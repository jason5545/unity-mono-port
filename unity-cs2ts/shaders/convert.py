# /// script
# requires-python = ">=3.11"
# dependencies = ["lz4>=4", "PyYAML>=6", "UnityPy>=1.24"]
# ///
"""shader 轉換：AssetRipper --shader-yaml 匯出的 DX11 bytecode → WebGL2 可用的 GLSL ES 3.00。
來源是 diceomancer-web 的 scripts/shaders/convert.py（K3 寫的第 0e 階段），只改了路徑的給法。

用法：uv run <工具包>/shaders/convert.py --src <ExportedProject> --out <輸出資料夾> [--build <Data 資料夾> --build-shaders <JSON 名稱清單>]
  --build-shaders：AssetRipper 當成引擎內建資源、沒有匯出的 shader（Standard、Unlit/…、Legacy 粒子…；材質參照的是
  unity_builtin_extra 的 fileID，本體在 build 的 sharedassets 或 unity_builtin_extra 裡）。用 UnityPy 從 build 讀，
  轉成跟 AssetRipper YAML 一樣的結構（build_shader_dict），之後走同一條轉換。資料夾名稱加 Builtin_ 前綴。
  通常由匯入器帶：uv run <工具包>/importer/run.py shaders（src 用設定檔 import.export 或 import.shaderExport，
  out 是 <root>/reference/shaders，轉完再發布到 <out>/shaders）。
來源要是 Windows build 的匯出（DX11 bytecode，platforms 4）；macOS build 的 shader 只有 Metal 原始碼，這支轉不了。
輸出不要進版控（原版素材）。

每個 shader 一個目錄：
  index.json                          pass / stage / 變體 / Unity 屬性對 binding 的對應
  pass<N>_<名稱>_<vert|frag>_<blob#>.dxbc   原始 DX11 bytecode
  .asm                                dxbc_disasm 反組譯
  .spv                                dxbc_compiler 產出再經 spi rv 修補（見下）
  .glsl                               spirv-cross --es --version 300

管線與工具（安裝方式見 README 段落或報告）：
  1. blob 解 LZ4、解析條目表（chunk0 開頭是 count + (offset, length, chunkIndex) 陣列，
     offset 是 chunk 內偏移），抽出 DXBC container。
  2. dxbc-spirv 的 dxbc_disasm / dxbc_compiler（環境變數 DXBC_SPIRV_BIN 指到 tools 目錄，
     預設 ~/GitHub/dxbc-spirv/builddir/tools）。dxbc-spirv 需要一個本地 patch：
     shaders/dxbc-spirv-local.patch（upstream c7f0697），內容：
     a) dxbc_io_map.cpp 關掉 FS 輸入寬度裁減（否則 WebGL2 varying 型別不一致會 link 失敗）；
     b) tools/dxbc_compiler.cpp 加 --cbv-array：cbuffer 一律輸出 std140 合法的 vec4 陣列
        （版面與 D3D register 一致；Unity packed struct 版面 spirv-cross 無法表達成 std140）。
     重現：git clone https://github.com/doitsujin/dxbc-spirv && git checkout c7f0697 &&
     git apply dxbc-spirv-local.patch && git submodule update --init &&
     meson setup builddir -Denable_tools=true && ninja -C builddir
  3. SPIR-V 修補（本檔 SpirvPatcher）：Vulkan memory model → Logical GLSL450、
     丟棄 Vulkan 專屬 capability、OpDemote→OpKill（= GLSL discard）、去 Component 0
     decoration、gl_BaseVertex/BaseInstance 換成常數 0（Unity 畫這些 pass 時 base 恒為 0）、
     導數 Fine/Coarse 降成普通版（ESSL 300 只有普通版）。
  4. spirv-cross 轉 GLSL ES 3.00 並取 reflection。
  5. glslangValidator 批次編譯檢查。
"""

from __future__ import annotations

import argparse
import concurrent.futures
import hashlib
import json
import os
import re
import shutil
import struct
import subprocess
import sys
import tempfile
import time
from collections import Counter, defaultdict
from pathlib import Path

import lz4.block
import yaml

DXBC_SPIRV_BIN = Path(
    os.environ.get("DXBC_SPIRV_BIN", Path.home() / "GitHub/dxbc-spirv/builddir/tools")
)

CUSTOM_PREFIXES = ("Shader Graphs_", "MoreMountains_")

GPU_PROGRAM_TYPE = {
    15: ("vertex", "vs_4_0"),
    16: ("vertex", "vs_5_0"),
    17: ("fragment", "ps_4_0"),
    18: ("fragment", "ps_5_0"),
    19: ("geometry", "gs_4_0"),
    20: ("geometry", "gs_5_0"),
    21: ("hull", "hs_5_0"),
    22: ("domain", "ds_5_0"),
}

STAGE_FIELD = [
    ("progVertex", "vertex", "vert"),
    ("progFragment", "fragment", "frag"),
    ("progGeometry", "geometry", "geom"),
    ("progHull", "hull", "hull"),
    ("progDomain", "domain", "dom"),
    ("progRayTracing", "raytracing", "ray"),
]


# ---------------- Unity YAML ----------------

class UnityLoader(yaml.CSafeLoader):
    pass


UnityLoader.add_multi_constructor(
    "tag:unity3d.com,2011:", lambda loader, suffix, node: loader.construct_mapping(node, deep=True)
)

# YAML 1.1 會把 hex 字串誤判成 int（"00000000" → 八進位 0、"10090000" → 十進位）。
# 只對已知是 hex 的欄位加引號（比照 extract.py 的 HEX_INT_FIELDS 做法）。
_HEX_SCALAR_KEYS = ("platforms", "compressedBlob", "m_SerializedKeywordStateMask", "m_KeywordFlags", "stageCounts", "Hash")
_HEX_LIST_KEYS = ("offsets", "compressedLengths", "decompressedLengths", "m_ParameterBlobIndices")
_HEX_SCALAR_RE = re.compile(
    r"^(\s*(?:" + "|".join(_HEX_SCALAR_KEYS) + r"): )([0-9a-f]+)[ \t]*$", re.M
)
_HEX_LIST_RE = re.compile(
    r"^(\s*(?:" + "|".join(_HEX_LIST_KEYS) + r"):\n)((?:\s+- [0-9a-f]+\n?)+)", re.M
)
_HEX_ITEM_RE = re.compile(r"^(\s*- )([0-9a-f]+)[ \t]*$", re.M)


def load_unity_yaml(path: Path) -> dict:
    text = path.read_text(encoding="utf8")
    text = _HEX_SCALAR_RE.sub(r'\1"\2"', text)
    text = _HEX_LIST_RE.sub(
        lambda m: m.group(1) + _HEX_ITEM_RE.sub(r'\1"\2"', m.group(2)), text
    )
    # m_ParameterBlobIndices 的項目混有空行（`- `）與 hex；逐行狀態處理
    lines = text.splitlines(keepends=True)
    in_pbi = False
    for i, ln in enumerate(lines):
        stripped = ln.strip()
        if stripped.startswith("m_ParameterBlobIndices:"):
            in_pbi = True
            continue
        if in_pbi:
            m = re.match(r"^(\s*)- ([0-9a-f]+)\s*$", ln)
            if m:
                lines[i] = f'{m.group(1)}- "{m.group(2)}"\n'
            elif stripped.startswith("- ") or stripped == "-":
                pass
            else:
                in_pbi = False
    text = "".join(lines)
    for doc in yaml.load_all(text, Loader=UnityLoader):
        if doc:
            return doc
    raise ValueError(f"{path} 是空的")


def hex_u32s(value) -> list[int]:
    """Unity 把 uint32 陣列寫成 little-endian hex；一個元素可能含多個 uint32。"""
    if value is None:
        return []
    if isinstance(value, str):
        value = [value]
    out: list[int] = []
    for item in value:
        raw = bytes.fromhex(item)
        out.extend(struct.unpack_from("<i", raw, i)[0] for i in range(0, len(raw), 4))
    return out


# ---------------- blob ----------------

def decompress_chunks(shader: dict) -> list[bytes]:
    comp = bytes.fromhex(shader["compressedBlob"])
    offs = hex_u32s(shader["offsets"])
    clens = hex_u32s(shader["compressedLengths"])
    dlens = hex_u32s(shader["decompressedLengths"])
    chunks = []
    for o, c, d in zip(offs, clens, dlens):
        chunks.append(lz4.block.decompress(comp[o : o + c], uncompressed_size=d))
    return chunks


def entry_table(chunks: list[bytes]) -> list[tuple[bytes, int, int]]:
    """條目表在 chunk0 開頭：count + count 個 (offset, length, chunkIndex)。"""
    t = chunks[0]
    (n,) = struct.unpack_from("<i", t, 0)
    out = []
    for i in range(n):
        off, ln, ci = struct.unpack_from("<iii", t, 4 + i * 12)
        out.append((chunks[ci], off, ln))
    return out


class SubProgram:
    def __init__(self, chunk: bytes, off: int, elen: int):
        end = off + elen
        if end > len(chunk):
            raise ValueError("entry 超出 chunk")
        self.version, self.progtype = struct.unpack_from("<ii", chunk, off)
        if self.version != 202012090:
            raise ValueError(f"未知 blob 版本 {self.version}")
        # +8/+12/+16/+20 四個欄位語意未明（keyword 狀態 hash 之類），轉換用不到
        pos = off + 24
        (nkw,) = struct.unpack_from("<i", chunk, pos)
        pos += 4
        self.keywords: list[str] = []
        for _ in range(nkw):
            (sl,) = struct.unpack_from("<i", chunk, pos)
            pos += 4
            self.keywords.append(chunk[pos : pos + sl].decode("utf8"))
            pos = (pos + sl + 3) & ~3
        (clen,) = struct.unpack_from("<i", chunk, pos)
        pos += 4
        code = chunk[pos : pos + clen]
        if len(code) != clen:
            raise ValueError("code 長度不足")
        dx = code.find(b"DXBC")
        if dx < 0:
            raise ValueError("code 裡沒有 DXBC")
        dlen = struct.unpack_from("<I", code, dx + 24)[0]
        if dx + dlen > len(code):
            raise ValueError("DXBC 長度超出 code")
        self.code_prefix = code[:dx]  # 38 bytes，開頭 4 bytes 大致是 02 <stage> 02 <stage>
        self.dxbc = code[dx : dx + dlen]
        self.code_tail = code[dx + dlen :]


# ---------------- DXBC 簽章 ----------------

def parse_dxbc_signatures(dxbc: bytes) -> dict[str, list[dict]]:
    """ISGN/OSGN chunk：register → 語意名稱、index、sysval、mask。"""
    n = struct.unpack_from("<I", dxbc, 28)[0]
    offs = struct.unpack_from(f"<{n}I", dxbc, 32)
    out: dict[str, list[dict]] = {}
    for o in offs:
        cc = dxbc[o : o + 4]
        if cc not in (b"ISGN", b"OSGN"):
            continue
        data = dxbc[o + 8 :]
        (count,) = struct.unpack_from("<I", data, 0)
        ents = []
        for i in range(count):
            name_off, sem_idx, sysval, comptype, reg, maskrw = struct.unpack_from("<6I", data, 8 + i * 24)
            z = data.index(b"\0", name_off)
            ents.append(
                {
                    "semantic": data[name_off:z].decode("utf8"),
                    "index": sem_idx,
                    "sysval": sysval,
                    "register": reg,
                    "mask": maskrw & 0xFF,
                }
            )
        out[cc.decode()] = ents
    return out


def io_rename_map(dxbc: bytes, stage: str) -> tuple[dict, list[dict]]:
    """VS 輸出（OSGN）與 FS 輸入（ISGN）用 D3D 語意名對接：v_<語意><index>。

    D3D11 靠語意對接，不靠 register；WebGL2 的 varying 靠名稱對接，所以兩邊改成同一套名稱。
    回傳 (rename map, 介面清單)。rename map 的 key 是 (storage class, location, component)。
    """
    sigs = parse_dxbc_signatures(dxbc)
    # VS: 改 OSGN（輸出）；FS: 改 ISGN（輸入）
    entries = sigs.get("OSGN" if stage == "vertex" else "ISGN") or []
    # SPIR-V StorageClass: 1=Input, 3=Output
    storage = 3 if stage == "vertex" else 1
    renames: dict[tuple[int, int, int], str] = {}
    iface = []
    for e in entries:
        if e["sysval"] != 0 or not e["mask"]:
            continue  # SV_POSITION 等系統語意是 builtin，沒有 Location decoration
        comp = 0
        m = e["mask"]
        while not (m & 1):
            m >>= 1
            comp += 1
        name = f"v_{e['semantic']}{e['index']}"
        renames[(storage, e["register"], comp)] = name
        iface.append(
            {
                "name": name,
                "semantic": e["semantic"],
                "index": e["index"],
                "register": e["register"],
                "component": comp,
                "mask": e["mask"],
            }
        )
    return renames, iface


# ---------------- 參數 blob ----------------
#
# 每個變體的參數存在 m_ParameterBlobIndices 指的 blob 條目（與 m_PlayerSubPrograms 平行、可重複）。
# 實測格式（Unity 2022.3，blob version 恆 202012090）：
#   header: version, cbCount+1, 4×u32 零
#   CB 記錄 ×(f4-1): [len][名字][size][memberCount][members][structCount][structs]
#     member: [len][名字][a][b][c][d][e][offset]；vector: b=1, c=dim, e=arraySize；
#             matrix: b=4, c=4(rows), d=1, e=arraySize
#     struct（陣列）: [len][名字][offset][arraySize][structSize][memberCount][members]
#   資源區: count + count 筆記錄，依首個 u32 分辨：
#     具名: [len][名字][tag] —— tag 0 = 貼圖 [reg][samp][srvDim]；tag 1 = CB binding [slot][?]
#     無名: [0][srvDim][reg][state] —— 隱含 sampler 狀態（貼圖沒有具名 sampler 時）
#   字串一律 u32 長度前綴、4 對齊、無 NUL。
#
# blob 的 CB 外殼列出該變體用到的全部 CB（含共用 CB，但共用欄位不重複列成員），
# 成員只列這個變體特有的部分；貼圖同理。所以變體參數 = m_CommonParameters ∪ blob。

class BlobReader:
    def __init__(self, buf: bytes):
        self.b = buf
        self.p = 0

    def u32(self) -> int:
        if self.p + 4 > len(self.b):
            raise ValueError(f"讀過頭 @{self.p}")
        (v,) = struct.unpack_from("<i", self.b, self.p)
        self.p += 4
        return v

    def string(self) -> str:
        start = self.p
        l = self.u32()
        if not (1 <= l <= 128) or self.p + l > len(self.b):
            raise ValueError(f"@{start}: 字串長度 {l} 不合理")
        raw = self.b[self.p : self.p + l]
        if not all(c == 0x24 or c == 0x5F or 0x2D <= c <= 0x7A for c in raw):
            raise ValueError(f"@{start}: 不是識別字")
        self.p = (self.p + l + 3) & ~3
        return raw.decode("ascii")

    def peek_string(self) -> bool:
        if self.p + 4 > len(self.b):
            return False
        (l,) = struct.unpack_from("<i", self.b, self.p)
        if not (1 <= l <= 128) or self.p + 4 + l > len(self.b):
            return False
        return all(c == 0x24 or c == 0x5F or 0x2D <= c <= 0x7A for c in self.b[self.p + 4 : self.p + 4 + l])

    def done(self) -> bool:
        return self.p >= len(self.b)


SRV_DIM_TO_UNITY = {4: 2, 5: 5, 6: 2, 7: 5, 8: 3, 9: 4, 10: 6}  # D3D_SRV_DIMENSION → Unity TextureDimension


def parse_param_blob(blob: bytes) -> dict:
    r = BlobReader(blob)
    if r.u32() != 202012090:
        raise ValueError("未知版本")
    cb_count = r.u32() - 1
    if cb_count < 0:
        raise ValueError("CB 數為負")
    for _ in range(4):
        if r.u32() != 0:
            raise ValueError("header 非零")

    def read_member() -> dict:
        name = r.string()
        a, b, c, d, e, offset = (r.u32() for _ in range(6))
        return {"name": name, "f": (a, b, c, d, e), "offset": offset}

    cbs = []
    for _ in range(cb_count):
        name = r.string()
        size = r.u32()
        member_count = r.u32()
        if not (0 <= member_count <= 512):
            raise ValueError(f"CB {name} 成員數 {member_count} 不合理")
        members = [read_member() for _ in range(member_count)]
        struct_count = r.u32()
        structs = []
        for _ in range(struct_count):
            sname = r.string()
            soffset, sarray, ssize, scount = r.u32(), r.u32(), r.u32(), r.u32()
            smembers = [read_member() for _ in range(scount)]
            structs.append(
                {"name": sname, "offset": soffset, "arraySize": sarray, "structSize": ssize, "members": smembers}
            )
        cbs.append({"name": name, "size": size, "members": members, "structs": structs})

    textures = []
    implicit_samplers = []
    cb_bindings = []
    buffers = []
    if not r.done():
        count = r.u32()
        if not (0 <= count <= 256):
            raise ValueError(f"資源數 {count} 不合理")
        for _ in range(count):
            if r.peek_string():
                name = r.string()
                tag = r.u32()
                if tag == 0:
                    reg, samp, dim = r.u32(), r.u32(), r.u32()
                    textures.append(
                        {
                            "name": name,
                            "register": reg,
                            "samplerRegister": samp if samp >= 0 else None,
                            "dim": SRV_DIM_TO_UNITY.get(dim, dim),
                            "srvDim": dim,
                            "multiSampled": dim == 6,
                        }
                    )
                elif tag == 1:
                    slot, arr = r.u32(), r.u32()
                    cb_bindings.append({"name": name, "slot": slot, "arraySize": arr})
                elif tag == 2:
                    # structured buffer（SRV）；第三欄語意未確認（不是 stride）
                    reg, unk = r.u32(), r.u32()
                    buffers.append({"name": name, "register": reg, "raw": unk})
                else:
                    raise ValueError(f"未知資源 tag {tag}")
            else:
                zero, dim, reg, state = r.u32(), r.u32(), r.u32(), r.u32()
                if zero != 0:
                    raise ValueError("無名資源首欄非零")
                implicit_samplers.append({"srvDim": dim, "register": reg, "samplerState": state})

    while not r.done():
        if r.u32() != 0:
            raise ValueError("尾部非零")
    return {"cbs": cbs, "textures": textures, "implicitSamplers": implicit_samplers, "cbBindings": cb_bindings, "buffers": buffers}


def blob_member_to_param(m: dict) -> dict:
    """member 欄位 [a,b,c,d,e]：b=4 是 matrix（c=rows，e=arraySize），其餘是 vector（c=dim）。"""
    a, b, c, d, e = m["f"]
    if b == 4:
        return {"name": m["name"], "offset": m["offset"], "rows": c, "arraySize": e}
    return {"name": m["name"], "offset": m["offset"], "dim": c, "arraySize": e or a or 0}


def merge_parameters(common: dict, blob: dict) -> dict:
    """變體參數 = stage 的 m_CommonParameters ∪ 參數 blob（blob 只存非共用部分）。"""
    common_cb = {cb["name"]: cb for cb in common.get("constantBuffers") or []}
    cbs = []
    for slot, bcb in enumerate(blob["cbs"]):
        ccb = common_cb.get(bcb["name"])
        vectors = [blob_member_to_param(m) for m in bcb["members"] if m["f"][1] != 4]
        matrices = [blob_member_to_param(m) for m in bcb["members"] if m["f"][1] == 4]
        for st in bcb["structs"]:
            # struct 陣列：成員 offset 相對 struct 起點；絕對 offset = struct.offset + 元素×structSize
            for m in st["members"]:
                p = blob_member_to_param(m)
                p["offset"] += st["offset"]
                p["struct"] = {"name": st["name"], "arraySize": st["arraySize"], "structSize": st["structSize"]}
                (matrices if m["f"][1] == 4 else vectors).append(p)
        seen = set()
        for lst, key in ((vectors, "vectors"), (matrices, "matrices")):
            for p in ccb.get(key) if ccb else []:
                if p["name"] not in {x["name"] for x in lst}:
                    lst.append(p)
            lst.sort(key=lambda x: (x["offset"], x["name"]))
            for p in lst:
                assert p["name"] not in seen
                seen.add(p["name"])
        cbs.append(
            {
                "name": bcb["name"],
                "size": bcb["size"],
                "slot": slot,
                "partial": ccb.get("partial") if ccb else None,
                "vectors": vectors,
                "matrices": matrices,
            }
        )
    # 貼圖：共用 ∪ blob（blob 有 srvDim 細節，同名以 blob 為準）
    textures = {t["name"]: dict(t) for t in common.get("textures") or []}
    for t in blob["textures"]:
        textures[t["name"]] = t
    for t in textures.values():
        if t.get("samplerRegister") is not None and t["samplerRegister"] < 0:
            t["samplerRegister"] = None
    return {
        "constantBuffers": cbs,
        "textures": sorted(textures.values(), key=lambda t: (t.get("register") or 0, t["name"])),
        "buffers": (common.get("buffers") or []) + blob.get("buffers", []),
        "samplers": common.get("samplers") or [],
        "implicitSamplers": blob["implicitSamplers"],
        "cbBindings": blob["cbBindings"],
    }


# ---------------- SPIR-V 修補 ----------------

OP_MEMORY_MODEL = 14
OP_ENTRY_POINT = 15
OP_CAPABILITY = 17
OP_DECORATE = 71
OP_CONSTANT = 43
OP_VARIABLE = 59
OP_LOAD = 61
OP_ACCESS_CHAIN = 65
OP_IN_BOUNDS_ACCESS_CHAIN = 66
OP_COPY_OBJECT = 83
OP_FUNCTION = 54
OP_FUNCTION_END = 56
OP_LABEL = 248
OP_BRANCH = 249
OP_KILL = 252
OP_DEMOTE = 5380  # OpDemoteToHelperInvocationEXT
OP_TYPE_INT = 21
OP_TYPE_FLOAT = 22
OP_TYPE_POINTER = 32

OP_DPDX = 207
OP_DPDY = 208
OP_FWIDTH = 209
# Fine/Coarse（DerivativeControl）：ESSL 300 沒有，降成普通版本（同 word count）
OP_DERIVATIVE_MAP = {210: OP_DPDX, 211: OP_DPDY, 212: OP_FWIDTH, 213: OP_DPDX, 214: OP_DPDY, 215: OP_FWIDTH}
OP_BIT_FIELD_INSERT = 201  # ESSL 3.10 才有 bitfieldInsert，降成位元運算
OP_NOT = 200
OP_SHIFT_LEFT_LOGICAL = 196
OP_BITWISE_AND = 199
OP_BITWISE_OR = 197
OP_NAME = 5

CAP_VULKAN_MEMORY_MODEL = 5345
CAP_VULKAN_MEMORY_MODEL_DEVICE_SCOPE = 5346
CAP_PHYSICAL_STORAGE_BUFFER = 5347
CAP_DEMOTE = 5379
CAP_DERIVATIVE_CONTROL = 51

DECORATION_COMPONENT = 31
DECORATION_BUILT_IN = 11
DECORATION_LOCATION = 30
BUILTIN_BASE_VERTEX = 4424
BUILTIN_BASE_INSTANCE = 4425

STAGE_SUFFIX = {0: "vs", 4: "fs"}  # OpEntryPoint 的 ExecutionModel


def _encode_string(s: str) -> list[int]:
    data = s.encode("utf8") + b"\0"
    data += b"\0" * ((-len(data)) % 4)
    return list(struct.unpack(f"<{len(data) // 4}I", data))


def _decode_string(words: list[int], pos: int) -> tuple[str, int]:
    start = pos * 4
    raw = struct.pack(f"<{len(words)}I", *words)
    end = raw.index(b"\0", start)
    return raw[start:end].decode("utf8"), (end // 4) + 1 - pos


def const_value(insts: list[list[int]], result_id: int) -> int | None:
    """找 OpConstant 的值（只處理 32-bit）。"""
    for inst in insts:
        if (inst[0] & 0xFFFF) == OP_CONSTANT and len(inst) == 4 and inst[2] == result_id:
            return inst[3]
    return None


class SpirvPatcher:
    """把 dxbc-spirv 的 Vulkan 導向 SPIR-V 改成 spirv-cross 能轉 ESSL 300 的形式。

    處理：
    - OpMemoryModel → Logical GLSL450；丟棄 Vulkan 專屬 capability
    - OpDemoteToHelperInvocationEXT → OpKill（ESSL 的 discard；吃掉同區塊後續死碼）
    - Component 0 decoration（ESSL 300 不支援 enhanced layouts，0 本來就是預設值）
    - gl_BaseVertex/gl_BaseInstance → 常數 0（Unity 畫這些全螢幕 pass 時 base 恒為 0；
      ESSL 沒有這兩個 builtin）
    - 導數 Fine/Coarse → 普通版（ESSL 300 只有普通版；語義差異寫進報告）
    """

    def __init__(self, data: bytes, io_renames: dict | None = None):
        self.words = list(struct.unpack(f"<{len(data) // 4}I", data))
        if self.words[0] != 0x07230203:
            raise ValueError("不是 SPIR-V")
        self.notes: list[str] = []
        # (storage class, location, component) -> 新名稱（varying 語意對接）
        self.io_renames = io_renames or {}

    def instructions(self):
        i = 5
        while i < len(self.words):
            w = self.words[i]
            ln = w >> 16
            yield self.words[i : i + ln]
            i += ln

    def patch(self) -> bytes:
        insts = list(self.instructions())

        # pass 0: 掃描
        base_vars = set()  # BaseVertex/BaseInstance 的 variable id
        var_pointee = {}  # variable id -> pointee type id
        consts = {}  # (type id, value) -> 常數 id
        max_id = self.words[3]
        var_storage = {}  # variable id -> storage class
        var_location = {}  # variable id -> location
        var_component = {}  # variable id -> component
        names = {}  # target id -> OpName 字串
        stage_suffix = None
        for inst in insts:
            op = inst[0] & 0xFFFF
            if op == OP_DECORATE and len(inst) >= 4:
                if inst[2] == DECORATION_BUILT_IN and inst[3] in (BUILTIN_BASE_VERTEX, BUILTIN_BASE_INSTANCE):
                    base_vars.add(inst[1])
                elif inst[2] == DECORATION_LOCATION:
                    var_location[inst[1]] = inst[3]
                elif inst[2] == DECORATION_COMPONENT:
                    var_component[inst[1]] = inst[3]
            elif op == OP_VARIABLE:
                var_pointee[inst[2]] = inst[1]
                var_storage[inst[2]] = inst[3]
            elif op == OP_CONSTANT and len(inst) == 4:
                consts[(inst[1], inst[3])] = inst[2]
            elif op == OP_NAME and len(inst) >= 3:
                names[inst[1]] = _decode_string(inst, 2)[0]
            elif op == OP_ENTRY_POINT:
                stage_suffix = STAGE_SUFFIX.get(inst[1])
        # variable 的 pointee type：OpTypePointer 的第四個 word
        ptr_pointee = {}
        for inst in insts:
            if (inst[0] & 0xFFFF) == OP_TYPE_POINTER and len(inst) == 4:
                ptr_pointee[inst[1]] = inst[3]
        var_elem_type = {v: ptr_pointee.get(t) for v, t in var_pointee.items()}

        def get_const(type_id: int, value: int) -> int:
            nonlocal max_id
            key = (type_id, value)
            if key in consts:
                return consts[key]
            new_id = max_id
            max_id += 1
            consts[key] = new_id
            self._new_consts.append([(4 << 16) | OP_CONSTANT, type_id, new_id, value & 0xFFFFFFFF])
            return new_id

        def alloc_id() -> int:
            nonlocal max_id
            new_id = max_id
            max_id += 1
            return new_id

        self._new_consts: list[list[int]] = []
        renamed_io = False
        renamed_cb = False
        out: list[list[int]] = []
        i = 0
        while i < len(insts):
            inst = insts[i]
            op = inst[0] & 0xFFFF
            ln = inst[0] >> 16

            if op == OP_CAPABILITY and inst[1] in (
                CAP_PHYSICAL_STORAGE_BUFFER,
                CAP_VULKAN_MEMORY_MODEL,
                CAP_VULKAN_MEMORY_MODEL_DEVICE_SCOPE,
                CAP_DEMOTE,
                CAP_DERIVATIVE_CONTROL,
            ):
                i += 1
                continue
            if op == OP_MEMORY_MODEL:
                inst = [inst[0], 0, 1]  # Logical, GLSL450
            if op == OP_DECORATE and len(inst) >= 4:
                if inst[2] == DECORATION_COMPONENT and inst[3] == 0:
                    i += 1
                    continue
                if inst[2] == DECORATION_BUILT_IN and inst[3] in (BUILTIN_BASE_VERTEX, BUILTIN_BASE_INSTANCE):
                    i += 1
                    continue
            if op == OP_NAME and len(inst) >= 3:
                target = inst[1]
                old = names.get(target)
                new = None
                if old:
                    # cbuffer：每個 stage 自己的 block 名（ESSL 要求同名 block 跨 stage 一致，
                    # 但 D3D 每個 stage 的 $Globals 版面不同）
                    m = re.fullmatch(r"cb(\d+)(_buf)?", old)
                    if m and stage_suffix:
                        new = f"cb{m.group(1)}_{stage_suffix}{m.group(2) or ''}"
                        renamed_cb = True
                    # varying：換成語意名（VS 輸出 / FS 輸入 用同一套）
                    key = (
                        var_storage.get(target),
                        var_location.get(target),
                        var_component.get(target, 0),
                    )
                    if key in self.io_renames:
                        new = self.io_renames[key]
                        renamed_io = True
                if new and new != old:
                    inst = [((2 + len(_encode_string(new))) << 16) | OP_NAME, target, *_encode_string(new)]
            if op == OP_ENTRY_POINT and base_vars:
                # [wc|op, model, ep, name..., interface ids...]：去掉 base vars
                name, nw = _decode_string(inst, 3)
                ids = [x for x in inst[3 + nw :] if x not in base_vars]
                wc = 3 + nw + len(ids)
                inst = [(wc << 16) | OP_ENTRY_POINT, inst[1], inst[2], *_encode_string(name), *ids]
            if op in (OP_LOAD, OP_ACCESS_CHAIN, OP_IN_BOUNDS_ACCESS_CHAIN) and len(inst) >= 4 and inst[3] in base_vars:
                if op != OP_LOAD:
                    raise ToolError("BaseVertex/BaseInstance 透過 access chain 存取，未支援")
                elem = var_elem_type.get(inst[3])
                inst = [(4 << 16) | OP_COPY_OBJECT, inst[1], inst[2], get_const(elem, 0)]
                self.notes.append("baseVertex/Instance=0")
            if op in OP_DERIVATIVE_MAP:
                inst = [(ln << 16) | OP_DERIVATIVE_MAP[op], *inst[1:]]
                self.notes.append("derivative fine/coarse→plain")
            if op == OP_BIT_FIELD_INSERT:
                # [type, id, base, insert, offset, count] → 位元運算（ESSL 300 沒有 bitfieldInsert）
                rtype, rid, base, insert, off_id, cnt_id = inst[1:7]
                off_val = const_value(insts, off_id)
                cnt_val = const_value(insts, cnt_id)
                if off_val is None or cnt_val is None:
                    raise ToolError("bitfieldInsert 的 offset/count 不是常數，未支援")
                if off_val >= 32:
                    # D3D bfi：offset 超過寬度 = 不插入
                    out.append([(4 << 16) | OP_COPY_OBJECT, rtype, rid, base])
                    self.notes.append("bitfieldInsert→位元運算")
                    i += 1
                    continue
                # D3D bfi：offset+count 超過 32 的位元丟棄；mask 截到 32 bit 即是這個語義
                mask = ((1 << cnt_val) - 1) << off_val & 0xFFFFFFFF
                mask_id = get_const(rtype, mask)
                # t1 = base & ~mask
                not_mask = alloc_id()
                out.append([(4 << 16) | OP_NOT, rtype, not_mask, mask_id])
                t1 = alloc_id()
                out.append([(5 << 16) | OP_BITWISE_AND, rtype, t1, base, not_mask])
                # t2 = (insert << offset) & mask
                t2a = alloc_id()
                out.append([(5 << 16) | OP_SHIFT_LEFT_LOGICAL, rtype, t2a, insert, off_id])
                t2 = alloc_id()
                out.append([(5 << 16) | OP_BITWISE_AND, rtype, t2, t2a, mask_id])
                out.append([(5 << 16) | OP_BITWISE_OR, rtype, rid, t1, t2])
                self.notes.append("bitfieldInsert→位元運算")
                i += 1
                continue
            if op == OP_DEMOTE:
                out.append([(1 << 16) | OP_KILL])
                i += 1
                # 吃掉同區塊的後續死碼（到 OpBranch / OpLabel / OpFunctionEnd 為止）
                while i < len(insts):
                    nop = insts[i][0] & 0xFFFF
                    if nop == OP_BRANCH:
                        i += 1
                        break
                    if nop in (OP_LABEL, OP_FUNCTION_END):
                        break
                    i += 1
                self.notes.append("demote→kill")
                continue
            out.append(inst)
            i += 1

        if renamed_cb:
            self.notes.append("cbuffer block 名加 stage 後綴")
        if renamed_io:
            self.notes.append("varying 用語意名對接")

        # 插入新常數到第一個 OpFunction 之前
        if self._new_consts:
            merged: list[list[int]] = []
            inserted = False
            for inst in out:
                if not inserted and (inst[0] & 0xFFFF) == OP_FUNCTION:
                    merged.extend(self._new_consts)
                    inserted = True
                merged.append(inst)
            if not inserted:
                merged.extend(self._new_consts)
            out = merged

        words = self.words[:5]
        for inst in out:
            words.extend(inst)
        words[3] = max_id
        return struct.pack(f"<{len(words)}I", *words)


def patch_spirv(data: bytes) -> bytes:
    return SpirvPatcher(data).patch()


# ---------------- 外部工具 ----------------

class ToolError(Exception):
    pass


def run(cmd: list[str], timeout: int = 300) -> subprocess.CompletedProcess:
    proc = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    return proc


def convert_one(hash_: str, dxbc: bytes, stage: str, workdir: Path) -> dict:
    """回傳 {asm, spv, glsl, reflection} 或丟 ToolError。結果以 hash 存在 workdir。"""
    base = workdir / hash_
    dxbc_path = base.with_suffix(".dxbc")
    asm_path = base.with_suffix(".asm")
    spv_raw_path = base.with_suffix(".raw.spv")
    spv_path = base.with_suffix(".spv")
    glsl_path = base.with_suffix(".glsl")
    reflect_path = base.with_suffix(".reflect.json")

    dxbc_path.write_bytes(dxbc)

    disasm = DXBC_SPIRV_BIN / "dxbc_disasm"
    compiler = DXBC_SPIRV_BIN / "dxbc_compiler"

    p = run([str(disasm), str(dxbc_path)])
    if p.returncode != 0:
        raise ToolError(f"dxbc_disasm: {p.stderr.strip()[:300]}")
    asm_path.write_bytes(p.stdout.encode())

    p = run([str(compiler), str(dxbc_path), "--spv", str(spv_raw_path), "--cbv-array"])
    if p.returncode != 0:
        raise ToolError(f"dxbc_compiler: {(p.stderr or p.stdout).strip()[:300]}")

    renames, iface = io_rename_map(dxbc, stage)
    patcher = SpirvPatcher(spv_raw_path.read_bytes(), io_renames=renames)
    spv_path.write_bytes(patcher.patch())
    spv_raw_path.unlink()

    p = run(["spirv-cross", str(spv_path), "--es", "--version", "300", "--flatten-multidimensional-arrays"])
    if p.returncode != 0:
        raise ToolError(f"spirv-cross: {(p.stdout + p.stderr).strip()[:300]}")
    glsl_path.write_text(p.stdout)

    p = run(["spirv-cross", str(spv_path), "--flatten-multidimensional-arrays", "--reflect"])
    if p.returncode == 0:
        reflect_path.write_text(p.stdout)

    return {"hash": hash_, "stage": stage, "patchNotes": sorted(set(patcher.notes)), "io": iface}


# ---------------- shader 解析 ----------------

def sanitize(name: str) -> str:
    s = re.sub(r"[^A-Za-z0-9]+", "_", name).strip("_")
    return s or "unnamed"


def parse_shader(path: Path) -> dict:
    doc = load_unity_yaml(path)
    return doc["Shader"]


# ---------------- build 裡的 shader（AssetRipper 沒匯出的內建 shader） ----------------

def _hex_u32(values) -> str:
    return struct.pack(f"<{len(values)}I", *values).hex()


def _ar_shape(v, key: str | None = None):
    """UnityPy 的 typetree → AssetRipper YAML 讀進來的樣子（load_unity_yaml 之後）。差別（UI/Additive 兩邊對過）：
    map 是 [(key, value)…] → dict；uint 陣列寫成 little-endian hex 字串（m_ParameterBlobIndices 每個平台一個 uint32 陣列，
    空的是 None；m_KeywordIndices、m_SerializedKeywordStateMask 是 uint16；m_Platforms、m_KeywordFlags 是 byte）；bytes → hex。"""
    if isinstance(v, (bytes, bytearray)):
        return bytes(v).hex()
    if isinstance(v, str):
        # AssetRipper 的 YAML 沒加引號的純量讀進來會被 YAML 解讀：空字串是 null、true／false 是布林（tag 的值、預設貼圖名）
        if v == "":
            return None
        if v in ("true", "false"):
            return v == "true"
        return v
    if isinstance(v, dict):
        return {k: _ar_shape(x, k) for k, x in v.items()}
    if isinstance(v, (list, tuple)):
        if key == "m_ParameterBlobIndices":
            return [_hex_u32(x) if x else None for x in v]
        if key in ("m_KeywordIndices", "m_SerializedKeywordStateMask"):
            return struct.pack(f"<{len(v)}H", *v).hex() if v else None
        if key in ("m_Platforms", "m_KeywordFlags"):
            return bytes(v).hex()
        if v and all(isinstance(x, tuple) and len(x) == 2 and isinstance(x[0], str) for x in v):
            return {k: _ar_shape(x, k) for k, x in v}
        return [_ar_shape(x) for x in v]
    return v


def build_shader_dict(tt: dict) -> dict:
    """一個 Shader 物件的 typetree → parse_shader 回傳的那種 dict"""
    blob_keys = ("platforms", "offsets", "compressedLengths", "decompressedLengths", "compressedBlob", "stageCounts")
    sh = _ar_shape({k: v for k, v in tt.items() if k not in blob_keys})
    sh["m_Name"] = tt["m_ParsedForm"]["m_Name"]  # AssetRipper 把 parsed 名稱寫進 m_Name（build 裡是空的）
    sh["platforms"] = _hex_u32(tt["platforms"])
    for k in ("offsets", "compressedLengths", "decompressedLengths"):
        sh[k] = [_hex_u32(x) for x in tt[k]]
    sh["compressedBlob"] = bytes(tt["compressedBlob"]).hex()
    sh["stageCounts"] = _hex_u32(tt.get("stageCounts") or [])
    return sh


def load_build_shaders(data: Path, names: list[str]) -> tuple[dict[str, dict], list[dict]]:
    """在 build 的資產檔（level*、*.assets、Resources/unity_builtin_extra）依 m_ParsedForm.m_Name 找 Shader；
    同名的只能有一個（多個就記失敗，不猜）。回傳 {名稱: dict}, 失敗清單"""
    import UnityPy

    want = set(names)
    found: dict[str, list] = {}
    files = sorted(p for p in data.iterdir() if p.is_file() and (p.suffix == ".assets" or p.name.startswith("level")) and not p.name.endswith(".resS"))
    files.append(data / "Resources" / "unity_builtin_extra")
    for p in files:
        if not p.exists():
            continue
        env = UnityPy.load(str(p))
        for o in env.objects:
            if o.type.name != "Shader":
                continue
            tt = o.read_typetree()
            n = (tt.get("m_ParsedForm") or {}).get("m_Name")
            if n in want:
                found.setdefault(n, []).append((f"{p.name}#{o.path_id}", tt))
    out: dict[str, dict] = {}
    failures = []
    for n in names:
        hits = found.get(n, [])
        if len(hits) != 1:
            failures.append({"shader": n, "step": "build", "error": f"build 裡找到 {len(hits)} 個（{', '.join(h[0] for h in hits)}）"})
            continue
        out[n] = build_shader_dict(hits[0][1])
        out[n]["_buildSource"] = hits[0][0]
    return out, failures


def name_indices_inv(pass_: dict) -> dict[int, str]:
    return {v: k for k, v in (pass_.get("m_NameIndices") or {}).items()}


def common_parameters(prog: dict, idx2name: dict[int, str]) -> dict:
    cp = prog.get("m_CommonParameters") or {}

    def pname(p):
        return idx2name.get(p.get("m_NameIndex"), f"#{p.get('m_NameIndex')}")

    cbs = []
    for cb in cp.get("m_ConstantBuffers") or []:
        cbs.append(
            {
                "name": pname(cb),
                "size": cb.get("m_Size"),
                "partial": bool(cb.get("m_IsPartialCB")),
                "vectors": [
                    {"name": pname(v), "offset": v.get("m_Index"), "dim": v.get("m_Dim"), "arraySize": v.get("m_ArraySize")}
                    for v in cb.get("m_VectorParams") or []
                ],
                "matrices": [
                    {"name": pname(m), "offset": m.get("m_Index"), "rows": m.get("m_RowCount"), "arraySize": m.get("m_ArraySize")}
                    for m in cb.get("m_MatrixParams") or []
                ],
            }
        )
    bindings = [
        {"name": pname(b), "slot": b.get("m_Index"), "arraySize": b.get("m_ArraySize")}
        for b in cp.get("m_ConstantBufferBindings") or []
    ]
    slot_of = {b["name"]: b["slot"] for b in bindings}
    for cb in cbs:
        cb["slot"] = slot_of.get(cb["name"])
    textures = [
        {
            "name": pname(t),
            "register": t.get("m_Index"),
            "samplerRegister": t.get("m_SamplerIndex"),
            "dim": t.get("m_Dim"),
            "multiSampled": bool(t.get("m_MultiSampled")),
        }
        for t in cp.get("m_TextureParams") or []
    ]
    buffers = [
        {"name": pname(b), "register": b.get("m_Index")}
        for b in cp.get("m_BufferParams") or []
    ]
    samplers = [
        {"name": pname(s), "register": s.get("m_Index")}
        for s in cp.get("m_Samplers") or []
    ]
    return {"constantBuffers": cbs, "textures": textures, "buffers": buffers, "samplers": samplers}


def prop_info(pf: dict) -> list[dict]:
    props = []
    for p in (pf.get("m_PropInfo") or {}).get("m_Props") or []:
        props.append(
            {
                "name": p.get("m_Name"),
                "description": p.get("m_Description"),
                "type": p.get("m_Type"),
                "flags": p.get("m_Flags"),
                "defaultValue": [p.get(f"m_DefValue[{i}]") for i in range(4)],
                "defaultTexture": (p.get("m_DefTexture") or {}).get("m_DefaultName"),
                "texDim": (p.get("m_DefTexture") or {}).get("m_TexDim"),
            }
        )
    return props


def pass_state(state: dict) -> dict:
    blend0 = state.get("rtBlend0") or {}

    def val(key):
        return state_value(state.get(key))

    def val_of(d: dict, key: str):
        return state_value(d.get(key))

    return {
        "zWrite": val("zWrite"),
        "zTest": val("zTest"),
        "culling": val("culling"),
        "blend": {
            "src": val_of(blend0, "srcBlend"),
            "dst": val_of(blend0, "destBlend"),
            "srcAlpha": val_of(blend0, "srcBlendAlpha"),
            "dstAlpha": val_of(blend0, "destBlendAlpha"),
            "op": val_of(blend0, "blendOp"),
            "opAlpha": val_of(blend0, "blendOpAlpha"),
        },
        "colorMask": val_of(blend0, "colMask"),
        "stencilRef": val("stencilRef"),
        "stencilReadMask": val("stencilReadMask"),
        "stencilWriteMask": val("stencilWriteMask"),
    }


def state_value(v):
    """SerializedShaderFloatValue {val, name}。綁材質屬性的（`Blend [_SrcBlend][_DstBlend]`、`Cull [_Cull]`）
    name 是屬性名，val 只是預設值，執行時要讀材質的值：輸出 {"val", "prop"}。沒綁的 name 是 '<noninit>'，只輸出數字。"""
    if not isinstance(v, dict):
        return v
    name = v.get("name")
    if name and name != "<noninit>":
        return {"val": v.get("val"), "prop": name}
    return v.get("val")


# ---------------- 主流程 ----------------

def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", required=True, help="AssetRipper --shader-yaml 匯出的 ExportedProject")
    ap.add_argument("--out", required=True, help="輸出資料夾（不要進版控）")
    ap.add_argument("--jobs", type=int, default=max(4, (os.cpu_count() or 8)))
    ap.add_argument("--filter", default=None, help="只處理檔名含此字串的 shader（除錯用）")
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--build", default=None, help="原版 build 的 Data 資料夾（--build-shaders 用）")
    ap.add_argument("--build-shaders", default=None, help="從 build 讀的 shader 名稱（JSON 陣列）")
    args = ap.parse_args()

    src = Path(args.src)
    out = Path(args.out)
    shader_dir = src / "Assets/Shader"
    mat_dir = src / "Assets/Material"

    for tool in ["spirv-cross", "glslangValidator"]:
        if shutil.which(tool) is None:
            print(f"錯誤：找不到 {tool}（brew install spirv-cross glslang）", file=sys.stderr)
            return 1
    for tool in ["dxbc_disasm", "dxbc_compiler"]:
        if not (DXBC_SPIRV_BIN / tool).exists():
            print(f"錯誤：找不到 {DXBC_SPIRV_BIN / tool}", file=sys.stderr)
            return 1

    t0 = time.time()
    print(f"來源: {shader_dir}")
    print(f"輸出: {out}")

    # 要轉的 shader 檔：Assets/Shader/*.asset，加上 Assets 底下其他地方的 Shader 資產（AssetRipper 照原專案路徑放，
    # 例如 Resources/shaders/tmp_sprite.asset 是 TextMeshPro/Sprite；以前只掃 Assets/Shader，這些沒轉）。
    # Assets/Shader 的資料夾名稱照檔名（跟以前一樣），其他的照相對 Assets 的路徑（/ 換成 _），避免撞名
    def is_shader_asset(f: Path) -> bool:
        with f.open("rb") as fh:
            return b"--- !u!48 " in fh.read(256)

    shader_paths: dict[str, Path] = {f.name[: -len(".asset")]: f for f in sorted(shader_dir.glob("*.asset"))}
    for f in sorted((src / "Assets").rglob("*.asset")):
        if f.parent == shader_dir or not is_shader_asset(f):
            continue
        shader_paths[str(f.relative_to(src / "Assets"))[: -len(".asset")].replace("/", "_")] = f

    # guid -> shader 檔名（材質對照用）
    guid2stem = {}
    stem2guid = {}
    for stem, f in shader_paths.items():
        meta = f.with_name(f.name + ".meta")
        if not meta.exists():
            continue
        m = re.search(r"^guid: ([0-9a-f]{32})$", meta.read_text(encoding="utf8"), re.M)
        if m:
            guid2stem[m.group(1)] = stem
            stem2guid[stem] = m.group(1)

    # 材質：shader guid + keywords
    materials = []
    for mp in sorted(mat_dir.glob("*.mat")):
        doc = load_unity_yaml(mp)
        mat = doc.get("Material") or {}
        guid = ((mat.get("m_Shader") or {}).get("guid")) or ""
        materials.append(
            {
                "file": mp.name,
                "name": mat.get("m_Name") or mp.stem,
                "shader": guid2stem.get(guid),
                "shaderGuid": guid,
                "keywords": sorted(mat.get("m_ValidKeywords") or []),
            }
        )

    shader_files = sorted(shader_paths.items())
    if args.filter:
        shader_files = [(stem, f) for stem, f in shader_files if args.filter in stem]
    if args.limit:
        shader_files = shader_files[: args.limit]
    # 工作清單：(資料夾名稱, 讀取函式)。AssetRipper 匯出的照上面的名稱；build 的加 Builtin_ 前綴
    sources: list[tuple[str, object]] = [(stem, (lambda f=f: parse_shader(f))) for stem, f in shader_files]
    build_failures: list[dict] = []
    if args.build and args.build_shaders:
        wanted = json.loads(args.build_shaders)
        if args.filter:
            wanted = [n for n in wanted if args.filter in n.replace("/", "_")]
        loaded, build_failures = load_build_shaders(Path(args.build), wanted)
        for n, d in loaded.items():
            print(f"  build 的 shader：{n}（{d['_buildSource']}）")
            sources.append(("Builtin_" + n.replace("/", "_"), (lambda d=d: d)))
    print(f"shader 數: {len(sources)}；材質數: {len(materials)}")

    # phase 1: 解析 YAML + blob，建立工作清單
    shaders = []  # 每個 shader 的完整中繼資料
    jobs = {}  # dxbc sha1 -> {dxbc, stage}

    totals = Counter()
    failures = list(build_failures)

    for si, (stem, load) in enumerate(sources):
        try:
            sh = load()
        except Exception as e:
            failures.append({"shader": stem, "step": "yaml", "error": str(e)[:300]})
            continue
        pf = sh.get("m_ParsedForm") or {}
        chunks = decompress_chunks(sh)
        entries = entry_table(chunks)
        totals["blobEntries"] += len(entries)

        parsed_entries = {}  # blobIndex -> SubProgram
        param_cache = {}  # paramBlobIndex -> parse_param_blob 結果
        subshaders = []
        for ssi, sub in enumerate(pf.get("m_SubShaders") or []):
            passes = []
            for pi, pass_ in enumerate(sub.get("m_Passes") or []):
                idx2name = name_indices_inv(pass_)
                state = pass_.get("m_State") or {}
                pname_ = state.get("m_Name") or ""
                stages = {}
                for field, stage_name, short in STAGE_FIELD:
                    prog = pass_.get(field) or {}
                    psp = prog.get("m_PlayerSubPrograms") or []
                    nonempty = [lst for lst in psp if lst]
                    if not nonempty:
                        continue
                    if len(nonempty) > 1:
                        failures.append(
                            {"shader": stem, "pass": pname_, "stage": stage_name,
                             "step": "parse", "error": f"m_PlayerSubPrograms 有 {len(nonempty)} 個非空子列表"}
                        )
                    variants = []
                    stage_common = common_parameters(prog, idx2name)
                    # 參數 blob 索引：與 m_PlayerSubPrograms 的非空子列表平行
                    pbi_raw = (prog.get("m_ParameterBlobIndices") or [])
                    pbi_list: list[int | None] = []
                    for item in pbi_raw:
                        if isinstance(item, str):
                            pbi_list = hex_u32s(item)
                            break
                    for vi, sp in enumerate(nonempty[0]):
                        bi = sp.get("m_BlobIndex")
                        variants.append(
                            {
                                "index": vi,
                                "blobIndex": bi,
                                "gpuProgramType": sp.get("m_GpuProgramType"),
                                "shaderRequirements": sp.get("m_ShaderRequirements"),
                            }
                        )
                        totals["programs"] += 1
                        if bi not in parsed_entries:
                            try:
                                chunk, off, elen = entries[bi]
                                parsed_entries[bi] = SubProgram(chunk, off, elen)
                            except Exception as e:
                                failures.append(
                                    {"shader": stem, "pass": pname_, "stage": stage_name,
                                     "blobIndex": bi, "step": "blob", "error": str(e)[:300]}
                                )
                                continue
                        entry = parsed_entries.get(bi)
                        if entry is not None:
                            h = hashlib.sha1(entry.dxbc).hexdigest()
                            if h not in jobs:
                                jobs[h] = {"dxbc": entry.dxbc, "stage": stage_name}
                        # 變體自己的參數 blob
                        if vi < len(pbi_list):
                            pbi = pbi_list[vi]
                            variant = variants[-1]
                            variant["parameterBlobIndex"] = pbi
                            try:
                                if pbi not in param_cache:
                                    chunk, off, elen = entries[pbi]
                                    param_cache[pbi] = parse_param_blob(chunk[off : off + elen])
                                merged = merge_parameters(stage_common, param_cache[pbi])
                                # 交叉驗證 slot：blob 宣告順序 vs blob bindings 記錄 vs YAML 共用 bindings
                                bind_slot = {b["name"]: b["slot"] for b in merged["cbBindings"]}
                                common_slot = {cb["name"]: cb.get("slot") for cb in stage_common["constantBuffers"]}
                                for i, cb in enumerate(merged["constantBuffers"]):
                                    bs = bind_slot.get(cb["name"])
                                    if bs is not None and bs != i:
                                        totals["paramSlotMismatch"] += 1
                                    cs = common_slot.get(cb["name"])
                                    if cs is not None and cs != i:
                                        totals["paramSlotVsCommon"] += 1
                                variant["parameters"] = merged
                                totals["paramBlobs"] += 1
                            except Exception as e:
                                failures.append(
                                    {"shader": stem, "pass": pname_, "stage": stage_name,
                                     "blobIndex": pbi, "step": "paramBlob", "error": str(e)[:300]}
                                )
                    stage_info = {
                        "gpuProgramType": (nonempty[0][0].get("m_GpuProgramType") if nonempty[0] else None),
                        "keywordStateMask": prog.get("m_SerializedKeywordStateMask") or "",
                        "parameters": stage_common,
                        "variants": variants,
                    }
                    stages[stage_name] = stage_info
                passes.append(
                    {
                        "index": pi,
                        "name": pname_,
                        # PassType：0 Normal、1 Use、2 Grab（GrabPass：把目前的畫面抓進 textureName，空字串是每個物件各抓一次的 _GrabTexture）
                        "type": pass_.get("m_Type") or 0,
                        "textureName": pass_.get("m_TextureName") or "",
                        "tags": (state.get("m_Tags") or {}).get("tags") or {},
                        "lod": state.get("m_LOD"),
                        "state": pass_state(state),
                        "stages": stages,
                    }
                )
            subshaders.append(
                {
                    "index": ssi,
                    "tags": (sub.get("m_Tags") or {}).get("tags") or {},
                    "lod": sub.get("m_LOD"),
                    "passes": passes,
                }
            )

        srec = {
            "stem": stem,
            "name": sh.get("m_Name"),
            "custom": stem.startswith(CUSTOM_PREFIXES),
            "fallback": pf.get("m_FallbackName"),
            "keywordNames": pf.get("m_KeywordNames") or [],
            "properties": prop_info(pf),
            "subShaders": subshaders,
            "entries": parsed_entries,  # 不進 index.json
        }
        if stem in stem2guid:
            srec["guid"] = stem2guid[stem]
        shaders.append(srec)

    print(f"解析完成：blob 條目 {totals['blobEntries']}，program 引用 {totals['programs']}，"
          f"唯一 DXBC {len(jobs)}（{time.time() - t0:.1f}s）")

    # phase 2: 轉換（依內容 hash 去重）
    workdir = Path(tempfile.mkdtemp(prefix="diceo-shaders-"))
    converted: dict[str, dict] = {}
    failed_hashes: dict[str, str] = {}
    done = 0
    with concurrent.futures.ThreadPoolExecutor(max_workers=args.jobs) as ex:
        futs = {ex.submit(convert_one, h, j["dxbc"], j["stage"], workdir): h for h, j in jobs.items()}
        for fut in concurrent.futures.as_completed(futs):
            h = futs[fut]
            try:
                converted[h] = fut.result()
            except Exception as e:
                failed_hashes[h] = str(e)[:300]
            done += 1
            if done % 200 == 0 or done == len(jobs):
                print(f"  轉換進度 {done}/{len(jobs)}（失敗 {len(failed_hashes)}）", flush=True)

    print(f"轉換完成：成功 {len(converted)}，失敗 {len(failed_hashes)}（{time.time() - t0:.1f}s）")

    # phase 3: 寫出每個 shader 的檔案與 index.json
    if out.exists():
        shutil.rmtree(out)
    out.mkdir(parents=True)

    variant_records = []  # (shader_stem, custom, pass, stage, variant, hash)
    for si, srec in enumerate(shaders):
        sdir = out / srec["stem"]
        sdir.mkdir(exist_ok=True)
        for sub in srec["subShaders"]:
            for pass_ in sub["passes"]:
                pfx = f"pass{pass_['index']}_{sanitize(pass_['name'])}"
                if len(srec["subShaders"]) > 1:
                    pfx = f"sub{sub['index']}_{pfx}"
                for stage_name, stage_info in pass_["stages"].items():
                    short = next(sh for f, s, sh in STAGE_FIELD if s == stage_name)
                    for variant in stage_info["variants"]:
                        bi = variant["blobIndex"]
                        entry = srec["entries"].get(bi)
                        if entry is None:
                            continue
                        h = hashlib.sha1(entry.dxbc).hexdigest()
                        base = f"{pfx}_{short}_{bi}"
                        files = {}
                        (sdir / f"{base}.dxbc").write_bytes(entry.dxbc)
                        files["dxbc"] = f"{base}.dxbc"
                        if h in converted:
                            for ext in ["asm", "spv", "glsl"]:
                                src_f = workdir / f"{h}.{ext}"
                                if src_f.exists():
                                    (sdir / f"{base}.{ext}").write_bytes(src_f.read_bytes())
                                    files[ext] = f"{base}.{ext}"
                            refl = workdir / f"{h}.reflect.json"
                            if refl.exists():
                                variant["reflection"] = json.loads(refl.read_text())
                            if converted[h].get("patchNotes"):
                                variant["patchNotes"] = converted[h]["patchNotes"]
                            if converted[h].get("io"):
                                variant["varyings"] = converted[h]["io"]
                        # uniform block 名稱：stage 後綴，執行環境照 stage 各自填。
                        # 優先用變體自己參數表裡的 CB（參數 blob 的宣告順序 = slot）；
                        # 沒有參數 blob 的變體退回 stage 共用表。
                        stg_suffix = "vs" if stage_name == "vertex" else "fs"
                        cb_source = (variant.get("parameters") or stage_info["parameters"])["constantBuffers"]
                        variant["uniformBlocks"] = {
                            cb["name"]: {"block": f"cb{cb['slot']}_{stg_suffix}_buf", "instance": f"cb{cb['slot']}_{stg_suffix}", "slot": cb["slot"]}
                            for cb in cb_source
                            if cb.get("slot") is not None
                        }
                        variant["keywords"] = entry.keywords
                        variant["dxbcSize"] = len(entry.dxbc)
                        variant["dxbcSha1"] = h
                        variant["files"] = files
                        variant["converted"] = h in converted
                        variant_records.append((srec, pass_, stage_name, variant, h))

    # phase 4: 批次 glslangValidator 檢查
    glsl_files = sorted(out.glob("**/*.glsl"))
    validate_fail = {}
    chunk = 100
    groups = [glsl_files[i : i + chunk] for i in range(0, len(glsl_files), chunk)]

    def validate_group(group):
        # glslangValidator 依副檔名判 stage；用獨一無二的 symlink 名放臨時目錄
        results = {}
        with tempfile.TemporaryDirectory(prefix="diceo-validate-") as td:
            tdp = Path(td)
            links = {}
            for f in group:
                stage = "vert" if "_vert_" in f.name else "frag"
                link = tdp / (f"{f.parent.name}__{f.stem}.{stage}")
                link.symlink_to(f)
                links[link] = f
            p = run(["glslangValidator", *[str(l) for l in links]], timeout=600)
            output = p.stdout + p.stderr
            # 逐檔判斷：有 "ERROR: <file>" 行才算失敗
            for l, f in links.items():
                if re.search(rf"ERROR: {re.escape(str(l))}", output):
                    msg = next(
                        (ln for ln in output.splitlines() if str(l) in ln and "ERROR" in ln),
                        "",
                    )
                    results[str(f)] = msg.strip()[:300]
        return results

    with concurrent.futures.ThreadPoolExecutor(max_workers=args.jobs) as ex:
        for res in ex.map(validate_group, groups):
            validate_fail.update(res)
    print(f"glslangValidator：{len(glsl_files)} 個 GLSL，失敗 {len(validate_fail)}")

    # 把驗證結果回填 variant
    for srec, pass_, stage_name, variant, h in variant_records:
        glsl_rel = variant.get("files", {}).get("glsl")
        if glsl_rel:
            full = out / srec["stem"] / glsl_rel
            variant["glslValidated"] = str(full) not in validate_fail
        else:
            variant["glslValidated"] = False

    # 材質 -> 用到的變體（同一變體被多個材質用只算一次）
    mat_by_shader = defaultdict(list)
    for m in materials:
        if m["shader"]:
            mat_by_shader[m["shader"]].append(m)
    used_missing = []
    used_variants = {}  # id(variant dict) -> variant
    for srec in shaders:
        mats = mat_by_shader.get(srec["stem"], [])
        if not mats:
            continue
        # Unity 的比對規則：材質 keyword 不在 shader 的 keyword 空間裡會被丟掉，
        # 用剩下的精確比對；找不到就退而求其次，取子集裡最大的一個（記錄 fallback）。
        kw_space = set(srec["keywordNames"])
        for sub in srec["subShaders"]:
            for pass_ in sub["passes"]:
                for stage_name, stage_info in pass_["stages"].items():
                    for variant in stage_info["variants"]:
                        kw_space.update(variant.get("keywords") or [])
        for sub in srec["subShaders"]:
            for pass_ in sub["passes"]:
                for stage_name, stage_info in pass_["stages"].items():
                    for m in mats:
                        effective = set(m["keywords"]) & kw_space
                        match = None
                        for variant in stage_info["variants"]:
                            if set(variant.get("keywords") or []) == effective:
                                match = variant
                                break
                        fallback = False
                        if match is None:
                            best = -1
                            for variant in stage_info["variants"]:
                                vk = set(variant.get("keywords") or [])
                                if vk <= effective and len(vk) > best:
                                    best = len(vk)
                                    match = variant
                            fallback = match is not None
                        if match is None:
                            used_missing.append(
                                {"material": m["file"], "shader": srec["stem"],
                                 "pass": pass_["name"], "stage": stage_name, "keywords": m["keywords"]}
                            )
                            continue
                        match.setdefault("usedByMaterials", [])
                        if m["name"] not in match["usedByMaterials"]:
                            match["usedByMaterials"].append(m["name"])
                        if fallback or effective != set(m["keywords"]):
                            match.setdefault("usedByMaterialsFallback", [])
                            rec = {"material": m["name"], "materialKeywords": m["keywords"]}
                            if rec not in match["usedByMaterialsFallback"]:
                                match["usedByMaterialsFallback"].append(rec)
                        used_variants[id(match)] = match
    used_total = len(used_variants)
    used_ok = sum(1 for v in used_variants.values() if v.get("converted") and v.get("glslValidated"))

    # 寫 index.json（拿掉 entries）
    for srec in shaders:
        srec_out = {k: v for k, v in srec.items() if k not in ("entries", "custom")}
        srec_out["file"] = srec["stem"] + ".asset"
        srec_out["materials"] = [m["name"] for m in mat_by_shader.get(srec["stem"], [])]
        (out / srec["stem"] / "index.json").write_text(
            json.dumps(srec_out, ensure_ascii=False, indent=2, sort_keys=True) + "\n"
        )

    # WebGL2 不支援（structured buffer → std430）：跟轉換失敗分開列
    webgl_unsupported = []
    for srec, pass_, stage_name, variant, h in variant_records:
        glsl_rel = variant.get("files", {}).get("glsl")
        if not glsl_rel:
            continue
        if "std430" in (out / srec["stem"] / glsl_rel).read_text():
            variant["webglUnsupported"] = "std430"
            webgl_unsupported.append(
                {
                    "shader": srec["name"],
                    "pass": pass_["name"],
                    "stage": stage_name,
                    "keywords": variant.get("keywords") or [],
                    "materials": sorted(variant.get("usedByMaterials") or []),
                    "reason": "structured buffer（std430 / SSBO），WebGL2 不支援",
                }
            )

    # constant buffer 清點
    cb_inventory = defaultdict(lambda: {"offsets": set(), "stages": set(), "shaders": set()})
    for srec in shaders:
        for sub in srec["subShaders"]:
            for pass_ in sub["passes"]:
                for stage_name, stage_info in pass_["stages"].items():
                    for cb in stage_info["parameters"]["constantBuffers"]:
                        rec = cb_inventory[cb["name"]]
                        rec["stages"].add(stage_name)
                        rec["shaders"].add(srec["stem"])
                        for v in cb["vectors"]:
                            rec["offsets"].add(f"{v['name']}@{v['offset']}")
                        for mm in cb["matrices"]:
                            rec["offsets"].add(f"{mm['name']}@{mm['offset']}")
    cb_out = {
        name: {
            "stages": sorted(rec["stages"]),
            "shaderCount": len(rec["shaders"]),
            "fields": sorted(rec["offsets"]),
        }
        for name, rec in sorted(cb_inventory.items())
    }

    custom_shaders = [s for s in shaders if s["custom"]]
    custom_variants = [r for r in variant_records if r[0]["custom"]]
    used_custom_shaders = sorted({m["shader"] for m in materials if m["shader"] and m["shader"].startswith(CUSTOM_PREFIXES)})

    distinct_programs = sum(len(s["entries"]) for s in shaders)
    report = {
        "source": str(shader_dir),
        "tools": {
            "dxbc-spirv": f"{DXBC_SPIRV_BIN}（c7f0697 + dxbc-spirv-local.patch）",
            "spirv-cross": (lambda p: (p.stdout + p.stderr).strip().splitlines()[0])(subprocess.run(["spirv-cross", "--version"], capture_output=True, text=True)),
            "glslangValidator": subprocess.run(["glslangValidator", "-v"], capture_output=True, text=True).stdout.strip().splitlines()[0],
        },
        "totals": {
            "shaders": len(shaders),
            "blobEntries": totals["blobEntries"],
            "programReferences": totals["programs"],
            "distinctPrograms": distinct_programs,
            "parameterBlobs": totals["blobEntries"] - distinct_programs,
            "uniqueDxbc": len(jobs),
            "converted": len(converted),
            "convertFailed": len(failed_hashes),
            "glslFiles": len(glsl_files),
            "glslValidated": len(glsl_files) - len(validate_fail),
            "paramBlobsParsed": totals["paramBlobs"],
            "paramSlotMismatch": totals["paramSlotMismatch"],
            "paramSlotVsCommon": totals["paramSlotVsCommon"],
        },
        "customShaders": {
            "count": len(custom_shaders),
            "variants": len(custom_variants),
            "variantsConverted": sum(1 for r in custom_variants if r[3]["converted"]),
            "variantsValidated": sum(1 for r in custom_variants if r[3].get("glslValidated")),
            "usedByMaterials": used_custom_shaders,
        },
        "usedVariants": {
            "count": used_total,
            "convertedAndValidated": used_ok,
            "missing": used_missing,
        },
        "webglUnsupported": webgl_unsupported,
        "materials": materials,
        "constantBuffers": cb_out,
        "failures": failures
        + [{"step": "convert", "dxbcSha1": h, "error": e} for h, e in sorted(failed_hashes.items())]
        + [{"step": "validate", "file": f, "error": e} for f, e in sorted(validate_fail.items())],
    }
    (out / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True) + "\n")

    print(f"\n=== 摘要 ===")
    print(f"shader: {len(shaders)}，blob 條目: {totals['blobEntries']}，program 引用: {totals['programs']}，唯一 DXBC: {len(jobs)}")
    print(f"參數 blob 解析: {totals['paramBlobs']}；slot 不一致: {totals['paramSlotMismatch']}（vs binding）/{totals['paramSlotVsCommon']}（vs common）")
    print(f"轉換: {len(converted)}/{len(jobs)}；GLSL 驗證: {len(glsl_files) - len(validate_fail)}/{len(glsl_files)}")
    print(f"自製 shader: {len(custom_shaders)}，變體 {len(custom_variants)}，轉出+驗證 {sum(1 for r in custom_variants if r[3].get('glslValidated'))}")
    print(f"材質用到的變體: {used_total}，轉出+驗證 {used_ok}，缺變體 {len(used_missing)}")
    print(f"總耗時 {time.time() - t0:.1f}s")

    shutil.rmtree(workdir, ignore_errors=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())

"""Unity 匯出專案（AssetRipper）的共用工具：YAML 載入、GUID 索引、PPtr 正規化、頂點資料解碼、MonoScript 的 fileID。

assets.py（素材）和 scenes.py（場景樹）共用。來源是 diceomancer-web 的 scripts/import/unity.py，遊戲專屬的部分改成設定。
"""

from __future__ import annotations

import os
import re
import struct
from pathlib import Path

import yaml

# ───────── YAML ─────────

# 有 libyaml 就用 C 版解析器，大量 sprite 與 shader 檔差很多
_BaseLoader = getattr(yaml, "CSafeLoader", yaml.SafeLoader)


class UnityLoader(_BaseLoader):
    """Unity 的 YAML：布林寫成 0/1，不該把 yes/on 當布林，也不該把 0123 當八進位。"""


UnityLoader.yaml_implicit_resolvers = {
    first: [
        (tag, rx)
        for tag, rx in resolvers
        if tag
        not in (
            "tag:yaml.org,2002:bool",
            "tag:yaml.org,2002:int",
            "tag:yaml.org,2002:float",
            "tag:yaml.org,2002:timestamp",
        )
    ]
    for first, resolvers in yaml.SafeLoader.yaml_implicit_resolvers.items()
}
UnityLoader.add_implicit_resolver(
    "tag:yaml.org,2002:int", re.compile(r"^-?(?:0|[1-9][0-9]*)$"), list("-0123456789")
)
UnityLoader.add_implicit_resolver(
    "tag:yaml.org,2002:float",
    re.compile(r"^-?(?:[0-9]+\.[0-9]*|\.[0-9]+|[0-9]+)(?:[eE][-+]?[0-9]+)?$"),
    list("-.0123456789"),
)
UnityLoader.add_multi_constructor(
    "tag:unity3d.com,2011:", lambda loader, suffix, node: loader.construct_mapping(node, deep=True)
)

# 一份 Unity YAML 檔可以有很多個物件，每個以 `--- !u!<classID> &<fileID>` 開頭
DOC_HEADER = re.compile(r"^--- !u!(\d+) &(-?\d+)( stripped)?[ \t]*$", re.M)

# Unity 把 byte／int 陣列寫成十六進位字串。全是數字或長得像 123e456 時會被當成數字讀走，要先加引號。
# 已知欄位不管長短都加；其他欄位只要值是 16 字元以上的純十六進位也加（GUID、雜湊、blob）。
HEX_KEYS = (
    "_typelessdata",
    "m_IndexBuffer",
    "m_ComponentGlyphIDs",
    "m_OpeningTagArray",
    "m_ClosingTagArray",
    "WeightList",
    "ElementList",
    "cbVariantIndices",
)
HEX_KEY_LINE = re.compile(r"^(\s*(?:- )?(?:" + "|".join(HEX_KEYS) + r")): ([0-9a-f]+)[ \t]*$", re.M)
HEX_LONG_LINE = re.compile(r"^(\s*(?:- )?[^\s:{}\[\]#][^:{}\[\]#]*): ([0-9a-f]{16,})[ \t]*$", re.M)

# 場景與 prefab 裡寫成十六進位的基本型別陣列：遊戲自己的列舉陣列（例如 Diceomancer 的 ColorE[] colorEs）
# Unity 寫成十六進位字串，要照 C# 宣告解成 int32 陣列。哪些欄位是遊戲決定的，由設定檔的 import.int32ArrayKeys 給（set_int32_array_keys）。
# 同名的單一列舉欄位寫成短整數，所以只有長度是 8 的倍數時才當陣列。
INT32_ARRAY_KEYS: tuple[str, ...] = ()
# 套件的陣列欄位保留原始十六進位字串，用到時照 C# 型別解
RAW_HEX_ARRAY_KEYS = ("m_ActiveFontFeatures", "m_ApplyToSortingLayers", "m_VertexStreams")
HEX_ARRAY_LINE = re.compile(r"^(\s*(?:- )?(?:" + "|".join(RAW_HEX_ARRAY_KEYS) + r")): ((?:[0-9a-f]{8})+)[ \t]*$", re.M)
# 一定是陣列、元素可能是 byte 的欄位：不管長度（偶數個十六進位字）都保留原字串，執行環境照 C# 型別解。
# RotaryHeart 的 SerializableDictionary（TKey[] _keys、List<TKey> _keyValues）：TKey 是 byte 列舉時 4 個鍵只有 8 個字（00010203），會被讀成數字 10203
RAW_HEX_ANY_KEYS = ("_keys", "_keyValues")
HEX_ANY_LINE = re.compile(r"^(\s*(?:- )?(?:" + "|".join(RAW_HEX_ANY_KEYS) + r")): ((?:[0-9a-f]{2})+)[ \t]*$", re.M)
# 沒列在上面、但值看起來是十六進位陣列（8–15 字元、含 a-f 或開頭是 0）的欄位：匯入時回報，避免默默讀錯
SUSPECT_HEX_LINE = re.compile(r"^\s*(?:- )?([A-Za-z_]\w*): ([0-9a-f]{8,15})[ \t]*$", re.M)
KNOWN_HEX_KEYS = set(HEX_KEYS) | set(RAW_HEX_ARRAY_KEYS) | set(RAW_HEX_ANY_KEYS)


def set_int32_array_keys(keys: list[str] | tuple[str, ...]) -> None:
    """設定遊戲自己的列舉陣列欄位（設定檔 import.int32ArrayKeys）。"""
    global INT32_ARRAY_KEYS, HEX_ARRAY_LINE, KNOWN_HEX_KEYS
    INT32_ARRAY_KEYS = tuple(keys)
    HEX_ARRAY_LINE = re.compile(
        r"^(\s*(?:- )?(?:" + "|".join(INT32_ARRAY_KEYS + RAW_HEX_ARRAY_KEYS) + r")): ((?:[0-9a-f]{8})+)[ \t]*$", re.M
    )
    KNOWN_HEX_KEYS = set(HEX_KEYS) | set(INT32_ARRAY_KEYS) | set(RAW_HEX_ARRAY_KEYS) | set(RAW_HEX_ANY_KEYS)


def suspect_hex_keys(text: str) -> set[str]:
    out = set()
    for m in SUSPECT_HEX_LINE.finditer(text):
        key, val = m.group(1), m.group(2)
        if key not in KNOWN_HEX_KEYS and (val[0] == "0" or re.search(r"[a-f]", val)):
            out.add(key)
    return out


def decode_int32_arrays(v, key: str | None = None):
    """把 INT32_ARRAY_KEYS 的十六進位字串解成 int32 little-endian 陣列。"""
    if isinstance(v, dict):
        return {k: decode_int32_arrays(x, k) for k, x in v.items()}
    if isinstance(v, list):
        return [decode_int32_arrays(x, key) for x in v]
    if key in INT32_ARRAY_KEYS and isinstance(v, str) and v and len(v) % 8 == 0:
        return list(struct.unpack(f"<{len(v) // 8}i", bytes.fromhex(v)))
    return v


# PPtr 裡的 guid（flow mapping，例如 {fileID: 10101, guid: 0000000000000000e000000000000000, type: 0}）
# 長得像科學記號時會被讀成 0.0，一律當字串
GUID_VALUE = re.compile(r"\bguid: ([0-9a-f]{32})\b")
# Unity 的字串欄位寫成 `m_text: 88` 時沒有引號，會被讀成數字（10/5 量到：TMP 文字 285 個、名稱 23 個）。
# 只處理型別確定是字串的 Unity 欄位；遊戲自己的 string 欄位一樣可能被讀成數字，移植時照 C# 型別轉。
STRING_KEY_NUMBER = re.compile(r"^(\s*(?:- )?(?:m_Name|m_text|m_TagString)): ([-+.0-9eE]+)[ \t]*$", re.M)


def load_yaml_text(text: str) -> list[dict]:
    text = GUID_VALUE.sub(r'guid: "\1"', text)
    text = STRING_KEY_NUMBER.sub(r'\1: "\2"', text)
    return [d for d in yaml.load_all(text, Loader=UnityLoader) if d]


def quote_hex(text: str) -> str:
    text = HEX_KEY_LINE.sub(r'\1: "\2"', text)
    text = HEX_ARRAY_LINE.sub(r'\1: "\2"', text)
    text = HEX_ANY_LINE.sub(r'\1: "\2"', text)
    return HEX_LONG_LINE.sub(r'\1: "\2"', text)


def load_unity_docs(path: Path, text: str | None = None) -> list[dict]:
    """回傳 [{classID, fileID, stripped, type, data}]，type 是物件的類別名稱（Sprite、Material…）。

    %TAG 只對檔案裡第一個物件有效，後面物件的 `!u!` 標籤解析不了，所以標頭先換成單純的 `---`，
    classID 與 fileID 另外從標頭讀。
    """
    if text is None:
        text = path.read_text(encoding="utf-8", errors="replace")
    headers = list(DOC_HEADER.finditer(text))
    docs = load_yaml_text(quote_hex(DOC_HEADER.sub("---", text)))
    if len(docs) != len(headers):
        raise ValueError(f"{path.name}：{len(headers)} 個物件標頭，解析出 {len(docs)} 個")
    out = []
    for h, d in zip(headers, docs):
        (type_name, data), = d.items()
        out.append(
            {
                "classID": int(h.group(1)),
                "fileID": h.group(2),  # 字串：常超過 2^53，JavaScript 的數字放不下
                "stripped": bool(h.group(3)),
                "type": type_name,
                "data": data if data is not None else {},
            }
        )
    return out


# ───────── GUID 索引 ─────────

GUID_RE = re.compile(r"^guid: ([0-9a-f]{32})", re.M)


def build_guid_index(assets: Path) -> dict[str, Path]:
    """guid → 資產路徑（去掉 .meta）。"""
    index: dict[str, Path] = {}
    for dirpath, _dirs, files in os.walk(assets):
        for f in files:
            if not f.endswith(".meta"):
                continue
            p = Path(dirpath) / f
            with p.open("r", encoding="utf-8", errors="replace") as fh:
                head = fh.read(200)
            m = GUID_RE.search(head)
            if m:
                index[m.group(1)] = p.with_suffix("")
    return index


# ───────── PPtr ─────────


def is_pptr(v: dict) -> bool:
    keys = set(v)
    return bool(keys) and keys <= {"fileID", "guid", "type"} and "fileID" in keys


MAX_SAFE_INT = 2**53 - 1


def norm_refs(v):
    """把 PPtr 換成精簡形式，其餘原樣保留（欄位名稱跟原版一樣）。

    - {fileID: 0} → None（空參照）
    - 指向別的檔案 → {"guid", "fileID"}（同一個檔案可能有多個物件，fileID 要留）
    - 同一個檔案裡的物件 → {"fileID"}
    - fileID 一律是字串；其他超過 2^53 的整數也轉字串（JavaScript 的數字放不下）
    """
    if isinstance(v, dict):
        if is_pptr(v):
            if not v.get("fileID") and not v.get("guid"):
                return None
            if "guid" in v:
                return {"guid": str(v["guid"]), "fileID": str(v["fileID"])}
            return {"fileID": str(v["fileID"])}
        return {k: norm_refs(x) for k, x in v.items()}
    if isinstance(v, list):
        return [norm_refs(x) for x in v]
    if isinstance(v, int) and not isinstance(v, bool) and abs(v) > MAX_SAFE_INT:
        return str(v)
    return v


def strip_meta_fields(d: dict) -> dict:
    """拿掉每個 Unity 物件都有、執行時用不到的欄位。"""
    drop = ("m_ObjectHideFlags", "m_CorrespondingSourceObject", "m_PrefabInstance", "m_PrefabAsset")
    return {k: v for k, v in d.items() if k not in drop}


# ───────── MonoScript 的 fileID ─────────


def md4(msg: bytes) -> bytes:
    """RFC 1320。hashlib 在 OpenSSL 3 預設沒有 md4，自己算。"""
    mask = 0xFFFFFFFF

    def rol(v: int, s: int) -> int:
        return ((v << s) | (v >> (32 - s))) & mask

    ml = len(msg) * 8
    msg += b"\x80" + b"\x00" * ((55 - len(msg)) % 64) + struct.pack("<Q", ml)
    h = [0x67452301, 0xEFCDAB89, 0x98BADCFE, 0x10325476]
    rounds = (
        (lambda x, y, z: (x & y) | (~x & z), 0, tuple(range(16)), (3, 7, 11, 19)),
        (lambda x, y, z: (x & y) | (x & z) | (y & z), 0x5A827999, (0, 4, 8, 12, 1, 5, 9, 13, 2, 6, 10, 14, 3, 7, 11, 15), (3, 5, 9, 13)),
        (lambda x, y, z: x ^ y ^ z, 0x6ED9EBA1, (0, 8, 4, 12, 2, 10, 6, 14, 1, 9, 5, 13, 3, 11, 7, 15), (3, 9, 11, 15)),
    )
    for off in range(0, len(msg), 64):
        x = struct.unpack("<16I", msg[off : off + 64])
        a, b, c, d = h
        for fn, k, order, shifts in rounds:
            for i, idx in enumerate(order):
                s = shifts[i % 4]
                if i % 4 == 0:
                    a = rol((a + fn(b, c, d) + x[idx] + k) & mask, s)
                elif i % 4 == 1:
                    d = rol((d + fn(a, b, c) + x[idx] + k) & mask, s)
                elif i % 4 == 2:
                    c = rol((c + fn(d, a, b) + x[idx] + k) & mask, s)
                else:
                    b = rol((b + fn(c, d, a) + x[idx] + k) & mask, s)
        h = [(v + w) & mask for v, w in zip(h, (a, b, c, d))]
    return struct.pack("<4I", *h)


def script_file_id(namespace: str, class_name: str) -> int:
    """DLL 裡的腳本在 m_Script 的 fileID：MD4("s\\0\\0\\0" + namespace + 類別名) 前 4 bytes，int32 little-endian。

    10/5 對資料驗證：TMPro.TMP_FontAsset → -667331979，跟 TMP 字型資產的 m_Script 一致。
    """
    return struct.unpack("<i", md4(("s\0\0\0" + namespace + class_name).encode("utf-8"))[:4])[0]


# ───────── 數值 ─────────

_F32 = struct.Struct("<f")


def f32(x: float) -> float:
    """float32 轉成能還原成同一個 float32 的最短十進位，JSON 才不會一堆 0.30000001192092896。"""
    if x != x or x in (float("inf"), float("-inf")):
        return x
    packed = _F32.pack(x)
    for digits in (6, 7, 8):
        y = float(f"{x:.{digits}g}")
        if _F32.pack(y) == packed:
            return y
    return float(f"{x:.9g}")


# ───────── 頂點資料（Mesh、Sprite 的 m_VertexData，serializedVersion 3） ─────────

# VertexFormat（Unity 2019+）→ (struct 代碼, 位元組數, 正規化除數)
VERTEX_FORMATS = {
    0: ("f", 4, None),  # Float32
    1: ("e", 2, None),  # Float16
    2: ("B", 1, 255.0),  # UNorm8
    3: ("b", 1, 127.0),  # SNorm8
    4: ("H", 2, 65535.0),  # UNorm16
    5: ("h", 2, 32767.0),  # SNorm16
    6: ("B", 1, None),  # UInt8
    7: ("b", 1, None),  # SInt8
    8: ("H", 2, None),  # UInt16
    9: ("h", 2, None),  # SInt16
    10: ("I", 4, None),  # UInt32
    11: ("i", 4, None),  # SInt32
}
# VertexAttribute 的順序
CHANNEL_NAMES = (
    "position",
    "normal",
    "tangent",
    "color",
    "uv0",
    "uv1",
    "uv2",
    "uv3",
    "uv4",
    "uv5",
    "uv6",
    "uv7",
    "blendWeight",
    "blendIndices",
)


def decode_vertex_data(vd: dict) -> dict:
    """把 m_VertexData 解成 {channel 名稱: {dimension, values（攤平）}}。

    每個 stream 依序排列，stream 之間對齊到 16 bytes；大小跟 m_DataSize 對不上就丟錯。
    dimension 只取低 4 位元（儲存的分量數）。高 4 位元有值時另外記成 rawDimension：
    例如 default mesh 的 normal 是 52（0x34），存成 4 個 float16，前 3 個是法向量、第 4 個全是 0（10/5 實測）。
    """
    count = int(vd.get("m_VertexCount") or 0)
    raw = vd.get("_typelessdata") or ""
    data = bytes.fromhex(raw) if isinstance(raw, str) else b""
    channels = vd.get("m_Channels") or []

    strides: dict[int, int] = {}
    for ch in channels:
        dim = int(ch["dimension"]) & 0xF
        if not dim:
            continue
        size = VERTEX_FORMATS[int(ch["format"])][1] * dim
        s = int(ch["stream"])
        strides[s] = max(strides.get(s, 0), int(ch["offset"]) + size)

    stream_offsets: dict[int, int] = {}
    pos = 0
    for s in sorted(strides):
        pos = (pos + 15) & ~15
        stream_offsets[s] = pos
        pos += strides[s] * count
    expected = int(vd.get("m_DataSize") or 0)
    if pos != expected or len(data) != expected:
        raise ValueError(f"頂點資料大小不符：算出 {pos}，m_DataSize {expected}，實際 {len(data)}")

    out: dict[str, dict] = {}
    for i, ch in enumerate(channels):
        dim = int(ch["dimension"]) & 0xF
        if not dim:
            continue
        code, size, norm = VERTEX_FORMATS[int(ch["format"])]
        s = int(ch["stream"])
        unpack = struct.Struct("<" + code * dim).unpack_from
        base = stream_offsets[s] + int(ch["offset"])
        stride = strides[s]
        values: list = []
        for v in range(count):
            comps = unpack(data, base + v * stride)
            if norm is not None:
                values.extend(f32(c / norm) for c in comps)
            elif code in ("f", "e"):
                values.extend(f32(c) for c in comps)
            else:
                values.extend(comps)
        entry = {"dimension": dim, "values": values}
        if int(ch["dimension"]) != dim:
            entry["rawDimension"] = int(ch["dimension"])
        out[CHANNEL_NAMES[i] if i < len(CHANNEL_NAMES) else f"channel{i}"] = entry
    return out


def decode_index_buffer(hex_str: str | None, index_format: int = 0) -> list[int]:
    """m_IndexBuffer：index_format 0 是 UInt16、1 是 UInt32，little-endian。"""
    if not hex_str:
        return []
    data = bytes.fromhex(hex_str)
    code, size = ("H", 2) if index_format == 0 else ("I", 4)
    return list(struct.unpack(f"<{len(data) // size}{code}", data))

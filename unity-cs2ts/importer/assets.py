"""素材匯入：把 AssetRipper 匯出的素材全部匯進 <out>/assets/。來源是 diceomancer-web 的 scripts/import/assets.py（第 0b 階段），遊戲專屬的部分拿掉。

執行環境（第 0d 階段起）用 GUID 找素材：場景與 prefab 的參照是 {guid, fileID}，
所以每張表都以 GUID 當 key，檔案也用 GUID 命名（原版名稱會撞，例如好幾個 `Atlas_0`）。
欄位名稱照 Unity 序列化的原樣（m_Rect、m_Pivot…），不改名、不換算；例外只有下面寫明的幾處。

輸出：
  report.json            每一類的來源數量、匯出數量、失敗清單；沒匯入的類別與原因
  textures.json          guid → 名稱、尺寸、匯入設定（filterMode、wrap、sRGB、mipmap…）；
                         Texture2DArray 另有 depth（層數，從原版 build 讀，見 texture_array_depths）
  textures/<guid>.png    原檔（APFS 上用 clonefile，不佔額外空間）
  sprites.json           guid → Sprite 物件（拿掉 m_PhysicsShape 等用不到的；m_RD 只留座標，網格另存）
                         m_Rect、m_Pivot、m_Offset、m_RD.textureRectOffset 改用原版 build 的值，見 rebase_sprites
  sprite-meshes/<guid>.json  Sprite 的網格（position、indices），SpriteRenderer 照這個畫；
                         UV 用 m_RD.uvTransform 從 position 算，公式見 _sprite_worker
  fonts.json、fonts/<guid>.ttf|otf   字型原檔與 TrueTypeFontImporter 設定
  materials.json         guid → Material（m_SavedProperties 原樣）＋ shaderName
  shaders.json           guid → 屬性表（m_PropInfo）、keyword、SubShader／Pass 的 tags 與 render state
  animations.json        guid → AnimationClip（曲線原樣，Infinity 以字串 "Infinity"/"-Infinity" 保留）
  animators.json         guid → AnimatorController／AnimatorOverrideController 的全部物件（以 fileID 為 key）
  meshes/<guid>.json     Mesh（頂點資料解碼），一個網格一個檔；meshes/index.json 是全部 guid 的清單。
                         執行環境照依賴閉包只載用到的（以前是整包 meshes.json，MT2 有 91 MB，開機要全部讀完），見 write_meshes
  physicMaterials.json   guid → PhysicMaterial（D8、D12、D20 骰子的碰撞材質）
  monobehaviours.json    guid → 名稱、種類；內容在 objects/<guid>.json（TMP 字型、TMP 設定、URP、Volume…）
  texts.json             guid → TextAsset 內容（TMP 斷行字元表等）；.bytes 與二進位的另有 file（texts/<guid>.bytes，Spine 的 .skel.bytes）
  audio/<名稱>.bank      FMOD bank 原檔（有的話）
  audioclips.json、audioclips/<guid>.<副檔名>  Unity 內建聲音（AudioClip）的原檔與匯入設定；Ogg Vorbis 另有
                         channels、frequency、samples（從檔案標頭與最後一頁的 granule position 讀，AudioClip.length ＝ samples / frequency）
  audiomixers.json       guid → AudioMixerController（.mixer）：群組樹、各群組的音量／音高參數、快照的參數值、曝露參數、輸出到哪個群組
  builtin.json           Unity 內建資源（UISprite、Sprites-Default、Quad 這類內建網格…），key 是 "<guid>:<fileID>"；
                         本體從原版 build 讀（AssetRipper 把它們改寫成內建參照，沒有匯出），見 export_builtin
  textures/builtin-<名稱>.png  上面這些 sprite 的貼圖
  project.json           ProjectSettings（sorting layer、色彩空間、URP 設定的參照…）
  addressables.json      Addressables 的 key → 匯出的 GUID（原版 AssetReference 存的原專案 GUID、位址字串），見 export_addressables

和 Unity 原樣不同的地方：
  - PPtr 寫成 {guid, fileID}（外部）、{fileID}（同檔）、null（空），見 unity.norm_refs
  - shader 屬性的 m_DefValue[0]…[3] 合成一個陣列 m_DefValue
  - render state 的 {val, name} 收成數值；有綁材質屬性（name 非空）時寫成 {val, prop}
"""

from __future__ import annotations

import ctypes
import json
import os
import re
import shutil
import sys
import time
from collections import Counter
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path

from PIL import Image

from unity import (
    decode_index_buffer,
    decode_vertex_data,
    load_unity_docs,
    load_yaml_text,
    norm_refs,
    strip_meta_fields,
)

# ───────── 共用 ─────────


def write_json(path: Path, obj) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(obj, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")


def write_meshes(out: Path, table: dict) -> None:
    """guid → Mesh 的表寫成 meshes/<guid>.json 一個網格一個檔，加 meshes/index.json（guid 清單）。舊的整包 meshes.json 刪掉"""
    d = out / "meshes"
    if d.exists():
        shutil.rmtree(d)
    for guid, mesh in table.items():
        write_json(d / f"{guid}.json", mesh)
    write_json(d / "index.json", sorted(table))
    (out / "meshes.json").unlink(missing_ok=True)


_libc = None
if sys.platform == "darwin":
    try:
        _libc = ctypes.CDLL("/usr/lib/libSystem.B.dylib", use_errno=True)
        _libc.clonefile.argtypes = (ctypes.c_char_p, ctypes.c_char_p, ctypes.c_int)
        _libc.clonefile.restype = ctypes.c_int
    except (OSError, AttributeError):
        _libc = None


def clone(src: Path, dst: Path) -> None:
    """APFS 上用 clonefile（寫入時才複製），其他情況退回一般複製。"""
    if _libc is not None and _libc.clonefile(os.fsencode(src), os.fsencode(dst), 0) == 0:
        return
    shutil.copyfile(src, dst)


def first_doc_type(path: Path) -> str | None:
    with path.open("r", encoding="utf-8", errors="replace") as fh:
        head = fh.read(400)
    m = re.search(r"^--- !u!\d+ &-?\d+(?: stripped)?\n(\w+):", head, re.M)
    return m.group(1) if m else None


def build_asset_files(game_data: Path) -> list[Path]:
    """原版 build 裡存資產的檔案：globalgamemanagers.assets、resources.assets、sharedassets*、Addressables bundle（任何平台）。"""
    files = [game_data / "globalgamemanagers.assets", game_data / "resources.assets", *sorted(game_data.glob("sharedassets*.assets"))]
    aa = game_data / "StreamingAssets" / "aa"
    if aa.is_dir():
        files += sorted(aa.rglob("*.bundle"))
    return [f for f in files if f.exists()]


class Category:
    """一類素材：來源清單、成功數、失敗清單。"""

    def __init__(self, name: str, assets: Path):
        self.name = name
        self.assets = assets
        self.sources: list[tuple[str, Path]] = []
        self.exported = 0
        self.failed: list[dict] = []

    def rel(self, p: Path) -> str:
        return str(p.relative_to(self.assets))

    def fail(self, p: Path, err: object) -> None:
        self.failed.append({"src": self.rel(p), "error": str(err)})

    def report(self) -> dict:
        return {"source": len(self.sources), "exported": self.exported, "failed": self.failed}


# ───────── 分類 ─────────

# 第 0b 階段沒匯入的物件類別與原因（照實寫進 report.json）
NOT_IMPORTED = {
    "ComputeShader": "compute shader：WebGL2 沒有 compute，用到時再看",
    "VisualEffectAsset": "VFX Graph：還沒做",
    "ShaderVariantCollection": "編輯器與預熱用，執行環境不需要",
    "LightingDataAsset": "烘焙光照資料：還沒做",
    "LightProbes": "烘焙光照資料：還沒做",
    "Prefab/Scene": "scenes.py（場景樹匯入）",
    "Script": "C# 原始碼與 DLL：轉換器的輸入，不是素材",
}

YAML_EXTS = {".asset", ".mat", ".anim", ".controller", ".overrideController", ".physicMaterial", ".shadervariants", ".playable"}
AUDIO_EXTS = {".ogg", ".wav", ".mp3", ".aif", ".aiff"}


def classify(assets: Path, guids: dict[str, Path]) -> tuple[dict[str, Category], Counter]:
    cats = {
        n: Category(n, assets)
        for n in (
            "textures",
            "sprites",
            "fonts",
            "materials",
            "shaders",
            "animations",
            "animators",
            "meshes",
            "physicMaterials",
            "monobehaviours",
            "texts",
            "audioclips",
            "audiomixers",
        )
    }
    skipped: Counter = Counter()
    for guid, p in sorted(guids.items(), key=lambda kv: str(kv[1])):
        if not p.is_file():
            continue  # 資料夾也有 .meta
        ext = p.suffix
        if ext == ".png":
            cats["textures"].sources.append((guid, p))
        elif ext in (".ttf", ".otf"):
            cats["fonts"].sources.append((guid, p))
        elif ext == ".shader":
            cats["shaders"].sources.append((guid, p))
        elif ext.lower() in AUDIO_EXTS:
            cats["audioclips"].sources.append((guid, p))
        elif ext == ".mixer":
            cats["audiomixers"].sources.append((guid, p))
        elif ext in (".txt", ".bytes", ".json"):
            cats["texts"].sources.append((guid, p))
        elif ext in (".cs", ".dll"):
            skipped["Script"] += 1
        elif ext in (".prefab", ".unity"):
            skipped["Prefab/Scene"] += 1
        elif ext in YAML_EXTS:
            t = first_doc_type(p)
            if t == "Sprite":
                cats["sprites"].sources.append((guid, p))
            elif t == "Material":
                cats["materials"].sources.append((guid, p))
            elif t == "AnimationClip":
                cats["animations"].sources.append((guid, p))
            elif t in ("AnimatorController", "AnimatorOverrideController"):
                cats["animators"].sources.append((guid, p))
            elif t == "Mesh":
                cats["meshes"].sources.append((guid, p))
            elif t == "PhysicMaterial":
                cats["physicMaterials"].sources.append((guid, p))
            elif t == "Shader":
                # AssetRipper --shader-yaml：shader 本身就是 YAML（含 m_ParsedForm），材質直接指到它
                cats["shaders"].sources.append((guid, p))
            elif t == "MonoBehaviour":
                cats["monobehaviours"].sources.append((guid, p))
            else:
                skipped[t or f"未知（{ext}）"] += 1
        else:
            skipped[f"其他副檔名 {ext or '(無)'}"] += 1
    return cats, skipped


# ───────── 貼圖 ─────────

# TextureImporter 裡執行時會影響畫面的欄位
TEXTURE_IMPORTER_KEYS = (
    "textureType",
    "textureShape",
    "alphaUsage",
    "alphaIsTransparency",
    "spriteMode",
    "spritePixelsToUnits",
    "spriteMeshType",
    "spriteBorder",
    "spritePivot",
    "nPOTScale",
    "maxTextureSize",
    "textureFormat",
    "flipbookRows",
    "flipbookColumns",
    "isReadable",  # Read/Write：TMP 動態字型的 atlas 要寫得進去（Diceomancer 的江城圓體 600W 烘了字又開著）
)


def texture_importer(meta: Path) -> dict:
    docs = load_yaml_text(meta.read_text(encoding="utf-8", errors="replace"))
    imp = docs[0].get("TextureImporter") or {}
    mips = imp.get("mipmaps") or {}
    ts = imp.get("textureSettings") or {}
    out = {k: imp[k] for k in TEXTURE_IMPORTER_KEYS if k in imp}
    out.update(
        sRGBTexture=mips.get("sRGBTexture"),
        enableMipMap=mips.get("enableMipMap"),
        filterMode=ts.get("filterMode"),
        aniso=ts.get("aniso"),
        mipBias=ts.get("mipBias"),
        wrapU=ts.get("wrapU"),
        wrapV=ts.get("wrapV"),
        wrapW=ts.get("wrapW"),
    )
    return out


def export_textures(cat: Category, out: Path) -> dict:
    table = {}
    tex_dir = out / "textures"
    tex_dir.mkdir(parents=True)
    for guid, p in cat.sources:
        try:
            with Image.open(p) as im:
                w, h = im.size
                mode = im.mode
            importer = texture_importer(p.with_name(p.name + ".meta"))
            clone(p, tex_dir / f"{guid}.png")
        except Exception as e:  # noqa: BLE001 — 失敗照實記錄
            cat.fail(p, e)
            continue
        table[guid] = {
            "name": p.stem,
            "src": cat.rel(p),
            "file": f"textures/{guid}.png",
            "width": w,
            "height": h,
            "pngMode": mode,
            "importer": importer,
        }
        cat.exported += 1
    return table


def texture_array_depths(game_data: Path, textures: dict) -> dict:
    """Texture2DArray（textureShape 4）的層數寫進 textures.json 的 depth。

    AssetRipper 把每一層由上往下直排成一張 PNG，meta 的 flipbookRows／flipbookColumns 卻是 0，層數沒有留下來。
    這裡讀原版 build 的 Texture2DArray，用名稱對，並確認 PNG 尺寸等於 m_Width ×（m_Height · m_Depth）。
    10/11 對過：BurnFxTable、cardburnmaskTable 都是 512×512、8 層（在 globalgamemanagers.assets）；
    PNG 由上往下第 i 格跟 UnityPy 解出的第 i 層逐像素相同，方向也一樣（每格最下面一列是 v = 0）。
    """
    import UnityPy

    rep = {"matched": 0, "unmatched": []}
    arrays = {g: t for g, t in textures.items() if t["importer"].get("textureShape") == 4}
    if not arrays:
        return rep
    if not (game_data / "globalgamemanagers.assets").exists():
        rep["unmatched"] = sorted(t["src"] for t in arrays.values())
        return rep
    files = build_asset_files(game_data)
    by_name: dict[str, list[dict]] = {}
    for f in files:
        for obj in UnityPy.load(str(f)).objects:
            if obj.type.name != "Texture2DArray":
                continue
            t = obj.read_typetree()
            by_name.setdefault(t["m_Name"], []).append({k: int(t[k]) for k in ("m_Width", "m_Height", "m_Depth")})
    for rec in arrays.values():
        hits = {h["m_Depth"] for h in by_name.get(rec["name"], []) if h["m_Width"] == rec["width"] and h["m_Height"] * h["m_Depth"] == rec["height"]}
        if len(hits) != 1:
            rep["unmatched"].append(rec["src"])
            continue
        rec["depth"] = hits.pop()
        rep["matched"] += 1
    return rep


# ───────── Sprite ─────────

SPRITE_DROP = ("m_PhysicsShape", "m_Bones", "m_AtlasRD", "m_RenderDataKey", "m_AtlasTags", "m_SpriteID")
RD_MESH_KEYS = ("m_SubMeshes", "m_IndexBuffer", "m_VertexData", "m_Bindpose")


def _sprite_worker(args: tuple[str, str, str]) -> tuple[str, dict | None, str | None]:
    """在子行程裡解析一個 Sprite：回傳 sprites.json 的紀錄，網格直接寫檔。"""
    guid, path_s, mesh_dir_s = args
    try:
        docs = load_unity_docs(Path(path_s))
        sprite = next(d["data"] for d in docs if d["type"] == "Sprite")
        rd = sprite.get("m_RD") or {}
        channels = decode_vertex_data(rd.get("m_VertexData") or {})
        if not sprite.get("m_Bones"):
            # 沒有骨架時 blend 權重與索引沒有意義
            channels.pop("blendWeight", None)
            channels.pop("blendIndices", None)
        # build 裡的 sprite 網格沒存 UV（4491 個只有 Splash 有，其餘全是 0）。
        # UV 由頂點算：u = (x·uvTransform.x + uvTransform.y) / 貼圖寬，v = (y·uvTransform.z + uvTransform.w) / 貼圖高。
        # 10/5 驗證：Splash 存的 UV 跟公式逐點相同；全部 sprite 的頂點換算後都落在 textureRect 內（最多超出 1 px，等於 m_Extrude）。
        channels.pop("uv0", None)
        mesh = {
            "vertexCount": int((rd.get("m_VertexData") or {}).get("m_VertexCount") or 0),
            "subMeshes": norm_refs(rd.get("m_SubMeshes") or []),
            "indices": decode_index_buffer(rd.get("m_IndexBuffer"), 0),
            **{name: ch["values"] for name, ch in channels.items()},
            "dimensions": {name: ch["dimension"] for name, ch in channels.items()},
        }
        write_json(Path(mesh_dir_s) / f"{guid}.json", mesh)
        rec = {k: v for k, v in strip_meta_fields(sprite).items() if k not in SPRITE_DROP}
        rec["m_RD"] = {k: v for k, v in rd.items() if k not in RD_MESH_KEYS}
        rec["vertexCount"] = mesh["vertexCount"]
        rec["mesh"] = f"sprite-meshes/{guid}.json"
        return guid, norm_refs(rec), None
    except Exception as e:  # noqa: BLE001
        return guid, None, f"{type(e).__name__}: {e}"


def export_sprites(cat: Category, out: Path, textures: dict) -> dict:
    mesh_dir = out / "sprite-meshes"
    mesh_dir.mkdir(parents=True)
    paths = dict(cat.sources)
    table = {}
    jobs = [(g, str(p), str(mesh_dir)) for g, p in cat.sources]
    with ProcessPoolExecutor() as pool:
        for guid, rec, err in pool.map(_sprite_worker, jobs, chunksize=64):
            p = paths[guid]
            if err:
                cat.fail(p, err)
                continue
            tex = ((rec.get("m_RD") or {}).get("texture") or {}).get("guid")
            if tex not in textures:
                cat.fail(p, f"貼圖 {tex} 不在 textures.json")
                continue
            rec["src"] = cat.rel(p)
            table[guid] = rec
            cat.exported += 1
    return dict(sorted(table.items()))


def rebase_sprites(game_data: Path, sprites: dict) -> dict:
    """AssetRipper 把有透明 padding 的 sprite 改寫成「範圍 = 有圖的部分」：m_Rect 改成 textureRect、
    textureRectOffset 歸 0、pivot 與 m_Offset 跟著調。SpriteRenderer 看不出差別（網格相對 pivot 不變），
    但 uGUI 的 Image 是照整個 sprite 範圍排版（padding 那圈透明的也算），會被拉長。
    10/5 量到 4491 個裡有 3684 個被改過（例：title_white_en 原版 1280×720，匯出變成 1076×132）。

    這裡用原版 build（資產檔 + Addressables bundle）的值蓋回去，用（名稱, textureRect）對應。
    """
    import UnityPy

    rep = {"matched": 0, "rebased": 0, "unmatched": [], "ambiguous": []}
    if not (game_data / "globalgamemanagers.assets").exists():
        rep["unmatched"].append("找不到原版 build（設定檔 import.game）")
        return rep
    files = build_asset_files(game_data)
    # 先用名稱找，再比 textureRect（誤差 0.01 px；四捨五入當 key 會在進位邊界上對不到）
    by_name: dict[str, list[dict]] = {}
    for f in files:
        for obj in UnityPy.load(str(f)).objects:
            if obj.type.name != "Sprite":
                continue
            t = obj.read_typetree()
            by_name.setdefault(t["m_Name"], []).append(t)

    def same_rect(a: dict, b: dict) -> bool:
        return all(abs(float(a[k]) - float(b[k])) < 0.01 for k in ("x", "y", "width", "height"))

    pick = ("m_Rect", "m_Pivot", "m_Offset")
    for guid, rec in sprites.items():
        hits = [t for t in by_name.get(rec["m_Name"], []) if same_rect(t["m_RD"]["textureRect"], rec["m_RD"]["textureRect"])]
        if not hits:
            rep["unmatched"].append(rec["src"])
            continue
        vals = [json.dumps({k: h[k] for k in pick} | {"o": h["m_RD"]["textureRectOffset"]}, sort_keys=True) for h in hits]
        if len(set(vals)) > 1:
            rep["ambiguous"].append(rec["src"])
            continue
        b = hits[0]
        rep["matched"] += 1
        if (b["m_Rect"]["width"], b["m_Rect"]["height"]) != (rec["m_Rect"]["width"], rec["m_Rect"]["height"]):
            rep["rebased"] += 1
        for k in pick:
            rec[k] = {kk: float(vv) for kk, vv in b[k].items()} if isinstance(b[k], dict) else b[k]
        rec["m_RD"]["textureRectOffset"] = {k: float(v) for k, v in b["m_RD"]["textureRectOffset"].items()}
    return rep


# ───────── 字型 ─────────


def export_fonts(cat: Category, out: Path) -> dict:
    table = {}
    font_dir = out / "fonts"
    font_dir.mkdir(parents=True)
    for guid, p in cat.sources:
        try:
            meta = load_yaml_text(p.with_name(p.name + ".meta").read_text(encoding="utf-8", errors="replace"))[0]
            importer = meta.get("TrueTypeFontImporter") or {}
            ext = p.suffix.lower()
            clone(p, font_dir / f"{guid}{ext}")
        except Exception as e:  # noqa: BLE001
            cat.fail(p, e)
            continue
        table[guid] = {
            "name": p.stem,
            "src": cat.rel(p),
            "file": f"fonts/{guid}{ext}",
            "bytes": p.stat().st_size,
            "importer": norm_refs(importer),
        }
        cat.exported += 1
    return table


# ───────── shader ─────────

SHADER_NAME_RE = re.compile(r'^\s*Shader\s+"([^"]+)"', re.M)
BLOB_LINE_RE = re.compile(r"^  compressedBlob: [0-9a-f]*\n", re.M)
PASS_DROP_PREFIX = ("prog",)
PASS_DROP = ("m_EditorDataHash", "m_NameIndices", "m_Platforms", "m_HasInstancingVariant", "m_HasProceduralInstancingVariant", "m_ProgramMask", "m_PackageRequirements", "m_CombinedStatus", "m_StatusMessage", "m_Requirements")


def collapse_state(v):
    """render state 的 {val, name}：name 空的收成數值，name 有值代表綁材質屬性，寫成 {val, prop}。"""
    if isinstance(v, dict):
        if set(v) == {"val", "name"}:
            return {"val": v["val"], "prop": v["name"]} if v["name"] else v["val"]
        return {k: collapse_state(x) for k, x in v.items()}
    if isinstance(v, list):
        return [collapse_state(x) for x in v]
    return v


def shader_props(parsed: dict) -> list[dict]:
    props = []
    for p in (parsed.get("m_PropInfo") or {}).get("m_Props") or []:
        q = {k: v for k, v in p.items() if not k.startswith("m_DefValue[")}
        q["m_DefValue"] = [p.get(f"m_DefValue[{i}]") for i in range(4)]
        props.append(q)
    return props


def shader_subshaders(parsed: dict) -> list[dict]:
    out = []
    for ss in parsed.get("m_SubShaders") or []:
        passes = []
        for ps in ss.get("m_Passes") or []:
            passes.append(
                collapse_state(
                    {
                        k: v
                        for k, v in ps.items()
                        if k not in PASS_DROP and not k.startswith(PASS_DROP_PREFIX) and k != "serializedVersion"
                    }
                )
            )
        rest = {k: v for k, v in ss.items() if k not in ("m_Passes", "m_PackageRequirements")}
        out.append({**rest, "m_Passes": passes})
    return out


def _shader_record(ypath: Path, rel_to: Path) -> tuple[str, dict]:
    text = BLOB_LINE_RE.sub("", ypath.read_text(encoding="utf-8", errors="replace"))
    shader = next(d["data"] for d in load_unity_docs(ypath, text) if d["type"] == "Shader")
    parsed = shader.get("m_ParsedForm") or {}
    name = parsed.get("m_Name") or shader.get("m_Name")
    return name, {
        "name": name,
        "yamlSrc": str(ypath.relative_to(rel_to)),
        "m_PropInfo": shader_props(parsed),
        "m_KeywordNames": parsed.get("m_KeywordNames"),
        "m_FallbackName": parsed.get("m_FallbackName"),
        "m_SubShaders": shader_subshaders(parsed),
    }


def export_shaders(cat: Category, shader_src: Path | None) -> tuple[dict, dict[str, str]]:
    """兩種匯出都吃：
    - AssetRipper --shader-yaml：shader 本身是 YAML 資產（m_ParsedForm 有屬性與 render state），材質直接指到它。
    - 預設的 .shader 空殼（材質指向它）：屬性與 render state 要從另一份 --shader-yaml 匯出（import.shaderExport）用名稱對；
      兩份匯出的 shader GUID 不一樣，只能用名稱對（Diceomancer 的 CardArtShader：主匯出 0559640f…，YAML 匯出 339e0c72…）。
    """
    yaml_by_name: dict[str, Path] = {}
    if shader_src is not None and any(p.suffix == ".shader" for _, p in cat.sources):
        yaml_assets = shader_src / "Assets"
        for p in sorted(yaml_assets.rglob("*.asset")):
            if first_doc_type(p) != "Shader":
                continue
            with p.open("r", encoding="utf-8", errors="replace") as fh:
                head = fh.read(4000)
            m = re.search(r"^  m_Name: (.+)$", head, re.M)
            if m:
                yaml_by_name[m.group(1).strip()] = p

    table = {}
    names: dict[str, str] = {}
    for guid, p in cat.sources:
        try:
            if p.suffix == ".shader":
                m = SHADER_NAME_RE.search(p.read_text(encoding="utf-8", errors="replace")[:2000])
                if not m:
                    raise ValueError('讀不到 Shader "名稱"')
                ypath = yaml_by_name.get(m.group(1))
                if ypath is None:
                    raise ValueError(f"YAML 匯出裡沒有 {m.group(1)}（import.shaderExport）")
                name, rec = _shader_record(ypath, shader_src / "Assets")
            else:
                name, rec = _shader_record(p, cat.assets)
        except Exception as e:  # noqa: BLE001
            cat.fail(p, e)
            continue
        names[guid] = name
        table[guid] = {"src": cat.rel(p), **rec}
        cat.exported += 1
    return table, names


# ───────── 單一物件的 YAML 資產（material、clip、mesh） ─────────


def export_single(cat: Category, type_name: str, extra=None) -> dict:
    table = {}
    for guid, p in cat.sources:
        try:
            docs = load_unity_docs(p)
            obj = next(d for d in docs if d["type"] == type_name)
            rec = norm_refs(strip_meta_fields(obj["data"]))
            rec = {"src": cat.rel(p), "fileID": obj["fileID"], **rec}
            if extra:
                extra(rec, obj["data"])
        except Exception as e:  # noqa: BLE001
            cat.fail(p, e)
            continue
        table[guid] = rec
        cat.exported += 1
    return table


def export_materials(cat: Category, shader_names: dict[str, str]) -> dict:
    builtin = {
        "0000000000000000f000000000000000": "unity_builtin_extra",
        "0000000000000000e000000000000000": "unity default resources",
    }

    def extra(rec: dict, _raw: dict) -> None:
        sh = rec.get("m_Shader") or {}
        rec["shaderName"] = shader_names.get(sh.get("guid", ""))
        if sh.get("guid") in builtin:
            # Unity 內建 shader 不在匯出裡，只有 fileID；對應哪個 shader 要另外查證，這裡不猜
            rec["builtinShader"] = {"resources": builtin[sh["guid"]], "fileID": sh["fileID"]}

    return export_single(cat, "Material", extra)


# 材質的內建 shader（unity_builtin_extra 的 fileID）→ shader 名稱。build 裡材質參照的 Standard、Unlit/…、Legacy 粒子 shader 是打包時複製進
# sharedassets 的複本，AssetRipper 認出是引擎資源，改寫成 {guid: 0000000000000000f000000000000000, fileID} 而沒有匯出。名稱這樣查：
#   1. build 裡同名的材質，它的 m_Shader 指到的 Shader 的 m_ParsedForm.m_Name（同一個 fileID 的全部材質要一致）；
#   2. 沒有材質對得到的，看 unity_builtin_extra 裡 pathID 就是這個 fileID 的物件是不是 Shader（本體在那裡的內建 shader，例如 Legacy Shaders/Diffuse）。
# 2026/10/17 MT2：45 Standard (Specular setup)、46 Standard、104 Skybox/6 Sided、200 Legacy Shaders/Particles/Additive、10751 Unlit/Transparent Cutout…
# 對不到或對到兩個名字的不寫（記在 report 的 builtinShaders）。查到的寫進材質的 shaderName 與 builtinShader.name，shaders 步驟照名稱從 build 抽 shader 來轉。
def name_builtin_shaders(game_data: Path, materials: dict) -> dict:
    import UnityPy

    by_name: dict[str, set[str]] = {}
    for m in materials.values():
        b = m.get("builtinShader")
        if b and b["resources"] == "unity_builtin_extra":
            by_name.setdefault(m.get("m_Name") or "", set()).add(str(b["fileID"]))
    seen: dict[str, dict[str, int]] = {}
    for path in build_asset_files(game_data):
        if path.suffix == ".bundle":
            continue
        env = UnityPy.load(str(path))
        for obj in env.objects:
            if obj.type.name != "Material":
                continue
            try:
                mat = obj.read()
                fids = by_name.get(mat.m_Name)
                if not fids:
                    continue
                shader_name = mat.m_Shader.read().m_ParsedForm.m_Name
            except Exception:  # noqa: BLE001 — 讀不到的材質不算數
                continue
            for fid in fids:
                seen.setdefault(fid, {})
                seen[fid][shader_name] = seen[fid].get(shader_name, 0) + 1
    table: dict[str, str] = {}
    failed: list[str] = []
    extra = game_data / "Resources" / "unity_builtin_extra"
    extra_objs = {str(o.path_id): o for o in UnityPy.load(str(extra)).objects} if extra.exists() else {}
    for fid in sorted({f for fs in by_name.values() for f in fs}, key=int):
        names = seen.get(fid, {})
        if len(names) == 1:
            table[fid] = next(iter(names))
        elif len(names) > 1:
            failed.append(f"fileID {fid} 對到多個 shader：{names}")
        elif fid in extra_objs and extra_objs[fid].type.name == "Shader":
            table[fid] = extra_objs[fid].read().m_ParsedForm.m_Name
        else:
            failed.append(f"fileID {fid}：build 裡沒有對得到的材質，unity_builtin_extra 也沒有這個 Shader")
    for m in materials.values():
        b = m.get("builtinShader")
        if b and b["resources"] == "unity_builtin_extra" and str(b["fileID"]) in table:
            b["name"] = table[str(b["fileID"])]
            m["shaderName"] = b["name"]
    return {"table": table, "failed": failed}


def export_meshes(cat: Category) -> dict:
    def extra(rec: dict, raw: dict) -> None:
        vd = raw.get("m_VertexData") or {}
        channels = decode_vertex_data(vd)
        rec.pop("m_VertexData", None)
        rec.pop("m_IndexBuffer", None)
        rec.pop("m_CompressedMesh", None)
        rec["vertexCount"] = int(vd.get("m_VertexCount") or 0)
        rec["indices"] = decode_index_buffer(raw.get("m_IndexBuffer"), int(raw.get("m_IndexFormat") or 0))
        rec["channels"] = channels
        if raw.get("m_MeshCompression"):
            raise ValueError("m_MeshCompression 非 0，要改解 m_CompressedMesh")

    return export_single(cat, "Mesh", extra)


def export_animators(cat: Category) -> dict:
    table = {}
    for guid, p in cat.sources:
        try:
            docs = load_unity_docs(p)
            root = next(d for d in docs if d["type"] in ("AnimatorController", "AnimatorOverrideController"))
            objects = {
                str(d["fileID"]): {"type": d["type"], **norm_refs(strip_meta_fields(d["data"]))} for d in docs
            }
        except Exception as e:  # noqa: BLE001
            cat.fail(p, e)
            continue
        table[guid] = {
            "name": root["data"].get("m_Name"),
            "src": cat.rel(p),
            "type": root["type"],
            "root": root["fileID"],
            "objects": objects,
        }
        cat.exported += 1
    return table


# ───────── MonoBehaviour 資產 ─────────


def mono_kind(data: dict) -> str | None:
    """script 指到不在匯出裡的套件（TMP、URP…）時 GUID 查不到類別，用欄位判斷種類。"""
    keys = set(data)
    if {"m_FaceInfo", "m_GlyphTable"} <= keys or "m_fontInfo" in keys:
        return "TMP_FontAsset"
    if "m_SpriteGlyphTable" in keys or "spriteInfoList" in keys:
        return "TMP_SpriteAsset"
    if "m_StyleList" in keys:
        return "TMP_StyleSheet"
    if {"topLeft", "topRight", "bottomLeft", "bottomRight"} <= keys:
        return "TMP_ColorGradient"
    if "m_defaultFontAsset" in keys:
        return "TMP_Settings"
    if "components" in keys and "isGlobal" not in keys and "m_RendererFeatures" not in keys:
        return "VolumeProfile"
    return None


def export_monobehaviours(cat: Category, out: Path, guids: dict[str, Path], assets: Path, game_data: Path | None) -> dict:
    """ScriptableObject 資產：主物件（fileID 11400000）的欄位，加上同一個檔裡的其他物件（$subObjects，fileID → $script 類別與欄位）。

    Timeline 的 .playable 是一個 TimelineAsset 帶著它的 track 與 clip（都是同檔的 MonoBehaviour，m_Tracks、m_Clips 用 {fileID} 互指）。
    腳本是 .cs 的類別名就是檔名；在 DLL 裡的（TimelineAsset、TMP_FontAsset…）照 m_Script 的 fileID 到 build 的 MonoScript 表反查。
    """
    from scenes import ScriptResolver  # scenes 也 import 這個模組，這裡才載

    resolver = ScriptResolver(assets, game_data, guids) if game_data else None

    def class_of(data: dict) -> str | None:
        script = data.get("m_Script") or {}
        sp = guids.get(script.get("guid", ""))
        if sp is not None and sp.suffix == ".cs":
            return sp.stem
        r = resolver.resolve(script) if resolver and script.get("guid") else None
        return r.get("class") if r else None

    obj_dir = out / "objects"
    obj_dir.mkdir(parents=True)
    table = {}
    for guid, p in cat.sources:
        try:
            docs = [d for d in load_unity_docs(p) if d["type"] == "MonoBehaviour"]
            mono = next((d for d in docs if d["fileID"] == "11400000"), docs[0])
            data = mono["data"]
            script = data.get("m_Script") or {}
            sp = guids.get(script.get("guid", ""))
            cls = class_of(data)
            rec = {
                "src": cat.rel(p),
                "fileID": mono["fileID"],
                **norm_refs(strip_meta_fields(data)),
            }
            # $ 開頭的鍵是匯入器加的（不會跟 C# 欄位撞名）
            subs = {d["fileID"]: {"$script": class_of(d["data"]), **norm_refs(strip_meta_fields(d["data"]))} for d in docs if d is not mono}
            if subs:
                rec["$subObjects"] = subs
            write_json(obj_dir / f"{guid}.json", rec)
        except Exception as e:  # noqa: BLE001
            cat.fail(p, e)
            continue
        table[guid] = {
            "name": data.get("m_Name"),
            "src": cat.rel(p),
            "kind": mono_kind(data),
            # 類別名：.cs 是檔名；DLL 裡的照 m_Script 的 fileID 反查（查不到是 null，用 kind）
            "script": cls,
            "scriptIsAssembly": bool(sp and sp.suffix == ".dll") or (sp is None and cls is not None),
            "file": f"objects/{guid}.json",
        }
        cat.exported += 1
    return table


def export_texts(cat: Category, out: Path) -> dict:
    """TextAsset：文字放進表裡（text）。.bytes 與解不開 UTF-8 的（Spine 的 .skel.bytes）另存原檔 texts/<guid>.bytes（file），
    執行環境預載時抓下來給 TextAsset.bytes；解得開的 .bytes 照樣帶 text（Unity 的 TextAsset.text 也是 UTF-8 解碼）。"""
    table = {}
    d = out / "texts"
    for guid, p in cat.sources:
        try:
            raw = p.read_bytes()
            try:
                text = raw.decode("utf-8")
            except UnicodeDecodeError:
                text = None
            rec = {"name": p.stem, "src": cat.rel(p)}
            if text is not None:
                rec["text"] = text
            if text is None or p.suffix == ".bytes":
                d.mkdir(parents=True, exist_ok=True)
                clone(p, d / f"{guid}.bytes")
                rec["file"] = f"texts/{guid}.bytes"
                rec["bytes"] = len(raw)
        except Exception as e:  # noqa: BLE001
            cat.fail(p, e)
            continue
        table[guid] = rec
        cat.exported += 1
    return table


# ───────── AudioClip ─────────

AUDIO_IMPORTER_KEYS = ("loadInBackground", "ambisonic", "preloadAudioData", "forceToMono", "normalize")


def export_audioclips(cat: Category, out: Path) -> dict:
    """Unity 內建聲音（AudioClip）：原檔照抄，加上 AudioImporter 裡執行時會影響播放的設定（loadType、取樣率覆寫…）。"""
    table = {}
    d = out / "audioclips"
    d.mkdir(parents=True)
    for guid, p in cat.sources:
        try:
            meta = load_yaml_text(p.with_name(p.name + ".meta").read_text(encoding="utf-8", errors="replace"))[0]
            imp = meta.get("AudioImporter") or {}
            ext = p.suffix.lower()
            clone(p, d / f"{guid}{ext}")
        except Exception as e:  # noqa: BLE001
            cat.fail(p, e)
            continue
        table[guid] = {
            "name": p.stem,
            "src": cat.rel(p),
            "file": f"audioclips/{guid}{ext}",
            "bytes": p.stat().st_size,
            "importer": {k: imp[k] for k in AUDIO_IMPORTER_KEYS if k in imp} | {"defaultSettings": imp.get("defaultSettings")},
        } | (ogg_vorbis_info(p) if ext == ".ogg" else {})
        cat.exported += 1
    return table


def ogg_vorbis_info(p: Path) -> dict:
    """Ogg Vorbis 的聲道數、取樣率（identification header：\\x01vorbis 之後 4 位元組版本、1 位元組聲道、4 位元組取樣率，little endian）
    與總樣本數（最後一個 Ogg 頁的 granule position，第 6–13 位元組）。不是 Vorbis 或讀不到回空的。
    Unity 匯入時 sampleRateSetting 0（Preserve）才是原檔的取樣率；MT2 全部是 0"""
    data = p.read_bytes()
    i = data.find(b"\x01vorbis")
    last = data.rfind(b"OggS")
    if i < 0 or last < 0 or last + 14 > len(data):
        return {}
    channels = data[i + 11]
    frequency = int.from_bytes(data[i + 12 : i + 16], "little")
    samples = int.from_bytes(data[last + 6 : last + 14], "little", signed=True)
    if frequency <= 0 or samples < 0:
        return {}
    return {"channels": channels, "frequency": frequency, "samples": samples}


# ───────── AudioMixer ─────────


def export_audiomixers(cat: Category) -> dict:
    """AudioMixerController（.mixer）。Unity 的混音器在 build 裡是同一個類別，欄位照原樣挑執行時用得到的：
      groups      fileID → 名稱、子群組、音量與音高參數的 GUID（m_Volume、m_Pitch）、mute、效果（名稱與參數，Attenuation 就是群組音量）
      snapshots   fileID → 名稱、m_FloatValues（參數 GUID → 值；沒列的參數用預設：音量 0 dB、音高 1）
      exposed     m_ExposedParameters：{guid, name}。build 只存名稱的 CRC32，AssetRipper 補的名稱是 CRC32 相同的字串，
                  執行環境照 CRC32 比對 AudioMixer.SetFloat 的名稱
      output      m_OutputGroup：輸出到別的混音器的群組（{guid, fileID}），null 是直接到 AudioListener"""
    table = {}
    for guid, p in cat.sources:
        try:
            docs = load_unity_docs(p)
            root = next(d for d in docs if d["type"] == "AudioMixerController")
            effects = {str(d["fileID"]): norm_refs(strip_meta_fields(d["data"])) for d in docs if d["type"] == "AudioMixerEffectController"}
            groups = {}
            for d in docs:
                if d["type"] != "AudioMixerGroupController":
                    continue
                g = norm_refs(strip_meta_fields(d["data"]))
                groups[str(d["fileID"])] = {
                    "name": g.get("m_Name"),
                    "groupID": g.get("m_GroupID"),
                    "children": [str(c["fileID"]) for c in (g.get("m_Children") or []) if c],
                    "volume": g.get("m_Volume"),
                    "pitch": g.get("m_Pitch"),
                    "mute": g.get("m_Mute", 0),
                    "solo": g.get("m_Solo", 0),
                    "bypassEffects": g.get("m_BypassEffects", 0),
                    "effects": [
                        {"name": e.get("m_EffectName"), "bypass": e.get("m_Bypass", 0), "parameters": e.get("m_Parameters") or [], "mixLevel": e.get("m_MixLevel")}
                        for e in (effects.get(str(r["fileID"])) for r in (g.get("m_Effects") or []) if r)
                        if e
                    ],
                }
            snapshots = {
                str(d["fileID"]): {"name": d["data"].get("m_Name"), "values": {str(k): v for k, v in (d["data"].get("m_FloatValues") or {}).items()}}
                for d in docs
                if d["type"] == "AudioMixerSnapshotController"
            }
            r = norm_refs(strip_meta_fields(root["data"]))
        except Exception as e:  # noqa: BLE001
            cat.fail(p, e)
            continue
        table[guid] = {
            "name": r.get("m_Name"),
            "src": cat.rel(p),
            "output": r.get("m_OutputGroup"),
            "master": str((r.get("m_MasterGroup") or {}).get("fileID")),
            "snapshotOrder": [str(x["fileID"]) for x in (r.get("m_Snapshots") or []) if x],
            "startSnapshot": str((r.get("m_StartSnapshot") or {}).get("fileID")),
            "updateMode": r.get("m_UpdateMode", 0),
            "exposed": r.get("m_ExposedParameters") or [],
            "groups": groups,
            "snapshots": snapshots,
        }
        cat.exported += 1
    return table


# ───────── FMOD bank ─────────


def export_banks(assets: Path, out: Path) -> dict:
    src_dir = assets / "StreamingAssets"
    banks = sorted(src_dir.glob("*.bank"))
    audio = out / "audio"
    audio.mkdir(parents=True)
    rep = {"source": len(banks), "exported": 0, "failed": [], "files": {}}
    for p in banks:
        try:
            clone(p, audio / p.name)
        except Exception as e:  # noqa: BLE001
            rep["failed"].append({"src": str(p.relative_to(assets)), "error": str(e)})
            continue
        rep["exported"] += 1
        rep["files"][p.name] = p.stat().st_size
    return rep


# ───────── Unity 內建資源（從原版 build） ─────────

BUILTIN_EXTRA = "0000000000000000f000000000000000"
# 場景參照的 unity_builtin_extra fileID → build 裡的物件。10/5 用原始 PPtr 位元組比對 level0–2 查證，
# 每次匯入在 scenes.py 重驗一次（verify_builtin_refs）。不要照 Unity 編輯器的印象改。
BUILTIN_OBJECTS = {
    "10754": ("Material", "Sprites-Default"),
    "10758": ("Material", "Sprites-Mask"),
    "10905": ("Sprite", "UISprite"),
    "10907": ("Sprite", "Background"),
    "10911": ("Sprite", "InputFieldBackground"),
    "10917": ("Sprite", "UIMask"),
}


# unity default resources（guid 0000000000000000e000000000000000）的內建網格：參照的 fileID 就是 Resources/unity default resources 裡的 pathID。
# 2026/10/16 用 UnityPy 讀 MT2 的 build 查證（10202 Cube、10206 Cylinder、10207 Sphere、10208 Capsule、10209 Plane、10210 Quad），
# 匯入時再驗一次類型與名稱，對不上就記失敗、不匯出。
BUILTIN_DEFAULT = "0000000000000000e000000000000000"
BUILTIN_DEFAULT_MESHES = {
    "10202": "Cube",
    "10206": "Cylinder",
    "10207": "Sphere",
    "10208": "Capsule",
    "10209": "Plane",
    "10210": "Quad",
}


def export_builtin_meshes(game_data: Path, table: dict, rep: dict) -> None:
    """內建網格照 MeshAssetRecord 的樣子（m_Name、vertexCount、indices、channels、m_SubMeshes、m_LocalAABB）放進 builtin.json 的 meshAsset 欄
    （sprite 的 mesh 欄是另一種格式，分開）。"""
    import UnityPy

    rep["source"] += len(BUILTIN_DEFAULT_MESHES)
    path = game_data / "Resources" / "unity default resources"
    if not path.exists():
        rep["failed"].append({"src": str(path), "error": "找不到 unity default resources"})
        return
    env = UnityPy.load(str(path))
    by_id = {str(o.path_id): o for o in env.objects}
    for file_id, name in BUILTIN_DEFAULT_MESHES.items():
        obj = by_id.get(file_id)
        try:
            if obj is None or obj.type.name != "Mesh":
                raise ValueError(f"pathID {file_id} 不是 Mesh（{obj.type.name if obj else '沒有這個物件'}）")
            t = obj.read_typetree()
            if t["m_Name"] != name:
                raise ValueError(f"pathID {file_id} 是 {t['m_Name']}，不是 {name}")
            if t.get("m_MeshCompression"):
                raise ValueError("m_MeshCompression 非 0，要改解 m_CompressedMesh")
            vd = dict(t["m_VertexData"])
            data = vd.pop("m_DataSize")
            vd["_typelessdata"], vd["m_DataSize"] = bytes(data).hex(), len(data)
            ib = t["m_IndexBuffer"]
            table[f"{BUILTIN_DEFAULT}:{file_id}"] = {
                "type": "Mesh",
                "name": name,
                "build": f"unity default resources#{file_id}",
                "meshAsset": {
                    "m_Name": name,
                    "vertexCount": int(vd["m_VertexCount"]),
                    "indices": decode_index_buffer(bytes(ib).hex() if not isinstance(ib, str) else ib, int(t.get("m_IndexFormat") or 0)),
                    "channels": decode_vertex_data(vd),
                    "m_SubMeshes": _pptr_to_none(t["m_SubMeshes"]),
                    "m_LocalAABB": _pptr_to_none(t["m_LocalAABB"]),
                },
            }
            rep["exported"] += 1
        except Exception as e:  # noqa: BLE001
            rep["failed"].append({"src": f"Mesh {name}", "error": f"{type(e).__name__}: {e}"})


def _pptr_to_none(v):
    """UnityPy 的 {m_FileID, m_PathID}：空的變 None，其他保留（只有少數欄位會用到，另外處理）。"""
    if isinstance(v, dict):
        if set(v) == {"m_FileID", "m_PathID"}:
            return None if not v["m_PathID"] else {"buildFileID": v["m_FileID"], "buildPathID": str(v["m_PathID"])}
        return {k: _pptr_to_none(x) for k, x in v.items()}
    if isinstance(v, list):
        # UnityPy 把 map 寫成 [(key, value)…]，轉回 YAML 的 {key: value}
        if v and all(isinstance(x, tuple) and len(x) == 2 and isinstance(x[0], str) for x in v):
            return {k: _pptr_to_none(x) for k, x in v}
        return [_pptr_to_none(x) for x in v]
    if isinstance(v, tuple):
        return [_pptr_to_none(x) for x in v]
    return v


def find_build_objects(game_data: Path, wanted: set[tuple[str, str]]) -> dict[tuple[str, str], list]:
    """在 build 的資產檔裡依（類別, 名稱）找物件，回傳 {(類別, 名稱): [(檔名, object reader)…]}。"""
    import UnityPy

    found: dict[tuple[str, str], list] = {}
    for path in build_asset_files(game_data):
        if path.suffix == ".bundle":
            continue
        fn = path.name
        env = UnityPy.load(str(path))
        for obj in env.objects:
            if obj.type.name not in {t for t, _ in wanted}:
                continue
            name = obj.peek_name() if hasattr(obj, "peek_name") else obj.read().m_Name
            if (obj.type.name, name) in wanted:
                found.setdefault((obj.type.name, name), []).append((fn, obj))
    return found


def export_builtin(game_data: Path, out: Path) -> dict:
    rep = {"source": len(BUILTIN_OBJECTS), "exported": 0, "failed": []}
    table: dict[str, dict] = {}
    if not (game_data / "globalgamemanagers.assets").exists():
        rep["failed"].append({"src": str(game_data), "error": "找不到原版 build（設定檔 import.game）"})
        return {"table": table, "report": rep}
    found = find_build_objects(game_data, set(BUILTIN_OBJECTS.values()))
    for file_id, (type_name, name) in BUILTIN_OBJECTS.items():
        hits = found.get((type_name, name), [])
        if len(hits) != 1:
            rep["failed"].append({"src": f"{type_name} {name}", "error": f"build 裡找到 {len(hits)} 個"})
            continue
        fn, obj = hits[0]
        try:
            t = _pptr_to_none(obj.read_typetree())
            rec = {"type": type_name, "name": name, "build": f"{fn}#{obj.path_id}"}
            if type_name == "Sprite":
                tex = obj.read().m_RD.texture.read()
                tex_file = f"textures/builtin-{name}.png"
                tex.image.save(out / tex_file)
                ts = tex.m_TextureSettings
                rec["texture"] = {
                    "name": tex.m_Name,
                    "file": tex_file,
                    "width": tex.m_Width,
                    "height": tex.m_Height,
                    "filterMode": ts.m_FilterMode,
                    "wrapU": ts.m_WrapU,
                    "wrapV": ts.m_WrapV,
                    "colorSpace": getattr(tex, "m_ColorSpace", None),
                }
                rd = t["m_RD"]
                vd = dict(rd["m_VertexData"])
                data = vd.pop("m_DataSize")
                vd["_typelessdata"], vd["m_DataSize"] = bytes(data).hex(), len(data)
                ib = rd["m_IndexBuffer"]
                channels = decode_vertex_data(vd)
                rec["mesh"] = {
                    "vertexCount": vd["m_VertexCount"],
                    "indices": decode_index_buffer(bytes(ib).hex() if not isinstance(ib, str) else ib, 0),
                    "position": channels["position"]["values"],
                }
                rec["sprite"] = {k: v for k, v in t.items() if k not in SPRITE_DROP}
                rec["sprite"]["m_RD"] = {k: v for k, v in rd.items() if k not in RD_MESH_KEYS and k != "texture"}
            else:
                shader = obj.read().m_Shader.read()
                rec["shaderName"] = shader.m_ParsedForm.m_Name
                rec["material"] = {k: v for k, v in t.items() if k != "m_Shader"}
            table[f"{BUILTIN_EXTRA}:{file_id}"] = rec
            rep["exported"] += 1
        except Exception as e:  # noqa: BLE001
            rep["failed"].append({"src": f"{type_name} {name}", "error": f"{type(e).__name__}: {e}"})
    export_builtin_meshes(game_data, table, rep)
    return {"table": table, "report": rep}


# ───────── ProjectSettings ─────────


def export_project(src: Path) -> dict:
    """ProjectSettings/*.asset 原樣轉 JSON，key 是檔名（TagManager 有 sorting layer，ProjectSettings 有色彩空間…）。

    注意：sorting layer 的 uniqueID 是無號 32 位元，元件的 m_SortingLayerID 存成有號 int32，比對時要轉。
    """
    out = {}
    for p in sorted((src / "ProjectSettings").glob("*.asset")):
        docs = load_unity_docs(p)
        out[p.stem] = {d["type"]: norm_refs(d["data"]) for d in docs}
    return out


# ───────── Addressables ─────────

# AssetRipper 匯出 bundle 裡的資產時換了副檔名（聲音轉 ogg、shader 與 shader graph 存成 .asset、模型存成 prefab）
ADDRESSABLE_EXT_ALT = {".wav": [".ogg"], ".mp3": [".ogg"], ".shader": [".asset"], ".shadergraph": [".asset"], ".fbx": [".prefab"], ".obj": [".prefab"]}


def _catalog_object(data: bytes, i: int):
    """SerializationUtilities.ReadObjectFromByteArray（Unity.Addressables 的原始碼）：只解 key 會用到的字串、整數、Hash128。"""
    t = data[i]
    i += 1
    if t == 0:  # AsciiString
        n = int.from_bytes(data[i : i + 4], "little", signed=True)
        return data[i + 4 : i + 4 + n].decode("ascii")
    if t == 1:  # UnicodeString（長度是位元組數）
        n = int.from_bytes(data[i : i + 4], "little", signed=True)
        return data[i + 4 : i + 4 + n].decode("utf-16-le")
    if t == 2:
        return int.from_bytes(data[i : i + 2], "little")
    if t == 3:
        return int.from_bytes(data[i : i + 4], "little")
    if t == 4:
        return int.from_bytes(data[i : i + 4], "little", signed=True)
    if t == 5:  # Hash128：一個位元組的長度 + ASCII
        return ("hash", data[i + 1 : i + 1 + data[i]].decode("ascii").lower())
    return None


def export_addressables(game_data: Path, guids: dict[str, Path], assets: Path) -> dict:
    """Addressables 的 key → 匯出的 GUID。

    原版的 AssetReference 存的是原專案的 GUID（m_AssetGUID，執行時當 Hash128 key）；bundle 裡的資產沒有 GUID，
    AssetRipper 匯出時另外配了新的。catalog.json（ContentCatalogData.CreateLocator 的格式）把 key 對到 internal id，
    internal id 就是原專案的資產路徑，匯出也放在同一個路徑：照路徑找 .meta 的 GUID。路徑找不到時，同資料夾、同檔名、
    換過副檔名（ADDRESSABLE_EXT_ALT）的候選只有一個才算。
    輸出 {"guids": {原 GUID: 匯出 GUID}, "addresses": {位址字串: 匯出 GUID}}。
    """
    import base64

    cat_path = game_data / "StreamingAssets" / "aa" / "catalog.json"
    if not cat_path.exists():
        return {"table": {"guids": {}, "addresses": {}}, "report": {"source": 0, "exported": 0, "failed": ["沒有 catalog.json"]}}
    cat = json.loads(cat_path.read_text(encoding="utf-8"))
    buckets_raw = base64.b64decode(cat["m_BucketDataString"])
    keys_raw = base64.b64decode(cat["m_KeyDataString"])
    entries_raw = base64.b64decode(cat["m_EntryDataString"])
    ids = cat["m_InternalIds"]
    root = assets.parent
    by_path = {str(p.relative_to(root)): g for g, p in guids.items() if p.is_relative_to(root)}

    def exported_guid(internal_id: str) -> str | None:
        if not internal_id.startswith("Assets/"):
            return None
        if internal_id in by_path:
            return by_path[internal_id]
        stem, ext = os.path.splitext(internal_id)
        hits = [by_path[stem + alt] for alt in ADDRESSABLE_EXT_ALT.get(ext.lower(), []) if stem + alt in by_path]
        return hits[0] if len(hits) == 1 else None

    n_entries = int.from_bytes(entries_raw[0:4], "little", signed=True)
    # 每筆 entry 開頭都是 internal id 的索引；步距看版本：MT2 的舊版（ShinyShoe 分支）16 bytes，
    # Addressables 1.x（Diceomancer）28 bytes（internalId、provider、依賴 key、依賴雜湊、data、primaryKey、型別）
    stride = (len(entries_raw) - 4) // n_entries if n_entries else 16
    entry_ids = [int.from_bytes(entries_raw[4 + k * stride : 8 + k * stride], "little", signed=True) for k in range(n_entries)]
    table = {"guids": {}, "addresses": {}}
    failed: list[str] = []
    n_buckets = int.from_bytes(buckets_raw[0:4], "little", signed=True)
    pos = 4
    for _ in range(n_buckets):
        off = int.from_bytes(buckets_raw[pos : pos + 4], "little", signed=True)
        cnt = int.from_bytes(buckets_raw[pos + 4 : pos + 8], "little", signed=True)
        ents = [int.from_bytes(buckets_raw[pos + 8 + 4 * j : pos + 12 + 4 * j], "little", signed=True) for j in range(cnt)]
        pos += 8 + 4 * cnt
        key = _catalog_object(keys_raw, off)
        paths = [ids[entry_ids[e]] for e in ents if ids[entry_ids[e]].startswith("Assets/")]
        if not paths or isinstance(key, int) or key is None:
            continue
        g = exported_guid(paths[0])
        if isinstance(key, tuple):
            if g:
                table["guids"][key[1]] = g
            else:
                failed.append(f"{key[1]} {paths[0]}")
        elif g:
            table["addresses"][key] = g
    report = {"source": len(table["guids"]) + len(failed), "exported": len(table["guids"]), "addresses": len(table["addresses"]), "failed": failed}
    return {"table": table, "report": report}


# ───────── 主程式 ─────────


def export_assets(assets: Path, shader_src: Path | None, out: Path, guids: dict[str, Path], game_data: Path | None = None) -> dict:
    t0 = time.time()
    if out.exists():
        shutil.rmtree(out)
    out.mkdir(parents=True)

    cats, skipped = classify(assets, guids)
    timings: dict[str, float] = {}

    def step(name: str, fn):
        t = time.time()
        result = fn()
        timings[name] = round(time.time() - t, 1)
        return result

    textures = step("textures", lambda: export_textures(cats["textures"], out))
    texture_arrays = step("textureArrays", lambda: texture_array_depths(game_data, textures) if game_data else {"matched": 0, "unmatched": ["沒有原版 build"]})
    write_json(out / "textures.json", textures)
    sprites = step("sprites", lambda: export_sprites(cats["sprites"], out, textures))
    sprite_rebase = step("spriteRebase", lambda: rebase_sprites(game_data, sprites) if game_data else {"matched": 0, "rebased": 0, "unmatched": ["沒有原版 build"], "ambiguous": []})
    write_json(out / "sprites.json", sprites)
    write_json(out / "fonts.json", step("fonts", lambda: export_fonts(cats["fonts"], out)))
    shaders, shader_names = step("shaders", lambda: export_shaders(cats["shaders"], shader_src))
    write_json(out / "shaders.json", shaders)
    materials = step("materials", lambda: export_materials(cats["materials"], shader_names))
    builtin_shaders = step("builtinShaders", lambda: name_builtin_shaders(game_data, materials) if game_data else {"table": {}, "failed": ["沒有原版 build"]})
    write_json(out / "materials.json", materials)
    write_json(out / "animations.json", step("animations", lambda: export_single(cats["animations"], "AnimationClip")))
    write_json(out / "animators.json", step("animators", lambda: export_animators(cats["animators"])))
    write_meshes(out, step("meshes", lambda: export_meshes(cats["meshes"])))
    write_json(
        out / "physicMaterials.json",
        step("physicMaterials", lambda: export_single(cats["physicMaterials"], "PhysicMaterial")),
    )
    write_json(
        out / "monobehaviours.json",
        step("monobehaviours", lambda: export_monobehaviours(cats["monobehaviours"], out, guids, assets, game_data)),
    )
    write_json(out / "texts.json", step("texts", lambda: export_texts(cats["texts"], out)))
    write_json(out / "audioclips.json", step("audioclips", lambda: export_audioclips(cats["audioclips"], out)))
    write_json(out / "audiomixers.json", step("audiomixers", lambda: export_audiomixers(cats["audiomixers"])))
    banks = step("banks", lambda: export_banks(assets, out))
    builtin = step("builtin", lambda: export_builtin(game_data, out) if game_data else {"table": {}, "report": {"source": 0, "exported": 0, "failed": []}})
    write_json(out / "builtin.json", builtin["table"])
    write_json(out / "project.json", step("project", lambda: export_project(assets.parent)))
    addressables = step("addressables", lambda: export_addressables(game_data, guids, assets) if game_data else {"table": {"guids": {}, "addresses": {}}, "report": {"source": 0, "exported": 0, "failed": ["沒有原版 build"]}})
    write_json(out / "addressables.json", addressables["table"])

    report = {
        "categories": {name: c.report() for name, c in cats.items()} | {"banks": banks, "builtin": builtin["report"], "addressables": addressables["report"]},
        "builtinShaders": builtin_shaders,
        "notImported": {k: {"count": n, "reason": NOT_IMPORTED.get(k, "")} for k, n in sorted(skipped.items())},
        "spriteRebase": sprite_rebase,
        "textureArrays": texture_arrays,
        "notes": asset_notes(sprites, textures, out),
        "seconds": timings | {"total": round(time.time() - t0, 1)},
    }
    write_json(out / "report.json", report)
    return report


def asset_notes(sprites: dict, textures: dict, out: Path) -> dict:
    """給第 0d 階段的事實：動態 TMP 字型、Texture2DArray、sprite 網格。"""
    tmp_fonts = {}
    mono = json.loads((out / "monobehaviours.json").read_text(encoding="utf-8"))
    for guid, m in mono.items():
        if m["kind"] != "TMP_FontAsset":
            continue
        obj = json.loads((out / m["file"]).read_text(encoding="utf-8"))
        tmp_fonts[m["name"] + f"（{guid[:8]}）"] = {
            "atlasPopulationMode": obj.get("m_AtlasPopulationMode"),
            "characters": len(obj.get("m_CharacterTable") or []),
            "sourceFontFile": (obj.get("m_SourceFontFile") or {}).get("guid"),
        }
    arrays = {g: t["name"] for g, t in textures.items() if t["importer"].get("textureShape") == 4}
    quads = sum(1 for s in sprites.values() if s.get("vertexCount") == 4)
    mats = json.loads((out / "materials.json").read_text(encoding="utf-8"))
    return {
        "tmpFonts": dict(sorted(tmp_fonts.items())),
        "tmpDynamicFonts": sum(1 for f in tmp_fonts.values() if f["atlasPopulationMode"] == 1),
        "texture2DArrays": arrays,
        "spriteMeshes": {"quad": quads, "tight": len(sprites) - quads},
        "builtinShaderMaterials": {m["m_Name"]: m["builtinShader"] for m in mats.values() if "builtinShader" in m},
        "materialsWithoutShader": sorted(m["m_Name"] for m in mats.values() if not m["shaderName"] and "builtinShader" not in m),
    }

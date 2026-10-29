"""動態字型的字形資料：給執行時產生 TMP 的 SDF glyph 用。來源是 diceomancer-web 的 scripts/import/glyphs.py（第 0d 階段）。

原版的動態字型（TMP_FontAsset 的 m_AtlasPopulationMode 1，中文、日文都是）在執行時才由 FontEngine（FreeType）
把需要的字畫進 atlas。網頁版照做：匯入時用 FreeType 抽出字形的輪廓與度量值，執行時要哪個字才算它的距離場
（src/runtime/font/），跟 TMP 一樣按需要加進 atlas。

驗證（10/5，scratchpad 的 sdf_probe2.py，之後由 vitest 的 sdf 測試接手）：
- 度量值：FreeType 不 hinting 的 26.6 值跟 build 裡已烘好的 glyph 表完全一致（江城圆体 600W 109 個、ConcertOne 7、
  SometypeMono 97、Biko 三套 448 個）。SDFAA_HINTED（4169）的 LiberationSans 有 61 個對不上（FreeType 版本的 hinting 差異），
  沒有元件用它。
- 距離場：像素中心到輪廓的真實有號距離，值 = 127.5 + d × 255 / (2 × (padding + 1))，跟烘好的 atlas 平均差 0.8–1.7 階。

字集：場景與 prefab 的 m_text、ASCII 可列印字元、TMP 自己會用的幾個字元，加上設定檔 import.charsetSources 列的來源
（JSON 檔或資料夾：裡面所有字串值都算，例如遊戲的語言表）與 import.extraChars（移植版自己加的介面文字）。
不在字集裡的字執行時拿不到（原版會畫），報告會列出各字型的字數。

輸出 assets/glyphs/<字型檔內容的 sha1 前 16 碼>_<point size>_<u|h>.json（同一個字型檔 AssetRipper 有時匯出成兩個 guid，用內容去重）：
  {pointSize, hinted, unitsPerEm, cmap: {unicode: glyph index}, glyphs: {glyph index: [w, h, bx, by, adv, 輪廓]}}
  度量值是 FreeType 的 26.6 整數（÷64 就是 TMP 存的 float）；輪廓 = [[x, y, tag]…] 每個 contour 一組，
  座標是 26.6 整數，tag 1 = 線上點、0 = 二次控制點、2 = 三次控制點（FreeType 的 FT_CURVE_TAG）。
assets/glyphs.json：字型資產 guid → 檔名，加上統計。
"""

from __future__ import annotations

import hashlib
import json
import shutil
from pathlib import Path

# TMP 會自己插入或查的字元：省略號、缺字方塊、底線（底線網格用）、不換行空格、零寬空格、連字號、ETX
EXTRA_CHARS = "…□_ ​-\u0003"
RENDER_HINTED = 4169  # GlyphRenderMode.SDFAA_HINTED；4165 SDFAA 不 hinting
def _strings(v):
    if isinstance(v, str):
        yield v
    elif isinstance(v, dict):
        for x in v.values():
            yield from _strings(x)
    elif isinstance(v, list):
        for x in v:
            yield from _strings(x)


def game_charset(out_root: Path, sources: list[Path] = (), extra: str = "") -> set[str]:
    chars: set[str] = set(chr(c) for c in range(32, 127)) | set(EXTRA_CHARS) | set(extra)
    for src in sources:
        files = sorted(src.rglob("*.json")) if src.is_dir() else [src]
        for f in files:
            for v in _strings(json.loads(f.read_text(encoding="utf-8"))):
                chars |= set(v)
    scenes = out_root / "scenes"
    files = sorted(scenes.glob("*.json")) + sorted((scenes / "prefabs").glob("*.json"))
    files = [f for f in files if f.name not in ("index.json", "report.json")]
    for f in files:
        # 場景資料夾裡也有別的 JSON（轉換器 --hierarchy 的 hierarchy.json）：沒有 components 的跳過
        for c in (json.loads(f.read_text(encoding="utf-8")).get("components") or {}).values():
            if isinstance(c.get("m_text"), str):
                chars |= set(c["m_text"])
    return chars


def outline(face) -> list[list[list[int]]]:
    ol = face.glyph.outline
    # freetype-py 每次存取 points／tags 都重建整個清單，先取一次
    points, tags = ol.points, ol.tags
    contours, start = [], 0
    for end in ol.contours:
        contours.append([[points[i][0], points[i][1], tags[i] & 3] for i in range(start, end + 1)])
        start = end + 1
    return contours


def export_glyphs(out_root: Path, sources: list[Path] = (), extra: str = "") -> dict:
    import time

    import freetype

    t0 = time.time()
    assets = out_root / "assets"
    mb = json.loads((assets / "monobehaviours.json").read_text(encoding="utf-8"))
    fonts = json.loads((assets / "fonts.json").read_text(encoding="utf-8"))
    chars = sorted(game_charset(out_root, sources, extra))
    out_dir = assets / "glyphs"
    shutil.rmtree(out_dir, ignore_errors=True)  # 可重生，整個重寫
    out_dir.mkdir(parents=True)
    index: dict[str, str] = {}
    stores: dict[str, dict] = {}
    report = {"charset": len(chars), "fonts": {}, "noSource": [], "failed": []}
    for guid, info in sorted(mb.items()):
        if info["kind"] != "TMP_FontAsset":
            continue
        asset = json.loads((assets / info["file"]).read_text(encoding="utf-8"))
        if asset.get("m_AtlasPopulationMode") != 1:
            continue
        src = (asset.get("m_SourceFontFile") or {}).get("guid")
        if src not in fonts:
            report["noSource"].append(info["name"])
            continue
        size = asset["m_FaceInfo"]["m_PointSize"]
        hinted = asset["m_AtlasRenderMode"] == RENDER_HINTED
        ttf = assets / fonts[src]["file"]
        digest = hashlib.sha1(ttf.read_bytes()).hexdigest()[:16]
        name = f"{digest}_{size}_{'h' if hinted else 'u'}.json"
        index[guid] = name
        if name in stores:
            continue
        face = freetype.Face(str(ttf))
        face.set_char_size(int(size * 64))  # 72 dpi：point size = 像素
        flags = freetype.FT_LOAD_NO_BITMAP | (0 if hinted else freetype.FT_LOAD_NO_HINTING)
        cmap: dict[str, int] = {}
        glyphs: dict[str, list] = {}
        for ch in chars:
            gid = face.get_char_index(ch)
            if not gid:
                continue
            cmap[str(ord(ch))] = gid
            if str(gid) in glyphs:
                continue
            try:
                face.load_glyph(gid, flags)
            except freetype.FT_Exception as e:
                report["failed"].append({"font": fonts[src]["name"], "char": ch, "error": str(e)})
                continue
            m = face.glyph.metrics
            glyphs[str(gid)] = [m.width, m.height, m.horiBearingX, m.horiBearingY, m.horiAdvance, outline(face)]
        stores[name] = {
            "font": fonts[src]["name"],
            "pointSize": size,
            "hinted": hinted,
            "unitsPerEm": face.units_per_EM,
            "cmap": cmap,
            "glyphs": glyphs,
        }
        report["fonts"][name] = {"font": fonts[src]["name"], "chars": len(cmap), "glyphs": len(glyphs)}
    for name, store in stores.items():
        (out_dir / name).write_text(json.dumps(store, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    report["seconds"] = round(time.time() - t0, 1)
    (assets / "glyphs.json").write_text(
        json.dumps({"fontAssets": index, "report": report}, ensure_ascii=False, separators=(",", ":")), encoding="utf-8"
    )
    return report

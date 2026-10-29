# /// script
# requires-python = ">=3.11"
# dependencies = ["UnityPy>=1.24", "PyYAML>=6", "Pillow>=11", "freetype-py>=2.5", "TypeTreeGeneratorAPI>=0.0.10"]
# ///
"""匯入器的進入點：AssetRipper 匯出 + 原版 build → 執行環境（runtime/）讀的 JSON 與素材。

用法（在遊戲專案裡，或用 --config 指定設定檔）：
  uv run <工具包>/importer/run.py [--config cs2ts.json] [all|assets|addressables|scenes|supplement|glyphs|streaming|packs|shaders]
  scenes 要先有 assets 的輸出（外部參照的統計、內建資源的驗證會讀它）；glyphs 要先有 assets 與 scenes。
  supplement 從原版 build 補 AssetRipper 漏掉的 [SerializeReference] 欄位與空殼 ScriptableObject（supplement.py 檔頭），
  要先有 assets 與 scenes；assets 或 scenes 重跑過就要重跑（會改寫它們的輸出）。
  addressables 只重做 assets/addressables.json（assets 步驟本來就會做）。
  packs 把開機與各場景依賴閉包的小檔併成大檔（packs.py 檔頭），要先有 assets 與 scenes；assets 或 scenes 重跑過就要重跑。
  shaders：shaders/convert.py 把 DX11 bytecode 轉成 GLSL（要 Windows build 的匯出，工具見 convert.py 檔頭），
  轉換結果放 <root>/reference/shaders（import.shaderWork 可改），再發布到 <out>/shaders。all 不含這步（慢、要外部工具）。

設定檔的 import 段（路徑相對設定檔的 root）：
  export          AssetRipper 匯出的 ExportedProject（建議 --shader-yaml，shader 屬性表才在同一份）
  game            原版遊戲：Windows 的資料夾（裡面有 <名稱>_Data）、macOS 的 .app，或直接給 Data 資料夾
  out             輸出資料夾（原版素材，不要進版控）
  shaderExport    選填：主匯出是 .shader 空殼時，另一份 --shader-yaml 匯出的 ExportedProject
  int32ArrayKeys  選填：遊戲自己的列舉陣列欄位（Unity 寫成十六進位字串），見 unity.py
  charsetSources  選填：動態字型字集的額外來源（JSON 檔或資料夾，所有字串值都算；例如語言表），見 glyphs.py
  extraChars      選填：移植版自己加的介面文字（原版沒有的字）

輸出：<out>/assets/（assets.py 檔頭）、<out>/scenes/（scenes.py 檔頭）、<out>/streaming/（streaming.py 檔頭）、<out>/packs/（packs.py 檔頭）。
"""

from __future__ import annotations

import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from assets import export_addressables, export_assets, write_json, write_meshes  # noqa: E402
from glyphs import export_glyphs  # noqa: E402
from packs import export_packs  # noqa: E402
from shaders import publish_shaders  # noqa: E402
from scenes import export_scenes  # noqa: E402
from supplement import export_supplement  # noqa: E402
from streaming import export_streaming  # noqa: E402
from unity import build_guid_index, set_int32_array_keys  # noqa: E402


def find_config(start: Path) -> Path | None:
    for d in [start, *start.parents]:
        if (d / "cs2ts.json").exists():
            return d / "cs2ts.json"
    return None


def load_config(path: Path) -> dict:
    # 設定檔可以有 // 註解（轉換器的 JSON 讀法允許），這裡照樣去掉
    lines = [ln for ln in path.read_text(encoding="utf-8").splitlines() if not ln.lstrip().startswith("//")]
    cfg = json.loads("\n".join(lines))
    root = Path(cfg.get("root") or ".")
    cfg["_root"] = (path.parent / root).resolve()
    return cfg


def game_data_dir(game: Path) -> Path:
    """原版 build 的 Data 資料夾：macOS 是 <名稱>.app/Contents/Resources/Data，Windows／Linux 是 <名稱>_Data。"""
    if (game / "globalgamemanagers").exists():
        return game
    if game.suffix == ".app":
        return game / "Contents" / "Resources" / "Data"
    hits = sorted(p for p in game.glob("*_Data") if (p / "globalgamemanagers").exists())
    if len(hits) != 1:
        raise SystemExit(f"在 {game} 找不到唯一的 <名稱>_Data（找到 {len(hits)} 個）")
    return hits[0]


def main() -> None:
    sys.stdout.reconfigure(line_buffering=True)  # 導到檔案時也逐行輸出（長時間的匯入看得到進度）
    args = sys.argv[1:]
    cfg_path = None
    if "--config" in args:
        i = args.index("--config")
        cfg_path = Path(args[i + 1]).resolve()
        del args[i : i + 2]
    cfg_path = cfg_path or find_config(Path.cwd())
    if cfg_path is None:
        raise SystemExit("找不到 cs2ts.json（從目前目錄往上找），或用 --config 指定")
    cfg = load_config(cfg_path)
    imp = cfg.get("import") or {}
    root: Path = cfg["_root"]

    def path(key: str) -> Path | None:
        v = imp.get(key)
        return (root / v).resolve() if v else None

    export, game, out = path("export"), path("game"), path("out")
    if not (export and game and out):
        raise SystemExit(f"{cfg_path}：import 段要有 export、game、out")
    assets = export / "Assets"
    game_data = game_data_dir(game)
    set_int32_array_keys(imp.get("int32ArrayKeys") or [])
    step = args[0] if args else "all"

    t0 = time.time()
    print(f"匯出：{export}\nbuild：{game_data}\n輸出：{out}")
    # packs 只讀前面步驟的輸出，不必建 GUID 索引
    guids = build_guid_index(assets) if step != "packs" else {}
    if step != "packs":
        print(f"GUID 索引：{len(guids)} 個（{time.time() - t0:.1f} 秒）")
    if step in ("all", "assets"):
        rep = export_assets(assets, path("shaderExport"), out / "assets", guids, game_data)
        for name, c in rep["categories"].items():
            print(f"  {name}: {c.get('exported')}/{c.get('source')}，失敗 {len(c.get('failed') or [])}")
        print(f"  sprite 範圍改回 build 的值：{rep['spriteRebase'].get('rebased')}（對到 {rep['spriteRebase'].get('matched')}）")
        print(f"素材完成（{rep['seconds']['total']} 秒），報告 {out / 'assets/report.json'}")
    if step == "addressables":
        # 只重做 Addressables 的對照表（assets 步驟也會做；這裡不清 assets 資料夾）
        rep = export_addressables(game_data, guids, assets)
        write_json(out / "assets" / "addressables.json", rep["table"])
        r = rep["report"]
        print(f"Addressables：GUID {r['exported']}/{r['source']}、位址 {r.get('addresses', 0)}，對不到 {len(r['failed'])}")
    if step in ("all", "scenes"):
        rep = export_scenes(assets, game_data, out, guids)
        f = rep["files"]
        print(f"  場景 {f['scenes']}、prefab {f['prefabs']}，失敗 {len(f['failed'])}")
        print(f"  腳本：{rep['scripts']['resolved']}/{rep['scripts']['distinctRefs']} 種解開，未解 {sum(len(v) for v in rep['scripts']['unresolved'].values())} 個引用")
        print(f"  樹的問題：{sum(len(v) for v in rep['treeProblems'].values())}；內建資源參照：檢查 {rep['builtinRefs']['checked']}、不符 {len(rep['builtinRefs']['mismatched'])}")
        print(f"場景完成（{rep['seconds']} 秒），報告 {out / 'scenes/report.json'}")
    if step in ("all", "supplement"):
        rep = export_supplement(game_data, out)
        print(f"  ScriptableObject {sum(rep['objects'].values())} 個（{len(rep['objectFailures'])} 個失敗）；元件：場景 {rep['sceneComponents']}、prefab {rep['prefabComponents']}（{len(rep['componentFailures'])} 個失敗）")
        print(f"  參照 {rep['refs']}；prefab 對不到 {len(rep['unmatchedPrefabs'])}、歧義 {len(rep['ambiguousPrefabs'])}")
        print(f"  Resources 容器：{rep['resources']}（{out / 'assets/resources.json'}）")
        print(f"補充完成（{rep['seconds']} 秒），報告 {out / 'supplement.json'}")
    if step in ("all", "glyphs"):
        sources = [(root / s).resolve() for s in imp.get("charsetSources") or []]
        rep = export_glyphs(out, sources, imp.get("extraChars") or "")
        print(f"  字集 {rep['charset']} 字；動態字型 {len(rep['fonts'])} 份，沒有原檔 {len(rep['noSource'])}、失敗 {len(rep['failed'])}")
        print(f"字形完成（{rep['seconds']} 秒），報告 {out / 'assets/glyphs.json'}")
    if step in ("all", "streaming"):
        rep = export_streaming(game_data, out)
        print(f"StreamingAssets：{rep['files']} 個檔（{rep.get('bytes', 0) // 1048576} MB，{rep['seconds']} 秒）→ {out / 'streaming'}")
    if step in ("all", "packs"):
        # 舊的輸出只有整包 meshes.json（assets 步驟 10/18 以前）：先拆成一個網格一個檔，不必整個 assets 重跑
        old_meshes = out / "assets" / "meshes.json"
        if old_meshes.exists():
            write_meshes(out / "assets", json.loads(old_meshes.read_text(encoding="utf-8")))
            print(f"  meshes.json 拆成 {out / 'assets/meshes'}/<guid>.json")
        rep = export_packs(out)
        print(f"  {rep['groups']} 組、{rep['chunks']} 包、{rep['files']} 個檔（{rep['kinds']}，{rep['megabytes']} MB）；開機 {rep['bootFiles']} 個檔、{rep['bootChunks']} 包")
        print(f"打包完成（{rep['seconds']} 秒）→ {out / 'packs'}")
    if step == "shaders":
        import subprocess

        work = path("shaderWork") or (root / "reference/shaders")
        src = path("shaderExport") or export
        convert = Path(__file__).resolve().parent.parent / "shaders" / "convert.py"
        # AssetRipper 沒匯出的內建 shader（assets 步驟查出名稱、寫在材質的 builtinShader.name）從 build 抽。
        # UI/Default、Sprites/Default、Sprites/Mask 由執行環境手寫（render/builtinShaders.ts），不轉
        handwritten = {"UI/Default", "Sprites/Default", "Sprites/Mask"}
        mats_path = out / "assets" / "materials.json"
        mats = json.loads(mats_path.read_text(encoding="utf-8")) if mats_path.exists() else {}
        builtin_names = sorted({(m.get("builtinShader") or {}).get("name") for m in mats.values()} - {None} - handwritten)
        cmd = ["uv", "run", str(convert), "--src", str(src), "--out", str(work)]
        if builtin_names:
            cmd += ["--build", str(game_data), "--build-shaders", json.dumps(builtin_names)]
        subprocess.run(cmd, check=True)
        rep = publish_shaders(work, out / "shaders")
        print(f"shader 發布：{rep['exported']}/{rep['source']}，GLSL {rep['glsl']} 個，失敗 {len(rep['failed'])}")


if __name__ == "__main__":
    main()

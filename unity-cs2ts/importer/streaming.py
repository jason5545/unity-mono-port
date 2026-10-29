"""StreamingAssets：原版 build 的 <名稱>_Data/StreamingAssets 搬到 <out>/streaming（clonefile，不多佔空間），寫 index.json。

執行環境的 System.IO（runtime/src/csport/dotnetIO.ts）把 Application.streamingAssetsPath 對到這裡：
文字檔（json、vdf、txt、xml）開機時預載，File.ReadAllText 是同步的；影片等大檔只記路徑，VideoPlayer 用網址播。
不搬的：Addressables 的資產包（aa/<平台>/*.bundle，內容 AssetRipper 已經匯出）只留 aa 底下的 catalog.json 與 settings.json；
SteamDeck 資料夾是 Steam Deck 專用的替代檔（原版只在 Steam Deck 上用，網頁版照桌機的路徑）。
"""

from __future__ import annotations

import json
import time
from pathlib import Path

from assets import clone, write_json

TEXT_EXTS = {".json", ".vdf", ".txt", ".xml", ".csv", ".ini", ".cfg", ".yaml", ".yml"}
SKIP_DIRS = {"SteamDeck"}


def export_streaming(game_data: Path, out: Path) -> dict:
    t0 = time.time()
    src = game_data / "StreamingAssets"
    dst = out / "streaming"
    files: dict[str, dict] = {}
    if not src.exists():
        write_json(dst / "index.json", {"files": files})
        return {"files": 0, "seconds": 0}
    for p in sorted(src.rglob("*")):
        if not p.is_file():
            continue
        rel = p.relative_to(src)
        parts = rel.parts
        if parts[0] in SKIP_DIRS:
            continue
        if parts[0] == "aa" and not (len(parts) == 2 and p.suffix == ".json"):
            continue
        target = dst / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        if target.exists():
            target.unlink()
        clone(p, target)
        files[rel.as_posix()] = {"size": p.stat().st_size, "text": p.suffix.lower() in TEXT_EXTS}
    write_json(dst / "index.json", {"files": files})
    return {"files": len(files), "bytes": sum(f["size"] for f in files.values()), "seconds": round(time.time() - t0, 1)}

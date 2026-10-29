"""打包：把開機與各場景依賴閉包裡的小 JSON 檔併成少數幾個大檔，執行環境一次抓一包（runtime/src/unity/packs.ts）。

為什麼：Unity 載場景時把序列化欄位參照到的資產（ScriptableObject、prefab、Mesh，再往下參照的）全部同步載好，
執行環境照同一個規則（runtime/src/unity/objectStore.ts 的 preload）。MT2 開機的閉包經 AllGameData 參照到整個遊戲資料庫，
是 4500 多個小檔；瀏覽器還好，Android APK 每個檔都要經過 WebView 的攔截、從 APK 讀、解壓，請求數本身就是成本。
打包不改載入的內容與順序：載哪些資產照舊由閉包決定，只是同一包的檔案一次到。

要先有 assets 與 scenes 的輸出（monobehaviours.json、meshes/index.json、texts.json、scenes/index.json）。

閉包的算法跟執行環境的 ObjectStore 一樣：
  - 參照是任何帶字串 guid 與 fileID 的物件（collectRefs）
  - guid 在 monobehaviours.json、fileID 11400000 → ScriptableObject（assets/objects/<guid>.json）
  - guid 在 scenes/index.json 的 prefabs → prefab 檔；guid 在 meshes/index.json → assets/meshes/<guid>.json
  - 其他（貼圖、材質、二進位 TextAsset…）不往下走、不打包
分組照載入的先後：
  boot     Resources 資料夾的全部資產（Resources.Load 是同步的，開機一次預載）＋ build 第 0 個場景的檔與閉包
           ＋ 全部 TMP 物件（runtime/src/font/textAssets.ts 開機就全部讀）。執行環境一裝好索引就開始抓
  <場景>   build 順序裡其他場景：場景檔本身加上閉包裡前面的組還沒有的，載那個場景時才抓
每組照廣度優先的順序切成不超過 PACK_BYTES 的檔。

輸出：
  packs/index.json        {"chunks": [{"file": "boot-0.json", "group": "boot", "boot": true, "files": ["assets/objects/<guid>.json", ...]}]}
                          files 是相對輸出根目錄的路徑（跟執行環境抓檔的網址去掉 base 一樣）
  packs/<組>-<n>.json     {"<相對路徑>": <原檔內容>, ...}，原檔的文字原樣接起來（不重新序列化）
原本的單檔照樣留著：沒打包的路徑（或沒有 packs/index.json 的舊輸出）執行環境照舊一個一個抓。
"""

from __future__ import annotations

import json
import re
import shutil
import time
from collections import Counter
from pathlib import Path

PACK_BYTES = 8 * 1024 * 1024
TMP_KINDS = {"TMP_FontAsset", "TMP_SpriteAsset", "TMP_Settings", "TMP_StyleSheet", "TMP_ColorGradient"}
SO_FILE_ID = "11400000"


def _read(path: Path):
    return json.loads(path.read_text(encoding="utf-8-sig"))


def collect_refs(root) -> list[tuple[str, str]]:
    """物件裡的全部 {guid, fileID} 參照（照出現順序去重），同 objectStore.ts 的 collectRefs"""
    out: list[tuple[str, str]] = []
    seen: set[tuple[str, str]] = set()
    stack = [root]
    # 用堆疊模擬遞迴，順序跟 JS 的深度優先一樣（子項目反著推進去）
    while stack:
        v = stack.pop()
        if isinstance(v, list):
            stack.extend(reversed(v))
        elif isinstance(v, dict):
            g = v.get("guid")
            if isinstance(g, str) and "fileID" in v:
                k = (g, str(v["fileID"]))
                if k not in seen:
                    seen.add(k)
                    out.append(k)
                continue
            stack.extend(reversed(list(v.values())))
    return out


def resource_path(src: str) -> str | None:
    """Resources.Load 的路徑（Resources/ 之後、去掉全部副檔名），同 objectStore.ts 的 addResource"""
    m = re.search(r"(?:^|/)Resources/(.+?)(?:\.[^./]+)+$", src)
    return m.group(1) if m else None


def export_packs(out: Path) -> dict:
    t0 = time.time()
    idx = _read(out / "scenes" / "index.json")
    mono = _read(out / "assets" / "monobehaviours.json")
    texts_path = out / "assets" / "texts.json"
    texts = _read(texts_path) if texts_path.exists() else {}
    mesh_index_path = out / "assets" / "meshes" / "index.json"
    meshes = set(_read(mesh_index_path)) if mesh_index_path.exists() else set()
    prefabs = idx["prefabs"]
    scenes = {e["name"]: e for e in idx["scenes"].values()}
    build_order = idx.get("buildOrder") or [e["name"] for e in sorted(scenes.values(), key=lambda e: e["buildIndex"]) if e["buildIndex"] >= 0]

    def path_of(guid: str, fileID: str) -> str | None:
        if guid in mono and fileID == SO_FILE_ID:
            return f"assets/{mono[guid]['file']}"
        if guid in prefabs:
            return prefabs[guid]["file"]
        # 二進位 TextAsset 是執行環境的 bin:，不往下走也不打包（ArrayBuffer，不是 JSON）
        if (texts.get(guid) or {}).get("file"):
            return None
        if guid in meshes:
            return f"assets/meshes/{guid}.json"
        return None

    refs_cache: dict[str, list[tuple[str, str]]] = {}

    def refs_of(rel: str) -> list[tuple[str, str]]:
        if rel not in refs_cache:
            refs_cache[rel] = [] if rel.startswith("assets/meshes/") else collect_refs(_read(out / rel))
        return refs_cache[rel]

    def closure(roots: list[tuple[str, str]]) -> list[str]:
        seen: set[str] = set()
        order: list[str] = []
        frontier = roots
        while frontier:
            nxt: list[tuple[str, str]] = []
            for g, f in frontier:
                rel = path_of(g, f)
                if not rel or rel in seen or not (out / rel).exists():
                    continue
                seen.add(rel)
                order.append(rel)
                nxt += refs_of(rel)
            frontier = nxt
        return order

    resources: dict[str, str] = {}
    for table in (mono, prefabs, texts):
        for guid, e in table.items():
            p = resource_path(e.get("src") or "")
            if p and p not in resources:
                resources[p] = guid
    res_roots = [(g, SO_FILE_ID if g in mono else "0") for g in resources.values()]

    groups: list[tuple[str, list[str]]] = []
    done: set[str] = set()

    def add_group(name: str, files: list[str]) -> None:
        fresh = []
        for f in files:
            if f not in done:
                done.add(f)
                fresh.append(f)
        if fresh:
            groups.append((name, fresh))

    first = scenes[build_order[0]] if build_order else None
    boot: list[str] = []
    if first:
        boot.append(first["file"])
    boot += closure(res_roots + (collect_refs(_read(out / first["file"])) if first else []))
    boot += [f"assets/{m['file']}" for m in mono.values() if m.get("kind") in TMP_KINDS]
    add_group("boot", boot)
    for name in build_order[1:]:
        e = scenes[name]
        add_group(name, [e["file"], *closure(collect_refs(_read(out / e["file"])))])

    pack_dir = out / "packs"
    if pack_dir.exists():
        shutil.rmtree(pack_dir)
    pack_dir.mkdir(parents=True)
    chunks = []
    total_bytes = 0
    for name, files in groups:
        safe = re.sub(r"[^A-Za-z0-9_.-]", "_", name)
        parts: list[list[tuple[str, str]]] = [[]]
        size = 0
        for rel in files:
            text = (out / rel).read_text(encoding="utf-8-sig").strip()
            if parts[-1] and size + len(text) > PACK_BYTES:
                parts.append([])
                size = 0
            parts[-1].append((rel, text))
            size += len(text)
        for i, part in enumerate(parts):
            file = f"{safe}-{i}.json"
            body = "{" + ",".join(f"{json.dumps(rel, ensure_ascii=False)}:{text}" for rel, text in part) + "}"
            (pack_dir / file).write_text(body, encoding="utf-8")
            total_bytes += len(body.encode("utf-8"))
            chunks.append({"file": file, "group": name, **({"boot": True} if name == "boot" else {}), "files": [rel for rel, _ in part]})
    (pack_dir / "index.json").write_text(json.dumps({"chunks": chunks}, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")

    kinds = Counter()
    for _, files in groups:
        for f in files:
            kinds["mesh" if f.startswith("assets/meshes/") else "prefab" if f.startswith("scenes/prefabs/") else "scene" if f.startswith("scenes/") else "so"] += 1
    boot_files = groups[0][1] if groups and groups[0][0] == "boot" else []
    return {
        "groups": len(groups),
        "chunks": len(chunks),
        "files": sum(len(f) for _, f in groups),
        "bootFiles": len(boot_files),
        "bootChunks": sum(1 for c in chunks if c.get("boot")),
        "kinds": dict(kinds),
        "megabytes": round(total_bytes / 1e6, 1),
        "seconds": round(time.time() - t0, 1),
    }

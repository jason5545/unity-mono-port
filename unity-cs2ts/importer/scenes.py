"""場景樹匯入：全部場景與 prefab 匯成場景樹 JSON。來源是 diceomancer-web 的 scripts/import/scenes.py（第 0c 階段）。

build 裡的場景已經攤平（沒有 PrefabInstance、沒有 stripped 物件，10/5 查過），所以每個檔案自成一棵樹。
YAML 原樣轉成 JSON，不改寫任何參照；只另外標註每個 MonoBehaviour 是哪個 C# 類別。

輸出（public/game/scenes/）：
  index.json             場景與 prefab 的清單：guid、名稱、來源、各類物件數
  <場景名>.json           每個 .unity 一檔；index.json 的 buildIndex 是 EditorBuildSettings 的順序（build 裡的 level<N>）
  prefabs/<guid>.json    每個 prefab 一檔（場景與素材用 GUID 參照 prefab）
  report.json            數量對照、腳本解析結果、樹的檢查、外部參照的去向

每個檔案的格式：
  roots          根 GameObject 的 fileID，依 m_RootOrder 排序
  gameObjects    fileID → {m_Name, m_IsActive, m_Layer, m_TagString, transform, parent, children, components}
                 parent／children 是 GameObject 的 fileID，children 照 Transform.m_Children 的順序
  components     fileID → {type, classID, ...欄位原樣}；MonoBehaviour 另有 script
  settings       場景層級的物件（RenderSettings、LightmapSettings…）
fileID 一律是字串（常超過 2^53）。PPtr 格式同 assets.py：{guid, fileID}、{fileID}、null。

腳本怎麼對到 C# 類別（不看 AssetRipper 取的檔名）：
  - m_Script 指到匯出裡的 .cs（Assembly-CSharp）：讀檔案裡的 namespace，類別名是檔名，
    再到 build 的 MonoScript 表確認這個型別真的存在
  - 指到 DLL 或匯出裡沒有的 GUID（UGUI、TMP、URP 等套件）：fileID 是 MD4(namespace + 類別名) 的雜湊，
    拿 build 的 MonoScript 表（globalgamemanagers.assets）逐一算雜湊反查
  - 原版 build 裡就是空的 MonoScript（類別名、namespace、組件名都空）照實標成 missing
"""

from __future__ import annotations

import json
import re
import shutil
import time
from collections import Counter
from pathlib import Path

from assets import NOT_IMPORTED, first_doc_type
from unity import (
    decode_int32_arrays,
    load_unity_docs,
    norm_refs,
    script_file_id,
    strip_meta_fields,
    suspect_hex_keys,
)

BUILTIN_GUIDS = {
    "0000000000000000e000000000000000": "unity default resources",
    "0000000000000000f000000000000000": "unity_builtin_extra",
}
COMPONENT_DROP = ("m_EditorHideFlags", "m_EditorClassIdentifier", "m_GameObject")
# 掛在 GameObject 底下的物件之外，場景本身的設定物件
SCENE_SETTINGS = {"OcclusionCullingSettings", "RenderSettings", "LightmapSettings", "NavMeshSettings"}


def write_json(path: Path, obj) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(obj, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")


# ───────── 腳本 → C# 類別 ─────────


class ScriptResolver:
    NS_RE = re.compile(r"^namespace\s+([\w.]+)", re.M)
    EMPTY_ID = script_file_id("", "")

    def __init__(self, assets: Path, game_data: Path, guids: dict[str, Path]):
        self.assets = assets
        self.guids = guids
        self.cache: dict[tuple[str, str], dict | None] = {}
        self.monoscripts: set[tuple[str, str, str]] = set()
        self.by_hash: dict[int, list[tuple[str, str, str]]] = {}
        ggm = game_data / "globalgamemanagers.assets"
        if ggm.exists():
            import UnityPy

            for obj in UnityPy.load(str(ggm)).objects:
                if obj.type.name != "MonoScript":
                    continue
                t = obj.read_typetree()
                ms = (t.get("m_AssemblyName") or "", t.get("m_Namespace") or "", t.get("m_ClassName") or "")
                self.monoscripts.add(ms)
        for ms in sorted(self.monoscripts):
            self.by_hash.setdefault(script_file_id(ms[1], ms[2]), []).append(ms)

    @staticmethod
    def _asm(name: str) -> str:
        return name[:-4] if name.endswith(".dll") else name

    def resolve(self, ref: dict | None) -> dict | None:
        """回傳 {assembly, namespace, class, source?}；原版就是空的回傳 {missing}；解不開回傳 None。"""
        if not ref or "guid" not in ref:
            return None
        key = (ref["guid"], str(ref["fileID"]))
        if key not in self.cache:
            self.cache[key] = self._resolve(ref["guid"], int(ref["fileID"]))
        return self.cache[key]

    def _resolve(self, guid: str, file_id: int) -> dict | None:
        target = self.guids.get(guid)
        if target is not None and target.suffix == ".cs":
            text = target.read_text(encoding="utf-8", errors="replace")
            m = self.NS_RE.search(text)
            ns = m.group(1) if m else ""
            hits = [ms for ms in self.monoscripts if ms[1] == ns and ms[2] == target.stem]
            if len(hits) != 1:
                return None
            asm = self._asm(hits[0][0])
            out = {"assembly": asm, "namespace": ns, "class": target.stem}
            asm_dir = self.assets / "Scripts" / asm
            if asm_dir in target.parents:
                # 相對於 Scripts/<組件>；Assembly-CSharp 就是 reference/csharp
                out["source"] = str(target.relative_to(asm_dir))
            return out
        if file_id == self.EMPTY_ID:
            return {"missing": "原版 build 的 MonoScript 類別名、namespace、組件名都是空的，原版也是 missing script"}
        cands = self.by_hash.get(file_id, [])
        if target is not None and target.suffix == ".dll":
            cands = [c for c in cands if self._asm(c[0]) == target.stem]
        if len(cands) != 1:
            return None
        asm, ns, cls = cands[0]
        return {"assembly": self._asm(asm), "namespace": ns, "class": cls}


# ───────── 場景的 LightingData ─────────

# 場景的 LightmapSettings.m_LightingDataAsset 指到的 LightingData 資產（AssetRipper 匯出成 Scenes/<場景>/LightingData.asset）：
# 內建管線的環境光 SH 是烘焙時存在這裡的 m_BakedAmbientProbeInLinear（27 個係數，sh[通道 × 9 + 係數]），不在 RenderSettings。
# 取出來放進 settings.LightingData.ambientProbe，執行環境的繪製端算 unity_SHA*（runtime/src/render/builtinLighting.ts）。
def lighting_data_of(settings: dict, guids: dict[str, Path]) -> None:
    ref = (settings.get("LightmapSettings") or {}).get("m_LightingDataAsset") or {}
    p = guids.get(ref.get("guid") or "")
    if not p or not p.exists():
        return
    text = p.read_text(encoding="utf-8", errors="replace")
    m = re.search(r"^  m_BakedAmbientProbeInLinear:\n((?:    sh\[\s*\d+\]: [^\n]*\n)+)", text, re.M)
    if not m:
        return
    coeffs = [float(x) for x in re.findall(r"sh\[\s*\d+\]: ([^\n]+)", m.group(1))]
    if len(coeffs) == 27:
        settings["LightingData"] = {"ambientProbe": coeffs, "src": ref.get("guid")}


# ───────── 單一檔案 ─────────


def build_tree(docs: list[dict], resolver: ScriptResolver) -> tuple[dict, dict]:
    """回傳（輸出的 JSON、這個檔案的檢查結果）。"""
    gos: dict[str, dict] = {}
    comps: dict[str, dict] = {}
    settings: dict[str, dict] = {}
    problems: list[str] = []
    unresolved: list[dict] = []
    missing: list[dict] = []

    for d in docs:
        if d["stripped"] or d["type"] == "PrefabInstance":
            problems.append(f"{d['type']} {d['fileID']}：prefab 實例或 stripped 物件，這個匯入沒處理")
            continue
        data = decode_int32_arrays(norm_refs(strip_meta_fields(d["data"])))
        if d["type"] == "GameObject":
            gos[d["fileID"]] = {
                "m_Name": data.get("m_Name"),
                "m_IsActive": data.get("m_IsActive"),
                "m_Layer": data.get("m_Layer"),
                "m_TagString": data.get("m_TagString"),
                "components": [c["component"]["fileID"] for c in data.get("m_Component") or [] if c.get("component")],
            }
        elif "m_GameObject" in data:
            rec = {"type": d["type"], "classID": d["classID"], "gameObject": (data.get("m_GameObject") or {}).get("fileID")}
            rec.update({k: v for k, v in data.items() if k not in COMPONENT_DROP})
            if d["type"] == "MonoBehaviour":
                script = resolver.resolve(data.get("m_Script"))
                if script is None:
                    unresolved.append({"fileID": d["fileID"], "m_Script": data.get("m_Script")})
                elif "missing" in script:
                    missing.append({"fileID": d["fileID"], "m_Script": data.get("m_Script")})
                rec["script"] = script
            comps[d["fileID"]] = rec
        elif d["type"] in SCENE_SETTINGS:
            settings[d["type"]] = data
        else:
            problems.append(f"{d['type']} {d['fileID']}：不是 GameObject、元件或場景設定")

    # 元件 ↔ GameObject 雙向對得上
    for gid, go in gos.items():
        for cid in go["components"]:
            c = comps.get(cid)
            if c is None:
                problems.append(f"GameObject {gid} 的元件 {cid} 不存在")
            elif c["gameObject"] != gid:
                problems.append(f"元件 {cid} 的 m_GameObject 是 {c['gameObject']}，不是 {gid}")
    for cid, c in comps.items():
        if c["gameObject"] not in gos:
            problems.append(f"元件 {cid}（{c['type']}）的 GameObject {c['gameObject']} 不存在")

    # Transform 樹
    tf_owner: dict[str, str] = {}
    for gid, go in gos.items():
        tfs = [cid for cid in go["components"] if comps.get(cid, {}).get("type") in ("Transform", "RectTransform")]
        if len(tfs) != 1:
            problems.append(f"GameObject {gid} 有 {len(tfs)} 個 Transform")
            continue
        go["transform"] = tfs[0]
        tf_owner[tfs[0]] = gid
    roots: list[tuple[int, str]] = []
    for gid, go in gos.items():
        tf = comps.get(go.get("transform", ""))
        if tf is None:
            continue
        father = (tf.get("m_Father") or {}).get("fileID")
        go["parent"] = tf_owner.get(father) if father else None
        if father and father not in tf_owner:
            problems.append(f"Transform {go['transform']} 的 m_Father {father} 不存在")
        go["children"] = []
        for ch in tf.get("m_Children") or []:
            child_go = tf_owner.get((ch or {}).get("fileID"))
            if child_go is None:
                problems.append(f"Transform {go['transform']} 的子物件 {ch} 不存在")
                continue
            go["children"].append(child_go)
        if not father:
            roots.append((int(tf.get("m_RootOrder") or 0), gid))
    for gid, go in gos.items():
        for ch in go.get("children", []):
            if gos[ch].get("parent") != gid:
                problems.append(f"{ch} 列在 {gid} 的 m_Children，但它的 m_Father 不是 {gid}")
    roots.sort()
    root_ids = [gid for _, gid in roots]

    # 從根走得到全部 GameObject
    seen: set[str] = set()
    stack = list(root_ids)
    while stack:
        gid = stack.pop()
        if gid in seen:
            problems.append(f"GameObject {gid} 在樹裡出現兩次")
            continue
        seen.add(gid)
        stack.extend(gos[gid].get("children", []))
    orphans = sorted(set(gos) - seen)
    for gid in orphans:
        problems.append(f"GameObject {gid}（{gos[gid]['m_Name']}）從根走不到")

    out = {"roots": root_ids, "gameObjects": gos, "components": comps, "settings": settings}
    check = {
        "problems": problems,
        "unresolvedScripts": unresolved,
        "missingScripts": missing,
        "reachable": len(seen),
        "counts": dict(sorted(Counter(c["type"] for c in comps.values()).items())) | {"GameObject": len(gos)},
    }
    return out, check


def iter_refs(v):
    """走過資料裡所有指向別的檔案的 PPtr。"""
    if isinstance(v, dict):
        if set(v) == {"guid", "fileID"}:
            yield v
            return
        for x in v.values():
            yield from iter_refs(x)
    elif isinstance(v, list):
        for x in v:
            yield from iter_refs(x)


# ───────── Unity 內建資源的參照 ─────────


def build_scene_order(assets: Path, game_data: Path | None = None) -> list[str]:
    """EditorBuildSettings 啟用的場景，照順序：第 N 個就是 build 裡的 level<N>。

    匯出沒有 EditorBuildSettings.asset 時（Diceomancer 的 ar_fullver），改讀原版 build 的 BuildSettings（globalgamemanagers）。
    那份匯出的場景檔名是 AssetRipper 取的 level<N>，名稱要換回 build 裡的真名（遊戲用 "Scenes/Main Menu" 載入），見 build_scene_names。"""
    p = assets.parent / "ProjectSettings" / "EditorBuildSettings.asset"
    if p.exists():
        docs = load_unity_docs(p)
        scenes = next((d["data"].get("m_Scenes") or [] for d in docs if d["type"] == "EditorBuildSettings"), [])
        return [Path(s["path"]).stem for s in scenes if s.get("enabled")]
    return [Path(s).stem for s in build_scene_paths(game_data)] if game_data else []


def build_scene_paths(game_data: Path) -> list[str]:
    """原版 build 的 BuildSettings.scenes（"Assets/Scenes/Main Menu.unity"…）。UnityPy 照型別樹讀會多要 8 bytes，不檢查長度。"""
    import UnityPy

    gm = game_data / "globalgamemanagers"
    if not gm.exists():
        return []
    for o in UnityPy.load(str(gm)).objects:
        if o.type.name == "BuildSettings":
            return list(o.read_typetree(check_read=False).get("scenes") or [])
    return []


def verify_builtin_refs(game_data: Path, out_root: Path, scene_order: list[str]) -> dict:
    """每個指向 unity_builtin_extra 的參照，到原版 build 的同一個物件（pathID = fileID）裡找原始 PPtr 位元組，
    確認它真的指向 builtin.json 記的那個 build 物件。對照表錯了這裡會抓到。"""
    import struct

    import UnityPy

    builtin = json.loads((out_root / "assets/builtin.json").read_text(encoding="utf-8"))
    result = {"checked": 0, "mismatched": []}
    for level, scene in enumerate(scene_order):
        build_file = game_data / f"level{level}"
        scene_json = out_root / "scenes" / f"{scene}.json"
        if not build_file.exists() or not scene_json.exists():
            result["mismatched"].append({"scene": scene, "error": "找不到 build 檔或場景 JSON"})
            continue
        sf = next(iter(UnityPy.load(str(build_file)).files.values()))
        externals = [e.path.split("/")[-1] for e in sf.externals]
        objects = {str(o.path_id): o for o in sf.objects.values()}
        data = json.loads(scene_json.read_text(encoding="utf-8"))
        for cid, comp in data["components"].items():
            for field, value in comp.items():
                if field == "m_Script":
                    continue
                for ref in value if isinstance(value, list) else [value]:
                    if not (isinstance(ref, dict) and ref.get("guid") in BUILTIN_GUIDS):
                        continue
                    result["checked"] += 1
                    entry = builtin.get(f"{ref['guid']}:{ref['fileID']}")
                    ok = False
                    if entry:
                        fn, path_id = entry["build"].split("#")
                        if fn in externals:
                            pattern = struct.pack("<iq", externals.index(fn) + 1, int(path_id))
                            ok = pattern in objects[cid].get_raw_data()
                    if not ok:
                        result["mismatched"].append(
                            {"scene": scene, "component": cid, "field": field, "ref": ref, "expected": entry and entry["name"]}
                        )
    return result


# ───────── 主程式 ─────────


def asset_categories(out_root: Path, assets: Path, guids: dict[str, Path]) -> dict[str, str]:
    """guid → 去向（0b 的哪張表、prefab、scriptableobject…），給外部參照的統計用。"""
    cats: dict[str, str] = {}
    assets_out = out_root / "assets"
    for name in (
        "textures", "sprites", "fonts", "materials", "shaders", "animations",
        "animators", "meshes", "physicMaterials", "monobehaviours", "texts", "audioclips",
    ):
        p = assets_out / f"{name}.json"
        if p.exists():
            for g in json.loads(p.read_text(encoding="utf-8")):
                cats[g] = name
    for g, p in guids.items():
        if g in cats:
            continue
        if p.suffix == ".prefab":
            cats[g] = "prefabs"
        elif p.suffix == ".unity":
            cats[g] = "scenes"
        elif p.suffix in (".cs", ".dll"):
            cats[g] = "scripts"
        elif p.suffix == ".asset" and p.is_file():
            t = first_doc_type(p)
            if t in NOT_IMPORTED:
                cats[g] = f"未匯入（{t}）"  # 0b 刻意沒匯的類別，原因見 assets/report.json
    return cats


def export_scenes(assets: Path, game_data: Path, out_root: Path, guids: dict[str, Path]) -> dict:
    t0 = time.time()
    out = out_root / "scenes"
    # hierarchy.json 是轉換器（--hierarchy）的輸出，不是這一步產生的：清資料夾時留著，否則子類別找不到 DLL 基底（GetComponent<TMP_Text> 認不出 TextMeshProUGUI）
    keep = {n: (out / n).read_bytes() for n in ("hierarchy.json",) if (out / n).exists()}
    if out.exists():
        shutil.rmtree(out)
    (out / "prefabs").mkdir(parents=True)
    for n, data in keep.items():
        (out / n).write_bytes(data)

    resolver = ScriptResolver(assets, game_data, guids)
    scene_order = build_scene_order(assets, game_data)
    # 匯出沒有 EditorBuildSettings、場景檔叫 level<N> 時，名稱與路徑換回 build 的（build_scene_order 的說明）
    renamed = {} if (assets.parent / "ProjectSettings" / "EditorBuildSettings.asset").exists() else {
        f"level{i}": path.removeprefix("Assets/") for i, path in enumerate(build_scene_paths(game_data) if game_data else [])
    }
    cats = asset_categories(out_root, assets, guids)
    files = sorted((g, p) for g, p in guids.items() if p.suffix in (".unity", ".prefab") and p.is_file())

    index: dict[str, dict] = {"scenes": {}, "prefabs": {}}
    totals: Counter = Counter()
    header_totals: Counter = Counter()
    problems: dict[str, list[str]] = {}
    unresolved: dict[str, list] = {}
    missing: dict[str, list] = {}
    ext_refs: Counter = Counter()
    unknown_refs: Counter = Counter()
    suspect: dict[str, list[str]] = {}
    failed: list[dict] = []

    for guid, p in files:
        rel = str(p.relative_to(assets))
        try:
            text = p.read_text(encoding="utf-8", errors="replace")
            for m in re.finditer(r"^--- !u!\d+ &-?\d+(?: stripped)?[ \t]*\n(\w+):", text, re.M):
                header_totals[m.group(1)] += 1  # 獨立於解析的數法，拿來對數量
            sk = suspect_hex_keys(text)
            if sk:
                suspect[rel] = sorted(sk)
            docs = load_unity_docs(p, text)
            tree, check = build_tree(docs, resolver)
        except Exception as e:  # noqa: BLE001 — 失敗照實記錄
            failed.append({"src": rel, "error": f"{type(e).__name__}: {e}"})
            continue

        lighting_data_of(tree["settings"], guids)
        totals.update(check["counts"])
        totals.update({"settings:" + k: 1 for k in tree["settings"]})
        if check["problems"]:
            problems[rel] = check["problems"]
        if check["unresolvedScripts"]:
            unresolved[rel] = check["unresolvedScripts"]
        if check["missingScripts"]:
            missing[rel] = check["missingScripts"]
        for c in tree["components"].values():
            data = {k: v for k, v in c.items() if k != "m_Script"}
            for r in iter_refs(data):
                g = r["guid"]
                cat = BUILTIN_GUIDS.get(g) or cats.get(g)
                ext_refs[cat or "未知"] += 1
                if cat is None:
                    unknown_refs[g] += 1

        name = p.stem
        if p.suffix == ".unity" and name in renamed:
            rel = renamed[name]
            name = Path(rel).stem
        entry = {
            "name": name,
            "src": rel,
            "roots": len(tree["roots"]),
            "counts": check["counts"],
        }
        if p.suffix == ".unity":
            file = f"scenes/{name}.json"
            index["scenes"][name] = {"guid": guid, "file": file, "buildIndex": scene_order.index(name) if name in scene_order else None, **entry}
        else:
            file = f"scenes/prefabs/{guid}.json"
            index["prefabs"][guid] = {"file": file, **entry}
        write_json(out_root / file, {"guid": guid, "name": name, "src": rel, **tree})

    index["buildOrder"] = scene_order
    write_json(out / "index.json", index)
    builtin_check = verify_builtin_refs(game_data, out_root, scene_order)
    report = {
        "files": {
            "scenes": len(index["scenes"]),
            "prefabs": len(index["prefabs"]),
            "source": len(files),
            "failed": failed,
        },
        # 解析後的物件數 vs 直接數 YAML 標頭（GameObject、各種元件、場景設定）
        "objects": {
            "parsed": dict(sorted(totals.items())),
            "headers": dict(sorted(header_totals.items())),
        },
        "scripts": {
            "monoScriptsInBuild": len(resolver.monoscripts),
            "distinctRefs": len(resolver.cache),
            "resolved": sum(1 for v in resolver.cache.values() if v and "class" in v),
            "unresolved": unresolved,
            "missingInOriginal": missing,
            "byAssembly": dict(
                sorted(Counter(v["assembly"] for v in resolver.cache.values() if v and "class" in v).items())
            ),
        },
        "treeProblems": problems,
        "externalRefs": dict(sorted(ext_refs.items())),
        "builtinRefs": builtin_check,
        "unknownRefGuids": dict(unknown_refs.most_common()),
        "suspectHexKeys": suspect,
        "seconds": round(time.time() - t0, 1),
    }
    write_json(out / "report.json", report)
    return report

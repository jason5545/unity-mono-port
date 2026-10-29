"""從原版 build 補 AssetRipper 漏掉的資料，寫回匯出的 JSON。

來源是 diceomancer-web 的 scripts/import/buildread.py 與 supplement.py（10/5 對 Diceomancer 的 build 逐一驗過），
2026/10/20 搬進工具包、改成不綁遊戲（原生版 unity-native 的 Diceomancer 要用）。

AssetRipper 不匯出 [SerializeReference] 欄位：Unity Localization 的 GameObjectLocalizer、LocalizeStringEvent 的區域變數整個變成空殼；
Addressables bundle 裡的 ScriptableObject（Locale、StringTable、SharedTableData…）與 LocalizationSettings 連一般欄位都沒有，只剩 m_Name。
build 是 Mono 後端、序列化檔沒附 type tree（bundle 有），所以用 TypeTreeGeneratorAPI 從 Managed/*.dll 產生欄位結構，再交給 UnityPy 讀原始位元組。

補的範圍：
1. ScriptableObject（assets/monobehaviours.json 的 objects/<guid>.json）：匯出是空殼、或類別有 [SerializeReference] 欄位的，整個換成 build 的。
   對應：Addressables bundle 裡的照 bundle 的 m_Container 路徑（"assets/…"，小寫）對匯出的 src；其他照（腳本類別, 名稱）在 build 裡唯一才對。
2. 場景與 prefab 裡類別有 [SerializeReference] 欄位的元件：
   - 場景：AssetRipper 的 fileID = build 的 pathID（scenes 步驟已用原始 PPtr 位元組驗過），另外核對腳本相同。build 檔是 level<buildIndex>。
   - prefab（sharedassets*、resources.assets）：同名根物件、整棵階層的簽名（名稱、子物件數、元件類別）完全相同才算對到，
     再依「階層路徑 + 元件順序」對元件。同一個 prefab 在 build 裡有好幾份副本時，補出來的內容要相同，不同就算歧義、不補。
寫法：
- SerializeReference 的值 → {"$type": 類別, "$ns": 命名空間, "$asm": 組件, ...欄位}；空參照 null。補過的物件記 "$build"（來源檔#pathID）。
- build 的 PPtr → 匯出參照：同檔的 {"fileID"}；補過的 ScriptableObject 直接對；Unity 內建資源（unity default resources、unity_builtin_extra）
  → 內建 guid 與 pathID；其他照「型別 + 名稱」找匯出的候選，有好幾個就比內容，內容都一樣的挑場景與 prefab 用得最多的（報告記為「副本」）。
- 超過 2^53 的整數（StringTable 的 keyId、rid、pathID）轉字串（JSON 的數字放不下）。

生成器（TypeTreeGeneratorAPI 0.0.10）有三個地方跟 Unity 實際的序列化不同，這裡修正（10/5 逐一對 build 確認）：
1. 每個型別前面都加了 MonoBehaviour 的檔頭（m_GameObject、m_Enabled、m_Script、m_Name）。
   SerializeReference 參照的是普通 [Serializable] 類別，沒有檔頭，要拿掉；MonoBehaviour 本身的 m_Enabled 要補 4 位元組對齊。
2. LazyLoadReference<T> 產生成 4 位元組的 m_InstanceID，實際序列化是 PPtr（m_FileID + m_PathID，12 位元組）。
3. string[]、int[] 這類基本型別陣列，節點型別寫成元素型別（string、int），UnityPy 會當成單一值讀。改成 vector。
驗證方式：每個物件都用 check_read 讀，位元組數必須剛好等於物件大小，結構錯了會直接失敗。

另外輸出 <out>/assets/resources.json：build 的 ResourceManager 容器（Resources 資料夾的路徑，小寫）→ 匯出參照的清單。
原版同一個路徑底下可以有好幾個物件（主資產加子資產：FMOD 的 FMODStudioSettings 底下有 11 個平台設定，AssetRipper 拆成獨立檔），
Resources.LoadAll 照這份回全部；對不到的是 null（執行環境退回照檔名的對法）。

輸出：改寫 <out>/assets/objects/*.json、<out>/scenes/*.json、<out>/scenes/prefabs/*.json；新增 <out>/assets/resources.json；報告 <out>/supplement.json。
"""

from __future__ import annotations

import importlib
import json
import time
from collections import Counter, defaultdict
from pathlib import Path

MB_HEADER = ("m_GameObject", "m_Enabled", "m_Script", "m_Name")
ALIGN = 0x4000
NULL_RIDS = {-1, -2, 0}
BIG = 2**53
# Unity 內建資源檔 → 匯出用的 guid（fileID 是 build 的 pathID，同 AssetRipper 與 engine 的 Assets.BuiltinDefault／BuiltinExtra）
BUILTIN_FILES = {"unity default resources": "0000000000000000e000000000000000", "unity_builtin_extra": "0000000000000000f000000000000000"}
# 匯出端的表：build 型別 → (assets/ 底下的索引檔名, 主物件 fileID)
EXPORT_TABLES = {
    "Texture2D": ("textures", "2800000"),
    "Sprite": ("sprites", "21300000"),
    "Material": ("materials", "2100000"),
    "MonoBehaviour": ("monobehaviours", "11400000"),
    "Font": ("fonts", "12800000"),
}
# ScriptableObject 匯出記錄裡，不算「有內容」的鍵（匯入器加的與每個 MonoBehaviour 都有的檔頭）
SO_BASE_KEYS = {"src", "fileID", "m_GameObject", "m_Enabled", "m_EditorHideFlags", "m_Script", "m_Name", "m_EditorClassIdentifier", "$build", "$subObjects"}


def big_to_str(v):
    if isinstance(v, bool):
        return v
    if isinstance(v, int) and abs(v) >= BIG:
        return str(v)
    if isinstance(v, dict):
        return {k: big_to_str(x) for k, x in v.items()}
    if isinstance(v, list):
        return [big_to_str(x) for x in v]
    return v


def inline_references(data: dict) -> dict:
    """把 SerializeReference 的 {rid} 換成實際物件（{"$type", "$ns", "$asm", ...欄位}），拿掉 references 區。空參照變 None。"""
    registry = {r["rid"]: r for r in (data.get("references") or {}).get("RefIds", [])}

    def walk(v, depth=0):
        if depth > 64:
            raise ValueError("SerializeReference 巢狀太深（可能有循環）")
        if isinstance(v, dict):
            if set(v) == {"rid"}:
                rid = v["rid"]
                if rid in NULL_RIDS or rid not in registry:
                    return None
                r = registry[rid]
                t = r["type"]
                if t["class"] == "":
                    return None
                return {"$type": t["class"], "$ns": t["ns"], "$asm": t["asm"], **walk(r.get("data") or {}, depth + 1)}
            return {k: walk(x, depth + 1) for k, x in v.items() if k != "references"}
        if isinstance(v, list):
            return [walk(x, depth + 1) for x in v]
        return v

    return walk(data)


# ───────── 讀 build ─────────


class BuildReader:
    def __init__(self, game_data: Path):
        import UnityPy
        from TypeTreeGeneratorAPI import TypeTreeGenerator
        from UnityPy.helpers.TypeTreeNode import TypeTreeNode

        self.game_data = game_data
        self._UnityPy = UnityPy
        self._Node = TypeTreeNode
        self._tth = importlib.import_module("UnityPy.helpers.TypeTreeHelper")
        self._files: dict[str, object] = {}
        self._bundles: dict[str, object] | None = None
        self._containers: list[tuple[object, dict[str, list[int]]]] = []
        self.serialized = sorted(
            p.name for p in game_data.iterdir()
            if p.is_file() and (p.name.startswith("level") and p.name[5:].isdigit() or p.suffix == ".assets")
        )
        ggm = self.file("globalgamemanagers.assets")
        version = ggm.unity_version.split("c")[0]  # 2022.3.3f1c1 → 2022.3.3f1（中國版的後綴）
        self.gen = TypeTreeGenerator(version)
        for dll in sorted((game_data / "Managed").glob("*.dll")):
            self.gen.load_dll(dll.read_bytes())
        self._nodes: dict[tuple[str, str, bool], object] = {}
        self._has_refs: dict[tuple[str, str], bool] = {}
        self._scripts: dict[tuple[str, int], tuple[str, str, str] | None] = {}
        # UnityPy 讀 SerializeReference 時要靠檔案內附的 type tree（build 的序列化檔沒有），改成問生成器。
        # C 版讀取器自己查型別，關掉改用 Python 版。
        self._tth.get_ref_type_node = self._ref_node
        self._tth.read_typetree_boost = None

    # ───────── 檔案 ─────────

    def file(self, name: str):
        """build 根目錄的序列化檔，或 Addressables bundle 裡的 CAB-…"""
        if name in self._files:
            return self._files[name]
        if name.startswith("CAB-"):
            self.bundles()
            if name not in self._files:
                raise KeyError(f"找不到 bundle 裡的 {name}")
            return self._files[name]
        self._files[name] = next(iter(self._UnityPy.load(str(self.game_data / name)).files.values()))
        return self._files[name]

    def bundles(self) -> list[tuple[object, dict[str, list[int]]]]:
        """StreamingAssets 裡所有 *.bundle 的序列化檔與 m_Container（路徑 → pathID 清單）"""
        if self._bundles is None:
            self._bundles = {}
            for p in sorted((self.game_data / "StreamingAssets").rglob("*.bundle")):
                env = self._UnityPy.load(str(p))
                for bf in env.files.values():
                    for name, sf in getattr(bf, "files", {}).items():
                        if not hasattr(sf, "objects"):
                            continue
                        self._files[name] = sf
                        self._bundles[name] = sf
                        ab = next((o for o in sf.objects.values() if o.type.name == "AssetBundle"), None)
                        if ab is None:
                            continue
                        container: dict[str, list[int]] = defaultdict(list)
                        for path, info in ab.read_typetree()["m_Container"]:
                            container[path.lower()].append(info["asset"]["m_PathID"])
                        self._containers.append((sf, container))
        return self._containers

    def externals(self, sf) -> list[str]:
        return [e.path.split("/")[-1] for e in sf.externals]

    def target(self, sf, fid: int):
        """PPtr 的 m_FileID → 序列化檔（0 是自己）；Unity 內建資源檔與找不到的回 None"""
        if fid == 0:
            return sf
        try:
            return self.file(self.externals(sf)[fid - 1])
        except Exception:
            return None

    # ───────── 腳本 ─────────

    def script_of(self, sf, obj) -> tuple[str, str, str] | None:
        """MonoBehaviour 的腳本 →（組件, 命名空間, 類別）。MonoScript 在 globalgamemanagers.assets（序列化檔）或 bundle 自己裡面"""
        head = obj.parse_monobehaviour_head()
        fid, pid = head.m_Script.m_FileID, head.m_Script.m_PathID
        tsf = self.target(sf, fid)
        if tsf is None or pid == 0:
            return None
        key = (tsf.name, pid)
        if key not in self._scripts:
            o = tsf.objects.get(pid)
            s = o.read() if o is not None and o.type.name == "MonoScript" else None
            self._scripts[key] = (s.m_AssemblyName, s.m_Namespace, s.m_ClassName) if s else None
        return self._scripts[key]

    # ───────── 欄位結構 ─────────

    def _fix(self, nodes: list, drop_header: bool):
        Node = self._Node
        out = []
        i = 0
        while i < len(nodes):
            n = nodes[i]
            end = i + 1
            while end < len(nodes) and nodes[end].m_Level > n.m_Level:
                end += 1
            if drop_header and n.m_Level == 1 and n.m_Name in MB_HEADER:
                i = end
                continue
            if n.m_Type.startswith("LazyLoadReference"):
                out += [
                    Node(n.m_Level, "PPtr<Object>", n.m_Name, 0, 0, m_MetaFlag=n.m_MetaFlag),
                    Node(n.m_Level + 1, "int", "m_FileID", 0, 0, m_MetaFlag=0),
                    Node(n.m_Level + 1, "SInt64", "m_PathID", 0, 0, m_MetaFlag=0),
                ]
                i = end
                continue
            typ = n.m_Type
            if end - i > 1 and nodes[i + 1].m_Type == "Array" and typ in self._tth.FUNCTION_READ_MAP:
                elem = nodes[i + 3] if i + 3 < end else None
                if not (typ == "string" and elem is not None and elem.m_Type == "char"):
                    typ = "vector"
            flag = n.m_MetaFlag
            if not drop_header and n.m_Level == 1 and n.m_Name == "m_Enabled":
                flag |= ALIGN
            out.append(Node(n.m_Level, typ, n.m_Name, 0, 0, m_MetaFlag=flag))
            i += 1
        return Node.from_list(out)

    def nodes(self, asm: str, ns: str, cls: str, *, monobehaviour: bool):
        key = (asm, f"{ns}.{cls}" if ns else cls, monobehaviour)
        if key not in self._nodes:
            dll = asm if asm.endswith(".dll") else f"{asm}.dll"
            self._nodes[key] = self._fix(list(self.gen.get_nodes(dll, key[1])), not monobehaviour)
        return self._nodes[key]

    def _ref_node(self, ref: dict, assetsfile):
        t = ref["type"]
        if t["class"] == "":
            return None  # 空參照（rid -2）
        # 檔案有附 type tree（Addressables bundle）就用檔案的
        for rt in (getattr(assetsfile, "ref_types", None) or []):
            if (rt.m_ClassName, rt.m_NameSpace, rt.m_AssemblyName) == (t["class"], t["ns"], t["asm"]) and rt.node:
                return rt.node
        return self.nodes(t["asm"], t["ns"], t["class"], monobehaviour=False)

    def has_serialize_reference(self, asm: str, ns: str, cls: str) -> bool:
        key = (asm, f"{ns}.{cls}" if ns else cls)
        if key not in self._has_refs:
            try:
                nodes = self.gen.get_nodes(asm if asm.endswith(".dll") else f"{asm}.dll", key[1])
                self._has_refs[key] = any(n.m_Type == "managedReference" for n in nodes)
            except Exception:
                self._has_refs[key] = False
        return self._has_refs[key]

    def read_monobehaviour(self, sf, obj) -> dict:
        """整個 MonoBehaviour，SerializeReference 已經換成實際物件。bundle 用檔案附的 type tree；序列化檔用生成器（位元組數不對會丟例外）"""
        if getattr(sf, "_enable_type_tree", False):
            return inline_references(obj.read_typetree())
        script = self.script_of(sf, obj)
        if script is None:
            raise ValueError("找不到 MonoScript")
        return inline_references(obj.read_typetree(nodes=self.nodes(*script, monobehaviour=True), check_read=True))


# ───────── build 物件 → 匯出參照 ─────────


def _close(a, b) -> bool:
    if isinstance(a, bool) or isinstance(b, bool):
        return int(a) == int(b)
    if isinstance(a, (int, float)) and isinstance(b, (int, float)):
        return abs(a - b) <= 1e-4 * max(1.0, abs(a), abs(b))
    return a == b


def _scalars(v, prefix="", depth=0, out=None):
    """攤平成 {路徑: 數值或字串}；PPtr、參照、長陣列不比"""
    out = {} if out is None else out
    if depth > 3:
        return out
    if isinstance(v, dict):
        keys = set(v)
        if keys == {"m_FileID", "m_PathID"} or ("fileID" in keys and keys <= {"fileID", "guid", "type"}):
            return out  # 參照不比
        for k, x in v.items():
            if k in ("src", "file", "fileID", "m_Script", "m_GameObject", "m_EditorClassIdentifier", "m_EditorHideFlags", "serializedVersion"):
                continue
            _scalars(x, f"{prefix}.{k}" if prefix else k, depth + 1, out)
    elif isinstance(v, (int, float, str)) and not (isinstance(v, str) and len(v) > 200):
        out[prefix] = v
    return out


def _guids(v):
    if isinstance(v, dict):
        if "guid" in v and isinstance(v.get("guid"), str):
            yield v["guid"]
        for x in v.values():
            yield from _guids(x)
    elif isinstance(v, list):
        for x in v:
            yield from _guids(x)


class ExportResolver:
    def __init__(self, reader: BuildReader, out_root: Path):
        self.reader = reader
        self.out_root = out_root
        self.candidates: dict[tuple[str, str], list[tuple[str, dict]]] = defaultdict(list)
        for typ, (table, _) in EXPORT_TABLES.items():
            p = out_root / "assets" / f"{table}.json"
            if not p.exists():
                continue
            for guid, rec in json.loads(p.read_text(encoding="utf-8")).items():
                name = rec.get("name") if "name" in rec else rec.get("m_Name")
                self.candidates[(typ, name)].append((guid, rec))
        # 偏好：場景與 prefab 參照最多次的 guid（只算 AssetRipper 匯出的參照，重跑時結果才不會跟著上一次的補充改變）
        self.usage: Counter = Counter()
        for f in (out_root / "scenes").rglob("*.json"):
            data = json.loads(f.read_text(encoding="utf-8"))
            if not isinstance(data, dict) or not isinstance(data.get("components"), dict):
                continue
            for m in data["components"].values():
                if "$build" in m:
                    continue
                for g in _guids(m):
                    self.usage[g] += 1
        self.cache: dict[tuple[str, int], tuple[dict | None, str]] = {}
        self.stats: Counter = Counter()
        self.problems: list[dict] = []

    def known(self, sf, path_id: int, ref: dict, status: str):
        """已經知道對應的物件（補過的 ScriptableObject）"""
        self.cache[(sf.name, path_id)] = (ref, status)

    def _record(self, typ: str, rec: dict) -> dict:
        if typ == "MonoBehaviour":
            return json.loads((self.out_root / "assets" / rec["file"]).read_text(encoding="utf-8"))
        return rec

    def _build_data(self, sf, obj) -> dict:
        if obj.type.name == "MonoBehaviour":
            try:
                return self.reader.read_monobehaviour(sf, obj)
            except Exception:
                return {}
        return obj.read_typetree()

    def _equivalent(self, typ: str, build: dict, rec: dict) -> bool:
        if typ == "Texture2D":
            return (build.get("m_Width"), build.get("m_Height")) == (rec.get("width"), rec.get("height"))
        if typ == "Sprite":
            pairs = [(build["m_Rect"], rec["m_Rect"]), (build["m_RD"]["textureRect"], rec["m_RD"]["textureRect"])]
            return all(_close(a[k], b[k]) for a, b in pairs for k in ("x", "y", "width", "height"))
        if typ == "Material":
            props = build["m_SavedProperties"]
            bf, bc = dict(props["m_Floats"]), dict(props["m_Colors"])
            rf, rc = rec["m_SavedProperties"]["m_Floats"], rec["m_SavedProperties"]["m_Colors"]
            for k in set(bf) | set(rf):
                if k not in bf or k not in rf or not _close(bf[k], rf[k]):
                    return False
            for k in set(bc) | set(rc):
                if k not in bc or k not in rc or any(not _close(bc[k][c], rc[k][c]) for c in "rgba"):
                    return False
            return True
        if typ == "Font":
            return len(build.get("m_FontData") or []) == rec.get("bytes")
        a, b = _scalars(build), _scalars(rec)
        common = set(a) & set(b)
        return len(common) > 0 and all(_close(a[k], b[k]) for k in common)

    def resolve(self, sf, path_id: int) -> tuple[dict | None, str]:
        key = (sf.name, path_id)
        if key in self.cache:
            return self.cache[key]
        obj = sf.objects.get(path_id)
        if obj is None:
            result = (None, "build 裡沒有這個物件")
        else:
            typ = obj.type.name
            name = obj.peek_name()
            cands = self.candidates.get((typ, name), [])
            if typ not in EXPORT_TABLES:
                result = (None, f"不處理的型別 {typ}")
            elif not cands:
                result = (None, f"匯出裡沒有 {typ}「{name}」")
            elif len(cands) == 1 and typ == "MonoBehaviour":
                result = ({"guid": cands[0][0], "fileID": EXPORT_TABLES[typ][1]}, "唯一")
            else:
                build = self._build_data(sf, obj)
                same = [(g, r) for g, r in cands if self._equivalent(typ, build, self._record(typ, r))]
                if not same:
                    result = (None, f"{typ}「{name}」有 {len(cands)} 個候選，內容都對不上")
                else:
                    same.sort(key=lambda gr: (-self.usage[gr[0]], gr[1].get("src", "")))
                    result = ({"guid": same[0][0], "fileID": EXPORT_TABLES[typ][1]}, "唯一" if len(same) == 1 else "副本")
        self.cache[key] = result
        self.stats[result[1] if result[0] else "失敗"] += 1
        if result[0] is None:
            self.problems.append({"file": sf.name, "pathID": str(path_id), "error": result[1]})
        return result


# ───────── 補資料 ─────────


class Supplementer:
    def __init__(self, reader: BuildReader, resolver: ExportResolver):
        self.reader = reader
        self.resolver = resolver
        self.report = {
            "objects": Counter(),  # ScriptableObject 類別 → 補了幾個
            "objectFailures": [],
            "components": Counter(),  # 元件類別 → 補了幾個
            "failed": [],
            "refs": Counter(),
            "ambiguousPrefabs": [],
            "unmatchedPrefabs": [],
        }

    # PPtr → 匯出參照
    def convert(self, data, sf, local_map: dict[int, str]):
        def walk(v):
            if isinstance(v, dict):
                if set(v) == {"m_FileID", "m_PathID"}:
                    fid, pid = v["m_FileID"], v["m_PathID"]
                    if pid == 0:
                        self.report["refs"]["空"] += 1
                        return None
                    if fid == 0 and pid in local_map:
                        self.report["refs"]["本地"] += 1
                        return {"fileID": local_map[pid]}
                    ext = self.reader.externals(sf)[fid - 1] if fid > 0 else None
                    if ext in BUILTIN_FILES:
                        self.report["refs"]["內建資源"] += 1
                        return {"guid": BUILTIN_FILES[ext], "fileID": str(pid)}
                    target_sf = self.reader.target(sf, fid)
                    if target_sf is None:
                        self.report["refs"]["外部檔不在 build 裡"] += 1
                        return {"build": f"{ext}#{pid}", "unresolved": True}
                    ref, status = self.resolver.resolve(target_sf, pid)
                    self.report["refs"][f"外部（{status}）" if ref else "外部對不到"] += 1
                    return ref or {"build": f"{target_sf.name}#{pid}", "unresolved": True}
                return {k: walk(x) for k, x in v.items()}
            if isinstance(v, list):
                return [walk(x) for x in v]
            return v

        return walk(data)

    @staticmethod
    def _fields(data: dict) -> dict:
        skip = {"m_GameObject", "m_Enabled", "m_Script", "m_Name"}
        return {k: v for k, v in data.items() if k not in skip}

    # ScriptableObject
    def objects(self, out_root: Path) -> int:
        assets = out_root / "assets"
        table = json.loads((assets / "monobehaviours.json").read_text(encoding="utf-8"))
        by_container: dict[str, tuple[object, int]] = {}
        for sf, container in self.reader.bundles():
            for path, pids in container.items():
                for pid in pids:
                    if sf.objects[pid].type.name == "MonoBehaviour":
                        by_container[path] = (sf, pid)
        by_name: dict[tuple[str, str], list[tuple[object, int]]] = defaultdict(list)
        for name in self.reader.serialized:
            sf = self.reader.file(name)
            for o in sf.objects.values():
                if o.type.name != "MonoBehaviour":
                    continue
                try:
                    s = self.reader.script_of(sf, o)
                    if s and not o.parse_monobehaviour_head().m_GameObject.m_PathID:
                        by_name[(s[2], o.peek_name())].append((sf, o.path_id))
                except Exception:
                    continue
        # 先對完全部，補過的資產互相參照（StringTable → SharedTableData）時直接對得到
        matched = []
        for guid, rec in table.items():
            hit = by_container.get("assets/" + (rec.get("src") or "").lower())
            if hit is None and rec.get("script"):
                cands = by_name.get((rec["script"], rec.get("name")), [])
                hit = cands[0] if len(cands) == 1 else None
            if hit is None:
                continue
            sf, pid = hit
            self.resolver.known(sf, pid, {"guid": guid, "fileID": "11400000"}, "補過的資產")
            matched.append((guid, rec, sf, pid))
        n = 0
        for guid, rec, sf, pid in matched:
            p = assets / rec["file"]
            data = json.loads(p.read_text(encoding="utf-8"))
            shell = not (set(data) - SO_BASE_KEYS)
            obj = sf.objects[pid]
            try:
                script = self.reader.script_of(sf, obj)
                if not (shell or "$build" in data or (script and self.reader.has_serialize_reference(*script))):
                    continue
                build = self.reader.read_monobehaviour(sf, obj)
            except Exception as e:  # noqa: BLE001
                self.report["objectFailures"].append({"asset": rec.get("src"), "build": f"{sf.name}#{pid}", "error": str(e)[:200]})
                continue
            # 先換參照再轉大整數：bundle 的 pathID 是 64 位元，轉成字串就查不到了
            fields = big_to_str(self.convert(self._fields(build), sf, {}))
            if not fields and shell:
                continue  # 類別本來就沒有欄位
            keep = {k: data[k] for k in ("src", "fileID", "m_GameObject", "m_Enabled", "m_EditorHideFlags", "m_Script", "m_Name", "m_EditorClassIdentifier", "$subObjects") if k in data}
            p.write_text(json.dumps({**keep, **fields, "$build": f"{sf.name}#{pid}"}, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
            self.report["objects"][rec.get("script") or "?"] += 1
            n += 1
        return n

    # 場景：fileID = pathID
    def scene(self, scene_json: dict, build_name: str) -> int:
        sf = self.reader.file(build_name)
        local = {int(k): k for k in list(scene_json["components"]) + list(scene_json["gameObjects"])}
        n = 0
        for cid, comp in scene_json["components"].items():
            script = comp.get("script")
            if not script or "assembly" not in script or not self.reader.has_serialize_reference(script["assembly"], script["namespace"], script["class"]):
                continue
            obj = sf.objects.get(int(cid))
            try:
                if obj is None or obj.type.name != "MonoBehaviour":
                    raise ValueError("build 裡同 pathID 的物件不是 MonoBehaviour")
                s = self.reader.script_of(sf, obj)
                if s is None or (s[0].removesuffix(".dll"), s[1], s[2]) != (script["assembly"], script["namespace"], script["class"]):
                    raise ValueError(f"腳本不同：build {s}")
                data = self.reader.read_monobehaviour(sf, obj)
            except Exception as e:  # noqa: BLE001
                self.report["failed"].append({"file": build_name, "component": cid, "class": script["class"], "error": str(e)[:200]})
                continue
            comp.update(big_to_str(self.convert(self._fields(data), sf, local)))
            comp["$build"] = f"{build_name}#{cid}"
            self.report["components"][script["class"]] += 1
            n += 1
        return n

    # prefab：階層簽名對應
    def _build_roots(self):
        if hasattr(self, "_roots"):
            return self._roots
        roots = defaultdict(list)  # 根物件名稱 → [(檔名, GameObject pathID)]
        for name in self.reader.serialized:
            if name.startswith("level") or name == "globalgamemanagers.assets":
                continue
            sf = self.reader.file(name)
            for o in sf.objects.values():
                if o.type.name in ("Transform", "RectTransform"):
                    t = o.read()
                    if t.m_Father.m_PathID == 0:
                        roots[sf.objects[t.m_GameObject.m_PathID].peek_name()].append((name, t.m_GameObject.m_PathID))
        self._roots = roots
        return roots

    def _build_tree(self, sf, go_pid: int, path=()):
        """build 的階層 → [(路徑, GameObject pathID, [(元件 pathID, 類別)], 名稱)]，路徑 =（名稱, 同層序號）"""
        go = sf.objects[go_pid].read()
        comps = []
        transform_pid = None
        for c in go.m_Component:
            pid = c.component.m_PathID
            o = sf.objects[pid]
            kind = o.type.name
            if kind == "MonoBehaviour":
                s = self.reader.script_of(sf, o)
                kind = f"MB:{s[2] if s else '?'}"
            elif kind in ("Transform", "RectTransform"):
                transform_pid = pid
            comps.append((pid, kind))
        out = [(path, go_pid, comps, go.m_Name)]
        if transform_pid is not None:
            t = sf.objects[transform_pid].read()
            for i, ch in enumerate(t.m_Children):
                child_go = sf.objects[ch.m_PathID].read().m_GameObject.m_PathID
                name = sf.objects[child_go].peek_name()
                out += self._build_tree(sf, child_go, path + ((name, i),))
        return out

    @staticmethod
    def _export_tree(prefab: dict, go_id: str, path=()):
        go = prefab["gameObjects"][go_id]
        comps = []
        for cid in go["components"]:
            c = prefab["components"].get(cid)
            if c is None:
                comps.append((cid, "?"))
                continue
            kind = c["type"]
            if kind == "MonoBehaviour":
                kind = f"MB:{(c.get('script') or {}).get('class', '?')}"
            comps.append((cid, kind))
        out = [(path, go_id, comps, go["m_Name"])]
        for i, ch in enumerate(go["children"]):
            out += Supplementer._export_tree(prefab, ch, path + ((prefab["gameObjects"][ch]["m_Name"], i),))
        return out

    @staticmethod
    def _signature(tree) -> list:
        return [(p, name, [k for _, k in comps]) for p, _, comps, name in tree]

    def prefab(self, prefab_json: dict) -> int:
        targets = [
            (cid, c) for cid, c in prefab_json["components"].items()
            if (sc := c.get("script")) and "assembly" in sc and self.reader.has_serialize_reference(sc["assembly"], sc["namespace"], sc["class"])
        ]
        if not targets:
            return 0
        if len(prefab_json["roots"]) != 1:
            self.report["unmatchedPrefabs"].append({"prefab": prefab_json["src"], "error": f"根物件 {len(prefab_json['roots'])} 個"})
            return 0
        etree = self._export_tree(prefab_json, prefab_json["roots"][0])
        esig = self._signature(etree)
        matches = []
        for fname, go_pid in self._build_roots().get(prefab_json["gameObjects"][prefab_json["roots"][0]]["m_Name"], []):
            sf = self.reader.file(fname)
            btree = self._build_tree(sf, go_pid)
            if self._signature(btree) == esig:
                matches.append((sf, btree))
        if not matches:
            self.report["unmatchedPrefabs"].append({"prefab": prefab_json["src"], "error": "build 裡沒有階層相同的副本"})
            return 0
        # 每份副本都補一次，結果要相同
        results = []
        for sf, btree in matches:
            local = {}
            for (_, bgo, bcomps, _), (_, ego, ecomps, _) in zip(btree, etree):
                local[bgo] = ego
                for (bpid, _), (ecid, _) in zip(bcomps, ecomps):
                    local[bpid] = ecid
            inverse = {v: k for k, v in local.items()}
            out = {}
            for cid, c in targets:
                obj = sf.objects[inverse[cid]]
                data = self.reader.read_monobehaviour(sf, obj)
                out[cid] = (big_to_str(self.convert(self._fields(data), sf, local)), f"{sf.name}#{obj.path_id}")
            results.append(out)
        first = {cid: v[0] for cid, v in results[0].items()}
        if any({cid: v[0] for cid, v in r.items()} != first for r in results[1:]):
            self.report["ambiguousPrefabs"].append({"prefab": prefab_json["src"], "copies": [next(iter(r.values()))[1] for r in results]})
            return 0
        for cid, c in targets:
            c.update(first[cid])
            c["$build"] = results[0][cid][1]
            self.report["components"][c["script"]["class"]] += 1
        return len(targets)


def export_resources(reader: BuildReader, resolver: ExportResolver) -> tuple[dict, Counter]:
    """ResourceManager.m_Container：路徑 → [匯出參照或 None]（照 build 的順序）"""
    gm = reader.file("globalgamemanagers")
    rm = next((o for o in gm.objects.values() if o.type.name == "ResourceManager"), None)
    out: dict[str, list] = defaultdict(list)
    stats: Counter = Counter()
    if rm is None:
        return {}, stats
    for path, pptr in rm.read_typetree(check_read=False)["m_Container"]:
        fid, pid = pptr["m_FileID"], pptr["m_PathID"]
        ext = reader.externals(gm)[fid - 1] if fid > 0 else None
        ref = None
        if ext in BUILTIN_FILES:
            ref = {"guid": BUILTIN_FILES[ext], "fileID": str(pid)}
        else:
            sf = reader.target(gm, fid)
            if sf is not None and sf.objects.get(pid) is not None and sf.objects[pid].type.name in EXPORT_TABLES:
                ref, _ = resolver.resolve(sf, pid)
        stats["對到" if ref else "對不到"] += 1
        out[path.lower()].append(ref)
    return dict(out), stats


def export_supplement(game_data: Path, out_root: Path) -> dict:
    """要先有 assets 與 scenes 的輸出。"""
    t0 = time.time()
    reader = BuildReader(game_data)
    resolver = ExportResolver(reader, out_root)
    sup = Supplementer(reader, resolver)

    def write(path: Path, obj):
        path.write_text(json.dumps(obj, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")

    n_objects = sup.objects(out_root)
    scenes_dir = out_root / "scenes"
    index = json.loads((scenes_dir / "index.json").read_text(encoding="utf-8"))
    n_scene = n_prefab = 0
    for info in index["scenes"].values():
        if info.get("buildIndex") is None:
            continue
        p = out_root / info["file"]
        data = json.loads(p.read_text(encoding="utf-8"))
        k = sup.scene(data, f"level{info['buildIndex']}")
        if k:
            write(p, data)
            n_scene += k
    for info in index["prefabs"].values():
        p = out_root / info["file"]
        data = json.loads(p.read_text(encoding="utf-8"))
        k = sup.prefab(data)
        if k:
            write(p, data)
            n_prefab += k
    resources, res_stats = export_resources(reader, resolver)
    write(out_root / "assets" / "resources.json", resources)
    report = {
        "resources": dict(res_stats),
        "objects": dict(sup.report["objects"]),
        "objectFailures": sup.report["objectFailures"],
        "sceneComponents": n_scene,
        "prefabComponents": n_prefab,
        "components": dict(sup.report["components"]),
        "componentFailures": sup.report["failed"],
        "refs": dict(sup.report["refs"]),
        "ambiguousPrefabs": sup.report["ambiguousPrefabs"],
        "unmatchedPrefabs": sup.report["unmatchedPrefabs"],
        "resolver": dict(resolver.stats),
        "resolverProblems": resolver.problems,
        "seconds": round(time.time() - t0, 1),
    }
    write(out_root / "supplement.json", report)
    return report

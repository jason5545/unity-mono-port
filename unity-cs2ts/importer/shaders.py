"""把 shaders/convert.py 轉出的 shader 發布到 <out>/shaders/，給執行環境讀。來源是 diceomancer-web 的 scripts/import/shaders.py。

只搬執行時要的：每個 shader 的 index.json 與 .glsl（不搬 .dxbc／.asm／.spv）。另外：
  - index.json 每個 vertex 變體補上 vertexInputs：GLSL 輸入名稱 → D3D 語意（從 DXBC 的 ISGN 簽章讀，
    location 就是 register）。GLSL 的名稱（TEXCOORD、TEXCOORD_1…）是 spirv-cross 取的，不能拿來判斷是第幾組 UV。
  - shaders/index.json：shader 名稱 → 資料夾（材質用名稱找 shader，見 HANDOFF「0b」的 GUID 差異）
"""

from __future__ import annotations

import json
import shutil
import struct
from pathlib import Path


def dxbc_input_signature(dxbc: bytes) -> list[dict]:
    """DXBC 的 ISGN（或 ISG1）：[{semantic, index, register, mask, systemValue}]"""
    count = struct.unpack_from("<I", dxbc, 28)[0]
    for off in struct.unpack_from(f"<{count}I", dxbc, 32):
        tag = dxbc[off : off + 4]
        if tag not in (b"ISGN", b"ISG1"):
            continue
        base = off + 8
        n = struct.unpack_from("<I", dxbc, base)[0]
        size, skip = (24, 0) if tag == b"ISGN" else (32, 4)
        out = []
        for i in range(n):
            e = base + 8 + i * size + skip
            name_off, sem_index, sysval, _comp, reg = struct.unpack_from("<5I", dxbc, e)
            end = dxbc.index(b"\0", base + name_off)
            out.append(
                {
                    "semantic": dxbc[base + name_off : end].decode().upper(),
                    "index": sem_index,
                    "register": reg,
                    "mask": dxbc[e + 20],
                    "systemValue": sysval,
                }
            )
        return out
    return []


def publish_shaders(src: Path, out: Path) -> dict:
    rep = {"source": 0, "exported": 0, "failed": [], "glsl": 0}
    if out.exists():
        shutil.rmtree(out)
    if not (src / "report.json").exists():
        rep["failed"].append({"src": str(src), "error": "沒有轉換結果，先跑 shaders/convert.py"})
        return rep
    out.mkdir(parents=True)
    names: dict[str, str] = {}
    for d in sorted(p for p in src.iterdir() if p.is_dir()):
        rep["source"] += 1
        try:
            idx = json.loads((d / "index.json").read_text(encoding="utf-8"))
            (out / d.name).mkdir()
            for ss in idx.get("subShaders", []):
                for p in ss.get("passes", []):
                    for stage, sd in p.get("stages", {}).items():
                        for v in sd.get("variants", []):
                            files = v.get("files") or {}
                            if files.get("glsl") and (d / files["glsl"]).exists():
                                shutil.copyfile(d / files["glsl"], out / d.name / files["glsl"])
                                rep["glsl"] += 1
                            if stage == "vertex" and files.get("dxbc"):
                                sig = {s["register"]: s for s in dxbc_input_signature((d / files["dxbc"]).read_bytes())}
                                inputs = (v.get("reflection") or {}).get("inputs") or []
                                v["vertexInputs"] = [
                                    {"name": i["name"], "location": i["location"], "type": i["type"], **{k: sig[i["location"]][k] for k in ("semantic", "index")}}
                                    for i in inputs
                                    if i["location"] in sig
                                ]
            (out / d.name / "index.json").write_text(json.dumps(idx, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
            names[idx["name"]] = d.name
            rep["exported"] += 1
        except Exception as e:  # noqa: BLE001 — 失敗照實記錄
            rep["failed"].append({"src": d.name, "error": f"{type(e).__name__}: {e}"})
    (out / "index.json").write_text(json.dumps(dict(sorted(names.items())), ensure_ascii=False, indent=1), encoding="utf-8")
    return rep

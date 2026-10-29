# /// script
# requires-python = ">=3.11"
# dependencies = ["pefile>=2023", "Pillow>=11"]
# ///
"""APK 的圖示：從原版 MonsterTrain2.exe 的圖示資源（RT_GROUP_ICON 第一組）取最大那張，做成 adaptive icon 的前景 PNG。
照 diceomancer-web 的 scripts/import/app_icon.py。原版素材不進版控，所以每次組 APK 前產生（scripts/build-apk.mjs）。

用法：uv run scripts/app_icon.py
來源：MT2_GAME（預設 reference/game-win-2.2.1）的 MonsterTrain2.exe
輸出：build/apk-res/mipmap-<密度>/ic_launcher_foreground.png（android/app/build.gradle.kts 的 res.srcDirs 讀這裡；
      背景與 adaptive-icon 的 XML 在 android/app/src/main/res/mipmap-anydpi/ic_launcher.xml）

adaptive icon 的畫布 108dp，launcher 的遮罩只保證中間直徑 66dp 的圓看得到：圖示的外框（不透明像素的範圍）縮到最長邊 66dp、置中。
"""

import io
import os
import struct
from pathlib import Path

import pefile
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
GAME = Path(os.environ.get("MT2_GAME", ROOT / "reference/game-win-2.2.1"))
OUT = ROOT / "build/apk-res"
DENSITIES = {"mdpi": 1, "hdpi": 1.5, "xhdpi": 2, "xxhdpi": 3, "xxxhdpi": 4}
CANVAS_DP = 108
ICON_DP = 66

RT_ICON = 3
RT_GROUP_ICON = 14


def exe_icon(exe: Path) -> Image.Image:
    """圖示群組裡最大的那張，包成單張 .ico 交給 Pillow 解（BMP 型的圖示是沒有檔頭的 DIB，高度是兩倍：色彩＋AND 遮罩）"""
    pe = pefile.PE(str(exe))
    icons: dict[int, bytes] = {}
    group = None
    for t in pe.DIRECTORY_ENTRY_RESOURCE.entries:
        for e in t.directory.entries:
            for lang in e.directory.entries:
                d = pe.get_data(lang.data.struct.OffsetToData, lang.data.struct.Size)
                if t.id == RT_ICON:
                    icons[e.id] = d
                elif t.id == RT_GROUP_ICON and group is None:
                    group = d
    if group is None:
        raise SystemExit(f"{exe} 沒有圖示資源")
    _, _, count = struct.unpack("<HHH", group[:6])
    entries = [struct.unpack("<BBBBHHIH", group[6 + i * 14 : 20 + i * 14]) for i in range(count)]
    w, h, colors, res, planes, bits, _, icon_id = max(entries, key=lambda en: en[0] or 256)
    data = icons[icon_id]
    ico = struct.pack("<HHH", 0, 1, 1) + struct.pack("<BBBBHHII", w, h, colors, res, planes, bits, len(data), 22) + data
    return Image.open(io.BytesIO(ico)).convert("RGBA")


def main() -> None:
    exe = GAME / "MonsterTrain2.exe"
    if not exe.is_file():
        raise SystemExit(f"找不到 {exe}（MT2_GAME 指到原版 build）")
    src = exe_icon(exe)
    src = src.crop(src.getbbox())
    for name, scale in DENSITIES.items():
        canvas = round(CANVAS_DP * scale)
        box = ICON_DP * scale
        k = box / max(src.size)
        icon = src.resize((round(src.width * k), round(src.height * k)), Image.LANCZOS)
        out = Image.new("RGBA", (canvas, canvas), (0, 0, 0, 0))
        out.alpha_composite(icon, ((canvas - icon.width) // 2, (canvas - icon.height) // 2))
        d = OUT / f"mipmap-{name}"
        d.mkdir(parents=True, exist_ok=True)
        out.save(d / "ic_launcher_foreground.png")
    print(f"圖示：{exe.name} {src.size[0]}×{src.size[1]} → {OUT.relative_to(ROOT)}（{', '.join(DENSITIES)}）")


if __name__ == "__main__":
    main()

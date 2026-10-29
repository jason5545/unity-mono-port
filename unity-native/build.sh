#!/bin/bash
# 建置：patch 原版 DLL（$OUT/managed 沒有或加 --patch 才做這一趟）→ 編手寫的 UnityNative → 帶它再 patch 一次、補替身 → 全部編起來
# 遊戲設定從 GAME_ENV 讀（預設 ../mt2-web/native/android.env，android.sh 讀同一份）：
#   OUT             輸出資料夾（預設 out；每款遊戲一個，patch 過的 DLL 與替身都跟著遊戲走）
#   MANAGED         原版的 Managed 資料夾
#   ENGINE_GLUE     引擎的轉接組件（glue/ 底下的資料夾，預設 glue/Facepunch/）：redirects.txt 一起進 patch
#   GAME_GLUE       遊戲自己的轉接組件（預設 ../mt2-web/native/glue/*/）
#   GAME_REDIRECTS  遊戲自己的 redirects.txt（預設 ../mt2-web/native/redirects.txt）
#   DESKTOP_NATIVE  桌面宿主要的原生函式庫（redirects.txt 的 native 留下的 P/Invoke，例如 FMOD 的 libfmodstudio.dylib）：複製到 $OUT/managed，
#                   .NET 找 DllImport 時先看呼叫端組件的資料夾
set -e
cd "$(dirname "$0")"
export DOTNET_ROOT=${DOTNET_ROOT:-$HOME/.dotnet-android/sdk}
export PATH=$DOTNET_ROOT:$PATH DOTNET_CLI_TELEMETRY_OPTOUT=1 DOTNET_NOLOGO=1
source ./game-env.sh
# 轉接組件（引擎的加遊戲的）的 redirect 加上遊戲自己的
R=(); for g in $ENGINE_GLUE; do [ -f "${g%/}/redirects.txt" ] && R+=("${g%/}/redirects.txt"); done
if [ ! -f "$OUT/managed/icalls.txt" ] || [ "$1" == "--patch" ]; then
  # 還沒有手寫的 UnityNative.dll：internal call 全部轉過去，給下一步編手寫的引擎參考
  dotnet run --project patcher -c Release -- "$MANAGED" "$OUT/managed" "${R[@]}" $GAME_REDIRECTS
fi
# 各專案的 csproj 預設參考 out/managed、out/hand；換成這款遊戲的（game-env.sh）
engine_props
dotnet build engine -c Release "${P[@]}" -o "$OUT/hand" -v q -nologo -clp:NoSummary
# 帶手寫的 UnityNative.dll 從原版再 patch 一次：沒有手寫實作的 internal call，本體直接寫成替身（手機上就是這一步）。檔案沒變就不寫
dotnet run --project patcher -c Release -- "$MANAGED" "$OUT/managed" --hand "$OUT/hand/UnityNative.dll" "${R[@]}" $GAME_REDIRECTS
for g in $ENGINE_GLUE $GAME_GLUE; do dotnet build "$g" -c Release "${P[@]}" -o "$OUT/glue" -v q -nologo -clp:NoSummary; done
cp "$OUT"/glue/Glue.*.dll "$OUT/managed/"
[ -n "$DESKTOP_NATIVE" ] && cp $DESKTOP_NATIVE "$OUT/managed/"
dotnet build host-desktop -c Release "${P[@]}" -o "$OUT/desktop" -v q -nologo -clp:NoSummary

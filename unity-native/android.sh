#!/bin/bash
# Android：建置引擎 → 組 APK → adb 安裝 → （第一次或加 --data）把遊戲資料推到手機 → 開起來。
# 用法：./android.sh [--data] [--no-run] [--shot 輸出.png [--at 格數]]
#   --shot：開起來之後等遊戲跑到第 N 格（--at，預設 900；看 files/log.txt 每 300 格的報告），截圖拉回 Mac，然後按 Home 回桌面
#   遊戲設定從 GAME_ENV（預設 ../mt2-web/native/android.env，game-env.sh）讀：APP_ID、APP_TITLE、APP_RES／APP_PREPARE／APP_ICON（圖示）、GAME_DIR、DATA_DIR、
#   AUTO_CLICKS（啟動時的自動點擊）、ANDROID_NATIVE_DIR／ANDROID_JAR_DIR（遊戲帶的原生函式庫與 jar 的資料夾，例如 FMOD）
#   多台裝置時用 ANDROID_SERIAL 指定
# 手機上的位置（外部 app 空間，adb 推得進去、app 不用權限就讀得到）：
#   /sdcard/Android/data/<APP_ID>/files/game：匯入器輸出裡引擎會讀的 assets、scenes、shaders
#   /sdcard/Android/data/<APP_ID>/files/data：原版 *_Data 的 app.info、ScriptingAssemblies.json、RuntimeInitializeOnLoads.json、
#     StreamingAssets（*.bundle 只放 0 位元組佔位檔：引擎照 addressables.json 對到匯入的素材，不讀 bundle 檔，但原版會先確認檔案存在）；
#     影片（StreamingAssets 最上層的 *.mp4，VideoPlayer 用 MediaCodec 播）另外推：每次都比大小，手機上沒有或不一樣才推
set -e
cd "$(dirname "$0")"
export DOTNET_ROOT=${DOTNET_ROOT:-$HOME/.dotnet-android/sdk}
export PATH=$DOTNET_ROOT:$PATH DOTNET_CLI_TELEMETRY_OPTOUT=1 DOTNET_NOLOGO=1
export GAME_ENV=${GAME_ENV:-../mt2-web/native/android.env}
source ./game-env.sh
PUSH_DATA=0; RUN=1; SHOT=; AT=900; FIX_OWNER=
while [ $# -gt 0 ]; do
  case "$1" in
    --data) PUSH_DATA=1 ;;
    --no-run) RUN=0 ;;
    --shot) SHOT=$2; shift ;;
    --at) AT=$2; shift ;;
  esac
  shift
done

./build.sh
engine_props
# 遊戲要的原生函式庫與 Java 函式庫（ANDROID_NATIVE_DIR 裡的 *.so、ANDROID_JAR_DIR 裡的 *.jar，例如 FMOD）：傳絕對路徑的資料夾，csproj 用萬用字元收
[ -n "$ANDROID_NATIVE_DIR" ] && P+=(-p:GameNativeDir="$(cd "$ANDROID_NATIVE_DIR" && pwd)")
[ -n "$ANDROID_JAR_DIR" ] && P+=(-p:GameJarDir="$(cd "$ANDROID_JAR_DIR" && pwd)")
# 圖示：APP_PREPARE 先產生（例如從原版 exe 抽圖示），APP_RES 列的資料夾（Android 的 res 結構）合併後帶進 APK，manifest 用 APP_ICON
RES_ARGS=()
if [ -n "$APP_RES" ]; then
  [ -n "$APP_PREPARE" ] && (eval "$APP_PREPARE")
  RES=$PWD/host-android/obj/gameres; rm -rf "$RES"; mkdir -p "$RES"
  for d in $APP_RES; do cp -R "$d"/. "$RES"/; done
  RES_ARGS=(-p:AppRes="$RES" -p:AppIcon="${APP_ICON:-@mipmap/ic_launcher}")
fi
dotnet build host-android -c Release -p:ApplicationId="$APP_ID" -p:ApplicationTitle="$APP_TITLE" "${P[@]}" "${RES_ARGS[@]}" -v q -nologo -clp:NoSummary
APK=$(ls -t host-android/bin/Release/net10.0-android/android-arm64/"$APP_ID"-Signed.apk | head -1)
echo "APK：$APK（$(du -h "$APK" | cut -f1)）"
adb install -r "$APK"

R=/sdcard/Android/data/$APP_ID/files
if [ "$PUSH_DATA" == 1 ] || ! adb shell "test -f $R/game/.complete && test -f $R/data/.complete"; then
  export COPYFILE_DISABLE=1
  echo "推遊戲資料到 $R（約 $(du -shc "$GAME_DIR"/assets "$GAME_DIR"/scenes "$GAME_DIR"/shaders | tail -1 | cut -f1)）"
  adb shell "rm -rf $R/game $R/data && mkdir -p $R/game $R/data"
  tar -C "$DATA_DIR" -cf - --no-mac-metadata --exclude '*.bundle' --exclude '*.mp4' \
    app.info ScriptingAssemblies.json RuntimeInitializeOnLoads.json StreamingAssets | adb exec-in "tar -xf - -C $R/data"
  # bundle 本身不推，但原版的 Addressables 載入前會先 File.Exists（AssetBundleProvider、Addressables 的相依檢查），沒有檔就走網路那條、載不到：
  # 推同名的 0 位元組佔位檔（10/19 手機上 battle_intro 的敵人就是這樣沒出來）
  PH=$(mktemp -d)
  (cd "$DATA_DIR" && find StreamingAssets -name '*.bundle') | while read -r f; do mkdir -p "$PH/$(dirname "$f")"; : > "$PH/$f"; done
  tar -C "$PH" -cf - --no-mac-metadata StreamingAssets | adb exec-in "tar -xf - -C $R/data"
  rm -rf "$PH"
  adb shell "touch $R/data/.complete"
  tar -C "$GAME_DIR" -cf - --no-mac-metadata assets scenes shaders | adb exec-in "tar -xf - -C $R/game"
  adb shell "touch $R/game/.complete"
  FIX_OWNER=1
fi
# 影片：SteamDeck 子資料夾那份是 Steam Deck 的編碼（FmvPathsData 照平台挑），手機走一般的，不推
for f in "$DATA_DIR"/StreamingAssets/*.mp4; do
  [ -f "$f" ] || continue
  n=$(basename "$f")
  if [ "$(adb shell stat -c %s "$R/data/StreamingAssets/$n" 2>/dev/null | tr -d '\r')" != "$(wc -c < "$f" | tr -d ' ')" ]; then
    echo "推影片 $n（$(du -h "$f" | cut -f1)）"
    adb push "$f" "$R/data/StreamingAssets/$n" >/dev/null
    FIX_OWNER=1
  fi
done
# adb shell 是 root 時（例如 KernelSU），解出來的檔案擁有者是 root 或 Mac 的 uid，app 讀不到：改成跟套件資料夾一樣（app uid、ext_data_rw）
if [ -n "$FIX_OWNER" ] && [ "$(adb shell id -u | tr -d '\r')" == 0 ]; then
  adb shell "U=\$(stat -c %u /sdcard/Android/data/$APP_ID); chown -R \$U:1078 $R/game $R/data && chmod -R ug=rwX,o= $R/game $R/data"
fi

if [ "$RUN" == 1 ]; then
  adb shell am force-stop "$APP_ID"
  adb shell rm -f "$R/log.txt"
  adb logcat -c
  # 螢幕關著不會轉成橫的，宿主會一直等：先叫醒
  adb shell input keyevent KEYCODE_WAKEUP
  adb shell am start -n "$APP_ID/unitynative.MainActivity" ${AUTO_CLICKS:+--es clicks "$AUTO_CLICKS"}
  echo "log：adb shell cat $R/log.txt（或 adb logcat -s unity-native AndroidRuntime）"
  if [ -n "$SHOT" ]; then
    # 每 300 格一行「（N 格，…」：等到 N ≥ --at；當掉或卡住 10 分鐘就放棄
    for i in $(seq 1 300); do
      n=$(adb shell "grep -o '（[0-9]* 格' $R/log.txt 2>/dev/null | tail -1" | tr -dc '0-9')
      [ -n "$n" ] && [ "$n" -ge "$AT" ] && break
      if ! adb shell pidof "$APP_ID" >/dev/null; then echo "app 沒在跑了（當掉？）"; break; fi
      sleep 2
    done
    adb exec-out screencap -p > "$SHOT"
    echo "截圖 $SHOT（第 ${n:-?} 格）"
    adb shell input keyevent KEYCODE_HOME
  fi
fi

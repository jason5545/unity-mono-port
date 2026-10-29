#!/bin/zsh
# 產生 public/ref/rng-unity.json：把 MT2 原版反編譯的亂數類別複製進 tools/unity-ref/Assets/Mt2（不進版控），
# 用 MT2 的 Unity 版本（2022.3.62f2）batch mode 跑 RefDump.Run。第一次開專案要匯入，約 1～2 分鐘。
set -e
HERE=${0:A:h}
SRC=${HERE:h}/reference/ar-win/ExportedProject/Assets/Scripts/Assembly-CSharp
P=$HERE/unity-ref
UNITY=${UNITY:-/Applications/Unity/Hub/Editor/2022.3.62f2/Unity.app/Contents/MacOS/Unity}

rm -rf $P/Assets/Mt2 && mkdir -p $P/Assets/Mt2
for f in HadesRNG RandomState RngId RngIdExtensions MurmurHash2 RandomManager ShinyShoe/Logging/LogGroups ShinyShoe/Logging/LogOptions; do
  cp "$SRC/$f.cs" $P/Assets/Mt2/
done
cp $HERE/ref/Scenario.cs $HERE/ref/Stubs.cs $P/Assets/Mt2/
"$UNITY" -batchmode -nographics -projectPath $P -executeMethod RefDump.Run -refOut ${HERE:h}/public/ref/rng-unity.json -logFile $P/unity.log
grep -E "RefDump|error CS" $P/unity.log || { echo "Unity 沒有跑到 RefDump，看 $P/unity.log"; exit 1; }

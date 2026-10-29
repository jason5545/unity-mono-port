# build.sh 與 android.sh 共用（source）：讀遊戲設定（GAME_ENV，預設 ../mt2-web/native/android.env），補預設值，
# 定義 engine_props：各專案的 csproj 要的 MSBuild 參數（這款遊戲的 DLL 資料夾、手寫引擎的輸出、Unity 小版本的 define），放進陣列 P。
GAME_ENV=${GAME_ENV:-../mt2-web/native/android.env}
source "$GAME_ENV"
OUT=${OUT:-out}
MANAGED=${MANAGED:-../mt2-web/reference/game-win-2.2.1/MonsterTrain2_Data/Managed}
ENGINE_GLUE=${ENGINE_GLUE:-glue/Facepunch/}
GAME_REDIRECTS=${GAME_REDIRECTS-$(ls ../mt2-web/native/redirects.txt 2>/dev/null || true)}
GAME_GLUE=${GAME_GLUE-$(ls -d ../mt2-web/native/glue/*/ 2>/dev/null || true)}

# patch 過的 DLL 要先有（$OUT/managed）才算得出 define
engine_props() {
  P=(-p:ManagedDir="$PWD/$OUT/managed" -p:HandDir="$PWD/$OUT/hand")
  # Unity 小版本之間 UnityEngine 的型別不一樣（MT2 是 2022.3.62、Diceomancer 是 2022.3.3）：引擎手寫的部分用到、這款遊戲沒有的型別，定義 NO_<型別>
  local D=() t
  for t in InstantiateParameters ParticleSystemBakeMeshOptions; do cat "$OUT"/managed/UnityEngine*.dll | grep -qa "$t" || D+=("NO_$t"); done
  # 多個用 %3B 接（-p: 的值裡逗號、分號都會被當成分隔，%3B 由 MSBuild 還原成分號）
  P+=(-p:UnityDefines="$(printf '%s%%3B' "${D[@]}")")
}

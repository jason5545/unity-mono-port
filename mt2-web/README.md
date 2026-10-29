# mt2-web

Monster Train 2 的網頁版移植，用工具包 [unity-cs2ts](https://github.com/jason5545/unity-cs2ts)（轉換器、匯入器、shader 轉換、執行環境）。遊戲專屬的東西放這裡：`cs2ts.json`、遊戲頁、相容層。

## 跑起來

```bash
npm install
npm run dev
```

- `index.html`：遊戲頁，照原版從 build 的第一個場景（start）開機（工具包 runtime 的 `bootGame`），之後由遊戲腳本換場景。
  `?scene=main_menu` 只載那個場景（`bootScene`，不跑開機流程）；`animate=0` 停在第一格，`text=0` 不畫文字。
  主控台的 `__report()` 列出已載入的場景、根物件、腳本例外與走到的 notPorted。
  聲音：瀏覽器規定第一次點擊或按鍵之後才出聲（之前遊戲照樣在播，只是沒聲音）；`__audio()` 列 AudioContext 狀態、正在播的聲音、混音器音量與輸出電平。
  語言：沒存過語言設定時跟瀏覽器語言（zh-TW 是正體中文），之後照遊戲設定（主選單的設定 → 其他 → 語言）。
- `rng.html`：亂數鏈的驗證頁（產生碼對 Unity 與 .NET 的標準答案）。

## Android APK（全包、離線；2026/10/17，Jason：裝到手機躺著玩）

照 `diceomancer-web` 的做法（`android/` 的 Java WebView 殼加 `scripts/build-apk.mjs`）。安裝目標只有 USB 連著的手機（測試手機，
`adb install`，套件 `com.jason5545.mt2`）。APK 內含原版素材（約 3 GB），不上傳、不放公開的地方、不傳給別人。

```bash
node scripts/build-apk.mjs          # vite build 程式碼 → Gradle 組 APK → adb install → 清掉手機上的程式碼覆蓋檔
node scripts/build-apk.mjs --code   # 只改程式碼時：推程式碼到 app 的覆蓋資料夾、重開 app，不重裝 APK
node scripts/build-apk.mjs --no-install   # 只組 APK
```

- 先要有 `public/game/`（`npm run import`）與產生碼（`npm run port`）。`MT2_APK=1` 時 vite 不複製 `public/`，素材由 Gradle 直接從 `public/` 打包。
- 觸控用原版的：MT2 原版就支援觸控，網頁的 pointer 事件照滑鼠送，殼不另做翻譯。返回鍵送 Esc。
- 手機才有的處理（10/18，Jason 實機確認，都在 `main.ts`）：
  - 上下滑動：原版只有滾輪跟搖桿。滑一下送一次滾輪，戰鬥換一層、地圖換一段（走原版的 `HandleScrollWheel`）；按在卡片、手牌區、ScrollRect 上照原本拖曳。
    滾輪本身以前也沒接上（原版在 `OnGUI` 讀 `Event.current`，執行環境不叫 `OnGUI`），現在桌面滾輪一樣能換樓層、捲地圖，一格當 3（未查證，照 RoomUI 的 2.94 推）。
  - 戰場的上下箭頭（`RoomUI` 的 scrollUpButton、scrollDownButton）照原版留著（10/19 Jason：MT1 的 Android 版也有），滑動與箭頭都能換樓層。
  - 螢幕圓角：原版沒有 safe area，手機上只有 HUD 右上角的設定齒輪被圓角裁到。齒輪與頂端資訊列的右緣一起往內挪（測試手機 約 74 px），畫面其他地方照樣延伸到底。
    圓角半徑從殼的 `MT2App.safeInsets()` 讀；殼改過，要重裝 APK。
- 圖示是原版 `MonsterTrain2.exe` 的（`scripts/app_icon.py`，`MT2_GAME` 預設 `reference/game-win-2.2.1`），透明處墊黑底。app 名稱用官方英文名。
- 解析度照手機版（10/18，Jason 參考 MT1 的 Android 版）：UA 帶 Android 時畫布填滿螢幕、用原生像素（測試手機 2608×1200），設定裡沒有解析度與全螢幕模式。
  MT2 原版只有 Steam／Standalone 兩種平台服務（`HasFixedResolution` 都是 false），`main.ts` 讓它在 Android 回 true，走 `GraphicsSettingsManager` 原本「平台解析度固定」的分支；
  寬於 2:1 的畫面原版自己會換排法（`GameObjectUtil.ConfigureAspectFitter`）。桌面照舊 16:9 補黑邊，解析度選單照舊列出，但 `Screen.SetResolution` 還是空的，選了不會變。
- 垂直同步與目標幀率（10/18）：主迴圈照 `QualitySettings.vSyncCount` 與 `Application.targetFrameRate` 節流（工具包 `viewer/framePacing.ts`，桌面 Unity 的規則：
  1 跟著更新率、2 減半，0 照目標幀率）。螢幕更新率 APK 問殼（`MT2App.refreshRate()`，殼替視窗選的最高顯示模式），其他量 rAF 的間隔。
  Android 走固定解析度的分支時原版不建目標幀率清單，`main.ts` 照 `RefreshResolutions` 的規則補（120 Hz：120、75、60、30、20）。殼改過，要重裝 APK。

## 原版資料（都不進版控，在 reference/ 與 public/game/）

1. 原版：Windows 2.2.1（Unity 2022.3.62f2，Mono）。macOS Steam 在 MT2 的相容性設定指定 NotProton 就會下載 Windows 版；下載完 `cp -c -R` 到 `reference/game-win-2.2.1`，再把 Steam 換回 Mac 版（拿掉 `~/Library/Application Support/Steam/config/config.vdf` 裡 `CompatToolMapping` 的 2742830，Steam 要先關掉）。
2. AssetRipper：`dotnet ../../MT2/AssetRipper/Source/AssetRipper.CLI/bin/Release/AssetRipper.CLI.dll reference/game-win-2.2.1 reference/ar-win --decompile-game-only --shader-yaml`
3. `npm run import`（素材、場景樹、字形、StreamingAssets、閉包打包；只重跑 assets 或 scenes 時要再跑 `npm run import -- packs`）、`npm run shaders`（DX11 → GLSL）、`npm run hierarchy`（繼承鏈）、`npm run port`（整個 Assembly-CSharp 與 uGUI 一起轉，產生到 `src/csport/gen`，不進版控）。

## 結構

- `src/csport/gen/`：產生碼，不要手改，不進版控（`npm run port` 重產）。
- `src/csport/runtime.ts`：MT2 的相容層：re-export 工具包的 csport（core、dotnet、unity、steamworks），只放 MT2 用到、工具包沒有的 DLL（ShinyShoe 改過的 Spine）。
- `src/rng-check.ts`、`tools/ref`、`tools/dotnet-ref`、`tools/unity-ref.sh`：亂數鏈的標準答案（Unity 2022.3.62f2 與 .NET）。

## 2026/10/16 狀態

- 從 start 開機：AppManager 生出 24 個管理器（DontDestroyOnLoad），StartGame、ScreenManager 開始跑；還沒走到 IntroStart 與主選單，
  卡在各管理器的初始化（DOTween、Addressables、Ink、AudioMixer…還沒有相容層）。`__report()` 看目前走到哪。
- 跟原版的差異（平台逼的）：沒有 Steam（Facepunch.Steamworks 回答成離線、本機玩家、沒有 DLC，`setSteamDlcOwned` 可改）；
  不連開發商的後端；原生程式庫（user32.dll 等）一律回預設值；存檔在瀏覽器的 IndexedDB。

## 2026/10/15 狀態

- 主選單（main_menu）用原版資料畫出來：背景、建築、按鈕、文字（TMP，K3 管線轉的 shader）。還沒有：Shader Graph 的 UI 特效（熔岩、傳送門，繪製端「沒有可畫的 pass」）、UIParticle 粒子、Timeline、遊戲自己的腳本（MainMenuScreen 等，要用轉換器轉）、在地化（Localize 元件）。
- 原本拿來匯出的 `../../MT2/GameSource` 是 1.3.1（2 月），Steam 上是 2.2.1（5 月）；10/15 起全部改用 2.2.1。


- 亂數鏈（MurmurHash2、HadesRNG、RandomState、RngIdExtensions、RandomManager）共 269 筆：
  - 對 Unity 2022.3.62f2 的標準答案：269/269 相同。`UnityEngine.Random` 的 Xorshift128 實作（`runtime.ts` 下半）已經驗證，包括初始化、`Range(int)` 取餘數與 `min > max`、`Range(float)` 的 `t·min + (1−t)·max`（float 位元一致）。
  - 對 .NET 標準答案：269/269 相同。
  - MurmurHash2 跟原版 DLL 相同，10/10。
- Unity 授權綁機器：從舊 Mac 搬來的授權檔會驗證失敗（機器序號不同），要在 Hub 重新啟用個人授權。

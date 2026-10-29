# unity-mono-port

把 Mono 版 Unity 遊戲移植到網頁的工具包，和用它移植的遊戲，放在同一個 repo。

| 資料夾 | 內容 |
|---|---|
| `unity-cs2ts/` | 工具包：C# → TS 轉換器、素材匯入器、shader 轉換、執行環境 |
| `mt2-web/` | Monster Train 2 的網頁版 |
| `unity-native/` | 原版的 Mono DLL 直接跑在 .NET／CoreCLR 上，UnityEngine 的原生半邊手寫（MT2 的原生版；其他遊戲從外面用 `GAME_ENV` 接） |

子資料夾彼此之間用相對路徑（例如 `mt2-web` 的 `../unity-cs2ts`），clone 之後不要改資料夾名稱。
各子專案的說明與指令在各自資料夾的 README 裡。README 與註解是開發紀錄，照原樣保留，裡面提到的本機路徑、Diceomancer（另一款用這套工具移植的遊戲，不在這個 repo）照當時的狀況寫。

這個 repo 只有工具與手寫的程式，不含任何遊戲檔案：原版 DLL、素材、反編譯的原始碼、轉換器產生的程式碼（`src/csport/gen/`）都不在這裡，也不會放進來。要用就自己買遊戲，用自己的檔案在本機轉換。

本專案與 *Monster Train 2* 的開發商、發行商無關，遊戲的商標與內容屬於各自的權利人。

## 授權

MIT，見 [LICENSE](LICENSE)。

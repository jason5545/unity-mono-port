# unity-cs2ts

把 Mono 版的 Unity 遊戲移植到網頁的工具包：遊戲邏輯、版面、美術、文字都從原版資料來，不手刻畫面。最早是 diceomancer-web 裡的轉換器與執行環境，2026/10/15 起拆出來，寫成不綁特定遊戲；遊戲專屬的東西放在各自的遊戲專案（例如 `~/GitHub/unity-port/mt2-web`），用 `cs2ts.json` 設定。

| 資料夾 | 做什麼 | 需要 |
|---|---|---|
| `converter/` | C# → TS 轉換器：反編譯的 C# 加原版 Managed DLL，用 Roslyn 語意模型產生 TS | .NET 10 SDK |
| `importer/` | 匯入器：AssetRipper 匯出 + 原版 build → 執行環境讀的 JSON 與素材（素材、場景樹、TMP 字形） | uv（自動裝 UnityPy 等） |
| `shaders/` | shader 轉換：Windows build 的 DX11 bytecode → GLSL ES 3.00（dxbc-spirv + spirv-cross，工具與 patch 見 `convert.py` 檔頭）；由匯入器的 `shaders` 步驟呼叫 | dxbc-spirv、spirv-cross、glslang |
| `runtime/` | 執行環境：場景樹、uGUI 排版、TMP 文字、Animator、three.js 繪製、通用開機流程（`src/viewer/boot.ts`） | 遊戲專案用 Vite alias 引用 `runtime/src` |
| `configs/` | diceomancer-web 的轉換器設定（diceomancer-web 還用自己那份，這份用來驗證產生檔逐字相同） | |

只適用 Mono 版的 Unity 遊戲（要有 `Managed/*.dll`），IL2CPP 不行。

## 新遊戲的流程

1. 拿 **Windows build**（shader 只有 Windows build 有 DX11 bytecode；macOS build 只有 Metal 原始碼）。macOS 的 Steam 可以用相容層工具（例如 Jason 的 NotProton）下載 Windows 版，下載完 clonefile 固定一份，再把 Steam 換回原本的版本。
   AssetRipper 乾淨匯出（不要用改過的 Unity 專案）：`dotnet AssetRipper.CLI.dll <遊戲> <輸出> --decompile-game-only --shader-yaml`
2. 遊戲專案放 `cs2ts.json`（轉換器欄位見下方，加 `import` 段見 `importer/run.py` 檔頭）。
3. `uv run <工具包>/importer/run.py`：素材、場景樹、字形、StreamingAssets、開機與各場景閉包的打包（packs）；`uv run <工具包>/importer/run.py shaders`：shader 轉換與發布。
4. `dotnet run --project <工具包>/converter -- --hierarchy <out>/scenes/hierarchy.json`：MonoBehaviour 的繼承鏈（執行環境幫遊戲的子類別找基底的實作，例如 `GameUISelectableButton : Button` 用 Button 的）。
   `dotnet run -c Release --project <工具包>/converter -- <目標> '*'`：整個組件一起轉（建議；跨類別的呼叫直接走產生碼，相容層只剩引擎與 .NET）。
5. 遊戲頁用 `runtime/src/viewer/boot.ts` 的 `bootGame` 照原版從 build 的第一個場景開機（物件庫預載依賴、System.IO 的虛擬檔案系統、遊戲腳本 SceneManager.LoadScene 換場景），
   或 `bootScene` 只看單一場景。產生的類別經 `BootOptions.registry` 註冊（`genRegistry`），列舉名字表用 `registerEnums`。

runtime 的單元測試（`cd runtime && npx vitest run`）期望值是照 Diceomancer 的資料算的，預設讀 `~/GitHub/diceomancer-native/public/game`（跟 unity-port 同一層）（`CS2TS_TEST_GAME`、`CS2TS_TEST_REF` 可改）。2026/10/15 搬過來時 32 檔 271 項全過。

# 轉換器（converter/）

## 用法

```bash
dotnet run --project ~/GitHub/unity-port/unity-cs2ts/converter -- --config <設定檔> [--out <資料夾>] [--diag] <目標> <類別名或群組名…>
```

- `--config`：沒給就從目前目錄往上找 `cs2ts.json`。
- `--out`：蓋過目標的輸出資料夾。試轉用，不會動到目標專案。
- `--diag`：先印出編譯錯誤數，用來確認新遊戲的反編譯碼和 DLL 對得上。錯誤是 0 才表示語意模型全部解得出來。
- 類別參數：`類別` 轉整個類別；`類別:方法,方法` 只轉列出的方法，加上這些方法會呼叫到的自己的方法；`類別:-方法` 排除某個方法。
  `*`：原始碼裡的全部類別與結構（含巢狀，產生名是 `外層_內層`），扣掉目標的 `exclude`。

輸出到 `<out>/gen/<類別>.ts` 和 `<out>/gen/index.ts`，相容層是 `<out>/runtime.ts`。`runtime.ts` 不存在時當成空的處理，所有外部呼叫都會變成 `R.notPorted`。印出來的「相容層缺的名字」就是要補的清單。

## 設定檔

JSON，可以寫註解。`root` 的相對路徑以設定檔所在資料夾為準，其他欄位的相對路徑以 `root` 為準。

| 欄位 | 說明 |
|---|---|
| `root` | 目標專案根目錄，預設是設定檔所在的資料夾 |
| `csharp` | 反編譯的主組件原始碼資料夾（通常是 Assembly-CSharp） |
| `managed` | 原版 `Managed` 資料夾。`mainAssembly`（預設 `Assembly-CSharp`）不參照 DLL，改用原始碼 |
| `generator` | 產生檔檔頭寫的產生器名稱，預設 `unity-cs2ts` |
| `sourceAssemblies` | 組件名 → 原始碼資料夾。只在 target 設了 `sourceAssemblies: true` 時，用原始碼取代這些 DLL |
| `fixups` | `{file, from, to}`：修正反編譯碼的型別歧義，`file` 相對 `csharp` |
| `directTypes` | TS 端欄位跟 C# 一一對應的資料型別，屬性直接讀寫 |
| `targets.<名>` | `style`（`ui` 通用／`bucket`）、`out`、`outEnv`、`label`、`indexConst`、`groups`（群組名 → 類別或群組）、`all`（`{prefix, baseType}`）、`buckets`、`exclude`（`*` 不轉的類別：執行環境原生做的，例如 uGUI 的 EventSystem、Graphic、LayoutGroup） |

## 已有的設定

- `configs/diceomancer.json`：重現原本寫死的行為。2026/10/15 驗證過 enemies 35 個、stories 25 個、ui 116 個類別，產生檔都跟 `scripts/csport` 逐字相同。
- MT2 的設定在遊戲專案 `~/GitHub/unity-port/mt2-web/cs2ts.json`（轉換器與匯入器共用）。下面試轉段落的 `configs/mt2.json` 是當時的版本，已經移過去。

## MT2 試轉（2026/10/15）

```bash
dotnet run --project ~/GitHub/unity-port/unity-cs2ts/converter -- --config ~/GitHub/unity-port/unity-cs2ts/configs/mt2.json --out /tmp/mt2 --diag logic effects core
```

- 編譯：2731 個檔、138 個 DLL，**錯誤 0 個**。
- 轉了 11 個類別：CardState、CharacterState、CombatManager、RelicManager 等，C# 19,094 行，產生 TS 16,955 行，esbuild 語法檢查 0 錯誤。
- 轉不動 4902 處，全部是相容層缺名字（runtime.ts 是空的，缺 1614 個名字），**轉換器不支援的語法 0 處**。
  - 第一次試轉是 3526 處（缺名字 3334、語法 192）。補了語法之後，原本整段 notPorted 的 using 區塊裡面也轉出來了，缺的名字跟著變多。
- 補的語法（只在 ui 樣式，Diceomancer 的產生結果逐字不變）：
  - `using (…) { }`：區塊裡 try／finally，finally 呼叫 `R.<實作 Dispose 的型別>_Dispose`（GenericPools 是 `UsingGenericPoolObject_Dispose`）。資源的 out 變數宣告在區塊裡。
  - `?.` 接呼叫鏈（`x?.A().B(y)`）、巢狀 `a?.b?.c`、`x?.欄位.方法()`：右邊照一般運算式轉，開頭的 `.X` 以暫存變數為對象。
  - 反編譯的 `goto`：都往前跳到同一層標籤的（CharacterState.cs:1967、5214），包成 `標籤: { … }`、goto 換成 `break 標籤`。
    有往回跳或範圍交錯的（CharacterState.cs:5049 那組，IL_06b1 結尾跳回 IL_06be），整串改成 `for (;;) { switch (狀態) { case … } }`，
    每個標籤一個 case，goto 換成設狀態再 `continue`；這一層的區域變數提到迴圈外宣告。goto 從這串外面跳進來的仍然 notPorted。
  - 屬性模式 `is CovenantState { AscensionLevel: <=1 }`：型別走 `R.is_<型別>`，屬性讀取規則同一般成員存取；也支援關係、not／and／or 子模式。
  - 索引初始化 `new X { [k] = v }` 與索引子複合指定 `a[k] += v`：走 `R.<型別>_set_Item`／`get_Item`，對象與索引只求值一次。
  - 靜態自動屬性（`Instance = this`）：跟靜態欄位一樣是模組變數 `S_<名>`，列進 statics。
  - `base` 單獨當對象（`base.enabled = false`）：同 `this`。
- 試轉時修掉三個 Diceomancer 沒碰過的 bug：多載只差型別參數個數（`Get()` 和 `Get<T>()`）時函式同名、lambda 有多個捨棄參數 `(_, _)`、區域函式是迭代器。

MT2 的原始碼被 `tools/post_export_fix.sh` 補過 null guard，不是純粹的反編譯結果。

## 2026/10/15 接 mt2-web 時補的（只在 ui 樣式，Diceomancer 的產生結果逐字不變）

- uint 運算照 C# 的 32 位元無號溢位：乘法用 `Math.imul`、結果 `>>> 0`、`>>` 改 `>>>`；整數縮窄轉型 `(uint)`、`(ushort)`、`(byte)`、`(short)`、`(sbyte)`、`(int)`（從 uint／long）照 unchecked 截斷；補 `^=`、`<<=`、`>>=`。MT2 的 MurmurHash2 靠這個才算得對。
- 靜態建構子轉成 `cctor`，相容層的 `registerGen` 登記完後跑一次。C# 是第一次用到才跑，這裡提早。
- `Enum.GetValues(typeof(E))` 直接寫成成員值陣列，順序跟 .NET 一樣照無號值排。
- 同一次轉的類別的擴充方法（`rngId.IsDebugLog()`、`str.GetMurmurHash()`）：自己的直接叫，別的類別走 `R.callStatic`。

## 2026/10/16 整個組件一起轉（工具包模式；Diceomancer 的產生結果逐字不變）

轉換器：`*` 參數與 `exclude`；巢狀類別的產生名；明確介面實作（`介面$成員`）；介面屬性與索引子走產生碼；`?.` 一律走一般路徑；
泛型類別帶型別引數（`R.newGenT`、`typeof(T)` → `R.typeArg`）、泛型方法傳型別引數（`__T_名字`）、`new T()`、`is T`、`default(T)`；
列舉名字表（`gen/$enums.ts`）；Unity 會序列化的欄位清單（`serialized`）；例外物件帶型別鏈（`R.csException`、`throw;` 丟回原例外、catch 照型別比）；
`lock`；`[DllImport]` → `R.pinvoke`；原生元件（DLL 裡的 Unity 元件與 exclude 的類別）的屬性 → `R.nativeGet／nativeSet`（退回序列化欄位 m_名字）；
LINQ 的其他運算子 → `R.linq名字`（…OrDefault 帶元素型別的預設值）；Unity 物件的 `==`／隱含 bool → `R.objEq`／`R.objAlive`（假 null）；
靜態欄位照宣告順序、參照別的靜態欄位的初始式延到 cctor；JS 保留字的識別字（`@class`）、物件字面值開頭的運算式。

執行環境：一個 World 同時載入多個場景（`unity/scenes.ts`，Single／Additive、DontDestroyOnLoad、sceneLoaded 事件）；
資產物件庫（`unity/objectStore.ts`，場景的依賴閉包預載、Resources、ScriptableObject 照 Unity 反序列化實體化）；
腳本例外照 Unity 隔離（記下來、其他物件照常）；Start 排在第一次 Update 之前；靜態建構子第一次用到才跑；
相容層分檔：`dotnetBcl`（字串、格式化、數字、集合、introsort、DateTime、Path、Regex 轉譯）、`dotnetIO`（虛擬檔案系統、Stream、BinaryReader／Writer）、
`dotnetLinq`、`dotnetReflection`、`unityScene`（物件生命週期、Transform、SceneManager、Resources、Application、Time、Debug、PlayerPrefs、JsonUtility）、
`unityMath`、`unityInput`、`unityNative`（原生元件的屬性、Material、P/Invoke）、`steamworks`（選用，Facepunch.Steamworks 回答成離線的 Steam）。

## 2026/10/16 接原版開機流程（MT2 從 start 走到 intro_fmv、新手局的 map；Diceomancer 的產生結果逐字不變）

轉換器（工具包模式）：跟 System／UnityEngine 同名的原始碼類別帶 namespace；外部 DLL 型別的基底鏈（找相容名時沿 `FileStream → Stream`）；
基底是 .NET 集合的類別（`extBase`）；`[RequireComponent]`（`requires`）；`out` 參數（`R.outBox`）；`base.X()` 打到原生類別走 `R.nativeBase`；
使用者定義的轉型運算子；字串欄位描述 `$s`；覆寫 `System.Object` 的 Equals／GetHashCode／ToString 記進 `objectMethods`；
字串相加與插值裡的物件、bool、Nullable 走 `R.Object_ToString`；結構的預設值帶 `$type`；`dict[k]++`、`obj.Prop--` 走 get／set；
指定當運算式用（`x = (dict[k] = v)`）時回右邊的值；條件存取的泛型方法（`?.GetComponentInChildren<T>()`）帶型別引數；
宣告在泛型基底的欄位描述用 `$targ:i`（執行期照 `baseTargs` 換）；`foreach`、LINQ 走實作 IEnumerable 的產生類別；
LINQ 寫成靜態呼叫（`Enumerable.Concat(second:, first:)`）照擴充方法轉；覆寫的方法跟被覆寫的方法同一個產生名（子類別多了同名多載時虛擬分派才找得到）。

執行環境：ScriptableObject 照 Unity 反序列化（initAi → 建構子 → 蓋上存檔值 → OnAfterDeserialize → OnEnable）；
場景裡的 ScriptableObject 參照場景物件（AssetRipper 的 `{guid: 場景, fileID}`）在場景合併時補上；Awake／Start 的排程照 Unity；
實例事件照接收者與事件名記（透過介面訂閱跟實作類別自己發是同一個事件）；`Object.Equals`、`GetHashCode`、`ToString`、Dictionary 與 HashSet 的鍵
照 C# 的相等（覆寫、產生的結構與登記的外部值型別照值）；`cloneData` 會複製產生的結構；
實作 `IList<T>`／`IEnumerable<T>` 的產生類別有 JS 陣列的外觀（Proxy：length、索引、for…of、陣列方法照介面成員分派）；
prefab 資產本身當物件用（休眠的物件樹 `SceneGraph.dormant`：GetComponentInChildren、原生屬性、腳本方法；`==` 跟資產參照比得起來）；
原生 uGUI 控制項（Slider、Toggle、ScrollRect）的屬性與方法接到執行環境的行為，腳本 `AddListener` 的監聽在原生控制項觸發時一起叫；
VideoPlayer（`<video>`，播完發 loopPointReached）；`Match.Captures`；`Random`（跟 .NET 同一個演算法）；Uri、UnityWebRequest 的 multipart。

## 2026/10/16 開機流程走通到新手局的地圖（intro_start → 首次設定 → 開場影片 → map；Diceomancer 的產生結果逐字不變）

轉換器（工具包模式）：`List.Contains／IndexOf`、LINQ 的 `Contains` 對非基本型別照 C# 的相等（`R.listContains`／`listIndexOf`）；
方法裡會被改到的結構參數在進方法時複製（C# 傳值；DOTween 的 ColorPlugin 改了傳進來的 Color）；
目標設定加 `loopGuard`（預設關）：每個迴圈數圈數，超過一千萬圈丟例外帶 C# 位置（`R.loopRunaway`），無窮迴圈不會讓分頁當掉。

執行環境：
- 生命週期：同一批物件照 Unity 的順序，每個物件 Awake 完接 OnEnable；沒啟用的物件等第一次啟用才 Awake。
- 場景：`Scene` 是值型別，照 handle 找到同一個場景（卸載拿到的是複本時才不會刪錯）；繪製端每格照啟用中的攝影機換。
- Overlay Canvas 照 Unity 放在螢幕像素空間（位置 寬/2、高/2，縮放 scaleFactor）。腳本讀到的 `transform.position` 是像素座標，
  掛在 Overlay Canvas 底下的攝影機（MT2 的 Main Camera）也不再跟著飄；繪製端畫的時候才換到攝影機前（`drawWorld`），
  射線檢測照 `RectTransformUtility.ScreenPointToRay(null, p)`。第 2 輪裁決 4 的「Overlay 用攝影機數學排版」到此為止，排序規則不變。
- 執行期 `AddComponent` 的原生元件帶 Unity 的預設值（CanvasGroup 的 alpha 1、interactable、blocksRaycasts；AudioSource）；
  射線檢測認得原生的 CanvasGroup（以前只認 `script.class`，blocksRaycasts 關掉也照樣點得到）。
- `Screen.currentResolution`／`resolutions` 是螢幕解析度（`window.screen` × devicePixelRatio），跟視窗大小無關；`Resolution` 的 ToString。
- VideoPlayer 的 CameraFarPlane／CameraNearPlane 畫出來（`videoLayers` → `SceneRenderer.videoLayers`，照 aspectRatio、targetCameraAlpha）。
- 新的相容層：`unityTmp.ts`（textInfo、mesh、ForceMeshUpdate、UpdateVertexData）、`unityCamera.ts`（攝影機座標換算、RectTransform 的尺寸工具、
  RectTransformUtility、Plane、全域 shader keyword、RenderTexture 的描述）、Renderer 的 material／sharedMaterials、LayerMask。
- async 方法裡沒接到的例外記進 `world.exceptions`（Unity 印到 Console）。
- 虛擬檔案系統：寫進 IndexedDB 改成每段同步程式結束時每個檔案寫一次；AppendAllText 用倍增緩衝區；FileStream 的 flush 交出 view 不複製。
  以前 log 每行都整份複製再 put，一格寫幾千行時記憶體爆掉，按住 Esc 跳過開場影片會讓分頁當掉。

還沒做：PlayableDirector／Timeline（獎勵畫面的進場）、TMP 的 `<sprite>`、透視攝影機的繪製與滑鼠事件、VideoPlayer 的 RenderTexture 模式。

## 2026/10/16 存檔寫得進去、讀得回來（新存檔走到 map，重新整理後從存檔接回地圖；Diceomancer 的產生結果逐字不變）

轉換器（工具包模式）：
- C# 8 的 `using var x = …;` 宣告：後面的敘述包進 try，finally 反向呼叫 Dispose（`await using` 還沒做）。
  以前沒有 Dispose，`FileStream` 沒 flush，MT2 的存檔全部是 0 位元組。
- 區域函式產生成 `function` 宣告（區塊內提升，跟 C# 一樣可以先呼叫後宣告）；呼叫直接叫名字、方法群組傳函式本身
  （以前方法群組變成字串 `"類別.名字"`）。
- 直接基底是 DLL 型別的類別多寫一欄 `dllBases`（整條 DLL 基底鏈，例如 GameData 是 `["ScriptableObject", "Object"]`），
  執行期的 `typeNames` 照它判斷，所以認得出 ScriptableObject。

執行環境：
- `JsonUtility.ToJson`：欄位裡的 UnityEngine.Object（ScriptableObject、資產參照）照 Unity 只寫 `{"instanceID": N}`，最外層才寫欄位；
  `FromJson` 照 instanceID 換回同一次執行裡的物件，找不到就是 null。以前整份展開，MT2 新手局的存檔是 1.25 MB，現在 58 KB。
  null 欄位還是寫 `null`；Unity 會照欄位型別寫 `{"instanceID":0}`、`""`、`[]`，要有欄位型別才做得到，還沒做。
- `new StringBuilder(string, int)` 等建構子多載、`FileSystemInfo.Exists`（照實際是 FileInfo 還是 DirectoryInfo）。
- TMP Settings 照 Resources 路徑 `tmp settings` 找（寫死的 Diceomancer guid 只當備援），預設的 sprite asset 載得到了；
  `<sprite name="…">` 實際畫不畫得出來還沒驗。
- 離線的 Steam：`setSteamDlcOwned('all')` 是全部 DLC 都擁有（預設還是都沒有）。

還沒做：PlayableDirector／Timeline、透視攝影機的繪製與滑鼠事件、`CardTextReplacements.cs:492` 的屬性模式比對、走到主選單。

## 2026/10/16 `base.M` 當委派不做虛擬分派（獎勵畫面不再漏到地圖上；Diceomancer 的產生結果逐字不變）

轉換器（工具包模式）：`base.Close` 這類方法群組產生 `R.boundAs`，固定叫基底那一版（`R.callAs`），同一個實體拿到同一個函式。
以前產生 `R.boundGen`，照實際類別分派，叫回子類別自己的覆寫。MT2 的 RewardScreen.Close 把 `base.Close` 交給淡出補間的 OnComplete，
結果補間播完又叫回 RewardScreen.Close、再開一次淡出，永遠走不到 UIScreen.Close：預載完的獎勵畫面一直開著，Skip 按鈕浮在地圖上。
MT2 有 7 處（RewardScreen、UnlockScreen、SoulProgressionScreen 等）。

執行環境：Calendar 的 GetYear／GetMonth／GetDayOfMonth／GetHour／GetMinute／GetSecond 與 ToDateTime（文化固定是公曆）。

Timeline 的盤點（還沒做）：MT2 有 25 個畫面的 `screenTransition` 接 TimelineTransition（含 main_menu、deck、merchant、relic_draft、card_draft），
開畫面播 introDirector，關畫面等 outroDirector 的 `stopped` 才 SetActive(false)。43 個 .playable 用到的 track 只有遊戲自己寫的
TransformTween、CanvasGroupFade、TransformScaleTween 三種，匯出裡沒有斷掉的參照；21 個 `m_Tracks: []`，原版是不是本來就空的還沒對原始資料確認。
場景存檔有 PlayableDirector 的 `m_SceneBindings` 與 `m_ExposedReferences`。

## 2026/10/16 Timeline 與 Playables（畫面的開關動畫照原版播；Diceomancer 的產生結果逐字不變）

MT2 有 25 個畫面的 `screenTransition` 接 TimelineTransition：開畫面播 intro 的 PlayableDirector，關畫面等 outro 的 `stopped` 才 SetActive(false)。
Timeline（Unity.Timeline.dll）是 managed C#：用 ilspycmd 反編譯，放進遊戲 cs2ts.json 的 `sourceAssemblies` 整套轉；
底下的 Playables 是引擎原生的，由執行環境的 `unityPlayables.ts` 接。

匯入器：
- ScriptableObject 資產把同一個檔裡的其他物件一起匯出（`$subObjects`：fileID → `$script` 類別與欄位）。Timeline 的 .playable 是 TimelineAsset 帶著它的 track 與 clip。
- 腳本在 DLL 裡的（TimelineAsset、TMP_FontAsset…）照 m_Script 的 fileID 到 build 的 MonoScript 表反查類別（scenes.py 的 ScriptResolver）。
- glyphs 掃場景時跳過沒有 components 的 JSON（轉換器 `--hierarchy` 的 hierarchy.json）。

轉換器（工具包模式）：
- DLL 泛型型別的靜態方法（`ScriptPlayable<T>.Create`）把包含型別的型別引數接在參數後面，相容層照 T 建實體。
- 抽象屬性（`public abstract double start { get; }`）寫法像自動屬性，但沒有 backing field：讀寫照實際類別分派到覆寫的 get_／set_，宣告處不產生欄位。
  以前當成欄位，Timeline 的 RuntimeClip 區間永遠是 0；Ink 的 `Value.valueType`／`valueObject`、`Filter.AppliesToUndiscoveredCards` 也一樣讀到 undefined。
- 轉型運算子只差目標型別時（DiscreteTime 轉 double／float／long）名字帶上目標型別，不然 JS 裡重複宣告。

執行環境：
- ScriptableObject 的實體化：同檔的子物件照 fileID 建（帶 `$fileID`），資產內的同檔參照（只有 `{fileID}`）指向它。
  一次載入連帶建出來的物件欄位全部填好之後，才依序跑 OnAfterDeserialize，再跑 OnEnable（以前每個物件建好就跑，Timeline 的 track 在回呼裡經由 parent 碰到還沒填好的 TimelineAsset，把 m_Tracks 清成空的）。
- `unityPlayables.ts`：PlayableGraph、Playable、ScriptPlayable、PlayableOutput／ScriptPlayableOutput、PlayableBinding、ExposedReference、FrameData、PlayableDirector。
  照 UnityCsReference 2022.3 的原文：PlayableBehaviour 的預設方法不做事、Clone 是 MemberwiseClone；ScriptPlayable 有 template 就複製、沒有就新建 T，放進 handle 後才發 OnPlayableCreate；
  PlayableAsset.duration 預設 PlayableBinding.DefaultDuration（正無限大）；ExposedReference 先問 resolver、沒有用 defaultValue；PlayableDirector 的 played／paused／stopped。
  WrapMode None 到終點時在 duration 那一格求值一次再 Stop（Timeline 1.7.0 的 changelog：修好「最後一格不保證執行」）。
- DLL 基底的虛擬成員（PlayableAsset.duration、CreatePlayable、PlayableBehaviour.Clone）：產生類別有覆寫就叫覆寫；同一個物件在覆寫裡又叫回同一個成員，視為 `base.X`，改走 DLL 的預設（`dllVirtual`）。
  資料物件上的原生屬性可以登記（`registerNativeDataProp`）。
- World 每格在腳本的 Update（與 DOTween）之後、協程之前推進 PlayableDirector（Unity 的 Update.DirectorUpdate；`registerDirectorUpdate`）。
- Double／Int64 的 GetHashCode 照 .NET Framework 參考原始碼；`Attribute.GetCustomAttribute` 回 null（attribute 沒有轉出，同 GetCustomAttributes）。

驗證：Deck 畫面打開時 intro 在 1/3 秒內把 CanvasGroup 的 alpha 從 0 淡到 1、最後一格是 1；關畫面時 outro 0.15 秒淡到 0，播完發 stopped，畫面變 inactive。

差異清單（原生、沒有原始碼，照文件與 Timeline 的用法做，未查證）：
- graph 求值的順序：先推進播放中 playable 的時間，再 PrepareFrame（由 output 往輸入走，每個 playable 一次），再對每個 output 做 ProcessFrame（由 output 往輸入走）；
  暫停的 playable 與它的輸入不走。OnBehaviourPlay／OnBehaviourPause 在播放狀態改變後的下一次求值發；OnGraphStart 在第一次求值時發。
- 新建的 playable 是 Playing（RuntimeClip 建好後自己 Pause，看得出預設不是暫停）；duration 預設正無限大。
- Stop 之後 time 回 initialTime；GameObject 沒啟用或元件關掉的導演不推進。
- 還沒做：Play On Awake（m_InitialState，MT2 只有 minimap 用）、Animation／Audio track 的原生 playable、clip 的動畫曲線（SetAnimatedProperties）、
  TimelineAsset／TrackAsset 的 `__internalAwake`（引擎呼叫的掛勾，時機未查證。TimelineAsset 的是設 track 的 parent，存檔的 m_Parent 已經有；
  TrackAsset 的是補空的 m_Clips／m_Children、清子 track 快取，欄位初始式已經給了空清單）、
  TrackBindingTypeAttribute（binding 的 outputTargetType 是 null，導演的綁定不靠它）。

## 2026/10/16 新手局的第一場戰鬥（地圖 → battle_intro → main；Diceomancer 的產生結果逐字不變）

從地圖點戰鬥節點，照原版走 BattleIntro（標題、說明、Start Battle），按下去載入戰鬥場景 main。
戰鬥中途重新整理，存檔記著看過第一段對話，IntroFmv 照原版改走主選單（main_menu），主選單上開 CoreDialogue_010_PostFirstRun。

轉換器（工具包模式）：
- `foreach (var (a, b) in tuples)`：每個元素照 tuple 型別的元素名字取出（同解構宣告）。
- 列舉轉整數照底層型別算：`(uint)(controls - 34) <= 1u` 的 `controls - 34` 還是列舉，以前不加 `>>> 0`，負數也算在範圍內。
  MT2 的 ScreenManager.TryHandleSettingsInput 因此把每個滑鼠事件當成 Settings 鍵，點 Start Battle 就開設定選單。
- 列舉表（`$enums.ts`）對底層型別不是 int 的列舉多寫 `kind`（u8、i16…）。
- MonoBehaviour 裡單一參數的方法多寫 `msgArgs`（參數種類：f float、i int、s string、o UnityEngine.Object、e AnimationEvent，其他 ?），動畫事件照它帶值。

執行環境：
- `isInstance` 認得 JS 產生器（C# 的迭代器方法）是 IEnumerator、IEnumerator<T>、IDisposable。以前不認得，ShinyShoe 的 CoroutineController
  （EnumeratorStack.Push 檢查 `is IEnumerator<object>`）把每個協程默默丟掉：SaveManager 的續關（ContinueRunWithReplay）沒跑，存檔停在 BattleIntro 時卡在 intro_fmv 的黑畫面。
  `IDisposable.Dispose` 對產生器是 `generator.return()`（跑停在那裡的 finally，同 C# 編譯器產生的 Dispose）。
- 泛型欄位的列舉陣列（RotaryHeart SerializableDictionary 的 `TKey[] _keys`）照列舉的底層型別解 Unity 的十六進位陣列。
  以前當成照原樣複製，StatusEffectsDisplayData 的字典鍵變成字串，狀態效果與觸發的圖示背景都查不到。
- Animator：沒有指定 controller（`{fileID: 0}`）就不播（Unity 也是），不再丟錯；`runtimeAnimatorController` 的 set 換掉 controller、從預設狀態重新開始。
- 動畫事件（AnimationClip 的 m_Events）：播放時間經過事件時間就對 Animator 所在物件上的腳本呼叫同名方法，參數照方法的參數型別帶
  （Unity 文件：float、int、string、Object、AnimationEvent）。事件落在（上一格, 這一格]，剛進狀態那一格含時間 0，loop 的 clip 每圈都發；
  沒有接收者而且是 RequireReceiver 時記在 notes。BattleIntro 的開場動畫靠它呼叫 HandleOpenAnimationComplete，Start Battle 才按得下去。
- Mesh：內建網格（unity default resources 的 Quad、Cube…）跟 builtin.json 一起登記，網格照 `{guid, fileID}` 找；
  `MeshFilter.mesh`（執行期複本）、`MeshFilter.sharedMesh`、`Mesh.bounds`（複本照目前頂點，設 vertices 會重算；資產照 m_LocalAABB）、`Mesh.vertexCount`。
- `new Stack<T>(IEnumerable<T>)`、`ReadOnlyCollection<T>`（List.AsReadOnly 的結果，就是那個陣列）。
- Post Processing v2 的 `PostProcessProfile.TryGetSettings<T>`：反編譯的原版是精確比型別（`setting.GetType() == typeof(T)`）。後製效果本身不畫。

匯入器：
- builtin.json 加上 unity default resources 的六個內建網格（照 pathID 讀，類型與名稱對不上就不匯出）；場景裡指向它們的參照由 verify_builtin_refs 對原始 PPtr 位元組驗過，沒有不符。
- RotaryHeart SerializableDictionary 的 `_keys`／`_keyValues` 不論長度都保留十六進位字串（byte 列舉 4 個鍵只有 8 個字 `00010203`，以前被 YAML 讀成數字 10203）。
- scenes 步驟清資料夾時留著 hierarchy.json（轉換器 `--hierarchy` 的輸出）。以前重跑 scenes 會把它刪掉，`GetComponent<TMP_Text>()` 認不出 TextMeshProUGUI。

差異清單（未查證）：
- 動畫事件在 Animator 推進之後、套用曲線之前收集，這個 Animator 更新完就派送；停用的腳本照樣收到（同 SendMessage 的做法）。
  方法有多載時先找沒有參數的，再找參數是 Unity 能帶的型別的。
- 後製效果（Bloom、ColorGrading…）不畫，設定照原版讀寫。

還沒做：Spine（spine-csharp、spine-unity，戰鬥與 battle_intro 的角色）、Febucci Text Animator（對話的打字機，主選單的對話停在「Lorem Ipsum」佔位字）、
戰鬥場景的 CardSelectionBehaviour（HandUI 是 null，每格丟例外）、透視攝影機的繪製（battle_intro 的敵人模型沒畫）。

## 2026/10/16 Spine 與 Febucci Text Animator 從原始碼轉（主選單 → 新手戰鬥；Diceomancer 的產生結果逐字不變）

mt2-web 的 sourceAssemblies 加上 spine-csharp、spine-unity、Febucci.Attributes.Runtime、Febucci.TextAnimator.Runtime、Febucci.TextAnimator.TMP.Runtime
（AssetRipper 匯出的原始碼，跟 DOTween、Ink 同一條路）。主選單的 Start 跑完，照存檔接回新手局的戰鬥：Spine 的骨架與動畫讀得進來
（PyreHeart 的 AnimationState 在播 Idle），Text Animator 的打字機不再丟例外。

轉換器（工具包模式）：
- `goto case X`／`goto default`：一段 case 的最後一句、X 正好是下一段時照 JS 的 fall-through（Spine 的 EventQueue、PhysicsConstraint，MT2 的 CharacterDialogueScreen）。
- `a[^n]`（陣列、List）：`a[a.length - n]`，對象只求值一次（Timeline 的 TimeUtility、Spine 的 DeformTimeline、DOTween 的 PathPlugin）。
- 鋸齒陣列 `new float[n][]`：外層 n 格 null。
- 屬性模式的子模式 `{ P: var x }`、`var _`（Spine 的 MeshGenerator、MT2 的 CardTextReplacements、Addressables）。
- struct 裡的 `this = default`：每個實體欄位與自動屬性回到預設值。
- `ref` 區域變數指到陣列／List 的元素：陣列與索引各存一次，讀寫換成那一格（Febucci 的 ShuffleArray）。
- char 欄位的型別描述 `$c`（YAML 存的是 UTF-16 碼，載入時換成字）；char 的預設值 `'\0'`（以前是 null）。
- `Array.Resize<T>` 把 default(T) 交給相容層：放大時新格子是新的 struct、0（以前補 null，Text Animator 的 CharacterData 陣列是 null）。
- 泛型原始碼類別的靜態方法（`StateMachine<State>.Initialize`）帶類別的型別引數（`R.callStaticT`）：方法裡的 `typeof(T)` 以前拿到呼叫端的。
- struct 型別的 out 參數被逐欄位賦值（CoreInterp.AsVector 的 `resultOut.x = …`）：方法開頭先給 default(T)。
- 巢狀類別不帶類別名寫外層的靜態欄位（GameStateManager.FtueSequenceActive 的 `IsFtueSequenceActive = true`）：R.genStaticSet（讀的時候本來就是 R.genStatic）。
- 物件初始式裡有本體的屬性（`new ICharacterNotificationsContainer { Result = listener }`）照 C# 叫 set（以前直接寫欄位，IUnifiedContainer 的 ObjectField 沒設，
  讀 Result 回 null）。同樣的寫法 MT2 有 20 個檔。
- `new List<KeyValuePair<K, V>>(dictionary)`：交給相容層的 `<型別>_toArray`（同 foreach、LINQ），元素是 `{ Key, Value }`（以前展開字典拿到 `[k, v]`，
  GameVFXManager.CleanUp 的 `item.Value` 是 undefined，VFX 物件池有東西以後 battle_intro 的 Start 丟例外）。

執行環境：
- TMP：`GetTextInfo(text)`（反編譯的 TextMeshProUGUI：SetText、重排、m_renderMode 直接設回 Render）、`GetParsedText()`；textInfo 跟 Unity 一樣是同一個物件，重排時就地換內容；
  `characterInfo[i].character` 是 char（長度 1 的字串）；`firstVisibleCharacter`、`maxVisibleCharacters`、`maxVisibleLines` 接到排版、`renderMode`、`havePropertiesChanged`。
- 場景載入時 Awake／OnEnable／Start 照場景檔的元件 fileID 由小到大（見差異清單）。新手戰鬥的 CardSelectionBehaviour 要 HandUI.Start 早於 RoomManager.Start，
  照樹的順序做不到，以前每格對 null 的 HandUI 丟例外。
- Addressables 的 key 經過對照表換成匯出的 GUID（bundle 裡的資產 AssetRipper 換了 GUID）：TrainData 的火車、CharacterData 的角色 prefab 以前載不到。
- 二進位 TextAsset（Spine 的 `.skel.bytes`）：預載依賴時抓原檔，`TextAsset.bytes` 照原檔回。
- `new Mesh()` 的資料面（vertices、uv、uv2、uv3、colors32、normals、tangents、bounds、subMeshCount、SetTriangles、SetVertices、SetUVs、SetColors、Clear、
  RecalculateBounds、RecalculateNormals、MarkDynamic）；`MeshFilter.sharedMesh` 可以設成它。長度跟頂點數不同時照 Unity 記錯誤、不寫入。
- `MaterialPropertyBlock` 與 `Renderer.SetPropertyBlock`／`GetPropertyBlock`／`HasPropertyBlock`。
- `Renderer.bounds`（MeshRenderer：網格的區域 AABB 換到世界座標）、`LightmapSettings`、`new LightmapData()`。
- 反射：`GetMethods` 照 BindingFlags.DeclaredOnly、叫的時候用實體自己的 Ctx（以前把 ai 設成元件本身）、不列建構子；`MethodInfo.ReturnType`、
  `Delegate.CreateDelegate(Type, object, MethodInfo)`；JS 函式算 Action、Func、Delegate 這些委派型別（以前 `as Action` 是 null）。
- 有多載的生命週期方法（SkeletonAnimation 的 `Update()` 與 `Update(float)`，產生名 `Update$0`）：Unity 叫的是沒有參數的那個，以前整個沒叫到
  （Spine 的 SkeletonAnimation、SkeletonGraphic、SkeletonMecanim 與 MT2 的 DelayForFrames）。
- 資產的陣列與 List 欄位寫成空值（YAML 的 `additionalTriggerStages:`）時是空陣列，Unity 反序列化不會給 null。
- `MonoBehaviour.StopCoroutine(IEnumerator)`、`Enum.TryParse(Type, string, out object)`、`Color32.LerpUnclamped`、`Convert.ToUInt64(char)`、`bool.CompareTo`。
- `CustomYieldInstruction.keepWaiting`（產生碼讀 DLL 的抽象屬性）：WaitUntil／WaitWhile 照條件，產生的子類別照覆寫（ShinyShoe 的 ManualCoroutine）。
- `Canvas.pixelRect`；TMP 的 `TMPro_EventManager.TEXT_CHANGED_EVENT`（FastAction 的 Add／Remove／Call）。
- CanvasRenderer 的 `SetMesh`／`GetMesh`、`SetMaterial`（兩種多載）／`GetMaterial`、`SetTexture`、`SetAlphaTexture`、`Clear`、`materialCount`、`GetColor`／`SetColor`，
  照 UnityCsReference 2022.3 的 CanvasRenderer.bindings.cs（`SetMaterial(material, texture)` 是 materialCount 至少 1、材質放第 0 格、再 SetTexture）；
  `CanvasRenderer.cull` 讀 RectMask2D 的剔除結果；`Graphic.canvasRenderer`（GetComponent，沒有就 AddComponent，同反編譯的 Graphic.cs:172）；
  `Canvas.referencePixelsPerUnit` 讀排版端照 CanvasScaler 算好的值。地圖上的 SkeletonGraphic 以前 Awake 斷在 SetTexture，之後每格對 null 的 AnimationState 丟例外。

匯入器：
- assets 步驟多寫 `addressables.json`：解原版 catalog.json（照 Unity.Addressables 原始碼的 ContentCatalogData.CreateLocator），Hash128 key 照 internal id
  （原專案的資產路徑）找匯出的 .meta；路徑找不到時同資料夾、同檔名、換過副檔名（.wav → .ogg、.shader → .asset、.fbx → .prefab）只有一個候選才算。
  3680 個對到 3677 個，對不到的是匯出裡沒有的兩個 SkeletonData 與一個 `(Clone)` prefab。也可以單獨跑 `run.py addressables`。
- texts 收 `.bytes` 與 `.json`：解不開 UTF-8 的與 `.bytes` 另存原檔 `texts/<guid>.bytes`（972 個、19 MB）。

差異清單：
- 場景載入的 Awake／Start 順序照 build 的 pathID（AssetRipper 匯出的 fileID 就是它，UnityPy 讀 level7 對過）。Unity 文件說物件之間不保證順序，
  照載入順序是推定（未查證）；新手戰鬥能跑起來的條件跟它一致。
- TMP 的 `renderMode = DontRender` 沒有作用（繪製端照常畫，頂點照 UpdateVertexData 的掛勾蓋）；`havePropertiesChanged` 只在設的那一格是 true（Unity 是到 Canvas 重建）。
- TMP 的 TEXT_CHANGED_EVENT 只在腳本觸發的重排時發（ForceMeshUpdate、GetTextInfo、文字改了之後讀 textInfo），Canvas 每格的重建不發。
- `Canvas.pixelRect` 在 World Space 照指定的攝影機、沒有就整個螢幕（未查證）。
- `LightmapSettings.lightmaps` 從空的開始（場景自己的烘焙光照圖清單沒有讀，繪製端也不畫 lightmap），只影響 renderer 的 lightmapIndex 編號。
- `MethodInfo.ReturnType` 只分得出 IEnumerator（JS 產生器），其他一律 Void；`GetMethods` 不看 Static／Instance／Public 旗標。
- 委派的型別判斷分不出簽章。
- `Renderer.bounds` 只做 MeshRenderer；物件停用時 Unity 回什麼未查證，照樣算。
- 執行期建的網格還不畫（繪製端只畫有資產的 MeshRenderer），子網格接成一份；property block 繪製端還沒讀。sharedMesh 是執行期網格時 `MeshFilter.mesh` 回它本身（Unity 會不會另複製未查證）。
- char 陣列的 YAML 格式未查證，照原樣複製。
- CanvasRenderer 存的網格、材質、貼圖繪製端還沒讀（Graphic 照元件資料畫）。`Clear` 照文件「Remove all cached vertices」只丟網格，材質與貼圖留不留未查證。
- `CanvasRenderer.cull` 腳本自己設的值沒有存；`Graphic.canvasRenderer` 每次重找（Unity 記在 m_CanvasRenderer，CanvasRenderer 刪掉後回的是記著的那個）。
- `Canvas.referencePixelsPerUnit` 在 CanvasScaler 的 ConstantPhysicalSize 模式沒有乘 DPI／m_DefaultSpriteDPI（CanvasScaler.cs:334）。

還沒做：Spine 與執行期網格的繪製、透視攝影機的繪製（戰鬥場景只看得到底色）、對話打字機的實際畫面驗證；
`ParticleSystem.main`（MainModule，8 個產生檔用到：duration、loop、simulationSpeed、maxParticles、startLifetime，產生碼先複製再設回去），
新手局的敵人 prefab 載得到以後 AnimEventFx.Awake 丟例外（×3）；續關進戰鬥時原版記「ContinueRun timed out」（combatPhase 停在 Start，
新手教學的對話框開著），下一節修好。

驗證（10/16）：新存檔從 intro_start 走到地圖、battle_intro、Start Battle 進 `main`（Entered Battle Level1BattleHealers_FTUE、抽牌），
例外只剩上面的 AnimEventFx ×3；存檔在戰鬥中時主選單的 Start 跑完，照存檔接回戰鬥，例外 0。

## 2026/10/16 Time.timeScale 生效、續關接回戰鬥（Diceomancer 的產生結果逐字不變）

MT2 續關（SaveManager.ContinueRunCoroutine）把 timeScale 設成 100，照 `Time.unscaledTime` 最多等 5 秒，等戰鬥跑到玩家回合；這段時間 ReplayManager
自己按掉開著的對話框（DismissNonChoicesCoroutine：ManualCoroutine.WaitForSeconds 照 `Time.time` 等 0.5 秒，再 TryClickButton）。以前 timeScale 沒有套用、
假的點擊點不到按鈕，戰鬥停在 Start（RunCombat 在 CombatFtue.TryPyreIntroCoroutine 等對話框），記「ContinueRun timed out」。

執行環境：
- World 存 `timeScale`、`unscaledTime`、`unscaledDeltaTime`；`Time.time`／`deltaTime` 乘 timeScale（Unity 手冊 Time and frame rate management：0 的時候 Update 照叫、Time.time 不走）。
  腳本的 Update、協程（WaitForSeconds、Invoke、Destroy(t)）、補間拿縮放後的時間；Animator 的 UnscaledTime（`m_UpdateMode` 2）、PlayableDirector 的
  UnscaledGameTime 與 DSPClock 用不縮放的；ScrollRect 的慣性照 ScrollRect.cs:682 用 unscaledDeltaTime；Graphic 的顏色漸變照 TweenRunner.cs:18 看
  ignoreTimeScale（Selectable、Toggle 傳 true，`Graphic.CrossFadeColor` 照參數）。
- `BaseEventData.currentInputModule`（BaseEventData.cs:7）：啟用中的 EventSystem 同一個物件上的 BaseInputModule。
- `Object.ToString` 認得 StringBuilder（插值字串 `$"… {sb}"` 以前印出「[object Object]」）。

轉換器（工具包模式）：
- 建構子的 `: base(…)` 指到不是產生類別的基底（DLL，或設定檔 exclude 給執行環境做的 PointerEventData）：照 `new 基底(…)` 叫相容層的建構子，結果併進實體
  （`R.dllBaseInit`；基底是集合時抄內容）。MT2 的 FakePointerEventData 以前沒有 `button`，ReplayManager.TryClickButton 的假點擊被 Button.OnPointerClick 擋掉；
  Ink 的 `InkList(InkList)` 複本以前是空的。

差異清單：
- 沒有照 `Time.maximumDeltaTime` 截斷一格的時間（Unity 文件沒寫截斷在乘 timeScale 之前或之後，未查證；這裡每格固定推 1/60 秒，碰不到上限）。
  timeScale 超出範圍時 Unity 怎麼處理未查證，照設的值存。
- DSPClock 的導演當成不受 timeScale 影響的實際時間（音訊時鐘不跟 timeScale 是推定，未查證）。
- `currentInputModule` 取同一個物件上第一個啟用的模組（Unity 從中挑 ShouldActivateModule 的那個）。
- 只處理寫了 `: base(…)` 的建構子；DLL 基底的隱含 `base()` 還是什麼都不做。

驗證（10/16）：存檔停在新手戰鬥、Pyre 介紹沒看過時續關：ContinueRun 期間 Time.time 走到約 2000 秒、unscaledTime 約 23 秒，對話框被 ReplayManager 按掉，
戰鬥進到 MonsterTurn、「ContinueRun end」，沒有逾時，例外 0。新存檔走到戰鬥後在 Pyre 介紹的對話框點 Yes Button：「Marking OneTimeMessage PyreIntro complete.」、
第 0 回合、PreCombat、MonsterTurn。

還沒做：第一回合停在 RunMonsterTurn 的 `roomUI.CenterCharacters`（「Adding player energy at start of turn」沒出現、手牌 0），下一節修好；
`ParticleSystem.main`（AnimEventFx.Awake ×3）。

## 2026/10/16 新手戰鬥的第一回合交到玩家手上（Diceomancer 的產生結果逐字不變）

第一回合依序卡在四個地方，修完之後續關與新存檔都走到 MonsterTurn、`monsterTurnPlayerHasControl` 是 true、手牌是佈署階段的
TrainStewardShield ×2 與 BanishedChamp1（Shield 的角色帶 SubtypesData_BannerUnit、勇士照 IsChampion），Pyre 介紹、佈署說明、出牌說明三個新手對話框點得掉。

執行環境：
- `MonoBehaviour.StartCoroutine` 沒碰到 yield 就跑完時回 null（Unity 文件 MonoBehaviour.StartCoroutine 明寫）。ShinyShoe 的 CoroutineController 靠它判斷
  IsRunning：Run() 同步跑完時 Stop() 先清掉 `_coroutine`，再被 StartCoroutine 的回傳值蓋回去。以前回協程物件，角色的 IsMovementDone 一直是 false，
  RoomUI.CenterCharacters 等不完。
- `RectTransform.offsetMin`／`offsetMax`（照 UnityCsReference 2022.3 RectTransform.bindings.cs:154-180 的算式讀寫）。
- `tupleItem`：見下面轉換器的 tuple。

轉換器（工具包模式）：
- 沒有初始式的靜態集合欄位是 null（C# 的預設值；`[]` 是序列化欄位的規則，靜態欄位 Unity 不序列化）。MT2 的 SubtypeManager._allData 是 `_allData ?? new List(…)`
  的快取，以前一開始就是空陣列，所有角色的 subtype 查不到：勇士不是勇士、佈署階段一張牌都不抽。
- tuple 的具名元素：C# 的名字只在編譯期，有名字的型別可能接到沒名字建的 `{ Item1, Item2 }`（CardManager.DrawDeploymentPhaseHand 的排序 lambda 寫
  `(int sortOrder, CardState cardState) first`），改成 `R.tupleItem(t, 名字, 位置)`：有這個名字照名字、沒有照位置。具名元素以前也找不到自己的位置。
- switch 的 case 區段 goto 到別的區段的標籤（CardUI.UpdateAbility 的 IL_0115／IL_028d，在 default: 的 break; 後面）：整個 switch 包成狀態機，
  標籤以後的敘述搬到外層的 case（見 SwitchGotoMachine 的註解；goto 從 switch 外面進來、區段直接宣告區域變數、要接到外面迴圈的 continue 不做）。
- 區域變數的初始式用到自己（反編譯的 `float num = !TryGetHandWidth(…, out num) ? … : Mathf.Min(num, …)`）：先宣告再指定，JS 的 let 會丟 TDZ。

差異清單：
- 實體欄位沒有初始式、也不會被序列化的集合（非 public、沒有 [SerializeField]）照舊是 `[]`，C# 是 null（這次沒動，沒碰到出問題的地方）。

驗證（10/16）：續關與新存檔各走到第一回合的玩家回合，例外只剩 AnimEventFx ×3（新存檔）；log 的「Game state has changed. Recalculating combat results
for battle previews.」之後跑的 EndTurnPreHandDiscard、room 3 的戰鬥是原版的戰鬥預覽（PreviewMode），不是回合結束。

還沒做：出牌（把單位卡拖到火車的樓層，房間在透視攝影機底下，SendMouseEvents 與繪製都還沒做）、`ParticleSystem.main`。

## 2026/10/16 出牌：透視攝影機的射線、PhysicsRaycaster、拖放（Diceomancer 的產生結果逐字不變）

新手戰鬥的玩家回合可以把卡從手牌拖到房間：Shield Steward 拖到 0 號房間的 SpawnPointUI，log 有「Played card TrainStewardShield in room 0
at a cost of 1」、單位進房間、Capacity 新手對話框點掉之後出牌協程跑完；勇士 Fel 也出得去（cost 0）。存檔裡的 replay（#4、#5 PlayCard）
續關時照原版重播出來。原版的出牌：手牌的 CardUI 收 BeginDrag（HandUI.InputDragBegin 選卡），拖到房間時 PhysicsRaycaster 打到房間與
SpawnPointUI 的 BoxCollider（GameUISelectable），放開時 SpawnPointUI 收 OnDrop（InputDragDroppedOn → CommonSelectionBehavior.PlayCard，
單位卡的 MonsterAreaTargetValidator 要放在 SpawnPointUI 上），卡收 EndDrag。

執行環境：
- 射線（engine/screenRay.ts）：Camera.ScreenPointToRay 的透視版（起點在近平面上）、WorldToScreenPoint、射線打 RectTransform 自己的平面
  （RectTransformUtility.ScreenPointToWorldPointInRectangle，UnityCsReference 2022.3）。events.ts、mouseEvents.ts 共用。
- EventSystem（engine/events.ts）：每個根 Canvas 一條射線、打各 Graphic 自己的平面，Screen Space - Camera 與 World Space 掛透視攝影機的 Canvas
  都打得到（MT2 戰鬥的三台攝影機都是透視的，手牌以前完全點不到）。GraphicRaycaster.Raycast（反編譯 UnityEngine.UI.dll）的 viewport 外整個
  Canvas 不算、比 farClipPlane 遠的不算、ignoreReversedGraphics 也照做。PhysicsRaycaster：事件攝影機是同物件的 Camera、射線長度
  |(far − near) ÷ ray.direction.z|、圖層是 cullingMask & m_EventMask。排序照 EventSystem.RaycastComparer：不同 Raycaster 先比事件攝影機的
  depth（大的在前），再比 sortOrderPriority、renderOrderPriority、sorting layer、sorting order、同一個根的繪製順序、距離。
- 放開照 StandaloneInputModule.ReleaseMouse（MT2 的 CustomStandaloneInputModule 直接用它）：pointerUp → click → 有在拖就對放開處往上第一個
  IDropHandler 送 drop → pointerDrag 收 endDrag。產生的腳本接上 OnBeginDrag／OnDrag／OnEndDrag／OnDrop／OnInitializePotentialDrag／OnScroll
  （明確介面實作也算），事件資料帶 position、pressPosition、scrollDelta、useDragThreshold（送完寫回事件系統那一份）。
- 3D 碰撞器的射線（engine/raycast3d.ts）：BoxCollider（有方向的盒子，跟著節點的縮放與旋轉）、SphereCollider（半徑乘最大的世界縮放）；
  起點在碰撞器裡面的不算、觸發器也算（Unity 手冊 Physics.RaycastAll、queriesHitTriggers 預設 true）。腳本的 Physics.Raycast 也改用它
  （以前一律打不到；MT2 的 InputManager.GetGameComponentAtScreenPos 讀 hit.transform）。
- 2D 碰撞器（mouseEvents.ts）：射線打碰撞器所在的 z 平面，交點在攝影機 [near, far] 深度內才算，透視攝影機也行。
- ParticleSystem.main（csport/unityParticles.ts）：MainModule 是包住粒子系統的 struct，改複本就是改粒子系統。屬性照編輯器
  InitialModuleUI.cs 的欄位對應讀寫元件資料（duration ↔ lengthInSec、loop ↔ looping、simulationSpace ↔ moveWithTransform、
  maxParticles ↔ InitialModule.maxNumParticles…）；MinMaxCurve 照 ParticleSystemStructs.cs 與 SerializedMinMaxCurve.cs（scalar 是
  constantMax，曲線模式下是倍率；minScalar 是 constantMin）。新存檔的 AnimEventFx.Awake ×3 例外沒了。
- `new MemoryStream(byte[]…)` 照 .NET 包住呼叫端的陣列（不複製）、容量固定（超出丟 NotSupportedException）。以前複製一份，MT2 的
  ReplayManager.SerializeEntry 寫進 recordBytesBuffer 後轉 Base64 拿到的全是 0，續關記「Replay playback error: Unknown type 0 at pos 0」。
- 場景元件的 ctx 第一次被 w 是 null 的呼叫端（靜態方法、資料物件）叫到時，退回作用中的 World。以前拖卡經過房間時 Signal 的監聽者叫到
  還沒建 ctx 的 CharacterUI，記「ctxOf CharacterUI：場景元件要有 World」。

轉換器（工具包模式）：
- 泛型類別的使用者定義運算子：呼叫端照宣告（OriginalDefinition）取名。WeakRef<T> 的 `op_Implicit(T)` 產生的是 `op_Implicit$T`，
  呼叫端以前寫 `op_Implicit$CharacterState`，出牌時協程丟「WeakRef$1 沒有轉出靜態方法」。mt2-web 的產生檔只有 8 個呼叫端改了。

mt2-web：`window.__drag(points, n)`（按住左鍵沿折線拖過去再放開，每步推 2 格）。

差異清單：
- 正交攝影機的射線起點照舊放在攝影機平面上（不加 near）；Graphic 與 2D 碰撞器的距離都從這裡量，比大小不受影響，只有「起點後面的不算」在
  近平面以內不一樣。透視攝影機照 Unity 放在近平面上。
- RaycastComparer 最後比的 index（加進結果的順序）用繪製順序代替；Overlay 的 renderOrderPriority 用根 Canvas 的階層順序代替 renderOrder。
- 3D 碰撞器只做 BoxCollider、SphereCollider；CapsuleCollider、MeshCollider（main 場景有 1 個）、TerrainCollider、WheelCollider 打不到（記 note）。
  Physics2DRaycaster 沒做。
- MemoryStream 包住一般陣列（R.newArray 產生的 byte[]）時，串流讀的是建立當下的複本：建立之後呼叫端直接改陣列，串流讀不到（寫入會同步回陣列）。
- MinMaxCurve 從序列化轉成託管 struct 時，常數模式的曲線是 null、曲線模式的常數是 0，照建構子，原生轉換的細節未查證。

驗證（10/16）：
- vitest：engine/raycast.test.ts（透視射線、Box／Sphere、PhysicsRaycaster 的進出、攝影機 depth 排序、放開順序）、csport/unityParticles.test.ts、
  dotnetIO.test.ts（MemoryStream 包住陣列）、dllBase.test.ts（ctxOf 退回作用中的 World）；全部 47 檔、345 個測試過。
- 瀏覽器：新存檔從頭走到新手戰鬥，例外 0；拖出 Shield Steward 與 Fel；續關的 replay 重播兩張卡，例外 0。

還沒做：
- 第三張卡（另一張 Shield Steward）拖到 0 號房間是 RoomFull（lastSelectionError 4，原版規則），要先按 Up 換樓層；Up 按鈕現在被勇士頭上
  DetailsUIRoot 的 Coffee UIParticle 擋住：UIParticle 把 raycastTarget 覆寫成永遠 false，但 Coffee.UIParticle 沒有轉，EventSystem 照序列化欄位
  當成會擋射線的 Graphic。
- 戰鬥畫面的繪製（透視攝影機、Spine、執行期網格）、拖曳中的目標線、End Turn 之後的戰鬥。粒子的其他模組與模擬。

## 2026/10/16 換樓層、第三張卡、End Turn（hud 場景載入；Diceomancer 的產生結果不受影響）

新手戰鬥的三張卡都出得去：0 號房間被 Shield Steward 和勇士 Fel 佔滿之後（RoomFull，原版規則），按 Up 換到 1 號樓層，第三張 Shield Steward
放進 1 號房間（Replay #6）。按 End Turn 進到 MonsterTurnQueueClear → HeroTurn → Combat → EndMonsterTurn，英雄開始進場、新手對話框跳出來，例外 0。
續關的 replay 把 #4～#6 三張卡照原版重播。

執行環境：
- EventSystem 讀 Graphic 的 `raycastTarget` 改成虛擬屬性：元件的產生類別覆寫了 getter 就照它（`componentVirtualGet`，csport 載入時用
  `setComponentVirtualGet` 登記給 engine）。Coffee UIParticle 覆寫成永遠 false，以前照序列化欄位當成會擋射線的 Graphic，勇士頭上的觸發圖示
  擋住了換樓層的 Up 按鈕（DetailsUIRoot 的 sortingOrder 3 比 RoomUI 的 0 高）。
- ParticleSystem 的其他模組（emission、trails、textureSheetAnimation、subEmitters…共 22 個）：跟 MainModule 一樣是包住粒子系統的 struct，
  `enabled` 照序列化的 XModule.enabled；Emission 的 rateOverTime／rateOverDistance／burstCount、TextureSheetAnimation 的格數與 frameOverTime
  （UVModule：numTilesX ↔ tilesX、animation ↔ animationType、cycleCount ↔ cycles、spriteCount ↔ sprites 的長度）、Trail 的幾個基本屬性、
  SubEmittersModule.subEmittersCount 與 GetSubEmitterSystem。UIParticle.OnEnable 的 CheckTrail 讀 trails.enabled。

mt2-web：
- Coffee.UIParticle 從原始碼轉（UIParticle、UIParticleOverlayCamera）。轉不動的 6 處在粒子播放時的 UpdateMesh（GetParticles、BakeMesh…）與
  mainTexture 的 sprite 分支，粒子還不會播，碰不到。
- 匯入設定加 `int32ArrayKeys`：screensToAlwaysLoadAndKeepLoaded、activeInStates。只有一兩個元素的 `List<列舉>` 被 Unity 寫成 8～15 個字元的
  十六進位，YAML 會讀成數字：ScreenManager 的「0e000000」（[Hud]）被讀成 0.0，hud 場景一直沒載入，CardAnimator 不在、出掉的卡沒人播動畫、
  不回物件池，蓋在手牌上擋住下一次拖曳。匯入器報告的 suspectHexKeys 列的就是這種欄位，剩下的 m_TrailVertexStreams 是位元組陣列，不是這個問題。

差異清單：
- 拿著卡經過別的樓層，RoomUI 的 _selectionDelay 到期就會把選中的樓層切過去，這是原版行為（RoomUI.Update）。測試拖曳要走得快，或先換好樓層。

驗證（10/16）：vitest 47 檔、347 個測試過（加 componentVirtualGet、粒子模組）；瀏覽器：hud 場景載入、主選單與續關例外 0；換樓層、第三張卡、
End Turn 到英雄進場，例外 0。

還沒做：
- 開機時 ManualCoroutine.Update 記一次 Error「[object Object]」：連線流程（離線，緊接著 FetchAuthorizationToken failed）裡某個協程 yield 了
  我們沒有型別的物件，還沒查是哪個。
- End Turn 之後的新手對話框與英雄回合、戰鬥結算之後的流程；戰鬥畫面的繪製。

## 2026/10/17 戰鬥畫面：built-in 管線的多台攝影機、透視、Spine、內建 shader、天空盒（Diceomancer 不受影響）

新手戰鬥畫得出來了：GameCamera 透視畫火車、房間、Spine 角色、地景與天空盒，UICamera 只清深度、畫 UI 層的 Canvas，Overlay 的 HUD 疊在最上面。
以前繪製端只用一台正交攝影機（照 Diceomancer 的 URP 2D 寫的），戰鬥場景挑到 CardTrailCamera，整個畫面是黑的。
Diceomancer 用自己那份執行環境（diceomancer-web/src/runtime）與 shader 腳本，這次的改動碰不到它；轉換器沒有改。

執行環境（繪製端）：
- 繪製管線分兩條（`SceneRendererOptions.pipeline`，boot 照專案設定選，`cameraStack.renderPipelineOf`）：品質等級與 GraphicsSettings 都沒有
  自訂管線時是 built-in（MT2），否則照舊走 URP 2D 那條。
- built-in 的攝影機（render/cameraStack.ts）：啟用中、沒有 targetTexture 的攝影機照 depth 由小到大畫，各自的 viewport、clearFlags
  （Skybox／Solid Color／Depth only／Don't Clear）、cullingMask、透視或正交投影。蓋滿畫面的清除之前的攝影機不畫（結果一樣，省時間）。
  Screen Space - Camera 的 Canvas 只由指定的攝影機畫，World Space 照圖層，Overlay 另一趟最後畫（投影直接用螢幕像素，不再換到攝影機前）。
  每一趟各自排序：不透明（render queue ≤ 2500）照 queue、由近到遠；天空盒；透明照 sorting layer → order → queue → 由遠到近
  （透視攝影機照到攝影機位置的距離，GraphicsSettings 的 TransparencySortMode Default）。K3 shader 的 cbuffer 每一趟照那台攝影機重填。
- 深度：built-in 照 pass 的 ZTest／ZWrite（可綁材質屬性，例如 Shader Graph 的 _BUILTIN_ZTest）；手寫的 UI/Default、Sprites/Default 是
  LEqual、不寫深度。
- pass：built-in 挑 LightMode ForwardBase，沒有再挑沒標的與 Always（不分大小寫）。變體沒有剛好的（打包時剝掉）就挑相同 keyword 最多、
  多出來最少的（Unity 的非嚴格變體比對；MT2 的 CharacterShader2.0 Graph 只留了帶 _ADDITIONAL_OFF 的變體）。
- 前向光照（render/builtinLighting.ts）：每個圖層一組常數，主光源是 cullingMask 含這個圖層、強度最大的平行光（MT2 的火車與角色各吃一盞）；
  _LightColor0 照 lightsUseLinearIntensity（false：強度乘在 gamma 色上再轉線性）；環境光 SH 用場景 LightingData 的
  m_BakedAmbientProbeInLinear（乘基底常數再照 HDRP 的 PackCoefficients 排），沒有時 Flat 模式只有常數項；霧（FOG_LINEAR 等）與 unity_FogParams。
  keyword 是 DIRECTIONAL＋LIGHTPROBE_SH（＋霧）。Unity 用 active 場景的光照設定：LoadedScene 帶著場景檔的 settings，boot 的
  `renderer.sceneLighting` 接上。
- MeshRenderer（built-in）改成受管的繪製物件：每個材質格畫對應的子網格（材質比子網格多，多的畫最後一個子網格），網格是 MeshFilter 的執行期網格
  或資產（m_SubMeshes 照 m_IndexFormat 切）。Spine 的 SkeletonRenderer 每格輪流寫兩份 new Mesh()，refresh 看物件與 version 換頂點與三角形；
  材質、子網格數、圖層變了重產。排序照 Renderer 的 sorting layer／order 與材質的 render queue（m_CustomRenderQueue，否則 shader 的 Queue tag）。
- 天空盒：RenderSettings.skybox 是 Skybox/6 Sided 時，每一面一片四邊形、一個 pass，在不透明之後、透明之前畫，跟著攝影機、大小是遠平面的一半。
- K3 shader 的貼圖：取樣器 uniform 名稱照 GLSL 的宣告找（參數表的 samplerRegister 是 null 時以前組出 `t3snull`，Spine 角色的 _MainTex 沒綁上、
  整隻看不到）。cbuffer 自動補 `<貼圖>_TexelSize`（1/寬、1/高、寬、高）與 `<貼圖>_HDR`。
- Canvas 元件停用時整個 Canvas 不畫、GraphicRaycaster 也打不到（`canvasDisabled`）。MT2 的 CardUI.SetCardVisible 用這個藏物件池裡的卡，
  以前池子裡的卡面在畫面中央留下兩個白方塊（升級圖示的 Image 沒有 sprite）。
- TMP：字型資產的材質欄位兩種都認（Diceomancer 的 TMP 3.2 預覽版是 m_Material，MT2 匯出的是 material）。粗體字重的 PTSansNarrowBold SDF
  以前讀不到材質，GetFallbackMaterial 複製出空材質，粗體字整段沒畫。

匯入器：
- assets：材質參照的內建 shader（unity_builtin_extra 的 fileID）查出名稱，寫進 shaderName 與 builtinShader.name。AssetRipper 把 build 裡打包進
  sharedassets 的內建 shader 複本改寫成內建參照、沒匯出；名稱照 build 裡同名材質的 m_Shader 查，對不到的看 unity_builtin_extra 的 pathID
  （report.json 的 builtinShaders）。MT2：45 Standard (Specular setup)、46 Standard、104 Skybox/6 Sided、200／202／203／205 Legacy 粒子、
  210／211 Particles/Standard、10750／10751 Unlit/Transparent（Cutout）、7 Legacy Shaders/Diffuse；10755 對不到，也沒有材質用。
- scenes：場景的 LightingData（LightmapSettings.m_LightingDataAsset）的 m_BakedAmbientProbeInLinear 帶進 settings.LightingData.ambientProbe。
- shaders：convert.py 多一個入口（--build、--build-shaders），用 UnityPy 從 build 讀 Shader，轉成跟 AssetRipper YAML 一樣的結構
  （build_shader_dict）之後走同一條轉換，資料夾加 Builtin_ 前綴。UI/Additive 兩條路轉出的 index.json 與 GLSL 相同（資料夾名稱除外）。
  也掃 Assets/Shader 以外的 Shader 資產（Resources/shaders 的 TextMeshPro/Sprite 等以前沒轉）。MT2 的 shader 從 170 個變 256 個。

差異清單：
- 陰影、ForwardAdd（其他逐像素光源）、頂點光源、光照探針群組、反射探針都沒做：SHADOWS_SCREEN 變體不選、unity_SpecCube0 是黑的、
  unity_IndirectSpecColor 是 0（Standard 的 _GLOSSYREFLECTIONS_OFF 用它）。RimLightCamera 的 stencil 取代 shader 沒做。
- 有 targetTexture 的攝影機不畫（CardTrailCamera 畫卡牌拖尾進 RenderTexture，RawImage 還沒做）。
- 一個 shader 有兩個以上要畫的 pass 時只畫第一個。
- 天空盒網格每面的 UV 方向、大小照推定（Unity 引擎內部的天空盒網格看不到原始碼）；其他天空盒 shader（Procedural 等）沒做。
- `<貼圖>_HDR` 一律給 LDR 的 (1, 1, 0, 0)；RGBM 編碼的貼圖未處理。
- 同 depth 的攝影機照場景樹順序；巢狀 Canvas 的圖層照最近的 Canvas；Overlay 那一趟之前清深度與 stencil。三者 Unity 的實際規則未查證。
- 距離排序用物件的位置（Unity 用包圍盒中心）。
- Particles/Standard Surface／Unlit 的部分頂點變體 spirv-cross 轉不出來（StructuredBuffer 的版面，26 個 DXBC），粒子還沒畫，碰不到。

驗證（10/17）：
- vitest：render/cameraStack.test.ts（攝影機順序、蓋滿畫面、viewport、cullingMask、透視與 Overlay 投影、管線判斷）、
  render/builtinLighting.test.ts（主光源照圖層、光源方向、lightsUseLinearIntensity、SH 打包、Flat 環境光、線性霧）；全部 49 檔、360 個測試過。
- 匯入器重跑 assets、scenes、glyphs、shaders：shader 發布 256/256，GLSL 18260 個、glslang 驗證失敗 0。
- 瀏覽器：續關進新手戰鬥，GameCamera 畫 67 個、UICamera 155 個、Overlay 65 個，例外 0；火車、房間、Fel、Shield Steward、Fallen Champion、
  Ominous Acolyte、地景與窗外的天空都畫出來；draw 一次約 11 ms。

還沒做：
- 粒子（ParticleSystemRenderer 的模擬與繪製，戰鬥裡 34 個）、RawImage 與 RenderTexture、陰影與反射。
- 效能：World.tick 一格約 480～520 ms，量一格 524 ms 裡 relayout 佔 510 ms。之前以為是分頁隱藏才慢，實際是每格的同步重排
  （同一天修掉，原因是「讀」transform 會整棵樹重排，見下一節）。

## 2026/10/17 讀 transform 只沿父物件鏈算（MT2 戰鬥一格的遊戲邏輯從約 740 ms 降到 11 ms；Diceomancer 不受影響）

原因：腳本讀 Transform（position、rotation、lossyScale、TransformPoint…）每次都叫 World.relayout，整棵樹排版兩遍再加 uGUI 自動排版。
MT2 戰鬥一格讀 108 次（CharacterClipAgainstRoom、RoomState.GetCharClip*、CharacterUIMeshSpine 的漸層與溶解、SkeletonRenderer 的物理、
BoneFollower），1.4 萬個節點每次約 7 ms，一格 801 ms 裡 776 ms 花在這裡。上一節寫「改 transform 就重排」不對，是讀的時候重排。

改法（照 Unity：讀的時候沿父物件鏈算，不跑自動排版；LayoutGroup、ContentSizeFitter 要等畫之前的 Canvas 重建或 ForceRebuildLayoutImmediate）：
- `SceneGraph.refreshChain`：只算 node 與它的祖先，跟 layout 共用同一套算法與輸入比對的快取（`layoutNode`）。鏈上某個節點的輸出變了，
  記 `childrenStale`，下一次 layout 讓它不在鏈上的子物件重算。Screen Space - Camera 的 Canvas 在鏈上時先更新那台攝影機的鏈。
- `World.refreshTransform` 包一層。unityScene 的 Transform 讀取、`SetParent` 讀世界矩陣、`set_position`／`set_rotation` 讀父物件、
  `Renderer.bounds` 改用它。
- 以前沒更新就直接讀的也補上：`RectTransform.rect`、`TransformPoint(Vector3)`、`GetWorldCorners`／`GetLocalCorners`、Camera 的座標換算
  （WorldToScreen／Viewport、ScreenToWorld、ScreenPointToRay）、`Camera.CopyFrom`、`SetSizeWithCurrentAnchors` 讀父物件的 rect、
  RectTransformUtility 的 `ScreenPointToLocalPointInRectangle`、`ScreenPointToWorldPointInRectangle`、`RectangleContainsScreenPoint`、
  `CalculateRelativeRectTransformBounds`。
- 整棵樹的 relayout 照舊在：每格結尾、`ForceRebuildLayoutImmediate`、`Canvas.ForceUpdateCanvases`、Instantiate、SetParent、
  SetSiblingIndex、RectTransform 的幾個 setter、場景載入、換螢幕大小。

差異清單：
- Slider／Scrollbar 的 handle 與 fill 錨點，Unity 是設 value 時就改（UpdateVisuals），這裡在 relayout 才改（ui/drivenControls.ts）。
  同一格設完 value 馬上讀 handle 的位置，拿到的是舊的；以前讀的時候順便整棵樹 relayout，剛好對。

驗證（10/17）：
- vitest 49 檔 364 個。unity/incrementalLayout.test.ts 加 4 個：refreshChain 讀到的 rect 與世界矩陣跟全部重算一樣、之後的 layout
  也一樣（level1、level2 各讀 240 次）；Screen Space - Camera 的攝影機動了再讀 Canvas 底下的物件；不在鏈上的物件不會被更新。
  反向確認：拿掉 childrenStale，2 個失敗；拿掉攝影機的鏈，1 個失敗。runtime 與 mt2-web 的 tsc 都是 0。
- 瀏覽器（2048×1152）：續關進新手戰鬥，同一個畫面把讀取換回「每次整棵樹 relayout」是一格 721～763 ms，改完 11 ms，
  畫一次約 14 ms。每格讀 153 次，沿鏈更新合計 0.16 ms。連跑 1680 格、重載後再跑 600 格，例外 0；畫面跟上一節的截圖一致。

還沒做（同一天下一節處理了前兩項）：
- 每格結尾那次 relayout 還是整棵樹掃，約 10 ms：排版兩遍各 2.8 ms，其餘是自動排版與裁切。
- SetParent 一次會整棵樹 relayout 兩次（instantiate.ts 的 setParent 一次、Transform.SetParent 結尾一次），卡牌換容器那幾格會多 20 ms。

## 2026/10/17 第二輪效能：停用的不排、生物件只算子樹、SetActive 只處理子樹、換父物件不重掃候選清單（Diceomancer 不受影響）

量法：續關進新手戰鬥（1024×768，畫布 2048×1152），拆開每格的時間。上一節之後一格 16.8～18.7 ms：每格結尾的 relayout 8.9～10.1 ms
（排版兩遍各 3 ms、uGUI 自動排版 3.8 ms、裁切 1.5 ms）、refreshEnables 1.8 ms、舊版滑鼠事件 2.0 ms、腳本 3.1 ms。
結束回合那段 709 格最慢 257 ms，超過 50 ms 的有 11 格。

改法：
- 排版跳過停用的子樹（`SceneGraph.layout`）。1.4 萬個節點只有 3,331 個啟用；沒有東西畫它，事件、射線、物理也跳過它，腳本讀它的 transform
  走 refreshChain。跳過時記 `skipped`，重新啟用後第一次算到它當作輸入有變（停用期間父物件可能動過）。force 照舊全算；
  verifyLayout 不比停用的。排版一遍 3 ms → 0.43 ms。TMP 的排版（unityTmp 的 layout 讀 rect）也先沿鏈算。
- Instantiate、new GameObject、spawnPrefab、SetParent 不再整棵樹 relayout，改成 `World.refreshSubtree`（沿鏈算根、再往下算那棵子樹）。
  Transform.SetParent 結尾那次、SetSiblingIndex、RectTransform 的 setter（SetSizeWithCurrentAnchors、SetInsetAndSizeFromParentEdge、
  offsetMin／offsetMax）、Camera.CopyFrom 同樣。Unity 在這些時機不重排；uGUI 自動排版照舊等每格結尾。
- `refreshEnables(scope)`：SetActive 只處理那棵子樹、Behaviour.enabled 只處理那個元件，順序照登記順序（`BehaviourTable` 照 GameObject 分組、
  記登記序號）。每格開頭照舊全掃。以前每次 SetActive 掃 1.8 萬個 behaviour，結束回合的協程一格 SetActive 幾十次，refreshEnables 一格 26～58 ms。
- 候選清單分兩種版本（`SceneGraph.cached` 的 dep）。換父物件（`bumpHierarchy`）只讓根的順序重建；「哪些節點有哪種元件」的清單
  （Slider／Scrollbar、uGUI 排版控制器、RectMask2D 的裁切對象）只在節點或元件增減時重建。結構一變四份清單合計重掃約 17 ms，
  戰鬥 600 格裡 54 次結構變動有 45 次是物件池換父物件。

順手修的兩個錯（改完上面之後，結束回合走得到的路徑）：
- 迭代器自己還在跑的時候被 Dispose（CharacterState.InnerSetWorldPosition 叫 onReachedPoint → SetWorldPosition → CoroutineController.Stop
  把自己停掉）：JS 的 return() 丟「Generator is already running」，協程整個中斷，角色走到定點後的下一段移動沒開始。C# 不丟例外，
  這一次 MoveNext 照常跑完；IDisposable_Dispose 改成一樣。
- 事件 `+=` 一個多播委派（CoroutineSignal.Clone 的 `copy.Listener += Listener`）：整個呼叫清單被塞成一個元素，Invoke 時「f is not a function」。
  eventAdd／eventRemove 照 Delegate.Combine／Remove 接上、拿掉最後一段相同的。

差異清單：
- 停用物件的 rect 與世界矩陣不每格算，讀的時候才算。引擎內部直接讀 node.world／rect、沒先 refreshTransform 的程式，讀停用物件會拿到舊值
  （目前知道的讀取點都補了）。
- 不經過 Behaviour.enabled、直接改 m_Enabled 的（Animator 曲線）：OnEnable／OnDisable 在下一格開頭的全掃才跑。以前同一格裡別處的 SetActive
  會順便把它跑掉。Unity 是在 Animator 更新時跑，兩種都只是近似。
- 執行中的迭代器被 Dispose 時，停在 try 裡的 finally 這裡沒跑（C# 會先跑）。

驗證（10/17）：
- vitest 49 檔 372 個。incrementalLayout.test.ts 加 3 個（前兩個 level1、level2 各跑一次）：停用的子樹（跳過、停用時讀、重新啟用後算對）、
  refreshSubtree（換 10 次父物件，跟全部重算一樣、之後的 layout 也一樣）、cached 的 membership。lifecycle.test.ts 加 SetActive 與 enabled 只處理受影響的、
  照登記順序。dotnetBcl.test.ts 加執行中的 Dispose、多播委派的事件。textContext.test.ts 讀 rect 改成先沿鏈算（停用的物件不再每次排版）。
  反向確認：拿掉 skipped 4 個失敗、不傳子樹根的 childrenStale 2 個、不照登記順序 1 個、SetActive 全掃 1 個、
  拿掉 Dispose 的例外處理 1 個、舊的 eventAdd 1 個。runtime 與 mt2-web 的 tsc 都是 0。
- 瀏覽器：
  - 停用的不排之後，一格 10.7 ms，relayout 4.3 ms。
  - 結束回合那段 709 格：最慢 257 → 88 ms，超過 50 ms 的 11 → 7 格，例外 1 → 0。
  - SetActive 只處理子樹之後，尖峰格的 refreshEnables 26～58 → 2～5 ms。
  - 全部改完，存檔已推進到 Boss 戰的戰鬥階段，600 格：平均 13.8 ms、中位數 13.3、第 95 百分位 16.5、最慢 49，沒有一格超過 50 ms，例外 0。
  - 把讀取、子樹更新、排版換回舊做法比對畫面：下層角色沒有數值標籤，兩邊一樣，不是這次造成的。

還沒做：
- uGUI 自動排版每格把 381 個根全部重排（約 2.7 ms），Unity 只重排標記過的。
- 每格開頭 refreshEnables 全掃（約 1.5 ms）、舊版滑鼠事件（約 1.6～2 ms）、裁切（約 1.3 ms）。
- 節點或元件增減時（600 格約 9 次），候選清單照舊整個重掃；attach／detach 的 rescanCameras 與 refreshHierarchy 也是整棵樹。

## 2026/10/17 粒子、拖尾、RenderTexture、GrabPass、反射（Diceomancer 不受影響）

程式在 4b94460 進版控，這一段是補寫的說明。

- 粒子（runtime/src/particles）：Unity 的粒子系統是原生程式，看不到原始碼，所以照 Unity 2022.3 手冊各模組的說明自己實作。
  - 模組：Shape、Emission（rate、rate over distance、bursts）、Velocity、Force、Limit Velocity、Inherit Velocity、Color、Size、Rotation、
    Noise、Texture Sheet、Trail、Custom Data、Sub Emitters（Birth、Death）。
  - 播放：World 在排版之後推進粒子，再發 `Canvas.willRenderCanvases`。停用時清掉並停止；啟用時照 playOnAwake 播放，子發射器不自己播。
  - 繪製：ParticleSystemRenderer 產 Billboard、Stretch、Horizontal、Vertical、Mesh 的網格，頂點流照 `m_VertexStreams` 塞進 TEXCOORDn。
    粒子頂點色轉成線性色（專案是線性色彩空間）。
  - 相容層：播放控制、`GetParticles`／`SetParticles`、`BakeMesh`／`BakeTrailsMesh`。
- UIParticle 照原版的路走：產生碼在 willRenderCanvases 烘網格、呼叫 `CanvasRenderer.SetMesh`，繪製端從 CanvasRenderer 的狀態拿網格。
  CanvasRenderer 的狀態搬到 ui/canvasRenderer.ts，csport 與繪製端共用。
- TrailRenderer（particles/trailRenderer.ts）：物件移動時留點，照 time 老化；寬度曲線、顏色漸層、View 對齊、Stretch 貼圖。
- RenderTexture：有 targetTexture 的攝影機先畫進各自的 render target，RawImage 再顯示。MT2 的 CardTrailCamera 就是這樣把 HUD 的拖尾畫進 Hud 建的 RenderTexture。
- GrabPass：shaders/convert.py 輸出 pass 的 type 與 textureName。choosePass 跳過 GrabPass：Particles/Standard Unlit 以前會先撞到 pass 0，變成「變體沒轉出」。
  繪製端畫這個物件之前，先把目前的畫面抓進貼圖。
- 反射：`unity_SpecCube0` 綁 RenderSettings 的反射 cubemap（`AssetDB.cubeTexture` 讀六面直條的 PNG）。
- 排版：GridLayoutGroup、AspectRatioFitter（照 UnityEngine.UI 原始碼）、遊戲腳本自己實作的 ILayoutElement（LayoutGroupReplacementElement），
  以及 LayoutGroup 的 min／preferred／flexible 尺寸。
- 轉換器：
  - `base.屬性` 固定叫基底那一版（EnhancerRewardData.Costs 以前無限遞迴）。
  - 不是 UnityEngine.Object 的資料類別，沒有初值的 List 欄位：用 new 建出來是 null，反序列化建的才是空清單。
  - ref 區域變數可以指到參數的欄位。
  - GetComponents 家族由 List<T> 推斷出來的型別引數也會傳。
- 執行環境：
  - LateUpdate 另外一趟，在全部 Update、補間、協程、動畫之後。
  - Animator 的 AnyState 要開 Can Transition To Self 才能轉回自己，一格只開始一個轉換。
  - 巢狀 Canvas 沒開 overrideSorting 時，點擊照父 Canvas 排序。
  - CanvasGroup 的 OnCanvasGroupChanged；Canvas.rootCanvas。
  - 根 Canvas 的 localPosition／localRotation／localScale 回驅動之後的值。
  - MemberInfo.Name 也接受 Type。
  - TMP 3.x 的 `m_SpriteGlyphTable`。

陰影決定先不做：
- 全部場景與資產只有 3 盞燈開了陰影，分別在 main、champion_upgrade、soul_savior_run_setup。
- main 那盞是火車燈，原版 GraphicsSettingsMainSceneManager 不管哪個畫質都設成 `LightShadows.None`，主線戰鬥本來就沒有即時陰影。
- champion_upgrade 只有 1 個網格會接收陰影。
- soul_savior_run_setup 有 252 個網格，但那是另一個模式（Soul Savior run）的設定畫面。

差異清單：
- 粒子：Mesh 形狀（MT2 只有 3 個）沒做，改從原點朝隨機方向發射。
- 粒子：Collision、Triggers、External Forces、Lights、各種 by Speed、Ring Buffer、Custom Simulation Space 沒做。
- 粒子：子發射器的 Collision、Trigger、Manual 沒做。
- 粒子：未查證的推定有這幾項。
  - 圓與球照面積／體積均勻取半徑。
  - 同一格裡發出的粒子平均分散在這一格的時間點上。
  - Limit Velocity 的 dampen 每 1/30 秒拉一次。
  - Noise 開了 damping 時，強度除以頻率。
  - 粒子旋轉的正方向。
  - 四邊形的錨點。
- TrailRenderer：點沿拖尾的比例用距離算（未查證）。時間用乘過 timeScale 的（未查證）。
- TrailRenderer：物件停用時點清掉（Unity 保不保留未查證）。
- TrailRenderer：autodestruct、圓角、圓頭、TransformZ 對齊、Tile 等貼圖模式沒做（MT2 的全部是 View、Stretch、0、0）。
- RenderTexture 一律是 SRGB8_ALPHA8、沒有深度貼圖。
- 有 targetTexture 的攝影機一律先畫。Unity 是全部攝影機一起照 depth 排，顯示 RenderTexture 的攝影機排在畫它的攝影機前面時，
  Unity 顯示的是上一格的內容，這裡沒照做。
- GrabPass：用 ComputeGrabScreenPos 的 shader 會上下顛倒（D3D 編譯時 y 固定乘 −1），MT2 的材質沒用到。
- 反射：只做了 Custom 反射來源。Skybox 來源要用 LightingData 烘的探針，還沒做，現在是全黑。
- 反射：強度乘在 HDR 解碼值的 x 上（未查證，MT2 都是 1）。
- CanvasRenderer.Clear 只丟網格，材質與貼圖留不留未查證。
- 陰影沒做（理由見上）。

驗證（10/17）：
- 4b94460：vitest 52 檔 396 個；runtime 與 mt2-web 的 tsc 都是 0。
- 瀏覽器，Boss 戰：粒子可見 29～33 個，UIParticle 3～5 個，RawImage（拖尾的 RenderTexture）1 個。
- 丟牌時手牌拖尾（第 5 層，UICamera 畫）可見 2 個。
- 戰後金幣、卡片飛向 HUD 時，CardTrailCamera 畫 1 個，RenderTexture 讀得到拖尾的像素。
- 勇者升級畫面的火星粒子看得到。

## 2026/10/17 往後打的模擬：故事事件、帶敵方遺物的戰鬥、OnDestroy、ink 的選項（Diceomancer 的 enemies、stories 產生結果逐字不變）

從續關的地圖一路往後打：地圖分支 → 商人 → 回血節點 → 故事事件 → Boss 戰 → 戰利品 → 勇者升級 → 升級商人 → 第二、三場戰鬥 → 另外兩個故事事件。
戰鬥中途用原版的作弊指令 `EndBattle`（SaveManager.Cheat_EndBattle → HeroManager.Cheat_EndBattle）結束。它走正常的勝利路徑：
發 combatFinishedSignal、通知沒有英雄了、等進入戰後獎勵。

這一輪修掉的卡關：
- 故事事件停在門口。原因有兩個，都在 Animator 的 Has Exit Time：
  - 以前拿總時間比，循環 clip 錯過第一圈就永遠不轉。照手冊改成「exit time 小於 1 的循環動畫每一圈都判斷」。
  - WideBG_Init、Event_Init 是長度 0 的循環 clip，以前當成非循環處理。現在只要時間有前進，每一格都算到達（未查證）。
- 帶敵方遺物的戰鬥開不了打。原因是 virtual 的自動屬性 `FloatingRewardReceiver.rewardType { get; }`，子類別用 `=>` 覆寫，
  產生碼卻直接讀欄位，每個接收者都是 0、在 FloatingRewardManager 的表裡互相蓋掉。敵方遺物找不到接收者，完成回呼斷掉，
  開戰時的 Reward 畫面關不掉。
  - 轉換器（工具包模式）：virtual／override 的自動屬性讀寫改走 R.callGen，宣告的類別另外產生讀寫欄位的 get_／set_。
  - mt2-web 有 12 個產生檔受影響。RoomAbility／UnitAbilitySelectionBehaviour 把 hasMovedTargetingCursorOutOfHand 覆寫成永遠 true，
    以前也沒生效。
- 進第二場戰鬥時丟例外（ScreenManager.RefreshScreenStack 讀到銷毀畫面的 canvas）。原因是執行環境完全沒有 OnDestroy。
  - UIScreen.OnDestroy 不會 UnregisterScreen，場景卸載後 ScreenManager 一直拿著 IntroStart、MainMenu、上一場的 GameScreen 等 10 個銷毀的畫面。
  - 補上 Behaviour.onDestroy：Destroy 與場景卸載時，整棵子樹先叫完 OnDisable 再叫 OnDestroy；只對跑過 Awake 的叫（手冊）。
  - OnDestroy 跑完才把物件標成已銷毀，因為 CharacterDialogueScreen.OnDestroy 會 TryGetComponent。
- 故事事件選完選項後 StoryException（Failed to find content at path 'c-0.0.PenanceFields'）。
  - 原因：相容層的 Stack 是一般陣列，列舉時從底到頂。.NET 是從頂到底。
  - ink 的 Object.path 把路徑一段段 Push 進 Stack 再 new Path(stack)，路徑整串反過來。
  - 改成 CsStack（陣列子類別，iterator 反著走）。ToArray 照索引複製再反轉；LINQ 遇到換過 iterator 的陣列改走 iterator。
- 故事事件的內文前後冒出一串「¤」，上色位置也偏掉。原因是 TMP 3.x 樣式表的 `m_HashCode` 匯入後是字串，`<style="Body">` 找不到樣式。
  另外匯出的 m_OpeningTagArray 只剩前 10 個字元，改照 TMP_Style.RefreshStyle 由定義字串逐字算。

往後打看到、還沒處理的缺漏（照影響大小排）：
1. 卡名完全沒畫。卡名用的是 ExtendedTextMeshProUGUI（TextMeshProUGUI 的子類別，WarpText 改 textInfo 的頂點做彎曲），繪製端只認 TextMeshProUGUI。
   火爐強化的名稱、Boss 能力框的標題可能也是同一個原因。
2. 卡圖：
   - 手上的法術卡卡圖整塊是橘色或黑色（選卡畫面同一張卡是正常的）。
   - 有的單位卡只有背景、沒有角色。
   - 物件池重用 CardUI 之後，卡圖變成別的風景圖，法術卡上還多出攻擊與血量圖示。
   - 勇者卡的卡圖是火車內部的佔位圖。
3. 牌組選擇畫面（商人的升級、故事事件的升級）：
   - 沒有暗色底，後面的畫面直接透出來。
   - 卡片網格的上緣被標題框蓋住。
   - 選中的卡跑到右下角被切掉。
4. 關鍵字提示框印出原始的 `<sprite name="" tint=1>`，圖示名稱是空的。
5. 出牌的瞄準曲線沒畫，只有箭頭。
6. 材質屬性動畫（`$materialOverrides`）繪製端沒讀：攻擊的溶解與 Outro_Mask、選卡後其他卡片燃燒時卡圖變白。
7. Animator 第 2 層以後的 layer 沒做，故事事件火車晃動的那一層不會動。
8. 地圖上 Boss 提示框的標題換行後跟內文疊在一起。
9. 第一場戰鬥開場時，紅色的 Boss 橫幅蓋住左上角的火爐血量與金幣，之後自己恢復（未查證原因）。
10. HUD 拖尾畫進 RenderTexture 的像素很淡（取樣 alpha 最高 31），跟原版比是不是太淡：未查證。
11. `_CameraDepthTexture` 沒綁（FireBurst 的 soft particles）。
12. 轉換的淡入淡出沒做（瞬間切換）。
13. 戰前介紹的 Boss 是一片藍色剪影，原版是不是剪影：未查證。

驗證（10/17）：
- vitest 54 檔 406 個。新加的測試有這幾組：
  - animator.test.ts 4 個（循環的下一圈、非循環只判斷一次、長度 0 的循環兩種）。
  - onDestroy.test.ts 3 個（子樹的順序與回呼期間還沒算銷毀、沒跑過 Awake 的不叫、只銷毀元件）。
  - dotnetBcl.test.ts 1 個（Stack 當 IEnumerable 的順序）。
  - styleSheet.test.ts 2 個。
- 反向確認：舊版 animator 3 個失敗、舊版 world／instantiate 2 個、舊版 Stack 1 個、舊版樣式表 1 個。
- runtime 與 mt2-web 的 tsc 都是 0。
- Diceomancer：enemies、stories 的產生檔逐字相同。ui 跟上一版轉換器的輸出逐字相同；跟 diceomancer-web 進版控的那份差 11 行
  （R.new_SubCommandChangeUI 變成 R.newGen），上一版轉換器也一樣，是先前就分岔的。
- 瀏覽器：
  - Boss 戰開打，出牌時單位出現、能量扣 1。
  - 戰後獎勵領完回地圖，商人買升級扣金幣。
  - 第二個故事事件選完選項接得下去（「You've chosen the power of Wrath」→ Depart）。
  - 全程例外 0。
  - 樣式表的修正只有單元測試，畫面上沒有再看到 `<style>` 的故事內文。

## 2026/10/17 卡名、卡圖、牌組選擇畫面（轉換器沒動；Diceomancer 實際碰到的只有 ScrollRect 與 LayoutGroup 的兩項）

上一段缺漏清單的第 1～3 項。先在瀏覽器重現、找到原因再改，一共七個原因：

- 卡名底板整個被關掉（不只卡名，連卡片類型標籤、商人與火爐強化的名稱牌、Boss 能力框的標題都一樣）。
  - Nameplate 上的 MasterySpriteSelector 用 `MasteryFrameType.None`（−1）查 sprite，查不到就 `SetActive(false)`（AbstractSpriteSelector.SetSprite）。
  - 查不到的原因：AssetRipper 匯出的十六進位陣列把 ffffffff 寫成 `ffffff/f`。MT2 有 3300 多處，全在 SerializableDictionary 的 `_keys`／`_keyValues`，
    「/」只出現在全是 f 的那 8 個字裡。以前 `parseInt('/f')` 是 NaN，存成 0，−1 解成 16777215。
  - 改法：decodeHexArray 把「/」當 f 讀（為什麼寫成「/」未查證）。
- 繼承 TMP 的遊戲類別完全沒畫。卡名用的 ExtendedTextMeshProUGUI 是 TextMeshProUGUI 的子類別，繪製端、Mask、RectMask2D、排版、Selectable 只認類別名。
  - 新增 unity/componentKind.ts：沿 hierarchy.json 的基底鏈，把 TMP 的子類別當成 TMP（viewer/boot.ts 載入時登記）。
  - 只換 TMP：Image、RawImage 的子類別多半自己覆寫 OnPopulateMesh，照 Image 畫會畫錯，MT2 也沒有。
  - 排版也照 TMP 的 ILayoutElement：以前 ExtendedTextMeshProUGUI 被當成腳本實作的 ILayoutElement，偏好尺寸是 0。
- 卡圖整塊單色、只有背景、物件池重用後變成別的風景圖。
  - AnimateCardEffects 用 `_material.GetTexture(...).width` 算各層的 UV 矩陣。相容層的 Texture.width 只看同 guid 的 sprite，卡圖材質的貼圖拿到 0，
    矩陣除以 0，各層的 `_LayerNTransUVOrigins／AxesLayer` 全是 NaN，只剩第 1 層（背景）照預設 UV 取樣。
  - 改法：Texture.width／height 先讀素材庫的貼圖寬高（RenderServices.textureInfo，textures.json），沒有才退回 sprite。
- 縱火犯（Firestarter）的卡圖只有背景（Jason 10/17 指出）。
  - Shiny Shoe/CardEffects 有兩個沒標 LightMode 的 pass：PASS_1 畫第 1～5 層（一般混色），PASS_2 畫第 6～9 層（加法混色）。繪製端只畫第一個，
    縱火犯的主圖在第 6 層。
  - 改法：unityShader.ts 新增 drawPasses（choosePass 挑的那個，加上它後面同一種 LightMode 的 pass；沒標與 Always 算同一種）。
    uGUI 的 Image 照它建繪製物件，共用幾何、排在同一個節點的後面。
- 牌組畫面的卡片網格上緣被標題蓋住（Deck 與 ApplyUpgrade 兩種模式都是）。
  - DeckScreen 剛放進卡片就 ScrollToRow 設 `verticalNormalizedPosition`。原版 SetNormalizedPosition 先 EnsureLayoutHasRebuilt：
    啟用之後還沒排過版就 Canvas.ForceUpdateCanvases（ScrollRect.cs:551-557）。這裡沒做，用舊的內容尺寸算，網格停在置中。
  - 改法：ScrollRect 的 SetNormalizedPosition、LateUpdate、OnScroll 前補上 EnsureLayoutHasRebuilt。
    「啟用之後排過版」用 World.layoutCount 比 OnEnable 當時的值；World 另外加 inLayout（CanvasUpdateRegistry.IsRebuildingLayout）。
- 牌組選擇畫面選中一張卡，其他卡消失、選中的卡跑到右下角被切掉。
  - 選中時 UIScreen.FocusCardInLayoutGroup → LayoutGroupReplacementElement.DisableLayoutGroup：記下 GridLayoutGroup 的 preferredWidth／Height、
    關掉群組。滑到別張卡時又叫一次，這時群組已經關了。
  - 原版的 preferredWidth 回的是上一次 CalculateLayoutInput 存的總和，關掉之後不重算、值還在。這裡每次從頭重算，群組關著就回 0，
    ContentSizeFitter 把網格縮成 0×0，掛在左上角的卡片整片往右下偏。
  - 改法：layout.ts 用一份以元件為鍵的「上次算好的總和」，群組這次沒算到就讀它。
- 彎曲文字（地圖的區域名稱、Select a Track）只有一半是彎的。
  - 原版文字一變，Canvas 畫之前 CanvasUpdateRegistry 叫 Graphic.Rebuild(PreRender)，子類別的 WarpText 跟著重跑。這裡只有 OnEnable 那一次，
    之後文字一改（在地化、地圖設名稱），掛勾的字數對不上就不蓋。
  - 改法：unityTmp.ts 在 base.OnEnable 時登記覆寫了 Rebuild 的 TMP 子類別，每格 willRenderCanvases 比對排版輸入、字距與文字顏色，
    變了才叫產生碼的 Rebuild(PreRender)。顏色也要比，因為 UpdateVertexData 的掛勾連頂點色一起蓋。
  - 卡名本來就不彎：所有卡的名字標籤 `enableVertexWarping` 都是 0（WarpText 不跑，只設 renderMode）。

查過、不是 bug 的：
- 「牌組選擇畫面沒有暗底」：Overlay（黑色、alpha 0.9）有畫，拿掉它背景亮 3～4 倍。MT2 是線性色彩空間（m_ActiveColorSpace 1），UI 在線性空間混色，
  0.9 的黑剩 10% 的線性亮度，換回 sRGB 約 35%，背景看得出來是對的。原版只有 Switch 版會把 Overlay 設成不透明（DeckScreen.SetOverlayOpaque）。
- 「物件池重用後法術卡多出攻擊與血量圖示」：同一組 CardUI（gameObject 相同）連選三輪，法術卡都沒有。舊版的確切原因沒找到，
  可能是把裝備卡的數值看成法術卡（未查證）。

Diceomancer 的影響（只讀 diceomancer-web 的資料，沒動它的工作區）：
- 場景與 prefab 沒有 `ffffff/f`；沒有繼承 TMP 的類別；產生碼沒有讀 Texture.width。
- 多 pass 而且同一種 LightMode 的只有 TMP 的 Distance Field - 2 Pass（不走 Image）和隱藏的後處理 shader。
- 會碰到的是 ScrollRect 的 EnsureLayoutHasRebuilt（啟用後第一次設位置會先排版）與 LayoutGroup 關掉後的總和，畫面沒有在瀏覽器確認。

差異清單：
- componentKind 只把 TMP 的子類別當基底，Image、RawImage 的子類別照舊不畫。
- drawPasses 只用在 uGUI 的 Image；其他繪製物件照舊只畫第一個 pass。Canvas 是不是不看 LightMode、把所有 pass 都畫：未查證（CardEffects 兩個 pass 都沒標，結果一樣）。
- TMP 子類別的 Rebuild(PreRender) 只在排版輸入、字距、文字顏色變了時叫。Unity 是任何 SetVerticesDirty（對齊、樣式、材質等）都會叫。
- ScrollRect 的 m_HasRebuiltLayout 用「OnEnable 之後 relayout 過」代替 Rebuild(PostLayout) 設旗標。
- 設完 normalizedPosition 馬上讀回來的值是舊的：節點的世界矩陣要等下一次排版才更新（先前就有，scrollRect.test.ts 有註明）。

驗證（10/17）：
- vitest 58 檔 421 個（新加 15 個）：
  - cardArtInputs.test.ts 5 個（`ffffff/f` 的解碼、Texture.width 讀貼圖寬高與退回 sprite）。
  - tmpRebuild.test.ts 2 個、drawPasses.test.ts 4 個、scrollRect.test.ts 2 個。
  - layout.test.ts 2 個（群組關掉讀上一次的總和、ExtendedTextMeshProUGUI 照 TMP 排）。
- 反向確認：舊版 core.ts 1 個失敗、unityAssets.ts 1 個、unityTmp.ts 2 個、layout.ts 2 個、scrollRect.ts 1 個；drawPasses 改成只回第一個 pass 2 個失敗。
- runtime 與 mt2-web 的 tsc 都是 0。轉換器沒動，沒有重轉。
- 瀏覽器（從續關的地圖往後打，全程例外 0）：
  - 牌組畫面：卡名、類型標籤、卡圖都出來，勇者卡 Fel 有角色圖；第一排完整露出在標題下面。
  - 法術升級商人買 Powerstone：ApplyUpgrade 模式第一排在說明框下面；選中 Pyreclasm 停在原位，下面出現 Upgrade 按鈕、預覽 Deal 200 damage。
    沒按確認。
  - Boss 戰：Boss 能力框的標題（Nourishing Feed）、手牌的法術卡（縱火犯、Fanning the Flame、Just Cause、Challenge）卡圖正常。
  - 勝利後的選卡、火爐強化的水晶名稱牌、勇者升級畫面的 Fel 卡圖正常；再打一場，同一組 CardUI 第二、三次選卡的卡圖各自對得上。
  - 地圖上 10 個 `enableVertexWarping` 的標籤全部彎了（畫出來的頂點跟沒掛勾的排版不同）。

還沒處理的缺漏（上一段清單剩下的）：
- 關鍵字提示框的 `<sprite name="" tint=1>`、瞄準曲線、材質屬性動畫、Animator 第 2 層、地圖 Boss 提示框的標題換行、開場 Boss 橫幅蓋住左上角、
  HUD 拖尾的淡、`_CameraDepthTexture`、轉換的淡入淡出、戰前介紹的 Boss 剪影（仍是藍色剪影，原版是不是剪影未查證）。

## 2026/10/17 關鍵字提示框的圖示、出牌的瞄準曲線（轉換器改了括號的轉型；Diceomancer 的產生結果不受影響）

上一段缺漏清單的前兩項。先在瀏覽器重現、找到原因再改：

- 關鍵字提示框的標題印出 `<sprite name="" tint=1>`（Valor、Revenge、Melee Weakness 等）。
  - StatusEffectsDisplayData.GetTMPSpriteTag 用 `iconSprite.name` 組標籤。iconSprite 不是 null（StatusEffectManager.displayData 的 icon 都有參照），
    是名字拿不到：Object.name 對資產參照只問物件庫（prefab、ScriptableObject、文字檔），sprite 回空字串。
  - 改法：物件庫沒有的參照再問素材庫（RenderServices.assetName → AssetDB.assetName：材質 fileID 2100000、貼圖 2800000、其他照 sprite，
    沒有 sprite 退回貼圖名，內建資源照 builtin.json）。
  - Sprite.name、pivot 一樣拿不到：相容層讀 m_Name、m_Pivot，素材庫的 SpriteInfo 叫 name、pivot。以前 Sprite.pivot 一律在中心、bounds 一律置中。
  - TMP 的 `<sprite name=…>` 本來就做了：預設 sprite asset 找得到 StatusValor 等圖示，tint=1 照 TMP 原始碼乘上 `<color>`（Valor 圖示的頂點色是 #88C701）。
- 名字補上之後，標題變成圖示一行、「Valor」另一行，壓到內文。
  - 標題寬度由 ContentSizeFitter 照 preferredWidth 給（Valor 是 87），實際排要 88 左右。偏好尺寸與產生網格對同一段字算得不一樣：
    TMP 3.2 起產生網格的字距調整看 m_ActiveFontFeatures，偏好尺寸看 m_enableKerning。MT2 的 Unity.TextMeshPro.dll 是 3.0 系列，沒有 m_ActiveFontFeatures，
    元件資料也沒有這個欄位，以前當成空清單：MT2 所有文字的網格都沒做字距調整。
  - 改法：元件資料沒有 m_ActiveFontFeatures 時（TMP 3.0 的資料），照 3.0 的 GenerateTextMesh 看 m_enableKerning。
- 出牌的瞄準曲線沒畫，只有箭頭。
  - 曲線是 GameUISpline 底下 CurveRenderer 的 UILineRenderer（UI Extensions；UIPrimitiveBase → MaskableGraphic），覆寫 OnPopulateMesh 自己產網格。
    uGUI 的 Graphic 在這個專案是執行環境原生的（cs2ts.json 的 exclude），執行環境不跑 OnPopulateMesh，VertexHelper 也沒有
    （產生碼的 vh.Clear、AddUIVertexQuad 都是 notPorted，只是從來沒走到）。拖牌時 UILineRenderer 是啟用的、有 99 個點，但沒有繪製物件。
  - 改法（csport/unityGraphicMesh.ts）：照 UnityEngine.UI 的原始碼補 VertexHelper、UIVertex（含 simpleVert）、Sprites.DataUtility 的
    GetOuterUV／GetInnerUV／GetPadding，與 Graphic 的重建：
    - OnEnable（Graphic.OnEnable 的 SetAllDirty）、SetAllDirty／SetVerticesDirty／SetMaterialDirty 記髒旗標，物件沒啟用時不記（Graphic.cs:285-309）。
      原生欄位（顏色、rect、材質）在 Unity 由屬性的 set 記髒，這裡每格比對。
    - Canvas 畫之前（willRenderCanvases，排版之後）對髒的叫 Rebuild(PreRender)；子類別覆寫了 Rebuild、UpdateGeometry、UpdateMaterial 就叫它的。
      UpdateGeometry 是 DoMeshGeneration：OnPopulateMesh(s_VertexHelper)、同一個物件上 IMeshModifier 的 ModifyMesh、FillMesh、CanvasRenderer.SetMesh；
      UpdateMaterial 把 material、mainTexture 交給 CanvasRenderer；OnDisable 清掉 CanvasRenderer 的網格（Graphic.cs:385-515）。
    - 產生的類別沒覆寫 OnEnable／OnDisable 時，Unity 叫的是原生基底那一版：core.ts 的 genBehaviour 照原生基底的 base.X() 實作補上（只看這兩個訊息）。
      以前這種類別的原生 OnEnable 從來不跑。
    - 繪製端照 UIParticle 那條 CanvasRenderer 網格路徑畫（材質、Mask／RectMask2D、排序同 Image）。走這條的類別改成照類別判斷
      （ui/canvasRenderer.ts 的 registerCanvasMeshResolver）：產生的基底鏈接到原生的 Graphic／MaskableGraphic，鏈上覆寫了 OnPopulateMesh(VertexHelper)。
      Image、RawImage、Text 的子類別照舊。
  - 轉換器：括號運算式的使用者定義轉型套了兩次。Roslyn 給括號與裡面的運算式同一個轉換，兩層都套：UILineRenderer 的
    `simpleVert.color = ((i == 0 || i == 1) ? c1 : c2)` 變成 Color32(Color32(…))，第二次把 0–255 當 0–1 夾住，0.9 的透明度變成不透明。改成括號那層不套。
- 曲線的材質與中間點：
  - CurveRenderer 的材質是 TargetingBeamV2（Shader Graphs/TargetingSplineV2，貼圖 × 頂點色，已轉出）。貼圖 TGT_Arrow_Links 是 Repeat，
    uvGenerationMode 是 FixedLength，鏈節沿曲線重複。
  - GameUISplinePoint 的中間點：兩個 GameUISpline 的 `_useCurveMesh` 都是 1，GenerateSegments 把中間點數設成 0，原版就不顯示，只畫終點箭頭與曲線網格。
  - 放開在自己的卡上時卡片保持選取（wasCardDraggedOntoSelf：點選之後再點目標），曲線跟著游標，按 Esc 取消才收起來：照原版。

UIPrimitiveBase 家族在 MT2 的用量（場景與 prefab 的元件）：
- UILineRenderer：main 場景 2 個（CardTargetingSplineUI、UnitAbilityTargetingSplineUI 的 CurveRenderer）。
- UICircle、UIPolygon、UICornerCut、DiamondGraph、UIGridRenderer、UILineTextureRenderer：0 個。
- 其他覆寫 OnPopulateMesh 的類別（NonDrawingGraphic、ShineEffect、SkeletonSubmeshGraphic、UIParticleSystem、TextPic）也都是 0 個。TextPic 繼承 Text，不走這條。

查過、不是 bug 的：
- 單位卡瞄準時曲線是白色：選取樣式（Highlighted、Valid、Invalid）給的 TargetingStartColor、EndColor 都是白色。法術卡的有效、無效顏色沒有在畫面上看到（手上沒有法術卡）。

Diceomancer 的影響：
- 轉換器：在暫存複本轉三個目標，enemies、stories 逐字相同；ui 跟進版控那份差的 11 行都是先前就有的分岔
  （new_X → newGen 5 行、屬性讀取改走 callGen 6 行），沒有一行是這次的括號修正。
- 執行環境：diceomancer-web 用的是它自己那份（src/runtime），不 import 工具包，這次的執行環境改動都不影響它。工具包裡用 Diceomancer 資料的文字測試全部照舊通過。

差異清單：
- Graphic 的髒旗標：原生欄位（顏色、rect、材質）每格比對，代替屬性的 set；pivot、錨點、所屬 Canvas 換了沒有記
  （Unity 由 OnRectTransformDimensionsChange、OnCanvasHierarchyChanged 記）。
- canvasRenderer.cull（RectMask2D 整個裁掉時跳過重建）沒做。
- materialForRendering 沒套 IMaterialModifier（Mask 的模板由繪製端照 Mask 自己算，同 Image）。
- useLegacyMeshGeneration 那條（OnPopulateMesh(Mesh)）不分開做，結果相同。
- IMeshModifier 只叫產生碼的（BaseMeshEffect 的子類別）；原生的 Shadow、Outline、PositionAsUV1 沒做（MT2 的兩個 CurveRenderer 上沒有）。
- CanvasRenderer.SetMesh 存參照（Unity 是複製）：每個 CanvasRenderer 各給一份網格，不共用 workerMesh。
- 執行期建的材質（沒有資產）還不能當 CanvasRenderer 網格的材質；沒設材質時的 Default UI Material 也還不能畫（兩個 CurveRenderer 都有材質）。
- AddUIVertexTriangleStream 照「整份換掉、索引 0..n−1」做，GetUIVertexStream 先清空清單（CanvasRenderer.SplitUIVertexStreams、CreateUIVertexStream 是原生的，未查證）。
- Graphic.GetPixelAdjustedRect、MaskableGraphic.GetModifiedMaterial 還沒做（UIPrimitiveBase.IsRaycastLocationValid 在 alpha 門檻小於 1 時才用到）。
- AssetDB.assetName 的 sprite 照 guid 找（sprites.json 只照 guid 記，一張貼圖有多個 sprite 時分不出來）。

驗證（10/17）：
- vitest 61 檔 442 個（新加 21 個）：spriteName.test.ts 6 個、graphicMesh.test.ts 12 個、kerningFallback.test.ts 3 個（字型用 Diceomancer 的 LiberationSans SDF，
  靜態字型裡唯一有字距表的）。
- 反向確認：舊版 unityScene.ts 1 個失敗、unityAssets.ts 2 個、assets.ts 2 個、textObject.ts 1 個；core.ts 拿掉原生 OnEnable 3 個、
  SetVerticesDirty 不記 1 個、不在 willRenderCanvases 重建 3 個。「物件沒啟用時不記髒」在重建次數上觀察不到（重新啟用的 OnEnable 本來就記），沒有單獨的測試。
- runtime 與 mt2-web 的 tsc 都是 0。
- 轉換器改了，npm run port 重轉：MT2 有 23 個產生檔受影響、差異 110 行。106 行是 VertexHelper、DataUtility 從 notPorted 換成真的呼叫，
  3 行是條件運算子的重複轉型，1 行是 UIParticleOverlayCamera 的 `objAlive((objAlive(…)))`（同一個括號問題）。
- 瀏覽器（Heaven's Maw 之後的 Boss 戰，Seraph Aeternus；全程例外 0、notPorted 0）：
  - Avenger 的提示框：Revenge、Valor、Melee Weakness 的標題前面有圖示，跟標題同一行；內文的 `+1⚔` 照舊。
  - 拖單位卡：曲線從卡片頂端拉到箭頭（780 個頂點、1170 個索引）；按 Esc 取消後 UILineRenderer 關掉、CanvasRenderer 的網格清掉、繪製物件隱藏。
  - 把 Avenger 拖到我方出生點打出去，能量 6 → 4；拖 Magma Cultist 停在出生點上方，曲線接到出生點。

順手發現、這次沒處理的：
- TMP 3.0 的 m_enableWordWrapping 沒讀：移植的 TMP 用 3.2 的 m_TextWrappingMode，MT2 的元件沒有，一律當成 Normal 換行。
  MT2 有 5984 個 TMP 元件關掉自動換行（520 個場景與 prefab），在移植版裡都會換行。上一段的「地圖 Boss 提示框的標題換行後跟內文疊在一起」可能就是這個（未查證）。
- parseActiveFontFeatures 的位元組順序沒換：存檔的 `6e72656b`（kern 的小端位元組）讀成 0x6e72656b，kern 是 0x6b65726e，永遠對不上。
  工具包與 diceomancer-web 那份都一樣，Diceomancer 的文字網格也從來沒做字距調整（偏好尺寸有做）。

還沒處理的缺漏（前兩段清單剩下的）：
- 材質屬性動畫（`$materialOverrides`）、Animator 第 2 層、地圖 Boss 提示框的標題換行、開場 Boss 橫幅蓋住左上角、HUD 拖尾的淡、`_CameraDepthTexture`、
  轉換的淡入淡出、戰前介紹的 Boss 剪影。

## 2026/10/17 TMP 3.0 的換行欄位 m_enableWordWrapping（Diceomancer 不受影響）

上一段「順手發現」的第一項。

- 原因：移植的 TMP 照 3.2 寫，換行看 m_TextWrappingMode（NoWrap 0、Normal 1、PreserveWhitespace 2、PreserveWhitespaceNoWrap 3），欄位不存在就當 Normal。
  MT2 的 Unity.TextMeshPro.dll 是 3.0 系列，元件只有布林的 m_enableWordWrapping。MT2 的場景與 prefab 裡 m_TextWrappingMode 0 處；
  m_enableWordWrapping 9247 個，是 0 的 5984 個（520 個檔）、1 的 3263 個。關掉換行的在移植版裡都會換行。
- TMP 3.0（反編譯 MT2 自己的 Unity.TextMeshPro.dll）：產生網格的換行與存換行點（TextMeshProUGUI.cs:1951、2450）、偏好高度（TMP_Text.cs:3500、3518）
  都只看這個布林，偏好寬度固定不換行（3463、3475），跟 3.2 的 Normal／NoWrap 兩種一樣。3.0 沒有 PreserveWhitespace 那兩種。
- 對應：3.2 的 m_TextWrappingMode 標了 `[FormerlySerializedAs("m_enableWordWrapping")]`（3.2.0-pre.4 的 TMP_Text.cs:746），舊資料的 0／1 照數值讀成
  NoWrap／Normal；廢棄的 enableWordWrapping 屬性 set 也是 `value ? 1 : 0`（同檔 733-745）。
- 改法（text/textObject.ts）：元件沒有 m_TextWrappingMode 時讀 m_enableWordWrapping 的值，兩個都沒有才當 Normal。
  Diceomancer 的場景有 m_TextWrappingMode 673 個、m_enableWordWrapping 0 個，結果不變。
- 執行期改屬性：MT2 的 C#（含一起轉的 DOTween、Febucci、Coffee 等）與產生碼都沒有讀寫 enableWordWrapping、textWrappingMode。
  有的話，相容層通用的 nativeSet 會寫進 m_enableWordWrapping（MT2 的元件有這個欄位），繪製端的重產比對整份元件資料，下一格會重排。

地圖 Boss 提示框（缺漏清單第 8 項）不是這個原因，c99fa98 的字距修正已經修掉：
- 全部的提示框都是同一個 Tooltip prefab，標題與內文的 m_enableWordWrapping 都是 1。BossTitle 樣式的提示框來自 HUD 的 BossTargetUI（地圖與戰鬥共用）、
  區域選擇的 RegionSelectionButton、開局的 BossDetailsUI。
- 在頁面上把產生網格的字距調整拿掉（模擬 c99fa98 之前），Boss 提示框裡的「Champion of Savagery」「Melee Weakness」「Rage」標題網格排成兩行、
  框只有一行高（36），壓到內文，跟缺漏的描述一樣。
- 現在的版本：地圖上三個 Boss 的提示框，標題行數都跟框高一致。「Seraph Aeternus, Chosen of Savagery」超過 360 寬，照原版排兩行，框高 61，內文接在下面。

改了以後會變的（在頁面上暫時替換排版的換行模式，同一份世界每個關掉換行的 TMP 新舊各排一次）：
- Boss 戰那份（載了 hud、main、reward、card_draft、deck 等）：關掉換行 935 個，結果不同 324 個，其中 259 個是停用、還沒排版的 0 寬物件。其他的：
  - 單位進場時頭上的狀態字（PopupNotification，寬 3）：「Melee Weakness 1」從「Melee ／Weakness 1」兩行變一行。
  - 獎勵畫面的「Skip (+10 金幣)」（270×64、自動縮放）：從兩行、字號 28.7 變成一行、字號 24。
  - 火爐頭上的 120、130：只有偏好高度變（1.03 → 0.6），畫面不變。
- 地圖那份（新存檔）：關掉換行 721 個，另外有 RunResultsMarker 的玩家名稱（停用中）偏好高度 46.9 → 23.4。
- 顯示中的標籤多半寬度本來就夠：地圖 31 個、地圖加暫停選單 36 個，修改前後逐項相同；Boss 戰顯示中的 165 個只有火爐那兩個偏好高度變。

差異清單：
- 執行期改 enableWordWrapping 不會標 havePropertiesChanged：腳本讀 textInfo 時的重排判斷（csport/unityTmp.ts 的 inputKey）沒有這個欄位。MT2 沒有程式改它。
- 3.0 與 3.2 其他的排版差異沒有逐項比對（移植照 3.2 寫），這次只補換行欄位。

驗證（10/17）：
- vitest 62 檔 448 個（新加 text/wrapFallback.test.ts 6 個：3.0 的 0／1 跟 3.2 的 NoWrap／Normal，產生網格、偏好高度、自動縮放的字號逐項相同；
  兩個欄位都有時照 m_TextWrappingMode）。換回 HEAD 的 textObject.ts 有 3 個失敗（關掉換行、偏好高度、自動縮放）。runtime 與 mt2-web 的 tsc 都是 0。
- 瀏覽器（全程例外 0、notPorted 0）：
  - 新存檔走到地圖（用 127.0.0.1 開，IndexedDB 跟 localhost 分開，不動原本的存檔）：懸停三個 Boss 圖示，提示框正常；
    地圖的區段標籤（Limbo 等，關掉換行加自動縮放）照舊。
  - Boss 戰（原本的存檔，先把 IndexedDB 備份）：Shield Steward 出到我方出生點，頭上的「Melee Weakness 1」一行。驗完還原存檔，
    重新整理接回出牌前（能量 4、兩張 Shield Steward 在手上）。
  - 獎勵畫面的 Skip 按鈕只有排版模擬，畫面上沒看到（要先打贏一場）。
- Diceomancer：diceomancer-web 用自己那份執行環境，不受影響；工具包裡用 Diceomancer 資料的文字測試全部照舊通過。

還沒處理的缺漏（前幾段清單剩下的）：
- 材質屬性動畫（`$materialOverrides`）、Animator 第 2 層、開場 Boss 橫幅蓋住左上角、HUD 拖尾的淡、`_CameraDepthTexture`、轉換的淡入淡出、
  戰前介紹的 Boss 剪影。
- parseActiveFontFeatures 的位元組順序（上一段的順手發現）。

## 2026/10/17 聲音、原生 Image 的網格效果、語言跟瀏覽器（Jason：補聲音、正體中文跟其他語系、設定選單的底色；都要經過轉換器）

聲音、語言、底色三件事，遊戲邏輯都是轉換器產生的（ShinyShoe 的 CoreAudioSystem／SoundManager、I2 Localization、UI Extensions 的 Gradient2），
缺的是 Unity 原生那一層與轉換器的排除清單。

### 聲音（csport/unityAudio.ts，新檔）

- 以前 AudioSource、AudioMixer 全是空殼，MT2 從頭到尾沒聲音。MT2 用 Unity 內建聲音（沒有 FMOD、Wwise）：2657 個 Ogg Vorbis、6 個混音器
  （MainMixer、MusicMixer、BattleMusic、Overworld、Narrative、CharacterSelect）。播放全部走 CoreAudioSystem：音效 20＋2 個 AudioSource 的物件池，
  音樂 8 個，兩個曲目槽用 MusicMixer 的 Track1／Track2 快照交叉淡入淡出，每首曲子再接自己的混音器（Overworld 的 Map／Forge／Merchant／Event 分軌）。
- 匯入器（importer/assets.py）：
  - `audiomixers.json`：.mixer 的群組樹、各群組的音量／音高參數、快照的值、曝露參數、m_OutputGroup。效果器只有 Attenuation（就是群組音量）。
  - `audioclips.json` 多 channels、frequency、samples：Ogg 的 identification header 與最後一頁的 granule position（AudioClip.length ＝ samples / frequency）。
- 曝露參數的名稱：build 只存 CRC32（UnityPy 讀原版 sharedassets0：MainMixer 的 exposedParameterNames 是 [3575369835, 1797338918]），
  AssetRipper 補的 mposwoH、hkkpiSL 跟 MusicVolume、SfxVolume 的 CRC32 相同。執行環境照 CRC32 比對 AudioMixer.SetFloat 的名稱，不用另外讀原版檔。
- 執行環境（Web Audio）：
  - 混音器每個群組一個 GainNode（dB → 倍率，−80 dB 當 0），子群組接父群組、主群組接 m_OutputGroup（或執行期設的 outputAudioMixerGroup），
    最後經過 AudioListener 的節點到 destination。參數從起始快照開始；TransitionTo(t) 在 t 秒內照 dB 線性插（Unity 的預設曲線未查證），
    照混音器的 updateMode 用 Time.time 或 unscaledTime；SetFloat 設過的參數不跟快照走，ClearFloat 才回來。
  - AudioSource：clip、volume、pitch、loop、mute、outputAudioMixerGroup；Play、PlayDelayed、PlayScheduled、Stop、Pause、UnPause、PlayOneShot。
    進度照邏輯時鐘（performance.now，同 AudioSettings.dspTime）算，isPlaying、time 不看 AudioContext：瀏覽器在第一次點擊或按鍵之前不准出聲，
    遊戲照樣走，CoreAudioSystem 每格看 isPlaying 回收物件池。能出聲之後，不循環的音效只在開始播的當下出聲（錯過的不補，不然第一次點擊會一起放出來），
    循環的（音樂、環境音）照進度接上。clip 第一次播時才下載解碼（UnloadAudioData 放掉）。元件停用、物件關掉、銷毀時停。
  - 開機（viewer/boot.ts）叫 mountAudio 讀兩張表，第一次 pointerdown／keydown／touchend 時 resume AudioContext。
- OnApplicationFocus（csport/unityScene.ts 的 installApplicationFocus）：以前沒送。SoundManager 照它重算音量（設定的「背景靜音」）。
  視窗 focus／blur 時排在下一格開頭送給啟用中的 MonoBehaviour（停用的收不收得到未查證）。
- 舊的空殼拿掉：unityNative.ts 的 AudioSource、unityAssets.ts 的 AudioMixer／AudioListener／AudioSettings、unity.ts 的 AudioClip.Load／UnloadAudioData。
- 沒做（差異清單）：3D 聲音（spatialBlend、距離衰減）、playOnAwake（MT2 的場景與 prefab 沒有 AudioSource 元件）、PlayOneShot 不算進 isPlaying、
  群組的音高與 Attenuation 以外的效果器（MT2 沒有）、AudioListener.pause 只靜音不暫停進度、Timeline 的 Audio track（MT2 的 43 個 Timeline 都沒引用 AudioClip）。
  Safari 能不能解 Ogg Vorbis 未查證（Chromium 可以）。

### 原生 Image 的網格效果（設定選單的底色）

- 設定選單的內框是淺灰的 DP_Bg_Banner，同一個物件上掛 Gradient2（UI Extensions 的 BaseMeshEffect：垂直漸層 (0.45, 0.08, 0.06) → (0.15, 0.02, 0.035)，
  Multiply）。Image 由繪製端照元件欄位產網格，以前不叫同一個物件上的 ModifyMesh，漸層沒套，露出淺灰原圖。
- 同一條路沒套的：MT2 的場景與 prefab 裡掛在 Image 上的 UIFlippable 220 個（左右翻轉；HUD 的牌組、選項、局資訊底板）、Gradient2 77 個（23 個場景的對話框底）、
  Outline 26 個、PositionAsUV1 2 個；Shadow 30 個掛在舊版 Text 上（Text 這次沒接）。
- 轉換器：mt2-web 的 cs2ts.json 把 BaseMeshEffect、Shadow、Outline、PositionAsUV1 從排除清單拿掉，改從反編譯的 UnityEngine.UI 原始碼轉
  （轉不動 1295 → 1289 處）。它們用到的 UnityEngine.Pool.CollectionPool 補在 csport/unity.ts：轉換器對 DLL 的泛型靜態類別把型別引數接在後面傳
  （"List$1<UIVertex>"），照集合種類建空的，Release／PooledObject.Dispose 清空。RoomState.UpdateAttachments（車廂附加物）的 CollectionPool 以前也是 notPorted。
- 執行環境：ui/graphicMeshModifier.ts 開一個掛勾，csport/unityGraphicMesh.ts 照 Graphic.DoMeshGeneration 實作：Image.OnPopulateMesh 的結果
  （位置、Color32 的 m_Color、uv0；法線、切線用 VertexHelper 的預設）進 VertexHelper，同一個物件上的 IMeshModifier 依元件順序叫 ModifyMesh
  （停用的也叫，Unity 用 GetComponents，各自看 IsActive）。繪製端（render/sceneRenderer.ts 的 addImage）拿改完的位置、uv、三角形與逐頂點顏色畫，
  顏色再乘 CanvasRenderer 顏色、轉線性、乘 CanvasGroup。修改器的種類、啟用與欄位放進重產鍵。
  有修改器的節點照場景樹的 membershipVersion 快取：MT2 戰鬥 1482 個啟用中的 Image、有修改器的 3 個，每格的檢查從 0.88 ms 降到 0.07 ms。

### 語言

- 正體中文與其他九種語系的翻譯、字型本來就在：I2 Localization 整個在 Assembly-CSharp 裡一起轉，翻譯在 Resources/I2Languages_Translations.asset，
  CJK 與西里爾字母用靜態 SDF 字型（NotoSansTC／SC／JP／KR、RussoOne…）。缺的是啟動時的語言：
  I2 的 SelectStartupLanguage 先問 PlatformServices.GetPlatformLanguage（Steam 的介面語言，tchinese → zh-TW），
  相容層的 SteamUILanguage 以前固定回 english，沒有存過語言設定的存檔一律從英文開始。
- 改法（csport/steamworks.ts）：Steam 介面語言在網頁上對應瀏覽器語言（navigator.languages 的第一個），換成 Steam 的語言名
  （zh-TW／zh-HK／zh-MO／zh-Hant → tchinese、其他中文 → schinese、pt-BR → brazilian、西班牙以外的 es → latam…）。之後照原版：
  GoogleLanguages.GetLanguageName("zh-TW") 是 Chinese/Taiwan，GetSupportedLanguage 對到 MT2 語言表裡的「Chinese (Traditional)」（代碼掛 zh-HK 是歷史包袱，
  內容就是臺灣用的正體中文）。遊戲自己存的語言設定（PreferencesManager.Language）照樣優先。
- 原版在跑局中把語言選單鎖住（SettingsDialog.cs:288，只有主選單與 Soul Savior 能改）；跑局中改語言，已經排好的字不會重刷，原版也一樣。

驗證（10/17）：
- vitest 64 檔 465 個（新加 audio.test.ts 10 個：CRC32、GetFloat／SetFloat／ClearFloat、FindSnapshot、TransitionTo 的線性過渡、SetFloat 不跟快照、
  outputAudioMixerGroup、AudioClip.length、播放進度與播完、物件關掉就停、PlayScheduled；meshModifier.test.ts 7 個：原生 Image 的修改器、
  沒有修改器回 null、簽章跟著欄位與啟用變、CollectionPool 兩個、Steam 語言對應兩個）。runtime 與 mt2-web 的 tsc 都是 0。
- 瀏覽器（新開的 localhost:5180，IndexedDB 跟原本的存檔分開；全程例外 0、notPorted 0）：
  - 聲音：標題畫面的音樂照邏輯在播（第一次點擊之前 AudioContext 不存在）；點擊後 running，點擊音效走 MainMixer/SFX。
    地圖：火車待機循環＋Overworld 四軌、快照只開 Map（−2 dB）；戰前介紹的環境音；戰鬥：BattleMusic/Base 與戰鬥環境音。
    輸出端的 RMS 約 0.06（地圖），音樂音量設 0 時 Music 群組到 −80 dB、RMS 剩 0.002（只剩火車待機音效），調回 100 恢復 −7.4 dB
    （整體 70：20·log10(0.7) ＝ −3.1，加上原本的 −4.28）。耳朵沒聽，只看電平。
  - 底色：設定選單與戰前介紹的面板變成深紅漸層；HUD 有 5 個 UIFlippable 的 Image 照原版翻轉。
  - 語言：瀏覽器 zh-TW 開新存檔直接是正體中文。日文、韓文、俄文、簡體、法文各重新整理進戰鬥看教學對話框，字型與翻譯都對；
    德文、西班牙文、巴西葡萄牙文跟法文同一套拉丁字型，沒逐一截圖。主選單的語言下拉選單沒點到（新手局的暫停選單回不了主選單），
    切換走的是同一條 PreferencesManager.Language。
- 戰鬥一格平均 12.3 ms（120 格，Mac）。
- Diceomancer：diceomancer-web 用自己那份執行環境與匯入器，不受影響；工具包裡用 Diceomancer 資料的測試照舊通過。

還沒處理的缺漏（前幾段清單剩下的）：
- 材質屬性動畫（`$materialOverrides`）、Animator 第 2 層、開場 Boss 橫幅蓋住左上角、HUD 拖尾的淡、`_CameraDepthTexture`、轉換的淡入淡出、
  戰前介紹的 Boss 剪影（下一段修掉）。
- parseActiveFontFeatures 的位元組順序。
- 舊版 Text 的網格效果（Shadow 30 個）：Text 的網格路徑還沒接修改器。
- 整局還沒打完過（後面幾層、最終 Boss、結算），手機版沒做。

## 2026/10/17 戰前介紹的 Boss 是藍色剪影：clip 空間 z 的 D3D 慣例（Jason 指出；Diceomancer 不受影響）

- 現象：進關卡前的介紹畫面，Boss 整隻是淺藍色的實心剪影。原版 BattleIntroEnemy.Set 叫 TryInstantiateCharacter 時 isInSilhouette 是 false，不是剪影。
- 原因：淺藍是霧的顏色 (0.51, 0.74, 0.95)。battle_intro 是 active 場景，RenderSettings 開線性霧 100–3500，角色的材質是
  Shader Graphs/CharacterShader2.0（Built-in Lit），走 FOG_LINEAR 變體。shader 是 DX11 bytecode，霧的距離照 D3D 寫死：
  vertex 把 clip z 原樣傳給 fragment，fragment 算 max((1 − z/_ProjectionParams.y)·_ProjectionParams.z, 0)（UNITY_Z_0_FAR_FROM_CLIPSPACE）。
  Unity 在 D3D 上給的是反向深度的 GPU 投影矩陣（near 的 clip z ＝ w、far ＝ 0），正交攝影機（near 0.3、far 1000）前 22 的角色算出負的、夾成 0，
  沒有霧；這裡給的是 three.js 的 GL 投影（near −w、far +w），算出約 4190，超過霧的終點 3500，整隻變成霧色。
- 改法：
  - render/sceneRenderer.ts 的 d3dProjection：K3 shader 拿到的 unity_MatrixVP、unity_MatrixP、glstate_matrix_projection（與反矩陣）改成 D3D 的
    GPU 投影矩陣，只換第三列 z_d3d ＝ (w − z_gl) / 2；x、y、w 不變（這裡畫進自己的 render target，不翻 y，跟以前一樣）。
  - render/unityShader.ts 的 d3dClipToGl：vertex shader 的 main 改名、包一層，最後 gl_Position.z ＝ w − 2·z，換回 GL 的範圍。
    換算前後的深度數學上相同（正交與透視都是），深度測試不變。手寫的 shader（UI/Default 等）不經過這裡。
- 影響範圍：9020 個轉出的 vertex shader 裡，把 clip z 另外傳給 fragment 的 1449 個，幾乎都是霧（FOG_*）或陰影（SHADOWS_SCREEN，繪製端沒開）的變體；
  Shiny Shoe/Character Shader 的 ComputeScreenPos 帶著 z，但 fragment 沒讀。A/B 對照（?scene=main、?scene=map，animate=0，同一格 canvas 逐像素）：
  修改前後 248 萬個像素 0 差。
- 驗證：vitest 65 檔 469 個（新加 render/clipDepth.test.ts 4 個：正交與透視的 near→1、far→0、換回 GL 的深度相同；戰前介紹的霧距離 D3D 沒霧、
  GL 整隻霧色；vertex shader 的包裝）。runtime 與 mt2-web 的 tsc 都是 0。瀏覽器（127.0.0.1:5180 新存檔）：首次設定 → 開場影片 → 地圖 → 戰前介紹，
  Fallen Champion 照原色畫出來（盔甲、盾、紅色翅膀）；進戰鬥畫面不變；全程例外 0。
- 順便驗到：首次設定畫面的語言下拉選單展開十個語系，點日本語整個面板當場換成日文，再切回中文（繁體）。

還沒處理的缺漏（前幾段清單剩下的）：
- 材質屬性動畫（`$materialOverrides`）、Animator 第 2 層、開場 Boss 橫幅蓋住左上角、HUD 拖尾的淡、`_CameraDepthTexture`、轉換的淡入淡出。
- parseActiveFontFeatures 的位元組順序。
- 舊版 Text 的網格效果（Shadow 30 個）：Text 的網格路徑還沒接修改器。
- 整局還沒打完過（後面幾層、最終 Boss、結算），手機版沒做。

## 2026/10/17 標題畫面一進去就有 BGM：開機就建 AudioContext（Jason 指出；Diceomancer 不受影響）

- 現象：原版標題畫面（按任意鍵開始）一出來就有音樂，網頁版要點一下才開始播。
- 原因：標題畫面出來時遊戲已經在播 MUSIC_CovenantOutpost_Main／Variant（循環，Narrative 混音器的 Base／Alt），邏輯進度照走，
  但 csport/unityAudio.ts 的 AudioContext 是第一次要用時才建，實際上是第一次點擊或按鍵（installGestureResume 叫 audioCtx()）才 `new AudioContext()`。
  瀏覽器在建立的當下決定能不能直接跑（Chrome 文件 developer.chrome.com/blog/autoplay：手勢前建的 AudioContext 是 suspended，
  允許自動播放的情況是跟這個網域互動過、桌面版 Media Engagement Index 過門檻、加到主畫面或裝成 PWA；Web Audio 規格：建構時「allowed to start」才開始處理）。
  所以就算瀏覽器允許，也要點一下才有聲音。修前在瀏覽器面板量：標題畫面 `__audio()` 的 context 是 `none`、兩條音樂 node false，
  同一個頁面另外 `new AudioContext()` 一建就是 running。
- Diceomancer 的做法（diceomancer-web a76747a，fmodRuntime.ts 的 startOutput）：FMOD HTML5 原本在 window 掛 click／touchend 才 resume；
  APK（UA 帶 DiceomancerApp，WebView 關掉手勢要求）或 `navigator.userActivation.hasBeenActive` 時初始化完直接 resume。
  這裡不認 UA：Web Audio 由瀏覽器在建立時判斷，直接開機就建，WebView、Chrome、Firefox 都照各自的政策決定；不允許的照舊等第一次手勢。
- 改法：mountAudio 在讀完聲音的表、掛好手勢監聽後就呼叫 audioCtx()；建立時已經是 running 不會有 statechange，自己叫一次 resumePlaying。
  不允許時不在開機呼叫 resume()（沒有手勢的 resume 只會在主控台多一條警告），第一次 pointerdown／keydown／touchend 照舊 resume，
  循環的音樂照邏輯進度接上（例如標題畫面停了 2.5 秒才按鍵，音樂從 2.5 秒接著播）。
- 瀏覽器限制下的極限：第一次開、沒跟 localhost 互動過、MEI 不夠的 Chrome，還是要等「按任意鍵」那一下（標題畫面本來就要按），不能更早；
  這是瀏覽器政策，網頁沒有繞過的方法。
- 驗證：vitest 67 檔 481 個（新加 csport/audioAutoplay.test.ts 2 個，用假的 AudioContext：允許時 mountAudio 就建好、沒有手勢循環音樂一播就出聲；
  不允許時開機建成 suspended、不出聲，允許之後照邏輯進度 2.5 秒接上。換回 HEAD 兩個都失敗：context 是 none、沒建）。runtime 與 mt2-web 的 tsc 都是 0。
  瀏覽器（localhost:5180 重新載入，沒按鍵）：標題畫面 context running、MUSIC_CovenantOutpost_Main／Variant 都有 node、輸出 RMS 0.03–0.06；Jason 確認修好。
  這次量的頁面之前有互動過（userActivation.hasBeenActive 是 true），第一次開、完全沒互動的情況沒在 Chrome 上另外量。

## 2026/10/17 新存檔的開場影片整段黑畫面：攝影機平面的影片要在目標攝影機那一趟畫（Jason 指出；Diceomancer 不受影響）

- 現象：清掉存檔重開，遊戲照原版進 intro_fmv（IntroFmvScreen），整段 90 秒都是黑的，字幕與跳過提示照常，影片播完照常進第一局。
- 原因：`<video>` 有在播（瀏覽器量：readyState 4、currentTime 9.2／90、沒暫停），只是沒畫出來。原版 VideoPlayerUnity.Awake 設
  renderMode ＝ CameraFarPlane、targetCamera ＝ Camera.main（intro_fmv 的 Main Camera，Clear Flags 是 Solid Color、黑色）。
  Unity 手冊（VideoRenderMode）：CameraFarPlane 畫在「那台攝影機的場景後面」，CameraNearPlane 畫在「場景前面」。
  b966975 加 built-in 管線的多台攝影機時，遠平面的影片仍在全部攝影機之前畫，接著 Main Camera 清成黑色就蓋掉了；近平面也是全部攝影機之後才畫。
- 改法：
  - csport/unityVideo.ts 的 videoLayers 多給 targetCamera 的 Camera 元件。
  - render/sceneRenderer.ts：built-in 管線在每台攝影機那一趟裡畫 targetCamera 是它的影片（videosForPass），遠平面在它清完背景之後、畫物件之前，
    近平面在它畫完之後；縮放照那台攝影機的 viewport。有 targetTexture 的攝影機、有後製（畫進中繼 target）的攝影機同樣處理。
    沒有攝影機的舊管線照舊整個畫面畫。
- 驗證：vitest 67 檔 483 個（render/videoLayer.test.ts 新加 2 個：遠平面只在 targetCamera 那一趟、別台攝影機不畫，cam 是 null 時照遠近全部畫；
  換回 HEAD 兩個都失敗）。runtime 與 mt2-web 的 tsc 都是 0。瀏覽器 localhost:5180：清掉存檔（IndexedDB unity-cs2ts-vfs 與 localStorage）重開，
  修前 intro_fmv 整段黑、builtinStats 是 Main Camera clear 2 之前就畫了影片；修後 Jason 走開場影片確認看得到。我這邊沒有另外截修後的影片畫面。

## 2026/10/17 開局畫面按確定，起始牌只剩文字飛走：換父物件之後的 Canvas 排序（Jason 指出；Diceomancer 不受影響）

- 現象：新的一局開始時的開局畫面（三張起始牌、這一局 Boss 的屬性），按確定之後牌的圖片先不見，只剩文字飛走。
  （同一輪順便確認：教學關第 0 段本來就沒有節點，正常的一局第一段有寶箱和鐵砧，跟 Jason 手機上的原版一致，不是缺漏。）
- 原因：原版 RunOpeningScreen.Close 對每張牌叫 FloatingRewardManager.CreateFloatingRewardFromObject，把牌本身 SetParent 到
  HUD 的 Tooltip Canvas（order 43）底下的 FloatingRewardsContainer 再飛向牌組，開局畫面接著淡出。牌的 CardCanvas 是巢狀 Canvas、
  沒開 overrideSorting，排序跟上層的 Canvas 走。繪製端的排序鍵前兩項（sorting layer、order）只在建網格時算一次，每格只更新樹順序與深度：
  換父物件後牌的 Image 還排在開局畫面的 order 11，被淡出中的畫面蓋住；文字飛行中重產網格，拿到新的 order，所以只看到文字。
  瀏覽器量：Close 之後牌在 Tooltip Canvas 底下，Image 的排序鍵還是 (Overlay, 11)。Unity 的 Graphic 換父物件時重新登記 Canvas（OnTransformParentChanged）。
- 改法：render/sceneRenderer.ts 抽出 canvasSortLayerOrder（四個建鍵處共用）與 refreshCanvasSortKey：refreshOrderKeys 每格對 Canvas 底下的
  繪製物件（Image、RawImage、TextMeshProUGUI、CanvasMesh、Mask 的 unmask）照節點目前的 Canvas 重算這兩項，變了就重新排序。
  成本：開局畫面 1345 個繪製物件，整趟 refreshOrderKeys 0.066 ms。
- 驗證：vitest 68 檔 486 個（新加 render/canvasSortRefresh.test.ts 3 個：巢狀 Canvas 照上層的 order、換到 Tooltip Canvas 後重算成 43、
  不是 Canvas 的繪製物件不動；換回 HEAD 三個都失敗）。runtime 與 mt2-web 的 tsc 都是 0。瀏覽器 localhost:5180：開局畫面按確定，
  三張牌整張（卡框、卡圖、文字）依序縮小飛向牌組，畫面淡出後進地圖。原版這一段的實際畫面沒有逐格對照，等 Jason 看。
- 同一輪看到、還沒處理：回主選單時 TransformTweenMixerBehaviour.OnBehaviourPlay 缺 PlayableBehaviour 的原生 base 方法（NotPorted）；
  地圖上 CharacterState.Update 的 CharacterUIMeshSpine.GetAnimInfo 讀到 undefined 的 animInfos（數百次）。
- 同一輪 Jason 指出：新遊戲設定按「出發」之後，開局畫面要晚好幾秒才出現（改之前的版本 9f700e1 一樣）。下一段修掉。

## 2026/10/17 第一次開新局，開局畫面晚好幾秒才出現：執行期子樹的貼圖先讀（Jason 指出；Diceomancer 不受影響）

- 現象：頁面載入後第一次開新局，新遊戲設定按「出發」之後，三張起始牌的開局畫面要等好幾秒才出現；同一頁再開第二局就快。
- 原因：viewer/boot.ts 的 subtreeHooks.added 把執行期新增的子樹（場景載入、Instantiate）串在同一條 pending 鏈上依序 addSubtree，
  建網格時才讀貼圖（AssetDB.texture，有快取），所以第一次讀貼圖也跟著一個一個排隊。量測（重新整理後第一局，Jason 操作）：
  排了 62 個子樹共 5.3 秒，地圖的節點圖示（POIart_Map_*，每個 16、17 個節點）每個 250–400 ms，幾乎都在等 db.texture／bindTextures；
  開局畫面的 Canvas 在第一個子樹開始後 4.6 秒才輪到，自己又花 924 ms，這段期間 RunOpeningScreen 已經啟用、畫面上沒有它。
  同一頁的第二局貼圖都在快取裡：60 個子樹 0.15 秒、開局畫面 18 ms。
- 改法：子樹一排進佇列就先同時開始讀它要用的貼圖，建網格照舊依序。unity/assets.ts 的 textureKeysIn 從元件資料找出貼圖 key
  （Sprite 的 m_RD.texture、Material 各貼圖屬性的圖、直接參照的 Texture；只往下走 6 層、走過的物件不重走），
  render/sceneRenderer.ts 的 prefetchSubtree 對子樹裡還沒建過的元件呼叫 db.texture（錯誤吞掉，建網格時照舊處理），boot.ts 在 added 時先叫它。
- 驗證：vitest 69 檔 488 個（新加 unity/textureKeys.test.ts 2 個；換回 HEAD 兩個都失敗）。runtime 與 mt2-web 的 tsc 都是 0。
  瀏覽器 localhost:5180 重新整理後第一局（Jason 操作、我只記錄）：88 個子樹建網格合計 1.09 秒，地圖節點圖示平均 3 ms、最多 73 ms；
  開局畫面在第一個子樹開始後約 3.2 秒看得到（修前約 5.5 秒），它自己的 Canvas 70 ms。Jason：「第一次明顯快很多」。
  剩下的時間是場景載入與遊戲邏輯，沒有再拆。

## 2026/10/17 PlayableBehaviour 的原生 base 方法、元件裡沒序列化的 List 預設 null（上上段記下的兩個例外；Diceomancer 不受影響）

- 例外一：開新局時 TransformTweenMixerBehaviour.OnBehaviourPlay 丟 NotPorted（缺 base_PlayableBehaviour_OnBehaviourPlay）。原版覆寫裡先叫
  base.OnBehaviourPlay(playable, info)，產生碼是 R.nativeBase，PlayableBehaviour 的方法沒登記。UnityCsReference 的
  Runtime/Export/Director/PlayableBehaviour.cs：OnGraphStart、OnGraphStop、OnPlayableCreate、OnPlayableDestroy、OnBehaviourDelay、
  OnBehaviourPlay、OnBehaviourPause、PrepareData、PrepareFrame、ProcessFrame 都是空的 {}，Clone 是 MemberwiseClone。
  改法：csport/unityPlayables.ts 把這些登記成 PlayableBehaviour 的原生 base（空的；Clone 直接淺複製，不走 dllVirtual，免得叫回覆寫自己）。
  Assembly-CSharp 裡叫 PlayableBehaviour 的 base 方法的只有這一處。
- 例外二：新遊戲設定畫面起（不只地圖）CharacterState.Update 每格丟 TypeError「reading 'animInfos'」，在 CharacterUIMeshSpine.GetAnimInfo 的
  modelVariations[modelIndex]。瀏覽器看：丟例外的是 run_setup 的 Character_Fel_ClassSelect（選氏族畫面的勇士），它的 CharacterUIMeshSpine
  沒跑過 Setup，modelVariations 是空清單（C# 這裡是 ArgumentOutOfRangeException）。原版的流程：ClassSelectCharacterDisplay.Show 在
  characters == null 時抓子物件的 CharacterState、逐一 PlayIdleWithoutSetup，後者 Setup 網格並把 CharacterState 停用（base.enabled = false），
  Update 就不會跑。產生碼的 initAi 把 characters（private List<CharacterState>，沒有 [SerializeField]、沒有初值）預設成 []，
  characters == null 不成立，PlayIdleWithoutSetup 從沒叫過，CharacterState 一直啟用。是轉換器的問題，不是資料或相容層。
  改法：converter/Program.cs 的 initAi，元件（UnityEngine.Object 的子類別）裡 Unity 不序列化的集合欄位（private 沒 [SerializeField]、
  [NonSerialized]、readonly、型別序列化不了；[SerializeReference] 不算），沒有初值時用 C# 的預設 null，不再一律 []；Unity 序列化的 List
  照舊是空清單。判斷抽成 UnitySerializedField，跟 serialized 欄位清單共用。MT2 的產生碼變了 71 個欄位（舊轉換器重產一次逐檔比對），
  都是 `: []` 變 `: null`，例如 _boneFollowers、Timeline 的 m_CacheRootTracks、各畫面的 UI 清單。diceomancer-web 用自己那份
  scripts/csport，不受影響。
- 驗證：vitest 70 檔 492 個。csport/playables.test.ts 新加 2 個（覆寫裡叫 base.OnBehaviourPlay／OnBehaviourPause 照跑、其他回呼的 base
  不做事與 base.Clone 淺複製；換回 HEAD 的 unityPlayables.ts 兩個都失敗）；新加 csport/componentFieldDefault.test.ts 2 個，讀 mt2-web
  的產生碼（要先 npm run port）：characters、_boneFollowers 是 null、modelVariations 是 []；換回舊轉換器的產生碼，第一個失敗。
  runtime 與 mt2-web 的 tsc 都是 0。瀏覽器 localhost:5180（面板沒在畫面上，用 __step／__tap 推進）：主選單 → 新遊戲設定 → 開局畫面 → 地圖
  → 回主選單 → 再開一局 → 第一場戰鬥的部署階段，__report().exceptions 一路是 0；修前新遊戲設定畫面就 ×274。顯示中的費爾 CharacterState
  已停用（PlayIdleWithoutSetup 有跑），選氏族畫面的勇士照常顯示。在 TransformTweenMixerBehaviour.OnBehaviourPlay 掛計數：開新局叫到 1 次、
  沒丟例外；回主選單這一趟沒叫到。
- 沒處理：不是 UnityEngine.Object 的資料類別，沒有初值的 List 欄位一律 R.serializedListDefault()（反序列化時給空清單），沒分 Unity 序列化不序列化；
  [NonSerialized] 的 List 在 JsonUtility 反序列化後照 Unity 應該還是 null（未查證）。這輪沒看到它造成的問題。

## 2026/10/17 主選單第一次的劇情對話沒有字幕、跳過也關不掉：Material.SetInteger(string, int)（Jason 指出；Diceomancer 不受影響）

- 現象：新存檔第一次進主選單，CharacterDialogueScreen 的劇情對話只顯示三個角色，沒有對話框與字幕；按 Esc 確認跳過也關不掉，主選單被擋住。
  __report() 有一個例外：協程 NotPorted「CharacterDialogueScreen.cs:1583 .SetInteger("_BlurEnable", 1)（缺 Material_SetInteger$string_int）」。
- 原因：ParseCommand_SetActive 切換說話的角色時對角色材質叫 SetInteger("_BlurEnable", 1)；相容層只登記了 int 鍵的
  Material_SetInteger$int_int，轉換器對 string 鍵那個多載產生 notPorted。對話的主協程在第一個 setactive 指令就死掉，後面的字幕、
  跳過時讀 skipDialogue 的迴圈都不會再跑。materials.json 3291 個材質與轉出的 shader 都沒有 _BlurEnable／_BlurRadius，
  原版這行等於設一個沒人讀的值，畫面不受影響。
- 改法：csport/unityNative.ts 補 Material_SetInteger$string_int 與 GetInteger。照 2022.3 手冊，SetInteger 設的是整數屬性
  （序列化裡的 m_Ints，繪製端在 m_Floats 之後讀它）；SetInt 是「SetFloat 的別名、值轉成 float」，照舊寫 m_Floats。
  以前 Material_SetInteger$int_int 也指到 SetFloat，一起改成寫 m_Ints（MT2 產生碼沒有呼叫者）。MT2 重轉，產生碼只差這一行。
- 驗證：vitest 71 檔 494 個（新加 csport/materialInteger.test.ts 2 個；HEAD 沒有這兩個 export，換回去直接失敗），runtime 與 mt2-web 的
  tsc 都是 0。瀏覽器 localhost:5180：主選單的對話有對話框與字幕，說話的角色亮、其他變暗，換背景、閃回（去色加暗角）都有，
  一路點完回到主選單，例外 0、notPorted 0；跳過由 Jason 手動測過正常。看過的對話會記在存檔，重新整理後不再出現。
- 順手看到沒修：RoomCorruptionFX.cs:33 的 Animator.SetInteger 也是 notPorted（戰鬥房間的腐化特效，這輪還沒走到）。

## 2026/10/17 戰前畫面的試煉名稱與說明是 prefab 的英文佔位字：同一個泛型介面的多種封閉型別（Jason 指出；Diceomancer 不受影響）

- 現象：第一場戰鬥的戰前畫面，試煉欄顯示「Explosive Sigil／Enemy units will explode for 1 damage on death.」，其他文字都是中文。
  存檔裡的試煉其實是 Enemy_TitanskinT1（Tough as Nails），這兩句是 battle_intro 場景 RelicInfoUI 的 TMP 預設 m_text，執行期沒被蓋掉。
- 原因：BattleIntroScreen.SetupScenarioTrial 用 GameObjectUtil.PopulateViewList<RelicState, RelicInfoUI> 填清單，裡面叫
  IDataView<DataType>.Set(data, index)。RelicInfoUI 實作了三種 IDataView：<RelicState>、<RelicData>（都在基底 RelicTooltipProvider）、
  <CollectableRelicData>（明確介面實作，產生名 IDataView$1$Set）。產生碼的介面名不帶型別引數，callIface 看到「介面$方法」就用，
  RelicState 被當成 CollectableRelicData 傳進 Set(RelicData)，例外又被 GenericPopulateViewList 的 try/catch 吞成 Log.Error。
  同樣的撞名在 MT2 有 14 個類別（CardChoiceItem 的 CardData／CardState、UpgradeCardChoiceItem、SoulInfoUI、SettableLabel…）。
- 改法：轉換器在「同一個泛型介面實作了兩種以上封閉型別」的類別輸出 ifaceImpls（「介面<型別引數>$成員」→ 實作的產生名，照 Roslyn 的
  FindImplementationForInterfaceMember；型別引數含型別參數的不寫）。原始碼宣告的泛型介面的呼叫端改成 R.callIfaceT，多帶型別引數
  （TypeRef，方法的型別參數就是 __T_DataType 這類執行期值）；runtime 的 callIfaceT 沿實際類別的基底鏈查 ifaceImpls，找到就照實際類別
  虛擬分派，沒有對照表照舊走 callIface。.NET 的泛型介面（IEqualityComparer<T>、IDictionary<K,V>）不改。MT2 重轉：14 個類別加 ifaceImpls、
  30 處呼叫端改 callIfaceT，其他產生碼不變。
- 驗證：vitest 72 檔 496 個（新加 csport/ifaceGeneric.test.ts 2 個：照型別引數分到三個實作、覆寫照實際類別、沒有對照表時跟 callIface 一樣），
  runtime 與 mt2-web 的 tsc 都是 0。瀏覽器 localhost:5180 第二場戰鬥的戰前畫面，試煉名稱與說明是中文，Jason 看過確認。

## 2026/10/17 戰鬥中 new bool?(false) 是 NotPorted，戰鬥結束畫面不出來：Nullable 的外部建構（Jason 指出；Diceomancer 不受影響）

- 現象：第一場戰鬥打到最後，敵人都清掉了，戰鬥結束畫面沒出來。__report() 有一個例外：DOTweenComponent.Update ×1 的
  NotPorted「new Nullable(…)：外部型別的建構子參數還沒對應」，在 CombatManager.GetTargetCharacters。
- 原因：原版 CombatManager.cs:1916 的 firstEffectInPlayedCard = (flag ? new bool?(false) : null)，轉成 R.newExternal(c, "Nullable", false)；
  相容層的 Nullable<T> 是「值或 null」（Nullable_get_HasValue 是 v != null），但 new 沒登記。同樣的寫法 MT2 還有 3 處
  （ClanChecklistSection 的 DLC?、DraftRewardData 的 rarityCeilingOverride、TooltipContainer 的 TooltipWidth?）。
- 改法：dotnetBcl.ts 登記 Nullable 的外部建構：new T?(x) 回 x，new T?() 回 null。
- 驗證：vitest 73 檔 497 個（新加 csport/nullableCtor.test.ts 1 個），runtime 與 mt2-web 的 tsc 都是 0。卡住的那場已經壞掉，用原版的
  EndBattle 作弊（SaveManager.Cheat_EndBattle）結束、拿到勝利畫面；修正後還沒在瀏覽器重現同一張牌的情況。

## 2026/10/18 開機載入：依賴閉包打包、網格一個一個檔、同一個檔只抓一次（Jason：手機開機比一般遊戲久很多；Diceomancer 不受影響）

- 現象：MT2 從開機到標題畫面，瀏覽器抓 5164 個檔、303.6 MB。4351 個是 ScriptableObject（objects/*.json），275 個 prefab，
  meshes.json 一個檔 91 MB，materials.json、monobehaviours.json、texts.json、project.json 與 33 個 TMP 物件各抓兩次。
  原版開機時 AllGameData 參照到整個遊戲資料庫，Unity 載場景時把閉包全部同步載好，執行環境照做（objectStore.ts 的 preload），
  這部分是原版行為。APK 每個請求都要經過 WebView 攔截、從 APK 讀、解壓，請求數本身就是成本。
- 改法（只改怎麼拿到檔案，載哪些資產、什麼時候載照舊）：
  - 匯入器新步驟 packs（importer/packs.py，all 會跑）：照執行環境同一套閉包規則算開機（Resources ＋ build 第 0 個場景 ＋ 全部 TMP 物件）
    與 build 順序裡各場景的閉包，併成不超過 8 MB 的包。單檔照樣留著。
  - meshes.json 拆成 meshes/<guid>.json 與 meshes/index.json；物件庫把網格當成閉包的一部分（Unity 也是），AssetDB.mesh(ref) 只抓用到的那個。
    舊的整包 meshes.json 照舊讀得到（沒有 meshes/index.json 時）；只有舊輸出時跑 `run.py packs` 會順便拆。
  - unity/packs.ts：fetchJsonCached（同一個網址只抓一次、內容共用，給索引表、ScriptableObject、TMP 物件、網格）與
    fetchJsonOnce（不留快取，給場景檔與 prefab：載入時會被改）。packs/index.json 裡的路徑從包裡拿，開機那組一裝好就開始抓。
- 量測（這台的 headless Chromium，正式版 bundle，到 IntroStartScreen 出現）：
  - 改前：5164 個請求、303.6 MB、5.3 秒；CPU 降速 4 倍 15.9 秒。
  - 改後：551 個請求、214.1 MB、4.1 秒；CPU 降速 4 倍 550 個請求、12.6 秒。重複的請求 0 個。
  - 剩下的請求大多是貼圖（412 個 PNG，33 MB），沒動。手機上的實際秒數沒量。
- 驗證：改前（git worktree 組 HEAD，補回整包 meshes.json）與改後同時開機，標題畫面與點一下之後的第一次設定畫面，
  載入的場景一樣，exceptions 0、notPorted 0、console 錯誤 0、失敗的請求 0；截圖逐像素比，差異只有左下角的載入毫秒數。
  vitest 74 檔 501 個（新加 unity/packs.test.ts 4 個），runtime 與 mt2-web 的 tsc 都是 0。
- 打包的閉包跟執行環境算的不一樣時（例如之後改了 collectRefs 或 keyOf），沒打包到的照舊一個一個抓，不會壞，只是慢；
  兩邊要一起改。assets 或 scenes 步驟重跑過要重跑 packs。

## 2026/10/18 字串加列舉變成 undefined：設定選單的對話速度、色盲模式、介面大小顯示成 key（Jason 指出；Diceomancer 未重新核對）

- 現象：設定 →「遊戲玩法」的對話速度顯示 `Enum_DialogueSpeed_undefined`，「輔助功能」的色盲模式、介面大小是
  `ScreenSettings_ColorBlindness_undefined`、`ScreenSettings_UIScaleOption_undefined`。
- 原因：C# 的 `"字串" + 列舉值` 綁成 string + object，Roslyn 報裝箱，E() 把運算元包成 R.boxEnum(…)，InString 再拿裝箱物件查名字表，得到 undefined。
  字串插值 `$"…{列舉}"` 沒有裝箱，本來就對。
- 改法（converter/Program.cs 的 Binary）：字串相加時，列舉運算元用裝箱前的值（Unboxed：E0，不套 E 的隱含轉換）查名字表。
- MT2 重轉：19 處、14 個檔。除了設定選單，還有 RunStat 的統計名稱（StatType_）、UserKeyMappingHelper 的按鍵名稱、ClanChecklistSection 的 EnableDLC_、
  RewardState 的亂數種子（以前混進 "undefined"，獎勵的亂數跟原版不同），其他是 Log 與例外訊息。
- mt2-web/src/main.ts 加除錯用的 `__locMissing()`：包住 I2 LocalizationManager.GetTranslation，記下回空字串、原樣或 `KEY>>…<<` 的 key 與呼叫端。
- 查過、不是 bug 的（原版資料就沒有這些詞條，原版 I2 一樣回 `KEY>>…<<`）：12 個狀態效果名稱（exploit poison、redcrown、maniac…）、
  14 個狀態效果的 `_CardTooltipText`、Trigger_PostCombatCharacterAbility（PostCombatHealing）、Trigger_OnSentry、MapRegion_Name0。
  用 UnityPy 解開原版全部資產與 bundle 搜尋過，只有 resources.assets 的 I2Languages 有詞條。281 個詞條翻譯本身是空的，原版也是空的。
- 驗證：瀏覽器（headless）設定選單三個下拉選單改前是 key；改後沒有在畫面上重拍（只確認產生碼與 19 處都不再有 boxEnum 查表），mt2-web tsc 0。
- 還沒查到：Jason 說「套用我方隊友或敵人的效果時顯示標籤」。用鍵盤出牌（數字鍵＋Enter，拖曳在 headless 不動）打了 8 回合，
  畫面上沒抓到 key，__locMissing 只有上面那些原版也缺的。

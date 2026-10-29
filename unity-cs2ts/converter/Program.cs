// Unity C# → TS 轉換器（best effort）：把 Unity 遊戲反編譯的 C# 類別轉成 TS 模組，搭配目標專案自己寫的相容層（runtime.ts）執行。
//
// 用法：
//   dotnet run --project <本專案> -- [--config <設定檔>] [--out <輸出資料夾>] [--diag] <目標> <類別名或群組名…>
//     設定檔沒給就從目前目錄往上找 cs2ts.json；格式見 README 與 configs/。
//     目標（targets）由設定檔定義，各自有輸出位置、樣式（style）與群組。
//     --out 蓋過目標的輸出資料夾（試轉用）；--diag 先印編譯錯誤數（新遊戲確認反編譯碼與 DLL 對得上）。
//   style "ui"（通用，任何 MonoBehaviour／資料類別）：
//     「類別:方法,…」只轉列出的方法（加上它們呼叫到的自己的方法）；沒列就整個類別；「-方法」排除。
//     另外處理：運算子多載（Vector3 的 + − ×）、使用者定義的隱含轉型（Vector3 ↔ Vector2）、事件的 += −= 與呼叫、
//     泛型方法的型別引數（GetComponent<T>() → 多傳一個型別名字串）、序列化欄位直接讀元件（c.ed.<名>）、
//     自己的巢狀類別與 Vector／Color 的欄位直接存取、同一次轉的類別之間互叫走 R.callGen。
//     語法：using 區塊 → try／finally 叫 R.<型別>_Dispose、?. 接呼叫鏈與巢狀 ?.、反編譯的 goto（往前跳 → break 標籤，往回跳 → for + switch 狀態機）、
//     索引初始化 { [k] = v } 與索引子複合指定 a[k] += v → R.<型別>_set_Item／get_Item、靜態自動屬性 → 模組變數 S_<名>、屬性模式 is T { P: <=1 }。
//     資料類別（這次轉的、不是 UnityEngine.Object 的類別與結構）：欄位直接存取，
//     多產生 fields（欄位型別）與 ctor0（無參數建構子），元件的這類欄位用 R.unityData 照 Unity 反序列化建。
//   style "bucket"（Diceomancer 的敵人與特殊故事）：prefab 序列化欄位照 buckets 檔分桶，見下方「做法」。
//   產生 <類別>.ts 與 index.ts，印出每個類別轉不動的地方與相容層缺的名字。
//   相容層：輸出資料夾的 runtime.ts（沒有就當空的，所有外部呼叫都變 notPorted，用來盤點要補哪些名字）。
//
// 做法：反編譯的 C# 原始碼加原版 Managed DLL（UnityEngine、UniTask…）建一個 Roslyn Compilation，
// 用語意模型轉：識別字是欄位、區域變數還是基底方法，多載選哪個，整數除法要不要截斷，都由編譯器判斷，不靠字面猜。
//   - 類別自己的方法 → 模組內的函式，第一個參數是 c（Ctx：s、self、ed、ai）。
//   - 類別自己的欄位 → c.ai.<名>（執行期狀態，可序列化）；bucket 樣式下 prefab 序列化、沒被改寫的 → c.ed.<桶>.<名>
//     （Diceomancer 的桶照 scripts/import/enemies.py 的分類：intentions、intentionLists、cards、triggers、strings、summonSlots、numbers、raw），
//     有被改寫的在 initAi 從 ed 複製一份進 ai。
//   - 其他型別的方法與屬性 → 相容層 runtime.ts 的 R.<型別>_<方法>(c, [receiver,] …)、
//     R.<型別>_get_<屬性>／R.<型別>_set_<屬性>、R.new_<型別>；多載加 $<參數型別> 後綴。
//     receiver：靜態方法與 X.Instance（單例）不傳；自己（隱含 this）傳 c.self；其他物件傳該物件。
//   - List／陣列／LINQ 轉成 JS 陣列操作；常數、enum 成員直接寫數值。
//   - 方法當委派（IntentionSpecialAction = Foo）→ 字串 key '類別.方法'，模組的 delegates 表註冊，由引擎分派。
//   - 相容層沒有的名字、不認得的語法 → R.notPorted(c, '檔案:行', '原句', '缺的名字')：型別照樣過，走到才丟 NotPorted。
// 產生的檔案不要手改；要改行為就改相容層或這支轉換器，再重跑。

using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.RegularExpressions;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;

/// 設定檔（cs2ts.json）。路徑可以是絕對路徑；相對路徑的基準：Root 相對設定檔所在資料夾，其他相對 Root。
class Config
{
    /// 目標專案根目錄（預設＝設定檔所在資料夾）
    public string Root { get; set; }
    /// 反編譯的主組件原始碼（通常是 Assembly-CSharp）
    public string Csharp { get; set; }
    /// 原版 Managed DLL 資料夾；跟 Csharp 同名的組件（MainAssembly）不參照 DLL
    public string Managed { get; set; }
    public string MainAssembly { get; set; } = "Assembly-CSharp";
    /// 產生檔檔頭寫的產生器名稱
    public string Generator { get; set; } = "unity-cs2ts";
    /// 用原始碼取代 DLL 的第三方組件：組件名 → 原始碼資料夾（只有 target 的 sourceAssemblies 為 true 時用；資料夾不存在就略過）
    public Dictionary<string, string> SourceAssemblies { get; set; } = new();
    /// 反編譯碼的型別歧義修正（file 相對 Csharp）：只改型別名稱，不改行為
    public List<Fixup> Fixups { get; set; } = new();
    /// TS 那邊結構跟 C# 欄位一一對應的資料型別：屬性直接讀寫
    public List<string> DirectTypes { get; set; } = new();
    public Dictionary<string, Target> Targets { get; set; } = new();

    public class Fixup { public string File { get; set; } public string From { get; set; } public string To { get; set; } }
    public class Target
    {
        /// "ui"（通用）或 "bucket"
        public string Style { get; set; } = "ui";
        /// 輸出與相容層的資料夾（產生檔在 <Out>/gen，相容層是 <Out>/runtime.ts）
        public string Out { get; set; }
        /// 有設這個環境變數就用它當 Out
        public string OutEnv { get; set; }
        /// index.ts 檔頭的類別稱呼與匯出常數名
        public string Label { get; set; } = "";
        public string IndexConst { get; set; } = "GENERATED";
        public bool SourceAssemblies { get; set; }
        /// 群組名 → 類別名或別的群組名（遞迴展開）
        public Dictionary<string, List<string>> Groups { get; set; } = new();
        /// 參數 all 且 Groups 沒有 all 時：名稱開頭是 Prefix、直接基底是 BaseType 的非抽象類別
        public AllBy All { get; set; }
        /// 參數 * 時不轉的類別（產生名）：執行環境原生做的部分（uGUI 的 EventSystem、Graphic、LayoutGroup…），呼叫它們走相容層
        public List<string> Exclude { get; set; } = new();
        /// 迴圈保護（除錯用，預設關）：每個 for／foreach／while／do 數圈數，超過一千萬圈丟例外帶 C# 位置（R.loopRunaway）。
        /// 無窮迴圈在網頁上會讓分頁當掉、什麼都查不到；Unity 會卡住。開了之後產生檔每個迴圈多兩行
        public bool LoopGuard { get; set; }
        /// bucket 樣式：類別 → 欄位 → 桶
        public BucketSource Buckets { get; set; }
    }
    public class AllBy { public string Prefix { get; set; } = ""; public string BaseType { get; set; } }
    /// JSON 檔：<Collection> 底下每筆有 <ClassKey>（類別名）與各個桶名的物件（欄位名 → 值）
    public class BucketSource
    {
        public string File { get; set; }
        public string Collection { get; set; }
        public string ClassKey { get; set; }
        public List<string> Names { get; set; } = new();
    }

    public string Path_(string p) => p == null ? null : Path.GetFullPath(Path.IsPathRooted(p) ? p : Path.Combine(Root, p));

    public static Config Load(string path)
    {
        var cfg = JsonSerializer.Deserialize<Config>(File.ReadAllText(path), new JsonSerializerOptions
        {
            PropertyNameCaseInsensitive = true, ReadCommentHandling = JsonCommentHandling.Skip, AllowTrailingCommas = true,
        });
        var dir = Path.GetDirectoryName(Path.GetFullPath(path));
        cfg.Root = Path.GetFullPath(cfg.Root == null ? dir : Path.IsPathRooted(cfg.Root) ? cfg.Root : Path.Combine(dir, cfg.Root));
        if (cfg.Csharp == null || cfg.Managed == null) throw new Exception($"{path}：csharp 與 managed 都要設");
        return cfg;
    }
}

static class Program
{
    static int Main(string[] argv)
    {
        string cfgPath = null, outOverride = null, hierarchyPath = null;
        var diag = false;
        var args = new List<string>();
        for (var i = 0; i < argv.Length; i++)
        {
            if (argv[i] == "--config" && i + 1 < argv.Length) cfgPath = argv[++i];
            else if (argv[i] == "--out" && i + 1 < argv.Length) outOverride = argv[++i];
            else if (argv[i] == "--diag") diag = true;
            else if (argv[i] == "--hierarchy" && i + 1 < argv.Length) hierarchyPath = argv[++i];
            else args.Add(argv[i]);
        }
        cfgPath = cfgPath != null ? Path.GetFullPath(cfgPath) : FindConfig(Directory.GetCurrentDirectory());
        if (cfgPath == null) { Console.Error.WriteLine("找不到 cs2ts.json（從目前目錄往上找），或用 --config 指定"); return 2; }
        var cfg = Config.Load(cfgPath);
        // --hierarchy <檔案> 只輸出繼承鏈時可以不給目標
        var hierarchyOnly = hierarchyPath != null && args.Count == 0;
        if (!hierarchyOnly && (args.Count < 2 || !cfg.Targets.ContainsKey(args[0])))
        {
            Console.Error.WriteLine($"用法：[--config <設定檔>] [--out <資料夾>] [--diag] [--hierarchy <檔案>] <目標> <類別名或群組名…>；{Path.GetFileName(cfgPath)} 的目標：{string.Join("、", cfg.Targets.Keys)}");
            return 2;
        }
        var mode = hierarchyOnly ? "" : args[0];
        var target = hierarchyOnly ? new Config.Target() : cfg.Targets[mode];
        var ui = target.Style == "ui";
        var managed = cfg.Path_(cfg.Managed);
        var csRoot = cfg.Path_(cfg.Csharp);
        Emitter.Generator = cfg.Generator;
        Emitter.CsharpLabel = cfg.Csharp.Replace('\\', '/').TrimEnd('/');
        Emitter.DirectTypes = cfg.DirectTypes.ToHashSet();
        Fixups = cfg.Fixups;
        // 第三方套件只有 DLL 時，要轉它的類別就用反編譯的原始碼取代那個 DLL 的參照
        var srcAssemblies = target.SourceAssemblies
            ? cfg.SourceAssemblies.Where(kv => Directory.Exists(cfg.Path_(kv.Value))).ToDictionary(kv => kv.Key, kv => cfg.Path_(kv.Value))
            : new Dictionary<string, string>();
        var refs = Directory.GetFiles(managed, "*.dll").Where(f => Path.GetFileNameWithoutExtension(f) != cfg.MainAssembly && !srcAssemblies.ContainsKey(Path.GetFileNameWithoutExtension(f)))
            .Select(f => (MetadataReference)MetadataReference.CreateFromFile(f)).ToList();
        var dllCount = refs.Count;
        var trees = Directory.GetFiles(csRoot, "*.cs", SearchOption.AllDirectories).OrderBy(f => f, StringComparer.Ordinal)
            .Select(f => CSharpSyntaxTree.ParseText(Fixup(Path.GetRelativePath(csRoot, f), File.ReadAllText(f)), path: f)).ToList();
        var opts = new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary, allowUnsafe: true);
        // 原始碼取代 DLL 的組件：各自一個編譯，名字照原本的組件名（AssemblyInfo 的版本、InternalsVisibleTo 一起帶），
        // 主編譯參照它。其他 DLL（例如 Unity.TextMeshPro 參照 UnityEngine.UI）才對得到同一個組件。
        // 依原 DLL 的參照排順序（MoreMountains.Feedbacks 參照 MoreMountains.Tools，Tools 先建）。
        var srcComps = new List<CSharpCompilation>();
        foreach (var name in SourceAssemblyOrder(managed, srcAssemblies.Keys))
        {
            var dir = srcAssemblies[name];
            var strees = Directory.GetFiles(dir, "*.cs", SearchOption.AllDirectories).Where(f => !f.Contains("/obj/")).OrderBy(f => f, StringComparer.Ordinal)
                .Select(f => CSharpSyntaxTree.ParseText(File.ReadAllText(f), path: f)).ToList();
            var sc = CSharpCompilation.Create(name, strees, refs, opts);
            srcComps.Add(sc);
            refs = refs.Append(sc.ToMetadataReference()).ToList();
        }
        var comp = CSharpCompilation.Create("A", trees, refs, opts);
        var allComps = srcComps.Append(comp).ToList();
        // 原始碼裡宣告的全部類別與結構（含巢狀；主編譯與原始碼組件），參數 * 轉全部時用
        List<INamedTypeSymbol> SourceTypes()
        {
            var res = new List<INamedTypeSymbol>();
            void Visit(INamespaceOrTypeSymbol ns, CSharpCompilation c)
            {
                foreach (var m in ns.GetMembers())
                {
                    if (m is INamespaceSymbol child) { Visit(child, c); continue; }
                    if (m is not INamedTypeSymbol t || t.IsImplicitlyDeclared) continue;
                    if (!t.DeclaringSyntaxReferences.Any(r => c.SyntaxTrees.Contains(r.SyntaxTree))) continue;
                    if (t.TypeKind is TypeKind.Class or TypeKind.Struct && !t.Name.Contains('<')) res.Add(t);
                    Visit(t, c);
                }
            }
            foreach (var c in allComps) Visit(c.Assembly.GlobalNamespace, c);
            return res;
        }
        // 工具包模式的產生名（GN）→ 型別；同名的（不同 namespace）取第一個
        var GenIndex = new Lazy<Dictionary<string, INamedTypeSymbol>>(() =>
        {
            var d = new Dictionary<string, INamedTypeSymbol>();
            foreach (var t in SourceTypes()) d.TryAdd(Emitter.GN(t), t);
            return d;
        });
        // 找類別：主編譯與原始碼組件的編譯都找（宣告在哪個編譯，就用那個編譯的語意模型）
        // 「名字$N」是型別參數 N 個的泛型類別（Signal$2 → Signal<T, U>）；沒寫就優先非泛型的
        INamedTypeSymbol FindType(string name)
        {
            // 巢狀類別：「外層.內層」或產生名「外層_內層」（工具包模式的 GN）
            if (name.Contains('.'))
            {
                var outer = FindType(name[..name.LastIndexOf('.')]);
                var inner = name[(name.LastIndexOf('.') + 1)..];
                var im = Regex.Match(inner, @"^(.+)\$(\d+)$");
                var (ibare, iar) = im.Success ? (im.Groups[1].Value, int.Parse(im.Groups[2].Value)) : (inner, -1);
                return outer?.GetTypeMembers(ibare).FirstOrDefault(t => iar < 0 || t.Arity == iar);
            }
            if (Emitter.ArityNames && GenIndex.Value.TryGetValue(name, out var byGn)) return byGn;
            var m = Regex.Match(name, @"^(.+)\$(\d+)$");
            var (bare, arity) = m.Success ? (m.Groups[1].Value, int.Parse(m.Groups[2].Value)) : (name, 0);
            var cands = allComps.SelectMany(c => c.GetSymbolsWithName(bare, SymbolFilter.Type)).OfType<INamedTypeSymbol>().Where(t => t.Name == bare).ToList();
            return cands.FirstOrDefault(t => t.Arity == arity) ?? (m.Success ? null : cands.FirstOrDefault());
        }
        SemanticModel ModelOf(SyntaxTree tree) => allComps.First(c => c.SyntaxTrees.Contains(tree)).GetSemanticModel(tree);
        if (diag)
        {
            var errs = allComps.SelectMany(c => c.GetDiagnostics()).Where(d => d.Severity == DiagnosticSeverity.Error).ToList();
            Console.Error.WriteLine($"== 編譯：{trees.Count + srcComps.Sum(c => c.SyntaxTrees.Count())} 個檔（原始碼組件 {srcComps.Count} 個）、{dllCount} 個 DLL，錯誤 {errs.Count} 個");
            foreach (var g in errs.GroupBy(d => d.Id).OrderByDescending(g => g.Count()).Take(10))
                Console.Error.WriteLine($"  {g.Count(),5} {g.Key} 例：{g.First().GetMessage()}（{Path.GetFileName(g.First().Location.SourceTree?.FilePath)}）");
        }

        if (hierarchyPath != null)
        {
            var h = Hierarchy(comp, out var dup);
            var hp = Path.GetFullPath(hierarchyPath);
            Directory.CreateDirectory(Path.GetDirectoryName(hp));
            File.WriteAllText(hp, JsonSerializer.Serialize(h, new JsonSerializerOptions { Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping }));
            Console.WriteLine($"== 繼承鏈：{h.Count} 個 MonoBehaviour 類別 → {hp}{(dup.Count > 0 ? $"；同名不同 namespace {dup.Count} 個（取原始碼裡的那個）：{string.Join("、", dup.Take(8))}" : "")}");
            if (hierarchyOnly) return 0;
        }

        // DLL 裡的型別的基底鏈（工具包模式找相容層名字時沿基底找，Emitter.ResolveRt）
        foreach (var r in comp.References)
            if (comp.GetAssemblyOrModuleSymbol(r) is IAssemblySymbol basm)
            {
                void VisitBases(INamespaceOrTypeSymbol ns)
                {
                    foreach (var mem in ns.GetMembers())
                    {
                        if (mem is INamespaceSymbol cns) { VisitBases(cns); continue; }
                        if (mem is not INamedTypeSymbol nt || nt.DeclaredAccessibility != Accessibility.Public) continue;
                        if (nt.BaseType is INamedTypeSymbol bt && bt.SpecialType != SpecialType.System_Object && bt.SpecialType != SpecialType.System_ValueType)
                            if (Emitter.TKName(nt) != Emitter.TKName(bt)) Emitter.ExternalBases.TryAdd(Emitter.TKName(nt), Emitter.TKName(bt));
                        VisitBases(nt);
                    }
                }
                VisitBases(basm.GlobalNamespace);
            }
        // DLL 裡的 Unity 元件型別（工具包模式的 nativeGet／nativeSet 用）：UnityEngine*、Unity.*（TextMeshPro、Timeline…）
        foreach (var r in comp.References)
            if (comp.GetAssemblyOrModuleSymbol(r) is IAssemblySymbol asm && (asm.Name.StartsWith("UnityEngine") || asm.Name.StartsWith("Unity.")))
            {
                void VisitNative(INamespaceOrTypeSymbol ns)
                {
                    foreach (var mem in ns.GetMembers())
                    {
                        if (mem is INamespaceSymbol cns) { VisitNative(cns); continue; }
                        if (mem is INamedTypeSymbol nt && nt.TypeKind == TypeKind.Class)
                            for (var b = nt.BaseType; b != null; b = b.BaseType)
                                if (b.ToDisplayString() == "UnityEngine.Component") { Emitter.NativeComponents.Add(nt.Name); break; }
                        if (mem is INamedTypeSymbol nt2 && nt2.TypeKind is TypeKind.Class or TypeKind.Struct)
                        {
                            Emitter.NativeTypes.Add(nt2.Name);
                            foreach (var inner in nt2.GetTypeMembers()) Emitter.NativeTypes.Add($"{nt2.Name}_{inner.Name}");
                        }
                    }
                }
                VisitNative(asm.GlobalNamespace);
            }
        var outEnv = target.OutEnv != null ? Environment.GetEnvironmentVariable(target.OutEnv) : null;
        var genRootRaw = outOverride ?? outEnv ?? target.Out;
        if (genRootRaw == null) { Console.Error.WriteLine($"目標 {mode} 沒有 out，用 --out 指定"); return 2; }
        var genRoot = outOverride != null || outEnv != null ? Path.GetFullPath(genRootRaw) : cfg.Path_(genRootRaw);
        var runtimePath = Path.Combine(genRoot, "runtime.ts");
        if (!File.Exists(runtimePath)) Console.Error.WriteLine($"注意：沒有 {runtimePath}，相容層當空的（外部呼叫全部 notPorted）");
        var rt = File.Exists(runtimePath) ? ReadExports(runtimePath) : new HashSet<string>();
        Emitter.ArityNames = rt.Contains("__cs2ts_core");
        Emitter.LoopGuard = target.LoopGuard;
        if (Emitter.ArityNames)
        {
            Emitter.ArityNames = false; // 先用不帶 namespace 的名字找出重複的
            Emitter.DuplicateNames = SourceTypes().Where(t => t.ContainingType == null).GroupBy(t => t.Arity > 0 ? $"{t.Name}${t.Arity}" : t.Name)
                .Where(g => g.Count() > 1).Select(g => g.Key).ToHashSet();
            // 跟 System、UnityEngine 的型別同名（Ink.Runtime.Object）也要帶 namespace：不然 base()、base.X()、is Object 會指到自己
            var shadow = new List<string>();
            foreach (var t in SourceTypes().Where(t => t.ContainingType == null))
            {
                var ns = t.ContainingNamespace?.IsGlobalNamespace == false ? t.ContainingNamespace.ToDisplayString() : "";
                var meta = t.Arity > 0 ? $"{t.Name}`{t.Arity}" : t.Name;
                foreach (var ext in new[] { "System", "UnityEngine" })
                    if (ns != ext && comp.GetTypeByMetadataName($"{ext}.{meta}") is { } et && et.DeclaringSyntaxReferences.Length == 0)
                    {
                        var own = t.Arity > 0 ? $"{t.Name}${t.Arity}" : t.Name;
                        if (ns == "") shadow.Add($"{own}（全域，沒有 namespace 可帶）");
                        else if (Emitter.DuplicateNames.Add(own)) shadow.Add($"{ns}.{own}");
                    }
            }
            if (shadow.Count > 0) Console.Error.WriteLine($"跟 System／UnityEngine 同名、改帶 namespace：{string.Join("、", shadow)}");
            Emitter.ArityNames = true;
        }
        var buckets = target.Buckets != null ? LoadBuckets(cfg.Path_(target.Buckets.File), target.Buckets) : new Dictionary<string, Dictionary<string, string>>();

        var names = new List<string>();
        // ui：類別 → 只轉的方法（沒列＝整個類別）
        var only = new Dictionary<string, HashSet<string>>();
        // 「類別:方法,…」只轉列出的方法（群組裡的項目也可以這樣寫）
        string ClassOf(string a)
        {
            if (!ui || !a.Contains(':')) return a;
            var parts = a.Split(':', 2);
            only[parts[0]] = parts[1].Split(',', StringSplitOptions.RemoveEmptyEntries).ToHashSet();
            return parts[0];
        }
        foreach (var a0 in args.Skip(1))
        {
            var a = ClassOf(a0);
            if (target.Groups.ContainsKey(a)) names.AddRange(Expand(target.Groups, a, new HashSet<string>()).Select(ClassOf));
            // *：原始碼裡的全部類別與結構（工具包模式；名字是 GN，同名不同 namespace 的只轉第一個，見下面的報告）
            else if (a == "*" && ui)
            {
                var excl = target.Exclude.ToHashSet();
                Emitter.Excluded = excl;
                var all = SourceTypes().Where(t => !excl.Contains(Emitter.GN(t)) && !excl.Contains(Emitter.GN(t.ContainingType ?? t))).ToList();
                var dupGn = all.GroupBy(Emitter.GN).Where(g => g.Count() > 1).Select(g => g.Key).ToList();
                if (dupGn.Count > 0) Console.Error.WriteLine($"注意：產生名重複 {dupGn.Count} 個（只轉第一個）：{string.Join("、", dupGn.Take(20))}");
                names.AddRange(all.Select(Emitter.GN).Distinct().OrderBy(x => x, StringComparer.Ordinal));
            }
            else if (a == "all" && target.All != null)
                names.AddRange(allComps.SelectMany(c => c.GetSymbolsWithName(n => n.StartsWith(target.All.Prefix), SymbolFilter.Type)).OfType<INamedTypeSymbol>()
                    .Where(t => !t.IsAbstract && t.BaseType?.Name == target.All.BaseType).Select(t => t.Name).OrderBy(x => x, StringComparer.Ordinal));
            else names.Add(a);
        }
        var outDir = Path.Combine(genRoot, "gen");
        // * 是整批重轉：先清掉舊的產生檔（index.ts 會登記資料夾裡的全部檔案，殘留的舊名字會混進來）
        if (args.Skip(1).Contains("*") && Directory.Exists(outDir))
            foreach (var f in Directory.GetFiles(outDir, "*.ts")) File.Delete(f);
        Directory.CreateDirectory(outDir);
        var allMissing = new Dictionary<string, int>();
        var report = new StringBuilder();
        int totalSites = 0, totalCs = 0;
        // ui：這次轉的類別與各自轉出的方法（別的類別呼叫到時走 R.callGen，沒轉到的方法走相容層）
        var genMethods = new Dictionary<string, HashSet<string>>();
        var usedFiles = new HashSet<string>();
        // ui：是同一次轉的別的類別的基底的類別（子類別會讀寫繼承來的欄位，initAi 要放全部欄位）
        var genBases = new HashSet<string>();
        var partialGen = new HashSet<string>();
        foreach (var name in names.Distinct())
        {
            var t0 = FindType(name);
            if (t0 == null) continue;
            var d0 = (TypeDeclarationSyntax)t0.DeclaringSyntaxReferences[0].GetSyntax();
            var sel = Emitter.SelectedMethods(ModelOf(d0.SyntaxTree), t0, d0, only.GetValueOrDefault(name));
            genMethods[Emitter.GN(t0)] = sel.Select(m => m.Name).ToHashSet();
            if (only.ContainsKey(name))
            {
                // 只轉部分方法：Emitter 只產生這些方法用到的自己的屬性（Emit 的 usedProps），存取子名字一起記
                partialGen.Add(Emitter.GN(t0));
                var md = ModelOf(d0.SyntaxTree);
                foreach (var m in d0.Members.OfType<MethodDeclarationSyntax>().Where(x => sel.Contains(md.GetDeclaredSymbol(x), SymbolEqualityComparer.Default)))
                    foreach (var n in m.DescendantNodes())
                        if (md.GetSymbolInfo(n).Symbol is IPropertySymbol ps && SymbolEqualityComparer.Default.Equals(ps.ContainingType, t0))
                        {
                            genMethods[Emitter.GN(t0)].Add("get_" + ps.Name);
                            genMethods[Emitter.GN(t0)].Add("set_" + ps.Name);
                        }
            }
            for (var bt = t0.BaseType; bt != null; bt = bt.BaseType) genBases.Add(Emitter.GN(bt));
        }
        foreach (var name in names.Distinct())
        {
            var type = FindType(name);
            if (type == null) { Console.Error.WriteLine($"找不到類別 {name}"); return 1; }
            // 結構也轉，宣告是 StructDeclarationSyntax
            var decl = (TypeDeclarationSyntax)type.DeclaringSyntaxReferences[0].GetSyntax();
            var model = ModelOf(decl.SyntaxTree);
            var rel = Path.GetRelativePath(csRoot, decl.SyntaxTree.FilePath);
            buckets.TryGetValue(name, out var fb);
            var em = new Emitter(model, type, decl, rel, rt, fb ?? new Dictionary<string, string>());
            if (ui) { em.Ui = true; em.Only = only.GetValueOrDefault(name); em.GenMethods = genMethods; em.IsGenBase = genBases.Contains(Emitter.GN(type)); em.PartialGen = partialGen; }
            var ts = em.Emit();
            // 檔名：大小寫不分的檔案系統上撞名（I2 的 JSON 與 Ink 的 Json）就加後綴；index.ts 照檔案裡的匯出名登記
            var fname = Emitter.GN(type);
            for (var k = 2; !usedFiles.Add(fname.ToLowerInvariant()); k++) fname = $"{Emitter.GN(type)}$${k}";
            File.WriteAllText(Path.Combine(outDir, fname + ".ts"), ts);
            var csLines = decl.SyntaxTree.GetText().Lines.Count;
            totalCs += csLines; totalSites += em.Sites.Count;
            report.AppendLine($"  {name}（{csLines} 行）：轉不動 {em.Sites.Count} 處");
            foreach (var s in em.Sites) report.AppendLine($"      {s}");
            foreach (var kv in em.Missing) allMissing[kv.Key] = allMissing.GetValueOrDefault(kv.Key) + kv.Value;
        }
        // 工具包模式：列舉的名字表（$enums.ts）：原始碼裡的全部列舉，加上產生碼當型別值用到的（KeyCode 這類 DLL 裡的）。
        // 成員照 .NET 的 Enum.GetValues 排（無號值由小到大，同值照宣告順序）
        if (Emitter.ArityNames)
        {
            var enums = new Dictionary<string, INamedTypeSymbol>();
            void VisitEnums(INamespaceOrTypeSymbol ns, CSharpCompilation c)
            {
                foreach (var m in ns.GetMembers())
                {
                    if (m is INamespaceSymbol child) { VisitEnums(child, c); continue; }
                    if (m is not INamedTypeSymbol t || !t.DeclaringSyntaxReferences.Any(r => c.SyntaxTrees.Contains(r.SyntaxTree))) continue;
                    if (t.TypeKind == TypeKind.Enum) enums.TryAdd(Emitter.GN(t), t);
                    VisitEnums(t, c);
                }
            }
            foreach (var c in allComps) VisitEnums(c.Assembly.GlobalNamespace, c);
            foreach (var t in Emitter.UsedEnums) enums.TryAdd(Emitter.GN(t), t);
            var es = new StringBuilder();
            es.AppendLine($"// 自動產生（{cfg.Generator}），不要手改：列舉的名字表（Enum.GetNames／GetValues／Parse、[Flags] 的 ToString 用）。");
            // kind：底層型別不是 int 時才寫（u8、i16…，同欄位描述的十六進位格式）：泛型欄位 TKey[] 的 TKey 是列舉時，執行期照它解 Unity 的十六進位陣列
            es.AppendLine("export const ENUMS: Record<string, { flags: boolean; members: [string, number][]; kind?: string }> = {");
            foreach (var (gn, t) in enums.OrderBy(kv => kv.Key, StringComparer.Ordinal))
            {
                var flags = t.GetAttributes().Any(a => a.AttributeClass?.Name == "FlagsAttribute");
                var members = t.GetMembers().OfType<IFieldSymbol>().Where(f => f.HasConstantValue)
                    .Select((f, i) => (f.Name, v: Convert.ToInt64(f.ConstantValue), i)).OrderBy(x => unchecked((ulong)x.v)).ThenBy(x => x.i)
                    .Select(x => $"[{Emitter.JsStr(x.Name)}, {x.v.ToString(System.Globalization.CultureInfo.InvariantCulture)}]");
                var hk = Emitter.HexElem(t) is string hd && hd != "[$i32]" ? $", kind: {Emitter.JsStr(hd[2..^1])}" : "";
                es.AppendLine($"  {Emitter.JsStr(gn)}: {{ flags: {(flags ? "true" : "false")}, members: [{string.Join(", ", members)}]{hk} }},");
            }
            es.AppendLine("};");
            File.WriteAllText(Path.Combine(outDir, "$enums.ts"), es.ToString());
        }
        // index：目錄下全部產生檔（不只這次轉的），照名稱排序；$ 開頭的不是類別（$enums.ts）
        var genFiles = Directory.GetFiles(outDir, "*.ts").Select(Path.GetFileNameWithoutExtension).Where(x => x != "index" && !x.StartsWith('$')).OrderBy(x => x, StringComparer.Ordinal).ToList();
        var idx = new StringBuilder();
        idx.AppendLine($"// 自動產生（{cfg.Generator}），不要手改：轉換器產生的{target.Label}類別登記表。");
        idx.AppendLine("import type { GenClassImpl } from '../runtime';");
        string ExportOf(string file)
        {
            var m = Regex.Match(File.ReadAllText(Path.Combine(outDir, file + ".ts")), @"^export const ([A-Za-z0-9_$]+): R\.GenClassImpl", RegexOptions.Multiline);
            return m.Success ? m.Groups[1].Value : file;
        }
        var exportsOf = genFiles.ToDictionary(g => g, ExportOf);
        foreach (var g in genFiles) idx.AppendLine(exportsOf[g] == g ? $"import {{ {g} }} from './{g}';" : $"import {{ {exportsOf[g]} }} from './{g}';");
        idx.AppendLine();
        idx.AppendLine($"export const {target.IndexConst}: Record<string, GenClassImpl> = {{");
        foreach (var g in genFiles) idx.AppendLine($"  {exportsOf[g]},");
        idx.AppendLine("};");
        if (File.Exists(Path.Combine(outDir, "$enums.ts"))) idx.AppendLine($"export {{ ENUMS as {target.IndexConst}_ENUMS }} from './$enums';");
        File.WriteAllText(Path.Combine(outDir, "index.ts"), idx.ToString());

        Console.WriteLine($"== 轉換 {names.Distinct().Count()} 個類別（C# {totalCs} 行），轉不動 {totalSites} 處");
        Console.Write(report);
        Console.WriteLine($"== 相容層缺的名字（{allMissing.Count} 個，依次數）");
        foreach (var kv in allMissing.OrderByDescending(k => k.Value).ThenBy(k => k.Key, StringComparer.Ordinal)) Console.WriteLine($"  {kv.Value,3} {kv.Key}");
        return 0;
    }

    /// 全部 MonoBehaviour 類別（原始碼與參照的 DLL）→ 基底類別鏈（直接基底在前，到 MonoBehaviour 為止）。
    /// 執行環境用它幫子類別找實作：遊戲的 GameUISelectableButton : Button 沒有自己的 behaviour 時用 Button 的。
    /// key 是類別名（場景樹的 script.class）；同名不同 namespace 時原始碼裡的優先。
    static SortedDictionary<string, List<string>> Hierarchy(CSharpCompilation comp, out List<string> dup)
    {
        var res = new SortedDictionary<string, List<string>>(StringComparer.Ordinal);
        var fromSource = new HashSet<string>();
        var dups = new SortedSet<string>(StringComparer.Ordinal);
        void Visit(INamespaceOrTypeSymbol ns)
        {
            foreach (var m in ns.GetMembers())
            {
                if (m is INamespaceSymbol child) { Visit(child); continue; }
                if (m is not INamedTypeSymbol t || t.TypeKind != TypeKind.Class) continue;
                var chain = new List<string>();
                var isMb = false;
                for (var b = t.BaseType; b != null; b = b.BaseType)
                {
                    chain.Add(b.Name);
                    if (b.ToDisplayString() == "UnityEngine.MonoBehaviour") { isMb = true; break; }
                }
                if (!isMb) continue;
                var src = t.DeclaringSyntaxReferences.Length > 0;
                if (res.ContainsKey(t.Name))
                {
                    dups.Add(t.Name);
                    if (!src || fromSource.Contains(t.Name)) continue;
                }
                res[t.Name] = chain;
                if (src) fromSource.Add(t.Name);
            }
        }
        Visit(comp.GlobalNamespace);
        dup = dups.ToList();
        return res;
    }

    /// 原始碼組件的建置順序：照原 DLL 的組件參照做拓撲排序（被參照的先建）；DLL 不在就照設定順序
    static List<string> SourceAssemblyOrder(string managed, IEnumerable<string> names)
    {
        var set = names.ToList();
        var deps = new Dictionary<string, HashSet<string>>();
        foreach (var n in set)
        {
            deps[n] = new HashSet<string>();
            var dll = Path.Combine(managed, n + ".dll");
            if (!File.Exists(dll)) continue;
            using var pe = new System.Reflection.PortableExecutable.PEReader(File.OpenRead(dll));
            var md = System.Reflection.Metadata.PEReaderExtensions.GetMetadataReader(pe);
            foreach (var h in md.AssemblyReferences)
            {
                var r = md.GetString(md.GetAssemblyReference(h).Name);
                if (set.Contains(r)) deps[n].Add(r);
            }
        }
        var order = new List<string>();
        var seen = new HashSet<string>();
        void Visit(string n)
        {
            if (!seen.Add(n)) return;
            foreach (var d in deps[n]) Visit(d);
            order.Add(n);
        }
        foreach (var n in set) Visit(n);
        return order;
    }

    static IEnumerable<string> Expand(Dictionary<string, List<string>> groups, string name, HashSet<string> seen)
    {
        if (!groups.TryGetValue(name, out var items)) { yield return name; yield break; }
        if (!seen.Add(name)) throw new Exception($"群組 {name} 循環引用");
        foreach (var x in items)
            foreach (var y in Expand(groups, x, seen)) yield return y;
    }

    static List<Config.Fixup> Fixups = new();
    static string Fixup(string rel, string text)
    {
        foreach (var f in Fixups)
        {
            if (rel.Replace('\\', '/') != f.File) continue;
            if (!text.Contains(f.From)) throw new Exception($"反編譯修正表對不上：{f.File} 沒有「{f.From}」");
            text = text.Replace(f.From, f.To);
        }
        return text;
    }

    /// 相容層的 export 名字；`export * from './x'` 會跟進去（例如故事的相容層共用敵人那份）
    static HashSet<string> ReadExports(string path)
    {
        var text = File.ReadAllText(path);
        var set = new HashSet<string>(Regex.Matches(text, @"^export (?:async )?(?:function|const|let|class) ([A-Za-z0-9_$]+)", RegexOptions.Multiline).Select(m => m.Groups[1].Value));
        foreach (Match m in Regex.Matches(text, @"^export \* from '([^']+)';", RegexOptions.Multiline))
            set.UnionWith(ReadExports(Path.GetFullPath(Path.Combine(Path.GetDirectoryName(path)!, m.Groups[1].Value + ".ts"))));
        return set;
    }

    static string FindConfig(string dir)
    {
        for (var d = new DirectoryInfo(dir); d != null; d = d.Parent)
            if (File.Exists(Path.Combine(d.FullName, "cs2ts.json"))) return Path.Combine(d.FullName, "cs2ts.json");
        return null;
    }

    /// buckets 檔：類別 → 欄位名 → 桶（同一類別的多筆取聯集）
    static Dictionary<string, Dictionary<string, string>> LoadBuckets(string path, Config.BucketSource src)
    {
        var res = new Dictionary<string, Dictionary<string, string>>();
        using var doc = JsonDocument.Parse(File.ReadAllText(path));
        foreach (var p in doc.RootElement.GetProperty(src.Collection).EnumerateObject())
        {
            var cls = p.Value.GetProperty(src.ClassKey).GetString();
            if (cls == null) continue;
            if (!res.TryGetValue(cls, out var m)) res[cls] = m = new Dictionary<string, string>();
            foreach (var b in src.Names)
                if (p.Value.TryGetProperty(b, out var obj) && obj.ValueKind == JsonValueKind.Object)
                    foreach (var f in obj.EnumerateObject()) m.TryAdd(f.Name, b);
        }
        return res;
    }
}

enum FieldKind { Ai, Ed, EdAi, Missing }

class Emitter
{
    readonly SemanticModel M;
    readonly INamedTypeSymbol T;
    readonly TypeDeclarationSyntax D;
    readonly string File;
    readonly HashSet<string> RT;
    readonly Dictionary<string, string> Bucket;
    public readonly Dictionary<string, int> Missing = new();
    public readonly List<string> Sites = new();
    readonly Dictionary<IFieldSymbol, (FieldKind kind, string bucket)> fields = new(SymbolEqualityComparer.Default);
    readonly Dictionary<IMethodSymbol, string> ownMethods = new(SymbolEqualityComparer.Default);
    readonly SortedSet<string> delegateKeys = new(StringComparer.Ordinal);
    readonly HashSet<IFieldSymbol> staticFields = new(SymbolEqualityComparer.Default);
    /// ui：靜態自動屬性（StatusEffectManager.Instance），跟靜態欄位一樣是模組變數 S_名字
    readonly HashSet<IPropertySymbol> staticProps = new(SymbolEqualityComparer.Default);
    /// ?. 左邊的運算式 → 暫存變數：右邊開頭的 .X 以它為對象（見 ConditionalAccess）
    readonly Dictionary<SyntaxNode, string> boundRecv = new();
    /// 正在產生的 catch 區塊接到的例外變數（throw; 丟回它）
    readonly Stack<string> catchVars = new();
    /// 正在產生的 goto 的標籤 → 換成的敘述（往前跳是 break 標籤；狀態機是設狀態再 continue，見 Stmts）
    readonly Dictionary<string, string> gotoJumps = new();
    // 工具包模式：ref 區域變數（ref int r = ref array[i]）→ 讀寫都換成「暫存的陣列[暫存的索引]」
    readonly Dictionary<ISymbol, string> refLocals = new(SymbolEqualityComparer.Default);
    List<string> hoist = new();
    int tmp;
    // ui 模式（畫面的 MonoBehaviour）：見檔頭
    public bool Ui;
    /// 只轉這些方法（null＝整個類別）
    public HashSet<string> Only;
    /// 這次一起轉的類別 → 轉出的方法名（別的類別呼叫到時走 R.callGen）
    public Dictionary<string, HashSet<string>> GenMethods = new();
    /// 這個類別是同一次轉的別的類別的基底（只轉部分方法時，initAi 照樣放全部實體欄位）
    public bool IsGenBase;
    List<MethodDeclarationSyntax> selected;

    /// 要轉的方法：Only 列的（含多載）加上它們呼叫或當委派用到的自己的方法（遞移）
    public static List<IMethodSymbol> SelectedMethods(SemanticModel m, INamedTypeSymbol t, TypeDeclarationSyntax d, HashSet<string> only)
    {
        var decls = d.Members.OfType<MethodDeclarationSyntax>().ToList();
        var all = decls.Select(x => m.GetDeclaredSymbol(x)).ToList();
        if (only == null) return all;
        // 「-方法」：不轉（呼叫走相容層 R.<類別>_<方法>，例如引擎已經做掉的邏輯）
        var skip = only.Where(n => n.StartsWith("-")).Select(n => n[1..]).ToHashSet();
        var want = only.Where(n => !n.StartsWith("-")).ToHashSet();
        var missing = want.Concat(skip).Where(n => !all.Any(x => x.Name == n)).ToList();
        if (missing.Count > 0) throw new Exception($"{t.Name} 沒有方法 {string.Join("、", missing)}");
        var pick = new HashSet<IMethodSymbol>(all.Where(x => want.Contains(x.Name)), SymbolEqualityComparer.Default);
        var queue = new Queue<IMethodSymbol>(pick);
        while (queue.Count > 0)
        {
            var cur = queue.Dequeue();
            var decl = decls[all.IndexOf(cur)];
            foreach (var n in decl.DescendantNodes())
            {
                if (n is not (IdentifierNameSyntax or MemberAccessExpressionSyntax)) continue;
                var sym = m.GetSymbolInfo(n).Symbol ?? m.GetSymbolInfo(n).CandidateSymbols.FirstOrDefault();
                if (sym is IMethodSymbol callee && SymbolEqualityComparer.Default.Equals(callee.ContainingType, t))
                {
                    var own = all.FirstOrDefault(x => SymbolEqualityComparer.Default.Equals(x, callee.OriginalDefinition));
                    if (own != null && !skip.Contains(own.Name) && pick.Add(own)) queue.Enqueue(own);
                }
            }
        }
        return all.Where(pick.Contains).ToList();
    }

    /// 自己宣告的巢狀類別（CardSelector.CardHighlightInfo）：ui 模式下是一般物件，成員直接讀寫
    bool OwnNested(ITypeSymbol t) => t is INamedTypeSymbol nt && nt.ContainingType != null && Same(nt.ContainingType.OriginalDefinition, T.OriginalDefinition);
    /// ui 模式直接存取的資料型別：自己的巢狀類別、Unity 的值型別（欄位 x y z w r g b a）
    static readonly HashSet<string> UiValueTypes = new() { "Vector2", "Vector3", "Vector4", "Quaternion", "Color", "Vector2Int", "Vector3Int", "Rect" };
    bool Direct(ITypeSymbol ct) => DirectTypes.Contains(ct.Name) || (Ui && (OwnNested(ct) || UiValueTypes.Contains(ct.Name) && ct.ContainingNamespace?.ToDisplayString() == "UnityEngine" || UiData(ct) || PlainSourceData(ct) || GenData(ct)));
    /// ui：這次轉的類別裡不是 UnityEngine.Object 的（資料類別，沒標 [Serializable] 的也算，例如 AllTachiEDialogueAndReadStatuses）：
    /// 執行期是 { $type, 欄位… } 物件，Ctx 的 ai 就是物件本身（runtime.ts 的 ctxOf），別的類別讀寫欄位直接存取
    bool GenData(ITypeSymbol t) => t is INamedTypeSymbol nt && GenMethods.ContainsKey(GN(nt)) && nt.DeclaringSyntaxReferences.Length > 0
        && !DerivesFrom(nt, "UnityEngine.Object") && nt.TypeKind is TypeKind.Class or TypeKind.Struct;
    /// ui：欄位型別的描述（R.unityData 照它把場景存檔值建成產生類別的物件）：@類別＝這次轉的資料類別；[x]＝陣列或 List；{x}＝Dictionary 的值。
    /// 不需要特別處理的（基本型別、Unity 的值型別、沒轉的類別）回 null
    string TypeDesc(ITypeSymbol t)
    {
        // 工具包模式：字串欄位。YAML 的空字串讀出來是 null，Unity 反序列化的字串欄位一律是 ""（$s：null 換成 ""）
        if (Core && t.SpecialType == SpecialType.System_String) return "$s";
        // 工具包模式：char 欄位。YAML 存成 UTF-16 碼的數字，產生碼裡的 char 是長度 1 的字串（$c：數字換成字）
        if (Core && t.SpecialType == SpecialType.System_Char) return "$c";
        if (t is IArrayTypeSymbol at) return (Core ? HexElem(at.ElementType) : null) ?? (TypeDesc(at.ElementType) is string ae ? $"[{ae}]" : null);
        // 工具包模式：類別的型別參數（ReorderableArray<T> 的 List<T> array）：執行期照實體的型別引數換（子類別的 baseTargs）
        if (Core && t is ITypeParameterSymbol { TypeParameterKind: TypeParameterKind.Type } tp) return $"$targ:{tp.Ordinal}";
        if (t is not INamedTypeSymbol nt) return null;
        var od = nt.OriginalDefinition.ToDisplayString();
        if (od == "System.Collections.Generic.List<T>") return (Core ? HexElem(nt.TypeArguments[0]) : null) ?? (TypeDesc(nt.TypeArguments[0]) is string le ? $"[{le}]" : null);
        if (od == "System.Collections.Generic.Dictionary<TKey, TValue>") return TypeDesc(nt.TypeArguments[1]) is string de ? $"{{{de}}}" : null;
        return GenData(nt) ? "@" + GN(nt) : null;
    }
    /// 工具包模式：數字（含列舉）的陣列與 List，Unity 的 YAML 存成十六進位字串（小端序）：描述帶元素的格式，執行環境照它解
    public static string HexElem(ITypeSymbol e)
    {
        var st = e is INamedTypeSymbol { TypeKind: TypeKind.Enum } en ? en.EnumUnderlyingType!.SpecialType : e.SpecialType;
        return st switch
        {
            SpecialType.System_Int32 => "[$i32]",
            SpecialType.System_UInt32 => "[$u32]",
            SpecialType.System_Int16 => "[$i16]",
            SpecialType.System_UInt16 => "[$u16]",
            SpecialType.System_Byte => "[$u8]",
            SpecialType.System_SByte => "[$i8]",
            SpecialType.System_Single => "[$f32]",
            SpecialType.System_Int64 => "[$i64]",
            _ => null,
        };
    }
    /// ui：原始碼裡宣告的一般類別／結構（不是 UnityEngine.Object、這次也沒有轉它的方法，例如 Feel 的 InternalWiggleProperties）：欄位直接讀寫
    bool PlainSourceData(ITypeSymbol t) => t is INamedTypeSymbol nt && nt.DeclaringSyntaxReferences.Length > 0 && !DerivesFrom(nt, "UnityEngine.Object")
        && nt.TypeKind is TypeKind.Class or TypeKind.Struct && !GenMethods.ContainsKey(GN(nt));
    /// ui：屬性屬於這次轉的類別（自己、基底或別的類別）
    bool GenProp(IPropertySymbol p) => Ui && p.DeclaringSyntaxReferences.Length > 0 && (IfaceProp(p) || Same(p.ContainingType, T) || GenMethods.ContainsKey(GN(p.ContainingType))
        // 工具包模式：別的類別只轉了部分方法時，沒轉出來的屬性（有本體的）照舊走相容層（CoreInput 只轉 GetGestureSensitivity 時的 currentInputDeviceMode）
        && (!Core || AutoProp(p) || !PartialGen.Contains(GN(p.ContainingType)) || GenMethods[GN(p.ContainingType)].Contains("get_" + p.Name) || GenMethods[GN(p.ContainingType)].Contains("set_" + p.Name)));
    /// 這次只轉部分方法的類別（GenMethods 裡另外列了它轉出來的屬性存取子 get_／set_）
    public HashSet<string> PartialGen = new();
    /// 工具包模式：原始碼裡宣告的介面的實體屬性（IGameUIComponent.component）→ R.callIface(…, "get_名字")，照實體的實際類別找實作
    bool IfaceProp(IPropertySymbol p) => Core && !p.IsStatic && !p.IsIndexer && p.ContainingType.TypeKind == TypeKind.Interface && p.DeclaringSyntaxReferences.Length > 0;
    /// 自動屬性（get、set 都沒有本體）
    static bool AutoPropSyntax(IPropertySymbol p) => p.DeclaringSyntaxReferences.Length > 0 && p.DeclaringSyntaxReferences[0].GetSyntax() is PropertyDeclarationSyntax pd
        && pd.ExpressionBody == null && pd.AccessorList != null && pd.AccessorList.Accessors.All(a => a.Body == null && a.ExpressionBody == null);
    /// 工具包模式：抽象屬性（public abstract double start { get; }）寫法像自動屬性，但沒有 backing field，讀寫要照實際類別分派到覆寫的 get_／set_
    bool AutoProp(IPropertySymbol p) => AutoPropSyntax(p) && !(Core && p.IsAbstract);
    /// 工具包模式：virtual／override 的自動屬性（FloatingRewardReceiver 的 public virtual RewardType rewardType { get; }，子類別用 => 覆寫）。
    /// 資料照舊放 ai 的欄位，但讀寫要照實際類別分派：宣告的類別另外產生 get_／set_（讀寫那個欄位），呼叫端走 R.callGen。
    /// 以前直接讀欄位，每個接收者的 rewardType 都是 0，FloatingRewardManager 的表互相蓋掉，敵方遺物飛不到接收者、獎勵畫面關不掉
    bool VirtualAutoProp(IPropertySymbol p) => Core && !p.IsStatic && (p.IsVirtual || p.IsOverride) && AutoProp(p);
    static bool DerivesFromSym(ITypeSymbol t, ITypeSymbol b)
    {
        for (var x = t; x != null; x = x.BaseType) if (SymbolEqualityComparer.Default.Equals(x.OriginalDefinition, b.OriginalDefinition)) return true;
        return false;
    }
    /// ui：從基底（這次一起轉的類別）繼承來的實體欄位：同一個實體的 ai（執行期建 Ctx 時沿基底鏈合併 initAi）
    bool InheritedGenField(IFieldSymbol f) => Ui && !f.IsStatic && !Same(f.ContainingType, T) && GenMethods.ContainsKey(GN(f.ContainingType)) && DerivesFromSym(T, f.ContainingType)
        && !RT.Contains($"{TK(f.ContainingType)}_get_{f.Name}");
    /// ui：產生類別的屬性讀取。自動屬性是 ai 的欄位（對象是 this 時直接 c.ai，否則 R.mbGet）；有本體的走 get_名字（R.callGen 依實際類別分派）。
    /// 靜態的自動屬性：自己的是模組變數 S_名字，同一次轉的別的類別走 R.genStatic（那個模組的 statics）
    string PropGet(IPropertySymbol p, string recv, bool viaBase = false)
    {
        var owner = Js(GN(p.ContainingType));
        // base.屬性（EnhancerRewardData 的 Costs 回 base.Costs）：固定叫基底那一版，不照實際類別分派（以前分派回自己，無限遞迴）
        if (viaBase && !p.IsStatic && !IfaceProp(p) && !AutoProp(p)) return $"R.callAs(c, {owner}, {Js("get_" + p.Name)}, c.self)";
        if (IfaceProp(p)) return $"R.callIface(c, {owner}, {Js("get_" + p.Name)}, {recv ?? "c.self"})";
        if (AutoProp(p) && !(VirtualAutoProp(p) && !viaBase))
        {
            if (p.IsStatic) return Same(p.ContainingType, T) ? OwnStaticProp(p) : $"R.genStatic(c, {owner}, {Js(p.Name)})";
            return recv == null && DerivesFromSym(T, p.ContainingType) ? $"c.ai.{p.Name}" : $"R.mbGet(c, {recv ?? "c.self"}, {Js(p.Name)})";
        }
        if (p.IsStatic) return $"R.callStatic(c, {owner}, {Js("get_" + p.Name)})";
        return $"R.callGen(c, {owner}, {Js("get_" + p.Name)}, {recv ?? "c.self"})";
    }
    string PropSet(IPropertySymbol p, string recv, string val, bool viaBase = false)
    {
        var owner = Js(GN(p.ContainingType));
        if (viaBase && !p.IsStatic && !IfaceProp(p) && !AutoProp(p)) return $"R.callAs(c, {owner}, {Js("set_" + p.Name)}, c.self, {val})";
        if (IfaceProp(p)) return $"R.callIface(c, {owner}, {Js("set_" + p.Name)}, {recv ?? "c.self"}, {val})";
        if (AutoProp(p) && !(VirtualAutoProp(p) && !viaBase))
        {
            if (p.IsStatic) return Same(p.ContainingType, T) ? $"{OwnStaticProp(p)} = {val}" : $"R.genStaticSet(c, {owner}, {Js(p.Name)}, {val})";
            return recv == null && DerivesFromSym(T, p.ContainingType) ? $"c.ai.{p.Name} = {val}" : $"R.mbSet(c, {recv ?? "c.self"}, {Js(p.Name)}, {val})";
        }
        if (p.IsStatic) return $"R.callStatic(c, {owner}, {Js("set_" + p.Name)}, {val})";
        return $"R.callGen(c, {owner}, {Js("set_" + p.Name)}, {recv ?? "c.self"}, {val})";
    }
    /// 方法本體是迭代器（有自己的 yield；lambda、區域函式裡的不算）
    static bool IsIterator(SyntaxNode body) => body != null && body.DescendantNodes(n => n is not (LambdaExpressionSyntax or AnonymousMethodExpressionSyntax or LocalFunctionStatementSyntax)).OfType<YieldStatementSyntax>().Any();
    static bool DerivesFrom(ITypeSymbol t, string full)
    {
        for (var b = t; b != null; b = b.BaseType) if (b.ToDisplayString() == full) return true;
        return false;
    }
    /// ui：資料類別（ScriptableObject、[Serializable] 的一般類別／結構）在 TS 是匯出的 JSON 物件，欄位直接讀
    static bool UiData(ITypeSymbol t) => t is INamedTypeSymbol nt && (DerivesFrom(nt, "UnityEngine.ScriptableObject")
        || !DerivesFrom(nt, "UnityEngine.Object") && nt.IsSerializable && nt.TypeKind is TypeKind.Class or TypeKind.Struct);
    /// ui：元件（MonoBehaviour 等）的欄位，相容層沒有專門的名字時走通用的 R.mbGet／mbSet
    bool UiComponentField(ISymbol sym) => Ui && sym is IFieldSymbol { IsStatic: false } f && DerivesFrom(f.ContainingType, "UnityEngine.Component");

    static readonly JsonSerializerOptions JsOpt = new() { Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping };
    static string Js(string s) => JsonSerializer.Serialize(s, JsOpt);
    public static string JsStr(string s) => Js(s);

    // TS 那邊結構跟 C# 欄位一一對應的資料型別：屬性直接讀寫（設定檔的 directTypes）
    public static HashSet<string> DirectTypes = new();
    /// 產生檔檔頭：產生器名稱、反編譯原始碼資料夾（設定檔的 generator、csharp）
    public static string Generator = "unity-cs2ts", CsharpLabel = "";
    static readonly HashSet<string> Reserved = new() {
        "arguments", "function", "delete", "var", "let", "const", "typeof", "instanceof", "in", "of", "export", "import",
        "yield", "await", "with", "eval", "c", "R", "self", "undefined", "NaN", "Infinity", "new", "class", "enum",
    };

    public Emitter(SemanticModel m, INamedTypeSymbol t, TypeDeclarationSyntax d, string file, HashSet<string> rt, Dictionary<string, string> bucket)
    {
        M = m; T = t; D = d; File = file; RT = rt; Bucket = bucket;
    }

    string Loc(SyntaxNode n) => $"{Path.GetFileName(File)}:{n.GetLocation().GetLineSpan().StartLinePosition.Line + 1}";
    static string Snip(SyntaxNode n) { var s = Regex.Replace(n.ToString(), @"\s+", " "); return s.Length > 160 ? s[..160] + "…" : s; }

    string NotPorted(SyntaxNode n, string need)
    {
        Sites.Add($"{Loc(n)} {Snip(n)}{(need != null ? $"（缺 {need}）" : "")}");
        if (need != null) Missing[need] = Missing.GetValueOrDefault(need) + 1;
        return $"R.notPorted(c, {Js(Loc(n))}, {Js(Snip(n))}{(need != null ? ", " + Js(need) : "")})";
    }

    /// 工具包模式：相容層沒有這個名字時，沿外部型別的基底鏈找（FileStream_get_Position → Stream_get_Position）；
    /// 無參數的多載（X$）也接受沒有後綴的 X
    string ResolveRt(string name)
    {
        if (RT.Contains(name)) return name;
        if (!Core) return null;
        string Try(string cand) => RT.Contains(cand) ? cand : cand.EndsWith("$") && RT.Contains(cand[..^1]) ? cand[..^1] : null;
        if (Try(name) is string direct) return direct;
        for (int i = name.IndexOf('_'); i > 0; i = name.IndexOf('_', i + 1))
        {
            var rest = name[i..];
            var seen = new HashSet<string> { name[..i] };
            for (var k = ExternalBases.GetValueOrDefault(name[..i]); k != null && seen.Add(k); k = ExternalBases.GetValueOrDefault(k))
                if (Try(k + rest) is string viaBase) return viaBase;
        }
        return null;
    }
    /// 參照的 DLL 裡的型別 → 基底型別（TK 的名字；System.Object 不記）
    public static Dictionary<string, string> ExternalBases = new();

    /// 相容層呼叫：名字在 runtime.ts 才產生，不在就 notPorted
    string Rt(string name, IEnumerable<string> args, SyntaxNode n)
    {
        if (ResolveRt(name) is string resolved && resolved != name) name = resolved;
        if (!RT.Contains(name))
        {
            // 工具包模式：執行環境原生做的類別（設定檔的 exclude）的屬性，相容層沒有專門名字時交給 R.nativeGet／nativeSet
            // （執行環境先找專門的實作，再退回讀寫序列化欄位 m_名字，Unity 的屬性多半就是這樣包的）
            var nm = Core && RT.Contains("nativeGet") ? Regex.Match(name, @"^([A-Za-z0-9_]+?)_(get|set)_([A-Za-z0-9_]+)$") : Match.Empty;
            if (nm.Success && (Excluded.Contains(nm.Groups[1].Value) || NativeComponents.Contains(nm.Groups[1].Value) || NativeTypes.Contains(nm.Groups[1].Value)))
            {
                var a = args.ToList();
                var isGet = nm.Groups[2].Value == "get";
                var recv = isGet ? (a.Count >= 1 ? a[0] : "null") : (a.Count >= 2 ? a[0] : "null");
                var rest = isGet ? "" : $", {a[^1]}";
                return $"R.native{(isGet ? "Get" : "Set")}(c, {recv}, {Js(nm.Groups[1].Value)}, {Js(nm.Groups[3].Value)}{rest})";
            }
            return NotPorted(n, name);
        }
        return $"R.{name}({string.Join(", ", new[] { "c" }.Concat(args))})";
    }
    /// 設定檔 exclude 的類別（執行環境原生做的）
    public static HashSet<string> Excluded = new();
    /// 參照的 DLL 裡的 Unity 元件（AudioSource、Camera、Canvas…）：屬性同樣交給 R.nativeGet／nativeSet
    public static HashSet<string> NativeComponents = new();
    /// 參照的 DLL（UnityEngine*）裡其他的類別與結構（UnityWebRequest、ParticleSystem 的模組…）：屬性一樣交給 R.nativeGet／nativeSet
    public static HashSet<string> NativeTypes = new();

    static bool Same(ISymbol a, ISymbol b) => SymbolEqualityComparer.Default.Equals(a, b);

    // ───────── 型別名稱 ─────────
    public static string TKName(ITypeSymbol t) => TK(t);
    static string TK(ITypeSymbol t)
    {
        if (t is IArrayTypeSymbol at) return TK(at.ElementType) + "_arr";
        if (t is INamedTypeSymbol nt && nt.ContainingType != null) return TK(nt.ContainingType) + "_" + nt.Name;
        return t?.Name ?? "unknown";
    }
    static string ShortTK(ITypeSymbol t) => t.SpecialType switch
    {
        SpecialType.System_Int32 => "int",
        SpecialType.System_Single => "float",
        SpecialType.System_Double => "double",
        SpecialType.System_Boolean => "bool",
        SpecialType.System_String => "string",
        _ => TK(t),
    };
    static string Ovl(IMethodSymbol m)
    {
        var def = m.ReducedFrom ?? m;
        def = def.OriginalDefinition;
        var group = def.MethodKind == MethodKind.Constructor
            ? def.ContainingType.InstanceConstructors.Cast<IMethodSymbol>().ToList()
            : def.ContainingType.GetMembers(def.Name).OfType<IMethodSymbol>().ToList();
        if (group.Count <= 1) return "";
        return "$" + string.Join("_", def.Parameters.Select(p => ShortTK(p.Type)));
    }
    static bool IsIntegral(ITypeSymbol t) => t != null && (t.SpecialType is SpecialType.System_Int32 or SpecialType.System_Int64 or SpecialType.System_Int16
        or SpecialType.System_Byte or SpecialType.System_UInt32 or SpecialType.System_UInt64 or SpecialType.System_SByte or SpecialType.System_UInt16
        || t.TypeKind == TypeKind.Enum);
    static bool IsFloat(ITypeSymbol t) => t != null && t.SpecialType is SpecialType.System_Single or SpecialType.System_Double;
    /// 動畫事件能帶的參數型別（Unity 文件：float、int、string、Object、AnimationEvent）
    static string MsgArgKind(ITypeSymbol t) => t.SpecialType switch
    {
        SpecialType.System_Single => "f",
        SpecialType.System_Int32 => "i",
        SpecialType.System_String => "s",
        _ when t.ToDisplayString() == "UnityEngine.AnimationEvent" => "e",
        _ when DerivesFrom(t, "UnityEngine.Object") => "o",
        _ => "?",
    };
    /// 工具包模式：實作 IEnumerable 的產生類別（基底不是 .NET 的集合）：執行期的實體可以 for…of、展開
    bool GenEnumerable(ITypeSymbol ct) => Core && ct is INamedTypeSymbol gct && ct.TypeKind is TypeKind.Class or TypeKind.Struct && GenMethods.ContainsKey(GN(gct.OriginalDefinition))
        && ct.AllInterfaces.Any(i => i.ToDisplayString() == "System.Collections.IEnumerable") && !HasBclCollectionBase(gct);
    /// 基底鏈上有 .NET 的集合（class InkList : Dictionary<…>）：執行期的實體是 CsDict／陣列本身（extBase），不走介面的外觀
    static bool HasBclCollectionBase(INamedTypeSymbol t)
    {
        for (var b = t.BaseType; b != null; b = b.BaseType)
            if (b.ContainingNamespace?.ToDisplayString() is "System.Collections.Generic" or "System.Collections.ObjectModel") return true;
        return false;
    }
    static bool IsCollection(ITypeSymbol t)
    {
        if (t == null) return false;
        if (t is IArrayTypeSymbol) return true;
        var n = t.OriginalDefinition.ToDisplayString();
        return n.StartsWith("System.Collections.Generic.List<") || n.StartsWith("System.Collections.Generic.IList<")
            || n.StartsWith("System.Collections.Generic.IEnumerable<") || n.StartsWith("System.Collections.Generic.IReadOnlyList<")
            || n.StartsWith("System.Collections.Generic.ICollection<") || n.StartsWith("System.Collections.Generic.IReadOnlyCollection<");
    }
    // C# 的 @class、@in 先去掉 @ 再看是不是 JS 的保留字
    static string Id(string n)
    {
        var b = n.StartsWith("@") ? n[1..] : n;
        return Reserved.Contains(b) ? b + "$" : b;
    }

    /// 模組層的宣告用的預設值（還沒有 Ctx）：型別參數先給 null（cctor 會照型別引數再設），要叫相容層的包一層 R.staticCtx
    string DeclDefault(ITypeSymbol t)
    {
        if (t is ITypeParameterSymbol) return "null";
        var d = DefaultOf(t);
        return d.Contains("(c") || d.Contains("c,") ? $"(() => {{ const c: any = R.staticCtx; return {d}; }})()" : d;
    }

    /// C# 的 default(T)：參考型別是 null。DefaultOf 對集合型別給 []，那是 Unity 反序列化欄位的值（序列化的 List 讀出來是空清單），
    /// 運算式裡的 default、default(T)、new T[n] 的空格子、參數預設 null、FirstOrDefault 找不到時，C# 都是 null（Jason 10/18：
    /// RemoveDeadCharacters(overrideList = null) 被補成 []，打完 Boss 不出結算）。值型別、沒限定 class 的型別參數照舊 DefaultOf
    string CsDefault(ITypeSymbol t) => t != null && t.IsReferenceType ? "null" : DefaultOf(t);

    string DefaultOf(ITypeSymbol t)
    {
        if (t == null) return "null";
        // 工具包模式：型別參數的預設值要到執行時才知道（int 是 0、類別是 null、Vector3 是全 0）
        if (Core && t is ITypeParameterSymbol) return $"R.defaultOf({TypeRef(t)})";
        // ui：Unity 的值型別預設是全 0 的結構（Vector3.zero），不是 null
        if (Ui && t.TypeKind == TypeKind.Struct && t.ContainingNamespace?.ToDisplayString() == "UnityEngine")
            switch (t.Name)
            {
                case "Vector2": return "{ x: 0, y: 0 }";
                case "Vector3": return "{ x: 0, y: 0, z: 0 }";
                case "Vector4": case "Quaternion": return "{ x: 0, y: 0, z: 0, w: 0 }";
                case "Color": return "{ r: 0, g: 0, b: 0, a: 0 }";
                case "Color32" when Core: return "{ r: 0, g: 0, b: 0, a: 0, $color32: true }";
                case "Vector2Int" when Core: return "{ x: 0, y: 0 }";
                case "Vector3Int" when Core: return "{ x: 0, y: 0, z: 0 }";
                case "Rect" when Core: return "{ x: 0, y: 0, width: 0, height: 0 }";
                case "RectInt" when Core: return "{ x: 0, y: 0, width: 0, height: 0 }";
                case "Bounds" when Core: return "{ center: { x: 0, y: 0, z: 0 }, extents: { x: 0, y: 0, z: 0 } }";
                case "Matrix4x4" when Core: return "R.Matrix4x4_get_zero(c)";
            }
        // ui：原始碼裡宣告的 struct（Feel 的 InternalWiggleProperties）：每個實體欄位都是它型別的預設值。
        // 工具包模式另外帶 $type（跟 R.newGen 建的實體一樣）：介面分派、is、Equals 的覆寫要認得型別
        if (Ui && t.TypeKind == TypeKind.Struct && t.DeclaringSyntaxReferences.Length > 0 && t is INamedTypeSymbol st && !t.IsTupleType)
            return "{ " + (Core ? $"$type: {Js(GN(st.OriginalDefinition))}, " : "") + string.Join(", ", st.GetMembers().OfType<IFieldSymbol>().Where(f => !f.IsStatic && !f.IsConst && !f.IsImplicitlyDeclared)
                .Select(f => $"{f.Name}: {(SymbolEqualityComparer.Default.Equals(f.Type, t) ? "null" : DefaultOf(f.Type))}")) + " }";
        // 工具包模式：char 的預設值 '\0'（產生碼裡的 char 是長度 1 的字串；同執行期的 R.defaultOf("Char")）
        if (Core && t.SpecialType == SpecialType.System_Char) return Js("\0");
        if (IsIntegral(t) || IsFloat(t)) return "0";
        if (Core && t.Name == "LayerMask" && t.ContainingNamespace?.ToDisplayString() == "UnityEngine") return "0";
        // 工具包模式：DLL 裡的其他結構（Resolution、Hash128…）：執行環境登記的預設值（R.newExternal）
        if (Core && t.TypeKind == TypeKind.Struct && t.DeclaringSyntaxReferences.Length == 0 && t.SpecialType == SpecialType.None && t is INamedTypeSymbol { IsTupleType: false, TypeKind: TypeKind.Struct } xs
            && xs.OriginalDefinition.ToDisplayString() != "System.Nullable<T>" && !UiValueTypes.Contains(t.Name))
            return $"R.newExternal(c, {Js(TK(t))})";
        if (t.SpecialType == SpecialType.System_Boolean) return "false";
        if (IsCollection(t) && !(t is IArrayTypeSymbol)) return "[]";
        return "null";
    }

    static string ConstLit(object v, ITypeSymbol t, string comment)
    {
        string s = v switch
        {
            null => "null",
            bool b => b ? "true" : "false",
            string str => Js(str),
            char ch => Js(ch.ToString()),
            float f => f.ToString("R", System.Globalization.CultureInfo.InvariantCulture),
            double d => d.ToString("R", System.Globalization.CultureInfo.InvariantCulture),
            _ => Convert.ToString(v, System.Globalization.CultureInfo.InvariantCulture),
        };
        return comment != null ? $"{s} /* {comment} */" : s;
    }

    // ───────── 類別 ─────────
    public string Emit()
    {
        var keep = SelectedMethods(M, T, D, Only).ToHashSet(SymbolEqualityComparer.Default);
        selected = D.Members.OfType<MethodDeclarationSyntax>().Where(x => keep.Contains(M.GetDeclaredSymbol(x))).ToList();
        ClassifyFields();
        // ui：靜態欄位全部宣告（別的類別用 R.genStatic 讀寫，例如子類別讀基底的靜態欄位）
        if (Ui) foreach (var sf in T.GetMembers().OfType<IFieldSymbol>().Where(f => f.IsStatic && !f.IsConst && !f.IsImplicitlyDeclared)) staticFields.Add(sf);
        if (Ui) foreach (var sp in T.GetMembers().OfType<IPropertySymbol>().Where(x => x.IsStatic && AutoProp(x))) staticProps.Add(sp);
        foreach (var m in selected)
        {
            var sym = M.GetDeclaredSymbol(m);
            var same = selected.Count(x => x.Identifier.Text == m.Identifier.Text);
            ownMethods[sym] = Ui ? GenName(sym) : same > 1 ? $"{m.Identifier.Text}${sym.Parameters.Length}" : m.Identifier.Text;
        }
        var sb = new StringBuilder();
        sb.AppendLine($"// 自動產生（{Generator}），不要手改。對應 {CsharpLabel}/{File.Replace('\\', '/')}");
        sb.AppendLine("/* eslint-disable */");
        sb.AppendLine("// @ts-nocheck 的替代：產生的程式碼全部用 any，型別由 C# 端保證");
        sb.AppendLine("import * as R from '../runtime';");
        sb.AppendLine("import type { Ctx } from '../runtime';");
        sb.AppendLine();
        var overrides = new List<(string cs, string ts)>();
        var objectMethods = new SortedDictionary<string, string>(StringComparer.Ordinal);
        var body = new StringBuilder();
        foreach (var m in selected)
        {
            var sym = M.GetDeclaredSymbol(m);
            body.Append(EmitMethod(m, sym));
            body.AppendLine();
            if (sym.IsOverride) overrides.Add((m.Identifier.Text, ownMethods[sym]));
            // 工具包模式：覆寫 System.Object 的 Equals(object)／GetHashCode／ToString：相容層的 Object.Equals、Dictionary 的鍵比較、
            // 字串串接照這張表分派到產生的版本（呼叫端的靜態型別是 object 或泛型 T 時，產生碼只能叫相容層）
            if (Core && sym.IsOverride && sym.Name is "Equals" or "GetHashCode" or "ToString")
            {
                var root = sym;
                while (root.OverriddenMethod != null) root = root.OverriddenMethod;
                if (root.ContainingType.SpecialType == SpecialType.System_Object) objectMethods[root.Name] = ownMethods[sym];
            }
        }
        // 靜態欄位（方法裡用到的）：初始式在模組載入時算一次，跟 C# 的靜態初始化相同。
        // 工具包模式（Core）：會呼叫東西的初始式（new 別的產生類別、相容層…）延到 cctor 裡照宣告順序跑（C# 是型別初始化時跑、先欄位後靜態建構子；
        // 模組載入時別的類別還沒登記），宣告時先給型別的預設值
        var deferredInits = new List<(int pos, string line)>();
        // 工具包模式：參照別的靜態欄位（S_名字）的初始式也延到 cctor：C# 照宣告順序初始化，讀到後面的欄位得到預設值；JS 的 let 會丟 TDZ 錯
        bool SimpleInit(string init) => !init.Contains('(') && !init.Contains("R.") && !(Core && init.Contains("S_"));
        // 工具包模式：沒有初始式的靜態集合欄位是 null（C# 的預設值；DefaultOf 給 [] 是序列化欄位的規則，靜態欄位 Unity 不序列化）。
        // MT2 的 SubtypeManager._allData 是 `_allData ?? new List(…)` 的快取，以前一開始就是空陣列，所有角色的 subtype 都查不到
        string StaticDefault(ITypeSymbol t) => Core && IsCollection(t) && t is not IArrayTypeSymbol ? "null" : DefaultOf(t);
        foreach (var f in staticFields.OrderBy(f => f.Name, StringComparer.Ordinal))
        {
            var init = f.DeclaringSyntaxReferences[0].GetSyntax() is VariableDeclaratorSyntax vd && vd.Initializer != null ? E(vd.Initializer.Value) : StaticDefault(f.Type);
            if (Core && !SimpleInit(init))
            {
                var expr = init.Contains("R.notPorted(") ? $"R.staticInit(() => {init}, {Js($"{T.Name}.{f.Name}")})" : init;
                deferredInits.Add((f.DeclaringSyntaxReferences[0].Span.Start, $"  S_{f.Name} = {expr};"));
                sb.AppendLine($"// C# static 欄位 {T.Name}.{f.Name}（初始式在 cctor）");
                sb.AppendLine($"let S_{f.Name}: any = {DeclDefault(f.Type)};");
                continue;
            }
            // ui：靜態初始式用到相容層（Shader.PropertyToID）時給一個空的 Ctx（R.staticCtx）
            if (Ui && (init.Contains("c.") || init.Contains("(c"))) init = $"(() => {{ const c: any = R.staticCtx; return {init}; }})()";
            else if (init.Contains("c.") || init.Contains("(c")) init = NotPorted(f.DeclaringSyntaxReferences[0].GetSyntax(), $"靜態欄位初始式 {f.Name}");
            sb.AppendLine($"// C# static 欄位 {T.Name}.{f.Name}");
            sb.AppendLine($"let S_{f.Name}: any = {init};");
        }
        foreach (var p in staticProps.OrderBy(x => x.Name, StringComparer.Ordinal))
        {
            var init = p.DeclaringSyntaxReferences[0].GetSyntax() is PropertyDeclarationSyntax spd && spd.Initializer != null ? E(spd.Initializer.Value) : DefaultOf(p.Type);
            if (Core && !SimpleInit(init))
            {
                var expr = init.Contains("R.notPorted(") ? $"R.staticInit(() => {init}, {Js($"{T.Name}.{p.Name}")})" : init;
                deferredInits.Add((p.DeclaringSyntaxReferences[0].Span.Start, $"  S_{p.Name} = {expr};"));
                sb.AppendLine($"// C# static 屬性 {T.Name}.{p.Name}（初始式在 cctor）");
                sb.AppendLine($"let S_{p.Name}: any = {DeclDefault(p.Type)};");
                continue;
            }
            if (init.Contains("c.") || init.Contains("(c")) init = $"(() => {{ const c: any = R.staticCtx; return {init}; }})()";
            sb.AppendLine($"// C# static 屬性 {T.Name}.{p.Name}");
            sb.AppendLine($"let S_{p.Name}: any = {init};");
        }
        if (staticFields.Count > 0 || staticProps.Count > 0) sb.AppendLine();
        var propMethods = new List<string>();
        // ui：建構子（R.newGen 建資料物件後呼叫）；只轉部分方法時不產生
        if (Ui && Only == null)
            foreach (var cd in D.Members.OfType<ConstructorDeclarationSyntax>().Where(x => !x.Modifiers.Any(SyntaxKind.StaticKeyword)))
            {
                var cs = M.GetDeclaredSymbol(cd);
                var cname = CtorName(cs);
                var line = cd.GetLocation().GetLineSpan();
                body.AppendLine($"/** C#: {File.Replace('\\', '/')} {T.Name} 的建構子（:{line.StartLinePosition.Line + 1}-{line.EndLinePosition.Line + 1}） */");
                body.AppendLine($"function {cname}(c: Ctx{string.Join("", cd.ParameterList.Parameters.Select(p => $", {Id(p.Identifier.Text)}: any"))}): any {{");
                body.Append(OutBoxLines(cs));
                body.Append(StructParamCopyLines(cs, (SyntaxNode)cd.Body ?? cd.ExpressionBody));
                if (cd.Initializer != null && M.GetSymbolInfo(cd.Initializer).Symbol is IMethodSymbol bctor)
                {
                    var bargs = Args(cd.Initializer.ArgumentList, bctor);
                    if (cd.Initializer.IsKind(SyntaxKind.ThisConstructorInitializer))
                        body.AppendLine($"  {CtorName(bctor)}({string.Join(", ", new[] { "c" }.Concat(bargs))});");
                    else if (GenMethods.ContainsKey(GN(bctor.ContainingType)))
                        body.AppendLine($"  R.callAs({string.Join(", ", new[] { "c", Js(GN(bctor.ContainingType)), Js(CtorName(bctor)), "c.self" }.Concat(bargs))});");
                    // 工具包模式：直接基底不是產生的類別（DLL，或設定檔 exclude 給執行環境做的 PointerEventData）：: base(…) 照 new 基底(…)
                    // 叫相容層的建構子，結果併進這個實體（R.dllBaseInit）。以前整個不寫：MT2 的 FakePointerEventData 沒有 button，
                    // ReplayManager.TryClickButton 點不到按鈕；Ink 的 InkList(InkList) 複本是空的
                    else if (Core && bctor.ContainingType.TypeKind == TypeKind.Class && RT.Contains("dllBaseInit")
                        && ResolveRt($"new_{TK(bctor.ContainingType)}{Ovl(bctor)}") != null)
                        body.AppendLine($"  R.dllBaseInit(c, {Rt($"new_{TK(bctor.ContainingType)}{Ovl(bctor)}", bargs, cd.Initializer)});");
                }
                // 工具包模式：沒寫 : base(…) 的建構子，C# 會先跑基底的無參數建構子
                else if (Core && T.BaseType is INamedTypeSymbol cbt && GenMethods.ContainsKey(GN(cbt)))
                    body.AppendLine($"  R.baseCtor0(c, {Js(GN(cbt))});");
                if (cd.Body != null) Stmts(cd.Body.Statements, body, 1);
                else if (cd.ExpressionBody != null) body.AppendLine($"  {E(cd.ExpressionBody.Expression)};");
                body.AppendLine("}");
                body.AppendLine();
                propMethods.Add(cname);
            }
        // 工具包模式：使用者定義的運算子與轉型 → 靜態方法（產生名見 OpName；呼叫端走 R.callStatic）
        if (Core && Only == null)
            foreach (var od in D.Members.OfType<BaseMethodDeclarationSyntax>().Where(x => x is OperatorDeclarationSyntax or ConversionOperatorDeclarationSyntax))
            {
                var os = M.GetDeclaredSymbol(od);
                var oname = OpName(os);
                var line = od.GetLocation().GetLineSpan();
                body.AppendLine($"/** C#: {File.Replace('\\', '/')} {T.Name} 的運算子 {os.Name}（:{line.StartLinePosition.Line + 1}-{line.EndLinePosition.Line + 1}） */");
                body.AppendLine($"function {oname}(c: Ctx{string.Join("", od.ParameterList.Parameters.Select(p => $", {Id(p.Identifier.Text)}: any"))}): any {{");
                if (od.Body != null) Stmts(od.Body.Statements, body, 1);
                else if (od.ExpressionBody != null) body.AppendLine($"  return {E(od.ExpressionBody.Expression)};");
                body.AppendLine("}");
                body.AppendLine();
                propMethods.Add(oname);
            }
        // ui：靜態建構子 → cctor（R.registerGen 登記完全部類別後各跑一次；C# 是第一次用到才跑，這裡提早）
        var cctor = Ui && Only == null ? D.Members.OfType<ConstructorDeclarationSyntax>().FirstOrDefault(x => x.Modifiers.Any(SyntaxKind.StaticKeyword)) : null;
        var hasCctor = cctor != null || deferredInits.Count > 0;
        if (hasCctor)
        {
            if (cctor != null)
            {
                var line = cctor.GetLocation().GetLineSpan();
                body.AppendLine($"/** C#: {File.Replace('\\', '/')} {T.Name} 的靜態建構子（:{line.StartLinePosition.Line + 1}-{line.EndLinePosition.Line + 1}）{(deferredInits.Count > 0 ? "，前面先跑靜態欄位的初始式（宣告順序）" : "")} */");
            }
            else body.AppendLine($"/** C#: {File.Replace('\\', '/')} {T.Name} 的靜態欄位初始式（宣告順序；型別初始化時跑） */");
            body.AppendLine("function cctor(c: Ctx): any {");
            foreach (var (_, line) in deferredInits.OrderBy(x => x.pos)) body.AppendLine(line);
            if (cctor?.Body != null) Stmts(cctor.Body.Statements, body, 1);
            else if (cctor?.ExpressionBody != null) body.AppendLine($"  {E(cctor.ExpressionBody.Expression)};");
            body.AppendLine("}");
            body.AppendLine();
        }
        // ui：屬性。自動屬性進 initAi；有本體的產生 get_名字／set_名字（只轉部分方法時，只產生那些方法用到的）
        var autoProps = new List<IPropertySymbol>();
        if (Ui)
        {
            var usedProps = Only == null ? null : selected.SelectMany(x => x.DescendantNodes()).Select(n => M.GetSymbolInfo(n).Symbol).OfType<IPropertySymbol>()
                .Where(x => Same(x.ContainingType, T)).Select(x => x.Name).ToHashSet();
            foreach (var p in D.Members.OfType<BasePropertyDeclarationSyntax>().Where(x => x is PropertyDeclarationSyntax || Core && x is IndexerDeclarationSyntax))
            {
                var ps = (IPropertySymbol)M.GetDeclaredSymbol(p);
                // 工具包模式：抽象屬性沒有實作（子類別的覆寫才有 get_／set_）
                if (Core && ps.IsAbstract) continue;
                if (AutoProp(ps))
                {
                    if (!ps.IsStatic) autoProps.Add(ps);
                    // virtual／override 的自動屬性：讀寫照實際類別分派到 get_／set_，這一版讀寫 ai 的欄位（子類別用 => 覆寫的有自己的 get_）
                    if (VirtualAutoProp(ps))
                    {
                        var vl = p.GetLocation().GetLineSpan();
                        body.AppendLine($"/** C#: {File.Replace('\\', '/')} {T.Name}.{ps.Name}（virtual 自動屬性，:{vl.StartLinePosition.Line + 1}-{vl.EndLinePosition.Line + 1}） */");
                        body.AppendLine($"function get_{ps.Name}(c: Ctx): any {{");
                        body.AppendLine($"  return c.ai.{ps.Name};");
                        body.AppendLine("}");
                        body.AppendLine($"function set_{ps.Name}(c: Ctx, value: any): any {{");
                        body.AppendLine($"  c.ai.{ps.Name} = value;");
                        body.AppendLine("}");
                        body.AppendLine();
                        propMethods.Add($"get_{ps.Name}");
                        propMethods.Add($"set_{ps.Name}");
                    }
                    continue;
                }
                if (usedProps != null && !usedProps.Contains(ps.Name)) continue;
                body.Append(EmitProperty(p, ps, propMethods));
                body.AppendLine();
            }
        }
        foreach (var p in Only == null && !Ui ? D.Members.OfType<PropertyDeclarationSyntax>() : Enumerable.Empty<PropertyDeclarationSyntax>())
        {
            if (p.AccessorList == null && p.ExpressionBody == null) continue;
            if (p.AccessorList != null && p.AccessorList.Accessors.All(a => a.Body == null && a.ExpressionBody == null)) continue; // auto-property
            Sites.Add($"{Loc(p)} 屬性 {p.Identifier.Text}（有本體的屬性還沒支援）");
        }
        // 方法、建構子、屬性的本體一起寫出（10/13 修正：原本在建構子與屬性產生之前就寫出，那兩段掉了，方法表卻照樣列名字）
        sb.Append(body);
        // initAi
        sb.AppendLine("function initAi(c: Ctx): Record<string, any> {");
        sb.AppendLine("  return {");
        foreach (var (f, info) in fields.OrderBy(k => k.Key.Name, StringComparer.Ordinal))
        {
            if (info.kind == FieldKind.Ai)
            {
                var v = f.DeclaringSyntaxReferences[0].GetSyntax() is VariableDeclaratorSyntax vd && vd.Initializer != null
                    ? E(vd.Initializer.Value) : DefaultOf(f.Type);
                sb.AppendLine($"    {f.Name}: {v},");
            }
            else if (info.kind == FieldKind.EdAi && Ui)
            {
                var v = f.DeclaringSyntaxReferences[0].GetSyntax() is VariableDeclaratorSyntax vd && vd.Initializer != null
                    ? E(vd.Initializer.Value) : DefaultOf(f.Type);
                // 工具包模式：一般資料類別（不是 UnityEngine.Object）沒有初值的 List 欄位：程式碼 new 出來是 null（C# 的預設），
                // Unity 反序列化建的才是空清單。以前一律 []：MT2 的 DeckScreen.Params.cardDatas 變成空清單，選卡畫面當成「指定 0 張卡」
                if (Core && !DerivesFrom(T, "UnityEngine.Object") && !(f.DeclaringSyntaxReferences[0].GetSyntax() is VariableDeclaratorSyntax { Initializer: not null })
                    && f.Type is INamedTypeSymbol { OriginalDefinition: var lod } && lod.ToDisplayString() == "System.Collections.Generic.List<T>")
                    v = "R.serializedListDefault()";
                // 工具包模式：元件（UnityEngine.Object）裡 Unity 不序列化的集合欄位（private 沒 [SerializeField]、[NonSerialized]、readonly、型別序列化不了），
                // 沒有初值就是 C# 的預設 null；Unity 只替序列化的 List 建空清單。以前一律 []：MT2 的 ClassSelectCharacterDisplay.characters
                // 一開始就是空清單，Show 的 characters == null 不成立，PlayIdleWithoutSetup 沒叫到，沒 Setup 的 CharacterState.Update 每格丟例外
                else if (Core && DerivesFrom(T, "UnityEngine.Object") && v == "[]" && !(f.DeclaringSyntaxReferences[0].GetSyntax() is VariableDeclaratorSyntax { Initializer: not null })
                    && !UnitySerializedField(f) && !f.GetAttributes().Any(a => a.AttributeClass?.Name == "SerializeReference"))
                    v = "null";
                // 元件的欄位是這次轉的資料類別（CareerManager.currentCareerInformation）：照 Unity 反序列化，先 new（初始式、無參數建構子）
                // 再蓋上存檔值（R.unityData）。[SerializeReference] 的清單元素自己帶 $type，照舊複製
                var ud = DerivesFrom(T, "UnityEngine.Object") && !f.GetAttributes().Any(a => a.AttributeClass?.Name == "SerializeReference") ? TypeDesc(f.Type) : null;
                if (ud != null && (ud.Contains('@') || (Core && ud.Contains('$'))))
                    sb.AppendLine($"    {f.Name}: ({Js(f.Name)} in c.ed ? R.unityData(c, {Js(ud)}, c.ed.{f.Name}{(ud.Contains("$targ:") ? ", " + Js(GN(T)) : "")}) : {v}),");
                else sb.AppendLine($"    {f.Name}: ({Js(f.Name)} in c.ed ? R.cloneData(c.ed.{f.Name}) : {v}),");
            }
            else if (info.kind == FieldKind.EdAi)
                sb.AppendLine($"    {f.Name}: R.cloneData(c.ed.{(info.bucket == "" ? "" : info.bucket + ".")}{f.Name}),");
        }
        // ui：自動屬性（C# 的 backing field；Unity 不序列化，存檔裡有同名欄位才用）
        foreach (var ap in autoProps.OrderBy(x => x.Name, StringComparer.Ordinal))
        {
            var v = ap.DeclaringSyntaxReferences[0].GetSyntax() is PropertyDeclarationSyntax apd && apd.Initializer != null ? E(apd.Initializer.Value) : DefaultOf(ap.Type);
            sb.AppendLine($"    {ap.Name}: ({Js(ap.Name)} in c.ed ? R.cloneData(c.ed.{ap.Name}) : {v}),");
        }
        sb.AppendLine("  };");
        sb.AppendLine("}");
        sb.AppendLine();
        var cls = GN(T);
        sb.AppendLine($"export const {cls}: R.GenClassImpl = {{");
        sb.AppendLine($"  name: {Js(cls)},");
        sb.AppendLine($"  file: {Js(File.Replace('\\', '/'))},");
        // ui：基底類別（原始碼裡宣告的才算；執行期 R.callGen 依實體的實際類別沿這條鏈找覆寫，見 runtime.ts 的 dispatchClass）
        if (Ui && T.BaseType is INamedTypeSymbol bt && bt.DeclaringSyntaxReferences.Length > 0)
        {
            sb.AppendLine($"  base: {Js(GN(bt))},");
            // 工具包模式：傳給泛型基底的型別引數（class GamePrefs : PreferencesBase<GameData>）：基底的 typeof(T) 照這個；
            // 是自己的型別參數就寫 "$targ:序號"（照實體帶的型別引數）
            if (Core && bt.IsGenericType && bt.TypeArguments.Length > 0)
                sb.AppendLine($"  baseTargs: [{string.Join(", ", bt.TypeArguments.Select(a => a is ITypeParameterSymbol atp ? Js($"$targ:{atp.Ordinal}") : Js(GN(a.OriginalDefinition))))}],");
        }
        // 工具包模式：基底是 .NET 的集合（class InkList : Dictionary<InkListItem, int>）：執行期的實體本身要是那個集合
        else if (Core && T.BaseType is INamedTypeSymbol ebt && ebt.ContainingNamespace?.ToDisplayString() is "System.Collections.Generic" or "System.Collections.ObjectModel")
            sb.AppendLine($"  extBase: {Js(GN(ebt.OriginalDefinition))},");
        // 工具包模式：直接基底是 DLL 裡的型別（ScriptableObject、MonoBehaviour…，沒有原始碼，不寫 base）：整條 DLL 基底鏈。
        // 執行期的 typeNames 照它判斷（JsonUtility 把 UnityEngine.Object 的參照寫成 instanceID、x is ScriptableObject）
        else if (Core && T.TypeKind == TypeKind.Class && T.BaseType is INamedTypeSymbol dbt && dbt.DeclaringSyntaxReferences.Length == 0 && dbt.SpecialType != SpecialType.System_Object)
        {
            var chain = new List<string>();
            for (var b = dbt; b != null && b.SpecialType != SpecialType.System_Object; b = b.BaseType) chain.Add(TK(b.OriginalDefinition));
            sb.AppendLine($"  dllBases: [{string.Join(", ", chain.Select(Js))}],");
        }
        // 工具包模式：[RequireComponent(typeof(A), typeof(B))]：AddComponent 時 Unity 先補上這些元件
        if (Core)
        {
            var req = T.GetAttributes().Where(at => at.AttributeClass?.Name == "RequireComponent")
                .SelectMany(at => at.ConstructorArguments).Select(arg => arg.Value as ITypeSymbol).Where(x => x != null)
                .Select(x => GenMethods.ContainsKey(GN(x)) ? GN(x) : TK(x)).Distinct().ToList();
            if (req.Count > 0) sb.AppendLine($"  requires: [{string.Join(", ", req.Select(Js))}],");
        }
        // ui：實作的介面（R.isInstance 判斷 x is 介面用；只在相容層有 isInstance 時寫，diceomancer-web 的產生檔不變）
        if (Ui && RT.Contains("isInstance") && T.AllInterfaces.Length > 0)
            sb.AppendLine($"  interfaces: [{string.Join(", ", T.AllInterfaces.Select(i => Js(GN(i))).Distinct().OrderBy(x => x, StringComparer.Ordinal))}],");
        // ui：同一個泛型介面實作了兩種以上封閉型別（RelicInfoUI 的 IDataView<RelicState>、IDataView<RelicData>、IDataView<CollectableRelicData>）：
        // 產生名不帶型別引數分不出來，照 C# 的介面對應（FindImplementationForInterfaceMember）寫「介面<型別引數>$成員 → 實作的產生名」，
        // R.callIfaceT 照呼叫端的型別引數查。型別引數含型別參數的不寫（執行期才知道）
        if (Ui && RT.Contains("callIfaceT"))
        {
            var impls = T.AllInterfaces
                .Where(i => i.TypeArguments.Length > 0 && i.DeclaringSyntaxReferences.Length > 0 && !i.TypeArguments.Any(HasTypeParameter))
                .GroupBy(i => i.OriginalDefinition, SymbolEqualityComparer.Default).Where(g => g.Count() > 1).SelectMany(g => g)
                .SelectMany(i => i.GetMembers().OfType<IMethodSymbol>().Where(x => x.MethodKind == MethodKind.Ordinary)
                    .Select(x => (key: $"{GN(i)}<{string.Join(", ", i.TypeArguments.Select(TypeName))}>${x.Name}", impl: T.FindImplementationForInterfaceMember(x) as IMethodSymbol)))
                .Where(x => x.impl != null && x.impl.ContainingType.DeclaringSyntaxReferences.Length > 0)
                .Select(x => $"{Js(x.key)}: {Js(GenName(x.impl))}").Distinct().ToList();
            if (impls.Count > 0) sb.AppendLine($"  ifaceImpls: {{ {string.Join(", ", impls)} }},");
        }
        // ui：資料類別的欄位型別（R.unityData 往下建巢狀物件用，只列要特別處理的）與無參數建構子的產生名
        if (Ui && GenData(T))
        {
            var fd = T.GetMembers().OfType<IFieldSymbol>().Where(f => !f.IsStatic && !f.IsConst && !f.IsImplicitlyDeclared)
                .Select(f => (f.Name, desc: TypeDesc(f.Type))).Where(x => x.desc != null).ToList();
            if (fd.Count > 0) sb.AppendLine($"  fields: {{ {string.Join(", ", fd.Select(x => $"{x.Name}: {Js(x.desc)}"))} }},");
        }
        // 無參數建構子的產生名（資料類別反序列化先跑它；工具包模式下元件也是，Unity 建元件時會跑 C# 的建構子）
        if (Ui && (GenData(T) || Core) && T.InstanceConstructors.FirstOrDefault(x => x.Parameters.Length == 0 && !x.IsImplicitlyDeclared) is IMethodSymbol c0)
            sb.AppendLine($"  ctor0: {Js(CtorName(c0))},");
        // 工具包模式：結構（default(T)、new T() 的預設值要知道是值型別）
        if (Core && T.TypeKind == TypeKind.Struct) sb.AppendLine("  struct: true,");
        // 工具包模式：Unity 會序列化的欄位（宣告順序；public 或 [SerializeField]，不是 static／const／readonly、沒有 [NonSerialized]，
        // 型別要能序列化：Dictionary、介面、委派不行）。JsonUtility.ToJson、反序列化的欄位清單用
        if (Core)
        {
            var ser = T.GetMembers().OfType<IFieldSymbol>().Where(UnitySerializedField)
                .OrderBy(f => f.DeclaringSyntaxReferences.FirstOrDefault()?.Span.Start ?? 0).Select(f => Js(f.Name)).ToList();
            if (ser.Count > 0) sb.AppendLine($"  serialized: [{string.Join(", ", ser)}],");
        }
        // 工具包模式：MonoBehaviour 裡單一參數方法的參數種類（Unity 的動畫事件照它帶值）：f float、i int、s string、o UnityEngine.Object、
        // e AnimationEvent；其他型別記 ?（Unity 呼叫不了，記錯誤）
        if (Core && DerivesFrom(T, "UnityEngine.MonoBehaviour"))
        {
            var ma = ownMethods.Where(kv => !kv.Key.IsStatic && kv.Key.MethodKind == MethodKind.Ordinary && kv.Key.Parameters.Length == 1 && kv.Key.Parameters[0].RefKind == RefKind.None)
                .Select(kv => (name: kv.Value, k: MsgArgKind(kv.Key.Parameters[0].Type))).OrderBy(x => x.name, StringComparer.Ordinal).ToList();
            if (ma.Count > 0) sb.AppendLine($"  msgArgs: {{ {string.Join(", ", ma.Select(x => $"{x.name}: {Js(x.k)}"))} }},");
        }
        sb.AppendLine("  initAi,");
        if (hasCctor) sb.AppendLine("  cctor,");
        if (objectMethods.Count > 0) sb.AppendLine($"  objectMethods: {{ {string.Join(", ", objectMethods.Select(kv => $"{kv.Key}: {Js(kv.Value)}"))} }},");
        sb.AppendLine("  overrides: {");
        foreach (var (cs, ts) in overrides) sb.AppendLine($"    {cs}: {ts},");
        sb.AppendLine("  },");
        sb.AppendLine("  delegates: {");
        foreach (var k in delegateKeys) sb.AppendLine($"    {k}: {k},");
        sb.AppendLine("  },");
        // ui：靜態欄位（別的類別用 R.genStatic／genStaticSet 讀寫，例如 TutorialManager.Instance）
        if (Ui)
        {
            sb.AppendLine("  statics: {");
            foreach (var f in staticFields.OrderBy(f => f.Name, StringComparer.Ordinal))
                sb.AppendLine($"    {f.Name}: {{ get: () => S_{f.Name}, set: (v: any) => {{ S_{f.Name} = v; }} }},");
            foreach (var p in staticProps.OrderBy(x => x.Name, StringComparer.Ordinal))
                sb.AppendLine($"    {p.Name}: {{ get: () => S_{p.Name}, set: (v: any) => {{ S_{p.Name} = v; }} }},");
            sb.AppendLine("  },");
        }
        // 其他類別（戰場設定之類）會從外面呼叫的 public 方法
        sb.AppendLine("  methods: {");
        // ui：全部（Unity 的訊息 Awake／Update／OnMouseDown 是 private，由宿主呼叫；別的轉過的類別也直接叫）
        foreach (var (sym, ts) in ownMethods.Where(kv => Ui || kv.Key.DeclaredAccessibility == Accessibility.Public && !kv.Key.IsOverride).OrderBy(kv => kv.Value, StringComparer.Ordinal))
            sb.AppendLine($"    {ts}: {ts},");
        foreach (var pm in propMethods.OrderBy(x => x, StringComparer.Ordinal))
            sb.AppendLine($"    {pm}: {pm},");
        sb.AppendLine("  },");
        sb.AppendLine("};");
        return sb.ToString();
    }

    void ClassifyFields()
    {
        var assigned = new HashSet<ISymbol>(SymbolEqualityComparer.Default);
        // 只轉部分方法時，欄位也只看那些方法用到的（initAi 不去算用不到的初始式）
        var scope = Only == null ? D.DescendantNodes().ToList() : selected.SelectMany(x => x.DescendantNodes()).ToList();
        var used = new HashSet<IFieldSymbol>(SymbolEqualityComparer.Default);
        foreach (var n in scope)
            if (n is IdentifierNameSyntax or MemberAccessExpressionSyntax && M.GetSymbolInfo(n).Symbol is IFieldSymbol uf && Same(uf.ContainingType, T)) used.Add(uf);
        foreach (var n in scope)
        {
            ExpressionSyntax target = n switch
            {
                AssignmentExpressionSyntax a => a.Left,
                PostfixUnaryExpressionSyntax p when p.IsKind(SyntaxKind.PostIncrementExpression) || p.IsKind(SyntaxKind.PostDecrementExpression) => p.Operand,
                PrefixUnaryExpressionSyntax p when p.IsKind(SyntaxKind.PreIncrementExpression) || p.IsKind(SyntaxKind.PreDecrementExpression) => p.Operand,
                ArgumentSyntax arg when !arg.RefKindKeyword.IsKind(SyntaxKind.None) => arg.Expression,
                _ => null,
            };
            if (target == null) continue;
            var s = M.GetSymbolInfo(target).Symbol;
            if (s is IFieldSymbol) assigned.Add(s);
            // ui：改的是欄位的成員（cardHighlightInfo.card = …、pos.z = …）也算改了那個欄位
            if (Ui)
                for (var t2 = target; t2 is MemberAccessExpressionSyntax tm; t2 = tm.Expression)
                    if (M.GetSymbolInfo(tm.Expression).Symbol is IFieldSymbol rf && Same(rf.ContainingType, T)) assigned.Add(rf);
            // 改寫序列化欄位的內容（list.Add、陣列元素）也算：保守起見，呼叫 mutating 方法的欄位一律進 ai
        }
        foreach (var inv in scope.OfType<InvocationExpressionSyntax>())
        {
            if (inv.Expression is MemberAccessExpressionSyntax ma && M.GetSymbolInfo(ma.Expression).Symbol is IFieldSymbol fs
                && Same(fs.ContainingType, T) && IsCollection(fs.Type)
                && ma.Name.Identifier.Text is "Add" or "AddRange" or "Remove" or "RemoveAt" or "Clear" or "Insert" or "Sort" or "Reverse")
                assigned.Add(fs);
            // 序列化的清單／物件欄位傳進其他方法（DitwUtil.Shuffle、EnemyUtil.SummonEnemyInSummonSlot 會改它）：保守起見也進 ai
            if (M.GetSymbolInfo(inv).Symbol is IMethodSymbol callee && !Same(callee.ContainingType, T))
                foreach (var arg in inv.ArgumentList.Arguments)
                    if (M.GetSymbolInfo(arg.Expression).Symbol is IFieldSymbol af && Same(af.ContainingType, T) && IsCollection(af.Type))
                        assigned.Add(af);
        }
        foreach (var f in T.GetMembers().OfType<IFieldSymbol>())
        {
            if (f.IsConst || f.IsStatic || f.IsImplicitlyDeclared) continue;
            if (Only != null && !used.Contains(f) && !(Ui && IsGenBase)) continue;
            var serialized = f.DeclaredAccessibility == Accessibility.Public || f.GetAttributes().Any(a => a.AttributeClass?.Name == "SerializeField");
            var nonSer = f.GetAttributes().Any(a => a.AttributeClass?.Name == "NonSerializedAttribute" || a.AttributeClass?.Name == "NonSerialized");
            // ui：欄位一律放 ai。元件資料（場景／prefab 匯出的 JSON）有這個欄位就用存檔值，沒有就用初始式——
            // 跟 Unity 反序列化一樣（沒存的欄位、不能序列化的型別如 Dictionary 都留初始值）
            if (Ui)
                fields[f] = (FieldKind.EdAi, "");
            else if (serialized && Bucket.TryGetValue(f.Name, out var b))
                fields[f] = (assigned.Contains(f) ? FieldKind.EdAi : FieldKind.Ed, b);
            else if (serialized && !(f.GetAttributes().Any(a => a.AttributeClass?.Name == "NonSerializedAttribute" || a.AttributeClass?.Name == "NonSerialized")))
                fields[f] = (FieldKind.Missing, null);
            else
                fields[f] = (FieldKind.Ai, null);
        }
        // auto-property（有 backing field）：當 ai 欄位
    }

    /// Unity 會序列化的欄位：public 或 [SerializeField]，不是 static／const／readonly、沒有 [NonSerialized]，型別序列化得了
    static bool UnitySerializedField(IFieldSymbol f) =>
        !f.IsStatic && !f.IsConst && !f.IsReadOnly && !f.IsImplicitlyDeclared
        && (f.DeclaredAccessibility == Accessibility.Public || f.GetAttributes().Any(a => a.AttributeClass?.Name == "SerializeField"))
        && !f.GetAttributes().Any(a => a.AttributeClass?.Name is "NonSerializedAttribute" or "NonSerialized")
        && UnitySerializable(f.Type);

    /// Unity 序列化得了的型別：基本型別、字串、列舉、UnityEngine.Object、[Serializable] 的類別／結構、Unity 的值型別，以及它們的陣列與 List
    static bool UnitySerializable(ITypeSymbol t)
    {
        if (t is IArrayTypeSymbol at) return at.Rank == 1 && at.ElementType is not IArrayTypeSymbol && UnitySerializable(at.ElementType);
        if (t is not INamedTypeSymbol nt) return false;
        if (nt.SpecialType is SpecialType.System_Boolean or SpecialType.System_Byte or SpecialType.System_SByte or SpecialType.System_Char or SpecialType.System_Int16
            or SpecialType.System_UInt16 or SpecialType.System_Int32 or SpecialType.System_UInt32 or SpecialType.System_Int64 or SpecialType.System_UInt64
            or SpecialType.System_Single or SpecialType.System_Double or SpecialType.System_String) return true;
        if (nt.TypeKind == TypeKind.Enum) return true;
        if (nt.TypeKind is TypeKind.Interface or TypeKind.Delegate) return false;
        var od = nt.OriginalDefinition.ToDisplayString();
        if (od == "System.Collections.Generic.List<T>") return nt.TypeArguments[0] is not IArrayTypeSymbol && !(nt.TypeArguments[0] is INamedTypeSymbol la && la.OriginalDefinition.ToDisplayString() == "System.Collections.Generic.List<T>") && UnitySerializable(nt.TypeArguments[0]);
        if (DerivesFrom(nt, "UnityEngine.Object")) return true;
        if (nt.ContainingNamespace?.ToDisplayString() is "UnityEngine" && nt.TypeKind == TypeKind.Struct) return true;
        if (nt.IsGenericType && od.StartsWith("System.")) return false;
        return nt.IsSerializable && nt.TypeKind is TypeKind.Class or TypeKind.Struct;
    }

    /// 工具包模式的 LINQ 查詢語法：每一列是帶範圍變數的物件（{ x, y }），子句依序對到陣列操作與相容層的 linq 函式：
    /// from（第二個起是 flatMap）、let（map 加欄位）、where（filter）、orderby（linqOrderBy／ThenBy，穩定）、
    /// select（map）、group … by（linqGroupBy）、into（接續查詢）。join 還沒做。
    string QueryCore(QueryExpressionSyntax q)
    {
        string SrcOf(ExpressionSyntax ex)
        {
            var src = E(ex);
            var st = M.GetTypeInfo(ex).Type;
            if (st != null && !IsCollection(st) && st.SpecialType != SpecialType.System_String) src = Rt($"{TK(st)}_toArray", new[] { src }, ex);
            return src;
        }
        var vars = new List<string> { Id(q.FromClause.Identifier.Text) };
        string P() => "({ " + string.Join(", ", vars) + " }: any)";
        string Row() => "{ " + string.Join(", ", vars) + " }";
        var first = vars[0];
        var cur = $"[...{SrcOf(q.FromClause.Expression)}].map(({first}: any) => ({{ {first} }}))";
        var body = q.Body;
        while (true)
        {
            foreach (var cl in body.Clauses)
            {
                switch (cl)
                {
                    case WhereClauseSyntax wc:
                        cur = $"{cur}.filter({P()} => {E(wc.Condition)})";
                        break;
                    case LetClauseSyntax lc:
                    {
                        var expr = E(lc.Expression);
                        var before = P();
                        var row = "{ " + string.Join(", ", vars) + $", {Id(lc.Identifier.Text)}: {expr} }}";
                        vars.Add(Id(lc.Identifier.Text));
                        cur = $"{cur}.map({before} => ({row}))";
                        break;
                    }
                    case FromClauseSyntax fc:
                    {
                        var before = P();
                        var nv = Id(fc.Identifier.Text);
                        var inner = SrcOf(fc.Expression);
                        vars.Add(nv);
                        cur = $"{cur}.flatMap({before} => [...{inner}].map(({nv}: any) => ({Row()})))";
                        break;
                    }
                    case OrderByClauseSyntax oc:
                        for (var i = 0; i < oc.Orderings.Count; i++)
                        {
                            var o = oc.Orderings[i];
                            var desc = o.AscendingOrDescendingKeyword.IsKind(SyntaxKind.DescendingKeyword);
                            var fn = i == 0 ? (desc ? "linqOrderByDescending" : "linqOrderBy") : (desc ? "linqThenByDescending" : "linqThenBy");
                            cur = Rt(fn, new[] { cur, $"({P()} => {E(o.Expression)})" }, o);
                        }
                        break;
                    default:
                        return NotPorted(cl, null);
                }
            }
            string result;
            if (body.SelectOrGroup is SelectClauseSyntax sc)
                result = $"{cur}.map({P()} => {(E(sc.Expression) is var se && se.StartsWith("{") ? $"({se})" : se)})";
            else if (body.SelectOrGroup is GroupClauseSyntax gc)
                result = Rt("linqGroupBy", new[] { cur, $"({P()} => {E(gc.ByExpression)})", $"({P()} => {E(gc.GroupExpression)})" }, gc);
            else return NotPorted(body, null);
            if (body.Continuation == null) return result;
            var cv = Id(body.Continuation.Identifier.Text);
            vars = new List<string> { cv };
            cur = $"{result}.map(({cv}: any) => ({{ {cv} }}))";
            body = body.Continuation.Body;
        }
    }

    /// 工具包模式：同批轉的類別（或原始碼裡的介面）宣告的索引子 → R.callGen／callIface 的 get_Item／set_Item（val 不是 null 是寫入）；不是就回 null
    string GenIndexer(ElementAccessExpressionSyntax ea, string val)
    {
        if (!Core || M.GetSymbolInfo(ea).Symbol is not IPropertySymbol { IsIndexer: true } ip || ip.DeclaringSyntaxReferences.Length == 0) return null;
        var recv = ea.Expression is ThisExpressionSyntax ? "c.self" : E(ea.Expression);
        var args = ea.ArgumentList.Arguments.Select(x => E(x.Expression)).ToList();
        if (val != null) args.Add(val);
        var acc = Js((val == null ? "get_" : "set_") + IndexerName(ip));
        var owner = Js(GN(ip.ContainingType));
        if (ip.ContainingType.TypeKind == TypeKind.Interface) return $"R.callIface({string.Join(", ", new[] { "c", owner, acc, recv }.Concat(args))})";
        if (!Same(ip.ContainingType, T) && !GenMethods.ContainsKey(GN(ip.ContainingType))) return null;
        return $"R.callGen({string.Join(", ", new[] { "c", owner, acc, recv }.Concat(args))})";
    }

    /// 索引子的產生名：沿原始碼裡的基底鏈只有一種參數列 → Item；多種（JSONNode 的 this[int] 與 this[string]）→ Item$參數型別
    static string IndexerName(IPropertySymbol ip)
    {
        ip = ip.OriginalDefinition;
        var sigs = new List<IPropertySymbol>();
        for (INamedTypeSymbol t = ip.ContainingType; t != null && t.DeclaringSyntaxReferences.Length > 0; t = t.BaseType)
            foreach (var x in t.GetMembers().OfType<IPropertySymbol>().Where(x => x.IsIndexer))
                if (!sigs.Any(y => y.Parameters.Length == x.Parameters.Length && y.Parameters.Zip(x.Parameters).All(z => SymbolEqualityComparer.Default.Equals(z.First.Type, z.Second.Type))))
                    sigs.Add(x);
        return sigs.Count <= 1 ? "Item" : "Item$" + string.Join("_", ip.Parameters.Select(p => ShortTK(p.Type)));
    }

    /// ui：有本體的屬性 → get_名字(c)／set_名字(c, value)。
    /// 工具包模式另外：索引子 → get_Item(c, 索引…)／set_Item(c, 索引…, value)；明確介面實作 → 介面的產生名 $ get_名字（R.callIface 先找這個）
    string EmitProperty(BasePropertyDeclarationSyntax p, IPropertySymbol ps, List<string> propMethods)
    {
        var sb = new StringBuilder();
        var line = p.GetLocation().GetLineSpan();
        var pname = p is PropertyDeclarationSyntax pd0 ? pd0.Identifier.Text : IndexerName(ps);
        var exprBody = p is PropertyDeclarationSyntax pd1 ? pd1.ExpressionBody : ((IndexerDeclarationSyntax)p).ExpressionBody;
        var ixParams = p is IndexerDeclarationSyntax ixd ? ixd.ParameterList.Parameters.Select(x => Id(x.Identifier.Text)).ToList() : new List<string>();
        var ixDecl = string.Join("", ixParams.Select(x => $", {x}: any"));
        var prefix = ps.ExplicitInterfaceImplementations.Length > 0 ? $"{GN(ps.ExplicitInterfaceImplementations[0].ContainingType)}$" : "";
        sb.AppendLine($"/** C#: {File.Replace('\\', '/')} {T.Name}.{(p is IndexerDeclarationSyntax ? "this[]" : pname)}（屬性，:{line.StartLinePosition.Line + 1}-{line.EndLinePosition.Line + 1}） */");
        if (exprBody != null)
        {
            hoist = new();
            var e = E(exprBody.Expression);
            sb.AppendLine($"function {prefix}get_{pname}(c: Ctx{ixDecl}): any {{");
            foreach (var h in hoist) sb.AppendLine($"  let {h}: any;");
            sb.AppendLine($"  return {e};");
            sb.AppendLine("}");
            propMethods.Add($"{prefix}get_{pname}");
            return sb.ToString();
        }
        foreach (var acc in p.AccessorList.Accessors)
        {
            var isGet = acc.IsKind(SyntaxKind.GetAccessorDeclaration);
            if (!isGet && !acc.IsKind(SyntaxKind.SetAccessorDeclaration)) { Sites.Add($"{Loc(acc)} 屬性 {pname} 的 {acc.Keyword.Text}（不支援）"); continue; }
            var fname = prefix + (isGet ? "get_" : "set_") + pname;
            var iter = isGet && IsIterator(acc.Body);
            sb.AppendLine($"function{(iter ? "*" : "")} {fname}(c: Ctx{ixDecl}{(isGet ? "" : ", value: any")}): any {{");
            if (acc.Body != null) Stmts(acc.Body.Statements, sb, 1);
            else if (acc.ExpressionBody != null)
            {
                hoist = new();
                var e = E(acc.ExpressionBody.Expression);
                foreach (var h in hoist) sb.AppendLine($"  let {h}: any;");
                sb.AppendLine(isGet ? $"  return {e};" : $"  {e};");
            }
            sb.AppendLine("}");
            propMethods.Add(fname);
        }
        return sb.ToString();
    }

    /// 工具包模式：方法自己的 out 參數。呼叫端傳的是回呼（(__v) => { x = __v; }，跟相容層同一套）；方法開頭用 R.outBox 包成盒子，
    /// 方法內讀寫 參數.v（寫的時候順便叫回呼）。區域函式、lambda 不包
    bool OutBoxed(IParameterSymbol p) => Core && p.RefKind == RefKind.Out
        && p.ContainingSymbol is IMethodSymbol { MethodKind: MethodKind.Ordinary or MethodKind.Constructor or MethodKind.ExplicitInterfaceImplementation or MethodKind.UserDefinedOperator or MethodKind.Conversion };
    string OutBoxLines(IMethodSymbol m) => string.Concat(m.Parameters.Where(OutBoxed).Select(p => $"  {Id(p.Name)} = R.outBox({Id(p.Name)});\n" + OutStructInit(m, p)));

    /// 工具包模式：結構型別的 out 參數被逐欄位賦值（resultOut.x = …，CoreInterp.AsVector）：C# 寫的是呼叫端那個變數的欄位，
    /// JS 的 out 盒子一開始沒有值。方法開頭先給 default(T)（經過 setter 交回呼叫端），之後改欄位就是改呼叫端拿到的那個物件。
    /// C# 規定 out 離開前一定賦值，先給預設值不改語意
    string OutStructInit(IMethodSymbol m, IParameterSymbol p)
    {
        if (p.Type.TypeKind != TypeKind.Struct || p.Type.SpecialType != SpecialType.None || m.DeclaringSyntaxReferences.Length == 0) return "";
        var syn = m.DeclaringSyntaxReferences[0].GetSyntax();
        var writesField = syn.DescendantNodes().OfType<AssignmentExpressionSyntax>().Any(a => a.Left is MemberAccessExpressionSyntax { Expression: IdentifierNameSyntax id }
            && SymbolEqualityComparer.Default.Equals(M.GetSymbolInfo(id).Symbol, p));
        var def = writesField ? DefaultOf(p.Type) : "null";
        return def == "null" ? "" : $"  {Id(p.Name)}.v = {def};\n";
    }

    /// 工具包模式：結構型別的參數在方法裡被改（startValue.r += …、p.Normalize()）：C# 的參數是複本，JS 傳的是物件參照，
    /// 方法開頭先複製一份（DOTween 的 ColorPlugin.EvaluateAndApply 就是這樣改 startValue）
    string StructParamCopyLines(IMethodSymbol m, SyntaxNode body)
    {
        if (!Core || body == null) return "";
        var sb = new StringBuilder();
        foreach (var p in m.Parameters)
        {
            var t = p.Type;
            if (p.RefKind != RefKind.None || !(t.IsValueType && t.TypeKind == TypeKind.Struct && t.SpecialType == SpecialType.None) || t.Name.StartsWith("ValueTuple")
                || t.OriginalDefinition.SpecialType == SpecialType.System_Nullable_T) continue;
            bool RootedAtP(ExpressionSyntax e)
            {
                while (e is MemberAccessExpressionSyntax ma) e = ma.Expression;
                while (e is ParenthesizedExpressionSyntax pe) e = pe.Expression;
                return e is IdentifierNameSyntax id && SymbolEqualityComparer.Default.Equals(M.GetSymbolInfo(id).Symbol, p);
            }
            bool mutated = body.DescendantNodes().Any(n => n switch
            {
                AssignmentExpressionSyntax a => a.Left is MemberAccessExpressionSyntax && RootedAtP(a.Left),
                PostfixUnaryExpressionSyntax pu => pu.Operand is MemberAccessExpressionSyntax && RootedAtP(pu.Operand),
                PrefixUnaryExpressionSyntax pr => pr.IsKind(SyntaxKind.PreIncrementExpression) || pr.IsKind(SyntaxKind.PreDecrementExpression)
                    ? pr.Operand is MemberAccessExpressionSyntax && RootedAtP(pr.Operand) : false,
                InvocationExpressionSyntax inv => inv.Expression is MemberAccessExpressionSyntax im && RootedAtP(im.Expression)
                    && M.GetSymbolInfo(inv).Symbol is IMethodSymbol { IsStatic: false, IsReadOnly: false, ReducedFrom: null },
                _ => false,
            });
            if (mutated) sb.Append($"  {Id(p.Name)} = R.cloneData({Id(p.Name)});\n");
        }
        return sb.ToString();
    }

    string EmitMethod(MethodDeclarationSyntax m, IMethodSymbol sym)
    {
        var sb = new StringBuilder();
        var ps = string.Join("", m.ParameterList.Parameters.Select(p => $", {Id(p.Identifier.Text)}: any"));
        // 工具包模式：泛型方法的型別引數接在參數後面（呼叫端照順序傳型別名）
        if (Core && sym.IsGenericMethod) ps += string.Join("", sym.TypeParameters.Select(tp => $", __T_{tp.Name}?: any"));
        var line = m.GetLocation().GetLineSpan();
        var mods = sym.IsAsync ? (Ui ? "（async）" : "（原版 async，引擎同步執行）") : "";
        sb.AppendLine($"/** C#: {File.Replace('\\', '/')} {T.Name}.{m.Identifier.Text}（:{line.StartLinePosition.Line + 1}-{line.EndLinePosition.Line + 1}）{mods} */");
        // ui：迭代器（IEnumerator + yield，協程用）→ generator；StartCoroutine 在相容層推進（runtime.ts 的 MonoBehaviour_StartCoroutine）
        var iter = Ui && IsIterator(m.Body);
        sb.AppendLine($"{(Ui && sym.IsAsync ? "async " : "")}function{(iter ? "*" : "")} {ownMethods[sym]}(c: Ctx{ps}): any {{");
        sb.Append(OutBoxLines(sym));
        sb.Append(StructParamCopyLines(sym, (SyntaxNode)m.Body ?? m.ExpressionBody));
        if (m.Body != null) Stmts(m.Body.Statements, sb, 1);
        else if (m.ExpressionBody != null)
        {
            hoist = new();
            var e = E(m.ExpressionBody.Expression);
            foreach (var h in hoist) sb.AppendLine($"  let {h}: any;");
            sb.AppendLine(sym.ReturnsVoid ? $"  {e};" : $"  return {e};");
        }
        // 工具包模式：extern（[DllImport] 的原生函式）→ R.pinvoke：網頁上沒有原生程式庫，執行環境回預設值並記下來
        else if (Core && sym.IsExtern)
        {
            var dll = sym.GetAttributes().FirstOrDefault(a => a.AttributeClass?.Name == "DllImportAttribute")?.ConstructorArguments.FirstOrDefault().Value as string ?? "";
            var pnames = m.ParameterList.Parameters.Select(p => Id(p.Identifier.Text));
            sb.AppendLine($"  return R.pinvoke(c, {Js(dll)}, {Js(m.Identifier.Text)}, {Js(sym.ReturnsVoid ? "void" : ShortTK(sym.ReturnType))}, [{string.Join(", ", pnames)}]);");
        }
        sb.AppendLine("}");
        return sb.ToString();
    }

    // ───────── 敘述 ─────────
    static string Ind(int n) => new string(' ', n * 2);

    void Stmt(StatementSyntax st, StringBuilder sb, int ind)
    {
        var saved = hoist;
        hoist = new();
        var inner = new StringBuilder();
        StmtInner(st, inner, ind);
        foreach (var h in hoist) sb.AppendLine($"{Ind(ind)}let {h}: any;");
        sb.Append(inner);
        hoist = saved;
    }

    /// 一串敘述。ui：反編譯留下的 goto 跳到同一串裡的標籤：
    ///   - 都是往前跳（CharacterState.cs:1967）：從第一個含 goto 的敘述到標籤前包成 `標籤: { … }`，goto 換成 break 標籤。
    ///   - 有往回跳或範圍交錯（CharacterState.cs:5059 的 IL_06be／IL_06b1）：整串改成 for + switch 的狀態機（GotoStateMachine）。
    ///   兩種都做不到的（goto 從這串外面跳進來、標籤在更深的區塊裡），維持 notPorted
    void Stmts(IReadOnlyList<StatementSyntax> list, StringBuilder sb, int ind)
    {
        // 工具包模式：C# 8 的 using 宣告（`using var x = …;`）在所在區塊結束時 Dispose：同一串後面的敘述包進 try，finally 反過來釋放。
        // 10/16 以前當成普通宣告，FileSystemUtils.WriteAllTextWithBackup 的 FileStream 沒關，存檔全是 0 位元組
        if (Core)
        {
            var k = -1;
            for (int i = 0; i < list.Count && k < 0; i++)
                if (list[i] is LocalDeclarationStatementSyntax { UsingKeyword.RawKind: (int)SyntaxKind.UsingKeyword, AwaitKeyword.RawKind: 0 }) k = i;
            if (k >= 0)
            {
                var ld = (LocalDeclarationStatementSyntax)list[k];
                Stmts(list.Take(k).ToList(), sb, ind);
                Stmt(ld, sb, ind);
                sb.AppendLine($"{Ind(ind)}try {{");
                Stmts(list.Skip(k + 1).ToList(), sb, ind + 1);
                sb.AppendLine($"{Ind(ind)}}} finally {{");
                foreach (var v in ld.Declaration.Variables.Reverse())
                    sb.AppendLine($"{Ind(ind + 1)}{DisposeCall((M.GetDeclaredSymbol(v) as ILocalSymbol)?.Type, Id(v.Identifier.Text), v)};");
                sb.AppendLine($"{Ind(ind)}}}");
                return;
            }
        }
        var regions = new List<(int start, int end, string label)>();
        if (Ui && list.Any(x => x is LabeledStatementSyntax))
        {
            regions = ForwardGotoRegions(list);
            var jumped = Enumerable.Range(0, list.Count).Where(k => list[k] is LabeledStatementSyntax ls && LabelGotos(ls).Count > 0);
            if (!jumped.All(k => regions.Any(r => r.end == k)) && GotoStateMachine(list, sb, ind)) return;
        }
        for (int i = 0; i < list.Count; i++)
        {
            var r = regions.FirstOrDefault(x => x.start == i);
            if (r.label == null) { Stmt(list[i], sb, ind); continue; }
            gotoJumps[r.label] = $"break {Id(r.label)};";
            sb.AppendLine($"{Ind(ind)}{Id(r.label)}: {{");
            for (int j = r.start; j < r.end; j++) Stmt(list[j], sb, ind + 1);
            sb.AppendLine($"{Ind(ind)}}}");
            gotoJumps.Remove(r.label);
            Stmt(((LabeledStatementSyntax)list[r.end]).Statement, sb, ind);
            i = r.end;
        }
    }

    /// 跳到這個標籤的 goto（標籤的有效範圍是所在的方法、區域函式或 lambda；goto 不能跨進巢狀的函式）
    static List<GotoStatementSyntax> LabelGotos(LabeledStatementSyntax ls)
    {
        var label = ls.Identifier.Text;
        var root = ls.Ancestors().First(n => n is BaseMethodDeclarationSyntax or AccessorDeclarationSyntax or LocalFunctionStatementSyntax or AnonymousFunctionExpressionSyntax);
        return root.DescendantNodes(n => n == root || n is not (LocalFunctionStatementSyntax or AnonymousFunctionExpressionSyntax)).OfType<GotoStatementSyntax>()
            .Where(g => g.IsKind(SyntaxKind.GotoStatement) && g.Expression is IdentifierNameSyntax gi && gi.Identifier.Text == label).ToList();
    }

    /// goto 的狀態機：這串在第 0 個 case，每個標籤開一個 case，switch 照順序往下掉就是原本的流程；goto 換成「設狀態、continue 迴圈」。
    ///   let __s = 0; __g: for (;;) { switch (__s) { case 0: … case 1: /* 標籤 */ … } break; }
    /// 這一層的區域變數（含 out var、?. 的暫存）提到迴圈外宣告，原本的宣告改成指定：重新進 switch 時才不會丟掉值。
    /// 不做（回 false）：goto 從這串外面跳進來、這一層有區域函式、break／continue 會被新的迴圈接走
    bool GotoStateMachine(IReadOnlyList<StatementSyntax> list, StringBuilder sb, int ind)
    {
        var labels = Enumerable.Range(0, list.Count).Where(k => list[k] is LabeledStatementSyntax).ToList();
        foreach (var k in labels)
            if (LabelGotos((LabeledStatementSyntax)list[k]).Any(g => !list.Any(x => x.Span.Contains(g.Span)))) return false;
        if (list.Any(x => x is LocalFunctionStatementSyntax)) return false;
        var block = list[0].Parent;
        foreach (var bc in list.SelectMany(x => x.DescendantNodesAndSelf(n => n is not (LocalFunctionStatementSyntax or AnonymousFunctionExpressionSyntax))))
        {
            if (bc is not (BreakStatementSyntax or ContinueStatementSyntax)) continue;
            var owned = false;
            for (var p = bc.Parent; p != block && !owned; p = p.Parent)
                owned = p is ForStatementSyntax or ForEachStatementSyntax or WhileStatementSyntax or DoStatementSyntax || bc is BreakStatementSyntax && p is SwitchStatementSyntax;
            if (!owned) return false;
        }
        var n = ++tmp;
        var sv = $"__s{n}";
        var lp = $"__g{n}";
        for (int i = 0; i < labels.Count; i++) gotoJumps[((LabeledStatementSyntax)list[labels[i]]).Identifier.Text] = $"{{ {sv} = {i + 1}; continue {lp}; }}";
        var decls = new List<string>();
        var body = new StringBuilder();
        var I3 = Ind(ind + 3);
        body.AppendLine($"{Ind(ind + 2)}case 0:");
        for (int i = 0, li = 0; i < list.Count; i++)
        {
            var st = list[i];
            if (st is LabeledStatementSyntax ls)
            {
                body.AppendLine($"{Ind(ind + 2)}case {++li}: // {ls.Identifier.Text}");
                st = ls.Statement;
            }
            var saved = hoist;
            hoist = new();
            var inner = new StringBuilder();
            if (st is LocalDeclarationStatementSyntax ld)
                foreach (var v in ld.Declaration.Variables)
                {
                    decls.Add(Id(v.Identifier.Text));
                    if (v.Initializer != null) inner.AppendLine($"{I3}{Id(v.Identifier.Text)} = {CopyIfStruct(v.Initializer.Value, (M.GetDeclaredSymbol(v) as ILocalSymbol)?.Type)};");
                }
            else StmtInner(st, inner, ind + 3);
            decls.AddRange(hoist);
            hoist = saved;
            body.Append(inner);
        }
        foreach (var lb in labels) gotoJumps.Remove(((LabeledStatementSyntax)list[lb]).Identifier.Text);
        foreach (var d in decls.Distinct()) sb.AppendLine($"{Ind(ind)}let {d}: any;");
        sb.AppendLine($"{Ind(ind)}let {sv}: any = 0;");
        sb.AppendLine($"{Ind(ind)}{lp}: for (;;) {{");
        sb.AppendLine($"{Ind(ind + 1)}switch ({sv}) {{");
        sb.Append(body);
        sb.AppendLine($"{Ind(ind + 1)}}}");
        sb.AppendLine($"{Ind(ind + 1)}break;");
        sb.AppendLine($"{Ind(ind)}}}");
        return true;
    }

    /// switch 區段的 case／default 標籤
    void SwitchLabels(SwitchSectionSyntax sec, StringBuilder sb, string I)
    {
        foreach (var lab in sec.Labels)
        {
            switch (lab)
            {
                case CaseSwitchLabelSyntax cl: sb.AppendLine($"{I}  case {E(cl.Value)}:"); break;
                case DefaultSwitchLabelSyntax: sb.AppendLine($"{I}  default:"); break;
                default: sb.AppendLine($"{I}  default: {NotPorted(lab, null)};"); break;
            }
        }
    }

    /// 敘述結束時一定跳走（break、return、throw、goto、continue，或最後一句是這些的區塊）：後面不會往下走
    static bool EndsWithJump(StatementSyntax s) => s switch
    {
        BreakStatementSyntax or ReturnStatementSyntax or ThrowStatementSyntax or GotoStatementSyntax or ContinueStatementSyntax => true,
        BlockSyntax b => b.Statements.Count > 0 && EndsWithJump(b.Statements[^1]),
        _ => false,
    };

    /// 工具包模式：反編譯的 switch，case 區段裡的 goto 跳到別的區段裡的標籤（MT2 的 CardUI.UpdateAbility：Monster、Equipment 兩段 goto 到
    /// default: 的 break; 後面的 IL_0115／IL_028d）。GotoStateMachine 只管同一串敘述，這裡把整個 switch 當成狀態機的第 0 個 case：
    ///   let __s = 0; __g: for (;;) { switch (__s) { case 0: switch (原本的) { …每段到第一個標籤前… } break __g; case 1: /* 標籤 */ … } break; }
    /// 標籤以後的敘述（到同段的下一個標籤或段尾）搬到外層的 case，同段相鄰的標籤照順序往下掉；標籤前的敘述會走進標籤時補一個跳轉。
    /// 標籤裡跳出原本 switch 的 break 在外層跳出 switch (__s)，接著的 break 跳出迴圈，等於原本 switch 之後。
    /// 不做（回 false）：goto 從 switch 外面跳進來、都是同段裡的 goto（交給 Stmts）、區段直接宣告的區域變數（C# 整個 switch 共用）、
    /// 要接到 switch 外面迴圈的 continue（會被新的迴圈接走）
    bool SwitchGotoMachine(SwitchStatementSyntax sw, StringBuilder sb, int ind)
    {
        var labels = new List<(SwitchSectionSyntax sec, int pos, LabeledStatementSyntax ls)>();
        foreach (var sec in sw.Sections)
            for (int i = 0; i < sec.Statements.Count; i++)
                if (sec.Statements[i] is LabeledStatementSyntax ls) labels.Add((sec, i, ls));
        if (labels.Count == 0) return false;
        var cross = false;
        foreach (var (sec, _, ls) in labels)
        {
            var gs = LabelGotos(ls);
            if (gs.Any(g => !sw.Span.Contains(g.Span))) return false;
            if (gs.Any(g => !sec.Span.Contains(g.Span))) cross = true;
        }
        if (!cross) return false;
        if (sw.Sections.Any(s => s.Statements.Any(x => x is LocalDeclarationStatementSyntax or LocalFunctionStatementSyntax))) return false;
        foreach (var cs in sw.DescendantNodes(x => x is not (LocalFunctionStatementSyntax or AnonymousFunctionExpressionSyntax)).OfType<ContinueStatementSyntax>())
        {
            var owned = false;
            for (var p = cs.Parent; p != sw && !owned; p = p.Parent) owned = p is ForStatementSyntax or ForEachStatementSyntax or WhileStatementSyntax or DoStatementSyntax;
            if (!owned) return false;
        }
        var n = ++tmp;
        var sv = $"__s{n}";
        var lp = $"__g{n}";
        for (int i = 0; i < labels.Count; i++) gotoJumps[labels[i].ls.Identifier.Text] = $"{{ {sv} = {i + 1}; continue {lp}; }}";
        var I = Ind(ind);
        var I3 = Ind(ind + 3);
        sb.AppendLine($"{I}let {sv}: any = 0;");
        sb.AppendLine($"{I}{lp}: for (;;) {{");
        sb.AppendLine($"{I}  switch ({sv}) {{");
        sb.AppendLine($"{I}    case 0:");
        sb.AppendLine($"{I3}switch ({E(sw.Expression)}) {{");
        foreach (var sec in sw.Sections)
        {
            SwitchLabels(sec, sb, I3);
            sb.AppendLine($"{I3}  {{");
            var first = labels.FirstOrDefault(l => l.sec == sec);
            var pre = first.ls == null ? sec.Statements.ToList() : sec.Statements.Take(first.pos).ToList();
            Stmts(pre, sb, ind + 5);
            if (first.ls != null && (pre.Count == 0 || !EndsWithJump(pre[^1]))) sb.AppendLine($"{Ind(ind + 5)}{gotoJumps[first.ls.Identifier.Text]}");
            sb.AppendLine($"{I3}  }}");
        }
        sb.AppendLine($"{I3}}}");
        sb.AppendLine($"{I3}break {lp};");
        for (int i = 0; i < labels.Count; i++)
        {
            var (sec, pos, ls) = labels[i];
            var next = labels.Where(l => l.sec == sec && l.pos > pos).Select(l => l.pos).DefaultIfEmpty(sec.Statements.Count).Min();
            var tail = new List<StatementSyntax> { ls.Statement };
            tail.AddRange(sec.Statements.Skip(pos + 1).Take(next - pos - 1));
            sb.AppendLine($"{I}    case {i + 1}: // {ls.Identifier.Text}");
            sb.AppendLine($"{I3}{{");
            Stmts(tail, sb, ind + 4);
            sb.AppendLine($"{I3}}}");
        }
        sb.AppendLine($"{I}  }}");
        sb.AppendLine($"{I}  break;");
        sb.AppendLine($"{I}}}");
        foreach (var l in labels) gotoJumps.Remove(l.ls.Identifier.Text);
        return true;
    }

    /// goto case X／goto default 跳到的是不是這一段 case
    bool GotoCaseHits(GotoStatementSyntax g, SwitchSectionSyntax sec)
    {
        if (g.IsKind(SyntaxKind.GotoDefaultStatement)) return sec.Labels.Any(l => l is DefaultSwitchLabelSyntax);
        if (!g.IsKind(SyntaxKind.GotoCaseStatement) || M.GetConstantValue(g.Expression) is not { HasValue: true } gv) return false;
        return sec.Labels.OfType<CaseSwitchLabelSyntax>().Any(l => M.GetConstantValue(l.Value) is { HasValue: true } lv && Equals(lv.Value, gv.Value));
    }

    /// 往前跳的 goto 範圍：(第一個含 goto 的敘述, 標籤敘述的位置, 標籤)
    List<(int start, int end, string label)> ForwardGotoRegions(IReadOnlyList<StatementSyntax> list)
    {
        var found = new List<(int start, int end, string label)>();
        for (int k = 0; k < list.Count; k++)
        {
            if (list[k] is not LabeledStatementSyntax ls) continue;
            var label = ls.Identifier.Text;
            var gotos = LabelGotos(ls);
            if (gotos.Count == 0) continue;
            var idx = gotos.Select(g => Enumerable.Range(0, k).FirstOrDefault(j => list[j].Span.Contains(g.Span), -1)).ToList();
            if (idx.Any(j => j < 0)) continue;
            var start = idx.Min();
            // 範圍裡宣告的變數（區域宣告、out var、模式變數）包進區塊後出不來：標籤之後還用到就不做
            var region = Enumerable.Range(start, k - start).Select(j => list[j]).ToList();
            var declared = region.OfType<LocalDeclarationStatementSyntax>().SelectMany(d => d.Declaration.Variables).Select(v => M.GetDeclaredSymbol(v))
                .Concat(region.SelectMany(x => x.DescendantNodes()).OfType<SingleVariableDesignationSyntax>().Select(v => M.GetDeclaredSymbol(v)))
                .Where(x => x != null).ToHashSet(SymbolEqualityComparer.Default);
            if (declared.Count > 0 && Enumerable.Range(k, list.Count - k).SelectMany(j => list[j].DescendantNodesAndSelf()).OfType<IdentifierNameSyntax>()
                .Any(n => M.GetSymbolInfo(n).Symbol is ISymbol rs && declared.Contains(rs))) continue;
            found.Add((start, k, label));
        }
        // 範圍交錯（含巢狀）的都不做
        return found.Where(a => !found.Any(b => b != a && a.start <= b.end && b.start <= a.end)).ToList();
    }

    void Body(StatementSyntax st, StringBuilder sb, int ind)
    {
        if (st is BlockSyntax b) Stmts(b.Statements, sb, ind);
        else Stmt(st, sb, ind);
    }

    void StmtInner(StatementSyntax st, StringBuilder sb, int ind)
    {
        var I = Ind(ind);
        switch (st)
        {
            case BlockSyntax b:
                sb.AppendLine($"{I}{{");
                Stmts(b.Statements, sb, ind + 1);
                sb.AppendLine($"{I}}}");
                return;
            // 工具包模式：ref 區域變數指到陣列／List 的元素：陣列與索引各存一次（C# 也只求值一次），之後讀寫這個變數都是那一格
            case LocalDeclarationStatementSyntax rld when Core && rld.Declaration.Type is RefTypeSyntax
                && rld.Declaration.Variables.All(v => v.Initializer?.Value is RefExpressionSyntax { Expression: ElementAccessExpressionSyntax rea }
                    && rea.ArgumentList.Arguments.Count == 1 && IsCollection(M.GetTypeInfo(rea.Expression).Type)):
                foreach (var v in rld.Declaration.Variables)
                {
                    var rea = (ElementAccessExpressionSyntax)((RefExpressionSyntax)v.Initializer.Value).Expression;
                    var ra = $"__ra{++tmp}";
                    var ri = $"__ri{tmp}";
                    sb.AppendLine($"{I}const {ra}: any = {E(rea.Expression)}, {ri}: any = {E(rea.ArgumentList.Arguments[0].Expression)};");
                    refLocals[M.GetDeclaredSymbol(v)] = $"{ra}[{ri}]";
                }
                return;
            // 工具包模式：ref 區域變數指到區域變數／參數的欄位（MT2 的 RewardData：ref Action cb = ref grantParams.interactionCompleteCallback;
            // GrantParams 是結構參數，方法裡是自己的複本）：之後讀寫這個變數都換成那個欄位。產生出來要是單純的 a.b 才走這條（能當指定的左邊）
            case LocalDeclarationStatementSyntax rfd when Core && rfd.Declaration.Type is RefTypeSyntax
                && rfd.Declaration.Variables.All(v => v.Initializer?.Value is RefExpressionSyntax { Expression: MemberAccessExpressionSyntax rma }
                    && M.GetSymbolInfo(rma).Symbol is IFieldSymbol { IsStatic: false }
                    && rma.Expression is IdentifierNameSyntax rid && M.GetSymbolInfo(rid).Symbol is ILocalSymbol or IParameterSymbol { RefKind: RefKind.None }
                    && Regex.IsMatch(E(rma), @"^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)+$")):
                foreach (var v in rfd.Declaration.Variables)
                    refLocals[M.GetDeclaredSymbol(v)] = E(((RefExpressionSyntax)v.Initializer.Value).Expression);
                return;
            case LocalDeclarationStatementSyntax ld:
                foreach (var v in ld.Declaration.Variables)
                {
                    var vt = (M.GetDeclaredSymbol(v) as ILocalSymbol)?.Type;
                    if (v.Initializer == null) sb.AppendLine($"{I}let {Id(v.Identifier.Text)}: any;");
                    // 工具包模式：初始式用到自己（反編譯的 float num = !TryGetHandWidth(…, out num) ? … : Mathf.Min(num, …)，MT2 的 HandUI）：
                    // 先宣告再指定。JS 的 let 在自己的初始式裡被 out 的回呼寫入會丟 TDZ（Cannot access 'num' before initialization）
                    else if (Core && M.GetDeclaredSymbol(v) is ILocalSymbol self && v.Initializer.Value.DescendantNodesAndSelf().OfType<IdentifierNameSyntax>()
                        .Any(x => SymbolEqualityComparer.Default.Equals(M.GetSymbolInfo(x).Symbol, self)))
                    {
                        sb.AppendLine($"{I}let {Id(v.Identifier.Text)}: any;");
                        sb.AppendLine($"{I}{Id(v.Identifier.Text)} = {CopyIfStruct(v.Initializer.Value, vt)};");
                    }
                    else sb.AppendLine($"{I}let {Id(v.Identifier.Text)}: any = {CopyIfStruct(v.Initializer.Value, vt)};");
                }
                return;
            case ExpressionStatementSyntax es:
                if (es.Expression is AssignmentExpressionSyntax da && da.Left is IdentifierNameSyntax dn && dn.Identifier.Text == "_" && da.Right is LiteralExpressionSyntax)
                {
                    sb.AppendLine($"{I}// {Snip(es)}（反編譯的空敘述）");
                    return;
                }
                // 工具包模式：struct 裡的 this = default：每個實體欄位（含自動屬性）回到型別的預設值
                if (Core && T.IsValueType && es.Expression is AssignmentExpressionSyntax { Left: ThisExpressionSyntax } tda
                    && (tda.Right is DefaultExpressionSyntax || tda.Right.IsKind(SyntaxKind.DefaultLiteralExpression)))
                {
                    sb.AppendLine($"{I}// {Snip(es)}");
                    foreach (var (df, _) in fields.Where(kv => !kv.Key.IsStatic && kv.Value.kind is FieldKind.Ai or FieldKind.EdAi).OrderBy(kv => kv.Key.Name, StringComparer.Ordinal))
                        sb.AppendLine($"{I}c.ai.{df.Name} = {DefaultOf(df.Type)};");
                    foreach (var dp in T.GetMembers().OfType<IPropertySymbol>().Where(p => !p.IsStatic && AutoProp(p)).OrderBy(p => p.Name, StringComparer.Ordinal))
                        sb.AppendLine($"{I}c.ai.{dp.Name} = {DefaultOf(dp.Type)};");
                    return;
                }
                // 解構宣告 var (a, b) = tuple：產生的 tuple 是 { 名字: 值 } 物件，照 tuple 型別的元素名字逐一取出
                if (es.Expression is AssignmentExpressionSyntax dca && dca.Left is DeclarationExpressionSyntax dde && dde.Designation is ParenthesizedVariableDesignationSyntax pvd
                    && M.GetTypeInfo(dca.Right).Type is INamedTypeSymbol { IsTupleType: true } dtt)
                {
                    var tv = $"__t{++tmp}";
                    sb.AppendLine($"{I}const {tv}: any = {E(dca.Right)};");
                    for (int i = 0; i < pvd.Variables.Count; i++)
                    {
                        if (pvd.Variables[i] is SingleVariableDesignationSyntax dsv)
                            sb.AppendLine($"{I}let {Id(dsv.Identifier.Text)}: any = {TupleItem(tv, dtt, i)};");
                    }
                    return;
                }
                // 物件字面值開頭的敘述（被丟掉的 tuple）：JS 會當成區塊，包括號
                var est = E(es.Expression);
                sb.AppendLine($"{I}{(est.StartsWith("{") ? $"({est})" : est)};");
                return;
            case IfStatementSyntax ifs:
                sb.AppendLine($"{I}if ({E(ifs.Condition)}) {{");
                Body(ifs.Statement, sb, ind + 1);
                var el = ifs.Else;
                while (el != null)
                {
                    if (el.Statement is IfStatementSyntax eif)
                    {
                        sb.AppendLine($"{I}}} else if ({E(eif.Condition)}) {{");
                        Body(eif.Statement, sb, ind + 1);
                        el = eif.Else;
                    }
                    else
                    {
                        sb.AppendLine($"{I}}} else {{");
                        Body(el.Statement, sb, ind + 1);
                        el = null;
                    }
                }
                sb.AppendLine($"{I}}}");
                return;
            case SwitchStatementSyntax sw:
                if (Core && Ui && SwitchGotoMachine(sw, sb, ind)) return;
                sb.AppendLine($"{I}switch ({E(sw.Expression)}) {{");
                foreach (var sec in sw.Sections)
                {
                    SwitchLabels(sec, sb, I);
                    sb.AppendLine($"{I}  {{");
                    Stmts(sec.Statements, sb, ind + 2);
                    sb.AppendLine($"{I}  }}");
                }
                sb.AppendLine($"{I}}}");
                return;
            case ForStatementSyntax fs:
            {
                var init = fs.Declaration != null
                    ? "let " + string.Join(", ", fs.Declaration.Variables.Select(v => $"{Id(v.Identifier.Text)}: any" + (v.Initializer != null ? $" = {E(v.Initializer.Value)}" : "")))
                    : string.Join(", ", fs.Initializers.Select(E));
                var lgf = LoopGuardOpen(fs, sb, I);
                sb.AppendLine($"{I}for ({init}; {(fs.Condition != null ? E(fs.Condition) : "")}; {string.Join(", ", fs.Incrementors.Select(E))}) {{");
                if (lgf != null) sb.AppendLine(lgf);
                Body(fs.Statement, sb, ind + 1);
                sb.AppendLine($"{I}}}");
                return;
            }
            case ForEachStatementSyntax fe:
            {
                var ct = M.GetTypeInfo(fe.Expression).Type;
                var coll = E(fe.Expression);
                // 工具包模式：實作 IEnumerable 的產生類別（Malee 的 ReorderableArray<T>）：執行期的實體本身可以 for…of（core 的 listFacade／enumerableFacade）
                if (GenEnumerable(ct)) { }
                else if (ct != null && !IsCollection(ct) && ct.SpecialType != SpecialType.System_String)
                {
                    // 非 List／陣列（Dictionary、自訂 IEnumerable）：交給相容層轉成陣列
                    coll = Rt($"{TK(ct)}_toArray", new[] { coll }, fe.Expression);
                }
                var lge = LoopGuardOpen(fe, sb, I);
                sb.AppendLine($"{I}for (const {Id(fe.Identifier.Text)} of {coll}) {{");
                if (lge != null) sb.AppendLine(lge);
                Body(fe.Statement, sb, ind + 1);
                sb.AppendLine($"{I}}}");
                return;
            }
            // 工具包模式：foreach (var (a, b) in tuples)：每個元素（產生的 tuple 是 { 名字: 值 } 物件）照 tuple 型別的元素名字取出，同解構宣告
            case ForEachVariableStatementSyntax fv when Core && fv.Variable is DeclarationExpressionSyntax { Designation: ParenthesizedVariableDesignationSyntax fpv }
                && M.GetForEachStatementInfo(fv).ElementType is INamedTypeSymbol { IsTupleType: true } ftt
                && fpv.Variables.All(x => x is SingleVariableDesignationSyntax or DiscardDesignationSyntax):
            {
                var fct = M.GetTypeInfo(fv.Expression).Type;
                var fcoll = E(fv.Expression);
                if (GenEnumerable(fct)) { }
                else if (fct != null && !IsCollection(fct) && fct.SpecialType != SpecialType.System_String)
                    fcoll = Rt($"{TK(fct)}_toArray", new[] { fcoll }, fv.Expression);
                var ftv = $"__t{++tmp}";
                var lgv = LoopGuardOpen(fv, sb, I);
                sb.AppendLine($"{I}for (const {ftv} of {fcoll}) {{");
                if (lgv != null) sb.AppendLine(lgv);
                for (int i = 0; i < fpv.Variables.Count; i++)
                    if (fpv.Variables[i] is SingleVariableDesignationSyntax fsv)
                        sb.AppendLine($"{Ind(ind + 1)}let {Id(fsv.Identifier.Text)}: any = {TupleItem(ftv, ftt, i)};");
                Body(fv.Statement, sb, ind + 1);
                sb.AppendLine($"{I}}}");
                return;
            }
            case WhileStatementSyntax ws:
            {
                var lgw = LoopGuardOpen(ws, sb, I);
                sb.AppendLine($"{I}while ({E(ws.Condition)}) {{");
                if (lgw != null) sb.AppendLine(lgw);
                Body(ws.Statement, sb, ind + 1);
                sb.AppendLine($"{I}}}");
                return;
            }
            case DoStatementSyntax ds:
            {
                var lgd = LoopGuardOpen(ds, sb, I);
                sb.AppendLine($"{I}do {{");
                if (lgd != null) sb.AppendLine(lgd);
                Body(ds.Statement, sb, ind + 1);
                sb.AppendLine($"{I}}} while ({E(ds.Condition)});");
                return;
            }
            case ReturnStatementSyntax rs:
                sb.AppendLine(rs.Expression != null ? $"{I}return {E(rs.Expression)};" : $"{I}return;");
                return;
            case BreakStatementSyntax:
                sb.AppendLine($"{I}break;");
                return;
            case ContinueStatementSyntax:
                sb.AppendLine($"{I}continue;");
                return;
            // 工具包模式：throw; 丟回 catch 接到的那個；throw 運算式照值丟（new XException(…) 是 R.csException，帶型別鏈與訊息）
            case ThrowStatementSyntax th when Core:
                if (th.Expression == null)
                    sb.AppendLine($"{I}throw {(catchVars.Count > 0 ? catchVars.Peek() : "new Error(" + Js("C# throw：" + Loc(th)) + ")")};");
                else
                    sb.AppendLine($"{I}throw {E(th.Expression)};");
                return;
            case ThrowStatementSyntax th:
                if (th.Expression is ObjectCreationExpressionSyntax oc)
                    sb.AppendLine($"{I}throw new Error({Js("C# " + oc.Type + "：" + Loc(th))});");
                else
                    sb.AppendLine($"{I}throw new Error({Js("C# throw：" + Loc(th))});");
                return;
            case EmptyStatementSyntax:
                return;
            case GotoStatementSyntax gs when gs.IsKind(SyntaxKind.GotoStatement) && gs.Expression is IdentifierNameSyntax gl && gotoJumps.TryGetValue(gl.Identifier.Text, out var jump):
                sb.AppendLine($"{I}{jump}");
                return;
            // 工具包模式：一段 case 的最後一句 goto case X／goto default，X 正好是下一段：JS 的 switch 不寫 break 就往下一段跑
            case GotoStatementSyntax gc when Core && gc.Parent is SwitchSectionSyntax gsec && gsec.Statements.Last() == gc && gsec.Parent is SwitchStatementSyntax gsw
                && gsw.Sections.IndexOf(gsec) + 1 < gsw.Sections.Count && GotoCaseHits(gc, gsw.Sections[gsw.Sections.IndexOf(gsec) + 1]):
                sb.AppendLine($"{I}// {Snip(gc)}（下一段，往下跑）");
                return;
            case UsingStatementSyntax us when Ui:
            {
                // using (宣告／運算式) { … } → 區塊裡 try／finally，finally 呼叫 Dispose（DisposeCall）。資源有多個時照順序巢狀，反過來釋放。
                // 資源的 out 變數（GenericPools.GetList(out list)）只在這個 using 裡有效，宣告在區塊裡（同一層的 using 常常重複用 list）
                var saved = hoist;
                hoist = new();
                var res = new List<(string decl, string v, ITypeSymbol t, SyntaxNode at)>();
                if (us.Declaration != null)
                    foreach (var v in us.Declaration.Variables)
                    {
                        var vt = (M.GetDeclaredSymbol(v) as ILocalSymbol)?.Type;
                        res.Add(($"let {Id(v.Identifier.Text)}: any = {CopyIfStruct(v.Initializer.Value, vt)};", Id(v.Identifier.Text), vt, v));
                    }
                else
                {
                    var uv = $"__u{++tmp}";
                    res.Add(($"const {uv}: any = {E(us.Expression)};", uv, M.GetTypeInfo(us.Expression).Type, us.Expression));
                }
                var uh = hoist;
                hoist = saved;
                sb.AppendLine($"{I}{{");
                foreach (var h in uh) sb.AppendLine($"{I}  let {h}: any;");
                var d = ind + 1;
                foreach (var r in res)
                {
                    sb.AppendLine($"{Ind(d)}{r.decl}");
                    sb.AppendLine($"{Ind(d)}try {{");
                    d++;
                }
                Body(us.Statement, sb, d);
                for (int ri = res.Count - 1; ri >= 0; ri--)
                {
                    d--;
                    sb.AppendLine($"{Ind(d)}}} finally {{");
                    sb.AppendLine($"{Ind(d + 1)}{DisposeCall(res[ri].t, res[ri].v, res[ri].at)};");
                    sb.AppendLine($"{Ind(d)}}}");
                }
                sb.AppendLine($"{I}}}");
                return;
            }
            // lock (x) { … }：瀏覽器是單一執行緒，照本體跑
            case LockStatementSyntax lk when Core:
                sb.AppendLine($"{I}{{ // lock ({Snip(lk.Expression)})");
                Body(lk.Statement, sb, ind + 1);
                sb.AppendLine($"{I}}}");
                return;
            case TryStatementSyntax ts when Ui:
            {
                // try／catch／finally：一個 catch 時例外的變數名照原本的；多個 catch 合成一個 JS catch，
                // 照順序用 R.exceptionIs 比型別（相容層丟的 C# 例外訊息開頭是「C# 型別：」），catch (Exception) 接剩下的，都不中就往外丟
                sb.AppendLine($"{I}try {{");
                Stmts(ts.Block.Statements, sb, ind + 1);
                if (ts.Catches.Count > 1 && ts.Catches.Any(cc0 => cc0.Filter != null))
                {
                    // catch (X) when (…)：還沒遇過，整段記 notPorted（會丟錯，不會默默吞掉）
                    sb.AppendLine($"{I}}} catch ({$"__e{++tmp}"}: any) {{");
                    sb.AppendLine($"{I}  {NotPorted(ts.Catches.First(cc0 => cc0.Filter != null).Filter!, null)};");
                }
                else if (ts.Catches.Count > 1)
                {
                    var ev = $"__e{++tmp}";
                    sb.AppendLine($"{I}}} catch ({ev}: any) {{");
                    var catchAll = false;
                    for (int ci = 0; ci < ts.Catches.Count && !catchAll; ci++)
                    {
                        var cc = ts.Catches[ci];
                        var ct = cc.Declaration != null ? M.GetTypeInfo(cc.Declaration.Type).Type : null;
                        catchAll = ct == null || ct.ToDisplayString() == "System.Exception";
                        var head = catchAll ? (ci == 0 ? "{" : "} else {") : $"{(ci == 0 ? "" : "} else ")}if (R.exceptionIs({ev}, {Js(ct!.Name)})) {{";
                        sb.AppendLine($"{I}  {head}");
                        if (cc.Declaration != null && !cc.Declaration.Identifier.IsKind(SyntaxKind.None))
                            sb.AppendLine($"{I}    let {Id(cc.Declaration.Identifier.Text)}: any = {ev};");
                        catchVars.Push(ev);
                        Stmts(cc.Block.Statements, sb, ind + 2);
                        catchVars.Pop();
                    }
                    if (!catchAll) sb.AppendLine($"{I}  }} else {{\n{I}    throw {ev};");
                    sb.AppendLine($"{I}  }}");
                }
                else if (ts.Catches.Count > 0)
                {
                    var cc = ts.Catches[0];
                    var ev = cc.Declaration != null && !cc.Declaration.Identifier.IsKind(SyntaxKind.None) ? Id(cc.Declaration.Identifier.Text) : $"__e{++tmp}";
                    sb.AppendLine($"{I}}} catch ({ev}: any) {{");
                    // 工具包模式：catch (特定型別) 只接那個型別（含子類別），其他照樣往外丟；catch (Exception) 接全部
                    var ct1 = cc.Declaration != null ? M.GetTypeInfo(cc.Declaration.Type).Type : null;
                    if (Core && ct1 != null && ct1.ToDisplayString() != "System.Exception")
                        sb.AppendLine($"{I}  if (!R.exceptionIs({ev}, {Js(ct1.Name)})) throw {ev};");
                    if (cc.Filter != null) sb.AppendLine($"{I}  if (!({E(cc.Filter.FilterExpression)})) throw {ev};");
                    catchVars.Push(ev);
                    Stmts(cc.Block.Statements, sb, ind + 1);
                    catchVars.Pop();
                }
                if (ts.Finally != null)
                {
                    sb.AppendLine($"{I}}} finally {{");
                    Stmts(ts.Finally.Block.Statements, sb, ind + 1);
                }
                sb.AppendLine($"{I}}}");
                return;
            }
            case YieldStatementSyntax ys when Ui:
                // 協程：yield return X → yield X（null 等下一格、WaitForSeconds、巢狀 IEnumerator 由相容層的協程推進解讀）；yield break → return
                sb.AppendLine(ys.IsKind(SyntaxKind.YieldBreakStatement) ? $"{I}return;" : $"{I}yield {E(ys.Expression)};");
                return;
            case LocalFunctionStatementSyntax lf when Core:
            {
                // 工具包模式：function 宣告。JS 會把它提升到所在區塊開頭，跟 C# 一樣宣告前面也叫得到、當委派用
                //（GameStateManager.ContinueExistingRun 的 callback2 = ViewChallengesCallback 寫在區域函式前面）
                var ps = LambdaParams(lf.ParameterList.Parameters);
                var kw = IsIterator(lf.Body) ? "function*" : lf.Modifiers.Any(SyntaxKind.AsyncKeyword) ? "async function" : "function";
                sb.AppendLine($"{I}{kw} {Id(lf.Identifier.Text)}({ps}): any {{");
                if (lf.Body != null) Stmts(lf.Body.Statements, sb, ind + 1);
                else sb.AppendLine($"{I}  return {E(lf.ExpressionBody.Expression)};");
                sb.AppendLine($"{I}}}");
                return;
            }
            case LocalFunctionStatementSyntax lf:
            {
                var ps = LambdaParams(lf.ParameterList.Parameters);
                // ui：區域函式是迭代器（MT2 RelicManager 的 IEnumerator TestAndMaybeApplyEffect）→ function*，箭頭函式不能 yield
                if (Ui && IsIterator(lf.Body)) sb.AppendLine($"{I}const {Id(lf.Identifier.Text)} = function* ({ps}): any {{");
                else sb.AppendLine($"{I}const {Id(lf.Identifier.Text)} = {(Ui && lf.Modifiers.Any(SyntaxKind.AsyncKeyword) ? "async " : "")}({ps}): any => {{");
                if (lf.Body != null) Stmts(lf.Body.Statements, sb, ind + 1);
                else sb.AppendLine($"{I}  return {E(lf.ExpressionBody.Expression)};");
                sb.AppendLine($"{I}}};");
                return;
            }
            default:
                sb.AppendLine($"{I}{NotPorted(st, null)};");
                return;
        }
    }

    /// using 結束時的 Dispose：同一次轉的類別而且 Dispose 有轉出來 → R.callGen；否則相容層 <實作 Dispose 的型別>_Dispose
    ///（型別本身是介面、型別參數時是 IDisposable_Dispose）。參照型別是 null 時照 C# 不呼叫
    string DisposeCall(ITypeSymbol t, string v, SyntaxNode at)
    {
        var im = M.Compilation.GetSpecialType(SpecialType.System_IDisposable).GetMembers("Dispose").OfType<IMethodSymbol>().First();
        var dm = t != null && t.TypeKind is TypeKind.Class or TypeKind.Struct ? t.FindImplementationForInterfaceMember(im) as IMethodSymbol ?? im : im;
        string call;
        if (GenMethods.TryGetValue(GN(dm.ContainingType), out var gm) && gm.Contains(dm.Name))
            call = $"R.callGen(c, {Js(GN(dm.ContainingType))}, {Js(GenName(dm))}, {v})";
        else
            call = Rt($"{TK(dm.ContainingType)}_Dispose{(dm.Name == "Dispose" ? Ovl(dm) : "")}", new[] { v }, at);
        return t != null && t.IsValueType ? call : $"if ({v} != null) {call}";
    }

    /// 結構（C# struct）從欄位／屬性拿出來是複製：TS 這邊要 clone，免得改到共用資料
    string CopyIfStruct(ExpressionSyntax e, ITypeSymbol t)
    {
        var s = E(e);
        if (t != null && t.IsValueType && t.TypeKind == TypeKind.Struct && t.SpecialType == SpecialType.None && !t.Name.StartsWith("ValueTuple")
            && e is not ObjectCreationExpressionSyntax && e is not ImplicitObjectCreationExpressionSyntax && e is not InvocationExpressionSyntax)
            return $"R.cloneData({s})";
        return s;
    }

    // ───────── 運算式 ─────────
    string E(ExpressionSyntax e)
    {
        if (boundRecv.TryGetValue(e, out var br)) return br;
        var s = E0(e);
        if (!Ui) return s;
        // 括號：Roslyn 給括號和裡面那個運算式同一個轉換，裡面那層已經套過，這裡不再套。
        // 以前套兩次：UILineRenderer 的 simpleVert.color = ((i == 0 || i == 1) ? c1 : c2) 變成 Color32(Color32(…))，第二次把 0–255 當 0–1 夾住
        if (e is ParenthesizedExpressionSyntax) return s;
        // 使用者定義的隱含轉型（Vector3 → Vector2 丟掉 z、Vector2 → Vector3 補 0）：UnityEngine.Object → bool 是「沒被銷毀」
        var conv = M.GetConversion(e);
        // 工具包模式：列舉值裝箱成 System.Enum／object（CoreSymbolName.Set(Enum)）：型別跟著值走，Enum.ToString() 才拿得到成員名
        if (Core && conv.IsBoxing && M.GetTypeInfo(e).Type is INamedTypeSymbol { TypeKind: TypeKind.Enum } bet) return BoxEnum(bet, s);
        // 工具包模式：char 隱含轉成數字（strData[i] ^ crc）：C# 的 char 是 UTF-16 碼位，TS 這邊是一個字的字串
        if (Core && conv.IsImplicit && conv.IsNumeric && M.GetTypeInfo(e).Type?.SpecialType == SpecialType.System_Char && M.GetTypeInfo(e).ConvertedType?.SpecialType != SpecialType.System_Char)
            return $"({s}).charCodeAt(0)";
        if (conv.IsUserDefined && conv.MethodSymbol is IMethodSymbol cm)
        {
            // 工具包模式：已銷毀的物件也是 false（Unity 的假 null）
            if (cm.ContainingType.ToDisplayString() == "UnityEngine.Object") return Core ? $"R.objAlive({s})" : $"({s} != null)";
            // 參數是 System.Enum／object、值是列舉（MappingID 的 implicit operator MappingID(Enum)）：裝箱這一步 Roslyn 不另外報，這裡補
            var arg = s;
            if (Core && M.GetTypeInfo(e).Type is INamedTypeSymbol { TypeKind: TypeKind.Enum } uet && cm.Parameters.Length == 1
                && cm.Parameters[0].Type.SpecialType is SpecialType.System_Enum or SpecialType.System_Object)
                arg = BoxEnum(uet, s);
            return GenOperatorCall(cm, new[] { arg }) ?? Rt($"{TK(cm.ContainingType)}_{cm.Name}{Ovl(cm)}", new[] { arg }, e);
        }
        return s;
    }

    string E0(ExpressionSyntax e)
    {
        switch (e)
        {
            case LiteralExpressionSyntax lit:
                return Literal(lit);
            case ParenthesizedExpressionSyntax p:
                return $"({E(p.Expression)})";
            case IdentifierNameSyntax id:
                return Identifier(id);
            case GenericNameSyntax gn:
                return Identifier(gn);
            case ThisExpressionSyntax:
                return "c.self";
            // ui：base 單獨當對象（base.enabled = false）：同一個實體；呼叫 base.X() 在 Invocation 另外處理
            case BaseExpressionSyntax when Ui:
                return "c.self";
            case MemberAccessExpressionSyntax ma:
                return MemberAccess(ma);
            case MemberBindingExpressionSyntax mbx when Ui && BindingReceiver(mbx) is ExpressionSyntax brx:
                return MemberAccess(mbx, brx, mbx.Name);
            case InvocationExpressionSyntax inv:
                return Invocation(inv);
            case ObjectCreationExpressionSyntax oc:
                return Creation(oc, oc.ArgumentList, oc.Initializer);
            case ImplicitObjectCreationExpressionSyntax ioc:
                return Creation(ioc, ioc.ArgumentList, ioc.Initializer);
            case ArrayCreationExpressionSyntax ac:
                if (ac.Initializer != null) return "[" + string.Join(", ", ac.Initializer.Expressions.Select(E)) + "]";
                if (ac.Type.RankSpecifiers.Count == 1 && ac.Type.RankSpecifiers[0].Sizes.Count == 1)
                    return !RT.Contains("newArray") ? NotPorted(e, "newArray")
                        : $"R.newArray({E(ac.Type.RankSpecifiers[0].Sizes[0])}, {CsDefault(M.GetTypeInfo(ac).Type is IArrayTypeSymbol at ? at.ElementType : null)})";
                // 工具包模式：鋸齒陣列 new float[n][]：外層 n 格，每格是還沒建的陣列（null）
                if (Core && ac.Type.RankSpecifiers.Count > 1 && ac.Type.RankSpecifiers[0].Sizes.Count == 1
                    && ac.Type.RankSpecifiers.Skip(1).All(r => r.Sizes.All(s => s is OmittedArraySizeExpressionSyntax)) && RT.Contains("newArray"))
                    return $"R.newArray({E(ac.Type.RankSpecifiers[0].Sizes[0])}, null)";
                return NotPorted(e, null);
            case ImplicitArrayCreationExpressionSyntax iac:
                return "[" + string.Join(", ", iac.Initializer.Expressions.Select(E)) + "]";
            case CollectionExpressionSyntax ce:
                return "[" + string.Join(", ", ce.Elements.OfType<ExpressionElementSyntax>().Select(x => E(x.Expression))) + "]";
            case InitializerExpressionSyntax ie when ie.IsKind(SyntaxKind.ArrayInitializerExpression):
                return "[" + string.Join(", ", ie.Expressions.Select(E)) + "]";
            case TupleExpressionSyntax tu:
                return Tuple(tu);
            case BinaryExpressionSyntax be:
                return Binary(be);
            case PrefixUnaryExpressionSyntax pu:
                return Prefix(pu);
            case PostfixUnaryExpressionSyntax po:
                return Postfix(po);
            case AssignmentExpressionSyntax asg:
                return Assign(asg);
            case ConditionalExpressionSyntax ce2:
                return $"({E(ce2.Condition)} ? {E(ce2.WhenTrue)} : {E(ce2.WhenFalse)})";
            case CastExpressionSyntax cast:
            {
                var to = M.GetTypeInfo(cast).Type;
                var from = M.GetTypeInfo(cast.Expression).Type;
                var inner = E(cast.Expression);
                if (IsIntegral(to) && to.TypeKind != TypeKind.Enum && IsFloat(from)) return $"Math.trunc({inner})";
                // 工具包模式：(int)ch → 碼位；(char)n → 那個碼位的字
                if (Core && from?.SpecialType == SpecialType.System_Char && to.SpecialType != SpecialType.System_Char && (IsIntegral(to) || IsFloat(to))) return $"({inner}).charCodeAt(0)";
                if (Core && to.SpecialType == SpecialType.System_Char && from?.SpecialType != SpecialType.System_Char && IsIntegral(from)) return $"String.fromCharCode({inner})";
                // 工具包模式：列舉轉整數照底層型別算（(uint)(controls - 34) <= 1u 這類範圍判斷：列舉減整數還是列舉，轉 uint 要繞回大數）
                if (Core && from is INamedTypeSymbol { TypeKind: TypeKind.Enum, EnumUnderlyingType: { } fu } && to.TypeKind != TypeKind.Enum && IsIntegral(to)) from = fu;
                // ui：整數之間縮窄或改成無號（MT2 MurmurHash2 的 (uint)、(ushort)）：照 C# unchecked 截斷
                if (Ui && IsIntegral(from) && from.TypeKind != TypeKind.Enum && to.TypeKind != TypeKind.Enum && !Same(from, to))
                    switch (to.SpecialType)
                    {
                        case SpecialType.System_UInt32: return $"(({inner}) >>> 0)";
                        case SpecialType.System_UInt16: return $"(({inner}) & 0xFFFF)";
                        case SpecialType.System_Byte: return $"(({inner}) & 0xFF)";
                        case SpecialType.System_Int16: return $"((({inner}) << 16) >> 16)";
                        case SpecialType.System_SByte: return $"((({inner}) << 24) >> 24)";
                        case SpecialType.System_Int32 when from.SpecialType is SpecialType.System_UInt32 or SpecialType.System_Int64 or SpecialType.System_UInt64: return $"(({inner}) | 0)";
                    }
                // 使用者定義的轉型（(int)layerMask 的 LayerMask.op_Implicit）：轉型運算式本身的轉換看 IOperation（GetConversion 給的是外層的）
                var xop = M.GetConversion(cast) is { IsUserDefined: true, MethodSymbol: IMethodSymbol xm0 } ? xm0
                    : Core && M.GetOperation(cast) is Microsoft.CodeAnalysis.Operations.IConversionOperation { OperatorMethod: IMethodSymbol xm1 } ? xm1 : null;
                if (Ui && xop is IMethodSymbol xm && xm.ContainingType.ToDisplayString() != "UnityEngine.Object")
                    return GenOperatorCall(xm, new[] { inner }) ?? Rt($"{TK(xm.ContainingType)}_{xm.Name}{Ovl(xm)}", new[] { inner }, cast);
                return inner;
            }
            case SimpleLambdaExpressionSyntax sl:
                return $"({(Ui && sl.AsyncKeyword.IsKind(SyntaxKind.AsyncKeyword) ? "async " : "")}({Id(sl.Parameter.Identifier.Text)}: any) => {LambdaBody(sl.Body)})";
            case ParenthesizedLambdaExpressionSyntax pl:
                return $"({(Ui && pl.AsyncKeyword.IsKind(SyntaxKind.AsyncKeyword) ? "async " : "")}({LambdaParams(pl.ParameterList.Parameters)}) => {LambdaBody(pl.Body)})";
            case AnonymousMethodExpressionSyntax am:
                return $"(({LambdaParams(am.ParameterList?.Parameters ?? default)}) => {LambdaBody(am.Body)})";
            case ElementAccessExpressionSyntax ea:
            {
                var rt0 = M.GetTypeInfo(ea.Expression).Type;
                if (IsCollection(rt0) || rt0?.OriginalDefinition.ToDisplayString().StartsWith("System.Collections.Generic.List<") == true)
                    return CollectionIndex(ea);
                if (GenIndexer(ea, null) is string gix) return gix;
                // ui：其他型別的索引子（Dictionary[key]）→ 相容層 <型別>_get_Item
                if (Ui) return Rt($"{TK(rt0)}_get_Item", new[] { E(ea.Expression) }.Concat(ea.ArgumentList.Arguments.Select(x => E(x.Expression))), e);
                return NotPorted(e, $"{TK(rt0)}_index");
            }
            case InterpolatedStringExpressionSyntax isx:
            {
                var sb = new StringBuilder("`");
                foreach (var part in isx.Contents)
                {
                    if (part is InterpolatedStringTextSyntax tx) sb.Append(tx.TextToken.ValueText.Replace("\\", "\\\\").Replace("`", "\\`").Replace("${", "\\${"));
                    else if (part is InterpolationSyntax ip)
                    {
                        var v = InString(ip.Expression, E(ip.Expression), ip.FormatClause != null || ip.AlignmentClause != null);
                        // {x:D2}、{x,5}：格式與對齊交給相容層的 csFormat（String.Format 的同一套規則）
                        if (ip.FormatClause != null || ip.AlignmentClause != null)
                        {
                            var fmt = ip.FormatClause?.FormatStringToken.ValueText ?? "";
                            var align = ip.AlignmentClause != null ? E(ip.AlignmentClause.Value) : "0";
                            v = Rt("csFormat", new[] { v, Js(fmt), align }, ip);
                        }
                        sb.Append("${").Append(v).Append('}');
                    }
                }
                return sb.Append('`').ToString();
            }
            case AwaitExpressionSyntax aw:
                // ui：畫面的等待是真的（動畫、延遲），保留 await；引擎模式同步執行
                return Ui ? $"(await {E(aw.Expression)})" : E(aw.Expression);
            case DefaultExpressionSyntax de:
                return CsDefault(M.GetTypeInfo(de).Type);
            // x ?? throw new …：運算式位置的 throw
            case ThrowExpressionSyntax te when Core:
                return $"R.throwIt({E(te.Expression)})";
            case TypeOfExpressionSyntax to2:
                // 工具包模式：型別名（巢狀用 外層_內層）；泛型類別的型別參數 → 實體帶的型別引數（R.typeArg）
                return Core && M.GetTypeInfo(to2.Type).Type is ITypeSymbol tot ? TypeRef(tot) : Js(to2.Type.ToString());
            case CheckedExpressionSyntax ck:
                return E(ck.Expression);
            case ConditionalAccessExpressionSyntax ca:
                return ConditionalAccess(ca);
            case IsPatternExpressionSyntax ip2:
                return IsPattern(ip2);
            case SwitchExpressionSyntax sx:
            {
                var v = E(sx.GoverningExpression);
                var t = $"__sw{++tmp}";
                hoist.Add(t);
                var sb = new StringBuilder($"({t} = {v}, ");
                foreach (var arm in sx.Arms)
                {
                    if (arm.Pattern is DiscardPatternSyntax) { sb.Append(E(arm.Expression)); sb.Append(new string(')', 1)); return sb.ToString(); }
                    if (arm.Pattern is ConstantPatternSyntax cp && arm.WhenClause == null) sb.Append($"{t} === {E(cp.Expression)} ? {E(arm.Expression)} : ");
                    else return NotPorted(e, null);
                }
                sb.Append($"R.switchFail(c, {Js(Loc(e))}))");
                return sb.ToString();
            }
            case QueryExpressionSyntax qx when Core:
                return QueryCore(qx);
            case QueryExpressionSyntax q:
            {
                // LINQ 查詢語法：只支援 from x in 來源 (where 條件)* select 運算式
                if (q.Body.Continuation != null || q.Body.Clauses.Any(cl => cl is not WhereClauseSyntax) || q.Body.SelectOrGroup is not SelectClauseSyntax sel) return NotPorted(e, null);
                var v = Id(q.FromClause.Identifier.Text);
                var src = E(q.FromClause.Expression);
                var srcType = M.GetTypeInfo(q.FromClause.Expression).Type;
                if (srcType != null && !IsCollection(srcType)) src = Rt($"{TK(srcType)}_toArray", new[] { src }, q.FromClause.Expression);
                var sb = new StringBuilder($"[...{src}]");
                foreach (WhereClauseSyntax w in q.Body.Clauses) sb.Append($".filter(({v}: any) => {E(w.Condition)})");
                var selText = E(sel.Expression);
                if (selText != v) sb.Append($".map(({v}: any) => {selText})");
                return sb.ToString();
            }
            case PredefinedTypeSyntax:
            case QualifiedNameSyntax:
                return Js(e.ToString());
            default:
                return NotPorted(e, null);
        }
    }

    string LambdaBody(CSharpSyntaxNode body)
    {
        // 運算式本體是物件字面值（回傳 tuple）：JS 會當成函式本體，包括號
        if (body is ExpressionSyntax ex) return E(ex) is var le && le.StartsWith("{") ? $"({le})" : le;
        var sb = new StringBuilder("{\n");
        Stmts(((BlockSyntax)body).Statements, sb, 2);
        return sb.Append("}").ToString();
    }

    string Literal(LiteralExpressionSyntax lit)
    {
        switch (lit.Kind())
        {
            case SyntaxKind.NumericLiteralExpression:
            {
                var txt = lit.Token.Text;
                // 十六進位的 F、D 是數字，只能去掉 u／l 字尾（0xFFu、0xFFFFFFFFu）
                if (txt.StartsWith("0x") || txt.StartsWith("0X")) return Regex.Replace(txt, "[uUlL]+$", "");
                return Regex.Replace(txt, "[fFdDmMuUlL]+$", "");
            }
            case SyntaxKind.StringLiteralExpression: return Js(lit.Token.ValueText);
            case SyntaxKind.CharacterLiteralExpression: return Js(lit.Token.ValueText);
            case SyntaxKind.TrueLiteralExpression: return "true";
            case SyntaxKind.FalseLiteralExpression: return "false";
            case SyntaxKind.NullLiteralExpression: return "null";
            case SyntaxKind.DefaultLiteralExpression: return CsDefault(M.GetTypeInfo(lit).ConvertedType);
            default: return NotPorted(lit, null);
        }
    }

    // 識別字（沒有明寫 receiver）：區域變數、參數、自己的欄位、基底的欄位與屬性、方法群組
    string Identifier(SimpleNameSyntax id)
    {
        var sym = M.GetSymbolInfo(id).Symbol ?? M.GetSymbolInfo(id).CandidateSymbols.FirstOrDefault();
        switch (sym)
        {
            case ILocalSymbol rl when refLocals.TryGetValue(rl, out var rlv): return rlv;
            case ILocalSymbol l: return Id(l.Name);
            case IParameterSymbol p: return Ui && p.RefKind == RefKind.Ref || OutBoxed(p) ? $"{Id(p.Name)}.v" : Id(p.Name);
            case IRangeVariableSymbol rv: return Id(rv.Name);
            case IFieldSymbol f:
                if (f.HasConstantValue) return ConstLit(f.ConstantValue, f.Type, $"{f.ContainingType.Name}.{f.Name}");
                if (Same(f.ContainingType, T)) return OwnField(f, id);
                if (InheritedGenField(f)) return $"c.ai.{f.Name}";
                if (f.IsStatic && Ui && GenMethods.ContainsKey(GN(f.ContainingType))) return $"R.genStatic(c, {Js(GN(f.ContainingType))}, {Js(f.Name)})";
                if (f.IsStatic) return Rt($"{TK(f.ContainingType)}_get_{f.Name}", Array.Empty<string>(), id);
                if (UiComponentField(f) && !RT.Contains($"{TK(f.ContainingType)}_get_{f.Name}")) return $"R.mbGet(c, c.self, {Js(f.Name)})";
                return Rt($"{TK(f.ContainingType)}_get_{f.Name}", new[] { "c.self" }, id);
            case IPropertySymbol pr:
                if (GenProp(pr) && PropGet(pr, null) is string pg) return pg;
                if (Same(pr.ContainingType, T)) return NotPorted(id, null);
                if (pr.IsStatic) return Rt($"{TK(pr.ContainingType)}_get_{pr.Name}", Array.Empty<string>(), id);
                return Rt($"{TK(pr.ContainingType)}_get_{pr.Name}", new[] { "c.self" }, id);
            case IMethodSymbol m:
                return MethodGroup(m, null, id);
            case INamedTypeSymbol nt:
                return Js(nt.Name);
            case IEventSymbol ev when Ui:
                return Rt("eventGet", new[] { Js($"{TK(ev.ContainingType)}.{ev.Name}"), ev.IsStatic ? "null" : "c.self" }, id);
            default:
                return NotPorted(id, null);
        }
    }

    string OwnStaticProp(IPropertySymbol p)
    {
        staticProps.Add(p);
        return $"S_{p.Name}";
    }

    string OwnField(IFieldSymbol f, SyntaxNode at)
    {
        // 靜態欄位：模組層級的變數（S_名字，Emit 開頭宣告）
        if (f.IsStatic) { staticFields.Add(f); return $"S_{f.Name}"; }
        var (kind, bucket) = fields[f];
        return kind switch
        {
            FieldKind.Ai or FieldKind.EdAi => $"c.ai.{f.Name}",
            FieldKind.Ed => bucket == "" ? $"c.ed.{f.Name}" : $"c.ed.{bucket}.{f.Name}",
            _ => NotPorted(at, $"序列化欄位 {T.Name}.{f.Name}（匯入沒有分到桶）"),
        };
    }

    string MethodGroup(IMethodSymbol m, ExpressionSyntax receiver, SyntaxNode at)
    {
        // 工具包模式：區域函式當委派：就是那個函式
        if (Core && m.MethodKind == MethodKind.LocalFunction) return Id(m.Name);
        if (Same(m.ContainingType, T) && ownMethods.TryGetValue(m.OriginalDefinition, out var ts))
        {
            // 工具包模式：別的實體的方法、或會被覆寫的方法：照實際類別分派（R.boundGen）
            if (Core && !m.IsStatic && ((receiver != null && receiver is not ThisExpressionSyntax) || IsVirtualDispatch(m)))
                return $"R.boundGen(c, {Js(GN(T))}, {Js(ts)}, {(receiver == null || receiver is ThisExpressionSyntax ? "c.self" : E(receiver))})";
            // ui：畫面的委派不用序列化，直接綁在這個實體上（同一個實體同一個方法拿到同一個函式，-= 才拿得掉）
            if (Ui) return $"R.bound(c, {Js(ts)}, {ts})";
            delegateKeys.Add(ts);
            return Js($"{T.Name}.{ts}");
        }
        // ui：同一次轉的別的類別的靜態方法當委派（MMTween.TweenDelegateArray 的 MMTweenDefinitions.Linear_Tween）→ 叫 R.callStatic 的函式
        if (Ui && m.IsStatic && GenMethods.TryGetValue(GN(m.ContainingType), out var dgm) && dgm.Contains(m.Name))
            return $"((...__a: any[]) => R.callStatic(c, {Js(GN(m.ContainingType))}, {Js(GenName(m))}, ...__a))";
        // 委派自己的 Invoke 當方法群組（BaseBookmark.SetOnClickEvent 的 AddListener(action.Invoke)）：就是那個委派本身
        if (m.MethodKind == MethodKind.DelegateInvoke && receiver != null) return E(receiver);
        if (Core)
        {
            // base.M 當委派：固定叫基底那一版（C# 用 base 建的委派不做虛擬分派；照實際類別分派會叫回自己的覆寫）
            if (receiver is BaseExpressionSyntax && !m.IsStatic && GenMethods.TryGetValue(GN(m.ContainingType), out var bam) && bam.Contains(m.Name))
                return $"R.boundAs(c, {Js(GN(m.ContainingType))}, {Js(GenName(m))}, c.self)";
            var recvJs = receiver == null || receiver is ThisExpressionSyntax ? "c.self" : E(receiver);
            var defm = m.ReducedFrom ?? m;
            // 同批轉的類別的實體方法（別的實體，或自己的 virtual 方法）：照實際類別分派，同一個實體同一個方法拿到同一個函式
            if (!m.IsStatic && m.ReducedFrom == null && GenMethods.TryGetValue(GN(m.ContainingType), out var bgm) && bgm.Contains(m.Name))
                return $"R.boundGen(c, {Js(GN(m.ContainingType))}, {Js(GenName(m))}, {recvJs})";
            // 介面方法
            if (!m.IsStatic && m.ContainingType.TypeKind == TypeKind.Interface)
                return $"R.boundIface(c, {Js(GN(m.ContainingType))}, {Js(m.Name)}, {recvJs})";
            // 同批轉的擴充方法當委派（x.Ext 綁住 x）
            if (m.ReducedFrom != null && GenMethods.TryGetValue(GN(defm.ContainingType), out var egm2) && egm2.Contains(defm.Name))
                return $"((...__a: any[]) => R.callStatic(c, {Js(GN(defm.ContainingType))}, {Js(GenName(defm))}, {recvJs}, ...__a))";
            // 相容層的方法：包一個呼叫它的函式（跟直接呼叫同一個名字）
            var ckey = $"{TK(defm.ContainingType)}_{defm.Name}{Ovl(m)}";
            if (RT.Contains(ckey))
                return m.IsStatic && m.ReducedFrom == null ? $"((...__a: any[]) => R.{ckey}(c, ...__a))" : $"((...__a: any[]) => R.{ckey}(c, {recvJs}, ...__a))";
        }
        // 其他型別的方法當委派（例如 enemyIntentionSpecial.ImmediateHideIntention）：key 帶型別，receiver 由相容層處理
        var key = $"{TK(m.ContainingType)}.{m.Name}";
        if (receiver != null && !(receiver is ThisExpressionSyntax))
            return Rt("bindDelegate", new[] { Js(key), E(receiver) }, at);
        return Js(key);
    }

    /// X.Instance（單例）：相容層的名字不帶對象。ui 模式下 X 是同一次轉的類別時不算（Instance 是 R.genStatic，對象照樣傳）
    bool IsSingleton(ExpressionSyntax recv) =>
        recv is MemberAccessExpressionSyntax ma && ma.Name.Identifier.Text == "Instance" && M.GetSymbolInfo(ma).Symbol is IPropertySymbol { IsStatic: true } or IFieldSymbol { IsStatic: true }
        && !(Ui && M.GetTypeInfo(recv).Type is ITypeSymbol st && GenMethods.ContainsKey(GN(st)));

    bool IsTypeRef(ExpressionSyntax recv) => M.GetSymbolInfo(recv).Symbol is INamedTypeSymbol;

    string MemberAccess(MemberAccessExpressionSyntax ma) => MemberAccess(ma, ma.Expression, ma.Name);

    /// 成員存取：node 是整個運算式（語意、報告位置用），rx 是對象，nm 是成員名。?. 右邊開頭的 .X 沒有明寫對象，rx 是 ?. 左邊（BindingReceiver）
    string MemberAccess(ExpressionSyntax node, ExpressionSyntax rx, SimpleNameSyntax nm)
    {
        var sym = M.GetSymbolInfo(node).Symbol ?? M.GetSymbolInfo(node).CandidateSymbols.FirstOrDefault();
        var name = nm.Identifier.Text;
        if (sym is IFieldSymbol cf && cf.HasConstantValue) return ConstLit(cf.ConstantValue, cf.Type, $"{cf.ContainingType.Name}.{cf.Name}");
        if (sym is IMethodSymbol mg) return MethodGroup(mg, rx, node);
        if (sym is INamedTypeSymbol nts) return Js(nts.Name);
        if (Ui && sym is IEventSymbol ev)
            return Rt("eventGet", new[] { Js($"{TK(ev.ContainingType)}.{ev.Name}"), ev.IsStatic || IsSingleton(rx) ? "null" : E(rx) }, node);
        if (rx is ThisExpressionSyntax || rx is BaseExpressionSyntax)
        {
            if (sym is IFieldSymbol tf && Same(tf.ContainingType, T)) return OwnField(tf, node);
            if (sym is IFieldSymbol itf && InheritedGenField(itf)) return $"c.ai.{name}";
            if (sym is IPropertySymbol tp && GenProp(tp) && PropGet(tp, null, rx is BaseExpressionSyntax) is string tpg) return tpg;
            if (UiComponentField(sym) && !RT.Contains($"{TK(sym.ContainingType)}_get_{name}")) return $"R.mbGet(c, c.self, {Js(name)})";
            if (sym is IFieldSymbol or IPropertySymbol) return Rt($"{TK(sym.ContainingType)}_get_{name}", new[] { "c.self" }, node);
        }
        var rtype = M.GetTypeInfo(rx).Type;
        if (sym is IPropertySymbol ps0 && (name == "Count" || name == "Length") && (IsCollection(rtype) || rtype?.SpecialType == SpecialType.System_String))
            return $"{E(rx)}.length";
        // tuple 的成員：產生的程式碼裡 tuple 是 { 名字: 值 } 物件；ItemN 換成那個位置的名字
        if (sym is IFieldSymbol tf2 && tf2.ContainingType.IsTupleType)
        {
            var el = tf2.CorrespondingTupleField ?? tf2;
            var els = tf2.ContainingType.TupleElements;
            // 有名字的元素（sortOrder）本身就在 TupleElements 裡；ItemN 照對應的元素找（以前只找後者，有名字的元素找不到位置）
            var idx = Enumerable.Range(0, els.Length).FirstOrDefault(i => SymbolEqualityComparer.Default.Equals(els[i], tf2)
                || SymbolEqualityComparer.Default.Equals(els[i].CorrespondingTupleField ?? els[i], el), -1);
            if (idx < 0) return $"{E(rx)}.{name}";
            return TupleItem(E(rx), tf2.ContainingType, idx);
        }
        // UniTask.CompletedTask／Task.CompletedTask：引擎同步執行
        if ((sym is IPropertySymbol { IsStatic: true } || sym is IFieldSymbol { IsStatic: true }) && name == "CompletedTask") return "undefined";
        if (sym is IPropertySymbol gp0 && GenProp(gp0) && PropGet(gp0, gp0.IsStatic ? null : E(rx), rx is BaseExpressionSyntax) is string gpg) return gpg;
        if (sym is IFieldSymbol or IPropertySymbol)
        {
            var ct = sym.ContainingType;
            // ui：靜態欄位寫成 型別.名字（TutorialManager.Instance）：自己的走模組變數，同一次轉的別的類別走 R.genStatic（那個模組的 statics）
            if (Ui && sym is IFieldSymbol { IsStatic: true } sf && !sf.HasConstantValue)
            {
                if (Same(ct, T)) return OwnField(sf, node);
                if (GenMethods.ContainsKey(GN(ct))) return $"R.genStatic(c, {Js(GN(ct))}, {Js(name)})";
            }
            if (sym.IsStatic) return Rt($"{TK(ct)}_get_{name}", Array.Empty<string>(), node);
            // ui：同一次轉的類別（自己或別的）的實體欄位，對象不是 this（TutorialManager.Instance.currentCard）：R.mbGet，對象照樣求值
            //（單例也是：Instance 是那個類別的靜態欄位，上面換成 R.genStatic）
            if (Ui && sym is IFieldSymbol gf && DerivesFrom(ct, "UnityEngine.Component") && (Same(ct, T) || GenMethods.ContainsKey(GN(ct))) && !RT.Contains($"{TK(ct)}_get_{name}"))
                return $"R.mbGet(c, {E(rx)}, {Js(name)})";
            if (IsSingleton(rx)) return Rt($"{TK(ct)}_get_{name}", Array.Empty<string>(), node);
            if (sym is IFieldSymbol && Direct(ct) || DirectTypes.Contains(ct.Name)) return $"{E(rx)}.{name}";
            if (sym is IFieldSymbol of && Same(of.ContainingType, T)) return NotPorted(node, null);
            if (UiComponentField(sym) && !RT.Contains($"{TK(ct)}_get_{name}")) return $"R.mbGet(c, {E(rx)}, {Js(name)})";
            return Rt($"{TK(ct)}_get_{name}", new[] { E(rx) }, node);
        }
        return NotPorted(node, null);
    }

    /// ?. 右邊開頭的 .X（MemberBinding）的對象：最近一層右邊包含它的 ?. 的左邊
    static ExpressionSyntax BindingReceiver(SyntaxNode n)
    {
        for (var p = n.Parent; p != null; p = p.Parent)
            if (p is ConditionalAccessExpressionSyntax pca && pca.WhenNotNull.Span.Contains(n.Span)) return pca.Expression;
        return null;
    }

    string ConditionalAccess(ConditionalAccessExpressionSyntax ca)
    {
        var t = $"__ca{++tmp}";
        hoist.Add(t);
        var recv = E(ca.Expression);
        // WhenNotNull 以 MemberBinding 開頭：換成暫存變數的成員存取再轉
        var rewritten = SyntaxFactory.ParseExpression(t + ca.WhenNotNull.ToString());
        // 語意要用原本的節點：只處理最常見的 .Prop 與 .Method(...)。
        // 工具包模式不走這兩條特例：一律交給下面的一般路徑（同批轉的類別走 R.callGen、擴充方法、介面、委派都跟沒有 ?. 時一樣）
        if (!Core && ca.WhenNotNull is MemberBindingExpressionSyntax mb)
        {
            var sym = M.GetSymbolInfo(mb).Symbol;
            if (sym is IPropertySymbol cgp && GenProp(cgp) && !cgp.IsStatic && PropGet(cgp, t) is string cpg)
                return $"(({t} = {recv}) == null ? null : {cpg})";
            if (sym is IPropertySymbol or IFieldSymbol)
            {
                var ct = sym.ContainingType;
                var get = DirectTypes.Contains(ct.Name) || sym is IFieldSymbol && Direct(ct) ? $"{t}.{mb.Name.Identifier.Text}" : Rt($"{TK(ct)}_get_{mb.Name.Identifier.Text}", new[] { t }, ca);
                return $"(({t} = {recv}) == null ? null : {get})";
            }
        }
        if (!Core && ca.WhenNotNull is InvocationExpressionSyntax inv && inv.Expression is MemberBindingExpressionSyntax mb2 && M.GetSymbolInfo(inv).Symbol is IMethodSymbol m)
        {
            var args = Args(inv.ArgumentList, m);
            var call = m.ContainingType.Name is "Action" || m.MethodKind == MethodKind.DelegateInvoke
                ? Rt("invokeDelegate", new[] { t }.Concat(args), ca)
                : Rt($"{TK(m.ContainingType)}_{m.Name}{Ovl(m)}", new[] { t }.Concat(args), ca);
            return $"(({t} = {recv}) == null ? null : {call})";
        }
        // ui：其他（呼叫鏈 x?.A().B(y)、巢狀 a?.b?.c、x?.欄位.方法()）：右邊照一般運算式轉，開頭 .X 的對象（?. 的左邊）換成暫存變數
        if (Ui)
        {
            boundRecv[ca.Expression] = t;
            var rest = E(ca.WhenNotNull);
            boundRecv.Remove(ca.Expression);
            return $"(({t} = {recv}) == null ? null : {rest})";
        }
        return NotPorted(ca, null);
    }

    /// 型別判斷：相容層有 isInstance（遊戲專案的相容層帶工具包的 csport/core）時走它，照實際類別、基底鏈、介面判斷；
    /// 相容層有專門的 is_<型別>，或沒有 isInstance（diceomancer-web）時照舊叫 R.is_<型別>。泛型參數（is T）照舊。
    string IsType(ITypeSymbol t, string v, SyntaxNode at)
    {
        // 工具包模式：is T（型別參數）照執行時的型別引數判斷
        if (Core && t is ITypeParameterSymbol) return $"R.isInstance(c, {v}, {TypeRef(t)})";
        if (Ui && t != null && t.TypeKind != TypeKind.TypeParameter && RT.Contains("isInstance") && !RT.Contains($"is_{TK(t)}"))
            return $"R.isInstance(c, {v}, {Js(GN(t))})";
        return Rt($"is_{TK(t)}", new[] { v }, at);
    }

    string IsPattern(IsPatternExpressionSyntax ip)
    {
        var v = E(ip.Expression);
        switch (ip.Pattern)
        {
            case ConstantPatternSyntax cp when cp.Expression.IsKind(SyntaxKind.NullLiteralExpression):
                return $"({v} == null)";
            case UnaryPatternSyntax up when up.Pattern is ConstantPatternSyntax cp2 && cp2.Expression.IsKind(SyntaxKind.NullLiteralExpression):
                return $"({v} != null)";
            case DeclarationPatternSyntax dp when dp.Designation is SingleVariableDesignationSyntax sv:
            {
                var t = M.GetTypeInfo(dp.Type).Type;
                hoist.Add(Id(sv.Identifier.Text));
                return IsType(t, $"({Id(sv.Identifier.Text)} = {v})", ip);
            }
            case TypePatternSyntax tp:
                return IsType(M.GetTypeInfo(tp.Type).Type, v, ip);
            // ui：屬性模式（item is CovenantState { AscensionLevel: <=1 }）
            case RecursivePatternSyntax when Ui:
            {
                var pv = $"__p{++tmp}";
                hoist.Add(pv);
                return PatternCond(ip.Pattern, $"({pv} = {v})", pv, M.GetTypeInfo(ip.Expression).Type, ip) ?? NotPorted(ip, null);
            }
            default:
                return NotPorted(ip, null);
        }
    }

    /// ui：模式比對的條件。first 是第一次用到值時的寫法（含存進暫存變數），v 是之後用的暫存變數，t 是值的型別。
    /// 支援常數、關係（< <= > >=）、not／and／or、型別、宣告、捨棄、屬性模式 { 屬性: 子模式 }；其他回 null
    string PatternCond(PatternSyntax p, string first, string v, ITypeSymbol t, SyntaxNode at)
    {
        switch (p)
        {
            case DiscardPatternSyntax:
                return $"(void {first}, true)";
            case ConstantPatternSyntax cp:
                return cp.Expression.IsKind(SyntaxKind.NullLiteralExpression) ? $"{first} == null" : $"{first} === {E(cp.Expression)}";
            case RelationalPatternSyntax rp:
                return $"{first} {rp.OperatorToken.Text} {E(rp.Expression)}";
            case ParenthesizedPatternSyntax pp:
                return PatternCond(pp.Pattern, first, v, t, at) is string pc ? $"({pc})" : null;
            case UnaryPatternSyntax up when up.IsKind(SyntaxKind.NotPattern):
                return PatternCond(up.Pattern, first, v, t, at) is string nc ? $"!({nc})" : null;
            case BinaryPatternSyntax bp:
            {
                var l = PatternCond(bp.Left, first, v, t, at);
                var r = PatternCond(bp.Right, v, v, t, at);
                return l != null && r != null ? $"({l} {(bp.IsKind(SyntaxKind.AndPattern) ? "&&" : "||")} {r})" : null;
            }
            case TypePatternSyntax tp:
                return IsType(M.GetTypeInfo(tp.Type).Type, first, at);
            case DeclarationPatternSyntax dp when dp.Designation is SingleVariableDesignationSyntax dsv:
                hoist.Add(Id(dsv.Identifier.Text));
                return $"({IsType(M.GetTypeInfo(dp.Type).Type, first, at)} && ({Id(dsv.Identifier.Text)} = {v}, true))";
            // 工具包模式：var x（屬性模式的 { P: var x }）一定成立，把值存進 x；var _ 只求值
            case VarPatternSyntax vp when Core && vp.Designation is SingleVariableDesignationSyntax vsv:
                hoist.Add(Id(vsv.Identifier.Text));
                return $"({Id(vsv.Identifier.Text)} = {first}, true)";
            case VarPatternSyntax vp2 when Core && vp2.Designation is DiscardDesignationSyntax:
                return $"(void {first}, true)";
            case RecursivePatternSyntax rec when rec.PositionalPatternClause == null:
            {
                var conds = new List<string>();
                var nt = t;
                if (rec.Type != null)
                {
                    nt = M.GetTypeInfo(rec.Type).Type;
                    conds.Add(IsType(nt, first, at));
                }
                else conds.Add($"{first} != null");
                foreach (var sub in rec.PropertyPatternClause?.Subpatterns ?? default)
                {
                    if (sub.NameColon == null || M.GetSymbolInfo(sub.NameColon.Name).Symbol is not ISymbol ms) return null;
                    var mt = ms is IPropertySymbol mps ? mps.Type : (ms as IFieldSymbol)?.Type;
                    var get = MemberGet(ms, nt, v, sub);
                    var mv = $"__p{++tmp}";
                    hoist.Add(mv);
                    var sc = PatternCond(sub.Pattern, $"({mv} = {get})", mv, mt, sub);
                    if (sc == null) return null;
                    conds.Add(sc);
                }
                if (rec.Designation is SingleVariableDesignationSyntax rsv)
                {
                    hoist.Add(Id(rsv.Identifier.Text));
                    conds.Add($"({Id(rsv.Identifier.Text)} = {v}, true)");
                }
                return "(" + string.Join(" && ", conds) + ")";
            }
            default:
                return null;
        }
    }

    /// ui：已求值的對象（字串 recv，型別 rt）的欄位／屬性讀取，規則同 MemberAccess 的一般對象（屬性模式用）
    string MemberGet(ISymbol sym, ITypeSymbol rt, string recv, SyntaxNode at)
    {
        var name = sym.Name;
        if (sym is IFieldSymbol cf && cf.HasConstantValue) return ConstLit(cf.ConstantValue, cf.Type, $"{cf.ContainingType.Name}.{cf.Name}");
        if (sym is IPropertySymbol && name is "Count" or "Length" && (IsCollection(rt) || rt?.SpecialType == SpecialType.System_String)) return $"{recv}.length";
        if (sym is IPropertySymbol gp && GenProp(gp) && PropGet(gp, gp.IsStatic ? null : recv) is string gpg) return gpg;
        var ct = sym.ContainingType;
        if (sym.IsStatic) return Rt($"{TK(ct)}_get_{name}", Array.Empty<string>(), at);
        if (sym is IFieldSymbol && DerivesFrom(ct, "UnityEngine.Component") && (Same(ct, T) || GenMethods.ContainsKey(GN(ct))) && !RT.Contains($"{TK(ct)}_get_{name}"))
            return $"R.mbGet(c, {recv}, {Js(name)})";
        if (sym is IFieldSymbol && Direct(ct) || DirectTypes.Contains(ct.Name)) return $"{recv}.{name}";
        if (UiComponentField(sym) && !RT.Contains($"{TK(ct)}_get_{name}")) return $"R.mbGet(c, {recv}, {Js(name)})";
        return Rt($"{TK(ct)}_get_{name}", new[] { recv }, at);
    }

    // tuple 的第 i 個元素：有名字照名字取；沒名字（ItemN）照位置取。
    // 沒名字的 tuple 型別可以接有名字的值（(bool, X) t = LoadCampaignInfo() 的回傳是 { hasValidInfo, campaignInformation }），
    // 產生的物件欄位照位置排好（Tuple()），所以照位置取不會錯。
    // 工具包模式：反過來，有名字的型別也可能接到沒名字建的物件（C# 的 tuple 名字只在編譯期；MT2 的 CardManager.DrawDeploymentPhaseHand
    // 用 List<(int, CardState)> 建 { Item1, Item2 }，排序的 lambda 參數寫成 (int sortOrder, CardState cardState) first）：R.tupleItem 有這個名字照名字、沒有照位置
    string TupleItem(string recv, INamedTypeSymbol tt, int i)
    {
        var el = tt.TupleElements[i];
        if (!el.IsExplicitlyNamedTupleElement) return $"Object.values({recv})[{i}]";
        return Core && RT.Contains("tupleItem") ? $"R.tupleItem({recv}, {Js(el.Name)}, {i})" : $"{recv}.{el.Name}";
    }

    string Tuple(TupleExpressionSyntax tu)
    {
        var tt = (M.GetTypeInfo(tu).ConvertedType ?? M.GetTypeInfo(tu).Type) as INamedTypeSymbol;
        var parts = new List<string>();
        for (int i = 0; i < tu.Arguments.Count; i++)
        {
            var a = tu.Arguments[i];
            var nm = a.NameColon?.Name.Identifier.Text ?? (tt != null && tt.IsTupleType && i < tt.TupleElements.Length ? tt.TupleElements[i].Name : $"Item{i + 1}");
            parts.Add($"{nm}: {E(a.Expression)}");
        }
        return "{ " + string.Join(", ", parts) + " }";
    }

    // 呼叫的引數照參數順序排好（具名引數、預設值、params、out）
    List<string> Args(ArgumentListSyntax al, IMethodSymbol m)
    {
        var ps = m.Parameters;
        var slots = new string[ps.Length];
        var paramsList = new List<string>();
        bool expandedParams = false;
        for (int i = 0; i < al.Arguments.Count; i++)
        {
            var a = al.Arguments[i];
            int pi = a.NameColon != null ? ps.IndexOf(ps.First(p => p.Name == a.NameColon.Name.Identifier.Text)) : Math.Min(i, ps.Length - 1);
            string val;
            if (a.RefKindKeyword.IsKind(SyntaxKind.OutKeyword))
            {
                string vname;
                if (a.Expression is DeclarationExpressionSyntax de && de.Designation is SingleVariableDesignationSyntax sv) { vname = Id(sv.Identifier.Text); hoist.Add(vname); }
                else if (a.Expression is DeclarationExpressionSyntax de2 && de2.Designation is DiscardDesignationSyntax) { vname = $"__discard{++tmp}"; hoist.Add(vname); }
                else vname = E(a.Expression);
                val = $"(__v: any) => {{ {vname} = __v; }}";
            }
            else if (a.RefKindKeyword.IsKind(SyntaxKind.RefKeyword))
            {
                // ui：ref 引數 → { get v, set v } 盒子（被呼叫的產生方法讀寫 參數.v；結構的欄位修改是同一個物件，直接改到呼叫端）
                var rlv = Ui ? LValueOrNull(a.Expression) : null;
                val = rlv != null ? $"{{ get v() {{ return {rlv}; }}, set v(__x: any) {{ {rlv} = __x; }} }}" : NotPorted(a, null);
            }
            else val = E(a.Expression);
            if (pi < ps.Length && ps[pi].IsParams && a.NameColon == null)
            {
                var at = M.GetTypeInfo(a.Expression).Type;
                if (al.Arguments.Count == ps.Length && at is IArrayTypeSymbol) slots[pi] = val;
                else { paramsList.Add(val); expandedParams = true; }
            }
            else slots[pi] = val;
        }
        if (expandedParams) slots[ps.Length - 1] = "[" + string.Join(", ", paramsList) + "]";
        for (int i = 0; i < ps.Length; i++)
        {
            if (slots[i] != null) continue;
            var p = ps[i];
            if (p.IsParams) slots[i] = "[]";
            // 預設值寫 null（或參考型別的 default）：C# 傳的就是 null。DefaultOf 對集合型別給 []（序列化欄位用的），參數不能用它：
            // CombatManager.RemoveDeadCharacters(List<CharacterState> overrideList = null) 被補成 []，「overrideList != null」成立、
            // 只看空清單，戰鬥中死掉的角色一直沒移除，Boss 打完不出結算畫面（Jason 10/18 指出）。值型別（struct、型別參數）照舊 DefaultOf
            else if (p.HasExplicitDefaultValue) slots[i] = p.ExplicitDefaultValue == null ? CsDefault(p.Type) : ConstLit(p.ExplicitDefaultValue, p.Type, null);
            else slots[i] = "undefined";
        }
        return slots.ToList();
    }

    string Invocation(InvocationExpressionSyntax inv)
    {
        var si = M.GetSymbolInfo(inv);
        var m = si.Symbol as IMethodSymbol ?? si.CandidateSymbols.OfType<IMethodSymbol>().FirstOrDefault();
        if (m == null) return NotPorted(inv, null);
        if (m.MethodKind == MethodKind.DelegateInvoke)
        {
            var target = inv.Expression is MemberAccessExpressionSyntax dm && dm.Name.Identifier.Text == "Invoke" ? dm.Expression : inv.Expression;
            return Rt("invokeDelegate", new[] { E(target) }.Concat(Args(inv.ArgumentList, m)), inv);
        }
        // 工具包模式：區域函式（產生成所在區塊裡的 function 宣告）直接叫
        if (Core && m.MethodKind == MethodKind.LocalFunction)
            return $"{Id(m.Name)}({string.Join(", ", Args(inv.ArgumentList, m))})";
        var name = m.Name;
        ExpressionSyntax recv = inv.Expression switch
        {
            MemberAccessExpressionSyntax ma => ma.Expression,
            // ui：?. 右邊開頭的 .Method()：對象是 ?. 的左邊（產生時是暫存變數）
            MemberBindingExpressionSyntax mbr when Ui => BindingReceiver(mbr),
            _ => null,
        };
        var def = m.ReducedFrom ?? m;
        // LINQ 與 List／陣列：轉成 JS 陣列操作
        if (m.ReducedFrom != null && def.ContainingType.ToDisplayString() == "System.Linq.Enumerable")
            return Linq(inv, m, recv);
        // 工具包模式：LINQ 寫成靜態呼叫（反編譯器把具名引數寫成 Enumerable.Concat(second: b, first: a)）：照參數順序排好，第一個當來源，照擴充方法轉
        if (Core && m.ReducedFrom == null && m.IsExtensionMethod && m.ContainingType.ToDisplayString() == "System.Linq.Enumerable" && inv.ArgumentList.Arguments.Count == m.Parameters.Length)
        {
            var ordered = new ExpressionSyntax[m.Parameters.Length];
            for (int i = 0; i < inv.ArgumentList.Arguments.Count; i++)
            {
                var ax = inv.ArgumentList.Arguments[i];
                int pi = ax.NameColon != null ? m.Parameters.IndexOf(m.Parameters.First(p => p.Name == ax.NameColon.Name.Identifier.Text)) : i;
                ordered[pi] = ax.Expression;
            }
            if (ordered.All(x => x != null) && M.GetTypeInfo(ordered[0]).Type is ITypeSymbol srcT && m.ReduceExtensionMethod(srcT) is IMethodSymbol reduced)
                return Linq(inv, reduced, ordered[0], ordered.Skip(1).ToList());
        }
        var args = Args(inv.ArgumentList, m);
        var recvType = recv != null ? M.GetTypeInfo(recv).Type : null;
        // enum 的 ToString()：照 enum 成員的名字（值 → 名字表）
        if (name == "ToString" && args.Count == 0 && recvType is INamedTypeSymbol { TypeKind: TypeKind.Enum } et)
            return EnumName(et, E(recv));
        if (name == "Parse" && m.IsStatic && m.ContainingType.SpecialType == SpecialType.System_Int32 && args.Count == 1) return $"R.int32Parse(c, {args[0]})";
        // ui：Enum.GetValues(typeof(E))：E 的成員值直接寫成陣列，順序跟 .NET 一樣照無號值排（MT2 RandomManager 的 RngId）
        if (Ui && name == "GetValues" && m.IsStatic && m.ContainingType.SpecialType == SpecialType.System_Enum && inv.ArgumentList.Arguments.Count == 1
            && inv.ArgumentList.Arguments[0].Expression is TypeOfExpressionSyntax gtof && M.GetTypeInfo(gtof.Type).Type is INamedTypeSymbol { TypeKind: TypeKind.Enum } genum)
            return "[" + string.Join(", ", genum.GetMembers().OfType<IFieldSymbol>().Where(f => f.HasConstantValue).Select(f => Convert.ToInt64(f.ConstantValue))
                .OrderBy(v => unchecked((ulong)v)).Select(v => v.ToString(System.Globalization.CultureInfo.InvariantCulture))) + "]";
        if (recv != null && !m.IsStatic && (IsCollection(recvType) || recvType?.OriginalDefinition.ToDisplayString().StartsWith("System.Collections.Generic.List<") == true))
        {
            var r = E(recv);
            // 工具包模式：元素不是數字、字串、列舉、bool 時，Contains／IndexOf 照 C# 的相等（EqualityComparer<T>.Default：覆寫的 Equals、結構照值）
            var elemT = recvType is IArrayTypeSymbol rat ? rat.ElementType : (recvType as INamedTypeSymbol)?.TypeArguments.FirstOrDefault();
            bool csEq = Core && elemT != null && NeedsCsEquality(elemT);
            switch (name)
            {
                case "Add": return $"{r}.push({args[0]})";
                case "AddRange": return $"{r}.push(...{args[0]})";
                case "Contains" when csEq: return Rt("listContains", new[] { r, args[0] }, inv);
                case "IndexOf" when csEq && args.Count == 1: return Rt("listIndexOf", new[] { r, args[0] }, inv);
                case "Contains": return $"{r}.includes({args[0]})";
                case "IndexOf": return $"{r}.indexOf({args[0]})";
                case "Insert": return $"{r}.splice({args[0]}, 0, {args[1]})";
                case "RemoveAt": return $"{r}.splice({args[0]}, 1)";
                case "Remove": return Rt("listRemove", new[] { r, args[0] }, inv);
                case "Clear": return $"({r}.length = 0)";
                case "ToArray": return $"[...{r}]";
                case "Reverse": return $"{r}.reverse()";
            }
        }
        if (m.IsStatic && m.ContainingType.SpecialType == SpecialType.System_Array || (m.IsStatic && m.ContainingType.ToDisplayString() == "System.Array"))
        {
            if (name == "Reverse") return $"{args[0]}.reverse()";
            // 工具包模式：Array.Resize<T>(ref a, n) 放大時新格子是 default(T)（struct 是新的實體、int 是 0）：預設值接在後面給相容層
            if (Core && name == "Resize" && m.IsGenericMethod && m.TypeArguments.Length == 1 && RT.Contains("Array_Resize"))
                return Rt("Array_Resize", args.Append(CsDefault(m.TypeArguments[0])), inv);
        }
        if (m.IsStatic && m.ContainingType.SpecialType == SpecialType.System_String && name == "IsNullOrEmpty") return $"!({args[0]})";
        if (m.IsStatic && m.ContainingType.ToDisplayString() == "System.Delegate" && name == "Combine") return Rt("Delegate_Combine", args, inv);

        // 工具包模式：叫產生的泛型方法，型別引數（明寫或推斷的）一律接在後面（產生的方法宣告 __T_名字 參數，typeof(T)、is T、new T() 用）
        var defm = m.ReducedFrom ?? m;
        if (Core && defm.IsGenericMethod && (Same(defm.ContainingType, T) || GenMethods.ContainsKey(GN(defm.ContainingType))) && defm.DeclaringSyntaxReferences.Length > 0)
            args.AddRange(AllTypeArgs(m).Select(TypeRef));
        // ui：泛型方法明寫的型別引數（GetComponent<LineRenderer>()）多傳型別名字串
        // （工具包模式也認條件存取的 x?.GetComponentInChildren<Image>()：運算式是 MemberBinding）
        else if (Ui && m.IsGenericMethod && (inv.Expression is GenericNameSyntax || inv.Expression is MemberAccessExpressionSyntax { Name: GenericNameSyntax }
                     || Core && inv.Expression is MemberBindingExpressionSyntax { Name: GenericNameSyntax }))
            args.AddRange(m.TypeArguments.Select(ta => Core ? TypeRef(ta) : Js(TK(ta)))); // 工具包模式：產生名（帶 namespace 的 I2_Loc_ResourceManager）、型別參數照執行期的值
        // ui：Unity 的 GetComponents 家族由 List<T> 參數推斷 T（GetComponentsInChildren(false, list)）：沒有明寫也要傳型別名，
        // 相容層照它挑元件（以前沒傳，UIParticle 找不到父 UIParticle、Selectable 的 CanvasGroup 快取是空的）
        else if (Ui && m.IsGenericMethod && name.StartsWith("GetComponent")
                 && m.ContainingType.ToDisplayString() is "UnityEngine.Component" or "UnityEngine.GameObject")
            args.AddRange(m.TypeArguments.Select(ta => Core ? TypeRef(ta) : Js(TK(ta))));
        // 工具包模式：DLL 泛型型別的靜態方法（ScriptPlayable<T>.Create）：包含型別的型別引數接在後面（相容層照 T 建實體）
        else if (Core && m.IsStatic && m.ContainingType is INamedTypeSymbol { IsGenericType: true } cgt && cgt.TypeArguments.Length > 0
                 && cgt.DeclaringSyntaxReferences.Length == 0 && !GenMethods.ContainsKey(GN(cgt.OriginalDefinition)))
            args.AddRange(cgt.TypeArguments.Select(TypeRef));
        // ui：同一次轉的類別的擴充方法（MT2 的 rngId.IsDebugLog()、str.GetMurmurHash()）：receiver 當第一個引數；自己的直接叫，別的類別走 R.callStatic
        if (Ui && m.ReducedFrom != null && recv != null)
        {
            var ext = m.ReducedFrom.OriginalDefinition;
            if (Same(ext.ContainingType, T) && ownMethods.TryGetValue(ext, out var ownExt)) return $"{ownExt}({string.Join(", ", new[] { "c", E(recv) }.Concat(args))})";
            if (GenMethods.TryGetValue(GN(ext.ContainingType), out var egm) && egm.Contains(ext.Name))
                return $"R.callStatic({string.Join(", ", new[] { "c", Js(GN(ext.ContainingType)), Js(GenName(ext)), E(recv) }.Concat(args))})";
        }
        // 自己的方法
        if (Same(m.ContainingType, T) && (recv == null || recv is ThisExpressionSyntax) && ownMethods.TryGetValue(m.OriginalDefinition, out var own))
        {
            // ui：virtual／abstract／override 的方法照實體的實際類別分派（子類別的覆寫也是產生的時候才有差，例如 MMF_Feedback.CustomPlayFeedback）
            if (Ui && IsVirtualDispatch(m))
                return $"R.callGen({string.Join(", ", new[] { "c", Js(GN(T)), Js(own), "c.self" }.Concat(args))})";
            return $"{own}({string.Join(", ", new[] { "c" }.Concat(args))})";
        }
        // 同類別的別的實體（Selectable 裡的 selectable2.IsInteractable()）：照對象的實際類別分派
        if (Core && !m.IsStatic && Same(m.ContainingType, T) && recv != null && recv is not ThisExpressionSyntax && recv is not BaseExpressionSyntax && ownMethods.TryGetValue(m.OriginalDefinition, out var ownOther))
            return $"R.callGen({string.Join(", ", new[] { "c", Js(GN(T)), Js(ownOther), E(recv) }.Concat(args))})";
        // base.X()：基底是同一次轉的類別而且那個方法有轉出來 → 直接叫基底版（不分派）；否則走相容層
        if (recv is BaseExpressionSyntax)
        {
            if (Ui && GenMethods.TryGetValue(GN(m.ContainingType), out var bm) && bm.Contains(m.Name))
            {
                var bname = GenName(m);
                return $"R.callAs({string.Join(", ", new[] { "c", Js(GN(m.ContainingType)), Js(bname), "c.self" }.Concat(args))})";
            }
            // 工具包模式：基底是執行環境原生做的類別（TextMeshProUGUI、Graphic…）、相容層沒有專門的 base_ 函式：R.nativeBase
            // （Unity 的生命週期訊息由執行環境自己處理，其他方法執行環境有實作才做）
            var bk = TK(m.ContainingType);
            if (Core && RT.Contains("nativeBase") && ResolveRt($"base_{bk}_{name}{Ovl(m)}") == null && (Excluded.Contains(bk) || NativeComponents.Contains(bk) || NativeTypes.Contains(bk)))
                return $"R.nativeBase({string.Join(", ", new[] { "c", "c.self", Js(bk), Js(name) }.Concat(args))})";
            return Rt($"base_{bk}_{name}{Ovl(m)}", new[] { "c.self" }.Concat(args), inv);
        }
        // ui：同一次轉的別的類別、而且那個方法有轉出來：R.callGen（實體的 Ctx 由相容層找）
        if (Ui && !m.IsStatic && !Same(m.ContainingType, T) && GenMethods.TryGetValue(GN(m.ContainingType), out var gm) && gm.Contains(m.Name) && m.ReducedFrom == null)
        {
            var gname = GenName(m);
            // 單例（X.Instance）照樣求值：X 是同一次轉的類別時是 R.genStatic，否則走相容層的 X_get_Instance
            var grecv = recv == null || recv is ThisExpressionSyntax ? "c.self" : E(recv);
            return $"R.callGen({string.Join(", ", new[] { "c", Js(GN(m.ContainingType)), Js(gname), grecv }.Concat(args))})";
        }
        // ui：同一次轉的別的類別的靜態方法（CardWarningCounterCard.MightBeCounter）：R.callStatic，用呼叫端的 Ctx（靜態方法不碰實體欄位）
        if (Ui && m.IsStatic && m.ReducedFrom == null && !Same(m.ContainingType, T) && GenMethods.TryGetValue(GN(m.ContainingType), out var sgm) && sgm.Contains(m.Name))
        {
            var sname = GenName(m);
            // 工具包模式：泛型類別的靜態方法（StateMachine<State>.Initialize）：類別的型別引數也要帶（方法裡的 typeof(T)、
            // 叫別人時傳的 T 照它；R.typeArg 讀 Ctx 的 self.$targs），相容層用帶型別引數的 self 另建一個 Ctx
            if (Core && m.ContainingType.TypeArguments.Length > 0 && RT.Contains("callStaticT"))
                return $"R.callStaticT({string.Join(", ", new[] { "c", Js(GN(m.ContainingType)), "[" + string.Join(", ", m.ContainingType.TypeArguments.Select(TypeRef)) + "]", Js(sname) }.Concat(args))})";
            return $"R.callStatic({string.Join(", ", new[] { "c", Js(GN(m.ContainingType)), Js(sname) }.Concat(args))})";
        }
        // ui：介面方法（IGameUISelectableCommon.GetSelectable()）：照實體的實際類別找產生的實作（相容層有 callIface 才這樣寫；
        // 實作不是產生的類別時 callIface 再找相容層的 <介面>_<方法>）
        if (Ui && !m.IsStatic && def.ContainingType.TypeKind == TypeKind.Interface && RT.Contains("callIface") && !RT.Contains($"{TK(def.ContainingType)}_{name}{Ovl(m)}"))
        {
            var irecv = recv == null || recv is ThisExpressionSyntax ? "c.self" : E(recv);
            // 泛型介面（IDataView<DataType>.Set）：型別引數也帶。同一個類別實作好幾種封閉型別時（RelicInfoUI 的 IDataView<RelicState>／
            // IDataView<CollectableRelicData>），R.callIfaceT 照它查類別的 ifaceImpls，不然名字一樣分不出來
            // （只有原始碼裡宣告的介面會有 ifaceImpls，.NET 的 IEqualityComparer<T> 這類照舊）
            if (def.ContainingType.TypeArguments.Length > 0 && def.ContainingType.DeclaringSyntaxReferences.Length > 0 && RT.Contains("callIfaceT"))
                return $"R.callIfaceT({string.Join(", ", new[] { "c", Js(GN(def.ContainingType)), "[" + string.Join(", ", def.ContainingType.TypeArguments.Select(TypeRef)) + "]", Js(name), irecv }.Concat(args))})";
            return $"R.callIface({string.Join(", ", new[] { "c", Js(GN(def.ContainingType)), Js(name), irecv }.Concat(args))})";
        }
        var key = $"{TK(def.ContainingType)}_{name}{Ovl(m)}";
        if (m.ReducedFrom != null) // 其他擴充方法：receiver 當第一個引數
            return Rt(key, new[] { E(recv) }.Concat(args), inv);
        if (m.IsStatic) return Rt(key, args, inv);
        if (recv == null || recv is ThisExpressionSyntax) return Rt(key, new[] { "c.self" }.Concat(args), inv);
        if (IsSingleton(recv)) return Rt(key, args, inv);
        return Rt(key, new[] { E(recv) }.Concat(args), inv);
    }

    /// ui：產生的方法名。同名方法（沿基底鏈看原始碼裡宣告的、不同的參數列）只有一個 → 原名；參數數量都不同 → 名字$數量；否則 → 名字$參數型別。
    /// 自己的方法表、跨類別的 R.callGen／callStatic／callAs 都用這個，子類別的覆寫跟基底同一個名字（虛擬分派照名字找）
    /// 參數列：C# 的 (_, _) 是捨棄，JS 不准同名參數，重複的 _ 依序改成 _$1、_$2（只有一個 _ 時它是真的參數名，照舊）
    static string LambdaParams(SeparatedSyntaxList<ParameterSyntax> ps)
    {
        var discards = ps.Count(p => p.Identifier.Text == "_") > 1;
        var k = 0;
        return string.Join(", ", ps.Select(p => (discards && p.Identifier.Text == "_" ? $"_${++k}" : Id(p.Identifier.Text)) + ": any"));
    }

    static bool SameParams(IMethodSymbol a, IMethodSymbol b) => a.Parameters.Length == b.Parameters.Length
        && a.Parameters.Zip(b.Parameters).All(z => SymbolEqualityComparer.Default.Equals(z.First.Type, z.Second.Type) && z.First.RefKind == z.Second.RefKind);

    static string GenName(IMethodSymbol m)
    {
        var d = (m.ReducedFrom ?? m).OriginalDefinition;
        // 工具包模式：覆寫的方法跟被覆寫的方法（原始碼裡最上層的那個）同一個產生名。子類別多了同名的多載時
        // （RelicRewardData 的 SetDataFromPool）名字才不會跟基底岔開，R.callGen 的虛擬分派照名字找得到覆寫
        if (ArityNames && d.IsOverride)
        {
            var root = d;
            while (root.OverriddenMethod?.OriginalDefinition is { } om && om.ContainingType.DeclaringSyntaxReferences.Length > 0) root = om;
            if (!SymbolEqualityComparer.Default.Equals(root, d)) return GenName(root);
        }
        // 明確介面實作（void IPointerDownHandler.OnPointerDown(…)）：介面的產生名 $ 介面成員的產生名（R.callIface 先找這個）
        if (d.ExplicitInterfaceImplementations.Length > 0)
        {
            var im = d.ExplicitInterfaceImplementations[0];
            return $"{GN(im.ContainingType)}${(im.AssociatedSymbol is IPropertySymbol ? im.Name : GenName(im))}";
        }
        var sigs = new List<IMethodSymbol>();
        for (INamedTypeSymbol t = d.ContainingType; t != null && t.DeclaringSyntaxReferences.Length > 0; t = t.BaseType)
            foreach (var x in t.GetMembers(d.Name).OfType<IMethodSymbol>().Where(x => x.MethodKind == MethodKind.Ordinary))
                if (!sigs.Any(y => SameParams(y, x) && y.Arity == x.Arity))
                    sigs.Add(x);
        if (sigs.Count <= 1) return d.Name;
        // 只差型別參數個數的多載（MT2 CharacterState 的 GetRoomStateModifiers() 與 GetRoomStateModifiers<T>()）：泛型的那個加 $T<個數>
        var gen = d.Arity > 0 && sigs.Any(y => y.Arity != d.Arity && SameParams(y, d)) ? $"$T{d.Arity}" : "";
        if (sigs.Select(x => x.Parameters.Length).Distinct().Count() == sigs.Count) return $"{d.Name}${d.Parameters.Length}{gen}";
        return $"{d.Name}$" + ParamKey(d, sigs) + gen;
    }

    /// 泛型方法的全部型別引數，照宣告的型別參數順序（擴充方法的接收者推斷出來的那幾個也算）
    static List<ITypeSymbol> AllTypeArgs(IMethodSymbol m)
    {
        if (m.ReducedFrom == null) return m.TypeArguments.ToList();
        var res = new List<ITypeSymbol>();
        var rest = m.TypeArguments.ToList();
        foreach (var tp in m.ReducedFrom.TypeParameters)
        {
            var inferred = m.GetTypeInferredDuringReduction(tp);
            if (inferred != null) res.Add(inferred);
            else if (rest.Count > 0) { res.Add(rest[0]); rest.RemoveAt(0); }
        }
        return res;
    }

    /// 工具包模式：執行時的型別值（System.Type 在 TS 這邊是型別名字串）。類別的型別參數 → R.typeArg（實體的 $targs）；
    /// 列舉另外記進 UsedEnums（$enums.ts 的名字表，Enum.GetNames(type) 這類用）
    public static readonly HashSet<INamedTypeSymbol> UsedEnums = new(SymbolEqualityComparer.Default);
    string TypeRef(ITypeSymbol t)
    {
        if (t is ITypeParameterSymbol tp)
            return tp.TypeParameterKind == TypeParameterKind.Type ? $"R.typeArg(c, {tp.Ordinal}, {Js(tp.Name)}, {Js(GN(tp.DeclaringType))})" : $"(__T_{tp.Name} ?? {Js(tp.Name)})";
        if (t is INamedTypeSymbol { TypeKind: TypeKind.Enum } en) UsedEnums.Add(en);
        if (t is IArrayTypeSymbol at) return $"({TypeRef(at.ElementType)} + \"[]\")";
        // 建構過的泛型型別帶型別引數（typeof(GenericPool<List<int>>) 跟 GenericPool<List<string>> 不同）："名字<引數, …>"
        if (t is INamedTypeSymbol { IsGenericType: true } gt && !gt.IsUnboundGenericType && gt.TypeArguments.Length > 0 && !SymbolEqualityComparer.Default.Equals(gt, gt.OriginalDefinition))
            return $"({Js(GN(t.OriginalDefinition) + "<")} + {string.Join(" + \", \" + ", gt.TypeArguments.Select(TypeRef))} + \">\")";
        return Js(GN(t.OriginalDefinition));
    }
    /// TypeRef 在執行期算出來的型別名（型別裡沒有型別參數時，轉換時就算得出來；類別中繼資料的 ifaceImpls 用）
    static string TypeName(ITypeSymbol t) => t switch
    {
        IArrayTypeSymbol at => TypeName(at.ElementType) + "[]",
        INamedTypeSymbol { IsGenericType: true } gt when !gt.IsUnboundGenericType && gt.TypeArguments.Length > 0 && !SymbolEqualityComparer.Default.Equals(gt, gt.OriginalDefinition)
            => $"{GN(t.OriginalDefinition)}<{string.Join(", ", gt.TypeArguments.Select(TypeName))}>",
        _ => GN(t.OriginalDefinition),
    };
    static bool HasTypeParameter(ITypeSymbol t) => t switch
    {
        ITypeParameterSymbol => true,
        IArrayTypeSymbol at => HasTypeParameter(at.ElementType),
        INamedTypeSymbol nt => nt.TypeArguments.Any(HasTypeParameter),
        _ => false,
    };

    /// 多載的參數後綴：參數型別的短名（ShortTK）以底線接起來；只差泛型引數的別的多載（List<Vector3> 與 List<Vector2>、Event 與 Event<T>）
    /// 會撞名時才把泛型引數也寫進去（ShortTKFull），其他照舊
    static string ParamKey(IMethodSymbol d, List<IMethodSymbol> sigs)
    {
        // full：泛型引數與 ref／out 也寫進去（GenericPools 的 GetList<T>(List<T>) 與 GetList<T>(out List<T>)）
        string Key(IMethodSymbol x, bool full) => string.Join("_", x.Parameters.Select(p => full ? (p.RefKind != RefKind.None ? p.RefKind.ToString().ToLowerInvariant() : "") + ShortTKFull(p.Type) : ShortTK(p.Type)));
        var k = Key(d, false);
        return sigs.Any(y => !SameParams(y, d) && y.Parameters.Length == d.Parameters.Length && Key(y, false) == k) ? Key(d, true) : k;
    }
    static string ShortTKFull(ITypeSymbol t) => t switch
    {
        IArrayTypeSymbol at => ShortTKFull(at.ElementType) + "_arr",
        INamedTypeSymbol { IsGenericType: true } nt => $"{ShortTK(nt)}${nt.Arity}" + string.Concat(nt.TypeArguments.Select(a => "$" + ShortTKFull(a))),
        _ => ShortTK(t),
    };

    /// ui：建構子的產生名：只有一個 → ctor；多個 → ctor$參數型別
    static string CtorName(IMethodSymbol ctor)
    {
        var all = ctor.ContainingType.InstanceConstructors.Where(x => !x.IsImplicitlyDeclared).ToList();
        if (all.Count <= 1) return "ctor";
        return "ctor$" + ParamKey(ctor, all);
    }

    /// 會被子類別覆寫的方法（virtual、abstract、override，不是 sealed、不是 private）
    static bool IsVirtualDispatch(IMethodSymbol m) => (m.IsVirtual || m.IsAbstract || m.IsOverride) && !m.IsSealed && m.DeclaredAccessibility != Accessibility.Private;

    string Linq(InvocationExpressionSyntax inv, IMethodSymbol m, ExpressionSyntax recv, List<ExpressionSyntax> argx = null)
    {
        var r = E(recv);
        // 非 List／陣列的來源（Dictionary 的 KeyValuePair 列舉，DiceObject 的 ElementAt／FirstOrDefault）：同 foreach，交給相容層轉成陣列（10/13）；
        // 工具包模式下實作 IEnumerable 的產生類別直接展開
        var rt = M.GetTypeInfo(recv).Type;
        if (rt != null && !IsCollection(rt) && rt.SpecialType != SpecialType.System_String) r = GenEnumerable(rt) ? $"[...{r}]" : Rt($"{TK(rt)}_toArray", new[] { r }, recv);
        var a = (argx ?? inv.ArgumentList.Arguments.Select(x => x.Expression).ToList()).Select(x => E(x)).ToList();
        // 工具包模式：…OrDefault 帶元素型別的預設值（List<int> 是 0、類別是 null）；OfType／Cast 帶目標型別；
        // 其他沒列的運算子一律走相容層的 linq<名字>（dotnetLinq.ts）
        if (Core)
        {
            var src = m.TypeArguments.Length > 0 ? m.TypeArguments[0] : null;
            switch (m.Name)
            {
                case "FirstOrDefault": case "LastOrDefault": case "SingleOrDefault":
                    // 有預設值引數的多載（FirstOrDefault(defaultValue)、FirstOrDefault(pred, defaultValue)）：照引數；否則補型別的預設值
                    if (m.Parameters.Length > 0 && m.Parameters[^1].Type is not INamedTypeSymbol { TypeKind: TypeKind.Delegate } && a.Count == m.Parameters.Length)
                        return Rt($"linq{m.Name}", new[] { r }.Concat(a.Count == 1 ? new[] { "null" } : Array.Empty<string>()).Concat(a), inv);
                    return Rt($"linq{m.Name}", new[] { r, a.Count > 0 ? a[0] : "null", CsDefault(src) }, inv);
                case "ElementAtOrDefault":
                    return Rt("linqElementAtOrDefault", new[] { r, a[0], CsDefault(src) }, inv);
                case "OfType": case "Cast":
                    return Rt($"linq{m.Name}", new[] { r, TypeRef(m.TypeArguments[0]) }, inv);
                case "Any": case "All": case "Count": case "Where": case "Select": case "ToList": case "ToArray": case "Take": case "Skip":
                case "Contains": case "Reverse": case "Concat": case "Append": case "ElementAt": case "SelectMany": case "Distinct":
                    break;
                default:
                    return Rt($"linq{m.Name}", new[] { r }.Concat(a), inv);
            }
        }
        switch (m.Name)
        {
            case "Any": return a.Count == 0 ? $"({r}.length > 0)" : $"{r}.some({a[0]})";
            case "All": return $"{r}.every({a[0]})";
            case "Count": return a.Count == 0 ? $"{r}.length" : $"{r}.filter({a[0]}).length";
            case "Where": return $"{r}.filter({a[0]})";
            case "Select": return $"{r}.map({a[0]})";
            case "ToList": case "ToArray": return $"[...{r}]";
            case "Take": return $"{r}.slice(0, {a[0]})";
            case "Skip": return $"{r}.slice({a[0]})";
            case "Contains" when Core && a.Count == 1 && m.TypeArguments.Length > 0 && NeedsCsEquality(m.TypeArguments[0]): return Rt("listContains", new[] { r, a[0] }, inv);
            case "Contains": return $"{r}.includes({a[0]})";
            case "Reverse": return $"[...{r}].reverse()";
            case "Concat": return $"[...{r}, ...{a[0]}]";
            case "First": return Rt("linqFirst", new[] { r }.Concat(a), inv);
            case "FirstOrDefault": return Rt("linqFirstOrDefault", new[] { r }.Concat(a), inv);
            case "Last": return Rt("linqLast", new[] { r }.Concat(a), inv);
            case "LastOrDefault": return Rt("linqLastOrDefault", new[] { r }.Concat(a), inv);
            case "Sum": return Rt("linqSum", new[] { r }.Concat(a), inv);
            case "Max": return Rt("linqMax", new[] { r }.Concat(a), inv);
            case "Min": return Rt("linqMin", new[] { r }.Concat(a), inv);
            case "OrderBy": return Rt("linqOrderBy", new[] { r }.Concat(a), inv);
            case "OrderByDescending": return Rt("linqOrderByDescending", new[] { r }.Concat(a), inv);
            case "Distinct": return $"[...new Set({r})]";
            case "Append": return $"[...{r}, {a[0]}]";
            case "ElementAt": return $"{r}[{a[0]}]";
            case "SelectMany": return $"{r}.flatMap({a[0]})";
            default: return NotPorted(inv, $"Enumerable.{m.Name}");
        }
    }

    string Creation(ExpressionSyntax e, ArgumentListSyntax al, InitializerExpressionSyntax init)
    {
        // 工具包模式：new T()（型別參數）照執行時的型別引數 new
        if (Core && M.GetTypeInfo(e).Type is ITypeParameterSymbol ntp) return $"R.newT(c, {TypeRef(ntp)})";
        var t = M.GetTypeInfo(e).Type as INamedTypeSymbol;
        var ctor = M.GetSymbolInfo(e).Symbol as IMethodSymbol;
        if (t == null) return NotPorted(e, null);
        var full = t.OriginalDefinition.ToDisplayString();
        if (full.StartsWith("System.Collections.Generic.List<") || full.StartsWith("System.Collections.Generic.HashSet<"))
        {
            if (init != null) return "[" + string.Join(", ", init.Expressions.Select(E)) + "]";
            // 工具包模式：new List<KeyValuePair<K, V>>(dictionary)：展開字典拿到的是 [k, v]，元素要是 { Key, Value }，
            // 同 foreach、LINQ 交給相容層的 <型別>_toArray（GameVFXManager.CleanUp 的 new List<…>(_particlePoolMap)）
            if (Core && al != null && al.Arguments.Count == 1 && t.TypeArguments[0].OriginalDefinition.ToDisplayString() == "System.Collections.Generic.KeyValuePair<TKey, TValue>"
                && M.GetTypeInfo(al.Arguments[0].Expression).Type is ITypeSymbol kvs && !IsCollection(kvs) && !GenEnumerable(kvs))
                return Rt($"{TK(kvs)}_toArray", new[] { E(al.Arguments[0].Expression) }, e);
            if (al != null && al.Arguments.Count == 1 && !IsIntegral(M.GetTypeInfo(al.Arguments[0].Expression).Type)) return $"[...{E(al.Arguments[0].Expression)}]";
            return "[]";
        }
        if (t.TypeKind == TypeKind.Delegate && al != null && al.Arguments.Count == 1) return E(al.Arguments[0].Expression);
        // ui：自己的巢狀類別（[Serializable] 資料類別，沒有建構子參數）→ 物件字面值，欄位照初始式或預設值
        // 工具包模式：巢狀類別本身也是產生的類別（有 $type、方法、基底），走下面的 R.newGen
        if (Ui && OwnNested(t) && !(Core && GenMethods.ContainsKey(GN(t))) && (al == null || al.Arguments.Count == 0))
        {
            var props = t.GetMembers().OfType<IFieldSymbol>().Where(f => !f.IsStatic && !f.IsConst && !f.IsImplicitlyDeclared)
                .Select(f => $"{f.Name}: {(f.DeclaringSyntaxReferences[0].GetSyntax() is VariableDeclaratorSyntax vd && vd.Initializer != null ? E(vd.Initializer.Value) : DefaultOf(f.Type))}").ToList();
            if (init != null && init.IsKind(SyntaxKind.ObjectInitializerExpression))
                foreach (var x in init.Expressions)
                {
                    if (x is AssignmentExpressionSyntax a && a.Left is IdentifierNameSyntax ln) props.Add($"{ln.Identifier.Text}: {E(a.Right)}");
                    else return NotPorted(e, null);
                }
            return "{ " + string.Join(", ", props) + " }";
        }
        // 工具包模式：例外物件帶型別鏈（catch 照它比）、訊息（第一個字串引數）與 InnerException（例外型別的引數）
        if (Core && DerivesFrom(t, "System.Exception"))
        {
            var chain = new List<string>();
            for (var b = (ITypeSymbol)t; b != null && b.SpecialType != SpecialType.System_Object; b = b.BaseType) chain.Add(b.Name);
            var eargs = ctor != null && al != null ? Args(al, ctor) : new List<string>();
            var msgIdx = ctor?.Parameters.ToList().FindIndex(p => p.Type.SpecialType == SpecialType.System_String) ?? -1;
            var innerIdx = ctor?.Parameters.ToList().FindIndex(p => DerivesFrom(p.Type, "System.Exception")) ?? -1;
            var msg = msgIdx >= 0 && msgIdx < eargs.Count ? eargs[msgIdx] : "null";
            var inner = innerIdx >= 0 && innerIdx < eargs.Count ? eargs[innerIdx] : "null";
            return $"R.csException([{string.Join(", ", chain.Select(Js))}], {msg}, {inner}, {Js(Loc(e))})";
        }
        if (t.AllInterfaces.Any(i => i.Name == "ISerializable") && t.Name.EndsWith("Exception"))
            return $"new Error({Js(t.Name)})";
        // ui：同一次轉的類別（不是 UnityEngine.Object）→ R.newGen：建 { $type } 資料物件、補初始值、跑建構子
        if (Ui && GenMethods.ContainsKey(GN(t)) && !DerivesFrom(t, "UnityEngine.Object"))
        {
            var cargs = ctor != null && al != null ? Args(al, ctor) : new List<string>();
            var ctorName = ctor != null && !ctor.IsImplicitlyDeclared ? Js(CtorName(ctor)) : "null";
            // 工具包模式：泛型類別的實體記住型別引數（typeof(T)、Enum.GetValues(typeof(T)) 這類要在執行時知道 T）
            var made = Core && t.IsGenericType && t.TypeArguments.Length > 0
                ? $"R.newGenT({string.Join(", ", new[] { "c", Js(GN(t)), "[" + string.Join(", ", t.TypeArguments.Select(TypeRef)) + "]", ctorName }.Concat(cargs))})"
                : $"R.newGen({string.Join(", ", new[] { "c", Js(GN(t)), ctorName }.Concat(cargs))})";
            if (init != null && init.IsKind(SyntaxKind.ObjectInitializerExpression))
            {
                // 工具包模式：初始式裡有本體的屬性（IUnifiedContainer<T>.Result 的 set 還要寫 ObjectField）照 C# 叫 set_名字，照順序一個一個設
                if (Core && init.Expressions.Any(x => x is AssignmentExpressionSyntax { Left: IdentifierNameSyntax } xa
                    && M.GetSymbolInfo(xa.Left).Symbol is IPropertySymbol bp && GenProp(bp) && !AutoProp(bp)))
                {
                    var sets = new List<string>();
                    foreach (var x in init.Expressions)
                    {
                        if (x is not AssignmentExpressionSyntax sa || sa.Left is not IdentifierNameSyntax sln) return NotPorted(e, null);
                        sets.Add(M.GetSymbolInfo(sa.Left).Symbol is IPropertySymbol sp && GenProp(sp) && !AutoProp(sp)
                            ? PropSet(sp, "__o", E(sa.Right))
                            : $"__o.{sln.Identifier.Text} = {E(sa.Right)}");
                    }
                    return $"((__o: any) => {{ {string.Join("; ", sets)}; return __o; }})({made})";
                }
                var gprops = new List<string>();
                foreach (var x in init.Expressions)
                {
                    if (x is AssignmentExpressionSyntax ga && ga.Left is IdentifierNameSyntax gln) gprops.Add($"{gln.Identifier.Text}: {E(ga.Right)}");
                    else return NotPorted(e, null);
                }
                return $"Object.assign({made}, {{ {string.Join(", ", gprops)} }})";
            }
            return made;
        }
        var args = ctor != null && al != null ? Args(al, ctor) : new List<string>();
        var newKey = $"new_{TK(t)}{(ctor != null ? Ovl(ctor) : "")}";
        // 工具包模式：外部型別（DLL）相容層沒有建構子：R.newExternal（執行環境有登記的工廠就用，沒有就是帶 $type 的一般物件），初始式照樣蓋上
        var call = Core && !RT.Contains(newKey) && t.DeclaringSyntaxReferences.Length == 0 && t.TypeKind is TypeKind.Class or TypeKind.Struct
            ? $"R.newExternal({string.Join(", ", new[] { "c", Js(TK(t)) }.Concat(args))})"
            : Rt(newKey, args, e);
        // ui：索引初始化（new PropDescriptions { [k] = v }）：每個元素照 C# 叫索引子的 set（相容層 <型別>_set_Item，同 dict[key] = value）
        if (Ui && init != null && init.IsKind(SyntaxKind.ObjectInitializerExpression) && init.Expressions.Count > 0
            && init.Expressions.All(x => x is AssignmentExpressionSyntax { Left: ImplicitElementAccessSyntax } xa && xa.IsKind(SyntaxKind.SimpleAssignmentExpression)))
        {
            var sets = init.Expressions.Cast<AssignmentExpressionSyntax>().Select(x => Rt($"{TK(t)}_set_Item",
                new[] { "__d" }.Concat(((ImplicitElementAccessSyntax)x.Left).ArgumentList.Arguments.Select(y => E(y.Expression))).Append(CopyIfStruct(x.Right, M.GetTypeInfo(x.Left).Type)), x)).ToList();
            return $"((__d: any) => {{ {string.Join("; ", sets)}; return __d; }})({call})";
        }
        if (init != null && init.IsKind(SyntaxKind.ObjectInitializerExpression))
        {
            var props = new List<string>();
            foreach (var x in init.Expressions)
            {
                if (x is AssignmentExpressionSyntax a && a.Left is IdentifierNameSyntax ln) props.Add($"{ln.Identifier.Text}: {E(a.Right)}");
                else return NotPorted(e, null);
            }
            return $"Object.assign({call}, {{ {string.Join(", ", props)} }})";
        }
        // ui：集合初始化（new Dictionary<string, string> { { "Chance", s } }）：每個元素照 C# 叫 Add（相容層 <型別>_Add）
        if (Ui && init != null && init.IsKind(SyntaxKind.CollectionInitializerExpression))
        {
            var adds = new List<string>();
            foreach (var x in init.Expressions)
            {
                var addArgs = x is InitializerExpressionSyntax ce && ce.IsKind(SyntaxKind.ComplexElementInitializerExpression) ? ce.Expressions.Select(E).ToArray() : new[] { E(x) };
                adds.Add(Rt($"{TK(t)}_Add", new[] { "d" }.Concat(addArgs), x));
            }
            return $"((d: any) => {{ {string.Join("; ", adds)}; return d; }})({call})";
        }
        if (init != null) return NotPorted(e, null);
        return call;
    }

    static string Op(SyntaxKind k) => k switch
    {
        SyntaxKind.AddExpression => "+", SyntaxKind.SubtractExpression => "-", SyntaxKind.MultiplyExpression => "*",
        SyntaxKind.DivideExpression => "/", SyntaxKind.ModuloExpression => "%",
        SyntaxKind.LogicalAndExpression => "&&", SyntaxKind.LogicalOrExpression => "||",
        SyntaxKind.EqualsExpression => "===", SyntaxKind.NotEqualsExpression => "!==",
        SyntaxKind.LessThanExpression => "<", SyntaxKind.LessThanOrEqualExpression => "<=",
        SyntaxKind.GreaterThanExpression => ">", SyntaxKind.GreaterThanOrEqualExpression => ">=",
        SyntaxKind.BitwiseAndExpression => "&", SyntaxKind.BitwiseOrExpression => "|", SyntaxKind.ExclusiveOrExpression => "^",
        SyntaxKind.LeftShiftExpression => "<<", SyntaxKind.RightShiftExpression => ">>",
        SyntaxKind.CoalesceExpression => "??",
        _ => null,
    };

    /// enum 值 → 成員名字（值 → 名字表）：明確的 ToString()，以及字串相加、字串插值裡隱含的 ToString()
    string EnumName(INamedTypeSymbol et, string js)
    {
        var pairs = et.GetMembers().OfType<IFieldSymbol>().Where(f => f.HasConstantValue).Select(f => $"{EnumKey(f.ConstantValue)}: {Js(f.Name)}");
        return $"(({{ {string.Join(", ", pairs)} }}) as Record<number, string>)[{js}]";
    }

    /// C# 把 enum 放進字串（"TheOneDice" + diceType、$"{diceType}"）時呼叫的是 ToString()，得到名字；JS 直接相加會得到數字
    /// 工具包模式：其他不是字串、數字、字元的值（bool、物件、結構、泛型 T、Nullable）也照 C# 的 ToString（R.Object_ToString：
    /// True／False、null 是空字串、產生類別覆寫的 ToString）；JS 直接相加會得到 true、null、[object Object]。
    /// 有格式（{x:D2}）的插值交給 csFormat，不先轉字串
    string InString(ExpressionSyntax e, string js, bool formatted = false)
    {
        var t = M.GetTypeInfo(e).Type;
        if (t is INamedTypeSymbol { TypeKind: TypeKind.Enum } et) return EnumName(et, js);
        if (Core && !formatted && t != null && NeedsToString(t)) return Rt("Object_ToString", new[] { js }, e);
        return js;
    }
    bool IsEnumExpr(ExpressionSyntax e) => M.GetTypeInfo(e).Type is INamedTypeSymbol { TypeKind: TypeKind.Enum };
    /// 運算式本身的值，不套 E 的隱含轉換（裝箱、使用者定義的轉型）
    string Unboxed(ExpressionSyntax e) => boundRecv.TryGetValue(e, out var br) ? br : E0(e);
    /// 相等要照 C# 的語意（不是 JS 的 ===）：數字、字串、bool、char、列舉以外的元素
    static bool NeedsCsEquality(ITypeSymbol t) => t.TypeKind != TypeKind.Enum && t.SpecialType is not (SpecialType.System_String or SpecialType.System_Boolean or SpecialType.System_Char
        or SpecialType.System_SByte or SpecialType.System_Byte or SpecialType.System_Int16 or SpecialType.System_UInt16 or SpecialType.System_Int32 or SpecialType.System_UInt32
        or SpecialType.System_Int64 or SpecialType.System_UInt64 or SpecialType.System_Single or SpecialType.System_Double or SpecialType.System_Decimal);
    static bool NeedsToString(ITypeSymbol t) => t.SpecialType switch
    {
        SpecialType.System_String or SpecialType.System_Char or SpecialType.System_SByte or SpecialType.System_Byte
            or SpecialType.System_Int16 or SpecialType.System_UInt16 or SpecialType.System_Int32 or SpecialType.System_UInt32
            or SpecialType.System_Int64 or SpecialType.System_UInt64 or SpecialType.System_Single or SpecialType.System_Double
            or SpecialType.System_Decimal => false,
        SpecialType.System_Boolean => true,
        _ => t.TypeKind is TypeKind.Class or TypeKind.Struct or TypeKind.Interface or TypeKind.TypeParameter,
    };

    string Binary(BinaryExpressionSyntax be)
    {
        // 工具包模式：x as T：型別不符是 null（Ink 的 Json 靠它分辨容器、分歧點…）
        if (be.IsKind(SyntaxKind.AsExpression))
            return Core && M.GetTypeInfo(be.Right).Type is ITypeSymbol ast && ast.SpecialType != SpecialType.System_Object
                ? $"R.asType(c, {E(be.Left)}, {TypeRef(ast)})" : E(be.Left);
        if (be.IsKind(SyntaxKind.IsExpression)) return IsType(M.GetTypeInfo(be.Right).Type, E(be.Left), be);
        var op = Op(be.Kind());
        if (op == null) return NotPorted(be, null);
        var l = E(be.Left);
        var r = E(be.Right);
        if (op == "+" && M.GetTypeInfo(be).Type?.SpecialType == SpecialType.System_String)
        {
            // 列舉運算元：C# 綁成 string + object，Roslyn 報裝箱，E 會包成 R.boxEnum；查名字表要用裝箱前的值，
            // 不然是拿裝箱物件當 key，得到 undefined（"Enum_DialogueSpeed_" + dialogueSpeed 變成 Enum_DialogueSpeed_undefined）
            l = InString(be.Left, IsEnumExpr(be.Left) ? Unboxed(be.Left) : l);
            r = InString(be.Right, IsEnumExpr(be.Right) ? Unboxed(be.Right) : r);
        }
        // ui：運算子多載（Vector3 − Vector3、float × Vector2…）→ 相容層；UnityEngine.Object 的 == != 照 JS 的鬆散比較（null 與 undefined 同）
        if (Ui && M.GetSymbolInfo(be).Symbol is IMethodSymbol { MethodKind: MethodKind.UserDefinedOperator } uop)
        {
            // 工具包模式：R.objEq（已銷毀的物件等於 null；資產參照照 guid 比）
            if (uop.ContainingType.ToDisplayString() == "UnityEngine.Object" && op is "===" or "!==")
                return Core ? $"{(op == "===" ? "" : "!")}R.objEq({l}, {r})" : $"{l} {(op == "===" ? "==" : "!=")} {r}";
            return GenOperatorCall(uop, new[] { l, r }) ?? Rt($"{TK(uop.ContainingType)}_{uop.Name}{Ovl(uop)}", new[] { l, r }, be);
        }
        if (op is "===" or "!==" && (be.Left.IsKind(SyntaxKind.NullLiteralExpression) || be.Right.IsKind(SyntaxKind.NullLiteralExpression)))
            op = op == "===" ? "==" : "!=";
        if (op == "/" && IsIntegral(M.GetTypeInfo(be).Type)) return $"Math.trunc({l} / {r})";
        // ui：uint 的運算照 C# 的 32 位元無號溢位（MT2 MurmurHash2）
        if (Ui && IsU32(M.GetTypeInfo(be).Type) && op is "*" or "+" or "-" or "^" or "|" or "&" or "<<" or ">>") return U32(op, l, r);
        // C# 的 bool & | ^ 兩邊都會求值（不短路）
        if (op is "&" or "|" or "^" && M.GetTypeInfo(be).Type?.SpecialType == SpecialType.System_Boolean)
            return $"Boolean(+({l}) {op} +({r}))";
        return $"{l} {op} {r}";
    }

    /// 相容層帶工具包的 csport/core（export __cs2ts_core）：用工具包的寫法（staticInit、同類別別的實體走 callGen…）；
    /// diceomancer-web 的相容層沒有，產生檔照舊
    bool Core => Ui && RT.Contains("__cs2ts_core");

    /// 產生類別的識別名：工具包模式（ArityNames）下泛型類別帶型別參數個數（Signal<T, U> → "Signal$2"），
    /// 跟同名的非泛型類別分開；巢狀類別前面接外層的識別名（ScreenManager.ScreenScene → "ScreenManager_ScreenScene"，
    /// 跟相容層 key 的 TK 同一個規則；MT2 有 13 個巢狀的 Data）。其他照類別名（diceomancer-web 的產生檔不變）
    public static bool ArityNames;
    /// cs2ts.json 目標的 loopGuard（Config.Target.LoopGuard 的說明）
    public static bool LoopGuard;
    int loopSeq;
    /// 迴圈保護：迴圈前宣告計數器，回傳迴圈本體第一行要加的檢查（沒開回 null）
    string LoopGuardOpen(SyntaxNode loop, StringBuilder sb, string I)
    {
        if (!LoopGuard) return null;
        var g = $"__lg{++loopSeq}";
        sb.AppendLine($"{I}let {g} = 0;");
        return $"{I}  if (++{g} > 10000000) R.loopRunaway(\"{Loc(loop)}\");";
    }
    /// 原始碼裡不只一個的頂層產生名（不同 namespace 的同名類別，例如 DOTween 與 Ink 的 Path）：有 namespace 的那幾個加上 namespace
    public static HashSet<string> DuplicateNames = new();
    public static string GN(ITypeSymbol t)
    {
        if (!ArityNames || t is not INamedTypeSymbol nt) return t?.Name;
        var own = nt.Arity > 0 ? $"{nt.Name}${nt.Arity}" : nt.Name;
        if (nt.ContainingType != null) return $"{GN(nt.ContainingType)}_{own}";
        var ns = nt.ContainingNamespace?.IsGlobalNamespace == false ? nt.ContainingNamespace.ToDisplayString() : "";
        if (ns != "" && nt.DeclaringSyntaxReferences.Length > 0 && DuplicateNames.Contains(own)) return $"{ns.Replace('.', '_')}_{own}";
        return own;
    }

    /// 使用者定義的運算子與轉型（op_Implicit、op_Addition…）的產生名：名字 $ 參數型別（同名多載一定有，乾脆都帶）
    static string OpName(IMethodSymbol m)
    {
        var n = $"{m.Name}$" + string.Join("_", m.Parameters.Select(p => ShortTK(p.Type)));
        // 轉型運算子只差目標型別（Timeline 的 DiscreteTime 轉 double／float／long）：再帶目標型別，不然同名（JS 裡重複宣告是語法錯誤）
        if (m.MethodKind == MethodKind.Conversion
            && m.ContainingType.GetMembers(m.Name).OfType<IMethodSymbol>().Count(x => x.MethodKind == MethodKind.Conversion && SameParams(x, m)) > 1)
            n += "$" + ShortTK(m.ReturnType);
        return n;
    }
    /// 工具包模式：運算子屬於這次一起轉的類別 → R.callStatic 叫產生的版本；否則 null（照舊走相容層）。
    /// 名字照宣告（OriginalDefinition）取：泛型類別 WeakRef<T> 的 op_Implicit(T) 在呼叫端是 WeakRef<CharacterState>.op_Implicit(CharacterState)，產生的是 op_Implicit$T
    string GenOperatorCall(IMethodSymbol op, IEnumerable<string> args) =>
        Core && GenMethods.ContainsKey(GN(op.ContainingType)) ? $"R.callStatic({string.Join(", ", new[] { "c", Js(GN(op.ContainingType)), Js(OpName(op.OriginalDefinition)) }.Concat(args))})" : null;

    /// 列舉值裝箱（R.boxEnum）：型別名與成員名表跟著值走
    string BoxEnum(INamedTypeSymbol et, string v)
    {
        var pairs = et.GetMembers().OfType<IFieldSymbol>().Where(f => f.HasConstantValue).Select(f => $"{EnumKey(f.ConstantValue)}: {Js(f.Name)}");
        return $"R.boxEnum({v}, {Js(GN(et))}, {{ {string.Join(", ", pairs)} }})";
    }
    /// 列舉名表的 key：負數不是合法的物件字面值 key，寫成字串（"-1": "None"）；JS 的數字 key 本來就轉成字串，查表結果一樣
    static string EnumKey(object v)
    {
        var s = Convert.ToString(v, System.Globalization.CultureInfo.InvariantCulture);
        return s.StartsWith('-') ? Js(s) : s;
    }

    static bool IsU32(ITypeSymbol t) => t?.SpecialType == SpecialType.System_UInt32;
    /// uint 的二元運算：結果截成 32 位元無號；乘法用 Math.imul（JS 的 * 超過 2^53 會失去精度）
    static string U32(string op, string l, string r) => op switch
    {
        "*" => $"(Math.imul({l}, {r}) >>> 0)",
        ">>" => $"({l} >>> {r})",
        _ => $"(({l} {op} {r}) >>> 0)",
    };

    string Prefix(PrefixUnaryExpressionSyntax pu)
    {
        switch (pu.Kind())
        {
            case SyntaxKind.LogicalNotExpression: return $"!{E(pu.Operand)}";
            case SyntaxKind.UnaryMinusExpression:
                if (Ui && M.GetSymbolInfo(pu).Symbol is IMethodSymbol { MethodKind: MethodKind.UserDefinedOperator } nop)
                    return Rt($"{TK(nop.ContainingType)}_{nop.Name}{Ovl(nop)}", new[] { E(pu.Operand) }, pu);
                return $"-{E(pu.Operand)}";
            case SyntaxKind.UnaryPlusExpression: return E(pu.Operand);
            case SyntaxKind.BitwiseNotExpression: return Ui && IsU32(M.GetTypeInfo(pu).Type) ? $"(~{E(pu.Operand)} >>> 0)" : $"~{E(pu.Operand)}";
            case SyntaxKind.PreIncrementExpression: return IncDec(pu.Operand, pu, "++", "");
            case SyntaxKind.PreDecrementExpression: return IncDec(pu.Operand, pu, "--", "");
            default: return NotPorted(pu, null);
        }
    }

    string Postfix(PostfixUnaryExpressionSyntax po)
    {
        switch (po.Kind())
        {
            case SyntaxKind.PostIncrementExpression: return IncDec(po.Operand, po, "", "++");
            case SyntaxKind.PostDecrementExpression: return IncDec(po.Operand, po, "", "--");
            case SyntaxKind.SuppressNullableWarningExpression: return E(po.Operand);
            default: return NotPorted(po, null);
        }
    }

    /// 陣列／List 的元素 a[i]。工具包模式：從尾端算的索引 a[^n] → a[a.length - n]（對象不是區域變數就先存暫存變數，只求值一次）
    string CollectionIndex(ElementAccessExpressionSyntax ea)
    {
        var arg = ea.ArgumentList.Arguments[0].Expression;
        if (Core && arg is PrefixUnaryExpressionSyntax hat && hat.IsKind(SyntaxKind.IndexExpression))
        {
            var recv = E(ea.Expression);
            if (M.GetSymbolInfo(ea.Expression).Symbol is ILocalSymbol or IParameterSymbol && ea.Expression is IdentifierNameSyntax && !recv.Contains('['))
                return $"{recv}[{recv}.length - {E(hat.Operand)}]";
            var t = $"__ix{++tmp}";
            hoist.Add(t);
            return $"({t} = {recv})[{t}.length - {E(hat.Operand)}]";
        }
        return $"{E(ea.Expression)}[{E(arg)}]";
    }

    /// 可直接賦值的左值（區域變數、自己的欄位、直接資料型別的欄位、陣列元素）；其他回 null
    string LValueOrNull(ExpressionSyntax e)
    {
        var sym = M.GetSymbolInfo(e).Symbol;
        switch (e)
        {
            case IdentifierNameSyntax:
                if (Ui && sym is IParameterSymbol { RefKind: RefKind.Ref } rp) return $"{Id(rp.Name)}.v";
                if (sym is IParameterSymbol op && OutBoxed(op)) return $"{Id(op.Name)}.v";
                if (sym is ILocalSymbol && refLocals.TryGetValue(sym, out var rlv)) return rlv;
                if (sym is ILocalSymbol or IParameterSymbol) return Id(sym.Name);
                if (sym is IFieldSymbol f && Same(f.ContainingType, T)) return OwnField(f, e);
                if (sym is IFieldSymbol fi && InheritedGenField(fi)) return $"c.ai.{fi.Name}";
                if (sym is IPropertySymbol pi && GenProp(pi) && AutoProp(pi) && !pi.IsStatic && DerivesFromSym(T, pi.ContainingType)) return $"c.ai.{pi.Name}";
                return null;
            case MemberAccessExpressionSyntax ma:
                if ((ma.Expression is ThisExpressionSyntax) && sym is IFieldSymbol f2 && Same(f2.ContainingType, T)) return OwnField(f2, e);
                if (ma.Expression is ThisExpressionSyntax or BaseExpressionSyntax && sym is IFieldSymbol f4 && InheritedGenField(f4)) return $"c.ai.{f4.Name}";
                if (ma.Expression is ThisExpressionSyntax or BaseExpressionSyntax && sym is IPropertySymbol p4 && GenProp(p4) && AutoProp(p4) && !p4.IsStatic) return $"c.ai.{p4.Name}";
                // 工具包模式：靜態欄位不是「對象.欄位」（對象是型別名）：同批轉的類別走 genStatic，其他走相容層（Assign 的一般路徑）
                if (sym is IFieldSymbol f3 && Direct(f3.ContainingType) && !(Core && f3.IsStatic)) return $"{E(ma.Expression)}.{ma.Name.Identifier.Text}";
                return null;
            case ElementAccessExpressionSyntax ea:
                if (IsCollection(M.GetTypeInfo(ea.Expression).Type)) return CollectionIndex(ea);
                return null;
            case ParenthesizedExpressionSyntax p:
                return LValueOrNull(p.Expression);
        }
        return null;
    }

    /// ++／-- 的運算元：轉不動就把整個運算式換成 notPorted（不能寫成 notPorted(...)++）
    string IncDec(ExpressionSyntax operand, SyntaxNode at, string pre, string post)
    {
        var lv = LValueOrNull(operand);
        // 工具包模式：語句位置（值沒人用）的數字 x++／x--，x 是屬性、索引子、別的物件的欄位：照 x += 1 的 get／set 寫回
        if (lv == null && Core && (at.Parent is ExpressionStatementSyntax || at.Parent is ForStatementSyntax fst && fst.Incrementors.Contains(at))
            && M.GetTypeInfo(operand).Type is ITypeSymbol ot && (IsIntegral(ot) || IsFloat(ot)))
            return AssignTo(operand, (pre + post) == "++" ? "+=" : "-=", null, "1", at);
        if (lv == null) return NotPorted(at, $"左值 {Snip(operand)}");
        return $"{pre}{lv}{post}";
    }

    string Assign(AssignmentExpressionSyntax a)
    {
        string op = a.Kind() switch
        {
            SyntaxKind.SimpleAssignmentExpression => "=",
            SyntaxKind.AddAssignmentExpression => "+=", SyntaxKind.SubtractAssignmentExpression => "-=",
            SyntaxKind.MultiplyAssignmentExpression => "*=", SyntaxKind.DivideAssignmentExpression => "/=",
            SyntaxKind.ModuloAssignmentExpression => "%=", SyntaxKind.CoalesceAssignmentExpression => "??=",
            SyntaxKind.OrAssignmentExpression => "|=", SyntaxKind.AndAssignmentExpression => "&=",
            SyntaxKind.ExclusiveOrAssignmentExpression when Ui => "^=",
            SyntaxKind.LeftShiftAssignmentExpression when Ui => "<<=", SyntaxKind.RightShiftAssignmentExpression when Ui => ">>=",
            _ => null,
        };
        if (op == null) return NotPorted(a, null);
        // 工具包模式：指定當運算式用（List<T> list = (dict[key] = GenericPools.GetList()))，左邊又要走相容層的 setter（set_Item、屬性）：
        // setter 沒有回傳值，右邊先存暫存變數，寫完回它（C# 指定運算式的值是右邊）
        if (Core && op == "=" && !StatementLevel(a) && LValueOrNull(a.Left) == null && M.GetSymbolInfo(a.Left).Symbol is not IEventSymbol)
        {
            var tv = $"__as{++tmp}";
            hoist.Add(tv);
            return $"({tv} = {CopyIfStruct(a.Right, M.GetTypeInfo(a.Left).Type)}, {AssignTo(a.Left, op, null, tv, a)}, {tv})";
        }
        return AssignTo(a.Left, op, a.Right, null, a);
    }

    /// 運算式的值沒人用（單獨一個語句、for 的遞增部分；外面包括號也算）
    static bool StatementLevel(ExpressionSyntax e)
    {
        SyntaxNode p = e.Parent;
        while (p is ParenthesizedExpressionSyntax) p = p.Parent;
        return p is ExpressionStatementSyntax || p is ForStatementSyntax;
    }

    /// 指定（= 與複合指定）的本體：right 是右邊的運算式；沒有運算式時（語句位置的 x++／x--）用 rightJs
    string AssignTo(ExpressionSyntax left, string op, ExpressionSyntax right, string rightJs, SyntaxNode at)
    {
        var lv = LValueOrNull(left);
        var lt = M.GetTypeInfo(left).Type;
        string Rhs() => right != null ? E(right) : rightJs;
        string RhsCopy() => right != null ? CopyIfStruct(right, lt) : rightJs;
        // ui：複合指定的運算子多載（localPosition += Vector3.left * scale）：左邊是屬性或別的類別的欄位時也要走運算子的相容層，不能寫成 JS 的 +
        var uop = Ui && op is "+=" or "-=" or "*=" or "/=" && (at is AssignmentExpressionSyntax ? M.GetSymbolInfo(at).Symbol : null) is IMethodSymbol { MethodKind: MethodKind.UserDefinedOperator } cop ? cop : null;
        string Comb(string get, string r) => uop != null ? Rt($"{TK(uop.ContainingType)}_{uop.Name}{Ovl(uop)}", new[] { get, r }, at) : $"{get} {op.TrimEnd('=')} {r}";
        // 工具包模式：宣告事件的類別裡把 field-like event 當委派欄位指定（Signal 的 Listener = AddUnique(Listener, callback)）：
        // 跟 += −= 與讀取（eventGet）同一張表，存成那個委派的呼叫清單
        if (Core && op == "=" && M.GetSymbolInfo(left).Symbol is IEventSymbol sev)
        {
            string srecv = sev.IsStatic ? "null" : left is MemberAccessExpressionSyntax sem && sem.Expression is not ThisExpressionSyntax ? E(sem.Expression) : "c.self";
            return Rt("eventSet", new[] { Js($"{TK(sev.ContainingType)}.{sev.Name}"), srecv, Rhs() }, at);
        }
        // ui：事件的 += −=（GameManager.Instance.RefreshTickEvent += RefreshStateByTick）
        if (Ui && M.GetSymbolInfo(left).Symbol is IEventSymbol ev && op is "+=" or "-=")
        {
            string erecv = ev.IsStatic ? "null" : left is MemberAccessExpressionSyntax em ? (IsSingleton(em.Expression) ? "null" : E(em.Expression)) : "c.self";
            return Rt(op == "+=" ? "eventAdd" : "eventRemove", new[] { Js($"{TK(ev.ContainingType)}.{ev.Name}"), erecv, Rhs() }, at);
        }
        // ui：複合指定的運算子多載（pos += offset）
        if (Ui && op is "+=" or "-=" or "*=" or "/=" && (at is AssignmentExpressionSyntax ? M.GetSymbolInfo(at).Symbol : null) is IMethodSymbol { MethodKind: MethodKind.UserDefinedOperator } aop && lv != null)
            return $"{lv} = {Rt($"{TK(aop.ContainingType)}_{aop.Name}{Ovl(aop)}", new[] { lv, Rhs() }, at)}";
        if (lv != null)
        {
            var rhs = op == "=" ? RhsCopy() : Rhs();
            if (op == "/=" && IsIntegral(lt)) return $"{lv} = Math.trunc({lv} / {rhs})";
            if (Ui && IsU32(lt) && op is "*=" or "+=" or "-=" or "^=" or "|=" or "&=" or "<<=" or ">>=") return $"{lv} = {U32(op.TrimEnd('='), lv, rhs)}";
            if (op is "|=" or "&=" && lt?.SpecialType == SpecialType.System_Boolean) return op == "|=" ? $"{lv} = {lv} || {rhs}" : $"{lv} = {lv} && {rhs}";
            return $"{lv} {op} {rhs}";
        }
        if (left is ElementAccessExpressionSyntax gsea && op == "=" && GenIndexer(gsea, RhsCopy()) is string gset) return gset;
        // ui：其他型別的索引子寫入（Dictionary[key] = value）→ 相容層 <型別>_set_Item；結構的值照 C# 複製一份
        if (Ui && left is ElementAccessExpressionSyntax sea && op == "=" && M.GetTypeInfo(sea.Expression).Type is ITypeSymbol sit && !IsCollection(sit))
            return Rt($"{TK(sit)}_set_Item", new[] { E(sea.Expression) }.Concat(sea.ArgumentList.Arguments.Select(x => E(x.Expression))).Append(RhsCopy()), at);
        // ui：其他型別的索引子複合指定（dict[key] += v）：對象與索引先存暫存變數（只求值一次），get_Item 讀出、算完 set_Item 寫回
        if (Ui && left is ElementAccessExpressionSyntax cea && op is not ("=" or "??=") && M.GetTypeInfo(cea.Expression).Type is ITypeSymbol cit && !IsCollection(cit))
        {
            var rv = $"__ix{++tmp}";
            hoist.Add(rv);
            var keys = new List<string>();
            var keyVals = new List<string>();
            foreach (var arg in cea.ArgumentList.Arguments)
            {
                var kv = $"__ix{++tmp}";
                hoist.Add(kv);
                keys.Add(kv);
                keyVals.Add($"({kv} = {E(arg.Expression)})");
            }
            var recvVal = $"({rv} = {E(cea.Expression)})";
            var get = Rt($"{TK(cit)}_get_Item", new[] { rv }.Concat(keys), at);
            return Rt($"{TK(cit)}_set_Item", new[] { recvVal }.Concat(keyVals).Append(Comb(get, Rhs())), at);
        }
        // 其他型別的屬性／欄位：相容層 setter
        var sym = M.GetSymbolInfo(left).Symbol;
        // ui：產生類別的屬性
        if (Ui && sym is IPropertySymbol asp && GenProp(asp) && left is MemberAccessExpressionSyntax or IdentifierNameSyntax)
        {
            string precv = asp.IsStatic || left is IdentifierNameSyntax || left is MemberAccessExpressionSyntax { Expression: ThisExpressionSyntax or BaseExpressionSyntax } ? null : E(((MemberAccessExpressionSyntax)left).Expression);
            var prhs = Rhs();
            var pbase = left is MemberAccessExpressionSyntax { Expression: BaseExpressionSyntax };
            if (op != "=") prhs = Comb(PropGet(asp, precv, pbase), prhs);
            if (PropSet(asp, precv, prhs, pbase) is string pset) return pset;
        }
        // 工具包模式：巢狀類別不帶類別名直接寫外層（同批轉的別的類別）的靜態欄位（GameStateManager.FtueSequenceActive 的 IsFtueSequenceActive = true）：
        // 讀的時候走 R.genStatic，寫也要走 R.genStaticSet
        if (Core && left is IdentifierNameSyntax && sym is IFieldSymbol ifs && ifs.IsStatic && !ifs.IsConst && !Same(ifs.ContainingType, T) && GenMethods.ContainsKey(GN(ifs.ContainingType)))
        {
            var irhs = Rhs();
            if (op != "=") irhs = Comb($"R.genStatic(c, {Js(GN(ifs.ContainingType))}, {Js(ifs.Name)})", irhs);
            return $"R.genStaticSet(c, {Js(GN(ifs.ContainingType))}, {Js(ifs.Name)}, {irhs})";
        }
        if (left is MemberAccessExpressionSyntax ma && sym is IPropertySymbol or IFieldSymbol)
        {
            var ct = sym.ContainingType;
            var name = ma.Name.Identifier.Text;
            // ui：同一次轉的類別的欄位（TutorialManager.Instance.currentCardBase = …）：靜態走 R.genStaticSet，實體走 R.mbSet（對象照樣求值）
            if (Ui && sym is IFieldSymbol gfs && DerivesFrom(ct, "UnityEngine.Component") && (Same(ct, T) || GenMethods.ContainsKey(GN(ct))) && !RT.Contains($"{TK(ct)}_set_{name}"))
            {
                var grhs = Rhs();
                if (gfs.IsStatic)
                {
                    if (Same(ct, T)) return $"{OwnField(gfs, ma)} {op} {grhs}";
                    if (op != "=") grhs = Comb($"R.genStatic(c, {Js(GN(ct))}, {Js(name)})", grhs);
                    return $"R.genStaticSet(c, {Js(GN(ct))}, {Js(name)}, {grhs})";
                }
                var grecv = ma.Expression is ThisExpressionSyntax ? "c.self" : E(ma.Expression);
                if (op != "=") grhs = Comb($"R.mbGet(c, {grecv}, {Js(name)})", grhs);
                return $"R.mbSet(c, {grecv}, {Js(name)}, {grhs})";
            }
            // 工具包模式：自己的靜態欄位寫成 類別.名字（DOTween.useSafeMode = …，參數同名時常見）：模組變數
            if (Core && sym is IFieldSymbol ofs && ofs.IsStatic && !ofs.IsConst && Same(ct, T))
                return $"{OwnField(ofs, ma)} {op} {Rhs()}";
            // 工具包模式：同批轉的別的類別的靜態欄位（不是元件也一樣）：R.genStaticSet
            if (Core && sym is IFieldSymbol sfs && sfs.IsStatic && !Same(ct, T) && GenMethods.ContainsKey(GN(ct)))
            {
                var srhs = Rhs();
                if (op != "=") srhs = Comb($"R.genStatic(c, {Js(GN(ct))}, {Js(name)})", srhs);
                return $"R.genStaticSet(c, {Js(GN(ct))}, {Js(name)}, {srhs})";
            }
            string recv = sym.IsStatic || IsSingleton(ma.Expression) ? null : (ma.Expression is ThisExpressionSyntax ? "c.self" : E(ma.Expression));
            var rhs = Rhs();
            if (UiComponentField(sym) && recv != null && !RT.Contains($"{TK(ct)}_set_{name}"))
            {
                if (op != "=") rhs = Comb($"R.mbGet(c, {recv}, {Js(name)})", rhs);
                return $"R.mbSet(c, {recv}, {Js(name)}, {rhs})";
            }
            if (op != "=")
            {
                var get = Rt($"{TK(ct)}_get_{name}", recv != null ? new[] { recv } : Array.Empty<string>(), at);
                rhs = Comb(get, rhs);
            }
            return Rt($"{TK(ct)}_set_{name}", (recv != null ? new[] { recv } : Array.Empty<string>()).Append(rhs), at);
        }
        if (left is IdentifierNameSyntax && sym is IPropertySymbol or IFieldSymbol && !Same(sym.ContainingType, T))
        {
            var rhs = Rhs();
            if (UiComponentField(sym) && !RT.Contains($"{TK(sym.ContainingType)}_set_{sym.Name}"))
            {
                if (op != "=") rhs = Comb($"R.mbGet(c, c.self, {Js(sym.Name)})", rhs);
                return $"R.mbSet(c, c.self, {Js(sym.Name)}, {rhs})";
            }
            if (op != "=") rhs = Comb(Rt($"{TK(sym.ContainingType)}_get_{sym.Name}", new[] { "c.self" }, at), rhs);
            return Rt($"{TK(sym.ContainingType)}_set_{sym.Name}", new[] { "c.self", rhs }, at);
        }
        if (left is IdentifierNameSyntax disc && disc.Identifier.Text == "_") return $"void ({Rhs()})";
        return NotPorted(at, null);
    }
}

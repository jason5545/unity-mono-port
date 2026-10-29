// .NET 宿主：跑 tools/ref/Scenario.cs → public/ref/rng-dotnet.json。
//   dotnet run --project tools/dotnet-ref
// 另外把原版 Assembly-CSharp.dll 裡的 MurmurHash2.Hash 用反射叫一次，跟這裡從原始碼編的比，確定反編譯碼沒走樣。
using System;
using System.IO;
using System.Linq;
using System.Reflection;

static class Program
{
    static int Main()
    {
        var here = AppContext.BaseDirectory;
        var root = Path.GetFullPath(Path.Combine(here, "../../../../.."));   // tools/dotnet-ref/bin/Debug/net10.0 → mt2-web
        // 原版 build（cs2ts.json 的 managed）：Windows 2.2.1
        var dll = Path.Combine(root, "reference/game-win-2.2.1/MonsterTrain2_Data/Managed/Assembly-CSharp.dll");

        var strs = new[] { "", "a", "ab", "abc", "abcd", "abcde", "merchant", "CardData_Torchmerchant", "測試中文", "The quick brown fox jumps over the lazy dog" };
        var orig = Assembly.LoadFrom(dll).GetType("MurmurHash2").GetMethod("Hash", new[] { typeof(string) });
        var same = strs.Count(s => (uint)orig.Invoke(null, new object[] { s }) == MurmurHash2.Hash(s));
        Console.WriteLine($"原版 DLL 的 MurmurHash2.Hash 對照原始碼編譯版：{same}/{strs.Length} 相同");
        if (same != strs.Length) return 1;

        var rows = Scenario.Run(s => $"{{\"s0\":{s.s0},\"s1\":{s.s1},\"s2\":{s.s2},\"s3\":{s.s3}}}");
        var outPath = Path.Combine(root, "public/ref/rng-dotnet.json");
        Directory.CreateDirectory(Path.GetDirectoryName(outPath));
        File.WriteAllText(outPath, Scenario.ToJson($".NET {Environment.Version}（UnityEngine.Random 用 UnityShim；MurmurHash2 對原版 DLL {same}/{strs.Length}）", rows));
        Console.WriteLine($"{rows.Count} 筆 → {outPath}");
        return 0;
    }
}

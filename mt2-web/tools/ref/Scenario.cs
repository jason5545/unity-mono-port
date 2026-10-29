// 亂數情境：原版反編譯的 HadesRNG、RandomState、RandomManager、MurmurHash2 跑一串固定操作，每一步記一筆（鍵、值）。
// 跟 src/rng-check.ts 一模一樣；兩個宿主都跑這一份：
//   tools/unity-ref（Unity 2022.3.62f2 batch mode，UnityEngine.Random 是真的）
//   tools/dotnet-ref（.NET 10，UnityEngine.Random 用 UnityShim.cs，驗轉換器）
using System;
using System.Collections.Generic;

public static class Scenario
{
    public static List<string[]> Run(Func<UnityEngine.Random.State, string> fmtState)
    {
        var rows = new List<string[]>();
        void Put(string k, string v) => rows.Add(new[] { k, v });
        void PutI(string k, long v) => Put(k, v.ToString());
        // float 用位元比對（不受十進位格式影響）
        void PutF(string k, float v) => Put(k, "f" + BitConverter.ToInt32(BitConverter.GetBytes(v), 0));
        void PutState(string k, UnityEngine.Random.State s) => Put(k, fmtState(s));

        foreach (var s in new[] { "", "a", "ab", "abc", "abcd", "abcde", "merchant", "CardData_Torchmerchant", "測試中文", "The quick brown fox jumps over the lazy dog" })
        {
            PutI($"murmur.Hash[{s}]", MurmurHash2.Hash(s));
            PutI($"murmur.GetMurmurHash[{s}]", s.GetMurmurHash());
        }

        foreach (var seed in new[] { 0, 1, 42, 123456789, -1, int.MaxValue, int.MinValue })
        {
            var rng = new HadesRNG(seed);
            PutState($"hades[{seed}].state0", rng.GetState());
            for (var i = 0; i < 8; i++) PutI($"hades[{seed}].int100[{i}]", rng.Range(0, 100));
            for (var i = 0; i < 3; i++) PutI($"hades[{seed}].intNeg[{i}]", rng.Range(-50, 50));
            PutI($"hades[{seed}].intDown", rng.Range(10, 3));
            PutI($"hades[{seed}].intSame", rng.Range(7, 7));
            PutI($"hades[{seed}].intBig", rng.Range(0, int.MaxValue));
            for (var i = 0; i < 4; i++) PutF($"hades[{seed}].f01[{i}]", rng.Range(0f, 1f));
            for (var i = 0; i < 3; i++) PutF($"hades[{seed}].fMix[{i}]", rng.Range(-2.5f, 7.25f));
            PutState($"hades[{seed}].state1", rng.GetState());
            rng.Reset(3);
            for (var i = 0; i < 3; i++) PutI($"hades[{seed}].afterReset[{i}]", rng.Range(0, 1000));
            var copy = new HadesRNG(rng);
            PutI($"hades[{seed}].copy", copy.Range(0, 1000));
            PutI($"hades[{seed}].orig", rng.Range(0, 1000));
        }

        // RandomManager 的靜態建構子已經 Init(new RandomState(0), null) 過一次
        var rs = new RandomState(777);
        PutI("manager.Init", RandomManager.Init(rs, null) ? 1 : 0);
        foreach (RngId id in Enum.GetValues(typeof(RngId)))
        {
            var st = rs.FindState(id);
            PutI($"manager.seed[{id}]", st == null ? -999 : st.rng.GetSeed());
        }
        foreach (RngId id in Enum.GetValues(typeof(RngId)))
            PutI($"manager.range[{id}]", RandomManager.Range(0, 1000000, id));
        RandomManager.AdvanceToNextNode();
        foreach (RngId id in Enum.GetValues(typeof(RngId)))
            PutI($"manager.afterAdvance[{id}]", RandomManager.Range(0, 1000000, id));
        RandomManager.ResetRng(RngId.Rewards, 2);
        PutI("manager.afterReset[Rewards]", RandomManager.Range(0, 100, RngId.Rewards));
        RandomManager.ResetRng(RngId.Battle, 2);
        PutI("manager.notResetable[Battle]", RandomManager.Range(0, 100, RngId.Battle));
        PutF("manager.float[CardDraw]", RandomManager.Range(0f, 10f, RngId.CardDraw));
        PutState("manager.state[Spawning]", RandomManager.GetState(RngId.Spawning));
        return rows;
    }

    public static string ToJson(string host, List<string[]> rows)
    {
        string Esc(string s) => s.Replace("\\", "\\\\").Replace("\"", "\\\"");
        var lines = new List<string>();
        foreach (var r in rows) lines.Add($"  [\"{Esc(r[0])}\", \"{Esc(r[1])}\"]");
        return "{\n \"host\": \"" + Esc(host) + "\",\n \"rows\": [\n" + string.Join(",\n", lines) + "\n ]\n}\n";
    }
}

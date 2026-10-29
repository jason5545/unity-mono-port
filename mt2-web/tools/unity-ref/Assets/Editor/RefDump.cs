// Unity 宿主：跑 tools/ref/Scenario.cs（unity-ref.sh 複製進 Assets/Mt2），UnityEngine.Random 是真的 → public/ref/rng-unity.json
using System.IO;
using UnityEditor;
using UnityEngine;

public static class RefDump
{
    public static void Run()
    {
        var args = System.Environment.GetCommandLineArgs();
        var outPath = args[System.Array.IndexOf(args, "-refOut") + 1];
        var rows = Scenario.Run(s => JsonUtility.ToJson(s));
        Directory.CreateDirectory(Path.GetDirectoryName(outPath));
        File.WriteAllText(outPath, Scenario.ToJson("Unity " + Application.unityVersion, rows));
        Debug.Log($"RefDump：{rows.Count} 筆 → {outPath}");
        EditorApplication.Exit(0);
    }
}

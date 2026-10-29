// 桌面宿主：開機、跑 N 格、印報告。
// 用法：host-desktop <patch 過的 Managed> <匯入器輸出 public/game> <原版 *_Data> [選項]
//   --frames N          跑幾格（預設 600；有視窗時 0 = 一直跑到關掉視窗）
//   --scene 名稱         直接載入這個場景（不走開機流程）
//   --gl                開視窗畫（GLFW，macOS 的 GL 4.1 core）
//   --hidden            視窗不顯示（截圖驗證用）
//   --size WxH          畫面大小（預設 1280x720）
//   --shot F:路徑        第 F 格截圖存成 PNG（可以多個）
//   --click F:X,Y       第 F 格在螢幕座標（左下原點，畫面像素）按一下滑鼠左鍵（可以多個）
//   --realtime          用真實時間推進（預設每格固定 1/60 秒）
//   --ts                log 每行前面加上程序開始後的秒數（量載入時間用）
//   --ctl 路徑           從這個 FIFO 一行一行讀指令，邊跑邊操作（座標左上原點、畫面像素，跟截圖一樣）：
//                       click X Y、down X Y、up X Y、move X Y、drag X1 Y1 X2 Y2 [格數]、key 名稱、scroll DY、shot 路徑、dump、find 名稱、raycast X Y、eval 組件|型別.成員…、hide 名稱、prof、quit
//                       （dump：下一格把繪製清單印進 log，同 --dump；find：名稱相同的 GameObject 的啟用狀態、RectTransform、元件；raycast：EventSystem.RaycastAll 在這一點的結果；prof：分段與每格時間從這格重算，quit 的報告只算之後的）
//                       每格固定 1/60 秒，照 60 fps 節流；指令做完印「[ctl] ok 指令」
using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Runtime.CompilerServices;
using System.Runtime.Loader;
using System.Text.Json;
using System.Threading;

static class Program
{
    static string managed;
    static int optimized, glFrom, windowNo;
    const int ProfileEvery = 10;
    static string profileMode = "auto";

    static int Main(string[] args)
    {
        managed = Path.GetFullPath(args[0]);
        // UnityEngine.*、遊戲的 DLL 從 patch 過的資料夾載入：一定要在碰到任何 UnityEngine 型別之前掛上
        AssemblyLoadContext.Default.Resolving += (ctx, name) =>
        {
            var p = Path.Combine(managed, name.Name + ".dll");
            return File.Exists(p) ? LoadOptimizable(ctx, p) : null;
        };
        return Run(args);
    }

    /// <summary>清除組件層級 DebuggableAttribute 的 DisableOptimizations，只改載入用的記憶體副本</summary>
    static Assembly LoadOptimizable(AssemblyLoadContext ctx, string file)
    {
        var bytes = File.ReadAllBytes(file);
        int at = DebuggableModesOffset(bytes);
        if (at < 0) return ctx.LoadFromAssemblyPath(file);
        int modes = BitConverter.ToInt32(bytes, at);
        const int Default = 0x1, EnableEditAndContinue = 0x4, DisableOptimizations = 0x100;
        if ((modes & DisableOptimizations) == 0) return ctx.LoadFromAssemblyPath(file);
        BitConverter.GetBytes(modes & ~(Default | EnableEditAndContinue | DisableOptimizations)).CopyTo(bytes, at);
        Interlocked.Increment(ref optimized);
        return ctx.LoadFromStream(new MemoryStream(bytes));
    }

    /// <summary>[assembly: Debuggable(DebuggingModes)] 的 DebuggingModes 位移；blob 共用或格式不同就不改</summary>
    static int DebuggableModesOffset(byte[] bytes)
    {
        using var pe = new System.Reflection.PortableExecutable.PEReader(new MemoryStream(bytes, false));
        if (!pe.HasMetadata) return -1;
        var md = System.Reflection.Metadata.PEReaderExtensions.GetMetadataReader(pe);
        if (!md.IsAssembly) return -1;
        foreach (var h in md.GetAssemblyDefinition().GetCustomAttributes())
        {
            var ca = md.GetCustomAttribute(h);
            if (ca.Constructor.Kind != System.Reflection.Metadata.HandleKind.MemberReference) continue;
            var mr = md.GetMemberReference((System.Reflection.Metadata.MemberReferenceHandle)ca.Constructor);
            if (mr.Parent.Kind != System.Reflection.Metadata.HandleKind.TypeReference) continue;
            if (md.GetString(md.GetTypeReference((System.Reflection.Metadata.TypeReferenceHandle)mr.Parent).Name) != "DebuggableAttribute") continue;
            var blob = md.GetBlobReader(ca.Value);
            if (blob.Length != 8) return -1;
            int users = 0;
            foreach (var other in md.CustomAttributes) if (md.GetCustomAttribute(other).Value == ca.Value) users++;
            if (users != 1) return -1;
            int heap = System.Reflection.Metadata.Ecma335.MetadataReaderExtensions.GetHeapMetadataOffset(md, System.Reflection.Metadata.Ecma335.HeapIndex.Blob);
            int start = pe.PEHeaders.MetadataStartOffset + heap + System.Reflection.Metadata.Ecma335.MetadataTokens.GetHeapOffset(ca.Value) + 1;
            return bytes[start] == 1 && bytes[start + 1] == 0 ? start + 2 : -1;
        }
        return -1;
    }

    sealed class Opts
    {
        public int Frames = 600;
        public string Scene;
        public bool Gl, Hidden, Realtime, Mute, Ts, Wide;
        public int W = 1280, H = 720;
        public readonly List<(int frame, string path)> Shots = new List<(int, string)>();
        public readonly List<(int frame, float x, float y)> Clicks = new List<(int, float, float)>();
        public string FontTest, Ctl;
        public readonly List<(int frame, UnityEngine.KeyCode key)> Keys = new List<(int, UnityEngine.KeyCode)>();
        public readonly List<int> Dumps = new List<int>();
    }

    static Opts Parse(string[] a)
    {
        var o = new Opts();
        for (int i = 3; i < a.Length; i++)
        {
            switch (a[i])
            {
                case "--frames": o.Frames = int.Parse(a[++i]); break;
                case "--scene": o.Scene = a[++i]; break;
                case "--gl": o.Gl = true; break;
                case "--hidden": o.Hidden = true; break;
                case "--mute": o.Mute = true; break;
                case "--realtime": o.Realtime = true; break;
                case "--ts": o.Ts = true; break;
                // 手機版面（Diceomancer 的寬版、介面縮放；Android 宿主預設開）：桌面上測用
                case "--wide": o.Wide = true; break;
                case "--dump": o.Dumps.Add(int.Parse(a[++i])); break;
                case "--size": { var s = a[++i].Split('x'); o.W = int.Parse(s[0]); o.H = int.Parse(s[1]); break; }
                case "--shot": { var s = a[++i]; int c = s.IndexOf(':'); o.Shots.Add((int.Parse(s[..c]), s[(c + 1)..])); break; }
                case "--font-test": o.FontTest = a[++i]; break;
                case "--ctl": o.Ctl = a[++i]; break;
                case "--key": { var s = a[++i]; int c = s.IndexOf(':'); o.Keys.Add((int.Parse(s[..c]), Enum.Parse<UnityEngine.KeyCode>(s[(c + 1)..], true))); break; }
                case "--click": { var s = a[++i]; int c = s.IndexOf(':'); var xy = s[(c + 1)..].Split(','); o.Clicks.Add((int.Parse(s[..c]), float.Parse(xy[0]), float.Parse(xy[1]))); break; }
            }
        }
        return o;
    }

    [MethodImpl(MethodImplOptions.NoInlining)]
    static int Run(string[] args)
    {
        var game = Path.GetFullPath(args[1]);
        var data = Path.GetFullPath(args[2]);
        var o = Parse(args);

        UnityNative.SerialFields.LoadEngineNonPublic(Path.Combine(managed, "nonpublic-fields.txt"));
        var list = JsonDocument.Parse(File.ReadAllText(Path.Combine(data, "ScriptingAssemblies.json"))).RootElement.GetProperty("names");
        foreach (var n in list.EnumerateArray())
        {
            var name = Path.GetFileNameWithoutExtension(n.GetString());
            if (name == "mscorlib" || name == "netstandard" || name.StartsWith("System") || name.StartsWith("Mono.") || name == "Microsoft.Bcl.AsyncInterfaces") continue;
            try { Assembly.Load(new AssemblyName(name)); } catch (Exception e) { Console.WriteLine("[警告] 載不了 " + name + "：" + e.Message); }
        }
        Console.WriteLine($"載入時清掉 DisableOptimizations 的組件 {optimized} 個");
        UnityNative.Icalls.UnityEngine_Object.MainThread = Environment.CurrentManagedThreadId;

        Window win = null;
        if (o.Gl)
        {
            win = new Window(o.W, o.H, !o.Hidden);
            o.W = win.FbW; o.H = win.FbH;
        }

        var info = File.ReadAllLines(Path.Combine(data, "app.info"));
        var cfg = new UnityNative.EngineConfig
        {
            GameDir = game,
            DataDir = data,
            PersistentDir = Path.Combine(Path.GetTempPath(), "unity-native", info.Length > 1 ? info[1] : "game"),
            CompanyName = info.Length > 0 ? info[0] : "",
            ProductName = info.Length > 1 ? info[1] : "",
            FirstScene = o.Scene,
            ScreenWidth = o.W,
            ScreenHeight = o.H,
            WindowWidth = o.W,
            WindowHeight = o.H,
            MobileLayout = o.Wide,
            Language = SystemLanguage(),
        };
        if (o.Ts)
        {
            var start = Process.GetCurrentProcess().StartTime;
            cfg.LogSink = s => Console.WriteLine($"{(DateTime.Now - start).TotalSeconds,6:F2} {s}");
        }
        Console.WriteLine("系統語言 " + cfg.Language);
        UnityNative.Gl.GlGpu gpu = null;
        if (win != null)
        {
            gpu = new UnityNative.Gl.GlGpu();
            UnityNative.FrameRenderer.Gpu = gpu;
            win.Gpu = gpu;
        }
        var sw = Stopwatch.StartNew();
        // 聲音：有視窗、沒加 --mute 才開輸出裝置（無畫面測試照樣混音推進時鐘，只是不出聲）
        var audio = !o.Hidden && !o.Mute ? AudioOut.TryOpen() : null;
        if (audio != null) UnityNative.AudioEngine.Sink = audio.Push;
        // UN_AUDIO_WAV=路徑：混音結果另外寫成 WAV（檢查用）
        var wavPath = Environment.GetEnvironmentVariable("UN_AUDIO_WAV");
        FileStream wav = null;
        if (!string.IsNullOrEmpty(wavPath))
        {
            wav = File.Create(wavPath);
            wav.Write(new byte[44]);
            var prev = UnityNative.AudioEngine.Sink;
            UnityNative.AudioEngine.Sink = (buf, frames) =>
            {
                prev?.Invoke(buf, frames);
                var b = new byte[frames * 4];
                for (int i = 0; i < frames * 2; i++) { short v = (short)Math.Clamp(buf[i] * 32767, -32767, 32767); b[i * 2] = (byte)v; b[i * 2 + 1] = (byte)(v >> 8); }
                wav.Write(b);
            };
            AppDomain.CurrentDomain.ProcessExit += (_, _) => FinishWav(wav);
        }
        MacVideoDecoder.Install();
        UnityNative.Engine.Boot(cfg);
        Console.WriteLine($"開機 {sw.ElapsedMilliseconds} ms");
        // 預設每 10 個 300 格視窗量一窗；環境變數可固定開或關，第一窗（開機後）量。
        var profileEnv = Environment.GetEnvironmentVariable("UN_PROFILE");
        profileMode = profileEnv == "1" ? "on" : profileEnv == "0" ? "off" : "auto";
        UnityNative.Engine.Profile = profileMode != "off";

        if (o.FontTest != null)
        {
            int c = o.FontTest.IndexOf(':');
            var px = UnityNative.FontFaces.SelfTest(o.FontTest[..c], 512, 5);
            if (px != null)
            {
                var img = new byte[px.Length];
                for (int y = 0; y < 512; y++)
                    for (int x = 0; x < 512; x++)
                    {
                        int s = ((511 - y) * 512 + x) * 4, d = (y * 512 + x) * 4;
                        img[d] = img[d + 1] = img[d + 2] = px[s + 3];
                        img[d + 3] = 255;
                    }
                using var f = File.Create(o.FontTest[(c + 1)..]);
                new StbImageWriteSharp.ImageWriter().WritePng(img, 512, 512, StbImageWriteSharp.ColorComponents.RedGreenBlueAlpha, f);
            }
            return 0;
        }
        var frameTimes = new List<double>();
        var windowTimes = new List<double>(300);
        var clock = Stopwatch.StartNew();
        double last = 0;
        var ctl = o.Ctl != null ? StartCtl(o.Ctl) : null;
        var later = new List<(int frame, Action act)>();
        var shotsNow = new List<string>();
        bool quit = false;
        for (int i = 0; (o.Frames <= 0 || i < o.Frames) && !UnityNative.Engine.Quitting && !quit; i++)
        {
            if (win != null && !win.Pump()) break;
            if (ctl != null)
            {
                while (ctl.TryDequeue(out var line)) quit |= RunCtl(line, i, o.H, later, shotsNow);
                if (dumpRequested && gpu != null) { gpu.DumpNext = true; dumpRequested = false; }
                if (profReset) { frameTimes.Clear(); profReset = false; }
                for (int k = later.Count - 1; k >= 0; k--)
                    if (later[k].frame <= i) { var act = later[k].act; later.RemoveAt(k); act(); }
            }
            foreach (var c in o.Clicks)
            {
                if (c.frame == i) UnityNative.InputState.PushButton(0, true, c.x, c.y);
                if (c.frame + 2 == i) UnityNative.InputState.PushButton(0, false, c.x, c.y);
            }
            foreach (var k in o.Keys)
            {
                if (k.frame == i) UnityNative.InputState.PushKey(k.key, true);
                if (k.frame + 2 == i) UnityNative.InputState.PushKey(k.key, false);
            }
            if (gpu != null && o.Dumps.Contains(i)) gpu.DumpNext = true;
            var t0 = Stopwatch.GetTimestamp();
            double now = clock.Elapsed.TotalSeconds;
            UnityNative.PerfDiag.FrameBegin();
            UnityNative.Engine.Frame(o.Realtime ? now - last : 1.0 / 60.0);
            last = now;
            double ms = Stopwatch.GetElapsedTime(t0).TotalMilliseconds;
            frameTimes.Add(ms);
            windowTimes.Add(ms);
            if (UnityNative.PerfDiag.FrameEnd(UnityNative.Engine.Time.FrameCount, ms) is string slow) Console.WriteLine(slow);
            if (UnityNative.Gl.GpuResources.PollTrace() is string tex) Console.WriteLine(tex);
            if (windowTimes.Count == 300)
            {
                double sum = 0, max = 0;
                foreach (var t in windowTimes) { sum += t; if (t > max) max = t; }
                Console.WriteLine($"每格 {sum / windowTimes.Count:F2} ms、最大 {max:F1} ms（{UnityNative.Engine.Time.FrameCount} 格，例外 {UnityNative.Engine.ExceptionCount}，draw {gpu?.LastDrawCalls ?? 0}，" +
                    $"批 UI {gpu?.LastBatches ?? 0}）；累計 shader 編譯 {UnityNative.Gl.GL.Compiles}＋link {UnityNative.Gl.GL.Links} 次 {UnityNative.Gl.GL.CompileMs:F0} ms、" +
                    $"貼圖上傳 {UnityNative.Gl.GpuResources.TexturesUploaded} 張 {UnityNative.Gl.GpuResources.UploadMs} ms、{UnityNative.PerfDiag.WindowGc()}");
                if (UnityNative.Engine.Profile)
                {
                    Console.WriteLine("  分段（每格平均 ms）" + string.Join("、", UnityNative.Engine.PhaseMs.OrderByDescending(kv => kv.Value).Take(14)
                        .Select(kv => kv.Key.Trim() + " " + (kv.Value / windowTimes.Count).ToString("F2"))));
                    Console.WriteLine("  配置（每格平均 KB）" + string.Join("、", UnityNative.Engine.PhaseAlloc.OrderByDescending(kv => kv.Value).Take(14)
                        .Select(kv => kv.Key.Trim() + " " + (kv.Value / windowTimes.Count / 1024).ToString("F1"))));
                }
                if (UnityNative.PerfDiag.WindowExtra() is string extra) Console.WriteLine(extra);
                UnityNative.Engine.PhaseMs.Clear();
                UnityNative.Engine.PhaseAlloc.Clear();
                UnityNative.PerfDiag.WindowEnd();
                windowTimes.Clear();
                windowNo++;
                if (profileMode == "auto") UnityNative.Engine.Profile = windowNo % ProfileEvery == 0;
            }
            foreach (var s in o.Shots) if (s.frame == i && gpu != null) Shot(gpu, s.path);
            if (shotsNow.Count > 0 && gpu != null) { foreach (var s in shotsNow) Shot(gpu, s); shotsNow.Clear(); }
            win?.Swap();
            if (ctl != null)
            {
                // 照 60 fps 節流，遊戲時間跟真實時間差不多
                double target = (i + 1) / 60.0, now2 = clock.Elapsed.TotalSeconds;
                if (target > now2) System.Threading.Thread.Sleep(TimeSpan.FromSeconds(target - now2));
            }
        }
        Report(frameTimes, gpu);
        win?.Close();
        return 0;
    }

    /// <summary>背景執行緒讀 FIFO：寫的那端關掉就重開，下一個寫入者照樣收得到</summary>
    static ConcurrentQueue<string> StartCtl(string path)
    {
        var q = new ConcurrentQueue<string>();
        var t = new System.Threading.Thread(() =>
        {
            while (true)
            {
                using var r = new StreamReader(path);
                string l;
                while ((l = r.ReadLine()) != null) if (l.Trim().Length > 0) q.Enqueue(l.Trim());
            }
        }) { IsBackground = true };
        t.Start();
        Console.WriteLine("[ctl] 等指令：" + path);
        return q;
    }

    /// <summary>一行指令。座標左上原點（跟截圖一樣），換成引擎的左下原點。回傳 true = 結束</summary>
    /// <summary>ctl 的 raycast：EventSystem.current.RaycastAll（uGUI 在 UnityEngine.UI，用反射叫）照排序印出每個結果</summary>
    static void Raycast(float x, float y)
    {
        var esT = Type.GetType("UnityEngine.EventSystems.EventSystem, UnityEngine.UI");
        var es = esT?.GetProperty("current")?.GetValue(null);
        if (es == null) { Console.WriteLine("[raycast] 沒有 EventSystem"); return; }
        var pedT = Type.GetType("UnityEngine.EventSystems.PointerEventData, UnityEngine.UI");
        var ped = Activator.CreateInstance(pedT, es);
        pedT.GetProperty("position").SetValue(ped, new UnityEngine.Vector2(x, y));
        var rrT = Type.GetType("UnityEngine.EventSystems.RaycastResult, UnityEngine.UI");
        var list = (System.Collections.IList)Activator.CreateInstance(typeof(List<>).MakeGenericType(rrT));
        esT.GetMethod("RaycastAll").Invoke(es, new object[] { ped, list });
        Console.WriteLine($"[raycast] ({x},{y}) {list.Count} 個");
        foreach (var r in list)
        {
            var go = rrT.GetProperty("gameObject").GetValue(r) as UnityEngine.GameObject;
            var module = rrT.GetField("module").GetValue(r);
            var path = go != null ? go.name : "null";
            for (var t = go?.transform.parent; t != null; t = t.parent) path = t.name + "/" + path;
            Console.WriteLine($"    {path} module={(module as UnityEngine.Component)?.name} sortingOrder={rrT.GetField("sortingOrder").GetValue(r)} depth={rrT.GetField("depth").GetValue(r)} distance={rrT.GetField("distance").GetValue(r)} index={rrT.GetField("index").GetValue(r)} sortOrderPriority={module?.GetType().GetProperty("sortOrderPriority")?.GetValue(module)} renderOrderPriority={module?.GetType().GetProperty("renderOrderPriority")?.GetValue(module)}");
        }
    }

    static bool dumpRequested, profReset, profUsed;

    static bool RunCtl(string line, int i, int h, List<(int, Action)> later, List<string> shotsNow)
    {
        var p = line.Split(' ', StringSplitOptions.RemoveEmptyEntries);
        float F(int k) => float.Parse(p[k], System.Globalization.CultureInfo.InvariantCulture);
        void Ok() => Console.WriteLine($"[ctl] ok {line}（第 {i} 格）");
        try
        {
            switch (p[0])
            {
                case "move": UnityNative.InputState.PushMouse(F(1), h - F(2)); Ok(); break;
                case "down": UnityNative.InputState.PushMouse(F(1), h - F(2)); UnityNative.InputState.PushButton(0, true, F(1), h - F(2)); Ok(); break;
                case "up": UnityNative.InputState.PushMouse(F(1), h - F(2)); UnityNative.InputState.PushButton(0, false, F(1), h - F(2)); Ok(); break;
                case "click":
                {
                    float x = F(1), y = h - F(2);
                    UnityNative.InputState.PushMouse(x, y);
                    later.Add((i + 1, () => UnityNative.InputState.PushButton(0, true, x, y)));
                    later.Add((i + 4, () => { UnityNative.InputState.PushButton(0, false, x, y); Ok(); }));
                    break;
                }
                case "drag":
                {
                    float x1 = F(1), y1 = h - F(2), x2 = F(3), y2 = h - F(4);
                    int n = p.Length > 5 ? int.Parse(p[5]) : 20;
                    UnityNative.InputState.PushMouse(x1, y1);
                    later.Add((i + 1, () => UnityNative.InputState.PushButton(0, true, x1, y1)));
                    for (int k = 1; k <= n; k++)
                    {
                        float t = (float)k / n;
                        later.Add((i + 3 + k, () => UnityNative.InputState.PushMouse(x1 + (x2 - x1) * t, y1 + (y2 - y1) * t)));
                    }
                    later.Add((i + 6 + n, () => { UnityNative.InputState.PushButton(0, false, x2, y2); Ok(); }));
                    break;
                }
                case "key":
                {
                    var kc = Enum.Parse<UnityEngine.KeyCode>(p[1], true);
                    UnityNative.InputState.PushKey(kc, true);
                    later.Add((i + 3, () => { UnityNative.InputState.PushKey(kc, false); Ok(); }));
                    break;
                }
                case "scroll": UnityNative.InputState.PushScroll(0, F(1)); Ok(); break;
                case "shot": shotsNow.Add(line[5..].Trim()); break;
                case "dump": dumpRequested = true; Ok(); break;
                case "prof": UnityNative.Engine.PhaseMs.Clear(); profReset = profUsed = true; Ok(); break;
                case "tex": UnityNative.Gl.GpuResources.StartTrace(300); Console.WriteLine("[ctl] 貼圖上傳追蹤 300 格"); Ok(); break;
                case "gc": Console.WriteLine(UnityNative.PerfDiag.GcInfo()); Ok(); break;
                case "profile" when p.Length > 1 && p[1] is "on" or "off" or "auto":
                    profileMode = p[1];
                    UnityNative.Engine.Profile = profileMode == "on" || (profileMode == "auto" && windowNo % ProfileEvery == 0);
                    Console.WriteLine("[ctl] 分段計時 " + profileMode + "（這一窗的分段只算到切換之後）"); Ok(); break;
                case "glcache" when p.Length > 1 && p[1] is "on" or "off":
                    UnityNative.Gl.GL.StateCache = p[1] == "on";
                    Console.WriteLine("[ctl] GL state 快取 " + p[1]); Ok(); break;
                case "gl":
                    Console.WriteLine($"  [gl] state 呼叫：送進驅動 {UnityNative.Gl.GL.StateIssued}、省掉 {UnityNative.Gl.GL.StateSkipped}（{UnityNative.Engine.Time.FrameCount - glFrom} 格）");
                    UnityNative.Gl.GL.StateIssued = UnityNative.Gl.GL.StateSkipped = 0; glFrom = UnityNative.Engine.Time.FrameCount; Ok(); break;
                case "find": UnityNative.DebugTools.Find(line[4..].Trim(), Console.WriteLine); Ok(); break;
                case "eval": UnityNative.DebugTools.Eval(line[4..].Trim(), Console.WriteLine); Ok(); break;
                case "hide": UnityNative.DebugTools.Hide(line[4..].Trim(), Console.WriteLine); Ok(); break;
                case "raycast": Raycast(F(1), h - F(2)); Ok(); break;
                case "pick": UnityNative.DebugTools.Pick(UnityNative.ScreenFit.MapX(F(1)), UnityNative.ScreenFit.MapY(h - F(2)), Console.WriteLine); Ok(); break;
                // 模擬觸控（遊戲有觸控翻譯層時才有用；手機版面 --wide 會開）：座標同 click
                case "tdown": UnityNative.TouchEvents.Push(UnityNative.TouchEvents.Kind.Down, 1, F(1), h - F(2)); Ok(); break;
                case "tmove": UnityNative.TouchEvents.Push(UnityNative.TouchEvents.Kind.Move, 1, F(1), h - F(2)); Ok(); break;
                case "tup": UnityNative.TouchEvents.Push(UnityNative.TouchEvents.Kind.Up, 1, F(1), h - F(2)); Ok(); break;
                case "tback": UnityNative.TouchEvents.Push(UnityNative.TouchEvents.Kind.Back, 0, 0, 0); Ok(); break;
                case "ttap":
                {
                    float x = F(1), y = h - F(2);
                    UnityNative.TouchEvents.Push(UnityNative.TouchEvents.Kind.Down, 1, x, y);
                    later.Add((i + 2, () => { UnityNative.TouchEvents.Push(UnityNative.TouchEvents.Kind.Up, 1, x, y); Ok(); }));
                    break;
                }
                case "where": UnityNative.DebugTools.Where(line[5..].Trim(), Console.WriteLine); Ok(); break;
                case "quit": Ok(); return true;
                default: Console.WriteLine("[ctl] 不認得：" + line); break;
            }
        }
        catch (Exception e) { Console.WriteLine($"[ctl] 失敗 {line}：{e.Message}"); }
        return false;
    }

    static void Shot(UnityNative.Gl.GlGpu gpu, string path)
    {
        var px = gpu.ReadPixels(out int w, out int h);
        // GL 左下原點 → PNG 上到下
        var flipped = new byte[px.Length];
        for (int y = 0; y < h; y++) Buffer.BlockCopy(px, (h - 1 - y) * w * 4, flipped, y * w * 4, w * 4);
        for (int i = 3; i < flipped.Length; i += 4) flipped[i] = 255; // 畫面輸出是不透明的（blit 時 alpha 一律 1）
        Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(path)));
        using var f = File.Create(path);
        new StbImageWriteSharp.ImageWriter().WritePng(flipped, w, h, StbImageWriteSharp.ColorComponents.RedGreenBlueAlpha, f);
        Console.WriteLine("截圖 " + path);
    }

    /// <summary>Application.systemLanguage：LC_ALL／LC_MESSAGES／LANG 有設就照它（Linux、手動指定）；
    /// 都沒有時 macOS 問系統的偏好語言（CFLocaleCopyPreferredLanguages，同 Unity 的 macOS player），其他平台用 .NET 的 UI 文化</summary>
    static UnityEngine.SystemLanguage SystemLanguage()
    {
        foreach (var v in new[] { "LC_ALL", "LC_MESSAGES", "LANG" })
        {
            var l = UnityNative.SystemLanguages.FromLocale(Environment.GetEnvironmentVariable(v));
            if (l != null) return l.Value;
        }
        var sys = OperatingSystem.IsMacOS() ? MacPreferredLanguage() : System.Globalization.CultureInfo.CurrentUICulture.Name;
        return UnityNative.SystemLanguages.FromLocale(sys) ?? UnityEngine.SystemLanguage.English;
    }

    [System.Runtime.InteropServices.DllImport("/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation")]
    static extern IntPtr CFLocaleCopyPreferredLanguages();
    [System.Runtime.InteropServices.DllImport("/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation")]
    static extern long CFArrayGetCount(IntPtr a);
    [System.Runtime.InteropServices.DllImport("/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation")]
    static extern IntPtr CFArrayGetValueAtIndex(IntPtr a, long i);
    [System.Runtime.InteropServices.DllImport("/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation")]
    static extern unsafe bool CFStringGetCString(IntPtr s, byte* buf, long size, uint encoding);
    [System.Runtime.InteropServices.DllImport("/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation")]
    static extern void CFRelease(IntPtr p);

    /// <summary>macOS 偏好語言的第一個（例：zh-Hant-TW）；拿不到回 null</summary>
    static unsafe string MacPreferredLanguage()
    {
        try
        {
            var arr = CFLocaleCopyPreferredLanguages();
            if (arr == IntPtr.Zero) return null;
            try
            {
                if (CFArrayGetCount(arr) == 0) return null;
                var buf = stackalloc byte[128];
                return CFStringGetCString(CFArrayGetValueAtIndex(arr, 0), buf, 128, 0x08000100) ? new string((sbyte*)buf) : null;
            }
            finally { CFRelease(arr); }
        }
        catch (Exception) { return null; }
    }

    static void FinishWav(FileStream f)
    {
        long len = f.Length;
        f.Position = 0;
        var w = new BinaryWriter(f);
        w.Write("RIFF"u8.ToArray()); w.Write((int)(len - 8)); w.Write("WAVEfmt "u8.ToArray()); w.Write(16); w.Write((short)1); w.Write((short)2);
        w.Write(UnityNative.AudioEngine.Rate); w.Write(UnityNative.AudioEngine.Rate * 4); w.Write((short)4); w.Write((short)16);
        w.Write("data"u8.ToArray()); w.Write((int)(len - 44));
        w.Flush();
        f.Close();
    }

    static void Report(List<double> ft, UnityNative.Gl.GlGpu gpu)
    {
        Console.WriteLine();
        Console.WriteLine("──── 報告 ────");
        if (ft.Count > 0)
        {
            var tail = profUsed ? ft : ft.Skip(ft.Count / 2).ToList(); // 用過 prof：只有 prof 之後的格，全算
            Console.WriteLine($"格數 {ft.Count}，{(profUsed ? "prof 之後" : "後半")}每格平均 {tail.Average():F3} ms、最大 {tail.Max():F3} ms；全部最大 {ft.Max():F1} ms");
        }
        if (UnityNative.Engine.Profile && ft.Count > 0)
            Console.WriteLine("分段（後半每格平均 ms）：" + string.Join("、", UnityNative.Engine.PhaseMs.OrderByDescending(kv => kv.Value).Take(14)
                .Select(kv => kv.Key.Trim() + " " + (kv.Value / (profUsed ? ft.Count : ft.Count - ft.Count / 2)).ToString("F2"))));
        if (gpu != null) Console.WriteLine($"繪製：最後一格 {gpu.LastDrawCalls} 次 draw、{gpu.LastBatches} 批 UI；貼圖上傳 {UnityNative.Gl.GpuResources.TexturesUploaded} 張、{UnityNative.Gl.GpuResources.UploadMs} ms；shader 編譯 {UnityNative.Gl.GL.Compiles}＋link {UnityNative.Gl.GL.Links} 次、{UnityNative.Gl.GL.CompileMs:F0} ms；代用的 shader：{string.Join("、", gpu.StandIns)}");
        foreach (var s in UnityNative.Scenes.Loaded)
            Console.WriteLine($"場景 {s.Name}：根物件 {string.Join("、", s.Roots.Select(r => r.Name + (r.ActiveSelf ? "" : "（停用）")))}");
        Console.WriteLine("DontDestroyOnLoad：" + string.Join("、", UnityNative.Scenes.DontDestroy.Roots.Select(r => r.Name)));
        Console.WriteLine($"原生物件 {UnityNative.Native.Count}，Update 中的腳本 {UnityNative.Lifecycle.UpdaterCount}，協程 {UnityNative.Coroutines.ActiveCount}");
        Console.WriteLine($"例外 {UnityNative.Engine.ExceptionCount}，錯誤 log {UnityNative.Engine.ErrorCount}");
        Console.WriteLine($"GC：gen0 {GC.CollectionCount(0)}、gen1 {GC.CollectionCount(1)}、gen2 {GC.CollectionCount(2)} 次，暫停共 {GC.GetTotalPauseDuration().TotalMilliseconds:F0} ms，配置 {GC.GetTotalAllocatedBytes() >> 20} MB，heap {GC.GetTotalMemory(false) >> 20} MB");
        Console.WriteLine("替身（被呼叫次數前 40）：");
        foreach (var kv in UnityNative.Engine.Stubs.OrderByDescending(k => k.Value).Take(40)) Console.WriteLine($"  {kv.Value,7}  {kv.Key}");
        Console.WriteLine($"替身共 {UnityNative.Engine.Stubs.Count} 種");
        if (UnityNative.Engine.Missing.Count > 0)
        {
            Console.WriteLine("缺的方法：");
            foreach (var kv in UnityNative.Engine.Missing.OrderByDescending(k => k.Value)) Console.WriteLine($"  {kv.Value,7}  {kv.Key}");
        }
    }
}

/// <summary>GLFW 視窗（macOS：GL 4.1 core、forward compatible）。滑鼠座標換成畫面像素、左下原點</summary>
sealed unsafe class Window
{
    readonly Silk.NET.GLFW.Glfw glfw;
    readonly Silk.NET.GLFW.WindowHandle* win;
    public int FbW, FbH;
    public UnityNative.Gl.GlGpu Gpu;
    float scale = 1;

    public Window(int w, int h, bool visible)
    {
        glfw = Silk.NET.GLFW.Glfw.GetApi();
        if (!glfw.Init()) throw new Exception("GLFW 初始化失敗");
        glfw.WindowHint(Silk.NET.GLFW.WindowHintInt.ContextVersionMajor, 4);
        glfw.WindowHint(Silk.NET.GLFW.WindowHintInt.ContextVersionMinor, 1);
        glfw.WindowHint(Silk.NET.GLFW.WindowHintOpenGlProfile.OpenGlProfile, Silk.NET.GLFW.OpenGlProfile.Core);
        glfw.WindowHint(Silk.NET.GLFW.WindowHintBool.OpenGLForwardCompat, true);
        glfw.WindowHint(Silk.NET.GLFW.WindowHintBool.Visible, visible);
        glfw.WindowHint(Silk.NET.GLFW.WindowHintBool.Resizable, false);
        // 畫面像素跟視窗大小一樣（不要 Retina 兩倍），截圖的座標好對
        glfw.WindowHint((Silk.NET.GLFW.WindowHintBool)0x00023001, false); // GLFW_COCOA_RETINA_FRAMEBUFFER
        win = glfw.CreateWindow(w, h, "unity-native", null, null);
        if (win == null) throw new Exception("GLFW 開不了視窗");
        glfw.MakeContextCurrent(win);
        glfw.SwapInterval(visible ? 1 : 0);
        glfw.GetFramebufferSize(win, out FbW, out FbH);
        glfw.GetWindowSize(win, out int ww, out int wh);
        scale = ww > 0 ? (float)FbW / ww : 1;
        UnityNative.Gl.GL.Load(n => (IntPtr)glfw.GetProcAddress(n), desktop: true);
        Console.WriteLine($"GL：{UnityNative.Gl.GL.Str(UnityNative.Gl.GL.VERSION)}，{UnityNative.Gl.GL.Str(UnityNative.Gl.GL.RENDERER)}，畫面 {FbW}x{FbH}");
        glfw.SetCursorPosCallback(win, (_, x, y) => UnityNative.InputState.PushMouse((float)x * scale, FbH - (float)y * scale));
        glfw.SetMouseButtonCallback(win, (_, b, a, m) =>
        {
            glfw.GetCursorPos(win, out double x, out double y);
            UnityNative.InputState.PushButton((int)b, a == Silk.NET.GLFW.InputAction.Press, (float)x * scale, FbH - (float)y * scale);
        });
        glfw.SetScrollCallback(win, (_, dx, dy) => UnityNative.InputState.PushScroll((float)dx, (float)dy));
        glfw.SetKeyCallback(win, (_, k, sc, a, m) =>
        {
            if (a == Silk.NET.GLFW.InputAction.Repeat) return;
            var kc = Map(k);
            if (kc != UnityEngine.KeyCode.None) UnityNative.InputState.PushKey(kc, a == Silk.NET.GLFW.InputAction.Press);
        });
        glfw.SetCharCallback(win, (_, c) => UnityNative.InputState.PushChar((char)c));
    }

    static UnityEngine.KeyCode Map(Silk.NET.GLFW.Keys k)
    {
        int v = (int)k;
        if (v >= 65 && v <= 90) return UnityEngine.KeyCode.A + (v - 65);
        if (v >= 48 && v <= 57) return UnityEngine.KeyCode.Alpha0 + (v - 48);
        return k switch
        {
            Silk.NET.GLFW.Keys.Escape => UnityEngine.KeyCode.Escape, Silk.NET.GLFW.Keys.Enter => UnityEngine.KeyCode.Return, Silk.NET.GLFW.Keys.Space => UnityEngine.KeyCode.Space,
            Silk.NET.GLFW.Keys.Tab => UnityEngine.KeyCode.Tab, Silk.NET.GLFW.Keys.Backspace => UnityEngine.KeyCode.Backspace,
            Silk.NET.GLFW.Keys.Left => UnityEngine.KeyCode.LeftArrow, Silk.NET.GLFW.Keys.Right => UnityEngine.KeyCode.RightArrow,
            Silk.NET.GLFW.Keys.Up => UnityEngine.KeyCode.UpArrow, Silk.NET.GLFW.Keys.Down => UnityEngine.KeyCode.DownArrow,
            Silk.NET.GLFW.Keys.ShiftLeft => UnityEngine.KeyCode.LeftShift, Silk.NET.GLFW.Keys.ControlLeft => UnityEngine.KeyCode.LeftControl,
            _ => UnityEngine.KeyCode.None,
        };
    }

    public bool Pump()
    {
        glfw.PollEvents();
        return !glfw.WindowShouldClose(win);
    }

    public void Swap() => glfw.SwapBuffers(win);
    public void Close() { glfw.DestroyWindow(win); glfw.Terminate(); }
}

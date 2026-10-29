// Android 宿主：一個全螢幕的 GLSurfaceView。開機與每格的 Engine.Frame 都在 GL 執行緒上跑（那條執行緒就是遊戲的主執行緒）。
// 檔案放哪裡：
//   遊戲的 DLL（patch 過）：APK 的 assets/managed，APK 裝好或更新後第一次開時解到內部空間 files/managed
//   匯入器輸出（public/game 的 assets、scenes、shaders）與原版 *_Data 的小檔：外部 app 空間 Android/data/<套件>/files/{game,data}，
//   由 android.sh 用 adb 推（約 3 GB，不放進 APK）
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Runtime.CompilerServices;
using System.Runtime.InteropServices;
using System.Runtime.Loader;
using System.Text.Json;
using System.Threading;
using Android.App;
using Android.Content;
using Android.Content.PM;
using Android.Opengl;
using Android.OS;
using Android.Views;
using Activity = Android.App.Activity;
using EGLConfig = Javax.Microedition.Khronos.Egl.EGLConfig;
using Javax.Microedition.Khronos.Opengles;

namespace HostAndroid
{
    [Activity(Name = "unitynative.MainActivity", MainLauncher = true, Theme = "@android:style/Theme.Black.NoTitleBar.Fullscreen", LaunchMode = LaunchMode.SingleTask,
        ScreenOrientation = ScreenOrientation.SensorLandscape,
        ConfigurationChanges = ConfigChanges.Orientation | ConfigChanges.ScreenSize | ConfigChanges.ScreenLayout | ConfigChanges.SmallestScreenSize |
                               ConfigChanges.Keyboard | ConfigChanges.KeyboardHidden | ConfigChanges.Navigation | ConfigChanges.UiMode | ConfigChanges.Density)]
    public class MainActivity : Activity
    {
        public const string Tag = "unity-native";
        internal static string Managed;
        /// <summary>挑到的顯示模式的更新率（Hz）與螢幕圓角半徑（裝置像素），開機時交給 EngineConfig</summary>
        internal static volatile float RefreshRate = 60f;
        internal static volatile int CornerRadius;
        /// <summary>畫面上緣被挖孔擋住的高（裝置像素，DisplayCutout.SafeInsetTop），開機時交給 EngineConfig、之後跟著插入值更新</summary>
        internal static volatile int SafeInsetTop;
        internal static MainActivity Instance;
        GameView view;

        /// <summary>載入時清掉 DisableOptimizations 的組件數</summary>
        internal static int Optimized;

        /// <summary>把組件層級 DebuggableAttribute 的 DisableOptimizations 從記憶體副本清掉；磁碟 DLL 不改</summary>
        static Assembly LoadOptimizable(AssemblyLoadContext ctx, string file)
        {
            var bytes = File.ReadAllBytes(file);
            int at = DebuggableModesOffset(bytes);
            if (at < 0) return ctx.LoadFromAssemblyPath(file);
            int modes = BitConverter.ToInt32(bytes, at);
            const int Default = 0x1, EnableEditAndContinue = 0x4, DisableOptimizations = 0x100;
            if ((modes & DisableOptimizations) == 0) return ctx.LoadFromAssemblyPath(file);
            BitConverter.GetBytes(modes & ~(Default | EnableEditAndContinue | DisableOptimizations)).CopyTo(bytes, at);
            Interlocked.Increment(ref Optimized);
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

        protected override void OnCreate(Bundle savedInstanceState)
        {
            base.OnCreate(savedInstanceState);
            Window.AddFlags(WindowManagerFlags.KeepScreenOn | WindowManagerFlags.Fullscreen);
            if (Build.VERSION.SdkInt >= BuildVersionCodes.P)
            {
                var lp = Window.Attributes;
                lp.LayoutInDisplayCutoutMode = LayoutInDisplayCutoutMode.ShortEdges;
                Window.Attributes = lp;
            }
            RequestHighestRefreshRate();

            Instance = this;
            Managed = ExtractManaged();
            InitFmodJava();
            // UnityEngine.*、遊戲的 DLL 從解出來的資料夾載入：一定要在碰到任何 UnityEngine 型別之前掛上
            AssemblyLoadContext.Default.Resolving += (ctx, name) =>
            {
                var p = Path.Combine(Managed, name.Name + ".dll");
                return File.Exists(p) ? LoadOptimizable(ctx, p) : null;
            };

            var ext = GetExternalFilesDir(null).AbsolutePath;
            var game = Path.Combine(ext, "game");
            var data = Path.Combine(ext, "data");
            if (!Directory.Exists(Path.Combine(game, "scenes")) || !File.Exists(Path.Combine(data, "ScriptingAssemblies.json")))
            {
                Android.Util.Log.Error(Tag, "缺遊戲資料：" + game + "、" + data + "（用 android.sh 推）");
                var tv = new Android.Widget.TextView(this) { Text = "缺遊戲資料：\n" + game + "\n" + data + "\n\n用 unity-native/android.sh 推到手機" };
                tv.SetTextColor(Android.Graphics.Color.White);
                SetContentView(tv);
                return;
            }
            // 自動點擊（驗證用）：am start --es clicks "格數:x,y;…"，x、y 是畫面比例（左上原點），例如 400:0.5,0.5 = 第 400 格點畫面中央
            // 另一份存檔（驗證用）：am start --es persistent 資料夾名，在 app 內部空間另開一份，不碰平常那份（persistent）
            var save = Intent?.GetStringExtra("persistent");
            if (string.IsNullOrEmpty(save) || save.Contains('/') || save.Contains("..")) save = "persistent";
            view = new GameView(this, game, data, Path.Combine(FilesDir.AbsolutePath, save), Intent?.GetStringExtra("clicks"));
            SetContentView(view);
            HideBars(); // decor view 在 SetContentView 之後才有，InsetsController 要等它
        }

        /// <summary>FMOD 的 Java 半邊（APK 帶了 fmod.jar 才有 org.fmod.FMOD；Diceomancer）：FMOD 在 Android 上靠它開音訊輸出、讀裝置資訊。
        /// 先用 System.loadLibrary 載 libfmod.so（Java 宣告的 native 方法只在 loadLibrary 載的函式庫裡找），再 FMOD.init(context)；
        /// 之後原版的 FMODUnity 用 DllImport 載 libfmodstudio.so，連到同一份 libfmod.so</summary>
        void InitFmodJava()
        {
            Java.Lang.Class cls;
            try { cls = Java.Lang.Class.ForName("org.fmod.FMOD"); }
            catch (Java.Lang.ClassNotFoundException) { return; }
            try
            {
                Java.Lang.JavaSystem.LoadLibrary("fmod");
                var init = cls.GetMethod("init", Java.Lang.Class.FromType(typeof(Context)));
                var ok = init.Invoke(null, this);
                Android.Util.Log.Info(Tag, "FMOD 的 Java 半邊初始化：" + ok);
            }
            catch (Exception e) { Android.Util.Log.Error(Tag, "FMOD 的 Java 半邊初始化失敗：" + e); }
        }

        /// <summary>同解析度裡更新率最高的顯示模式（120 Hz 的手機預設常跑 60；同 mt2-web 的 APK 殼）</summary>
        void RequestHighestRefreshRate()
        {
            var display = WindowManager?.DefaultDisplay;
            if (display == null) return;
            var cur = display.GetMode();
            var best = cur;
            foreach (var m in display.GetSupportedModes())
                if (m.PhysicalWidth == cur.PhysicalWidth && m.PhysicalHeight == cur.PhysicalHeight && m.RefreshRate > best.RefreshRate) best = m;
            var lp = Window.Attributes;
            lp.PreferredDisplayModeId = best.ModeId;
            lp.PreferredRefreshRate = best.RefreshRate;
            Window.Attributes = lp;
            RefreshRate = best.RefreshRate;
        }

        /// <summary>圓角半徑（四個角取最大）與挖孔的左右 safe inset 取大（同 mt2-web 的 APK 殼 updateSafeInsets）</summary>
        internal static void UpdateCorner(WindowInsets insets)
        {
            int side = 0;
            if (Build.VERSION.SdkInt >= BuildVersionCodes.S)
                foreach (var pos in new[] { RoundedCornerPosition.TopLeft, RoundedCornerPosition.TopRight, RoundedCornerPosition.BottomRight, RoundedCornerPosition.BottomLeft })
                {
                    var rc = insets.GetRoundedCorner((int)pos);
                    if (rc != null) side = Math.Max(side, rc.Radius);
                }
            var cut = insets.DisplayCutout;
            if (cut != null) side = Math.Max(side, Math.Max(cut.SafeInsetLeft, cut.SafeInsetRight));
            CornerRadius = side;
            SafeInsetTop = cut?.SafeInsetTop ?? 0;
            if (UnityNative.Engine.Config != null)
            {
                UnityNative.Engine.Config.CornerRadius = side;
                UnityNative.Engine.Config.SafeInsetTop = SafeInsetTop;
            }
        }

        bool portraitAllowed;

        /// <summary>
        /// 遊戲的 glue 打開 EngineConfig.AllowPortrait（Diceomancer 的手機直向版面）時方向改成跟著感應器轉（直拿直向、橫拿橫向，不看系統的自動旋轉開關，同 sensorLandscape；
        /// 網頁版 APK 殼的 setPortraitAllowed），關掉時回 sensorLandscape。沒有遊戲打開就一直是 Manifest 的 sensorLandscape（MT2）
        /// </summary>
        internal void SetPortraitAllowed(bool allow)
        {
            if (portraitAllowed == allow) return;
            portraitAllowed = allow;
            RunOnUiThread(() => RequestedOrientation = allow ? ScreenOrientation.Sensor : ScreenOrientation.SensorLandscape);
        }

        void HideBars()
        {
            if (Build.VERSION.SdkInt >= BuildVersionCodes.R)
            {
                Window.SetDecorFitsSystemWindows(false);
                Window.InsetsController?.Hide(WindowInsets.Type.SystemBars());
                if (Window.InsetsController != null) Window.InsetsController.SystemBarsBehavior = (int)WindowInsetsControllerBehavior.ShowTransientBarsBySwipe;
            }
            else
            {
                Window.DecorView.SystemUiVisibility = (StatusBarVisibility)(SystemUiFlags.ImmersiveSticky | SystemUiFlags.Fullscreen | SystemUiFlags.HideNavigation |
                                                                              SystemUiFlags.LayoutStable | SystemUiFlags.LayoutHideNavigation | SystemUiFlags.LayoutFullscreen);
            }
        }

        /// <summary>APK 的 assets/managed 解到 files/managed；APK 沒換（安裝時間一樣）就不重解</summary>
        string ExtractManaged()
        {
            var dir = Path.Combine(FilesDir.AbsolutePath, "managed");
            var stamp = Path.Combine(dir, ".stamp");
            var info = PackageManager.GetPackageInfo(PackageName, 0);
            var want = info.LastUpdateTime.ToString();
            if (File.Exists(stamp) && File.ReadAllText(stamp) == want) return dir;
            var sw = Stopwatch.StartNew();
            if (Directory.Exists(dir)) Directory.Delete(dir, true);
            Directory.CreateDirectory(dir);
            var names = Assets.List("managed");
            foreach (var n in names)
            {
                using var src = Assets.Open("managed/" + n);
                using var dst = File.Create(Path.Combine(dir, n));
                src.CopyTo(dst);
            }
            File.WriteAllText(stamp, want);
            Android.Util.Log.Info(Tag, $"解出遊戲 DLL {names.Length} 個，{sw.ElapsedMilliseconds} ms");
            return dir;
        }

        public override void OnWindowFocusChanged(bool hasFocus)
        {
            base.OnWindowFocusChanged(hasFocus);
            if (hasFocus) HideBars();
        }

        // 切到背景／回來：照 Unity 送 OnApplicationFocus、OnApplicationPause 給腳本（原版 FMODUnity 的 RuntimeManager 在這裡 mixerSuspend／mixerResume）。
        // 要在 GL 執行緒（遊戲的主執行緒）上跑：QueueEvent 排在 view.OnPause() 之前，GLSurfaceView 停下來前會先跑完排隊的事件
        protected override void OnPause()
        {
            base.OnPause();
            view?.QueueEvent(new Java.Lang.Runnable(() => Loop.ApplicationPause(true)));
            view?.OnPause();
            view?.Audio?.Pause();
        }

        protected override void OnResume()
        {
            base.OnResume();
            view?.OnResume();
            view?.QueueEvent(new Java.Lang.Runnable(() => Loop.ApplicationPause(false)));
            view?.Audio?.Resume();
        }

        /// <summary>Application.Quit：關掉 Activity（同網頁版 APK 殼的 finishAndRemoveTask），程序也一起結束（引擎的狀態都是靜態的，不能在同一個程序裡再開機）</summary>
        internal void Quit() => RunOnUiThread(() => { FinishAndRemoveTask(); Android.OS.Process.KillProcess(Android.OS.Process.MyPid()); });

        // 返回鍵當 Escape（遊戲的選單、關對話框）
        public override bool DispatchKeyEvent(KeyEvent e)
        {
            if (view != null && e.KeyCode == Keycode.Back)
            {
                if (e.Action == KeyEventActions.Down && e.RepeatCount == 0) view.Key(true);
                else if (e.Action == KeyEventActions.Up) view.Key(false);
                return true;
            }
            return base.DispatchKeyEvent(e);
        }
    }

    /// <summary>畫面：GL ES 3 context、觸控（第一根手指當滑鼠左鍵）、遊戲迴圈</summary>
    public sealed class GameView : GLSurfaceView
    {
        readonly Loop loop;
        public AudioOut Audio => loop.Audio;

        public GameView(Context ctx, string game, string data, string persistent, string clicks) : base(ctx)
        {
            SetEGLContextClientVersion(3);
            SetEGLConfigChooser(8, 8, 8, 0, 0, 0);
            PreserveEGLContextOnPause = true;
            loop = new Loop(game, data, persistent, clicks);
            SetRenderer(loop);
            RenderMode = Rendermode.Continuously;
        }

        public override bool OnTouchEvent(MotionEvent e)
        {
            int h = Height;
            // 遊戲有觸控翻譯層（TouchEvents.Enabled）：每根手指的事件原樣排進去，由它決定送什麼滑鼠動作
            if (Input.TouchLayer())
            {
                int idx = e.ActionIndex;
                switch (e.ActionMasked)
                {
                    case MotionEventActions.Down:
                    case MotionEventActions.PointerDown:
                        Input.Touch(0, e.GetPointerId(idx), e.GetX(idx), h - e.GetY(idx), e.ActionMasked == MotionEventActions.Down); break;
                    case MotionEventActions.Move:
                        for (int i = 0; i < e.PointerCount; i++) Input.Touch(1, e.GetPointerId(i), e.GetX(i), h - e.GetY(i), i == 0); break;
                    case MotionEventActions.Up:
                    case MotionEventActions.PointerUp:
                        Input.Touch(2, e.GetPointerId(idx), e.GetX(idx), h - e.GetY(idx), e.ActionMasked == MotionEventActions.Up); break;
                    case MotionEventActions.Cancel:
                        Input.Touch(3, e.GetPointerId(0), e.GetX(0), h - e.GetY(0), true); break;
                }
                return true;
            }
            float x = e.GetX(0), y = h - e.GetY(0);
            switch (e.ActionMasked)
            {
                case MotionEventActions.Down: Input.Button(true, x, y); break;
                case MotionEventActions.Move: Input.Move(x, y); break;
                case MotionEventActions.Up:
                case MotionEventActions.Cancel: Input.Button(false, x, y); break;
            }
            return true;
        }

        public void Key(bool down)
        {
            // 觸控翻譯層：返回鍵交給它（依狀態送取消、Shift、右鍵或 Esc）
            if (Input.TouchLayer()) { if (down) Input.Touch(4, 0, 0, 0, true); return; }
            Input.Escape(down);
        }

        public override WindowInsets OnApplyWindowInsets(WindowInsets insets)
        {
            MainActivity.UpdateCorner(insets);
            return base.OnApplyWindowInsets(insets);
        }
    }

    /// <summary>碰 UnityEngine 型別的地方集中在這裡（Resolving 掛好之後才會 JIT 到）</summary>
    static class Input
    {
        public static void Button(bool down, float x, float y) => UnityNative.InputState.PushButton(0, down, x, y);
        public static void Move(float x, float y) => UnityNative.InputState.PushMouse(x, y);
        public static void Escape(bool down) => UnityNative.InputState.PushKey(UnityEngine.KeyCode.Escape, down);
        public static bool TouchLayer() => UnityNative.TouchEvents.Enabled;
        public static void Touch(int kind, int id, float x, float y, bool primary) => UnityNative.TouchEvents.Push((UnityNative.TouchEvents.Kind)kind, id, x, y, primary);
    }

    sealed class Loop : Java.Lang.Object, GLSurfaceView.IRenderer
    {
        readonly string game, data, persistent;
        readonly List<(int frame, float fx, float fy)> clicks = new List<(int, float, float)>();
        int frameNo;
        bool booted, failed, quitting;
        [MethodImpl(MethodImplOptions.NoInlining)]
        static bool QuitRequested() => UnityNative.Engine.Quitting;
        [MethodImpl(MethodImplOptions.NoInlining)]
        static bool PortraitAllowed() => UnityNative.Engine.Config?.AllowPortrait ?? false;
        int width, height;
        public AudioOut Audio;
        readonly Stopwatch clock = Stopwatch.StartNew();
        double last;
        readonly List<double> times = new List<double>();
        UnityNative.Gl.GlGpu gpu;
        readonly string ctlFile = Android.App.Application.Context.GetExternalFilesDir(null)?.AbsolutePath is string ext ? Path.Combine(ext, "ctl") : null;
        const int ProfileEvery = 10;
        string profileMode = "auto";
        int windowNo, glFrom;

        void RunCtl()
        {
            string[] lines;
            try { lines = File.ReadAllLines(ctlFile); File.Delete(ctlFile); } catch { return; }
            foreach (var l in lines)
            {
                var t = l.Trim();
                if (t == "dump") gpu.DumpNext = true;
                else if (t.StartsWith("find ")) UnityNative.DebugTools.Find(t[5..].Trim(), Log);
                else if (t == "tex") { UnityNative.Gl.GpuResources.StartTrace(300); Log("[ctl] 貼圖上傳追蹤 300 格"); }
                else if (t == "gc") Log(UnityNative.PerfDiag.GcInfo());
                else if (t == "glcache on" || t == "glcache off") { UnityNative.Gl.GL.StateCache = t.EndsWith("on"); Log("[ctl] GL state 快取 " + t[8..]); }
                else if (t == "gl")
                {
                    Log($"  [gl] state 呼叫：送進驅動 {UnityNative.Gl.GL.StateIssued}、省掉 {UnityNative.Gl.GL.StateSkipped}（{UnityNative.Engine.Time.FrameCount - glFrom} 格）");
                    UnityNative.Gl.GL.StateIssued = UnityNative.Gl.GL.StateSkipped = 0; glFrom = UnityNative.Engine.Time.FrameCount;
                }
                else if (t == "profile on" || t == "profile off" || t == "profile auto")
                {
                    profileMode = t[8..];
                    UnityNative.Engine.Profile = profileMode == "on" || (profileMode == "auto" && windowNo % ProfileEvery == 0);
                    Log("[ctl] 分段計時 " + profileMode + "（這一窗的分段只算到切換之後）");
                }
                else if (t.Length > 0) Log("[ctl] 不認得：" + t);
            }
        }

        public Loop(string game, string data, string persistent, string clickSpec)
        {
            this.game = game; this.data = data; this.persistent = persistent;
            foreach (var c in (clickSpec ?? "").Split(';', StringSplitOptions.RemoveEmptyEntries))
            {
                int k = c.IndexOf(':');
                var xy = c[(k + 1)..].Split(',');
                clicks.Add((int.Parse(c[..k]), float.Parse(xy[0], System.Globalization.CultureInfo.InvariantCulture), float.Parse(xy[1], System.Globalization.CultureInfo.InvariantCulture)));
            }
        }

        // 新的 EGL context：GL state 回到預設值，引擎的快取也要清空。
        public void OnSurfaceCreated(IGL10 gl, EGLConfig config) => ResetGlState();

        [MethodImpl(MethodImplOptions.NoInlining)]
        static void ResetGlState() => UnityNative.Gl.GL.ResetStateCache();

        public void OnSurfaceChanged(IGL10 gl, int w, int h)
        {
            width = w; height = h;
            if (booted)
            {
                UnityNative.Engine.Config.WindowWidth = w;
                UnityNative.Engine.Config.WindowHeight = h;
                return;
            }
            if (failed) return;
            // 第一個 surface 常是直的（轉向還沒套上）：等到橫的再開機，畫面大小才對
            if (h > w) { Log($"畫面 {w}x{h} 是直的，等轉成橫的"); return; }
            try { Boot(); booted = booted0 = true; }
            catch (Exception e) { failed = true; Android.Util.Log.Error(MainActivity.Tag, "開機失敗：" + e); }
        }

        [MethodImpl(MethodImplOptions.NoInlining)]
        void Boot()
        {
            var sw = Stopwatch.StartNew();
            Log($"畫面 {width}x{height}、{MainActivity.RefreshRate:F0} Hz、圓角 {MainActivity.CornerRadius} px，遊戲資料 {game}");
            LoadGl();
            UnityNative.SerialFields.LoadEngineNonPublic(Path.Combine(MainActivity.Managed, "nonpublic-fields.txt"));
            var list = JsonDocument.Parse(File.ReadAllText(Path.Combine(data, "ScriptingAssemblies.json"))).RootElement.GetProperty("names");
            foreach (var n in list.EnumerateArray())
            {
                var name = Path.GetFileNameWithoutExtension(n.GetString());
                if (name == "mscorlib" || name == "netstandard" || name.StartsWith("System") || name.StartsWith("Mono.") || name == "Microsoft.Bcl.AsyncInterfaces") continue;
                try { Assembly.Load(new AssemblyName(name)); } catch (Exception e) { Log("[警告] 載不了 " + name + "：" + e.Message); }
            }
            Log($"載入 DLL {sw.ElapsedMilliseconds} ms");
            Log($"  載入時清掉 DisableOptimizations 的組件 {MainActivity.Optimized} 個");
            UnityNative.Icalls.UnityEngine_Object.MainThread = System.Environment.CurrentManagedThreadId;

            var info = File.ReadAllLines(Path.Combine(data, "app.info"));
            var cfg = new UnityNative.EngineConfig
            {
                GameDir = game,
                DataDir = data,
                PersistentDir = persistent,
                CompanyName = info.Length > 0 ? info[0] : "",
                ProductName = info.Length > 1 ? info[1] : "",
                ScreenWidth = width,
                ScreenHeight = height,
                WindowWidth = width,
                WindowHeight = height,
                // 手機版面（網頁版的 APK 預設開：寬版、介面縮放；遊戲的 glue 讀這個）
                MobileLayout = true,
                Dpi = Android.App.Application.Context.Resources.DisplayMetrics.Xdpi,
                RefreshRate = MainActivity.RefreshRate,
                CornerRadius = MainActivity.CornerRadius,
                SafeInsetTop = MainActivity.SafeInsetTop,
                LogSink = Log,
            };
            gpu = new UnityNative.Gl.GlGpu();
            UnityNative.FrameRenderer.Gpu = gpu;
            Audio = AudioOut.TryOpen();
            if (Audio != null) UnityNative.AudioEngine.Sink = Audio.Push;
            AndroidVideoDecoder.Install();
            HostAndroid.PngAndroid.Install();
            UnityNative.Engine.Boot(cfg);
            Log($"開機 {sw.ElapsedMilliseconds} ms");
            UnityNative.Engine.Profile = true; // 第一窗（開機後）量
            last = clock.Elapsed.TotalSeconds;
        }

        // GL ES 的函式：核心的從 libGLESv3.so 直接拿（Android 的 eglGetProcAddress 不保證回核心函式），拿不到才問 EGL
        static unsafe void LoadGl()
        {
            var gles = NativeLibrary.Load("libGLESv3.so");
            var egl = NativeLibrary.Load("libEGL.so");
            var eglGet = (delegate* unmanaged<byte*, IntPtr>)NativeLibrary.GetExport(egl, "eglGetProcAddress");
            UnityNative.Gl.GL.Load(n =>
            {
                if (NativeLibrary.TryGetExport(gles, n, out var p)) return p;
                var b = System.Text.Encoding.ASCII.GetBytes(n + "\0");
                fixed (byte* s = b) return eglGet(s);
            }, desktop: false);
            Log($"GL：{UnityNative.Gl.GL.Str(UnityNative.Gl.GL.VERSION)}，{UnityNative.Gl.GL.Str(UnityNative.Gl.GL.RENDERER)}");
        }

        readonly UnityNative.FramePacer pacer = new UnityNative.FramePacer();

        public void OnDrawFrame(IGL10 gl)
        {
            if (!booted) return;
            // 照 targetFrameRate／vSyncCount 限速：這次不跑的話重貼上一格（GLSurfaceView 每次都會換緩衝）
            if (frameNo > 0 && !pacer.ShouldRun(clock.Elapsed.TotalSeconds)) { gpu.Present(); return; }
            foreach (var c in clicks)
            {
                float x = c.fx * width, y = (1 - c.fy) * height;
                if (c.frame == frameNo) { Log($"自動點擊 第 {frameNo} 格 ({x:F0},{y:F0})"); Input.Button(true, x, y); }
                if (c.frame + 2 == frameNo) Input.Button(false, x, y);
            }
            frameNo++;
            // 除錯：adb 推 files/ctl（一行一個指令，同桌面版 --ctl 的 dump、find 名稱），結果寫進 log，檔案讀完就刪
            if (frameNo % 30 == 0 && ctlFile != null && File.Exists(ctlFile)) RunCtl();
            double now = clock.Elapsed.TotalSeconds;
            UnityNative.PerfDiag.FrameBegin();
            var t0 = Stopwatch.GetTimestamp();
            try { Frame(now - last); }
            catch (Exception e) { Log("[例外] 每格：" + e); }
            last = now;
            if (QuitRequested() && !quitting) { quitting = true; Log("Application.Quit：關掉"); MainActivity.Instance?.Quit(); }
            MainActivity.Instance?.SetPortraitAllowed(PortraitAllowed());
            double ms = Stopwatch.GetElapsedTime(t0).TotalMilliseconds;
            times.Add(ms);
            if (UnityNative.PerfDiag.FrameEnd(UnityNative.Engine.Time.FrameCount, ms) is string slow) Log(slow);
            if (UnityNative.Gl.GpuResources.PollTrace() is string tex) Log(tex);
            if (times.Count == 300)
            {
                double sum = 0, max = 0;
                foreach (var t in times) { sum += t; if (t > max) max = t; }
                Log($"每格 {sum / times.Count:F2} ms、最大 {max:F1} ms（{UnityNative.Engine.Time.FrameCount} 格，例外 {UnityNative.Engine.ExceptionCount}，draw {gpu.LastDrawCalls}，" +
                    $"代用的 shader {gpu.StandIns.Count}）；累計 shader 編譯 {UnityNative.Gl.GL.Compiles}＋link {UnityNative.Gl.GL.Links} 次 {UnityNative.Gl.GL.CompileMs:F0} ms、" +
                    $"貼圖上傳 {UnityNative.Gl.GpuResources.TexturesUploaded} 張 {UnityNative.Gl.GpuResources.UploadMs} ms、{UnityNative.PerfDiag.WindowGc()}");
                if (UnityNative.Engine.Profile)
                {
                    Log("  分段（每格平均 ms）" + string.Join("、", UnityNative.Engine.PhaseMs.OrderByDescending(kv => kv.Value).Take(14)
                        .Select(kv => kv.Key.Trim() + " " + (kv.Value / times.Count).ToString("F2"))));
                    Log("  配置（每格平均 KB）" + string.Join("、", UnityNative.Engine.PhaseAlloc.OrderByDescending(kv => kv.Value).Take(14)
                        .Select(kv => kv.Key.Trim() + " " + (kv.Value / times.Count / 1024).ToString("F1"))));
                }
                if (UnityNative.PerfDiag.WindowExtra() is string extra) Log(extra);
                UnityNative.Engine.PhaseMs.Clear();
                UnityNative.Engine.PhaseAlloc.Clear();
                UnityNative.PerfDiag.WindowEnd();
                times.Clear();
                windowNo++;
                if (profileMode == "auto") UnityNative.Engine.Profile = windowNo % ProfileEvery == 0;
            }
        }

        [MethodImpl(MethodImplOptions.NoInlining)]
        static void Frame(double dt) => UnityNative.Engine.Frame(dt);

        static bool booted0;

        /// <summary>切到背景：OnApplicationFocus(false)、OnApplicationPause(true)；回來：OnApplicationPause(false)、OnApplicationFocus(true)</summary>
        [MethodImpl(MethodImplOptions.NoInlining)]
        internal static void ApplicationPause(bool paused)
        {
            if (!booted0) return;
            if (paused) { UnityNative.Lifecycle.SendApplicationFocus(false); UnityNative.Lifecycle.SendApplicationPause(true); }
            else { UnityNative.Lifecycle.SendApplicationPause(false); UnityNative.Lifecycle.SendApplicationFocus(true); }
            Log(paused ? "切到背景：OnApplicationPause(true)" : "回到前景：OnApplicationPause(false)");
        }

        // logcat 會被系統訊息洗掉，另外整份寫到 files/log.txt（每次開機重寫）：adb pull 回來看
        static StreamWriter file;
        static readonly object fileGate = new object();

        internal static void Log(string s)
        {
            Android.Util.Log.Info(MainActivity.Tag, s);
            lock (fileGate)
            {
                if (file == null)
                {
                    try { file = new StreamWriter(Path.Combine(Android.App.Application.Context.GetExternalFilesDir(null).AbsolutePath, "log.txt"), false) { AutoFlush = true }; }
                    catch { return; }
                }
                file.WriteLine(DateTime.Now.ToString("HH:mm:ss.fff ") + s);
            }
        }
    }
}

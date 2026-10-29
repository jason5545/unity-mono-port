// macOS 的影片解碼器（VideoPlayer 用，引擎的 VideoDecoders.Open）：AVFoundation 的 AVAssetReader，透過 objc_msgSend 直接叫，不用另外的套件。
//   - 畫面：AVAssetReaderTrackOutput 要 32BGRA（系統用 VideoToolbox 硬體解碼再轉），背景執行緒讀進最多 Ahead 格的佇列；
//     主執行緒 Advance(t) 挑 t 之前最新的一格，Upload 用 glTexSubImage2D（GL_BGRA）放進 RGBA8 貼圖。
//   - 聲音：另一個 AVAssetReader（兩個 output 放同一個 reader 時，沒被讀的那個會卡住另一個），要 48 kHz 立體聲 32 位元 float 交錯，
//     照時間戳寫進 PcmRing（最多領先播放位置 4 秒）。
//   - 跳時間：兩個 reader 都重開，timeRange 從 t 開始。
// AVAsset 的同步屬性（tracksWithMediaType:、duration、naturalSize、nominalFrameRate）macOS 15 起標成 deprecated，但還能用（本機 macOS 26 實測）。
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Threading;
using UnityNative;
using UnityNative.Gl;

static unsafe class ObjC
{
    const string Objc = "/usr/lib/libobjc.A.dylib";
    static readonly IntPtr lib = NativeLibrary.Load(Objc);
    static readonly IntPtr send = NativeLibrary.GetExport(lib, "objc_msgSend");
    static readonly Dictionary<string, IntPtr> sels = new Dictionary<string, IntPtr>();

    [DllImport(Objc)] public static extern IntPtr objc_getClass(string name);
    [DllImport(Objc)] static extern IntPtr sel_registerName(string name);
    [DllImport(Objc)] public static extern IntPtr objc_autoreleasePoolPush();
    [DllImport(Objc)] public static extern void objc_autoreleasePoolPop(IntPtr pool);

    public static IntPtr Sel(string name)
    {
        lock (sels)
        {
            if (!sels.TryGetValue(name, out var s)) sels[name] = s = sel_registerName(name);
            return s;
        }
    }

    public static IntPtr Cls(string name) => objc_getClass(name);
    public static IntPtr Msg(IntPtr o, string sel) => ((delegate* unmanaged<IntPtr, IntPtr, IntPtr>)send)(o, Sel(sel));
    public static IntPtr Msg(IntPtr o, string sel, IntPtr a) => ((delegate* unmanaged<IntPtr, IntPtr, IntPtr, IntPtr>)send)(o, Sel(sel), a);
    public static IntPtr Msg(IntPtr o, string sel, IntPtr a, IntPtr b) => ((delegate* unmanaged<IntPtr, IntPtr, IntPtr, IntPtr, IntPtr>)send)(o, Sel(sel), a, b);
    public static IntPtr Msg(IntPtr o, string sel, IntPtr a, IntPtr b, nuint c) => ((delegate* unmanaged<IntPtr, IntPtr, IntPtr, IntPtr, nuint, IntPtr>)send)(o, Sel(sel), a, b, c);
    public static IntPtr MsgInt(IntPtr o, string sel, int a) => ((delegate* unmanaged<IntPtr, IntPtr, int, IntPtr>)send)(o, Sel(sel), a);
    public static IntPtr MsgIndex(IntPtr o, string sel, nuint a) => ((delegate* unmanaged<IntPtr, IntPtr, nuint, IntPtr>)send)(o, Sel(sel), a);
    public static IntPtr MsgBool(IntPtr o, string sel, bool a) => ((delegate* unmanaged<IntPtr, IntPtr, byte, IntPtr>)send)(o, Sel(sel), (byte)(a ? 1 : 0));
    public static void MsgVoidBool(IntPtr o, string sel, bool a) => ((delegate* unmanaged<IntPtr, IntPtr, byte, void>)send)(o, Sel(sel), (byte)(a ? 1 : 0));
    public static bool MsgB(IntPtr o, string sel) => ((delegate* unmanaged<IntPtr, IntPtr, byte>)send)(o, Sel(sel)) != 0;
    public static bool MsgB(IntPtr o, string sel, IntPtr a) => ((delegate* unmanaged<IntPtr, IntPtr, IntPtr, byte>)send)(o, Sel(sel), a) != 0;
    public static long MsgL(IntPtr o, string sel) => ((delegate* unmanaged<IntPtr, IntPtr, long>)send)(o, Sel(sel));
    public static float MsgF(IntPtr o, string sel) => ((delegate* unmanaged<IntPtr, IntPtr, float>)send)(o, Sel(sel));
    public static CGSize MsgSize(IntPtr o, string sel) => ((delegate* unmanaged<IntPtr, IntPtr, CGSize>)send)(o, Sel(sel));
    public static CMTime MsgTime(IntPtr o, string sel) => ((delegate* unmanaged<IntPtr, IntPtr, CMTime>)send)(o, Sel(sel));
    public static void MsgRange(IntPtr o, string sel, CMTimeRange r) => ((delegate* unmanaged<IntPtr, IntPtr, CMTimeRange, void>)send)(o, Sel(sel), r);
    public static void Msg0(IntPtr o, string sel) => ((delegate* unmanaged<IntPtr, IntPtr, void>)send)(o, Sel(sel));

    public static IntPtr Str(string s)
    {
        var p = Marshal.StringToCoTaskMemUTF8(s);
        try { return Msg(Cls("NSString"), "stringWithUTF8String:", p); }
        finally { Marshal.FreeCoTaskMem(p); }
    }

    public static string ToStr(IntPtr ns) => ns == IntPtr.Zero ? null : Marshal.PtrToStringUTF8(Msg(ns, "UTF8String"));
    public static IntPtr Int(int v) => MsgInt(Cls("NSNumber"), "numberWithInt:", v);
    public static IntPtr Bool(bool v) => MsgBool(Cls("NSNumber"), "numberWithBool:", v);
    public static IntPtr Retain(IntPtr o) => o == IntPtr.Zero ? o : Msg(o, "retain");
    public static void Release(IntPtr o) { if (o != IntPtr.Zero) Msg0(o, "release"); }

    public static IntPtr Dict(params (IntPtr key, IntPtr val)[] kv)
    {
        var keys = stackalloc IntPtr[kv.Length];
        var vals = stackalloc IntPtr[kv.Length];
        for (int i = 0; i < kv.Length; i++) { keys[i] = kv[i].key; vals[i] = kv[i].val; }
        return Msg(Cls("NSDictionary"), "dictionaryWithObjects:forKeys:count:", (IntPtr)vals, (IntPtr)keys, (nuint)kv.Length);
    }

    /// <summary>framework 匯出的 NSString* 常數（AVMediaTypeVideo 之類）</summary>
    public static IntPtr Const(IntPtr framework, string name) => *(IntPtr*)NativeLibrary.GetExport(framework, name);
}

[StructLayout(LayoutKind.Sequential)] struct CGSize { public double W, H; }
[StructLayout(LayoutKind.Sequential)] struct CMTime { public long Value; public int Timescale; public uint Flags; public long Epoch; }
[StructLayout(LayoutKind.Sequential)] struct CMTimeRange { public CMTime Start, Duration; }

sealed unsafe class MacVideoDecoder : VideoDecoder
{
    const string AVF = "/System/Library/Frameworks/AVFoundation.framework/AVFoundation";
    const string CM = "/System/Library/Frameworks/CoreMedia.framework/CoreMedia";
    const string CV = "/System/Library/Frameworks/CoreVideo.framework/CoreVideo";
    const string CF = "/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation";
    [DllImport(CM)] static extern CMTime CMSampleBufferGetPresentationTimeStamp(IntPtr sbuf);
    [DllImport(CM)] static extern IntPtr CMSampleBufferGetImageBuffer(IntPtr sbuf);
    [DllImport(CM)] static extern IntPtr CMSampleBufferGetDataBuffer(IntPtr sbuf);
    [DllImport(CM)] static extern nuint CMBlockBufferGetDataLength(IntPtr bb);
    [DllImport(CM)] static extern int CMBlockBufferCopyDataBytes(IntPtr bb, nuint offset, nuint len, void* dst);
    [DllImport(CM)] static extern double CMTimeGetSeconds(CMTime t);
    [DllImport(CM)] static extern CMTime CMTimeMakeWithSeconds(double seconds, int timescale);
    [DllImport(CV)] static extern int CVPixelBufferLockBaseAddress(IntPtr pb, ulong flags);
    [DllImport(CV)] static extern int CVPixelBufferUnlockBaseAddress(IntPtr pb, ulong flags);
    [DllImport(CV)] static extern IntPtr CVPixelBufferGetBaseAddress(IntPtr pb);
    [DllImport(CV)] static extern nuint CVPixelBufferGetBytesPerRow(IntPtr pb);
    [DllImport(CV)] static extern nuint CVPixelBufferGetWidth(IntPtr pb);
    [DllImport(CV)] static extern nuint CVPixelBufferGetHeight(IntPtr pb);
    [DllImport(CF)] static extern void CFRelease(IntPtr p);

    static IntPtr avf, cm, cv;
    const int Ahead = 6;
    const uint GL_BGRA = 0x80E1, GL_UNPACK_ROW_LENGTH = 0x0CF2;

    readonly string path;
    IntPtr asset, vtrack, atrack;
    Thread vthread, athread;
    volatile bool stop;
    int generation;
    readonly object gate = new object();
    readonly Queue<(double pts, IntPtr sbuf)> frames = new Queue<(double, IntPtr)>();
    IntPtr current;      // 要顯示的那一格（CMSampleBuffer，持有）
    bool dirty, any;
    int texW, texH;

    /// <summary>宿主開機時掛上（只有 macOS）</summary>
    public static void Install()
    {
        if (!OperatingSystem.IsMacOS()) return;
        try
        {
            avf = NativeLibrary.Load(AVF);
            cm = NativeLibrary.Load(CM);
            cv = NativeLibrary.Load(CV);
        }
        catch (Exception e) { Console.WriteLine("[影片] 載不了 AVFoundation：" + e.Message); return; }
        VideoDecoders.Open = p => new MacVideoDecoder(p);
    }

    MacVideoDecoder(string path)
    {
        this.path = path;
        var pool = ObjC.objc_autoreleasePoolPush();
        try
        {
            var url = ObjC.Msg(ObjC.Cls("NSURL"), "fileURLWithPath:", ObjC.Str(path));
            asset = ObjC.Retain(ObjC.Msg(ObjC.Cls("AVURLAsset"), "URLAssetWithURL:options:", url, IntPtr.Zero));
            if (asset == IntPtr.Zero) { Error = "AVURLAsset 打不開 " + path; return; }
            vtrack = ObjC.Retain(FirstTrack(ObjC.Const(avf, "AVMediaTypeVideo")));
            atrack = ObjC.Retain(FirstTrack(ObjC.Const(avf, "AVMediaTypeAudio")));
            if (vtrack == IntPtr.Zero) { Error = "沒有影像軌：" + path; return; }
            var size = ObjC.MsgSize(vtrack, "naturalSize");
            Width = (int)size.W; Height = (int)size.H;
            FrameRate = ObjC.MsgF(vtrack, "nominalFrameRate");
            Length = CMTimeGetSeconds(ObjC.MsgTime(asset, "duration"));
            AudioChannels = atrack != IntPtr.Zero ? 2 : 0;
        }
        finally { ObjC.objc_autoreleasePoolPop(pool); }
    }

    IntPtr FirstTrack(IntPtr mediaType)
    {
        var arr = ObjC.Msg(asset, "tracksWithMediaType:", mediaType);
        return arr != IntPtr.Zero && ObjC.MsgL(arr, "count") > 0 ? ObjC.MsgIndex(arr, "objectAtIndex:", 0) : IntPtr.Zero;
    }

    public override bool HasFrame { get { lock (gate) return any; } }

    public override void Seek(double t)
    {
        StopThreads();
        lock (gate)
        {
            while (frames.Count > 0) CFRelease(frames.Dequeue().sbuf);
            if (current != IntPtr.Zero) { CFRelease(current); current = IntPtr.Zero; }
            dirty = false; any = false;
        }
        if (Error != null || asset == IntPtr.Zero) return;
        stop = false;
        int gen = ++generation;
        Audio.Reset((long)Math.Round(t * AudioEngine.Rate));
        vthread = new Thread(() => VideoLoop(t, gen)) { IsBackground = true, Name = "影片解碼" };
        vthread.Start();
        if (atrack != IntPtr.Zero)
        {
            athread = new Thread(() => AudioLoop(t)) { IsBackground = true, Name = "影片聲音" };
            athread.Start();
        }
    }

    void StopThreads()
    {
        stop = true;
        lock (gate) Monitor.PulseAll(gate);
        Audio.Close();
        vthread?.Join(); athread?.Join();
        vthread = athread = null;
    }

    IntPtr NewReader(IntPtr track, IntPtr settings, double t, out IntPtr output)
    {
        output = IntPtr.Zero;
        IntPtr err = IntPtr.Zero;
        var reader = ObjC.Msg(ObjC.Cls("AVAssetReader"), "assetReaderWithAsset:error:", asset, (IntPtr)(&err));
        if (reader == IntPtr.Zero) { Error = "AVAssetReader 開不了：" + ObjC.ToStr(ObjC.Msg(err, "localizedDescription")); return IntPtr.Zero; }
        output = ObjC.Msg(ObjC.Cls("AVAssetReaderTrackOutput"), "assetReaderTrackOutputWithTrack:outputSettings:", track, settings);
        ObjC.MsgVoidBool(output, "setAlwaysCopiesSampleData:", false);
        if (!ObjC.MsgB(reader, "canAddOutput:", output)) { Error = "AVAssetReader 不能加 output"; return IntPtr.Zero; }
        ObjC.Msg(reader, "addOutput:", output);
        if (t > 0)
        {
            var inf = *(CMTime*)NativeLibrary.GetExport(cm, "kCMTimePositiveInfinity");
            ObjC.MsgRange(reader, "setTimeRange:", new CMTimeRange { Start = CMTimeMakeWithSeconds(t, 90000), Duration = inf });
        }
        if (!ObjC.MsgB(reader, "startReading"))
        {
            Error = "AVAssetReader startReading 失敗：" + ObjC.ToStr(ObjC.Msg(ObjC.Msg(reader, "error"), "localizedDescription"));
            return IntPtr.Zero;
        }
        return ObjC.Retain(reader);
    }

    void VideoLoop(double t, int gen)
    {
        IntPtr reader = IntPtr.Zero;
        var pool = ObjC.objc_autoreleasePoolPush();
        try
        {
            var settings = ObjC.Dict((ObjC.Const(cv, "kCVPixelBufferPixelFormatTypeKey"), ObjC.Int(0x42475241))); // 'BGRA'
            reader = NewReader(vtrack, settings, t, out var output);
            if (reader == IntPtr.Zero) return;
            while (!stop)
            {
                lock (gate)
                {
                    while (!stop && frames.Count >= Ahead) Monitor.Wait(gate, 100);
                    if (stop) break;
                }
                var p = ObjC.objc_autoreleasePoolPush();
                var sb = ObjC.Msg(output, "copyNextSampleBuffer");
                ObjC.objc_autoreleasePoolPop(p);
                if (sb == IntPtr.Zero)
                {
                    if (ObjC.MsgL(reader, "status") == 3) Error = "影片解碼失敗：" + ObjC.ToStr(ObjC.Msg(ObjC.Msg(reader, "error"), "localizedDescription"));
                    break;
                }
                if (CMSampleBufferGetImageBuffer(sb) == IntPtr.Zero) { CFRelease(sb); continue; }
                double pts = CMTimeGetSeconds(CMSampleBufferGetPresentationTimeStamp(sb));
                lock (gate)
                {
                    if (stop || gen != generation) { CFRelease(sb); break; }
                    frames.Enqueue((pts, sb));
                    any = true;
                }
            }
        }
        catch (Exception e) { Error = "影片解碼例外：" + e.Message; }
        finally
        {
            if (reader != IntPtr.Zero) { ObjC.Msg0(reader, "cancelReading"); ObjC.Release(reader); }
            ObjC.objc_autoreleasePoolPop(pool);
        }
    }

    void AudioLoop(double t)
    {
        IntPtr reader = IntPtr.Zero;
        var pool = ObjC.objc_autoreleasePoolPush();
        try
        {
            var settings = ObjC.Dict(
                (ObjC.Const(avf, "AVFormatIDKey"), ObjC.Int(0x6C70636D)), // 'lpcm'
                (ObjC.Const(avf, "AVSampleRateKey"), ObjC.Int(AudioEngine.Rate)),
                (ObjC.Const(avf, "AVNumberOfChannelsKey"), ObjC.Int(2)),
                (ObjC.Const(avf, "AVLinearPCMBitDepthKey"), ObjC.Int(32)),
                (ObjC.Const(avf, "AVLinearPCMIsFloatKey"), ObjC.Bool(true)),
                (ObjC.Const(avf, "AVLinearPCMIsBigEndianKey"), ObjC.Bool(false)),
                (ObjC.Const(avf, "AVLinearPCMIsNonInterleaved"), ObjC.Bool(false)));
            reader = NewReader(atrack, settings, t, out var output);
            if (reader == IntPtr.Zero) return;
            var buf = new float[0];
            while (!stop)
            {
                var p = ObjC.objc_autoreleasePoolPush();
                var sb = ObjC.Msg(output, "copyNextSampleBuffer");
                ObjC.objc_autoreleasePoolPop(p);
                if (sb == IntPtr.Zero) break;
                try
                {
                    var bb = CMSampleBufferGetDataBuffer(sb);
                    if (bb == IntPtr.Zero) continue;
                    int bytes = (int)CMBlockBufferGetDataLength(bb);
                    int n = bytes / 8;
                    if (buf.Length < n * 2) buf = new float[n * 2];
                    fixed (float* d = buf) CMBlockBufferCopyDataBytes(bb, 0, (nuint)bytes, d);
                    long at = (long)Math.Round(CMTimeGetSeconds(CMSampleBufferGetPresentationTimeStamp(sb)) * AudioEngine.Rate);
                    if (!Audio.Write(at, buf, n)) break;
                }
                finally { CFRelease(sb); }
            }
        }
        catch (Exception e) { Console.WriteLine("[影片] 聲音解碼例外：" + e.Message); }
        finally
        {
            if (reader != IntPtr.Zero) { ObjC.Msg0(reader, "cancelReading"); ObjC.Release(reader); }
            ObjC.objc_autoreleasePoolPop(pool);
        }
    }

    public override void Advance(double t)
    {
        lock (gate)
        {
            bool took = false;
            // 第一格（時間戳可能不是 0）不管時間先拿：準備好就有畫面
            while (frames.Count > 0 && (frames.Peek().pts <= t + 1e-4 || current == IntPtr.Zero))
            {
                var f = frames.Dequeue();
                if (current != IntPtr.Zero) CFRelease(current);
                current = f.sbuf;
                took = true;
            }
            if (took) { dirty = true; Monitor.PulseAll(gate); }
        }
    }

    public override void Upload()
    {
        IntPtr sb;
        lock (gate)
        {
            if (!dirty || current == IntPtr.Zero) return;
            dirty = false;
            sb = current;
            Msg.CFRetain(sb);
        }
        try
        {
            var pb = CMSampleBufferGetImageBuffer(sb);
            CVPixelBufferLockBaseAddress(pb, 1);
            try
            {
                int w = (int)CVPixelBufferGetWidth(pb), h = (int)CVPixelBufferGetHeight(pb), bpr = (int)CVPixelBufferGetBytesPerRow(pb);
                if (Texture == 0 || w != texW || h != texH)
                {
                    if (Texture == 0) Texture = GL.Gen(GL.glGenTextures);
                    GL.BindTexture(GL.TEXTURE_2D, Texture);
                    GL.glTexImage2D(GL.TEXTURE_2D, 0, (int)GL.RGBA8, w, h, 0, GL_BGRA, GL.UNSIGNED_BYTE, null);
                    GL.glTexParameteri(GL.TEXTURE_2D, GL.TEXTURE_MIN_FILTER, (int)GL.LINEAR);
                    GL.glTexParameteri(GL.TEXTURE_2D, GL.TEXTURE_MAG_FILTER, (int)GL.LINEAR);
                    GL.glTexParameteri(GL.TEXTURE_2D, GL.TEXTURE_WRAP_S, (int)GL.CLAMP_TO_EDGE);
                    GL.glTexParameteri(GL.TEXTURE_2D, GL.TEXTURE_WRAP_T, (int)GL.CLAMP_TO_EDGE);
                    texW = w; texH = h;
                }
                GL.BindTexture(GL.TEXTURE_2D, Texture);
                GL.glPixelStorei(GL_UNPACK_ROW_LENGTH, bpr / 4);
                GL.glTexSubImage2D(GL.TEXTURE_2D, 0, 0, 0, w, h, GL_BGRA, GL.UNSIGNED_BYTE, (void*)CVPixelBufferGetBaseAddress(pb));
                GL.glPixelStorei(GL_UNPACK_ROW_LENGTH, 0);
            }
            finally { CVPixelBufferUnlockBaseAddress(pb, 1); }
        }
        finally { CFRelease(sb); }
    }

    public override void Dispose()
    {
        stop = true;
        lock (gate) Monitor.PulseAll(gate);
        Audio.Close();
        vthread?.Join(); athread?.Join();
        lock (gate)
        {
            while (frames.Count > 0) CFRelease(frames.Dequeue().sbuf);
            if (current != IntPtr.Zero) { CFRelease(current); current = IntPtr.Zero; }
        }
        if (Texture != 0) { uint t = Texture; GL.DeleteTextures(1, &t); Texture = 0; }
        ObjC.Release(vtrack); ObjC.Release(atrack); ObjC.Release(asset);
        vtrack = atrack = asset = IntPtr.Zero;
    }

    static class Msg
    {
        [DllImport(CF)] public static extern IntPtr CFRetain(IntPtr p);
    }
}

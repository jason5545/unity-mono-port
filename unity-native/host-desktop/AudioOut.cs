// 桌面宿主的聲音輸出：引擎每格混好的 48 kHz 立體聲 float（AudioEngine.Sink）轉成 16 位元，排進 OpenAL（OpenAL Soft）的串流佇列。
// 佇列超過 MaxQueued 秒就丟掉這一段（遊戲跑得比實際時間快，例如不帶 --realtime 時），避免延遲越積越多。
using System;
using System.Collections.Generic;
using Silk.NET.OpenAL;

sealed unsafe class AudioOut : IDisposable
{
    const double MaxQueued = 0.25;
    readonly ALContext alc;
    readonly AL al;
    readonly Device* device;
    readonly Context* context;
    readonly uint source;
    readonly Queue<(uint id, int frames)> queued = new Queue<(uint, int)>();
    readonly Stack<uint> free = new Stack<uint>();
    int queuedFrames;
    short[] pcm = new short[0];

    public static AudioOut TryOpen()
    {
        try { return new AudioOut(); }
        catch (Exception e) { Console.WriteLine("[聲音] 開不了輸出裝置：" + e.Message); return null; }
    }

    AudioOut()
    {
        alc = ALContext.GetApi(true);
        al = AL.GetApi(true);
        device = alc.OpenDevice("");
        if (device == null) throw new Exception("OpenDevice 失敗");
        context = alc.CreateContext(device, null);
        alc.MakeContextCurrent(context);
        source = al.GenSource();
        Console.WriteLine("[聲音] OpenAL 輸出：" + UnityNative.AudioEngine.Rate + " Hz 立體聲");
    }

    public void Push(float[] buf, int frames)
    {
        // 收回播完的緩衝
        al.GetSourceProperty(source, GetSourceInteger.BuffersProcessed, out int processed);
        for (int i = 0; i < processed && queued.Count > 0; i++)
        {
            var (id, f) = queued.Dequeue();
            uint b = id;
            al.SourceUnqueueBuffers(source, 1, &b);
            queuedFrames -= f;
            free.Push(id);
        }
        if (queuedFrames > MaxQueued * UnityNative.AudioEngine.Rate) return;
        if (pcm.Length < frames * 2) pcm = new short[frames * 2];
        for (int i = 0; i < frames * 2; i++)
        {
            float v = buf[i];
            pcm[i] = (short)(v >= 1 ? 32767 : v <= -1 ? -32767 : v * 32767);
        }
        uint id2 = free.Count > 0 ? free.Pop() : al.GenBuffer();
        fixed (short* p = pcm) al.BufferData(id2, BufferFormat.Stereo16, p, frames * 4, UnityNative.AudioEngine.Rate);
        uint q = id2;
        al.SourceQueueBuffers(source, 1, &q);
        queued.Enqueue((id2, frames));
        queuedFrames += frames;
        al.GetSourceProperty(source, GetSourceInteger.SourceState, out int state);
        if (state != (int)SourceState.Playing && queuedFrames > UnityNative.AudioEngine.Rate / 20) al.SourcePlay(source);
    }

    public void Dispose()
    {
        al.SourceStop(source);
        al.DeleteSource(source);
        alc.MakeContextCurrent(null);
        alc.DestroyContext(context);
        alc.CloseDevice(device);
    }
}

// UnityEngine 的替身：只有亂數情境用到的部分。
// UnityEngine.Random 是 Unity 原生（沒有 C# 原始碼），這裡是對 Xorshift128 的假設，跟 src/csport/runtime.ts 各自獨立寫一份；
// 兩邊對得上只證明轉換器忠實，Unity 原生演算法本身要用 tools/unity-ref.sh 的結果驗證。
using System;

namespace UnityEngine
{
    [AttributeUsage(AttributeTargets.Field)]
    public sealed class SerializeField : Attribute { }

    public static class Random
    {
        [Serializable]
        public struct State
        {
            public int s0, s1, s2, s3;
        }

        static State st;
        public static State state { get => st; set => st = value; }

        public static void InitState(int seed)
        {
            uint s0 = (uint)seed;
            uint s1 = unchecked(s0 * 1812433253u + 1u);
            uint s2 = unchecked(s1 * 1812433253u + 1u);
            uint s3 = unchecked(s2 * 1812433253u + 1u);
            st = new State { s0 = (int)s0, s1 = (int)s1, s2 = (int)s2, s3 = (int)s3 };
        }

        static uint Next()
        {
            uint t = (uint)st.s0;
            t ^= t << 11;
            t ^= t >> 8;
            uint w = (uint)st.s3;
            st.s0 = st.s1;
            st.s1 = st.s2;
            st.s2 = st.s3;
            w = w ^ (w >> 19) ^ t;
            st.s3 = (int)w;
            return w;
        }

        public static int Range(int min, int max)
        {
            if (min < max) return min + (int)(Next() % (uint)(max - min));
            if (min > max) return min - (int)(Next() % (uint)(min - max));
            return min;
        }

        public static float Range(float min, float max)
        {
            float t = (Next() & 0x7FFFFF) / 8388607f;
            return t * min + (1f - t) * max;
        }
    }
}

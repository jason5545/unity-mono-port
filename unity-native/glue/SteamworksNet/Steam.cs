// redirects.txt 把 Steamworks.NET 的 SteamAPI 接到這裡：Steam 沒在跑（原版沒開 Steam 時 SteamAPI_Init 就是回 false）。
// 遊戲的 SteamManager 看到沒初始化就不叫其他 Steam API（RunCallbacks、SetWarningMessageHook、Shutdown 都先看 m_bInitialized）。
using Steamworks;

namespace Glue.SteamworksNet
{
    public static class SteamAPI
    {
        public static bool RestartAppIfNecessary(AppId_t unOwnAppID) => false;
        public static bool Init() => false;
        public static void Shutdown() { }
        public static void RunCallbacks() { }
    }
}

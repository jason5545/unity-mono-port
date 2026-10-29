// RandomManager 參照到、但這個情境用不到的 MT2 類別：只留簽章讓原版程式碼編譯得過。
// Log 照原版的簽章（ShinyShoe/Logging/Log.cs），不輸出。
using System.Runtime.CompilerServices;

namespace ShinyShoe.Logging
{
    public static class Log
    {
        public static void Info(LogGroups group, string message, LogOptions options = LogOptions.None) { }
        public static void Error(LogGroups group, string message, LogOptions options = LogOptions.None, [CallerMemberName] string methodName = "???", [CallerFilePath] string sourceFile = "???", [CallerLineNumber] int lineNumber = 0) { }
        public static void Assert(bool exprTrue, LogGroups group, string message = "", LogOptions options = LogOptions.None, [CallerMemberName] string methodName = "???", [CallerFilePath] string sourceFile = "???", [CallerLineNumber] int lineNumber = 0) { }
    }
}

public class SaveManager
{
    public bool PreviewMode;
}

public class GrantableRewardData
{
    public string GetRngDeterminismID() => "";
}

public class MerchantGoodState
{
    public GrantableRewardData RewardData;
    public int IncrNumRngOffers(int seed) => 0;
}

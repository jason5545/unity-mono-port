// MT2 的相容層：轉換器產生的 gen/*.ts 呼叫 R.<型別>_<成員>。
// 通用的部分在工具包（../unity-cs2ts/runtime/src/csport：core 是實體與分派，dotnet 是 System.*，unity 是 UnityEngine 原生），
// 這裡只放 MT2 自己用到、工具包沒有的部分（沒有原始碼的 DLL）。原版的 Assembly-CSharp 整個轉（cs2ts.json 的 web 目標，參數 *），
// 遊戲自己的類別不在這裡手寫。用相對路徑 re-export：轉換器的 ReadExports 會跟進去，這些名字就算相容層有。
export * from '../../../unity-cs2ts/runtime/src/csport/core';
export * from '../../../unity-cs2ts/runtime/src/csport/dotnet';
export * from '../../../unity-cs2ts/runtime/src/csport/unity';
// MT2 用 Facepunch.Steamworks：網頁上回答成離線的 Steam（平台逼的差異，見該檔檔頭）
export * from '../../../unity-cs2ts/runtime/src/csport/steamworks';

import type { Ctx } from '../../../unity-cs2ts/runtime/src/csport/core';

// ───────── ShinyShoe 改過的 Spine 執行環境（DLL，沒有原始碼） ─────────

/** SpineShinyShoeLogging.SetLoggingCallbacks：Spine 的記錄接到遊戲的 Log；網頁上的 Spine 還沒接，先不動作 */
export function SpineShinyShoeLogging_SetLoggingCallbacks(c: Ctx, ...a: unknown[]): void {
  void c;
  void a;
}

// 相容層（選用）：Facepunch.Steamworks。網頁上沒有 Steam，這是平台逼的差異：回答成「Steam 用戶端在、離線、本機一個玩家」。
// 用到 Facepunch.Steamworks 的遊戲在自己的相容層 export * 這裡。
//   - SteamClient.Init 成功、IsValid true；SteamId 固定（setSteamUser 可改）；名字預設 Player。
//   - 好友、頭像、Rich Presence、Overlay、Steam Input 的控制器：都是空的或不動作。
//   - 成就：Steam 端的成就清單拿不到（Achievements 是空的），Trigger 記在本機（steamAchievementsUnlocked）。
//   - DLC：預設都沒有（setSteamDlcOwned 指定擁有的 AppId；'all' 是全部擁有）。
//   - 驗證票（GetAuthSessionTicketAsync）：沒有（null），遊戲的後端登入照離線處理。
//   - 介面語言（SteamUILanguage、GameLanguage）：Steam 用戶端的語言在網頁上對應瀏覽器的語言（navigator.languages 的第一個），
//     換成 Steam 的語言名（zh-TW → tchinese）；setSteamLanguage 可改。遊戲自己存的語言設定照樣優先（那是遊戲的事）。

import type { Ctx } from './core';
import { registerReflectionType } from './dotnetReflection';

let user = { id: '76561197960265728', name: 'Player' };
const ownedDlc = new Set<number>();
let allDlcOwned = false;
const unlocked = new Set<string>();
let language = browserSteamLanguage(typeof navigator !== 'undefined' ? navigator.languages : []);

/**
 * 瀏覽器語言（BCP 47）→ Steam 的語言名（Steamworks 文件 Languages 頁的 API language code）。
 * 中文照文字：繁體（zh-TW、zh-HK、zh-MO、zh-Hant）是 tchinese，其他中文是 schinese；
 * 葡萄牙文巴西是 brazilian；西班牙文西班牙以外的地區是 latam；挪威文三種寫法都是 norwegian。沒有對應的回 english
 */
export function browserSteamLanguage(langs: readonly string[]): string {
  const tag = (langs[0] ?? 'en').toLowerCase();
  const [base, ...rest] = tag.split('-');
  const sub = rest.join('-');
  if (base === 'zh') return /^(tw|hk|mo|hant)\b/.test(sub) ? 'tchinese' : 'schinese';
  if (base === 'pt') return sub === 'br' ? 'brazilian' : 'portuguese';
  if (base === 'es') return sub && sub !== 'es' ? 'latam' : 'spanish';
  const byBase: Record<string, string> = {
    ar: 'arabic', bg: 'bulgarian', cs: 'czech', da: 'danish', nl: 'dutch', en: 'english', fi: 'finnish', fr: 'french', de: 'german', el: 'greek',
    hu: 'hungarian', id: 'indonesian', it: 'italian', ja: 'japanese', ko: 'koreana', no: 'norwegian', nb: 'norwegian', nn: 'norwegian', pl: 'polish',
    ro: 'romanian', ru: 'russian', sv: 'swedish', th: 'thai', tr: 'turkish', uk: 'ukrainian', vi: 'vietnamese',
  };
  return byBase[base] ?? 'english';
}

export function setSteamUser(id: string, name: string): void {
  user = { id, name };
}
export function setSteamDlcOwned(appIds: number[] | 'all'): void {
  ownedDlc.clear();
  allDlcOwned = appIds === 'all';
  if (appIds !== 'all') for (const a of appIds) ownedDlc.add(a);
}
/** Steam 介面語言（SteamUtils.SteamUILanguage、SteamApps.GameLanguage）：Steam 的語言名（english、tchinese、schinese…） */
export function setSteamLanguage(l: string): void {
  language = l;
}
export function steamAchievementsUnlocked(): string[] {
  return [...unlocked];
}

type SteamId = { $type: 'SteamId'; Value: string };
const steamId = (v: string): SteamId => ({ $type: 'SteamId', Value: v });

export const SteamClient_Init = (_c: Ctx, appId: number, asyncCallbacks?: boolean): void => void [appId, asyncCallbacks];
export const SteamClient_Shutdown = (_c: Ctx): void => undefined;
export const SteamClient_RunCallbacks = (_c: Ctx): void => undefined;
export const SteamClient_RestartAppIfNecessary = (_c: Ctx, appId: number): boolean => (void (appId), false);
export const SteamClient_get_IsValid = (_c: Ctx): boolean => true;
export const SteamClient_get_IsLoggedOn = (_c: Ctx): boolean => false;
export const SteamClient_get_SteamId = (_c: Ctx): SteamId => steamId(user.id);
export const SteamClient_get_Name = (_c: Ctx): string => user.name;
export const SteamClient_get_AppId = (_c: Ctx): number => 0;
export const SteamId_ToString = (_c: Ctx, id: SteamId): string => id.Value;
export const SteamId_op_Implicit$UInt64 = (_c: Ctx, v: number | string): SteamId => steamId(String(v));
export const SteamId_op_Implicit$SteamId = (_c: Ctx, id: SteamId): string => id.Value;
export const SteamId_get_IsValid = (_c: Ctx, id: SteamId): boolean => !!id?.Value && id.Value !== '0';
export const AppId_op_Implicit$int = (_c: Ctx, v: number): number => v;
export const AppId_op_Implicit$UInt32 = AppId_op_Implicit$int;
export const AppId_op_Implicit$AppId = AppId_op_Implicit$int;

export const SteamUtils_get_IsOverlayEnabled = (_c: Ctx): boolean => false;
export const SteamUtils_get_IsSteamInBigPictureMode = (_c: Ctx): boolean => false;
export const SteamUtils_get_IsRunningOnSteamDeck = (_c: Ctx): boolean => false;
export const SteamUtils_get_SteamUILanguage = (_c: Ctx): string => language;
export const SteamUtils_set_OverlayNotificationPosition = (_c: Ctx, v: number): void => void v;
export const SteamUtils_ShowGamepadTextInput = (_c: Ctx, ...a: unknown[]): boolean => (void (a), false);
export const SteamUtils_GetEnteredGamepadText = (_c: Ctx): string => '';
export const SteamUtils_get_SecondsSinceAppActive = (_c: Ctx): number => 0;
export const SteamApps_IsDlcInstalled = (_c: Ctx, appId: number): boolean => allDlcOwned || ownedDlc.has(Number(appId));
export const SteamApps_get_GameLanguage = (_c: Ctx): string => language;
export const SteamApps_get_IsSubscribed = (_c: Ctx): boolean => true;
export const SteamApps_get_BuildId = (_c: Ctx): number => 0;

export const SteamFriends_GetFriends = (_c: Ctx): unknown[] => [];
export const SteamFriends_SetRichPresence = (_c: Ctx, k: string, v: string): boolean => (void ([k, v]), true);
export const SteamFriends_ClearRichPresence = (_c: Ctx): void => undefined;
export const SteamFriends_OpenStoreOverlay = (_c: Ctx, ...a: unknown[]): void => void a;
export const SteamFriends_OpenWebOverlay = (_c: Ctx, url: string, ...a: unknown[]): void => void [url, a];
export const SteamFriends_GetSmallAvatarAsync = (_c: Ctx, id: SteamId): Promise<null> => Promise.resolve((void id, null));
export const SteamFriends_GetMediumAvatarAsync = SteamFriends_GetSmallAvatarAsync;
export const SteamFriends_GetLargeAvatarAsync = SteamFriends_GetSmallAvatarAsync;
export const Friend_get_Id = (_c: Ctx, f: { Id: SteamId }): SteamId => f.Id;
export const Friend_get_Name = (_c: Ctx, f: { Name: string }): string => f.Name;

export const SteamUser_GetAuthSessionTicketAsync = (_c: Ctx, ...a: unknown[]): Promise<null> => Promise.resolve((void (a), null));
export const SteamUser_GetAuthSessionTicket = (_c: Ctx, ...a: unknown[]): null => (void (a), null);
export const AuthTicket_get_Data = (_c: Ctx, t: { Data?: Uint8Array } | null): Uint8Array => t?.Data ?? new Uint8Array(0);
export const AuthTicket_get_Handle = (_c: Ctx, t: { Handle?: number } | null): number => t?.Handle ?? 0;
export const AuthTicket_Cancel = (_c: Ctx, t: unknown): void => void t;

export const SteamUserStats_get_StatsRecieved = (_c: Ctx): boolean => true;
export const SteamUserStats_get_Achievements = (_c: Ctx): unknown[] => [];
export const SteamUserStats_StoreStats = (_c: Ctx): boolean => true;
export const SteamUserStats_RequestCurrentStats = (_c: Ctx): boolean => true;
export const SteamUserStats_SetStat$string_int = (_c: Ctx, k: string, v: number): boolean => (void ([k, v]), true);
export const SteamUserStats_GetStatInt = (_c: Ctx, k: string): number => (void (k), 0);
export const Achievement_get_Identifier = (_c: Ctx, a: { Identifier: string }): string => a.Identifier;
export const Achievement_get_State = (_c: Ctx, a: { Identifier: string }): boolean => unlocked.has(a.Identifier);
export function Achievement_Trigger(_c: Ctx, a: { Identifier: string }, apply = true): boolean {
  void apply;
  unlocked.add(a.Identifier);
  return true;
}
export const new_Achievement = (_c: Ctx, name: string): { $type: string; Identifier: string } => ({ $type: 'Achievement', Identifier: name });

export const SteamInput_get_Controllers = (_c: Ctx): unknown[] => [];
export const SteamInput_GetPngActionGlyph = (_c: Ctx, ...a: unknown[]): string => (void (a), '');
export const SteamInput_RunFrame = (_c: Ctx): void => undefined;
export const SteamRemoteStorage_get_IsCloudEnabled = (_c: Ctx): boolean => false;
export const SteamRemoteStorage_get_IsCloudEnabledForAccount = (_c: Ctx): boolean => false;
export const SteamRemoteStorage_get_IsCloudEnabledForApp = (_c: Ctx): boolean => false;
export const SteamScreenshots_TriggerScreenshot = (_c: Ctx): void => undefined;

// HackFixInitSteamInput（MT2 等遊戲用反射叫 Facepunch 的內部 SteamClientClass<SteamInput>.Interface.Init(false)）：給一個假的介面物件，Init 不動作
const STEAM_INPUT_IFACE = { $type: 'SteamInputInterfaceStub' };
registerReflectionType('SteamClientClass$1', { fields: { Interface: () => STEAM_INPUT_IFACE } });
registerReflectionType('SteamInputInterfaceStub', { methods: { Init: () => undefined } });

// 相容層：資產的載入與幾種資產物件（Addressables 的入口、Hash128、TextAsset、Sprite／Texture 的讀值、UnityWebRequest、
// TrailRenderer）。unity.ts 會 export * 這裡。
//
// Addressables：AssetReference、AsyncOperationBase 這些 C# 類別跟著遊戲一起轉（Unity.Addressables／Unity.ResourceManager 的原始碼），
// 只有入口的靜態類別 Addressables（遊戲專案設定檔的 exclude）在這裡接到物件庫（unity/objectStore.ts）：
// key（Hash128、GUID 字串、AssetReference）→ GUID → 預載依賴 → 下一格在主迴圈完成（Status、Result、Completed 事件）。
// 資產包（AssetBundle）、目錄（catalog）、下載這些不需要：資產已經由匯入器匯出。
// 與原版的差異：載入時間不同（原版從資產包讀，這裡從匯出的 JSON 讀）；位址字串（address）還沒對到 GUID，只認 GUID。

import type { World } from '../engine/world';
import type { ComponentData } from '../unity/types';
import { UriJs } from './dotnetBcl';
import { baseTypeName, eventGet, getActiveWorld, getObjectStore, materializeScriptableObject, registerExternalCtor, registerValueType, staticCtx, type Ctx } from './core';

function w(c: Ctx): World {
  const world = c.w ?? getActiveWorld();
  if (!world) throw new Error('這個呼叫要在場景裡（沒有作用中的 World）');
  return world;
}

// ───────── Hash128（Addressables 的 runtime key） ─────────

type H128 = { $type: 'Hash128'; hex: string };
export const Hash128_Parse = (_c: Ctx, s: string | null): H128 => ({ $type: 'Hash128', hex: (s ?? '').toLowerCase() });
export const Hash128_get_isValid = (_c: Ctx, h: H128): boolean => !!h?.hex && /[1-9a-f]/.test(h.hex);
export const Hash128_ToString = (_c: Ctx, h: H128): string => h?.hex ?? '';
export const Hash128_op_Equality = (_c: Ctx, a: H128, b: H128): boolean => (a?.hex ?? '') === (b?.hex ?? '');
export const Hash128_op_Inequality = (c: Ctx, a: H128, b: H128): boolean => !Hash128_op_Equality(c, a, b);
export const Hash128_Equals$Hash128 = Hash128_op_Equality;
export const Hash128_Equals$Object = Hash128_op_Equality;
export const Hash128_GetHashCode = (_c: Ctx, h: H128): number => {
  let x = 0;
  for (const ch of h?.hex ?? '') x = (Math.imul(x, 31) + ch.charCodeAt(0)) | 0;
  return x;
};
export const Hash128_Compute$string = (_c: Ctx, s: string): H128 => {
  // 不是 Unity 的雜湊算法（未查證），只保證同一個字串同一個值
  let a = 0x811c9dc5;
  let b = 0x01000193;
  for (let i = 0; i < s.length; i++) {
    a = Math.imul(a ^ s.charCodeAt(i), 16777619) >>> 0;
    b = Math.imul(b + s.charCodeAt(i), 2246822519) >>> 0;
  }
  return { $type: 'Hash128', hex: (a.toString(16).padStart(8, '0') + b.toString(16).padStart(8, '0')).repeat(2) };
};

// ───────── Addressables 的入口 ─────────

/** 舊版 Addressables 的 IAsyncOperation<T>（遊戲用介面存取：Status、Result、IsDone、Completed 事件） */
export class AddressablesOp {
  readonly $type = 'AddressablesOp';
  Status = 0; // AsyncOperationStatus：None 0、Succeeded 1、Failed 2
  Result: unknown = null;
  IsDone = false;
  IsValid = true;
  PercentComplete = 0;
  Context: unknown = null;
  Key: unknown = null;
  OperationException: unknown = null;
  Current: unknown = null;
  get isDone(): boolean {
    return this.IsDone;
  }
  Validate(): boolean {
    return this.IsValid;
  }
  Release(): void {}
  ResetStatus(): void {}
  Retain(): this {
    return this;
  }
  MoveNext(): boolean {
    return !this.IsDone;
  }
  Reset(): void {}
  finish(world: World, result: unknown, error?: unknown): void {
    world.beforeNextTick(() => {
      this.IsDone = true;
      this.PercentComplete = 1;
      this.Status = error ? 2 : 1;
      this.Result = result;
      this.OperationException = error ?? null;
      for (const f of eventGet(staticCtx, 'IAsyncOperation.Completed', this) ?? []) world.guard('IAsyncOperation.Completed', () => f(this));
    });
  }
}
/** key（GUID 字串、位址字串、Hash128、AssetReference）→ 匯出的 GUID：經過 Addressables 的對照表（ObjectStore.addressableGuid） */
function guidOfKey(key: unknown): string | null {
  if (key == null) return null;
  const store = getObjectStore();
  const viaStore = (s: string): string | null => (store ? store.addressableGuid(s) : /^[0-9a-f]{32}$/i.test(s) ? s.toLowerCase() : null);
  if (typeof key === 'string') return viaStore(key);
  const k = key as { hex?: string; m_AssetGUID?: string };
  if (typeof k.hex === 'string') return viaStore(k.hex);
  if (typeof k.m_AssetGUID === 'string') return viaStore(k.m_AssetGUID);
  return null;
}
/** 型別 → 資產參照的 fileID（Unity 的主物件慣例：Sprite 21300000、Texture2D 2800000、TextAsset 4900000、AudioClip 8300000、Material 2100000） */
const MAIN_FILE_ID: Record<string, string> = { Sprite: '21300000', Texture2D: '2800000', Texture: '2800000', TextAsset: '4900000', AudioClip: '8300000', Material: '2100000', Mesh: '4300000', AnimationClip: '7400000' };
/** GUID → 遊戲拿到的資產物件（prefab 是 GameObject 參照、ScriptableObject 是資料物件、其他是 {guid, fileID}） */
export function assetObjectOf(guid: string, type: string): unknown {
  const store = getObjectStore();
  if (!store) return null;
  if (store.isPrefab(guid)) {
    const f = store.prefabFile(guid);
    return { guid, fileID: f.roots[0] };
  }
  if (store.isScriptableObject(guid)) return materializeScriptableObject(guid);
  return { guid, fileID: MAIN_FILE_ID[type] ?? '0' };
}
function loadAsync(c: Ctx, key: unknown, type: string, then?: (r: unknown) => unknown): AddressablesOp {
  const world = w(c);
  const op = new AddressablesOp();
  op.Key = key;
  const guid = guidOfKey(key);
  const store = getObjectStore();
  if (!guid || !store) {
    op.finish(world, null, new Error(`Addressables：認不得的 key（${String((key as { hex?: string })?.hex ?? key)}；位址字串還沒對到 GUID）`));
    return op;
  }
  store.preload({ guid, fileID: store.isScriptableObject(guid) ? '11400000' : '0' }).then(
    () => {
      try {
        const r = assetObjectOf(guid, type);
        op.finish(world, then ? then(r) : r);
      } catch (e) {
        op.finish(world, null, e);
      }
    },
    (e) => op.finish(world, null, e),
  );
  return op;
}
/** Addressables.LoadAsset<T>(key)：型別名在最後（轉換器把泛型引數接在後面） */
export const Addressables_LoadAsset$Object = (c: Ctx, key: unknown, type: string): AddressablesOp => loadAsync(c, key, type);
export const Addressables_LoadAsset$IResourceLocation = Addressables_LoadAsset$Object;
export const Addressables_LoadAssetAsync$Object = Addressables_LoadAsset$Object;
export function Addressables_Instantiate$Object_InstantiationParameters(c: Ctx, key: unknown, params: { Parent?: unknown } | null): AddressablesOp {
  return loadAsync(c, key, 'GameObject', (prefab) => instantiateFromCompat(c, prefab, (params?.Parent as never) ?? null));
}
export function Addressables_Instantiate$Object_Transform_bool(c: Ctx, key: unknown, parent: unknown): AddressablesOp {
  return loadAsync(c, key, 'GameObject', (prefab) => instantiateFromCompat(c, prefab, parent));
}
export function Addressables_Instantiate$Object_Vector3_Quaternion_Transform(c: Ctx, key: unknown, pos: unknown, rot: unknown, parent: unknown): AddressablesOp {
  return loadAsync(c, key, 'GameObject', (prefab) => instantiateFromCompat(c, prefab, parent, pos, rot));
}
/** Instantiate 在 unityScene.ts（避免循環 import，開機時接上） */
let instantiateFromCompat: (c: Ctx, prefab: unknown, parent: unknown, pos?: unknown, rot?: unknown) => unknown = () => {
  throw new Error('Addressables.Instantiate：還沒接上');
};
export function setAddressablesInstantiate(fn: typeof instantiateFromCompat): void {
  instantiateFromCompat = fn;
}
export function Addressables_HasResourceLocation(c: Ctx, key: unknown, bundleNotFound: (v: string) => void): boolean {
  void c;
  bundleNotFound('');
  return !!guidOfKey(key);
}
export const Addressables_CollectBundlesAssetDependsOn = (_c: Ctx, key: unknown, out: unknown[]): void => void [key, out];
export const Addressables_ReleaseAsset = (_c: Ctx, asset: unknown): void => void asset;
export const Addressables_ReleaseInstance = (_c: Ctx, go: unknown): void => void go;
export const Addressables_get_RuntimePath = (_c: Ctx): string => '/streaming/aa';
export const Addressables_get_StreamingAssetsSubFolder = (_c: Ctx): string => 'aa';
let modifyBundlePath: unknown = null;
export const Addressables_set_ModifyAssetBundlePathFn = (_c: Ctx, f: unknown): void => void (modifyBundlePath = f);
export const Addressables_get_ModifyAssetBundlePathFn = (_c: Ctx): unknown => modifyBundlePath;
export function Addressables_Initialize(c: Ctx): AddressablesOp {
  const op = new AddressablesOp();
  op.finish(w(c), null);
  return op;
}
export const Addressables_get_InitializationOperation = Addressables_Initialize;
export function Addressables_GetDownloadSize(c: Ctx): AddressablesOp {
  const op = new AddressablesOp();
  op.finish(w(c), 0);
  return op;
}
export const Addressables_DownloadDependencies$Object = Addressables_Initialize;

// ───────── TextAsset ─────────

type AssetRef = { guid: string; fileID: string | number };
export function TextAsset_get_text(_c: Ctx, t: AssetRef | null): string {
  if (!t) throw new Error('TextAsset.text：對象是 null');
  const s = getObjectStore()?.text(t.guid);
  if (s == null) throw new Error(`TextAsset ${t.guid} 沒有匯出（匯入器的 texts.json）`);
  // UTF-8 的 BOM 不算內容（Unity 的 TextAsset.text 也是去掉的；Ink 的 JSON 檔開頭有 BOM）
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}
/** TextAsset.bytes：二進位的（.bytes，Spine 的 .skel.bytes）照原檔（ObjectStore 預載依賴時抓好），文字的照 UTF-8 編碼 */
export const TextAsset_get_bytes = (c: Ctx, t: AssetRef): Uint8Array => {
  if (!t) throw new Error('TextAsset.bytes：對象是 null');
  const b = getObjectStore()?.textBytes(t.guid);
  return b ?? new TextEncoder().encode(TextAsset_get_text(c, t));
};
export const TextAsset_ToString = TextAsset_get_text;

// ───────── Sprite、Texture（素材庫的資料；繪製端的 services.render） ─────────

/** 素材庫的 sprite（unity/assets.ts 的 SpriteInfo）：名字與樞紐是 name、pivot（匯入的 m_Name、m_Pivot 換過名字；以前讀 m_ 開頭的拿不到） */
type SpriteInfoLike = { m_Rect?: { x: number; y: number; width: number; height: number }; m_Border?: { x: number; y: number; z: number; w: number }; m_PixelsToUnits?: number; pivot?: { x: number; y: number }; textureKey?: string; name?: string };
function spriteInfo(c: Ctx, s: unknown): SpriteInfoLike | null {
  return (w(c).services.render?.spriteInfo(s as never) as SpriteInfoLike | null) ?? null;
}
export const Sprite_get_rect = (c: Ctx, s: unknown): { x: number; y: number; width: number; height: number } => ({ ...(spriteInfo(c, s)?.m_Rect ?? { x: 0, y: 0, width: 0, height: 0 }) });
export const Sprite_get_textureRect = Sprite_get_rect;
export const Sprite_get_border = (c: Ctx, s: unknown): { x: number; y: number; z: number; w: number } => ({ ...(spriteInfo(c, s)?.m_Border ?? { x: 0, y: 0, z: 0, w: 0 }) });
export const Sprite_get_pixelsPerUnit = (c: Ctx, s: unknown): number => spriteInfo(c, s)?.m_PixelsToUnits ?? 100;
export function Sprite_get_pivot(c: Ctx, s: unknown): { x: number; y: number } {
  const i = spriteInfo(c, s);
  const r = i?.m_Rect ?? { width: 0, height: 0 };
  const p = i?.pivot ?? { x: 0.5, y: 0.5 };
  return { x: p.x * r.width, y: p.y * r.height };
}
export function Sprite_get_bounds(c: Ctx, s: unknown): { center: { x: number; y: number; z: number }; extents: { x: number; y: number; z: number } } {
  const i = spriteInfo(c, s);
  const r = i?.m_Rect ?? { width: 0, height: 0 };
  const ppu = i?.m_PixelsToUnits ?? 100;
  const p = i?.pivot ?? { x: 0.5, y: 0.5 };
  const wdt = r.width / ppu;
  const hgt = r.height / ppu;
  return { center: { x: (0.5 - p.x) * wdt, y: (0.5 - p.y) * hgt, z: 0 }, extents: { x: wdt / 2, y: hgt / 2, z: 0 } };
}
export const Sprite_get_texture = (_c: Ctx, s: AssetRef | null): AssetRef | null => (s ? { guid: s.guid, fileID: '2800000' } : null);
export const Sprite_get_name = (c: Ctx, s: unknown): string => spriteInfo(c, s)?.name ?? '';
/**
 * 素材庫貼圖的寬高：先讀貼圖本身（textures.json），沒有才退回同一個 guid 的 sprite（fileID 21300000）的 m_Rect。
 * 以前只看 sprite：卡圖材質的貼圖（AnimateCardEffects 讀 _material.GetTexture(...).width）不是單張 sprite，寬高拿到 0，
 * 各層的 UV 矩陣除以 0 變成 NaN，卡圖整塊是單色
 */
function textureSizeOf(c: Ctx, t: AssetRef | null): { width: number; height: number } | null {
  if (!t || !('guid' in t)) return null;
  const render = w(c).services.render;
  const tex = render?.textureInfo?.(t as never);
  if (tex) return tex;
  const sprite = render?.spriteInfo({ guid: t.guid, fileID: '21300000' } as never) as SpriteInfoLike | null | undefined;
  return sprite?.m_Rect ?? null;
}
export function Texture_get_width(c: Ctx, t: AssetRef | { $width?: number } | null): number {
  if (t && '$width' in t && typeof t.$width === 'number') return t.$width;
  return textureSizeOf(c, t as AssetRef | null)?.width ?? 0;
}
export function Texture_get_height(c: Ctx, t: AssetRef | { $height?: number } | null): number {
  if (t && '$height' in t && typeof t.$height === 'number') return t.$height;
  return textureSizeOf(c, t as AssetRef | null)?.height ?? 0;
}
export const Texture2D_get_width = Texture_get_width;
export const Texture2D_get_height = Texture_get_height;
/** new Texture2D(w, h)：執行時期的貼圖（像素在記憶體；繪製端還沒接） */
export const new_Texture2D$int_int = (_c: Ctx, wd: number, ht: number): { $type: string; $width: number; $height: number; pixels: Uint8ClampedArray } => ({ $type: 'Texture2D', $width: wd, $height: ht, pixels: new Uint8ClampedArray(wd * ht * 4) });
export const new_Texture2D$int_int_TextureFormat_bool = (c: Ctx, wd: number, ht: number): ReturnType<typeof new_Texture2D$int_int> => new_Texture2D$int_int(c, wd, ht);
export const Texture2D_Apply$ = (_c: Ctx, t: unknown): void => void t;
export const Texture2D_Apply$bool = Texture2D_Apply$;
export function Texture2D_SetPixel$int_int_Color(_c: Ctx, t: { $width: number; pixels: Uint8ClampedArray }, x: number, y: number, col: { r: number; g: number; b: number; a: number }): void {
  const i = (y * t.$width + x) * 4;
  t.pixels[i] = col.r * 255;
  t.pixels[i + 1] = col.g * 255;
  t.pixels[i + 2] = col.b * 255;
  t.pixels[i + 3] = col.a * 255;
}
export const Texture_set_filterMode = (_c: Ctx, t: unknown, v: number): void => void [t, v];
export const Texture_set_wrapMode = Texture_set_filterMode;
export const Texture_get_filterMode = (_c: Ctx, t: unknown): number => (void t, 1);

// ───────── UnityWebRequest（網頁版不連開發商的後端：一律當離線，請求在下一格以連線錯誤結束） ─────────

export class WebRequestJs {
  readonly $type = 'UnityWebRequest';
  isDone = false;
  result = 0; // UnityWebRequest.Result：InProgress 0、Success 1、ConnectionError 2、ProtocolError 3、DataProcessingError 4
  error: string | null = null;
  responseCode = 0;
  downloadHandler: { $type: string; text: string; data: Uint8Array } = { $type: 'DownloadHandlerBuffer', text: '', data: new Uint8Array(0) };
  uploadHandler: unknown = null;
  timeout = 0;
  headers: Record<string, string> = {};
  get uri(): UriJs {
    return new UriJs(this.url);
  }
  constructor(
    public url: string,
    public method: string,
  ) {}
}
const newReq = (url: string, method: string): WebRequestJs => new WebRequestJs(url, method);
export const new_UnityWebRequest$string_string = (_c: Ctx, url: string, method: string): WebRequestJs => newReq(url, method);
export const new_UnityWebRequest$string = (_c: Ctx, url: string): WebRequestJs => newReq(url, 'GET');
export const new_UnityWebRequest$ = (_c: Ctx): WebRequestJs => newReq('', 'GET');
export const UnityWebRequest_Get$string = (_c: Ctx, url: string): WebRequestJs => newReq(url, 'GET');
export const UnityWebRequest_Post$string_string = (_c: Ctx, url: string): WebRequestJs => newReq(url, 'POST');
export const UnityWebRequest_Post$string_WWWForm = UnityWebRequest_Post$string_string;
export const UnityWebRequest_Post$string_List = UnityWebRequest_Post$string_string;
// 表單的段（IMultipartFormSection）：離線，送不出去，資料照收（遊戲可能讀 sectionData 記 log）
registerExternalCtor('MultipartFormDataSection', (...a: unknown[]) => {
  const data = a.length >= 2 ? a[1] : a[0];
  return { $type: 'MultipartFormDataSection', sectionName: a.length >= 2 ? a[0] : null, sectionData: typeof data === 'string' ? [...new TextEncoder().encode(data)] : data };
});
registerExternalCtor('MultipartFormFileSection', (...a: unknown[]) => ({ $type: 'MultipartFormFileSection', sectionName: a[0], sectionData: a[1], fileName: a[2] ?? null, contentType: a[3] ?? null }));
export const UnityWebRequest_Put$string_string = (_c: Ctx, url: string): WebRequestJs => newReq(url, 'PUT');
export const UnityWebRequest_Put$string_Byte_arr = UnityWebRequest_Put$string_string;
export function UnityWebRequest_SendWebRequest(c: Ctx, r: WebRequestJs): { $type: string; isDone: boolean; webRequest: WebRequestJs; progress: number } {
  const world = w(c);
  const op = { $type: 'UnityWebRequestAsyncOperation', isDone: false, webRequest: r, progress: 0 };
  world.notes.add(`網頁版不連後端：${r.method} ${r.url.replace(/\?.*$/, '')}`);
  world.beforeNextTick(() => {
    r.isDone = true;
    r.result = 2;
    r.error = 'Cannot connect to destination host';
    op.isDone = true;
    op.progress = 1;
    for (const f of eventGet(staticCtx, 'AsyncOperation.completed', op) ?? []) world.guard('UnityWebRequest.completed', () => f(op));
  });
  return op;
}
export const UnityWebRequest_get_isDone = (_c: Ctx, r: WebRequestJs): boolean => r.isDone;
export const UnityWebRequest_get_result = (_c: Ctx, r: WebRequestJs): number => r.result;
export const UnityWebRequest_get_error = (_c: Ctx, r: WebRequestJs): string | null => r.error;
export const UnityWebRequest_get_isNetworkError = (_c: Ctx, r: WebRequestJs): boolean => r.result === 2;
export const UnityWebRequest_get_isHttpError = (_c: Ctx, r: WebRequestJs): boolean => r.result === 3;
export const UnityWebRequest_get_responseCode = (_c: Ctx, r: WebRequestJs): number => r.responseCode;
export const UnityWebRequest_get_url = (_c: Ctx, r: WebRequestJs): string => r.url;
export const UnityWebRequest_set_url = (_c: Ctx, r: WebRequestJs, v: string): void => void (r.url = v);
export const UnityWebRequest_get_method = (_c: Ctx, r: WebRequestJs): string => r.method;
export const UnityWebRequest_set_method = (_c: Ctx, r: WebRequestJs, v: string): void => void (r.method = v);
export const UnityWebRequest_get_downloadHandler = (_c: Ctx, r: WebRequestJs): unknown => r.downloadHandler;
export const UnityWebRequest_set_downloadHandler = (_c: Ctx, r: WebRequestJs, v: never): void => void (r.downloadHandler = v);
export const UnityWebRequest_set_uploadHandler = (_c: Ctx, r: WebRequestJs, v: unknown): void => void (r.uploadHandler = v);
export const UnityWebRequest_set_timeout = (_c: Ctx, r: WebRequestJs, v: number): void => void (r.timeout = v);
export const UnityWebRequest_SetRequestHeader = (_c: Ctx, r: WebRequestJs, k: string, v: string): void => void (r.headers[k] = v);
export const UnityWebRequest_GetResponseHeader = (_c: Ctx, r: WebRequestJs, k: string): string | null => (void [r, k], null);
export const UnityWebRequest_Abort = (_c: Ctx, r: WebRequestJs): void => void r;
export const UnityWebRequest_Dispose = UnityWebRequest_Abort;
export const UnityWebRequest_EscapeURL$string = (_c: Ctx, s: string): string => encodeURIComponent(s);
export const new_DownloadHandlerBuffer = (_c: Ctx): { $type: string; text: string; data: Uint8Array } => ({ $type: 'DownloadHandlerBuffer', text: '', data: new Uint8Array(0) });
export const DownloadHandler_get_text = (_c: Ctx, d: { text: string }): string => d?.text ?? '';
export const DownloadHandler_get_data = (_c: Ctx, d: { data: Uint8Array }): Uint8Array => d?.data ?? new Uint8Array(0);
export const new_UploadHandlerRaw = (_c: Ctx, data: unknown): { $type: string; data: unknown } => ({ $type: 'UploadHandlerRaw', data });
// 產生碼也會走 R.newExternal（多載的名字帶參數型別時對不上）：登記同一個建構子
registerExternalCtor('UploadHandlerRaw', (data: unknown) => ({ $type: 'UploadHandlerRaw', data }));
registerExternalCtor('DownloadHandlerBuffer', () => ({ $type: 'DownloadHandlerBuffer', text: '', data: new Uint8Array(0) }));
export const new_WWWForm = (_c: Ctx): { $type: string; fields: Record<string, unknown> } => ({ $type: 'WWWForm', fields: {} });
export const WWWForm_AddField$string_string = (_c: Ctx, f: { fields: Record<string, unknown> }, k: string, v: unknown): void => void (f.fields[k] = v);
export const WWWForm_AddField$string_int = WWWForm_AddField$string_string;
export const WWWForm_AddBinaryData$string_Byte_arr_string_string = WWWForm_AddField$string_string;
export const UnityWebRequestAsyncOperation_get_webRequest = (_c: Ctx, op: { webRequest: WebRequestJs }): WebRequestJs => op.webRequest;

// AudioMixer、AudioSource、AudioClip 的長度：unityAudio.ts
export const AudioClip_get_name = (_c: Ctx, clip: AssetRef | null): string => (clip ? (getObjectStore()?.assetName(clip) ?? '') : '');

// ───────── TrailRenderer（留下的點在 particles/trailRenderer.ts，World 每格推進）；ParticleSystem 在 unityParticles.ts ─────────

function trailComp(h: unknown, what: string): ComponentData {
  const comp = (h as { comp?: ComponentData } | null)?.comp;
  if (!comp) throw new Error(`${what}：對象是 null（C# 這裡會 NullReferenceException）`);
  return comp;
}
export const TrailRenderer_Clear = (c: Ctx, h: unknown): void => (c.w ?? getActiveWorld())?.trails.clear(trailComp(h, 'TrailRenderer.Clear'));
export const TrailRenderer_AddPosition = (c: Ctx, h: unknown, p: { x: number; y: number; z: number }): void =>
  (c.w ?? getActiveWorld())?.trails.addPosition(trailComp(h, 'TrailRenderer.AddPosition'), p);
export const TrailRenderer_get_positionCount = (c: Ctx, h: unknown): number => (c.w ?? getActiveWorld())?.trails.positionCount(trailComp(h, 'TrailRenderer.positionCount')) ?? 0;

registerExternalCtor('InstantiationParameters', (...a: unknown[]) => ({ $type: 'InstantiationParameters', Parent: a.find((x) => x && typeof x === 'object' && 'node' in (x as object)) ?? null, InstantiateInWorldPosition: false }));
registerExternalCtor('Hash128', () => ({ $type: 'Hash128', hex: '' }));
// Hash128 是結構：Dictionary<Hash128, …>（Addressables 的 runtime key）照值比
registerValueType('Hash128', { equals: (a: H128, b: H128) => (a.hex ?? '') === (b.hex ?? '') });
registerValueType('InstantiationParameters');

// ───────── Post Processing v2（Unity.Postprocessing.Runtime，DLL）：設定資產的讀寫 ─────────
// 執行環境不畫後製效果（差異清單）；遊戲讀寫 profile 裡的設定（GraphicsSettingsMainSceneManager 開關 Bloom、MotionBlur）照原版的資料走。
// profile 是 ScriptableObject（materializeScriptableObject），settings 是同檔的子物件，$type 是 Bloom、ColorGrading 這類類別名。

/** PostProcessProfile.TryGetSettings<T>(out T)：反編譯的原版是 setting.GetType() == typeof(T)（精確比型別，不含子類別），第一個符合的 */
export function PostProcessProfile_TryGetSettings(c: Ctx, profile: { settings?: unknown[] } | null, out: (v: unknown) => void, type: string): boolean {
  void c;
  if (!profile) throw new Error('PostProcessProfile.TryGetSettings：對象是 null（C# 這裡會 NullReferenceException）');
  out(null);
  const t = baseTypeName(type);
  for (const s of profile.settings ?? []) {
    if (s && (s as { $type?: string }).$type === t) {
      out(s);
      return true;
    }
  }
  return false;
}

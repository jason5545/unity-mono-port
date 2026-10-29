// 相容層：執行環境原生做的元件（uGUI 的 Graphic、Image、Text、LayoutGroup、ScrollRect、EventSystem…，遊戲專案設定檔的 exclude）。
// unity.ts 會 export * 這裡。
//
// 轉換器在工具包模式下，這些類別的屬性如果相容層沒有專門的名字，寫成 R.nativeGet／nativeSet(對象, 類別, 屬性[, 值])：
//   1. NATIVE 表裡有專門的實作（要算的、有副作用的、巢狀欄位的）就用它；
//   2. 否則讀寫元件的序列化欄位 m_<屬性>（Unity 的屬性多半是這樣包的：color ↔ m_Color、sprite ↔ m_Sprite）；
//   3. 再不然，對象不是場景元件（事件資料這類一般物件）就讀寫同名的欄位；
//   4. 都沒有：設定的值記在旁邊（之後讀得回來），讀不到就 NotPorted。
// 繪製端每格讀元件資料，所以改 m_Color、m_Sprite 這類欄位下一格就畫出來（Unity 的 SetDirty 在這裡不需要）。

import type { World } from '../engine/world';
import { layoutGroupSize, registerScriptLayoutElements } from '../ui/layout';
import type { SceneNode } from '../unity/scene';
import type { ColorRGBA, ComponentData, MaterialRecord } from '../unity/types';
import { scriptGenName, hasGen, genCallVirtual, genMethodOf, ctxOf, genClass, compHandle, getActiveWorld, H, liveObj, NotPorted, registerExternalCtor, resolveValue, setNativeMessageLookup, transformOf, trace, type Ctx } from './core';

function w(c: Ctx): World {
  const world = c.w ?? getActiveWorld();
  if (!world) throw new Error('這個呼叫要在場景裡（沒有作用中的 World）');
  return world;
}
const cap = (s: string): string => s[0].toUpperCase() + s.slice(1);

/** 執行期的值 → 存檔的樣子（H 換回同檔參照 {fileID}、ScriptableObject 換回 {guid, fileID}、bool 換成 0／1） */
function toStored(world: World, v: unknown): unknown {
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (v instanceof H) {
    if (v.kind === 'go') return { fileID: v.node.id };
    if (v.kind === 'transform') return { fileID: v.node.go.transform };
    const id = v.node.go.components.find((x) => world.graph.file.components[x] === v.comp);
    return { fileID: id ?? '0' };
  }
  if (v && typeof v === 'object' && '$asset' in (v as object)) return { guid: (v as { $asset: string }).$asset, fileID: '11400000' };
  return v;
}

type NativeProp = { get?: (c: Ctx, h: H) => unknown; set?: (c: Ctx, h: H, v: unknown) => void };
const bool = (field: string): NativeProp => ({
  get: (_c, h) => !!h.comp?.[field],
  set: (_c, h, v) => {
    if (h.comp) h.comp[field] = v ? 1 : 0;
  },
});
const nearestCanvas = (world: World, n: SceneNode | null): H | null => {
  for (let x = n; x; x = x.parent) {
    const comp = world.graph.component(x, 'Canvas');
    if (comp) return compHandle(world, comp);
  }
  return null;
};
/** 專門的實作：類別.屬性（子類別找不到時沿 NATIVE_BASES 往上找） */
const NATIVE: Record<string, NativeProp> = {
  'Graphic.rectTransform': { get: (_c, h) => transformOf(h.node) },
  'Graphic.canvas': { get: (c, h) => nearestCanvas(w(c), h.node) },
  'Graphic.raycastTarget': bool('m_RaycastTarget'),
  'MaskableGraphic.maskable': bool('m_Maskable'),
  'Image.preserveAspect': bool('m_PreserveAspect'),
  'Image.fillClockwise': bool('m_FillClockwise'),
  'Image.overrideSprite': {
    get: (c, h) => resolveValue(w(c), (h.comp?.$overrideSprite as unknown) ?? h.comp?.m_Sprite),
    set: (c, h, v) => {
      if (h.comp) h.comp.$overrideSprite = toStored(w(c), v);
    },
  },
  'Text.fontSize': {
    get: (_c, h) => (h.comp?.m_FontData as { m_FontSize?: number } | undefined)?.m_FontSize ?? 14,
    set: (_c, h, v) => {
      const fd = h.comp?.m_FontData as Record<string, unknown> | undefined;
      if (fd) fd.m_FontSize = v;
    },
  },
  'Text.font': {
    get: (c, h) => resolveValue(w(c), (h.comp?.m_FontData as { m_Font?: unknown } | undefined)?.m_Font ?? null),
    set: (c, h, v) => {
      const fd = h.comp?.m_FontData as Record<string, unknown> | undefined;
      if (fd) fd.m_Font = toStored(w(c), v);
    },
  },
  'Text.alignment': {
    get: (_c, h) => (h.comp?.m_FontData as { m_Alignment?: number } | undefined)?.m_Alignment ?? 0,
    set: (_c, h, v) => {
      const fd = h.comp?.m_FontData as Record<string, unknown> | undefined;
      if (fd) fd.m_Alignment = v;
    },
  },
  'Text.resizeTextForBestFit': { get: (_c, h) => !!(h.comp?.m_FontData as { m_BestFit?: number } | undefined)?.m_BestFit },
  'Text.resizeTextMaxSize': { get: (_c, h) => (h.comp?.m_FontData as { m_MaxSize?: number } | undefined)?.m_MaxSize ?? 40 },
  'ScrollRect.horizontal': bool('m_Horizontal'),
  'ScrollRect.vertical': bool('m_Vertical'),
  'Toggle.isOn': bool('m_IsOn'),
  'LayoutElement.ignoreLayout': bool('m_IgnoreLayout'),
  'Mask.showMaskGraphic': bool('m_ShowMaskGraphic'),
  'EventSystem.sendNavigationEvents': bool('m_sendNavigationEvents'),
  'EventSystem.firstSelectedGameObject': {
    get: (c, h) => resolveValue(w(c), h.comp?.m_FirstSelected ?? null),
    set: (c, h, v) => {
      if (h.comp) h.comp.m_FirstSelected = toStored(w(c), v);
    },
  },
  'EventSystem.pixelDragThreshold': {
    get: (_c, h) => h.comp?.m_DragThreshold ?? 10,
    set: (_c, h, v) => {
      if (h.comp) h.comp.m_DragThreshold = v;
    },
  },
  'BaseInputModule.eventSystem': {
    get: (c, h) => {
      const comp = w(c).graph.component(h.node, 'EventSystem');
      return comp ? compHandle(w(c), comp) : null;
    },
  },
  'CanvasScaler.uiScaleMode': { get: (_c, h) => h.comp?.m_UiScaleMode ?? 0, set: (_c, h, v) => void (h.comp && (h.comp.m_UiScaleMode = v)) },
  // TextMeshPro（TMP_Text.cs 的屬性；繪製端每格照元件欄位重排，見 render/meshRefresh.ts）
  'TMP_Text.text': { get: (_c, h) => (h.comp?.m_text as string | undefined) ?? '', set: (_c, h, v) => void (h.comp && (h.comp.m_text = v)) },
  'TMP_Text.transform': { get: (_c, h) => transformOf(h.node) },
  'TMP_Text.color': { get: (_c, h) => ({ ...((h.comp?.m_fontColor as ColorRGBA | undefined) ?? WHITE) }), set: (_c, h, v) => void (h.comp && (h.comp.m_fontColor = { ...(v as ColorRGBA) })) },
  'TMP_Text.alpha': {
    get: (_c, h) => ((h.comp?.m_fontColor as ColorRGBA | undefined) ?? WHITE).a,
    set: (_c, h, v) => void (h.comp && (h.comp.m_fontColor = { ...((h.comp.m_fontColor as ColorRGBA | undefined) ?? WHITE), a: v as number })),
  },
  'TMP_Text.font': { get: (c, h) => resolveValue(w(c), h.comp?.m_fontAsset ?? null), set: (c, h, v) => void (h.comp && (h.comp.m_fontAsset = toStored(w(c), v))) },
  'TMP_Text.fontSharedMaterial': { get: (c, h) => resolveValue(w(c), h.comp?.m_sharedMaterial ?? null), set: (c, h, v) => void (h.comp && (h.comp.m_sharedMaterial = toStored(w(c), v))) },
  'TMP_Text.fontMaterial': { get: (c, h) => resolveValue(w(c), h.comp?.m_sharedMaterial ?? null), set: (c, h, v) => void (h.comp && (h.comp.m_sharedMaterial = toStored(w(c), v))) },
  'TMP_Text.fontSize': {
    get: (_c, h) => (h.comp?.m_fontSize as number | undefined) ?? 36,
    // fontSize 的 setter 同時改 m_fontSizeBase（自動縮放以它為準）
    set: (_c, h, v) => void (h.comp && ((h.comp.m_fontSize = v), (h.comp.m_fontSizeBase = v))),
  },
  'TMP_Text.alignment': {
    get: (_c, h) => ((h.comp?.m_HorizontalAlignment as number | undefined) ?? 1) | ((h.comp?.m_VerticalAlignment as number | undefined) ?? 0x100),
    set: (_c, h, v) => {
      if (!h.comp) return;
      h.comp.m_HorizontalAlignment = (v as number) & 0xff;
      h.comp.m_VerticalAlignment = (v as number) & 0xff00;
      h.comp.m_textAlignment = 65535;
    },
  },
  'Graphic.material': {
    get: (c, h) => graphicMaterial(c, h),
    set: (c, h, v) => void (h.comp && (h.comp.m_Material = v == null ? null : (v as { $type?: string }).$type === 'Material' && !(v as { $asset?: string }).$asset ? v : toStored(w(c), v))),
  },
  // materialForRendering：Unity 是套過 IMaterialModifier（Mask 的模板）之後的材質；模板測試由繪製端照 Mask 自己算，這裡給同一份材質
  'Graphic.materialForRendering': { get: (c, h) => graphicMaterial(c, h) },
  'Canvas.worldCamera': { get: (c, h) => resolveValue(w(c), h.comp?.m_Camera ?? null), set: (c, h, v) => void (h.comp && (h.comp.m_Camera = toStored(w(c), v))) },
  'TMP_Text.isRightToLeftText': bool('m_isRightToLeft'),
  'TMP_Text.enableAutoSizing': bool('m_enableAutoSizing'),
  'TMP_Text.richText': bool('m_isRichText'),
};
const WHITE: ColorRGBA = { r: 1, g: 1, b: 1, a: 1 };
/** 原生類別的基底（NATIVE 表沿這條找；m_ 欄位不需要） */
const NATIVE_BASES: Record<string, string> = {
  MaskableGraphic: 'Graphic',
  Image: 'MaskableGraphic',
  RawImage: 'MaskableGraphic',
  Text: 'MaskableGraphic',
  HorizontalOrVerticalLayoutGroup: 'LayoutGroup',
  HorizontalLayoutGroup: 'HorizontalOrVerticalLayoutGroup',
  VerticalLayoutGroup: 'HorizontalOrVerticalLayoutGroup',
  GridLayoutGroup: 'LayoutGroup',
  PointerInputModule: 'BaseInputModule',
  StandaloneInputModule: 'PointerInputModule',
  GraphicRaycaster: 'BaseRaycaster',
  TMP_Text: 'MaskableGraphic',
  TextMeshProUGUI: 'TMP_Text',
  TextMeshPro: 'TMP_Text',
  TMP_InputField: 'Selectable',
  TMP_Dropdown: 'Selectable',
  MeshRenderer: 'Renderer',
  SpriteRenderer: 'Renderer',
  SkinnedMeshRenderer: 'Renderer',
  LineRenderer: 'Renderer',
  TrailRenderer: 'Renderer',
  ParticleSystemRenderer: 'Renderer',
};
function lookup(cls: string, prop: string): NativeProp | undefined {
  for (let k: string | undefined = cls; k; k = NATIVE_BASES[k]) {
    const p = NATIVE[`${k}.${prop}`];
    if (p) return p;
  }
  return undefined;
}
/** 對象的元件資料：Transform／RectTransform 的 handle 沒有 comp，用節點的 Transform 資料 */
function compData(o: H): ComponentData | null {
  return (o.comp as ComponentData | null) ?? (o.kind === 'transform' ? (o.node.transform as unknown as ComponentData) : null);
}
/** 屬性 → 序列化欄位名：m_Prop、m_prop（TMP 這類小寫開頭）、prop */
function fieldKey(comp: ComponentData | null, prop: string): string | null {
  if (!comp) return null;
  for (const k of [`m_${cap(prop)}`, `m_${prop}`, prop]) if (k in comp) return k;
  return null;
}
/** 遊戲設定、但元件資料沒有對應欄位的屬性：記在旁邊 */
const side = new WeakMap<object, Record<string, unknown>>();
function sideOf(o: object): Record<string, unknown> {
  let s = side.get(o);
  if (!s) side.set(o, (s = {}));
  return s;
}
/** 登記專門的實作（遊戲專案或執行環境的其他模組） */
export function registerNativeProp(cls: string, prop: string, impl: NativeProp): void {
  NATIVE[`${cls}.${prop}`] = impl;
}
/**
 * 資料物件（不是場景元件）上的原生屬性：DLL 基底的虛擬屬性（PlayableAsset.duration：產生類別覆寫了就叫覆寫，沒有是預設值）。
 * 物件自己有這個欄位時照欄位
 */
const NATIVE_DATA: Record<string, { get?: (c: Ctx, o: object) => unknown; set?: (c: Ctx, o: object, v: unknown) => void }> = {};
export function registerNativeDataProp(cls: string, prop: string, impl: { get?: (c: Ctx, o: object) => unknown; set?: (c: Ctx, o: object, v: unknown) => void }): void {
  NATIVE_DATA[`${cls}.${prop}`] = impl;
}

/** 原生類別的靜態屬性（QualitySettings.vSyncCount 這類）：遊戲設定過的值，沒設過用這裡的預設 */
const staticProps: Record<string, Record<string, unknown>> = {
  QualitySettings: { vSyncCount: 1, antiAliasing: 0, pixelLightCount: 4, masterTextureLimit: 0, globalTextureMipmapLimit: 0, lodBias: 1, maxQueuedFrames: 2, names: ['Default'], shadowDistance: 40 },
  RenderSettings: {},
  Physics: { autoSimulation: true },
  Physics2D: { autoSimulation: true },
  GL: { sRGBWrite: false },
  // GarbageCollector.Mode：Disabled 0、Enabled 1、Manual 2
  GarbageCollector: { GCMode: 1, isIncremental: true, incrementalTimeSliceNanoseconds: 3000000 },
  // 烘焙光照圖（LightmapData 的清單）：遊戲執行期設的（MT2 的 PrefabLightmapData 把 prefab 帶的光照圖加進來）由繪製端照 Renderer 的
  // lightmapIndex 取（lightmapOf）。場景自己的清單（build 的 LightmapSettings.m_Lightmaps）沒有讀，從空的開始（差異清單）。
  // LightmapsMode：NonDirectional 0、CombinedDirectional 1
  LightmapSettings: { lightmaps: [], lightmapsMode: 1 },
  // Graphic.s_WhiteTexture（UnityEngine.UI Graphic.cs：Texture2D.whiteTexture，4×4 白色）：Graphic.mainTexture 沒有貼圖時用（UIParticle 也是）
  Graphic: { s_WhiteTexture: { $type: 'Texture2D', $width: 4, $height: 4, pixels: new Uint8ClampedArray(64).fill(255), $builtin: 'white' } },
};
/** 原生類別的靜態屬性每次讀都重算（UIVertex.simpleVert 這種 struct：每次給一份新的，改了不影響下一次） */
export function registerNativeStatic(cls: string, prop: string, get: () => unknown): void {
  Object.defineProperty((staticProps[cls] ??= {}), prop, { get, enumerable: true, configurable: true });
}
/** new LightmapData()：三張貼圖都是 null */
registerExternalCtor('LightmapData', () => ({ $type: 'LightmapData', lightmapColor: null, lightmapDir: null, shadowMask: null }));
export function nativeGet(c: Ctx, o: unknown, cls: string, prop: string): unknown {
  if (o == null) {
    // 轉換器對靜態屬性傳 null 當對象
    const bag = staticProps[cls];
    if (bag && prop in bag) return bag[prop];
    throw new NotPorted(`${cls}.${prop}`, '原生類別的靜態屬性沒有預設值', `${cls}_get_${prop}`);
  }
  o = liveObj(o);
  if (o instanceof H) {
    // 延後排版中的 RectTransform（World.flushDeferredLayout）：讀之前先排好
    if ((cls === 'RectTransform' || cls === 'Transform') && o.node) w(c).flushDeferredLayout(o.node);
    const impl = lookup(cls, prop);
    if (impl?.get) return impl.get(c, o);
    const comp = compData(o);
    const key = fieldKey(comp, prop);
    if (comp && key) {
      const raw = comp[key];
      // UnityEvent（onValueChanged、onClick）：回元件資料裡那一份（AddListener 照事件物件記監聽，執行環境的控制項觸發時也照它找）
      if (raw && typeof raw === 'object' && 'm_PersistentCalls' in (raw as object)) return raw;
      return resolveValue(w(c), raw);
    }
    const s = side.get(comp ?? o.node);
    if (s && prop in s) return s[prop];
  } else {
    const rec = o as Record<string, unknown>;
    if (prop in rec) return rec[prop];
    const s = side.get(rec);
    if (s && prop in s) return s[prop];
    const d = NATIVE_DATA[`${cls}.${prop}`];
    if (d?.get) return d.get(c, rec);
  }
  const where = `${cls}.${prop}`;
  trace.notPorted.set(`原生屬性 ${where}`, (trace.notPorted.get(`原生屬性 ${where}`) ?? 0) + 1);
  throw new NotPorted(where, '執行環境原生的元件沒有這個屬性的資料', `${cls}_get_${prop}`);
}
export function nativeSet(c: Ctx, o: unknown, cls: string, prop: string, v: unknown): void {
  if (o == null) {
    (staticProps[cls] ??= {})[prop] = v;
    return;
  }
  o = liveObj(o);
  if (o instanceof H) {
    // 延後排版中的 RectTransform：寫之前先排好（之後同一格讀到的是腳本寫的值，同 Unity）
    if ((cls === 'RectTransform' || cls === 'Transform') && o.node) w(c).flushDeferredLayout(o.node);
    const impl = lookup(cls, prop);
    if (impl?.set) return impl.set(c, o, v);
    const comp = compData(o);
    const key = fieldKey(comp, prop);
    if (comp && key) {
      comp[key] = toStored(w(c), v);
      return;
    }
    sideOf(comp ?? o.node)[prop] = v;
    return;
  }
  const d = NATIVE_DATA[`${cls}.${prop}`];
  if (d?.set) return d.set(c, o as object, v);
  (o as Record<string, unknown>)[prop] = v;
}

// ───────── 原生元件的方法 ─────────

/**
 * SetAllDirty／SetVerticesDirty／SetMaterialDirty：Image、TMP 由繪製端每格照元件資料重產，不需要標記；腳本自己產網格的 Graphic
 * （覆寫 OnPopulateMesh，csport/unityGraphicMesh.ts）照 Unity 記 m_VertsDirty／m_MaterialDirty（元件資料的 $vertsDirty、$materialDirty），
 * Canvas 畫之前重建。跟 Unity 一樣，物件沒有啟用（IsActive）時不記（Graphic.cs:285-309）
 */
function markGraphicDirty(h: H | null, verts: boolean, material: boolean): void {
  const comp = h instanceof H ? h.comp : null;
  if (!comp || !h!.node.activeInHierarchy || comp.m_Enabled === 0) return;
  if (verts) comp.$vertsDirty = true;
  if (material) comp.$materialDirty = true;
}
export const Graphic_SetAllDirty = (_c: Ctx, h: H): void => markGraphicDirty(h, true, true);
export const Graphic_SetVerticesDirty = (_c: Ctx, h: H): void => markGraphicDirty(h, true, false);
export const Graphic_SetMaterialDirty = (_c: Ctx, h: H): void => markGraphicDirty(h, false, true);
/** SetLayoutDirty、SetNativeSize：排版每格整棵樹重算，不需要標記 */
export const Graphic_SetLayoutDirty = (_c: Ctx, h: H): void => void h;
export const Graphic_SetNativeSize = Graphic_SetLayoutDirty;
/** LayoutRebuilder.ForceRebuildLayoutImmediate：立刻重排（排版是整棵樹算的） */
export function LayoutRebuilder_ForceRebuildLayoutImmediate(c: Ctx, rt: H): void {
  void rt;
  w(c).relayout();
}
export function LayoutRebuilder_MarkLayoutForRebuild(c: Ctx, rt: H): void {
  void c;
  void rt;
}
/** LayoutGroup.minWidth／preferredWidth／flexibleWidth 與 Height：照這個節點重算一次，讀群組自己的 total 值（ui/layout.ts 的 layoutGroupSize） */
for (const [prop, axis, kind] of [
  ['minWidth', 0, 'min'],
  ['preferredWidth', 0, 'preferred'],
  ['flexibleWidth', 0, 'flexible'],
  ['minHeight', 1, 'min'],
  ['preferredHeight', 1, 'preferred'],
  ['flexibleHeight', 1, 'flexible'],
] as const) {
  registerNativeProp('LayoutGroup', prop, {
    get: (c, h) => {
      const world = w(c);
      world.refreshTransform(h.node);
      return layoutGroupSize(world.graph, h.node, h.comp!, axis, kind, world.services.layout ?? {});
    },
  });
}
/**
 * 遊戲腳本實作的 ILayoutElement 參與 uGUI 排版（ui/layout.ts 的 registerScriptLayoutElements）：值照產生碼的屬性
 *（有本體的 getter 照實際類別分派；自動屬性讀實體欄位），排版前叫 CalculateLayoutInputHorizontal／Vertical
 */
const layoutElementClasses = new Map<string, boolean>();
const LAYOUT_PROPS = { min: ['minWidth', 'minHeight'], preferred: ['preferredWidth', 'preferredHeight'], flexible: ['flexibleWidth', 'flexibleHeight'] } as const;
function scriptProp(world: World, comp: ComponentData, name: string): number {
  const cls = scriptGenName(comp.script);
  if (!cls) return 0;
  const h = compHandle(world, comp);
  if (genMethodOf(cls, `get_${name}`)) return Number(genCallVirtual(world, cls, h, `get_${name}`)) || 0;
  return Number(ctxOf(world, h, cls).ai[name]) || 0;
}
registerScriptLayoutElements({
  isElement(c) {
    const cls = scriptGenName(c.script);
    if (!cls || !hasGen(cls)) return false;
    let yes = layoutElementClasses.get(cls);
    if (yes === undefined) {
      // 只算產生的類別自己（或產生的基底）宣告的；原生基底（TextMeshProUGUI、Image）的照內建的規則
      yes = false;
      for (let k: string | undefined = cls; k && hasGen(k); k = genClass(k).base) if (genClass(k).interfaces?.includes('ILayoutElement')) yes = true;
      layoutElementClasses.set(cls, yes);
    }
    return yes;
  },
  calculate(c, _node, axis) {
    const world = getActiveWorld();
    const cls = scriptGenName(c.script);
    const method = axis === 0 ? 'CalculateLayoutInputHorizontal' : 'CalculateLayoutInputVertical';
    if (world && cls && genMethodOf(cls, method)) world.guard(`${cls}.${method}`, () => void genCallVirtual(world, cls, compHandle(world, c), method));
  },
  value(c, _node, axis, prop) {
    const world = getActiveWorld();
    return world ? scriptProp(world, c, LAYOUT_PROPS[prop][axis]) : 0;
  },
  priority(c) {
    const world = getActiveWorld();
    return world ? scriptProp(world, c, 'layoutPriority') : 0;
  },
});
export function Canvas_ForceUpdateCanvases(c: Ctx): void {
  w(c).relayout();
}

// ───────── 原生程式庫（[DllImport]）與 IntPtr ─────────

/** P/Invoke：網頁上沒有原生程式庫（user32.dll、Steam 的 dll…），回傳型別的預設值（IntPtr.Zero、false、0、null），記下來 */
export function pinvoke(c: Ctx, dll: string, fn: string, ret: string, args: unknown[]): unknown {
  void args;
  (c.w ?? getActiveWorld())?.notes.add(`原生函式 ${dll}!${fn}（網頁上沒有，回預設值）`);
  if (ret === 'void') return undefined;
  if (ret === 'bool') return false;
  if (ret === 'string' || ret === 'Object') return null;
  return 0;
}
export const IntPtr_get_Zero = (_c: Ctx): number => 0;
export const IntPtr_op_Equality = (_c: Ctx, a: unknown, b: unknown): boolean => (a ?? 0) === (b ?? 0);
export const IntPtr_op_Inequality = (_c: Ctx, a: unknown, b: unknown): boolean => (a ?? 0) !== (b ?? 0);
export const IntPtr_ToInt32 = (_c: Ctx, a: unknown): number => Number(a ?? 0) | 0;
export const IntPtr_ToInt64 = (_c: Ctx, a: unknown): number => Number(a ?? 0);
export const new_IntPtr$int = (_c: Ctx, v: number): number => v;
export const new_IntPtr$Int64 = new_IntPtr$int;
export const IntPtr_get_Size = (_c: Ctx): number => 8;

// ───────── Material、Shader（屬性存在 MaterialRecord.m_SavedProperties；資產材質共用一份，跟 Unity 的 sharedMaterial 一樣） ─────────


export interface MaterialObj {
  $type: 'Material';
  $record: Omit<MaterialRecord, 'shaderName'> & { shaderName?: string | null };
  /** 資產材質的 guid（共用同一份）；執行時期 new 出來的沒有 */
  $asset?: string;
  shaderName: string | null;
}
const assetMaterials = new Map<string, MaterialObj>();
const emptyRecord = (name: string, shaderName: string | null): MaterialObj['$record'] => ({
  m_Name: name,
  shaderName,
  m_CustomRenderQueue: -1,
  m_ValidKeywords: [],
  m_SavedProperties: { m_TexEnvs: {}, m_Floats: {}, m_Colors: {} },
});
/** 遊戲碰到的材質值 → MaterialObj：資產參照（{guid, fileID}）換成共用的那份 */
/** Graphic.material：元件的 m_Material（執行期的材質物件或資產參照）；沒設是 Default UI Material */
let defaultUiMaterial: MaterialObj | null = null;
function graphicMaterial(c: Ctx, h: H): MaterialObj {
  const m = h.comp?.m_Material as { $type?: string; guid?: string } | null | undefined;
  if (m?.$type === 'Material') return m as MaterialObj;
  if (m && typeof m.guid === 'string' && m.guid !== '0000000000000000f000000000000000') return materialOf(c, m);
  return (defaultUiMaterial ??= { $type: 'Material', $record: emptyRecord('Default UI Material', 'UI/Default'), shaderName: 'UI/Default' });
}
export function materialOf(c: Ctx, m: unknown): MaterialObj {
  if (m == null) throw new Error('Material：對象是 null（C# 會 NullReferenceException）');
  const o = m as MaterialObj & { guid?: string };
  if (o.$type === 'Material') return o;
  if (typeof o.guid === 'string') {
    let hit = assetMaterials.get(o.guid);
    if (!hit) {
      const info = w(c).services.render?.sharedMaterial(m as never) ?? null;
      hit = { $type: 'Material', $record: info ? info.record : emptyRecord('Material', null), $asset: o.guid, shaderName: info?.shaderName ?? null };
      assetMaterials.set(o.guid, hit);
    }
    return hit;
  }
  throw new Error('Material：不認得的材質值');
}
const propNames = new Map<number, string>();
const propIds = new Map<string, number>();
/** Shader.PropertyToID：同一個名字同一個數字（Unity 的數字是執行期配的，遊戲只拿來當 key） */
export function Shader_PropertyToID(_c: Ctx, name: string): number {
  let id = propIds.get(name);
  if (id === undefined) {
    id = propIds.size + 1000;
    propIds.set(name, id);
    propNames.set(id, name);
  }
  return id;
}
const pname = (k: string | number): string => (typeof k === 'number' ? (propNames.get(k) ?? `#${k}`) : k);
export const Shader_Find = (_c: Ctx, name: string): { $type: 'Shader'; name: string } => ({ $type: 'Shader', name });
export const Shader_get_name = (_c: Ctx, s: { name: string }): string => s.name;
// ───────── Renderer 的材質（MeshRenderer、SpriteRenderer、ParticleSystemRenderer 的 m_Materials） ─────────
// sharedMaterial／sharedMaterials：存檔的那幾格（資產參照換成共用的那份 MaterialObj）。
// material／materials：照 Unity，第一次讀時複製一份給這個 Renderer 自己（名字加 (Instance)），之後讀到同一份。
const ownMaterials = new WeakSet<MaterialObj>();
const isNullRef = (m: unknown): boolean => m == null || (typeof m === 'object' && !('$type' in (m as object)) && String((m as { fileID?: unknown }).fileID ?? '0') === '0');
function rendererMats(h: H): unknown[] {
  if (!h.comp) throw new Error('Renderer：對象不是元件');
  return ((h.comp.m_Materials as unknown[] | undefined) ??= []);
}
function storedMaterial(c: Ctx, v: unknown): unknown {
  if (v == null) return { fileID: 0 };
  const m = v as MaterialObj;
  return m.$type === 'Material' && !m.$asset ? m : toStored(w(c), m.$type === 'Material' ? { guid: m.$asset, fileID: '2100000' } : v);
}
function instanceMaterial(c: Ctx, h: H, i: number): MaterialObj | null {
  const mats = rendererMats(h);
  const cur = mats[i];
  if (isNullRef(cur)) return null;
  const m = cur as MaterialObj;
  if (m.$type === 'Material' && ownMaterials.has(m)) return m;
  const copy = new_Material$Material(c, materialOf(c, cur));
  copy.$record.m_Name = `${materialOf(c, cur).$record.m_Name ?? 'Material'} (Instance)`;
  ownMaterials.add(copy);
  mats[i] = copy;
  return copy;
}
registerNativeProp('Renderer', 'sharedMaterial', {
  get: (c, h) => (isNullRef(rendererMats(h)[0]) ? null : materialOf(c, rendererMats(h)[0])),
  set: (c, h, v) => void (rendererMats(h)[0] = storedMaterial(c, v)),
});
registerNativeProp('Renderer', 'material', {
  get: (c, h) => instanceMaterial(c, h, 0),
  set: (c, h, v) => void (rendererMats(h)[0] = storedMaterial(c, v)),
});
registerNativeProp('Renderer', 'sharedMaterials', {
  get: (c, h) => rendererMats(h).map((m) => (isNullRef(m) ? null : materialOf(c, m))),
  set: (c, h, v) => void (h.comp!.m_Materials = ((v as unknown[]) ?? []).map((m) => storedMaterial(c, m))),
});
registerNativeProp('Renderer', 'materials', {
  get: (c, h) => rendererMats(h).map((_m, i) => instanceMaterial(c, h, i)),
  set: (c, h, v) => void (h.comp!.m_Materials = ((v as unknown[]) ?? []).map((m) => storedMaterial(c, m))),
});

// Renderer.lightmapIndex／lightmapScaleOffset：存成 Unity 序列化的欄位（m_LightmapIndex、m_LightmapTilingOffset），繪製端照它選 LIGHTMAP_ON 變體。
// 沒有光照圖時 Unity 序列化成 65535（0xFFFF），讀出來是 −1（手冊 Renderer.lightmapIndex：−1 是沒有光照圖；0xFFFE 是只受光照圖影響的物件，未做）
registerNativeProp('Renderer', 'lightmapIndex', {
  get: (_c, h) => {
    const v = h.comp?.m_LightmapIndex as number | undefined;
    return v === undefined || v === 0xffff ? -1 : v;
  },
  set: (_c, h, v) => {
    if (h.comp) h.comp.m_LightmapIndex = Number(v);
  },
});
registerNativeProp('Renderer', 'lightmapScaleOffset', {
  get: (_c, h) => {
    const v = h.comp?.m_LightmapTilingOffset as { x: number; y: number; z: number; w: number } | undefined;
    return v ? { ...v } : { x: 1, y: 1, z: 0, w: 0 };
  },
  set: (_c, h, v) => {
    const o = v as { x: number; y: number; z: number; w: number };
    if (h.comp) h.comp.m_LightmapTilingOffset = { x: o.x, y: o.y, z: o.z, w: o.w };
  },
});

/**
 * 繪製端用：這個 Renderer 的烘焙光照圖（LightmapSettings.lightmaps[lightmapIndex].lightmapColor 的貼圖 guid）與 lightmapScaleOffset。
 * 沒有光照圖（−1、65535、超出清單、清單那格沒有貼圖）時回 null
 */
export function lightmapOf(comp: ComponentData): { guid: string; scaleOffset: [number, number, number, number] } | null {
  const idx = comp.m_LightmapIndex as number | undefined;
  if (idx === undefined || idx < 0 || idx >= 0xfffe) return null;
  const list = (staticProps.LightmapSettings?.lightmaps as { lightmapColor?: { guid?: string } | null }[] | undefined) ?? [];
  const guid = list[idx]?.lightmapColor?.guid;
  if (!guid) return null;
  const st = (comp.m_LightmapTilingOffset as { x: number; y: number; z: number; w: number } | undefined) ?? { x: 1, y: 1, z: 0, w: 0 };
  return { guid, scaleOffset: [st.x, st.y, st.z, st.w] };
}

// ───────── Light ─────────
// Light.shadows（LightShadows：None 0、Hard 1、Soft 2）序列化在 m_Shadows.m_Type；泛用的欄位寫入會把整個 m_Shadows 結構換成數字
//（MT2 的 GraphicsSettingsMainSceneManager 把火車燈設成 None），這裡只改 m_Type
registerNativeProp('Light', 'shadows', {
  get: (_c, h) => ((h.comp?.m_Shadows as { m_Type?: number } | undefined)?.m_Type ?? 0),
  set: (_c, h, v) => {
    const sh = ((h.comp!.m_Shadows as { m_Type?: number } | null | undefined) ??= {}) as { m_Type?: number };
    sh.m_Type = v as number;
  },
});
registerNativeProp('Light', 'shadowStrength', {
  get: (_c, h) => ((h.comp?.m_Shadows as { m_Strength?: number } | undefined)?.m_Strength ?? 1),
  set: (_c, h, v) => {
    const sh = ((h.comp!.m_Shadows as { m_Strength?: number } | null | undefined) ??= {}) as { m_Strength?: number };
    sh.m_Strength = v as number;
  },
});

// ───────── MaterialPropertyBlock 與 Renderer 的 property block ─────────
// 跟材質一樣照屬性名存（屬性 ID 經 pname 換回名字）。Renderer.SetPropertyBlock 存一份複本（Unity 也是當下的值），
// GetPropertyBlock 把它複製進傳入的 block。繪製端還沒讀 property block（差異清單）。
type V4 = { r: number; g: number; b: number; a: number };
interface PropBlock {
  $type: 'MaterialPropertyBlock';
  floats: Record<string, number>;
  colors: Record<string, V4>;
  textures: Record<string, unknown>;
}
registerExternalCtor('MaterialPropertyBlock', (): PropBlock => ({ $type: 'MaterialPropertyBlock', floats: {}, colors: {}, textures: {} }));
const copyBlock = (b: PropBlock): Omit<PropBlock, '$type'> => ({ floats: { ...b.floats }, colors: Object.fromEntries(Object.entries(b.colors).map(([k, v]) => [k, { ...v }])), textures: { ...b.textures } });
export const MaterialPropertyBlock_SetFloat$string_float = (_c: Ctx, b: PropBlock, k: string | number, v: number): void => void (b.floats[pname(k)] = v);
export const MaterialPropertyBlock_SetFloat$int_float = MaterialPropertyBlock_SetFloat$string_float;
export const MaterialPropertyBlock_SetInt$string_int = MaterialPropertyBlock_SetFloat$string_float;
export const MaterialPropertyBlock_SetInt$int_int = MaterialPropertyBlock_SetFloat$string_float;
export const MaterialPropertyBlock_GetFloat$string = (_c: Ctx, b: PropBlock, k: string | number): number => b.floats[pname(k)] ?? 0;
export const MaterialPropertyBlock_GetFloat$int = MaterialPropertyBlock_GetFloat$string;
export const MaterialPropertyBlock_GetInt$string = MaterialPropertyBlock_GetFloat$string;
export const MaterialPropertyBlock_GetInt$int = MaterialPropertyBlock_GetFloat$string;
export const MaterialPropertyBlock_SetColor$string_Color = (_c: Ctx, b: PropBlock, k: string | number, v: V4): void => void (b.colors[pname(k)] = { r: v.r, g: v.g, b: v.b, a: v.a });
export const MaterialPropertyBlock_SetColor$int_Color = MaterialPropertyBlock_SetColor$string_Color;
export const MaterialPropertyBlock_GetColor$string = (_c: Ctx, b: PropBlock, k: string | number): V4 => ({ ...(b.colors[pname(k)] ?? { r: 0, g: 0, b: 0, a: 0 }) });
export const MaterialPropertyBlock_GetColor$int = MaterialPropertyBlock_GetColor$string;
export const MaterialPropertyBlock_SetVector$string_Vector4 = (_c: Ctx, b: PropBlock, k: string | number, v: { x: number; y: number; z: number; w: number }): void =>
  void (b.colors[pname(k)] = { r: v.x, g: v.y, b: v.z, a: v.w });
export const MaterialPropertyBlock_SetVector$int_Vector4 = MaterialPropertyBlock_SetVector$string_Vector4;
export const MaterialPropertyBlock_GetVector$string = (_c: Ctx, b: PropBlock, k: string | number): { x: number; y: number; z: number; w: number } => {
  const v = b.colors[pname(k)] ?? { r: 0, g: 0, b: 0, a: 0 };
  return { x: v.r, y: v.g, z: v.b, w: v.a };
};
export const MaterialPropertyBlock_GetVector$int = MaterialPropertyBlock_GetVector$string;
export const MaterialPropertyBlock_SetTexture$string_Texture = (_c: Ctx, b: PropBlock, k: string | number, t: unknown): void => void (b.textures[pname(k)] = t);
export const MaterialPropertyBlock_SetTexture$int_Texture = MaterialPropertyBlock_SetTexture$string_Texture;
export const MaterialPropertyBlock_GetTexture$string = (_c: Ctx, b: PropBlock, k: string | number): unknown => b.textures[pname(k)] ?? null;
export const MaterialPropertyBlock_GetTexture$int = MaterialPropertyBlock_GetTexture$string;
export const MaterialPropertyBlock_Clear = (_c: Ctx, b: PropBlock): void => void Object.assign(b, { floats: {}, colors: {}, textures: {} });
export const MaterialPropertyBlock_get_isEmpty = (_c: Ctx, b: PropBlock): boolean =>
  !Object.keys(b.floats).length && !Object.keys(b.colors).length && !Object.keys(b.textures).length;
/** Renderer 的 property block：整個 Renderer 一份（-1），或照材質格（SetPropertyBlock(block, i)） */
const rendererBlocks = new WeakMap<ComponentData, Map<number, Omit<PropBlock, '$type'>>>();
export function Renderer_SetPropertyBlock$MaterialPropertyBlock(_c: Ctx, h: H, b: PropBlock | null): void {
  const comp = h.comp!;
  let m = rendererBlocks.get(comp);
  if (!m) rendererBlocks.set(comp, (m = new Map()));
  if (b) m.set(-1, copyBlock(b));
  else m.delete(-1);
}
export function Renderer_SetPropertyBlock$MaterialPropertyBlock_int(_c: Ctx, h: H, b: PropBlock | null, i: number): void {
  const comp = h.comp!;
  let m = rendererBlocks.get(comp);
  if (!m) rendererBlocks.set(comp, (m = new Map()));
  if (b) m.set(i, copyBlock(b));
  else m.delete(i);
}
export function Renderer_GetPropertyBlock$MaterialPropertyBlock(_c: Ctx, h: H, dest: PropBlock): void {
  Object.assign(dest, copyBlock({ $type: 'MaterialPropertyBlock', floats: {}, colors: {}, textures: {}, ...(rendererBlocks.get(h.comp!)?.get(-1) ?? {}) }));
}
export function Renderer_GetPropertyBlock$MaterialPropertyBlock_int(_c: Ctx, h: H, dest: PropBlock, i: number): void {
  Object.assign(dest, copyBlock({ $type: 'MaterialPropertyBlock', floats: {}, colors: {}, textures: {}, ...(rendererBlocks.get(h.comp!)?.get(i) ?? {}) }));
}
export const Renderer_HasPropertyBlock = (_c: Ctx, h: H): boolean => (rendererBlocks.get(h.comp!)?.size ?? 0) > 0;

export function new_Material$Shader(_c: Ctx, shader: { name?: string } | null): MaterialObj {
  const name = shader?.name ?? null;
  return { $type: 'Material', $record: emptyRecord(name ?? 'Material', name), shaderName: name };
}
export function new_Material$Material(c: Ctx, src: unknown): MaterialObj {
  const m = materialOf(c, src);
  return { $type: 'Material', $record: structuredClone(m.$record), shaderName: m.shaderName };
}
const props = (c: Ctx, m: unknown) => materialOf(c, m).$record.m_SavedProperties;
export const Material_SetFloat$string_float = (c: Ctx, m: unknown, k: string | number, v: number): void => void (props(c, m).m_Floats[pname(k)] = v);
export const Material_SetFloat$int_float = Material_SetFloat$string_float;
export const Material_SetInt$string_int = Material_SetFloat$string_float;
export const Material_SetInt$int_int = Material_SetFloat$int_float;
// SetInt 是「SetFloat 的別名，值轉成 float」（2022.3 手冊 Material.SetInt）；SetInteger 設的是整數屬性（Material.SetInteger），
// 序列化裡是 m_Ints，繪製端在 m_Floats 之後讀它
export const Material_SetInteger$string_int = (c: Ctx, m: unknown, k: string | number, v: number): void => {
  const p = props(c, m);
  (p.m_Ints ??= {})[pname(k)] = v | 0;
};
export const Material_SetInteger$int_int = Material_SetInteger$string_int;
export const Material_GetFloat$string = (c: Ctx, m: unknown, k: string | number): number => props(c, m).m_Floats[pname(k)] ?? 0;
export const Material_GetFloat$int = Material_GetFloat$string;
export const Material_GetInt$string = Material_GetFloat$string;
export const Material_GetInt$int = Material_GetFloat$string;
export const Material_GetInteger$string = (c: Ctx, m: unknown, k: string | number): number => props(c, m).m_Ints?.[pname(k)] ?? 0;
export const Material_GetInteger$int = Material_GetInteger$string;
export const Material_SetColor$string_Color = (c: Ctx, m: unknown, k: string | number, v: { r: number; g: number; b: number; a: number }): void => void (props(c, m).m_Colors[pname(k)] = { r: v.r, g: v.g, b: v.b, a: v.a });
export const Material_SetColor$int_Color = Material_SetColor$string_Color;
export const Material_GetColor$string = (c: Ctx, m: unknown, k: string | number): { r: number; g: number; b: number; a: number } => ({ ...(props(c, m).m_Colors[pname(k)] ?? { r: 0, g: 0, b: 0, a: 0 }) });
export const Material_GetColor$int = Material_GetColor$string;
export const Material_SetVector$string_Vector4 = (c: Ctx, m: unknown, k: string | number, v: { x: number; y: number; z: number; w: number }): void => void (props(c, m).m_Colors[pname(k)] = { r: v.x, g: v.y, b: v.z, a: v.w });
export const Material_SetVector$int_Vector4 = Material_SetVector$string_Vector4;
export const Material_GetVector$string = (c: Ctx, m: unknown, k: string | number): { x: number; y: number; z: number; w: number } => {
  const v = props(c, m).m_Colors[pname(k)] ?? { r: 0, g: 0, b: 0, a: 0 };
  return { x: v.r, y: v.g, z: v.b, w: v.a };
};
export const Material_GetVector$int = Material_GetVector$string;
export function Material_SetTexture$string_Texture(c: Ctx, m: unknown, k: string | number, tex: unknown): void {
  const p = props(c, m);
  const key = pname(k);
  const old = p.m_TexEnvs[key];
  p.m_TexEnvs[key] = { m_Texture: (tex ?? { fileID: '0' }) as never, m_Scale: old?.m_Scale ?? { x: 1, y: 1 }, m_Offset: old?.m_Offset ?? { x: 0, y: 0 } };
}
export const Material_SetTexture$int_Texture = Material_SetTexture$string_Texture;
export const Material_GetTexture$string = (c: Ctx, m: unknown, k: string | number): unknown => props(c, m).m_TexEnvs[pname(k)]?.m_Texture ?? null;
export const Material_GetTexture$int = Material_GetTexture$string;
export const Material_HasProperty$string = (c: Ctx, m: unknown, k: string | number): boolean => {
  const p = props(c, m);
  const key = pname(k);
  return key in p.m_Floats || key in p.m_Colors || key in p.m_TexEnvs || key in (p.m_Ints ?? {});
};
export const Material_HasProperty$int = Material_HasProperty$string;
export const Material_HasFloat$string = Material_HasProperty$string;
export const Material_HasColor$string = Material_HasProperty$string;
export function Material_EnableKeyword$string(c: Ctx, m: unknown, k: string): void {
  const r = materialOf(c, m).$record;
  r.m_ValidKeywords ??= [];
  if (!r.m_ValidKeywords.includes(k)) r.m_ValidKeywords.push(k);
}
export function Material_DisableKeyword$string(c: Ctx, m: unknown, k: string): void {
  const r = materialOf(c, m).$record;
  r.m_ValidKeywords = (r.m_ValidKeywords ?? []).filter((x) => x !== k);
}
export const Material_IsKeywordEnabled$string = (c: Ctx, m: unknown, k: string): boolean => (materialOf(c, m).$record.m_ValidKeywords ?? []).includes(k);
export const Material_get_color = (c: Ctx, m: unknown) => Material_GetColor$string(c, m, '_Color');
export const Material_set_color = (c: Ctx, m: unknown, v: { r: number; g: number; b: number; a: number }): void => Material_SetColor$string_Color(c, m, '_Color', v);
export const Material_get_mainTexture = (c: Ctx, m: unknown): unknown => Material_GetTexture$string(c, m, '_MainTex');
export const Material_set_mainTexture = (c: Ctx, m: unknown, t: unknown): void => Material_SetTexture$string_Texture(c, m, '_MainTex', t);
export const Material_get_renderQueue = (c: Ctx, m: unknown): number => materialOf(c, m).$record.m_CustomRenderQueue;
export const Material_set_renderQueue = (c: Ctx, m: unknown, v: number): void => void (materialOf(c, m).$record.m_CustomRenderQueue = v);
export const Material_get_shader = (c: Ctx, m: unknown): { $type: 'Shader'; name: string } => ({ $type: 'Shader', name: materialOf(c, m).shaderName ?? '' });
export const Material_set_shader = (c: Ctx, m: unknown, s: { name: string }): void => void (materialOf(c, m).shaderName = s?.name ?? null);
export const Material_get_name = (c: Ctx, m: unknown): string => materialOf(c, m).$record.m_Name;
export const Material_CopyPropertiesFromMaterial = (c: Ctx, m: unknown, src: unknown): void => void (materialOf(c, m).$record.m_SavedProperties = structuredClone(materialOf(c, src).$record.m_SavedProperties));
export const Material_SetPass = (_c: Ctx, m: unknown, p: number): boolean => (void [m, p], true);

// AudioSource：unityAudio.ts

// ───────── TextMeshPro 的方法 ─────────

export const TMP_Text_SetText$string = (c: Ctx, t: H, text: string): void => nativeSet(c, t, 'TMP_Text', 'text', text);
export const TMP_Text_SetText$string_bool = (c: Ctx, t: H, text: string, syncTextInputBox: boolean): void => void [syncTextInputBox, nativeSet(c, t, 'TMP_Text', 'text', text)];
export const TMP_Text_SetText$string_float = (c: Ctx, t: H, f: string, a0: number): void => nativeSet(c, t, 'TMP_Text', 'text', tmpFormat(f, [a0]));
export const TMP_Text_SetText$string_float_float = (c: Ctx, t: H, f: string, a0: number, a1: number): void => nativeSet(c, t, 'TMP_Text', 'text', tmpFormat(f, [a0, a1]));
export const TMP_Text_SetText$string_float_float_float = (c: Ctx, t: H, f: string, a0: number, a1: number, a2: number): void =>
  nativeSet(c, t, 'TMP_Text', 'text', tmpFormat(f, [a0, a1, a2]));
// ForceMeshUpdate、UpdateVertexData、textInfo：unityTmp.ts（繪製端的同步排版）

/**
 * TMP_Text.SetText(string, float…)（TMP_Text.cs:2559）：{索引:格式}，格式的 0 是補零位數、. 之後的 0 是小數位數、單一個 1-9 是舊式小數位數。
 * 數字照 AddFloatToInternalTextBackingArray（:3419）：float 轉 decimal（7 位有效數字）、加 0.5×10^-位數 進位、截斷。
 */
export function tmpFormat(src: string, args: number[]): string {
  let argIndex = 0;
  let padding = 0;
  let precision = 0;
  let readFlag = 0;
  let out = '';
  for (const ch of src) {
    if (ch === '{') {
      readFlag = 1;
      continue;
    }
    if (ch === '}') {
      if (argIndex < 8) out += tmpFloat(args[argIndex] ?? 0, padding, precision);
      argIndex = 0;
      readFlag = 0;
      padding = 0;
      precision = 0;
      continue;
    }
    if (readFlag === 1 && ch >= '0' && ch <= '8') {
      argIndex = ch.charCodeAt(0) - 48;
      readFlag = 2;
      continue;
    }
    if (readFlag === 2) {
      if (ch === ':' || ch === '#' || ch === ',') continue;
      if (ch === '.') {
        readFlag = 3;
        continue;
      }
      if (ch === '0') {
        padding++;
        continue;
      }
      if (ch >= '1' && ch <= '9') {
        precision = ch.charCodeAt(0) - 48;
        continue;
      }
    }
    if (readFlag === 3 && ch === '0') {
      precision++;
      continue;
    }
    out += ch;
  }
  return out;
}
const DEC_SCALE = 28;
const TEN = 10n;
const ONE_DEC = TEN ** BigInt(DEC_SCALE);
/** (decimal)float：7 位有效數字，換成 10^-28 為單位的整數 */
function decimalFromFloat(v: number): bigint {
  if (v === 0 || !Number.isFinite(v)) return 0n;
  const [mant, expStr] = Math.fround(v).toExponential(6).split('e');
  const digits = BigInt(mant.replace('.', '').replace('-', ''));
  const exp = Number(expStr) - 6 + DEC_SCALE;
  const mag = exp >= 0 ? digits * TEN ** BigInt(exp) : digits / TEN ** BigInt(-exp);
  return mant.startsWith('-') ? -mag : mag;
}
function tmpFloat(value: number, padding: number, precision: number): string {
  let out = '';
  if (value < 0) {
    out = '-';
    value = -value;
  }
  let d = decimalFromFloat(value);
  if (padding === 0 && precision === 0) precision = 9;
  else d += 5n * TEN ** BigInt(DEC_SCALE - (Math.min(9, precision) + 1));
  const integer = d / ONE_DEC;
  out += integer.toString().padStart(padding, '0');
  if (precision > 0) {
    d -= integer * ONE_DEC;
    if (d !== 0n) {
      out += '.';
      for (let p = 0; p < precision; p++) {
        d *= TEN;
        const digit = d / ONE_DEC;
        out += String(digit);
        d -= digit * ONE_DEC;
        if (d === 0n) break;
      }
    }
  }
  return out;
}

// ───────── 原生基底的 base.X()（遊戲的子類別叫原生類別的方法） ─────────

/** Unity 的訊息：原生元件的這些行為（登記重繪、排版、裁切）執行環境每格自己處理，子類別叫 base 版本時不用做事 */
const UNITY_MESSAGES = new Set([
  'Awake', 'Start', 'OnEnable', 'OnDisable', 'OnDestroy', 'OnValidate', 'Reset', 'Update', 'LateUpdate',
  'OnRectTransformDimensionsChange', 'OnTransformParentChanged', 'OnBeforeTransformParentChanged', 'OnCanvasHierarchyChanged',
  'OnCanvasGroupChanged', 'OnDidApplyAnimationProperties',
]);
const nativeBaseImpls: Record<string, (c: Ctx, self: unknown, ...a: unknown[]) => unknown> = {};
/** 登記原生類別的方法給子類別的 base.X() 用（"TextMeshProUGUI.Rebuild"） */
export function registerNativeBase(key: string, fn: (c: Ctx, self: unknown, ...a: unknown[]) => unknown): void {
  nativeBaseImpls[key] = fn;
}
export function nativeBase(c: Ctx, self: unknown, cls: string, method: string, ...args: unknown[]): unknown {
  for (let k: string | undefined = cls; k; k = NATIVE_BASES[k]) {
    const fn = nativeBaseImpls[`${k}.${method}`];
    if (fn) return fn(c, self, ...args);
  }
  if (UNITY_MESSAGES.has(method)) return undefined;
  throw new NotPorted(`base.${method}()`, `原生類別 ${cls} 的方法還沒做`, `base_${cls}_${method}`);
}
// 網格重產：繪製端每格照元件欄位重排重畫（render/meshRefresh.ts），子類別叫 base 版本時不用做事。
// Graphic 的 Rebuild、UpdateGeometry、UpdateMaterial 對腳本自己產網格的 Graphic 有實作（csport/unityGraphicMesh.ts 蓋過這裡）
for (const k of ['Graphic.Rebuild', 'Graphic.UpdateGeometry', 'Graphic.UpdateMaterial', 'Graphic.SetLayoutDirty', 'TMP_Text.ForceMeshUpdate', 'TMP_Text.UpdateVertexData', 'TMP_Text.UpdateGeometry'])
  registerNativeBase(k, () => undefined);
registerNativeBase('Graphic.SetAllDirty', (_c, self) => markGraphicDirty(self as H, true, true));
registerNativeBase('Graphic.SetVerticesDirty', (_c, self) => markGraphicDirty(self as H, true, false));
registerNativeBase('Graphic.SetMaterialDirty', (_c, self) => markGraphicDirty(self as H, false, true));
// 產生的類別沒覆寫 OnEnable／OnDisable 時，Unity 叫原生基底那一版（core.ts 的 genBehaviour）：照 base.X() 的實作找
setNativeMessageLookup((nativeClass, message) => {
  for (let k: string | undefined = nativeClass; k; k = NATIVE_BASES[k]) {
    const fn = nativeBaseImpls[`${k}.${message}`];
    if (fn) return fn;
  }
  return undefined;
});

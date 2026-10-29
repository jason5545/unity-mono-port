// 相容層：TextMeshPro 的排版結果給腳本讀寫（TMP_Text.textInfo、bounds、mesh；ForceMeshUpdate、UpdateVertexData、TMP_TextUtilities）。
// unity.ts 會 export * 這裡。
//   - 排版用繪製端的同步排版（RenderServices.layoutText：跟畫出來的同一套 TMP 移植，只排版、不建網格）。
//   - textInfo 照 TMP_TextInfo 的形狀：characterInfo、lineInfo、wordInfo、linkInfo、meshInfo（照 materialReferenceIndex 排，
//     vertices 是 Vector3、colors32 是 Color32，腳本可以直接改）。同一份排版輸入（文字、字級、字型、區域大小）重複讀拿到同一個物件。
//   - UpdateVertexData：把腳本改過的頂點與顏色登記成網格掛勾（setTextHook），下一次產生網格時蓋上去（ExtendedTextMeshProUGUI 的彎字、
//     逐字動畫）。字數或頂點數跟排版當時不同（文字又改了）就不蓋，等腳本下一次 ForceMeshUpdate。
// 與原版的差異：沒有文字功能（?text=0）時 textInfo 是空的（characterCount 0）。

import { registerWillRenderCanvases, type World } from '../engine/world';
import type { ComponentData } from '../unity/types';
import type { TextMeshResult } from '../text/types';
import type { TmpVertexHook } from '../text/vertexHooks';
import { genCallVirtual, genClass, getActiveWorld, H, hasGen, scriptGenName, type Ctx } from './core';
import { registerNativeBase, registerNativeProp } from './unityNative';

type V3 = { x: number; y: number; z: number };
type C32 = { r: number; g: number; b: number; a: number; $color32: true };
interface MeshInfoJs {
  $type: 'TMP_MeshInfo';
  vertexCount: number;
  vertices: V3[];
  colors32: C32[];
  uvs0: { x: number; y: number; z: number; w: number }[];
  uvs2: { x: number; y: number }[];
  triangles: number[];
}
interface TextInfoJs {
  $type: 'TMP_TextInfo';
  characterCount: number;
  spriteCount: number;
  spaceCount: number;
  wordCount: number;
  linkCount: number;
  lineCount: number;
  pageCount: number;
  materialCount: number;
  characterInfo: Record<string, unknown>[];
  lineInfo: Record<string, unknown>[];
  wordInfo: Record<string, unknown>[];
  linkInfo: Record<string, unknown>[];
  pageInfo: Record<string, unknown>[];
  meshInfo: (MeshInfoJs | null)[];
}
interface TmpState {
  key: string;
  result: TextMeshResult;
  info: TextInfoJs;
}
const states = new WeakMap<ComponentData, TmpState>();
let hookSeq = 0;

function world(c: Ctx): World | null {
  return c.w ?? getActiveWorld();
}
/** 排版的輸入：這些變了就重排（Unity 是 havePropertiesChanged 時重產網格） */
function inputKey(h: H): string {
  const comp = h.comp!;
  const font = comp.m_fontAsset as { guid?: string } | null;
  return `${comp.m_text}|${comp.m_fontSize}|${comp.m_enableAutoSizing}|${font?.guid}|${h.node.rect.width}x${h.node.rect.height}|${comp.m_isRichText}|${comp.m_firstVisibleCharacter}|${comp.m_maxVisibleCharacters}|${comp.m_maxVisibleLines}`;
}
/**
 * m_havePropertiesChanged：屬性的 set 設成 true；Unity 在 ForceMeshUpdate 或這一格的 Canvas 重建（OnPreRenderCanvas → GenerateTextMesh）清掉。
 * 這裡沒有逐元件的 Canvas 重建，記下設的那一格：過了那一格就當已經重建過
 */
function markChanged(c: Ctx, comp: ComponentData): void {
  changedFrame.set(comp, world(c)?.frameCount ?? 0);
}
const changedFrame = new WeakMap<ComponentData, number>();
/** 沒序列化的 int 屬性（預設值照 TMP_Text 的欄位初始式）：值變了才設，並標記 havePropertiesChanged（TMP_Text.cs 的 set） */
function intProp(field: string, def: number) {
  return {
    get: (_c: Ctx, h: H) => (h.comp?.[field] as number | undefined) ?? def,
    set: (c: Ctx, h: H, v: unknown) => {
      const comp = h.comp;
      if (!comp || ((comp[field] as number | undefined) ?? def) === v) return;
      comp[field] = v;
      markChanged(c, comp);
    },
  };
}
function meshInfoOf(sub: TextMeshResult['subMeshes'][number]): MeshInfoJs {
  const n = sub.positions.length / 3;
  const vertices: V3[] = new Array(n);
  const colors32: C32[] = new Array(n);
  const uvs0: MeshInfoJs['uvs0'] = new Array(n);
  const uvs2: MeshInfoJs['uvs2'] = new Array(n);
  for (let i = 0; i < n; i++) {
    vertices[i] = { x: sub.positions[i * 3], y: sub.positions[i * 3 + 1], z: sub.positions[i * 3 + 2] };
    colors32[i] = { r: sub.colors[i * 4], g: sub.colors[i * 4 + 1], b: sub.colors[i * 4 + 2], a: sub.colors[i * 4 + 3], $color32: true };
    uvs0[i] = { x: sub.uvs0[i * 4], y: sub.uvs0[i * 4 + 1], z: sub.uvs0[i * 4 + 2], w: sub.uvs0[i * 4 + 3] };
    uvs2[i] = { x: sub.uvs2[i * 2], y: sub.uvs2[i * 2 + 1] };
  }
  return { $type: 'TMP_MeshInfo', vertexCount: n, vertices, colors32, uvs0, uvs2, triangles: [...sub.indices] };
}
function textInfoOf(r: TextMeshResult): TextInfoJs {
  const ti = r.textInfo;
  const meshInfo: (MeshInfoJs | null)[] = [];
  for (const sub of r.subMeshes) meshInfo[sub.materialIndex] = meshInfoOf(sub);
  for (let i = 0; i < meshInfo.length; i++) meshInfo[i] ??= null;
  const clone = <T extends object>(xs: T[]): Record<string, unknown>[] => xs.map((x) => structuredClone(x) as Record<string, unknown>);
  return {
    $type: 'TMP_TextInfo',
    characterCount: ti.characterCount,
    spriteCount: ti.spriteCount,
    spaceCount: ti.spaceCount,
    wordCount: ti.wordCount,
    linkCount: ti.linkCount,
    lineCount: ti.lineCount,
    pageCount: ti.pageCount,
    materialCount: ti.materialCount,
    // TMP_CharacterInfo.character 是 C# 的 char（產生碼裡是長度 1 的字串）；TMP 存的是 (char)unicode，超過 0xFFFF 截掉高位，fromCharCode 一樣
    characterInfo: clone(ti.characterInfo).map((ch) => ({ ...ch, character: String.fromCharCode(ch.character as number) })),
    lineInfo: clone(ti.lineInfo),
    wordInfo: clone(ti.wordInfo),
    linkInfo: clone(ti.linkInfo),
    pageInfo: clone(ti.pageInfo),
    meshInfo,
  };
}
const EMPTY_INFO = (): TextInfoJs => ({
  $type: 'TMP_TextInfo', characterCount: 0, spriteCount: 0, spaceCount: 0, wordCount: 0, linkCount: 0, lineCount: 0, pageCount: 0, materialCount: 0,
  characterInfo: [], lineInfo: [], wordInfo: [], linkInfo: [], pageInfo: [], meshInfo: [],
});
/**
 * 照目前的元件資料排版（強制重排或輸入變了）；沒有文字功能時 null。
 * textInfo 跟 Unity 的 m_textInfo 一樣是同一個物件（腳本快取 tmp.textInfo 之後，重排拿到的還是它）：重排時就地換掉內容
 */
function layout(c: Ctx, h: H, force: boolean): TmpState | null {
  const comp = h.comp;
  if (!comp) return null;
  // 排版讀 rect：停用的物件 layout 不算，先沿父物件鏈算好（World.refreshTransform）
  world(c)?.refreshTransform(h.node);
  const key = inputKey(h);
  const cur = states.get(comp);
  if (cur && !force && cur.key === key) return cur;
  const r = world(c)?.services.render?.layoutText(comp, h.node, false) ?? null;
  if (!r) return null;
  const info = cur ? Object.assign(cur.info, textInfoOf(r)) : textInfoOf(r);
  const st: TmpState = { key, result: r, info };
  states.set(comp, st);
  changedFrame.delete(comp);
  // TMP 重產網格時發 TMPro_EventManager.TEXT_CHANGED_EVENT（GenerateTextMesh 的最後）。這裡只在腳本觸發的重排發（差異清單）
  for (const fn of [...TEXT_CHANGED_EVENT.list]) fn(h);
  return st;
}

/** TMP 的 FastAction<A>（TMPro_EventManager 的事件）：Add 不重複加、Remove、Call 照加入的順序 */
interface FastActionJs {
  $type: 'FastAction';
  list: ((...a: unknown[]) => unknown)[];
}
const TEXT_CHANGED_EVENT: FastActionJs = { $type: 'FastAction', list: [] };
export const TMPro_EventManager_get_TEXT_CHANGED_EVENT = (_c: Ctx): FastActionJs => TEXT_CHANGED_EVENT;
export function FastAction_Add(_c: Ctx, fa: FastActionJs, fn: (...a: unknown[]) => unknown): void {
  if (!fa.list.includes(fn)) fa.list.push(fn);
}
export function FastAction_Remove(_c: Ctx, fa: FastActionJs, fn: (...a: unknown[]) => unknown): void {
  const i = fa.list.indexOf(fn);
  if (i >= 0) fa.list.splice(i, 1);
}
export function FastAction_Call(_c: Ctx, fa: FastActionJs, ...a: unknown[]): void {
  for (const fn of [...fa.list]) fn(...a);
}

/** ForceMeshUpdate(ignoreActiveState, forceTextReparsing)：馬上重排，textInfo 換成新的一份 */
export function TMP_Text_ForceMeshUpdate(c: Ctx, h: H, ...a: unknown[]): void {
  void a;
  layout(c, h, true);
}
export const TMP_Text_ForceMeshUpdate$bool_bool = TMP_Text_ForceMeshUpdate;
export const TextMeshProUGUI_ForceMeshUpdate = TMP_Text_ForceMeshUpdate;
export const TextMeshProUGUI_ForceMeshUpdate$bool_bool = TMP_Text_ForceMeshUpdate;
export const TextMeshPro_ForceMeshUpdate = TMP_Text_ForceMeshUpdate;
export const TextMeshPro_ForceMeshUpdate$bool_bool = TMP_Text_ForceMeshUpdate;

/**
 * GetTextInfo(text)（TextMeshProUGUI／TextMeshPro 的覆寫，反編譯 Unity.TextMeshPro.dll）：SetText(text) 之後馬上重排，
 * m_renderMode 直接設回 Render（不經屬性的 set），回傳 textInfo。
 */
export function TMP_Text_GetTextInfo(c: Ctx, h: H, text: string): TextInfoJs {
  const comp = h.comp;
  if (comp) comp.m_text = text ?? '';
  const st = layout(c, h, true);
  if (comp) comp.m_renderMode = 0xff;
  return st?.info ?? EMPTY_INFO();
}
export const TextMeshProUGUI_GetTextInfo = TMP_Text_GetTextInfo;
export const TextMeshPro_GetTextInfo = TMP_Text_GetTextInfo;

/** GetParsedText()（TMP_Text.cs，反編譯）：textInfo 前 characterCount 個字的 character 接起來（標籤已拿掉） */
export function TMP_Text_GetParsedText(c: Ctx, h: H): string {
  const info = layout(c, h, false)?.info;
  if (!info) return '';
  let s = '';
  for (let i = 0; i < info.characterCount && i < info.characterInfo.length; i++) s += info.characterInfo[i].character as string;
  return s;
}
export const TextMeshProUGUI_GetParsedText = TMP_Text_GetParsedText;
export const TextMeshPro_GetParsedText = TMP_Text_GetParsedText;

type VertexSnap = ({ vertices: number[][]; colors: number[][] } | null)[];
/** 每個元件上一次 UpdateVertexData 登記的掛勾與它的快照：這次的頂點與顏色完全一樣就沿用（版本不變，繪製端不重產） */
const lastVertexHook = new WeakMap<ComponentData, { count: number; snap: VertexSnap; hook: TmpVertexHook }>();

function sameSnap(a: VertexSnap, b: VertexSnap): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (!x || !y) {
      if (x !== y) return false;
      continue;
    }
    if (x.vertices.length !== y.vertices.length || x.colors.length !== y.colors.length) return false;
    for (let k = 0; k < x.vertices.length; k++) {
      const u = x.vertices[k];
      const v = y.vertices[k];
      if (u[0] !== v[0] || u[1] !== v[1] || u[2] !== v[2]) return false;
    }
    for (let k = 0; k < x.colors.length; k++) {
      const u = x.colors[k];
      const v = y.colors[k];
      if (u[0] !== v[0] || u[1] !== v[1] || u[2] !== v[2] || u[3] !== v[3]) return false;
    }
  }
  return true;
}

/**
 * UpdateVertexData(flags)：腳本改過的 meshInfo 頂點與顏色，蓋進接下來產生的網格。
 * 頂點、顏色、字數都跟上一次登記的一樣：把同一個掛勾設回去，版本不變、不重產（產生出來的網格本來就一模一樣）。
 * MT2 戰鬥的 Chatter 文字（Text Animator）每格呼叫一次、內容不變，以前每格整個重產（10/18）
 */
export function TMP_Text_UpdateVertexData$(c: Ctx, h: H, ...flags: unknown[]): void {
  void flags;
  const comp = h.comp;
  const st = comp ? states.get(comp) : undefined;
  const render = world(c)?.services.render;
  if (!comp || !st || !render) return;
  const count = st.result.characterCount;
  const snap: VertexSnap = st.info.meshInfo.map((mi) => (mi ? { vertices: mi.vertices.map((v) => [v.x, v.y, v.z]), colors: mi.colors32.map((k) => [k.r, k.g, k.b, k.a]) } : null));
  const last = lastVertexHook.get(comp);
  if (last && last.count === count && sameSnap(last.snap, snap)) {
    render.setTextHook(comp, last.hook);
    return;
  }
  const hook: TmpVertexHook = {
    version: `csport:${++hookSeq}`,
    apply(result) {
      if (result.characterCount !== count) return;
      for (const sub of result.subMeshes) {
        const m = snap[sub.materialIndex];
        if (!m || m.vertices.length * 3 !== sub.positions.length) continue;
        m.vertices.forEach((v, i) => sub.positions.set(v, i * 3));
        m.colors.forEach((k, i) => sub.colors.set(k, i * 4));
      }
    },
  };
  lastVertexHook.set(comp, { count, snap, hook });
  render.setTextHook(comp, hook);
}
export const TMP_Text_UpdateVertexData$TMP_VertexDataUpdateFlags = TMP_Text_UpdateVertexData$;
export const TextMeshProUGUI_UpdateVertexData$ = TMP_Text_UpdateVertexData$;
export const TextMeshProUGUI_UpdateVertexData$TMP_VertexDataUpdateFlags = TMP_Text_UpdateVertexData$;
export const TextMeshPro_UpdateVertexData$ = TMP_Text_UpdateVertexData$;
export const TextMeshPro_UpdateVertexData$TMP_VertexDataUpdateFlags = TMP_Text_UpdateVertexData$;

/** TMP_TextInfo.CopyMeshInfoVertexData()：每個子網格的頂點、顏色、UV 各複製一份（逐字動畫拿來當原始值） */
export function TMP_TextInfo_CopyMeshInfoVertexData(c: Ctx, info: TextInfoJs): (MeshInfoJs | null)[] {
  void c;
  return info.meshInfo.map((mi) =>
    mi ? { ...mi, vertices: mi.vertices.map((v) => ({ ...v })), colors32: mi.colors32.map((k) => ({ ...k })), uvs0: mi.uvs0.map((u) => ({ ...u })), uvs2: mi.uvs2.map((u) => ({ ...u })) } : null,
  );
}

registerNativeProp('TMP_Text', 'textInfo', { get: (c, h) => layout(c, h, false)?.info ?? EMPTY_INFO() });
registerNativeProp('TMP_Text', 'firstVisibleCharacter', intProp('m_firstVisibleCharacter', 0));
registerNativeProp('TMP_Text', 'maxVisibleCharacters', intProp('m_maxVisibleCharacters', 99999));
registerNativeProp('TMP_Text', 'maxVisibleLines', intProp('m_maxVisibleLines', 99999));
/** renderMode（TextRenderFlags：DontRender 0、Render 255）：繪製端一律照常畫，DontRender 沒有作用（差異清單） */
registerNativeProp('TMP_Text', 'renderMode', intProp('m_renderMode', 0xff));
registerNativeProp('TMP_Text', 'havePropertiesChanged', {
  get: (c, h) => {
    const comp = h.comp;
    return !!comp && changedFrame.get(comp) === (world(c)?.frameCount ?? 0);
  },
  set: (c, h, v) => {
    const comp = h.comp;
    if (!comp) return;
    if (v) markChanged(c, comp);
    else changedFrame.delete(comp);
  },
});
/** TMP_Text.bounds（GetCompoundBounds，TMPro_Private.cs:4631-4650）：主網格的 AABB 併入有內容的子網格 */
registerNativeProp('TMP_Text', 'bounds', {
  get: (c, h) => {
    const st = layout(c, h, false);
    const min = { x: Infinity, y: Infinity, z: Infinity };
    const max = { x: -Infinity, y: -Infinity, z: -Infinity };
    for (const s of st?.result.subMeshes ?? []) {
      if (s.materialIndex !== 0 && s.indices.length === 0) continue;
      for (let i = 0; i + 2 < s.positions.length; i += 3) {
        min.x = Math.min(min.x, s.positions[i]);
        min.y = Math.min(min.y, s.positions[i + 1]);
        min.z = Math.min(min.z, s.positions[i + 2]);
        max.x = Math.max(max.x, s.positions[i]);
        max.y = Math.max(max.y, s.positions[i + 1]);
        max.z = Math.max(max.z, s.positions[i + 2]);
      }
    }
    if (!Number.isFinite(min.x)) return { center: { x: 0, y: 0, z: 0 }, extents: { x: 0, y: 0, z: 0 } };
    return {
      center: { x: (min.x + max.x) / 2, y: (min.y + max.y) / 2, z: (min.z + max.z) / 2 },
      extents: { x: (max.x - min.x) / 2, y: (max.y - min.y) / 2, z: (max.z - min.z) / 2 },
    };
  },
});
/** TMP_Text.mesh／TextMeshProUGUI.mesh：主網格（腳本多半只判斷不是 null，再去改 textInfo.meshInfo） */
const meshProp = {
  get: (c: Ctx, h: H) => {
    const mi = layout(c, h, false)?.info.meshInfo[0];
    return { $type: 'Mesh', vertices: mi?.vertices ?? [], colors32: mi?.colors32 ?? [], vertexCount: mi?.vertexCount ?? 0 };
  },
};
registerNativeProp('TMP_Text', 'mesh', meshProp);
registerNativeProp('TextMeshProUGUI', 'mesh', meshProp);

/**
 * TMP_TextUtilities.FindIntersectingLink(text, position, camera)（TMP_TextUtilities.cs）：螢幕點落在哪個 <link> 的字上（字的四邊形），沒有回 -1。
 * 螢幕點換成文字的區域座標用 EventSystem 同一套（Overlay 不用攝影機）。
 */
export function TMP_TextUtilities_FindIntersectingLink(c: Ctx, h: H, position: { x: number; y: number }, camera: unknown): number {
  void camera;
  const w = world(c);
  const st = layout(c, h, false);
  if (!w || !st) return -1;
  const s = w.events.screenSize;
  const p = w.events.screenPointToLocal(h.node, position.x, position.y, s.w, s.h);
  if (!p) return -1;
  const chars = st.result.textInfo.characterInfo;
  const links = st.result.textInfo.linkInfo;
  for (let li = 0; li < st.result.textInfo.linkCount && li < links.length; li++) {
    const link = links[li];
    for (let k = 0; k < link.linkTextLength; k++) {
      const ch = chars[link.linkTextfirstCharacterIndex + k];
      if (!ch) continue;
      if (p.x >= ch.bottomLeft.x && p.x <= ch.topRight.x && p.y >= ch.bottomLeft.y && p.y <= ch.topRight.y) return li;
    }
  }
  return -1;
}

// 子類別（ExtendedTextMeshProUGUI）叫 base.ForceMeshUpdate()／base.UpdateVertexData()：同上
registerNativeBase('TMP_Text.ForceMeshUpdate', (c, self) => TMP_Text_ForceMeshUpdate(c, self as H));
registerNativeBase('TMP_Text.UpdateVertexData', (c, self) => TMP_Text_UpdateVertexData$(c, self as H));

// ───────── Graphic 重建：覆寫 Rebuild 的 TMP 子類別 ─────────
// Unity 的文字一變（屬性的 set、rect 改大小都會 SetVerticesDirty），Canvas 畫之前 CanvasUpdateRegistry.PerformUpdate 叫 Graphic.Rebuild(PreRender)，
// 子類別覆寫的 Rebuild 跟著跑：ExtendedTextMeshProUGUI 在這裡 WarpText 彎字（地圖的區域名稱、Select a Track）。
// 這裡沒有逐元件的 Canvas 重建：base.OnEnable 時登記，每格 willRenderCanvases（排版之後）比對排版輸入、字距與文字顏色，變了才叫產生碼的
// Rebuild(PreRender)。以前只有 OnEnable 那一次，之後文字一改（在地化、地圖設名稱），掛勾的字數對不上就不蓋，標籤變成直的。
// 字距與顏色也要比：WarpText 經 UpdateVertexData 登記的掛勾連頂點色一起蓋，顏色改了不重跑會蓋回舊色。
const rebuildTargets = new Map<ComponentData, { h: H; cls: string; key: string | null }>();
function overridesRebuild(cls: string): boolean {
  for (let k: string | undefined = cls; k && hasGen(k); k = genClass(k).base) if (genClass(k).overrides?.Rebuild) return true;
  return false;
}
function rebuildKey(h: H): string {
  const comp = h.comp!;
  return `${inputKey(h)}|${comp.m_characterSpacing}|${JSON.stringify(comp.m_fontColor)}|${JSON.stringify(comp.m_fontColor32)}|${comp.m_enableVertexGradient}`;
}
registerNativeBase('TMP_Text.OnEnable', (_c, self) => {
  const h = self as H;
  const comp = h.comp;
  const cls = comp ? scriptGenName(comp.script) : undefined;
  if (!comp || !cls || !hasGen(cls) || !overridesRebuild(cls)) return;
  if (!rebuildTargets.has(comp)) rebuildTargets.set(comp, { h, cls, key: null });
});
registerWillRenderCanvases((w) => {
  for (const [comp, t] of rebuildTargets) {
    const node = t.h.node;
    if (w.graph.nodes.get(node.id) !== node) {
      rebuildTargets.delete(comp); // 銷毀了
      continue;
    }
    if (!node.activeInHierarchy || comp.m_Enabled === 0) continue;
    const key = rebuildKey(t.h);
    if (key === t.key) continue;
    t.key = key;
    w.guard(`${t.cls}.Rebuild`, () => genCallVirtual(w, t.cls, t.h, 'Rebuild', 3 /* CanvasUpdate.PreRender */));
  }
});

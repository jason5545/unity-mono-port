// TMP 排版模組（src/runtime/text/）要的素材介面 TextAssets 的實作：讀 public/game/assets 的 JSON，
// 動態字型（m_AtlasPopulationMode 1）缺字時用 assets/glyphs/ 的輪廓即時算 SDF、排進這個字型自己的 atlas。
//
// TextAssets 是同步介面（TMP 的 TryAddCharacterInternal 也是同步），所以字形資料要先 preload：
// 繪製前對場景用到的字型呼叫 prepare()，它會把整條 fallback 鏈上動態字型的字形檔載好。

import { fetchJsonCached } from '../unity/packs';
import type { ExternalRef } from '../unity/types';
import type { RawObject, TextAssets } from '../text/types';
import { GlyphAtlas } from './atlas';
import { renderSdf, type Outline } from './sdf';

interface MonoIndexEntry {
  name: string;
  src: string;
  kind: string | null;
  file: string;
}
interface GlyphStore {
  font: string;
  pointSize: number;
  cmap: Record<string, number>;
  glyphs: Record<string, [number, number, number, number, number, Outline]>;
}

// TMP_SpriteAsset：新版匯入器分得出來（舊的 0b 歸成 TMP_FontAsset，建構子照 m_SpriteCharacterTable 再分）
const TMP_KINDS = new Set(['TMP_FontAsset', 'TMP_SpriteAsset', 'TMP_Settings', 'TMP_StyleSheet', 'TMP_ColorGradient']);
/** Diceomancer 的 TMP Settings（測試資料用 guid 給；遊戲照 Resources 路徑找，見建構子） */
const SETTINGS_GUID = '1ef33ef2ba3054448b22726c1476ec0e';

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}：HTTP ${res.status}`);
  return (await res.json()) as T;
}

/** "Resources/fonts & materials/Biko_Bold SDF.asset" → "fonts & materials/biko_bold sdf"（Resources.Load 的路徑，不分大小寫） */
export function resourcePath(src: string): string | null {
  const i = src.toLowerCase().lastIndexOf('resources/');
  if (i < 0) return null;
  return src.slice(i + 'resources/'.length).replace(/\.[^./]+$/, '').toLowerCase();
}

/** 動態字型執行時的狀態：atlas 與已加的字 */
export interface DynamicFont {
  guid: string;
  atlas: GlyphAtlas;
  store: GlyphStore;
  /** unicode → 加過的結果（null = 字型沒有這個字或 atlas 滿了） */
  added: Map<number, { character: RawObject; glyph: RawObject } | null>;
  /** build 裡烘好的 atlas 貼圖（m_AtlasTextures[0]）；烘好的 glyph 位置已在 prepare 佔住（atlas.reserve），
   *  像素由繪製端合進來（sceneRenderer.seedBakedAtlas，只複製 bakedRects 的範圍）。沒有烘好內容的字型是 null */
  baked: ExternalRef | null;
  /** 烘好 glyph 的佔用區（rect 外擴 padding+1，已夾進 atlas 範圍）；繪製端只從烘好的圖片複製這些範圍 */
  bakedRects: { x: number; y: number; width: number; height: number }[];
}

export class GameTextAssets implements TextAssets {
  readonly settings: RawObject;
  readonly dynamicFonts = new Map<string, DynamicFont>();
  readonly warnings: string[] = [];
  private readonly resources = new Map<string, { kind: string; ref: ExternalRef }[]>();

  private constructor(
    private readonly base: string,
    private readonly index: Record<string, MonoIndexEntry>,
    private readonly objects: Map<string, RawObject>,
    private readonly materials: Record<string, RawObject & { src?: string; m_Name?: string }>,
    private readonly texts: Record<string, { text: string }>,
    private readonly glyphIndex: Record<string, string>,
    usage: Record<string, number>,
  ) {
    // Resources 路徑表。兩個 Resources 資料夾（Resources/、TextMesh Pro/Resources/）有同名副本時，場景用得多的排前面
    const add = (src: string | undefined, kind: string, guid: string, fileID: string) => {
      const p = src && resourcePath(src);
      if (!p) return;
      const list = this.resources.get(p) ?? [];
      list.push({ kind, ref: { guid, fileID } });
      this.resources.set(p, list);
    };
    // 0b 把 sprite asset 也歸成 TMP_FontAsset（同一種腳本判斷不出來），有 m_SpriteCharacterTable 的才是 sprite asset
    for (const [guid, m] of Object.entries(index)) if (m.kind) add(m.src, m.kind === 'TMP_FontAsset' && objects.get(guid)?.m_SpriteCharacterTable ? 'TMP_SpriteAsset' : m.kind, guid, '11400000');
    for (const [guid, m] of Object.entries(materials)) add(m.src as string | undefined, 'Material', guid, '2100000');
    for (const list of this.resources.values()) list.sort((a, b) => (usage[b.ref.guid] ?? 0) - (usage[a.ref.guid] ?? 0) || a.ref.guid.localeCompare(b.ref.guid));
    // TMP_Settings.instance ＝ Resources.Load<TMP_Settings>("TMP Settings")（TMP_Settings.cs）。10/16 以前寫死 Diceomancer 的 guid，
    // MT2 的設定讀不到（預設 sprite asset 是空的，<sprite> 標籤整段當文字）
    const settingsRef = this.resources.get('tmp settings')?.find((r) => r.kind === 'TMP_Settings')?.ref;
    this.settings = (settingsRef && objects.get(settingsRef.guid)) || objects.get(SETTINGS_GUID) || {};
  }

  /** base 是 public/game/assets 的網址。usage：guid → 場景與 prefab 參照次數（同名副本挑哪個用） */
  static async load(base: string, usage: Record<string, number> = {}): Promise<GameTextAssets> {
    const [index, materials, texts, glyphs] = await Promise.all([
      fetchJsonCached<Record<string, MonoIndexEntry>>(`${base}monobehaviours.json`),
      fetchJsonCached<Record<string, RawObject>>(`${base}materials.json`),
      fetchJsonCached<Record<string, { text: string }>>(`${base}texts.json`),
      fetchJsonCached<{ fontAssets: Record<string, string> }>(`${base}glyphs.json`),
    ]);
    const objects = new Map<string, RawObject>();
    await Promise.all(
      Object.entries(index)
        .filter(([, m]) => m.kind && TMP_KINDS.has(m.kind))
        .map(async ([guid, m]) => objects.set(guid, await fetchJsonCached<RawObject>(`${base}${m.file}`))),
    );
    return new GameTextAssets(base, index, objects, materials, texts, glyphs.fontAssets, usage);
  }

  /** 測試用：直接給資料（字形檔用 storeLoader 讀） */
  static fromData(
    index: Record<string, MonoIndexEntry>,
    objects: Map<string, RawObject>,
    materials: Record<string, RawObject>,
    texts: Record<string, { text: string }>,
    glyphIndex: Record<string, string>,
    usage: Record<string, number> = {},
  ): GameTextAssets {
    return new GameTextAssets('', index, objects, materials, texts, glyphIndex, usage);
  }

  object(ref: ExternalRef): RawObject | null {
    return this.objects.get(ref.guid) ?? null;
  }

  material(ref: ExternalRef): RawObject | null {
    return this.materials[ref.guid] ?? null;
  }

  textAsset(ref: ExternalRef): string | null {
    return this.texts[ref.guid]?.text ?? null;
  }

  resource(path: string, kind: Parameters<TextAssets['resource']>[1]): { ref: ExternalRef; data: RawObject } | null {
    const hit = this.resources.get(path.toLowerCase())?.find((r) => r.kind === kind);
    if (!hit) return null;
    const data = kind === 'Material' ? this.material(hit.ref) : this.object(hit.ref);
    return data ? { ref: hit.ref, data } : null;
  }

  /** 字型的整條 fallback 鏈（含自己），照 m_FallbackFontAssetTable 遞迴，去重 */
  fallbackChain(guid: string, out: string[] = []): string[] {
    if (out.includes(guid)) return out;
    out.push(guid);
    for (const r of (this.objects.get(guid)?.m_FallbackFontAssetTable as ExternalRef[] | undefined) ?? []) if (r?.guid) this.fallbackChain(r.guid, out);
    return out;
  }

  /** 載入這些字型（含 fallback 鏈、TMP Settings 的預設字型與 fallback）裡動態字型的字形檔 */
  async prepare(fontGuids: Iterable<string>, loadStore: (file: string) => Promise<GlyphStore> = (f) => fetchJson(`${this.base}glyphs/${f}`)): Promise<void> {
    const want = new Set<string>();
    const settingsFonts = [this.settings.m_defaultFontAsset, ...((this.settings.m_fallbackFontAssets as unknown[]) ?? [])] as (ExternalRef | null)[];
    for (const g of [...fontGuids, ...settingsFonts.filter((r) => r?.guid).map((r) => r!.guid)]) for (const f of this.fallbackChain(g)) want.add(f);
    await Promise.all(
      [...want].map(async (guid) => {
        const font = this.objects.get(guid);
        const file = this.glyphIndex[guid];
        if (!font || font.m_AtlasPopulationMode !== 1 || !file || this.dynamicFonts.has(guid)) return;
        const store = await loadStore(file);
        const atlas = new GlyphAtlas(font.m_AtlasWidth as number, font.m_AtlasHeight as number, font.m_AtlasPadding as number);
        // 動態字型在 build 裡可能帶著烘好的內容（m_GlyphTable 與 m_AtlasTextures[0]）：先佔住烘好的位置，
        // 執行時新加的字才不會蓋到（TMP 的動態字型：執行時加字是加進同一張 atlas）
        const baked = ((font.m_AtlasTextures as ExternalRef[] | undefined) ?? [])[0] ?? null;
        const bakedRects: { x: number; y: number; width: number; height: number }[] = [];
        if (baked) {
          const p = (font.m_AtlasPadding as number) + 1;
          const W = font.m_AtlasWidth as number;
          const H = font.m_AtlasHeight as number;
          for (const g of (font.m_GlyphTable as RawObject[] | undefined) ?? []) {
            const r = g.m_GlyphRect as { m_X: number; m_Y: number; m_Width: number; m_Height: number } | undefined;
            if (!r || r.m_Width <= 0 || r.m_Height <= 0) continue;
            const zone = {
              x: Math.max(0, r.m_X - p),
              y: Math.max(0, r.m_Y - p),
              width: Math.min(W, r.m_X + r.m_Width + p) - Math.max(0, r.m_X - p),
              height: Math.min(H, r.m_Y + r.m_Height + p) - Math.max(0, r.m_Y - p),
            };
            bakedRects.push(zone);
            atlas.reserve(zone);
          }
        }
        this.dynamicFonts.set(guid, { guid, store, atlas, added: new Map(), baked, bakedRects });
      }),
    );
  }

  addDynamicCharacter(ref: ExternalRef, unicode: number): { character: RawObject; glyph: RawObject } | null {
    const df = this.dynamicFonts.get(ref.guid);
    if (!df) {
      this.warnings.push(`動態字型 ${this.index[ref.guid]?.name ?? ref.guid} 的字形檔沒有先載入（prepare）`);
      return null;
    }
    if (df.added.has(unicode)) return df.added.get(unicode)!;
    const gid = df.store.cmap[unicode];
    const g = gid !== undefined ? df.store.glyphs[gid] : undefined;
    let result: { character: RawObject; glyph: RawObject } | null = null;
    if (g) {
      // 同一個 glyph 被別的字元用過（例如兩個 unicode 對到同一個字形）就共用 GlyphRect
      const shared = [...df.added.values()].find((r) => r && r.glyph.m_Index === gid);
      let rect = shared?.glyph.m_GlyphRect as { m_X: number; m_Y: number; m_Width: number; m_Height: number } | undefined;
      if (!rect) {
        const placed = df.atlas.add(renderSdf(g[5], df.atlas.padding));
        if (placed) rect = { m_X: placed.x, m_Y: placed.y, m_Width: placed.width, m_Height: placed.height };
        else this.warnings.push(`${df.store.font} 的 atlas（${df.atlas.width}²）滿了，U+${unicode.toString(16)} 加不進去`);
      }
      if (rect) {
        result = {
          character: { m_ElementType: 1, m_Unicode: unicode, m_GlyphIndex: gid, m_Scale: 1 },
          glyph: {
            m_Index: gid,
            m_Metrics: { m_Width: g[0] / 64, m_Height: g[1] / 64, m_HorizontalBearingX: g[2] / 64, m_HorizontalBearingY: g[3] / 64, m_HorizontalAdvance: g[4] / 64 },
            m_GlyphRect: rect,
            m_Scale: 1,
            m_AtlasIndex: 0,
            m_ClassDefinitionType: 0,
          },
        };
      }
    }
    df.added.set(unicode, result);
    return result;
  }
}

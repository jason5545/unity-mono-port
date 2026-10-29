// 元件專屬的材質（Unity 的 Renderer.material 語意）。
//
// 原版 Renderer.material 第一次存取時，替這個 renderer 複製一份材質實例；之後改它的屬性只影響這個 renderer
// （CardBase.cs:932 的 principleSpriteRenderer.material、:284 的 SetTexture 都是這樣）。
// 這裡的做法：SpriteRenderer 的元件（ComponentData）第一次要自己的材質時，才複製一份 MaterialInfo。
// shader 與關鍵字照共用的，m_SavedProperties（float、color、貼圖參照）複製一份。
// 沒有人要過的元件繼續讀共用的材質紀錄（db.material 回傳的那份），不替場景裡每個 SpriteRenderer 預先複製。
//
// 繪製端（sceneRenderer.ts）讀材質屬性的兩處：fillCbuffers 每格、bindTextures 綁貼圖時，元件有複本就讀複本，沒有就讀共用紀錄。
// 複本存在 WeakMap 裡，鍵是元件物件；元件（節點）銷毀後跟著被回收。

import type { MaterialInfo } from '../unity/assets';
import type { ColorRGBA } from '../unity/types';

const copies = new WeakMap<object, MaterialInfo>();

/** 這個元件已經有自己的材質複本就回傳；沒有回傳 null（繪製端就讀共用紀錄） */
export function rendererMaterialIfAny(comp: object): MaterialInfo | null {
  return copies.get(comp) ?? null;
}

/** 第一次要的時候複製：shared 是 db.material(comp.m_Materials[0]) 的共用紀錄。之後的呼叫回傳同一份複本 */
export function rendererMaterialCopy(comp: object, shared: MaterialInfo): MaterialInfo {
  const have = copies.get(comp);
  if (have) return have;
  const sp = structuredClone(shared.record.m_SavedProperties);
  // 缺的表補空的（內建材質的紀錄可能沒有某一張表）；寫入時才不用每次檢查
  sp.m_Floats ??= {};
  sp.m_Colors ??= {};
  sp.m_TexEnvs ??= {};
  const copy: MaterialInfo = {
    name: shared.name,
    shaderName: shared.shaderName,
    record: { ...shared.record, m_SavedProperties: sp },
  };
  copies.set(comp, copy);
  return copy;
}

/** 忘掉元件的材質複本（LineRenderer.material 換成別的材質時用；下一次要的時候從新的共用材質複製）。第 3 輪 */
export function forgetRendererMaterial(comp: object): void {
  copies.delete(comp);
}

/** Material.SetFloat */
export function setRendererFloat(m: MaterialInfo, name: string, value: number): void {
  m.record.m_SavedProperties.m_Floats[name] = value;
}

/**
 * Material.SetColor。值用 ColorPattern 的 float（colors.ts 的 FLOATS），跟材質序列化的顏色是同一套數字
 * （CardNameBG 材質序列化的 _WorldColor 就是綠色 ColorPattern 的值），之後走繪製端對顏色屬性的同一條路。
 */
export function setRendererColor(m: MaterialInfo, name: string, c: ColorRGBA): void {
  m.record.m_SavedProperties.m_Colors[name] = { r: c.r, g: c.g, b: c.b, a: c.a };
}

/**
 * Material.SetTexture 的參照部分（只改參照；貼圖的載入與綁到繪製物件上由繪製端做）。
 * fileID 2800000 是 Texture2D 的 fileID（materials.json 裡的貼圖參照都是這個）。
 */
export function setRendererTextureRef(m: MaterialInfo, name: string, textureGuid: string): void {
  const env = m.record.m_SavedProperties.m_TexEnvs;
  const cur = env[name];
  env[name] = {
    m_Texture: { guid: textureGuid, fileID: '2800000' },
    m_Scale: cur?.m_Scale ?? { x: 1, y: 1 },
    m_Offset: cur?.m_Offset ?? { x: 0, y: 0 },
  };
}

/** 目前綁著的貼圖 guid（沒有、或是 Unity 內建的 0000… 參照就回傳 null） */
export function rendererTextureGuid(m: MaterialInfo, name: string): string | null {
  const ref = m.record.m_SavedProperties.m_TexEnvs?.[name]?.m_Texture;
  return ref && 'guid' in ref && !ref.guid.startsWith('0000') ? ref.guid : null;
}

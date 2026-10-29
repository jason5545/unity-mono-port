// 重產偵測（meshRefresh.ts）：什麼都沒改時 key 不變（不觸發重產）；改 m_text／m_fontColor／m_fontSize、rect 寬度、
// CanvasRenderer 顏色（tint）、啟用狀態任一項，key 都要變（觸發重產）。
// 用真元件：level1 的 1104（TextMeshProUGUI，PLAY 文字）與一個真 Image（level1 音樂滑桿的 Handle）。
// 腳本是就地把欄位改掉的（comp.m_text = …），測試也用就地改，跟執行時一樣。

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ComponentData, SceneFile } from '../unity/types';
import { meshRefreshKey, type RefreshInput } from './meshRefresh';
import { TEST_GAME } from '../testData';

const GAME = TEST_GAME;
function load<T>(p: string): T {
  const f = resolve(GAME, p);
  if (!existsSync(f)) throw new Error(`找不到 ${f}，先跑 npm run import`);
  return JSON.parse(readFileSync(f, 'utf-8')) as T;
}

const level1 = load<SceneFile>('scenes/level1.json');

// level1 音樂滑桿的 Handle（SettingCanvasMainMenu/.../Music Slider/MusicSlider/Handle Slide Area/Handle）
function findHandle(): ComponentData {
  for (const g of Object.values(level1.gameObjects)) {
    if (g.m_Name !== 'Handle') continue;
    const img = g.components.map((cid) => level1.components[cid]).find((c) => (c.script?.class ?? c.type) === 'Image');
    if (img) return img;
  }
  throw new Error('level1 找不到 Handle 的 Image');
}

const INPUT: RefreshInput = {
  rect: { x: -143, y: -28.5, width: 286, height: 57 },
  lossyScaleY: 0.01,
  canvasScaleFactor: 1,
  tint: null,
  canvasAlpha: 1,
  active: true,
  enabled: true,
};

describe('重產偵測：meshRefreshKey', () => {
  it('什麼都沒改 → key 不變（不觸發重產）', () => {
    const comp = JSON.parse(JSON.stringify(level1.components['1104'])) as ComponentData;
    const k0 = meshRefreshKey(comp, INPUT);
    expect(meshRefreshKey(comp, INPUT)).toBe(k0);
    expect(meshRefreshKey(comp, { ...INPUT })).toBe(k0);
  });

  it('TMP：改 m_text／m_fontColor／m_fontSize／rect 寬度／tint／啟用 → key 變（觸發重產）', () => {
    const comp = JSON.parse(JSON.stringify(level1.components['1104'])) as ComponentData;
    const k0 = meshRefreshKey(comp, INPUT);

    comp.m_text = 'PLAY!';
    expect(meshRefreshKey(comp, INPUT)).not.toBe(k0);
    comp.m_text = level1.components['1104'].m_text;

    comp.m_fontColor = { r: 0.99607843, g: 0.84705883, b: 0.3529412, a: 1 }; // MainMenuButton 滑過的 selectColor
    expect(meshRefreshKey(comp, INPUT)).not.toBe(k0);
    comp.m_fontColor = level1.components['1104'].m_fontColor;

    comp.m_fontSize = (comp.m_fontSize as number) + 1;
    expect(meshRefreshKey(comp, INPUT)).not.toBe(k0);
    comp.m_fontSize = level1.components['1104'].m_fontSize;

    expect(meshRefreshKey(comp, { ...INPUT, rect: { ...INPUT.rect, width: INPUT.rect.width + 1 } })).not.toBe(k0);
    expect(meshRefreshKey(comp, { ...INPUT, tint: { r: 0.96, g: 0.96, b: 0.96, a: 1 } })).not.toBe(k0);
    expect(meshRefreshKey(comp, { ...INPUT, active: false })).not.toBe(k0);
    expect(meshRefreshKey(comp, { ...INPUT, enabled: false })).not.toBe(k0);
    // 全部還原後回到原 key
    expect(meshRefreshKey(comp, INPUT)).toBe(k0);
  });

  it('Image：改 m_Color／m_Sprite／m_FillAmount／rect 高度 → key 變', () => {
    const handle = findHandle();
    const comp = JSON.parse(JSON.stringify(handle)) as ComponentData;
    const k0 = meshRefreshKey(comp, INPUT);

    comp.m_Color = { r: 0.5, g: 0.5, b: 0.5, a: 1 };
    expect(meshRefreshKey(comp, INPUT)).not.toBe(k0);
    comp.m_Color = handle.m_Color;

    comp.m_Sprite = null;
    expect(meshRefreshKey(comp, INPUT)).not.toBe(k0);
    comp.m_Sprite = handle.m_Sprite;

    comp.m_FillAmount = 0.5;
    expect(meshRefreshKey(comp, INPUT)).not.toBe(k0);
    comp.m_FillAmount = handle.m_FillAmount;

    expect(meshRefreshKey(comp, { ...INPUT, rect: { ...INPUT.rect, height: INPUT.rect.height + 1 } })).not.toBe(k0);
    expect(meshRefreshKey(comp, INPUT)).toBe(k0);
  });
});

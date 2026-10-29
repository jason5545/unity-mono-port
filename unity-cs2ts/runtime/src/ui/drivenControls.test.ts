// drivenControls.ts（Slider／Scrollbar 驅動錨點）的測試，用真資料。
// 期望值逐條對照反編譯 C#：Slider.cs 的 ClampValue／normalizedValue／UpdateVisuals、
// Scrollbar.cs 的 value getter／UpdateVisuals；1、2 兩條用 Unity 存下的真值錨點。
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { layoutWithUI, SceneGraph } from '../unity/scene';
import type { ComponentData, SceneFile } from '../unity/types';
import { updateDrivenControls } from './drivenControls';
import { TEST_GAME } from '../testData';

const GAME = TEST_GAME;
function load<T>(p: string): T {
  const f = resolve(GAME, p);
  if (!existsSync(f)) throw new Error(`找不到 ${f}，先跑 npm run import`);
  return JSON.parse(readFileSync(f, 'utf8')) as T;
}

/** 取 RectTransform 元件的錨點，回傳 [minX, minY, maxX, maxY] 方便逐個 toBeCloseTo */
function anchors(file: SceneFile, id: string): number[] {
  const c = file.components[id] as ComponentData;
  const min = c.m_AnchorMin as { x: number; y: number };
  const max = c.m_AnchorMax as { x: number; y: number };
  return [min.x, min.y, max.x, max.y];
}

function expectAnchors(file: SceneFile, id: string, want: [number, number, number, number]): void {
  const got = anchors(file, id);
  want.forEach((v, i) => expect(got[i]).toBeCloseTo(v, 6));
}

describe('drivenControls：Slider／Scrollbar 驅動錨點', () => {
  it('Unity 存下的真值（Scrollbar，TopToBottom）：level2 的 1544 重算後跟存檔一模一樣', () => {
    const file = load<SceneFile>('scenes/level2.json');
    const before = anchors(file, '1544');
    updateDrivenControls(new SceneGraph(file));
    expectAnchors(file, '1544', [0, 0.735988, 1, 0.789988]);
    expect(anchors(file, '1544')).toEqual(before);
  });

  it('Unity 存下的真值（Scrollbar，值是負數）：負值 clamp01 成 0，重算後錨點不變、m_Value 不寫回', () => {
    const file = load<SceneFile>('scenes/prefabs/b43f81e5d978a4e43ba1231acc3bcd8a.json');
    const before = anchors(file, '224809695087409508');
    const sb = file.components['114830934961530103'] as ComponentData;
    updateDrivenControls(new SceneGraph(file));
    expectAnchors(file, '224809695087409508', [0, 0, 1, 0.27440158]);
    expect(anchors(file, '224809695087409508')).toEqual(before);
    expect(sb.m_Value).toBeCloseTo(-8.797353e-8, 6);
  });

  it('Slider：value 0.1 → 填充條錨點 (0,0)–(0.1,1)、拉桿 (0.1,0)–(0.1,1)', () => {
    const file = load<SceneFile>('scenes/level1.json');
    updateDrivenControls(new SceneGraph(file));
    expectAnchors(file, '1020', [0, 0, 0.1, 1]);
    expectAnchors(file, '1057', [0.1, 0, 0.1, 1]);
  });

  it('Slider 的 Filled 填充：Image m_Type=3 時改 m_FillAmount，填充條錨點維持 (0,0)–(1,1)', () => {
    const file = load<SceneFile>('scenes/level1.json');
    (file.components['1312'] as ComponentData).m_Value = 0.4;
    updateDrivenControls(new SceneGraph(file));
    expect((file.components['1487'] as ComponentData).m_FillAmount).toBeCloseTo(0.4, 6);
    expectAnchors(file, '913', [0, 0, 1, 1]);
    expectAnchors(file, '1060', [0.4, 0, 0.4, 1]);
  });

  it('Scrollbar：value 0.60911894、size 0.27871427 → 拉桿 (0,0.4393488)–(1,0.71806306)', () => {
    const file = load<SceneFile>('scenes/level1.json');
    updateDrivenControls(new SceneGraph(file));
    expectAnchors(file, '875', [0, 0.4393488, 1, 0.71806306]);
  });

  it('反向（RightToLeft）：填充條從右邊縮、拉桿在 1−nv', () => {
    const file = load<SceneFile>('scenes/level1.json');
    const slider = file.components['1243'] as ComponentData;
    slider.m_Direction = 1;
    slider.m_Value = 0.25;
    updateDrivenControls(new SceneGraph(file));
    expectAnchors(file, '1020', [0.75, 0, 1, 1]);
    expectAnchors(file, '1057', [0.75, 0, 0.75, 1]);
  });

  it('整數取整取偶數：Mathf.Round(2.5) = 2（不是 3）', () => {
    const file = load<SceneFile>('scenes/level1.json');
    const slider = file.components['1243'] as ComponentData;
    slider.m_WholeNumbers = 1;
    slider.m_MaxValue = 10;
    slider.m_Value = 2.5;
    updateDrivenControls(new SceneGraph(file));
    expect(slider.m_Value).toBe(2);
    expectAnchors(file, '1020', [0, 0, 0.2, 1]);
  });

  it('步數取整取偶數、不寫回：Round(0.625×4)/4 = 2/4 = 0.5，m_Value 仍是 0.625', () => {
    const file = load<SceneFile>('scenes/level1.json');
    const sb = file.components['1260'] as ComponentData;
    sb.m_NumberOfSteps = 5;
    sb.m_Value = 0.625;
    updateDrivenControls(new SceneGraph(file));
    expectAnchors(file, '875', [0, 0.36064285, 1, 0.6393571]);
    expect(sb.m_Value).toBe(0.625);
  });

  it('反面：m_Enabled=0 的不處理；填充條指向 slider 自己時不碰填充條', () => {
    const a = load<SceneFile>('scenes/level1.json');
    (a.components['1243'] as ComponentData).m_Enabled = 0;
    updateDrivenControls(new SceneGraph(a));
    expectAnchors(a, '1020', [0, 0, 0, 0]);
    expectAnchors(a, '1057', [0, 0, 0, 0]);

    const b = load<SceneFile>('scenes/level1.json');
    (b.components['1243'] as ComponentData).m_FillRect = { fileID: '832' };
    updateDrivenControls(new SceneGraph(b));
    expectAnchors(b, '832', [0, 0, 0, 0]);
    expectAnchors(b, '1057', [0.1, 0, 0.1, 1]);
  });

  it('接上排版：layoutWithUI 會先重算驅動錨點', () => {
    const file = load<SceneFile>('scenes/level1.json');
    layoutWithUI(new SceneGraph(file), 1920, 1080);
    expectAnchors(file, '1020', [0, 0, 0.1, 1]);
  });
});

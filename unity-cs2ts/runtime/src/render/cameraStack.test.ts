// built-in 管線的攝影機（2026/10/17，MT2 的戰鬥畫面：GameCamera 透視畫火車與角色、UICamera 只清深度畫 UI 層、CardTrailCamera 畫進 RenderTexture）
import { describe, expect, it } from 'vitest';
import { Matrix4, Quaternion, Vector3, Vector4 } from 'three';
import type { CameraInfo, SceneNode } from '../unity/scene';
import type { ComponentData } from '../unity/types';
import {
  CLEAR_DEPTH,
  CLEAR_SOLID_COLOR,
  coversScreen,
  cullingMask,
  firstVisibleCamera,
  inCullingMask,
  overlayProjection,
  overlayView,
  projectionOf,
  renderPipelineOf,
  screenCameras,
  targetCameras,
  viewOf,
  viewportPixels,
} from './cameraStack';

function cam(name: string, comp: Partial<ComponentData>, opts: { active?: boolean; pos?: Vector3; ortho?: boolean } = {}): CameraInfo {
  const node = { go: { m_Name: name }, activeInHierarchy: opts.active ?? true, world: new Matrix4().compose(opts.pos ?? new Vector3(), new Quaternion(), new Vector3(1, 1, 1)) } as unknown as SceneNode;
  return { node, data: { type: 'Camera', m_Enabled: 1, ...comp } as ComponentData, orthographic: !!opts.ortho, orthographicSize: 5, fieldOfView: 60, near: 0.3, far: 1000 };
}

describe('cameraStack：哪幾台畫到螢幕、照什麼順序', () => {
  it('照 depth 由小到大；同 depth 照場景樹順序；停用的與有 targetTexture 的不畫', () => {
    const main = cam('Main Camera', { m_Depth: -1, m_ClearFlags: 1 });
    const trail = cam('CardTrailCamera', { m_Depth: 0, m_ClearFlags: 2 });
    const off = cam('UIParticleOverlayCamera', { m_Depth: 0, m_Enabled: 0 });
    const rim = cam('RimLightCamera', { m_Depth: -2 }, { active: false });
    const game = cam('GameCamera', { m_Depth: -1, m_ClearFlags: 1 });
    const ui = cam('UICamera', { m_Depth: 0, m_ClearFlags: 3 });
    const order = screenCameras([trail, main, off, rim, game, ui], (c) => c === trail.data);
    expect(order.map((c) => c.node.go.m_Name)).toEqual(['Main Camera', 'GameCamera', 'UICamera']);
    // GameCamera 清整個畫面（Skybox），它前面的 Main Camera 畫了也看不到：從 GameCamera 開始
    expect(firstVisibleCamera(order, 1920, 1080)).toBe(1);
  });
  it('有 targetTexture 的另外列出：照 depth、同 depth 照場景樹順序，停用的不算', () => {
    const rtA = { width: 4, height: 4 };
    const rtB = { width: 8, height: 8 };
    const a = cam('A', { m_Depth: 1 });
    const b = cam('B', { m_Depth: -1 });
    const off = cam('Off', { m_Depth: -5, m_Enabled: 0 });
    const plain = cam('Plain', { m_Depth: -9 });
    const targets = new Map<ComponentData, { width: number; height: number }>([
      [a.data, rtA],
      [b.data, rtB],
      [off.data, rtA],
    ]);
    const list = targetCameras([a, b, off, plain], (c) => targets.get(c) ?? null);
    expect(list.map((x) => x.cam.node.go.m_Name)).toEqual(['B', 'A']);
    expect(list[0].target).toBe(rtB);
  });
  it('只清深度、或 viewport 沒蓋滿的不算蓋住畫面', () => {
    expect(coversScreen(cam('a', { m_ClearFlags: CLEAR_DEPTH }), 100, 100)).toBe(false);
    expect(coversScreen(cam('b', { m_ClearFlags: CLEAR_SOLID_COLOR, m_NormalizedViewPortRect: { x: 0, y: 0, width: 0.5, height: 1 } }), 100, 100)).toBe(false);
    expect(coversScreen(cam('c', { m_ClearFlags: CLEAR_SOLID_COLOR }), 100, 100)).toBe(true);
  });
  it('viewport 夾在 0～1、換成像素', () => {
    expect(viewportPixels(cam('a', { m_NormalizedViewPortRect: { x: -0.5, y: 0.25, width: 1, height: 1 } }), 200, 100)).toEqual({ x: 0, y: 25, width: 100, height: 75 });
  });
  it('cullingMask：m_Bits 是無號 32 位元；沒有欄位是 Everything', () => {
    const c = cam('GameCamera', { m_CullingMask: { m_Bits: 14103 } });
    expect([0, 5, 10, 11, 13].map((l) => inCullingMask(cullingMask(c), l))).toEqual([true, false, true, false, true]);
    expect(inCullingMask(cullingMask(cam('x', {})), 31)).toBe(true);
  });
});

describe('cameraStack：投影與 view', () => {
  it('透視：攝影機前方 near 與 far 的點落在 NDC 的 z −1 與 1、上緣對到 y 1', () => {
    const c = cam('GameCamera', {}, { pos: new Vector3(0, 0, -10) });
    const VP = projectionOf(c, 16 / 9).multiply(viewOf(c));
    const ndc = (p: Vector3) => {
      const v = new Vector4(p.x, p.y, p.z, 1).applyMatrix4(VP);
      return [v.x / v.w, v.y / v.w, v.z / v.w];
    };
    expect(ndc(new Vector3(0, 0, -9.7))[2]).toBeCloseTo(-1, 6);
    expect(ndc(new Vector3(0, 0, 990))[2]).toBeCloseTo(1, 6);
    const d = 20;
    expect(ndc(new Vector3(0, d * Math.tan(Math.PI / 6), -10 + d))[1]).toBeCloseTo(1, 6);
    // Unity 的 +x 在畫面右邊（view 翻 z 之後仍是右手 x）
    expect(ndc(new Vector3(1, 0, 0))[0]).toBeGreaterThan(0);
  });
  it('Overlay：螢幕像素（原點左下）直接對到 NDC', () => {
    const VP = overlayProjection(200, 100).multiply(overlayView());
    const v = new Vector4(200, 0, 5, 1).applyMatrix4(VP);
    expect([v.x / v.w, v.y / v.w]).toEqual([1, -1]);
  });
});

describe('renderPipelineOf：品質等級的 customRenderPipeline，沒有再看 GraphicsSettings', () => {
  it('都沒有是 built-in；任何一個有是 srp', () => {
    const q = (pipelines: ({ guid: string } | null)[], cur = 0) => ({ QualitySettings: { QualitySettings: { m_CurrentQuality: cur, m_QualitySettings: pipelines.map((p) => ({ customRenderPipeline: p })) } } });
    expect(renderPipelineOf({ ...q([null]), GraphicsSettings: { GraphicsSettings: { m_CustomRenderPipeline: null } } })).toBe('builtin');
    expect(renderPipelineOf({ ...q([null, { guid: 'a' }], 1), GraphicsSettings: { GraphicsSettings: { m_CustomRenderPipeline: null } } })).toBe('srp');
    expect(renderPipelineOf({ ...q([null]), GraphicsSettings: { GraphicsSettings: { m_CustomRenderPipeline: { guid: 'b' } } } })).toBe('srp');
  });
});

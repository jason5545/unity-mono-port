// clip 空間 z 的慣例（2026/10/17）：MT2 戰前介紹的 Boss 整隻是淺藍色的剪影，其實是霧。原版的 shader 是 DX11 bytecode，
// 霧的距離 UNITY_Z_0_FAR_FROM_CLIPSPACE ＝ max((1 − z/near)·far, 0) 照 D3D 的反向深度寫死；以前給的是 three.js 的 GL 投影，
// 正交攝影機（near 0.3、far 1000）前 22 的角色算出約 4190，超過 battle_intro 的線性霧終點 3500，整隻變成霧色 (0.51, 0.74, 0.95)。
// 現在 shader 拿 D3D 的 GPU 投影矩陣，vertex shader 最後換回 GL（深度與以前相同）。
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { d3dProjection } from './sceneRenderer';
import { d3dClipToGl } from './unityShader';

const clip = (P: THREE.Matrix4, d: number) => new THREE.Vector4(0, 0, -d, 1).applyMatrix4(P); // 視線方向是 −z
const fogDistance = (zClip: number, near: number, far: number) => Math.max((1 - zClip / near) * far, 0);
const fogFactor = (dist: number, start: number, end: number) => Math.min(Math.max((end - dist) / (end - start), 0), 1);

describe('D3D 的 GPU 投影矩陣（反向深度）', () => {
  for (const [name, P] of [
    ['正交', new THREE.OrthographicCamera(-9.6, 9.6, 5.4, -5.4, 0.3, 1000).projectionMatrix],
    ['透視', new THREE.PerspectiveCamera(60, 16 / 9, 0.3, 1000).projectionMatrix],
  ] as const) {
    it(`${name}：near 的 z/w ＝ 1、far ＝ 0；x、y、w 不變；換回 GL（w − 2z）跟 three.js 的深度相同`, () => {
      const D = d3dProjection(P);
      for (const d of [0.3, 1, 22, 500, 1000]) {
        const g = clip(P, d);
        const k = clip(D, d);
        expect(k.x).toBeCloseTo(g.x, 9);
        expect(k.y).toBeCloseTo(g.y, 9);
        expect(k.w).toBeCloseTo(g.w, 9);
        expect(k.w - 2 * k.z).toBeCloseTo(g.z, 6);
      }
      expect(clip(D, 0.3).z / clip(D, 0.3).w).toBeCloseTo(1, 6);
      expect(clip(D, 1000).z / clip(D, 1000).w).toBeCloseTo(0, 6);
    });
  }

  it('戰前介紹（正交、near 0.3、far 1000、線性霧 100–3500）：前 22 的角色沒有霧；GL 的 z 會整隻變成霧色', () => {
    const P = new THREE.OrthographicCamera(-9.6, 9.6, 5.4, -5.4, 0.3, 1000).projectionMatrix;
    const d3d = fogDistance(clip(d3dProjection(P), 22).z, 0.3, 1000);
    const gl = fogDistance(clip(P, 22).z, 0.3, 1000);
    expect(fogFactor(d3d, 100, 3500)).toBe(1); // 1 ＝ 原本的顏色
    expect(gl).toBeGreaterThan(3500);
    expect(fogFactor(gl, 100, 3500)).toBe(0); // 0 ＝ 整個是霧色
  });
});

describe('vertex shader 最後把 clip z 換回 GL', () => {
  it('main 改名、包一層，結尾 z ＝ w − 2z', () => {
    const src = 'in vec4 POSITION;\nvoid main()\n{\n    gl_Position = POSITION;\n}\n';
    const out = d3dClipToGl(src);
    expect(out).toContain('void main_d3d()');
    expect(out).toMatch(/void main\(\)\n\{\n {4}main_d3d\(\);\n {4}gl_Position\.z = gl_Position\.w - 2\.0 \* gl_Position\.z;\n\}/);
    expect(d3dClipToGl('void other() {}')).toBe('void other() {}');
  });
});

import { describe, expect, it } from 'vitest';
import { videoQuadScale, videosForPass, type VideoLayer } from './sceneRenderer';
import type { ComponentData } from '../unity/types';

// 開場影片 intro_fmv（2026/10/17 Jason：新存檔走開場影片整段黑畫面）：VideoPlayerUnity 設 CameraFarPlane、targetCamera ＝ Camera.main，
// 那台攝影機是 Solid Color 清成黑。以前 built-in 管線在全部攝影機之前畫遠平面，目標攝影機清背景就蓋掉；
// 現在在 targetCamera 那一趟裡畫（遠平面在清完之後、近平面在場景之後），別台攝影機的那一趟不畫。
describe('VideoPlayer 畫在哪一台攝影機的那一趟', () => {
  const main = { type: 'Camera' } as unknown as ComponentData;
  const trail = { type: 'Camera' } as unknown as ComponentData;
  const el = {} as HTMLVideoElement;
  const far: VideoLayer = { el, nearPlane: false, camera: main, alpha: 1, aspectRatio: 1 };
  const near: VideoLayer = { el, nearPlane: true, camera: trail, alpha: 0.5, aspectRatio: 2 };
  it('遠平面只在 targetCamera 那一趟畫，近平面同理；別台攝影機不畫', () => {
    expect(videosForPass([far, near], false, main)).toEqual([far]);
    expect(videosForPass([far, near], true, main)).toEqual([]);
    expect(videosForPass([far, near], false, trail)).toEqual([]);
    expect(videosForPass([far, near], true, trail)).toEqual([near]);
  });
  it('沒有攝影機的管線（cam 是 null）：照遠近全部畫', () => {
    expect(videosForPass([far, near], false, null)).toEqual([far]);
    expect(videosForPass([far, near], true, null)).toEqual([near]);
  });
});

// 1920×1080 的影片畫在 2560×1440（同比例）與 1000×1000（比較窄）的畫面
describe('VideoPlayer 的 aspectRatio（攝影機平面的縮放，NDC）', () => {
  it('同比例：Fit 系列都填滿', () => {
    for (const mode of [1, 2, 3, 4, 5]) expect(videoQuadScale(mode, 1920, 1080, 2560, 1440)).toEqual([1, 1]);
    expect(videoQuadScale(0, 1920, 1080, 2560, 1440)).toEqual([0.75, 0.75]);
  });
  it('畫面比較窄：FitVertically 高度填滿、左右超出；FitHorizontally 寬度填滿、上下留黑；Inside／Outside 取小／大', () => {
    const [vx, vy] = videoQuadScale(1, 1920, 1080, 1000, 1000);
    expect(vy).toBe(1);
    expect(vx).toBeCloseTo(16 / 9, 6);
    const [hx, hy] = videoQuadScale(2, 1920, 1080, 1000, 1000);
    expect(hx).toBe(1);
    expect(hy).toBeCloseTo(9 / 16, 6);
    expect(videoQuadScale(3, 1920, 1080, 1000, 1000)).toEqual([hx, hy]);
    expect(videoQuadScale(4, 1920, 1080, 1000, 1000)).toEqual([vx, vy]);
    expect(videoQuadScale(5, 1920, 1080, 1000, 1000)).toEqual([1, 1]);
  });
});

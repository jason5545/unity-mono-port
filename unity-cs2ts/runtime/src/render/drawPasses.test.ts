// drawPasses（2026/10/17）：同一種 LightMode 的 pass 依序都畫。MT2 的 Shiny Shoe/CardEffects 有兩個沒標的 pass（第 1～5 層、第 6～9 層），
// 以前只畫第一個，縱火犯（Firestarter）的主圖在第 6 層，卡圖只剩背景。
import { describe, expect, it } from 'vitest';
import { drawPasses, type ShaderIndex, type ShaderPass } from './unityShader';

const pass = (index: number, name: string, lightMode?: string, type = 0): ShaderPass =>
  ({ index, name, type, tags: lightMode === undefined ? {} : { LIGHTMODE: lightMode }, state: {} as ShaderPass['state'], stages: {} }) as unknown as ShaderPass;
const shader = (passes: ShaderPass[]): ShaderIndex => ({ name: 't', stem: 't', properties: [], subShaders: [{ index: 0, tags: {}, passes }] });

describe('drawPasses', () => {
  it('CardEffects：兩個沒標 LightMode 的 pass 都畫，照順序', () => {
    const idx = shader([pass(0, 'PASS_1'), pass(1, 'PASS_2')]);
    expect(drawPasses(idx, 'builtin').map((p) => p.name)).toEqual(['PASS_1', 'PASS_2']);
  });

  it('Spine/Skeleton：Normal 加 ShadowCaster，只畫 Normal', () => {
    const idx = shader([pass(0, 'Normal'), pass(1, 'Caster', 'SHADOWCASTER')]);
    expect(drawPasses(idx, 'builtin').map((p) => p.name)).toEqual(['Normal']);
  });

  it('built-in 的 ForwardBase 加 ForwardAdd、Deferred：只畫 ForwardBase（ForwardAdd 是逐光源，另外的事）', () => {
    const idx = shader([pass(0, 'FORWARD', 'FORWARDBASE'), pass(1, 'FORWARD_DELTA', 'FORWARDADD'), pass(2, 'DEFERRED', 'DEFERRED')]);
    expect(drawPasses(idx, 'builtin').map((p) => p.name)).toEqual(['FORWARD']);
  });

  it('沒標與 Always 算同一種；GrabPass 不算；挑中的 pass 之前的不重畫', () => {
    const idx = shader([pass(0, 'Caster', 'SHADOWCASTER'), pass(1, 'A'), pass(2, 'Grab', '', 2), pass(3, 'B', 'Always')]);
    expect(drawPasses(idx, 'builtin').map((p) => p.name)).toEqual(['A', 'B']);
  });
});

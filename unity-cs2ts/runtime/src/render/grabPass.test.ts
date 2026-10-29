// GrabPass（2026/10/17）：built-in 挑可畫的 pass 時跳過 GrabPass；程式記住排在前面的 GrabPass 抓進哪張貼圖
import { describe, expect, it } from 'vitest';
import { choosePass, grabBefore, type ShaderIndex, type ShaderPass } from './unityShader';

const stage = { variants: [] } as unknown as NonNullable<ShaderPass['stages']['vertex']>;
const pass = (index: number, type: number, textureName: string, tags: Record<string, string> = {}): ShaderPass =>
  ({ index, name: '', type, textureName, tags, state: {}, stages: type === 2 ? {} : { vertex: stage, fragment: stage } }) as unknown as ShaderPass;
const shader = (passes: ShaderPass[]): ShaderIndex => ({ name: 's', stem: 's', properties: [], subShaders: [{ index: 0, tags: {}, passes }] });

describe('GrabPass', () => {
  it('Particles/Standard Unlit 的排法（Grab、ShadowCaster、沒有 LightMode 的一般 pass）：挑到一般 pass，不是 GrabPass', () => {
    const s = shader([pass(0, 2, '_GrabTexture'), pass(1, 0, '', { LIGHTMODE: 'SHADOWCASTER' }), pass(2, 0, '')]);
    const p = choosePass(s, 'builtin');
    expect(p?.index).toBe(2);
    expect(grabBefore(s, p!)).toEqual({ texture: '_GrabTexture', perObject: false });
  });
  it('沒取名的 GrabPass：抓進 _GrabTexture、每個物件各抓一次；沒有 GrabPass 的是 null', () => {
    const s = shader([pass(0, 2, ''), pass(1, 0, '', { LIGHTMODE: 'FORWARDBASE' })]);
    const p = choosePass(s, 'builtin')!;
    expect(p.index).toBe(1);
    expect(grabBefore(s, p)).toEqual({ texture: '_GrabTexture', perObject: true });
    const plain = shader([pass(0, 0, '', { LIGHTMODE: 'FORWARDBASE' })]);
    expect(grabBefore(plain, plain.subShaders[0].passes[0])).toBeNull();
  });
});

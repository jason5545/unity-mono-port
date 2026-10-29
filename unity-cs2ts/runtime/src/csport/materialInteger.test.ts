// Material.SetInteger／GetInteger（整數屬性，序列化的 m_Ints）與 SetInt（SetFloat 的別名）
import { describe, expect, it } from 'vitest';
import { staticCtx } from './core';
import {
  Material_CopyPropertiesFromMaterial,
  Material_GetFloat$string,
  Material_GetInteger$string,
  Material_HasProperty$string,
  Material_SetInt$string_int,
  Material_SetInteger$string_int,
  new_Material$Shader,
} from './unityNative';
import './unity';

const c = staticCtx;

describe('Material.SetInteger', () => {
  it('寫進 m_Ints（CharacterDialogueScreen 的 SetInteger("_BlurEnable", 1)），不動 m_Floats；複製材質時一起帶過去', () => {
    const m = new_Material$Shader(c, { name: 'UI/Default' });
    Material_SetInteger$string_int(c, m, '_BlurEnable', 1);
    expect(Material_GetInteger$string(c, m, '_BlurEnable')).toBe(1);
    expect(m.$record.m_SavedProperties.m_Ints).toEqual({ _BlurEnable: 1 });
    expect('_BlurEnable' in m.$record.m_SavedProperties.m_Floats).toBe(false);
    expect(Material_HasProperty$string(c, m, '_BlurEnable')).toBe(true);
    const copy = new_Material$Shader(c, { name: 'UI/Default' });
    Material_CopyPropertiesFromMaterial(c, copy, m);
    expect(Material_GetInteger$string(c, copy, '_BlurEnable')).toBe(1);
  });

  it('SetInt 照手冊是 SetFloat 的別名，寫 m_Floats', () => {
    const m = new_Material$Shader(c, { name: 'UI/Default' });
    Material_SetInt$string_int(c, m, '_Stencil', 3);
    expect(Material_GetFloat$string(c, m, '_Stencil')).toBe(3);
    expect(Material_GetInteger$string(c, m, '_Stencil')).toBe(0);
  });
});

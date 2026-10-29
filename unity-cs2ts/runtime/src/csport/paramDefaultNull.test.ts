import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// 轉換器的輸出（mt2-web 的 npm run port 產生，gen 不進版控；檔案不在時測試會失敗，同 componentFieldDefault.test.ts）
const gen = (name: string) => readFileSync(new URL(`../../../../mt2-web/src/csport/gen/${name}.ts`, import.meta.url), 'utf8');

describe('轉換器：呼叫端補上的參數預設值', () => {
  it('集合參數預設 null 照傳 null（RemoveDeadCharacters(List overrideList = null)：補成 [] 時戰鬥中死掉的角色不會移除，打完 Boss 不出結算）', () => {
    const src = gen('CombatManager');
    expect(src).toContain('RemoveDeadCharacters(c, null, false, false)');
    expect(src).not.toContain('RemoveDeadCharacters(c, [], ');
  });
});

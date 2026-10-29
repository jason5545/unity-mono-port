import { describe, expect, it } from 'vitest';
// 轉換器的輸出（mt2-web 的 npm run port 產生，gen 不進版控；檔案不在時測試會因為找不到模組失敗，跟 testData.ts 讀 diceomancer-web 的資料一樣）
import { ClassSelectCharacterDisplay } from '../../../../mt2-web/src/csport/gen/ClassSelectCharacterDisplay';
import { CharacterUIMeshSpine } from '../../../../mt2-web/src/csport/gen/CharacterUIMeshSpine';
import type { Ctx } from './core';

// 存檔裡沒有任何欄位的元件（場景、prefab 匯出的 JSON 只有 Unity 序列化的欄位）
const blank = { ed: {} } as unknown as Ctx;

describe('轉換器：元件欄位沒有存檔值時的預設', () => {
  it('Unity 不序列化、沒有初值的 List 是 C# 的預設 null（ClassSelectCharacterDisplay.Show 靠 characters == null 才叫 PlayIdleWithoutSetup）', () => {
    expect(ClassSelectCharacterDisplay.initAi(blank).characters).toBeNull();
    expect(CharacterUIMeshSpine.initAi(blank)._boneFollowers).toBeNull();
  });

  it('Unity 序列化的 List（[SerializeField]）照舊是空清單', () => {
    expect(CharacterUIMeshSpine.initAi(blank).modelVariations).toEqual([]);
  });
});

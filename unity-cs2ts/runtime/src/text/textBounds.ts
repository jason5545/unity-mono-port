// GetTextBounds（TMP_Text.cs:4794）：rendered 寬高（看得見的字元的 origin..xAdvance、descender..ascender 範圍）。

import { k_LargeNegativeFloat, k_LargePositiveFloat } from './utils';
import type { TmpCharacterInfo } from './textInfo';

/** TMP_Text.GetTextBounds()（TMP_Text.cs:4794）：回傳 size（寬高） */
export function computeRenderedValues(characterInfo: TmpCharacterInfo[], characterCount: number): { x: number; y: number } {
  if (characterCount > characterInfo.length) return { x: 0, y: 0 };

  let minX = k_LargePositiveFloat;
  let minY = k_LargePositiveFloat;
  let maxX = k_LargeNegativeFloat;
  let maxY = k_LargeNegativeFloat;

  for (let i = 0; i < characterCount && i < characterInfo.length; i++) {
    if (!characterInfo[i].isVisible) continue;

    minX = Math.min(minX, characterInfo[i].origin);
    minY = Math.min(minY, characterInfo[i].descender);

    maxX = Math.max(maxX, characterInfo[i].xAdvance);
    maxY = Math.max(maxY, characterInfo[i].ascender);
  }

  return { x: maxX - minX, y: maxY - minY };
}

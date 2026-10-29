import { describe, expect, it } from 'vitest';
import { newGen, registerGen, staticCtx, typeNames, type GenClassImpl } from './core';
import { JsonUtility_FromJson$string, JsonUtility_FromJsonOverwrite, JsonUtility_ToJson$Object } from './unityScene';

// 跟 MT2 的 RelicRewardData／CollectableRelicData 同一個形狀：兩個都是 ScriptableObject（基底在 DLL），獎勵的欄位指向遺物
const so = { overrides: {}, delegates: {}, methods: {}, dllBases: ['ScriptableObject', 'Object'] };
const Relic: GenClassImpl = { ...so, name: 'TestRelic', file: 'TestRelic.cs', initAi: () => ({ nameKey: '' }), serialized: ['nameKey'] };
const Reward: GenClassImpl = {
  ...so,
  name: 'TestReward',
  file: 'TestReward.cs',
  initAi: () => ({ _relic: null, _relicId: '', _icon: null }),
  serialized: ['_relic', '_relicId', '_icon'],
};
registerGen({ TestRelic: Relic, TestReward: Reward });

describe('JsonUtility：欄位裡的 UnityEngine.Object 寫成 instanceID', () => {
  it('dllBases 讓 typeNames 認得 DLL 裡的基底', () => {
    expect(typeNames(null, 'TestReward').has('ScriptableObject')).toBe(true);
    expect(typeNames(null, 'TestReward').has('Object')).toBe(true);
  });

  it('巢狀的 ScriptableObject 與資產參照只寫 instanceID，讀回是同一個物件', () => {
    const relic = newGen(staticCtx, 'TestRelic', null) as Record<string, unknown>;
    relic.nameKey = 'Relic_name';
    const reward = newGen(staticCtx, 'TestReward', null) as Record<string, unknown>;
    reward._relic = relic;
    reward._relicId = 'r1';
    reward._icon = { guid: 'd63a6db400d58e24c903326b6043ed43', fileID: '21300000' };
    const json = JsonUtility_ToJson$Object(staticCtx, reward);
    const plain = JSON.parse(json);
    expect(Object.keys(plain._relic)).toEqual(['instanceID']);
    expect(Object.keys(plain._icon)).toEqual(['instanceID']);
    expect(plain._relicId).toBe('r1');
    // 最外層照樣寫欄位
    expect(JSON.parse(JsonUtility_ToJson$Object(staticCtx, relic))).toEqual({ nameKey: 'Relic_name' });

    const back = JsonUtility_FromJson$string(staticCtx, json, 'TestReward') as Record<string, unknown>;
    expect(back._relic).toBe(relic);
    expect(back._icon).toEqual({ guid: 'd63a6db400d58e24c903326b6043ed43', fileID: '21300000' });
  });

  it('找不到的 instanceID 讀回是 null', () => {
    const reward = newGen(staticCtx, 'TestReward', null) as Record<string, unknown>;
    JsonUtility_FromJsonOverwrite(staticCtx, '{"_relic":{"instanceID":987654321},"_icon":{"instanceID":0}}', reward);
    expect(reward._relic).toBeNull();
    expect(reward._icon).toBeNull();
  });
});

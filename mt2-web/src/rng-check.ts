// 亂數情境的 TS 版：跟 tools/ref/Scenario.cs 一模一樣的操作，跑轉換器產生的 HadesRNG、RandomState、RandomManager、MurmurHash2。
// 每一步記一筆（鍵、值），跟 public/ref/rng-*.json（原版 C# 跑出來的）逐筆比。
import * as R from './csport/runtime';

const RNG_IDS = [
  'Master', 'NonDeterministic', 'SetupRun', 'Spawning', 'Chatter', 'CardDraw', 'Battle', 'BossActions',
  'Merchant', 'StoryEvents', 'Rewards', 'Trials', 'BossGeneration', 'BattleTest', 'AutoselectTrainPath', 'HellforgedShardEnemy',
] as const;
const RngId = Object.fromEntries(RNG_IDS.map((n, i) => [n, i])) as Record<(typeof RNG_IDS)[number], number>;

const INT_MAX = 2147483647;
const INT_MIN = -2147483648;

interface State { s0: number; s1: number; s2: number; s3: number }
const fmtState = (s: State) => `{"s0":${s.s0 | 0},"s1":${s.s1 | 0},"s2":${s.s2 | 0},"s3":${s.s3 | 0}}`;
const floatBits = (v: number) => 'f' + new Int32Array(new Float32Array([v]).buffer)[0];

export function runScenario(): [string, string][] {
  const rows: [string, string][] = [];
  const put = (k: string, v: string) => rows.push([k, v]);
  const putI = (k: string, v: number) => put(k, String(v));
  const putF = (k: string, v: number) => put(k, floatBits(v));
  const putState = (k: string, s: State) => put(k, fmtState(s));

  const hades = (o: object, m: string, ...a: unknown[]) => R.genCall(null, 'HadesRNG', o, m, ...a);
  const st = (cls: string, m: string, ...a: unknown[]) => R.genStaticCall(cls, m, ...a);

  for (const s of ['', 'a', 'ab', 'abc', 'abcd', 'abcde', 'merchant', 'CardData_Torchmerchant', '測試中文', 'The quick brown fox jumps over the lazy dog']) {
    putI(`murmur.Hash[${s}]`, st('MurmurHash2', 'Hash$string', s));
    putI(`murmur.GetMurmurHash[${s}]`, st('RandomManager', 'GetMurmurHash', s));
  }

  for (const seed of [0, 1, 42, 123456789, -1, INT_MAX, INT_MIN]) {
    const rng = R.newGen(R.staticCtx, 'HadesRNG', 'ctor$int', seed);
    putState(`hades[${seed}].state0`, hades(rng, 'GetState'));
    for (let i = 0; i < 8; i++) putI(`hades[${seed}].int100[${i}]`, hades(rng, 'Range$int_int', 0, 100));
    for (let i = 0; i < 3; i++) putI(`hades[${seed}].intNeg[${i}]`, hades(rng, 'Range$int_int', -50, 50));
    putI(`hades[${seed}].intDown`, hades(rng, 'Range$int_int', 10, 3));
    putI(`hades[${seed}].intSame`, hades(rng, 'Range$int_int', 7, 7));
    putI(`hades[${seed}].intBig`, hades(rng, 'Range$int_int', 0, INT_MAX));
    for (let i = 0; i < 4; i++) putF(`hades[${seed}].f01[${i}]`, hades(rng, 'Range$float_float', 0, 1));
    for (let i = 0; i < 3; i++) putF(`hades[${seed}].fMix[${i}]`, hades(rng, 'Range$float_float', -2.5, 7.25));
    putState(`hades[${seed}].state1`, hades(rng, 'GetState'));
    hades(rng, 'Reset', 3);
    for (let i = 0; i < 3; i++) putI(`hades[${seed}].afterReset[${i}]`, hades(rng, 'Range$int_int', 0, 1000));
    const copy = R.newGen(R.staticCtx, 'HadesRNG', 'ctor$HadesRNG', rng);
    putI(`hades[${seed}].copy`, hades(copy, 'Range$int_int', 0, 1000));
    putI(`hades[${seed}].orig`, hades(rng, 'Range$int_int', 0, 1000));
  }

  // RandomManager 的靜態建構子在 registerGen 時已經 Init(new RandomState(0), null) 過一次
  const rs = R.newGen(R.staticCtx, 'RandomState', 'ctor$int', 777);
  putI('manager.Init', st('RandomManager', 'Init', rs, null) ? 1 : 0);
  for (const id of RNG_IDS) {
    const state = R.genCall(null, 'RandomState', rs, 'FindState', RngId[id]);
    putI(`manager.seed[${id}]`, state == null ? -999 : R.genCall(null, 'HadesRNG', state.rng, 'GetSeed'));
  }
  for (const id of RNG_IDS) putI(`manager.range[${id}]`, st('RandomManager', 'Range$int_int_RngId', 0, 1000000, RngId[id]));
  st('RandomManager', 'AdvanceToNextNode');
  for (const id of RNG_IDS) putI(`manager.afterAdvance[${id}]`, st('RandomManager', 'Range$int_int_RngId', 0, 1000000, RngId[id]));
  st('RandomManager', 'ResetRng', RngId.Rewards, 2);
  putI('manager.afterReset[Rewards]', st('RandomManager', 'Range$int_int_RngId', 0, 100, RngId.Rewards));
  st('RandomManager', 'ResetRng', RngId.Battle, 2);
  putI('manager.notResetable[Battle]', st('RandomManager', 'Range$int_int_RngId', 0, 100, RngId.Battle));
  putF('manager.float[CardDraw]', st('RandomManager', 'Range$float_float_RngId', 0, 10, RngId.CardDraw));
  putState('manager.state[Spawning]', st('RandomManager', 'GetState', RngId.Spawning));
  return rows;
}

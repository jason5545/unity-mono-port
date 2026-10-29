// Time.timeScale（2026/10/16，MT2 的續關：ContinueRun 把 timeScale 設成 100，照 unscaledTime 等 5 秒）
import { describe, expect, it } from 'vitest';
import { World } from './world';
import { SceneGraph } from '../unity/scene';
import type { SceneFile } from '../unity/types';
import { staticCtx, type Ctx } from '../csport/core';
import {
  MonoBehaviour_StartCoroutine$IEnumerator,
  new_WaitForSeconds,
  Time_get_deltaTime,
  Time_get_time,
  Time_get_timeScale,
  Time_get_unscaledDeltaTime,
  Time_get_unscaledTime,
  Time_set_timeScale,
} from '../csport/unity';

function world(): World {
  const file: SceneFile = { guid: 'g', name: 's', src: 's.unity', settings: {}, roots: [], gameObjects: {}, components: {} };
  return new World(new SceneGraph(file), {
    localization: undefined as never,
    version: 'test',
    controllers: {},
    clips: {},
    registry: {},
    layout: {},
    sortingLayerIndex: () => 0,
  });
}

describe('Time.timeScale', () => {
  it('Time.time／deltaTime 乘 timeScale，unscaledTime／unscaledDeltaTime 不乘；0 的時候 Time.time 不走', () => {
    const w = world();
    const c: Ctx = { ...staticCtx, w };
    expect(Time_get_timeScale(c)).toBe(1);
    Time_set_timeScale(c, 100);
    w.tick(0.02);
    expect(Time_get_deltaTime(c)).toBeCloseTo(2);
    expect(Time_get_time(c)).toBeCloseTo(2);
    expect(Time_get_unscaledDeltaTime(c)).toBeCloseTo(0.02);
    expect(Time_get_unscaledTime(c)).toBeCloseTo(0.02);
    Time_set_timeScale(c, 0);
    w.tick(0.02);
    expect(Time_get_deltaTime(c)).toBe(0);
    expect(Time_get_time(c)).toBeCloseTo(2);
    expect(Time_get_unscaledTime(c)).toBeCloseTo(0.04);
  });

  it('WaitForSeconds 照乘過 timeScale 的時間等', () => {
    const w = world();
    const c: Ctx = { ...staticCtx, w };
    const log: string[] = [];
    function* co() {
      log.push('開始');
      yield new_WaitForSeconds(c, 0.5);
      log.push('等完');
    }
    MonoBehaviour_StartCoroutine$IEnumerator(c, null, co());
    Time_set_timeScale(c, 100);
    w.tick(1 / 60); // 協程剛開始的那一格不推進
    w.tick(1 / 60); // 1.67 秒（乘過 timeScale）> 0.5 秒
    expect(log).toEqual(['開始', '等完']);
  });
});

describe('MonoBehaviour.StartCoroutine 的回傳值', () => {
  it('沒碰到 yield 就跑完回 null（Unity 文件），有 yield 回協程', () => {
    const w = world();
    const c: Ctx = { ...staticCtx, w };
    function* done() {
      // 沒有 yield
    }
    function* waits() {
      yield null;
    }
    expect(MonoBehaviour_StartCoroutine$IEnumerator(c, null, done())).toBe(null);
    expect(MonoBehaviour_StartCoroutine$IEnumerator(c, null, waits())).not.toBe(null);
  });
});

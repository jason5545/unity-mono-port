// Graphic 的顏色漸變：照反編譯的 UnityEngine.UI.CoroutineTween（TweenRunner.cs、ColorTween.cs）。
// Unity 的 coroutine 用 World 的 coroutine 清單模擬：StartTween 當下先跑到第一個 yield（用這一幀的
// Time.deltaTime），之後每幀在 World.tick 裡恢復（step）。

import type { World } from '../engine/world';
import type { SceneNode } from '../unity/scene';
import type { ColorRGBA, ComponentData } from '../unity/types';

export type ColorTweenMode = 'All' | 'RGB' | 'Alpha';

export interface ColorTweenInfo {
  start: ColorRGBA;
  target: ColorRGBA;
  mode: ColorTweenMode;
  duration: number;
  /** ColorTween.ignoreTimeScale：TweenRunner.cs:18 照它選 Time.unscaledDeltaTime 或 Time.deltaTime（Selectable、Toggle 都傳 true） */
  ignoreTimeScale: boolean;
}

/** ColorTween.TweenValue：Color.Lerp（t 夾在 [0,1]），mode 决定哪些分量保留 start 的值 */
export function tweenValue(start: ColorRGBA, target: ColorRGBA, mode: ColorTweenMode, t: number): ColorRGBA {
  const p = Math.min(Math.max(t, 0), 1);
  const out: ColorRGBA = {
    r: start.r + (target.r - start.r) * p,
    g: start.g + (target.g - start.g) * p,
    b: start.b + (target.b - start.b) * p,
    a: start.a + (target.a - start.a) * p,
  };
  if (mode === 'Alpha') {
    out.r = start.r;
    out.g = start.g;
    out.b = start.b;
  } else if (mode === 'RGB') {
    out.a = start.a;
  }
  return out;
}

/** TweenRunner<ColorTween>：一個 Graphic 一支，跑在 world.coroutines 裡 */
export class ColorTweenRunner {
  private tween: (ColorTweenInfo & { elapsed: number }) | null = null;
  private apply: ((c: ColorRGBA) => void) | null = null;

  constructor(
    private readonly world: World,
    private readonly graphicNode: SceneNode,
  ) {}

  /** TweenRunner.StartTween ＋ coroutine Start 到第一個 yield 之前：先用當前一幀的 deltaTime 套一次 */
  startTween(info: ColorTweenInfo, apply: (c: ColorRGBA) => void): void {
    this.stopTween();
    const { start, target, mode, duration, ignoreTimeScale } = info;
    if (!this.graphicNode.activeInHierarchy) {
      apply(tweenValue(start, target, mode, 1));
      return;
    }
    if (!(0 < duration)) {
      apply(tweenValue(start, target, mode, 1));
      return;
    }
    const elapsed = ignoreTimeScale ? this.world.unscaledDeltaTime : this.world.deltaTime;
    this.tween = { start, target, mode, duration, ignoreTimeScale, elapsed };
    this.apply = apply;
    apply(tweenValue(start, target, mode, elapsed / duration));
    this.world.coroutines.add(this);
  }

  /** coroutine 每幀恢復：回 false 表示結束（世界會把它從 coroutines 移除） */
  step(dt: number): boolean {
    const t = this.tween;
    if (!t || !this.apply) return false;
    if (!this.graphicNode.activeInHierarchy) {
      this.tween = null;
      this.apply = null;
      return false;
    }
    if (t.elapsed < t.duration) {
      t.elapsed += t.ignoreTimeScale ? this.world.unscaledDeltaTime : dt;
      this.apply(tweenValue(t.start, t.target, t.mode, t.elapsed / t.duration));
      return true;
    }
    this.apply(tweenValue(t.start, t.target, t.mode, 1));
    this.tween = null;
    this.apply = null;
    return false;
  }

  stopTween(): void {
    this.tween = null;
    this.apply = null;
    this.world.coroutines.delete(this);
  }
}

// Graphic.m_ColorTweenRunner：每個 Graphic 元件一支
const runners = new WeakMap<ComponentData, ColorTweenRunner>();

export function colorTweenRunnerOf(world: World, graphicComp: ComponentData, graphicNode: SceneNode): ColorTweenRunner {
  let r = runners.get(graphicComp);
  if (!r) {
    r = new ColorTweenRunner(world, graphicNode);
    runners.set(graphicComp, r);
  }
  return r;
}

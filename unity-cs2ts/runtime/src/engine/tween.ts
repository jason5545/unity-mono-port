// DOTween 的子集（遊戲用到的才做）。行為照 DOTween（reference/decompiled/DOTween/，見各函式的行號）：
// - 預設緩動 OutQuad（DOTweenSettings.defaultEaseType 6＝DG.Tweening/Ease.cs 的 OutQuad 列舉值）。
// - 起始值在第一次更新（或第一次被 Sequence 帶到）時才抓（lazy startup）：「先設 localScale＝0.6 再 DOScale(1)」是從 0.6 開始。
// - DOKill(complete: true)：先跳到終點、觸發 OnComplete，再刪；DOKill() 直接刪。
// - 同一個目標上的多個補間各自跑，照建立順序更新（後建的覆蓋前面的）。
// - Sequence：插入時間照 Sequence.cs（DoInsert 42-72、DoAppendInterval 74-79、DoInsertCallback 95-106；
//   Join 插在 lastTweenInsertTime）。Sequence 自己的 ease 預設 Linear（Setup :158），時間先經過它映射（DoApplyTween :209-213）。
// - DOShakePosition：照 DOTween.cs:439-530 的段數、段長與位移公式；亂數改用固定種子（原版是 UnityEngine.Random，序列不同，寫進差異）。
//   段間插值照 Vector3ArrayPlugin.cs:100-135（每段一個緩動，預設 OutQuad）。
// - SetDelay（TweenSettingsExtensions.cs:702-718）：Sequence 是 PrependInterval（Sequence.DoPrependInterval :81-93），
//   其他補間是 delay（DelayClock；10/13 快速骰果用到）。
// 刻意不做：loops、yoyo、SpeedBased、SetRelative、DOPath，以及遊戲沒用到的 Ease（只留標準答案與遊戲用到的）。

export type Ease = (t: number) => number;

/** DG.Tweening.Ease 的列舉值（reference/decompiled/DOTween/DG.Tweening/Ease.cs，Unset＝0 起算） */
export const EaseNum = {
  Linear: 1,
  OutSine: 3,
  InOutSine: 4,
  InQuad: 5,
  OutQuad: 6,
  OutCubic: 9,
  InOutCubic: 10,
  InQuart: 11,
  OutQuart: 12,
  InOutQuart: 13,
  InQuint: 14,
  OutQuint: 15,
  InOutQuint: 16,
  OutExpo: 18,
  InBack: 26,
  OutBack: 27,
  OutBounce: 30,
  InOutBounce: 31,
} as const;

/** Bounce.EaseOut（reference/decompiled/DOTween/DG.Tweening.Core.Easing/Bounce.cs:10-25；t 已經是 time／duration） */
function bounceOut(t: number): number {
  if (t < 372 / 1023) return 7.5625 * t * t;
  if (t < 744 / 1023) {
    const u = t - 558 / 1023;
    return 7.5625 * u * u + 0.75;
  }
  if (t < 930 / 1023) {
    const u = t - 837 / 1023;
    return 7.5625 * u * u + 0.9375;
  }
  const u = t - 21 / 22;
  return 7.5625 * u * u + 63 / 64;
}

/** DOTweenSettings 的 overshoot（InBack／OutBack 的預設，DOTween.defaultEaseOvershootOrAmplitude） */
export const DEFAULT_OVERSHOOT = 1.70158;

/** EaseManager.cs 的公式（t 已經是 time／duration） */
export const EASES: Record<number, Ease> = {
  [EaseNum.Linear]: (t) => t, // EaseManager.cs:20-21
  [EaseNum.OutSine]: (t) => Math.sin(t * (Math.PI / 2)), // :24-25（釣魚的進度條，10/12）
  [EaseNum.InOutSine]: (t) => -0.5 * (Math.cos(Math.PI * t) - 1), // :26-27
  [EaseNum.InQuad]: (t) => t * t, // :28-29（Yoyo 第二圈倒放 OutQuad 等於 InQuad，10/12）
  [EaseNum.OutQuad]: (t) => -t * (t - 2), // :30-31
  // 以下三個（OutCubic、InOutCubic、InOutQuart）對過 DOTween 反編譯的 EaseManager.cs:231-235（Claude Code 10/10）
  [EaseNum.OutCubic]: (t) => {
    const u = t - 1; // EaseManager.cs:231-235
    return u * u * u + 1;
  },
  [EaseNum.InOutCubic]: (t) => (t < 0.5 ? 4 * t * t * t : (t - 1) * (2 * t - 2) * (2 * t - 2) + 1), // EaseManager.cs:231-235
  [EaseNum.InQuart]: (t) => t * t * t * t, // :48-49
  [EaseNum.OutQuart]: (t) => {
    const u = t - 1; // :50-51
    return -(u * u * u * u - 1);
  },
  [EaseNum.InOutQuart]: (t) => {
    if (t < 0.5) return 8 * t * t * t * t; // EaseManager.cs:231-235
    const u = t - 1;
    return 1 - 8 * u * u * u * u;
  },
  [EaseNum.InQuint]: (t) => t * t * t * t * t, // :58-59
  [EaseNum.OutQuint]: (t) => {
    const u = t - 1; // :60-61
    return u * u * u * u * u + 1;
  },
  [EaseNum.InOutQuint]: (t) => {
    // EaseManager.cs:62-67（小地圖的紫霧預測放大，MinimapManager.HighLightMiniMapTween）
    const u = t * 2;
    if (u < 1) return 0.5 * u * u * u * u * u;
    const v = u - 2;
    return 0.5 * (v * v * v * v * v + 2);
  },
  // EaseManager.cs:74-79（能力圖示在畫面上半部生成時從上面掉下來，AbilityBase.GenerateAnimation，10/13）：time == duration 才回 1
  [EaseNum.OutExpo]: (t) => (t === 1 ? 1 : -Math.pow(2, -10 * t) + 1),
  [EaseNum.InBack]: (t) => t * t * ((DEFAULT_OVERSHOOT + 1) * t - DEFAULT_OVERSHOOT), // :186-187
  [EaseNum.OutBack]: (t) => {
    const u = t - 1; // :188-189
    return u * u * ((DEFAULT_OVERSHOOT + 1) * u + DEFAULT_OVERSHOOT) + 1;
  },
  // Bounce.EaseInOut（Bounce.cs:27-34）：前半是 EaseIn（＝1 − EaseOut(1 − t)）的一半，後半是 EaseOut 的一半加 0.5（法力球的入場，Mana.Start）
  // Bounce.EaseOut（EaseManager.cs:198-199；敵人出招時意圖放大與收回，EnemyIntentionBase.IntentionFeedBackIntoResolve／LeaveResolve，10/13）
  [EaseNum.OutBounce]: (t) => bounceOut(t),
  [EaseNum.InOutBounce]: (t) => (t < 0.5 ? (1 - bounceOut(1 - t * 2)) * 0.5 : bounceOut(t * 2 - 1) * 0.5 + 0.5),
};

/** 專案預設緩動（DOTweenSettings.defaultEaseType＝6） */
export const DEFAULT_EASE = EaseNum.OutQuad;

/** 所有 tween 的共同介面（Tweens 容器與 Sequence 用） */
export interface Animatable {
  /** DOKill 用的目標（DOTween 的 SetTarget）；Sequence 用自己當目標 */
  readonly target: object;
  /** 這個補間自己的長度（秒） */
  readonly duration: number;
  killed: boolean;
  /** 推進時間；結束時回傳 true */
  update(dt: number): boolean;
  /** 跳到終點並觸發 OnComplete（DOTween 的 Complete） */
  complete(): void;
  /** Sequence 帶動用：跳到自己長度的 progress（0..1）那一點（不觸發完成） */
  seek(progress: number): void;
}

/**
 * SetDelay 的延遲（Tweener.DoUpdateDelay，Tweener.cs:62-73；TweenManager.Update :535-551）：延遲走完之前不 startup、不寫值，
 * 走完的那一格把超出的時間（elapsed − delay）交給補間；剛好等於 delay 的那一格還不動。只管獨立的補間，被 Sequence 帶動（seek）時不看。
 */
export class DelayClock {
  private delay = 0;
  private elapsed = 0;
  private done = true;
  set(delay: number): void {
    this.delay = delay;
    this.elapsed = 0;
    this.done = delay <= 0;
  }
  /** 這一格要交給補間的時間；還在延遲回 null */
  step(dt: number): number | null {
    if (this.done) return dt;
    const e = this.elapsed + dt;
    if (e > this.delay) {
      this.elapsed = this.delay;
      this.done = true;
      return e - this.delay;
    }
    this.elapsed = e;
    return null;
  }
}

type Lerpable = number | Record<string, number>;

function lerp(a: Lerpable, b: Lerpable, t: number): Lerpable {
  if (typeof a === 'number') return a + ((b as number) - a) * t;
  const out: Record<string, number> = {};
  for (const k of Object.keys(b as Record<string, number>)) out[k] = (a as Record<string, number>)[k] + ((b as Record<string, number>)[k] - (a as Record<string, number>)[k]) * t;
  return out;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** DOTween.To 的對應：getter／setter 讀寫目標的一個屬性（number 或 {x,y,z,…} 物件） */
export class Tween implements Animatable {
  private start: Lerpable | null = null;
  private elapsed = 0;
  killed = false;
  private completeCallbacks: (() => void)[] = [];
  ease: Ease = EASES[DEFAULT_EASE];
  readonly delayClock = new DelayClock();

  constructor(
    readonly target: object,
    private readonly getter: () => Lerpable,
    private readonly setter: (v: Lerpable) => void,
    private readonly end: Lerpable,
    readonly duration: number,
  ) {}

  /** SetEase（Tween.SetEase；只收這份表裡的緩動） */
  setEase(e: Ease): this {
    this.ease = e;
    return this;
  }

  onComplete(fn: () => void): this {
    this.completeCallbacks.push(fn);
    return this;
  }

  /** SetDelay（非 Sequence）：延後 startup */
  setDelay(delay: number): this {
    this.delayClock.set(delay);
    return this;
  }

  /** 推進時間；結束時回傳 true */
  update(rawDt: number): boolean {
    if (this.killed) return true;
    const dt = this.delayClock.step(rawDt);
    if (dt === null) return false;
    if (this.start === null) this.start = structuredClone(this.getter());
    this.elapsed += dt;
    const t = this.duration > 0 ? Math.min(1, this.elapsed / this.duration) : 1;
    this.setter(lerp(this.start, this.end, this.ease(t)));
    if (t >= 1) {
      this.finish();
      return true;
    }
    return false;
  }

  seek(progress: number): void {
    if (this.killed) return;
    if (this.start === null) this.start = structuredClone(this.getter());
    this.setter(lerp(this.start, this.end, this.ease(clamp01(progress))));
  }

  /** 跳到終點並觸發 OnComplete */
  complete(): void {
    if (this.killed) return;
    this.setter(structuredClone(this.end));
    this.finish();
  }

  private finish() {
    this.killed = true;
    for (const f of this.completeCallbacks) f();
  }
}

/** Sequence 裡的一格：補間或回呼 */
interface SequenceItem {
  start: number;
  length: number;
  anim?: Animatable;
  callback?: () => void;
  fired: boolean;
}

/** DOTween.Sequence()（Sequence.cs）。Append／Join／AppendInterval／AppendCallback／OnComplete／SetEase／Kill／Complete／IsActive */
export class Sequence implements Animatable {
  /** Sequence 沒有 DOTween 意義上的目標，用自己當目標（Tweens.kill 不會誤殺它） */
  readonly target: object = {};
  killed = false;
  ease: Ease = EASES[EaseNum.Linear]; // Sequence.Setup :158（預設 Linear）
  private readonly items: SequenceItem[] = [];
  private length = 0;
  /** Sequence.lastTweenInsertTime */
  private lastInsert = 0;
  private elapsed = 0;
  private completeCallbacks: (() => void)[] = [];

  get duration(): number {
    return this.length;
  }

  get isActive(): boolean {
    return !this.killed;
  }

  setEase(e: Ease): this {
    this.ease = e;
    return this;
  }

  /** Sequence.Append（DoInsert 在 duration 的位置） */
  append(a: Animatable): this {
    this.insert(a, this.length);
    return this;
  }

  /** Sequence.Join（DoInsert 在 lastTweenInsertTime 的位置） */
  join(a: Animatable): this {
    this.insert(a, this.lastInsert);
    return this;
  }

  /** Sequence.AppendInterval（DoAppendInterval :74-79） */
  appendInterval(seconds: number): this {
    this.lastInsert = this.length;
    this.length += seconds;
    return this;
  }

  /** Sequence.PrependInterval（DoPrependInterval :81-93）：所有子項往後挪、lastTweenInsertTime 歸零。SetDelay 用在 Sequence 上就是這個 */
  prependInterval(seconds: number): this {
    this.lastInsert = 0;
    this.length += seconds;
    for (const it of this.items) it.start += seconds;
    return this;
  }

  /** Sequence.AppendCallback（DoInsertCallback :95-106，回呼在 duration 的位置） */
  appendCallback(fn: () => void): this {
    this.lastInsert = this.length;
    this.items.push({ start: this.length, length: 0, callback: fn, fired: false });
    return this;
  }

  onComplete(fn: () => void): this {
    this.completeCallbacks.push(fn);
    return this;
  }

  private insert(a: Animatable, at: number): void {
    this.lastInsert = at;
    this.items.push({ start: at, length: a.duration, anim: a, fired: false });
    if (at + a.duration > this.length) this.length = at + a.duration;
  }

  /** 每格推進：時間經過 Sequence 自己的緩動後，帶動每個子項 */
  update(dt: number): boolean {
    if (this.killed) return true;
    this.elapsed += dt;
    if (this.elapsed >= this.length) {
      this.render(this.length);
      this.finish();
      return true;
    }
    this.render(this.elapsed);
    return false;
  }

  seek(progress: number): void {
    if (this.killed) return;
    this.render(clamp01(progress) * this.length);
  }

  complete(): void {
    if (this.killed) return;
    this.render(this.length);
    this.finish();
  }

  /** Sequence.Kill（不觸發 OnComplete） */
  kill(): void {
    this.killed = true;
  }

  private render(time: number): void {
    // DoApplyTween :209-213：有 ease 時 position ＝ duration × ease(time／duration)
    const pos = this.ease !== EASES[EaseNum.Linear] && this.length > 0 ? this.length * this.ease(clamp01(time / this.length)) : time;
    for (const it of this.items) {
      if (it.callback) {
        if (!it.fired && pos >= it.start) {
          it.fired = true;
          it.callback();
        }
        continue;
      }
      if (pos < it.start || !it.anim) continue;
      const local = it.length > 0 ? clamp01((pos - it.start) / it.length) : 1;
      it.anim.seek(local);
    }
  }

  private finish(): void {
    this.killed = true;
    for (const f of this.completeCallbacks) f();
  }
}

type Vec3 = { x: number; y: number; z: number };

/** 固定種子的亂數（mulberry32）：DOShakePosition 用，同一頁每次跑出一樣的序列 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Random.Range(−r, r) */
function rangeSym(rand: () => number, r: number): number {
  return -r + rand() * 2 * r;
}

/** DOTweenUtils.Vector3FromAngle（DOTweenUtils.cs:13-17） */
function vector3FromAngle(degrees: number, magnitude: number): Vec3 {
  const f = degrees * (Math.PI / 180);
  return { x: magnitude * Math.cos(f), y: magnitude * Math.sin(f), z: 0 };
}

/** Quaternion.AngleAxis(angle, Vector3.up) × v（繞 +Y 軸的右手旋轉） */
function rotateAroundY(v: Vec3, angleDeg: number): Vec3 {
  const r = angleDeg * (Math.PI / 180);
  const c = Math.cos(r);
  const s = Math.sin(r);
  return { x: v.x * c + v.z * s, y: v.y, z: -v.x * s + v.z * c };
}

/**
 * DOTween.Shake 的段數與位移（DOTween.cs:439-530，ignoreZAxis＝false、vectorBased＝false、randomnessMode＝Full）。
 * 回傳每一段的終點位移（最後一段是 0，所以會回到起始位置）與每段的長度（加總＝duration）。
 */
export function shakeSegments(
  duration: number,
  strength: number,
  vibrato: number,
  randomness: number,
  fadeOut: boolean,
  rand: () => number,
): { ends: Vec3[]; durations: number[] } {
  let num = strength;
  let count = Math.trunc(vibrato * duration); // DOTween.cs:442
  if (count < 2) count = 2; // :443-446
  const num3 = num / count; // :447
  const raw: number[] = [];
  let sum = 0;
  for (let i = 0; i < count; i++) {
    const num5 = (i + 1) / count;
    const num6 = fadeOut ? duration * num5 : duration / count; // :450-455
    sum += num6;
    raw.push(num6);
  }
  const num7 = duration / sum; // :459
  const durations = raw.map((d) => d * num7); // :460-463
  let num8 = rand() * 360; // UnityEngine.Random.Range(0f, 360f)
  const ends: Vec3[] = [];
  for (let k = 0; k < count; k++) {
    if (k < count - 1) {
      if (k > 0) num8 = num8 - 180 + rangeSym(rand, randomness); // :487-488
      const angle = rangeSym(rand, randomness); // :490-491
      const v = vector3FromAngle(num8, num);
      ends.push(rotateAroundY(v, angle));
      if (fadeOut) num -= num3; // :524-525
    } else {
      ends.push({ x: 0, y: 0, z: 0 }); // :531-534
    }
  }
  return { ends, durations };
}

/** DOShakePosition 的補間（段間線性之外，每段一個緩動；原版 Vector3ArrayPlugin.cs:100-135） */
export class ShakeTween implements Animatable {
  killed = false;
  readonly duration: number;
  private base: Vec3 | null = null;
  private completeCallbacks: (() => void)[] = [];
  readonly ease: Ease = EASES[DEFAULT_EASE];

  constructor(
    readonly target: object,
    private readonly getter: () => Vec3,
    private readonly setter: (v: Vec3) => void,
    private readonly ends: Vec3[],
    private readonly durations: number[],
  ) {
    let sum = 0;
    for (const d of durations) sum += d;
    this.duration = sum;
  }

  onComplete(fn: () => void): this {
    this.completeCallbacks.push(fn);
    return this;
  }

  private apply(elapsed: number): void {
    if (this.base === null) this.base = { ...this.getter() };
    let acc = 0;
    let prev: Vec3 = { x: 0, y: 0, z: 0 };
    for (let i = 0; i < this.durations.length; i++) {
      const d = this.durations[i];
      const last = i === this.durations.length - 1;
      if (elapsed <= acc + d || last) {
        const local = d > 0 ? clamp01((elapsed - acc) / d) : 1;
        const e = this.ease(local);
        const end = this.ends[i];
        const b = this.base;
        this.setter({ x: b.x + prev.x + (end.x - prev.x) * e, y: b.y + prev.y + (end.y - prev.y) * e, z: b.z + prev.z + (end.z - prev.z) * e });
        return;
      }
      acc += d;
      prev = this.ends[i];
    }
  }

  private elapsed = 0;

  update(dt: number): boolean {
    if (this.killed) return true;
    this.elapsed += dt;
    if (this.elapsed >= this.duration) {
      this.complete();
      return true;
    }
    this.apply(this.elapsed);
    return false;
  }

  seek(progress: number): void {
    if (this.killed) return;
    this.apply(clamp01(progress) * this.duration);
  }

  complete(): void {
    if (this.killed) return;
    this.apply(this.duration);
    this.killed = true;
    for (const f of this.completeCallbacks) f();
  }

  /** getter 只在第一次推進時抓（與 DOTween 的 lazy startup 一致）；這裡給測試看目前的基準位置 */
  get basePosition(): Vec3 | null {
    return this.base;
  }
}

/** DOTween 的全域容器（每個 World 一份）：DOKill、CompleteAll、Update */
export class Tweens {
  private list: Animatable[] = [];
  /** 世界層級的固定種子亂數（DOShakePosition 用） */
  readonly rand = mulberry32(20261010);

  to(target: object, getter: () => Lerpable, setter: (v: Lerpable) => void, end: Lerpable, duration: number): Tween {
    const t = new Tween(target, getter, setter, end, duration);
    this.list.push(t);
    return t;
  }

  /** 把已經建好的補間（Sequence、ShakeTween…）交給容器推進 */
  add<T extends Animatable>(anim: T): T {
    this.list.push(anim);
    return anim;
  }

  /** 從容器拿掉（不停、不完成）：Append／Join 進 Sequence 的補間改由 Sequence 帶（DOTween 的 nested tween；csport/runtime.ts 用） */
  remove(anim: Animatable): void {
    this.list = this.list.filter((t) => t !== anim);
  }

  /** DOTween.Sequence()：建立並交給容器推進 */
  sequence(): Sequence {
    const s = new Sequence();
    this.list.push(s);
    return s;
  }

  /** DOShakePosition（Transform 版，ShortcutExtensions.cs:685-700）：getter／setter 讀寫位置 */
  shakePosition(
    target: object,
    getter: () => Vec3,
    setter: (v: Vec3) => void,
    duration: number,
    strength = 1,
    vibrato = 10,
    randomness = 90,
    fadeOut = true,
  ): ShakeTween {
    const { ends, durations } = shakeSegments(duration, strength, vibrato, randomness, fadeOut, this.rand);
    return this.add(new ShakeTween(target, getter, setter, ends, durations));
  }

  /** DOKill：這個目標上的補間全部停；complete 時先跳到終點 */
  kill(target: object, complete = false): void {
    for (const t of this.list) {
      if (t.target !== target || t.killed) continue;
      if (complete) t.complete();
      else t.killed = true;
    }
    this.list = this.list.filter((t) => !t.killed);
  }

  /** DOTween.CompleteAll：全部補間跳到終點（PauseMenu.ShowPauseMenu/Resume 開頭） */
  completeAll(): void {
    for (const t of [...this.list]) if (!t.killed) t.complete();
  }

  update(dt: number): void {
    const current = [...this.list];
    for (const t of current) if (!t.killed) t.update(dt);
    this.list = this.list.filter((t) => !t.killed);
  }

  get count(): number {
    return this.list.length;
  }
}

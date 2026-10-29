// DOTween 子集（tween.ts）的單元測試（第 1 輪）：緩動的手算值（EaseManager.cs 公式代入 t＝0.25、0.5、0.75）、
// Sequence 的插入時間（Join／AppendInterval，立繪對話那串）、Sequence 外層緩動 ∘ 內層緩動、DOShakePosition 結束時回到起點。
// 手算值寫死在這個檔裡，不從 tween.ts 反算。這個檔只在 vitest 裡跑（實作端不跑，由 Claude Code 跑）。
import { describe, expect, it } from 'vitest';
import { type Animatable, DEFAULT_EASE, EASES, EaseNum, Sequence, Tween, Tweens, mulberry32 } from './tween';

/** 手算值：EaseManager.cs 的公式代入 t＝0.25、0.5、0.75（InBack／OutBack 的 overshoot 是 1.70158） */
const HAND_VALUES: [string, number, [number, number, number]][] = [
  ['Linear', EaseNum.Linear, [0.25, 0.5, 0.75]],
  ['InOutSine', EaseNum.InOutSine, [0.14644660940672624, 0.5, 0.8535533905932738]],
  ['OutQuad', EaseNum.OutQuad, [0.4375, 0.75, 0.9375]],
  ['InQuart', EaseNum.InQuart, [0.00390625, 0.0625, 0.31640625]],
  ['OutQuart', EaseNum.OutQuart, [0.68359375, 0.9375, 0.99609375]],
  ['InQuint', EaseNum.InQuint, [0.0009765625, 0.03125, 0.2373046875]],
  ['OutQuint', EaseNum.OutQuint, [0.7626953125, 0.96875, 0.9990234375]],
  ['InBack', EaseNum.InBack, [-0.0641365625, -0.0876975, 0.1825903125]],
  ['OutBack', EaseNum.OutBack, [0.8174096875, 1.0876975, 1.0641365625]],
  // 第 3 階段第七段第 2 輪加的三個（EaseManager.cs:231-235）：OutCubic＝(t−1)³＋1；InOutCubic＝t<½ 時 4t³，否則 (t−1)(2t−2)²＋1；InOutQuart＝t<½ 時 8t⁴，否則 1−8(t−1)⁴
  ['OutCubic', EaseNum.OutCubic, [0.578125, 0.875, 0.984375]], // (−0.75)³＋1、(−0.5)³＋1、(−0.25)³＋1
  ['InOutCubic', EaseNum.InOutCubic, [0.0625, 0.5, 0.9375]], // 4×0.25³；(−0.5)×1²＋1；(−0.25)×0.5²＋1
  ['InOutQuart', EaseNum.InOutQuart, [0.03125, 0.5, 0.96875]], // 8×0.25⁴；1−8×0.5⁴；1−8×0.25⁴
  // 10/13 能力圖示加的（EaseManager.cs:74-79）：OutExpo＝1−2^(−10t)，t＝1 才回 1
  ['OutExpo', EaseNum.OutExpo, [0.8232233047033631, 0.96875, 0.9944757282719801]], // 1−2^−2.5、1−2^−5、1−2^−7.5
];

/** 記錄 seek 被呼叫的假補間（長度 0：一進入時間點就算「出現」） */
type Recorder = Animatable & { calls: number[] };

function recorder(): Recorder {
  const calls: number[] = [];
  return {
    target: {},
    duration: 0,
    killed: false,
    calls,
    update: () => false,
    complete: () => {},
    seek: (p: number) => {
      calls.push(p);
    },
  };
}

/** 立繪對話一串：5 個字各自 Join，之後 AppendInterval(0.025)（TachiEDialogueBuilder.cs 的 ShowDialogue） */
function dialogueSeq(): { seq: Sequence; chars: Recorder[] } {
  const seq = new Sequence();
  const chars = [recorder(), recorder(), recorder(), recorder(), recorder()];
  for (const c of chars) {
    seq.join(c);
    seq.appendInterval(0.025);
  }
  return { seq, chars };
}

/** 在時間 e 秒時看得到的字數（每次都從頭建一個 Sequence，免得前一次的 seek 影響結果） */
function visibleCountAt(e: number): number {
  const { seq, chars } = dialogueSeq();
  seq.seek(e / seq.duration);
  return chars.filter((c) => c.calls.length > 0).length;
}

describe('緩動（EaseManager.cs）', () => {
  it.each(HAND_VALUES)('%s 在 t＝0.25、0.5、0.75 對手算值', (_name, ease, values) => {
    const [a, b, c] = values;
    expect(EASES[ease](0.25)).toBeCloseTo(a, 9);
    expect(EASES[ease](0.5)).toBeCloseTo(b, 9);
    expect(EASES[ease](0.75)).toBeCloseTo(c, 9);
  });

  it('預設緩動是 OutQuad（DOTweenSettings.defaultEaseType＝6）', () => {
    expect(DEFAULT_EASE).toBe(EaseNum.OutQuad);
  });
});

describe('Tween（DOTween.To 的對應）', () => {
  it('起點在第一次推進時才抓（lazy startup）：建立之後才改起點，就從新的值開始', () => {
    const obj = { v: 0 };
    const tweens = new Tweens();
    tweens
      .to(
        obj,
        () => obj.v,
        (v) => {
          obj.v = v as number;
        },
        1,
        1,
      )
      .setEase(EASES[EaseNum.OutQuad]);
    obj.v = 0.6;
    tweens.update(0.5);
    // 0.6 + (1 − 0.6) × OutQuad(0.5)＝0.6 + 0.4 × 0.75
    expect(obj.v).toBeCloseTo(0.9, 9);
  });

  it('結束時 onComplete 只觸發一次，之後從容器移除', () => {
    const obj = { v: 0 };
    const tweens = new Tweens();
    let done = 0;
    tweens
      .to(
        obj,
        () => obj.v,
        (v) => {
          obj.v = v as number;
        },
        1,
        0.5,
      )
      .onComplete(() => {
        done++;
      });
    tweens.update(0.3);
    expect(done).toBe(0);
    tweens.update(0.3);
    expect(done).toBe(1);
    expect(obj.v).toBeCloseTo(1, 12);
    expect(tweens.count).toBe(0);
    tweens.update(1);
    expect(done).toBe(1);
  });
});

describe('Sequence（Sequence.cs 的插入時間）', () => {
  it('立繪對話那串：字的出現時間 0、0、0.025、0.05、0.075，總長 0.125', () => {
    const { seq } = dialogueSeq();
    expect(seq.duration).toBeCloseTo(0.125, 12);
  });

  it.each([
    [1 / 60, 2], // 0.0167：時間 0 的兩個字已經出現
    [2 / 60, 3], // 0.0333：再加上 0.025 那個
    [4 / 60, 4], // 0.0667：再加上 0.05 那個
    [7 / 60, 5], // 0.1167：全部
  ])('e＝%f 秒時看得到的字數是 %i（不落在邊界上）', (e, n) => {
    expect(visibleCountAt(e)).toBe(n);
  });

  it('外層緩動 ∘ 內層緩動：Sequence 的 ease 先把時間映射過，子補間再套自己的 ease', () => {
    const obj = { v: 0 };
    const seq = new Sequence().setEase(EASES[EaseNum.InOutSine]);
    seq.append(
      new Tween(
        obj,
        () => obj.v,
        (v) => {
          obj.v = v as number;
        },
        1,
        1,
      ).setEase(EASES[EaseNum.InQuart]),
    );
    seq.seek(0.25);
    const outer = EASES[EaseNum.InOutSine](0.25);
    expect(obj.v).toBeCloseTo(EASES[EaseNum.InQuart](outer), 9);
    // 只套內層（沒有外層）的值差很多，證明外層有作用
    expect(obj.v).not.toBeCloseTo(EASES[EaseNum.InQuart](0.25), 3);
  });
});

describe('DOShakePosition（DOTween.cs:439-534）', () => {
  type V = { x: number; y: number; z: number };

  /** 跑一次震動：先推 0.03 秒記中間位置，再推過結束記最後位置 */
  function shakeRun(): { mid: V; end: V } {
    const pos = { x: 1, y: 2, z: 3 };
    const tweens = new Tweens();
    tweens.shakePosition(
      pos,
      () => ({ ...pos }),
      (v) => {
        pos.x = v.x;
        pos.y = v.y;
        pos.z = v.z;
      },
      0.1,
      0.1,
    );
    tweens.update(0.03);
    const mid = { ...pos };
    tweens.update(0.2);
    return { mid, end: { ...pos } };
  }

  it('結束時回到起始位置；同一個固定種子跑出同一個中間位置', () => {
    const a = shakeRun();
    const b = shakeRun();
    expect(a.mid).toEqual(b.mid);
    expect(a.mid).not.toEqual({ x: 1, y: 2, z: 3 });
    expect(a.end.x).toBeCloseTo(1, 9);
    expect(a.end.y).toBeCloseTo(2, 9);
    expect(a.end.z).toBeCloseTo(3, 9);
  });
});

describe('固定種子的亂數（DOShakePosition 用）', () => {
  it('同一個種子跑出同一串數字，值在 [0, 1) 之間', () => {
    const a = mulberry32(20261010);
    const b = mulberry32(20261010);
    const xs = [a(), a(), a(), a(), a()];
    expect(xs).toEqual([b(), b(), b(), b(), b()]);
    for (const x of xs) {
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(1);
    }
  });
});

// 主迴圈的節流：照 Unity 的 QualitySettings.vSyncCount 與 Application.targetFrameRate 決定這個 requestAnimationFrame 要不要跑一格。
// 網頁的 rAF 跟著螢幕更新（等於一直開著垂直同步），所以只能少跑，不能比更新率快。

/** 一格的節流設定：vSyncCount、targetFrameRate 是遊戲設的值，refreshHz 是螢幕更新率 */
export interface FramePacing {
  vSyncCount: number;
  targetFrameRate: number;
  refreshHz: number;
}

/**
 * 回傳一個判斷函式：rAF 的時間（ms）→ 這一格要不要跑。照桌面 Unity 的規則（MT2 原版是 Windows／Steam）：
 * - vSyncCount > 0：每 vSyncCount 次垂直同步一格（1 是更新率、2 是一半），不看 targetFrameRate
 * - vSyncCount 0：照 targetFrameRate；-1（或 0）是平台預設，桌面是不限，網頁上就是每個 rAF 都跑
 * 間隔不到一次垂直同步的都每格跑。時間照目標往後排（不累積誤差），落後超過兩格就從現在重排
 */
export function framePacer(): (now: number, p: FramePacing) => boolean {
  let next = -Infinity;
  return (now, p) => {
    const vblank = 1000 / p.refreshHz;
    const interval = p.vSyncCount > 0 ? p.vSyncCount * vblank : p.targetFrameRate > 0 ? 1000 / p.targetFrameRate : 0;
    if (interval <= vblank * 1.05) {
      next = now;
      return true;
    }
    // rAF 的時間有抖動，差不到半次垂直同步就算到了
    if (now < next - vblank / 2) return false;
    next = now - next > interval * 2 ? now + interval : next + interval;
    return true;
  };
}

/** 常見的螢幕更新率：量到的值取最接近的一個 */
const COMMON_RATES = [30, 48, 50, 60, 72, 75, 90, 100, 120, 144, 165, 180, 200, 240];

/**
 * 量 requestAnimationFrame 的間隔推算螢幕更新率（Hz）：取 samples 個間隔的中位數，對到最接近的常見值。
 * 開機前、主執行緒還閒的時候量；量不到（背景分頁 rAF 停住）timeoutMs 後回 fallback
 */
export function measureRefreshRate(samples = 30, timeoutMs = 1500, fallback = 60): Promise<number> {
  if (typeof requestAnimationFrame === 'undefined') return Promise.resolve(fallback);
  return new Promise((resolve) => {
    const d: number[] = [];
    let last = 0;
    let done = false;
    const finish = (hz: number) => {
      if (!done) resolve(hz);
      done = true;
    };
    setTimeout(() => finish(fallback), timeoutMs);
    const tick = (t: number) => {
      if (done) return;
      if (last) d.push(t - last);
      last = t;
      if (d.length < samples) {
        requestAnimationFrame(tick);
        return;
      }
      d.sort((a, b) => a - b);
      finish(nearestRate(1000 / d[d.length >> 1]));
    };
    requestAnimationFrame(tick);
  });
}

export function nearestRate(hz: number): number {
  return COMMON_RATES.reduce((best, r) => (Math.abs(r - hz) < Math.abs(best - hz) ? r : best));
}

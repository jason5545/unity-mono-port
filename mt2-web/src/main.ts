// 遊戲頁（index.html?scene=main_menu）：用工具包的執行環境載入匯入器的輸出（public/game），畫出原版場景。
// 網址參數：沒給 scene 就照原版從 build 的第一個場景（start）開機，由遊戲腳本換場景；
// scene=<名> 只載那個場景（檢視用，不跑開機流程）、animate=0 停在第一格、text=0 不畫文字。
import { attachInput, bootGame, bootScene, fitCanvas, loadShared, type Session } from '@runtime/viewer/boot';
import * as core from '@runtime/csport/core';
import { genRegistry, registerGen, trace } from '@runtime/csport/core';
import { registerEnums } from '@runtime/csport/dotnet';
import { activeVideos, audioDebug } from '@runtime/csport/unity';
import { setSteamDlcOwned } from '@runtime/csport/steamworks';
import { setApplicationQuitHandler } from '@runtime/csport/unityScene';
import type { SceneNode } from '@runtime/unity/scene';
import type { ComponentData } from '@runtime/unity/types';
import { GENERATED, GENERATED_ENUMS } from './csport/gen';
import * as R from './csport/runtime';
import { framePacer, measureRefreshRate } from '@runtime/viewer/framePacing';

// 轉換器產生的類別（cs2ts.json 的 web 目標）：登記，再接成 Behaviour（uGUI 的 Selectable、Button 也是產生的，蓋過執行環境手寫的）
registerGen(GENERATED);
registerEnums(GENERATED_ENUMS);
const REGISTRY = genRegistry(GENERATED);
// 離線的 Steam：Jason 的帳號擁有全部 DLC（2026/10/16 確認），DLC 內容照已購買打開
setSteamDlcOwned('all');
// 原版的「退出遊戲」（PauseDialog.QuitGame → Application.Quit，存完檔才關）：跟 diceomancer-web 一樣
// - APK：殼的 MT2App.quit()（MainActivity 的 finishAndRemoveTask：關掉並從最近使用移除）。
// - 瀏覽器：window.close()。HTML 規格只讓腳本關「腳本開的」或「歷史紀錄只有一筆」的分頁，關不掉時換成空白頁，遊戲照樣結束。
setApplicationQuitHandler(() => {
  if (window.MT2App?.quit) {
    window.MT2App.quit();
    return;
  }
  window.close();
  // 關得掉的話這一頁已經不在，計時器不會跑
  setTimeout(() => location.replace('about:blank'), 300);
});

const params = new URLSearchParams(location.search);
const sceneName = params.get('scene');
const status = document.getElementById('status')!;
// Android（APK 與瀏覽器）不顯示左下角的載入時間與匯入備註，只留錯誤
const android = /Android/.test(navigator.userAgent);
const quietStatus = android;
if (quietStatus) status.textContent = '';

declare global {
  interface Window {
    __session?: Session;
    /** APK 殼注入的介面（MainActivity.AppBridge）；舊版殼沒有 refreshRate */
    MT2App?: { quit?: () => void; refreshRate?: () => number; safeInsets?: () => string };
    __trace?: typeof trace;
    /** 除錯用：工具包的 csport 核心（ctxOf、existingCtx、compHandle…） */
    __core?: typeof core;
    __ready?: Promise<unknown>;
    /** 除錯用：場景、根物件、腳本例外、走到的 notPorted */
    __report?: () => unknown;
    /** 除錯用（分頁在背景時 requestAnimationFrame 不跑）：手動推 n 格，每格讓出事件迴圈給載入用 */
    __step?: (n: number) => Promise<unknown>;
    /** 除錯用：在螢幕座標（Unity 的像素、原點左下）點一下，跟 attachInput 一樣設 Input 的滑鼠狀態 */
    __tap?: (sx: number, sy: number) => Promise<void>;
    /** 除錯用：按住左鍵沿折線拖過去再放開（點是螢幕座標；每段切 n 步、每步推 2 格，Update 讀得到中途的 Input.mousePosition） */
    __drag?: (points: [number, number][], n?: number) => Promise<void>;
    /** 除錯用：按一下鍵（KeyboardEvent.code） */
    __key?: (code: string) => Promise<void>;
    /** 除錯用：VideoPlayer 用的 <video> 狀態 */
    __videos?: () => unknown;
    /** 除錯用：AudioContext 的狀態、正在播的 AudioSource、混音器各群組的音量 */
    __audio?: () => unknown;
    /** 除錯用：腳本類別是 cls 的元件（含停用的），帶節點、handle 與 Ctx（ai 是實體欄位） */
    __find?: (cls: string) => { n: SceneNode; c: ComponentData; h: object; ctx: core.Ctx }[];
    /** 除錯用：翻譯不出來的 key（I2 LocalizationManager.GetTranslation 回空字串、原樣或 KEY>>…<<），次數與第一次的呼叫端 */
    __locMissing?: () => { key: string; times: number; result: unknown; stack: string }[];
  }
}

window.__report = () => {
  const s = window.__session;
  const short = (st: string) => st.split('\n').slice(1, 3).map((l) => l.trim().replace(location.origin, '').replace(/\?t=\d+/g, '')).join(' | ');
  return {
    scenes: s?.world.scenes.loaded.map((x) => x.name),
    active: s?.world.scenes.active?.name,
    roots: s?.world.graph.roots.map((r) => `${r.go.m_Name}@${(r.scene as { name?: string } | undefined)?.name}`).join(', '),
    exceptions: s?.world.exceptions.map((e) => `${e.where} ×${e.times}: ${e.message.slice(0, 240)} | ${short(e.stack)}`),
    notes: s ? [...s.world.notes].slice(-20) : [],
    notPorted: [...trace.notPorted.keys()].slice(0, 40),
  };
};

window.__find = (cls) => {
  const w = window.__session!.world;
  const out: { n: SceneNode; c: ComponentData; h: object; ctx: core.Ctx }[] = [];
  for (const n of w.graph.nodes.values())
    for (const c of w.graph.components(n))
      if (c.script?.class === cls) {
        const h = core.compHandle(w, c);
        out.push({ n, c, h, ctx: core.ctxOf(w, h, cls) });
      }
  return out;
};

// 翻譯不出來的 key（畫面上顯示成標籤的那種）：包住 I2 的 GetTranslation 記下來。詞條本身 10918 個都翻得出來（10/18 實測），
// 會落到這裡的是程式組出來的 key 不對（例如 "Enum_DialogueSpeed_" + 列舉值 轉成 Enum_DialogueSpeed_undefined）
const locMissing = new Map<string, { times: number; result: unknown; stack: string }>();
{
  // 直接改產生表（genClass 會先跑靜態建構子，這時候還沒有 World）
  const loc = GENERATED.LocalizationManager;
  const getTranslation = loc.methods.GetTranslation;
  loc.methods.GetTranslation = (c: core.Ctx, term: unknown, ...rest: unknown[]) => {
    const r = getTranslation(c, term, ...rest);
    if (typeof term === 'string' && term && (r == null || r === '' || r === term || (typeof r === 'string' && r.startsWith('KEY>>')))) {
      const hit = locMissing.get(term);
      if (hit) hit.times++;
      else locMissing.set(term, { times: 1, result: r, stack: (new Error().stack ?? '').split('\n').slice(2, 8).join(' | ') });
    }
    return r;
  };
}
window.__locMissing = () => [...locMissing].map(([key, v]) => ({ key, ...v }));

// Android 照手機版的做法（Jason 10/18，參考 MT1 的 Android 版）：畫面是手機的原生解析度、填滿螢幕，設定裡沒有解析度與全螢幕模式。
// MT2 原版只有 Steam／Standalone 兩種平台服務，HasFixedResolution 都是 false。GraphicsSettingsManager 本來就有平台解析度固定的分支
// （DoesSupportChangingResolution 回 false：不列解析度、不叫 Screen.SetResolution、不跟著螢幕改偏好），Android 上讓平台服務回 true 走那條。
// 畫面寬於 2:1 原版自己會換排法（GameObjectUtil.ConfigureAspectFitter、IntroStartScreen 的主視覺），所以畫布不鎖 16:9（main 的 fitCanvas）。
if (android) {
  GENERATED.SteamPlatformServices.methods.HasFixedResolution = () => true;
  // 設定選單（SettingsDialog）與第一次的設定畫面（FirstTimeSettingsScreen）：Initialize 跑完把解析度、全螢幕模式兩列關掉，
  // 再照 SettingsDialog.Initialize 的結尾重編隔行底色（SettingsEntry.SetIndex），結果等於原版在那之前就關掉
  const settingsEntryRoot = GENERATED.SettingsDialog.methods.GetSettingsEntryRoot;
  for (const cls of ['SettingsDialog', 'FirstTimeSettingsScreen']) {
    const m = GENERATED[cls].methods;
    const initialize = m.Initialize;
    m.Initialize = (c: core.Ctx, ...a: unknown[]) => {
      const r = initialize(c, ...a);
      for (const k of ['resolutionDropdown', 'fullScreenDropdown']) {
        const dd = c.ai[k];
        if (dd) R.GameObject_SetActive(c, settingsEntryRoot(c, dd) ?? R.Component_get_gameObject(c, dd), false);
      }
      for (const tab of c.ai.tabs ?? []) {
        const entries: object[] = R.GameObject_GetComponentsInChildren$(c, R.callGen(c, 'SettingsTab', 'get_SectionRoot', tab), 'SettingsEntry');
        entries.forEach((e, i) => R.callGen(c, 'SettingsEntry', 'SetIndex', e, i));
      }
      return r;
    };
  }
  // 螢幕圓角：HUD 右上角的設定齒輪與頂端資訊列的右緣往內挪（gearInset 那段）
  const hud = GENERATED.Hud.methods;
  const hudStart = hud.Start;
  hud.Start = (c: core.Ctx, ...a: unknown[]) => {
    const r = hudStart(c, ...a);
    const screenH = c.w?.screen.h ?? 0;
    const d = screenH ? gearInset(screenCorner(), screenH) / (screenH / 1080) : 0;
    if (d > 0) {
      const gear = c.ai.settingsButton && R.Component_get_transform(c, c.ai.settingsButton);
      if (gear) {
        const p = R.nativeGet(c, gear, 'RectTransform', 'anchoredPosition') as { x: number; y: number };
        R.nativeSet(c, gear, 'RectTransform', 'anchoredPosition', { x: p.x - d, y: p.y });
      }
      const bar = c.ai.gameplayHudRoot && R.GameObject_get_transform(c, c.ai.gameplayHudRoot);
      if (bar) {
        const m = R.nativeGet(c, bar, 'RectTransform', 'offsetMax') as { x: number; y: number };
        R.nativeSet(c, bar, 'RectTransform', 'offsetMax', { x: m.x - d, y: m.y });
      }
    }
    return r;
  };
  // 目標幀率的清單：原版只在可以改解析度時建（RefreshResolutions），固定解析度的分支只放螢幕更新率一個。
  // 垂直同步、目標幀率在 Android 照樣能改（HasFixedFrameRate 是 false），清單照 RefreshResolutions 的規則補：更新率，加上比它小的
  // targetFrameratesSpecial（20、30、60、75、144、240）；120 Hz 的手機是 120、75、60、30、20
  // 掛在 Start（Unity 的訊息經過方法表；Init 是 Start 直接叫的）：Init 跑完、DepInjector.AddProvider 之後補，設定選單開的時候讀得到
  const gsm = GENERATED.GraphicsSettingsManager;
  const start = gsm.methods.Start;
  gsm.methods.Start = (c: core.Ctx, ...a: unknown[]) => {
    const r = start(c, ...a);
    const hz = Math.round(R.getDisplayRefreshRate());
    gsm.methods.AddTargetFramerate(c, hz);
    for (const fps of gsm.statics!.targetFrameratesSpecial.get() as number[]) if (fps < hz) gsm.methods.AddTargetFramerate(c, fps);
    return r;
  };
}

// 滾輪：原版的 CoreInputDriverMouse 在 OnGUI 讀 Event.current 的 ScrollWheel（_scrollDeltaY = −delta.y），OnLateUpdate 交給 MouseWheel 軸；
// 換樓層（RoomUI.HandleScrollWheel）與地圖捲動（MapScreen.HandleScrollWheel）都吃這個軸。執行環境不叫 OnGUI，_scrollDeltaY 一直是 0，
// 這裡在 OnLateUpdate 之前把這一格的量補上，等於 OnGUI 收到了這一格的 ScrollWheel 事件。
// 單位是 Event.delta：滾輪一格當 3。Unity 在 Windows 一格給多少沒查到（未查證）；RoomUI 一格的捲動是 scrollHigherThresholdSectionPct / 2.94，
// 主戰場的換樓門檻也是 0.5（main.unity），3 剛好一格換一層，照這個推。
const WHEEL_NOTCH = 3;
/** 觸控滑動換算的量（Event.delta 的單位，往上為正，跟 _scrollDeltaY 同號），下一次 OnLateUpdate 用掉 */
let swipeScroll = 0;
{
  const driver = GENERATED.CoreInputDriverMouse.methods;
  const onLateUpdate = driver.OnLateUpdate;
  driver.OnLateUpdate = (c: core.Ctx, ...a: unknown[]) => {
    const wheel = (c.w?.mouse.scrollY ?? 0) * WHEEL_NOTCH + swipeScroll;
    swipeScroll = 0;
    if (wheel) c.ai._scrollDeltaY = wheel;
    return onLateUpdate(c, ...a);
  };
}

/**
 * 手機的上下滑動（Jason 10/18：戰鬥滑動換樓層、地圖滑動捲動）：原版只有滑鼠滾輪跟搖桿，沒有滑動手勢，這裡把滑動換成滾輪，
 * 走原版的 HandleScrollWheel。手指往下＝內容往下跟著走＝看上面＝滾輪往上。
 * 一次滑動換一段（Jason 10/18：樓層與地圖都是一段一段的，滑一下就切上一段或下一段）：認出方向就送一次 SWIPE_STEP，同一次滑動不再送。
 * 原版換段時把累計歸零（RoomUI 選樓層、MapScreen.FocusOnSection），量給大一點只會換一段，跟捲動靈敏度無關；
 * 換段動畫還在跑時再滑一下，原版在移動中的門檻也過得去，照樣再換一段。卡片詳情只看正負號。
 * 讓給原本拖曳的情況：按下時接拖曳的物件（uGUI 的 pointerDrag）是卡片或手牌區（GameUIDraggableHelper、上層有 CardUI／HandUI），
 * 或是 ScrollRect、Scrollbar、Slider 這類自己會捲的元件。房間、角色也是 GameUISelectable，拖曳照樣轉給遊戲（UISignals），
 * 原版拿它做拖卡片，房間上拖不會怎樣，所以不擋（10/18 手機實測：一開始照「uGUI 在拖就讓」，戰場上整片都是房間，滑不動）。
 */
const SWIPE_STEP = 100;
const SWIPE_YIELD = new Set(['GameUIDraggableHelper', 'CardUI', 'HandUI', 'ScrollRect', 'Scrollbar', 'Slider']);
function attachSwipe(s: Session): void {
  const { canvas, world } = s;
  const events = world.events as unknown as { pointerDrag: SceneNode | null };
  /** 按下處接拖曳的物件，自己或上層有 SWIPE_YIELD 的元件就讓給原本的拖曳 */
  const yieldsToDrag = (n: SceneNode | null): boolean => {
    for (let p = n; p; p = p.parent) for (const c of world.graph.components(p)) if (c.script?.class && SWIPE_YIELD.has(c.script.class)) return true;
    return false;
  };
  let id: number | null = null;
  let x0 = 0;
  let y0 = 0;
  // attachInput 的監聽先登記、先跑：這裡的 pointerDrag 已經是這次按下找到的拖曳對象
  canvas.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'touch' || !e.isPrimary || yieldsToDrag(events.pointerDrag)) return;
    id = e.pointerId;
    x0 = e.clientX;
    y0 = e.clientY;
  });
  canvas.addEventListener('pointermove', (e) => {
    if (e.pointerId !== id) return;
    const dx = e.clientX - x0;
    const dy = e.clientY - y0;
    // 起動距離：畫面高度的 3%，而且以垂直為主
    if (Math.abs(dy) < canvas.clientHeight * 0.03 || Math.abs(dy) < Math.abs(dx) * 1.5) return;
    swipeScroll += Math.sign(dy) * SWIPE_STEP;
    id = null;
  });
  const end = (e: PointerEvent): void => {
    if (e.pointerId === id) id = null;
  };
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', end);
}

/**
 * 螢幕圓角（Jason 10/18：圓角裁到最右邊的設定齒輪；畫面照樣延伸到底，只處理圓角）。原版沒有 Screen.safeArea 的處理（Assembly-CSharp 沒有用到），
 * 手機上只有 HUD 右上角的齒輪被裁到。齒輪是 hud 場景的 Settings button：錨在右上角、中心離角 (40, 34)、64×64，
 * 畫出來的圓（含外圈陰影）半徑約 24（10/18 在 測試手機 截圖量的，27 px ÷ 1200/1080）。單位是 HUD 畫布的單位：比 16:9 寬時
 * UICanvasScalerAspectSwitcher 讓 CanvasScaler 照高度縮放，參考高 1080（介面大小的設定改了縮放就會不準，沒處理）。
 * 齒輪往內挪 d，讓它的圓整個落在螢幕圓角裡：圓心 (d + cx, cy) 到圓角圓心 (r, r) 的距離加上 b 不超過 r。測試手機（r = 174 px）約 74 px。
 * 齒輪左邊緊貼著頂端資訊列（Gameplay hud root）右端的按鈕，只挪齒輪會疊上去，資訊列的右緣一起縮 d。
 * 圓角半徑從殼來（MT2App.safeInsets，裝置像素）；瀏覽器開（沒有殼）就不挪。
 */
function gearInset(r: number, screenH: number): number {
  const k = screenH / 1080;
  const cx = 40 * k;
  const cy = 34 * k;
  const b = 24 * k;
  if (r <= 0 || cy >= r) return 0;
  const room = (r - b) ** 2 - (r - cy) ** 2;
  if (room <= 0) return r;
  return Math.max(0, Math.ceil(r - Math.sqrt(room) - cx));
}

/** 螢幕圓角半徑（裝置像素；殼的 safeInsets 給的是圓角與挖孔取大的，挖孔比圓角淺） */
function screenCorner(): number {
  try {
    const raw = window.MT2App?.safeInsets?.();
    if (raw) return (JSON.parse(raw) as { right?: number }).right ?? 0;
  } catch {
    /* 舊版殼或讀不到：當成沒有圓角 */
  }
  return 0;
}

window.__audio = audioDebug;

window.__videos = () =>
  activeVideos().map((v) => ({
    url: v.url,
    src: v.el?.src,
    paused: v.el?.paused,
    readyState: v.el?.readyState,
    error: v.el?.error?.message ?? v.el?.error?.code,
    time: v.el?.currentTime,
    duration: v.el?.duration,
    muted: v.el?.muted,
  }));

// 讓出事件迴圈（載入的 fetch 才接得下去）：用 MessageChannel，不用 setTimeout——分頁在背景久了，計時器會被節流到一秒一次
const yieldTask = (): Promise<void> =>
  new Promise((r) => {
    const ch = new MessageChannel();
    ch.port1.onmessage = () => r();
    ch.port2.postMessage(0);
  });
const stepFrames = async (n: number): Promise<void> => {
  const s = window.__session!;
  for (let i = 0; i < n; i++) {
    s.frame(1 / 60);
    await yieldTask();
  }
  s.draw();
};
window.__step = async (n) => {
  await stepFrames(n);
  return window.__report!();
};
window.__tap = async (sx, sy) => {
  const w = window.__session!.world;
  const m = w.mouse;
  m.x = sx;
  m.y = sy;
  w.pointerMove(sx, sy);
  await stepFrames(3);
  m.leftDownThisFrame = true;
  m.leftPressed = true;
  if (m.buttons && m.buttonsDown) m.buttons[0] = m.buttonsDown[0] = true;
  w.pointerDown(sx, sy, 0);
  await stepFrames(3);
  m.leftUpThisFrame = true;
  m.leftPressed = false;
  if (m.buttons && m.buttonsUp) {
    m.buttons[0] = false;
    m.buttonsUp[0] = true;
  }
  w.pointerUp(sx, sy, 0);
  await stepFrames(3);
};
window.__drag = async (points, n = 6) => {
  const w = window.__session!.world;
  const m = w.mouse;
  const [x0, y0] = points[0]!;
  m.x = x0;
  m.y = y0;
  w.pointerMove(x0, y0);
  await stepFrames(3);
  m.leftDownThisFrame = true;
  m.leftPressed = true;
  if (m.buttons && m.buttonsDown) m.buttons[0] = m.buttonsDown[0] = true;
  w.pointerDown(x0, y0, 0);
  await stepFrames(2);
  for (let k = 1; k < points.length; k++) {
    const [ax, ay] = points[k - 1]!;
    const [bx, by] = points[k]!;
    for (let i = 1; i <= n; i++) {
      const x = ax + ((bx - ax) * i) / n;
      const y = ay + ((by - ay) * i) / n;
      m.x = x;
      m.y = y;
      w.pointerMove(x, y);
      await stepFrames(2);
    }
  }
  const [x1, y1] = points[points.length - 1]!;
  m.leftUpThisFrame = true;
  m.leftPressed = false;
  if (m.buttons && m.buttonsUp) {
    m.buttons[0] = false;
    m.buttonsUp[0] = true;
  }
  w.pointerUp(x1, y1, 0);
  await stepFrames(3);
};
window.__key = async (code) => {
  window.dispatchEvent(new KeyboardEvent('keydown', { code, key: code }));
  await stepFrames(3);
  window.dispatchEvent(new KeyboardEvent('keyup', { code, key: code }));
  await stepFrames(1);
};

/**
 * APK 的殼是 sensorLandscape：手機直拿時把 app 拉起來，WebView 第一次排版還是直向（10/18 手機量到 400×869 CSS px），
 * 照那個大小開機，畫布、Screen 與鏡頭取景都變成直向。開機前等它轉成橫向（最多 3 秒，跟載入一起等）；瀏覽器開的不等
 */
function landscapeReady(): Promise<void> {
  if (!window.MT2App || innerWidth >= innerHeight) return Promise.resolve();
  return new Promise((resolve) => {
    const done = (): void => {
      window.removeEventListener('resize', check);
      clearTimeout(timer);
      resolve();
    };
    const check = (): void => {
      if (innerWidth >= innerHeight) done();
    };
    const timer = setTimeout(done, 3000);
    window.addEventListener('resize', check);
  });
}

async function main(): Promise<void> {
  const t0 = performance.now();
  // 螢幕更新率（Screen.currentResolution 的 refreshRateRatio、垂直同步、目標幀率清單都用）：APK 問殼（它替視窗選了最高的顯示模式），
  // 其他量 requestAnimationFrame 的間隔；跟載入一起跑，要在 GraphicsSettingsManager.Init 之前好
  const appRate = window.MT2App?.refreshRate?.();
  const [shared, hz] = await Promise.all([loadShared('./game/'), appRate ? Promise.resolve(appRate) : measureRefreshRate(), landscapeReady()]);
  R.setDisplayRefreshRate(hz);
  const canvas = document.getElementById('game') as HTMLCanvasElement;
  // Android 填滿螢幕（原生解析度，見上面平台服務那段），其他照舊鎖 16:9 補黑邊
  const aspect = android ? null : 16 / 9;
  const fit = (): { w: number; h: number } => fitCanvas(canvas, aspect);
  // render thread（照 Unity 的分工，WebGL 呼叫交給 worker 的 OffscreenCanvas）：gfx=0 改回主執行緒畫；gfx=verify 逐位元驗證（兩邊各畫一份比像素）
  const gfxParam = params.get('gfx');
  const bootOpts = { noText: params.get('text') === '0', registry: REGISTRY, gameKey: 'mt2', renderThread: gfxParam === 'verify' ? ('verify' as const) : gfxParam !== '0' };
  const s = sceneName ? await bootScene(shared, sceneName, canvas, fit(), bootOpts) : await bootGame(shared, canvas, fit(), bootOpts);
  // LoadingScreen.RunOnStart 是 [RuntimeInitializeOnLoadMethod]（第一個場景載完叫），執行環境不叫這類方法，這裡補：
  // 它訂閱 Application.wantsToQuit，退出遊戲時先存檔、存完才關（LoadingScreen.WantsToQuit）
  if (!sceneName) core.callStatic(core.staticCtx, 'LoadingScreen', 'RunOnStart');
  window.__session = s;
  window.__trace = trace;
  window.__core = core;
  attachInput(s);
  attachSwipe(s);
  const notes = [...shared.notes, ...s.world.notes];
  if (!quietStatus) status.textContent = `${s.name}：${Math.round(performance.now() - t0)} ms${notes.length ? `\n${notes.join('\n')}` : ''}`;
  const onResize = (): void => {
    const { w, h } = fit();
    s.resize(w, h);
    s.draw();
  };
  window.addEventListener('resize', onResize);
  // 開機途中改過大小（轉向等）：resize 事件在掛上監聽之前就發過了，這裡補一次
  const fitted = fit();
  if (fitted.w !== s.world.screen.w || fitted.h !== s.world.screen.h) onResize();
  if (params.get('animate') !== '0') {
    // 垂直同步與目標幀率照遊戲設的值節流（viewer/framePacing.ts）：vSyncCount 1 跟著更新率、2 減半，0 照 targetFrameRate
    const pace = framePacer();
    let last = performance.now();
    const loop = (now: number) => {
      requestAnimationFrame(loop);
      // render thread 還在畫前兩格：這一格先不跑（Unity 的主執行緒等 render thread，Gfx.WaitForRenderThread）
      if (s.busy()) return;
      if (!pace(now, { ...R.frameRateSettings(), refreshHz: R.getDisplayRefreshRate() })) return;
      s.frame(Math.min(0.1, (now - last) / 1000));
      last = now;
      s.draw();
    };
    requestAnimationFrame(loop);
  }
}

window.__ready = main().catch((e) => {
  status.textContent = `錯誤：${e instanceof Error ? e.stack : e}`;
  throw e;
});

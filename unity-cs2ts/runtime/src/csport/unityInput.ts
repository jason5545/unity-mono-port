// 相容層：UnityEngine.Input（舊版輸入）與 Display。unity.ts 會 export * 這裡。
// 狀態來自 World（viewer/boot.ts 的 attachInput 把瀏覽器的指標、滾輪、鍵盤寫進去，每格結尾 endInputFrame 清掉這一格的邊緣）。
// KeyCode 照名字對到瀏覽器的 KeyboardEvent.code（列舉的名字表要先登記，registerEnums）。
// 與原版的差異：沒有搖桿與觸控（touchCount 是 0）；GetAxis 沒有 Input Manager 的平滑（gravity／sensitivity），跟 GetAxisRaw 一樣。

import type { World } from '../engine/world';
import { getActiveWorld, type Ctx } from './core';
import { enumNameOf } from './dotnet';

function w(c: Ctx): World {
  const world = c.w ?? getActiveWorld();
  if (!world) throw new Error('Input：沒有作用中的 World');
  return world;
}

/** KeyCode 的成員名 → KeyboardEvent.code（或 key）；滑鼠鍵是 Mouse<n> */
const SPECIAL: Record<string, string> = {
  Return: 'Enter', Escape: 'Escape', Space: 'Space', Tab: 'Tab', Backspace: 'Backspace', Delete: 'Delete', Insert: 'Insert',
  Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown', UpArrow: 'ArrowUp', DownArrow: 'ArrowDown', LeftArrow: 'ArrowLeft', RightArrow: 'ArrowRight',
  LeftShift: 'ShiftLeft', RightShift: 'ShiftRight', LeftControl: 'ControlLeft', RightControl: 'ControlRight', LeftAlt: 'AltLeft', RightAlt: 'AltRight',
  LeftCommand: 'MetaLeft', LeftApple: 'MetaLeft', LeftWindows: 'MetaLeft', RightCommand: 'MetaRight', RightApple: 'MetaRight', RightWindows: 'MetaRight',
  Minus: 'Minus', Equals: 'Equal', LeftBracket: 'BracketLeft', RightBracket: 'BracketRight', Backslash: 'Backslash', Semicolon: 'Semicolon', Quote: 'Quote',
  BackQuote: 'Backquote', Comma: 'Comma', Period: 'Period', Slash: 'Slash', CapsLock: 'CapsLock', Pause: 'Pause', Print: 'PrintScreen', ScrollLock: 'ScrollLock', Numlock: 'NumLock',
  KeypadPeriod: 'NumpadDecimal', KeypadDivide: 'NumpadDivide', KeypadMultiply: 'NumpadMultiply', KeypadMinus: 'NumpadSubtract', KeypadPlus: 'NumpadAdd',
  KeypadEnter: 'NumpadEnter', KeypadEquals: 'NumpadEqual',
};
function domCode(name: string): string {
  if (/^[A-Z]$/.test(name)) return `Key${name}`;
  let m = /^Alpha(\d)$/.exec(name);
  if (m) return `Digit${m[1]}`;
  m = /^Keypad(\d)$/.exec(name);
  if (m) return `Numpad${m[1]}`;
  if (/^F\d+$/.test(name)) return name;
  return SPECIAL[name] ?? name;
}
/** Input.GetKey(string) 的名字（"space"、"a"、"left shift"、"up"）→ KeyCode 的成員名 */
function nameToKeyCode(n: string): string {
  const s = n.toLowerCase();
  const map: Record<string, string> = { space: 'Space', enter: 'Return', return: 'Return', escape: 'Escape', tab: 'Tab', backspace: 'Backspace', delete: 'Delete',
    up: 'UpArrow', down: 'DownArrow', left: 'LeftArrow', right: 'RightArrow', 'left shift': 'LeftShift', 'right shift': 'RightShift',
    'left ctrl': 'LeftControl', 'right ctrl': 'RightControl', 'left alt': 'LeftAlt', 'right alt': 'RightAlt', 'left cmd': 'LeftCommand', 'right cmd': 'RightCommand' };
  if (map[s]) return map[s];
  if (/^[a-z]$/.test(s)) return s.toUpperCase();
  if (/^[0-9]$/.test(s)) return `Alpha${s}`;
  if (/^f\d+$/.test(s)) return s.toUpperCase();
  return n;
}
function keyName(code: number | string): string {
  return typeof code === 'string' ? nameToKeyCode(code) : (enumNameOf('KeyCode', code) ?? String(code));
}
function mouseIndex(name: string): number {
  const m = /^Mouse(\d)$/.exec(name);
  return m ? Number(m[1]) : -1;
}
function held(world: World, code: number | string): boolean {
  const n = keyName(code);
  const mi = mouseIndex(n);
  if (mi >= 0) return !!world.mouse.buttons?.[mi];
  return world.keysHeld.has(domCode(n));
}
function down(world: World, code: number | string): boolean {
  const n = keyName(code);
  const mi = mouseIndex(n);
  if (mi >= 0) return !!world.mouse.buttonsDown?.[mi];
  return world.input.has(domCode(n));
}
function up(world: World, code: number | string): boolean {
  const n = keyName(code);
  const mi = mouseIndex(n);
  if (mi >= 0) return !!world.mouse.buttonsUp?.[mi];
  return world.keysUp.has(domCode(n));
}
export const Input_GetKey$KeyCode = (c: Ctx, k: number): boolean => held(w(c), k);
export const Input_GetKey$string = (c: Ctx, k: string): boolean => held(w(c), k);
export const Input_GetKeyDown$KeyCode = (c: Ctx, k: number): boolean => down(w(c), k);
export const Input_GetKeyDown$string = (c: Ctx, k: string): boolean => down(w(c), k);
export const Input_GetKeyUp$KeyCode = (c: Ctx, k: number): boolean => up(w(c), k);
export const Input_GetKeyUp$string = (c: Ctx, k: string): boolean => up(w(c), k);
export const Input_GetMouseButton = (c: Ctx, i: number): boolean => !!w(c).mouse.buttons?.[i];
export const Input_GetMouseButtonDown = (c: Ctx, i: number): boolean => !!w(c).mouse.buttonsDown?.[i];
export const Input_GetMouseButtonUp = (c: Ctx, i: number): boolean => !!w(c).mouse.buttonsUp?.[i];
export const Input_get_mousePosition = (c: Ctx): { x: number; y: number; z: number } => ({ x: w(c).mouse.x, y: w(c).mouse.y, z: 0 });
export const Input_get_mouseScrollDelta = (c: Ctx): { x: number; y: number } => ({ x: 0, y: w(c).mouse.scrollY });
export const Input_get_mousePresent = (_c: Ctx): boolean => true;
export const Input_get_anyKey = (c: Ctx): boolean => w(c).keysHeld.size > 0 || !!w(c).mouse.buttons?.some(Boolean);
export const Input_get_anyKeyDown = (c: Ctx): boolean => w(c).input.size > 0 || !!w(c).mouse.buttonsDown?.some(Boolean);
export const Input_get_touchCount = (_c: Ctx): number => 0;
export const Input_get_touchSupported = (_c: Ctx): boolean => false;
export const Input_get_multiTouchEnabled = (_c: Ctx): boolean => false;
export const Input_set_multiTouchEnabled = (_c: Ctx, v: boolean): void => void v;
export const Input_get_simulateMouseWithTouches = (_c: Ctx): boolean => true;
export const Input_set_simulateMouseWithTouches = (_c: Ctx, v: boolean): void => void v;
export const Input_get_inputString = (_c: Ctx): string => '';
export const Input_get_compositionString = (_c: Ctx): string => '';
export const Input_get_imeCompositionMode = (_c: Ctx): number => 0;
export const Input_set_imeCompositionMode = (_c: Ctx, v: number): void => void v;
export const Input_get_compositionCursorPos = (_c: Ctx): { x: number; y: number } => ({ x: 0, y: 0 });
export const Input_set_compositionCursorPos = (_c: Ctx, v: unknown): void => void v;
export const Input_GetJoystickNames = (_c: Ctx): string[] => [];
export const Input_ResetInputAxes = (_c: Ctx): void => undefined;
let lastMouse = { x: 0, y: 0, frame: -1, dx: 0, dy: 0 };
function mouseDelta(world: World): { dx: number; dy: number } {
  if (lastMouse.frame !== world.frameCount) {
    lastMouse = { x: world.mouse.x, y: world.mouse.y, frame: world.frameCount, dx: (world.mouse.x - lastMouse.x) * 0.1, dy: (world.mouse.y - lastMouse.y) * 0.1 };
  }
  return lastMouse;
}
/** Input.GetAxis／GetAxisRaw：Input Manager 的預設軸（Horizontal、Vertical、Mouse X、Mouse Y、Mouse ScrollWheel） */
export function Input_GetAxisRaw(c: Ctx, axis: string): number {
  const world = w(c);
  const k = (code: string) => world.keysHeld.has(code);
  switch (axis) {
    case 'Horizontal':
      return (k('ArrowRight') || k('KeyD') ? 1 : 0) - (k('ArrowLeft') || k('KeyA') ? 1 : 0);
    case 'Vertical':
      return (k('ArrowUp') || k('KeyW') ? 1 : 0) - (k('ArrowDown') || k('KeyS') ? 1 : 0);
    case 'Mouse ScrollWheel':
      return world.mouse.scrollY * 0.1;
    case 'Mouse X':
      return mouseDelta(world).dx;
    case 'Mouse Y':
      return mouseDelta(world).dy;
    default:
      return 0;
  }
}
export const Input_GetAxis = Input_GetAxisRaw;
/** Input.GetButton：Input Manager 的預設按鈕（Submit = Enter／Space、Cancel = Escape、Fire1 = 左鍵／Ctrl…） */
const BUTTONS: Record<string, string[]> = { Submit: ['Enter', 'NumpadEnter', 'Space'], Cancel: ['Escape'], Fire1: ['ControlLeft', 'Mouse0'], Fire2: ['AltLeft', 'Mouse1'], Fire3: ['ShiftLeft', 'Mouse2'], Jump: ['Space'] };
function button(_world: World, name: string, f: (code: string) => boolean, mouse: (i: number) => boolean): boolean {
  return (BUTTONS[name] ?? []).some((code) => (code.startsWith('Mouse') ? mouse(Number(code.slice(5))) : f(code)));
}
export const Input_GetButton = (c: Ctx, n: string): boolean => button(w(c), n, (k) => w(c).keysHeld.has(k), (i) => !!w(c).mouse.buttons?.[i]);
export const Input_GetButtonDown = (c: Ctx, n: string): boolean => button(w(c), n, (k) => w(c).input.has(k), (i) => !!w(c).mouse.buttonsDown?.[i]);
export const Input_GetButtonUp = (c: Ctx, n: string): boolean => button(w(c), n, (k) => w(c).keysUp.has(k), (i) => !!w(c).mouse.buttonsUp?.[i]);

// ───────── Display（一個畫面：瀏覽器的視窗） ─────────

type DisplayJs = { $type: 'Display'; index: number };
const MAIN: DisplayJs = { $type: 'Display', index: 0 };
export const Display_get_displays = (_c: Ctx): DisplayJs[] => [MAIN];
export const Display_get_main = (_c: Ctx): DisplayJs => MAIN;
export const Display_get_renderingWidth = (c: Ctx): number => w(c).screen.w;
export const Display_get_renderingHeight = (c: Ctx): number => w(c).screen.h;
export const Display_get_systemWidth = (c: Ctx): number => (typeof screen !== 'undefined' ? Math.round(screen.width * (devicePixelRatio || 1)) : w(c).screen.w);
export const Display_get_systemHeight = (c: Ctx): number => (typeof screen !== 'undefined' ? Math.round(screen.height * (devicePixelRatio || 1)) : w(c).screen.h);
export const Display_get_active = (_c: Ctx): boolean => true;
export const Display_Activate$ = (_c: Ctx): void => undefined;
export const Display_RelativeMouseAt = (_c: Ctx, p: { x: number; y: number; z: number }): { x: number; y: number; z: number } => ({ x: p.x, y: p.y, z: 0 });

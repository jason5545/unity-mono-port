// 相容層：Unity 的數學與值型別（Mathf、Vector2／3／4、Vector2Int／3Int、Quaternion、Color、Color32、ColorUtility、Rect、RectOffset、
// Bounds、Matrix4x4、AnimationCurve、Keyframe、Gradient）。unity.ts 會 export * 這裡。
//
// 值型別是一般物件（{ x, y, z }），轉換器在要複製的地方寫 R.cloneData；這裡的函式一律回傳新的物件。
// 細節照 Unity（UnityCsReference 的 C# 原始碼）：
//   - Mathf.Round／RoundToInt 是銀行家捨入（Math.Round 的預設）；Mathf.Sign(0) 是 1；Mathf.Epsilon 是 float.Epsilon。
//   - Vector2／3 的 == 是近似相等（差的平方長度 < 1e-10）；normalized 在長度 ≤ 1e-5 時是零向量。
//   - Lerp 系列的 t 夾在 0～1（LerpUnclamped 不夾）。
//   - 尤拉角：Z、X、Y 的順序（three.js 的 'YXZ'），度數，讀回來是 0～360。
//   - Color.yellow 是 (1, 0.92156863, 0.015686275, 1)；Color → Color32 是 round(clamp01(c) × 255)。

import { Euler, Matrix4, Quaternion as TQ, Vector3 as TV3 } from 'three';
import type { Ctx } from './core';
import { evaluate as evalCurve, type Keyframe as CurveKey } from '../engine/curves';
import { roundEven } from './dotnetBcl';

type V2 = { x: number; y: number };
type V3 = { x: number; y: number; z: number };
type V4 = { x: number; y: number; z: number; w: number };
type Q = V4;
type C = { r: number; g: number; b: number; a: number };
type C32 = C & { $color32?: true };
type RectV = { x: number; y: number; width: number; height: number };

const v2 = (x: number, y: number): V2 => ({ x, y });
const v3 = (x: number, y: number, z: number): V3 => ({ x, y, z });
const col = (r: number, g: number, b: number, a: number): C => ({ r, g, b, a });
const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
const RAD2DEG = 57.29578;
const DEG2RAD = 0.017453292;

// ───────── Mathf ─────────

export const Mathf_get_PI = (_c: Ctx): number => Math.PI;
export const Mathf_get_Infinity = (_c: Ctx): number => Infinity;
export const Mathf_get_NegativeInfinity = (_c: Ctx): number => -Infinity;
export const Mathf_get_Epsilon = (_c: Ctx): number => 1.401298e-45;
export const Mathf_get_Deg2Rad = (_c: Ctx): number => DEG2RAD;
export const Mathf_get_Rad2Deg = (_c: Ctx): number => RAD2DEG;
export const Mathf_Abs$float = (_c: Ctx, v: number): number => Math.abs(v);
export const Mathf_Abs$int = Mathf_Abs$float;
export const Mathf_Max$float_float = (_c: Ctx, a: number, b: number): number => (a > b ? a : b);
export const Mathf_Max$int_int = Mathf_Max$float_float;
export const Mathf_Min$float_float = (_c: Ctx, a: number, b: number): number => (a < b ? a : b);
export const Mathf_Min$int_int = Mathf_Min$float_float;
export const Mathf_Max$Single_arr = (_c: Ctx, a: number[]): number => (a.length ? Math.max(...a) : 0);
export const Mathf_Max$Int32_arr = Mathf_Max$Single_arr;
export const Mathf_Min$Single_arr = (_c: Ctx, a: number[]): number => (a.length ? Math.min(...a) : 0);
export const Mathf_Min$Int32_arr = Mathf_Min$Single_arr;
export const Mathf_Clamp$float_float_float = (_c: Ctx, v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);
export const Mathf_Clamp$int_int_int = Mathf_Clamp$float_float_float;
export const Mathf_Clamp01 = (_c: Ctx, v: number): number => clamp01(v);
export const Mathf_Sign = (_c: Ctx, v: number): number => (v >= 0 ? 1 : -1);
export const Mathf_Round = (_c: Ctx, v: number): number => roundEven(v);
export const Mathf_RoundToInt = (_c: Ctx, v: number): number => roundEven(v) | 0;
export const Mathf_Floor = (_c: Ctx, v: number): number => Math.floor(v);
export const Mathf_FloorToInt = (_c: Ctx, v: number): number => Math.floor(v) | 0;
export const Mathf_Ceil = (_c: Ctx, v: number): number => Math.ceil(v);
export const Mathf_CeilToInt = (_c: Ctx, v: number): number => Math.ceil(v) | 0;
export const Mathf_Sqrt = (_c: Ctx, v: number): number => Math.sqrt(v);
export const Mathf_Pow = (_c: Ctx, a: number, b: number): number => Math.pow(a, b);
export const Mathf_Exp = (_c: Ctx, v: number): number => Math.exp(v);
export const Mathf_Log$float = (_c: Ctx, v: number): number => Math.log(v);
export const Mathf_Log$float_float = (_c: Ctx, v: number, b: number): number => Math.log(v) / Math.log(b);
export const Mathf_Log10 = (_c: Ctx, v: number): number => Math.log10(v);
export const Mathf_Sin = (_c: Ctx, v: number): number => Math.sin(v);
export const Mathf_Cos = (_c: Ctx, v: number): number => Math.cos(v);
export const Mathf_Tan = (_c: Ctx, v: number): number => Math.tan(v);
export const Mathf_Asin = (_c: Ctx, v: number): number => Math.asin(v);
export const Mathf_Acos = (_c: Ctx, v: number): number => Math.acos(v);
export const Mathf_Atan = (_c: Ctx, v: number): number => Math.atan(v);
export const Mathf_Atan2 = (_c: Ctx, y: number, x: number): number => Math.atan2(y, x);
export const Mathf_Approximately = (_c: Ctx, a: number, b: number): boolean => Math.abs(b - a) < Math.max(0.000001 * Math.max(Math.abs(a), Math.abs(b)), 1.401298e-45 * 8);
export const Mathf_Lerp = (_c: Ctx, a: number, b: number, t: number): number => a + (b - a) * clamp01(t);
export const Mathf_LerpUnclamped = (_c: Ctx, a: number, b: number, t: number): number => a + (b - a) * t;
export const Mathf_InverseLerp = (_c: Ctx, a: number, b: number, v: number): number => (a !== b ? clamp01((v - a) / (b - a)) : 0);
export function Mathf_Repeat(_c: Ctx, t: number, len: number): number {
  return Math.min(Math.max(t - Math.floor(t / len) * len, 0), len);
}
export function Mathf_PingPong(c: Ctx, t: number, len: number): number {
  t = Mathf_Repeat(c, t, len * 2);
  return len - Math.abs(t - len);
}
export function Mathf_SmoothStep(_c: Ctx, from: number, to: number, t: number): number {
  t = clamp01(t);
  t = -2 * t * t * t + 3 * t * t;
  return to * t + from * (1 - t);
}
export function Mathf_DeltaAngle(c: Ctx, a: number, b: number): number {
  let d = Mathf_Repeat(c, b - a, 360);
  if (d > 180) d -= 360;
  return d;
}
export function Mathf_LerpAngle(c: Ctx, a: number, b: number, t: number): number {
  let d = Mathf_Repeat(c, b - a, 360);
  if (d > 180) d -= 360;
  return a + d * clamp01(t);
}
export function Mathf_MoveTowards(_c: Ctx, cur: number, target: number, maxDelta: number): number {
  return Math.abs(target - cur) <= maxDelta ? target : cur + Math.sign(target - cur) * maxDelta;
}
/** Mathf.SmoothDamp（Game Programming Gems 4 的臨界阻尼彈簧，Unity 的實作）；currentVelocity 是 ref 盒子 */
export function Mathf_SmoothDamp$float_float_float_float_float_float(_c: Ctx, cur: number, target: number, vel: { v: number }, smoothTime: number, maxSpeed: number, dt: number): number {
  smoothTime = Math.max(0.0001, smoothTime);
  const omega = 2 / smoothTime;
  const x = omega * dt;
  const exp = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);
  let change = cur - target;
  const orig = target;
  const maxChange = maxSpeed * smoothTime;
  change = Math.min(Math.max(change, -maxChange), maxChange);
  target = cur - change;
  const temp = (vel.v + omega * change) * dt;
  vel.v = (vel.v - omega * temp) * exp;
  let out = target + (change + temp) * exp;
  if (orig - cur > 0 === out > orig) {
    out = orig;
    vel.v = (out - orig) / dt;
  }
  return out;
}
export const Mathf_SmoothDamp$float_float_float_float_float = (c: Ctx, cur: number, target: number, vel: { v: number }, st: number, maxSpeed: number): number =>
  Mathf_SmoothDamp$float_float_float_float_float_float(c, cur, target, vel, st, maxSpeed, c.w?.deltaTime ?? 0);
export const Mathf_SmoothDamp$float_float_float_float = (c: Ctx, cur: number, target: number, vel: { v: number }, st: number): number =>
  Mathf_SmoothDamp$float_float_float_float_float_float(c, cur, target, vel, st, Infinity, c.w?.deltaTime ?? 0);
export const Mathf_IsPowerOfTwo = (_c: Ctx, v: number): boolean => v > 0 && (v & (v - 1)) === 0;
export const Mathf_NextPowerOfTwo = (_c: Ctx, v: number): number => (v <= 0 ? 0 : 2 ** Math.ceil(Math.log2(v)));
export const Mathf_PerlinNoise = (_c: Ctx, x: number, y: number): number => perlin(x, y);
/** Mathf.PerlinNoise（Ken Perlin 的改良雜訊，結果在 0～1 附近；Unity 的排列表未查證，用經典的表） */
const P = [151, 160, 137, 91, 90, 15, 131, 13, 201, 95, 96, 53, 194, 233, 7, 225, 140, 36, 103, 30, 69, 142, 8, 99, 37, 240, 21, 10, 23, 190, 6, 148, 247, 120, 234, 75, 0, 26, 197, 62, 94, 252, 219, 203, 117, 35, 11, 32, 57, 177, 33, 88, 237, 149, 56, 87, 174, 20, 125, 136, 171, 168, 68, 175, 74, 165, 71, 134, 139, 48, 27, 166, 77, 146, 158, 231, 83, 111, 229, 122, 60, 211, 133, 230, 220, 105, 92, 41, 55, 46, 245, 40, 244, 102, 143, 54, 65, 25, 63, 161, 1, 216, 80, 73, 209, 76, 132, 187, 208, 89, 18, 169, 200, 196, 135, 130, 116, 188, 159, 86, 164, 100, 109, 198, 173, 186, 3, 64, 52, 217, 226, 250, 124, 123, 5, 202, 38, 147, 118, 126, 255, 82, 85, 212, 207, 206, 59, 227, 47, 16, 58, 17, 182, 189, 28, 42, 223, 183, 170, 213, 119, 248, 152, 2, 44, 154, 163, 70, 221, 153, 101, 155, 167, 43, 172, 9, 129, 22, 39, 253, 19, 98, 108, 110, 79, 113, 224, 232, 178, 185, 112, 104, 218, 246, 97, 228, 251, 34, 242, 193, 238, 210, 144, 12, 191, 179, 162, 241, 81, 51, 145, 235, 249, 14, 239, 107, 49, 192, 214, 31, 181, 199, 106, 157, 184, 84, 204, 176, 115, 121, 50, 45, 127, 4, 150, 254, 138, 236, 205, 93, 222, 114, 67, 29, 24, 72, 243, 141, 128, 195, 78, 66, 215, 61, 156, 180];
const PP = [...P, ...P];
function perlin(x: number, y: number): number {
  const fade = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);
  const grad = (h: number, a: number, b: number) => ((h & 1) === 0 ? a : -a) + ((h & 2) === 0 ? b : -b);
  const X = Math.floor(x) & 255;
  const Y = Math.floor(y) & 255;
  x -= Math.floor(x);
  y -= Math.floor(y);
  const u = fade(x);
  const v = fade(y);
  const A = PP[X] + Y;
  const B = PP[X + 1] + Y;
  const l = (a: number, b: number, t: number) => a + t * (b - a);
  const r = l(l(grad(PP[A], x, y), grad(PP[B], x - 1, y), u), l(grad(PP[A + 1], x, y - 1), grad(PP[B + 1], x - 1, y - 1), u), v);
  return (r + 1) / 2;
}

// ───────── Vector2 ─────────

export const new_Vector2$float_float = (_c: Ctx, x: number, y: number): V2 => v2(x, y);
export const Vector2_get_zero = (_c: Ctx): V2 => v2(0, 0);
export const Vector2_get_one = (_c: Ctx): V2 => v2(1, 1);
export const Vector2_get_up = (_c: Ctx): V2 => v2(0, 1);
export const Vector2_get_down = (_c: Ctx): V2 => v2(0, -1);
export const Vector2_get_left = (_c: Ctx): V2 => v2(-1, 0);
export const Vector2_get_right = (_c: Ctx): V2 => v2(1, 0);
export const Vector2_get_positiveInfinity = (_c: Ctx): V2 => v2(Infinity, Infinity);
export const Vector2_get_negativeInfinity = (_c: Ctx): V2 => v2(-Infinity, -Infinity);
export const Vector2_op_Addition = (_c: Ctx, a: V2, b: V2): V2 => v2(a.x + b.x, a.y + b.y);
export const Vector2_op_Subtraction = (_c: Ctx, a: V2, b: V2): V2 => v2(a.x - b.x, a.y - b.y);
export const Vector2_op_Multiply$Vector2_float = (_c: Ctx, a: V2, d: number): V2 => v2(a.x * d, a.y * d);
export const Vector2_op_Multiply$float_Vector2 = (_c: Ctx, d: number, a: V2): V2 => v2(a.x * d, a.y * d);
export const Vector2_op_Multiply$Vector2_Vector2 = (_c: Ctx, a: V2, b: V2): V2 => v2(a.x * b.x, a.y * b.y);
export const Vector2_op_Division$Vector2_float = (_c: Ctx, a: V2, d: number): V2 => v2(a.x / d, a.y / d);
export const Vector2_op_Division$Vector2_Vector2 = (_c: Ctx, a: V2, b: V2): V2 => v2(a.x / b.x, a.y / b.y);
export const Vector2_op_UnaryNegation = (_c: Ctx, a: V2): V2 => v2(-a.x, -a.y);
export const Vector2_op_Equality = (_c: Ctx, a: V2, b: V2): boolean => (a.x - b.x) ** 2 + (a.y - b.y) ** 2 < 1e-10;
export const Vector2_op_Inequality = (c: Ctx, a: V2, b: V2): boolean => !Vector2_op_Equality(c, a, b);
export const Vector2_Equals$Vector2 = (_c: Ctx, a: V2, b: V2): boolean => a.x === b.x && a.y === b.y;
export const Vector2_Equals$Object = (_c: Ctx, a: V2, b: V2 | null): boolean => !!b && a.x === b.x && a.y === b.y;
export const Vector2_op_Implicit$Vector2 = (_c: Ctx, a: V2): V3 => v3(a.x, a.y, 0);
export const Vector2_op_Implicit$Vector3 = (_c: Ctx, a: V3): V2 => v2(a.x, a.y);
export const Vector2_get_magnitude = (_c: Ctx, a: V2): number => Math.sqrt(a.x * a.x + a.y * a.y);
export const Vector2_get_sqrMagnitude = (_c: Ctx, a: V2): number => a.x * a.x + a.y * a.y;
export function Vector2_get_normalized(_c: Ctx, a: V2): V2 {
  const m = Math.sqrt(a.x * a.x + a.y * a.y);
  return m > 1e-5 ? v2(a.x / m, a.y / m) : v2(0, 0);
}
export function Vector2_Normalize(c: Ctx, a: V2): void {
  const n = Vector2_get_normalized(c, a);
  a.x = n.x;
  a.y = n.y;
}
export const Vector2_Dot = (_c: Ctx, a: V2, b: V2): number => a.x * b.x + a.y * b.y;
export const Vector2_Distance = (_c: Ctx, a: V2, b: V2): number => Math.hypot(a.x - b.x, a.y - b.y);
export const Vector2_Lerp = (_c: Ctx, a: V2, b: V2, t: number): V2 => {
  t = clamp01(t);
  return v2(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t);
};
export const Vector2_LerpUnclamped = (_c: Ctx, a: V2, b: V2, t: number): V2 => v2(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t);
export const Vector2_Scale$Vector2_Vector2 = (_c: Ctx, a: V2, b: V2): V2 => v2(a.x * b.x, a.y * b.y);
export function Vector2_Scale$Vector2(_c: Ctx, a: V2, b: V2): void {
  a.x *= b.x;
  a.y *= b.y;
}
export function Vector2_Angle(_c: Ctx, a: V2, b: V2): number {
  const d = Math.sqrt((a.x * a.x + a.y * a.y) * (b.x * b.x + b.y * b.y));
  if (d < 1e-15) return 0;
  return Math.acos(Math.min(Math.max((a.x * b.x + a.y * b.y) / d, -1), 1)) * RAD2DEG;
}
export function Vector2_SignedAngle(c: Ctx, a: V2, b: V2): number {
  return Vector2_Angle(c, a, b) * Math.sign(a.x * b.y - a.y * b.x);
}
export function Vector2_MoveTowards(_c: Ctx, a: V2, b: V2, maxDelta: number): V2 {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const d = Math.hypot(dx, dy);
  if (d === 0 || (maxDelta >= 0 && d <= maxDelta)) return v2(b.x, b.y);
  return v2(a.x + (dx / d) * maxDelta, a.y + (dy / d) * maxDelta);
}
export function Vector2_ClampMagnitude(_c: Ctx, a: V2, max: number): V2 {
  const m2 = a.x * a.x + a.y * a.y;
  if (m2 > max * max) {
    const m = Math.sqrt(m2);
    return v2((a.x / m) * max, (a.y / m) * max);
  }
  return v2(a.x, a.y);
}
export const Vector2_Min = (_c: Ctx, a: V2, b: V2): V2 => v2(Math.min(a.x, b.x), Math.min(a.y, b.y));
export const Vector2_Max = (_c: Ctx, a: V2, b: V2): V2 => v2(Math.max(a.x, b.x), Math.max(a.y, b.y));
export const Vector2_Perpendicular = (_c: Ctx, a: V2): V2 => v2(-a.y, a.x);
export const Vector2_get_Item = (_c: Ctx, a: V2, i: number): number => (i === 0 ? a.x : a.y);
export function Vector2_set_Item(_c: Ctx, a: V2, i: number, v: number): void {
  if (i === 0) a.x = v;
  else a.y = v;
}
export function Vector2_Set(_c: Ctx, a: V2, x: number, y: number): void {
  a.x = x;
  a.y = y;
}
export const Vector2_GetHashCode = (_c: Ctx, a: V2): number => (Math.fround(a.x) * 73856093) ^ (Math.fround(a.y) * 19349663);

// ───────── Vector3 ─────────

export const new_Vector3$float_float_float = (_c: Ctx, x: number, y: number, z: number): V3 => v3(x, y, z);
export const new_Vector3$float_float = (_c: Ctx, x: number, y: number): V3 => v3(x, y, 0);
export const Vector3_get_zero = (_c: Ctx): V3 => v3(0, 0, 0);
export const Vector3_get_one = (_c: Ctx): V3 => v3(1, 1, 1);
export const Vector3_get_up = (_c: Ctx): V3 => v3(0, 1, 0);
export const Vector3_get_down = (_c: Ctx): V3 => v3(0, -1, 0);
export const Vector3_get_left = (_c: Ctx): V3 => v3(-1, 0, 0);
export const Vector3_get_right = (_c: Ctx): V3 => v3(1, 0, 0);
export const Vector3_get_forward = (_c: Ctx): V3 => v3(0, 0, 1);
export const Vector3_get_back = (_c: Ctx): V3 => v3(0, 0, -1);
export const Vector3_get_positiveInfinity = (_c: Ctx): V3 => v3(Infinity, Infinity, Infinity);
export const Vector3_get_negativeInfinity = (_c: Ctx): V3 => v3(-Infinity, -Infinity, -Infinity);
export const Vector3_op_Addition = (_c: Ctx, a: V3, b: V3): V3 => v3(a.x + b.x, a.y + b.y, a.z + b.z);
export const Vector3_op_Subtraction = (_c: Ctx, a: V3, b: V3): V3 => v3(a.x - b.x, a.y - b.y, a.z - b.z);
export const Vector3_op_Multiply$Vector3_float = (_c: Ctx, a: V3, d: number): V3 => v3(a.x * d, a.y * d, a.z * d);
export const Vector3_op_Multiply$float_Vector3 = (_c: Ctx, d: number, a: V3): V3 => v3(a.x * d, a.y * d, a.z * d);
export const Vector3_op_Division = (_c: Ctx, a: V3, d: number): V3 => v3(a.x / d, a.y / d, a.z / d);
export const Vector3_op_Division$Vector3_float = Vector3_op_Division;
export const Vector3_op_UnaryNegation = (_c: Ctx, a: V3): V3 => v3(-a.x, -a.y, -a.z);
export const Vector3_op_Equality = (_c: Ctx, a: V3, b: V3): boolean => (a.x - b.x) ** 2 + (a.y - b.y) ** 2 + (a.z - b.z) ** 2 < 1e-10;
export const Vector3_op_Inequality = (c: Ctx, a: V3, b: V3): boolean => !Vector3_op_Equality(c, a, b);
export const Vector3_Equals$Vector3 = (_c: Ctx, a: V3, b: V3): boolean => a.x === b.x && a.y === b.y && a.z === b.z;
export const Vector3_Equals$Object = (_c: Ctx, a: V3, b: V3 | null): boolean => !!b && a.x === b.x && a.y === b.y && a.z === b.z;
export const Vector3_Dot = (_c: Ctx, a: V3, b: V3): number => a.x * b.x + a.y * b.y + a.z * b.z;
export const Vector3_Cross = (_c: Ctx, a: V3, b: V3): V3 => v3(a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x);
export const Vector3_get_sqrMagnitude = (_c: Ctx, a: V3): number => a.x * a.x + a.y * a.y + a.z * a.z;
export const Vector3_get_magnitude = (_c: Ctx, a: V3): number => Math.sqrt(a.x * a.x + a.y * a.y + a.z * a.z);
export const Vector3_Magnitude = Vector3_get_magnitude;
export const Vector3_SqrMagnitude = Vector3_get_sqrMagnitude;
export function Vector3_Normalize$Vector3(_c: Ctx, a: V3): V3 {
  const m = Math.sqrt(a.x * a.x + a.y * a.y + a.z * a.z);
  return m > 1e-5 ? v3(a.x / m, a.y / m, a.z / m) : v3(0, 0, 0);
}
export const Vector3_get_normalized = Vector3_Normalize$Vector3;
export function Vector3_Normalize$(c: Ctx, a: V3): void {
  const n = Vector3_Normalize$Vector3(c, a);
  a.x = n.x;
  a.y = n.y;
  a.z = n.z;
}
export const Vector3_Distance = (_c: Ctx, a: V3, b: V3): number => Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2 + (a.z - b.z) ** 2);
export const Vector3_Lerp = (_c: Ctx, a: V3, b: V3, t: number): V3 => {
  t = clamp01(t);
  return v3(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, a.z + (b.z - a.z) * t);
};
export const Vector3_LerpUnclamped = (_c: Ctx, a: V3, b: V3, t: number): V3 => v3(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, a.z + (b.z - a.z) * t);
export const Vector3_Scale$Vector3_Vector3 = (_c: Ctx, a: V3, b: V3): V3 => v3(a.x * b.x, a.y * b.y, a.z * b.z);
export function Vector3_Scale$Vector3(_c: Ctx, a: V3, b: V3): void {
  a.x *= b.x;
  a.y *= b.y;
  a.z *= b.z;
}
export function Vector3_Angle(_c: Ctx, a: V3, b: V3): number {
  const d = Math.sqrt((a.x * a.x + a.y * a.y + a.z * a.z) * (b.x * b.x + b.y * b.y + b.z * b.z));
  if (d < 1e-15) return 0;
  return Math.acos(Math.min(Math.max((a.x * b.x + a.y * b.y + a.z * b.z) / d, -1), 1)) * RAD2DEG;
}
export function Vector3_SignedAngle(c: Ctx, a: V3, b: V3, axis: V3): number {
  const cr = Vector3_Cross(c, a, b);
  return Vector3_Angle(c, a, b) * Math.sign(axis.x * cr.x + axis.y * cr.y + axis.z * cr.z);
}
export function Vector3_MoveTowards(_c: Ctx, a: V3, b: V3, maxDelta: number): V3 {
  const d = v3(b.x - a.x, b.y - a.y, b.z - a.z);
  const m = Math.sqrt(d.x * d.x + d.y * d.y + d.z * d.z);
  if (m === 0 || (maxDelta >= 0 && m <= maxDelta)) return v3(b.x, b.y, b.z);
  return v3(a.x + (d.x / m) * maxDelta, a.y + (d.y / m) * maxDelta, a.z + (d.z / m) * maxDelta);
}
export function Vector3_ClampMagnitude(_c: Ctx, a: V3, max: number): V3 {
  const m2 = a.x * a.x + a.y * a.y + a.z * a.z;
  if (m2 > max * max) {
    const m = Math.sqrt(m2);
    return v3((a.x / m) * max, (a.y / m) * max, (a.z / m) * max);
  }
  return v3(a.x, a.y, a.z);
}
export function Vector3_Project(_c: Ctx, a: V3, n: V3): V3 {
  const d = n.x * n.x + n.y * n.y + n.z * n.z;
  if (d < 1.401298e-45) return v3(0, 0, 0);
  const k = (a.x * n.x + a.y * n.y + a.z * n.z) / d;
  return v3(n.x * k, n.y * k, n.z * k);
}
export function Vector3_ProjectOnPlane(c: Ctx, a: V3, n: V3): V3 {
  const p = Vector3_Project(c, a, n);
  return v3(a.x - p.x, a.y - p.y, a.z - p.z);
}
export const Vector3_Min = (_c: Ctx, a: V3, b: V3): V3 => v3(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.min(a.z, b.z));
export const Vector3_Max = (_c: Ctx, a: V3, b: V3): V3 => v3(Math.max(a.x, b.x), Math.max(a.y, b.y), Math.max(a.z, b.z));
/** Vector3.SmoothDamp：每個分量照 Unity 的向量版（整體限速） */
export function Vector3_SmoothDamp$Vector3_Vector3_Vector3_float_float_float(_c: Ctx, cur: V3, target: V3, vel: { v: V3 }, smoothTime: number, maxSpeed: number, dt: number): V3 {
  smoothTime = Math.max(0.0001, smoothTime);
  const omega = 2 / smoothTime;
  const x = omega * dt;
  const exp = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);
  let ch = v3(cur.x - target.x, cur.y - target.y, cur.z - target.z);
  const orig = v3(target.x, target.y, target.z);
  const maxCh = maxSpeed * smoothTime;
  const sq = ch.x * ch.x + ch.y * ch.y + ch.z * ch.z;
  if (sq > maxCh * maxCh) {
    const m = Math.sqrt(sq);
    ch = v3((ch.x / m) * maxCh, (ch.y / m) * maxCh, (ch.z / m) * maxCh);
  }
  const t2 = v3(cur.x - ch.x, cur.y - ch.y, cur.z - ch.z);
  const temp = v3((vel.v.x + omega * ch.x) * dt, (vel.v.y + omega * ch.y) * dt, (vel.v.z + omega * ch.z) * dt);
  vel.v = v3((vel.v.x - omega * temp.x) * exp, (vel.v.y - omega * temp.y) * exp, (vel.v.z - omega * temp.z) * exp);
  let out = v3(t2.x + (ch.x + temp.x) * exp, t2.y + (ch.y + temp.y) * exp, t2.z + (ch.z + temp.z) * exp);
  const oc = v3(orig.x - cur.x, orig.y - cur.y, orig.z - cur.z);
  const ro = v3(out.x - orig.x, out.y - orig.y, out.z - orig.z);
  if (oc.x * ro.x + oc.y * ro.y + oc.z * ro.z > 0) {
    out = orig;
    vel.v = v3((out.x - orig.x) / dt, (out.y - orig.y) / dt, (out.z - orig.z) / dt);
  }
  return out;
}
export const Vector3_SmoothDamp$Vector3_Vector3_Vector3_float = (c: Ctx, cur: V3, target: V3, vel: { v: V3 }, st: number): V3 =>
  Vector3_SmoothDamp$Vector3_Vector3_Vector3_float_float_float(c, cur, target, vel, st, Infinity, c.w?.deltaTime ?? 0);
export const Vector3_SmoothDamp$Vector3_Vector3_Vector3_float_float = (c: Ctx, cur: V3, target: V3, vel: { v: V3 }, st: number, ms: number): V3 =>
  Vector3_SmoothDamp$Vector3_Vector3_Vector3_float_float_float(c, cur, target, vel, st, ms, c.w?.deltaTime ?? 0);
export function Vector3_Slerp(c: Ctx, a: V3, b: V3, t: number): V3 {
  t = clamp01(t);
  const ma = Vector3_get_magnitude(c, a);
  const mb = Vector3_get_magnitude(c, b);
  const na = Vector3_Normalize$Vector3(c, a);
  const nb = Vector3_Normalize$Vector3(c, b);
  const dot = Math.min(Math.max(na.x * nb.x + na.y * nb.y + na.z * nb.z, -1), 1);
  const th = Math.acos(dot) * t;
  const rel = Vector3_Normalize$Vector3(c, v3(nb.x - na.x * dot, nb.y - na.y * dot, nb.z - na.z * dot));
  const m = ma + (mb - ma) * t;
  return v3((na.x * Math.cos(th) + rel.x * Math.sin(th)) * m, (na.y * Math.cos(th) + rel.y * Math.sin(th)) * m, (na.z * Math.cos(th) + rel.z * Math.sin(th)) * m);
}
export const Vector3_get_Item = (_c: Ctx, a: V3, i: number): number => (i === 0 ? a.x : i === 1 ? a.y : a.z);
export function Vector3_set_Item(_c: Ctx, a: V3, i: number, v: number): void {
  if (i === 0) a.x = v;
  else if (i === 1) a.y = v;
  else a.z = v;
}
export function Vector3_Set(_c: Ctx, a: V3, x: number, y: number, z: number): void {
  a.x = x;
  a.y = y;
  a.z = z;
}
export const Vector3_GetHashCode = (_c: Ctx, a: V3): number => (Math.fround(a.x) * 73856093) ^ (Math.fround(a.y) * 19349663) ^ (Math.fround(a.z) * 83492791);

// ───────── Vector4、Vector2Int、Vector3Int ─────────

export const new_Vector4$float_float_float_float = (_c: Ctx, x: number, y: number, z: number, w: number): V4 => ({ x, y, z, w });
export const new_Vector4$float_float_float = (_c: Ctx, x: number, y: number, z: number): V4 => ({ x, y, z, w: 0 });
export const Vector4_get_zero = (_c: Ctx): V4 => ({ x: 0, y: 0, z: 0, w: 0 });
export const Vector4_get_one = (_c: Ctx): V4 => ({ x: 1, y: 1, z: 1, w: 1 });
export const Vector4_op_Addition = (_c: Ctx, a: V4, b: V4): V4 => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z, w: a.w + b.w });
export const Vector4_op_Subtraction = (_c: Ctx, a: V4, b: V4): V4 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z, w: a.w - b.w });
export const Vector4_op_Multiply$Vector4_float = (_c: Ctx, a: V4, d: number): V4 => ({ x: a.x * d, y: a.y * d, z: a.z * d, w: a.w * d });
export const Vector4_op_Multiply$float_Vector4 = (_c: Ctx, d: number, a: V4): V4 => ({ x: a.x * d, y: a.y * d, z: a.z * d, w: a.w * d });
export const Vector4_op_Division = (_c: Ctx, a: V4, d: number): V4 => ({ x: a.x / d, y: a.y / d, z: a.z / d, w: a.w / d });
export const Vector4_op_Equality = (_c: Ctx, a: V4, b: V4): boolean => (a.x - b.x) ** 2 + (a.y - b.y) ** 2 + (a.z - b.z) ** 2 + (a.w - b.w) ** 2 < 1e-10;
export const Vector4_op_Inequality = (c: Ctx, a: V4, b: V4): boolean => !Vector4_op_Equality(c, a, b);
export const Vector4_get_sqrMagnitude = (_c: Ctx, a: V4): number => a.x * a.x + a.y * a.y + a.z * a.z + a.w * a.w;
export const Vector4_get_magnitude = (c: Ctx, a: V4): number => Math.sqrt(Vector4_get_sqrMagnitude(c, a));
/** Vector4 ↔ Vector2／3 的隱含轉型（Vector4 的 op_Implicit 有三個方向） */
export const Vector4_op_Implicit$Vector3 = (_c: Ctx, a: V3): V4 => ({ x: a.x, y: a.y, z: a.z, w: 0 });
export const Vector4_op_Implicit$Vector2 = (_c: Ctx, a: V2): V4 => ({ x: a.x, y: a.y, z: 0, w: 0 });
export const Vector4_op_Implicit$Vector4 = (_c: Ctx, a: V4): V3 => v3(a.x, a.y, a.z);
export const Vector4_get_Item = (_c: Ctx, a: V4, i: number): number => [a.x, a.y, a.z, a.w][i];
export function Vector4_set_Item(_c: Ctx, a: V4, i: number, v: number): void {
  if (i === 0) a.x = v;
  else if (i === 1) a.y = v;
  else if (i === 2) a.z = v;
  else a.w = v;
}
export const Vector4_Lerp = (_c: Ctx, a: V4, b: V4, t: number): V4 => {
  t = clamp01(t);
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t, w: a.w + (b.w - a.w) * t };
};
export const Vector4_Dot = (_c: Ctx, a: V4, b: V4): number => a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w;
export const new_Vector2Int$int_int = (_c: Ctx, x: number, y: number): V2 => v2(x | 0, y | 0);
export const Vector2Int_get_x = (_c: Ctx, a: V2): number => a.x;
export const Vector2Int_get_y = (_c: Ctx, a: V2): number => a.y;
export const Vector2Int_set_x = (_c: Ctx, a: V2, v: number): void => void (a.x = v);
export const Vector2Int_set_y = (_c: Ctx, a: V2, v: number): void => void (a.y = v);
export const Vector2Int_get_zero = (_c: Ctx): V2 => v2(0, 0);
export const Vector2Int_get_one = (_c: Ctx): V2 => v2(1, 1);
export const Vector2Int_op_Equality = (_c: Ctx, a: V2, b: V2): boolean => a.x === b.x && a.y === b.y;
export const Vector2Int_op_Inequality = (_c: Ctx, a: V2, b: V2): boolean => a.x !== b.x || a.y !== b.y;
export const Vector2Int_Equals$Vector2Int = Vector2Int_op_Equality;
export const Vector2Int_op_Addition = (_c: Ctx, a: V2, b: V2): V2 => v2(a.x + b.x, a.y + b.y);
export const Vector2Int_op_Subtraction = (_c: Ctx, a: V2, b: V2): V2 => v2(a.x - b.x, a.y - b.y);
export const Vector2Int_op_Implicit$Vector2Int = (_c: Ctx, a: V2): V2 => v2(a.x, a.y);
export const Vector2Int_GetHashCode = (_c: Ctx, a: V2): number => (a.x ^ (a.y << 2)) | 0;
export const new_Vector3Int$int_int_int = (_c: Ctx, x: number, y: number, z: number): V3 => v3(x | 0, y | 0, z | 0);
export const Vector3Int_get_x = (_c: Ctx, a: V3): number => a.x;
export const Vector3Int_get_y = (_c: Ctx, a: V3): number => a.y;
export const Vector3Int_get_z = (_c: Ctx, a: V3): number => a.z;
export const Vector3Int_op_Equality = (_c: Ctx, a: V3, b: V3): boolean => a.x === b.x && a.y === b.y && a.z === b.z;
export const Vector3Int_op_Inequality = (_c: Ctx, a: V3, b: V3): boolean => !(a.x === b.x && a.y === b.y && a.z === b.z);

// ───────── Quaternion ─────────

const tq = (q: Q): TQ => new TQ(q.x, q.y, q.z, q.w);
const fq = (q: TQ): Q => ({ x: q.x, y: q.y, z: q.z, w: q.w });
export const new_Quaternion$float_float_float_float = (_c: Ctx, x: number, y: number, z: number, w: number): Q => ({ x, y, z, w });
export const Quaternion_get_identity = (_c: Ctx): Q => ({ x: 0, y: 0, z: 0, w: 1 });
export function Quaternion_Euler$float_float_float(_c: Ctx, x: number, y: number, z: number): Q {
  return fq(new TQ().setFromEuler(new Euler(x * DEG2RAD, y * DEG2RAD, z * DEG2RAD, 'YXZ')));
}
export const Quaternion_Euler$Vector3 = (c: Ctx, e: V3): Q => Quaternion_Euler$float_float_float(c, e.x, e.y, e.z);
export function Quaternion_get_eulerAngles(_c: Ctx, q: Q): V3 {
  const e = new Euler().setFromQuaternion(tq(q).normalize(), 'YXZ');
  const n = (d: number) => ((d % 360) + 360) % 360;
  return v3(n(e.x * RAD2DEG), n(e.y * RAD2DEG), n(e.z * RAD2DEG));
}
export function Quaternion_set_eulerAngles(c: Ctx, q: Q, e: V3): void {
  Object.assign(q, Quaternion_Euler$Vector3(c, e));
}
export const Quaternion_AngleAxis = (_c: Ctx, angle: number, axis: V3): Q => fq(new TQ().setFromAxisAngle(new TV3(axis.x, axis.y, axis.z).normalize(), angle * DEG2RAD));
export const Quaternion_op_Multiply$Quaternion_Quaternion = (_c: Ctx, a: Q, b: Q): Q => fq(tq(a).multiply(tq(b)));
export function Quaternion_op_Multiply$Quaternion_Vector3(_c: Ctx, q: Q, v: V3): V3 {
  const r = new TV3(v.x, v.y, v.z).applyQuaternion(tq(q));
  return v3(r.x, r.y, r.z);
}
export const Quaternion_Inverse = (_c: Ctx, q: Q): Q => fq(tq(q).invert());
export const Quaternion_Dot = (_c: Ctx, a: Q, b: Q): number => a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w;
export const Quaternion_op_Equality = (c: Ctx, a: Q, b: Q): boolean => Quaternion_Dot(c, a, b) > 0.999999;
export const Quaternion_op_Inequality = (c: Ctx, a: Q, b: Q): boolean => !Quaternion_op_Equality(c, a, b);
export function Quaternion_Angle(c: Ctx, a: Q, b: Q): number {
  const d = Math.min(Math.abs(Quaternion_Dot(c, a, b)), 1);
  return d > 0.999999 ? 0 : Math.acos(d) * 2 * RAD2DEG;
}
export const Quaternion_Slerp = (_c: Ctx, a: Q, b: Q, t: number): Q => fq(tq(a).slerp(tq(b), clamp01(t)));
export const Quaternion_SlerpUnclamped = (_c: Ctx, a: Q, b: Q, t: number): Q => fq(tq(a).slerp(tq(b), t));
export function Quaternion_Lerp(_c: Ctx, a: Q, b: Q, t: number): Q {
  t = clamp01(t);
  const s = a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w < 0 ? -1 : 1;
  return fq(new TQ(a.x + (s * b.x - a.x) * t, a.y + (s * b.y - a.y) * t, a.z + (s * b.z - a.z) * t, a.w + (s * b.w - a.w) * t).normalize());
}
export function Quaternion_RotateTowards(c: Ctx, a: Q, b: Q, maxDeg: number): Q {
  const ang = Quaternion_Angle(c, a, b);
  return ang === 0 ? { ...b } : Quaternion_SlerpUnclamped(c, a, b, Math.min(1, maxDeg / ang));
}
/** LookRotation：forward 對到 +z、up 對到 +y（左手系）；用 three 的 lookAt 取旋轉矩陣再換成四元數 */
export function Quaternion_LookRotation$Vector3_Vector3(_c: Ctx, fwd: V3, up: V3): Q {
  const f = new TV3(fwd.x, fwd.y, fwd.z).normalize();
  if (f.lengthSq() === 0) return { x: 0, y: 0, z: 0, w: 1 };
  const r = new TV3(up.x, up.y, up.z).cross(f).normalize();
  const u = f.clone().cross(r);
  const m = new Matrix4().makeBasis(r, u, f);
  return fq(new TQ().setFromRotationMatrix(m));
}
export const Quaternion_LookRotation$Vector3 = (c: Ctx, f: V3): Q => Quaternion_LookRotation$Vector3_Vector3(c, f, v3(0, 1, 0));
export const Quaternion_get_normalized = (_c: Ctx, q: Q): Q => fq(tq(q).normalize());
export const Quaternion_Normalize$Quaternion = Quaternion_get_normalized;
export function Quaternion_ToAngleAxis(_c: Ctx, q: Q, angle: (v: number) => void, axis: (v: V3) => void): void {
  const n = tq(q).normalize();
  const a = 2 * Math.acos(Math.min(1, Math.abs(n.w)));
  const s = Math.sqrt(1 - n.w * n.w);
  angle(a * RAD2DEG);
  axis(s < 1e-6 ? v3(1, 0, 0) : v3(n.x / s, n.y / s, n.z / s));
}
export const Quaternion_FromToRotation = (_c: Ctx, a: V3, b: V3): Q => fq(new TQ().setFromUnitVectors(new TV3(a.x, a.y, a.z).normalize(), new TV3(b.x, b.y, b.z).normalize()));

// ───────── Color、Color32、ColorUtility ─────────

export const new_Color$float_float_float_float = (_c: Ctx, r: number, g: number, b: number, a: number): C => col(r, g, b, a);
export const new_Color$float_float_float = (_c: Ctx, r: number, g: number, b: number): C => col(r, g, b, 1);
export const Color_get_white = (_c: Ctx): C => col(1, 1, 1, 1);
export const Color_get_black = (_c: Ctx): C => col(0, 0, 0, 1);
export const Color_get_clear = (_c: Ctx): C => col(0, 0, 0, 0);
export const Color_get_red = (_c: Ctx): C => col(1, 0, 0, 1);
export const Color_get_green = (_c: Ctx): C => col(0, 1, 0, 1);
export const Color_get_blue = (_c: Ctx): C => col(0, 0, 1, 1);
export const Color_get_yellow = (_c: Ctx): C => col(1, 0.92156863, 0.015686275, 1);
export const Color_get_cyan = (_c: Ctx): C => col(0, 1, 1, 1);
export const Color_get_magenta = (_c: Ctx): C => col(1, 0, 1, 1);
export const Color_get_gray = (_c: Ctx): C => col(0.5, 0.5, 0.5, 1);
export const Color_get_grey = Color_get_gray;
export const Color_op_Multiply$Color_float = (_c: Ctx, a: C, d: number): C => col(a.r * d, a.g * d, a.b * d, a.a * d);
export const Color_op_Multiply$float_Color = (_c: Ctx, d: number, a: C): C => col(a.r * d, a.g * d, a.b * d, a.a * d);
export const Color_op_Multiply$Color_Color = (_c: Ctx, a: C, b: C): C => col(a.r * b.r, a.g * b.g, a.b * b.b, a.a * b.a);
export const Color_op_Division = (_c: Ctx, a: C, d: number): C => col(a.r / d, a.g / d, a.b / d, a.a / d);
export const Color_op_Addition = (_c: Ctx, a: C, b: C): C => col(a.r + b.r, a.g + b.g, a.b + b.b, a.a + b.a);
export const Color_op_Subtraction = (_c: Ctx, a: C, b: C): C => col(a.r - b.r, a.g - b.g, a.b - b.b, a.a - b.a);
export const Color_op_Equality = (_c: Ctx, a: C, b: C): boolean => (a.r - b.r) ** 2 + (a.g - b.g) ** 2 + (a.b - b.b) ** 2 + (a.a - b.a) ** 2 < 1e-10;
export const Color_op_Inequality = (c: Ctx, a: C, b: C): boolean => !Color_op_Equality(c, a, b);
export const Color_Equals$Color = (_c: Ctx, a: C, b: C): boolean => a.r === b.r && a.g === b.g && a.b === b.b && a.a === b.a;
export const Color_Lerp = (_c: Ctx, a: C, b: C, t: number): C => {
  t = clamp01(t);
  return col(a.r + (b.r - a.r) * t, a.g + (b.g - a.g) * t, a.b + (b.b - a.b) * t, a.a + (b.a - a.a) * t);
};
export const Color_LerpUnclamped = (_c: Ctx, a: C, b: C, t: number): C => col(a.r + (b.r - a.r) * t, a.g + (b.g - a.g) * t, a.b + (b.b - a.b) * t, a.a + (b.a - a.a) * t);
export const Color_op_Implicit$Color = (_c: Ctx, a: C): V4 => ({ x: a.r, y: a.g, z: a.b, w: a.a });
export const Color_op_Implicit$Vector4 = (_c: Ctx, v: V4): C => col(v.x, v.y, v.z, v.w);
export const Color_get_maxColorComponent = (_c: Ctx, a: C): number => Math.max(a.r, a.g, a.b);
export const Color_get_grayscale = (_c: Ctx, a: C): number => 0.299 * a.r + 0.587 * a.g + 0.114 * a.b;
const toLin = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
const toGam = (v: number) => (v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055);
export const Color_get_linear = (_c: Ctx, a: C): C => col(toLin(a.r), toLin(a.g), toLin(a.b), a.a);
export const Color_get_gamma = (_c: Ctx, a: C): C => col(toGam(a.r), toGam(a.g), toGam(a.b), a.a);
export const Color_get_Item = (_c: Ctx, a: C, i: number): number => [a.r, a.g, a.b, a.a][i];
export function Color_RGBToHSV(_c: Ctx, a: C, h: (v: number) => void, s: (v: number) => void, v: (v: number) => void): void {
  const max = Math.max(a.r, a.g, a.b);
  const min = Math.min(a.r, a.g, a.b);
  const d = max - min;
  let hh = 0;
  if (d > 0) {
    if (max === a.r) hh = ((a.g - a.b) / d) % 6;
    else if (max === a.g) hh = (a.b - a.r) / d + 2;
    else hh = (a.r - a.g) / d + 4;
    hh /= 6;
    if (hh < 0) hh += 1;
  }
  h(hh);
  s(max === 0 ? 0 : d / max);
  v(max);
}
export function Color_HSVToRGB$float_float_float(_c: Ctx, h: number, s: number, v: number): C {
  const i = Math.floor(h * 6);
  const f = h * 6 - i;
  const p = v * (1 - s);
  const q = v * (1 - f * s);
  const t = v * (1 - (1 - f) * s);
  const [r, g, b] = [[v, t, p], [q, v, p], [p, v, t], [p, q, v], [t, p, v], [v, p, q]][((i % 6) + 6) % 6];
  return col(r, g, b, 1);
}
export const new_Color32$Byte_Byte_Byte_Byte = (_c: Ctx, r: number, g: number, b: number, a: number): C32 => ({ r, g, b, a, $color32: true });
/** Color32 → Color：除以 255 */
export const Color32_op_Implicit$Color32 = (_c: Ctx, v: C): C => col(v.r / 255, v.g / 255, v.b / 255, v.a / 255);
/** Color → Color32：round(clamp01(c) × 255) */
export const Color32_op_Implicit$Color = (_c: Ctx, v: C): C32 => ({ r: roundEven(clamp01(v.r) * 255), g: roundEven(clamp01(v.g) * 255), b: roundEven(clamp01(v.b) * 255), a: roundEven(clamp01(v.a) * 255), $color32: true });
export const Color32_get_r = (_c: Ctx, v: C): number => v.r;
export const Color32_get_g = (_c: Ctx, v: C): number => v.g;
export const Color32_get_b = (_c: Ctx, v: C): number => v.b;
export const Color32_get_a = (_c: Ctx, v: C): number => v.a;
export const Color32_set_r = (_c: Ctx, v: C, x: number): void => void (v.r = x);
export const Color32_set_g = (_c: Ctx, v: C, x: number): void => void (v.g = x);
export const Color32_set_b = (_c: Ctx, v: C, x: number): void => void (v.b = x);
export const Color32_set_a = (_c: Ctx, v: C, x: number): void => void (v.a = x);
export const Color32_Lerp = (_c: Ctx, a: C, b: C, t: number): C32 => {
  t = clamp01(t);
  return { r: Math.trunc(a.r + (b.r - a.r) * t), g: Math.trunc(a.g + (b.g - a.g) * t), b: Math.trunc(a.b + (b.b - a.b) * t), a: Math.trunc(a.a + (b.a - a.a) * t), $color32: true };
};
/** Color32.LerpUnclamped（UnityCsReference Color32.cs:71-79）：t 不夾，(byte) 轉型：截掉小數再取低 8 位（超出 0–255 會繞回，unchecked） */
export const Color32_LerpUnclamped = (_c: Ctx, a: C, b: C, t: number): C32 => {
  const u8 = (x: number) => Math.trunc(x) & 0xff;
  return { r: u8(a.r + (b.r - a.r) * t), g: u8(a.g + (b.g - a.g) * t), b: u8(a.b + (b.b - a.b) * t), a: u8(a.a + (b.a - a.a) * t), $color32: true };
};
const hex2 = (v: number) => v.toString(16).toUpperCase().padStart(2, '0');
export const ColorUtility_ToHtmlStringRGB = (c: Ctx, v: C): string => {
  const x = Color32_op_Implicit$Color(c, v);
  return hex2(x.r) + hex2(x.g) + hex2(x.b);
};
export const ColorUtility_ToHtmlStringRGBA = (c: Ctx, v: C): string => {
  const x = Color32_op_Implicit$Color(c, v);
  return hex2(x.r) + hex2(x.g) + hex2(x.b) + hex2(x.a);
};
const NAMED: Record<string, string> = { red: 'ff0000ff', cyan: '00ffffff', blue: '0000ffff', darkblue: '0000a0ff', lightblue: 'add8e6ff', purple: '800080ff', yellow: 'ffff00ff', lime: '00ff00ff', fuchsia: 'ff00ffff', white: 'ffffffff', silver: 'c0c0c0ff', grey: '808080ff', gray: '808080ff', black: '000000ff', orange: 'ffa500ff', brown: 'a52a2aff', maroon: '800000ff', green: '008000ff', olive: '808000ff', navy: '000080ff', teal: '008080ff', aqua: '00ffffff', magenta: 'ff00ffff' };
/** ColorUtility.TryParseHtmlString：#RGB、#RGBA、#RRGGBB、#RRGGBBAA 與 Unity 認得的顏色名 */
export function ColorUtility_TryParseHtmlString(_c: Ctx, s: string, out: (v: C) => void): boolean {
  let h = (s ?? '').trim().toLowerCase();
  if (NAMED[h]) h = `#${NAMED[h]}`;
  const m = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/.exec(h);
  if (!m) {
    out(col(0, 0, 0, 0));
    return false;
  }
  let x = m[1];
  if (x.length <= 4) x = [...x].map((ch) => ch + ch).join('');
  if (x.length === 6) x += 'ff';
  const n = (i: number) => parseInt(x.slice(i, i + 2), 16) / 255;
  out(col(n(0), n(2), n(4), n(6)));
  return true;
}

// ───────── Rect、RectOffset ─────────

export const new_Rect$float_float_float_float = (_c: Ctx, x: number, y: number, width: number, height: number): RectV => ({ x, y, width, height });
export const new_Rect$Vector2_Vector2 = (_c: Ctx, p: V2, s: V2): RectV => ({ x: p.x, y: p.y, width: s.x, height: s.y });
export const new_Rect$ = (_c: Ctx): RectV => ({ x: 0, y: 0, width: 0, height: 0 });
export const new_Rect$Rect = (_c: Ctx, r: RectV): RectV => ({ ...r });
export const Rect_get_zero = (_c: Ctx): RectV => ({ x: 0, y: 0, width: 0, height: 0 });
export const Rect_get_x = (_c: Ctx, r: RectV): number => r.x;
export const Rect_get_y = (_c: Ctx, r: RectV): number => r.y;
export const Rect_get_width = (_c: Ctx, r: RectV): number => r.width;
export const Rect_get_height = (_c: Ctx, r: RectV): number => r.height;
export const Rect_set_x = (_c: Ctx, r: RectV, v: number): void => void (r.x = v);
export const Rect_set_y = (_c: Ctx, r: RectV, v: number): void => void (r.y = v);
export const Rect_set_width = (_c: Ctx, r: RectV, v: number): void => void (r.width = v);
export const Rect_set_height = (_c: Ctx, r: RectV, v: number): void => void (r.height = v);
export const Rect_get_xMin = (_c: Ctx, r: RectV): number => r.x;
export const Rect_get_yMin = (_c: Ctx, r: RectV): number => r.y;
export const Rect_get_xMax = (_c: Ctx, r: RectV): number => r.x + r.width;
export const Rect_get_yMax = (_c: Ctx, r: RectV): number => r.y + r.height;
export function Rect_set_xMin(_c: Ctx, r: RectV, v: number): void {
  const xmax = r.x + r.width;
  r.x = v;
  r.width = xmax - v;
}
export function Rect_set_yMin(_c: Ctx, r: RectV, v: number): void {
  const ymax = r.y + r.height;
  r.y = v;
  r.height = ymax - v;
}
export const Rect_set_xMax = (_c: Ctx, r: RectV, v: number): void => void (r.width = v - r.x);
export const Rect_set_yMax = (_c: Ctx, r: RectV, v: number): void => void (r.height = v - r.y);
export const Rect_get_position = (_c: Ctx, r: RectV): V2 => v2(r.x, r.y);
export const Rect_set_position = (_c: Ctx, r: RectV, p: V2): void => void ((r.x = p.x), (r.y = p.y));
export const Rect_get_size = (_c: Ctx, r: RectV): V2 => v2(r.width, r.height);
export const Rect_set_size = (_c: Ctx, r: RectV, s: V2): void => void ((r.width = s.x), (r.height = s.y));
export const Rect_get_center = (_c: Ctx, r: RectV): V2 => v2(r.x + r.width / 2, r.y + r.height / 2);
export const Rect_set_center = (_c: Ctx, r: RectV, p: V2): void => void ((r.x = p.x - r.width / 2), (r.y = p.y - r.height / 2));
export const Rect_get_min = (_c: Ctx, r: RectV): V2 => v2(r.x, r.y);
export const Rect_get_max = (_c: Ctx, r: RectV): V2 => v2(r.x + r.width, r.y + r.height);
export function Rect_Contains$Vector2(_c: Ctx, r: RectV, p: V2): boolean {
  return p.x >= Math.min(r.x, r.x + r.width) && p.x < Math.max(r.x, r.x + r.width) && p.y >= Math.min(r.y, r.y + r.height) && p.y < Math.max(r.y, r.y + r.height);
}
export const Rect_Contains$Vector3 = Rect_Contains$Vector2;
export function Rect_Overlaps$Rect(_c: Ctx, a: RectV, b: RectV): boolean {
  return b.x + b.width > a.x && b.x < a.x + a.width && b.y + b.height > a.y && b.y < a.y + a.height;
}
export const Rect_op_Equality = (_c: Ctx, a: RectV, b: RectV): boolean => a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
export const Rect_op_Inequality = (c: Ctx, a: RectV, b: RectV): boolean => !Rect_op_Equality(c, a, b);
export const Rect_MinMaxRect = (_c: Ctx, x0: number, y0: number, x1: number, y1: number): RectV => ({ x: x0, y: y0, width: x1 - x0, height: y1 - y0 });
export const Rect_NormalizedToPoint = (_c: Ctx, r: RectV, n: V2): V2 => v2(r.x + r.width * n.x, r.y + r.height * n.y);
export const Rect_PointToNormalized = (_c: Ctx, r: RectV, p: V2): V2 => v2(r.width ? clamp01((p.x - r.x) / r.width) : 0, r.height ? clamp01((p.y - r.y) / r.height) : 0);
/** RectOffset：存檔是 { m_Left, m_Right, m_Top, m_Bottom } */
type RO = { m_Left: number; m_Right: number; m_Top: number; m_Bottom: number };
export const new_RectOffset$ = (_c: Ctx): RO => ({ m_Left: 0, m_Right: 0, m_Top: 0, m_Bottom: 0 });
export const new_RectOffset$int_int_int_int = (_c: Ctx, l: number, r: number, t: number, b: number): RO => ({ m_Left: l, m_Right: r, m_Top: t, m_Bottom: b });
export const RectOffset_get_left = (_c: Ctx, o: RO): number => o.m_Left;
export const RectOffset_get_right = (_c: Ctx, o: RO): number => o.m_Right;
export const RectOffset_get_top = (_c: Ctx, o: RO): number => o.m_Top;
export const RectOffset_get_bottom = (_c: Ctx, o: RO): number => o.m_Bottom;
export const RectOffset_get_horizontal = (_c: Ctx, o: RO): number => o.m_Left + o.m_Right;
export const RectOffset_get_vertical = (_c: Ctx, o: RO): number => o.m_Top + o.m_Bottom;
export const RectOffset_set_left = (_c: Ctx, o: RO, v: number): void => void (o.m_Left = v);
export const RectOffset_set_right = (_c: Ctx, o: RO, v: number): void => void (o.m_Right = v);
export const RectOffset_set_top = (_c: Ctx, o: RO, v: number): void => void (o.m_Top = v);
export const RectOffset_set_bottom = (_c: Ctx, o: RO, v: number): void => void (o.m_Bottom = v);

// ───────── Bounds ─────────

type B = { center: V3; extents: V3 };
export const new_Bounds$Vector3_Vector3 = (_c: Ctx, center: V3, size: V3): B => ({ center: { ...center }, extents: v3(size.x / 2, size.y / 2, size.z / 2) });
export const Bounds_get_center = (_c: Ctx, b: B): V3 => ({ ...b.center });
export const Bounds_set_center = (_c: Ctx, b: B, v: V3): void => void (b.center = { ...v });
export const Bounds_get_extents = (_c: Ctx, b: B): V3 => ({ ...b.extents });
export const Bounds_set_extents = (_c: Ctx, b: B, v: V3): void => void (b.extents = { ...v });
export const Bounds_get_size = (_c: Ctx, b: B): V3 => v3(b.extents.x * 2, b.extents.y * 2, b.extents.z * 2);
export const Bounds_set_size = (_c: Ctx, b: B, s: V3): void => void (b.extents = v3(s.x / 2, s.y / 2, s.z / 2));
export const Bounds_get_min = (_c: Ctx, b: B): V3 => v3(b.center.x - b.extents.x, b.center.y - b.extents.y, b.center.z - b.extents.z);
export const Bounds_get_max = (_c: Ctx, b: B): V3 => v3(b.center.x + b.extents.x, b.center.y + b.extents.y, b.center.z + b.extents.z);
export function Bounds_SetMinMax(_c: Ctx, b: B, mn: V3, mx: V3): void {
  b.extents = v3((mx.x - mn.x) / 2, (mx.y - mn.y) / 2, (mx.z - mn.z) / 2);
  b.center = v3(mn.x + b.extents.x, mn.y + b.extents.y, mn.z + b.extents.z);
}
export function Bounds_Encapsulate$Vector3(c: Ctx, b: B, p: V3): void {
  const mn = Bounds_get_min(c, b);
  const mx = Bounds_get_max(c, b);
  Bounds_SetMinMax(c, b, v3(Math.min(mn.x, p.x), Math.min(mn.y, p.y), Math.min(mn.z, p.z)), v3(Math.max(mx.x, p.x), Math.max(mx.y, p.y), Math.max(mx.z, p.z)));
}
export function Bounds_Encapsulate$Bounds(c: Ctx, b: B, o: B): void {
  Bounds_Encapsulate$Vector3(c, b, Bounds_get_min(c, o));
  Bounds_Encapsulate$Vector3(c, b, Bounds_get_max(c, o));
}
export function Bounds_Contains(c: Ctx, b: B, p: V3): boolean {
  const mn = Bounds_get_min(c, b);
  const mx = Bounds_get_max(c, b);
  return p.x >= mn.x && p.x <= mx.x && p.y >= mn.y && p.y <= mx.y && p.z >= mn.z && p.z <= mx.z;
}
export function Bounds_Intersects(c: Ctx, a: B, b: B): boolean {
  const amn = Bounds_get_min(c, a);
  const amx = Bounds_get_max(c, a);
  const bmn = Bounds_get_min(c, b);
  const bmx = Bounds_get_max(c, b);
  return amn.x <= bmx.x && amx.x >= bmn.x && amn.y <= bmx.y && amx.y >= bmn.y && amn.z <= bmx.z && amx.z >= bmn.z;
}
export function Bounds_Expand$float(_c: Ctx, b: B, amount: number): void {
  b.extents = v3(b.extents.x + amount / 2, b.extents.y + amount / 2, b.extents.z + amount / 2);
}

// ───────── Matrix4x4（m<列><行>） ─────────

type M = Record<string, number>;
function fromThree(m: Matrix4): M {
  const e = m.elements;
  const out: M = {};
  for (let r = 0; r < 4; r++) for (let c2 = 0; c2 < 4; c2++) out[`m${r}${c2}`] = e[c2 * 4 + r];
  return out;
}
function toThree(m: M): Matrix4 {
  const t = new Matrix4();
  const e = t.elements;
  for (let r = 0; r < 4; r++) for (let c2 = 0; c2 < 4; c2++) e[c2 * 4 + r] = m[`m${r}${c2}`] ?? 0;
  return t;
}
export const Matrix4x4_get_identity = (_c: Ctx): M => fromThree(new Matrix4());
export const Matrix4x4_get_zero = (_c: Ctx): M => fromThree(new Matrix4().set(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0));
export const Matrix4x4_TRS = (_c: Ctx, p: V3, q: Q, s: V3): M => fromThree(new Matrix4().compose(new TV3(p.x, p.y, p.z), tq(q), new TV3(s.x, s.y, s.z)));
export const Matrix4x4_Translate = (_c: Ctx, p: V3): M => fromThree(new Matrix4().makeTranslation(p.x, p.y, p.z));
export const Matrix4x4_Scale = (_c: Ctx, s: V3): M => fromThree(new Matrix4().makeScale(s.x, s.y, s.z));
export const Matrix4x4_Rotate = (_c: Ctx, q: Q): M => fromThree(new Matrix4().makeRotationFromQuaternion(tq(q)));
export const Matrix4x4_op_Multiply$Matrix4x4_Matrix4x4 = (_c: Ctx, a: M, b: M): M => fromThree(toThree(a).multiply(toThree(b)));
export function Matrix4x4_op_Multiply$Matrix4x4_Vector4(_c: Ctx, m: M, v: V4): V4 {
  return {
    x: m.m00 * v.x + m.m01 * v.y + m.m02 * v.z + m.m03 * v.w,
    y: m.m10 * v.x + m.m11 * v.y + m.m12 * v.z + m.m13 * v.w,
    z: m.m20 * v.x + m.m21 * v.y + m.m22 * v.z + m.m23 * v.w,
    w: m.m30 * v.x + m.m31 * v.y + m.m32 * v.z + m.m33 * v.w,
  };
}
export function Matrix4x4_MultiplyPoint(_c: Ctx, m: M, p: V3): V3 {
  const x = m.m00 * p.x + m.m01 * p.y + m.m02 * p.z + m.m03;
  const y = m.m10 * p.x + m.m11 * p.y + m.m12 * p.z + m.m13;
  const z = m.m20 * p.x + m.m21 * p.y + m.m22 * p.z + m.m23;
  const w = 1 / (m.m30 * p.x + m.m31 * p.y + m.m32 * p.z + m.m33);
  return v3(x * w, y * w, z * w);
}
export function Matrix4x4_MultiplyPoint3x4(_c: Ctx, m: M, p: V3): V3 {
  return v3(m.m00 * p.x + m.m01 * p.y + m.m02 * p.z + m.m03, m.m10 * p.x + m.m11 * p.y + m.m12 * p.z + m.m13, m.m20 * p.x + m.m21 * p.y + m.m22 * p.z + m.m23);
}
export function Matrix4x4_MultiplyVector(_c: Ctx, m: M, v: V3): V3 {
  return v3(m.m00 * v.x + m.m01 * v.y + m.m02 * v.z, m.m10 * v.x + m.m11 * v.y + m.m12 * v.z, m.m20 * v.x + m.m21 * v.y + m.m22 * v.z);
}
export const Matrix4x4_get_inverse = (_c: Ctx, m: M): M => fromThree(toThree(m).invert());
export const Matrix4x4_Inverse = Matrix4x4_get_inverse;
export const Matrix4x4_get_transpose = (_c: Ctx, m: M): M => fromThree(toThree(m).transpose());
export const Matrix4x4_GetColumn = (_c: Ctx, m: M, i: number): V4 => ({ x: m[`m0${i}`], y: m[`m1${i}`], z: m[`m2${i}`], w: m[`m3${i}`] });
export const Matrix4x4_GetRow = (_c: Ctx, m: M, i: number): V4 => ({ x: m[`m${i}0`], y: m[`m${i}1`], z: m[`m${i}2`], w: m[`m${i}3`] });
export const Matrix4x4_get_lossyScale = (_c: Ctx, m: M): V3 => {
  const s = new TV3();
  toThree(m).decompose(new TV3(), new TQ(), s);
  return v3(s.x, s.y, s.z);
};
export const Matrix4x4_get_rotation = (_c: Ctx, m: M): Q => {
  const q = new TQ();
  toThree(m).decompose(new TV3(), q, new TV3());
  return fq(q);
};

// ───────── AnimationCurve、Keyframe、Gradient ─────────

/** AnimationCurve：存檔是 { m_Curve: [Keyframe…], m_PreInfinity, m_PostInfinity }；Keyframe 的欄位是 time、value、inSlope、outSlope */
type Curve = { m_Curve: CurveKey[]; m_PreInfinity?: number; m_PostInfinity?: number };
type KF = CurveKey & { inWeight?: number; outWeight?: number };
export function AnimationCurve_Evaluate(_c: Ctx, curve: Curve | null, t: number): number {
  const keys = curve?.m_Curve ?? [];
  if (!keys.length) return 0;
  return evalCurve(keys, t);
}
export const new_AnimationCurve$Keyframe_arr = (_c: Ctx, keys: KF[]): Curve => ({ m_Curve: [...(keys ?? [])], m_PreInfinity: 2, m_PostInfinity: 2 });
export const new_AnimationCurve$ = (_c: Ctx): Curve => ({ m_Curve: [], m_PreInfinity: 2, m_PostInfinity: 2 });
export const AnimationCurve_Linear = (_c: Ctx, t0: number, v0: number, t1: number, v1: number): Curve => {
  const s = t1 === t0 ? 0 : (v1 - v0) / (t1 - t0);
  return { m_Curve: [{ time: t0, value: v0, inSlope: 0, outSlope: s }, { time: t1, value: v1, inSlope: s, outSlope: 0 }], m_PreInfinity: 2, m_PostInfinity: 2 };
};
export const AnimationCurve_EaseInOut = (_c: Ctx, t0: number, v0: number, t1: number, v1: number): Curve => ({
  m_Curve: [{ time: t0, value: v0, inSlope: 0, outSlope: 0 }, { time: t1, value: v1, inSlope: 0, outSlope: 0 }],
  m_PreInfinity: 2,
  m_PostInfinity: 2,
});
export const AnimationCurve_Constant = (_c: Ctx, t0: number, t1: number, v: number): Curve => ({ m_Curve: [{ time: t0, value: v, inSlope: 0, outSlope: 0 }, { time: t1, value: v, inSlope: 0, outSlope: 0 }], m_PreInfinity: 2, m_PostInfinity: 2 });
export const AnimationCurve_get_keys = (_c: Ctx, c: Curve): KF[] => (c.m_Curve ?? []).map((k) => ({ ...k }));
export const AnimationCurve_set_keys = (_c: Ctx, c: Curve, keys: KF[]): void => void (c.m_Curve = [...keys]);
export const AnimationCurve_get_length = (_c: Ctx, c: Curve): number => c.m_Curve?.length ?? 0;
export const AnimationCurve_get_Item = (_c: Ctx, c: Curve, i: number): KF => ({ ...c.m_Curve[i] });
export function AnimationCurve_AddKey$float_float(_c: Ctx, c: Curve, t: number, v: number): number {
  const k: KF = { time: t, value: v, inSlope: 0, outSlope: 0 };
  const i = c.m_Curve.findIndex((x) => x.time > t);
  if (i < 0) c.m_Curve.push(k);
  else c.m_Curve.splice(i, 0, k);
  return i < 0 ? c.m_Curve.length - 1 : i;
}
export function AnimationCurve_AddKey$Keyframe(_c: Ctx, c: Curve, k: KF): number {
  const i = c.m_Curve.findIndex((x) => x.time > k.time);
  if (i < 0) c.m_Curve.push({ ...k });
  else c.m_Curve.splice(i, 0, { ...k });
  return i < 0 ? c.m_Curve.length - 1 : i;
}
export function AnimationCurve_MoveKey(c: Ctx, curve: Curve, i: number, k: KF): number {
  curve.m_Curve.splice(i, 1);
  return AnimationCurve_AddKey$Keyframe(c, curve, k);
}
export const AnimationCurve_RemoveKey = (_c: Ctx, c: Curve, i: number): void => void c.m_Curve.splice(i, 1);
export const AnimationCurve_set_preWrapMode = (_c: Ctx, c: Curve, v: number): void => void (c.m_PreInfinity = v);
export const AnimationCurve_set_postWrapMode = (_c: Ctx, c: Curve, v: number): void => void (c.m_PostInfinity = v);
export const AnimationCurve_get_preWrapMode = (_c: Ctx, c: Curve): number => c.m_PreInfinity ?? 2;
export const AnimationCurve_get_postWrapMode = (_c: Ctx, c: Curve): number => c.m_PostInfinity ?? 2;
export const new_Keyframe$float_float = (_c: Ctx, time: number, value: number): KF => ({ time, value, inSlope: 0, outSlope: 0 });
export const new_Keyframe$float_float_float_float = (_c: Ctx, time: number, value: number, i: number, o: number): KF => ({ time, value, inSlope: i, outSlope: o });
export const Keyframe_get_time = (_c: Ctx, k: KF): number => k.time;
export const Keyframe_set_time = (_c: Ctx, k: KF, v: number): void => void (k.time = v);
export const Keyframe_get_value = (_c: Ctx, k: KF): number => k.value;
export const Keyframe_set_value = (_c: Ctx, k: KF, v: number): void => void (k.value = v);
export const Keyframe_get_inTangent = (_c: Ctx, k: KF): number => Number(k.inSlope);
export const Keyframe_get_outTangent = (_c: Ctx, k: KF): number => Number(k.outSlope);
export const Keyframe_set_inTangent = (_c: Ctx, k: KF, v: number): void => void (k.inSlope = v);
export const Keyframe_set_outTangent = (_c: Ctx, k: KF, v: number): void => void (k.outSlope = v);
/** Gradient：存檔是 { key0..key7（顏色）, ctime0..7, atime0..7（0～65535）, m_Mode, m_NumColorKeys, m_NumAlphaKeys } */
type G = Record<string, unknown> & { m_Mode?: number; m_NumColorKeys?: number; m_NumAlphaKeys?: number };
function gradKeys(g: G): { colors: { c: C; t: number }[]; alphas: { a: number; t: number }[] } {
  const nc = g.m_NumColorKeys ?? 2;
  const na = g.m_NumAlphaKeys ?? 2;
  const colors = [];
  const alphas = [];
  for (let i = 0; i < nc; i++) colors.push({ c: g[`key${i}`] as C, t: (g[`ctime${i}`] as number) / 65535 });
  for (let i = 0; i < na; i++) alphas.push({ a: (g[`key${i}`] as C).a, t: (g[`atime${i}`] as number) / 65535 });
  return { colors, alphas };
}
export function Gradient_Evaluate(_c: Ctx, g: G, t: number): C {
  const { colors, alphas } = gradKeys(g);
  const fixed = g.m_Mode === 1;
  const pick = <T,>(keys: { t: number }[], get: (i: number) => T, lerp: (a: T, b: T, u: number) => T): T => {
    if (t <= keys[0].t) return get(0);
    for (let i = 1; i < keys.length; i++) {
      if (t <= keys[i].t) return fixed ? get(i) : lerp(get(i - 1), get(i), (t - keys[i - 1].t) / (keys[i].t - keys[i - 1].t || 1));
    }
    return get(keys.length - 1);
  };
  const c = pick(colors, (i) => colors[i].c, (a, b, u) => col(a.r + (b.r - a.r) * u, a.g + (b.g - a.g) * u, a.b + (b.b - a.b) * u, 1));
  const a = pick(alphas, (i) => alphas[i].a, (x, y, u) => x + (y - x) * u);
  return col(c.r, c.g, c.b, a);
}
export const Gradient_get_colorKeys = (_c: Ctx, g: G): { color: C; time: number }[] => gradKeys(g).colors.map((k) => ({ color: { ...k.c, a: 1 }, time: k.t }));
export const Gradient_get_alphaKeys = (_c: Ctx, g: G): { alpha: number; time: number }[] => gradKeys(g).alphas.map((k) => ({ alpha: k.a, time: k.t }));
export function Gradient_SetKeys(_c: Ctx, g: G, colors: { color: C; time: number }[], alphas: { alpha: number; time: number }[]): void {
  g.m_NumColorKeys = colors.length;
  g.m_NumAlphaKeys = alphas.length;
  for (let i = 0; i < 8; i++) {
    const cc = colors[i]?.color ?? col(0, 0, 0, 0);
    g[`key${i}`] = col(cc.r, cc.g, cc.b, alphas[i]?.alpha ?? 1);
    g[`ctime${i}`] = Math.round((colors[i]?.time ?? 0) * 65535);
    g[`atime${i}`] = Math.round((alphas[i]?.time ?? 0) * 65535);
  }
}
export const new_Gradient = (_c: Ctx): G => ({ m_Mode: 0, m_NumColorKeys: 2, m_NumAlphaKeys: 2, key0: col(1, 1, 1, 1), key1: col(1, 1, 1, 1), ctime0: 0, ctime1: 65535, atime0: 0, atime1: 65535 });
export const new_GradientColorKey$Color_float = (_c: Ctx, color: C, time: number): { color: C; time: number } => ({ color, time });
export const new_GradientAlphaKey$float_float = (_c: Ctx, alpha: number, time: number): { alpha: number; time: number } => ({ alpha, time });
export const Gradient_get_mode = (_c: Ctx, g: G): number => g.m_Mode ?? 0;
export const Gradient_set_mode = (_c: Ctx, g: G, v: number): void => void (g.m_Mode = v);

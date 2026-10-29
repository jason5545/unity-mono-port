// 相容層：System.Reflection 的一小部分。System.Type 在 TS 這邊是型別名字串（轉換器的 typeof 產生的）。
// 產生的類別：方法（methods 表）、靜態欄位（statics）與會序列化的欄位列得出來；外部型別（沒有原始碼的 DLL）要先登記（registerReflectionType）。
// dotnet.ts 會 export * 這裡。

import { baseTypeName, ctxOf, genBaseOf, genClass, genStatic, getActiveWorld, hasGen, newGen, serializedFieldsOf, splitTypeArgs, staticCtx, typeNames, type Ctx } from './core';
import { ENUM_TYPES, Type_get_Name } from './dotnet';

type Fn = (...a: any[]) => any;
export interface FieldInfoJs {
  $type: 'FieldInfo';
  Name: string;
  DeclaringType: string;
  get(obj: unknown): unknown;
  set(obj: unknown, v: unknown): void;
}
export interface MethodInfoJs {
  $type: 'MethodInfo';
  Name: string;
  DeclaringType: string;
  invoke(target: unknown, args: unknown[]): unknown;
  /** 產生的方法本身（ReturnType 看它是不是產生器） */
  fn?: Fn;
}
const registered = new Map<string, { fields: FieldInfoJs[]; methods: MethodInfoJs[]; base?: string }>();

/** 外部型別的反射資料：欄位（取值函式）與方法 */
export function registerReflectionType(name: string, def: { fields?: Record<string, () => unknown>; methods?: Record<string, Fn>; base?: string }): void {
  registered.set(name, {
    base: def.base,
    fields: Object.entries(def.fields ?? {}).map(([n, g]) => ({ $type: 'FieldInfo', Name: n, DeclaringType: name, get: () => g(), set: () => {} })),
    methods: Object.entries(def.methods ?? {}).map(([n, f]) => ({ $type: 'MethodInfo', Name: n, DeclaringType: name, invoke: (t, a) => f(t, ...a) })),
  });
}
function fieldsOf(t: string): FieldInfoJs[] {
  const r = registered.get(t) ?? registered.get(baseTypeName(t));
  t = baseTypeName(t);
  if (r) return r.fields;
  if (!hasGen(t)) return [];
  const g = genClass(t);
  const out: FieldInfoJs[] = [];
  for (const n of Object.keys(g.statics ?? {})) out.push({ $type: 'FieldInfo', Name: n, DeclaringType: t, get: () => genStatic(staticCtx, t, n), set: (_o, v) => g.statics![n].set(v) });
  for (const n of serializedFieldsOf(t)) out.push({ $type: 'FieldInfo', Name: n, DeclaringType: t, get: (o) => (o as Record<string, unknown>)?.[n], set: (o, v) => void ((o as Record<string, unknown>)[n] = v) });
  return out;
}
/**
 * 產生的類別的方法（沿基底鏈；declaredOnly＝BindingFlags.DeclaredOnly 只列這個類別自己宣告的）。建構子不算（C# 的 GetMethods 不含）。
 * 叫的時候用實體自己的 Ctx（元件的 ai 跟 H 分開，ctxOf）；靜態方法（target null）用靜態的 Ctx
 */
function methodsOf(t: string, declaredOnly = false): MethodInfoJs[] {
  const r = registered.get(t) ?? registered.get(baseTypeName(t));
  t = baseTypeName(t);
  if (r) return r.methods;
  const out: MethodInfoJs[] = [];
  for (let k: string | null = t; k && hasGen(k); k = declaredOnly ? null : genBaseOf(k)) {
    const g = genClass(k);
    for (const [n, f] of Object.entries(g.methods)) {
      if (n === 'ctor' || n.startsWith('ctor$') || n === 'cctor') continue;
      const name = n.split('$')[0];
      if (out.some((m) => m.Name === name && m.DeclaringType !== k)) continue;
      const owner = k;
      out.push({
        $type: 'MethodInfo',
        Name: name,
        DeclaringType: owner,
        fn: f,
        invoke: (target, args) => f(target == null ? { ...staticCtx, w: getActiveWorld() } : ctxOf(getActiveWorld(), target as object, owner), ...(args ?? [])),
      });
    }
  }
  return out;
}
/** BindingFlags.DeclaredOnly */
const DECLARED_ONLY = 2;
export const RuntimeReflectionExtensions_GetRuntimeFields = (_c: Ctx, t: string): FieldInfoJs[] => fieldsOf(t);
export const RuntimeReflectionExtensions_GetRuntimeMethods = (_c: Ctx, t: string): MethodInfoJs[] => methodsOf(t);
export const Type_GetFields$BindingFlags = (_c: Ctx, t: string): FieldInfoJs[] => fieldsOf(t);
export const Type_GetFields$ = Type_GetFields$BindingFlags;
export const Type_GetField$string_BindingFlags = (_c: Ctx, t: string, n: string): FieldInfoJs | null => fieldsOf(t).find((f) => f.Name === n) ?? null;
export const Type_GetField$string = Type_GetField$string_BindingFlags;
export const Type_GetMethods$BindingFlags = (_c: Ctx, t: string, flags: number): MethodInfoJs[] => methodsOf(t, ((flags ?? 0) & DECLARED_ONLY) !== 0);
export const Type_GetMethods$ = (_c: Ctx, t: string): MethodInfoJs[] => methodsOf(t);
export const Type_GetMethod$string = (_c: Ctx, t: string, n: string): MethodInfoJs | null => methodsOf(t).find((m) => m.Name === n) ?? null;
export const Type_GetMethod$string_BindingFlags = Type_GetMethod$string;
export const FieldInfo_GetValue = (_c: Ctx, f: FieldInfoJs, o: unknown): unknown => f.get(o);
export const FieldInfo_SetValue$Object_Object = (_c: Ctx, f: FieldInfoJs, o: unknown, v: unknown): void => f.set(o, v);
export const FieldInfo_get_FieldType = (_c: Ctx, f: FieldInfoJs): string => typeof f.get(null);
/**
 * MemberInfo.Name：Type 也是 MemberInfo（typeof(T).Name 轉出來叫這個）。這個專案的 Type 是型別名字串，照 Type.Name 回；
 * 以前只認 { Name } 物件，型別拿到 undefined：MT2 的 RelicData.GetFirstRelicEffectData<T>() 永遠找不到，商人的升級商品變成 Instant、不開選卡畫面
 */
export const MemberInfo_get_Name = (c: Ctx, m: { Name: string } | string): string => (typeof m === 'string' ? Type_get_Name(c, m) : m.Name);
export const MemberInfo_get_DeclaringType = (_c: Ctx, m: { DeclaringType: string }): string => m.DeclaringType;
export const MemberInfo_GetCustomAttributes$bool = (_c: Ctx): unknown[] => [];
export const MemberInfo_GetCustomAttributes$Type_bool = (_c: Ctx): unknown[] => [];
/** Attribute.GetCustomAttribute(成員, 型別)：類別與成員的 attribute 沒有轉出（同上），回 null。Timeline 的 TrackBindingTypeAttribute 因此是 null（binding 的 outputTargetType） */
export const Attribute_GetCustomAttribute$MemberInfo_Type = (_c: Ctx, m: unknown, t: unknown): null => (void [m, t], null);
export const MethodBase_Invoke$Object_Object_arr = (_c: Ctx, m: MethodInfoJs, target: unknown, args: unknown[]): unknown => m.invoke(target, args ?? []);
export const MethodInfo_op_Inequality = (_c: Ctx, a: unknown, b: unknown): boolean => a !== b;
export const MethodInfo_op_Equality = (_c: Ctx, a: unknown, b: unknown): boolean => a === b;
const GeneratorFunction = Object.getPrototypeOf(function* () {}).constructor;
/**
 * MethodInfo.ReturnType：產生的方法只分得出迭代器（C# 回傳 IEnumerator 的 yield 方法轉成 JS 產生器）；其他一律 Void（差異清單）
 */
export const MethodInfo_get_ReturnType = (_c: Ctx, m: MethodInfoJs): string => (m.fn instanceof GeneratorFunction ? 'IEnumerator' : 'Void');
/** Delegate.CreateDelegate(type, target, method)：綁好對象的委派（產生碼裡的委派就是 JS 函式） */
export const Delegate_CreateDelegate$Type_Object_MethodInfo = (_c: Ctx, type: string, target: unknown, m: MethodInfoJs): ((...a: unknown[]) => unknown) => {
  void type;
  return (...a: unknown[]) => m.invoke(target, a);
};

// ───────── Type ─────────

const PRIMS = new Set(['Boolean', 'Byte', 'SByte', 'Int16', 'UInt16', 'Int32', 'UInt32', 'Int64', 'UInt64', 'Char', 'Double', 'Single', 'IntPtr', 'UIntPtr']);
const VALUE_TYPES = new Set([...PRIMS, 'Decimal', 'DateTime', 'TimeSpan', 'Guid', 'Vector2', 'Vector3', 'Vector4', 'Quaternion', 'Color', 'Color32', 'Rect', 'Bounds', 'Vector2Int', 'Vector3Int', 'Matrix4x4']);
export const Type_get_IsPrimitive = (_c: Ctx, t: string): boolean => PRIMS.has(t);
export const Type_get_IsValueType = (_c: Ctx, t: string): boolean => VALUE_TYPES.has(t) || ENUM_TYPES.has(t);
export const Type_get_IsClass = (_c: Ctx, t: string): boolean => !VALUE_TYPES.has(t) && !ENUM_TYPES.has(t);
export const Type_get_IsInterface = (_c: Ctx, t: string): boolean => /^I[A-Z]/.test(t) && !hasGen(t);
export const Type_get_IsGenericType = (_c: Ctx, t: string): boolean => /\$\d+$/.test(t) || t.includes('<');
export const Type_GetGenericTypeDefinition = (_c: Ctx, t: string): string => t.replace(/<.*>$/, '');
export const Type_GetGenericArguments = (_c: Ctx, t: string): string[] => {
  const m = /<(.*)>$/.exec(t);
  return m ? splitTypeArgs(m[1]) : [];
};
export const Type_get_FullName = (_c: Ctx, t: string): string => t;
export const Type_get_Namespace = (_c: Ctx, t: string): string => (void t, '');
export const Type_ToString = (_c: Ctx, t: string): string => t;
export const Type_get_BaseType = (_c: Ctx, t: string): string | null => genBaseOf(baseTypeName(t)) ?? (t === 'Object' ? null : 'Object');
export const Type_GetType$string = (_c: Ctx, name: string): string | null => {
  const short = name.split(',')[0].split('.').pop() ?? name;
  return hasGen(short) || registered.has(short) || ENUM_TYPES.has(short) ? short : null;
};
export const Type_GetInterfaces = (_c: Ctx, t: string): string[] => (hasGen(baseTypeName(t)) ? genClass(baseTypeName(t)).interfaces ?? [] : []);
/** a.IsAssignableFrom(b)：b 是 a 或 a 的子類別、實作 a */
export const Type_IsAssignableFrom = (c: Ctx, a: string, b: string | null): boolean => b != null && (a === b || a === 'Object' || typeNames(c.w, b).has(a));
export const Type_IsSubclassOf = (c: Ctx, t: string, b: string): boolean => t !== b && typeNames(c.w, t).has(b);
export const Type_IsInstanceOfType = (c: Ctx, t: string, o: unknown): boolean => o != null && typeNames(c.w, ((o as { $type?: string }).$type ?? typeof o) as string).has(t);
export const Type_MakeGenericType = (_c: Ctx, t: string, args: string[]): string => `${t}<${args.join(', ')}>`;
export const Type_GetHashCode = (_c: Ctx, t: string): number => {
  let h = 0;
  for (let i = 0; i < t.length; i++) h = (Math.imul(h, 31) + t.charCodeAt(i)) | 0;
  return h;
};
export const Type_Equals$Type = (_c: Ctx, a: string, b: string): boolean => a === b;
export const Type_Equals$Object = Type_Equals$Type;
export function Activator_CreateInstanceFromType(c: Ctx, t: string): unknown {
  return newGen(c, t, null);
}

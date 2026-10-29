// 相容層：System.IO（File、Directory、FileInfo、各種 Stream、StreamReader／Writer、BinaryReader／Writer）。dotnet.ts 會 export * 這裡。
//
// 網頁上沒有檔案系統：這裡是同步的虛擬檔案系統（C# 的 File.* 是同步的），路徑一律用 /。
//   - /streaming：Application.streamingAssetsPath，匯入器的 <out>/streaming（importer/streaming.py）。文字檔開機時預載（mountStreaming），
//     大檔（影片）只記網址（streamingUrl，VideoPlayer 用）。
//   - /persistent：Application.persistentDataPath（存檔）。開機時從瀏覽器的 IndexedDB 讀進來（mountPersistent），寫入時同步改記憶體、
//     背景寫回 IndexedDB。只存在這個瀏覽器（跟原版存在本機一樣）。
//   - 其他路徑（/temp 等）：只在記憶體。
// 與原版的差異：檔案鎖、權限、磁碟空間不足這類錯誤不會發生。

import type { Ctx } from './core';
import { DateTimeJs } from './dotnetBcl';

type Out<T> = (v: T) => void;
const csErr = (type: string, msg: string): Error => Object.assign(new Error(`C# ${type}：${msg}`), { name: type });

// ───────── 虛擬檔案系統 ─────────

export function normPath(p: string): string {
  if (p == null) throw csErr('ArgumentNullException', 'path');
  const parts: string[] = [];
  for (const seg of p.replace(/\\/g, '/').split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') parts.pop();
    else parts.push(seg);
  }
  return '/' + parts.join('/');
}
const files = new Map<string, Uint8Array>();
const mtimes = new Map<string, number>();
const dirs = new Set<string>(['/', '/persistent', '/temp', '/streaming', '/data']);
const remote = new Map<string, string>();

function ensureParents(p: string): void {
  for (let d = p.slice(0, p.lastIndexOf('/')); d && !dirs.has(d); d = d.slice(0, d.lastIndexOf('/'))) dirs.add(d);
}
function putFile(p: string, data: Uint8Array): void {
  ensureParents(p);
  files.set(p, data);
  mtimes.set(p, Date.now());
  persist(p, data);
}
function getFile(p: string): Uint8Array {
  const f = files.get(p);
  if (!f) {
    if (remote.has(p)) throw csErr('IOException', `${p} 是大檔，沒有預載（用網址：streamingUrl）`);
    throw csErr(dirs.has(p.slice(0, p.lastIndexOf('/')) || '/') ? 'FileNotFoundException' : 'DirectoryNotFoundException', `Could not find file "${p}"`);
  }
  return f;
}
function deleteFile(p: string): void {
  files.delete(p);
  mtimes.delete(p);
  persist(p, null);
}

/** StreamingAssets 的大檔（影片）在網頁上的網址；沒有回 null */
export function streamingUrl(path: string): string | null {
  return remote.get(normPath(path)) ?? null;
}

/** 開機：StreamingAssets 的索引，文字檔預載進 /streaming */
export async function mountStreaming(base: string): Promise<void> {
  let index: { files: Record<string, { size: number; text: boolean }> };
  try {
    index = await fetch(`${base}streaming/index.json`).then((r) => r.json());
  } catch {
    return;
  }
  await Promise.all(
    Object.entries(index.files).map(async ([rel, info]) => {
      const p = normPath(`/streaming/${rel}`);
      const url = `${base}streaming/${rel.split('/').map(encodeURIComponent).join('/')}`;
      ensureParents(p);
      if (!info.text) {
        remote.set(p, url);
        return;
      }
      const buf = new Uint8Array((await fetch(url).then((r) => r.arrayBuffer())) as ArrayBuffer);
      files.set(p, buf);
      mtimes.set(p, 0);
    }),
  );
}

// IndexedDB（/persistent 底下的檔案）
const DB_NAME = 'unity-cs2ts-vfs';
let db: IDBDatabase | null = null;
let dbPrefix = '';
/**
 * 寫進 IndexedDB：同一段同步程式裡改過的檔案只在結束時（microtask）各寫一次最後的內容。
 * 10/16：原本每次寫入就 put 一次，put 當下複製整份資料；MT2 每行 log 都 AppendAllText 到 logfile.log，
 * 一格裡幾千行 × 好幾 MB 的副本在讓出事件迴圈前都放不掉，分頁記憶體爆掉當掉。
 */
const pendingPersist = new Map<string, Uint8Array | null>();
let persistScheduled = false;
function persist(p: string, data: Uint8Array | null): void {
  if (!db || !p.startsWith('/persistent/')) return;
  pendingPersist.set(p, data);
  if (persistScheduled) return;
  persistScheduled = true;
  queueMicrotask(flushPersist);
}
/** 最後一個還沒寫完的交易：同一個 store 的 readwrite 交易照開的順序寫，等最後一個就等於全部 */
let lastPersistTx: IDBTransaction | null = null;
function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve) => {
    for (const ev of ['complete', 'error', 'abort']) tx.addEventListener(ev, () => resolve());
  });
}
function flushPersist(): void {
  persistScheduled = false;
  if (!db || !pendingPersist.size) return;
  const tx = db.transaction('files', 'readwrite');
  lastPersistTx = tx;
  void txDone(tx).then(() => {
    if (lastPersistTx === tx) lastPersistTx = null;
  });
  const store = tx.objectStore('files');
  // slice：檔案內容可能是大緩衝區的一段（appendBytes），結構化複製會連整個緩衝區一起抄
  for (const [p, data] of pendingPersist) {
    if (data) store.put({ data: data.slice(), mtime: mtimes.get(p) ?? Date.now() }, dbPrefix + p);
    else store.delete(dbPrefix + p);
  }
  pendingPersist.clear();
}
/** 關掉之前（Application.Quit）：還在排隊的寫入現在就寫，等全部寫進 IndexedDB */
export function flushPersistent(): Promise<void> {
  if (persistScheduled) flushPersist();
  return lastPersistTx ? txDone(lastPersistTx) : Promise.resolve();
}
/** 開機：IndexedDB 裡這個遊戲（key 前綴）的存檔讀進 /persistent。瀏覽器沒有 IndexedDB 時存檔只在記憶體 */
export async function mountPersistent(gameKey: string): Promise<void> {
  if (typeof indexedDB === 'undefined') return;
  dbPrefix = `${gameKey}:`;
  db = await new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore('files');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  const tx = db.transaction('files', 'readonly');
  const store = tx.objectStore('files');
  await new Promise<void>((resolve, reject) => {
    const req = store.openCursor();
    req.onsuccess = () => {
      const cur = req.result;
      if (!cur) return resolve();
      const key = String(cur.key);
      if (key.startsWith(dbPrefix)) {
        const p = key.slice(dbPrefix.length);
        const v = cur.value as { data: Uint8Array; mtime: number };
        ensureParents(p);
        files.set(p, v.data);
        mtimes.set(p, v.mtime);
      }
      cur.continue();
    };
    req.onerror = () => reject(req.error);
  });
}

const enc = new TextEncoder();
const dec = new TextDecoder();
/** 讀文字：去掉 UTF-8 的 BOM（.NET 的 ReadAllText 也會） */
function decodeText(b: Uint8Array): string {
  const s = dec.decode(b);
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

// ───────── File ─────────

export function File_Exists(c: Ctx, p: string | null): boolean {
  void c;
  return p != null && files.has(normPath(p)) || (p != null && remote.has(normPath(p)));
}
export function File_ReadAllText$string(c: Ctx, p: string): string {
  void c;
  return decodeText(getFile(normPath(p)));
}
export const File_ReadAllText$string_Encoding = File_ReadAllText$string;
export function File_ReadAllLines$string(c: Ctx, p: string): string[] {
  const s = File_ReadAllText$string(c, p);
  const lines = s.split(/\r?\n/);
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines;
}
export const File_ReadAllLines$string_Encoding = File_ReadAllLines$string;
export const File_ReadLines$string = File_ReadAllLines$string;
export function File_ReadAllBytes(c: Ctx, p: string): Uint8Array {
  void c;
  return getFile(normPath(p)).slice();
}
export function File_WriteAllText$string_string(c: Ctx, p: string, text: string | null): void {
  void c;
  putFile(normPath(p), enc.encode(text ?? ''));
}
export const File_WriteAllText$string_string_Encoding = File_WriteAllText$string_string;
export function File_WriteAllLines$string_IEnumerable(c: Ctx, p: string, lines: Iterable<string>): void {
  File_WriteAllText$string_string(c, p, [...lines].map((l) => `${l}\n`).join(''));
}
export const File_WriteAllLines$string_String_arr = File_WriteAllLines$string_IEnumerable;
/**
 * 接在檔案尾巴：檔案內容放在容量倍增的緩衝區裡（最新的那一段 view 後面的空間可以直接寫），一直 append 的 log 不用每次整份重拷。
 * 舊的 view 內容不變（別人拿著的讀取不受影響）；只有最新的 view 能接著寫。
 */
const appendable = new WeakSet<Uint8Array>();
function appendBytes(old: Uint8Array, add: Uint8Array): Uint8Array {
  const end = old.byteOffset + old.length;
  if (appendable.has(old) && end + add.length <= old.buffer.byteLength) {
    new Uint8Array(old.buffer, end, add.length).set(add);
    appendable.delete(old);
    const out = new Uint8Array(old.buffer, old.byteOffset, old.length + add.length);
    appendable.add(out);
    return out;
  }
  const buf = new Uint8Array(Math.max(4096, (old.length + add.length) * 2));
  buf.set(old);
  buf.set(add, old.length);
  const out = buf.subarray(0, old.length + add.length);
  appendable.add(out);
  return out;
}
export function File_AppendAllText$string_string(c: Ctx, p: string, text: string | null): void {
  void c;
  const n = normPath(p);
  putFile(n, appendBytes(files.get(n) ?? new Uint8Array(0), enc.encode(text ?? '')));
}
export const File_AppendAllText$string_string_Encoding = File_AppendAllText$string_string;
export function File_WriteAllBytes(c: Ctx, p: string, data: ArrayLike<number>): void {
  void c;
  putFile(normPath(p), Uint8Array.from(data as ArrayLike<number>));
}
export function File_Delete(c: Ctx, p: string): void {
  void c;
  deleteFile(normPath(p));
}
export function File_Move(c: Ctx, a: string, b: string): void {
  const src = normPath(a);
  const dst = normPath(b);
  if (files.has(dst)) throw csErr('IOException', `Cannot create "${dst}" because a file with the same name already exists.`);
  putFile(dst, getFile(src));
  deleteFile(src);
  void c;
}
export const File_Move$string_string = File_Move;
export function File_Move$string_string_bool(c: Ctx, a: string, b: string, overwrite: boolean): void {
  if (overwrite) deleteFile(normPath(b));
  File_Move(c, a, b);
}
export function File_Copy$string_string_bool(c: Ctx, a: string, b: string, overwrite: boolean): void {
  void c;
  const dst = normPath(b);
  if (!overwrite && files.has(dst)) throw csErr('IOException', `The file "${dst}" already exists.`);
  putFile(dst, getFile(normPath(a)).slice());
}
export function File_Copy$string_string(c: Ctx, a: string, b: string): void {
  File_Copy$string_string_bool(c, a, b, false);
}
export function File_Replace$string_string_string(c: Ctx, src: string, dst: string, backup: string | null): void {
  if (backup) File_Copy$string_string_bool(c, dst, backup, true);
  File_Move$string_string_bool(c, src, dst, true);
}
function mtimeOf(p: string): DateTimeJs {
  const t = mtimes.get(normPath(p));
  return new DateTimeJs(t ?? Date.UTC(1601, 0, 1), 1);
}
export const File_GetLastWriteTimeUtc = (_c: Ctx, p: string): DateTimeJs => mtimeOf(p);
export const File_GetLastWriteTime = (_c: Ctx, p: string): DateTimeJs => mtimeOf(p);
export const File_GetCreationTimeUtc = File_GetLastWriteTimeUtc;
export const File_GetCreationTime = File_GetLastWriteTime;
export function File_SetLastWriteTimeUtc(c: Ctx, p: string, t: DateTimeJs): void {
  void c;
  mtimes.set(normPath(p), t.ms);
}
export function File_GetAttributes(c: Ctx, p: string): number {
  void c;
  return dirs.has(normPath(p)) ? 16 : 128;
}
export function File_SetAttributes(c: Ctx, p: string, a: number): void {
  void c;
  void p;
  void a;
}
export function File_OpenRead(c: Ctx, p: string): StreamJs {
  void c;
  return new StreamJs(getFile(normPath(p)).slice(), null, true, false);
}
export function File_OpenWrite(c: Ctx, p: string): StreamJs {
  void c;
  return new StreamJs(files.get(normPath(p))?.slice() ?? new Uint8Array(0), normPath(p), false, true);
}
export function File_Create$string(c: Ctx, p: string): StreamJs {
  void c;
  const n = normPath(p);
  putFile(n, new Uint8Array(0));
  return new StreamJs(new Uint8Array(0), n, true, true);
}
export const File_Create$string_int = File_Create$string;
export const File_Create$string_int_FileOptions = File_Create$string;
export function File_OpenText(c: Ctx, p: string): TextReaderJs {
  return new TextReaderJs(File_ReadAllText$string(c, p));
}
export function File_CreateText(c: Ctx, p: string): TextWriterJs {
  return new TextWriterJs(File_Create$string(c, p));
}
export function File_AppendText(_c: Ctx, p: string): TextWriterJs {
  const s = new StreamJs(files.get(normPath(p))?.slice() ?? new Uint8Array(0), normPath(p), true, true);
  s.position = s.length;
  return new TextWriterJs(s);
}
/** FileMode：CreateNew 1、Create 2、Open 3、OpenOrCreate 4、Truncate 5、Append 6 */
export function File_Open$string_FileMode(_c: Ctx, p: string, mode: number): StreamJs {
  return openStream(p, mode, 3);
}
export function File_Open$string_FileMode_FileAccess(_c: Ctx, p: string, mode: number, access: number): StreamJs {
  return openStream(p, mode, access);
}
export const File_Open$string_FileMode_FileAccess_FileShare = File_Open$string_FileMode_FileAccess;
function openStream(path: string, mode: number, access: number): StreamJs {
  const p = normPath(path);
  const exists = files.has(p);
  if (mode === 1 && exists) throw csErr('IOException', `The file "${p}" already exists.`);
  if ((mode === 3 || mode === 5) && !exists) getFile(p);
  let data = exists ? files.get(p)!.slice() : new Uint8Array(0);
  if (mode === 2 || mode === 5 || mode === 1) data = new Uint8Array(0);
  const canWrite = (access & 2) !== 0;
  if (canWrite && !exists) putFile(p, data);
  const s = new StreamJs(data, canWrite ? p : null, (access & 1) !== 0, canWrite);
  if (mode === 6) s.position = s.length;
  return s;
}
export function new_FileStream$string_FileMode(c: Ctx, p: string, mode: number): StreamJs {
  void c;
  return openStream(p, mode, mode === 6 ? 2 : 3);
}
export function new_FileStream$string_FileMode_FileAccess(c: Ctx, p: string, mode: number, access: number): StreamJs {
  void c;
  return openStream(p, mode, access);
}
export const new_FileStream$string_FileMode_FileAccess_FileShare = new_FileStream$string_FileMode_FileAccess;
export const new_FileStream$string_FileMode_FileAccess_FileShare_int = new_FileStream$string_FileMode_FileAccess;
export const new_FileStream$string_FileMode_FileAccess_FileShare_int_bool = new_FileStream$string_FileMode_FileAccess;
export const new_FileStream$string_FileMode_FileAccess_FileShare_int_FileOptions = new_FileStream$string_FileMode_FileAccess;

// ───────── Directory ─────────

export function Directory_Exists(c: Ctx, p: string | null): boolean {
  void c;
  return p != null && dirs.has(normPath(p));
}
export function Directory_CreateDirectory$string(c: Ctx, p: string): DirInfoJs {
  void c;
  const n = normPath(p);
  ensureParents(`${n}/x`);
  dirs.add(n);
  return new DirInfoJs(n);
}
/** 搜尋樣式（* 與 ?）→ 正規式 */
function globRe(pattern: string): RegExp {
  const esc = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${esc}$`, 'i');
}
function listFiles(p: string, pattern = '*', recursive = false): string[] {
  const n = normPath(p);
  if (!dirs.has(n)) throw csErr('DirectoryNotFoundException', `Could not find a part of the path "${n}".`);
  const re = globRe(pattern);
  const out: string[] = [];
  const all = new Set([...files.keys(), ...remote.keys()]);
  for (const f of all) {
    if (!f.startsWith(`${n === '/' ? '' : n}/`)) continue;
    const rest = f.slice(n === '/' ? 1 : n.length + 1);
    if (!recursive && rest.includes('/')) continue;
    if (re.test(rest.slice(rest.lastIndexOf('/') + 1))) out.push(f);
  }
  return out.sort();
}
function listDirs(p: string, pattern = '*', recursive = false): string[] {
  const n = normPath(p);
  if (!dirs.has(n)) throw csErr('DirectoryNotFoundException', `Could not find a part of the path "${n}".`);
  const re = globRe(pattern);
  const out: string[] = [];
  for (const d of dirs) {
    if (d === n || !d.startsWith(`${n === '/' ? '' : n}/`)) continue;
    const rest = d.slice(n === '/' ? 1 : n.length + 1);
    if (!recursive && rest.includes('/')) continue;
    if (re.test(rest.slice(rest.lastIndexOf('/') + 1))) out.push(d);
  }
  return out.sort();
}
export const Directory_GetFiles$string = (_c: Ctx, p: string): string[] => listFiles(p);
export const Directory_GetFiles$string_string = (_c: Ctx, p: string, pat: string): string[] => listFiles(p, pat);
export const Directory_GetFiles$string_string_SearchOption = (_c: Ctx, p: string, pat: string, o: number): string[] => listFiles(p, pat, o === 1);
export const Directory_EnumerateFiles$string = Directory_GetFiles$string;
export const Directory_EnumerateFiles$string_string = Directory_GetFiles$string_string;
export const Directory_EnumerateFiles$string_string_SearchOption = Directory_GetFiles$string_string_SearchOption;
export const Directory_GetDirectories$string = (_c: Ctx, p: string): string[] => listDirs(p);
export const Directory_GetDirectories$string_string = (_c: Ctx, p: string, pat: string): string[] => listDirs(p, pat);
export const Directory_GetDirectories$string_string_SearchOption = (_c: Ctx, p: string, pat: string, o: number): string[] => listDirs(p, pat, o === 1);
export const Directory_EnumerateDirectories$string = Directory_GetDirectories$string;
export function Directory_Delete$string_bool(c: Ctx, p: string, recursive: boolean): void {
  void c;
  const n = normPath(p);
  const inside = [...files.keys()].filter((f) => f.startsWith(`${n}/`));
  const subdirs = [...dirs].filter((d) => d.startsWith(`${n}/`));
  if (!recursive && (inside.length || subdirs.length)) throw csErr('IOException', `The directory is not empty: "${n}"`);
  for (const f of inside) deleteFile(f);
  for (const d of subdirs) dirs.delete(d);
  dirs.delete(n);
}
export const Directory_Delete$string = (c: Ctx, p: string): void => Directory_Delete$string_bool(c, p, false);
export function Directory_Move(c: Ctx, a: string, b: string): void {
  void c;
  const src = normPath(a);
  const dst = normPath(b);
  for (const f of [...files.keys()].filter((x) => x.startsWith(`${src}/`))) {
    putFile(dst + f.slice(src.length), files.get(f)!);
    deleteFile(f);
  }
  for (const d of [...dirs].filter((x) => x === src || x.startsWith(`${src}/`))) {
    dirs.delete(d);
    dirs.add(dst + d.slice(src.length));
  }
}
export const Directory_GetCurrentDirectory = (_c: Ctx): string => '/data';
export const Directory_GetParent = (_c: Ctx, p: string): DirInfoJs | null => {
  const n = normPath(p);
  return n === '/' ? null : new DirInfoJs(n.slice(0, n.lastIndexOf('/')) || '/');
};

// ───────── FileInfo、DirectoryInfo ─────────

export class FileInfoJs {
  readonly $type = 'FileInfo';
  constructor(readonly path: string) {}
}
export class DirInfoJs {
  readonly $type = 'DirectoryInfo';
  constructor(readonly path: string) {}
}
export const new_FileInfo = (_c: Ctx, p: string): FileInfoJs => new FileInfoJs(normPath(p));
export const FileInfo_get_Exists = (_c: Ctx, f: FileInfoJs): boolean => files.has(f.path) || remote.has(f.path);
export const FileInfo_get_Length = (_c: Ctx, f: FileInfoJs): number => getFile(f.path).length;
export const FileInfo_get_Name = (_c: Ctx, f: FileInfoJs): string => f.path.slice(f.path.lastIndexOf('/') + 1);
export const FileInfo_get_FullName = (_c: Ctx, f: FileInfoJs): string => f.path;
export const FileSystemInfo_get_FullName = (_c: Ctx, f: FileInfoJs | DirInfoJs): string => f.path;
export const FileSystemInfo_get_Name = (_c: Ctx, f: FileInfoJs | DirInfoJs): string => f.path.slice(f.path.lastIndexOf('/') + 1);
export const FileSystemInfo_get_Extension = (_c: Ctx, f: FileInfoJs): string => {
  const n = f.path.slice(f.path.lastIndexOf('/') + 1);
  return n.includes('.') ? n.slice(n.lastIndexOf('.')) : '';
};
export const FileInfo_get_DirectoryName = (_c: Ctx, f: FileInfoJs): string => f.path.slice(0, f.path.lastIndexOf('/')) || '/';
export const FileInfo_get_Directory = (_c: Ctx, f: FileInfoJs): DirInfoJs => new DirInfoJs(f.path.slice(0, f.path.lastIndexOf('/')) || '/');
export const FileSystemInfo_get_LastWriteTimeUtc = (_c: Ctx, f: FileInfoJs): DateTimeJs => mtimeOf(f.path);
export const FileSystemInfo_get_LastWriteTime = FileSystemInfo_get_LastWriteTimeUtc;
export const FileSystemInfo_get_CreationTimeUtc = FileSystemInfo_get_LastWriteTimeUtc;
export const FileInfo_Delete = (_c: Ctx, f: FileInfoJs): void => deleteFile(f.path);
export const FileSystemInfo_Delete = FileInfo_Delete;
export const FileInfo_OpenRead = (c: Ctx, f: FileInfoJs): StreamJs => File_OpenRead(c, f.path);
export const FileInfo_CopyTo$string_bool = (c: Ctx, f: FileInfoJs, dst: string, ow: boolean): FileInfoJs => {
  File_Copy$string_string_bool(c, f.path, dst, ow);
  return new FileInfoJs(normPath(dst));
};
export const FileInfo_MoveTo$string = (c: Ctx, f: FileInfoJs, dst: string): void => File_Move(c, f.path, dst);
export const new_DirectoryInfo = (_c: Ctx, p: string): DirInfoJs => new DirInfoJs(normPath(p));
export const DirectoryInfo_get_Exists = (_c: Ctx, d: DirInfoJs): boolean => dirs.has(d.path);
/** FileSystemInfo.Exists（抽象屬性）：照實際是 FileInfo 還是 DirectoryInfo */
export const FileSystemInfo_get_Exists = (c: Ctx, f: FileInfoJs | DirInfoJs): boolean =>
  f instanceof DirInfoJs ? DirectoryInfo_get_Exists(c, f) : FileInfo_get_Exists(c, f);
export const DirectoryInfo_get_Name = (_c: Ctx, d: DirInfoJs): string => d.path.slice(d.path.lastIndexOf('/') + 1);
export const DirectoryInfo_get_FullName = (_c: Ctx, d: DirInfoJs): string => d.path;
export const DirectoryInfo_get_Parent = (c: Ctx, d: DirInfoJs): DirInfoJs | null => Directory_GetParent(c, d.path);
export const DirectoryInfo_Create = (c: Ctx, d: DirInfoJs): void => void Directory_CreateDirectory$string(c, d.path);
export const DirectoryInfo_GetFiles$ = (_c: Ctx, d: DirInfoJs): FileInfoJs[] => listFiles(d.path).map((f) => new FileInfoJs(f));
export const DirectoryInfo_GetFiles$string = (_c: Ctx, d: DirInfoJs, pat: string): FileInfoJs[] => listFiles(d.path, pat).map((f) => new FileInfoJs(f));
export const DirectoryInfo_GetFiles$string_SearchOption = (_c: Ctx, d: DirInfoJs, pat: string, o: number): FileInfoJs[] => listFiles(d.path, pat, o === 1).map((f) => new FileInfoJs(f));
export const DirectoryInfo_GetDirectories$ = (_c: Ctx, d: DirInfoJs): DirInfoJs[] => listDirs(d.path).map((x) => new DirInfoJs(x));
export const DirectoryInfo_Delete$bool = (c: Ctx, d: DirInfoJs, r: boolean): void => Directory_Delete$string_bool(c, d.path, r);

// ───────── Stream（FileStream、MemoryStream 共用：一塊可以長大的位元組） ─────────

export class StreamJs {
  $type = 'Stream';
  buf: Uint8Array;
  length: number;
  position = 0;
  closed = false;
  constructor(
    data: Uint8Array,
    /** 寫回虛擬檔案系統的路徑（FileStream）；MemoryStream 是 null */
    readonly path: string | null,
    readonly canRead = true,
    readonly canWrite = true,
  ) {
    this.buf = data;
    this.length = data.length;
  }
  /** flush 交給虛擬檔案系統的那段長度（buf 的 [0, shared) 被檔案內容共用）：覆寫這段之前先換一塊緩衝區，交出去的內容不變 */
  private shared = 0;
  /** new MemoryStream(byte[]…)：包住呼叫端的陣列，容量固定（.NET 的 _expandable 是 false） */
  fixedCapacity = false;
  /**
   * 包住的是一般陣列（R.newArray 產生的 byte[]）時：buf 是它的 Uint8Array 複本（BinaryReader 要 DataView），
   * 寫入同步寫回原陣列的 [offset, …)，呼叫端讀原陣列看得到（MT2 ReplayManager.SerializeEntry 寫完把 recordBytesBuffer 轉 Base64）
   */
  mirror: { arr: { [i: number]: number }; offset: number } | null = null;
  ensure(n: number): void {
    if (n <= this.buf.length) return;
    if (this.fixedCapacity) throw csErr('NotSupportedException', 'Memory stream is not expandable.');
    const nb = new Uint8Array(Math.max(n, this.buf.length * 2, 256));
    nb.set(this.buf.subarray(0, this.length));
    this.buf = nb;
    this.shared = 0;
  }
  write(bytes: ArrayLike<number>, offset = 0, count = bytes.length - offset): void {
    if (!this.canWrite) throw csErr('NotSupportedException', 'Stream does not support writing.');
    if (this.position < this.shared) {
      this.buf = this.buf.slice();
      this.shared = 0;
    }
    this.ensure(this.position + count);
    for (let i = 0; i < count; i++) this.buf[this.position + i] = bytes[offset + i];
    if (this.mirror) for (let i = 0; i < count; i++) this.mirror.arr[this.mirror.offset + this.position + i] = this.buf[this.position + i];
    this.position += count;
    if (this.position > this.length) this.length = this.position;
  }
  read(into: { [i: number]: number }, offset: number, count: number): number {
    const n = Math.max(0, Math.min(count, this.length - this.position));
    for (let i = 0; i < n; i++) into[offset + i] = this.buf[this.position + i];
    this.position += n;
    return n;
  }
  bytes(): Uint8Array {
    return this.buf.slice(0, this.length);
  }
  /** 寫回虛擬檔案系統：交出目前內容的 view，不複製（AutoFlush 的 log 每行 flush 一次，複製整份會越寫越慢） */
  flush(): void {
    if (!this.path || !this.canWrite) return;
    putFile(this.path, this.buf.subarray(0, this.length));
    this.shared = this.length;
  }
}
export const new_MemoryStream$ = (_c: Ctx): StreamJs => new StreamJs(new Uint8Array(0), null);
export const new_MemoryStream$int = new_MemoryStream$;
/**
 * new MemoryStream(byte[] buffer, [int index, int count,] [bool writable])：.NET 不複製，包住呼叫端的陣列（寫入落在原陣列），
 * 長度與容量都是那一段、不能變大；index／count 的版本 writable 預設 true。
 * Uint8Array 直接共用（subarray）；一般陣列見 StreamJs.mirror。
 */
function wrapBytes(b: ArrayLike<number>, index: number, count: number, writable: boolean): StreamJs {
  let s: StreamJs;
  if (b instanceof Uint8Array) s = new StreamJs(b.subarray(index, index + count), null, true, writable);
  else {
    s = new StreamJs(Uint8Array.from(Array.prototype.slice.call(b, index, index + count) as number[]), null, true, writable);
    s.mirror = { arr: b as { [i: number]: number }, offset: index };
  }
  s.fixedCapacity = true;
  return s;
}
export const new_MemoryStream$Byte_arr = (_c: Ctx, b: ArrayLike<number>): StreamJs => wrapBytes(b, 0, b.length, true);
export const new_MemoryStream$Byte_arr_bool = (_c: Ctx, b: ArrayLike<number>, w: boolean): StreamJs => wrapBytes(b, 0, b.length, w);
export const new_MemoryStream$Byte_arr_int_int = (_c: Ctx, b: ArrayLike<number>, i: number, n: number): StreamJs => wrapBytes(b, i, n, true);
export const new_MemoryStream$Byte_arr_int_int_bool = (_c: Ctx, b: ArrayLike<number>, i: number, n: number, w: boolean): StreamJs => wrapBytes(b, i, n, w);
export const MemoryStream_ToArray = (_c: Ctx, s: StreamJs): Uint8Array => s.bytes();
export const MemoryStream_GetBuffer = (_c: Ctx, s: StreamJs): Uint8Array => s.buf;
export const MemoryStream_get_Capacity = (_c: Ctx, s: StreamJs): number => s.buf.length;
export const MemoryStream_SetLength = (_c: Ctx, s: StreamJs, n: number): void => {
  s.ensure(n);
  s.length = n;
  if (s.position > n) s.position = n;
};
export const Stream_SetLength = MemoryStream_SetLength;
export const Stream_Write$Byte_arr_int_int = (_c: Ctx, s: StreamJs, b: ArrayLike<number>, o: number, n: number): void => s.write(b, o, n);
export const Stream_Read$Byte_arr_int_int = (_c: Ctx, s: StreamJs, b: number[], o: number, n: number): number => s.read(b, o, n);
export const Stream_Write = Stream_Write$Byte_arr_int_int;
export const Stream_Read = Stream_Read$Byte_arr_int_int;
export const Stream_ReadByte = (_c: Ctx, s: StreamJs): number => (s.position < s.length ? s.buf[s.position++] : -1);
export const Stream_WriteByte = (_c: Ctx, s: StreamJs, v: number): void => s.write([v & 255]);
/** SeekOrigin：Begin 0、Current 1、End 2 */
export const Stream_Seek = (_c: Ctx, s: StreamJs, o: number, origin: number): number => (s.position = origin === 0 ? o : origin === 1 ? s.position + o : s.length + o);
export const Stream_get_Position = (_c: Ctx, s: StreamJs): number => s.position;
export const Stream_set_Position = (_c: Ctx, s: StreamJs, v: number): void => void (s.position = v);
export const Stream_get_Length = (_c: Ctx, s: StreamJs): number => s.length;
export const Stream_get_CanRead = (_c: Ctx, s: StreamJs): boolean => s.canRead;
export const Stream_get_CanWrite = (_c: Ctx, s: StreamJs): boolean => s.canWrite;
export const Stream_get_CanSeek = (_c: Ctx, s: StreamJs): boolean => !!s;
export const Stream_Flush = (_c: Ctx, s: StreamJs): void => s.flush();
export function Stream_Close(c: Ctx, s: StreamJs): void {
  void c;
  if (s.closed) return;
  s.flush();
  s.closed = true;
}
export const Stream_Dispose = Stream_Close;
export const FileStream_Dispose = Stream_Close;
export const MemoryStream_Dispose = Stream_Close;
export const FileStream_Flush$ = Stream_Flush;
export const FileStream_Flush$bool = Stream_Flush;
export function Stream_CopyTo$Stream(c: Ctx, s: StreamJs, dst: StreamJs): void {
  void c;
  dst.write(s.buf.subarray(s.position, s.length));
  s.position = s.length;
}
export const FileStream_get_Name = (_c: Ctx, s: StreamJs): string => s.path ?? '';

// ───────── 文字的讀寫（StreamReader、StreamWriter、StringReader、StringWriter） ─────────

export class TextReaderJs {
  $type = 'TextReader';
  pos = 0;
  constructor(readonly text: string) {}
}
export class TextWriterJs {
  $type = 'TextWriter';
  s = '';
  autoFlush = false;
  constructor(readonly stream: StreamJs | null) {}
}
function readerText(s: StreamJs): string {
  const b = s.buf.subarray(s.position, s.length);
  s.position = s.length;
  return decodeText(b);
}
export const new_StreamReader$string = (c: Ctx, p: string): TextReaderJs => new TextReaderJs(File_ReadAllText$string(c, p));
export const new_StreamReader$string_Encoding = new_StreamReader$string;
export const new_StreamReader$Stream = (_c: Ctx, s: StreamJs): TextReaderJs => new TextReaderJs(readerText(s));
export const new_StreamReader$Stream_Encoding = new_StreamReader$Stream;
export const new_StreamReader$Stream_bool = new_StreamReader$Stream;
export const new_StringReader = (_c: Ctx, s: string): TextReaderJs => new TextReaderJs(s ?? '');
export function TextReader_ReadToEnd(c: Ctx, r: TextReaderJs): string {
  void c;
  const out = r.text.slice(r.pos);
  r.pos = r.text.length;
  return out;
}
export const StreamReader_ReadToEnd = TextReader_ReadToEnd;
export const StringReader_ReadToEnd = TextReader_ReadToEnd;
export function TextReader_ReadLine(c: Ctx, r: TextReaderJs): string | null {
  void c;
  if (r.pos >= r.text.length) return null;
  const m = /\r\n|\n|\r/g;
  m.lastIndex = r.pos;
  const hit = m.exec(r.text);
  const end = hit ? hit.index : r.text.length;
  const line = r.text.slice(r.pos, end);
  r.pos = hit ? end + hit[0].length : r.text.length;
  return line;
}
export const StreamReader_ReadLine = TextReader_ReadLine;
export const StringReader_ReadLine = TextReader_ReadLine;
export const TextReader_Peek = (_c: Ctx, r: TextReaderJs): number => (r.pos < r.text.length ? r.text.charCodeAt(r.pos) : -1);
export const StreamReader_Peek = TextReader_Peek;
export const StringReader_Peek = TextReader_Peek;
export const TextReader_Read$ = (_c: Ctx, r: TextReaderJs): number => (r.pos < r.text.length ? r.text.charCodeAt(r.pos++) : -1);
export const StreamReader_Read$ = TextReader_Read$;
export const StringReader_Read$ = TextReader_Read$;
export const StreamReader_get_EndOfStream = (_c: Ctx, r: TextReaderJs): boolean => r.pos >= r.text.length;
export const TextReader_Dispose = (_c: Ctx, r: TextReaderJs): void => void r;
export const StreamReader_Dispose = TextReader_Dispose;
export const StringReader_Dispose = TextReader_Dispose;
export const TextReader_Close = TextReader_Dispose;
export const StreamReader_Close = TextReader_Dispose;
export const new_StreamWriter$string = (c: Ctx, p: string): TextWriterJs => new TextWriterJs(File_Create$string(c, p));
export const new_StreamWriter$string_bool = (c: Ctx, p: string, append: boolean): TextWriterJs => (append ? File_AppendText(c, p) : new_StreamWriter$string(c, p));
export const new_StreamWriter$string_bool_Encoding = new_StreamWriter$string_bool;
export const new_StreamWriter$Stream = (_c: Ctx, s: StreamJs): TextWriterJs => new TextWriterJs(s);
export const new_StreamWriter$Stream_Encoding = new_StreamWriter$Stream;
export const new_StringWriter$ = (_c: Ctx): TextWriterJs => new TextWriterJs(null);
export const new_StringWriter$IFormatProvider = new_StringWriter$;
function writerFlush(w: TextWriterJs): void {
  if (!w.stream || !w.s) return;
  w.stream.write(enc.encode(w.s));
  w.s = '';
  w.stream.flush();
}
export function TextWriter_Write$string(c: Ctx, w: TextWriterJs, v: unknown): void {
  void c;
  w.s += v == null ? '' : String(v);
  if (w.autoFlush) writerFlush(w);
}
export const TextWriter_Write$Char = TextWriter_Write$string;
export const TextWriter_Write$Object = TextWriter_Write$string;
export const StreamWriter_Write$string = TextWriter_Write$string;
export const StreamWriter_Write$Char = TextWriter_Write$string;
export const StringWriter_Write$string = TextWriter_Write$string;
export const StringWriter_Write$Char = TextWriter_Write$string;
export function TextWriter_WriteLine$string(c: Ctx, w: TextWriterJs, v: unknown): void {
  TextWriter_Write$string(c, w, `${v == null ? '' : String(v)}\n`);
}
export const TextWriter_WriteLine$ = (c: Ctx, w: TextWriterJs): void => TextWriter_Write$string(c, w, '\n');
export const TextWriter_WriteLine$Object = TextWriter_WriteLine$string;
export const StreamWriter_WriteLine$string = TextWriter_WriteLine$string;
export const StringWriter_WriteLine$string = TextWriter_WriteLine$string;
export const TextWriter_Flush = (_c: Ctx, w: TextWriterJs): void => writerFlush(w);
export const StreamWriter_Flush = TextWriter_Flush;
export function TextWriter_Dispose(c: Ctx, w: TextWriterJs): void {
  void c;
  writerFlush(w);
  if (w.stream) w.stream.closed = true;
}
export const StreamWriter_Dispose = TextWriter_Dispose;
export const StringWriter_Dispose = TextWriter_Dispose;
export const TextWriter_Close = TextWriter_Dispose;
export const StreamWriter_Close = TextWriter_Dispose;
export const StreamWriter_get_AutoFlush = (_c: Ctx, w: TextWriterJs): boolean => w.autoFlush;
export const StreamWriter_set_AutoFlush = (_c: Ctx, w: TextWriterJs, v: boolean): void => void (w.autoFlush = v);
export const StreamWriter_get_BaseStream = (_c: Ctx, w: TextWriterJs): StreamJs | null => w.stream;
export const StringWriter_ToString = (_c: Ctx, w: TextWriterJs): string => w.s;
export const StringWriter_GetStringBuilder = (_c: Ctx, w: TextWriterJs): { s: string } => w as unknown as { s: string };

// ───────── BinaryWriter、BinaryReader（.NET 的格式：小端序、字串前面是 7 位元編碼的位元組長度＋UTF-8） ─────────

export class BinaryWriterJs {
  $type = 'BinaryWriter';
  constructor(readonly stream: StreamJs) {}
}
export class BinaryReaderJs {
  $type = 'BinaryReader';
  constructor(readonly stream: StreamJs) {}
}
const scratch = new DataView(new ArrayBuffer(8));
function wr(w: BinaryWriterJs, n: number): void {
  w.stream.write(new Uint8Array(scratch.buffer, 0, n));
}
export const new_BinaryWriter$Stream = (_c: Ctx, s: StreamJs): BinaryWriterJs => new BinaryWriterJs(s);
export const new_BinaryWriter$Stream_Encoding = new_BinaryWriter$Stream;
export const new_BinaryWriter$Stream_Encoding_bool = new_BinaryWriter$Stream;
export const BinaryWriter_Write$int = (_c: Ctx, w: BinaryWriterJs, v: number): void => (scratch.setInt32(0, v, true), wr(w, 4));
export const BinaryWriter_Write$UInt32 = (_c: Ctx, w: BinaryWriterJs, v: number): void => (scratch.setUint32(0, v >>> 0, true), wr(w, 4));
export const BinaryWriter_Write$short = (_c: Ctx, w: BinaryWriterJs, v: number): void => (scratch.setInt16(0, v, true), wr(w, 2));
export const BinaryWriter_Write$Int16 = BinaryWriter_Write$short;
export const BinaryWriter_Write$UInt16 = (_c: Ctx, w: BinaryWriterJs, v: number): void => (scratch.setUint16(0, v, true), wr(w, 2));
export const BinaryWriter_Write$Int64 = (_c: Ctx, w: BinaryWriterJs, v: number): void => (scratch.setBigInt64(0, BigInt(Math.trunc(v)), true), wr(w, 8));
export const BinaryWriter_Write$UInt64 = (_c: Ctx, w: BinaryWriterJs, v: number): void => (scratch.setBigUint64(0, BigInt(Math.trunc(v)), true), wr(w, 8));
export const BinaryWriter_Write$float = (_c: Ctx, w: BinaryWriterJs, v: number): void => (scratch.setFloat32(0, v, true), wr(w, 4));
export const BinaryWriter_Write$double = (_c: Ctx, w: BinaryWriterJs, v: number): void => (scratch.setFloat64(0, v, true), wr(w, 8));
export const BinaryWriter_Write$bool = (_c: Ctx, w: BinaryWriterJs, v: boolean): void => w.stream.write([v ? 1 : 0]);
export const BinaryWriter_Write$Byte = (_c: Ctx, w: BinaryWriterJs, v: number): void => w.stream.write([v & 255]);
export const BinaryWriter_Write$SByte = BinaryWriter_Write$Byte;
export const BinaryWriter_Write$Byte_arr = (_c: Ctx, w: BinaryWriterJs, b: ArrayLike<number>): void => w.stream.write(b);
export const BinaryWriter_Write$Byte_arr_int_int = (_c: Ctx, w: BinaryWriterJs, b: ArrayLike<number>, i: number, n: number): void => w.stream.write(b, i, n);
export const BinaryWriter_Write$Char = (_c: Ctx, w: BinaryWriterJs, ch: string): void => w.stream.write(enc.encode(ch));
export function write7BitInt(w: BinaryWriterJs, v: number): void {
  let n = v >>> 0;
  while (n >= 0x80) {
    w.stream.write([(n & 0x7f) | 0x80]);
    n >>>= 7;
  }
  w.stream.write([n]);
}
export function BinaryWriter_Write$string(c: Ctx, w: BinaryWriterJs, s: string): void {
  void c;
  if (s == null) throw csErr('ArgumentNullException', 'value');
  const b = enc.encode(s);
  write7BitInt(w, b.length);
  w.stream.write(b);
}
export const BinaryWriter_Write7BitEncodedInt = (_c: Ctx, w: BinaryWriterJs, v: number): void => write7BitInt(w, v);
export const BinaryWriter_Flush = (_c: Ctx, w: BinaryWriterJs): void => w.stream.flush();
export const BinaryWriter_Dispose = (c: Ctx, w: BinaryWriterJs): void => Stream_Close(c, w.stream);
export const BinaryWriter_Close = BinaryWriter_Dispose;
export const BinaryWriter_get_BaseStream = (_c: Ctx, w: BinaryWriterJs): StreamJs => w.stream;
function rd(r: BinaryReaderJs, n: number): DataView {
  const s = r.stream;
  if (s.position + n > s.length) throw csErr('EndOfStreamException', 'Unable to read beyond the end of the stream.');
  const v = new DataView(s.buf.buffer, s.buf.byteOffset + s.position, n);
  s.position += n;
  return v;
}
export const new_BinaryReader$Stream = (_c: Ctx, s: StreamJs): BinaryReaderJs => new BinaryReaderJs(s);
export const new_BinaryReader$Stream_Encoding = new_BinaryReader$Stream;
export const new_BinaryReader$Stream_Encoding_bool = new_BinaryReader$Stream;
export const BinaryReader_ReadInt32 = (_c: Ctx, r: BinaryReaderJs): number => rd(r, 4).getInt32(0, true);
export const BinaryReader_ReadUInt32 = (_c: Ctx, r: BinaryReaderJs): number => rd(r, 4).getUint32(0, true);
export const BinaryReader_ReadInt16 = (_c: Ctx, r: BinaryReaderJs): number => rd(r, 2).getInt16(0, true);
export const BinaryReader_ReadUInt16 = (_c: Ctx, r: BinaryReaderJs): number => rd(r, 2).getUint16(0, true);
export const BinaryReader_ReadInt64 = (_c: Ctx, r: BinaryReaderJs): number => Number(rd(r, 8).getBigInt64(0, true));
export const BinaryReader_ReadUInt64 = (_c: Ctx, r: BinaryReaderJs): number => Number(rd(r, 8).getBigUint64(0, true));
export const BinaryReader_ReadSingle = (_c: Ctx, r: BinaryReaderJs): number => rd(r, 4).getFloat32(0, true);
export const BinaryReader_ReadDouble = (_c: Ctx, r: BinaryReaderJs): number => rd(r, 8).getFloat64(0, true);
export const BinaryReader_ReadBoolean = (_c: Ctx, r: BinaryReaderJs): boolean => rd(r, 1).getUint8(0) !== 0;
export const BinaryReader_ReadByte = (_c: Ctx, r: BinaryReaderJs): number => rd(r, 1).getUint8(0);
export const BinaryReader_ReadSByte = (_c: Ctx, r: BinaryReaderJs): number => rd(r, 1).getInt8(0);
export function BinaryReader_ReadBytes(c: Ctx, r: BinaryReaderJs, n: number): Uint8Array {
  void c;
  const s = r.stream;
  const k = Math.min(n, s.length - s.position);
  const out = s.buf.slice(s.position, s.position + k);
  s.position += k;
  return out;
}
export function read7BitInt(r: BinaryReaderJs): number {
  let v = 0;
  let shift = 0;
  for (;;) {
    const b = rd(r, 1).getUint8(0);
    v |= (b & 0x7f) << shift;
    if (!(b & 0x80)) return v;
    shift += 7;
    if (shift > 35) throw csErr('FormatException', 'Too many bytes in what should have been a 7 bit encoded Int32.');
  }
}
export function BinaryReader_ReadString(c: Ctx, r: BinaryReaderJs): string {
  void c;
  const n = read7BitInt(r);
  const s = r.stream;
  if (s.position + n > s.length) throw csErr('EndOfStreamException', 'Unable to read beyond the end of the stream.');
  const out = dec.decode(s.buf.subarray(s.position, s.position + n));
  s.position += n;
  return out;
}
export const BinaryReader_Read7BitEncodedInt = (_c: Ctx, r: BinaryReaderJs): number => read7BitInt(r);
export const BinaryReader_ReadChar = (_c: Ctx, r: BinaryReaderJs): string => String.fromCharCode(rd(r, 1).getUint8(0));
export const BinaryReader_PeekChar = (_c: Ctx, r: BinaryReaderJs): number => (r.stream.position < r.stream.length ? r.stream.buf[r.stream.position] : -1);
export const BinaryReader_Dispose = (_c: Ctx, r: BinaryReaderJs): void => void r;
export const BinaryReader_Close = BinaryReader_Dispose;
export const BinaryReader_get_BaseStream = (_c: Ctx, r: BinaryReaderJs): StreamJs => r.stream;

/** 除錯用：虛擬檔案系統的內容 */
export function vfsList(): { files: string[]; dirs: string[]; remote: string[] } {
  return { files: [...files.keys()].sort(), dirs: [...dirs].sort(), remote: [...remote.keys()].sort() };
}
export type { Out as IoOut };

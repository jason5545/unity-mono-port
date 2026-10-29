// 抓 JSON 檔的共用入口：同一個網址只抓一次（不同模組要同一份表時共用），打包過的檔從包裡拿（匯入器的 packs/，importer/packs.py）。
//
// 為什麼：開機時物件庫（objectStore.ts）、素材庫（assets.ts）、TMP 素材（font/textAssets.ts）各自讀 materials.json、monobehaviours.json、
// texts.json、TMP 字型這些檔，以前各抓各的，同一個檔抓兩次。依賴閉包是幾千個小檔，Android APK 每個請求都要經過 WebView 攔截、
// 從 APK 讀、解壓；匯入器把閉包併成少數幾包，這裡照 packs/index.json 的對照表把那些路徑改成從包裡拿。
// 載哪些檔照舊由呼叫端決定（閉包、場景），這裡只改「怎麼拿到檔案內容」。

interface PackIndex {
  chunks: { file: string; group: string; boot?: boolean; files: string[] }[];
}

/** 網址 → 在哪一包（包的網址）、包裡的 key（相對輸出根目錄的路徑） */
const packOf = new Map<string, { chunk: string; rel: string }>();
/** 包的網址 → 內容（拿走的項目會刪掉，同一份資料不在包裡多留一份） */
const chunks = new Map<string, Promise<Record<string, unknown>>>();
const cached = new Map<string, Promise<unknown>>();
const installed = new Map<string, Promise<void>>();

async function fetchJsonRaw<T>(url: string): Promise<T> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}：HTTP ${r.status}`);
  return (await r.json()) as T;
}

function loadChunk(url: string): Promise<Record<string, unknown>> {
  let p = chunks.get(url);
  if (!p) {
    p = fetchJsonRaw<Record<string, unknown>>(url);
    chunks.set(url, p);
  }
  return p;
}

/**
 * 讀匯入器的 packs/index.json（base 是匯入器輸出的網址，例如 "./game/"），之後這些路徑從包裡拿；開機那組（boot）立刻開始抓。
 * 沒有 packs/（舊的匯入、沒跑 packs 步驟）就什麼都不做，照舊一個一個抓。同一個 base 只裝一次
 */
export function installPacks(base: string): Promise<void> {
  let p = installed.get(base);
  if (!p) {
    p = (async () => {
      const r = await fetch(`${base}packs/index.json`).catch(() => null);
      if (!r?.ok) return;
      const index = (await r.json().catch(() => null)) as PackIndex | null;
      for (const c of index?.chunks ?? []) {
        const chunk = `${base}packs/${c.file}`;
        for (const rel of c.files) packOf.set(`${base}${rel}`, { chunk, rel });
        if (c.boot) loadChunk(chunk).catch(() => {});
      }
    })();
    installed.set(base, p);
  }
  return p;
}

/**
 * 抓 JSON（打包過的從包裡拿，拿一次就從包裡刪掉）。不留快取：場景檔這類用完就丟的，第二次要再抓一次（改從網路抓單檔）。
 * 包抓不到（壞了、沒放進 APK）時退回抓單檔
 */
export async function fetchJsonOnce<T>(url: string): Promise<T> {
  const at = packOf.get(url);
  if (at) {
    packOf.delete(url);
    const data = await loadChunk(at.chunk).catch(() => null);
    if (data && Object.prototype.hasOwnProperty.call(data, at.rel)) {
      const v = data[at.rel];
      delete data[at.rel];
      return v as T;
    }
  }
  return fetchJsonRaw<T>(url);
}

/** 抓 JSON，同一個網址只抓一次、內容共用（索引表、ScriptableObject、TMP 字型這類全程留著的；呼叫端不可以改內容） */
export function fetchJsonCached<T>(url: string): Promise<T> {
  let p = cached.get(url);
  if (!p) {
    p = fetchJsonOnce<T>(url);
    cached.set(url, p);
    // 失敗的不留：下次再試
    p.catch(() => cached.delete(url));
  }
  return p as Promise<T>;
}

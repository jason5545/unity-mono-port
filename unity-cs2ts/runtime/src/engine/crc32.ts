// CRC32（IEEE，同 zlib.crc32）。Unity 的 build 有些名稱只存 CRC32：混音器的曝露參數（csport/unityAudio.ts）、
// 動畫曲線綁到腳本欄位的屬性名（AssetRipper 認不出時寫成 script_0x<CRC32>_…，engine/animator.ts）。
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(s: string): number {
  let c = 0xffffffff;
  for (const b of new TextEncoder().encode(s)) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

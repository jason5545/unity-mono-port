import { defineConfig } from 'vite';
import { resolve } from 'node:path';

// 工具包（../unity-cs2ts）的執行環境直接引用原始碼：@runtime → runtime/src
const TOOLKIT = resolve(import.meta.dirname, '../unity-cs2ts');

export default defineConfig({
  resolve: {
    alias: { '@runtime': resolve(TOOLKIT, 'runtime/src') },
    // three 只留一份（工具包與遊戲專案各自的 node_modules）
    dedupe: ['three'],
  },
  server: { fs: { allow: ['.', TOOLKIT] } },
  // APK（scripts/build-apk.mjs 設 MT2_APK=1）：只產程式碼，原版素材由 Gradle 直接從 public/ 打包，不複製一份 3 GB 的 public/
  publicDir: process.env.MT2_APK ? false : 'public',
  build: {
    rollupOptions: { input: { main: resolve(import.meta.dirname, 'index.html'), rng: resolve(import.meta.dirname, 'rng.html') } },
  },
});

// 全包 APK（照 diceomancer-web 的 scripts/build-apk.mjs，Jason 10/17 要）：網頁程式碼加原版素材打成一個 APK，裝到 USB 連著的手機。殼在 android/。
//
//   node scripts/build-apk.mjs            vite build（只有程式碼）→ Gradle 組 APK → adb install（清掉手機上的程式碼覆蓋檔）
//   node scripts/build-apk.mjs --code     只更新程式碼：vite build → adb push 到 app 的覆蓋資料夾 → 重開 app（不重裝 3 GB 的 APK）
//   node scripts/build-apk.mjs --no-install  只組 APK
//
// 覆蓋資料夾是 /sdcard/Android/data/<套件>/files/web/：MainActivity 先找這裡、再找 APK 的 assets。重裝 APK 時清掉。
// 原版素材只在 APK 裡（public/game/ 換了就要重裝）。產生碼（src/csport/gen）要先 npm run port。
// 需要：Android SDK（ANDROID_HOME，macOS 預設 ~/Library/Android/sdk）、JDK 17–25（macOS 找 temurin-25）、public/game/（npm run import）。
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ANDROID = join(ROOT, 'android');
const WEB_OUT = join(ROOT, 'build/apk-web');
const PKG = 'com.jason5545.mt2';
const OVERRIDE = `/sdcard/Android/data/${PKG}/files/web`;
const APK = join(ANDROID, 'app/build/outputs/apk/debug/app-debug.apk');
const args = new Set(process.argv.slice(2));

function run(cmd, argv, opts = {}) {
  console.log(`$ ${cmd} ${argv.join(' ')}`);
  const r = spawnSync(cmd, argv, { stdio: 'inherit', ...opts });
  if (r.status !== 0) throw new Error(`${cmd} 失敗（exit ${r.status}）`);
}

function javaHome() {
  if (process.env.MT2_JAVA_HOME) return process.env.MT2_JAVA_HOME;
  try {
    return execFileSync('/usr/libexec/java_home', ['-v', '25'], { encoding: 'utf8' }).trim();
  } catch {}
  return process.env.JAVA_HOME;
}

const sdk = process.env.ANDROID_HOME ?? (process.platform === 'darwin' ? join(homedir(), 'Library/Android/sdk') : '/opt/android-sdk');
if (!existsSync(join(ROOT, 'public/game/assets/project.json'))) throw new Error('public/game/ 不在：先跑 npm run import');
if (!existsSync(join(ROOT, 'src/csport/gen'))) throw new Error('src/csport/gen 不在：先跑 npm run port');

// 1. 程式碼（MT2_APK=1：vite.config.ts 不複製 public/）
run('npx', ['vite', 'build', '--outDir', WEB_OUT, '--emptyOutDir'], { cwd: ROOT, env: { ...process.env, MT2_APK: '1' } });

if (args.has('--code')) {
  run('adb', ['shell', 'rm', '-rf', OVERRIDE]);
  run('adb', ['shell', 'mkdir', '-p', OVERRIDE]);
  run('adb', ['push', `${WEB_OUT}/.`, OVERRIDE]);
  run('adb', ['shell', 'am', 'force-stop', PKG]);
  run('adb', ['shell', 'am', 'start', '-n', `${PKG}/.MainActivity`]);
  process.exit(0);
}

// 2. APK（圖示：從原版 exe 抽出，寫到 build/apk-res/）
run('uv', ['run', '-q', 'scripts/app_icon.py'], { cwd: ROOT });
writeFileSync(join(ANDROID, 'local.properties'), `sdk.dir=${sdk}\n`);
const env = { ...process.env, ANDROID_HOME: sdk, JAVA_HOME: javaHome() };
run('./gradlew', ['assembleDebug', '--console=plain'], { cwd: ANDROID, env });
console.log(`APK：${APK}（${(statSync(APK).size / 1e6).toFixed(0)} MB）`);

// 3. 安裝
if (!args.has('--no-install')) {
  run('adb', ['install', '-r', APK]);
  run('adb', ['shell', 'rm', '-rf', OVERRIDE]);
  run('adb', ['shell', 'am', 'start', '-n', `${PKG}/.MainActivity`]);
}

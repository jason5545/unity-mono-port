// 測試用的資料位置：這批單元測試的期望值是照 Diceomancer 的匯入資料與原版原始碼算的（從 diceomancer-web 搬來）。
//   CS2TS_TEST_GAME  匯入器的輸出資料夾（例如 ~/GitHub/diceomancer-native/public/game）
//   CS2TS_TEST_REF   原版參考資料夾（例如 ~/GitHub/diceomancer-native/reference）
// 沒設就用 diceomancer-native 的預設位置（跟 unity-port 放在同一層，10/27 從 unity-port 拆出去）；資料不在時測試會因為找不到檔案失敗。
import { resolve } from 'node:path';

const SIBLING = resolve(import.meta.dirname, '../../../../diceomancer-native');
export const TEST_GAME = process.env.CS2TS_TEST_GAME ?? resolve(SIBLING, 'public/game');
export const TEST_REF = process.env.CS2TS_TEST_REF ?? resolve(SIBLING, 'reference');

// Unity 內建 shader 的手寫版。它們在 build 的 unity_builtin_extra 裡，不在 AssetRipper 匯出，0e 沒轉。
// blend 狀態從 build 讀（見 HANDOFF「0d」）：UI/Default 與 Sprites/Default 都是 Blend One OneMinusSrcAlpha（預乘 alpha）。
// 運算照 Unity 2022.3 builtin shader 的寫法（UI-Default.shader、Sprites-Default.shader；未逐行對照原始碼）：
//   UI/Default      color = vertexColor × _Color；frag = (tex + _TextureSampleAdd) × color，rgb *= a
//   Sprites/Default color = vertexColor × _Color × _RendererColor；frag = tex × color，rgb *= a
// UI/Default 的 UNITY_UI_ALPHACLIP（StencilMaterial.cs:121-128 開的 keyword，clip(color.a - 0.001)）用手寫版
// 沒有 variant，改用 _UseUIAlphaClip 這個 float（StencilMaterial.cs:120 寫進材質的同一個值）判斷。
//
// 「代用」：K3 的 shader 還沒接上（0d-3b）之前，URP 的 Sprite-Unlit／Lit-Default 與自製材質先用 straight alpha 版畫，
// 會記在繪製報告的 standIn 裡，不能當成原版的樣子。

export const UNITY_VERTEX = /* glsl */ `
in vec3 position;
in vec2 uv;
in vec4 color;
uniform mat4 modelViewMatrix;
uniform mat4 projectionMatrix;
uniform vec4 _Color;
out vec2 vUv;
out vec4 vColor;
void main() {
  vUv = uv;
  vColor = color * _Color;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

export const UI_DEFAULT_FRAGMENT = /* glsl */ `
precision highp float;
uniform sampler2D _MainTex;
uniform vec4 _TextureSampleAdd;
uniform float _UseUIAlphaClip;
uniform vec4 _ClipRect;
in vec2 vUv;
in vec4 vColor;
in vec4 vMask;
out vec4 fragColor;
void main() {
  // UI-Default.shader:125-127：取樣前先把插值出來的頂點 alpha 四捨五入到 1/255（穩住 HDR 透明混合）。
  // HLSL round → DXBC round_ne（.5 取偶數）；K3（dxbc-spirv→SPIRV-Cross）把 round_ne 轉成 roundEven
  //（public/game/shaders 各 GLSL 實證，如 Hidden_Universal Render Pipeline_SubpixelMorphologicalAntialiasing/pass1_unnamed_frag_12.glsl:118），這裡照同一個寫法。
  // vColor 是 in（GLSL 唯讀），複製到區域變數再改 alpha（HLSL 的 color 是參數可寫，這裡語意等價）
  vec4 col = vColor;
  col.a = roundEven(col.a * 255.0) * (1.0 / 255.0);
  vec4 c = (texture(_MainTex, vUv) + _TextureSampleAdd) * col;
  // UNITY_UI_CLIP_RECT（UI-Default.shader:131-134）。沒開 keyword 的呼叫端把 _ClipRect 設超大矩形，
  // 這裡無條件算（原版 vert 本來就無條件算 mask，keyword 只差 frag 這三行）。
  vec2 m = clamp((_ClipRect.zw - _ClipRect.xy - abs(vMask.xy)) * vMask.zw, 0.0, 1.0);
  c.a *= m.x * m.y;
  if (_UseUIAlphaClip > 0.5 && c.a < 0.001) discard; // UNITY_UI_ALPHACLIP：clip(color.a - 0.001)
  c.rgb *= c.a;
  fragColor = c;
}`;

/** UI/Default 的頂點加 UNITY_UI_CLIP_RECT 的 mask 輸出（其餘同 UNITY_VERTEX）。
 * 原版 vert 沒有 #ifdef（mask 無條件算，UI-Default.shader:105），keyword 只在 frag（:131）。
 * 沒有 RectMask2D 時 _ClipRect 給超大矩形讓 m 恆為 1（見 sceneRenderer 的 material()）。 */
export const UI_CLIP_VERTEX = /* glsl */ `
in vec3 position;
in vec2 uv;
in vec4 color;
uniform mat4 modelViewMatrix;
uniform mat4 projectionMatrix;
uniform vec4 _Color;
uniform vec4 _ClipRect;
uniform vec2 _UIMaskSoftness;
uniform vec4 _ScreenParams;
out vec2 vUv;
out vec4 vColor;
out vec4 vMask;
void main() {
  vUv = uv;
  vec4 clipPos = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  // UI-Default.shader :99-105（UNITY_UI_CLIP_RECT 的 pixelSize／clampedRect／mask）
  vec2 pixelSize = clipPos.w / abs(mat2(projectionMatrix) * _ScreenParams.xy);
  vec4 clampedRect = clamp(_ClipRect, vec4(-2e10), vec4(2e10));
  vMask = vec4(position.xy * 2.0 - clampedRect.xy - clampedRect.zw, 0.25 / (0.25 * _UIMaskSoftness + abs(pixelSize)));
  vColor = color * _Color;
  gl_Position = clipPos;
}`;

export const SPRITES_DEFAULT_FRAGMENT = /* glsl */ `
precision highp float;
uniform sampler2D _MainTex;
in vec2 vUv;
in vec4 vColor;
out vec4 fragColor;
void main() {
  vec4 c = texture(_MainTex, vUv) * vColor;
  c.rgb *= c.a;
  fragColor = c;
}`;

/** 代用：不預乘，配 SrcAlpha OneMinusSrcAlpha */
export const STAND_IN_FRAGMENT = /* glsl */ `
precision highp float;
uniform sampler2D _MainTex;
in vec2 vUv;
in vec4 vColor;
out vec4 fragColor;
void main() {
  fragColor = texture(_MainTex, vUv) * vColor;
}`;

/** 最後一步：linear 的 render target 轉回 sRGB 輸出到畫面 */
export const BLIT_VERTEX = /* glsl */ `
in vec3 position;
out vec2 vUv;
void main() {
  vUv = position.xy * 0.5 + 0.5;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}`;

export const BLIT_FRAGMENT = /* glsl */ `
precision highp float;
uniform sampler2D tSource;
in vec2 vUv;
out vec4 fragColor;
vec3 linearToSRGB(vec3 c) {
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(vec3(0.0031308), c));
}
void main() {
  vec4 c = texture(tSource, vUv); // render target 是 SRGB8_ALPHA8，取樣時 GPU 已經轉成線性
  fragColor = vec4(linearToSRGB(c.rgb), 1.0);
}`;

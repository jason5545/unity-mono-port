// 用 three.js 畫 Unity 場景（0d-3a）。
//
// 座標：場景樹照 Unity 座標算（左手系、z 往畫面裡），交給 three.js 前統一乘 FLIP_Z（右手系、z 往畫面外）。
// 色彩：linear 流程。貼圖用 SRGB8_ALPHA8（取樣時 GPU 轉成線性）、畫進 SRGB8_ALPHA8 的 render target（混色在線性空間，
//       寫入時轉回 sRGB，跟 Unity 的 sRGB backbuffer 一樣），最後 blit 到畫面時再把線性值轉成 sRGB。
// 順序：照 Unity 2D 的透明物件規則自己排好，three.js 只照 renderOrder 畫（不開深度測試）：
//       sorting layer → order in layer → render queue → 距攝影機遠的先畫 → 場景樹順序（同一個 Canvas 裡就是 uGUI 的順序）。
//
// 這一版有畫：SpriteRenderer、Image（Simple、Sliced）、Light2D 點光源（light2d.ts）、TMP 文字（排版由 options.text 注入，
// 素材與動態字型 atlas 在 src/runtime/font/；TextContext 用 text/textContext.ts 的共用算法）、Mask 的 stencil 裁切
// （ui/mask.ts 算 uGUI 的那組值，這裡套成 GL 狀態）、RawImage（Texture2D 資產或攝影機畫進去的 RenderTexture）。
// Overlay Canvas 底下的 Image 與文字：layout 照 Unity 放在螢幕像素空間，畫的時候換到繪製用攝影機前 planeDistance（drawWorld），
// 排序鍵第一項用 OVERLAY_LAYER，畫在所有攝影機之後（第 2 輪裁決 4 的排序；10/16 起排版不再用攝影機的數學）。
// 材質的 shader 在 0e 的清單裡就用 K3 轉出的 GLSL（unityShader.ts）；UI/Default、Sprites/Default 用手寫版。
//
// 第 1 輪（10/10，規格 4.1、4.2 與裁決 3–7、10–13）：LineRenderer（lineMesh.ts 建網格，K3 的 DottedLine）與
//   SpriteMask（spriteMaskRange.ts 的範圍與 stencil 規則）。
//   LineRenderer：網格建在節點本地座標；側向量在世界座標算（寬度是世界單位），再除以節點縮放換回本地，所以寬度不吃 Transform 縮放；
//     距離用世界包圍盒中心（depthOf）；SetPosition、SetColor 之後下一格 refresh 重建網格。
//   SpriteMask：寫入與清除是兩片手寫網格（maskMaterial，只寫 bit 0x80、不寫顏色），排序鍵的 order 欄放 back＋0.25（寫入）與
//     front＋0.75（清除），不靠距離；SpriteRenderer、LineRenderer 的 m_MaskInteraction 1 與 2 套 stencil（applyMaskState）。
//     interaction 1 不在任何範圍內時範圍外的 bit 是 0，Equal 不過，所以不畫；interaction 2 不在範圍內照常畫。
//   刻意不做（寫進差異）：多點接頭、圓角與圓頭（記 skipped）、多 key 寬度曲線的切線插值（線性近似）、loop、非 View 的 alignment 與
//     非 Stretch／Tile 的 textureMode（整條不畫，記 skipped）、高亮線的流動（時間固定 0，裁決 8）、多個遮罩範圍重疊時共用 0x80、
//     SpriteRenderer 的距離仍用 node.world（裁決 4，不在範圍內）、Sprites/Mask 的材質不用 K3（自己手寫）。
//
// 執行中重產（0d 接線）：TMP 與 Image 在建置時不跳過未啟用／關閉的元件（之後啟用要能畫），每格比對
// meshRefreshKey（元件整份 JSON＋rect＋lossyScaleY＋CanvasRenderer 顏色＋CanvasGroup alpha＋stencil 狀態…，
// 見 meshRefresh.ts），變了就重產網格——對應 TMP 的 m_havePropertiesChanged／OnRectTransformDimensionsChange →
// OnPreRenderCanvas 與 Graphic 的 SetVerticesDirty／SetMaterialDirty。顯示與否每格照 activeInHierarchy 與 m_Enabled 決定。
//
// 執行中新增／移除子樹（Object.Instantiate／Destroy，TMP_Dropdown.Show／Hide 用）：addSubtree(root) 用跟 build()
// 完全相同的規則把一棵子樹加進來（Image／TMP 走 buildManaged，含 managed 清單與每格重產偵測；SpriteRenderer 走
// addSpriteRenderer），removeSubtree(root) 把 drawable 與 managed entry 清乾淨。排序 key 的最後一項是 node.order
// （scene.ts:136-144 的深度優先計數），結構改變後每格重算（refreshOrderKeys），插入的子樹才不會跟既有物件亂序。
// CanvasRenderer 顏色（Selectable 的 ColorTint 存在 CanvasRenderer 上，canvasRenderer.ts）：畫的時候乘進頂點色——
// gamma 值相乘後整體轉線性（Unity 原生 batching 是「乘進 UIVertex 顏色」再隨頂點色轉線性；原生程式碼看不到，
// 順序未查證。選 gamma 相乘的理由：ColorTint 的顏色是設計師在 inspector 挑的 sRGB 值，這個順序下白底 × 0.96 灰
// 在螢幕上就是 0.96 灰；alpha 不轉線性，直接相乘）。

import * as THREE from 'three';
import { imageMesh, type ImageForMesh } from '../ui/imageMesh';
import {
  activeMaskNodes,
  DEFAULT_STENCIL,
  graphicStencil,
  isDefaultStencil,
  maskSubtree,
  STENCIL_PROPERTIES,
  stencilFromMaterial,
  stencilKey,
  subtreeLastOrder,
  type GraphicStencil,
  type StencilState,
} from '../ui/mask';
import { slicedSpriteMesh } from './spriteSliced';
import type { AssetDB, MaterialInfo, SpriteInfo } from '../unity/assets';
import { colorToLinear, linearToGamma } from '../unity/color';
import { canvasDisabled, screenSpaceCameraMatrix, type CameraInfo, type CanvasInfo, type SceneGraph, type SceneNode } from '../unity/scene';
import type { ColorRGBA, ComponentData, Ref, SceneFile, SpriteMeshRecord } from '../unity/types';
import { applyStencilState, createProgram, drawPasses, fillBlock, stateValue, type SamplerKind, type ShaderLibrary, type UnityProgram } from './unityShader';
import {
  forgetRendererMaterial,
  rendererMaterialCopy,
  rendererMaterialIfAny,
  rendererTextureGuid,
  setRendererFloat,
  setRendererTextureRef,
} from './rendererMaterial';
import type { GlyphAtlas } from '../font/atlas';
import type { GameTextAssets } from '../font/textAssets';
import type { TextAssets, TextContext, TextMeshResult, TmpComponentData } from '../text/types';
import { textContextOf } from '../text/textContext';
import type { TmpVertexHook } from '../text/vertexHooks';
import { canvasMeshOf, existingCanvasRendererState, getCanvasRendererColor, isCanvasMeshClass } from '../ui/canvasRenderer';
import { graphicMeshModifier } from '../ui/graphicMeshModifier';
import { componentKind } from '../unity/componentKind';
import { isWideLayout, isWideMoved, wideMovedGenerationOf } from '../ui/canvas';
import type { RectClipRegistry } from '../ui/rectMask2d';
import { meshRefreshKey } from './meshRefresh';
import { PostProcessStack } from './postProcess';
import { RemoteImage } from './gfx/client';
import type { RenderThread } from './gfx/thread';
import type { GfxContext } from './gfx/client';
import { JOB_STREAM } from './gfx/protocol';
import type { PostProcessFrame } from '../csport/unityPostProcess';
import type { ParticleWorld } from '../particles/manager';
import { buildTrailRendererGeometry, type TrailWorld } from '../particles/trailRenderer';
import { buildParticles, buildTrails, parseVertexStreams, streamLayout, type ParticleCamera, type ParticleGeometry } from '../particles/particleMesh';
import { meshAssetOf, meshInstanceOf, meshKeyOf, type MeshAssetRecord, type MeshInstance } from '../unity/meshes';
import { builtinKeywords, builtinLightGlobals, type BuiltinLightingInput } from './builtinLighting';
import { CHANNEL_SEMANTIC, blackCubeTexture, forwardLightGlobals, meshAttributes, type LightEntry } from './mesh3d';
import { buildLineMesh, localBoundsCenter, type LineBuildResult, type LineStyle, type Vec3 } from './lineMesh';
import {
  maskClearKeyOrder,
  maskClearState,
  maskInteractionOf,
  maskRangeOf,
  maskWriteKeyOrder,
  maskWriteState,
  maskedRendererState,
} from './spriteMaskRange';
import { gammaToLinear } from '../unity/color';
import {
  CLEAR_DEPTH,
  CLEAR_SKYBOX,
  CLEAR_SOLID_COLOR,
  clearFlagsOf,
  cullingMask,
  firstVisibleCamera,
  inCullingMask,
  overlayProjection,
  projectionOf,
  screenCameras,
  targetCameras,
  viewportPixels,
} from './cameraStack';
import {
  applyToSortingLayers,
  blendFactors,
  LIGHT_TYPE_GLOBAL,
  LIGHT_TYPE_POINT,
  lightLookupTexture,
  pointLightMesh,
  type BlendStyle,
  type Light2DData,
} from './light2d';
import {
  BLIT_FRAGMENT,
  BLIT_VERTEX,
  SPRITES_DEFAULT_FRAGMENT,
  STAND_IN_FRAGMENT,
  UI_DEFAULT_FRAGMENT,
  UI_CLIP_VERTEX,
  UNITY_VERTEX,
} from './builtinShaders';

const FLIP_Z = new THREE.Matrix4().makeScale(1, 1, -1);

/** 遮罩的頂點著色器（手寫版；只要位置與 uv） */
const MASK_VERTEX = /* glsl */ `
in vec3 position;
in vec2 uv;
uniform mat4 modelViewMatrix;
uniform mat4 projectionMatrix;
out vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

/** 遮罩的片段著色器：照 Sprites-Mask.shader 的 clip(a − _Cutoff)（alpha 小於 cutoff 丟掉，≥ 保留），不寫顏色 */
const MASK_FRAGMENT = /* glsl */ `
precision highp float;
uniform sampler2D _MainTex;
uniform float _Cutoff;
in vec2 vUv;
out vec4 fragColor;
void main() {
  if (texture(_MainTex, vUv).a < _Cutoff) discard;
  fragColor = vec4(0.0);
}`;

/** 白色（頂點色的預設值） */
const WHITE: ColorRGBA = { r: 1, g: 1, b: 1, a: 1 };

/** LineRenderer 的 m_Parameters 用到的欄位（序列化的 JSON 形狀） */
interface LineParamsData {
  widthMultiplier?: number;
  widthCurve?: { m_Curve?: { time: number; value: number }[] };
  colorGradient?: Record<string, unknown> & { m_NumColorKeys?: number; m_NumAlphaKeys?: number; m_Mode?: number };
  alignment?: number;
  textureMode?: number;
  textureScale?: { x: number; y: number };
  numCornerVertices?: number;
  numCapVertices?: number;
}

/** gradient 的時間是 uint16（65535 ＝ 1） */
const GRADIENT_TIME = 1 / 65535;

/** LineRenderer 的線參數（照序列化資料整理；網格與重建判定都用它） */
function lineStyleOf(comp: ComponentData): LineStyle {
  const p = (comp.m_Parameters as LineParamsData | undefined) ?? {};
  const g = p.colorGradient;
  const nColor = Math.max(0, Math.min(8, g?.m_NumColorKeys ?? 0));
  const nAlpha = Math.max(0, Math.min(8, g?.m_NumAlphaKeys ?? 0));
  const keyAt = (i: number) => g?.[`key${i}`] as { r: number; g: number; b: number; a: number } | undefined;
  const colorKeys: { time: number; r: number; g: number; b: number }[] = [];
  for (let i = 0; i < nColor; i++) {
    const k = keyAt(i);
    if (k) colorKeys.push({ time: ((g?.[`ctime${i}`] as number | undefined) ?? 0) * GRADIENT_TIME, r: k.r, g: k.g, b: k.b });
  }
  const alphaKeys: { time: number; a: number }[] = [];
  for (let i = 0; i < nAlpha; i++) {
    const k = keyAt(i);
    if (k) alphaKeys.push({ time: ((g?.[`atime${i}`] as number | undefined) ?? 0) * GRADIENT_TIME, a: k.a });
  }
  return {
    widthMultiplier: p.widthMultiplier ?? 1,
    widthKeys: (p.widthCurve?.m_Curve ?? []).map((k) => ({ time: k.time, value: k.value })),
    colorKeys,
    alphaKeys,
    gradientMode: g?.m_Mode ?? 0,
    alignment: p.alignment ?? 0,
    textureMode: p.textureMode ?? 0,
    textureScaleX: p.textureScale?.x ?? 1,
    numCornerVertices: p.numCornerVertices ?? 0,
    numCapVertices: p.numCapVertices ?? 0,
    loop: ((comp.m_Loop as number | undefined) ?? 0) !== 0,
    useWorldSpace: ((comp.m_UseWorldSpace as number | undefined) ?? 0) !== 0,
  };
}

/** m_Positions（SetPosition 寫的就是這個陣列） */
function linePointsOf(comp: ComponentData): Vec3[] {
  const pts = (comp.m_Positions as { x: number; y: number; z: number }[] | undefined) ?? [];
  return pts.map((p) => [p.x, p.y, p.z] as const);
}

/** LineRenderer 的材質 guid（m_Materials[0]）；換材質會換 program，要非同步重產 */
function lineMaterialGuidOf(comp: ComponentData): string {
  const first = ((comp.m_Materials as { guid?: string }[] | undefined) ?? [])[0];
  return first?.guid ?? '';
}

/** 重建網格的判定：點、線參數、節點矩陣的縮放與旋轉（位移不影響網格：shader 每格用節點矩陣） */
function lineSignatureOf(comp: ComponentData, node: SceneNode): string {
  const e = node.world.elements;
  return JSON.stringify([linePointsOf(comp), lineStyleOf(comp), [e[0], e[1], e[2], e[4], e[5], e[6], e[8], e[9], e[10]]]);
}

/** 攝影機往前的方向（世界座標）：正交攝影機是 (0, 0, 1) 經攝影機旋轉後的結果 */
function forwardOf(cam: CameraInfo): Vec3 {
  const f = new THREE.Vector3(0, 0, 1).transformDirection(cam.node.world);
  return [f.x, f.y, f.z];
}

/** 用來還原 K3 材質 stencil 的快照（applyMaskState 第一次改之前記下來） */
type StencilProps = Pick<THREE.Material, 'stencilWrite' | 'stencilFunc' | 'stencilRef' | 'stencilFuncMask' | 'stencilWriteMask' | 'stencilFail' | 'stencilZFail' | 'stencilZPass'>;

function captureStencil(m: THREE.Material): StencilProps {
  return {
    stencilWrite: m.stencilWrite,
    stencilFunc: m.stencilFunc,
    stencilRef: m.stencilRef,
    stencilFuncMask: m.stencilFuncMask,
    stencilWriteMask: m.stencilWriteMask,
    stencilFail: m.stencilFail,
    stencilZFail: m.stencilZFail,
    stencilZPass: m.stencilZPass,
  };
}

function restoreStencil(m: THREE.Material, s: StencilProps): void {
  Object.assign(m, s);
}

/** Overlay Canvas 底下的 Image 的排序鍵第一項：比任何 sorting layer 都大，所以畫在所有攝影機與世界物件之後（Unity 的 Overlay 規則） */
const OVERLAY_LAYER = 1e6;
/** 3D 網格（MeshRenderer：骰盤與骰子）：一般圖層之後、Overlay Canvas 之前（render/mesh3d.ts 檔頭） */
const MESH3D_LAYER = OVERLAY_LAYER - 1;

type ShaderKind = 'ui' | 'sprite' | 'standIn';

interface Drawable {
  mesh: THREE.Mesh;
  key: [number, number, number, number, number]; // layer、order、queue、-距離、場景樹順序
  label: string;
  /** 每格：顯示與否看 node.activeInHierarchy 與元件的 m_Enabled；手寫 shader 的網格要重設矩陣 */
  node?: SceneNode;
  comp?: ComponentData;
  handwritten?: boolean;
  /** TMP 子網格的 materialReferenceIndex（0 = 主網格）；除錯介面用 */
  materialIndex?: number;
  /** 每格的額外更新（換 sprite 等） */
  refresh?: () => void;
  /** SpriteRenderer 建置時沒有 sprite 的佔位（空網格，什麼都不畫；sprite 換上來之後由 refresh 補上）。不計進 report.drawn（spawn-check 的差分只算真的畫得出來的）。 */
  placeholder?: boolean;
  /** Mask 的 unmask（pop）繪製：指向那個 Mask 所在的節點，排序要排在它的子樹之後（Mask.cs:135-136、146-147） */
  popFor?: SceneNode;
  /** key 最後一項在 node.order（pop 是子樹最後一個 order）之上的偏移：TMP 子網格是 materialIndex × 1e-3、pop 是 0.5 */
  orderBias?: number;
  /** 幾何跟同一個 ManagedEntry 的另一個 drawable 共用（pop 繪製），disposeDrawable 不重複丟 */
  sharesGeometry?: boolean;
  /** debugIsolate 藏掉的旗標：updateDrawable 照常算 normal 能見度，isolated 只額外藏（不會重新啟用） */
  isolated?: boolean;
  /**
   * 排序鍵的深度項（key[3]＝-距離）每格重算：Unity 的透明排序是每格依實際位置排，不是建立時的位置。
   * 有的話 refreshOrderKeys 每格更新 key[3]：3D 的 SpriteRenderer、3D 的 TextMeshPro 深度來自節點的世界位置（卡牌在手上重排時 z 會變，
   * 建立時的深度會讓同一張牌的卡名與底圖排錯前後）；世界空間 Canvas 底下的 UI（Image、TextMeshProUGUI 主網格與子網格、遮罩的 pop）
   * 深度來自 canvas 節點的世界位置，卡牌移動後 canvas 跟著動，建網格時算的值會過期（第一張卡的說明被底圖蓋住就是這樣來的），所以也每格算（uiDepthOf）。
   * Screen Space 的 UI 深度是固定的 planeDistance，沒有 depthOf。Unity 的規則（世界空間 Canvas 依攝影機距離與其他透明物件一起排）：未查證。
   */
  depthOf?: () => number;
  /** built-in 的天空盒（不透明之後、透明之前畫；renderSkybox） */
  sky?: boolean;
  /** built-in：這一趟要畫它之前叫（粒子照這台攝影機重產網格；cam 是 null 的是 Overlay 那一趟） */
  beforePass?: (cam: CameraInfo | null) => void;
}

/** 每格會重產網格的元件（TMP 與 Image）。建置時不跳過未啟用的；之後啟用、屬性變更、rect 變更都靠 key 比對重產 */
interface ManagedEntry {
  /** LineRenderer 第 3 輪起走受管路徑：材質 guid 變了就非同步重產（幾何變更仍由每格的 refresh 同步處理） */
  kind: 'TextMeshProUGUI' | 'TextMeshPro' | 'Image' | 'RawImage' | 'LineRenderer' | 'MeshRenderer' | 'ParticleSystemRenderer' | 'TrailRenderer' | 'CanvasMesh';
  node: SceneNode;
  comp: ComponentData;
  /** 目前在場景裡的子網格（重產時整批換掉） */
  drawables: Drawable[];
  /** 上一次產生網格時的 meshRefreshKey */
  key: string;
  /** 非同步重產進行中（完成前的 key 變更由下一格的重比對補上） */
  busy: boolean;
  /** 最近一次「要畫」（節點啟用、元件與所在 Canvas 開著）的 frameCount；上一格不是就算這一格才出現 */
  shownAt?: number;
  /** 出現時內容已經過期：重產完成前不畫（frame() 設、regenerate 完成時解除） */
  hold?: boolean;
  /** 最近一次產生時 TMP 排版回報的 warning */
  warnings: string[];
}

export interface RenderReport {
  drawn: Record<string, number>;
  /** drawn 裡建置當下未啟用（activeInHierarchy false 或 m_Enabled 0）的數量；之後啟用才會真的畫出 */
  drawnInactive?: Record<string, number>;
  /** TMP 排版回報的 warning → 次數 */
  textWarnings?: Record<string, number>;
  standIn: Record<string, number>; // 材質名 → 次數
  skipped: Record<string, number>; // 原因 → 次數
  unityShaders: Record<string, number>; // 用 K3 GLSL 畫的 shader → 次數
  unfilled: Record<string, number>; // 沒填到的 cbuffer 欄位 → 次數
}

/** 一個繪製物件的資料，K3 shader 填 cbuffer 用 */
interface DrawContext {
  world: THREE.Matrix4;
  /** 有的話每格用它當下的世界矩陣（動畫、腳本會動 transform） */
  node?: SceneNode;
  /** SpriteRenderer 的元件：有元件專屬的材質複本（rendererMaterial.ts）就讀複本，沒有才讀共用的 mat */
  comp?: ComponentData;
  mainTexture: THREE.Texture | null;
  mat: MaterialInfo;
  /** 這個物件專用的全域變數（光照參數等），優先於共用的 */
  globals?: Record<string, ArrayLike<number>>;
  /** 依 shader 屬性名指定的貼圖（_ShapeLightTexture0、_LightLookup…） */
  textures?: Record<string, THREE.Texture>;
  /** built-in：烘焙光照圖的 unity_LightmapST（Renderer.lightmapScaleOffset）；沒有光照圖時沒有 */
  lightmapST?: number[];
}

/** 一張光照貼圖：某個 sorting layer、某個混合樣式 */
interface LightTarget {
  layer: number;
  style: number;
  target: THREE.WebGLRenderTarget;
  scene: THREE.Scene;
  clear: THREE.Color;
}

export interface SceneRendererOptions {
  /** 光的顏色要不要從 gamma 轉成線性。URP 用 CommandBuffer.SetGlobalColor 傳，它在 linear 專案會不會轉，
   *  原生程式碼看不到、文件沒寫（Shader.SetGlobalColor 的文件寫明不轉），未查證。預設不轉：Jason 10/5 看兩種截圖，
   *  不轉的比較像原版主選單 */
  lightColorToLinear?: boolean;
  /**
   * 繪製管線：'srp'（預設；URP 2D Renderer，Diceomancer：一台攝影機、全部照 2D 透明物件規則排）或 'builtin'（內建管線，MT2：
   * 多台攝影機照 depth 疊、cullingMask、透視、深度測試，Overlay Canvas 最後疊上；cameraStack.ts）。boot 照專案設定選（pipelineOf）
   */
  pipeline?: 'srp' | 'builtin';
  /** TMP 排版（src/runtime/text 的 generateText）與它要的素材；沒給就跳過文字 */
  text?: {
    generate: (component: TmpComponentData, ctx: TextContext, assets: TextAssets) => TextMeshResult;
    assets: GameTextAssets;
  };
  /**
   * render thread（render/gfx/thread.ts）：three.js 拿 GfxCanvas／GfxContext，gl 呼叫寫成指令交給 worker 的 OffscreenCanvas 畫。
   * 沒給就照舊在主執行緒畫（diceomancer-web 等沒開的遊戲）
   */
  gfx?: RenderThread | null;
}

/** three.js 的 program 快取對 RawShaderMaterial 只看 vertex 與 fragment 原始碼（加 defines，這裡的材質都沒有） */
function shaderSourceKey(m: THREE.ShaderMaterial): string {
  return `${m.vertexShader}\0${m.fragmentShader}\0${JSON.stringify(m.defines ?? {})}`;
}

function bump(map: Record<string, number>, k: string, n = 1) {
  map[k] = (map[k] ?? 0) + n;
}

/** three.js 貼圖要綁的取樣器型別（render target、DataTexture 這些都是 2D） */
function textureKind(t: THREE.Texture): SamplerKind {
  return 'isDataArrayTexture' in t ? '2DArray' : 'isData3DTexture' in t ? '3D' : 'isCubeTexture' in t ? 'Cube' : '2D';
}

/**
 * TMP 3.0.x 的頂點 UV（TMP_Text.PackUV：(int)(x·511)·4096 + (int)(y·511)；shader 用 /4096 與 ×1/512 解回來）：
 * uv0 = (u, v)，uv2 = (PackUV(faceU, faceV), xScale)。輸入是 3.2 格式的 uv0（xyzw）與 uv2（xy）
 */
function legacyTmpUvs(uvs0: Float32Array, uvs2: Float32Array): Record<string, THREE.BufferAttribute> {
  const n = uvs0.length / 4;
  const uv0 = new Float32Array(n * 2);
  const uv2 = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) {
    uv0[i * 2] = uvs0[i * 4];
    uv0[i * 2 + 1] = uvs0[i * 4 + 1];
    uv2[i * 2] = Math.trunc(uvs2[i * 2] * 511) * 4096 + Math.trunc(uvs2[i * 2 + 1] * 511);
    uv2[i * 2 + 1] = uvs0[i * 4 + 3];
  }
  return { TEXCOORD0: new THREE.BufferAttribute(uv0, 2), TEXCOORD1: new THREE.BufferAttribute(uv2, 2) };
}

/** 某節點為根的子樹（含自己），深度優先 */
function subtreeNodes(root: SceneNode, out: SceneNode[] = []): SceneNode[] {
  out.push(root);
  for (const c of root.children) subtreeNodes(c, out);
  return out;
}

/**
 * GL 的投影矩陣（three.js：near 的 clip z ＝ −w、far ＝ +w）→ Unity 在 D3D 上給 shader 的 GPU 投影矩陣（GL.GetGPUProjectionMatrix，
 * 反向深度：near ＝ w、far ＝ 0）。z_d3d ＝ (w − z_gl) / 2，只換第三列；x、y、w 不變（這裡畫進自己的 render target，不翻 y）
 */
export function d3dProjection(gl: THREE.Matrix4): THREE.Matrix4 {
  const e = gl.elements; // column-major：第 r 列第 c 行在 e[c * 4 + r]
  const out = gl.clone();
  for (let c = 0; c < 4; c++) out.elements[c * 4 + 2] = 0.5 * (e[c * 4 + 3] - e[c * 4 + 2]);
  return out;
}

/** uGUI 的 MaskableGraphic 子類才吃 Mask 的 stencil（3D 的 TextMeshPro 不是 Graphic） */
function isMaskableKind(kind: ManagedEntry['kind']): boolean {
  return kind === 'Image' || kind === 'RawImage' || kind === 'TextMeshPro' || kind === 'TextMeshProUGUI' || kind === 'CanvasMesh';
}

/** 頂點色整批換掉（SpriteRenderer.m_Color 執行期改動用；顏色在線性空間，alpha 不轉）。
 *  K3 的網格屬性名是 shader 的 vertexInput 名字（unityGeometry 記在 userData.colorAttrName，例如 'COLOR'），
 *  手寫的用 'color'（見 makeMesh）。以前只找 'COLOR0'，K3 的 SpriteRenderer 改色沒有套上去，
 *  戰鬥的回合橫幅（9-Sliced，m_Color.a 已被 BattleTurnIndicator 的最終狀態改成 0）因此一直看得到。 */
function applyVertexColor(mesh: THREE.Mesh, color: ColorRGBA): void {
  const name = mesh.geometry.userData.colorAttrName as string | undefined;
  const attr = (((name ? mesh.geometry.getAttribute(name) : null) ?? mesh.geometry.getAttribute('COLOR0') ?? mesh.geometry.getAttribute('color')) as THREE.BufferAttribute | null | undefined) ?? undefined;
  if (!attr) return;
  for (let i = 0; i < attr.count; i++) attr.setXYZW(i, color.r, color.g, color.b, color.a);
  attr.needsUpdate = true;
  const arr = mesh.userData.vertexColors as Float32Array | undefined;
  if (arr) for (let i = 0; i < attr.count; i++) arr.set([color.r, color.g, color.b, color.a], i * 4);
}

function sameColor(a: ColorRGBA, b: ColorRGBA): boolean {
  return Math.abs(a.r - b.r) < 1e-6 && Math.abs(a.g - b.g) < 1e-6 && Math.abs(a.b - b.b) < 1e-6 && Math.abs(a.a - b.a) < 1e-6;
}

/** shader 屬性名 → 型別（Color 0、Vector 1…）；每個 shader 只建一次（fillCbuffers 每格每個物件都要查） */
const propTypeCache = new WeakMap<UnityProgram["shader"], Map<string, number>>();
/**
 * 時間全域（Unity 手冊 Built-in shader variables）：_Time ＝ (t/20, t, 2t, 3t)；_SinTime／_CosTime ＝ t/8、t/4、t/2、t 的正弦／餘弦；
 * unity_DeltaTime ＝ (dt, 1/dt, smoothDt, 1/smoothDt)；URP 的 _TimeParameters ＝ (t, sin t, cos t, 0)
 */
export function shaderTimeGlobals(t: number, dt: number, smoothDt: number): Record<'_Time' | '_SinTime' | '_CosTime' | 'unity_DeltaTime' | '_TimeParameters', number[]> {
  const inv = (x: number) => (x > 0 ? 1 / x : 0);
  return {
    _Time: [t / 20, t, t * 2, t * 3],
    _SinTime: [Math.sin(t / 8), Math.sin(t / 4), Math.sin(t / 2), Math.sin(t)],
    _CosTime: [Math.cos(t / 8), Math.cos(t / 4), Math.cos(t / 2), Math.cos(t)],
    unity_DeltaTime: [dt, inv(dt), smoothDt, inv(smoothDt)],
    _TimeParameters: [t, Math.sin(t), Math.cos(t), 0],
  };
}

/**
 * 材質的顏色屬性進 cbuffer 的值：Color 型別（m_Type 0）在 linear 色彩空間轉線性；Vector（1）不轉；標了 [HDR] 的顏色不轉。
 * [HDR] 不轉是推論（2022.3 的文件沒寫；Unity 6 的 Material.SetColor 文件反而寫 HDR 顏色當 gamma 轉）：跟原版（Windows 2.2.1）的畫面對照，
 * 戰鬥房間的火盆（Shader Graphs/FireVertical 的 HDR 色 _Color_1 ＝ (1, 0.1296, 0)）轉了線性之後核心到不了原版的橘黃
 *（G 的上限 0.0153 × _Mask_Power 18.54 × _Power 0.91 ≈ 0.26），不轉的才對得上（Jason 10/17 看兩邊的畫面確認）
 */
export function materialColorConstant(c: ColorRGBA, isColor: boolean, hdr: boolean): number[] {
  const lin = isColor && !hdr ? colorToLinear(c) : c;
  return [lin.r, lin.g, lin.b, lin.a];
}

/** shader 屬性名 → 有沒有 [HDR]（flags 的 16，ShaderPropertyFlags.HDR）；fillCbuffers 決定顏色要不要轉線性 */
const hdrPropCache = new WeakMap<UnityProgram['shader'], Set<string>>();
function hdrPropsOf(shader: UnityProgram['shader']): Set<string> {
  let m = hdrPropCache.get(shader);
  if (!m) hdrPropCache.set(shader, (m = new Set(shader.properties.filter((p) => p.type === 0 && (p.flags & 16) !== 0).map((p) => p.name))));
  return m;
}

function propTypesOf(shader: UnityProgram["shader"]): Map<string, number> {
  let m = propTypeCache.get(shader);
  if (!m) propTypeCache.set(shader, (m = new Map(shader.properties.map((p) => [p.name, p.type]))));
  return m;
}

/**
 * 這個繪製物件的 _UIMaskSoftnessX／_UIMaskSoftnessY（依據見 fillCbuffers 裡那段註解）：
 * 讀 CanvasRenderer 的 clippingSoftness（RectMask2D.cs:222、226 → MaskableGraphic.cs:172-175 寫的），
 * 沒有 CanvasRenderer（3D 的 TextMeshPro）或沒有人寫過就是 (0, 0)。
 */
function uiMaskSoftnessOf(graph: SceneGraph | null, node: SceneNode | undefined): Record<string, ArrayLike<number>> {
  const cr = graph && node ? graph.component(node, 'CanvasRenderer') : undefined;
  const soft = (cr?.$clippingSoftness as { x: number; y: number } | undefined) ?? { x: 0, y: 0 };
  return { _UIMaskSoftnessX: [soft.x], _UIMaskSoftnessY: [soft.y] };
}

/**
 * 節點還在不在場景裡：規則同 mouseEvents.ts 的 isLiveNode（graph.nodes.get(node.id) === node）。
 * Object.Destroy 之後為 false（detach 把整棵子樹從 nodes 刪掉）。不 import isLiveNode，它吃 World，這裡只有 SceneGraph。
 */
function isLiveSceneNode(graph: SceneGraph, node: SceneNode): boolean {
  return graph.nodes.get(node.id) === node;
}

/** 手寫 UI 材質沒掛 RectMask2D 時的 _ClipRect：超大矩形，saturate 後 m 恆為 1（等效 UNITY_UI_CLIP_RECT 關著） */
const NO_CLIP: [number, number, number, number] = [-1e7, -1e7, 1e7, 1e7];

/** uGUI 的繪製物件（屬於 Canvas 的：Image、RawImage、TextMeshProUGUI、Mask 的 pop）；SpriteRenderer、3D 文字、MeshRenderer 不算，Canvas 底下也照自己畫 */
/**
 * 決定排序的 Canvas：巢狀 Canvas 沒開 overrideSorting 時沿用父 Canvas 的 sorting layer／order（Unity 手冊 Canvas 的 Override Sorting），
 * 一路往上到根或開了 overrideSorting 的那一層。以前直接用最近的 Canvas 自己的值：卡牌的 CardCanvas（order 0、沒開 override）
 * 在 order 11 的選卡畫面裡被排到背景後面
 */
function sortingCanvasOf(cv: CanvasInfo): CanvasInfo {
  let c = cv;
  while ((c.data.m_OverrideSorting as number | undefined) !== 1 && c.node.parent?.canvas) c = c.node.parent.canvas;
  return c;
}

/** Canvas 底下的繪製物件排序鍵的前兩項：Overlay 是 OVERLAY_LAYER，其他照 sorting layer；order 照決定排序的 Canvas */
export function canvasSortLayerOrder(canvas: CanvasInfo, sortingLayerIndex: (id: number) => number): [number, number] {
  const sorting = sortingCanvasOf(canvas).data;
  return [canvas.renderMode === 0 ? OVERLAY_LAYER : sortingLayerIndex(sorting.m_SortingLayerID as number), sorting.m_SortingOrder as number];
}

/**
 * 每格（refreshOrderKeys）：Canvas 底下的繪製物件照節點「目前」的 Canvas 重算排序鍵的前兩項。以前只在建網格時算：
 * 換父物件（Transform.SetParent）到別的 Canvas 之後還照舊的排。MT2 開局畫面按確定，三張起始牌照原版
 * （FloatingRewardManager.CreateFloatingRewardFromObject）換到 Tooltip Canvas（order 43）飛向牌組；牌的 Image 還排在
 * 開局畫面的 order 11，被淡出中的畫面蓋住，只剩重產過網格的文字在飛。Unity 的 Graphic 換父物件時重新登記 Canvas（OnTransformParentChanged）。
 */
export function refreshCanvasSortKey(d: Pick<Drawable, 'key' | 'node' | 'comp' | 'popFor'>, db: Pick<AssetDB, 'sortingLayerIndex'>): boolean {
  const canvas = d.node?.canvas;
  if (!canvas || !isCanvasDrawable(d as Drawable)) return false;
  const [layer, order] = canvasSortLayerOrder(canvas, (id) => db.sortingLayerIndex(id));
  if (d.key[0] === layer && d.key[1] === order) return false;
  d.key[0] = layer;
  d.key[1] = order;
  return true;
}

function isCanvasDrawable(d: Drawable): boolean {
  if (d.popFor) return true;
  const kind = d.comp ? componentKind(d.comp) : '';
  return kind === 'Image' || kind === 'TextMeshProUGUI' || kind === 'RawImage' || isCanvasMeshClass(kind);
}

/** 網格的子網格（三角形索引）：執行期網格照 SetTriangles 存的；資產照 m_SubMeshes（firstByte 是 16 位元索引的位元組偏移，baseVertex 加回去） */
function submeshIndicesOf(src: MeshInstance | MeshAssetRecord): number[][] {
  if ('version' in src) return src.submeshes?.length ? src.submeshes : src.indices.length ? [src.indices] : [];
  const subs = src.m_SubMeshes ?? [];
  if (!subs.length) return src.indices.length ? [src.indices] : [];
  const bytes = (src as { m_IndexFormat?: number }).m_IndexFormat === 1 ? 4 : 2; // IndexFormat：0 UInt16、1 UInt32
  return subs.map((sm) => src.indices.slice(sm.firstByte / bytes, sm.firstByte / bytes + sm.indexCount).map((v) => v + (sm.baseVertex ?? 0)));
}

/** 語意 → mesh channel（CHANNEL_SEMANTIC 反過來） */
const SEMANTIC_CHANNEL: Record<string, string> = Object.fromEntries(Object.entries(CHANNEL_SEMANTIC).map(([k, v]) => [v, k]));

/** 整個填成預設值的屬性（網格沒有這個 channel）：channel 回來之前不用再填 */
const defaultFilled = new WeakSet<THREE.BufferAttribute>();

/**
 * 執行期網格的頂點寫進幾何；網格沒有的 channel 照 unityGeometry 的預設值補。
 * 容量不夠才換新的屬性（預留兩倍，同 writeParticleAttributes）：three.js 的屬性不能改大小，換一個就是一個新的 GL buffer，
 * 舊的沒有 dispose、要等 GC。UIParticle 每格烘的網格頂點數都在變，原本每格換整組（MT2 地圖 10/18 量到每秒 500 多個 buffer）。
 * 用到的頂點數記在 userData.vertexCount（後面是上一次留下的，三角形不會引用；包圍盒照這個數，見 usedVertexCount）
 */
function writeMeshAttributes(g: THREE.BufferGeometry, program: UnityProgram, src: MeshInstance): void {
  const n = src.vertexCount;
  for (const inp of program.vertexInputs) {
    const sem = `${inp.semantic}${inp.index}`;
    const ch = src.channels[SEMANTIC_CHANNEL[sem] ?? ''];
    const cur = g.getAttribute(inp.name) as THREE.BufferAttribute | undefined;
    const size = ch?.dimension ?? cur?.itemSize ?? 4;
    let attr = cur;
    if (!attr || attr.itemSize !== size || attr.count < n) {
      attr = new THREE.BufferAttribute(new Float32Array(Math.max(n, 64) * 2 * size), size);
      attr.setUsage(THREE.DynamicDrawUsage);
      g.setAttribute(inp.name, attr);
    }
    if (ch) {
      (attr.array as Float32Array).set(ch.values.subarray ? ch.values.subarray(0, n * size) : ch.values);
      defaultFilled.delete(attr);
      attr.clearUpdateRanges();
      attr.addUpdateRange(0, n * size);
      attr.needsUpdate = true;
    } else if (!defaultFilled.has(attr)) {
      const def = sem === 'COLOR0' ? [1, 1, 1, 1] : sem === 'NORMAL0' ? [0, 0, -1] : sem === 'TANGENT0' ? [1, 0, 0, -1] : [0, 0, 0, 0];
      for (let i = 0; i < attr.count; i++) for (let k = 0; k < size; k++) (attr.array as Float32Array)[i * size + k] = def[k] ?? 0;
      defaultFilled.add(attr);
      attr.clearUpdateRanges();
      attr.needsUpdate = true;
    }
  }
  g.userData.vertexCount = n;
}

/** 執行期網格的三角形寫進幾何：同 writeMeshAttributes，容量不夠才換新的 index（原本每次 setIndex(陣列) 都是新的 buffer，Spine 每格一個） */
function writeMeshIndex(g: THREE.BufferGeometry, idx: ArrayLike<number>): void {
  const n = idx.length;
  let index = g.getIndex();
  if (!index || !(index.array instanceof Uint32Array) || index.array.length < n) {
    index = new THREE.BufferAttribute(new Uint32Array(Math.max(n, 96) * 2), 1);
    index.setUsage(THREE.DynamicDrawUsage);
    g.setIndex(index);
  }
  (index.array as Uint32Array).set(idx);
  index.clearUpdateRanges();
  index.addUpdateRange(0, n);
  index.needsUpdate = true;
  g.setDrawRange(0, n);
}

/** 屬性裡真的用到的頂點數：writeMeshAttributes 預留了容量，後面的不算 */
function usedVertexCount(g: THREE.BufferGeometry, attr: THREE.BufferAttribute): number {
  const n = g.userData.vertexCount as number | undefined;
  return n === undefined ? attr.count : Math.min(n, attr.count);
}

/** CameraInfo → 粒子用的攝影機（Unity 世界座標的軸） */
function particleCameraOf(cam: CameraInfo): ParticleCamera {
  const position = new THREE.Vector3();
  const q = new THREE.Quaternion();
  cam.node.world.decompose(position, q, new THREE.Vector3());
  return {
    position,
    right: new THREE.Vector3(1, 0, 0).applyQuaternion(q),
    up: new THREE.Vector3(0, 1, 0).applyQuaternion(q),
    forward: new THREE.Vector3(0, 0, 1).applyQuaternion(q),
    orthographic: cam.orthographic,
    fov: cam.fieldOfView,
    orthoSize: cam.orthographicSize,
  };
}

/** 粒子網格寫進幾何：照 shader 的頂點輸入語意（POSITION、NORMAL、COLOR、TEXCOORDn 4 個分量；TANGENT 給預設）。容量不夠才換新的緩衝 */
function writeParticleAttributes(g: THREE.BufferGeometry, program: UnityProgram, geo: ParticleGeometry): void {
  const n = geo.vertexCount;
  for (const inp of program.vertexInputs) {
    const sem = `${inp.semantic}${inp.index}`;
    let src: Float32Array | null = null;
    let size = 4;
    if (sem === 'POSITION0') {
      src = geo.position;
      size = 3;
    } else if (sem === 'NORMAL0') {
      src = geo.normal;
      size = 3;
    } else if (sem === 'COLOR0') src = geo.color;
    else if (inp.semantic === 'TEXCOORD') src = geo.texcoords[inp.index] ?? null;
    let attr = g.getAttribute(inp.name) as THREE.BufferAttribute | undefined;
    if (!attr || attr.itemSize !== size || attr.array.length < n * size) {
      attr = new THREE.BufferAttribute(new Float32Array(Math.max(n, 64) * 2 * size), size);
      attr.setUsage(THREE.DynamicDrawUsage);
      if (!src) {
        const def = sem === 'TANGENT0' ? [1, 0, 0, -1] : [0, 0, 0, 0];
        for (let i = 0; i < attr.count; i++) for (let k = 0; k < size; k++) (attr.array as Float32Array)[i * size + k] = def[k] ?? 0;
      }
      g.setAttribute(inp.name, attr);
    }
    if (src) {
      (attr.array as Float32Array).set(src.subarray(0, n * size));
      // 只上傳這次用到的長度（陣列預留了兩倍；不設範圍 three.js 整個陣列都傳）。超過的部分畫的時候用不到（drawRange）
      attr.clearUpdateRanges();
      attr.addUpdateRange(0, n * size);
      attr.needsUpdate = true;
    }
  }
  let index = g.getIndex();
  if (!index || index.array.length < geo.indices.length) {
    index = new THREE.BufferAttribute(new Uint32Array(Math.max(geo.indices.length, 96) * 2), 1);
    index.setUsage(THREE.DynamicDrawUsage);
    g.setIndex(index);
  }
  (index.array as Uint32Array).set(geo.indices);
  index.clearUpdateRanges();
  index.addUpdateRange(0, geo.indices.length);
  index.needsUpdate = true;
  g.setDrawRange(0, geo.indices.length);
}

/**
 * 粒子網格交給 render thread 的工作（render/gfx/particleJobs.ts）時：容量、上傳範圍、drawRange 跟 writeParticleAttributes 一樣，
 * 資料不在主執行緒填，屬性陣列登記成那個工作的輸出（three.js 上傳時 worker 從工作抄）。TEXCOORDn 有沒有資料流照 vertex streams 算
 *（buildParticles 的 texcoords 有 max(1, texcoordCount) 個）
 */
function writeParticleAttributesJob(g: THREE.BufferGeometry, program: UnityProgram, renderer: Record<string, unknown>, n: number, indexCount: number, job: number, gl: GfxContext): void {
  const streams = renderer.m_UseCustomVertexStreams === 1 ? parseVertexStreams(renderer.m_VertexStreams) : [0, 1, 3, 4];
  const tcCount = Math.max(1, streamLayout(streams).texcoordCount);
  for (const inp of program.vertexInputs) {
    const sem = `${inp.semantic}${inp.index}`;
    let stream = -1;
    let size = 4;
    if (sem === 'POSITION0') {
      stream = JOB_STREAM.position;
      size = 3;
    } else if (sem === 'NORMAL0') {
      stream = JOB_STREAM.normal;
      size = 3;
    } else if (sem === 'COLOR0') stream = JOB_STREAM.color;
    else if (inp.semantic === 'TEXCOORD' && inp.index < tcCount) stream = JOB_STREAM.texcoord0 + inp.index;
    let attr = g.getAttribute(inp.name) as THREE.BufferAttribute | undefined;
    if (!attr || attr.itemSize !== size || attr.array.length < n * size) {
      attr = new THREE.BufferAttribute(new Float32Array(Math.max(n, 64) * 2 * size), size);
      attr.setUsage(THREE.DynamicDrawUsage);
      if (stream < 0) {
        const def = sem === 'TANGENT0' ? [1, 0, 0, -1] : [0, 0, 0, 0];
        for (let i = 0; i < attr.count; i++) for (let k = 0; k < size; k++) (attr.array as Float32Array)[i * size + k] = def[k] ?? 0;
      }
      g.setAttribute(inp.name, attr);
    }
    if (stream >= 0) {
      gl.bindJobArray(attr.array, job, stream);
      attr.clearUpdateRanges();
      attr.addUpdateRange(0, n * size);
      attr.needsUpdate = true;
    }
  }
  let index = g.getIndex();
  if (!index || index.array.length < indexCount) {
    index = new THREE.BufferAttribute(new Uint32Array(Math.max(indexCount, 96) * 2), 1);
    index.setUsage(THREE.DynamicDrawUsage);
    g.setIndex(index);
  }
  gl.bindJobArray(index.array, job, JOB_STREAM.indices);
  index.clearUpdateRanges();
  index.addUpdateRange(0, indexCount);
  index.needsUpdate = true;
  g.setDrawRange(0, indexCount);
}

function compareKeys(a: number[], b: number[]): number {
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (x !== y) return x - y;
  }
  return 0;
}

function compareDrawKeys(a: Pick<Drawable, "key">, b: Pick<Drawable, "key">): number {
  return compareKeys(a.key, b.key);
}

/**
 * drawables 照 key 穩定排序（結果同 Array.prototype.sort(compareDrawKeys)，它也是穩定的）。平常只有幾個換了位置
 *（重產換上的新網格接在最後、少數物件的 key 變了），先用插入排序：幾乎排好的清單接近線性。搬動太多（結構大改）就交給內建的 sort，
 * 插入排序做到一半也是穩定的，接著排的結果一樣。key 有 NaN 時比較不一致，兩種排法結果可能不同，直接用內建的（同以前）。
 * MT2 戰鬥 6500 個繪製物件、Chatter 文字每格重產一次，以前每次都整個重排（10/18）。
 * 每個元素的 key 只讀一次：繪製物件的形狀很多種，`.key` 是 megamorphic 讀取，NaN 檢查原本每個分量讀兩次，佔了這裡大部分的時間
 */
export function sortDrawablesStable(list: Pick<Drawable, "key">[]): void {
  const n = list.length;
  for (let i = 0; i < n; i++) {
    const k = list[i].key;
    for (let j = 0; j < k.length; j++) {
      const v = k[j];
      if (v !== v) return void list.sort(compareDrawKeys);
    }
  }
  let budget = 4 * n + 1000;
  // prev＝list[i - 1] 的 key。插入之後 list[i] 是原本的 list[i - 1]，prev 不變
  let prev = n ? list[0].key : [];
  for (let i = 1; i < n; i++) {
    const d = list[i];
    const dk = d.key;
    if (compareKeys(prev, dk) <= 0) {
      prev = dk;
      continue;
    }
    let j = i - 1;
    while (j >= 0 && compareKeys(list[j].key, dk) > 0) {
      list[j + 1] = list[j];
      j--;
      budget--;
    }
    list[j + 1] = d;
    if (budget < 0) return void list.sort(compareDrawKeys);
  }
}

export class SceneRenderer {
  /** RectMask2D 裁切狀態（viewer/main 在 World 建好後接上 world.clips）。沒接上時完全不裁 */
  clips: RectClipRegistry | null = null;
  /** 場景裡的粒子模擬（boot 在 World 建好後接上 world.particles）。沒接上時不畫粒子 */
  particles: ParticleWorld | null = null;
  /** 場景裡 TrailRenderer 留下的點（boot 接上 world.trails）。沒接上時不畫拖尾 */
  trails: TrailWorld | null = null;
  readonly renderer: THREE.WebGLRenderer;
  private target: THREE.WebGLRenderTarget;
  private scene3 = new THREE.Scene();
  private camera3 = new THREE.OrthographicCamera();
  private blit: { scene: THREE.Scene; camera: THREE.Camera; material: THREE.RawShaderMaterial };
  private whiteTexture: THREE.DataTexture;
  private materialCache = new Map<string, THREE.RawShaderMaterial>();
  private clearColor = new THREE.Color(0, 0, 0);
  report: RenderReport = { drawn: {}, standIn: {}, skipped: {}, unityShaders: {}, unfilled: {} };
  /**
   * 建置時沒有 sprite 的 SpriteRenderer 是否佔位（空網格）。預設開：Unity 畫的是 SpriteRenderer 當下的 sprite，之後換上去要畫得出來
   * （LockTooltipHint 建置時沒有 sprite，ShowLockHint 才換上 pinHint）。?spritePlaceholder=0 關掉＝舊的行為（tooltip-check 的負向確認）。
   */
  placeholderSprites = true;
  /** built-in：攝影機有沒有 targetTexture（Camera.targetTexture 是執行期設的，存在相容層；boot 接上）。有的不畫到螢幕 */
  cameraHasTarget: ((camera: ComponentData) => boolean) | null = null;
  /** built-in：攝影機的 targetTexture（RenderTexture 物件，照身分對到一張 render target；boot 接上）。有的先畫進那張，RawImage 再拿來顯示 */
  cameraTarget: ((camera: ComponentData) => { width: number; height: number } | null) | null = null;
  /** shader 的時間（_Time 那一組；boot 接上 World 的 Time.timeSinceLevelLoad 與 deltaTime）。沒接上時固定 0 */
  shaderTime: (() => { time: number; deltaTime: number; smoothDeltaTime: number }) | null = null;
  /**
   * built-in：攝影機這一格的 Post Processing v2 設定（csport/unityPostProcess.ts 混合好的 volume；boot 接上）。
   * 有的攝影機先畫進 HDR 的中繼 target，再由 render/postProcess.ts 跑 Bloom／LUT／Uber 畫回主 target
   */
  postProcess: ((cam: CameraInfo) => PostProcessFrame | null) | null = null;
  /**
   * built-in：Renderer 的烘焙光照圖（LightmapSettings.lightmaps[lightmapIndex] 的貼圖與 lightmapScaleOffset；csport/unityNative.ts 的 lightmapOf，boot 接上）。
   * 有的物件用 LIGHTMAP_ON 變體（multi_compile_fwdbase：有光照圖的物件不開 LIGHTPROBE_SH）
   */
  lightmapOf: ((comp: ComponentData) => { guid: string; scaleOffset: [number, number, number, number] } | null) | null = null;
  private ppStacks = new Map<ComponentData, PostProcessStack>();
  /** 除錯介面看：每台攝影機的後製（ensure 沒好的那一格照舊直接畫） */
  postProcessStacks(): Map<ComponentData, PostProcessStack> {
    return this.ppStacks;
  }
  private ppStack(cam: CameraInfo, frame: PostProcessFrame): PostProcessStack | null {
    if (!this.shaders) return null;
    let st = this.ppStacks.get(cam.data);
    if (!st) {
      const db = this.db;
      st = new PostProcessStack(this.renderer, this.shaders, db ? frame.blueNoise.map((g) => db.texture(g).catch(() => null)) : []);
      this.ppStacks.set(cam.data, st);
    }
    return st;
  }
  /**
   * built-in：active 場景的光照設定（RenderSettings 與 LightingData 的環境探針；boot 接 World.scenes.active 的 settings）。
   * 沒接上時沒有環境光與霧
   */
  sceneLighting: (() => { renderSettings?: Record<string, unknown>; ambientProbe?: number[] | null }) | null = null;
  /** built-in：圖層 → 那個圖層的物件共用的前向光照常數（builtinLighting.ts；每格就地重算，K3 程式的 ctx.globals 指著它） */
  private builtinGlobals = new Map<number, Record<string, number[]>>();
  /** built-in：這一格的光照輸入（frame() 開頭算；建網格時的 keyword 也照它） */
  private builtinLightInput: BuiltinLightingInput | null = null;
  /** built-in：排序鍵的距離照這台攝影機算（每台攝影機畫之前設；null 時照建網格時的攝影機，見 viewDepth） */
  private depthCam: CameraInfo | null = null;
  /** built-in：目前這一趟的畫面大小（viewport 的像素寬高；cbuffer 的 _ScreenParams 用），null 時是整個 target */
  private passSize: { w: number; h: number } | null = null;
  private shaders: ShaderLibrary | null = null;
  private db: AssetDB | null = null;
  private cam: CameraInfo | null = null;
  /** mesh：fillCbuffers 用它的 visible 跳過這一格不畫的物件 */
  private programs: { program: UnityProgram; ctx: DrawContext; mesh?: THREE.Mesh }[] = [];
  /** 場景裡的 3D 光源（Light 元件；建置與新增子樹時收集）與每格算出來的 URP 前向光源常數（3D 網格共用） */
  private lightEntries: LightEntry[] = [];
  private readonly lights3d: Record<string, number[]> = {};
  private defaultTextures = new Map<string, THREE.Texture>();
  private lightTargets: LightTarget[] = [];
  /** 光照 target 相對主 target 的比例（m_LightRenderTextureScale）與點光源材質自帶的 _ScreenParams 記錄；resize 時跟上（見 resize） */
  private lightScale = 1;
  private lightScreenGlobals: Record<string, ArrayLike<number>>[] = [];
  private lightLookup: THREE.DataTexture | null = null;
  /** 動態字型的 atlas（字型資產 guid → 貼圖），build 結束時與每格把新加的字上傳 */
  private atlasTextures = new Map<string, THREE.DataTexture>();
  private drawables: Drawable[] = [];
  /** 每格重產偵測的元件（TMP 與 Image，含建置時未啟用的） */
  private managed: ManagedEntry[] = [];
  private graph: SceneGraph | null = null;
  /** 建置之後的重產失敗（原因 → 次數）；建置期的在 report.skipped */
  readonly runtimeSkipped: Record<string, number> = {};
  /** 每格完成的重產統計（text-check f）：frame() 會把上一格以來完成的彙總進來 */
  readonly regenFrames: { frame: number; texts: number; images: number; ms: number }[] = [];
  private regenDone: { kind: ManagedEntry['kind']; ms: number }[] = [];
  private frameCount = 0;
  /** 換 sprite 用：預載好的 sprite（網格、貼圖），同步取得 */
  private spriteCache = new Map<string, { sprite: SpriteInfo; mesh: SpriteMeshRecord; texture: THREE.Texture } | Promise<void>>();
  /** 場景裡全部掛 Mask 元件的節點（build 與 addSubtree 收集；每格由 updateMaskState 判斷哪些 MaskEnabled） */
  private maskNodes = new Set<SceneNode>();
  /** 目前啟用中的 Mask 子樹（含 Mask 自己）的節點；沒有任何 Mask 啟用時是 null（stencilOf 直接短路） */
  private maskedNodes: Set<SceneNode> | null = null;
  /** 已經建過 drawable 的元件（addSubtree 對重疊節點不會建第二次） */
  private builtComps = new Set<ComponentData>();
  /** StencilMaterial.Add 的材質快取（手寫 shader 用；StencilMaterial.cs:91-100 也是同一組參數共用一份） */
  private stencilMaterials = new Map<string, THREE.RawShaderMaterial>();
  /** 每份 shader 原始碼（vertex＋fragment）留一個不 dispose 的材質，program 才不會被 three.js 釋放（retireMaterial） */
  private programKeepers = new Map<string, THREE.ShaderMaterial>();
  /** prewarmPrefabs 預編過的 shader（除錯介面看） */
  readonly prewarmed: string[] = [];
  /** shader 有沒有 _Stencil 那六個屬性（StencilMaterial.cs:61-90） */
  private stencilPropsCache = new Map<string, boolean>();
  /** TMP 網格產生後的掛勾（vertexHooks.ts，第 2 輪）：按元件登記；沒有登記的元件不跑（既有截圖不變） */
  private readonly textHooks = new WeakMap<ComponentData, TmpVertexHook>();
  /** 最近一次 addText 排版的結果（掛勾已套上）；textResultOf 與除錯介面用 */
  private readonly textResults = new WeakMap<ComponentData, TextMeshResult>();

  constructor(
    readonly canvas: HTMLCanvasElement,
    readonly options: SceneRendererOptions = {},
  ) {
    // render thread 開著時 <canvas> 已經交給 worker：three.js 用 GfxCanvas（getContext 回記錄指令的 GfxContext）
    const glCanvas = options.gfx ? (options.gfx.canvas as unknown as HTMLCanvasElement) : canvas;
    this.renderer = new THREE.WebGLRenderer({ canvas: glCanvas, antialias: false, alpha: false });
    this.renderer.autoClear = false;
    this.renderer.sortObjects = true;
    // 場景本身不動（單位矩陣）。開著 matrixAutoUpdate 的話 three.js 每次 render 先重組場景矩陣、標成要更新，底下 6500 個網格
    // 全部被強制重算世界矩陣（一格畫三趟約兩萬次矩陣乘法，10/18 量）。網格都是 matrixAutoUpdate＝false、改了 matrix 自己設
    // matrixWorldNeedsUpdate，關掉之後只更新有變的
    this.scene3.matrixAutoUpdate = false;
    this.target = this.makeTarget(1, 1);
    this.whiteTexture = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
    this.whiteTexture.colorSpace = THREE.SRGBColorSpace;
    this.whiteTexture.needsUpdate = true;
    const blitMaterial = new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: BLIT_VERTEX,
      fragmentShader: BLIT_FRAGMENT,
      uniforms: { tSource: { value: this.target.texture } },
      depthTest: false,
      depthWrite: false,
    });
    const tri = new THREE.BufferGeometry();
    tri.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
    const blitScene = new THREE.Scene();
    const blitMesh = new THREE.Mesh(tri, blitMaterial);
    blitMesh.frustumCulled = false;
    blitScene.add(blitMesh);
    this.blit = { scene: blitScene, camera: new THREE.Camera(), material: blitMaterial };
  }

  private makeTarget(w: number, h: number): THREE.WebGLRenderTarget {
    return new THREE.WebGLRenderTarget(w, h, {
      colorSpace: THREE.SRGBColorSpace, // → SRGB8_ALPHA8
      type: THREE.UnsignedByteType,
      // Mask 的 stencil 裁切要 stencil buffer。three.js（0.186.1）只在 depthBuffer 為真時才配置 depth/stencil
      // renderbuffer（WebGLTextures.js:2244-2248 → setupRenderBufferStorage 的 if (renderTarget.depthBuffer)），
      // 所以兩個都開（拿到 DEPTH24_STENCIL8）。深度本身不用：全部材質 depthTest／depthWrite 都是 false，
      // render() 也只清 color 與 stencil。
      depthBuffer: true,
      stencilBuffer: true,
      generateMipmaps: false,
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
    });
  }

  /** 換場景時丟掉整個繪製端（檢視頁的舊 session）：釋放 render target 與 WebGL context */
  dispose(): void {
    this.target.dispose();
    for (const t of this.grabTextures.values()) t.dispose();
    for (const t of this.rtTargets.values()) t.dispose();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
  }

  setSize(w: number, h: number) {
    this.renderer.setSize(w, h, false);
    this.target.dispose();
    this.target = this.makeTarget(w, h);
    this.blit.material.uniforms.tSource.value = this.target.texture;
  }

  /**
   * 視窗尺寸改變（手機旋轉、網址列收合；viewer/main.ts 的 refit）：主 target 重建、正交攝影機的長寬比、光照 target 跟上。
   * 光照 target 用 setSize（texture 是同一個物件，受光 sprite 已綁的 _ShapeLightTexture* 參照照舊有效）；
   * 點光源材質的 _ScreenParams 在它自己的 globals（pointLight），就地改內容（fillCbuffers 每格讀）。
   */
  resize(w: number, h: number): void {
    this.setSize(w, h);
    const cam = this.cam;
    if (cam) {
      const halfH = cam.orthographicSize;
      const halfW = halfH * (w / h);
      const c = this.camera3;
      c.left = -halfW;
      c.right = halfW;
      c.top = halfH;
      c.bottom = -halfH;
      c.updateProjectionMatrix();
    }
    const lw = Math.max(1, Math.floor(w * this.lightScale));
    const lh = Math.max(1, Math.floor(h * this.lightScale));
    for (const t of this.lightTargets) t.target.setSize(lw, lh);
    for (const g of this.lightScreenGlobals) {
      (g._ScreenParams as number[]).splice(0, 4, lw, lh, 1 + 1 / lw, 1 + 1 / lh);
      (g._ScaledScreenParams as number[]).splice(0, 4, lw, lh, 1 + 1 / lw, 1 + 1 / lh);
    }
  }

  private material(kind: ShaderKind, texture: THREE.Texture, color: ColorRGBA, textureSampleAdd = [0, 0, 0, 0], clipKey = ''): THREE.RawShaderMaterial {
    const key = `${kind}|${texture.uuid}|${color.r},${color.g},${color.b},${color.a}|${clipKey}`;
    let m = this.materialCache.get(key);
    if (!m) {
      const premultiplied = kind !== 'standIn';
      m = new THREE.RawShaderMaterial({
        glslVersion: THREE.GLSL3,
        vertexShader: kind === 'ui' ? UI_CLIP_VERTEX : UNITY_VERTEX,
        fragmentShader: kind === 'ui' ? UI_DEFAULT_FRAGMENT : kind === 'sprite' ? SPRITES_DEFAULT_FRAGMENT : STAND_IN_FRAGMENT,
        uniforms: {
          _MainTex: { value: texture },
          _Color: { value: new THREE.Vector4(color.r, color.g, color.b, color.a) },
          _TextureSampleAdd: { value: new THREE.Vector4(...textureSampleAdd) },
          // UI/Default 的 UNITY_UI_ALPHACLIP（StencilMaterial.cs:120-128）；手寫版沒有 variant，用這個 float 判斷
          _UseUIAlphaClip: { value: 0 },
          // UI/Default 的 UNITY_UI_CLIP_RECT（UI-Default.shader:59、99-105、131-134）：手寫版沒有
          // multi_compile variant，照 UNITY_UI_ALPHACLIP 同樣的做法把運算常駐，
          // 沒掛 RectMask2D 的給超大矩形 _ClipRect（m 恆為 1，等效 keyword 關著）。
          // clipKey 非空的繪製物件每格由 updateClipUniforms 更新（換 RectMask2D 要換矩陣，不能共用材質）。
          ...(kind === 'ui'
            ? {
                _ClipRect: { value: new THREE.Vector4(...NO_CLIP) },
                _UIMaskSoftness: { value: new THREE.Vector2(0, 0) },
                _ScreenParams: { value: new THREE.Vector4(1920, 1080, 1 + 1 / 1920, 1 + 1 / 1080) },
              }
            : {}),
        },
        transparent: true,
        // built-in：UI/Default 是 ZTest [unity_GUIZTestMode]（Screen Space - Camera 與 World Space 是 LEqual；Overlay 那一趟先清深度，等於不測）、
        // Sprites/Default 是預設的 ZTest LEqual，兩個都 ZWrite Off（UI-Default.shader、Sprites-Default.shader）。srp 照舊不測
        depthTest: this.builtin,
        depthFunc: THREE.LessEqualDepth,
        depthWrite: false,
        side: THREE.DoubleSide, // FLIP_Z 讓三角形的繞向反過來；這些 shader 本來就是 Cull Off
        blending: THREE.CustomBlending,
        blendSrc: premultiplied ? THREE.OneFactor : THREE.SrcAlphaFactor,
        blendDst: THREE.OneMinusSrcAlphaFactor,
        blendSrcAlpha: THREE.OneFactor,
        blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
      });
      this.materialCache.set(key, m);
    }
    return m;
  }

  /** 材質 → 用哪個 shader。內建的照原樣，其他先代用 */
  private shaderKind(mat: MaterialInfo | null, fallback: 'ui' | 'sprite'): ShaderKind {
    if (!mat) return fallback;
    if (mat.shaderName === 'UI/Default') return 'ui';
    if (mat.shaderName === 'Sprites/Default') return 'sprite';
    bump(this.report.standIn, `${mat.name}（${mat.shaderName}）`);
    return 'standIn';
  }

  private materialColor(mat: MaterialInfo | null): ColorRGBA {
    const c = mat?.record.m_SavedProperties.m_Colors._Color;
    return c ? colorToLinear(c) : { r: 1, g: 1, b: 1, a: 1 };
  }

  get builtin(): boolean {
    return this.options.pipeline === 'builtin';
  }

  /**
   * 排序鍵的距離。built-in 每台攝影機畫之前設 depthCam，照那台算；GraphicsSettings 的 m_TransparencySortMode 是 Default（0）時，
   * 透視攝影機照到攝影機位置的距離、正交攝影機照前方軸的深度（Unity 文件 Camera.transparencySortMode）。
   */
  private viewDepth(cam: CameraInfo, worldPos: THREE.Vector3): number {
    if (this.depthCam) {
      cam = this.depthCam;
      if (!cam.orthographic) return worldPos.distanceTo(new THREE.Vector3().setFromMatrixPosition(cam.node.world));
    }
    const camPos = new THREE.Vector3().setFromMatrixPosition(cam.node.world);
    const forward = new THREE.Vector3(0, 0, 1).transformDirection(cam.node.world);
    return worldPos.clone().sub(camPos).dot(forward);
  }

  /**
   * Overlay Canvas（renderMode 0）在螢幕像素空間（unity/scene.ts 的 layout，跟 Unity 一樣）。繪製端只有一台攝影機，畫的時候把像素空間
   * 換到這台攝影機前 planeDistance、填滿畫面（跟 Screen Space - Camera 同一套數學），排序鍵第一項 OVERLAY_LAYER 讓它畫在最後。
   * 像素 p → 攝影機前：screenSpaceCameraMatrix(攝影機, 距離, 螢幕高) × 平移(−寬/2, −高/2)，跟 scaleFactor 無關。
   * 距離不在攝影機的 near～far 之間時取中點（正交攝影機的距離只影響裁切）。每格 frame() 開頭清掉重算（攝影機可能動了）。
   */
  private readonly overlayMats = new Map<number, THREE.Matrix4>();
  private overlayMatrix(planeDistance: number): THREE.Matrix4 {
    let m = this.overlayMats.get(planeDistance);
    if (m) return m;
    const cam = this.cam!;
    const d = planeDistance > cam.near && planeDistance < cam.far ? planeDistance : (cam.near + cam.far) / 2;
    const w = this.target.width;
    const h = this.target.height;
    m = screenSpaceCameraMatrix(cam, d, h).multiply(new THREE.Matrix4().makeTranslation(-w / 2, -h / 2, 0));
    this.overlayMats.set(planeDistance, m);
    return m;
  }

  /** 畫的時候用的世界矩陣：Overlay Canvas 底下的節點換到攝影機前（overlayMatrix），其他就是 node.world */
  private drawWorld(node: SceneNode): THREE.Matrix4 {
    const cv = node.canvas;
    // built-in：Overlay 另外一趟畫，投影直接用螢幕像素（cameraStack.overlayProjection），不用換到攝影機前
    if (!cv || cv.renderMode !== 0 || !this.cam || this.builtin) return node.world;
    return this.overlayMatrix(cv.planeDistance ?? 0).clone().multiply(node.world);
  }

  /**
   * TMP 的 TextContext：lossyScaleY 照畫的時候的矩陣（drawWorld）。TMP 把 |lossyScale| 打進 uv（xScale，Overlay 再除以 scaleFactor），
   * shader 再用實際的投影算每像素的世界單位，兩邊要是同一個空間；Overlay 的 node.world 是像素空間，畫的時候才換到攝影機前。
   */
  private textContext(node: SceneNode, comp: ComponentData, cam: CameraInfo): TextContext {
    return textContextOf({ rect: node.rect, canvas: node.canvas, world: this.drawWorld(node) }, comp as TmpComponentData, { orthographic: cam.orthographic, linearColorSpace: true });
  }

  /**
   * 世界空間 Canvas 底下的 UI 繪製物件（Image、TextMeshProUGUI 的主網格與子網格、遮罩的 pop）的深度項，每格照 canvas 節點目前的世界位置算。
   * 建網格時的排序鍵用的是同一個式子（planeDistance 為 null 時 depth ＝ viewDepth(canvas 世界位置)），所以建網格當下與之後每格算的值一致，
   * 差別只在之後 canvas 跟著卡移動時，這裡會跟著更新。Screen Space（planeDistance 不是 null）的深度是固定的平面距離，回傳 undefined，key 與建網格時一樣。
   * Unity 的對應規則（世界空間 Canvas 依攝影機距離與其他透明物件一起排）：未查證。專案內的說明見 src/runtime/unity/scene.ts 的 CanvasInfo 註解。
   */
  private uiDepthOf(cam: CameraInfo, canvas: CanvasInfo): (() => number) | undefined {
    if (canvas.planeDistance !== null) return undefined;
    return () => -this.viewDepth(cam, new THREE.Vector3().setFromMatrixPosition(canvas.node.world));
  }

  /** 依場景樹建立全部要畫的網格。screenW、screenH 是畫面像素（layout 已經用同樣的大小算過） */
  async build(graph: SceneGraph, db: AssetDB, shaders: ShaderLibrary | null = null): Promise<void> {
    this.scene3.clear();
    this.report = { drawn: {}, drawnInactive: {}, standIn: {}, skipped: {}, unityShaders: {}, unfilled: {} };
    this.shaders = shaders;
    this.db = db;
    this.graph = graph;
    this.programs = [];
    this.managed = [];
    this.scanVersion++;
    const cam = graph.cameras.find((c) => c.node.activeInHierarchy && c.data.m_Enabled !== 0);
    if (!cam) throw new Error('場景沒有啟用的攝影機');
    const bg = cam.data.m_BackGroundColor as ColorRGBA;
    const bgLin = colorToLinear(bg);
    this.clearColor.setRGB(bgLin.r, bgLin.g, bgLin.b, THREE.LinearSRGBColorSpace);
    this.setupCamera(cam);
    this.cam = cam;
    const lit = await this.setupLighting(graph, db, cam);
    this.lit = lit;
    // setupLighting（pointLight → unityMesh）建的 Hidden/Light2D-Point 程式在 addNodes 的 programsBefore 之前，
    // 不在 addNodes 那句 bindTextures(新程式) 的範圍裡：這裡先綁它們的 _LightLookup／
    // _FalloffLookup（RendererLighting.DrawPointLight 的 SetTexture）。漏綁的話光源 fragment 取樣到未綁定的
    // 貼圖（黑），光照 target 全 0，受光 sprite（Sprite-Lit-Default 的 USE_SHAPE_LIGHT_TYPE_0 乘
    // _ShapeLightTexture0）整片變黑。此時 this.programs 只有光照程式（build 開頭清空）。
    await this.bindTextures(this.programs);
    this.drawables = [];
    this.scanVersion++;
    this.builtComps = new Set();
    this.maskNodes = new Set();
    this.cbufferReported = false;

    await this.addNodes(graph.nodes.values(), true);
    this.frame();
  }

  /** URP 2D 光照的準備結果（build 算一次，addSubtree 建 SpriteRenderer 時沿用） */
  private lit: LitInfo = { layerStyles: new Map(), globals: {}, styles: [], targets: [] };

  /**
   * 把一批節點建成繪製物件並加進場景（build 與 addSubtree 共用同一套規則）。
   * initial ＝ 建置期：未啟用的 TMP／Image 記 report.drawnInactive、失敗記 report.skipped（否則記 runtimeSkipped）。
   */
  private async addNodes(nodes: Iterable<SceneNode>, initial: boolean): Promise<Drawable[]> {
    this.updateMaskState();
    const drawables: Drawable[] = [];
    const jobs: Promise<void>[] = [];
    // 「這批建出來的新程式」用抓快照後比對（Set）而不是切 index 範圍：await 期間別的 addNodes／
    // regenerate 會 dropDrawable 掉舊的 this.programs 項目，長度會縮，切 index 會漏掉落在舊範圍裡的新程式
    // （實測：level2 進戰鬥的 Enemy_GrassGuy/Sprite 就是這樣漏綁 _MainTex，敵人整隻不見）
    const programsBefore = new Set(this.programs);
    /** 這一批新建的受管項目（結尾放進 this.drawables 之後才解除 busy） */
    const building: ManagedEntry[] = [];
    for (const node of nodes) {
      // 節點已被 destroy（10/10 的競態：排在 main.ts 的 subtreePending 鏈上的 addSubtree 輪到時，根可能已經銷毀）：
      // 元件資料已從 file.components 刪掉，components(node) 會給 undefined，下面的 comp.script 就丟 TypeError。整個跳過。
      if (!isLiveSceneNode(this.graph!, node)) continue;
      for (const comp of this.graph!.components(node)) {
        if (this.builtComps.has(comp)) continue;
        // 繼承 TMP 的遊戲類別（ExtendedTextMeshProUGUI）照 TMP 畫（unity/componentKind.ts）
        const kind = componentKind(comp);
        if (kind === 'Mask') {
          // Mask 自己沒有網格：它改同一個 GameObject 上那個 Graphic 的材質（Mask.cs:113-149），並在子樹畫完之後
          // 用 unmask 材質把同一份網格再畫一次、把 stencil 清回（Mask.cs:132-136、143-147）
          this.maskNodes.add(node);
          continue;
        }
        // TMP 與 Image：建置時不跳過未啟用／關閉的（之後啟用要能畫出來）。顯示與否每格依 activeInHierarchy 與 m_Enabled 決定；
        // 屬性、rect、CanvasRenderer 顏色的變更由每格的 key 比對觸發重產（meshRefresh.ts）
        // 腳本自己把網格交給 CanvasRenderer 的 Graphic（UIParticle）：受管，材質、貼圖、stencil 變了重產；頂點每格由 refresh 換
        if (isCanvasMeshClass(kind) && this.builtin) {
          this.builtComps.add(comp);
          const cm: ManagedEntry = { kind: 'CanvasMesh', node, comp, drawables: [], key: '', busy: true, warnings: [] };
          this.managed.push(cm);
          building.push(cm);
          jobs.push(
            this.buildManaged(cm, initial).then((ds) => {
              cm.drawables = ds;
              for (const d of ds) drawables.push(d);
            }),
          );
          continue;
        }
        if (kind === 'Image' || kind === 'RawImage' || kind === 'TextMeshProUGUI' || kind === 'TextMeshPro') {
          if (kind !== 'Image' && kind !== 'RawImage' && !this.options.text) {
            if (initial && node.activeInHierarchy && comp.m_Enabled !== 0) bump(this.report.skipped, `${kind}（沒有排版模組）`);
            continue;
          }
          this.builtComps.add(comp);
          // busy：第一次建置（非同步，TMP 要等字型）一直到這一批放進 this.drawables（函式結尾）之前，frame() 不能對它開始重產。
          // 否則建置期間或綁貼圖的空檔 key 變了（生成後馬上改字、SpecialState 的 Start 從 0 放大），重產先把 m.drawables 換掉，
          // 結尾又把第一次建置的網格塞進 this.drawables，變成不在任何受管項目裡、永遠不更新的殘影
          //（10/13 敵人的格擋數字疊了一份舊網格）。放完之後 key 不同，下一格照常重產。
          const m: ManagedEntry = { kind: kind as ManagedEntry['kind'], node, comp, drawables: [], key: '', busy: true, warnings: [] };
          this.managed.push(m);
          building.push(m);
          jobs.push(
            this.buildManaged(m, initial).then((ds) => {
              m.drawables = ds;
              for (const d of ds) {
                drawables.push(d);
                if (initial && (!node.activeInHierarchy || comp.m_Enabled === 0)) bump(this.report.drawnInactive!, d.label);
              }
            }),
          );
          continue;
        }
        // 3D 光源：只收集，每格依啟用狀態算 URP 的光源常數（render/mesh3d.ts）
        if (kind === 'Light') {
          this.builtComps.add(comp);
          this.lightEntries.push({ node, comp });
          continue;
        }
        // MeshRenderer＋MeshFilter 的 3D 網格（骰盤、骰子）：網格資產在 meshes.json 才畫。3D 的 TextMeshPro 也有 MeshRenderer，
        // 它的網格是 TMP 自己產生的（MeshFilter 沒有資產參照），由 TextMeshPro 那條路畫，這裡跳過。建置時不跳過未啟用的
        if (kind === 'MeshRenderer' && this.builtin) {
          // built-in：受管（材質、子網格數、圖層變了重產；執行期網格的頂點每格由 refresh 換）。網格可能建置之後才有（Spine 的 SkeletonRenderer
          // 在第一次 LateUpdate 才 new Mesh() 指給 sharedMesh），所以有 MeshFilter 就登記。3D 文字的 MeshRenderer 由 TextMeshPro 那條路畫
          const mf = this.graph!.component(node, 'MeshFilter');
          if (mf && !this.graph!.component(node, 'TextMeshPro')) {
            this.builtComps.add(comp);
            const mm: ManagedEntry = { kind: 'MeshRenderer', node, comp, drawables: [], key: '', busy: true, warnings: [] };
            this.managed.push(mm);
            building.push(mm);
            jobs.push(
              this.buildManaged(mm, initial).then((ds) => {
                mm.drawables = ds;
                for (const d of ds) drawables.push(d);
              }),
            );
          }
          continue;
        }
        // TrailRenderer（built-in）：受管（材質、圖層變了重產）；網格每一趟由 beforePass 照那台攝影機與 TrailWorld 的點產
        if (kind === 'TrailRenderer' && this.builtin) {
          this.builtComps.add(comp);
          const tm: ManagedEntry = { kind: 'TrailRenderer', node, comp, drawables: [], key: '', busy: true, warnings: [] };
          this.managed.push(tm);
          building.push(tm);
          jobs.push(
            this.buildManaged(tm, initial).then((ds) => {
              tm.drawables = ds;
              for (const d of ds) drawables.push(d);
            }),
          );
          continue;
        }
        // ParticleSystemRenderer（built-in）：受管（材質、繪製模式、拖尾開關變了重產）；網格每一趟由 beforePass 照那台攝影機產
        if (kind === 'ParticleSystemRenderer' && this.builtin) {
          if (this.graph!.component(node, 'ParticleSystem')) {
            this.builtComps.add(comp);
            const pm: ManagedEntry = { kind: 'ParticleSystemRenderer', node, comp, drawables: [], key: '', busy: true, warnings: [] };
            this.managed.push(pm);
            building.push(pm);
            jobs.push(
              this.buildManaged(pm, initial).then((ds) => {
                pm.drawables = ds;
                for (const d of ds) drawables.push(d);
              }),
            );
          }
          continue;
        }
        if (kind === 'MeshRenderer') {
          const mf = this.graph!.component(node, 'MeshFilter');
          const ref = mf?.m_Mesh as { guid?: string } | null | undefined;
          if (mf && ref?.guid && !this.graph!.component(node, 'TextMeshPro')) {
            this.builtComps.add(comp);
            jobs.push(this.addMeshRenderer(node, comp, mf, drawables));
          }
          continue;
        }
        // SpriteRenderer：建置時不跳過未啟用／關閉的（同 TMP 與 Image，見上面）。之後 SetActive(true)、m_Enabled＝1 才畫得出來：
        // RNumberHighlight、遺物的底圖與進度條建置時都是關的，原本建置時跳過，之後啟用也永遠不會有繪製物件。
        // 顯示與否每格由 updateDrawable 依 activeInHierarchy 與 m_Enabled 決定。
        if (kind === 'SpriteRenderer') {
          this.builtComps.add(comp);
          jobs.push(this.addSpriteRenderer(node, comp, this.db!, this.cam!, drawables, this.lit));
          continue;
        }
        // LineRenderer、SpriteMask（第 1 輪）：建置時不跳過未啟用的，可見與否每格由 updateDrawable 依 activeInHierarchy 與 m_Enabled 決定
        if (kind === 'LineRenderer') {
          // 第 3 輪：走受管路徑（ManagedEntry）；材質 guid 變了由 frame() 非同步重產（regenerate），裁決第 10 條
          this.builtComps.add(comp);
          // busy：同上面 TMP／Image 的第一次建置
          const lm: ManagedEntry = { kind: 'LineRenderer', node, comp, drawables: [], key: '', busy: true, warnings: [] };
          this.managed.push(lm);
          building.push(lm);
          jobs.push(
            this.buildManaged(lm, initial).then((ds) => {
              lm.drawables = ds;
              for (const d of ds) drawables.push(d);
            }),
          );
          continue;
        }
        if (kind === 'SpriteMask') {
          this.builtComps.add(comp);
          jobs.push(this.addSpriteMask(node, comp, this.db!, this.cam!, drawables));
          continue;
        }
        if (!node.activeInHierarchy || comp.m_Enabled === 0) continue;
      }
    }
    await Promise.all(jobs);
    this.uploadDirtyAtlases();
    await this.bindTextures(this.programs.filter((e) => !programsBefore.has(e)));
    // 非同步期間節點可能被 destroy（Object.Destroy 隨時可發生）：晚到的網格整個丟掉（disposeDrawable 連同 this.programs 那一筆）。
    // 只丟幾何的話程式會留在 this.programs，下一格 fillCbuffers 讀死節點就炸（10/10 的競態）。活的才進 drawables。
    const live: Drawable[] = [];
    for (const d of drawables) {
      if (d.node && !isLiveSceneNode(this.graph!, d.node)) {
        this.disposeDrawable(d);
        continue;
      }
      live.push(d);
    }
    for (const d of live) {
      this.drawables.push(d);
      this.scene3.add(d.mesh);
      if (!d.placeholder) bump(this.report.drawn, d.label);
    }
    this.scanVersion++; // 這一批的受管項目（前面已經放進 managed、busy 中）與繪製物件
    this.resortDrawables();
    for (const d of live) this.updateDrawable(d);
    for (const m of building) m.busy = false;
    // 執行期安裝的新程式要立刻填 cbuffer（同 regenerate）：fillCbuffers 只在 frame() 裡跑，安裝到下一格 frame() 之間，
    // 讀取者會看到 _ClipRect 等欄位是零。建置期（initial）的 build() 結尾就是 frame()，不在這裡填。
    // 只填這批新建的：其他程式下一格 frame() 會照常填（10/14 原本每次全部重填）
    if (!initial) this.fillCbuffers(this.programs.filter((e) => !programsBefore.has(e)));
    return live;
  }

  /**
   * 執行時期把「某節點為根的子樹」加進來（Object.Instantiate 之後呼叫；TMP_Dropdown.Show 用它畫複製出來的清單）。
   * 規則跟 build() 完全相同：Image／TextMeshProUGUI／TextMeshPro 走 buildManaged（進 managed 清單，之後每格重產偵測），
   * SpriteRenderer 走 addSpriteRenderer。呼叫端要先把節點掛進場景樹並跑完排版（graph.layout／layoutWithUI），
   * 這裡只讀 node.world／node.rect／node.order。
   */
  async addSubtree(root: SceneNode): Promise<void> {
    if (!this.graph || !this.db) throw new Error('addSubtree 要在 build() 之後呼叫');
    await this.addNodes(subtreeNodes(root), false);
  }

  /**
   * 執行期新增的子樹排進建置佇列（boot.ts 的 subtreeHooks.added）時先開始讀它要用的貼圖（AssetDB.texture 有快取，之後建網格拿同一份）。
   * 建網格照佇列一個一個來，以前讀貼圖也跟著排隊：第一次開新局排了 62 個子樹，地圖節點圖示每個等貼圖 260–400 ms，
   * 開局畫面（三張起始牌）4.6 秒才輪到。同一頁的第二局貼圖都在快取裡，60 個子樹 0.15 秒。
   */
  prefetchSubtree(root: SceneNode): void {
    if (!this.graph || !this.db) return;
    const keys = new Set<string>();
    for (const node of subtreeNodes(root)) {
      if (!isLiveSceneNode(this.graph, node)) continue;
      for (const comp of this.graph.components(node)) if (!this.builtComps.has(comp)) this.db.textureKeysIn(comp, keys);
    }
    for (const k of keys) void this.db.texture(k).catch(() => undefined);
  }

  /** 執行時期把子樹的 drawable 與 managed entry 清乾淨（Object.Destroy 之後呼叫；TMP_Dropdown.Hide 用它收合清單） */
  removeSubtree(root: SceneNode): void {
    const nodes = new Set<SceneNode>(subtreeNodes(root));
    for (const d of [...this.drawables]) if (d.node && nodes.has(d.node)) this.dropDrawable(d);
    for (let i = this.managed.length - 1; i >= 0; i--) {
      const m = this.managed[i];
      if (!nodes.has(m.node)) continue;
      this.builtComps.delete(m.comp);
      this.managed.splice(i, 1);
      this.scanVersion++;
    }
    for (const n of nodes) this.maskNodes.delete(n);
    this.resortDrawables();
  }

  /** 排序並重設 renderOrder（build、重產換網格、新增／移除子樹之後） */
  private resortDrawables() {
    sortDrawablesStable(this.drawables);
    this.drawables.forEach((d, i) => (d.mesh.renderOrder = i));
  }

  /**
   * 排序 key 的最後一項是場景樹順序（node.order，scene.ts:136-144 的深度優先計數）：結構改變
   * （setSiblingIndex、Object.Instantiate 插入子樹）會讓全部節點重新編號，所以每格重算。
   * Mask 的 unmask（pop）繪製排在它子樹的最後一個 order ＋ 0.5（子樹之後、下一個兄弟之前）。
   * 只更新這一格要畫的（frame() 先跑 updateDrawable 定好 visible）：不畫的 key 晚一點更新不影響要畫的彼此之間的先後
   *（排序照 key，同 key 照原本的先後），重新出現的那一格會先更新、有變就重排。MT2 戰鬥 6500 個繪製物件只畫 334 個（10/18）。
   */
  private refreshOrderKeys(list: readonly Drawable[]): boolean {
    let changed = false;
    for (const d of list) {
      if (!d.node || !d.mesh.visible) continue;
      const v = (d.popFor ? subtreeLastOrder(d.popFor) : d.node.order) + (d.orderBias ?? 0);
      if (d.key[4] !== v) {
        d.key[4] = v;
        changed = true;
      }
      if (this.db && refreshCanvasSortKey(d, this.db)) changed = true;
      // 深度項：節點移動（手牌重排等）後每格照新的世界位置重算（見 Drawable.depthOf）
      if (d.depthOf) {
        const depth = d.depthOf();
        if (d.key[3] !== depth) {
          d.key[3] = depth;
          changed = true;
        }
      }
    }
    return changed;
  }

  /** 產生一個受管元件的網格（建置與重產共用）。initial＝建置期（失敗記 report.skipped，否則記 runtimeSkipped） */
  private async buildManaged(m: ManagedEntry, initial: boolean): Promise<Drawable[]> {
    const skip = (reason: string) => bump(initial ? this.report.skipped : this.runtimeSkipped, reason);
    m.key = this.refreshKeyOf(m, true);
    const out: Drawable[] = [];
    try {
      if (m.kind === 'Image') await this.addImage(m.node, m.comp, out, skip);
      else if (m.kind === 'RawImage') await this.addRawImage(m.node, m.comp, out, skip);
      else if (m.kind === 'TrailRenderer') await this.addTrailRenderer(m.node, m.comp, out, skip);
      else if (m.kind === 'LineRenderer') await this.addLineRenderer(m.node, m.comp, this.db!, this.cam!, out, this.lit);
      else if (m.kind === 'MeshRenderer') await this.addMeshRendererBuiltin(m.node, m.comp, out, skip);
      else if (m.kind === 'ParticleSystemRenderer') await this.addParticleRenderer(m.node, m.comp, out, skip);
      else if (m.kind === 'CanvasMesh') await this.addCanvasMesh(m.node, m.comp, out, skip);
      else await this.addText(m.node, m.comp, m.kind, out, skip, m);
    } catch (err) {
      skip(`${m.kind}（產生失敗：${err instanceof Error ? err.message : err}）`);
    }
    // 建置期的 TMP warning 進 report（重產的留在 entry.warnings，不重複計數）
    if (initial && m.kind !== 'Image' && m.kind !== 'RawImage') {
      this.report.textWarnings ??= {};
      for (const w of m.warnings) bump(this.report.textWarnings, w);
    }
    return out;
  }

  /** 非同步重產一個受管元件，完成後整批換掉舊網格。完成前的 key 變更由下一格的重比對補上（m.key 記的是產生當下的輸入） */
  private async regenerate(m: ManagedEntry): Promise<void> {
    m.busy = true;
    const t0 = performance.now();
    // 同 addNodes：用 Set 快照比對抓新程式，別切 index（buildManaged 是 await 的，等待期間別的
    // regenerate／addNodes 會 dropDrawable 舊程式，this.programs 會縮，切 index 會漏綁 _MainTex 之類的貼圖）
    const programsBefore = new Set(this.programs);
    const fresh = await this.buildManaged(m, false);
    const freshPrograms = this.programs.filter((e) => !programsBefore.has(e));
    if (!this.managed.includes(m)) {
      // 重產進行中這個元件被 removeSubtree 拔掉了（TMP_Dropdown.Hide 收合清單）：新網格直接丟掉
      for (const d of fresh) this.disposeDrawable(d);
      m.busy = false;
      m.hold = false;
      return;
    }
    await this.bindTextures(freshPrograms); // 新網格的 K3 材質要重新綁貼圖（跟 build／addSubtree 同一套規則）
    for (const d of m.drawables) this.dropDrawable(d);
    // bindTextures 進行中節點可能被 destroy（上面的 managed 檢查管不到「元件還在、節點已毀」）：
    // 晚到的網格整個丟掉（disposeDrawable 連同 this.programs 那一筆），理由同 addNodes。
    const live: Drawable[] = [];
    for (const d of fresh) {
      if (d.node && !isLiveSceneNode(this.graph!, d.node)) {
        this.disposeDrawable(d);
        continue;
      }
      live.push(d);
    }
    m.drawables = live;
    for (const d of live) {
      this.drawables.push(d);
      this.scene3.add(d.mesh);
    }
    this.scanVersion++;
    this.resortDrawables();
    m.hold = false;
    for (const d of live) this.updateDrawable(d);
    // 新換上的 K3 程式立刻填 cbuffer：fillCbuffers 只在 frame() 裡跑，這裡到下一格 frame() 之間，讀取者（除錯介面、
    // settle() 之後的斷言）會讀到 _ClipRect＝0（clip-check d3 的 [0,0,0,0]）。下面是同步程式碼，中間沒有任何讀取者能插進來。
    // 只填新換上的：其他程式下一格 frame() 會照常填（10/14 原本每次重產都全部重填）
    const freshSet = new Set(freshPrograms);
    this.fillCbuffers(this.programs.filter((e) => freshSet.has(e)));
    this.regenDone.push({ kind: m.kind, ms: performance.now() - t0 });
    m.busy = false;
  }

  /** 從 drawables 清單與場景移除一個繪製物件，並釋放它的資源 */
  private dropDrawable(d: Drawable) {
    const i = this.drawables.indexOf(d);
    if (i >= 0) this.drawables.splice(i, 1);
    this.scanVersion++;
    this.disposeDrawable(d);
  }

  private disposeDrawable(d: Drawable) {
    this.scene3.remove(d.mesh);
    if (!d.sharesGeometry) d.mesh.geometry.dispose(); // Mask 的 unmask（pop）繪製跟主繪製共用同一份幾何
    if (d.mesh.userData.ownMaterial) this.retireMaterial(d.mesh.material as THREE.Material); // 遮罩的材質每個繪製物件一份（maskMaterial）
    const entry = d.mesh.userData.programEntry as { program: UnityProgram; ctx: DrawContext } | undefined;
    if (entry) {
      const i = this.programs.indexOf(entry);
      if (i >= 0) this.programs.splice(i, 1);
      this.programsVersion++;
      this.retireMaterial(d.mesh.material as THREE.Material); // K3 的材質每個繪製物件一份（unityMesh）
    }
    // 手寫 shader 的材質是 materialCache／stencilMaterials 共用的，不 dispose
  }

  /**
   * 釋放一個繪製物件專屬的材質，但每份 shader 原始碼留一個已經編譯過的不 dispose（programKeepers）。
   * three.js 在同一份原始碼的最後一個材質 dispose 時，連 program 與 shader 快取一起刪（WebGLPrograms.releaseProgram、
   * WebGLShaderCache.remove），下一個同樣的物件生出來就重新編譯連結；手機的驅動一次要好幾秒（10/15 拖牌時 tooltip 框
   * 每出現一次就重編一次，cacheKey 的 fragment ID 一路遞增）。留下來的材質不再畫，只是讓 program 的使用次數不歸零。
   */
  private retireMaterial(m: THREE.Material): void {
    if (m instanceof THREE.ShaderMaterial) {
      const key = shaderSourceKey(m);
      if (!this.programKeepers.has(key) && (this.renderer.properties.get(m) as { currentProgram?: unknown }).currentProgram !== undefined) {
        this.keepProgram(key, m);
        return;
      }
    }
    m.dispose();
  }

  /** 把已經編譯過的材質留下來保住 program；貼圖的參照放掉（不再畫，不必拉著貼圖） */
  private keepProgram(key: string, m: THREE.ShaderMaterial): void {
    for (const u of Object.values(m.uniforms)) if (u.value instanceof THREE.Texture) u.value = null;
    this.programKeepers.set(key, m);
  }

  /**
   * 預先編譯 prefab 裡 K3 材質的 Image 要用的 program（之後才生出來、第一次出現會卡住的物件，例如 tooltip 框）。
   * 跟 addImage 走同一個 createProgram（材質的 m_ValidKeywords，沒有額外 keyword），所以原始碼一樣、program 共用。
   * Mask 換過 stencil 或 RectMask2D 加 keyword 的變體不在這裡。用 compileAsync（KHR_parallel_shader_compile）不卡主執行緒；
   * 編好的材質留在 programKeepers。不影響畫面：材質不進場景，只有編譯。呼叫端不等它，失敗只記在 runtimeSkipped。
   */
  async prewarmPrefabs(files: SceneFile[]): Promise<void> {
    try {
      await this.prewarm(files);
    } catch (e) {
      bump(this.runtimeSkipped, `預編 shader 失敗：${(e as Error).message}`);
    }
  }

  private async prewarm(files: SceneFile[]): Promise<void> {
    if (!this.shaders || !this.db) return;
    const seen = new Set<string>();
    const meshes: THREE.Mesh[] = [];
    for (const file of files) {
      for (const comp of Object.values(file.components)) {
        if ((comp.script?.class ?? comp.type) !== 'Image') continue;
        const mat = this.db.material(comp.m_Material as Ref);
        if (!mat || !this.shaders.has(mat.shaderName) || mat.shaderName === 'UI/Default' || seen.has(mat.name + '|' + mat.shaderName)) continue;
        seen.add(mat.name + '|' + mat.shaderName);
        const program = await createProgram(this.shaders, mat.shaderName!, [...(mat.record.m_ValidKeywords ?? [])], mat.record.m_SavedProperties.m_Floats ?? {}, this.options.pipeline);
        if ('error' in program) continue;
        const key = shaderSourceKey(program.material);
        if (this.programKeepers.has(key)) continue;
        const g = this.unityGeometry(program, [0, 0, 0, 1, 0, 0, 0, 1, 0], [0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0], 4, [0, 1, 2], WHITE, {});
        const mesh = new THREE.Mesh(g, program.material);
        mesh.frustumCulled = false;
        meshes.push(mesh);
        this.prewarmed.push(mat.shaderName!);
      }
    }
    if (meshes.length === 0) return;
    const scene = new THREE.Scene();
    for (const m of meshes) scene.add(m);
    await this.renderer.compileAsync(scene, this.camera3);
    for (const m of meshes) {
      m.geometry.dispose();
      const material = m.material as THREE.RawShaderMaterial;
      const key = shaderSourceKey(material);
      // 編譯期間同一份原始碼可能已經有物件畫過、留下了材質：那份留著，這份照常釋放
      if (this.programKeepers.has(key)) material.dispose();
      else this.keepProgram(key, material);
    }
  }

  /** 重產偵測的 key（meshRefresh.ts）；會影響網格的輸入全在裡面。
   *  lossyScaleY／canvasScaleFactor 只給 TMP（uv0.w，TMPro_UGUI_Private.cs:4068-4090）；
   *  Image 的網格在自己區域空間，scale 不影響網格內容（Unity 也不會因 scale 重產 Image 網格）。
   *  stencil：Mask 的啟用狀態與深度改變時要換材質重產（Unity 是 SetMaterialDirty → Canvas 重建，
   *  Mask.cs:75、89、MaskableGraphic.cs:251-257 的 RecalculateMasking）。這裡用同步比對，所以放在 key 裡。
   *  full＝false（每格的比對）：節點未啟用、元件關掉、或所在的 Canvas 關掉（不畫，updateDrawable 同一條規則）時不算，回傳上次的 key
   *（每一種都是，粒子、MeshRenderer 也一樣；canvasMeshKey 原本就這樣）。Unity 的 Graphic 停用期間不重建，OnEnable 時 SetAllDirty 才重建；這裡重新啟用（或 Canvas 打開）那一格
   *  算出完整的 key，跟之前不同就重產。MT2 戰鬥 1.2 萬個受管元件 87% 是停用的，啟用的 1424 個裡又有 1206 個在牌池關掉的 Canvas 底下，
   *  每格把它們整個 JSON.stringify 占手機一格的 1/5（10/18 量）。建置（buildManaged）用 full＝true 照實記下。 */
  private refreshKeyOf(m: ManagedEntry, full = false): string {
    if (!full && (!m.node.activeInHierarchy || m.comp.m_Enabled === 0 || canvasDisabled(m.node))) return m.key;
    // LineRenderer：重產只看材質 guid（幾何每格由 refresh 同步處理）
    if (m.kind === 'LineRenderer') return 'material:' + lineMaterialGuidOf(m.comp);
    if (m.kind === 'MeshRenderer') return this.meshRendererKey(m.node, m.comp);
    if (m.kind === 'ParticleSystemRenderer') return this.particleRendererKey(m.node, m.comp);
    if (m.kind === 'CanvasMesh') return this.canvasMeshKey(m);
    if (m.kind === 'TrailRenderer') return this.trailRendererKey(m.node, m.comp);
    const isText = m.kind !== 'Image' && m.kind !== 'RawImage';
    const e = (isText ? this.drawWorld(m.node) : m.node.world).elements;
    // RawImage 的貼圖可能換成另一張內容一樣的 RenderTexture（Hud 換解析度時 new 一張）：元件 JSON 看不出來，另外比物件身分
    const tex = m.kind === 'RawImage' ? `|tex:${this.textureSig(m.comp.m_Texture)}` : '';
    // Image 的網格修改器（ui/graphicMeshModifier.ts）：修改器的種類、啟用與欄位變了要重產
    const mod = m.kind === 'Image' ? (graphicMeshModifier()?.signature(m.node) ?? '') : '';
    return tex + (mod ? `|mod:${mod}` : '') + meshRefreshKey(m.comp, {
      rect: m.node.rect,
      lossyScaleY: isText ? Math.hypot(e[4], e[5], e[6]) : 0,
      canvasScaleFactor: isText ? (m.node.canvas?.scaleFactor ?? null) : null,
      tint: getCanvasRendererColor(this.graph!, m.node),
      canvasAlpha: this.canvasAlphaOf(m.node),
      active: m.node.activeInHierarchy,
      enabled: m.comp.m_Enabled !== 0,
      stencil: this.stencilSignatureOf(m),
      // RectMask2D 掛勾／valid 變化要重產：手寫要換帶 clipKey 的材質、K3 要換帶 UNITY_UI_CLIP_RECT
      // 的 variant（keyword 在 createProgram 時定）。rect 值變動不重產（每格更新 uniform）
      clip: this.clips?.clipOf(m.node.id)?.valid ? '1' : '0',
      // 掛勾版本（vertexHooks.ts）：版本變了就整個重產（裁決 3 方案 A）；沒有掛勾時是 ''，key 不變
      hook: isText ? (this.textHooks.get(m.comp)?.version ?? '') : '',
      live: isText ? null : this.liveMaterialColors(m.comp),
    });
  }

  /** Image／RawImage 的 m_Material 是執行期材質（new Material、renderer.material 的複本）且走 K3 shader（addImage／addRawImage 的 useK3）時，
   *  它的 m_Colors：fillCbuffers 每格從同一份 record 讀（withStencil 的複本也共用這個物件），值變了不用重產（meshRefresh.ts 的 live）。
   *  手寫 shader 在建網格時把 _Color 烤進材質（materialColor），照舊算進 key */
  private liveMaterialColors(comp: ComponentData): object | null {
    const rt = comp.m_Material as { $type?: string; $record?: MaterialInfo['record']; shaderName?: string | null } | null | undefined;
    if (rt?.$type !== 'Material' || !rt.$record) return null;
    const name = rt.shaderName ?? null;
    if (!this.shaders?.has(name) || name === 'UI/Default') return null;
    return rt.$record.m_SavedProperties?.m_Colors ?? null;
  }

  /** 這個 Graphic 目前的 stencil 狀態簽章（重產偵測用）。沒有任何 Mask 啟用、或不是 uGUI Graphic 時是空字串。
   *  簽章只比「Mask 算出來的那組值」，材質自己序列化的 _Stencil* 不在裡面——那些隨元件的 m_Material 一起進 key。 */
  private stencilSignatureOf(m: ManagedEntry): string {
    if (!this.maskedNodes?.has(m.node) || !isMaskableKind(m.kind)) return '';
    const st = graphicStencil(this.graph!, m.node, DEFAULT_STENCIL, true);
    return `${stencilKey(st.state)}|${st.pop ? stencilKey(st.pop) : ''}`;
  }

  /** 往上的 CanvasGroup alpha 乘積（同一個 Canvas 內；CanvasGroup.cs 的 alpha 是逐層相乘） */
  private canvasAlphaOf(node: SceneNode): number {
    if (!node.canvas || !this.graph) return 1;
    let alpha = 1;
    for (let n: SceneNode | null = node; n && n.canvas === node.canvas; n = n.parent) {
      const g = this.graph.component(n, 'CanvasGroup');
      if (g && g.m_Enabled !== 0) alpha *= (g.m_Alpha as number | undefined) ?? 1;
    }
    return alpha;
  }

  // ───────── Mask 的 stencil 裁切（uGUI 的規則在 ui/mask.ts，這裡把它套到 three.js 的材質上） ─────────

  /** 每格重算哪些 Mask 是 MaskEnabled()（Mask.cs:55-62：看 activeInHierarchy 與 m_Enabled，兩者腳本都會改），
   *  以及受它們影響的節點（只有 Mask 子樹裡的 Graphic 的 stencil 會變，其他節點直接短路） */
  private updateMaskState(): void {
    const active = activeMaskNodes(this.graph!, this.maskNodes);
    if (active.length === 0) {
      this.maskedNodes = null;
      return;
    }
    const set = new Set<SceneNode>();
    for (const m of active) for (const n of maskSubtree(m)) set.add(n);
    this.maskedNodes = set;
  }

  /**
   * 一個 uGUI Graphic 畫的時候的 stencil 狀態（Graphic.materialForRendering 的 IMaterialModifier 鏈，
   * Graphic.cs:210-224 → ui/mask.ts 的 graphicStencil）。base 是材質自己序列化的 _Stencil*。
   * 沒有任何 Mask 啟用時直接回傳 base，不走祖先鏈。
   */
  private stencilOf(node: SceneNode, kind: ManagedEntry['kind'], base: StencilState, hasStencilProps: boolean): GraphicStencil {
    if (!this.maskedNodes?.has(node) || !isMaskableKind(kind)) return { state: base, pop: null, masking: false };
    return graphicStencil(this.graph!, node, base, hasStencilProps);
  }

  /**
   * StencilMaterial.cs:61-90 的六個 HasProperty 檢查（缺一就回傳原材質，Unity 會印 warning）。
   * K3 的 shader 讀 index.json 的 properties；手寫的內建 shader：UI/Default 六個都有（見 ui/mask.ts 的
   * DEFAULT_STENCIL 註解），Sprites/Default 一個都沒有（materials.json 裡唯一用它的 UpgradeLine，
   * floats 沒有任何 _Stencil*），沒有轉出的 shader 一樣當成沒有。
   */
  private async hasStencilProperties(mat: MaterialInfo | null, kind: ShaderKind): Promise<boolean> {
    if (!mat || !this.shaders?.has(mat.shaderName)) return kind === 'ui';
    const name = mat.shaderName!;
    let has = this.stencilPropsCache.get(name);
    if (has === undefined) {
      const idx = await this.shaders.index(name);
      has = STENCIL_PROPERTIES.every((p) => idx.properties.some((x) => x.name === p));
      this.stencilPropsCache.set(name, has);
    }
    return has;
  }

  /**
   * StencilMaterial.Add 的材質那一半（StencilMaterial.cs:101-130）：複製一份 MaterialInfo，寫那七個 float
   * （:114-120）、開關 UNITY_UI_ALPHACLIP keyword（:121-128）。K3 的材質走這條：createProgram 從這七個值
   * 算 render state（unityShader.ts 檔頭「stencil」）與變體。名字照 StencilMaterial.cs:113。
   */
  private withStencil(mat: MaterialInfo, s: StencilState): MaterialInfo {
    const floats = { ...(mat.record.m_SavedProperties.m_Floats ?? {}) };
    floats._Stencil = s.ref;
    floats._StencilOp = s.op;
    floats._StencilComp = s.comp;
    floats._StencilReadMask = s.readMask;
    floats._StencilWriteMask = s.writeMask;
    floats._ColorMask = s.colorMask;
    floats._UseUIAlphaClip = s.alphaClip ? 1 : 0;
    const keywords = (mat.record.m_ValidKeywords ?? []).filter((k) => k !== 'UNITY_UI_ALPHACLIP');
    if (s.alphaClip) keywords.push('UNITY_UI_ALPHACLIP');
    return {
      ...mat,
      name: `Stencil Id:${s.ref}, Op:${s.op}, Comp:${s.comp}, WriteMask:${s.writeMask}, ReadMask:${s.readMask}, ColorMask:${s.colorMask} AlphaClip:${s.alphaClip} (${mat.name})`,
      record: { ...mat.record, m_ValidKeywords: keywords, m_SavedProperties: { ...mat.record.m_SavedProperties, m_Floats: floats } },
    };
  }

  /** 手寫 shader 的材質版 StencilMaterial.Add：同一組參數共用一份 clone（StencilMaterial.cs:91-100 的快取同理）。
   *  手寫材質是 materialCache 共用的，不能就地改狀態。ColorMask 只有 0 與 All 兩種能表達（three.js 的
   *  Material.colorWrite 是布林），這個專案的 Mask 只用這兩種。 */
  private stencilMaterial(base: THREE.RawShaderMaterial, s: StencilState): THREE.Material {
    if (isDefaultStencil(s)) return base;
    const key = `${base.uuid}|${stencilKey(s)}`;
    let m = this.stencilMaterials.get(key);
    if (!m) {
      m = base.clone();
      m.name = `Stencil Id:${s.ref}, Op:${s.op}, Comp:${s.comp}, WriteMask:${s.writeMask}, ReadMask:${s.readMask}, ColorMask:${s.colorMask} AlphaClip:${s.alphaClip} (${base.name})`;
      applyStencilState(m, s);
      m.colorWrite = s.colorMask !== 0;
      if (m.uniforms._UseUIAlphaClip) m.uniforms._UseUIAlphaClip.value = s.alphaClip ? 1 : 0; // StencilMaterial.cs:120
      this.stencilMaterials.set(key, m);
    }
    return m;
  }

  /**
   * Mask 的 unmask（pop）繪製：同一份網格、換成 unmask 材質，排在遮罩子樹之後再畫一次把 stencil 清回
   * （Mask.cs:132-136、143-147 的 popMaterialCount ＝ 1 ＋ SetPopMaterial）。幾何跟主繪製共用，
   * 由主繪製那個 drawable 負責 dispose。k3 ＝ 主繪製是 K3 shader 時建 unmask 材質要的輸入，null 是手寫 shader。
   */
  private async popDrawable(
    src: Drawable,
    pop: StencilState,
    k3: { mat: MaterialInfo; color: ColorRGBA; world: THREE.Matrix4; mainTexture: THREE.Texture | null; globals?: Record<string, ArrayLike<number>>; textures?: Record<string, THREE.Texture> } | null,
  ): Promise<Drawable | null> {
    let mesh: THREE.Mesh;
    if (k3) {
      const m = await this.unityMesh(this.withStencil(k3.mat, pop), [], [], 4, [], k3.color, k3.world, k3.mainTexture, { geometry: src.mesh.geometry, node: src.node, globals: k3.globals, textures: k3.textures });
      if (!m) return null;
      mesh = m;
    } else {
      mesh = new THREE.Mesh(src.mesh.geometry, this.stencilMaterial(src.mesh.material as THREE.RawShaderMaterial, pop));
      mesh.matrixAutoUpdate = false;
      mesh.matrix.copy(src.mesh.matrix);
      mesh.matrixWorldNeedsUpdate = true;
      mesh.frustumCulled = false;
    }
    return {
      mesh,
      key: [...src.key] as Drawable['key'],
      label: `${src.label}（Mask unmask）`,
      node: src.node,
      comp: src.comp,
      handwritten: src.handwritten,
      popFor: src.node,
      orderBias: 0.5,
      sharesGeometry: true,
      // 遮罩的 pop 跟來源的深度走（popDrawable 只有 UI 的遮罩會呼叫，來源的 depthOf 只有世界空間 canvas 才有）
      depthOf: src.depthOf,
    };
  }

  /** spawn-check c 隔離用：把某節點的 Mask unmask（pop）純白方塊蓋與 TMP 子網格繪製先藏住
   *（比對主文字像素時會干擾）。只動 isolated 旗標，不影響正式繪製規則。回傳藏掉的筆數。 */
  hidePopAndChildMeshDrawables(nodeId: string): number {
    let n = 0;
    for (const d of this.drawables) if (d.node && d.node.id === nodeId && (d.popFor || d.label.includes('（子網格）'))) { d.isolated = true; n++; }
    return n;
  }

  /**
   * URP 2D 光照的準備：攝影機用的 Renderer2DData、場景裡的 Light2D、每個 sorting layer 用到哪些混合樣式，
   * 每個（layer, 樣式）建一張光照貼圖並把光源畫進它的場景。回傳受光 sprite 要的資料。
   */
  private async setupLighting(graph: SceneGraph, db: AssetDB, cam: CameraInfo): Promise<LitInfo> {
    for (const t of this.lightTargets) t.target.dispose();
    this.lightTargets = [];
    this.lightScreenGlobals = [];
    const camData = graph.component(cam.node, 'UniversalAdditionalCameraData');
    const rd = (await db.rendererData((camData?.m_RendererIndex as number) ?? -1)) as Renderer2DDataLike | null;
    if (!rd?.m_LightBlendStyles) return { layerStyles: new Map(), globals: {}, styles: [], targets: [] };

    const styles = rd.m_LightBlendStyles;
    const globals: Record<string, ArrayLike<number>> = {
      _HDREmulationScale: [rd.m_HDREmulationScale],
      _UseSceneLighting: [1],
    };
    styles.forEach((st, i) => {
      globals[`_ShapeLightBlendFactors${i}`] = blendFactors(st);
      // maskTextureChannel：0 None、1–4 R／G／B／A、5–8 1−R…（這個遊戲只有 0 與 1）
      const ch = st.maskTextureChannel;
      const mask = [0, 0, 0, 0];
      if (ch >= 1 && ch <= 4) mask[ch - 1] = 1;
      if (ch >= 5 && ch <= 8) mask[ch - 5] = 1;
      globals[`_ShapeLightMaskFilter${i}`] = mask;
      globals[`_ShapeLightInvertedFilter${i}`] = ch >= 5 ? mask : [0, 0, 0, 0];
    });

    // 場景裡的 Light2D
    const lights: { node: SceneNode; data: Light2DData; layers: number[] }[] = [];
    for (const node of graph.nodes.values()) {
      if (!node.activeInHierarchy) continue;
      const c = graph.component(node, 'Light2D');
      if (!c || c.m_Enabled === 0) continue;
      const data = c as unknown as Light2DData;
      lights.push({ node, data, layers: applyToSortingLayers(data.m_ApplyToSortingLayers).map((id) => db.sortingLayerIndex(id | 0)) });
    }
    const layerStyles = new Map<number, Set<number>>();
    for (const l of lights) for (const layer of l.layers) {
      if (!layerStyles.has(layer)) layerStyles.set(layer, new Set());
      layerStyles.get(layer)!.add(l.data.m_BlendStyleIndex);
    }

    const scale = Math.min(1, Math.max(0.01, rd.m_LightRenderTextureScale));
    this.lightScale = scale;
    const w = Math.floor(this.target.width * scale);
    const h = Math.floor(this.target.height * scale);
    const pointShader = rd.m_PointLightShader && 'guid' in rd.m_PointLightShader ? await db.shaderName(rd.m_PointLightShader.guid) : null;
    const falloff = rd.m_FallOffLookup && 'guid' in rd.m_FallOffLookup ? await db.texture(rd.m_FallOffLookup.guid) : null;
    this.lightLookup ??= lightLookupTexture();
    const meshData = pointLightMesh();

    for (const [layer, set] of layerStyles) {
      for (const style of set) {
        const target = new THREE.WebGLRenderTarget(w, h, { type: THREE.HalfFloatType, depthBuffer: false, generateMipmaps: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter });
        const scene = new THREE.Scene();
        for (const l of lights) {
          if (l.data.m_BlendStyleIndex !== style || !l.layers.includes(layer)) continue;
          if (l.data.m_LightType === LIGHT_TYPE_GLOBAL) continue; // 全域光是清除色（這個遊戲沒有）
          if (l.data.m_LightType !== LIGHT_TYPE_POINT || !pointShader) {
            bump(this.report.skipped, `Light2D 類型 ${l.data.m_LightType}（還沒做）`);
            continue;
          }
          const mesh = await this.pointLight(l.node, l.data, pointShader, meshData, rd.m_HDREmulationScale, falloff, [w, h]);
          if (mesh) scene.add(mesh);
        }
        // Light2DManager.GetGlobalColor：沒有全域光就清成黑色
        this.lightTargets.push({ layer, style, target, scene, clear: new THREE.Color(0, 0, 0) });
      }
    }
    return { layerStyles, globals, styles, targets: this.lightTargets };
  }

  /** RendererLighting.SetGeneralLightShaderGlobals + SetPointLightShaderGlobals + DrawPointLight */
  private async pointLight(node: SceneNode, light: Light2DData, shaderName: string, meshData: { positions: number[]; indices: number[] }, hdrScale: number, falloff: THREE.Texture | null, size: [number, number]): Promise<THREE.Mesh | null> {
    const pos = new THREE.Vector3();
    const rot = new THREE.Quaternion();
    node.world.decompose(pos, rot, new THREE.Vector3());
    const r = light.m_PointLightOuterRadius;
    // 光的大小只看外半徑，不吃父物件的縮放（DrawPointLight 與 GetScaledLightInvMatrix 都用 TRS(位置, 旋轉, 外半徑)）
    const world = new THREE.Matrix4().compose(pos, rot, new THREE.Vector3(r, r, r));
    const noRot = new THREE.Matrix4().compose(pos, new THREE.Quaternion(), new THREE.Vector3(r, r, r));
    const intensity = light.m_Intensity * light.m_Color.a;
    const c = [light.m_Color.r * intensity, light.m_Color.g * intensity, light.m_Color.b * intensity];
    const lightColor = this.options.lightColorToLinear ? c.map(gammaToLinear) : c;
    const innerRadius = light.m_PointLightInnerRadius / r;
    const innerAngle = light.m_PointLightInnerAngle / 360;
    const outerAngle = light.m_PointLightOuterAngle / 360;
    const additive = light.m_OverlapOperation === 0;
    const mat: MaterialInfo = {
      name: 'Light2D（點光源）',
      shaderName,
      record: {
        m_Name: 'Light2D（點光源）',
        m_CustomRenderQueue: -1,
        // RendererLighting.CreateLightMaterial：Additive → Blend One One + USE_ADDITIVE_BLENDING；否則 SrcAlpha OneMinusSrcAlpha
        m_ValidKeywords: additive ? ['USE_ADDITIVE_BLENDING'] : [],
        m_SavedProperties: { m_TexEnvs: {}, m_Floats: additive ? { _SrcBlend: 1, _DstBlend: 1 } : { _SrcBlend: 5, _DstBlend: 10 }, m_Colors: {} },
      },
    };
    const lookup = this.lightLookup!;
    const textures: Record<string, THREE.Texture> = { _LightLookup: lookup };
    if (falloff) textures._FalloffLookup = falloff;
    const globals: Record<string, ArrayLike<number>> = {
      _LightColor: [lightColor[0], lightColor[1], lightColor[2], 1],
      _LightInvMatrix: world.clone().invert().elements,
      _LightNoRotInvMatrix: noRot.clone().invert().elements,
      _LightPosition: [pos.x, pos.y, pos.z, 1],
      _InnerRadiusMult: [1 / (1 - innerRadius)],
      _OuterAngle: [outerAngle],
      // 遊戲的 URP（2023 年版，Graphics 3600004b26 的 RendererLighting.cs:489）傳 _InnerAngleMult = 1 / (外角 − 內角)；
      // 內外角相同時是 Infinity，shader 乘完再 saturate，等於硬邊。2025/8 之後的版本改成傳 _InnerAngle，這裡的 shader 是舊的
      _InnerAngleMult: [1 / (outerAngle - innerAngle)],
      _IsFullSpotlight: [innerAngle === 1 ? 1 : 0],
      // 這個遊戲的光都沒開陰影（m_ShadowIntensityEnabled 0）→ ShadowRendering.DisableGlobalShadowTexture：_ShadowIntensity = 1
      _ShadowIntensity: [1],
      _ShadowVolumeIntensity: [1],
      // 沒有光呼叫過 SetGlobalShadowTexture，這個全域值從沒被設過（Unity 給 0）；_ShadowIntensity = 1 時 shader 也不讀它
      _ShadowColorMask: [0, 0, 0, 0],
      _FalloffIntensity: [light.m_FalloffIntensity],
      _InverseHDREmulationScale: [1 / hdrScale],
      _LightLookup_TexelSize: [1 / 256, 1 / 256, 256, 256],
      _ScreenParams: [size[0], size[1], 1 + 1 / size[0], 1 + 1 / size[1]],
      // URP ScriptableRenderer.SetPerCameraShaderVariables：_ScaledScreenParams ＝ 渲染目標尺寸 × renderScale。
      // 兩個 URP asset 的 m_RenderScale 都是 1、攝影機 m_AllowDynamicResolution 是 0 → 與 _ScreenParams 同值
      _ScaledScreenParams: [size[0], size[1], 1 + 1 / size[0], 1 + 1 / size[1]],
    };
    this.lightScreenGlobals.push(globals); // resize 時更新裡面的 _ScreenParams（見 resize）
    return this.unityMesh(mat, meshData.positions, [], 2, meshData.indices, { r: 0, g: 0, b: 0, a: 1 }, world, null, { globals, textures });
  }

  /** Unity 的 view 矩陣（worldToCameraMatrix）：右手系、看 -z */
  private viewMatrix(): THREE.Matrix4 {
    return FLIP_Z.clone().multiply(this.cam!.node.world.clone().invert());
  }

  /**
   * 每格：Mask 的啟用狀態、排序 key（場景樹順序）、顯示與否、手寫 shader 網格的矩陣、各自的額外更新（換 sprite…），
   * TMP／Image 的重產偵測（key 比對，變了非同步重產）、動態字型 atlas 上傳，再重填 K3 shader 的 cbuffer。
   * 場景資料（transform、元件欄位）由 World 改，這裡只讀。
   */
  /** drawables／managed 的成員變了（加入、移除、整個重建）就加一：activeScan 的快取照它失效。換順序（重排）不加 */
  private scanVersion = 0;
  private scanCache: {
    av: number;
    version: number;
    drawablesRef: Drawable[];
    drawablesLen: number;
    managedRef: ManagedEntry[];
    managedLen: number;
    drawables: Drawable[];
    managed: ManagedEntry[];
  } | null = null;

  /**
   * 每格要看的繪製物件與受管元件：節點啟用中的（沒有節點的繪製物件也算）。節點停用的，updateDrawable 只會把它設成不畫
   *（activeInHierarchy 是第一個條件），refreshKeyOf 回原本的 key（不重產）；它的 refresh（同步執行期網格的頂點、sprite）
   * 留到節點重新啟用的那一格再做，那一格畫之前一定會先做（下面的快取跟著 activeVersion 失效），畫出來一樣。
   * 快取照 graph.activeVersion（任何節點的 activeInHierarchy 真的變了才加一）與成員版本：沒變的格子，停用的還是停用。
   * 重建時把停用的設成不畫（同 updateDrawable）。MT2 戰鬥 6412 個繪製物件只有 1885 個、11859 個受管元件只有 1866 個節點啟用，
   * activeVersion 84 格變 1 次（10/18）
   */
  private activeScan(): { drawables: Drawable[]; managed: ManagedEntry[] } {
    const g = this.graph;
    const c = this.scanCache;
    if (
      g &&
      c &&
      c.av === g.activeVersion &&
      c.version === this.scanVersion &&
      c.drawablesRef === this.drawables &&
      c.drawablesLen === this.drawables.length &&
      c.managedRef === this.managed &&
      c.managedLen === this.managed.length
    )
      return c;
    const drawables: Drawable[] = [];
    for (const d of this.drawables) {
      if (!d.node || d.node.activeInHierarchy) drawables.push(d);
      else d.mesh.visible = false;
    }
    const managed: ManagedEntry[] = [];
    for (const m of this.managed) if (m.node.activeInHierarchy) managed.push(m);
    const out = { drawables, managed };
    this.scanCache = g
      ? { av: g.activeVersion, version: this.scanVersion, drawablesRef: this.drawables, drawablesLen: this.drawables.length, managedRef: this.managed, managedLen: this.managed.length, ...out }
      : null;
    return out;
  }

  frame() {
    this.refreshCamera();
    if (this.builtin) this.updateBuiltinLights();
    this.overlayMats.clear();
    this.updateMaskState();
    this.wideCull = this.computeWideCull();
    // 先定這一格畫不畫，排序 key 只更新要畫的（refreshOrderKeys）。只走節點啟用中的（activeScan）
    const scan = this.activeScan();
    for (const d of scan.drawables) this.updateDrawable(d);
    if (this.refreshOrderKeys(scan.drawables)) this.resortDrawables();
    // 這一格才出現（上一格沒畫：剛啟用、元件剛打開、所在 Canvas 剛打開）而內容跟上次產生的不同：重產完成前先不畫（hold）。
    // Unity 的 Graphic 在 OnEnable 時 SetAllDirty，出現的那一格就是新內容；這裡重產是非同步的，照畫會先露出舊網格。
    // 物件池第一次拿出來的物件，舊網格是 prefab 的佔位字：MT2 卡牌效果的彈出通知（PopupNotificationUI）第一次顯示成 [MISSING]
    //（Jason 10/18 指出）。一直在畫的照舊用舊網格撐到重產完成，不閃
    for (const m of scan.managed) {
      const showing = m.comp.m_Enabled !== 0 && !canvasDisabled(m.node);
      const appeared = showing && m.shownAt !== this.frameCount - 1;
      if (showing) m.shownAt = this.frameCount;
      // full＝false：這一圈只收 activeInHierarchy 的（activeScan）、showing 又已經比過 m_Enabled 與 canvasDisabled，
      // refreshKeyOf 的提早回傳條件在這裡永遠不成立，結果跟 full＝true 相同，但不用把三個條件再算一次。
      // （以前傳 true，每個可見元件每格重算一次 activeInHierarchy／m_Enabled／canvasDisabled；10/18 量 132 個／格）
      if (showing && !m.busy && this.refreshKeyOf(m, false) !== m.key) {
        if (appeared) m.hold = true;
        void this.regenerate(m).catch((err) => {
          m.hold = false;
          bump(this.runtimeSkipped, `${m.kind}（重產例外：${err instanceof Error ? err.message : err}）`);
        });
      }
      if (m.hold) for (const d of m.drawables) d.mesh.visible = false;
    }
    this.uploadDirtyAtlases();
    // built-in 每台攝影機畫之前各填一次（cbuffer 的 VP 是那台的），這裡不填
    if (!this.builtin) this.fillCbuffers();
    if (this.regenDone.length) {
      const texts = this.regenDone.filter((r) => r.kind !== 'Image').length;
      const ms = this.regenDone.reduce((s, r) => s + r.ms, 0);
      this.regenFrames.push({ frame: this.frameCount, texts, images: this.regenDone.length - texts, ms });
      this.regenDone = [];
    }
    this.frameCount++;
  }

  /**
   * 等所有進行中的重產（TMP／Image 因資料變動而重建網格）完成。
   * frame() 裡的 regenerate 是丟出去跑的（void），所以「改完資料 → frame() → render()」之後畫面
   * 還是舊的；第 3 階段的戰鬥畫面每次同步後要拿到確定的結果（battle-check 直接斷言文字與 sprite），
   * 用這個等它落地再重畫。
   */
  async settle(maxFrames = 240): Promise<void> {
    for (let i = 0; i < maxFrames; i++) {
      if (!this.managed.some((m) => m.busy)) return;
      await new Promise<void>((r) => requestAnimationFrame(() => r()));
    }
    this.runtimeSkipped['重產等候逾時'] = (this.runtimeSkipped['重產等候逾時'] ?? 0) + 1;
  }

  // ───────── 手機寬版：藏住原本在 16:9 畫面外的物件（Jason 10/15 定，原版沒有；只在 isWideLayout() 時） ─────────
  // 寬版的攝影機照實際比例拉寬（viewer/main.ts 的 fit），原版停在 16:9 畫面外的東西（設定面板的裝飾卡、CardWarning 的提示）
  // 會跑進兩側。整個落在 16:9 範圍外的繪製物件不畫——原版本來就看不到。地圖（OuterMapParent、MapRelated）例外：
  // 多看到一段地圖是寬版的好處。背景與全螢幕遮罩由 game/wideLayout.ts 放大到蓋滿，不在這裡處理。
  private wideCull: { vp: THREE.Matrix4; lim: number } | null = null;
  private wideExempt = new WeakMap<SceneNode, { gen: number; v: boolean }>();
  private wideBox = new WeakMap<THREE.BufferGeometry, { version: number; n: number; box: THREE.Box3 }>();

  private computeWideCull(): { vp: THREE.Matrix4; lim: number } | null {
    if (!isWideLayout() || !this.cam) return null;
    const k = this.target.width / this.target.height / (16 / 9);
    if (k <= 1.001) return null;
    return { vp: this.camera3.projectionMatrix.clone().multiply(this.viewMatrix()), lim: 1 / k };
  }

  /** 地圖（OuterMapParent、MapRelated）與寬版刻意移到兩側的節點（加寬的 Canvas、推出去的 HUD）底下不套裁切（設定面板除外） */
  private wideExempted(node: SceneNode): boolean {
    const gen = wideMovedGenerationOf();
    const hit = this.wideExempt.get(node);
    if (hit && hit.gen === gen) return hit.v;
    let v = false;
    for (let n: SceneNode | null = node; n; n = n.parent) {
      // 設定面板是置中的彈出視窗：它在 16:9 外面的（Cards 底下的裝飾卡）是停放在畫面外、開面板才滑進來的，照樣裁掉
      if (n.go.m_Name === 'SettingPanel') break;
      if (n.go.m_Name === 'OuterMapParent' || n.go.m_Name === 'MapRelated' || isWideMoved(n)) {
        v = true;
        break;
      }
    }
    this.wideExempt.set(node, { gen, v });
    return v;
  }

  private readonly wideCorner = new THREE.Vector3();
  private readonly wideMatrix = new THREE.Matrix4();

  /** 網格的包圍盒（物件空間）乘上 node.world 與 VP，整個在 NDC x ∈ [−lim, lim] 外面就是原版 16:9 畫面外 */
  private outsideSafeArea(d: Drawable, wc: { vp: THREE.Matrix4; lim: number }): boolean {
    if (!d.node || this.wideExempted(d.node)) return false;
    const g = d.mesh.geometry;
    // 手寫網格是 position，K3 shader 的網格（TMP 等）是 POSITION（同 debugDrawnScreenRect）
    const pos = (g.getAttribute('position') ?? g.getAttribute('POSITION')) as THREE.BufferAttribute | undefined;
    const n = pos ? usedVertexCount(g, pos) : 0;
    if (!pos || n === 0) return false;
    let cached = this.wideBox.get(g);
    if (!cached || cached.version !== pos.version || cached.n !== n) {
      // 同 Box3.setFromBufferAttribute，只算用到的頂點
      const box = new THREE.Box3();
      for (let i = 0; i < n; i++) box.expandByPoint(this.wideCorner.fromBufferAttribute(pos, i));
      cached = { version: pos.version, n, box };
      this.wideBox.set(g, cached);
    }
    const b = cached.box;
    const m = this.wideMatrix.multiplyMatrices(wc.vp, this.drawWorld(d.node));
    let x0 = Infinity;
    let x1 = -Infinity;
    for (let i = 0; i < 8; i++) {
      const v = this.wideCorner.set(i & 1 ? b.max.x : b.min.x, i & 2 ? b.max.y : b.min.y, i & 4 ? b.max.z : b.min.z).applyMatrix4(m);
      x0 = Math.min(x0, v.x);
      x1 = Math.max(x1, v.x);
    }
    return x1 < -wc.lim || x0 > wc.lim;
  }

  /** 單一繪製物件的每格更新（frame 與重產換上時都用） */
  private updateDrawable(d: Drawable) {
    if (d.node) d.mesh.visible = d.node.activeInHierarchy && d.comp?.m_Enabled !== 0 && !this.clips?.isCulled(d.node.id) && !d.isolated && !(isCanvasDrawable(d) && canvasDisabled(d.node));
    // 手寫 shader 的矩陣與裁切 uniform 只有要畫的才算（MT2 戰鬥 2809 個只有 162 個看得見，10/18 量）；
    // 重新出現的那一格會在這裡先算好再畫。refresh 之後才變成看得見的，在下面補
    const placed = !!(d.handwritten && d.node && d.mesh.visible);
    if (placed) this.placeHandwritten(d);
    d.refresh?.();
    if (!placed && d.handwritten && d.node && d.mesh.visible) this.placeHandwritten(d);
    // refresh 可能重設 visible（TMP），寬版裁切放在最後
    if (d.node && d.mesh.visible && this.wideCull && this.outsideSafeArea(d, this.wideCull)) d.mesh.visible = false;
  }

  /** 手寫 shader 的網格：矩陣照節點當下的位置，裁切 uniform 照當下的 RectMask2D */
  private placeHandwritten(d: Drawable) {
    d.mesh.matrix.copy(FLIP_Z).multiply(this.drawWorld(d.node!));
    d.mesh.matrixWorldNeedsUpdate = true;
    this.updateClipUniform(d);
  }

  /** 手寫 UI/Default 的 _ClipRect／_UIMaskSoftness／_ScreenParams 每格更新（等價性判定見 clipRectFor） */
  private updateClipUniform(d: Drawable) {
    const mat = d.mesh.material as THREE.RawShaderMaterial;
    const u = mat.uniforms?._ClipRect;
    if (!u || !d.node) return;
    const st = this.clips?.clipOf(d.node.id);
    if (st && st.valid) {
      (u.value as THREE.Vector4).set(...this.clipRectFor(d.node));
      const cr = this.graph?.component(d.node, 'CanvasRenderer');
      const soft = (cr?.$clippingSoftness as { x: number; y: number } | undefined) ?? { x: 0, y: 0 };
      (mat.uniforms._UIMaskSoftness.value as THREE.Vector2).set(soft.x, soft.y);
    } else {
      (u.value as THREE.Vector4).set(...NO_CLIP);
    }
    (mat.uniforms._ScreenParams.value as THREE.Vector4).set(this.target.width, this.target.height, 1 + 1 / this.target.width, 1 + 1 / this.target.height);
  }

  /**
   * 根 Canvas 空間的裁切 rect 換到 Graphic 自己的空間（四角經 W_graphic⁻¹·W_canvas 變換取 AABB）。
   * 供手寫材質 uniform 與 K3 cbuffer 的 _ClipRect 兩條路。等價性：線性部分要把軸映到軸
   * （旋轉為 90 度倍數，可含鏡射；負縮放 XY 同時取負屬此類），否則 AABB 是近似，
   * 記進繪製報告不默默照畫。
   */
  private clipRectFor(node: SceneNode): [number, number, number, number] {
    const st = this.clips!.clipOf(node.id)!;
    const T = node.world.clone().invert().multiply(st.root.world);
    const e = T.elements;
    const equivalent = (Math.abs(e[1]) < 1e-6 && Math.abs(e[4]) < 1e-6) || (Math.abs(e[0]) < 1e-6 && Math.abs(e[5]) < 1e-6);
    if (!equivalent && !this.cbufferReported) bump(this.report.skipped, 'RectMask2D 裁切換到 Graphic 空間不等價（相對於裁切 Canvas 有非 90 度倍數的旋轉）');
    const r = st.rect;
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const [cx, cy] of [
      [r.x, r.y],
      [r.x + r.width, r.y],
      [r.x, r.y + r.height],
      [r.x + r.width, r.y + r.height],
    ] as const) {
      const p = new THREE.Vector3(cx, cy, 0).applyMatrix4(T);
      x0 = Math.min(x0, p.x);
      y0 = Math.min(y0, p.y);
      x1 = Math.max(x1, p.x);
      y1 = Math.max(y1, p.y);
    }
    return [x0, y0, x1, y1];
  }

  /** 預載 sprite（動畫會換到的），之後換 sprite 是同步的 */
  async preloadSprites(db: AssetDB, refs: Iterable<Ref>): Promise<void> {
    this.db = db;
    const jobs: Promise<void>[] = [];
    for (const r of refs) if (r && 'guid' in r) jobs.push(this.loadSprite(r));
    await Promise.all(jobs);
  }

  private loadSprite(ref: Ref): Promise<void> {
    const guid = (ref as { guid: string }).guid;
    const cached = this.spriteCache.get(guid);
    if (cached) return cached instanceof Promise ? cached : Promise.resolve();
    const p = (async () => {
      const sprite = this.db!.sprite(ref);
      if (!sprite) return;
      const [mesh, texture] = await Promise.all([this.db!.spriteMesh(sprite), this.db!.texture(sprite.textureKey)]);
      this.spriteCache.set(guid, { sprite, mesh, texture });
    })();
    this.spriteCache.set(guid, p);
    return p;
  }

  private cachedSprite(ref: Ref) {
    const c = ref && 'guid' in ref ? this.spriteCache.get(ref.guid) : undefined;
    if (c && !(c instanceof Promise)) return c;
    if (ref && 'guid' in ref && !c) void this.loadSprite(ref);
    return null;
  }

  /** 填 K3 shader 的 cbuffer：frame() 每格填全部，重產／執行期新增只填新的那幾個 */
  private fillCbuffers(entries = this.programs) {
    this.updateLights3d();
    const V = this.viewMatrix();
    // shader 拿到的是 D3D 的 GPU 投影矩陣（反向深度），vertex shader 最後換回 GL（unityShader.ts 的 d3dClipToGl）
    const P = d3dProjection(this.camera3.projectionMatrix);
    const VP = P.clone().multiply(V);
    const camPos = new THREE.Vector3().setFromMatrixPosition(this.cam!.node.world);
    const w = this.passSize?.w ?? this.target.width;
    const h = this.passSize?.h ?? this.target.height;
    const near = this.cam!.near;
    const far = this.cam!.far;
    // 時間全域（Unity 手冊 Built-in shader variables）：_Time ＝ (t/20, t, 2t, 3t)，t 是場景載入後的時間（Time.timeSinceLevelLoad，乘過 timeScale）；
    // _SinTime／_CosTime ＝ t/8、t/4、t/2、t 的正弦／餘弦；unity_DeltaTime ＝ (dt, 1/dt, smoothDt, 1/smoothDt)；URP 的 _TimeParameters ＝ (t, sin t, cos t, 0)。
    // boot 接上 World 的時間（shaderTime）；沒接時（檢視頁的靜態畫面）固定 0。
    const st = this.shaderTime?.() ?? { time: 0, deltaTime: 0, smoothDeltaTime: 0 };
    const tg = shaderTimeGlobals(st.time, st.deltaTime, st.smoothDeltaTime);
    const globals: Record<string, ArrayLike<number>> = {
      unity_MatrixVP: VP.elements,
      unity_MatrixV: V.elements,
      unity_MatrixInvV: V.clone().invert().elements,
      unity_MatrixP: P.elements,
      glstate_matrix_projection: P.elements,
      unity_MatrixInvVP: VP.clone().invert().elements,
      _WorldSpaceCameraPos: [camPos.x, camPos.y, camPos.z, 0],
      _ScreenParams: [w, h, 1 + 1 / w, 1 + 1 / h],
      // 同上（URP 全域）。_TextureSampleAdd 是 Unity 原生 UI 繪製設的（規則未查證），
      // 手寫 UI/Default 一律給 0（_builtinShaders_ 同），這裡照同一個處理
      _ScaledScreenParams: [w, h, 1 + 1 / w, 1 + 1 / h],
      _TextureSampleAdd: [0, 0, 0, 0],
      _ProjectionParams: [1, near, far, 1 / far], // x = 1：沒有翻 y（直接畫進自己的 render target，不取 D3D 的 RT 慣例）
      unity_OrthoParams: [this.cam!.orthographicSize * (w / h), this.cam!.orthographicSize, 0, this.cam!.orthographic ? 1 : 0],
      ...tg,
      // URP 的 _TimeParameters ＝ (t, sin t, cos t, 0)。遊戲的卡牌 shader 用它做動畫：
      // Shader Graphs/CardPrincipleShader 的 fragment（public/game/shaders/Shader Graphs_CardPrincipleShader/
      // pass0_Sprite_Unlit_frag_3.glsl）讀 .x 當時間、.y 當正弦項（× 0.5 後加進 UV）、.z 只取 sign()，
      // 三個分量分別是 t／sin t／cos t 才講得通。t ＝ 0 時是 (0, 0, 1, 0)。
      _TimeParameters: tg._TimeParameters,
      _GlobalMipBias: [0, 0],
      _RendererColor: [1, 1, 1, 1],
      unity_WorldTransformParams: [0, 0, 0, 1],
      unity_LODFade: [1, 0, 0, 0],
    };
    for (const { program, ctx, mesh } of entries) {
      // 這一格不畫的（inactive、disabled、被 RectMask2D 整個裁掉；visible 在同一格 frame() 前面的 updateDrawable 設好）不填：
      // three.js 不畫 visible＝false 的網格，cbuffer 沒人讀；重新出現的那一格 frame() 會先填再畫（10/14：每格全填，
      // 戰鬥中這裡佔 CPU 約四成）。第一次照舊全填，下面「沒填到的欄位」報告要涵蓋全部程式
      if (this.cbufferReported && mesh && !mesh.visible) continue;
      // 節點已被 destroy（tooltip 在滑鼠移上卡牌時生、按下時 HideAllTooltips 收掉，排隊中的 addSubtree／重產晚一步才回來）：
      // 元件資料已從 file.components 刪掉，下面的 graph.component 會丟 TypeError。不畫的東西也不用填 cbuffer，跳過（10/12）
      if (ctx.node && this.graph && !isLiveSceneNode(this.graph, ctx.node)) continue;
      const M = ctx.node ? this.drawWorld(ctx.node) : ctx.world;
      // 每個繪製物件自己的值，shader 讀到才算（反矩陣、裁切框、柔邊；10/14 原本每格每個物件全算）
      const perDraw = (name: string): ArrayLike<number> | undefined => {
        switch (name) {
          case 'unity_ObjectToWorld':
            return M.elements;
          case 'unity_WorldToObject':
            return M.clone().invert().elements;
          case '_UIMaskSoftnessX':
          case '_UIMaskSoftnessY':
            return uiMaskSoftnessOf(this.graph, ctx.node)[name];
          case '_ClipRect':
            return ctx.node && this.clips?.clipOf(ctx.node.id)?.valid ? this.clipRectFor(ctx.node) : undefined;
          case 'unity_LightmapST':
            return ctx.lightmapST;
          case 'unity_Lightmap_HDR':
            // 光照圖的解碼參數：MT2 的光照圖是 BC6H（完整 HDR，textureFormat 24），Unity 給 (1, 1, 0, 0)：RGBM／dLDR 的解碼公式在 alpha＝1 時就是原值
            return ctx.lightmapST ? [1, 1, 0, 0] : undefined;
        }
        return undefined;
      };
      // 上面四種值的依據：
      // unity_ObjectToWorld／unity_WorldToObject：節點當下的世界矩陣與它的反矩陣。
      // uGUI 的 _UIMaskSoftnessX／_UIMaskSoftnessY：managed 程式碼裡沒有人 SetFloat／SetVector
      // （RectMask2D.cs:214-228 的 UpdateClipSoftness 只寫 canvasRenderer.clippingSoftness，
      // MaskableGraphic.cs:172-175；uGUI 與 TMP runtime 全部 grep「UIMaskSoftness」零命中），
      // 是 Unity 原生 CanvasRenderer 在 EnableRectClipping／clippingSoftness 之後於批次繪製時寫進材質常數緩衝。
      // 這裡在對應的位置（每個 UI 繪製物件）從 CanvasRenderer 的 clippingSoftness 填。
      // 沒有 RectMask2D 呼叫過 SetClipSoftness 時是預設值 (0,0)：RectMask2D 的 m_Softness 預設也是 (0,0)
      // （RectMask2D.cs:42、setter 在 :70-71 clamp 成 >= 0），而 PerformClipping 每次都會在 SetClipRect 之後
      // 呼叫 UpdateClipSoftness（RectMask2D.cs:211），所以 UNITY_UI_CLIP_RECT 開著的時候這個值一定被設過；
      // 沒開的時候 shader 讀不到它（TextMeshPro/Distance Field 的 v_TEXCOORD2.zw 只有帶 UNITY_UI_CLIP_RECT 的
      // fragment 變體 frag_16-19 會讀，frag_12-15 不讀，實測）。
      // UNITY_UI_CLIP_RECT 的 _ClipRect（原版 EnableRectClipping 設在 canvasRenderer 上、繪製時
      // 喂 cbuffer）。頂點在 Graphic 自己的空間 → 四角經 W_graphic⁻¹·W_canvas 變換取 AABB；
      // 判等價（非 90 度倍數旋轉不等價，記繪製報告）同 updateClipUniform，實作在 clipRectFor。
      // 沒有有效裁切時不給，往下照材質與全域找（同原本 perDraw 沒有這個 key）
      const props = this.materialOf(ctx).record.m_SavedProperties;
      const propType = propTypesOf(program.shader);
      const resolve = (name: string): ArrayLike<number> | null => {
        if (ctx.globals && name in ctx.globals) return ctx.globals[name];
        const own = perDraw(name);
        if (own) return own;
        // TMP 的 _EnvMatrix（TMPro_UGUI_Private.cs:601-611 UpdateEnvMapMatrix）：只有「材質有 _EnvMap 屬性且該貼圖
        // 非 null」時才寫入 Matrix4x4.TRS(zero, Quaternion.Euler(_EnvMatrixRotation), one)（:603-610），否則直接 return
        // （:603-604），欄位留材質的預設值。UGUI 版在整個 TMP 套件裡沒有任何呼叫者（reference/tmp-src/pre.4/
        // package/Scripts/Runtime 全掃只有 TMPro_Private.cs:365 在 ON_MATERIAL_PROPERTY_CHANGED 裡呼叫 3D 版），
        // 所以 TextMeshProUGUI 的 _EnvMatrix 永遠不會被寫。這個遊戲的 TMP 材質序列化 floats 裡也沒有 _EnvMap
        // （materials.json 143 個實測 0 個）→ 3D 版那條路也是直接 return，兩條都等同不生效。
        // 預設值 0 的依據：_EnvMatrix 沒有宣告在 shader 的 Properties 裡（reference/shaders/
        // TextMeshPro_Distance Field_1/index.json 的 66 個屬性沒有它，只有 _EnvMatrixRotation），Unity 對沒寫過、
        // 也不是屬性的 cbuffer 欄位給 0（跟這個檔案裡「從沒被設過的全域值 Unity 給 0」同一個處理，見 _ShadowColorMask）。
        // 而且它只影響 v_TEXCOORD3，TextMeshPro/Distance Field 的 8 個 fragment 變體一個都沒讀它（實測 grep 0 命中）。
        if (name === '_EnvMatrix') return [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
        // <貼圖>_HDR：DecodeHDR 的參數。一般（LDR）貼圖給 (1, 1, 0, 0)：倍率 1、次方 1、不用 alpha（RGBM 的值未做；未查證）
        if (name.endsWith('_HDR') && program.textures.some((t) => `${t.property}_HDR` === name)) return [1, 1, 0, 0];
        // <貼圖>_TexelSize：Unity 照綁上的貼圖自動給 (1/寬, 1/高, 寬, 高)（ShaderLab 文件 Properties 的 TexelSize）
        const texel = name.endsWith('_TexelSize') ? program.textures.find((t) => `${t.property}_TexelSize` === name) : undefined;
        if (texel) {
          const img = (program.material.uniforms[texel.uniform]?.value as THREE.Texture | null)?.image as { width?: number; height?: number } | undefined;
          if (img?.width && img.height) return [1 / img.width, 1 / img.height, img.width, img.height];
        }
        if (name in globals) return globals[name];
        if (props.m_Floats && name in props.m_Floats) return [props.m_Floats[name]];
        if (props.m_Ints && name in props.m_Ints) return [props.m_Ints[name]];
        if (props.m_Colors && name in props.m_Colors) {
          const c = props.m_Colors[name];
          // Color 型別（m_Type 0）在 linear 色彩空間要轉線性；Vector（1）不轉。
          // 標了 [HDR] 的顏色不轉（推論，2022.3 的文件沒寫；Unity 6 的 Material.SetColor 文件反而寫 HDR 顏色當 gamma 轉）：
          // 依據是跟原版（Windows 2.2.1）的畫面對照，戰鬥房間的火盆（Shader Graphs/FireVertical 的 HDR 色 _Color_1）轉了線性之後
          // 核心永遠到不了原版的橘黃（G 的上限 0.0153 × _Mask_Power 18.54 × 0.91 ≈ 0.26），不轉的才對得上
          return materialColorConstant(c, propType.get(name) === 0, hdrPropsOf(program.shader).has(name));
        }
        const st = name.match(/^(.*)_ST$/);
        if (st && props.m_TexEnvs?.[st[1]]) {
          const e = props.m_TexEnvs[st[1]];
          return [e.m_Scale.x, e.m_Scale.y, e.m_Offset.x, e.m_Offset.y];
        }
        if (st) return [1, 1, 0, 0];
        return null;
      };
      for (const b of program.blocks) {
        const unfilled = fillBlock(b, resolve);
        if (!this.cbufferReported) for (const f of unfilled) bump(this.report.unfilled, `${program.shader.name}：${b.cbuffer}.${f}`);
      }
    }
    if (entries === this.programs) this.cbufferReported = true;
  }

  private cbufferReported = false;

  /** built-in 的光照輸入（每格 frame() 開頭算一次） */
  private keywordSigFrame = -1;
  private keywordSig = '';
  /** 重產鍵用的光照 keyword（受管 MeshRenderer 與 ParticleSystemRenderer 每格每個都要；同一格只算一次） */
  private lightKeywordSig(): string {
    if (this.keywordSigFrame !== this.frameCount) {
      this.keywordSigFrame = this.frameCount;
      this.keywordSig = builtinKeywords(this.lightInput()).join(' ');
    }
    return this.keywordSig;
  }

  private lightInput(): BuiltinLightingInput {
    if (!this.builtinLightInput) this.builtinLightInput = this.computeLightInput();
    return this.builtinLightInput;
  }

  private computeLightInput(): BuiltinLightingInput {
    const sl = this.sceneLighting?.();
    const gs = (this.db?.project as unknown as { GraphicsSettings?: { GraphicsSettings?: { m_LightsUseLinearIntensity?: number } } } | undefined)?.GraphicsSettings?.GraphicsSettings;
    this.lightEntries = this.lightEntries.filter((l) => this.graph && isLiveSceneNode(this.graph, l.node));
    return { lights: this.lightEntries, renderSettings: sl?.renderSettings, ambientProbe: sl?.ambientProbe ?? null, lightsUseLinearIntensity: !!gs?.m_LightsUseLinearIntensity };
  }

  /** 這個圖層的光照常數（同一個圖層共用一份物件，每格就地重算） */
  private builtinGlobalsFor(layer: number): Record<string, number[]> {
    let g = this.builtinGlobals.get(layer);
    if (!g) {
      g = {};
      builtinLightGlobals(this.lightInput(), layer, g);
      this.builtinGlobals.set(layer, g);
    }
    return g;
  }

  private updateBuiltinLights(): void {
    this.builtinLightInput = this.computeLightInput();
    this.keywordSigFrame = -1;
    // 反射來源換了（換場景、cubemap 剛載好）：已經建好的程式重綁 unity_SpecCube0
    const cube = this.reflectionCube();
    if (cube !== this.boundSpecCube) {
      this.boundSpecCube = cube;
      for (const { program, ctx } of this.programs)
        for (const t of program.textures) if (t.property === 'unity_SpecCube0' && !ctx.textures?.unity_SpecCube0) program.material.uniforms[t.uniform].value = cube;
    }
    for (const [layer, g] of this.builtinGlobals) builtinLightGlobals(this.builtinLightInput, layer, g);
  }

  /** URP 前向的光源常數（render/mesh3d.ts）：場景裡啟用中的 Light、RenderSettings 的平面環境光 */
  private updateLights3d() {
    if (!this.lightEntries.length && !Object.keys(this.lights3d).length && !this.programs.some((e) => e.ctx.globals === this.lights3d)) return;
    this.lightEntries = this.lightEntries.filter((l) => this.graph && isLiveSceneNode(this.graph, l.node));
    const rs = (this.graph?.file as { settings?: { RenderSettings?: { m_AmbientSkyColor?: { r: number; g: number; b: number }; m_AmbientIntensity?: number } } } | undefined)?.settings?.RenderSettings;
    forwardLightGlobals(this.lightEntries, { color: rs?.m_AmbientSkyColor ?? { r: 0, g: 0, b: 0 }, intensity: rs?.m_AmbientIntensity ?? 1 }, this.lights3d);
  }

  /** 綁 K3 shader 的貼圖（build 時一次，之後新增／重產的網格綁自己那幾份；換 sprite 時另外換 _MainTex） */
  private async bindTextures(entries: { program: UnityProgram; ctx: DrawContext }[] = this.programs) {
    for (const { program, ctx } of entries) {
      for (const t of program.textures) {
        let tex: THREE.Texture | null = ctx.textures?.[t.property] ?? null;
        if (tex) {
          // 已指定
        } else if (t.property === '_MainTex' && ctx.mainTexture) tex = ctx.mainTexture;
        else if (t.property === 'unity_SpecCube0' && this.builtin) tex = this.reflectionCube();
        else {
          const guid = rendererTextureGuid(this.materialOf(ctx), t.property);
          if (guid) {
            const loaded = await this.db!.texture(guid).catch(() => null);
            // 等待期間同一個屬性可能被 setRendererTexture 換成別張貼圖：那張新的會自己綁，這張晚到的舊貼圖不能蓋上去
            if (rendererTextureGuid(this.materialOf(ctx), t.property) !== guid) continue;
            tex = loaded;
          }
        }
        if (tex && textureKind(tex) !== t.sampler) {
          // 貼圖跟取樣器的型別對不上：照綁的話 WebGL 丟 INVALID_OPERATION、那次取樣讀不到東西，改用預設貼圖並記一筆
          bump(this.report.unfilled, `${program.shader.name}：${t.property}（貼圖是 ${textureKind(tex)}，取樣器是 ${t.sampler}）`);
          tex = null;
        }
        program.material.uniforms[t.uniform].value = tex ?? this.defaultTexture(t.defaultTexture, t.sampler);
      }
    }
  }

  /** 這個繪製物件讀材質屬性用的紀錄：元件有專屬複本就用複本，沒有就用共用的（rendererMaterial.ts） */
  private materialOf(ctx: DrawContext): MaterialInfo {
    return (ctx.comp ? rendererMaterialIfAny(ctx.comp) : null) ?? ctx.mat;
  }

  /**
   * Renderer.material 的語意（rendererMaterial.ts 檔頭）：第一次要才複製，之後回傳同一份複本。
   * 元件沒有 m_Materials、或材質不在素材表裡就回傳 null。
   */
  rendererMaterial(comp: ComponentData): MaterialInfo | null {
    const have = rendererMaterialIfAny(comp);
    if (have) return have;
    const shared = this.db?.material(((comp.m_Materials as Ref[] | undefined) ?? [])[0] ?? null) ?? null;
    return shared ? rendererMaterialCopy(comp, shared) : null;
  }

  /**
   * Material.SetTexture（CardBase.cs:284：principleSpriteRenderer.material.SetTexture(CardArtTex, sprite.texture)）。
   * 參照同步寫進元件的複本（回來就讀得到）；已經畫出來的物件在貼圖載入後換上。textureKey 是 textures 表的 key（Texture2D 的 guid）。
   */
  async setRendererTexture(comp: ComponentData, property: string, textureKey: string): Promise<void> {
    const m = this.rendererMaterial(comp);
    if (!m) return;
    setRendererTextureRef(m, property, textureKey);
    await this.bindTextures(this.programs.filter((e) => e.ctx.comp === comp));
  }

  /** 同 setRendererTexture，但給 sprite 參照：取的是 sprite 所在的整張貼圖（sprite.texture），不是裁切後的 sprite 區域 */
  async setRendererSpriteTexture(comp: ComponentData, property: string, spriteRef: Ref): Promise<void> {
    const sprite = spriteRef && 'guid' in spriteRef ? this.db?.sprite(spriteRef) : null;
    if (!sprite) return;
    await this.setRendererTexture(comp, property, sprite.textureKey);
  }

  /**
   * shader 屬性的預設貼圖。顏色照 Unity 的內建預設貼圖（white、black、grey、bump、red；未逐一查證）。
   * 型別跟著取樣器：2DArray 給 1×1×1 的 DataArrayTexture。3D、Cube 與其他回傳 null，three.js 綁它自己的同型空貼圖
   * （全 0；目前畫得到的 shader 沒有走到這裡，骰子的 unity_SpecCube0 還沒畫）。
   */
  private defaultTexture(name: string | null, sampler: SamplerKind = '2D'): THREE.Texture | null {
    if (sampler !== '2D' && sampler !== '2DArray') return null;
    const key = `${name ?? 'white'}${sampler === '2DArray' ? ':2DArray' : ''}`;
    let t = this.defaultTextures.get(key);
    if (!t) {
      const rgba: Record<string, number[]> = {
        white: [255, 255, 255, 255],
        black: [0, 0, 0, 0],
        grey: [128, 128, 128, 128],
        gray: [128, 128, 128, 128],
        bump: [128, 128, 255, 128],
        red: [255, 0, 0, 255],
      };
      const px = new Uint8Array(rgba[name ?? 'white'] ?? rgba.white);
      t = sampler === '2DArray' ? new THREE.DataArrayTexture(px, 1, 1, 1) : new THREE.DataTexture(px, 1, 1);
      t.colorSpace = THREE.SRGBColorSpace;
      t.needsUpdate = true;
      this.defaultTextures.set(key, t);
    }
    return t;
  }

  /** K3 shader 的頂點屬性：照 vertexInputs 的 D3D 語意給（逐頂點的 attributes 優先） */
  private unityGeometry(
    program: UnityProgram,
    positions: number[],
    uvs: number[],
    uvSize: 2 | 4,
    indices: number[],
    color: ColorRGBA,
    attributes: Record<string, THREE.BufferAttribute>,
  ): THREE.BufferGeometry {
    const n = positions.length / 3;
    const g = new THREE.BufferGeometry();
    const fill = (size: number, v: number[]) => {
      const a = new Float32Array(n * size);
      for (let i = 0; i < n; i++) a.set(v, i * size);
      return a;
    };
    for (const inp of program.vertexInputs) {
      const sem = `${inp.semantic}${inp.index}`;
      let attr: THREE.BufferAttribute;
      if (attributes[sem]) attr = attributes[sem];
      else if (sem === 'POSITION0') attr = new THREE.Float32BufferAttribute(positions, 3);
      else if (sem === 'COLOR0') attr = new THREE.BufferAttribute(fill(4, [color.r, color.g, color.b, color.a]), 4);
      else if (sem === 'TEXCOORD0' && uvs.length) attr = new THREE.Float32BufferAttribute(uvs, uvSize);
      else if (sem === 'NORMAL0') attr = new THREE.BufferAttribute(fill(3, [0, 0, -1]), 3);
      else if (sem === 'TANGENT0') attr = new THREE.BufferAttribute(fill(4, [1, 0, 0, -1]), 4);
      else attr = new THREE.BufferAttribute(fill(4, [0, 0, 0, 0]), 4);
      g.setAttribute(inp.name, attr);
      // applyVertexColor 要找到頂點色屬性的實際名字（shader 的 vertexInput 名，不一定是 COLOR0）
      if (sem === 'COLOR0') g.userData.colorAttrName = inp.name;
    }
    g.setIndex(indices);
    return g;
  }

  /** 用 K3 的 shader 建網格。頂點屬性照 vertexInputs 的 D3D 語意給 */
  private async unityMesh(
    mat: MaterialInfo,
    positions: number[],
    uvs: number[],
    uvSize: 2 | 4,
    indices: number[],
    color: ColorRGBA,
    world: THREE.Matrix4,
    mainTexture: THREE.Texture | null,
    extra: {
      keywords?: string[];
      globals?: Record<string, ArrayLike<number>>;
      textures?: Record<string, THREE.Texture>;
      /** 逐頂點的屬性，key 是 D3D 語意（COLOR0、TEXCOORD0、TEXCOORD1…），優先於上面的參數 */
      attributes?: Record<string, THREE.BufferAttribute>;
      /** 世界矩陣每格從這個節點讀 */
      node?: SceneNode;
      /** SpriteRenderer 的元件（有元件專屬的材質複本時，繪製端讀複本） */
      comp?: ComponentData;
      /** 沿用現成的幾何（Mask 的 unmask 繪製跟主繪製共用同一份網格），不建新的 */
      geometry?: THREE.BufferGeometry;
      /** 指定 shader 的第幾個 pass（天空盒） */
      passIndex?: number;
      /** 烘焙光照圖的 unity_LightmapST */
      lightmapST?: number[];
      /** uGUI 的繪製（Image、RawImage、TextMeshProUGUI、CanvasMesh）：在 Overlay Canvas 底下時不加霧的 keyword（builtinKeywords） */
      canvasUi?: boolean;
    } = {},
  ): Promise<THREE.Mesh | null> {
    const floats = mat.record.m_SavedProperties.m_Floats ?? {};
    if (this.builtin) {
      // built-in：ForwardBase 的光照 keyword 與這個物件圖層的光照常數（builtinLighting.ts）。shader 的 keyword 空間沒有的會被 chooseVariant 濾掉（UI 的 shader）
      // 有烘焙光照圖的（LIGHTMAP_ON）不用光照探針：multi_compile_fwdbase 的變體是 LIGHTMAP_ON 或 LIGHTPROBE_SH 其中一個
      const lightmapped = !!extra.keywords?.includes('LIGHTMAP_ON');
      // Overlay Canvas 的 UI 不加霧：以前 UIParticle 的粒子（地圖戰鬥節點的 FX_Map_FireRing，Legacy Shaders/Particles/Additive）選到 FOG_LINEAR，
      // Overlay 那一趟的 _ProjectionParams（near −1e6、far 1e6）讓霧距離 ≈1e6、霧係數夾到 0，加法混色整個變黑
      const overlayUi = !!extra.canvasUi && !!extra.node?.canvas && this.rootCanvasOf(extra.node.canvas).renderMode === 0;
      const base = builtinKeywords(this.lightInput(), { fog: !overlayUi }).filter((k) => !(lightmapped && k === 'LIGHTPROBE_SH'));
      extra = { ...extra, keywords: [...base, ...(extra.keywords ?? [])], globals: extra.globals ?? this.builtinGlobalsFor((extra.node?.go.m_Layer as number | undefined) ?? 0) };
    }
    const program = await createProgram(this.shaders!, mat.shaderName!, [...(mat.record.m_ValidKeywords ?? []), ...(extra.keywords ?? [])], floats, this.options.pipeline, extra.passIndex);
    if ('error' in program) {
      bump(this.report.skipped, program.error);
      return null;
    }
    bump(this.report.unityShaders, `${mat.shaderName} [${program.pass.tags.LIGHTMODE ?? program.pass.name}] {${program.keywords.join(' ')}}`);
    const g = extra.geometry ?? this.unityGeometry(program, positions, uvs, uvSize, indices, color, extra.attributes ?? {});
    const mesh = new THREE.Mesh(g, program.material);
    if (program.grab) {
      // GrabPass：畫這個物件之前把目前的畫面抓進貼圖（grabScreen），shader 取樣的屬性綁那張貼圖
      const grab = program.grab;
      extra = { ...extra, textures: { ...(extra.textures ?? {}), [grab.texture]: this.grabTexture(grab.texture) } };
      mesh.onBeforeRender = () => this.grabScreen(grab);
    }
    // K3 的 shader 自己用 unity_ObjectToWorld 與 unity_MatrixVP（Unity 座標），不用 three.js 的矩陣
    mesh.matrixAutoUpdate = false;
    mesh.frustumCulled = false;
    mesh.userData.program = program;
    const entry = { program, ctx: { world, node: extra.node, comp: extra.comp, mainTexture, mat, globals: extra.globals, textures: extra.textures, lightmapST: extra.lightmapST }, mesh };
    this.programs.push(entry);
    this.programsVersion++;
    mesh.userData.programEntry = entry; // 重產換網格時要從 this.programs 移除並 dispose 材質
    return mesh;
  }

  // ───────── 反射（unity_SpecCube0） ─────────
  private specCubes = new Map<string, THREE.CubeTexture | null>();
  private boundSpecCube: THREE.Texture | null = null;
  /**
   * built-in 的 unity_SpecCube0：場景裡沒有反射探針時是 RenderSettings 的反射來源（Unity 手冊 Lighting window 的 Environment Reflections）。
   * m_DefaultReflectionMode 1（Custom）用 m_CustomReflection 那張 cubemap；0（Skybox）要用 LightingData 烘的天空盒探針，還沒做（全黑，差異清單）。
   * cubemap 非同步載，載好之前全黑（updateBuiltinLights 每格比對，換了就重綁）。MT2 的場景裡沒有 ReflectionProbe 元件
   */
  private reflectionCube(): THREE.Texture {
    const rs = this.lightInput().renderSettings as { m_DefaultReflectionMode?: number; m_CustomReflection?: { guid?: string } | null } | undefined;
    const guid = rs?.m_DefaultReflectionMode === 1 ? rs.m_CustomReflection?.guid : undefined;
    if (!guid || !this.db) return blackCubeTexture();
    if (!this.specCubes.has(guid)) {
      this.specCubes.set(guid, null);
      this.db
        .cubeTexture(guid)
        .then((cube) => this.specCubes.set(guid, cube))
        .catch((err) => bump(this.runtimeSkipped, `反射 cubemap（${err instanceof Error ? err.message : err}）`));
    }
    return this.specCubes.get(guid) ?? blackCubeTexture();
  }

  // ───────── RenderTexture ─────────
  private rtTargets = new Map<object, THREE.WebGLRenderTarget>();
  /** Release 之後已經放掉 GPU 記憶體的 */
  private rtFreed = new WeakSet<THREE.WebGLRenderTarget>();
  /** RenderTexture 物件（相容層的 RenderTextureJs）→ render target：第一次用到才配，尺寸變了重配（貼圖物件不變，RawImage 不用重產） */
  private renderTextureTarget(rt: { width: number; height: number }): THREE.WebGLRenderTarget {
    const w = Math.max(1, Math.round(rt.width));
    const h = Math.max(1, Math.round(rt.height));
    let t = this.rtTargets.get(rt);
    if (!t) {
      t = this.makeTarget(w, h);
      t.texture.minFilter = THREE.LinearFilter;
      t.texture.magFilter = THREE.LinearFilter;
      this.rtTargets.set(rt, t);
    } else if (t.width !== w || t.height !== h) t.setSize(w, h);
    return t;
  }

  // ───────── GrabPass ─────────
  private grabTextures = new Map<string, THREE.FramebufferTexture>();
  /** 這一格已經抓過的具名 GrabPass 貼圖（render 開頭清空） */
  private grabbed = new Set<string>();

  /** GrabPass 的貼圖（同名共用一張；跟 render target 同格式 SRGB8_ALPHA8，copyTexSubImage2D 要求色彩編碼一致） */
  private grabTexture(name: string): THREE.FramebufferTexture {
    let t = this.grabTextures.get(name);
    if (!t) {
      t = new THREE.FramebufferTexture(1, 1);
      t.colorSpace = THREE.SRGBColorSpace;
      t.minFilter = THREE.LinearFilter;
      t.magFilter = THREE.LinearFilter;
      this.grabTextures.set(name, t);
    }
    return t;
  }

  /**
   * 把目前畫到一半的 render target 複製進 GrabPass 的貼圖（three.js 在畫那個物件之前叫，onBeforeRender）。
   * 沒取名的每個物件各抓一次；取了名的這一格只抓第一次。大小跟著目前的 render target，變了就重配。
   * 方向：這裡的 render target 是 GL 的列序（第 0 列在下），MT2 的 FX shader 用 ComputeScreenPos（乘 _ProjectionParams.x，這裡是 1）算取樣座標，
   * 兩邊一致；用 ComputeGrabScreenPos 的 shader（D3D 編譯時 y 固定乘 −1）會上下顛倒，MT2 的材質沒用到（差異清單）
   */
  private grabScreen(grab: { texture: string; perObject: boolean }): void {
    if (!grab.perObject && this.grabbed.has(grab.texture)) return;
    this.grabbed.add(grab.texture);
    const rt = this.renderer.getRenderTarget();
    const w = rt ? rt.width : this.renderer.domElement.width;
    const h = rt ? rt.height : this.renderer.domElement.height;
    const tex = this.grabTexture(grab.texture);
    const img = tex.image as { width: number; height: number };
    // 格式跟著目前的 target：後製攝影機畫進的是 HalfFloat（copyTexSubImage2D 要求兩邊同一類格式）
    const hdr = rt?.texture.type === THREE.HalfFloatType;
    if ((tex.type === THREE.HalfFloatType) !== hdr) {
      tex.dispose();
      tex.type = hdr ? THREE.HalfFloatType : THREE.UnsignedByteType;
      tex.colorSpace = hdr ? THREE.LinearSRGBColorSpace : THREE.SRGBColorSpace;
      tex.image = { width: 0, height: 0 };
    }
    if (img.width !== w || img.height !== h || (tex.image as { width: number }).width !== w) {
      tex.dispose();
      tex.image = { width: w, height: h };
      tex.needsUpdate = true;
    }
    this.renderer.copyFramebufferToTexture(tex);
  }

  /**
   * MeshRenderer（3D 網格，render/mesh3d.ts）：K3 的 URP Lit shader（UniversalForward pass，固定 _ADDITIONAL_LIGHTS 變體），
   * 頂點照 mesh 的 channel 給（語意對 vertexInputs）。MeshFilter 有執行期複本（MeshFilter.mesh，DiceObject 改 uv 與頂點色）就畫複本，
   * 每格看 version 重傳頂點。開深度測試與寫入，排在 MESH3D_LAYER。
   */
  private async addMeshRenderer(node: SceneNode, comp: ComponentData, mf: ComponentData, out: Drawable[]) {
    await this.db!.mesh(mf.m_Mesh as { guid?: string; fileID?: string } | null);
    const asset = meshAssetOf(mf.m_Mesh as { guid: string; fileID: string });
    if (!asset) {
      bump(this.report.skipped, 'MeshRenderer（網格不在 meshes.json）');
      return;
    }
    const matRef = (comp.m_Materials as Ref[] | undefined)?.[0];
    const mat = matRef ? this.db!.material(matRef) : null;
    if (!mat || !this.shaders?.has(mat.shaderName ?? null)) {
      bump(this.report.skipped, `MeshRenderer（${mat?.shaderName ?? '沒有材質'} 不在 K3 清單）`);
      return;
    }
    const src = meshInstanceOf(mf) ?? asset;
    const mesh = await this.unityMesh(mat, [...(src.channels.position?.values ?? [])], [], 2, [...asset.indices], WHITE, node.world, null, {
      keywords: ['_ADDITIONAL_LIGHTS'],
      globals: this.lights3d,
      textures: { unity_SpecCube0: blackCubeTexture() },
      attributes: meshAttributes(src),
      node,
      comp,
    });
    if (!mesh) return;
    const program = mesh.userData.program as UnityProgram;
    const material = mesh.material as THREE.RawShaderMaterial;
    material.depthTest = true;
    material.depthWrite = stateValue(program.pass.state.zWrite, mat.record.m_SavedProperties.m_Floats ?? {}) !== 0;
    // 執行期複本改了（uv、頂點色）就重傳那幾個屬性
    const attrName = new Map(program.vertexInputs.map((inp) => [`${inp.semantic}${inp.index}`, inp.name]));
    let version = meshInstanceOf(mf)?.version ?? -1;
    const refresh = () => {
      const inst = meshInstanceOf(mf);
      if (!inst || inst.version === version) return;
      version = inst.version;
      for (const [name, ch] of Object.entries(inst.channels)) {
        const sem = CHANNEL_SEMANTIC[name];
        const an = sem ? attrName.get(sem) : undefined;
        if (!an) continue;
        const attr = mesh.geometry.getAttribute(an) as THREE.BufferAttribute | undefined;
        if (attr && attr.itemSize === ch.dimension && attr.array.length === ch.values.length) {
          (attr.array as Float32Array).set(ch.values);
          attr.needsUpdate = true;
        } else mesh.geometry.setAttribute(an, new THREE.BufferAttribute(Float32Array.from(ch.values), ch.dimension));
      }
    };
    const depthOf = () => -new THREE.Vector3().setFromMatrixPosition(node.world).distanceTo(new THREE.Vector3().setFromMatrixPosition(this.cam!.node.world));
    const queue = mat.record.m_CustomRenderQueue as number | undefined;
    out.push({ mesh, key: [MESH3D_LAYER, 0, queue && queue >= 0 ? queue : 2000, depthOf(), node.order], label: 'MeshRenderer', node, comp, refresh, depthOf });
  }

  // ───────── built-in 的 MeshRenderer（資產網格與執行期網格；Spine 的 SkeletonRenderer） ─────────

  private materialIds = new WeakMap<object, number>();
  private materialIdSeq = 0;
  /** 材質參照的簽章（資產照 guid；執行期的 Material 物件照身分） */
  private materialSig(ref: unknown): string {
    if (!ref || typeof ref !== 'object') return '0';
    if ((ref as { $type?: string }).$type === 'Material') {
      let id = this.materialIds.get(ref);
      if (id === undefined) this.materialIds.set(ref, (id = ++this.materialIdSeq));
      return `rt${id}`;
    }
    const r = ref as { guid?: string; fileID?: string | number };
    return r.guid ? `${r.guid}:${r.fileID}` : '0';
  }

  /** 受管 MeshRenderer 的重產鍵：網格的來源與子網格數、材質、圖層、光照 keyword（頂點本身每格由 refresh 換，不在這裡） */
  private meshRendererKey(node: SceneNode, comp: ComponentData): string {
    const mf = this.graph!.component(node, 'MeshFilter');
    const inst = mf ? meshInstanceOf(mf) : null;
    const src = inst ? `rt:${inst.submeshes?.length ?? 1}` : `asset:${meshKeyOf(mf?.m_Mesh as { guid?: string; fileID?: string } | null) ?? ''}`;
    const mats = ((comp.m_Materials as unknown[] | undefined) ?? []).map((m) => this.materialSig(m)).join(',');
    const lm = this.lightmapOf?.(comp);
    return `${src}|${mats}|L${node.go.m_Layer ?? 0}|${this.lightKeywordSig()}|${lm ? `lm${lm.guid}:${lm.scaleOffset.join(',')}` : ''}`;
  }

  /** render queue：材質的 m_CustomRenderQueue（≥ 0），否則 shader 的 Queue tag（Background 1000、Geometry 2000、AlphaTest 2450、Transparent 3000、Overlay 4000，可帶 ±n） */
  private renderQueueOf(mat: MaterialInfo, program: UnityProgram): number {
    const custom = mat.record.m_CustomRenderQueue as number | undefined;
    if (custom !== undefined && custom >= 0) return custom;
    const tag = String(program.shader.subShaders[0]?.tags.QUEUE ?? program.pass.tags.QUEUE ?? 'Geometry');
    const m = tag.match(/^(\w+)\s*([+-]\s*\d+)?$/);
    const base: Record<string, number> = { background: 1000, geometry: 2000, alphatest: 2450, transparent: 3000, overlay: 4000 };
    const b = m ? (base[m[1].toLowerCase()] ?? 2000) : 2000;
    return b + (m?.[2] ? Number(m[2].replace(/\s/g, '')) : 0);
  }

  /**
   * built-in 的 MeshRenderer：每個材質格一個繪製物件，畫對應的子網格（材質比子網格多時，多的材質畫最後一個子網格；子網格比材質多時，多的不畫——
   * Unity 文件 Renderer.materials）。網格是 MeshFilter 的執行期網格（MeshFilter.mesh 的複本或 new Mesh()）或資產。
   * 執行期網格每格看物件與 version（Spine 每格換兩份網格輪流寫），變了就重傳頂點與這個子網格的三角形。
   * 排序鍵照 Renderer 的 sorting layer／order 與材質的 render queue，距離照物件位置（Unity 照包圍盒中心，未做）。
   */
  private async addMeshRendererBuiltin(node: SceneNode, comp: ComponentData, out: Drawable[], skip: (reason: string) => void) {
    const graph = this.graph!;
    const db = this.db!;
    const mf = graph.component(node, 'MeshFilter');
    if (!mf) return;
    await db.mesh(mf.m_Mesh as { guid?: string; fileID?: string } | null);
    const inst = meshInstanceOf(mf);
    const asset = inst ? null : meshAssetOf(mf.m_Mesh as { guid?: string; fileID?: string } | null);
    const src: MeshInstance | MeshAssetRecord | null = inst ?? asset;
    if (!src) {
      if ((mf.m_Mesh as { guid?: string } | null)?.guid) skip('MeshRenderer（網格不在 meshes.json）');
      return;
    }
    const subs = submeshIndicesOf(src);
    const mats = (comp.m_Materials as Ref[] | undefined) ?? [];
    for (let i = 0; i < mats.length && subs.length; i++) {
      const mat = db.material(mats[i]);
      if (!mat) continue;
      if (!this.shaders?.has(mat.shaderName ?? null)) {
        skip(`MeshRenderer（${mat.shaderName ?? `材質 ${mat.name} 沒有 shader`} 不在 K3 清單）`);
        continue;
      }
      const si = Math.min(i, subs.length - 1);
      const positions = Array.from(src.channels.position?.values ?? []);
      // 烘焙光照圖（Renderer.lightmapIndex／lightmapScaleOffset）：網格要有第二組 uv（光照圖座標）
      const lm = src.channels.uv1 ? (this.lightmapOf?.(comp) ?? null) : null;
      const lmTex = lm ? await db.texture(lm.guid).catch(() => null) : null;
      const mesh = await this.unityMesh(mat, positions, [], 2, subs[si], WHITE, node.world, null, {
        attributes: meshAttributes(src),
        node,
        comp,
        ...(lm && lmTex ? { keywords: ['LIGHTMAP_ON'], textures: { unity_Lightmap: lmTex }, lightmapST: lm.scaleOffset } : {}),
      });
      if (!mesh) continue;
      const program = mesh.userData.program as UnityProgram;
      let lastInst: MeshInstance | null = inst;
      let lastVersion = inst?.version ?? -1;
      const refresh = (): void => {
        const cur = meshInstanceOf(mf);
        if (!cur || (cur === lastInst && cur.version === lastVersion)) return;
        lastInst = cur;
        lastVersion = cur.version;
        writeMeshAttributes(mesh.geometry, program, cur);
        writeMeshIndex(mesh.geometry, cur.submeshes?.[si] ?? cur.indices);
      };
      const depthOf = () => -this.viewDepth(this.cam!, new THREE.Vector3().setFromMatrixPosition(node.world));
      const bias = i * 1e-3;
      out.push({
        mesh,
        key: [db.sortingLayerIndex((comp.m_SortingLayerID as number) ?? 0), (comp.m_SortingOrder as number) ?? 0, this.renderQueueOf(mat, program), depthOf(), node.order + bias],
        label: 'MeshRenderer',
        node,
        comp,
        refresh,
        depthOf,
        orderBias: bias,
      });
    }
  }

  private objectIds = new WeakMap<object, number>();
  /** 貼圖參照的簽章（資產照 guid；執行期的物件照身分） */
  private textureSig(t: unknown): string {
    if (!t || typeof t !== 'object') return '0';
    const g = (t as { guid?: string }).guid;
    if (g) return g;
    let id = this.objectIds.get(t);
    if (id === undefined) this.objectIds.set(t, (id = ++this.materialIdSeq));
    return `rt${id}`;
  }

  /** CanvasRenderer.SetTexture 給的貼圖 → three.js 貼圖（Texture2D 資產、Graphic.s_WhiteTexture）；認不得的回 null（照材質的 _MainTex） */
  private async canvasTextureOf(t: unknown): Promise<THREE.Texture | null> {
    if (!t || typeof t !== 'object') return null;
    const r = t as { guid?: string; $builtin?: string };
    if (r.$builtin === 'white') return this.whiteTexture;
    if (r.guid) return this.db!.texture(r.guid).catch(() => null);
    return null;
  }

  /** 受管 CanvasMesh（UIParticle）的重產鍵：材質、貼圖、stencil、RectMask2D 掛勾。未啟用時不問產生碼，沿用上一個 key */
  private canvasMeshKey(m: ManagedEntry): string {
    if (!m.node.activeInHierarchy || m.comp.m_Enabled === 0) return m.key;
    const cls = m.comp.script?.class ?? m.comp.type;
    const src = canvasMeshOf(cls, m.node, m.comp);
    return `${this.materialSig(src?.material)}|${this.textureSig(src?.texture)}|${this.stencilSignatureOf(m)}|${this.clips?.clipOf(m.node.id)?.valid ? 1 : 0}`;
  }

  /**
   * 腳本自己把網格交給 CanvasRenderer 的 Graphic（UIParticle：每格在 Canvas.willRenderCanvases 烘粒子網格、換到自己的座標、SetMesh）。
   * 網格在節點區域空間（照 node.world 畫，Overlay 由 drawWorld 換），材質是腳本的 material 屬性加上 Mask 的 stencil，貼圖是 SetTexture 給的
   * （蓋過材質的 _MainTex）。頂點色照 Image 的規則：gamma 值乘 CanvasRenderer 顏色後轉線性，alpha 再乘 CanvasGroup。排序同 Image。
   */
  private async addCanvasMesh(node: SceneNode, comp: ComponentData, out: Drawable[], skip: (reason: string) => void) {
    const graph = this.graph!;
    const db = this.db!;
    const cam = this.cam!;
    const canvas = node.canvas;
    const cls = comp.script?.class ?? comp.type;
    if (!canvas) {
      skip(`${cls}（不在 Canvas 底下）`);
      return;
    }
    const src = canvasMeshOf(cls, node, comp);
    if (!src?.material) return;
    const mat = db.material(src.material as Ref);
    if (!mat) return;
    if (!this.shaders?.has(mat.shaderName ?? null)) {
      skip(`${cls}（${mat.shaderName ?? `材質 ${mat.name} 沒有 shader`} 不在 K3 清單）`);
      return;
    }
    const texture = await this.canvasTextureOf(src.texture);
    const base = stencilFromMaterial(mat.record.m_SavedProperties.m_Floats, mat.record.m_ValidKeywords);
    const st = this.stencilOf(node, 'CanvasMesh', base, await this.hasStencilProperties(mat, 'ui'));
    const useMat = stencilKey(st.state) !== stencilKey(base) ? this.withStencil(mat, st.state) : mat;
    const mesh = await this.unityMesh(useMat, [0, 0, 0], [], 2, [], WHITE, node.world, texture, { node, canvasUi: true });
    if (!mesh) return;
    const program = mesh.userData.program as UnityProgram;
    const geo = mesh.geometry;
    const colorInput = program.vertexInputs.find((i) => i.semantic === 'COLOR' && i.index === 0);
    const crComp = graph.component(node, 'CanvasRenderer');
    let last: MeshInstance | null = null;
    let lastVersion = -1;
    let lastSig = '';
    const refresh = (): void => {
      const cur = (crComp ? existingCanvasRendererState(crComp)?.mesh : null) as MeshInstance | null;
      if (!cur || !cur.channels || !cur.vertexCount) {
        mesh.visible = false;
        return;
      }
      const tint = getCanvasRendererColor(graph, node);
      const alpha = this.canvasAlphaOf(node);
      const sig = `${tint ? `${tint.r},${tint.g},${tint.b},${tint.a}` : ''}|${alpha}`;
      if (cur === last && cur.version === lastVersion && sig === lastSig) return;
      last = cur;
      lastVersion = cur.version;
      lastSig = sig;
      writeMeshAttributes(geo, program, cur);
      if (colorInput) {
        const attr = geo.getAttribute(colorInput.name) as THREE.BufferAttribute;
        const a = attr.array as Float32Array;
        const ch = cur.channels.color;
        const t = tint ?? { r: 1, g: 1, b: 1, a: 1 };
        const size = attr.itemSize;
        for (let i = 0; i < cur.vertexCount; i++) {
          const o = i * size;
          const c = ch ? i * ch.dimension : -1;
          a[o] = gammaToLinear((ch ? ch.values[c] : 1) * t.r);
          a[o + 1] = gammaToLinear((ch ? ch.values[c + 1] : 1) * t.g);
          a[o + 2] = gammaToLinear((ch ? ch.values[c + 2] : 1) * t.b);
          if (size > 3) a[o + 3] = (ch && ch.dimension > 3 ? ch.values[c + 3] : 1) * t.a * alpha;
        }
        attr.needsUpdate = true;
      }
      writeMeshIndex(geo, cur.submeshes?.[0] ?? cur.indices);
    };
    const depth = canvas.planeDistance ?? this.viewDepth(cam, new THREE.Vector3().setFromMatrixPosition(canvas.node.world));
    out.push({
      mesh,
      key: [...canvasSortLayerOrder(canvas, (id) => db.sortingLayerIndex(id)), 3000, -depth, node.order],
      label: cls,
      node,
      comp,
      refresh,
      depthOf: this.uiDepthOf(cam, canvas),
    });
    if (st.pop) {
      const pop = await this.popDrawable(out[out.length - 1], st.pop, { mat, color: WHITE, world: node.world, mainTexture: texture });
      if (pop) out.push(pop);
    }
  }

  /** 受管 TrailRenderer 的重產鍵：材質、圖層、光照 keyword（點與寬度、顏色每一趟由 beforePass 重產） */
  private trailRendererKey(node: SceneNode, comp: ComponentData): string {
    const mats = ((comp.m_Materials as unknown[] | undefined) ?? []).map((m) => this.materialSig(m)).join(',');
    return `${mats}|L${node.go.m_Layer ?? 0}|${this.lightKeywordSig()}`;
  }

  /**
   * built-in 的 TrailRenderer（particles/trailRenderer.ts）：第一個材質畫 TrailWorld 留下的點連成的帶子。頂點是世界座標（unity_ObjectToWorld 是單位矩陣），
   * 每一趟畫之前照那台攝影機重產（View 對齊）。排序照 Renderer 的 sorting layer／order 與材質的 render queue，距離照物件位置
   *（Unity 照包圍盒中心，未做）。顏色照 m_ApplyActiveColorSpace 轉線性（LineRenderer 同）
   */
  private async addTrailRenderer(node: SceneNode, comp: ComponentData, out: Drawable[], skip: (reason: string) => void) {
    const db = this.db!;
    const ref = ((comp.m_Materials as Ref[] | undefined) ?? [])[0];
    const mat = ref ? db.material(ref) : null;
    if (!mat) return;
    if (!this.shaders?.has(mat.shaderName ?? null)) {
      skip(`TrailRenderer（${mat.shaderName ?? `材質 ${mat.name} 沒有 shader`} 不在 K3 清單）`);
      return;
    }
    const layer = (node.go.m_Layer as number | undefined) ?? 0;
    const mesh = await this.unityMesh(mat, [0, 0, 0], [], 2, [], WHITE, new THREE.Matrix4(), null, { comp, globals: this.builtinGlobalsFor(layer) });
    if (!mesh) return;
    const program = mesh.userData.program as UnityProgram;
    const geo = mesh.geometry;
    const linear = (comp.m_ApplyActiveColorSpace as number | undefined) !== 0;
    const beforePass = (cam: CameraInfo | null): void => {
      const path = this.trails?.pathOf(comp) ?? [];
      if (!cam || path.length < 2) {
        mesh.visible = false;
        return;
      }
      const g = buildTrailRendererGeometry(path, (comp.m_Parameters as object | undefined) ?? {}, particleCameraOf(cam), linear);
      if (!g.vertexCount) {
        mesh.visible = false;
        return;
      }
      writeParticleAttributes(geo, program, g);
    };
    const depthOf = () => -this.viewDepth(this.cam!, new THREE.Vector3().setFromMatrixPosition(node.world));
    out.push({
      mesh,
      key: [db.sortingLayerIndex((comp.m_SortingLayerID as number) ?? 0), (comp.m_SortingOrder as number) ?? 0, this.renderQueueOf(mat, program), depthOf(), node.order],
      label: 'TrailRenderer',
      node,
      comp,
      depthOf,
      beforePass,
    });
  }

  /** 受管 ParticleSystemRenderer 的重產鍵：材質、繪製模式、拖尾開關、網格、圖層、光照 keyword */
  private particleKeyMemo = new WeakMap<ComponentData, { inputs: unknown[]; key: string }>();
  private particleRendererKey(node: SceneNode, comp: ComponentData): string {
    const ps = this.graph!.component(node, 'ParticleSystem');
    const trail = (ps?.TrailModule as { enabled?: number } | undefined)?.enabled === 1;
    const matRefs = (comp.m_Materials as unknown[] | undefined) ?? [];
    // 每格每個 Renderer 都要比（場景裡幾千個）：輸入照身分比，沒變就回上次的字串
    const inputs = [comp.m_RenderMode, trail, comp.m_Mesh, node.go.m_Layer, this.lightKeywordSig(), ...matRefs];
    const memo = this.particleKeyMemo.get(comp);
    if (memo && memo.inputs.length === inputs.length && memo.inputs.every((v, i) => v === inputs[i])) return memo.key;
    const mats = matRefs.map((m) => this.materialSig(m)).join(',');
    const mesh = meshKeyOf(comp.m_Mesh as { guid?: string; fileID?: string } | null) ?? '';
    const key = `${mats}|m${comp.m_RenderMode}|t${trail ? 1 : 0}|${mesh}|L${node.go.m_Layer ?? 0}|${this.lightKeywordSig()}`;
    this.particleKeyMemo.set(comp, { inputs, key });
    return key;
  }

  /**
   * built-in 的 ParticleSystemRenderer（particles/particleMesh.ts）：粒子一個繪製物件（m_Materials[0]，renderMode 5 None 不畫）、
   * 拖尾一個（m_Materials[1]，Trails module 開著才有）。頂點是世界座標（unity_ObjectToWorld 是單位矩陣，Unity 畫粒子也是這樣），
   * 每一趟畫之前照那台攝影機重產（billboard 面向攝影機）。排序照 Renderer 的 sorting layer／order 與材質的 render queue，
   * 距離照系統的位置（Unity 照包圍盒中心加 sortingFudge，未做）；拖尾排在粒子後面一點。
   */
  private async addParticleRenderer(node: SceneNode, comp: ComponentData, out: Drawable[], skip: (reason: string) => void) {
    const graph = this.graph!;
    const db = this.db!;
    const ps = graph.component(node, 'ParticleSystem');
    if (!ps) return;
    const mats = (comp.m_Materials as Ref[] | undefined) ?? [];
    const trail = (ps.TrailModule as { enabled?: number } | undefined)?.enabled === 1;
    const slots: { ref: Ref; trail: boolean }[] = [];
    if (((comp.m_RenderMode as number) ?? 0) !== 5 && mats[0]) slots.push({ ref: mats[0], trail: false });
    if (trail && mats[1]) slots.push({ ref: mats[1], trail: true });
    let meshData: { position: ArrayLike<number>; normal?: ArrayLike<number>; uv?: ArrayLike<number>; color?: ArrayLike<number>; indices: ArrayLike<number> } | null = null;
    if ((comp.m_RenderMode as number) === 4) {
      await db.mesh(comp.m_Mesh as { guid?: string; fileID?: string } | null);
      const a = meshAssetOf(comp.m_Mesh as { guid?: string; fileID?: string } | null);
      if (!a) skip('ParticleSystemRenderer（Mesh 模式的網格不在 meshes.json）');
      else meshData = { position: a.channels.position?.values ?? [], normal: a.channels.normal?.values, uv: a.channels.uv0?.values, color: a.channels.color?.values, indices: a.indices };
    }
    const layer = (node.go.m_Layer as number | undefined) ?? 0;
    for (const slot of slots) {
      const mat = db.material(slot.ref);
      if (!mat) continue;
      if (!this.shaders?.has(mat.shaderName ?? null)) {
        skip(`ParticleSystemRenderer（${mat.shaderName ?? `材質 ${mat.name} 沒有 shader`} 不在 K3 清單）`);
        continue;
      }
      const mesh = await this.unityMesh(mat, [0, 0, 0], [], 2, [], WHITE, new THREE.Matrix4(), null, { comp, globals: this.builtinGlobalsFor(layer) });
      if (!mesh) continue;
      const program = mesh.userData.program as UnityProgram;
      const geo = mesh.geometry;
      const beforePass = (cam: CameraInfo | null): void => {
        const sim = this.particles?.existing(ps);
        if (!cam || !sim || !sim.pose || (!sim.n && !(slot.trail && sim.orphans.length))) {
          mesh.visible = false;
          return;
        }
        // render thread：粒子本身的網格交給 worker 產（ParticleSystem.GeometryJob），這裡只算大小、登記上傳來源。拖尾留在這裡
        const jobs = this.options.gfx?.particles;
        if (jobs && !slot.trail) {
          const j = jobs.job(sim, comp, meshData, particleCameraOf(cam), true);
          if (!j.vertexCount) {
            mesh.visible = false;
            return;
          }
          writeParticleAttributesJob(geo, program, comp, j.vertexCount, j.indexCount, j.job, jobs.gl);
          return;
        }
        // scratch：產出的陣列下面 writeParticleAttributes 馬上抄進 GPU 屬性，共用暫存陣列不每趟新配
        const opt = { camera: particleCameraOf(cam), renderer: comp, linearColor: true, mesh: meshData, scratch: true };
        const g = slot.trail ? buildTrails(sim, opt) : buildParticles(sim, opt);
        if (!g.vertexCount) {
          mesh.visible = false;
          return;
        }
        writeParticleAttributes(geo, program, g);
      };
      const depthOf = () => -this.viewDepth(this.cam!, new THREE.Vector3().setFromMatrixPosition(node.world));
      const bias = slot.trail ? 1e-3 : 0;
      out.push({
        mesh,
        key: [db.sortingLayerIndex((comp.m_SortingLayerID as number) ?? 0), (comp.m_SortingOrder as number) ?? 0, this.renderQueueOf(mat, program), depthOf(), node.order + bias],
        label: slot.trail ? 'ParticleSystemRenderer（拖尾）' : 'ParticleSystemRenderer',
        node,
        comp,
        depthOf,
        orderBias: bias,
        beforePass,
      });
    }
  }

  /**
   * 每格：繪製用的攝影機照目前的場景樹選（Unity 每格照啟用中的攝影機畫）。規則跟 Overlay Canvas 的排版一樣（SceneGraph.firstActiveCamera）：
   * 原本那台所在的場景卸載了、物件或元件關掉了就換一台；攝影機移動或設定改了，投影與背景色跟著重設。
   */
  private camSig = '';
  private refreshCamera(): void {
    const g = this.graph;
    if (!g) return;
    const cur = this.cam;
    const alive = !!cur && g.nodes.has(cur.node.id) && cur.node.activeInHierarchy && (cur.data.m_Enabled as number) !== 0;
    const next = alive ? cur! : g.firstActiveCamera();
    if (!next) return;
    const bg = next.data.m_BackGroundColor as ColorRGBA | undefined;
    const sig = `${next.data.gameObject}|${next.orthographic}|${next.orthographicSize}|${next.near}|${next.far}|${this.target.width}x${this.target.height}|${bg ? `${bg.r},${bg.g},${bg.b}` : ''}|${next.node.world.elements.join(',')}`;
    if (next === cur && sig === this.camSig) return;
    this.camSig = sig;
    this.cam = next;
    if (bg) {
      const bgLin = colorToLinear(bg);
      this.clearColor.setRGB(bgLin.r, bgLin.g, bgLin.b, THREE.LinearSRGBColorSpace);
    }
    this.setupCamera(next);
  }

  private setupCamera(cam: CameraInfo) {
    const aspect = this.target.width / this.target.height;
    if (!cam.orthographic && !this.builtin) bump(this.report.skipped, '透視攝影機（還沒做）');
    const h = cam.orthographicSize;
    const c = this.camera3;
    c.left = -h * aspect;
    c.right = h * aspect;
    c.top = h;
    c.bottom = -h;
    c.near = cam.near;
    c.far = cam.far;
    c.updateProjectionMatrix();
    c.matrixAutoUpdate = false;
    c.matrix.copy(FLIP_Z).multiply(cam.node.world).multiply(FLIP_Z);
    c.matrixWorldNeedsUpdate = true; // matrixAutoUpdate 關掉後，three.js 要這個旗標才會把 matrix 抄進 matrixWorld
  }

  /** color：整片一個色，或逐頂點（r, g, b, a 交錯，Image 的網格修改器） */
  private makeMesh(positions: number[], uvs: number[], indices: number[], color: ColorRGBA | Float32Array, world: THREE.Matrix4, material: THREE.Material): THREE.Mesh {
    const n = positions.length / 3;
    const colors = color instanceof Float32Array ? color : new Float32Array(n * 4);
    if (!(color instanceof Float32Array)) for (let i = 0; i < n; i++) colors.set([color.r, color.g, color.b, color.a], i * 4);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute(colors, 4));
    g.setIndex(indices);
    const mesh = new THREE.Mesh(g, material);
    mesh.matrixAutoUpdate = false;
    mesh.matrix.copy(FLIP_Z).multiply(world);
    mesh.matrixWorldNeedsUpdate = true;
    mesh.frustumCulled = false;
    mesh.userData.vertexColors = colors; // 除錯介面讀「目前畫出來的那一份網格」的頂點色
    return mesh;
  }

  /** SpriteRenderer 的網格（Simple 用 sprite 自己的網格；Sliced／Tiled 用九宮格）。uv 從頂點用 uvTransform 算 */
  private spriteGeometry(sprite: SpriteInfo, mesh: SpriteMeshRecord | null, comp: ComponentData): { positions: number[]; uvs: number[]; indices: number[] } {
    const flipX = comp.m_FlipX ? -1 : 1;
    const flipY = comp.m_FlipY ? -1 : 1;
    const positions: number[] = [];
    const uvs: number[] = [];
    if (comp.m_DrawMode === 1 || comp.m_DrawMode === 2) {
      const sliced = slicedSpriteMesh(sprite, comp.m_Size as { x: number; y: number });
      if (comp.m_DrawMode === 2) bump(this.report.skipped, 'SpriteRenderer Tiled 畫成 Sliced');
      if (sliced.note) bump(this.report.skipped, `SpriteRenderer ${sliced.note}`);
      for (let i = 0; i < sliced.positions.length; i += 3) positions.push(sliced.positions[i] * flipX, sliced.positions[i + 1] * flipY, 0);
      uvs.push(...sliced.uvs);
      const indices = flipX * flipY < 0 ? sliced.indices.map((_, k, a) => a[k - (k % 3) + [0, 2, 1][k % 3]]) : sliced.indices;
      return { positions, uvs, indices };
    }
    const m = mesh!;
    for (let i = 0; i < m.vertexCount; i++) {
      const x = m.position[i * 3];
      const y = m.position[i * 3 + 1];
      positions.push(x * flipX, y * flipY, 0);
      // build 裡的 sprite 網格沒存 UV，用 uvTransform 從頂點算（0b 驗證過，見 HANDOFF）
      uvs.push((x * sprite.uvTransform.x + sprite.uvTransform.y) / sprite.textureWidth, (y * sprite.uvTransform.z + sprite.uvTransform.w) / sprite.textureHeight);
    }
    return { positions, uvs, indices: m.indices };
  }

  private async addSpriteRenderer(node: SceneNode, comp: ComponentData, db: AssetDB, cam: CameraInfo, out: Drawable[], lit: LitInfo) {
    const ref = comp.m_Sprite as Ref;
    // m_Sprite 是 null（建置時沒有 sprite）：照記 skipped，但佔一個位置，網格是空的，什麼都不畫。Unity 畫的是 SpriteRenderer 當下的 sprite，
    // 所以之後 m_Sprite 從 null 變成有值（TooltipSystem.ShowLockHint 換上 pinHint）時，下面的 refresh 照動畫換 sprite 的同一套補上網格與貼圖。
    const empty = !comp.m_Sprite;
    if (empty) {
      bump(this.report.skipped, 'SpriteRenderer（沒有 sprite）');
      if (!this.placeholderSprites) return; // ?spritePlaceholder=0：舊的行為，不佔位
    } else if (!db.sprite(ref)) {
      bump(this.report.skipped, 'SpriteRenderer（sprite 找不到）');
      return;
    }
    if (!empty) await this.loadSprite(ref);
    const first = empty ? null : this.cachedSprite(ref)!;
    const matRef = ((comp.m_Materials as Ref[]) ?? [])[0] ?? null;
    const mat = db.material(matRef);
    const geo: { positions: number[]; uvs: number[]; indices: number[] } = first ? this.spriteGeometry(first.sprite, first.mesh, comp) : { positions: [], uvs: [], indices: [] };
    const color = colorToLinear(comp.m_Color as ColorRGBA);
    const center = new THREE.Vector3().setFromMatrixPosition(node.world);
    let drawMesh: THREE.Mesh | null = null;
    const useK3 = !!(mat && this.shaders?.has(mat.shaderName) && mat.shaderName !== 'Sprites/Default');
    if (useK3) {
      // K3 材質的佔位還沒做（unityMesh 要有貼圖才建得起來）：沒有 sprite 的先不佔位，記一筆
      if (!first) {
        bump(this.report.skipped, 'SpriteRenderer（沒有 sprite，K3 材質的佔位還沒做）');
        return;
      }
      // 受光 sprite：所在 sorting layer 有光，就打開對應混合樣式的 USE_SHAPE_LIGHT_TYPE_<n>（不受光的 shader 沒有這些 keyword，會被濾掉）
      const layer = db.sortingLayerIndex(comp.m_SortingLayerID as number);
      const styles = [...(lit.layerStyles.get(layer) ?? [])];
      const textures: Record<string, THREE.Texture> = {};
      for (const t of lit.targets) if (t.layer === layer) textures[`_ShapeLightTexture${t.style}`] = t.target.texture;
      drawMesh = await this.unityMesh(mat!, geo.positions, geo.uvs, 2, geo.indices, color, node.world, first.texture, {
        keywords: styles.map((s) => `USE_SHAPE_LIGHT_TYPE_${s}`),
        globals: lit.globals,
        textures,
        node,
        comp,
      });
      if (!drawMesh) return;
    } else {
      // 佔位（沒有 sprite）用白色貼圖：網格是空的，畫不出東西；sprite 換上來之後 refresh 會換成它的貼圖
      const base = this.material(this.shaderKind(mat, 'sprite'), first ? first.texture : this.whiteTexture, this.materialColor(mat));
      drawMesh = this.makeMesh(geo.positions, geo.uvs, geo.indices, color, node.world, this.spriteMaterial(comp, base));
      drawMesh.userData.baseMaterial = base; // 手寫材質的共用原版（套 stencil 時用它換出去）
    }
    const meshRef = drawMesh;
    // m_MaskInteraction 1、2 的 stencil（每格 refresh 比對，改了就換）
    let maskNow = maskInteractionOf(comp);
    if (maskNow !== 0) this.applyMaskState(meshRef, comp, useK3);
    let current = empty ? '' : (ref as { guid: string }).guid;
    let currentColor = color;
    // 網格跟著 sprite、翻面、Sliced／Tiled 的 m_Size 走（spriteGeometry）。卡名底圖的寬度 SetCardNameTMP 每張卡都會改
    // （CardBase.cs:1568），所以 m_Size 變了也要換網格，不只是換 sprite 才換。
    const geometryKey = () => {
      const size = comp.m_Size as { x: number; y: number } | undefined;
      const sliced = comp.m_DrawMode === 1 || comp.m_DrawMode === 2;
      return [comp.m_FlipX, comp.m_FlipY, comp.m_DrawMode, sliced ? size?.x : '', sliced ? size?.y : ''].join(',');
    };
    let currentGeometry = geometryKey();
    /** 照目前的 sprite 與 m_Size 重建網格；changeTexture 為 true 才換貼圖（sprite 換了，貼圖跟著換） */
    const regenerate = (c: { sprite: SpriteInfo; mesh: SpriteMeshRecord; texture: THREE.Texture }, changeTexture: boolean) => {
      const g = this.spriteGeometry(c.sprite, c.mesh, comp);
      if (useK3) {
        const program = meshRef.userData.program as UnityProgram;
        meshRef.geometry.dispose();
        meshRef.geometry = this.unityGeometry(program, g.positions, g.uvs, 2, g.indices, currentColor, {});
        if (changeTexture) {
          const entry = this.programs.find((p) => p.program === program);
          if (entry) entry.ctx.mainTexture = c.texture;
          const main = program.textures.find((t) => t.property === '_MainTex');
          if (main) program.material.uniforms[main.uniform].value = c.texture;
        }
      } else {
        const geom = new THREE.BufferGeometry();
        geom.setAttribute('position', new THREE.Float32BufferAttribute(g.positions, 3));
        geom.setAttribute('uv', new THREE.Float32BufferAttribute(g.uvs, 2));
        const colors = new Float32Array((g.positions.length / 3) * 4);
        geom.setAttribute('color', new THREE.Float32BufferAttribute(colors, 4));
        geom.setIndex(g.indices);
        meshRef.geometry.dispose();
        meshRef.geometry = geom;
        if (changeTexture) {
          const base = this.material(this.shaderKind(mat, 'sprite'), c.texture, this.materialColor(mat));
          meshRef.userData.baseMaterial = base;
          meshRef.material = this.spriteMaterial(comp, base); // 換貼圖會換共用材質，stencil 要重套
        }
        meshRef.userData.vertexColors = colors;
      }
      applyVertexColor(meshRef, currentColor);
    };
    // 動畫換 sprite（m_Sprite 的 PPtr 曲線）：網格與貼圖跟著換。
    // m_Color 也一起比（第 3 階段：DOTween 的 DOColor、EnemyIntentionUtil.SetIntentionIcon 的
    // intentionIcon.color 都是執行期改 SpriteRenderer.m_Color，原本只在建網格時讀一次）
    const refresh = () => {
      if (maskInteractionOf(comp) !== maskNow) {
        maskNow = maskInteractionOf(comp);
        this.applyMaskState(meshRef, comp, useK3);
      }
      const now = comp.m_Sprite as Ref;
      const guid = now && 'guid' in now ? now.guid : '';
      if (guid === current) {
        const geo = geometryKey();
        if (geo !== currentGeometry) {
          const c = this.cachedSprite(now);
          if (c) {
            currentGeometry = geo;
            regenerate(c, false);
          }
        }
        const want = colorToLinear(comp.m_Color as ColorRGBA);
        if (sameColor(want, currentColor)) return;
        currentColor = want;
        applyVertexColor(meshRef, want);
        return;
      }
      const c = this.cachedSprite(now);
      if (!c) return; // 還在載入，下一格再換
      current = guid;
      currentGeometry = geometryKey();
      regenerate(c, true);
    };
    out.push({
      mesh: drawMesh,
      key: [db.sortingLayerIndex(comp.m_SortingLayerID as number), comp.m_SortingOrder as number, 3000, -this.viewDepth(cam, center), node.order],
      label: 'SpriteRenderer',
      node,
      comp,
      placeholder: empty,
      handwritten: !useK3,
      refresh,
      depthOf: () => -this.viewDepth(cam, new THREE.Vector3().setFromMatrixPosition(node.world)),
    });
  }

  // ───────── LineRenderer 與 SpriteMask（第 1 輪；規格 4.1、4.2，裁決 3–7、10–13） ─────────

  /**
   * LineRenderer（對應 Unity 的 LineRenderer，原生元件）。材質是 K3 的 DottedLine：每條線一份材質複本（Renderer.material）。
   * 網格由 lineMesh.ts 建；m_Positions、widthCurve、colorGradient、m_MaskInteraction 等改了，下一格 refresh 會重建或重套 stencil。
   * 排序：key ＝ [sorting layer, m_SortingOrder, 3000（透明）, −距離（世界包圍盒中心）, 場景樹順序]（裁決 4）。
   */
  private async addLineRenderer(node: SceneNode, comp: ComponentData, db: AssetDB, cam: CameraInfo, out: Drawable[], lit: LitInfo) {
    const shared = db.material(((comp.m_Materials as Ref[]) ?? [])[0] ?? null);
    if (!shared) {
      bump(this.report.skipped, 'LineRenderer（材質找不到）');
      return;
    }
    if (!this.shaders?.has(shared.shaderName ?? '')) {
      bump(this.report.skipped, `LineRenderer（${shared.shaderName ?? '沒有 shader'} 不在 K3 清單，手寫版還沒做）`);
      return;
    }
    const mat = rendererMaterialCopy(comp, shared);
    const layer = db.sortingLayerIndex(comp.m_SortingLayerID as number);
    const styles = [...(lit.layerStyles.get(layer) ?? [])];
    const textures: Record<string, THREE.Texture> = {};
    for (const t of lit.targets) if (t.layer === layer) textures[`_ShapeLightTexture${t.style}`] = t.target.texture;
    const buildNow = () => buildLineMesh({ points: linePointsOf(comp), world: node.world.elements, viewForward: forwardOf(cam), style: lineStyleOf(comp) });
    const built = buildNow();
    const mesh = await this.unityMesh(mat, built.positions, built.uvs, 2, built.indices, WHITE, node.world, null, {
      keywords: styles.map((s) => `USE_SHAPE_LIGHT_TYPE_${s}`),
      globals: lit.globals,
      textures,
      node,
      comp,
      attributes: { COLOR0: new THREE.Float32BufferAttribute(built.colors, 4) },
    });
    if (!mesh) return;
    mesh.userData.lineBuilt = built;
    for (const s of built.skipped) bump(this.report.skipped, s);
    this.applyMaskState(mesh, comp, true);
    let sig = lineSignatureOf(comp, node);
    let maskNow = maskInteractionOf(comp);
    const depthOf = () => {
      const b = mesh.userData.lineBuilt as LineBuildResult;
      const c = localBoundsCenter(b.positions);
      const w = c ? new THREE.Vector3(c[0], c[1], c[2]).applyMatrix4(node.world) : new THREE.Vector3().setFromMatrixPosition(node.world);
      return -this.viewDepth(cam, w);
    };
    const refresh = () => {
      const s = lineSignatureOf(comp, node);
      if (s !== sig) {
        sig = s;
        const b = buildNow();
        const program = mesh.userData.program as UnityProgram;
        mesh.geometry.dispose();
        mesh.geometry = this.unityGeometry(program, b.positions, b.uvs, 2, b.indices, WHITE, { COLOR0: new THREE.Float32BufferAttribute(b.colors, 4) });
        mesh.userData.lineBuilt = b;
      }
      const mi = maskInteractionOf(comp);
      if (mi !== maskNow) {
        maskNow = mi;
        this.applyMaskState(mesh, comp, true);
      }
    };
    out.push({ mesh, key: [layer, comp.m_SortingOrder as number, 3000, depthOf(), node.order], label: 'LineRenderer', node, comp, refresh, depthOf });
  }

  /**
   * SpriteMask（對應 Unity 的 SpriteMask，原生元件；原版材質是 Sprites/Mask）。寫入與清除是兩片網格（同一份幾何，不同的 stencil 狀態），
   * 排序鍵的 order 欄放在範圍的邊界（maskWriteKeyOrder、maskClearKeyOrder），見 spriteMaskRange.ts。
   * 沒有自訂範圍時整層（未查證）。
   */
  private async addSpriteMask(node: SceneNode, comp: ComponentData, db: AssetDB, cam: CameraInfo, out: Drawable[]) {
    const ref = comp.m_Sprite as Ref;
    if (!ref || !('guid' in ref) || !db.sprite(ref)) {
      bump(this.report.skipped, 'SpriteMask（沒有 sprite）');
      return;
    }
    await this.loadSprite(ref);
    const c = this.cachedSprite(ref);
    if (!c) {
      bump(this.report.skipped, 'SpriteMask（sprite 載入失敗）');
      return;
    }
    const range = maskRangeOf(comp);
    if (!range.custom) bump(this.report.skipped, 'SpriteMask 沒有自訂範圍（整層，未查證）');
    const layer = db.sortingLayerIndex(comp.m_SortingLayerID as number);
    const cutoff = (comp.m_MaskAlphaCutoff as number | undefined) ?? 0;
    const geo = this.spriteGeometry(c.sprite, c.mesh, comp);
    const write = this.makeMesh(geo.positions, geo.uvs, geo.indices, WHITE, node.world, this.maskMaterial(c.texture, cutoff, maskWriteState()));
    write.userData.ownMaterial = true;
    const clear = new THREE.Mesh(write.geometry, this.maskMaterial(c.texture, cutoff, maskClearState()));
    clear.matrixAutoUpdate = false;
    clear.matrix.copy(FLIP_Z).multiply(node.world);
    clear.matrixWorldNeedsUpdate = true;
    clear.frustumCulled = false;
    clear.userData.ownMaterial = true;
    const depthOf = () => -this.viewDepth(cam, new THREE.Vector3().setFromMatrixPosition(node.world));
    out.push({ mesh: write, key: [layer, maskWriteKeyOrder(range), 3000, depthOf(), node.order], label: 'SpriteMask', node, comp, handwritten: true, depthOf });
    out.push({ mesh: clear, key: [layer, maskClearKeyOrder(range), 3000, depthOf(), node.order], label: 'SpriteMask（清除）', node, comp, handwritten: true, depthOf, sharesGeometry: true });
  }

  /** 遮罩的材質（每個繪製物件一份）：只寫 stencil、不寫顏色；stencil 狀態由 state 給（寫入或清除） */
  private maskMaterial(texture: THREE.Texture, cutoff: number, state: StencilState): THREE.RawShaderMaterial {
    const m = new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: MASK_VERTEX,
      fragmentShader: MASK_FRAGMENT,
      uniforms: { _MainTex: { value: texture }, _Cutoff: { value: cutoff } },
      transparent: true,
      depthTest: false,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.NoBlending,
    });
    applyStencilState(m, state);
    m.colorWrite = false;
    return m;
  }

  /** 手寫材質依 m_MaskInteraction 套 stencil：沒有遮罩的回傳原材質，有的回傳套了 stencil 的 clone（stencilMaterial 快取） */
  private spriteMaterial(comp: ComponentData, base: THREE.RawShaderMaterial): THREE.Material {
    const state = maskedRendererState(maskInteractionOf(comp));
    return state ? this.stencilMaterial(base, state) : base;
  }

  /**
   * 依 m_MaskInteraction 設 stencil。K3 材質是這個繪製物件自己的（unityMesh），第一次改之前先記下原來的值，interaction 變回 0 時還原；
   * 手寫材質換成套了 stencil 的 clone（或換回共用的原材質）。
   */
  private applyMaskState(mesh: THREE.Mesh, comp: ComponentData, k3: boolean) {
    const state = maskedRendererState(maskInteractionOf(comp));
    if (k3) {
      const material = mesh.material as THREE.RawShaderMaterial;
      mesh.userData.stencilBase ??= captureStencil(material);
      if (state) applyStencilState(material, state);
      else restoreStencil(material, mesh.userData.stencilBase as StencilProps);
      return;
    }
    const base = mesh.userData.baseMaterial as THREE.RawShaderMaterial | undefined;
    if (!base) return;
    mesh.material = state ? this.stencilMaterial(base, state) : base;
  }

  /** 除錯（規格 R1）：LineRenderer 的繪製物件（節點＋標籤） */
  private lineDrawableOf(node: SceneNode): Drawable | null {
    return this.drawables.find((d) => d.node === node && d.label === 'LineRenderer') ?? null;
  }

  /** 除錯（規格 R1）：LineRenderer 目前的網格：本地座標、uv、頂點色（線性 rgba）、索引，與是否畫出、跳過原因、世界包圍盒 */
  debugLineMesh(node: SceneNode): {
    drawn: boolean;
    visible: boolean;
    segments: number;
    rotated: boolean;
    skipped: string[];
    positions: number[];
    uvs: number[];
    colors: number[];
    indices: number[];
    worldMin: number[] | null;
    worldMax: number[] | null;
    key: number[];
    /** 目前程式的 shader 名字（R4 用；沒有程式時 null） */
    shader: string | null;
  } | null {
    const d = this.lineDrawableOf(node);
    const b = d?.mesh.userData.lineBuilt as LineBuildResult | undefined;
    if (!d || !b) return null;
    return {
      drawn: b.drawn,
      visible: d.mesh.visible,
      segments: b.segments,
      rotated: b.rotated,
      skipped: [...b.skipped],
      positions: [...b.positions],
      uvs: [...b.uvs],
      colors: [...b.colors],
      indices: [...b.indices],
      worldMin: b.worldMin ? [...b.worldMin] : null,
      worldMax: b.worldMax ? [...b.worldMax] : null,
      key: [...d.key],
      shader: (d.mesh.userData.programEntry as { program: UnityProgram } | undefined)?.program.shader.name ?? null,
    };
  }

  /**
   * 除錯（規格 R4）與 LineConnection.SetMaterial：LineRenderer 的 m_Materials[0] 換成 guid，材質複本作廢；
   * 下一格 frame() 看到材質 guid 變了就非同步重產（regenerate，程式與貼圖一起換）。
   */
  debugLineSetMaterial(node: SceneNode, guid: string): boolean {
    const comp = this.graph?.component(node, 'LineRenderer');
    if (!comp) return false;
    comp.m_Materials = [{ guid, fileID: '2100000' }];
    forgetRendererMaterial(comp);
    return true;
  }

  /** 除錯（規格 R1）：LineRenderer.SetPosition(index, p)；寫進元件資料，下一格 refresh 重建網格。index 超出範圍回傳 false */
  debugLineSetPosition(node: SceneNode, index: number, p: number[]): boolean {
    const comp = this.graph?.component(node, 'LineRenderer');
    const pts = comp?.m_Positions as { x: number; y: number; z: number }[] | undefined;
    if (!comp || !pts || index < 0 || index >= pts.length) return false;
    pts[index] = { x: p[0], y: p[1], z: p[2] ?? 0 };
    return true;
  }

  /** 除錯（規格 R1）：LineRenderer.startColor（第一個顏色 key）、endColor（最後一個顏色 key）；rgb 與 alpha 都寫進 key */
  debugLineSetColor(node: SceneNode, start: number[], end: number[]): boolean {
    const comp = this.graph?.component(node, 'LineRenderer');
    const g = (comp?.m_Parameters as { colorGradient?: Record<string, unknown> & { m_NumColorKeys?: number } } | undefined)?.colorGradient;
    if (!comp || !g) return false;
    const last = Math.max(0, (g.m_NumColorKeys ?? 2) - 1);
    g.key0 = { r: start[0], g: start[1], b: start[2], a: start[3] ?? 1 };
    g[`key${last}`] = { r: end[0], g: end[1], b: end[2], a: end[3] ?? 1 };
    return true;
  }

  /** 除錯（規格 R1）：材質的 float。scope ＝ copy 是這條線的複本（Renderer.material），shared 是素材那一份（db.material） */
  debugLineMaterialFloat(node: SceneNode, name: string, scope: 'copy' | 'shared'): number | null {
    const comp = this.graph?.component(node, 'LineRenderer');
    if (!comp) return null;
    const m = scope === 'copy' ? this.rendererMaterial(comp) : (this.db?.material(((comp.m_Materials as Ref[]) ?? [])[0] ?? null) ?? null);
    return m?.record.m_SavedProperties.m_Floats?.[name] ?? null;
  }

  /** 除錯（規格 R1）：Material.SetFloat 寫進這條線的材質複本 */
  debugLineSetMaterialFloat(node: SceneNode, name: string, value: number): boolean {
    const comp = this.graph?.component(node, 'LineRenderer');
    const m = comp ? this.rendererMaterial(comp) : null;
    if (!m) return false;
    setRendererFloat(m, name, value);
    return true;
  }

  /** 除錯（規格 R2）：改 m_MaskInteraction（SpriteRenderer 或 LineRenderer）；下一格 refresh 重套 stencil */
  debugSetMaskInteraction(node: SceneNode, value: number): boolean {
    const comp = this.graph?.component(node, 'SpriteRenderer') ?? this.graph?.component(node, 'LineRenderer');
    if (!comp) return false;
    comp.m_MaskInteraction = value;
    return true;
  }

  /**
   * 除錯（R3）：節點的可見繪製物件（SpriteRenderer、LineRenderer 等）在畫面上的外接框，像素座標（原點左下，同 pixels() 的列序）。
   * 頂點用節點世界矩陣與 unity_MatrixVP 換到螢幕，跟 K3 的 shader 走同一條路。沒有可見的繪製物件回傳 null。
   */
  debugDrawnScreenRect(node: SceneNode): { x0: number; y0: number; x1: number; y1: number } | null {
    if (!this.cam) return null;
    const vp = this.camera3.projectionMatrix.clone().multiply(this.viewMatrix());
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const d of this.drawables) {
      if (d.node !== node || !d.mesh.visible) continue;
      const attr = (d.mesh.geometry.getAttribute('position') ?? d.mesh.geometry.getAttribute('POSITION')) as THREE.BufferAttribute | undefined;
      if (!attr) continue;
      const n = usedVertexCount(d.mesh.geometry, attr);
      for (let i = 0; i < n; i++) {
        const v = new THREE.Vector3(attr.getX(i), attr.getY(i), attr.getZ(i)).applyMatrix4(this.drawWorld(node)).applyMatrix4(vp);
        const px = ((v.x + 1) / 2) * this.target.width;
        const py = ((v.y + 1) / 2) * this.target.height;
        x0 = Math.min(x0, px);
        y0 = Math.min(y0, py);
        x1 = Math.max(x1, px);
        y1 = Math.max(y1, py);
      }
    }
    return x0 === Infinity ? null : { x0, y0, x1, y1 };
  }

  /** 除錯：照目前的資料重畫一格（frame 會跑每個繪製物件的 refresh，render 畫到 render target） */
  debugRedraw(): void {
    this.frame();
    this.render();
  }

  private async addImage(node: SceneNode, comp: ComponentData, out: Drawable[], skip: (reason: string) => void) {
    const graph = this.graph!;
    const db = this.db!;
    const cam = this.cam!;
    const canvas = node.canvas;
    if (!canvas) {
      skip('Image（不在 Canvas 底下）');
      return;
    }
    // Overlay Canvas（renderMode 0）的 Image：畫，排序鍵見下面的 OVERLAY_LAYER（第 2 輪，裁決 4）。
    // 轉場的 Image 用的 sprite 是 blinktransition（public/game/assets/textures 的 537d309c…，2048×1152，alpha 全 255，PIL 驗證）：
    // 貼圖是中央亮、四周暗的漸層（不是單一色），頂點色（0.18867922）乘上貼圖色。所以 alpha 1 的那一格，整面的顏色每個點都不一樣，
    // 要照規格 C 的九點表取樣（±2，裁決 15），而且只能在 alpha 剛好 1 的那一格取樣；不能當成整面一個色。
    // Image.activeSprite（Image.cs:161）＝ overrideSprite ?? sprite；Selectable.DoSpriteSwap（Selectable.cs:587-592）
    // 設 m_OverrideSprite 後網格與貼圖都跟著換（refreshKeyOf 含整個元件，自動重產）
    const sprite: SpriteInfo | null = db.sprite((comp.m_OverrideSprite as Ref) ?? (comp.m_Sprite as Ref));
    const ui = imageMesh(node.rect, (node.transform as unknown as { m_Pivot: { x: number; y: number } }).m_Pivot, comp as unknown as ImageForMesh, sprite, canvas.referencePixelsPerUnit);
    if (ui.unsupported) skip(`Image ${ui.unsupported}（畫成 Simple）`);
    if (ui.positions.length === 0) return;
    const texture = sprite ? await db.texture(sprite.textureKey) : this.whiteTexture;
    const mat = db.material(comp.m_Material as Ref);
    const useK3 = !!(mat && this.shaders?.has(mat.shaderName) && mat.shaderName !== 'UI/Default');
    const kind = useK3 ? 'ui' : this.shaderKind(mat, 'ui');
    // Mask 的 stencil：Graphic.materialForRendering 的 IMaterialModifier 鏈（Graphic.cs:210-224 → ui/mask.ts）。
    // base 是材質自己序列化的 _Stencil*，Mask／MaskableGraphic 在上面疊
    const base = stencilFromMaterial(mat?.record.m_SavedProperties.m_Floats, mat?.record.m_ValidKeywords);
    const st = this.stencilOf(node, 'Image', base, await this.hasStencilProperties(mat, kind));
    const stencilChanged = stencilKey(st.state) !== stencilKey(base);
    const alpha = this.canvasAlphaOf(node);
    // CanvasRenderer 顏色（Selectable 的 ColorTint）乘進頂點色：gamma 值相乘後整體轉線性（順序未查證，見檔頭）
    const tint = getCanvasRendererColor(graph, node);
    const mc = comp.m_Color as ColorRGBA;
    const combined = tint ? { r: mc.r * tint.r, g: mc.g * tint.g, b: mc.b * tint.b, a: mc.a * tint.a } : { ...mc };
    const c = colorToLinear(combined);
    c.a *= alpha;
    let positions: number[] = [];
    for (let i = 0; i < ui.positions.length; i += 2) positions.push(ui.positions[i], ui.positions[i + 1], 0);
    let uvs = ui.uvs;
    let indices = ui.indices;
    // 網格修改器（IMeshModifier：UIFlippable、Gradient2、Outline…，ui/graphicMeshModifier.ts）：頂點照 Image.OnPopulateMesh 帶 m_Color，
    // 修改器改完的逐頂點顏色再乘 CanvasRenderer 顏色、轉線性、乘 CanvasGroup 的 alpha（同上面的單色）
    let vertexColors: Float32Array | null = null;
    const modified = graphicMeshModifier()?.modify(node, {
      positions,
      uvs,
      colors: positions.flatMap((_, i) => (i % 3 === 0 ? [mc.r, mc.g, mc.b, mc.a] : [])),
      indices,
    });
    if (modified) {
      if (modified.positions.length === 0) return;
      ({ positions, uvs, indices } = modified);
      const t = tint ?? { r: 1, g: 1, b: 1, a: 1 };
      vertexColors = new Float32Array((positions.length / 3) * 4);
      for (let i = 0; i < positions.length / 3; i++) {
        const k = colorToLinear({ r: modified.colors[i * 4] * t.r, g: modified.colors[i * 4 + 1] * t.g, b: modified.colors[i * 4 + 2] * t.b, a: modified.colors[i * 4 + 3] * t.a });
        vertexColors.set([k.r, k.g, k.b, k.a * alpha], i * 4);
      }
    }
    const depth = canvas.planeDistance ?? this.viewDepth(cam, new THREE.Vector3().setFromMatrixPosition(canvas.node.world));
    let drawMesh: THREE.Mesh | null;
    // 同一種 LightMode 的後續 pass（unityShader.ts 的 drawPasses）：共用幾何，各自一個繪製物件，排在第一個 pass 之後
    const morePasses: THREE.Mesh[] = [];
    if (useK3) {
      // UIVertex 的 uv0 是 Vector4，zw 是 0
      const uv4: number[] = [];
      for (let i = 0; i < uvs.length; i += 2) uv4.push(uvs[i], uvs[i + 1], 0, 0);
      const n = positions.length / 3;
      const colors = vertexColors ?? new Float32Array(n * 4);
      if (!vertexColors) for (let i = 0; i < n; i++) colors.set([c.r, c.g, c.b, c.a], i * 4);
      const useMat = stencilChanged ? this.withStencil(mat!, st.state) : mat!;
      drawMesh = await this.unityMesh(useMat, positions, uv4, 4, indices, { r: 1, g: 1, b: 1, a: 1 }, node.world, texture, {
        node,
        canvasUi: true,
        attributes: { COLOR0: new THREE.BufferAttribute(colors, 4) },
      });
      if (!drawMesh) return;
      drawMesh.userData.vertexColors = colors;
      const passes = drawPasses(await this.shaders!.index(mat!.shaderName!), this.options.pipeline);
      for (const pass of passes.slice(1)) {
        const m2 = await this.unityMesh(useMat, positions, uv4, 4, indices, { r: 1, g: 1, b: 1, a: 1 }, node.world, texture, { node, canvasUi: true, geometry: drawMesh.geometry, passIndex: pass.index });
        if (!m2) continue;
        m2.userData.vertexColors = colors;
        morePasses.push(m2);
      }
    } else {
      // RectMask2D 掛勾中：材質帶節點 id 做 key（每格填自己的 _ClipRect，不能與共用材質互搶 uniform）。
      // 掛勾狀態變（含關掉 RectMask2D）由 refreshKeyOf 的 clip 欄觸發重產、換回共用材質
      const clipKey = kind === 'ui' && this.clips?.clipOf(node.id)?.valid ? node.id : '';
      drawMesh = this.makeMesh(positions, uvs, indices, vertexColors ?? c, node.world, this.stencilMaterial(this.material(kind, texture, this.materialColor(mat), [0, 0, 0, 0], clipKey), st.state));
    }
    out.push({
      mesh: drawMesh,
      key: [...canvasSortLayerOrder(canvas, (id) => db.sortingLayerIndex(id)), 3000, -depth, node.order],
      label: 'Image',
      node,
      comp,
      handwritten: !useK3,
      // 世界空間 canvas：深度每格照 canvas 位置重算；Screen Space 是 undefined（見 uiDepthOf）
      depthOf: this.uiDepthOf(cam, canvas),
    });
    const main = out[out.length - 1];
    morePasses.forEach((m2, i) => {
      const bias = (i + 1) * 1e-4;
      out.push({ ...main, mesh: m2, key: [main.key[0], main.key[1], main.key[2], main.key[3], node.order + bias], orderBias: bias, sharesGeometry: true });
    });
    if (st.pop) {
      const pop = await this.popDrawable(main, st.pop, useK3 ? { mat: mat!, color: { r: 1, g: 1, b: 1, a: 1 }, world: node.world, mainTexture: texture } : null);
      if (pop) out.push(pop);
    }
  }

  /**
   * RawImage（UnityEngine.UI RawImage.cs:82-100 OnPopulateMesh）：rect 四角一片，uv 照 m_UVRect（RenderTexture 與 Texture2D 的
   * width × texelSize 都是 1）；頂點順序 (xMin,yMin)、(xMin,yMax)、(xMax,yMax)、(xMax,yMin)，三角形 (0,1,2)、(2,3,0)。
   * mainTexture（RawImage.cs:16-30）：m_Texture，沒有就材質的 _MainTex，再沒有是白色。RenderTexture 是攝影機畫進去的那張（renderTextureTarget），
   * 列序跟這裡的 render target 一樣（第 0 列在下），uv 原點左下直接對得上。顏色、CanvasRenderer 顏色、CanvasGroup、Mask、排序同 Image
   */
  private async addRawImage(node: SceneNode, comp: ComponentData, out: Drawable[], skip: (reason: string) => void) {
    const graph = this.graph!;
    const db = this.db!;
    const cam = this.cam!;
    const canvas = node.canvas;
    if (!canvas) {
      skip('RawImage（不在 Canvas 底下）');
      return;
    }
    const mat = db.material(comp.m_Material as Ref);
    const texRef = comp.m_Texture as { $type?: string; guid?: string; width?: number; height?: number } | null | undefined;
    let texture: THREE.Texture | null = null;
    if (texRef?.$type === 'RenderTexture') texture = this.renderTextureTarget(texRef as { width: number; height: number }).texture;
    else if (texRef?.guid) texture = await db.texture(texRef.guid).catch(() => null);
    else {
      const g = mat ? rendererTextureGuid(mat, '_MainTex') : null;
      texture = g ? await db.texture(g).catch(() => null) : null;
    }
    texture ??= this.whiteTexture;
    const useK3 = !!(mat && this.shaders?.has(mat.shaderName) && mat.shaderName !== 'UI/Default');
    const kind = useK3 ? 'ui' : this.shaderKind(mat, 'ui');
    const base = stencilFromMaterial(mat?.record.m_SavedProperties.m_Floats, mat?.record.m_ValidKeywords);
    const st = this.stencilOf(node, 'RawImage', base, await this.hasStencilProperties(mat, kind));
    const stencilChanged = stencilKey(st.state) !== stencilKey(base);
    const alpha = this.canvasAlphaOf(node);
    const tint = getCanvasRendererColor(graph, node);
    const mc = (comp.m_Color as ColorRGBA | undefined) ?? WHITE;
    const c = colorToLinear(tint ? { r: mc.r * tint.r, g: mc.g * tint.g, b: mc.b * tint.b, a: mc.a * tint.a } : { ...mc });
    c.a *= alpha;
    const r = node.rect;
    const uv = (comp.m_UVRect as { x: number; y: number; width: number; height: number } | undefined) ?? { x: 0, y: 0, width: 1, height: 1 };
    const x0 = r.x;
    const y0 = r.y;
    const x1 = r.x + r.width;
    const y1 = r.y + r.height;
    const positions = [x0, y0, 0, x0, y1, 0, x1, y1, 0, x1, y0, 0];
    const u0 = uv.x;
    const v0 = uv.y;
    const u1 = uv.x + uv.width;
    const v1 = uv.y + uv.height;
    const uvs = [u0, v0, u0, v1, u1, v1, u1, v0];
    const indices = [0, 1, 2, 2, 3, 0];
    const depth = canvas.planeDistance ?? this.viewDepth(cam, new THREE.Vector3().setFromMatrixPosition(canvas.node.world));
    let drawMesh: THREE.Mesh | null;
    if (useK3) {
      const uv4: number[] = [];
      for (let i = 0; i < uvs.length; i += 2) uv4.push(uvs[i], uvs[i + 1], 0, 0);
      const colors = new Float32Array(16);
      for (let i = 0; i < 4; i++) colors.set([c.r, c.g, c.b, c.a], i * 4);
      drawMesh = await this.unityMesh(stencilChanged ? this.withStencil(mat!, st.state) : mat!, positions, uv4, 4, indices, WHITE, node.world, texture, {
        node,
        canvasUi: true,
        attributes: { COLOR0: new THREE.BufferAttribute(colors, 4) },
      });
      if (!drawMesh) return;
      drawMesh.userData.vertexColors = colors;
    } else {
      const clipKey = kind === 'ui' && this.clips?.clipOf(node.id)?.valid ? node.id : '';
      drawMesh = this.makeMesh(positions, uvs, indices, c, node.world, this.stencilMaterial(this.material(kind, texture, this.materialColor(mat), [0, 0, 0, 0], clipKey), st.state));
    }
    out.push({
      mesh: drawMesh,
      key: [...canvasSortLayerOrder(canvas, (id) => db.sortingLayerIndex(id)), 3000, -depth, node.order],
      label: 'RawImage',
      node,
      comp,
      handwritten: !useK3,
      depthOf: this.uiDepthOf(cam, canvas),
    });
    if (st.pop) {
      const pop = await this.popDrawable(out[out.length - 1], st.pop, useK3 ? { mat: mat!, color: WHITE, world: node.world, mainTexture: texture } : null);
      if (pop) out.push(pop);
    }
  }

  /** 動態字型 atlas 的貼圖；字型有烘好的內容時先把像素合進來（TMP 的動態字型：執行時加字是加進同一張 atlas） */
  private async dynamicAtlasTexture(guid: string): Promise<THREE.DataTexture | null> {
    await this.seedBakedAtlas(guid);
    return this.atlasTexture(guid);
  }

  private bakedSeeded = new Set<string>();

  /**
   * 把動態字型烘好的 atlas（m_AtlasTextures[0]；PNG 的 SDF 在 alpha 通道，RGB 是 0）複製進執行時 atlas。
   * 只複製各個烘好 glyph 的佔用區（prepare 存的 bakedRects，含 padding）——整張覆蓋會把執行時新加的字清成 0。
   * 位置在 prepare 已佔住（atlas.reserve），這裡只放像素。圖片列 0 在上面、atlas 列 0 在下面，要翻。
   */
  private async seedBakedAtlas(fontGuid: string): Promise<void> {
    if (this.bakedSeeded.has(fontGuid)) return;
    this.bakedSeeded.add(fontGuid);
    const df = this.options.text?.assets.dynamicFonts.get(fontGuid);
    if (!df?.baked || !this.db) return;
    const tex = await this.db.texture(df.baked.guid).catch(() => null);
    let img = tex?.image as { width: number; height: number } | undefined;
    if (!img?.width) return;
    // render thread：像素在 worker，CPU 要讀的這張另外用 <img> 載（跟沒開時同一條解碼）
    if (img instanceof RemoteImage) {
      const el = new Image();
      el.src = img.url;
      await el.decode();
      img = el;
    }
    const c = document.createElement('canvas');
    c.width = img.width;
    c.height = img.height;
    const g = c.getContext('2d', { willReadFrequently: true });
    if (!g) return;
    g.drawImage(img as CanvasImageSource, 0, 0);
    const id = g.getImageData(0, 0, img.width, img.height).data;
    const W = df.atlas.width;
    const H = df.atlas.height;
    for (const z of df.bakedRects) {
      for (let y = z.y; y < z.y + z.height; y++) {
        const j = H - 1 - y; // 圖片列（上往下）
        if (j < 0 || j >= img.height) continue;
        const dst = y * W;
        const src = j * img.width * 4 + 3;
        for (let x = z.x; x < z.x + z.width && x < W; x++) df.atlas.data[dst + x] = id[src + x * 4];
      }
    }
    df.atlas.markDirty();
  }

  /** 動態字型 atlas 的貼圖（列 0 在最下面，跟 GL 的 v = 0 一樣，不用翻）。
   *  Unity 是 Alpha8、shader 讀 .w；WebGL2 的 texStorage2D 不接受舊式 ALPHA，所以包成 RGBA8：alpha＝SDF 值，RGB 補白 */
  private atlasTexture(guid: string): THREE.DataTexture | null {
    const atlas = this.options.text?.assets.dynamicFonts.get(guid)?.atlas;
    if (!atlas) return null;
    let tex = this.atlasTextures.get(guid);
    if (!tex) {
      const rgba = new Uint8Array(atlas.width * atlas.height * 4);
      for (let i = 0; i < atlas.data.length; i++) {
        rgba[i * 4] = 255;
        rgba[i * 4 + 1] = 255;
        rgba[i * 4 + 2] = 255;
        rgba[i * 4 + 3] = atlas.data[i];
      }
      tex = new THREE.DataTexture(rgba, atlas.width, atlas.height, THREE.RGBAFormat, THREE.UnsignedByteType);
      tex.colorSpace = THREE.NoColorSpace;
      tex.magFilter = THREE.LinearFilter;
      tex.minFilter = THREE.LinearFilter;
      tex.generateMipmaps = false;
      tex.needsUpdate = true; // 第一次整張上傳：RGBA 剛從 atlas.data 整張建好，髒區清掉
      atlas.clearDirty();
      tex.userData.atlas = atlas; // 上傳前把 atlas.data 同步進 RGBA（uploadDirtyAtlases）
      tex.userData.rgba = rgba;
      // 局部上傳的來源（同一塊 RGBA；copyTextureToTexture 的來源，自己不上傳）
      tex.userData.patchSource = new THREE.DataTexture(rgba, atlas.width, atlas.height, THREE.RGBAFormat, THREE.UnsignedByteType);
      this.atlasTextures.set(guid, tex);
    }
    return tex;
  }

  /**
   * 動態字型 atlas 有新字就把資料同步進 RGBA 並上傳（build 結束與每格）。只同步、只上傳改過的範圍（atlas.dirtyRect）：
   * atlas 是 4096×4096，整張重抄加整張 texSubImage2D 是 64 MB，手機上每帶出新字的 tooltip 就卡好幾秒（10/15 拖牌實測）。
   * 貼圖還沒上傳過時 initTexture 先整張上傳（內容已含這次同步的範圍），之後的局部上傳只是重複寫同樣的值。
   */
  private uploadDirtyAtlases() {
    for (const [, tex] of this.atlasTextures) {
      const atlas = tex.userData.atlas as GlyphAtlas | undefined;
      if (!atlas?.dirty) continue;
      const rgba = tex.userData.rgba as Uint8Array;
      const r = atlas.dirtyRect;
      for (let y = r.y; y < r.y + r.height; y++) {
        const row = y * atlas.width;
        for (let x = r.x; x < r.x + r.width; x++) rgba[(row + x) * 4 + 3] = atlas.data[row + x];
      }
      if (r.width > 0 && r.height > 0) {
        this.renderer.initTexture(tex);
        const region = new THREE.Box2(new THREE.Vector2(r.x, r.y), new THREE.Vector2(r.x + r.width, r.y + r.height));
        this.renderer.copyTextureToTexture(tex.userData.patchSource as THREE.DataTexture, tex, region, new THREE.Vector2(r.x, r.y));
      }
      atlas.clearDirty();
    }
  }

  /**
   * TMP 文字：排版（options.text.generate）回傳每個子網格（主字型、fallback 字型、sprite 各一個）的頂點與實際用的材質，
   * 這裡接 K3 的 TMP shader。UI 版（TextMeshProUGUI）的頂點色乘上 CanvasRenderer 顏色後整體轉線性（Canvas 的
   * m_VertexColorAlwaysGammaSpace 是 0；乘法順序未查證，見檔頭）；3D 版（TextMeshPro）TMP 排版時自己轉
   * （m_ConvertToLinearSpace），這裡不動。子網格是文字物件底下的 TMP_SubMeshUI，畫在主網格之後。
   * TextContext 用 text/textContext.ts 的共用算法（跟 uGUI 排版的 external 同一份）。
   */
  private tmpLegacyCache = new Map<string, Promise<boolean>>();
  /**
   * TMP 的網格格式看遊戲用的 TMP 版本：排版（text/）照 3.2.0-pre.4 移植，uv0 是 (u, v, 0, xScale)、uv2 是 (faceU, faceV)；
   * 3.0.x（MT2 的 Unity.TextMeshPro）的 shader 讀 uv0 = (u, v)、uv2 = (PackUV(faceU, faceV), xScale)。
   * 從轉出的 shader 判斷，不寫死版本：vertex 輸入 TEXCOORD0 是 vec2 就是舊格式（MT2 的 TextMeshPro/Distance Field 實測）。
   */
  private tmpLegacyUv(shaderName: string | null): Promise<boolean> {
    if (!shaderName || !this.shaders?.has(shaderName)) return Promise.resolve(false);
    let p = this.tmpLegacyCache.get(shaderName);
    if (!p) {
      p = this.shaders
        .index(shaderName)
        .then((idx) =>
          idx.subShaders.some((ss) =>
            ss.passes.some((ps) => ps.stages.vertex?.variants.some((v) => v.vertexInputs?.some((i) => i.semantic === 'TEXCOORD' && i.index === 0 && i.type === 'vec2'))),
          ),
        )
        .catch(() => false);
      this.tmpLegacyCache.set(shaderName, p);
    }
    return p;
  }

  private async addText(node: SceneNode, comp: ComponentData, kind: 'TextMeshProUGUI' | 'TextMeshPro', out: Drawable[], skip: (reason: string) => void, entry?: ManagedEntry) {
    const graph = this.graph!;
    const db = this.db!;
    const cam = this.cam!;
    const text = this.options.text!;
    const ui = kind === 'TextMeshProUGUI';
    const canvas = node.canvas;
    if (ui && !canvas) {
      skip('TextMeshProUGUI（不在 Canvas 底下）');
      return;
    }
    // Overlay Canvas（renderMode 0）底下的文字：跟 Image 同一套（畫的時候換到攝影機前，drawWorld；排序鍵第一項 OVERLAY_LAYER）
    // ProjectSettings 的 m_ActiveColorSpace 是 1（linear）
    const ctx = this.textContext(node, comp, cam);
    let result: TextMeshResult;
    try {
      result = text.generate(comp as TmpComponentData, ctx, text.assets);
    } catch (err) {
      skip(`${kind}（排版失敗：${err instanceof Error ? err.message : err}）`);
      return;
    }
    // 網格產生後的掛勾（vertexHooks.ts）：沒登記的元件不跑；結果記下來給 textResultOf 與除錯介面用
    this.textHooks.get(comp)?.apply(result);
    this.textResults.set(comp, result);
    if (entry) entry.warnings = result.warnings;

    const alpha = this.canvasAlphaOf(node);
    let sortKey: [number, number, number, number];
    if (ui) {
      const depth = canvas!.planeDistance ?? this.viewDepth(cam, new THREE.Vector3().setFromMatrixPosition(canvas!.node.world));
      sortKey = [...canvasSortLayerOrder(canvas!, (id) => db.sortingLayerIndex(id)), 3000, -depth];
    } else {
      const r = graph.component(node, 'MeshRenderer');
      sortKey = [db.sortingLayerIndex((r?.m_SortingLayerID as number) ?? 0), (r?.m_SortingOrder as number) ?? 0, 3000, -this.viewDepth(cam, new THREE.Vector3().setFromMatrixPosition(node.world))];
    }

    // CanvasRenderer 顏色（Selectable 的 ColorTint）乘進頂點色：gamma 值相乘後整體轉線性（順序未查證，見檔頭）；3D 版沒有 CanvasRenderer
    const tint = ui ? getCanvasRendererColor(graph, node) : null;
    const tr = tint?.r ?? 1;
    const tg = tint?.g ?? 1;
    const tb = tint?.b ?? 1;
    const ta = tint?.a ?? 1;

    for (const sub of result.subMeshes) {
      if (sub.indices.length === 0) continue;
      const src = sub.material.source ? db.material(sub.material.source) : null;
      // fallback 字型／sprite 的子網格材質是執行時實例（source 是 null）：shader 用排版模組保留的 shaderRef
      // （GetFallbackMaterial 沿用來源材質的 shader）
      const shaderName = src?.shaderName ?? (sub.material.shader ? await db.shaderName(sub.material.shader.guid) : null);
      if (!shaderName || !this.shaders?.has(shaderName)) {
        skip(`${kind}（材質 ${src?.name ?? '?'} 的 shader 沒有轉出）`);
        continue;
      }
      // UNITY_UI_CLIP_RECT：原版是 EnableRectClipping（MaskableGraphic.cs:160-170）作用在 canvasRenderer、
      // 原生批次繪製時設 keyword；這裡在建 program 的關鍵詞裡注入選 variant（開／關由 refreshKeyOf 的
      // clip 欄觸發重產）。頂點在 Graphic 自己的空間，_ClipRect 由 fillCbuffers 經 clipRectFor 換算
      const keywords = ui && this.clips?.clipOf(node.id)?.valid ? [...sub.material.keywords, 'UNITY_UI_CLIP_RECT'] : sub.material.keywords;
      const texEnvs: Record<string, { m_Texture: Ref; m_Scale: { x: number; y: number }; m_Offset: { x: number; y: number } }> = {};
      for (const [name, ref] of Object.entries(sub.material.textures)) {
        const env = src?.record.m_SavedProperties.m_TexEnvs?.[name];
        texEnvs[name] = { m_Texture: ref, m_Scale: env?.m_Scale ?? { x: 1, y: 1 }, m_Offset: env?.m_Offset ?? { x: 0, y: 0 } };
      }
      const mat: MaterialInfo = {
        name: src?.name ?? `TMP 子網格材質（${shaderName}）`,
        shaderName,
        record: src
          ? {
              ...src.record,
              m_ValidKeywords: keywords,
              m_SavedProperties: { ...src.record.m_SavedProperties, m_Floats: sub.material.floats, m_Colors: sub.material.colors, m_TexEnvs: texEnvs },
            }
          : {
              m_Name: `TMP 子網格材質（${shaderName}）`,
              m_CustomRenderQueue: -1,
              m_ValidKeywords: keywords,
              m_SavedProperties: { m_Floats: sub.material.floats, m_Colors: sub.material.colors, m_TexEnvs: texEnvs },
            },
      };
      const mainRef = sub.material.textures._MainTex;
      // 主貼圖：字型子網格用字型的動態 atlas；sprite 子網格（<sprite name=…>）用 sprite 材質自己的 _MainTex（spriteSheet）。
      // sprite 子網格的 fontAsset 是從 materialReferences[0] 繼承來的（TMP_Text.addMaterialReferenceSprite），不是 null，
      // 先看 fontAsset 的話會綁到字型 atlas，骰子等 sprite 整個畫不出來（第 3 階段 T2：RNumber 的 D4／D6／D8）。
      const mainTexture = sub.spriteAsset
        ? mainRef
          ? await db.texture(mainRef.guid).catch(() => null)
          : null
        : (sub.fontAsset && (await this.dynamicAtlasTexture(sub.fontAsset.guid))) ?? (mainRef ? await db.texture(mainRef.guid).catch(() => null) : null);
      const n = sub.positions.length / 3;
      const colors = new Float32Array(n * 4);
      for (let i = 0; i < n; i++) {
        colors[i * 4] = ui ? gammaToLinear((sub.colors[i * 4] / 255) * tr) : sub.colors[i * 4] / 255;
        colors[i * 4 + 1] = ui ? gammaToLinear((sub.colors[i * 4 + 1] / 255) * tg) : sub.colors[i * 4 + 1] / 255;
        colors[i * 4 + 2] = ui ? gammaToLinear((sub.colors[i * 4 + 2] / 255) * tb) : sub.colors[i * 4 + 2] / 255;
        colors[i * 4 + 3] = (sub.colors[i * 4 + 3] / 255) * ta * alpha;
      }
      // Mask 的 stencil：TMP UGUI 的 materialForRendering 跟 uGUI Graphic 同一條 IMaterialModifier 鏈
      // （TextMeshProUGUI.cs:23-26 → TMP_MaterialManager.GetMaterialForRendering，TMP_MaterialManager.cs:304-318）；
      // 3D 的 TextMeshPro 不是 Graphic，不吃 Mask。子網格（TMP_SubMeshUI）是文字物件底下執行期建的 GameObject，
      // 它的 MaskableGraphic 算出來的 depth 跟父物件相同（Mask 都在祖先上），所以整批用同一組值；
      // unmask（pop）繪製屬於 Mask 那個 Graphic 自己的 CanvasRenderer（Mask.cs:135-136），所以只有主網格有。
      const base = stencilFromMaterial(mat.record.m_SavedProperties.m_Floats, mat.record.m_ValidKeywords);
      const st = ui ? this.stencilOf(node, 'TextMeshProUGUI', base, await this.hasStencilProperties(mat, 'ui')) : { state: base, pop: null, masking: false };
      const stencilChanged = stencilKey(st.state) !== stencilKey(base);
      const mesh = await this.unityMesh(stencilChanged ? this.withStencil(mat, st.state) : mat, Array.from(sub.positions), [], 4, Array.from(sub.indices), { r: 1, g: 1, b: 1, a: 1 }, node.world, mainTexture, {
        attributes: {
          COLOR0: new THREE.BufferAttribute(colors, 4),
          ...((await this.tmpLegacyUv(mat.shaderName)) ? legacyTmpUvs(sub.uvs0, sub.uvs2) : { TEXCOORD0: new THREE.BufferAttribute(sub.uvs0, 4), TEXCOORD1: new THREE.BufferAttribute(sub.uvs2, 2) }),
        },
        node,
        canvasUi: ui,
      });
      if (!mesh) continue;
      mesh.userData.vertexColors = colors; // 除錯介面讀「目前畫出來的那一份網格」的頂點色
      out.push({
        mesh,
        key: [...sortKey, node.order + sub.materialIndex * 1e-3],
        label: sub.materialIndex === 0 ? kind : `${kind}（子網格）`,
        node,
        comp,
        materialIndex: sub.materialIndex,
        orderBias: sub.materialIndex * 1e-3,
        // 3D 的 TextMeshPro 深度來自節點世界位置（同 sortKey 的算法）；UI 版（主網格與子網格都走這裡）：世界空間 canvas 每格重算（uiDepthOf）
        depthOf: ui ? this.uiDepthOf(cam, canvas!) : () => -this.viewDepth(cam, new THREE.Vector3().setFromMatrixPosition(node.world)),
      });
      if (st.pop && sub.materialIndex === 0) {
        const pop = await this.popDrawable(out[out.length - 1], st.pop, { mat, color: { r: 1, g: 1, b: 1, a: 1 }, world: node.world, mainTexture });
        if (pop) out.push(pop);
      }
    }
    // TextMeshProUGUI.Cull 用的是複合文字 bounds（:365-420 → GetCanvasSpaceClippingRect :4738），
    // 不是 rect 四角：產好網格後回報所有子網格頂點的 AABB（自己空間），下一格 cullAll 照它算
    if (ui && this.clips) {
      const min = new THREE.Vector3(Infinity, Infinity, Infinity);
      const max = new THREE.Vector3(-Infinity, -Infinity, -Infinity);
      for (const sub of result.subMeshes)
        for (let i = 0; i + 2 < sub.positions.length; i += 3) {
          min.x = Math.min(min.x, sub.positions[i]);
          min.y = Math.min(min.y, sub.positions[i + 1]);
          min.z = Math.min(min.z, sub.positions[i + 2]);
          max.x = Math.max(max.x, sub.positions[i]);
          max.y = Math.max(max.y, sub.positions[i + 1]);
          max.z = Math.max(max.z, sub.positions[i + 2]);
        }
      this.clips.setTextBounds(node.id, min, max);
    }
  }

  // ───────── 除錯介面（text-check 用；讀的是「目前畫出來的那一份網格」） ─────────

  // ───────── TMP 掛勾與同步排版（第 2 輪；RenderServices 的 setTextHook／layoutText／textResultOf 接這裡） ─────────

  /** 登記（或拿掉，null）某個 TMP 元件的網格掛勾。版本變了，下一格 frame() 會重產它（refreshKeyOf 的 hook 欄） */
  setTextHook(comp: ComponentData, hook: TmpVertexHook | null): void {
    if (hook) this.textHooks.set(comp, hook);
    else this.textHooks.delete(comp);
  }

  /**
   * 同步排版（DOTweenTMPAnimator 的 ForceMeshUpdate，DOTweenTMPAnimator.cs:259）：只排版，不建網格、不碰畫面。
   * withHook＝true 時套上掛勾（跟畫出來的一樣）；false 是沒掛勾的原始頂點（W5 的彎字比對用）。沒有文字功能（text=0）或還沒建置時回 null。
   */
  layoutText(comp: ComponentData, node: SceneNode, withHook: boolean): TextMeshResult | null {
    const text = this.options.text;
    if (!text || !this.cam) return null;
    const ctx = this.textContext(node, comp, this.cam);
    const result = text.generate(comp as TmpComponentData, ctx, text.assets);
    if (withHook) this.textHooks.get(comp)?.apply(result);
    return result;
  }

  /** 最近一次建網格時用的排版結果（掛勾已套上）；還沒畫過回 null */
  textResultOf(comp: ComponentData): TextMeshResult | null {
    return this.textResults.get(comp) ?? null;
  }

  /**
   * 除錯（W5 的彎字比對）：某個 TMP 元件每個可見字的四個頂點（主網格與子網格）。withHook 決定套不套掛勾。
   * 純讀取：另外排一次版，不動畫面。元件不存在回 null。
   */
  debugLayoutVertices(compId: string, withHook: boolean): { characterCount: number; chars: ({ materialIndex: number; vertices: number[][] } | null)[] } | null {
    const comp = this.graph?.file.components[compId];
    const node = comp ? this.graph!.nodes.get(comp.gameObject) ?? null : null;
    if (!comp || !node) return null;
    const result = this.layoutText(comp, node, withHook);
    if (!result) return null;
    const chars = result.textInfo.characterInfo.slice(0, result.textInfo.characterCount).map((ch) => {
      if (!ch.isVisible) return null;
      const sub = result.subMeshes.find((x) => x.materialIndex === ch.materialReferenceIndex);
      if (!sub) return null;
      const vertices: number[][] = [];
      for (let k = 0; k < 4; k++) {
        const v = ch.vertexIndex + k;
        vertices.push([sub.positions[v * 3], sub.positions[v * 3 + 1], sub.positions[v * 3 + 2]]);
      }
      return { materialIndex: ch.materialReferenceIndex, vertices };
    });
    return { characterCount: result.textInfo.characterCount, chars };
  }

  /**
   * 除錯（立繪的可見字數）：畫出來的那一份網格（主網格）裡，每個字第一個頂點的 alpha（0 到 1，線性）；不可見的字是 null。
   * 純讀取；要先 settle（重產是非同步的）。沒有這個元件回 null。
   */
  debugDrawnCharAlphas(compId: string): (number | null)[] | null {
    const comp = this.graph?.file.components[compId];
    const res = comp ? this.textResults.get(comp) : undefined;
    const m = comp ? this.managed.find((x) => x.kind !== 'Image' && x.comp === comp) : undefined;
    const d = m?.drawables.find((x) => (x.materialIndex ?? 0) === 0);
    const arr = d?.mesh.userData.vertexColors as Float32Array | undefined;
    if (!res || !arr) return null;
    return res.textInfo.characterInfo
      .slice(0, res.textInfo.characterCount)
      .map((ch) => (ch.isVisible ? arr[ch.vertexIndex * 4 + 3] : null));
  }

  private compIdOf(comp: ComponentData): string {
    for (const [id, c] of Object.entries(this.graph!.file.components)) if (c === comp) return id;
    return '';
  }

  private pathOf(node: SceneNode): string {
    const names: string[] = [];
    for (let n: SceneNode | null = node; n; n = n.parent) names.unshift(n.go.m_Name);
    return names.join('/');
  }

  /** 節點 rect 的螢幕框（繪圖緩衝像素、原點左下，跟 snapshotPixels 同一座標系）。四角經世界矩陣與 VP 投影後取範圍 */
  screenRectOf(node: SceneNode): { x0: number; y0: number; x1: number; y1: number } | null {
    if (!this.cam) return null;
    const vp = this.camera3.projectionMatrix.clone().multiply(this.viewMatrix());
    const r = node.rect;
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const [x, y] of [
      [r.x, r.y],
      [r.x + r.width, r.y],
      [r.x, r.y + r.height],
      [r.x + r.width, r.y + r.height],
    ]) {
      const v = new THREE.Vector3(x, y, 0).applyMatrix4(this.drawWorld(node)).applyMatrix4(vp);
      const px = ((v.x + 1) / 2) * this.target.width;
      const py = ((v.y + 1) / 2) * this.target.height;
      x0 = Math.min(x0, px);
      y0 = Math.min(y0, py);
      x1 = Math.max(x1, px);
      y1 = Math.max(y1, py);
    }
    return { x0, y0, x1, y1 };
  }

  /** 受管元件（TMP 與 Image）的清單：身分、啟用狀態、目前網格的子網格數與頂點數、最近的 warning、螢幕框 */
  debugManaged() {
    return this.managed.map((m) => {
      const tint = getCanvasRendererColor(this.graph!, m.node);
      const colorField = (m.kind === 'Image' ? m.comp.m_Color : m.comp.m_fontColor) as ColorRGBA | undefined;
      return {
        compId: this.compIdOf(m.comp),
        nodeId: m.node.id,
        path: this.pathOf(m.node),
        kind: m.kind,
        active: m.node.activeInHierarchy,
        enabled: m.comp.m_Enabled !== 0,
        text: (m.comp.m_text as string | undefined) ?? null,
        alpha: (colorField?.a ?? 1) * (tint?.a ?? 1) * this.canvasAlphaOf(m.node),
        // Mask 的 unmask（pop）繪製不是子網格，不列進這兩個數字
        submeshes: m.drawables.filter((d) => !d.popFor).length,
        vertices: m.drawables.filter((d) => !d.popFor).reduce((s, d) => s + ((d.mesh.userData.vertexColors as Float32Array | undefined)?.length ?? 0) / 4, 0),
        warnings: m.warnings,
        screenRect: this.screenRectOf(m.node),
      };
    });
  }

  /**
   * 除錯（loot-check 的說明可見性）：數某個節點（TMP 節點，或任何有 rect 的節點，例如 tooltip 的 layout 根節點）螢幕框內「亮度低於 threshold」的像素。
   * 讀的是 render target 上一次 render 畫出來的結果：snapshotPixels 直接 readRenderTargetPixels，不會先重畫，
   * 所以這裡不 render、不 frame，不會替過期的繪製狀態補上新結果；讀到的就是畫面上實際的樣子。
   * 螢幕框沿用 screenRectOf（緩衝像素、原點左下），換成原點左上後逐像素數；框往內縮 inset 像素，避開邊框。
   * 亮度用 Rec.709 近似 0.2126 R + 0.7152 G + 0.0722 B（0–255）。回傳的 rect 是原點左上的螢幕框。
   */
  debugDarkPixelsOf(nodeId: string, threshold: number, inset = 4): { dark: number; area: number; rect: { x: number; y: number; width: number; height: number } } | null {
    // TMP 節點走 managed（loot-check）；沒有 TMP 的節點（tooltip 的 layout 根節點，tooltip-check 量說明框）用場景裡的節點與它的 rect
    const m = this.managed.find((e) => e.node.id === nodeId && e.kind !== 'Image');
    const node = m?.node ?? this.graph?.nodes.get(nodeId);
    if (!node) return null;
    const sr = this.screenRectOf(node);
    if (!sr) return null;
    const w = this.target.width;
    const h = this.target.height;
    const rect = { x: sr.x0, y: h - sr.y1, width: sr.x1 - sr.x0, height: sr.y1 - sr.y0 };
    const px = this.snapshotPixels();
    const xa = Math.max(0, Math.ceil(rect.x + inset));
    const xb = Math.min(w, Math.floor(rect.x + rect.width - inset));
    const ya = Math.max(0, Math.ceil(rect.y + inset));
    const yb = Math.min(h, Math.floor(rect.y + rect.height - inset));
    let dark = 0;
    let area = 0;
    for (let y = ya; y < yb; y++) {
      const row = h - 1 - y; // 緩衝的列 0 在最下面
      for (let x = xa; x < xb; x++) {
        const i = (row * w + x) * 4;
        area++;
        if (0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2] < threshold) dark++;
      }
    }
    return { dark, area, rect };
  }

  /**
   * 除錯（tooltip-check 的說明框）：多個節點螢幕框的外接框裡「亮度低於 threshold」的像素數（原點左上）。
   * 說明框的根 layout 只有 VerticalLayoutGroup、沒有 ContentSizeFitter，它自己的 rect 是 0×0，框是 builder 撐出來的，
   * 所以呼叫端傳的是每個 builder 根節點。沒有螢幕框的節點略過；全部都沒有就 null。純讀取，不 render、不 frame。
   */
  debugDarkPixelsOfNodes(nodeIds: string[], threshold: number, inset = 4): { dark: number; area: number; rect: { x: number; y: number; width: number; height: number } } | null {
    const rects: { x0: number; y0: number; x1: number; y1: number }[] = [];
    for (const id of nodeIds) {
      const node = this.graph?.nodes.get(id);
      const sr = node ? this.screenRectOf(node) : null;
      if (sr) rects.push(sr);
    }
    if (rects.length === 0) return null;
    const w = this.target.width;
    const h = this.target.height;
    const x0 = Math.min(...rects.map((r) => r.x0));
    const y0 = Math.min(...rects.map((r) => r.y0));
    const x1 = Math.max(...rects.map((r) => r.x1));
    const y1 = Math.max(...rects.map((r) => r.y1));
    const rect = { x: x0, y: h - y1, width: x1 - x0, height: y1 - y0 };
    const px = this.snapshotPixels();
    const xa = Math.max(0, Math.ceil(rect.x + inset));
    const xb = Math.min(w, Math.floor(rect.x + rect.width - inset));
    const ya = Math.max(0, Math.ceil(rect.y + inset));
    const yb = Math.min(h, Math.floor(rect.y + rect.height - inset));
    let dark = 0;
    let area = 0;
    for (let y = ya; y < yb; y++) {
      const row = h - 1 - y; // 緩衝的列 0 在最下面
      for (let x = xa; x < xb; x++) {
        const i = (row * w + x) * 4;
        area++;
        if (0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2] < threshold) dark++;
      }
    }
    return { dark, area, rect };
  }

  /**
   * 除錯（tooltip-check 的提示圖）：SpriteRenderer 的 sprite 在螢幕上的外接框（sprite 的網格乘節點的世界矩陣、再投影）裡，
   * 跟框內眾數顏色（背景：各通道量化到 8 階後次數最多的那一格的平均色）相差超過 distance 的像素數。框不看有沒有繪製物件，
   * 所以沒有畫出來的提示圖，框還是量得到，像素全是背景。讀的是 render target 上一次 render 的結果（不 render、不 frame）。
   * 節點沒有 sprite、sprite 還沒載入，或節點不在場景裡，就回傳 null。
   */
  debugNonBackgroundPixelsOfSprite(nodeId: string, distance = 40, inset = 2): { count: number; area: number; rect: { x: number; y: number; width: number; height: number }; background: number[] } | null {
    const node = this.graph?.nodes.get(nodeId);
    const comp = node && this.graph ? this.graph.component(node, 'SpriteRenderer') : null;
    const ref = comp?.m_Sprite as Ref | null | undefined;
    const c = ref && 'guid' in ref ? this.cachedSprite(ref) : null;
    if (!node || !comp || !c) return null;
    const geo = this.spriteGeometry(c.sprite, c.mesh, comp);
    const vp = this.camera3.projectionMatrix.clone().multiply(this.viewMatrix());
    const w = this.target.width;
    const h = this.target.height;
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (let i = 0; i + 2 < geo.positions.length; i += 3) {
      const v = new THREE.Vector3(geo.positions[i] ?? 0, geo.positions[i + 1] ?? 0, geo.positions[i + 2] ?? 0).applyMatrix4(this.drawWorld(node)).applyMatrix4(vp);
      const sx = ((v.x + 1) / 2) * w;
      const sy = ((v.y + 1) / 2) * h;
      x0 = Math.min(x0, sx);
      y0 = Math.min(y0, sy);
      x1 = Math.max(x1, sx);
      y1 = Math.max(y1, sy);
    }
    if (!Number.isFinite(x0) || !Number.isFinite(y0)) return null;
    const rect = { x: x0, y: h - y1, width: x1 - x0, height: y1 - y0 }; // 原點左上
    const px = this.snapshotPixels();
    const xa = Math.max(0, Math.ceil(rect.x + inset));
    const xb = Math.min(w, Math.floor(rect.x + rect.width - inset));
    const ya = Math.max(0, Math.ceil(rect.y + inset));
    const yb = Math.min(h, Math.floor(rect.y + rect.height - inset));
    const bins = new Map<number, { n: number; r: number; g: number; b: number }>();
    for (let y = ya; y < yb; y++) {
      const row = h - 1 - y; // 緩衝的列 0 在最下面
      for (let x = xa; x < xb; x++) {
        const i = (row * w + x) * 4;
        const key = ((px[i] >> 5) << 6) | ((px[i + 1] >> 5) << 3) | (px[i + 2] >> 5);
        const e = bins.get(key) ?? { n: 0, r: 0, g: 0, b: 0 };
        e.n++;
        e.r += px[i];
        e.g += px[i + 1];
        e.b += px[i + 2];
        bins.set(key, e);
      }
    }
    let mode: { n: number; r: number; g: number; b: number } | null = null;
    for (const e of bins.values()) if (!mode || e.n > mode.n) mode = e;
    const bg = mode ? { r: mode.r / mode.n, g: mode.g / mode.n, b: mode.b / mode.n } : { r: 0, g: 0, b: 0 };
    let count = 0;
    let area = 0;
    for (let y = ya; y < yb; y++) {
      const row = h - 1 - y;
      for (let x = xa; x < xb; x++) {
        const i = (row * w + x) * 4;
        area++;
        if (Math.hypot(px[i] - bg.r, px[i + 1] - bg.g, px[i + 2] - bg.b) > distance) count++;
      }
    }
    return { count, area, rect, background: [Math.round(bg.r), Math.round(bg.g), Math.round(bg.b)] };
  }

  /** 目前的繪製物件清單（除錯／測試用）：label、節點、排序 key、是不是 Mask 的 unmask（pop）繪製、這格會不會畫 */
  debugDrawables() {
    return this.drawables.map((d) => {
      const uniforms = (d.mesh.material as THREE.RawShaderMaterial).uniforms as
        | { _MainTex?: { value: THREE.Texture }; _ClipRect?: { value: THREE.Vector4 } }
        | undefined;
      return {
        label: d.label,
        nodeId: d.node?.id ?? null,
        key: [...d.key],
        pop: d.popFor != null,
        visible: d.mesh.visible,
        inScene: this.scene3.children.indexOf(d.mesh) >= 0,
        // SpriteSwap／裁切檢查用：貼圖名（assets.texture 設的 guid）與目前的 _ClipRect
        texture: uniforms?._MainTex?.value?.name ?? null,
        clipRect: uniforms?._ClipRect?.value.toArray() ?? null,
      };
    });
  }

  /** 目前畫出來的頂點色（線性 float）轉回 sRGB byte 的去重清單；alpha 沒轉過線性 */
  private vertexColorBytes(d: Drawable): number[][] {
    const arr = d.mesh.userData.vertexColors as Float32Array | undefined;
    if (!arr) return [];
    const uniq = new Map<string, number[]>();
    for (let i = 0; i < arr.length; i += 4) {
      const b = [0, 1, 2].map((c) => Math.round(Math.min(1, Math.max(0, linearToGamma(arr[i + c]))) * 255));
      b.push(Math.round(Math.min(1, Math.max(0, arr[i + 3])) * 255));
      uniq.set(b.join(','), b);
    }
    return [...uniq.values()];
  }

  /** TMP 某個子網格目前畫出的頂點色（sRGB byte，去重） */
  debugTextColors(compId: string, materialIndex = 0): number[][] | null {
    const m = this.managed.find((x) => x.kind !== 'Image' && this.compIdOf(x.comp) === compId);
    if (!m) return null;
    const d = m.drawables.find((x) => (x.materialIndex ?? 0) === materialIndex);
    return d ? this.vertexColorBytes(d) : null;
  }

  /** Image 的顏色資訊：目前畫出的頂點色（線性 float 與 sRGB byte）、元件 m_Color、CanvasRenderer 顏色、CanvasGroup alpha */
  debugImageInfo(compId: string) {
    const m = this.managed.find((x) => x.kind === 'Image' && this.compIdOf(x.comp) === compId);
    if (!m || !m.drawables.length) return null;
    const arr = m.drawables[0].mesh.userData.vertexColors as Float32Array | undefined;
    return {
      vertexLinear: arr ? [arr[0], arr[1], arr[2], arr[3]] : null,
      vertexBytes: this.vertexColorBytes(m.drawables[0]),
      mColor: m.comp.m_Color as ColorRGBA,
      tint: getCanvasRendererColor(this.graph!, m.node),
      canvasAlpha: this.canvasAlphaOf(m.node),
    };
  }

  /**
   * 除錯（clip-check b–g）：帶 activeSprite／網格統計的繪製物件清單（debugDrawables 是
   * label／排序／能見度那個）。vertexCount 是 position 頂點數；clipRect 是手寫 UI/Default
   * uniform 的 _ClipRect（Graphic 自己的空間，updateClipUniform 每格填；K3 cbuffer 材質沒有
   * uniform → null）；spriteRef＝Image.activeSprite 的參照（Image.cs:161 ＝ overrideSprite ??
   * sprite，跟 buildManaged 選 sprite 同一個式）、sprite 是解析出的素材、texKey 是它的貼圖 key
   * （assets.texture 把 texture.name 設成 textureKey）。
   */
  debugSpriteDrawables(): { node: SceneNode | null; tmp: string | null; label: string; inScene: boolean; visible: boolean; spriteRef: Ref | null; sprite: SpriteInfo | null; texKey: string | null; mType: number | null; vertexCount: number; clipRect: number[] | null; keywords: string[] | null; mesh: THREE.Mesh; key: number[] }[] {
    return this.drawables.map((d) => {
      const uniforms = (d.mesh.material as THREE.RawShaderMaterial).uniforms as
        | { _MainTex?: { value: THREE.Texture }; _ClipRect?: { value: THREE.Vector4 } }
        | undefined;
      const pos = d.mesh.geometry.getAttribute('position');
      const ref = d.comp ? ((d.comp.m_OverrideSprite as Ref) ?? (d.comp.m_Sprite as Ref)) : null;
      const sprite = ref && 'guid' in ref ? this.db?.sprite(ref) ?? null : null;
      return {
        node: d.node ?? null,
        tmp: d.node ? d.node.go.m_Name : null, // 繪製節點名（TMP_SubMeshUI 沒有 m_text）：clip-check d 找 TMP 繪製物件用
        visible: d.mesh.visible, // 隔離生效與 cull 的直接證據
        spriteRef: ref ?? null,
        sprite,
        mType: (d.comp?.m_Type as number | undefined) ?? null, // Image.m_Type（0 Simple、1 Sliced、2 Tiled、3 Filled）：f 確認 Tiled
        texKey: sprite?.textureKey ?? uniforms?._MainTex?.value?.name ?? null,
        vertexCount: pos ? pos.count : 0,
          clipRect: uniforms?._ClipRect
            ? uniforms._ClipRect.value.toArray()
            : (() => {
                // K3 材質：_ClipRect 在 cbuffer（fillCbuffers :1030 填 program.blocks），
                // 從 fields 找偏移讀 data（clip-check d3 驗收用）
                const blocks = (d.mesh.userData.program as { blocks?: { fields: { name: string; offset: number }[]; data: Float32Array }[] } | undefined)?.blocks;
                if (!blocks) return null;
                for (const b of blocks) {
                  const f = b.fields.find((x) => x.name === '_ClipRect');
                  if (f) return [b.data[f.offset / 4], b.data[f.offset / 4 + 1], b.data[f.offset / 4 + 2], b.data[f.offset / 4 + 3]];
                }
                return null;
              })(),
        keywords: (d.mesh.userData.program as { keywords?: string[] } | null)?.keywords ?? null,
        mesh: d.mesh,
        label: d.label, // 繪製物件的標籤（TextMeshProUGUI、TextMeshProUGUI（子網格）、SpriteRenderer…）
        inScene: this.scene3.children.indexOf(d.mesh) >= 0, // 這個網格是否真的掛在場景上（重產換網格時舊的會被移掉）
        key: [...d.key] as unknown as number[],
      };
    });
  }

  /**
   * 除錯（clip-check b）：隔離 root 子樹——把「不在 root 子樹裡」的繪製物件藏掉。只額外隱藏：
   * inactive／disabled／culled 的照 updateDrawable 關著，不重新啟用；隔離存 isolated 旗標，
   * 之後每格 frame() 保持（normal 能見度跟它取交集）。回傳藏掉的物件數。
   */
  debugIsolate(root: SceneNode): number {
    let hidden = 0;
    for (const d of this.drawables) {
      if (!d.node) continue;
      let inSubtree = false;
      for (let c: SceneNode | null = d.node; c; c = c.parent) if (c === root) { inSubtree = true; break; }
      if (inSubtree) continue;
      if (d.mesh.visible) hidden++;
      d.mesh.visible = false;
      d.isolated = true;
    }
    return hidden;
  }

  /** debugIsolate 的反操作：解除隔離旗標並照 normal 規則恢復能見度（正常檢視頁沒呼叫過＝無作用） */
  debugClearIsolation(): void {
    for (const d of this.drawables) {
      if (!d.isolated) continue;
      d.isolated = false;
      this.updateDrawable(d);
    }
  }

  /** 目前 render target 的像素（RGBA8，列 0 在最下面，跟 GL 一樣；y 往上） */
  snapshotPixels(): Uint8Array {
    if (this.options.gfx) throw new Error('render thread 開著時讀不到像素（網址加 gfx=0 改回主執行緒畫）');
    const w = this.target.width;
    const h = this.target.height;
    const buf = new Uint8Array(w * h * 4);
    this.renderer.readRenderTargetPixels(this.target, 0, 0, w, h, buf);
    return buf;
  }

  /** 攝影機遠平面／近平面的影片（boot 接 csport/unityVideo.ts 的 videoLayers） */
  videoLayers: (() => VideoLayer[]) | null = null;
  private video: { scene: THREE.Scene; camera: THREE.Camera; material: THREE.RawShaderMaterial; textures: WeakMap<HTMLVideoElement, THREE.VideoTexture> } | null = null;

  /**
   * cam 是 built-in 管線這一趟的攝影機（只畫 targetCamera 是它的；w、h 是它的 viewport），null 是沒有攝影機的管線（全部、整個畫面）。
   * 畫進目前的 render target 與 viewport。
   */
  private drawVideos(near: boolean, cam: ComponentData | null = null, w = this.target.width, h = this.target.height): void {
    const layers = this.videoLayers ? videosForPass(this.videoLayers(), near, cam).filter((v) => v.el.readyState >= 2 && v.el.videoWidth > 0) : [];
    if (!layers.length) return;
    if (!this.video) {
      const material = new THREE.RawShaderMaterial({
        glslVersion: THREE.GLSL3,
        vertexShader: VIDEO_VERTEX,
        fragmentShader: VIDEO_FRAGMENT,
        uniforms: { tVideo: { value: null }, uAlpha: { value: 1 }, uScale: { value: new THREE.Vector2(1, 1) } },
        depthTest: false,
        depthWrite: false,
        transparent: true,
        blending: THREE.CustomBlending,
        blendSrc: THREE.SrcAlphaFactor,
        blendDst: THREE.OneMinusSrcAlphaFactor,
      });
      const quad = new THREE.BufferGeometry();
      quad.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], 3));
      quad.setIndex([0, 1, 2, 0, 2, 3]);
      const mesh = new THREE.Mesh(quad, material);
      mesh.frustumCulled = false;
      const scene = new THREE.Scene();
      scene.add(mesh);
      this.video = { scene, camera: new THREE.Camera(), material, textures: new WeakMap() };
    }
    const { material, textures } = this.video;
    for (const v of layers) {
      let tex = textures.get(v.el);
      if (!tex) {
        tex = new THREE.VideoTexture(v.el);
        tex.colorSpace = THREE.NoColorSpace; // shader 自己轉線性
        tex.minFilter = THREE.LinearFilter;
        tex.magFilter = THREE.LinearFilter;
        tex.generateMipmaps = false;
        textures.set(v.el, tex);
      }
      material.uniforms.tVideo.value = tex;
      material.uniforms.uAlpha.value = v.alpha;
      (material.uniforms.uScale.value as THREE.Vector2).set(...videoQuadScale(v.aspectRatio, v.el.videoWidth, v.el.videoHeight, w, h));
      this.renderer.render(this.video.scene, this.video.camera);
    }
  }

  // ───────── built-in 管線：多台攝影機（cameraStack.ts） ─────────

  /** Canvas 的根（巢狀 Canvas 的 render mode 與攝影機照根 Canvas） */
  private rootCanvasOf(cv: CanvasInfo): CanvasInfo {
    let root = cv;
    while (root.node.parent?.canvas) root = root.node.parent.canvas;
    return root;
  }

  /**
   * 這個繪製物件在這一趟畫不畫：cam 是 null 表示 Overlay 那一趟。
   * uGUI（Image、TextMeshProUGUI、Mask 的 pop）照根 Canvas 的 render mode：Overlay 只在 Overlay 那一趟；Screen Space - Camera 只由指定的攝影機畫；
   * World Space 跟其他物件一樣看圖層。圖層照最近的 Canvas 節點（Canvas 以自己為單位送出繪製；巢狀 Canvas 圖層不同時的規則未查證）。
   * 其他（SpriteRenderer、MeshRenderer、3D 文字、LineRenderer…）看節點的圖層在不在 cullingMask。
   */
  private drawnBy(d: Drawable, cam: CameraInfo | null, mask: number, canvasCams: Map<CanvasInfo, CameraInfo | null>): boolean {
    const node = d.popFor ?? d.node;
    if (!node) return cam !== null;
    if (isCanvasDrawable(d) && node.canvas) {
      const root = this.rootCanvasOf(node.canvas);
      if (root.renderMode === 0) return cam === null;
      if (cam === null) return false;
      if (root.renderMode === 1) {
        let c = canvasCams.get(root);
        if (c === undefined) {
          c = this.graph!.cameraByComponentId((root.data.m_Camera as { fileID?: string } | null)?.fileID) ?? null;
          canvasCams.set(root, c);
        }
        if (c !== cam) return false;
      }
      return inCullingMask(mask, (node.canvas.node.go.m_Layer as number | undefined) ?? 0);
    }
    if (cam === null) return false;
    return inCullingMask(mask, (node.go.m_Layer as number | undefined) ?? 0);
  }

  /**
   * built-in 的一趟繪製的順序：不透明（render queue ≤ 2500）先畫，照 queue、由近到遠；之後透明的照 2D 透明物件規則
   * （sorting layer → order in layer → queue → 由遠到近 → 場景樹順序；Unity 文件 2D Sorting）。
   * Skybox 畫在兩者之間（render queue 的 Geometry 與 Transparent 之間；還沒做，見 renderCamera）
   */
  private static builtinOrder(a: Drawable, b: Drawable): number {
    if (a.sky || b.sky) {
      if (a.sky && b.sky) return a.key[4] - b.key[4];
      const other = a.sky ? b : a;
      const skyFirst = other.key[2] > 2500; // 天空盒在不透明之後、透明之前
      return a.sky === skyFirst ? -1 : 1;
    }
    const oa = a.key[2] <= 2500;
    const ob = b.key[2] <= 2500;
    if (oa !== ob) return oa ? -1 : 1;
    if (oa) {
      if (a.key[2] !== b.key[2]) return a.key[2] - b.key[2];
      if (a.key[3] !== b.key[3]) return b.key[3] - a.key[3]; // key[3] 是 −距離：大的近，先畫
      return a.key[4] - b.key[4];
    }
    for (let i = 0; i < a.key.length; i++) if (a.key[i] !== b.key[i]) return a.key[i] - b.key[i];
    return 0;
  }

  /** 這一趟的投影與 view 套到 camera3（手寫 shader 用 three.js 的矩陣；K3 shader 的 cbuffer 由 fillCbuffers 照 this.cam 與 camera3 填） */
  private applyPassCamera(P: THREE.Matrix4, camWorld: THREE.Matrix4): void {
    const c = this.camera3;
    c.projectionMatrix.copy(P);
    c.projectionMatrixInverse.copy(P).invert();
    c.matrixAutoUpdate = false;
    c.matrix.copy(FLIP_Z).multiply(camWorld).multiply(FLIP_Z);
    c.matrixWorldNeedsUpdate = true;
  }

  /** this.programs 的成員變了（加入、移除）就加一（looseProgramEntries 的快取照它失效） */
  private programsVersion = 0;
  private readonly passEntries: SceneRenderer['programs'] = [];
  private looseCache: { programs: SceneRenderer['programs']; len: number; pv: number; sv: number; sky: unknown; entries: SceneRenderer['programs'] } | null = null;

  /** 程式條目裡網格不是任何繪製物件（drawables、天空盒）的：drawPass 只填清單裡的，這些另外照舊交給 fillCbuffers 判斷 */
  private looseProgramEntries(): SceneRenderer['programs'] {
    const c = this.looseCache;
    const sky = this.sky?.drawables ?? null;
    if (c && c.programs === this.programs && c.len === this.programs.length && c.pv === this.programsVersion && c.sv === this.scanVersion && c.sky === sky) return c.entries;
    const owned = new Set<THREE.Object3D>();
    for (const d of this.drawables) owned.add(d.mesh);
    for (const d of sky ?? []) owned.add(d.mesh);
    const entries = this.programs.filter((e) => !e.mesh || !owned.has(e.mesh));
    this.looseCache = { programs: this.programs, len: this.programs.length, pv: this.programsVersion, sv: this.scanVersion, sky, entries };
    return entries;
  }

  /** drawPass 畫的時候暫時換上的 scene3.children（只有這一趟要畫的網格） */
  private readonly passChildren: THREE.Object3D[] = [];

  /** 一趟繪製：挑出這一趟要畫的、排序、填 cbuffer、畫 */
  private drawPass(cam: CameraInfo | null, vis: readonly Drawable[], canvasCams: Map<CanvasInfo, CameraInfo | null>, sky: Drawable[] = []): number {
    const mask = cam ? cullingMask(cam) : 0;
    const list: Drawable[] = [...sky];
    // 這一趟的深度（照這台攝影機）只給下面的排序用，排完還原：留著的話下一格 refreshOrderKeys 照主攝影機算回來，
    // 每格都當成順序變了、整個 drawables 重排（MT2 戰鬥一格畫三趟，10/18）
    const depthOwners: Drawable[] = [];
    const depthSaved: number[] = [];
    for (let i = 0; i < vis.length; i++) {
      const d = vis[i];
      const ok = this.drawnBy(d, cam, mask, canvasCams);
      d.mesh.visible = ok;
      if (!ok) continue;
      if (cam && d.depthOf) {
        depthOwners.push(d);
        depthSaved.push(d.key[3]);
        d.key[3] = d.depthOf();
      }
      if (d.beforePass) {
        d.beforePass(cam);
        if (!d.mesh.visible) continue;
      }
      list.push(d);
    }
    const restoreDepth = () => {
      for (let i = 0; i < depthOwners.length; i++) depthOwners[i].key[3] = depthSaved[i];
    };
    if (!list.length) {
      restoreDepth();
      return 0;
    }
    list.sort(SceneRenderer.builtinOrder);
    restoreDepth();
    for (let i = 0; i < list.length; i++) list[i].mesh.renderOrder = i;
    for (const d of sky) d.mesh.visible = true;
    // 只填這一趟會畫的：清單裡的繪製物件（含天空盒）加上不屬於任何繪製物件的程式（fillCbuffers 照舊跳過看不見的）。
    // 以前每一趟都走全部的程式（MT2 戰鬥 6000 多個，一格三趟）。第一次照舊全填（沒填到的欄位報告要涵蓋全部程式）
    if (this.cbufferReported) {
      const entries = this.passEntries;
      entries.length = 0;
      for (const d of list) {
        const e = d.mesh.userData.programEntry as SceneRenderer['programs'][number] | undefined;
        if (e) entries.push(e);
      }
      for (const e of this.looseProgramEntries()) entries.push(e);
      this.fillCbuffers(entries);
      entries.length = 0;
    } else this.fillCbuffers();
    // three.js 每次 render 都走過 scene3 的全部子物件（updateMatrixWorld、projectObject），MT2 戰鬥 6400 個只畫一兩百個、
    // 一格三趟。這一趟暫時只掛要畫的：不畫的本來就 visible＝false、three.js 不會畫，網格都沒有子物件；
    // 世界矩陣（matrixWorldNeedsUpdate）留到它被畫的那一趟才更新，除了 three.js 畫的時候沒有人讀（10/18）
    const all = this.scene3.children;
    const pass = this.passChildren;
    pass.length = list.length;
    for (let i = 0; i < list.length; i++) pass[i] = list[i].mesh;
    this.scene3.children = pass;
    try {
      this.renderer.render(this.scene3, this.camera3);
    } finally {
      this.scene3.children = all;
      pass.length = 0;
    }
    for (const d of sky) d.mesh.visible = false;
    return list.length - sky.length;
  }

  // ───────── built-in 的天空盒（RenderSettings.skybox） ─────────

  /** 目前的天空盒：材質、六面的繪製物件、它們共用的世界矩陣（每台攝影機畫之前改成攝影機的位置）。null＝沒有或建不出來 */
  private sky: { mat: string; drawables: Drawable[]; world: THREE.Matrix4 } | null = null;
  private skyBuilding: string | null = null;

  /**
   * 天空盒的繪製物件。Skybox/6 Sided 一個 pass 畫一面（Front +Z、Back −Z、Left +X、Right −X、Up +Y、Down −Y，照 shader 屬性的標註）；
   * Unity 引擎內部的天空盒網格看不到原始碼，這裡每面一片四邊形，UV 照「從裡面看出去，貼圖正立」排（未查證）。
   * 位置跟著攝影機、大小是遠平面的一半（八個角都在遠平面內）；材質的 ZTest LEqual／ZWrite Off 讓前面不透明物件擋住它。
   * 其他天空盒 shader（Procedural、Cubemap、Panoramic）還沒做，記在 report.skipped。非同步建，建好之前清成背景色。
   */
  private skyboxFor(): Drawable[] | null {
    const rs = this.lightInput().renderSettings;
    const ref = rs?.m_SkyboxMaterial as Ref | null | undefined;
    const mat = ref ? this.db?.material(ref) : null;
    if (!mat) return null;
    const key = `${(ref as { guid?: string }).guid}`;
    if (this.sky?.mat === key) return this.sky.drawables;
    if (this.skyBuilding === key) return null;
    this.skyBuilding = key;
    void this.buildSkybox(key, mat).finally(() => {
      if (this.skyBuilding === key) this.skyBuilding = null;
    });
    return null;
  }

  private async buildSkybox(key: string, mat: MaterialInfo): Promise<void> {
    if (mat.shaderName !== 'Skybox/6 Sided' || !this.shaders?.has(mat.shaderName)) {
      bump(this.report.skipped, `天空盒（${mat.shaderName ?? mat.name} 還沒做）`);
      return;
    }
    const world = new THREE.Matrix4();
    // [面上的四個角（x, y, z）、UV]
    const faces: [number[][], number[][]][] = [
      [[[-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1]], [[0, 0], [1, 0], [1, 1], [0, 1]]], // Front +Z
      [[[1, -1, -1], [-1, -1, -1], [-1, 1, -1], [1, 1, -1]], [[0, 0], [1, 0], [1, 1], [0, 1]]], // Back −Z
      [[[1, -1, 1], [1, -1, -1], [1, 1, -1], [1, 1, 1]], [[0, 0], [1, 0], [1, 1], [0, 1]]], // Left +X
      [[[-1, -1, -1], [-1, -1, 1], [-1, 1, 1], [-1, 1, -1]], [[0, 0], [1, 0], [1, 1], [0, 1]]], // Right −X
      [[[-1, 1, 1], [1, 1, 1], [1, 1, -1], [-1, 1, -1]], [[0, 0], [1, 0], [1, 1], [0, 1]]], // Up +Y
      [[[-1, -1, -1], [1, -1, -1], [1, -1, 1], [-1, -1, 1]], [[0, 0], [1, 0], [1, 1], [0, 1]]], // Down −Y
    ];
    const programsBefore = new Set(this.programs);
    const drawables: Drawable[] = [];
    for (let i = 0; i < faces.length; i++) {
      const [corners, uvs] = faces[i];
      const mesh = await this.unityMesh(mat, corners.flat(), uvs.flat(), 2, [0, 1, 2, 0, 2, 3], WHITE, world, null, { passIndex: i, globals: {} });
      if (!mesh) return;
      mesh.visible = false;
      this.scene3.add(mesh);
      drawables.push({ mesh, key: [0, 0, 1000, 0, i], label: 'Skybox', sky: true });
    }
    await this.bindTextures(this.programs.filter((e) => !programsBefore.has(e)));
    if (this.sky) for (const d of this.sky.drawables) this.disposeDrawable(d);
    this.sky = { mat: key, drawables, world };
  }

  /** 天空盒跟著這台攝影機：位置是攝影機的位置、大小是遠平面的一半 */
  private placeSkybox(cam: CameraInfo): void {
    if (!this.sky) return;
    const p = new THREE.Vector3().setFromMatrixPosition(cam.node.world);
    const s = cam.far * 0.5;
    this.sky.world.makeScale(s, s, s).setPosition(p);
  }

  /** built-in 每台攝影機畫完之後的統計（除錯介面看） */
  builtinStats: { camera: string; drawn: number; clear: number; viewport: number[] }[] = [];
  /** Overlay 那一趟用的虛擬攝影機：在原點、看 +z（cameraStack.overlayView）；cbuffer 的 _WorldSpaceCameraPos、_ProjectionParams 從這裡讀 */
  private overlayCam(h: number): CameraInfo {
    return {
      node: { world: new THREE.Matrix4() } as unknown as SceneNode,
      data: {} as ComponentData,
      orthographic: true,
      orthographicSize: h / 2,
      fieldOfView: 60,
      near: -1e6,
      far: 1e6,
    };
  }

  private renderBuiltin(): void {
    const r = this.renderer;
    const graph = this.graph;
    const W = this.target.width;
    const H = this.target.height;
    // 這一格要畫的（frame() 定的 visible），照 drawables 的順序。每一趟只看這些：其他的本來就 visible＝false、每一趟也是 false
    //（以前每一趟都走全部 6400 個，10/18）。畫完還原成 true
    const vis = this.drawables.filter((d) => d.mesh.visible);
    const savedCam = this.cam;
    const canvasCams = new Map<CanvasInfo, CameraInfo | null>();
    const cams = graph ? screenCameras(graph.cameras, (c) => !!this.cameraHasTarget?.(c)) : [];
    // RenderTexture.Release 過的：GPU 記憶體放掉（再用到時 three.js 會重配）
    for (const [rt, t] of this.rtTargets) {
      if (!(rt as { released?: boolean }).released) this.rtFreed.delete(t);
      else if (!this.rtFreed.has(t)) {
        t.dispose();
        this.rtFreed.add(t);
      }
    }
    const start = firstVisibleCamera(cams, W, H);
    this.builtinStats = [];
    const t = this.target;
    t.scissorTest = false;
    t.viewport.set(0, 0, W, H);
    r.setRenderTarget(t);
    // 第一台之前的畫面內容 Unity 沒定義（上一格留下的）；這裡清成黑色
    r.setClearColor(new THREE.Color(0, 0, 0), 1);
    r.clear(true, true, true);
    // 有 targetTexture 的攝影機先畫進各自的 render target（MT2：CardTrailCamera 把 HUD 的卡片拖尾畫進 Hud 建的 RenderTexture，RawImage 再顯示）
    for (const { cam, target } of graph && this.cameraTarget ? targetCameras(graph.cameras, this.cameraTarget) : []) {
      const rt3 = this.renderTextureTarget(target);
      const vp = viewportPixels(cam, rt3.width, rt3.height);
      if (vp.width <= 0 || vp.height <= 0) continue;
      rt3.viewport.set(vp.x, vp.y, vp.width, vp.height);
      rt3.scissor.set(vp.x, vp.y, vp.width, vp.height);
      rt3.scissorTest = true;
      r.setRenderTarget(rt3);
      const flags = clearFlagsOf(cam);
      const sky = flags === CLEAR_SKYBOX ? this.skyboxFor() : null;
      if (sky) {
        this.placeSkybox(cam);
        r.clear(true, true, true);
      } else if (flags === CLEAR_SKYBOX || flags === CLEAR_SOLID_COLOR) {
        // 貼圖的 alpha 照背景色寫（螢幕那一趟固定 1；這裡的 alpha 是 RawImage 疊上去時看得到的）
        const bg = colorToLinear((cam.data.m_BackGroundColor as ColorRGBA | undefined) ?? { r: 0, g: 0, b: 0, a: 0 });
        r.setClearColor(new THREE.Color().setRGB(bg.r, bg.g, bg.b, THREE.LinearSRGBColorSpace), bg.a);
        r.clear(true, true, true);
      } else if (flags === CLEAR_DEPTH) r.clear(false, true, true);
      this.cam = cam;
      this.depthCam = cam;
      this.passSize = { w: vp.width, h: vp.height };
      this.applyPassCamera(projectionOf(cam, vp.width / vp.height), cam.node.world);
      this.drawVideos(false, cam.data, vp.width, vp.height);
      const drawn = this.drawPass(cam, vis, canvasCams, sky ?? []);
      this.drawVideos(true, cam.data, vp.width, vp.height);
      this.builtinStats.push({ camera: `${cam.node.go.m_Name} → RenderTexture`, drawn, clear: flags, viewport: [vp.x, vp.y, vp.width, vp.height] });
      rt3.scissorTest = false;
    }
    r.setRenderTarget(t);
    for (let i = start; i < cams.length; i++) {
      const cam = cams[i];
      const vp = viewportPixels(cam, W, H);
      if (vp.width <= 0 || vp.height <= 0) continue;
      t.viewport.set(vp.x, vp.y, vp.width, vp.height);
      t.scissor.set(vp.x, vp.y, vp.width, vp.height);
      t.scissorTest = true;
      r.setRenderTarget(t);
      const flags = clearFlagsOf(cam);
      // Post Processing v2：攝影機畫進 HDR 的中繼 target（原版 HDR 攝影機＋PostProcessLayer 也是先畫進 ARGBHalf 的暫存，OnRenderImage 再畫回去）
      const pp = this.postProcess?.(cam) ?? null;
      const stack = pp ? this.ppStack(cam, pp) : null;
      if (pp && stack && stack.ensure(pp)) {
        const src = stack.sourceTarget(vp.width, vp.height);
        src.viewport.set(0, 0, vp.width, vp.height);
        src.scissorTest = false;
        // 不清顏色的攝影機接著前面攝影機的內容畫：先把目前畫面複製進來（MT2 的後製攝影機是 Skybox，不會走到）
        if (flags !== CLEAR_SKYBOX && flags !== CLEAR_SOLID_COLOR) stack.copyInto(t.texture, src, [vp.x / W, vp.y / H, vp.width / W, vp.height / H]);
        r.setRenderTarget(src);
        const sky = flags === CLEAR_SKYBOX ? this.skyboxFor() : null;
        if (sky) {
          this.placeSkybox(cam);
          r.clear(true, true, true);
        } else if (flags === CLEAR_SKYBOX || flags === CLEAR_SOLID_COLOR) {
          const bg = colorToLinear((cam.data.m_BackGroundColor as ColorRGBA | undefined) ?? { r: 0, g: 0, b: 0, a: 1 });
          r.setClearColor(new THREE.Color().setRGB(bg.r, bg.g, bg.b, THREE.LinearSRGBColorSpace), 1);
          r.clear(true, true, true);
        } else r.clear(false, true, true);
        this.cam = cam;
        this.depthCam = cam;
        this.passSize = { w: vp.width, h: vp.height };
        this.applyPassCamera(projectionOf(cam, vp.width / vp.height), cam.node.world);
        this.drawVideos(false, cam.data, vp.width, vp.height);
        const drawn = this.drawPass(cam, vis, canvasCams, sky ?? []);
        this.drawVideos(true, cam.data, vp.width, vp.height);
        t.viewport.set(vp.x, vp.y, vp.width, vp.height);
        t.scissor.set(vp.x, vp.y, vp.width, vp.height);
        t.scissorTest = true;
        stack.render(pp, t);
        r.setRenderTarget(t);
        this.builtinStats.push({ camera: `${cam.node.go.m_Name}（後製 ${stack.report.lastPasses} 趟）`, drawn, clear: flags, viewport: [vp.x, vp.y, vp.width, vp.height] });
        continue;
      }
      // Skybox：有 RenderSettings.skybox 時清深度、天空盒在不透明物件之後畫（drawPass）；沒有天空盒時跟 Solid Color 一樣清成背景色
      const sky = flags === CLEAR_SKYBOX ? this.skyboxFor() : null;
      if (sky) {
        this.placeSkybox(cam);
        r.clear(true, true, true);
      } else if (flags === CLEAR_SKYBOX || flags === CLEAR_SOLID_COLOR) {
        const bg = colorToLinear((cam.data.m_BackGroundColor as ColorRGBA | undefined) ?? { r: 0, g: 0, b: 0, a: 1 });
        r.setClearColor(new THREE.Color().setRGB(bg.r, bg.g, bg.b, THREE.LinearSRGBColorSpace), 1);
        r.clear(true, true, true);
      } else if (flags === CLEAR_DEPTH) r.clear(false, true, true);
      this.cam = cam;
      this.depthCam = cam;
      this.passSize = { w: vp.width, h: vp.height };
      this.applyPassCamera(projectionOf(cam, vp.width / vp.height), cam.node.world);
      this.drawVideos(false, cam.data, vp.width, vp.height);
      const drawn = this.drawPass(cam, vis, canvasCams, sky ?? []);
      this.drawVideos(true, cam.data, vp.width, vp.height);
      this.builtinStats.push({ camera: cam.node.go.m_Name, drawn, clear: flags, viewport: [vp.x, vp.y, vp.width, vp.height] });
    }
    // Overlay Canvas：全部攝影機之後、整個畫面。先清深度與 stencil（UI 的 Mask 從 0 開始算；Unity 實際清不清未查證）
    t.scissorTest = false;
    t.viewport.set(0, 0, W, H);
    r.setRenderTarget(t);
    r.clear(false, true, true);
    this.cam = this.overlayCam(H);
    this.depthCam = null;
    this.passSize = { w: W, h: H };
    this.applyPassCamera(overlayProjection(W, H), new THREE.Matrix4());
    const drawn = this.drawPass(null, vis, canvasCams);
    this.builtinStats.push({ camera: '(Overlay)', drawn, clear: 0, viewport: [0, 0, W, H] });
    for (let i = 0; i < vis.length; i++) vis[i].mesh.visible = true;
    this.cam = savedCam;
    this.depthCam = null;
    this.passSize = null;
    r.setRenderTarget(null);
    r.clear(true, false, false);
    r.render(this.blit.scene, this.blit.camera);
  }

  render() {
    this.renderFrame();
    // render thread：這一格的指令送出去（worker 照順序畫，最後的 blit 讓這一格上螢幕）
    this.options.gfx?.endFrame();
  }

  private renderFrame() {
    this.grabbed.clear();
    if (this.builtin) {
      this.renderBuiltin();
      return;
    }
    const r = this.renderer;
    for (const t of this.lightTargets) {
      r.setRenderTarget(t.target);
      r.setClearColor(t.clear, 1);
      r.clear(true, false, false);
      r.render(t.scene, this.camera3);
    }
    r.setRenderTarget(this.target);
    r.setClearColor(this.clearColor, 1);
    // 每格把 stencil 一起清掉（Mask 的遮罩是「這一格」的狀態；清除值是 0，three.js 在 WebGLState 初始化時
    // 就 gl.clearStencil(0)）
    // 深度也清：3D 網格（render/mesh3d.ts）開深度測試；其他材質都不讀不寫深度
    r.clear(true, true, true);
    this.drawVideos(false);
    r.render(this.scene3, this.camera3);
    this.drawVideos(true);
    r.setRenderTarget(null);
    r.clear(true, false, false);
    r.render(this.blit.scene, this.blit.camera);
  }
}

/**
 * VideoPlayer 畫在攝影機的遠平面／近平面（renderMode CameraFarPlane／CameraNearPlane）。相容層（csport/unityVideo.ts 的 videoLayers）給，
 * boot 接上 SceneRenderer.videoLayers。
 */
export interface VideoLayer {
  el: HTMLVideoElement;
  /**
   * CameraNearPlane：畫在目標攝影機的場景前面；CameraFarPlane：場景後面（Unity 手冊 VideoRenderMode：behind／in front of a camera's scene）。
   * built-in 管線在 targetCamera 那一趟裡畫：遠平面在它清完之後、畫物件之前，近平面在它畫完之後（後面的攝影機與 Overlay Canvas 照樣疊上去）
   */
  nearPlane: boolean;
  /** targetCamera 的 Camera 元件 */
  camera: ComponentData;
  /** targetCameraAlpha */
  alpha: number;
  /** VideoAspectRatio：0 NoScaling、1 FitVertically、2 FitHorizontally、3 FitInside、4 FitOutside、5 Stretch */
  aspectRatio: number;
}

const VIDEO_VERTEX = /* glsl */ `
in vec3 position;
uniform vec2 uScale;
out vec2 vUv;
void main() {
  vUv = position.xy * 0.5 + 0.5;
  gl_Position = vec4(position.xy * uScale, 0.0, 1.0);
}`;
// 影片是 sRGB：取樣後轉線性（render target 是線性流程，blit 時再轉回去）
const VIDEO_FRAGMENT = /* glsl */ `
precision highp float;
uniform sampler2D tVideo;
uniform float uAlpha;
in vec2 vUv;
out vec4 fragColor;
void main() {
  vec3 c = texture(tVideo, vUv).rgb;
  c = mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c));
  fragColor = vec4(c, uAlpha);
}`;

/**
 * 這一趟要畫的影片：built-in 管線只畫 targetCamera 是這台的（cam）；cam 是 null（沒有攝影機的管線）全部都畫。
 * 以前 built-in 管線在全部攝影機之前畫遠平面，目標攝影機自己清背景（Solid Color）就蓋掉了：開場影片 intro_fmv 整段黑畫面。
 */
export function videosForPass(layers: VideoLayer[], near: boolean, cam: ComponentData | null): VideoLayer[] {
  return layers.filter((v) => v.nearPlane === near && (cam === null || v.camera === cam));
}

/** 影片在 NDC 的縮放（VideoAspectRatio 的規則；NoScaling 是影片像素大小） */
export function videoQuadScale(mode: number, vw: number, vh: number, sw: number, sh: number): [number, number] {
  const va = vw / vh;
  const sa = sw / sh;
  const fitV: [number, number] = [va / sa, 1];
  const fitH: [number, number] = [1, sa / va];
  switch (mode) {
    case 0:
      return [vw / sw, vh / sh];
    case 1:
      return fitV;
    case 2:
      return fitH;
    case 3:
      return va > sa ? fitH : fitV;
    case 4:
      return va > sa ? fitV : fitH;
    default:
      return [1, 1];
  }
}

interface Renderer2DDataLike {
  m_LightBlendStyles?: BlendStyle[];
  m_LightRenderTextureScale: number;
  m_HDREmulationScale: number;
  m_PointLightShader: Ref;
  m_FallOffLookup: Ref;
}

interface LitInfo {
  layerStyles: Map<number, Set<number>>;
  globals: Record<string, ArrayLike<number>>;
  styles: BlendStyle[];
  targets: LightTarget[];
}

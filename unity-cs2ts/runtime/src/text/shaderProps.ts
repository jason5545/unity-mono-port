// 文字會用到的 shader 的屬性清單（Material.HasProperty 的依據：Unity 查的是 shader 宣告的屬性，
// 不是 .mat 序列化進來的欄位——0b 的 .mat 會帶不屬於 shader 的陳舊欄位，例如 m_Colors._IsoPerimeter）。
// 內容是 0b 匯出的 assets/shaders.json 的 m_PropInfo.m_Name（TMP 套件＋遊戲自訂 shader 的屬性名稱，不含素材本體）。
// 遊戲資料換版（npm run import）後若 shader 變動要同步重建。

// TextMeshPro/Distance Field 的屬性
const TMP_SDF_PROPS = [
  '_Ambient', '_Bevel', '_BevelClamp', '_BevelOffset', '_BevelRoundness', '_BevelWidth', '_BumpFace', '_BumpMap', '_BumpOutline',
  '_ClipRect', '_ColorMask', '_Cube', '_CullMode', '_Diffuse', '_EnvMatrixRotation', '_FaceColor', '_FaceDilate', '_FaceTex',
  '_FaceUVSpeedX', '_FaceUVSpeedY', '_GlowColor', '_GlowInner', '_GlowOffset', '_GlowOuter', '_GlowPower', '_GradientScale',
  '_LightAngle', '_MainTex', '_MaskCoord', '_MaskSoftnessX', '_MaskSoftnessY', '_OutlineColor', '_OutlineSoftness', '_OutlineTex',
  '_OutlineUVSpeedX', '_OutlineUVSpeedY', '_OutlineWidth', '_PerspectiveFilter', '_ReflectFaceColor', '_ReflectOutlineColor',
  '_Reflectivity', '_ScaleRatioA', '_ScaleRatioB', '_ScaleRatioC', '_ScaleX', '_ScaleY', '_ShaderFlags', '_Sharpness', '_SpecularColor',
  '_SpecularPower', '_Stencil', '_StencilComp', '_StencilOp', '_StencilReadMask', '_StencilWriteMask', '_TextureHeight', '_TextureWidth',
  '_UnderlayColor', '_UnderlayDilate', '_UnderlayOffsetX', '_UnderlayOffsetY', '_UnderlaySoftness', '_VertexOffsetX', '_VertexOffsetY',
  '_WeightBold', '_WeightNormal',
];

/** shader guid → 屬性名稱清單 */
export const SHADER_PROPERTIES: Record<string, string[]> = {
  // TextMeshPro/Distance Field（Resources 裡有三份副本，guid 不同內容相同）
  c1f9b553e112b2f42a30c970b714228c: TMP_SDF_PROPS,
  '337400c97a142fb4e8ed1ebc4cc8ff80': TMP_SDF_PROPS,
  d774b8b0c2d6eee45be86ed8f12c9249: TMP_SDF_PROPS,
  // TextMeshPro/Mobile/Distance Field
  '1ea24d33489d07f4d9a574640879b295': [
    '_ClipRect', '_ColorMask', '_CullMode', '_FaceColor', '_FaceDilate', '_GradientScale', '_MainTex', '_MaskSoftnessX', '_MaskSoftnessY',
    '_OutlineColor', '_OutlineSoftness', '_OutlineWidth', '_PerspectiveFilter', '_ScaleRatioA', '_ScaleRatioB', '_ScaleRatioC', '_ScaleX',
    '_ScaleY', '_ShaderFlags', '_Sharpness', '_Stencil', '_StencilComp', '_StencilOp', '_StencilReadMask', '_StencilWriteMask',
    '_TextureHeight', '_TextureWidth', '_UnderlayColor', '_UnderlayDilate', '_UnderlayOffsetX', '_UnderlayOffsetY', '_UnderlaySoftness',
    '_VertexOffsetX', '_VertexOffsetY', '_WeightBold', '_WeightNormal',
  ],
  // TextMeshPro/Sprite
  f1819a3be7bed4a47ac373b73f56db01: [
    '_ClipRect', '_Color', '_ColorMask', '_CullMode', '_DefaultColorBlue', '_DefaultColorGreen', '_DefaultColorPurple', '_DefaultColorRed',
    '_DefaultColorVoid', '_Fuzziness', '_MainTex', '_ReplacementColorBlue', '_ReplacementColorGreen', '_ReplacementColorPurple',
    '_ReplacementColorRed', '_ReplacementColorVoid', '_Stencil', '_StencilComp', '_StencilOp', '_StencilReadMask', '_StencilWriteMask',
    '_Tolerance', '_UseUIAlphaClip',
  ],
  // TextMeshPro/SRP/TMP_SDF-HDRP UNLIT（遊戲自訂，有 _IsoPerimeter／_Softness／_UnderlayOffset）
  '7b073b36f087e9f429b333cfa1d9ffec': [
    '_Ambient', '_BevelAmount', '_BevelClamp', '_BevelOffset', '_BevelRoundness', '_BevelType', '_BevelWidth', '_Diffuse', '_FaceColor',
    '_FaceTex', '_FaceTex_ST', '_FaceUVSpeed', '_GradientScale', '_IsoPerimeter', '_LightAngle', '_MainTex', '_OutlineColor1',
    '_OutlineColor2', '_OutlineColor3', '_OutlineMode', '_OutlineOffset1', '_OutlineOffset2', '_OutlineOffset3', '_OutlineTex',
    '_OutlineTex_ST', '_OutlineUVSpeed', '_Reflectivity', '_Softness', '_SpecularColor', '_SpecularPower', '_UnderlayColor',
    '_UnderlayDilate', '_UnderlayOffset', '_UnderlaySoftness',
  ],
};

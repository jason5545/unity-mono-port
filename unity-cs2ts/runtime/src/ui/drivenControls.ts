// 對應 reference/decompiled/UnityEngine.UI/UnityEngine.UI/Slider.cs（OnEnable → UpdateCachedReferences → Set/ClampValue → UpdateVisuals，
// 以及 normalizedValue、axis、reverseValue）與
// reference/decompiled/UnityEngine.UI/UnityEngine.UI/Scrollbar.cs（value getter、axis、reverseValue、
// OnEnable → UpdateCachedReferences → Set → UpdateVisuals）。
// Unity 存檔把這些被驅動屬性的基底欄位（錨點、fillAmount）大多存成 0，必須照 C# 重算。
// 不看 activeInHierarchy：這裡還沒有「SetActive 時觸發 OnEnable」的機制，而驅動的值
// 只由存檔欄位決定（value、min、max、direction、size 都不隨啟用狀態變），所以先算好，
// 等於物件第一次啟用時 Unity 會算出來的值。
import type { SceneGraph, SceneNode } from '../unity/scene';
import type { ComponentData, RectTransformData } from '../unity/types';

/** Unity Mathf.Round：小數正好 0.5 時取偶數（2.5→2、3.5→4、−2.5→−2），其他四捨五入。JS 的 Math.round 不是這個行為。 */
export function mathfRound(x: number): number {
  const f = Math.floor(x);
  const d = x - f;
  if (d > 0.5) return f + 1;
  if (d < 0.5) return f;
  return f % 2 === 0 ? f : f + 1;
}

/** Unity Mathf.Approximately */
function approximately(a: number, b: number): boolean {
  return Math.abs(b - a) < Math.max(1e-6 * Math.max(Math.abs(a), Math.abs(b)), 1.1754944e-38 * 8);
}

/** m_FillRect／m_HandleRect 這類的 PPtr → 所在節點 */
function refNode(graph: SceneGraph, ref: unknown): SceneNode | undefined {
  const fileID = (ref as { fileID?: string } | null | undefined)?.fileID;
  return graph.nodeOfComponent(fileID);
}

function setAnchors(node: SceneNode, zero: number[], one: number[]): void {
  const rt = node.transform as unknown as RectTransformData;
  rt.m_AnchorMin = { x: zero[0], y: zero[1] };
  rt.m_AnchorMax = { x: one[0], y: one[1] };
}

/** m_Direction 0（LeftToRight）、1（RightToLeft）→ x 軸；2（BottomToTop）、3（TopToBottom）→ y 軸 */
export function axisOf(direction: number): number {
  return direction === 0 || direction === 1 ? 0 : 1;
}

/** RightToLeft 或 TopToBottom 時值反向 */
export function reverseOf(direction: number): boolean {
  return direction === 1 || direction === 3;
}

export function updateDrivenControls(graph: SceneGraph): void {
  // 有 Slider／Scrollbar 的元件清單只隨節點與元件增減變（SceneGraph.cached 的 membership）；啟用與否每次照舊判斷，順序跟掃全樹一樣
  const list = graph.cached('drivenControls', () => {
    const out: [SceneNode, ComponentData][] = [];
    for (const node of graph.nodes.values()) {
      for (const comp of graph.components(node)) {
        if (comp.script?.class === 'Slider' || comp.script?.class === 'Scrollbar') out.push([node, comp]);
      }
    }
    return out;
  }, 'membership');
  for (const [node, comp] of list) {
    if (comp.m_Enabled === 0) continue;
    if (comp.script?.class === 'Slider') sliderUpdateVisuals(graph, node, comp);
    else scrollbarUpdateVisuals(graph, node, comp);
  }
}

/** 照 Slider.cs：OnEnable → UpdateCachedReferences → Set → UpdateVisuals */
export function sliderUpdateVisuals(graph: SceneGraph, node: SceneNode, comp: ComponentData): void {
  const min = comp.m_MinValue as number;
  const max = comp.m_MaxValue as number;
  // Set → ClampValue：結果寫回 m_Value
  let value = Math.min(Math.max(comp.m_Value as number, min), max);
  if (comp.m_WholeNumbers === 1) value = mathfRound(value);
  comp.m_Value = value;
  // normalizedValue：Approximately(min, max) → 0，否則 InverseLerp
  const nv = approximately(min, max) ? 0 : Math.min(Math.max((value - min) / (max - min), 0), 1);
  const dir = comp.m_Direction as number;
  const axis = axisOf(dir);
  const reverse = reverseOf(dir);
  // 填充條：UpdateCachedReferences 要求 fillRect 存在、不是自己、parent 有 RectTransform
  const fillNode = refNode(graph, comp.m_FillRect);
  if (fillNode && fillNode !== node && fillNode.parent && fillNode.parent.isRect) {
    const zero = [0, 0];
    const one = [1, 1];
    const img = graph.component(fillNode, 'Image');
    if (img && (img.m_Type as number) === 3) {
      // Image.Type.Filled：改 fillAmount，錨點維持 (0,0)–(1,1)
      img.m_FillAmount = nv;
    } else if (reverse) {
      zero[axis] = 1 - nv;
    } else {
      one[axis] = nv;
    }
    setAnchors(fillNode, zero, one);
  }
  // 拉桿：同樣要排除「指向自己」
  const handleNode = refNode(graph, comp.m_HandleRect);
  if (handleNode && handleNode !== node && handleNode.parent && handleNode.parent.isRect) {
    const zero = [0, 0];
    const one = [1, 1];
    const v = reverse ? 1 - nv : nv;
    zero[axis] = v;
    one[axis] = v;
    setAnchors(handleNode, zero, one);
  }
}

/** 照 Scrollbar.cs：OnEnable → UpdateCachedReferences → Set → UpdateVisuals */
export function scrollbarUpdateVisuals(graph: SceneGraph, _node: SceneNode, comp: ComponentData): void {
  // value getter：取整只發生在讀取時，Set 原樣存輸入值，不寫回 m_Value
  let value = comp.m_Value as number;
  const steps = (comp.m_NumberOfSteps as number) ?? 0;
  if (steps > 1) value = mathfRound(value * (steps - 1)) / (steps - 1);
  const size = comp.m_Size as number;
  const dir = comp.m_Direction as number;
  const axis = axisOf(dir);
  const reverse = reverseOf(dir);
  // UpdateCachedReferences 只要求 handleRect 存在且 parent 有 RectTransform（沒有「不是自己」的檢查）
  const handleNode = refNode(graph, comp.m_HandleRect);
  if (handleNode && handleNode.parent && handleNode.parent.isRect) {
    const zero = [0, 0];
    const one = [1, 1];
    const num = Math.min(Math.max(value, 0), 1) * (1 - size);
    if (reverse) {
      zero[axis] = 1 - num - size;
      one[axis] = 1 - num;
    } else {
      zero[axis] = num;
      one[axis] = num + size;
    }
    setAnchors(handleNode, zero, one);
  }
}

// PhysicMaterial 資產（public/game/assets/physicMaterials.json，0c 補的：DiceBounce、DiceTray）。物理（engine/physics.ts）同步取用。

export interface PhysicMaterialRecord {
  dynamicFriction: number;
  staticFriction: number;
  bounciness: number;
  frictionCombine: number;
  bounceCombine: number;
}

const materials = new Map<string, PhysicMaterialRecord>();

export function registerPhysicMaterials(rec: Record<string, PhysicMaterialRecord>): void {
  for (const [guid, m] of Object.entries(rec)) materials.set(guid, m);
}

export function physicMaterial(guid: string): PhysicMaterialRecord | null {
  return materials.get(guid) ?? null;
}

/**
 * Phase 15.3: entities fading out (a defeated enemy with `defeat: "fade"`).
 *
 * Each mesh under a fading entity draws with its own transparent copy of its
 * material(s) at the runtime's opacity (times the material's own), so a
 * material shared with other objects is never touched; the originals come
 * back — and the copies are released — when the entity leaves the runtime's
 * opacity map (the fade ended and it is hidden, or a new run shows it again).
 */
import * as THREE from 'three';

interface FadedMesh {
  readonly mesh: THREE.Mesh;
  readonly original: THREE.Material | THREE.Material[];
  readonly base: readonly number[];
}

export interface FadeTracker {
  /** Apply this frame's opacities (`undefined`: the runtime has none — restore everything). */
  apply(objects: ReadonlyMap<string, THREE.Object3D>, opacity: ReadonlyMap<string, number> | undefined): void;
  /** Entities currently drawn faded. */
  faded(): readonly string[];
  /** Restore every original material and release the copies. */
  dispose(): void;
}

export function createFadeTracker(): FadeTracker {
  const faded = new Map<string, FadedMesh[]>();
  const restore = (id: string): void => {
    const meshes = faded.get(id);
    if (meshes === undefined) return;
    for (const { mesh, original } of meshes) {
      const copies = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      mesh.material = original;
      for (const c of copies) c.dispose();
    }
    faded.delete(id);
  };
  return {
    apply(objects, opacity) {
      for (const id of [...faded.keys()]) if (opacity === undefined || !opacity.has(id)) restore(id);
      if (opacity === undefined) return;
      for (const [id, alpha] of opacity) {
        const obj = objects.get(id);
        if (obj === undefined) continue;
        let meshes = faded.get(id);
        if (meshes === undefined) {
          const list: FadedMesh[] = [];
          obj.traverse((o) => {
            const mesh = o as THREE.Mesh;
            if (mesh.isMesh !== true || mesh.material === undefined) return;
            const original = mesh.material;
            const originals = Array.isArray(original) ? original : [original];
            const copies = originals.map((m) => {
              const c = m.clone();
              c.transparent = true;
              return c;
            });
            mesh.material = Array.isArray(original) ? copies : copies[0]!;
            list.push({ mesh, original, base: originals.map((m) => m.opacity) });
          });
          meshes = list;
          faded.set(id, meshes);
        }
        const a = Math.max(0, Math.min(1, alpha));
        for (const { mesh, base } of meshes) {
          const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
          materials.forEach((m, i) => {
            m.opacity = (base[i] ?? 1) * a;
          });
        }
      }
    },
    faded: () => [...faded.keys()],
    dispose() {
      for (const id of [...faded.keys()]) restore(id);
    },
  };
}

/**
 * Phase 23.0: the hand-over of the 3D physics backend between separately
 * built bundles. The 3D backend (rapier3d with its inlined WASM, a few MB) is
 * its own script file (`physics-3d.js`) loaded only by a project whose
 * `physics_dimension` is 3 — the play/export bundles are IIFE scripts (the
 * pinned build options), so there is no code splitting: the backend script
 * registers itself on the global object under this name and the host picks
 * it up (`loadPhysics3D`). Dependency-free on purpose: the backend entry
 * imports only this file (the `./physics-3d-global` subpath), not the host.
 */

/** The global property the 3D backend script registers itself under. */
export const PHYSICS_3D_GLOBAL = '__thirdlightPhysics3D';

/** What the 3D backend script provides (physics-rapier/3d's factory and memory probe). */
export interface Physics3DModule {
  createPhysicsPort3D(config: never, signal?: AbortSignal): Promise<{ ok: true; port: unknown } | { ok: false; error: { code: string; message?: string } }>;
  physicsMemoryBytes3D(): number | null;
}

/** Called by the 3D backend script when it runs: registers the module (the first one stays). */
export function registerPhysics3D(module: Physics3DModule): void {
  const g = globalThis as Record<string, unknown>;
  if (g[PHYSICS_3D_GLOBAL] === undefined) g[PHYSICS_3D_GLOBAL] = Object.freeze({ ...module });
}

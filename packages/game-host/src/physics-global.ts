/**
 * The hand-over of the physics backend between separately built bundles. The
 * backend (rapier3d with its WASM, a few MB) is its own script file, loaded
 * only by a game that needs physics — the play/export bundles are IIFE
 * scripts, so there is no code splitting: the backend script registers itself
 * on the global object and the host picks it up (`loadPhysics3D`). Dependency-free on
 * purpose: a backend entry imports only this file (the `./physics-global`
 * subpath), not the host.
 */

/** The global property the backend script registers itself under. */
export const PHYSICS_3D_GLOBAL = '__thirdlightPhysics3D';

/** What the backend script provides (physics-rapier's factory and memory probe). */
export interface Physics3DModule {
  createPhysicsPort3D(config: never, signal?: AbortSignal): Promise<{ ok: true; port: unknown } | { ok: false; error: { code: string; message?: string } }>;
  physicsMemoryBytes3D(): number | null;
}

function register(name: string, module: object): void {
  const g = globalThis as Record<string, unknown>;
  // The first one stays: a script loaded twice registers the same backend.
  if (g[name] === undefined) g[name] = Object.freeze({ ...module });
}

/** Called by the backend script when it runs. */
export function registerPhysics3D(module: Physics3DModule): void {
  register(PHYSICS_3D_GLOBAL, module);
}

/**
 * The hand-over of a physics backend between separately built bundles. Each
 * backend (rapier2d or rapier3d with its WASM, a few MB) is its own script
 * file, loaded only by a project whose `physics_dimension` names it — the
 * play/export bundles are IIFE scripts, so there is no code splitting: the
 * backend script registers itself on the global object under its name and
 * the host picks it up (`loadPhysics2D`, `loadPhysics3D`). Dependency-free on
 * purpose: a backend entry imports only this file (the `./physics-global`
 * subpath), not the host.
 */

/** The global property the 2D backend script registers itself under. */
export const PHYSICS_2D_GLOBAL = '__thirdlightPhysics2D';
/** The global property the 3D backend script registers itself under. */
export const PHYSICS_3D_GLOBAL = '__thirdlightPhysics3D';

/** What the 2D backend script provides (physics-rapier's factory and memory probe). */
export interface Physics2DModule {
  createPhysicsPort(config: never): Promise<{ ok: true; port: unknown } | { ok: false; error: { code: string; message?: string } }>;
  physicsMemoryBytes(): number | null;
}

/** What the 3D backend script provides (physics-rapier/3d's factory and memory probe). */
export interface Physics3DModule {
  createPhysicsPort3D(config: never, signal?: AbortSignal): Promise<{ ok: true; port: unknown } | { ok: false; error: { code: string; message?: string } }>;
  physicsMemoryBytes3D(): number | null;
}

function register(name: string, module: object): void {
  const g = globalThis as Record<string, unknown>;
  // The first one stays: a script loaded twice registers the same backend.
  if (g[name] === undefined) g[name] = Object.freeze({ ...module });
}

/** Called by the 2D backend script when it runs. */
export function registerPhysics2D(module: Physics2DModule): void {
  register(PHYSICS_2D_GLOBAL, module);
}

/** Called by the 3D backend script when it runs. */
export function registerPhysics3D(module: Physics3DModule): void {
  register(PHYSICS_3D_GLOBAL, module);
}

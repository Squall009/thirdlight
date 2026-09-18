/**
 * @thirdlight/three-adapter — public surface (dependencies.md §3 row:
 * `createSceneAdapter(canvas, opts) → SceneAdapter { renderFrame,
 * captureScreenshot(maxWidth), diagnostics, dispose }`, `ERROR_CODES`).
 *
 * Thirdlight M1 three.js scene adapter (packet 08): owns ALL
 * Object3D/material/renderer lifetimes for the M1 scene graph; transform
 * synchronization from the runtime's interpolated state; one WebGL
 * renderer path (three@0.186.0, WebGL 2 first — the selected backend is
 * reported in diagnostics); structured adapter diagnostics. Node-side
 * dependencies (dependencies.md §4.1): @thirdlight/runtime, three.
 */
export { createSceneAdapter, type SceneAdapter, type SceneAdapterDiagnostics, type SceneAdapterOptions, type ScreenshotResult } from './adapter';
export { ERROR_CODES, adapterError, type AdapterError, type AdapterErrorCode } from './errors';
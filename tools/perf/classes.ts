/**
 * The benchmark scene classes and the written budgets (the same
 * numbers as the "Budgets" of docs/plan-phase-21.md). Classes are generic scene
 * sizes — a small level, a medium level, a large multi-scene world, a
 * script-heavy and an effect-heavy scene — never a particular game.
 * And an asset-heavy world (many distinct model files and
 * textures, one start scene of four), for Play-start and scene-load timings.
 */

export type BenchClass = 'small' | 'medium' | 'large' | 'script-heavy' | 'effect-heavy' | 'asset-heavy';

export const BENCH_CLASSES: readonly BenchClass[] = ['small', 'medium', 'large', 'script-heavy', 'effect-heavy', 'asset-heavy'];

export interface ClassSpec {
  name: BenchClass;
  /** Entities over every scene, the built-in camera and two lights included (exact). */
  entities: number;
  scenes: number;
  materials: number;
  effects: number;
  /** Capacity (maxParticles) of each effect's one system; rate × lifetime fills it. */
  particlesPerEffect: number;
  /** Entities carrying a script (behavior component). */
  scriptInstances: number;
  /** Instance sets and the copies in each. */
  instanceSets: number;
  copiesPerSet: number;
  /** Entities showing a piece of the benchmark model. */
  models: number;
  /** Point lights (the sun and the ambient light come with every project); the loaded scenes together hold at most 16. */
  pointLights: number;
  /**
   * Distinct model files (absent: the one benchmark kit). Each is
   * a textured sphere of `modelSegments`² quads with a `modelTextureSize`²
   * embedded texture; a scene's props use the files dealt to that scene.
   */
  modelFiles?: number;
  modelSegments?: number;
  modelTextureSize?: number;
  /** Texture files (`textureSize`²), one per material (absent: untextured materials). */
  textureFiles?: number;
  textureSize?: number;
  /** How many scenes start (absent: all); the others load on demand. */
  startScenes?: number;
}

export const CLASS_SPECS: Readonly<Record<BenchClass, ClassSpec>> = {
  // Every class carries a little of everything, so every path is exercised;
  // the class's own emphasis is its headline number.
  small: { name: 'small', entities: 100, scenes: 1, materials: 4, effects: 1, particlesPerEffect: 200, scriptInstances: 4, instanceSets: 1, copiesPerSet: 1000, models: 10, pointLights: 2 },
  medium: { name: 'medium', entities: 2000, scenes: 1, materials: 50, effects: 20, particlesPerEffect: 500, scriptInstances: 20, instanceSets: 2, copiesPerSet: 5000, models: 400, pointLights: 8 },
  large: { name: 'large', entities: 16000, scenes: 10, materials: 50, effects: 20, particlesPerEffect: 500, scriptInstances: 50, instanceSets: 4, copiesPerSet: 50000, models: 5500, pointLights: 16 },
  'script-heavy': { name: 'script-heavy', entities: 600, scenes: 1, materials: 8, effects: 1, particlesPerEffect: 200, scriptInstances: 500, instanceSets: 1, copiesPerSet: 1000, models: 20, pointLights: 2 },
  'effect-heavy': { name: 'effect-heavy', entities: 100, scenes: 1, materials: 4, effects: 20, particlesPerEffect: 2500, scriptInstances: 4, instanceSets: 1, copiesPerSet: 1000, models: 10, pointLights: 2 },
  // 48 model files (~0.6 MB each) and 24 textures (~1 MB each) over four scenes; only the first starts.
  'asset-heavy': { name: 'asset-heavy', entities: 1200, scenes: 4, materials: 24, effects: 1, particlesPerEffect: 200, scriptInstances: 4, instanceSets: 1, copiesPerSet: 1000, models: 400, pointLights: 4, modelFiles: 48, modelSegments: 96, modelTextureSize: 256, textureFiles: 24, textureSize: 512, startScenes: 1 },
};

/**
 * Budgets per class. Frame times are for a
 * mid-range GPU at 1920×1080 (owner look: this server renders on the CPU).
 * Heap/GPU memory in MiB, times in ms.
 */
export interface ClassBudget {
  playFrameP95Ms: number;
  editorOrbitFrameP95Ms: number;
  playHeapMiB: number;
  editorHeapMiB: number;
  gpuMiB: number;
  exportFirstFrameMs: number;
  editorFirstFrameMs: number;
  playDrawCalls: number;
  simStepP95Ms: number;
  /** The goal is 0: the steady step loop allocates nothing. */
  simBytesPerStep: number;
  commandP95Ms: number;
}

export const BUDGETS: Readonly<Record<BenchClass, ClassBudget>> = {
  small: { playFrameP95Ms: 16.6, editorOrbitFrameP95Ms: 16.6, playHeapMiB: 64, editorHeapMiB: 128, gpuMiB: 64, exportFirstFrameMs: 1500, editorFirstFrameMs: 3000, playDrawCalls: 150, simStepP95Ms: 1, simBytesPerStep: 0, commandP95Ms: 50 },
  medium: { playFrameP95Ms: 16.6, editorOrbitFrameP95Ms: 16.6, playHeapMiB: 128, editorHeapMiB: 256, gpuMiB: 256, exportFirstFrameMs: 3000, editorFirstFrameMs: 5000, playDrawCalls: 600, simStepP95Ms: 1, simBytesPerStep: 0, commandP95Ms: 100 },
  large: { playFrameP95Ms: 16.6, editorOrbitFrameP95Ms: 16.6, playHeapMiB: 384, editorHeapMiB: 768, gpuMiB: 512, exportFirstFrameMs: 6000, editorFirstFrameMs: 15000, playDrawCalls: 1500, simStepP95Ms: 2, simBytesPerStep: 0, commandP95Ms: 250 },
  'script-heavy': { playFrameP95Ms: 16.6, editorOrbitFrameP95Ms: 16.6, playHeapMiB: 128, editorHeapMiB: 192, gpuMiB: 128, exportFirstFrameMs: 2000, editorFirstFrameMs: 4000, playDrawCalls: 700, simStepP95Ms: 2, simBytesPerStep: 0, commandP95Ms: 75 },
  'effect-heavy': { playFrameP95Ms: 16.6, editorOrbitFrameP95Ms: 16.6, playHeapMiB: 128, editorHeapMiB: 192, gpuMiB: 256, exportFirstFrameMs: 2000, editorFirstFrameMs: 4000, playDrawCalls: 200, simStepP95Ms: 1, simBytesPerStep: 0, commandP95Ms: 50 },
  // The files dominate (heap and GPU memory hold the decoded meshes and textures).
  'asset-heavy': { playFrameP95Ms: 16.6, editorOrbitFrameP95Ms: 16.6, playHeapMiB: 256, editorHeapMiB: 384, gpuMiB: 512, exportFirstFrameMs: 4000, editorFirstFrameMs: 6000, playDrawCalls: 700, simStepP95Ms: 1, simBytesPerStep: 0, commandP95Ms: 75 },
};

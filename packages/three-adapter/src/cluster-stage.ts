/**
 * The light clusters of a scene drawn outside a level: a stage (the editor's
 * preview pane) whose local lights are the effect light pools it holds.
 *
 * It is the level's own cluster frame (`AdapterClusters`) with nothing of a
 * level to read (no realized lights, entities, rooms or bakes), so an
 * effect's lights light the stage's lit objects through the same lists,
 * loop and programs as in the Scene view and Play.
 *
 * Browser-only.
 */
import type * as THREE from 'three/webgpu';

import { AdapterClusters, type ClusterDiagnostics } from './cluster-frame';
import type { ClusterUploadRenderer } from './cluster-gpu';
import type { SceneLights } from './lights-shadows';

export interface StageClusters {
  /** Before each render of `camera`: the pools' lights gathered, built and on the GPU. */
  frame(renderer: unknown, camera: THREE.Camera & { near: number; far: number }): void;
  diagnostics(): ClusterDiagnostics | null;
  dispose(): void;
}

const NONE: ReadonlySet<string> = new Set();

/** The cluster frame of `scene` (a stage that draws every frame: nothing to ask another frame for). */
export function createStageClusters(scene: THREE.Scene): StageClusters {
  const clusters = new AdapterClusters({
    scene,
    lights: { forEachLight: () => undefined } as unknown as SceneLights,
    docs: new Map(),
    graph: { worldMatrixOf: () => false, node: () => undefined },
    hidden: () => NONE,
    roomSeen: () => true,
    bakedLight: () => false,
    sceneNames: () => ['preview'],
    canvas: null,
    shadingChanged: () => undefined,
    movers: () => [],
    staticRevision: () => 0,
    drawAgain: () => undefined,
  });
  return {
    frame: (renderer, camera) => clusters.frame(renderer as ClusterUploadRenderer, camera),
    diagnostics: () => clusters.diagnostics(),
    dispose: () => clusters.dispose(),
  };
}

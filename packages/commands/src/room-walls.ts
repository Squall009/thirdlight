/**
 * The walls of rooms drawn on a block layer (generated architecture whose
 * `layer` names it), as the layer's cell edges: wall paint strokes reach
 * their faces as they reach edge pieces'. Read by `editBlocks` for strokes
 * that paint walls.
 */
import { architectureGraphsOf, architectureStylesOf, architectureWallEdges, expandArchitecture, type ArchitectureComponent, type ArchitectureGraphLike, type BlockLayerComponent } from '@thirdlight/project-model';

import type { ContentDocument, SceneDocument } from './types';

const positionOf = (e: { components: unknown }): readonly number[] => (e.components as { transform?: { position?: number[] } }).transform?.position ?? [0, 0, 0];

/** The cell edges the rooms on layer `layerId` stand on (null: none drawn on it). */
export function roomWallsOn(scene: SceneDocument, content: ContentDocument, layerId: string): Map<number, boolean> | null {
  const layer = scene.entities.find((e) => e.id === layerId);
  const comp = (layer?.components as { blockLayer?: BlockLayerComponent } | undefined)?.blockLayer;
  if (layer === undefined || comp === undefined) return null;
  const objects = scene.entities.filter((e) => (e.components as { architecture?: ArchitectureComponent }).architecture?.layer === layerId);
  if (objects.length === 0) return null;
  const table = architectureStylesOf(architectureGraphsOf((content as { graphs?: ArchitectureGraphLike[] }).graphs));
  const origin = positionOf(layer);
  const out = new Map<number, boolean>();
  for (const e of objects) {
    const at = positionOf(e);
    const x = expandArchitecture((e.components as { architecture: ArchitectureComponent }).architecture, at, table);
    for (const [k, v] of architectureWallEdges(x.component, [0, 1, 2].map((i) => (at[i] ?? 0) - (origin[i] ?? 0)), comp.cellSize)) out.set(k, (out.get(k) ?? false) || v);
  }
  return out;
}

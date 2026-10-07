/**
 * A project's block-layer level checks as the backend runs them: one layer's
 * problems (project-model `blockLayerChecks`) with the project's steepest
 * walkable slope as the default for a layer without its own.
 */
import { blockLayerChecks, maxSlopeClimbOf, type BlockLayerCheck, type BlockLayerComponent, type BlockLayerData, type BlockType, type CellField } from '@thirdlight/project-model';

export type { BlockLayerCheck } from '@thirdlight/project-model';

/** The content a layer's checks read: the block types, the cell fields and the settings. */
export interface BlockCheckContent {
  readonly blockTypes?: readonly BlockType[];
  readonly cellFields?: readonly CellField[];
  readonly settings?: unknown;
}

/** One layer's level checks (floating blocks, empty regions, unreachable places). */
export function layerLevelChecks(entityId: string, component: BlockLayerComponent, data: BlockLayerData | null, content: BlockCheckContent): BlockLayerCheck[] {
  return blockLayerChecks(entityId, component, data, content, maxSlopeClimbOf(content.settings));
}

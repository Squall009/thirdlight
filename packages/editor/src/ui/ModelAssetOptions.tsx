/**
 * A model asset's options in the Assets tab's side panel: the rig an
 * animation-only file's clips play on, and the default materials of every
 * placement. Each change is one `setAssetOptions` command (one undo).
 *
 * Browser-only (React).
 */
import type { JSX } from 'react';
import type { MaterialDef } from '@thirdlight/project-model';

import type { AssetView } from '../session/content-projection';
import { ClipsForField } from './ClipsForField';
import { MaterialMappingEditor } from './MaterialsPanel';

export function ModelAssetOptions(p: {
  asset: AssetView;
  assets: readonly AssetView[];
  materials: readonly MaterialDef[];
  /** The model file's own material names. */
  sourceMaterials: readonly string[];
  missingBones: (clipAssetId: string, rigAssetId: string) => Promise<string[] | null>;
  onClipsFor: (rig: string | null) => void;
  onMaterials: (mapping: Record<string, string> | null) => void;
}): JSX.Element {
  return (
    <>
      <ClipsForField
        assetId={p.asset.assetId}
        clipsFor={p.asset.clipsFor ?? null}
        rigs={p.assets.filter((a) => a.kind === 'model' && a.assetId !== p.asset.assetId && a.clipsFor === undefined).map((a) => ({ assetId: a.assetId, displayName: a.displayName }))}
        onChange={p.onClipsFor}
        missingBones={p.missingBones}
      />
      <MaterialMappingEditor label="Default materials (every placement)" sourceNames={p.sourceMaterials} mapping={p.asset.materials ?? null} materials={p.materials} onChange={p.onMaterials} />
    </>
  );
}

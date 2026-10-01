/**
 * A model asset's options in the Assets tab's side panel: the rig an
 * animation-only file's clips play on, and the default materials of every
 * placement. Each change is one `setAssetOptions` command (one undo).
 *
 * Browser-only (React).
 */
import { useState, type JSX } from 'react';
import type { MaterialDef } from '@thirdlight/project-model';

import type { AssetView } from '../session/content-projection';
import { ClipsForField } from './ClipsForField';
import { MaterialMappingEditor } from './MaterialsPanel';

export function ModelAssetOptions(p: {
  asset: AssetView;
  materials: readonly MaterialDef[];
  /** The model file's own material names. */
  sourceMaterials: readonly string[];
  missingBones: (clipAssetId: string, rigAssetId: string) => Promise<string[] | null>;
  onClipsFor: (rig: string | null) => void;
  onMaterials: (mapping: Record<string, string> | null) => void;
  /** Import the model's file again with "extract textures" on or off. */
  onReimportExtract?: (path: string, extract: boolean) => void;
}): JSX.Element {
  return (
    <>
      <ExtractTexturesField asset={p.asset} {...(p.onReimportExtract !== undefined ? { onReimport: p.onReimportExtract } : {})} />
      <ClipsForField
        assetId={p.asset.assetId}
        clipsFor={p.asset.clipsFor ?? null}
        onChange={p.onClipsFor}
        missingBones={p.missingBones}
      />
      <MaterialMappingEditor label="Default materials (every placement)" sourceNames={p.sourceMaterials} mapping={p.asset.materials ?? null} materials={p.materials} onChange={p.onMaterials} />
    </>
  );
}

/**
 * The model's "extract textures" import setting and the texture assets its
 * images became. Changing the setting takes a re-import of the file (Unity's
 * Apply, Godot's Reimport), so an existing model never changes on its own.
 */
function ExtractTexturesField(p: { asset: AssetView; onReimport?: (path: string, extract: boolean) => void }): JSX.Element {
  const on = p.asset.extractTextures === true;
  const [want, setWant] = useState(on);
  const textures = Object.entries(p.asset.textures ?? {});
  const file = p.asset.convertedFrom?.format === 'glb' ? p.asset.convertedFrom.sourcePath : p.asset.convertedFrom === undefined ? p.asset.sourcePath : undefined;
  return (
    <div className="tl-field" data-extract-textures={on ? 'on' : 'off'}>
      <label className="tl-field tl-field--inline" title="The model file's images become texture assets next to it (PNG and JPEG encoded to KTX2 with mipmaps), counted and streamed like any texture. Off: they stay inside the file.">
        <input type="checkbox" aria-label="extract textures" checked={want} onChange={(e) => setWant(e.target.checked)} />
        <span className="tl-field__label">extract textures</span>
      </label>
      {want !== on && file !== undefined && p.onReimport !== undefined && (
        <button className="tl-btn tl-btn--small" onClick={() => p.onReimport?.(file, want)} title="Import the model's file again with this setting">
          reimport
        </button>
      )}
      {textures.length > 0 && (
        <ul className="tl-list" aria-label="extracted textures">
          {textures.map(([image, id]) => (
            <li key={image} data-texture-asset={id}>
              image {image} → {id}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

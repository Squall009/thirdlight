/**
 * A layer's textures, one row per array the layered material reads: its
 * colour (with the height in alpha, which the height blend uses), its
 * normal map and its ORM (occlusion, roughness, metalness). Each row shows
 * the slot's picture and name; a click opens the texture browser under it
 * (the project window lies under the edit mode), × empties a normal or ORM
 * slot. Giving a layer a colour texture fills the other two from textures
 * named alike (`texture-sets.ts`), when the project has them.
 *
 * Browser-only (React).
 */
import { useState, type JSX } from 'react';
import type { MaterialDef } from '@thirdlight/project-model';

import { slotTexture, type LayerTextureKey } from '../../session/layer-palette';
import { LAYERED_TEXTURES } from '../../session/material-graph';
import type { TileThumbnails } from '../../viewport/thumbnails';
import { EntryName, TEXTURE_KINDS } from '../catalog/RefPicker';
import { Glyph } from '../editmode/glyphs';
import { useLayerThumb } from './LayerPalette';
import { TextureBrowser } from './TextureBrowser';

const ROWS: readonly { key: LayerTextureKey; label: string; title: string; clear: boolean }[] = [
  { key: LAYERED_TEXTURES.albedo, label: 'Colour', title: 'The layer\'s colour; its alpha is the height the layers blend by. Picking it fills the normal map and ORM from textures named alike.', clear: false },
  { key: LAYERED_TEXTURES.normals, label: 'Normal map', title: 'The layer\'s surface detail. Layers without one borrow the first layer\'s that has one.', clear: true },
  { key: LAYERED_TEXTURES.orm, label: 'ORM', title: 'Occlusion, roughness and metalness in one texture (red, green, blue). Layers without one borrow the first layer\'s that has one.', clear: true },
];

export function LayerTextures(p: { material: MaterialDef; layer: number; thumbnails: TileThumbnails | null; onPick: (key: LayerTextureKey, textureId: string) => void; disabled?: boolean }): JSX.Element {
  const [open, setOpen] = useState<LayerTextureKey | null>(null);
  return (
    <div className="tl-layertex" role="group" aria-label={`layer ${p.layer + 1} textures`}>
      {ROWS.map((r) => {
        const id = slotTexture(p.material, r.key, p.layer);
        const name = `layer ${p.layer + 1} ${r.label.toLowerCase()}`;
        return (
          <div key={r.key} className="tl-layertex__slot">
            <div className="tl-frow" title={r.title}>
              <span className="tl-frow__label">{r.label}</span>
              <SlotChip id={id} aria={name} open={open === r.key} thumbnails={p.thumbnails} disabled={p.disabled} onClick={() => setOpen(open === r.key ? null : r.key)} />
              {r.clear && id !== null && (
                <button type="button" className="tl-iconbtn" aria-label={`clear ${name}`} title="Empty the slot" disabled={p.disabled} onClick={() => p.onPick(r.key, '')}>
                  <Glyph name="trash" size={14} />
                </button>
              )}
            </div>
            {open === r.key && (
              <TextureBrowser
                aria={`${name} browser`}
                value={id}
                thumbnails={p.thumbnails}
                autoFocus
                onPick={(t) => {
                  setOpen(null);
                  p.onPick(r.key, t);
                }}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}

function SlotChip(p: { id: string | null; aria: string; open: boolean; thumbnails: TileThumbnails | null; onClick: () => void; disabled?: boolean }): JSX.Element {
  const thumb = useLayerThumb(p.id, p.thumbnails);
  return (
    <button type="button" className={`tl-layerchip tl-layerchip--slot${p.open ? ' is-open' : ''}`} aria-label={p.aria} aria-expanded={p.open} data-texture={p.id ?? ''} disabled={p.disabled} onClick={p.onClick}>
      <span className="tl-layerchip__thumb">{thumb.url !== null ? <img src={thumb.url} alt="" /> : <Glyph name="plus" size={12} />}</span>
      <span className="tl-layerchip__name">{p.id === null ? 'Choose…' : <EntryName id={p.id} kinds={TEXTURE_KINDS} />}</span>
    </button>
  );
}

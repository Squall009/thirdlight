/**
 * The material an edit mode works through, as a card at the top of its
 * column: a round picture (its first layer's or colour map's texture tile
 * from the backend, else its colour), its name and what kind of material it
 * is, and whether it reads what the mode makes (a tag: "reads paint" or
 * "no paint"). A click opens it in the material editor.
 *
 * Browser-only (React).
 */
import type { JSX } from 'react';
import type { MaterialDef } from '@thirdlight/project-model';

import type { TileThumbnails } from '../../viewport/thumbnails';
import { Glyph } from '../editmode/glyphs';
import { useLayerThumb } from './LayerPalette';

export interface MaterialCardProps {
  readonly material: MaterialDef | null;
  /** What it is, in a few words ("Layered surface · 4 layers + wetness"). */
  readonly summary: string;
  /** Whether it reads what the mode makes, and the tag's words for each. */
  readonly reads: boolean;
  readonly readsLabel: string;
  readonly offLabel: string;
  /** The texture whose tile is its picture (null: its colour). */
  readonly texture: string | null;
  readonly thumbnails: TileThumbnails | null;
  /** Open it (absent: no material to open). */
  readonly onOpen?: () => void;
}

export function MaterialCard(p: MaterialCardProps): JSX.Element {
  const thumb = useLayerThumb(p.texture, p.thumbnails);
  const colour = typeof p.material?.params['color'] === 'string' ? (p.material.params['color'] as string) : undefined;
  const name = p.material?.name ?? 'No material';
  return (
    <div className="tl-matcard" aria-label="material card">
      <button type="button" className="tl-matcard__ball" aria-label="open material" title={p.onOpen !== undefined ? `Open "${name}" in the material editor` : name} disabled={p.onOpen === undefined} onClick={p.onOpen}>
        {thumb.url !== null ? <img src={thumb.url} alt="" draggable={false} /> : <i style={colour !== undefined ? { background: colour } : undefined} />}
      </button>
      <div className="tl-matcard__text">
        <b>{name}</b>
        <span>{p.summary}</span>
      </div>
      <span className={`tl-tag ${p.reads ? 'tl-tag--ok' : 'tl-tag--warn'}`} aria-label={p.reads ? p.readsLabel : p.offLabel}>
        <Glyph name={p.reads ? 'check' : 'warn'} size={11} />
        {p.reads ? p.readsLabel : p.offLabel}
      </span>
    </div>
  );
}

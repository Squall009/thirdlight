/**
 * The round brush as docked panels, the same in every editor that paints or
 * sculpts with it (terrain, blocks, vertex paint, decal scatter): the
 * brush's settings and, for a tool that reads one, its noise mask, both on
 * the right edge. Each has one id in every editor and mode, so it keeps one
 * place across them (`EditPanels`).
 *
 * Browser-only (React).
 */
import type { JSX, ReactNode } from 'react';

import type { BrushSettings, BrushStore, BrushUse } from '../../session/brush';
import { BrushPanel } from '../brush/BrushPanel';
import { NoiseMask } from '../brush/NoiseMask';
import type { EditPanel } from './docks';

export interface BrushPanelsOptions {
  settings: BrushSettings;
  store: BrushStore;
  uses: readonly BrushUse[];
  /** What inverting does ("Erase", "Lower"); see `BrushPanel`. */
  invert?: string;
  /** Show the cursor's preview (sculpting). */
  preview?: boolean;
  /** The mode cannot paint now (a locked layer): the brush shows as it is, not to be changed. */
  off?: boolean;
  /** The brush panel's title and badge (a tool's own brush: "Scatter brush"). */
  title?: string;
  badge?: string;
  /** What the brush panel shows above the brush (a tool's own options). */
  head?: ReactNode;
  /** The noise mask starts open (absent: open only while the mask is on). */
  maskOpen?: boolean;
}

/** The brush panel (right edge, open) and, for a brush that reads one, the noise mask panel. */
export function brushPanels(p: BrushPanelsOptions): EditPanel[] {
  const mask = p.uses.includes('mask');
  const body = (content: ReactNode): JSX.Element => (
    <div className={`tl-dpanel__pad${p.off === true ? ' tl-vpaint__off' : ''}`} inert={p.off === true}>
      {content}
    </div>
  );
  return [
    { id: 'brush', title: p.title ?? 'Brush', dock: 'r', badge: p.badge ?? 'shared by every brush', render: () => body(<>{p.head}<BrushPanel settings={p.settings} store={p.store} uses={p.uses.filter((u) => u !== 'mask')} {...(p.preview === true ? { preview: true } : {})} {...(p.invert !== undefined ? { invert: p.invert } : {})} /></>) },
    ...(mask ? [{ id: 'noise-mask', title: 'Noise mask', dock: 'r' as const, collapsed: !(p.maskOpen ?? p.settings.mask.on), badge: p.settings.mask.on ? 'on' : 'off', render: () => body(<NoiseMask settings={p.settings} store={p.store} />) }] : []),
  ];
}

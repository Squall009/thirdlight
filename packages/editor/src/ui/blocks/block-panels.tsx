/**
 * The block editor's panels that more than one of its modes declares: the
 * layer's lock (bottom left, collapsed), the block type editor (right edge),
 * and the round brush with its noise mask (right edge). A panel shared by
 * modes has one id, so it keeps one place across them (`EditPanels`).
 *
 * Browser-only (React).
 */
import type { JSX, ReactNode } from 'react';

import type { BrushSettings, BrushStore, BrushUse } from '../../session/brush';
import { BrushPanel } from '../brush/BrushPanel';
import { NoiseMask } from '../brush/NoiseMask';
import { Toggle } from '../editmode/controls';
import type { EditPanel } from '../editmode/docks';
import type { EditModeView } from '../editmode/modes';
import type { BlockSetup } from './block-column';
import { BlockTypeEditor } from './BlockTypeEditor';

/** The layer's lock (its Hierarchy flag), so a finished layer is not changed by a stray stroke; open while locked, so the lock shows. */
export function layerPanel(s: BlockSetup): EditPanel {
  return {
    id: 'layer',
    title: 'Layer',
    dock: 'bl',
    collapsed: !s.locked,
    badge: s.locked ? 'locked' : 'unlocked',
    render: () => (
      <div className="tl-dpanel__pad">
        <Toggle label="Locked (nothing can be edited)" aria="lock layer" on={s.locked} onChange={(on) => s.blocks.setFlag(s.entity.id, 'locked', on)} hint="The object's Locked flag, as in the Hierarchy." />
      </div>
    ),
  };
}

/** The block type the palette picked (or a click in Navigate opened), edited in plain controls. */
export function blockTypePanel(view: EditModeView, s: BlockSetup, shown = true): EditPanel {
  const id = s.state.typeOpen ?? s.state.brush.block;
  const t = id === null ? undefined : s.typeOf.get(id);
  return { id: 'block-type', title: 'Block type', dock: 'r', shown, ...(t !== undefined ? { badge: t.name } : {}), render: () => <BlockTypeEditor {...view} /> };
}

/** Outside Build, the block type editor shows while a click in Navigate has a block selected (its type opened). */
export const openedTypeShown = (s: BlockSetup): boolean => s.state.selection !== null && s.state.typeOpen !== null;

/** The round brush's settings and, for a brush that reads one, its noise mask (open while it is on). */
export function brushPanels(p: { settings: BrushSettings; store: BrushStore; uses: readonly BrushUse[]; invert?: string; preview?: boolean; off?: boolean; title?: string; badge?: string; head?: ReactNode }): EditPanel[] {
  const mask = p.uses.includes('mask');
  // A mode that cannot paint now (a locked layer) shows its brush as it is, not to be changed.
  const body = (content: ReactNode): JSX.Element => (
    <div className={`tl-dpanel__pad${p.off === true ? ' tl-vpaint__off' : ''}`} inert={p.off === true}>
      {content}
    </div>
  );
  return [
    { id: 'brush', title: p.title ?? 'Brush', dock: 'r', badge: p.badge ?? 'shared by every brush', render: () => body(<>{p.head}<BrushPanel settings={p.settings} store={p.store} uses={p.uses.filter((u) => u !== 'mask')} {...(p.preview === true ? { preview: true } : {})} {...(p.invert !== undefined ? { invert: p.invert } : {})} /></>) },
    ...(mask ? [{ id: 'noise-mask', title: 'Noise mask', dock: 'r' as const, collapsed: !p.settings.mask.on, badge: p.settings.mask.on ? 'on' : 'off', render: () => body(<NoiseMask settings={p.settings} store={p.store} />) }] : []),
  ];
}

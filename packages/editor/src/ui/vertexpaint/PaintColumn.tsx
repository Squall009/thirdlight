/**
 * The vertex paint editor's Paint mode: what the object's material is and
 * whether it reads paint (with Make it paintable first when it does not),
 * the tools (Paint, Erase: one brush, X switches), the palette of what the
 * paint means on that material (a layered surface's Base, layers 2–4 and
 * Wet; a trim sheet's grime and wetness; a tint's colour and amount), the
 * shared brush panel and noise mask.
 *
 * Browser-only (React).
 */
import { useState, type JSX } from 'react';

import { brushKeyHints, paletteKeyHint } from '../../session/edit-keys';
import { VERTEX_PAINT_USES } from '../../session/vertex-paint-brush';
import { BrushPanel } from '../brush/BrushPanel';
import { NoiseMask } from '../brush/NoiseMask';
import { Banner } from '../editmode/Banner';
import { Section } from '../editmode/controls';
import { useEditStatus } from '../editmode/edit-status';
import type { EditModeView } from '../editmode/modes';
import { ToolGrid } from '../editmode/ToolGrid';
import { LayerPalette } from '../palette/LayerPalette';
import { setUpLayered } from '../palette/MaterialLayers';
import { PaintMaterialCard } from './PaintMaterialCard';
import { useVertexPaint, type VertexPaintSetup } from './vertex-paint-column';

const TOOLS = [
  { id: 'paint', label: 'Paint', glyph: 'paint', key: 'B', hint: 'Drag on the object to paint the picked layer.' },
  { id: 'erase', label: 'Erase', glyph: 'erase', key: 'X', hint: 'Drag on the object to take the picked layer off.' },
] as const;

/** The status line's words for the picked tile and tool. */
function statusOf(vp: VertexPaintSetup, erase: boolean): { tool: string; text: string } {
  const t = vp.channels.tiles[vp.tile];
  const name = t?.name ?? 'the layer';
  if (!vp.paintable) return { tool: 'Paint', text: vp.locked ? `${vp.entity.name} is locked: unlock it in the Hierarchy to paint.` : 'This material doesn\'t read paint. Make it paintable to start.' };
  if (vp.target.erases === true) return { tool: 'Paint', text: `Drag on ${vp.entity.name} to paint ${name}: it takes the other layers off.` };
  return erase ? { tool: 'Erase', text: `Drag on ${vp.entity.name} to take ${name} off.` } : { tool: 'Paint', text: `Drag on ${vp.entity.name} to paint ${name}.` };
}

/** "Make it paintable" with its own busy state. */
export function useMakePaintable(vp: VertexPaintSetup): { busy: boolean; run: () => void } {
  const [busy, setBusy] = useState(false);
  return {
    busy,
    run: () => {
      setBusy(true);
      void setUpLayered(vp.host.palette, vp.entity.id, vp.entity.name, vp.channels.material, undefined, vp.slots).finally(() => setBusy(false));
    },
  };
}

/** The banner a material without paint gets first in a column (null: it reads paint, or the object is locked). */
export function NoPaintBanner({ vp }: { vp: VertexPaintSetup }): JSX.Element | null {
  const make = useMakePaintable(vp);
  if (vp.channels.meaning !== 'none' || vp.locked) return null;
  const m = vp.channels.material;
  const what = m === null ? `${vp.entity.name} wears no material of the project's (it draws its own or a stand-in), which reads no paint, so painting would change nothing you can see. Make it paintable gives it a Layered surface (its base starts empty: drop a texture on it), as one undo step.` : `${m.name} is a ${vp.channels.summary}, so painting would change nothing you can see. Make it paintable swaps in a Layered surface whose base is its own textures (one undo step).`;
  return (
    <Banner title="This material doesn't read paint" aria="material does not read paint" action={{ label: 'Make it paintable', onClick: make.run, busy: make.busy }}>
      {what}
    </Banner>
  );
}

/** Paint made for an earlier version of the model (a stroke over it was refused), with the offer to remove it (null: none). */
export function StalePaintCheck({ vp }: { vp: VertexPaintSetup }): JSX.Element | null {
  const stale = vp.host.paint.stale;
  if (stale === null || stale.entityId !== vp.entity.id) return null;
  return (
    <div className="tl-check tl-check--warn" role="alert" aria-label="stale vertex paint">
      <div>
        <b>Paint made for an earlier version of this model</b>
        <p>{stale.message}</p>
      </div>
      <button type="button" className="tl-btn tl-btn--small" onClick={() => void vp.host.paint.removeStale()} title="Remove this mesh's old paint (one undo step); then it can be painted again">
        Remove its stale paint
      </button>
    </div>
  );
}

export function PaintColumn({ entity, host }: EditModeView): JSX.Element {
  const vp = useVertexPaint(entity, host);
  const { channels, settings, store, paintable } = vp;
  const erase = settings.invert && vp.target.erases !== true;
  useEditStatus({
    ...statusOf(vp, erase),
    keys: paintable ? [...paletteKeyHint(channels.tiles.length, 'Layer'), ...brushKeyHints(VERTEX_PAINT_USES, 'Erase'), { keys: ['V'], label: 'Channel view' }] : [],
  });
  const picked = channels.tiles[vp.tile];
  return (
    <div className="tl-vpaint" aria-label="vertex paint tools">
      <NoPaintBanner vp={vp} />
      <StalePaintCheck vp={vp} />
      <Section title="Material">
        <PaintMaterialCard vp={vp} />
      </Section>
      <div className={paintable ? undefined : 'tl-vpaint__off'} inert={!paintable}>
        <Section title="Tool">
          <ToolGrid tools={TOOLS} active={erase ? 'erase' : 'paint'} onPick={(id) => store.set({ invert: id === 'erase' })} aria="vertex paint tool" cols={4} disabled={!paintable} />
        </Section>
        <Section title="Layers" aside={picked !== undefined ? <span className="tl-sec__note">{picked.name}{picked.sub !== undefined ? ` · ${picked.sub}` : ''}</span> : undefined}>
          <LayerPalette layers={channels.tiles} active={vp.tile} onPick={(i) => vp.setState({ tile: i })} thumbnails={host.palette.thumbnails} compact keys={paintable} disabled={!paintable} aria="paint layers" />
          <p className="tl-hint">{channels.hint}</p>
        </Section>
        <Section title="Brush" aside="Shared by every brush">
          <BrushPanel settings={settings} store={store} uses={VERTEX_PAINT_USES.filter((u) => u !== 'mask')} invert="Erase" />
        </Section>
        <Section title="Noise mask" open={settings.mask.on} aside={<span className={`tl-tag${settings.mask.on ? ' tl-tag--ok' : ''}`}>{settings.mask.on ? 'on' : 'off'}</span>}>
          <NoiseMask settings={settings} store={store} />
        </Section>
      </div>
    </div>
  );
}

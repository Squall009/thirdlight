/**
 * The vertex paint editor's Material mode: the object's material and its
 * layers — on a layered surface the layer palette's editing (a texture into
 * a layer, its name, tiling and trim sheet in Layer settings); on a
 * material whose paint means something else (a trim sheet's grime, a tint)
 * the offer to make it a layered surface whose base keeps its look; on one
 * that reads no paint, Make it paintable.
 *
 * Browser-only (React).
 */
import { useState, type JSX } from 'react';

import { Section } from '../editmode/controls';
import { useEditStatus } from '../editmode/edit-status';
import type { EditModeView } from '../editmode/modes';
import { MaterialLayers } from '../palette/MaterialLayers';
import { NoPaintBanner, useMakePaintable } from './PaintColumn';
import { PaintMaterialCard } from './PaintMaterialCard';
import { useVertexPaint } from './vertex-paint-column';

export function MaterialColumn({ entity, host }: EditModeView): JSX.Element {
  const vp = useVertexPaint(entity, host);
  const { channels, palette } = vp;
  const [layer, setLayer] = useState(0);
  const make = useMakePaintable(vp);
  useEditStatus({ tool: 'Material', text: channels.meaning === 'layers' ? 'Drop or pick a texture for each layer; Layer settings… for its name, tiling and trim sheet.' : 'The material the paint is read by.', keys: [] });
  return (
    <div className="tl-vpaint" aria-label="vertex paint material">
      <NoPaintBanner vp={vp} />
      <Section title="Material">
        <PaintMaterialCard vp={vp} />
      </Section>
      {channels.meaning === 'layers' && <MaterialLayers entityId={entity.id} entityName={entity.name} palette={palette} active={layer} onPick={setLayer} host={host.palette} disabled={vp.locked} />}
      {(channels.meaning === 'trim' || channels.meaning === 'tint' || channels.meaning === 'raw') && (
        <Section title="Layers">
          <p className="tl-hint">
            {channels.meaning === 'trim' ? `"${channels.material?.name}" reads paint as grime and wetness.` : channels.meaning === 'tint' ? `"${channels.material?.name}" reads paint as a tint.` : `"${channels.material?.name}" reads the paint its own way.`} To blend other materials on {entity.name} (a second trim sheet, moss, rust) make it a layered surface: its base keeps this look{channels.meaning === 'trim' ? ' (the sheet\'s strips and rows)' : ''}, and its paint starts again as layers 2–4 and wetness. One undo step.
          </p>
          <button type="button" className="tl-btn tl-btn--primary" aria-label="make it a layered surface" disabled={make.busy || vp.locked} onClick={make.run}>
            {make.busy ? 'Working…' : 'Make it a layered surface'}
          </button>
        </Section>
      )}
    </div>
  );
}

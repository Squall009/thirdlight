/**
 * The decal editor's Place and Scatter columns: the palette (what is
 * placed), how a placed decal is made (projected or clipped, its size and
 * turn) and, in Place, the random turn and size of Shift+click stamps; in
 * Scatter, the shared brush's footprint and the scatter's density, jitter and
 * seed. The settings are the editor's (remembered per browser); only the
 * placements are commands.
 *
 * Browser-only (React).
 */
import type { JSX } from 'react';
import { DECAL_LIMITS } from '@thirdlight/runtime';

import { DECAL_SCATTER_LIMITS, scatterSpacing } from '../../session/decal-editor';
import { DECAL_STAMP_SCALE_MAX, type DecalToolSettings } from '../../session/decal-place';
import { brushKeyHints, paletteKeyHint } from '../../session/edit-keys';
import { DECAL_SCATTER_USES } from '../../viewport/decal-tool';
import { BrushPanel } from '../brush/BrushPanel';
import { SliderField } from '../brush/SliderField';
import { useBrush } from '../brush/useBrush';
import { Section, Segmented } from '../editmode/controls';
import { useEditStatus } from '../editmode/edit-status';
import type { SceneModeView } from '../editmode/modes';
import { SeedField } from '../rules/RuleConditions';
import type { DecalTools } from '../shell/useDecalTools';
import { DecalPalette } from './DecalPalette';

/** Projected or clipped, in plain words. */
export const PROJECTIONS = [
  { id: 'projected', label: 'Projected', hint: 'Marks every surface in its box, channel by channel, as the camera sees it' },
  { id: 'clipped', label: 'Clipped', hint: 'A mesh cut from the surfaces under it: cheap for many static marks, and it can be baked to a model' },
] as const;

/** How a placed decal is made: projected or clipped, its width, height, depth and turn. */
function PlacementFields({ tools }: { tools: DecalTools }): JSX.Element {
  const s = tools.settings;
  const set = (patch: Partial<DecalToolSettings>): void => tools.setSettings({ ...s, ...patch });
  const size = (axis: 0 | 1 | 2, v: number): void => {
    const next = [...s.size] as [number, number, number];
    next[axis] = v;
    set({ size: next });
  };
  return (
    <Section title="Placement">
      <div className="tl-frow">
        <span className="tl-frow__label">Projection</span>
        <Segmented small aria="decal projection" options={PROJECTIONS} value={s.mode} onChange={(mode) => set({ mode })} />
      </div>
      <SliderField label="Width" aria="decal width" value={s.size[0]} min={0.05} max={20} log limit={[0.001, DECAL_LIMITS.sizeMax]} step={0.01} unit="m" hint="Width of the mark." onChange={(v) => size(0, v)} />
      <SliderField label="Height" aria="decal height" value={s.size[1]} min={0.05} max={20} log limit={[0.001, DECAL_LIMITS.sizeMax]} step={0.01} unit="m" hint="Height of the mark." onChange={(v) => size(1, v)} />
      <SliderField label="Depth" aria="decal depth" value={s.size[2]} min={0.05} max={10} log limit={[0.001, DECAL_LIMITS.sizeMax]} step={0.01} unit="m" hint="How deep the box reaches through the surface: half in front of the point clicked, half behind." onChange={(v) => size(2, v)} />
      <SliderField label="Turn" aria="decal angle" value={s.angle} min={-180} max={180} step={15} unit="°" hint="Degrees a placed decal turns about the surface's normal." onChange={(v) => set({ angle: v })} />
    </Section>
  );
}

/** The status line's words when nothing is picked to place. */
const NOTHING_PICKED = 'Pick a decal in the palette (or drop an image on it) first.';

export function PlaceColumn({ host }: SceneModeView): JSX.Element {
  const tools = host.decals;
  const s = tools.settings;
  const name = tools.palette.find((e) => e.material === s.material)?.name;
  useEditStatus({
    tool: 'Place',
    text: s.material === null ? NOTHING_PICKED : `Click a surface to place ${name ?? 'the decal'}; Shift+click stamps more, each turned and sized at random.`,
    keys: [...paletteKeyHint(tools.palette.length, 'Decal'), { keys: ['Shift', 'Click'], label: 'Stamp' }, { keys: ['Del'], label: 'Delete' }],
  });
  return (
    <div className="tl-decals" aria-label="decal place tools">
      <DecalPalette tools={tools} thumbnails={host.palette.thumbnails} active={s.material} onPick={(e) => void tools.pick(e)} />
      <PlacementFields tools={tools} />
      <Section title="Stamps" aside={<span className="tl-sec__note">Shift+click</span>} open={false}>
        <SliderField label="Turn ±" aria="decal stamp turn" value={s.stamp.turn} min={0} max={180} step={15} unit="°" hint="Each stamp turns by a random angle up to this either way." onChange={(v) => tools.setSettings({ ...s, stamp: { ...s.stamp, turn: v } })} />
        <SliderField label="Size min" aria="decal stamp size min" value={s.stamp.scaleMin} min={0.1} max={DECAL_STAMP_SCALE_MAX} log step={0.05} unit="×" hint="Each stamp is sized by a random factor between min and max." onChange={(v) => tools.setSettings({ ...s, stamp: { ...s.stamp, scaleMin: v, scaleMax: Math.max(v, s.stamp.scaleMax) } })} />
        <SliderField label="Size max" aria="decal stamp size max" value={s.stamp.scaleMax} min={0.1} max={DECAL_STAMP_SCALE_MAX} log step={0.05} unit="×" hint="Each stamp is sized by a random factor between min and max." onChange={(v) => tools.setSettings({ ...s, stamp: { ...s.stamp, scaleMax: v, scaleMin: Math.min(v, s.stamp.scaleMin) } })} />
        <SeedField aria="decal stamp seed" value={s.stamp.seed} onChange={(n) => tools.setSettings({ ...s, stamp: { ...s.stamp, seed: Math.abs(n) } })} />
      </Section>
    </div>
  );
}

export function ScatterColumn({ host }: SceneModeView): JSX.Element {
  const tools = host.decals;
  const s = tools.settings;
  const sc = tools.scatter;
  const brush = useBrush(tools.brush);
  const name = tools.palette.find((e) => e.material === s.material)?.name;
  useEditStatus({
    tool: 'Scatter',
    text: s.material === null ? NOTHING_PICKED : `Drag over the surfaces to scatter ${name ?? 'the decal'}: each stroke is one undo step.`,
    keys: [...paletteKeyHint(tools.palette.length, 'Decal'), ...brushKeyHints(DECAL_SCATTER_USES)],
    right: `about ${Math.max(1, Math.round(sc.density * Math.PI * (brush.size / 2) ** 2))} per dab`,
  });
  const L = DECAL_SCATTER_LIMITS;
  return (
    <div className="tl-decals" aria-label="decal scatter tools">
      <DecalPalette tools={tools} thumbnails={host.palette.thumbnails} active={s.material} onPick={(e) => void tools.pick(e)} />
      <Section title="Brush" aside="Shared by every brush">
        <BrushPanel settings={brush} store={tools.brush} uses={DECAL_SCATTER_USES} />
      </Section>
      <Section title="Scatter">
        <SliderField label="Density" aria="decal scatter density" value={sc.density} min={L.density[0]} max={L.density[1]} log step={0.01} unit="/m²" hint={`Decals per square metre of surface; never closer than ${scatterSpacing(sc).toFixed(2)} m.`} onChange={(v) => tools.setScatter({ ...sc, density: v })} />
        <SliderField label="Turn ±" aria="decal scatter turn" value={sc.turn} min={0} max={180} step={15} unit="°" hint="Each decal turns by a random angle up to this either way." onChange={(v) => tools.setScatter({ ...sc, turn: v })} />
        <SliderField label="Size min" aria="decal scatter size min" value={sc.scaleMin} min={L.scale[0]} max={L.scale[1]} log step={0.05} unit="×" hint="Each decal is sized by a random factor between min and max." onChange={(v) => tools.setScatter({ ...sc, scaleMin: v, scaleMax: Math.max(v, sc.scaleMax) })} />
        <SliderField label="Size max" aria="decal scatter size max" value={sc.scaleMax} min={L.scale[0]} max={L.scale[1]} log step={0.05} unit="×" hint="Each decal is sized by a random factor between min and max." onChange={(v) => tools.setScatter({ ...sc, scaleMax: v, scaleMin: Math.min(v, sc.scaleMin) })} />
        <SeedField aria="decal scatter seed" value={sc.seed} onChange={(n) => tools.setScatter({ ...sc, seed: Math.abs(n) })} />
      </Section>
      <PlacementFields tools={tools} />
    </div>
  );
}

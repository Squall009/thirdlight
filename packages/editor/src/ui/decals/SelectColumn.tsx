/**
 * The decal editor's Select column: the tools (Navigate, whose click picks
 * a decal as it does in every mode, and Box), the filters
 * (which decals the pointer can pick: by material, by decal layer), the
 * palette (with decals selected, a pick gives them that material); and the
 * selection as a docked panel while there is one — how many, what they are,
 * Select same, and the fields of all of them at once: size, projection, blend, opacity per channel, fades and
 * order. A field the selection disagrees on says "mixed"; an edit is one
 * command for every selected decal (a slider's once it rests). Bake to model
 * and Delete act on the selection.
 *
 * Browser-only (React).
 */
import { useMemo, type JSX } from 'react';
import type { DecalBlend } from '@thirdlight/project-model';
import { DECAL_BLENDS, DECAL_CHANNELS, DECAL_LAYER_COUNT, DECAL_LIMITS } from '@thirdlight/runtime';

import { selectionFields, type DecalFieldEdit, type DecalSelectionFields } from '../../session/decal-editor';
import { paletteKeyHint } from '../../session/edit-keys';
import { SliderField } from '../brush/SliderField';
import { useSettledEdits } from '../brush/settle';
import { Section, Segmented } from '../editmode/controls';
import { EditPanels } from '../editmode/docks';
import { useEditStatus } from '../editmode/edit-status';
import { Glyph } from '../editmode/glyphs';
import type { SceneModeView } from '../editmode/modes';
import { ToolGrid } from '../editmode/ToolGrid';
import { cropStyle, useLayerThumb } from '../palette/LayerPalette';
import type { DecalTools } from '../shell/useDecalTools';
import { PROJECTIONS } from './DecalColumns';
import { DecalPalette } from './DecalPalette';

/** Select's one tool: no tool (Navigate) already picks decals by click. */
const TOOLS = [{ id: 'box', label: 'Box', glyph: 'box', key: 'B', hint: 'Drag a box: the decals whose middle is in it are selected (Shift adds, Ctrl removes).' }] as const;

/** The channels' names on screen. */
const CHANNEL_LABELS: Readonly<Record<(typeof DECAL_CHANNELS)[number], string>> = { albedo: 'Colour', normal: 'Normal', roughness: 'Roughness', metalness: 'Metalness', occlusion: 'Occlusion', emission: 'Emission' };
/** A mesh or clipped decal's blends on screen. */
const BLEND_LABELS: Readonly<Record<DecalBlend, string>> = { blend: 'Normal', multiply: 'Multiply', add: 'Add' };

/** The selection's numeric fields by key, null where it disagrees (what the sliders show and settle). */
type Flat = Readonly<Record<string, number | null>>;

function flatten(f: DecalSelectionFields): Flat {
  const out: Record<string, number | null> = { 'size.0': f.width, 'size.1': f.height, 'size.2': f.depth, normalFade: f.normalFade, fadeDistance: f.fadeDistance, 'edge.0': f.edgeFront, 'edge.1': f.edgeBack, sortOrder: f.sortOrder };
  for (const c of DECAL_CHANNELS) out[`opacity.${c}`] = f.opacity[c];
  return out;
}

/** The command a flat field's new value is. */
function editOf(key: string, value: number): DecalFieldEdit {
  if (key.startsWith('size.')) return { field: 'size', axis: Number(key.slice(5)) as 0 | 1 | 2, value };
  if (key.startsWith('edge.')) return { field: 'edgeFade', end: Number(key.slice(5)) as 0 | 1, value };
  if (key.startsWith('opacity.')) return { field: 'opacity', channel: key.slice(8) as (typeof DECAL_CHANNELS)[number], value };
  return { field: key as 'normalFade' | 'fadeDistance' | 'sortOrder', value };
}

export function SelectColumn({ host }: SceneModeView): JSX.Element {
  const tools = host.decals;
  const { selected } = tools;
  const sel = useMemo(() => selected(host.entities), [selected, host.entities]);
  const fields = useMemo(() => selectionFields(sel.map((s) => s.decal)), [sel]);
  const n = sel.length;
  const decalCount = useMemo(() => host.entities.filter((e) => e.components['decal'] !== undefined).length, [host.entities]);
  useEditStatus({
    tool: 'Box',
    text: 'Drag a box round decals; Shift adds, Ctrl removes.',
    keys: [{ keys: ['Shift'], label: 'Add' }, { keys: ['Ctrl'], label: 'Remove' }, { keys: ['Del'], label: 'Delete' }, ...paletteKeyHint(tools.palette.length, 'Material')],
    right: `${decalCount} decal${decalCount === 1 ? '' : 's'} · ${n} selected`,
  });
  const materials = tools.materials;
  return (
    <div className="tl-decals" aria-label="decal select tools">
      <Section title="Tool">
        <ToolGrid tools={TOOLS} active="box" onPick={() => undefined} aria="decal select tool" cols={4} />
        <div className="tl-frow">
          <span className="tl-frow__label">Filter</span>
          <span className="tl-decals__filters">
            <select className="tl-input" aria-label="pick only material" value={tools.filter.material ?? ''} onChange={(e) => tools.setFilter({ ...tools.filter, material: e.target.value === '' ? null : e.target.value })} title="Only decals of this material can be picked">
              <option value="">Any material</option>
              {materials.map((m) => (
                <option key={m.materialId} value={m.materialId}>
                  {m.name}
                </option>
              ))}
            </select>
            <select className="tl-input" aria-label="pick only layer" value={tools.filter.layer ?? ''} onChange={(e) => tools.setFilter({ ...tools.filter, layer: e.target.value === '' ? null : Number(e.target.value) })} title="Only decals that mark this decal layer can be picked">
              <option value="">Any layer</option>
              {Array.from({ length: DECAL_LAYER_COUNT }, (_x, i) => (
                <option key={i} value={i}>
                  Layer {i + 1}
                </option>
              ))}
            </select>
          </span>
        </div>
      </Section>
      <DecalPalette
        tools={tools}
        thumbnails={host.palette.thumbnails}
        active={n > 0 ? fields.material : tools.settings.material}
        onPick={(e) => {
          void tools.pick(e);
          if (n > 0 && e.material !== null) void tools.edit(host.entities, { field: 'material', value: e.material });
        }}
      />
      <EditPanels
        panels={[
          {
            id: 'selection',
            title: 'Selection',
            dock: 'r',
            selection: true,
            shown: n > 0,
            badge: `${n} of ${decalCount}`,
            render: () => <SelectionFields view={{ host }} tools={tools} fields={fields} names={sel.map((s) => s.name)} />,
          },
        ]}
      />
    </div>
  );
}

/** The selected decals' fields, all at once. */
function SelectionFields({ view, tools, fields, names }: { view: Pick<SceneModeView, 'host'>; tools: DecalTools; fields: DecalSelectionFields; names: readonly string[] }): JSX.Element {
  const { host } = view;
  const n = fields.count;
  const stored = useMemo(() => flatten(fields), [fields]);
  const q = useSettledEdits<Flat>(stored, async (next) => {
    for (const k of Object.keys(next)) {
      const v = next[k];
      if (v !== null && v !== undefined && v !== stored[k]) await tools.edit(host.entities, editOf(k, v));
    }
  });
  const shown = q.value;
  const set = (key: string, label: string) => (v: number) => q.edit(key, label, (d) => ({ ...d, [key]: v }));
  const num = (key: string, fallback: number): { value: number; mixed: boolean } => ({ value: shown[key] ?? fallback, mixed: shown[key] === null });
  const material = fields.material === null ? null : tools.materials.find((m) => m.materialId === fields.material);
  const entry = tools.palette.find((e) => e.material === fields.material);
  const blend = (material?.params['blend'] as DecalBlend | undefined) ?? 'blend';
  const projected = fields.mode !== 'clipped';
  return (
    <div className="tl-dpanel__pad" role="group" aria-label="decal selection">
      {n > 0 && (
        <>
          <div className="tl-decal-sel" aria-label="selected decals">
            <SelThumb texture={entry?.texture ?? null} crop={entry?.crop} stacked={n > 1} thumbnails={host.palette.thumbnails} />
            <div className="tl-decal-sel__text">
              <b>{n === 1 ? names[0] : `${n} decals selected`}</b>
              <span>{material?.name ?? (fields.material === null ? 'several materials' : fields.material)}</span>
            </div>
            <button type="button" className="tl-btn tl-btn--small" onClick={() => tools.selectSame(host.entities)} title="Select every decal of the selection's material">
              Select same
            </button>
          </div>
          <SliderField label="Width" aria="selection width" {...num('size.0', 1)} min={0.05} max={20} log limit={[0.001, DECAL_LIMITS.sizeMax]} step={0.01} unit="m" onChange={set('size.0', 'Width')} />
          <SliderField label="Height" aria="selection height" {...num('size.1', 1)} min={0.05} max={20} log limit={[0.001, DECAL_LIMITS.sizeMax]} step={0.01} unit="m" onChange={set('size.1', 'Height')} />
          <SliderField label="Depth" aria="selection depth" {...num('size.2', 0.5)} min={0.05} max={10} log limit={[0.001, DECAL_LIMITS.sizeMax]} step={0.01} unit="m" hint="How deep the box reaches through the surface." onChange={set('size.2', 'Depth')} />
          <div className="tl-frow">
            <span className="tl-frow__label">Projection</span>
            <Segmented small aria="selection projection" options={PROJECTIONS} value={fields.mode ?? ('' as 'projected')} onChange={(mode) => void tools.edit(host.entities, { field: 'mode', value: mode })} />
          </div>
          <div className="tl-frow" title={material === undefined || material === null ? 'The selection has several materials: blend is set on each material' : `How ${material.name}'s clipped and mesh decals go over the surface (the material's: every decal of it changes). Projected decals blend channel by channel below.`}>
            <span className="tl-frow__label">Blend</span>
            <Segmented small aria="selection blend" disabled={material === undefined || material === null || material.instanceOf !== undefined || projected} options={DECAL_BLENDS.map((b) => ({ id: b, label: BLEND_LABELS[b] }))} value={blend} onChange={(b) => material !== undefined && material !== null && void tools.setBlend(material.materialId, b)} />
          </div>
          <div className="tl-sec__sub">Opacity per channel{projected ? '' : ' (projected decals)'}</div>
          {DECAL_CHANNELS.map((c) => (
            <SliderField key={c} label={CHANNEL_LABELS[c]} aria={`selection opacity ${c}`} {...num(`opacity.${c}`, 1)} min={0} max={1} step={1} scale={100} unit="%" disabled={!projected} hint={`How much of the surface's ${CHANNEL_LABELS[c].toLowerCase()} the decal changes.`} onChange={set(`opacity.${c}`, `${CHANNEL_LABELS[c]} opacity`)} />
          ))}
          <div className="tl-sec__sub">Fades</div>
          <SliderField label="Angle fade" aria="selection angle fade" {...num('normalFade', 90)} min={DECAL_LIMITS.normalFadeMin} max={DECAL_LIMITS.normalFadeMax} step={1} unit="°" hint="Surfaces turned more than this from facing the decal take no mark (180: back faces too)." onChange={set('normalFade', 'Angle fade')} />
          <SliderField label="Far fade" aria="selection far fade" {...num('fadeDistance', 0)} min={0} max={200} limit={[0, DECAL_LIMITS.fadeDistanceMax]} step={1} unit="m" hint="Metres from the camera where it has faded out (0: never)." onChange={set('fadeDistance', 'Far fade')} />
          <SliderField label="Edge front" aria="selection edge fade front" {...num('edge.0', 0.3)} min={0} max={1} step={1} scale={100} unit="%" hint="The share of the box depth it fades over at its front." onChange={set('edge.0', 'Edge fade')} />
          <SliderField label="Edge back" aria="selection edge fade back" {...num('edge.1', 0.3)} min={0} max={1} step={1} scale={100} unit="%" hint="The share of the box depth it fades over at its back." onChange={set('edge.1', 'Edge fade')} />
          <SliderField label="Order" aria="selection sort order" {...num('sortOrder', 0)} min={-20} max={20} limit={[DECAL_LIMITS.sortOrderMin, DECAL_LIMITS.sortOrderMax]} step={1} hint="Where decals overlap, the higher order is drawn over the lower." onChange={set('sortOrder', 'Order')} />
          <div className="tl-decals__actions">
            <button type="button" className="tl-btn" disabled={tools.busy !== null} onClick={() => void tools.bake(host.entities)} title="Write each selected clipped decal's mesh as a model asset and place it instead of the decal (one undo step each)">
              <Glyph name="bake" size={14} /> Bake to model
            </button>
            <button type="button" className="tl-btn" onClick={() => void tools.remove(tools.selection.ids)} title="Delete the selected decals (Del)">
              Delete
            </button>
          </div>
        </>
      )}
    </div>
  );
}

/** The selection's picture: its material's, stacked when several are selected. */
function SelThumb({ texture, crop, stacked, thumbnails }: { texture: string | null; crop: readonly [number, number, number, number] | undefined; stacked: boolean; thumbnails: SceneModeView['host']['palette']['thumbnails'] }): JSX.Element {
  const t = useLayerThumb(texture, thumbnails);
  const style = t.url === null ? undefined : cropStyle(t.url, crop ?? [0, 0, 1, 1]);
  return <span className={`tl-decal-sel__thumb${stacked ? ' is-stacked' : ''}`} style={style} aria-hidden="true" />;
}

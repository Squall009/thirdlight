/**
 * The terrain editor's Stack mode: the edit layers its heights are combined
 * from, top first, over the ground sculpted by hand — stamps, erosion, the
 * splines, the ground meeting block layers — each switched on or off,
 * weighed, moved up or down and deleted; and the tools:
 *
 * - No tool (Navigate): a stamp's square in the view is picked with a
 *   click; its body drags it, a corner resizes it, the knob turns it (one
 *   command on release); its height, side, turn, edge fade and mode in the
 *   Picked stamp panel. Esc lets it go.
 * - Stamp: a click places the chosen heightmap as a stamp, its side the
 *   brush size, into a stamps layer (its settings: the New stamp panel).
 * - Erode: a click erodes the square under the brush (hydraulic, thermal,
 *   every setting of each) into an erosion layer (the Erode panel).
 *
 * The column holds the tools and the layer stack (what is picked from);
 * the panels over the view the settings of what is picked.
 *
 * Every change is one command: the layer list (`setComponent terrain`) or
 * an erosion (`editTerrain` erode); the backend combines the ground again.
 * Changes of the list go through one `useSettledEdits`, so a slider that
 * settles, a click and a handle dragged in the view all build on each
 * other and on the list as the project holds it.
 *
 * Browser-only (React).
 */
import { useCallback, useState, type JSX } from 'react';
import { EROSION_LIMITS, TERRAIN_HEIGHT_LIMIT, TERRAIN_STAMP_SIZE_LIMITS, TERRAIN_BLOCKS_BLEND_DEFAULT, TERRAIN_BLOCKS_BLEND_LIMITS, TERRAIN_STAMP_FALLOFF_DEFAULT, TERRAIN_STAMP_MODES, terrainLayerOrder, type TerrainBlocksLayer, type TerrainLayer, type TerrainStamp } from '@thirdlight/runtime';

import { brushKeyHints } from '../../session/edit-keys';
import { brushRadius } from '../../session/brush';
import { TERRAIN_MODES, erodeArgs, freeLayerId, layersWithStamp, layersWithStampChanged, layersWithoutStamp, terrainStamps, terrainToolUses, type ErodeToolState, type StampRef, type StampToolState } from '../../session/terrain-brush';
import { stampFrameBox } from '../../viewport/frame-view';
import type { TileThumbnails } from '../../viewport/thumbnails';
import { BrushPanel } from '../brush/BrushPanel';
import { useSettledEdits, type SettledEdits } from '../brush/settle';
import { SliderField } from '../brush/SliderField';
import { useBrush } from '../brush/useBrush';
import { EntryName, TEXTURE_KINDS, useEntryName } from '../catalog/RefPicker';
import { Section, Segmented, Toggle } from '../editmode/controls';
import { EditPanels, type EditPanel } from '../editmode/docks';
import { useEditSelection, useEditTool, useToolArmed } from '../editmode/edit-tool';
import { useEditStatus } from '../editmode/edit-status';
import { Glyph } from '../editmode/glyphs';
import { ToolGrid } from '../editmode/ToolGrid';
import { TextureBrowser } from '../palette/TextureBrowser';
import { SeedField } from '../rules/RuleConditions';
import { toolKeysHint } from './BrushModes';
import { heightTrack } from './RulesMode';
import { terrainBrushStore, useTerrainTool, useTerrainToolState, type TerrainColumnProps } from './terrain-column';

const MODE = TERRAIN_MODES.find((m) => m.id === 'stack')!;

const KIND_LABEL: Record<TerrainLayer['kind'], string> = { stamps: 'Stamps', erosion: 'Erosion', splines: 'Roads and rivers', blocks: 'Meets block layers' };
const MODE_LABEL: Record<string, string> = { add: 'Raise', max: 'Up to', min: 'Down to' };

/** No layers stored (one array, so the settled edits see the same stored value each render). */
const NO_LAYERS: TerrainLayer[] = [];

/** The list to store: the splines' place only once it differs from "on top" or carries a setting. */
function storedLayers(next: readonly TerrainLayer[]): TerrainLayer[] {
  const last = next[next.length - 1];
  const plain = last !== undefined && last.kind === 'splines' && last.enabled !== false && (last.strength ?? 1) === 1 && last.name === undefined && next.filter((l) => l.kind === 'splines').length === 1;
  return plain ? next.slice(0, -1) : [...next];
}

type LayerEdits = SettledEdits<TerrainLayer[]>;

export function StackColumn(p: TerrainColumnProps): JSX.Element {
  const [state, setState] = useTerrainToolState(p.entityId);
  const tile = MODE.tiles.find((t) => t.id === state.tiles.stack) ?? MODE.tiles[0]!;
  // With no tool, a click picks a stamp and the picked one's handles drag it.
  const tool = useToolArmed() ? tile.tool : 'stamps';
  const edit = useEditTool();
  const { run, entityId } = p;
  const saveLayers = useCallback(
    (next: TerrainLayer[], what: string): Promise<boolean> => {
      const list = storedLayers(next);
      return run(what, 'setComponent', { entityId, component: 'terrain', value: { layers: list.length > 0 ? list : null } });
    },
    [run, entityId],
  );
  const edits = useSettledEdits(p.component.layers ?? NO_LAYERS, saveLayers);
  const layers = edits.value;
  const stamps = terrainStamps(layers);
  const picked = state.pickedStamp === null ? null : (stamps.find((s) => s.layer === state.pickedStamp!.layer && s.index === state.pickedStamp!.index) ?? null);
  useEditSelection(picked === null ? null : `Stamp ${picked.index + 1} of ${picked.layer}`, () => setState({ pickedStamp: null }), undefined, () => (picked === null ? null : stampFrameBox(picked.stamp, entityId)));
  const store = useTerrainTool(p, tool, {
    place: (at) => {
      if (p.locked) return;
      const radius = brushRadius(terrainBrushStore(tool).get());
      if (tool === 'stamp') {
        if (state.stamp.asset === '') return;
        const stamp = state.stamp;
        edits.edit('place', 'Place stamp', (ls) => layersWithStamp(ls, stamp, at, radius), true);
      } else if (tool === 'erode') void p.run('Erode', 'editTerrain', erodeArgs(p.entityId, state.erode, at, radius));
    },
    stamps: {
      list: stamps,
      picked: state.pickedStamp,
      onPick: (ref) => setState({ pickedStamp: ref === null ? null : { layer: ref.layer, index: ref.index } }),
      onChange: (ref, pose) => edits.edit(`stamp ${ref.layer} ${ref.index} pose`, 'Move stamp', (ls) => layersWithStampChanged(ls, ref.layer, ref.index, { at: pose.at, size: pose.size, rotation: pose.rotation }), true),
    },
  });
  const settings = useBrush(store ?? terrainBrushStore('stamp'));
  const uses = terrainToolUses(tool);
  const text = tool === 'stamp' && state.stamp.asset === '' ? 'Choose a heightmap in the New stamp panel, then click the ground.' : tile.hint;
  useEditStatus({ tool: tool === 'stamps' ? 'Navigate' : tile.label, text, keys: [...toolKeysHint(MODE.tiles), ...brushKeyHints(uses)] });
  const armed = tool !== 'stamps';
  const pickedName = useEntryName(picked?.stamp.asset ?? null, TEXTURE_KINDS);
  const panels: EditPanel[] = [
    {
      id: 'picked-stamp',
      title: 'Picked stamp',
      dock: 'r',
      selection: true,
      shown: picked !== null && !armed,
      ...(picked !== null ? { badge: pickedName?.name ?? picked.stamp.asset } : {}),
      render: () => (picked === null ? null : <PickedStamp p={p} picked={picked} edits={edits} onDrop={() => setState({ pickedStamp: null })} />),
    },
    {
      id: 'new-stamp',
      title: 'New stamp',
      dock: 'r',
      badge: 'the Stamp tool',
      shown: tool === 'stamp' && store !== null,
      render: () =>
        store === null ? null : (
          <div className="tl-dpanel__pad">
            <StampOptions stamp={state.stamp} set={(x) => setState({ stamp: { ...state.stamp, ...x } })} layers={layers.filter((l) => l.kind === 'stamps').map((l) => l.id)} thumbnails={p.palette.thumbnails} />
            <BrushPanel settings={settings} store={store} uses={uses} />
          </div>
        ),
    },
    {
      id: 'erode',
      title: 'Erode',
      dock: 'r',
      badge: 'the Erode tool',
      shown: tool === 'erode' && store !== null,
      render: () =>
        store === null ? null : (
          <div className="tl-dpanel__pad">
            <ErodeOptions erode={state.erode} set={(x) => setState({ erode: { ...state.erode, ...x } })} />
            <BrushPanel settings={settings} store={store} uses={uses} />
          </div>
        ),
    },
  ];
  return (
    <div className="tl-terrain" aria-label="terrain tools">
      <Section title="Tool">
        <ToolGrid tools={MODE.tiles} active={tile.id} onPick={(id) => setState({ tiles: { ...state.tiles, stack: id } })} aria="terrain tool" cols={4} disabled={p.locked} />
        <p className="tl-hint">{armed ? text : stamps.length === 0 ? 'No stamps yet: the Stamp tool places them.' : "Click a stamp's square in the view, or one in the list below."}</p>
      </Section>
      <LayerList
        p={p}
        picked={picked}
        onPick={(ref) => {
          setState({ pickedStamp: ref === null ? null : { layer: ref.layer, index: ref.index } });
          // A stamp picked in the list is edited with no tool in hand (its handles in the view, its settings in its panel).
          edit?.drop();
        }}
        layers={layers}
        edits={edits}
      />
      <EditPanels panels={panels} />
    </div>
  );
}

/** The picked stamp's settings: what it is, where, how high, turned, how it meets the ground; delete. */
function PickedStamp(p: { p: TerrainColumnProps; picked: StampRef; edits: LayerEdits; onDrop: () => void }): JSX.Element {
  const r = p.picked;
  const s = r.stamp;
  const off = p.p.locked;
  // Keyed by the stamp and the setting: a drag's moves replace each other; other settings wait beside it.
  const change = (what: string, patch: Partial<TerrainStamp>, now = false): void => p.edits.edit(`stamp ${r.layer} ${r.index} ${Object.keys(patch).join()}`, what, (ls) => layersWithStampChanged(ls, r.layer, r.index, patch), now);
  return (
    <div role="group" aria-label="picked stamp" className="tl-dpanel__pad">
      <SliderField label="Height" aria="picked stamp height" value={s.height} min={-100} max={100} limit={[-TERRAIN_HEIGHT_LIMIT, TERRAIN_HEIGHT_LIMIT]} step={0.5} unit="m" hint="Metres the image's white stands for (negative digs)." disabled={off} onChange={(v) => change('Stamp height', { height: v })} />
      <SliderField label="Side" aria="picked stamp size" value={s.size} min={1} max={2048} log limit={[TERRAIN_STAMP_SIZE_LIMITS.min, TERRAIN_STAMP_SIZE_LIMITS.max]} step={0.5} unit="m" hint="Metres along a side. A corner in the view drags it too." disabled={off} onChange={(v) => change('Stamp size', { size: v })} />
      <SliderField label="Turn" aria="picked stamp rotation" value={s.rotation ?? 0} min={-180} max={180} step={1} unit="°" hint="Degrees about up. The knob in the view turns it too." disabled={off} onChange={(v) => change('Turn stamp', { rotation: v })} />
      <SliderField label="Edge fade" aria="picked stamp falloff" value={s.falloff ?? TERRAIN_STAMP_FALLOFF_DEFAULT} min={0} max={0.5} step={0.01} scale={100} unit="%" hint="The share of the side over which it fades in from its edges." disabled={off} onChange={(v) => change('Stamp fade', { falloff: v })} />
      <div className="tl-frow">
        <span className="tl-frow__label">Meets the ground</span>
        <Segmented small aria="picked stamp mode" value={s.mode ?? 'add'} options={TERRAIN_STAMP_MODES.map((m) => ({ id: m, label: MODE_LABEL[m] ?? m, hint: m === 'add' ? 'Raised by the shape' : m === 'max' ? 'Raised up to the shape' : 'Cut down to the shape' }))} onChange={(m) => change('Stamp mode', { mode: m === 'add' ? undefined : m }, true)} />
      </div>
      {s.mode !== undefined && s.mode !== 'add' && (
        <SliderField label="Its zero at" aria="picked stamp base" value={s.y ?? p.p.origin[1]} min={heightTrack(p.p)[0]} max={heightTrack(p.p)[1]} limit={[-TERRAIN_HEIGHT_LIMIT, TERRAIN_HEIGHT_LIMIT]} step={0.5} unit="m" hint="The world height the image's black stands for: the ground is raised up to, or cut down to, the shape from there." disabled={off} onChange={(v) => change('Stamp base', { y: v })} />
      )}
      <button type="button" className="tl-btn tl-btn--small" aria-label="delete picked stamp" disabled={off} onClick={() => {
        p.onDrop();
        p.edits.edit(`stamp ${r.layer} ${r.index} remove`, 'Remove stamp', (ls) => layersWithoutStamp(ls, r.layer, r.index), true);
      }}>
        <Glyph name="trash" size={14} /> Delete stamp
      </button>
    </div>
  );
}

/** The Stamp tool's settings: the heightmap (picked by its picture), its height, turn, how it meets the ground, its edge fade, the layer. */
function StampOptions(p: { stamp: StampToolState; set: (x: Partial<StampToolState>) => void; layers: readonly string[]; thumbnails: TileThumbnails | null }): JSX.Element {
  const s = p.stamp;
  const [browsing, setBrowsing] = useState(s.asset === '');
  return (
    <div role="group" aria-label="stamp options" className="tl-sec__stack">
      <div className="tl-frow" title="The texture whose first channel (a 16- or 8-bit greyscale PNG) is the stamp's shape: white is its height, black 0.">
        <span className="tl-frow__label">Heightmap</span>
        <button type="button" className={`tl-layerchip tl-layerchip--slot${browsing ? ' is-open' : ''}`} aria-label="stamp heightmap" aria-expanded={browsing} data-texture={s.asset} onClick={() => setBrowsing(!browsing)}>
          <span className="tl-layerchip__name">{s.asset === '' ? 'Choose…' : <EntryName id={s.asset} kinds={TEXTURE_KINDS} />}</span>
        </button>
      </div>
      {browsing && (
        <TextureBrowser
          aria="stamp heightmap browser"
          value={s.asset === '' ? null : s.asset}
          thumbnails={p.thumbnails}
          onPick={(id) => {
            p.set({ asset: id });
            setBrowsing(false);
          }}
        />
      )}
      <SliderField label="Height" aria="stamp height" value={s.height} min={-100} max={100} limit={[-TERRAIN_HEIGHT_LIMIT, TERRAIN_HEIGHT_LIMIT]} step={1} unit="m" hint="Metres the image's white stands for (negative digs)." onChange={(v) => p.set({ height: v })} />
      <SliderField label="Turn" aria="stamp rotation" value={s.rotation} min={-180} max={180} limit={[-360, 360]} step={15} unit="°" hint="Degrees the image turns about up." onChange={(v) => p.set({ rotation: v })} />
      <div className="tl-frow">
        <span className="tl-frow__label">Meets the ground</span>
        <Segmented small aria="stamp mode" value={s.mode} options={TERRAIN_STAMP_MODES.map((m) => ({ id: m, label: MODE_LABEL[m] ?? m }))} onChange={(m) => p.set({ mode: m })} />
      </div>
      <SliderField label="Edge fade" aria="stamp falloff" value={s.falloff} min={0} max={0.5} step={0.01} scale={100} unit="%" hint="The share of the side over which the stamp fades in from its edges." onChange={(v) => p.set({ falloff: v })} />
      {p.layers.length > 1 && (
        <div className="tl-frow">
          <span className="tl-frow__label">Into layer</span>
          <Segmented small aria="stamp layer" value={s.layer === '' ? p.layers[0]! : s.layer} options={p.layers.map((id) => ({ id, label: id }))} onChange={(id) => p.set({ layer: id })} />
        </div>
      )}
    </div>
  );
}

/** The Erode tool's settings: hydraulic and thermal erosion, each on or off, with every setting of each. */
function ErodeOptions(p: { erode: ErodeToolState; set: (x: Partial<ErodeToolState>) => void }): JSX.Element {
  const e = p.erode;
  const L = EROSION_LIMITS;
  const h = !e.hydraulic;
  const t = !e.thermal;
  return (
    <div role="group" aria-label="erode options" className="tl-sec__stack">
      <Toggle label="Hydraulic: water carves channels" aria="erode hydraulic" hint="Water droplets run downhill, take up ground and drop it where they slow: channels and fans." on={e.hydraulic} onChange={(on) => p.set({ hydraulic: on })} />
      <SliderField label="Droplets" aria="erode droplets" value={e.droplets} min={0.05} max={L.droplets[1]} limit={[0.01, L.droplets[1]]} step={0.05} disabled={h} hint="Droplets per sample of the square." onChange={(v) => p.set({ droplets: v })} />
      <SliderField label="Erosion" aria="erode erosion" value={e.erosion} min={0.01} max={L.erosion[1]} step={0.01} disabled={h} hint="How fast a droplet takes up ground." onChange={(v) => p.set({ erosion: v })} />
      <SliderField label="Deposition" aria="erode deposition" value={e.deposition} min={0.01} max={L.deposition[1]} step={0.01} disabled={h} hint="How fast it drops what it carries past its capacity." onChange={(v) => p.set({ deposition: v })} />
      <SliderField label="Capacity" aria="erode capacity" value={e.capacity} min={0.1} max={L.capacity[1]} step={0.1} disabled={h} hint="How much ground a droplet can carry (more: deeper channels)." onChange={(v) => p.set({ capacity: v })} />
      <SliderField label="Evaporation" aria="erode evaporation" value={e.evaporation} min={L.evaporation[0]} max={L.evaporation[1]} step={0.005} disabled={h} hint="How fast a droplet dries up (more: shorter channels)." onChange={(v) => p.set({ evaporation: v })} />
      <SliderField label="Inertia" aria="erode inertia" value={e.inertia} min={L.inertia[0]} max={L.inertia[1]} step={0.01} disabled={h} hint="How much a droplet keeps its way (more: straighter, smoother channels)." onChange={(v) => p.set({ inertia: v })} />
      <SliderField label="Lifetime" aria="erode lifetime" value={e.lifetime} min={L.lifetime[0]} max={L.lifetime[1]} step={1} disabled={h} hint="Steps a droplet runs before it is gone." onChange={(v) => p.set({ lifetime: Math.round(v) })} />
      <SliderField label="Wear radius" aria="erode radius" value={e.radius} min={L.radius[0]} max={L.radius[1]} step={1} unit="samples" disabled={h} hint="Samples around a droplet it wears (more: wider, softer channels)." onChange={(v) => p.set({ radius: Math.round(v) })} />
      <Toggle label="Thermal: slopes crumble" aria="erode thermal" hint="Ground slides off slopes steeper than the angle of repose: screes and softened ridges." on={e.thermal} onChange={(on) => p.set({ thermal: on })} />
      <SliderField label="Passes" aria="erode passes" value={e.iterations} min={1} max={200} limit={[L.iterations[0], L.iterations[1]]} step={1} disabled={t} hint="Passes over the square." onChange={(v) => p.set({ iterations: Math.round(v) })} />
      <SliderField label="Angle" aria="erode talus" value={e.talus} min={L.talus[0]} max={L.talus[1]} step={1} unit="°" disabled={t} hint="The angle of repose: steeper slopes shed ground." onChange={(v) => p.set({ talus: v })} />
      <SliderField label="Amount" aria="erode amount" value={e.amount} min={0.01} max={L.amount[1]} step={0.01} disabled={t} hint="The share of the steepness past the angle moved each pass." onChange={(v) => p.set({ amount: v })} />
      <SeedField aria="erode seed" value={e.seed} onChange={(n) => p.set({ seed: n })} />
    </div>
  );
}

/** The layers, top first, with the hand-made ground at the bottom; a stamps layer lists its stamps (a click picks one). */
function LayerList(p: { p: TerrainColumnProps; picked: StampRef | null; onPick: (ref: StampRef | null) => void; layers: readonly TerrainLayer[]; edits: LayerEdits }): JSX.Element {
  // The stack as it applies (the splines on top when the list names none), drawn top first.
  const order = terrainLayerOrder({ layers: [...p.layers] });
  /** A change of the stack, made on the list as the project holds it when it is stored (a click at once, a slider once it rests). */
  const change = (key: string, what: string, f: (order: TerrainLayer[]) => TerrainLayer[], now = true): void => p.edits.edit(key, what, (ls) => f(terrainLayerOrder({ layers: ls })), now);
  const update = (id: string, patch: (l: TerrainLayer) => TerrainLayer | null, what: string, key = `${id} ${what}`, now = true): void =>
    change(key, what, (o) => o.map((l) => (l.id === id ? patch(l) : l)).filter((l): l is TerrainLayer => l !== null), now);
  const move = (id: string, by: -1 | 1): void =>
    change(`move ${id} ${by}`, 'Move layer', (o) => {
      const i = o.findIndex((l) => l.id === id);
      const j = i + by;
      if (i < 0 || j < 0 || j >= o.length) return o;
      const next = [...o];
      [next[i], next[j]] = [next[j]!, next[i]!];
      return next;
    });
  const add = (kind: 'stamps' | 'erosion' | 'blocks'): void =>
    change(`add ${kind}`, kind === 'blocks' ? 'Add blocks layer' : 'Add layer', (o) => {
      // The ground meets the block layers over everything else (a road's end included); other new layers go under the splines.
      if (kind === 'blocks') return [...o, { id: freeLayerId(o, 'blocks'), kind }];
      const made: TerrainLayer = kind === 'stamps' ? { id: freeLayerId(o, 'stamps'), kind, stamps: [] } : { id: freeLayerId(o, 'erosion'), kind };
      const at = o.findIndex((l) => l.kind === 'splines');
      return at < 0 ? [...o, made] : [...o.slice(0, at), made, ...o.slice(at)];
    });
  const setBlocks = (id: string, patch: Partial<TerrainBlocksLayer>, what: string, now = true): void => update(id, (x) => (x.kind === 'blocks' ? ({ ...x, ...patch } as TerrainLayer) : x), what, `${id} ${Object.keys(patch).join()}`, now);
  const off = p.p.locked;
  return (
    <Section title="Layers" aside={`${order.length + 1}`}>
      <div role="group" aria-label="terrain layers">
        <ol className="tl-stack" reversed>
          {[...order].reverse().map((l) => {
            const i = order.indexOf(l);
            return (
              <li key={l.id} className={`tl-stack__layer${l.enabled === false ? ' is-off' : ''}`} aria-label={`layer ${l.id}`}>
                <div className="tl-stack__head">
                  <Toggle label={KIND_LABEL[l.kind]} aria={`layer ${l.id} on`} hint="Switch the layer on or off (off: it changes nothing)" disabled={off} on={l.enabled !== false} onChange={(on) => update(l.id, (x) => ({ ...x, ...(on ? { enabled: undefined } : { enabled: false }) }) as TerrainLayer, on ? 'Layer on' : 'Layer off')} />
                  <span className="tl-stack__id">{l.id}</span>
                  <span className="tl-emh__spacer" />
                  <button type="button" className="tl-iconbtn" aria-label={`layer ${l.id} up`} title="Apply after the layer above" disabled={off || i === order.length - 1} onClick={() => move(l.id, 1)}>
                    <Glyph name="up" size={15} />
                  </button>
                  <button type="button" className="tl-iconbtn" aria-label={`layer ${l.id} down`} title="Apply before the layer below" disabled={off || i === 0} onClick={() => move(l.id, -1)}>
                    <Glyph name="down" size={15} />
                  </button>
                  {l.kind !== 'splines' && (
                    <button type="button" className="tl-iconbtn" aria-label={`delete layer ${l.id}`} title="Delete the layer (its stamps or erosion go; undo brings them back)" disabled={off} onClick={() => update(l.id, () => null, 'Delete layer')}>
                      <Glyph name="trash" size={15} />
                    </button>
                  )}
                </div>
                <SliderField label="Strength" aria={`layer ${l.id} strength`} value={l.strength ?? 1} min={0} max={1} step={1} scale={100} unit="%" hint="The share of the layer's change kept." disabled={off} onChange={(v) => update(l.id, (x) => ({ ...x, strength: v === 1 ? undefined : v }) as TerrainLayer, 'Layer strength', `${l.id} strength`, false)} />
                {l.kind === 'stamps' && (
                  <ul className="tl-stack__stamps">
                    {l.stamps.map((s, k) => (
                      <li key={k}>
                        <button type="button" className={`tl-stack__stamp${p.picked?.layer === l.id && p.picked.index === k ? ' is-active' : ''}`} aria-label={`stamp ${k + 1} of ${l.id}`} onClick={() => p.onPick({ layer: l.id, index: k, stamp: s })}>
                          <EntryName id={s.asset} kinds={TEXTURE_KINDS} /> · {Math.round(s.size)} m · {s.height} m{s.mode !== undefined && s.mode !== 'add' ? ` · ${MODE_LABEL[s.mode]?.toLowerCase()}` : ''}
                        </button>
                      </li>
                    ))}
                    {l.stamps.length === 0 && <li className="tl-hint">No stamps yet: the Stamp tool places them.</li>}
                  </ul>
                )}
                {l.kind === 'blocks' && (
                  <>
                    <div className="tl-frow">
                      <span className="tl-frow__label">Under blocks</span>
                      <Segmented small aria={`layer ${l.id} mode`} value={l.mode ?? 'cut'} options={[{ id: 'cut', label: 'Cut away', hint: 'No ground, no collider under the blocks' }, { id: 'flatten', label: 'Flatten', hint: 'Whole ground just below them' }]} onChange={(m) => setBlocks(l.id, { mode: m === 'cut' ? undefined : 'flatten' }, 'Blocks layer mode')} />
                    </div>
                    <SliderField label="Blend" aria={`layer ${l.id} blend`} value={l.blend ?? TERRAIN_BLOCKS_BLEND_DEFAULT} min={TERRAIN_BLOCKS_BLEND_LIMITS.min} max={TERRAIN_BLOCKS_BLEND_LIMITS.max} step={0.5} unit="m" hint="Metres over which the ground round the blocks fades from their border's height and paint to its own." disabled={off} onChange={(v) => setBlocks(l.id, { blend: v === TERRAIN_BLOCKS_BLEND_DEFAULT ? undefined : v }, 'Blocks layer blend', false)} />
                    <Toggle label="Carry the blocks' paint across" aria={`layer ${l.id} paint`} disabled={off} on={l.paint !== false} onChange={(on) => setBlocks(l.id, { paint: on ? undefined : false }, 'Blocks layer paint')} />
                    <span className="tl-hint">{l.blockLayers === undefined ? 'Meets every block layer.' : `Meets ${l.blockLayers.join(', ')}.`}</span>
                  </>
                )}
                {l.kind === 'erosion' && <span className="tl-hint">{(l.tiles?.length ?? 0) === 0 ? 'Nothing eroded yet: the Erode tool runs it.' : `${l.tiles!.length} tile${l.tiles!.length === 1 ? '' : 's'} eroded`}</span>}
              </li>
            );
          })}
          <li className="tl-stack__layer tl-stack__layer--base" aria-label="layer base">
            <b>Base</b> <span className="tl-hint">the ground as sculpted and painted by hand</span>
          </li>
        </ol>
        <div className="tl-inspector__modes">
          <button type="button" className="tl-btn tl-btn--small" aria-label="add stamps layer" disabled={off} onClick={() => add('stamps')}>
            <Glyph name="plus" size={13} /> Stamps
          </button>
          <button type="button" className="tl-btn tl-btn--small" aria-label="add erosion layer" disabled={off} onClick={() => add('erosion')}>
            <Glyph name="plus" size={13} /> Erosion
          </button>
          <button type="button" className="tl-btn tl-btn--small" aria-label="add blocks layer" title="The ground meets the scene's block layers: their border followed, cut away or flattened under them, their paint carried across" disabled={off || order.some((l) => l.kind === 'blocks')} onClick={() => add('blocks')}>
            <Glyph name="plus" size={13} /> Meet block layers
          </button>
        </div>
      </div>
    </Section>
  );
}

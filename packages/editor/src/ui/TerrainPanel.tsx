/**
 * A terrain's tools — the terrain editor's settings column, one mode of the
 * editor's rail at a time (`TERRAIN_MODES`: sculpt, paint, holes, material
 * rules, scatter, stack, tiles); the tools of the mode are armed in the Scene
 * view while the editor is in front.
 *
 * - Tools: raise, lower, smooth, flatten, noise, ramp, paint, holes; Ctrl
 *   (or the invert toggle, X) lowers, erases hand paint or fills holes for
 *   one stroke.
 * - Brush: the shared brush panel (`BrushPanel`: height step, size,
 *   strength, opacity, falloff, spacing, invert) and noise mask
 *   (`NoiseMask`), the settings each tool uses, remembered per tool; the
 *   painted layer and the noise tool's size and seed beside them.
 * - Import heightmap: a 16-bit PNG or RAW file staged and laid onto the
 *   tiles from a tile on, with the heights its 0 and 65535 stand for.
 * - Convert a block layer: its surface (corner heights) and paint become the
 *   terrain's samples.
 * - Material rules: layers by slope, height, cavity and noise, baked into
 *   the tiles (`editTerrain` bake); hand paint stays over them.
 * - Scatter rules: models placed by density where their conditions hold,
 *   baked into the tiles' scatter (`editTerrain` bake); the Scatter brush
 *   puts a rule's copies under it or takes them off (Ctrl), over the rules.
 * - Layers: the edit layers the heights are combined from
 *   (`TerrainLayersPanel`); the Stamp tool places a heightmap (a texture
 *   asset) into a stamps layer with a click, the Erode tool erodes the
 *   square under the brush (hydraulic, thermal) into an erosion layer.
 *
 * A stroke is one `editTerrain` (the Scene view's `TerrainEditor`), as is an
 * import or a conversion — one undo step each.
 *
 * Browser-only (React).
 */
import { useEffect, useState, type JSX } from 'react';
import { EROSION_LIMITS, HEIGHTMAP_FORMATS, TERRAIN_STAMP_MODES, TERRAIN_TILE_COORD_MAX, terrainTileSize, type HeightmapFormat, type TerrainComponent, type TerrainStampMode } from '@thirdlight/runtime';
import { TERRAIN_DEFAULT_COLOURS } from '@thirdlight/three-adapter';
import { DEFAULT_BRUSH, brushRadius, brushStore } from '../session/brush';
import { DEFAULT_ERODE_TOOL, DEFAULT_STAMP_TOOL, DEFAULT_TERRAIN_BRUSH, TERRAIN_BRUSH_BOUNDS, TERRAIN_BRUSH_UI, TERRAIN_INVERT_LABELS, TERRAIN_TOOLS, erodeArgs, layersWithStamp, terrainToolUses, type ErodeToolState, type StampToolState, type TerrainBrushState, type TerrainMode, type TerrainToolId } from '../session/terrain-brush';
import { BrushPanel } from './brush/BrushPanel';
import { LayerPicker } from './palette/LayerPalette';
import { MaterialLayers, usePalette, type PaletteHost } from './palette/MaterialLayers';
import { NoiseMask } from './brush/NoiseMask';
import { SliderField } from './brush/SliderField';
import { useBrush } from './brush/useBrush';
import { Section } from './editmode/controls';
import type { TerrainEditor } from '../viewport/terrain-editor';
import { SurfaceRulesEditor } from './SurfaceRulesEditor';
import { ScatterRulesEditor } from './ScatterRulesEditor';
import { TerrainLayersPanel } from './TerrainLayersPanel';
import { RefPicker } from './catalog/RefPicker';

interface Props {
  editor: TerrainEditor | null;
  /** The mode of the editor's rail shown (its tools, its sections). */
  mode: TerrainMode;
  /** The tools are in front (the terrain editor shows them; they are armed only then). */
  visible: boolean;
  entityId: string;
  component: TerrainComponent;
  locked: boolean;
  hidden: boolean;
  /** The block layers a conversion may read. */
  blockLayers: readonly { entityId: string; name: string }[];
  /** A command (true: stored). */
  run: (what: string, op: string, args: Record<string, unknown>) => Promise<boolean>;
  /** Stage a file's bytes (its stage id; null: not uploaded). */
  stage: (bytes: Uint8Array) => Promise<string | null>;
  /** The terrain object's name and material mapping (its palette's material). */
  entityName: string;
  mapping: Readonly<Record<string, string>> | undefined;
  /** What the layer palette needs from the app. */
  palette: PaletteHost;
}

const clampNum = (v: number, lo: number, hi: number, fallback: number): number => (Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : fallback);

export function TerrainPanel(p: Props): JSX.Element {
  const mode = p.mode;
  const [chosen, setTool] = useState<TerrainToolId>(mode.tools[0] ?? 'raise');
  // The mode's tool (its first until another of its tools is chosen).
  const tool = mode.tools.includes(chosen) ? chosen : (mode.tools[0] ?? chosen);
  const [brush, setBrush] = useState<TerrainBrushState>(DEFAULT_TERRAIN_BRUSH);
  // The tool's shared brush settings (remembered per tool; keys and drags in the view change them too).
  const store = brushStore('terrain', tool, DEFAULT_BRUSH, TERRAIN_BRUSH_BOUNDS);
  const settings = useBrush(store);
  const uses = terrainToolUses(tool);
  const [importOpen, setImportOpen] = useState(false);
  const [stamp, setStamp] = useState<StampToolState>(DEFAULT_STAMP_TOOL);
  const [erode, setErode] = useState<ErodeToolState>(DEFAULT_ERODE_TOOL);
  const [source, setSource] = useState('');
  const editor = p.editor;
  const c = p.component;
  // The layers paint, rules and scatter pick from: the material's, or the stand-in colours it draws without one.
  const palette = usePalette(p.mapping, p.palette.materials, TERRAIN_DEFAULT_COLOURS);

  useEffect(() => {
    editor?.setTarget({ entityId: p.entityId, component: c, locked: p.locked, hidden: p.hidden });
  }, [editor, p.entityId, c, p.locked, p.hidden]);
  useEffect(() => () => editor?.setTarget(null), [editor]);
  // The placed tools: a click is one command (the stamp joins the layer list; erosion runs on the backend's worker).
  const place = (at: [number, number]): void => {
    if (p.locked) return;
    if (tool === 'stamp') {
      if (stamp.asset === '') return;
      void p.run('Place stamp', 'setComponent', { entityId: p.entityId, component: 'terrain', value: { layers: layersWithStamp(c.layers ?? [], stamp, at, brushRadius(store.get())) } });
    } else if (tool === 'erode') void p.run('Erode', 'editTerrain', erodeArgs(p.entityId, erode, at, brushRadius(store.get())));
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps -- `place` is remade each render from the state listed here
  useEffect(() => editor?.setOptions({ tool, brush, store, place }), [editor, tool, brush, store, stamp, erode, c, p.entityId, p.locked, p.run]);
  // A mode without brush tools (rules, tiles) leaves the Scene view's clicks alone.
  const brushing = mode.tools.length > 0;
  useEffect(() => {
    editor?.setActive(p.visible && brushing);
    return () => editor?.setActive(false);
  }, [editor, p.visible, brushing]);

  const size = terrainTileSize(c);
  const set = (patch: Partial<TerrainBrushState>): void => setBrush((b) => ({ ...b, ...patch }));
  // The scatter brush paints a rule the terrain has (the first, until another is chosen).
  // Ground cover is never stored: the brush edits the stored rules only.
  const scatterIds = (c.scatter ?? []).filter((r) => r.cover !== true).map((r) => r.id);
  useEffect(() => {
    const ids = (c.scatter ?? []).filter((r) => r.cover !== true).map((r) => r.id);
    if (!ids.includes(brush.rule)) setBrush((b) => ({ ...b, rule: ids[0] ?? '' }));
  }, [c.scatter, brush.rule]);
  return (
    <div className="tl-blocks tl-terrain" aria-label="terrain tools">
      <div className="tl-blocks__head">
        <span className="tl-inspector__hint" aria-label="terrain size">
          {c.tiles.length} tile{c.tiles.length === 1 ? '' : 's'} of {size} m ({c.tileSamples} samples, {c.spacing} m apart), heights {c.heightRange[0]} to {c.heightRange[1]} m
        </span>
      </div>
      {brushing && (
      <>
      <Section title="Tool">
        <div className="tl-blocks__tools" role="toolbar" aria-label="terrain tool">
          {TERRAIN_TOOLS.filter((t) => mode.tools.includes(t.id)).map((t) => (
            <button key={t.id} className={`tl-btn tl-btn--small${tool === t.id ? ' is-active' : ''}`} aria-pressed={tool === t.id} title={t.title} onClick={() => setTool(t.id)}>
              {t.label}
            </button>
          ))}
        </div>
      </Section>
      {tool === 'paint' && <MaterialLayers entityId={p.entityId} entityName={p.entityName} palette={palette} active={brush.layer} onPick={(layer) => set({ layer })} host={p.palette} disabled={p.locked} />}
      <Section title="Brush" aside="Shared by every brush">
        <BrushPanel settings={settings} store={store} uses={uses} preview={mode.id === 'sculpt'} {...(TERRAIN_INVERT_LABELS[tool] !== undefined ? { invert: TERRAIN_INVERT_LABELS[tool] } : {})} />
      </Section>
      {uses.includes('mask') && (
        <Section key={`mask:${mode.id}`} title="Noise mask" open={mode.id === 'paint'} aside={<span className={`tl-tag${settings.mask.on ? ' tl-tag--ok' : ''}`}>{settings.mask.on ? 'on' : 'off'}</span>}>
          <NoiseMask settings={settings} store={store} />
        </Section>
      )}
      {tool === 'noise' && (
        <Section title="Noise">
          <SliderField label="Bump size" aria="noise size" value={brush.scale} min={0.5} max={256} log limit={[0.1, TERRAIN_BRUSH_UI.scaleMax]} step={0.1} decimals={brush.scale < 10 ? 1 : 0} unit="m" hint="The size of the noise's bumps in metres." onChange={(v) => set({ scale: v })} />
          <SliderField label="Seed" aria="noise seed" value={brush.seed} min={0} max={100} limit={[-2_147_483_647, 2_147_483_647]} step={1} hint="Another seed, other bumps." onChange={(v) => set({ seed: Math.round(v) })} />
        </Section>
      )}
      {tool === 'scatter' && (
        <Section title="Scatter rule">
          <label className="tl-frow" title="The scatter rule whose copies the brush puts on (Ctrl: takes off).">
            <span className="tl-frow__label">Rule</span>
            <select aria-label="scatter brush rule" value={brush.rule} onChange={(e) => set({ rule: e.target.value })}>
              {scatterIds.length === 0 && <option value="">(no scatter rules)</option>}
              {scatterIds.map((id) => (
                <option key={id} value={id}>
                  {id}
                </option>
              ))}
            </select>
          </label>
        </Section>
      )}
      {tool === 'stamp' && (
        <Section title="Stamp">
          <StampOptions stamp={stamp} set={(x) => setStamp((s) => ({ ...s, ...x }))} layers={(c.layers ?? []).filter((l) => l.kind === 'stamps').map((l) => l.id)} />
        </Section>
      )}
      {tool === 'erode' && (
        <Section title="Erode">
          <ErodeOptions erode={erode} set={(x) => setErode((s) => ({ ...s, ...x }))} />
        </Section>
      )}
      </>
      )}
      {mode.id === 'tiles' && (
      <div className="tl-blocks__opts">
        <button className="tl-btn tl-btn--small" aria-expanded={importOpen} onClick={() => setImportOpen((o) => !o)}>
          Import heightmap…
        </button>
        <label title="Lay a block layer's surface (its corner heights) and paint onto the terrain; cells over empty columns become holes. The block layer is not changed.">
          From block layer{' '}
          <select aria-label="convert source" value={source} onChange={(e) => setSource(e.target.value)}>
            <option value="">(choose)</option>
            {p.blockLayers.map((l) => (
              <option key={l.entityId} value={l.entityId}>
                {l.name}
              </option>
            ))}
          </select>
        </label>
        <button className="tl-btn tl-btn--small" aria-label="convert block layer" disabled={source === ''} onClick={() => void p.run('Convert block layer', 'editTerrain', { entityId: p.entityId, kind: 'fromBlocks', source })}>
          Convert
        </button>
      </div>
      )}
      {/* The edit layers the heights are combined from: stamps, erosion and the splines over the hand-made ground. */}
      {mode.id === 'stack' && <TerrainLayersPanel entityId={p.entityId} component={c} disabled={p.locked} run={p.run} />}
      {/* Material layers painted by slope, height, cavity and noise (baked into the tiles; hand paint stays over them). */}
      {mode.id === 'rules' && <SurfaceRulesEditor rules={c.rules ?? []} blocks={false} disabled={p.locked} layerField={(value, onChange, aria) => <LayerPicker layers={palette.layers} value={value} onChange={onChange} aria={aria} title="Layer for this rule" {...(palette.source.kind !== 'none' ? { material: palette.source.material.name } : {})} thumbnails={p.palette.thumbnails} disabled={p.locked} />} onApply={(rules) => p.run('Bake material rules', 'editTerrain', { entityId: p.entityId, kind: 'bake', rules })} />}
      {/* Models placed by density, slope, height, layer and noise (baked into the tiles; the Scatter brush's hand edits stay over them). */}
      {mode.id === 'scatter' && <ScatterRulesEditor rules={c.scatter ?? []} blocks={false} disabled={p.locked} onApply={(scatter) => p.run('Bake scatter rules', 'editTerrain', { entityId: p.entityId, kind: 'bake', scatter })} />}
      {mode.id === 'tiles' && importOpen && <HeightmapImport entityId={p.entityId} component={c} run={p.run} stage={p.stage} onDone={() => setImportOpen(false)} />}
    </div>
  );
}

/** The heightmap import dialog: the file, its form, where it starts and the heights it stands for. */
function HeightmapImport(p: { entityId: string; component: TerrainComponent; run: Props['run']; stage: Props['stage']; onDone: () => void }): JSX.Element {
  const [file, setFile] = useState<File | null>(null);
  const [format, setFormat] = useState<HeightmapFormat>('png16');
  const [size, setSize] = useState<[number, number]>([p.component.tileSamples, p.component.tileSamples]);
  const [byteOrder, setByteOrder] = useState<'little' | 'big'>('little');
  const [at, setAt] = useState<[number, number]>([0, 0]);
  const [range, setRange] = useState<[number, number]>([p.component.heightRange[0], p.component.heightRange[1]]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const choose = (f: File | null): void => {
    setFile(f);
    if (f === null) return;
    const raw = /\.(raw|r16|bin)$/i.test(f.name);
    setFormat(raw ? 'raw16' : 'png16');
    // A square RAW file names its own size (2 bytes a sample).
    if (raw) {
      const side = Math.round(Math.sqrt(f.size / 2));
      if (side * side * 2 === f.size) setSize([side, side]);
    }
  };
  const submit = async (): Promise<void> => {
    if (file === null) return;
    if (!(range[0] < range[1])) return setError('The low height must be below the high one.');
    setBusy(true);
    setError(null);
    try {
      const stageId = await p.stage(new Uint8Array(await file.arrayBuffer()));
      if (stageId === null) return;
      const args: Record<string, unknown> = { entityId: p.entityId, kind: 'import', stageId, format, at, range };
      if (format === 'raw16') {
        args['size'] = size;
        args['byteOrder'] = byteOrder;
      }
      if (await p.run('Import heightmap', 'editTerrain', args)) p.onDone();
    } finally {
      setBusy(false);
    }
  };
  const coord = (v: string): number => Math.round(clampNum(Number(v), -TERRAIN_TILE_COORD_MAX, TERRAIN_TILE_COORD_MAX, 0));
  return (
    <div className="tl-blocks__form" role="dialog" aria-label="import heightmap">
      <div className="tl-panel__title">Import heightmap</div>
      <p className="tl-inspector__hint">One pixel per sample from the chosen tile's min corner, rows going +z. Tiles it reaches are made; past the image, new tiles take its nearest edge.</p>
      <label>
        File <input aria-label="heightmap file" type="file" accept=".png,.raw,.r16,.bin" onChange={(e) => choose(e.target.files?.[0] ?? null)} />
      </label>
      <label>
        Form{' '}
        <select aria-label="heightmap format" value={format} onChange={(e) => setFormat(e.target.value as HeightmapFormat)}>
          {HEIGHTMAP_FORMATS.map((f) => (
            <option key={f} value={f}>
              {f === 'png16' ? '16-bit PNG' : 'RAW 16-bit'}
            </option>
          ))}
        </select>
      </label>
      {format === 'raw16' && (
        <>
          <label title="The RAW file's width and height in samples.">
            Size <input aria-label="raw width" type="number" className="tl-blocks__num" min={2} value={size[0]} onChange={(e) => setSize([Math.max(2, Math.round(Number(e.target.value) || 2)), size[1]])} /> ×{' '}
            <input aria-label="raw height" type="number" className="tl-blocks__num" min={2} value={size[1]} onChange={(e) => setSize([size[0], Math.max(2, Math.round(Number(e.target.value) || 2))])} />
          </label>
          <label>
            Byte order{' '}
            <select aria-label="raw byte order" value={byteOrder} onChange={(e) => setByteOrder(e.target.value as 'little' | 'big')}>
              <option value="little">little-endian</option>
              <option value="big">big-endian</option>
            </select>
          </label>
        </>
      )}
      <label title="The tile the image's first sample lies on.">
        From tile <input aria-label="import tile x" type="number" className="tl-blocks__num" step={1} value={at[0]} onChange={(e) => setAt([coord(e.target.value), at[1]])} />{' '}
        <input aria-label="import tile z" type="number" className="tl-blocks__num" step={1} value={at[1]} onChange={(e) => setAt([at[0], coord(e.target.value)])} />
      </label>
      <label title="The heights (metres above the terrain object) the image's 0 and 65535 stand for.">
        Heights <input aria-label="import low" type="number" className="tl-blocks__num" step={1} value={range[0]} onChange={(e) => setRange([Number(e.target.value), range[1]])} /> to{' '}
        <input aria-label="import high" type="number" className="tl-blocks__num" step={1} value={range[1]} onChange={(e) => setRange([range[0], Number(e.target.value)])} /> m
      </label>
      {error !== null && <p className="tl-inspector__error">{error}</p>}
      <div className="tl-inspector__modes">
        <button className="tl-btn tl-btn--small" aria-label="import" disabled={file === null || busy} onClick={() => void submit()}>
          {busy ? 'Importing…' : 'Import'}
        </button>
        <button className="tl-btn tl-btn--small" onClick={p.onDone}>
          Cancel
        </button>
      </div>
    </div>
  );
}

/** The Stamp tool's settings: the heightmap, its height, turn, how it meets the ground, its edge fade, the layer. */
function StampOptions(p: { stamp: StampToolState; set: (x: Partial<StampToolState>) => void; layers: readonly string[] }): JSX.Element {
  const s = p.stamp;
  return (
    <div className="tl-blocks__opts" role="group" aria-label="stamp options">
      <label title="The texture whose first channel (a 16- or 8-bit greyscale PNG) is the stamp's shape: white is its height, black 0.">
        Heightmap <RefPicker aria="stamp heightmap" kinds={['texture']} value={s.asset} none={null} onPick={(v) => p.set({ asset: v })} />
      </label>
      {s.asset === '' && <span className="tl-inspector__hint">Choose a heightmap, then click the terrain.</span>}
      <SliderField label="Height" aria="stamp height" value={s.height} min={-100} max={100} limit={[-10_000, 10_000]} step={1} unit="m" hint="Metres the image's white stands for (negative digs)." onChange={(v) => p.set({ height: v })} />
      <SliderField label="Turn" aria="stamp rotation" value={s.rotation} min={-180} max={180} limit={[-360, 360]} step={15} unit="°" hint="Degrees the image turns about +y." onChange={(v) => p.set({ rotation: v })} />
      <label title="add: raised by the shape; max: raised up to it; min: cut down to it.">
        Mode{' '}
        <select aria-label="stamp mode" value={s.mode} onChange={(e) => p.set({ mode: e.target.value as TerrainStampMode })}>
          {TERRAIN_STAMP_MODES.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
      </label>
      <SliderField label="Edge fade" aria="stamp falloff" value={s.falloff} min={0} max={0.5} step={0.05} hint="The share of the side over which the stamp fades in from its edges." onChange={(v) => p.set({ falloff: v })} />
      <label title="The stamps layer the stamp goes into (none yet: a new one).">
        Layer{' '}
        <select aria-label="stamp layer" value={s.layer} onChange={(e) => p.set({ layer: e.target.value })}>
          <option value="">{p.layers.length === 0 ? '(new stamps layer)' : '(first stamps layer)'}</option>
          {p.layers.map((id) => (
            <option key={id} value={id}>
              {id}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}

/** The Erode tool's settings: hydraulic (droplets, how fast they take and drop ground) and thermal (passes, angle of repose). */
function ErodeOptions(p: { erode: ErodeToolState; set: (x: Partial<ErodeToolState>) => void }): JSX.Element {
  const e = p.erode;
  const L = EROSION_LIMITS;
  return (
    <div className="tl-blocks__opts" role="group" aria-label="erode options">
      <label title="Water droplets run downhill, take up ground and drop it where they slow: channels and fans.">
        <input type="checkbox" aria-label="erode hydraulic" checked={e.hydraulic} onChange={(x) => p.set({ hydraulic: x.target.checked })} /> Hydraulic
      </label>
      <SliderField label="Droplets" aria="erode droplets" value={e.droplets} min={0.05} max={L.droplets[1]} limit={[0.01, L.droplets[1]]} step={0.05} disabled={!e.hydraulic} hint="Droplets per sample of the square." onChange={(v) => p.set({ droplets: v })} />
      <SliderField label="Erosion" aria="erode erosion" value={e.erosion} min={0.01} max={1} step={0.05} disabled={!e.hydraulic} hint="How fast a droplet takes up ground." onChange={(v) => p.set({ erosion: v })} />
      <SliderField label="Deposition" aria="erode deposition" value={e.deposition} min={0.01} max={1} step={0.05} disabled={!e.hydraulic} hint="How fast it drops what it carries past its capacity." onChange={(v) => p.set({ deposition: v })} />
      <label title="Ground slides off slopes steeper than the angle of repose: screes and softened ridges.">
        <input type="checkbox" aria-label="erode thermal" checked={e.thermal} onChange={(x) => p.set({ thermal: x.target.checked })} /> Thermal
      </label>
      <SliderField label="Passes" aria="erode passes" value={e.iterations} min={1} max={L.iterations[1]} step={1} disabled={!e.thermal} hint="Passes over the square." onChange={(v) => p.set({ iterations: Math.round(v) })} />
      <SliderField label="Angle" aria="erode talus" value={e.talus} min={L.talus[0]} max={L.talus[1]} step={1} unit="°" disabled={!e.thermal} hint="The angle of repose: steeper slopes shed ground." onChange={(v) => p.set({ talus: v })} />
      <SliderField label="Seed" aria="erode seed" value={e.seed} min={0} max={100} limit={[-2_147_483_647, 2_147_483_647]} step={1} hint="Another seed, other droplets." onChange={(v) => p.set({ seed: Math.round(v) })} />
    </div>
  );
}

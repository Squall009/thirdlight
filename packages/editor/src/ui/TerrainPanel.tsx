/**
 * A terrain's tools — terrain editing in the Scene view, shown in the
 * Inspector while a terrain is selected (as a block layer's tools are).
 *
 * - Tools: raise, lower, smooth, flatten, noise, ramp, paint, holes; Ctrl
 *   (or the invert toggle) lowers, erases hand paint or fills holes for one
 *   stroke.
 * - Brush: radius, strength (metres for raise, lower and noise; a blend for
 *   the others), falloff, the painted layer, the noise's size and seed.
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
import { BRUSH_FALLOFFS, EROSION_LIMITS, HEIGHTMAP_FORMATS, TERRAIN_LAYER_MAX, TERRAIN_STAMP_MODES, TERRAIN_TILE_COORD_MAX, terrainTileSize, type BrushFalloff, type HeightmapFormat, type TerrainComponent, type TerrainStampMode } from '@thirdlight/runtime';
import { TERRAIN_DEFAULT_COLOURS } from '@thirdlight/three-adapter';
import { DEFAULT_ERODE_TOOL, DEFAULT_STAMP_TOOL, DEFAULT_TERRAIN_BRUSH, TERRAIN_BRUSH_UI, TERRAIN_TOOLS, erodeArgs, layersWithStamp, type ErodeToolState, type StampToolState, type TerrainBrushState, type TerrainToolId } from '../session/terrain-brush';
import type { TerrainEditor } from '../viewport/terrain-editor';
import { SurfaceRulesEditor } from './SurfaceRulesEditor';
import { ScatterRulesEditor } from './ScatterRulesEditor';
import { TerrainLayersPanel } from './TerrainLayersPanel';
import { RefPicker } from './catalog/RefPicker';

interface Props {
  editor: TerrainEditor | null;
  /** The tools are in front (the Inspector shows them over the default view; they are armed only then). */
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
}

/** Layers the picker shows as buttons (any other is typed in). */
const PICKER_LAYERS = 8;

const clampNum = (v: number, lo: number, hi: number, fallback: number): number => (Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : fallback);

export function TerrainPanel(p: Props): JSX.Element {
  const [armed, setArmed] = useState(true);
  const [tool, setTool] = useState<TerrainToolId>('raise');
  const [brush, setBrush] = useState<TerrainBrushState>(DEFAULT_TERRAIN_BRUSH);
  const [invert, setInvert] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [rulesOpen, setRulesOpen] = useState(false);
  const [scatterOpen, setScatterOpen] = useState(false);
  const [layersOpen, setLayersOpen] = useState(false);
  const [stamp, setStamp] = useState<StampToolState>(DEFAULT_STAMP_TOOL);
  const [erode, setErode] = useState<ErodeToolState>(DEFAULT_ERODE_TOOL);
  const [source, setSource] = useState('');
  const editor = p.editor;
  const c = p.component;

  useEffect(() => {
    editor?.setTarget({ entityId: p.entityId, component: c, locked: p.locked, hidden: p.hidden });
  }, [editor, p.entityId, c, p.locked, p.hidden]);
  useEffect(() => () => editor?.setTarget(null), [editor]);
  // The placed tools: a click is one command (the stamp joins the layer list; erosion runs on the backend's worker).
  const place = (at: [number, number]): void => {
    if (p.locked) return;
    if (tool === 'stamp') {
      if (stamp.asset === '') return;
      void p.run('Place stamp', 'setComponent', { entityId: p.entityId, component: 'terrain', value: { layers: layersWithStamp(c.layers ?? [], stamp, at, brush.radius) } });
    } else if (tool === 'erode') void p.run('Erode', 'editTerrain', erodeArgs(p.entityId, erode, at, brush.radius));
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps -- `place` is remade each render from the state listed here
  useEffect(() => editor?.setOptions({ tool, brush, invert, place }), [editor, tool, brush, invert, stamp, erode, c, p.entityId, p.locked, p.run]);
  useEffect(() => {
    editor?.setActive(p.visible && armed);
    return () => editor?.setActive(false);
  }, [editor, p.visible, armed]);

  const size = terrainTileSize(c);
  const metres = tool === 'raise' || tool === 'lower' || tool === 'noise';
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
        <label title="Edit the terrain in the Scene view (Alt+drag or the right button orbits)">
          <input type="checkbox" aria-label="edit terrain" checked={armed} onChange={(e) => setArmed(e.target.checked)} /> Edit terrain
        </label>
      </div>
      <div className="tl-blocks__tools" role="toolbar" aria-label="terrain tool">
        {TERRAIN_TOOLS.map((t) => (
          <button key={t.id} className={`tl-btn tl-btn--small${tool === t.id ? ' is-active' : ''}`} aria-pressed={tool === t.id} title={t.title} onClick={() => setTool(t.id)}>
            {t.label}
          </button>
        ))}
      </div>
      <div className="tl-blocks__opts">
        <label title="The brush's radius in metres.">
          Radius <input aria-label="terrain radius" type="number" className="tl-blocks__num" min={TERRAIN_BRUSH_UI.radiusMin} max={TERRAIN_BRUSH_UI.radiusMax} step={0.5} value={brush.radius} onChange={(e) => set({ radius: clampNum(Number(e.target.value), TERRAIN_BRUSH_UI.radiusMin, TERRAIN_BRUSH_UI.radiusMax, brush.radius) })} />
        </label>
        {tool !== 'holes' && tool !== 'scatter' && tool !== 'stamp' && tool !== 'erode' &&
          (metres ? (
            <label title="Metres a dab moves the ground at its centre.">
              Strength <input aria-label="terrain strength" type="number" className="tl-blocks__num" min={0.01} max={TERRAIN_BRUSH_UI.heightMax} step={0.1} value={brush.height} onChange={(e) => set({ height: clampNum(Number(e.target.value), 0.01, TERRAIN_BRUSH_UI.heightMax, brush.height) })} />
            </label>
          ) : (
            <label title="How far toward the target (the neighbours, the level, the slope, the layer) a dab goes at its centre (0-1).">
              Strength <input aria-label="terrain blend" type="number" className="tl-blocks__num" min={0.01} max={1} step={0.05} value={brush.blend} onChange={(e) => set({ blend: clampNum(Number(e.target.value), 0.01, 1, brush.blend) })} />
            </label>
          ))}
        {tool === 'scatter' && (
          <label title="The scatter rule whose copies the brush puts on (Ctrl: takes off).">
            Rule{' '}
            <select aria-label="scatter brush rule" value={brush.rule} onChange={(e) => set({ rule: e.target.value })}>
              {scatterIds.length === 0 && <option value="">(no scatter rules)</option>}
              {scatterIds.map((id) => (
                <option key={id} value={id}>
                  {id}
                </option>
              ))}
            </select>
          </label>
        )}
        {tool !== 'holes' && tool !== 'scatter' && tool !== 'stamp' && tool !== 'erode' && (
          <label title="How the brush fades toward its edge: smooth, linear, or constant (a hard edge).">
            Falloff{' '}
            <select aria-label="terrain falloff" value={brush.falloff} onChange={(e) => set({ falloff: e.target.value as BrushFalloff })}>
              {BRUSH_FALLOFFS.map((f) => (
                <option key={f} value={f}>
                  {f}
                </option>
              ))}
            </select>
          </label>
        )}
        {tool === 'noise' && (
          <>
            <label title="The size of the noise's bumps in metres.">
              Size <input aria-label="noise size" type="number" className="tl-blocks__num" min={0.1} max={TERRAIN_BRUSH_UI.scaleMax} step={1} value={brush.scale} onChange={(e) => set({ scale: clampNum(Number(e.target.value), 0.1, TERRAIN_BRUSH_UI.scaleMax, brush.scale) })} />
            </label>
            <label title="The noise's seed (another seed, other bumps).">
              Seed <input aria-label="noise seed" type="number" className="tl-blocks__num" step={1} value={brush.seed} onChange={(e) => set({ seed: Math.trunc(Number(e.target.value) || 0) })} />
            </label>
          </>
        )}
        <label title="Lower (raise), erase hand paint back toward the baked layers (paint), fill holes (holes) or take copies off (scatter); Ctrl held flips it for one stroke.">
          <input type="checkbox" aria-label="terrain invert" checked={invert} onChange={(e) => setInvert(e.target.checked)} /> Lower / erase / fill
        </label>
      </div>
      {tool === 'stamp' && <StampOptions stamp={stamp} set={(x) => setStamp((s) => ({ ...s, ...x }))} layers={(c.layers ?? []).filter((l) => l.kind === 'stamps').map((l) => l.id)} />}
      {tool === 'erode' && <ErodeOptions erode={erode} set={(x) => setErode((s) => ({ ...s, ...x }))} />}
      {tool === 'paint' && (
        <div className="tl-blocks__palette" role="radiogroup" aria-label="terrain layer">
          {Array.from({ length: PICKER_LAYERS }, (_v, i) => (
            <button key={i} className={`tl-blocks__type${brush.layer === i ? ' is-active' : ''}`} role="radio" aria-checked={brush.layer === i} aria-label={`layer ${i}`} title={`Layer ${i} (the material's layer ${i}; its colour without a material)`} onClick={() => set({ layer: i })}>
              <span className="tl-blocks__swatch" style={{ background: TERRAIN_DEFAULT_COLOURS[i % TERRAIN_DEFAULT_COLOURS.length] }} />
              <span>{i}</span>
            </button>
          ))}
          <label title="Any layer of the material (0-255).">
            Layer <input aria-label="terrain layer number" type="number" className="tl-blocks__num" min={0} max={TERRAIN_LAYER_MAX} step={1} value={brush.layer} onChange={(e) => set({ layer: Math.round(clampNum(Number(e.target.value), 0, TERRAIN_LAYER_MAX, brush.layer)) })} />
          </label>
        </div>
      )}
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
      <div className="tl-blocks__opts">
        <button className="tl-btn tl-btn--small" aria-expanded={rulesOpen} title="Paint the material layers by slope, height, cavity and noise (baked into the tiles; hand paint stays over them)" onClick={() => setRulesOpen((o) => !o)}>
          Material rules{(c.rules?.length ?? 0) > 0 ? ` (${c.rules!.length})` : ''}…
        </button>
        <button className="tl-btn tl-btn--small" aria-expanded={layersOpen} title="The edit layers the heights are combined from: stamps, erosion and the splines over the hand-made ground" onClick={() => setLayersOpen((o) => !o)}>
          Layers{(c.layers?.length ?? 0) > 0 ? ` (${c.layers!.length})` : ''}…
        </button>
        <button className="tl-btn tl-btn--small" aria-expanded={scatterOpen} title="Place models (trees, rocks) by density, slope, height, layer and noise (baked into the tiles; the Scatter brush's hand edits stay over them)" onClick={() => setScatterOpen((o) => !o)}>
          Scatter rules{(c.scatter?.length ?? 0) > 0 ? ` (${c.scatter!.length})` : ''}…
        </button>
      </div>
      {layersOpen && <TerrainLayersPanel entityId={p.entityId} component={c} disabled={p.locked} run={p.run} />}
      {rulesOpen && <SurfaceRulesEditor rules={c.rules ?? []} blocks={false} disabled={p.locked} onApply={(rules) => p.run('Bake material rules', 'editTerrain', { entityId: p.entityId, kind: 'bake', rules })} />}
      {scatterOpen && <ScatterRulesEditor rules={c.scatter ?? []} blocks={false} disabled={p.locked} onApply={(scatter) => p.run('Bake scatter rules', 'editTerrain', { entityId: p.entityId, kind: 'bake', scatter })} />}
      {importOpen && <HeightmapImport entityId={p.entityId} component={c} run={p.run} stage={p.stage} onDone={() => setImportOpen(false)} />}
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
      <label title="Metres the image's white stands for (negative digs).">
        Height <input aria-label="stamp height" type="number" className="tl-blocks__num" step={1} value={s.height} onChange={(e) => p.set({ height: clampNum(Number(e.target.value), -10_000, 10_000, s.height) })} />
      </label>
      <label title="Degrees the image turns about +y.">
        Turn <input aria-label="stamp rotation" type="number" className="tl-blocks__num" step={15} value={s.rotation} onChange={(e) => p.set({ rotation: clampNum(Number(e.target.value), -360, 360, s.rotation) })} />
      </label>
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
      <label title="The share of the side over which the stamp fades in from its edges (0-0.5).">
        Edge fade <input aria-label="stamp falloff" type="number" className="tl-blocks__num" min={0} max={0.5} step={0.05} value={s.falloff} onChange={(e) => p.set({ falloff: clampNum(Number(e.target.value), 0, 0.5, s.falloff) })} />
      </label>
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
      <label title="Droplets per sample of the square.">
        Droplets <input aria-label="erode droplets" type="number" className="tl-blocks__num" min={0.05} max={L.droplets[1]} step={0.1} value={e.droplets} disabled={!e.hydraulic} onChange={(x) => p.set({ droplets: clampNum(Number(x.target.value), 0.01, L.droplets[1], e.droplets) })} />
      </label>
      <label title="How fast a droplet takes up ground (0-1).">
        Erosion <input aria-label="erode erosion" type="number" className="tl-blocks__num" min={0.01} max={1} step={0.05} value={e.erosion} disabled={!e.hydraulic} onChange={(x) => p.set({ erosion: clampNum(Number(x.target.value), 0.01, 1, e.erosion) })} />
      </label>
      <label title="How fast it drops what it carries past its capacity (0-1).">
        Deposition <input aria-label="erode deposition" type="number" className="tl-blocks__num" min={0.01} max={1} step={0.05} value={e.deposition} disabled={!e.hydraulic} onChange={(x) => p.set({ deposition: clampNum(Number(x.target.value), 0.01, 1, e.deposition) })} />
      </label>
      <label title="Ground slides off slopes steeper than the angle of repose: screes and softened ridges.">
        <input type="checkbox" aria-label="erode thermal" checked={e.thermal} onChange={(x) => p.set({ thermal: x.target.checked })} /> Thermal
      </label>
      <label title="Passes over the square.">
        Passes <input aria-label="erode passes" type="number" className="tl-blocks__num" min={1} max={L.iterations[1]} step={1} value={e.iterations} disabled={!e.thermal} onChange={(x) => p.set({ iterations: Math.round(clampNum(Number(x.target.value), 1, L.iterations[1], e.iterations)) })} />
      </label>
      <label title="The angle of repose in degrees: steeper slopes shed ground.">
        Angle <input aria-label="erode talus" type="number" className="tl-blocks__num" min={L.talus[0]} max={L.talus[1]} step={1} value={e.talus} disabled={!e.thermal} onChange={(x) => p.set({ talus: clampNum(Number(x.target.value), L.talus[0], L.talus[1], e.talus) })} />
      </label>
      <label title="Another seed, other droplets.">
        Seed <input aria-label="erode seed" type="number" className="tl-blocks__num" step={1} value={e.seed} onChange={(x) => p.set({ seed: Math.trunc(Number(x.target.value) || 0) })} />
      </label>
    </div>
  );
}

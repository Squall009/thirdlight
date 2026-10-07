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
 *
 * A stroke is one `editTerrain` (the Scene view's `TerrainEditor`), as is an
 * import or a conversion — one undo step each.
 *
 * Browser-only (React).
 */
import { useEffect, useState, type JSX } from 'react';
import { BRUSH_FALLOFFS, HEIGHTMAP_FORMATS, TERRAIN_LAYER_MAX, TERRAIN_TILE_COORD_MAX, terrainTileSize, type BrushFalloff, type HeightmapFormat, type TerrainComponent } from '@thirdlight/runtime';
import { TERRAIN_DEFAULT_COLOURS } from '@thirdlight/three-adapter';
import { DEFAULT_TERRAIN_BRUSH, TERRAIN_BRUSH_UI, TERRAIN_TOOLS, type TerrainBrushState, type TerrainToolId } from '../session/terrain-brush';
import type { TerrainEditor } from '../viewport/terrain-editor';
import { SurfaceRulesEditor } from './SurfaceRulesEditor';

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
  const [source, setSource] = useState('');
  const editor = p.editor;
  const c = p.component;

  useEffect(() => {
    editor?.setTarget({ entityId: p.entityId, component: c, locked: p.locked, hidden: p.hidden });
  }, [editor, p.entityId, c, p.locked, p.hidden]);
  useEffect(() => () => editor?.setTarget(null), [editor]);
  useEffect(() => editor?.setOptions({ tool, brush, invert }), [editor, tool, brush, invert]);
  useEffect(() => {
    editor?.setActive(p.visible && armed);
    return () => editor?.setActive(false);
  }, [editor, p.visible, armed]);

  const size = terrainTileSize(c);
  const metres = tool === 'raise' || tool === 'lower' || tool === 'noise';
  const set = (patch: Partial<TerrainBrushState>): void => setBrush((b) => ({ ...b, ...patch }));
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
        {tool !== 'holes' &&
          (metres ? (
            <label title="Metres a dab moves the ground at its centre.">
              Strength <input aria-label="terrain strength" type="number" className="tl-blocks__num" min={0.01} max={TERRAIN_BRUSH_UI.heightMax} step={0.1} value={brush.height} onChange={(e) => set({ height: clampNum(Number(e.target.value), 0.01, TERRAIN_BRUSH_UI.heightMax, brush.height) })} />
            </label>
          ) : (
            <label title="How far toward the target (the neighbours, the level, the slope, the layer) a dab goes at its centre (0-1).">
              Strength <input aria-label="terrain blend" type="number" className="tl-blocks__num" min={0.01} max={1} step={0.05} value={brush.blend} onChange={(e) => set({ blend: clampNum(Number(e.target.value), 0.01, 1, brush.blend) })} />
            </label>
          ))}
        {tool !== 'holes' && (
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
        <label title="Lower (raise), erase hand paint back toward the baked layers (paint) or fill holes (holes); Ctrl held flips it for one stroke.">
          <input type="checkbox" aria-label="terrain invert" checked={invert} onChange={(e) => setInvert(e.target.checked)} /> Lower / erase / fill
        </label>
      </div>
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
      </div>
      {rulesOpen && <SurfaceRulesEditor rules={c.rules ?? []} blocks={false} disabled={p.locked} onApply={(rules) => p.run('Bake material rules', 'editTerrain', { entityId: p.entityId, kind: 'bake', rules })} />}
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

/**
 * The terrain editor's Tiles mode: the tile grid drawn in the view — click
 * an empty square beside the terrain to add a tile there (it carries on from
 * its neighbours' edges: `editTerrain` addTiles), click a tile to pick it and
 * remove it — and the ways to bring ground in: a 16-bit heightmap laid onto
 * the tiles from a tile on (the picked one by default), or a block layer's
 * surface converted. Each is one command, one undo step.
 *
 * Browser-only (React).
 */
import { useState, type JSX } from 'react';
import { HEIGHTMAP_FORMATS, TERRAIN_TILE_COORD_MAX, terrainTileSize, type HeightmapFormat } from '@thirdlight/runtime';

import { Section, Segmented } from '../editmode/controls';
import { useEditStatus } from '../editmode/edit-status';
import { Glyph } from '../editmode/glyphs';
import { useTerrainTool, useTerrainToolState, type TerrainColumnProps } from './terrain-column';

export function TilesColumn(p: TerrainColumnProps): JSX.Element {
  const [state, setState] = useTerrainToolState(p.entityId);
  const c = p.component;
  const picked = state.pickedTile !== null && c.tiles.some((t) => t.x === state.pickedTile![0] && t.z === state.pickedTile![1]) ? state.pickedTile : null;
  useTerrainTool(p, 'tiles', {
    pickedTile: picked,
    onTile: (cell) => {
      if (cell.kind === 'tile') setState({ pickedTile: [cell.x, cell.z] });
      else if (!p.locked) void p.run('Add tile', 'editTerrain', { entityId: p.entityId, kind: 'addTiles', tiles: [[cell.x, cell.z]] }).then((ok) => ok && setState({ pickedTile: [cell.x, cell.z] }));
    },
  });
  const size = terrainTileSize(c);
  const remove = (): void => {
    if (picked === null) return;
    setState({ pickedTile: null });
    void p.run('Remove tile', 'setComponent', { entityId: p.entityId, component: 'terrain', value: { tiles: c.tiles.filter((t) => !(t.x === picked[0] && t.z === picked[1])) } });
  };
  useEditStatus({ tool: 'Tiles', text: picked === null ? 'Click an empty square (+) beside the terrain to add a tile there; click a tile to pick it.' : `Tile ${picked[0]}, ${picked[1]} picked: remove it, or import a heightmap onto it.`, right: `${c.tiles.length} tile${c.tiles.length === 1 ? '' : 's'} of ${size} m` });
  return (
    <div className="tl-terrain" aria-label="terrain tools">
      <Section title="Tiles" aside={`${c.tiles.length} × ${size} m`}>
        <p className="tl-hint">Each tile is {size} m square ({c.tileSamples} samples, {c.spacing} m apart). A new tile carries the ground on from its neighbours' edges.</p>
        <div className="tl-frow" aria-label="picked tile">
          <span className="tl-frow__label">Picked tile</span>
          <span>{picked === null ? 'none' : `${picked[0]}, ${picked[1]}`}</span>
          <span className="tl-emh__spacer" />
          <button type="button" className="tl-btn tl-btn--small" aria-label="remove tile" title="Remove the picked tile (undo brings it back)" disabled={picked === null || p.locked || c.tiles.length <= 1} onClick={remove}>
            <Glyph name="trash" size={14} /> Remove
          </button>
        </div>
      </Section>
      <Section title="Import heightmap">
        <HeightmapImport p={p} at={picked} />
      </Section>
      <Section title="From a block layer" open={p.blockLayers.length > 0}>
        <ConvertBlocks p={p} />
      </Section>
    </div>
  );
}

const coord = (v: string): number => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.max(-TERRAIN_TILE_COORD_MAX, Math.min(TERRAIN_TILE_COORD_MAX, n)) : 0;
};

/** The heightmap import: the file, its form, where it starts and the heights its 0 and 65535 stand for. */
function HeightmapImport({ p, at: picked }: { p: TerrainColumnProps; at: readonly [number, number] | null }): JSX.Element {
  const c = p.component;
  const [file, setFile] = useState<File | null>(null);
  const [format, setFormat] = useState<HeightmapFormat>('png16');
  const [size, setSize] = useState<[number, number]>([c.tileSamples, c.tileSamples]);
  const [byteOrder, setByteOrder] = useState<'little' | 'big'>('little');
  const [at, setAt] = useState<[number, number] | null>(null);
  const [range, setRange] = useState<[number, number]>([c.heightRange[0], c.heightRange[1]]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const from: [number, number] = at ?? (picked !== null ? [picked[0], picked[1]] : [0, 0]);
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
      const args: Record<string, unknown> = { entityId: p.entityId, kind: 'import', stageId, format, at: from, range };
      if (format === 'raw16') {
        args['size'] = size;
        args['byteOrder'] = byteOrder;
      }
      if (await p.run('Import heightmap', 'editTerrain', args)) setFile(null);
    } finally {
      setBusy(false);
    }
  };
  const num = (aria: string, value: number, set: (v: string) => void, title?: string): JSX.Element => <input className="tl-num" aria-label={aria} title={title} type="text" inputMode="numeric" value={value} onChange={(e) => set(e.target.value)} />;
  return (
    <div role="group" aria-label="import heightmap" className="tl-sec__stack">
      <p className="tl-hint">One pixel per sample from the tile's corner, rows going +z. Tiles it reaches are made; past the image they take its nearest edge.</p>
      <label className="tl-file">
        <Glyph name="import" size={16} />
        <span>{file === null ? 'Choose a 16-bit PNG or RAW file…' : file.name}</span>
        <input aria-label="heightmap file" type="file" accept=".png,.raw,.r16,.bin" onChange={(e) => choose(e.target.files?.[0] ?? null)} />
      </label>
      <div className="tl-frow">
        <span className="tl-frow__label">Form</span>
        <Segmented small aria="heightmap format" value={format} options={HEIGHTMAP_FORMATS.map((f) => ({ id: f, label: f === 'png16' ? '16-bit PNG' : 'RAW 16-bit' }))} onChange={setFormat} />
      </div>
      {format === 'raw16' && (
        <>
          <div className="tl-frow" title="The RAW file's width and height in samples.">
            <span className="tl-frow__label">Size</span>
            {num('raw width', size[0], (v) => setSize([Math.max(2, Math.round(Number(v)) || 2), size[1]]))} ×{num('raw height', size[1], (v) => setSize([size[0], Math.max(2, Math.round(Number(v)) || 2)]))}
          </div>
          <div className="tl-frow">
            <span className="tl-frow__label">Byte order</span>
            <Segmented small aria="raw byte order" value={byteOrder} options={[{ id: 'little', label: 'Little-endian' }, { id: 'big', label: 'Big-endian' }]} onChange={setByteOrder} />
          </div>
        </>
      )}
      <div className="tl-frow" title="The tile the image's first sample lies on (the picked tile, unless set here).">
        <span className="tl-frow__label">From tile</span>
        {num('import tile x', from[0], (v) => setAt([coord(v), from[1]]))}
        {num('import tile z', from[1], (v) => setAt([from[0], coord(v)]))}
      </div>
      <div className="tl-frow" title="The heights (metres above the terrain object) the image's 0 and 65535 stand for.">
        <span className="tl-frow__label">Heights</span>
        {num('import low', range[0], (v) => setRange([Number(v) || 0, range[1]]))} to {num('import high', range[1], (v) => setRange([range[0], Number(v) || 0]))} m
      </div>
      {error !== null && <p className="tl-inspector__error">{error}</p>}
      <button type="button" className="tl-btn tl-btn--primary" aria-label="import" disabled={file === null || busy || p.locked} onClick={() => void submit()}>
        {busy ? 'Importing…' : 'Import'}
      </button>
    </div>
  );
}

/** A block layer's surface (its corner heights) and paint laid onto the terrain; the block layer is not changed. */
function ConvertBlocks({ p }: { p: TerrainColumnProps }): JSX.Element {
  const [source, setSource] = useState('');
  if (p.blockLayers.length === 0) return <p className="tl-hint">The scene has no block layer to convert.</p>;
  return (
    <div className="tl-sec__stack">
      <p className="tl-hint">Lay a block layer's surface (its corner heights) and paint onto the terrain; cells over empty columns become holes. The block layer is not changed.</p>
      <div className="tl-frow">
        <span className="tl-frow__label">Block layer</span>
        <select className="tl-input" aria-label="convert source" value={source} onChange={(e) => setSource(e.target.value)}>
          <option value="">(choose)</option>
          {p.blockLayers.map((l) => (
            <option key={l.entityId} value={l.entityId}>
              {l.name}
            </option>
          ))}
        </select>
      </div>
      <button type="button" className="tl-btn tl-btn--small" aria-label="convert block layer" disabled={source === '' || p.locked} onClick={() => void p.run('Convert block layer', 'editTerrain', { entityId: p.entityId, kind: 'fromBlocks', source })}>
        Convert
      </button>
    </div>
  );
}

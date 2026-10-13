/**
 * The decal editor's palette: the project's decal materials and the trim
 * sheets' decal cells as pictures (the layer palette's tiles, a cell as its
 * part of the sheet, on a checker for the alpha), filtered All · Materials ·
 * Trim cells, the picked one ringed; 1–9 pick. Under it the drop zone: an
 * image file dropped (or chosen) is imported and becomes a decal material, a
 * project texture dropped or picked in the texture browser likewise.
 *
 * `onPick` says what a pick does: in Place and Scatter it is the decal
 * placed; in Select, with decals selected, it also gives them that material.
 *
 * Browser-only (React).
 */
import { useMemo, useRef, useState, type DragEvent, type JSX } from 'react';

import { filterPalette, type DecalPaletteEntry } from '../../session/decal-editor';
import type { PaletteLayer } from '../../session/layer-palette';
import { ASSET_DRAG_TYPE, parseAssetDrag } from '../../session/placement';
import type { TileThumbnails } from '../../viewport/thumbnails';
import { Section, Segmented } from '../editmode/controls';
import { Glyph } from '../editmode/glyphs';
import { LayerPalette, Popover } from '../palette/LayerPalette';
import { TextureBrowser } from '../palette/TextureBrowser';
import type { DecalTools } from '../shell/useDecalTools';

const FILTERS = [
  { id: 'all', label: 'All' },
  { id: 'material', label: 'Materials' },
  { id: 'cell', label: 'Trim cells' },
] as const;

/** The palette's tiles of its entries (index = position in the list shown). */
export function paletteTiles(entries: readonly DecalPaletteEntry[]): PaletteLayer[] {
  return entries.map((e, i) => ({ index: i, name: e.name, texture: e.texture, checker: true, aria: `decal ${e.name}`, ...(e.crop !== undefined ? { crop: e.crop } : {}), ...(e.texture === null ? { colour: 'var(--surface-3)' } : {}), ...(e.kind === 'cell' ? { sub: 'trim cell' } : {}) }));
}

export function DecalPalette({ tools, thumbnails, onPick, active }: { tools: DecalTools; thumbnails: TileThumbnails | null; onPick: (e: DecalPaletteEntry) => void; active: string | null }): JSX.Element {
  const entries = useMemo(() => filterPalette(tools.palette, tools.paletteFilter), [tools.palette, tools.paletteFilter]);
  const tiles = useMemo(() => paletteTiles(entries), [entries]);
  const picked = entries.findIndex((e) => e.material !== null && e.material === active);
  return (
    <Section title="Decals" aside={<span className="tl-sec__note">{entries[picked]?.name ?? `${tools.palette.length} decal${tools.palette.length === 1 ? '' : 's'}`}</span>}>
      <Segmented small aria="decal palette filter" options={FILTERS} value={tools.paletteFilter} onChange={tools.setPaletteFilter} />
      {tiles.length > 0 ? (
        <LayerPalette layers={tiles} active={picked < 0 ? null : picked} onPick={(i) => entries[i] !== undefined && onPick(entries[i]!)} thumbnails={thumbnails} compact keys aria="decal palette" />
      ) : (
        <p className="tl-hint">{tools.paletteFilter === 'cell' ? 'No trim sheet has decal cells without a material.' : 'No decal materials yet: drop an image below to make one.'}</p>
      )}
      <DropZone tools={tools} thumbnails={thumbnails} />
    </Section>
  );
}

const textureDrop = (ev: DragEvent): string | null => {
  const payload = parseAssetDrag(ev.dataTransfer.getData(ASSET_DRAG_TYPE));
  return payload !== null && (payload.kind === undefined || payload.kind === 'texture') ? payload.assetId : null;
};

/** "Drop an image to make a decal material": a file from the desktop, a project texture, or one picked in the browser. */
function DropZone({ tools, thumbnails }: { tools: DecalTools; thumbnails: TileThumbnails | null }): JSX.Element {
  const [over, setOver] = useState(false);
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const file = useRef<HTMLInputElement | null>(null);
  return (
    <>
      <button
        type="button"
        className={`tl-dropzone${over ? ' is-drop' : ''}`}
        aria-label="make a decal material"
        title="Drop an image file (PNG with its shape in alpha) or a project texture here, or click to pick a texture or a file: it becomes a decal material, picked to place"
        disabled={tools.busy !== null}
        onClick={(e) => setAnchor(anchor === null ? e.currentTarget : null)}
        onDragOver={(ev) => {
          if (!ev.dataTransfer.types.includes('Files') && !ev.dataTransfer.types.includes(ASSET_DRAG_TYPE)) return;
          ev.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(ev) => {
          setOver(false);
          const f = ev.dataTransfer.files[0];
          const tex = f === undefined ? textureDrop(ev) : null;
          if (f === undefined && tex === null) return;
          ev.preventDefault();
          if (f !== undefined) void tools.fromFile(f);
          else void tools.fromTexture(tex!);
        }}
      >
        <Glyph name="plus" size={16} />
        {tools.busy ?? 'Drop an image to make a decal material'}
      </button>
      <input
        ref={file}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        hidden
        aria-label="decal image file"
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = '';
          setAnchor(null);
          if (f !== undefined) void tools.fromFile(f);
        }}
      />
      {anchor !== null && (
        <Popover anchor={anchor} onClose={() => setAnchor(null)} aria="decal image" title="A decal from a texture" aside={<button type="button" className="tl-btn tl-btn--small" onClick={() => file.current?.click()}>Choose a file…</button>}>
          <TextureBrowser
            aria="decal texture"
            value={null}
            thumbnails={thumbnails}
            autoFocus
            onPick={(id) => {
              setAnchor(null);
              void tools.fromTexture(id);
            }}
          />
        </Popover>
      )}
    </>
  );
}

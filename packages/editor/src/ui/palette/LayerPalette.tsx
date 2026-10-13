/**
 * The layer palette: a layered material's layers as tiles — each layer's
 * albedo picture (its slot texture's tile thumbnail from the backend, never
 * drawn here), its number and name, the picked one ringed in the brush
 * colour. Every editor that paints or picks material layers shows the same
 * tiles (terrain paint and rules here; vertex paint and blocks later).
 *
 * - A tile is a drop target for a texture asset dragged from the project
 *   window (it goes into that layer's slot); an empty slot and the "Add
 *   layer" tile also open a texture picker on a click.
 * - `keys`: the number keys 1–9 pick a tile (the edit modes' key map).
 * - The decal editor shows its decals on the same tiles (a trim sheet's cell
 *   as its part of the sheet's picture, on a checker for the alpha).
 * - A layer whose albedo has no height in A (the backend's check) wears a
 *   small "no height" badge: its blends are soft until a texture with one
 *   takes its place.
 * - `LayerPicker` is the compact palette in a popover behind a chip, for a
 *   field that names one layer (a material rule's).
 *
 * Browser-only (React).
 */
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type DragEvent, type JSX, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

import { paletteKeyIndex } from '../../session/edit-keys';
import type { PaletteLayer } from '../../session/layer-palette';
import { ASSET_DRAG_TYPE, assetDropOf } from '../../session/placement';
import type { TileThumbnails } from '../../viewport/thumbnails';
import { useTile } from '../assets/TileImage';
import { useAssetSummaries } from '../catalog/catalog-context';
import { Glyph } from '../editmode/glyphs';
import { isTyping } from '../workspace/EditorWindow';

export interface LayerPaletteProps {
  layers: readonly PaletteLayer[];
  /** The picked layer's index (null: none). */
  active: number | null;
  onPick?: (index: number) => void;
  /** A texture dropped on a tile (or on "Add layer": the next index). Absent: no drops. */
  onDropTexture?: (index: number, textureId: string) => void;
  /** A click on an empty slot or on "Add layer" (the next index): pick its texture. */
  onChooseTexture?: (index: number, anchor: HTMLElement) => void;
  /** Show the "Add layer" tile. */
  add?: boolean;
  thumbnails: TileThumbnails | null;
  compact?: boolean;
  disabled?: boolean;
  /** The number keys 1–9 pick a tile. */
  keys?: boolean;
  aria: string;
}

/** What a "no height" badge means, in the tile's tooltip. */
const NO_HEIGHT_HINT = 'No height in its alpha: blends with the other layers are soft, and its brightness stands in for the height. Use an albedo with height in A (Texture Designer: albedo + height export).';

const textureDrop = (ev: DragEvent): string | null => assetDropOf(ev, 'texture')?.assetId ?? null;

export function LayerPalette(p: LayerPaletteProps): JSX.Element {
  const latest = useRef(p);
  latest.current = p;
  // Captured before the shell's own keys, so a digit picks a layer and nothing else reads it.
  useEffect(() => {
    if (p.keys !== true) return undefined;
    const onKey = (e: KeyboardEvent): void => {
      const q = latest.current;
      if (e.defaultPrevented || q.disabled === true || q.onPick === undefined || isTyping(e.target) || document.querySelector('[aria-modal="true"]') !== null) return;
      const i = paletteKeyIndex(e);
      const layer = i === null ? undefined : q.layers[i];
      if (layer === undefined) return;
      e.preventDefault();
      q.onPick(layer.index);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [p.keys]);
  const n = p.layers.length + (p.add === true ? 1 : 0);
  const cls = `tl-palette${p.compact === true ? ' tl-palette--compact' : ''}${p.compact === true && n === 5 ? ' tl-palette--five' : ''}${p.disabled === true ? ' is-disabled' : ''}`;
  return (
    <div className={cls} role="radiogroup" aria-label={p.aria} aria-disabled={p.disabled === true ? true : undefined}>
      {p.layers.map((l) => (
        <LayerTile key={l.index} {...p} layer={l} picked={p.active === l.index} />
      ))}
      {p.add === true && <AddTile {...p} index={p.layers.length} />}
    </div>
  );
}

function LayerTile(p: LayerPaletteProps & { layer: PaletteLayer; picked: boolean }): JSX.Element {
  const l = p.layer;
  const [over, setOver] = useState(false);
  const thumb = useLayerThumb(l.texture, p.thumbnails);
  const drops = p.onDropTexture !== undefined && p.disabled !== true;
  return (
    <button
      type="button"
      role="radio"
      aria-checked={p.picked}
      aria-label={l.aria ?? `layer ${l.index + 1}`}
      className={`tl-ptile${p.picked ? ' is-active' : ''}${l.empty === true && l.wet !== true ? ' tl-ptile--empty' : ''}${l.wet === true ? ' tl-ptile--wet' : ''}${over ? ' is-drop' : ''}`}
      title={l.wet === true ? `${l.name}: darkens and adds shine over any layer` : l.empty === true ? `${l.name}: no texture yet (it draws the first filled layer's). Drop a texture here, or click to pick one.` : `${l.name}${l.sub !== undefined ? ` · ${l.sub}` : ''}${l.noHeight === true ? `\n${NO_HEIGHT_HINT}` : ''}`}
      disabled={p.disabled}
      data-layer={l.index}
      onClick={(e) => {
        p.onPick?.(l.index);
        if (l.empty === true) p.onChooseTexture?.(l.index, e.currentTarget);
      }}
      onDragOver={(ev) => {
        if (!drops || !ev.dataTransfer.types.includes(ASSET_DRAG_TYPE)) return;
        ev.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(ev) => {
        setOver(false);
        const id = drops ? textureDrop(ev) : null;
        if (id === null) return;
        ev.preventDefault();
        p.onDropTexture!(l.index, id);
      }}
    >
      <span className={`tl-ptile__thumb${l.checker === true ? ' tl-ptile__thumb--checker' : ''}`} data-thumb={thumb.state}>
        {l.wet === true ? <Glyph name="drop" size={20} /> : thumb.url !== null ? l.crop !== undefined ? <i className="tl-ptile__crop" style={cropStyle(thumb.url, l.crop)} /> : <img src={thumb.url} alt="" draggable={false} /> : l.colour !== undefined ? <i style={{ background: l.colour }} /> : l.empty === true ? <PlusGlyph /> : null}
      </span>
      <span className="tl-ptile__idx">{l.badge ?? l.index + 1}</span>
      {l.noHeight === true && (
        <span className="tl-ptile__badge" aria-label="no height in alpha">
          no height
        </span>
      )}
      <span className="tl-ptile__name">{l.name}</span>
      {l.sub !== undefined && <span className="tl-ptile__sub">{l.sub}</span>}
    </button>
  );
}

function AddTile(p: LayerPaletteProps & { index: number }): JSX.Element {
  const [over, setOver] = useState(false);
  const drops = p.onDropTexture !== undefined && p.disabled !== true;
  return (
    <button
      type="button"
      className={`tl-ptile tl-ptile--empty tl-ptile--add${over ? ' is-drop' : ''}`}
      aria-label="add layer"
      title="Another layer: drop a texture here, or click to pick one"
      disabled={p.disabled}
      onClick={(e) => p.onChooseTexture?.(p.index, e.currentTarget)}
      onDragOver={(ev) => {
        if (!drops || !ev.dataTransfer.types.includes(ASSET_DRAG_TYPE)) return;
        ev.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(ev) => {
        setOver(false);
        const id = drops ? textureDrop(ev) : null;
        if (id === null) return;
        ev.preventDefault();
        p.onDropTexture!(p.index, id);
      }}
    >
      <span className="tl-ptile__thumb">
        <PlusGlyph />
      </span>
      <span className="tl-ptile__name">Add layer</span>
      {p.compact !== true && <span className="tl-ptile__sub">drop a texture</span>}
    </button>
  );
}

/** A part of a picture filling the tile: the picture scaled so the part spans the tile, moved so the part shows. */
export function cropStyle(url: string, [x, y, w, h]: readonly [number, number, number, number]): CSSProperties {
  const at = (p: number, size: number): string => (size >= 1 ? '0%' : `${(p / (1 - size)) * 100}%`);
  return { backgroundImage: `url("${url}")`, backgroundSize: `${100 / Math.max(w, 1e-3)}% ${100 / Math.max(h, 1e-3)}%`, backgroundPosition: `${at(x, w)} ${at(y, h)}` };
}

function PlusGlyph(): JSX.Element {
  return (
    <svg width="22" height="22" viewBox="0 0 22 22" aria-hidden="true">
      <path d="M11 5v12M5 11h12" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

/** A slot texture's tile picture (the backend's thumbnail) and whether it is there, still coming, or not to be had. */
export function useLayerThumb(textureId: string | null, thumbnails: TileThumbnails | null): { url: string | null; state: 'ready' | 'pending' | 'none' } {
  const [summary] = useAssetSummaries(textureId === null ? [] : [textureId]);
  const { url, pending } = useTile(textureId === null ? undefined : summary, null, thumbnails);
  return { url, state: textureId === null ? 'none' : pending ? 'pending' : url !== null ? 'ready' : 'none' };
}

/**
 * A popover beside the edit mode's settings column, over the Scene view, with
 * an arrow at its anchor (it never covers the column it was opened from).
 * Esc or a press outside closes it; Esc is taken before the shell's (which
 * would leave the mode).
 */
export function Popover(p: { anchor: HTMLElement; onClose: () => void; title: ReactNode; aside?: ReactNode; aria: string; children: ReactNode }): JSX.Element {
  const box = useRef<HTMLDivElement | null>(null);
  const [place, setPlace] = useState<{ right: number; top: number; arrow: number } | null>(null);
  const latest = useRef(p);
  latest.current = p;
  useLayoutEffect(() => {
    const put = (): void => {
      const a = p.anchor.getBoundingClientRect();
      const column = p.anchor.closest('.tl-editmode__column, .tl-dock, aside')?.getBoundingClientRect() ?? a;
      const h = Math.min(box.current?.offsetHeight ?? 200, window.innerHeight - 16);
      const top = Math.max(8, Math.min(window.innerHeight - h - 8, a.top + a.height / 2 - 28));
      setPlace((was) => (was !== null && was.top === top && was.right === window.innerWidth - column.left + 10 ? was : { right: window.innerWidth - column.left + 10, top, arrow: a.top + a.height / 2 - top }));
    };
    put();
    // Its content grows (a texture browser opened in it): placed again so it stays on the screen.
    const ro = typeof ResizeObserver === 'function' && box.current !== null ? new ResizeObserver(put) : null;
    if (ro !== null && box.current !== null) ro.observe(box.current);
    return () => ro?.disconnect();
  }, [p.anchor]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      e.preventDefault();
      e.stopPropagation();
      latest.current.onClose();
    };
    const onDown = (e: PointerEvent): void => {
      const t = e.target as Node | null;
      if (t !== null && (box.current?.contains(t) === true || latest.current.anchor.contains(t))) return;
      latest.current.onClose();
    };
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('pointerdown', onDown, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('pointerdown', onDown, true);
    };
  }, []);
  return createPortal(
    <div ref={box} className="tl-pop" role="dialog" aria-label={p.aria} style={place === null ? { visibility: 'hidden', top: 0, right: 0 } : { top: place.top, right: place.right, ['--tl-pop-arrow' as string]: `${Math.max(14, place.arrow)}px` }}>
      <div className="tl-pop__title">
        <span>{p.title}</span>
        {p.aside !== undefined && <span>{p.aside}</span>}
      </div>
      {p.children}
    </div>,
    document.body,
  );
}

/** A field naming one layer: a chip with the layer's picture and name that opens the compact palette beside the column. */
export function LayerPicker(p: { layers: readonly PaletteLayer[]; value: number; onChange: (index: number) => void; aria: string; title: string; material?: string; thumbnails: TileThumbnails | null; disabled?: boolean }): JSX.Element {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const layer = p.layers.find((l) => l.index === p.value);
  const thumb = useLayerThumb(layer?.texture ?? null, p.thumbnails);
  return (
    <>
      <button
        type="button"
        className={`tl-layerchip${anchor !== null ? ' is-open' : ''}`}
        aria-label={p.aria}
        aria-expanded={anchor !== null}
        aria-haspopup="dialog"
        title={p.title}
        disabled={p.disabled}
        data-layer={p.value}
        onClick={(e) => setAnchor(anchor === null ? e.currentTarget : null)}
      >
        <span className="tl-layerchip__thumb">{thumb.url !== null ? <img src={thumb.url} alt="" /> : layer?.colour !== undefined ? <i style={{ background: layer.colour }} /> : <b>{p.value + 1}</b>}</span>
        <span className="tl-layerchip__name">{layer?.name ?? `Layer ${p.value + 1}`}</span>
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
          <path d="M2.5 4l2.5 2.5L7.5 4" fill="none" stroke="currentColor" strokeWidth="1.4" />
        </svg>
      </button>
      {anchor !== null && (
        <Popover anchor={anchor} onClose={() => setAnchor(null)} aria={`${p.aria} choices`} title={p.title} {...(p.material !== undefined ? { aside: p.material } : {})}>
          <LayerPalette
            layers={p.layers}
            active={p.value}
            compact
            thumbnails={p.thumbnails}
            aria={`${p.aria} palette`}
            onPick={(i) => {
              p.onChange(i);
              setAnchor(null);
            }}
          />
        </Popover>
      )}
    </>
  );
}

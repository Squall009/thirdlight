/**
 * The block editor's palette: the layer's block types as tiles — a picture
 * of each type's first look on its shape (a model look's tile thumbnail
 * from the backend; a stand-in drawn as a small isometric block in its
 * colour, or in its material's colour texture), its number and its name,
 * the picked one ringed in the brush colour — and a "New type" tile that a
 * model can be dropped on. The number keys 1–9 pick a tile.
 *
 * The isometric stand-in is SVG drawn here from the type's shape (full,
 * half, ramp, stairs, an edge piece's slab): never a second renderer.
 *
 * Browser-only (React).
 */
import { useEffect, useId, useRef, useState, type DragEvent, type JSX } from 'react';
import type { BlockType, MaterialDef } from '@thirdlight/project-model';

import { paletteKeyIndex } from '../../session/edit-keys';
import { LAYERED_TEXTURES } from '../../session/material-graph';
import { ASSET_DRAG_TYPE } from '../../session/placement';
import type { TileThumbnails } from '../../viewport/thumbnails';
import { useTileUrl } from '../assets/TileImage';
import { useAssetSummaries } from '../catalog/catalog-context';
import { Glyph } from '../editmode/glyphs';
import { useLayerThumb } from '../palette/LayerPalette';
import { isTyping } from '../workspace/EditorWindow';

/** The colour texture a material draws with (its map, or a layered surface's first layer), for a stand-in's picture; null: none. */
export function materialAlbedo(m: MaterialDef | undefined): string | null {
  if (m === undefined) return null;
  const map = m.params['map'];
  if (typeof map === 'string' && map !== '') return map;
  const v = (m.parameters ?? []).find((p) => p.key === LAYERED_TEXTURES.albedo)?.default;
  if (typeof v === 'string' && v !== '') return v;
  if (Array.isArray(v)) return (v as unknown[]).find((x): x is string => typeof x === 'string' && x !== '') ?? null;
  return null;
}

type P3 = readonly [number, number, number];

/** A face of the stand-in: its corners (block units, y up) and how much light it takes. */
interface IsoFace {
  readonly pts: readonly P3[];
  readonly shade: number;
}

/** The faces seen from above the +x +z corner, back to front, of a block of this shape (in a unit cell). */
function isoFaces(shape: BlockType['shape'], edge: boolean): IsoFace[] {
  const box = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): IsoFace[] => [
    { pts: [[x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1]], shade: 1 },
    { pts: [[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]], shade: 0.62 },
    { pts: [[x1, y0, z0], [x1, y0, z1], [x1, y1, z1], [x1, y1, z0]], shade: 0.8 },
  ];
  if (edge) return box(0, 0, 0.42, 1, 1, 0.58);
  if (shape === 'half') return box(0, 0, 0, 1, 0.5, 1);
  if (shape === 'stairs') return [...box(0, 0, 0, 1, 1, 0.5), ...box(0, 0, 0.5, 1, 0.5, 1)];
  if (shape === 'ramp') {
    // Rising toward −z (the editor's ramps rise along +z at rotation 0; drawn from the side that shows the slope).
    return [
      { pts: [[0, 1, 0], [1, 1, 0], [1, 0, 1], [0, 0, 1]], shade: 0.92 },
      { pts: [[1, 0, 0], [1, 0, 1], [1, 1, 0]], shade: 0.8 },
    ];
  }
  return box(0, 0, 0, 1, 1, 1);
}

const COS30 = Math.cos(Math.PI / 6);

/** An isometric picture of a stand-in block: its shape in its colour, or its material's texture on each face. */
export function IsoBlock({ shape, edge, colour, texture }: { shape: BlockType['shape']; edge: boolean; colour: string; texture: string | null }): JSX.Element {
  const id = useId();
  const s = 26;
  const at = (p: P3): [number, number] => [32 + (p[0] - p[2]) * COS30 * s, 40 + ((p[0] + p[2]) / 2 - p[1]) * s];
  const faces = isoFaces(shape, edge);
  return (
    <svg className="tl-iso-block" viewBox="0 0 64 70" aria-hidden="true">
      {faces.map((f, i) => {
        const pts = f.pts.map(at);
        // A texture spans the face: the picture's unit square mapped onto the face's first three corners.
        const [o, u, , v] = pts.length === 4 ? pts : [pts[0]!, pts[1]!, pts[2]!, pts[2]!];
        return (
          <g key={i}>
            {texture !== null && pts.length === 4 && (
              <defs>
                <pattern id={`${id}-${i}`} patternUnits="userSpaceOnUse" width="1" height="1" patternTransform={`matrix(${u![0] - o![0]} ${u![1] - o![1]} ${v![0] - o![0]} ${v![1] - o![1]} ${o![0]} ${o![1]})`}>
                  <image href={texture} width="1" height="1" preserveAspectRatio="none" />
                </pattern>
              </defs>
            )}
            <polygon points={pts.map((p) => p.join(',')).join(' ')} fill={texture !== null && pts.length === 4 ? `url(#${id}-${i})` : colour} stroke="rgba(0,0,0,.35)" strokeWidth="0.6" />
            <polygon points={pts.map((p) => p.join(',')).join(' ')} fill="#000" opacity={1 - f.shade} />
          </g>
        );
      })}
    </svg>
  );
}

/** A block type's picture: its first look (a model's thumbnail, else the stand-in drawn). */
export function BlockPicture({ t, materials, thumbnails }: { t: BlockType; materials: readonly MaterialDef[]; thumbnails: TileThumbnails | null }): JSX.Element {
  const v = t.variants[0];
  const [summary] = useAssetSummaries(v?.model !== undefined ? [v.model.assetId] : []);
  const thumb = useTileUrl(summary, v?.model?.piece ?? null, thumbnails);
  const materialId = t.materials?.['*'];
  const albedo = useLayerThumb(v?.model === undefined && v?.prefab === undefined && materialId !== undefined ? materialAlbedo(materials.find((m) => m.materialId === materialId)) : null, thumbnails);
  if (thumb !== null) return <img className="tl-bpal__img" src={thumb} alt="" draggable={false} />;
  if (v?.prefab !== undefined) return <span className="tl-bpal__prefab">prefab</span>;
  return <IsoBlock shape={t.shape} edge={t.placement === 'edge'} colour={v?.color ?? '#808080'} texture={albedo.url} />;
}

export interface BlockPaletteProps {
  types: readonly BlockType[];
  active: string | null;
  onPick: (blockId: string) => void;
  /** "New type": a click makes a stand-in; a model dropped on it makes a type wearing it. */
  onNew: () => void;
  onDropModel: (ev: DragEvent) => void;
  materials: readonly MaterialDef[];
  thumbnails: TileThumbnails | null;
  /** The number keys 1–9 pick a tile. */
  keys: boolean;
  disabled?: boolean;
  /** Types listed that the layer's kit does not hold (marked so). */
  outside?: ReadonlySet<string>;
}

export function BlockPalette(p: BlockPaletteProps): JSX.Element {
  const latest = useRef(p);
  latest.current = p;
  // Captured before the shell's own keys, so a digit picks a block type and nothing else reads it.
  useEffect(() => {
    if (!p.keys) return undefined;
    const onKey = (e: KeyboardEvent): void => {
      const q = latest.current;
      if (e.defaultPrevented || q.disabled === true || isTyping(e.target) || document.querySelector('[aria-modal="true"]') !== null) return;
      const i = paletteKeyIndex(e);
      const t = i === null ? undefined : q.types[i];
      if (t === undefined) return;
      e.preventDefault();
      q.onPick(t.blockId);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [p.keys]);
  const [over, setOver] = useState(false);
  return (
    <div className={`tl-bpal${p.disabled === true ? ' is-disabled' : ''}`} role="radiogroup" aria-label="block palette">
      {p.types.map((t, i) => (
        <button
          key={t.blockId}
          type="button"
          role="radio"
          aria-checked={p.active === t.blockId}
          aria-label={`block ${t.blockId}`}
          className={`tl-bpal__tile${p.active === t.blockId ? ' is-active' : ''}`}
          title={`${t.name}${p.outside?.has(t.blockId) === true ? ' (not in the kit: the layer uses it)' : ''}`}
          disabled={p.disabled}
          onClick={() => p.onPick(t.blockId)}
        >
          <span className="tl-bpal__thumb">
            <BlockPicture t={t} materials={p.materials} thumbnails={p.thumbnails} />
          </span>
          {i < 9 && <span className="tl-bpal__idx">{i + 1}</span>}
          <span className="tl-bpal__name">{t.name}</span>
          {p.outside?.has(t.blockId) === true && <span className="tl-bpal__sub">not in the kit</span>}
        </button>
      ))}
      <button
        type="button"
        className={`tl-bpal__tile tl-bpal__tile--new${over ? ' is-drop' : ''}`}
        aria-label="new block type"
        title="A new block type: click for a coloured stand-in, or drop a model from the project window or a GLB file here"
        disabled={p.disabled}
        onClick={p.onNew}
        onDragOver={(ev) => {
          if (!ev.dataTransfer.types.includes(ASSET_DRAG_TYPE) && !ev.dataTransfer.types.includes('Files')) return;
          ev.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(ev) => {
          setOver(false);
          p.onDropModel(ev);
        }}
      >
        <span className="tl-bpal__thumb">
          <Glyph name="plus" size={22} />
        </span>
        <span className="tl-bpal__name">New type</span>
        <span className="tl-bpal__sub">or drop a model</span>
      </button>
    </div>
  );
}

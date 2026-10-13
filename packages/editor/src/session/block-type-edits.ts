/**
 * The block type editor's edits, as data: each takes a block type and gives
 * the one `setBlockType` stores — a new stand-in type, a look added (a model,
 * a kit piece, a colour) or changed, the collision boxes, the turns allowed,
 * the connection pieces, a theme's swap, a default metadata value. Fields
 * that end up empty are left out, so a type keeps the stored shape the
 * engine reads as "absent".
 *
 * Pure.
 */
import type { BlockConnectLook, BlockConnectPiece, BlockType, BlockVariant, CellMetaValue } from '@thirdlight/project-model';
import { BLOCK_LIMITS } from '@thirdlight/project-model/limits';
import { BLOCK_CONNECT_PIECES, BLOCK_EDGE_CONNECT_PIECES } from '@thirdlight/runtime';

/** A free block type id from a name (`[a-z0-9-]`, numbered past those taken). */
export function newBlockId(name: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'block';
  let id = slug;
  for (let i = 2; used.has(id); i++) id = `${slug}-${i}`;
  return id;
}

/** A stand-in colour for the n-th new type: hues spread round the wheel, mid lightness. */
export function standInColour(n: number): string {
  const hue = (n * 67) % 360;
  return `#${[0, 8, 4]
    .map((k0) => {
      const k = (k0 + hue / 30) % 12;
      const c = 0.5 - 0.4 * Math.max(-1, Math.min(k - 3, 9 - k, 1));
      return Math.round(c * 255).toString(16).padStart(2, '0');
    })
    .join('')}`;
}

/** A new block type: a full stand-in in its own colour, or wearing a model (a dropped model or kit piece). */
export function newBlockType(types: readonly BlockType[], look?: BlockVariant, name?: string): BlockType {
  const label = name ?? `Block ${types.length + 1}`;
  return { blockId: newBlockId(label, types.map((t) => t.blockId)), name: label, variants: [look ?? { color: standInColour(types.length) }], shape: 'full' };
}

/** A copy of a type under a new id and name ("… copy"). */
export function duplicateBlockType(t: BlockType, types: readonly BlockType[]): BlockType {
  const name = `${t.name} copy`;
  return { ...structuredClone(t), blockId: newBlockId(name, types.map((x) => x.blockId)), name };
}

/** The type with its looks replaced (at least one is kept: a type always has a look). */
export function withVariants(t: BlockType, variants: readonly BlockVariant[]): BlockType {
  return { ...t, variants: variants.length > 0 ? [...variants].slice(0, BLOCK_LIMITS.variants) : t.variants };
}

/** A look added, up to the engine's limit of looks per type (null: the type is full). */
export function withLookAdded(t: BlockType, look: BlockVariant): BlockType | null {
  if (t.variants.length >= BLOCK_LIMITS.variants) return null;
  return { ...t, variants: [...t.variants, look] };
}

/** One look changed (`patch` fields set; undefined ones taken off). */
export function withLook(t: BlockType, index: number, patch: Partial<BlockVariant>): BlockType {
  return withVariants(
    t,
    t.variants.map((v, i) => {
      if (i !== index) return v;
      const next: BlockVariant = { ...v, ...patch };
      for (const k of Object.keys(next) as (keyof BlockVariant)[]) if (next[k] === undefined) delete next[k];
      return next;
    }),
  );
}

/** A look taken out (never the last); the connection pieces and theme looks pointing past it are dropped or moved down. */
export function withoutLook(t: BlockType, index: number): BlockType {
  if (t.variants.length <= 1) return t;
  const move = (v: number): number | null => (v === index ? null : v > index ? v - 1 : v);
  const next: BlockType = withVariants(t, t.variants.filter((_v, i) => i !== index));
  if (t.connect !== undefined) {
    const pieces: Partial<Record<BlockConnectPiece, BlockConnectLook>> = {};
    for (const [k, look] of Object.entries(t.connect.pieces)) {
      const v = look === undefined ? null : move(look.variant);
      if (v !== null) pieces[k as BlockConnectPiece] = { ...look!, variant: v };
    }
    next.connect = { ...t.connect, pieces };
  }
  return next;
}

/** The turns a type may take, as stored (all four, or an edge piece's two: absent). */
export function withRotations(t: BlockType, rotations: readonly number[]): BlockType {
  const all = t.placement === 'edge' ? [0, 180] : [0, 90, 180, 270];
  const kept = all.filter((r) => rotations.includes(r));
  const next = { ...t };
  if (kept.length === 0 || kept.length === all.length) delete next.rotations;
  else next.rotations = kept;
  return next;
}

/** The collision shape; a custom shape starts from one full box when it has none. */
export function withShape(t: BlockType, shape: BlockType['shape']): BlockType {
  const next: BlockType = { ...t, shape };
  if (shape === 'custom') next.boxes = t.boxes !== undefined && t.boxes.length > 0 ? t.boxes : [[0, 0, 0, 1, 1, 1]];
  else delete next.boxes;
  return next;
}

/** One coordinate of a custom box set (clamped to the cell; a box keeps its min below its max). */
export function withBoxValue(t: BlockType, box: number, axis: number, value: number): BlockType {
  const boxes = (t.boxes ?? []).map((b) => [...b]);
  const b = boxes[box];
  if (b === undefined) return t;
  const v = Math.min(1, Math.max(0, Math.round(value * 1000) / 1000));
  b[axis] = v;
  const lo = axis % 3;
  if (b[lo + 3]! <= b[lo]!) {
    if (axis < 3) b[lo] = Math.max(0, b[lo + 3]! - 0.01);
    else b[lo + 3] = Math.min(1, b[lo]! + 0.01);
  }
  return { ...t, boxes };
}

/** Where it stands: in its cell, or on a cell edge (a wall, door, fence: only end-for-end turns, its connection pieces those an edge has). */
export function withPlacement(t: BlockType, placement: 'cell' | 'edge'): BlockType {
  const next: BlockType = { ...t };
  if (placement === 'edge') next.placement = 'edge';
  else {
    delete next.placement;
    delete next.blocking;
  }
  return withRotations(next, t.rotations ?? [0, 90, 180, 270]);
}

/** The pieces a connected type can name for its placement. */
export const connectPiecesOf = (t: Pick<BlockType, 'placement'>): readonly BlockConnectPiece[] => (t.placement === 'edge' ? BLOCK_EDGE_CONNECT_PIECES : BLOCK_CONNECT_PIECES);

/** Joining up on or off (on: no piece named yet, so every cell keeps its look until pieces are set). */
export function withConnect(t: BlockType, on: boolean): BlockType {
  const next = { ...t };
  if (on) next.connect = t.connect ?? { pieces: {} };
  else delete next.connect;
  return next;
}

/** A piece's look (null: the ordinary look) and extra turn. */
export function withConnectPiece(t: BlockType, piece: BlockConnectPiece, variant: number | null, rot = 0): BlockType {
  const c = t.connect ?? { pieces: {} };
  const pieces = { ...c.pieces };
  if (variant === null) delete pieces[piece];
  else pieces[piece] = { variant, ...(rot !== 0 ? { rot } : {}) };
  return { ...t, connect: { ...c, pieces } };
}

/** The other types that count as connected (absent when none). */
export function withConnectWith(t: BlockType, ids: readonly string[]): BlockType {
  const c = t.connect ?? { pieces: {} };
  const next = { ...c };
  const kept = [...new Set(ids)].filter((x) => x !== t.blockId);
  if (kept.length > 0) next.with = kept;
  else delete next.with;
  return { ...t, connect: next };
}

/** A theme's swap set (`block` null: the theme taken off; a new theme starts as a swap to the type itself). */
export function withTheme(t: BlockType, theme: string, swap: { block: string; variant?: number } | null): BlockType {
  const kits = { ...(t.kits ?? {}) };
  if (swap === null) delete kits[theme];
  else kits[theme] = { block: swap.block, ...(swap.variant !== undefined ? { variant: swap.variant } : {}) };
  const next = { ...t };
  if (Object.keys(kits).length > 0) next.kits = kits;
  else delete next.kits;
  return next;
}

/** A default metadata value (null: the field's own default again). */
export function withMetadata(t: BlockType, key: string, value: CellMetaValue | null): BlockType {
  const metadata = { ...(t.metadata ?? {}) };
  if (value === null) delete metadata[key];
  else metadata[key] = value;
  const next = { ...t };
  if (Object.keys(metadata).length > 0) next.metadata = metadata;
  else delete next.metadata;
  return next;
}

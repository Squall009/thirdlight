/**
 * Whole-model placement planning (packet 27; C27-1 repair).
 *
 * Placement is a **typed command**, never a direct state write: this module
 * only decides which `commands.md` operation the editor must issue and with
 * what strict `args`; the client transports it and the workspace executes it
 * (the sole mutation path).
 *
 * M2 placement has two contracted forms:
 *  - a whole GLB is placed by `createEntity` with `kind: "model"` and a
 *    resolving `model.asset.assetId` reference (commands.md §3.1/§8.1, the
 *    C27-1 repair): one placement = one undoable transaction with a
 *    backend-assigned `model-NNNN` ID and an independent transform;
 *  - a prefab copy is placed by `instantiatePrefab` (commands.md
 *    §3.1.3/§8.7): a definition may carry `components.model` references and
 *    instantiation materializes independent copies.
 *
 * Pure: no DOM, no I/O, no Node builtins.
 */

/** A typed prefab-copy command the editor will transport (never executed here). */
export interface PrefabPlacementCommand {
  op: 'instantiatePrefab';
  args: {
    prefabId: string;
    parentId?: string | null;
    transform?: { position?: readonly number[]; rotation?: readonly number[]; scale?: readonly number[] };
    overrides?: readonly { localId: string; key: string; value: unknown }[];
  };
}

/** A typed whole-GLB placement command (commands.md §8.1 `kind: "model"`). */
export interface ModelPlacementCommand {
  op: 'createEntity';
  args: {
    kind: 'model';
    model: { asset: { assetId: string } };
    parentId?: string | null;
    name?: string;
    transform?: { position?: readonly number[]; rotation?: readonly number[]; scale?: readonly number[] };
  };
}

export type PlacementCommand = PrefabPlacementCommand | ModelPlacementCommand;

export interface PlacementOptions {
  /** The parent the instance root is attached to (absent ⇒ scene root). */
  parentId?: string | null;
  /** The explicit root transform applied to the instance root only. */
  transform?: { position?: readonly number[]; rotation?: readonly number[]; scale?: readonly number[] };
  /** Declared-property overrides (≤ 64, unique `(localId, key)`). */
  overrides?: readonly { localId: string; key: string; value: unknown }[];
  /** Optional display name (asset placement only). */
  name?: string;
}

/**
 * Plan exactly one whole-model placement as the contracted `createEntity`
 * command with `kind: "model"` and a resolving asset reference. One placement
 * = one undoable transaction (§8.1), so two placements are two calls with
 * distinct, backend-assigned `model-NNNN` IDs.
 */
export function planAssetPlacement(assetId: string, options: PlacementOptions = {}): ModelPlacementCommand {
  return {
    op: 'createEntity',
    args: {
      kind: 'model',
      model: { asset: { assetId } },
      ...(options.parentId !== undefined ? { parentId: options.parentId } : {}),
      ...(options.name !== undefined ? { name: options.name } : {}),
      ...(options.transform !== undefined ? { transform: options.transform } : {}),
    },
  };
}

/**
 * Plan exactly one prefab-copy placement as the contracted `instantiatePrefab`
 * command. One placement = one undoable transaction (§8.7), so two placements
 * are two calls with distinct, backend-assigned IDs.
 */
export function planPrefabPlacement(prefabId: string, options: PlacementOptions = {}): PrefabPlacementCommand {
  const overrides = options.overrides?.slice(0, 64).map((o) => ({ localId: o.localId, key: o.key, value: o.value }));
  return {
    op: 'instantiatePrefab',
    args: {
      prefabId,
      ...(options.parentId !== undefined ? { parentId: options.parentId } : {}),
      ...(options.transform !== undefined ? { transform: options.transform } : {}),
      ...(overrides && overrides.length > 0 ? { overrides } : {}),
    },
  };
}

// ---- drag and drop of model assets (2026-09-24) ------------------------------

/** The DataTransfer type an asset tile drags. */
export const ASSET_DRAG_TYPE = 'application/x-thirdlight-asset';

/** What an asset tile drags: a whole model file or one piece of it. */
export interface AssetDragPayload {
  assetId: string;
  piece?: string;
}

export function parseAssetDrag(text: string): AssetDragPayload | null {
  try {
    const v = JSON.parse(text) as { assetId?: unknown; piece?: unknown };
    if (typeof v.assetId !== 'string' || v.assetId === '') return null;
    return typeof v.piece === 'string' ? { assetId: v.assetId, piece: v.piece } : { assetId: v.assetId };
  } catch {
    return null;
  }
}

/** What the loaded file says about one piece. */
export interface PieceFacts {
  name: string;
  /** LOD0 bounds in the file's root space (null when empty). */
  bounds: { min: [number, number, number]; max: [number, number, number] } | null;
  /** The 2D collider from the piece's `_COL` node (null: none); phase 23.1: in a 3D project its 3D shape (`{ shape }`). */
  collider: DropCollider;
  skinned: boolean;
}

/** Gap between pieces laid out in a row (meters). */
export const PIECE_ROW_GAP = 0.5;

export interface ModelDropInput {
  assetId: string;
  displayName: string;
  /** The dragged piece (absent: the whole file). */
  piece?: string;
  /** The file's pieces (from the loaded GLB). */
  pieces: readonly PieceFacts[];
  /** The whole file's collider (its single `_COL`), for a single-piece file. */
  wholeCollider: DropCollider;
  position: [number, number, number];
  /** A folder to file into (null: the scene root). */
  parentId: string | null;
}

/** A drop's collider: the 2D plane's polygon corners, or (phase 23.1, a 3D project) a 3D shape made from the `_COL` node. */
export type DropCollider = [number, number][] | { shape: Record<string, unknown> } | null;

const colliderComponents = (c: DropCollider, skinned: boolean): { components?: Record<string, unknown> } => {
  if (c === null || skinned) return {};
  if (!Array.isArray(c)) return { components: { collider: { shape: c.shape } } };
  return { components: { collider: { shape: { type: 'polygon', vertices: c.map(([x, y]) => [x, y]) } } } };
};

/**
 * Plan the one `createEntity` a model drop issues:
 *  - one piece → a model entity showing that piece (with its `_COL` collider);
 *  - a multi-piece file → a folder named after the file holding one entity per
 *    piece, laid out left to right with a gap so nothing overlaps (one undo);
 *  - a single-piece file → one whole-file model entity (a skinned character
 *    gets no static collider).
 */
export function planModelDrop(input: ModelDropInput): { args: Record<string, unknown> } {
  const name = (s: string): string => s.slice(0, 128);
  const parent = input.parentId !== null ? { parentId: input.parentId } : {};
  if (input.piece !== undefined) {
    const facts = input.pieces.find((p) => p.name === input.piece);
    return {
      args: {
        kind: 'model',
        name: name(input.piece),
        model: { asset: { assetId: input.assetId }, piece: input.piece },
        ...parent,
        transform: { position: [...input.position] },
        ...colliderComponents(facts?.collider ?? null, facts?.skinned ?? false),
      },
    };
  }
  if (input.pieces.length >= 2) {
    let cursor = 0;
    const children = input.pieces.map((p) => {
      const minX = p.bounds?.min[0] ?? 0;
      const width = p.bounds !== null ? Math.max(0.1, p.bounds.max[0] - p.bounds.min[0]) : 1;
      const x = round3(input.position[0] + cursor - minX);
      cursor += width + PIECE_ROW_GAP;
      return {
        kind: 'model',
        name: name(p.name),
        model: { asset: { assetId: input.assetId }, piece: p.name },
        transform: { position: [x, input.position[1], input.position[2]] },
        ...colliderComponents(p.collider, p.skinned),
      };
    });
    return { args: { kind: 'folder', name: name(input.displayName), ...parent, children } };
  }
  const skinned = input.pieces.some((p) => p.skinned);
  return {
    args: {
      kind: 'model',
      name: name(input.displayName),
      model: { asset: { assetId: input.assetId } },
      ...parent,
      transform: { position: [...input.position] },
      ...colliderComponents(input.wholeCollider, skinned),
    },
  };
}

function round3(v: number): number {
  const r = Math.round(v * 1000) / 1000;
  return r === 0 ? 0 : r;
}

/** Whether an asset can be placed directly (the `model` kind exists — C27-1 closed). */
export function assetPlacementAvailable(): boolean {
  return true;
}

/**
 * What the block editor remembers while a page is open, per block layer:
 * the tool picked in each mode, the block brush (the type, its turn and
 * look, the box height, the paint layer and target, the scatter rule), the
 * slice, the selection and what was copied, the stamp, the region and the
 * metadata brush, the overlays shown, the block type open in the block type
 * editor, and what Rooms & buildings draws with (presets, kit pieces) and
 * the room picked there. Modes come and go as the rail switches (each its own column), so
 * this is kept apart from them; it is never stored in the project (the
 * round brushes' settings are remembered per tool in `brush.ts`).
 *
 * Pure but for its in-memory store.
 */
import { DEFAULT_BRUSH, type BrushState, type CellBox, type PasteSource } from './block-brush';
import { BLOCK_MODES, type BlockModeId } from './block-mode';
import { DEFAULT_ROOM_OPTIONS, type RoomToolOptions } from './room-draw';

/** What was copied (or cut, to be moved within its layer) from a selection. */
export interface BlockClip {
  readonly layerId: string;
  readonly box: CellBox;
  readonly array: PasteSource & { kind: 'array' };
  readonly move: boolean;
}

export interface BlockStampPick {
  readonly stampId: string;
  readonly rot: 0 | 90 | 180 | 270;
  readonly mirror: 'x' | 'z' | null;
}

/** The metadata brush: the field, its value as typed, clear instead, cells or a rectangle, only cells that hold something. */
export interface BlockMetaBrush {
  readonly field: string;
  readonly raw: string;
  readonly erase: boolean;
  readonly shape: 'cells' | 'rect';
  readonly occupiedOnly: boolean;
}

export interface BlockToolState {
  /** The tool tile picked in each mode (its id in the mode's grid). */
  readonly tiles: Readonly<Record<BlockModeId, string>>;
  readonly brush: BrushState;
  /** The slice row (null: not chosen yet; the layer's lowest row). */
  readonly slice: number | null;
  readonly selection: CellBox | null;
  readonly clip: BlockClip | null;
  readonly stamp: BlockStampPick | null;
  readonly region: string | null;
  readonly meta: BlockMetaBrush;
  /** The cell fields the overlay colours. */
  readonly shown: readonly string[];
  readonly showRegions: boolean;
  /** Regions whose cut-away is previewed in the Scene view. */
  readonly cutPreview: readonly string[];
  /** The block type open in the block type editor (null: the brush's). */
  readonly typeOpen: string | null;
  /** The palette shows every block type of the project, not only the kit's and the layer's. */
  readonly allTypes: boolean;
  /** The open material rule card and scatter rule card. */
  readonly rule: number | null;
  readonly scatterRule: number | null;
  /** The cell under the pointer, in words (the status line's readout). */
  readonly hover: string;
  /** The Build tile picked before X switched to Erase (X switches back). */
  readonly beforeErase: string | null;
  /** What Rooms & buildings draws with (its tool's mode is the picked tile). */
  readonly roomOpts: Omit<RoomToolOptions, 'mode'>;
  /** The room, run or building picked in Rooms & buildings (its outline id; null: none). */
  readonly room: string | null;
}

const DEFAULT_TILES = Object.fromEntries(BLOCK_MODES.map((m) => [m.id, m.tiles[0]?.id ?? ''])) as Record<BlockModeId, string>;

export const DEFAULT_BLOCK_TOOL_STATE: BlockToolState = Object.freeze({
  tiles: DEFAULT_TILES,
  brush: DEFAULT_BRUSH,
  slice: null,
  selection: null,
  clip: null,
  stamp: null,
  region: null,
  meta: { field: '', raw: '', erase: false, shape: 'cells', occupiedOnly: false },
  shown: [],
  showRegions: true,
  cutPreview: [],
  typeOpen: null,
  allTypes: false,
  rule: null,
  scatterRule: null,
  hover: '',
  beforeErase: null,
  roomOpts: (({ mode: _m, ...rest }) => rest)(DEFAULT_ROOM_OPTIONS),
  room: null,
}) as BlockToolState;

export interface BlockToolStore {
  get(): BlockToolState;
  set(patch: Partial<BlockToolState> | ((s: BlockToolState) => Partial<BlockToolState>)): void;
  subscribe(listener: () => void): () => void;
}

const stores = new Map<string, BlockToolStore>();

/** The block editor's state of a layer (made on first use; kept while the page is open). */
export function blockToolStore(entityId: string): BlockToolStore {
  let s = stores.get(entityId);
  if (s !== undefined) return s;
  let state = DEFAULT_BLOCK_TOOL_STATE;
  const listeners = new Set<() => void>();
  s = {
    get: () => state,
    set: (patch) => {
      state = { ...state, ...(typeof patch === 'function' ? patch(state) : patch) };
      for (const l of [...listeners]) l();
    },
    subscribe: (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
  };
  stores.set(entityId, s);
  return s;
}

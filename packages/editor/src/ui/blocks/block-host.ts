/**
 * What the block editor gets from the app (as the terrain editor gets its
 * tools): the Scene view's block tools, the project's block types, cell
 * fields, stamps and kits, the block layers as the Hierarchy flags them,
 * the commands, and what the Rooms & buildings mode binds the layer's rooms
 * with.
 *
 * Browser-only (types for React components).
 */
import type { BlockCell, BlockEdit, BlockLayerComponent, BlockRegion, BlockStamp, BlockType, CellField, GraphDocument, KitDef } from '@thirdlight/project-model';

import type { Cell3, CellBox } from '../../session/block-brush';
import type { BlockEditor } from '../../viewport/block-editor';
import type { PresetSlidersHost } from '../architecture/PresetSliders';
import type { ClientRef, ReportFailure, ViewportRef } from '../shell/commands';

export interface BlockLayerRow {
  entityId: string;
  name: string;
  component: BlockLayerComponent;
  regions: readonly BlockRegion[];
  active: boolean;
  locked: boolean;
}

/** What the Scene view's block tools report back to the block editor (set by the editor while it shows). */
export interface BlockModeHandlers {
  onPick(cell: BlockCell | null): void;
  onSelect(box: CellBox | null): void;
  onHover(at: Cell3 | null, cell: BlockCell | null): void;
  /** A stroke was stored. */
  onCommitted(entityId: string, edits: readonly BlockEdit[]): void;
}

export interface BlockModeHost {
  /** The Scene view's block tools (null: the view is not up yet). */
  readonly editor: BlockEditor | null;
  /** The open scenes' block layers, with their Hierarchy flags. */
  readonly rows: readonly BlockLayerRow[];
  readonly types: readonly BlockType[];
  readonly fields: readonly CellField[];
  readonly stamps: readonly BlockStamp[];
  readonly kits: readonly KitDef[];
  /** The graphs (presets, room programs) the rooms of the layer are expanded with. */
  readonly graphs: readonly GraphDocument[];
  /** What the rooms' preset sliders read and send (graph edits, the Scene view's preview). */
  readonly presets: PresetSlidersHost;
  /** The project's prefabs (a block look can be a prefab's model). */
  readonly prefabs: readonly { readonly prefabId: string; readonly displayName: string }[];
  /** The layer the Scene view's tools edit (null: none). */
  setLayer(entityId: string | null): void;
  /** A content or scene command (true: stored). */
  run(what: string, op: string, args: Record<string, unknown>): Promise<boolean>;
  /**
   * Run one user action that sends several commands as one undo step (the
   * backend groups what it stored; see `SessionClient.grouped`).
   */
  grouped<T>(action: () => Promise<T>): Promise<T>;
  /** Some `editBlocks` edits of a layer (true: stored). */
  edit(what: string, entityId: string, edits: BlockEdit[]): Promise<boolean>;
  /**
   * One `setComponent` of a layer's own settings, the change applied to the
   * component as it is when the command is sent (so two quick changes both
   * stick); `change` null: nothing to send.
   */
  changeLayer(what: string, entityId: string, change: (c: BlockLayerComponent) => BlockLayerComponent | null): Promise<boolean>;
  setFlag(entityId: string, flag: 'active' | 'locked', value: boolean): void;
  notice(message: string): void;
  readonly handlers: { current: BlockModeHandlers | null };
  /** Publish a GLB file the user dropped as a model asset (its id; null: refused, said in a notice). */
  importModel(file: File): Promise<string | null>;
  /** Open the kit editor on a kit. */
  openKit(kitId: string): void;
  readonly clientRef: ClientRef;
  readonly viewportRef: ViewportRef;
  readonly reportFailure: ReportFailure;
}

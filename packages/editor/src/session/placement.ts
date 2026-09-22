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

/** Whether an asset can be placed directly (the `model` kind exists — C27-1 closed). */
export function assetPlacementAvailable(): boolean {
  return true;
}

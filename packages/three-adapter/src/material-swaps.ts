/**
 * Material swaps the running game asks for (a script's
 * `ctx.entity(id).set('materials', …)`, a timeline's material swap key,
 * `ctx.grid.setTypeMaterials`), shown on the objects and block types.
 *
 * A swap is simulation state: the runtime decides which material each slot
 * wears. What the picture does with it is presentation: the materials an
 * object (or a block type) will wear are loaded first — their textures
 * decoded and held in the resource manager — and only then put on, so an
 * object never shows a half-loaded material (no untextured flash). Until
 * then it keeps what it wore. A swap that changes again while it loads is
 * replaced by the newer one; the older load is let go.
 *
 * Pure bookkeeping over injected hooks (the adapter re-applies its own
 * objects); no three.js here.
 */

/** Slot → material id (a model's source material name, or "*" for every slot). */
export type MaterialMappingLike = Readonly<Record<string, string>>;

/** A texture preload (the material library's `preloadTextures`). */
export interface TexturePreload {
  readonly ready: Promise<void>;
  release(): void;
}

export interface MaterialSwapDeps {
  /** The materials an object wears with this swap over its authored mapping (null: it wears none of the project's). */
  entityMapping(entityId: string, swap: MaterialMappingLike | null): MaterialMappingLike | null;
  /** The materials a block type wears with this swap over its own mapping (null: none of the project's). */
  blockMapping(blockId: string, swap: MaterialMappingLike | null): MaterialMappingLike | null;
  /** The texture assets a project material draws with. */
  textureRefs(materialId: string): readonly string[];
  /** Decode and hold textures until released (absent: nothing to wait for). */
  preload?(textureAssetIds: readonly string[]): TexturePreload;
  /** Put the object's materials on again (its swap is now `applied(entityId)`). */
  applyEntity(entityId: string): void;
  /** Put the block types' materials on again (their swaps are now `appliedBlocks()`). */
  applyBlockTypes(): void;
  /** Something was put on (a new frame is needed). */
  onChange?(): void;
}

interface Pending {
  readonly key: string;
  readonly hold: TexturePreload | null;
}

const keyOf = (m: MaterialMappingLike | undefined): string => (m === undefined ? '' : JSON.stringify(Object.entries(m).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))));

export class MaterialSwapView {
  private readonly appliedEntities = new Map<string, MaterialMappingLike>();
  private appliedBlockSwaps: ReadonlyMap<string, MaterialMappingLike> = new Map();
  private readonly pendingEntities = new Map<string, Pending>();
  private pendingBlocks: Pending | null = null;
  private lastEntitiesKey = '';
  private lastBlocksKey = '';
  private disposed = false;
  /** Swaps put on since the start (diagnostics). */
  applied = 0;

  constructor(private readonly deps: MaterialSwapDeps) {}

  /** The swap an object wears now (null: its authored materials). */
  swapOf(entityId: string): MaterialMappingLike | null {
    return this.appliedEntities.get(entityId) ?? null;
  }

  /** The block types' swaps worn now. */
  appliedBlocks(): ReadonlyMap<string, MaterialMappingLike> {
    return this.appliedBlockSwaps;
  }

  /** Swaps waiting for their materials to load. */
  pending(): number {
    return this.pendingEntities.size + (this.pendingBlocks !== null ? 1 : 0);
  }

  /** The runtime's swaps this frame (undefined: the runtime has none to give). */
  update(entities: ReadonlyMap<string, MaterialMappingLike> | undefined, blocks: ReadonlyMap<string, MaterialMappingLike> | undefined): void {
    if (this.disposed) return;
    if (entities !== undefined) this.updateEntities(entities);
    if (blocks !== undefined) this.updateBlocks(blocks);
  }

  private updateEntities(swaps: ReadonlyMap<string, MaterialMappingLike>): void {
    // Unchanged lists cost one key per frame (none while no swap was ever made).
    const listKey = swaps.size === 0 && this.appliedEntities.size === 0 && this.pendingEntities.size === 0 ? '' : JSON.stringify([...swaps].map(([id, m]) => [id, keyOf(m)]));
    if (listKey === this.lastEntitiesKey) return;
    this.lastEntitiesKey = listKey;
    const ids = new Set([...swaps.keys(), ...this.appliedEntities.keys(), ...this.pendingEntities.keys()]);
    for (const id of ids) {
      const target = swaps.get(id);
      const targetKey = keyOf(target);
      const pending = this.pendingEntities.get(id);
      if (pending !== undefined) {
        if (pending.key === targetKey) continue;
        // A newer swap replaces the one still loading.
        pending.hold?.release();
        this.pendingEntities.delete(id);
      }
      if (targetKey === keyOf(this.appliedEntities.get(id))) continue;
      const mapping = this.deps.entityMapping(id, target ?? null);
      const textures = mapping === null ? [] : [...new Set(Object.values(mapping).flatMap((m) => this.deps.textureRefs(m)))];
      const hold = textures.length > 0 && this.deps.preload !== undefined ? this.deps.preload(textures) : null;
      const entry: Pending = { key: targetKey, hold };
      this.pendingEntities.set(id, entry);
      const put = (): void => {
        if (this.disposed || this.pendingEntities.get(id) !== entry) return;
        this.pendingEntities.delete(id);
        if (target === undefined) this.appliedEntities.delete(id);
        else this.appliedEntities.set(id, target);
        this.applied += 1;
        this.deps.applyEntity(id);
        // The materials put on hold their own textures now.
        entry.hold?.release();
        this.deps.onChange?.();
      };
      if (hold === null) put();
      else void hold.ready.then(put, put);
    }
  }

  private updateBlocks(swaps: ReadonlyMap<string, MaterialMappingLike>): void {
    const key = swaps.size === 0 ? '' : JSON.stringify([...swaps].map(([id, m]) => [id, keyOf(m)]).sort(([a], [b]) => (String(a) < String(b) ? -1 : 1)));
    if (key === this.lastBlocksKey) return;
    this.lastBlocksKey = key;
    this.pendingBlocks?.hold?.release();
    this.pendingBlocks = null;
    const target = new Map(swaps);
    // Every type whose look changes (newly swapped, or back to its own) loads what it will wear.
    const types = new Set([...target.keys(), ...this.appliedBlockSwaps.keys()]);
    const textures = [...new Set([...types].flatMap((t) => Object.values(this.deps.blockMapping(t, target.get(t) ?? null) ?? {}).flatMap((id) => this.deps.textureRefs(id))))];
    const hold = textures.length > 0 && this.deps.preload !== undefined ? this.deps.preload(textures) : null;
    const entry: Pending = { key, hold };
    this.pendingBlocks = entry;
    const put = (): void => {
      if (this.disposed || this.pendingBlocks !== entry) return;
      this.pendingBlocks = null;
      this.appliedBlockSwaps = target;
      this.applied += 1;
      this.deps.applyBlockTypes();
      entry.hold?.release();
      this.deps.onChange?.();
    };
    if (hold === null) put();
    else void hold.ready.then(put, put);
  }

  /** An object left the picture: its swap and any load for it go. */
  removed(entityId: string): void {
    this.appliedEntities.delete(entityId);
    const p = this.pendingEntities.get(entityId);
    if (p !== undefined) {
      p.hold?.release();
      this.pendingEntities.delete(entityId);
    }
    this.lastEntitiesKey = '\u0000';
  }

  dispose(): void {
    this.disposed = true;
    for (const p of this.pendingEntities.values()) p.hold?.release();
    this.pendingEntities.clear();
    this.pendingBlocks?.hold?.release();
    this.pendingBlocks = null;
  }
}

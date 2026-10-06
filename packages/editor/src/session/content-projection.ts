/**
 * Content projection (additive to the scene projection).
 *
 * The asset summaries the editor has read by id (`queryAssets {ids}`): the
 * ones the Scene view, a list or a picker shows now — never the whole
 * catalog, which the project index pages (`catalog.ts`). It also resolves
 * the version a placement realizes.
 *
 * Normative rules implemented here:
 *
 *  - the summaries are read again after every full state (establish/re-attach/resync)
 *    and updated from the same `mutation.applied` `change` records the scene
 *    projection uses; `mutation.applied` never carries bytes;
 *  - a **reimport** appends a version and moves `currentVersion`; it never
 *    touches an entity — referencing placements keep their entity IDs,
 *    transforms and `assetId`, and resolve the new version;
 *  - a **failed** import/reimport never reaches this projection (only an
 *    applied `publishAsset` change does), so a failure preserves the previous
 *    committed content.
 *
 * Pure: no DOM, no I/O, no Node builtins. Content **summaries** only — this
 * module never holds bytes.
 */

import type { AssetSummary, ChangeData, CommandAssetRecord, PublishAssetChange } from '@thirdlight/commands';
import { audioSummaryOf, textureHasStreamableChain, textureStreamingOf } from '@thirdlight/project-model/limits';
import type { ProjectedEntity } from './projection';

/** One catalog asset summary exactly as `queryAssets`/full state returns it. */
export type AssetView = AssetSummary;

/** The immutable per-version facts a placement resolves a visual through. */
export interface AssetVersionView {
  version: number;
  sourceDigest: string;
  sourceByteLength: number;
}

/** The full-state `content` block (only the additive fields we consume). */
export interface FullContentState {
  assets?: readonly AssetSummary[];
}

/**
 * The editor's projection of the backend asset catalog. One instance per
 * connection, advanced only by applied `mutation.applied` changes (never by a
 * failed or stale job).
 */
export class ContentProjection {
  private assets = new Map<string, AssetView>();

  /** Start again from these summaries (a full state: the ones read so far may be stale). */
  hydrate(content: FullContentState | null | undefined): void {
    this.assets.clear();
    this.put(content?.assets ?? []);
  }

  /** Add or replace summaries read by id (what a list, picker or the Scene view needs now). */
  put(summaries: readonly AssetSummary[]): void {
    for (const a of summaries) this.assets.set(a.assetId, cloneSummary(a));
  }

  has(assetId: string): boolean {
    return this.assets.has(assetId);
  }

  /** The summaries read so far, in ascending `assetId` order (never the whole catalog: the index pages that). */
  cachedAssets(): AssetView[] {
    return [...this.assets.values()].sort((a, b) => (a.assetId < b.assetId ? -1 : a.assetId > b.assetId ? 1 : 0));
  }

  getAsset(assetId: string): AssetView | undefined {
    return this.assets.get(assetId);
  }

  get size(): number {
    return this.assets.size;
  }

  /**
   * Apply one applied change record. Content changes update the catalog;
   * scene-only changes leave it untouched. Returns whether the catalog changed.
   */
  applyChange(change: ChangeData): boolean {
    switch (change.type) {
      case 'publishAsset':
        return this.applyPublishAsset(change);
      // `deleteAsset` (and its redo) removes the record.
      case 'removeAsset':
        return this.assets.delete(change.assetId);
      // A folder import adds its records; its undo names the ones it forgets.
      case 'importAssets': {
        let changed = false;
        for (const r of change.removed) changed = this.assets.delete(r.assetId) || changed;
        for (const r of change.added) changed = this.applyPublishAsset({ type: 'publishAsset', mode: 'create', assetId: r.assetId, previous: null, next: r } as PublishAssetChange) || changed;
        return changed;
      }
      // Assets' labels and addresses (a resource's are the client's content).
      case 'setLabels':
      case 'setAddress': {
        let changed = false;
        for (const item of change.items) {
          const a = item.kind === 'asset' ? this.assets.get(item.id) : undefined;
          if (a === undefined) continue;
          const { labels: _l, address: _a, ...rest } = a;
          this.assets.set(item.id, { ...rest, ...(item.next.labels !== undefined ? { labels: [...item.next.labels] } : {}), ...(item.next.address !== undefined ? { address: item.next.address } : {}) });
          changed = true;
        }
        return changed;
      }
      // Files moved: an asset's file (and its original, for a converted one) is somewhere else.
      case 'moveResources': {
        let changed = false;
        for (const m of change.moves) {
          const a = m.kind === 'asset' ? this.assets.get(m.id) : undefined;
          if (a === undefined) continue;
          const moved = { ...a } as AssetView & { sourcePath?: string; convertedFrom?: { sourcePath?: string } };
          if (moved.sourcePath === m.from) moved.sourcePath = m.to;
          if (moved.convertedFrom?.sourcePath === m.from) moved.convertedFrom = { ...moved.convertedFrom, sourcePath: m.to };
          this.assets.set(m.id, moved);
          changed = true;
        }
        return changed;
      }
      // The whole next record (its options, and where its file is after a move).
      case 'setAssetOptions':
        if (!this.assets.has(change.assetId)) return false;
        return this.applyPublishAsset({ type: 'publishAsset', mode: 'reimport', assetId: change.assetId, previous: null, next: change.next } as unknown as PublishAssetChange);
      default:
        return false;
    }
  }

  private applyPublishAsset(change: PublishAssetChange): boolean {
    const next = change.next;
    if (next === null) {
      // An inverse (undo of a create) removes the record (a
      // `deleteAsset` sends its own `removeAsset` change).
      return this.assets.delete(change.assetId);
    }
    const previous = this.assets.get(change.assetId);
    const pathOf = (v: unknown): string | undefined => (v as { sourcePath?: string } | undefined)?.sourcePath;
    const current = next.versions.find((v) => v.version === next.currentVersion) as
      | { convertedFrom?: { format: 'fbx' | 'glb' | 'png' | 'jpeg' | 'webp'; sourcePath?: string; encoding?: 'color' | 'normal' | 'data' }; packedFrom?: { encoding: 'color' | 'normal' | 'data'; layers: ({ assetId?: string } | { value: number })[][] }; metrics?: unknown }
      | undefined;
    const image = next.kind === 'texture' ? (current?.metrics as { format: string; width: number; height: number; codec?: 'etc1s' | 'uastc'; levels?: number; layers?: number } | undefined) : undefined;
    // A packed texture's encoding and source assets.
    const packed = current?.packedFrom;
    const packedSources = packed === undefined ? [] : [...new Set(packed.layers.flatMap((l) => l.flatMap((c) => ('assetId' in c && typeof c.assetId === 'string' ? [c.assetId] : []))))].sort();
    const sourcePath = pathOf(current);
    const convertedFrom = current?.convertedFrom;
    const audio = audioSummaryOf(next as unknown as Parameters<typeof audioSummaryOf>[0]);
    this.assets.set(change.assetId, {
      assetId: next.assetId,
      kind: next.kind,
      displayName: next.displayName,
      currentVersion: next.currentVersion,
      versionCount: next.versions.length,
      ...(next.vertexColors === 'tint' ? { vertexColors: 'tint' as const } : {}),
      ...((next as { materials?: Record<string, string> }).materials !== undefined ? { materials: { ...(next as unknown as { materials: Record<string, string> }).materials } } : {}),
      ...(typeof (next as { clipsFor?: string }).clipsFor === 'string' ? { clipsFor: (next as unknown as { clipsFor: string }).clipsFor } : {}),
      ...((next as { lod?: { screenSizes?: number[]; cullSize?: number } }).lod !== undefined ? { lod: lodCopy((next as { lod?: { screenSizes?: number[]; cullSize?: number } }).lod!) } : {}),
      ...(next.extractTextures === true ? { extractTextures: true as const } : {}),
      ...(next.textures !== undefined ? { textures: { ...next.textures } } : {}),
      ...(next.labels !== undefined ? { labels: [...next.labels] } : {}),
      ...((next as { address?: string }).address !== undefined ? { address: (next as { address?: string }).address } : {}),
      ...(sourcePath !== undefined ? { sourcePath } : {}),
      ...(convertedFrom !== undefined ? { convertedFrom: { format: convertedFrom.format, ...(convertedFrom.sourcePath !== undefined ? { sourcePath: convertedFrom.sourcePath } : {}), ...(convertedFrom.encoding !== undefined ? { encoding: convertedFrom.encoding } : {}) } } : {}),
      // A texture's image facts (a KTX2's codec and mip levels).
      ...(image !== undefined ? { image: { format: image.format, width: image.width, height: image.height, ...(image.codec !== undefined ? { codec: image.codec } : {}), ...(image.levels !== undefined ? { levels: image.levels } : {}), ...(image.layers !== undefined ? { layers: image.layers } : {}) } } : {}),
      ...(packed !== undefined ? { packedFrom: { encoding: packed.encoding, sources: packedSources } } : {}),
      // An audio file's facts and load settings.
      ...(audio !== undefined ? { audio } : {}),
      // A texture's mip streaming (the setting, else the default for its size).
      ...(next.kind === 'texture' ? { streaming: { on: textureStreamingOf(next), set: typeof (next as { streaming?: unknown }).streaming === 'boolean', possible: textureHasStreamableChain(current?.metrics) } } : {}),
      // `change.next` carries the full record, so the version facts (never
      // bytes) are recomputed locally rather than re-queried.
      versions: next.versions.map((v) => {
        const path = pathOf(v);
        return { version: v.version, sourceDigest: v.sourceDigest, sourceByteLength: v.sourceByteLength, ...(path !== undefined ? { sourcePath: path } : {}) };
      }),
    });
    if (!previous) return true;
    // Any fact of the summary (a vertex-colour mode, default materials, a rig, streaming, …).
    return JSON.stringify(previous) !== JSON.stringify(this.assets.get(change.assetId));
  }

  /** The `(version, digest, byteLength)` a placement resolves through now. */
  resolveVersion(assetId: string): AssetVersionView | null {
    const a = this.assets.get(assetId);
    if (!a) return null;
    const v = a.versions?.find((x) => x.version === a.currentVersion);
    // Summaries carry no digest/byte length unless `includeVersions` was set;
    // the viewport resolver reads the immutable version facts through the
    // authenticated byte route, so only the version number is required here.
    return { version: a.currentVersion, sourceDigest: v?.sourceDigest ?? '', sourceByteLength: v?.sourceByteLength ?? 0 };
  }

  /** Current version of an asset, or `null` when it is not in the catalog. */
  currentVersion(assetId: string): number | null {
    return this.assets.get(assetId)?.currentVersion ?? null;
  }

  /** Every `assetId` referenced by the projected scene (ascending, unique). */
  referencedAssetIds(entities: readonly ProjectedEntity[]): string[] {
    const ids = new Set<string>();
    for (const e of entities) if (e.assetId) ids.add(e.assetId);
    return [...ids].sort();
  }

  /**
   * A placement reference check for the content browser: every referenced
   * `assetId` must resolve in the catalog, else the projection is stale and a
   * fresh full state is required (never a partial merge).
   */
  unresolvedReferences(entities: readonly ProjectedEntity[]): string[] {
    return this.referencedAssetIds(entities).filter((id) => !this.assets.has(id));
  }
}

/** A model's LOD settings, copied. */
function lodCopy(lod: { readonly screenSizes?: readonly number[]; readonly cullSize?: number }): { screenSizes?: number[]; cullSize?: number } {
  return { ...(lod.screenSizes !== undefined ? { screenSizes: [...lod.screenSizes] } : {}), ...(lod.cullSize !== undefined ? { cullSize: lod.cullSize } : {}) };
}

function cloneSummary(a: AssetSummary): AssetSummary {
  return {
    assetId: a.assetId,
    kind: a.kind,
    displayName: a.displayName,
    currentVersion: a.currentVersion,
    versionCount: a.versionCount,
    ...(a.vertexColors === 'tint' ? { vertexColors: 'tint' as const } : {}),
    ...(a.materials !== undefined ? { materials: { ...a.materials } } : {}),
    ...(a.clipsFor !== undefined ? { clipsFor: a.clipsFor } : {}),
    ...(a.lod !== undefined ? { lod: lodCopy(a.lod) } : {}),
    ...(a.extractTextures === true ? { extractTextures: true as const } : {}),
    ...(a.textures !== undefined ? { textures: { ...a.textures } } : {}),
    ...(a.labels !== undefined ? { labels: [...a.labels] } : {}),
    ...(a.address !== undefined ? { address: a.address } : {}),
    ...(a.sourcePath !== undefined ? { sourcePath: a.sourcePath } : {}),
    ...(a.convertedFrom !== undefined ? { convertedFrom: { ...a.convertedFrom } } : {}),
    ...(a.image !== undefined ? { image: { ...a.image } } : {}),
    ...(a.streaming !== undefined ? { streaming: { ...a.streaming } } : {}),
    ...(a.audio !== undefined ? { audio: { ...a.audio, ...(a.audio.playbackGaps !== undefined ? { playbackGaps: [...a.audio.playbackGaps] } : {}) } } : {}),
    ...(a.packedFrom !== undefined ? { packedFrom: { encoding: a.packedFrom.encoding, sources: [...a.packedFrom.sources] } } : {}),
    ...(a.versions ? { versions: a.versions.map((v) => ({ ...v })) } : {}),
  };
}

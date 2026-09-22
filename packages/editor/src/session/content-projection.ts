/**
 * Content projection (sessions.md §8 "Content projection (M2, additive)";
 * packet 27).
 *
 * The full-state payload carries a bounded `content` object
 * (`{ assets, prefabs, behaviors }` summary pages at the same revision,
 * sessions.md §19.4). This module holds the **asset** part of that projection:
 * the catalog summaries the content browser renders and the version
 * resolution the viewport uses to realize a model placement.
 *
 * Normative rules implemented here:
 *
 *  - the projection is rebuilt on every full state (establish/re-attach/resync)
 *    and updated from the same `mutation.applied` `change` records the scene
 *    projection uses; `mutation.applied` never carries bytes;
 *  - a **reimport** appends a version and moves `currentVersion`; it never
 *    touches an entity — referencing placements keep their entity IDs,
 *    transforms and `assetId`, and resolve the new version (project-model
 *    §18.1.5);
 *  - a **failed** import/reimport never reaches this projection (only an
 *    applied `publishAsset` change does), so a failure preserves the previous
 *    committed content.
 *
 * Pure: no DOM, no I/O, no Node builtins. Content **summaries** only — this
 * module never holds bytes.
 */

import type { AssetSummary, ChangeData, PublishAssetChange } from '@thirdlight/commands';
import type { ProjectedEntity } from './projection';

/** One catalog asset summary exactly as `queryAssets`/full state returns it. */
export type AssetView = AssetSummary;

/** The immutable per-version facts a placement resolves a visual through. */
export interface AssetVersionView {
  version: number;
  sourceDigest: string;
  sourceByteLength: number;
}

/** The full-state `content` block (only the additive M2 fields we consume). */
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

  /** Rebuild from authoritative full state (establish / re-attach / resync). */
  hydrate(content: FullContentState | null | undefined): void {
    this.assets.clear();
    for (const a of content?.assets ?? []) {
      this.assets.set(a.assetId, cloneSummary(a));
    }
  }

  /** Ascending `assetId` order (commands.md §5.6). */
  listAssets(): AssetView[] {
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
      default:
        return false;
    }
  }

  private applyPublishAsset(change: PublishAssetChange): boolean {
    const next = change.next;
    if (next === null) {
      // An inverse (undo of a create) removes the record. M2 has no asset
      // deletion, so this only occurs through undo/redo.
      return this.assets.delete(change.assetId);
    }
    const previous = this.assets.get(change.assetId);
    this.assets.set(change.assetId, {
      assetId: next.assetId,
      kind: next.kind,
      displayName: next.displayName,
      currentVersion: next.currentVersion,
      versionCount: next.versions.length,
      // `change.next` carries the full record, so the version facts (never
      // bytes) are recomputed locally rather than re-queried.
      versions: next.versions.map((v) => ({ version: v.version, sourceDigest: v.sourceDigest, sourceByteLength: v.sourceByteLength })),
    });
    if (!previous) return true;
    return previous.currentVersion !== next.currentVersion || previous.displayName !== next.displayName;
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
   * fresh full state is required (never a partial merge — sessions.md §8).
   */
  unresolvedReferences(entities: readonly ProjectedEntity[]): string[] {
    return this.referencedAssetIds(entities).filter((id) => !this.assets.has(id));
  }
}

function cloneSummary(a: AssetSummary): AssetSummary {
  return {
    assetId: a.assetId,
    kind: a.kind,
    displayName: a.displayName,
    currentVersion: a.currentVersion,
    versionCount: a.versionCount,
    ...(a.versions ? { versions: a.versions.map((v) => ({ ...v })) } : {}),
  };
}

/**
 * The content query result shapes (queryAssets, queryBehaviors,
 * queryPrefabs, queryProject counts, queryGameConfig, queryEntities).
 */
import type { AssetKind, BehaviorRecord, PrefabDefinition, PropertyDeclaration, SceneV3, TagDefinition } from '@thirdlight/project-model';

import type { CommandError } from './types';


/** One `queryAssets` summary. */
export interface AssetSummary {
  assetId: string;
  kind: AssetKind;
  displayName: string;
  currentVersion: number;
  versionCount: number;
  /** The current version's file in the game folder, when it is referenced in place. */
  sourcePath?: string;
  /** The current version's original when it was converted at import (FBX; a PNG/JPEG encoded to KTX2). */
  convertedFrom?: { format: 'fbx' | 'glb' | 'png' | 'jpeg'; sourcePath?: string; encoding?: 'color' | 'normal' | 'data' };
  /** The current version was packed from texture assets: its encoding and the source assets. */
  packedFrom?: { encoding: 'color' | 'normal' | 'data'; sources: string[] };
  /** Texture only: the current version's image facts (a KTX2's codec and mip levels; a texture array's layers). */
  image?: { format: string; width: number; height: number; codec?: 'etc1s' | 'uastc'; levels?: number; layers?: number };
  /**
   * Texture only: whether the game streams its mips (`on`, the setting or the
   * default for its size), whether the user set it, and whether it can
   * (`possible`: a KTX2 mip chain larger than the mip tail).
   */
  streaming?: { on: boolean; set: boolean; possible: boolean };
  /**
   * Audio only: the current version's facts, how the game holds it (defaults
   * applied; `loadTypeSet`: the user chose it) and what a browser does not play.
   */
  audio?: import('@thirdlight/project-model').AudioSummary;
  /** Model only: `tint` = COLOR_0 multiplies the albedo (absent = shader data). */
  vertexColors?: 'tint';
  /** Model only: the default material mapping of every placement. */
  materials?: Record<string, string>;
  /** Model only: an animation-only file whose clips play on this model asset's rig. */
  clipsFor?: string;
  /** Model only: the "extract textures" import setting is on. */
  extractTextures?: true;
  /** Model only: the texture asset each extracted image of the file became (image index → assetId). */
  textures?: Record<string, string>;
  /** The asset's labels (absent: none). */
  labels?: string[];
  /** The asset's address (absent: none). */
  address?: string;
  /** Present only with `includeVersions: true` (never bytes, never metrics). */
  versions?: readonly { version: number; sourceDigest: string; sourceByteLength: number; sourcePath?: string }[];
}

/** One `queryBehaviors` element: a summary, or the full record with `includeDeclaration`. */
export type BehaviorQueryEntry = BehaviorSummary | BehaviorRecord;

/** One `queryBehaviors` summary. */
export interface BehaviorSummary {
  behaviorId: string;
  displayName: string;
  propertyCount: number;
  hasSource: boolean;
  publishedRevision: number;
  /** Present only with `includeDeclaration: true` (never source bytes). */
  declaration?: PropertyDeclaration;
}

/** One `queryPrefabs` summary. */
export interface PrefabSummary {
  prefabId: string;
  displayName: string;
  createdRevision: number;
  entityCount: number;
  depth: number;
}

/** One `queryPrefabs` element: a summary, or the full definition with `includeEntities`. */
export type PrefabQueryEntry = PrefabSummary | PrefabDefinition;

/**
 * A query result. Queries are read-only: no
 * `expectedRevision`/`requestId`, never deduplicated, never mutating.
 */
export type QueryResult<T> =
  | {
      ok: true;
      projectId: string;
      revision: number;
      total: number;
      offset: number;
      limit: number;
      assets?: readonly T[];
      behaviors?: readonly T[];
      prefabs?: readonly T[];
      /** With `ids`: the ids asked for that name no record. */
      missing?: readonly string[];
    }
  | { ok: false; op?: string; projectId?: string; error: CommandError };

/**
 * The `queryProject` content count summary:
 * counts only, except `game` which is a boolean (`content.game !== null`).
 */
export interface ContentCounts {
  assets: number;
  prefabs: number;
  behaviors: number;
  settingsKeys: number;
  /** v3 only: `assets` records with `kind === "audio"`. */
  audioAssets?: number;
  /** v3 only: entities carrying `components.playerSpawn`. */
  spawns?: number;
}

/** `queryGameConfig` result (the tags, no game block). */
export type GameConfigQueryResult =
  | { ok: true; projectId: string; revision: number; tags: TagDefinition[] }
  | { ok: false; op?: string; projectId?: string; error: CommandError };

/** One `queryEntities` page: filtered, document order. */
export interface EntitiesQueryResult {
  ok: true;
  projectId: string;
  revision: number;
  total: number;
  offset: number;
  limit: number;
  entities: readonly SceneV3['entities'][number][];
}

/**
 * Bounded content queries — commands.md §4/§5.6 (packet 21 non-prefab subset).
 *
 * Queries are read-only: they carry no `expectedRevision`/`requestId`, never
 * mutate state and are never deduplicated. They observe the last acknowledged
 * in-memory state. This pure layer serves the content queries the packet-21
 * ops own (`queryAssets`, `queryBehaviors`, `queryPrefabs`) plus the bounded
 * `queryProject` content counts; the scene queries are served by the
 * workspace/protocol layers (packet 07).
 *
 * Results never carry bytes, blobs or staging handles.
 */

import { ID_RE, fieldType, fieldUnexpected, fieldValue, invalidRequest, isPlainObject } from './errors';
import { assetKindOf } from './v3';
import { contentOf } from './content-ops';
import type { GameConfig } from '@thirdlight/project-model';
import type {
  AssetSummary,
  BehaviorQueryEntry,
  BehaviorSummary,
  CommandError,
  CommandState,
  ContentCounts,
  GameConfigQueryResult,
  PrefabQueryEntry,
  PrefabSummary,
  QueryResult,
  SceneDocument,
} from './types';

/** Page cap for content queries (commands.md §4). */
const MAX_CONTENT_PAGE = 128;
const DEFAULT_LIMIT = 50;

interface QueryBase {
  op?: string;
  projectId: string;
  args: Record<string, unknown>;
}

function parseQueryRequest(
  expectedOp: 'queryAssets' | 'queryBehaviors' | 'queryPrefabs' | 'queryGameConfig',
  request: unknown,
): { ok: true; base: QueryBase } | { ok: false; projectId?: string; error: CommandError } {
  if (!isPlainObject(request)) {
    return {
      ok: false,
      error: invalidRequest('', typeof request, `query request object { op: "${expectedOp}", projectId, args? }`, 'query must be a JSON object'),
    };
  }
  const projectId = request['projectId'];
  if (projectId !== undefined && (typeof projectId !== 'string' || !ID_RE.test(projectId))) {
    return {
      ok: false,
      error: fieldValue('/projectId', projectId, 'project-model ID syntax: [a-z0-9][a-z0-9_-]{0,63}', 'projectId must use the project-model ID syntax'),
    };
  }
  if (typeof projectId !== 'string') {
    return {
      ok: false,
      error: invalidRequest('/projectId', projectId, 'project-model ID syntax: [a-z0-9][a-z0-9_-]{0,63}', 'query requires a parseable projectId'),
    };
  }
  const op = request['op'];
  if (op !== undefined && (typeof op !== 'string' || op !== expectedOp)) {
    return {
      ok: false,
      projectId,
      error: fieldValue('/op', op, `"${expectedOp}"`, `query op must be "${expectedOp}"`),
    };
  }
  const args = request['args'];
  if (args !== undefined && !isPlainObject(args)) {
    return { ok: false, projectId, error: fieldType('/args', args, 'object (query args)') };
  }
  return { ok: true, base: { op, projectId, args: (args ?? {}) as Record<string, unknown> } };
}

function parsePageArgs(
  args: Record<string, unknown>,
  known: readonly string[],
): { ok: true; limit: number; offset: number } | { ok: false; error: CommandError } {
  const knownText = known.join(', ');
  for (const key of Object.keys(args)) {
    if (!known.includes(key)) {
      return { ok: false, error: fieldUnexpected(`/args/${key}`, key, knownText) };
    }
  }
  let limit = DEFAULT_LIMIT;
  if (args['limit'] !== undefined) {
    const v = args['limit'];
    if (typeof v !== 'number' || !Number.isInteger(v)) {
      return { ok: false, error: fieldType('/args/limit', v, 'integer 1-128') };
    }
    if (v < 1 || v > MAX_CONTENT_PAGE) {
      return {
        ok: false,
        error: fieldValue('/args/limit', v, 'integer 1-128', 'limit must be an integer between 1 and 128'),
      };
    }
    limit = v;
  }
  let offset = 0;
  if (args['offset'] !== undefined) {
    const v = args['offset'];
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) {
      return {
        ok: false,
        error: fieldValue('/args/offset', v, 'integer >= 0', 'offset must be a non-negative integer'),
      };
    }
    offset = v;
  }
  return { ok: true, limit, offset };
}

function parseBooleanArg(
  args: Record<string, unknown>,
  key: string,
): { ok: true; value: boolean } | { ok: false; error: CommandError } {
  const v = args[key];
  if (v === undefined) return { ok: true, value: false };
  if (typeof v !== 'boolean') return { ok: false, error: fieldType(`/args/${key}`, v, 'boolean') };
  return { ok: true, value: v };
}

/** `queryAssets` (commands.md §5.6): paged catalog summaries. */
export function queryAssets(
  state: CommandState<SceneDocument>,
  request: unknown,
): QueryResult<AssetSummary> {
  const parsed = parseQueryRequest('queryAssets', request);
  if (!parsed.ok) return { ok: false, projectId: parsed.projectId, error: parsed.error };
  const { projectId, args } = parsed.base;
  const page = parsePageArgs(args, ['limit', 'offset', 'includeVersions', 'assetId']);
  if (!page.ok) return { ok: false, op: 'queryAssets', projectId, error: page.error };
  const inc = parseBooleanArg(args, 'includeVersions');
  if (!inc.ok) return { ok: false, op: 'queryAssets', projectId, error: inc.error };
  if (args['assetId'] !== undefined && typeof args['assetId'] !== 'string') {
    return { ok: false, op: 'queryAssets', projectId, error: fieldType('/args/assetId', args['assetId'], 'string (asset ID)') };
  }
  const content = contentOf(state.content);
  let records = [...content.assets].sort((a, b) => (a.assetId < b.assetId ? -1 : a.assetId > b.assetId ? 1 : 0));
  if (typeof args['assetId'] === 'string') {
    const wanted = args['assetId'];
    const one = records.find((a) => a.assetId === wanted);
    if (one === undefined) {
      return {
        ok: false,
        op: 'queryAssets',
        projectId,
        error: { code: 'asset_not_found', cls: 'validation', assetId: wanted, message: 'no asset record with this id exists in content.assets' },
      };
    }
    records = [one];
  }
  const total = records.length;
  const pageRecords = records.slice(page.offset, page.offset + page.limit);
  const assets: AssetSummary[] = pageRecords.map((a) => {
    const summary: AssetSummary = {
      assetId: a.assetId,
      kind: a.kind,
      displayName: a.displayName,
      currentVersion: a.currentVersion,
      versionCount: a.versions.length,
    };
    const current = a.versions.find((v) => v.version === a.currentVersion) as { sourcePath?: string; convertedFrom?: { format: 'fbx'; sourcePath?: string } } | undefined;
    if (current?.sourcePath !== undefined) summary.sourcePath = current.sourcePath;
    if ((a as { vertexColors?: string }).vertexColors === 'tint') summary.vertexColors = 'tint';
    const defaultMaterials = (a as { materials?: Record<string, string> }).materials;
    if (defaultMaterials !== undefined) summary.materials = { ...defaultMaterials };
    if (current?.convertedFrom !== undefined) {
      summary.convertedFrom = { format: current.convertedFrom.format, ...(current.convertedFrom.sourcePath !== undefined ? { sourcePath: current.convertedFrom.sourcePath } : {}) };
    }
    if (inc.value) {
      summary.versions = a.versions.map((v) => {
        const sourcePath = (v as { sourcePath?: string }).sourcePath;
        return {
          version: v.version,
          sourceDigest: v.sourceDigest,
          sourceByteLength: v.sourceByteLength,
          ...(sourcePath !== undefined ? { sourcePath } : {}),
        };
      });
    }
    return summary;
  });
  return {
    ok: true,
    projectId,
    revision: state.scene.revision,
    total,
    offset: page.offset,
    limit: page.limit,
    assets,
  };
}

/** `queryBehaviors` (commands.md §5.6): paged behavior summaries. */
export function queryBehaviors(
  state: CommandState<SceneDocument>,
  request: unknown,
): QueryResult<BehaviorQueryEntry> {
  const parsed = parseQueryRequest('queryBehaviors', request);
  if (!parsed.ok) return { ok: false, projectId: parsed.projectId, error: parsed.error };
  const { projectId, args } = parsed.base;
  const page = parsePageArgs(args, ['limit', 'offset', 'includeDeclaration', 'behaviorId']);
  if (!page.ok) return { ok: false, op: 'queryBehaviors', projectId, error: page.error };
  const inc = parseBooleanArg(args, 'includeDeclaration');
  if (!inc.ok) return { ok: false, op: 'queryBehaviors', projectId, error: inc.error };
  if (args['behaviorId'] !== undefined && typeof args['behaviorId'] !== 'string') {
    return { ok: false, op: 'queryBehaviors', projectId, error: fieldType('/args/behaviorId', args['behaviorId'], 'string (behavior ID)') };
  }
  const content = contentOf(state.content);
  let records = [...content.behaviors].sort((a, b) => (a.behaviorId < b.behaviorId ? -1 : a.behaviorId > b.behaviorId ? 1 : 0));
  if (typeof args['behaviorId'] === 'string') {
    const wanted = args['behaviorId'];
    const one = records.find((b) => b.behaviorId === wanted);
    if (one === undefined) {
      return {
        ok: false,
        op: 'queryBehaviors',
        projectId,
        error: { code: 'behavior_not_found', cls: 'validation', behaviorId: wanted, message: 'no behavior record with this id exists in content.behaviors' },
      };
    }
    records = [one];
  }
  const total = records.length;
  const pageRecords = records.slice(page.offset, page.offset + page.limit);
  // `includeDeclaration: true` returns the exact stored record (the
  // packet-16 query fixture pins this shape), never source bytes.
  const behaviors: BehaviorQueryEntry[] = pageRecords.map((b) => {
    if (inc.value) return b;
    const summary: BehaviorSummary = {
      behaviorId: b.behaviorId,
      displayName: b.displayName,
      propertyCount: b.declaration.properties.length,
      hasSource: b.source !== null,
      publishedRevision: b.publishedRevision,
    };
    return summary;
  });
  return {
    ok: true,
    projectId,
    revision: state.scene.revision,
    total,
    offset: page.offset,
    limit: page.limit,
    behaviors,
  };
}

/** `queryPrefabs` (commands.md §5.6, packet 22): paged definition summaries. */
export function queryPrefabs(
  state: CommandState<SceneDocument>,
  request: unknown,
): QueryResult<PrefabQueryEntry> {
  const parsed = parseQueryRequest('queryPrefabs', request);
  if (!parsed.ok) return { ok: false, projectId: parsed.projectId, error: parsed.error };
  const { projectId, args } = parsed.base;
  const page = parsePageArgs(args, ['limit', 'offset', 'includeEntities', 'prefabId']);
  if (!page.ok) return { ok: false, op: 'queryPrefabs', projectId, error: page.error };
  const inc = parseBooleanArg(args, 'includeEntities');
  if (!inc.ok) return { ok: false, op: 'queryPrefabs', projectId, error: inc.error };
  if (args['prefabId'] !== undefined && typeof args['prefabId'] !== 'string') {
    return {
      ok: false,
      op: 'queryPrefabs',
      projectId,
      error: fieldType('/args/prefabId', args['prefabId'], 'string (prefab ID)'),
    };
  }
  const content = contentOf(state.content);
  let records = [...content.prefabs].sort((a, b) =>
    a.prefabId < b.prefabId ? -1 : a.prefabId > b.prefabId ? 1 : 0,
  );
  if (typeof args['prefabId'] === 'string') {
    const wanted = args['prefabId'];
    const one = records.find((d) => d.prefabId === wanted);
    if (one === undefined) {
      return {
        ok: false,
        op: 'queryPrefabs',
        projectId,
        error: {
          code: 'prefab_not_found',
          cls: 'validation',
          prefabId: wanted,
          message: 'no prefab definition with this id exists in content.prefabs',
        },
      };
    }
    records = [one];
  }
  const total = records.length;
  const pageRecords = records.slice(page.offset, page.offset + page.limit);
  // `includeEntities: true` returns the exact stored definition value (the
  // packet-16 query fixture pins this shape), never a projection.
  const prefabs: PrefabQueryEntry[] = pageRecords.map((d) => {
    if (inc.value) return d;
    const summary: PrefabSummary = {
      prefabId: d.prefabId,
      displayName: d.displayName,
      createdRevision: d.createdRevision,
      entityCount: d.entityCount,
      depth: d.depth,
    };
    return summary;
  });
  return {
    ok: true,
    projectId,
    revision: state.scene.revision,
    total,
    offset: page.offset,
    limit: page.limit,
    prefabs,
  };
}

/**
 * The `queryProject` bounded content counts (commands.md §4/§5.6, packet 45):
 * counts only, plus the v3 additions — `audioAssets` (asset records with
 * `kind === "audio"`), `game` (boolean), `zones` and `spawns` entity counts.
 * Never returns block contents, bytes or definitions.
 */
export function contentCounts(state: CommandState<SceneDocument>): ContentCounts {
  const content = contentOf(state.content);
  const counts: ContentCounts = {
    assets: content.assets.length,
    prefabs: content.prefabs.length,
    behaviors: content.behaviors.length,
    settingsKeys: Object.keys(content.settings).length,
  };
  // The v3 additions are emitted only for a v3 state so the accepted M2
  // `queryProject` content summary stays byte-identical (handoff 45 CC-45-6).
  if ((state.scene as { schemaVersion?: unknown }).schemaVersion === 3 || (state.scene as { schemaVersion?: unknown }).schemaVersion === 4) {
    const entities = state.scene.entities as unknown as readonly {
      components: Record<string, unknown>;
    }[];
    counts.audioAssets = content.assets.filter((a) => assetKindOf(a) === 'audio').length;
    counts.game = (content.game ?? null) !== null;
    counts.zones = entities.filter((e) => e.components['gameZone'] !== undefined).length;
    counts.spawns = entities.filter((e) => e.components['playerSpawn'] !== undefined).length;
  }
  return counts;
}

/**
 * `queryGameConfig` (commands.md §3.1.11/authoring §A6): the full normalized
 * `content.game` block or `null`; no page args, no mutation fields. A v2
 * catalog (no `game` key) reads as `null`.
 */
export function queryGameConfig(
  state: CommandState<SceneDocument>,
  request: unknown,
): GameConfigQueryResult {
  const parsed = parseQueryRequest('queryGameConfig', request);
  if (!parsed.ok) return { ok: false, projectId: parsed.projectId, error: parsed.error };
  const { projectId, args } = parsed.base;
  for (const key of Object.keys(args)) {
    return {
      ok: false,
      op: 'queryGameConfig',
      projectId,
      error: fieldUnexpected(`/args/${key}`, key, '(none — queryGameConfig takes no args)'),
    };
  }
  const content = contentOf(state.content);
  return {
    ok: true,
    projectId,
    revision: state.scene.revision,
    game: (content.game ?? null) as GameConfig | null,
    // Phase 12 (b): the project tag registry travels with the game block.
    tags: (content.tags ?? []).map((t) => ({ bit: t.bit, name: t.name })),
  };
}

/**
 * The `queryEntities` component filter (commands.md §4, packet 45): the page
 * contains only entities carrying `component`, still in document order, and
 * `total` counts the filtered set. Unknown component names are `field_value`.
 * The workspace query validates/pages through this helper (packet 48).
 */
export function filterEntitiesByComponent(
  entities: readonly { components: Record<string, unknown> }[],
  component: unknown,
): { ok: true; entities: readonly { components: Record<string, unknown> }[] } | { ok: false; error: CommandError } {
  if (component === undefined) return { ok: true, entities };
  if (typeof component !== 'string' || !KNOWN_COMPONENTS.includes(component)) {
    return {
      ok: false,
      error: fieldValue(
        '/args/component',
        component,
        `one of ${KNOWN_COMPONENTS.map((c) => `"${c}"`).join(', ')}`,
        'component must be one of the accepted component names',
      ),
    };
  }
  return {
    ok: true,
    entities: entities.filter((e) => Object.prototype.hasOwnProperty.call(e.components, component)),
  };
}

/** Every accepted component name (the v1/v2/v3 registry union). */
const KNOWN_COMPONENTS: readonly string[] = [
  'transform',
  'model',
  'box',
  'camera',
  'behavior',
  'prefab',
  'collider',
  'controller',
  'gameZone',
  'playerSpawn',
  'cameraFollow',
  'light',
  'surface',
  'modelAnimation',
];

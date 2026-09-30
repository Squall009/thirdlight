/**
 * Bounded content queries.
 *
 * Queries are read-only: they carry no `expectedRevision`/`requestId`, never
 * mutate state and are never deduplicated. They observe the last acknowledged
 * in-memory state. This pure layer serves the content queries
 * (`queryAssets`, `queryBehaviors`, `queryPrefabs`) plus the bounded
 * `queryProject` content counts; the scene queries are served by the
 * workspace/protocol layers.
 *
 * Results never carry bytes, blobs or staging handles.
 */
import { ASSET_QUERY_PAGE_DEFAULT, ASSET_QUERY_PAGE_MAX, audioSummaryOf, textureHasStreamableChain, textureStreamingOf } from '@thirdlight/project-model';

import { ID_RE, fieldType, fieldUnexpected, fieldValue, invalidRequest, isPlainObject } from './errors';
import { assetKindOf } from './v3';
import { contentOf } from './content-ops';
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

/** Page cap for content queries: the model's asset catalog page. */
const MAX_CONTENT_PAGE = ASSET_QUERY_PAGE_MAX;
const DEFAULT_LIMIT = ASSET_QUERY_PAGE_DEFAULT;

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

/**
 * A list in id order, made once per list: queries page from it instead of
 * copying and sorting the catalog on every call. Lists are immutable values
 * (a command replaces the list it changes), so the list is the key; a page
 * whose records no longer carry the ids the order was made from (a list
 * changed in place) makes the order again.
 */
interface IdOrder {
  readonly length: number;
  /** Positions in the list, in ascending id order. */
  readonly order: readonly number[];
  /** The ids in that order. */
  readonly ids: readonly string[];
  /** Id → its place in the order. */
  readonly rank: ReadonlyMap<string, number>;
}
const idOrders = new WeakMap<readonly object[], IdOrder>();

function makeIdOrder<T>(list: readonly T[], idOf: (r: T) => string): IdOrder {
  const order = list.map((_, i) => i).sort((a, b) => {
    const x = idOf(list[a]!);
    const y = idOf(list[b]!);
    return x < y ? -1 : x > y ? 1 : 0;
  });
  const ids = order.map((i) => idOf(list[i]!));
  const made: IdOrder = { length: list.length, order, ids, rank: new Map(ids.map((id, k) => [id, k] as const)) };
  idOrders.set(list as unknown as readonly object[], made);
  return made;
}

/** The records of `list` in id order from `offset` (at most `limit`), and one by id; `total` is the list's length. */
export function idOrderedPage<T>(list: readonly T[], idOf: (r: T) => string, offset: number, limit: number, only?: string): { total: number; records: T[]; found: boolean } {
  let o = idOrders.get(list as unknown as readonly object[]);
  if (o === undefined || o.length !== list.length) o = makeIdOrder(list, idOf);
  const pick = (from: number, to: number): T[] | null => {
    const out: T[] = [];
    for (let k = from; k < to; k += 1) {
      const r = list[o!.order[k]!]!;
      if (idOf(r) !== o!.ids[k]) return null;
      out.push(r);
    }
    return out;
  };
  if (only !== undefined) {
    let k = o.rank.get(only);
    let got = k === undefined ? [] : pick(k, k + 1);
    if (got === null) {
      o = makeIdOrder(list, idOf);
      k = o.rank.get(only);
      got = k === undefined ? [] : pick(k, k + 1)!;
    }
    return { total: got.length, records: got.slice(offset, offset + limit), found: got.length > 0 };
  }
  const to = Math.min(list.length, offset + limit);
  let got = offset >= to ? [] : pick(offset, to);
  if (got === null) {
    o = makeIdOrder(list, idOf);
    got = pick(offset, to)!;
  }
  return { total: list.length, records: got, found: true };
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

/** `queryAssets`: paged catalog summaries. */
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
  const wanted = typeof args['assetId'] === 'string' ? args['assetId'] : undefined;
  const { total, records: pageRecords, found } = idOrderedPage(content.assets, (a) => a.assetId, page.offset, page.limit, wanted);
  if (!found) {
    return {
      ok: false,
      op: 'queryAssets',
      projectId,
      error: { code: 'asset_not_found', cls: 'validation', assetId: wanted!, message: 'no asset record with this id exists in content.assets' },
    };
  }
  const assets: AssetSummary[] = pageRecords.map((a) => {
    const summary: AssetSummary = {
      assetId: a.assetId,
      kind: a.kind,
      displayName: a.displayName,
      currentVersion: a.currentVersion,
      versionCount: a.versions.length,
    };
    const current = a.versions.find((v) => v.version === a.currentVersion) as
      | { sourcePath?: string; convertedFrom?: { format: 'fbx' | 'png' | 'jpeg'; sourcePath?: string; encoding?: 'color' | 'normal' | 'data' }; packedFrom?: { encoding: 'color' | 'normal' | 'data'; layers: ({ assetId?: string } | { value: number })[][] }; metrics?: unknown }
      | undefined;
    if (current?.sourcePath !== undefined) summary.sourcePath = current.sourcePath;
    if ((a as { vertexColors?: string }).vertexColors === 'tint') summary.vertexColors = 'tint';
    const defaultMaterials = (a as { materials?: Record<string, string> }).materials;
    if (defaultMaterials !== undefined) summary.materials = { ...defaultMaterials };
    const clipsFor = (a as { clipsFor?: string }).clipsFor;
    if (clipsFor !== undefined) summary.clipsFor = clipsFor;
    const labels = (a as { labels?: string[] }).labels;
    if (labels !== undefined) summary.labels = [...labels];
    const address = (a as { address?: string }).address;
    if (address !== undefined) summary.address = address;
    if (current?.convertedFrom !== undefined) {
      summary.convertedFrom = { format: current.convertedFrom.format, ...(current.convertedFrom.sourcePath !== undefined ? { sourcePath: current.convertedFrom.sourcePath } : {}), ...(current.convertedFrom.encoding !== undefined ? { encoding: current.convertedFrom.encoding } : {}) };
    }
    if (current?.packedFrom !== undefined) {
      const sources = new Set<string>();
      for (const l of current.packedFrom.layers) for (const c of l) if ('assetId' in c && typeof c.assetId === 'string') sources.add(c.assetId);
      summary.packedFrom = { encoding: current.packedFrom.encoding, sources: [...sources].sort() };
    }
    if ((a.kind as string) === 'texture') {
      const m = current?.metrics as { format: string; width: number; height: number; codec?: 'etc1s' | 'uastc'; levels?: number; layers?: number } | undefined;
      if (m !== undefined) summary.image = { format: m.format, width: m.width, height: m.height, ...(m.codec !== undefined ? { codec: m.codec } : {}), ...(m.levels !== undefined ? { levels: m.levels } : {}), ...(m.layers !== undefined ? { layers: m.layers } : {}) };
      const own = (a as { streaming?: boolean }).streaming;
      summary.streaming = { on: textureStreamingOf(a), set: typeof own === 'boolean', possible: textureHasStreamableChain(current?.metrics) };
    }
    const audio = audioSummaryOf(a);
    if (audio !== undefined) summary.audio = audio;
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

/** `queryBehaviors`: paged behavior summaries. */
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
  const wanted = typeof args['behaviorId'] === 'string' ? args['behaviorId'] : undefined;
  const { total, records: pageRecords, found } = idOrderedPage(content.behaviors, (b) => b.behaviorId, page.offset, page.limit, wanted);
  if (!found) {
    return {
      ok: false,
      op: 'queryBehaviors',
      projectId,
      error: { code: 'behavior_not_found', cls: 'validation', behaviorId: wanted!, message: 'no behavior record with this id exists in content.behaviors' },
    };
  }
  // `includeDeclaration: true` returns the exact stored record (the
  // query fixture pins this shape), never source bytes.
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

/** `queryPrefabs`: paged definition summaries. */
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
  const wanted = typeof args['prefabId'] === 'string' ? args['prefabId'] : undefined;
  const { total, records: pageRecords, found } = idOrderedPage(content.prefabs, (d) => d.prefabId, page.offset, page.limit, wanted);
  {
    if (!found) {
      return {
        ok: false,
        op: 'queryPrefabs',
        projectId,
        error: {
          code: 'prefab_not_found',
          cls: 'validation',
          prefabId: wanted!,
          message: 'no prefab definition with this id exists in content.prefabs',
        },
      };
    }
  }
  // `includeEntities: true` returns the exact stored definition value (the
  // query fixture pins this shape), never a projection.
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
 * The `queryProject` bounded content counts:
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
  // The v3 additions (every state is v3 or v4).
  {
    const entities = state.scene.entities as unknown as readonly {
      components: Record<string, unknown>;
    }[];
    counts.audioAssets = content.assets.filter((a) => assetKindOf(a) === 'audio').length;
    counts.spawns = entities.filter((e) => e.components['playerSpawn'] !== undefined).length;
  }
  return counts;
}

/**
 * `queryGameConfig`: the project tag registry; no page args, no mutation
 * fields.
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
    // The project tag registry.
    tags: (content.tags ?? []).map((t) => ({ bit: t.bit, name: t.name })),
  };
}

/**
 * The `queryEntities` component filter: the page
 * contains only entities carrying `component`, still in document order, and
 * `total` counts the filtered set. Unknown component names are `field_value`.
 * The workspace query validates/pages through this helper.
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
  'playerSpawn',
  'light',
  'surface',
  'modelAnimation',
];

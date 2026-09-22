/**
 * v3 project composition, the model-owned v3 authoring-envelope branch and
 * the pure v2→v3 scene migration — project-model.md §13.2 (`validateProjectV3`),
 * §23.5/§23.8 (the effective v3 order), §23.11 (`migrateSceneV3`) and
 * `workspace.md` §16.2/§16.3 (the envelope combination and key set).
 *
 * Composition order (§23.8): content block → scene (the accepted per-document
 * order) → game-dependent scene rules → v3 cross-block asset/cue/animation
 * references → the accepted v2 cross-block checks. `game_config_invalid` is a
 * single-error rule that stops the pipeline; the combination check and the
 * envelope/content key set are single-error rules too.
 *
 * Pure: no I/O, no filesystem, no three.js. Paths handed to
 * `validateEnvelopeV3` are envelope-relative (`/scene/…`, `/content/…`);
 * `validateProjectV3` returns the accepted document-tagged, document-relative
 * shape (§13.2).
 */

import { fail, isPlainObject, pointerSegment, withFound } from './validate';
import { ID_RE_V2 } from './scene-v2';
import { validateManifest } from './validate';
import { validateContentV3 } from './content';
import { validateSceneV3 } from './scene-v3';
import { crossBlockV2 } from './project-v2';
import type {
  EnvelopeV3Error,
  EnvelopeV3ErrorCode,
  ModelErrorV2,
  ModelErrorV3,
  ModelResultV3,
} from './errors';
import type { Manifest as M1Manifest } from './types';
import type { SceneV3, ContentCatalogV3, AuthoringEnvelopeV3, GameConfig } from './types-v3';

const ENVELOPE_V3_FIELDS = ['storageVersion', 'type', 'projectId', 'scene', 'content', 'retry'] as const;
const CONTENT_V3_FIELDS = ['assets', 'prefabs', 'behaviors', 'settings', 'behaviorTrust', 'game'] as const;

// ---- shared v3 composition (§23.5/§23.8 steps 5–6) ---------------------------

function gameRef(
  path: string,
  reason: 'player' | 'camera' | 'camera_follow' | 'spawn' | 'safe_spawn' | 'cue',
  message: string,
  expected: string,
  document: 'scene' | 'content',
  found?: unknown,
): ModelErrorV3 {
  const e: ModelErrorV3 = { code: 'game_reference_missing', path, message, reason, expected, document };
  return found === undefined ? e : withFound(e, found);
}

function assetRef(
  code: 'asset_reference_missing' | 'asset_kind_mismatch' | 'asset_version_invalid',
  path: string,
  message: string,
  expected: string,
  document: 'scene' | 'content',
  reason?: string,
  found?: unknown,
): ModelErrorV3 {
  const e: ModelErrorV3 = { code, path, message, expected, document, ...(reason === undefined ? {} : { reason }) };
  return found === undefined ? e : withFound(e, found);
}

/**
 * §23.5/§23.8 steps 5–6 over already-validated v3 blocks. Emits
 * document-tagged, document-relative errors (the §13.2 shape); the envelope
 * branch maps them to envelope-relative paths.
 */
export function composeV3(
  scene: SceneV3,
  content: ContentCatalogV3,
  errors: ModelErrorV3[],
): void {
  const game: GameConfig | null = content.game;
  const indexById = new Map<string, number>();
  scene.entities.forEach((e, i) => {
    if (!indexById.has(e.id)) indexById.set(e.id, i);
  });
  const entityById = (id: string): (typeof scene.entities)[number] | undefined => {
    const i = indexById.get(id);
    return i === undefined ? undefined : scene.entities[i];
  };

  if (game !== null) {
    // Rule 1: exactly one controller, named by game.playerId.
    const controllers = scene.entities.filter((e) => e.components.controller !== undefined).length;
    if (controllers === 0) {
      errors.push(
        withFound(
          {
            code: 'controller_count_invalid',
            path: '',
            document: 'scene',
            message: 'content.game requires exactly one controller entity',
            expected: 'exactly 1 controller',
          },
          0,
        ),
      );
    }
    const player = entityById(game.playerId);
    if (!player || player.components.controller === undefined) {
      errors.push(
        gameRef(
          '/game/playerId',
          'player',
          'game.playerId must name the scene controller entity',
          'the id of the entity carrying controller',
          'content',
          game.playerId,
        ),
      );
    }
    // Rule 2: the camera entity carries cameraFollow and is named by cameraId.
    const camera = entityById(game.cameraId);
    if (!camera || camera.components.camera === undefined) {
      errors.push(
        gameRef('/game/cameraId', 'camera', 'game.cameraId must name the scene camera entity', 'the id of the entity carrying camera', 'content', game.cameraId),
      );
    } else if (camera.components.cameraFollow === undefined) {
      errors.push(
        gameRef(
          '/game/cameraId',
          'camera_follow',
          'the camera entity must carry cameraFollow when content.game is non-null',
          'components.cameraFollow on the camera entity',
          'content',
          game.cameraId,
        ),
      );
    }
    // Rule 3: the start spawn.
    const spawn = entityById(game.spawnId);
    if (!spawn || spawn.components.playerSpawn === undefined) {
      errors.push(
        gameRef('/game/spawnId', 'spawn', 'game.spawnId must name a playerSpawn entity', 'the id of an entity carrying playerSpawn', 'content', game.spawnId),
      );
    }
    // Rule 5: at least one goal zone.
    const goals = scene.entities.filter((e) => e.components.gameZone?.role === 'goal').length;
    if (goals < 1) {
      errors.push({
        code: 'zone_goal_missing',
        path: '/entities',
        document: 'scene',
        message: 'content.game requires at least one role: "goal" gameZone',
        expected: '>= 1 goal zone',
      });
    }
  }

  // Step 6: cross-block asset/cue/animation resolution (never a dangling ref).
  const assetById = new Map(content.assets.map((a) => [a.assetId, a]));
  if (game !== null) {
    for (const k of ['start', 'jump', 'checkpoint', 'death', 'goal'] as const) {
      const ref = game.cues[k];
      if (ref === null) continue;
      const record = assetById.get(ref);
      if (!record) {
        errors.push(
          assetRef('asset_reference_missing', `/game/cues/${k}`, 'cue asset reference resolves to no catalog record', 'an existing assetId in content.assets', 'content', undefined, ref),
        );
      } else if (record.kind !== 'audio') {
        errors.push(
          assetRef('asset_kind_mismatch', `/game/cues/${k}`, 'a cue asset reference must resolve to kind "audio"', '"audio"', 'content', 'cue', record.kind),
        );
      }
    }
  }
  scene.entities.forEach((e, i) => {
    const activation = e.components.gameZone?.activation;
    if (activation && activation.cueAssetId !== null) {
      const record = assetById.get(activation.cueAssetId);
      if (!record) {
        errors.push(
          assetRef(
            'asset_reference_missing',
            `/entities/${i}/components/gameZone/activation/cueAssetId`,
            'activation cue reference resolves to no catalog record',
            'an existing assetId in content.assets',
            'scene',
            undefined,
            activation.cueAssetId,
          ),
        );
      } else if (record.kind !== 'audio') {
        errors.push(
          assetRef(
            'asset_kind_mismatch',
            `/entities/${i}/components/gameZone/activation/cueAssetId`,
            'an activation cue reference must resolve to kind "audio"',
            '"audio"',
            'scene',
            'cue',
            record.kind,
          ),
        );
      }
    }
    const model = e.components.model;
    if (model) {
      const record = assetById.get(model.asset.assetId);
      if (record && record.kind !== 'model') {
        errors.push(
          assetRef(
            'asset_kind_mismatch',
            `/entities/${i}/components/model/asset/assetId`,
            'a components.model reference must resolve to kind "model"',
            '"model"',
            'scene',
            'model',
            record.kind,
          ),
        );
      }
    }
    const animation = e.components.modelAnimation;
    if (animation) {
      const record = assetById.get(animation.assetId);
      if (!record) {
        errors.push(
          assetRef(
            'asset_reference_missing',
            `/entities/${i}/components/modelAnimation/assetId`,
            'modelAnimation assetId resolves to no catalog record',
            'an existing assetId in content.assets',
            'scene',
            undefined,
            animation.assetId,
          ),
        );
      } else {
        if (record.kind !== 'model') {
          errors.push(
            assetRef(
              'asset_kind_mismatch',
              `/entities/${i}/components/modelAnimation/assetId`,
              'modelAnimation assetId must resolve to kind "model"',
              '"model"',
              'scene',
              'model',
              record.kind,
            ),
          );
        }
        if (animation.version > record.currentVersion) {
          errors.push(
            assetRef(
              'asset_version_invalid',
              `/entities/${i}/components/modelAnimation/version`,
              'modelAnimation version exceeds the record currentVersion (a binding is never silently moved)',
              `<= ${record.currentVersion}`,
              'scene',
              undefined,
              animation.version,
            ),
          );
        }
      }
    }
  });

  // The accepted v2 cross-block checks (§13.1/§13.2 items 1–7).
  crossBlockV2(
    scene as unknown as Parameters<typeof crossBlockV2>[0],
    content as unknown as Parameters<typeof crossBlockV2>[1],
    errors as ModelErrorV2[],
  );
}

// ---- validateProjectV3 (§13.2) ----------------------------------------------

function tag(errors: readonly ModelErrorV3[], document: 'manifest' | 'scene' | 'content'): ModelErrorV3[] {
  return errors.map((e) => ({ ...e, document }));
}

/** §13.2 `validateProjectV3`: manifest (v1) + v3 scene + v3 content. */
export function validateProjectV3(
  manifest: unknown,
  scene: unknown,
  content: unknown,
): ModelResultV3<{ manifest: M1Manifest; scene: SceneV3; content: ContentCatalogV3 }> {
  const m = validateManifest(manifest);
  const s = validateSceneV3(scene);
  const c = validateContentV3(content);
  const errors: ModelErrorV3[] = [];
  if (!m.ok) errors.push(...tag(m.errors as ModelErrorV3[], 'manifest'));
  if (!s.ok) errors.push(...tag(s.errors, 'scene'));
  if (!c.ok) errors.push(...tag(c.errors, 'content'));
  if (!m.ok || !s.ok || !c.ok) return fail(errors);

  const mm = m.normalized as M1Manifest;
  const ss = s.normalized as SceneV3;
  const cc = c.normalized as ContentCatalogV3;

  if (mm.scenes[0]!.id !== ss.sceneId) {
    errors.push(
      withFound(
        {
          code: 'manifest_scene_mismatch',
          path: '/scenes/0/id',
          document: 'manifest',
          message: 'manifest scenes[0].id does not equal the scene document sceneId',
          expected: 'scene document sceneId',
        },
        mm.scenes[0]!.id,
      ),
    );
  }

  composeV3(ss, cc, errors);
  if (errors.length > 0) return fail(errors);
  return { ok: true, normalized: { manifest: mm, scene: ss, content: cc } };
}

// ---- the model-owned v3 authoring envelope (§23.8; workspace §16.2/§16.3) ----

export type EnvelopeV3Load =
  | { ok: true; normalized: AuthoringEnvelopeV3 }
  | { ok: false; errors: readonly EnvelopeV3Error[]; count: number };

function envelopeFail(errors: readonly EnvelopeV3Error[]): EnvelopeV3Load {
  return { ok: false, errors, count: errors.length };
}

function envelopeError(
  code: EnvelopeV3ErrorCode,
  path: string,
  message: string,
  expected: string,
  reason?: string,
  found?: unknown,
): EnvelopeV3Error {
  const e: EnvelopeV3Error = { code, path, message, expected, ...(reason === undefined ? {} : { reason }) };
  return found === undefined ? e : (withFound(e as ModelErrorV3, found) as EnvelopeV3Error);
}

/** Map a document-tagged composition error to the envelope-relative path. */
function toEnvelopeError(e: ModelErrorV3): EnvelopeV3Error {
  const prefix = e.document === 'content' ? '/content' : e.document === 'manifest' ? '' : '/scene';
  const { document: _document, ...rest } = e;
  void _document;
  return { ...rest, path: `${prefix}${e.path}` };
}

function prefixErrors(errors: readonly ModelErrorV3[], prefix: string): EnvelopeV3Error[] {
  return errors.map((e) => {
    const { document: _document, ...rest } = e;
    void _document;
    return { ...rest, path: `${prefix}${e.path}` };
  });
}

/**
 * The model-owned v3 envelope branch: `storageVersion` known → version
 * combination → envelope/content key set → content (`game_config_invalid`
 * stops the pipeline) → scene → composition. Every refusal is a single
 * error; the bytes are never rewritten here.
 */
export function validateEnvelopeV3(root: unknown): EnvelopeV3Load {
  if (!isPlainObject(root)) {
    return envelopeFail([envelopeError('envelope_invalid', '', 'the envelope root must be an object', 'object')]);
  }
  const storageVersion = root['storageVersion'];
  if (typeof storageVersion !== 'number' || ![1, 2, 3].includes(storageVersion)) {
    return envelopeFail([
      envelopeError(
        'storage_version_unsupported',
        '/storageVersion',
        'storageVersion is not a known envelope version',
        '[1, 2, 3]',
        undefined,
        storageVersion,
      ),
    ]);
  }
  const sceneRaw = root['scene'];
  const sceneSchema = isPlainObject(sceneRaw) ? sceneRaw['schemaVersion'] : undefined;
  if (storageVersion !== 3 || sceneSchema !== 3) {
    return envelopeFail([
      envelopeError(
        'version_combination_unsupported',
        '/storageVersion',
        'the only passable v3 combination is manifest 1 + scene schemaVersion 3 + storageVersion 3',
        'storageVersion 3 with scene.schemaVersion 3',
        undefined,
        storageVersion,
      ),
    ]);
  }
  for (const k of ENVELOPE_V3_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(root, k)) {
      return envelopeFail([envelopeError('envelope_invalid', `/${k}`, `required envelope field '${k}' is missing`, 'present', 'field_missing')]);
    }
  }
  for (const k of Object.keys(root)) {
    if (!(ENVELOPE_V3_FIELDS as readonly string[]).includes(k)) {
      return envelopeFail([
        envelopeError('envelope_invalid', `/${pointerSegment(k)}`, 'unknown envelope field is not permitted (the six-key set is exact)', ENVELOPE_V3_FIELDS.join(', '), 'field_unexpected', k),
      ]);
    }
  }
  if (root['type'] !== 'authoring-state') {
    return envelopeFail([
      envelopeError('envelope_invalid', '/type', 'envelope type must be "authoring-state"', '"authoring-state"', 'field_value', root['type']),
    ]);
  }
  const projectId = root['projectId'];
  if (typeof projectId !== 'string') {
    return envelopeFail([envelopeError('envelope_invalid', '/projectId', 'envelope projectId must be a string', 'a project ID string', 'field_type', projectId)]);
  }
  if (!ID_RE_V2.test(projectId)) {
    return envelopeFail([envelopeError('envelope_invalid', '/projectId', 'envelope projectId must match the §5.1 ID syntax', '1-64 chars, ^[a-z0-9][a-z0-9_-]{0,63}$', 'field_value', projectId)]);
  }
  if (!isPlainObject(root['retry'])) {
    return envelopeFail([envelopeError('envelope_invalid', '/retry', 'the retry block must be present and be an object', 'object', 'field_type', root['retry'])]);
  }
  const contentRaw = root['content'];
  if (!isPlainObject(contentRaw)) {
    return envelopeFail([envelopeError('envelope_invalid', '/content', 'the content block must be an object', 'object', 'field_type', contentRaw)]);
  }
  for (const k of CONTENT_V3_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(contentRaw, k)) {
      return envelopeFail([
        envelopeError('envelope_invalid', `/content/${k}`, `required v3 content key '${k}' is missing`, 'present', 'field_missing'),
      ]);
    }
  }
  for (const k of Object.keys(contentRaw)) {
    if (!(CONTENT_V3_FIELDS as readonly string[]).includes(k)) {
      return envelopeFail([
        envelopeError('envelope_invalid', `/content/${pointerSegment(k)}`, 'unknown v3 content key is not permitted (the six-key set is exact)', CONTENT_V3_FIELDS.join(', '), 'field_unexpected', k),
      ]);
    }
  }

  const contentResult = validateContentV3(contentRaw);
  if (!contentResult.ok) {
    const mapped = prefixErrors(contentResult.errors, '/content');
    // `game_config_invalid` is a single-error rule that stops the pipeline.
    if (mapped.some((e) => e.code === 'game_config_invalid')) return envelopeFail(mapped);
    const sceneResult = validateSceneV3(sceneRaw);
    if (!sceneResult.ok) return envelopeFail([...mapped, ...prefixErrors(sceneResult.errors, '/scene')]);
    return envelopeFail(mapped);
  }
  const sceneResult = validateSceneV3(sceneRaw);
  if (!sceneResult.ok) return envelopeFail(prefixErrors(sceneResult.errors, '/scene'));

  const compositionErrors: ModelErrorV3[] = [];
  composeV3(sceneResult.normalized, contentResult.normalized, compositionErrors);
  if (compositionErrors.length > 0) return envelopeFail(compositionErrors.map(toEnvelopeError));

  return {
    ok: true,
    normalized: {
      storageVersion: 3,
      type: 'authoring-state',
      projectId,
      scene: sceneResult.normalized,
      content: contentResult.normalized,
      // Workspace-owned (§4.6): required present, carried unchanged.
      retry: root['retry'],
    },
  };
}

/**
 * Validate and re-emit the canonical v3 envelope (`workspace.md` §16.3 key
 * order). The `retry` block is carried through byte-preserving — the
 * workspace owns it and re-validates it (`§16.4` step 6).
 */
export function normalizeEnvelopeV3(root: unknown): EnvelopeV3Load {
  return validateEnvelopeV3(root);
}

// ---- pure v2 → v3 scene migration (§23.11) ----------------------------------

function noMigrationPath(from: unknown): ModelErrorV3 {
  return withFound(
    {
      code: 'no_migration_path',
      path: '/schemaVersion',
      message: 'migrateSceneV3 converts a schemaVersion 2 scene (or is the identity on schemaVersion 3)',
      expected: 'schemaVersion 2 or 3',
      hint: 'a v1 project uses migrateSceneV1ToV2 first; no direct v1→v3 conversion exists',
    },
    from,
  );
}

/**
 * §23.11 `migrateSceneV3(scene)`: the pure v2→v3 logical migration. Sets
 * `schemaVersion: 3` and carries every entity value, order and ID verbatim
 * (the v3 registry is a superset of v2, so no v2 entity needs editing).
 * Identity on a v3 input. A v1 (or unknown) source is refused with
 * `no_migration_path` and retained unchanged; the caller's input is never
 * mutated. The envelope-level copy operator (new identity, revision/retry/
 * history reset, resumable crash boundaries) is `workspace.md`
 * §16.5/§16.6 (packet 46).
 *
 * Post-condition: the RESULT is a valid, canonical v3 scene. Because the v3
 * registry is a strict superset, a schemaVersion-2-declared document is
 * converted by bumping the version and validating the v3 result — this keeps
 * the operator total and accepts v2-declared documents that already carry a
 * v3-only component (the committed migration fixture does; see handoff 44
 * CC-44-3, which asks whether §16.5.1's "loadable under the v2 pipeline"
 * source precondition should instead make that fixture a strict v2 scene).
 */
export function migrateSceneV3(doc: unknown): ModelResultV3<SceneV3> {
  const obj = isPlainObject(doc) ? doc : null;
  const from = obj === null ? undefined : obj['schemaVersion'];
  if (from === 3) {
    return validateSceneV3(doc);
  }
  if (obj !== null && from === 2) {
    const candidate = {
      schemaVersion: 3,
      sceneId: obj['sceneId'],
      revision: obj['revision'],
      entities: obj['entities'],
    };
    return validateSceneV3(candidate);
  }
  return fail([noMigrationPath(from)]);
}

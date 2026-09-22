/**
 * fixtures/m3/contracts/tools/check-fixtures.mjs
 *
 * Fixture consistency checker for packet 39's PROPOSED v3 model/storage/authoring
 * contracts (docs/planning/m3-contracts/{model,storage,authoring}.md and
 * docs/planning/m3-contracts/diffs/*).
 *
 * This is fixture tooling, NOT an implementation of the contracts. It contains
 * no storage, migration or command implementation. It verifies that the
 * committed fixtures are internally consistent and that the values they claim
 * are recomputable by an independent implementation of the declared rules:
 *
 *  1. canonical bytes (2-space indent, LF, one trailing newline, no BOM, no
 *     trailing whitespace) plus a strict parser with duplicate-key rejection;
 *  2. declared canonical key order in every known document shape;
 *  3. index coverage: every fixture on disk is listed and every listed file exists;
 *  4. every index `sha256`/`bytes` equals the real file, and every claimed
 *     `sourceDigest`/`sourceByteLength` equals a committed preimage;
 *  5. the version-combination table and the v3 validation order are re-derived
 *     independently for every envelope fixture and compared with the declared
 *     `{ result, path, reason }` (one rule per invalid fixture);
 *  6. valid v3 envelopes pass the same independent validation;
 *  7. the v2→v3 copy identity policy (verbatim entities/content except the
 *     §16.5.2 derived revision metadata reset, `game: null`, versions,
 *     revision 0, retry cleared, interrupted-copy suppression);
 *  8. the command scenario (revision/history arithmetic, derived-ID allocation,
 *     canonical created entity, inverse/redo equality, final document);
 *  9. the no-change cases and the reachable failure cases (independently
 *     re-derived where decidable; every declared code in the registry).
 *
 * Usage (repository root):
 *   node fixtures/m3/contracts/tools/check-fixtures.mjs
 *   TL39_FIXTURE_ROOT=<copy> node fixtures/m3/contracts/tools/check-fixtures.mjs
 *   node fixtures/m3/contracts/tools/check-fixtures.mjs --report out.json
 *
 * Exit 0 = all checks passed; 1 = at least one failed. The negative control in
 * verification.md copies the tree, corrupts one byte and runs this checker
 * against the copy; it must exit non-zero.
 *
 * Node: pinned Node 22 (`package.json` engines). No dependency, no eval.
 */

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.TL39_FIXTURE_ROOT ? resolve(process.env.TL39_FIXTURE_ROOT) : resolve(HERE, '..');

const failures = [];
const passes = [];
const fail = (check, detail) => failures.push({ check, detail });
const pass = (check, detail) => passes.push({ check, detail: detail ?? null });
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const jp = (v) => JSON.stringify(v);

// ---------------------------------------------------------------------------
// strict JSON parser (duplicate keys rejected, no eval)
// ---------------------------------------------------------------------------
function parseStrict(text) {
  let i = 0;
  const bad = (m) => { throw new Error(`${m} (offset ${i})`); };
  const ws = () => { while (i < text.length && ' \n\t\r'.includes(text[i])) i++; };
  function string() {
    i++; let out = '';
    while (i < text.length) {
      const c = text[i];
      if (c === '"') { i++; return out; }
      if (c === '\\') {
        const e = text[i + 1];
        if (e === 'u') {
          const hex = text.slice(i + 2, i + 6);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) bad('bad \\u escape');
          out += String.fromCharCode(parseInt(hex, 16)); i += 6; continue;
        }
        const map = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
        if (!(e in map)) bad('bad escape');
        out += map[e]; i += 2; continue;
      }
      if (c.charCodeAt(0) < 0x20) bad('raw control character');
      out += c; i++;
    }
    return bad('unterminated string');
  }
  function number() {
    const m = /^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?/.exec(text.slice(i));
    if (!m) return bad('bad number');
    i += m[0].length; return Number(m[0]);
  }
  function value() {
    ws();
    const c = text[i];
    if (c === '{') {
      i++; ws(); const o = {};
      if (text[i] === '}') { i++; return o; }
      for (;;) {
        ws(); if (text[i] !== '"') bad('object key must be a string');
        const k = string();
        if (Object.prototype.hasOwnProperty.call(o, k)) bad(`duplicate key ${jp(k)}`);
        ws(); if (text[i] !== ':') bad('expected :'); i++;
        o[k] = value(); ws();
        if (text[i] === ',') { i++; continue; }
        if (text[i] === '}') { i++; return o; }
        return bad('expected , or }');
      }
    }
    if (c === '[') {
      i++; ws(); const a = [];
      if (text[i] === ']') { i++; return a; }
      for (;;) {
        a.push(value()); ws();
        if (text[i] === ',') { i++; continue; }
        if (text[i] === ']') { i++; return a; }
        return bad('expected , or ]');
      }
    }
    if (c === '"') return string();
    if (text.startsWith('true', i)) { i += 4; return true; }
    if (text.startsWith('false', i)) { i += 5; return false; }
    if (text.startsWith('null', i)) { i += 4; return null; }
    return number();
  }
  const v = value();
  ws();
  if (i !== text.length) bad('trailing content');
  return v;
}

// ---------------------------------------------------------------------------
// canonical bytes and key order (model.md §23.7)
// ---------------------------------------------------------------------------
function checkCanonical(rel, text) {
  if (text.charCodeAt(0) === 0xfeff) fail('canonical', `${rel}: leading BOM`);
  if (text.includes('\r')) fail('canonical', `${rel}: CR present`);
  if (!text.endsWith('\n')) fail('canonical', `${rel}: missing trailing newline`);
  if (text.endsWith('\n\n')) fail('canonical', `${rel}: more than one trailing newline`);
  for (const line of text.split('\n')) {
    if (/[ \t]+$/.test(line)) { fail('canonical', `${rel}: trailing whitespace`); break; }
  }
  const parsed = parseStrict(text);
  if (JSON.stringify(parsed, null, 2) + '\n' !== text) fail('canonical', `${rel}: not byte-canonical`);
  return parsed;
}

const REGISTRY = ['transform', 'model', 'box', 'camera', 'behavior', 'prefab', 'collider', 'controller', 'gameZone', 'playerSpawn', 'cameraFollow', 'light', 'surface', 'modelAnimation'];
const COMPONENT_FIELDS = {
  transform: ['position', 'rotation', 'scale'],
  model: ['asset'],
  box: ['size', 'material'],
  camera: ['type', 'fovY', 'near', 'far'],
  behavior: ['behaviorId', 'values'],
  prefab: ['prefabId', 'localId'],
  collider: ['shape'],
  controller: [],
  gameZone: ['role', 'size', 'safeSpawnId', 'activation'],
  playerSpawn: [],
  cameraFollow: ['deadZone', 'smoothing', 'bounds'],
  light: ['type', 'color', 'intensity', 'direction', 'castShadow'],
  surface: ['color', 'roughness', 'metalness', 'emissive', 'emissiveIntensity'],
  modelAnimation: ['assetId', 'version', 'roles'],
};
const GAME_FIELDS = ['configVersion', 'title', 'objective', 'instructions', 'playerId', 'cameraId', 'spawnId', 'level', 'killY', 'cues'];
const CONTENT_FIELDS = ['assets', 'prefabs', 'behaviors', 'settings', 'behaviorTrust', 'game'];
const ASSET_FIELDS = ['assetId', 'kind', 'displayName', 'currentVersion', 'versions'];
const VERSION_FIELDS = ['version', 'sourceDigest', 'sourceByteLength', 'importRecipe', 'metrics', 'importedAt', 'publishedRevision'];
const RECIPE_FIELDS = ['profile', 'recipeVersion', 'toolchain', 'extensions'];
const METRIC_FIELDS = ['nodes', 'meshes', 'primitives', 'materials', 'images', 'textures', 'vertices', 'triangles', 'animations', 'animationChannels', 'clipDurationMs', 'decodedGeometryBytes', 'decodedImageBytes'];
// presentation.md §41.4.3 (packet 47, CC-44-2): an `kind: "audio"` version's
// metrics member is `PcmWavMetrics`, not the 13-field GLB member. The key-order
// rule is per-`kind`; both lists are exact for their profile.
const AUDIO_METRIC_FIELDS = ['container', 'encoding', 'channels', 'sampleRate', 'bitsPerSample', 'frames', 'durationMs', 'pcmBytes', 'dataChunkBytes', 'riffChunkBytes'];

function ordered(obj, keys, path, rel, sink) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return;
  const got = Object.keys(obj);
  const expected = keys.filter((k) => got.includes(k));
  if (!eq(got, expected)) sink.push(`${rel}${path} expected [${expected}] got [${got}]`);
}
function checkOrder(rel, env) {
  const errs = [];
  ordered(env, ['storageVersion', 'type', 'projectId', 'scene', 'content', 'retry'], '', rel, errs);
  ordered(env.scene, ['schemaVersion', 'sceneId', 'revision', 'entities'], '/scene', rel, errs);
  (env.scene?.entities ?? []).forEach((e, i) => {
    ordered(e, ['id', 'name', 'parentId', 'components'], `/scene/entities/${i}`, rel, errs);
    ordered(e.components, REGISTRY, `/scene/entities/${i}/components`, rel, errs);
    for (const [name, comp] of Object.entries(e.components ?? {})) {
      ordered(comp, COMPONENT_FIELDS[name] ?? Object.keys(comp), `/scene/entities/${i}/components/${name}`, rel, errs);
      if (name === 'gameZone' && comp.activation) ordered(comp.activation, ['emissive', 'emissiveIntensity', 'cueAssetId'], `/scene/entities/${i}/components/gameZone/activation`, rel, errs);
      if (name === 'cameraFollow') {
        ordered(comp.deadZone, ['x', 'y'], `/scene/entities/${i}/components/cameraFollow/deadZone`, rel, errs);
        ordered(comp.bounds, ['minX', 'maxX', 'minY', 'maxY'], `/scene/entities/${i}/components/cameraFollow/bounds`, rel, errs);
      }
    }
  });
  ordered(env.content, CONTENT_FIELDS, '/content', rel, errs);
  (env.content?.assets ?? []).forEach((a, i) => {
    ordered(a, ASSET_FIELDS, `/content/assets/${i}`, rel, errs);
    (a.versions ?? []).forEach((v, j) => {
      ordered(v, VERSION_FIELDS, `/content/assets/${i}/versions/${j}`, rel, errs);
      ordered(v.importRecipe, RECIPE_FIELDS, `/content/assets/${i}/versions/${j}/importRecipe`, rel, errs);
      ordered(v.metrics, a.kind === 'audio' ? AUDIO_METRIC_FIELDS : METRIC_FIELDS, `/content/assets/${i}/versions/${j}/metrics`, rel, errs);
    });
  });
  if (env.content?.game) {
    ordered(env.content.game, GAME_FIELDS, '/content/game', rel, errs);
    ordered(env.content.game.level, ['minX', 'maxX', 'minY', 'maxY'], '/content/game/level', rel, errs);
    ordered(env.content.game.cues, ['start', 'jump', 'checkpoint', 'death', 'goal'], '/content/game/cues', rel, errs);
  }
  if (errs.length) fail('key-order', errs.join('; '));
  else pass('key-order', rel);
}

// ---------------------------------------------------------------------------
// independent v3 validation (storage.md §S2/S4, model.md §23.8)
// ---------------------------------------------------------------------------
const LIMITS = { zones: 64, player_spawns: 16, lights_directional: 1, lights_ambient: 1 };
const PRESETS = {
  'matte-ground': { color: '#6f6f6f', roughness: 0.95, metalness: 0, emissive: '#000000', emissiveIntensity: 0 },
  hazard: { color: '#d42a1e', roughness: 0.55, metalness: 0, emissive: '#3a0703', emissiveIntensity: 0.35 },
  beacon: { color: '#2f7fd4', roughness: 0.4, metalness: 0.1, emissive: '#1bc8ff', emissiveIntensity: 1.2 },
};
const COMBOS = { 1: 1, 2: 2, 3: 3 };
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const err = (code, path, reason) => ({ code, path, ...(reason ? { reason } : {}) });

function validateV3(env) {
  if (![1, 2, 3].includes(env?.storageVersion)) return err('storage_version_unsupported', '/storageVersion');
  if (env.scene?.schemaVersion !== COMBOS[env.storageVersion]) return err('version_combination_unsupported', '/storageVersion');
  if (env.storageVersion !== 3) return err('storage_version_unsupported', '/storageVersion');
  const extra = Object.keys(env).filter((k) => !['storageVersion', 'type', 'projectId', 'scene', 'content', 'retry'].includes(k));
  if (extra.length) return err('envelope_invalid', `/${extra[0]}`);
  if (env.type !== 'authoring-state') return err('envelope_invalid', '/type');
  if (!env.content || typeof env.content !== 'object') return err('envelope_invalid', '/content');
  for (const k of CONTENT_FIELDS) if (!(k in env.content)) return err('envelope_invalid', `/content/${k}`, 'field_missing');
  for (const k of Object.keys(env.content)) if (!CONTENT_FIELDS.includes(k)) return err('envelope_invalid', `/content/${k}`);
  for (const [i, a] of (env.content.assets ?? []).entries()) {
    if (!['model', 'audio'].includes(a.kind)) return err('asset_kind_mismatch', `/content/assets/${i}/kind`);
    if (a.currentVersion !== (a.versions ?? []).length) return err('asset_version_invalid', `/content/assets/${i}/currentVersion`);
    for (const [j, v] of (a.versions ?? []).entries()) {
      if (v.version !== j + 1) return err('asset_version_invalid', `/content/assets/${i}/versions/${j}/version`);
      if (!/^[0-9a-f]{64}$/.test(v.sourceDigest)) return err('digest_invalid', `/content/assets/${i}/versions/${j}/sourceDigest`);
      // §18.9.2 rule 4: derived revision metadata never names a future revision.
      if (!Number.isInteger(v.publishedRevision) || v.publishedRevision < 0) return err('number_out_of_range', `/content/assets/${i}/versions/${j}/publishedRevision`);
      if (v.publishedRevision > env.scene.revision) return err('field_value', `/content/assets/${i}/versions/${j}/publishedRevision`);
    }
  }
  const g = env.content.game;
  if (g !== null) {
    if (!g || typeof g !== 'object') return err('game_config_invalid', '/content/game', 'field_type');
    for (const k of GAME_FIELDS) if (!(k in g)) return err('game_config_invalid', `/content/game/${k}`, 'field_missing');
    for (const k of Object.keys(g)) if (!GAME_FIELDS.includes(k)) return err('game_config_invalid', `/content/game/${k}`, 'field_unexpected');
    if (g.configVersion !== 1) return err('game_config_invalid', '/content/game/configVersion', 'field_value');
    for (const [k, max] of Object.entries({ title: 64, objective: 160, instructions: 320 })) {
      if (typeof g[k] !== 'string') return err('game_config_invalid', `/content/game/${k}`, 'field_type');
      if (g[k].length < 1 || g[k].length > max || /[\u0000-\u001f\u007f]/.test(g[k])) return err('game_config_invalid', `/content/game/${k}`, 'field_value');
    }
    for (const k of ['playerId', 'cameraId', 'spawnId']) if (typeof g[k] !== 'string') return err('game_config_invalid', `/content/game/${k}`, 'field_type');
    if (!g.level || typeof g.level !== 'object') return err('game_config_invalid', '/content/game/level', 'field_type');
    for (const k of ['minX', 'maxX', 'minY', 'maxY']) if (!isNum(g.level[k])) return err('game_config_invalid', `/content/game/level/${k}`, 'field_type');
    if (!(g.level.minX < g.level.maxX) || !(g.level.minY < g.level.maxY)) return err('game_config_invalid', '/content/game/level', 'field_value');
    if (!isNum(g.killY)) return err('game_config_invalid', '/content/game/killY', 'field_type');
    if (!(g.killY < g.level.maxY)) return err('game_config_invalid', '/content/game/killY', 'field_value');
    if (!g.cues || typeof g.cues !== 'object') return err('game_config_invalid', '/content/game/cues', 'field_type');
    for (const k of ['start', 'jump', 'checkpoint', 'death', 'goal']) {
      if (!(k in g.cues)) return err('game_config_invalid', `/content/game/cues/${k}`, 'field_missing');
      if (g.cues[k] !== null && typeof g.cues[k] !== 'string') return err('game_config_invalid', `/content/game/cues/${k}`, 'field_type');
    }
    for (const k of Object.keys(g.cues)) if (!['start', 'jump', 'checkpoint', 'death', 'goal'].includes(k)) return err('game_config_invalid', `/content/game/cues/${k}`, 'field_unexpected');
  }
  const ents = env.scene.entities;
  if (!Array.isArray(ents)) return err('field_type', '/scene/entities');
  // (a) registry + required transform
  for (const [i, e] of ents.entries()) {
    for (const name of Object.keys(e.components ?? {})) if (!REGISTRY.includes(name)) return err('component_unknown', `/scene/entities/${i}/components/${name}`);
    if (!e.components || !('transform' in e.components)) return err('component_missing', `/scene/entities/${i}/components`, 'transform');
  }
  // (b) per-component field validation (entity order, canonical component order)
  for (const [i, e] of ents.entries()) {
    const c = e.components;
    if (c.gameZone) {
      const z = c.gameZone;
      if (!['hazard', 'checkpoint', 'goal'].includes(z.role)) return err('field_value', `/scene/entities/${i}/components/gameZone/role`);
      if (!Array.isArray(z.size) || z.size.length !== 2 || !z.size.every((v) => isNum(v) && v > 0 && v <= 1e6)) return err('number_out_of_range', `/scene/entities/${i}/components/gameZone/size`);
      if (z.role === 'checkpoint') {
        if (!('safeSpawnId' in z)) return err('field_missing', `/scene/entities/${i}/components/gameZone/safeSpawnId`);
        if (!('activation' in z)) return err('field_missing', `/scene/entities/${i}/components/gameZone/activation`);
        const a = z.activation;
        for (const k of ['emissive', 'emissiveIntensity', 'cueAssetId']) if (!(k in a)) return err('field_missing', `/scene/entities/${i}/components/gameZone/activation/${k}`);
        if (typeof a.emissive !== 'string' || !/^#[0-9a-f]{6}$/.test(a.emissive)) return err('field_value', `/scene/entities/${i}/components/gameZone/activation/emissive`);
        if (!isNum(a.emissiveIntensity) || a.emissiveIntensity < 0 || a.emissiveIntensity > 4) return err('number_out_of_range', `/scene/entities/${i}/components/gameZone/activation/emissiveIntensity`);
        if (a.cueAssetId !== null && typeof a.cueAssetId !== 'string') return err('field_type', `/scene/entities/${i}/components/gameZone/activation/cueAssetId`);
      } else {
        if ('safeSpawnId' in z) return err('field_unexpected', `/scene/entities/${i}/components/gameZone/safeSpawnId`);
        if ('activation' in z) return err('field_unexpected', `/scene/entities/${i}/components/gameZone/activation`);
      }
    }
    if (c.playerSpawn && Object.keys(c.playerSpawn).length) return err('field_unexpected', `/scene/entities/${i}/components/playerSpawn`);
    if (c.light) {
      const l = c.light;
      if (!['directional', 'ambient'].includes(l.type)) return err('field_value', `/scene/entities/${i}/components/light/type`);
      if (l.type === 'directional') {
        if (!('direction' in l)) return err('field_missing', `/scene/entities/${i}/components/light/direction`);
        if (!Array.isArray(l.direction) || l.direction.length !== 3 || !l.direction.every((v) => isNum(v) && Math.abs(v) <= 1)) return err('number_out_of_range', `/scene/entities/${i}/components/light/direction`);
      } else if ('direction' in l || 'castShadow' in l) {
        return err('field_value', `/scene/entities/${i}/components/light/${'direction' in l ? 'direction' : 'castShadow'}`);
      }
    }
    if (c.surface) {
      for (const [k, lo, hi] of [['roughness', 0, 1], ['metalness', 0, 1], ['emissiveIntensity', 0, 4]]) {
        if (!isNum(c.surface[k]) || c.surface[k] < lo || c.surface[k] > hi) return err('number_out_of_range', `/scene/entities/${i}/components/surface/${k}`);
      }
    }
    if (c.modelAnimation) {
      const roles = c.modelAnimation.roles;
      if (!roles || typeof roles !== 'object') return err('field_type', `/scene/entities/${i}/components/modelAnimation/roles`);
      for (const k of ['idle', 'run', 'airborne']) if (!(k in roles)) return err('field_missing', `/scene/entities/${i}/components/modelAnimation/roles/${k}`);
      for (const k of Object.keys(roles)) if (!['idle', 'run', 'airborne'].includes(k)) return err('field_unexpected', `/scene/entities/${i}/components/modelAnimation/roles/${k}`);
      for (const k of ['idle', 'run', 'airborne']) if (!roles[k] || typeof roles[k] !== 'object' || Array.isArray(roles[k]) || Object.keys(roles[k]).length === 0) return err('field_value', `/scene/entities/${i}/components/modelAnimation/roles/${k}`);
      if (Buffer.byteLength(JSON.stringify(roles), 'utf8') > 4096) return err('limits_exceeded', `/scene/entities/${i}/components/modelAnimation/roles`, 'animation_profile_bytes');
    }
  }
  // (c) target/conflict rules
  for (const [i, e] of ents.entries()) {
    const c = e.components;
    if (c.surface && !c.box && !c.model) return err('component_missing', `/scene/entities/${i}/components/surface`);
    if (c.modelAnimation) {
      if (!c.model) return err('component_missing', `/scene/entities/${i}/components/modelAnimation`);
      if (c.modelAnimation.assetId !== c.model.asset?.assetId) return err('component_conflict', `/scene/entities/${i}/components/modelAnimation/assetId`, 'animation_asset');
    }
    if (c.cameraFollow && !c.camera) return err('component_conflict', `/scene/entities/${i}/components/cameraFollow`, 'camera_target');
    if (c.gameZone && (c.collider || c.controller)) return err('component_conflict', `/scene/entities/${i}/components/gameZone`, 'zone_physics');
    if (c.playerSpawn && (c.gameZone || c.collider || c.controller)) return err('component_conflict', `/scene/entities/${i}/components/playerSpawn`, 'spawn_target');
  }
  // (d) counts and required roles
  const zones = ents.filter((e) => e.components.gameZone);
  const byRole = (r) => zones.filter((e) => e.components.gameZone.role === r);
  if (zones.length > LIMITS.zones) return err('limits_exceeded', '/scene/entities', 'zones');
  if (ents.filter((e) => e.components.playerSpawn).length > LIMITS.player_spawns) return err('limits_exceeded', '/scene/entities', 'player_spawns');
  if (ents.filter((e) => e.components.light?.type === 'directional').length > LIMITS.lights_directional) return err('limits_exceeded', '/scene/entities', 'lights_directional');
  if (ents.filter((e) => e.components.light?.type === 'ambient').length > LIMITS.lights_ambient) return err('limits_exceeded', '/scene/entities', 'lights_ambient');
  if (byRole('checkpoint').length > 1) return err('zone_checkpoint_count_invalid', '/scene/entities');
  if (g !== null && byRole('goal').length < 1) return err('zone_goal_missing', '/scene/entities');
  // (e) zone/spawn transform rules (model.md §23.3.1/§23.3.2, §23.9: distinct codes)
  for (const [i, e] of ents.entries()) {
    if (!e.components.gameZone && !e.components.playerSpawn) continue;
    // a gameZone violation is zone_transform_unsupported; a playerSpawn violation
    // is spawn_transform_unsupported (same three conditions, separate code)
    const code = e.components.gameZone ? 'zone_transform_unsupported' : 'spawn_transform_unsupported';
    const t = e.components.transform ?? {};
    if (e.parentId !== undefined && e.parentId !== null) return err(code, `/scene/entities/${i}/parentId`, 'parented');
    if (!eq(t.scale ?? [1, 1, 1], [1, 1, 1])) return err(code, `/scene/entities/${i}/components/transform/scale`, 'scale');
    if (!eq(t.rotation ?? [0, 0, 0, 1], [0, 0, 0, 1])) return err(code, `/scene/entities/${i}/components/transform/rotation`, 'rotation');
  }
  // (f) scene-level game references
  if (g !== null) {
    const player = ents.find((e) => e.id === g.playerId);
    if (!player || !player.components.controller) return err('game_reference_missing', '/content/game/playerId', 'player');
    const cam = ents.find((e) => e.id === g.cameraId);
    if (!cam || !cam.components.camera) return err('game_reference_missing', '/content/game/cameraId', 'camera');
    if (!cam.components.cameraFollow) return err('game_reference_missing', '/content/game/cameraId', 'camera_follow');
    const spawn = ents.find((e) => e.id === g.spawnId);
    if (!spawn || !spawn.components.playerSpawn) return err('game_reference_missing', '/content/game/spawnId', 'spawn');
    for (const [i, e] of ents.entries()) {
      if (!e.components.gameZone || e.components.gameZone.role !== 'checkpoint') continue;
      const safe = ents.find((x) => x.id === e.components.gameZone.safeSpawnId);
      if (!safe || !safe.components.playerSpawn) return err('game_reference_missing', `/scene/entities/${i}/components/gameZone/safeSpawnId`, 'safe_spawn');
    }
  }
  // (g) cross-block asset resolution and kinds
  const assets = env.content.assets ?? [];
  const find = (id) => assets.find((a) => a.assetId === id);
  if (g !== null) {
    for (const k of ['start', 'jump', 'checkpoint', 'death', 'goal']) {
      const ref = g.cues?.[k];
      if (ref === null || ref === undefined) continue;
      const rec = find(ref);
      if (!rec) return err('asset_reference_missing', `/content/game/cues/${k}`);
      if (rec.kind !== 'audio') return err('asset_kind_mismatch', `/content/game/cues/${k}`, 'cue');
    }
  }
  for (const [i, e] of ents.entries()) {
    const act = e.components.gameZone?.activation;
    if (act && act.cueAssetId !== null) {
      const rec = find(act.cueAssetId);
      if (!rec) return err('asset_reference_missing', `/scene/entities/${i}/components/gameZone/activation/cueAssetId`);
      if (rec.kind !== 'audio') return err('asset_kind_mismatch', `/scene/entities/${i}/components/gameZone/activation/cueAssetId`, 'cue');
    }
    if (e.components.model?.asset) {
      const rec = find(e.components.model.asset.assetId);
      if (!rec) return err('asset_reference_missing', `/scene/entities/${i}/components/model/asset/assetId`);
      if (rec.kind !== 'model') return err('asset_kind_mismatch', `/scene/entities/${i}/components/model/asset/assetId`, 'model');
    }
    if (e.components.modelAnimation) {
      const rec = find(e.components.modelAnimation.assetId);
      if (!rec) return err('asset_reference_missing', `/scene/entities/${i}/components/modelAnimation/assetId`);
      if (e.components.modelAnimation.version > rec.currentVersion) return err('asset_version_invalid', `/scene/entities/${i}/components/modelAnimation/version`);
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// command replay (recorded change data; contract consistency, not production apply)
// ---------------------------------------------------------------------------
function derivedPrefix(e) {
  if (e.model) return 'model';
  if (e.box) return 'box';
  if (e.gameZone) return 'zone';
  if (e.playerSpawn) return 'spawn';
  if (e.light) return 'light';
  return 'group';
}
function allocId(env, prefix) {
  const taken = new Set(env.scene.entities.map((e) => e.id));
  for (let n = 1; n <= 9999; n++) {
    const id = `${prefix}-${String(n).padStart(4, '0')}`;
    if (!taken.has(id)) return id;
  }
  return null;
}
function entityFromArgs(args) {
  const e = { id: null };
  if (args.name) e.name = args.name;
  const t = args.transform ?? {};
  const components = { transform: { position: t.position ?? [0, 0, 0], rotation: t.rotation ?? [0, 0, 0, 1], scale: t.scale ?? [1, 1, 1] } };
  if (args.kind === 'box') components.box = args.box ? { size: args.box.size ?? [1, 1, 1], material: { color: (args.box.material?.color ?? '#b0b0b0').toLowerCase() } } : { size: [1, 1, 1], material: { color: '#b0b0b0' } };
  if (args.kind === 'model') components.model = { asset: { assetId: args.model.asset.assetId } };
  for (const [name, value] of Object.entries(args.components ?? {})) components[name] = value;
  const out = {};
  for (const name of REGISTRY) if (name in components) out[name] = components[name];
  e.components = out;
  return e;
}
function replayScenario(beforeRel, messagesRel, afterRel) {
  const state = JSON.parse(readTextRaw(beforeRel));
  const messages = readJson(messagesRel).messages;
  const after = readJson(afterRel);
  let undoDepth = 0, redoDepth = 0;
  const problems = [];
  for (const m of messages) {
    const rev = state.scene.revision;
    if (m.expectedRevision !== rev) problems.push(`m${m.seq}: expectedRevision ${m.expectedRevision} != state ${rev}`);
    if (m.result.revision !== rev + 1) problems.push(`m${m.seq}: result.revision ${m.result.revision} != ${rev + 1}`);
    const c = m.result.change;
    if (m.op === 'createEntity') {
      const prefix = derivedPrefix(m.args.kind === 'box' ? { box: true } : m.args.kind === 'model' ? { model: true } : (m.args.components ?? {}));
      const id = allocId(state, prefix);
      if (id !== m.result.createdId) problems.push(`m${m.seq}: allocated ${id} != ${m.result.createdId}`);
      const built = entityFromArgs(m.args);
      built.id = m.result.createdId;
      if (!eq(built, c.entity)) problems.push(`m${m.seq}: canonical created entity mismatch`);
      state.scene.entities.push(JSON.parse(JSON.stringify(c.entity)));
      undoDepth += 1; redoDepth = 0;
    } else if (m.op === 'applySurfacePreset') {
      const target = state.scene.entities.find((e) => e.id === m.args.entityId);
      if (!target) problems.push(`m${m.seq}: entity missing`);
      else {
        if (!eq(target.components.surface ?? null, c.previous)) problems.push(`m${m.seq}: previous surface mismatch`);
        if (!eq(PRESETS[m.args.preset], c.next)) problems.push(`m${m.seq}: preset row mismatch`);
        target.components.surface = JSON.parse(JSON.stringify(c.next));
      }
      undoDepth += 1; redoDepth = 0;
    } else if (m.op === 'setGameConfig') {
      if (!eq(state.content.game, c.previous)) problems.push(`m${m.seq}: previous game mismatch`);
      state.content.game = c.next === null ? null : JSON.parse(JSON.stringify(c.next));
      undoDepth += 1; redoDepth = 0;
    } else if (m.op === 'undo' || m.op === 'redo') {
      state.content.game = c.next === null ? null : JSON.parse(JSON.stringify(c.next));
      if (m.op === 'undo') { undoDepth -= 1; redoDepth += 1; } else { undoDepth += 1; redoDepth -= 1; }
    } else problems.push(`m${m.seq}: unknown op ${m.op}`);
    state.scene.revision = m.result.revision;
    if (!eq(m.result.history, { undoDepth, redoDepth })) problems.push(`m${m.seq}: history ${jp(m.result.history)} != ${jp({ undoDepth, redoDepth })}`);
  }
  if (!eq(state, after)) problems.push('final state != scenario.after.json');
  const m1 = messages.find((m) => m.seq === 1), m5 = messages.find((m) => m.seq === 5), m6 = messages.find((m) => m.seq === 6), m7 = messages.find((m) => m.seq === 7);
  if (!eq(m5.result.change.next, m6.result.change.previous)) problems.push('inverse: m6.previous != m5.next');
  if (m6.result.change.next !== null) problems.push('inverse: m6.next must be null');
  if (!eq(m7.result.change.next, m5.result.change.next)) problems.push('redo: m7.next != m5.next');
  if (!eq(m1.inverse, { kind: 'delete', rootId: m1.result.createdId })) problems.push('m1.inverse must delete the created id');
  return problems;
}

// ---------------------------------------------------------------------------
// io helpers
// ---------------------------------------------------------------------------
const cache = new Map();
function readTextRaw(rel) {
  if (!cache.has(rel)) cache.set(rel, readFileSync(join(ROOT, rel), 'utf8'));
  return cache.get(rel);
}
function readJson(rel) { return JSON.parse(readTextRaw(rel)); }
function walk(dir, base = dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, base, out);
    else out.push(relative(base, p));
  }
  return out;
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
const index = readJson('index.json');
const preimage = new Map();
for (const [rel, meta] of Object.entries(index.fixtures)) {
  if (meta.kind !== 'source-preimage') continue;
  const buf = readFileSync(join(ROOT, rel));
  preimage.set(sha256(buf), { rel, bytes: buf.length });
}

// group 1: index coverage, canonical bytes, digests
const EXCLUDED = new Set(['README.md', 'verification.md', 'index.json']);
const onDisk = walk(ROOT).filter((p) => !EXCLUDED.has(p) && !p.startsWith('tools/'));
const listed = new Set(Object.keys(index.fixtures));
for (const rel of onDisk) if (!listed.has(rel)) fail('index-orphan', rel);
for (const rel of listed) {
  let buf;
  try { buf = readFileSync(join(ROOT, rel)); } catch { fail('index-dangling', rel); continue; }
  const meta = index.fixtures[rel];
  if (meta.sha256 !== sha256(buf)) fail('digest', `${rel}: sha256 mismatch`);
  if (meta.bytes !== buf.length) fail('digest', `${rel}: byte length mismatch`);
  if (!rel.endsWith('.json')) continue;
  let doc;
  try { doc = checkCanonical(rel, buf.toString('utf8')); } catch (e) { fail('parse', `${rel}: ${e.message}`); continue; }
  if ((meta.kind === 'v3-envelope-valid' || meta.kind === 'migration' || rel.startsWith('commands/scenario.')) && doc.storageVersion !== undefined && doc.scene) checkOrder(rel, doc);
}
pass('index-coverage', `${listed.size} fixtures, ${onDisk.length} files on disk`);

// group 2: preimage digests referenced by fixtures
function collectDigestRefs(value, out = [], path = '') {
  if (Array.isArray(value)) value.forEach((v, i) => collectDigestRefs(v, out, `${path}/${i}`));
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      if (k === 'sourceDigest' && typeof v === 'string') out.push({ digest: v, path: `${path}/${k}`, byteLength: value.sourceByteLength });
      else collectDigestRefs(v, out, `${path}/${k}`);
    }
  }
  return out;
}
let digestRefs = 0;
for (const [rel, meta] of Object.entries(index.fixtures)) {
  if (!['v3-envelope-valid', 'catalog'].includes(meta.kind)) continue;
  for (const ref of collectDigestRefs(readJson(rel))) {
    digestRefs++;
    const pre = preimage.get(ref.digest);
    if (!pre) fail('preimage', `${rel}${ref.path}: no committed preimage for ${ref.digest}`);
    else if (ref.byteLength !== undefined && ref.byteLength !== pre.bytes) fail('preimage', `${rel}${ref.path}: byte length ${ref.byteLength} != ${pre.bytes}`);
  }
}
pass('preimage-digests', `${digestRefs} digest references`);

// group 3: version combinations and v3 validation
let envelopeChecked = 0;
for (const [rel, meta] of Object.entries(index.fixtures)) {
  if (meta.kind === 'v3-envelope-valid') {
    const result = validateV3(readJson(rel));
    if (result) fail('v3-valid', `${rel}: unexpected ${jp(result)}`);
    else pass('v3-valid', rel);
    envelopeChecked++;
  } else if (meta.kind === 'v3-envelope-invalid') {
    const result = validateV3(readJson(rel));
    const exp = meta.expect ?? {};
    if (!result) fail('v3-invalid', `${rel}: expected ${exp.result} but validation passed`);
    else {
      const got = { result: result.code, path: result.path, ...(result.reason ? { reason: result.reason } : {}) };
      const want = { result: exp.result, path: exp.path, ...(exp.reason ? { reason: exp.reason } : {}) };
      if (!eq(got, want)) fail('v3-invalid', `${rel}: got ${jp(got)} want ${jp(want)}`);
      else pass('v3-invalid', rel);
    }
    envelopeChecked++;
  }
}
pass('envelope-rules', `${envelopeChecked} envelope fixtures`);

// group 4: migration identity + interrupted copy
{
  const SRC_REL = 'migration/v2-source/envelope.json';
  const DST_REL = 'migration/expected-v3-destination/envelope.json';
  const src = readJson(SRC_REL);
  const dst = readJson(DST_REL);
  const srcMeta = index.fixtures[SRC_REL] ?? {};
  const dstMeta = index.fixtures[DST_REL] ?? {};
  const problems = [];
  // §16.5.1/§23.11: the source must be loadable under the v2 pipeline; a
  // v2-labeled scene carrying a v3-only component is component_unknown there.
  const V3_ONLY = ['gameZone', 'playerSpawn', 'cameraFollow', 'light', 'surface', 'modelAnimation'];
  const v3OnlyFound = [];
  for (const [i, e] of (src.scene.entities ?? []).entries()) {
    for (const name of Object.keys(e.components ?? {})) if (V3_ONLY.includes(name)) v3OnlyFound.push(`/scene/entities/${i}/components/${name}`);
  }
  if (v3OnlyFound.length) problems.push(`v2 source must not carry v3-only components: ${v3OnlyFound.join(', ')}`);
  if (!Number.isInteger(srcMeta.expect?.v3OnlyComponents) || srcMeta.expect.v3OnlyComponents !== v3OnlyFound.length) {
    problems.push(`index expect.v3OnlyComponents ${jp(srcMeta.expect?.v3OnlyComponents)} != re-derived ${v3OnlyFound.length}`);
  }
  if ((srcMeta.expect?.sceneSchemaVersion ?? null) !== src.scene.schemaVersion) problems.push('index expect.sceneSchemaVersion != source scene.schemaVersion');
  if (src.storageVersion !== 2) problems.push('source must be storageVersion 2');
  if (src.scene.schemaVersion !== 2) problems.push('source scene must be schemaVersion 2');
  // §16.5.1 requires the source to be loadable under the v2 pipeline, which
  // includes the §4.3 step-7 retry block: each record must be a §5.1 success
  // payload, not a stub. CC-46-1 repair: the fixture used to carry
  // `result: {ok: true}`, which the real loader refuses (`retry_records_invalid`
  // at `/result/op`), so this minimal shape check keeps that class of defect
  // from regressing.
  {
    const REQ_RE = /^req-[0-9a-f]{32}$/;
    const DIG_RE = /^[0-9a-f]{64}$/;
    const records = src.retry?.records;
    if (!Array.isArray(records)) problems.push('source retry.records must be an array');
    else {
      let prev = -1;
      for (const [i, r] of records.entries()) {
        const at = `/retry/records/${i}`;
        if (typeof r?.requestId !== 'string' || !REQ_RE.test(r.requestId)) problems.push(`source ${at}/requestId must be req- plus 32 hex chars`);
        if (typeof r?.digest !== 'string' || !DIG_RE.test(r.digest)) problems.push(`source ${at}/digest must be 64 hex chars`);
        if (!Number.isInteger(r?.appliedRevision) || r.appliedRevision < 0 || r.appliedRevision > src.scene.revision) problems.push(`source ${at}/appliedRevision must be an integer in 0..${src.scene.revision}`);
        if (Number.isInteger(r?.appliedRevision)) {
          if (r.appliedRevision <= prev) problems.push(`source ${at}/appliedRevision must be strictly ascending`);
          prev = r.appliedRevision;
        }
        const res = r?.result;
        if (res === null || typeof res !== 'object') problems.push(`source ${at}/result must be a §5.1 result object (not a stub)`);
        else if (typeof res.op !== 'string' || res.op.length === 0) problems.push(`source ${at}/result must carry a known op string (not a stub)`);
        else if (res.revision !== r.appliedRevision) problems.push(`source ${at}/result/revision must equal appliedRevision`);
      }
    }
  }
  if (dst.storageVersion !== 3) problems.push('destination storageVersion must be 3');
  if (dst.scene.schemaVersion !== 3) problems.push('destination scene schemaVersion must be 3');
  if ((dstMeta.expect?.sceneSchemaVersion ?? null) !== dst.scene.schemaVersion) problems.push('index expect.sceneSchemaVersion != destination scene.schemaVersion');
  if (dst.projectId === src.projectId) problems.push('destination must be a new project identity');
  if (dst.scene.revision !== 0) problems.push('destination revision must reset to 0');
  if (dstMeta.expect?.revision !== dst.scene.revision) problems.push('index expect.revision != destination scene.revision');
  if (!eq(dst.scene.entities, src.scene.entities)) problems.push('entities must be carried verbatim');
  // §16.5.2: content is copied byte-identically except that the derived revision
  // metadata (versions[j].publishedRevision, behaviors[i].publishedRevision,
  // behaviors[i].source.publishedRevision, behaviorTrust.entries[k].acknowledgedRevision)
  // is reset to 0 for the new project identity.
  const zeroDerived = (content) => {
    const out = JSON.parse(JSON.stringify(content));
    for (const a of out.assets ?? []) for (const v of a.versions ?? []) v.publishedRevision = 0;
    for (const b of out.behaviors ?? []) {
      b.publishedRevision = 0;
      if (b.source) b.source.publishedRevision = 0;
    }
    for (const e of out.behaviorTrust?.entries ?? []) e.acknowledgedRevision = 0;
    return out;
  };
  const expectedContent = zeroDerived(src.content);
  for (const k of ['assets', 'prefabs', 'behaviors', 'settings', 'behaviorTrust']) {
    if (!eq(dst.content[k], expectedContent[k])) problems.push(`content.${k} must be carried verbatim except for the derived revision reset`);
  }
  const derivedReset = eq(zeroDerived(dst.content), dst.content);
  if (!derivedReset) problems.push('destination derived revision metadata must all be 0');
  if (dstMeta.expect?.derivedRevisionsReset !== true) problems.push('index expect.derivedRevisionsReset must be declared true');
  const srcHasDerived = (src.content.assets ?? []).some((a) => (a.versions ?? []).some((v) => v.publishedRevision > 0))
    || (src.content.behaviors ?? []).some((b) => b.publishedRevision > 0 || (b.source != null && b.source.publishedRevision > 0))
    || (src.content.behaviorTrust?.entries ?? []).some((e) => e.acknowledgedRevision > 0);
  if (!srcHasDerived) problems.push('source must carry a non-zero derived revision value so the reset is exercised');
  if (dst.content.game !== null) problems.push('destination content.game must be null');
  if (!eq(dst.retry.records, [])) problems.push('destination retry.records must be cleared');
  if (dst.retry.retention !== 128) problems.push('destination retention must stay 128');
  const bad = validateV3(dst);
  if (bad) problems.push(`destination invalid: ${jp(bad)}`);
  if (dstMeta.expect?.loadable !== true) problems.push('index expect.loadable must be declared true');
  if (bad) problems.push('the destination must be loadable (CC-44-4)');
  const caseFile = readJson('migration/interrupted-copy/case.json');
  if (caseFile.expect.startupScan !== 'migration_resume_required') problems.push('interrupted case must expect migration_resume_required');
  if (!caseFile.expect.defaultEnvelopeSuppressed) problems.push('interrupted case must suppress the default envelope');
  const marker = readJson('migration/interrupted-copy/marker.json');
  if (marker.type !== 'migration-copy' || marker.storageVersion !== 3 || marker.phase !== 'created') problems.push('marker shape wrong');
  for (const p of onDisk) if (p.startsWith('migration/interrupted-copy/') && p.endsWith('envelope.json')) problems.push('interrupted copy must not contain an envelope');
  if (problems.length) fail('migration', problems.join('; '));
  else pass('migration', 'identity/reset/verbatim/interrupted');
}

// group 5: command scenario replay
{
  const problems = replayScenario('commands/scenario.before.json', 'commands/scenario.messages.json', 'commands/scenario.after.json');
  if (problems.length) fail('scenario', problems.join('; '));
  else pass('scenario', 'revision/history/ID/inverse/redo/final');
}

// group 6: no-change replay
{
  const nc = readJson('commands/no-change.json');
  const state = readJson(nc.state);
  const problems = [];
  for (const m of nc.messages) {
    const c = JSON.parse(JSON.stringify(state));
    if (m.op === 'applySurfacePreset') c.scene.entities.find((e) => e.id === m.args.entityId).components.surface = { ...PRESETS[m.args.preset] };
    else if (m.op === 'setGameConfig') c.content.game = { ...m.args.game };
    else if (m.op === 'setComponent') c.scene.entities.find((e) => e.id === m.args.entityId).components[m.args.component] = { ...m.args.value };
    if (!eq(c, state)) problems.push(`${m.requestId}: recomputed state differs, so no_change is wrong`);
    if (m.expect.code !== 'no_change') problems.push(`${m.requestId}: expect must be no_change`);
  }
  if (problems.length) fail('no-change', problems.join('; '));
  else pass('no-change', `${nc.messages.length} cases`);
}

// group 7: reachable failures
{
  const f = readJson('commands/failures.json');
  const problems = [];
  const registry = new Set([...index.registry.modelErrorCodes, ...index.registry.commandErrorCodes]);
  const decidable = {
    F1: (st) => (st.scene.entities.some((e) => e.components.gameZone?.safeSpawnId === 'spawn-0002') ? 'game_reference_in_use' : null),
    F2: (st) => (st.content.game.playerId === 'group-0001' ? 'game_reference_in_use' : null),
    F3: (st) => (st.content.game.spawnId === 'spawn-0001' ? 'game_reference_in_use' : null),
    F4: (st) => (st.scene.entities.some((e) => e.id === 'zone-0003') ? 'ok' : null),
    F5: (st) => (st.scene.entities.find((e) => e.id === 'zone-0002').components.gameZone ? 'component_conflict' : null),
    F6: (st) => { const e = st.scene.entities.find((x) => x.id === 'group-0001'); return !e.components.box && !e.components.model ? 'component_missing' : null; },
    F7: (st) => { const e = st.scene.entities.find((x) => x.id === 'group-0001'); return !e.components.box && !e.components.model ? 'component_missing' : null; },
    F8: (st) => { const e = st.scene.entities.find((x) => x.id === 'light-0002'); return e.components.light.type === 'ambient' ? 'field_value' : null; },
    F9: (st) => (st.scene.entities.some((e) => e.id === 'spawn-0001') ? 'field_unexpected' : null),
    F11: (st, m) => (st.scene.revision !== m.expectedRevision ? 'revision_conflict' : null),
    F12: (st) => { const e = st.scene.entities.find((x) => x.id === 'zone-0002'); return e.components.gameZone.role === 'hazard' ? 'field_missing' : null; },
  };
  for (const m of f.cases) {
    const st = readJson(m.state);
    if (!registry.has(m.expect.code) && m.expect.code !== 'ok') problems.push(`${m.id}: code ${m.expect.code} not in registry`);
    if (m.expectedRevision !== undefined && m.expectedRevision !== st.scene.revision && m.expect.code !== 'revision_conflict') problems.push(`${m.id}: expectedRevision mismatch`);
    const fn = decidable[m.id];
    if (fn) {
      const got = fn(st, m);
      if (got !== m.expect.code) problems.push(`${m.id}: re-derived ${got} != declared ${m.expect.code}`);
    }
  }
  if (problems.length) fail('failures', problems.join('; '));
  else pass('failures', `${f.cases.length} cases`);
}

// group 8: every invalid fixture declares a code+path (and a reason where the
// contract makes one mandatory, e.g. game_config_invalid path+reason)
const REASON_REQUIRED = new Set(['game_config_invalid', 'game_reference_missing', 'zone_transform_unsupported', 'spawn_transform_unsupported']);
{
  const problems = [];
  for (const [rel, meta] of Object.entries(index.fixtures)) {
    if (meta.kind !== 'v3-envelope-invalid') continue;
    if (!meta.expect?.result || !meta.expect?.path) { problems.push(rel); continue; }
    if (REASON_REQUIRED.has(meta.expect.result) && !meta.expect.reason) problems.push(`${rel}: ${meta.expect.result} must carry a reason`);
  }
  if (problems.length) fail('expectations', problems.join(','));
  else pass('expectations', 'every invalid fixture declares code and path (+ the required reason)');
}

// ---------------------------------------------------------------------------
const reportAt = process.argv.indexOf('--report');
if (reportAt >= 0) writeFileSync(process.argv[reportAt + 1], JSON.stringify({ root: ROOT, passes, failures }, null, 2) + '\n');
console.log(`check-fixtures (packet 39) root=${ROOT}`);
console.log(`  groups passed: ${passes.length}`);
for (const f of failures) console.log(`  FAIL [${f.check}] ${f.detail}`);
console.log(failures.length ? `  ${failures.length} failure(s)` : '  all checks passed');
process.exit(failures.length ? 1 : 0);

/**
 * fixtures/m3/storage/tools/check-fixtures.mjs
 *
 * Fixture consistency checker for packet 46's durable v3 storage and the
 * v2→v3 copy operator (`docs/contracts/workspace.md` §16).
 *
 * This is fixture tooling, NOT an implementation of the workspace. It contains
 * no storage engine, no migration operator and no fs writer. It re-derives,
 * from the committed bytes and the committed rules:
 *
 *  1. `index.json` coverage, byte lengths and SHA-256 of every fixture file;
 *  2. canonical JSON bytes (2-space indent, LF, one trailing newline, no BOM)
 *     with a strict parser (duplicate keys rejected);
 *  3. the v3 project fixture: `storageVersion` 3, the six-key envelope and
 *     six-key content order, `scene.schemaVersion` 3, a bounded `game` block,
 *     manifest `schemaVersion` 1 with the identity agreement;
 *  4. the v2 source fixture: `storageVersion` 2, the five-key content order,
 *     `scene.schemaVersion` 2, no v3-only component, and a non-zero derived
 *     revision value (so the copy's reset is exercised);
 *  5. the §16.5.2 destination derivation from the committed source (new
 *     identity, revision 0, entities verbatim, content verbatim except the
 *     four derived revision resets, `game: null`, retry cleared), cross-checked
 *     against `fixtures/m3/contracts/migration/expected-v3-destination`;
 *  6. the `cases/migration.json` operator/marker/report/refusal declarations;
 *  7. the `cases/durability.json` ack timing, crash-point rows, single mutable
 *     file and no-sidecar rule;
 *  8. the `cases/media.json` typed prepared-media facts and copy-safe byte
 *     reads.
 *
 * Usage (repository root):
 *   node fixtures/m3/storage/tools/check-fixtures.mjs
 *   TL46_FIXTURE_ROOT=<copy> node fixtures/m3/storage/tools/check-fixtures.mjs
 *   node fixtures/m3/storage/tools/check-fixtures.mjs --corrupt-control
 *
 * Exit 0 = all checks passed; 1 = at least one failed. `--corrupt-control`
 * makes deliberate corrupted copies and requires every one to be detected
 * (exit non-zero for a corrupted tree, 0 only when all corruptions fail the
 * checks).
 *
 * Node: pinned Node 22 (`package.json` engines). No dependency, no eval.
 */

import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = resolve(HERE, '..');
const CORRUPT = process.argv.includes('--corrupt-control');

const TOP_KEYS = ['storageVersion', 'type', 'projectId', 'scene', 'content', 'retry'];
const V3_CONTENT_KEYS = ['assets', 'prefabs', 'behaviors', 'settings', 'behaviorTrust', 'game'];
const V2_CONTENT_KEYS = ['assets', 'prefabs', 'behaviors', 'settings', 'behaviorTrust'];
const V3_ONLY = ['gameZone', 'playerSpawn', 'cameraFollow', 'light', 'surface', 'modelAnimation'];
const PHASES = ['created', 'manifest', 'blobs', 'envelope'];

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const jp = (v) => JSON.stringify(v);

// ---- strict JSON parser (duplicate keys rejected, no eval) -------------------
function parseStrict(text) {
  let i = 0;
  const ws = () => {
    while (i < text.length && (text[i] === ' ' || text[i] === '\n' || text[i] === '\r' || text[i] === '\t')) i++;
  };
  const fail = (msg) => {
    throw new Error(`${msg} at ${i}`);
  };
  const value = () => {
    ws();
    const c = text[i];
    if (c === '{') return object();
    if (c === '[') return array();
    if (c === '"') return string();
    if (c === '-' || (c >= '0' && c <= '9')) return number();
    if (text.startsWith('true', i)) {
      i += 4;
      return true;
    }
    if (text.startsWith('false', i)) {
      i += 5;
      return false;
    }
    if (text.startsWith('null', i)) {
      i += 4;
      return null;
    }
    return fail('unexpected token');
  };
  const object = () => {
    i++;
    const out = {};
    const seen = new Set();
    ws();
    if (text[i] === '}') {
      i++;
      return out;
    }
    for (;;) {
      ws();
      if (text[i] !== '"') fail('expected object key');
      const k = string();
      if (seen.has(k)) fail(`duplicate object key ${jp(k)}`);
      seen.add(k);
      ws();
      if (text[i] !== ':') fail('expected colon');
      i++;
      out[k] = value();
      ws();
      if (text[i] === ',') {
        i++;
        continue;
      }
      if (text[i] === '}') {
        i++;
        return out;
      }
      return fail('expected , or }');
    }
  };
  const array = () => {
    i++;
    const out = [];
    ws();
    if (text[i] === ']') {
      i++;
      return out;
    }
    for (;;) {
      out.push(value());
      ws();
      if (text[i] === ',') {
        i++;
        continue;
      }
      if (text[i] === ']') {
        i++;
        return out;
      }
      return fail('expected , or ]');
    }
  };
  const string = () => {
    if (text[i] !== '"') fail('expected string');
    i++;
    let out = '';
    while (i < text.length) {
      const c = text[i];
      if (c === '"') {
        i++;
        return out;
      }
      if (c === '\\') {
        const e = text[i + 1];
        if (e === 'u') {
          out += String.fromCharCode(parseInt(text.slice(i + 2, i + 6), 16));
          i += 6;
          continue;
        }
        const map = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
        if (!(e in map)) fail('bad escape');
        out += map[e];
        i += 2;
        continue;
      }
      out += c;
      i++;
    }
    return fail('unterminated string');
  };
  const number = () => {
    const start = i;
    if (text[i] === '-') i++;
    while (i < text.length && text[i] >= '0' && text[i] <= '9') i++;
    if (text[i] === '.') {
      i++;
      while (i < text.length && text[i] >= '0' && text[i] <= '9') i++;
    }
    if (text[i] === 'e' || text[i] === 'E') {
      i++;
      if (text[i] === '+' || text[i] === '-') i++;
      while (i < text.length && text[i] >= '0' && text[i] <= '9') i++;
    }
    return Number(text.slice(start, i));
  };
  const out = value();
  ws();
  if (i !== text.length) fail('trailing content');
  return out;
}

// ---- checks ------------------------------------------------------------------
function check(root) {
  const failures = [];
  const passes = [];
  const fail = (check, detail) => failures.push({ check, detail });
  const pass = (check, detail) => passes.push({ check, detail: detail === undefined ? null : detail });
  const read = (rel) => readFileSync(join(root, rel));
  const readText = (rel) => readFileSync(join(root, rel), 'utf8');
  const json = (rel) => parseStrict(readText(rel));

  // 1. index coverage
  let index = null;
  try {
    index = json('index.json');
    pass('index', 'index.json parsed strictly');
  } catch (e) {
    fail('index', `index.json unreadable: ${e.message}`);
    return { failures, passes };
  }
  const walk = (d) => {
    const out = [];
    for (const n of readdirSync(d).sort()) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) out.push(...walk(p));
      else out.push(p);
    }
    return out;
  };
  const indexed = new Set(Object.keys(index.files ?? {}));
  const skip = (rel) => rel === 'index.json' || rel.startsWith('tools/') || rel === 'README.md' || rel === 'verification.md';
  for (const f of walk(root)) {
    const rel = relative(root, f).split('\\').join('/');
    if (skip(rel)) continue;
    const meta = index.files?.[rel];
    if (meta === undefined) {
      fail('index', `missing index entry for ${rel}`);
      continue;
    }
    const bytes = readFileSync(f);
    if (meta.bytes !== bytes.length) fail('index', `${rel}: indexed bytes ${meta.bytes} != ${bytes.length}`);
    const h = sha256(bytes);
    if (meta.sha256 !== h) fail('index', `${rel}: indexed sha256 ${meta.sha256} != ${h}`);
    indexed.delete(rel);
  }
  for (const rel of indexed) fail('index', `indexed file is absent: ${rel}`);
  if (failures.length === 0) pass('index', `${Object.keys(index.files).length} files hashed exactly`);

  // 2. canonical bytes for every JSON fixture
  const jsonFiles = Object.keys(index.files).filter((r) => r.endsWith('.json'));
  for (const rel of jsonFiles) {
    const bytes = read(rel);
    if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
      fail('canonical', `${rel}: BOM present`);
      continue;
    }
    const text = readText(rel);
    if (!text.endsWith('\n')) fail('canonical', `${rel}: no trailing newline`);
    if (/\n\s*\n$/.test(text)) fail('canonical', `${rel}: blank line before EOF`);
    try {
      const doc = parseStrict(text);
      const rebuilt = JSON.stringify(doc, null, 2) + '\n';
      if (rebuilt !== text) fail('canonical', `${rel}: bytes are not canonical JSON`);
    } catch (e) {
      fail('canonical', `${rel}: ${e.message}`);
    }
  }
  if (!failures.some((f) => f.check === 'canonical')) pass('canonical', `${jsonFiles.length} JSON files canonical and strict`);
  else pass('canonical', 'canonical checks recorded failures');

  // 3. the v3 project fixture
  try {
    const manifest = json('project-v3-demo-0003/project.json');
    const env = json('project-v3-demo-0003/scenes/main.json');
    if (manifest.schemaVersion !== 1) fail('project-v3', 'manifest schemaVersion must be 1');
    if (manifest.id !== 'demo-0003') fail('project-v3', 'manifest id must be demo-0003');
    if (env.storageVersion !== 3) fail('project-v3', 'envelope storageVersion must be 3');
    if (env.type !== 'authoring-state') fail('project-v3', 'envelope type must be authoring-state');
    if (env.projectId !== manifest.id) fail('project-v3', 'envelope projectId must equal the manifest id');
    if (!eq(Object.keys(env), TOP_KEYS)) fail('project-v3', `top-level key order must be ${TOP_KEYS.join(',')} (got ${Object.keys(env).join(',')})`);
    if (env.scene.schemaVersion !== 3) fail('project-v3', 'scene.schemaVersion must be 3');
    if (manifest.scenes[0].id !== env.scene.sceneId) fail('project-v3', 'manifest scene id must equal the envelope sceneId');
    if (manifest.scenes[0].path !== 'scenes/main.json') fail('project-v3', 'manifest scene path must be scenes/main.json');
    if (!eq(Object.keys(env.content), V3_CONTENT_KEYS)) fail('project-v3', `content key order must be ${V3_CONTENT_KEYS.join(',')}`);
    if (env.content.game === null || typeof env.content.game !== 'object') {
      fail('project-v3', 'the v3 fixture must carry a non-null game block');
    } else {
      const g = env.content.game;
      const gkeys = ['configVersion', 'title', 'objective', 'instructions', 'playerId', 'cameraId', 'spawnId', 'level', 'killY', 'cues'];
      if (!eq(Object.keys(g), gkeys)) fail('project-v3', `game key order must be ${gkeys.join(',')}`);
      if (!eq(Object.keys(g.cues), ['start', 'jump', 'checkpoint', 'death', 'goal'])) fail('project-v3', 'cues key order wrong');
      if (typeof g.instructions !== 'string' || g.instructions.length > 320) fail('project-v3', 'instructions bound');
      if (g.configVersion !== 1) fail('project-v3', 'configVersion must be 1');
      const ids = new Set(env.scene.entities.map((e) => e.id));
      for (const ref of [g.playerId, g.cameraId, g.spawnId]) if (!ids.has(ref)) fail('project-v3', `game reference ${ref} must resolve in the scene`);
    }
    if (!failures.some((f) => f.check === 'project-v3')) pass('project-v3', 'v3 envelope/manifest structure and identity');
  } catch (e) {
    fail('project-v3', e.message);
  }

  // 4. the v2 source fixture
  let src = null;
  try {
    src = json('project-v2-demo-0002/scenes/main.json');
    const manifest = json('project-v2-demo-0002/project.json');
    if (manifest.schemaVersion !== 1) fail('project-v2', 'manifest schemaVersion must be 1');
    if (manifest.id !== 'demo-0002') fail('project-v2', 'manifest id must be demo-0002');
    if (src.storageVersion !== 2) fail('project-v2', 'source storageVersion must be 2');
    if (src.secret) fail('project-v2', 'unexpected field');
    if (src.scene.schemaVersion !== 2) fail('project-v2', 'source scene.schemaVersion must be 2');
    if (src.projectId !== manifest.id) fail('project-v2', 'source envelope projectId must equal the manifest id');
    if (!eq(Object.keys(src.content), V2_CONTENT_KEYS)) fail('project-v2', `v2 content key order must be ${V2_CONTENT_KEYS.join(',')}`);
    const found = [];
    for (const [i, e] of (src.scene.entities ?? []).entries()) {
      for (const name of Object.keys(e.components ?? {})) if (V3_ONLY.includes(name)) found.push(`/scene/entities/${i}/components/${name}`);
    }
    if (found.length) fail('project-v2', `a v2 source must not carry v3-only components: ${found.join(',')}`);
    const derived = [];
    for (const a of src.content.assets ?? []) for (const v of a.versions ?? []) if (v.publishedRevision > 0) derived.push('asset');
    for (const b of src.content.behaviors ?? []) {
      if (b.publishedRevision > 0) derived.push('behavior');
      if (b.source && b.source.publishedRevision > 0) derived.push('behavior.source');
    }
    for (const e of src.content.behaviorTrust?.entries ?? []) if (e.acknowledgedRevision > 0) derived.push('trust');
    if (derived.length === 0) fail('project-v2', 'the source must carry a non-zero derived revision value');
    if (!failures.some((f) => f.check === 'project-v2')) pass('project-v2', 'v2 source structure and registry');
  } catch (e) {
    fail('project-v2', e.message);
  }

  // 5. §16.5.2 destination derivation, cross-checked with the contracts fixture
  try {
    const cases = json('cases/migration.json');
    const migrationRel = resolve(root, '..', 'contracts', 'migration', 'expected-v3-destination', 'envelope.json');
    const contracts = existsSync(migrationRel) ? parseStrict(readFileSync(migrationRel, 'utf8')) : null;
    if (contracts === null) {
      fail('migration', 'the contracts expected-v3-destination fixture is required for the cross-check');
    }
    if (!src) {
      fail('migration', 'source unreadable');
    } else if (contracts !== null) {
      const zero = (content) => {
        const out = JSON.parse(JSON.stringify(content));
        for (const a of out.assets ?? []) for (const v of a.versions ?? []) v.publishedRevision = 0;
        for (const b of out.behaviors ?? []) {
          b.publishedRevision = 0;
          if (b.source) b.source.publishedRevision = 0;
        }
        for (const e of out.behaviorTrust?.entries ?? []) e.acknowledgedRevision = 0;
        return out;
      };
      // The derived destination (project-model §23.11 / workspace §16.5.2).
      const derivedScene = { schemaVersion: 3, sceneId: src.scene.sceneId, revision: 0, entities: src.scene.entities };
      const derivedContent = { ...zero(src.content), game: null };
      const expectedContent = zero(src.content);
      if (cases.expectedDestination.projectId === src.projectId) fail('migration', 'the destination must be a new identity');
      if (contracts.content.game !== null) fail('migration', 'the contracts destination game must be null');
      for (const k of V2_CONTENT_KEYS) {
        if (!eq(derivedContent[k], expectedContent[k])) fail('migration', `derived content.${k} must be verbatim except the derived reset`);
        if (!eq(derivedContent[k], contracts.content[k])) fail('migration', `derived content.${k} must equal the contracts fixture`);
      }
      if (!eq(Object.keys(derivedContent), V3_CONTENT_KEYS)) fail('migration', 'the derived content must use the six-key order');
      if (contracts.storageVersion !== 3 || contracts.scene.schemaVersion !== 3) fail('migration', 'the contracts destination must be v3');
      if (contracts.projectId !== cases.expectedDestination.projectId) fail('migration', 'the contracts projectId must equal the declared destination');
      if (contracts.scene.revision !== 0) fail('migration', 'the contracts destination revision must be 0');
      if (!eq(contracts.scene.entities, src.scene.entities)) fail('migration', 'the contracts destination entities must be the source entities verbatim');
      if (!eq(derivedScene.entities, contracts.scene.entities)) fail('migration', 'the derived destination entities must equal the contracts fixture');
      if (!eq(contracts.retry.records, [])) fail('migration', 'the contracts destination retry must be cleared');
      if (contracts.retry.retention !== 128) fail('migration', 'the contracts destination retention must be 128');
      if (!failures.some((f) => f.check === 'migration')) pass('migration', 'v2→v3 destination derivation matches §16.5.2 and the contracts fixture');
    }
  } catch (e) {
    fail('migration', e.message);
  }

  // 6. cases/migration.json
  try {
    const c = json('cases/migration.json');
    if (c.operator !== 'migrateProjectCopyV3') fail('cases-migration', 'operator');
    if (c.sourceVersion !== 2 || c.newVersion !== 3) fail('cases-migration', 'version pair must be 2→3');
    if (!eq(c.phases, PHASES)) fail('cases-migration', `phases must be ${PHASES.join('→')}`);
    if (c.marker.storageVersion !== 3 || c.marker.sourceVersion !== 2 || c.marker.newVersion !== 3) fail('cases-migration', 'marker version pair');
    if (c.marker.type !== 'migration-copy') fail('cases-migration', 'marker type');
    const reported = ['sourceProjectId', 'newProjectId', 'sourceRevision', 'newRevision', 'revisionPolicy', 'historyReset', 'retryCleared', 'blobsCopied', 'blobsAlreadyPresent', 'resumed', 'sourceVersion', 'newVersion'];
    if (!eq(c.reported, reported)) fail('cases-migration', 'reported object keys');
    const refusals = ['migration_version_unsupported', 'migration_source_invalid', 'migration_destination_exists', 'migration_marker_conflict', 'path_rejected', 'content_publish_failed'];
    if (!eq(c.refusals, refusals)) fail('cases-migration', 'refusal code set');
    if (c.expectedDestination.projectId !== 'demo-0003' || c.expectedDestination.revision !== 0) fail('cases-migration', 'expected destination');
    if (c.expectedDestination.contentGame !== null || c.expectedDestination.retryRecords !== 0) fail('cases-migration', 'expected destination reset');
    if (c.expectedDestination.retention !== 128) fail('cases-migration', 'retention');
    if (c.derivedRevisionFields.length !== 4) fail('cases-migration', 'derived revision fields');
    if (!failures.some((f) => f.check === 'cases-migration')) pass('cases-migration', 'operator/marker/report/refusal declarations');
  } catch (e) {
    fail('cases-migration', e.message);
  }

  // 7. cases/durability.json
  try {
    const c = json('cases/durability.json');
    if (!eq(c.mutableAuthoritativeFiles, ['scenes/main.json'])) fail('cases-durability', 'one mutable authoritative file');
    if (!eq(c.forbiddenSidecars, ['game.json', 'settings.json', 'scene.json', 'content.json'])) fail('cases-durability', 'sidecar list');
    if (!eq(c.envelopeStorageVersions, [1, 2, 3])) fail('cases-durability', 'known envelope storage versions');
    if (!eq(c.markerStorageVersions, [1, 3])) fail('cases-durability', 'marker versions');
    if (!eq(c.v3EnvelopeTopLevelKeys, TOP_KEYS)) fail('cases-durability', 'v3 envelope key order');
    if (!eq(c.v3ContentKeys, V3_CONTENT_KEYS)) fail('cases-durability', 'v3 content key order');
    const rows = c.crashPoints.map((r) => r.at);
    if (!eq(rows, ['before-envelope-rename', 'after-envelope-rename-before-directory-flush', 'after-directory-flush-before-ack', 'after-ack'])) {
      fail('cases-durability', 'crash-point rows');
    }
    if (c.crashPoints[0].retry !== 'fresh-execution') fail('cases-durability', 'before-rename retry must be fresh execution');
    for (const r of c.crashPoints.slice(1)) if (r.retry !== 'durable-replay') fail('cases-durability', 'post-rename retry must be durable replay');
    if (typeof c.acknowledgement.success !== 'string' || !c.acknowledgement.success.includes('step 5')) fail('cases-durability', 'ack timing');
    if (!failures.some((f) => f.check === 'cases-durability')) pass('cases-durability', 'ack timing / crash points / single-file rule');
  } catch (e) {
    fail('cases-durability', e.message);
  }

  // 8. cases/media.json
  try {
    const c = json('cases/media.json');
    if (!eq(c.preparedMediaFacts, ['assetId', 'kind', 'version', 'sourceDigest', 'sourceByteLength', 'importRecipe'])) {
      fail('cases-media', 'prepared-media fact fields');
    }
    if (!eq(c.kinds, ['model', 'audio'])) fail('cases-media', 'kinds');
    if (c.byteRead.operation !== 'readBlob' || c.byteRead.verified !== true || c.byteRead.copySafe !== true) fail('cases-media', 'byte read');
    const codes = ['asset_not_found', 'asset_version_not_found', 'blob_missing', 'blob_corrupt', 'path_rejected'];
    if (!eq(c.byteRead.failureCodes, codes)) fail('cases-media', 'byte read failure codes');
    if (!failures.some((f) => f.check === 'cases-media')) pass('cases-media', 'typed prepared-media facts and byte reads');
  } catch (e) {
    fail('cases-media', e.message);
  }

  // 9. no sidecar exists anywhere in either project tree
  for (const p of ['project-v2-demo-0002', 'project-v3-demo-0003']) {
    for (const sidecar of ['game.json', 'settings.json', 'scene.json', 'content.json']) {
      if (existsSync(join(root, p, sidecar))) fail('no-sidecar', `${p}/${sidecar} must not exist`);
    }
  }
  if (!failures.some((f) => f.check === 'no-sidecar')) pass('no-sidecar', 'no second mutable document in either project');

  return { failures, passes };
}

// ---- run ---------------------------------------------------------------------
function run(root) {
  const { failures, passes } = check(root);
  return { failures, passes };
}

if (!CORRUPT) {
  const root = process.env.TL46_FIXTURE_ROOT ? resolve(process.env.TL46_FIXTURE_ROOT) : DEFAULT_ROOT;
  const { failures, passes } = run(root);
  for (const p of passes) console.log(`  ok   ${p.check}${p.detail ? ` — ${p.detail}` : ''}`);
  for (const f of failures) console.log(`  FAIL ${f.check}: ${f.detail}`);
  console.log(`groups: ${new Set([...passes.map((p) => p.check), ...failures.map((f) => f.check)]).size}, checks passed: ${passes.length}, failed: ${failures.length}`);
  if (failures.length) {
    console.log('fixture checks FAILED');
    process.exit(1);
  }
  console.log('all checks passed');
  process.exit(0);
}

// --corrupt-control: every deliberate corruption must be detected.
{
  const base = DEFAULT_ROOT;
  const clean = run(base);
  const results = [];
  const corruptions = [
    ['flip-envelope-byte', (dir) => {
      const p = join(dir, 'project-v3-demo-0003', 'scenes', 'main.json');
      const b = readFileSync(p);
      b[b.indexOf('Beacon Reach'.charCodeAt(0))] = 'X'.charCodeAt(0);
      writeFileSync(p, b);
    }],
    ['remove-game-key', (dir) => {
      const p = join(dir, 'project-v3-demo-0003', 'scenes', 'main.json');
      const d = parseStrict(readFileSync(p, 'utf8'));
      delete d.content.game;
      writeFileSync(p, JSON.stringify(d, null, 2) + '\n');
    }],
    ['zero-source-derived', (dir) => {
      const p = join(dir, 'project-v2-demo-0002', 'scenes', 'main.json');
      const d = parseStrict(readFileSync(p, 'utf8'));
      d.content.assets[0].versions[0].publishedRevision = 0;
      writeFileSync(p, JSON.stringify(d, null, 2) + '\n');
    }],
    ['add-sidecar', (dir) => writeFileSync(join(dir, 'project-v3-demo-0003', 'game.json'), '{}\n')],
    ['tamper-index', (dir) => {
      const p = join(dir, 'index.json');
      const d = parseStrict(readFileSync(p, 'utf8'));
      d.files['project-v3-demo-0003/scenes/main.json'].sha256 = '0'.repeat(64);
      writeFileSync(p, JSON.stringify(d, null, 2) + '\n');
    }],
    ['v3-only-in-v2-source', (dir) => {
      const p = join(dir, 'project-v2-demo-0002', 'scenes', 'main.json');
      const d = parseStrict(readFileSync(p, 'utf8'));
      d.scene.entities[0].components.cameraFollow = { deadZone: { x: 0.5, y: 0.5 }, smoothing: 0.2, bounds: { minX: 0, maxX: 1, minY: 0, maxY: 1 } };
      writeFileSync(p, JSON.stringify(d, null, 2) + '\n');
    }],
  ];
  let detected = 0;
  for (const [name, mutate] of corruptions) {
    const tmp = mkdtempSync(join(tmpdir() === '/tmp' ? '/home/dadmin' : tmpdir(), '.tl46-corrupt-'));
    const copy = join(tmp, 'storage');
    cpSync(base, copy, { recursive: true });
    mutate(copy);
    const r = run(copy);
    if (r.failures.length > 0) {
      detected += 1;
      console.log(`  ok   corruption '${name}' detected (${r.failures.length} failures)`);
    } else {
      console.log(`  FAIL corruption '${name}' was NOT detected`);
    }
    rmSync(tmp, { recursive: true, force: true });
  }
  console.log(`corruption control: ${detected}/${corruptions.length} detected (clean tree failures: ${clean.failures.length})`);
  if (clean.failures.length !== 0 || detected !== corruptions.length) {
    console.log('corruption control FAILED');
    process.exit(1);
  }
  console.log('all corruptions detected');
  process.exit(0);
}

/**
 * fixtures/m2/contracts/tools/check-fixtures.mjs
 *
 * Fixture consistency checker for packet 15's PROPOSED content-storage and
 * asset contracts (docs/planning/m2-contracts/{content-storage,assets}.md).
 *
 * This tool is fixture tooling, NOT an implementation of the contracts. It
 * contains no storage, import or publish logic. It verifies that the
 * committed fixtures are internally consistent and that every value they
 * claim about bytes is recomputable:
 *
 *  1. every JSON fixture parses under a strict parser (no duplicate keys)
 *     and is byte-canonical (2-space indent, LF, one trailing newline,
 *     no BOM, no trailing whitespace, shortest-round-trip numbers);
 *  2. every path listed in expected.json exists, and every fixture file on
 *     disk is listed (no orphans, no dangling entries);
 *  3. every `sourceDigest`/`sourceByteLength` claimed anywhere equals the
 *     real SHA-256/length of a committed preimage file;
 *  4. the captured content view's `contentDigest` equals the recomputed
 *     digest of the view (canonical JSON, contentDigest removed);
 *  5. catalog/envelope/migration cross-references hold (same content block,
 *     verbatim entity carry-over, reset revision policy, marker state);
 *  6. every error code used by a fixture is declared in expected.json's code
 *     registry, and every case fixture's `pins` name a real section heading
 *     in the proposal it pins.
 *  7. (packet 16) the command scenario replays: revision/history arithmetic,
 *     byte-exact request/result pairing, deterministic entity-ID allocation
 *     recomputed from the definition document order, internal-reference
 *     remapping, closure/restore equality, and a final scene deep-equal to
 *     the after envelope; the failure set's revision arithmetic and codes;
 *     the query examples' declared revision/counts.
 *
 * Usage (from the repository root):
 *   node fixtures/m2/contracts/tools/check-fixtures.mjs            # check
 *   node fixtures/m2/contracts/tools/check-fixtures.mjs --write    # canonicalize
 *   node fixtures/m2/contracts/tools/check-fixtures.mjs --report out.json
 *
 * Exit code 0 = all checks passed; 1 = at least one check failed.
 */

import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
// The repository root is only needed to resolve the proposal sections that case
// fixtures pin. `TL15_REPO_ROOT` lets the checker run against a copy of the
// fixture tree (used by the negative control in verification.md §1.1).
const REPO = process.env.TL15_REPO_ROOT ? resolve(process.env.TL15_REPO_ROOT) : resolve(ROOT, '..', '..', '..');

const WRITE = process.argv.includes('--write');
const SELF_TEST = process.argv.includes('--self-test');
const REPORT_AT = process.argv.indexOf('--report');
const REPORT = REPORT_AT >= 0 ? process.argv[REPORT_AT + 1] : null;

/** Files that are tooling/index prose, not fixtures (excluded from the orphan rule). */
const NON_FIXTURES = new Set(['README.md', 'verification.md', 'expected.json', 'tools/check-fixtures.mjs']);

const failures = [];
const passes = [];
const fail = (check, detail) => failures.push({ check, detail });
const pass = (check, detail) => passes.push({ check, detail: detail ?? null });

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

// ---------------------------------------------------------------------------
// strict JSON parser with duplicate-key rejection (no dependency, no eval)
// ---------------------------------------------------------------------------

function parseStrict(text) {
  let i = 0;
  const at = () => 'offset ' + i;
  const bad = (m) => {
    throw new Error(m + ' at ' + at());
  };
  const ws = () => {
    while (i < text.length && (text[i] === ' ' || text[i] === '\n' || text[i] === '\t' || text[i] === '\r')) i++;
  };
  function string() {
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
          const hex = text.slice(i + 2, i + 6);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) bad('bad \\u escape');
          out += String.fromCharCode(parseInt(hex, 16));
          i += 6;
          continue;
        }
        const map = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
        if (!Object.prototype.hasOwnProperty.call(map, e)) bad('bad escape');
        out += map[e];
        i += 2;
        continue;
      }
      if (c.charCodeAt(0) < 0x20) bad('raw control character in string');
      out += c;
      i++;
    }
    return bad('unterminated string');
  }
  function number() {
    const m = /^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?/.exec(text.slice(i));
    if (!m) return bad('bad number');
    i += m[0].length;
    return Number(m[0]);
  }
  function array() {
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
      return bad('expected , or ] in array');
    }
  }
  function object() {
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
      if (text[i] !== '"') return bad('expected object key string');
      const k = string();
      if (seen.has(k)) return bad('duplicate object key ' + JSON.stringify(k));
      seen.add(k);
      ws();
      if (text[i] !== ':') return bad('expected : after key');
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
      return bad('expected , or } in object');
    }
  }
  function value() {
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
    return bad('unexpected token');
  }
  const v = value();
  ws();
  if (i !== text.length) bad('trailing garbage');
  return v;
}

/** commands.md §6.6 rule 2 canonical JSON (codepoint-sorted keys, no whitespace). */
const canon = (v) => {
  if (Array.isArray(v)) return '[' + v.map(canon).join(',') + ']';
  if (v && typeof v === 'object') {
    return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canon(v[k])).join(',') + '}';
  }
  return JSON.stringify(v);
};

// ---------------------------------------------------------------------------
// walk
// ---------------------------------------------------------------------------

const files = [];
(function walk(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'tools') continue;
      walk(p);
    } else if (e.isFile()) {
      files.push(relative(ROOT, p));
    }
  }
})(ROOT);

const rel = (p) => relative(ROOT, p).split('\\').join('/');
const readText = (p) => readFileSync(join(ROOT, p), 'utf8');
const readJson = (p) => {
  const text = readText(p);
  try {
    return parseStrict(text);
  } catch (err) {
    fail('json-parse', `${p}: ${err.message}`);
    return null;
  }
};
const deepEqual = (a, b) => canon(a) === canon(b);

// ---------------------------------------------------------------------------
// 1. canonical form
// ---------------------------------------------------------------------------

function canonicalForm() {
  let checked = 0;
  let rewritten = 0;
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    const text = readText(f);
    checked++;
    if (text.charCodeAt(0) === 0xfeff) {
      fail('canonical-form', `${f}: leading BOM`);
      continue;
    }
    if (text.includes('\r')) fail('canonical-form', `${f}: CR present (LF required)`);
    if (!text.endsWith('\n') || text.endsWith('\n\n')) fail('canonical-form', `${f}: must end with exactly one newline`);
    for (const [n, line] of text.split('\n').entries()) {
      if (/[ \t]+$/.test(line)) fail('canonical-form', `${f}: trailing whitespace on line ${n + 1}`);
    }
    const parsed = readJson(f);
    if (parsed === null) continue;
    let canonical;
    try {
      canonical = JSON.stringify(parsed, null, 2) + '\n';
    } catch {
      fail('canonical-form', `${f}: not serializable (non-finite number?)`);
      continue;
    }
    if (canonical !== text) {
      if (WRITE) {
        writeFileSync(join(ROOT, f), canonical);
        rewritten++;
      } else {
        fail('canonical-form', `${f}: bytes are not the canonical form (run --write)`);
      }
    }
  }
  pass('canonical-form', `${checked} JSON fixture(s) checked${WRITE ? `, ${rewritten} rewritten` : ''}`);
}

// ---------------------------------------------------------------------------
// 2. expected.json index completeness
// ---------------------------------------------------------------------------

function indexCompleteness(expected) {
  const listed = new Set();
  for (const e of expected.entries) {
    const p = join(ROOT, e.path);
    let exists = true;
    try {
      statSync(p);
    } catch {
      exists = false;
    }
    if (!exists) fail('index', `expected.json entry path does not exist: ${e.path}`);
    listed.add(e.path.split('\\').join('/'));
  }
  for (const f of files) {
    if (NON_FIXTURES.has(f)) continue;
    if (!listed.has(f)) fail('index', `fixture file not listed in expected.json: ${f}`);
  }
  for (const l of listed) {
    if (!files.includes(l)) fail('index', `expected.json lists a non-file: ${l}`);
  }
  pass('index', `${expected.entries.length} index entries, ${files.length} files on disk`);
}

// ---------------------------------------------------------------------------
// 3. preimages + every claimed digest/length
// ---------------------------------------------------------------------------

function preimages(expected) {
  // Files indexed as intentionally INVALID fixtures may carry intentionally
  // invalid values (e.g. a malformed sourceDigest in
  // envelope/invalid/content-digest-invalid.json) and are skipped here.
  const invalidFixtures = new Set(
    (expected.entries ?? []).filter((e) => e.valid === false).map((e) => e.path),
  );
  const index = readJson('source-preimages/preimages.json');
  if (!index) return;
  const byDigest = new Map();
  for (const p of index.preimages) {
    const buf = readFileSync(join(ROOT, 'source-preimages', p.file));
    const digest = sha256(buf);
    if (digest !== p.sha256) fail('preimage', `${p.file}: sha256 ${digest} != declared ${p.sha256}`);
    if (buf.length !== p.byteLength) fail('preimage', `${p.file}: length ${buf.length} != declared ${p.byteLength}`);
    byDigest.set(digest, buf.length);
  }
  if (byDigest.size === 0) fail('preimage', 'no preimages declared');
  pass('preimage', `${byDigest.size} preimage(s) re-hashed`);
  // packet 18: behavior source-graph containers are committed bytes too, indexed
  // by their own containers.json. Merging them keeps the digest-claims check
  // below authoritative for every sourceDigest/sourceByteLength pair a fixture
  // claims (including the compiled-example record).
  const behaviorContainers = readJson('behaviors/source-preimages/containers.json');
  if (behaviorContainers) {
    let merged = 0;
    for (const p of behaviorContainers.containers) {
      const buf = readFileSync(join(ROOT, 'behaviors', 'source-preimages', p.file));
      const digest = sha256(buf);
      if (digest !== p.sha256) fail('p18-container-hash', `${p.file}: sha256 ${digest} != declared ${p.sha256}`);
      if (buf.length !== p.byteLength) fail('p18-container-hash', `${p.file}: length ${buf.length} != declared ${p.byteLength}`);
      const known = byDigest.get(digest);
      if (known !== undefined && known !== buf.length) fail('p18-container-hash', `${p.file}: digest collides with a different length`);
      byDigest.set(digest, buf.length);
      merged++;
    }
    pass('p18-container-hash', `${merged} behavior source container(s) re-hashed and merged into the digest map`);
  }
  // every digest/length pair claimed by any fixture
  const offenders = [];
  for (const f of files) {
    if (!f.endsWith('.json') || f === 'source-preimages/preimages.json') continue;
    if (invalidFixtures.has(f)) continue;
    const doc = readJson(f);
    if (!doc) continue;
    const visit = (node) => {
      if (Array.isArray(node)) return node.forEach(visit);
      if (!node || typeof node !== 'object') return;
      if (typeof node.sourceDigest === 'string' && typeof node.sourceByteLength === 'number') {
        const len = byDigest.get(node.sourceDigest);
        if (len === undefined) offenders.push(`${f}: sourceDigest ${node.sourceDigest} matches no committed preimage`);
        else if (len !== node.sourceByteLength) offenders.push(`${f}: sourceByteLength ${node.sourceByteLength} != preimage length ${len}`);
      }
      for (const v of Object.values(node)) visit(v);
    };
    visit(doc);
  }
  for (const o of offenders) fail('digest-claims', o);
  if (offenders.length === 0) pass('digest-claims', 'every sourceDigest/sourceByteLength pair matches a committed preimage');
}

// ---------------------------------------------------------------------------
// 4. captured content view digest
// ---------------------------------------------------------------------------

function contentView() {
  const view = readJson('catalog/captured-content-view.json');
  if (!view) return;
  const { contentDigest, ...rest } = view;
  const recomputed = sha256(Buffer.from(canon(rest), 'utf8'));
  if (recomputed !== contentDigest) {
    fail('content-digest', `declared ${contentDigest} != recomputed ${recomputed}`);
  } else {
    pass('content-digest', `captured-content-view.json contentDigest ${recomputed.slice(0, 16)}… verified`);
  }
}

// ---------------------------------------------------------------------------
// 5. cross-references
// ---------------------------------------------------------------------------

function crossReferences(expected) {
  const env = readJson('envelope/valid/demo-0002-rev7-v2.json');
  const block = readJson('catalog/content-block-example.json');
  if (env && block) {
    if (!deepEqual(env.content, block)) fail('cross-ref', 'catalog/content-block-example.json does not equal the valid envelope content block');
    else pass('cross-ref', 'content-block-example.json equals envelope/valid/demo-0002-rev7-v2.json content block');
  }
  if (env) {
    const ids = env.content.assets.map((a) => a.assetId);
    const sorted = [...ids].sort();
    if (!deepEqual(ids, sorted)) fail('cross-ref', 'content.assets is not sorted ascending by assetId');
    for (const a of env.content.assets) {
      const versions = a.versions.map((v) => v.version);
      const expectedVersions = versions.map((_, n) => n + 1);
      if (!deepEqual(versions, expectedVersions)) fail('cross-ref', `${a.assetId}: versions are not contiguous 1..N`);
      if (a.currentVersion !== versions[versions.length - 1]) {
        fail('cross-ref', `${a.assetId}: currentVersion ${a.currentVersion} != last version ${versions[versions.length - 1]}`);
      }
    }
    const referenced = new Set();
    for (const e of env.scene.entities) {
      if (e.components && e.components.model) referenced.add(e.components.model.asset.assetId);
    }
    for (const r of referenced) {
      if (!ids.includes(r)) fail('cross-ref', `scene references ${r} but the catalog does not resolve it`);
    }
    pass('cross-ref', `${env.content.assets.length} catalog records, ${referenced.size} scene reference(s) resolved`);
  }

  // migration
  const srcEnv = readJson('migration/v1-source/scenes/main.json');
  const srcMan = readJson('migration/v1-source/project.json');
  const dstEnv = readJson('migration/expected-v2-destination/scenes/main.json');
  const dstMan = readJson('migration/expected-v2-destination/project.json');
  if (srcEnv && dstEnv && srcMan && dstMan) {
    if (!deepEqual(srcEnv.scene.entities, dstEnv.scene.entities)) {
      fail('migration', 'destination entities are not a verbatim carry-over of the source entities');
    }
    if (srcEnv.scene.sceneId !== dstEnv.scene.sceneId) fail('migration', 'sceneId changed across the migration copy');
    if (dstEnv.projectId === srcEnv.projectId) fail('migration', 'the destination must be a NEW project identity');
    if (dstEnv.scene.schemaVersion !== 2 || srcEnv.scene.schemaVersion !== 1) {
      fail('migration', 'expected scene schemaVersion 1 (source) -> 2 (destination)');
    }
    if (dstEnv.storageVersion !== 2 || srcEnv.storageVersion !== 1) {
      fail('migration', 'expected storageVersion 1 (source) -> 2 (destination)');
    }
    if (dstEnv.scene.revision !== 0) fail('migration', 'destination revision policy is reset-to-zero');
    if (dstEnv.retry.records.length !== 0 || dstEnv.retry.retention !== 128) fail('migration', 'destination retry block must be reset');
    for (const k of ['assets', 'prefabs', 'behaviors']) {
      if (!Array.isArray(dstEnv.content[k]) || dstEnv.content[k].length !== 0) fail('migration', `destination content.${k} must be an empty array`);
    }
    if (!deepEqual(dstEnv.content.settings, {})) fail('migration', 'destination content.settings must be {}');
    if (dstMan.id !== dstEnv.projectId) fail('migration', 'destination manifest id != envelope projectId');
    if (srcMan.id !== srcEnv.projectId) fail('migration', 'source manifest id != envelope projectId');
    if (dstMan.name !== srcMan.name) fail('migration', 'display name is carried over');
    if (dstMan.schemaVersion !== 1 || srcMan.schemaVersion !== 1) fail('migration', 'the manifest stays schemaVersion 1 in M2');
    pass('migration', 'source v1 -> destination v2 transformation verified (identity, versions, revision policy, verbatim entities)');
  }

  // source retention hashes
  for (const entry of expected.sourceHashes) {
    const buf = readFileSync(join(ROOT, entry.path));
    const digest = sha256(buf);
    if (digest !== entry.sha256) fail('source-retention', `${entry.path}: sha256 ${digest} != recorded ${entry.sha256}`);
  }
  pass('source-retention', `${expected.sourceHashes.length} source file(s) re-hashed (original-preserving migration evidence)`);

  // interrupted copy
  const marker = readJson('migration/interrupted-copy/.thirdlight/migration.json');
  const partMan = readJson('migration/interrupted-copy/project.json');
  if (marker && partMan) {
    let envelopeExists = true;
    try {
      statSync(join(ROOT, 'migration/interrupted-copy/scenes/main.json'));
    } catch {
      envelopeExists = false;
    }
    if (envelopeExists) fail('interrupted-copy', 'the interrupted copy fixture must not contain an envelope');
    const phases = ['created', 'manifest', 'blobs', 'envelope'];
    if (!phases.includes(marker.phase)) fail('interrupted-copy', `unknown marker phase ${marker.phase}`);
    if (marker.type !== 'migration-copy') fail('interrupted-copy', 'marker type must be migration-copy');
    if (partMan.id !== marker.newProjectId) fail('interrupted-copy', 'partial manifest id != marker newProjectId');
    pass('interrupted-copy', `marker phase "${marker.phase}", no envelope present (never auto-completed)`);
  }
}

// ---------------------------------------------------------------------------
// 6. codes registry + case pins
// ---------------------------------------------------------------------------

function collectCodes(node, out) {
  if (Array.isArray(node)) return node.forEach((n) => collectCodes(n, out));
  if (!node || typeof node !== 'object') return;
  for (const [k, v] of Object.entries(node)) {
    if ((k === 'code' || k === 'innerCodes' || k === 'expectedCodes' || k === 'codes') && (typeof v === 'string' || Array.isArray(v))) {
      for (const c of Array.isArray(v) ? v : [v]) if (typeof c === 'string') out.add(c);
    }
    collectCodes(v, out);
  }
}

function codesAndPins(expected) {
  const registry = new Set([
    ...expected.registry.modelErrorCodes,
    ...expected.registry.workspaceErrorCodes,
    ...expected.registry.commandErrorCodes,
    ...(expected.registry.runtimeErrorCodes ?? []),
    ...(expected.registry.behaviorErrorCodes ?? []),
    ...(expected.registry.importDiagnosticCodes ?? []),
    ...(expected.registry.sessionErrorCodes ?? []),
    ...(expected.registry.exportErrorCodes ?? []),
    ...(expected.registry.deliveryErrorCodes ?? []),
  ]);
  const used = new Set();
  for (const f of files) {
    if (!f.endsWith('.json') || f === 'expected.json' || f === 'source-preimages/preimages.json') continue;
    const doc = readJson(f);
    if (!doc) continue;
    const found = new Set();
    collectCodes(doc, found);
    for (const c of found) {
      used.add(c);
      if (!registry.has(c)) fail('code-registry', `${f}: code "${c}" is not declared in expected.json registry`);
    }
  }
  const unused = [...registry].filter((c) => !used.has(c));
  pass('code-registry', `${used.size} code(s) used by fixtures, all declared in expected.json.registry; ${unused.length} declared (accepted M1 / proposed M2) code(s) are not exercised by a fixture`);

  // envelope entries must agree with their fixture's valid flag
  for (const e of expected.entries) {
    if (e.kind !== 'envelope') continue;
    if (e.valid === true && (e.code || e.innerCodes)) fail('envelope-index', `${e.path}: valid envelope must not declare codes`);
    if (e.valid === false && !e.code) fail('envelope-index', `${e.path}: invalid envelope must declare a top-level code`);
  }

  // case pins (declarative packet-15 cases and packet-16 failure/query sets)
  let pins = 0;
  for (const e of expected.entries) {
    if (e.kind !== 'case' && e.kind !== 'command-failure-set' && e.kind !== 'command-query-examples' && e.kind !== 'platformer-failure-set'
        && e.kind !== 'physics-numerics' && e.kind !== 'platformer-traces' && e.kind !== 'input-action-sequences' && e.kind !== 'runtime-catchup'
        && e.kind !== 'behavior-source-graph-set' && e.kind !== 'behavior-compiled-example' && e.kind !== 'behavior-intent-analysis'
        && e.kind !== 'behavior-runtime-failure-set' && e.kind !== 'behavior-publication-case-set'
        && e.kind !== 'delivery-protocol-surface' && e.kind !== 'delivery-locator-cases' && e.kind !== 'delivery-upload-bounds'
        && e.kind !== 'delivery-scan-expectations' && e.kind !== 'delivery-manifest' && e.kind !== 'delivery-input-relay') continue;
    const doc = readJson(e.path);
    if (!doc) continue;
    if (e.kind === 'case') {
      if (doc.id !== e.path.replace(/^cases\//, '').replace(/\.json$/, '')) fail('case-shape', `${e.path}: id must equal the file name`);
      for (const key of ['kind', 'caseVersion', 'title', 'pins', 'input', 'steps', 'expect', 'notes']) {
        if (!(key in doc)) fail('case-shape', `${e.path}: missing member "${key}"`);
      }
    }
    const pinLists = e.kind === 'command-failure-set'
      ? [...doc.cases.map((c) => ({ where: c.caseId, pins: c.pins })), ...doc.constructed.map((c) => ({ where: c.caseId, pins: c.pins }))]
      : e.kind === 'command-query-examples'
        ? [{ where: e.path, pins: doc.pins ?? [] }]
        : e.kind === 'platformer-failure-set'
          ? [{ where: e.path, pins: doc.pins ?? [] }, ...doc.cases.map((c) => ({ where: c.caseId, pins: c.pins ?? [] }))]
          : [{ where: e.path, pins: doc.pins }];
    for (const { where, pins: list } of pinLists) {
      for (const pin of list ?? []) {
        pins++;
        let text;
        try {
          text = readFileSync(join(REPO, pin.file), 'utf8');
        } catch {
          fail('case-pins', `${e.path} (${where}): pinned file does not exist: ${pin.file}`);
          continue;
        }
        if (!text.split('\n').some((l) => l.trim() === pin.section.trim())) {
          fail('case-pins', `${e.path} (${where}): pinned section not found in ${pin.file}: ${pin.section}`);
        }
      }
    }
  }
  pass('case-pins', `${pins} case->section pin(s) verified`);
}

// ---------------------------------------------------------------------------
// 7. packet 16: command scenario replay, failure set, query examples
// ---------------------------------------------------------------------------

const P16_REQUEST_ID = /^req-[0-9a-f]{32}$/;
const cloned = (v) => JSON.parse(JSON.stringify(v));

/** Derived ID prefix of a v2 entity (packets 16): model > box > group. */
const idPrefix = (components) => (components.model ? 'model' : components.box ? 'box' : 'group');

/** commands.md §8.1 semantics extended to a multi-entity creation (packet 16). */
function allocateId(used, prefix) {
  for (let i = 1; i <= 9999; i++) {
    const id = prefix + '-' + String(i).padStart(4, '0');
    if (!used.has(id)) {
      used.add(id);
      return id;
    }
  }
  return null;
}

function closureOf(entities, rootId) {
  const ids = new Set([rootId]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const e of entities) {
      if (e.parentId && ids.has(e.parentId) && !ids.has(e.id)) {
        ids.add(e.id);
        grew = true;
      }
    }
  }
  return entities.filter((e) => ids.has(e.id)).map((e) => e.id);
}

/** Fill declared defaults for a property value map (declaration order). */
function fillDefaults(declaration, provided) {
  const out = {};
  for (const p of declaration.properties) {
    out[p.key] = Object.prototype.hasOwnProperty.call(provided, p.key) ? provided[p.key] : p.default;
  }
  return out;
}

function packet16Commands() {
  const before = readJson('commands/prefab-scenario.before.json');
  const scen = readJson('commands/prefab-scenario.messages.json');
  const after = readJson('commands/prefab-scenario.after.json');
  const failSet = readJson('commands/prefab-failures.json');
  const querySet = readJson('commands/queries.json');
  if (!before || !scen || !after) return;

  // --- envelopes ----------------------------------------------------------
  for (const [name, doc] of [['before', before], ['after', after]]) {
    if (doc.storageVersion !== 2) fail('p16-envelope', `${name}: storageVersion must be 2`);
    if (doc.scene.schemaVersion !== 2) fail('p16-envelope', `${name}: scene.schemaVersion must be 2`);
    if (doc.projectId !== 'demo-0003') fail('p16-envelope', `${name}: unexpected projectId`);
    if (!deepEqual(Object.keys(doc), ['storageVersion', 'type', 'projectId', 'scene', 'content', 'retry'])) {
      fail('p16-envelope', `${name}: envelope key order is not the v2 canonical order`);
    }
    if (!deepEqual(Object.keys(doc.content), ['assets', 'prefabs', 'behaviors', 'settings', 'behaviorTrust'])) {
      fail('p16-envelope', `${name}: content key order is not canonical`);
    }
    if (doc.retry.records.length !== 0) fail('p16-envelope', `${name}: released-state fixture must carry no retry records`);
  }
  if (before.scene.revision !== 2) fail('p16-envelope', 'before revision must be 2');
  if (scen.projectId !== before.projectId) fail('p16-envelope', 'scenario projectId mismatch');
  if (scen.before !== 'commands/prefab-scenario.before.json' || scen.after !== 'commands/prefab-scenario.after.json') {
    fail('p16-envelope', 'scenario before/after paths must point at the committed envelopes');
  }

  // --- definition taken from the createPrefab step ------------------------
  const createStep = scen.steps.find((s) => s.out && s.out.change && s.out.change.type === 'createPrefab');
  if (!createStep) {
    fail('p16-scenario', 'no createPrefab step in the scenario');
    return;
  }
  const definition = createStep.out.change.definition;
  const declaration = scen.steps.find((s) => s.out && s.out.change && s.out.change.type === 'publishBehavior').out.change.next.declaration;
  const declaredKeys = declaration.properties.map((p) => p.key);
  const localById = new Map(definition.entities.map((e) => [e.localId, e]));

  // --- replay -------------------------------------------------------------
  let entities = cloned(before.scene.entities);
  let revision = before.scene.revision;
  let lastDeletion = null;
  const seenRequestIds = new Map();

  for (const step of scen.steps) {
    const req = step.in;
    const res = step.out;
    const where = `${scen.id}/${step.stepId}`;
    if (!P16_REQUEST_ID.test(req.requestId)) fail('p16-replay', `${where}: requestId syntax`);
    if (res.op !== req.op || res.projectId !== req.projectId || res.requestId !== req.requestId) {
      fail('p16-replay', `${where}: result does not echo op/projectId/requestId`);
    }
    if (req.expectedRevision !== revision && !res.duplicated) {
      fail('p16-replay', `${where}: expectedRevision ${req.expectedRevision} != replay revision ${revision}`);
    }
    if (res.duplicated) {
      const prev = seenRequestIds.get(req.requestId);
      if (!prev) fail('p16-replay', `${where}: duplicated replay of an unrecorded requestId`);
      else {
        if (!deepEqual(prev.in, req)) fail('p16-replay', `${where}: replay request differs from the recorded request`);
        const { duplicated: _d, ...rest } = res;
        const { duplicated: _p, ...prevOut } = prev.out;
        if (!deepEqual(rest, prevOut)) fail('p16-replay', `${where}: replay payload is not byte-identical to the recorded result modulo duplicated`);
      }
      continue;
    }
    seenRequestIds.set(req.requestId, step);
    revision += 1;
    if (res.revision !== revision) fail('p16-replay', `${where}: result revision ${res.revision} != replay revision ${revision}`);
    const ch = res.change;
    if (!ch) {
      fail('p16-replay', `${where}: success result without change data`);
      continue;
    }
    if (ch.type === 'instantiatePrefab') {
      const used = new Set(entities.map((e) => e.id));
      const expectedIds = definition.entities.map((de) => allocateId(used, idPrefix(de.components)));
      const createdIds = ch.entries.map((en) => en.entity.id);
      if (!deepEqual(createdIds, expectedIds)) {
        fail('p16-replay', `${where}: deterministic ID allocation mismatch: ${JSON.stringify(createdIds)} != ${JSON.stringify(expectedIds)}`);
      }
      if (ch.rootId !== expectedIds[0]) fail('p16-replay', `${where}: rootId must be the first allocated ID`);
      for (const [i, en] of ch.entries.entries()) {
        if (en.index !== entities.length + i) fail('p16-replay', `${where}: entry index ${en.index} != pre-insertion slot ${entities.length + i}`);
        const de = definition.entities[i];
        if (en.entity.components.prefab.prefabId !== definition.prefabId || en.entity.components.prefab.localId !== de.localId) {
          fail('p16-replay', `${where}: provenance component mismatch on ${en.entity.id}`);
        }
      }
      const mapping = new Map(ch.mapping.map((m) => [m.localId, m.entityId]));
      if (!deepEqual(ch.mapping.map((m) => m.localId), definition.entities.map((e) => e.localId))) {
        fail('p16-replay', `${where}: mapping order must follow definition document order`);
      }
      const overrides = new Map((req.args.overrides ?? []).map((o) => [o.localId + '\u0000' + o.key, o.value]));
      for (const [i, en] of ch.entries.entries()) {
        const de = definition.entities[i];
        // remap internal entity references and apply declared overrides
        const expected = cloned(de.components);
        expected.prefab = { prefabId: definition.prefabId, localId: de.localId };
        if (de.localId === definition.entities[0].localId && req.args.transform) {
          for (const [k, v] of Object.entries(req.args.transform)) expected.transform[k] = v;
        }
        if (expected.behavior) {
          const provided = {};
          for (const p of declaration.properties) {
            const own = Object.prototype.hasOwnProperty.call(de.components.behavior.values, p.key) ? de.components.behavior.values[p.key] : undefined;
            let value = own === undefined ? p.default : own;
            const ov = overrides.get(de.localId + '\u0000' + p.key);
            if (ov !== undefined) value = ov;
            if (p.type === 'entityRef' && typeof value === 'string' && localById.has(value)) value = mapping.get(value);
            provided[p.key] = value;
          }
          expected.behavior.values = provided;
        }
        if (!deepEqual(en.entity.components, expected)) {
          fail('p16-replay', `${where}: remapped entity ${en.entity.id} differs from the definition + overrides`);
        } else if (en.entity.parentId !== (i === 0 ? (req.args.parentId ?? undefined) : mapping.get(de.parentLocalId))) {
          fail('p16-replay', `${where}: parent remap mismatch on ${en.entity.id}`);
        }
      }
      for (const en of ch.entries) entities.splice(en.index, 0, cloned(en.entity));
    } else if (ch.type === 'createPrefab') {
      const source = ch.definition;
      const expectedClosure = closureOf(entities, req.args.sourceEntityId);
      if (!deepEqual(source.entities.map((e) => e.localId), expectedClosure)) {
        fail('p16-replay', `${where}: definition localIds must be the source subtree closure in document order`);
      }
      if (source.createdRevision !== res.revision) fail('p16-replay', `${where}: createdRevision must equal the resulting revision`);
      if (source.entityCount !== source.entities.length) fail('p16-replay', `${where}: entityCount must equal entities.length`);
    } else if (ch.type === 'setComponent') {
      const target = entities.find((e) => e.id === ch.id);
      if (!target) fail('p16-replay', `${where}: setComponent target not found`);
      else if (!deepEqual(target.components[ch.component], ch.previous)) {
        fail('p16-replay', `${where}: recorded previous value does not match the replayed state`);
      } else {
        target.components[ch.component] = cloned(ch.next);
      }
    } else if (ch.type === 'setBehaviorProperties') {
      const target = entities.find((e) => e.id === ch.id);
      const beforeBehavior = target ? (target.components.behavior ?? null) : undefined;
      if (!target) fail('p16-replay', `${where}: setBehaviorProperties target not found`);
      else if (!deepEqual(beforeBehavior, ch.previous)) {
        fail('p16-replay', `${where}: recorded previous behavior component does not match the replayed state`);
      } else {
        target.components.behavior = cloned(ch.next);
      }
      const provided = Object.fromEntries((req.args.values ? Object.entries(req.args.values) : []).map(([k, v]) => [k, v]));
      const filled = fillDefaults(declaration, ch.next ? provided : {});
      if (ch.next) {
        if (!deepEqual(Object.keys(ch.next.values), declaredKeys)) fail('p16-replay', `${where}: values key order must follow the declaration`);
        if (!deepEqual(ch.next.values, filled)) fail('p16-replay', `${where}: values must be the declaration defaults overridden by args.values`);
      }
    } else if (ch.type === 'publishBehavior') {
      if (ch.next.publishedRevision !== res.revision) fail('p16-replay', `${where}: publishedRevision must equal the resulting revision`);
      if (!deepEqual(ch.next.declaration, req.args.declaration)) fail('p16-replay', `${where}: recorded declaration must equal the request declaration`);
    } else if (ch.type === 'deleteEntity') {
      const expectedClosure = closureOf(entities, ch.rootId);
      if (!deepEqual(ch.deletedIds, expectedClosure)) fail('p16-replay', `${where}: deletedIds must be the subtree closure in document order`);
      lastDeletion = { indices: ch.deletedIds.map((id) => entities.findIndex((e) => e.id === id)), entities: ch.deletedIds.map((id) => cloned(entities.find((e) => e.id === id))) };
      entities = entities.filter((e) => !ch.deletedIds.includes(e.id));
    } else if (ch.type === 'restoreSubtree') {
      if (!lastDeletion) fail('p16-replay', `${where}: restoreSubtree without a preceding deletion`);
      else if (!deepEqual(ch.entities, lastDeletion.entities)) fail('p16-replay', `${where}: restored values must equal the deleted values byte-for-byte`);
      else for (const [i, idx] of lastDeletion.indices.entries()) entities.splice(idx, 0, cloned(lastDeletion.entities[i]));
    } else {
      fail('p16-replay', `${where}: unknown change type ${ch.type}`);
    }
  }

  // Undo/redo depth arithmetic: forward ops truncate redo, undo/redo move one
  // entry across the cursor (commands.md §9.1), and a duplicated replay is a
  // pure read (no depth change).
  {
    let u = 0;
    let r = 0;
    for (const step of scen.steps) {
      const { duplicated: _dup, ...resNoDup } = step.out;
      if (!step.out.duplicated) {
        if (step.in.op === 'undo') {
          if (u === 0) fail('p16-replay', `${step.stepId}: undo with an empty undo stack`);
          u -= 1;
          r += 1;
        } else if (step.in.op === 'redo') {
          if (r === 0) fail('p16-replay', `${step.stepId}: redo with an empty redo stack`);
          u += 1;
          r -= 1;
        } else {
          u += 1;
          r = 0;
        }
      }
      if (!deepEqual(step.out.history, { undoDepth: u, redoDepth: r })) {
        fail('p16-replay', `${step.stepId}: history depths ${JSON.stringify(step.out.history)} != expected ${JSON.stringify({ undoDepth: u, redoDepth: r })}`);
      }
      void resNoDup;
    }
  }

  if (!deepEqual(entities, after.scene.entities)) {
    const ids = entities.map((e) => e.id).join(',');
    const want = after.scene.entities.map((e) => e.id).join(',');
    fail('p16-replay', `replayed scene does not deep-equal commands/prefab-scenario.after.json (replayed [${ids}] vs after [${want}])`);
    for (let i = 0; i < Math.max(entities.length, after.scene.entities.length); i++) {
      if (canon(entities[i]) !== canon(after.scene.entities[i])) {
        fail('p16-replay', `first differing entity index ${i}: ${canon(entities[i])} != ${canon(after.scene.entities[i])}`);
        break;
      }
    }
  } else {
    pass('p16-replay', `${scen.steps.length} scenario steps replayed; deterministic ID allocation, internal-reference remap, one-undo subtree removal and exact-ID redo/retry verified; final scene deep-equals the after envelope`);
  }
  if (after.scene.revision !== revision) fail('p16-replay', `after revision ${after.scene.revision} != replayed revision ${revision}`);
  const publishedBehavior = scen.steps.find((s) => s.out.change && s.out.change.type === 'publishBehavior').out.change.next;
  if (!deepEqual(after.content.behaviors, [publishedBehavior])) {
    fail('p16-replay', 'after content.behaviors must carry exactly the published behavior record');
  }
  if (!deepEqual(after.content.prefabs, [definition])) fail('p16-replay', 'after content.prefabs must carry exactly the created definition');

  // --- failure set --------------------------------------------------------
  if (failSet) {
    let checked = 0;
    for (const c of failSet.cases) {
      const snap = c.state === 'base' ? failSet.base : failSet.stateSnapshots[c.state];
      if (!snap) {
        fail('p16-failures', `${c.caseId}: undeclared state ${c.state}`);
        continue;
      }
      let rev = snap.revision;
      for (const step of c.steps) {
        if (step.in.projectId !== 'demo-0003') fail('p16-failures', `${c.caseId}: projectId`);
        if (c.stale) {
          if (step.in.expectedRevision === rev) fail('p16-failures', `${c.caseId}: a stale-revision case must not carry the current revision`);
        } else if (step.in.expectedRevision !== rev) fail('p16-failures', `${c.caseId}: step expectedRevision ${step.in.expectedRevision} != ${rev}`);
        if (!P16_REQUEST_ID.test(step.in.requestId)) fail('p16-failures', `${c.caseId}: requestId syntax`);
        if (step.out.ok) rev += 1;
        else {
          if ('revision' in step.out || 'duplicated' in step.out) fail('p16-failures', `${c.caseId}: failure result must not carry revision/duplicated`);
          if (step.out.op !== step.in.op || step.out.requestId !== step.in.requestId) fail('p16-failures', `${c.caseId}: failure does not echo op/requestId`);
          if (!step.out.error || typeof step.out.error.code !== 'string' || typeof step.out.error.cls !== 'string') fail('p16-failures', `${c.caseId}: malformed error object`);
        }
      }
      const finalStep = c.steps[c.steps.length - 1];
      if (finalStep.out.ok) fail('p16-failures', `${c.caseId}: final step must be the expected failure`);
      if (finalStep.out.error && !c.expect.codes.includes(finalStep.out.error.code)) {
        fail('p16-failures', `${c.caseId}: error code ${finalStep.out.error.code} not in expect.codes`);
      }
      if (c.expect.durableStateUnchanged !== true) fail('p16-failures', `${c.caseId}: must assert durableStateUnchanged`);
      checked++;
    }
    pass('p16-failures', `${checked} failure case(s) checked (revision arithmetic, error shape, expected codes)`);
  }

  // --- query examples -----------------------------------------------------
  if (querySet && after) {
    if (querySet.revision !== after.scene.revision) fail('p16-queries', 'query examples must target the after revision');
    const qp = querySet.examples.queryProject.result;
    if (qp.revision !== querySet.revision || qp.projectId !== querySet.projectId) fail('p16-queries', 'queryProject revision/projectId');
    if (qp.scene.entityCount !== after.scene.entities.length) fail('p16-queries', 'queryProject entityCount mismatch');
    if (qp.content.assets !== after.content.assets.length || qp.content.prefabs !== after.content.prefabs.length || qp.content.behaviors !== after.content.behaviors.length) {
      fail('p16-queries', 'queryProject content counts mismatch');
    }
    const qa = querySet.examples.queryAssets.result;
    if (qa.total !== after.content.assets.length) fail('p16-queries', 'queryAssets total mismatch');
    if (!deepEqual(qa.assets.map((a) => a.assetId), after.content.assets.map((a) => a.assetId))) fail('p16-queries', 'queryAssets must be in ascending assetId order and match the catalog');
    const qpre = querySet.examples.queryPrefabs.result;
    if (qpre.total !== after.content.prefabs.length) fail('p16-queries', 'queryPrefabs total mismatch');
    if (!deepEqual(querySet.examples.queryPrefabDefinition.result.prefabs, after.content.prefabs)) fail('p16-queries', 'queryPrefabs includeEntities must return the exact definition');
    const qb = querySet.examples.queryBehaviors.result;
    if (qb.total !== after.content.behaviors.length) fail('p16-queries', 'queryBehaviors total mismatch');
    if (qb.behaviors[0].propertyCount !== after.content.behaviors[0].declaration.properties.length) fail('p16-queries', 'queryBehaviors propertyCount mismatch');
    if (!deepEqual(querySet.examples.queryBehaviorDeclaration.result.behaviors, after.content.behaviors)) fail('p16-queries', 'queryBehaviors includeDeclaration must return the exact record');
    if (querySet.state !== 'commands/prefab-scenario.after.json') fail('p16-queries', 'query examples must declare the after envelope');
    pass('p16-queries', 'query examples checked against the after envelope (counts, ids, definitions, declarations)');
  }
}

// ---------------------------------------------------------------------------
// 8. packet 17: ActionFrame, physics numerics, platformer traces, catch-up
// ---------------------------------------------------------------------------
//
// Independent reference implementation of the PROPOSED packet-17 contracts
// (docs/planning/m2-contracts/{input,physics,platformer}.md). The committed
// expectation tables were produced by a separate python3 implementation
// (docs/acceptance/evidence-m2/17/independent-recompute.py); this code
// re-derives them. Where this code and the proposals disagree, the proposals
// win and this code is a bug to fix.

const P17 = {
  dt: 1 / 120,
  g: -19.62,
  run: 4,
  jumpV: 7,
  maxFall: -30,
  accel: 40,
  decel: 60,
  coyote: 6,
  buffer: 8,
  release: 0.5,
  halfX: 0.31, // capsule radius 0.3 + skin 0.01
  halfY: 0.91, // half-height 0.6 + radius 0.3 + skin 0.01
  snap: 0.1,
  restY: 0.91,
  settle: 12,
  maxCatchup: 8,
  deadZone: 0.2,
  quantum: 1e-4,
};

const p17Floor = (hw = 200) => ({ id: 'floor', x: 0, y: -0.25, hw, hh: 0.25 });

function p17Approach(v, target, up, down) {
  if (Math.abs(target - v) <= 1e-9) return target;
  if (v < target) return Math.min(target, v + up);
  if (v > target) return Math.max(target, v - down);
  return v;
}

/** Scripted analytic port: axis-aligned statics, capsule as a (halfX, halfY) box. */
function p17PortStep(pos, req, statics, groundedPrev, groundUntilStep, stepIndex) {
  const blocked = groundUntilStep !== undefined && stepIndex > groundUntilStep;
  const active = blocked ? [] : statics;
  let nx = pos.x + req.x;
  let wall = false;
  for (const b of active) {
    if (Math.abs(pos.y - b.y) < P17.halfY + b.hh) {
      if (req.x > 0 && pos.x + P17.halfX <= b.x - b.hw && nx + P17.halfX > b.x - b.hw) {
        nx = b.x - b.hw - P17.halfX;
        wall = true;
      } else if (req.x < 0 && pos.x - P17.halfX >= b.x + b.hw && nx - P17.halfX < b.x + b.hw) {
        nx = b.x + b.hw + P17.halfX;
        wall = true;
      }
    }
  }
  let ny = pos.y + req.y;
  let ground = false;
  let head = false;
  for (const b of active) {
    if (Math.abs(nx - b.x) < P17.halfX + b.hw) {
      const top = b.y + b.hh;
      const bottom = b.y - b.hh;
      if (req.y <= 0 && pos.y - P17.halfY >= top - 1e-9 && ny - P17.halfY < top) {
        ny = top + P17.halfY;
        ground = true;
      } else if (req.y > 0 && pos.y + P17.halfY <= bottom + 1e-9 && ny + P17.halfY > bottom) {
        ny = bottom - P17.halfY;
        head = true;
      }
    }
  }
  let snapped = false;
  if (!ground && groundedPrev && req.y <= 0) {
    let best = null;
    for (const b of active) {
      if (Math.abs(nx - b.x) < P17.halfX + b.hw) {
        const top = b.y + b.hh;
        const gap = pos.y - P17.halfY - top;
        if (gap >= -1e-9 && gap <= P17.snap + 1e-9 && (best === null || top > best)) best = top;
      }
    }
    if (best !== null) {
      ny = best + P17.halfY;
      ground = true;
      snapped = true;
    }
  }
  return {
    pos: { x: nx, y: ny },
    result: {
      applied: { x: nx - pos.x, y: ny - pos.y },
      grounded: ground,
      supportNormal: ground ? { x: 0, y: 1 } : { x: 0, y: 0 },
      contacts: { ground, wall, head, steepSlope: false },
      snapped,
    },
  };
}

function p17RunTrace(trace, runSpeed) {
  const st = {
    stepIndex: trace.start.stepIndex, x: trace.start.x, y: trace.start.y,
    vx: trace.start.vx, vy: trace.start.vy, airborne: trace.start.airborne,
    coyote: trace.start.coyote, buffer: trace.start.buffer,
  };
  let prevResult = {
    grounded: trace.start.grounded,
    contacts: { ground: trace.start.grounded, wall: false, head: false, steepSlope: false },
  };
  const statics = (trace.port.statics ?? []).map((b) => ({ ...b }));
  if (trace.port.includeFloor !== false) statics.unshift(p17Floor());
  const frames = new Map((trace.frames ?? []).map((f) => [f.stepIndex, f]));
  const steps = [];
  for (let n = trace.start.stepIndex; n < trace.untilStep; n++) {
    const frame = frames.get(n) ?? { stepIndex: n, moveX: 0, jump: 'none' };
    const groundedPrev = prevResult.grounded === true;
    if (frame.jump === 'pressed') st.buffer = P17.buffer; // A
    if (groundedPrev) st.coyote = P17.coyote; // B
    let started = false; // C
    if (st.buffer > 0 && (groundedPrev || st.coyote > 0) && !st.airborne) {
      st.vy = P17.jumpV;
      st.airborne = true;
      st.buffer = 0;
      st.coyote = 0;
      started = true;
    }
    if (groundedPrev && !st.airborne) st.vy = 0; // D
    else st.vy = Math.max(st.vy + P17.g * P17.dt, P17.maxFall);
    if (prevResult.contacts.head && st.vy > 0) st.vy = 0; // E
    if (frame.jump === 'released' && st.airborne) { // F
      if (st.vy > 0) st.vy = st.vy * P17.release;
      st.airborne = false;
    }
    if (st.airborne && groundedPrev && st.vy <= 0) st.airborne = false; // G
    const target = frame.moveX * runSpeed; // H
    st.vx = p17Approach(st.vx, target, P17.accel * P17.dt, P17.decel * P17.dt);
    const req = { x: st.vx * P17.dt, y: st.vy * P17.dt }; // I
    const { pos, result } = p17PortStep({ x: st.x, y: st.y }, req, statics, groundedPrev, trace.port.groundUntilStep, n);
    st.x = pos.x;
    st.y = pos.y;
    if (!groundedPrev) st.coyote = Math.max(0, st.coyote - 1); // J
    if (!started) st.buffer = Math.max(0, st.buffer - 1); // K
    prevResult = result;
    steps.push({ stepIndex: n, frame, x: st.x, y: st.y, vx: st.vx, vy: st.vy, grounded: result.grounded, airborne: st.airborne, coyote: st.coyote, buffer: st.buffer, contacts: result.contacts, snapped: result.snapped });
  }
  return { st, steps, prevResult };
}

function packet17Numerics() {
  const doc = readJson('physics/numerics.json');
  if (!doc) return;
  const climb = (45 * Math.PI) / 180;
  const threshold = Math.cos(climb);
  const tol = 1e-6;
  const constants = new Map(doc.constants.map((c) => [c.name, c]));
  const expectConst = (name, value) => {
    const e = constants.get(name);
    if (!e) return fail('p17-numerics', `constant ${name} missing`);
    if (typeof value === 'number' ? Math.abs(e.value - value) > 1e-9 : e.value !== value) {
      fail('p17-numerics', `constant ${name} = ${JSON.stringify(e.value)}, expected ${JSON.stringify(value)}`);
    }
  };
  expectConst('gravityY', -19.62);
  expectConst('runSpeed', 4);
  expectConst('jumpVelocity', 7);
  expectConst('maxFallSpeed', -30);
  expectConst('capsuleRadius', 0.3);
  expectConst('capsuleHalfHeight', 0.6);
  expectConst('offsetSkin', 0.01);
  expectConst('groundSnap', 0.1);
  expectConst('maxSlopeClimbDeg', 45);
  expectConst('minSlopeSlideDeg', 30);
  expectConst('autostep', false);
  expectConst('settlePreRollSteps', 12);
  expectConst('moveAccel', 40);
  expectConst('moveDecel', 60);
  expectConst('jumpReleaseFactor', 0.5);
  expectConst('coyoteSteps', 6);
  expectConst('jumpBufferSteps', 8);
  // derived values must agree with the proposed contract
  const derived = doc.derived;
  if (Math.abs(derived.cosMaxSlopeClimb - threshold) > 1e-12) fail('p17-numerics', 'cosMaxSlopeClimb mismatch');
  if (Math.abs(derived.groundingThreshold - (threshold - tol)) > 1e-12) fail('p17-numerics', 'groundingThreshold mismatch');
  if (derived.accelStepsToRunSpeed !== 12) fail('p17-numerics', 'accelStepsToRunSpeed must be 12');
  if (derived.decelStepsToZero !== 8) fail('p17-numerics', 'decelStepsToZero must be 8');
  if (derived.coyoteWindowSteps !== 6 || derived.jumpBufferWindowSteps !== 8) fail('p17-numerics', 'window step counts mismatch');
  if (!(Math.abs(derived.jumpApexGainDiscrete - 1.249) <= 0.05)) fail('p17-numerics', 'discrete apex outside the 1.249 +/- 0.05 tolerance');
  if (Math.abs(7 * 7 / (2 * 19.62) - 1.249) > 5e-4) fail('p17-numerics', 'continuous-theory apex constant is not v^2/2g');
  // slope classification table: recompute each row from the angle
  let rows = 0;
  for (const row of doc.slopeClassification) {
    rows++;
    const nY = Math.cos((row.angleDeg * Math.PI) / 180);
    if (Math.abs(nY - row.supportNormalY) > 1e-12) fail('p17-numerics', `slope ${row.angleDeg}: supportNormalY mismatch`);
    if (row.grounded !== nY >= threshold - tol) fail('p17-numerics', `slope ${row.angleDeg}: grounded mismatch`);
    if (row.slidesWhenIdle !== row.angleDeg >= 30) fail('p17-numerics', `slope ${row.angleDeg}: slidesWhenIdle mismatch`);
  }
  // settings resolution cases against the registry table
  const registry = new Map(doc.settingsRegistry.map((r) => [r.key, r]));
  const defaults = {};
  for (const r of doc.settingsRegistry) defaults[r.key] = r.default;
  for (const c of doc.settingsCases) {
    if (c.outcome === 'ok') {
      const resolved = { ...defaults, ...c.input };
      if (!deepEqual(resolved, c.settings)) fail('p17-numerics', `${c.caseId}: resolved settings mismatch`);
      continue;
    }
    const key = Object.keys(c.input)[0];
    if (c.outcome === 'setting_unknown') {
      if (registry.has(key)) fail('p17-numerics', `${c.caseId}: key ${key} is registered but expected unknown`);
      continue;
    }
    const row = registry.get(key);
    if (!row) {
      fail('p17-numerics', `${c.caseId}: unknown registered key ${key}`);
      continue;
    }
    const v = c.input[key];
    if (key === 'min_slope_slide_deg' && c.input.max_slope_climb_deg !== undefined && c.input.max_slope_climb_deg <= v) {
      fail('p17-numerics', `${c.caseId}: cross-key rule not violated`);
    }
    if (typeof v === typeof row.default) {
      const below = row.min !== undefined && (row.exclusiveMin ? v <= row.min : v < row.min);
      const above = row.max !== undefined && (row.exclusiveMax ? v >= row.max : v > row.max);
      if (!below && !above && c.input.max_slope_climb_deg === undefined) {
        fail('p17-numerics', `${c.caseId}: value ${v} is inside the declared range`);
      }
    }
  }
  // validation cases must declare exactly one of outcome/code and use known limits
  const limits = new Set(['colliders', 'collider_vertices', 'collider_vertices_total']);
  for (const c of doc.validationCases) {
    if ('code' in c && 'outcome' in c) fail('p17-numerics', `${c.caseId}: both outcome and code declared`);
    if (!('code' in c) && !('outcome' in c)) fail('p17-numerics', `${c.caseId}: neither outcome nor code declared`);
    if (c.limit !== undefined && !limits.has(c.limit)) fail('p17-numerics', `${c.caseId}: unknown limit ${c.limit}`);
  }
  pass('p17-numerics', `${doc.constants.length} constants, ${rows} slope rows, ${doc.settingsCases.length} settings cases, ${doc.validationCases.length} validation cases re-derived`);
}

function packet17Traces() {
  const doc = readJson('platformer/traces.json');
  if (!doc) return;
  let rows = 0;
  let derived = 0;
  for (const trace of doc.traces) {
    const { steps } = p17RunTrace(trace, trace.start.runSpeedOverride ?? P17.run);
    const byIndex = new Map(steps.map((s) => [s.stepIndex, s]));
    for (const row of trace.sample) {
      rows++;
      const s = byIndex.get(row.stepIndex);
      if (!s) {
        fail('p17-traces', `${trace.traceId}: step ${row.stepIndex} not simulated`);
        continue;
      }
      const close = (a, b) => Math.abs(a - b) <= trace.replayToleranceM;
      if (!close(s.x, row.position.x) || !close(s.y, row.position.y)) {
        fail('p17-traces', `${trace.traceId}/${row.stepIndex}: position (${s.x},${s.y}) != (${row.position.x},${row.position.y})`);
      }
      if (!close(s.vx, row.velocity.x) || !close(s.vy, row.velocity.y)) {
        fail('p17-traces', `${trace.traceId}/${row.stepIndex}: velocity mismatch`);
      }
      if (s.grounded !== row.grounded) fail('p17-traces', `${trace.traceId}/${row.stepIndex}: grounded mismatch`);
      if (s.airborne !== row.airborne) fail('p17-traces', `${trace.traceId}/${row.stepIndex}: airborne mismatch`);
      if (s.coyote !== row.coyote || s.buffer !== row.buffer) fail('p17-traces', `${trace.traceId}/${row.stepIndex}: window counter mismatch`);
      if (!deepEqual(s.contacts, row.contacts)) fail('p17-traces', `${trace.traceId}/${row.stepIndex}: contacts mismatch`);
      // no Z drift: the expectation table itself must carry the authored Z/rotation/scale
      const authored = trace.start.authoredTransform;
      if (authored) {
        if (row.position.z !== authored.position[2]) fail('p17-traces', `${trace.traceId}/${row.stepIndex}: Z drifted in the expectation table`);
        if (!deepEqual(row.rotation, authored.rotation) || !deepEqual(row.scale, authored.scale)) {
          fail('p17-traces', `${trace.traceId}/${row.stepIndex}: rotation/scale changed in the expectation table`);
        }
      }
    }
    // derived expectations
    const e = trace.expect;
    const check = (name, actual) => {
      derived++;
      const expected = e[name];
      if (typeof expected === 'number' && typeof actual === 'number') {
        if (Math.abs(expected - actual) > 1e-9) fail('p17-traces', `${trace.traceId}: ${name} = ${expected}, recomputed ${actual}`);
      } else if (JSON.stringify(expected) !== JSON.stringify(actual)) {
        fail('p17-traces', `${trace.traceId}: ${name} = ${JSON.stringify(expected)}, recomputed ${JSON.stringify(actual)}`);
      }
    };
    if (trace.traceId === 'jump-hold-full-height') {
      const apex = steps.reduce((a, b) => (b.y > a.y ? b : a), steps[0]);
      check('apexStep', apex.stepIndex);
      check('apexCenterY', apex.y);
      check('apexGainM', apex.y - P17.restY);
      const landed = steps.find((s) => s.stepIndex > 12 && s.grounded && s.vy <= 0);
      check('landedStep', landed.stepIndex);
      check('landedCenterY', landed.y);
      if (!(Math.abs(e.apexGainM - e.apexTheoreticalM) <= e.apexToleranceM)) fail('p17-traces', 'apex outside the declared tolerance');
    }
    if (trace.traceId === 'jump-tap-release') {
      const apex = steps.reduce((a, b) => (b.y > a.y ? b : a), steps[0]);
      check('apexStep', apex.stepIndex);
      check('apexGainM', apex.y - P17.restY);
    }
    if (trace.traceId === 'no-air-jump') {
      let starts = 0;
      let prevAir = trace.start.airborne;
      for (const s of steps) {
        if (s.airborne && !prevAir) starts++;
        prevAir = s.airborne;
      }
      check('jumpStartCount', starts);
      check('maxVy', Math.max(...steps.map((s) => s.vy)));
    }
    if (trace.traceId === 'wall-stop' || trace.traceId === 'high-speed-wall-approach') {
      const contact = steps.find((s) => s.contacts.wall);
      check('contactStep', contact ? contact.stepIndex : null);
      check('maxCenterX', Math.max(...steps.map((s) => s.x)));
      if (trace.traceId === 'wall-stop') check('finalCenterX', steps[steps.length - 1].x);
      const limit = 9.5 - P17.halfX + e.maxPenetrationM;
      if (Math.max(...steps.map((s) => s.x)) > limit + 1e-9) fail('p17-traces', `${trace.traceId}: penetration beyond the declared tolerance`);
    }
    if (trace.traceId === 'head-bump') {
      const contact = steps.find((s) => s.contacts.head);
      check('contactStep', contact ? contact.stepIndex : null);
      check('maxCenterY', Math.max(...steps.map((s) => s.y)));
      const after = steps.filter((s) => contact && s.stepIndex > contact.stepIndex);
      check('maxVyAfterContact', after.length ? Math.max(...after.map((s) => s.vy)) : 0);
      let maxRise = 0;
      for (let i = 0; i < steps.length - 1; i++) {
        if (contact && steps[i].stepIndex >= contact.stepIndex) maxRise = Math.max(maxRise, steps[i + 1].y - steps[i].y);
      }
      check('maxAbsRisePerStepAfterContact', maxRise);
      if (maxRise > e.maxRisePerStepAfterContactM) fail('p17-traces', 'head contact allowed a sustained rise');
    }
    if (trace.traceId === 'ledge-block-and-jump-on') {
      const blocked = steps.filter((s) => s.contacts.wall);
      check('blockedStepCount', blocked.length);
      check('blockedFirstStep', blocked.length ? blocked[0].stepIndex : null);
      check('blockedCenterX', blocked.length ? blocked[blocked.length - 1].x : null);
      let maxDx = 0;
      for (let i = 0; i < blocked.length - 1; i++) maxDx = Math.max(maxDx, blocked[i + 1].x - blocked[i].x);
      check('maxDxWhileBlocked', maxDx);
      const landed = steps.find((s) => s.stepIndex >= 70 && s.grounded && s.y > 1);
      check('landedStep', landed ? landed.stepIndex : null);
      check('landedCenterY', landed ? landed.y : null);
      if (!(maxDx <= e.blockedMaxDxPerStepM)) fail('p17-traces', 'walking climbed the ledge (autostep not disabled)');
    }
    if (trace.traceId === 'seam-cross') {
      const ungrounded = steps.filter((s) => !s.grounded);
      check('ungroundedSteps', ungrounded.length);
      check('groundedEveryStep', ungrounded.length === 0);
      check('maxDxPerStep', Math.max(...steps.slice(1).map((s, i) => s.x - steps[i].x)));
      check('maxYDeviation', Math.max(...steps.map((s) => Math.abs(s.y - P17.restY))));
      if (ungrounded.length > e.maxUngroundedStepsAllowed) fail('p17-traces', 'seam-cross exceeded the allowed ungrounded steps');
      if (!(e.seamHalfWidthM > 0)) fail('p17-traces', 'seam-cross must declare a non-zero seam half width');
    }
    if (trace.traceId === 'snap-within-distance' || trace.traceId === 'snap-beyond-distance') {
      const ungrounded = steps.filter((s) => !s.grounded);
      check('ungroundedSteps', ungrounded.length);
      check('snapAbsorbedStepDown', ungrounded.length === 0);
      check('minCenterY', Math.min(...steps.map((s) => s.y)));
      if (trace.traceId === 'snap-within-distance') {
        check('finalCenterY', steps[steps.length - 1].y);
        if (ungrounded.length !== 0) fail('p17-traces', 'a step down inside the snap distance ungrounded the character');
        if (Math.abs(steps[steps.length - 1].y - e.expectedCenterY) > 1e-9) fail('p17-traces', 'snap did not place the character on the lower floor');
        if (e.stepDownM > e.snapDistanceM) fail('p17-traces', 'snap-within-distance declares a step down beyond the snap distance');
      } else {
        check('firstUngroundedStep', ungrounded.length ? ungrounded[0].stepIndex : null);
        check('landedStep', (() => { const l = steps.find((s) => s.stepIndex > 45 && s.grounded && s.y < 0.8); return l ? l.stepIndex : null; })());
        check('landedCenterY', (() => { const l = steps.find((s) => s.stepIndex > 45 && s.grounded && s.y < 0.8); return l ? l.y : null; })());
        if (ungrounded.length === 0) fail('p17-traces', 'a step down beyond the snap distance did not unground the character');
        if (!(e.stepDownM > e.snapDistanceM)) fail('p17-traces', 'snap-beyond-distance must exceed the snap distance');
      }
    }
    if (trace.traceId === 'flat-accel-decel') {
      const vxAt = (i) => byIndex.get(i).vx;
      check('vxAtStep23', vxAt(23));
      check('vxAtStep29', vxAt(29));
      check('vxAtStep37', vxAt(37));
      check('vxAtStep38', vxAt(38));
      if (vxAt(23) !== 4 || vxAt(37) !== 0) fail('p17-traces', 'accel/decel step counts do not reach the declared values');
      if (steps.some((s) => Math.abs(s.vx) > 4 + 1e-12)) fail('p17-traces', 'vx exceeded run_speed');
      if (steps.some((s) => Math.abs(s.y - P17.restY) > 1e-12)) fail('p17-traces', 'flat-ground Y drifted');
      if (!steps.every((s) => s.grounded)) fail('p17-traces', 'flat-ground trace lost grounding');
    }
    if (trace.traceId === 'jump-buffer-lands-in-window' || trace.traceId === 'jump-buffer-expired') {
      const landed = steps.find((s) => s.stepIndex > 12 && s.grounded);
      check('landingStep', landed ? landed.stepIndex : null);
      const starts = steps.filter((s, i) => s.airborne && !(i ? steps[i - 1].airborne : trace.start.airborne)).map((s) => s.stepIndex);
      check('jumpStartedStep', starts.length ? starts[0] : null);
    }
    if (trace.traceId === 'jump-coyote-last-step' || trace.traceId === 'jump-coyote-one-step-late') {
      const starts = steps.filter((s, i) => s.airborne && !(i ? steps[i - 1].airborne : trace.start.airborne)).map((s) => s.stepIndex);
      check('jumpStartedStep', starts.length ? starts[0] : null);
    }
  }
  pass('p17-traces', `${doc.traces.length} traces, ${rows} sampled step rows and ${derived} derived expectations replayed`);
}

function p17Quantize(v) {
  const c = Math.max(-1, Math.min(1, v));
  const q = Math.floor(Math.abs(c) * 1e4 + 0.5) / 1e4;
  return q === 0 ? 0 : v >= 0 ? q : -q;
}

function p17RescaledStick(axis) {
  const a = Math.abs(axis);
  if (a <= P17.deadZone) return 0;
  return Math.sign(axis) * ((a - P17.deadZone) / (1 - P17.deadZone));
}

function p17MapRaw(raw, stepIndex, prevDown, verified) {
  let digital = 0;
  if (raw.keyboardLeft && !raw.keyboardRight) digital = -1;
  else if (raw.keyboardRight && !raw.keyboardLeft) digital = 1;
  else if (raw.dpad !== undefined && raw.dpad !== 0) digital = raw.dpad > 0 ? 1 : -1;
  const stick = p17RescaledStick(raw.stickX ?? 0);
  const moveX = p17Quantize(digital !== 0 ? digital : stick);
  const downNow = raw.jumpDown === true;
  let jump;
  let nextDown = downNow;
  let nextVerified = verified;
  if (!verified) {
    if (downNow) jump = 'held';
    else {
      jump = 'none';
      nextVerified = true;
    }
  } else {
    const down = downNow || raw.jumpLatch === true;
    if (down && !prevDown) jump = 'pressed';
    else if (down && prevDown) jump = 'held';
    else if (!down && prevDown) jump = 'released';
    else jump = 'none';
    nextDown = down;
  }
  return { frame: { stepIndex, moveX, jump }, next: { down: nextDown, verified: nextVerified } };
}

function packet17Input() {
  const doc = readJson('input/action-sequences.json');
  if (!doc) return;
  let maps = 0;
  for (const c of doc.mappingCases) {
    maps++;
    const { frame, next } = p17MapRaw(c.raw, c.stepIndex, c.prevDown, c.verified);
    if (!deepEqual(frame, c.expectFrame)) fail('p17-input', `${c.caseId}: frame ${JSON.stringify(frame)} != ${JSON.stringify(c.expectFrame)}`);
    if (!deepEqual(next, c.expectNext)) fail('p17-input', `${c.caseId}: next state mismatch`);
  }
  const phases = new Set(['none', 'pressed', 'held', 'released']);
  for (const c of doc.mappingCases) if (!phases.has(c.expectFrame.jump)) fail('p17-input', `${c.caseId}: bad jump phase`);
  let seqs = 0;
  for (const c of doc.sequenceCases) {
    seqs++;
    let down = false;
    let verified = true;
    let pressed = 0;
    const frames = [];
    for (const step of c.sampleSteps) {
      const prior = c.events.filter((e) => e.atStep <= step);
      const held = prior.length ? prior[prior.length - 1].kind === 'down' : false;
      const latch = c.events.some((e) => e.kind === 'down' && e.atStep > step - 1 && e.atStep <= step);
      if (c.suspendBeforeStep !== undefined && step >= c.suspendBeforeStep && frames.length + 1 === c.suspendBeforeStep - c.sampleSteps[0] + 1) {
        // suspension at the named step: clear held/latch state and require a release
        down = false;
        verified = false;
      }
      const { frame, next } = p17MapRaw({ stickX: 0, jumpDown: held, jumpLatch: latch }, step, down, verified);
      down = next.down;
      verified = next.verified;
      if (frame.jump === 'pressed') pressed++;
      frames.push(frame);
    }
    if (!deepEqual(frames, c.expectFrames)) fail('p17-input', `${c.caseId}: sequence frames mismatch`);
    if (pressed !== c.expectPressedCount) fail('p17-input', `${c.caseId}: pressed count ${pressed} != ${c.expectPressedCount}`);
    if (c.suspendBeforeStep !== undefined && verified === false && pressed !== 0) fail('p17-input', `${c.caseId}: a suspension produced a phantom edge`);
  }
  const fields = new Set(['stepIndex', 'moveX', 'jump']);
  for (const c of doc.invalidFrames) {
    for (const f of c.frames) {
      for (const k of Object.keys(f)) if (!fields.has(k) && c.field === 'device') {
        if (k !== c.field) fail('p17-input', `${c.caseId}: unknown field ${k} is not the declared ${c.field}`);
      }
    }
  }
  pass('p17-input', `${maps} mapping cases and ${seqs} step-indexed sequences replayed`);
}

function p17Scheduler(startStepIndex, startSimTime, frames, preRollSteps) {
  let stepIndex = startStepIndex;
  let simTime = startSimTime;
  let anchor = { wallAtFrame: 0, simTimeAtAnchor: simTime };
  let dropped = 0;
  let warnings = 0;
  let wall = 0;
  let preRoll = preRollSteps;
  const observations = [];
  const sampled = [];
  const executed = [];
  const preRollStepIndices = [];
  for (const f of frames) {
    wall += f.elapsed;
    if (preRoll > 0) {
      const n = preRoll;
      preRoll = 0;
      for (let i = 0; i < n; i++) preRollStepIndices.push(stepIndex + i);
      stepIndex += n;
      simTime = stepIndex / 120;
      anchor = { wallAtFrame: wall, simTimeAtAnchor: simTime };
      observations.push({ frameId: f.frameId, stepsExecuted: n, droppedSteps: 0, simTimeAfter: simTime, preRoll: true, actionSamples: [] });
      continue;
    }
    let elapsed = wall - anchor.wallAtFrame;
    if (elapsed < 0) {
      warnings++;
      elapsed = 0;
    }
    const target = anchor.simTimeAtAnchor + elapsed;
    let raw = Math.floor((target - simTime) / P17.dt);
    if (raw < 0) raw = 0;
    const n = Math.min(raw, P17.maxCatchup);
    const samples = [];
    for (let i = 0; i < n; i++) {
      executed.push(stepIndex + i);
      samples.push(stepIndex + i);
      sampled.push(stepIndex + i);
    }
    stepIndex += n;
    let dropNow = 0;
    if (raw > P17.maxCatchup) {
      dropNow = raw - P17.maxCatchup;
      dropped += dropNow;
    }
    simTime = stepIndex / 120;
    if (dropNow > 0) anchor = { wallAtFrame: wall, simTimeAtAnchor: simTime };
    observations.push({ frameId: f.frameId, stepsExecuted: n, droppedSteps: dropNow, simTimeAfter: simTime, preRoll: false, actionSamples: samples });
  }
  return { observations, stepIndexEnd: stepIndex, droppedSteps: dropped, clockWarningCount: warnings, sampledStepIndices: sampled, executedStepIndices: executed, preRollStepIndices };
}

function packet17Catchup() {
  const doc = readJson('runtime/catchup.json');
  if (!doc) return;
  let cases = 0;
  for (const c of doc.cases) {
    cases++;
    const run = p17Scheduler(c.startStepIndex, c.startSimTime, c.frames, c.preRollSteps ?? 0);
    if (!deepEqual(run.observations, c.expect.observations)) fail('p17-catchup', `${c.caseId}: observations mismatch`);
    if (run.stepIndexEnd !== c.expect.stepIndexEnd) fail('p17-catchup', `${c.caseId}: final stepIndex ${run.stepIndexEnd} != ${c.expect.stepIndexEnd}`);
    if (run.droppedSteps !== c.expect.droppedSteps) fail('p17-catchup', `${c.caseId}: droppedSteps ${run.droppedSteps} != ${c.expect.droppedSteps}`);
    if (run.clockWarningCount !== c.expect.clockWarningCount) fail('p17-catchup', `${c.caseId}: clockWarningCount mismatch`);
    if (!deepEqual(run.sampledStepIndices, c.expect.sampledStepIndices)) fail('p17-catchup', `${c.caseId}: sampled step indices mismatch`);
    if (new Set(run.executedStepIndices).size !== run.executedStepIndices.length) fail('p17-catchup', `${c.caseId}: a step index was executed twice`);
    const allIndices = [...run.preRollStepIndices, ...run.executedStepIndices];
    if (!allIndices.every((v, i) => i === 0 || v === allIndices[i - 1] + 1)) fail('p17-catchup', `${c.caseId}: executed step indices are not contiguous (phantom step)`);
    if (!run.observations.every((o) => o.preRoll || o.stepsExecuted <= P17.maxCatchup)) fail('p17-catchup', `${c.caseId}: a frame exceeded the 8-step cap`);
    const droppedCovered = run.sampledStepIndices.length === run.executedStepIndices.length
      && run.preRollStepIndices.length === c.preRollSteps;
    if (!droppedCovered) fail('p17-catchup', `${c.caseId}: not every executed (non-pre-roll) step was sampled exactly once`);
    if (c.expect.pressedCount !== undefined) {
      const pressed = (c.expect.recordedFrames ?? []).filter((f) => f.jump === 'pressed').length;
      if (pressed !== c.expect.pressedCount) fail('p17-catchup', `${c.caseId}: pressed count mismatch`);
      const sampledOnce = c.expect.recordedFrames.every((f) => c.expect.sampledStepIndices.filter((i) => i === f.stepIndex).length === 1);
      if (!sampledOnce) fail('p17-catchup', `${c.caseId}: a recorded frame index was sampled more than once`);
    }
    if (run.preRollStepIndices.length !== (c.preRollSteps ?? 0)) fail('p17-catchup', `${c.caseId}: pre-roll step count mismatch`);
  }
  // ownership/combination cases
  const ownershipCodes = new Set(['transform_owner_conflict', 'transform_owner_forbidden', 'module_combination_unsupported', 'config_invalid', 'snapshot_invalid']);
  for (const o of doc.ownershipCases) {
    if (o.code !== undefined && !ownershipCodes.has(o.code)) fail('p17-catchup', `${o.caseId}: unknown ownership code`);
    if (o.code === undefined && o.outcome !== 'ok') fail('p17-catchup', `${o.caseId}: neither outcome nor code`);
  }
  const order = doc.phaseOrder;
  if (!deepEqual(order, ['sample', 'intent', 'controller', 'physics', 'transform', 'render'])) fail('p17-catchup', 'phase order is not the contract order');
  pass('p17-catchup', `${cases} scheduler cases and ${doc.ownershipCases.length} ownership/combination cases replayed`);
}

function packet17Failures() {
  const doc = readJson('platformer/failures.json');
  if (!doc) return;
  const registry = new Set([
    ...(readJson('expected.json')?.registry?.runtimeErrorCodes ?? []),
    ...(readJson('expected.json')?.registry?.modelErrorCodes ?? []),
  ]);
  let cases = 0;
  for (const c of doc.cases) {
    cases++;
    const codes = [c.code, ...(c.codes ?? []), ...(c.innerCodes ?? [])].filter((v) => typeof v === 'string');
    if (!c.durableEffect) fail('p17-failures', `${c.caseId}: no durableEffect declared`);
    if (!c.runtimeState && !c.triggers) fail('p17-failures', `${c.caseId}: no runtimeState declared`);
    if (codes.length === 0 && !c.diagnostics) fail('p17-failures', `${c.caseId}: neither a code nor a diagnostic class declared`);
    for (const code of codes) if (!registry.has(code)) fail('p17-failures', `${c.caseId}: code ${code} is not in the runtime/model registry`);
    if (c.runtimeState === 'failed' && c.rollbackAttempted !== undefined) fail('p17-failures', `${c.caseId}: failed cases must not declare rollback`);
  }
  const sm = doc.stateMachine;
  if (sm.rollbackAttempted !== false) fail('p17-failures', 'the state machine must not attempt rollback');
  if (!deepEqual(sm.failedFrom, ['running', 'stopped']) || !deepEqual(sm.failedTo, ['disposed'])) fail('p17-failures', 'failed-state transitions do not match the contract');
  pass('p17-failures', `${cases} failure cases checked (codes, state, durable effect)`);
}

// ---------------------------------------------------------------------------
// 8. packet 18: source-graph taxonomy, compiler bounds, the example manifest,
//    the intent model and the publication state machine
//
// Independent re-implementation of the proposed rules (behaviors.md §3/§4/§6/
// §9/§8). It is fixture tooling, not an implementation of the compiler.
// ---------------------------------------------------------------------------

const P18_PINNED = ['@thirdlight/runtime'];
const P18_NODE_BUILTINS = new Set(['assert', 'buffer', 'child_process', 'crypto', 'dns', 'events', 'fs', 'http', 'https', 'module', 'net', 'os', 'path', 'process', 'stream', 'tls', 'url', 'util', 'vm', 'worker_threads', 'zlib']);
const P18_PATH_RE = /^[a-z0-9][a-z0-9._-]*(\/[a-z0-9][a-z0-9._-]*)*$/;
const P18_JUMP = new Set(['none', 'pressed', 'held', 'released']);

function p18PosixResolve(fromPath, spec) {
  const parts = fromPath.split('/').slice(0, -1);
  let up = 0;
  for (const seg of spec.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length > 0) parts.pop();
      else up++;
    } else parts.push(seg);
  }
  return '../'.repeat(up) + parts.join('/');
}

/** Extract import-ish constructs in text order. */
function p18ScanText(path, text) {
  const hits = [];
  const push = (index, kind, extra) => hits.push({ index, kind, ...extra });
  const patterns = [
    { re: /\bimport\s*\(/g, kind: 'dynamic_import' },
    { re: /\beval\s*\(/g, kind: 'eval' },
    { re: /\bnew\s+Function\s*\(/g, kind: 'function_constructor' },
    { re: /\bFunction\s*\(/g, kind: 'function_constructor' },
    { re: /\brequire\s*\(/g, kind: 'require' },
  ];
  for (const { re, kind } of patterns) {
    for (const m of text.matchAll(re)) push(m.index, 'dynamic', { reason: kind });
  }
  const importDecl = /\b(?:import|export)\s+(type\s+)?([\s\S]*?)\s*from\s*['"]([^'"]+)['"]/g;
  for (const m of text.matchAll(importDecl)) push(m.index, 'specifier', { typeOnly: Boolean(m[1]), spec: m[3] });
  const sideEffect = /\bimport\s*['"]([^'"]+)['"]/g;
  for (const m of text.matchAll(sideEffect)) push(m.index, 'specifier', { typeOnly: false, spec: m[1] });
  hits.sort((a, b) => a.index - b.index);
  return hits;
}

function p18Classify(spec, typeOnly, pinned) {
  if (/^[a-z][a-z0-9+.-]*:/i.test(spec)) {
    if (spec.startsWith('node:')) return { code: 'behavior_import_forbidden', reason: 'node_builtin', specifier: spec };
    return { code: 'behavior_import_forbidden', reason: 'network', specifier: spec };
  }
  if (spec.startsWith('/')) return { code: 'behavior_import_forbidden', reason: 'absolute', specifier: spec };
  if (spec.startsWith('./') || spec.startsWith('../')) return { relative: true };
  if (spec.startsWith('#')) return { code: 'behavior_import_forbidden', reason: 'absolute', specifier: spec };
  if (P18_NODE_BUILTINS.has(spec.split('/')[0])) return { code: 'behavior_import_forbidden', reason: 'node_builtin', specifier: spec };
  if (pinned.includes(spec)) {
    if (typeOnly) return { typeOnlyEngine: true, specifier: spec };
    return { code: 'behavior_import_forbidden', reason: 'engine_value_import', specifier: spec };
  }
  return { code: 'behavior_import_forbidden', reason: 'bare', specifier: spec };
}

/** behaviors.md §4.3 order. Returns a derived verdict object. */
function p18AnalyzeGraph(container, pinned) {
  const bad = (code, extra = {}) => ({ ok: false, code, ...extra });
  if (container.graphVersion !== 1) return bad('behavior_source_invalid', { reason: 'graph_version' });
  const files = container.files ?? [];
  if (!files.some((f) => f.path === container.entryPath)) return bad('behavior_source_invalid', { reason: 'entry_missing' });
  for (const f of files) {
    if (!P18_PATH_RE.test(f.path)) return bad('behavior_source_invalid', { reason: 'path', path: f.path });
    if (!f.path.endsWith('.ts')) return bad('behavior_source_invalid', { reason: 'extension', path: f.path });
  }
  const sorted = (arr) => arr.every((v, i) => i === 0 || arr[i - 1] <= v);
  if (!sorted(files.map((f) => f.path)) || !sorted(container.requiredModules ?? []) || !sorted(container.ownedTransforms ?? [])) {
    return bad('behavior_source_invalid', { reason: 'file_order' });
  }
  const paths = files.map((f) => f.path);
  if (new Set(paths).size !== paths.length) return bad('behavior_source_duplicate');
  const dupIn = (arr) => new Set(arr).size !== arr.length;
  if (dupIn(container.requiredModules ?? []) || dupIn(container.ownedTransforms ?? [])) return bad('behavior_source_invalid', { reason: 'duplicate' });
  const bytes = files.map((f) => Buffer.byteLength(f.text, 'utf8'));
  if (files.length > 16) return bad('behavior_source_limits_exceeded', { limit: 'files', current: files.length, max: 16 });
  const overFile = bytes.findIndex((n) => n > 65536);
  if (overFile >= 0) return bad('behavior_source_limits_exceeded', { limit: 'file_bytes', current: bytes[overFile], max: 65536 });
  const graphBytes = Buffer.byteLength(JSON.stringify(container, null, 2) + '\n', 'utf8');
  if (graphBytes > 262144) return bad('behavior_source_limits_exceeded', { limit: 'graph_bytes', current: graphBytes, max: 262144 });
  if ((container.ownedTransforms ?? []).length > 16) return bad('behavior_source_limits_exceeded', { limit: 'owned_transforms', current: container.ownedTransforms.length, max: 16 });
  for (const mod of container.requiredModules ?? []) if (!pinned.includes(mod)) return bad('behavior_import_unpinned', { moduleId: mod });
  // ordered import scan (file order, then text position)
  const edges = [];
  let typeOnlyImports = 0;
  let acceptedImports = 0;
  for (const f of files) {
    const hits = p18ScanText(f.path, f.text);
    const importCount = hits.filter((h) => h.kind === 'specifier').length;
    if (importCount > 16) return bad('behavior_source_limits_exceeded', { limit: 'imports', current: importCount, max: 16 });
    for (const h of hits) {
      if (h.kind === 'dynamic') return bad('behavior_dynamic_code', { reason: h.reason, path: f.path });
      const cls = p18Classify(h.spec, h.typeOnly, pinned);
      if (cls.typeOnlyEngine) { typeOnlyImports++; continue; }
      if (cls.relative) { acceptedImports++; edges.push([f.path, h.spec]); continue; }
      return bad(cls.code, { reason: cls.reason, specifier: cls.specifier, path: f.path });
    }
  }
  // resolution
  const relEdges = [];
  for (const [from, spec] of edges) {
    let target = p18PosixResolve(from, spec);
    if (!target.endsWith('.ts')) target += '.ts';
    if (target.startsWith('../') || target.startsWith('..')) return bad('behavior_source_escape', { resolved: target, path: from });
    if (!paths.includes(target)) return bad('behavior_source_missing', { resolved: target, path: from });
    relEdges.push([from, target]);
  }
  // cycle
  const adj = new Map();
  for (const [a, b] of relEdges) adj.set(a, [...(adj.get(a) ?? []), b]);
  const state = new Map();
  const stack = [];
  let cycle = null;
  (function visit(node) {
    if (cycle) return;
    state.set(node, 1);
    stack.push(node);
    for (const next of adj.get(node) ?? []) {
      if (state.get(next) === 1) { cycle = [...stack.slice(stack.indexOf(next)), next]; return; }
      if (!state.has(next)) visit(next);
    }
    stack.pop();
    state.set(node, 2);
  })(container.entryPath);
  if (cycle) return bad('behavior_source_cycle', { cycle });
  // depth
  const depthOf = (node) => {
    let best = 0;
    for (const next of adj.get(node) ?? []) best = Math.max(best, 1 + depthOf(next));
    return best;
  };
  const importDepth = depthOf(container.entryPath);
  if (importDepth > 8) return bad('behavior_source_limits_exceeded', { limit: 'import_depth', current: importDepth, max: 8 });
  return { ok: true, fileCount: files.length, requiredModules: container.requiredModules ?? [], ownedTransforms: container.ownedTransforms ?? [], entryPath: container.entryPath, importDepth, typeOnlyImports, acceptedImports, relativeEdges: relEdges };
}

function p18ExpectMatch(check, where, expect, derived) {
  for (const [k, v] of Object.entries(expect)) {
    const got = derived[k];
    if (canon(got) !== canon(v)) fail(check, `${where}: ${k} derived ${canon(got)} != expected ${canon(v)}`);
  }
}

function p18Constructed(state) {
  const bad = (code, extra = {}) => ({ ok: false, code, ...extra });
  if (state.fileCount > 16) return bad('behavior_source_limits_exceeded', { limit: 'files' });
  if (state.fileBytes > 65536) return bad('behavior_source_limits_exceeded', { limit: 'file_bytes' });
  if (state.graphBytes > 262144) return bad('behavior_source_limits_exceeded', { limit: 'graph_bytes' });
  if (state.ownedTransforms > 16) return bad('behavior_source_limits_exceeded', { limit: 'owned_transforms' });
  if (state.requiredModules) {
    if (new Set(state.requiredModules).size !== state.requiredModules.length) return bad('behavior_source_invalid', { reason: 'duplicate' });
    for (const m of state.requiredModules) if (!P18_PINNED.includes(m)) return bad('behavior_import_unpinned', { moduleId: m });
  }
  if (state.importsPerFile > 16) return bad('behavior_source_limits_exceeded', { limit: 'imports' });
  if (state.importDepth > 8) return bad('behavior_source_limits_exceeded', { limit: 'import_depth' });
  if (state.syntaxError) return bad('behavior_source_invalid', { reason: 'syntax' });
  if (state.compileTimeoutMs > 2000) return bad('behavior_compile_timeout');
  if (state.compileFailed) {
    const diagnostics = state.diagnostics ?? 1;
    return bad('behavior_compile_failed', { diagnosticsStored: Math.min(diagnostics, 32), diagnosticsTruncated: diagnostics > 32 });
  }
  if (state.outputBytes > 131072) return bad('behavior_output_limits_exceeded', { limit: 'output_bytes' });
  if (state.outputScanPattern) return bad('behavior_output_forbidden_content', { reason: state.outputScanPattern });
  if (state.manifestMismatch) return bad('behavior_declaration_mismatch', { reason: 'manifest' });
  if (state.trustAcknowledged === false) return bad('behavior_trust_unacknowledged', { reason: 'digest' });
  return { ok: true };
}

function p18SourceGraphs() {
  const doc = readJson('behaviors/source-graphs.json');
  if (!doc) return;
  let checked = 0;
  for (const c of doc.cases) {
    const buf = readFileSync(join(ROOT, c.container));
    const digest = sha256(buf);
    if (digest !== c.containerDigest) fail('p18-source-graphs', `${c.caseId}: containerDigest ${digest} != ${c.containerDigest}`);
    if (buf.length !== c.containerByteLength) fail('p18-source-graphs', `${c.caseId}: containerByteLength ${buf.length} != ${c.containerByteLength}`);
    const container = readJson(c.container);
    if (!container) continue;
    p18ExpectMatch('p18-source-graphs', c.caseId, c.expect, p18AnalyzeGraph(container, P18_PINNED));
    checked++;
  }
  for (const c of doc.constructed) {
    p18ExpectMatch('p18-source-graphs', c.caseId, c.expect, p18Constructed(c.state));
    checked++;
  }
  // the declared limits must equal the contract's table
  const limits = { files: 16, fileBytes: 65536, graphBytes: 262144, importDepth: 8, importsPerFile: 16, ownedTransforms: 16, diagnostics: 32, timeoutMs: 2000, outputBytes: 131072 };
  for (const [k, v] of Object.entries(limits)) {
    if (doc.limits[k] !== v) fail('p18-source-graphs', `limits.${k} = ${doc.limits[k]}, expected ${v}`);
  }
  pass('p18-source-graphs', `${checked} source-graph case(s) (${doc.cases.length} container + ${doc.constructed.length} constructed) re-derived from behaviors.md §4.3/§6`);
}

function p18QuantizeMove(v) {
  const q = Math.round(v * 1e4) / 1e4;
  return q === 0 ? 0 : q;
}

function p18Effective(action, intents) {
  return { stepIndex: action.stepIndex, moveX: intents.move ?? action.moveX, jump: intents.jump ?? action.jump };
}

function p18ValidateOne(c, phase, limits, state) {
  const intent = c.intent ?? {};
  if (typeof intent !== 'object' || intent === null || typeof intent.kind !== 'string' || !['control_move', 'control_jump', 'transform'].includes(intent.kind)) {
    return { ok: false, code: 'module_error', reason: 'behavior_intent_invalid', detail: 'shape' };
  }
  const allowed = intent.kind === 'transform' ? ['kind', 'entityId', 'position'] : ['kind', 'value'];
  if (Object.keys(intent).some((k) => !allowed.includes(k))) return { ok: false, code: 'module_error', reason: 'behavior_intent_invalid', detail: 'shape' };
  if (phase !== (intent.kind === 'transform' ? 'transform' : 'intent')) return { ok: false, code: 'module_error', reason: 'behavior_intent_invalid', detail: 'phase' };
  if (intent.kind === 'control_move') {
    if (typeof intent.value !== 'number') return { ok: false, code: 'module_error', reason: 'behavior_intent_invalid', detail: 'shape' };
    if (!Number.isFinite(intent.value) || intent.value < -1 || intent.value > 1) return { ok: false, code: 'module_error', reason: 'behavior_intent_invalid', detail: 'value' };
  } else if (intent.kind === 'control_jump') {
    if (typeof intent.value !== 'string' || !P18_JUMP.has(intent.value)) return { ok: false, code: 'module_error', reason: 'behavior_intent_invalid', detail: 'value' };
  } else {
    const pos = intent.position;
    if (typeof pos !== 'object' || pos === null) return { ok: false, code: 'module_error', reason: 'behavior_intent_invalid', detail: 'shape' };
    const axes = Object.keys(pos);
    if (axes.length === 0 || axes.some((a) => !['x', 'y', 'z'].includes(a))) return { ok: false, code: 'module_error', reason: 'behavior_intent_invalid', detail: 'value' };
    for (const a of axes) if (typeof pos[a] !== 'number' || !Number.isFinite(pos[a]) || Math.abs(pos[a]) > 1e6) return { ok: false, code: 'module_error', reason: 'behavior_intent_invalid', detail: 'value' };
    if (!(c.ownedTransforms ?? []).includes(intent.entityId)) return { ok: false, code: 'module_error', reason: 'behavior_transform_forbidden', detail: 'not_owner' };
  }
  const key = intent.kind === 'transform' ? intent.entityId + ':' + Object.keys(intent.position).sort().join(',') : intent.kind;
  const seen = state.perInstance.get(c.moduleId) ?? new Set();
  if (seen.has(key)) return { ok: false, code: 'module_error', reason: 'behavior_intent_conflict', detail: 'duplicate_intent' };
  seen.add(key);
  state.perInstance.set(c.moduleId, seen);
  if (intent.kind !== 'transform') {
    const owner = state.channelWriter.get(intent.kind);
    if (owner && owner !== c.moduleId) return { ok: false, code: 'module_error', reason: 'behavior_intent_conflict', detail: 'duplicate_writer' };
    state.channelWriter.set(intent.kind, c.moduleId);
  }
  if (seen.size > limits.intentsPerInstanceStep) return { ok: false, code: 'module_error', reason: 'behavior_intent_limit', detail: 'per_instance' };
  state.committed++;
  if (state.committed > state.stepCap) return { ok: false, code: 'module_error', reason: 'behavior_intent_limit', detail: 'per_step' };
  if (intent.kind === 'control_move') { state.move = p18QuantizeMove(intent.value); state.moveWriter = c.moduleId; }
  if (intent.kind === 'control_jump') { state.jump = intent.value; state.jumpWriter = c.moduleId; }
  if (intent.kind === 'transform') state.transformWrites.push({ moduleId: c.moduleId, entityId: intent.entityId, position: { ...intent.position } });
  return { ok: true };
}

function p18ReplayStep(step, limits) {
  // Phase 21.2: the per-step cap scales with the step's instances (one per module id here):
  // max(intentsPerStep, intentsPerInstanceStep x instances).
  const instances = new Set([...(step.intentPhase ?? []), ...(step.transformPhase ?? [])].map((c) => c.moduleId)).size;
  const stepCap = Math.max(limits.intentsPerStep, limits.intentsPerInstanceStep * instances);
  const state = { perInstance: new Map(), channelWriter: new Map(), committed: 0, stepCap, move: null, jump: null, moveWriter: null, jumpWriter: null, transformWrites: [] };
  for (const [phase, list] of [['intent', step.intentPhase ?? []], ['transform', step.transformPhase ?? []]]) {
    for (const c of list) {
      const verdict = p18ValidateOne(c, phase, limits, state);
      if (!verdict.ok) return verdict;
    }
  }
  return { ok: true, committed: { move: state.move, jump: state.jump, moveWriter: state.moveWriter, jumpWriter: state.jumpWriter, transformWrites: state.transformWrites } };
}

function p18Intents() {
  const doc = readJson('behaviors/intents.json');
  if (!doc) return;
  for (const row of doc.quantization) {
    const got = p18QuantizeMove(row.input);
    if (canon(got) !== canon(row.expected)) fail('p18-intents', `quantize(${row.input}) = ${got}, expected ${row.expected}`);
  }
  let replayed = 0;
  for (const c of doc.steps) {
    const derived = p18ReplayStep(c.step, doc.limits);
    p18ExpectMatch('p18-intents', c.caseId, c.expect, derived);
    replayed++;
  }
  for (const c of doc.effectiveFrames) {
    const got = p18Effective(c.action, c.intents);
    if (canon(got) !== canon(c.expected)) fail('p18-intents', `${c.caseId}: effective ${canon(got)} != ${canon(c.expected)}`);
  }
  pass('p18-intents', `${doc.quantization.length} quantization row(s), ${replayed} intent step(s) and ${doc.effectiveFrames.length} effective-frame row(s) replayed`);
}

function p18RuntimeFailures() {
  const doc = readJson('behaviors/runtime-failures.json');
  if (!doc) return;
  const reasons = new Set(['behavior_intent_invalid', 'behavior_intent_conflict', 'behavior_intent_limit', 'behavior_transform_forbidden', 'behavior_step_async', 'behavior_state_shared', 'behavior_prepare_failed', 'behavior_instantiate_failed', 'behavior_step_failed', 'behavior_source_unlinked', 'behavior_modules', 'phase_violation', 'behavior_ownership_forbidden']);
  const ids = new Set();
  for (const c of doc.cases) {
    if (ids.has(c.caseId)) fail('p18-runtime-failures', `duplicate caseId ${c.caseId}`);
    ids.add(c.caseId);
    for (const key of ['title', 'trigger', 'runtimeState', 'durableEffect']) if (!(key in c)) fail('p18-runtime-failures', `${c.caseId}: missing ${key}`);
    const runtimeCodes = ['module_error', 'config_invalid', 'transform_owner_forbidden'];
    if (runtimeCodes.includes(c.code) && c.reason != null && !reasons.has(c.reason)) fail('p18-runtime-failures', `${c.caseId}: reason "${c.reason}" is not in the proposed runtime reason set`);
  }
  for (const f of doc.floods) {
    const perStepCap = doc.limits.logsPerStep;
    const ring = doc.limits.logsPerInstance;
    if (typeof f.callsPerStep === 'number') {
      const logCount = f.callsPerStep * f.steps;
      const accepted = Math.min(f.callsPerStep, perStepCap) * f.steps;
      const derived = { logCount, accepted, stored: accepted, dropped: logCount - accepted, ring: Math.min(accepted, ring) };
      for (const [k, v] of Object.entries(f.expect)) {
        if (k === 'errorCount') continue;
        if (derived[k] !== v) fail('p18-runtime-failures', `${f.caseId}: ${k} derived ${derived[k]} != expected ${v}`);
      }
    } else {
      const perInstanceCap = doc.limits.intentsPerInstanceStep;
      const total = f.instances * f.intentsPerInstance;
      // Phase 21.2: the per-step cap scales with the instances.
      const stepCap = Math.max(doc.limits.intentsPerStep, perInstanceCap * f.instances);
      const accepted = Math.min(f.instances * Math.min(f.intentsPerInstance, perInstanceCap), stepCap);
      const reason = f.intentsPerInstance > perInstanceCap ? 'behavior_intent_limit' : total > stepCap ? 'behavior_intent_limit' : null;
      const detail = f.intentsPerInstance > perInstanceCap ? 'per_instance' : total > stepCap ? 'per_step' : null;
      if (accepted !== f.expect.accepted) fail('p18-runtime-failures', `${f.caseId}: accepted ${accepted} != ${f.expect.accepted}`);
      if (reason !== f.expect.reason) fail('p18-runtime-failures', `${f.caseId}: reason ${reason} != ${f.expect.reason}`);
      if ((detail ?? null) !== (f.expect.detail ?? null)) fail('p18-runtime-failures', `${f.caseId}: detail ${detail} != ${f.expect.detail}`);
    }
  }
  pass('p18-runtime-failures', `${doc.cases.length} runtime failure case(s) and ${doc.floods.length} flood case(s) re-derived`);
}

function p18ShallowMatch(check, where, expect, derived) {
  for (const [k, v] of Object.entries(expect)) {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      for (const [k2, v2] of Object.entries(v)) {
        const got = derived[k] ? derived[k][k2] : undefined;
        if (canon(got) !== canon(v2)) fail(check, `${where}: ${k}.${k2} derived ${canon(got)} != expected ${canon(v2)}`);
      }
    } else if (canon(derived[k]) !== canon(v)) {
      fail(check, `${where}: ${k} derived ${canon(derived[k])} != expected ${canon(v)}`);
    }
  }
}

function p18Publication() {
  const doc = readJson('behaviors/publication-cases.json');
  if (!doc) return;
  const both = [doc.digests.published, doc.digests.other];
  let checked = 0;
  for (const c of doc.cases) {
    const b = c.before;
    const st = {
      revision: b.revision,
      sourceDigest: b.sourceDigest ?? null,
      artifactDigest: b.derivedArtifact ? b.sourceDigest : null,
      prepared: new Set(b.prepared ? [b.sourceDigest] : []),
      acknowledged: new Set(b.acknowledged ? both : []),
      preparer: b.preparer,
      running: b.runningPlay ? { ...b.runningPlay } : null,
      lastCode: null,
      lastReason: null,
      duplicated: false,
      recompiled: false,
      probes: {},
    };
    const refuse = (code, reason) => { st.lastCode = code; st.lastReason = reason ?? null; };
    for (const s of c.steps) {
      if (s.op === 'editStage') continue;
      if (s.op === 'prepare') {
        if (s.result === 'trust') { refuse(s.code, 'digest'); continue; }
        if (s.result === 'ok') { st.prepared.add(s.sourceDigest); st.lastCode = null; st.lastReason = null; continue; }
        refuse(s.code, null);
        continue;
      }
      if (s.op === 'reprepare') { st.prepared.add(s.sourceDigest); st.lastCode = null; st.lastReason = null; continue; }
      if (s.op === 'deleteDerivedCache') { st.artifactDigest = null; continue; }
      if (s.op === 'build') {
        if (s.result === 'ok') { st.artifactDigest = st.sourceDigest; st.lastCode = null; st.lastReason = null; }
        else refuse(s.code ?? 'behavior_build_failed', s.reason ?? 'link');
        continue;
      }
      if (s.op === 'retry') { st.duplicated = true; st.recompiled = false; continue; }
      if (s.op === 'play') {
        if (st.sourceDigest === null) st.probes[s.probe] = { ok: true, artifactDigest: null };
        else if (st.artifactDigest !== st.sourceDigest) st.probes[s.probe] = { code: 'behavior_publication_unavailable', reason: 'preparation_missing' };
        else st.probes[s.probe] = { ok: true, artifactDigest: st.artifactDigest };
        continue;
      }
      if (s.op === 'publishDeclaration') {
        if (s.identical) { refuse('no_change', null); continue; }
        if (s.incompatible) { refuse(s.code, null); continue; }
        st.revision += 1;
        continue;
      }
      if (s.op === 'publishSource') {
        if (!st.preparer) { refuse('behavior_publication_unavailable', 'preparer_unavailable'); continue; }
        if (!st.acknowledged.has(s.sourceDigest)) { refuse('behavior_trust_unacknowledged', 'digest'); continue; }
        if (!st.prepared.has(s.sourceDigest)) { refuse('behavior_publication_unavailable', 'preparation_missing'); continue; }
        if (s.expectedRevision !== st.revision) { refuse('revision_conflict', null); continue; }
        if (st.sourceDigest === s.sourceDigest) { refuse('no_change', null); continue; }
        st.revision += 1;
        st.sourceDigest = s.sourceDigest;
        st.lastCode = null;
        st.lastReason = null;
        continue;
      }
      fail('p18-publication', `${c.caseId}: unknown op ${s.op}`);
    }
    const derived = {
      revision: st.revision,
      sourceDigest: st.sourceDigest,
      artifactDigest: st.artifactDigest,
      code: st.lastCode,
      reason: st.lastReason,
      duplicated: st.duplicated,
      recompiled: st.recompiled,
      runningPlay: st.running,
      sourceNull: st.sourceDigest === null,
      ...st.probes,
    };
    p18ShallowMatch('p18-publication', c.caseId, c.expect, derived);
    checked++;
  }
  pass('p18-publication', `${checked} publication case(s) replayed through the prepare/publish/build state machine`);
}

function p18Example() {
  const doc = readJson('behaviors/compiled-example.json');
  if (!doc) return;
  const containerBytes = readFileSync(join(ROOT, doc.source.container));
  const src = doc.source;
  if (sha256(containerBytes) !== src.sourceDigest) fail('p18-example', `sourceDigest ${sha256(containerBytes)} != ${src.sourceDigest}`);
  if (containerBytes.length !== src.sourceByteLength) fail('p18-example', `sourceByteLength ${containerBytes.length} != ${src.sourceByteLength}`);
  const container = readJson(doc.source.container);
  if (container) {
    if (container.entryPath !== doc.manifest.entryPath) fail('p18-example', 'entryPath mismatch');
    if (container.files.length !== src.fileCount) fail('p18-example', `fileCount ${container.files.length} != ${src.fileCount}`);
    if (canon(container.requiredModules) !== canon(doc.manifest.requiredModules)) fail('p18-example', 'requiredModules mismatch');
    if (canon(container.ownedTransforms) !== canon(doc.manifest.ownedTransforms)) fail('p18-example', 'ownedTransforms mismatch');
    const files = container.files.map((f) => ({ path: f.path, digest: sha256(Buffer.from(f.text, 'utf8')), byteLength: Buffer.byteLength(f.text, 'utf8') }));
    if (canon(files) !== canon(doc.manifest.files)) fail('p18-example', 'manifest.files do not match the container files');
    for (const mod of doc.manifest.requiredModules) if (!doc.enginePins.some((p) => p.id === mod)) fail('p18-example', `requiredModules ${mod} is not in enginePins`);
  }
  const manifestBytes = Buffer.from(JSON.stringify(doc.manifest, null, 2) + '\n', 'utf8');
  const manifestDigest = sha256(manifestBytes);
  if (manifestDigest !== src.manifestDigest) fail('p18-example', `manifestDigest ${manifestDigest} != ${src.manifestDigest}`);
  if (manifestBytes.length !== doc.manifestBytes.byteLength) fail('p18-example', 'manifestBytes.byteLength mismatch');
  if (doc.manifest.sourceDigest !== src.sourceDigest) fail('p18-example', 'manifest.sourceDigest mismatch');
  if (canon(doc.manifest.declaration) !== canon(doc.declaration)) fail('p18-example', 'manifest.declaration != fixture declaration');
  if (canon(doc.manifest.enginePins) !== canon(doc.enginePins)) fail('p18-example', 'manifest.enginePins != fixture enginePins');
  if (doc.manifest.outputDigest !== src.outputDigest || doc.manifest.outputByteLength !== src.outputByteLength) fail('p18-example', 'manifest output fields != source record');
  const outBytes = readFileSync(join(ROOT, doc.outputArtifact.path));
  if (sha256(outBytes) !== doc.outputArtifact.digest) fail('p18-example', 'output artifact digest mismatch');
  if (outBytes.length !== doc.outputArtifact.byteLength) fail('p18-example', 'output artifact byteLength mismatch');
  if (doc.outputArtifact.digest !== src.outputDigest) fail('p18-example', 'output artifact digest != source.outputDigest');
  // record canonical order
  if (canon(Object.keys(doc.record)) !== canon(['behaviorId', 'displayName', 'declaration', 'source', 'publishedRevision'])) fail('p18-example', 'record key order is not packet 16 + packet 18');
  if (canon(Object.keys(doc.record.source)) !== canon(['sourceDigest', 'sourceByteLength', 'entryPath', 'fileCount', 'manifestDigest', 'outputDigest', 'outputByteLength', 'requiredModules', 'publishedRevision'])) fail('p18-example', 'source record key order is not the proposed order');
  if (doc.record.publishedRevision !== doc.record.source.publishedRevision) fail('p18-example', 'record.publishedRevision != source.publishedRevision');
  if (doc.trust.sourceDigest !== src.sourceDigest) fail('p18-example', 'trust.sourceDigest mismatch');
  if (doc.trust.acknowledgedRevision > src.publishedRevision) fail('p18-example', 'the acknowledgment must not postdate the publication');
  // declared numeric property + replayed intent trace
  const numeric = doc.declaration.properties.filter((p) => p.type === 'number');
  if (numeric.length === 0) fail('p18-example', 'the example declares no numeric property');
  for (const row of doc.intentTrace.rows) {
    const expected = p18QuantizeMove(Math.max(-1, Math.min(1, row.speed / 10)));
    if (canon(expected) !== canon(row.expectedMove)) fail('p18-example', `intent row speed ${row.speed}: ${expected} != ${row.expectedMove}`);
  }
  for (const m of doc.intentTrace.sequence.expectedMoves) {
    const expected = p18QuantizeMove(Math.max(-1, Math.min(1, doc.intentTrace.sequence.usedValues.speed / 10)));
    if (canon(expected) !== canon(m)) fail('p18-example', `sequence move ${m} != ${expected}`);
  }
  const ef = doc.effectiveFrame;
  if (canon(p18Effective(ef.emptyIdentity.action, { move: null, jump: null })) !== canon(ef.emptyIdentity.expected)) fail('p18-example', 'emptyIntentSet identity failed');
  if (canon(p18Effective(ef.withIntent.action, ef.withIntent.intents)) !== canon(ef.withIntent.expected)) fail('p18-example', 'intent override failed');
  pass('p18-example', 'the example manifest is digest-bound, links one pinned module, declares a numeric property and replays its intent trace');
}

// ---------------------------------------------------------------------------
// self-test (negative controls: proves the checks are not vacuous)
// ---------------------------------------------------------------------------

function selfTest() {
  const bad = [
    ['duplicate key', '{"a":1,"a":2}'],
    ['duplicate key (escaped)', '{"\\u0061":1,"a":2}'],
    ['duplicate key (nested)', '{"o":{"k":1,"k":2}}'],
    ['trailing garbage', '{"a":1} x'],
    ['leading zero', '{"a":01}'],
    ['raw control character', '{"a":"\u0001"}'],
    ['unterminated string', '{"a":"x}'],
    ['missing colon', '{"a" 1}'],
    ['trailing comma', '{"a":1,}'],
  ];
  for (const [name, text] of bad) {
    let rejected = false;
    try {
      parseStrict(text);
    } catch {
      rejected = true;
    }
    if (!rejected) fail('self-test', `strict parser ACCEPTED a ${name}: ${text}`);
  }
  const good = [
    ['plain object', '{"a":1,"b":[true,null,"x"]}', { a: 1, b: [true, null, 'x'] }],
    ['escapes', '{"a":"\\u0041\\n"}', { a: 'A\n' }],
    ['exponents', '{"a":-1.5e2}', { a: -150 }],
  ];
  for (const [name, text, expectedValue] of good) {
    let parsed;
    try {
      parsed = parseStrict(text);
    } catch (err) {
      fail('self-test', `strict parser rejected a valid ${name}: ${err.message}`);
      continue;
    }
    if (canon(parsed) !== canon(expectedValue)) fail('self-test', `strict parser mis-parsed ${name}`);
  }
  // canonical JSON helper: key order must not matter, arrays must
  const a = canon({ b: 1, a: [1, 2] });
  const b = canon({ a: [1, 2], b: 1 });
  if (a !== b || a !== '{"a":[1,2],"b":1}') fail('self-test', `canon() is not order-insensitive: ${a}`);
  // duplicate-key detection must be fed by canonicalization, not JSON.parse
  const key = 'b';
  if (canon({ [key]: 1, a: 2 }) !== '{"a":2,"b":1}') fail('self-test', 'canon() key sorting broken');
  pass('self-test', `${bad.length} invalid + ${good.length} valid parser controls, canon() order-insensitivity`);
}

// ---------------------------------------------------------------------------

selfTest();
canonicalForm();
// ---------------------------------------------------------------------------
// 15. packet 19: delivery protocol surface, locator, uploads, scans, manifest, relay
// ---------------------------------------------------------------------------

const P19_STATUS = { validation: 400, conflict: 409, not_found: 404, unavailable: 503, internal: 500 };
const docDigest19 = (v) => sha256(Buffer.from(JSON.stringify(v, null, 2) + '\n', 'utf8'));
const p19Registry = (expected) => new Set([
  ...expected.registry.modelErrorCodes, ...expected.registry.workspaceErrorCodes,
  ...expected.registry.commandErrorCodes, ...(expected.registry.runtimeErrorCodes ?? []),
  ...(expected.registry.behaviorErrorCodes ?? []), ...(expected.registry.deliveryErrorCodes ?? []),
  ...(expected.registry.importDiagnosticCodes ?? []), ...(expected.registry.sessionErrorCodes ?? []),
  ...(expected.registry.exportErrorCodes ?? []),
]);
const P19_CLS = {
  unauthorized: 'validation', bad_origin: 'validation', field_value: 'validation', field_missing: 'validation',
  invalid_request: 'validation', path_rejected: 'validation', content_frame_invalid: 'validation',
  stage_limits_exceeded: 'validation', input_relay_limits_exceeded: 'validation', import_rejected: 'validation',
  export_manifest_invalid: 'validation', asset_uri_rejected: 'validation',
  asset_not_found: 'not_found', asset_version_not_found: 'not_found', project_not_found: 'not_found',
  stage_not_found: 'not_found', job_not_found: 'not_found', play_not_found: 'not_found', play_locator_invalid: 'not_found',
  stage_expired: 'unavailable', job_expired: 'unavailable', blob_missing: 'unavailable',
  session_unavailable: 'unavailable', play_locator_expired: 'unavailable', play_build_unavailable: 'unavailable',
  input_relay_timeout: 'unavailable', export_build_unavailable: 'unavailable',
  play_content_not_ready: 'conflict', input_relay_conflict: 'conflict',
  blob_corrupt: 'internal', scan_forbidden_content: 'internal', export_bundle_forbidden_content: 'internal',
  export_bundle_graph_forbidden: 'internal', export_scene_invalid: 'validation',
};

function p19Protocol(expected) {
  const doc = readJson('delivery/protocol-surface.json');
  if (!doc) return;
  const registry = p19Registry(expected);
  const statusMap = doc.statusMap;
  const ids = new Set();
  const seen = new Set();
  let errorRows = 0;
  for (const r of doc.routes) {
    if (ids.has(r.id)) fail('p19-protocol', `duplicate route id ${r.id}`);
    ids.add(r.id);
    const key = r.method + ' ' + r.path;
    if (seen.has(key)) fail('p19-protocol', `duplicate route ${key}`);
    seen.add(key);
    const segs = r.path.split('/');
    if (segs[0] !== '') fail('p19-protocol', `${r.id}: path must be absolute`);
    if (r.path.includes('://') || r.path.includes('..') || r.path.includes('//')) fail('p19-protocol', `${r.id}: forbidden path content`);
    const params = [];
    for (const s of segs.slice(1)) {
      if (s === '') { fail('p19-protocol', `${r.id}: empty path segment`); continue; }
      const m = /^:([a-z][A-Za-z]*)(\.[A-Za-z0-9]+)?$/.exec(s);
      if (m) params.push(m[1]);
      else if (s.startsWith(':')) fail('p19-protocol', `${r.id}: malformed param ${s}`);
    }
    if (!deepEqual(params, r.identifierParams)) fail('p19-protocol', `${r.id}: identifierParams ${JSON.stringify(r.identifierParams)} != path params ${JSON.stringify(params)}`);
    if (r.surface === 'authoring' || r.surface === 'authoring-or-admin') {
      if (r.auth !== 'project-token' || r.origin !== 'authoring-allowlist') fail('p19-protocol', `${r.id}: authoring route must require a project token + origin allowlist`);
    } else if (r.surface === 'preview-capability') {
      if (r.auth !== 'locator-capability' || r.origin !== 'none') fail('p19-protocol', `${r.id}: locator route must be capability-gated with no token/origin requirement`);
      if (/\/api\/v1\//.test(r.path)) fail('p19-protocol', `${r.id}: locator route must not be an /api/v1 surface`);
    } else {
      fail('p19-protocol', `${r.id}: unknown surface ${r.surface}`);
    }
    if (!(r.responseCap > 0)) fail('p19-protocol', `${r.id}: responseCap must be positive`);
    for (const c of Object.keys(doc.constants)) {
      if (r.responseCap === doc.constants[c] && !/Bytes$/.test(c)) fail('p19-protocol', `${r.id}: responseCap matches a non-byte constant ${c}`);
    }
    if (r.responseKind === 'binary' && r.responseCap > doc.constants.assetReadBytes && r.id !== 'play-content-manifest') {
      fail('p19-protocol', `${r.id}: binary responseCap ${r.responseCap} exceeds the asset-read cap`);
    }
    if (r.requestMaxBytes !== undefined && r.requestMaxBytes > doc.constants.uploadFrameBytes) fail('p19-protocol', `${r.id}: requestMaxBytes exceeds the upload frame cap`);
    for (const e of r.errors) {
      errorRows++;
      if (!registry.has(e.code)) fail('p19-protocol', `${r.id}: error code ${e.code} not in expected.json registry`);
      if (statusMap[e.cls] !== e.status && !(e.code === 'unauthorized' && e.status === 401) && !(e.code === 'bad_origin' && e.status === 403)) fail('p19-protocol', `${r.id}: ${e.code} status ${e.status} != statusMap[${e.cls}]=${statusMap[e.cls]}`);
      if (P19_CLS[e.code] && P19_CLS[e.code] !== e.cls) fail('p19-protocol', `${r.id}: ${e.code} cls ${e.cls} != ${P19_CLS[e.code]}`);
    }
  }
  for (const m of doc.bridgeMessages) {
    if (!m.name.startsWith('tl.')) fail('p19-protocol', `bridge message ${m.name} must start with tl.`);
    if (m.version !== 2) fail('p19-protocol', `${m.name}: bridge version must be 2`);
    if (m.carriesBinary !== false) fail('p19-protocol', `${m.name}: no binary content in bridge messages`);
    if (m.maxBytes > doc.constants.bridgeMessageBytes && m.name !== 'tl.snapshot') fail('p19-protocol', `${m.name}: maxBytes ${m.maxBytes} exceeds the bridge cap`);
    if (m.name === 'tl.snapshot' && m.maxBytes !== doc.constants.wsStateFrameBytes) fail('p19-protocol', `${m.name}: snapshot bound must equal the state-frame bound`);
    if (!['editor->preview', 'preview->editor'].includes(m.direction)) fail('p19-protocol', `${m.name}: bad direction`);
  }
  if (!doc.forbiddenBinaryCarriers.includes('tl.snapshot')) fail('p19-protocol', 'tl.snapshot must be a forbidden binary carrier');
  if (doc.wsStatePayloadRule.binaryAllowed !== false) fail('p19-protocol', 'WS state frames must forbid binary content');
  if (doc.wsStatePayloadRule.maxBytes !== doc.constants.wsStateFrameBytes) fail('p19-protocol', 'WS state bound mismatch');
  pass('p19-protocol', `${doc.routes.length} route(s) and ${doc.bridgeMessages.length} bridge message(s) re-derived; ${errorRows} error mapping(s) checked`);
}

function p19Locator(expected) {
  const doc = readJson('delivery/locator-cases.json');
  if (!doc) return;
  const l = doc.locator;
  const expectedLen = Math.ceil((l.idBytes * 8) / 6);
  if (l.idPattern !== `^[A-Za-z0-9_-]{${expectedLen}}$`) fail('p19-locator', `idPattern does not match idBytes ${l.idBytes} (expected length ${expectedLen})`);
  const re = new RegExp(l.idPattern);
  const sample = 'A'.repeat(expectedLen);
  if (!re.test(sample)) fail('p19-locator', 'idPattern rejects a valid-length base64url sample');
  if (re.test('A'.repeat(expectedLen + 1)) || re.test('A'.repeat(expectedLen - 1))) fail('p19-locator', 'idPattern accepts a wrong-length id');
  if (!re.test('aZ0-_'.padEnd(expectedLen, 'x'))) fail('p19-locator', 'idPattern rejects base64url alphabet characters');
  const statusMap = P19_STATUS;
  let checked = 0;
  for (const c of doc.cases) {
    checked++;
    const expires = c.issuedAtSeconds + l.ttlSeconds;
    let derived;
    if (c.requestAtSeconds > expires) derived = { served: false, status: 503, code: 'play_locator_expired', cacheMaxAgeSeconds: 0 };
    else {
      const kind = c.pathKind;
      const byKind = {
        declared: null, listing: 'path_rejected', traversal: 'path_rejected', 'other-content-id': 'path_rejected',
        undeclared: 'path_rejected', 'build-missing': 'play_build_unavailable', 'build-in-flight': 'play_content_not_ready',
        'malformed-id': 'play_locator_invalid', 'corrupt-blob': 'blob_corrupt',
      };
      if (!(kind in byKind)) { fail('p19-locator', `${c.caseId}: unknown pathKind ${kind}`); continue; }
      const kc = byKind[kind];
      if (kc) derived = { served: false, status: statusMap[P19_CLS[kc]], code: kc, cacheMaxAgeSeconds: 0 };
      else if (c.terminalAtSeconds !== null && c.requestAtSeconds > c.terminalAtSeconds + l.graceSeconds) derived = { served: false, status: 404, code: 'play_locator_invalid', cacheMaxAgeSeconds: 0 };
      else derived = { served: true, status: 200, code: null, cacheMaxAgeSeconds: expires - c.requestAtSeconds };
    }
    for (const k of ['served', 'status', 'code', 'cacheMaxAgeSeconds']) {
      if (derived[k] !== c.expect[k]) fail('p19-locator', `${c.caseId}: ${k} ${JSON.stringify(c.expect[k])} != derived ${JSON.stringify(derived[k])}`);
    }
    if (derived.cacheMaxAgeSeconds > l.ttlSeconds) fail('p19-locator', `${c.caseId}: cache lifetime exceeds the locator TTL`);
  }
  if (l.referrerPolicy !== 'no-referrer') fail('p19-locator', 'locator responses must be no-referrer');
  if (l.excludedFromExport !== true) fail('p19-locator', 'locator values must be excluded from exports');
  if (!l.redaction) fail('p19-locator', 'locator redaction token missing');
  pass('p19-locator', `${checked} locator case(s) re-derived (TTL, grace, traversal/listing, build states, redaction)`);
}

function p19Upload() {
  const doc = readJson('delivery/upload-bounds.json');
  if (!doc) return;
  const b = doc.bounds;
  if (!(b.frameBytes < b.stageBytes && b.stageBytes < b.stagedBytesPerProject)) fail('p19-upload', 'bounds must be strictly increasing frame < stage < project');
  if (!(b.stageTtlSeconds > 0 && b.abandonedStageRetentionSeconds > b.stageTtlSeconds)) fail('p19-upload', 'stage TTL/retention ordering violated');
  for (const c of doc.cases) {
    let derived = { accepted: true, code: null, limit: null };
    if (c.frameBytes > b.frameBytes) derived = { accepted: false, code: 'stage_limits_exceeded', limit: 'frame_bytes' };
    else if (c.offset !== c.expectedOffset) derived = { accepted: false, code: 'content_frame_invalid', limit: null };
    else if (c.declaredTotal > b.stageBytes) derived = { accepted: false, code: 'stage_limits_exceeded', limit: 'stage_bytes' };
    else if (c.openStages >= b.openStages) derived = { accepted: false, code: 'stage_limits_exceeded', limit: 'open_stages' };
    else if (c.stagedBytes + c.frameBytes > b.stagedBytesPerProject) derived = { accepted: false, code: 'stage_limits_exceeded', limit: 'staged_bytes_per_project' };
    for (const k of ['accepted', 'code', 'limit']) {
      if (derived[k] !== c.expect[k]) fail('p19-upload', `${c.caseId}: ${k} ${JSON.stringify(c.expect[k])} != derived ${JSON.stringify(derived[k])}`);
    }
  }
  pass('p19-upload', `${doc.cases.length} upload/stage bound case(s) re-derived (frame, offset, stage, open stages, project cap)`);
}

function p19Scans(expected) {
  const doc = readJson('delivery/scan-expectations.json');
  if (!doc) return;
  const byId = new Map(doc.validators.map((v) => [v.id, v]));
  if (!byId.has('text') || byId.get('text').binary !== false) fail('p19-scans', 'the text validator must be non-binary');
  if (byId.get('glb')?.binary !== true || byId.get('wasm')?.binary !== true) fail('p19-scans', 'GLB/WASM validators must be binary');
  const faultCode = {
    'text-absolute-locator': 'export_bundle_forbidden_content', 'text-credential': 'export_bundle_forbidden_content',
    'text-locator-value': 'export_bundle_forbidden_content',
    'glb-remote-uri': 'asset_uri_rejected', 'glb-external-buffer': 'asset_uri_rejected', 'glb-bad-magic': 'import_rejected',
    'wasm-digest-mismatch': 'scan_forbidden_content', 'wasm-host-import': 'scan_forbidden_content',
    'undeclared-fetch': 'export_bundle_graph_forbidden', 'duplicate-declared-fetch': 'export_bundle_graph_forbidden',
    'graph-forbidden-package': 'export_bundle_graph_forbidden',
    'closure-absolute-path': 'export_manifest_invalid', 'closure-missing-artifact': 'export_manifest_invalid',
  };
  const formatValidator = { js: 'text', html: 'text', json: 'text', glb: 'glb', wasm: 'wasm', tree: 'closure' };
  const statusMap = P19_STATUS;
  for (const c of doc.cases) {
    const derivedCode = faultCode[c.fault];
    if (!derivedCode) { fail('p19-scans', `${c.caseId}: unknown fault ${c.fault}`); continue; }
    if (!p19Registry(expected).has(derivedCode)) fail('p19-scans', `${c.caseId}: derived code ${derivedCode} not in registry`);
    if (derivedCode !== c.expect.code) fail('p19-scans', `${c.caseId}: code ${c.expect.code} != derived ${derivedCode}`);
    if (statusMap[P19_CLS[derivedCode]] !== c.expect.status) fail('p19-scans', `${c.caseId}: status ${c.expect.status} != mapping ${statusMap[P19_CLS[derivedCode]]}`);
    const validator = formatValidator[c.format];
    if (!validator || !byId.has(validator)) fail('p19-scans', `${c.caseId}: unknown format ${c.format}`);
    const textApplied = ['js', 'html', 'json'].includes(c.format);
    if (textApplied !== c.textScanApplied) fail('p19-scans', `${c.caseId}: textScanApplied ${c.textScanApplied} != derived ${textApplied}`);
    if (!textApplied && c.textScanApplied) fail('p19-scans', `${c.caseId}: a binary container must not be judged by the text scan`);
  }
  pass('p19-scans', `${doc.cases.length} format-aware scan case(s) re-derived (text vs GLB/WASM/closure, no text scan on binaries)`);
}

function p19Manifest() {
  const doc = readJson('delivery/manifest-example.json');
  if (!doc) return;
  const m = doc.manifest;
  const withoutBuildId = { ...m };
  delete withoutBuildId.buildId;
  const recomputed = docDigest19(withoutBuildId);
  if (recomputed !== m.buildId) fail('p19-manifest', `buildId ${m.buildId} != recomputed ${recomputed}`);
  const optionsDigest = docDigest19(doc.buildOptions);
  if (optionsDigest !== doc.buildOptionsDigest) fail('p19-manifest', `buildOptionsDigest ${doc.buildOptionsDigest} != ${optionsDigest}`);
  if (m.toolchain.optionsDigest !== optionsDigest) fail('p19-manifest', 'manifest.toolchain.optionsDigest != the option-set digest');
  if (doc.buildOptions.bundle !== true || doc.buildOptions.format !== 'iife' || doc.buildOptions.treeShaking !== false) fail('p19-manifest', 'the option record must carry the pinned export.md §5.3 flags');
  if (m.projectId !== doc.capturedFrom.projectId || m.revision !== doc.capturedFrom.revision) fail('p19-manifest', 'manifest identity != capturedFrom identity');
  if (m.snapshotId !== `${m.projectId}@r${m.revision}`) fail('p19-manifest', 'snapshotId does not equal projectId@r<revision>');
  const env = readJson('envelope/valid/demo-0002-rev7-v2.json');
  const sceneDigest = docDigest19(env.scene);
  if (sceneDigest !== doc.capturedFrom.sceneDigest || sceneDigest !== m.sceneDigest) fail('p19-manifest', 'sceneDigest is not the recomputed canonical scene digest');
  const view = readJson('catalog/captured-content-view.json');
  if (view.contentDigest !== m.contentDigest || view.contentDigest !== doc.capturedFrom.contentDigest) fail('p19-manifest', 'contentDigest != the captured content view digest');
  const sortedAsc = (xs, key) => deepEqual(xs, [...xs].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0)));
  if (!sortedAsc(m.assets, (a) => `${a.assetId}#${String(a.version).padStart(6, '0')}`)) fail('p19-manifest', 'assets are not ascending by assetId/version');
  if (!sortedAsc(m.behaviors, (b) => b.behaviorId)) fail('p19-manifest', 'behaviors are not ascending by behaviorId');
  if (!sortedAsc(m.modules, (x) => x.id) || !sortedAsc(m.enginePins, (x) => x.id)) fail('p19-manifest', 'modules/enginePins are not ascending by id');
  const relOk = (p) => typeof p === 'string' && !p.startsWith('/') && !p.includes('://') && !p.split('/').includes('..') && !p.includes('\\');
  for (const a of m.assets) {
    if (a.path !== `content/sha256/${a.sourceDigest}`) fail('p19-manifest', `${a.assetId}: path != content/sha256/<sourceDigest>`);
    if (!relOk(a.path)) fail('p19-manifest', `${a.assetId}: non-relative artifact path`);
  }
  for (const b of m.behaviors) {
    if (b.path !== `behaviors/${b.outputDigest}.js`) fail('p19-manifest', `${b.behaviorId}: path != behaviors/<outputDigest>.js`);
    if (!relOk(b.path)) fail('p19-manifest', `${b.behaviorId}: non-relative artifact path`);
  }
  // every declared asset digest/length is a real committed preimage
  const pre = readJson('source-preimages/preimages.json');
  const byDigest = new Map(pre.preimages.map((p) => {
    const buf = readFileSync(join(ROOT, 'source-preimages', p.file));
    return [sha256(buf), buf.length];
  }));
  const containers = readJson('behaviors/source-preimages/containers.json');
  for (const c of containers.containers) {
    const buf = readFileSync(join(ROOT, 'behaviors', 'source-preimages', c.file));
    byDigest.set(sha256(buf), buf.length);
  }
  for (const a of m.assets) {
    if (byDigest.get(a.sourceDigest) !== a.sourceByteLength) fail('p19-manifest', `${a.assetId}: sourceDigest/length does not match a committed preimage`);
  }
  for (const b of m.behaviors) {
    if (byDigest.get(b.sourceDigest) !== b.sourceByteLength) fail('p19-manifest', `${b.behaviorId}: sourceDigest/length does not match a committed container`);
  }
  const fetched = [...m.assets.map((a) => a.path), ...m.behaviors.map((b) => b.path)];
  if (!deepEqual(doc.closure.fetchedArtifacts, fetched)) fail('p19-manifest', 'closure.fetchedArtifacts != the manifest asset/behavior paths');
  if (doc.closure.expectedFetchCount !== 1 + fetched.length) fail('p19-manifest', 'expectedFetchCount != 1 manifest read + one read per declared artifact');
  if (doc.closure.allPathsRelative !== true || doc.closure.absoluteLocatorsAllowed !== false) fail('p19-manifest', 'closure must be relative-only');
  if (doc.identityRule.snapshotIdIsBinaryHash !== false || doc.identityRule.buildIdIsEngineIndependentHash !== false) fail('p19-manifest', 'identity rule must not equate snapshot/build with a binary hash');
  if (doc.identityRule.buildFailurePreservesPreviousOutput !== true) fail('p19-manifest', 'build failure must preserve the previous output');
  if (!Array.isArray(doc.licenses) || doc.licenses.length === 0) fail('p19-manifest', 'licenses must be recorded');
  for (const lic of doc.licenses) for (const k of ['id', 'version', 'license', 'source']) if (!lic[k]) fail('p19-manifest', `license entry missing ${k}`);
  pass('p19-manifest', `manifest identity, ${m.assets.length} asset(s), ${m.behaviors.length} behavior(s), closure fetch count ${doc.closure.expectedFetchCount} and licenses re-derived`);
}

function p19Relay() {
  const doc = readJson('delivery/input-relay.json');
  if (!doc) return;
  const k = doc.constants;
  if (k.mode !== 'exclusive-test') fail('p19-relay', 'the only relay mode is exclusive-test');
  const statusMap = P19_STATUS;
  for (const c of doc.cases) {
    let derived;
    const failWith = (code) => ({ applied: false, appliedFromStep: null, appliedToStep: null, code, mode: null, clearedOnCompletion: false });
    if (c.mode !== k.mode) derived = failWith('field_value');
    else if (c.playExists === false) derived = failWith('play_not_found');
    else if (c.browserPresent === false) derived = failWith('session_unavailable');
    else if (c.physicalEngaged === true) derived = failWith('input_relay_conflict');
    else if (c.frameCount > k.maxFrames || c.bodyBytes > k.maxBodyBytes) derived = failWith('input_relay_limits_exceeded');
    else if (c.ascending === false) derived = failWith('field_value');
    else if (c.ackWithinMs !== undefined && c.ackWithinMs > k.ackTimeoutMs) derived = failWith('input_relay_timeout');
    else derived = {
      applied: true, appliedFromStep: c.baseStepIndex, appliedToStep: c.baseStepIndex + c.frameCount - 1,
      code: null, mode: 'test', clearedOnCompletion: true,
    };
    for (const key of ['applied', 'appliedFromStep', 'appliedToStep', 'code', 'mode', 'clearedOnCompletion']) {
      if (derived[key] !== c.expect[key]) fail('p19-relay', `${c.caseId}: ${key} ${JSON.stringify(c.expect[key])} != derived ${JSON.stringify(derived[key])}`);
    }
    if (derived.code) {
      const cls = P19_CLS[derived.code];
      if (!cls || statusMap[cls] === undefined) fail('p19-relay', `${c.caseId}: code ${derived.code} has no status mapping`);
    }
    if (derived.applied && derived.appliedToStep - derived.appliedFromStep + 1 !== c.frameCount) fail('p19-relay', `${c.caseId}: applied range length != frame count`);
  }
  pass('p19-relay', `${doc.cases.length} relay case(s) re-derived (step range, exclusive mode, limits, no-browser unavailable)`);
}

function p27Authoring() {
  const doc = readJson('commands/model-authoring.messages.json');
  if (!doc) return;
  const before = readJson('commands/prefab-scenario.before.json');
  if (doc.kind !== 'command-scenario-m2' || doc.projectId !== before.projectId) {
    fail('p27-authoring', 'scenario kind/projectId mismatch');
    return;
  }
  if (typeof doc.base?.state !== 'string' || !doc.base.state.endsWith('commands/prefab-scenario.before.json') || doc.base?.revision !== before.scene.revision) {
    fail('p27-authoring', 'scenario base must be the committed before envelope at its revision');
  }
  const assets = new Set(before.content.assets.map((a) => a.assetId));
  let entities = cloned(before.scene.entities);
  let revision = before.scene.revision;
  let entries = [];
  let cursor = 0;
  const usedIds = () => new Set(entities.map((e) => e.id));
  const byId = (id) => entities.find((e) => e.id === id);
  const canonicalBox = (s) => ({ type: 'box', hx: s.hx, hy: s.hy });
  const canonicalPoly = (s) => ({ type: 'polygon', vertices: s.vertices.map((v) => [v[0], v[1]]) });
  const canonicalShape = (s) => (s.type === 'box' ? canonicalBox(s) : canonicalPoly(s));

  if (doc.steps.length !== 12) fail('p27-authoring', `expected 12 steps, found ${doc.steps.length}`);
  for (const step of doc.steps) {
    const where = `${doc.id}/${step.stepId}`;
    const req = step.in;
    const res = step.out;
    if (req.expectedRevision !== revision) fail('p27-authoring', `${where}: expectedRevision ${req.expectedRevision} != ${revision}`);
    let derived = null;
    let failure = null;
    if (req.op === 'createEntity') {
      const assetId = req.args?.model?.asset?.assetId;
      if (!assets.has(assetId)) failure = 'asset_reference_missing';
      else {
        let id = null;
        for (let i = 1; i <= 9999; i++) {
          const cand = `model-${String(i).padStart(4, '0')}`;
          if (!usedIds().has(cand)) { id = cand; break; }
        }
        const entity = {
          id,
          ...(req.args.name ? { name: req.args.name } : {}),
          components: {
            transform: {
              position: [...(req.args.transform?.position ?? [0, 0, 0])],
              rotation: [...(req.args.transform?.rotation ?? [0, 0, 0, 1])],
              scale: [...(req.args.transform?.scale ?? [1, 1, 1])],
            },
            model: { asset: { assetId } },
          },
        };
        derived = { type: 'createEntity', id, entity };
        entities = [...entities, cloned(entity)];
      }
    } else if (req.op === 'undo' || req.op === 'redo') {
      if (req.op === 'undo') {
        if (cursor === 0) failure = 'history_empty';
        else {
          cursor -= 1;
          const inv = entries[cursor].inverse;
          if (inv.kind === 'delete') {
            entities = entities.filter((e) => e.id !== inv.rootId);
            derived = { type: 'deleteEntity', rootId: inv.rootId, deletedIds: [inv.rootId] };
          } else failure = 'history_invalid';
        }
      } else {
        if (cursor >= entries.length) failure = 'history_empty';
        else {
          const ch = entries[cursor].change;
          entities = [...entities, cloned(ch.entity)];
          derived = cloned(ch);
          cursor += 1;
        }
      }
    } else if (req.op === 'setComponent') {
      const entity = byId(req.args.entityId);
      if (!entity) failure = 'entity_not_found';
      else {
        const comp = req.args.component;
        const current = entity.components[comp];
        const removable = comp === 'collider' || comp === 'controller';
        if (current === undefined && !removable) failure = 'component_missing';
        else if (req.args.value === null) {
          if (!removable) failure = 'field_value';
          else {
            const next = cloned(entity);
            delete next.components[comp];
            entities = entities.map((e) => (e.id === entity.id ? next : e));
            derived = { type: 'setComponent', id: entity.id, component: comp, previous: cloned(current), next: null, changedFields: comp === 'collider' ? ['shape'] : [] };
          }
        } else {
          const fields = comp === 'collider' ? ['shape'] : comp === 'controller' ? [] : null;
          if (fields === null) failure = 'unsupported_component';
          else {
            const next = cloned(entity);
            const value = {};
            if (comp === 'collider') value.shape = canonicalShape(req.args.value.shape);
            if (comp === 'controller' && entity.components.controller !== undefined) failure = 'controller_count_invalid';
            if (comp === 'collider' && entity.components.controller !== undefined) failure = 'component_conflict';
            if (failure === null) {
              next.components[comp] = value;
              entities = entities.map((e) => (e.id === entity.id ? next : e));
              derived = {
                type: 'setComponent',
                id: entity.id,
                component: comp,
                previous: current === undefined ? null : cloned(current),
                next: cloned(value),
                changedFields: fields,
              };
            }
          }
        }
      }
    } else {
      fail('p27-authoring', `${where}: unsupported op ${req.op}`);
      continue;
    }

    if (failure !== null) {
      if (res.ok !== false) fail('p27-authoring', `${where}: expected a failure, found success`);
      else if (res.error?.code !== failure) fail('p27-authoring', `${where}: derived ${failure} != fixture ${res.error?.code}`);
      if (res.revision !== undefined || res.duplicated !== undefined) fail('p27-authoring', `${where}: failure must not carry revision/duplicated`);
      continue;
    }
    if (res.ok !== true) { fail('p27-authoring', `${where}: expected success, found ${JSON.stringify(res.error)}`); continue; }
    revision += 1;
    if (res.revision !== revision) fail('p27-authoring', `${where}: revision ${res.revision} != ${revision}`);
    if (!deepEqual(res.change, derived)) fail('p27-authoring', `${where}: change ${JSON.stringify(res.change)} != derived ${JSON.stringify(derived)}`);
    if (req.op === 'undo' || req.op === 'redo') {
      // History entries are untouched by undo/redo; only the cursor moves.
    } else {
      entries = entries.slice(0, cursor);
      const inverse = derived.type === 'createEntity'
        ? { kind: 'delete', rootId: derived.id }
        : { kind: 'setComponent', id: derived.id, component: derived.component, restore: derived.previous };
      entries.push({ requestId: req.requestId, change: cloned(derived), inverse });
      cursor += 1;
    }
    const undoDepth = cursor;
    const redoDepth = entries.length - cursor;
    if (res.history?.undoDepth !== undoDepth || res.history?.redoDepth !== redoDepth) {
      fail('p27-authoring', `${where}: history ${JSON.stringify(res.history)} != ${JSON.stringify({ undoDepth, redoDepth })}`);
    }
    if (req.op === 'createEntity' && res.createdId !== derived.id) fail('p27-authoring', `${where}: createdId != derived id`);
  }
  if (revision !== 12) fail('p27-authoring', `final revision ${revision} != 12`);
  if (entities.length !== before.scene.entities.length + 2) fail('p27-authoring', 'final entity count != base + two placements');
  pass('p27-authoring', `${doc.steps.length} placement/component steps re-derived (model ID allocation, undo/redo, asset_reference_missing, collider add/edit/remove, controller add/remove, component_conflict)`);
}

const expected = readJson('expected.json');
if (expected) {
  indexCompleteness(expected);
  codesAndPins(expected);
  crossReferences(expected);
  packet16Commands();
  p27Authoring();
  packet17Numerics();
  packet17Traces();
  packet17Input();
  packet17Catchup();
  packet17Failures();
  p18SourceGraphs();
  p18Intents();
  p18RuntimeFailures();
  p18Publication();
  p18Example();
  p19Protocol(expected);
  p19Locator(expected);
  p19Upload();
  p19Scans(expected);
  p19Manifest();
  p19Relay();
}
preimages(expected ?? { sourceHashes: [] });
contentView();

const report = {
  tool: 'fixtures/m2/contracts/tools/check-fixtures.mjs',
  mode: WRITE ? 'write' : 'check',  fixturesRoot: 'fixtures/m2/contracts',
  filesOnDisk: files.length,
  checks: passes,
  failures,
  ok: failures.length === 0,
};
if (REPORT) writeFileSync(resolve(REPORT), JSON.stringify(report, null, 2) + '\n');
for (const p of passes) console.log(`ok   ${p.check}${p.detail ? ': ' + p.detail : ''}`);
for (const f of failures) console.log(`FAIL ${f.check}: ${f.detail}`);
console.log(
  `${failures.length === 0 ? 'check OK' : 'check FAILED'}: ${passes.length} check group(s) passed, ${failures.length} problem(s)`,
);
process.exit(failures.length === 0 ? 0 : 1);

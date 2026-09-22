#!/usr/bin/env node
/**
 * Packet-33 behavior-build fixture checker — plain Node, independent of the
 * TypeScript compiler implementation.
 *
 * It re-derives, from the committed fixture bytes alone:
 *   1. every container's SHA-256 and byte length (against `expected.json`);
 *   2. the canonical form of each parseable container (2-space JSON, §22.1
 *      field order, trailing newline) and the first failure of the §22.3.3
 *      step order with its own small classifier;
 *   3. the valid sample's manifest bytes/digest, per-file digests, recipe
 *      digest and committed output artifact digest/length;
 *   4. the declaration and injected-case expectations as bound checks.
 *
 * Digest fields of the two valid cases are compile products and are checked
 * for shape here (their real values are re-derived from the committed manifest
 * and output artifact in step 3).
 *
 * Exit 0 = every row matched; exit 1 = mismatch (with reasons on stdout).
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const index = JSON.parse(readFileSync(join(ROOT, 'expected.json'), 'utf8'));

const sha256 = (b) => createHash('sha256').update(b).digest('hex');
const canon = (v) => `${JSON.stringify(v, null, 2)}\n`;
const codePoints = (a, b) => {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const d = a.codePointAt(i) - b.codePointAt(i);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return a.length === b.length ? 0 : a.length < b.length ? -1 : 1;
};
const canonicalJsonText = (v) => {
  if (v === null) return 'null';
  if (typeof v === 'number') return JSON.stringify(v === 0 ? 0 : v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'string') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonicalJsonText).join(',')}]`;
  const keys = Object.keys(v).sort(codePoints);
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJsonText(v[k])}`).join(',')}}`;
};

let failures = 0;
const fail = (check, msg) => {
  failures += 1;
  console.log(`FAIL ${check}: ${msg}`);
};
const pass = (check, msg) => console.log(`ok   ${check}: ${msg}`);

const PATH_RE = /^[a-z0-9][a-z0-9._-]*(\/[a-z0-9][a-z0-9._-]*)*$/;
const NODE_BUILTINS = new Set([
  'assert', 'buffer', 'child_process', 'crypto', 'dns', 'events', 'fs', 'http', 'https', 'module',
  'net', 'os', 'path', 'process', 'stream', 'tls', 'url', 'util', 'vm', 'worker_threads', 'zlib',
]);
const pinnedIds = index.pinnedModules.map((p) => p.id);

function hasLoneSurrogate(s) {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const n = i + 1 < s.length ? s.charCodeAt(i + 1) : 0;
      if (!(n >= 0xdc00 && n <= 0xdfff)) return true;
      i++;
    } else if (c >= 0xdc00 && c <= 0xdfff) return true;
  }
  return false;
}

function classify(spec, typeOnly) {
  if (/^[a-z][a-z0-9+.-]*:/i.test(spec)) {
    return spec.startsWith('node:') ? { reason: 'node_builtin' } : { reason: 'network' };
  }
  if (spec.startsWith('/')) return { reason: 'absolute' };
  if (spec.startsWith('./') || spec.startsWith('../')) return { relative: true };
  if (spec.startsWith('#')) return { reason: 'absolute' };
  if (NODE_BUILTINS.has(spec.split('/')[0])) return { reason: 'node_builtin' };
  if (pinnedIds.includes(spec)) return typeOnly ? { typeOnlyEngine: true } : { reason: 'engine_value_import' };
  return { reason: 'bare' };
}

function scanText(text) {
  const hits = [];
  const dyn = [
    [/\bimport\s*\(/g, 'dynamic_import'],
    [/\beval\s*\(/g, 'eval'],
    [/\bnew\s+Function\s*\(/g, 'function_constructor'],
    [/\bFunction\s*\(/g, 'function_constructor'],
    [/\brequire\s*\(/g, 'require'],
  ];
  for (const [re, reason] of dyn) for (const m of text.matchAll(re)) hits.push({ i: m.index, kind: 'dyn', reason });
  for (const m of text.matchAll(/\b(?:import|export)\s+(type\s+)?([\s\S]*?)\s*from\s*['"]([^'"]+)['"]/g)) {
    hits.push({ i: m.index, kind: 'spec', typeOnly: Boolean(m[1]), spec: m[3] });
  }
  for (const m of text.matchAll(/\bimport\s*['"]([^'"]+)['"]/g)) hits.push({ i: m.index, kind: 'spec', typeOnly: false, spec: m[1] });
  return hits.sort((a, b) => a.i - b.i);
}

/**
 * Independent re-derivation of the §22.3.3 step order. `text` is the raw
 * decoded container; `value` its parsed form (null when unparseable).
 */
function analyze(text, value, limits) {
  if (text.charCodeAt(0) === 0xfeff) return { ok: false, code: 'behavior_source_invalid', reason: 'encoding' };
  if (value === null) return { ok: false, code: 'behavior_source_invalid', reason: 'container' };
  const bad = (code, extra = {}) => ({ ok: false, code, ...extra });
  if (typeof value !== 'object' || Array.isArray(value)) return bad('behavior_source_invalid', { reason: 'container' });
  const known = ['graphVersion', 'entryPath', 'requiredModules', 'ownedTransforms', 'files'];
  if (Object.keys(value).some((k) => !known.includes(k))) return bad('behavior_source_invalid', { reason: 'container' });
  if (!Array.isArray(value.files) || !Array.isArray(value.requiredModules) || !Array.isArray(value.ownedTransforms)) {
    return bad('behavior_source_invalid', { reason: 'container' });
  }
  if (value.files.some((f) => typeof f !== 'object' || f === null || Object.keys(f).some((k) => k !== 'path' && k !== 'text'))) {
    return bad('behavior_source_invalid', { reason: 'container' });
  }
  const strings = [value.entryPath, ...value.requiredModules, ...value.ownedTransforms];
  for (const f of value.files) strings.push(f.path, f.text);
  if (strings.some((s) => typeof s === 'string' && hasLoneSurrogate(s))) return bad('behavior_source_invalid', { reason: 'encoding' });
  if (canon(value) !== text) return bad('behavior_source_invalid', { reason: 'container' });
  if (value.graphVersion !== 1) return bad('behavior_source_invalid', { reason: 'graph_version' });
  const files = value.files;
  if (!files.some((f) => f.path === value.entryPath)) {
    return bad('behavior_source_invalid', { reason: 'entry_missing', detail: value.entryPath });
  }
  for (const f of files) {
    if (typeof f.path !== 'string' || f.path.length > 128 || !PATH_RE.test(f.path)) {
      return bad('behavior_source_invalid', { reason: 'path', detail: f.path });
    }
    if (!f.path.endsWith('.ts')) return bad('behavior_source_invalid', { reason: 'extension', detail: f.path });
  }
  for (let i = 1; i < files.length; i++) {
    if (codePoints(files[i - 1].path, files[i].path) > 0) return bad('behavior_source_invalid', { reason: 'file_order' });
  }
  for (const key of ['requiredModules', 'ownedTransforms']) {
    for (let i = 1; i < value[key].length; i++) {
      const c = codePoints(value[key][i - 1], value[key][i]);
      if (c > 0) return bad('behavior_source_invalid', { reason: 'file_order' });
      if (c === 0) return bad('behavior_source_invalid', { reason: 'duplicate' });
    }
  }
  for (const id of value.ownedTransforms) {
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(id)) return bad('behavior_source_invalid', { reason: 'container', detail: id });
  }
  for (let i = 1; i < files.length; i++) {
    if (files[i - 1].path === files[i].path) return bad('behavior_source_duplicate', { reason: 'duplicate', detail: files[i].path });
  }
  if (files.length > limits.files) {
    return bad('behavior_source_limits_exceeded', { reason: 'files', limit: 'files', current: files.length, max: limits.files });
  }
  if (value.ownedTransforms.length > limits.ownedTransforms) {
    return bad('behavior_source_limits_exceeded', {
      reason: 'owned_transforms', limit: 'owned_transforms', current: value.ownedTransforms.length, max: limits.ownedTransforms,
    });
  }
  for (const f of files) {
    const n = Buffer.byteLength(f.text, 'utf8');
    if (n > limits.fileBytes) {
      return bad('behavior_source_limits_exceeded', { reason: 'file_bytes', limit: 'file_bytes', current: n, max: limits.fileBytes });
    }
  }
  for (const m of value.requiredModules) {
    if (!pinnedIds.includes(m)) return bad('behavior_import_unpinned', { reason: m, detail: m });
  }
  const edges = [];
  let typeOnlyImports = 0;
  let acceptedImports = 0;
  for (const f of files) {
    const hits = scanText(f.text);
    const count = hits.filter((h) => h.kind === 'spec').length;
    if (count > limits.importsPerFile) {
      return bad('behavior_source_limits_exceeded', { reason: 'imports', limit: 'imports', current: count, max: limits.importsPerFile });
    }
    for (const h of hits) {
      if (h.kind === 'dyn') return bad('behavior_dynamic_code', { reason: h.reason, detail: h.reason });
      const c = classify(h.spec, h.typeOnly);
      if (c.typeOnlyEngine) {
        if (!value.requiredModules.includes(h.spec)) return bad('behavior_import_unpinned', { reason: h.spec, detail: h.spec });
        typeOnlyImports++;
        continue;
      }
      if (c.relative) {
        acceptedImports++;
        edges.push([f.path, h.spec]);
        continue;
      }
      return bad('behavior_import_forbidden', { reason: c.reason, detail: h.spec });
    }
  }
  const rel = [];
  for (const [from, spec] of edges) {
    const parts = from.split('/').slice(0, -1);
    let up = 0;
    for (const seg of spec.split('/')) {
      if (seg === '' || seg === '.') continue;
      if (seg === '..') {
        if (parts.length > 0) parts.pop();
        else up++;
      } else parts.push(seg);
    }
    let target = '../'.repeat(up) + parts.join('/');
    if (!target.endsWith('.ts')) target += '.ts';
    if (target === '..' || target.startsWith('../')) return bad('behavior_source_escape', { reason: target, detail: target });
    if (!files.some((f) => f.path === target)) return bad('behavior_source_missing', { reason: target, detail: target });
    rel.push([from, target]);
  }
  const adj = new Map();
  for (const [a, b] of rel) adj.set(a, [...(adj.get(a) ?? []), b]);
  const state = new Map();
  const stack = [];
  let cycle = null;
  const visit = (n) => {
    if (cycle) return;
    state.set(n, 1);
    stack.push(n);
    for (const next of adj.get(n) ?? []) {
      if (state.get(next) === 1) {
        cycle = [...stack.slice(stack.indexOf(next)), next];
        return;
      }
      if (!state.has(next)) visit(next);
    }
    stack.pop();
    state.set(n, 2);
  };
  visit(value.entryPath);
  if (cycle) return bad('behavior_source_cycle', { reason: cycle.join(' -> '), detail: cycle.join(' -> ') });
  const memo = new Map();
  const depth = (n) => {
    if (memo.has(n)) return memo.get(n);
    let best = 0;
    for (const next of adj.get(n) ?? []) best = Math.max(best, 1 + depth(next));
    memo.set(n, best);
    return best;
  };
  const importDepth = depth(value.entryPath);
  if (importDepth > limits.importDepth) {
    return bad('behavior_source_limits_exceeded', {
      reason: 'import_depth', limit: 'import_depth', current: importDepth, max: limits.importDepth,
    });
  }
  return {
    ok: true,
    fileCount: files.length,
    requiredModules: value.requiredModules,
    ownedTransforms: value.ownedTransforms,
    importDepth,
    typeOnlyImports,
    acceptedImports,
  };
}

const DIGEST_FIELDS = ['manifestDigest', 'outputDigest', 'recipeDigest', 'declarationDigest', 'outputByteLength'];
const isDigest = (v) => typeof v === 'string' && /^[0-9a-f]{64}$/.test(v);

function expectMatch(check, where, expect, derived) {
  for (const [k, v] of Object.entries(expect)) {
    if (expect.ok === true && DIGEST_FIELDS.includes(k)) {
      if (k === 'outputByteLength') {
        if (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > index.limits.outputBytes) {
          fail(check, `${where}: recorded outputByteLength is outside the compiler bound`);
        }
      } else if (!isDigest(v)) {
        fail(check, `${where}: recorded ${k} is not a 64-hex digest`);
      }
      continue;
    }
    if (JSON.stringify(derived[k]) !== JSON.stringify(v)) {
      fail(check, `${where}: ${k} derived ${JSON.stringify(derived[k])} != expected ${JSON.stringify(v)}`);
    }
  }
}

// 1 + 2: containers
let matched = 0;
let validCount = 0;
for (const c of index.cases) {
  const bytes = readFileSync(join(ROOT, c.container));
  const text = bytes.toString('utf8');
  if (sha256(bytes) !== c.containerDigest) fail('container-digest', `${c.caseId}: sha256 mismatch`);
  if (bytes.length !== c.containerByteLength) fail('container-digest', `${c.caseId}: length mismatch`);
  let value = null;
  try {
    value = JSON.parse(text);
  } catch {
    value = null;
  }
  const derived = analyze(text, value, index.limits);
  expectMatch('container-analysis', c.caseId, c.expect, derived);
  if (derived.ok === true) {
    validCount++;
    if (typeof c.expect.outputByteLength !== 'number' || c.expect.outputByteLength > index.limits.outputBytes) {
      fail('container-analysis', `${c.caseId}: outputByteLength is not within the compiler bound`);
    }
  }
  matched++;
}
pass('containers', `${matched} container case(s) re-hashed, canonical-checked and re-analyzed (${validCount} valid)`);

// 3: the valid sample's recorded products
const sample = index.validSample;
const outBytes = readFileSync(join(ROOT, sample.outputArtifact.path));
if (sha256(outBytes) !== sample.outputArtifact.digest) fail('sample-output', 'committed output sha256 mismatch');
if (outBytes.length !== sample.outputArtifact.byteLength) fail('sample-output', 'committed output length mismatch');
const manifestBytes = Buffer.from(`${JSON.stringify(sample.manifest, null, 2)}\n`, 'utf8');
if (sha256(manifestBytes) !== sample.manifestDigest) fail('sample-manifest', 'manifest sha256 mismatch');
if (manifestBytes.length !== sample.manifestByteLength) fail('sample-manifest', 'manifest length mismatch');
{
  const containerValue = JSON.parse(readFileSync(join(ROOT, sample.container), 'utf8'));
  const byPath = new Map(containerValue.files.map((f) => [f.path, f]));
  for (const f of sample.manifest.files) {
    const src = byPath.get(f.path);
    if (!src) {
      fail('sample-files', `${f.path} not in the container`);
      continue;
    }
    if (sha256(Buffer.from(src.text, 'utf8')) !== f.digest) fail('sample-files', `${f.path} digest mismatch`);
    if (Buffer.byteLength(src.text, 'utf8') !== f.byteLength) fail('sample-files', `${f.path} byteLength mismatch`);
  }
}
if (sha256(Buffer.from(canonicalJsonText(sample.recipe), 'utf8')) !== sample.recipeDigest) {
  fail('sample-recipe', 'recipe digest mismatch');
}
if (sample.manifest.outputDigest !== sample.outputArtifact.digest) fail('sample-manifest', 'outputDigest != artifact digest');
if (sample.manifest.outputByteLength !== sample.outputArtifact.byteLength) fail('sample-manifest', 'outputByteLength != artifact length');
pass('sample-products', 'manifest/output/recipe digests and per-file digests re-derived from the committed bytes');

// 4: declaration + injected bound rows (marker-driven)
for (const c of index.declarationCases) {
  const props =
    c.declaration === 'empty'
      ? []
      : Array.from({ length: 33 }, (_, i) => ({ key: `p${i}`, label: `P${i}`, type: 'number', default: 0 }));
  const derived =
    props.length < 1 || props.length > index.limits.properties
      ? { ok: false, code: 'behavior_source_limits_exceeded', reason: 'properties', limit: 'properties' }
      : { ok: true };
  expectMatch('declaration-case', c.caseId, c.expect, derived);
}
pass('declaration-cases', `${index.declarationCases.length} declaration bound case(s) re-derived`);
for (const c of index.injectedCases) {
  const derived =
    c.injection === 'oversized-output'
      ? { ok: false, code: 'behavior_output_limits_exceeded', limit: 'output_bytes' }
      : c.injection === 'forbidden-output'
        ? { ok: false, code: 'behavior_output_forbidden_content', reason: 'd' }
        : c.injection === 'throwing-build'
          ? { ok: false, code: 'behavior_compile_failed' }
          : { ok: false, code: 'behavior_compile_timeout' };
  expectMatch('injected-case', c.caseId, c.expect, derived);
}
pass('injected-cases', `${index.injectedCases.length} injected bound/failure case(s) re-derived`);

if (failures > 0) {
  console.log(`check: FAIL — ${failures} mismatch(es)`);
  process.exit(1);
}
console.log('check: OK — all behavior-build fixture rows re-derived');

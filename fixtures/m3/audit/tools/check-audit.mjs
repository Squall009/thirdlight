/**
 * fixtures/m3/audit/tools/check-audit.mjs
 *
 * Packet 43's integrated M3 fixture checker. It is the single entry point for
 * the four packet checkers and adds the cross-pack audit that no single packet
 * can make:
 *
 *  1. runs fixtures/m3/{contracts,gameplay,media,delivery}/tools/check-fixtures.mjs
 *     as subprocesses and requires exit 0 from each;
 *  2. inventory closure and Gate K dispositions: every proposed diff item in
 *     docs/planning/m3-contracts/diffs/*.md has exactly one row in
 *     docs/planning/m3-contracts/contract-diffs.md §2, and vice versa; the row
 *     count and the 13 repaired/rejected statuses match index.json
 *     `inventory` (97 rows stay `open`);
 *  3. no two packets claim the same destination contract section unless the row
 *     records an explicit supersession/reconciliation;
 *  4. the scene/storage/manifest version tables in model.md, storage.md,
 *     diffs/workspace.md and delivery.md agree;
 *  5. one owner per new error code, and every code a fixture declares for a
 *     rejected input is registered (no fixture invents or silently coerces);
 *  6. one owner per v3 component, op, simulation phase and module, and one
 *     `content/sha256/` artifact class;
 *  7. traceability: every authorability row (A8 1–21), every acceptance row
 *     B01–B24 and the three PR-1 values have an owner and a creation path, and
 *     every C38/C39/C40/C41/C42 request is routed exactly once;
 *  8. the obsolete M1/M2 non-goal quotes the pack supersedes are recorded in the
 *     reconciliation section and the promoted scoping text is present in the
 *     accepted contracts (the docs-only Gate K promotion has been applied).
 *
 * This is fixture/planning tooling, NOT an implementation. No dependency, no
 * eval, no network.
 *
 * Usage (repository root):
 *   node fixtures/m3/audit/tools/check-audit.mjs
 *   TL43_FIXTURE_ROOT=<copy of fixtures/m3> node fixtures/m3/audit/tools/check-audit.mjs
 *   TL43_DOCS_ROOT=<copy of docs>          node fixtures/m3/audit/tools/check-audit.mjs
 *   node fixtures/m3/audit/tools/check-audit.mjs --report out.json
 *   node fixtures/m3/audit/tools/check-audit.mjs --corrupt-control
 *
 * Exit 0 = every check passed; 1 = at least one failed. `--corrupt-control`
 * copies the docs and fixture trees, applies one deliberate corruption to each
 * and requires this checker (and its sub-checkers) to exit non-zero on every
 * corrupted copy.
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync,
  rmSync, statSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..', '..', '..');
const FIXTURES = process.env.TL43_FIXTURE_ROOT
  ? resolve(process.env.TL43_FIXTURE_ROOT)
  : resolve(HERE, '..', '..');                       // fixtures/m3
const DOCS = process.env.TL43_DOCS_ROOT ? resolve(process.env.TL43_DOCS_ROOT) : join(REPO, 'docs');
const PKT = join(DOCS, 'planning', 'm3-contracts');
const REPORT = (() => {
  const i = process.argv.indexOf('--report');
  return i >= 0 ? resolve(process.argv[i + 1]) : null;
})();

const failures = [];
const passes = [];
const fail = (check, detail) => failures.push({ check, detail });
const pass = (check, detail) => passes.push({ check, detail: detail ?? null });
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ---------------------------------------------------------------------------
// input expectations
// ---------------------------------------------------------------------------
const audit = JSON.parse(readFileSync(join(FIXTURES, 'audit', 'index.json'), 'utf8'));
const diffFiles = Object.keys(audit.fileOwner).filter((f) => f.startsWith('diffs/'));
const DOC_NAMES = Object.keys(audit.fileOwner).filter((f) => !f.startsWith('diffs/'));
const readDoc = (rel) => readFileSync(join(PKT, rel), 'utf8');
const readDocLines = (rel) => readDoc(rel).split('\n');

// ---------------------------------------------------------------------------
// group 1: the four packet checkers as one entry point
// ---------------------------------------------------------------------------
{
  const results = [];
  for (const sc of audit.subCheckers) {
    const script = join(FIXTURES, sc.script);
    if (!existsSync(script)) {
      fail('subchecker', `${sc.name}: missing ${relative(REPO, script)}`);
      continue;
    }
    const env = { ...process.env };
    const root = sc.root === '.' ? FIXTURES : join(FIXTURES, sc.root);
    env[sc.env] = root;
    const r = spawnSync(process.execPath, [script], { env, encoding: 'utf8' });
    const status = r.status === null ? 'spawn-failed' : r.status;
    results.push({ name: sc.name, status });
    if (status !== 0) {
      const tail = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim().split('\n').slice(-3).join(' | ');
      fail('subchecker', `${sc.name}: exit ${status}${tail ? ` — ${tail}` : ''}`);
    }
  }
  const failed = results.filter((r) => r.status !== 0);
  if (failed.length === 0 && results.length === audit.subCheckers.length) {
    pass('subchecker', results.map((r) => `${r.name}=0`).join(', '));
  }
}

// ---------------------------------------------------------------------------
// parsing helpers
// ---------------------------------------------------------------------------
const INVENTORY_ID = /^\| ((?:PM43-\d+|PM41-\d+|PM\d+|CMD41-\d+|D42-\d+|E42-\d+|R40-\d+|R41-\d+|R42-\d+|S42-\d+|W\d+|C\d+|NC-\d+)) \|/;
const ANY_ITEM_ID = /\b(PM43-\d+|PM41-\d+|PM\d+|CMD41-\d+|D42-\d+|E42-\d+|R40-\d+|R41-\d+|R42-\d+|S42-\d+|W\d+|C\d+|NC-\d+)\b/g;

function ownerForLine(file, line) {
  for (const sw of audit.ownerSectionSwitch) {
    if (new RegExp(sw.match).test(line)) return sw.owner;
  }
  return null;
}

function parseDiffItems() {
  const items = new Map();       // id -> { file, owner }
  const headingIds = new Map();
  for (const f of diffFiles) {
    const rel = `diffs/${f.replace(/^diffs\//, '')}`;
    const lines = readDocLines(rel);
    let owner = audit.fileOwner[rel];
    for (const line of lines) {
      const sw = ownerForLine(rel, line);
      if (sw !== null) owner = sw;
      const m = line.match(INVENTORY_ID);
      if (m) items.set(m[1], { file: rel, owner });
      const h = line.match(/^#{3,4} ([A-Za-z0-9-]+)\b/);
      if (h && /^(PM|W|C|CMD|R\d|S42|E42|D42)/.test(h[1])) headingIds.set(h[1], rel);
    }
  }
  return { items, headingIds };
}

const diff = parseDiffItems();

function parseInventory() {
  const all = readDocLines('contract-diffs.md');
  const start = all.findIndex((l) => /^## 2\./.test(l));
  const end = all.findIndex((l) => /^## 3\./.test(l));
  const lines = all.slice(start >= 0 ? start : 0, end >= 0 ? end : all.length);
  const rows = new Map();
  for (const line of lines) {
    const m = line.match(INVENTORY_ID);
    if (!m) continue;
    const cells = line.split('|').slice(1, -1).map((c) => c.trim());
    rows.set(m[1], { cells, line });
  }
  return rows;
}

const inventory = parseInventory();

// ---------------------------------------------------------------------------
// group 2: inventory closure
// ---------------------------------------------------------------------------
{
  const problems = [];
  for (const id of diff.items.keys()) {
    if (!inventory.has(id)) problems.push(`missing inventory row ${id}`);
  }
  for (const id of inventory.keys()) {
    if (!diff.items.has(id) && !/^(PM43|NC)-/.test(id)) problems.push(`inventory row ${id} has no proposed diff item`);
  }
  for (const id of diff.headingIds.keys()) {
    if (!diff.items.has(id)) problems.push(`diff heading ${id} is not in its summary table`);
    if (!inventory.has(id)) problems.push(`diff heading ${id} missing from inventory`);
  }
  if (inventory.size !== diff.items.size + 5) problems.push(`inventory ${inventory.size} rows != ${diff.items.size} proposed diffs + 3 PM43 + 2 new-contract rows`);
  for (const [id, row] of inventory) {
    if (row.cells.length !== 8) problems.push(`${id}: expected 8 columns, got ${row.cells.length}`);
    if (row.cells[2] === '' || row.cells[3] === '') problems.push(`${id}: empty destination or fixture cell`);
  }
  // Gate K dispositions: the repair step writes them per fixtures/m3/audit/index.json
  const STATUS_RE = /^(open|repaired \((?:FU-\d+(?:\/K-\d+)?)(?:; FU-\d+(?:\/K-\d+)?)*\)|rejected \(superseded by PM41-1\))$/;
  const invMeta = audit.inventory ?? {};
  for (const [id, row] of inventory) {
    const status = row.cells[7];
    if (!STATUS_RE.test(status)) problems.push(`${id}: invalid Gate K status "${status}"`);
    const want = invMeta.repairedRows?.[id];
    if (want === undefined && status !== 'open') problems.push(`${id}: unrecorded non-open status "${status}"`);
    if (want !== undefined && status !== want) problems.push(`${id}: status "${status}" != recorded "${want}"`);
  }
  for (const id of Object.keys(invMeta.repairedRows ?? {})) {
    if (!inventory.has(id)) problems.push(`recorded repaired row ${id} is not in the inventory`);
  }
  const openCount = [...inventory.values()].filter((r) => r.cells[7] === 'open').length;
  if (invMeta.rows !== undefined && inventory.size !== invMeta.rows) problems.push(`inventory ${inventory.size} rows != recorded ${invMeta.rows}`);
  if (invMeta.openRows !== undefined && openCount !== invMeta.openRows) problems.push(`${openCount} open rows != recorded ${invMeta.openRows}`);
  if (invMeta.nonOpenRows !== undefined && inventory.size - openCount !== invMeta.nonOpenRows) problems.push(`${inventory.size - openCount} non-open rows != recorded ${invMeta.nonOpenRows}`);
  if (problems.length) fail('inventory', problems.join('; '));
  else pass('inventory', `${inventory.size} rows, one per proposed diff item; ${openCount} open / ${inventory.size - openCount} repaired`);
}

// ---------------------------------------------------------------------------
// group 3: one packet per destination section (explicit supersession required)
// ---------------------------------------------------------------------------
{
  const SECTION = /\b(project-model|workspace|commands|runtime|sessions|export|dependencies) §(\d+(?:\.\d+)*)/g;
  const bySection = new Map();
  for (const [id, row] of inventory) {
    const packet = Number(row.cells[1]);
    const dest = row.cells[2];
    const collision = row.cells[6].toLowerCase();
    if (/confirm/.test(collision)) continue;
    let m;
    const re = new RegExp(SECTION.source, 'g');
    while ((m = re.exec(dest)) !== null) {
      const key = `${m[1]} §${m[2]}`;
      if (!bySection.has(key)) bySection.set(key, []);
      bySection.get(key).push({ id, packet, collision });
    }
  }
  const problems = [];
  for (const [key, rows] of bySection) {
    const packets = new Set(rows.map((r) => r.packet));
    if (packets.size < 2) continue;
    const resolved = rows.some((r) => /supersede|supersession|reconcil|coexist/.test(r.collision));
    if (!resolved) {
      problems.push(`${key} claimed by packets ${[...packets].sort().join('/')} (${rows.map((r) => r.id).join(', ')}) without an explicit supersession/coexistence note`);
    }
  }
  if (problems.length) fail('destinations', problems.join('; '));
  else pass('destinations', `${bySection.size} destination sections, no unresolved multi-packet claim`);
}

// ---------------------------------------------------------------------------
// group 4: version tables agree
// ---------------------------------------------------------------------------
{
  const problems = [];
  for (const assertion of audit.versionAssertions) {
    let text;
    try {
      text = readDoc(assertion.file);
    } catch {
      problems.push(`${assertion.file}: unreadable`);
      continue;
    }
    for (const needle of assertion.mustContain) {
      if (!text.includes(needle)) problems.push(`${assertion.file}: missing "${needle}"`);
    }
  }

  // Combination rows: derive the canonical map from model.md and require the
  // other two sources to agree on every shared (manifest,scene,storage) pair.
  const rowRe = /^\s*([+-])?\|\s*([12]|any)\s*\|\s*([1234]|any|1 or 2|≥ ?4)\s*\|\s*([123]|any|1 or 2|≥ ?4|≥3 or ≤0|≥4 or ≤0)\s*\|\s*(.*?)\s*\|/;
  const tables = { 'model.md': {}, 'storage.md': {}, 'diffs/workspace.md': {} };
  for (const file of Object.keys(tables)) {
    for (const line of readDocLines(file)) {
      const m = line.match(rowRe);
      if (!m) continue;
      const [, sign, mm, ss, vv, rest] = m;
      const result = /\bvalid\b/.test(rest) ? 'valid' : (rest.match(/`([a-z_]+)`/) ?? [])[1] ?? 'unknown';
      tables[file][`${mm}|${ss}|${vv}`] = { result, sign: sign ?? '' };
    }
  }
  const canonical = tables['model.md'];
  if (Object.keys(canonical).length < 10) problems.push(`model.md: only ${Object.keys(canonical).length} combination rows parsed`);
  for (const [key, want] of Object.entries(canonical)) {
    for (const other of ['storage.md', 'diffs/workspace.md']) {
      const got = tables[other][key];
      if (got && got.result !== want.result) {
        problems.push(`${other}: ${key} = ${got.result} but model.md says ${want.result}`);
      }
    }
  }
  for (const required of ['1|1|1', '1|2|2', '1|3|3']) {
    if (canonical[required]?.result !== 'valid') problems.push(`model.md: ${required} must be valid`);
    const wt = tables['diffs/workspace.md'][required];
    if (wt && wt.result !== 'valid') problems.push(`diffs/workspace.md: ${required} must be valid`);
  }
  const wsRow = tables['diffs/workspace.md']['any|any|≥4 or ≤0'];
  if (!wsRow) problems.push('diffs/workspace.md: missing the ≥4 storage row');

  if (problems.length) fail('version', problems.join('; '));
  else pass('version', `${Object.keys(canonical).length} combination rows + ${audit.versionAssertions.length} assertions`);
}

// ---------------------------------------------------------------------------
// group 5: one owner per new error code; registered fixture rejection codes
// ---------------------------------------------------------------------------
function collectNegativeCodes() {
  const codes = new Set();
  const reasons = new Set();
  const addExpect = (o) => {
    if (!o || typeof o !== 'object') return;
    if (typeof o.code === 'string' && o.code) codes.add(o.code);
    if (typeof o.result === 'string' && o.result && o.result !== 'ok') codes.add(o.result);
    if (typeof o.reason === 'string' && o.reason && !o.reason.includes(' ')) reasons.add(o.reason);
  };
  const walk = (o) => {
    if (Array.isArray(o)) { o.forEach(walk); return; }
    if (!o || typeof o !== 'object') return;
    if (typeof o.code === 'string' && o.code) codes.add(o.code);
    if (typeof o.reason === 'string' && o.reason && !o.reason.includes(' ')) reasons.add(o.reason);
    addExpect(o.expect);
    for (const v of Object.values(o)) walk(v);
  };
  const walkDir = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'tools') continue;
        walkDir(p);
      } else if (entry.name.endsWith('.json')) {
        let doc;
        try { doc = JSON.parse(readFileSync(p, 'utf8')); } catch { continue; }
        if (entry.name === 'index.json' && doc.fixtures) {
          for (const meta of Object.values(doc.fixtures)) addExpect(meta.expect);
        }
        walk(doc);
      }
    }
  };
  for (const sub of ['contracts', 'gameplay', 'camera', 'media', 'delivery']) {
    const d = join(FIXTURES, sub);
    if (existsSync(d)) walkDir(d);
  }
  return { codes, reasons };
}
{
  const problems = [];
  const rowClaims = new Map();   // code -> Set(owner)
  const textClaims = new Map();  // code -> Set(owner)
  const registered = new Set([...Object.keys(audit.codeOwners), ...audit.acceptedCodes]);
  const allText = new Map();
  for (const file of [...DOC_NAMES, ...diffFiles.map((f) => `diffs/${f.replace(/^diffs\//, '')}`)]) {
    let text;
    try { text = readDoc(file); } catch { continue; }
    allText.set(file, text);
  }
  for (const [file, text] of allText) {
    const lines = text.split('\n');
    let owner = audit.fileOwner[file];
    for (const line of lines) {
      const sw = ownerForLine(file, line);
      if (sw !== null) owner = sw;
      const row = line.match(/^\s*[+-]?\|\s*`([a-z][a-z0-9_]+)`/);
      const code = row ? row[1] : null;
      for (const candidate of Object.keys(audit.codeOwners)) {
        if (!line.includes('`' + candidate + '`')) continue;
        if (!textClaims.has(candidate)) textClaims.set(candidate, new Set());
        textClaims.get(candidate).add(owner);
        if (code === candidate) {
          if (!rowClaims.has(candidate)) rowClaims.set(candidate, new Set());
          rowClaims.get(candidate).add(owner);
        }
      }
    }
  }
  for (const [code, declared] of Object.entries(audit.codeOwners)) {
    const rows = rowClaims.get(code) ?? new Set();
    const texts = textClaims.get(code) ?? new Set();
    for (const o of rows) if (o !== declared) problems.push(`${code}: defined in a packet-${o} code table but owned by ${declared}`);
    if (!texts.has(declared)) problems.push(`${code}: not found in the packet-${declared} docs`);
  }
  const { codes, reasons } = collectNegativeCodes();
  for (const code of codes) {
    if (code === 'ok') continue;
    if (!registered.has(code)) problems.push(`fixture rejects with unregistered code "${code}"`);
  }
  for (const reason of reasons) {
    if (!registered.has(reason) && !audit.reasonAllowlist.includes(reason)) {
      problems.push(`fixture declares unregistered reason "${reason}"`);
    }
  }
  if (problems.length) fail('codes', problems.join('; '));
  else pass('codes', `${Object.keys(audit.codeOwners).length} owned codes; ${codes.size} fixture rejection codes registered`);
}

// ---------------------------------------------------------------------------
// group 6: one owner per component / op / phase / module / artifact class
// ---------------------------------------------------------------------------
{
  const problems = [];
  if (!audit.components.every((c) => readDoc('model.md').includes(c))) problems.push('model.md: v3 component names differ');
  if (!audit.components.every((c) => readDoc('diffs/project-model.md').includes(c))) problems.push('diffs/project-model.md: v3 component list differs');
  for (const comp of audit.components) {
    const count = (text) => text.split('\n').filter((l) => new RegExp(`^\\| \\\`${comp}\\\` \\|`).test(l)).length;
    if (count(readDoc('authoring.md')) !== 1) problems.push(`authoring.md §A3.2: ${comp} must have exactly one row`);
    if (count(readDoc('diffs/commands.md').replace(/^\+/gm, '')) !== 1) problems.push(`diffs/commands.md C11: ${comp} must have exactly one row`);
  }
  const a2Source = readDoc('authoring.md');
  const a2Section = a2Source.slice(a2Source.indexOf('## A2'), a2Source.indexOf('## A3'));
  for (const op of ['createEntity', 'setComponent', 'applySurfacePreset', 'setGameConfig', 'publishAsset', 'queryGameConfig']) {
    const count = a2Section.split('\n').filter((l) => new RegExp(`^\\| \\\`${op}\\\` \\|`).test(l)).length;
    if (count !== 1) problems.push(`authoring.md §A2: op ${op} must appear exactly once (got ${count})`);
  }
  const cmdDiff = readDoc('diffs/commands.md');
  for (const op of ['applySurfacePreset', 'setGameConfig']) if (!cmdDiff.includes('`' + op + '`')) problems.push(`diffs/commands.md: missing op ${op}`);

  const phaseOrderLiteral = `[${audit.phaseOrder.map((p) => `'${p}'`).join(',')}]`;
  const gm = readDoc('gameplay.md').match(/SIMULATION_PHASE_ORDER\s*=\s*\[([^\]]+)\]/);
  if (!gm) problems.push('gameplay.md: SIMULATION_PHASE_ORDER not found');
  else {
    const order = gm[1].split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, ''));
    if (!eq(order, audit.phaseOrder)) problems.push(`gameplay.md: phase order ${order.join(',')} != ${audit.phaseOrder.join(',')}`);
  }
  if (!readDoc('diffs/runtime.md').includes(phaseOrderLiteral)) problems.push(`diffs/runtime.md: missing the extended phase order literal ${phaseOrderLiteral}`);

  const runtimeDiff = readDoc('diffs/runtime.md');
  for (const [id, meta] of Object.entries(audit.moduleOwners)) {
    if (!runtimeDiff.includes(id)) problems.push(`diffs/runtime.md: missing module ${id}`);
    const occurrences = runtimeDiff.split(id).length - 1;
    if (occurrences < 1) problems.push(`diffs/runtime.md: module ${id} not declared`);
  }
  if ((runtimeDiff.split('thirdlight.platformer-game:session').length - 1) > 3) {
    problems.push('diffs/runtime.md: module session declared in more than one inventory row');
  }

  for (const file of ['delivery.md', 'diffs/sessions.md']) {
    if (!readDoc(file).includes(audit.artifactPathToken)) problems.push(`${file}: missing the single ${audit.artifactPathToken} artifact path`);
  }
  for (const file of ['storage.md', 'diffs/workspace.md']) {
    if (!readDoc(file).includes('sources/sha256/')) problems.push(`${file}: missing the single sources/sha256/ artifact path`);
  }
  if (problems.length) fail('entities', problems.join('; '));
  else pass('entities', `${audit.components.length} components, 6 ops, 1 phase order, ${Object.keys(audit.moduleOwners).length} modules, 1 artifact class`);
}

// ---------------------------------------------------------------------------
// group 7: traceability — sample rows, acceptance rows, PR-1, request routing
// ---------------------------------------------------------------------------
function parseAcceptanceOwners() {
  const text = readFileSync(join(DOCS, 'planning', 'm3-acceptance.md'), 'utf8');
  const map = new Map();
  for (const line of text.split('\n')) {
    const m = line.match(/^\| (B\d\d) \|([^|]*)\|([^|]*)\|/);
    if (m) map.set(m[1], m[3].trim());
  }
  return map;
}
const normalizeOwners = (s) => {
  const out = new Set();
  for (const part of s.split(',')) {
    const t = part.trim();
    const range = t.match(/^(\d+)\s*[–-]\s*(\d+)$/);
    if (range) { for (let i = Number(range[1]); i <= Number(range[2]); i += 1) out.add(i); }
    else if (/^\d+$/.test(t)) out.add(Number(t));
  }
  return [...out].sort((a, b) => a - b);
};
{
  const problems = [];
  // A8 authorability rows
  const a8 = readDoc('authoring.md');
  const a8Section = a8.slice(a8.indexOf('## A8'));
  const a8Rows = [...a8Section.matchAll(/^\| (\d+) \|/gm)].map((m) => Number(m[1]));
  const expected = [];
  for (let i = audit.sampleRowRange[0]; i <= audit.sampleRowRange[1]; i += 1) expected.push(i);
  if (!eq(a8Rows.slice().sort((a, b) => a - b), expected)) problems.push(`authoring.md §A8 rows ${a8Rows.join(',')} != 1..21`);

  // traceability tables
  let trace = '';
  try { trace = readDoc('traceability.md'); } catch { problems.push('traceability.md unreadable'); }
  const tA8 = [...trace.matchAll(/^\| (\d+) \|/gm)].map((m) => Number(m[1]));
  if (!eq(tA8.slice().sort((a, b) => a - b), expected)) problems.push(`traceability.md A8 rows ${tA8.join(',')} != 1..21`);
  for (const line of trace.split('\n')) {
    const m = line.match(/^\| (\d+) \|(.+)$/);
    if (!m) continue;
    const cells = line.split('|').slice(1, -1).map((c) => c.trim());
    if (cells.length < 10) { problems.push(`traceability.md row ${m[1]}: expected 10 columns, got ${cells.length}`); continue; }
    if (!/create|setGameConfig|createEntity|setComponent|publishAsset|applySurfacePreset|setSettings|createPrefab|same/.test(cells[2])) {
      problems.push(`traceability.md row ${m[1]}: no creation op in column 3`);
    }
    if (/—\s*\(no creation path\)/.test(cells[2])) problems.push(`traceability.md row ${m[1]}: marked uncreatable`);
  }

  // PR-1 values
  const reference = trace + readDoc('model.md') + readDoc('presentation.md');
  for (const pr of audit.pr1Values) {
    if (!reference.includes(pr.traceabilityToken)) problems.push(`PR-1 ${pr.id}: traceability/contract token "${pr.traceabilityToken}" missing`);
    if (!trace.includes(pr.createOp)) problems.push(`PR-1 ${pr.id}: creation op "${pr.createOp}" missing from traceability.md`);
    if (!readDoc(pr.doc).includes(pr.id === 'activation' ? 'activation' : pr.id)) problems.push(`PR-1 ${pr.id}: owner doc ${pr.doc} does not define it`);
  }

  // acceptance rows
  const acceptance = parseAcceptanceOwners();
  const traceB = new Map();
  for (const line of trace.split('\n')) {
    const m = line.match(/^\| (B\d\d) \|(.+?)\|/);
    if (m) traceB.set(m[1], m[2].trim());
  }
  for (const id of audit.acceptanceRows) {
    if (!acceptance.has(id)) { problems.push(`m3-acceptance.md: missing row ${id}`); continue; }
    if (!traceB.has(id)) { problems.push(`traceability.md: missing row ${id}`); continue; }
    const a = normalizeOwners(acceptance.get(id));
    const b = normalizeOwners(traceB.get(id));
    if (!eq(a, b)) problems.push(`${id}: owners ${b.join(',')} != acceptance ${a.join(',')}`);
  }

  // request routing
  const diffText = readDoc('contract-diffs.md');
  const routing = diffText.slice(diffText.indexOf('## 3.'), diffText.indexOf('## 4.'));
  for (const req of audit.requestIds) {
    const hits = routing.split('\n').filter((l) => new RegExp(`(^|[^0-9A-Za-z-])${req}([^0-9-]|$)`).test(l));
    if (hits.length !== 1) { problems.push(`routing: ${req} appears ${hits.length} times (must be exactly 1)`); continue; }
    const ids = (hits[0].match(ANY_ITEM_ID) ?? []).filter((id) => id !== req && inventory.has(id));
    if (ids.length === 0 && !/unresolved|no row|confirmed/.test(hits[0])) {
      problems.push(`routing: ${req} names no destination row`);
    }
  }

  if (problems.length) fail('traceability', problems.join('; '));
  else pass('traceability', `A8 1–21, B01–B24 owners, ${audit.pr1Values.length} PR-1 values, ${audit.requestIds.length} requests routed`);
}

// ---------------------------------------------------------------------------
// group 8: superseded M1/M2 non-goal quotes exist and are recorded
// ---------------------------------------------------------------------------
{
  const problems = [];
  const diffText = readDoc('contract-diffs.md');
  for (const entry of audit.supersededQuotes) {
    const target = join(DOCS, entry.file);
    let text = '';
    try { text = readFileSync(target, 'utf8'); } catch { problems.push(`${entry.row}: cannot read ${entry.file}`); continue; }
    if (entry.promotedQuote && !text.includes(entry.promotedQuote)) problems.push(`${entry.row}: promoted scoping text not found in ${entry.file}`);
    if (!entry.promotedQuote && !text.includes(entry.fileQuote)) problems.push(`${entry.row}: accepted-contract quote not found in ${entry.file}`);
    if (entry.replaced && text.includes(entry.fileQuote)) problems.push(`${entry.row}: the superseded quote is still present in ${entry.file}`);
    if (!diffText.includes(entry.quote)) problems.push(`${entry.row}: quote not recorded in contract-diffs.md §5`);
    if (!diffText.includes(entry.row)) problems.push(`${entry.row}: row id missing from contract-diffs.md`);
  }
  if (!/## 5\. Packet 43 reconciliation/.test(diffText)) problems.push('contract-diffs.md: missing the Packet 43 reconciliation section');
  if (problems.length) fail('supersession', problems.join('; '));
  else pass('supersession', `${audit.supersededQuotes.length} obsolete non-goal quotes resolved`);
}

// ---------------------------------------------------------------------------
// report
// ---------------------------------------------------------------------------
const groups = new Set([...passes, ...failures].map((e) => e.check));
const report = {
  packet: 43,
  docsRoot: DOCS,
  fixtureRoot: FIXTURES,
  checksPassed: passes.length,
  failures: failures.length,
  failedChecks: failures,
};
if (REPORT) writeFileSync(REPORT, `${JSON.stringify(report, null, 2)}\n`);
for (const f of failures) console.error(`FAIL [${f.check}] ${f.detail}`);
console.log(`check-audit (packet 43) docs=${DOCS}`);
console.log(`  groups passed: ${passes.length}`);
console.log(`  groups failed: ${groups.size - passes.length}`);
console.log(failures.length === 0 ? '  all checks passed' : `  ${failures.length} failure(s)`);

// ---------------------------------------------------------------------------
// deliberate-corruption negative control
// ---------------------------------------------------------------------------
if (process.argv.includes('--corrupt-control')) {
  const run = (env) => {
    const r = spawnSync(process.execPath, [join(HERE, 'check-audit.mjs')], {
      env: { ...process.env, ...env },
      encoding: 'utf8',
    });
    return { status: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
  };
  const results = [];
  for (const ctl of audit.corruptControls) {
    const dir = mkdtempSync(join(tmpdir(), `tl43-corrupt-${ctl.id}-`));
    let env;
    if (ctl.target === 'docs') {
      const docsCopy = join(dir, 'docs');
      mkdirSync(join(docsCopy, 'planning'), { recursive: true });
      cpSync(join(DOCS, 'planning', 'm3-contracts'), join(docsCopy, 'planning', 'm3-contracts'), { recursive: true });
      cpSync(join(DOCS, 'planning', 'm3-acceptance.md'), join(docsCopy, 'planning', 'm3-acceptance.md'));
      if (existsSync(join(DOCS, 'contracts'))) cpSync(join(DOCS, 'contracts'), join(docsCopy, 'contracts'), { recursive: true });
      const p = join(docsCopy, ctl.file);
      const text = readFileSync(p, 'utf8');
      writeFileSync(p, text.replace(ctl.find, ctl.replace));
      env = { TL43_DOCS_ROOT: docsCopy };
    } else {
      const fixCopy = join(dir, 'm3');
      cpSync(FIXTURES, fixCopy, { recursive: true });
      const p = join(fixCopy, ctl.file);
      const text = readFileSync(p, 'utf8');
      writeFileSync(p, text.replace(ctl.find, ctl.replace));
      env = { TL43_FIXTURE_ROOT: fixCopy };
    }
    const r = run(env);
    const ok = r.status !== 0 && r.out.includes(ctl.expectCheck);
    results.push({ control: ctl.id, status: r.status, check: ctl.expectCheck, ok });
    rmSync(dir, { recursive: true, force: true });
  }
  for (const r of results) {
    console.log(`control [${r.control}] exit=${r.status} check=${r.check} ${r.ok ? 'PASS (non-zero, expected check fired)' : 'FAIL (corruption not detected)'}`);
  }
  const controlOk = results.every((r) => r.ok);
  console.log(controlOk ? 'negative control passed (all corruptions rejected)' : 'negative control FAILED');
  process.exit(failures.length === 0 && controlOk ? 0 : 1);
}

process.exit(failures.length === 0 ? 0 : 1);

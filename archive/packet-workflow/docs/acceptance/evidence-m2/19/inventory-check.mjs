#!/usr/bin/env node
// Packet-19 inventory-consistency check (evidence artifact, not a product tool).
// Verifies that docs/planning/m2-contracts/contract-diffs.md is a complete and
// resolvable inventory: every M2 proposal/diff file is listed, every referenced
// destination contract exists, the decision 0002 sections exist, and every
// implementing packet number exists in docs/planning/m2-packets.md.
//
// Run from the repository root:  node docs/acceptance/evidence-m2/19/inventory-check.mjs
import { readdirSync, readFileSync, statSync } from 'node:fs';

const REPO = process.cwd();
const CONTRACTS = 'docs/planning/m2-contracts';
const inventory = readFileSync(`${CONTRACTS}/contract-diffs.md`, 'utf8');
const problems = [];
const notes = [];
const ok = [];

const exists = (p) => {
  try { statSync(`${REPO}/${p}`); return true; } catch { return false; }
};

// 1. every proposal/diff file under m2-contracts must exist and be listed
const proposalFiles = [];
for (const f of readdirSync(`${CONTRACTS}`)) {
  if (f.endsWith('.md') && f !== 'contract-diffs.md') proposalFiles.push(f);
}
for (const f of readdirSync(`${CONTRACTS}/diffs`)) {
  if (f.endsWith('.md')) proposalFiles.push(`diffs/${f}`);
}
for (const f of proposalFiles) {
  if (!inventory.includes(f)) problems.push(`inventory does not list proposal file ${f}`);
}
ok.push(`${proposalFiles.length} proposal/diff file(s) enumerated; all listed in contract-diffs.md`);

// 2. every backticked proposal-looking filename in the inventory must exist
const backticked = new Set([...inventory.matchAll(/`([^`\n]+)`/g)].map((m) => m[1]));
const fileLike = [...backticked].filter((t) => /^[a-z0-9-]+\.md$/.test(t) || /^diffs\/[a-z0-9-]+\.md$/.test(t));
for (const t of fileLike) {
  const p = t.startsWith('diffs/') ? `${CONTRACTS}/${t}` : `${CONTRACTS}/${t}`;
  if (!exists(p)) {
    const dc = `docs/contracts/${t}`;
    if (!exists(dc)) problems.push(`referenced file not found: ${t}`);
  }
}
ok.push(`${fileLike.length} distinct file token(s) referenced by the inventory resolve to a real file`);

// 3. destination contract documents named in §2 must exist
const destinations = ['workspace.md', 'project-model.md', 'commands.md', 'runtime.md', 'sessions.md', 'export.md', 'dependencies.md'];
for (const d of destinations) {
  if (!exists(`docs/contracts/${d}`)) problems.push(`destination contract missing: docs/contracts/${d}`);
}
ok.push(`${destinations.length} destination contract document(s) present`);

// 4. decision 0002 §§2–6 headings
const decisionRaw = readFileSync('docs/decisions/0002-m2-content-and-behavior.md', 'utf8');
const decision = decisionRaw.replace(/\s+/g, ' ');
for (const n of [2, 3, 4, 5, 6]) {
  if (!new RegExp(`^## ${n}\\. `, 'm').test(decisionRaw)) problems.push(`decision 0002 §${n} heading missing`);
}
if (!/owner pre-approval \(autonomous M2 build instruction, 2026-09-18\); final manual review pending/.test(decision)) {
  problems.push('decision 0002 is missing the owner pre-approval tag');
}
ok.push('decision 0002 §§2–6 present and carry the owner pre-approval tag');

// 5. implementing packets referenced by the inventory exist in m2-packets.md
const packets = readFileSync('docs/planning/m2-packets.md', 'utf8');
const packetHeadings = new Set([...packets.matchAll(/^## (\d+) — /gm)].map((m) => m[1]));
const referenced = new Set([...inventory.matchAll(/\b(1[4-9]|2\d|3[0-7])\b/g)].map((m) => m[1]));
let missing = 0;
for (const n of referenced) {
  if (!packetHeadings.has(n)) { problems.push(`referenced packet ${n} has no section in m2-packets.md`); missing++; }
}
ok.push(`${referenced.size} packet number(s) referenced; ${referenced.size - missing} resolve to a m2-packets.md section`);

// 6. mandatory packet-19 deliverables exist
for (const p of [
  'docs/planning/m2-contracts/delivery.md',
  'docs/planning/m2-contracts/contract-diffs.md',
  'docs/planning/m2-contracts/diffs/sessions.md',
]) if (!exists(p)) problems.push(`packet-19 deliverable missing: ${p}`);
ok.push('delivery.md + contract-diffs.md + diffs/sessions.md present');

notes.push('This check is a docs-level consistency check. It establishes that the consolidated inventory resolves to real files and real packet sections; it does not execute any proposed behavior.');

console.log('inventory-consistency:');
for (const o of ok) console.log(`ok   ${o}`);
for (const n of notes) console.log(`note ${n}`);
for (const p of problems) console.log(`FAIL ${p}`);
console.log(problems.length === 0
  ? `inventory-consistency OK: ${ok.length} check(s), 0 problem(s)`
  : `inventory-consistency FAILED: ${problems.length} problem(s)`);
process.exit(problems.length === 0 ? 0 : 1);

#!/usr/bin/env node
/**
 * Proves an edit touched comments only: every checked source file (the
 * history check's set) is compiled with `removeComments: true` and the
 * emitted JavaScript is hashed. Record before the edit, compare after; any
 * file whose output changed is listed with its first differing line.
 *
 * Usage: node tools/emit-compare.mjs record <snapshot.json>
 *        node tools/emit-compare.mjs compare <snapshot.json>
 */

import ts from 'typescript';
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import { checkedFiles } from './history-comments.mjs';

const COMPILER_OPTIONS = {
  removeComments: true,
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ESNext,
  jsx: ts.JsxEmit.Preserve,
  isolatedModules: true,
  verbatimModuleSyntax: false,
  useDefineForClassFields: true,
};

/** The comment-free JavaScript of one source file. */
export function emitWithoutComments(text, fileName) {
  // A JavaScript input would emit onto its own name, which the compiler
  // refuses; its TypeScript twin name emits the same JavaScript.
  const asTs = fileName.replace(/\.(m|c)?js$/, (_, m) => `.${m ?? ''}ts`);
  return ts.transpileModule(text, { compilerOptions: COMPILER_OPTIONS, fileName: asTs, reportDiagnostics: false }).outputText;
}

/** `{ file: { sha256, js } }` for every checked file under `root`. */
export function snapshot(root, { keepText = false } = {}) {
  const out = {};
  for (const file of checkedFiles(root)) {
    // Declarations emit no JavaScript; their comments are covered by the history check.
    if (/\.d\.[mc]?ts$/.test(file)) continue;
    const js = emitWithoutComments(readFileSync(join(root, file), 'utf8'), file);
    out[file] = { sha256: createHash('sha256').update(js).digest('hex'), ...(keepText ? { js } : {}) };
  }
  return out;
}

/** Files added, removed or emitting different JavaScript between two snapshots. */
export function compareSnapshots(before, after) {
  const changed = [];
  for (const file of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const a = before[file];
    const b = after[file];
    if (!a || !b) changed.push({ file, why: a ? 'removed' : 'added' });
    else if (a.sha256 !== b.sha256) {
      const al = (a.js ?? '').split('\n');
      const bl = (b.js ?? '').split('\n');
      let i = 0;
      while (i < al.length && al[i] === bl[i]) i++;
      changed.push({ file, why: `emitted JavaScript differs at line ${i + 1}`, before: al[i], after: bl[i] });
    }
  }
  return changed.sort((x, y) => x.file.localeCompare(y.file));
}

function main() {
  const [mode, path] = process.argv.slice(2);
  if ((mode !== 'record' && mode !== 'compare') || !path) {
    console.error('usage: emit-compare.mjs record|compare <snapshot.json>');
    process.exit(2);
  }
  const now = snapshot(process.cwd(), { keepText: true });
  if (mode === 'record') {
    writeFileSync(path, JSON.stringify(now));
    console.log(`emit-compare: recorded ${Object.keys(now).length} file(s) to ${path}`);
    return;
  }
  const changed = compareSnapshots(JSON.parse(readFileSync(path, 'utf8')), now);
  for (const c of changed) {
    console.error(`${c.file}: ${c.why}`);
    if (c.before !== undefined || c.after !== undefined) console.error(`  - ${c.before}\n  + ${c.after}`);
  }
  if (changed.length > 0) {
    console.error(`emit-compare: FAIL — ${changed.length} file(s) emit different JavaScript`);
    process.exit(1);
  }
  console.log(`emit-compare: OK — ${Object.keys(now).length} file(s) emit byte-identical JavaScript`);
}

function isMain() {
  const invoked = process.argv[1];
  if (!invoked) return false;
  try {
    return realpathSync(invoked) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (isMain()) main();

#!/usr/bin/env node
/**
 * Unit-size check. Large units are where every feature lands and where a
 * change gets expensive, so their size is capped, not only the file's:
 *
 *   - a function or closure spans at most FUNCTION_LINES_MAX lines;
 *   - a class has at most CLASS_MEMBERS_MAX members;
 *   - a file has at most FILE_LINES_MAX lines.
 *
 * Spans come from the TypeScript parser (first line of the node's own text to
 * its last line), so comments in front of a unit do not count and a nested
 * closure counts on its own as well as inside its parent.
 *
 * Usage: node tools/check-size.mjs              (every unit over the limits, largest first)
 *        node tools/check-size.mjs --near       (also files over FILE_LINES_NEAR)
 */

import ts from 'typescript';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

/** The limits, defined here only. */
export const FUNCTION_LINES_MAX = 400;
export const CLASS_MEMBERS_MAX = 80;
export const FILE_LINES_MAX = 2000;
/** Reported with --near: files close enough to the file limit that the next feature should split first. */
export const FILE_LINES_NEAR = 1800;

/**
 * Where the check applies: every package's sources, the tools and the repo tests. The file limit holds for
 * all of them; the unit limits for code the engine and tools are built from, not for tests (a test file's
 * `describe` callback is a list of cases, not a unit). Generated files are written by a tool, never edited.
 */
export const CHECKED_ROOTS = Object.freeze(['packages', 'tools', 'tests']);
const SOURCE_RE = /\.(?:ts|tsx|mts|cts|js|mjs|cjs)$/;
const GENERATED_RE = /\.generated\.[cm]?[jt]sx?$|\.d\.ts$/;

/** Whether a checked file is a test (its units are not held to the unit limits). */
export function isTestFile(file) {
  const f = file.replaceAll('\\', '/');
  return /\.(?:test|spec|e2e)\.[cm]?[jt]sx?$/.test(f) || /^tests\//.test(f) || /\/(?:tests?|__tests__)\//.test(f);
}
const SKIP_DIRS = new Set(['node_modules', 'dist', '.build', 'fixtures', '__pycache__']);

function scriptKind(file) {
  if (file.endsWith('.tsx')) return ts.ScriptKind.TSX;
  if (/\.(?:js|mjs|cjs)$/.test(file)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

function propertyName(name, sf) {
  if (!name) return undefined;
  if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
  return name.getText(sf);
}

function calleeName(expr, sf) {
  if (ts.isIdentifier(expr)) return expr.text;
  if (ts.isPropertyAccessExpression(expr)) return `${calleeName(expr.expression, sf) ?? '?'}.${expr.name.text}`;
  if (ts.isCallExpression(expr)) return calleeName(expr.expression, sf);
  return undefined;
}

/** A unit's own name, from its declaration or the place it is assigned or passed to; undefined if it has none. */
function ownName(node, sf) {
  if (ts.isConstructorDeclaration(node)) return 'constructor';
  if (ts.isGetAccessorDeclaration(node)) return `get ${propertyName(node.name, sf)}`;
  if (ts.isSetAccessorDeclaration(node)) return `set ${propertyName(node.name, sf)}`;
  if (node.name) return propertyName(node.name, sf);
  const parent = node.parent;
  if (!parent) return undefined;
  if (ts.isVariableDeclaration(parent) || ts.isPropertyAssignment(parent) || ts.isPropertyDeclaration(parent)) {
    return propertyName(parent.name, sf);
  }
  if (ts.isBinaryExpression(parent) && parent.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
    return parent.left.getText(sf).replace(/\s+/g, '');
  }
  if (ts.isCallExpression(parent)) return `(${calleeName(parent.expression, sf) ?? 'call'} callback)`;
  if (ts.isExportAssignment(parent)) return 'default';
  return undefined;
}

function isFunctionUnit(node) {
  return (
    (ts.isFunctionDeclaration(node) ||
      ts.isFunctionExpression(node) ||
      ts.isArrowFunction(node) ||
      ts.isMethodDeclaration(node) ||
      ts.isConstructorDeclaration(node) ||
      ts.isGetAccessorDeclaration(node) ||
      ts.isSetAccessorDeclaration(node)) &&
    node.body !== undefined
  );
}

/** A class's members: its declarations, an overload set counted once, stray semicolons not at all. */
export function classMemberCount(node) {
  let n = 0;
  for (const m of node.members) {
    if (ts.isSemicolonClassElement(m)) continue;
    if ((ts.isMethodDeclaration(m) || ts.isConstructorDeclaration(m)) && m.body === undefined) continue;
    n += 1;
  }
  return n;
}

/**
 * Every unit in one source file: `{ unit, kind: 'function' | 'class', size, line }`. A unit's name is its
 * path of named parents (`Viewport.render`, `createBackend > handleRequest`); names that repeat in a file
 * get `#2`, `#3` in source order, so the names stay stable when unrelated code moves.
 */
export function measureUnits(text, fileName = 'source.ts') {
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, scriptKind(fileName));
  const lineOf = (pos) => sf.getLineAndCharacterOfPosition(pos).line + 1;
  const units = [];
  const seen = new Map();
  const visit = (node, path) => {
    let next = path;
    const isFn = isFunctionUnit(node);
    const isClass = ts.isClassDeclaration(node) || ts.isClassExpression(node);
    if (isFn || isClass) {
      const name = ownName(node, sf) ?? (isClass ? '(class)' : '(function)');
      const sep = path.length === 0 ? '' : ts.isClassElement(node) ? '.' : ' > ';
      const base = path.length === 0 ? name : `${path.join('')}${sep}${name}`;
      const count = (seen.get(base) ?? 0) + 1;
      seen.set(base, count);
      const unit = count === 1 ? base : `${base}#${count}`;
      const start = lineOf(node.getStart(sf));
      const size = isClass ? classMemberCount(node) : lineOf(node.end) - start + 1;
      units.push({ unit, kind: isClass ? 'class' : 'function', size, line: start });
      next = [unit];
    }
    ts.forEachChild(node, (child) => visit(child, next));
  };
  visit(sf, []);
  return { lines: text.length === 0 ? 0 : text.split('\n').length - (text.endsWith('\n') ? 1 : 0), units };
}

/** The checked source files under `root` (relative paths, sorted). */
export function checkedFiles(root) {
  const out = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      if (SKIP_DIRS.has(name) || name.startsWith('.')) continue;
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (SOURCE_RE.test(name) && !GENERATED_RE.test(name)) out.push(relative(root, path).replaceAll('\\', '/'));
    }
  };
  for (const top of CHECKED_ROOTS) {
    if (top === 'packages') {
      for (const pkg of readdirSync(join(root, 'packages'))) {
        const src = join(root, 'packages', pkg, 'src');
        try {
          if (statSync(src).isDirectory()) walk(src);
        } catch {
          // a package directory without sources has nothing to check
        }
      }
    } else {
      try {
        walk(join(root, top));
      } catch {
        // an absent top-level directory has nothing to check
      }
    }
  }
  return out.sort();
}

/**
 * Everything over a limit under `root`: `[{ file, unit, kind: 'file' | 'function' | 'class', size, limit }]`,
 * largest first within each kind. A file entry's unit is '(file)'.
 */
export function oversized(root, { fileLimit = FILE_LINES_MAX } = {}) {
  const out = [];
  for (const file of checkedFiles(root)) {
    const { lines, units } = measureUnits(readFileSync(join(root, file), 'utf8'), file);
    if (lines > fileLimit) out.push({ file, unit: '(file)', kind: 'file', size: lines, limit: fileLimit });
    if (isTestFile(file)) continue;
    for (const u of units) {
      const limit = u.kind === 'class' ? CLASS_MEMBERS_MAX : FUNCTION_LINES_MAX;
      if (u.size > limit) out.push({ file, unit: u.unit, kind: u.kind, size: u.size, limit, line: u.line });
    }
  }
  const order = { file: 0, function: 1, class: 2 };
  return out.sort((a, b) => order[a.kind] - order[b.kind] || b.size - a.size || a.file.localeCompare(b.file));
}

function main(argv) {
  const root = join(fileURLToPath(new URL('.', import.meta.url)), '..');
  const near = argv.includes('--near');
  const found = oversized(root, { fileLimit: near ? FILE_LINES_NEAR : FILE_LINES_MAX });
  for (const e of found) {
    const what = e.kind === 'class' ? 'members' : 'lines';
    console.log(`${e.kind.padEnd(8)} ${String(e.size).padStart(5)} ${what.padEnd(7)} ${e.file}${e.unit === '(file)' ? '' : `  ${e.unit}`}`);
  }
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(main(process.argv.slice(2)));
}

#!/usr/bin/env node
/**
 * History-comment check. Source comments say why the code is the way it is;
 * the history of how it got there lives in git and the phase plans. This
 * check fails on comments (and test titles) that name a phase, a plan item,
 * a delivery packet or milestone, an audit-list defect, a date, or a
 * numbered section of a spec (the section sign), so they do not creep back.
 *
 * Comments are found with the TypeScript parser, never a regex over code,
 * so string literals, template strings and regexes are not read as comments.
 *
 * Usage: node tools/history-comments.mjs            (check; exit 1 on hits)
 *        node tools/history-comments.mjs --list     (print every hit)
 */

import ts from 'typescript';
import { readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

/**
 * The history markers, defined here only. Each is narrow enough that prose
 * about the engine itself (a physics "phase", `M3_ENGINE_PINS`, 3D) does not
 * match; the unit test pins both sides.
 */
export const HISTORY_PATTERNS = Object.freeze([
  { name: 'phase', re: /\b[Pp]hases?\s+\d/ },
  { name: 'item id', re: /\b(?:[1-9]|[12]\d)\.\d{1,2}[a-h]\b/ },
  { name: 'item id', re: /\b(?:[Ss]ince|[Uu]ntil|[Bb]efore|[Aa]fter|[Ii]tems?|[Pp]lan|[Ii]n|[Ss]ee|[Bb]y|[Ff]rom)\s+(?:9|[12]\d)\.\d{1,2}\b(?!\s*(?:m|s|ms|px|%|°|x|Hz|MiB|KiB|kB|MB)\b)/ },
  { name: 'packet', re: /\b[Pp]ackets?[\s-]+\d/ },
  { name: 'milestone', re: /\bM[1-9](?:\+M[1-9])?(?=\s*(?:\(|:|,|;|\)|—|-\s|era\b|milestone|packet|review|contract|acceptance|repair|work\b|state\b|$))/ },
  { name: 'audit id', re: /\bD\d{1,3}\b(?![-.]\d)/ },
  { name: 'date', re: /\b20\d\d-[01]\d-[0-3]\d\b/ },
  { name: 'spec section', re: /§/ },
]);

/** Where the check applies: every package's sources (tests included), the tools and the repo tests. */
export const CHECKED_ROOTS = Object.freeze(['packages', 'tools', 'tests']);
const SOURCE_RE = /\.(?:ts|tsx|mts|cts|js|mjs|cjs)$/;
const SKIP_DIRS = new Set(['node_modules', 'dist', '.build', 'fixtures', '__pycache__']);

function scriptKind(file) {
  if (file.endsWith('.tsx')) return ts.ScriptKind.TSX;
  if (/\.(?:js|mjs|cjs)$/.test(file)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

function isJsDocNode(node) {
  return node.kind >= ts.SyntaxKind.FirstJSDocNode && node.kind <= ts.SyntaxKind.LastJSDocNode;
}

/**
 * Every comment in a source file, as `{ pos, end, text }`: the trivia in
 * front of each token of the parsed tree (JSX text is not trivia).
 */
export function commentRanges(text, fileName = 'source.ts') {
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, scriptKind(fileName));
  const found = new Map();
  const visit = (node) => {
    if (isJsDocNode(node)) return;
    const children = node.getChildren(sf);
    if (children.length === 0) {
      if (node.kind === ts.SyntaxKind.JsxText) return;
      // Trailing ranges are the comments on the previous token's line,
      // leading ranges the ones after its line break; together, all of them.
      const ranges = [...(ts.getTrailingCommentRanges(text, node.pos) ?? []), ...(ts.getLeadingCommentRanges(text, node.pos) ?? [])];
      for (const r of ranges) {
        if (!found.has(r.pos)) found.set(r.pos, { pos: r.pos, end: r.end, text: text.slice(r.pos, r.end) });
      }
      return;
    }
    for (const child of children) visit(child);
  };
  visit(sf);
  return { sourceFile: sf, comments: [...found.values()].sort((a, b) => a.pos - b.pos) };
}

const TEST_CALLEES = new Set(['describe', 'it', 'test', 'suite']);

/** The titles of `describe`/`it`/`test` calls (and `.skip`/`.only`/`.each(...)` forms). */
export function testTitles(sourceFile) {
  const titles = [];
  const calleeRoot = (expr) => {
    while (true) {
      if (ts.isIdentifier(expr)) return expr.text;
      if (ts.isPropertyAccessExpression(expr)) expr = expr.expression;
      else if (ts.isCallExpression(expr)) expr = expr.expression;
      else return undefined;
    }
  };
  const visit = (node) => {
    if (ts.isCallExpression(node) && TEST_CALLEES.has(calleeRoot(node.expression) ?? '')) {
      const first = node.arguments[0];
      if (first && (ts.isStringLiteral(first) || ts.isNoSubstitutionTemplateLiteral(first) || ts.isTemplateExpression(first))) {
        titles.push({ pos: first.getStart(sourceFile), end: first.end, text: first.getText(sourceFile) });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return titles;
}

/** The history markers in one piece of comment or title text. */
export function historyMarkers(text) {
  const hits = [];
  for (const { name, re } of HISTORY_PATTERNS) {
    const m = text.match(re);
    if (m) hits.push({ name, match: m[0] });
  }
  return hits;
}

/** Every history hit in one file: `{ line, kind: 'comment' | 'test title', name, match }`. */
export function historyHits(text, fileName) {
  const { sourceFile, comments } = commentRanges(text, fileName);
  const hits = [];
  const add = (kind, range) => {
    for (const marker of historyMarkers(range.text)) {
      const line = sourceFile.getLineAndCharacterOfPosition(range.pos).line + 1;
      hits.push({ line, kind, ...marker });
    }
  };
  for (const c of comments) add('comment', c);
  for (const t of testTitles(sourceFile)) add('test title', t);
  return hits;
}

/** The checked source files under `root` (relative paths). */
export function checkedFiles(root) {
  const out = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      if (SKIP_DIRS.has(name) || name.startsWith('.')) continue;
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (SOURCE_RE.test(name)) out.push(relative(root, path));
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

/** Run the check over a workspace root; returns `{ files, hits: [{ file, line, kind, name, match }] }`. */
export function checkHistory(root) {
  const files = checkedFiles(root);
  const hits = [];
  for (const file of files) {
    for (const hit of historyHits(readFileSync(join(root, file), 'utf8'), file)) hits.push({ file, ...hit });
  }
  return { files: files.length, hits };
}

function main() {
  const { files, hits } = checkHistory(process.cwd());
  const list = process.argv.includes('--list');
  if (hits.length > 0) {
    const shown = list ? hits : hits.slice(0, 40);
    for (const h of shown) console.error(`${h.file}:${h.line}: ${h.kind} names a ${h.name} (${JSON.stringify(h.match)})`);
    if (shown.length < hits.length) console.error(`… ${hits.length - shown.length} more (--list prints all)`);
    console.error(
      `history-comments: FAIL — ${hits.length} history marker(s) in ${files} file(s). ` +
        'Say why the code is the way it is; history lives in git and docs/plan-phase-*.md.',
    );
    process.exit(1);
  }
  console.log(`history-comments: OK — ${files} source file(s), no history markers in comments or test titles.`);
}

// Realpath-based, so a symlinked or relative tool path still runs the check.
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

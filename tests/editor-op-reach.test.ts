/**
 * Every command op the backend accepts can be sent from the editor: the
 * browser and MCP share one set of editing commands, so an op only the API
 * can send is a gap in the editor (or a deliberate API-only op, listed below
 * with its reason). The op list is the validator's; the editor's senders are
 * read from its source, so a new op without an editor sender fails here and
 * is named.
 *
 * A sender is the op's name as a string literal in an editor source file
 * that sends commands (`.command(...)`, a `…Command(...)` helper, or a
 * component handed a runner that takes the op, `op: string`), outside
 * comments and outside comparisons and `case` labels (those read change
 * records, they do not send). The editor reaches ops through typed wrappers,
 * per-kind tables and op parameters, so a literal in a sending file is the
 * reliable trace; a call such as `c.command(op, …)` with `op` built
 * elsewhere in the same file is covered by that file's literals.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { MUTATION_OPS } from '../packages/commands/src/index';

const EDITOR_SRC = resolve(import.meta.dirname, '..', 'packages', 'editor', 'src');

/** Ops the editor does not send, by design. */
const API_ONLY: Readonly<Record<string, string>> = {
  importResources:
    "sent by the backend's file check, which the editor starts (Check files, and after an import): resource and scene files found in the game folder come in as one undo step; no client builds it",
  createEntities:
    'bulk creation for build scripts and agents (up to 1024 objects in one revision); the editor creates objects one at a time (createEntity, pasteEntities, instantiatePrefab, a folder with children)',
};

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) sourceFiles(p, out);
    else if (/\.(ts|tsx)$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) && !e.name.endsWith('.d.ts')) out.push(p);
  }
  return out;
}

/** The text without comments (a comment naming an op is not a sender). */
function withoutComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1');
}

const SENDS = /\.command\(|[a-z]Command\(|\bop: string\b/;

/** The quoted identifiers of a text, bar those in comments, comparisons and `case` labels. */
function literals(text: string): string[] {
  return [...withoutComments(text).matchAll(/(case\s+|[!=]==\s*)?(['"])([A-Za-z]+)\2(\s*[!=]==)?/g)].filter((m) => m[1] === undefined && m[4] === undefined).map((m) => m[3]!);
}

/** Each op literal of the sending files, with the files it is in. */
function senders(): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const file of sourceFiles(EDITOR_SRC)) {
    const text = readFileSync(file, 'utf8');
    if (!SENDS.test(withoutComments(text))) continue;
    for (const name of literals(text)) {
      const list = out.get(name) ?? [];
      const rel = relative(EDITOR_SRC, file);
      if (!list.includes(rel)) list.push(rel);
      out.set(name, list);
    }
  }
  return out;
}

describe('editor op reach', () => {
  const found = senders();

  it('the editor sends every command op (or the op is API-only with a reason)', () => {
    const missing = MUTATION_OPS.filter((op) => !found.has(op) && API_ONLY[op] === undefined);
    expect(missing, `ops with no editor sender: ${missing.join(', ')} — add a sender in the editor, or list the op in API_ONLY with why`).toEqual([]);
  });

  it('the API-only list names real ops the editor really does not send', () => {
    for (const op of Object.keys(API_ONLY)) {
      expect(MUTATION_OPS as readonly string[], `${op} is not a command op`).toContain(op);
      expect(found.get(op), `${op} is API-only but the editor sends it (from ${found.get(op)?.join(', ')}): take it off the list`).toBeUndefined();
    }
  });

  it('a comparison, a case label or a comment is not a sender', () => {
    expect(literals("case 'deleteBehavior': if (t === 'revokeBehaviorTrust') {} // 'setShell'\n/* 'setModes' */")).toEqual([]);
    expect(literals("c.command('deleteBehavior', {}); const op = { behavior: 'deleteBehavior' };")).toEqual(['deleteBehavior', 'deleteBehavior']);
  });
});

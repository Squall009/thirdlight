/**
 * Phase 16.3: the script editor's source model (pure, Node-testable).
 *
 * A behavior's source is a source-graph container (`thirdlight-behavior-source`
 * v1: `graphVersion`, `entryPath` = `src/index.ts`, `requiredModules`,
 * `ownedTransforms`, `files[{path, text}]`). The script tab edits its files as
 * a file list — add, rename, delete (the entry cannot be renamed or deleted)
 * — and serializes the canonical container bytes the backend compiler
 * accepts (2-space JSON in field order, files in ascending path order, `\n`).
 * The rules mirror the compiler's container checks (behavior-build
 * `container.ts`) so a bad name is refused before a round trip; the backend
 * stays the authority.
 *
 * Member completion (`memberCompletion`) walks the generated behavior API
 * table (`ui/script/behavior-api.generated.ts`) along an `a.b.c.` chain.
 */

import { BEHAVIOR_ENTRY_PATH, MAX_BEHAVIOR_FILES, MAX_BEHAVIOR_FILE_BYTES } from '@thirdlight/project-model/limits';

/** The entry file every container has. */
export const ENTRY_PATH = BEHAVIOR_ENTRY_PATH;
/** The compiler's file-count bound (the model's, which the compiler checks). */
export const MAX_FILES = MAX_BEHAVIOR_FILES;
/** The compiler's per-file byte bound. */
export const MAX_FILE_BYTES = MAX_BEHAVIOR_FILE_BYTES;
/** The module the behavior API types are imported from (type-only). */
export const API_MODULE = '@thirdlight/runtime';

const PATH_RE = /^[a-z0-9][a-z0-9._-]*(\/[a-z0-9][a-z0-9._-]*)*$/;

export interface ScriptFile {
  path: string;
  text: string;
}

export interface ScriptContainer {
  graphVersion: 1;
  entryPath: string;
  requiredModules: string[];
  ownedTransforms: string[];
  files: ScriptFile[];
}

function byPath(a: ScriptFile, b: ScriptFile): number {
  return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
}

/** The canonical container text (the bytes the compiler digests). */
export function containerText(c: ScriptContainer): string {
  const out = {
    graphVersion: c.graphVersion,
    entryPath: c.entryPath,
    requiredModules: [...c.requiredModules],
    ownedTransforms: [...c.ownedTransforms],
    files: [...c.files].sort(byPath).map((f) => ({ path: f.path, text: f.text })),
  };
  return `${JSON.stringify(out, null, 2)}\n`;
}

export function containerBytes(c: ScriptContainer): Uint8Array {
  return new TextEncoder().encode(containerText(c));
}

/** Read a stored container (the published source text). */
export function parseContainer(text: string): { ok: true; container: ScriptContainer } | { ok: false; message: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return { ok: false, message: `the stored source is not JSON: ${String((e as Error).message).slice(0, 120)}` };
  }
  const r = raw as Partial<Record<keyof ScriptContainer, unknown>>;
  if (typeof raw !== 'object' || raw === null || r.graphVersion !== 1 || typeof r.entryPath !== 'string' || !Array.isArray(r.files)) {
    return { ok: false, message: 'the stored source is not a source-graph container' };
  }
  const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
  const files: ScriptFile[] = [];
  for (const f of r.files as unknown[]) {
    const ff = f as { path?: unknown; text?: unknown };
    if (typeof ff?.path !== 'string' || typeof ff.text !== 'string') return { ok: false, message: 'a file entry needs a path and a text' };
    files.push({ path: ff.path, text: ff.text });
  }
  return {
    ok: true,
    container: { graphVersion: 1, entryPath: r.entryPath, requiredModules: strings(r.requiredModules), ownedTransforms: strings(r.ownedTransforms), files: files.sort(byPath) },
  };
}

/**
 * A new behavior's starting source: declares one example property in code (a
 * behavior declares 0..32) and a `step` that does nothing yet.
 * The declaration already published for the behavior is kept when it exists:
 * then no property is declared in code.
 */
export function newScript(hasDeclaration: boolean): ScriptContainer {
  const text = [
    `import type { BehaviorContext } from '${API_MODULE}';`,
    '',
    ...(hasDeclaration
      ? ['// The properties are the declaration beside the code (or declare them here:', '// export const properties = { speed: property.number(1, { min: 0 }) };).']
      : ['export const properties = {', '  speed: property.number(1, { min: 0 }),', '};']),
    '',
    'export default {',
    '  step(_state: unknown, ctx: BehaviorContext) {',
    "    if (ctx.phase !== 'intent') return;",
    '  },',
    '};',
    '',
  ].join('\n');
  return { graphVersion: 1, entryPath: ENTRY_PATH, requiredModules: [API_MODULE], ownedTransforms: [], files: [{ path: ENTRY_PATH, text }] };
}

/** Why a file name is refused (`null` = acceptable). */
export function pathProblem(path: string, container: ScriptContainer, except?: string): string | null {
  if (path.length === 0) return 'a file needs a name';
  // Phase 23.7: `.json` files are data modules (`import data from './data.json'`).
  if (!path.endsWith('.ts') && !path.endsWith('.json')) return 'a script file ends in .ts (or .json for data)';
  if (!PATH_RE.test(path)) return 'use lower-case letters, digits, "-", "_", "." and "/" folders (e.g. src/util.ts)';
  if (path.length > 128) return 'the name is too long';
  if (container.files.some((f) => f.path === path && f.path !== except)) return `${path} already exists`;
  return null;
}

type Edit = { ok: true; container: ScriptContainer } | { ok: false; message: string };

export function addFile(c: ScriptContainer, path: string, text = 'export {};\n'): Edit {
  if (c.files.length >= MAX_FILES) return { ok: false, message: `a behavior has at most ${MAX_FILES} files` };
  const problem = pathProblem(path, c);
  if (problem !== null) return { ok: false, message: problem };
  return { ok: true, container: { ...c, files: [...c.files, { path, text }].sort(byPath) } };
}

export function renameFile(c: ScriptContainer, from: string, to: string): Edit {
  if (from === c.entryPath) return { ok: false, message: `${c.entryPath} is the entry file; it cannot be renamed` };
  if (!c.files.some((f) => f.path === from)) return { ok: false, message: `${from} does not exist` };
  if (from === to) return { ok: true, container: c };
  const problem = pathProblem(to, c, from);
  if (problem !== null) return { ok: false, message: problem };
  return { ok: true, container: { ...c, files: c.files.map((f) => (f.path === from ? { path: to, text: f.text } : f)).sort(byPath) } };
}

export function deleteFile(c: ScriptContainer, path: string): Edit {
  if (path === c.entryPath) return { ok: false, message: `${c.entryPath} is the entry file; it cannot be deleted` };
  if (!c.files.some((f) => f.path === path)) return { ok: false, message: `${path} does not exist` };
  return { ok: true, container: { ...c, files: c.files.filter((f) => f.path !== path) } };
}

export function setFileText(c: ScriptContainer, path: string, text: string): ScriptContainer {
  return { ...c, files: c.files.map((f) => (f.path === path ? { path, text } : f)) };
}

/** The owned-transforms list from its comma-separated text (`@self` = the carrying entity). */
export function ownedTransformsOf(text: string): string[] {
  return [...new Set(text.split(',').map((s) => s.trim()).filter((s) => s.length > 0))].sort();
}

// ---- completion ------------------------------------------------------------

export interface ApiMember {
  name: string;
  kind: 'property' | 'method';
  detail: string;
  type?: string;
  returns?: string;
  optional?: true;
  doc?: string;
}

/** The type key an identifier names: an annotation `name: Type` in the text, else `ctx` → the context. */
export function typeOfIdentifier(name: string, text: string, types: Readonly<Record<string, readonly ApiMember[]>>): string | null {
  const escaped = name.replace(/[$]/g, '\\$');
  const re = new RegExp(`(?:^|[^\\w$.])${escaped}\\s*\\??\\s*:\\s*([A-Za-z_$][\\w$]*)`, 'g');
  for (const m of text.matchAll(re)) {
    const t = m[1] as string;
    if (types[t] !== undefined) return t;
  }
  // Phase 25.11: a spec method's parameter by its position (`onTriggerEnter(state, event, ctx)`: `event` is
  // the trigger event), from the method's signature in the table.
  for (const m of types[SPEC_TYPE] ?? []) {
    if (m.kind !== 'method') continue;
    const params = parameterTypesOf(m.detail);
    for (const call of text.matchAll(new RegExp(`(?:^|[^\\w$.])${m.name}\\s*\\(([^()]*)\\)\\s*(?::[^{]*)?\\{`, 'g'))) {
      const at = (call[1] as string).split(',').map((p) => p.trim().replace(/[?:=].*$/s, '').trim()).indexOf(name);
      const t = at < 0 ? undefined : params[at];
      if (t !== undefined && types[t] !== undefined) return t;
    }
  }
  // The documented convention: `step(state, ctx)` — `ctx` is the behavior context.
  if (name === 'ctx' && types['BehaviorContext'] !== undefined) return 'BehaviorContext';
  return null;
}

/** Phase 25.11: the type key of the behavior spec (`export default { … }`) in the member table. */
export const SPEC_TYPE = 'BehaviorSpec';

/** The parameter types of a method's signature text (`(state: State, event: X): void` → State, X). */
function parameterTypesOf(detail: string): string[] {
  const m = /^\(([^()]*)\)/.exec(detail);
  if (m === null || (m[1] as string).trim() === '') return [];
  return (m[1] as string).split(',').map((p) => p.slice(p.indexOf(':') + 1).trim());
}

/**
 * Phase 25.11: the spec members to complete when the cursor is at a member
 * name directly inside the script's `export default { … }` (`onTri` →
 * `onTriggerEnter`, …). `textBefore` is the whole text up to the cursor.
 * Null elsewhere (a nested object, a statement, a string or comment).
 */
export function specMemberCompletion(textBefore: string, types: Readonly<Record<string, readonly ApiMember[]>>): { prefix: string; members: readonly ApiMember[] } | null {
  const members = types[SPEC_TYPE];
  if (members === undefined) return null;
  const start = textBefore.lastIndexOf('export default {');
  if (start < 0) return null;
  const m = /(?:^|[{,])\s*([A-Za-z_$][\w$]*)?$/.exec(textBefore.slice(start + 'export default {'.length));
  if (m === null) return null;
  // Depth 0 inside the literal: count braces outside strings and comments.
  const body = textBefore.slice(start + 'export default {'.length, textBefore.length - (m[1]?.length ?? 0));
  let depth = 0;
  for (let i = 0; i < body.length; i += 1) {
    const c = body[i]!;
    if (c === '/' && body[i + 1] === '/') {
      const nl = body.indexOf('\n', i);
      if (nl < 0) return null;
      i = nl;
    } else if (c === '/' && body[i + 1] === '*') {
      const end = body.indexOf('*/', i + 2);
      if (end < 0) return null;
      i = end + 1;
    } else if (c === "'" || c === '"' || c === '`') {
      let j = i + 1;
      while (j < body.length && body[j] !== c) j += body[j] === '\\' ? 2 : 1;
      if (j >= body.length) return null;
      i = j;
    } else if (c === '{') depth += 1;
    else if (c === '}') {
      depth -= 1;
      if (depth < 0) return null;
    }
  }
  if (depth !== 0) return null;
  const prefix = m[1] ?? '';
  return { prefix, members: members.filter((x) => x.name.startsWith(prefix)) };
}

/**
 * Members to complete after `before` (the line up to the cursor), e.g.
 * `ctx.game.a` → the members of the game state starting from `a`. `null`
 * when the text before the cursor is not a member access the table knows.
 */
export function memberCompletion(
  before: string,
  text: string,
  types: Readonly<Record<string, readonly ApiMember[]>>,
): { prefix: string; members: readonly ApiMember[] } | null {
  const m = /([A-Za-z_$][\w$]*)((?:\??\.[A-Za-z_$][\w$]*(?:\([^()]*\))?)*)\??\.([A-Za-z_$][\w$]*)?$/.exec(before);
  if (m === null) return null;
  // Not a member of something else (`a.ctx.` is not the context).
  const start = m.index;
  if (start > 0 && /[\w$.]/.test(before[start - 1] as string)) return null;
  let key = typeOfIdentifier(m[1] as string, text, types);
  if (key === null) return null;
  const chain = (m[2] ?? '').split(/\??\./).filter((s) => s.length > 0);
  for (const seg of chain) {
    const call = seg.endsWith(')');
    const name = call ? seg.slice(0, seg.indexOf('(')) : seg;
    const member: ApiMember | undefined = types[key]?.find((x) => x.name === name);
    if (member === undefined) return null;
    const next: string | undefined = call ? member.returns : member.type;
    if (next === undefined || types[next] === undefined) return null;
    key = next;
  }
  const prefix = m[3] ?? '';
  const members = types[key] ?? [];
  return { prefix, members: members.filter((x) => x.name.startsWith(prefix)) };
}

/** The type names the typings export (`export interface X` / `type X` / `const X`). */
export function exportedTypeNames(dts: string): string[] {
  return [...new Set([...dts.matchAll(/\bexport\s+(?:interface|type|const|enum)\s+([A-Za-z_$][\w$]*)/g)].map((m) => m[1] as string))].sort();
}

// ---- phase 23.7: script libraries ---------------------------------------------

/** The import prefix of a script library (`import { x } from '@lib/<id>'`). */
export const LIBRARY_IMPORT_PREFIX = '@lib/';

/** A new library's starting files: an entry that exports one example. */
export function newLibraryFiles(libraryId: string): ScriptFile[] {
  return [
    {
      path: ENTRY_PATH,
      // No import statement in the comment: the compiler's import scan is textual (a comment counts).
      text: [`// Shared code for every script of this project (its module name is @lib/${libraryId}).`, '','export function clamp(value: number, min: number, max: number): number {', '  return Math.min(max, Math.max(min, value));', '}', ''].join('\n'),
    },
  ];
}

/**
 * The `setScriptLibrary` file patch that turns the stored files into the
 * draft: changed and new files with their text, removed ones with `null`
 * (unchanged files are not sent, so an edit stays small).
 */
export function libraryFilePatch(stored: readonly ScriptFile[], draft: readonly ScriptFile[]): { path: string; text: string | null }[] {
  const before = new Map(stored.map((f) => [f.path, f.text] as const));
  const out: { path: string; text: string | null }[] = [];
  for (const f of [...draft].sort(byPath)) if (before.get(f.path) !== f.text) out.push({ path: f.path, text: f.text });
  const kept = new Set(draft.map((f) => f.path));
  for (const f of [...stored].sort(byPath)) if (!kept.has(f.path)) out.push({ path: f.path, text: null });
  return out;
}

/** Phase 25.9: one staged library patch (a file may come in pieces: `append`). */
export interface LibraryStagePatch {
  libraryId: string;
  files: { path: string; text: string | null; append?: true }[];
}

/**
 * Phase 25.9: the request budget of one patch's files (JSON bytes). A
 * command or stage request is capped at 64 KiB; this leaves room for the
 * envelope.
 */
export const LIBRARY_PATCH_BUDGET = 40 * 1024;

const jsonBytes = (v: unknown): number => new TextEncoder().encode(JSON.stringify(v)).length;

/** True when a library patch fits one ordinary `setScriptLibrary` request. */
export function fitsOneRequest(files: readonly { path: string; text: string | null }[]): boolean {
  return jsonBytes(files) <= LIBRARY_PATCH_BUDGET;
}

/**
 * Phase 25.9: a library patch cut into stage patches that each fit one
 * request: files are packed in order; a file too large for one request is
 * split into pieces (its first piece replaces the file, the rest append).
 * Staged in this order and committed once, they give exactly `files`.
 */
export function libraryStagePatches(libraryId: string, files: readonly { path: string; text: string | null }[], budget = LIBRARY_PATCH_BUDGET): LibraryStagePatch[] {
  const out: LibraryStagePatch[] = [];
  let current: LibraryStagePatch['files'] = [];
  const flush = (): void => {
    if (current.length > 0) out.push({ libraryId, files: current });
    current = [];
  };
  const add = (entry: LibraryStagePatch['files'][number]): void => {
    if (current.length > 0 && jsonBytes([...current, entry]) > budget) flush();
    current.push(entry);
  };
  for (const f of files) {
    if (f.text === null || jsonBytes([f]) <= budget) {
      add(f);
      continue;
    }
    // Split by characters so that each piece's JSON stays under the budget (escapes counted).
    let rest = f.text;
    let first = true;
    while (rest.length > 0) {
      let n = Math.min(rest.length, Math.floor(budget / 2));
      while (n > 1 && jsonBytes([{ path: f.path, text: rest.slice(0, n), append: true }]) > budget) n = Math.floor(n * 0.8);
      // Never cut a surrogate pair in two.
      const code = rest.charCodeAt(n - 1);
      if (n < rest.length && code >= 0xd800 && code <= 0xdbff) n -= 1;
      const piece = rest.slice(0, n);
      rest = rest.slice(n);
      flush();
      current.push(first ? { path: f.path, text: piece } : { path: f.path, text: piece, append: true });
      first = false;
    }
  }
  flush();
  return out;
}

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

/** The entry file every container has (project-model §22.2). */
export const ENTRY_PATH = 'src/index.ts';
/** The compiler's file-count bound (behavior-build `COMPILER_LIMITS.files`). */
export const MAX_FILES = 16;
/** The compiler's per-file byte bound (`COMPILER_LIMITS.fileBytes`). */
export const MAX_FILE_BYTES = 65_536;
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
  if (!path.endsWith('.ts')) return 'a script file ends in .ts';
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
  // The documented convention: `step(state, ctx)` — `ctx` is the behavior context.
  if (name === 'ctx' && types['BehaviorContext'] !== undefined) return 'BehaviorContext';
  return null;
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

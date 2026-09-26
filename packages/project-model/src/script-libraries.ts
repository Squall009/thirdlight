/**
 * Phase 23.7: shared script libraries (`content.scriptLibraries[]`, v4).
 *
 * A script library is TypeScript (and JSON data) that any behavior imports
 * with `import { … } from '@lib/<libraryId>'` — shared rules, tables and
 * helpers written once instead of copied into every behavior. Its files are
 * project data stored inline (edited in the script editor, created and
 * changed with `setScriptLibrary` / `deleteScriptLibrary`, one undo step
 * each); the library as a whole has a digest — the sha256 of its canonical
 * source-graph container (`scriptLibraryContainerText`, the same container
 * format and bounds as a behavior source) — and that digest goes through the
 * same per-digest trust acknowledgment as a behavior source before code
 * that imports it is compiled.
 *
 * A published behavior that imports libraries records which library
 * versions it was compiled against (`BehaviorSourceRecord.libraries`, the
 * pins), so a library change republishes its dependents in the same command
 * (their records move together with the library, and undo restores both).
 * The game never reads libraries: their code is bundled into each
 * dependent's compiled output.
 *
 * Pure data rules; the compiler lives in behavior-build.
 */
import type { ModelErrorV2 } from './errors';
import { sha256HexOfText } from './sha256';

export interface ScriptLibraryFile {
  /** A container path, e.g. `src/index.ts` or `src/data/items.json`. */
  path: string;
  text: string;
}

export interface ScriptLibrary {
  /** The id behaviors import it by (`@lib/<libraryId>`). */
  libraryId: string;
  /** Shown in the editor. */
  name: string;
  /** Its files; `src/index.ts` is the module an import names. */
  files: ScriptLibraryFile[];
}

/** One library version a published behavior was compiled against. */
export interface BehaviorLibraryPin {
  libraryId: string;
  /** The library's digest (`scriptLibraryDigest`) at publication. */
  sourceDigest: string;
}

/** The import prefix: `@lib/<libraryId>` names a library's `src/index.ts`. */
export const SCRIPT_LIBRARY_IMPORT_PREFIX = '@lib/';
/** The module an import of a library resolves to. */
export const SCRIPT_LIBRARY_ENTRY = 'src/index.ts';

/**
 * Bounds. A library has a behavior source's bounds (16 files, 64 KiB per
 * file, 256 KiB per container — the compiler's limits); a project keeps at
 * most 32 libraries and 1 MiB of library text in total, since libraries are
 * stored inline in the content document.
 */
export const SCRIPT_LIBRARY_LIMITS = Object.freeze({
  libraries: 32,
  files: 16,
  fileBytes: 65_536,
  containerBytes: 262_144,
  totalBytes: 1_048_576,
});

const ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const PATH_RE = /^[a-z0-9][a-z0-9._-]*(\/[a-z0-9][a-z0-9._-]*)*$/;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
function err(errors: ModelErrorV2[], code: string, path: string, message: string, found?: unknown, expected?: string): void {
  errors.push({ code, path, message, ...(found !== undefined ? { found } : {}), ...(expected !== undefined ? { expected } : {}) } as ModelErrorV2);
}
const byPath = (a: ScriptLibraryFile, b: ScriptLibraryFile): number => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
const utf8Length = (s: string): number => new TextEncoder().encode(s).length;

/** Why a library file path is refused (`null` = acceptable). Shared with the editor. */
export function scriptLibraryPathProblem(path: string): string | null {
  if (path.length < 1 || path.length > 128) return 'a file path has 1-128 characters';
  if (!PATH_RE.test(path)) return 'use lower-case letters, digits, "-", "_", "." and "/" folders (e.g. src/util.ts)';
  if (!path.endsWith('.ts') && !path.endsWith('.json')) return 'a library file ends in .ts or .json';
  return null;
}

/**
 * The canonical source-graph container of a library (the bytes its digest
 * covers and the compiler reads): the behavior container format with no
 * required modules and no owned transforms (a library moves nothing itself;
 * its type-only engine imports are allowed without a list).
 */
export function scriptLibraryContainerText(lib: Pick<ScriptLibrary, 'files'>): string {
  const out = {
    graphVersion: 1,
    entryPath: SCRIPT_LIBRARY_ENTRY,
    requiredModules: [] as string[],
    ownedTransforms: [] as string[],
    files: [...lib.files].sort(byPath).map((f) => ({ path: f.path, text: f.text })),
  };
  return `${JSON.stringify(out, null, 2)}\n`;
}

/** The library's digest: sha256 of its canonical container (the trust and pin identity). */
export function scriptLibraryDigest(lib: Pick<ScriptLibrary, 'files'>): string {
  return sha256HexOfText(scriptLibraryContainerText(lib));
}

/** One library: id, name, 1-16 files with unique valid paths, `src/index.ts` present, byte bounds. */
export function validateScriptLibrary(value: unknown, path: string, errors: ModelErrorV2[]): void {
  if (!isPlainObject(value)) return err(errors, 'field_type', path, 'a script library is an object { libraryId, name, files }', value, 'object');
  for (const k of Object.keys(value)) if (!['libraryId', 'name', 'files'].includes(k)) err(errors, 'field_unexpected', `${path}/${k}`, `unknown script library field "${k}"`, k, 'libraryId, name, files');
  const id = value['libraryId'];
  if (typeof id !== 'string' || !ID_RE.test(id)) err(errors, 'id_invalid', `${path}/libraryId`, 'libraryId uses the id syntax [a-z0-9][a-z0-9_-]{0,63}', id, 'an id');
  const name = value['name'];
  if (typeof name !== 'string' || name.length < 1 || name.length > 64 || /[\u0000-\u001f\u007f]/.test(name)) err(errors, 'field_value', `${path}/name`, 'a library name has 1-64 characters', name, '1-64 characters');
  const files = value['files'];
  if (!Array.isArray(files)) return err(errors, 'field_type', `${path}/files`, 'files is a list of { path, text }', files, 'array');
  if (files.length < 1 || files.length > SCRIPT_LIBRARY_LIMITS.files) {
    err(errors, 'limits_exceeded', `${path}/files`, `a library has 1-${SCRIPT_LIBRARY_LIMITS.files} files`, files.length, `1-${SCRIPT_LIBRARY_LIMITS.files}`);
  }
  const seen = new Set<string>();
  let ok = true;
  files.forEach((f, i) => {
    const fp = `${path}/files/${i}`;
    if (!isPlainObject(f)) {
      ok = false;
      return err(errors, 'field_type', fp, 'a library file is { path, text }', f, 'object');
    }
    for (const k of Object.keys(f)) if (k !== 'path' && k !== 'text') err(errors, 'field_unexpected', `${fp}/${k}`, `unknown library file field "${k}"`, k, 'path, text');
    const p = f['path'];
    const t = f['text'];
    if (typeof p !== 'string') {
      ok = false;
      err(errors, 'field_type', `${fp}/path`, 'a file path is a string', p, 'string');
    } else {
      const problem = scriptLibraryPathProblem(p);
      if (problem !== null) err(errors, 'field_value', `${fp}/path`, problem, p, 'a container path ending in .ts or .json');
      if (seen.has(p)) err(errors, 'id_duplicate', `${fp}/path`, `the file ${p} appears twice`, p);
      seen.add(p);
    }
    if (typeof t !== 'string') {
      ok = false;
      err(errors, 'field_type', `${fp}/text`, 'a file text is a string', t, 'string');
    } else if (utf8Length(t) > SCRIPT_LIBRARY_LIMITS.fileBytes) {
      err(errors, 'limits_exceeded', `${fp}/text`, `a library file has at most ${SCRIPT_LIBRARY_LIMITS.fileBytes} bytes`, utf8Length(t), `<= ${SCRIPT_LIBRARY_LIMITS.fileBytes}`);
    }
  });
  if (!seen.has(SCRIPT_LIBRARY_ENTRY)) err(errors, 'field_missing', `${path}/files`, `a library has the entry file ${SCRIPT_LIBRARY_ENTRY} (what an import of @lib/<id> names)`, undefined, SCRIPT_LIBRARY_ENTRY);
  if (ok) {
    const bytes = utf8Length(scriptLibraryContainerText({ files: files as ScriptLibraryFile[] }));
    if (bytes > SCRIPT_LIBRARY_LIMITS.containerBytes) {
      err(errors, 'limits_exceeded', `${path}/files`, `a library's source has at most ${SCRIPT_LIBRARY_LIMITS.containerBytes} bytes`, bytes, `<= ${SCRIPT_LIBRARY_LIMITS.containerBytes}`);
    }
  }
}

/** `content.scriptLibraries`: at most 32 libraries with unique ids and 1 MiB of text in total. */
export function validateScriptLibraries(value: unknown, path: string, errors: ModelErrorV2[]): void {
  if (!Array.isArray(value)) return err(errors, 'field_type', path, 'scriptLibraries is a list', value, 'array of script libraries');
  if (value.length > SCRIPT_LIBRARY_LIMITS.libraries) err(errors, 'limits_exceeded', path, `a project has at most ${SCRIPT_LIBRARY_LIMITS.libraries} script libraries`, value.length, `<= ${SCRIPT_LIBRARY_LIMITS.libraries}`);
  const seen = new Set<string>();
  let total = 0;
  value.forEach((l, i) => {
    validateScriptLibrary(l, `${path}/${i}`, errors);
    if (!isPlainObject(l)) return;
    const id = l['libraryId'];
    if (typeof id === 'string') {
      if (seen.has(id)) err(errors, 'id_duplicate', `${path}/${i}/libraryId`, 'libraryId is used twice', id);
      seen.add(id);
    }
    if (Array.isArray(l['files'])) for (const f of l['files'] as unknown[]) if (isPlainObject(f) && typeof f['text'] === 'string') total += utf8Length(f['text']);
  });
  if (total > SCRIPT_LIBRARY_LIMITS.totalBytes) err(errors, 'limits_exceeded', path, `the script libraries hold at most ${SCRIPT_LIBRARY_LIMITS.totalBytes} bytes of text in total`, total, `<= ${SCRIPT_LIBRARY_LIMITS.totalBytes}`);
}

export function canonicalScriptLibrary(l: ScriptLibrary): ScriptLibrary {
  return { libraryId: l.libraryId, name: l.name, files: [...l.files].sort(byPath).map((f) => ({ path: f.path, text: f.text })) };
}

export function canonicalScriptLibraries(list: readonly ScriptLibrary[]): ScriptLibrary[] {
  return [...list].sort((a, b) => (a.libraryId < b.libraryId ? -1 : a.libraryId > b.libraryId ? 1 : 0)).map(canonicalScriptLibrary);
}

/** A behavior source record's pins: 1-32 `{libraryId, sourceDigest}`, ascending unique ids. */
export function validateLibraryPins(value: unknown, path: string, errors: ModelErrorV2[]): void {
  if (!Array.isArray(value) || value.length < 1 || value.length > SCRIPT_LIBRARY_LIMITS.libraries) {
    return err(errors, 'field_value', path, `libraries is absent or lists 1-${SCRIPT_LIBRARY_LIMITS.libraries} library pins`, value, `1-${SCRIPT_LIBRARY_LIMITS.libraries} { libraryId, sourceDigest }`);
  }
  value.forEach((p, i) => {
    const pp = `${path}/${i}`;
    if (!isPlainObject(p)) return err(errors, 'field_type', pp, 'a library pin is { libraryId, sourceDigest }', p, 'object');
    for (const k of Object.keys(p)) if (k !== 'libraryId' && k !== 'sourceDigest') err(errors, 'field_unexpected', `${pp}/${k}`, `unknown library pin field "${k}"`, k, 'libraryId, sourceDigest');
    const id = p['libraryId'];
    if (typeof id !== 'string' || !ID_RE.test(id)) err(errors, 'id_invalid', `${pp}/libraryId`, 'a pin names a library id', id, 'an id');
    else if (i > 0 && isPlainObject(value[i - 1]) && typeof (value[i - 1] as Record<string, unknown>)['libraryId'] === 'string' && ((value[i - 1] as Record<string, unknown>)['libraryId'] as string) >= id) {
      err(errors, 'field_value', `${pp}/libraryId`, 'library pins are ascending and unique by libraryId', id, 'ascending unique ids');
    }
    const d = p['sourceDigest'];
    if (typeof d !== 'string' || !/^[0-9a-f]{64}$/.test(d)) err(errors, 'digest_invalid', `${pp}/sourceDigest`, 'a pin digest is 64 lowercase hex', d, '64 lowercase hex');
  });
}

/**
 * The behaviors whose published source pins a library (the ones a change of
 * it republishes and a deletion is refused for), in behavior order.
 */
export function scriptLibraryDependents(
  behaviors: readonly { behaviorId: string; source: { libraries?: readonly BehaviorLibraryPin[] } | null }[],
  libraryId: string,
): string[] {
  return behaviors.filter((b) => b.source?.libraries?.some((p) => p.libraryId === libraryId) === true).map((b) => b.behaviorId);
}

/**
 * A stable key of a whole library set (every library's id and digest): the
 * preparation layer files the dependents it compiled for a proposed set
 * under it, and the command finds them by the set it is about to commit.
 */
export function scriptLibrarySetKey(libraries: readonly Pick<ScriptLibrary, 'libraryId' | 'files'>[]): string {
  const lines = [...libraries]
    .sort((a, b) => (a.libraryId < b.libraryId ? -1 : a.libraryId > b.libraryId ? 1 : 0))
    .map((l) => `${l.libraryId}=${scriptLibraryDigest(l)}\n`)
    .join('');
  return sha256HexOfText(lines);
}

/** The `setScriptLibrary` args: a patch (unmentioned files are kept; `text: null` removes one). */
export interface ScriptLibraryPatch {
  libraryId: string;
  /** Required when the library is new. */
  name?: string;
  files?: { path: string; text: string | null }[];
}

/**
 * Apply a `setScriptLibrary` patch to the current library (`null` = new): the
 * one rule the command and the backend's dependent preparation share, so
 * both derive the same next library (and so the same library set key).
 * Structural only — the result is validated by `validateScriptLibrary`.
 */
export function applyScriptLibraryPatch(previous: ScriptLibrary | null, patch: ScriptLibraryPatch): { ok: true; library: ScriptLibrary } | { ok: false; path: string; message: string } {
  if (previous === null && patch.name === undefined) return { ok: false, path: '/args/name', message: 'a new script library needs a name' };
  const files = new Map<string, string>((previous?.files ?? []).map((f) => [f.path, f.text] as const));
  const seen = new Set<string>();
  for (const [i, f] of (patch.files ?? []).entries()) {
    if (seen.has(f.path)) return { ok: false, path: `/args/files/${i}/path`, message: `the file ${f.path} appears twice in the patch` };
    seen.add(f.path);
    if (f.text === null) {
      if (!files.has(f.path)) return { ok: false, path: `/args/files/${i}/path`, message: `the library has no file ${f.path} to remove` };
      files.delete(f.path);
    } else files.set(f.path, f.text);
  }
  return {
    ok: true,
    library: canonicalScriptLibrary({
      libraryId: patch.libraryId,
      name: patch.name ?? (previous as ScriptLibrary).name,
      files: [...files].map(([path, text]) => ({ path, text })),
    }),
  };
}

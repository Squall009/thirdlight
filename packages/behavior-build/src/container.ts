/**
 * The canonical source-graph container parse and the static source rules
 * (project-model.md §22.1, §22.3, §22.3.3 steps 1–7).
 *
 * Steps owned here: strict parse + unknown-field rejection + canonical-form
 * check (`container`), lone-surrogate rejection (`encoding`), `graphVersion`,
 * `entryPath`/`entry_missing`, per-path grammar and `.ts` extension, ascending
 * order, duplicate paths and the step-7 bounds (phase 23.7: `.json` data
 * files are accepted beside `.ts`). Nothing here is executed: the
 * container is data and is parsed with the accepted strict byte parser.
 */

import { parseDocumentBytes } from '@thirdlight/project-model';
import type { CompileDiagnostic, BehaviorCompileFailure, BehaviorCompilerLimits, SourceGraphContainer, SourceGraphFile } from './types';
import { COMPILER_LIMITS, ENTRY_PATH } from './limits';
import { utf8Decode } from './canonical';
import { compareCodePoints } from './canonical';

/** §22.1 rule 2: stored-path grammar. */
const PATH_RE = /^[a-z0-9][a-z0-9._-]*(\/[a-z0-9][a-z0-9._-]*)*$/;
/**
 * Phase 14.1: the `ownedTransforms` entry that means "the entity carrying this
 * behavior" — each instance may move its own entity (a spawned copy included,
 * whose runtime id is not known when the script is published). The runtime's
 * `BEHAVIOR_SELF_OWNER` is the same token.
 */
const SELF_OWNER = '@self';
const KNOWN_CONTAINER_FIELDS = new Set(['graphVersion', 'entryPath', 'requiredModules', 'ownedTransforms', 'files']);
const KNOWN_FILE_FIELDS = new Set(['path', 'text']);
/** project-model.md §5.1 ID syntax (reused for `ownedTransforms` entries). */
const ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export interface ContainerParseOk {
  ok: true;
  container: SourceGraphContainer;
  fileByteLengths: { path: string; byteLength: number }[];
}

export type ContainerParseResult = ContainerParseOk | { ok: false; failure: BehaviorCompileFailure };

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function hasLoneSurrogate(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = i + 1 < s.length ? s.charCodeAt(i + 1) : 0;
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      i += 1;
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      return true;
    }
  }
  return false;
}

/** The canonical container bytes (2-space JSON in the §22.1 field order + `\n`). */
export function canonicalContainerText(container: SourceGraphContainer): string {
  const out = {
    graphVersion: container.graphVersion,
    entryPath: container.entryPath,
    requiredModules: container.requiredModules,
    ownedTransforms: container.ownedTransforms,
    files: container.files.map((f) => ({ path: f.path, text: f.text })),
  };
  return `${JSON.stringify(out, null, 2)}\n`;
}

/** Convert a step failure into the shared `BehaviorCompileFailure` shape. */
export function containerFailure(
  code: string,
  reason: string,
  extra: { limit?: string; current?: number; max?: number; detail?: string; path?: string; message?: string } = {},
): { ok: false; failure: BehaviorCompileFailure } {
  const diag: CompileDiagnostic = {
    code,
    reason,
    message: (extra.message ?? `${code} (${reason})`).slice(0, 256),
  };
  if (extra.path !== undefined) diag.path = extra.path;
  const failure: BehaviorCompileFailure = { ok: false, code, reason, diagnostics: [diag] };
  if (extra.limit !== undefined) failure.limit = extra.limit;
  if (extra.current !== undefined) failure.current = extra.current;
  if (extra.max !== undefined) failure.max = extra.max;
  if (extra.detail !== undefined) failure.detail = extra.detail;
  return { ok: false, failure };
}

/**
 * Parse and validate the container bytes (steps 1–7). `limits` may override
 * the M2 defaults; the returned failure is the first violation in the
 * normative order.
 */
export function parseSourceGraphContainer(
  containerBytes: Uint8Array,
  limits: BehaviorCompilerLimits = COMPILER_LIMITS,
): ContainerParseResult {
  // Step 7's `graph_bytes` pre-check: the raw container bytes are bounded
  // before the file text they hold is parsed (project-model.md §22.4).
  if (containerBytes.length > limits.graphBytes) {
    return containerFailure('behavior_source_limits_exceeded', 'graph_bytes', {
      limit: 'graph_bytes',
      current: containerBytes.length,
      max: limits.graphBytes,
      message: 'the staged container exceeds the total graph byte bound',
    });
  }
  // Step 1: strict parse (encoding → container).
  const parsed = parseDocumentBytes(containerBytes);
  if (!parsed.ok) {
    const reason = parsed.error.code === 'encoding_invalid' ? 'encoding' : 'container';
    return containerFailure('behavior_source_invalid', reason, {
      path: parsed.error.path,
      message: `the source-graph container is not accepted: ${parsed.error.message}`,
    });
  }
  const raw = parsed.value;
  if (!isPlainObject(raw)) {
    return containerFailure('behavior_source_invalid', 'container', {
      message: 'the source-graph container must be a JSON object',
    });
  }
  for (const key of Object.keys(raw)) {
    if (!KNOWN_CONTAINER_FIELDS.has(key)) {
      return containerFailure('behavior_source_invalid', 'container', {
        path: `/${key}`,
        message: `unknown container field "${key}" (unknown fields are invalid, never stripped)`,
      });
    }
  }
  // Encoding: an unpaired surrogate can only enter through a `\uXXXX` escape.
  const strings: [string, string][] = [];
  const entry = raw['entryPath'];
  if (typeof entry === 'string') strings.push(['/entryPath', entry]);
  for (const key of ['requiredModules', 'ownedTransforms'] as const) {
    const arr = raw[key];
    if (Array.isArray(arr)) {
      arr.forEach((v, i) => {
        if (typeof v === 'string') strings.push([`/${key}/${i}`, v]);
      });
    }
  }
  const filesRaw = raw['files'];
  if (Array.isArray(filesRaw)) {
    filesRaw.forEach((f, i) => {
      if (isPlainObject(f)) {
        if (typeof f['path'] === 'string') strings.push([`/files/${i}/path`, f['path'] as string]);
        if (typeof f['text'] === 'string') strings.push([`/files/${i}/text`, f['text'] as string]);
      }
    });
  }
  for (const [path, s] of strings) {
    if (hasLoneSurrogate(s)) {
      return containerFailure('behavior_source_invalid', 'encoding', {
        path,
        message: 'an unpaired UTF-16 surrogate is not valid container text',
      });
    }
  }
  // Step 2: graphVersion.
  if (raw['graphVersion'] !== 1) {
    return containerFailure('behavior_source_invalid', 'graph_version', {
      path: '/graphVersion',
      message: 'graphVersion must be exactly 1 (no forward compatibility)',
    });
  }
  // Schema: entryPath, requiredModules, ownedTransforms, files.
  if (typeof raw['entryPath'] !== 'string') {
    return containerFailure('behavior_source_invalid', 'container', { path: '/entryPath', message: 'entryPath must be a string' });
  }
  for (const key of ['requiredModules', 'ownedTransforms'] as const) {
    const arr = raw[key];
    if (!Array.isArray(arr) || arr.some((v) => typeof v !== 'string')) {
      return containerFailure('behavior_source_invalid', 'container', { path: `/${key}`, message: `${key} must be an array of strings` });
    }
  }
  if (!Array.isArray(filesRaw)) {
    return containerFailure('behavior_source_invalid', 'container', { path: '/files', message: 'files must be an array' });
  }
  const files: SourceGraphFile[] = [];
  for (let i = 0; i < filesRaw.length; i++) {
    const f = filesRaw[i];
    if (!isPlainObject(f)) {
      return containerFailure('behavior_source_invalid', 'container', { path: `/files/${i}`, message: 'a file entry must be an object' });
    }
    for (const key of Object.keys(f)) {
      if (!KNOWN_FILE_FIELDS.has(key)) {
        return containerFailure('behavior_source_invalid', 'container', {
          path: `/files/${i}/${key}`,
          message: `unknown file field "${key}"`,
        });
      }
    }
    if (typeof f['path'] !== 'string' || typeof f['text'] !== 'string') {
      return containerFailure('behavior_source_invalid', 'container', {
        path: `/files/${i}`,
        message: 'a file entry is exactly { path, text } with string values',
      });
    }
    files.push({ path: f['path'], text: f['text'] });
  }
  const requiredModules = raw['requiredModules'] as string[];
  const ownedTransforms = raw['ownedTransforms'] as string[];
  const entryPath = raw['entryPath'];

  // Canonical form: the container bytes are the declaration of the source
  // graph, so the exact bytes must equal the canonical serialization.
  const canonical = canonicalContainerText({ graphVersion: 1, entryPath, requiredModules: [...requiredModules], ownedTransforms: [...ownedTransforms], files });
  let decoded: string;
  try {
    decoded = utf8Decode(containerBytes);
  } catch {
    return containerFailure('behavior_source_invalid', 'encoding', { message: 'the container bytes are not valid UTF-8' });
  }
  if (canonical !== decoded) {
    return containerFailure('behavior_source_invalid', 'container', {
      message: 'the container is not in canonical form (field order, unknown fields and whitespace are part of the bytes)',
    });
  }
  // Step 3: entryPath present and matching files.
  if (!files.some((f) => f.path === entryPath)) {
    return containerFailure('behavior_source_invalid', 'entry_missing', {
      detail: entryPath,
      message: `the entry file "${entryPath}" is not in files`,
    });
  }
  // Step 4: per-path grammar and `.ts` extension.
  for (const f of files) {
    if (f.path.length < 1 || f.path.length > 128 || !PATH_RE.test(f.path)) {
      return containerFailure('behavior_source_invalid', 'path', { path: f.path, detail: f.path, message: `stored path "${f.path}" violates the path grammar` });
    }
    // Phase 23.7: `.json` files are data modules (imported as their parsed value).
    if (!f.path.endsWith('.ts') && !f.path.endsWith('.json')) {
      return containerFailure('behavior_source_invalid', 'extension', { path: f.path, detail: f.path, message: `stored path "${f.path}" is not a .ts or .json file` });
    }
    if (f.path === entryPath && !f.path.endsWith('.ts')) {
      return containerFailure('behavior_source_invalid', 'extension', { path: f.path, detail: f.path, message: `the entry file "${f.path}" is not a .ts file` });
    }
  }
  // Step 5: ascending order (duplicates are step 6) and module/ownership order.
  for (let i = 1; i < files.length; i++) {
    if (compareCodePoints((files[i - 1] as SourceGraphFile).path, (files[i] as SourceGraphFile).path) > 0) {
      return containerFailure('behavior_source_invalid', 'file_order', { message: 'files must be in ascending path order' });
    }
  }
  for (const [name, arr] of [['requiredModules', requiredModules], ['ownedTransforms', ownedTransforms]] as const) {
    for (let i = 0; i < arr.length; i++) {
      if (typeof arr[i] !== 'string') {
        return containerFailure('behavior_source_invalid', 'container', { path: `/${name}/${i}`, message: `${name} must contain strings` });
      }
    }
    for (let i = 1; i < arr.length; i++) {
      const cmp = compareCodePoints(arr[i - 1] as string, arr[i] as string);
      if (cmp > 0) {
        return containerFailure('behavior_source_invalid', 'file_order', { path: `/${name}`, message: `${name} must be ascending` });
      }
      if (cmp === 0) {
        return containerFailure('behavior_source_invalid', 'duplicate', { path: `/${name}`, detail: arr[i] as string, message: `${name} must be unique` });
      }
    }
  }
  for (const id of ownedTransforms) {
    // Phase 14.1: "@self" (never an entity id) = each carrier's own transform.
    if (!ID_RE.test(id) && id !== SELF_OWNER) {
      return containerFailure('behavior_source_invalid', 'container', { path: '/ownedTransforms', detail: id, message: `ownedTransforms entry "${id}" is not an ID (or "@self")` });
    }
  }
  // Step 6: duplicate stored path.
  for (let i = 1; i < files.length; i++) {
    if ((files[i - 1] as SourceGraphFile).path === (files[i] as SourceGraphFile).path) {
      return containerFailure('behavior_source_duplicate', 'duplicate', { detail: (files[i] as SourceGraphFile).path, message: 'the same stored path appears twice' });
    }
  }
  // Step 7: bounds (files, per-file bytes, total graph bytes, ownedTransforms).
  if (files.length > limits.files) {
    return containerFailure('behavior_source_limits_exceeded', 'files', { limit: 'files', current: files.length, max: limits.files, message: 'the graph has too many files' });
  }
  if (ownedTransforms.length > limits.ownedTransforms) {
    return containerFailure('behavior_source_limits_exceeded', 'owned_transforms', {
      limit: 'owned_transforms',
      current: ownedTransforms.length,
      max: limits.ownedTransforms,
      message: 'the graph declares too many owned transforms',
    });
  }
  const fileByteLengths: { path: string; byteLength: number }[] = [];
  for (const f of files) {
    const byteLength = new TextEncoder().encode(f.text).length;
    if (byteLength > limits.fileBytes) {
      return containerFailure('behavior_source_limits_exceeded', 'file_bytes', {
        limit: 'file_bytes',
        current: byteLength,
        max: limits.fileBytes,
        path: f.path,
        message: `file "${f.path}" exceeds the per-file byte bound`,
      });
    }
    fileByteLengths.push({ path: f.path, byteLength });
  }
  if (containerBytes.length > limits.graphBytes) {
    return containerFailure('behavior_source_limits_exceeded', 'graph_bytes', {
      limit: 'graph_bytes',
      current: containerBytes.length,
      max: limits.graphBytes,
      message: 'the container exceeds the total graph byte bound',
    });
  }
  return {
    ok: true,
    container: { graphVersion: 1, entryPath, requiredModules: [...requiredModules], ownedTransforms: [...ownedTransforms], files },
    fileByteLengths,
  };
}

/** The fixed entry path constant, re-exported for hosts validating records. */
export const FIXED_ENTRY_PATH = ENTRY_PATH;

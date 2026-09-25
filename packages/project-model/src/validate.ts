/**
 * Shared value validation — project-model.md §12.3 passes 2–4 and §13.
 *
 * Holds the manifest (schemaVersion 1, the manifest of a storage-v3
 * project, still read by the automatic v3 → v4 upgrade), the shared field
 * helpers, the hierarchy cycle/depth checks and the component
 * canonicalizers the v3/v4 scene validators build on. The M1 standalone
 * scene model (schemaVersion 1) was removed in phase 9.3.
 *
 * Errors are collected, not fail-on-first, in a deterministic order.
 * Success returns the CANONICAL document (§12.2). Pure and total: never
 * reads/writes the filesystem, never throws on malformed data. `found`
 * values are always bounded and JSON-safe so an error payload serialized to
 * text never emits NaN/Infinity tokens (§12.7 R5).
 */

import {
  SCHEMA_VERSIONS_BY_DOCUMENT,
  type ModelError,
  type ModelErrorV2,
  type ModelResult,
} from './errors';

/** The error element type shared by the M1 (narrow) and v2 (extended) results. */
type AnyError = ModelError | ModelErrorV2;
import type {
  BoxComponent,
  CameraComponent,
  Manifest,
  TransformComponent,
  Vec3,
  Quat,
} from './types';

// ---- §5/§6/§7/§10 constants -------------------------------------------------

export const ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/; // §5.1
const SEMVER_RE = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/; // §6
const TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/; // §7.2
const M1_SCENE_PATH = 'scenes/main.json'; // §3/§5.3/§7.1
const QUATERNION_TOLERANCE = 1e-4; // §10.1
export const MAX_LEN = 1e6; // §10.1/§10.2/§10.3 length bound (meters)
export const MAX_REVISION = Number.MAX_SAFE_INTEGER; // §6 (2^53 - 1)
const MAX_DEPTH = 32; // §10.4 (root = 1)
export const NAME_MIN = 1;
export const NAME_MAX = 128;

export const KNOWN_MANIFEST_FIELDS = new Set([
  'schemaVersion',
  'engineVersion',
  'id',
  'name',
  'createdAt',
  'scenes',
]);

// ---- helpers ----------------------------------------------------------------

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * RFC 6901 escaping of one JSON Pointer reference token (G3 — Gate B
 * re-review round 1; project-model.md §12.5: `path` is a JSON Pointer to
 * the offending value). DYNAMIC keys (unknown fields) are interpolated
 * into `path` ONLY through this helper: `~` → `~0` FIRST, then `/` →
 * `~1`. Static segment names (`entities`, `components`, `position`, …) and
 * numeric indices never need escaping. Deliberate duplication of the same
 * two-line pure helper (commands' `pointerSegment`, parse-bytes' exported
 * `escapePointer`): the dependency direction (dependencies.md §4.1) keeps
 * validate.ts module-local, and neither helper is a public export.
 */
export function pointerSegment(segment: string): string {
  return segment.replace(/~/g, '~0').replace(/\//g, '~1');
}

export function fail<E extends AnyError = ModelError>(errors: readonly E[]): { ok: false; errors: readonly E[] } {
  return { ok: false, errors };
}

/** True when the value serializes with JSON.stringify without loss. */
function jsonSafe(v: unknown, depth: number): boolean {
  if (v === null) return true;
  const t = typeof v;
  if (t === 'string' || t === 'boolean' || t === 'number') return true;
  if (t === 'undefined' || t === 'function' || t === 'symbol') return false;
  if (depth > 4) return false;
  if (Array.isArray(v)) {
    return v.length <= 64 && v.every((x) => jsonSafe(x, depth + 1));
  }
  const keys = Object.keys(v as object);
  return keys.length <= 64 && keys.every((k) => jsonSafe((v as Record<string, unknown>)[k], depth + 1));
}

/**
 * G1/G2 (Gate B re-review round 1, 2026-09-18): the traversal bound of the
 * `found` mapper. A value used as `found` may be ANY in-process value
 * (project-model.md §12.1: validation is pure and total — it never throws
 * on malformed data), so the recursion over nested values must be bounded
 * by construction. The per-level caps below (string ≤ 256 chars, array ≤
 * 16 elements) are WIDTH caps, not a recursion bound: a length-1 nested
 * chain still recursed one stack frame per level, so a persisted
 * 4000-level chain used as `found` overflowed the stack (RangeError)
 * through the public `validate*` entry points. Now, per `found` mapping
 * (fresh budget per error):
 *
 *   - depth <= 64 (root = depth 0; children of a depth-64 value are not
 *     processed — they degrade to the marker);
 *   - <= 4096 visited nodes (each processed value consumes one node).
 *
 * Overflow-impossibility (any value shape, arrays, objects, mixed):
 * `mapFound` recurses at most 66 levels deep (depths 0..65), and each
 * array level adds at most one extra frame (the `map` callback), so the
 * call chain is <= ~137 frames plus the object branch's jsonSafe depth
 * (<= 5, its own depth cap of 4). Node's default stack holds orders of
 * magnitude more frames; with the depth cap, overflow is impossible by
 * construction.
 *
 * Deliberate duplication of the commands O1 helper (packages/commands/src/
 * errors.ts, 69b1a17): the dependency direction (dependencies.md §4.1 —
 * project-model is the leaf; commands depends on it) forbids importing
 * that module-local pure helper.
 */
const BOUNDED_FOUND_MAX_DEPTH = 64;
const BOUNDED_FOUND_MAX_NODES = 4096;

/** The `found` marker emitted where the traversal bound is hit — the
 * commands O1 marker text verbatim: this file's existing markers are the
 * long-string / long-array summaries, which do not cover the bound case. */
const BOUNDED_FOUND_MARKER =
  '[truncated: exceeds bounded diagnostic traversal (depth <= 64, nodes <= 4096)]';

interface FoundBudget {
  nodes: number;
  hit: boolean;
}

/**
 * Bound a `found` value (§12.5: "present when it exists and is bounded"):
 * long strings are truncated, long arrays summarized, non-JSON-safe values
 * omitted (the error keeps code/path/message/expected), and the whole
 * traversal is bounded (G1/G2). Where the bound is hit ANYWHERE in the
 * value the whole `found` degrades to the marker — a complete, JSON-safe
 * string (the same "degrade to a summary" convention as the long-string /
 * long-array cases); the error's `path` (built from complete field
 * segments) is unaffected and stays a complete, valid JSON Pointer.
 * Primitives — including NaN/±Infinity, which JSON.stringify maps to
 * `null`, never to a NaN/Infinity token — pass through.
 */
function boundedFound(v: unknown): unknown {
  const budget: FoundBudget = { nodes: 0, hit: false };
  const out = mapFound(v, 0, budget);
  return budget.hit ? BOUNDED_FOUND_MARKER : out;
}

function mapFound(v: unknown, depth: number, budget: FoundBudget): unknown {
  if (depth > BOUNDED_FOUND_MAX_DEPTH || budget.nodes >= BOUNDED_FOUND_MAX_NODES) {
    budget.hit = true;
    return BOUNDED_FOUND_MARKER;
  }
  budget.nodes += 1;
  if (typeof v === 'string') {
    return v.length <= 256 ? v : `${v.slice(0, 256)}… (truncated, ${v.length} chars total)`;
  }
  if (Array.isArray(v)) {
    return v.length <= 16 ? v.map((x) => mapFound(x, depth + 1, budget)) : `[${v.length} elements]`;
  }
  if (v !== null && typeof v === 'object') {
    return jsonSafe(v, 0) ? v : undefined;
  }
  return v;
}

export function withFound<E extends AnyError>(e: E, found: unknown): E {
  const b = boundedFound(found);
  if (b === undefined) return e;
  return { ...e, found: b } as E;
}

export function fieldMissing<E extends AnyError = ModelError>(path: string, field: string): E {
  return {
    code: 'field_missing',
    path,
    message: `required field '${field}' is missing`,
    expected: 'present',
  } as unknown as E;
}

export function fieldType<E extends AnyError = ModelError>(path: string, found: unknown, expected: string): E {
  return withFound<E>(
    { code: 'field_type', path, message: `value must be of type ${expected}`, expected } as unknown as E,
    found,
  );
}

export function fieldValue<E extends AnyError = ModelError>(path: string, found: unknown, expected: string, message: string): E {
  return withFound<E>({ code: 'field_value', path, message, expected } as unknown as E, found);
}

export function idInvalid<E extends AnyError = ModelError>(path: string, found: string): E {
  return withFound<E>(
    {
      code: 'id_invalid',
      path,
      message: 'id does not match the M1 ID syntax',
      expected: '1-64 chars, ^[a-z0-9][a-z0-9_-]{0,63}$',
    } as unknown as E,
    found,
  );
}

export function unexpectedField<E extends AnyError = ModelError>(path: string, key: string, known: string): E {
  return withFound<E>(
    {
      code: 'field_unexpected',
      path,
      message: 'unknown field is not permitted (strict M1 schema drops nothing)',
      expected: `known fields: ${known}`,
    } as unknown as E,
    key,
  );
}

/** §12.3 pass 3: schemaVersion present and known for the document type. */
export function isKnownVersion(v: unknown, known: readonly number[]): boolean {
  return typeof v === 'number' && known.includes(v);
}

/**
 * §6/§12.5: the single `schema_version_unsupported` error. Carries `found`,
 * `knownVersions: [1]`, and the action hint naming the known versions.
 * Document validation stops at this error.
 */
export function schemaVersionUnsupported(
  v: unknown,
  known: readonly number[],
  context = '',
): ModelError {
  const knownList = `[${known.join(', ')}]`;
  const suffix = context === '' ? '' : ` (${context})`;
  let hint: string;
  const highest = known.length > 0 ? (known[known.length - 1] as number) : 0;
  if (typeof v === 'number' && v > highest) {
    hint = `known versions: ${knownList}${suffix}; written by a newer Thirdlight; open with a matching engine, or convert the document; the original is retained`;
  } else if (typeof v === 'number') {
    hint = `known versions: ${knownList}${suffix}; written by an older Thirdlight; open with a matching engine, or convert the document; the original is retained`;
  } else {
    hint = `known versions: ${knownList}${suffix}; the document has no known schemaVersion; open with a matching engine, or convert the document; the original is retained`;
  }
  return withFound(
    {
      code: 'schema_version_unsupported',
      path: '/schemaVersion',
      message: 'schemaVersion is not a known version for this engine',
      expected: `one of the known versions: ${knownList}`,
      knownVersions: [...known],
      hint,
    },
    v,
  );
}

/** §7.2: timestamp regex AND an existing UTC calendar date/time. */
export function isValidTimestamp(s: string): boolean {
  if (!TIMESTAMP_RE.test(s)) return false;
  const y = Number(s.slice(0, 4));
  const mo = Number(s.slice(5, 7));
  const d = Number(s.slice(8, 10));
  const h = Number(s.slice(11, 13));
  const mi = Number(s.slice(14, 16));
  const se = Number(s.slice(17, 19));
  if (y < 1 || mo < 1 || mo > 12) return false;
  const leap = y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);
  let dim: number;
  switch (mo) {
    case 2:
      dim = leap ? 29 : 28;
      break;
    case 4:
    case 6:
    case 9:
    case 11:
      dim = 30;
      break;
    default:
      dim = 31;
  }
  if (d < 1 || d > dim) return false;
  return h <= 23 && mi <= 59 && se <= 59;
}

/** §4/§9.1: name fields — 1–128 chars, no control characters. */
export function isValidName(s: string): boolean {
  if (s.length < NAME_MIN || s.length > NAME_MAX) return false;
  for (let k = 0; k < s.length; k++) {
    const c = s.charCodeAt(k);
    if (c <= 0x1f || c === 0x7f) return false;
  }
  return true;
}

export interface NumRange {
  /** reject v <= minExcl */
  minExcl?: number;
  /** reject v >= maxExcl */
  maxExcl?: number;
  /** reject |v| > absMax */
  absMax?: number;
  /** Phase 15.5: reject v < min (an inclusive lower bound, e.g. 0 for a strength or a factor) */
  min?: number;
  /** reject v <= 0 (no zero or negative lengths/scales) */
  positive?: boolean;
}

/**
 * One numeric leaf. Finiteness is checked BEFORE range (§12.7 R2): a
 * non-finite value yields only `number_not_finite`; a finite out-of-range
 * value yields only `number_out_of_range`; checks are independent per
 * element and all are collected.
 */
export function checkFiniteNumber(
  v: unknown,
  path: string,
  range: NumRange,
  expected: string,
  errors: AnyError[],
): void {
  if (typeof v !== 'number') {
    errors.push(fieldType(path, v, 'finite number'));
    return;
  }
  if (!Number.isFinite(v)) {
    errors.push(
      withFound(
        {
          code: 'number_not_finite',
          path,
          message: 'number must be finite (non-finite values are not JSON-encodable)',
          expected: 'finite number',
        },
        v,
      ),
    );
    return;
  }
  let out = false;
  if (range.positive && v <= 0) out = true;
  if (range.minExcl !== undefined && v <= range.minExcl) out = true;
  if (range.maxExcl !== undefined && v >= range.maxExcl) out = true;
  if (range.absMax !== undefined && Math.abs(v) > range.absMax) out = true;
  if (range.min !== undefined && v < range.min) out = true;
  if (out) {
    errors.push(
      withFound(
        {
          code: 'number_out_of_range',
          path,
          message: 'number is outside the allowed range',
          expected,
        },
        v,
      ),
    );
  }
}

/** Optional vector field: exactly `len` finite numbers, per-element range. */
export function checkVector(
  v: unknown,
  path: string,
  len: number,
  range: NumRange,
  expected: string,
  errors: AnyError[],
): void {
  if (v === undefined) return; // defaulted on normalize (§12.2 rule 1)
  if (!Array.isArray(v)) {
    errors.push(fieldType(path, v, `array of ${len} finite numbers`));
    return;
  }
  if (v.length !== len) {
    errors.push(
      fieldValue(path, v.length, `array of exactly ${len} numbers`, `value must be an array of exactly ${len} numbers`),
    );
    return;
  }
  for (let j = 0; j < len; j++) {
    checkFiniteNumber(v[j], `${path}/${j}`, range, expected, errors);
  }
}

/** §10.1 quaternion: 4 finite numbers, |‖q‖ − 1| ≤ 1e-4. */
export function checkQuaternion(v: unknown, path: string, errors: AnyError[]): void {
  if (v === undefined) return;
  if (!Array.isArray(v)) {
    errors.push(fieldType(path, v, 'array of 4 finite numbers'));
    return;
  }
  if (v.length !== 4) {
    errors.push(
      fieldValue(path, v.length, 'array of exactly 4 numbers', 'value must be an array of exactly 4 numbers'),
    );
    return;
  }
  let allFinite = true;
  for (let j = 0; j < 4; j++) {
    const n = v[j];
    if (typeof n !== 'number') {
      errors.push(fieldType(`${path}/${j}`, n, 'finite number'));
      allFinite = false;
    } else if (!Number.isFinite(n)) {
      errors.push(
        withFound(
          {
            code: 'number_not_finite',
            path: `${path}/${j}`,
            message: 'number must be finite (non-finite values are not JSON-encodable)',
            expected: 'finite number',
          },
          n,
        ),
      );
      allFinite = false;
    }
  }
  if (!allFinite) return;
  const norm = Math.hypot(v[0] as number, v[1] as number, v[2] as number, v[3] as number);
  if (Math.abs(norm - 1) > QUATERNION_TOLERANCE) {
    errors.push(
      withFound(
        {
          code: 'quaternion_invalid',
          path,
          message: 'rotation quaternion must have unit length within 1e-4',
          expected: 'finite [x,y,z,w] with |norm - 1| <= 1e-4',
          hint: 'normalize to unit length; e.g. 45-degree yaw about Y is [0, 0.3826834323650898, 0, 0.9238795325112867]',
        },
        [v[0], v[1], v[2], v[3]],
      ),
    );
  }
}

// ---- cross-entity checks (§11, §10.3, §10.4) ----------------------------------

/**
 * §11.2 normative cycle rejection: each node has ≤ 1 parent (functional
 * graph), three-state walk (unvisited/visiting/done) started in array
 * order. Reaching a `visiting` node on the current walk ⇒ cycle ⇒
 * `hierarchy_cycle` listing the node IDs of the cycle in walk order
 * (e.g. ["a","b"] for a → b → a). A self-parent is a cycle (["a"]). O(n).
 */
export function checkHierarchyCycles(
  ents: unknown[],
  idFirstIndex: Map<string, number>,
  errors: AnyError[],
): void {
  const parentOf = new Map<string, string>(); // first occurrence wins
  for (let idx = 0; idx < ents.length; idx++) {
    const e = ents[idx];
    if (!isPlainObject(e)) continue;
    const id = e['id'];
    const pid = e['parentId'];
    if (typeof id !== 'string' || typeof pid !== 'string') continue;
    if (!idFirstIndex.has(pid)) continue; // missing reference: chain stops (reported separately)
    if (!parentOf.has(id)) parentOf.set(id, pid);
  }
  const done = new Set<string>();
  const ids: string[] = [];
  for (const e of ents) {
    if (isPlainObject(e) && typeof e['id'] === 'string') ids.push(e['id'] as string);
  }
  for (const startId of ids) {
    if (done.has(startId)) continue;
    const path: string[] = [];
    const visiting = new Set<string>();
    let cur: string | undefined = startId;
    while (cur !== undefined && !done.has(cur)) {
      if (visiting.has(cur)) {
        const at = path.indexOf(cur);
        const firstIdx = idFirstIndex.get(cur);
        errors.push(
          withFound(
            {
              code: 'hierarchy_cycle',
              path: firstIdx === undefined ? '' : `/entities/${firstIdx}/parentId`,
              message: 'parent chain contains a cycle',
              expected: 'acyclic parent chain (each entity has at most one parent)',
            },
            path.slice(at),
          ),
        );
        break;
      }
      visiting.add(cur);
      path.push(cur);
      cur = parentOf.get(cur);
    }
    for (const node of path) done.add(node);
  }
}

export function pushDepthError(errors: AnyError[], idx: number, d: number): void {
  errors.push(
    withFound(
      {
        code: 'limits_exceeded',
        path: `/entities/${idx}`,
        message: 'hierarchy depth exceeds the M1 limit (root = 1)',
        limit: 'depth',
        expected: `depth <= ${MAX_DEPTH}`,
      },
      d,
    ),
  );
}

/**
 * §10.4 depth limit (root = 1). Depths are computed only through valid
 * parent links; chains that hit a missing reference or a cycle are
 * undefined (the document is already invalid for that reason) and are not
 * depth-reported.
 */
export function checkDepthLimit(
  ents: unknown[],
  idFirstIndex: Map<string, number>,
  errors: AnyError[],
): void {
  type Chain = string | null | 'bad';
  const parentOf = new Map<string, Chain>();
  for (let idx = 0; idx < ents.length; idx++) {
    const e = ents[idx];
    if (!isPlainObject(e)) continue;
    const id = e['id'];
    if (typeof id !== 'string' || parentOf.has(id)) continue;
    const pid = e['parentId'];
    if (pid === undefined || pid === null) parentOf.set(id, null);
    else if (typeof pid === 'string' && idFirstIndex.has(pid)) parentOf.set(id, pid);
    else parentOf.set(id, 'bad');
  }
  const depth = new Map<string, number>();
  for (let idx = 0; idx < ents.length; idx++) {
    const e = ents[idx];
    if (!isPlainObject(e)) continue;
    const id = e['id'];
    if (typeof id !== 'string') continue;
    const known = depth.get(id);
    if (known !== undefined) {
      if (known > MAX_DEPTH) pushDepthError(errors, idx, known);
      continue;
    }
    const chain: string[] = [];
    const seen = new Set<string>();
    let cur: string | Chain | undefined = id;
    let baseDepth = 0;
    let resolved = false;
    while (cur !== undefined) {
      if (cur === null) {
        // Reached a root (no parent): chain resolved with base depth 0.
        baseDepth = 0;
        resolved = true;
        break;
      }
      if (cur === 'bad') break; // missing/invalid parent link
      const d = depth.get(cur);
      if (d !== undefined) {
        baseDepth = d;
        resolved = true;
        break;
      }
      if (seen.has(cur)) break; // cycle
      seen.add(cur);
      chain.push(cur);
      cur = parentOf.get(cur);
    }
    if (resolved) {
      let d = baseDepth;
      for (let k = chain.length - 1; k >= 0; k--) {
        d += 1;
        depth.set(chain[k] as string, d);
      }
      if (d > MAX_DEPTH) pushDepthError(errors, idx, d);
    }
  }
}

// ---- manifest (§7) -------------------------------------------------------------

function validateManifestValue(
  doc: Record<string, unknown>,
): { errors: ModelError[]; doc?: Manifest } {
  const errors: ModelError[] = [];
  // engineVersion (§7.1)
  const ev = doc['engineVersion'];
  if (ev === undefined) {
    errors.push(fieldMissing('/engineVersion', 'engineVersion'));
  } else if (typeof ev !== 'string') {
    errors.push(fieldType('/engineVersion', ev, 'string'));
  } else if (!SEMVER_RE.test(ev)) {
    errors.push(fieldValue('/engineVersion', ev, 'semver MAJOR.MINOR.PATCH[-prerelease]', 'engineVersion must be a well-formed semver string'));
  }
  // id (§5.1)
  const id = doc['id'];
  if (id === undefined) {
    errors.push(fieldMissing('/id', 'id'));
  } else if (typeof id !== 'string') {
    errors.push(fieldType('/id', id, 'string'));
  } else if (!ID_RE.test(id)) {
    errors.push(idInvalid('/id', id));
  }
  // name
  const name = doc['name'];
  if (name === undefined) {
    errors.push(fieldMissing('/name', 'name'));
  } else if (typeof name !== 'string') {
    errors.push(fieldType('/name', name, 'string'));
  } else if (!isValidName(name)) {
    errors.push(fieldValue('/name', name, `string, ${NAME_MIN}-${NAME_MAX} chars, no control characters`, 'project name must be 1-128 characters without control characters'));
  }
  // createdAt (§7.2)
  const createdAt = doc['createdAt'];
  if (createdAt === undefined) {
    errors.push(fieldMissing('/createdAt', 'createdAt'));
  } else if (typeof createdAt !== 'string') {
    errors.push(fieldType('/createdAt', createdAt, 'string'));
  } else if (!isValidTimestamp(createdAt)) {
    errors.push(
      fieldValue('/createdAt', createdAt, 'YYYY-MM-DDTHH:mm:ssZ denoting an existing UTC date', 'createdAt must be a UTC timestamp with second precision and must denote an existing calendar date'),
    );
  }
  // scenes (§7.1: exactly one in M1)
  const scenes = doc['scenes'];
  if (scenes === undefined) {
    errors.push(fieldMissing('/scenes', 'scenes'));
  } else if (!Array.isArray(scenes)) {
    errors.push(fieldType('/scenes', scenes, 'array'));
  } else if (scenes.length !== 1) {
    errors.push(
      fieldValue('/scenes', scenes.length, 'array of exactly 1 scene reference (M1)', 'the M1 manifest lists exactly one scene'),
    );
  } else {
    const ref = scenes[0];
    if (!isPlainObject(ref)) {
      errors.push(fieldType('/scenes/0', ref, 'object'));
    } else {
      const refId = ref['id'];
      if (refId === undefined) {
        errors.push(fieldMissing('/scenes/0/id', 'id'));
      } else if (typeof refId !== 'string') {
        errors.push(fieldType('/scenes/0/id', refId, 'string'));
      } else if (!ID_RE.test(refId)) {
        errors.push(idInvalid('/scenes/0/id', refId));
      }
      const refPath = ref['path'];
      if (refPath === undefined) {
        errors.push(fieldMissing('/scenes/0/path', 'path'));
      } else if (typeof refPath !== 'string') {
        errors.push(fieldType('/scenes/0/path', refPath, 'string'));
      } else if (refPath !== M1_SCENE_PATH) {
        errors.push(
          fieldValue('/scenes/0/path', refPath, `"${M1_SCENE_PATH}" (the only permitted M1 path)`, 'scenes[0].path must be exactly "scenes/main.json"'),
        );
      }
      for (const k of Object.keys(ref)) {
        if (k !== 'id' && k !== 'path') errors.push(unexpectedField(`/scenes/0/${pointerSegment(k)}`, k, 'id, path'));
      }
    }
  }
  // Unknown top-level fields (§7.1 strict).
  for (const k of Object.keys(doc)) {
    if (!KNOWN_MANIFEST_FIELDS.has(k)) errors.push(unexpectedField(`/${pointerSegment(k)}`, k, 'schemaVersion, engineVersion, id, name, createdAt, scenes'));
  }
  if (errors.length > 0) return { errors };
  // All checks passed: build the canonical document (§12.2). The value
  // below is the same validated `scenes[0]` reference object (the if-chain
  // narrowing does not persist past the block, so re-read and assert the
  // shape the checks just proved).
  const scenesArr = doc['scenes'] as unknown[];
  const ref = scenesArr[0] as Record<string, unknown>;
  return {
    errors,
    doc: {
      schemaVersion: 1,
      engineVersion: ev as string,
      id: id as string,
      name: name as string,
      createdAt: createdAt as string,
      scenes: [{ id: ref['id'] as string, path: ref['path'] as string }],
    },
  };
}

export function validateManifest(doc: unknown): ModelResult<Manifest> {
  if (!isPlainObject(doc)) return fail([fieldType('', doc, 'object')]);
  if (!isKnownVersion(doc['schemaVersion'], SCHEMA_VERSIONS_BY_DOCUMENT.manifest)) {
    // §12.3 pass 3: exactly one error; no field-level validation follows.
    return fail([schemaVersionUnsupported(doc['schemaVersion'], SCHEMA_VERSIONS_BY_DOCUMENT.manifest)]);
  }
  const { errors, doc: canonical } = validateManifestValue(doc);
  if (errors.length > 0) return fail(errors);
  return { ok: true, normalized: canonical as Manifest };
}

/** §12.1: validate, then return the new canonical document (§12.2). */
export function normalizeManifest(doc: unknown): ModelResult<Manifest> {
  return validateManifest(doc);
}

/**
 * Canonical component values (§12.2) for the v3/v4 scene canonicalizers.
 * Each builds a NEW object (never mutates the input): defaults filled,
 * negative zero converted to zero, color lowercased, fixed key order,
 * quaternions preserved verbatim (no renormalization, no sign-flip, §12.2
 * rules 2/5).
 */
export function canonNum(v: unknown): number {
  const n = v as number; // validated finite number
  return n === 0 ? 0 : n; // negative zero → zero (§12.2 rule 2)
}

function canonVec3(v: unknown, d0: number, d1: number, d2: number): Vec3 {
  if (Array.isArray(v)) return [canonNum(v[0]), canonNum(v[1]), canonNum(v[2])];
  return [d0, d1, d2];
}

function canonQuat(v: unknown): Quat {
  if (Array.isArray(v)) return [canonNum(v[0]), canonNum(v[1]), canonNum(v[2]), canonNum(v[3])];
  return [0, 0, 0, 1];
}

function canonOptNumber(v: unknown, d: number): number {
  return typeof v === 'number' ? canonNum(v) : d;
}

export function canonicalTransform(t: unknown): TransformComponent {
  const o = (t ?? {}) as Record<string, unknown>;
  return {
    position: canonVec3(o['position'], 0, 0, 0),
    rotation: canonQuat(o['rotation']),
    scale: canonVec3(o['scale'], 1, 1, 1),
  };
}

export function canonicalBox(b: unknown): BoxComponent {
  const o = (b ?? {}) as Record<string, unknown>;
  const mat = (o['material'] ?? {}) as Record<string, unknown>;
  const color = mat['color'];
  return {
    size: canonVec3(o['size'], 1, 1, 1),
    material: { color: typeof color === 'string' ? color.toLowerCase() : '#b0b0b0' },
    // Phase 17.4: kept only when set (an existing box keeps its exact canonical bytes).
    ...(typeof o['castShadow'] === 'boolean' ? { castShadow: o['castShadow'] } : {}),
    ...(typeof o['receiveShadow'] === 'boolean' ? { receiveShadow: o['receiveShadow'] } : {}),
  };
}

export function canonicalCamera(c: unknown): CameraComponent {
  const o = (c ?? {}) as Record<string, unknown>;
  const type = o['type'];
  return {
    type: typeof type === 'string' ? (type as 'perspective') : 'perspective',
    fovY: canonOptNumber(o['fovY'], 60),
    near: canonOptNumber(o['near'], 0.1),
    far: canonOptNumber(o['far'], 100),
  };
}

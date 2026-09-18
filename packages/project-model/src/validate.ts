/**
 * Value validation — project-model.md §12.3 passes 2–4 and §13.
 *
 * `validate*` is a pure check over in-memory values starting at pass 2:
 * it re-checks ALL value rules, including finiteness (parsed values are
 * not inherently safe — §12.7). Errors are collected, not fail-on-first:
 * independent violations in one document are all reported, in a
 * deterministic order: schema fields in §7–§10 order, entities in array
 * order, then cross-entity checks (references, cycles, order, camera
 * count, depth), then unknown fields in source order.
 *
 * Success returns the CANONICAL document (§12.2) — the same value
 * `normalize*` produces; in M1 validation and normalization are one pass.
 * Pure and total: never reads/writes the filesystem, never throws on
 * malformed data. `found` values are always bounded and JSON-safe so an
 * error payload serialized to text never emits NaN/Infinity tokens
 * (§12.7 R5).
 */

import {
  KNOWN_VERSIONS,
  type ModelError,
  type ModelResult,
} from './errors';
import type {
  BoxComponent,
  CameraComponent,
  Entity,
  EntityComponents,
  Manifest,
  Scene,
  TransformComponent,
  Vec3,
  Quat,
} from './types';

// ---- §5/§6/§7/§10 constants -------------------------------------------------

const ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/; // §5.1
const SEMVER_RE = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/; // §6
const TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/; // §7.2
const COLOR_RE = /^#[0-9a-fA-F]{6}$/; // §10.2
const M1_SCENE_PATH = 'scenes/main.json'; // §3/§5.3/§7.1
const QUATERNION_TOLERANCE = 1e-4; // §10.1
const MAX_LEN = 1e6; // §10.1/§10.2/§10.3 length bound (meters)
const MAX_REVISION = Number.MAX_SAFE_INTEGER; // §6 (2^53 - 1)
const MAX_ENTITIES = 1024; // §10.4
const MAX_DEPTH = 32; // §10.4 (root = 1)
const NAME_MIN = 1;
const NAME_MAX = 128;

const KNOWN_MANIFEST_FIELDS = new Set([
  'schemaVersion',
  'engineVersion',
  'id',
  'name',
  'createdAt',
  'scenes',
]);
const KNOWN_SCENE_FIELDS = new Set([
  'schemaVersion',
  'sceneId',
  'revision',
  'entities',
]);
const KNOWN_ENTITY_FIELDS = new Set(['id', 'name', 'parentId', 'components']);
const KNOWN_COMPONENTS = new Set(['transform', 'box', 'camera']); // §10
const KNOWN_TRANSFORM_FIELDS = new Set(['position', 'rotation', 'scale']);
const KNOWN_BOX_FIELDS = new Set(['size', 'material']);
const KNOWN_MATERIAL_FIELDS = new Set(['color']);
const KNOWN_CAMERA_FIELDS = new Set(['type', 'fovY', 'near', 'far']);

// ---- helpers ----------------------------------------------------------------

function isPlainObject(v: unknown): v is Record<string, unknown> {
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
function pointerSegment(segment: string): string {
  return segment.replace(/~/g, '~0').replace(/\//g, '~1');
}

function fail(errors: ModelError[]): { ok: false; errors: readonly ModelError[] } {
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

function withFound(e: ModelError, found: unknown): ModelError {
  const b = boundedFound(found);
  if (b === undefined) return e;
  return { ...e, found: b };
}

function fieldMissing(path: string, field: string): ModelError {
  return {
    code: 'field_missing',
    path,
    message: `required field '${field}' is missing`,
    expected: 'present',
  };
}

function fieldType(path: string, found: unknown, expected: string): ModelError {
  return withFound(
    { code: 'field_type', path, message: `value must be of type ${expected}`, expected },
    found,
  );
}

function fieldValue(path: string, found: unknown, expected: string, message: string): ModelError {
  return withFound({ code: 'field_value', path, message, expected }, found);
}

function idInvalid(path: string, found: string): ModelError {
  return withFound(
    {
      code: 'id_invalid',
      path,
      message: 'id does not match the M1 ID syntax',
      expected: '1-64 chars, ^[a-z0-9][a-z0-9_-]{0,63}$',
    },
    found,
  );
}

function unexpectedField(path: string, key: string, known: string): ModelError {
  return withFound(
    {
      code: 'field_unexpected',
      path,
      message: 'unknown field is not permitted (strict M1 schema drops nothing)',
      expected: `known fields: ${known}`,
    },
    key,
  );
}

/** §12.3 pass 3: schemaVersion present and in KNOWN_VERSIONS. */
function isKnownVersion(v: unknown): boolean {
  return typeof v === 'number' && (KNOWN_VERSIONS as readonly number[]).includes(v);
}

/**
 * §6/§12.5: the single `schema_version_unsupported` error. Carries `found`,
 * `knownVersions: [1]`, and the action hint naming the known versions.
 * Document validation stops at this error.
 */
function schemaVersionUnsupported(v: unknown): ModelError {
  let hint: string;
  if (typeof v === 'number' && v > 1) {
    hint =
      'known versions: [1]; written by a newer Thirdlight; open with a matching ' +
      'engine, or convert the document; the original is retained';
  } else if (typeof v === 'number') {
    hint =
      'known versions: [1]; written by an older Thirdlight; open with a matching ' +
      'engine, or convert the document; the original is retained';
  } else {
    hint =
      'known versions: [1]; the document has no known schemaVersion; open with a ' +
      'matching engine, or convert the document; the original is retained';
  }
  return withFound(
    {
      code: 'schema_version_unsupported',
      path: '/schemaVersion',
      message: 'schemaVersion is not a known version for this engine',
      expected: `one of the known versions: [${(KNOWN_VERSIONS as readonly number[]).join(', ')}]`,
      knownVersions: [...KNOWN_VERSIONS],
      hint,
    },
    v,
  );
}

/** §7.2: timestamp regex AND an existing UTC calendar date/time. */
function isValidTimestamp(s: string): boolean {
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
function isValidName(s: string): boolean {
  if (s.length < NAME_MIN || s.length > NAME_MAX) return false;
  for (let k = 0; k < s.length; k++) {
    const c = s.charCodeAt(k);
    if (c <= 0x1f || c === 0x7f) return false;
  }
  return true;
}

interface NumRange {
  /** reject v <= minExcl */
  minExcl?: number;
  /** reject v >= maxExcl */
  maxExcl?: number;
  /** reject |v| > absMax */
  absMax?: number;
  /** reject v <= 0 (no zero or negative lengths/scales) */
  positive?: boolean;
}

/**
 * One numeric leaf. Finiteness is checked BEFORE range (§12.7 R2): a
 * non-finite value yields only `number_not_finite`; a finite out-of-range
 * value yields only `number_out_of_range`; checks are independent per
 * element and all are collected.
 */
function checkFiniteNumber(
  v: unknown,
  path: string,
  range: NumRange,
  expected: string,
  errors: ModelError[],
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
function checkVector(
  v: unknown,
  path: string,
  len: number,
  range: NumRange,
  expected: string,
  errors: ModelError[],
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
function checkQuaternion(v: unknown, path: string, errors: ModelError[]): void {
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

// ---- components (§10) --------------------------------------------------------

function validateTransform(t: unknown, path: string, errors: ModelError[]): void {
  if (!isPlainObject(t)) {
    errors.push(fieldType(path, t, 'object'));
    return;
  }
  // Canonical field order: position, rotation, scale (§10.1).
  checkVector(t['position'], `${path}/position`, 3, { absMax: MAX_LEN }, `each |v| <= ${MAX_LEN} meters`, errors);
  checkQuaternion(t['rotation'], `${path}/rotation`, errors);
  checkVector(t['scale'], `${path}/scale`, 3, { positive: true, absMax: MAX_LEN }, `each 0 < v <= ${MAX_LEN}`, errors);
  for (const k of Object.keys(t)) {
    if (!KNOWN_TRANSFORM_FIELDS.has(k)) errors.push(unexpectedField(`${path}/${pointerSegment(k)}`, k, 'position, rotation, scale'));
  }
}

function validateBox(b: unknown, path: string, errors: ModelError[]): void {
  if (!isPlainObject(b)) {
    errors.push(fieldType(path, b, 'object'));
    return;
  }
  checkVector(b['size'], `${path}/size`, 3, { positive: true, absMax: MAX_LEN }, `each 0 < v <= ${MAX_LEN} meters`, errors);
  const mat = b['material'];
  if (mat !== undefined) {
    if (!isPlainObject(mat)) {
      errors.push(fieldType(`${path}/material`, mat, 'object'));
    } else {
      const color = mat['color'];
      if (color !== undefined) {
        if (typeof color !== 'string') {
          errors.push(fieldType(`${path}/material/color`, color, 'string'));
        } else if (!COLOR_RE.test(color)) {
          errors.push(
            fieldValue(`${path}/material/color`, color, '#rrggbb (6 hex digits)', 'material color must be #rrggbb (case-insensitive; canonical form is lowercase)'),
          );
        }
      }
      for (const k of Object.keys(mat)) {
        if (!KNOWN_MATERIAL_FIELDS.has(k)) errors.push(unexpectedField(`${path}/material/${pointerSegment(k)}`, k, 'color'));
      }
    }
  }
  for (const k of Object.keys(b)) {
    if (!KNOWN_BOX_FIELDS.has(k)) errors.push(unexpectedField(`${path}/${pointerSegment(k)}`, k, 'size, material'));
  }
}

function validateCamera(c: unknown, path: string, errors: ModelError[]): void {
  if (!isPlainObject(c)) {
    errors.push(fieldType(path, c, 'object'));
    return;
  }
  // Canonical field order: type, fovY, near, far (§10.3). All numeric
  // fields are optional with §10.3 defaults — absent is skipped here and
  // filled on normalize (§12.2 rule 1).
  const type = c['type'];
  if (type !== undefined) {
    if (typeof type !== 'string') {
      errors.push(fieldType(`${path}/type`, type, 'string'));
    } else if (type !== 'perspective') {
      errors.push(fieldValue(`${path}/type`, type, '"perspective" (only M1 value)', 'camera type must be "perspective"'));
    }
  }
  if (c['fovY'] !== undefined) {
    checkFiniteNumber(c['fovY'], `${path}/fovY`, { positive: true, maxExcl: 180 }, '0 < v < 180 degrees', errors);
  }
  const near = c['near'];
  if (near !== undefined) {
    checkFiniteNumber(near, `${path}/near`, { positive: true, absMax: MAX_LEN }, `0 < v <= ${MAX_LEN} meters`, errors);
  }
  // `far > near`: compare against the effective near (validated value, or
  // the §10.3 default when near is absent/invalid).
  const effectiveNear = typeof near === 'number' && Number.isFinite(near) ? (near as number) : 0.1;
  if (c['far'] !== undefined) {
    checkFiniteNumber(c['far'], `${path}/far`, { minExcl: effectiveNear, absMax: MAX_LEN }, `near < v <= ${MAX_LEN} meters`, errors);
  }
  for (const k of Object.keys(c)) {
    if (!KNOWN_CAMERA_FIELDS.has(k)) errors.push(unexpectedField(`${path}/${pointerSegment(k)}`, k, 'type, fovY, near, far'));
  }
}

/**
 * §9 component registry and combinations. Unknown components report
 * `component_unknown` (listing the known types) with NO field-level
 * validation of their contents. `transform` is required; `box` and
 * `camera` conflict. Field validation of every present KNOWN component is
 * collected independently (a conflicting combination does not suppress the
 * field errors of either component).
 */
function validateComponents(comps: Record<string, unknown>, path: string, errors: ModelError[]): void {
  for (const k of Object.keys(comps)) {
    if (!KNOWN_COMPONENTS.has(k)) {
      errors.push(
        withFound(
          {
            code: 'component_unknown',
            path: `${path}/${pointerSegment(k)}`,
            message: 'component is not in the M1 registry',
            expected: 'known component types: transform, box, camera',
            hint: 'adding a component type requires a new schemaVersion (project-model.md §10)',
          },
          k,
        ),
      );
    }
  }
  if (comps['transform'] === undefined) {
    errors.push({
      code: 'component_missing',
      path: `${path}/transform`,
      message: 'every entity requires the transform component',
      expected: 'transform present',
    });
  }
  const hasBox = comps['box'] !== undefined;
  const hasCam = comps['camera'] !== undefined;
  if (hasBox && hasCam) {
    errors.push(
      withFound(
        {
          code: 'component_conflict',
          path,
          message: 'box and camera are mutually exclusive on one entity',
          expected: 'at most one of box, camera',
        },
        ['box', 'camera'],
      ),
    );
  }
  if (comps['transform'] !== undefined) validateTransform(comps['transform'], `${path}/transform`, errors);
  if (hasBox) validateBox(comps['box'], `${path}/box`, errors);
  if (hasCam) validateCamera(comps['camera'], `${path}/camera`, errors);
}

// ---- entity (§9) --------------------------------------------------------------

function validateEntity(
  e: unknown,
  idx: number,
  errors: ModelError[],
  idFirstIndex: Map<string, number>,
): void {
  const base = `/entities/${idx}`;
  if (!isPlainObject(e)) {
    errors.push(fieldType(base, e, 'object'));
    return;
  }
  const id = e['id'];
  if (id === undefined) {
    errors.push(fieldMissing(`${base}/id`, 'id'));
  } else if (typeof id !== 'string') {
    errors.push(fieldType(`${base}/id`, id, 'string'));
  } else {
    if (!ID_RE.test(id)) errors.push(idInvalid(`${base}/id`, id));
    const first = idFirstIndex.get(id);
    if (first === undefined) {
      idFirstIndex.set(id, idx);
    } else {
      // First occurrence wins; the error points at the later occurrence
      // (§12.3 duplicate-ID reporting).
      errors.push(
        withFound(
          {
            code: 'id_duplicate',
            path: `${base}/id`,
            message: 'entity id is already used by an earlier entity (first occurrence wins)',
            expected: 'a unique entity id within the scene',
          },
          id,
        ),
      );
    }
  }
  const name = e['name'];
  if (name !== undefined) {
    if (typeof name !== 'string') {
      errors.push(fieldType(`${base}/name`, name, 'string'));
    } else if (!isValidName(name)) {
      errors.push(
        fieldValue(`${base}/name`, name, `string, ${NAME_MIN}-${NAME_MAX} chars, no control characters`, 'entity name must be 1-128 characters without control characters'),
      );
    }
  }
  const pid = e['parentId'];
  if (pid !== undefined && pid !== null && typeof pid !== 'string') {
    errors.push(fieldType(`${base}/parentId`, pid, 'string or null'));
  }
  const comps = e['components'];
  if (comps === undefined) {
    errors.push(fieldMissing(`${base}/components`, 'components'));
  } else if (!isPlainObject(comps)) {
    errors.push(fieldType(`${base}/components`, comps, 'object'));
  } else {
    validateComponents(comps, `${base}/components`, errors);
  }
  for (const k of Object.keys(e)) {
    if (!KNOWN_ENTITY_FIELDS.has(k)) errors.push(unexpectedField(`${base}/${pointerSegment(k)}`, k, 'id, name, parentId, components'));
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
function checkHierarchyCycles(
  ents: unknown[],
  idFirstIndex: Map<string, number>,
  errors: ModelError[],
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

function pushDepthError(errors: ModelError[], idx: number, d: number): void {
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
function checkDepthLimit(
  ents: unknown[],
  idFirstIndex: Map<string, number>,
  errors: ModelError[],
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
  if (!isKnownVersion(doc['schemaVersion'])) {
    // §12.3 pass 3: exactly one error; no field-level validation follows.
    return fail([schemaVersionUnsupported(doc['schemaVersion'])]);
  }
  const { errors, doc: canonical } = validateManifestValue(doc);
  if (errors.length > 0) return fail(errors);
  return { ok: true, normalized: canonical as Manifest };
}

/** §12.1: validate, then return the new canonical document (§12.2). */
export function normalizeManifest(doc: unknown): ModelResult<Manifest> {
  return validateManifest(doc);
}

// ---- scene (§8) -----------------------------------------------------------------

function validateSceneValue(
  doc: Record<string, unknown>,
): { errors: ModelError[]; doc?: Scene } {
  const errors: ModelError[] = [];
  // sceneId (§5.1)
  const sceneId = doc['sceneId'];
  if (sceneId === undefined) {
    errors.push(fieldMissing('/sceneId', 'sceneId'));
  } else if (typeof sceneId !== 'string') {
    errors.push(fieldType('/sceneId', sceneId, 'string'));
  } else if (!ID_RE.test(sceneId)) {
    errors.push(idInvalid('/sceneId', sceneId));
  }
  // revision (§6)
  const revision = doc['revision'];
  if (revision === undefined) {
    errors.push(fieldMissing('/revision', 'revision'));
  } else if (typeof revision !== 'number') {
    errors.push(fieldType('/revision', revision, 'integer'));
  } else if (!Number.isSafeInteger(revision) || revision < 0 || revision > MAX_REVISION) {
    errors.push(
      withFound(
        {
          code: 'revision_invalid',
          path: '/revision',
          message: 'revision must be an integer in [0, 2^53-1]',
          expected: `integer in [0, ${MAX_REVISION}]`,
        },
        revision,
      ),
    );
  }
  // entities (§8.1)
  const ents = doc['entities'];
  let entities: unknown[] | null = null;
  if (ents === undefined) {
    errors.push(fieldMissing('/entities', 'entities'));
  } else if (!Array.isArray(ents)) {
    errors.push(fieldType('/entities', ents, 'array'));
  } else {
    entities = ents;
    if (ents.length > MAX_ENTITIES) {
      errors.push(
        withFound(
          {
            code: 'limits_exceeded',
            path: '/entities',
            message: `scene exceeds the M1 entity limit of ${MAX_ENTITIES}`,
            limit: 'entities',
            expected: `<= ${MAX_ENTITIES} entities`,
          },
          ents.length,
        ),
      );
    }
  }
  if (entities !== null) {
    const idFirstIndex = new Map<string, number>();
    for (let idx = 0; idx < entities.length; idx++) {
      validateEntity(entities[idx], idx, errors, idFirstIndex);
    }
    // Cross-entity: references (§11.2).
    for (let idx = 0; idx < entities.length; idx++) {
      const e = entities[idx];
      if (!isPlainObject(e)) continue;
      const pid = e['parentId'];
      if (typeof pid === 'string' && !idFirstIndex.has(pid)) {
        errors.push(
          withFound(
            {
              code: 'reference_missing',
              path: `/entities/${idx}/parentId`,
              message: 'parentId does not reference an existing entity in this scene',
              found: undefined,
              expected: 'an existing entity id, or null/absent (root)',
            },
            pid,
          ),
        );
      }
    }
    // Cross-entity: cycles (§11.2 normative algorithm).
    checkHierarchyCycles(entities, idFirstIndex, errors);
    // Cross-entity: parent-before-child order (§11.1).
    for (let idx = 0; idx < entities.length; idx++) {
      const e = entities[idx];
      if (!isPlainObject(e)) continue;
      const pid = e['parentId'];
      if (typeof pid !== 'string') continue;
      const pidx = idFirstIndex.get(pid);
      if (pidx === undefined) continue; // missing reference reported separately
      if (pidx >= idx) {
        errors.push(
          withFound(
            {
              code: 'order_parent_before_child',
              path: `/entities/${idx}/parentId`,
              message: 'an entity must appear before its parent in the entities array',
              expected: 'parent index < child index (parent-before-child order)',
            },
            pid,
          ),
        );
      }
    }
    // Cross-entity: exactly one camera (§10.3).
    let cameras = 0;
    for (const e of entities) {
      if (isPlainObject(e) && isPlainObject(e['components']) && e['components']['camera'] !== undefined) {
        cameras += 1;
      }
    }
    if (cameras !== 1) {
      errors.push(
        withFound(
          {
            code: 'camera_count_invalid',
            path: '',
            message: 'the scene must contain exactly one entity carrying the camera component',
            expected: 'exactly 1 camera',
          },
          cameras,
        ),
      );
    }
    // Cross-entity: depth limit (§10.4).
    checkDepthLimit(entities, idFirstIndex, errors);
  }
  // Unknown top-level fields (§8.1 strict) — always checked, independent of
  // the entity-level errors collected above.
  for (const k of Object.keys(doc)) {
    if (!KNOWN_SCENE_FIELDS.has(k)) errors.push(unexpectedField(`/${pointerSegment(k)}`, k, 'schemaVersion, sceneId, revision, entities'));
  }
  if (errors.length > 0) return { errors };
  return { errors, doc: canonicalScene(doc, entities as unknown[]) };
}

/**
 * Canonical scene (§12.2) from a fully validated scene value. Builds a NEW
 * object graph (never mutates the input): defaults filled, negative zero
 * converted to zero, color lowercased, fixed key order, entities order
 * preserved, quaternions preserved verbatim (no renormalization, no
 * sign-flip, §12.2 rules 2/5).
 */
function canonNum(v: unknown): number {
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

function canonicalTransform(t: unknown): TransformComponent {
  const o = (t ?? {}) as Record<string, unknown>;
  return {
    position: canonVec3(o['position'], 0, 0, 0),
    rotation: canonQuat(o['rotation']),
    scale: canonVec3(o['scale'], 1, 1, 1),
  };
}

function canonicalBox(b: unknown): BoxComponent {
  const o = (b ?? {}) as Record<string, unknown>;
  const mat = (o['material'] ?? {}) as Record<string, unknown>;
  const color = mat['color'];
  return {
    size: canonVec3(o['size'], 1, 1, 1),
    material: { color: typeof color === 'string' ? color.toLowerCase() : '#b0b0b0' },
  };
}

function canonicalCamera(c: unknown): CameraComponent {
  const o = (c ?? {}) as Record<string, unknown>;
  const type = o['type'];
  return {
    type: typeof type === 'string' ? (type as 'perspective') : 'perspective',
    fovY: canonOptNumber(o['fovY'], 60),
    near: canonOptNumber(o['near'], 0.1),
    far: canonOptNumber(o['far'], 100),
  };
}

function canonicalEntity(e: Record<string, unknown>): Entity {
  const comps = e['components'] as Record<string, unknown>;
  const components: EntityComponents = {
    transform: canonicalTransform(comps['transform']),
  };
  if (comps['box'] !== undefined) components.box = canonicalBox(comps['box']);
  if (comps['camera'] !== undefined) components.camera = canonicalCamera(comps['camera']);
  // Fixed entity key order (§12.2 rule 4): id, name?, parentId?, components.
  const name = e['name'];
  const pid = e['parentId'];
  return {
    id: e['id'] as string,
    ...(typeof name === 'string' ? { name } : {}),
    ...(typeof pid === 'string' ? { parentId: pid } : {}),
    components,
  };
}

function canonicalScene(doc: Record<string, unknown>, ents: unknown[]): Scene {
  return {
    schemaVersion: 1,
    sceneId: doc['sceneId'] as string,
    revision: canonNum(doc['revision']),
    entities: (ents as Record<string, unknown>[]).map(canonicalEntity),
  };
}

export function validateScene(doc: unknown): ModelResult<Scene> {
  if (!isPlainObject(doc)) return fail([fieldType('', doc, 'object')]);
  if (!isKnownVersion(doc['schemaVersion'])) {
    return fail([schemaVersionUnsupported(doc['schemaVersion'])]);
  }
  const { errors, doc: canonical } = validateSceneValue(doc);
  if (errors.length > 0) return fail(errors);
  return { ok: true, normalized: canonical as Scene };
}

/** §12.1: validate, then return the new canonical document (§12.2). */
export function normalizeScene(doc: unknown): ModelResult<Scene> {
  return validateScene(doc);
}

// ---- cross-document (§13) ---------------------------------------------------------

/**
 * Project-level validation (§13): both single-document validations first
 * (manifest then scene order); project-level errors carry the `document`
 * discriminator. Cross-document checks run only when BOTH documents pass;
 * an unknown version produces exactly one error for that document while
 * independent errors in the other document are still returned.
 */
export function validateProject(
  manifest: unknown,
  scene: unknown,
): ModelResult<{ manifest: Manifest; scene: Scene }> {
  const m = validateManifest(manifest);
  const s = validateScene(scene);
  const errors: ModelError[] = [];
  if (!m.ok) for (const e of m.errors) errors.push({ ...e, document: 'manifest' });
  if (!s.ok) for (const e of s.errors) errors.push({ ...e, document: 'scene' });
  if (!m.ok || !s.ok) return fail(errors);
  const mm = m.normalized;
  const ss = s.normalized;
  if (mm.scenes[0].id !== ss.sceneId) {
    errors.push(
      withFound(
        {
          code: 'manifest_scene_mismatch',
          path: '/scenes/0/id',
          document: 'manifest',
          message: 'manifest scenes[0].id does not equal the scene document sceneId',
          expected: 'scene document sceneId',
        },
        mm.scenes[0].id,
      ),
    );
    return fail(errors);
  }
  return { ok: true, normalized: { manifest: mm, scene: ss } };
}
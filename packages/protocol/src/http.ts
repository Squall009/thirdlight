/**
 * HTTP payload types + strict validators: establish / re-attach, the command
 * envelope pre-check, admin operations, play start and screenshot.
 *
 * All payloads are strict JSON (unknown fields rejected).
 * The command envelope is delegated to the workspace pipeline for the
 * authoritative validation (strict byte parse first, then the command
 * pipeline) — the pre-check here only routes on `op`.
 *
 * Pure: no I/O.
 */
import { ID_RE } from '@thirdlight/project-model/limits';
import { SCRIPT_SAVE_LIMITS } from '@thirdlight/project-model/limits';
import type { MutationOp } from '@thirdlight/commands';
import {
  isProjectId,
  isSessionId,
  REQUEST_ID_RE,
} from './ids';
import { sessionError } from './errors';
import { V3_MUTATION_OPS, V3_QUERY_OPS } from './m3';
import {
  checkField,
  checkOptionalObject,
  checkShape,
  isPlainObject,
  isStringNoControl,
  type FieldErrorResult,
  type FieldVerdict,
} from './strict';

// ---- POST /api/v1/sessions --------------------------------

export interface EstablishRequest {
  projectId: string;
  sessionId: string;
  clientInfo?: { kind: 'browser'; label?: string };
}

const ESTABLISH_FIELDS = new Map([
  ['projectId', 'string (the project id syntax)'],
  ['sessionId', 'string (sess- + 32 hex)'],
  ['clientInfo', '{ kind: "browser", label?: string ≤ 128 }'],
]);
const CLIENT_INFO_FIELDS = new Map([
  ['kind', '"browser"'],
  ['label', 'string 1–128, no control chars'],
]);

export function parseEstablishRequest(value: unknown):
  | { ok: true; request: EstablishRequest }
  | { ok: false; error: import('./errors').SessionError } {
  const shape = checkShape(value, '', ESTABLISH_FIELDS, ['projectId', 'sessionId']);
  if (!shape.ok) return { ok: false, error: shape.error };
  const obj = shape.value;
  const pid = checkField(obj, 'projectId', '', 'project ID', (v) =>
    isProjectId(v) ? null : { problem: 'projectId must match the project-model ID syntax', kind: 'value' },
  );
  if (!pid.ok) return { ok: false, error: pid.error };
  const sid = checkField(obj, 'sessionId', '', 'sess- + 32 lowercase hex', (v) =>
    isSessionId(v) ? null : { problem: 'sessionId must be sess- + 32 lowercase hex', kind: 'value' },
  );
  if (!sid.ok) return { ok: false, error: sid.error };
  let clientInfo: EstablishRequest['clientInfo'];
  if (obj.clientInfo !== undefined) {
    const ci = checkOptionalObject(obj, 'clientInfo', '', CLIENT_INFO_FIELDS, ['kind']);
    if (!ci.ok) return { ok: false, error: ci.error };
    const kind = checkField(ci.value, 'kind', '/clientInfo', '"browser" (the only M1 session kind)', (v) =>
      v === 'browser' ? null : { problem: 'clientInfo.kind must be "browser"', kind: 'value' },
    );
    if (!kind.ok) return { ok: false, error: kind.error };
    let label: string | undefined;
    if (ci.value.label !== undefined) {
      const lb = checkField(ci.value, 'label', '/clientInfo', 'string 1–128, no control chars', (v) =>
        isStringNoControl(v) ? null : { problem: 'clientInfo.label must be 1–128 chars with no control chars', kind: 'type' },
      );
      if (!lb.ok) return { ok: false, error: lb.error };
      label = lb.value as string;
    }
    clientInfo = label === undefined ? { kind: 'browser' } : { kind: 'browser', label };
  }
  return { ok: true, request: { projectId: obj.projectId as string, sessionId: obj.sessionId as string, clientInfo } };
}

// ---- POST /api/v1/projects/:projectId/play ---------------

export interface PlayStartRequest {
  demo: boolean;
  /** Optional: the authoring session (browser) the play must run in. */
  sessionId?: string;
  /** A test/debug start (absent: the game starts as it always does). */
  start?: PlayStartOptions;
}

/**
 * Where Play starts and with what — a scene, a game mode, script
 * variables (what the scripts' `ctx.save` holds from step 0) and/or a
 * project save (a save document, or one of the page's project save
 * slots). The
 * backend resolves them against the project (`RuntimeSnapshotDoc.start`).
 */
export interface PlayStartOptions {
  sceneId?: string;
  mode?: string;
  variables?: Record<string, unknown>;
  save?: Record<string, unknown>;
  /** '1'–'99': a project save slot. */
  saveSlot?: string;
  /** Where this play's simulation runs (a worker or the page's main thread), over the project's `sim_thread`. */
  threads?: 'worker' | 'single';
}

/** The bounds of the start options' variables: the script save's own. */
export const PLAY_START_VARIABLES_MAX = SCRIPT_SAVE_LIMITS.keys;
export const PLAY_START_VARIABLE_MAX_CHARS = SCRIPT_SAVE_LIMITS.valueChars;
const PLAY_VARIABLE_KEY_RE = /^[A-Za-z0-9_.:-]{1,64}$/;
const PLAY_SCENE_ID_RE = ID_RE;
const PLAY_MODE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/;
/** A project save document (`format: "thirdlight.save"`) may be as large as a save slot (1 MiB; the request body bound applies too). */
export const PLAY_START_PROJECT_SAVE_MAX_BYTES = 1_048_576;
export const PROJECT_SAVE_FORMAT = 'thirdlight.save';
const PLAY_SAVE_SLOT_RE = /^[1-9][0-9]?$/;

const PLAY_START_FIELDS = new Map([
  ['options', '{ demo?: boolean, sceneId?, mode?, variables?, save?, saveSlot?, threads? }'],
  ['sessionId', 'sess- + 32 hex (optional: the browser session to play in)'],
]);
const PLAY_OPTIONS_FIELDS = new Map([
  ['demo', 'boolean (default true)'],
  ['sceneId', 'a scene id: Play starts there'],
  ['mode', 'a game mode id (checked once the project has game modes)'],
  ['variables', `{ key: JSON value } (at most ${PLAY_START_VARIABLES_MAX}; what the scripts' ctx.save holds from step 0)`],
  ['save', 'a project save document { format: "thirdlight.save", version, doc, ... } (at most 1 MiB)'],
  ['saveSlot', '1-99 (a project save slot)'],
  ['threads', '"worker" | "single": where the simulation runs for this play (absent: the project setting sim_thread)'],
]);

/** Validate the start fields of the play-start options (pure). */
function parsePlayStartOptions(o: Record<string, unknown>): { ok: true; start: PlayStartOptions | undefined } | { ok: false; error: import('./errors').SessionError } {
  const bad = (path: string, message: string) => ({ ok: false as const, error: sessionError('field_value', 'validation', message, { path }) });
  const start: PlayStartOptions = {};
  if (o.sceneId !== undefined) {
    if (typeof o.sceneId !== 'string' || !PLAY_SCENE_ID_RE.test(o.sceneId)) return bad('/options/sceneId', 'options.sceneId must be a scene id');
    start.sceneId = o.sceneId;
  }
  if (o.mode !== undefined) {
    if (typeof o.mode !== 'string' || !PLAY_MODE_ID_RE.test(o.mode)) return bad('/options/mode', 'options.mode must be a game mode id (1-64 of A-Z a-z 0-9 _ . : -)');
    start.mode = o.mode;
  }
  if (o.variables !== undefined) {
    const v = o.variables;
    if (!isPlainObject(v) || Object.keys(v).length > PLAY_START_VARIABLES_MAX) return bad('/options/variables', `options.variables must map at most ${PLAY_START_VARIABLES_MAX} keys to JSON values`);
    for (const [k, value] of Object.entries(v)) {
      let text: string | undefined;
      try {
        text = JSON.stringify(value);
      } catch {
        text = undefined;
      }
      if (!PLAY_VARIABLE_KEY_RE.test(k)) return bad(`/options/variables/${k.slice(0, 64)}`, 'a variable key is 1-64 of A-Z a-z 0-9 _ . : -');
      if (text === undefined || text.length > PLAY_START_VARIABLE_MAX_CHARS) return bad(`/options/variables/${k}`, `a variable value is JSON of at most ${PLAY_START_VARIABLE_MAX_CHARS} characters`);
    }
    start.variables = v;
  }
  if (o.save !== undefined) {
    const s = o.save;
    // A project save document (its content is checked against the project's schema by the backend and the game).
    if (!isPlainObject(s) || s.format !== PROJECT_SAVE_FORMAT || !Number.isInteger(s.version) || (s.version as number) < 1 || !('doc' in s)) return bad('/options/save', 'options.save must be a project save document { format: "thirdlight.save", version, doc, playSeconds?, sections? }');
    if (new TextEncoder().encode(JSON.stringify(s)).length > PLAY_START_PROJECT_SAVE_MAX_BYTES) return bad('/options/save', `options.save is larger than ${PLAY_START_PROJECT_SAVE_MAX_BYTES} bytes`);
    start.save = s;
  }
  if (o.saveSlot !== undefined) {
    if (typeof o.saveSlot !== 'string' || !PLAY_SAVE_SLOT_RE.test(o.saveSlot)) return bad('/options/saveSlot', 'options.saveSlot must be a project save slot 1-99');
    start.saveSlot = o.saveSlot;
  }
  if (o.threads !== undefined) {
    // A play-test's threading mode (the page URL flag ?threads= still wins, as over the setting).
    if (o.threads !== 'worker' && o.threads !== 'single') return bad('/options/threads', 'options.threads must be "worker" or "single"');
    start.threads = o.threads;
  }
  if (start.save !== undefined && start.saveSlot !== undefined) return bad('/options/saveSlot', 'give options.save or options.saveSlot, not both');
  if (start.sceneId !== undefined && (start.save !== undefined || start.saveSlot !== undefined)) return bad('/options/sceneId', 'a save decides where the game continues: give options.sceneId or a save, not both');
  return { ok: true, start: Object.keys(start).length > 0 ? start : undefined };
}

export function parsePlayStartRequest(value: unknown):
  | { ok: true; request: PlayStartRequest }
  | { ok: false; error: import('./errors').SessionError } {
  // Absent body is allowed (options optional) — the HTTP layer normalizes
  // an empty body to {} before calling this.
  const shape = checkShape(value ?? {}, '', PLAY_START_FIELDS, []);
  if (!shape.ok) return { ok: false, error: shape.error };
  const options = checkOptionalObject(shape.value, 'options', '', PLAY_OPTIONS_FIELDS, []);
  if (!options.ok) return { ok: false, error: options.error };
  let demo = true;
  if (options.value.demo !== undefined) {
    const dv = checkField(options.value, 'demo', '/options', 'boolean', (v) =>
      typeof v === 'boolean' ? null : { problem: 'options.demo must be a boolean', kind: 'type' },
    );
    if (!dv.ok) return { ok: false, error: dv.error };
    demo = dv.value as boolean;
  }
  const started = parsePlayStartOptions(options.value);
  if (!started.ok) return started;
  const sid = shape.value.sessionId;
  if (sid !== undefined && !isSessionId(sid)) {
    return { ok: false, error: sessionError('invalid_request', 'validation', 'sessionId must be sess- + 32 hex', { path: '/sessionId' }) };
  }
  return { ok: true, request: { demo, ...(typeof sid === 'string' ? { sessionId: sid } : {}), ...(started.start !== undefined ? { start: started.start } : {}) } };
}

// ---- POST …/play/:playSessionId/screenshot -----------------

/** Screenshot width bounds (default 1024, max 2048, min 256). */
export const SCREENSHOT_MAX_WIDTH_MIN = 256;
export const SCREENSHOT_MAX_WIDTH_MAX = 2048;
export const SCREENSHOT_MAX_WIDTH_DEFAULT = 1024;

export interface ScreenshotRequest {
  maxWidth: number;
}

const SCREENSHOT_FIELDS = new Map([['maxWidth', `integer ${SCREENSHOT_MAX_WIDTH_MIN}–${SCREENSHOT_MAX_WIDTH_MAX}`]]);

export function parseScreenshotRequest(value: unknown):
  | { ok: true; request: ScreenshotRequest }
  | { ok: false; error: import('./errors').SessionError } {
  const shape = checkShape(value ?? {}, '', SCREENSHOT_FIELDS, []);
  if (!shape.ok) return { ok: false, error: shape.error };
  if (shape.value.maxWidth === undefined) {
    return { ok: true, request: { maxWidth: SCREENSHOT_MAX_WIDTH_DEFAULT } };
  }
  const mw = checkField(shape.value, 'maxWidth', '', `integer ${SCREENSHOT_MAX_WIDTH_MIN}–${SCREENSHOT_MAX_WIDTH_MAX}`, (v) => {
    if (typeof v !== 'number' || !Number.isInteger(v)) return { problem: 'maxWidth must be an integer', kind: 'type' };
    if (v < SCREENSHOT_MAX_WIDTH_MIN || v > SCREENSHOT_MAX_WIDTH_MAX) {
      return { problem: `maxWidth must be in [${SCREENSHOT_MAX_WIDTH_MIN}, ${SCREENSHOT_MAX_WIDTH_MAX}]`, kind: 'value' };
    }
    return null;
  });
  if (!mw.ok) return { ok: false, error: mw.error };
  return { ok: true, request: { maxWidth: mw.value as number } };
}

// ---- POST /api/v1/admin/projects ---------------------------

export interface AdminCreateProjectRequest {
  projectId: string;
  name: string;
  /** Optional template/sample id to create the project from. */
  template?: string;
  /** Optional absolute server folder: the project is there (marker + thirdlight/) instead of the data root. */
  folder?: string;
}

const ADMIN_CREATE_FIELDS = new Map([
  ['projectId', 'string (the project id syntax)'],
  ['name', 'string 1–128, no control chars'],
  ['template', 'string (template id), optional'],
  ['folder', 'absolute server folder path, optional'],
]);

export function parseAdminCreateProjectRequest(value: unknown):
  | { ok: true; request: AdminCreateProjectRequest }
  | { ok: false; error: import('./errors').SessionError } {
  const shape = checkShape(value ?? {}, '', ADMIN_CREATE_FIELDS, ['projectId', 'name']);
  if (!shape.ok) return { ok: false, error: shape.error };
  const pid = checkField(shape.value, 'projectId', '', 'project ID', (v) =>
    isProjectId(v) ? null : { problem: 'projectId must match the project-model ID syntax', kind: 'value' },
  );
  if (!pid.ok) return { ok: false, error: pid.error };
  const name = checkField(shape.value, 'name', '', 'string 1–128, no control chars', (v) =>
    isStringNoControl(v) ? null : { problem: 'name must be 1–128 chars with no control chars', kind: 'type' },
  );
  if (!name.ok) return { ok: false, error: name.error };
  const template = shape.value.template;
  if (template !== undefined && !isProjectId(template)) {
    return { ok: false, error: sessionError('invalid_request', 'validation', 'template must be a template id', { path: '/template' }) };
  }
  const folder = shape.value.folder;
  if (folder !== undefined && (typeof folder !== 'string' || folder.length === 0 || folder.length > 1024 || !folder.startsWith('/'))) {
    return { ok: false, error: sessionError('invalid_request', 'validation', 'folder must be an absolute path on the server', { path: '/folder' }) };
  }
  return {
    ok: true,
    request: {
      projectId: shape.value.projectId as string,
      name: shape.value.name as string,
      ...(typeof template === 'string' ? { template } : {}),
      ...(typeof folder === 'string' ? { folder } : {}),
    },
  };
}

/**
 * Strict no-argument admin body (admin routes without arguments): exactly `{}` — no fields (unknown fields rejected). An
 * empty body is normalized to `{}` by the HTTP layer before this.
 */
export function parseAdminNoArgsBody(value: unknown): FieldErrorResult {
  return checkShape(value ?? {}, '', new Map(), []);
}

// ---- POST /api/v1/projects/:projectId/commands ------------

/**
 * Command envelope pre-check: the body is a commands.md
 * envelope; this pre-check only verifies it is an object carrying a
 * string `op` so the router can dispatch to the workspace pipeline (the
 * authoritative validator). Anything else is a
 * session-layer `invalid_request`.
 */
const MUTATION_OPS: readonly MutationOp[] = [
  // entity and history ops
  'createEntity', 'setTransform', 'deleteEntity', 'undo', 'redo',
  // content/property/prefab ops
  'publishAsset', 'publishBehavior', 'setBehaviorProperties', 'setComponent', 'setSettings',
  'acknowledgeBehaviorTrust', 'createPrefab', 'instantiatePrefab',
  // v3 game/presentation ops
  ...(V3_MUTATION_OPS as readonly MutationOp[]),
];
export const QUERY_OPS = [
  'queryProject', 'queryEntity', 'queryEntities',
  'queryAssets', 'queryPrefabs', 'queryBehaviors',
  // v3 queries
  ...V3_QUERY_OPS,
] as const;
const ALL_OPS: readonly string[] = [...MUTATION_OPS, ...QUERY_OPS];

export function parseCommandEnvelope(value: unknown):
  | { ok: true; op: string }
  | { ok: false; error: import('./errors').SessionError } {
  if (!isPlainObject(value)) {
    return {
      ok: false,
      error: {
        code: 'invalid_request',
        cls: 'validation',
        message: 'command body must be a JSON object (a commands.md envelope)',
        path: '',
        expected: 'commands.md envelope object',
      },
    };
  }
  const op = (value as Record<string, unknown>).op;
  if (typeof op !== 'string' || !ALL_OPS.includes(op)) {
    return {
      ok: false,
      error: {
        code: 'invalid_request',
        cls: 'validation',
        message: `op must be one of the accepted ops (got ${JSON.stringify(String(op)).slice(0, 64)})`,
        path: '/op',
        expected: `one of: ${ALL_OPS.join(', ')}`,
      },
    };
  }
  // requestId, when present, must at least be a string (syntax is the
  // pipeline's).
  const rid = (value as Record<string, unknown>).requestId;
  if (rid !== undefined && typeof rid !== 'string') {
    return {
      ok: false,
      error: {
        code: 'invalid_request',
        cls: 'validation',
        message: 'requestId must be a string when present',
        path: '/requestId',
        expected: 'req- + 32 hex',
      },
    };
  }
  if (typeof rid === 'string' && !REQUEST_ID_RE.test(rid)) {
    return {
      ok: false,
      error: {
        code: 'invalid_request',
        cls: 'validation',
        message: 'requestId must be req- + 32 hex',
        path: '/requestId',
        expected: REQUEST_ID_RE.source,
      },
    };
  }
  return { ok: true, op };
}

export function isMutationOp(op: string): boolean {
  return (MUTATION_OPS as readonly string[]).includes(op);
}
export { ALL_OPS as ALL_COMMAND_OPS };
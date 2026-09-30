/**
 * The headless play-test runner — a client of the same `/api/v1`
 * play surface as the editor and MCP (play start, the input exercise relay,
 * the observation, diagnostics), shared by `tl_playtest` and the
 * `tools/playtest.mjs` CLI. It ships no game knowledge: what a run does comes
 * from an input script (relay frames, input frame version 2) or from a driver
 * the project supplies, and what it reports from an observation spec.
 *
 * A run is the game from its start: the first exercise restarts it (the
 * replay: start scenes, every object as authored, the start's variables set
 * again), so every run of a play-test begins alike whatever ran before.
 * Every exercise asks for `hold`: the game holds right after its last step
 * and the next exercise begins at exactly the following step, so a long
 * script split into several exercises, an observation in the middle of a
 * run and a driver that decides step by step are all step-exact, whatever
 * the wall-clock time between calls. The game runs at its real step rate
 * while an exercise runs (a minute of play takes a minute).
 *
 * Each run reports the run digest (`tl_game_observe` `run`) at the end and
 * at each requested step; runs with the same input must agree (the same
 * digest at the same run step), in the simulation worker and on a single
 * thread alike — the result says whether they did.
 *
 * Pure: no Node builtins (the MCP adapter's boundary). The caller supplies
 * the backend client and, for a driver, the loaded function.
 */
import { INPUT_RELAY_MAX_BODY_BYTES, INPUT_RELAY_MAX_FRAMES, INPUT_RELAY_MAX_STEPS, parseRelayGamepad, parseRelayUiEdges } from '@thirdlight/protocol';

import type { BackendClient, BackendResponse } from './backend-client';

// The CLI (tools/playtest.mjs) loads this module's build (dist/mcp-adapter/playtest.mjs) and needs a client too.
export { BackendClient } from './backend-client';

/** One frame of an input script: a relay frame whose `stepOffset` counts from the run's first step (0). */
export interface PlaytestFrame {
  readonly stepOffset: number;
  readonly steps?: number;
  readonly actions?: Readonly<Record<string, unknown>>;
  readonly pointer?: Readonly<Record<string, unknown>>;
  readonly gamepad?: Readonly<Record<string, unknown>>;
  readonly ui?: readonly string[];
}

/** What each run reports. */
export interface PlaytestObserveSpec {
  /** Dot paths into the `tl_game_observe` document (default: state, player, counters, scenes, ui.values). */
  readonly fields?: readonly string[];
  /** Input scripts: also observe right after these run steps (1 = after the run's first step); at most 64. */
  readonly atSteps?: readonly number[];
  /** Also read this object's running script values (the observation's `behaviors`). */
  readonly entityId?: string;
}

/** The game as a driver sees it (one run). */
export interface PlaytestDriverGame {
  /** 1-based run number within its threading mode. */
  readonly run: number;
  /** The threading mode asked for ('project': the project's own setting). */
  readonly threads: PlaytestThreads;
  /** The observation now. Before the run's first `step`, the run starts with one neutral step and holds after it. */
  observe(): Promise<Record<string, unknown>>;
  /** Apply these frames from the next step (the first call restarts the game first), hold after them, and return the observation there. */
  step(frames: readonly PlaytestFrame[]): Promise<Record<string, unknown>>;
  /** `n` neutral steps (no action, no pointer, the pad at rest), then the observation. */
  wait(steps: number): Promise<Record<string, unknown>>;
  /** A line for the result's `log` (at most 64 lines of 256 characters). */
  log(message: string): void;
}

/** A driver: the project's own code that plays the game through `game` and returns what it found (JSON). */
export type PlaytestDriver = (game: PlaytestDriverGame) => Promise<unknown> | unknown;

export type PlaytestThreads = 'project' | 'worker' | 'single';

export interface PlaytestSpec {
  /** Start at this scene (with the start scenes; the character at its first spawn). */
  readonly sceneId?: string;
  /** Start in this game mode. */
  readonly mode?: string;
  /** Script variables (ctx.save) at the start and at every restart. */
  readonly variables?: Readonly<Record<string, unknown>>;
  /** Where the simulation runs: the project's setting, a worker, the page's main thread, or both one after the other (default 'project'). */
  readonly threads?: PlaytestThreads | 'both';
  /** Runs per threading mode (1-8, default 2). */
  readonly runs?: number;
  /** The input script (or a driver). */
  readonly frames?: readonly PlaytestFrame[];
  readonly driver?: PlaytestDriver;
  /** A name for the driver in the result (its path). */
  readonly driverName?: string;
  readonly observe?: PlaytestObserveSpec;
  /** The whole play-test's bound (ms; default 10 minutes, at most 1 hour). */
  readonly timeoutMs?: number;
}

export interface PlaytestObservation {
  readonly runStep: number;
  readonly digest: string;
  readonly fields: Record<string, unknown>;
}

export interface PlaytestRun {
  readonly threads: PlaytestThreads;
  readonly run: number;
  /** Where the simulation ran (the observation's `simulation.mode`). */
  readonly simulation: string | null;
  readonly playSessionId: string;
  /** Observations at the requested steps, then the run's end (input scripts); the end (drivers). */
  readonly observations: PlaytestObservation[];
  /** The run digest after the run's last step. */
  readonly runStep: number;
  readonly digest: string;
  /** A driver's result. */
  readonly result?: unknown;
  /** A driver run: how many exercises it made and a digest of the run digests after each (runs that played alike agree). */
  readonly trace?: { readonly exercises: number; readonly digest: string };
  readonly log?: string[];
  /** Script errors and logs the play reported (the first 16; `errorCount` all). */
  readonly errors: unknown[];
  readonly errorCount: number;
}

export interface PlaytestResult {
  readonly ok: true;
  readonly projectId: string;
  readonly start: { sceneId?: string; mode?: string; variables?: Readonly<Record<string, unknown>> };
  readonly input: { kind: 'frames'; frames: number; steps: number; exercises: number } | { kind: 'driver'; name: string };
  readonly runs: PlaytestRun[];
  /** Every run agrees: the same digest at every observed run step (and, for drivers, at every step call). */
  readonly deterministic: boolean;
  readonly mismatches: string[];
  readonly durationMs: number;
}

export interface PlaytestFailure {
  readonly ok: false;
  readonly error: { readonly code: string; readonly message: string; readonly detail?: unknown };
  /** The runs finished before the failure. */
  readonly runs?: PlaytestRun[];
}

/** The play routes the runner uses (one project). */
export interface PlaytestBackend {
  startPlay(body: Record<string, unknown>): Promise<BackendResponse>;
  stopPlay(playSessionId: string): Promise<BackendResponse>;
  inputRelay(playSessionId: string, body: Record<string, unknown>, timeoutMs: number): Promise<BackendResponse>;
  gameObserve(playSessionId: string, body: Record<string, unknown>): Promise<BackendResponse>;
  diagnostics(playSessionId: string): Promise<BackendResponse>;
}

/** The runner's backend over a `BackendClient` (each relay waits as long as the backend may: 10 s + its span at 30 steps a second). */
export function playtestBackend(client: BackendClient, projectId: string): PlaytestBackend {
  return {
    startPlay: (body) => client.withTimeout(60_000).startPlay(projectId, body),
    stopPlay: (id) => client.stopPlay(projectId, id),
    inputRelay: (id, body, timeoutMs) => client.withTimeout(timeoutMs).inputRelay(projectId, id, body),
    gameObserve: (id, body) => client.gameObserve(projectId, id, body),
    diagnostics: (id) => client.diagnostics(projectId, id),
  };
}

// ---- limits -------------------------------------------------------------------

export const PLAYTEST_MAX_RUNS = 8;
/** An input script covers at most an hour at 120 steps a second. */
export const PLAYTEST_MAX_SCRIPT_STEPS = 432_000;
export const PLAYTEST_MAX_SCRIPT_FRAMES = 20_000;
export const PLAYTEST_MAX_AT_STEPS = 64;
const DEFAULT_FIELDS = ['state', 'player', 'counters', 'scenes', 'ui.values'];
const MAX_FIELDS = 32;
const MAX_LOG_LINES = 64;
const MAX_RESULT_CHARS = 65_536;
const DEFAULT_TIMEOUT_MS = 600_000;
const MAX_TIMEOUT_MS = 3_600_000;
/** A relay body stays under the backend's bound with room for the envelope. */
const CHUNK_BODY_BUDGET = INPUT_RELAY_MAX_BODY_BYTES - 512;
const FRAME_FIELDS = ['stepOffset', 'steps', 'actions', 'pointer', 'gamepad', 'ui'];

type Check<T> = { ok: true; value: T } | { ok: false; message: string };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);

/** Check one frame's shape (the backend checks the values again). `where` names it in messages. */
function checkFrame(raw: unknown, where: string): Check<PlaytestFrame> {
  if (!isObj(raw)) return { ok: false, message: `${where} must be an object` };
  for (const k of Object.keys(raw)) if (!FRAME_FIELDS.includes(k)) return { ok: false, message: `${where}.${k} is not a frame field (${FRAME_FIELDS.join(', ')})` };
  if (!isInt(raw['stepOffset']) || raw['stepOffset'] < 0) return { ok: false, message: `${where}.stepOffset must be an integer >= 0` };
  const steps = raw['steps'];
  if (steps !== undefined && (!isInt(steps) || steps < 1 || steps > INPUT_RELAY_MAX_STEPS)) return { ok: false, message: `${where}.steps must be an integer 1-${INPUT_RELAY_MAX_STEPS}` };
  if (raw['actions'] !== undefined && !isObj(raw['actions'])) return { ok: false, message: `${where}.actions must be an object` };
  if (raw['pointer'] !== undefined && !isObj(raw['pointer'])) return { ok: false, message: `${where}.pointer must be an object { x, y, ... }` };
  if (raw['gamepad'] !== undefined && parseRelayGamepad(raw['gamepad']) === null) return { ok: false, message: `${where}.gamepad must be { buttons?: up to 17 numbers 0-1, axes?: up to 4 numbers -1..1 }` };
  if (raw['ui'] !== undefined && parseRelayUiEdges(raw['ui']) === null) return { ok: false, message: `${where}.ui must be 1-8 of up, down, left, right, submit, cancel, pause` };
  return { ok: true, value: raw as unknown as PlaytestFrame };
}

/** Check a frame list: ascending, no overlap. Returns the frames and where the last ends. */
export function checkFrames(raw: unknown, what: string, maxFrames: number, maxSteps: number): Check<{ frames: PlaytestFrame[]; end: number }> {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > maxFrames) return { ok: false, message: `${what} must be a list of 1-${maxFrames} frames` };
  const frames: PlaytestFrame[] = [];
  let end = 0;
  for (let i = 0; i < raw.length; i += 1) {
    const f = checkFrame(raw[i], `${what}[${i}]`);
    if (!f.ok) return f;
    if (f.value.stepOffset < end) return { ok: false, message: `${what}[${i}] starts at step ${f.value.stepOffset}, inside the frame before it (which ends at ${end}): frames are ascending and do not overlap` };
    end = f.value.stepOffset + (f.value.steps ?? 1);
    if (end > maxSteps) return { ok: false, message: `${what} covers at most ${maxSteps} steps` };
    frames.push(f.value);
  }
  return { ok: true, value: { frames, end } };
}

/** One exercise of a split script: frames re-based to its first step, `length` steps in all. */
export interface ScriptChunk {
  readonly start: number;
  readonly length: number;
  readonly frames: PlaytestFrame[];
  /** Observe after it (a requested step or the script's end). */
  readonly observe: boolean;
}

/**
 * Split an input script into exercises the relay takes (at most 7,200 steps,
 * 600 frames and its body bound each), ending at every requested observation
 * step and at the script's end. Splits fall between frames (never inside a
 * run-length frame); a stretch with no frame is sent as an empty frame, which
 * is exactly a gap (neutral). A pad or pointer button held from one frame
 * into the next starts again after a split (each exercise's pad and pointer
 * start at rest), as they would after a gap.
 */
export function splitScript(frames: readonly PlaytestFrame[], atSteps: readonly number[]): Check<ScriptChunk[]> {
  // The run ends after its last frame, or at the last observation step when that is later (neutral steps up to it).
  const scriptEnd = Math.max(frames.reduce((n, f) => Math.max(n, f.stepOffset + (f.steps ?? 1)), 0), ...atSteps);
  const stops = [...new Set([...atSteps, scriptEnd])].sort((a, b) => a - b);
  const total = stops[stops.length - 1]!;
  for (const s of atSteps) {
    const inside = frames.find((f) => f.stepOffset < s && s < f.stepOffset + (f.steps ?? 1));
    if (inside !== undefined) return { ok: false, message: `observe.atSteps ${s} falls inside the frame at step ${inside.stepOffset} (steps ${inside.steps ?? 1}): observe where no frame is held, or split that frame` };
  }
  const chunks: ScriptChunk[] = [];
  let at = 0;
  let i = 0;
  while (at < total) {
    const stop = stops.find((s) => s > at)!;
    let end = Math.min(stop, at + INPUT_RELAY_MAX_STEPS);
    const out: PlaytestFrame[] = [];
    let bytes = 64;
    let j = i;
    // Take the frames that start before `end`, while they fit (one slot kept for a trailing gap).
    for (; j < frames.length && frames[j]!.stepOffset < end; j += 1) {
      const f = frames[j]!;
      const fEnd = f.stepOffset + (f.steps ?? 1);
      const size = JSON.stringify(f).length + 1;
      if (fEnd > end || out.length >= INPUT_RELAY_MAX_FRAMES - 1 || bytes + size > CHUNK_BODY_BUDGET) {
        // This frame does not fit here: the exercise ends where it starts (or, when it is the first, it fits by itself: <= 7200 steps).
        if (f.stepOffset > at) end = f.stepOffset;
        else if (out.length === 0) {
          out.push({ ...f, stepOffset: 0 });
          end = fEnd;
          j += 1;
        }
        break;
      }
      out.push({ ...f, stepOffset: f.stepOffset - at });
      bytes += size;
    }
    i = j;
    const last = out.length === 0 ? 0 : out[out.length - 1]!.stepOffset + (out[out.length - 1]!.steps ?? 1);
    // A trailing stretch without frames is an empty frame (a gap) so the exercise ends at `end`.
    if (last < end - at) out.push({ stepOffset: last, steps: end - at - last });
    chunks.push({ start: at, length: end - at, frames: out, observe: stops.includes(end) });
    at = end;
  }
  return { ok: true, value: chunks };
}

/** Read a dot path of an observation (null when absent). */
export function pickPath(doc: unknown, path: string): unknown {
  let v: unknown = doc;
  for (const k of path.split('.')) {
    if (!isObj(v) && !Array.isArray(v)) return null;
    v = (v as Record<string, unknown>)[k];
    if (v === undefined) return null;
  }
  return v;
}

/** Check a spec (everything but the driver function). */
export function checkPlaytestSpec(spec: PlaytestSpec): Check<{ threads: PlaytestThreads[]; runs: number; frames: PlaytestFrame[] | null; atSteps: number[]; fields: string[]; timeoutMs: number }> {
  const hasFrames = spec.frames !== undefined;
  const hasDriver = spec.driver !== undefined;
  if (hasFrames === hasDriver) return { ok: false, message: 'give an input script (frames) or a driver, not both' };
  const t = spec.threads ?? 'project';
  if (!['project', 'worker', 'single', 'both'].includes(t)) return { ok: false, message: 'threads must be project, worker, single or both' };
  const threads: PlaytestThreads[] = t === 'both' ? ['worker', 'single'] : [t as PlaytestThreads];
  const runs = spec.runs ?? 2;
  if (!isInt(runs) || runs < 1 || runs > PLAYTEST_MAX_RUNS) return { ok: false, message: `runs must be 1-${PLAYTEST_MAX_RUNS}` };
  let frames: PlaytestFrame[] | null = null;
  if (hasFrames) {
    const f = checkFrames(spec.frames, 'frames', PLAYTEST_MAX_SCRIPT_FRAMES, PLAYTEST_MAX_SCRIPT_STEPS);
    if (!f.ok) return f;
    frames = f.value.frames;
  }
  const o = spec.observe ?? {};
  if (!isObj(o)) return { ok: false, message: 'observe must be an object { fields?, atSteps?, entityId? }' };
  for (const k of Object.keys(o)) if (!['fields', 'atSteps', 'entityId'].includes(k)) return { ok: false, message: `observe.${k} is not an observe field (fields, atSteps, entityId)` };
  const fields = o.fields ?? DEFAULT_FIELDS;
  if (!Array.isArray(fields) || fields.length > MAX_FIELDS || fields.some((p) => typeof p !== 'string' || !/^[A-Za-z0-9_$-]+(\.[A-Za-z0-9_$-]+)*$/.test(p))) {
    return { ok: false, message: `observe.fields must be at most ${MAX_FIELDS} dot paths into the tl_game_observe document (e.g. "player", "ui.values", "run.digest")` };
  }
  const atSteps = o.atSteps ?? [];
  if (!Array.isArray(atSteps) || atSteps.length > PLAYTEST_MAX_AT_STEPS || atSteps.some((s) => !isInt(s) || s < 1 || s > PLAYTEST_MAX_SCRIPT_STEPS)) {
    return { ok: false, message: `observe.atSteps must be at most ${PLAYTEST_MAX_AT_STEPS} run steps 1-${PLAYTEST_MAX_SCRIPT_STEPS}` };
  }
  if (atSteps.length > 0 && hasDriver) return { ok: false, message: 'observe.atSteps goes with an input script (a driver observes where it wants)' };
  if (o.entityId !== undefined && (typeof o.entityId !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(o.entityId))) return { ok: false, message: 'observe.entityId must be an entity id' };
  const timeoutMs = spec.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!isInt(timeoutMs) || timeoutMs < 10_000 || timeoutMs > MAX_TIMEOUT_MS) return { ok: false, message: `timeoutMs must be 10000-${MAX_TIMEOUT_MS}` };
  if (spec.variables !== undefined && !isObj(spec.variables)) return { ok: false, message: 'variables must be an object {key: JSON value}' };
  return { ok: true, value: { threads, runs, frames, atSteps: [...atSteps].sort((a, b) => a - b), fields: [...fields], timeoutMs } };
}

class PlaytestError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly detail?: unknown,
  ) {
    super(message);
  }
}

const sleep = (ms: number): Promise<void> => new Promise((ok) => setTimeout(ok, ms));

/** 32-bit FNV-1a in two lanes over text (a driver run's trace of run digests). */
class TextHash {
  private a = 0x811c9dc5;
  private b = 0x050c5d1f;
  text(s: string): void {
    for (let i = 0; i <= s.length; i += 1) {
      const c = i === s.length ? 0x0a : s.charCodeAt(i) & 0xff;
      this.a = Math.imul(this.a ^ c, 0x01000193) >>> 0;
      this.b = Math.imul(this.b ^ c, 0x01000193) >>> 0;
    }
  }
  hex(): string {
    return this.a.toString(16).padStart(8, '0') + this.b.toString(16).padStart(8, '0');
  }
}

function backendError(what: string, res: BackendResponse): PlaytestError {
  const body = isObj(res.body) ? res.body : {};
  const e = isObj(body['error']) ? body['error'] : {};
  const code = typeof e['code'] === 'string' ? e['code'] : `http_${res.status}`;
  const message = typeof e['message'] === 'string' ? e['message'] : `status ${res.status}`;
  return new PlaytestError(code, `${what}: ${message}`, body);
}

/** The run digest block of an observation. */
interface RunBlock {
  runStep: number;
  digest: string;
  lastInput?: { toStep: number; runStep: number; digest: string; held?: boolean };
}

/** Run a play-test. Never throws: a failure is `{ ok: false, error }` (with the runs finished before it). */
export async function runPlaytest(backend: PlaytestBackend, projectId: string, spec: PlaytestSpec): Promise<PlaytestResult | PlaytestFailure> {
  const checked = checkPlaytestSpec(spec);
  if (!checked.ok) return { ok: false, error: { code: 'playtest_invalid', message: checked.message } };
  const { threads, runs, frames, atSteps, fields, timeoutMs } = checked.value;
  let chunks: ScriptChunk[] = [];
  if (frames !== null) {
    const split = splitScript(frames, atSteps);
    if (!split.ok) return { ok: false, error: { code: 'playtest_invalid', message: split.message } };
    chunks = split.value;
  }
  const began = Date.now();
  const deadline = began + timeoutMs;
  const left = (): number => deadline - Date.now();
  const done: PlaytestRun[] = [];
  const entity = spec.observe?.entityId;

  const observe = async (playSessionId: string): Promise<Record<string, unknown>> => {
    const res = await backend.gameObserve(playSessionId, entity !== undefined ? { entityId: entity } : {});
    if (!isObj(res.body) || res.body['ok'] !== true) throw backendError('observe', res);
    return res.body;
  };
  const runOf = (o: Record<string, unknown>): RunBlock => {
    const r = o['run'];
    if (!isObj(r) || typeof r['digest'] !== 'string') throw new PlaytestError('playtest_no_digest', 'the observation carries no run digest (an engine without run digests?)');
    return r as unknown as RunBlock;
  };
  const pick = (o: Record<string, unknown>): Record<string, unknown> => Object.fromEntries(fields.map((p) => [p, pickPath(o, p)]));

  /** One exercise with hold; resolves with the observation once the game holds right after its last step. */
  const exercise = async (playSessionId: string, fs: readonly PlaytestFrame[], restart: boolean): Promise<Record<string, unknown>> => {
    const span = fs.reduce((n, f) => Math.max(n, f.stepOffset + (f.steps ?? 1)), 0);
    const wait = 15_000 + Math.ceil((span / 30) * 1000);
    if (left() < wait) throw new PlaytestError('playtest_timeout', `the play-test ran out of time (timeoutMs ${timeoutMs})`);
    const body = { mode: 'exclusive-test', frames: fs, hold: true, ...(restart ? { restart: true } : {}) };
    const res = await backend.inputRelay(playSessionId, body, wait);
    if (!isObj(res.body) || res.body['ok'] !== true) throw backendError('input exercise', res);
    const to = Number(res.body['appliedToStep']);
    // The digest is taken right after the last step, where the game then holds.
    const until = Date.now() + 10_000;
    for (;;) {
      const o = await observe(playSessionId);
      const r = runOf(o);
      if (r.lastInput !== undefined && r.lastInput.toStep === to && r.lastInput.held === true) return o;
      if (Date.now() > until) throw new PlaytestError('playtest_hold_lost', `the game did not hold after step ${to} (another exercise or the debugger let it go?)`, { run: r });
      await sleep(25);
    }
  };

  const errorsOf = async (playSessionId: string): Promise<{ errors: unknown[]; errorCount: number }> => {
    const res = await backend.diagnostics(playSessionId);
    const d = isObj(res.body) ? res.body['diagnostics'] : undefined;
    const rt = isObj(d) ? d['runtime'] : undefined;
    const list = isObj(rt) && Array.isArray(rt['errors']) ? (rt['errors'] as unknown[]) : [];
    return { errors: list.slice(0, 16), errorCount: list.length };
  };

  for (const mode of threads) {
    const options: Record<string, unknown> = { demo: false };
    if (spec.sceneId !== undefined) options['sceneId'] = spec.sceneId;
    if (spec.mode !== undefined) options['mode'] = spec.mode;
    if (spec.variables !== undefined) options['variables'] = spec.variables;
    if (mode !== 'project') options['threads'] = mode;
    const started = await backend.startPlay({ options });
    if (!isObj(started.body) || started.body['ok'] !== true) {
      const e = backendError('play start', started);
      return { ok: false, error: { code: e.code, message: e.message, detail: e.detail }, runs: done };
    }
    const playSessionId = String(started.body['playSessionId']);
    try {
      // Wait for the game to run (the headless editor may be opening; the page loads the game).
      let first: Record<string, unknown> | null = null;
      while (first === null) {
        if (left() < 0) throw new PlaytestError('playtest_timeout', 'the play did not start running in time');
        const res = await backend.gameObserve(playSessionId, {});
        if (isObj(res.body) && res.body['ok'] === true) {
          if (res.body['state'] === 'running') first = res.body;
          else if (res.body['state'] === 'paused') throw new PlaytestError('playtest_paused', 'the game starts paused (a title screen or a pause screen holds it): a run restarts the game and needs it running; start past it (sceneId) or give the shell no title screen for the test');
        } else if (isObj(res.body) && isObj(res.body['error']) && res.body['error']['code'] === 'play_not_found') {
          throw backendError('the play ended before it ran', res);
        }
        if (first === null) await sleep(200);
      }
      const simulation = isObj(first['simulation']) && typeof first['simulation']['mode'] === 'string' ? first['simulation']['mode'] : null;
      for (let run = 1; run <= runs; run += 1) {
        const observations: PlaytestObservation[] = [];
        let last: Record<string, unknown> | null = null;
        let result: unknown;
        const log: string[] = [];
        let driverTrace: { exercises: number; digest: string } | null = null;
        if (frames !== null) {
          for (let c = 0; c < chunks.length; c += 1) {
            const chunk = chunks[c]!;
            last = await exercise(playSessionId, chunk.frames, c === 0);
            // The run step as the game counts it (a restart inside the run, e.g. a shell's New game, counts from there).
            const r = runOf(last);
            if (chunk.observe) observations.push({ runStep: r.lastInput!.runStep, digest: r.lastInput!.digest, fields: pick(last) });
          }
        } else {
          let started = false;
          let steps = 0;
          const trace = { exercises: 0, hash: new TextHash() };
          const stepWith = async (fs: readonly PlaytestFrame[]): Promise<Record<string, unknown>> => {
            const f = checkFrames(fs, 'step frames', INPUT_RELAY_MAX_FRAMES, INPUT_RELAY_MAX_STEPS);
            if (!f.ok) throw new PlaytestError('playtest_driver_frames', f.message);
            steps += f.value.end;
            if (steps > PLAYTEST_MAX_SCRIPT_STEPS) throw new PlaytestError('playtest_driver_frames', `a driver run covers at most ${PLAYTEST_MAX_SCRIPT_STEPS} steps`);
            last = await exercise(playSessionId, f.value.frames, !started);
            started = true;
            const r = runOf(last);
            trace.exercises += 1;
            trace.hash.text(`${r.lastInput!.runStep}:${r.lastInput!.digest}`);
            return last;
          };
          const game: PlaytestDriverGame = {
            run,
            threads: mode,
            observe: async () => (started ? observe(playSessionId) : stepWith([{ stepOffset: 0 }])),
            step: (fs) => stepWith(fs),
            wait: (n) => {
              if (!isInt(n) || n < 1 || n > INPUT_RELAY_MAX_STEPS) throw new PlaytestError('playtest_driver_frames', `wait takes 1-${INPUT_RELAY_MAX_STEPS} steps`);
              return stepWith([{ stepOffset: 0, steps: n }]);
            },
            log: (m) => {
              if (log.length < MAX_LOG_LINES) log.push(String(m).slice(0, 256));
            },
          };
          try {
            result = await spec.driver!(game);
          } catch (e) {
            if (e instanceof PlaytestError) throw e;
            throw new PlaytestError('playtest_driver_failed', `the driver threw: ${e instanceof Error ? e.message : String(e)}`.slice(0, 512));
          }
          if (result !== undefined) {
            let text: string | undefined;
            try {
              text = JSON.stringify(result);
            } catch {
              text = undefined;
            }
            if (text === undefined) result = null;
            else if (text.length > MAX_RESULT_CHARS) throw new PlaytestError('playtest_driver_result', `the driver's result is larger than ${MAX_RESULT_CHARS} characters of JSON`);
            else result = JSON.parse(text) as unknown;
          }
          if (!started) await stepWith([{ stepOffset: 0 }]);
          const r = runOf(last!);
          observations.push({ runStep: r.lastInput!.runStep, digest: r.lastInput!.digest, fields: pick(last!) });
          driverTrace = { exercises: trace.exercises, digest: trace.hash.hex() };
        }
        const end = runOf(last!);
        const errs = await errorsOf(playSessionId);
        done.push({
          threads: mode,
          run,
          simulation,
          playSessionId,
          observations,
          runStep: end.lastInput!.runStep,
          digest: end.lastInput!.digest,
          ...(frames === null ? { result: result ?? null, log, ...(driverTrace !== null ? { trace: driverTrace } : {}) } : {}),
          ...errs,
        });
      }
    } catch (e) {
      await backend.stopPlay(playSessionId).catch(() => undefined);
      const err = e instanceof PlaytestError ? e : new PlaytestError('playtest_failed', e instanceof Error ? e.message : String(e));
      return { ok: false, error: { code: err.code, message: err.message, ...(err.detail !== undefined ? { detail: err.detail } : {}) }, runs: done };
    }
    await backend.stopPlay(playSessionId).catch(() => undefined);
  }

  // Every run against the first: the same digests at the same run steps.
  const mismatches: string[] = [];
  const base = done[0]!;
  for (const r of done.slice(1)) {
    const name = `${r.threads} run ${r.run}`;
    if (r.observations.length !== base.observations.length) mismatches.push(`${name}: ${r.observations.length} observations, the first run ${base.observations.length}`);
    const n = Math.min(r.observations.length, base.observations.length);
    for (let i = 0; i < n; i += 1) {
      const a = base.observations[i]!;
      const b = r.observations[i]!;
      if (a.runStep !== b.runStep || a.digest !== b.digest) {
        mismatches.push(`${name}: at run step ${b.runStep} digest ${b.digest}, the first run at ${a.runStep} ${a.digest}`);
        break;
      }
    }
    if (base.trace !== undefined && r.trace !== undefined && (base.trace.exercises !== r.trace.exercises || base.trace.digest !== r.trace.digest)) {
      mismatches.push(`${name}: the driver's steps went otherwise (${r.trace.exercises} exercises, trace ${r.trace.digest}; the first run ${base.trace.exercises}, ${base.trace.digest})`);
    }
  }
  const input: PlaytestResult['input'] =
    frames !== null ? { kind: 'frames', frames: frames.length, steps: chunks.reduce((n, c) => n + c.length, 0), exercises: chunks.length } : { kind: 'driver', name: spec.driverName ?? 'driver' };
  return {
    ok: true,
    projectId,
    start: { ...(spec.sceneId !== undefined ? { sceneId: spec.sceneId } : {}), ...(spec.mode !== undefined ? { mode: spec.mode } : {}), ...(spec.variables !== undefined ? { variables: spec.variables } : {}) },
    input,
    runs: done,
    deterministic: mismatches.length === 0,
    mismatches,
    durationMs: Date.now() - began,
  };
}

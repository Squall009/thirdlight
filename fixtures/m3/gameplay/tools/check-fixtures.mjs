/**
 * fixtures/m3/gameplay/tools/check-fixtures.mjs
 *
 * Fixture consistency checker for packet 40's PROPOSED gameplay/respawn/camera
 * contract (docs/planning/m3-contracts/gameplay.md and
 * docs/planning/m3-contracts/diffs/runtime.md).
 *
 * This is fixture tooling, NOT an implementation of the contract. It contains
 * no runtime, no physics port, no renderer and no editor code. It verifies that
 * the committed fixtures are internally consistent and that every declared
 * expectation is re-derivable from the rules of `gameplay.md`:
 *
 *  1. canonical bytes (2-space indent, LF, one trailing newline, no BOM, no
 *     trailing whitespace) + a strict parser with duplicate-key rejection;
 *  2. index coverage of both fixture roots (`fixtures/m3/gameplay`,
 *     `fixtures/m3/camera`) and every index `sha256`/`bytes`;
 *  3. the swept upright-capsule vs axis-aligned XY zone predicate
 *     (`gameplay.md` §4.2) re-derived for every zone fixture, including the
 *     tangency bucket and the same-step precedence/stable-ID tie rules;
 *  4. the run state machine, the bounded respawn delay and the event bound
 *     (`gameplay.md` §2/§6) replayed from state fixtures;
 *  5. the M3 effective-frame overrides (`gameplay.md` §2.5);
 *  6. the last-committed-state claim for every failure phase
 *     (`gameplay.md` §5.4/§10);
 *  7. the camera follow/dead-zone/smoothing/bounds/frustum math
 *     (`gameplay.md` §7.2–§7.4) re-derived for every camera fixture;
 *  8. the error-code registry (`gameplay.md` §8.1).
 *
 * Usage (repository root):
 *   node fixtures/m3/gameplay/tools/check-fixtures.mjs
 *   TL40_FIXTURE_ROOT=<copy> node fixtures/m3/gameplay/tools/check-fixtures.mjs
 *   node fixtures/m3/gameplay/tools/check-fixtures.mjs --report out.json
 *   node fixtures/m3/gameplay/tools/check-fixtures.mjs --emit        (derivation only)
 *
 * Exit 0 = all checks passed; 1 = at least one check failed. The negative
 * control in verification.md copies the tree, corrupts one byte and runs this
 * checker against the copy; it must exit non-zero.
 *
 * Node: pinned Node 22 (`package.json` engines). No dependency, no eval.
 */

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE_ROOT = process.env.TL40_FIXTURE_ROOT
  ? resolve(process.env.TL40_FIXTURE_ROOT)
  : resolve(HERE, '..', '..');                 // fixtures/m3
const GAMEPLAY_ROOT = join(FIXTURE_ROOT, 'gameplay');
const CAMERA_ROOT = join(FIXTURE_ROOT, 'camera');
const EMIT = process.argv.includes('--emit');
const reportArg = process.argv.indexOf('--report');
const REPORT = reportArg >= 0 ? process.argv[reportArg + 1] : null;

const failures = [];
const passes = [];
const derived = {};
const seenGroups = new Set();
const fail = (check, detail) => failures.push({ check, detail });
const pass = (check, detail) => passes.push({ check, detail: detail ?? null });
const markGroup = (g) => seenGroups.add(g);
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const jp = (v) => JSON.stringify(v);
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

// ---------------------------------------------------------------------------
// contract constants (gameplay.md §4.2, §8.2, §7.1)
// ---------------------------------------------------------------------------
const CAPSULE_RADIUS = 0.3;
const CAPSULE_HALF_HEIGHT = 0.6;
const ZONE_OVERLAP_EPS = 1e-9;
const RESPAWN_DELAY_STEPS = 30;
const MAX_GAME_EVENTS = 32;
const SIM_HZ = 120;              // accepted runtime.md §5 fixed step (gameplay.md §3.2)
const CAMERA_Z = 12;
const CAMERA_MAX_STEP = 4;
const CAMERA_SNAP_EPS = 1e-9;
const DEFAULT_ASPECT = 16 / 9;
const MAX_VIEWPORT = 16384;

const NEW_ERROR_CODES = {
  game_command_invalid: { cls: 'validation', reasons: ['state', 'pending', 'unknown'], destination: 'runtime.md §8' },
  game_spawn_invalid: { cls: 'validation', reasons: ['reference', 'outside_level'], destination: 'runtime.md §8/§13' },
  game_spawn_blocked: {
    cls: 'unavailable',
    reasons: ['blocked', 'no_support', 'hazard', 'query_failed'],
    destination: 'runtime.md §8/§13',
  },
  camera_viewport_invalid: { cls: 'validation', reasons: [], destination: 'runtime.md §8' },
  game_session_unavailable: { cls: 'validation', reasons: ['schedule'], destination: 'runtime.md §8' },
};
const ACCEPTED_REASON_ADDITIONS = {
  module_error: ['gameplay_invalid'],
  physics_port_error: ['reset'],
};

// ---------------------------------------------------------------------------
// strict JSON parser (duplicate keys rejected, no eval)
// ---------------------------------------------------------------------------
function parseStrict(text) {
  let i = 0;
  const err = (msg) => {
    throw new Error(`${msg} at offset ${i}`);
  };
  const ws = () => {
    while (i < text.length && (text[i] === ' ' || text[i] === '\n' || text[i] === '\t' || text[i] === '\r')) i += 1;
  };
  const string = () => {
    if (text[i] !== '"') err('expected string');
    i += 1;
    let out = '';
    while (i < text.length) {
      const c = text[i];
      if (c === '\\') {
        const n = text[i + 1];
        if (n === 'u') {
          out += String.fromCharCode(parseInt(text.slice(i + 2, i + 6), 16));
          i += 6;
          continue;
        }
        const map = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
        if (!(n in map)) err('bad escape');
        out += map[n];
        i += 2;
        continue;
      }
      if (c === '"') {
        i += 1;
        return out;
      }
      out += c;
      i += 1;
    }
    return err('unterminated string');
  };
  const value = () => {
    ws();
    const c = text[i];
    if (c === '{') {
      i += 1;
      const obj = {};
      const keys = new Set();
      ws();
      if (text[i] === '}') {
        i += 1;
        return obj;
      }
      for (;;) {
        ws();
        const k = string();
        if (keys.has(k)) err(`duplicate key ${jp(k)}`);
        keys.add(k);
        ws();
        if (text[i] !== ':') err('expected :');
        i += 1;
        obj[k] = value();
        ws();
        if (text[i] === ',') {
          i += 1;
          continue;
        }
        if (text[i] === '}') {
          i += 1;
          return obj;
        }
        return err('expected , or }');
      }
    }
    if (c === '[') {
      i += 1;
      const arr = [];
      ws();
      if (text[i] === ']') {
        i += 1;
        return arr;
      }
      for (;;) {
        arr.push(value());
        ws();
        if (text[i] === ',') {
          i += 1;
          continue;
        }
        if (text[i] === ']') {
          i += 1;
          return arr;
        }
        return err('expected , or ]');
      }
    }
    if (c === '"') return string();
    if (text.startsWith('true', i)) {
      i += 4;
      return true;
    }
    if (text.startsWith('false', i)) {
      i += 5;
      return false;
    }
    if (text.startsWith('null', i)) {
      i += 4;
      return null;
    }
    const m = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(text.slice(i));
    if (!m) return err('unexpected token');
    i += m[0].length;
    return Number(m[0]);
  };
  const out = value();
  ws();
  if (i !== text.length) err('trailing content');
  return out;
}

function walkFiles(root, out = []) {
  for (const name of readdirSync(root).sort()) {
    const p = join(root, name);
    const st = statSync(p);
    if (st.isDirectory()) walkFiles(p, out);
    else out.push(p);
  }
  return out;
}

function canonicalBytes(buf) {
  const problems = [];
  if (buf.length === 0) return ['empty file'];
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) problems.push('BOM');
  if (buf.includes(0x0d)) problems.push('CR');
  if (buf[buf.length - 1] !== 0x0a) problems.push('missing trailing newline');
  const text = buf.toString('utf8');
  for (const [n, line] of text.split('\n').entries()) {
    if (/[ \t]+$/.test(line)) problems.push(`trailing whitespace line ${n + 1}`);
  }
  if (text.includes('\t')) problems.push('tab character');
  // 2-space indent canonical form
  for (const line of text.split('\n')) {
    const m = /^( +)/.exec(line);
    if (m && m[1].length % 2 !== 0) problems.push(`odd indent: ${jp(line.slice(0, 20))}`);
  }
  if (text.trim() !== JSON.stringify(JSON.parse(text), null, 2)) problems.push('not 2-space canonical');
  return problems;
}

function checkIndex(rootName, root) {
  const indexPath = join(root, 'index.json');
  let index;
  try {
    index = parseStrict(readFileSync(indexPath, 'utf8'));
  } catch (e) {
    fail(`index[${rootName}]`, `cannot read/parse index.json: ${e.message}`);
    return new Map();
  }
  markGroup(`index[${rootName}]`);
  const declared = new Map();
  for (const [rel, meta] of Object.entries(index.fixtures ?? {})) {
    declared.set(rel, meta);
    const p = join(root, rel);
    let buf;
    try {
      buf = readFileSync(p);
    } catch {
      fail(`index[${rootName}]`, `declared fixture missing: ${rel}`);
      continue;
    }
    if (meta.bytes !== undefined && meta.bytes !== buf.length) {
      fail(`index[${rootName}]`, `${rel} bytes ${buf.length} != declared ${meta.bytes}`);
    }
    if (meta.sha256 !== undefined && sha256(buf) !== meta.sha256) {
      fail(`index[${rootName}]`, `${rel} sha256 mismatch`);
    }
    const problems = canonicalBytes(buf);
    if (problems.length) fail(`canonical[${rootName}]`, `${rel}: ${problems.join(', ')}`);
  }
  // orphan check
  const skip = new Set(['index.json', 'README.md', 'verification.md', 'tools', 'tools/check-fixtures.mjs']);
  for (const p of walkFiles(root)) {
    const rel = relative(root, p).split('\\').join('/');
    if (skip.has(rel) || rel.startsWith('tools/')) continue;
    if (!declared.has(rel)) fail(`index[${rootName}]`, `orphan fixture not in index: ${rel}`);
  }
  pass(`index[${rootName}]`, `${declared.size} indexed fixtures, digests and canonical bytes`);
  return declared;
}

function load(rel) {
  const p = join(GAMEPLAY_ROOT, rel);
  return parseStrict(readFileSync(p, 'utf8'));
}

function loadCamera(rel) {
  const p = join(CAMERA_ROOT, rel);
  return parseStrict(readFileSync(p, 'utf8'));
}

// ---------------------------------------------------------------------------
// zones (gameplay.md §4)
// ---------------------------------------------------------------------------
function zoneHalf(zone) {
  return [zone.size[0] / 2, zone.size[1] / 2];
}

function zoneTest(from, to, zone) {
  const [hx, hy] = zoneHalf(zone);
  const [cx, cy] = zone.center;
  const rx0 = Math.min(from[0], to[0]);
  const rx1 = Math.max(from[0], to[0]);
  const ry0 = Math.min(from[1], to[1]) - CAPSULE_HALF_HEIGHT;
  const ry1 = Math.max(from[1], to[1]) + CAPSULE_HALF_HEIGHT;
  const zx0 = cx - hx;
  const zx1 = cx + hx;
  const zy0 = cy - hy;
  const zy1 = cy + hy;
  const dx = Math.max(0, rx0 - zx1, zx0 - rx1);
  const dy = Math.max(0, ry0 - zy1, zy0 - ry1);
  const d = Math.sqrt(dx * dx + dy * dy);
  const overlap = d < CAPSULE_RADIUS - ZONE_OVERLAP_EPS;
  const tangent = Math.abs(d - CAPSULE_RADIUS) <= ZONE_OVERLAP_EPS;
  const classification = overlap ? 'overlap' : tangent ? 'tangent' : 'separate';
  return { dx, dy, d, overlap, tangent, classification };
}

function byId(a, b) {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Same-step decision (gameplay.md §4.3); `zones` is the frozen ID-ordered list. */
function decide(run, cfg, from, to) {
  const touches = cfg.zones.map((z) => ({ zone: z, hit: zoneTest(from, to, z) }));
  const hazards = touches.filter((t) => t.hit.overlap && t.zone.role === 'hazard');
  if (hazards.length) {
    const z = hazards.map((h) => h.zone).sort(byId)[0];
    return { kind: 'death', cause: 'hazard', zoneId: z.id };
  }
  if (to[1] < cfg.killY) return { kind: 'death', cause: 'fall' };
  const checkpoint = touches.find((t) => t.hit.overlap && t.zone.role === 'checkpoint');
  if (run.checkpointId === null && checkpoint) {
    return { kind: 'checkpoint', zoneId: checkpoint.zone.id };
  }
  const goals = touches.filter((t) => t.hit.overlap && t.zone.role === 'goal').map((t) => t.zone).sort(byId);
  if (goals.length) return { kind: 'goal', zoneId: goals[0].id };
  return { kind: null };
}

// ---------------------------------------------------------------------------
// the run engine (gameplay.md §2/§6) — fixture replay only
// ---------------------------------------------------------------------------
class Run {
  constructor(cfg) {
    this.cfg = cfg;
    this.snapshotId = cfg.snapshotId;
    this.state = 'awaitingStart';
    this.epoch = 0;
    this.checkpointId = null;
    this.goalReached = false;
    this.deathCount = 0;
    this.respawnAtStep = null;
    this.nextStep = cfg.firstStep ?? 0;
    this.events = [];
    this.eventCount = 0;
    this.eventDropped = 0;
    this.failed = false;
    this.failure = null;
    this.pending = [];
    this.firstLive = null;
  }

  get runId() {
    return `${this.snapshotId}#${this.epoch}`;
  }

  emit(kind, stepIndex, boundary, extra = {}) {
    this.eventCount += 1;
    const event = {
      id: `${this.runId}/${kind}/${stepIndex}`,
      kind,
      stepIndex,
      boundary,
      deathCount: this.deathCount,
      ...extra,
    };
    this.events.push(event);
    if (this.events.length > MAX_GAME_EVENTS) {
      this.events.shift();
      this.eventDropped += 1;
    }
    return event;
  }

  submit(command) {
    if (this.pending.includes(command)) return { ok: true, coalesced: true };
    if (this.pending.length > 0) {
      return { ok: false, error: { code: 'game_command_invalid', reason: 'pending', command } };
    }
    if (command === 'start' && this.state !== 'awaitingStart') {
      return { ok: false, error: { code: 'game_command_invalid', reason: 'state', command, state: this.state } };
    }
    if (command === 'replay' && !['playing', 'respawning', 'won'].includes(this.state)) {
      return { ok: false, error: { code: 'game_command_invalid', reason: 'state', command, state: this.state } };
    }
    this.pending.push(command);
    return { ok: true };
  }

  /** The step boundary (gameplay.md §3.2 item 0). */
  boundary() {
    const stepIndex = this.nextStep;
    const notes = [];
    while (this.pending.length) {
      const command = this.pending.shift();
      if (command === 'start') {
        this.state = 'playing';
        this.firstLive = stepIndex;
        notes.push(this.emit('runStarted', stepIndex, true));
      } else if (command === 'replay') {
        this.epoch += 1;
        this.checkpointId = null;
        this.deathCount = 0;
        this.goalReached = false;
        this.respawnAtStep = null;
        this.state = 'playing';
        this.firstLive = stepIndex;
        notes.push(this.emit('replayed', stepIndex, true));
      }
    }
    if (this.respawnAtStep !== null && this.respawnAtStep === stepIndex) {
      this.respawnAtStep = null;
      this.state = 'playing';
      this.firstLive = stepIndex;
      notes.push(this.emit('respawned', stepIndex, true));
    }
    return notes;
  }

  step(from, to) {
    const stepIndex = this.nextStep;
    const boundaryEvents = this.boundary();
    let decision = { kind: null };
    let evaluated = this.state === 'playing';
    if (this.state === 'playing') {
      decision = decide(this, this.cfg, from, to);
      if (decision.kind === 'death') {
        this.deathCount += 1;
        this.respawnAtStep = stepIndex + 1 + RESPAWN_DELAY_STEPS;
        this.state = 'respawning';
        this.emit('died', stepIndex, false, {
          ...(decision.zoneId ? { zoneId: decision.zoneId } : {}),
          cause: decision.cause,
        });
      } else if (decision.kind === 'checkpoint') {
        this.checkpointId = decision.zoneId;
        this.emit('checkpointActivated', stepIndex, false, { zoneId: decision.zoneId });
      } else if (decision.kind === 'goal') {
        this.goalReached = true;
        this.state = 'won';
        this.emit('goalReached', stepIndex, false, { zoneId: decision.zoneId });
      }
    }
    this.nextStep += 1;
    return { boundaryEvents, decision, evaluated, view: this.view() };
  }

  fail(where) {
    const stepIndex = this.nextStep;
    const table = {
      intent: { code: 'module_error', reason: 'module_threw' },
      controller: { code: 'module_error', reason: 'module_threw' },
      physics: { code: 'physics_port_error', reason: 'result' },
      transform: { code: 'module_error', reason: 'phase_violation' },
      gameplay: { code: 'module_error', reason: 'gameplay_invalid' },
      camera: { code: 'module_error', reason: 'phase_violation' },
      commit: { code: 'module_error', reason: 'phase_violation' },
      'reset:R1': { code: 'game_spawn_invalid', reason: 'reference' },
      'reset:R2': { code: 'game_spawn_blocked', reason: 'hazard' },
      'reset:R3': { code: 'game_spawn_blocked', reason: 'blocked' },
      'reset:R4': { code: 'physics_port_error', reason: 'reset' },
      'reset:R5': { code: 'physics_port_error', reason: 'reset' },
      'reset:R6': { code: 'module_error', reason: 'module_threw' },
      'reset:R7': { code: 'module_error', reason: 'phase_violation' },
      'reset:R8': { code: 'module_error', reason: 'phase_violation' },
    };
    if (!(where in table)) throw new Error(`unknown failure phase ${jp(where)}`);
    this.failed = true;
    this.failure = { ...table[where], stepIndex, phase: where };
    return this.view();
  }

  view() {
    return {
      runId: this.runId,
      snapshotId: this.snapshotId,
      replayEpoch: this.epoch,
      state: this.state,
      stepIndex: this.nextStep,
      activeSpawnId: this.checkpointId === null ? this.cfg.spawnId : this.cfg.safeSpawnId,
      checkpointId: this.checkpointId,
      checkpointActive: this.checkpointId !== null,
      goalReached: this.goalReached,
      deathCount: this.deathCount,
      respawnAtStep: this.respawnAtStep,
      events: this.events,
      eventCount: this.eventCount,
      eventDropped: this.eventDropped,
      failed: this.failed,
      ...(this.failure ? { failure: this.failure } : {}),
    };
  }
}

function runScript(cfg, script) {
  const run = new Run(cfg);
  const trace = [];
  const apply = (ops) => {
    for (const op of ops) {
      if (op.op === 'submit') {
        const r = run.submit(op.command);
        if (op.expectError) {
          markGroup(`run-error[${cfg.caseId}]`);
          if (!eq(r.error, op.expectError)) fail('run-error', `${cfg.caseId}: ${jp(r.error)} != ${jp(op.expectError)}`);
        } else if (!r.ok) {
          fail('run-script', `${cfg.caseId}: submit rejected: ${jp(r.error)}`);
        }
      } else if (op.op === 'step') {
        const r = run.step(op.from, op.to);
        trace.push({ stepIndex: r.view.stepIndex - 1, state: run.state, evaluated: r.evaluated });
      } else if (op.op === 'steps') {
        for (let k = 0; k < op.count; k += 1) {
          const r = run.step(op.from, op.to);
          trace.push({ stepIndex: r.view.stepIndex - 1, state: run.state, evaluated: r.evaluated });
        }
      } else if (op.op === 'repeat') {
        for (let k = 0; k < op.count; k += 1) apply(op.ops);
      } else if (op.op === 'fail') {
        run.fail(op.where);
      } else {
        throw new Error(`unknown op ${jp(op.op)}`);
      }
    }
  };
  apply(script);
  return { run, trace };
}

function compareSubset(actual, expected, path, caseId, group) {
  if (expected === undefined) return;
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual) || actual.length !== expected.length) {
      fail(group, `${caseId}${path}: length ${actual?.length} != ${expected.length}`);
      return;
    }
    expected.forEach((v, i) => compareSubset(actual[i], v, `${path}[${i}]`, caseId, group));
    return;
  }
  if (expected !== null && typeof expected === 'object') {
    for (const k of Object.keys(expected)) {
      if (!(k in (actual ?? {}))) {
        fail(group, `${caseId}${path}: missing key ${jp(k)}`);
        continue;
      }
      compareSubset(actual[k], expected[k], `${path}.${k}`, caseId, group);
    }
    return;
  }
  if (!Object.is(actual, expected)) {
    fail(group, `${caseId}${path}: ${jp(actual)} != expected ${jp(expected)}`);
  }
}

// ---------------------------------------------------------------------------
// camera math (gameplay.md §7)
// ---------------------------------------------------------------------------
function frustum(fovY, width, height) {
  const aspect = width / height;
  const halfH = CAMERA_Z * Math.tan((fovY * Math.PI) / 180 / 2);
  return { aspect, halfW: halfH * aspect, halfH };
}

function clamp(v, min, max) {
  return v < min ? min : v > max ? max : v;
}

function clampFrustum(v, min, max, half) {
  return max - min >= 2 * half ? clamp(v, min + half, max - half) : (min + max) / 2;
}

function overflow(v, h) {
  return v > h ? v - h : v < -h ? v + h : 0;
}

function cameraStep(state, player, opts) {
  const { dz, smoothing, bounds, level, snap } = opts;
  const { halfW, halfH } = frustum(opts.fovY, opts.width, opts.height);
  const C = state;
  const Tx = C[0] + overflow(player[0] - C[0], dz[0]);
  const Ty = C[1] + overflow(player[1] - C[1], dz[1]);
  const hard = snap === true || smoothing === 0;
  let Sx = hard ? Tx : C[0] + smoothing * (Tx - C[0]);
  let Sy = hard ? Ty : C[1] + smoothing * (Ty - C[1]);
  const capped = [
    C[0] + clamp(Sx - C[0], -CAMERA_MAX_STEP, CAMERA_MAX_STEP),
    C[1] + clamp(Sy - C[1], -CAMERA_MAX_STEP, CAMERA_MAX_STEP),
  ];
  const S = hard ? [Sx, Sy] : capped;
  const A = [clamp(S[0], bounds.minX, bounds.maxX), clamp(S[1], bounds.minY, bounds.maxY)];
  const P = [
    clampFrustum(A[0], level.minX, level.maxX, halfW),
    clampFrustum(A[1], level.minY, level.maxY, halfH),
  ];
  const moved = Math.abs(P[0] - C[0]) > CAMERA_SNAP_EPS || Math.abs(P[1] - C[1]) > CAMERA_SNAP_EPS;
  return {
    target: [Tx, Ty],
    smoothed: [Sx, Sy],
    capped: S,
    bounded: A,
    clamped: P,
    position: moved ? P : [C[0], C[1]],
    moved,
    halfW,
    halfH,
  };
}

function cameraCase(c) {
  const opts = {
    fovY: c.fovY ?? 45,
    width: c.viewport[0],
    height: c.viewport[1],
    dz: c.deadZone,
    smoothing: c.smoothing,
    bounds: c.bounds,
    level: c.level,
    snap: c.snap === true,
  };
  let C = c.start;
  const out = { halfH: null, halfW: null, positions: [], targets: [], moved: [], clips: [], range: null };
  for (const stepDef of c.steps) {
    if (!stepDef.skipTargets) {
      if (stepDef.viewport) {
        opts.width = stepDef.viewport[0];
        opts.height = stepDef.viewport[1];
      }
      const stepOpts = stepDef.snap !== undefined ? { ...opts, snap: stepDef.snap } : opts;
      const r = cameraStep(C, stepDef.player, stepOpts);
      out.positions.push(r.position);
      out.targets.push(r.target);
      out.moved.push(r.moved);
      out.halfH = r.halfH;
      out.halfW = r.halfW;
      const rangeFor = (min, max, half) =>
        max - min >= 2 * half
          ? { clamped: [min + half, max - half] }
          : { centeredAt: (min + max) / 2 };
      out.range = {
        halfW: r.halfW,
        halfH: r.halfH,
        x: rangeFor(c.level.minX, c.level.maxX, r.halfW),
        y: rangeFor(c.level.minY, c.level.maxY, r.halfH),
      };
      C = r.position;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// fixture group checks
// ---------------------------------------------------------------------------
function checkZoneSweep() {
  const doc = load('zones/sweep.json');
  markGroup('zone-sweep');
  for (const c of doc.cases) {
    const r = zoneTest(c.from, c.to, { id: c.zone.id, role: c.zone.role, center: c.zone.center, size: c.zone.size });
    derived[`zones/sweep.json::${c.id}`] = r;
    compareSubset(r, c.expect, '', c.id, 'zone-sweep');
    pass('zone-sweep', c.id);
  }
  pass('zone-sweep', `${doc.cases.length} cases`);
  return doc;
}

function checkZonePrecedence() {
  const doc = load('zones/precedence.json');
  markGroup('zone-precedence');
  for (const c of doc.cases) {
    const cfg = { zones: c.zones, killY: c.killY };
    const run = { checkpointId: c.checkpointId ?? null };
    const d = decide(run, cfg, c.from, c.to);
    const actual = { kind: d.kind ?? null, zoneId: d.zoneId ?? null, cause: d.cause ?? null };
    derived[`zones/precedence.json::${c.id}`] = actual;
    compareSubset(actual, c.expect, '', c.id, 'zone-precedence');
    pass('zone-precedence', c.id);
  }
  pass('zone-precedence', `${doc.cases.length} cases`);
}

function checkRuns() {
  for (const file of ['run/states.json', 'run/respawn-timing.json', 'run/events-bound.json', 'run/failure-phases.json', 'zones/run-semantics.json']) {
    const doc = load(file);
    const group = `run[${file}]`;
    markGroup(group);
    for (const c of doc.cases) {
      const cfg = {
        caseId: c.id,
        snapshotId: c.snapshotId ?? doc.snapshotId ?? 'demo-0003@r7',
        killY: c.killY ?? doc.killY ?? -4,
        zones: (c.zones ?? doc.zones ?? []).map((z) => ({ ...z })),
        spawnId: c.spawnId ?? doc.spawnId ?? 'spawn-0001',
        safeSpawnId: c.safeSpawnId ?? doc.safeSpawnId ?? 'spawn-0002',
        firstStep: c.firstStep ?? doc.firstStep ?? 0,
      };
      cfg.zones.sort(byId);
      const { run, trace } = runScript(cfg, c.script);
      const view = run.view();
      derived[`${file}::${c.id}`] = { view, trace };
      if (c.expect.timeline !== undefined && c.expect.timeline.length > 0) {
        compareSubset(trace, c.expect.timeline, '.timeline', c.id, group);
      }
      if (c.counterfactual) {
        const d = decide({ checkpointId: null }, { zones: cfg.zones, killY: cfg.killY }, c.counterfactual.from, c.counterfactual.to);
        const actual = { kind: d.kind ?? null, zoneId: d.zoneId ?? null, cause: d.cause ?? null };
        derived[`${file}::${c.id}::counterfactual`] = actual;
        compareSubset(actual, c.counterfactual.expect ?? {}, `${c.id}.counterfactual`, c.id, group);
      }
      if (c.expect.final) compareSubset(view, c.expect.final, '', c.id, group);
      if (c.expect.events !== undefined) {
        compareSubset(view.events, c.expect.events, '.events', c.id, group);
      }
      if (c.expect.retainedFirst) compareSubset(view.events[0], c.expect.retainedFirst, '.events[0]', c.id, group);
      if (c.expect.retainedLast) {
        compareSubset(view.events[view.events.length - 1], c.expect.retainedLast, '.events[last]', c.id, group);
      }
      pass(group, c.id);
    }
    pass(group, `${doc.cases.length} cases`);
  }
}

function checkHeldJump() {
  const doc = load('run/held-jump.json');
  markGroup('run-held-jump');
  for (const c of doc.cases) {
    // effective-frame rules (gameplay.md §2.5), re-derived independently
    const neutral = c.runState === 'awaitingStart' || c.runState === 'respawning' || c.runState === 'won';
    const effectiveJump = neutral || c.firstLive ? 'none' : c.sampled;
    const effectiveMoveX = neutral ? 0 : c.sampledMoveX;
    derived[`run/held-jump.json::${c.id}`] = { jump: effectiveJump, moveX: effectiveMoveX };
    compareSubset({ jump: effectiveJump, moveX: effectiveMoveX }, c.expect, '', c.id, 'run-held-jump');
    pass('run-held-jump', c.id);
  }
  pass('run-held-jump', `${doc.cases.length} cases`);
}

function checkSegmentSource() {
  const doc = load('run/segment-source.json');
  markGroup('segment-source');
  for (const c of doc.cases) {
    const segment = { from: c.lastCommitted, to: c.currEnd };
    const naive = { from: c.statePrevDuringStep, to: c.currEnd };
    derived[`run/segment-source.json::${c.id}`] = { segment, differsFromStatePrev: !eq(segment, naive) };
    compareSubset(segment, c.expect.segment, '', c.id, 'segment-source');
    if (c.expect.differsFromStatePrev !== undefined) {
      const differs = !eq(segment, naive);
      if (differs !== c.expect.differsFromStatePrev) {
        fail('segment-source', `${c.id}: differsFromStatePrev ${differs} != ${c.expect.differsFromStatePrev}`);
      }
    }
    pass('segment-source', c.id);
  }
}

function checkGameView() {
  const doc = load('run/game-view.json');
  markGroup('game-view');
  for (const c of doc.cases) {
    if (c.op === 'identity') {
      const cfg = {
        caseId: c.id,
        snapshotId: c.snapshotId,
        killY: -4,
        zones: [],
        spawnId: 'spawn-0001',
        safeSpawnId: 'spawn-0002',
        firstStep: 0,
      };
      const { run } = runScript(cfg, c.script);
      const stale = (a, b) => a.runId !== b.runId || a.stepIndex < b.stepIndex;
      const actual = {
        runId: run.runId,
        state: run.state,
        stepIndex: run.nextStep,
        staleAgainstSelf: stale(run.view(), run.view()),
      };
      derived[`run/game-view.json::${c.id}`] = actual;
      compareSubset(actual, c.expect, '', c.id, 'game-view');
    } else if (c.op === 'motion') {
      // committed GameView.playerMotion (gameplay.md §6, C41-1): speed over the
      // last completed motion segment × fixedStepHz; no new state, no writer
      const neutral = c.runState === 'awaitingStart' || c.runState === 'won';
      const seg = c.lastCompletedSegment;
      const raw = !neutral && seg ? Math.hypot(seg.to[0] - seg.from[0], seg.to[1] - seg.from[1]) * SIM_HZ : 0;
      const actual = { speed: Math.round(raw * 1e6) / 1e6, grounded: neutral || !seg ? true : c.grounded };
      derived[`run/game-view.json::${c.id}`] = actual;
      compareSubset(actual, c.expect, '', c.id, 'game-view');
    } else if (c.op === 'staleness') {
      const stale = (a, b) => a.runId !== b.runId || a.stepIndex < b.stepIndex;
      const actual = stale(c.view, c.current);
      derived[`run/game-view.json::${c.id}`] = { stale: actual };
      if (c.expect.stale !== undefined && actual !== c.expect.stale) {
        fail('game-view', `${c.id}: stale ${actual} != ${c.expect.stale}`);
      }
    }
    pass('game-view', c.id);
  }
}

function checkSpawn() {
  const doc = load('zones/spawn.json');
  markGroup('zone-spawn-check');
  for (const c of doc.cases) {
    const [x, y] = c.target;
    const L = doc.level;
    let result = { ok: true };
    if (x < L.minX || x > L.maxX || y < L.minY || y > L.maxY || y < doc.killY) {
      result = { ok: false, code: 'game_spawn_invalid', reason: 'outside_level' };
    } else if (c.zones.some((z) => z.role === 'hazard' && zoneTest(c.target, c.target, z).overlap)) {
      result = { ok: false, code: 'game_spawn_blocked', reason: 'hazard' };
    }
    derived[`zones/spawn.json::${c.id}`] = result;
    compareSubset(result, c.expect, '', c.id, 'zone-spawn-check');
    pass('zone-spawn-check', c.id);
  }
  pass('zone-spawn-check', `${doc.cases.length} cases`);
}

function checkErrors() {
  const doc = load('errors/codes.json');
  markGroup('error-codes');
  const declared = Object.keys(doc.codes);
  for (const code of Object.keys(NEW_ERROR_CODES)) {
    if (!declared.includes(code)) fail('error-codes', `contract code ${code} missing from the fixture registry`);
  }
  for (const code of declared) {
    if (!(code in NEW_ERROR_CODES)) fail('error-codes', `fixture code ${code} is not a contract code`);
  }
  for (const [code, meta] of Object.entries(doc.codes)) {
    const contract = NEW_ERROR_CODES[code];
    if (!contract) continue;
    if (meta.cls !== contract.cls) fail('error-codes', `${code}: cls ${meta.cls} != ${contract.cls}`);
    if (meta.destination !== contract.destination) {
      fail('error-codes', `${code}: destination ${meta.destination} != ${contract.destination}`);
    }
    for (const r of meta.reasons ?? []) {
      if (!contract.reasons.includes(r)) fail('error-codes', `${code}: undeclared reason ${r}`);
    }
  }
  for (const [code, reasons] of Object.entries(ACCEPTED_REASON_ADDITIONS)) {
    const entry = doc.acceptedReasonAdditions?.[code];
    if (!entry || !eq(entry, reasons)) fail('error-codes', `${code}: accepted reason additions mismatch`);
  }
  pass('error-codes', `${declared.length} new codes + accepted reason additions`);
}

function checkCamera() {
  for (const file of ['follow.json', 'bounds.json', 'snap.json', 'resize.json']) {
    const doc = loadCamera(file);
    const group = `camera[${file}]`;
    markGroup(group);
    for (const c of doc.cases) {
      const actual = cameraCase(c);
      derived[`${file}::${c.id}`] = actual;
      compareSubset(actual, c.expect, '', c.id, group);
      pass(group, c.id);
    }
    pass(group, `${doc.cases.length} cases`);
  }
}

function checkCameraOwner() {
  const doc = loadCamera('owner.json');
  markGroup('camera-owner');
  for (const c of doc.cases) {
    // gameplay.md §3.4 instantiate validation, re-derived (CC-51-1:
    // `doc.cameraId` — the cameraId is declared at the document level)
    const cameraModules = c.modules.filter((m) => m.phases.includes('camera'));
    const gameplayModules = c.modules.filter((m) => m.phases.includes('gameplay'));
    let result = { ok: true };
    if (cameraModules.length === 0) {
      result = { ok: false, code: 'config_invalid', reason: 'camera_owner', detail: 'missing' };
    } else if (cameraModules.length > 1) {
      result = { ok: false, code: 'config_invalid', reason: 'camera_owner', detail: 'multiple' };
    } else if (!eq(cameraModules[0].transformOwners, [doc.cameraId])) {
      result = { ok: false, code: 'config_invalid', reason: 'camera_owner', detail: 'owner_mismatch' };
    } else if (gameplayModules.length > 1) {
      result = { ok: false, code: 'config_invalid', reason: 'gameplay_module' };
    } else if (c.sceneVersion !== 3) {
      result = { ok: false, code: 'config_invalid', reason: 'scene_version' };
    } else if (c.game === null) {
      result = { ok: false, code: 'config_invalid', reason: 'game_config' };
    } else if (c.cameraFollow !== true) {
      result = { ok: false, code: 'config_invalid', reason: 'camera_follow' };
    }
    derived[`owner.json::${c.id}`] = result;
    compareSubset(result, c.expect, '', c.id, 'camera-owner');
    pass('camera-owner', c.id);
  }
}

const decodeDim = (v) => (typeof v === 'string' ? Number(v) : v);

function checkViewportRules() {
  const doc = loadCamera('resize.json');
  markGroup('camera-viewport');
  for (const raw of doc.rejected ?? []) {
    const c = { width: decodeDim(raw.width), height: decodeDim(raw.height) };
    const bad =
      !Number.isFinite(c.width) ||
      !Number.isFinite(c.height) ||
      c.width <= 0 ||
      c.height <= 0 ||
      c.width > MAX_VIEWPORT ||
      c.height > MAX_VIEWPORT;
    if (bad !== true) fail('camera-viewport', `${jp(raw)} should be rejected`);
  }
  if ((doc.rejected ?? []).length === 0) fail('camera-viewport', 'no non-finite viewport cases');
  for (const raw of doc.accepted ?? []) {
    const c = raw;
    const ok =
      Number.isFinite(c.width) &&
      Number.isFinite(c.height) &&
      c.width > 0 &&
      c.height > 0 &&
      c.width <= MAX_VIEWPORT &&
      c.height <= MAX_VIEWPORT;
    if (ok !== true) fail('camera-viewport', `${jp(raw)} should be accepted`);
  }
  pass('camera-viewport', `${(doc.rejected ?? []).length} rejected + ${(doc.accepted ?? []).length} accepted`);
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
checkIndex('gameplay', GAMEPLAY_ROOT);
checkIndex('camera', CAMERA_ROOT);

checkZoneSweep();
checkZonePrecedence();
checkSpawn();
checkRuns();
checkHeldJump();
checkSegmentSource();
checkGameView();
checkErrors();
checkCamera();
checkCameraOwner();
checkViewportRules();

// every contract constant the fixtures rely on is asserted here as well
markGroup('constants');
{
  const declared = load('index.json').constants ?? {};
  const expected = {
    CAPSULE_RADIUS,
    CAPSULE_HALF_HEIGHT,
    ZONE_OVERLAP_EPS,
    RESPAWN_DELAY_STEPS,
    MAX_GAME_EVENTS,
    CAMERA_Z,
    CAMERA_MAX_STEP,
    CAMERA_SNAP_EPS,
    DEFAULT_ASPECT,
  };
  for (const [k, v] of Object.entries(expected)) {
    if (!(k in declared)) fail('constants', `index.json constants missing ${k}`);
    else if (!Object.is(declared[k], v)) fail('constants', `${k}: ${jp(declared[k])} != ${jp(v)}`);
  }
  pass('constants', `${Object.keys(expected).length} constants`);
}

if (EMIT) {
  process.stdout.write(`${JSON.stringify(derived, null, 2)}\n`);
  process.exit(0);
}

if (REPORT) {
  writeFileSync(
    REPORT,
    `${JSON.stringify({ failures, passes: passes.length, groups: [...seenGroups].sort() }, null, 2)}\n`,
  );
}

const unique = [...new Set(failures.map((f) => f.check))];
if (failures.length === 0) {
  process.stdout.write(`groups passed: ${seenGroups.size}\n`);
  process.stdout.write(`checks passed: ${passes.length}\n`);
  process.stdout.write('all checks passed\n');
  process.exit(0);
}
for (const f of failures) process.stdout.write(`FAIL [${f.check}] ${f.detail}\n`);
process.stdout.write(`groups passed: ${seenGroups.size} · failed checks: ${failures.length} in ${unique.length} groups\n`);
process.exit(1);

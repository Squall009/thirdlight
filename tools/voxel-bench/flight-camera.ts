/**
 * The camera the 8 km world's browser benches move (the project's "Perf far
 * camera" object): its ground read from the far cache, the behaviours that
 * fly it along a line or orbit the town square, and publishing one onto it.
 * Shared by the coverage bench (Play in the editor) and the export memory
 * bench (the same project exported), so both fly the same line the same way.
 */
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { chunkGrid, createDenseChunk, decodeDenseChunk, regionChunkCodecBytes } from '@thirdlight/voxel';
import { FarCacheReader, openShippedWorld, VOXEL_WORLDS_FOLDER, zstdDecompress } from '@thirdlight/workspace';
import { commandEnvelope } from '../../tests/support/commands';
import type { CoveragePath } from './coverage';

/** The ground (metres) at (x, z) of a project's world: the top solid cell of its far cache's level-2 nodes (2 m cells). */
export function farGround(projectDir: string, world: string): (x: number, z: number) => number {
  const cache = new FarCacheReader(join(projectDir, 'cache', 'voxel-far', world));
  const g = chunkGrid(32);
  const L = 2, span = 32 << L;
  const d = createDenseChunk(g);
  return (xm, zm) => {
    const xc = xm * 2, zc = zm * 2;
    const nx = Math.floor(xc / span), nz = Math.floor(zc / span);
    const ix = Math.floor((xc - nx * span) / (1 << L)), iz = Math.floor((zc - nz * span) / (1 << L));
    for (let ny = 30; ny >= -2; ny--) {
      const e = cache.entry({ level: L, nx, ny, nz }) as { uniform?: unknown; stored?: Uint8Array; raw?: number } | null;
      if (e === null) continue;
      if ('uniform' in e) return ((ny + 1) * span) / 2;
      const codec = regionChunkCodecBytes(g, { cx: 0, cy: 0, cz: 0, kind: 'stored', bytes: e.stored!, raw: e.raw! } as never, zstdDecompress);
      if (codec === null) continue;
      decodeDenseChunk(g, codec, d);
      for (let y = 31; y >= 0; y--) {
        const li = (ix << 10) | (iz << 5) | y;
        if (d.material[li] !== 0) return (ny * span + (y + d.shape[li]! / 15) * (1 << L)) / 2;
      }
    }
    return 0;
  };
}

/**
 * The true ground of a project's world at (x, z) (metres): the top of the highest solid 0.5 m cell of its voxels (the
 * region files, what fine collision is derived from) at or under `fromY`; null where the column is air down to the
 * world's floor. What a body there stands on once its fine collision is in, unlike {@link farGround}'s 2 m cells.
 */
export function fineGround(projectDir: string, world: string): (x: number, z: number, fromY: number) => number | null {
  const w = openShippedWorld(join(projectDir, VOXEL_WORLDS_FOLDER, world));
  const g = w.opts.grid;
  const e = g.edge;
  const chunks = new Map<string, ReturnType<typeof createDenseChunk> | null>();
  const chunk = (cx: number, cy: number, cz: number): ReturnType<typeof createDenseChunk> | null => {
    const key = `${cx},${cy},${cz}`;
    let d = chunks.get(key);
    if (d !== undefined) return d;
    const codec = w.chunkBytes({ cx, cy, cz });
    d = codec === null ? null : decodeDenseChunk(g, codec, createDenseChunk(g));
    if (chunks.size > 4096) chunks.clear();
    chunks.set(key, d);
    return d;
  };
  return (xm, zm, fromY) => {
    const x = Math.floor(xm * 2), z = Math.floor(zm * 2), top = Math.floor(fromY * 2);
    const cx = Math.floor(x / e), cz = Math.floor(z / e), ix = x - cx * e, iz = z - cz * e;
    for (let cy = Math.floor(top / e); cy >= -2; cy--) {
      const d = chunk(cx, cy, cz);
      if (d === null) continue;
      for (let y = Math.min(e - 1, top - cy * e); y >= 0; y--) {
        const li = (ix << 10) | (iz << 5) | y;
        if (d.material[li] !== 0) return (cy * e + y + d.shape[li]! / 15) / 2;
      }
    }
    return null;
  };
}

/** The pose of the orbit round the town square the far-field measurements use (0.15 rad/s at the 120 Hz step, 12 m out, 20 m up), as behaviour source. */
export const TOWN_ORBIT_POSE = `const orbitPose = (yaw: number) => { const pitch = 0.03, d = 12, c = Math.cos(pitch); return { position: { x: Math.sin(yaw) * c * d, y: 20 + Math.sin(pitch) * d, z: Math.cos(yaw) * c * d }, quaternion: quat(yaw, pitch) }; };`;
/** A yaw/pitch camera quaternion, as behaviour source. */
export const CAMERA_QUAT = `const quat = (yaw: number, pitch: number) => { const cy = Math.cos(yaw / 2), sy = Math.sin(yaw / 2), cp = Math.cos(-pitch / 2), sp = Math.sin(-pitch / 2); return [cy * sp, sy * cp, -sy * sp, cy * cp]; };`;

export interface FlightOptions {
  readonly path: CoveragePath;
  readonly altitude: 'high' | 'hug';
  /** Metres along the line the flight stops at. */
  readonly total: number;
  readonly pitch: number;
  /** Debug commands that start a flight from the line's start, and their speeds (m/s). */
  readonly flights: Readonly<Record<string, number>>;
  /** True: the camera orbits the town square until a flight starts, and the debug command `orbit` puts it back there. */
  readonly orbit?: boolean;
  /** The probes of the ground under the camera (a ray and a dropped body, {@link PROBE_COUNTERS}); absent: none. */
  readonly probe?: FlightProbe;
}

/**
 * What the flight behaviour probes in the simulation, at the real physics boundary: every step a ray straight down
 * from the camera against the colliders (solid when it hits within `rayTolM` of the ground under the line), and the
 * project's player character ({@link PROBE_BODY}, if there is one) dropped `dropAboveM` over the ground under the
 * camera every `dropEveryS` of flight and once where the flight stops, its height, standing and suspension reported.
 */
export interface FlightProbe {
  /** The ground under the line (metres) every `step` metres along it, at the line itself (the far cache's 2 m cells). */
  readonly ground: readonly number[];
  readonly step: number;
  readonly dropEveryS: number;
  readonly dropAboveM: number;
  readonly rayTolM: number;
}

/** The player character the probe drops (a capsule controller the bench adds to the project for the run). */
export const PROBE_BODY = 'Perf probe character';

/**
 * The run's counters the probe writes (`ctx.game`; read from the play's observation): the flight's distance (cm),
 * the steps the flight started and stopped at, ray steps in flight (all, solid, none hit, hit deep under the
 * ground), the first solid step after the stop, and the body: its drop, the drop point's ground (cm), its height
 * (cm), standing, suspended, standing on a voxel world's coarse floor (its collider ids' `:floor:`), the first
 * step after the stop's drop it stood. Where the body is and what is round it, to tell a fall off an edge from one
 * through a surface: its x, z (cm), the first collider straight under it and the first one met coming down from
 * {@link PROBE_ABOVE_M} over it to its height (each a height in cm and a kind, {@link PROBE_HIT_KIND}).
 */
export const PROBE_COUNTERS = Object.freeze({
  m: 'probe_m_cm',
  flyStep: 'probe_fly_step',
  stopStep: 'probe_stop_step',
  raySteps: 'probe_ray_steps',
  raySolid: 'probe_ray_solid',
  rayNone: 'probe_ray_none',
  rayDeep: 'probe_ray_deep',
  rayReadyStep: 'probe_ray_ready_step',
  drop: 'probe_drop',
  dropGround: 'probe_drop_ground_cm',
  bodyY: 'probe_body_y_cm',
  grounded: 'probe_grounded',
  suspended: 'probe_suspended',
  onFloor: 'probe_on_floor',
  bodyReadyStep: 'probe_body_ready_step',
  bodyX: 'probe_body_x_cm',
  bodyZ: 'probe_body_z_cm',
  belowY: 'probe_below_y_cm',
  belowKind: 'probe_below_kind',
  aboveY: 'probe_above_y_cm',
  aboveKind: 'probe_above_kind',
});

/** What a probe ray met: nothing, a voxel world's fine collision, its coarse floor, any other collider. */
export const PROBE_HIT_KIND = Object.freeze({ none: 0, fine: 1, floor: 2, other: 3 });

/** How far over the body the ray that looks for a surface it passed starts (metres): more than a drop's 2 s fall. */
export const PROBE_ABOVE_M = 80;

/** The probe's behaviour source (the `intent` phase, after the flight's commands): rays, drops and counters. */
function probeSource(p: FlightProbe): string {
  const C = PROBE_COUNTERS;
  return `
const GROUND = ${JSON.stringify(p.ground.map((g) => Math.round(g * 10) / 10))};
const GSTEP = ${p.step}, DROP_STEPS = ${Math.round(p.dropEveryS * 120)}, DROP_ABOVE = ${p.dropAboveM}, RAY_TOL = ${p.rayTolM};
const gAt = (m: number) => { const f = Math.max(0, Math.min(GROUND.length - 1.001, m / GSTEP)); const i = Math.floor(f); return GROUND[i]! + (GROUND[i + 1]! - GROUND[i]!) * (f - i); };
const put = (ctx: any, name: string, v: number) => { const now = ctx.game.counter(name); if (now !== v) ctx.game.add(name, v - now); };
const probe = (s: any, ctx: any) => {
  if (s.flyStep < 0) return;
  const body = ctx.world.find(${JSON.stringify(PROBE_BODY)});
  const p = along(s.m), y = altAt(s.m), g = gAt(s.m);
  put(ctx, '${C.m}', Math.round(s.m * 100));
  const stopped = s.m >= TOTAL;
  if (stopped && s.stopStep < 0) { s.stopStep = ctx.stepIndex; put(ctx, '${C.stopStep}', s.stopStep); s.nextDrop = ctx.stepIndex; }
  const hit = ctx.physics.raycast?.([p.x, y, p.z], [0, -1, 0], 2000, body === undefined ? undefined : { exclude: [body] }) ?? null;
  const solid = hit !== null && Math.abs(y - hit.distance - g) <= RAY_TOL;
  if (!stopped) {
    ctx.game.add('${C.raySteps}', 1);
    if (solid) ctx.game.add('${C.raySolid}', 1);
    else if (hit === null) ctx.game.add('${C.rayNone}', 1);
    else if (y - hit.distance < g - RAY_TOL) ctx.game.add('${C.rayDeep}', 1);
  } else if (solid && ctx.game.counter('${C.rayReadyStep}') === 0) put(ctx, '${C.rayReadyStep}', ctx.stepIndex);
  if (body === undefined) return;
  if (ctx.stepIndex >= s.nextDrop && (!stopped || s.stopDropped === false)) {
    ctx.emit({ kind: 'character_place', entityId: body, position: [p.x, g + DROP_ABOVE, p.z] });
    ctx.game.add('${C.drop}', 1);
    put(ctx, '${C.dropGround}', Math.round(g * 100));
    s.nextDrop = ctx.stepIndex + DROP_STEPS;
    if (stopped) s.stopDropped = true;
  }
  const st = ctx.physics.characterState?.(body);
  if (st === undefined) return;
  const susp = ctx.physics.isSuspended?.(body) === true;
  put(ctx, '${C.bodyY}', Math.round(st.position.y * 100));
  put(ctx, '${C.grounded}', st.grounded ? 1 : 0);
  put(ctx, '${C.suspended}', susp ? 1 : 0);
  put(ctx, '${C.onFloor}', st.grounded && typeof st.groundEntityId === 'string' && st.groundEntityId.startsWith('voxel:') && st.groundEntityId.includes(':floor:') ? 1 : 0);
  const bx = st.position.x, by = st.position.y, bz = st.position.z;
  put(ctx, '${C.bodyX}', Math.round(bx * 100));
  put(ctx, '${C.bodyZ}', Math.round(bz * 100));
  const kind = (h: any) => h === null ? ${PROBE_HIT_KIND.none} : typeof h.entityId !== 'string' || !h.entityId.startsWith('voxel:') ? ${PROBE_HIT_KIND.other} : h.entityId.includes(':floor:') ? ${PROBE_HIT_KIND.floor} : ${PROBE_HIT_KIND.fine};
  const below = ctx.physics.raycast?.([bx, by, bz], [0, -1, 0], 2000, { exclude: [body] }) ?? null;
  put(ctx, '${C.belowY}', below === null ? 0 : Math.round((by - below.distance) * 100));
  put(ctx, '${C.belowKind}', kind(below));
  const above = ctx.physics.raycast?.([bx, by + ${PROBE_ABOVE_M}, bz], [0, -1, 0], ${PROBE_ABOVE_M}, { exclude: [body] }) ?? null;
  put(ctx, '${C.aboveY}', above === null ? 0 : Math.round((by + ${PROBE_ABOVE_M} - above.distance) * 100));
  put(ctx, '${C.aboveKind}', kind(above));
  if (s.stopDropped && st.grounded && !susp && ctx.game.counter('${C.bodyReadyStep}') === 0 && ctx.stepIndex > s.stopStep + 2) put(ctx, '${C.bodyReadyStep}', ctx.stepIndex);
};
const probeReset = (ctx: any) => { for (const name of ${JSON.stringify(Object.values(C))}) put(ctx, name, 0); };
`;
}

/**
 * The flight behaviour: holds the line's start (`start`), or orbits the town (`orbit`, with `orbit` set), until a
 * flight's command, then that speed along the line (the 120 Hz step), then holds the line's end.
 */
export function flightSource(o: FlightOptions): string {
  return `
const WP = ${JSON.stringify(o.path.waypoints)};
const ALT = ${JSON.stringify(o.path[o.altitude])};
const STEP = ${o.path.step}, TOTAL = ${o.total}, PITCH = ${o.pitch};
const FLIGHTS = ${JSON.stringify(o.flights)};
${CAMERA_QUAT}
${TOWN_ORBIT_POSE}
const along = (m: number) => { let r = Math.max(0, m); for (let i = 1; i < WP.length; i++) { const a = WP[i - 1]!, b = WP[i]!; const len = Math.hypot(b[0] - a[0], b[1] - a[1]); const dx = (b[0] - a[0]) / len, dz = (b[1] - a[1]) / len; if (r <= len || i === WP.length - 1) { const t = Math.min(r, len); return { x: a[0] + dx * t, z: a[1] + dz * t, dx, dz }; } r -= len; } return { x: WP[0][0], z: WP[0][1], dx: 1, dz: 0 }; };
const altAt = (m: number) => { const f = Math.max(0, Math.min(ALT.length - 1.001, m / STEP)); const i = Math.floor(f); return ALT[i]! + (ALT[i + 1]! - ALT[i]!) * (f - i); };
${o.probe === undefined ? 'const probe = (_s: any, _ctx: any) => undefined; const probeReset = (_ctx: any) => undefined;' : probeSource(o.probe)}
const flown = (s: any, ctx: any) => { s.m = 0; s.orbiting = false; s.flyStep = s.speed > 0 ? ctx.stepIndex : -1; s.stopStep = -1; s.nextDrop = ctx.stepIndex; s.stopDropped = false; probeReset(ctx); };
export default {
  prepare() { return {}; },
  instantiate() { return { m: 0, speed: 0, orbiting: ${o.orbit === true}, yaw: 0.4636, flyStep: -1, stopStep: -1, nextDrop: 0, stopDropped: false }; },
  step(s: any, ctx: any) {
    if (ctx.phase === 'intent') {
      for (const name of Object.keys(FLIGHTS)) for (const _ of ctx.debug.command(name)) { s.speed = FLIGHTS[name]; flown(s, ctx); ctx.game.add('${PROBE_COUNTERS.flyStep}', ctx.stepIndex); }
      for (const _ of ctx.debug.command('start')) { s.speed = 0; flown(s, ctx); }
      ${o.orbit === true ? `for (const _ of ctx.debug.command('orbit')) { s.speed = 0; s.orbiting = true; s.flyStep = -1; }` : ''}
      if (!s.orbiting) probe(s, ctx);
      return;
    }
    if (ctx.phase !== 'transform') return;
    if (s.orbiting) {
      s.yaw += 0.15 / 120;
      ctx.emit({ kind: 'transform', entityId: ctx.entityId, ...orbitPose(s.yaw) });
      return;
    }
    s.m = Math.min(TOTAL, s.m + s.speed / 120);
    const p = along(s.m);
    const yaw = Math.atan2(-p.dx, -p.dz);
    ctx.emit({ kind: 'transform', entityId: ctx.entityId, position: { x: p.x, y: altAt(s.m), z: p.z }, quaternion: quat(yaw, PITCH) });
  },
  dispose() {},
};
`;
}

export interface BenchApi {
  readonly origin: string;
  readonly token: string;
  readonly project: string;
  api(path: string, body?: unknown, method?: string): Promise<{ status: number; json: Record<string, unknown> }>;
  command(op: string, args: unknown): Promise<void>;
  revision(): Promise<number>;
}

/** The backend's project API for a bench (`clientId` names it in the command log). */
export function benchApi(o: { origin: string; token: string; project: string; clientId: string }): BenchApi {
  const headers = { authorization: `Bearer ${o.token}`, 'content-type': 'application/json', origin: o.origin };
  const api = async (path: string, body: unknown = {}, method = 'POST'): Promise<{ status: number; json: Record<string, unknown> }> => {
    const r = await fetch(`${o.origin}/api/v1/${path.startsWith('admin/') ? path : `projects/${o.project}/${path}`}`, { method, headers, ...(method === 'GET' ? {} : { body: JSON.stringify(body) }) });
    return { status: r.status, json: (await r.json().catch(() => ({}))) as Record<string, unknown> };
  };
  const revision = async (): Promise<number> => Number((await api('commands', { op: 'queryProject', projectId: o.project, args: {} })).json['revision']);
  const send = async (op: string, args: unknown): Promise<void> => {
    const r = await api('commands', commandEnvelope(op, o.project, await revision(), args as Record<string, unknown>, o.clientId));
    const error = r.json['error'] as { code?: string } | undefined;
    if (r.json['ok'] !== true && error?.code !== 'no_change') throw new Error(`${op}: ${JSON.stringify(r.json).slice(0, 400)}`);
  };
  return { origin: o.origin, token: o.token, project: o.project, api, command: send, revision };
}

/** The behaviour the project's "Perf far camera" has now (null: none, or no such object). */
export function cameraBehaviour(projectDir: string): string | null {
  const entities = JSON.parse(readFileSync(join(projectDir, 'scenes', 'scene-main.json'), 'utf8')).scene.entities as Array<{ name: string; components: Record<string, { behaviorId?: string }> }>;
  return entities.find((e) => e.name === 'Perf far camera')?.components['behavior']?.behaviorId ?? null;
}

/** Publishes `source` as behaviour `behaviorId` and gives it to the project's "Perf far camera" object. */
export async function publishCameraBehaviour(b: BenchApi, projectDir: string, behaviorId: string, source: string): Promise<void> {
  const entities = JSON.parse(readFileSync(join(projectDir, 'scenes', 'scene-main.json'), 'utf8')).scene.entities as Array<{ id: string; name: string }>;
  const cam = entities.find((e) => e.name === 'Perf far camera');
  if (cam === undefined) throw new Error('no "Perf far camera" object in the project (the far-field runs make it)');
  const bytes = Buffer.from(`${JSON.stringify({ graphVersion: 1, entryPath: 'src/index.ts', requiredModules: ['@thirdlight/runtime'], ownedTransforms: ['@self'], files: [{ path: 'src/index.ts', text: source }] }, null, 2)}\n`);
  const stageId = String((await b.api('content/stages')).json['stageId']);
  const put = await fetch(`${b.origin}/api/v1/projects/${b.project}/content/stages/${stageId}/bytes`, { method: 'PUT', headers: { authorization: `Bearer ${b.token}`, origin: b.origin, 'content-type': 'application/octet-stream', 'x-thirdlight-offset': '0', 'x-thirdlight-total': String(bytes.length) }, body: bytes });
  if (put.status !== 200) throw new Error(`stage ${put.status}`);
  const declaration = { properties: [] };
  await b.command('publishBehavior', { behaviorId, displayName: behaviorId, mode: 'declaration-create', declaration }).catch((e: unknown) => {
    if (!String(e).includes('behavior_id_duplicate')) throw e;
  });
  await b.command('acknowledgeBehaviorTrust', { sourceDigest: createHash('sha256').update(bytes).digest('hex') });
  const pub = await b.api('content/behaviors/source', { stageId, behaviorId, displayName: behaviorId, declaration, expectedRevision: await b.revision(), requestId: `req-${randomBytes(16).toString('hex')}` });
  if (pub.status !== 200) throw new Error(`publish ${JSON.stringify(pub.json).slice(0, 300)}`);
  await b.command('setBehaviorProperties', { entityId: cam.id, behaviorId, values: {} });
}

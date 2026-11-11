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
import { FarCacheReader, zstdDecompress } from '@thirdlight/workspace';
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
export default {
  prepare() { return {}; },
  instantiate() { return { m: 0, speed: 0, orbiting: ${o.orbit === true}, yaw: 0.4636 }; },
  step(s: any, ctx: any) {
    if (ctx.phase === 'intent') {
      for (const name of Object.keys(FLIGHTS)) for (const _ of ctx.debug.command(name)) { s.m = 0; s.speed = FLIGHTS[name]; s.orbiting = false; }
      for (const _ of ctx.debug.command('start')) { s.m = 0; s.speed = 0; s.orbiting = false; }
      ${o.orbit === true ? `for (const _ of ctx.debug.command('orbit')) { s.speed = 0; s.orbiting = true; }` : ''}
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

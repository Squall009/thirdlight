/**
 * Height in alpha over the real transports: PNG textures imported through
 * the content route — one albedo with a height painted into A, one RGB PNG
 * (no alpha at all) — put into the albedo slots of a layered surface with
 * `setMaterial`, and into a cut-out graph whose albedo A is opacity.
 *
 * - The project's problems name the texture without height ("no height in
 *   alpha — blends between layers will be soft") and only it; the cut-out
 *   is never named.
 * - The height-alpha route (the layer palette's badge) says which is which.
 * - The albedo array the views and builds draw gives the texture without
 *   height a brightness height (`x-thirdlight-derived-height`); once a version
 *   with a height in A is imported in its place, it keeps its own.
 */
import { rmSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

import { LAYERED_TEXTURES, layeredMaterial, type MaterialDef } from '@thirdlight/project-model';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AUTH_TOKEN, AUTHORING_ORIGIN, V3_PROJECT, cleanupBundles, createMcp, http, inspectViaHttp, makeRoot, mkRequestId, publishArgs, sleep, spawnBackend, stopBackend, type BackendProcess, type DisposableRoot, type McpHarness } from '../m3-content/harness';

function crc32(bytes: Uint8Array): number {
  let c = ~0;
  for (const b of bytes) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
  }
  return ~c >>> 0;
}
function chunk(type: string, body: Uint8Array): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(body.length, 0);
  head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])), 0);
  return Buffer.concat([head, body, crc]);
}
/** A PNG of `size`² from a per-pixel colour: RGBA, or RGB (no alpha channel) when `alpha` is false. */
function png(size: number, px: (x: number, y: number) => [number, number, number, number], alpha: boolean): Uint8Array {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = alpha ? 6 : 2;
  const rows: Buffer[] = [];
  for (let y = 0; y < size; y++) {
    const row: number[] = [0];
    for (let x = 0; x < size; x++) row.push(...px(x, y).slice(0, alpha ? 4 : 3));
    rows.push(Buffer.from(row));
  }
  return new Uint8Array(Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(Buffer.concat(rows))), chunk('IEND', new Uint8Array(0))]));
}
/** Stones: bright faces, dark joints; the height (A) high on the faces. */
const stones = (x: number, y: number): [number, number, number, number] => {
  const joint = x % 8 === 0 || y % 8 === 0;
  return joint ? [60, 55, 50, 20] : [170, 160, 150, 120 + ((x * 13 + y * 7) % 120)];
};

let root: DisposableRoot;
let bp: BackendProcess;
let mcp: McpHarness;

async function revision(): Promise<number> {
  const res = await mcp.call('tl_inspect', { target: 'project' });
  return Number(res.body.revision);
}
async function command(op: string, args: Record<string, unknown>): Promise<void> {
  const r = await mcp.call('tl_command', { op, args, expectedRevision: await revision(), requestId: mkRequestId() });
  expect(r.isError, JSON.stringify(r.body).slice(0, 600)).toBe(false);
}
async function publishPng(bytes: Uint8Array, assetId: string, mode: 'create' | 'reimport'): Promise<void> {
  const inspected = await inspectViaHttp(bp.origin, V3_PROJECT, AUTH_TOKEN, bytes, { kind: 'texture' });
  expect(inspected.status, JSON.stringify(inspected.body)).toBe(200);
  await command('publishAsset', publishArgs(mode, assetId, (inspected.body as { proposal: Record<string, unknown> }).proposal, { kind: 'texture' }));
}
const withAlbedo = (m: MaterialDef, slots: string[]): MaterialDef => ({ ...m, parameters: (m.parameters ?? []).map((p) => (p.key === LAYERED_TEXTURES.albedo ? { ...p, default: slots } : p)) as MaterialDef['parameters'] });
const get = (path: string) => http(`${bp.origin}/api/v1/projects/${V3_PROJECT}${path}`, { token: AUTH_TOKEN, origin: AUTHORING_ORIGIN });
/** The height problems logged so far. */
async function heightProblems(): Promise<string[]> {
  const r = await get('/problems');
  return ((r.body as { problems?: { code: string; message: string }[] }).problems ?? []).filter((p) => p.code === 'no_height_in_alpha').map((p) => p.message);
}
const albedoArray = (layers: string[]) => http(`${bp.origin}/api/v1/projects/${V3_PROJECT}/content/textures/slots`, { body: { layers, mode: 'color', height: true }, token: AUTH_TOKEN, origin: AUTHORING_ORIGIN });

beforeAll(async () => {
  root = makeRoot('heightalpha');
  bp = await spawnBackend(root, [{ token: AUTH_TOKEN, scope: `authoring:${V3_PROJECT}` }]);
  mcp = await createMcp(bp.origin);
  await publishPng(png(32, stones, true), 'stones-height', 'create');
  await publishPng(png(32, (x, y) => stones(x, y), false), 'stones-flat', 'create');
}, 120_000);

afterAll(async () => {
  cleanupBundles();
  await mcp?.close();
  if (bp) await stopBackend(bp);
  if (root) rmSync(root.root, { recursive: true, force: true });
}, 60_000);

describe('height in alpha over the real backend', () => {
  it('a layered surface\'s albedo without height is a problem and gets a brightness height; a cut-out is never warned', async () => {
    await command('setMaterial', { material: withAlbedo(layeredMaterial('mat-ground', 'Ground'), ['stones-height', 'stones-flat']) });
    // A cut-out: the same layout with the albedo's A into opacity — A is opacity, so nothing is checked.
    const cut = withAlbedo(layeredMaterial('mat-leaves', 'Leaves'), ['stones-flat']);
    const g = cut.graph!;
    const read = g.edges.find((e) => g.nodes.find((n) => n.id === e.from.node)?.data?.['key'] === LAYERED_TEXTURES.albedo)!.to.node;
    const out = g.nodes.find((n) => n.type === 'pbr')!.id;
    await command('setMaterial', { material: { ...cut, graph: { ...g, edges: [...g.edges, { id: 'cut', from: { node: read, port: 'a' }, to: { node: out, port: 'opacity' } }] } } });

    let lines: string[] = [];
    for (let i = 0; i < 60 && lines.length === 0; i++) {
      lines = await heightProblems();
      if (lines.length === 0) await sleep(250);
    }
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^stones-flat: no height in alpha — blends between layers will be soft \("Ground" layer 2\)/);
    expect(lines[0]).not.toMatch(/Leaves/);

    const route = await get('/content/textures/height-alpha?ids=stones-height,stones-flat');
    expect(route.status).toBe(200);
    expect((route.body as { textures: unknown }).textures).toEqual({ 'stones-height': 'height', 'stones-flat': 'flat' });

    const arr = await albedoArray(['stones-height', 'stones-flat']);
    expect(arr.status).toBe(200);
    expect(arr.headers['x-thirdlight-derived-height']).toBe('1');
  }, 120_000);

  it('a version with height in A replaces the stand-in: no derived layer, the route says height', async () => {
    await publishPng(png(32, stones, true), 'stones-flat', 'reimport');
    const route = await get('/content/textures/height-alpha?ids=stones-flat');
    expect((route.body as { textures: unknown }).textures).toEqual({ 'stones-flat': 'height' });
    const arr = await albedoArray(['stones-height', 'stones-flat']);
    expect(arr.status).toBe(200);
    expect(arr.headers['x-thirdlight-derived-height']).toBe('');
  }, 120_000);
});

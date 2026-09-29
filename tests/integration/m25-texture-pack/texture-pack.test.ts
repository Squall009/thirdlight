/**
 * Phase 25.21: packing texture assets into one KTX2 texture (a texture
 * array with several layers) over the REAL transports — two PNG textures
 * published through the content route, packed channel by channel with the
 * MCP upload tool's `pack` (the backend's pack route), published with the
 * returned `packedFrom`; `tl_content_query` lists the array's layers and its
 * sources. Refusals name the reason: sources of different sizes, a KTX2
 * source, a texture the project does not have, and a texture array where
 * one plain texture is read (a shader material's slot).
 */
import { rmSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ADMIN_TOKEN, AUTH_TOKEN, V3_PROJECT, cleanupBundles, createMcp, inspectViaHttp, makeRoot, mkRequestId, publishArgs, spawnBackend, stopBackend, type BackendProcess, type DisposableRoot, type McpHarness } from '../m3-content/harness';

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
/** A solid RGBA PNG. */
function png(size: number, rgba: [number, number, number, number]): Uint8Array {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(new Array(size).fill(rgba).flat())]);
  const raw = Buffer.concat(new Array(size).fill(row));
  return new Uint8Array(Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', new Uint8Array(0))]));
}

let root: DisposableRoot;
let bp: BackendProcess;
let mcp: McpHarness;

async function revision(): Promise<number> {
  const res = await mcp.call('tl_inspect', { target: 'project' });
  return Number(res.body.revision);
}
async function command(op: string, args: Record<string, unknown>): Promise<{ isError: boolean; body: Record<string, unknown> }> {
  return mcp.call('tl_command', { op, args, expectedRevision: await revision(), requestId: mkRequestId() });
}
async function publishPng(bytes: Uint8Array, assetId: string): Promise<void> {
  const inspected = await inspectViaHttp(bp.origin, V3_PROJECT, AUTH_TOKEN, bytes, { kind: 'texture' });
  expect(inspected.status, JSON.stringify(inspected.body)).toBe(200);
  const proposal = (inspected.body as { proposal: Record<string, unknown> }).proposal;
  const r = await command('publishAsset', publishArgs('create', assetId, proposal, { kind: 'texture' }));
  expect(r.isError, JSON.stringify(r.body)).toBe(false);
}

beforeAll(async () => {
  root = makeRoot('texpack');
  bp = await spawnBackend(root, [
    { token: AUTH_TOKEN, scope: `authoring:${V3_PROJECT}` },
    { token: ADMIN_TOKEN, scope: 'admin' },
  ]);
  mcp = await createMcp(bp.origin);
  await publishPng(png(16, [200, 40, 20, 255]), 'albedo-a');
  await publishPng(png(16, [30, 30, 30, 255]), 'height-a');
  await publishPng(png(8, [0, 0, 0, 255]), 'small');
}, 120_000);

afterAll(async () => {
  cleanupBundles();
  await mcp?.close();
  if (bp) await stopBackend(bp);
  if (root) rmSync(root.root, { recursive: true, force: true });
}, 60_000);

describe('texture packing over MCP and the pack route (phase 25.21)', () => {
  it('packs two layers from two textures; the array is published with its packedFrom and listed with its layers', async () => {
    const pack = {
      layers: [
        [{ assetId: 'albedo-a', channel: 'r' }, { assetId: 'albedo-a', channel: 'g' }, { assetId: 'albedo-a', channel: 'b' }, { assetId: 'height-a', channel: 'r' }],
        [{ value: 10 }, { assetId: 'albedo-a', channel: 'r' }, { value: 0 }, { value: 255 }],
      ],
      encoding: 'data',
    };
    const packed = await mcp.call('tl_content_upload', { pack, displayName: 'Two layers' });
    expect(packed.isError, JSON.stringify(packed.body).slice(0, 500)).toBe(false);
    const proposal = packed.body.proposal as Record<string, unknown>;
    expect(proposal.metrics).toEqual({ format: 'ktx2', width: 16, height: 16, decodedBytes: 16 * 16 * 4 * 2, codec: 'uastc', levels: 5, layers: 2 });
    const packedFrom = packed.body.packedFrom as { layers: unknown[][]; converter: unknown; encoding: string };
    expect(packedFrom.encoding).toBe('data');
    expect(packedFrom.converter).toEqual({ name: 'ktx2-encoder', version: '0.6.0' });
    expect(packedFrom.layers[1]).toEqual([{ value: 10 }, { assetId: 'albedo-a', digest: expect.stringMatching(/^[0-9a-f]{64}$/), channel: 'r' }, { value: 0 }, { value: 255 }]);
    const published = await command('publishAsset', publishArgs('create', 'two-layers', proposal, { kind: 'texture', displayName: 'Two layers', packedFrom }));
    expect(published.isError, JSON.stringify(published.body)).toBe(false);
    const listed = await mcp.call('tl_content_query', { target: 'assets', limit: 128, offset: 0 });
    const a = (listed.body.assets as { assetId: string; image?: unknown; packedFrom?: unknown }[]).find((x) => x.assetId === 'two-layers')!;
    expect(a.image).toEqual({ format: 'ktx2', width: 16, height: 16, codec: 'uastc', levels: 5, layers: 2 });
    expect(a.packedFrom).toEqual({ encoding: 'data', sources: ['albedo-a', 'height-a'] });
    // Only graph materials read an array's layers: a shader material's slot refuses it.
    const slot = await command('setMaterial', { material: { materialId: 'mat-plain', name: 'Plain', shader: 'standard', params: {}, textures: { map: 'two-layers' } } });
    expect(slot.isError).toBe(true);
    expect(JSON.stringify(slot.body)).toMatch(/texture array/);
  }, 120_000);

  it('refuses sources of different sizes, a KTX2 source and an unknown texture, with the reason', async () => {
    const sized = await mcp.call('tl_content_upload', { pack: { layers: [[{ assetId: 'albedo-a', channel: 'r' }, { assetId: 'small', channel: 'r' }, { value: 0 }, { value: 255 }]], encoding: 'data' } });
    expect(sized.isError).toBe(true);
    expect(JSON.stringify(sized.body)).toMatch(/one size/);
    const ktx = await mcp.call('tl_content_upload', { pack: { layers: [[{ assetId: 'two-layers', channel: 'r' }, { value: 0 }, { value: 0 }, { value: 255 }]], encoding: 'data' } });
    expect(ktx.isError).toBe(true);
    expect(JSON.stringify(ktx.body)).toMatch(/PNG or JPEG/);
    const missing = await mcp.call('tl_content_upload', { pack: { layers: [[{ assetId: 'nope', channel: 'r' }, { value: 0 }, { value: 0 }, { value: 255 }]], encoding: 'color' } });
    expect(missing.isError).toBe(true);
    expect(JSON.stringify(missing.body)).toMatch(/no texture asset .{0,4}nope/);
    const both = await mcp.call('tl_content_upload', { pack: { layers: [], encoding: 'color' }, dataBase64: 'AAAA' });
    expect(both.isError).toBe(true);
  }, 60_000);
});

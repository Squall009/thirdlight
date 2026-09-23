/**
 * FBX → GLB with the real headless Blender (this host has it; the test says
 * so and skips where it is absent), then the real import inspector: the
 * converted GLB keeps the texture and the animation. A missing Blender and a
 * non-FBX input fail with the documented codes.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { createAssetInspector } from './content';
import { createFbxConverter, isFbx } from './fbx';

const FBX = resolve(import.meta.dirname, '..', '..', '..', 'fixtures', 'import-ext', 'fbx');
const blender = process.env.THIRDLIGHT_BLENDER ?? 'blender';
const haveBlender = spawnSync(blender, ['--version'], { encoding: 'utf8' }).status === 0;
const work = mkdtempSync(join(process.env.TMPDIR ?? '/tmp', 'tl-fbx-test-'));
afterAll(() => rmSync(work, { recursive: true, force: true }));

const job = {
  now: () => 0,
  isCancelled: () => false,
  proposalId: () => `p-${'0'.repeat(31)}1`,
  stageId: () => 'fbx-test',
  expiresAt: () => '2026-09-23T00:00:00Z',
};
function glbJson(glb: Uint8Array): Record<string, unknown> {
  const n = new DataView(glb.buffer, glb.byteOffset).getUint32(12, true);
  return JSON.parse(new TextDecoder().decode(glb.subarray(20, 20 + n))) as Record<string, unknown>;
}

describe('FBX detection', () => {
  it('knows binary FBX and nothing else', () => {
    expect(isFbx(new Uint8Array(readFileSync(join(FBX, 'crate.fbx'))))).toBe(true);
    expect(isFbx(new TextEncoder().encode('glTF....'))).toBe(false);
    expect(isFbx(new TextEncoder().encode('; FBX 7.4.0 project file\n'))).toBe(true);
  });
});

describe.skipIf(!haveBlender)('FBX → GLB with headless Blender', () => {
  const converter = createFbxConverter({ blender, workRoot: join(work, 'convert') });

  it('converts a game-folder FBX with its texture next to it, keeping the animation; the GLB passes the import profile', async () => {
    const r = await converter.convert({ path: join(FBX, 'crate.fbx') });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    if (!r.ok) return;
    expect(r.blenderVersion).toMatch(/^\d+\.\d+\.\d+$/);
    const json = glbJson(r.glb);
    expect((json['images'] as unknown[]).length).toBe(1);
    expect((json['animations'] as unknown[]).length).toBe(1);
    const p = createAssetInspector()(r.glb, job) as unknown as { status: string; metrics?: { vertices: number; animations: number; images: number } };
    expect(p.status).toBe('ok');
    expect(p.metrics).toMatchObject({ animations: 1, images: 1 });
  }, 120_000);

  it('converts uploaded bytes (embedded texture) and leaves no scratch files', async () => {
    const r = await converter.convert({ bytes: new Uint8Array(readFileSync(join(FBX, 'crate-embedded.fbx'))) });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    if (r.ok) expect((glbJson(r.glb)['images'] as unknown[]).length).toBe(1);
    expect(spawnSync('ls', ['-A', join(work, 'convert')], { encoding: 'utf8' }).stdout.trim()).toBe('');
  }, 120_000);

  it('a file that is not an FBX fails with conversion_failed and a bounded reason', async () => {
    const r = await converter.convert({ bytes: new TextEncoder().encode('Kaydara FBX Binary  \0 but truncated') });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe('conversion_failed');
      expect(r.message.length).toBeLessThanOrEqual(260);
      expect(r.message).not.toContain(work);
    }
  }, 120_000);
});

describe('no Blender', () => {
  it('is converter_unavailable, saying how to fix it', async () => {
    const r = await createFbxConverter({ blender: '/nonexistent/blender', workRoot: join(work, 'none') }).convert({ bytes: new Uint8Array(4) });
    expect(r).toMatchObject({ ok: false, code: 'converter_unavailable' });
    if (!r.ok) expect(r.message).toContain('THIRDLIGHT_BLENDER');
  });
});

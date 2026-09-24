/**
 * Phase 9.6: the final bake service with a fake Blender on the `local` host
 * (a script that answers like the real bake script: progress lines, one PNG
 * per atlas). The real Cycles script runs in the lightmaps e2e.
 */
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { checkBakePackage, createBakeService } from './bake';

const work = mkdtempSync(join(process.env.TMPDIR ?? '/tmp', 'tl-bake-test-'));
afterAll(() => rmSync(work, { recursive: true, force: true }));

// A 1 × 1 PNG.
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

/** A fake `blender`: reads `-- <package> <out>`, prints progress, writes atlas-<i>.png (or fails / hangs). */
function fakeBlender(mode: 'ok' | 'fail' | 'hang'): string {
  const path = join(work, `blender-${mode}`);
  writeFileSync(
    path,
    `#!/usr/bin/env node
const fs = require('fs');
const a = process.argv.slice(process.argv.indexOf('--') + 1);
const raw = fs.readFileSync(a[0]);
const header = JSON.parse(raw.subarray(12, 12 + raw.readUInt32LE(8)).toString('utf8'));
if (${JSON.stringify(mode)} === 'fail') { console.error('Error: something broke in Blender'); process.exit(1); }
if (${JSON.stringify(mode)} === 'hang') { setTimeout(() => {}, 60000); return; }
console.log('TL_DEVICE CPU');
const n = header.atlases.length;
for (let i = 0; i < n; i++) {
  console.log('TL_PROGRESS ' + (i + 1) + '/' + n);
  fs.writeFileSync(require('path').join(a[1], 'atlas-' + i + '.png'), Buffer.from(${JSON.stringify(PNG_B64)}, 'base64'));
}
`,
  );
  chmodSync(path, 0o755);
  return path;
}

function pkg(atlases = 2, header?: Record<string, unknown>): Uint8Array {
  const h = new TextEncoder().encode(
    JSON.stringify(
      header ?? {
        atlases: Array.from({ length: atlases }, () => ({ width: 64, height: 64 })),
        geometries: [],
        objects: [{ entityId: 'box-0001', geometry: 'g0', matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], atlas: 0, scaleOffset: [1, 1, 0, 0] }],
        lights: [],
        settings: { samples: 16 },
      },
    ),
  );
  const out = new Uint8Array(12 + h.byteLength + 8);
  out.set([0x54, 0x4c, 0x42, 0x4b]);
  new DataView(out.buffer).setUint32(4, 1, true);
  new DataView(out.buffer).setUint32(8, h.byteLength, true);
  out.set(h, 12);
  return out;
}

async function settle(svc: ReturnType<typeof createBakeService>, jobId: string): Promise<NonNullable<ReturnType<typeof svc.job>>> {
  for (let i = 0; i < 200; i++) {
    const j = svc.job('p1', jobId)!;
    if (j.state !== 'running' && j.state !== 'queued') return j;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('the bake never settled');
}

describe('bake packages', () => {
  it('accepts a well-formed package and refuses broken ones', () => {
    expect(checkBakePackage(pkg())).toEqual({ ok: true, atlases: 2, objects: 1 });
    expect(checkBakePackage(new TextEncoder().encode('GLB....'))).toMatchObject({ ok: false });
    expect(checkBakePackage(pkg(0))).toMatchObject({ ok: false, message: expect.stringContaining('atlases') });
    expect(checkBakePackage(pkg(1, { atlases: [{ width: 9000, height: 64 }], geometries: [], objects: [{}], lights: [] }))).toMatchObject({ ok: false });
    const truncated = pkg().subarray(0, 20);
    expect(checkBakePackage(truncated)).toMatchObject({ ok: false });
  });
});

describe('the final bake on a (fake) local bake host', () => {
  it('reports that no host is configured', () => {
    const svc = createBakeService({ blender: 'blender', timeoutMs: 1000, workRoot: join(work, 'none') });
    expect(svc.status()).toMatchObject({ ok: false });
    expect(svc.start('p1', pkg())).toMatchObject({ ok: false, code: 'bake_unavailable' });
  });

  it('runs a bake: progress, device and one PNG per atlas; the job belongs to its project', async () => {
    const svc = createBakeService({ host: 'local', blender: fakeBlender('ok'), timeoutMs: 20_000, workRoot: join(work, 'ok') });
    expect(svc.status()).toEqual({ ok: true, host: 'local' });
    const started = svc.start('p1', pkg(2));
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    const job = await settle(svc, started.jobId);
    expect(job).toMatchObject({ state: 'done', atlases: 2, progress: { done: 2, total: 2 }, device: 'CPU' });
    expect(svc.atlas('p1', started.jobId, 0)?.subarray(0, 4)).toEqual(new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
    expect(svc.atlas('p1', started.jobId, 2)).toBeNull();
    expect(svc.job('p2', started.jobId)).toBeNull();
    expect(svc.atlas('p2', started.jobId, 0)).toBeNull();
    svc.dispose();
  });

  it('reports a Blender failure with its message', async () => {
    const svc = createBakeService({ host: 'local', blender: fakeBlender('fail'), timeoutMs: 20_000, workRoot: join(work, 'fail') });
    const started = svc.start('p1', pkg());
    if (!started.ok) throw new Error('not started');
    const job = await settle(svc, started.jobId);
    expect(job.state).toBe('failed');
    expect(job.message).toContain('something broke in Blender');
    svc.dispose();
  });

  it('runs one bake at a time, cancels, and times out', async () => {
    const svc = createBakeService({ host: 'local', blender: fakeBlender('hang'), timeoutMs: 20_000, workRoot: join(work, 'hang') });
    const first = svc.start('p1', pkg());
    if (!first.ok) throw new Error('not started');
    expect(svc.start('p1', pkg())).toMatchObject({ ok: false, code: 'bake_busy' });
    expect(svc.cancel('p1', first.jobId)).toBe(true);
    expect((await settle(svc, first.jobId)).state).toBe('cancelled');
    await new Promise((r) => setTimeout(r, 100));
    svc.dispose();

    const slow = createBakeService({ host: 'local', blender: fakeBlender('hang'), timeoutMs: 300, workRoot: join(work, 'slow') });
    const s = slow.start('p1', pkg());
    if (!s.ok) throw new Error('not started');
    const timedOut = await settle(slow, s.jobId);
    expect(timedOut.state).toBe('failed');
    expect(timedOut.message).toContain('longer than');
    slow.dispose();
  });
});

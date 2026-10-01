/**
 * The scale bench generator at its small size: the project it writes is one
 * the backend opens as it stands on disk, every source file is distinct and
 * matches its record, and the same seed writes the same bytes.
 */
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { openWorkspaceService } from '@thirdlight/workspace';

import { generateScaleProject, SCALE_SMALL, scaledSpec } from '../../tools/perf/scale-generate';

const root = mkdtempSync(join(homedir(), '.cache', 'tl-scale-gen-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const read = (dir: string, rel: string): unknown => JSON.parse(readFileSync(join(dir, rel), 'utf8'));

describe('scale bench generator', () => {
  it('writes a small project the backend opens as it stands, each asset a file with its sidecar holding its record', async () => {
    const r = await generateScaleProject(join(root, 'a'), 'scale', SCALE_SMALL, 7);
    // The workspace reads it the way it reads any project: content.json, the scenes, the resource files and the sidecars.
    const svc = openWorkspaceService({ root: join(root, 'a'), processMarker: 'node' });
    try {
      const q = svc.query({ op: 'queryProject', projectId: 'scale', args: {} }) as { ok: boolean; revision?: number };
      expect(q.ok, JSON.stringify(q).slice(0, 800)).toBe(true);
      expect(q.revision).toBe(0);
      const index = svc.query({ op: 'queryIndex', projectId: 'scale', args: { limit: 1024 } }) as unknown as { entries: { kind: string; id: string; path: string }[] };
      const kinds: Record<string, number> = {};
      for (const e of index.entries) kinds[e.kind] = (kinds[e.kind] ?? 0) + 1;
      expect(kinds).toEqual({ audio: SCALE_SMALL.voices + SCALE_SMALL.sounds, texture: SCALE_SMALL.textures, model: SCALE_SMALL.models, prefab: SCALE_SMALL.prefabs, material: SCALE_SMALL.materials, dialogue: r.counts.dialogues, scene: SCALE_SMALL.scenes });
      expect(r.counts.dialogueLines).toBe(SCALE_SMALL.dialogueNodes);
      // Each asset is a file in the project's folder, next to its sidecar holding its record.
      for (const e of index.entries.filter((x) => ['audio', 'texture', 'model'].includes(x.kind))) {
        const sidecar = read(r.dir, `${e.path}.tlasset`) as { tlasset: number; id: string; kind: string; record: { versions: { sourceDigest: string; sourceByteLength: number }[] } };
        expect(sidecar).toMatchObject({ tlasset: 3, id: e.id, kind: e.kind });
        const bytes = readFileSync(join(r.dir, e.path));
        expect(createHash('sha256').update(bytes).digest('hex')).toBe(sidecar.record.versions[0]!.sourceDigest);
        expect(bytes.length).toBe(sidecar.record.versions[0]!.sourceByteLength);
        // Voice lines are read when played (as a voiced game sets them); other sounds with their scene.
        if (e.kind === 'audio') expect((sidecar as unknown as { importSettings: { preload: boolean } }).importSettings.preload).toBe(!e.id.startsWith('voice-'));
      }
    } finally {
      svc.dispose();
    }
  });

  it('is deterministic for a seed and differs for another', async () => {
    const digests = (dir: string): string[] => readdirSync(join(dir, 'assets'), { recursive: true, encoding: 'utf8' }).filter((f) => f.endsWith('.tlasset')).map((f) => (read(dir, join('assets', f)) as { record: { versions: { sourceDigest: string }[] } }).record.versions[0]!.sourceDigest).sort();
    const a = await generateScaleProject(join(root, 'b1'), 'scale', SCALE_SMALL, 11);
    const b = await generateScaleProject(join(root, 'b2'), 'scale', SCALE_SMALL, 11);
    const c = await generateScaleProject(join(root, 'b3'), 'scale', SCALE_SMALL, 12);
    expect(digests(a.dir).length).toBeGreaterThan(0);
    expect(digests(b.dir)).toEqual(digests(a.dir));
    expect(readFileSync(join(b.dir, 'content.json'))).toEqual(readFileSync(join(a.dir, 'content.json')));
    expect(digests(c.dir)).not.toEqual(digests(a.dir));
  });

  it('embeds a KTX2 or a WebP in every embedEvery-th model, alternately, the inspector accepting both', async () => {
    const r = await generateScaleProject(join(root, 'e'), 'scale', SCALE_SMALL, 7);
    const formats: string[] = [];
    for (let i = 0; i < SCALE_SMALL.models; i++) {
      const id = `model-${String(i).padStart(5, '0')}`;
      const sidecar = read(r.dir, `assets/model/${id}.glb.tlasset`) as { record: { versions: { metrics: { images: number; decodedImageBytes: number } }[] } };
      const glb = readFileSync(join(r.dir, 'assets', 'model', `${id}.glb`));
      const json = JSON.parse(glb.subarray(20, 20 + glb.readUInt32LE(12)).toString('utf8')) as { images: { mimeType: string }[]; extensionsRequired?: string[] };
      formats.push(json.images[0]!.mimeType);
      const size = i % SCALE_SMALL.embedEvery === 0 ? SCALE_SMALL.embedSize : 8;
      expect(sidecar.record.versions[0]!.metrics).toMatchObject({ images: 1, decodedImageBytes: size * size * 4 });
    }
    expect(formats).toEqual(Array.from({ length: SCALE_SMALL.models }, (_, i) => (i % SCALE_SMALL.embedEvery !== 0 ? 'image/png' : (i / SCALE_SMALL.embedEvery) % 2 === 0 ? 'image/ktx2' : 'image/webp')));
  });

  it('scales the full size by a factor', () => {
    const s = scaledSpec(0.01);
    expect(s.voices).toBe(100);
    expect(s.scenes).toBe(3);
    expect(s.walkthroughLines).toBe(20);
  });
});

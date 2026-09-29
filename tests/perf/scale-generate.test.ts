/**
 * The scale bench generator at its small size: the project it writes is one
 * the model accepts as it stands on disk, every source file is distinct and
 * matches its record, and the same seed writes the same bytes.
 */
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { validateProjectV4 } from '@thirdlight/project-model';

import { generateScaleProject, SCALE_SMALL, scaledSpec } from '../../tools/perf/scale-generate';

const root = mkdtempSync(join(homedir(), '.cache', 'tl-scale-gen-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const read = (dir: string, rel: string): unknown => JSON.parse(readFileSync(join(dir, rel), 'utf8'));

describe('scale bench generator', () => {
  it('writes a small project the model validates, with distinct sources matching their records', () => {
    const r = generateScaleProject(join(root, 'a'), 'scale', SCALE_SMALL, 7);
    const content = read(r.dir, 'content.json') as { content: { assets: { assetId: string; kind: string; versions: { sourceDigest: string; sourceByteLength: number }[] }[]; dialogues: unknown[] } };
    const scenes = r.sceneIds.map((id) => (read(r.dir, `scenes/${id}.json`) as { scene: unknown }).scene);
    const v = validateProjectV4(read(r.dir, 'project.json'), content.content, scenes, 0);
    expect(v.ok ? [] : v.errors.slice(0, 5)).toEqual([]);

    const kinds: Record<string, number> = {};
    for (const a of content.content.assets) kinds[a.kind] = (kinds[a.kind] ?? 0) + 1;
    expect(kinds).toEqual({ music: SCALE_SMALL.voices, audio: SCALE_SMALL.sounds, texture: SCALE_SMALL.textures, model: SCALE_SMALL.models });
    expect(r.counts.dialogueLines).toBe(SCALE_SMALL.dialogueNodes);
    expect(r.counts.scenes).toBe(SCALE_SMALL.scenes);

    const blobs = readdirSync(join(r.dir, 'sources', 'sha256'));
    expect(blobs.length).toBe(content.content.assets.length);
    for (const a of content.content.assets) {
      const bytes = readFileSync(join(r.dir, 'sources', 'sha256', a.versions[0]!.sourceDigest));
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(a.versions[0]!.sourceDigest);
      expect(bytes.length).toBe(a.versions[0]!.sourceByteLength);
    }
  });

  it('is deterministic for a seed and differs for another', () => {
    const digests = (dir: string): string[] => readdirSync(join(dir, 'sources', 'sha256')).sort();
    const a = generateScaleProject(join(root, 'b1'), 'scale', SCALE_SMALL, 11);
    const b = generateScaleProject(join(root, 'b2'), 'scale', SCALE_SMALL, 11);
    const c = generateScaleProject(join(root, 'b3'), 'scale', SCALE_SMALL, 12);
    expect(digests(b.dir)).toEqual(digests(a.dir));
    expect(readFileSync(join(b.dir, 'content.json'))).toEqual(readFileSync(join(a.dir, 'content.json')));
    expect(digests(c.dir)).not.toEqual(digests(a.dir));
  });

  it('scales the full size by a factor', () => {
    const s = scaledSpec(0.01);
    expect(s.voices).toBe(100);
    expect(s.scenes).toBe(3);
    expect(s.walkthroughLines).toBe(20);
  });
});

/**
 * The storage-v4 project files of the contract corpus
 * (fixtures/commands/envelope, indexed by fixtures/commands/expected.json):
 *
 * - every valid project directory loads (`loadV4`) at the pinned revision
 *   with the pinned record count, and rebuilding each file from the loaded
 *   state (`contentFileBytes` / `sceneFileBytes` / `manifestV2Bytes`)
 *   reproduces the fixture bytes exactly (canonical form);
 * - every invalid project directory is blocked with the pinned reason and
 *   first error code, and the service reports the same reason as
 *   `project_unavailable`.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { defaultWriteOps, openWorkspaceService } from '@thirdlight/workspace';

import { CONTENT_REL, contentFileBytes, loadV4, manifestV2Bytes, MANIFEST_REL_V4, sceneFileBytes, sceneRel } from '../src/store-v4';
import { FIXTURES, makeRoot, seedProject } from './helpers';

interface Index {
  envelopeFixtures: ({ dir: string; project: string; revision: number; records: number } | { dir: string; reason: string; code: string; file: string })[];
}

const index = JSON.parse(readFileSync(join(FIXTURES, 'expected.json'), 'utf8')) as Index;
const valid = index.envelopeFixtures.filter((e): e is { dir: string; project: string; revision: number; records: number } => 'project' in e);
const invalid = index.envelopeFixtures.filter((e): e is { dir: string; reason: string; code: string; file: string } => 'reason' in e);

const text = (p: string): string => readFileSync(p, 'utf8');
const utf8 = (b: Uint8Array): string => new TextDecoder().decode(b);

describe('v4 project files: canonical bytes (fixtures/commands/envelope/valid)', () => {
  it('the index lists the five valid and eight invalid project directories', () => {
    expect(valid.map((e) => e.dir.split('/').pop())).toEqual(['demo-0001-rev0', 'demo-0001-rev5', 'demo-0001-rev6', 'demo-0001-rev7', 'demo-0002-revision-129']);
    expect(invalid).toHaveLength(8);
  });

  for (const fx of valid) {
    it(`${fx.dir} loads at revision ${fx.revision} with ${fx.records} records and rebuilds byte-identically`, () => {
      const dir = join(FIXTURES, fx.dir);
      const l = loadV4(defaultWriteOps, dir, fx.project);
      if (l.kind !== 'loaded') throw new Error(`fixture must load: ${JSON.stringify(l).slice(0, 400)}`);
      const { state } = l;
      expect(state.revision).toBe(fx.revision);
      expect([...state.fileRecords.values()].reduce((n, r) => n + r.length, 0)).toBe(fx.records);
      expect(state.content.scenes.map((s) => s.sceneId)).toEqual(['scene-main']);

      expect(utf8(manifestV2Bytes(state.manifest))).toBe(text(join(dir, MANIFEST_REL_V4)));
      const contentRevision = (JSON.parse(text(join(dir, CONTENT_REL))) as { revision: number }).revision;
      expect(utf8(contentFileBytes(fx.project, contentRevision, state.content, state.fileRecords.get(CONTENT_REL) ?? []))).toBe(text(join(dir, CONTENT_REL)));
      for (const [sceneId, scene] of state.scenes) {
        const rel = sceneRel(sceneId);
        expect(utf8(sceneFileBytes(fx.project, scene, state.fileRecords.get(rel) ?? []))).toBe(text(join(dir, rel)));
      }
    });
  }
});

describe('v4 project files: strict load failures (fixtures/commands/envelope/invalid)', () => {
  for (const fx of invalid) {
    it(`${fx.dir} ⇒ ${fx.reason} (${fx.file})`, () => {
      const l = loadV4(defaultWriteOps, join(FIXTURES, fx.dir), 'demo-0001');
      if (l.kind !== 'blocked') throw new Error('an invalid fixture must not load');
      expect(l.reason).toBe(fx.reason);
      expect(l.count).toBeGreaterThanOrEqual(1);
      expect(l.errors[0]!.code).toBe(fx.code);
      expect(l.errors[0]!.path).toBeTypeOf('string');
      expect(l.errors[0]!.message).toBeTypeOf('string');
    });
  }

  it('the service blocks each invalid project with the same reason (project_unavailable)', () => {
    for (const fx of invalid) {
      const root = makeRoot('v4-invalid');
      seedProject(root, join(FIXTURES, fx.dir), 'demo-0001');
      const svc = openWorkspaceService({ root, storageV4: true });
      const q = svc.query({ op: 'queryProject', projectId: 'demo-0001' }) as { ok: boolean; error?: { code: string; reason?: string } };
      expect(q.ok, fx.dir).toBe(false);
      expect(q.error?.code, fx.dir).toBe('project_unavailable');
      expect(q.error?.reason, fx.dir).toBe(fx.reason);
      svc.dispose();
    }
  });
});

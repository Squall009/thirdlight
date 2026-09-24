/**
 * Phase 15.0 — the descriptor registry travels with `queryGameConfig`
 * (`args.descriptors: true`): the editor may import project-model types
 * only, so this is how it reads the registry. Parity: what the query returns
 * equals project-model's `DESCRIPTORS`; without the flag nothing extra is
 * sent; a non-boolean flag is refused.
 */
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { DESCRIPTORS } from '@thirdlight/project-model';
import { openWorkspaceService } from '@thirdlight/workspace';

import { REPO_ROOT, makeRoot, seedProject } from './helpers';

const STORAGE = join(REPO_ROOT, 'fixtures', 'm3', 'storage');
const PROJECT_ID = 'demo-0003';
const SELF = { backendId: 'tb-' + 'e'.repeat(32), pid: 6302 };

describe('descriptor registry over queryGameConfig (phase 15.0)', () => {
  it('returns the registry only when asked, equal to project-model, and refuses a bad flag', () => {
    const root = makeRoot('descriptors-query');
    seedProject(root, join(STORAGE, 'project-v3-demo-0003'), PROJECT_ID);
    const svc = openWorkspaceService({ root, utcNow: () => '2026-09-24T10:00:00Z', ...SELF });
    const plain = svc.query({ op: 'queryGameConfig', projectId: PROJECT_ID }) as unknown as Record<string, unknown>;
    expect(plain['ok']).toBe(true);
    expect(plain['descriptors']).toBeUndefined();
    const off = svc.query({ op: 'queryGameConfig', projectId: PROJECT_ID, args: { descriptors: false } }) as unknown as Record<string, unknown>;
    expect(off['ok']).toBe(true);
    expect(off['descriptors']).toBeUndefined();
    const withDescriptors = svc.query({ op: 'queryGameConfig', projectId: PROJECT_ID, args: { descriptors: true } }) as unknown as Record<string, unknown>;
    expect(withDescriptors['ok']).toBe(true);
    expect(withDescriptors['descriptors']).toEqual(JSON.parse(JSON.stringify(DESCRIPTORS)));
    // everything else is the same answer
    const { descriptors: _d, ...rest } = withDescriptors;
    expect(rest).toEqual(plain);
    const bad = svc.query({ op: 'queryGameConfig', projectId: PROJECT_ID, args: { descriptors: 'yes' } }) as unknown as { ok: boolean; error: { code: string; path: string } };
    expect(bad.ok).toBe(false);
    expect(bad.error).toMatchObject({ code: 'field_type', path: '/args/descriptors' });
    const other = svc.query({ op: 'queryGameConfig', projectId: PROJECT_ID, args: { descriptors: true, limit: 1 } }) as unknown as { ok: boolean };
    expect(other.ok).toBe(false);
    svc.close();
  });
});

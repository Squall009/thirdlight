/**
 * Packet 48 coordinator repair — the v3 query surface through the workspace.
 *
 * `commands.md` §3.1.11/authoring §A6 add `queryGameConfig`, and packet 45
 * added the `queryEntities` `component` filter. Packet 48 exposed both on the
 * wire (protocol) but could not edit the workspace dispatch, so B02's query
 * half was unreachable. This test pins the real service path.
 */

import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openWorkspaceService, type WorkspaceService } from '@thirdlight/workspace';

import { REPO_ROOT, makeRoot, seedProject } from './helpers';

const STORAGE = join(REPO_ROOT, 'fixtures', 'm3', 'storage');
const V3 = 'demo-0003';
const V2 = 'demo-0002';
const CREATED_AT = '2026-09-19T10:00:00Z';

function open(root: string): WorkspaceService {
  return openWorkspaceService({ root, utcNow: () => CREATED_AT });
}

describe('packet 48 repair — v3 queries through the real service', () => {
  it('serves queryGameConfig for a v3 state and reflects a legal partial edit', () => {
    const root = makeRoot('m3q-game');
    seedProject(root, join(STORAGE, 'project-v3-demo-0003'), V3);
    const svc = open(root);
    const q0 = svc.query({ op: 'queryGameConfig', projectId: V3 }) as {
      ok: boolean;
      revision?: number;
      game?: { title?: string; objective?: string; cues?: Record<string, unknown> } | null;
    };
    expect(q0.ok, JSON.stringify(q0)).toBe(true);
    expect(q0.revision).toBe(3);
    expect(q0.game?.title).toBe('Beacon Reach');
    expect(q0.game?.objective).toBe('Reach the beacon');
    expect(Object.keys(q0.game?.cues ?? {})).toEqual(['start', 'jump', 'checkpoint', 'death', 'goal']);

    const r = svc.runCommand({
      op: 'setGameConfig',
      projectId: V3,
      expectedRevision: q0.revision!,
      requestId: 'req-' + 'a'.repeat(32),
      origin: { kind: 'mcp', clientId: 'pi-q' },
      args: { game: { title: 'Beacon Reach II' } },
    }) as { ok: boolean; revision?: number };
    expect(r.ok, JSON.stringify(r)).toBe(true);

    const q1 = svc.query({ op: 'queryGameConfig', projectId: V3 }) as {
      ok: boolean;
      revision?: number;
      game?: { title?: string; objective?: string } | null;
    };
    expect(q1.ok).toBe(true);
    expect(q1.revision).toBe(4);
    expect(q1.game?.title).toBe('Beacon Reach II');
    // The partial edit preserved the untouched fields.
    expect(q1.game?.objective).toBe('Reach the beacon');

    // No args are accepted.
    const bad = svc.query({ op: 'queryGameConfig', projectId: V3, args: { limit: 1 } }) as {
      ok: boolean;
      error?: { code?: string };
    };
    expect(bad.ok).toBe(false);
    expect(bad.error?.code).toBe('field_unexpected');
    svc.dispose();
  });

  it('reads a v2 state as game: null (the v2 catalog has no game key)', () => {
    const root = makeRoot('m3q-v2');
    seedProject(root, join(STORAGE, 'project-v2-demo-0002'), V2);
    const svc = open(root);
    const q = svc.query({ op: 'queryGameConfig', projectId: V2 }) as { ok: boolean; game?: unknown };
    expect(q.ok, JSON.stringify(q)).toBe(true);
    expect(q.game).toBeNull();
    svc.dispose();
  });

  it('filters queryEntities by component and rejects an unknown name', () => {
    const root = makeRoot('m3q-filter');
    seedProject(root, join(STORAGE, 'project-v3-demo-0003'), V3);
    const svc = open(root);
    const all = svc.query({ op: 'queryEntities', projectId: V3 }) as { ok: boolean; total?: number };
    expect(all.ok).toBe(true);
    expect(all.total).toBe(9);
    // C35-5 / CC-48-3: the queryProject scene summary carries the scene
    // document's schemaVersion (3 for this v3 fixture), not the manifest's 1.
    const proj = svc.query({ op: 'queryProject', projectId: V3 }) as {
      ok: boolean;
      scene?: { schemaVersion?: number };
      manifest?: { schemaVersion?: number };
    };
    expect(proj.scene?.schemaVersion).toBe(3);
    expect(proj.manifest?.schemaVersion).toBe(1);

    const zones = svc.query({ op: 'queryEntities', projectId: V3, args: { component: 'gameZone' } }) as {
      ok: boolean;
      total?: number;
      entities?: { id: string }[];
    };
    expect(zones.ok, JSON.stringify(zones)).toBe(true);
    expect(zones.total).toBe(2);
    expect(zones.entities?.map((e) => e.id)).toEqual(['zone-0001', 'zone-0003']);

    // The filter composes with paging (total counts the filtered set).
    const page = svc.query({
      op: 'queryEntities',
      projectId: V3,
      args: { component: 'gameZone', offset: 1, limit: 1 },
    }) as { ok: boolean; total?: number; entities?: { id: string }[] };
    expect(page.ok).toBe(true);
    expect(page.total).toBe(2);
    expect(page.entities?.map((e) => e.id)).toEqual(['zone-0003']);

    const bad = svc.query({ op: 'queryEntities', projectId: V3, args: { component: 'notAComponent' } }) as {
      ok: boolean;
      error?: { code?: string };
    };
    expect(bad.ok).toBe(false);
    expect(bad.error?.code).toBe('field_value');
    svc.dispose();
  });
});

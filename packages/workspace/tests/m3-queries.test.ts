/**
 * Packet 48 coordinator repair — the v3 query surface through the workspace.
 *
 * `commands.md` §3.1.11/authoring §A6 add `queryGameConfig`, and packet 45
 * added the `queryEntities` `component` filter. Packet 48 exposed both on the
 * wire (protocol) but could not edit the workspace dispatch, so B02's query
 * half was unreachable. This test pins the real service path.
 */

import { describe, expect, it } from 'vitest';
import { openWorkspaceService, type WorkspaceService } from '@thirdlight/workspace';

import { makeRoot, seedV3DemoProject } from './helpers';

const V3 = 'demo-0003';
const NEW = 'demo-0002';
const CREATED_AT = '2026-09-19T10:00:00Z';

function open(root: string): WorkspaceService {
  return openWorkspaceService({ root, utcNow: () => CREATED_AT });
}

describe('packet 48 repair — v3 queries through the real service', () => {
  it('serves queryGameConfig (the tag registry) for an upgraded v3 state and reflects a content edit', () => {
    const root = makeRoot('m3q-game');
    seedV3DemoProject(root, V3);
    const svc = open(root);
    const q0 = svc.query({ op: 'queryGameConfig', projectId: V3 }) as unknown as Record<string, unknown> & { ok: boolean; revision?: number; tags?: unknown };
    expect(q0.ok, JSON.stringify(q0)).toBe(true);
    expect(q0.revision).toBe(3);
    expect(q0.tags).toEqual([]);
    // Phase 24.7: the game block is gone from the answer.
    expect('game' in q0).toBe(false);

    const r = svc.runCommand({
      op: 'setTags',
      projectId: V3,
      expectedRevision: q0.revision!,
      requestId: 'req-' + 'a'.repeat(32),
      origin: { kind: 'mcp', clientId: 'pi-q' },
      args: { tags: [{ name: 'solid' }, { name: 'water' }] },
    }) as { ok: boolean; revision?: number };
    expect(r.ok, JSON.stringify(r)).toBe(true);

    const q1 = svc.query({ op: 'queryGameConfig', projectId: V3 }) as { ok: boolean; revision?: number; tags?: { bit: number; name: string }[] };
    expect(q1.ok).toBe(true);
    expect(q1.revision).toBe(4);
    expect(q1.tags?.map((t) => t.name)).toEqual(['solid', 'water']);
    expect(new Set(q1.tags?.map((t) => t.bit)).size).toBe(2);

    // No args are accepted.
    const bad = svc.query({ op: 'queryGameConfig', projectId: V3, args: { limit: 1 } }) as {
      ok: boolean;
      error?: { code?: string };
    };
    expect(bad.ok).toBe(false);
    expect(bad.error?.code).toBe('field_unexpected');
    svc.dispose();
  });

  it("reads a new project's game config as an empty tag registry", () => {
    // Formerly a storage v2 project (no game key); v1/v2 projects are now
    // refused (storage-version-refusal.test.ts).
    const root = makeRoot('m3q-nogame');
    const svc = open(root);
    expect(svc.createProject(NEW, 'No Game').ok).toBe(true);
    const q = svc.query({ op: 'queryGameConfig', projectId: NEW }) as unknown as Record<string, unknown> & { ok: boolean; revision?: number; tags?: unknown };
    expect(q.ok, JSON.stringify(q)).toBe(true);
    expect(q.revision).toBe(0);
    expect(q.tags).toEqual([]);
    expect('game' in q).toBe(false);
    svc.dispose();
  });

  it('filters queryEntities by component and rejects an unknown name', () => {
    const root = makeRoot('m3q-filter');
    seedV3DemoProject(root, V3);
    const svc = open(root);
    const all = svc.query({ op: 'queryEntities', projectId: V3 }) as { ok: boolean; total?: number };
    expect(all.ok).toBe(true);
    // The 9 v3 entities (phase 24.7: the upgrade adds no fall zone).
    expect(all.total).toBe(9);
    // C35-5 / CC-48-3: the queryProject scene summary carries the scene
    // document's schemaVersion, not the manifest's (the v3 fixture is upgraded
    // to storage v4 on open: scene schemaVersion 4, manifest schemaVersion 2).
    const proj = svc.query({ op: 'queryProject', projectId: V3 }) as {
      ok: boolean;
      scene?: { schemaVersion?: number };
      manifest?: { schemaVersion?: number };
    };
    expect(proj.scene?.schemaVersion).toBe(4);
    expect(proj.manifest?.schemaVersion).toBe(7);

    const spawns = svc.query({ op: 'queryEntities', projectId: V3, args: { component: 'playerSpawn' } }) as {
      ok: boolean;
      total?: number;
      entities?: { id: string }[];
    };
    expect(spawns.ok, JSON.stringify(spawns)).toBe(true);
    expect(spawns.total).toBe(2);
    expect(spawns.entities?.map((e) => e.id)).toEqual(['spawn-0001', 'spawn-0002']);

    // The filter composes with paging (total counts the filtered set).
    const page = svc.query({
      op: 'queryEntities',
      projectId: V3,
      args: { component: 'playerSpawn', offset: 1, limit: 1 },
    }) as { ok: boolean; total?: number; entities?: { id: string }[] };
    expect(page.ok).toBe(true);
    expect(page.total).toBe(2);
    expect(page.entities?.map((e) => e.id)).toEqual(['spawn-0002']);

    // Phase 24.7: gameZone is no component any more.
    const zones = svc.query({ op: 'queryEntities', projectId: V3, args: { component: 'gameZone' } }) as { ok: boolean; error?: { code?: string } };
    expect(zones.ok).toBe(false);
    expect(zones.error?.code).toBe('field_value');

    const bad = svc.query({ op: 'queryEntities', projectId: V3, args: { component: 'notAComponent' } }) as {
      ok: boolean;
      error?: { code?: string };
    };
    expect(bad.ok).toBe(false);
    expect(bad.error?.code).toBe('field_value');
    svc.dispose();
  });
});

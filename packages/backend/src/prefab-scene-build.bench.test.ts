/**
 * Scene build timings for a prefab-heavy scene, run on demand only
 * (`TL_BENCH=1`): 10 prefabs of 4 parts each (a box root and three box
 * children, one part with a collider), placed 100 times each — 1,000 copies,
 * 4,000 objects in one scene. Linked copies are assembled by the backend when
 * it builds a scene, so this is the cost they are held to (within 10 % of the
 * plain-copy numbers this printed before they existed).
 *
 * Timed at the real boundaries over HTTP: the editor's view (the scene's
 * objects read as the editor reads them, `queryEntities`) and a Play start's
 * backend part (`total`, the shared Play/export closure, and its scene
 * stage), each the median of five runs, every run after an edit so nothing
 * is served from a cache.
 *
 * Not a pass/fail test: it prints the numbers (the plan records them).
 * `TL_BENCH_COPIES` changes the copy count. `TL_BENCH_LINKED=1` places
 * linked copies instead (written into the scene file while the project is
 * closed, as no command writes links yet), so the numbers include assembly.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { api, establish, mkRequestId, mkSessionId, startBackend, upgrade, type TestBackend } from './test-helpers';
import { FakeEditor } from './test-editor';

const PID = 'demo-0001';
const REPO = resolve(import.meta.dirname, '..', '..', '..');
const PREFABS = 10;
const COPIES = Number(process.env.TL_BENCH_COPIES ?? 1000);
const RUNS = 5;
const LINKED = process.env.TL_BENCH_LINKED === '1';

const median = (xs: number[]): number => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] as number;

describe.skipIf(process.env.TL_BENCH !== '1')('prefab scene build timings', () => {
  let tb: TestBackend;
  const revision = (): number => {
    const r = tb.backend._test.service.readCapturedV3(PID);
    if (!r.ok) throw new Error(r.error.code);
    return r.read.revision;
  };
  const send = async (op: string, args: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const r = await api(`${tb.authUrl}/api/v1/projects/${PID}/commands`, { body: { op, projectId: PID, expectedRevision: revision(), requestId: mkRequestId(), origin: { kind: 'mcp', clientId: 'prefab-bench' }, args }, token: tb.adminToken, origin: null });
    expect(r.status, JSON.stringify(r.json).slice(0, 400)).toBe(200);
    return r.json as Record<string, unknown>;
  };

  beforeAll(async () => {
    tb = await startBackend({ engineRoot: REPO, timeouts: { presentTimeoutSeconds: 120, inactivityTtlSeconds: 600 } });
    for (let p = 0; p < PREFABS; p++) {
      const root = await send('createEntity', { kind: 'box', name: `Prefab ${p}`, sceneId: 'scene-main', box: { size: [1 + p * 0.1, 1, 1] }, components: { collider: { shape: { type: 'box', hx: 0.5, hy: 0.5, hz: 0.5 } } } });
      const rootId = root['createdId'] as string;
      await send('createEntities', { entities: [0, 1, 2].map((c) => ({ kind: 'box', name: `Part ${c}`, parentId: rootId, transform: { position: [c, 1, 0] }, box: { size: [0.3, 0.3, 0.3] } })) });
      await send('createPrefab', { prefabId: `bench-${p}`, displayName: `Bench ${p}`, sourceEntityId: rootId });
      await send('deleteEntity', { entityId: rootId });
    }
    const started = performance.now();
    const at = (i: number): [number, number, number] => [(i % 40) * 3, 0, Math.floor(i / 40) * 3];
    if (LINKED) {
      expect(tb.backend._test.service.releaseWorkspace(PID).ok).toBe(true);
      const file = join(tb.root, 'data', 'projects', PID, 'scenes', 'scene-main.json');
      const doc = JSON.parse(readFileSync(file, 'utf8')) as { scene: { entities: unknown[] } };
      for (let i = 0; i < COPIES; i++) doc.scene.entities.push({ id: `copy-${i}`, components: { transform: { position: at(i), rotation: [0, 0, 0, 1], scale: [1, 1, 1] }, prefab: { prefabId: `bench-${i % PREFABS}` } } });
      writeFileSync(file, JSON.stringify(doc));
    } else {
      for (let i = 0; i < COPIES; i++) {
        await send('instantiatePrefab', { prefabId: `bench-${i % PREFABS}`, sceneId: 'scene-main', transform: { position: at(i) } });
      }
    }
    console.log(`[prefab bench] placed ${COPIES} ${LINKED ? 'linked' : 'plain'} copies in ${Math.round(performance.now() - started)} ms`);
  }, 900_000);
  afterAll(async () => {
    await tb?.teardown();
  });

  it(`builds a scene of ${COPIES} copies of ${PREFABS} prefabs`, async () => {
    const r = tb.backend._test.service.readCapturedV3(PID);
    if (!r.ok) throw new Error(r.error.code);
    // Linked copies count as the objects they assemble into (the captured read is assembled).
    const objects = (r.read.scene as { entities: unknown[] }).entities.length;
    expect(objects).toBeGreaterThanOrEqual(COPIES * 4);

    // A nudge between runs: a new revision, so no run reuses the last build.
    let nudge = 0;
    const edit = async (): Promise<void> => {
      nudge++;
      await send('updateEntity', { entityId: 'cam-main', name: `Camera ${nudge}` });
    };

    // The editor's view: the scene's objects read as the editor reads them (one page).
    const viewMs: number[] = [];
    for (let i = 0; i < RUNS; i++) {
      await edit();
      const t0 = performance.now();
      const q = await api(`${tb.authUrl}/api/v1/projects/${PID}/commands`, { body: { op: 'queryEntities', projectId: PID, args: { limit: 16_384, offset: 0 } }, token: tb.adminToken, origin: null });
      viewMs.push(performance.now() - t0);
      expect((q.json as { entities: unknown[] }).entities.length).toBe(objects);
    }

    const sid = mkSessionId();
    const est = await establish(tb, sid);
    const ws = await upgrade(tb, sid, est.wsToken);
    await ws.waitFor((m) => (m as { type?: string }).type === 'attached', 120_000);
    const editor = new FakeEditor(ws);
    const play: { total: number; closure: number; scenes: number }[] = [];
    for (let i = 0; i < RUNS; i++) {
      await edit();
      const p = await api(`${tb.authUrl}/api/v1/projects/${PID}/play`, { body: {}, token: tb.authToken });
      expect(p.status, JSON.stringify(p.json).slice(0, 400)).toBe(200);
      const j = p.json as { playSessionId: string; timings: Record<string, number> };
      play.push({ total: j.timings['total'] ?? NaN, closure: j.timings['closure'] ?? NaN, scenes: j.timings['closure.scenes'] ?? NaN });
      await editor.waitUntil(() => tb.backend._test.plays.get(j.playSessionId)?.state === 'presented');
      editor.stoppedEvents.length = 0;
      await api(`${tb.authUrl}/api/v1/projects/${PID}/play/${j.playSessionId}/stop`, { body: {}, token: tb.authToken });
      await editor.waitForEvent('play.stopped');
    }
    ws.close();
    const report = {
      linked: LINKED,
      copies: COPIES,
      prefabs: PREFABS,
      objects,
      viewMs: Math.round(median(viewMs)),
      playTotalMs: Math.round(median(play.map((x) => x.total))),
      playClosureMs: Math.round(median(play.map((x) => x.closure))),
      playClosureScenesMs: Math.round(median(play.map((x) => x.scenes))),
      runs: { viewMs: viewMs.map(Math.round), play },
    };
    console.log(`[prefab bench] ${JSON.stringify(report)}`);
  }, 900_000);
});

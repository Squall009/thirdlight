/**
 * Scene build and prefab edit timings for a prefab-heavy scene, run on
 * demand only (`TL_BENCH=1`): 10 prefabs of 4 parts each (a box root and three box
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
 * A prefab edit is timed end to end as the editor sees it: the command
 * sent on the prefab's stage until its change reached the editor's own
 * projection over the WebSocket (the `mutation.applied` frame applied, or,
 * when the change outgrows one frame, the editor's re-read after
 * `workspace.resync`), with the frame's size.
 *
 * Not a pass/fail test: it prints the numbers (the plan records them).
 * `TL_BENCH_COPIES` changes the copy count and `TL_BENCH_PREFABS` the prefab
 * count (1: every copy is one prefab's, so its edit reaches them all).
 * `TL_BENCH_LINKED=1` places linked copies instead (written into the scene
 * file while the project is closed, which is quicker than placing them by
 * command), so the numbers include assembly. `TL_BENCH_FOOTPRINT=1` gives
 * every prefab's root a block footprint over a block layer, so every
 * command also writes the footprints of what the scene shows.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { Projection } from '../../../packages/editor/src/session/projection';
import { api, connectWs, establish, mkRequestId, mkSessionId, startBackend, upgrade, type TestBackend } from '../../../packages/backend/src/test-helpers';
import { FakeEditor } from '../../../packages/backend/src/test-editor';
import type { Any } from '../m23-3d/character-kit';

const PID = 'demo-0001';
const REPO = resolve(import.meta.dirname, '..', '..', '..');
const PREFABS = Number(process.env.TL_BENCH_PREFABS ?? 10);
const COPIES = Number(process.env.TL_BENCH_COPIES ?? 1000);
const RUNS = 5;
const LINKED = process.env.TL_BENCH_LINKED === '1';
const FOOTPRINT = process.env.TL_BENCH_FOOTPRINT === '1';

const median = (xs: number[]): number => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] as number;

describe.skipIf(process.env.TL_BENCH !== '1')('prefab scene build timings', () => {
  let tb: TestBackend;
  // One authoring session for both tests (a project holds one at a time).
  const sid = mkSessionId();
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
    if (FOOTPRINT) {
      // A layer under every copy (40 columns of copies 3 m apart), two rows filled, a cell field the footprints set.
      await send('setCellFields', { fields: [{ key: 'marked', type: 'bool' }] });
      await send('setBlockType', { block: { blockId: 'stone', name: 'Stone', variants: [{ color: '#888888' }], shape: 'full' } });
      const layer = (await send('createEntity', { kind: 'group', name: 'Ground', sceneId: 'scene-main', transform: { position: [0, -1, 0] } }))['createdId'] as string;
      const depth = Math.ceil(COPIES / 40) * 3 + 2;
      await send('setComponent', { entityId: layer, component: 'blockLayer', value: { cellSize: [1, 0.5, 1], bounds: { min: [0, 0, 0], max: [122, 4, depth] } } });
      await send('editBlocks', { entityId: layer, edits: [{ kind: 'fill', box: [0, 0, 0, 122, 2, depth], cell: { block: 'stone' } }] });
    }
    for (let p = 0; p < PREFABS; p++) {
      const footprint = FOOTPRINT ? { blockFootprint: { size: [1, 1], set: { marked: true } } } : {};
      const root = await send('createEntity', { kind: 'box', name: `Prefab ${p}`, sceneId: 'scene-main', box: { size: [1 + p * 0.1, 1, 1] }, components: { collider: { shape: { type: 'box', hx: 0.5, hy: 0.5, hz: 0.5 } }, ...footprint } });
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

    // A nudge between runs: a new revision, so no run reuses the last build. Timed: the cost of any command on this scene.
    let nudge = 0;
    const commandMs: number[] = [];
    const edit = async (): Promise<void> => {
      nudge++;
      const t0 = performance.now();
      await send('updateEntity', { entityId: 'cam-main', name: `Camera ${nudge}` });
      commandMs.push(performance.now() - t0);
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
      footprint: FOOTPRINT,
      copies: COPIES,
      prefabs: PREFABS,
      objects,
      viewMs: Math.round(median(viewMs)),
      playTotalMs: Math.round(median(play.map((x) => x.total))),
      playClosureMs: Math.round(median(play.map((x) => x.closure))),
      playClosureScenesMs: Math.round(median(play.map((x) => x.scenes))),
      commandMs: Math.round(median(commandMs)),
      runs: { viewMs: viewMs.map(Math.round), commandMs: commandMs.map(Math.round), play },
    };
    console.log(`[prefab bench] ${JSON.stringify(report)}`);
  }, 900_000);

  it(`a prefab edit reaches its ${Math.ceil(COPIES / PREFABS)} copies in the editor`, async () => {
    const query = async (op: string, args: Record<string, unknown>): Promise<Any> => (await api(`${tb.authUrl}/api/v1/projects/${PID}/commands`, { body: { op, projectId: PID, args }, token: tb.adminToken, origin: null })).json;
    const sessionId = sid;
    const est = await api(`${tb.authUrl}/api/v1/sessions`, { body: { projectId: PID, sessionId, clientInfo: { kind: 'browser', label: 'prefab-bench' } }, token: tb.authToken });
    expect(est.status, JSON.stringify(est.json).slice(0, 400)).toBe(200);
    const full = est.json as Any;
    const projection = new Projection();
    projection.hydrate({ revision: full.revision, entities: full.scene.entities, entitySceneIds: full.scene.entitySceneIds, scenes: full.scene.scenes, startScenes: full.scene.startScenes });
    const ws = await connectWs(`${tb.authUrl.replace(/^http/, 'ws')}/api/v1/ws?${new URLSearchParams({ sessionId, wsToken: full.wsToken }).toString()}`, { Origin: 'http://127.0.0.1:8501' });
    await ws.waitFor((m) => (m as Any).type === 'attached', 120_000);
    // Each frame's size and arrival, beside the parsed messages the helper queues.
    const sizes: { at: number; bytes: number }[] = [];
    ws.ws.on('message', (data: Buffer) => sizes.push({ at: performance.now(), bytes: data.length }));

    const part = ((await query('queryPrefabs', { prefabId: 'bench-0', stage: true })).stage.entities as Any[]).find((e) => e.name === 'Part 0').id as string;
    const copies = Math.ceil(COPIES / PREFABS);
    const runs: { commandMs: number; frameMs: number; applyMs: number; totalMs: number; frameBytes: number; resync: boolean; objects: number }[] = [];
    for (let i = 0; i < RUNS; i++) {
      const size = [0.3, 0.4 + i * 0.05, 0.3];
      const requestId = mkRequestId();
      sizes.length = 0;
      const t0 = performance.now();
      const r = await api(`${tb.authUrl}/api/v1/projects/${PID}/commands`, { body: { op: 'setComponent', projectId: PID, expectedRevision: revision(), requestId, origin: { kind: 'mcp', clientId: 'prefab-bench' }, args: { entityId: part, component: 'box', value: { size } } }, token: tb.adminToken, origin: null });
      const commandMs = performance.now() - t0;
      expect(r.status, JSON.stringify(r.json).slice(0, 400)).toBe(200);
      const m = (await ws.waitFor((x) => ((x as Any).type === 'mutation.applied' && (x as Any).requestId === requestId) || (x as Any).type === 'workspace.resync', 60_000)) as Any;
      const frame = sizes[sizes.length - 1]!;
      const t1 = performance.now();
      let objects = 0;
      if (m.type === 'mutation.applied') {
        objects = (m.change.assembled?.upsert as Any[] | undefined)?.reduce((n, g) => n + g.entities.length, 0) ?? 0;
        expect(projection.applyMutationApplied(m)).toEqual({ deduped: false, gap: false, applied: true });
      } else {
        // What the editor does on a resync: the project's scenes, then every object in pages.
        const proj = await query('queryProject', { environments: true });
        const q = await query('queryEntities', { limit: 16_384, offset: 0 });
        projection.hydrate({ revision: q.revision, entities: q.entities, entitySceneIds: q.entitySceneIds, scenes: proj.scenes, startScenes: proj.startScenes });
      }
      const t2 = performance.now();
      runs.push({ commandMs, frameMs: frame.at - t0, applyMs: t2 - t1, totalMs: t2 - t0, frameBytes: frame.bytes, resync: m.type === 'workspace.resync', objects });
      // Every copy shows the edit.
      const reached = projection.listEntities().filter((e) => e.name === 'Part 0' && (e.components as Any).prefab?.prefabId === 'bench-0' && JSON.stringify((e.components as Any).box?.size) === JSON.stringify(size));
      expect(reached.length).toBe(copies);
    }
    ws.close();
    const report = {
      linked: LINKED,
      footprint: FOOTPRINT,
      copiesReached: copies,
      totalMs: Math.round(median(runs.map((x) => x.totalMs))),
      commandMs: Math.round(median(runs.map((x) => x.commandMs))),
      frameMs: Math.round(median(runs.map((x) => x.frameMs))),
      applyMs: Math.round(median(runs.map((x) => x.applyMs))),
      frameBytes: Math.round(median(runs.map((x) => x.frameBytes))),
      resync: runs.some((x) => x.resync),
      runs: runs.map((x) => ({ ...x, commandMs: Math.round(x.commandMs), frameMs: Math.round(x.frameMs), applyMs: Math.round(x.applyMs), totalMs: Math.round(x.totalMs) })),
    };
    console.log(`[prefab bench] edit ${JSON.stringify(report)}`);
  }, 900_000);
});

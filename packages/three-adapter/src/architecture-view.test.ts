/**
 * Generated architecture on the page: the generator workers answer byte for
 * byte what the page makes, the view draws one mesh per chunk per material
 * with its far level, and an edit keeps the old meshes until the new ones
 * are in, re-making only the chunks it touched. Kit copies are drawn per
 * room, so a lamp lights and the walk culls them with their room.
 */
import * as THREE from 'three';
import { afterEach, describe, expect, it } from 'vitest';
import { architectureChunkInput, architectureChunkKeys, architectureStylesOf, encodeArchitectureChunks, expandArchitecture, generateArchitectureChunk, type ArchitectureComponent } from '@thirdlight/runtime';

import { answerArchitectureJob, runArchitectureWorker, type ArchitectureJobReply } from './architecture-worker';
import { ARCHITECTURE_CHUNK_MARK, ArchitectureView, type ArchitectureViewDeps } from './architecture-view';
import type { MeshWorkerPort } from './block-mesh-pool';
import { LayeredPointLight, lightsObject, ROOM_KEY } from './light-layers';
import { RoomCulling, ROOM_AT_KEY } from './room-culling';
import type { ModelInstance } from './visual';

// A neutral test style: two rooms' walls 40 m apart (two chunks each side), a crown moulding (detail) and a floor.
const STYLE: ArchitectureComponent = {
  chunkSize: 16,
  profiles: {
    wall: { points: [[0.1, 0], [0.1, 3], [-0.1, 3], [-0.1, 0]], slots: ['lower_wall', 'bevel', 'upper_wall'] },
    crown: { points: [[0, 2.7], [0.06, 2.8], [0.08, 3]], slots: ['crown', 'crown'], smooth: true },
  },
  elements: [
    { id: 'a', kind: 'sweep', path: { points: [[0, 0, 0], [8, 0, 0], [8, 0, 6], [0, 0, 6]], closed: true }, profile: 'wall', openings: [{ id: 'door', at: 4, width: 1.2, bottom: 0, top: 2.2 }] },
    { id: 'a-crown', kind: 'sweep', path: { points: [[0, 0, 0], [8, 0, 0], [8, 0, 6], [0, 0, 6]], closed: true, offset: 0.1 }, profile: 'crown', detail: true },
    { id: 'a-floor', kind: 'fill', path: { points: [[0, 0, 0], [8, 0, 0], [8, 0, 6], [0, 0, 6]], closed: true }, shape: 'flat', slot: 'floor' },
    { id: 'b', kind: 'sweep', path: { points: [[40, 0, 0], [48, 0, 0], [48, 0, 6], [40, 0, 6]], closed: true }, profile: 'wall' },
  ],
};

const stops: (() => void)[] = [];
afterEach(() => {
  for (const s of stops.splice(0)) s();
});

/** A generator worker on message ports: the worker core as a browser worker runs it. */
function portWorker(): MeshWorkerPort {
  const ch = new MessageChannel();
  const listenOn = (port: MessagePort, cb: (m: unknown) => void): void => {
    port.addEventListener('message', (e) => cb((e as MessageEvent).data));
    port.start();
  };
  runArchitectureWorker({ post: (m, t) => ch.port2.postMessage(m, [...(t ?? [])]), listen: (cb) => listenOn(ch.port2, cb) });
  const stop = (): void => {
    ch.port1.close();
    ch.port2.close();
  };
  stops.push(stop);
  return { post: (m, t) => ch.port1.postMessage(m, [...(t ?? [])]), listen: (cb) => listenOn(ch.port1, cb), onError: () => undefined, terminate: stop };
}

function makeView(extra: Partial<ArchitectureViewDeps> = {}): { view: ArchitectureView; root: THREE.Group } {
  const root = new THREE.Group();
  const view = new ArchitectureView({
    sheets: () => ({}),
    materials: () => null,
    template: () => null,
    dress: () => null,
    read: null,
    place: (r, shown) => (shown ? root.add(r) : root.remove(r)),
    shapeChanged: () => undefined,
    changed: () => undefined,
    ...extra,
  });
  return { view, root };
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 2));
async function settle(v: ArchitectureView): Promise<void> {
  for (let i = 0; i < 2000; i++) {
    v.update([0, 0, 0]);
    const d = v.diagnostics();
    if (d.queued === 0 && d.inFlight === 0 && d.arriving === 0) {
      v.update([0, 0, 0]);
      return;
    }
    await tick();
  }
  throw new Error('the generator never answered');
}

function digest(a: ArrayBufferView): string {
  const b = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
  let h = 0x811c9dc5;
  for (let i = 0; i < b.length; i++) h = Math.imul(h ^ b[i]!, 0x01000193) >>> 0;
  return `${b.length}:${h.toString(16)}`;
}
function drawn(root: THREE.Object3D): string[] {
  const out: string[] = [];
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.isMesh !== true) return;
    const g = m.geometry;
    out.push(`${m.name}:${['position', 'normal', 'uv', 'color'].map((n) => digest(g.getAttribute(n)!.array as ArrayBufferView)).join('|')}|${digest(g.getIndex()!.array as Uint32Array)}`);
  });
  return out.sort();
}

describe('generated architecture on the page', () => {
  it('a worker answers byte for byte what the page makes', async () => {
    const keys = [...architectureChunkKeys(STYLE, {}).values()];
    const w = portWorker();
    const replies = new Map<number, ArchitectureJobReply>();
    w.listen((m) => replies.set((m as ArchitectureJobReply).job, m as ArchitectureJobReply));
    keys.forEach((k, job) => w.post({ t: 'archGenerate', job, component: architectureChunkInput(STYLE, k), sheets: {}, cx: k.cx, cz: k.cz }));
    for (let i = 0; i < 500 && replies.size < keys.length; i++) await tick();
    expect(replies.size).toBe(keys.length);
    keys.forEach((k, job) => {
      const page = answerArchitectureJob({ t: 'archGenerate', job, component: STYLE, sheets: {}, cx: k.cx, cz: k.cz });
      const worker = replies.get(job)!;
      if (!page.ok || !worker.ok) throw new Error('a job failed');
      expect(digest(encodeArchitectureChunks([worker.chunk]))).toBe(digest(encodeArchitectureChunks([page.chunk])));
    });
  });

  it('draws one mesh per chunk per material, near and far levels, the same with workers as on the page', async () => {
    const page = makeView();
    page.view.set('arch', STYLE, [0, 0, 0]);
    await settle(page.view);
    // No arrival time to spare: while the workers start the page makes one chunk a frame, the workers the rest.
    const withWorkers = makeView({ worker: () => portWorker(), arrival: { left: () => 0, spent: () => undefined } });
    withWorkers.view.set('arch', STYLE, [0, 0, 0]);
    await settle(withWorkers.view);
    expect(drawn(withWorkers.root)).toEqual(drawn(page.root));
    const d = withWorkers.view.diagnostics();
    expect(d.made.worker + d.made.page).toBe(architectureChunkKeys(STYLE, {}).size);
    expect(d.made.worker).toBeGreaterThan(0);
    expect(d.made.page).toBeGreaterThan(0);
    // One draw per chunk per material (one material slot here; chunks the elements' bounds reach but own nothing of are empty).
    expect(d.draws).toBe(withWorkers.root.children.filter((g) => g.children.length > 0).length);
    expect(d.draws).toBeGreaterThan(1);
    const lods: THREE.LOD[] = [];
    withWorkers.root.traverse((o) => (o as THREE.LOD).isLOD === true && lods.push(o as THREE.LOD));
    // The chunks with the crown moulding have a far level without it.
    expect(lods.length).toBeGreaterThan(0);
    for (const l of lods) expect(l.levels.map((x) => x.distance)).toEqual([0, 40]);
  });

  it('an edit re-makes only the chunks it touches and keeps the old meshes until the new ones are in', async () => {
    const { view, root } = makeView();
    view.set('arch', STYLE, [0, 0, 0]);
    await settle(view);
    const before = drawn(root);
    const made = view.diagnostics().made.page;
    // Move the far room's wall: its chunks change, the first room's do not.
    const edited: ArchitectureComponent = { ...STYLE, elements: STYLE.elements.map((e) => (e.id === 'b' && e.kind === 'sweep' ? { ...e, path: { ...e.path, points: e.path.points.map((p) => [p[0], p[1], p[2] + 1] as [number, number, number]) } } : e)) };
    view.remove('arch');
    view.set('arch', edited, [0, 0, 0]);
    // Nothing made yet: everything still drawn.
    expect(drawn(root)).toEqual(before);
    await settle(view);
    const after = view.diagnostics();
    const changed = [...architectureChunkKeys(edited, {}).values()].filter((k) => !new Set([...architectureChunkKeys(STYLE, {}).values()].map((x) => x.key)).has(k.key)).length;
    expect(after.made.page - made).toBe(changed);
    expect(drawn(root)).not.toEqual(before);
    // Undo: the old chunks come from memory, nothing is generated.
    view.set('arch', STYLE, [0, 0, 0]);
    await settle(view);
    expect(view.diagnostics().made.page).toBe(after.made.page);
    expect(drawn(root)).toEqual(before);
  });

  it("an export's shipped meshes are drawn as they are: nothing is generated", async () => {
    const page = makeView();
    page.view.set('arch', STYLE, [0, 0, 0]);
    await settle(page.view);
    const chunks = [...architectureChunkKeys(STYLE, {}).values()].map((k) => generateArchitectureChunk(STYLE, {}, k.cx, k.cz));
    const blob = encodeArchitectureChunks(chunks);
    const shipped = makeView({ read: () => Promise.resolve(blob.slice().buffer), worker: () => portWorker() });
    shipped.view.set('arch', { ...STYLE, baked: 'a'.repeat(64) }, [0, 0, 0]);
    for (let i = 0; i < 500 && shipped.view.diagnostics().made.baked === 0; i++) await tick();
    await settle(shipped.view);
    expect(drawn(shipped.root)).toEqual(drawn(page.root));
    const d = shipped.view.diagnostics();
    expect(d.made.baked).toBe(chunks.length);
    expect(d.made.worker + d.made.page).toBe(0);
  });

  it("an export's shipped meshes give way to generated ones when a script swaps only an outside preset, a building's too", async () => {
    const path = { points: [[0, 0, 0], [8, 0, 0], [8, 0, 6], [0, 0, 6]] as [number, number, number][], closed: true as const };
    const room: ArchitectureComponent = { elements: [], chunkSize: 16, outlines: [{ id: 'r', preset: 'starter-room', outside: 'starter-hall', path }] };
    // A building alone in its object (no outlines): its facade's preset swapped.
    const shed: ArchitectureComponent = { elements: [], chunkSize: 16, buildings: [{ id: 'b', preset: 'starter-room', outside: 'starter-hall', roof: { shape: 'hip' }, path }] };
    for (const [id, c] of [['room', room], ['shed', shed]] as const) {
      const expanded = expandArchitecture(c, [0, 0, 0], architectureStylesOf([])).component;
      const keys = [...architectureChunkKeys(expanded, {}).values()];
      const blob = encodeArchitectureChunks(keys.map((k) => generateArchitectureChunk(architectureChunkInput(expanded, k), {}, k.cx, k.cz)));
      const shipped = makeView({ read: () => Promise.resolve(blob.slice().buffer) });
      shipped.view.set(id, { ...c, baked: 'c'.repeat(64) }, [0, 0, 0]);
      for (let i = 0; i < 500 && shipped.view.diagnostics().made.baked === 0; i++) await tick();
      await settle(shipped.view);
      const before = drawn(shipped.root);
      expect(shipped.view.diagnostics().made.page, id).toBe(0);
      // The outside's preset swapped (the inside's kept): what it dresses is the swapped preset's, made here.
      shipped.view.setSwaps({ 'starter-hall': 'starter-room' });
      await settle(shipped.view);
      expect(shipped.view.diagnostics().made.page, id).toBeGreaterThan(0);
      expect(drawn(shipped.root), id).not.toEqual(before);
      shipped.view.dispose();
    }
  });

  it('a preset being dragged makes again only the objects its outlines reach, only their changed chunks, and the stored values come back from memory', async () => {
    const { view } = makeView();
    const room = (preset: string, x: number): ArchitectureComponent => ({ elements: [], chunkSize: 16, outlines: [{ id: 'r', preset, path: { points: [[x, 0, 0], [x + 8, 0, 0], [x + 8, 0, 6], [x, 0, 6]], closed: true } }] });
    view.set('east', room('starter-room', 0), [0, 0, 0]);
    view.set('west', room('starter-hall', 0), [100, 0, 0]);
    await settle(view);
    const made = (): number => view.diagnostics().made.page;
    const before = made();
    expect(view.diagnostics().chunks).toBeGreaterThan(0);
    // The room's slider: the hall is another preset, so only the room is made again.
    expect(view.preview({ preset: 'starter-room', values: { ceiling_height: 4.5 } })).toBe(1);
    await settle(view);
    const changed = made() - before;
    expect(changed).toBeGreaterThan(0);
    // Back to the stored values: every chunk is found in memory, nothing generated.
    expect(view.preview(null)).toBe(1);
    await settle(view);
    expect(made()).toBe(before + changed);
    expect(view.diagnostics().made.memory).toBeGreaterThanOrEqual(changed);
    // A swap (a script's) reaches the objects of the swapped preset.
    view.setSwaps({ 'starter-hall': 'starter-room' });
    await settle(view);
    expect(view.diagnostics().problems).toEqual([]);
    view.dispose();
  });
});

describe('a heavy chunk made in parts', () => {
  /** A block of 4 × 4 rooms 4 m wide sharing walls (one 16 m chunk), the wall x = `wall` between two of them moved. */
  const block = (wall = 8): ArchitectureComponent => {
    const outlines: NonNullable<ArchitectureComponent['outlines']> = [];
    for (let i = 0; i < 4; i++) {
      for (let j = 0; j < 4; j++) {
        const x0 = j === 1 && i === 2 ? wall : i * 4;
        const x1 = j === 1 && i === 1 ? wall : i * 4 + 4;
        outlines.push({ id: `r${i}${j}`, preset: 'starter-room', path: { points: [[x0, 0, j * 4], [x1, 0, j * 4], [x1, 0, j * 4 + 4], [x0, 0, j * 4 + 4]], closed: true }, openings: [{ id: 'door', at: 2, width: 1, bottom: 0, top: 2.1 }] });
      }
    }
    return { elements: [], chunkSize: 16, outlines };
  };
  const partJobs = (): number => performance.getEntriesByName(ARCHITECTURE_CHUNK_MARK).filter((m) => (m as PerformanceMark).detail?.part === true).length;

  it('its parts are jobs on the workers, joined into the bytes of the chunk made whole; a wall drag re-makes only the parts it changed', async () => {
    const expanded = expandArchitecture(block(), [0, 0, 0], architectureStylesOf([])).component;
    const keys = [...architectureChunkKeys(expanded, {}).values()];
    expect(keys.some((k) => (k.parts?.length ?? 0) > 1)).toBe(true);
    const jobs0 = partJobs();
    const { view, root } = makeView({ worker: portWorker });
    view.set('block', block(), [0, 0, 0]);
    await settle(view);
    const atLoad = partJobs() - jobs0;
    expect(atLoad).toBe(keys.reduce((n, k) => n + (k.parts?.length ?? 0), 0));
    expect(view.diagnostics().made.worker + view.diagnostics().made.page).toBe(keys.length);
    // The same meshes as the chunks made whole (an export's, drawn as they are).
    const blob = encodeArchitectureChunks(keys.map((k) => generateArchitectureChunk(architectureChunkInput(expanded, k), {}, k.cx, k.cz)));
    const whole = makeView({ read: () => Promise.resolve(blob.slice().buffer) });
    whole.view.set('block', { ...expanded, baked: 'b'.repeat(64) }, [0, 0, 0]);
    for (let i = 0; i < 500 && whole.view.diagnostics().made.baked === 0; i++) await tick();
    await settle(whole.view);
    expect(drawn(root).length).toBeGreaterThan(0);
    expect(drawn(root)).toEqual(drawn(whole.root));
    // A shared wall dragged: fewer part jobs than the chunk has parts.
    const jobs1 = partJobs();
    view.set('block', block(8.5), [0, 0, 0]);
    await settle(view);
    const dragged = partJobs() - jobs1;
    expect(dragged).toBeGreaterThan(0);
    expect(dragged).toBeLessThan(atLoad);
    // Back: every part and chunk from memory.
    const jobs2 = partJobs();
    view.set('block', block(), [0, 0, 0]);
    await settle(view);
    expect(partJobs()).toBe(jobs2);
    expect(drawn(root)).toEqual(drawn(whole.root));
    view.dispose();
    whole.view.dispose();
  });
});

describe('a scene prepared ahead of its load', () => {
  it('makes its chunks into the cache, not drawn; the object that then loads draws them from memory at once', async () => {
    const { view, root } = makeView({ worker: portWorker });
    const prep = view.prepare([{ id: 'house', component: STYLE, origin: [0, 0, 0] }]);
    let done = false;
    void prep.ready.then(() => (done = true));
    for (let i = 0; i < 2000 && !done; i++) {
      view.update([0, 0, 0]);
      await tick();
    }
    expect(done).toBe(true);
    const made = view.diagnostics();
    expect(made.made.worker + made.made.page).toBe(architectureChunkKeys(STYLE, {}).size);
    expect(made.objects).toBe(0);
    expect(root.children.length).toBe(0);
    // The scene arrives: every chunk comes from memory and is drawn in that frame.
    view.set('house', STYLE, [0, 0, 0]);
    view.update([0, 0, 0]);
    const after = view.diagnostics();
    expect(after.made.memory).toBe(architectureChunkKeys(STYLE, {}).size);
    expect(after.made.worker + after.made.page).toBe(made.made.worker + made.made.page);
    expect(after.chunks).toBe(architectureChunkKeys(STYLE, {}).size);
    prep.release();
    view.dispose();
  });

});

describe('kit copies and rooms', () => {
  it('kit copies are drawn per room: each draw lit and culled with its room, copies in a wall in none', async () => {
    const scene = new THREE.Scene();
    const rooms = new RoomCulling({ scene, edgeClosed: () => false, regroup: () => undefined, roomLights: () => undefined, culling: true, changed: () => undefined });
    const kit = new THREE.Group();
    kit.add(new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.4, 0.4), new THREE.MeshStandardMaterial()));
    const { view } = makeView({
      template: () => ({ glbRoot: kit }) as unknown as ModelInstance,
      rooms: (id, origin, _c, plans) => rooms.setObject(id, origin, plans),
      copyRoomAt: (x, y, z) => rooms.copyRoomAt(x, y, z),
      // Listed as the render graph lists a static root's drawables: each one among the scene's children.
      place: (r, shown) => {
        if (!shown) return;
        r.updateMatrixWorld(true);
        r.traverse((o) => {
          if ((o as THREE.Mesh).isMesh !== true) return;
          scene.children.push(o);
          rooms.listed(o);
        });
      },
    });
    const square = (x0: number, z0: number, x1: number, z1: number): number[][] => [[x0, 0, z0], [x1, 0, z0], [x1, 0, z1], [x0, 0, z1]];
    const copy = (id: string, x: number, z: number) => ({ id, kind: 'repeat' as const, path: { points: [[x, 0, z], [x + 1, 0, z]] }, spacing: 100, piece: { model: { assetId: 'kit' } } });
    // Rooms a (x 0–4) and b (x 4–8) sharing a wall; a copy in each (one chunk: one copy set of the model), one in the shared wall, one outside.
    const component = {
      elements: [copy('in-a', 2, 2), copy('in-b', 6, 2), copy('in-wall', 4, 3), copy('outside', 6, -3)],
      outlines: [{ id: 'a', preset: 'starter-room', path: { points: square(0, 0, 4, 4), closed: true } }, { id: 'b', preset: 'starter-room', path: { points: square(4, 0, 8, 4), closed: true } }],
    } as unknown as ArchitectureComponent;
    view.set('house', component, [0, 0, 0]);
    await settle(view);
    const copies = new Map<string, THREE.Mesh>();
    for (const o of scene.children) {
      if ((o as THREE.Mesh).isMesh !== true || o.userData[ROOM_AT_KEY] === undefined) continue;
      // The set's name: architecture:<object>:<chunk>:<model>:<room>.
      let set: THREE.Object3D | null = o;
      while (set !== null && set.name.split(':').length < 5) set = set.parent;
      copies.set(set!.name.split(':')[4]!, o as THREE.Mesh);
    }
    // One draw per room the copies stand in ('' : the outside), and the one in the wall.
    expect([...copies.keys()].sort()).toEqual(['', 'house/a', 'house/b', 'wall']);
    expect(['house/a', 'house/b', ''].map((k) => copies.get(k)!.userData[ROOM_KEY])).toEqual([1, 2, 0]);
    // The one in the wall is in no room: every lamp lights it and no walk hides it.
    expect(copies.get('wall')!.userData[ROOM_KEY]).toBeUndefined();
    const lamp = new LayeredPointLight(0xffffff, 1, 6);
    lamp.position.set(6, 2, 2);
    lamp.updateMatrixWorld();
    scene.children.push(lamp);
    rooms.listed(lamp);
    expect(['house/a', 'house/b', 'wall'].map((k) => lightsObject(lamp, copies.get(k)!))).toEqual([false, true, true]);
    // In b looking away from a: a's copy is not drawn, b's and the wall's are.
    const look = new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 100);
    look.position.set(5, 1.6, 2);
    look.lookAt(20, 1.2, 2);
    look.updateMatrixWorld();
    rooms.update(look);
    const inView = (k: string): boolean => copies.get(k)!.layers.isEnabled(0);
    expect(['house/a', 'house/b', 'wall'].map(inView)).toEqual([false, true, true]);
    view.dispose();
  });
  it("kit copies keep their models' materials: the object's (its `*` too) go on the generated meshes only", async () => {
    const kit = new THREE.Group();
    const own = new THREE.MeshStandardMaterial({ name: 'kit-own' });
    kit.add(new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.4, 0.4), own));
    const sheet = new THREE.MeshStandardMaterial({ name: 'trim-sheet' });
    const root = new THREE.Group();
    const { view } = makeView({
      template: () => ({ glbRoot: kit }) as unknown as ModelInstance,
      place: (r, shown) => (shown ? root.add(r) : root.remove(r)),
      // An object mapping `*` to its sheet: every mesh under the root it is given wears it.
      materials: (r) => {
        const was = new Map<THREE.Mesh, THREE.Material | THREE.Material[]>();
        r.traverse((o) => {
          const m = o as THREE.Mesh;
          if (m.isMesh !== true) return;
          was.set(m, m.material);
          m.material = sheet;
        });
        return () => was.forEach((mat, m) => (m.material = mat));
      },
    });
    const component = {
      elements: [{ id: 'chair', kind: 'repeat', path: { points: [[2, 0, 2], [3, 0, 2]] }, spacing: 100, piece: { model: { assetId: 'kit' } } }],
      outlines: [{ id: 'a', preset: 'starter-room', path: { points: [[0, 0, 0], [4, 0, 0], [4, 0, 4], [0, 0, 4]], closed: true } }],
    } as unknown as ArchitectureComponent;
    view.set('house', component, [0, 0, 0]);
    await settle(view);
    const worn = { walls: new Set<string>(), copies: new Set<string>() };
    root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh !== true) return;
      // A copy set is named after its model; the generated meshes after their slot.
      let set: THREE.Object3D | null = m;
      while (set !== null && !set.name.includes(':kit')) set = set.parent;
      (set !== null ? worn.copies : worn.walls).add((m.material as THREE.Material).name);
    });
    expect([...worn.walls]).toEqual(['trim-sheet']);
    expect(worn.copies.size).toBeGreaterThan(0);
    expect(worn.copies.has('trim-sheet')).toBe(false);
    view.dispose();
  });
});

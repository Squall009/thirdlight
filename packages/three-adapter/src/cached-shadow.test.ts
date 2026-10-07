import * as THREE from 'three/webgpu';
import { describe, expect, it } from 'vitest';

import { BATCH_KEY, createAutoBatcher } from './batching';
import { snapToLightGrid, staticShadowSize, STATIC_SHADOW_STEP } from './cached-shadow';
import { RenderGraph } from './render-graph';
import { CHANGING_ALPHA_KEY, DrawnCasters, isStaticCaster, MOVING_CASTER_KEY, STATIC_CASTER_KEY, StaticShadowRevision } from './shadow-casters';
import { STATIC_KEY } from './static-merge';

const box = (mat: THREE.Material = new THREE.MeshBasicMaterial()): THREE.Mesh => new THREE.Mesh(new THREE.BoxGeometry(), mat);

describe('the cached static shadow map', () => {
  it('casts static meshes and what stands for them; never skinned, posed or vertex-moving ones', () => {
    const s = box();
    s.userData[STATIC_KEY] = 'scene-main';
    expect(isStaticCaster(s)).toBe(true);
    expect(isStaticCaster(box())).toBe(false);
    const cell = box();
    cell.userData[STATIC_CASTER_KEY] = true;
    expect(isStaticCaster(cell)).toBe(true);
    // Wind or a vertex offset moves the shadow in the shader.
    const swaying = new THREE.MeshStandardNodeMaterial();
    swaying.positionNode = THREE.TSL.positionLocal;
    const tree = box(swaying);
    tree.userData[STATIC_KEY] = 'scene-main';
    expect(isStaticCaster(tree)).toBe(false);
    const posed = box();
    posed.userData[STATIC_KEY] = 'scene-main';
    posed.userData[MOVING_CASTER_KEY] = true;
    expect(isStaticCaster(posed)).toBe(false);
    const skinned = new THREE.SkinnedMesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial());
    skinned.userData[STATIC_KEY] = 'scene-main';
    expect(isStaticCaster(skinned)).toBe(false);
  });

  it('a clock-driven alpha (opacity or clip) casts every frame, not from the cached map', () => {
    const m = new THREE.MeshStandardNodeMaterial();
    const fence = box(m);
    fence.userData[STATIC_KEY] = 'scene-main';
    expect(isStaticCaster(fence)).toBe(true);
    m.userData[CHANGING_ALPHA_KEY] = true;
    expect(isStaticCaster(fence)).toBe(false);
  });

  it('draws the static map again for a change made in place: a texture arriving, a recompile, a swap, wind gained, a caster no longer static', () => {
    const drawn = new DrawnCasters();
    const m = new THREE.MeshStandardNodeMaterial();
    const fence = box(m);
    fence.userData[STATIC_KEY] = 'scene-main';
    const wall = box();
    wall.userData[STATIC_KEY] = 'scene-main';
    const record = (): void => {
      drawn.clear();
      drawn.add(fence);
      drawn.add(wall);
    };
    record();
    expect(drawn.has(fence)).toBe(true);
    expect(drawn.changed()).toBe(false);
    // The cutout's alpha map arrives on the material it already wears (needsUpdate bumps its version).
    m.alphaMap = new THREE.Texture();
    m.needsUpdate = true;
    expect(drawn.changed()).toBe(true);
    record();
    expect(drawn.changed()).toBe(false);
    // A swap to a material that sways: the old shadow must leave the static map.
    const swaying = new THREE.MeshStandardNodeMaterial();
    swaying.positionNode = THREE.TSL.positionLocal;
    fence.material = swaying;
    expect(drawn.changed()).toBe(true);
    record();
    // Its graph compiled again without the wind: in place, and static again.
    swaying.positionNode = null;
    swaying.needsUpdate = true;
    expect(drawn.changed()).toBe(true);
    record();
    // Posed from now on (an animator gained).
    wall.userData[MOVING_CASTER_KEY] = true;
    expect(drawn.changed()).toBe(true);
  });

  it('snaps the square to whole steps of the light frame; the static map is larger by the step at the same texel size', () => {
    const dir = new THREE.Vector3(0.5, -1, 0.4).normalize();
    // three's shadow camera for that light: its axes are the grid's frame.
    const cam = new THREE.OrthographicCamera();
    cam.position.set(0, 0, 0).addScaledVector(dir, -20);
    cam.lookAt(0, 0, 0);
    cam.updateMatrixWorld();
    const inv = cam.matrixWorldInverse;
    const step = 0.25;
    const out = new THREE.Vector3();
    for (const p of [new THREE.Vector3(3.3, 0, -71.2), new THREE.Vector3(-12.07, 0, 4.4), new THREE.Vector3(0.01, 0, 0.02)]) {
      const c = snapToLightGrid(p, dir, step, out).clone().applyMatrix4(inv);
      // Whole steps on the camera's x and y (texels), and within half a step of the point.
      expect(Math.abs(c.x / step - Math.round(c.x / step))).toBeLessThan(1e-6);
      expect(Math.abs(c.y / step - Math.round(c.y / step))).toBeLessThan(1e-6);
      const q = p.clone().applyMatrix4(inv);
      expect(Math.abs(c.x - q.x)).toBeLessThanOrEqual(step / 2 + 1e-9);
      expect(Math.abs(c.y - q.y)).toBeLessThanOrEqual(step / 2 + 1e-9);
    }
    // A camera wandering within a step keeps the square where it is.
    const a = snapToLightGrid(new THREE.Vector3(1.01, 0, 1.01), dir, 4, new THREE.Vector3());
    const b = snapToLightGrid(new THREE.Vector3(1.2, 0, 0.9), dir, 4, new THREE.Vector3());
    expect(a.distanceTo(b)).toBeLessThan(1e-9);
    const size = staticShadowSize({ mapSize: 1024, halfExtent: 26 });
    expect(size.texel).toBeCloseTo(52 / 1024, 12);
    expect(size.halfExtent / size.texel).toBeCloseTo(size.mapSize / 2, 9);
    // Covers the followed square wherever the camera is within half a step of the static centre.
    expect(size.halfExtent).toBeGreaterThanOrEqual(26 + (26 * STATIC_SHADOW_STEP) / 2 + size.texel);
  });

  it('is drawn again only when a static caster enters, leaves, moves or switches its level within its reach', () => {
    const scene = new THREE.Scene();
    const graph = new RenderGraph(scene, (id) => id === 'dancer');
    const revision = new StaticShadowRevision();
    const report = (where: THREE.Object3D | null): void => (where === null ? revision.bump() : revision.touched(where));
    graph.onStaticChange(report);
    const batcher = createAutoBatcher(scene, { park: (o, on) => graph.park(o, on), staticChanged: report });
    graph.setMembership(batcher);
    const camera = new THREE.PerspectiveCamera();
    camera.position.set(0, 0, 10);
    /** The map's reach: a box round the props (or, `far`, somewhere else). */
    let reach = new THREE.Box3(new THREE.Vector3(-10, -10, -10), new THREE.Vector3(10, 10, 10));
    const frame = (): number => {
      const before = revision.value;
      graph.update();
      graph.updateLods(camera);
      batcher.update(camera);
      const within = revision.drain((s) => reach.intersectsSphere(s));
      return revision.value - before + (within ? 1 : 0);
    };
    const mat = new THREE.MeshBasicMaterial();
    for (let i = 0; i < 3; i += 1) {
      // Distinct static models sharing a material (one merged cell), two levels each.
      graph.addEntity(`prop${i}`, null);
      graph.world.setLocal(`prop${i}`, [i * 2, 0, 0], [0, 0, 0, 1], [1, 1, 1]);
      const lod = new THREE.LOD();
      const a = new THREE.Mesh(new THREE.BoxGeometry(1, 1 + i * 0.1, 1), mat);
      const f = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.9 + i * 0.1, 0.9), mat);
      for (const m of [a, f]) {
        m.userData[BATCH_KEY] = true;
        m.userData[STATIC_KEY] = 'scene-main';
      }
      lod.addLevel(a, 0);
      lod.addLevel(f, 30);
      graph.nodeFor(`prop${i}`)!.add(lod);
    }
    graph.addEntity('walker', null);
    graph.nodeFor('walker')!.add(box());
    graph.addEntity('dancer', null);
    const posed = box();
    graph.nodeFor('dancer')!.add(posed);
    expect(frame()).toBeGreaterThan(0);
    const cell = scene.children.find((o) => o.name.startsWith('tl-merged:'))!;
    expect(isStaticCaster(cell)).toBe(true);
    // A part of an animated hierarchy is posed every frame: never cached.
    expect(isStaticCaster(posed)).toBe(false);
    // Idle, and a moving object that is not static: nothing to draw again.
    expect(frame()).toBe(0);
    graph.world.setLocal('walker', [5, 0, 0], [0, 0, 0, 1], [1, 1, 1]);
    graph.poseAnimated();
    expect(frame()).toBe(0);
    // A static one moved (an edit, or its moving parent), hidden, or switching its level.
    graph.world.setLocal('prop2', [4, 0, 1], [0, 0, 0, 1], [1, 1, 1]);
    expect(frame()).toBeGreaterThan(0);
    graph.setHidden(new Set(['prop1']));
    expect(frame()).toBeGreaterThan(0);
    expect(frame()).toBe(0);
    camera.position.set(0, 0, 200);
    expect(frame()).toBeGreaterThan(0);
    // Levels switching beyond the map's reach leave it as it is.
    reach = new THREE.Box3(new THREE.Vector3(100, -10, -10), new THREE.Vector3(120, 10, 10));
    camera.position.set(0, 0, 10);
    expect(frame()).toBe(0);
    graph.removeEntity('prop0');
    expect(frame()).toBe(0);
  });

  it('changes held back (a restyle arriving over several frames) draw the map nothing until the last hold goes, then once', () => {
    const revision = new StaticShadowRevision();
    const all = (): boolean => true;
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
    mesh.updateMatrixWorld(true);
    revision.hold(true);
    revision.hold(true);
    expect(revision.holding).toBe(true);
    for (let frame = 0; frame < 3; frame += 1) {
      revision.touched(mesh);
      expect(revision.drain(all)).toBe(false);
    }
    revision.hold(false);
    expect(revision.drain(all)).toBe(false);
    revision.hold(false);
    expect(revision.holding).toBe(false);
    // Every change made while held, drained at once: one redraw, then nothing.
    expect(revision.drain(all)).toBe(true);
    expect(revision.drain(all)).toBe(false);
    // Without a cached map (no reach) the held changes are forgotten as usual.
    revision.hold(true);
    revision.touched(mesh);
    expect(revision.drain(null)).toBe(false);
    revision.hold(false);
    expect(revision.drain(all)).toBe(false);
  });

  it('marks an instanced batch a static caster only while every member is static', () => {
    const scene = new THREE.Scene();
    const revision = new StaticShadowRevision();
    const batcher = createAutoBatcher(scene, { merging: 'off', staticChanged: (where) => (where === null ? revision.bump() : revision.touched(where)) });
    const geo = new THREE.BoxGeometry();
    const mat = new THREE.MeshBasicMaterial();
    const members: THREE.Mesh[] = [];
    for (let i = 0; i < 4; i += 1) {
      const m = new THREE.Mesh(geo, mat);
      m.position.set(i, 0, 0);
      m.userData[BATCH_KEY] = true;
      m.userData[STATIC_KEY] = 'scene-main';
      scene.add(m);
      batcher.listed(m);
      members.push(m);
    }
    const camera = new THREE.PerspectiveCamera();
    batcher.update(camera);
    expect(isStaticCaster(scene.children.find((o) => o.userData['tlBatch'] === true)!)).toBe(true);
    // One member that moves (not static) makes the whole batch a dynamic caster.
    const mover = new THREE.Mesh(geo, mat);
    mover.userData[BATCH_KEY] = true;
    scene.add(mover);
    batcher.listed(mover);
    batcher.update(camera);
    expect(isStaticCaster(scene.children.find((o) => o.userData['tlBatch'] === true)!)).toBe(false);
    // It leaves: the static members' shadows go back to the static map, which is drawn again.
    const before = revision.value;
    batcher.unlisted(mover);
    batcher.update(camera);
    expect(isStaticCaster(scene.children.find((o) => o.userData['tlBatch'] === true)!)).toBe(true);
    expect(revision.value).toBeGreaterThan(before);
  });
});

describe('RenderGraph: LOD levels picked again only on a change', () => {
  it('keeps every level while the camera is still, and switches one whose object moved', () => {
    const scene = new THREE.Scene();
    const graph = new RenderGraph(scene, () => false);
    graph.addEntity('tree', null);
    const lod = new THREE.LOD();
    const near0 = box();
    const far1 = box();
    lod.addLevel(near0, 0);
    lod.addLevel(far1, 20);
    graph.nodeFor('tree')!.add(lod);
    graph.update();
    const camera = new THREE.PerspectiveCamera();
    graph.updateLods(camera);
    expect(scene.children).toEqual([near0]);
    graph.updateLods(camera);
    expect(scene.children).toEqual([near0]);
    // The camera stays; the tree is carried away.
    graph.world.setLocal('tree', [0, 0, -50], [0, 0, 0, 1], [1, 1, 1]);
    graph.update();
    graph.updateLods(camera);
    expect(scene.children).toEqual([far1]);
  });
});

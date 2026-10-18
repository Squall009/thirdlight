/**
 * Occlusion culling's groundwork on a small scene: the registry follows the
 * scene's drawables and tells their kinds, bounds and facts; the culler picks
 * its path from the setting, the renderer and a pin, shows what it hid when
 * the path changes, and reports itself on the canvas and the scene's switch.
 */
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';

import { occludeeClassOf, type OcclusionCulling } from '@thirdlight/runtime';

import { markOccludee, occludeeFactsOf, occludeeKindOf, OccludeeRegistry, occludeeWorldBounds } from './occludees';
import { OCCLUSION_SWITCH_KEY, OcclusionCuller, occlusionFromUrl, occlusionPyramidFromUrl, type OcclusionSwitch } from './occlusion';
import { createQualityControl } from './quality-control';
import { createRenderControl } from './render-control';
import { LodTuning } from './lod-switch';
import { HIDDEN_BY_OCCLUSION, HIDDEN_BY_ROOM, hiddenFromView, hideFromView } from './view-hidden';

const box = (size = 1, transparent = false): THREE.Mesh => new THREE.Mesh(new THREE.BoxGeometry(size, size, size), new THREE.MeshBasicMaterial({ transparent }));

describe('occludees', () => {
  it('tells a draw\'s kind: marked by its owner, transparent, instanced, alone; lights, lines and what three never culls are not occludees', () => {
    const single = box();
    const glass = box(1, true);
    const copies = new THREE.InstancedMesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial(), 4);
    const chunk = box();
    markOccludee(chunk, 'blocks');
    const terrain = box();
    terrain.frustumCulled = false;
    markOccludee(terrain, 'terrain');
    const sky = box();
    sky.frustumCulled = false;
    expect([single, glass, copies, chunk, terrain, sky].map(occludeeKindOf)).toEqual(['single', 'transparent', 'instanced', 'blocks', 'terrain', null]);
    expect(occludeeKindOf(new THREE.PointLight())).toBeNull();
    expect(occludeeKindOf(new THREE.Line(new THREE.BufferGeometry()))).toBeNull();
  });

  it('follows the scene\'s drawables: new ones in, gone ones out, a new material classified again', () => {
    const r = new OccludeeRegistry();
    const a = box();
    const b = box();
    const light = new THREE.DirectionalLight();
    const children: THREE.Object3D[] = [a, light, b];
    expect(r.sync(children)).toBe(true);
    expect(r.size).toBe(2);
    expect(r.sync(children)).toBe(false);
    // b leaves while a light comes: b is dropped.
    children.splice(2, 1, new THREE.PointLight());
    expect(r.sync(children)).toBe(true);
    expect([...r.values()].map((o) => o.object)).toEqual([a]);
    a.material = new THREE.MeshBasicMaterial({ transparent: true });
    expect(r.sync(children)).toBe(true);
    expect(r.get(a)?.kind).toBe('transparent');
    expect(r.counts()).toMatchObject({ transparent: 1, single: 0 });
  });

  it('bounds in the world and the facts the runtime decides on (an instanced draw: the box over every copy)', () => {
    const m = box(2);
    m.position.set(10, 0, 0);
    m.updateMatrixWorld();
    const r = new OccludeeRegistry();
    r.sync([m]);
    const o = r.get(m)!;
    const world = occludeeWorldBounds(o, new THREE.Box3());
    expect(world.min.toArray()).toEqual([9, -1, -1]);
    expect(world.max.toArray()).toEqual([11, 1, 1]);
    const facts = occludeeFactsOf(o, new THREE.Vector3(10, 0, 20), Math.tan(Math.PI / 6));
    expect(facts).toMatchObject({ kind: 'single', triangles: 12, items: 1 });
    expect(facts.screenShare).toBeCloseTo(Math.sqrt(3) / (20 * Math.tan(Math.PI / 6)));
    // Twelve triangles are not worth a test of their own.
    expect(occludeeClassOf(facts)).toBe('never');

    const copies = new THREE.InstancedMesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial(), 3);
    for (let i = 0; i < 3; i += 1) copies.setMatrixAt(i, new THREE.Matrix4().makeTranslation(i * 10, 0, 0));
    copies.updateMatrixWorld();
    r.sync([copies]);
    const c = r.get(copies)!;
    expect(occludeeWorldBounds(c, new THREE.Box3()).max.x).toBe(20.5);
    const cf = occludeeFactsOf(c, new THREE.Vector3(10, 0, 50), 0.5);
    expect(cf).toMatchObject({ kind: 'instanced', triangles: 12, items: 3 });
  });
});

function culler(setting: { value: OcclusionCulling }, renderer: { value: 'webgpu' | 'webgl2' | null }, pinned: 'off' | 'queries' | 'hiz' | null = null) {
  const scene = new THREE.Scene();
  const marks: string[] = [];
  let changes = 0;
  const c = new OcclusionCuller({ scene, setting: () => setting.value, renderer: () => renderer.value, pinned, canvas: { setAttribute: (k, v) => void (k === 'data-tl-occlusion' && marks.push(v)) }, changed: () => void (changes += 1) });
  return { scene, c, marks, changes: () => changes };
}

describe('occlusion culler', () => {
  it('culls on the setting\'s path for the renderer; the page flag pins one; off keeps no occludees', () => {
    const setting = { value: 'auto' as OcclusionCulling };
    const renderer = { value: null as 'webgpu' | 'webgl2' | null };
    const h = culler(setting, renderer);
    h.scene.add(box(), box(), new THREE.AmbientLight());
    h.c.update();
    expect(h.c.diagnostics()).toMatchObject({ setting: 'auto', path: 'off', occludees: 0 });
    renderer.value = 'webgpu';
    h.c.update();
    expect(h.c.diagnostics()).toMatchObject({ path: 'hiz', source: 'setting', occludees: 2, tested: 0, culled: 0, pass1Culled: 0, pass2Drawn: 0, gpuMs: null });
    expect(h.marks[h.marks.length - 1]).toBe('hiz|2|0|0|0');
    // WebGL 2's queries answer frames late: auto culls nothing there, the queries are a pin.
    renderer.value = 'webgl2';
    h.c.update();
    expect(h.c.path()).toBe('off');
    setting.value = 'off';
    h.c.update();
    expect(h.c.diagnostics()).toMatchObject({ setting: 'off', path: 'off', occludees: 0 });
    expect(h.marks[h.marks.length - 1]).toBe('off|0|0|0|0');
    expect(occlusionFromUrl('?occlusion=hiz&x=1')).toBe('hiz');
    expect(occlusionFromUrl('?occlusion=on')).toBeNull();
    // The pyramid's debug view pins the path that builds it.
    expect(occlusionFromUrl('?occlusion=pyramid')).toBe('hiz');
    expect(occlusionFromUrl('?occlusion=pyramid:4')).toBe('hiz');
    expect([occlusionPyramidFromUrl('?occlusion=pyramid'), occlusionPyramidFromUrl('?occlusion=pyramid:4'), occlusionPyramidFromUrl('?occlusion=hiz'), occlusionPyramidFromUrl('?occlusion=pyramid:x')]).toEqual([0, 4, null, null]);
    const pinned = culler({ value: 'auto' }, { value: 'webgpu' }, 'off');
    expect(pinned.c.diagnostics()).toMatchObject({ path: 'off', source: 'page', pinned: 'off' });
  });

  it('the scene\'s switch: tools read the path and pin one; what the old path hid is shown at once, other reasons stay', () => {
    const h = culler({ value: 'auto' }, { value: 'webgpu' });
    const a = box();
    const b = box();
    h.scene.add(a, b);
    h.c.update();
    const sw = h.scene.userData[OCCLUSION_SWITCH_KEY] as OcclusionSwitch;
    expect(sw.path()).toBe('hiz');
    // What a path hid (here by hand, as a path would): back in view when the path changes.
    hideFromView(a, HIDDEN_BY_OCCLUSION, true);
    hideFromView(b, HIDDEN_BY_OCCLUSION, true);
    hideFromView(b, HIDDEN_BY_ROOM, true);
    const before = h.changes();
    sw.pin('off');
    expect(sw.path()).toBe('off');
    expect(hiddenFromView(a, HIDDEN_BY_OCCLUSION)).toBe(false);
    expect(a.layers.isEnabled(0)).toBe(true);
    expect(hiddenFromView(b, HIDDEN_BY_ROOM)).toBe(true);
    expect(b.layers.isEnabled(0)).toBe(false);
    expect(h.changes()).toBeGreaterThan(before);
    // Pinned off, a frame hides nothing again (an oracle's own hiding stands).
    hideFromView(a, HIDDEN_BY_OCCLUSION, true);
    h.c.update();
    expect(hiddenFromView(a, HIDDEN_BY_OCCLUSION)).toBe(true);
    sw.pin(null);
    expect(sw.path()).toBe('hiz');
    expect(hiddenFromView(a, HIDDEN_BY_OCCLUSION)).toBe(false);
    h.c.dispose();
    expect(h.scene.userData[OCCLUSION_SWITCH_KEY]).toBeUndefined();
  });

  it('a quality level turns it off over the project\'s setting, and the level above takes the project\'s again', () => {
    const renderControl = createRenderControl({ occlusionCulling: 'auto' });
    const q = createQualityControl(
      { renderControl, lodTuning: new LodTuning(), setLightLimits: () => false, reselectLights: () => undefined, setPixelRatioCap: () => undefined, environment: () => null, changed: () => undefined },
      { project: { quality: 'low', qualityLevels: [{ id: 'low', occlusionCulling: 'off' }, { id: 'high' }] } },
    );
    const h = culler({ get value() { return renderControl.occlusionCulling(); } } as { value: OcclusionCulling }, { value: 'webgpu' });
    expect(renderControl.diagnostics().occlusionCulling).toBe('off');
    expect(h.c.path()).toBe('off');
    q.choose('high');
    expect(renderControl.occlusionCulling()).toBe('auto');
    expect(h.c.path()).toBe('hiz');
    renderControl.set({ occlusionCulling: 'off' }, 'project');
    expect(h.c.path()).toBe('off');
  });
});

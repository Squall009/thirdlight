/**
 * See-through: the mask's maths on the CPU reference (the shader's steps in
 * the same order), a view's subjects (slots, the nearest kept, easing, a
 * subject never fading itself, the opt-out, other cameras), and the WGSL
 * three builds: an unarmed renderer keeps every program it had (digests
 * recorded before see-through existed), an armed one carries the mask in
 * every material kind and none in the shadow pass or colourless draws, and
 * changing subjects or settings builds nothing. The correctness cases run a
 * view's own packs and per-draw bits through the reference (two subjects, a
 * subject in front of another), and a subject drawn in a batch or merged
 * cell leaves it while it is one.
 */
import * as THREE from 'three';
import { MeshStandardNodeMaterial, NodeMaterial } from 'three/webgpu';
import * as TSL from 'three/tsl';
import { describe, expect, it } from 'vitest';
import { SEE_THROUGH_DEFAULTS, SEE_THROUGH_SUBJECTS, type SeeThroughSettings } from '@thirdlight/runtime';

import { createAttributeInstancedMesh } from './attribute-instancing';
import { batchKey, batchKeyParts, batchRefusal, BATCH_KEY, createAutoBatcher } from './batching';
import { digestOf } from './material-graph';
import { STATIC_KEY } from './static-merge';
import { applyObjectSeeThrough, circleRect, emptyPack, mayFade, objectSeeThrough, packSubject, SEE_THROUGH_KEY, seeThroughEntitiesOf, seeThroughFadeAt, seeThroughOfComponents, SeeThroughView, subjectExtent, type SeeThroughEntities, type SeeThroughScripted, type SubjectExtent, type SubjectPack } from './see-through';
import { RenderGraph } from './render-graph';
import { graphDef, libraryScene, litScene, PLAIN_GRAPH_WGSL, PLAIN_GRAPHS, refreshesEveryFrame, SHADER_TYPE_MATERIALS, SHADER_TYPE_WGSL, wgslOf, wgslRenderer } from './test-wgsl';

const ON: SeeThroughSettings = { ...SEE_THROUGH_DEFAULTS, enabled: true };

/** Subjects that are plain three objects (one per id, no entity hierarchy): what the maths cases need. */
function plain(objects: Readonly<Record<string, THREE.Object3D | undefined>>): SeeThroughEntities {
  return {
    matrix: (id, out) => {
      const o = objects[id];
      if (o === undefined) return false;
      out.copy(o.matrixWorld);
      return true;
    },
    drawn: (id) => (objects[id] === undefined ? [] : [objects[id]!]),
  };
}

function perspective(eye: readonly number[], at: readonly number[]): THREE.PerspectiveCamera {
  const c = new THREE.PerspectiveCamera(50, 16 / 9, 0.1, 500);
  c.position.set(eye[0]!, eye[1]!, eye[2]!);
  c.lookAt(at[0]!, at[1]!, at[2]!);
  c.updateMatrixWorld(true);
  return c;
}

/** A subject standing at `feet` (x, y, z), `height` tall. */
function standing(feet: readonly number[], height: number): SubjectExtent {
  return { centre: new THREE.Vector3(feet[0]!, feet[1]! + height / 2, feet[2]!), feet: feet[1]!, height };
}

/** The fade at a world point (its view position through `camera`). */
function fadeAtWorld(camera: THREE.Camera, packs: readonly SubjectPack[], count: number, bits: number, p: readonly number[]): number {
  const v = new THREE.Vector3(p[0]!, p[1]!, p[2]!).applyMatrix4(camera.matrixWorldInverse);
  return seeThroughFadeAt([v.x, v.y, v.z], packs, count, bits);
}

/** A point on the ray from the camera through `q`, `t` of the way (t < 1 in front of `q`, t > 1 behind). */
function onRay(camera: THREE.Camera, q: readonly number[], t: number): number[] {
  const e = camera.getWorldPosition(new THREE.Vector3());
  return [e.x + (q[0]! - e.x) * t, e.y + (q[1]! - e.y) * t, e.z + (q[2]! - e.z) * t];
}

describe('the see-through mask (CPU reference)', () => {
  const camera = perspective([0, 3, 8], [0, 0.9, 0]);
  const subject = standing([0, 0, 0], 1.8);
  const pack = emptyPack();
  packSubject(camera, subject, ON, ON.maxFade, pack);
  const at = (p: readonly number[], bits = 1): number => fadeAtWorld(camera, [pack], 1, bits, p);
  // A point over the subject's chest on its depth plane (inside the circle's solid middle).
  const chest = [0.3, 1.2, 0];

  it('fades what is between the camera and the subject, inside the circle, to the max fade', () => {
    expect(at(onRay(camera, chest, 0.5))).toBeCloseTo(ON.maxFade, 6);
    expect(at(onRay(camera, [0, 0.9, 0], 0.3))).toBeCloseTo(ON.maxFade, 6);
  });

  it('never fades what is behind the subject, or within the depth margin in front of it', () => {
    expect(at(onRay(camera, chest, 1.1))).toBe(0);
    // Just in front of the subject's middle, closer than the margin.
    const near = onRay(camera, [0, 0.9, 0], 1 - (ON.depthMargin * 0.5) / camera.position.distanceTo(subject.centre));
    expect(at(near)).toBe(0);
  });

  it('never fades anything lower than half the subject height above its feet: the floor round it stays', () => {
    // The floor between the camera and the subject, in the circle on screen.
    expect(at([0, 0, 1])).toBe(0);
    expect(at([0, subject.feet + subject.height / 2 - 0.01, 2])).toBe(0);
    expect(at([0, subject.feet + subject.height / 2 + 0.01, 2])).toBeGreaterThan(0);
  });

  it('fades only inside a soft circle round the subject', () => {
    expect(at([6, 2.5, 4])).toBe(0);
    // Across the soft edge the fade falls off between the radii.
    const r = pack.shape;
    expect(r.x).toBeLessThan(r.y);
    const mid = (r.x + r.y) / 2;
    // A pixel at half the subject's depth whose view ray meets the subject's depth plane `off` from the centre.
    const p = (off: number): number => seeThroughFadeAt([(pack.centre.x + off) * 0.5, pack.centre.y * 0.5, pack.centre.z * 0.5], [pack], 1, 1);
    expect(p(r.x * 0.9)).toBeCloseTo(ON.maxFade, 6);
    expect(p(mid)).toBeGreaterThan(0);
    expect(p(mid)).toBeLessThan(ON.maxFade);
    expect(p(r.y * 1.01)).toBe(0);
  });

  it('keeps the circle over the body at any zoom (never smaller than the subject)', () => {
    const far = perspective([0, 3, 80], [0, 0.9, 0]);
    const close = perspective([0, 1.2, 2], [0, 0.9, 0]);
    const a = emptyPack();
    const b = emptyPack();
    packSubject(far, subject, ON, 1, a);
    packSubject(close, subject, ON, 1, b);
    expect(b.shape.y).toBeGreaterThanOrEqual(0.75 * subject.height - 1e-9);
    // Far away the circle is the radius share of the view height there.
    expect(a.shape.y).toBeCloseTo(ON.radius * 2 * -a.centre.z * Math.tan(THREE.MathUtils.degToRad(25)), 6);
  });

  it('fades nothing for an object without the subject bit, and fades as the largest over the subjects', () => {
    expect(at(onRay(camera, chest, 0.5), 0)).toBe(0);
    const other = emptyPack();
    packSubject(camera, standing([3, 0, -2], 1.8), ON, 0.4, other);
    const p = onRay(camera, chest, 0.5);
    expect(fadeAtWorld(camera, [pack, other], 2, 0b11, p)).toBeCloseTo(ON.maxFade, 6);
    expect(fadeAtWorld(camera, [pack, other], 2, 0b10, p)).toBe(0);
    expect(fadeAtWorld(camera, [other, pack], 2, 0b11, p)).toBeCloseTo(ON.maxFade, 6);
  });

  it('on stairs between storeys fades the slab above, never the one under the feet', () => {
    const cam = perspective([0, 9, 9], [0, 2.4, 0]);
    // A character half way up the stairs: feet 1.5 m up, the upper storey's slab at 3 m.
    const climbing = standing([0, 1.5, 0], 1.8);
    const p = emptyPack();
    packSubject(cam, climbing, ON, ON.maxFade, p);
    const c = [0, 2.4, 0];
    const t = (y: number): number => (9 - y) / (9 - 2.4);
    // The upper slab where the view ray to the subject crosses it.
    expect(fadeAtWorld(cam, [p], 1, 1, onRay(cam, c, t(3)))).toBeCloseTo(ON.maxFade, 6);
    // The floor the stairs start from (in front of the subject, under its feet).
    expect(fadeAtWorld(cam, [p], 1, 1, [0, 0, 1.5])).toBe(0);
    // Walking up past the slab: it is now under the feet and stays.
    const up = emptyPack();
    packSubject(cam, standing([0, 3, 0], 1.8), ON, ON.maxFade, up);
    expect(fadeAtWorld(cam, [up], 1, 1, [0, 3, 1])).toBe(0);
    expect(fadeAtWorld(cam, [up], 1, 1, onRay(cam, [0, 3.9, 0], (9 - 3) / (9 - 3.9)))).toBe(0);
    // ... and the next storey's slab (6 m) is the one that fades now.
    const next = (y: number): number[] => onRay(cam, [0, 3.9, 0], (9 - y) / (9 - 3.9));
    expect(fadeAtWorld(cam, [up], 1, 1, next(6))).toBeCloseTo(ON.maxFade, 6);
    expect(fadeAtWorld(cam, [p], 1, 1, onRay(cam, c, t(6)))).toBeCloseTo(ON.maxFade, 6);
  });

  it('works for an orthographic camera (a side view): the near prop by the floor stays solid', () => {
    const o = new THREE.OrthographicCamera(-8, 8, 4.5, -4.5, 0.1, 100);
    o.position.set(0, 1, 20);
    o.lookAt(0, 1, 0);
    o.updateMatrixWorld(true);
    const p = emptyPack();
    packSubject(o, subject, ON, ON.maxFade, p);
    expect(p.centre.w).toBe(0);
    // A pillar between the camera and the subject, at chest height and at knee height.
    expect(fadeAtWorld(o, [p], 1, 1, [0, 1.3, 5])).toBeCloseTo(ON.maxFade, 6);
    expect(fadeAtWorld(o, [p], 1, 1, [0, 0.4, 5])).toBe(0);
    expect(fadeAtWorld(o, [p], 1, 1, [0, 1.3, -5])).toBe(0);
  });

  it('has no circle for a subject behind a perspective camera', () => {
    const p = emptyPack();
    packSubject(perspective([0, 1, -5], [0, 1, -10]), subject, ON, 0.75, p);
    expect(p.shape.w).toBe(0);
  });
});

describe('a subject\'s extent', () => {
  it('is a character\'s controller capsule, else its meshes\' bounds, else its origin', () => {
    const o = new THREE.Object3D();
    o.position.set(2, 5, 1);
    o.updateMatrixWorld(true);
    const out: SubjectExtent = { centre: new THREE.Vector3(), feet: 0, height: 0 };
    subjectExtent(o.matrixWorld, [o], { controller: { capsule: { radius: 0.3, height: 1.6, offset: [0, 0.8, 0.5] } } }, out);
    expect([out.feet, out.height, out.centre.y, out.centre.z]).toEqual([5, 1.6, 5.8, 1.5]);
    subjectExtent(o.matrixWorld, [o], {}, out);
    expect([out.feet, out.height]).toEqual([5, 0]);
    const box = new THREE.Mesh(new THREE.BoxGeometry(1, 2, 1));
    box.position.y = 1;
    o.add(box);
    // A line (a helper) and a hidden mesh do not size it.
    const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, -3, 0), new THREE.Vector3(0, 9, 0)]));
    const hidden = new THREE.Mesh(new THREE.BoxGeometry(1, 9, 1));
    hidden.visible = false;
    o.add(line, hidden);
    o.updateMatrixWorld(true);
    subjectExtent(o.matrixWorld, [o], {}, out);
    expect([out.feet, out.height]).toEqual([5, 2]);
  });
});

/** A view over a scene of named objects, its camera target `target`. */
function viewOf(objects: Record<string, THREE.Object3D>, target: string | null, settings: Partial<SeeThroughSettings> = ON) {
  const problems: string[] = [];
  let precompiles = 0;
  const view = new SeeThroughView({ ...plain(objects), components: () => ({}), cameraTarget: () => target, requestPrecompile: () => precompiles++, onProblem: (code) => problems.push(code) }, settings);
  return { view, problems, precompiles: () => precompiles };
}

function body(x: number, z: number): THREE.Object3D {
  const g = new THREE.Group();
  const m = new THREE.Mesh(new THREE.BoxGeometry(0.6, 1.8, 0.6));
  m.position.y = 0.9;
  g.add(m);
  g.position.set(x, 0, z);
  g.updateMatrixWorld(true);
  return g;
}

describe('which draws a subject may fade', () => {
  it('never rules out a sphere any of whose points the mask fades (perspective and side views, random spheres)', () => {
    let seed = 7;
    const rnd = (): number => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const ortho = new THREE.OrthographicCamera(-8, 8, 4.5, -4.5, 0.1, 100);
    ortho.position.set(0, 1, 20);
    ortho.updateMatrixWorld(true);
    let ruledOut = 0;
    for (const camera of [perspective([0, 3, 8], [0, 0.9, 0]), perspective([6, 9, 6], [0, 0, 0]), ortho]) {
      const pack = emptyPack();
      packSubject(camera, standing([0, 0, 0], 1.8), ON, ON.maxFade, pack);
      for (let n = 0; n < 400; n++) {
        const centre = new THREE.Vector3((rnd() - 0.5) * 12, rnd() * 6 - 1, (rnd() - 0.5) * 12);
        const r = 0.2 + rnd() * 3;
        const v = centre.clone().applyMatrix4(camera.matrixWorldInverse);
        const may = mayFade(v, r, pack);
        if (!may) ruledOut += 1;
        // Points through the sphere: any that fades proves the sphere may.
        for (let k = 0; k < 300 && !may; k++) {
          const d = new THREE.Vector3(rnd() - 0.5, rnd() - 0.5, rnd() - 0.5).normalize().multiplyScalar(r * Math.cbrt(rnd()));
          expect(fadeAtWorld(camera, [pack], 1, 1, centre.clone().add(d).toArray())).toBe(0);
        }
      }
    }
    // The test rules out a good share (it saves the mask's work there), not nothing.
    expect(ruledOut).toBeGreaterThan(300);
  });

  it('the box a pixel is tested against first holds every pixel that fades (two subjects, perspective and side views)', () => {
    let seed = 11;
    const rnd = (): number => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const ortho = new THREE.OrthographicCamera(-8, 8, 4.5, -4.5, 0.1, 100);
    ortho.position.set(0, 1, 20);
    ortho.updateMatrixWorld(true);
    for (const camera of [perspective([0, 3, 8], [0, 0.9, 0]), ortho]) {
      const packs = [emptyPack(), emptyPack()];
      packSubject(camera, standing([0, 0, 0], 1.8), ON, ON.maxFade, packs[0]!);
      packSubject(camera, standing([3, 0, -2], 1.8), ON, 0.4, packs[1]!);
      const rect = new THREE.Vector4();
      const persp = circleRect(packs, 2, rect);
      expect(persp).toBe(camera === ortho ? false : true);
      let faded = 0;
      for (let n = 0; n < 20000; n++) {
        const v = new THREE.Vector3((rnd() - 0.5) * 12, rnd() * 5, (rnd() - 0.5) * 12).applyMatrix4(camera.matrixWorldInverse);
        if (seeThroughFadeAt([v.x, v.y, v.z], packs, 2, 0b11) <= 0) continue;
        faded += 1;
        const k = persp ? 1 / Math.max(-v.z, 1e-4) : 1;
        const [x, y] = [v.x * k, v.y * k];
        expect(x >= rect.x && x <= rect.z && y >= rect.y && y <= rect.w).toBe(true);
      }
      expect(faded).toBeGreaterThan(100);
    }
    // Nothing fading: an empty box.
    const none = new THREE.Vector4();
    const faded = emptyPack();
    faded.shape.w = 0;
    circleRect([faded], 1, none);
    expect(none.x).toBeGreaterThan(none.z);
  });

  it('a script turning see-through on in a page that built no mask ahead says so once; a prebuilt page does not', () => {
    const camera = perspective([0, 6, 10], [0, 1, 0]);
    for (const prebuild of [false, true]) {
      const problems: string[] = [];
      let scripted: SeeThroughScripted | null = null;
      const view = new SeeThroughView({ ...plain({ a: body(0, 0) }), components: () => ({}), cameraTarget: () => 'a', scripted: () => scripted, prebuild, onProblem: (code) => problems.push(code) });
      const r = { contextNode: { value: {}, needsUpdate: false } };
      view.update(r, camera, 0);
      scripted = { settings: { ...ON }, subjects: null };
      view.update(r, camera, 16);
      view.update(r, camera, 32);
      expect(view.diagnostics().armed).toBe(true);
      expect(problems).toEqual(prebuild ? [] : ['see_through_rebuild']);
    }
  });

  it('a draw far from every circle takes no subject; a wall in front of one takes it', () => {
    const objects: Record<string, THREE.Object3D> = { a: body(0, 0) };
    const camera = perspective([0, 6, 10], [0, 1, 0]);
    const view = new SeeThroughView({ ...plain(objects), components: () => ({}), cameraTarget: () => 'a' }, { ...ON, fadeTime: 0 });
    view.update({ contextNode: { value: {}, needsUpdate: false } }, camera, 0);
    const wall = new THREE.Mesh(new THREE.BoxGeometry(3, 3, 0.2));
    wall.position.set(0, 1.5, 4);
    const far = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
    far.position.set(14, 0.5, -6);
    const behind = new THREE.Mesh(new THREE.BoxGeometry(3, 3, 0.2));
    behind.position.set(0, 1.5, -4);
    for (const m of [wall, far, behind]) m.updateMatrixWorld(true);
    expect(view.bitsFor(wall, camera)).toBe(1);
    expect(view.bitsFor(far, camera)).toBe(0);
    expect(view.bitsFor(behind, camera)).toBe(0);
    // Without the camera (or for another one) the bits stay whole: nothing narrowed on a guess.
    expect(view.bitsFor(far)).toBe(1);
    expect(view.bitsFor(far, perspective([0, 1, 1], [0, 0, 0]))).toBe(1);
    // Instanced draws keep theirs (their geometry's bounds are one copy's).
    const inst = new THREE.InstancedMesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial(), 2);
    inst.position.copy(far.position);
    inst.updateMatrixWorld(true);
    expect(view.bitsFor(inst, camera)).toBe(1);
  });
});

describe('a view\'s subjects', () => {
  const camera = perspective([0, 6, 10], [0, 1, 0]);
  const renderer = (): { contextNode: { value: Record<string, unknown>; needsUpdate: boolean; version: number } } => {
    const n = { value: {} as Record<string, unknown>, version: 0, set needsUpdate(v: boolean) { if (v) n.version++; }, get needsUpdate() { return false; } };
    return { contextNode: n };
  };

  it('off and never on: arms nothing and does nothing', () => {
    const r = renderer();
    const { view } = viewOf({ p: body(0, 0) }, 'p', { enabled: false });
    view.update(r, camera, 0);
    expect(r.contextNode.version).toBe(0);
    expect(Object.keys(r.contextNode.value)).toEqual([]);
    expect(view.diagnostics()).toEqual({ enabled: false, armed: false, subjects: [], leftOut: 0 });
  });

  it('on: arms the renderer once (programs built ahead), follows the camera target and eases its fade in and out', () => {
    const r = renderer();
    const fadeTime = 0.1;
    const { view, precompiles } = viewOf({ p: body(0, 0) }, 'p', { ...ON, fadeTime });
    view.update(r, camera, 0);
    expect(r.contextNode.version).toBe(1);
    expect(precompiles()).toBe(1);
    // Not faded in yet: no subject drawn.
    expect(view.fill(camera)).toBe(0);
    view.update(r, camera, (fadeTime / 2) * 1000);
    expect(view.diagnostics().subjects).toEqual([{ id: 'p', slot: 0, fade: 0.5 }]);
    expect(view.fill(camera)).toBe(1);
    expect(view.packed()[0]!.shape.w).toBeCloseTo(0.5 * ON.maxFade, 6);
    view.update(r, camera, fadeTime * 1000);
    view.fill(camera);
    expect(view.packed()[0]!.shape.w).toBeCloseTo(ON.maxFade, 6);
    // Off at run time: it fades out and the renderer stays armed (turning it back on builds nothing).
    view.set({ enabled: false });
    view.update(r, camera, fadeTime * 2000);
    expect(view.diagnostics().subjects).toEqual([]);
    expect(view.fill(camera)).toBe(0);
    view.set({ enabled: true });
    view.update(r, camera, fadeTime * 3000);
    expect(r.contextNode.version).toBe(1);
    expect(precompiles()).toBe(1);
    view.dispose();
    expect(r.contextNode.value).toEqual({});
  });

  it('follows what the game\'s scripts set over the host\'s settings, back to them on a new run; a page pin stands over both', () => {
    const r = renderer();
    let scripted: SeeThroughScripted | null = null;
    const objects = { p: body(0, 0), q: body(2, 0) };
    const deps = { ...plain(objects), components: () => ({}), cameraTarget: () => 'p', scripted: () => scripted };
    const view = new SeeThroughView(deps, { enabled: false, radius: 0.3 });
    view.update(r, camera, 0);
    expect(view.diagnostics().armed).toBe(false);
    // A script turns it on round q (a new object each step, as the worker's view arrives: applied once).
    scripted = { settings: { ...SEE_THROUGH_DEFAULTS, enabled: true, radius: 0.5 }, subjects: ['q'] };
    view.update(r, camera, 1000);
    expect(view.settings()).toMatchObject({ enabled: true, radius: 0.5 });
    expect(view.subjects()).toEqual(['q']);
    expect(view.diagnostics().subjects.map((s) => s.id)).toEqual(['q']);
    scripted = { settings: { ...scripted.settings }, subjects: ['q'] };
    view.update(r, camera, 2000);
    expect(r.contextNode.version).toBe(1);
    // A host change while a script's stands: kept for when the script's goes (a new run).
    view.set({ radius: 0.1 });
    expect(view.settings().radius).toBe(0.5);
    scripted = null;
    view.update(r, camera, 3000);
    expect(view.settings()).toMatchObject({ enabled: false, radius: 0.1 });
    expect(view.subjects()).toBeNull();
    // ?seethrough=off: never on, whatever the script says.
    const pinned = new SeeThroughView({ ...deps, pinned: false }, { enabled: true });
    scripted = { settings: { ...SEE_THROUGH_DEFAULTS, enabled: true }, subjects: null };
    const r2 = renderer();
    pinned.update(r2, camera, 0);
    expect(pinned.settings().enabled).toBe(false);
    expect(r2.contextNode.version).toBe(0);
    view.dispose();
    pinned.dispose();
  });

  it('sees no subject from any other camera (a bake, a thumbnail)', () => {
    const r = renderer();
    const { view } = viewOf({ p: body(0, 0) }, 'p', { ...ON, fadeTime: 0 });
    view.update(r, camera, 0);
    expect(view.fill(camera)).toBe(1);
    expect(view.fill(perspective([5, 5, 5], [0, 0, 0]))).toBe(0);
  });

  it('keeps the nearest subjects when more are asked for than the arrays hold, and says so once', () => {
    const objects: Record<string, THREE.Object3D> = {};
    const ids: string[] = [];
    for (let i = 0; i < SEE_THROUGH_SUBJECTS + 2; i++) {
      objects[`s${i}`] = body(0, 8 - i * 3);
      ids.push(`s${i}`);
    }
    const r = renderer();
    const { view, problems } = viewOf(objects, null, { ...ON, fadeTime: 0 });
    view.set({ subjects: ids });
    view.update(r, camera, 0);
    view.update(r, camera, 16);
    expect(problems).toEqual(['see_through_subjects']);
    expect(view.diagnostics().leftOut).toBe(2);
    expect(view.diagnostics().subjects.map((s) => s.id).sort()).toEqual(ids.slice(0, SEE_THROUGH_SUBJECTS).sort());
    // Back under the size: reported again only after it overflows again.
    view.set({ subjects: ids.slice(0, 2) });
    view.update(r, camera, 32);
    expect(view.diagnostics().leftOut).toBe(0);
  });

  it('never fades a subject (or what is under it) for itself, yet for another subject it stands in front of; opted-out objects never', () => {
    const a = body(0, 0);
    const b = body(0, -4);
    const sword = new THREE.Mesh(new THREE.BoxGeometry(0.1, 1, 0.1));
    a.add(sword);
    const wall = new THREE.Mesh(new THREE.BoxGeometry(4, 3, 0.2));
    const r = renderer();
    const { view } = viewOf({ a, b }, null, { ...ON, fadeTime: 0 });
    view.set({ subjects: ['a', 'b'] });
    view.update(r, camera, 0);
    const all = 0b11;
    const slotOf = (id: string): number => view.diagnostics().subjects.find((s) => s.id === id)!.slot;
    expect(view.bitsFor(wall)).toBe(all);
    expect(view.bitsFor(a.children[0]!)).toBe(all & ~(1 << slotOf('a')));
    expect(view.bitsFor(sword)).toBe(all & ~(1 << slotOf('a')));
    expect(view.bitsFor(b.children[0]!)).toBe(all & ~(1 << slotOf('b')));
    applyObjectSeeThrough(wall, false);
    expect(objectSeeThrough(wall)).toBe(false);
    expect(view.bitsFor(wall)).toBe(0);
    // The marks are this frame's: a subject dropped next frame fades again for the others.
    view.set({ subjects: ['b'] });
    view.update(r, camera, 16);
    expect(view.bitsFor(a.children[0]!)).toBe(1 << slotOf('b'));
  });
});

describe('a view\'s fades end to end (its packs and per-draw bits through the CPU reference)', () => {
  const r = (): { contextNode: { value: Record<string, unknown>; needsUpdate: boolean } } => ({ contextNode: { value: {}, needsUpdate: false } });
  /** The fade `view` gives the pixel of drawable `o` at world point `p`. */
  const fadeOf = (view: SeeThroughView, camera: THREE.Camera, o: THREE.Object3D, p: readonly number[]): number => fadeAtWorld(camera, view.packed(), view.fill(camera), view.bitsFor(o), p);
  const wall = new THREE.Mesh(new THREE.BoxGeometry(10, 4, 0.2));

  it('two subjects in one view: what is in front of each fades round each, and nothing between their circles', () => {
    const camera = perspective([0, 5, 12], [0, 1, -2]);
    const objects = { a: body(-4, 0), b: body(4, -4) };
    const { view } = viewOf(objects, null, { ...ON, fadeTime: 0 });
    view.set({ subjects: ['a', 'b'] });
    view.update(r(), camera, 0);
    expect(fadeOf(view, camera, wall, onRay(camera, [-4, 1.2, 0], 0.5))).toBeCloseTo(ON.maxFade, 6);
    expect(fadeOf(view, camera, wall, onRay(camera, [4, 1.2, -4], 0.5))).toBeCloseTo(ON.maxFade, 6);
    expect(fadeOf(view, camera, wall, onRay(camera, [0, 1.2, -2], 0.5))).toBe(0);
    // Behind either: solid.
    expect(fadeOf(view, camera, wall, onRay(camera, [-4, 1.2, 0], 1.1))).toBe(0);
    expect(fadeOf(view, camera, wall, onRay(camera, [4, 1.2, -4], 1.1))).toBe(0);
  });

  it('a subject in front of another fades for the one behind, never for itself; the one behind stays solid', () => {
    const camera = perspective([0, 4, 12], [0, 1, -3]);
    const objects = { a: body(0, 2), b: body(0, -3) };
    const { view } = viewOf(objects, null, { ...ON, fadeTime: 0 });
    view.set({ subjects: ['a', 'b'] });
    view.update(r(), camera, 0);
    const aMesh = objects.a.children[0]!;
    const bMesh = objects.b.children[0]!;
    // A's chest covers B on screen: it thins for B.
    expect(fadeOf(view, camera, aMesh, [0, 1.2, 2])).toBeCloseTo(ON.maxFade, 6);
    expect(fadeOf(view, camera, bMesh, [0, 1.2, -3])).toBe(0);
    // A alone as the subject: A never fades.
    view.set({ subjects: ['a'] });
    view.update(r(), camera, 16);
    expect(fadeOf(view, camera, aMesh, [0, 1.2, 2])).toBe(0);
  });
});

describe('a subject drawn in a batch or a merged cell', () => {
  const r = { contextNode: { value: {} as Record<string, unknown>, needsUpdate: false } };
  const camera = perspective([0, 6, 12], [0, 1, 0]);
  const drawnAlone = (m: THREE.Object3D): boolean => m.layers.mask === 1;

  /** One frame as the adapter runs it: subjects marked, batches grouped, the view followed. */
  const frame = (view: SeeThroughView, b: ReturnType<typeof createAutoBatcher>, t: number): void => {
    view.beforeBatch(camera);
    b.update(camera);
    view.update(r, camera, t);
  };

  it('leaves its batch while it is a subject (so it never fades itself) and goes back after', () => {
    const scene = new THREE.Scene();
    const geo = new THREE.BoxGeometry(0.6, 1.8, 0.6);
    const mat = new THREE.MeshStandardMaterial();
    const boxes: Record<string, THREE.Mesh> = {};
    for (let i = 0; i < 6; i++) {
      const m = new THREE.Mesh(geo, mat);
      m.position.set(i * 2 - 5, 0.9, 0);
      m.userData[BATCH_KEY] = true;
      scene.add(m);
      boxes[`s${i}`] = m;
    }
    const b = createAutoBatcher(scene);
    for (const m of Object.values(boxes)) b.listed(m);
    const view = new SeeThroughView({ ...plain(boxes), components: () => ({}), cameraTarget: () => 's0', regroup: (o) => b.touch(o) }, { ...ON, fadeTime: 0 });
    frame(view, b, 0);
    const s0 = boxes['s0']!;
    expect(batchRefusal(s0)).toBe('see-through subject');
    expect(drawnAlone(s0)).toBe(true);
    expect(Object.values(boxes).filter(drawnAlone)).toEqual([s0]);
    expect(view.bitsFor(s0)).toBe(0);
    const batch = b.drawOf(boxes['s1']!)!;
    expect(view.bitsFor(batch)).toBe(1);
    // Off: it fades out, its slot frees, then it rejoins its batch.
    view.set({ enabled: false });
    frame(view, b, 16);
    frame(view, b, 32);
    expect(batchRefusal(s0)).toBeNull();
    expect(drawnAlone(s0)).toBe(false);
    expect(b.drawOf(s0)).toBe(batch);
    view.dispose();
    b.dispose();
  });

  it('only the subjects that hold a slot leave their batches: more named than slots keep the farthest batched', () => {
    const scene = new THREE.Scene();
    const geo = new THREE.BoxGeometry(0.6, 1.8, 0.6);
    const mat = new THREE.MeshStandardMaterial();
    const boxes: Record<string, THREE.Mesh> = {};
    const n = SEE_THROUGH_SUBJECTS + 3;
    for (let i = 0; i < n; i++) {
      const m = new THREE.Mesh(geo, mat);
      m.position.set(0, 0.9, 8 - i * 3);
      m.userData[BATCH_KEY] = true;
      m.updateMatrixWorld(true);
      scene.add(m);
      boxes[`s${i}`] = m;
    }
    const b = createAutoBatcher(scene);
    for (const m of Object.values(boxes)) b.listed(m);
    const view = new SeeThroughView({ ...plain(boxes), components: () => ({}), cameraTarget: () => null, regroup: (o) => b.touch(o) }, { ...ON, fadeTime: 0 });
    view.set({ subjects: Object.keys(boxes) });
    frame(view, b, 0);
    const alone = Object.keys(boxes).filter((id) => batchRefusal(boxes[id]!) === 'see-through subject');
    expect(alone.sort()).toEqual(Object.keys(boxes).slice(0, SEE_THROUGH_SUBJECTS).sort());
    expect(view.diagnostics().subjects.map((x) => x.id).sort()).toEqual(alone.sort());
    view.dispose();
    b.dispose();
  });

  it('leaves its merged cell while it is a subject; a mesh loaded under it later follows; dispose gives it back', () => {
    const scene = new THREE.Scene();
    const mat = new THREE.MeshLambertMaterial();
    const props: THREE.Mesh[] = [];
    for (let i = 0; i < 3; i++) {
      const m = new THREE.Mesh(new THREE.BoxGeometry(1, 1 + i * 0.1, 1), mat);
      m.position.set(i * 2, 0.5, 0);
      m.userData[BATCH_KEY] = true;
      m.userData[STATIC_KEY] = 'scene-a';
      m.updateMatrixWorld(true);
      scene.add(m);
      props.push(m);
    }
    const b = createAutoBatcher(scene);
    for (const m of props) b.listed(m);
    b.update(camera);
    expect(props.filter(drawnAlone)).toEqual([]);
    const subject = props[0]!;
    const view = new SeeThroughView({ ...plain({ p: subject }), components: () => ({}), cameraTarget: () => 'p', regroup: (o) => b.touch(o) }, { ...ON, fadeTime: 0 });
    frame(view, b, 0);
    expect(props.filter(drawnAlone)).toEqual([subject]);
    expect(view.bitsFor(subject)).toBe(0);
    const cell = b.drawOf(props[1]!)!;
    expect(cell).not.toBeNull();
    expect(view.bitsFor(cell)).toBe(1);
    // A part attached under the subject later (a model that finished loading) is marked too.
    const part = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.2, 0.2), mat);
    part.userData[BATCH_KEY] = true;
    subject.add(part);
    frame(view, b, 16);
    expect(batchRefusal(part)).toBe('see-through subject');
    view.dispose();
    expect(batchRefusal(subject)).toBeNull();
    expect(batchRefusal(part)).toBeNull();
    b.dispose();
  });
});

describe('subjects in the engine\'s entity hierarchy (the render graph)', () => {
  const r = { contextNode: { value: {} as Record<string, unknown>, needsUpdate: false } };
  const camera = perspective([0, 6, 10], [0, 1, 0]);

  /** A prefab-shaped hero (a controller root drawing nothing, its model a child entity holding a sword entity), a crate prefab root with a child model, and a wall. */
  function world() {
    const scene = new THREE.Scene();
    const graph = new RenderGraph(scene, () => false);
    const place = (id: string, parent: string | null, p: readonly number[]): void => {
      graph.addEntity(id, parent);
      graph.world.setLocal(id, p, [0, 0, 0, 1], [1, 1, 1]);
    };
    // The capsule (1.8 m, the default) is centred on the root: its feet on the floor.
    place('hero', null, [0, 0.9, 0]);
    place('hero-model', 'hero', [0, 0, 0]);
    place('sword', 'hero-model', [0.4, 0.2, 0]);
    place('crate', null, [3, 0, 0]);
    place('crate-model', 'crate', [0, 0.6, 0]);
    place('wall', null, [0, 1.5, 4]);
    const mesh = (id: string, w: number, h: number, d: number): THREE.Mesh => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), new THREE.MeshStandardMaterial());
      graph.nodeFor(id)!.add(m);
      return m;
    };
    const meshes = { model: mesh('hero-model', 0.6, 1.8, 0.6), sword: mesh('sword', 0.1, 1, 0.1), crate: mesh('crate-model', 1.2, 1.2, 1.2), wall: mesh('wall', 8, 3, 0.2) };
    graph.update();
    const components: Record<string, unknown> = { hero: { controller: {} } };
    const view = (target: string): SeeThroughView => new SeeThroughView({ ...seeThroughEntitiesOf(graph), components: (id) => components[id] ?? {}, cameraTarget: () => target }, { ...ON, fadeTime: 0 });
    return { graph, meshes, view };
  }

  it('a controller root whose model is a child entity is a subject, sized by its capsule; its model and the item its model holds never fade for it', () => {
    const { graph, meshes, view } = world();
    expect(graph.node('hero')).toBeUndefined();
    const v = view('hero');
    v.beforeBatch(camera);
    v.update(r, camera, 0);
    expect(v.diagnostics().subjects).toEqual([{ id: 'hero', slot: 0, fade: 1 }]);
    expect(v.bitsFor(meshes.model, camera)).toBe(0);
    expect(v.bitsFor(meshes.sword, camera)).toBe(0);
    expect(v.bitsFor(meshes.wall, camera)).toBe(1);
    // The wall in front of its chest fades; at its knees it stays (the capsule's half height, 0.9 m).
    const count = v.fill(camera);
    const fadeAt = (o: THREE.Object3D, p: readonly number[]): number => fadeAtWorld(camera, v.packed(), count, v.bitsFor(o, camera), p);
    expect(fadeAt(meshes.wall, onRay(camera, [0, 1.4, 0], 0.6))).toBeCloseTo(ON.maxFade, 6);
    expect(fadeAt(meshes.wall, [0, 0.5, 4])).toBe(0);
  });

  it('a prefab root without a controller (the editor preview\'s pick) is sized by what its child entities draw', () => {
    const { meshes, view } = world();
    const v = view('crate');
    v.beforeBatch(camera);
    v.update(r, camera, 0);
    expect(v.diagnostics().subjects).toEqual([{ id: 'crate', slot: 0, fade: 1 }]);
    expect(v.bitsFor(meshes.crate, camera)).toBe(0);
    // Its circle centres on the child's box (1.2 m: the half-height plane at 0.6 m).
    const count = v.fill(camera);
    expect(fadeAtWorld(camera, v.packed(), count, 1, onRay(camera, [3, 0.9, 0], 0.6))).toBeCloseTo(ON.maxFade, 6);
    // In front of it just under and just over that plane.
    expect(fadeAtWorld(camera, v.packed(), count, 1, [3, 0.55, 1])).toBe(0);
    expect(fadeAtWorld(camera, v.packed(), count, 1, [3, 0.65, 1])).toBeGreaterThan(0);
  });

  it('a child entity given to another parent leaves its old one\'s subject', () => {
    const { graph, meshes, view } = world();
    graph.addEntity('sword', 'crate');
    graph.update();
    const v = view('hero');
    v.beforeBatch(camera);
    v.update(r, camera, 0);
    expect(graph.subtreeNodes('hero').map((n) => n.entityId)).toEqual(['hero-model']);
    expect(v.bitsFor(meshes.sword)).toBe(1);
    graph.removeEntity('hero-model');
    expect(graph.subtreeNodes('hero')).toEqual([]);
  });
});

describe('the per-object opt-out', () => {
  it('is read from the entity\'s components and keeps batches apart', () => {
    expect(seeThroughOfComponents({ model: {} })).toBe(true);
    expect(seeThroughOfComponents({ model: { seeThrough: false } })).toBe(false);
    expect(seeThroughOfComponents({ blockLayer: { seeThrough: false } })).toBe(false);
    const geo = new THREE.BoxGeometry();
    const mat = new THREE.MeshStandardMaterial();
    const a = new THREE.Mesh(geo, mat);
    const b = new THREE.Mesh(geo, mat);
    a.userData[BATCH_KEY] = true;
    b.userData[BATCH_KEY] = true;
    b.userData[SEE_THROUGH_KEY] = false;
    expect(batchKey(batchKeyParts(a)!, null, 16)).not.toBe(batchKey(batchKeyParts(b)!, null, 16));
  });
});

/** A renderer armed by a view (its context holds the view; a build reads it). */
function armed(view?: SeeThroughView): { renderer: ReturnType<typeof wgslRenderer>; view: SeeThroughView } {
  const renderer = wgslRenderer();
  const v = view ?? new SeeThroughView({ ...plain({}), components: () => ({}), cameraTarget: () => null }, ON);
  v.update(renderer, new THREE.PerspectiveCamera(), 0);
  return { renderer, view: v };
}

const fragmentOf = (wgsl: string): string => wgsl.slice(wgsl.indexOf('@fragment'));

describe('the see-through programs', () => {
  it('an unarmed renderer builds every material kind as before see-through existed', async () => {
    // The step is on three's prototypes from here on (as in any page with a view that armed).
    armed();
    const defs = [...SHADER_TYPE_MATERIALS, ...Object.entries(PLAIN_GRAPHS).map(([id, g]) => graphDef(`graph-${id}`, g))];
    const { scene, meshes } = await libraryScene(defs);
    const renderer = wgslRenderer();
    const now: Record<string, string> = {};
    for (const [id, m] of Object.entries(meshes)) now[id] = digestOf(wgslOf(renderer, scene, m));
    expect(now).toEqual({ ...SHADER_TYPE_WGSL, ...Object.fromEntries(Object.entries(PLAIN_GRAPH_WGSL).map(([k, v]) => [`graph-${k}`, v])) });
  });

  it('an armed renderer builds the mask into every material kind, beside the material\'s own mask', async () => {
    const defs = [...SHADER_TYPE_MATERIALS, ...Object.entries(PLAIN_GRAPHS).map(([id, g]) => graphDef(`graph-${id}`, g))];
    const { scene, meshes } = await libraryScene(defs);
    const geo = new THREE.SphereGeometry(1, 8, 6);
    const extra: Record<string, THREE.Mesh> = {
      classicStandard: new THREE.Mesh(geo, new THREE.MeshStandardMaterial()),
      classicLambert: new THREE.Mesh(geo, new THREE.MeshLambertMaterial()),
      classicBasic: new THREE.Mesh(geo, new THREE.MeshBasicMaterial()),
    };
    // Instanced copies (the engine's batches and instance sets draw through instance columns).
    const inst = createAttributeInstancedMesh(geo, new THREE.MeshStandardMaterial(), 16);
    inst.count = 2;
    inst.markChanged();
    extra['instanced'] = inst.mesh;
    // A skinned mesh (its bones bound).
    const skinGeo = new THREE.BoxGeometry(1, 2, 1);
    const count = skinGeo.getAttribute('position').count;
    skinGeo.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(new Uint16Array(count * 4), 4));
    skinGeo.setAttribute('skinWeight', new THREE.Float32BufferAttribute(new Float32Array(count * 4).fill(0.25), 4));
    const skinned = new THREE.SkinnedMesh(skinGeo, new THREE.MeshStandardMaterial());
    const bone = new THREE.Bone();
    skinned.add(bone);
    skinned.bind(new THREE.Skeleton([bone]));
    extra['skinned'] = skinned;
    // A material with a mask of its own (a terrain's holes, a cut-away fade).
    const own = new MeshStandardNodeMaterial();
    (own as unknown as { maskNode: unknown }).maskNode = TSL.uv().x.greaterThan(0.5);
    extra['ownMask'] = new THREE.Mesh(geo, own as unknown as THREE.Material);
    for (const m of Object.values(extra)) scene.add(m);
    const { renderer } = armed();
    const plain = wgslRenderer();
    // Skinning asks the device how large a uniform buffer may be (no device here).
    for (const r of [renderer, plain]) (r as unknown as { backend: { capabilities: { getUniformBufferLimit(): number } } }).backend.capabilities.getUniformBufferLimit = () => 65536;
    for (const [id, m] of Object.entries({ ...meshes, ...extra })) {
      const withMask = fragmentOf(wgslOf(renderer, scene, m));
      expect(withMask, id).toContain('discard');
      expect(withMask, id).toContain('seeThroughFade');
      expect(withMask, id).not.toBe(fragmentOf(wgslOf(plain, scene, m)));
    }
    // The material's own mask stays (two discards: its own and see-through's).
    expect(fragmentOf(wgslOf(renderer, scene, extra['ownMask']!)).match(/discard/g)?.length).toBeGreaterThanOrEqual(2);
  });

  it('builds the CPU reference\'s own steps (one set of steps, two sets of operations): each slot\'s circle unrolled once', async () => {
    const { scene, meshes } = await libraryScene(SHADER_TYPE_MATERIALS.slice(0, 1));
    const { renderer } = armed();
    const count = (r: ReturnType<typeof wgslRenderer>): number => fragmentOf(wgslOf(r, scene, meshes['standard']!)).match(/smoothstep\(/g)?.length ?? 0;
    expect(count(renderer) - count(wgslRenderer())).toBe(SEE_THROUGH_SUBJECTS);
  });

  it('an armed draw refreshes its own uniforms every frame, a classic material\'s too (its subject bits change while it stays still)', () => {
    const scene = litScene();
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshLambertMaterial());
    scene.add(mesh);
    expect(refreshesEveryFrame(wgslRenderer(), scene, mesh)).toBe(false);
    expect(refreshesEveryFrame(armed().renderer, scene, mesh)).toBe(true);
  });

  it('builds no mask into the shadow pass, colourless draws or draws over everything', () => {
    const { renderer } = armed();
    const scene = litScene();
    const geo = new THREE.BoxGeometry();
    const shadowPass = new NodeMaterial();
    (shadowPass as unknown as { isShadowPassMaterial: boolean }).isShadowPassMaterial = true;
    const colourless = new THREE.MeshBasicMaterial({ colorWrite: false });
    const overlay = new THREE.MeshBasicMaterial({ depthTest: false });
    for (const m of [shadowPass as unknown as THREE.Material, colourless, overlay]) {
      const mesh = new THREE.Mesh(geo, m);
      scene.add(mesh);
      expect(wgslOf(renderer, scene, mesh)).not.toContain('seeThroughFade');
    }
  });

  it('subjects and settings are uniforms: changing them builds the same program', async () => {
    const objects: Record<string, THREE.Object3D> = { a: body(0, 0), b: body(2, -3) };
    const camera = perspective([0, 6, 10], [0, 1, 0]);
    const view = new SeeThroughView({ ...plain(objects), components: () => ({}), cameraTarget: () => 'a' }, ON);
    const { renderer } = armed(view);
    const { scene, meshes } = await libraryScene(SHADER_TYPE_MATERIALS.slice(0, 1));
    const m = meshes['standard']!;
    const before = wgslOf(renderer, scene, m);
    view.set({ subjects: ['a', 'b'], radius: 0.5, softness: 0.1, maxFade: 0.5, depthMargin: 1 });
    view.update(renderer, camera, 100);
    expect(wgslOf(renderer, scene, m)).toBe(before);
  });

  it('a prebuilding view arms at its first frame while off, so turning it on later builds no program again', async () => {
    const objects: Record<string, THREE.Object3D> = { a: body(0, 0) };
    const camera = perspective([0, 6, 10], [0, 1, 0]);
    const deps = { ...plain(objects), components: () => ({}), cameraTarget: () => 'a', prebuild: true };
    const view = new SeeThroughView(deps);
    const renderer = wgslRenderer();
    view.update(renderer, camera, 0);
    expect(view.diagnostics()).toMatchObject({ enabled: false, armed: true, subjects: [] });
    const { scene, meshes } = await libraryScene(SHADER_TYPE_MATERIALS.slice(0, 1));
    const m = meshes['standard']!;
    const off = wgslOf(renderer, scene, m);
    expect(fragmentOf(off)).toContain('seeThroughFade');
    // Off, nothing fades: no draw takes a subject's bit (the programs skip the mask).
    expect(view.bitsFor(m)).toBe(0);
    const ctx = (renderer as unknown as { contextNode: { version: number } }).contextNode;
    const version = ctx.version;
    view.set({ enabled: true });
    view.update(renderer, camera, 100);
    expect(ctx.version).toBe(version);
    expect(wgslOf(renderer, scene, m)).toBe(off);
    expect(view.bitsFor(m)).not.toBe(0);
    // A page pinned off never arms, prebuilt or not.
    const pinned = new SeeThroughView({ ...deps, pinned: false });
    pinned.update(wgslRenderer(), camera, 0);
    expect(pinned.diagnostics().armed).toBe(false);
  });
});

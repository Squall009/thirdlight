import { describe, expect, it } from 'vitest';
import * as THREE from 'three/webgpu';

import { BALLAST_MAX, BALLAST_SIZE, BALLAST_STEPS, GpuLoad, HEADROOM_LAYER, type GpuLoadRenderer } from './gpu-headroom';
import { gpuPassHides } from './gpu-pass-hides';
import { fragmentWgslOf, wgslRenderer } from './test-wgsl';

/** A renderer that records what each render call drew: the camera's layer mask, the target and what was visible to it. */
function recordingRenderer() {
  const calls: { scene: THREE.Object3D; mask: number; target: THREE.RenderTarget | null; drawn: string[]; lights: number; autoClear: boolean; background: unknown }[] = [];
  let target: THREE.RenderTarget | null = null;
  let mrt: unknown = 'scene-mrt';
  const r: GpuLoadRenderer & { calls: typeof calls; mrt(): unknown } = {
    calls,
    mrt: () => mrt,
    autoClear: false,
    render(scene, camera) {
      const drawn: string[] = [];
      let lights = 0;
      // three's projection: an object is drawn when its layers meet the camera's; its children are tested on their own.
      scene.traverseVisible((o) => {
        if (!o.layers.test(camera.layers)) return;
        if ((o as THREE.Light).isLight === true) lights += 1;
        else if ((o as THREE.Mesh).isMesh === true) drawn.push(o.name);
      });
      calls.push({ scene, mask: camera.layers.mask, target, drawn, lights, autoClear: r.autoClear, background: (scene as THREE.Scene).background });
    },
    getRenderTarget: () => target,
    setRenderTarget: (t) => void (target = t),
    getMRT: () => mrt,
    setMRT: (m) => void (mrt = m),
  };
  return r;
}

function testScene() {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color('#88aaff');
  const sun = new THREE.DirectionalLight('#ffffff', 1);
  sun.castShadow = true;
  scene.add(sun, new THREE.AmbientLight('#ffffff', 0.3));
  const mesh = (name: string) => Object.assign(new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicNodeMaterial()), { name });
  const near = new THREE.Group();
  const chunk = mesh('chunk');
  const caster = mesh('shadow-only caster');
  caster.layers.set(31);
  near.add(chunk, caster);
  const far = new THREE.Group();
  far.add(mesh('far node'));
  const other = mesh('other entity');
  scene.add(near, far, other);
  const camera = new THREE.PerspectiveCamera();
  return { scene, sun, near, far, chunk, caster, camera };
}

describe('GpuLoad: the headroom meter’s load on a frame', () => {
  it('draws the chosen roots’ drawables again with the scene’s lights, into a target of the scene pass’s size, then puts every setting back', () => {
    const { scene, near, chunk, caster, camera } = testScene();
    const r = recordingRenderer();
    const sceneTarget = new THREE.RenderTarget(4, 4);
    r.setRenderTarget(sceneTarget);
    const load = new GpuLoad();
    load.set({ copies: 3, copyOf: () => [near] });
    expect(load.active).toBe(true);
    load.afterDraw(r, scene, camera, 853.3, 480);
    expect(r.calls).toHaveLength(3);
    for (const c of r.calls) {
      expect(c.mask).toBe(1 << HEADROOM_LAYER);
      // The near root's layer-0 drawable only: not the shadow-only caster, the far field or other entities; both lights.
      expect(c.drawn).toEqual(['chunk']);
      expect(c.lights).toBe(2);
      expect(c.target).not.toBe(sceneTarget);
      expect([c.target!.width, c.target!.height]).toEqual([853, 480]);
      expect(c.autoClear).toBe(true);
      // The sky is the scene's, not the copied pass's.
      expect(c.background).toBeNull();
    }
    expect(camera.layers.mask).toBe(1);
    expect(r.getRenderTarget()).toBe(sceneTarget);
    expect(r.mrt()).toBe('scene-mrt');
    expect(r.autoClear).toBe(false);
    expect(scene.background).toBeInstanceOf(THREE.Color);
    expect(caster.layers.isEnabled(HEADROOM_LAYER)).toBe(false);
    expect(load.state()).toMatchObject({ copies: 3, size: [853, 480], frames: 1 });
    expect(load.state().copyCpuMs).toBeGreaterThanOrEqual(0);

    // A drawable arriving under the root is copied the next frame; off again, nothing stays in the meter's layer.
    const late = Object.assign(new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicNodeMaterial()), { name: 'late chunk' });
    near.add(late);
    load.afterDraw(r, scene, camera, 853, 480);
    expect(r.calls.at(-1)!.drawn).toEqual(['chunk', 'late chunk']);
    load.set({});
    load.afterDraw(r, scene, camera, 853, 480);
    expect(r.calls).toHaveLength(6);
    let inLayer = 0;
    scene.traverse((o) => void (o.layers.isEnabled(HEADROOM_LAYER) && inLayer++));
    expect(inLayer).toBe(0);
    expect(chunk.layers.mask).toBe(1);
    expect(load.active).toBe(false);
  });

  it('draws the ballast as one instanced draw of a fixed size, its count clamped, and builds a fragment that runs its steps', () => {
    const { scene, camera } = testScene();
    const r = recordingRenderer();
    const load = new GpuLoad();
    load.set({ ballast: BALLAST_MAX + 10 });
    load.afterDraw(r, scene, camera, 1280, 720);
    expect(r.calls).toHaveLength(1);
    const call = r.calls[0]!;
    expect(call.scene).not.toBe(scene);
    expect([call.target!.width, call.target!.height]).toEqual([...BALLAST_SIZE]);
    const mesh = (call.scene as THREE.Scene).children[0] as THREE.Mesh;
    expect((mesh.geometry as THREE.InstancedBufferGeometry).instanceCount).toBe(BALLAST_MAX);
    load.set({ ballast: 7 });
    load.afterDraw(r, scene, camera, 1280, 720);
    expect(r.calls).toHaveLength(2);
    expect((mesh.geometry as THREE.InstancedBufferGeometry).instanceCount).toBe(7);
    const wgsl = fragmentWgslOf(wgslRenderer(), call.scene as THREE.Scene, mesh);
    expect(wgsl).toMatch(new RegExp(`< ${BALLAST_STEPS}`));
    expect(wgsl).toMatch(/sin\(/);
  });

  it('stops the shadow-casting lights casting while the shadows category is hidden and gives them back when shown', () => {
    const { scene, sun, camera } = testScene();
    const r = recordingRenderer();
    const load = new GpuLoad(scene);
    expect(gpuPassHides.present().shadows).toEqual(['shadow maps']);
    gpuPassHides.set(['shadows']);
    expect(load.active).toBe(true);
    load.afterDraw(r, scene, camera, 1280, 720);
    expect(sun.castShadow).toBe(false);
    expect(load.state().lightsHidden).toBe(1);
    // Still present while hidden (the measurement reads it), and nothing is drawn for a hide alone.
    expect(gpuPassHides.present().shadows).toEqual(['shadow maps']);
    expect(r.calls).toHaveLength(0);
    gpuPassHides.set([]);
    expect(sun.castShadow).toBe(true);
    expect(load.active).toBe(false);
    load.dispose();
    expect(gpuPassHides.present().shadows).toBeUndefined();
  });

  it('draws the frame without the post stack into a target of the stack’s size and copies it to the canvas', () => {
    const { scene, camera } = testScene();
    const r = recordingRenderer();
    const load = new GpuLoad(scene, () => true);
    expect(gpuPassHides.present().post).toEqual(['post stack']);
    gpuPassHides.set(['post']);
    expect(load.bypassesPost).toBe(true);
    // The canvas copy is a three QuadMesh: its render goes through the same renderer.
    load.drawPlain(r, scene, camera, 853, 480);
    expect(r.calls).toHaveLength(2);
    expect(r.calls[0]!.scene).toBe(scene);
    expect([r.calls[0]!.target!.width, r.calls[0]!.target!.height]).toEqual([853, 480]);
    expect(r.calls[1]!.target).toBeNull();
    gpuPassHides.set([]);
    load.dispose();
    expect(load.active).toBe(false);
  });

  it('draws a known pass’s ballast under its category only while that category is shown', () => {
    const { scene, camera } = testScene();
    const r = recordingRenderer();
    const load = new GpuLoad();
    load.setKnownPass({ category: 'lighting', units: 40 });
    expect(gpuPassHides.present().lighting).toEqual(['known pass (40 ballast copies)']);
    expect(load.active).toBe(true);
    load.afterDraw(r, scene, camera, 1280, 720);
    const mesh = (r.calls[0]!.scene as THREE.Scene).children[0] as THREE.Mesh;
    expect((mesh.geometry as THREE.InstancedBufferGeometry).instanceCount).toBe(40);
    load.setBallast(10);
    load.afterDraw(r, scene, camera, 1280, 720);
    expect((mesh.geometry as THREE.InstancedBufferGeometry).instanceCount).toBe(50);
    gpuPassHides.set(['lighting']);
    load.afterDraw(r, scene, camera, 1280, 720);
    expect((mesh.geometry as THREE.InstancedBufferGeometry).instanceCount).toBe(10);
    gpuPassHides.set([]);
    load.setKnownPass(null);
    expect(gpuPassHides.present().lighting).toBeUndefined();
    load.dispose();
  });

  it('times frames by the GPU’s completions on WebGPU, in frame order', async () => {
    const load = new GpuLoad();
    let finish: (() => void)[] = [];
    const renderer = { backend: { isWebGPUBackend: true, device: { queue: { onSubmittedWorkDone: () => new Promise<void>((done) => finish.push(done)) } } } };
    const rec = load.record(0.05, 'gpu');
    for (let i = 0; i < 3; i++) load.presented(i, renderer);
    // Nothing is stamped until the GPU says the frame is done.
    for (const f of finish) f();
    finish = [];
    const intervals = await rec;
    expect(intervals).toHaveLength(2);
    expect(intervals.every((d) => d >= 0)).toBe(true);
    // WebGL 2 has no completions: a GPU-clock recording stamps nothing.
    const none = load.record(0.02, 'gpu');
    for (let i = 0; i < 3; i++) load.presented(i, { backend: { isWebGPUBackend: false } });
    expect(await none).toEqual([]);
    load.dispose();
  });
});

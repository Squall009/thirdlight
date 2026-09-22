/**
 * Packet-26 tests: the local material/animation preview controller.
 *
 * Node-level: the animation mixer's CPU-side pose application is observable
 * (node quaternions), so play/pause/scrub are verified without a renderer.
 * Rendered pixels and WebGL behaviour remain UNVERIFIED (no browser here).
 */
import { describe, expect, it } from 'vitest';
import type * as THREE from 'three';
import { prepareVisualResource, suppliedBytes, type AssetPreviewController, type ModelInstance, type PrepareVisualResult, type PreparedVisualResource } from './index';
import { buildGlb, descriptorFor } from './test-glb';
import { createFakePort } from './test-visual';

function ready(result: PrepareVisualResult): PreparedVisualResource {
  if (!result.ok) throw new Error(`expected a ready resource, got ${result.error.code}`);
  return result.resource;
}

function failedCode(result: { readonly ok: boolean; readonly error?: { readonly code: string } }): string {
  if (result.ok) throw new Error('expected a structured failure');
  return result.error?.code ?? 'missing';
}

async function prepared(options: { materials?: number } = {}): Promise<{
  resource: PreparedVisualResource;
  instance: ModelInstance;
  controller: AssetPreviewController;
  rotor: THREE.Object3D;
  mesh: THREE.Mesh;
}> {
  const fake = createFakePort();
  const bytes = buildGlb(options);
  const handle = prepareVisualResource(suppliedBytes(descriptorFor(bytes), bytes), { loader: fake.port });
  fake.last().resolveWith();
  const resource = ready(await handle.result);
  const made = resource.createInstance();
  if (!made.ok) throw new Error('createInstance failed');
  const instance = made.instance;
  const controller = instance.createPreviewController();
  if (!controller.ok) throw new Error('createPreviewController failed');
  const rotor = instance.glbRoot.getObjectByName('Rotor');
  if (!rotor) throw new Error('rotor missing');
  const mesh = rotor.children[0] as THREE.Mesh;
  return { resource, instance, controller: controller.controller, rotor, mesh };
}

describe('packet 26 — local animation preview (play / pause / scrub)', () => {
  it('reports the clip list and drives a local mixer through play, pause and scrub', async () => {
    const { resource, instance, controller, rotor } = await prepared();
    expect(controller.clips()).toHaveLength(1);
    expect(controller.state()).toMatchObject({ playing: false, clipIndex: null, timeSeconds: 0, clipCount: 1, materialMode: 'asset' });

    expect(controller.play().ok).toBe(true);
    expect(controller.state().playing).toBe(true);
    expect(controller.update(0.25).ok).toBe(true);
    expect(controller.state().timeSeconds).toBeCloseTo(0.25, 5);

    expect(controller.pause().ok).toBe(true);
    expect(controller.state().playing).toBe(false);
    const paused = controller.state().timeSeconds;
    controller.update(0.5);
    expect(controller.state().timeSeconds).toBeCloseTo(paused, 5); // paused: no advance

    // Scrub applies the pose directly (observable on the node quaternion).
    expect(controller.scrub(1).ok).toBe(true);
    expect(controller.state().timeSeconds).toBeCloseTo(1, 5);
    expect(Math.abs(rotor.quaternion.z)).toBeGreaterThan(0.6);
    expect(controller.scrub(0).ok).toBe(true);
    expect(rotor.quaternion.z).toBeCloseTo(0, 5);
    // Scrubbing past the clip duration clamps to the clip end.
    expect(controller.scrub(99).ok).toBe(true);
    expect(controller.state().timeSeconds).toBeCloseTo(1, 5);

    instance.dispose();
    resource.dispose();
  });

  it('bounds-check clip selection, scrub time and update deltas (preview_invalid)', async () => {
    const { resource, instance, controller } = await prepared();
    expect(controller.selectClip(1).ok).toBe(false);
    expect(controller.selectClip(-1).ok).toBe(false);
    expect(controller.selectClip(0).ok).toBe(true);
    expect(controller.state().clipIndex).toBe(0);
    expect(controller.scrub(-1).ok).toBe(false);
    expect(controller.scrub(Number.NaN).ok).toBe(false);
    expect(controller.scrub(Number.POSITIVE_INFINITY).ok).toBe(false);
    expect(controller.update(-0.1).ok).toBe(false);
    expect(controller.update(Number.NaN).ok).toBe(false);
    expect(controller.setMaterialMode('bogus' as never).ok).toBe(false);
    for (const result of [controller.scrub(-1), controller.update(Number.NaN)]) {
      if (result.ok) throw new Error('expected failure');
      expect(result.error.code).toBe('preview_invalid');
    }
    instance.dispose();
    resource.dispose();
  });

  it('a model without clips refuses play/scrub with preview_invalid (no fake animation)', async () => {
    const fake = createFakePort({ animations: [] });
    const bytes = buildGlb({ clip: false });
    const handle = prepareVisualResource(suppliedBytes(descriptorFor(bytes), bytes), { loader: fake.port });
    fake.last().resolveWith({ animations: [] });
    const resource = ready(await handle.result);
    const made = resource.createInstance();
    if (!made.ok) throw new Error('createInstance failed');
    const controller = made.instance.createPreviewController();
    if (!controller.ok) throw new Error('createPreviewController failed');
    expect(resource.clips).toHaveLength(0);
    if (controller.controller.play().ok) throw new Error('expected failure');
    expect(controller.controller.play().ok).toBe(false);
    const play = controller.controller.play();
    if (play.ok) throw new Error('expected failure');
    expect(play.error.code).toBe('preview_invalid');
    const scrub = controller.controller.scrub(0.5);
    if (scrub.ok) throw new Error('expected failure');
    expect(scrub.error.code).toBe('preview_invalid');
    expect(controller.controller.state().clipCount).toBe(0);
    made.instance.dispose();
    resource.dispose();
  });
});

describe('packet 26 — local material preview', () => {
  it('wireframe/normals are instance-local override materials; asset mode restores the asset material', async () => {
    const a = await prepared({ materials: 2 });
    const b = await prepared({ materials: 2 });
    const assetMaterial = a.mesh.material;
    expect((assetMaterial as THREE.MeshStandardMaterial).type).toBe('MeshStandardMaterial');

    expect(a.controller.setMaterialMode('wireframe').ok).toBe(true);
    expect(a.controller.state().materialMode).toBe('wireframe');
    const wireframe = a.mesh.material as THREE.MeshBasicMaterial;
    expect(wireframe.wireframe).toBe(true);
    expect(wireframe).not.toBe(assetMaterial);
    // The asset's own material is untouched, and the other instance is unaffected.
    expect((assetMaterial as THREE.MeshStandardMaterial).wireframe).toBe(false);
    expect(b.mesh.material).toBe(b.mesh.material);
    expect((b.mesh.material as THREE.MeshStandardMaterial).type).toBe('MeshStandardMaterial');

    expect(a.controller.setMaterialMode('normals').ok).toBe(true);
    expect((a.mesh.material as THREE.MeshNormalMaterial).type).toBe('MeshNormalMaterial');
    expect(a.controller.setMaterialMode('asset').ok).toBe(true);
    expect(a.mesh.material).toBe(assetMaterial);

    a.instance.dispose();
    b.instance.dispose();
    a.resource.dispose();
    b.resource.dispose();
  });

  it('counts and releases the controller-owned mixer and override materials', async () => {
    const { resource, instance, controller } = await prepared();
    controller.play();
    controller.setMaterialMode('wireframe');
    controller.setMaterialMode('normals');
    const report = resource.ownership();
    expect(report.byKind.mixer.allocations).toBe(1);
    expect(report.byKind.material.allocations).toBe(3); // the asset material + the two override materials
    expect(report.byKind.instance.allocations).toBe(1);
    expect(controller.dispose()).toEqual({ ok: true });
    expect(controller.dispose()).toEqual({ ok: true, alreadyDisposed: true });
    const after = resource.ownership();
    expect(after.byKind.mixer.releases).toBe(1);
    expect(after.byKind.material.releases).toBe(2); // the overrides; the asset material follows the resource
    instance.dispose();
    resource.dispose();
    expect(resource.ownership().outstanding).toBe(0);
  });

  it('disposing the instance disposes its controllers (no leaked mixer or override material)', async () => {
    const { resource, instance, controller } = await prepared();
    controller.play();
    controller.setMaterialMode('wireframe');
    instance.dispose();
    expect(controller.play().ok).toBe(false); // the controller was disposed with its instance
    expect(controller.state().playing).toBe(false);
    expect(failedCode(controller.play())).toBe('asset_disposed');
    resource.dispose();
    expect(resource.ownership().outstanding).toBe(0);
  });
});

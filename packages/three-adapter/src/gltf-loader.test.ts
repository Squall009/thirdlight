/**
 * Packet-26 tests: the pinned `three@0.186.0` GLTFLoader-backed port
 * (`./gltf-loader` subpath) over real, self-contained GLB bytes.
 *
 * These run in Node against the REAL loader (three's own GLTFLoader module,
 * transitively pulling its BufferGeometryUtils/SkeletonUtils imports — no mock
 * of the loader binding). Verified here: container/extension guarding,
 * successful realization of a real scene graph (MeshStandardMaterial +
 * BufferGeometry + AnimationClip), instance independence with shared
 * geometry/material, exact release of the loader-created resources, and
 * structured failures for corrupt/unsupported/embedded-image inputs.
 *
 * NOT verified here (no browser): texture decode of embedded PNG/JPEG, rendered
 * pixels, WebGL state, screenshot taint. See docs/acceptance/evidence-m2/26/.
 */
import { describe, expect, it, vi } from 'vitest';
import { MeshStandardMaterial, BufferGeometry, type Mesh } from 'three';
import { GLTF_LOADER_ALLOWED_EXTENSIONS, createGltfLoaderPort } from './gltf-loader';
import { prepareVisualResource, suppliedBytes, type PrepareVisualResult, type PreparedVisualResource } from './index';
import { buildGlb, descriptorFor } from './test-glb';

function ready(result: PrepareVisualResult): PreparedVisualResource {
  if (!result.ok) throw new Error(`expected a ready resource, got ${result.error.code}: ${result.error.message}`);
  return result.resource;
}

function codeOf(result: PrepareVisualResult): string {
  if (result.ok) throw new Error('expected a failure');
  return result.error.code;
}

async function loadReal(bytes: Uint8Array, allowedExtensions?: readonly string[]): Promise<PrepareVisualResult> {
  const port = allowedExtensions === undefined ? createGltfLoaderPort() : createGltfLoaderPort({ allowedExtensions });
  const handle = prepareVisualResource(suppliedBytes(descriptorFor(bytes), bytes), { loader: port });
  return handle.result;
}

/** A mesh object from a throwaway instance (its geometry/material are the shared ones). */
function firstMesh(resource: PreparedVisualResource): Mesh {
  const made = resource.createInstance();
  if (!made.ok) throw new Error('createInstance failed');
  const mesh = firstMeshOf(made.instance.glbRoot);
  made.instance.dispose();
  return mesh;
}

describe('packet 26 — pinned GLTFLoader port (three@0.186.0, real bytes, Node)', () => {
  it('realizes a real scene graph: preserved hierarchy, MeshStandardMaterial, BufferGeometry, clip', async () => {
    const bytes = buildGlb();
    const resource = ready(await loadReal(bytes));
    expect(resource.clips.map((c) => c.name)).toEqual(['Spin']);
    expect(resource.clips[0]?.trackCount).toBe(1);
    const report = resource.ownership();
    expect(report.byKind.geometry.allocations).toBeGreaterThanOrEqual(1);
    expect(report.byKind.material.allocations).toBeGreaterThanOrEqual(1);
    const mesh = firstMesh(resource);
    expect(mesh.geometry).toBeInstanceOf(BufferGeometry);
    expect(mesh.material).toBeInstanceOf(MeshStandardMaterial);
    // baseColorFactor [0.9, 0.4, 0.3] after three's color management.
    expect((mesh.material as MeshStandardMaterial).color.getHexString()).toBe('f3aa95');
    // The whole-GLB hierarchy is preserved (Group 'Scene' → Group 'Main' → Object3D 'Rotor' → Mesh 'Tri').
    const instance = resource.createInstance();
    if (!instance.ok) throw new Error('createInstance failed');
    expect(instance.instance.root.children).toHaveLength(1);
    expect(instance.instance.glbRoot.name).toBe('Scene');
    expect(instance.instance.glbRoot.getObjectByName('Main')).toBeTruthy();
    expect(instance.instance.glbRoot.getObjectByName('Rotor')).toBeTruthy();
    instance.instance.dispose();
    resource.dispose();
    expect(resource.ownership().outstanding).toBe(0);
  });

  it('two instances share the loader-created geometry/material but are independent objects', async () => {
    const resource = ready(await loadReal(buildGlb()));
    const a = resource.createInstance();
    const b = resource.createInstance();
    if (!a.ok || !b.ok) throw new Error('createInstance failed');
    const ma = firstMeshOf(a.instance.glbRoot);
    const mb = firstMeshOf(b.instance.glbRoot);
    expect(ma).not.toBe(mb);
    expect(ma.geometry).toBe(mb.geometry); // shared resource (one owner)
    expect(ma.material).toBe(mb.material);
    a.instance.setTransform([4, 0, 0], [0, 0, 0, 1], [1, 1, 1]);
    expect(a.instance.root.position.x).toBe(4);
    expect(b.instance.root.position.x).toBe(0);
    const ca = a.instance.createPreviewController();
    if (!ca.ok) throw new Error('controller failed');
    ca.controller.play();
    ca.controller.update(0.5);
    expect(ca.controller.state().timeSeconds).toBeCloseTo(0.5, 5);
    a.instance.dispose();
    b.instance.dispose();
    resource.dispose();
    expect(resource.ownership().outstanding).toBe(0);
  });

  it('disposes exactly the loader-created geometry/material (once) through the resource', async () => {
    const resource = ready(await loadReal(buildGlb()));
    const mesh = firstMesh(resource);
    const geometryDispose = vi.spyOn(mesh.geometry, 'dispose');
    const materialDispose = vi.spyOn(mesh.material as MeshStandardMaterial, 'dispose');
    const instance = resource.createInstance();
    if (!instance.ok) throw new Error('createInstance failed');
    instance.instance.dispose();
    expect(resource.dispose()).toEqual({ ok: true });
    expect(geometryDispose).toHaveBeenCalledTimes(1);
    expect(materialDispose).toHaveBeenCalledTimes(1);
    expect(resource.dispose()).toEqual({ ok: true, alreadyDisposed: true });
    expect(geometryDispose).toHaveBeenCalledTimes(1); // no double release
    expect(resource.ownership().outstanding).toBe(0);
  });

  it('rejects unsupported/required extensions structurally (fail closed)', async () => {
    const variants = buildGlb({
      extensionsUsed: ['KHR_materials_variants'],
      extensionsRequired: ['KHR_materials_variants'],
    });
    const result = await loadReal(variants);
    expect(codeOf(result)).toBe('asset_extension_unsupported');
    if (!result.ok) expect(result.error.message.length).toBeLessThanOrEqual(256);

    // An allowlisted extension passes the guard (the allowlist is injectable;
    // the default is the import allowlist).
    const unlit = buildGlb({ extensionsUsed: ['KHR_materials_unlit'] });
    expect(GLTF_LOADER_ALLOWED_EXTENSIONS).toContain('KHR_materials_unlit');
    const allowed = await loadReal(unlit);
    expect(allowed.ok).toBe(true);
    if (allowed.ok) allowed.resource.dispose();
  });

  it('rejects truncated/corrupt containers without throwing across the module edge', async () => {
    const good = buildGlb();
    const truncated = good.slice(0, good.byteLength - 12);
    const result = await loadReal(truncated);
    expect(codeOf(result)).toBe('asset_corrupt');

    // A GLB whose JSON chunk cannot be parsed at all.
    const badJson = (() => {
      const bytes = good.slice();
      // Corrupt the JSON chunk body while keeping the framing intact.
      bytes[30] = 0x7b; // '{'
      bytes[31] = 0x7b; // '{'
      return bytes;
    })();
    const result2 = await loadReal(badJson);
    expect(codeOf(result2)).toBe('asset_corrupt');
  });

  it('reports an embedded-image decode failure structurally in Node (browser decode UNVERIFIED)', async () => {
    // Node has no DOM image decoder, so an embedded texture cannot be decoded.
    // This proves the failure is bounded/structured and leaks nothing here; the
    // successful decode path is a browser-only claim (packet-37 procedure).
    const withImage = buildGlb({ image: true });
    const result = await loadReal(withImage);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('asset_image_invalid');
      expect(result.error.message.length).toBeLessThanOrEqual(256);
    }
  });
});

function firstMeshOf(root: import('three').Object3D): Mesh {
  let found: Mesh | null = null;
  root.traverse((o) => {
    const mesh = o as Mesh;
    if (found === null && mesh.isMesh === true) found = mesh;
  });
  if (found === null) throw new Error('no mesh in the hierarchy');
  return found;
}

/**
 * Packet-26 tests: the shared GLB realization path (visual.ts) — Node-level,
 * with an injected loader port and REAL three.js objects.
 *
 * LABELED per AGENTS.md: no browser exists in this container. What is proved
 * here is the loading/ownership/preview logic (cancellation, stale discard,
 * structured failures, independence, ownership balance, idempotent disposal)
 * through injected ports. Rendered pixels, real GLTFLoader texture decode,
 * screenshot taint and WebGL behaviour remain UNVERIFIED — see the packet-26
 * evidence manifest for the exact packet-37 browser procedure.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createVisualResourceStore,
  ERROR_CODES,
  injectedResolver,
  prepareVisualResource,
  suppliedBytes,
  VISUAL_SOURCE_BYTES_MAX,
  visualLoadFailure,
  type AssetVersionDescriptor,
  type PrepareVisualResult,
  type PreparedVisualResource,
} from './index';
import { descriptorFor, buildGlb } from './test-glb';
import { createFakePort, fakeFailure } from './test-visual';

afterEach(() => {
  vi.unstubAllGlobals();
});

function ready(result: PrepareVisualResult): PreparedVisualResource {
  if (!result.ok) throw new Error(`expected a ready resource, got ${result.error.code}: ${result.error.message}`);
  return result.resource;
}

function failed(result: PrepareVisualResult): string {
  if (result.ok) throw new Error('expected a failed result, got a ready resource');
  return result.error.code;
}

function instanceOf(resource: PreparedVisualResource) {
  const made = resource.createInstance();
  if (!made.ok) throw new Error(`createInstance failed: ${made.error.code}`);
  return made.instance;
}

describe('packet 26 — public surface (dependencies.md §3 additions row)', () => {
  it('exports the realization helpers and the packet-26 error codes', () => {
    expect(typeof prepareVisualResource).toBe('function');
    expect(typeof suppliedBytes).toBe('function');
    expect(typeof injectedResolver).toBe('function');
    expect(typeof createVisualResourceStore).toBe('function');
    expect(typeof visualLoadFailure).toBe('function');
    expect(VISUAL_SOURCE_BYTES_MAX).toBe(33_554_432);
    for (const code of [
      'asset_source_invalid',
      'asset_missing',
      'asset_corrupt',
      'asset_extension_unsupported',
      'asset_image_invalid',
      'asset_clip_invalid',
      'asset_load_cancelled',
      'asset_load_stale',
      'asset_disposed',
      'preview_invalid',
      'render_context_lost',
    ]) {
      expect(ERROR_CODES).toContain(code);
    }
  });

  it('rejects a missing/invalid source before any loader work (asset_source_invalid)', async () => {
    const fake = createFakePort();
    const bytes = buildGlb();
    const bad = prepareVisualResource(undefined as never, { loader: fake.port });
    expect(failed(await bad.result)).toBe('asset_source_invalid');
    const noBytes = prepareVisualResource(suppliedBytes(descriptorFor(bytes), null as never), { loader: fake.port });
    expect(failed(await noBytes.result)).toBe('asset_source_invalid');
    const badDigest = prepareVisualResource(
      suppliedBytes({ ...descriptorFor(bytes), sourceDigest: 'nope' }, bytes),
      { loader: fake.port },
    );
    expect(failed(await badDigest.result)).toBe('asset_source_invalid');
    const noLoader = prepareVisualResource(suppliedBytes(descriptorFor(bytes), bytes), {} as never);
    expect(failed(await noLoader.result)).toBe('asset_source_invalid');
    expect(fake.records.length).toBe(0); // no loader call for any invalid source
  });
});

describe('packet 26 — prepare: supplied bytes and an injected resolver', () => {
  it('prepares a descriptor set from supplied bytes: clips, ownership and diagnostics', async () => {
    const fake = createFakePort();
    const bytes = buildGlb({ materials: 2 });
    const descriptor = descriptorFor(bytes, { assetId: 'asset-00000000000000aa', version: 3 });
    const handle = prepareVisualResource(suppliedBytes(descriptor, bytes), { loader: fake.port });
    expect(handle.state()).toBe('pending');
    fake.last().resolveWith();
    const resource = ready(await handle.result);
    expect(handle.state()).toBe('ready');
    expect(resource.descriptor).toEqual(descriptor);
    expect(resource.clips).toHaveLength(1);
    expect(resource.clips[0]).toMatchObject({ index: 0, name: 'Spin', durationSeconds: 1, trackCount: 1 });
    const report = resource.ownership();
    expect(report.byKind.geometry.allocations).toBe(1);
    expect(report.byKind.material.allocations).toBe(1);
    expect(report.byKind.texture.allocations).toBe(1);
    expect(report.byKind.listener.allocations).toBe(2);
    expect(report.byKind.objectUrl.allocations).toBe(1);
    expect(report.byKind.instance.allocations).toBe(0);
    expect(resource.diagnostics()).toMatchObject({ state: 'ready', instances: 0, clips: 1 });
    expect(fake.stats.loadedDisposed).toBe(0);
    resource.dispose();
    expect(resource.ownership().outstanding).toBe(0);
    expect(fake.stats.loadedDisposed).toBe(1);
  });

  it('prepares through an injected resolver that receives only the descriptor and an AbortSignal', async () => {
    const fake = createFakePort();
    const bytes = buildGlb();
    const descriptor = descriptorFor(bytes);
    const seen: { descriptor: AssetVersionDescriptor | null; aborted: boolean } = { descriptor: null, aborted: false };
    const source = injectedResolver(descriptor, async (signal) => {
      seen.descriptor = descriptor;
      seen.aborted = signal.aborted;
      return bytes;
    });
    const handle = prepareVisualResource(source, { loader: fake.port });
    // The resolver is awaited before the loader is invoked.
    await new Promise((resolve) => setTimeout(resolve, 0));
    fake.last().resolveWith();
    const resource = ready(await handle.result);
    expect(seen.descriptor).toEqual(descriptor);
    expect(seen.aborted).toBe(false);
    resource.dispose();
  });
});

describe('packet 26 — model instances are independent', () => {
  it('two instances preserve the hierarchy under one entity and keep transforms/animation state independent', async () => {
    const fake = createFakePort();
    const bytes = buildGlb();
    const handle = prepareVisualResource(suppliedBytes(descriptorFor(bytes), bytes), { loader: fake.port });
    fake.last().resolveWith();
    const resource = ready(await handle.result);
    const a = instanceOf(resource);
    const b = instanceOf(resource);
    expect(fake.stats.instanceCreated).toBe(2);

    // One entity holder per instance; the GLB hierarchy is preserved verbatim.
    expect(a.root.children).toHaveLength(1);
    expect(a.glbRoot.parent).toBe(a.root);
    expect(a.glbRoot.name).toBe('Main');
    expect(a.glbRoot.getObjectByName('Rotor')).toBeTruthy();
    expect(a.glbRoot).not.toBe(b.glbRoot);
    expect(a.root.name).toContain(resource.descriptor.assetId);

    // Independent transforms (the adapter's single transform helper).
    a.setTransform([1, 2, 3], [0, 0, 0, 1], [2, 2, 2]);
    expect(a.root.position.toArray()).toEqual([1, 2, 3]);
    expect(a.root.scale.toArray()).toEqual([2, 2, 2]);
    expect(b.root.position.toArray()).toEqual([0, 0, 0]);
    expect(b.root.scale.toArray()).toEqual([1, 1, 1]);

    // Independent animation state: one plays, the other does not move.
    const ca = a.createPreviewController();
    const cb = b.createPreviewController();
    if (!ca.ok || !cb.ok) throw new Error('preview controller creation failed');
    expect(ca.controller.play().ok).toBe(true);
    expect(ca.controller.update(0.5).ok).toBe(true);
    expect(ca.controller.state().timeSeconds).toBeCloseTo(0.5, 5);
    expect(cb.controller.state().timeSeconds).toBe(0);
    expect(cb.controller.state().playing).toBe(false);
    const rotorA = a.glbRoot.getObjectByName('Rotor');
    const rotorB = b.glbRoot.getObjectByName('Rotor');
    if (!rotorA || !rotorB) throw new Error('rotor missing');
    expect(Math.abs(rotorA.quaternion.z)).toBeGreaterThan(0.1);
    expect(rotorB.quaternion.z).toBe(0);

    a.dispose();
    expect(fake.stats.loadedDisposed).toBe(0); // b still owns the shared resources
    expect(resource.ownership().byKind.instance.releases).toBe(1);
    b.dispose();
    resource.dispose();
    expect(resource.ownership().outstanding).toBe(0);
    expect(fake.stats.geometryDisposed).toBe(1);
    expect(fake.stats.materialDisposed).toBe(1);
    expect(fake.stats.textureDisposed).toBe(1);
  });
});

describe('packet 26 — cancellation and stale async completion', () => {
  it('cancels a pending resolver load and reports asset_load_cancelled', async () => {
    const fake = createFakePort();
    let observedAbort = false;
    const bytes = buildGlb();
    const handle = prepareVisualResource(
      injectedResolver(descriptorFor(bytes), (signal) =>
        new Promise<Uint8Array>((_resolve, reject) => {
          signal.addEventListener('abort', () => {
            observedAbort = true;
            const err = new Error('aborted');
            err.name = 'AbortError';
            reject(err);
          });
        }),
      ),
      { loader: fake.port },
    );
    handle.cancel();
    expect(failed(await handle.result)).toBe('asset_load_cancelled');
    expect(handle.state()).toBe('cancelled');
    expect(observedAbort).toBe(true);
    expect(fake.records.length).toBe(0); // never reached the loader
  });

  it('discards a late completion after cancel and releases everything it produced', async () => {
    const fake = createFakePort();
    const bytes = buildGlb();
    const handle = prepareVisualResource(suppliedBytes(descriptorFor(bytes), bytes), { loader: fake.port });
    handle.cancel();
    const record = fake.last();
    expect(record.signal.aborted).toBe(true);
    record.resolveWith(); // the port completes anyway
    expect(failed(await handle.result)).toBe('asset_load_cancelled');
    expect(handle.state()).toBe('cancelled');
    // The discarded result was disposed by the loader port, not leaked.
    expect(fake.stats.loadedDisposed).toBe(1);
    expect(fake.stats.geometryDisposed).toBe(1);
  });

  it('structured failure mapping: missing, corrupt, unsupported extension, invalid image and invalid clip', async () => {
    const bytes = buildGlb();
    const descriptor = descriptorFor(bytes);

    // missing: the resolver rejects.
    {
      const fake = createFakePort();
      const handle = prepareVisualResource(
        injectedResolver(descriptor, () => Promise.reject(new Error('asset blob not found'))),
        { loader: fake.port },
      );
      expect(failed(await handle.result)).toBe('asset_missing');
    }
    // corrupt: the bytes do not match the pinned descriptor length.
    {
      const fake = createFakePort();
      const handle = prepareVisualResource(suppliedBytes({ ...descriptor, sourceByteLength: bytes.byteLength + 4 }, bytes), {
        loader: fake.port,
      });
      expect(failed(await handle.result)).toBe('asset_corrupt');
      expect(fake.records.length).toBe(0); // rejected before the loader
    }
    // corrupt: the loader refuses the container.
    {
      const fake = createFakePort();
      const handle = prepareVisualResource(suppliedBytes(descriptor, bytes), { loader: fake.port });
      fake.last().rejectWith(fakeFailure('corrupt', 'the GLB container is invalid'));
      expect(failed(await handle.result)).toBe('asset_corrupt');
    }
    // unsupported extension.
    {
      const fake = createFakePort();
      const handle = prepareVisualResource(suppliedBytes(descriptor, bytes), { loader: fake.port });
      fake.last().rejectWith(fakeFailure('unsupported_extension', "the GLB requires 'KHR_draco_mesh_compression'"));
      const result = await handle.result;
      if (result.ok) throw new Error('expected failure');
      expect(result.error.code).toBe('asset_extension_unsupported');
      expect(result.error.message.length).toBeLessThanOrEqual(256);
    }
    // invalid image.
    {
      const fake = createFakePort();
      const handle = prepareVisualResource(suppliedBytes(descriptor, bytes), { loader: fake.port });
      fake.last().rejectWith(fakeFailure('invalid_image', "couldn't load texture"));
      expect(failed(await handle.result)).toBe('asset_image_invalid');
    }
    // invalid clip: the loaded result carries a structurally invalid clip.
    {
      const fake = createFakePort();
      const broken = { name: 'Broken', duration: Number.NaN, tracks: [] } as never;
      const handle = prepareVisualResource(suppliedBytes(descriptor, bytes), { loader: fake.port });
      fake.last().resolveWith({ animations: [broken] });
      expect(failed(await handle.result)).toBe('asset_clip_invalid');
      expect(fake.stats.loadedDisposed).toBe(1); // the rejected load was released
    }
    // unclassified throw: bounded, structured, never crossing the module edge.
    {
      const fake = createFakePort();
      const handle = prepareVisualResource(suppliedBytes(descriptor, bytes), { loader: fake.port });
      fake.last().rejectWith(new Error('boom'));
      expect(failed(await handle.result)).toBe('asset_corrupt');
    }
  });
});

describe('packet 26 — disposal, ownership balance and idempotence', () => {
  it('repeated load/reimport/dispose releases owned GPU/CPU/listener resources (allocations == releases)', async () => {
    const store = createVisualResourceStore();
    const fake = createFakePort();
    for (let round = 0; round < 3; round += 1) {
      const bytes = buildGlb({ materials: round + 1 });
      const handle = store.load(suppliedBytes(descriptorFor(bytes, { version: 1 }), bytes), { loader: fake.port });
      fake.last().resolveWith();
      const resource = ready(await handle.result);
      const instance = instanceOf(resource);
      const controller = instance.createPreviewController();
      if (!controller.ok) throw new Error('controller failed');
      controller.controller.play();
      controller.controller.update(0.25);
      controller.controller.setMaterialMode('wireframe');
      expect(store.current(resource.descriptor.assetId)).toBe(resource);
      // Reimport of the same asset supersedes the previous resource.
      instance.dispose();
      store.load(suppliedBytes(descriptorFor(bytes, { version: 2, sourceDigest: 'cd'.repeat(32) }), bytes), { loader: fake.port });
      fake.last().resolveWith();
    }
    store.dispose();
    const report = store.ownership();
    expect(report.allocations).toBeGreaterThan(0);
    expect(report.releases).toBe(report.allocations);
    expect(report.outstanding).toBe(0);
    // Every resource kind that was allocated was fully released.
    for (const kind of ['geometry', 'material', 'texture', 'listener', 'objectUrl', 'instance', 'mixer'] as const) {
      expect(report.byKind[kind].releases).toBe(report.byKind[kind].allocations);
    }
    expect(store.dispose()).toEqual({ ok: true, alreadyDisposed: true });
    expect(store.current('asset-0000000000000001')).toBeNull();
  });

  it('double dispose of the resource, the instance and the controller releases nothing twice', async () => {
    const fake = createFakePort();
    const bytes = buildGlb();
    const handle = prepareVisualResource(suppliedBytes(descriptorFor(bytes), bytes), { loader: fake.port });
    fake.last().resolveWith();
    const resource = ready(await handle.result);
    const instance = instanceOf(resource);
    const controller = instance.createPreviewController();
    if (!controller.ok) throw new Error('controller failed');
    expect(controller.controller.dispose()).toEqual({ ok: true });
    expect(controller.controller.dispose()).toEqual({ ok: true, alreadyDisposed: true });
    expect(instance.dispose()).toEqual({ ok: true });
    expect(instance.dispose()).toEqual({ ok: true, alreadyDisposed: true });
    expect(resource.dispose()).toEqual({ ok: true });
    expect(resource.dispose()).toEqual({ ok: true, alreadyDisposed: true });
    const report = resource.ownership();
    expect(report.releases).toBe(report.allocations);
    expect(report.outstanding).toBe(0);
    expect(fake.stats.loadedDisposed).toBe(1);
    expect(fake.stats.geometryDisposed).toBe(1);
    expect(fake.stats.materialDisposed).toBe(1);
    expect(fake.stats.textureDisposed).toBe(1);
    // A disposed resource hands out no new instance.
    const late = resource.createInstance();
    expect(late.ok).toBe(false);
    if (!late.ok) expect(late.error.code).toBe('asset_disposed');
    expect(resource.diagnostics().state).toBe('disposed');
  });

  it('the screenshot/render path never needs a network fetch (fetch/XHR/WebSocket stubbed to throw)', async () => {
    const throwing = (): never => {
      throw new Error('network access attempted by the three-adapter visual path');
    };
    vi.stubGlobal('fetch', throwing);
    vi.stubGlobal('XMLHttpRequest', throwing);
    vi.stubGlobal('WebSocket', throwing);
    const fake = createFakePort();
    const bytes = buildGlb();
    const handle = prepareVisualResource(suppliedBytes(descriptorFor(bytes), bytes), { loader: fake.port });
    fake.last().resolveWith();
    const resource = ready(await handle.result);
    const instance = instanceOf(resource);
    const controller = instance.createPreviewController();
    if (!controller.ok) throw new Error('controller failed');
    expect(controller.controller.play().ok).toBe(true);
    expect(controller.controller.update(0.1).ok).toBe(true);
    expect(globalThis.fetch).toBe(throwing);
    instance.dispose();
    resource.dispose();
  });
});

describe('packet 26 — store supersession (reimport) semantics', () => {
  it('a newer load for the same asset supersedes a pending one and discards its late completion', async () => {
    const store = createVisualResourceStore();
    const fake = createFakePort();
    const bytes = buildGlb();
    const first = store.load(suppliedBytes(descriptorFor(bytes, { version: 1 }), bytes), { loader: fake.port });
    const second = store.load(suppliedBytes(descriptorFor(bytes, { version: 2 }), bytes), { loader: fake.port });
    expect(first.state()).toBe('stale');
    expect(fake.stats.loadedDisposed).toBe(0);
    // The superseded load completes late: its result is discarded and released.
    fake.records[0]?.resolveWith();
    expect(failed(await first.result)).toBe('asset_load_stale');
    fake.records[1]?.resolveWith();
    const resource = ready(await second.result);
    expect(store.current(resource.descriptor.assetId)).toBe(resource);
    store.dispose();
    const report = store.ownership();
    expect(report.releases).toBe(report.allocations);
    expect(report.outstanding).toBe(0);
  });

  it('a superseded settled resource is retired, and its open instances keep the shared resources alive', async () => {
    const store = createVisualResourceStore();
    const fake = createFakePort();
    const bytes = buildGlb();
    const first = store.load(suppliedBytes(descriptorFor(bytes, { version: 1 }), bytes), { loader: fake.port });
    fake.last().resolveWith();
    const v1 = ready(await first.result);
    const instance = instanceOf(v1);
    const second = store.load(suppliedBytes(descriptorFor(bytes, { version: 2 }), bytes), { loader: fake.port });
    fake.last().resolveWith();
    const v2 = ready(await second.result);
    expect(store.current(v2.descriptor.assetId)).toBe(v2);
    expect(v1.diagnostics().state).toBe('disposed');
    expect(fake.stats.loadedDisposed).toBe(0); // the live instance still holds the shared resources
    instance.dispose();
    expect(fake.stats.loadedDisposed).toBe(1);
    store.dispose();
    expect(store.ownership().outstanding).toBe(0);
  });
});

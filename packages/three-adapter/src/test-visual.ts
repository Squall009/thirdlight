/**
 * Test-only loader-port double for the packet-26 visual-resource tests (NOT
 * part of the public surface — imported only by .test.ts files).
 *
 * It returns REAL three.js objects (BufferGeometry/MeshStandardMaterial/
 * Texture/AnimationClip) so the adapter's ownership ledger counts and disposal
 * accounting are exercised against real three.js types, while the load itself
 * is fully controllable (immediate resolve, deferred resolve, failure,
 * late-after-abort completion).
 */
import * as THREE from 'three';
import {
  visualLoadFailure,
  type AssetVersionDescriptor,
  type GlbLoaderPort,
  type LoadedGlb,
  type VisualLoadFailureReason,
} from './visual';

export interface FakeOwnership {
  readonly geometries: number;
  readonly materials: number;
  readonly textures: number;
  readonly listeners: number;
  readonly objectUrls: number;
}

export interface FakeStats {
  geometryDisposed: number;
  materialDisposed: number;
  textureDisposed: number;
  loadedDisposed: number;
  instanceCreated: number;
}

export interface FakeLoadRecord {
  readonly descriptor: AssetVersionDescriptor;
  readonly bytes: Uint8Array;
  readonly signal: AbortSignal;
  readonly settled: Promise<void>;
  /** Resolve with a fresh synthetic hierarchy (default) or the given parts. */
  resolveWith(parts?: {
    root?: THREE.Object3D;
    animations?: readonly THREE.AnimationClip[];
    ownership?: Partial<FakeOwnership>;
    createInstance?: () => THREE.Object3D;
  }): void;
  rejectWith(error: unknown): void;
}

export interface FakePort {
  readonly port: GlbLoaderPort;
  readonly records: FakeLoadRecord[];
  readonly stats: FakeStats;
  last(): FakeLoadRecord;
}

const DEFAULT_OWNERSHIP: FakeOwnership = { geometries: 1, materials: 1, textures: 1, listeners: 2, objectUrls: 1 };

function syntheticClip(name = 'Spin', duration = 1): THREE.AnimationClip {
  return new THREE.AnimationClip(name, duration, [
    new THREE.QuaternionKeyframeTrack(
      'Rotor.quaternion',
      [0, duration],
      [0, 0, 0, 1, 0, 0, Math.SQRT1_2, Math.SQRT1_2],
    ),
  ]);
}

/** Build a fresh synthetic hierarchy plus its disposal accounting. */
function syntheticGlb(ownership: FakeOwnership, stats: FakeStats, animations: readonly THREE.AnimationClip[]): LoadedGlb {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 1, 0], 3));
  const material = new THREE.MeshStandardMaterial({ color: 0xdd7744 });
  const texture = new THREE.Texture();
  material.map = texture;
  const root = new THREE.Group();
  root.name = 'Main';
  const rotor = new THREE.Object3D();
  rotor.name = 'Rotor';
  rotor.add(new THREE.Mesh(geometry, material));
  root.add(rotor);
  let released = false;
  return {
    root,
    animations,
    createInstance: () => {
      stats.instanceCreated += 1;
      return root.clone(true);
    },
    dispose: () => {
      if (released) return;
      released = true;
      stats.loadedDisposed += 1;
      for (let i = 0; i < ownership.geometries; i += 1) {
        geometry.dispose();
        stats.geometryDisposed += 1;
      }
      for (let i = 0; i < ownership.materials; i += 1) {
        material.dispose();
        stats.materialDisposed += 1;
      }
      for (let i = 0; i < ownership.textures; i += 1) {
        texture.dispose();
        stats.textureDisposed += 1;
      }
    },
    ownership: {
      geometries: ownership.geometries,
      materials: ownership.materials,
      textures: ownership.textures,
      listeners: ownership.listeners,
      objectUrls: ownership.objectUrls,
    },
  };
}

/** A controllable loader port. The caller decides when each load settles. */
export function createFakePort(options: { ownership?: Partial<FakeOwnership>; animations?: readonly THREE.AnimationClip[] } = {}): FakePort {
  const ownership: FakeOwnership = { ...DEFAULT_OWNERSHIP, ...options.ownership };
  const animations = options.animations ?? [syntheticClip()];
  const records: FakeLoadRecord[] = [];
  const stats: FakeStats = {
    geometryDisposed: 0,
    materialDisposed: 0,
    textureDisposed: 0,
    loadedDisposed: 0,
    instanceCreated: 0,
  };
  const port: GlbLoaderPort = {
    load(bytes, loadOptions): Promise<LoadedGlb> {
      let resolve!: (value: LoadedGlb) => void;
      let reject!: (error: unknown) => void;
      let settle!: () => void;
      const promise = new Promise<LoadedGlb>((res, rej) => {
        resolve = res;
        reject = rej;
      });
      const settled = new Promise<void>((res) => {
        settle = res;
      });
      const record: FakeLoadRecord = {
        descriptor: loadOptions.descriptor,
        bytes,
        signal: loadOptions.signal,
        settled,
        resolveWith(parts) {
          const glb = syntheticGlb(
            { ...ownership, ...(parts?.ownership ?? {}) },
            stats,
            parts?.animations ?? animations,
          );
          if (parts?.root !== undefined) {
            return resolve({ ...glb, root: parts.root });
          }
          if (parts?.createInstance !== undefined) {
            return resolve({ ...glb, createInstance: parts.createInstance });
          }
          resolve(glb);
        },
        rejectWith(error) {
          reject(error);
        },
      };
      // `settled` resolves on either outcome without affecting the load promise.
      void promise.then(
        () => settle(),
        () => settle(),
      );
      const result = promise;
      records.push(record);
      void result.catch(() => undefined);
      return result;
    },
  };
  return {
    port,
    records,
    stats,
    last: () => records[records.length - 1] as FakeLoadRecord,
  };
}

/** A structured failure value for the fake port. */
export function fakeFailure(reason: VisualLoadFailureReason, message = 'synthetic loader failure'): unknown {
  return visualLoadFailure(reason, message);
}

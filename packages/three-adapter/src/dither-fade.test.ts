/**
 * The dither fade, on the WGSL three builds (no GPU: the WebGPU backend's
 * node builder runs in Node). The cut-away's fade variants keep the programs
 * they had before the dither became a module of its own (digests recorded
 * then, three r186: a change of three.js changes the text, re-record them
 * from the failure); fades ANDed into one mask share one threshold, so they
 * thin a pixel as the largest of them; a fade's value is a uniform, never a
 * program; variants are made once per source and go with their last holder.
 */
import * as THREE from 'three';
import { MeshStandardNodeMaterial } from 'three/webgpu';
import * as TSL from 'three/tsl';
import { describe, expect, it } from 'vitest';
import type { BlockLayerComponent } from '@thirdlight/runtime';

import { CutawayDrawing } from './block-cutaway-view';
import { andMask, ditherKeep, fadeCopy, fadeVariant, FadeVariants, nodeMaterialCopy, objectFade } from './dither-fade';
import { LIGHT_LAYERS_KEY } from './light-layers';
import { digestOf } from './material-graph';
import { graphDef, libraryScene, litScene, PLAIN_GRAPHS, SHADER_TYPE_MATERIALS, wgslOf, wgslRenderer } from './test-wgsl';

const LAYER: BlockLayerComponent = { cellSize: [1, 1, 1], bounds: { min: [0, 0, 0], max: [4, 4, 4] }, cutaway: { regions: [{ region: 'roof' }] } };

/** The cut-away's fade variant programs, as the cut-away built them with its own dither. */
const CUTAWAY_FADE_WGSL: Readonly<Record<string, string>> = {
  standard: '261b04d33ab74140',
  textured: '7a854a7b174b4545',
  blended: 'd2d9c895ae425abb',
  foliage: '2d12f691c67f0cb2',
  kit: 'ebc9eeb5d658504a',
  water: 'dcba6a50d68dd17f',
  unlit: 'be8b2e98cadf7608',
  trim: '960c54b12223f561',
  'graph-plain': 'aff1f297436c8757',
  'graph-tinted': 'bf26be093ff0e6de',
  'graph-everySlot': 'b1c118d25813fedd',
  'graph-unlit': '6b3bd6f0dc0ac90a',
  'graph-customLit': '613e4cff933b4c93',
  classicStandard: '261b04d33ab74140',
  classicLambert: 'b4cfc67e2ca19184',
  classicBasic: '8fa19ec0464a5d8b',
};

/** The cut-away's fade variant of each mesh's material (the one its precompile probe wears). */
function cutawayProbes(meshes: Record<string, THREE.Mesh>): Record<string, THREE.Mesh> {
  const probes: THREE.Object3D[] = [];
  const cut = new CutawayDrawing({ precompile: (o) => probes.push(o) });
  cut.setLayer('L', LAYER, new Map([['roof', [[0, 0, 0, 4, 4, 4]]]]), [0, 0, 0]);
  const out: Record<string, THREE.Mesh> = {};
  for (const [id, mesh] of Object.entries(meshes)) {
    probes.length = 0;
    cut.register('L', id, [{ mesh, zones: [0] }]);
    out[id] = probes[0] as THREE.Mesh;
  }
  return out;
}

/** The fragment stage of a mesh's WGSL. */
const fragmentOf = (wgsl: string): string => wgsl.slice(wgsl.indexOf('@fragment'));

describe('the cut-away fade variants', () => {
  it('build the programs they built before the dither moved to its own module, on every material kind', async () => {
    const defs = [...SHADER_TYPE_MATERIALS, ...Object.entries(PLAIN_GRAPHS).map(([id, g]) => graphDef(`graph-${id}`, g))];
    const { scene, meshes } = await libraryScene(defs);
    const geo = new THREE.SphereGeometry(1, 8, 6);
    for (const [id, m] of [['classicStandard', new THREE.MeshStandardMaterial({ color: '#808080' })], ['classicLambert', new THREE.MeshLambertMaterial()], ['classicBasic', new THREE.MeshBasicMaterial()]] as const) {
      const mesh = new THREE.Mesh(geo, m);
      scene.add(mesh);
      meshes[id] = mesh;
    }
    const renderer = wgslRenderer();
    const now: Record<string, string> = {};
    for (const [id, probe] of Object.entries(cutawayProbes(meshes))) {
      expect(probe.userData.__tlCutawayFade).toBe(1);
      scene.add(probe);
      const wgsl = wgslOf(renderer, scene, probe);
      expect(fragmentOf(wgsl)).toContain('discard');
      now[id] = digestOf(wgsl);
    }
    expect(now).toEqual(CUTAWAY_FADE_WGSL);
  });
});

describe('fades in one mask', () => {
  it('share one threshold, so two fades thin a pixel as the larger of them; the material keeps its own mask', () => {
    const m = new MeshStandardNodeMaterial();
    (m as unknown as { maskNode: unknown }).maskNode = TSL.uniform(1).greaterThan(0.5);
    andMask(m, ditherKeep(objectFade('__a')));
    andMask(m, ditherKeep(objectFade('__b')));
    const scene = litScene();
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 8, 6), m);
    scene.add(mesh);
    const frag = fragmentOf(wgslOf(wgslRenderer(), scene, mesh));
    // The noise is computed once, and both fades compare with that one value inside the one discard test.
    expect(frag.match(/52\.9829189/g)).toHaveLength(1);
    const v = /(nodeVar\d+) = fract\( \( 52\.9829189/.exec(frag)![1]!;
    const tests = [...frag.matchAll(new RegExp(`${v} >= object\\.(nodeUniform\\d+)`, 'g'))].map((x) => x[1]);
    expect(new Set(tests).size).toBe(2);
    expect(frag.match(/discard;/g)).toHaveLength(1);
    // The material's own mask is still part of that test.
    expect(frag).toMatch(/object\.nodeUniform\d+ > 0\.5 \) && /);
  });

  it('a fade value is a uniform read per draw: objects fading by different amounts share one program', () => {
    const fade = objectFade('__f');
    expect((fade as { updateType: string }).updateType).toBe('object');
    const m = new MeshStandardNodeMaterial();
    andMask(m, ditherKeep(fade));
    const scene = litScene();
    const geo = new THREE.SphereGeometry(1, 8, 6);
    const renderer = wgslRenderer();
    const digests = [0, 0.4, 1].map((f) => {
      const mesh = new THREE.Mesh(geo, m);
      mesh.userData.__f = f;
      scene.add(mesh);
      return digestOf(wgslOf(renderer, scene, mesh));
    });
    expect(new Set(digests).size).toBe(1);
  });
});

describe('fade variants', () => {
  it('a classic material becomes the node class three draws it with, every field carried; a material with no node class cannot fade', () => {
    const map = new THREE.Texture();
    const src = new THREE.MeshLambertMaterial({ color: '#ff8000', map, transparent: true, opacity: 0.5 });
    src.userData.tag = 1;
    const v = fadeVariant(src, ditherKeep(objectFade('__x')), 'test fade')!;
    expect(v.type).toBe('MeshLambertNodeMaterial');
    expect((v as unknown as THREE.MeshLambertMaterial).color.getHexString()).toBe('ff8000');
    expect((v as unknown as THREE.MeshLambertMaterial).map).toBe(map);
    expect([v.transparent, v.opacity, v.name]).toEqual([true, 0.5, ' (test fade)']);
    expect(v.uuid).not.toBe(src.uuid);
    expect(v.userData).toEqual({ tag: 1 });
    expect(v.userData).not.toBe(src.userData);
    expect(nodeMaterialCopy(new THREE.LineBasicMaterial())).toBeNull();
    expect(nodeMaterialCopy(new THREE.ShaderMaterial())).toBeNull();
  });

  it('are made once per source, again only after the source changed, and disposed with their last holder', () => {
    let made = 0;
    const variants = new FadeVariants<string>((src) => {
      made += 1;
      return fadeVariant(src, ditherKeep(objectFade('__x')), 'fade');
    });
    const a = new MeshStandardNodeMaterial();
    const b = new THREE.MeshBasicMaterial();
    const first = variants.hold('m1', a);
    expect(first.made).toBe(true);
    expect(variants.hold('m2', a)).toEqual({ variant: first.variant, made: false });
    expect(variants.hold('m1', a).made).toBe(false);
    expect(made).toBe(1);
    let disposed = 0;
    first.variant!.addEventListener('dispose', () => (disposed += 1));
    // m1 moves to another material: the first variant stays for m2.
    variants.hold('m1', b);
    expect([variants.size, disposed]).toEqual([2, 0]);
    // The source changed: its variant is made again (the old one let go).
    a.needsUpdate = true;
    const remade = variants.hold('m2', a);
    expect(remade.made).toBe(true);
    expect(remade.variant).not.toBe(first.variant);
    expect(disposed).toBe(1);
    variants.release('m2');
    variants.release('m2');
    expect(variants.size).toBe(1);
    variants.dispose();
    expect(variants.size).toBe(0);
  });

  it('a fade copy draws the mesh where it is, lit as it is, casting no shadow', () => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial());
    mesh.position.set(1, 2, 3);
    mesh.updateMatrixWorld();
    mesh.castShadow = mesh.receiveShadow = true;
    mesh.userData[LIGHT_LAYERS_KEY] = 6;
    const variant = new MeshStandardNodeMaterial();
    const copy = fadeCopy(mesh, variant, 'c');
    expect(copy.geometry).toBe(mesh.geometry);
    expect(copy.material).toBe(variant);
    expect([copy.castShadow, copy.receiveShadow, copy.userData[LIGHT_LAYERS_KEY]]).toEqual([false, true, 6]);
    expect(copy.matrixWorld.equals(mesh.matrixWorld)).toBe(true);
  });
});

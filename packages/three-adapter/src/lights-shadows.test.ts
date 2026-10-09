/**
 * The key light's cached shadow when the key light changes: only the key
 * light's map hears of the static casters' changes, so a sun that becomes the
 * key light again (an additive scene with its own sun unloaded, its sun
 * hidden) draws its static map again instead of reusing what it held.
 *
 * Point and spot lights on a page whose rooms come and go: realized as
 * layered lights once, when the first rooms arrive, and kept so when the
 * rooms go (realizing them again would rebuild every lit program).
 */
import * as THREE from 'three/webgpu';
import { describe, expect, it } from 'vitest';

import { isLayeredLight } from './light-layers';
import { createSceneLights } from './lights-shadows';
import { StaticShadowRevision } from './shadow-casters';

describe('the key light', () => {
  it('a sun becoming the key light again draws its static shadow map again', () => {
    const scene = new THREE.Scene();
    const lights = createSceneLights({
      scene,
      v3: true,
      startView: [0, 2, 6],
      resources: {} as never,
      loadCookie: null,
      bakedLight: () => false,
      place: () => undefined,
      shadingChanged: () => undefined,
      tagBits: new Map(),
      staticShadows: new StaticShadowRevision(),
    });
    const sun = (id: string) => ({ id, components: { light: { type: 'directional', color: '#ffffff', intensity: 1, direction: [0.5, -1, 0.4], castShadow: true } } });
    lights.realize(sun('sun-a'));
    lights.realize(sun('sun-b'));
    const nodeOf = (light: THREE.Object3D): { staticDirty: boolean } => (light as THREE.DirectionalLight).shadow.shadowNode as never;
    const [a] = scene.children.filter((c): c is THREE.DirectionalLight => (c as THREE.DirectionalLight).isDirectionalLight === true);
    expect(nodeOf(a!)).toBeDefined();
    // Sun A is key (B's scene ranks below it); its map was drawn.
    const rank = (top: string) => (id: string) => (id === top ? 1 : 0);
    lights.select(rank('sun-a'), new Set());
    expect(lights.keyDirection()).toBeDefined();
    nodeOf(a!).staticDirty = false;
    // B's scene comes in above: B is key; then it unloads (B hidden) and A is key again.
    lights.select(rank('sun-b'), new Set());
    expect(a!.visible).toBe(false);
    lights.select(rank('sun-a'), new Set(['sun-b']));
    expect(a!.visible).toBe(true);
    expect(nodeOf(a!).staticDirty, "A's map saw none of the changes made while B was key").toBe(true);
    lights.dispose();
  });
});

describe('room-bound lights', () => {
  it('stay the same layered lights when the rooms go and come back', () => {
    const placed = new Map<string, THREE.Light>();
    const lights = createSceneLights({
      scene: new THREE.Scene(),
      v3: true,
      startView: [0, 2, 6],
      resources: {} as never,
      loadCookie: null,
      bakedLight: () => false,
      place: (id, light) => void placed.set(id, light),
      shadingChanged: () => undefined,
      tagBits: new Map(),
      staticShadows: null,
    });
    lights.realize({ id: 'lamp', components: { light: { type: 'point', color: '#ffffff', intensity: 1, range: 4 } } });
    lights.select(() => 0, new Set());
    expect(isLayeredLight(placed.get('lamp'))).toBe(false);
    lights.setRoomLights(true);
    const layered = placed.get('lamp')!;
    expect(isLayeredLight(layered)).toBe(true);
    lights.setRoomLights(false);
    lights.setRoomLights(true);
    expect(placed.get('lamp'), 'not realized again').toBe(layered);
    // A light realized while there are no rooms any more is layered too (the page had rooms).
    lights.setRoomLights(false);
    lights.realize({ id: 'lamp-2', components: { light: { type: 'spot', color: '#ffffff', intensity: 1, range: 4 } } });
    expect(isLayeredLight(placed.get('lamp-2'))).toBe(true);
    lights.dispose();
  });
});

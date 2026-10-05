/**
 * A dump of what a page drew last frame, so the plain three.js page
 * (tools/perf/bare/) can draw the same content: every visible mesh's
 * geometry (byte-identical vertex data), its material's values, its world
 * matrix (instanced sets with their copies), the lights with the sun's
 * shadow setup, fog and the camera. Read through the frame probe
 * (frame-probe.ts), so it works on any three page; the binary part is
 * PUT to `<origin>/__dump/scene.bin` and the description to
 * `/__dump/scene.json` (the measuring server writes them out).
 *
 * Materials record what makes them more than plain values (their type,
 * the node slots set, hooks of their own) so the per-draw ablation can
 * tell three's default materials from the engine's.
 *
 * Serialized into the page: it must not close over anything.
 */

export interface DumpSummary {
  geos: number;
  mats: number;
  items: number;
  instanced: number;
  bytes: number;
  lights: number;
}

export async function dumpScene(): Promise<DumpSummary | string> {
  type V = { x: number; y: number; z: number };
  type Attr = { array: ArrayLike<number> & { buffer: ArrayBufferLike; byteOffset: number; byteLength: number; constructor: { name: string } }; itemSize: number; normalized: boolean; count: number; isInterleavedBufferAttribute?: boolean; getComponent(i: number, k: number): number };
  type Geo = { uuid: string; attributes: Record<string, Attr | undefined>; index: Attr | null; groups: unknown; drawRange: unknown; instanceCount?: number };
  type Mat = Record<string, unknown> & { uuid: string; type: string; name: string; color?: { getHex(): number }; emissive?: { getHex(): number }; map?: { name?: string; image?: { width: number; height: number } } | null };
  type Obj = { isScene?: boolean; isMesh?: boolean; isLight?: boolean; isSkinnedMesh?: boolean; isInstancedMesh?: boolean; isOrthographicCamera?: boolean; isPerspectiveCamera?: boolean; type: string; name: string; visible: boolean; parent: Obj | null; children: Obj[]; layers: { mask: number; test(l: unknown): boolean }; castShadow: boolean; receiveShadow: boolean; frustumCulled: boolean; geometry: Geo; material: Mat | Mat[]; matrixWorld: { elements: number[] }; userData: Record<string, unknown>; count?: number; instanceMatrix?: { array: Float32Array }; color?: { getHex(): number }; intensity?: number; distance?: number; decay?: number; target?: Obj; shadow?: { mapSize: { x: number; y: number }; camera: Obj & { left: number; right: number; top: number; bottom: number; near: number; far: number }; bias: number; normalBias: number; autoUpdate: boolean }; getWorldPosition(v: V): V; position: V & { clone(): V & { toArray(): number[] } }; fov?: number; near?: number; far?: number; aspect?: number; updateMatrixWorld(force?: boolean): void; traverse(fn: (o: Obj) => void): void; fog?: { constructor: { name: string }; color: { getHex(): number }; density?: number; near?: number; far?: number } | null; background?: unknown; environment?: unknown };
  const P = (window as unknown as { __tlProbe?: { lastScenes: Map<unknown, unknown>; renderers: { toneMapping?: number; toneMappingExposure?: number; shadowMap?: { type?: number }; getPixelRatio?: () => number }[] } }).__tlProbe;
  if (P === undefined) return 'no frame probe';
  // The scene with the most objects drawn last frame, with its view camera.
  let scene: Obj | null = null;
  let camera: Obj | null = null;
  let best = -1;
  for (const [s, c] of P.lastScenes) {
    const o = s as Obj;
    if (o?.isScene !== true) continue;
    let n = 0;
    o.traverse(() => (n += 1));
    if (n > best) {
      best = n;
      scene = o;
      camera = c as Obj;
    }
  }
  if (scene === null || camera === null) return 'no scene drawn';
  scene.updateMatrixWorld(true);
  const visible = (o: Obj): boolean => {
    for (let p: Obj | null = o; p !== null; p = p.parent) if (!p.visible) return false;
    return true;
  };
  const chunks: Uint8Array[] = [];
  let offset = 0;
  const put = (typed: { buffer: ArrayBufferLike; byteOffset: number; byteLength: number }): number => {
    const b = new Uint8Array(typed.buffer, typed.byteOffset, typed.byteLength).slice();
    const pad = (4 - (b.byteLength % 4)) % 4;
    chunks.push(b);
    if (pad > 0) chunks.push(new Uint8Array(pad));
    const at = offset;
    offset += b.byteLength + pad;
    return at;
  };
  const geos = new Map<string, Record<string, unknown> & { id: number }>();
  const mats = new Map<string, Record<string, unknown> & { id: number }>();
  const geoOf = (g: Geo): number => {
    const known = geos.get(g.uuid);
    if (known !== undefined) return known.id;
    const e: Record<string, unknown> & { id: number } = { id: geos.size, attrs: {}, index: null };
    for (const name of ['position', 'normal', 'uv', 'uv1', 'color', 'tangent', 'skinIndex', 'skinWeight']) {
      const a = g.attributes[name];
      if (a === undefined) continue;
      let arr: { buffer: ArrayBufferLike; byteOffset: number; byteLength: number; length: number; constructor: { name: string } } = a.array as never;
      if (a.isInterleavedBufferAttribute === true) {
        const out = new Float32Array(a.count * a.itemSize);
        for (let i = 0; i < a.count; i += 1) for (let k = 0; k < a.itemSize; k += 1) out[i * a.itemSize + k] = a.getComponent(i, k);
        arr = out;
      }
      (e['attrs'] as Record<string, unknown>)[name] = { at: put(arr), type: arr.constructor.name, count: arr.length, itemSize: a.itemSize, normalized: a.normalized };
    }
    if (g.index !== null) e['index'] = { at: put(g.index.array), type: g.index.array.constructor.name, count: (g.index.array as ArrayLike<number>).length };
    e['groups'] = g.groups;
    e['drawRange'] = g.drawRange;
    geos.set(g.uuid, e);
    return e.id;
  };
  const matOf = (m: Mat): number => {
    const known = mats.get(m.uuid);
    if (known !== undefined) return known.id;
    const nodes = Object.keys(m).filter((k) => k.endsWith('Node') && m[k] !== null && m[k] !== undefined);
    const hooks = Object.keys(m).filter((k) => typeof m[k] === 'function');
    const maps = ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'emissiveMap', 'aoMap', 'lightMap', 'alphaMap', 'envMap'].filter((k) => m[k] !== null && m[k] !== undefined);
    const e = {
      id: mats.size,
      type: m.type,
      name: m.name,
      node: m['isNodeMaterial'] === true,
      nodes,
      hooks,
      maps,
      color: m.color?.getHex() ?? 0xffffff,
      roughness: (m['roughness'] as number | undefined) ?? 1,
      metalness: (m['metalness'] as number | undefined) ?? 0,
      emissive: m.emissive?.getHex() ?? 0,
      emissiveIntensity: (m['emissiveIntensity'] as number | undefined) ?? 1,
      map: m.map !== null && m.map !== undefined,
      mapSize: m.map?.image !== undefined ? [m.map.image.width, m.map.image.height] : null,
      normalMap: m['normalMap'] !== null && m['normalMap'] !== undefined,
      transparent: m['transparent'] === true,
      opacity: (m['opacity'] as number | undefined) ?? 1,
      alphaTest: (m['alphaTest'] as number | undefined) ?? 0,
      side: (m['side'] as number | undefined) ?? 0,
      vertexColors: m['vertexColors'] === true,
      flatShading: m['flatShading'] === true,
      depthWrite: m['depthWrite'] !== false,
      blending: (m['blending'] as number | undefined) ?? 1,
    };
    mats.set(m.uuid, e);
    return e.id;
  };
  const items: Record<string, unknown>[] = [];
  const lights: Record<string, unknown>[] = [];
  const BATCH_LAYER = 1 << 30;
  const visit = (o: Obj): void => {
    // The effect light pool is one object: its slots in use are point lights to a plain page.
    const pool = o as unknown as { isEffectLights?: boolean; count: number; slots: { position: V & { toArray(): number[] }; color: { getHex(): number }; intensity: number; distance: number; decay: number }[] };
    if (pool.isEffectLights === true) {
      for (const sl of pool.slots.slice(0, pool.count)) {
        const pos = sl.position.toArray();
        lights.push({ type: 'PointLight', color: sl.color.getHex(), intensity: sl.intensity, visible: visible(o), castShadow: false, distance: sl.distance, decay: sl.decay, pos, target: null, shadow: null });
      }
      return;
    }
    if (o.isLight === true) {
      const wp = o.getWorldPosition(o.position.clone());
      const tp = o.target !== undefined ? o.target.getWorldPosition(o.position.clone()) : null;
      lights.push({
        type: o.type,
        color: o.color?.getHex() ?? 0xffffff,
        intensity: o.intensity ?? 1,
        visible: visible(o),
        castShadow: o.castShadow,
        distance: o.distance ?? 0,
        decay: o.decay ?? 2,
        pos: [wp.x, wp.y, wp.z],
        target: tp === null ? null : [tp.x, tp.y, tp.z],
        shadow: o.shadow !== undefined ? { mapSize: [o.shadow.mapSize.x, o.shadow.mapSize.y], cam: o.shadow.camera.isOrthographicCamera === true ? [o.shadow.camera.left, o.shadow.camera.right, o.shadow.camera.top, o.shadow.camera.bottom, o.shadow.camera.near, o.shadow.camera.far] : null, bias: o.shadow.bias, normalBias: o.shadow.normalBias, autoUpdate: o.shadow.autoUpdate } : null,
      });
      return;
    }
    if (o.isMesh !== true || o.userData['tlBatch'] !== undefined || !visible(o)) return;
    // Meshes the batcher draws are on its layer instead of the camera's: they are drawn too.
    const batched = (o.layers.mask & BATCH_LAYER) !== 0;
    if (!o.layers.test((camera as unknown as { layers: unknown }).layers) && !batched) return;
    const ms = Array.isArray(o.material) ? o.material : [o.material];
    const it: Record<string, unknown> = { g: geoOf(o.geometry), m: matOf(ms[0]!), multiMat: ms.length > 1 ? ms.length : 0, mw: Array.from(o.matrixWorld.elements), cast: o.castShadow, recv: o.receiveShadow, batched, skinned: o.isSkinnedMesh === true, name: o.name, frustumCulled: o.frustumCulled };
    const g = o.geometry;
    if (o.isInstancedMesh === true && o.instanceMatrix !== undefined) {
      const n = o.count ?? 0;
      it['inst'] = { at: put(o.instanceMatrix.array.subarray(0, n * 16)), count: n };
    } else if (g.attributes['tlInstanceMatrix0'] !== undefined) {
      // The engine's attribute instancing: four vec4 columns per copy.
      const col0 = g.attributes['tlInstanceMatrix0']!;
      const n = g.instanceCount === undefined || g.instanceCount === Infinity ? col0.count : g.instanceCount;
      const arr = new Float32Array(n * 16);
      for (let i = 0; i < n; i += 1) for (let c = 0; c < 4; c += 1) for (let r = 0; r < 4; r += 1) arr[i * 16 + c * 4 + r] = g.attributes[`tlInstanceMatrix${c}`]!.getComponent(i, r);
      it['inst'] = { at: put(arr), count: n };
    }
    items.push(it);
  };
  scene.traverse(visit);
  // Drawables the engine draws through its batches are parked outside the scene's children: drawn too.
  for (const p of (scene.userData['tlParked'] as Iterable<Obj> | undefined) ?? []) p.traverse(visit);
  const r = P.renderers[P.renderers.length - 1];
  const origin = location.origin;
  const bin = new Blob(chunks as BlobPart[]);
  const okBin = await fetch(`${origin}/__dump/scene.bin`, { method: 'PUT', body: bin });
  const fog = scene.fog ?? null;
  const meta = {
    camera: { mw: Array.from(camera.matrixWorld.elements), fov: camera.fov ?? 50, near: camera.near ?? 0.1, far: camera.far ?? 1000, aspect: camera.aspect ?? 1 },
    geos: [...geos.values()],
    mats: [...mats.values()],
    items,
    lights,
    toneMapping: r?.toneMapping ?? 0,
    exposure: r?.toneMappingExposure ?? 1,
    shadowType: r?.shadowMap?.type ?? null,
    pixelRatio: r?.getPixelRatio?.() ?? 1,
    environment: scene.environment !== null && scene.environment !== undefined,
    fog: fog === null ? null : { type: fog.constructor.name, color: fog.color.getHex(), density: fog.density ?? null, near: fog.near ?? null, far: fog.far ?? null },
    bytes: offset,
  };
  const okMeta = await fetch(`${origin}/__dump/scene.json`, { method: 'PUT', body: JSON.stringify(meta) });
  if (!okBin.ok || !okMeta.ok) return `dump upload failed (${okBin.status}/${okMeta.status})`;
  return { geos: geos.size, mats: mats.size, items: items.length, instanced: items.filter((i) => i['inst'] !== undefined).length, bytes: offset, lights: lights.length };
}

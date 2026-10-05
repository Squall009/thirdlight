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
 * So the plain page draws the same content, not a stand-in for it:
 * - every texture a material samples, as the GPU has it: a compressed
 *   texture's mip levels in their GPU format (the KTX2 transcode), a data
 *   texture's texels, an image as a PNG (`/__dump/tex-<id>.png`), with its
 *   sampler and UV transform;
 * - the background (a colour or a texture) and the environment lighting:
 *   the PMREM texture the scene shades with, read back from the GPU, and its
 *   intensity;
 * - skinned meshes with their skeletons and the motion they played: each
 *   bone's local pose sampled over `SKIN_SAMPLE_FRAMES` drawn frames, so the
 *   page plays it back through three's own mixer.
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
  textures: number;
  skeletons: number;
  environment: boolean;
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
  // Textures by uuid; images are encoded as PNG after the walk (async).
  type Tex = Record<string, unknown> & { uuid: string; name: string; image: unknown; mipmaps?: { data: ArrayLike<number> & { buffer: ArrayBufferLike; byteOffset: number; byteLength: number; constructor: { name: string } }; width: number; height: number }[]; isCompressedTexture?: boolean; isDataTexture?: boolean; isRenderTargetTexture?: boolean; renderTarget?: unknown; offset: V & { toArray(): number[] }; repeat: { toArray(): number[] }; center: { toArray(): number[] }; rotation: number };
  const texs = new Map<string, Record<string, unknown> & { id: number }>();
  const images: { id: number; image: unknown }[] = [];
  const texOf = (t: Tex | null | undefined): number | null => {
    if (t === null || t === undefined || t.image === undefined || t.image === null) return null;
    const known = texs.get(t.uuid);
    if (known !== undefined) return known.id;
    const e: Record<string, unknown> & { id: number } = {
      id: texs.size,
      name: t.name,
      sampler: { wrapS: t['wrapS'], wrapT: t['wrapT'], magFilter: t['magFilter'], minFilter: t['minFilter'], anisotropy: t['anisotropy'], generateMipmaps: t['generateMipmaps'] },
      colorSpace: t['colorSpace'],
      flipY: t['flipY'],
      premultiplyAlpha: t['premultiplyAlpha'],
      mapping: t['mapping'],
      channel: t['channel'],
      format: t['format'],
      type: t['type'],
      uv: { offset: t.offset.toArray(), repeat: t.repeat.toArray(), center: t.center.toArray(), rotation: t.rotation },
    };
    const img = t.image as { data?: ArrayLike<number> & { buffer: ArrayBufferLike; byteOffset: number; byteLength: number; constructor: { name: string } }; width?: number; height?: number };
    const putMips = (): unknown[] => (t.mipmaps ?? []).map((m) => ({ at: put(m.data), type: m.data.constructor.name, count: m.data.length, width: m.width, height: m.height }));
    if (t.isRenderTargetTexture === true) e['kind'] = 'render-target';
    else if (t.isCompressedTexture === true) {
      e['kind'] = 'compressed';
      e['width'] = img.width;
      e['height'] = img.height;
      e['mips'] = putMips();
    } else if (img.data !== undefined) {
      e['kind'] = 'data';
      e['width'] = img.width;
      e['height'] = img.height;
      e['data'] = { at: put(img.data), type: img.data.constructor.name, count: img.data.length };
      e['mips'] = putMips();
    } else if ((img.width ?? 0) > 0) {
      e['kind'] = 'image';
      e['width'] = img.width;
      e['height'] = img.height;
      e['file'] = `tex-${e.id}.png`;
      images.push({ id: e.id, image: img });
    } else e['kind'] = 'none';
    texs.set(t.uuid, e);
    return e.id;
  };
  const MAP_SLOTS = ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'emissiveMap', 'aoMap', 'lightMap', 'alphaMap', 'bumpMap', 'displacementMap', 'envMap', 'specularMap'];
  const matOf = (m: Mat): number => {
    const known = mats.get(m.uuid);
    if (known !== undefined) return known.id;
    const nodes = Object.keys(m).filter((k) => k.endsWith('Node') && m[k] !== null && m[k] !== undefined);
    const hooks = Object.keys(m).filter((k) => typeof m[k] === 'function');
    const maps = MAP_SLOTS.filter((k) => m[k] !== null && m[k] !== undefined);
    const textures: Record<string, number> = {};
    for (const k of maps) {
      const id = texOf(m[k] as Tex);
      if (id !== null) textures[k] = id;
    }
    // A node material's slots: the textures each one samples and its node count, so the plain page can draw
    // the same textures through plain map slots (what a hand-written page has for a graph's look).
    type Nd = { isTextureNode?: boolean; value?: Tex; getChildren?(): Iterable<Nd> };
    const nodeMaps: Record<string, number[]> = {};
    let nodeCount = 0;
    for (const k of nodes) {
      const seen = new Set<Nd>();
      const ids: number[] = [];
      const walk = (n: Nd): void => {
        if (seen.has(n)) return;
        seen.add(n);
        if (n.isTextureNode === true && (n.value as { isTexture?: boolean } | undefined)?.isTexture === true) {
          const id = texOf(n.value);
          if (id !== null && !ids.includes(id)) ids.push(id);
        }
        for (const c of n.getChildren?.() ?? []) walk(c);
      };
      walk(m[k] as Nd);
      nodeCount += seen.size;
      if (ids.length > 0) nodeMaps[k] = ids;
    }
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
      textures,
      nodeMaps,
      nodeCount,
      normalScale: (m['normalScale'] as { toArray(): number[] } | undefined)?.toArray() ?? null,
      normalMapType: m['normalMapType'] ?? 0,
      aoMapIntensity: m['aoMapIntensity'] ?? 1,
      lightMapIntensity: m['lightMapIntensity'] ?? 1,
      envMapIntensity: m['envMapIntensity'] ?? 1,
      fog: m['fog'] !== false,
      toneMapped: m['toneMapped'] !== false,
      shadowSide: m['shadowSide'] ?? null,
    };
    mats.set(m.uuid, e);
    return e.id;
  };
  // Skeletons by uuid: the bones (a parent index among them, -1 for a root) and their bind inverses; the
  // poses are sampled after the walk. A root bone's pose is its world matrix (what holds it is not drawn).
  type M4 = { elements: number[]; copy(m: M4): M4; invert(): M4; multiply(m: M4): M4; clone(): M4 };
  type Bone = { uuid: string; name: string; parent: Bone | null; matrixWorld: M4 };
  type Skinned = { skeleton: { uuid: string; bones: Bone[]; boneInverses: M4[] }; bindMatrix: M4; bindMode: string };
  const skels = new Map<string, Record<string, unknown> & { id: number; bones: Bone[] }>();
  const skinOf = (o: Skinned): Record<string, unknown> => {
    let sk = skels.get(o.skeleton.uuid);
    if (sk === undefined) {
      const bones = o.skeleton.bones;
      const index = new Map(bones.map((b, i) => [b, i]));
      sk = { id: skels.size, bones, parents: bones.map((b) => (b.parent !== null ? (index.get(b.parent) ?? -1) : -1)), names: bones.map((b) => b.name), inverses: o.skeleton.boneInverses.map((m) => Array.from(m.elements)) };
      skels.set(o.skeleton.uuid, sk);
    }
    return { skeleton: sk.id, bindMatrix: Array.from(o.bindMatrix.elements), bindMode: o.bindMode };
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
    if (o.isSkinnedMesh === true) it['skin'] = skinOf(o as unknown as Skinned);
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
  const r = P.renderers[P.renderers.length - 1] as unknown as { readRenderTargetPixelsAsync?(rt: unknown, x: number, y: number, w: number, h: number): Promise<ArrayLike<number> & { buffer: ArrayBufferLike; byteOffset: number; byteLength: number; constructor: { name: string } }> } & (typeof P.renderers)[number] | undefined;
  const origin = location.origin;

  // Bone poses over the next drawn frames: local to the parent bone (a root's is its world matrix).
  const SKIN_SAMPLE_FRAMES = 60;
  const t0 = performance.now();
  const times: number[] = [];
  const poses = new Map<number, number[][]>();
  for (let f = 0; f < SKIN_SAMPLE_FRAMES && skels.size > 0; f += 1) {
    await new Promise((res) => requestAnimationFrame(res));
    times.push((performance.now() - t0) / 1000);
    for (const sk of skels.values()) {
      const frame: number[] = [];
      for (const b of sk.bones) {
        const parent = b.parent !== null && sk.bones.includes(b.parent) ? b.parent : null;
        const local = parent === null ? b.matrixWorld.clone() : parent.matrixWorld.clone().invert().multiply(b.matrixWorld);
        frame.push(...local.elements);
      }
      const list = poses.get(sk.id) ?? [];
      list.push(frame);
      poses.set(sk.id, list);
    }
  }
  const skeletons = [...skels.values()].map((sk) => {
    const list = poses.get(sk.id) ?? [];
    const flat = new Float32Array(list.length * sk.bones.length * 16);
    list.forEach((fr, i) => flat.set(fr, i * sk.bones.length * 16));
    return { id: sk.id, parents: sk['parents'], names: sk['names'], inverses: sk['inverses'], frames: list.length, poses: { at: put(flat), count: flat.length } };
  });

  // The background, and the environment the scene shades with (a PMREM render target: read back).
  type Sc = { background?: { isColor?: boolean; isTexture?: boolean; getHex?(): number } | null; environment?: Tex | null; environmentIntensity?: number; backgroundIntensity?: number; backgroundBlurriness?: number };
  const sc = scene as unknown as Sc;
  const bg = sc.background ?? null;
  const background = bg === null ? null : bg.isColor === true ? { color: bg.getHex!() } : bg.isTexture === true ? { texture: texOf(bg as unknown as Tex) } : null;
  let environment: Record<string, unknown> | null = null;
  const env = sc.environment ?? null;
  if (env !== null) {
    const rt = env.renderTarget as { width: number; height: number } | null | undefined;
    if (env.isRenderTargetTexture === true && rt !== null && rt !== undefined && r?.readRenderTargetPixelsAsync !== undefined) {
      const px = await r.readRenderTargetPixelsAsync(rt, 0, 0, rt.width, rt.height);
      // Rows come padded to 256 bytes (WebGPU's copy alignment): keep each row's texels only.
      const texel = { Uint16Array: 8, Float32Array: 16, Uint8Array: 4 }[px.constructor.name] ?? 8;
      const tight = new Uint8Array(rt.width * rt.height * texel);
      const src = new Uint8Array(px.buffer, px.byteOffset, px.byteLength);
      const stride = Math.ceil((rt.width * texel) / 256) * 256;
      for (let y = 0; y < rt.height; y += 1) tight.set(src.subarray(y * stride, y * stride + rt.width * texel), y * rt.width * texel);
      environment = { kind: 'pmrem', width: rt.width, height: rt.height, type: px.constructor.name, at: put(tight), bytes: tight.byteLength, intensity: sc.environmentIntensity ?? 1 };
    } else environment = { kind: 'texture', texture: texOf(env), intensity: sc.environmentIntensity ?? 1 };
  }

  // Images as PNG files beside the dump.
  const pngFailures: string[] = [];
  for (const { id, image } of images) {
    const im = image as { width: number; height: number };
    try {
      const c = new OffscreenCanvas(im.width, im.height);
      const ctx = c.getContext('2d')!;
      ctx.drawImage(image as CanvasImageSource, 0, 0);
      const blob = await c.convertToBlob({ type: 'image/png' });
      const ok = await fetch(`${origin}/__dump/tex-${id}.png`, { method: 'PUT', body: blob });
      if (!ok.ok) pngFailures.push(`tex-${id}: ${ok.status}`);
    } catch (e) {
      pngFailures.push(`tex-${id}: ${String(e)}`);
    }
  }

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
    environment,
    background,
    backgroundIntensity: sc.backgroundIntensity ?? 1,
    backgroundBlurriness: sc.backgroundBlurriness ?? 0,
    textures: [...texs.values()],
    skeletons,
    skinTimes: times,
    pngFailures,
    fog: fog === null ? null : { type: fog.constructor.name, color: fog.color.getHex(), density: fog.density ?? null, near: fog.near ?? null, far: fog.far ?? null },
    bytes: offset,
  };
  const okMeta = await fetch(`${origin}/__dump/scene.json`, { method: 'PUT', body: JSON.stringify(meta) });
  if (!okBin.ok || !okMeta.ok) return `dump upload failed (${okBin.status}/${okMeta.status})`;
  return { geos: geos.size, mats: mats.size, items: items.length, instanced: items.filter((i) => i['inst'] !== undefined).length, bytes: offset, lights: lights.length, textures: texs.size, skeletons: skels.size, environment: environment !== null };
}

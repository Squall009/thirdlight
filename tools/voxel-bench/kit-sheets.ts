/**
 * Placeholder texture sheets for voxel kits (engine-owned test data, not
 * art): a kit's one texture set laid out on its sheet layout (a named
 * layout such as `detail-trim`, or the kit's own `sheetLayout`), and the
 * GLB of its pieces with that set as its one material, the way an artist's
 * export carries it (the images inside the file; the import extracts them
 * into KTX2 texture assets the pieces draw with).
 *
 * Each region of the layout shows a placeholder material at real size (the
 * sheet's px a metre): its height falls off over the region's last 2 cm so
 * a strip reads as a trim edge in the normal map, caps are a shade darker
 * (end faces), and everything outside the regions (gutters, unused space)
 * is neutral as the texture layout asks: height 0.5, a flat normal, the
 * material's colour carried on so mips do not bleed another hue in.
 *
 * Deterministic at any size (the sheet's layout is in its authored pixels;
 * a smaller image is the same sheet with fewer texels).
 */
import { glbBytes, readGlb } from '@thirdlight/shared';
import { trimRegionAt, type TrimLayout } from '@thirdlight/project-model';

import { placeholderMaps, placeholderPng, placeholderShade, type PlaceholderSet } from './texture-sets';

/** The rim (metres) over which a region's height falls to the gutter's 0.5: the strip's edge in the normal map. */
const REGION_RIM_M = 0.02;

/** A kit sheet's three maps at `size`² (RGBA 8-bit, first row the sheet's top), its regions in placeholder `set`. */
export function kitSheetMaps(layout: TrimLayout, size: number, set: PlaceholderSet): ReturnType<typeof placeholderMaps> {
  const shade = placeholderShade(set);
  const sheetMetres = layout.size / layout.pxPerMetre;
  const rimPx = REGION_RIM_M * layout.pxPerMetre;
  return placeholderMaps(size, sheetMetres, shade.depthMetres, shade.roughness, (u, vUp) => {
    // The sheet's UV (v down from the top, as glTF stores it) and its authored pixel.
    const v = 1 - vUp;
    const tile = shade.shade(((u * sheetMetres) / shade.tileMetres) % 1, ((vUp * sheetMetres) / shade.tileMetres) % 1);
    const region = trimRegionAt(layout, u, v);
    if (region === null) return { h: 0.5, rgb: tile.rgb };
    const px = u * layout.size;
    const py = v * layout.size;
    const [x0, x1] = region.x ?? [Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY];
    const edge = Math.min(py - region.y[0], region.y[1] - py, px - x0, x1 - px);
    const rim = Math.min(1, Math.max(0, edge / rimPx));
    const h = 0.5 + (tile.h - 0.5) * rim;
    const k = region.kind === 'cap' ? 0.8 : 1;
    return { h, rgb: [tile.rgb[0] * k, tile.rgb[1] * k, tile.rgb[2] * k] };
  });
}

/** A kit sheet's maps as PNG files (albedo sRGB; normal with the height in A; ORM). */
export function kitSheetPngs(layout: TrimLayout, size: number, set: PlaceholderSet): { albedo: Uint8Array; normal: Uint8Array; orm: Uint8Array } {
  const m = kitSheetMaps(layout, size, set);
  // The albedo's A is opaque: a kit sheet's height lives in the normal map (texture layout v1), and an alpha below 1
  // would read as cut-out or blended in a glTF material.
  const albedo = m.albedoHeight.slice();
  for (let i = 3; i < albedo.length; i += 4) albedo[i] = 255;
  return { albedo: placeholderPng(albedo, size), normal: placeholderPng(m.normal, size), orm: placeholderPng(m.orm, size) };
}

/**
 * The GLB with one material, named `name`, on every primitive: the sheet's albedo as base colour, its normal map,
 * its ORM as occlusion and metallic-roughness (glTF reads occlusion from R, roughness from G, metal from B), the
 * images inside the file. The file's other materials and images are dropped (one texture set a kit).
 */
export function glbWithKitMaterial(glb: Uint8Array, name: string, images: { albedo: Uint8Array; normal: Uint8Array; orm: Uint8Array }): Uint8Array {
  const parts = readGlb(glb);
  if (typeof parts === 'string') throw new Error(parts);
  const json = structuredClone(parts.json) as Record<string, unknown> & { meshes?: { primitives: Record<string, unknown>[] }[]; bufferViews?: Record<string, unknown>[]; buffers?: { byteLength: number }[] };
  const bin = parts.bin ?? new Uint8Array(0);
  const pad = (n: number): number => (4 - (n % 4)) % 4;
  const chunks: Uint8Array[] = [bin, new Uint8Array(pad(bin.length))];
  let at = bin.length + pad(bin.length);
  const views = [...(json.bufferViews ?? [])];
  const imageList = (['albedo', 'normal', 'orm'] as const).map((k) => {
    const bytes = images[k];
    views.push({ buffer: 0, byteOffset: at, byteLength: bytes.length });
    chunks.push(bytes, new Uint8Array(pad(bytes.length)));
    at += bytes.length + pad(bytes.length);
    return { name: `${name}-${k}`, mimeType: 'image/png', bufferView: views.length - 1 };
  });
  json.bufferViews = views;
  json.buffers = [{ byteLength: at }];
  json.images = imageList;
  // Repeat, trilinear: a sheet's strips run on along a piece's U.
  json.samplers = [{ magFilter: 9729, minFilter: 9987, wrapS: 10497, wrapT: 10497 }];
  json.textures = imageList.map((_, source) => ({ sampler: 0, source }));
  json.materials = [{ name, pbrMetallicRoughness: { baseColorTexture: { index: 0 }, metallicRoughnessTexture: { index: 2 }, metallicFactor: 1, roughnessFactor: 1 }, normalTexture: { index: 1 }, occlusionTexture: { index: 2 } }];
  for (const m of json.meshes ?? []) for (const p of m.primitives) p['material'] = 0;
  const out = new Uint8Array(at);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return glbBytes(JSON.stringify(json), out);
}

/**
 * A placeholder crack map for a kit (`damage.crackTexture`): one 4 × 4 m construction tile at `size`² (4096²: the
 * base tile's 1024 px/m), its red channel the strength from which a crack shows (255 first, dimmer later), cracks two
 * pixels wide wandering from one origin a metre, wrapping at the tile's edges. Deliberately unlike the engine's map
 * (fewer, longer, straighter cracks), so a picture tells the two apart.
 */
export function placeholderCrackPng(size: number, seed = 7): Uint8Array {
  const px = new Uint8Array(size * size * 4);
  for (let i = 3; i < px.length; i += 4) px[i] = 255;
  let s = seed >>> 0;
  const rnd = (): number => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
  const put = (x: number, y: number, v: number): void => {
    for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]] as const) {
      const ix = (((Math.round(x) + dx) % size) + size) % size;
      const iy = (((Math.round(y) + dy) % size) + size) % size;
      const o = (iy * size + ix) * 4;
      if (px[o]! < v) px[o] = v;
    }
  };
  const perMetre = size / 4;
  const crack = (x: number, y: number, a: number, length: number, v: number): void => {
    for (let k = 0; k < length; k++) {
      put(x, y, v);
      a += (rnd() - 0.5) * 0.12;
      x += Math.cos(a);
      y += Math.sin(a);
      if (v > 120 && rnd() < 0.004) crack(x, y, a + (rnd() < 0.5 ? -1 : 1) * 0.9, length * 0.3, v - 90);
    }
  };
  for (let my = 0; my < 4; my++) for (let mx = 0; mx < 4; mx++) {
    const a = rnd() * Math.PI * 2;
    crack((mx + rnd()) * perMetre, (my + rnd()) * perMetre, a, perMetre * (1.2 + rnd()), 255);
    crack((mx + rnd()) * perMetre, (my + rnd()) * perMetre, a + Math.PI / 2, perMetre * 0.8, 165);
  }
  return placeholderPng(px, size);
}

/**
 * Shared fixture of the painted-terrain e2e specs — four layer
 * textures (flat colours with a height each), a flat normal map and an ORM
 * image as plain PNG texture assets; the three texture arrays packed from
 * them through the real pack route (as MCP does); and the colour tests the
 * pictures are read with.
 *
 * Layer colours (albedo, sRGB): 1 red, 2 green, 3 blue, 4 magenta. Heights:
 * layer 1 high (230), layer 2 low (20), 3 and 4 in the middle — so where
 * layers 1 and 2 are mixed half and half the height blend shows layer 1
 * (red), never an olive cross-fade.
 */
import { randomUUID } from 'node:crypto';

import type { E2EBackend } from './backend';
import type { Image } from './png';
import { makePng } from './png-make';

export const LAYER_ALBEDO: readonly [number, number, number][] = [
  [220, 40, 40],
  [40, 200, 40],
  [40, 60, 220],
  [220, 40, 220],
];
export const LAYER_HEIGHT = [230, 20, 128, 128] as const;

type Channel = { assetId: string; channel: 'r' | 'g' | 'b' | 'a' } | { value: number };

async function command(be: E2EBackend, op: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const q = await be.command({ op: 'queryProject', projectId: be.projectId, args: {} });
  const r = await be.command({ op, projectId: be.projectId, expectedRevision: Number(q['revision']), requestId: `req-${randomUUID().replace(/-/g, '')}`, origin: { kind: 'mcp', clientId: 'e2e-painted-layers' }, args });
  if (r['ok'] !== true) throw new Error(`${op}: ${JSON.stringify(r).slice(0, 500)}`);
  return r;
}

/** Publish a PNG as a plain texture through the content route, closing its stage (a project keeps at most 8 open). */
export async function publishTexture(be: E2EBackend, bytes: Uint8Array, assetId: string, displayName: string): Promise<void> {
  const headers = { authorization: `Bearer ${be.token}`, origin: be.origin };
  const base = `${be.origin}/api/v1/projects/${be.projectId}/content/stages`;
  const stage = (await (await fetch(base, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: '{}' })).json()) as { stageId: string };
  const put = await fetch(`${base}/${stage.stageId}/bytes`, { method: 'PUT', headers: { ...headers, 'content-type': 'application/octet-stream', 'x-thirdlight-offset': '0', 'x-thirdlight-total': String(bytes.length) }, body: bytes });
  if (!put.ok) throw new Error(`publish ${assetId} upload: ${put.status} ${await put.text()}`);
  const inspected = (await (await fetch(`${base}/${stage.stageId}/inspect`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'texture' }) })).json()) as { proposal?: Record<string, unknown> };
  const p = inspected.proposal;
  if (p === undefined) throw new Error(`publish ${assetId} inspect: ${JSON.stringify(inspected).slice(0, 300)}`);
  await command(be, 'publishAsset', { mode: 'create', assetId, kind: 'texture', displayName, sourceDigest: p['sourceDigest'], sourceByteLength: p['sourceByteLength'], importRecipe: p['importRecipe'], metrics: p['metrics'], importedAt: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z') });
  await fetch(`${base}/${stage.stageId}`, { method: 'DELETE', headers });
}

/** The layer source images as plain PNG textures (ids alb-1…4, hgt-1…4, nrm, orm-src). */
export async function publishLayerSources(be: E2EBackend): Promise<void> {
  for (let i = 0; i < 4; i++) {
    const [r, g, b] = LAYER_ALBEDO[i]!;
    await publishTexture(be, new Uint8Array(makePng(16, 16, () => [r, g, b, 255])), `alb-${i + 1}`, `Albedo ${i + 1}`);
    const h = LAYER_HEIGHT[i]!;
    await publishTexture(be, new Uint8Array(makePng(16, 16, () => [h, h, h, 255])), `hgt-${i + 1}`, `Height ${i + 1}`);
  }
  await publishTexture(be, new Uint8Array(makePng(16, 16, () => [128, 128, 255, 255])), 'nrm', 'Flat normal');
  // Occlusion 1, roughness 0.8, metalness 0.
  await publishTexture(be, new Uint8Array(makePng(16, 16, () => [255, 204, 0, 255])), 'orm-src', 'ORM');
}

/** Pack through the route and publish with its packedFrom (the MCP path); returns the route's answer. */
export async function packTexture(be: E2EBackend, layers: Channel[][], encoding: 'color' | 'normal' | 'data', assetId: string): Promise<Record<string, unknown>> {
  const res = await fetch(`${be.origin}/api/v1/projects/${be.projectId}/content/textures/pack`, {
    method: 'POST',
    headers: { authorization: `Bearer ${be.token}`, origin: be.origin, 'content-type': 'application/json' },
    body: JSON.stringify({ layers, encoding, displayName: assetId }),
  });
  const packed = (await res.json()) as { ok?: boolean; proposal?: Record<string, unknown>; packedFrom?: unknown };
  if (packed.ok !== true || packed.proposal?.['status'] !== 'ok') throw new Error(`pack ${assetId}: ${JSON.stringify(packed).slice(0, 500)}`);
  const p = packed.proposal;
  await command(be, 'publishAsset', { mode: 'create', assetId, kind: 'texture', displayName: assetId, sourceDigest: p['sourceDigest'], sourceByteLength: p['sourceByteLength'], packedFrom: packed.packedFrom, importRecipe: p['importRecipe'], metrics: p['metrics'], importedAt: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z') });
  return packed as Record<string, unknown>;
}

/** The albedo + height array's layers (RGB of alb-i, A = hgt-i's R). */
export const ALBEDO_HEIGHT_LAYERS: Channel[][] = [0, 1, 2, 3].map((i) => [
  { assetId: `alb-${i + 1}`, channel: 'r' },
  { assetId: `alb-${i + 1}`, channel: 'g' },
  { assetId: `alb-${i + 1}`, channel: 'b' },
  { assetId: `hgt-${i + 1}`, channel: 'r' },
]);

/** The normal and ORM arrays (the same image in every layer). */
export async function packNormalAndOrm(be: E2EBackend): Promise<void> {
  const four = (layer: Channel[]): Channel[][] => [layer, layer, layer, layer];
  await packTexture(be, four([{ assetId: 'nrm', channel: 'r' }, { assetId: 'nrm', channel: 'g' }, { assetId: 'nrm', channel: 'b' }, { value: 255 }]), 'normal', 'terrain-normals');
  await packTexture(be, four([{ assetId: 'orm-src', channel: 'r' }, { assetId: 'orm-src', channel: 'g' }, { assetId: 'orm-src', channel: 'b' }, { value: 255 }]), 'data', 'terrain-orm');
}

interface Mat {
  materialId: string;
  graph?: unknown;
  parameters?: { key: string; type: string; default: unknown }[];
}

/** The project's materials (queryGameConfig). */
export async function materials(be: E2EBackend): Promise<Mat[]> {
  const r = await be.command({ op: 'queryGameConfig', projectId: be.projectId, args: {} });
  return (r['materials'] ?? []) as Mat[];
}

/** Set a layered material's three texture parameters to the arrays. */
export async function useArrays(be: E2EBackend, materialId: string, arrays: { albedoHeight: string; normals: string; orm: string }): Promise<void> {
  const m = (await materials(be)).find((x) => x.materialId === materialId);
  if (m === undefined) throw new Error(`no material ${materialId}`);
  const parameters = (m.parameters ?? []).map((p) => (p.key === 'albedoHeight' ? { ...p, default: arrays.albedoHeight } : p.key === 'normals' ? { ...p, default: arrays.normals } : p.key === 'orm' ? { ...p, default: arrays.orm } : p));
  await command(be, 'setMaterial', { material: { ...m, parameters } });
}

// ---- reading the pictures ----------------------------------------------------------

type Pred = (r: number, g: number, b: number) => boolean;
/** Layer 1 (red), wet or dry. */
export const isRed: Pred = (r, g, b) => r > 45 && r > 2.2 * g && r > 2.2 * b;
export const isBlue: Pred = (r, g, b) => b > 60 && b > 1.6 * r && b > 1.6 * g;
export const isMagenta: Pred = (r, g, b) => r > 60 && b > 60 && g < 0.55 * Math.min(r, b) && Math.abs(r - b) < 0.35 * Math.max(r, b);
/** Layer 2's green, or a green-red cross-fade (olive): what the height blend must not show. */
export const isGreenish: Pred = (r, g, b) => g > 55 && g > 1.4 * b && g > 0.6 * r;

export function count(img: Image, test: Pred): number {
  let n = 0;
  for (let y = 0; y < img.height; y += 2) for (let x = 0; x < img.width; x += 2) {
    const [r, g, b] = img.pixel(x, y);
    if (test(r, g, b)) n += 1;
  }
  return n;
}

/** The red pixels' red channel, sorted (the wet ground is the dark end). */
export function reds(img: Image): number[] {
  const out: number[] = [];
  for (let y = 0; y < img.height; y += 2) for (let x = 0; x < img.width; x += 2) {
    const [r, g, b] = img.pixel(x, y);
    if (isRed(r, g, b)) out.push(r);
  }
  return out.sort((a, b) => a - b);
}

/**
 * The instance brush against a real backend.
 *
 * A 3D project with a block layer (a raised flat top at y = 2) and a wide
 * model with a collider (a scaled pillar, its cap the surface) beside it;
 * one instance set of small pillars, its one copy far away.
 *
 * In the editor: the set's Inspector shows the brush (Paint, Erase and the
 * settings); a stroke dragged across the block-layer top paints copies onto
 * it (one paintInstances, read back over HTTP: on the top, inside the
 * stroke, scaled within the range), one undo takes them all away, one redo
 * brings the same buffer back; the same stroke sent again over MCP gives the
 * same buffer (the copies come from the seed); a reload shows them; Erase
 * takes away the copies under its stroke, one undo restores them. The copies
 * show in the Scene view's and in Play's pixels and keep the set's chunks. A
 * stroke on the model's cap puts copies on the cap.
 *
 * Vertex paint in the same project (the vertex paint editor, opened from
 * the Inspector's Paint vertices): the platform, the set's copies and a
 * generated room's walls wear a white material that paint darkens
 * (`paintTint`, its "Tint amount" tile = channel A: no tint colour, so
 * painted is dark). The editor shows only the painted object, the material
 * card says it reads paint, the palette names the tint's channels, and the
 * shared cursor lies on the cap. A drag across the platform's cap is drawn
 * while the button is still down (the page's preview) and stored as ONE
 * `paintVertices` carrying the shared brush (size, strength, a constant
 * falloff, opacity); the stored paint replaces the preview with no frame in
 * which the platform is missing (the same for an API stroke, undo and redo);
 * a click on one copy paints that copy alone; a drag along the room's south
 * wall paints that wall's path side; the channel view shows channel A as
 * white; Erase takes the cap's paint off and one undo brings it back; Play
 * draws the paint. A box wearing a plain material: the editor says it reads
 * no paint (banner, toast, grey cursor, a press paints nothing); Make it
 * paintable gives it a layered surface whose base keeps its colour map (one
 * command, one undo), and the palette then shows Base, layers 2–4 and Wet;
 * with a red texture in layer 2 its tile paints R and the box draws red there.
 * WebGL 2 draws the stored paint (the cap, the box's red layer) and a stroke's
 * preview too.
 *
 * Over MCP without a surface the backend drops the stroke onto the block
 * layer itself; erase and undo work the same; a stroke past what one
 * command may carry is refused with its reason.
 */
import { randomBytes } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { expect, test, type Page } from './pw';
import * as THREE from 'three';

import { publishBytes, startBackend, withoutSky, type E2EBackend } from './backend';
import { count, isRed, materials, publishTexture } from './painted-layers';
import { makePng } from './png-make';
import { consoleErrors, refusedObjects } from './console-errors';
import { changedPixels, decodePng, type Image } from './png';
import { inspector } from './ui';
import { channelView, enterPaint, fit, frame, leavePaint, paintColumnsFit, paintDrag, paintEditor, paintState, paintTool, pickTile, select, sceneProjector, setPaint, strokeDone, view, type Projector } from './vertex-paint-drive';

const REPO = resolve(import.meta.dirname, '..', '..');
let be: E2EBackend | null = null;
test.afterEach(async () => {
  await be?.stop();
  be = null;
});

async function query(op: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  return be!.command({ op, projectId: be!.projectId, args });
}
async function cmd(op: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = await be!.command({ op, projectId: be!.projectId, expectedRevision: Number((await query('queryProject')).revision), requestId: `req-${randomBytes(16).toString('hex')}`, origin: { kind: 'mcp', clientId: 'e2e-instance-brush' }, args });
  expect(res['ok'], JSON.stringify(res).slice(0, 600)).toBe(true);
  return res;
}
async function relay(path: string, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const r = await fetch(`${be!.origin}/api/v1/projects/${be!.projectId}/play/${path}`, { method: 'POST', headers: { authorization: `Bearer ${be!.token}`, 'content-type': 'application/json', origin: be!.origin }, body: JSON.stringify(body) });
  return { status: r.status, json: (await r.json()) as Record<string, unknown> };
}
async function mcpClient(): Promise<Client> {
  const mcp = new Client({ name: 'thirdlight-e2e', version: '0.0.0' });
  await mcp.connect(new StdioClientTransport({ command: process.execPath, args: [join(REPO, 'dist', 'mcp-adapter', 'mcp.mjs')], env: { ...process.env, THIRDLIGHT_AUTHORING_ORIGIN: be!.origin, THIRDLIGHT_PROJECT_ID: be!.projectId, THIRDLIGHT_MCP_TOKEN: be!.token } as Record<string, string>, stderr: 'ignore' }));
  return mcp;
}
async function mcpCommand(mcp: Client, op: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const revision = Number((await query('queryProject')).revision);
  const r = (await mcp.callTool({ name: 'tl_command', arguments: { op, expectedRevision: revision, args } })) as { content: { text: string }[]; isError?: boolean };
  return JSON.parse(r.content[0]!.text) as Record<string, unknown>;
}

/** The block layer's top: y = 2 over x −24…−12, z −20…−12. */
const TOP_Y = 2;
const LAYER_AT = [-24, 0, -20] as const;
/** The model platform (a pillar scaled 6 × 1.5 × 6, its cap's top at y = 3) stands at x = −4, z = −16. */
const CAP_Y = 3;
const PLATFORM_AT = [-4, 0, -16] as const;
/** The instance brush's fields (size: metres across, the stroke's radius 1.5 m). */
const BRUSH = { size: '3', density: '2', spacing: '0.3', 'scale min': '0.3', 'scale max': '0.4', rotation: '360', align: '0', seed: '7' };
/** A generated room (one outline, the starter preset) west of the platform: its south wall's outer face at z = ROOM.z[1]. */
const ROOM = { x: [-11, -7.5], z: [-12, -9] } as const;
/** White, darkened by paint channel A (`paintTint` mixes toward the paint's RGB, 0 here, by A). */
const TINT = { materials: { '*': 'vp-tint' } };

async function buildScene(): Promise<{ set: string; layer: string; platform: string; camera: string; room: string }> {
  await publishBytes(be!, new Uint8Array(readFileSync(join(REPO, 'templates', 'starter', 'assets', 'Pillar.glb'))), 'model', 'pillar', 'Pillar', {}, { extractTextures: false });
  await cmd('setBlockType', { block: { blockId: 'turf', name: 'Turf', variants: [{ color: '#3f8f3a' }], shape: 'full' } });
  const layer = String((await cmd('createEntity', { sceneId: 'scene-main', parentId: null, kind: 'group', name: 'Terrain', transform: { position: [...LAYER_AT] } }))['createdId']);
  await cmd('setComponent', { entityId: layer, component: 'blockLayer', value: { cellSize: [1, 0.5, 1], bounds: { min: [0, 0, 0], max: [12, 8, 8] }, castShadow: false, receiveShadow: false } });
  await cmd('editBlocks', { entityId: layer, edits: [{ kind: 'fill', box: [0, 0, 0, 12, 4, 8], cell: { block: 'turf' } }] });
  await cmd('setMaterial', { material: { materialId: 'vp-tint', name: 'Paint tint', shader: 'standard', params: { color: '#ffffff', roughness: 0.9, paintTint: true }, textures: {} } });
  const platform = String((await cmd('createEntity', { sceneId: 'scene-main', parentId: null, kind: 'model', name: 'Platform', transform: { position: [...PLATFORM_AT], scale: [6, 1.5, 6] }, model: { asset: { assetId: 'pillar' } }, components: { collider: { shape: { type: 'box', hx: 0.45, hy: 1, hz: 0.45 } }, ...TINT } }))['createdId']);
  const room = String((await cmd('createEntity', { sceneId: 'scene-main', parentId: null, kind: 'group', name: 'Room' }))['createdId']);
  const [x0, x1] = ROOM.x;
  const [z0, z1] = ROOM.z;
  await cmd('setComponent', { entityId: room, component: 'architecture', value: { elements: [], outlines: [{ id: 'room', preset: 'starter-room', path: { points: [[x0, 0, z0], [x1, 0, z0], [x1, 0, z1], [x0, 0, z1]], closed: true } }] } });
  await cmd('setComponent', { entityId: room, component: 'materials', value: TINT.materials });
  // The set: one copy far off, chunks of 4 m (painted copies keep the set's chunking).
  const res = await fetch(`${be!.origin}/api/v1/projects/${be!.projectId}/content/buffers`, { method: 'POST', headers: { authorization: `Bearer ${be!.token}`, 'content-type': 'application/json', origin: be!.origin }, body: JSON.stringify({ transforms: [40, 0, 40, 0, 0, 0, 1, 0.3, 0.3, 0.3] }) });
  const published = (await res.json()) as { digest: string };
  const set = String((await cmd('createEntity', { sceneId: 'scene-main', parentId: null, kind: 'group', name: 'Sprinkles', components: { instances: { asset: { assetId: 'pillar' }, buffer: published.digest, count: 1, chunkSize: 4 }, ...TINT } }))['createdId']);
  // The game camera looks down at the terrain from the south-east.
  const entities = (await query('queryEntities', { limit: 100, offset: 0 }))['entities'] as { id: string; components: Record<string, unknown> }[];
  const camera = entities.find((e) => e.components['virtualCamera'] !== undefined)!.id;
  const aim = new THREE.PerspectiveCamera();
  aim.position.set(-10, 12, -4);
  aim.lookAt(-18, TOP_Y, -16);
  const q = aim.quaternion;
  await cmd('setTransform', { entityId: camera, transform: { position: aim.position.toArray(), rotation: [q.x, q.y, q.z, q.w] } });
  return { set, layer, platform, camera, room };
}

type Copy = { x: number; y: number; z: number; s: number };
async function setState(set: string): Promise<{ buffer: string; count: number; chunkSize?: number; copies: Copy[] }> {
  const inst = ((await query('queryEntity', { entityId: set }))['entity'] as { components: { instances: { buffer: string; count: number; chunkSize?: number } } }).components.instances;
  const bytes = await fetch(`${be!.origin}/api/v1/projects/${be!.projectId}/content/buffers/${inst.buffer}`, { headers: { authorization: `Bearer ${be!.token}` } });
  const f = new Float32Array(await bytes.arrayBuffer());
  const copies = Array.from({ length: inst.count }, (_, i) => ({ x: f[i * 10]!, y: f[i * 10 + 1]!, z: f[i * 10 + 2]!, s: f[i * 10 + 7]! }));
  return { ...inst, copies };
}

/** TL_INSTANCE_BRUSH_DIR=<dir> keeps the pictures the test compares. */
const keep = (name: string, png: Buffer): void => {
  const dir = process.env['TL_INSTANCE_BRUSH_DIR'];
  if (dir === undefined || dir === '') return;
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.png`), png);
};
async function setBrush(page: Page, values: Record<string, string>): Promise<void> {
  for (const [k, v] of Object.entries(values)) {
    // The size is the shared brush panel's; the rest are the copies' own.
    const field = inspector(page).getByLabel(k === 'size' ? 'brush size' : `instance brush ${k}`, { exact: true });
    await field.fill(v);
    await field.blur();
  }
}
/** Drag across world points in the Scene view (a stroke). */
async function stroke(page: Page, from: readonly [number, number, number], to: readonly [number, number, number]): Promise<void> {
  const project = await sceneProjector(page);
  const box = (await view(page).boundingBox())!;
  const a = project(from)!;
  const b = project(to)!;
  for (const p of [a, b]) expect(p.x > 4 && p.x < box.width - 4 && p.y > 4 && p.y < box.height - 4, `stroke point in view ${JSON.stringify(p)}`).toBe(true);
  await page.mouse.move(box.x + a.x, box.y + a.y);
  await page.mouse.down();
  for (let i = 1; i <= 24; i++) await page.mouse.move(box.x + a.x + ((b.x - a.x) * i) / 24, box.y + a.y + ((b.y - a.y) * i) / 24);
  await page.mouse.up();
  // The ring leaves with the pointer (pictures without it).
  await page.mouse.move(box.x + box.width + 40, box.y + box.height / 2);
}
async function strokeTiming(page: Page): Promise<{ ok: boolean; dabs: number; candidates: number; surfaceMs: number; commandMs: number }> {
  let t: { ok: boolean } | null = null;
  await expect.poll(async () => (t = JSON.parse((await view(page).getAttribute('data-instance-stroke')) ?? 'null') as { ok: boolean } | null) !== null).toBe(true);
  return t as unknown as { ok: boolean; dabs: number; candidates: number; surfaceMs: number; commandMs: number };
}
async function undo(page: Page, redo = false): Promise<void> {
  await view(page).hover();
  await page.keyboard.press(redo ? 'Control+y' : 'Control+z');
  await page.mouse.move(0, 0);
}

/** The brush cursor's amber (`--brush`) against the scene (white, green turf, grey). */
const isBrushAmber = (r: number, g: number, b: number): boolean => r > 150 && r > b + 70 && g > b + 30 && r >= g;

/** How many of the copies changed the picture where they stand (a 5 × 5 patch over their middle). */
function copiesSeen(before: Image, after: Image, project: Projector, copies: Copy[]): number {
  let seen = 0;
  for (const c of copies) {
    const p = project([c.x, c.y + 0.25 * c.s * 2, c.z]);
    if (p === null) continue;
    let diff = 0;
    for (let y = Math.round(p.y) - 2; y <= Math.round(p.y) + 2; y++)
      for (let x = Math.round(p.x) - 2; x <= Math.round(p.x) + 2; x++) {
        if (x < 0 || y < 0 || x >= before.width || y >= before.height) continue;
        const [r0, g0, b0] = before.pixel(x, y);
        const [r1, g1, b1] = after.pixel(x, y);
        diff = Math.max(diff, Math.abs(r1 - r0) + Math.abs(g1 - g0) + Math.abs(b1 - b0));
      }
    if (diff > 40) seen += 1;
  }
  return seen;
}

// ---- Vertex paint (the Vertex paint window and the Scene view's paint mode) ----

/** The mean of a 7 × 7 patch's brightest channel around a world point in a picture (null: off the picture). */
function patch(img: Image, project: Projector, p: readonly [number, number, number]): number | null {
  const s = project(p);
  if (s === null || s.x < 4 || s.y < 4 || s.x > img.width - 4 || s.y > img.height - 4) return null;
  let sum = 0;
  let n = 0;
  for (let y = Math.round(s.y) - 3; y <= Math.round(s.y) + 3; y++)
    for (let x = Math.round(s.x) - 3; x <= Math.round(s.x) + 3; x++) {
      const [r, g, b] = img.pixel(x, y);
      sum += Math.max(r, g, b);
      n += 1;
    }
  return sum / n;
}
async function sceneShot(page: Page, name: string): Promise<Image> {
  await page.mouse.move(0, 0);
  await page.waitForTimeout(250);
  const png = await view(page).screenshot();
  keep(name, png);
  return decodePng(png);
}
const component = async (id: string, name: string): Promise<Record<string, unknown> | undefined> => ((await query('queryEntity', { entityId: id }))['entity'] as { components: Record<string, Record<string, unknown> | undefined> }).components[name];

async function vertexPaint(page: Page, ids: { set: string; layer: string; platform: string; room: string }, playBefore: Image, copies: Copy[]): Promise<void> {
  const sent: Record<string, unknown>[] = [];
  page.on('request', (r) => {
    if (r.method() !== 'POST' || !r.url().includes('/commands')) return;
    const body = JSON.parse(r.postData() ?? '{}') as { op?: string; args?: Record<string, unknown> };
    if (body.op === 'paintVertices') sent.push(body.args ?? {});
  });
  // The platform's editor: only it is drawn; its material reads paint as a tint; "Tint amount" (A), full strength, a hard edge.
  await frame(page, ids.platform);
  await enterPaint(page, ids.platform);
  await expect(view(page)).toHaveAttribute('data-isolation', new RegExp(`"ids":\\["${ids.platform}"\\]`));
  const col = paintEditor(page);
  await paintColumnsFit(page);
  await expect.poll(async () => (await paintState(page))?.navigate, { message: 'back in Paint, the tool armed again' }).toBe(false);
  await expect(col.getByLabel('material card')).toContainText('Paint tint');
  await expect(col.getByLabel('material card')).toContainText('reads paint');
  await expect(col.getByRole('radiogroup', { name: 'paint layers' }).getByRole('radio')).toHaveText([/Tint red/, /Tint green/, /Tint blue/, /Tint amount/]);
  await pickTile(page, 3, 3);
  await setPaint(page, { size: '7', strength: '100', falloff: 'Constant' });
  await expect(paintEditor(page).getByLabel('edit mode hints')).toContainText('Drag on Platform to paint Tint amount.');

  // The platform's cap: drawn dark while the button is down, one paintVertices on release. (Read off its middle: the
  // collider's grip sits there.)
  const cap = [PLATFORM_AT[0] + 1.2, CAP_Y, PLATFORM_AT[2] - 1.2] as const;
  await fit(page, [[PLATFORM_AT[0] - 3, CAP_Y, PLATFORM_AT[2] - 3], [PLATFORM_AT[0] + 3, CAP_Y, PLATFORM_AT[2] + 3]]);
  const project = await sceneProjector(page);
  const beforeShot = await sceneShot(page, 'paint-before');
  const before = patch(beforeShot, project, cap)!;
  expect(before, 'the white cap').toBeGreaterThan(110);
  // The shared cursor lies on the cap under the pointer, in the brush colour.
  {
    const box = (await view(page).boundingBox())!;
    const at = project(cap)!;
    await page.mouse.move(box.x + at.x, box.y + at.y);
    await page.waitForTimeout(250);
    const png = await view(page).screenshot();
    keep('paint-cursor', png);
    expect(changedPixels(beforeShot, decodePng(png), isBrushAmber), 'the vertex paint cursor drawn').toBeGreaterThan(60);
    expect((await paintState(page))?.cursor).toBe('paint');
    await page.mouse.move(0, 0);
  }
  let mid: number | null = null;
  await paintDrag(page, [PLATFORM_AT[0] - 1, CAP_Y, PLATFORM_AT[2]], [PLATFORM_AT[0] + 1, CAP_Y, PLATFORM_AT[2]], async () => {
    await page.waitForTimeout(150);
    const png = await view(page).screenshot();
    keep('paint-mid-stroke', png);
    mid = patch(decodePng(png), project, cap);
    expect(sent, 'nothing sent while the button is down').toHaveLength(0);
  });
  expect(mid!, 'the preview darkens the cap while the button is down').toBeLessThan(before * 0.45);
  const t1 = await strokeDone(page, 1);
  expect(sent).toHaveLength(1);
  expect(sent[0]!['entityId']).toBe(ids.platform);
  expect(sent[0]!['brush']).toEqual({ radius: 3.5, strength: 1, channel: 3, falloff: 'constant' });
  expect((sent[0]!['dabs'] as unknown[]).length).toBe(t1.dabs);
  const paint1 = (await component(ids.platform, 'vertexPaint')) as { meshes: { mesh: string; paint: string }[] };
  expect(paint1.meshes.length).toBeGreaterThan(0);
  expect(patch(await sceneShot(page, 'paint-after'), project, cap)!).toBeLessThan(before * 0.45);
  keep('paint-editor', await page.screenshot());
  // From the release on, every frame drew the platform (the stored paint replaced the preview in place).
  expect((await paintState(page))!.watch).toMatchObject({ id: ids.platform, gaps: 0 });

  // The same object painted over the API (the command MCP sends), then undone and redone: drawn in place, never missing.
  // (An erase at one corner of the cap's top.)
  await cmd('paintVertices', { entityId: ids.platform, dabs: [[PLATFORM_AT[0] + 2.7, CAP_Y, PLATFORM_AT[2] + 2.7]], brush: { radius: 0.5, strength: 1, channel: 3, falloff: 'constant', erase: true } });
  await expect.poll(async () => JSON.stringify(await component(ids.platform, 'vertexPaint'))).not.toBe(JSON.stringify(paint1));
  await undo(page);
  await expect.poll(async () => JSON.stringify(await component(ids.platform, 'vertexPaint'))).toBe(JSON.stringify(paint1));
  await undo(page, true);
  await expect.poll(async () => JSON.stringify(await component(ids.platform, 'vertexPaint'))).not.toBe(JSON.stringify(paint1));
  await undo(page);
  await expect.poll(async () => JSON.stringify(await component(ids.platform, 'vertexPaint'))).toBe(JSON.stringify(paint1));
  await page.waitForTimeout(500);
  const watched = (await paintState(page))!.watch!;
  expect(watched.frames, 'frames drawn while the paint changed').toBeGreaterThan(3);
  expect(watched.gaps, 'frames without the platform').toBe(0);
  await leavePaint(page);

  // One copy of the set (the one nearest the layer's middle, where the view dollies to): a click paints it alone.
  const one = copies.reduce((a, c) => (Math.hypot(c.x + 18, c.z + 16) < Math.hypot(a.x + 18, a.z + 16) ? c : a));
  const capOf = (c: Copy): [number, number, number] => [c.x, TOP_Y + 2 * c.s, c.z];
  await frame(page, ids.layer);
  await enterPaint(page, ids.set);
  await pickTile(page, 3, 3);
  await setPaint(page, { size: '1' });
  const vb = (await view(page).boundingBox())!;
  for (let i = 0; i < 30; i++) {
    const s0 = (await sceneProjector(page))(capOf(one));
    const s1 = (await sceneProjector(page))([one.x + 1, TOP_Y, one.z]);
    if (s0 === null || s1 === null || Math.hypot(s1.x - s0.x, s1.y - s0.y) > vb.width * 0.08) break;
    await page.mouse.move(vb.x + vb.width / 2, vb.y + vb.height / 2);
    await page.mouse.wheel(0, -150);
    await page.waitForTimeout(60);
  }
  await page.mouse.move(0, 0);
  // Another copy on screen, a metre or more from it, keeps its look.
  const inView = (q: { x: number; y: number } | null): boolean => q !== null && q.x > 20 && q.y > 50 && q.x < vb.width - 20 && q.y < vb.height - 20;
  const proj0 = await sceneProjector(page);
  const other = copies.find((c) => c !== one && Math.hypot(c.x - one.x, c.z - one.z) > 1 && inView(proj0(capOf(c))));
  const pc = await sceneProjector(page);
  const copyBefore = await sceneShot(page, 'copy-before');
  await paintDrag(page, capOf(one), capOf(one));
  const t2 = await strokeDone(page, 2);
  expect(sent.at(-1)).toMatchObject({ entityId: ids.set });
  const copy = sent.at(-1)!['copy'] as number;
  expect(copy).toBeGreaterThanOrEqual(1);
  const instPaint = ((await component(ids.set, 'instances')) as { paint?: { painted: number } }).paint;
  expect(instPaint?.painted).toBe(1);
  const copyAfter = await sceneShot(page, 'copy-after');
  const ob = patch(copyBefore, pc, capOf(one));
  const oa = patch(copyAfter, pc, capOf(one));
  expect(ob !== null && oa !== null && oa < ob * 0.6, `the painted copy darkens ${ob} -> ${oa}`).toBe(true);
  const xb = other === undefined ? null : patch(copyBefore, pc, capOf(other));
  const xa = other === undefined ? null : patch(copyAfter, pc, capOf(other));
  if (xb !== null && xa !== null) expect(Math.abs(xa - xb), 'another copy keeps its look').toBeLessThan(25);
  await leavePaint(page);

  // The room's south wall: a drag along its outer face paints its path side.
  const wallY = 1.5;
  const wallZ = ROOM.z[1] + 0.12;
  // (F frames an object by what hangs on its node: the room's walls are drawn apart, so the view starts at the platform beside it.)
  await frame(page, ids.platform);
  await enterPaint(page, ids.room);
  await pickTile(page, 3, 3);
  await setPaint(page, { size: '4' });
  await fit(page, [[ROOM.x[0], 0, ROOM.z[1]], [ROOM.x[1], 3, ROOM.z[1]]]);
  const pw = await sceneProjector(page);
  const mid3 = [(ROOM.x[0] + ROOM.x[1]) / 2, wallY, wallZ] as const;
  const wallBefore = patch(await sceneShot(page, 'wall-before'), pw, mid3)!;
  let wallMid: number | null = null;
  await paintDrag(page, [ROOM.x[0] + 0.8, wallY, wallZ], [ROOM.x[1] - 0.8, wallY, wallZ], async () => {
    await page.waitForTimeout(150);
    wallMid = patch(decodePng(await view(page).screenshot()), pw, mid3);
  });
  const t3 = await strokeDone(page, 3);
  expect(sent.at(-1)).toMatchObject({ entityId: ids.room, path: 'outline:room' });
  const paths = ((await component(ids.room, 'vertexPaint')) as { paths: { path: string; side: string }[] }).paths;
  expect(paths.map((g) => g.path)).toEqual(['outline:room']);
  const wallAfter = patch(await sceneShot(page, 'wall-after'), pw, mid3)!;
  expect(wallMid!, `the wall's preview darkens it (${wallBefore} -> ${wallMid})`).toBeLessThan(wallBefore * 0.6);
  expect(wallAfter, `the stored wall paint (${wallBefore} -> ${wallAfter})`).toBeLessThan(wallBefore * 0.6);

  // The channel view: channel A as grey (the painted wall white; the editor draws the room alone, so the ground beside it is the empty view).
  await channelView(page, 'Tint amount');
  await expect.poll(async () => (await paintState(page))?.view).toBe(3);
  const channel = await sceneShot(page, 'wall-channel-a');
  expect(patch(channel, pw, mid3)!, 'painted A shows white').toBeGreaterThan(200);
  expect(patch(channel, pw, [ROOM.x[1] + 1.5, 0, ROOM.z[1] + 1.5]) ?? 0, 'nothing else drawn: the empty view').toBeLessThan(40);
  await channelView(page, 'Final');
  await expect.poll(async () => (await paintState(page))?.view).toBe(null);
  await leavePaint(page);

  // Erase on the cap: its paint goes; one undo brings it back.
  await frame(page, ids.platform);
  await enterPaint(page, ids.platform);
  await paintTool(page, 'Erase');
  // The editor kept the platform's tile; the brush is shared, so its size is set again (the cap's vertices are its corners).
  await expect.poll(async () => (await paintState(page))?.channel).toBe(3);
  await setPaint(page, { size: '7' });
  await fit(page, [[PLATFORM_AT[0] - 3, CAP_Y, PLATFORM_AT[2] - 3], [PLATFORM_AT[0] + 3, CAP_Y, PLATFORM_AT[2] + 3]]);
  const pe = await sceneProjector(page);
  await paintDrag(page, [PLATFORM_AT[0] - 1, CAP_Y, PLATFORM_AT[2]], [PLATFORM_AT[0] + 1, CAP_Y, PLATFORM_AT[2]]);
  await strokeDone(page, 4);
  expect(sent.at(-1)!['brush']).toMatchObject({ channel: 3, erase: true });
  await expect.poll(async () => (await component(ids.platform, 'vertexPaint')) ?? null).toBeNull();
  expect(patch(await sceneShot(page, 'erase-after'), pe, cap)!).toBeGreaterThan(before * 0.8);
  await undo(page);
  await expect.poll(async () => JSON.stringify(await component(ids.platform, 'vertexPaint'))).toBe(JSON.stringify(paint1));
  await expect.poll(async () => patch(await sceneShot(page, 'erase-undone'), pe, cap)!, { timeout: 10_000 }).toBeLessThan(before * 0.45);
  expect((await paintState(page))!.watch).toMatchObject({ id: ids.platform, gaps: 0 });
  await paintTool(page, 'Paint');
  await leavePaint(page);

  // Play draws the paint (the cap and the wall, where the game camera sees them).
  const play = await playPicture(page);
  keep('paint-play', play.png);
  const gp = gameProjector(play.img);
  const seen: string[] = [];
  for (const [label, p] of [['cap', cap], ['wall', mid3]] as const) {
    const b0 = patch(playBefore, gameProjector(playBefore), p);
    const b1 = patch(play.img, gp, p);
    if (b0 === null || b1 === null) continue;
    seen.push(label);
    expect(b1, `Play: the painted ${label} (${b0} -> ${b1})`).toBeLessThan(b0 * 0.6);
  }
  expect(seen.length, 'the game camera sees a painted thing').toBeGreaterThan(0);
  console.log(`vertex paint: model stroke ${JSON.stringify(t1)}; copy ${JSON.stringify(t2)}; wall ${JSON.stringify(t3)}; Play saw ${seen.join(', ')}`);
}

/**
 * A box wearing a material that reads no paint: the editor says so (banner, toast, the "no paint" tag, a grey
 * cursor; a press paints nothing); Make it paintable is one command giving it a layered surface whose base keeps the
 * colour map, one undo puts the old material back and redo the new one; a red texture in layer 2, its tile picked, a
 * stroke draws red on the box (R = layer 2). Returns the box.
 */
async function makePaintable(page: Page, ids: { platform: string }): Promise<string> {
  await publishTexture(be!, new Uint8Array(makePng(16, 16, () => [200, 190, 170, 255])), 'vp-plain-map', 'Mill map');
  await cmd('setMaterial', { material: { materialId: 'vp-plain', name: 'Mill walls', shader: 'standard', params: { color: '#ffffff' }, textures: { map: 'vp-plain-map' } } });
  const box = String((await cmd('createEntity', { sceneId: 'scene-main', parentId: null, kind: 'model', name: 'Mill', transform: { position: [PLATFORM_AT[0], CAP_Y + 1, PLATFORM_AT[2]] }, model: { asset: { assetId: 'pillar' } }, components: { materials: { '*': 'vp-plain' } } }))['createdId']);
  const sent: string[] = [];
  page.on('request', (r) => {
    if (r.method() !== 'POST' || !r.url().includes('/commands')) return;
    const body = JSON.parse(r.postData() ?? '{}') as { op?: string };
    if (body.op === 'paintVertices' || body.op === 'setMaterial') sent.push(body.op);
  });
  await frame(page, ids.platform);
  await enterPaint(page, box);
  const col = paintEditor(page);
  await expect(col.getByRole('alert', { name: 'material does not read paint' })).toContainText('Mill walls is a Standard material');
  await expect(page.getByRole('status', { name: 'painting is off' })).toContainText('Mill walls');
  await expect(col.getByLabel('material card')).toContainText('no paint');
  await expect(paintEditor(page).getByLabel('edit mode hints')).toContainText("This material doesn't read paint");
  await fit(page, [[PLATFORM_AT[0] - 0.5, CAP_Y + 1, PLATFORM_AT[2] - 0.5], [PLATFORM_AT[0] + 0.5, CAP_Y + 3, PLATFORM_AT[2] + 0.5]]);
  const top = (await sceneProjector(page))([PLATFORM_AT[0], CAP_Y + 3, PLATFORM_AT[2]])!;
  const vb = (await view(page).boundingBox())!;
  await page.mouse.move(vb.x + top.x, vb.y + top.y + 4);
  // No tool can be armed on a material that reads no paint (Navigate): no brush cursor, and a drag orbits.
  await expect.poll(async () => (await paintState(page))?.navigate).toBe(true);
  expect((await paintState(page))?.cursor ?? null).toBeNull();
  await page.mouse.down();
  await page.mouse.move(vb.x + top.x + 10, vb.y + top.y + 4, { steps: 4 });
  await page.mouse.up();
  await page.waitForTimeout(300);
  expect(sent.filter((o) => o === 'paintVertices'), 'nothing painted on a material without paint').toHaveLength(0);
  keep('make-paintable-before', await page.screenshot());

  // Make it paintable: one setMaterial; the palette then shows the layered surface's tiles, the base named after the old material.
  await col.getByRole('alert', { name: 'material does not read paint' }).getByRole('button', { name: 'make it paintable' }).click();
  await expect(col.getByLabel('material card')).toContainText('reads paint');
  expect(sent).toEqual(['setMaterial']);
  const mapping = (await component(box, 'materials')) as Record<string, string>;
  expect(mapping['*']).not.toBe('vp-plain');
  const made = (await materials(be!)).find((m) => m.materialId === mapping['*']) as { materialId: string; layerNames?: string[]; parameters?: { key: string; default: unknown }[] };
  expect(made.layerNames?.[0]).toBe('Mill walls');
  expect(made.parameters?.find((p) => p.key === 'albedoHeight')?.default).toEqual(['vp-plain-map', '', '', '']);
  await expect(col.getByRole('radiogroup', { name: 'paint layers' }).getByRole('radio')).toHaveText([/Mill walls/, /Layer 2/, /Layer 3/, /Layer 4/, /Wet/]);
  await expect(page.getByRole('status', { name: 'painting is off' })).toHaveCount(0);
  // One undo: the old material is back, and the editor says so again; one redo makes it paintable again.
  await undo(page);
  await expect.poll(async () => ((await component(box, 'materials')) as Record<string, string>)['*']).toBe('vp-plain');
  await expect(col.getByRole('alert', { name: 'material does not read paint' })).toBeVisible();
  await undo(page, true);
  await expect.poll(async () => ((await component(box, 'materials')) as Record<string, string>)['*']).toBe(mapping['*']);
  await expect(col.getByLabel('material card')).toContainText('reads paint');

  // Layer 2 takes a red texture (as the Material mode's palette would put it); its tile paints R: the stroke's paint draws it.
  await publishTexture(be!, new Uint8Array(makePng(16, 16, () => [210, 30, 25, 255])), 'vp-red', 'Red brick');
  await cmd('setMaterial', { material: { ...made, parameters: made.parameters!.map((p) => (p.key === 'albedoHeight' ? { ...p, default: ['vp-plain-map', 'vp-red', '', ''] } : p)) } });
  await expect(col.getByRole('radiogroup', { name: 'paint layers' }).getByRole('radio')).toHaveText([/Mill walls/, /Red brick/, /Layer 3/, /Layer 4/, /Wet/]);
  await paintTool(page, 'Paint');
  await pickTile(page, 1, 0);
  await expect(paintEditor(page).getByLabel('edit mode hints')).toContainText('Drag on Mill to paint Red brick.');
  const redBefore = count(decodePng(await view(page).screenshot()), isRed);
  const strokes = (await paintState(page))?.strokes ?? 0;
  // Across its cap's top (a 7 m brush reaches every vertex of the box).
  await paintDrag(page, [PLATFORM_AT[0] - 0.2, CAP_Y + 3, PLATFORM_AT[2]], [PLATFORM_AT[0] + 0.2, CAP_Y + 3, PLATFORM_AT[2]]);
  const t = await strokeDone(page, strokes + 1);
  expect(t.entityId).toBe(box);
  expect(sent.at(-1)).toBe('paintVertices');
  await expect.poll(async () => count(decodePng(await view(page).screenshot()), isRed), { timeout: 20_000, message: 'layer 2 drawn where it was painted' }).toBeGreaterThan(redBefore + 300);
  await page.mouse.move(vb.x + top.x, vb.y + top.y + 4);
  await page.waitForTimeout(200);
  keep('make-paintable-after', await page.screenshot());
  await leavePaint(page);
  return box;
}

async function vertexPaintWebgl2(page: Page, ids: { platform: string; mill: string }): Promise<void> {
  await page.goto(be!.editorUrl.replace('#', '&renderer=webgl2#'));
  await expect(page.locator('.tl-statusbar')).toContainText('connected');
  await expect.poll(() => view(page).evaluate((c) => `${c.getAttribute('data-tl-renderer')}/${c.getAttribute('data-tl-renderer-state')}`), { timeout: 30_000 }).toBe('webgl2/ready');
  // The box's layer 2 (red, painted on a layered surface) draws in WebGL 2 too.
  await frame(page, ids.mill);
  await enterPaint(page, ids.mill);
  await expect.poll(async () => count(decodePng(await view(page).screenshot()), isRed), { timeout: 20_000, message: 'WebGL 2: the painted layer 2' }).toBeGreaterThan(300);
  keep('webgl2-layers', await page.screenshot());
  await leavePaint(page);
  await frame(page, ids.platform);
  await enterPaint(page, ids.platform);
  await pickTile(page, 3, 3);
  await setPaint(page, { size: '7', strength: '100', falloff: 'Constant' });
  await fit(page, [[PLATFORM_AT[0] - 3, CAP_Y, PLATFORM_AT[2] - 3], [PLATFORM_AT[0] + 3, CAP_Y, PLATFORM_AT[2] + 3]]);
  const project = await sceneProjector(page);
  const cap = [PLATFORM_AT[0] + 1.2, CAP_Y, PLATFORM_AT[2] - 1.2] as const;
  // The stored paint (dark), its edge white: the shaft's side below the cap is not painted.
  await expect.poll(async () => patch(await sceneShot(page, 'webgl2-stored'), project, cap)!, { timeout: 20_000 }).toBeLessThan(60);
  keep('webgl2-editor', await page.screenshot());
  // Erasing previews white while the button is down; Esc drops it (nothing stored, the editor stays) and the stored paint is drawn again.
  await paintTool(page, 'Erase');
  await setPaint(page, { size: '8' });
  const stored = JSON.stringify(await component(ids.platform, 'vertexPaint'));
  let mid: number | null = null;
  const box = (await view(page).boundingBox())!;
  const a = project([PLATFORM_AT[0], CAP_Y, PLATFORM_AT[2]])!;
  await page.mouse.move(box.x + a.x, box.y + a.y);
  await page.mouse.down();
  await page.mouse.move(box.x + a.x + 20, box.y + a.y, { steps: 6 });
  await page.waitForTimeout(150);
  const midPng = await view(page).screenshot();
  keep('webgl2-erase-mid-stroke', midPng);
  mid = patch(decodePng(midPng), project, cap);
  await page.keyboard.press('Escape');
  await page.mouse.up();
  expect(mid!, 'WebGL 2: the erase preview whitens the cap').toBeGreaterThan(110);
  await expect.poll(async () => patch(await sceneShot(page, 'webgl2-cancelled'), project, cap)!).toBeLessThan(60);
  expect(JSON.stringify(await component(ids.platform, 'vertexPaint'))).toBe(stored);
  await expect(paintEditor(page)).toBeVisible();
  await paintTool(page, 'Paint');
  await leavePaint(page);
}

async function playPicture(page: Page): Promise<{ img: Image; png: Buffer }> {
  const started = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().endsWith('/play'));
  await page.getByTitle('Start an isolated play preview').click();
  const psid = String(((await (await started).json()) as { playSessionId: string }).playSessionId);
  let png: Buffer | null = null;
  await expect.poll(async () => {
    const shot = await relay(`${psid}/screenshot`, { maxWidth: 960 });
    if (shot.status !== 200) return false;
    png = Buffer.from(String(shot.json.dataUrl ?? '').split(',')[1] ?? '', 'base64');
    return true;
  }, { timeout: 60_000, intervals: [500] }).toBe(true);
  // A screenshot is the frame as drawn, models still loading absent: the picture is taken once Play has none loading.
  await expect.poll(async () => {
    const r = (await relay(`${psid}/observe`, {})).json['resources'] as { loading?: number; resident?: Record<string, { count: number }> } | undefined;
    return r !== undefined && r.loading === 0 && (r.resident?.['model']?.count ?? 0) > 0;
  }, { timeout: 60_000 }).toBe(true);
  const shot = await relay(`${psid}/screenshot`, { maxWidth: 960 });
  if (shot.status === 200) png = Buffer.from(String(shot.json.dataUrl ?? '').split(',')[1] ?? '', 'base64');
  await page.getByTitle('Stop the play preview').click();
  return { img: decodePng(png!), png: png! };
}
function gameProjector(img: Image): Projector {
  const camera = new THREE.PerspectiveCamera(60, img.width / img.height, 0.1, 500);
  camera.position.set(-10, 12, -4);
  camera.lookAt(-18, TOP_Y, -16);
  camera.updateMatrixWorld();
  return (p) => {
    const v = new THREE.Vector3(...p).project(camera);
    return v.z > 1 ? null : { x: ((v.x + 1) / 2) * img.width, y: ((1 - v.y) / 2) * img.height };
  };
}

test('the instance brush paints and erases on a block-layer top and a model: one command and one undo per stroke, redo, reload, the same copies from the same stroke over MCP, pixels in the Scene view and Play; vertex paint on a model, a copy and a generated wall', async ({ page }) => {
  test.setTimeout(600_000);
  be = await startBackend(`instance-brush-${randomBytes(4).toString('hex')}`);
  // Paint is read by how much it darkens a copy: without the sky's tone mapping, which compresses the change.
  await withoutSky(be);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const logged = consoleErrors(page);
  const { set, layer, platform, room } = await buildScene();
  const original = await setState(set);
  const cameraFov = Number((((await query('queryEntities', { limit: 100, offset: 0 }))['entities'] as { components: Record<string, { fovY?: number }> }[]).find((e) => e.components['virtualCamera'] !== undefined)!.components['virtualCamera']!.fovY) ?? 60);
  expect(cameraFov).toBe(60);

  await page.goto(be.editorUrl);
  await expect(page.locator('.tl-statusbar')).toContainText('connected');
  await expect.poll(async () => JSON.parse((await view(page).getAttribute('data-block-layers')) ?? '{"chunks":0}').chunks as number, { timeout: 30_000 }).toBe(1);
  const playBefore = await playPicture(page);

  // The set's Inspector: the brush beside the copies; Paint arms it (the Scene view publishes its projection).
  await frame(page, layer);
  await select(page, set);
  await expect(inspector(page).getByRole('group', { name: 'instance brush' })).toBeVisible();
  await setBrush(page, BRUSH);
  await inspector(page).getByRole('button', { name: 'Paint', exact: true }).click();
  await expect(view(page)).toHaveAttribute('data-brush', set);
  await expect(view(page)).toHaveAttribute('data-brush-mode', 'paint');
  await expect(view(page)).toHaveAttribute('data-view-proj', /\[/);
  await fit(page, [[-23, TOP_Y, -18], [-13, TOP_Y, -14]]);
  await page.waitForTimeout(300);
  const sceneBeforePng = await view(page).screenshot();
  keep('scene-before', sceneBeforePng);
  const sceneBefore = decodePng(sceneBeforePng);
  // The shared brush cursor is drawn under the pointer in the brush colour (closed lines: three draws no LineLoop and logs an error for one).
  {
    const box = (await view(page).boundingBox())!;
    const at = (await sceneProjector(page))([-18, TOP_Y, -16])!;
    await page.mouse.move(box.x + at.x, box.y + at.y);
    await page.waitForTimeout(300);
    const ring = changedPixels(sceneBefore, decodePng(await view(page).screenshot()), isBrushAmber);
    expect(ring, 'the instance brush cursor drawn').toBeGreaterThan(60);
    await page.mouse.move(box.x + box.width + 40, box.y + box.height / 2);
  }

  // One stroke along the block-layer top: one paintInstances (its request kept for MCP).
  let sent: Record<string, unknown> | null = null;
  page.on('request', (r) => {
    if (r.method() !== 'POST' || !r.url().includes('/commands')) return;
    const body = JSON.parse(r.postData() ?? '{}') as { op?: string; args?: Record<string, unknown> };
    if (body.op === 'paintInstances') sent = body.args ?? null;
  });
  const A = [-21, TOP_Y, -16] as const;
  const B = [-15, TOP_Y, -16] as const;
  await stroke(page, A, B);
  const t1 = await strokeTiming(page);
  expect(t1.ok, JSON.stringify(t1)).toBe(true);
  const painted = await setState(set);
  expect(painted.count).toBeGreaterThan(10);
  expect(painted.chunkSize).toBe(4);
  const fresh = painted.copies.slice(1);
  expect(painted.copies[0]).toEqual(original.copies[0]);
  for (const c of fresh) {
    expect(c.y).toBeCloseTo(TOP_Y, 2);
    expect(Math.abs(c.z + 16)).toBeLessThanOrEqual(1.5 + 1e-3);
    expect(c.x).toBeGreaterThanOrEqual(-21 - 1.5 - 1e-3);
    expect(c.x).toBeLessThanOrEqual(-15 + 1.5 + 1e-3);
    expect(c.s).toBeGreaterThanOrEqual(0.3 - 1e-4);
    expect(c.s).toBeLessThanOrEqual(0.4 + 1e-4);
  }
  for (let i = 0; i < fresh.length; i++) for (let j = i + 1; j < fresh.length; j++) expect(Math.hypot(fresh[i]!.x - fresh[j]!.x, fresh[i]!.z - fresh[j]!.z)).toBeGreaterThanOrEqual(0.3 - 1e-3);
  expect(sent, 'the stroke went out as one paintInstances').not.toBeNull();
  const surface = (sent as unknown as { surface: unknown[] }).surface;
  expect(surface.length).toBe(t1.candidates);
  // The Scene view shows the copies where they stand; the Inspector counts the set's chunks (4 m).
  await page.waitForTimeout(500);
  const project = await sceneProjector(page);
  const sceneAfterPng = await view(page).screenshot();
  keep('scene-after', sceneAfterPng);
  const sceneAfter = decodePng(sceneAfterPng);
  expect(copiesSeen(sceneBefore, sceneAfter, project, fresh)).toBeGreaterThanOrEqual(Math.ceil(fresh.length * 0.6));
  await expect.poll(async () => Number(await inspector(page).locator('[data-chunks]').getAttribute('data-chunks'))).toBeGreaterThanOrEqual(3);

  // One undo takes the whole stroke away; one redo brings the same buffer back.
  await undo(page);
  await expect.poll(async () => (await setState(set)).buffer).toBe(original.buffer);
  await undo(page, true);
  await expect.poll(async () => (await setState(set)).buffer).toBe(painted.buffer);

  // The same stroke over MCP (after an undo) gives the same copies: the places come from the seed.
  await undo(page);
  await expect.poll(async () => (await setState(set)).buffer).toBe(original.buffer);
  const mcp = await mcpClient();
  try {
    const r = await mcpCommand(mcp, 'paintInstances', sent as unknown as Record<string, unknown>);
    expect(r['ok'], JSON.stringify(r).slice(0, 400)).toBe(true);
    expect((await setState(set)).buffer).toBe(painted.buffer);
    // Painting it again adds nothing.
    const again = await mcpCommand(mcp, 'paintInstances', sent as unknown as Record<string, unknown>);
    expect(JSON.stringify(again)).toContain('no_change');
  } finally {
    await mcp.close();
  }

  // A reload: the copies are there.
  await page.reload();
  await expect(page.locator('.tl-statusbar')).toContainText('connected');
  await expect.poll(async () => (await setState(set)).count).toBe(painted.count);
  await select(page, set);
  await expect.poll(async () => JSON.parse((await view(page).getAttribute('data-instance-copies')) ?? '[]').length, { timeout: 30_000 }).toBe(Math.min(64, painted.count));

  // Play shows them where they stand.
  const playAfter = await playPicture(page);
  keep('play-before', playBefore.png);
  keep('play-after', playAfter.png);
  expect(copiesSeen(playBefore.img, playAfter.img, gameProjector(playAfter.img), fresh)).toBeGreaterThanOrEqual(Math.ceil(fresh.length * 0.5));

  // Erase across the stroke's first half: those copies go, the rest stay; one undo restores them.
  await frame(page, layer);
  await select(page, set);
  await inspector(page).getByRole('button', { name: 'Erase', exact: true }).click();
  await expect(view(page)).toHaveAttribute('data-brush-mode', 'erase');
  await expect(view(page)).toHaveAttribute('data-view-proj', /\[/);
  await fit(page, [[-23, TOP_Y, -18], [-13, TOP_Y, -14]]);
  await stroke(page, [-21, TOP_Y, -16], [-19, TOP_Y, -16]);
  await expect.poll(async () => (await setState(set)).count).toBeLessThan(painted.count);
  const erased = await setState(set);
  for (const c of erased.copies.slice(1)) {
    const near = Math.hypot(c.x + 21, c.z + 16) <= 1.5 || Math.hypot(c.x + 19, c.z + 16) <= 1.5;
    expect(near, `copy at ${c.x},${c.z} under the erase stroke`).toBe(false);
  }
  expect(erased.copies.slice(1).some((c) => c.x > -17)).toBe(true);
  await undo(page);
  await expect.poll(async () => (await setState(set)).buffer).toBe(painted.buffer);

  // On a model: a stroke over the platform's cap puts copies on the cap.
  await frame(page, platform);
  await select(page, set);
  await inspector(page).getByRole('button', { name: 'Paint', exact: true }).click();
  await setBrush(page, { size: '1.2', density: '3', spacing: '0.2' });
  await expect(view(page)).toHaveAttribute('data-view-proj', /\[/);
  await fit(page, [[PLATFORM_AT[0] - 3, CAP_Y, PLATFORM_AT[2] - 3], [PLATFORM_AT[0] + 3, CAP_Y, PLATFORM_AT[2] + 3]]);
  const capTop = await (async () => {
    const before = (await setState(set)).count;
    await stroke(page, [PLATFORM_AT[0] - 0.8, CAP_Y, PLATFORM_AT[2]], [PLATFORM_AT[0] + 0.8, CAP_Y, PLATFORM_AT[2]]);
    await expect.poll(async () => (await setState(set)).count).toBeGreaterThan(before);
    const now = (await setState(set)).copies.slice(before);
    return now;
  })();
  const ys = capTop.map((c) => c.y);
  for (const y of ys) expect(y).toBeCloseTo(CAP_Y, 2);
  for (const c of capTop) expect(Math.max(Math.abs(c.x - PLATFORM_AT[0]), Math.abs(c.z - PLATFORM_AT[2]))).toBeLessThanOrEqual(0.45 * 6 + 1e-3);
  await undo(page);
  await expect.poll(async () => (await setState(set)).buffer).toBe(painted.buffer);
  console.log(`instance brush: stroke ${JSON.stringify(t1)}, ${fresh.length} copies; cap at y ${ys[0]}`);

  await vertexPaint(page, { set, layer, platform, room }, playBefore.img, fresh);
  const mill = await makePaintable(page, { platform });
  await vertexPaintWebgl2(page, { platform, mill });
  expect(errors).toEqual([]);
  expect(refusedObjects(logged), 'no object three refuses to draw').toEqual([]);
});

test('paintInstances over MCP: no surface drops onto the block layer, erase, one undo each, a stroke too large refused with its reason', async () => {
  test.setTimeout(180_000);
  be = await startBackend(`instance-brush-mcp-${randomBytes(4).toString('hex')}`);
  const { set } = await buildScene();
  const original = await setState(set);
  const mcp = await mcpClient();
  try {
    const brush = { radius: 2, density: 1.5, spacing: 0.4, scale: [0.5, 0.7], yaw: 180, align: 1, seed: 3 };
    const r = await mcpCommand(mcp, 'paintInstances', { entityId: set, mode: 'paint', dabs: [[-20, 2, -16], [-17, 2, -15]], brush });
    expect(r['ok'], JSON.stringify(r).slice(0, 400)).toBe(true);
    const painted = await setState(set);
    expect(painted.count).toBeGreaterThan(5);
    for (const c of painted.copies.slice(1)) expect(c.y).toBeCloseTo(TOP_Y, 3);
    // Outside the block layer (and no surface given) nothing lands.
    const off = await mcpCommand(mcp, 'paintInstances', { entityId: set, mode: 'paint', dabs: [[20, 0, 20]], brush });
    expect(JSON.stringify(off)).toContain('no_change');
    // Erase, then one undo restores; one more undo takes the paint away.
    const e = await mcpCommand(mcp, 'paintInstances', { entityId: set, mode: 'erase', dabs: [[-20, 2, -16]], brush: { ...brush, radius: 1 } });
    expect(e['ok'], JSON.stringify(e).slice(0, 400)).toBe(true);
    expect((await setState(set)).count).toBeLessThan(painted.count);
    expect((await mcpCommand(mcp, 'undo', {}))['ok']).toBe(true);
    expect((await setState(set)).buffer).toBe(painted.buffer);
    expect((await mcpCommand(mcp, 'undo', {}))['ok']).toBe(true);
    expect((await setState(set)).buffer).toBe(original.buffer);
    // More places than one stroke may carry: refused, saying so.
    const big = await mcpCommand(mcp, 'paintInstances', { entityId: set, mode: 'paint', dabs: [[-18, 2, -16]], brush: { ...brush, radius: 40, density: 50 } });
    expect(big['ok']).not.toBe(true);
    expect(JSON.stringify(big)).toMatch(/more than 1536 places/);
    expect((await setState(set)).buffer).toBe(original.buffer);
    // A stroke refused after it was planned (a stale revision) leaves no buffer behind: nothing collects an unused one.
    const blobs = (): number => readdirSync(join(be!.projectDir, 'sources', 'sha256')).length;
    const before = blobs();
    expect(before).toBeGreaterThan(0);
    const revision = Number((await query('queryProject')).revision);
    const stale = await be!.command({ op: 'paintInstances', projectId: be!.projectId, expectedRevision: revision - 1, requestId: `req-${randomBytes(16).toString('hex')}`, origin: { kind: 'mcp', clientId: 'e2e-instance-brush' }, args: { entityId: set, mode: 'paint', dabs: [[-14, 2, -14]], brush } });
    expect(JSON.stringify(stale)).toContain('revision_conflict');
    expect(blobs()).toBe(before);
  } finally {
    await mcp.close();
  }
});

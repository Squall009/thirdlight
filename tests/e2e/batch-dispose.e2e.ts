/**
 * Freeing an instancing group leaves what shares its mesh drawn, in a real
 * browser against the real backend.
 *
 * Automatic batches and instance sets draw a wrapper geometry that shares the
 * source mesh's vertex buffers. Disposing a wrapper the plain way frees those
 * shared buffers on the GPU: on WebGPU every later submit is refused (the view
 * stops updating for good), on WebGL 2 the other boxes lose their vertices.
 * Here two groups of equal boxes and a single box share the unit box; one
 * group is dissolved and formed again, and every colour must stay on screen
 * with no WebGPU validation error.
 *
 * Then the batcher regroups only on a change, in Play: with a fifth box in
 * each group and five model placements with two levels of detail (a graph
 * material per level, so placements share it), an idle frame regroups
 * nothing and copies no matrix; a project script then moves one red box,
 * hides one blue box and brings the far placement within its switch
 * distance, and each step regroups only the groups of that member (none for
 * the move, one for the hide, two for the level switch: the level it leaves
 * and the one it joins) and copies only its matrices. The picture after the
 * three steps matches the same steps drawn without batching (`?batching=off`).
 *
 * Static batching rides along: three static models of distinct shapes (two
 * levels each) wearing one material merge into one draw. In the Scene view a
 * click on one still selects it, and one moved by a command leaves the
 * merged draw and rejoins it where it now is; in Play one hidden by a script
 * leaves it, and the final picture (batched against `?batching=off`)
 * includes them.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test, type Locator, type Page } from '@playwright/test';

import { publishBytes, publishScript, startBackend, type E2EBackend } from './backend';
import { multiPieceGlb } from './multi-piece-glb';
import { diff, diffPng, show, STRICT, within } from './parity';
import { decodePng, type Image } from './png';
import { editorUrlFor, expectRendererBackend, onlyInItsProject, RENDERER_VARIANTS } from './renderer-variants';
import { lodSwitchDistance } from '@thirdlight/three-adapter';

let be: E2EBackend;
test.afterEach(async () => {
  await be?.stop();
});

async function query(op: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  return be.command({ op, projectId: be.projectId, args });
}

async function cmd(op: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = await be.command({
    op,
    projectId: be.projectId,
    expectedRevision: Number((await query('queryProject'))['revision']),
    requestId: `req-${createHash('sha256').update(`${op}${Math.random()}`).digest('hex').slice(0, 32)}`,
    origin: { kind: 'mcp', clientId: 'e2e-batch-dispose' },
    args,
  });
  expect(res['ok'], JSON.stringify(res)).toBe(true);
  return res;
}

type Hue = 'red' | 'green' | 'blue';
const COLORS: Record<Hue, string> = { red: '#d03030', green: '#30d030', blue: '#3030d0' };

/** Pixels whose channel `hue` clearly dominates the other two (shading keeps the hue). */
function hueCount(img: Image, hue: Hue): number {
  const k = hue === 'red' ? 0 : hue === 'green' ? 1 : 2;
  let n = 0;
  for (let y = 0; y < img.height; y += 2) {
    for (let x = 0; x < img.width; x += 2) {
      const p = img.pixel(x, y);
      const v = p[k]!;
      const others = [0, 1, 2].filter((i) => i !== k).map((i) => p[i]!);
      if (v > 60 && others.every((o) => v > o * 1.8)) n += 1;
    }
  }
  return n;
}

/** The project script: `place {id, x, y, z}` moves an object, `hide {id}` hides it. */
const DRIVER = [
  'export default {',
  '  instantiate() { return {}; },',
  '  step(_state: any, ctx: any) {',
  "    if (ctx.phase !== 'intent') return;",
  "    for (const c of ctx.debug.command('place', { description: 'Move an object', args: [{ name: 'id', type: 'string' }, { name: 'x', type: 'number' }, { name: 'y', type: 'number' }, { name: 'z', type: 'number' }] })) {",
  "      ctx.entity(String(c.id))?.set('transform', { position: [Number(c.x), Number(c.y), Number(c.z)] });",
  '    }',
  "    for (const c of ctx.debug.command('hide', { description: 'Hide an object', args: [{ name: 'id', type: 'string' }] })) ctx.game.setVisible(String(c.id), false);",
  '  },',
  '};',
].join('\n');

/** An unlit graph material whose colour is its `tint` parameter. */
const TINT_GRAPH = {
  nodes: [
    { id: 'out', type: 'unlit', position: [400, 0], data: { castShadows: false } },
    { id: 'tint', type: 'parameter', position: [0, 0], data: { key: 'tint' } },
  ],
  edges: [{ id: 'e1', from: { node: 'tint', port: 'value' }, to: { node: 'out', port: 'color' } }],
};

/** The batcher's counters in Play's diagnostics. */
interface Batching {
  groups: number;
  batched: number;
  single: number;
  regroups: number;
  matrixCopies: number;
  regroupsTotal: number;
  matrixCopiesTotal: number;
  merging?: { cells: number; merged: number; slots: number; vertexBytes: number; indexBytes: number; buildsTotal: number };
}

/** Pixels of the static models' magenta (red and blue both high, green low), as view coordinates. */
function magentaPixels(img: Image): [number, number][] {
  const out: [number, number][] = [];
  for (let y = 0; y < img.height; y += 2) {
    for (let x = 0; x < img.width; x += 2) {
      const p = img.pixel(x, y);
      if (p[0]! > 90 && p[2]! > 90 && p[1]! < 0.5 * Math.min(p[0]!, p[2]!)) out.push([x, y]);
    }
  }
  return out;
}

/** A canvas's picture once two shots in a row are the same. */
async function settledShot(target: Locator): Promise<{ img: Image; png: Buffer }> {
  let last = '';
  await expect
    .poll(
      async () => {
        const png = (await target.screenshot()).toString('base64');
        const same = png === last;
        last = png;
        return same;
      },
      { timeout: 60_000, intervals: [1000] },
    )
    .toBe(true);
  const png = Buffer.from(last, 'base64');
  return { img: decodePng(png), png };
}

async function hues(page: Page): Promise<Record<Hue, number>> {
  const img = decodePng(await page.locator('canvas.tl-viewport').screenshot());
  return { red: hueCount(img, 'red'), green: hueCount(img, 'green'), blue: hueCount(img, 'blue') };
}

for (const variant of RENDERER_VARIANTS) {
  test(`dissolving an instancing group keeps the meshes it shared drawn (${variant})`, async ({ page }) => {
    onlyInItsProject(variant);
    test.setTimeout(180_000);
    be = await startBackend(`batch-dispose-${variant}`);
    // Two groups of four equal boxes (one material each) and one single box, all on the unit box mesh.
    const blue: string[] = [];
    for (let i = 0; i < 4; i++) {
      blue.push(String((await cmd('createEntity', { sceneId: 'scene-main', kind: 'box', name: `Blue ${i}`, transform: { position: [i * 1.4 - 2.1, 0.5, 1] }, box: { size: [1, 1, 1], material: { color: COLORS.blue } } }))['createdId']));
      await cmd('createEntity', { sceneId: 'scene-main', kind: 'box', name: `Red ${i}`, transform: { position: [i * 1.4 - 2.1, 0.5, -1] }, box: { size: [1, 1, 1], material: { color: COLORS.red } } });
    }
    await cmd('createEntity', { sceneId: 'scene-main', kind: 'box', name: 'Green', transform: { position: [0, 2, 0] }, box: { size: [1, 1, 1], material: { color: COLORS.green } } });

    const validation: string[] = [];
    page.on('console', (m) => {
      const t = m.text();
      if (/GPUValidationError|while destroyed/.test(t)) validation.push(t.slice(0, 200));
    });
    await page.goto(editorUrlFor(be.editorUrl, variant));
    const view = page.locator('canvas.tl-viewport');
    await expectRendererBackend(view, variant);
    const frames = async (): Promise<number> => Number((await view.getAttribute('data-frames')) ?? 0);
    const batches = async (): Promise<string> => (await view.getAttribute('data-batches')) ?? '';
    await expect.poll(batches, { timeout: 30_000 }).toMatch(/^[1-9]/);
    const grouped = await batches();
    const seen = async (): Promise<string> => {
      const h = await hues(page);
      return (Object.keys(h) as Hue[]).filter((k) => h[k] > 30).sort().join(',');
    };
    await expect.poll(seen, { timeout: 30_000, message: 'every colour drawn before the group changes' }).toBe('blue,green,red');

    // The view draws on demand: each change is followed by at least one frame drawn after it.
    for (let i = 0; i < 3; i++) {
      let f = await frames();
      await cmd('updateEntity', { entityId: blue[0]!, active: false });
      await expect.poll(batches).not.toBe(grouped);
      await expect.poll(frames).toBeGreaterThan(f);
      await expect.poll(seen, { message: 'the red group, the single box and the three blue boxes left stay drawn' }).toBe('blue,green,red');
      f = await frames();
      await cmd('updateEntity', { entityId: blue[0]!, active: true });
      await expect.poll(batches).toBe(grouped);
      await expect.poll(frames).toBeGreaterThan(f);
      await expect.poll(seen, { message: 'every colour drawn after the group forms again' }).toBe('blue,green,red');
    }
    expect(validation, 'no WebGPU validation errors').toEqual([]);

    // ---- Static batching in the Scene view ----
    // Three static models of distinct shapes (two levels each), one magenta material: no instancing partner, one merged draw.
    await cmd('setMaterial', { material: { materialId: 'mag', name: 'Magenta', shader: 'unlit', params: {}, textures: {}, parameters: [{ key: 'tint', type: 'color', default: '#e020e0' }], graph: TINT_GRAPH } });
    await publishBytes(be, multiPieceGlb([0.7, 0.9, 1.1].map((k, i) => ({ name: `rock${i}`, lods: [[k, k, k], [k, k * 0.8, k]] }))), 'model', 'statics', 'Statics');
    const statics: string[] = [];
    for (let i = 0; i < 3; i++) {
      const id = String((await cmd('createEntity', { sceneId: 'scene-main', kind: 'model', name: `Static ${i}`, static: true, model: { asset: { assetId: 'statics' }, piece: `rock${i}` }, transform: { position: [i * 2.5 + 0.5, 2.5, -2] } }))['createdId']);
      await cmd('setComponent', { entityId: id, component: 'materials', value: { '*': 'mag' } });
      statics.push(id);
    }
    /** The Scene view opened afresh (framing the level); every value `data-merged` takes is kept. */
    const openView = async (): Promise<void> => {
      await page.goto(editorUrlFor(be.editorUrl, variant));
      await expectRendererBackend(view, variant);
      await page.evaluate(() => {
        const el = document.querySelector('canvas.tl-viewport')!;
        const seen: string[] = [];
        (window as unknown as { __merged: string[] }).__merged = seen;
        new MutationObserver(() => {
          const v = el.getAttribute('data-merged') ?? '';
          if (seen[seen.length - 1] !== v) seen.push(v);
        }).observe(el, { attributes: true, attributeFilter: ['data-merged'] });
      });
    };
    const merged = async (): Promise<string> => (await view.getAttribute('data-merged')) ?? '';
    await openView();
    // Cells, objects drawn through them, cells still building (in the background: drawn alone until then).
    await expect.poll(merged, { timeout: 60_000, message: 'the three static models drawn as one merged cell' }).toBe('1 3 0');
    await expect.poll(async () => magentaPixels(decodePng(await view.screenshot())).length, { timeout: 30_000 }).toBeGreaterThan(40);
    // A click on the leftmost magenta object selects it: members keep their entities for picking.
    const pts = magentaPixels(decodePng(await view.screenshot())).sort((a, b) => a[0] - b[0]);
    const left = pts.filter((p) => p[0] <= pts[0]![0] + 10);
    const at = left.reduce((acc, p) => [acc[0] + p[0] / left.length, acc[1] + p[1] / left.length], [0, 0]);
    const vb = (await view.boundingBox())!;
    await page.mouse.click(vb.x + at[0] + 3, vb.y + at[1]);
    await expect(page.locator('.tl-hierarchy__list li.tl-row[aria-selected="true"]').first()).toContainText(/Static \d/, { timeout: 15_000 });
    // The selection is an outline: the selected object stays merged.
    expect(await merged()).toBe('1 3 0');
    // One moved by a command: out of the merged draw at once, back in where it is once it stays put.
    await page.evaluate(() => void ((window as unknown as { __merged: string[] }).__merged.length = 0));
    // (All three in one world cell: x > 0, z < 0.)
    await cmd('setTransform', { entityId: statics[1]!, transform: { position: [3.5, 3.5, -2.5], rotation: [0, 0, 0, 1], scale: [1, 1, 1] } });
    await expect.poll(async () => page.evaluate(() => (window as unknown as { __merged: string[] }).__merged.join(',')), { timeout: 15_000, message: 'the moved model leaves the merged draw and rejoins it' }).toMatch(/1 2 0.*1 3 0$/);
    // Still drawn (the picture merged against unmerged is compared in Play below: the Scene view's framing on open
    // depends on when the models arrive, so two opened views need not match).
    expect(magentaPixels(decodePng(await view.screenshot())).length).toBeGreaterThan(40);

    // ---- Play: only a change regroups, only a moved member is copied ----
    blue.push(String((await cmd('createEntity', { sceneId: 'scene-main', kind: 'box', name: 'Blue 4', transform: { position: [3.5, 0.5, 1] }, box: { size: [1, 1, 1], material: { color: COLORS.blue } } }))['createdId']));
    const red0 = String((await query('queryEntities', { limit: 100, offset: 0 }) as { entities: { id: string; name: string }[] }).entities.find((e) => e.name === 'Red 0')!.id);
    await cmd('createEntity', { sceneId: 'scene-main', kind: 'box', name: 'Red 4', transform: { position: [3.5, 0.5, -1] }, box: { size: [1, 1, 1], material: { color: COLORS.red } } });
    // Placements of a model with two levels (yellow near, cyan far): four within the switch distance, one beyond it.
    await cmd('setMaterial', { material: { materialId: 'near', name: 'Near', shader: 'unlit', params: {}, textures: {}, parameters: [{ key: 'tint', type: 'color', default: '#e0e020' }], graph: TINT_GRAPH } });
    await cmd('setMaterial', { material: { materialId: 'far', name: 'Far', shader: 'unlit', params: {}, textures: {}, parameters: [{ key: 'tint', type: 'color', default: '#20e0e0' }], graph: TINT_GRAPH } });
    await publishBytes(be, multiPieceGlb([{ name: 'marker', lods: [[1, 1, 1], [1, 1, 1]], colors: [[1, 1, 0], [0, 1, 1]] }]), 'model', 'markers', 'Markers');
    const levels = { mat_marker_LOD0: 'near', mat_marker_LOD1: 'far' };
    const eye: [number, number, number] = [0, 2.5, 8];
    const switchAt = lodSwitchDistance(Math.hypot(1, 1, 1) / 2, 1);
    const marker = async (name: string, at: [number, number, number]): Promise<string> => {
      const id = String((await cmd('createEntity', { sceneId: 'scene-main', kind: 'model', name, model: { asset: { assetId: 'markers' }, piece: 'marker' }, transform: { position: at } }))['createdId']);
      await cmd('setComponent', { entityId: id, component: 'materials', value: levels });
      return id;
    };
    for (const x of [-3, -1, 1, 3]) await marker(`Near ${x}`, [x, 0, eye[2] - switchAt + 3]);
    const crossing = await marker('Crossing', [0, 0, eye[2] - switchAt - 15]);
    const inside: [number, number, number] = [5, 0, eye[2] - switchAt + 3];
    // The game camera looks along -z, 10 degrees down.
    const cam = (await query('queryEntities', { limit: 100, offset: 0 }) as { entities: { id: string; components: Record<string, unknown> }[] }).entities.find((e) => e.components['virtualCamera'] !== undefined)!.id;
    await cmd('setTransform', { entityId: cam, transform: { position: eye, rotation: [-0.0871557, 0, 0, 0.9961947] } });
    const driver = String((await cmd('createEntity', { sceneId: 'scene-main', parentId: null, kind: 'group', name: 'Driver', transform: { position: [0, -10, 0] } }))['createdId']);
    await publishScript(be, 'driver', DRIVER, driver);

    const api = async (path: string, body: unknown = {}): Promise<{ status: number; json: Record<string, unknown> }> => {
      const r = await fetch(`${be.origin}/api/v1/projects/${be.projectId}/${path}`, { method: 'POST', headers: { authorization: `Bearer ${be.token}`, origin: be.origin, 'content-type': 'application/json' }, body: JSON.stringify(body) });
      return { status: r.status, json: (await r.json()) as Record<string, unknown> };
    };
    /** Play from the editor (batched or not); the three steps; the settled picture. */
    const play = async (batched: boolean): Promise<{ img: Image; png: Buffer }> => {
      await page.goto(editorUrlFor(batched ? be.editorUrl : be.editorUrl.replace('#', '&batching=off#'), variant));
      await expect(page.locator('.tl-statusbar')).toContainText('connected');
      const started = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().endsWith('/play'));
      await page.getByTitle('Start an isolated play preview').click();
      const psid = String(((await (await started).json()) as { playSessionId: string }).playSessionId);
      const canvas = page.frameLocator('iframe.tl-app__preview-frame').locator('canvas').first();
      await expectRendererBackend(canvas, variant);
      await expect.poll(async () => (await api(`play/${psid}/observe`)).json['state'], { timeout: 60_000 }).toBe('running');
      const batching = async (): Promise<Batching | undefined> => ((await api(`play/${psid}/diagnostics`)).json as { diagnostics?: { renderer?: { batching?: Batching } } }).diagnostics?.renderer?.batching;
      const send = async (name: string, args: Record<string, unknown>): Promise<void> => {
        const r = await api(`play/${psid}/control`, { command: 'debugCommand', name, args });
        expect(r.status, JSON.stringify(r.json).slice(0, 300)).toBe(200);
      };
      const steps: [string, Record<string, unknown>, number][] = [
        ['place', { id: red0, x: -3.5, y: 2.5, z: -1 }, 0],
        ['hide', { id: blue[1]! }, 1],
        ['place', { id: crossing, x: inside[0], y: inside[1], z: inside[2] }, 2],
      ];
      if (!batched) {
        for (const [name, args] of steps) await send(name, args);
        await send('hide', { id: statics[0]! });
        return settledShot(canvas);
      }
      // The static models: merged at load, every level copied.
      await expect.poll(async () => { const m = (await batching())?.merging; return m === undefined ? '' : `${m.cells} ${m.merged} ${m.slots}`; }, { timeout: 30_000 }).toBe('1 3 6');
      // Red and blue batched (five each), the near level (four); the far placement drawn alone.
      await expect.poll(async () => { const b = await batching(); return b === undefined ? '' : `${b.groups} ${b.batched}`; }, { timeout: 60_000 }).toBe('3 14');
      // Idle: no regroup and no matrix copy, frame after frame.
      await expect.poll(async () => { const b = await batching(); return `${b?.regroups} ${b?.matrixCopies}`; }, { timeout: 15_000 }).toBe('0 0');
      const idle = (await batching())!;
      await page.waitForTimeout(1500);
      const still = (await batching())!;
      expect([still.regroupsTotal, still.matrixCopiesTotal], 'an idle static scene regroups and copies nothing').toEqual([idle.regroupsTotal, idle.matrixCopiesTotal]);
      let before = still;
      for (const [name, args, regroups] of steps) {
        await send(name, args);
        await expect.poll(async () => { const b = (await batching())!; return b.regroupsTotal + b.matrixCopiesTotal; }, { timeout: 15_000, message: `${name} reaches the batcher` }).toBeGreaterThan(before.regroupsTotal + before.matrixCopiesTotal);
        // Settled (the move is drawn over a frame or two between simulation steps).
        await page.waitForTimeout(1000);
        const after = (await batching())!;
        console.log(`[batch-dispose] ${name} ${JSON.stringify(args)}: ${after.regroupsTotal - before.regroupsTotal} regroups, ${after.matrixCopiesTotal - before.matrixCopiesTotal} matrix copies`);
        expect(after.regroupsTotal - before.regroupsTotal, `${name}: the regroups of its own groups only`).toBe(regroups);
        expect(after.matrixCopiesTotal - before.matrixCopiesTotal, `${name}: its own matrices only`).toBeGreaterThanOrEqual(regroups === 2 ? 0 : 1);
        expect(after.matrixCopiesTotal - before.matrixCopiesTotal, `${name}: its own matrices only`).toBeLessThanOrEqual(6);
        before = after;
      }
      // Blue lost one; the near level gained the placement that crossed.
      expect(`${before.groups} ${before.batched}`).toBe('3 14');
      // A static model a script hides leaves the merged draw (its copy stays for when it is shown again).
      await send('hide', { id: statics[0]! });
      await expect.poll(async () => { const m = (await batching())?.merging; return `${m?.cells} ${m?.merged} ${m?.slots}`; }, { timeout: 15_000 }).toBe('1 2 6');
      const m = (await batching())!.merging!;
      console.log(`[batch-dispose] Play merging: ${JSON.stringify(m)}`);
      expect(m.buildsTotal, 'hiding rewrites the index only').toBe(1);
      return settledShot(canvas);
    };
    const batchedShot = await play(true);
    await page.getByTitle('Stop the play preview').click();
    const singleShot = await play(false);
    const d = diff(batchedShot.img, singleShot.img, STRICT);
    const out = test.info().outputPath();
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, 'play-batched.png'), batchedShot.png);
    if (!within(d, STRICT)) writeFileSync(join(out, 'diff.png'), diffPng(batchedShot.img, singleShot.img));
    console.log(`[batch-dispose] Play after the steps, batched vs one draw per object: ${show(d, STRICT)}`);
    expect(within(d, STRICT), show(d, STRICT)).toBe(true);
    await page.getByTitle('Stop the play preview').click();
    expect(validation, 'no WebGPU validation errors').toEqual([]);
  });
}

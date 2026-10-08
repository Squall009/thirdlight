/**
 * A heightfield terrain drawn by the renderer (CDLOD over its tiles' texture
 * arrays) against a real backend, in the Scene view, Play and the static
 * export, on WebGPU and WebGL 2 (one backend for both: each renderer is a
 * pass of the same test).
 *
 * The terrain: 8 × 8 tiles of 65 samples 0.5 m apart (256 m square), its
 * heights an uploaded RAW heightmap of rolling bumps (finer ones on top, so
 * the levels' shapes differ and morph); it wears the
 * height-blended layers material (the three texture arrays packed through the
 * pack route; layer 1 red, layer 3 blue), a disc painted layer 3 by
 * `editTerrain`, and the sky a cyan nothing on the terrain has.
 *
 * - Scene view: every tile read and uploaded and the quadtree's three levels
 *   drawn in one draw (its published `data-terrain`); red where unpainted,
 *   blue on the painted disc (world points
 *   projected through the view's published matrix); a holes stroke then cuts
 *   a disc while the page is open (its tile's layers uploaded again): the sky
 *   shows through it.
 * - Play and the export: the scene camera looks down at the terrain from 22 m
 *   with the sky out of frame, over the finest level's reach and the next
 *   (the levels meet in view, and 64 tiles' seams): red and blue show, and
 *   the only sky pixels are the hole's — one compact blob, no crack along a
 *   level or tile boundary.
 * - Any number of layers: the albedo array has a fifth layer (yellow), and a
 *   second disc is painted layer index 4; it shows yellow (the material reads
 *   each pixel's layer indices) in the Scene view and Play.
 * - Collision (3D, Play on both renderers): a player stands on the terrain at
 *   its height (a flattened strip), walks forward into the hole and falls
 *   through it; the simulation's terrain colliders and the page's decoded
 *   tiles show in Play's diagnostics.
 * - A 1,025² tile far out of view (its own terrain) is packed on a worker and
 *   uploaded over several frames in the Scene view and Play: no frame spends
 *   more than a few milliseconds of the page's time on it (the upload peak).
 * - The Terrain tools (the Inspector of a selected terrain, both renderers):
 *   raise, paint (and noise, smooth, a ramp: read back only) and a holes click previewed on the GPU
 *   while the pointer is held, then stored as one `editTerrain` each; the
 *   preview read back against the stored tiles (`?terrainCheck=1`: heights
 *   to a step, paint to a few weight bytes, holes exactly) and the pixels
 *   before and after the stored tiles replaced it; undo and redo; the brush
 *   cursor on the ground under the pointer. On the first renderer also a new
 *   terrain from the GameObject menu, the heightmap import dialog and a block
 *   layer converted (each undone). Then a 64 m raise on the 1,025² tile: the
 *   preview's main-thread time per frame, the page's frames meanwhile, the
 *   commit's round trip and how long until the stored tile replaced it.
 * - Material rules (first renderer, through the editor): the terrain's
 *   Material rules paint layer 3 (magenta) where the ground is steeper than
 *   the bumps ever get, so a steep ramp turns magenta while the disc painted
 *   by hand on it stays blue, through a second bake too; the block layer's
 *   Rules paint the same rule onto its walls and a steep top while its flat
 *   top keeps layer 0 (red). The layer table gives layer 5 settings of its
 *   own and sets layer 3's projection. Then the Scene view (second
 *   renderer), Play and the export (both) show the magenta ramp and walls
 *   beside the blue disc and red tops; along the ramp layer 3's checker
 *   repeats about three times as often projected by slope (the side plane:
 *   the ramp's 9 m height) or biplanar as from the top (its 3 m depth).
 * - Far ground: in Play and the export the ground's tiles past 30 m are
 *   drawn from their baked macro textures (every tile baked, far nodes drawn
 *   from them throughout the frame taken: Play's diagnostics); the frames
 *   show the same layers, discs, ramp and hole, without a crack.
 * - Scatter rules (first renderer, through the editor): on a disc painted
 *   layer 2 (green), the terrain's Scatter rules place orange posts where the
 *   ground is gentler than 30° (none on the disc's steep bumps, read back by
 *   position) and white tufts as ground cover; the Scatter brush takes the
 *   posts off a patch (undone after); a small block terrace's Scatter puts
 *   posts on its flat tops, none on its sloped cell. Play and the export
 *   (both renderers) show the posts and, near their camera, the tufts.
 * - Scatter copies in the game (Play, both renderers): the posts collide
 *   (their model's `_COL`, the rule's Collides box): posts put by hand across
 *   the player's strip stop the player walking into them; a script names the
 *   copies by address (`ctx.scatter.near`) and hides them on a key (the posts
 *   leave the frame, the simulation's and the renderer's counts follow), then
 *   shows them again. A second Play draws every terrain post as its impostor
 *   (the rule's Impostor below, set in the dialog): baked once, the copies at
 *   the impostor's level, the posts' pixels as many and as orange as the
 *   meshes'.
 * - Splines: a road (one command: the terrain flattened and painted under it,
 *   the posts' scatter kept off it) and a river (the terrain's bed carved, its
 *   water mesh made with the river template, posts along its bank). The
 *   Scene view (both renderers), Play and the export show the road yellow with
 *   no post on it and the river's water blue; Play draws the river's mesh and
 *   posts and the simulation has the posts' colliders. On the first renderer
 *   the road's point grip is dragged across the ground in the Scene view: one
 *   command moves it and shapes the terrain again; one undo puts it back.
 * - Edit layers (Scene view, both renderers): on the first renderer through the
 *   editor — the Stamp tool places a cone (a texture asset) 20 m high into a new
 *   stamps layer with a click (one command: the mountain stands where it was
 *   clicked, its steep flanks magenta from the rules baked after it), the Erode
 *   tool erodes the square round it (one command, its result an erosion layer),
 *   and the Layers list switches the erosion off and on. On both renderers the
 *   pictures with each layer on and off differ where the mountain and its
 *   channels are; the layers are then switched off for Play and the export.
 * - Blocks on terrain: a block area (the plaza: 8 × 8 cells, one row of sloped tops rising 1 m along +x) stands on
 *   the terrain; on the first renderer the Layers list adds a blocks layer (one command: the ground round every
 *   block layer follows its border over the blend, the cells under them cut away), sets its blend, switches it to
 *   flatten (no holes, the ground just under the blocks) and back; it is then narrowed to the plaza by command (the
 *   other block areas get their ground back) and the terrain's texture origin is the plaza's. In Play and the
 *   export (both renderers) no sky shows round the plaza and the ground's colour just outside its border is the
 *   blocks' just inside (the plaza's blue carried across, the same lighting and texture place); in the first Play a
 *   script reads the ground across the plaza (`ctx.surface`: the plaza's tops and blue on it, the terrain and the blue
 *   carried across round it; the backend's `querySurface` the same) and a player put west of it walks
 *   east across it and off again without sinking or catching on the seam.
 * - World streaming (the impostors' Play on both renderers, and the export): the
 *   ground streams round the camera — only the tiles within its render ring
 *   resident, the overview (every tile at its coarsest level, which the build
 *   made) drawn past them without a crack; a player walks west across a tile
 *   border with a 1 m collision ring and never sinks; the camera flies 400 m
 *   off (every ground tile and block chunk let go, counted in the
 *   diagnostics) and back, and the picture is the same as before.
 */
import { join } from 'node:path';

import { expect, test } from './pw';

import { controls, startBackend, type E2EBackend } from './backend';
import { isBlue, isMagenta, isRed, type Pred } from './painted-layers';
import { decodePng, type Image } from './png';
import { expectRendererBackend } from './renderer-variants';
import { serveDir, type CameraView, type V3 } from './frame-reading';

import { BACKENDS, BLOCKS_AT, type Diagnostics, FIFTH, HOLE, MACRO_DISTANCE, type Observation, PAINTED, PLAIN, POST_IMPOSTOR_SIZE, RAMP_DISC, RAMP_MID, RIVER_LOOK, ROAD_AT, ROAD_LOOK, STRIP_HEIGHT, TILES, type TerrainDiag, bigNoise, buildTerrain, checkCrossings, cmd, editLayers, expectFrame, expectHorizonLight, expectRiver, expectRoad, expectSeam, frameOk, isOrange, isYellow, materialRules, postBand, relay, roadHandle, scatterRules, screenOf, seamPoints, setLayer3, setPostsImpostor, shareNear, streamed, streamingPlay, surface, surfaceAcrossPlaza, terrainTools, useBackend, viewport, walkAcrossPlaza, zoomedOutTo } from './terrain-cdlod-steps';

let be: E2EBackend | null = null;
test.afterEach(async () => {
  await be?.stop();
  be = null;
  useBackend(null);
});

test('terrain: CDLOD heights, layered material, paint and a hole in the Scene view, Play and the export, without cracks (WebGPU and WebGL 2)', async ({ page }) => {
  test.skip(test.info().project.name === 'webgpu', 'one pass covers both renderers');
  test.setTimeout(420_000);
  be = await startBackend('terrain-cdlod');
  useBackend(be);
  const { ground, big, blocks, terrace, road, plaza } = await buildTerrain();
  const plain = await surface(ground, ...PLAIN);
  const painted = await surface(ground, ...PAINTED);
  const holeAt: V3 = [HOLE[0], (await surface(ground, ...HOLE))[1], HOLE[1]];
  const fifth = await surface(ground, ...FIFTH);
  let holed = false;
  let roadCam: CameraView | null = null;
  let seam: { p: V3; q: V3; b: V3 }[] | null = null;

  for (const renderer of BACKENDS) {
    await page.goto(be.editorUrl.replace('#', `&renderer=${renderer}&terrainCheck=1#`));
    await expect(page.locator('.tl-statusbar')).toContainText('connected');
    const canvas = page.locator('canvas.tl-viewport');
    await expect.poll(() => canvas.evaluate((c) => `${c.getAttribute('data-tl-renderer')}/${c.getAttribute('data-tl-renderer-state')}`), { timeout: 30_000 }).toBe(`${renderer}/ready`);
    await expect(viewport(page)).toHaveAttribute('data-view-proj', /\[/);
    // Every tile read and uploaded, one draw for the page of tiles, nothing failed to read.
    const terrain = async (): Promise<TerrainDiag> => JSON.parse((await viewport(page).getAttribute('data-terrain')) ?? '{"tilesDrawn":0,"draws":0,"perLevel":[],"errors":[]}');
    // The 64 tiles and the far 1,025² one.
    await expect.poll(async () => (await terrain()).tilesDrawn, { timeout: 60_000 }).toBe(TILES * TILES + 1);
    const t = await terrain();
    // One page per terrain: the 64 tiles' and the far tile's (a tile's root is always selected: shadow maps draw it).
    expect(t.draws).toBe(2);
    expect(t.errors).toEqual([]);
    // Packed on a worker, uploaded a layer texture at a time: no frame spent more than a few milliseconds of the page's time on it.
    test.info().annotations.push({ type: `${renderer} Scene view terrain`, description: JSON.stringify({ uploadMsPeak: t.uploadMsPeak, uploadBytesPeak: t.uploadBytesPeak, decodeMs: t.decodeMs, packMs: t.packMs, cpuBytes: t.cpuBytes }) });
    expect(t.uploadMsPeak!, 'the most a frame spent uploading').toBeLessThan(8);
    expect(t.uploadBytesPeak!, 'the most a frame uploaded (one 1,025² layer texture)').toBeLessThanOrEqual(1025 * 1025 * 4);
    // The quadtree's three levels (8, 16, 32 m nodes) are all drawn; the far tile (seven levels) only at its root.
    expect(t.perLevel.length).toBe(7);
    expect(t.perLevel.slice(0, 3).every((n) => n > 0)).toBe(true);
    // The Scene view: the layered material's layer 1 where unpainted, layer 3 on the painted disc.
    await expect.poll(() => shareNear(page, plain, isRed), { timeout: 60_000, message: `${renderer} Scene view: red ground` }).toBeGreaterThan(0.8);
    await expect.poll(() => shareNear(page, painted, isBlue), { timeout: 30_000, message: `${renderer} Scene view: the painted disc` }).toBeGreaterThan(0.8);
    // Layer index 4: past the template's four slots, drawn from the array's fifth layer.
    await expect.poll(() => shareNear(page, fifth, isYellow), { timeout: 30_000, message: `${renderer} Scene view: the fifth layer's disc` }).toBeGreaterThan(0.8);
    // The road the spline flattened and painted (yellow), and the river's water (blue): the view zooms out until both are
    // in it, then back.
    await zoomedOutTo(page, [...ROAD_LOOK.map(([x, z]) => [x, ROAD_AT[1], z] as V3), RIVER_LOOK], async () => {
      for (const [x, z] of ROAD_LOOK) await expect.poll(() => shareNear(page, [x, ROAD_AT[1], z], isYellow, 6), { timeout: 30_000, message: `${renderer} Scene view: the road at (${x}, ${z})` }).toBeGreaterThan(0.6);
      await expect.poll(() => shareNear(page, RIVER_LOOK, isBlue, 6), { timeout: 30_000, message: `${renderer} Scene view: the river's water` }).toBeGreaterThan(0.6);
    });
    if (!holed) {
      expect(await shareNear(page, holeAt, (r, g, b) => isRed(r, g, b) || isBlue(r, g, b))).toBeGreaterThan(0.8);
      // A holes stroke with the page open: its tile's layers are uploaded again and the ground there is cut away.
      await cmd('editTerrain', { entityId: ground, kind: 'holes', dabs: [HOLE], radius: 3 });
      holed = true;
    }
    await expect.poll(() => shareNear(page, holeAt, (r, g, b) => !isRed(r, g, b) && !isBlue(r, g, b)), { timeout: 30_000, message: `${renderer} Scene view: the hole` }).toBeGreaterThan(0.6);

    // The 1,025² tile sculpted with the page open: packed on the worker, its 12.6 MB of texels uploaded over a few frames.
    // The page's frames meanwhile (a rAF loop beside the view's) are recorded; what the uploads took of each is asserted.
    const uploaded = (await terrain()).tilesUploaded!;
    await page.evaluate(() => {
      const w = window as unknown as { __tlFrames?: number[] };
      const frames: number[] = (w.__tlFrames = []);
      let last = performance.now();
      const tick = (now: number): void => {
        frames.push(now - last);
        last = now;
        if (frames.length < 2000) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    await bigNoise(big, renderer === 'webgpu' ? 8 : 9);
    await expect.poll(async () => (await terrain()).tilesUploaded!, { timeout: 30_000, message: `${renderer} Scene view: the sculpted 1,025² tile uploaded again` }).toBeGreaterThan(uploaded);
    const rafFrames = await page.evaluate(() => (window as unknown as { __tlFrames: number[] }).__tlFrames.splice(0));
    const after = await terrain();
    test.info().annotations.push({ type: `${renderer} Scene view 1,025² re-upload`, description: JSON.stringify({ frames: rafFrames.length, maxMs: Math.round(Math.max(...rafFrames) * 10) / 10, missedVsync: rafFrames.filter((f) => f > 25).length, uploadMsPeak: after.uploadMsPeak, uploadBytesPeak: after.uploadBytesPeak, decodeMs: after.decodeMs, packMs: after.packMs }) });
    expect(after.uploadMsPeak!, 'the most a frame spent uploading').toBeLessThan(8);
    expect(after.errors).toEqual([]);

    if (renderer === BACKENDS[0]) {
      // The terrain tools (their previews against the stored tiles), then the material rules from the editor.
      await terrainTools(page, renderer, ground, big, true);
      await materialRules(page, ground, blocks);
      await scatterRules(page, ground, terrace);
      await expectRoad(ground, `${renderer} (stored)`);
      await roadHandle(page, ground, road);
      await editLayers(page, renderer, ground, road, true, plaza);
    } else {
      // The rules baked on the first renderer: the steep ramp and the block walls magenta, the hand-painted disc on
      // the ramp blue, the layer's flat top red (layer 0). The view zooms out until they are all in it, then back.
      const checks: [string, V3, Pred][] = [
        ['the steep ramp', [RAMP_MID[0], (await surface(ground, ...RAMP_MID))[1], RAMP_MID[1]], isMagenta],
        ['the disc painted by hand on the ramp', [RAMP_DISC[0], (await surface(ground, ...RAMP_DISC))[1], RAMP_DISC[1]], isBlue],
        ['the block wall', [BLOCKS_AT[0] + 2.5, BLOCKS_AT[1] + 2.4, BLOCKS_AT[2] + 2], isMagenta],
        ['the block layer\'s steep top', [BLOCKS_AT[0] + 1.5, BLOCKS_AT[1] + 4.5, BLOCKS_AT[2] + 0.5], isMagenta],
        ['the block layer\'s flat top', [BLOCKS_AT[0] + 3, BLOCKS_AT[1] + 3, BLOCKS_AT[2] + 1], isRed],
      ];
      const box = (await viewport(page).boundingBox())!;
      const inView = async (): Promise<boolean> => {
        for (const [, p] of checks) {
          const q = await screenOf(page, p);
          if (!(q.x > box.x + 12 && q.x < box.x + box.width - 12 && q.y > box.y + 12 && q.y < box.y + box.height - 12)) return false;
        }
        return true;
      };
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      let zoomed = 0;
      for (; zoomed < 30 && !(await inView()); zoomed++) {
        await page.mouse.wheel(0, 200);
        await page.waitForTimeout(80);
      }
      expect(await inView(), `${renderer} Scene view: the ramp and the block layer in view`).toBe(true);
      for (const [what, p, test] of checks) {
        await expect.poll(() => shareNear(page, p, test, 6), { timeout: 30_000, message: `${renderer} Scene view: ${what}` }).toBeGreaterThan(0.6);
      }
      // Layer 3's projection on the ramp: checks counted along its middle, top against by slope and biplanar.
      const crossings: Record<string, number> = {};
      for (const [name, mode] of [['top', 0], ['by slope', 1], ['biplanar', 2]] as const) {
        await setLayer3(mode, 2);
        let n = -1;
        await expect.poll(async () => (n = await checkCrossings(page, ground)), { timeout: 30_000, message: `${renderer} Scene view: the ramp's checker, ${name}` }).toBeGreaterThan(name === 'top' ? 0 : 2 * Math.max(1, crossings['top'] ?? 1));
        crossings[name] = n;
      }
      test.info().annotations.push({ type: `${renderer} layer 3 checker crossings along the ramp`, description: JSON.stringify(crossings) });
      console.log(`${renderer} layer 3 checker crossings along the ramp: ${JSON.stringify(crossings)}`);
      for (let i = 0; i < zoomed; i++) {
        await page.mouse.wheel(0, -200);
        await page.waitForTimeout(80);
      }
      await terrainTools(page, renderer, ground, big, false);
      await editLayers(page, renderer, ground, road, false, plaza);
    }

    // In Play (and the export), tiles past MACRO_DISTANCE are drawn from their baked macro textures.
    await cmd('setComponent', { entityId: ground, component: 'terrain', value: { macroDistance: MACRO_DISTANCE } });
    // The posts across the player's strip, for this renderer's Plays.
    const band = await postBand(ground, true);
    // Play: the scene camera's frame.
    const started = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().endsWith('/play'));
    await page.getByTitle('Start an isolated play preview').click();
    const psid = String(((await (await started).json()) as { playSessionId: string }).playSessionId);
    {
      // Every tile of the ground baked, and the far nodes drawn from them, before the frame is judged.
      let m: TerrainDiag['macro'] | undefined;
      await expect
        .poll(async () => {
          m = (((await relay(`${psid}/diagnostics`, {})).json as { diagnostics?: Diagnostics }).diagnostics ?? {}).renderer?.terrain?.macro;
          return m !== undefined && m.baked >= TILES * TILES && m.farNodes > 0;
        }, { timeout: 60_000, message: `${renderer} Play: the macro textures baked and drawn` })
        .toBe(true);
      test.info().annotations.push({ type: `${renderer} Play macro`, description: JSON.stringify(m) });
      console.log(`${renderer} Play macro: ${JSON.stringify(m)}`);
    }
    {
      // The scatter: the posts drawn from their stored copies, the tufts made near the camera (on the view worker).
      let d: Record<string, unknown> | undefined;
      await expect
        .poll(async () => {
          d = (((await relay(`${psid}/diagnostics`, {})).json as { diagnostics?: { renderer?: Record<string, unknown> } }).diagnostics ?? {}).renderer;
          const sc = d?.['scatter'] as { copies?: number } | undefined;
          const cv = d?.['cover'] as { copies?: number } | undefined;
          return (sc?.copies ?? 0) > 10 && (cv?.copies ?? 0) > 10;
        }, { timeout: 60_000, message: `${renderer} Play: the scatter drawn and the ground cover made` })
        .toBe(true)
        .catch((e: Error) => {
          console.log(`${renderer} Play scatter: ${JSON.stringify({ scatter: d?.['scatter'], cover: d?.['cover'] })}`);
          throw e;
        });
      console.log(`${renderer} Play scatter: ${JSON.stringify({ scatter: d?.['scatter'], cover: d?.['cover'] })}`);
    }
    let last: Image | null = null;
    // A frame counts only while every tile's bake is current and far nodes are drawn from them throughout.
    const macroNow = async (): Promise<string> => {
      const m = (((await relay(`${psid}/diagnostics`, {})).json as { diagnostics?: Diagnostics }).diagnostics ?? {}).renderer?.terrain?.macro;
      return m !== undefined && m.waiting === 0 && m.baked >= TILES * TILES && m.farNodes > 0 ? `${m.bakes}` : 'not drawn from macro textures';
    };
    await expect
      .poll(async () => {
        const before = await macroNow();
        // Full size: a crack is a pixel wide.
        const shot = await relay(`${psid}/screenshot`, { maxWidth: 2048 });
        if (shot.status !== 200) return false;
        last = decodePng(Buffer.from(String(shot.json['dataUrl'] ?? '').split(',')[1] ?? '', 'base64'));
        if (before.startsWith('not') || (await macroNow()) !== before) return false;
        return frameOk(last);
      }, { timeout: 90_000, message: `${renderer} Play: the terrain with its layers and hole` })
      .toBe(true)
      .catch((e: Error) => {
        if (last !== null) expectFrame(last, `${renderer} Play`);
        throw e;
      });
    expectFrame(last!, `${renderer} Play`);
    // The road and the river in Play's frame, where the scene camera sees them.
    roadCam = ((await relay(`${psid}/observe`, {})).json as { camera?: CameraView }).camera ?? null;
    expect(roadCam, `${renderer} Play: the camera observed`).not.toBeNull();
    await expectRoad(ground, `${renderer} Play`, { img: last!, cam: roadCam! });
    expectRiver(last!, roadCam!, `${renderer} Play`);
    // The plaza's seam: no sky round it, the ground's colour across its border the blocks'.
    seam ??= await seamPoints(ground);
    expectSeam(last!, roadCam!, seam, `${renderer} Play`);
    {
      // The river's mesh pieces and posts drawn, the posts' colliders in the simulation (the water has none).
      type SplineDiag = { renderer?: { splines?: { meshPieces: number; triangles: number; copies: number; errors: string[] } }; runtime?: { splines?: { colliders: number; waiting: number } } };
      let sd: SplineDiag = {};
      await expect
        .poll(async () => {
          sd = ((await relay(`${psid}/diagnostics`, {})).json as { diagnostics?: SplineDiag }).diagnostics ?? {};
          return `${(sd.renderer?.splines?.meshPieces ?? 0) > 0} ${sd.renderer?.splines?.copies ?? 0} ${sd.runtime?.splines?.colliders ?? 0}`;
        }, { timeout: 30_000, message: `${renderer} Play: the river's mesh, posts and their colliders` })
        .toBe('true 6 6');
      const shown = { renderer: sd.renderer?.splines, runtime: sd.runtime?.splines };
      test.info().annotations.push({ type: `${renderer} Play splines`, description: JSON.stringify(shown) });
      console.log(`${renderer} Play splines: ${JSON.stringify(shown)}`);
    }

    // Play's diagnostics: the tiles drawn (the far one too), the page's decoded copy, the simulation's colliders.
    let diag: Diagnostics = {};
    await expect
      .poll(async () => {
        diag = ((await relay(`${psid}/diagnostics`, {})).json as { diagnostics?: Diagnostics }).diagnostics ?? {};
        return `${diag.renderer?.terrain?.tilesDrawn ?? 0} ${diag.runtime?.terrainMemory?.waiting ?? -1}`;
      }, { timeout: 60_000, message: `${renderer} Play: every tile drawn and every collider built` })
      .toBe(`${TILES * TILES + 1} 0`);
    const mem = diag.runtime!.terrainMemory!;
    test.info().annotations.push({ type: `${renderer} Play terrain`, description: JSON.stringify({ renderer: diag.renderer!.terrain, collision: mem }) });
    // Every tile has colliders (the holed one in patches); the page holds one decoded copy (65 tiles' worth).
    expect(mem.tilesWithColliders).toBe(TILES * TILES + 1);
    expect(mem.colliders).toBeGreaterThan(TILES * TILES + 1);
    expect(diag.renderer!.terrain!.cpuBytes!).toBeGreaterThan(1025 * 1025 * 2);
    expect(diag.renderer!.terrain!.uploadMsPeak!).toBeLessThan(8);

    // The script names the scatter copies by address and hides them (the jump key): the posts leave the frame (the
    // pixels orange before and not after are theirs), the simulation and the renderer count them hidden; the key
    // again shows them.
    const frameNow = async (sid: string): Promise<Image | null> => {
      const s = await relay(`${sid}/screenshot`, { maxWidth: 1024 });
      return s.status === 200 ? decodePng(Buffer.from(String(s.json['dataUrl'] ?? '').split(',')[1] ?? '', 'base64')) : null;
    };
    const jump = async (sid: string): Promise<void> => {
      const r = await relay(`${sid}/input`, { mode: 'exclusive-test', frames: [{ stepOffset: 0, ...controls(0, 'pressed') }] });
      expect(r.status, JSON.stringify(r.json)).toBe(200);
    };
    type ScatterDiag = { runtime?: { scatterCopies?: { hidden: number; colliders: number; copies: number } }; renderer?: { scatter?: { hidden: number; copies: number; instances: { byLevel: number[] }; impostors?: { baked: number; bytes: number; bakeMsMax: number } } } };
    const sdiag = async (sid: string): Promise<ScatterDiag> => ((await relay(`${sid}/diagnostics`, {})).json as { diagnostics?: ScatterDiag }).diagnostics ?? {};
    /** The posts' pixels: orange with them shown, not with them hidden (the frame's other orange stays), and their mean colour. */
    const posts = async (sid: string, what: string): Promise<{ n: number; tint: [number, number, number] }> => {
      const shownImg = (await frameNow(sid))!;
      await jump(sid);
      let d: ScatterDiag = {};
      await expect.poll(async () => {
        d = await sdiag(sid);
        return (d.runtime?.scatterCopies?.hidden ?? 0) > 0 && d.renderer?.scatter?.hidden === d.runtime?.scatterCopies?.hidden;
      }, { timeout: 30_000, message: `${what}: the hidden copies counted by the simulation and the renderer` }).toBe(true);
      let out = { n: 0, tint: [0, 0, 0] as [number, number, number] };
      await expect.poll(async () => {
        const hiddenImg = await frameNow(sid);
        if (hiddenImg === null) return 0;
        const sum = [0, 0, 0];
        let n = 0;
        for (let y = 0; y < shownImg.height; y++) for (let x = 0; x < shownImg.width; x++) {
          const p = shownImg.pixel(x, y);
          if (!isOrange(...p) || isOrange(...hiddenImg.pixel(x, y))) continue;
          sum[0] += p[0];
          sum[1] += p[1];
          sum[2] += p[2];
          n += 1;
        }
        out = { n, tint: [sum[0]! / Math.max(1, n), sum[1]! / Math.max(1, n), sum[2]! / Math.max(1, n)] };
        return n;
      }, { timeout: 30_000, message: `${what}: the script hid the posts` }).toBeGreaterThan(60);
      test.info().annotations.push({ type: `${what} scatter hidden`, description: JSON.stringify({ postPixels: out.n, runtime: d.runtime?.scatterCopies, renderer: d.renderer?.scatter?.hidden }) });
      console.log(`${what}: the script hid ${d.runtime?.scatterCopies?.hidden} copies by address (the renderer ${d.renderer?.scatter?.hidden}), ${out.n} post pixels left the frame`);
      await jump(sid);
      await expect.poll(async () => (await sdiag(sid)).renderer?.scatter?.hidden ?? -1, { timeout: 30_000, message: `${what}: the script showed the posts again` }).toBe(0);
      return out;
    };
    const meshPosts = await posts(psid, `${renderer} Play`);

    // The player stands on the terrain, walks back (+z) into the posts across the strip (they collide), then forward
    // (−z) into the hole and falls through it.
    const read = async (): Promise<Observation | null> => {
      const r = await relay(`${psid}/observe`, {});
      return r.status === 200 ? (r.json as unknown as Observation) : null;
    };
    const standing: { o: Observation | null } = { o: null };
    await expect
      .poll(async () => {
        const o = await read();
        const before = standing.o;
        const same = o?.player !== undefined && before?.player !== undefined && Math.abs(o.player.y - before.player.y) < 1e-4 && (o.stepIndex ?? 0) > (before.stepIndex ?? 0);
        standing.o = o;
        return same;
      }, { timeout: 30_000, intervals: [250], message: `${renderer} Play: the player at rest` })
      .toBe(true);
    const at = standing.o!.player!;
    expect(Math.abs(at.y - (STRIP_HEIGHT + 0.9)), `${renderer} Play: standing on the terrain (at y ${at.y})`).toBeLessThan(0.05);
    {
      // Two seconds back toward the band of posts (a second a request: the relay's body bound): about 8 m at the
      // walking speed, through it were it not solid.
      const back = Array.from({ length: 120 }, (_, k) => ({ stepOffset: k, ...controls(0, 'none', -1) }));
      for (let leg = 0; leg < 2; leg++) {
        const r = await relay(`${psid}/input`, { mode: 'exclusive-test', frames: back });
        expect(r.status, JSON.stringify(r.json)).toBe(200);
        await page.waitForTimeout(1200);
      }
      await expect.poll(async () => (await read())?.player?.z ?? at.z, { timeout: 30_000, message: `${renderer} Play: walking back` }).toBeGreaterThan(at.z + 0.5);
      await page.waitForTimeout(1000);
      const stopped = (await read())!.player!;
      const colliders = (await sdiag(psid)).runtime?.scatterCopies?.colliders ?? 0;
      test.info().annotations.push({ type: `${renderer} Play scatter collision`, description: JSON.stringify({ from: at.z, stopped: stopped.z, band, colliders }) });
      console.log(`${renderer} Play scatter collision: from z ${at.z.toFixed(2)} stopped at ${stopped.z.toFixed(2)}, the band z ${band[0].toFixed(2)}–${band[1].toFixed(2)}, ${colliders} copy colliders`);
      expect(stopped.z, `${renderer} Play: the posts across the strip (z ${band[0].toFixed(2)}–${band[1].toFixed(2)}) stopped the player`).toBeLessThan(band[1]);
      expect(colliders, `${renderer} Play: the posts' colliders`).toBeGreaterThan(8);
    }
    // A second of forward a request (the relay's body bound), until it is in the hole (about 5 m at the walking speed).
    const frames = Array.from({ length: 120 }, (_, k) => ({ stepOffset: k, ...controls(0, 'none', 1) }));
    for (let leg = 0; leg < 4 && ((await read())?.player?.y ?? 0) > STRIP_HEIGHT - 0.5; leg++) {
      const from = (await read())!.player!.z;
      const walk = await relay(`${psid}/input`, { mode: 'exclusive-test', frames });
      expect(walk.status, JSON.stringify(walk.json)).toBe(200);
      // The leg walked (or the ground gave way).
      await expect.poll(async () => {
        const p = (await read())?.player;
        return p !== undefined && (p.z < from - 1.5 || p.y < STRIP_HEIGHT - 0.5);
      }, { timeout: 30_000, message: `${renderer} Play: walking forward (leg ${leg + 1})` }).toBe(true);
      await page.waitForTimeout(1200);
    }
    await expect.poll(async () => (await read())?.player?.y ?? Infinity, { timeout: 30_000, message: `${renderer} Play: fell through the hole` }).toBeLessThan(STRIP_HEIGHT - 3);
    const fell = (await read())!.player!;
    expect(fell.z, `${renderer} Play: it went forward into the hole`).toBeLessThan(HOLE[1] + 3.5);
    if (renderer === BACKENDS[0]) {
      await surfaceAcrossPlaza(psid, ground, plaza, renderer);
      await walkAcrossPlaza(psid, ground, renderer);
    }

    // A second Play with every post drawn as its impostor (the rule's size 1: smaller than the whole view, so at any
    // distance): baked once, every copy at the impostor's level, the posts' pixels as many and as orange as the
    // meshes' were (both found the same way: shown against hidden by the script).
    await setPostsImpostor(ground, 1);
    // The second Play streams the ground and the block layers round the camera (the export does too).
    await streamed([ground], [blocks, terrace], true);
    await page.getByTitle('Stop the play preview').click();
    await expect(page.getByTitle('Start an isolated play preview')).toBeVisible({ timeout: 30_000 });
    const restarted = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().endsWith('/play'));
    await page.getByTitle('Start an isolated play preview').click();
    const psid2 = String(((await (await restarted).json()) as { playSessionId: string }).playSessionId);
    let far: ScatterDiag = {};
    await expect
      .poll(async () => {
        far = await sdiag(psid2);
        const sc = far.renderer?.scatter;
        // The terrain's posts at the impostor's level (the terrace's own rule keeps its meshes).
        return (sc?.impostors?.baked ?? 0) >= 1 && (sc?.instances.byLevel[1] ?? 0) > 10;
      }, { timeout: 60_000, message: `${renderer} Play: the posts drawn as impostors` })
      .toBe(true)
      .catch((e: Error) => {
        console.log(`${renderer} Play impostors: ${JSON.stringify(far.renderer?.scatter)}`);
        throw e;
      });
    // The frame once the impostors are in (settled: two frames alike).
    await page.waitForTimeout(1000);
    const farPosts = await posts(psid2, `${renderer} Play (impostors)`);
    const ratio = farPosts.n / meshPosts.n;
    test.info().annotations.push({ type: `${renderer} Play impostors`, description: JSON.stringify({ meshPixels: meshPosts.n, impostorPixels: farPosts.n, meshTint: meshPosts.tint.map(Math.round), impostorTint: farPosts.tint.map(Math.round), impostors: far.renderer?.scatter?.impostors }) });
    console.log(`${renderer} Play impostors: post pixels ${meshPosts.n} → ${farPosts.n}, tint ${meshPosts.tint.map(Math.round)} → ${farPosts.tint.map(Math.round)}, ${JSON.stringify(far.renderer?.scatter?.impostors)}`);
    expect(ratio, `${renderer} Play: the impostors' posts' pixels against the meshes'`).toBeGreaterThan(0.6);
    expect(ratio, `${renderer} Play: the impostors' posts' pixels against the meshes'`).toBeLessThan(1.6);
    for (let k = 0; k < 3; k++) expect(Math.abs(farPosts.tint[k]! - meshPosts.tint[k]!), `${renderer} Play: the impostors' orange against the meshes' (channel ${k})`).toBeLessThan(40);
    await streamingPlay(psid2, renderer);
    // The next renderer's first Play counts every tile and collider again; the last keeps streaming for the export.
    if (renderer !== BACKENDS[BACKENDS.length - 1]) await streamed([ground], [blocks, terrace], false);
    await setPostsImpostor(ground, POST_IMPOSTOR_SIZE);
    await postBand(ground, false);
    // The next renderer's Scene view draws the layers everywhere again (its checks count one draw per page); the last keeps far ground for the export.
    if (renderer !== BACKENDS[BACKENDS.length - 1]) await cmd('setComponent', { entityId: ground, component: 'terrain', value: { macroDistance: null } });
  }

  // The static export with the backend stopped, on each renderer.
  const res = await be.admin(`projects/${be.projectId}/export`);
  expect(res.status, JSON.stringify(res.json)).toBe(200);
  await be.halt();
  const site = await serveDir(join(be.exportRoot, String(res.json['outputDir'])));
  try {
    for (const renderer of BACKENDS) {
      const game = await page.context().newPage();
      const errors: string[] = [];
      game.on('pageerror', (e) => errors.push(e.message));
      try {
        await game.goto(`${site.url}?renderer=${renderer}`);
        const c = game.locator('canvas').first();
        await expectRendererBackend(c, renderer);
        let last: Image | null = null;
        await expect
          .poll(async () => {
            last = decodePng(await c.screenshot());
            return frameOk(last);
          }, { timeout: 60_000, message: `${renderer} export: the terrain with its layers and hole` })
          .toBe(true)
          .catch((e: Error) => {
            if (last !== null) expectFrame(last, `${renderer} export`);
            throw e;
          });
        expectFrame(last!, `${renderer} export`);
        // The backend is stopped: the export's frame alone.
        await expectRoad(null, `${renderer} export`, { img: last!, cam: roadCam! });
        expectRiver(last!, roadCam!, `${renderer} export`);
        expectSeam(last!, roadCam!, seam!, `${renderer} export`);
        expect(errors).toEqual([]);
        await expectHorizonLight(game, site.url, renderer, roadCam!);
      } finally {
        await game.close();
      }
    }
  } finally {
    await site.close();
  }
});

/**
 * The far ground's horizon light (the export, each renderer): the frame with it (the page as loaded, its far tiles'
 * bakes done) against the same export with `?terrainHorizon=off` — the far ground (past the macro distance) darker
 * where its horizon hides sky and sun, the near ground (drawn from its layers) the same.
 */

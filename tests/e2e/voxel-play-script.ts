/**
 * The Play project's script (voxel-world.e2e.ts's Play tests drive it by debug commands): it digs once the test asks
 * after the pit's ground is resident; on further commands it wets the ground beside the pit, saves the world into
 * the game's save slot 1 and restores it from there; casts rays; builds and reads rooms; builds the walls, the hut
 * and the other shapes the shadow and light checks read; asks for a path out of the hut; moves objects by id; places
 * and walks the character. `at`: where the character stands
 * (metres), the pad's middle.
 */
import { VOXEL_ROLE } from '@thirdlight/voxel';

import { MAT } from '../../tools/voxel-bench/world-kit';
import { GLOW_MASKED_MAT, GLOW_MAT } from './voxel-shadows';

/**
 * The structure grid's house for a path into it: where its grid stands, its cells (voxel-grid-house.ts `GRID_HOUSE`),
 * and the path's ends (world metres): on its porch, in its room.
 */
export interface GridHousePath {
  readonly position: readonly number[];
  readonly yawRad: number;
  readonly cells: { readonly w: number; readonly d: number; readonly porch: number; readonly h: number; readonly doorX: readonly number[]; readonly doorH: number };
  readonly from: readonly number[];
  readonly to: readonly number[];
  /**
   * Its door's props (object ids) with a `voxelPortal`: a leaf standing in the door, and a pane (light passes) standing
   * in the room; the pane's place in the door and the leaf's in the room are the other's (grid metres, the objects'
   * own frame: they are the house's children).
   */
  readonly door?: { readonly leaf: string; readonly pane: string; readonly inDoor: readonly number[]; readonly inRoom: readonly number[] };
}

export function playScriptSource(at: readonly number[], gridRoom?: readonly number[], gridPath?: GridHousePath): string {
  const pit = `{ center: [${at[0]}, ${at[1] - 0.25}, ${at[2]}], radius: 1.75 }`;
  const wetAt = `[${at[0] - 2.75}, ${at[1] - 0.25}, ${at[2]}]`;
  return [
    'export default {',
    '  prepare() { return {}; },',
    '  instantiate() { return { wait: -1, at: -1, dug: false }; },',
    '  step(state: any, ctx: any) {',
    "    if (ctx.phase !== 'intent') return;",
    '    const v = ctx.voxels;',
    `    const pit = ${pit};`,
    '    if (state.wait < 0) state.wait = v.whenResident(pit);',
    "    for (const w of v.waits) if (w.wait === state.wait && w.resident && state.at < 0) { state.at = ctx.stepIndex; ctx.game.add('resident', 1); }",
    "    for (const c of v.changes) ctx.game.add('changes', 1);",
    "    for (const _ of ctx.debug.command('dig')) if (!state.dug) { const r = v.dig(pit); state.dug = r.ok; ctx.game.add(r.ok ? 'dug' : 'refused', 1); }",
    // Rays from 6 m over the pad: down meets the pad's top face (a voxel with its material, the face looking up), up meets nothing.
    `    const eye = [${at[0]}, ${at[1] + 6}, ${at[2]}];`,
    "    for (const _ of ctx.debug.command('rays')) {",
    "      const down = v.raycast(eye, [0, -1, 0], 20);",
    `      const ground = down !== null && down.voxel !== null && down.voxel.material > 0 && down.normal[1] === 1 && Math.abs(down.point[1] - ${at[1]}) < 0.01 && Math.abs(down.distance - 6) < 0.01 && !down.far;`,
    "      ctx.game.add(ground ? 'rayGround' : 'rayGroundMissed', 1);",
    "      ctx.game.add(v.raycast(eye, [0, 1, 0], 500) === null ? 'raySky' : 'raySkyHit', 1);",
    "      ctx.game.add(v.raycast(eye, [0, -1, 0], 20, { stop: 'light' }) !== null ? 'rayLight' : 'rayLightMissed', 1);",
    '    }',
    // Open regions: two rooms dug under the ground behind the camera (a shell of wall voxels round them, a partition
    // with a door of opening cells), read each step once built; a shaft dug up from the first room opens it to the sky.
    `    const A = [${at[0]}, ${at[1]}, ${at[2]}];`,
    "    const box = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number) => ({ min: [A[0] + x0, A[1] + y0, A[2] + z0], max: [A[0] + x1, A[1] + y1, A[2] + z1] });",
    "    for (const _ of ctx.debug.command('rooms')) {",
    "      const r = [v.set(box(-3, -7, 9, 3, -1.5, 16), { material: 5, role: 3 }), v.dig(box(-2, -6, 10, 2, -2.5, 15)), v.set(box(-2, -6, 12.5, 2, -2.5, 12.75), { material: 5, role: 3 }), v.set(box(-0.5, -6, 12.5, 0.5, -4, 12.75), { material: 5, role: 9 })];",
    "      state.rooms = r.every((e: any) => e.ok); ctx.game.add(state.rooms ? 'roomsBuilt' : 'roomsRefused', 1);",
    '    }',
    "    for (const _ of ctx.debug.command('shaft')) { const r = v.dig(box(-0.5, -3, 10.5, 0.5, 14, 11.5)); ctx.game.add(r.ok ? 'shaftDug' : 'shaftRefused', 1); }",
    // Shadows: a wall 4 m tall on the pad west of the character (its sun shadow falls east of it), dug again; objects
    // (test boxes, a lamp) moved by id.
    '    const wall = box(-3, 0, -2, -2.5, 4, 0.5);',
    `    for (const _ of ctx.debug.command('wall')) ctx.game.add(v.set(wall, { material: ${MAT.plaster}, role: ${VOXEL_ROLE.wall} }).ok ? 'wallBuilt' : 'wallRefused', 1);`,
    "    for (const _ of ctx.debug.command('unwall')) ctx.game.add(v.dig(wall).ok ? 'wallDug' : 'wallRefused', 1);",
    // A pillar a cell square and 3 m tall between the wall and a lamp east of it: it takes the lamp's bounce off the wall.
    '    const pillar = box(-2, 0, -1.75, -1.5, 3, -1.25);',
    `    for (const _ of ctx.debug.command('pillar')) ctx.game.add(v.set(pillar, { material: ${MAT.plaster}, role: ${VOXEL_ROLE.wall} }).ok ? 'pillarBuilt' : 'pillarRefused', 1);`,
    "    for (const _ of ctx.debug.command('unpillar')) ctx.game.add(v.dig(pillar).ok ? 'pillarDug' : 'pillarRefused', 1);",
    // A long wall 8 m tall from 4 m to 38 m ahead of the character: its sun shadow runs out past the key light's map.
    '    const longWall = box(-3, 0, -38, -2, 8, -4);',
    `    for (const _ of ctx.debug.command('longwall')) ctx.game.add(v.set(longWall, { material: ${MAT.plaster}, role: ${VOXEL_ROLE.wall} }).ok ? 'longWallBuilt' : 'longWallRefused', 1);`,
    "    for (const _ of ctx.debug.command('unlongwall')) ctx.game.add(v.dig(longWall).ok ? 'longWallDug' : 'longWallRefused', 1);",
    // A hut on the pad ahead of the camera (walls and roof of plaster round a 4 × 2.5 × 7.5 m room, a floor slab): the
    // light volume's sky occlusion and bounce. Its roof opened.
    "    const hutRoof = box(-1.5, 3, 4, 1.5, 3.5, 8);",
    `    for (const _ of ctx.debug.command('hut')) { const r = [v.set(box(-2.5, 0, 2, 2.5, 3.5, 10.5), { material: ${MAT.plaster}, role: ${VOXEL_ROLE.wall} }), v.dig(box(-2, 0.5, 2.5, 2, 3, 10))]; state.hut = r.every((e: any) => e.ok); ctx.game.add(state.hut ? 'hutBuilt' : 'hutRefused', 1); }`,
    // A door of opening cells in the hut's north wall (a portal to the pad).
    `    for (const _ of ctx.debug.command('hutdoor')) ctx.game.add(v.set(box(-0.5, 0.5, 2, 0.5, 2.5, 2.2), { material: ${MAT.plaster}, role: ${VOXEL_ROLE.opening} }).ok ? 'hutDoor' : 'hutRefused', 1);`,
    "    for (const _ of ctx.debug.command('hutopen')) ctx.game.add(v.dig(hutRoof).ok ? 'hutOpened' : 'hutRefused', 1);",
    "    for (const _ of ctx.debug.command('unhut')) { state.hut = false; ctx.game.add(v.dig(box(-2.5, 0, 2, 2.5, 3.5, 10.5)).ok ? 'hutDug' : 'hutRefused', 1); }",
    // A stone stub in the hut (the test kit's material): kit pieces stand at its free ends' edges, indoors.
    "    const stub = box(-1.5, 0.5, 5, -0.5, 2.5, 5.5);",
    `    for (const _ of ctx.debug.command('hutstone')) ctx.game.add(v.set(stub, { material: ${MAT.stone}, role: ${VOXEL_ROLE.wall} }).ok ? 'stubBuilt' : 'hutRefused', 1);`,
    "    for (const _ of ctx.debug.command('unstone')) ctx.game.add(v.dig(stub).ok ? 'stubDug' : 'hutRefused', 1);",
    // A strip of the glowing test materials along the shut hut's south wall (painted: shader data; the plain one, then
    // the masked one on its last 0.75 m at +x: the stub hides the strip's −x half from the camera), and back to plaster.
    "    const glowStrip = box(-1.5, 1, 2, 1.5, 1.5, 2.5);",
    `    for (const _ of ctx.debug.command('hutglow')) ctx.game.add(v.paint(box(-1.5, 1, 2, 0.75, 1.5, 2.5), { material: ${GLOW_MAT} }).ok && v.paint(box(0.75, 1, 2, 1.5, 1.5, 2.5), { material: ${GLOW_MASKED_MAT} }).ok ? 'hutGlow' : 'hutRefused', 1);`,
    `    for (const _ of ctx.debug.command('hutunglow')) ctx.game.add(v.paint(glowStrip, { material: ${MAT.plaster} }).ok ? 'hutUnglow' : 'hutRefused', 1);`,
    // The hut's floor slab repainted (its shape as it was): the light volume's bounce takes the floor's colour.
    `    for (const _ of ctx.debug.command('hutgreen')) ctx.game.add(v.set(box(-2, 0, 2.5, 2, 0.5, 10), { material: ${MAT.grass}, role: ${VOXEL_ROLE.wall} }).ok ? 'hutGreen' : 'hutRefused', 1);`,
    // A camera made live, looking at a target (and back): the cut-away and plain views of the hut.
    "    for (const c of ctx.debug.command('cam', { description: 'Make a camera live on a target', args: [{ name: 'id', type: 'string' }, { name: 'target', type: 'string' }] })) ctx.game.add(ctx.camera.setTarget(String(c.id), String(c.target)) && ctx.camera.activate(String(c.id)) ? 'camLive' : 'camRefused', 1);",
    "    for (const c of ctx.debug.command('uncam', { description: 'Take a camera off', args: [{ name: 'id', type: 'string' }] })) ctx.game.add(ctx.camera.deactivate(String(c.id)) ? 'camOff' : 'camRefused', 1);",
    // The character placed (from rest) and pushed along a world direction for some steps: what a structure grid's
    // walls stop and its door lets through.
    "    for (const c of ctx.debug.command('cplace', { description: 'Place the character', args: [{ name: 'x', type: 'number' }, { name: 'y', type: 'number' }, { name: 'z', type: 'number' }] })) { ctx.emit({ kind: 'character_place', position: [Number(c.x), Number(c.y), Number(c.z)] }); state.walk = null; ctx.game.add('cplaced', 1); }",
    "    for (const c of ctx.debug.command('walk', { description: 'Push the character a step at a time', args: [{ name: 'x', type: 'number' }, { name: 'z', type: 'number' }, { name: 'steps', type: 'number' }] })) state.walk = { x: Number(c.x), z: Number(c.z), left: Number(c.steps) };",
    // A push a step (the character's own braking toward no input against it): a walk without taking the move input.
    "    if (state.walk && state.walk.left > 0) { state.walk.left--; ctx.character?.impulse([state.walk.x, 0, state.walk.z]); }",
    "    for (const c of ctx.debug.command('place', { description: 'Move an object', args: [{ name: 'id', type: 'string' }, { name: 'x', type: 'number' }, { name: 'y', type: 'number' }, { name: 'z', type: 'number' }] })) ctx.entity(String(c.id))?.set('transform', { position: [Number(c.x), Number(c.y), Number(c.z)] });",
    "    const put = (n: string, x: number) => ctx.game.add(n, x - ctx.game.counter(n));",
    // The hut as a room for a game: its kind, size (m³; m² × 4; mean free path in cm) and portals, and the pad outside it.
    '    if (state.hut) {',
    '      const h = v.regionAt(A[0], A[1] + 1.75, A[2] + 6.25);',
    '      const o = v.regionAt(A[0], A[1] + 6, A[2] - 4);',
    "      const list = h === null ? [] : v.portalsOf(h.id);",
    "      put('hutKind', h === null ? 0 : h.kind === 'room' ? 1 : 2); put('hutVolume', h !== null ? Math.round(h.volume) : 0); put('hutSurface4', h !== null ? Math.round(h.surface * 4) : 0); put('hutMfpCm', h !== null ? Math.round(h.meanFreePath * 100) : 0);",
    "      put('hutPortals', h?.portals ?? -1); put('hutPortalList', list.length); put('hutPortalJoins', list.length === 1 && o !== null && list[0].regions.includes(h.id) && list[0].regions.includes(o.id) ? 1 : 0); put('hutOut', o?.kind === 'outdoors' ? 1 : 0);",
    '    }',
    // A path from inside the hut (1 m off its middle) out of its door to the pad west of the pit: its status (1 found,
    // 2 partial, 3 unreachable, 4 unknown) and length (cm) once answered; the door walled up (and opened again with
    // `hutdoor`). The hut stands past the pad's edge on the hill, a cell lower outside its door than its floor: a
    // doorstep slab at the pad's height in the three cell rows before its north wall, 6 m wide past the pit's sides (the
    // hill above it dug away, the wall and its door left), takes a walker onto the pad.
    `    for (const _ of ctx.debug.command('hutstep')) { const r = [v.set(box(-3, 0, 0.5, 3, 0.5, 1.7), { material: ${MAT.plaster}, role: ${VOXEL_ROLE.wall} }), v.dig(box(-3, 0.5, 0.5, 3, 3, 1.7))]; ctx.game.add(r.every((e: any) => e.ok) ? 'hutStep' : 'hutRefused', 1); }`,
    "    for (const _ of ctx.debug.command('hutpath')) state.path = v.findPath([A[0] + 1, A[1] + 0.75, A[2] + 6.25], [A[0] - 2.5, A[1] + 0.25, A[2] - 3]);",
    "    for (const a of v.paths) if (a.path === state.path) { put('pathStatus', ['found', 'partial', 'unreachable', 'unknown'].indexOf(a.status) + 1); put('pathCm', Math.round(a.length * 100)); put('pathPoints', a.points.length); ctx.game.add('pathAnswers', 1); }",
    `    for (const _ of ctx.debug.command('hutshut')) ctx.game.add(v.set(box(-0.5, 0.5, 2, 0.5, 2.5, 2.2), { material: ${MAT.plaster}, role: ${VOXEL_ROLE.wall} }).ok ? 'hutShut' : 'hutRefused', 1);`,
    // A path from the structure grid's porch into its room (`gridpath`), packed in one counter put from its first answer
    // on (an observation carries the first 32 counters by name only; the grid's checks are the Play's last):
    // answers × 10¹² + status (1 found … 4 unknown) × 10¹¹ + its last waypoint in the room × 10¹⁰ + segments through a
    // wall's cell (the grid's own frame, as built; the door's cells are none) × 10⁸ + waypoints in the room × 10⁵ + its
    // length (cm).
    ...(gridPath === undefined ? [] : [
      `    for (const _ of ctx.debug.command('gridpath')) state.gpath = v.findPath([${gridPath.from.join(', ')}], [${gridPath.to.join(', ')}]);`,
      '    for (const a of v.paths) if (a.path === state.gpath) {',
      `      const c = Math.cos(${gridPath.yawRad}), s = Math.sin(${gridPath.yawRad}), P = [${gridPath.position.join(', ')}], H = ${JSON.stringify(gridPath.cells)};`,
      '      const g = (p: number[]) => { const dx = p[0] - P[0], dz = p[2] - P[2]; return [(c * dx - s * dz) / 0.5, (p[1] - P[1]) / 0.5, (s * dx + c * dz) / 0.5]; };',
      '      const room = (q: number[]) => q[0] > 1 && q[0] < H.w - 1 && q[2] > H.porch + 1 && q[2] < H.porch + H.d - 1;',
      // A wall cell (not the door's) under a point of the way: its waypoints, and every 5 cm along each segment between
      // them (a straight run through a wall has no waypoint in it); counted a segment.
      "      const wallAt = (q: number[]) => { const x = Math.floor(q[0]), y = Math.floor(q[1] + 0.25), z = Math.floor(q[2]); const edge = x >= 0 && x < H.w && z >= H.porch && z < H.porch + H.d && (x === 0 || x === H.w - 1 || z === H.porch || z === H.porch + H.d - 1); const door = z === H.porch && x >= H.doorX[0] && x <= H.doorX[1] && y <= H.doorH; return edge && y >= 1 && y <= H.h && !door; };",
      '      let inRoom = 0, inWall = 0;',
      '      for (let i = 0; i < a.points.length; i++) {',
      '        const q = g(a.points[i]);',
      '        if (room(q)) inRoom++;',
      '        const r = i + 1 < a.points.length ? g(a.points[i + 1]) : q;',
      '        const n = Math.max(1, Math.ceil(Math.hypot(r[0] - q[0], r[2] - q[2]) / 0.1));',
      '        let hit = false;',
      '        for (let k = 0; k <= n && !hit; k++) hit = wallAt([q[0] + ((r[0] - q[0]) * k) / n, q[1] + ((r[1] - q[1]) * k) / n, q[2] + ((r[2] - q[2]) * k) / n]);',
      '        if (hit) inWall++;',
      '      }',
      "      const last = a.points.length > 0 && room(g(a.points[a.points.length - 1])) ? 1 : 0;",
      "      state.gp = (Math.floor((state.gp ?? 0) / 1e12) + 1) * 1e12 + (['found', 'partial', 'unreachable', 'unknown'].indexOf(a.status) + 1) * 1e11 + last * 1e10 + Math.min(inWall, 99) * 1e8 + Math.min(inRoom, 999) * 1e5 + Math.min(Math.round(a.length * 100), 99999);",
      '    }',
      "    if (state.gp !== undefined) put('gpath', state.gp);",
    ]),
    // A ray from the porch at the front wall left of the door (grid x 1.75 m, 1.25 m over the slab's underside,
    // 1.5 m out), along the grid's +z: packed in one counter, answers × 10⁸ + the grid met × 10⁶ + (its cell's z + 50) ×
    // 10⁴ + the face's normal the wall's turned outward (1) × 10³ + its distance (cm). Then a hole dug through that wall
    // (the box round grid x 0.75 … 2.75 m, 0.5 … 3 m up, z −0.25 … 0.75 m: the world box of its turned corners). One
    // command for both (a game has at most 32).
    ...(gridPath === undefined ? [] : [
      `    const gyaw = ${gridPath.yawRad}, gP = [${gridPath.position.join(', ')}];`,
      '    const gw = (x: number, y: number, z: number) => [Math.cos(gyaw) * x + Math.sin(gyaw) * z + gP[0], y + gP[1], -Math.sin(gyaw) * x + Math.cos(gyaw) * z + gP[2]];',
      "    for (const c of ctx.debug.command('gridedit', { description: 'At the house: ray, dig, digpath (its wall); shut, open, pane (its door); path, pathshut, path07, path08 (porch to room)', args: [{ name: 'what', type: 'string' }] })) {",
      // `digpath`: the dig and, in the same step, a path from the porch before the hole into the room (it waits for the
      // dig to be in the walk, so it goes through the hole: its waypoints there count as in a wall by the house's cells).
      "      if (c.what === 'dig' || c.what === 'digpath') {",
      '        const cs = [[0.75, 0.5, -0.25], [2.75, 3, 0.75]];',
      '        const pts = [0, 1, 2, 3, 4, 5, 6, 7].map((k) => gw(cs[k & 1][0], cs[(k >> 1) & 1][1], cs[(k >> 2) & 1][2]));',
      '        const lo = [0, 1, 2].map((a) => Math.min(...pts.map((p) => p[a]))), hi = [0, 1, 2].map((a) => Math.max(...pts.map((p) => p[a])));',
      "        ctx.game.add(v.dig({ min: lo, max: hi }).ok ? 'gridDug' : 'gridDigRefused', 1);",
      // (straight in along the grid's z at x 1.25 m, 1.5 m before the wall to 2 m inside: 3.5 m; by the door 2 m along is about 6.5 m).
      `        if (c.what === 'digpath') state.gpath = v.findPath(gw(1.25, ${gridPath.from[1]} - gP[1], -1.5), gw(1.25, ${gridPath.from[1]} - gP[1], 2));`,
      '        continue;',
      '      }',
      // The door: its leaf shut or opened by the generic component access; the pane put in the door (the leaf in the
      // room, by their places alone); a path from the porch into the room, by default or through shut doors.
      ...(gridPath.door === undefined ? [] : [
        `        const D = ${JSON.stringify(gridPath.door)};`,
        "        if (c.what === 'shut' || c.what === 'open') { ctx.game.add(ctx.entity(D.leaf)?.set('voxelPortal', { open: c.what === 'open' }).ok === true ? 'doorSet' : 'doorRefused', 1); continue; }",
        "        if (c.what === 'pane') { const a = ctx.entity(D.leaf)?.set('transform', { position: D.inRoom }); const b = ctx.entity(D.pane)?.set('transform', { position: D.inDoor }); ctx.game.add(a?.ok === true && b?.ok === true ? 'doorSet' : 'doorRefused', 1); continue; }",
      ]),
      // A path by default, through shut doors, or for a walker of 0.7 m (three cells: the 1.5 m door takes it) or 0.8 m (four: none does).
      `        if (c.what === 'path' || c.what === 'pathshut' || c.what === 'path07' || c.what === 'path08') { state.gpath = v.findPath([${gridPath.from.join(', ')}], [${gridPath.to.join(', ')}], c.what === 'pathshut' ? { doors: 'shut-too' } : c.what === 'path07' ? { radius: 0.7 } : c.what === 'path08' ? { radius: 0.8 } : undefined); continue; }`,
      '      const h = v.raycast(gw(1.75, 1.25, -1.5), [Math.sin(gyaw), 0, Math.cos(gyaw)], 10);',
      '      const nOk = h !== null && Math.abs(h.normal[0] + Math.sin(gyaw)) < 1e-6 && Math.abs(h.normal[1]) < 1e-6 && Math.abs(h.normal[2] + Math.cos(gyaw)) < 1e-6 ? 1 : 0;',
      "      state.gray = (Math.floor((state.gray ?? 0) / 1e8) + 1) * 1e8 + (h === null ? 0 : Math.min(h.grid, 99) * 1e6 + (h.cell[2] + 50) * 1e4 + nOk * 1e3 + Math.min(Math.round(h.distance * 100), 999));",
      '    }',
      "    if (state.gray !== undefined) put('gray', state.gray);",
    ]),
    // The structure grid's house as the world's regions see it (its stamp): its room's kind (1 room, 2 outdoors) and
    // portals, and (× 10) the prop `portalsOf` names in its door: 0 none, the leaf open 1 or shut 2, the pane open 3 or
    // shut 4 (one counter: an observation carries the first 32 by name).
    ...(gridRoom === undefined ? [] : [
      `    { const g = v.regionAt(${gridRoom[0]}, ${gridRoom[1]}, ${gridRoom[2]}); put('gridRoomKind', g === null ? 0 : g.kind === 'room' ? 1 : 2);`,
      `      const D = ${JSON.stringify(gridPath?.door ?? null)}; const p = g === null || D === null ? undefined : v.portalsOf(g.id).find((x: any) => x.prop !== undefined);`,
      "      const code = p === undefined ? 0 : (p.prop === D.leaf ? 1 : p.prop === D.pane ? 3 : 9) + (p.open ? 0 : 1);",
      "      put('gridRoomPortals', g === null ? -1 : g.portals + 10 * code); }",
    ]),
    '    if (state.rooms) {',
    '      const a = v.regionAt(A[0], A[1] - 4.5, A[2] + 11);',
    '      const b = v.regionAt(A[0], A[1] - 4.5, A[2] + 14);',
    '      const o = v.regionAt(A[0], A[1] + 3, A[2]);',
    "      put('roomKnown', a !== null ? 1 : 0); put('roomEnclosed', a?.enclosed ? 1 : 0); put('roomVolume', a !== null ? Math.round(a.volume) : 0);",
    "      put('roomPortals', a?.portals ?? 0); put('roomSky', a?.seesSky ? 1 : 0); put('roomsApart', a !== null && b !== null && a.id !== b.id ? 1 : 0);",
    "      put('otherEnclosed', b?.enclosed ? 1 : 0); put('outSky', o !== null && o.sky && !o.enclosed ? 1 : 0); put('outVolume', o !== null ? Math.round(o.volume) : 0);",
    '    }',
    `    const wetAt = ${wetAt};`,
    "    for (const _ of ctx.debug.command('wet')) { const r = v.paint({ center: wetAt, radius: 1.5 }, { wetness: 7 }); ctx.game.add(r.ok ? 'wet' : 'refused', 1); ctx.game.add('wetness', v.get(...wetAt)?.wetness ?? -1); }",
    "    for (const _ of ctx.debug.command('save')) state.save = v.save();",
    "    for (const a of v.saves) if (a.save === state.save) ctx.game.add(a.ok && ctx.saves.write({ voxels: a.text }) && ctx.saves.save(1) ? 'saving' : 'saveFailed', 1);",
    "    for (const _ of ctx.debug.command('restore')) ctx.game.add(ctx.saves.load(1) ? 'loading' : 'loadFailed', 1);",
    "    for (const r of ctx.saves.results()) if (r.op === 'save') ctx.game.add(r.ok ? 'saved' : 'saveFailed', 1); else if (r.op === 'load' && r.ok) {",
    "      const doc = ctx.saves.read();",
    "      const r2 = v.restore(doc.voxels, 'save');",
    "      ctx.game.add(r2.ok ? 'restored' : 'restoreRefused', 1);",
    "      if (v.get(...pit.center)?.material === 0) ctx.game.add('holeKept', 1);",
    "      if (v.get(...wetAt)?.wetness === 0) ctx.game.add('dry', 1);",
    '    }',
    '  },',
    '  dispose() {},',
    '};',
    '',
  ].join('\n');
}

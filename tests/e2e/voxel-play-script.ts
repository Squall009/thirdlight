/**
 * The Play project's script (voxel-world.e2e.ts's Play tests drive it by debug commands): it digs once the test asks
 * after the pit's ground is resident; on further commands it wets the ground beside the pit, saves the world into
 * the game's save slot 1 and restores it from there; casts rays; builds and reads rooms; builds the walls, the hut
 * and the other shapes the shadow and light checks read; asks for a path out of the hut; moves objects by id. `at`: where the character stands
 * (metres), the pad's middle.
 */
import { VOXEL_ROLE } from '@thirdlight/voxel';

import { MAT } from '../../tools/voxel-bench/world-kit';
import { GLOW_MASKED_MAT, GLOW_MAT } from './voxel-shadows';

export function playScriptSource(at: readonly number[]): string {
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

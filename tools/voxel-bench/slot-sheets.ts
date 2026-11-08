/**
 * The kit authoring package's slot sheets and slot contract, generated from
 * the engine's own tables so an artist (or an agent) never reads engine code
 * and the sheets cannot drift from what the engine places and the kit check
 * tests:
 *
 * - **the slot contract** (`kits/slot-contract.json`): every slot of the
 *   edge catalogue with its anchor, run axis, open direction, envelope boxes
 *   (the kit check's), flush rule, stagger, the rotations that let it share
 *   another slot's mesh, and its triangle guidance, in glTF axes and in
 *   Blender's. The Blender template script (`kits/kit_templates.py`) reads
 *   it, so the templates hold the same numbers;
 * - **one manual page a slot** (`docs/manual/guides/voxel-kit-slots/`) and
 *   their index, with the slot's diagram taken from the approved role spec.
 *
 * `node tools/voxel-bench/gen-slot-sheets.mjs` writes them (`--check`: exit 1
 * when a file differs); `slot-sheets.test.ts` fails when the committed files
 * are not what this module makes.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { VOXEL_KIT_ENVELOPE, voxelKitMeshFacts, type VoxelKit } from '@thirdlight/project-model';
import {
  applyCubeRotation,
  CONSTRUCTION_ROLES,
  CUBE_ROTATION_COUNT,
  CUBE_ROTATION_X90,
  CUBE_ROTATION_ZM90,
  DAMAGE_PIECE_SLOTS,
  DAMAGE_SCATTER_REACH,
  DAMAGE_STAGES_DEFAULT,
  EDGE_CASE_IDS,
  meshRunAxis,
  PIECE_FLUSH_INSET,
  PIECE_JITTER_DEFAULT,
  PIECE_JITTER_MAX,
  PIECE_STAGGER,
  PIECE_STAGGER_FRAMES,
  pieceHalfRun,
  pieceRunAxis,
  ROOF_EDGE_CASE_IDS,
  VOXEL_ROLE,
  VOXEL_SIZE_M,
  WORLD_RULES,
  type CaseDef,
} from '@thirdlight/voxel';

export const REPO = join(import.meta.dirname, '..', '..');
/** Where the generated files go, relative to the repository. */
export const SLOT_PAGES_DIR = 'docs/manual/guides/voxel-kit-slots';
export const SLOT_CONTRACT_FILE = 'tools/voxel-bench/kits/slot-contract.json';
export const GENERATOR = 'node tools/voxel-bench/gen-slot-sheets.mjs';
const ROLE_SPEC = 'docs/architecture/voxel-role-spec.md';
const KIT_DIR = 'tools/voxel-bench/kits';
/** The kits whose triangles the sheets quote as reference (engine test data and the recommended sample). */
export const REFERENCE_KITS = ['log', 'stone', 'sample'] as const;

export type SlotFamily = 'outer-edge' | 'inner-edge' | 'outer-corner' | 'inner-corner' | 'roof-edge' | 'damage';

/**
 * Triangles a piece, a game-ready ceiling for one slot mesh (guidance for artists, and the bound the committed
 * kits' tests hold their meshes to; the engine never caps a kit). A piece is drawn once a 0.5 m edge in the near
 * ring, so a wall of a few hundred cells draws thousands of them; a damage fragment is drawn several times a face.
 */
export const SLOT_TRIANGLE_GUIDE: Readonly<Record<SlotFamily, number>> = Object.freeze({
  'outer-edge': 48,
  'inner-edge': 48,
  'outer-corner': 64,
  'inner-corner': 64,
  'roof-edge': 64,
  damage: 32,
});

type Vec3 = [number, number, number];
const AXES = ['x', 'y', 'z'] as const;

export function slotFamily(id: string): SlotFamily {
  if ((ROOF_EDGE_CASE_IDS as readonly string[]).includes(id)) return 'roof-edge';
  if (id === DAMAGE_PIECE_SLOTS[2] || id === DAMAGE_PIECE_SLOTS[3]) return 'damage';
  if (!(EDGE_CASE_IDS as readonly string[]).includes(id)) throw new Error(`slot sheets: no family for ${id}`);
  const inner = id.includes('-in-');
  return id.startsWith('corner-') ? (inner ? 'inner-corner' : 'outer-corner') : inner ? 'inner-edge' : 'outer-edge';
}

/** glTF (x, y, z) to Blender (x, −z, y): the glTF exporter turns Blender's Z up back to +y. */
const toBlender = (v: readonly number[]): Vec3 => [v[0]! + 0, -v[2]! + 0, v[1]! + 0];
const boxToBlender = (b: { min: Vec3; max: Vec3 }): { min: Vec3; max: Vec3 } => ({ min: [b.min[0], -b.max[2] + 0, b.min[1]], max: [b.max[0], -b.min[2] + 0, b.max[1]] });
const round = (v: number, d = 4): number => Math.round(v * 10 ** d) / 10 ** d + 0;
const r3 = (v: readonly number[]): Vec3 => [round(v[0]!), round(v[1]!), round(v[2]!)];
const near = (a: readonly number[], b: readonly number[]): boolean => a.every((x, i) => Math.abs(x - b[i]!) < 1e-6);

export interface SlotShare {
  /** The slot whose mesh this slot may draw. */
  from: string;
  /** The cube rotation that turns that mesh into this slot's orientation. */
  rotation: number;
}

export interface SlotContractEntry {
  id: string;
  family: SlotFamily;
  note: string;
  placedBy: string;
  roles: string;
  /** The axis the piece runs along (where a world-anchored U grows); a corner names x, its U axis. */
  run: 'x' | 'y';
  /** The middle of its edge (a corner: the corner point) from the cell's centre, metres. */
  anchor: Vec3;
  /** Unit vector from the solid into the open side. */
  open: Vec3;
  /** Half the piece's length along its run from the anchor, metres (a corner: its reach). */
  halfRun: number;
  /** The box the mesh must touch (err) and the box it should stay in (warn past it), metres. */
  touch: { min: Vec3; max: Vec3 };
  fit: { min: Vec3; max: Vec3 };
  /** At a door or window: 'cut' (drawn cut flush with the faces toward the opening), 'skipped' (not placed), 'none'. */
  opening: 'cut' | 'skipped' | 'none';
  /** How a 1:2 roof bends it: 'turned' (rigidly onto the slope), 'squashed' (half its height about its line), null. */
  pitch: 'turned' | 'squashed' | null;
  /** Whether a half piece of it is drawn at an odd hip roof's apex. */
  half: boolean;
  /** Whether the engine draws it mirrored on its own (the gable's second verge). */
  engineMirror: boolean;
  /** Other slots of its family whose mesh it may draw, with the rotation. */
  shares: SlotShare[];
  triangleGuide: number;
  blender: { anchor: Vec3; open: Vec3; run: 'X' | 'Z'; touch: { min: Vec3; max: Vec3 }; fit: { min: Vec3; max: Vec3 } };
}

export interface SlotContract {
  generatedBy: string;
  catalogue: { id: string; version: number };
  cellMetres: number;
  /** Stagger, in metres and radians at jitter 1 (a kit scales it by its jitter). */
  stagger: { inwardMin: number; inwardMax: number; twistMax: number };
  jitter: { default: number; max: number };
  flushInsetMetres: number;
  damage: { scatterReach: number; stage2Pieces: number; stage3Pieces: number };
  rotations: { x90: number; zm90: number };
  slots: SlotContractEntry[];
}

const ROLE_NAME = new Map<number, string>(Object.entries(VOXEL_ROLE).map(([k, v]) => [v, k]));

function placedBy(c: CaseDef): string {
  const f = slotFamily(c.id);
  if (f === 'roof-edge') return 'the roof mesher, on the edges of roof planes';
  if (f === 'damage') return `the damage rule, several a face, on an intact face toward a hole at stage ${c.id === DAMAGE_PIECE_SLOTS[2] ? 2 : 3}`;
  return f.endsWith('corner') ? 'the edge pass, one piece a lattice corner, yaw 0–3' : 'the edge pass, one piece a 0.5 m lattice edge, yaw 0–3';
}

function roles(c: CaseDef): string {
  if (c.roles.length === CONSTRUCTION_ROLES.length && CONSTRUCTION_ROLES.every((r) => c.roles.includes(r))) return 'every construction role';
  return c.roles.map((r) => ROLE_NAME.get(r)!).join(', ');
}

/** The first rotation (identity, X90, ZM90 first: the two the placeholders use) turning slot `a`'s mesh into slot `b`. */
function shareRotation(a: string, b: string): number | null {
  const fa = PIECE_STAGGER_FRAMES[a]!;
  const fb = PIECE_STAGGER_FRAMES[b]!;
  const order = [0, CUBE_ROTATION_X90, CUBE_ROTATION_ZM90, ...Array.from({ length: CUBE_ROTATION_COUNT }, (_, i) => i)];
  for (const r of order) {
    if (!near(applyCubeRotation(r, fa.anchor), fb.anchor) || !near(applyCubeRotation(r, fa.out), fb.out)) continue;
    // The mesh axis the rotation turns onto b's run must be a's run, so U along the run stays along it.
    if (meshRunAxis(b, r) !== pieceRunAxis(a)) continue;
    return r;
  }
  return null;
}

export function slotContract(): SlotContract {
  const cat = WORLD_RULES.catalogue!;
  const E = VOXEL_KIT_ENVELOPE;
  const slots = cat.cases.map((c): SlotContractEntry => {
    const family = slotFamily(c.id);
    const f = PIECE_STAGGER_FRAMES[c.id]!;
    const top = family === 'roof-edge' ? E.roofTop : E.half;
    const touch = { min: [-E.half, -E.half, -E.half] as Vec3, max: [E.half, top, E.half] as Vec3 };
    const fit = { min: touch.min.map((v) => v - E.reach) as Vec3, max: touch.max.map((v) => v + E.reach) as Vec3 };
    const shares = family === 'roof-edge' ? [] : cat.cases.filter((o) => o.id !== c.id && slotFamily(o.id) === family).flatMap((o) => {
      const rotation = shareRotation(o.id, c.id);
      return rotation === null ? [] : [{ from: o.id, rotation }];
    });
    const anchor = r3(f.anchor.map((v) => v * VOXEL_SIZE_M));
    const open = r3(f.out);
    const run = pieceRunAxis(c.id) === 1 ? 'y' : 'x';
    const halfRun = pieceHalfRun(c.id);
    return {
      id: c.id,
      family,
      note: c.note,
      placedBy: placedBy(c),
      roles: roles(c),
      run,
      anchor,
      open,
      halfRun: round(f.reach * VOXEL_SIZE_M),
      touch,
      fit,
      opening: family === 'outer-edge' || family === 'outer-corner' ? 'cut' : family === 'inner-edge' || family === 'inner-corner' ? 'skipped' : 'none',
      pitch: c.id === 'roof-eave' || c.id === 'roof-gable' ? 'turned' : family === 'roof-edge' ? 'squashed' : null,
      half: halfRun !== null,
      engineMirror: c.id === 'roof-gable',
      shares,
      triangleGuide: SLOT_TRIANGLE_GUIDE[family],
      blender: { anchor: toBlender(anchor), open: r3(toBlender(open)), run: run === 'y' ? 'Z' : 'X', touch: boxToBlender(touch), fit: boxToBlender(fit) },
    };
  });
  return {
    generatedBy: GENERATOR,
    catalogue: { id: cat.id, version: cat.version },
    cellMetres: VOXEL_SIZE_M,
    stagger: { inwardMin: round(PIECE_STAGGER.inwardMin * VOXEL_SIZE_M, 5), inwardMax: round(PIECE_STAGGER.inwardMax * VOXEL_SIZE_M, 5), twistMax: round(PIECE_STAGGER.twistMax, 5) },
    jitter: { default: PIECE_JITTER_DEFAULT, max: PIECE_JITTER_MAX },
    flushInsetMetres: round(PIECE_FLUSH_INSET * VOXEL_SIZE_M, 6),
    damage: { scatterReach: round(DAMAGE_SCATTER_REACH * VOXEL_SIZE_M), stage2Pieces: DAMAGE_STAGES_DEFAULT.stage2.pieces!, stage3Pieces: DAMAGE_STAGES_DEFAULT.stage3.pieces! },
    rotations: { x90: CUBE_ROTATION_X90, zm90: CUBE_ROTATION_ZM90 },
    slots,
  };
}

/** A reference kit's triangles a slot: each of its meshes' (and whether it borrows another slot's mesh). */
export interface ReferenceSlot {
  tris: number[];
  borrowed: string | null;
}

/** The committed reference kits' triangles per slot, read from their GLBs. */
export function referenceTriangles(repo = REPO): Map<string, Map<string, ReferenceSlot>> {
  const out = new Map<string, Map<string, ReferenceSlot>>();
  for (const id of REFERENCE_KITS) {
    // The sample is written by the Blender templates from the contract this module makes: absent until then.
    if (!existsSync(join(repo, KIT_DIR, `${id}.voxelkit.json`))) continue;
    const kit = JSON.parse(readFileSync(join(repo, KIT_DIR, `${id}.voxelkit.json`), 'utf8')) as VoxelKit;
    const glb = new Uint8Array(readFileSync(join(repo, KIT_DIR, `voxel-kit-${id}.glb`)));
    const slots = new Map<string, ReferenceSlot>();
    for (const [cid, s] of Object.entries(kit.slots)) {
      const owners = s.meshes.map((m) => (m.mesh.node ?? '').replace(/_v\d+$/, ''));
      slots.set(cid, { tris: s.meshes.map((m) => voxelKitMeshFacts(glb, m.mesh.node).triangles), borrowed: owners[0] !== cid ? `${owners[0]}, rotation ${s.meshes[0]!.rotation ?? 0}` : null });
    }
    out.set(id, slots);
  }
  return out;
}

/** The first text diagram under a case's heading in the role spec. */
function diagram(spec: string, id: string): string {
  const at = spec.indexOf(`#### \`${id}\` · slot`);
  if (at < 0) throw new Error(`slot sheets: the role spec has no heading for ${id}`);
  const open = spec.indexOf('```text', at);
  const close = spec.indexOf('\n```', open + 7);
  if (open < 0 || close < 0) throw new Error(`slot sheets: no diagram for ${id}`);
  return spec.slice(open, close + 4);
}

const m = (v: number): string => `${round(v, 4)}`;
const vec = (v: readonly number[]): string => `(${v.map((x) => m(x)).join(', ')})`;
const box = (b: { min: Vec3; max: Vec3 }): string => AXES.map((a, i) => `${a} ${m(b.min[i]!)} … ${m(b.max[i]!)}`).join(', ');
const bbox = (b: { min: Vec3; max: Vec3 }): string => ['X', 'Y', 'Z'].map((a, i) => `${a} ${m(b.min[i]!)} … ${m(b.max[i]!)}`).join(', ');
const cm = (metres: number): string => `${round(metres * 100, 2)} cm`;

const FAMILY_TEXT: Record<SlotFamily, string> = {
  'outer-edge': 'An outer edge: one solid cell of the four round a 0.5 m lattice edge. The piece rounds or dresses the voxel\'s square edge; the two faces it sits on are plain voxel faces drawn with the material\'s 4 × 4 m tile.',
  'inner-edge': 'An inner edge: three solid cells of four round the edge (a cove). The piece lies in the open quadrant against the two faces; where two roles meet the higher one\'s kit dresses it (roof > wall > pillar > stair > floor > foundation), and two kits of that role leave it bare.',
  'outer-corner': 'An outer corner: one solid cell of the eight round a lattice point, where three outer edges end. It closes the ends of the edge pieces meeting there. Mixed corners (outer and inner edges meeting, as at a stair notch) also draw this slot when fewer than five cells round the point are solid.',
  'inner-corner': 'An inner corner: seven solid cells of eight (a room\'s corner), where three inner edges meet. It closes the coves\' ends. Mixed corners with five or more solid cells (a wall\'s foot on a wider foundation) also draw this slot.',
  'roof-edge': 'A roof edge, placed by the roof mesher on the edges of its sloped planes (45° and 1:2). Author it for a 45° roof; the engine pitches it onto a 1:2 roof. No piece goes round a roof plane cell otherwise.',
  damage: 'A damage fragment: the engine places several on every intact face toward a damaged hole (the hole itself is not drawn and gets no edge pieces), spread over the face and spun about its normal. Author one fragment, centred on the face toward the hole (+z).',
};

function slotPage(s: SlotContractEntry, c: SlotContract, spec: string, refs: Map<string, Map<string, ReferenceSlot>>): string {
  const L: string[] = [];
  const E = VOXEL_KIT_ENVELOPE;
  L.push(`# Slot \`${s.id}\``, '');
  L.push(`> Generated by \`${GENERATOR}\` from the engine's case catalogue (\`${c.catalogue.id}\` v${c.catalogue.version}, role spec v1) and the kit check; do not edit by hand. [All slots](index.md) · [Make a kit and a material set](../voxel-kits.md)`, '');
  L.push(`${FAMILY_TEXT[s.family]}`, '');
  L.push('## Facts', '');
  L.push(`- **Slot id:** \`${s.id}\` (the kit record's \`slots\` key; a mesh node named \`${s.id}_v0\`, \`${s.id}_v1\` … by the templates)`);
  L.push(`- **What it is:** ${s.note}`);
  L.push(`- **Placed by:** ${s.placedBy}`);
  L.push(`- **Roles:** ${s.roles}`);
  L.push(`- **Collision, navigation, light:** from the voxels, never from the piece`);
  L.push(`- **LODs:** none: pieces draw in the near ring (level 0) only; from level 1 out the edge is a plain voxel edge`, '');
  L.push('## Where it sits: pivot, axes, run', '');
  L.push('The mesh is written in the case\'s own orientation, its origin at the **centre of its anchor cell** (the cell is −0.25 … +0.25 m on each axis). The engine turns it into place by quarter turns about up.', '');
  L.push('| | glTF / engine (+y up) | Blender (Z up) |', '|---|---|---|');
  L.push(`| Edge middle / corner point (anchor) | ${vec(s.anchor)} | ${vec(s.blender.anchor)} |`);
  L.push(`| Open side (out of the solid) | ${vec(s.open)} | ${vec(s.blender.open)} |`);
  L.push(`| Runs along | +${s.run} | +${s.blender.run} |`);
  L.push(`| Length along the run | ${s.family.endsWith('corner') ? `a corner: reach ${m(s.halfRun)} m from the point` : s.family === 'damage' ? 'one fragment, a few cm' : `${m(2 * s.halfRun)} m (${m(-s.halfRun)} … ${m(s.halfRun)} about the anchor)`} | same |`);
  L.push('');
  L.push('## Envelope (what the kit check tests)', '');
  L.push(`- **Must touch** (else an error: it draws beside its cell): ${box(s.touch)} — Blender ${bbox(s.blender.touch)}`);
  L.push(`- **Should stay within** (else a warning: it overlaps the neighbours' pieces): ${box(s.fit)} — Blender ${bbox(s.blender.fit)}`);
  if (s.family === 'roof-edge') L.push(`- A roof edge's box reaches ${m(E.roofTop)} m up: the roof planes run up to a cell above the voxel's top.`);
  L.push('- Apply rotation and scale; leave the object at the template\'s slot origin. No faces against the voxel body or under a roof plane (hidden geometry).', '');
  L.push('## Openings (doors, windows)', '');
  L.push(
    s.opening === 'cut'
      ? `Next to an \`opening\` cell this slot is still drawn, **cut flush** ${cm(c.flushInsetMetres)} inside the anchor's faces toward the opening, so nothing stands in the doorway. Keep the part of the piece that matters on the solid side; a jamb is a vertical outer edge, a lintel a bottom edge, a sill a top edge.`
      : s.opening === 'skipped'
        ? 'Where this piece would lie inside an `opening` cell (a cove where a doorway\'s floor meets a jamb) it is **not placed**.'
        : 'Not affected by openings.',
    '',
  );
  L.push('## Stagger and jitter', '');
  L.push(`Every piece is moved ${cm(c.stagger.inwardMin)}–${cm(c.stagger.inwardMax)} **into the solid** along ${vec(s.open.map((v) => -v))} (its open direction reversed) and twisted up to ${round((c.stagger.twistMax * 180) / Math.PI, 1)}°, hashed per cell, scaled by the kit's \`jitter\` (0–${c.jitter.max}, default ${c.jitter.default}). Let the piece stand at least ${cm(c.stagger.inwardMax * c.jitter.default)} proud of its faces at jitter ${c.jitter.default} (${cm(c.stagger.inwardMax * c.jitter.max)} at ${c.jitter.max}), or it sinks under them in places. Collision never sees the stagger.`);
  if (s.family === 'damage') L.push('', `The engine spreads the pieces of one face over a jittered grid within ±${m(c.damage.scatterReach)} m of the face's centre and spins each about the face's normal: stage 2 draws ${c.damage.stage2Pieces} a face, stage 3 ${c.damage.stage3Pieces} (the kit's \`damage\` field changes the counts).`);
  L.push('');
  L.push('## Mirror and rotation', '');
  const mirrorText = s.engineMirror
    ? 'The engine draws the gable\'s second verge **mirrored** on its own: author one verge rising toward +x. A slot mesh\'s `mirror` flag on top of that cancels it.'
    : `A slot mesh may set \`mirror\`: drawn mirrored across the run (${s.run === 'y' ? 'up and down the vertical edge' : 'left and right along x'}), winding and normal-map tangents flipped, so one carving serves both hands.`;
  L.push(`- ${mirrorText}`);
  L.push(`- \`rotation\` (one of the 24 cube rotations, 0–23) turns a mesh authored for another slot into this one; it never mirrors.`);
  if (s.pitch !== null) L.push(`- On a 1:2 roof the engine ${s.pitch === 'turned' ? 'turns the piece rigidly onto the shallower plane' : 'squashes the piece to half its height about its line, so both sides lie on the shallower planes'}; leave room for it.`);
  if (s.half) L.push('- At an odd hip roof\'s apex the engine draws a half piece (the +x half of its run); no extra mesh.');
  L.push('');
  L.push('## Shares a mesh with', '');
  if (s.shares.length === 0) L.push(s.family === 'roof-edge' ? 'No other slot: each roof edge has its own mesh.' : 'No other slot of its family.');
  else for (const sh of s.shares) L.push(`- \`${sh.from}\`'s mesh, \`rotation: ${sh.rotation}\`${sh.rotation === c.rotations.x90 ? ' (a quarter turn about +x)' : sh.rotation === c.rotations.zm90 ? ' (a quarter turn about −z)' : sh.rotation === 0 ? ' (as authored)' : ''}`);
  L.push('');
  L.push('## Triangles', '');
  L.push(`Guidance: **at most ${s.triangleGuide} triangles a mesh** (the committed kits are held to it; the engine reports, never caps). Fine detail goes into baked normals, not triangles. Reference kits:`, '');
  L.push('| Kit | Meshes (triangles) |', '|---|---|');
  for (const k of REFERENCE_KITS) {
    const r = refs.get(k)?.get(s.id);
    L.push(`| ${k}${k === 'sample' ? ' (recommended sample)' : ' (placeholder)'} | ${r === undefined ? 'empty slot (plain voxel edge)' : `${r.tris.join(', ')}${r.borrowed !== null ? ` — ${r.borrowed.replace(/^([^,]+)/, '`$1`')}` : ''}`} |`);
  }
  L.push('');
  L.push('## Diagram', '');
  L.push('From the role spec (`#` solid, `.` open, `*` the edge or corner, `O` the anchor cell):', '');
  L.push(diagram(spec, s.id), '');
  L.push('## In the Blender template', '');
  L.push(`Collection \`${s.id}\`: the cell (wire), the touch and fit boxes, the anchor, open and run arrows. Model under the slot's empty \`SLOT ${s.id}\`; name meshes \`${s.id}_v0\`, \`${s.id}_v1\` …; to borrow a mesh, set the empty's \`tl_source\` to the other slot and \`tl_rotation\` to the rotation above. The export writes the meshes relative to the empty.`);
  return `${L.join('\n')}\n`;
}

function indexPage(c: SlotContract): string {
  const L: string[] = [];
  L.push('# Voxel kit slots', '');
  L.push(`> Generated by \`${GENERATOR}\` from the engine's case catalogue (\`${c.catalogue.id}\` v${c.catalogue.version}, role spec v1) and the kit check; do not edit by hand.`, '');
  L.push(`A voxel kit fills **slots**: the ${c.slots.length} places where voxel faces meet (edges, corners, roof edges) and the faces round a damage hole. Every slot is optional: an empty slot draws a plain voxel edge. No piece ever goes on a flat face. How to make a kit: [Make a kit and a material set](../voxel-kits.md). What the engine stores and why: [voxel worlds](../../features/voxel-worlds.md#voxel-kits).`, '');
  L.push('**Conventions for every slot** (glTF axes; Blender in brackets): metres; the mesh origin at the centre of its anchor cell (−0.25 … +0.25 m); the open side toward +z (Blender −Y, the Front view), a run along +x (+X), up +y (+Z); vertical edges run up +y and open toward +x and +z. One kit uses one texture set. No LODs (pieces draw at level 0 only); collision from the voxels.', '');
  L.push('| Slot | Family | Runs along | Shares a mesh with | Triangles (guide) |', '|---|---|---|---|---|');
  for (const s of c.slots) L.push(`| [\`${s.id}\`](${s.id}.md) | ${s.family} | +${s.run} | ${s.shares.length === 0 ? '—' : s.shares.map((x) => `\`${x.from}\` r${x.rotation}`).join(', ')} | ≤ ${s.triangleGuide} |`);
  L.push('');
  L.push(`A kit can fill all ten edge and corner slots with three meshes (an outer edge, an inner edge, an outer corner) and the rotations above; the roof edges each need their own; one fragment serves both damage stages.`);
  return `${L.join('\n')}\n`;
}

/** Every generated file: repository-relative path → its text. */
export function slotSheetFiles(repo = REPO): Map<string, string> {
  const c = slotContract();
  const spec = readFileSync(join(repo, ROLE_SPEC), 'utf8');
  const refs = referenceTriangles(repo);
  const out = new Map<string, string>();
  out.set(SLOT_CONTRACT_FILE, `${JSON.stringify(c, null, 1)}\n`);
  out.set(`${SLOT_PAGES_DIR}/index.md`, indexPage(c));
  for (const s of c.slots) out.set(`${SLOT_PAGES_DIR}/${s.id}.md`, slotPage(s, c, spec, refs));
  return out;
}

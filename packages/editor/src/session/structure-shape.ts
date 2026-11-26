/**
 * The structure mode's arithmetic: what a drag on a structure's handles, a
 * drawn rectangle or a brush stroke makes of its definition or of an edit
 * command, in whole cells of the structure's own grid, and the plain words
 * the mode says about it.
 *
 * Every number of a definition is a cell of the structure's grid as it is
 * (`@thirdlight/voxel` structures/definition.ts): a footprint point is a
 * lattice corner, nothing here translates a definition, so an edge dragged
 * west writes into negative cells and every hand edit keeps its cell. A
 * change is checked by the building generator's own checks before it is
 * sent (`structureProblem`): the mode shows their message and sends nothing.
 *
 * Pure: no DOM, no three.js.
 */
import type { VoxelMaterialUse } from '@thirdlight/project-model/voxel-materials';
import { anchoredDefinition, BUILDING_GENERATOR, GridFrame, MATERIAL_AIR, STRUCTURE_DEFAULTS, StructureDefinitionError, VOXEL_ROLE, VOXEL_SIZE_M, valueMaterial, valueRole, type GridPlacement, type StructureDefinition, type StructureMaterials } from '@thirdlight/voxel';

/** A footprint point or a rectangle's corner, [x, z] in cells. */
export type CellPoint = readonly [number, number];

/** The smallest side a drawn rectangle may have (cells): a wall on each side and a cell of room between them. */
export const STRUCTURE_MIN_SIDE_CELLS = 3;

/** A turn's step (radians) when it snaps: 15°. */
export const STRUCTURE_YAW_STEP = Math.PI / 12;

/** A structure's component value: its world and grid, then its definition. */
export type StructureValue = StructureDefinition & { readonly world: string; readonly grid: number };

/** Why the building generator refuses a definition (its check's message), or null when it takes it. */
export function structureProblem(def: unknown): string | null {
  try {
    BUILDING_GENERATOR.canonical(def);
    return null;
  } catch (e) {
    if (e instanceof StructureDefinitionError) return e.message;
    throw e;
  }
}

/** The definition part of a component value (its world and grid left out). */
export function definitionOf(value: StructureValue): StructureDefinition {
  const { world: _w, grid: _g, ...def } = value;
  void _w;
  void _g;
  return def;
}

/** Whole cells in a length (metres), rounded to the nearest. */
export const cellsIn = (metres: number): number => Math.round(metres / VOXEL_SIZE_M);

/** The rectangle two corners span (cells; any order), as a polygon's points counter-clockwise from its minimum corner (null: a side shorter than {@link STRUCTURE_MIN_SIDE_CELLS}). */
export function rectPoints(a: CellPoint, b: CellPoint): [number, number][] | null {
  const x0 = Math.min(a[0], b[0]);
  const x1 = Math.max(a[0], b[0]);
  const z0 = Math.min(a[1], b[1]);
  const z1 = Math.max(a[1], b[1]);
  if (x1 - x0 < STRUCTURE_MIN_SIDE_CELLS || z1 - z0 < STRUCTURE_MIN_SIDE_CELLS) return null;
  return [[x0, z0], [x1, z0], [x1, z1], [x0, z1]];
}

/** The axis an edge moves along when dragged: across its run (an edge running along x moves along z). */
export function edgeMoveAxis(points: readonly CellPoint[], edge: number): 'x' | 'z' {
  const a = points[edge]!;
  const b = points[(edge + 1) % points.length]!;
  return a[1] === b[1] ? 'z' : 'x';
}

/** The points with edge `edge` (point k to k + 1) moved `cells` along its move axis: its two ends move, the polygon stays right-angled. */
export function moveEdge(points: readonly CellPoint[], edge: number, cells: number): [number, number][] {
  const n = points.length;
  const axis = edgeMoveAxis(points, edge);
  return points.map((p, k): [number, number] => (k === edge || k === (edge + 1) % n ? (axis === 'x' ? [p[0] + cells, p[1]] : [p[0], p[1] + cells]) : [p[0], p[1]]));
}

/**
 * The points with corner `k` moved by (dx, dz) cells: its two edges move with it (the one running along z moves
 * along x by dx, the one along x along z by dz), so the polygon stays right-angled.
 */
export function moveCorner(points: readonly CellPoint[], k: number, dx: number, dz: number): [number, number][] {
  const n = points.length;
  const prev = (k + n - 1) % n;
  const next = (k + 1) % n;
  const out = points.map((p): [number, number] => [p[0], p[1]]);
  out[k] = [out[k]![0] + dx, out[k]![1] + dz];
  for (const j of [prev, next]) {
    // The neighbour on the edge that runs along z shares the corner's x; the one on the edge along x shares its z.
    if (points[j]![0] === points[k]![0]) out[j] = [out[j]![0] + dx, out[j]![1]];
    else out[j] = [out[j]![0], out[j]![1] + dz];
  }
  return out;
}

/** The definition with polygon `index`'s points replaced (openings and stairs kept as they are). */
export function withPolygonPoints(def: StructureDefinition, index: number, points: readonly CellPoint[]): StructureDefinition {
  return { ...def, footprint: def.footprint.map((p, i) => (i === index ? { id: p.id, points: points.map((q) => [q[0], q[1]] as [number, number]) } : p)) };
}

/** A polygon id the definition does not use yet ("wing-2", "wing-3", …). */
export function nextPolygonId(def: StructureDefinition): string {
  const ids = new Set(def.footprint.map((p) => p.id));
  for (let k = def.footprint.length + 1; ; k++) if (!ids.has(`wing-${k}`)) return `wing-${k}`;
}

/** The definition extended by a polygon (a wing: an L, a T or any shape the union makes). */
export function addPolygon(def: StructureDefinition, points: readonly CellPoint[]): StructureDefinition {
  return { ...def, footprint: [...def.footprint, { id: nextPolygonId(def), points: points.map((q) => [q[0], q[1]] as [number, number]) }] };
}

/** The definition without polygon `index`, or why it cannot go (the last one; one that openings or stairs stand on). */
export function removePolygon(def: StructureDefinition, index: number): StructureDefinition | string {
  if (def.footprint.length <= 1) return 'a structure keeps at least one polygon: delete the object to remove the building';
  const id = def.footprint[index]?.id;
  if (id === undefined) return `no polygon ${index}`;
  const on = def.openings.filter((o) => o.polygon === id).length + def.stairs.filter((s) => s.polygon === id).length;
  if (on > 0) return `polygon "${id}" holds ${on} opening${on === 1 ? '' : 's'} or stair${on === 1 ? '' : 's'}: move or remove them first`;
  return { ...def, footprint: def.footprint.filter((_, i) => i !== index) };
}

/** The storeys a drag up (positive metres) or down gives: whole storeys from where it began, at least one. */
export function storeysFor(start: number, dyMetres: number, storeyHeightCells: number): number {
  return Math.max(1, start + Math.round(dyMetres / (storeyHeightCells * VOXEL_SIZE_M)));
}

/** A yaw (radians) snapped to 15° steps (free: as it is), in (−π, π]. */
export function snapYaw(rad: number, free: boolean): number {
  const r = free ? rad : Math.round(rad / STRUCTURE_YAW_STEP) * STRUCTURE_YAW_STEP;
  let w = Math.atan2(Math.sin(r), Math.cos(r));
  if (Math.abs(w) < 1e-12) w = 0;
  return w;
}

/** The box (cells, lattice corners) round every polygon's points. */
export function footprintBox(def: StructureDefinition): { minX: number; maxX: number; minZ: number; maxZ: number } {
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const p of def.footprint) for (const [x, z] of p.points) {
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minZ = Math.min(minZ, z);
    maxZ = Math.max(maxZ, z);
  }
  return { minX, maxX, minZ, maxZ };
}

/** The footprint's middle in the grid's frame (metres from cell 0; y 0): what a turn turns about. */
export function footprintMiddle(def: StructureDefinition): [number, number, number] {
  const b = footprintBox(def);
  return [((b.minX + b.maxX) / 2) * VOXEL_SIZE_M, 0, ((b.minZ + b.maxZ) / 2) * VOXEL_SIZE_M];
}

/** Where the object stands after a turn to `yaw` about the footprint's middle (which stays where it is): its position. */
export function turnedPosition(place: GridPlacement, middle: readonly [number, number, number], yaw: number): [number, number, number] {
  const at = new GridFrame(place).toWorld(middle[0], middle[1], middle[2]);
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  return [at[0] - (c * middle[0] + s * middle[2]), place.position[1], at[2] - (-s * middle[0] + c * middle[2])];
}

/** The rotation quaternion [x, y, z, w] of a turn about the vertical axis (a structure's only turn). */
export function yawRotation(yaw: number): [number, number, number, number] {
  return [0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2)];
}

/** A voxel material as the structure mode offers it. */
export interface StructureMaterialChoice {
  readonly id: number;
  readonly name: string;
  readonly use: VoxelMaterialUse;
}

/** The parts a structure has a material for, in the Inspector's order. */
export const STRUCTURE_PARTS: readonly (keyof StructureMaterials)[] = Object.freeze(['wall', 'floor', 'roof', 'foundation', 'stair']);

/**
 * A new structure's materials: the project's first construction material (lowest voxel id) for every part, so a
 * house draws whole at once and a part is swapped in the Inspector; null when the project has none (the mode says
 * so and makes nothing: a house of terrain or liquid would not be a building).
 */
export function defaultMaterials(choices: readonly StructureMaterialChoice[]): StructureMaterials | null {
  const first = [...choices].filter((c) => c.use === 'construction').sort((a, b) => a.id - b.id)[0];
  return first === undefined ? null : { wall: first.id, floor: first.id, roof: first.id, foundation: first.id, stair: first.id };
}

/** What the mode says when no material fits a building. */
export const NO_CONSTRUCTION_MATERIAL = 'No construction voxel material in the project: give a material a voxel part with use "construction" (Project → a material → Voxel), then draw the building.';

/**
 * A new structure on a rectangle `w` × `d` cells: one storey of the default height, the default foundation, a gable
 * roof along x with the default overhang, `materials` on every part, no openings or stairs, anchored as the backend
 * anchors a new structure (cell 0 at the corner of all it writes), so the drawn rectangle's corner lies `offset`
 * cells inside the grid on x and z.
 */
export function newStructure(world: string, w: number, d: number, materials: StructureMaterials): { value: Omit<StructureValue, 'grid'>; offset: number } {
  const def: StructureDefinition = {
    footprint: [{ id: 'main', points: [[0, 0], [w, 0], [w, d], [0, d]] }],
    storeys: 1,
    storeyHeight: STRUCTURE_DEFAULTS.storeyHeight,
    foundationDepth: STRUCTURE_DEFAULTS.foundationDepth,
    roof: { shape: 'gable', overhang: STRUCTURE_DEFAULTS.overhang, axis: 'x' },
    materials,
    openings: [],
    stairs: [],
    generator: BUILDING_GENERATOR.version,
  };
  const anchored = anchoredDefinition(def);
  return { value: { world, ...anchored }, offset: anchored.footprint[0]!.points[0]![0] };
}

/** The role names a misfit's words use. */
const ROLE_WORDS: Readonly<Record<number, string>> = Object.freeze(Object.fromEntries(Object.entries(VOXEL_ROLE).map(([k, v]) => [v, k])));

/** A misfit as the regenerate reports it (its cell, the generated voxel it was made over, the voxel it holds, what is generated now). */
export interface MisfitLike {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly base: number;
  readonly value: number;
  readonly generated: number;
}

/** What a hand edit was, in plain words: a dug cell, an added cell or a painted cell, and of what (`name`: a voxel material's name, else its id). */
export function misfitWords(m: MisfitLike, name: (id: number) => string = (id) => `material ${id}`): string {
  const air = (v: number): boolean => valueMaterial(v) === MATERIAL_AIR;
  const role = (v: number): string => ROLE_WORDS[valueRole(v)] ?? `role ${valueRole(v)}`;
  const now = air(m.generated) ? 'air' : role(m.generated);
  if (air(m.value)) return `a dug cell (was ${role(m.base)}; now ${now} is generated there)`;
  if (air(m.base)) return `an added cell (${role(m.value)}, ${name(valueMaterial(m.value))}; now ${now} is generated there)`;
  return `a painted cell (${role(m.value)}, ${name(valueMaterial(m.value))} over ${name(valueMaterial(m.base))}; now ${now} is generated there)`;
}

/** The banner's words for `n` misfits. */
export function misfitSummary(n: number): string {
  return `${n} edit${n === 1 ? '' : 's'} did not fit the new shape`;
}

/** The roles Add offers, in its palette's order. */
export const ADD_ROLES: readonly { readonly role: number; readonly label: string }[] = Object.freeze([
  { role: VOXEL_ROLE.wall, label: 'Wall' },
  { role: VOXEL_ROLE.floor, label: 'Floor' },
  { role: VOXEL_ROLE.roof, label: 'Roof' },
  { role: VOXEL_ROLE.pillar, label: 'Pillar' },
  { role: VOXEL_ROLE.foundation, label: 'Foundation' },
  { role: VOXEL_ROLE.stair, label: 'Stair' },
]);

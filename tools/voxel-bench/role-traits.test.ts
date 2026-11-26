/**
 * The role traits table against the checks it replaced. Each consumer used
 * to compare role ids itself; those expressions are kept here, as they
 * were, as the reference: every one of the 16 role values goes through
 * every consumer's question, and every cell of the test worlds through the
 * consumers that answer from a whole value. The reference knows the ten
 * roles the consumers compared; a role added since (gas) has its own file.
 */
import { describe, expect, it } from 'vitest';
import {
  ASSEMBLY_CLASS,
  BODY_ROLE,
  CASE_ROLES,
  CASE_SYMBOL,
  CLASS_MASK,
  CONSTRUCTION_ROLES,
  DENSITY_FULL,
  DERIVED_PART,
  LIGHT_STOP_COVERAGE,
  MATERIAL_AIR,
  MATERIAL_BITS,
  MIP_MEDIUM_ROLES,
  MIP_ROLE_PRIORITY,
  OPEN_ROLE,
  PLACEHOLDER_RULES,
  PLANE_BIT,
  PORTAL_ROLES,
  ROLE_SLOTS,
  ROLE_TRAITS,
  ROLE_TRAIT_COLUMNS,
  SHADER_CONSTRUCTION_BIT,
  SHAPE_EMPTY,
  SHAPE_FULL,
  STAMP_CLASS,
  SURFACE_ISO,
  VOXEL_ROLE,
  VOXEL_ROLE_COUNT,
  caseSymbol,
  changeFeeds,
  changedFields,
  checkRoleTraits,
  chunkGrid,
  createDenseChunk,
  createNeighbourhood,
  createWorldStore,
  damagedIntegrity,
  downsampleMip,
  fieldsFeed,
  fillLevel,
  integrityCoverage,
  isAirRole,
  isBodyRole,
  isConstructionRole,
  isFillRole,
  isFrameRole,
  isIntegrityRole,
  isLiquidRole,
  isMediumRole,
  isPortalRole,
  isRelaidRole,
  isRoofRole,
  isUniformKeepable,
  jobRadius,
  recordValue,
  roleBlocksWalkers,
  roleCollides,
  roleShape,
  roleStopsLight,
  roleTraitBit,
  roleTraitBits,
  roleTraits,
  roleTraitsWgsl,
  shaderEntry,
  shapeDensity,
  stampClassOfValue,
  valueDensity,
  valueMaterial,
  valueRole,
  valueShape,
  type PaletteStore,
  type RoleTraitColumn,
  type RoleTraits,
} from '@thirdlight/voxel';
import { featuresStore } from './features';
import { townWorld } from './town';
import { loadAreaCached } from './world-cache';
import { hillyWorld } from './worlds';

const R = VOXEL_ROLE;
const ALL = Array.from({ length: ROLE_SLOTS }, (_, r) => r);
const ASSIGNED = ALL.filter((r) => r < VOXEL_ROLE_COUNT);
const UNASSIGNED = ALL.filter((r) => r >= VOXEL_ROLE_COUNT);
/** The roles the consumers' own checks knew: every assigned role but those added as rows since. */
const COMPARED = ASSIGNED.filter((r) => r !== R.gas);

const OLD_CONSTRUCTION: number[] = [R.wall, R.floor, R.roof, R.foundation, R.stair, R.pillar];
const OLD_FRAME: number[] = [R.wall, R.floor, R.foundation, R.stair, R.pillar];
const OLD_MIP_PRIORITY: number[] = [R.wall, R.foundation, R.pillar, R.floor, R.stair, R.roof, R.terrain];

// The checks as the consumers wrote them before the table (the reference).
const OLD = {
  /** assembly.ts `OPEN_ROLE`: what the rule sets, the mesher, the kit cases and the mips read as open. */
  open: (r: number): boolean => r === R.air || r === R.liquid || r === R.opening,
  /** record.ts `CONSTRUCTION_ROLES`. */
  construction: (r: number): boolean => OLD_CONSTRUCTION.includes(r),
  /** assembly.ts `BUILT_ROLE`: where the placeholder rules read beams and rails. */
  frame: (r: number): boolean => OLD_FRAME.includes(r),
  /** The placeholder rules' class of a cell that is no beam or rail (null: the frame rules decide). */
  plainClass: (r: number): number | null => (r === R.air || r === R.opening ? ASSEMBLY_CLASS.empty : r === R.terrain ? ASSEMBLY_CLASS.ground : r === R.liquid ? ASSEMBLY_CLASS.liquid : !OLD.frame(r) ? ASSEMBLY_CLASS.wall : null),
  fillLevel: (role: number, shape: number): number => (shape !== SHAPE_EMPTY && OLD.construction(role) ? SHAPE_FULL : shape),
  damagedIntegrity: (v: number): number => {
    const shape = valueShape(v);
    return shape !== SHAPE_EMPTY && shape < SHAPE_FULL && OLD.construction(valueRole(v)) && valueMaterial(v) !== MATERIAL_AIR ? shape : 0;
  },
  valueDensity: (v: number): number => shapeDensity(OLD.fillLevel(valueRole(v), valueShape(v))),
  airOrLiquid: (v: number): boolean => v === 0 || valueRole(v) === R.liquid,
  changeFeeds: (before: number, after: number): number => {
    if (before === after) return 0;
    if (OLD.airOrLiquid(before) && OLD.airOrLiquid(after)) return DERIVED_PART.liquid;
    const fields = changedFields(before, after);
    if ((fields & (PLANE_BIT.role | PLANE_BIT.shape)) !== 0) return fieldsFeed(fields);
    return DERIVED_PART.shader;
  },
  stampClass: (v: number): number => {
    const role = valueRole(v);
    if (role === R.opening) return STAMP_CLASS.opening;
    if (valueMaterial(v) === MATERIAL_AIR) return STAMP_CLASS.open;
    if (OLD.construction(role)) {
      const integrity = OLD.damagedIntegrity(v);
      return integrity === 0 || integrityCoverage(integrity) >= LIGHT_STOP_COVERAGE ? STAMP_CLASS.stop : STAMP_CLASS.open;
    }
    if (role === R.terrain) return OLD.valueDensity(v) * 2 >= DENSITY_FULL ? STAMP_CLASS.stop : STAMP_CLASS.open;
    return STAMP_CLASS.open;
  },
  /** structure-stamp.ts and grid-resample.ts: a cell a stamp or a resample reads at all. */
  stampReads: (material: number, role: number): boolean => !(material === MATERIAL_AIR && role !== R.opening),
  shaderEntry: (material: number, wetness: number, role: number): number => (material === 0 || role === R.liquid ? 0 : material | (wetness << MATERIAL_BITS) | (OLD.construction(role) ? SHADER_CONSTRUCTION_BIT : 0)),
  caseSymbol: (value: number, density: number): number => {
    const role = valueRole(value);
    if (role === R.opening) return CASE_SYMBOL.opening;
    if (OLD.open(role) || density < SURFACE_ISO) return CASE_SYMBOL.open;
    const b = OLD_CONSTRUCTION.indexOf(role);
    return b >= 0 ? CASE_SYMBOL.built + 2 * b : role === R.terrain ? CASE_SYMBOL.ground : CASE_SYMBOL.open;
  },
  /** derived-liquid.ts `kindOf`: −1 open, −2 solid, else a liquid's fill. */
  liquidKind: (v: number, density: number): number => {
    if (valueMaterial(v) === 0) return -1;
    const role = valueRole(v);
    if (role === R.liquid) return valueShape(v) === 0 ? -1 : valueShape(v);
    if (role === R.air || role === R.opening) return -1;
    if (role === R.terrain) return density >= SURFACE_ISO ? -2 : -1;
    return -2;
  },
  /** terrain-mesher.ts: the roles whose fill makes the smooth surface. */
  meshedFromFill: (r: number): boolean => r === R.terrain,
  /** edge-cases.ts: ground with any fill keeps a piece out. */
  blocksPieces: (r: number): boolean => r === R.terrain,
  /** roof-words.ts `body`: what a roof can rest on, by role. */
  roofRests: (r: number): boolean => !OLD.open(r) && r !== R.terrain,
  /** roof-words.ts `air`: plain open space, by role. */
  roofAir: (r: number): boolean => r === R.air || r === R.liquid,
  /** far-ground.ts `standsOn`. */
  standsOn: (r: number): boolean => r !== R.liquid,
  /** far-bricks-faces.ts: a cell the far faces skip, by role. */
  farSkips: (r: number): boolean => r === R.liquid,
  /** edit-apply.ts: an `add` stroke fills a cell of this role as it fills air. */
  addFills: (r: number): boolean => r === R.liquid,
  /** spline-writer.ts `solid` and world-writer.ts `airOrLiquid`, by role. */
  writerOpen: (r: number): boolean => r === R.liquid,
  /** open-regions.ts, voxel-portals.ts, kit-cases.ts, edge-cases.ts, voxel-mips.ts: an opening. */
  portal: (r: number): boolean => r === R.opening,
  /** far-tree.ts `isUniformKeepable`, by role, for a whole cell. */
  keepable: (r: number): boolean => r !== R.roof && OLD_MIP_PRIORITY.includes(r),
  /** voxel-mips.ts: the priority, the whole-cell bodies, the liquid fallback. */
  mipPriority: OLD_MIP_PRIORITY,
  mipWholeCell: (r: number): boolean => OLD.mipPriority.includes(r) && r !== R.terrain,
  /** workspace voxel-water.ts and voxel-worlds.ts, water/body.ts, level-fill.ts. */
  liquid: (r: number): boolean => r === R.liquid,
  /** editor local-edits.ts: a filled cell's label. */
  editLabel: (r: number): string => (r === R.terrain ? 'terrain' : 'built'),
};

/** What each consumer asks the table now, a role at a time, beside what it compared before. */
const BY_ROLE: Array<[string, (r: number) => unknown, (r: number) => unknown]> = [
  ['open to the rule sets, the mesher, the kit cases and the mips', OLD.open, (r) => OPEN_ROLE[r] === 1],
  ['drawn as a body', (r) => !OLD.open(r), (r) => BODY_ROLE[r] === 1 && isBodyRole(r)],
  ['stops light (a structure stamp)', (r) => OLD.construction(r) || r === R.terrain, roleStopsLight],
  ['blocks walkers', (r) => !OLD.open(r), roleBlocksWalkers],
  ['collides', (r) => !OLD.open(r), roleCollides],
  ['construction', OLD.construction, (r) => isConstructionRole(r) && isIntegrityRole(r) && CONSTRUCTION_ROLES.includes(r)],
  ['frame (beams and rails)', OLD.frame, isFrameRole],
  ['smooth surface from the fill', OLD.meshedFromFill, isFillRole],
  ['ground keeps a piece out', OLD.blocksPieces, isFillRole],
  ['a roof rests on it', OLD.roofRests, (r) => OPEN_ROLE[r] !== 1 && !isFillRole(r)],
  ['plain open space to the roof words', OLD.roofAir, (r) => isAirRole(r) || isMediumRole(r)],
  ['stands as far ground', OLD.standsOn, (r) => !isMediumRole(r)],
  ['skipped by the far faces', OLD.farSkips, isMediumRole],
  ['an add stroke fills it', OLD.addFills, isMediumRole],
  ['open to the world writers', OLD.writerOpen, isMediumRole],
  ['an opening', OLD.portal, (r) => isPortalRole(r) && PORTAL_ROLES.includes(r)],
  ['a liquid', OLD.liquid, isLiquidRole],
  ['kept whole by the far tree', OLD.keepable, (r) => isUniformKeepable(recordValue(3, r, SHAPE_FULL, 0))],
  ['a whole-cell body in the mips', OLD.mipWholeCell, (r) => roleTraits(r).mip === 'cells'],
  ['carries a kit case', (r) => OLD.construction(r) || r === R.opening, (r) => CASE_ROLES.includes(r)],
  ['the editor\'s label of a filled cell', OLD.editLabel, (r) => (isFillRole(r) ? 'terrain' : 'built')],
];

/** The placeholder rules' class of one cell of `role` standing alone in air. */
function placeholderClass(role: number): number {
  const pad = jobRadius(PLACEHOLDER_RULES);
  const n = createNeighbourhood(1, pad);
  const i = (pad * n.side + pad) * n.side + pad;
  n.values[i] = recordValue(3, role, SHAPE_FULL, 0);
  n.shapes[i] = DENSITY_FULL;
  const out = new Uint8Array(n.values.length);
  PLACEHOLDER_RULES.resolve(n, pad, pad + 1, out);
  return out[i]! & CLASS_MASK;
}

describe('role traits table', () => {
  it('has a row for each of the 16 role values: the record\'s eleven roles by name, five unassigned', () => {
    expect(ROLE_TRAITS).toHaveLength(16);
    for (const [name, id] of Object.entries(VOXEL_ROLE)) expect(ROLE_TRAITS[id]!.name).toBe(name);
    for (const r of UNASSIGNED) expect(ROLE_TRAITS[r]!.name).toBeNull();
    expect(ASSIGNED).toHaveLength(11);
    expect(UNASSIGNED).toEqual([11, 12, 13, 14, 15]);
    expect(ASSIGNED.map((r) => roleShape(r))).toEqual(['none', 'fill', 'level', 'integrity', 'integrity', 'integrity', 'integrity', 'integrity', 'integrity', 'none', 'density']);
    expect(ASSIGNED.map((r) => roleTraits(r).medium)).toEqual(['none', 'none', 'liquid', 'none', 'none', 'none', 'none', 'none', 'none', 'none', 'gas']);
  });

  it('answers every consumer\'s question for each assigned role as the consumer\'s own check did', () => {
    for (const [what, old, now] of BY_ROLE) for (const r of COMPARED) expect(now(r), `${what}: role ${r} (${ROLE_TRAITS[r]!.name})`).toEqual(old(r));
    expect([...MIP_ROLE_PRIORITY]).toEqual(OLD.mipPriority);
    expect(MIP_MEDIUM_ROLES.filter((r) => COMPARED.includes(r))).toEqual([R.liquid]);
    expect([...PORTAL_ROLES]).toEqual([R.opening]);
    expect(ASSIGNED.filter(isRoofRole)).toEqual([R.roof]);
    expect(ASSIGNED.filter(isRelaidRole)).toEqual([R.roof]);
    expect(ASSIGNED.filter(isAirRole)).toEqual([R.air]);
    for (const r of COMPARED) {
      const plain = OLD.plainClass(r);
      // A frame role alone in air is a wall to the placeholder rules (no beam, no rail without neighbours).
      expect(placeholderClass(r), `placeholder class of role ${r}`).toBe(plain ?? ASSEMBLY_CLASS.wall);
    }
  });

  it('reads an unassigned value as plain open space in every consumer', () => {
    for (const r of UNASSIGNED) {
      const v = recordValue(3, r, SHAPE_FULL, 2);
      expect([OPEN_ROLE[r], BODY_ROLE[r]]).toEqual([1, 0]);
      expect([roleStopsLight(r), roleBlocksWalkers(r), roleCollides(r), isMediumRole(r), isLiquidRole(r), isPortalRole(r), isFillRole(r), isIntegrityRole(r), isConstructionRole(r), isFrameRole(r), isAirRole(r), isRoofRole(r)]).toEqual(new Array(12).fill(false));
      expect(placeholderClass(r)).toBe(ASSEMBLY_CLASS.empty);
      expect(stampClassOfValue(v)).toBe(STAMP_CLASS.open);
      expect(caseSymbol(v, DENSITY_FULL)).toBe(CASE_SYMBOL.open);
      expect(fillLevel(r, 7)).toBe(7);
      expect(damagedIntegrity(recordValue(3, r, 7, 0))).toBe(0);
      expect(isUniformKeepable(v)).toBe(false);
      expect(MIP_ROLE_PRIORITY.includes(r) || MIP_MEDIUM_ROLES.includes(r) || CASE_ROLES.includes(r)).toBe(false);
      expect(roleTraits(r).mip).toBe('never');
    }
  });

  it('answers the consumers that read a whole value as their own checks did, for every assigned role, shape and material', () => {
    const values: number[] = [0];
    for (const r of COMPARED) for (let shape = 0; shape <= SHAPE_FULL; shape++) for (const material of [1, 9]) for (const wet of [0, 3]) values.push(recordValue(material, r, shape, wet));
    for (const v of values) {
      const at = `value ${v} (role ${valueRole(v)}, shape ${valueShape(v)})`;
      expect(stampClassOfValue(v), `stamp class of ${at}`).toBe(OLD.stampClass(v));
      expect(shaderEntry(valueMaterial(v), 2, valueRole(v)), `shader entry of ${at}`).toBe(OLD.shaderEntry(valueMaterial(v), 2, valueRole(v)));
      expect(fillLevel(valueRole(v), valueShape(v)), `fill level of ${at}`).toBe(OLD.fillLevel(valueRole(v), valueShape(v)));
      expect(damagedIntegrity(v), `integrity of ${at}`).toBe(OLD.damagedIntegrity(v));
      expect(valueDensity(v), `density of ${at}`).toBe(OLD.valueDensity(v));
      for (const density of [0, SURFACE_ISO - 1, SURFACE_ISO, DENSITY_FULL]) {
        expect(caseSymbol(v, density), `case symbol of ${at} at density ${density}`).toBe(OLD.caseSymbol(v, density));
        const role = valueRole(v);
        const kind = valueMaterial(v) === 0 ? -1 : isLiquidRole(role) ? (valueShape(v) === 0 ? -1 : valueShape(v)) : !isBodyRole(role) ? -1 : isFillRole(role) ? (density >= SURFACE_ISO ? -2 : -1) : -2;
        expect(kind, `liquid part's kind of ${at} at density ${density}`).toBe(OLD.liquidKind(v, density));
      }
    }
    // Every pair of roles, whole and partly filled: which derived parts a change feeds.
    const ends = values.filter((v) => v === 0 || [0, 6, SHAPE_FULL].includes(valueShape(v)));
    for (const a of ends) for (const b of ends) expect(changeFeeds(a, b), `feeds of ${a} -> ${b}`).toBe(OLD.changeFeeds(a, b));
  });

  it('keeps a coarser cell by the rows: a body by rank, then a liquid by its share, then an opening, and nothing for an unassigned value', () => {
    const grid = chunkGrid(16);
    const parentOf = (cells: ReadonlyArray<readonly [number, number, number]>): { role: number; shape: number; material: number } => {
      const child = createDenseChunk(grid);
      // The 8 cells under parent cell (0, 0, 0) of octant 0: local (x, y, z) of 0 or 1.
      cells.forEach(([role, shape, material], c) => {
        const i = (((c & 1) * grid.edge) + ((c >> 2) & 1)) * grid.edge + ((c >> 1) & 1);
        child.material[i] = material;
        child.role[i] = role;
        child.shape[i] = shape;
      });
      const out = createDenseChunk(grid);
      downsampleMip(grid, [child, null, null, null, null, null, null, null], out);
      return { role: out.role[0]!, shape: out.shape[0]!, material: out.material[0]! };
    };
    const eight = (cell: readonly [number, number, number], n = 8): Array<readonly [number, number, number]> => Array.from({ length: 8 }, (_, c) => (c < n ? cell : ([0, 0, 0] as const)));
    // A block of each whole-cell body stays itself; so does full ground.
    for (const r of OLD.mipPriority) expect(parentOf(eight([r, SHAPE_FULL, 4])).role, `eight cells of role ${r}`).toBe(r);
    // Liquid alone holds by its share (8 full cells: full; 4: half); with ground under it the ground wins.
    expect(parentOf(eight([R.liquid, SHAPE_FULL, 6]))).toEqual({ role: R.liquid, shape: SHAPE_FULL, material: 6 });
    expect(parentOf(eight([R.liquid, SHAPE_FULL, 6], 4))).toMatchObject({ role: R.liquid, shape: 8 });
    expect(parentOf([...eight([R.liquid, SHAPE_FULL, 6], 4).slice(0, 4), ...eight([R.terrain, SHAPE_FULL, 2], 4).slice(0, 4)]).role).toBe(R.terrain);
    // Too little liquid to round to a level leaves air.
    expect(parentOf([[R.liquid, 3, 6], ...eight([0, 0, 0]).slice(1)])).toEqual({ role: R.air, shape: 0, material: 0 });
    // An opening with nothing solid or liquid beside it stays an opening.
    expect(parentOf(eight([R.opening, SHAPE_FULL, 5]))).toEqual({ role: R.opening, shape: SHAPE_FULL, material: 5 });
    // A wall of four cells holds the parent over ground with more fill.
    expect(parentOf([...eight([R.wall, SHAPE_FULL, 3], 4).slice(0, 4), ...eight([R.terrain, SHAPE_FULL, 2], 4).slice(0, 4)]).role).toBe(R.wall);
    // A value no role is assigned to adds nothing.
    for (const r of UNASSIGNED) expect(parentOf(eight([r, SHAPE_FULL, 4])), `eight cells of unassigned ${r}`).toEqual({ role: R.air, shape: 0, material: 0 });
  });

  it('gives a shader the same rows as a 16-entry lookup', () => {
    const wgsl = roleTraitsWgsl();
    for (const column of Object.keys(ROLE_TRAIT_COLUMNS) as RoleTraitColumn[]) {
      const bits = roleTraitBits(column);
      for (const r of ALL) expect(roleTraitBit(bits, r), `${column} of role ${r}`).toBe(ROLE_TRAIT_COLUMNS[column](ROLE_TRAITS[r]!));
      const name = `ROLE_${column.replace(/[A-Z]/g, (m) => `_${m}`).toUpperCase()}`;
      expect(wgsl).toContain(`const ${name}: u32 = ${bits}u;`);
    }
    expect(roleTraitBits('stopsLight')).toBe(ASSIGNED.filter((r) => OLD.construction(r) || r === R.terrain).reduce((m, r) => m | (1 << r), 0));
    expect(roleTraitBits('medium')).toBe((1 << R.liquid) | (1 << R.gas));
    expect(roleTraitBits('gas')).toBe(1 << R.gas);
    expect(wgsl).toContain('fn role_has(bits: u32, role: u32) -> bool');
    // A row added (a second gas at the first unassigned value) reaches the lookup with no other change.
    const next = UNASSIGNED[0]!;
    const withRow = ROLE_TRAITS.map((t, r): RoleTraits => (r === next ? { ...t, name: 'vapour', medium: 'gas', shape: 'density', mip: 'share', mipRank: 10 } : t));
    expect(() => checkRoleTraits(withRow)).not.toThrow();
    expect(roleTraitBits('gas', withRow)).toBe((1 << R.gas) | (1 << next));
    expect(roleTraitBits('body', withRow)).toBe(roleTraitBits('body'));
    expect(roleTraitsWgsl(withRow)).toContain(`const ROLE_MEDIUM: u32 = ${(1 << R.liquid) | (1 << R.gas) | (1 << next)}u;`);
  });

  it('refuses a table the consumers would read wrongly', () => {
    const edit = (role: number, change: Partial<RoleTraits>): RoleTraits[] => ROLE_TRAITS.map((t, r) => (r === role ? { ...t, ...change } : t));
    expect(() => checkRoleTraits(ROLE_TRAITS)).not.toThrow();
    expect(() => checkRoleTraits(ROLE_TRAITS.slice(0, 15))).toThrow(/15 rows/);
    // The derive reads light, walkers and collision from the one class a body derives to.
    expect(() => checkRoleTraits(edit(R.liquid, { collides: true }))).toThrow(/must equal body/);
    expect(() => checkRoleTraits(edit(R.wall, { stopsLight: false }))).toThrow(/must equal body/);
    expect(() => checkRoleTraits(edit(R.liquid, { body: true, stopsLight: true, blocksWalkers: true, collides: true }))).toThrow(/a medium is open space/);
    expect(() => checkRoleTraits(edit(R.floor, { mipRank: 0 }))).toThrow(/mip rank/);
    expect(() => checkRoleTraits(edit(R.terrain, { shape: 'integrity' }))).toThrow(/whole blocks/);
    expect(() => checkRoleTraits(edit(R.opening, { mip: 'never' }))).toThrow(/an opening/);
  });
});

describe('role traits table on the test worlds', () => {
  it('gives every cell of the town, the hills and the hard cases the answers the old checks gave', () => {
    const grid = chunkGrid(32);
    const town = createWorldStore(grid);
    loadAreaCached(townWorld({ footprint: 128 }).grids[0]!, town, 0, 0, 128, 128);
    const hilly = createWorldStore(grid);
    loadAreaCached(hillyWorld({ footprint: 96 }).grids[0]!, hilly, -48, -48, 48, 48);
    const worlds: Array<[string, PaletteStore, readonly [number, number, number], readonly [number, number, number]]> = [
      ['town', town, [0, -32, 0], [128, 64, 128]],
      ['hilly', hilly, [-48, -32, -48], [48, 64, 48]],
      ['features', featuresStore(), [0, -16, 0], [512, 48, 64]],
    ];
    const cell = { material: 0, role: 0, shape: 0, wetness: 0 };
    const seen = new Map<number, number>();
    const roles = new Set<number>();
    for (const [, store, lo, hi] of worlds) {
      for (let x = lo[0]; x < hi[0]; x++) for (let z = lo[2]; z < hi[2]; z++) for (let y = lo[1]; y < hi[1]; y++) {
        store.voxelAt(x, y, z, cell);
        // A cell as the stores hand it to the consumers: its four fields (an opening may hold no material).
        const v = cell.material === 0 && cell.role === 0 ? 0 : recordValue(cell.material, cell.role, cell.shape, cell.wetness);
        seen.set(v, (seen.get(v) ?? 0) + 1);
        if (cell.material !== 0) roles.add(cell.role);
      }
    }
    // The worlds hold ground, lakes and ponds, and houses with their openings.
    for (const r of [R.terrain, R.liquid, R.wall, R.floor, R.roof, R.foundation, R.stair, R.opening]) expect(roles.has(r), `the worlds hold role ${r}`).toBe(true);
    expect(seen.size).toBeGreaterThan(20);
    const values = [...seen.keys()];
    for (const v of values) {
      const role = valueRole(v);
      const material = valueMaterial(v);
      const at = `value ${v} (role ${role}, shape ${valueShape(v)}, ${seen.get(v)} cells)`;
      expect(stampClassOfValue(v), `stamp class of ${at}`).toBe(OLD.stampClass(v));
      expect(material === MATERIAL_AIR && !isPortalRole(role), `a stamp skips ${at}`).toBe(!OLD.stampReads(material, role));
      expect(shaderEntry(material, cellWetness(v), role), `shader entry of ${at}`).toBe(OLD.shaderEntry(material, cellWetness(v), role));
      expect(valueDensity(v), `density of ${at}`).toBe(OLD.valueDensity(v));
      expect(damagedIntegrity(v), `integrity of ${at}`).toBe(OLD.damagedIntegrity(v));
      expect(caseSymbol(v, valueDensity(v)), `case symbol of ${at}`).toBe(OLD.caseSymbol(v, OLD.valueDensity(v)));
      for (const [what, old, now] of BY_ROLE) expect(now(role), `${what}: ${at}`).toEqual(old(role));
    }
    // Any cell changed into any other the worlds hold feeds the parts the old rule fed.
    for (const a of values) for (const b of values) if (changeFeeds(a, b) !== OLD.changeFeeds(a, b)) expect(changeFeeds(a, b), `feeds of ${a} -> ${b}`).toBe(OLD.changeFeeds(a, b));
  }, 60_000);
});

function cellWetness(v: number): number {
  return (v >>> 20) & 7;
}

/**
 * The role traits table: what each value of the record's role field does,
 * one row a role, all 16 values of the 4 role bits. Every consumer of a
 * role (the mesher and the rule sets, collision, light coverage,
 * navigation, the coarser levels, the far field, structure stamps, edits)
 * asks this table through the predicates below and none compares role ids,
 * so a role added later is one more row here. A file that holds a role's
 * own behaviour (the liquid part, openings as portals, a roof's planes, the
 * generators that write named roles) may name that role; the build refuses
 * a role comparison anywhere else (`tools/check-role-traits.mjs`).
 *
 * The table has no imports: the record module reads it, and checks at load
 * that its rows are the record's role ids.
 */

/**
 * What a role's 4 shape bits mean: nothing (air, an opening), the fill of a
 * surface (terrain: a smooth surface where the fill crosses half), the fill
 * level of a liquid, the integrity of a block (construction: a whole block
 * at any integrity, lower a damage stage) or the density of a gas.
 */
export type RoleShape = 'none' | 'fill' | 'level' | 'integrity' | 'density';

/** The medium a role's cells are: open space that holds a liquid or a gas, or none (a body, or plain open space). */
export type RoleMedium = 'none' | 'liquid' | 'gas';

/**
 * How a role holds a cell of a coarser level against the other roles of the
 * 8 cells under it:
 * - `cells`: a body drawn as whole cells: by how many of the 8 it holds (half, or a sheet), among bodies by rank;
 * - `fill`: a body drawn from its fill: with any fill, after every `cells` role that holds;
 * - `share`: a medium: only where no body holds, when its share of the 8 rounds to a level, among media by rank;
 * - `gap`: an opening: only where neither a body nor a medium holds (open space that keeps its width);
 * - `never`: it adds nothing (air).
 */
export type RoleMipHold = 'never' | 'cells' | 'fill' | 'share' | 'gap';

/** One role's row. */
export interface RoleTraits {
  /** The role's name (its key in the record's role ids); null for a value no role is assigned to. */
  readonly name: string | null;
  /**
   * Drawn as a body: the mesher, the rule sets, the kit cases and the far
   * faces build its surface, and a cell of any other role is open space to
   * them (something else may draw there: a liquid's faces, a door's prop).
   */
  readonly body: boolean;
  /** Stops light (subject to its coverage: a partly filled or damaged cell stops by its share). */
  readonly stopsLight: boolean;
  /** Blocks walkers: nothing stands in it or passes through it; a walker stands on it. */
  readonly blocksWalkers: boolean;
  /** Collides with bodies. */
  readonly collides: boolean;
  /** The medium its cells hold. */
  readonly medium: RoleMedium;
  /** What its shape bits mean. */
  readonly shape: RoleShape;
  /** A gap a portal prop (a door, a window) stands in: open space the open regions keep apart from the rooms it joins. */
  readonly portal: boolean;
  /** The placeholder rule set reads beams, rails and posts from its cells (the construction roles but the roof). */
  readonly frame: boolean;
  /** How it holds a cell of a coarser level. */
  readonly mip: RoleMipHold;
  /** Its place among the roles of the same {@link RoleMipHold} group order (bodies, then media): lower wins; −1 for `never` and `gap`. */
  readonly mipRank: number;
}

/** A body drawn as whole blocks: its shape is its integrity. */
const construction = (name: string, mipRank: number, frame = true): RoleTraits => ({ name, body: true, stopsLight: true, blocksWalkers: true, collides: true, medium: 'none', shape: 'integrity', portal: false, frame, mip: 'cells', mipRank });

/**
 * A value no role is assigned to. A decoder refuses it, so no stored cell
 * holds one; a consumer handed one reads plain open space (nothing drawn,
 * nothing stopped, nothing kept in a coarser level).
 */
const UNASSIGNED: RoleTraits = Object.freeze({ name: null, body: false, stopsLight: false, blocksWalkers: false, collides: false, medium: 'none', shape: 'none', portal: false, frame: false, mip: 'never', mipRank: -1 });

/**
 * The table: index = role value. Among bodies a coarser cell takes the
 * first by rank: whole-cell bodies before ground, so a wall standing in a
 * node of ground keeps its block and the ground's surface closes round it;
 * walls and their footings before floors, so a wall meeting a slab keeps
 * its height; terrain last.
 */
export const ROLE_TRAITS: readonly RoleTraits[] = Object.freeze([
  /* 0 */ Object.freeze<RoleTraits>({ name: 'air', body: false, stopsLight: false, blocksWalkers: false, collides: false, medium: 'none', shape: 'none', portal: false, frame: false, mip: 'never', mipRank: -1 }),
  /* 1 */ Object.freeze<RoleTraits>({ name: 'terrain', body: true, stopsLight: true, blocksWalkers: true, collides: true, medium: 'none', shape: 'fill', portal: false, frame: false, mip: 'fill', mipRank: 6 }),
  /* 2 */ Object.freeze<RoleTraits>({ name: 'liquid', body: false, stopsLight: false, blocksWalkers: false, collides: false, medium: 'liquid', shape: 'level', portal: false, frame: false, mip: 'share', mipRank: 7 }),
  /* 3 */ Object.freeze(construction('wall', 0)),
  /* 4 */ Object.freeze(construction('floor', 3)),
  /* 5 */ Object.freeze(construction('roof', 5, false)),
  /* 6 */ Object.freeze(construction('foundation', 1)),
  /* 7 */ Object.freeze(construction('stair', 4)),
  /* 8 */ Object.freeze(construction('pillar', 2)),
  /* 9 */ Object.freeze<RoleTraits>({ name: 'opening', body: false, stopsLight: false, blocksWalkers: false, collides: false, medium: 'none', shape: 'none', portal: true, frame: false, mip: 'gap', mipRank: -1 }),
  /* 10 */ UNASSIGNED,
  /* 11 */ UNASSIGNED,
  /* 12 */ UNASSIGNED,
  /* 13 */ UNASSIGNED,
  /* 14 */ UNASSIGNED,
  /* 15 */ UNASSIGNED,
]);

/** Values of the role field (the record's 4 role bits). */
export const ROLE_SLOTS = 16;
const SLOT_MASK = ROLE_SLOTS - 1;

/**
 * Throws unless a table is one the consumers can read: 16 rows; the derive
 * reads a level-0 cell's mesh, collision, navigation and light coverage
 * from one class (what the rule set makes of a body), so a row whose light
 * stop, walkers or collision differ from `body` would be read wrongly until
 * the derive carries them apart; a medium is open space; ranks are distinct
 * within bodies and within media.
 */
export function checkRoleTraits(table: readonly RoleTraits[]): void {
  if (table.length !== ROLE_SLOTS) throw new RangeError(`role traits: ${table.length} rows (the role field has ${ROLE_SLOTS} values)`);
  const ranks = new Set<string>();
  table.forEach((t, role) => {
    const what = `role traits row ${role} (${t.name ?? 'unassigned'})`;
    if (t.stopsLight !== t.body || t.blocksWalkers !== t.body || t.collides !== t.body) throw new RangeError(`${what}: light stop, walkers and collision are read from the one class a body derives to, so they must equal body`);
    if (t.medium !== 'none' && t.body) throw new RangeError(`${what}: a medium is open space, not a body`);
    if ((t.shape === 'level') !== (t.medium === 'liquid') || (t.shape === 'density') !== (t.medium === 'gas')) throw new RangeError(`${what}: a liquid's shape is its level, a gas's its density`);
    if ((t.shape === 'fill' || t.shape === 'integrity') !== t.body) throw new RangeError(`${what}: a body's shape is a fill or an integrity, and only a body's`);
    const group = t.mip === 'cells' || t.mip === 'fill' ? 'body' : t.mip === 'share' ? 'medium' : null;
    if ((group === 'body') !== t.body || (group === 'medium') !== (t.medium !== 'none')) throw new RangeError(`${what}: bodies hold a coarser cell by cells or fill, media by share`);
    if ((t.mip === 'cells') !== (t.shape === 'integrity')) throw new RangeError(`${what}: whole blocks hold a coarser cell by cells, and only they`);
    if ((t.mip === 'gap') !== t.portal) throw new RangeError(`${what}: an opening holds a coarser cell as a gap, and only an opening`);
    if (group === null ? t.mipRank !== -1 : !Number.isInteger(t.mipRank) || t.mipRank < 0 || ranks.has(String(t.mipRank))) throw new RangeError(`${what}: mip rank ${t.mipRank}`);
    if (group !== null) ranks.add(String(t.mipRank));
    if (t.frame && t.shape !== 'integrity') throw new RangeError(`${what}: only whole blocks carry beams and rails`);
  });
}
checkRoleTraits(ROLE_TRAITS);

/** A role's row (the role's low 4 bits). */
export function roleTraits(role: number): RoleTraits {
  return ROLE_TRAITS[role & SLOT_MASK]!;
}

/** Per role, 1 where `pick` holds: the table as a lookup a hot loop indexes by the role bits. */
export function roleLookup(pick: (t: RoleTraits) => boolean, table: readonly RoleTraits[] = ROLE_TRAITS): Uint8Array {
  const out = new Uint8Array(ROLE_SLOTS);
  for (let r = 0; r < ROLE_SLOTS; r++) out[r] = pick(table[r]!) ? 1 : 0;
  return out;
}

/** The roles (ascending) whose rows `pick` holds for. */
export function rolesWhere(pick: (t: RoleTraits) => boolean, table: readonly RoleTraits[] = ROLE_TRAITS): number[] {
  const out: number[] = [];
  for (let r = 0; r < ROLE_SLOTS; r++) if (pick(table[r]!)) out.push(r);
  return out;
}

/** Per role: 1 for a role drawn as a body ({@link RoleTraits.body}). */
export const BODY_ROLE = roleLookup((t) => t.body);
/**
 * Per role: 1 for open space as the rule sets, the mesher and the coarser
 * levels read it (not drawn as a body: air, a medium, an opening): nothing
 * stands on it or against it.
 */
export const OPEN_ROLE = roleLookup((t) => !t.body);
const STOPS_LIGHT = roleLookup((t) => t.stopsLight);
const BLOCKS_WALKERS = roleLookup((t) => t.blocksWalkers);
const COLLIDES = roleLookup((t) => t.collides);
const MEDIUM = roleLookup((t) => t.medium !== 'none');
const LIQUID = roleLookup((t) => t.medium === 'liquid');
const PORTAL = roleLookup((t) => t.portal);
const FILL = roleLookup((t) => t.shape === 'fill');
const INTEGRITY = roleLookup((t) => t.shape === 'integrity');
const FRAME = roleLookup((t) => t.frame);
const AIR = roleLookup((t) => t.name === 'air');

/** Whether a role is air: no voxel. */
export function isAirRole(role: number): boolean {
  return AIR[role & SLOT_MASK] === 1;
}

/** Whether a role is drawn as a body ({@link RoleTraits.body}). */
export function isBodyRole(role: number): boolean {
  return BODY_ROLE[role & SLOT_MASK] === 1;
}

/** Whether a role's cells stop light ({@link RoleTraits.stopsLight}). */
export function roleStopsLight(role: number): boolean {
  return STOPS_LIGHT[role & SLOT_MASK] === 1;
}

/** Whether a role's cells block walkers, who stand on them ({@link RoleTraits.blocksWalkers}). */
export function roleBlocksWalkers(role: number): boolean {
  return BLOCKS_WALKERS[role & SLOT_MASK] === 1;
}

/** Whether a role's cells collide ({@link RoleTraits.collides}). */
export function roleCollides(role: number): boolean {
  return COLLIDES[role & SLOT_MASK] === 1;
}

/** Whether a role's cells hold a medium (a liquid, a gas): open space every output but the medium's own part reads as the air it stands in. */
export function isMediumRole(role: number): boolean {
  return MEDIUM[role & SLOT_MASK] === 1;
}

/** Whether a role's cells hold a liquid. */
export function isLiquidRole(role: number): boolean {
  return LIQUID[role & SLOT_MASK] === 1;
}

/** Whether a role is a gap a portal prop stands in ({@link RoleTraits.portal}). */
export function isPortalRole(role: number): boolean {
  return PORTAL[role & SLOT_MASK] === 1;
}

/** Whether a role's shape is the fill of a smooth surface (terrain). */
export function isFillRole(role: number): boolean {
  return FILL[role & SLOT_MASK] === 1;
}

/** Whether a role's shape is a block's integrity: a construction role, a whole block at any integrity. */
export function isIntegrityRole(role: number): boolean {
  return INTEGRITY[role & SLOT_MASK] === 1;
}

/** Whether the placeholder rule set reads beams, rails and posts from a role's cells ({@link RoleTraits.frame}). */
export function isFrameRole(role: number): boolean {
  return FRAME[role & SLOT_MASK] === 1;
}

/** What a role's shape bits mean. */
export function roleShape(role: number): RoleShape {
  return ROLE_TRAITS[role & SLOT_MASK]!.shape;
}

const byRank = (table: readonly RoleTraits[]) => (a: number, b: number): number => table[a]!.mipRank - table[b]!.mipRank;

/** The body roles a coarser level counts, first wins ({@link RoleTraits.mipRank}). */
export function mipBodyRoles(table: readonly RoleTraits[] = ROLE_TRAITS): number[] {
  return rolesWhere((t) => t.mip === 'cells' || t.mip === 'fill', table).sort(byRank(table));
}

/** The medium roles a coarser level keeps where no body holds, first wins. */
export function mipMediumRoles(table: readonly RoleTraits[] = ROLE_TRAITS): number[] {
  return rolesWhere((t) => t.mip === 'share', table).sort(byRank(table));
}

/** The roles of gaps portal props stand in (ascending). */
export const PORTAL_ROLES: readonly number[] = Object.freeze(rolesWhere((t) => t.portal));

/** The construction roles (ascending): what a builder places as whole blocks ({@link isIntegrityRole}). */
export const INTEGRITY_ROLES: readonly number[] = Object.freeze(rolesWhere((t) => t.shape === 'integrity'));

/** The yes-or-no columns a shader may ask, each as the bit of a role in a 16-bit word. */
export const ROLE_TRAIT_COLUMNS = Object.freeze({
  body: (t: RoleTraits) => t.body,
  stopsLight: (t: RoleTraits) => t.stopsLight,
  blocksWalkers: (t: RoleTraits) => t.blocksWalkers,
  collides: (t: RoleTraits) => t.collides,
  medium: (t: RoleTraits) => t.medium !== 'none',
  liquid: (t: RoleTraits) => t.medium === 'liquid',
  gas: (t: RoleTraits) => t.medium === 'gas',
  portal: (t: RoleTraits) => t.portal,
  fill: (t: RoleTraits) => t.shape === 'fill',
  integrity: (t: RoleTraits) => t.shape === 'integrity',
});

/** A yes-or-no column of the table. */
export type RoleTraitColumn = keyof typeof ROLE_TRAIT_COLUMNS;

/** A column as one word: bit `role` set where the role's row holds it (the 16-entry lookup a shader reads). */
export function roleTraitBits(column: RoleTraitColumn, table: readonly RoleTraits[] = ROLE_TRAITS): number {
  let bits = 0;
  for (let r = 0; r < ROLE_SLOTS; r++) if (ROLE_TRAIT_COLUMNS[column](table[r]!)) bits |= 1 << r;
  return bits;
}

/** Whether `role` holds a column, read from its word as a shader reads it. */
export function roleTraitBit(bits: number, role: number): boolean {
  return ((bits >>> (role & SLOT_MASK)) & 1) === 1;
}

/**
 * The table for WGSL, made from the rows: one `const ROLE_<COLUMN>: u32`
 * a column (bit = role) and `role_has(bits, role)`, so a shader that reads
 * a cell's role asks the same rows the CPU does and holds no role id.
 */
export function roleTraitsWgsl(table: readonly RoleTraits[] = ROLE_TRAITS): string {
  const lines = (Object.keys(ROLE_TRAIT_COLUMNS) as RoleTraitColumn[]).map((c) => `const ROLE_${c.replace(/[A-Z]/g, (m) => `_${m}`).toUpperCase()}: u32 = ${roleTraitBits(c, table)}u;`);
  return `${lines.join('\n')}\nfn role_has(bits: u32, role: u32) -> bool { return ((bits >> (role & ${SLOT_MASK}u)) & 1u) == 1u; }\n`;
}

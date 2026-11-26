/**
 * The role traits check: which uses of a voxel role count as a comparison
 * (and which are a write), the owner list (a file may name only its roles;
 * an entry nothing needs any more fails), and the tool run as the build
 * runs it over a workspace on disk, and over this repository.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OWNERS, roleComparisons, roleTraitProblems, sourceFiles, withoutComments } from './check-role-traits.mjs';

const TOOL = fileURLToPath(new URL('./check-role-traits.mjs', import.meta.url));
const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function workspace(files) {
  const root = mkdtempSync(join(tmpdir(), 'tl-check-role-traits-'));
  roots.push(root);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

const VOXEL_IMPORT = 'import { VOXEL_ROLE, valueRole } from \'@thirdlight/voxel\';\n';
const found = (text, file = 'packages/game/src/a.ts') => roleComparisons(file, VOXEL_IMPORT + text).map((c) => `${c.role ?? '#'}: ${c.what}`);

describe('what counts as a role comparison', () => {
  it('refuses a role id compared, switched on, listed, indexed, asked of a list, handed to a check or kept in a variable', () => {
    expect(found('if (role === VOXEL_ROLE.liquid) skip();')).toEqual(['liquid: compared (===)']);
    expect(found('const open = VOXEL_ROLE.opening !== cell.role;')).toEqual(['opening: compared (!==)']);
    expect(found('switch (kind) {\n  case VOXEL_ROLE.roof:\n    break;\n}')).toEqual(['roof: a switch case']);
    expect(found('const SOLID = [VOXEL_ROLE.wall, VOXEL_ROLE.floor];').map((s) => s.split(':')[0])).toEqual(['wall', 'floor']);
    expect(found('count[VOXEL_ROLE.roof]++;')).toEqual(['roof: used as an index']);
    expect(found('if (chunk.role.includes(VOXEL_ROLE.opening)) close();')).toEqual(['opening: asked of a list (includes)']);
    expect(found('const t = roleTable(VOXEL_ROLE.air, VOXEL_ROLE.liquid);').map((s) => s.split(':')[0])).toEqual(['air', 'liquid']);
    expect(found('const LIQUID = VOXEL_ROLE.liquid;\nif (r === LIQUID) skip();')).toEqual(['liquid: kept in a variable (an alias hides the comparison it is for)']);
    // An alias of the ids is read as the ids.
    expect(found('const R = VOXEL_ROLE;\nif (c === R.terrain) ground();')).toEqual(['terrain: compared (===)']);
  });

  it('refuses a role compared with a number, in code and in shader text, where a file reads voxels', () => {
    expect(found('if (role === 2) skip();')).toEqual(['#: a role compared with a number: role === 2']);
    expect(found('if (valueRole(v) !== 9) continue;')).toEqual(['#: a role compared with a number: valueRole(v) !== 9']);
    expect(found('if (cell.role === 1 || chunk.roles[i]! == 3) x();')).toHaveLength(2);
    expect(found('if (5 === out.role[i]) x();')).toHaveLength(1);
    expect(found('switch (cell.role) { default: break; }')).toEqual(['#: a switch on a role: switch (cell.role)']);
    expect(found('const WGSL = `if (role == 2u) { return 0.0; }`;')).toEqual(['#: a role compared with a number: role == 2u']);
    // Another kind of role (an animation's, a handle's) in a file that reads no voxel is not this check's.
    expect(roleComparisons('packages/game/src/b.ts', 'if (role === 2) run();')).toEqual([]);
    // Inside the voxel package every file reads voxels.
    expect(roleComparisons('packages/voxel/src/b.ts', 'if (role === 2) run();')).toHaveLength(1);
  });

  it('lets a role be written, asked through the table, counted or named in a comment', () => {
    expect(found('const v = { material, role: VOXEL_ROLE.wall, shape: 15 };')).toEqual([]);
    expect(found('const v = { role: paint ? VOXEL_ROLE.wall : role, also: d.role ?? VOXEL_ROLE.floor };')).toEqual([]);
    expect(found('out.role[i] = VOXEL_ROLE.air;')).toEqual([]);
    expect(found('col.put(row, recordValue(material, VOXEL_ROLE.terrain, SHAPE_FULL, 0));')).toEqual([]);
    expect(found('function voxelOf(material = 0, role: number = VOXEL_ROLE.air): number { return role; }')).toEqual([]);
    expect(found('if (isLiquidRole(valueRole(v)) || OPEN_ROLE[role] === 1 || roleCells[r] === 0 || role < 0) skip();')).toEqual([]);
    expect(found('const names = Object.entries(VOXEL_ROLE).map(([k]) => k);')).toEqual([]);
    expect(found('// role === 2 was the liquid check; VOXEL_ROLE.liquid === role\n/* if (role === VOXEL_ROLE.roof) */\nconst x = 1;')).toEqual([]);
    expect(found('if (role >= VOXEL_ROLE_COUNT) refuse();')).toEqual([]);
  });

  it('blanks comments and keeps strings, line for line', () => {
    const text = 'a(); // one\nconst s = "// not a comment"; /* two\nlines */ b();\nconst t = `/* kept */ ${x}`;';
    const out = withoutComments(text);
    expect(out).toHaveLength(text.length);
    expect(out.split('\n')).toHaveLength(4);
    expect(out).not.toContain('one');
    expect(out).not.toContain('two');
    expect(out).toContain('"// not a comment"');
    expect(out).toContain('`/* kept */ ${x}`');
  });
});

describe('the owner list', () => {
  const owners = [{ file: 'packages/voxel/src/roof.ts', roles: ['roof'], why: 'test' }];

  it('passes a workspace whose only comparison is an owner\'s own role', () => {
    const root = workspace({
      'packages/voxel/src/roof.ts': 'export const isRoofRole = (role: number): boolean => role === VOXEL_ROLE.roof;\n',
      'packages/voxel/src/mesher.ts': 'export const drawn = (role: number): boolean => isBodyRole(role);\nexport const made = { role: VOXEL_ROLE.wall };\n',
      'packages/voxel/src/mesher.test.ts': 'if (role === VOXEL_ROLE.liquid || role === 2) expect(1).toBe(1);\n',
    });
    expect(sourceFiles(root)).toEqual(['packages/voxel/src/mesher.ts', 'packages/voxel/src/roof.ts']);
    expect(roleTraitProblems(root, owners)).toEqual([]);
  });

  it('fails a comparison outside the owners, another role inside one, and an entry nothing needs', () => {
    const root = workspace({
      'packages/voxel/src/roof.ts': 'export const isRoofRole = (role: number): boolean => role === VOXEL_ROLE.roof || role === VOXEL_ROLE.wall;\n',
      'packages/runtime/src/water.ts': VOXEL_IMPORT + 'export const wet = (v: number): boolean =>\n  valueRole(v) === VOXEL_ROLE.liquid;\n',
    });
    const problems = roleTraitProblems(root, owners);
    expect(problems).toHaveLength(2);
    expect(problems[0]).toMatch(/^packages\/runtime\/src\/water\.ts:3: VOXEL_ROLE\.liquid compared \(===\)\. Ask the role traits table/);
    expect(problems[1]).toMatch(/^packages\/voxel\/src\/roof\.ts:1: VOXEL_ROLE\.wall compared.*this file owns only roof/);
    // The owner's comparison gone: its entry must go too.
    const stale = workspace({ 'packages/voxel/src/roof.ts': 'export const isRoofRole = (role: number): boolean => roleTraits(role).name === \'roof\';\n' });
    expect(roleTraitProblems(stale, owners)).toEqual(['tools/check-role-traits.mjs: owner packages/voxel/src/roof.ts no longer names roof in a comparison: take roof out of its entry']);
    expect(roleTraitProblems(workspace({ 'packages/voxel/src/x.ts': 'export {};\n' }), owners)[0]).toMatch(/owner packages\/voxel\/src\/roof\.ts does not exist/);
  });
});

describe('the tool as the build runs it', () => {
  // A checkout holding every owner file, each naming exactly its roles.
  const owned = () => Object.fromEntries(OWNERS.map((o) => [o.file, o.roles === '*' ? 'export {};\n' : `${o.roles.map((r) => `export const is_${r} = (role: number): boolean => role === VOXEL_ROLE.${r};`).join('\n')}\n`]));
  const run = (root) => spawnSync(process.execPath, [TOOL, root], { encoding: 'utf8' });

  it('exits 0 over a checkout with no comparison outside the owners', () => {
    const out = run(workspace({ ...owned(), 'packages/editor/src/tool.ts': VOXEL_IMPORT + 'export const add = { role: VOXEL_ROLE.terrain };\n' }));
    expect(out.status, out.stderr).toBe(0);
    expect(out.stdout).toMatch(/check-role-traits: \d+ source files, no role comparison outside the table/);
  });

  it('exits 1 naming the file and line of each comparison', () => {
    const out = run(workspace({ ...owned(), 'packages/editor/src/tool.ts': VOXEL_IMPORT + 'export const wet = (v: number): boolean => valueRole(v) === VOXEL_ROLE.liquid;\nexport const air = (role: number): boolean => role === 0;\n' }));
    expect(out.status).toBe(1);
    expect(out.stderr).toContain('packages/editor/src/tool.ts:2: VOXEL_ROLE.liquid compared (===)');
    expect(out.stderr).toContain('packages/editor/src/tool.ts:3: a role compared with a number: role === 0');
    expect(out.stderr).toContain('check-role-traits: 2 problems');
  });

  it('passes on this repository, every owner entry in use and with its reason', () => {
    expect(roleTraitProblems()).toEqual([]);
    for (const o of OWNERS) expect(o.why.length, o.file).toBeGreaterThan(10);
    expect(new Set(OWNERS.map((o) => o.file)).size).toBe(OWNERS.length);
  });
});

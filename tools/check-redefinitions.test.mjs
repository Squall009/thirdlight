/**
 * The redefinition check: which declarations count as copies of an owned
 * helper, and the ratchet (a new copy fails, a listed copy that is gone fails
 * until its entry is dropped, entries in retired areas carry their marker),
 * run as the build runs it over a workspace on disk.
 */

import { afterEach, describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OWNED_FAMILIES, RATCHET_FILE, checkRedefinitions, definitionsIn, isRetired, writeRatchet } from './check-redefinitions.mjs';

const TOOL = fileURLToPath(new URL('./check-redefinitions.mjs', import.meta.url));
const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function workspace(files) {
  const root = mkdtempSync(join(tmpdir(), 'tl-check-redefinitions-'));
  roots.push(root);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

function run(root, ...args) {
  return spawnSync(process.execPath, [TOOL, ...args], { cwd: root, encoding: 'utf8' });
}

const ownerOf = (family) => OWNED_FAMILIES.find((f) => f.family === family).owner;
const names = (defs) => defs.map((d) => d.name).sort();

describe('what counts as a copy', () => {
  it('finds functions, classes and variables with an owned name at any depth', () => {
    const text = [
      'export function crc32(b: Uint8Array): number { return b.length; }',
      'const isPlainObject = (v: unknown): boolean => typeof v === "object";',
      'function outer() {',
      '  const deepFreeze = <T>(v: T): T => v;',
      '  return deepFreeze;',
      '}',
      'class mulQuat {}',
      'const unrelated = 1;',
    ].join('\n');
    expect(names(definitionsIn(text, 'packages/a/src/x.ts'))).toEqual(['crc32', 'deepFreeze', 'isPlainObject', 'mulQuat']);
  });

  it('does not count an alias of another binding, an import or a use', () => {
    const text = [
      "import { sha256Hex as hex } from './elsewhere';",
      "import { canonicalJson } from './elsewhere';",
      'const sha256HexAsync = hex;',
      'const utf8Length = Text.length;',
      'export const out = canonicalJson({});',
    ].join('\n');
    expect(definitionsIn(text, 'packages/a/src/x.ts')).toEqual([]);
  });

  it('finds a renamed copy by its fingerprint, once per file, and not where the family is named', () => {
    const renamed = 'function next(s: number): number { return (s + 0x6d2b79f5) >>> 0; }\nconst again = 1831565813;\n';
    expect(definitionsIn(renamed, 'packages/a/src/x.ts')).toEqual([{ name: 'seeded-random fingerprint', family: 'seeded-random', line: 1 }]);
    const named = 'export function mulberry32(s: number): number { return (s + 0x6D2B79F5) >>> 0; }\n';
    expect(names(definitionsIn(named, 'packages/a/src/x.ts'))).toEqual(['mulberry32']);
  });

  it('leaves the owner file its own definitions', () => {
    const text = 'export function crc32(b: Uint8Array): number { return b.length ^ 0xedb88320; }\n';
    expect(definitionsIn(text, ownerOf('crc32'))).toEqual([]);
    expect(names(definitionsIn(text, 'packages/b/src/y.ts'))).toEqual(['crc32']);
  });

  it('marks the areas the voxel world retires, not the tools it keeps', () => {
    expect(isRetired('packages/project-model/src/block-kit.ts')).toBe(true);
    expect(isRetired('packages/project-model/src/terrain-erosion.ts')).toBe(true);
    expect(isRetired('packages/project-model/src/architecture.ts')).toBe(true);
    expect(isRetired('packages/project-model/src/arch-math.ts')).toBe(true);
    for (const f of ['packages/commands/src/room-walls.ts', 'packages/editor/src/session/room-draw.ts', 'packages/editor/src/viewport/room-tool.ts', 'tests/e2e/rooms-drawing.ts']) expect(isRetired(f), f).toBe(true);
    for (const f of ['packages/commands/src/scatter-ops.ts', 'packages/three-adapter/src/stored-scatter.ts', 'packages/workspace/src/vertex-paint-host.ts', 'packages/project-model/src/paint-brush.ts', 'packages/three-adapter/src/room-culling.ts', 'packages/project-model/src/trim-sheet.ts', 'packages/project-model/src/kits.ts', 'packages/backend/src/kit-check.ts']) expect(isRetired(f), f).toBe(false);
    expect(isRetired('packages/runtime/src/scene-control.ts')).toBe(false);
    expect(isRetired('packages/project-model/src/sha256.ts')).toBe(false);
    expect(isRetired('packages/runtime/src/camera-rig.ts')).toBe(false);
  });
});

describe('the ratchet, as the build runs it', () => {
  const copy = 'export function crc32(b: Uint8Array): number { return b.length; }\n';

  it('passes when every copy is listed, and fails on a new copy with where to import it from', () => {
    const root = workspace({ 'packages/a/src/x.ts': copy });
    writeRatchet(root, [{ file: 'packages/a/src/x.ts', name: 'crc32' }]);
    expect(run(root).status).toBe(0);

    writeFileSync(join(root, 'packages/a/src/z.ts'), 'export const isPlainObject = (v: unknown): boolean => v !== null;\n');
    const res = run(root);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain(`packages/a/src/z.ts:1: 'isPlainObject' is defined again; import it from its owner ${ownerOf('objects')}`);
    // --update never adds a copy: the new one still fails.
    expect(run(root, '--update').status).toBe(1);
    expect(JSON.parse(readFileSync(join(root, RATCHET_FILE), 'utf8')).entries).toEqual([{ file: 'packages/a/src/x.ts', name: 'crc32' }]);
  });

  it('fails on a listed copy that is gone until --update drops its entry', () => {
    const root = workspace({ 'packages/a/src/x.ts': copy, 'tools/t.mjs': 'export function crc32(b) { return b.length; }\n' });
    writeRatchet(root, [{ file: 'packages/a/src/x.ts', name: 'crc32' }, { file: 'tools/t.mjs', name: 'crc32' }]);
    writeFileSync(join(root, 'packages/a/src/x.ts'), "export { crc32 } from './owner';\n");
    const res = run(root);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain("packages/a/src/x.ts: 'crc32' is no longer defined there; drop its entry");
    expect(run(root, '--update').status).toBe(0);
    expect(run(root).status).toBe(0);
    expect(checkRedefinitions(root).updated).toEqual([{ file: 'tools/t.mjs', name: 'crc32' }]);
  });

  it('holds a retired-area entry to its marker', () => {
    const root = workspace({ 'packages/a/src/terrain-x.ts': copy });
    writeRatchet(root, [{ file: 'packages/a/src/terrain-x.ts', name: 'crc32' }]);
    const res = run(root);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('retired marker');
    expect(run(root, '--update').status).toBe(0);
    expect(JSON.parse(readFileSync(join(root, RATCHET_FILE), 'utf8')).entries).toEqual([{ file: 'packages/a/src/terrain-x.ts', name: 'crc32', retired: true }]);
    expect(run(root).status).toBe(0);
  });
});

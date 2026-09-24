/**
 * Phase 15.4: properties declared in code — the compiler derives the
 * declaration from `export const properties = { … }` in src/index.ts (code
 * wins over the supplied JSON declaration), marks the manifest
 * `declaredInCode`, and rewrites the statement to plain data so the module
 * runs without a `property` helper.
 */
import { transformSync } from 'esbuild';
import { describe, expect, it } from 'vitest';

import { M2_PINNED_MODULES, compileBehavior, labelOfKey, preparedSourceFrom, readCodeDeclaration } from './index';

const SOURCE = [
  'export const properties = {',
  "  speed: property.number(3, { min: 0, max: 10, step: 0.5, group: 'Movement', tooltip: 'Metres per second' }),",
  '  secret: property.private.number(1),',
  "  jump_height: property.public.number(2.5, { header: 'Jump' }),",
  "  mode: property.enum('walk', { values: ['walk', 'run'], label: 'Gait' }),",
  "  'tint': property.vec3([1, 0.5, 0], { bounds: { min: [0, 0, 0], max: [1, 1, 1] } }), // a colour",
  '  target: property.entityRef(null),',
  '  on: property.boolean(true),',
  "  name: property.string('x', { maxLength: 8 }),",
  '} as const;',
  '',
  'export default {',
  '  prepare() { return {}; },',
  '  instantiate() { return {}; },',
  '  step(_s: unknown, ctx: any) { void ctx.properties.speed; },',
  '  dispose() {},',
  '};',
  '',
].join('\n');

function container(text: string): Uint8Array {
  return new TextEncoder().encode(`${JSON.stringify({ graphVersion: 1, entryPath: 'src/index.ts', requiredModules: [], ownedTransforms: [], files: [{ path: 'src/index.ts', text }] }, null, 2)}\n`);
}

const DERIVED = [
  { key: 'speed', label: 'Speed', type: 'number', default: 3, min: 0, max: 10, step: 0.5, group: 'Movement', tooltip: 'Metres per second' },
  { key: 'secret', label: 'Secret', type: 'number', default: 1, visibility: 'private' },
  { key: 'jump_height', label: 'Jump height', type: 'number', default: 2.5, header: 'Jump' },
  { key: 'mode', label: 'Gait', type: 'enum', default: 'walk', values: ['walk', 'run'] },
  { key: 'tint', label: 'Tint', type: 'vec3', default: [1, 0.5, 0], bounds: { min: [0, 0, 0], max: [1, 1, 1] } },
  { key: 'target', label: 'Target', type: 'entityRef', default: null },
  { key: 'on', label: 'On', type: 'boolean', default: true },
  { key: 'name', label: 'Name', type: 'string', default: 'x', maxLength: 8 },
];

describe('phase 15.4: properties declared in code', () => {
  it('reads every property type, visibility, options and default labels', () => {
    const r = readCodeDeclaration(SOURCE);
    if (!r.found || !r.ok) throw new Error(JSON.stringify(r));
    expect(r.properties).toEqual(DERIVED);
    expect(labelOfKey('max_air_jumps')).toBe('Max air jumps');
  });

  it('is absent without the export (the JSON declaration applies) and ignores a commented-out one', () => {
    expect(readCodeDeclaration('export default {};')).toEqual({ found: false });
    expect(readCodeDeclaration('// export const properties = { a: property.number(1) };\nexport default {};')).toEqual({ found: false });
  });

  it('reports a non-literal default, an unknown type or option with its position', () => {
    const bad = (body: string): string => {
      const r = readCodeDeclaration(`const k = 1;\nexport const properties = {\n  ${body}\n};`);
      if (!r.found || r.ok) throw new Error(`expected a failure for ${body}`);
      return r.message;
    };
    expect(bad('speed: property.number(k)')).toMatch(/src\/index\.ts:3:.*"k" is not a literal/);
    expect(bad('speed: property.float(1)')).toMatch(/property\.float is not a property type/);
    expect(bad('speed: property.number(1, { minimum: 0 })')).toMatch(/unknown option "minimum"/);
    expect(bad('speed: 3')).toMatch(/must be property/);
    expect(bad('speed: property.number(1), speed: property.number(2)')).toMatch(/declared twice/);
  });

  it('the compiler derives the declaration (code wins), marks it and emits runnable data', async () => {
    const result = await compileBehavior({
      behaviorId: 'mover-a',
      // Ignored: the code declares its properties.
      declaration: { properties: [] },
      containerBytes: container(SOURCE),
      pinnedModules: M2_PINNED_MODULES,
      limits: { timeoutMs: 30_000 },
    });
    if (!result.ok) throw new Error(JSON.stringify(result));
    expect(result.manifest.declaration.properties).toEqual(DERIVED);
    expect(result.manifest.declaredInCode).toBe(true);
    const prepared = preparedSourceFrom(result);
    expect(prepared.declaredInCode).toBe(true);
    expect(prepared.declaration.properties).toEqual(DERIVED);
    // The output runs with no `property` helper in scope; `properties` is plain data.
    const text = new TextDecoder().decode(result.outputBytes);
    expect(text).not.toContain('property.number');
    // Evaluated here only as a test of the output (the compiler never runs source): as CommonJS.
    const cjs = transformSync(text, { format: 'cjs' }).code;
    const holder: { exports: Record<string, unknown> } = { exports: {} };
    new Function('module', 'exports', cjs)(holder, holder.exports);
    const mod = holder.exports as { default: { step: unknown }; properties: Record<string, { key: string }> };
    expect(typeof mod.default.step).toBe('function');
    expect(mod.properties['secret']).toMatchObject({ key: 'secret', visibility: 'private' });

    // Without the export the supplied declaration is used, unmarked.
    const plain = await compileBehavior({
      behaviorId: 'mover-a',
      declaration: { properties: [{ key: 'speed', label: 'Speed', type: 'number', default: 1 }] },
      containerBytes: container('export default { step() {} };\n'),
      pinnedModules: M2_PINNED_MODULES,
      limits: { timeoutMs: 30_000 },
    });
    if (!plain.ok) throw new Error(JSON.stringify(plain));
    expect(plain.manifest.declaredInCode).toBeUndefined();
    expect(plain.manifest.declaration.properties).toEqual([{ key: 'speed', label: 'Speed', type: 'number', default: 1 }]);
  });

  it('a malformed code declaration is a compile failure (behavior_source_invalid)', async () => {
    const result = await compileBehavior({
      behaviorId: 'mover-a',
      declaration: { properties: [{ key: 'speed', label: 'Speed', type: 'number', default: 1 }] },
      containerBytes: container('export const properties = { speed: property.number(Math.PI) };\nexport default { step() {} };\n'),
      pinnedModules: M2_PINNED_MODULES,
      limits: { timeoutMs: 30_000 },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('behavior_source_invalid');
    expect(result.reason).toBe('properties');
    expect(result.diagnostics[0]?.message).toMatch(/"Math" is not a literal/);
  });
});

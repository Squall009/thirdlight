/**
 * Phase 16.3: compile failures carry located diagnostics (path, 1-based line
 * and column) so the script editor can mark them inline.
 */
import { describe, expect, it } from 'vitest';

import { canonicalContainerText } from './container';
import { compileBehavior } from './compile';
import { M2_PINNED_MODULES } from './limits';

const DECLARATION = { properties: [{ key: 'speed', label: 'Speed', type: 'number' as const, default: 1 }] };

function container(files: { path: string; text: string }[]): Uint8Array {
  return new TextEncoder().encode(
    canonicalContainerText({ graphVersion: 1, entryPath: 'src/index.ts', requiredModules: [], ownedTransforms: [], files }),
  );
}

describe('located compile diagnostics', () => {
  it('a syntax error in the entry names src/index.ts, its line and its column', async () => {
    const r = await compileBehavior({
      behaviorId: 'b',
      declaration: DECLARATION,
      containerBytes: container([{ path: 'src/index.ts', text: 'export default {\n  step() {\n    const x = ;\n  },\n};\n' }]),
      pinnedModules: M2_PINNED_MODULES,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe('behavior_source_invalid');
    expect(r.reason).toBe('syntax');
    expect(r.diagnostics[0]).toMatchObject({ path: 'src/index.ts', line: 3, column: 15 });
  });

  it('a syntax error in an imported file names that file', async () => {
    const r = await compileBehavior({
      behaviorId: 'b',
      declaration: DECLARATION,
      containerBytes: container([
        { path: 'src/index.ts', text: "import { f } from './util';\nexport default { step() { f(); } };\n" },
        { path: 'src/util.ts', text: 'export function f() {\n  return (;\n}\n' },
      ]),
      pinnedModules: M2_PINNED_MODULES,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.diagnostics[0]).toMatchObject({ path: 'src/util.ts', line: 2 });
  });

  it('a bad code declaration carries its position as fields', async () => {
    const r = await compileBehavior({
      behaviorId: 'b',
      declaration: DECLARATION,
      containerBytes: container([{ path: 'src/index.ts', text: 'export const properties = {\n  speed: property.nope(1),\n};\nexport default { step() {} };\n' }]),
      pinnedModules: M2_PINNED_MODULES,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.diagnostics[0]?.path).toBe('src/index.ts');
    expect(r.diagnostics[0]?.line).toBe(2);
    expect(typeof r.diagnostics[0]?.column).toBe('number');
  });
});

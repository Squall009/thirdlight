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

describe('phase 25.6: an import-scan hit says where it is (line; comment, string or code)', () => {
  const failure = async (text: string) => {
    const r = await compileBehavior({ behaviorId: 'b', declaration: DECLARATION, containerBytes: container([{ path: 'src/index.ts', text }]), pinnedModules: M2_PINNED_MODULES });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('compiled');
    return { code: r.code, reason: r.reason, d: r.diagnostics[0]! };
  };
  const STEP = 'export default { step() {} };\n';

  it('a construct in a line comment: the line, and that it is inside a comment', async () => {
    const f = await failure(`${STEP}\n// never require('fs') here\n`);
    expect(f.code).toBe('behavior_dynamic_code');
    expect(f.d).toMatchObject({ path: 'src/index.ts', line: 3, column: 10 });
    expect(f.d.message).toContain('line 3');
    expect(f.d.message).toContain('inside a comment');
  });

  it('an import in a block comment, and a declaration whose "from" is in a trailing comment', async () => {
    const block = await failure(`/*\n  import fs from 'fs';\n*/\n${STEP}`);
    expect(block.code).toBe('behavior_import_forbidden');
    expect(block.d.line).toBe(2);
    expect(block.d.message).toContain('inside a comment');
    const trailing = await failure(`${STEP}export const a = 1; // loaded from 'disk'\n`);
    expect(trailing.code).toBe('behavior_import_forbidden');
    expect(trailing.d.line).toBe(2);
    expect(trailing.d.message).toContain('inside a comment');
  });

  it('in a string, a template text and a regular expression; code inside ${…} is code', async () => {
    expect((await failure(`const s = "eval(1)";\n${STEP}`)).d.message).toContain('inside a string');
    expect((await failure(`const s = \`x eval(1)\`;\n${STEP}`)).d.message).toContain('inside a string');
    expect((await failure(`const r = /eval (x)/;\n${STEP}`)).d.message).toContain('inside a regular expression');
    const code = await failure(`const s = \`\${eval('1')}\`;\n${STEP}`);
    expect(code.d.message).not.toContain('inside');
    expect(code.d.line).toBe(1);
  });

  it('a real construct in code: the line, no note', async () => {
    const f = await failure(`${STEP}const x = 1 / 2;\nconst m = require('fs');\n`);
    expect(f.code).toBe('behavior_dynamic_code');
    expect(f.d.line).toBe(3);
    expect(f.d.message).toBe('file "src/index.ts" line 3 contains a require construct (dynamic code is forbidden).');
  });
});

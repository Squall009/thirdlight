import { describe, expect, it } from 'vitest';

import { BEHAVIOR_API_TYPES } from '../ui/script/behavior-api.generated';
import {
  addFile,
  containerText,
  deleteFile,
  memberCompletion,
  newScript,
  ownedTransformsOf,
  parseContainer,
  pathProblem,
  renameFile,
  typeOfIdentifier,
} from './script-sources';

describe('script sources (phase 16.3)', () => {
  it('serializes the canonical container: field order, files by path, trailing newline', () => {
    const c = { graphVersion: 1 as const, entryPath: 'src/index.ts', requiredModules: [], ownedTransforms: ['@self'], files: [{ path: 'src/z.ts', text: 'z' }, { path: 'src/index.ts', text: 'i' }] };
    const text = containerText(c);
    expect(text.endsWith('}\n')).toBe(true);
    expect(Object.keys(JSON.parse(text))).toEqual(['graphVersion', 'entryPath', 'requiredModules', 'ownedTransforms', 'files']);
    expect(JSON.parse(text).files.map((f: { path: string }) => f.path)).toEqual(['src/index.ts', 'src/z.ts']);
    const back = parseContainer(text);
    expect(back.ok && containerText(back.container)).toBe(text);
  });

  it('adds, renames and deletes files; the entry is protected; names follow the compiler grammar', () => {
    let c = newScript(false);
    const added = addFile(c, 'src/util.ts');
    expect(added.ok).toBe(true);
    if (!added.ok) return;
    c = added.container;
    expect(addFile(c, 'src/util.ts')).toEqual({ ok: false, message: 'src/util.ts already exists' });
    expect(pathProblem('src/Util.ts', c)).toMatch(/lower-case/);
    expect(pathProblem('src/util.js', c)).toMatch(/\.ts/);
    const renamed = renameFile(c, 'src/util.ts', 'src/lib/math.ts');
    expect(renamed.ok && renamed.container.files.map((f) => f.path)).toEqual(['src/index.ts', 'src/lib/math.ts']);
    expect(renameFile(c, 'src/index.ts', 'src/main.ts').ok).toBe(false);
    expect(deleteFile(c, 'src/index.ts').ok).toBe(false);
    const deleted = deleteFile(c, 'src/util.ts');
    expect(deleted.ok && deleted.container.files.length).toBe(1);
  });

  it('parses owned transforms from text', () => {
    expect(ownedTransformsOf(' @self, door-1 ,, door-1')).toEqual(['@self', 'door-1']);
  });

  it('completes the behavior API along member chains', () => {
    const text = 'export default { step(s: unknown, ctx: BehaviorContext) { ctx.game. } };';
    expect(typeOfIdentifier('ctx', text, BEHAVIOR_API_TYPES)).toBe('BehaviorContext');
    const top = memberCompletion('    ctx.ti', text, BEHAVIOR_API_TYPES);
    expect(top?.prefix).toBe('ti');
    expect(top?.members.map((m) => m.name)).toEqual(['timers']);
    const nested = memberCompletion('    ctx.game?.', text, BEHAVIOR_API_TYPES);
    expect(nested?.members.map((m) => m.name)).toContain('add');
    const timers = memberCompletion('ctx.timers.af', text, BEHAVIOR_API_TYPES);
    expect(timers?.members.map((m) => m.name)).toEqual(['after']);
    // Through a call's return type.
    const handle = memberCompletion("ctx.animator('door')?.", text, BEHAVIOR_API_TYPES);
    expect(handle?.members.length).toBeGreaterThan(0);
    // Unknown roots and members give nothing.
    expect(memberCompletion('foo.', text, BEHAVIOR_API_TYPES)).toBeNull();
    expect(memberCompletion('ctx.nope.', text, BEHAVIOR_API_TYPES)).toBeNull();
    expect(memberCompletion('a.ctx.', text, BEHAVIOR_API_TYPES)).toBeNull();
    // An annotation names the type of any identifier.
    expect(memberCompletion('info.', 'instantiate(p: unknown, info: BehaviorInstanceInfo) {}', BEHAVIOR_API_TYPES)?.members.map((m) => m.name)).toContain('entityId');
  });
});

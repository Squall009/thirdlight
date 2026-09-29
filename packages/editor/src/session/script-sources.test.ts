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
  specMemberCompletion,
  typeOfIdentifier,
} from './script-sources';

describe('script sources', () => {
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
    expect(top?.members.map((m) => m.name)).toEqual(['timers', 'timeline']);
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

describe('callback completion', () => {
  it('completes the spec members inside export default, and a callback event parameter by its position', () => {
    const top = 'export default {\n  step(s, ctx) { if (ctx.phase === "x") { const o = { a: "}" }; } },\n  onTri';
    const spec = specMemberCompletion(top, BEHAVIOR_API_TYPES);
    expect(spec?.prefix).toBe('onTri');
    expect(spec?.members.map((m) => m.name)).toEqual(['onTriggerEnter', 'onTriggerExit']);
    expect(specMemberCompletion('export default {\n  on', BEHAVIOR_API_TYPES)?.members.map((m) => m.name)).toEqual(
      expect.arrayContaining(['onEnable', 'onDisable', 'onDestroy', 'onContact', 'onMessage', 'onUiEvent', 'onAnimatorEvent']),
    );
    // Not inside a method body or a nested object, nor without export default.
    expect(specMemberCompletion('export default {\n  step(s, ctx) {\n    onTri', BEHAVIOR_API_TYPES)).toBeNull();
    expect(specMemberCompletion('const x = {\n  onTri', BEHAVIOR_API_TYPES)).toBeNull();

    const text = 'export default {\n  onTriggerEnter(state, event, ctx) {\n    event.\n  },\n  onMessage(s, m: BehaviorMessage, c) { m. },\n};';
    expect(typeOfIdentifier('event', text, BEHAVIOR_API_TYPES)).toBe('TriggerEventRecord');
    expect(memberCompletion('    event.tr', text, BEHAVIOR_API_TYPES)?.members.map((m) => m.name)).toEqual(['trigger']);
    expect(typeOfIdentifier('m', text, BEHAVIOR_API_TYPES)).toBe('BehaviorMessage');
    expect(typeOfIdentifier('c', text, BEHAVIOR_API_TYPES)).toBe('BehaviorContext');
    expect(typeOfIdentifier('e', 'export default { onUiEvent(_s, e, _c) {} };', BEHAVIOR_API_TYPES)).toBe('UiEventRecord');
    expect(typeOfIdentifier('e', 'export default { onContact(_s, e, _c) {} };', BEHAVIOR_API_TYPES)).toBe('ContactEventRecord');
    expect(typeOfIdentifier('e', 'export default { onAnimatorEvent(_s, e, _c) {} };', BEHAVIOR_API_TYPES)).toBe('AnimatorEventRecord');
  });
});

describe('staged library patches', () => {
  it('cuts a change into patches under the request budget; a large file comes in pieces that rebuild it exactly', async () => {
    const { fitsOneRequest, libraryStagePatches } = await import('./script-sources');
    const big = `"quoted" ${'x'.repeat(30_000)} é 🙂 ${'"y"'.repeat(8000)}\n`;
    const files = [
      { path: 'src/a.ts', text: 'export const a = 1;\n' },
      { path: 'src/big.json', text: big },
      { path: 'src/gone.ts', text: null },
    ];
    expect(fitsOneRequest(files)).toBe(false);
    const patches = libraryStagePatches('lib', files, 20_000);
    expect(patches.length).toBeGreaterThan(2);
    for (const p of patches) {
      expect(p.libraryId).toBe('lib');
      expect(new TextEncoder().encode(JSON.stringify(p.files)).length).toBeLessThanOrEqual(20_000);
    }
    // Replaying the patches in order (append adds to the file) gives exactly the change.
    const state = new Map<string, string | null>();
    for (const p of patches) for (const f of p.files) state.set(f.path, f.append === true ? `${state.get(f.path) ?? ''}${f.text}` : f.text);
    expect(state.get('src/big.json')).toBe(big);
    expect(state.get('src/a.ts')).toBe('export const a = 1;\n');
    expect(state.get('src/gone.ts')).toBeNull();
    expect(fitsOneRequest([{ path: 'src/a.ts', text: 'x' }])).toBe(true);
  });
});

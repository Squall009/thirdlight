/**
 * Game modes as data — shape rules, limits, references to UI
 * documents / input maps / behavior groups, the canonical form (field order,
 * absent fields stay absent), the runtime rows (each action's map), the
 * project's own input maps, and the behaviorGroup component.
 */
import { describe, expect, it } from 'vitest';

import {
  MODE_LIMITS,
  behaviorGroupErrors,
  canonicalInput,
  canonicalMode,
  modesForRuntime,
  projectInputMaps,
  validateBehaviorGroupComponent,
  validateBehaviorGroups,
  validateInput,
  validateModeReferences,
  validateModes,
  type GameMode,
  type ModelErrorV2,
} from './index';

const errs = (f: (e: ModelErrorV2[]) => void): ModelErrorV2[] => {
  const e: ModelErrorV2[] = [];
  f(e);
  return e;
};

const EXPLORE: GameMode = { modeId: 'explore', name: 'Explore', inputMaps: ['gameplay', 'ui'], camera: 'cam-follow', ui: ['hud'], groups: ['field'] };
const TACTICAL: GameMode = { modeId: 'tactical', name: 'Tactical', inputMaps: ['tactical', 'ui'], ui: ['board'], groups: ['board'], ungrouped: 'pause', pause: false, pauseScreen: 'menu', timeScale: 0.5, physics: 'hold', enter: { blend: 'eased', blendTime: 0.4, fade: 'fade', fadeTime: 0.3 } };

describe('game modes (data)', () => {
  it('accepts well-formed modes and refuses bad fields, duplicates and too many', () => {
    expect(errs((e) => validateModes([EXPLORE, TACTICAL], '/modes', e))).toEqual([]);
    const bad = errs((e) =>
      validateModes(
        [
          { modeId: 'A b', name: '' },
          { modeId: 'x', name: 'X', inputMaps: ['1bad'], ui: ['hud', 'hud'], ungrouped: 'maybe', pause: 'yes', timeScale: 0, physics: 'fly', enter: { blend: 'wipe', fadeTime: 20 }, extra: 1 },
          { modeId: 'x', name: 'Again' },
        ],
        '/modes',
        e,
      ),
    );
    const paths = bad.map((x) => x.path);
    for (const p of ['/modes/0/modeId', '/modes/0/name', '/modes/1/inputMaps/0', '/modes/1/ui/1', '/modes/1/ungrouped', '/modes/1/pause', '/modes/1/timeScale', '/modes/1/physics', '/modes/1/enter/blend', '/modes/1/enter/fadeTime', '/modes/1/extra', '/modes/2/modeId']) expect(paths, p).toContain(p);
    const many = Array.from({ length: MODE_LIMITS.modes + 1 }, (_, i) => ({ modeId: `m${i}`, name: `M${i}` }));
    expect(errs((e) => validateModes(many, '/modes', e)).some((x) => x.code === 'limits_exceeded')).toBe(true);
  });

  it('checks references against the project: documents, input maps (engine and input.maps), behavior groups', () => {
    const content = {
      uiDocuments: [{ uiDocumentId: 'hud' }, { uiDocumentId: 'board' }, { uiDocumentId: 'menu' }],
      input: { actions: [], maps: ['tactical'] },
      behaviorGroups: ['field', 'board'],
      modes: [EXPLORE, TACTICAL],
    };
    const missing = errs((e) => validateModeReferences(content, e));
    expect(missing.map((x) => x.path)).toEqual(['/modes/1/enter/fade']);
    const none = errs((e) => validateModeReferences({ modes: [TACTICAL] }, e));
    expect(none.map((x) => x.path).sort()).toEqual(['/modes/0/enter/fade', '/modes/0/groups/0', '/modes/0/inputMaps/0', '/modes/0/pauseScreen', '/modes/0/ui/0']);
  });

  it('keeps a canonical field order and drops nothing; the runtime rows carry each action\'s map', () => {
    const shuffled = { enter: { fadeTime: 0.3, fade: 'fade', blendTime: 0.4, blend: 'eased' }, physics: 'hold', timeScale: 0.5, pauseScreen: 'menu', pause: false, ungrouped: 'pause', groups: ['board'], ui: ['board'], inputMaps: ['tactical', 'ui'], name: 'Tactical', modeId: 'tactical' } as GameMode;
    expect(JSON.stringify(canonicalMode(shuffled))).toBe(JSON.stringify(TACTICAL));
    expect(canonicalMode({ modeId: 'a', name: 'A' })).toEqual({ modeId: 'a', name: 'A' });
    const rows = modesForRuntime([EXPLORE], { actions: [{ name: 'move', map: 'gameplay' }, { name: 'select', map: 'tactical' }] });
    expect(rows).toEqual({ modes: [EXPLORE], actionMaps: { move: 'gameplay', select: 'tactical' } });
    expect(modesForRuntime([], undefined)).toBeUndefined();
  });

  it('input.maps: the project\'s own maps (unique, not gameplay/ui); actions may use them; absent keeps the bytes', () => {
    const input = { actions: [{ name: 'select', type: 'button', map: 'tactical', bindings: [{ kind: 'key', code: 'Enter' }] }], maps: ['tactical'] };
    expect(errs((e) => validateInput(input, '/input', e))).toEqual([]);
    expect(errs((e) => validateInput({ ...input, maps: [] }, '/input', e)).map((x) => x.path)).toEqual(['/input/actions/0/map']);
    expect(errs((e) => validateInput({ actions: [], maps: ['ui', 'a', 'a', '9x'] }, '/input', e)).map((x) => x.path)).toEqual(['/input/maps/0', '/input/maps/2', '/input/maps/3']);
    expect(projectInputMaps(input)).toEqual(['gameplay', 'ui', 'tactical']);
    expect(projectInputMaps(undefined)).toEqual(['gameplay', 'ui']);
    expect(Object.keys(canonicalInput({ actions: [] }))).toEqual(['actions']);
    expect(canonicalInput(input as never).maps).toEqual(['tactical']);
  });

  it('phase 25.6: input.cursor takes every map of input.maps (and only the project\'s maps); canonical order gameplay, ui, own maps', () => {
    const input = { actions: [], maps: ['tactical', 'board'], cursor: { board: 'locked', tactical: 'free', ui: 'free', gameplay: 'locked' } };
    expect(errs((e) => validateInput(input, '/input', e))).toEqual([]);
    const bad = errs((e) => validateInput({ ...input, cursor: { ghost: 'free', tactical: 'sideways' } }, '/input', e));
    expect(bad.map((x) => [x.code, x.path])).toEqual([['field_unexpected', '/input/cursor/ghost'], ['field_value', '/input/cursor/tactical']]);
    expect(bad[0]!.message).toBe('"ghost" is not an input map of this project');
    // Without its map, a project map's cursor is refused.
    expect(errs((e) => validateInput({ actions: [], cursor: { tactical: 'free' } }, '/input', e)).map((x) => x.path)).toEqual(['/input/cursor/tactical']);
    expect(Object.keys(canonicalInput(input as never).cursor!)).toEqual(['gameplay', 'ui', 'tactical', 'board']);
  });

  it('behavior groups and the behaviorGroup component', () => {
    expect(errs((e) => validateBehaviorGroups(['field', 'board'], '/behaviorGroups', e))).toEqual([]);
    expect(errs((e) => validateBehaviorGroups(['a', 'a', 'b c'], '/behaviorGroups', e)).map((x) => x.path)).toEqual(['/behaviorGroups/1', '/behaviorGroups/2']);
    expect(errs((e) => validateBehaviorGroupComponent({ group: 'field' }, '/c', e))).toEqual([]);
    expect(errs((e) => validateBehaviorGroupComponent({ group: '', other: 1 }, '/c', e)).map((x) => x.path).sort()).toEqual(['/c/group', '/c/other']);
    expect(errs((e) => behaviorGroupErrors({ behaviorGroup: { group: 'field' } }, '/entities/0', ['field'], e))).toEqual([]);
    expect(errs((e) => behaviorGroupErrors({ behaviorGroup: { group: 'ghost' } }, '/entities/0', ['field'], e)).map((x) => [x.code, x.path])).toEqual([['reference_missing', '/entities/0/components/behaviorGroup/group']]);
  });
});

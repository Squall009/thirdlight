import { describe, expect, it } from 'vitest';

import {
  GAME_OBSERVATION_HEADER,
  GAME_OBSERVATION_MAX_BYTES,
  PLAY_DIAGNOSTICS_MAX_BYTES,
  PLAY_DIAGNOSTICS_SECTIONS,
  fitGameObservation,
  fitPlayDiagnostics,
  parseDiagnosticsRequest,
  parseGameObserveRequest,
  parseInboundEvent,
  pickPlaySections,
  validateBridgeEditorToPreview,
  validateBridgePreviewToEditor,
  validateGameObservation,
} from './index';

const bytes = (v: unknown): number => new TextEncoder().encode(JSON.stringify(v)).length;
const entry = (i: number) => ({ code: 'behavior_log', reason: 'warn', moduleId: 'thirdlight.behavior:talker', message: `line ${i} ${'—'.repeat(240)}`, stepIndex: i });

describe('Play diagnostics within the relay bound', () => {
  it('leaves a report that fits as it is', () => {
    const d = { runtime: { errors: [entry(1)], errorCount: 1 }, buildId: 'b' };
    expect(fitPlayDiagnostics(d)).toBe(d);
  });

  it('drops the oldest play log entries first and says how many', () => {
    const errors = Array.from({ length: 32 }, (_, i) => entry(i));
    const d = { runtime: { state: 'running', errors, errorCount: 900 }, buildId: 'b', audio: { voices: [] } };
    expect(bytes(d)).toBeGreaterThan(PLAY_DIAGNOSTICS_MAX_BYTES);
    const fit = fitPlayDiagnostics(d) as { runtime: { errors: { stepIndex: number }[]; errorCount: number }; trimmed: { logEntries: number; lists: Record<string, number>; omitted: string[] } };
    expect(bytes(fit)).toBeLessThanOrEqual(PLAY_DIAGNOSTICS_MAX_BYTES);
    expect(fit.trimmed.logEntries).toBeGreaterThan(0);
    expect(fit.runtime.errors.length).toBe(32 - fit.trimmed.logEntries);
    // The newest entries stay, in order; the totals and the rest are untouched.
    expect(fit.runtime.errors.map((e) => e.stepIndex)).toEqual(errors.slice(fit.trimmed.logEntries).map((e) => e.stepIndex));
    expect(fit.runtime.errorCount).toBe(900);
    expect(fit.trimmed.lists).toEqual({});
    expect(fit.trimmed.omitted).toEqual([]);
    // The input is not changed.
    expect(d.runtime.errors).toHaveLength(32);
    // The bridge takes the trimmed report (it refused the whole one).
    const msg = (diagnostics: unknown) => ({ v: 2, type: 'tl.diagnostics.result', playSessionId: `play-${'a'.repeat(32)}`, relayId: `relay-${'b'.repeat(32)}`, ok: true, diagnostics });
    expect(validateBridgePreviewToEditor(msg(fit)).ok).toBe(true);
  });

  it('cuts the other lists before the play log, oldest first, and leaves whole parts out after them', () => {
    const reads = Array.from({ length: 2000 }, (_, i) => ({ assetId: `asset-${i}`, bytes: i }));
    const fit = fitPlayDiagnostics({ runtime: { errors: [entry(1)] }, assetReads: reads, buildId: 'b' }) as { assetReads: { assetId: string }[]; runtime: { errors: unknown[] }; trimmed: { logEntries: number; lists: Record<string, number> } };
    expect(bytes(fit)).toBeLessThanOrEqual(PLAY_DIAGNOSTICS_MAX_BYTES);
    expect(fit.trimmed.logEntries).toBe(0);
    expect(fit.runtime.errors).toHaveLength(1);
    expect(fit.trimmed.lists['assetReads']).toBe(2000 - fit.assetReads.length);
    expect(fit.assetReads.at(-1)!.assetId).toBe('asset-1999');
    const huge = fitPlayDiagnostics({ runtime: { state: 'running' }, renderer: { note: 'x'.repeat(40_000) } }) as { trimmed: { omitted: string[] }; runtime?: unknown };
    expect(bytes(huge)).toBeLessThanOrEqual(PLAY_DIAGNOSTICS_MAX_BYTES);
    expect(huge.trimmed.omitted).toEqual(['renderer']);
    expect(huge.runtime).toEqual({ state: 'running' });
  });

  it('a big scene keeps every error: copies folded with a count, other lists and log lines cut first, whole parts after', () => {
    // 10 distinct errors, 6 log lines, 16 identical effect rows, thousands of texture rows, a big renderer block.
    const thrown = (i: number) => ({ code: 'module_error', reason: 'behavior_step_failed', moduleId: 'thirdlight.behavior:director', message: `error ${i} ${'x'.repeat(300)}`, stepIndex: 100 + i, entityId: `unit-${i}`, at: { file: `behaviors/${'a'.repeat(64)}.js`, line: 3, column: 9 } });
    const errors = [...Array.from({ length: 6 }, (_, i) => entry(i)), ...Array.from({ length: 10 }, (_, i) => thrown(i))];
    const effects = Array.from({ length: 16 }, () => ({ effect: 'fire-building', executor: 'webgpu', particles: 400 }));
    const textures = Array.from({ length: 3000 }, (_, i) => ({ assetId: `tex-${i}`, bytes: 4096 * i, format: 'ktx2' }));
    const scene = (note: number) => ({ runtime: { state: 'running', errors, errorCount: 16, modules: ['a', 'b'] }, renderer: { effects: { instances: effects }, textures, note: 'r'.repeat(note) }, buildId: 'b' });
    type Fit = { runtime: { errors: { message: string; code: string }[]; errorCount: number }; renderer?: { effects: { instances: unknown[] }; textures: unknown[] }; trimmed: { logEntries: number; errorEntries: number; lists: Record<string, number>; omitted: string[]; merged: Record<string, number> } };
    const keepsErrors = (fit: Fit): void => {
      expect(bytes(fit)).toBeLessThanOrEqual(PLAY_DIAGNOSTICS_MAX_BYTES);
      expect(fit.runtime.errors.filter((e) => e.code !== 'behavior_log').map((e) => e.message)).toEqual(errors.slice(6).map((e) => e.message));
      expect(fit.trimmed.errorEntries).toBe(0);
      expect(fit.runtime.errorCount).toBe(16);
      expect(fit.trimmed.merged['renderer.effects.instances']).toBe(15);
      expect(fit.trimmed.lists['renderer.textures']).toBeGreaterThan(2000);
    };
    // The texture rows go; the 16 effect copies stay as one row "×16"; every log line stays.
    const small = fitPlayDiagnostics(scene(3000)) as Fit;
    keepsErrors(small);
    expect(small.renderer!.effects.instances).toEqual([{ ...effects[0], count: 16 }]);
    expect(small.trimmed.logEntries).toBe(0);
    expect(small.runtime.errors).toHaveLength(16);
    // A bigger renderer block: every other list, then the oldest log lines, then the renderer part (named, with counts).
    const big = fitPlayDiagnostics(scene(12_000)) as Fit;
    keepsErrors(big);
    expect(big.trimmed.lists['renderer.textures']).toBe(3000);
    expect(big.trimmed.lists['renderer.effects.instances']).toBe(1);
    expect(big.trimmed.logEntries).toBe(6);
    expect(big.trimmed.omitted).toEqual(['renderer']);
    expect(big.runtime.errors).toHaveLength(10);
  });

  it('cuts errors only when they alone outgrow the bound, oldest first', () => {
    const errors = Array.from({ length: 64 }, (_, i) => ({ code: 'module_error', message: `error ${i} ${'y'.repeat(250)}`, stepIndex: i }));
    const fit = fitPlayDiagnostics({ runtime: { state: 'running', errors, errorCount: 64 }, buildId: 'b' }) as { runtime: { errors: { stepIndex: number }[] }; buildId?: string; trimmed: { logEntries: number; errorEntries: number; omitted: string[] } };
    expect(bytes(fit)).toBeLessThanOrEqual(PLAY_DIAGNOSTICS_MAX_BYTES);
    expect(fit.trimmed.errorEntries).toBe(fit.trimmed.logEntries);
    expect(fit.trimmed.errorEntries).toBe(64 - fit.runtime.errors.length);
    expect(fit.runtime.errors.at(-1)!.stepIndex).toBe(63);
    expect(fit.trimmed.omitted).toContain('buildId');
  });

  it('trims an oversize observation instead of the bridge refusing it: the header and a failed run\'s error stay', () => {
    const header = { ok: true, playSessionId: `play-${'a'.repeat(32)}`, snapshotId: 'snap', buildId: 'b', runId: 'snap@r1#0', revision: 1, observedAt: '2026-10-21T00:00:00Z', stepIndex: 9, simTime: 0.1, state: 'running', error: { code: 'module_error', message: 'stopped' }, inputMode: 'physical', sound: { status: 'ready', unlocked: true, muted: false, voices: 0, gesture: 'none' } };
    const o = { ...header, player: { x: 1, y: 2, z: 3 }, debug: { trace: Array.from({ length: 900 }, (_, i) => `node-${i}`) }, audio: { voices: Array.from({ length: 40 }, () => ({ assetId: 'fire-crackle', gain: 0.5 })) }, ui: { values: 'v'.repeat(9000) } };
    const result = (r: unknown) => validateBridgePreviewToEditor({ v: 2, type: 'tl.game.observe.result', playSessionId: header.playSessionId, relayId: `relay-${'b'.repeat(32)}`, ok: true, result: r });
    expect(bytes(o)).toBeGreaterThan(GAME_OBSERVATION_MAX_BYTES);
    expect(result(o).ok).toBe(false);
    const fit = fitGameObservation(o) as typeof o & { trimmed: { lists: Record<string, number>; omitted: string[]; merged: Record<string, number> } };
    expect(bytes(fit)).toBeLessThanOrEqual(GAME_OBSERVATION_MAX_BYTES);
    expect(result(fit).ok).toBe(true);
    expect(validateGameObservation(fit), JSON.stringify(validateGameObservation(fit))).toMatchObject({ ok: true });
    for (const k of GAME_OBSERVATION_HEADER) expect(fit[k]).toEqual(header[k]);
    expect(fit.player).toEqual({ x: 1, y: 2, z: 3 });
    expect(fit.trimmed.merged['audio.voices']).toBe(39);
    expect(fit.trimmed.lists['debug.trace']).toBeGreaterThan(0);
    expect(fit.debug.trace.at(-1)).toBe('node-899');
    expect(fit.trimmed.omitted).toEqual([]);
    // A part too big for the bound on its own is left out whole; the header stays.
    const whole = fitGameObservation({ ...o, ui: { values: 'v'.repeat(20_000) } }) as typeof fit;
    expect(bytes(whole)).toBeLessThanOrEqual(GAME_OBSERVATION_MAX_BYTES);
    expect(whole.trimmed.omitted).toEqual(['ui']);
    expect(whole.error).toEqual(header.error);
    expect(validateGameObservation(whole).ok).toBe(true);
  });

  it('sections: only the named parts (an observation keeps its header); an unknown name is refused with the valid ones', () => {
    const d = { runtime: { errors: [] }, renderer: {}, buildId: 'b', assetReads: [] };
    expect(pickPlaySections(d, ['runtime'])).toEqual({ runtime: { errors: [] } });
    expect(pickPlaySections(d, undefined)).toBe(d);
    expect(pickPlaySections({ ok: true, state: 'running', player: {}, audio: {} }, ['player'], GAME_OBSERVATION_HEADER)).toEqual({ ok: true, state: 'running', player: {} });
    expect(parseDiagnosticsRequest({ sections: ['runtime', 'audio'] })).toEqual({ ok: true, request: { sections: ['runtime', 'audio'] } });
    expect(parseDiagnosticsRequest({})).toEqual({ ok: true, request: {} });
    const bad = parseDiagnosticsRequest({ sections: ['runtime', 'errors'] });
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(bad.error.message).toMatch(/^unknown section "errors"; the sections are: runtime, renderer/);
      expect(bad.error.expected).toBe(PLAY_DIAGNOSTICS_SECTIONS.join(', '));
    }
    expect(parseDiagnosticsRequest({ sections: [] }).ok).toBe(false);
    const obs = parseGameObserveRequest({ sections: ['player', 'scenes'] });
    expect(obs.ok && obs.request.sections).toEqual(['player', 'scenes']);
    const wrong = parseGameObserveRequest({ sections: ['playre'] });
    expect(!wrong.ok && wrong.error.path).toBe('/sections');
    const req = (sections: unknown) => validateBridgeEditorToPreview({ v: 2, type: 'tl.game.observe', playSessionId: `play-${'a'.repeat(32)}`, relayId: `relay-${'b'.repeat(32)}`, sections });
    expect(req(['player']).ok).toBe(true);
    expect(req(['nope']).ok).toBe(false);
  });

  it('measures the bound in UTF-8 bytes: non-ASCII log lines within 16 Ki characters are refused whole, taken trimmed', () => {
    // 12 lines of 1,000 three-byte characters: about 12 Ki UTF-16 units, about 36 KiB of UTF-8.
    const errors = Array.from({ length: 12 }, (_, i) => ({ code: 'behavior_log', reason: 'warn', moduleId: 'thirdlight.behavior:talker', message: `${i} ${'\u2014'.repeat(1000)}`, stepIndex: i }));
    const d = { runtime: { state: 'running', errors, errorCount: 12 }, buildId: 'b' };
    expect(JSON.stringify(d).length).toBeLessThan(PLAY_DIAGNOSTICS_MAX_BYTES);
    expect(bytes(d)).toBeGreaterThan(PLAY_DIAGNOSTICS_MAX_BYTES);
    const bridge = (diagnostics: unknown) => validateBridgePreviewToEditor({ v: 2, type: 'tl.diagnostics.result', playSessionId: `play-${'a'.repeat(32)}`, relayId: `relay-${'b'.repeat(32)}`, ok: true, diagnostics });
    const ws = (diagnostics: unknown) => parseInboundEvent({ type: 'play.diagnostics.ack', relayId: `relay-${'b'.repeat(32)}`, ok: true, diagnostics });
    expect(bridge(d).ok).toBe(false);
    expect(ws(d).ok).toBe(false);
    const fit = fitPlayDiagnostics(d) as { runtime: { errors: unknown[] }; trimmed: { logEntries: number } };
    expect(fit.trimmed.logEntries).toBeGreaterThan(6);
    expect(bytes(fit)).toBeLessThanOrEqual(PLAY_DIAGNOSTICS_MAX_BYTES);
    expect(bridge(fit).ok).toBe(true);
    expect(ws(fit).ok).toBe(true);
  });
});

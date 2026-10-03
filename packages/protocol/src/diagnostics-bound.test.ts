import { describe, expect, it } from 'vitest';

import { PLAY_DIAGNOSTICS_MAX_BYTES, fitPlayDiagnostics, parseInboundEvent, validateBridgePreviewToEditor } from './index';

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

  it('then trims other lists, oldest first, and leaves whole parts out last', () => {
    const reads = Array.from({ length: 2000 }, (_, i) => ({ assetId: `asset-${i}`, bytes: i }));
    const fit = fitPlayDiagnostics({ runtime: { errors: [entry(1)] }, assetReads: reads, buildId: 'b' }) as { assetReads: { assetId: string }[]; runtime: { errors: unknown[] }; trimmed: { logEntries: number; lists: Record<string, number> } };
    expect(bytes(fit)).toBeLessThanOrEqual(PLAY_DIAGNOSTICS_MAX_BYTES);
    expect(fit.trimmed.logEntries).toBe(1);
    expect(fit.trimmed.lists['assetReads']).toBe(2000 - fit.assetReads.length);
    expect(fit.assetReads.at(-1)!.assetId).toBe('asset-1999');
    const huge = fitPlayDiagnostics({ runtime: { state: 'running' }, renderer: { note: 'x'.repeat(40_000) } }) as { trimmed: { omitted: string[] }; runtime?: unknown };
    expect(bytes(huge)).toBeLessThanOrEqual(PLAY_DIAGNOSTICS_MAX_BYTES);
    expect(huge.trimmed.omitted).toEqual(['renderer']);
    expect(huge.runtime).toEqual({ state: 'running' });
  });

  it('measures the bound in UTF-8 bytes: non-ASCII log lines within 16 Ki characters are refused whole, taken trimmed', () => {
    // 12 lines of 1,000 three-byte characters: about 12 Ki UTF-16 units, about 36 KiB of UTF-8.
    const errors = Array.from({ length: 12 }, (_, i) => ({ code: 'behavior_log', reason: 'warn', moduleId: 'thirdlight.behavior:talker', message: `${'\u2014'.repeat(1000)}`, stepIndex: i }));
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

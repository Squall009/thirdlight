import { describe, expect, it } from 'vitest';

import { ErrorRing, MAX_ERROR_ENTRIES } from './error-ring';
import type { DiagnosticErrorEntry } from './types';

const thrown = (entityId: string, step: number): DiagnosticErrorEntry => ({ code: 'module_error', reason: 'behavior_step_failed', moduleId: 'thirdlight.behavior:fire', message: 'boom', stepIndex: step, entityId, at: { file: `behaviors/${'a'.repeat(64)}.js`, line: 3, column: 9 } });
const log = (text: string, step: number): DiagnosticErrorEntry => ({ code: 'behavior_log', reason: 'info', moduleId: 'thirdlight.behavior:talker', message: text, stepIndex: step });

describe('the runtime error ring', () => {
  it('folds copies of one error (16 objects throwing the same) into one row with a count, first and last step and a few objects', () => {
    const ring = new ErrorRing();
    for (let i = 0; i < 16; i += 1) ring.push(thrown(`fire-${i}`, 10 + i));
    ring.push({ ...thrown('fire-0', 40), message: 'another' });
    const rows = ring.entries();
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ message: 'boom', count: 16, firstStep: 10, stepIndex: 25, entityId: 'fire-0', entityIds: ['fire-0', 'fire-1', 'fire-2', 'fire-3'] });
    expect(rows[1]).toMatchObject({ message: 'another', entityId: 'fire-0' });
    expect(rows[1]!.count).toBeUndefined();
    // A row handed out never changes when a later copy is folded in.
    ring.push(thrown('fire-9', 50));
    expect(rows[0]!.count).toBe(16);
    expect(ring.entries().at(-1)).toMatchObject({ message: 'boom', count: 17, stepIndex: 50 });
  });

  it('keeps the last 32 distinct rows; a line logged every step cannot push the errors out', () => {
    const ring = new ErrorRing();
    for (let i = 0; i < 40; i += 1) ring.push(log(`line ${i}`, i));
    expect(ring.entries().map((r) => r.message)).toEqual(Array.from({ length: MAX_ERROR_ENTRIES }, (_, i) => `line ${i + 8}`));
    const errors = Array.from({ length: 10 }, (_, i) => ({ ...thrown('e', 100 + i), message: `error ${i}` }));
    for (const e of errors) ring.push(e);
    for (let i = 0; i < 100; i += 1) ring.push(log(`later ${i}`, 200 + i));
    const rows = ring.entries();
    expect(rows).toHaveLength(MAX_ERROR_ENTRIES);
    expect(rows.filter((r) => r.code !== 'behavior_log').map((r) => r.message)).toEqual(errors.map((e) => e.message));
    expect(rows.at(-1)!.message).toBe('later 99');
    // Many errors: they take the half of the ring the log lines do not need, newest kept; the newest log lines keep the other half.
    for (let i = 0; i < 40; i += 1) ring.push({ ...thrown('e', 400 + i), message: `late error ${i}` });
    const mixed = ring.entries();
    expect(mixed.filter((r) => r.code === 'behavior_log').map((r) => r.message)).toEqual(Array.from({ length: 16 }, (_, i) => `later ${84 + i}`));
    expect(mixed.filter((r) => r.code !== 'behavior_log').map((r) => r.message)).toEqual(Array.from({ length: 16 }, (_, i) => `late error ${24 + i}`));
    // Without log lines, errors fill the whole ring.
    const only = new ErrorRing();
    for (let i = 0; i < 40; i += 1) only.push({ ...thrown('e', i), message: `error ${i}` });
    expect(only.entries()).toHaveLength(MAX_ERROR_ENTRIES);
    expect(only.entries()[0]!.message).toBe('error 8');
  });
});

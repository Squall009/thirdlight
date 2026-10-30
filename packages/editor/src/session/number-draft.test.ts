import { describe, expect, it } from 'vitest';
import { numberDraft } from './number-draft';

describe('number field drafts', () => {
  it('reads a finite number and refuses anything else', () => {
    expect(numberDraft(' 2.5 ', {})).toBe(2.5);
    expect(numberDraft('1e3', {})).toBe(1000);
    expect(numberDraft('abc', {})).toBeUndefined();
    expect(numberDraft('Infinity', {})).toBeUndefined();
    expect(numberDraft('', {})).toBeUndefined();
  });
  it('an empty optional box is none', () => {
    expect(numberDraft('  ', { optional: true })).toBeNull();
  });
  it('out of range is refused by default and clamped on request', () => {
    expect(numberDraft('11', { min: 0, max: 10 })).toBeUndefined();
    expect(numberDraft('-1', { min: 0, max: 10, outOfRange: 'reject' })).toBeUndefined();
    expect(numberDraft('11', { min: 0, max: 10, outOfRange: 'clamp' })).toBe(10);
    expect(numberDraft('-1', { min: 0, outOfRange: 'clamp' })).toBe(0);
    expect(numberDraft('10', { min: 0, max: 10 })).toBe(10);
  });
});

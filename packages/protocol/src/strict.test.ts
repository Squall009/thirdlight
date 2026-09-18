/**
 * Strict JSON payload discipline (sessions.md §1/§6.1/§11.2) — pass-1 byte
 * rules via project-model, strict shape helpers (unknown fields rejected).
 */
import { describe, expect, it } from 'vitest';
import {
  checkField,
  checkOptionalObject,
  checkShape,
  parseStrictJson,
  parseStrictJsonBytes,
} from './strict';

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

describe('parseStrictJsonBytes (sessions.md §6.1 pass-1)', () => {
  it('parses valid strict JSON', () => {
    const r = parseStrictJsonBytes(enc('{"a":1,"b":[1,2]}'));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual({ a: 1, b: [1, 2] });
  });

  it('rejects a BOM with encoding_invalid (never silently stripped)', () => {
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...enc('{"a":1}')]);
    const r = parseStrictJsonBytes(bytes);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('invalid_request');
  });

  it('rejects duplicate keys (strict pass-1)', () => {
    const r = parseStrictJsonBytes(enc('{"a":1,"a":2}'));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('invalid_request');
  });

  it('rejects malformed JSON', () => {
    const r = parseStrictJsonBytes(enc('{"a":1'));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('invalid_request');
      expect(r.error.cls).toBe('validation');
      expect(r.error.message.length).toBeLessThanOrEqual(256);
    }
  });
});

describe('checkShape (unknown fields rejected — sessions.md §1)', () => {
  const allowed = new Map([
    ['a', 'number'],
    ['b', 'string (optional)'],
  ]);

  it('accepts the exact shape', () => {
    const r = checkShape({ a: 1, b: 'x' }, '', allowed, ['a']);
    expect(r.ok).toBe(true);
  });

  it('unknown field ⇒ field_unexpected with path', () => {
    const r = checkShape({ a: 1, c: true }, '', allowed, ['a']);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('field_unexpected');
      expect(r.error.path).toBe('/c');
      expect(r.error.cls).toBe('validation');
    }
  });

  it('missing required field ⇒ field_missing with path + expected', () => {
    const r = checkShape({ b: 'x' }, '', allowed, ['a']);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('field_missing');
      expect(r.error.path).toBe('/a');
      expect(r.error.expected).toBe('number');
    }
  });

  it('non-object ⇒ field_type', () => {
    for (const v of ['nope', null, [1], 42]) {
      const r = checkShape(v, '', allowed, ['a']);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe('field_type');
    }
  });

  it('nested path prefixes propagate', () => {
    const r = checkShape({ y: 1 }, '/opt', new Map([['x', 'n']]), []);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.path).toBe('/opt/y');
  });
});

describe('checkField / checkOptionalObject', () => {
  it('checkField: type verdict ⇒ field_type; value verdict ⇒ field_value', () => {
    const r1 = checkField({ v: 's' }, 'v', '', 'boolean', (x) =>
      typeof x === 'boolean' ? null : { problem: 'must be boolean', kind: 'type' },
    );
    expect(r1.ok).toBe(false);
    if (!r1.ok) {
      expect(r1.error.code).toBe('field_type');
      expect(r1.error.path).toBe('/v');
      expect(r1.error.found).toBe('string');
    }
    const r2 = checkField({ v: 3 }, 'v', '', 'integer 1–2', (x) =>
      typeof x === 'number' && Number.isInteger(x) && x >= 1 && x <= 2
        ? null
        : { problem: 'out of range', kind: 'value' },
    );
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.error.code).toBe('field_value');
  });

  it('checkOptionalObject: absent ⇒ {}', () => {
    const r = checkOptionalObject({}, 'opt', '', new Map([['x', 'n']]), []);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual({});
  });

  it('checkOptionalObject: present unknown field ⇒ field_unexpected', () => {
    const r = checkOptionalObject({ opt: { y: 1 } }, 'opt', '', new Map([['x', 'n']]), []);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('field_unexpected');
      expect(r.error.path).toBe('/opt/y');
    }
  });
});

describe('parseStrictJson (WS text frames)', () => {
  it('round-trips a strict object', () => {
    const r = parseStrictJson('{"type":"ping"}');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual({ type: 'ping' });
  });
  it('rejects non-objects and malformed frames', () => {
    expect(parseStrictJson('42').ok).toBe(true); // pass-1 allows any JSON value; shape checks are the caller's
    expect(parseStrictJson('{bad').ok).toBe(false);
  });
});
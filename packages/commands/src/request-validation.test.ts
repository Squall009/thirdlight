/**
 * Strict request validation — commands.md §3/§3.1/§5.4: envelope-level
 * failures are `invalid_request` (path/found/expected); args-level
 * failures are the `field_*` codes. Nothing is silently dropped.
 */

import { describe, expect, it } from 'vitest';

import {
  applyMutation,
  createCommandState,
  type CommandError,
} from './index';
import { cameraEntity, freshRequestId, req, scene } from './test-scene';

const ST = createCommandState(scene(0, [cameraEntity()]));

/** Apply a malformed request; return the structured error (never throws). */
function err(request: unknown): CommandError {
  const r = applyMutation(ST, request);
  if (r.ok) throw new Error('malformed request should not succeed');
  return r.result.ok === false ? r.result.error : ({} as never);
}

const VALID_ARGS: Record<string, unknown> = { kind: 'box' };

describe('envelope-level strictness (invalid_request)', () => {
  it('non-object roots fail at path ""', () => {
    for (const v of [42, 'x', null, [1], true]) {
      const e = err(v);
      expect(e.code).toBe('invalid_request');
      expect(e.cls).toBe('validation');
      expect(e.path).toBe('');
      expect(e.expected).toBeDefined();
    }
  });

  it('unknown top-level fields are rejected (strict; nothing dropped)', () => {
    const e = err({ ...req('createEntity', VALID_ARGS), extra: 1 });
    expect(e.code).toBe('invalid_request');
    expect(e.path).toBe('/extra');
    expect(e.found).toBe('extra');
  });

  it.each([
    ['missing', (o: Record<string, unknown>) => delete o.op],
    ['non-string', (o: Record<string, unknown>) => (o.op = 7)],
    ['unknown value', (o: Record<string, unknown>) => (o.op = 'renameEntity')],
  ])('op %s ⇒ invalid_request at /op', (_label, mutate) => {
    const o = req('createEntity', VALID_ARGS);
    mutate(o);
    const e = err(o);
    expect(e.code).toBe('invalid_request');
    expect(e.path).toBe('/op');
  });

  it.each([
    ['missing', (o: Record<string, unknown>) => delete o.projectId],
    ['uppercase', (o: Record<string, unknown>) => (o.projectId = 'DEMO-0001')],
    ['space', (o: Record<string, unknown>) => (o.projectId = 'demo 0001')],
    ['too long', (o: Record<string, unknown>) => (o.projectId = 'a'.repeat(65))],
    ['non-string', (o: Record<string, unknown>) => (o.projectId = 5)],
  ])('projectId %s ⇒ invalid_request at /projectId', (_label, mutate) => {
    const o = req('createEntity', VALID_ARGS);
    mutate(o);
    const e = err(o);
    expect(e.code).toBe('invalid_request');
    expect(e.path).toBe('/projectId');
  });

  it.each([
    ['missing', (o: Record<string, unknown>) => delete o.expectedRevision],
    ['string', (o: Record<string, unknown>) => (o.expectedRevision = '4')],
    ['fractional', (o: Record<string, unknown>) => (o.expectedRevision = 1.5)],
    ['negative', (o: Record<string, unknown>) => (o.expectedRevision = -1)],
    ['2^53 (unsafe)', (o: Record<string, unknown>) => (o.expectedRevision = 2 ** 53)],
  ])('expectedRevision %s ⇒ invalid_request at /expectedRevision', (_label, mutate) => {
    const o = req('createEntity', VALID_ARGS);
    mutate(o);
    const e = err(o);
    expect(e.code).toBe('invalid_request');
    expect(e.path).toBe('/expectedRevision');
  });

  it.each([
    ['missing', (o: Record<string, unknown>) => delete o.requestId],
    ['uppercase hex', (o: Record<string, unknown>) => (o.requestId = 'req-ABCDEFABCDEFABCDEFABCDEFABCDEFABCDEF')],
    ['31 hex', (o: Record<string, unknown>) => (o.requestId = `req-${'a'.repeat(31)}`)],
    ['33 hex', (o: Record<string, unknown>) => (o.requestId = `req-${'a'.repeat(33)}`)],
    ['no prefix', (o: Record<string, unknown>) => (o.requestId = 'a'.repeat(32))],
    ['non-string', (o: Record<string, unknown>) => (o.requestId = 9)],
  ])('requestId %s ⇒ invalid_request at /requestId', (_label, mutate) => {
    const o = req('createEntity', VALID_ARGS);
    mutate(o);
    const e = err(o);
    expect(e.code).toBe('invalid_request');
    expect(e.path).toBe('/requestId');
  });

  it.each([
    ['non-object', (o: Record<string, unknown>) => (o.origin = 'browser')],
    ['unknown field', (o: Record<string, unknown>) => (o.origin = { kind: 'browser', clientId: 'x', extra: 1 })],
    ['bad kind', (o: Record<string, unknown>) => (o.origin = { kind: 'agent', clientId: 'x' })],
    ['empty clientId', (o: Record<string, unknown>) => (o.origin = { kind: 'browser', clientId: '' })],
    ['129-char clientId', (o: Record<string, unknown>) => (o.origin = { kind: 'browser', clientId: 'a'.repeat(129) })],
    ['control char', (o: Record<string, unknown>) => (o.origin = { kind: 'browser', clientId: 'a\u001fb' })],
    ['DEL char', (o: Record<string, unknown>) => (o.origin = { kind: 'browser', clientId: 'a\u007fb' })],
    ['missing clientId', (o: Record<string, unknown>) => (o.origin = { kind: 'browser' })],
  ])('origin %s ⇒ invalid_request', (_label, mutate) => {
    const o = req('createEntity', VALID_ARGS);
    mutate(o);
    const e = err(o);
    expect(e.code).toBe('invalid_request');
    expect(e.path ?? '').toMatch(/^\/origin(\/[\w-]+)?$/);
  });

  it('origin absent ⇒ accepted (recorded as null in the history entry)', () => {
    const o = req('createEntity', VALID_ARGS, { origin: null });
    const r = applyMutation(ST, o);
    expect(r.ok).toBe(true);
    if (r.ok) {
      const entry = r.state.history.entries[0];
      expect(entry).toBeDefined();
      expect(entry?.origin).toBeNull();
    }
  });

  it.each([
    ['missing', (o: Record<string, unknown>) => delete o.args],
    ['array', (o: Record<string, unknown>) => (o.args = [1])],
    ['string', (o: Record<string, unknown>) => (o.args = 'x')],
    ['null', (o: Record<string, unknown>) => (o.args = null)],
  ])('args %s ⇒ invalid_request at /args', (_label, mutate) => {
    const o = req('createEntity', VALID_ARGS);
    mutate(o);
    const e = err(o);
    expect(e.code).toBe('invalid_request');
    expect(e.path).toBe('/args');
  });
});

describe('args-level strictness (field_*) — createEntity', () => {
  const base = () => req('createEntity', VALID_ARGS);

  it.each([
    ['missing', (o: Record<string, unknown>) => delete (o.args as Record<string, unknown>).kind],
    ['non-string', (o: Record<string, unknown>) => ((o.args as Record<string, unknown>).kind = 3)],
    ['camera', (o: Record<string, unknown>) => ((o.args as Record<string, unknown>).kind = 'camera')],
  ])('kind %s', (_label, mutate) => {
    const o = base();
    mutate(o);
    const e = err(o);
    expect(e.path).toBe('/args/kind');
    if (_label === 'missing') expect(e.code).toBe('field_missing');
    if (_label === 'non-string') {
      expect(e.code).toBe('field_type');
      expect(e.found).toBe(3);
    }
    if (_label === 'camera') {
      expect(e.code).toBe('field_value');
      expect(e.expected).toBe('"group" or "box"');
    }
  });

  it('unknown args field ⇒ field_unexpected with the key as found', () => {
    const o = base();
    (o.args as Record<string, unknown>).velocity = [1, 0, 0];
    const e = err(o);
    expect(e.code).toBe('field_unexpected');
    expect(e.path).toBe('/args/velocity');
    expect(e.found).toBe('velocity');
    expect(e.expected).toContain('known fields');
  });

  it.each([
    ['empty name', { kind: 'box', name: '' }],
    ['129-char name', { kind: 'box', name: 'a'.repeat(129) }],
    ['control char name', { kind: 'box', name: 'a\u001fb' }],
  ])('name %s ⇒ field_value at /args/name', (_label, args) => {
    const e = err(req('createEntity', args as Record<string, unknown>));
    expect(e.code).toBe('field_value');
    expect(e.path).toBe('/args/name');
  });

  it('non-string name ⇒ field_type', () => {
    const e = err(req('createEntity', { kind: 'box', name: 5 } as Record<string, unknown>));
    expect(e.code).toBe('field_type');
    expect(e.path).toBe('/args/name');
  });

  it('parentId wrong type ⇒ field_type', () => {
    const e = err(req('createEntity', { kind: 'box', parentId: 9 } as Record<string, unknown>));
    expect(e.code).toBe('field_type');
    expect(e.path).toBe('/args/parentId');
  });

  it.each([
    ['transform non-object', { kind: 'box', transform: 'abc' }],
    ['transform empty', { kind: 'box', transform: {} }],
    ['transform unknown field', { kind: 'box', transform: { velocity: [1] } }],
    ['transform position non-array', { kind: 'box', transform: { position: 1 } }],
  ])('transform %s', (_label, args) => {
    const e = err(req('createEntity', args as Record<string, unknown>));
    const path = String(e.path);
    expect(path).toMatch(/^\/args\/transform(\/(position|rotation|scale|velocity))?$/);
    if (_label === 'transform non-object' || _label === 'transform empty') {
      expect(e.path).toBe('/args/transform');
      expect(e.code).toBe(_label === 'transform non-object' ? 'field_type' : 'field_value');
    }
    if (_label === 'transform unknown field') {
      expect(e.code).toBe('field_unexpected');
      expect(e.path).toBe('/args/transform/velocity');
    }
    if (_label === 'transform position non-array') {
      expect(e.code).toBe('field_type');
      expect(e.path).toBe('/args/transform/position');
    }
  });

  it('box with kind "group" ⇒ field_unexpected at /args/box', () => {
    const e = err(req('createEntity', { kind: 'group', box: {} } as Record<string, unknown>));
    expect(e.code).toBe('field_unexpected');
    expect(e.path).toBe('/args/box');
  });

  it.each([
    ['box non-object', { kind: 'box', box: 'big' }],
    ['box unknown field', { kind: 'box', box: { radius: 1 } }],
    ['size non-array', { kind: 'box', box: { size: 1 } }],
    ['material non-object', { kind: 'box', box: { material: 'red' } }],
    ['material unknown field', { kind: 'box', box: { material: { opacity: 0.5 } } }],
    ['color non-string', { kind: 'box', box: { material: { color: 12 } } }],
  ])('box %s', (_label, args) => {
    const e = err(req('createEntity', args as Record<string, unknown>));
    expect(e.code).toBe(
      ['box non-object', 'size non-array', 'material non-object', 'color non-string'].includes(_label)
        ? 'field_type'
        : 'field_unexpected',
    );
    expect(String(e.path)).toMatch(/^\/args\/box(\/[\w-]+(\/[\w-]+)?)?$/);
  });
});

describe('args-level strictness (field_*) — setTransform / deleteEntity / undo / redo', () => {
  it.each([
    ['missing entityId', { transform: { position: [1, 0, 0] } }, 'field_missing', '/args/entityId'],
    ['non-string entityId', { entityId: 5, transform: { position: [1, 0, 0] } }, 'field_type', '/args/entityId'],
    ['missing transform', { entityId: 'cam-main' }, 'field_missing', '/args/transform'],
    ['transform non-object', { entityId: 'cam-main', transform: 9 }, 'field_type', '/args/transform'],
    ['transform empty', { entityId: 'cam-main', transform: {} }, 'field_value', '/args/transform'],
    ['unknown args field', { entityId: 'cam-main', transform: { position: [1, 0, 0] }, extra: 1 }, 'field_unexpected', '/args/extra'],
  ])('setTransform %s', (_label, args, code, path) => {
    const e = err(req('setTransform', args as Record<string, unknown>));
    expect(e.code).toBe(code);
    expect(e.path).toBe(path);
  });

  it.each([
    ['missing entityId', {}, 'field_missing'],
    ['non-string entityId', { entityId: true }, 'field_type'],
    ['unknown args field', { entityId: 'cam-main', subtree: true }, 'field_unexpected'],
  ])('deleteEntity %s', (_label, args, code) => {
    const e = err(req('deleteEntity', args as Record<string, unknown>));
    expect(e.code).toBe(code);
  });

  it.each([
    ['undo', { force: true }],
    ['redo', { include: 'all' }],
  ])('%s with non-empty args ⇒ field_unexpected (%s takes no arguments)', (op, args) => {
    const e = err(req(op, args as Record<string, unknown>));
    expect(e.code).toBe('field_unexpected');
    expect(e.path).toBe(`/args/${op === 'undo' ? 'force' : 'include'}`);
    expect(e.expected).toBe('known fields: (none)');
  });
});

describe('failure payload echo rules (§5.2)', () => {
  it('echoes op (capped at 32 chars), projectId, requestId (capped at 64) when parseable', () => {
    const longOp = 'x'.repeat(40);
    const longRid = `req-${'a'.repeat(70)}`;
    const r = applyMutation(ST, {
      op: longOp,
      projectId: 'demo-0001',
      expectedRevision: 0,
      requestId: longRid,
      args: VALID_ARGS,
    });
    if (r.ok) throw new Error('should have failed');
    const f = r.result;
    expect(f.ok).toBe(false);
    expect(f.op).toBe('x'.repeat(32));
    expect(f.projectId).toBe('demo-0001');
    expect(f.requestId).toBe('req-' + 'a'.repeat(60)); // capped at 64 chars total
  });

  it('omits non-string echoes (op numeric ⇒ no op key)', () => {
    const r = applyMutation(ST, {
      op: 42,
      projectId: 'demo-0001',
      expectedRevision: 0,
      requestId: 'req-' + 'a'.repeat(32),
      args: VALID_ARGS,
    });
    if (r.ok) throw new Error('should have failed');
    expect('op' in r.result).toBe(false);
    expect(r.result.projectId).toBe('demo-0001');
  });

  it('long found values are bounded (256-char truncation, model convention)', () => {
    const kind = 'K'.repeat(300);
    const r = applyMutation(ST, req('createEntity', { kind } as Record<string, unknown>));
    if (r.ok) throw new Error('should have failed');
    const found = r.result.ok === false ? r.result.error.found : undefined;
    expect(typeof found).toBe('string');
    expect(found && (found as string).length).toBeLessThan(300);
    expect(found && (found as string).endsWith('(truncated, 300 chars total)')).toBe(true);
  });
});

// ---- O1 + O2 (2026-09-18 repair, inherited from packet 06) ---------------------
//
// O1: the diagnostic `found` mapper's recursion over nested values was
// unbounded (errors.ts:82–89), so a JSON-parsed 12,000-level nested array
// as `found` threw RangeError (stack overflow) out of the public
// `applyMutation` — violating the contract's total claim (commands.md §6.1
// / §3: validation is total, never throws). Pre-fix RED: RangeError escapes
// the public call.
//
// O2: dynamic unknown keys were interpolated into the `path` (a JSON
// Pointer into the request, commands.md §3) without RFC 6901 escaping, so
// a key `a/b` reported `/args/a/b` instead of `/args/a~1b`. Pre-fix RED:
// the unescaped pointer shape.

/** Fresh, never-mutated state (the O1/O2 requests all fail validation). */
const ST_O = createCommandState(scene(0, [cameraEntity()]));

/** Apply a malformed request to ST_O; return the structured error. */
function errO(request: unknown): CommandError {
  const r = applyMutation(ST_O, request);
  if (r.ok) throw new Error('malformed request should not succeed');
  return r.result.ok === false ? r.result.error : ({} as never);
}

/**
 * Parse an RFC 6901 pointer; throws on a malformed or truncated pointer
 * (missing leading slash, dangling `~`, invalid escape sequence).
 */
function parsePointer(p: string): string[] {
  if (p === '') return [];
  if (!p.startsWith('/')) throw new Error(`not a JSON Pointer: ${JSON.stringify(p)}`);
  return p.slice(1).split('/').map((s) => {
    if (/~(?!0|1)/.test(s)) {
      throw new Error(`invalid escape in pointer segment: ${JSON.stringify(s)}`);
    }
    return s.replace(/~1/g, '/').replace(/~0/g, '~');
  });
}

describe('O1 (2026-09-18 repair): bounded diagnostic traversal — total applyMutation', () => {
  /** The review's exact construction: a 12,000-level nested JSON array. */
  const DEEP = JSON.parse('['.repeat(12000) + '0' + ']'.repeat(12000));

  /** The bounded-`found` marker errors.ts emits where the traversal bound is hit. */
  const MARKER =
    '[truncated: exceeds bounded diagnostic traversal (depth <= 64, nodes <= 4096)]';

  it('undo args = 12,000-level nested array ⇒ structured invalid_request, no throw (RED: RangeError)', () => {
    // Pre-fix: applyMutation throws RangeError (stack overflow) at this call.
    const r = applyMutation(ST_O, req('undo', DEEP));
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.result.ok).toBe(false);
    if (r.result.ok) throw new Error('unreachable');
    const e = r.result.error;
    expect(e.code).toBe('invalid_request');
    expect(e.cls).toBe('validation');
    // `path` is a complete, valid JSON Pointer (parses; no truncated segment).
    expect(e.path).toBe('/args');
    expect(() => parsePointer(String(e.path))).not.toThrow();
    // The offending value degrades to the bounded marker — never the raw
    // 12,000-deep value, never a throw.
    expect(e.found).toBe(MARKER);
    expect(e.expected).toBe('object (op-specific, strict)');
  });

  it('delete args.entityId = 12,000-level nested array ⇒ structured field_type, no throw (RED: RangeError)', () => {
    // Pre-fix: applyMutation throws RangeError (stack overflow) at this call.
    const r = applyMutation(ST_O, req('deleteEntity', { entityId: DEEP }));
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.result.ok).toBe(false);
    if (r.result.ok) throw new Error('unreachable');
    const e = r.result.error;
    expect(e.code).toBe('field_type');
    expect(e.cls).toBe('validation');
    expect(e.path).toBe('/args/entityId');
    expect(() => parsePointer(String(e.path))).not.toThrow();
    expect(e.found).toBe(MARKER);
    expect(e.expected).toBe('string (entity ID)');
  });
});

describe('O2 (2026-09-18 repair): RFC 6901 escaping of dynamic JSON Pointer segments', () => {
  it('fresh undo args {"a/b": 1} ⇒ field_unexpected at /args/a~1b (review case; pre-fix /args/a/b)', () => {
    const e = errO(req('undo', { 'a/b': 1 }));
    expect(e.code).toBe('field_unexpected');
    expect(e.path).toBe('/args/a~1b');
    expect(e.found).toBe('a/b');
  });

  it('transform key "a~b" ⇒ segment a~0b (review case; pre-fix a~b)', () => {
    const e = errO(req('createEntity', { kind: 'box', transform: { 'a~b': [1] } }));
    expect(e.code).toBe('field_unexpected');
    expect(e.path).toBe('/args/transform/a~0b');
    expect(e.found).toBe('a~b');
  });

  it('combined key "~/x" ⇒ segment ~0~1x (both ~ and / in one key)', () => {
    const e = errO(req('deleteEntity', { entityId: 'cam-main', '~/x': 1 }));
    expect(e.code).toBe('field_unexpected');
    expect(e.path).toBe('/args/~0~1x');
    expect(e.found).toBe('~/x');
  });

  it('unknown top-level field "a/b~c" ⇒ invalid_request at /a~1b~0c (top-level case)', () => {
    const e = errO({ ...req('createEntity', VALID_ARGS), 'a/b~c': 1 });
    expect(e.code).toBe('invalid_request');
    expect(e.path).toBe('/a~1b~0c');
    expect(e.found).toBe('a/b~c');
  });

  it('origin unknown field "a/b" ⇒ invalid_request at /origin/a~1b (origin case)', () => {
    const origin = { kind: 'browser' as const, clientId: 'x', 'a/b': 1 };
    const e = errO(req('createEntity', VALID_ARGS, { origin }));
    expect(e.code).toBe('invalid_request');
    expect(e.path).toBe('/origin/a~1b');
  });

  it('box unknown field "x/y" ⇒ field_unexpected at /args/box/x~1y (box case)', () => {
    const e = errO(req('createEntity', { kind: 'box', box: { 'x/y': 1 } }));
    expect(e.code).toBe('field_unexpected');
    expect(e.path).toBe('/args/box/x~1y');
  });

  it('material unknown field "a/b" ⇒ field_unexpected at /args/box/material/a~1b (material case)', () => {
    const e = errO(req('createEntity', { kind: 'box', box: { material: { 'a/b': 1 } } }));
    expect(e.code).toBe('field_unexpected');
    expect(e.path).toBe('/args/box/material/a~1b');
  });

  it('setTransform unknown args field "a/b" ⇒ field_unexpected at /args/a~1b', () => {
    const e = errO(
      req('setTransform', { entityId: 'cam-main', transform: { position: [1, 0, 0] }, 'a/b': 1 }),
    );
    expect(e.code).toBe('field_unexpected');
    expect(e.path).toBe('/args/a~1b');
  });

  it('every O2-emitted path parses as a valid RFC 6901 pointer (complete segments)', () => {
    const cases: unknown[] = [
      req('undo', { 'a/b': 1 }),
      req('createEntity', { kind: 'box', transform: { 'a~b': [1] } }),
      req('deleteEntity', { entityId: 'cam-main', '~/x': 1 }),
      { ...req('createEntity', VALID_ARGS), 'a/b~c': 1 },
      req('createEntity', { kind: 'box', box: { 'x/y': 1 } }),
      req('createEntity', { kind: 'box', box: { material: { 'a/b': 1 } } }),
      req('setTransform', { entityId: 'cam-main', transform: { position: [1, 0, 0] }, 'a/b': 1 }),
    ];
    for (const c of cases) {
      const e = errO(c);
      expect(() => parsePointer(String(e.path)), `path ${JSON.stringify(e.path)}`).not.toThrow();
    }
  });
});
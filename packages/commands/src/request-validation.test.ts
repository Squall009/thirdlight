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
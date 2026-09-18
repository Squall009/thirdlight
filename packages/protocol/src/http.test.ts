/**
 * HTTP payload validators (sessions.md §5.1/§6/§10.1/§12).
 */
import { describe, expect, it } from 'vitest';
import {
  parseAdminCreateProjectRequest,
  parseAdminNoArgsBody,
  parseCommandEnvelope,
  parseEstablishRequest,
  parsePlayStartRequest,
  parseScreenshotRequest,
} from './http';

const hex32 = '0123456789abcdef0123456789abcdef';
const est = { projectId: 'demo-0001', sessionId: `sess-${hex32}` };

describe('parseEstablishRequest (sessions.md §5.1)', () => {
  it('accepts the minimal request', () => {
    const r = parseEstablishRequest(est);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.request.clientInfo).toBeUndefined();
  });

  it('accepts a browser clientInfo with label', () => {
    const r = parseEstablishRequest({ ...est, clientInfo: { kind: 'browser', label: 'desktop-chrome' } });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.request.clientInfo).toEqual({ kind: 'browser', label: 'desktop-chrome' });
  });

  it('unknown top-level field ⇒ field_unexpected', () => {
    const r = parseEstablishRequest({ ...est, extra: 1 });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('field_unexpected');
      expect(r.error.path).toBe('/extra');
    }
  });

  it('missing sessionId ⇒ field_missing', () => {
    const r = parseEstablishRequest({ projectId: 'demo-0001' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('field_missing');
  });

  it('bad sessionId syntax ⇒ field_value', () => {
    const r = parseEstablishRequest({ projectId: 'demo-0001', sessionId: 'sess-short' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('field_value');
  });

  it('bad projectId syntax ⇒ field_value', () => {
    const r = parseEstablishRequest({ projectId: 'UPPER', sessionId: `sess-${hex32}` });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('field_value');
  });

  it('clientInfo.kind other than "browser" ⇒ field_value (M1)', () => {
    const r = parseEstablishRequest({ ...est, clientInfo: { kind: 'mcp' } });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('field_value');
      expect(r.error.path).toBe('/clientInfo/kind');
    }
  });

  it('clientInfo with control chars in label ⇒ rejected', () => {
    const r = parseEstablishRequest({ ...est, clientInfo: { kind: 'browser', label: 'a\nb' } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.path).toBe('/clientInfo/label');
  });

  it('clientInfo unknown field ⇒ field_unexpected', () => {
    const r = parseEstablishRequest({ ...est, clientInfo: { kind: 'browser', token: 'x' } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.path).toBe('/clientInfo/token');
  });

  it('non-object ⇒ field_type', () => {
    const r = parseEstablishRequest('nope');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('field_type');
  });
});

describe('parsePlayStartRequest (sessions.md §10.1)', () => {
  it('absent body ⇒ demo defaults to true', () => {
    const r = parsePlayStartRequest(undefined);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.request.demo).toBe(true);
  });

  it('explicit demo:false honored', () => {
    const r = parsePlayStartRequest({ options: { demo: false } });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.request.demo).toBe(false);
  });

  it('unknown options field ⇒ field_unexpected', () => {
    const r = parsePlayStartRequest({ options: { physics: true } });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('field_unexpected');
      expect(r.error.path).toBe('/options/physics');
    }
  });

  it('non-boolean demo ⇒ field_type', () => {
    const r = parsePlayStartRequest({ options: { demo: 'yes' } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('field_type');
  });
});

describe('parseScreenshotRequest (sessions.md §12/§11.5)', () => {
  it('defaults to 1024', () => {
    const r = parseScreenshotRequest({});
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.request.maxWidth).toBe(1024);
  });
  it('accepts 256 and 2048', () => {
    expect(parseScreenshotRequest({ maxWidth: 256 }).ok).toBe(true);
    expect(parseScreenshotRequest({ maxWidth: 2048 }).ok).toBe(true);
  });
  it('rejects below/above the bounds and non-integers', () => {
    for (const bad of [0, 255, 2049, 512.5, '512']) {
      const r = parseScreenshotRequest({ maxWidth: bad });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.path).toBe('/maxWidth');
    }
  });
  it('unknown field ⇒ field_unexpected', () => {
    const r = parseScreenshotRequest({ maxWidth: 512, quality: 0.5 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('field_unexpected');
  });
});

describe('admin bodies (sessions.md §6.3)', () => {
  it('createProject: { projectId, name } strict', () => {
    const r = parseAdminCreateProjectRequest({ projectId: 'new-proj', name: 'Demo' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.request).toEqual({ projectId: 'new-proj', name: 'Demo' });
    const bad = parseAdminCreateProjectRequest({ projectId: 'new-proj' });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error.code).toBe('field_missing');
  });
  it('no-args admin body: exactly {}', () => {
    expect(parseAdminNoArgsBody({}).ok).toBe(true);
    const r = parseAdminNoArgsBody({ x: 1 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('field_unexpected');
  });
});

describe('parseCommandEnvelope (sessions.md §6.1 pre-check)', () => {
  it('routes every M1 op', () => {
    for (const op of ['createEntity', 'setTransform', 'deleteEntity', 'undo', 'redo', 'queryProject', 'queryEntity', 'queryEntities']) {
      const r = parseCommandEnvelope({ op, projectId: 'demo-0001', args: {} });
      expect(r.ok, op).toBe(true);
      if (r.ok) expect(r.op).toBe(op);
    }
  });

  it('unknown op ⇒ invalid_request with /op path', () => {
    const r = parseCommandEnvelope({ op: 'teleport' });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('invalid_request');
      expect(r.error.path).toBe('/op');
    }
  });

  it('non-object ⇒ invalid_request', () => {
    for (const v of [null, 's', 42, [1]]) {
      const r = parseCommandEnvelope(v);
      expect(r.ok).toBe(false);
    }
  });

  it('requestId present but wrong syntax ⇒ invalid_request (pre-check)', () => {
    const r = parseCommandEnvelope({ op: 'undo', requestId: 'tb-req-bad' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.path).toBe('/requestId');
  });
});
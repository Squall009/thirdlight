/**
 * 2026-09-18 review repair — packet 07 O2 (workspace audit): RFC 6901
 * escaping of dynamic JSON Pointer segments in the workspace validators.
 *
 * The review's O2 (commands package) carries the instruction: "Coordinate
 * the same audit in workspace validators." Dynamic object keys were
 * interpolated into error `path` fields (JSON Pointers into the request or
 * the envelope) without escaping `~`/`/`, so a key `a/b` produced the
 * pointer `/args/a/b` instead of the RFC 6901-correct `/args/a~1b`
 * (commands.md §3: `path` is "a JSON Pointer into the request").
 *
 * One test per fixed site (12 reachable sites):
 *
 *   service.ts   canonicalIssue object-key walk      args `x/y`   ⇒ /args/x~1y
 *   service.ts   query envelope unknown top-level    `a/b~c`      ⇒ /a~1b~0c
 *   session.ts   queryProject args unknown key       `a/b`        ⇒ /args/a~1b
 *   session.ts   queryEntity args unknown key        `x/y`        ⇒ /args/x~1y
 *   session.ts   queryEntities args unknown key      `z/w`        ⇒ /args/z~1w
 *   envelope.ts  envelope root unknown key           `a/b`        ⇒ /a~1b
 *   envelope.ts  retry block unknown key             `x/y`        ⇒ /retry/x~1y
 *   envelope.ts  retry record unknown key            `z/w`        ⇒ /retry/records/0/z~1w
 *   envelope.ts  recorded result unknown key         `q/w`        ⇒ /result/q~1w
 *   envelope.ts  originOfApplied unknown key         `m/n`        ⇒ /result/originOfApplied/m~1n
 *   envelope.ts  recorded history unknown key        `h/i`        ⇒ /result/history/h~1i
 *   envelope.ts  fullTransformError unknown key      `t/u`        ⇒ /result/change/previous/t~1u
 *
 * (session.ts's `validateQueryEnvelope` carries the same pattern but has no
 * callers at HEAD — unreachable; its site is fixed for consistency and is
 * noted in the handoff rather than tested through the public API.)
 *
 * Pre-fix RED: each test fails on the unescaped pointer shape (e.g. the
 * detail at `/args/x/y` instead of `/args/x~1y`).
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  openWorkspaceService,
  type QueryResult,
  type WorkspaceService,
} from '@thirdlight/workspace';
import { validateEnvelope, type EnvelopeLoad } from './envelope';

// ---- disposable roots (mkdtemp data roots; cleaned up in finally) ----------

const roots: string[] = [];

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'tl07-o-'));
  roots.push(root);
  return root;
}

function dropRoot(root: string): void {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    // best effort — the afterAll backstop retries
  }
}

afterAll(() => {
  for (const r of roots.splice(0)) dropRoot(r);
});

// ---- helpers -----------------------------------------------------------------

/** Pinned backend identity (the durable records are format-checked). */
const BACKEND_ID = 'tb-0102030405060708090a010203040506';

let seq = 0;
function nextRequestId(): string {
  seq += 1;
  return `req-${seq.toString(16).padStart(32, '0')}`;
}

describe('O2 workspace audit — request-level sites (public service API)', () => {
  let service: WorkspaceService;

  beforeEach(() => {
    const root = makeRoot();
    service = openWorkspaceService({ root, backendId: BACKEND_ID });
    expect(service.createProject('p000', 'P000').ok).toBe(true);
  });

  afterEach(() => {
    service.dispose();
  });

  it('service.ts canonicalIssue: non-canonical value under args key "x/y" ⇒ invalid_request at /args/x~1y', () => {
    const r = service.runCommand({
      op: 'createEntity',
      projectId: 'p000',
      expectedRevision: 0,
      requestId: nextRequestId(),
      args: { kind: 'box', 'x/y': new Date() },
    });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.error.code).toBe('invalid_request');
    expect(r.error.path).toBe('/args/x~1y');
  });

  it('service.ts query envelope: unknown top-level key "a/b~c" ⇒ invalid_request at /a~1b~0c', () => {
    const q = service.query({
      op: 'queryProject',
      projectId: 'p000',
      'a/b~c': 1,
    }) as QueryResult;
    expect(q.ok).toBe(false);
    if (q.ok) throw new Error('unreachable');
    expect(q.error.code).toBe('invalid_request');
    expect(q.error.path).toBe('/a~1b~0c');
  });

  it('session.ts queryProject args: unknown key "a/b" ⇒ field_unexpected at /args/a~1b', () => {
    const q = service.query({
      op: 'queryProject',
      projectId: 'p000',
      args: { 'a/b': 1 },
    }) as QueryResult;
    expect(q.ok).toBe(false);
    if (q.ok) throw new Error('unreachable');
    expect(q.error.code).toBe('field_unexpected');
    expect(q.error.path).toBe('/args/a~1b');
  });

  it('session.ts queryEntity args: unknown key "x/y" ⇒ field_unexpected at /args/x~1y', () => {
    const q = service.query({
      op: 'queryEntity',
      projectId: 'p000',
      args: { 'x/y': 1 },
    }) as QueryResult;
    expect(q.ok).toBe(false);
    if (q.ok) throw new Error('unreachable');
    expect(q.error.code).toBe('field_unexpected');
    expect(q.error.path).toBe('/args/x~1y');
  });

  it('session.ts queryEntities args: unknown key "z/w" ⇒ field_unexpected at /args/z~1w', () => {
    const q = service.query({
      op: 'queryEntities',
      projectId: 'p000',
      args: { 'z/w': 1 },
    }) as QueryResult;
    expect(q.ok).toBe(false);
    if (q.ok) throw new Error('unreachable');
    expect(q.error.code).toBe('field_unexpected');
    expect(q.error.path).toBe('/args/z~1w');
  });
});

describe('O2 workspace audit — envelope-level sites (validateEnvelope)', () => {
  const RID = `req-${'a'.repeat(32)}`;
  const RID2 = `req-${'b'.repeat(32)}`;
  const DIGEST = `c`.repeat(64);

  /** A minimal valid M1 scene: exactly one camera (project-model §10.3). */
  const BASE_SCENE = {
    schemaVersion: 1,
    sceneId: 'scene-main',
    revision: 0,
    entities: [
      {
        id: 'cam-main',
        components: {
          transform: { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
          camera: { type: 'perspective', fovY: 60, near: 0.1, far: 100 },
        },
      },
    ],
  };

  /** A valid envelope document (fresh JSON copy) with one injected mutation. */
  function envelopeBytes(mutate: (doc: Record<string, unknown>) => void): Uint8Array {
    const doc: Record<string, unknown> = {
      storageVersion: 1,
      type: 'authoring-state',
      projectId: 'p000',
      scene: JSON.parse(JSON.stringify(BASE_SCENE)),
      retry: { retention: 128, records: [] },
    };
    mutate(doc);
    return new TextEncoder().encode(JSON.stringify(doc));
  }

  /** Assert a failed load with the given reason and a detail at the exact (escaped) path. */
  function expectDetail(res: EnvelopeLoad, reason: string, path: string): void {
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('envelope load should have failed');
    expect(res.reason).toBe(reason);
    const d = res.errors.find((x) => x.path === path);
    expect(d, `expected a detail at ${path}; got: ${JSON.stringify(res.errors)}`).toBeDefined();
  }

  /** A valid setTransform change (§5.3). */
  function stChange(): Record<string, unknown> {
    return {
      type: 'setTransform',
      id: 'cam-main',
      previous: { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
      next: { position: [1, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
      changedFields: ['position'],
    };
  }

  /** A valid setTransform result (§5.1 key set) with optional extra fields. */
  function stResult(extra: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      ok: true,
      op: 'setTransform',
      projectId: 'p000',
      requestId: RID,
      revision: 0,
      duplicated: false,
      change: stChange(),
      history: { undoDepth: 1, redoDepth: 0 },
      ...extra,
    };
  }

  /** A valid retry record around the given result (appliedRevision 0 ≤ scene.revision 0). */
  function record(result: Record<string, unknown>): Record<string, unknown> {
    return { requestId: RID, digest: DIGEST, appliedRevision: 0, result };
  }

  it('envelope.ts root: unknown key "a/b" ⇒ field_unexpected at /a~1b', () => {
    const res = validateEnvelope(envelopeBytes((doc) => { doc['a/b'] = 1; }), 'p000');
    expectDetail(res, 'envelope_invalid', '/a~1b');
  });

  it('envelope.ts retry block: unknown key "x/y" ⇒ at /retry/x~1y', () => {
    const res = validateEnvelope(
      envelopeBytes((doc) => {
        doc.retry = { retention: 128, records: [], 'x/y': 1 };
      }),
      'p000',
    );
    expectDetail(res, 'retry_records_invalid', '/retry/x~1y');
  });

  it('envelope.ts retry record: unknown key "z/w" ⇒ at /retry/records/0/z~1w', () => {
    const res = validateEnvelope(
      envelopeBytes((doc) => {
        doc.retry = { retention: 128, records: [{ 'z/w': 1 }] };
      }),
      'p000',
    );
    expectDetail(res, 'retry_records_invalid', '/retry/records/0/z~1w');
  });

  it('envelope.ts recorded result: unknown key "q/w" ⇒ at /result/q~1w', () => {
    const res = validateEnvelope(
      envelopeBytes((doc) => {
        doc.retry = { retention: 128, records: [record(stResult({ 'q/w': 1 }))] };
      }),
      'p000',
    );
    expectDetail(res, 'retry_records_invalid', '/result/q~1w');
  });

  it('envelope.ts originOfApplied: unknown key "m/n" ⇒ at /result/originOfApplied/m~1n', () => {
    const result: Record<string, unknown> = {
      ok: true,
      op: 'undo',
      projectId: 'p000',
      requestId: RID,
      revision: 0,
      duplicated: false,
      change: { type: 'deleteEntity', rootId: 'cam-main', deletedIds: ['box-0001'] },
      history: { undoDepth: 0, redoDepth: 1 },
      appliedOf: RID2,
      originOfApplied: { kind: 'browser', clientId: 'x', 'm/n': 1 },
    };
    const res = validateEnvelope(
      envelopeBytes((doc) => {
        doc.retry = { retention: 128, records: [record(result)] };
      }),
      'p000',
    );
    expectDetail(res, 'retry_records_invalid', '/result/originOfApplied/m~1n');
  });

  it('envelope.ts recorded history: unknown key "h/i" ⇒ at /result/history/h~1i', () => {
    const result: Record<string, unknown> = {
      ok: true,
      op: 'setTransform',
      projectId: 'p000',
      requestId: RID,
      revision: 0,
      duplicated: false,
      change: stChange(),
      history: { undoDepth: 1, redoDepth: 0, 'h/i': 1 },
    };
    const res = validateEnvelope(
      envelopeBytes((doc) => {
        doc.retry = { retention: 128, records: [record(result)] };
      }),
      'p000',
    );
    expectDetail(res, 'retry_records_invalid', '/result/history/h~1i');
  });

  it('envelope.ts fullTransformError: unknown transform key "t/u" ⇒ at /result/change/previous/t~1u', () => {
    const change = stChange();
    (change.previous as Record<string, unknown>)['t/u'] = 1;
    const res = validateEnvelope(
      envelopeBytes((doc) => {
        doc.retry = { retention: 128, records: [record(stResult({ change }))] };
      }),
      'p000',
    );
    expectDetail(res, 'retry_records_invalid', '/result/change/previous/t~1u');
  });
});
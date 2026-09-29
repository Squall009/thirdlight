/**
 * Publishing a script whose output links a script library: the library's
 * digest is named only by the command's refusal, and is asked for or
 * acknowledged like the script's own digest.
 */
import { describe, expect, it } from 'vitest';

import type { MutationResponse } from './envelope';
import { publishScriptSource, type ScriptPublishClient } from './script-publish';

const SOURCE = 'a'.repeat(64);
const LIBRARY = 'b'.repeat(64);
const BEHAVIOR = { behaviorId: 'keeper', displayName: 'Keeper', declaration: { properties: [] } };

/** A backend that refuses a publish while the source or the linked library digest is unacknowledged. */
function fakeClient(acknowledged: string[]): ScriptPublishClient & { acks: string[]; publishes: number } {
  let revision = 10;
  const trust = new Set(acknowledged);
  const refuse = (digest: string): { ok: false; response: MutationResponse } => ({ ok: false, response: { ok: false, code: 'behavior_trust_unacknowledged', message: 'no acknowledgment', sourceDigest: digest } });
  const c = {
    acks: [] as string[],
    publishes: 0,
    get projection() {
      return { revision };
    },
    stageBehaviorSource: async (bytes: Uint8Array) => ({ ok: true as const, stageId: 'stage-1', digest: SOURCE, byteLength: bytes.length }),
    acknowledgedDigests: () => [...trust],
    acknowledgeBehaviorTrust: async (digest: string, expected: number) => {
      expect(expected).toBe(revision);
      trust.add(digest);
      c.acks.push(digest);
      revision += 1;
      return { ok: true as const, revision };
    },
    publishBehaviorSource: async (_args: unknown, expected: number) => {
      expect(expected).toBe(revision);
      c.publishes += 1;
      if (!trust.has(SOURCE)) return refuse(SOURCE);
      if (!trust.has(LIBRARY)) return refuse(LIBRARY);
      revision += 1;
      return { ok: true as const, revision };
    },
  };
  return c;
}

describe('publishing a script that links a library', () => {
  it('asks for the source digest first, then acknowledges the source and the library in one go', async () => {
    const c = fakeClient([]);
    const seen: string[] = [];
    expect(await publishScriptSource(c, BEHAVIOR, new Uint8Array(4), false, (d) => seen.push(d))).toEqual({ kind: 'needs-ack', digest: SOURCE });
    expect(c.publishes).toBe(0);
    const out = await publishScriptSource(c, BEHAVIOR, new Uint8Array(4), true, (d) => seen.push(d));
    expect(out).toEqual({ kind: 'published', revision: 13, digest: SOURCE });
    expect(c.acks).toEqual([SOURCE, LIBRARY]);
    expect(seen).toEqual([SOURCE, LIBRARY]);
  });

  it('asks for the library digest the refusal names when the source is already acknowledged', async () => {
    const c = fakeClient([SOURCE]);
    expect(await publishScriptSource(c, BEHAVIOR, new Uint8Array(4), false, () => undefined)).toEqual({ kind: 'needs-ack', digest: LIBRARY });
    expect(c.acks).toEqual([]);
    expect((await publishScriptSource(c, BEHAVIOR, new Uint8Array(4), true, () => undefined)).kind).toBe('published');
    expect(c.acks).toEqual([LIBRARY]);
  });

  it('stops when a digest it acknowledged is refused again', async () => {
    const c = fakeClient([SOURCE]);
    c.publishBehaviorSource = async () => ({ ok: false, response: { ok: false, code: 'behavior_trust_unacknowledged', message: 'no acknowledgment', sourceDigest: LIBRARY } });
    expect((await publishScriptSource(c, BEHAVIOR, new Uint8Array(4), true, () => undefined)).kind).toBe('failed');
    expect(c.acks).toEqual([LIBRARY]);
  });

  it('passes any other refusal through', async () => {
    const c = fakeClient([SOURCE, LIBRARY]);
    c.publishBehaviorSource = async () => ({ ok: false, response: { ok: false, code: 'compile_failed', message: 'src/index.ts:3 no' } });
    expect(await publishScriptSource(c, BEHAVIOR, new Uint8Array(4), true, () => undefined)).toEqual({ kind: 'failed', message: 'compile_failed: src/index.ts:3 no' });
  });
});

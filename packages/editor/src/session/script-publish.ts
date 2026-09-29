/**
 * Publishing a script's source from its Script tab: stage the container, get
 * every digest the published output runs acknowledged, then the ordinary
 * source route (compile + one `publishBehavior` command).
 *
 * The output runs the script's own source and every script library it links,
 * and the command refuses any of those digests that has no trust
 * acknowledgment. The script's digest is known before publishing; a linked
 * library's is only named by the refusal (a library saved while no script
 * imported it was never acknowledged). So a refusal naming a digest is asked
 * for (`needs-ack`) or, once the user has acknowledged, recorded and the
 * publish retried — otherwise a script importing a new library could not be
 * published from the editor at all.
 *
 * Browser-safe (no DOM): the client is passed in.
 */
import type { PropertyDeclaration } from '@thirdlight/project-model';

import type { MutationResponse } from './envelope';

export type ScriptPublishOutcome =
  | { kind: 'published'; revision: number; digest: string }
  | { kind: 'needs-ack'; digest: string }
  | { kind: 'failed'; message: string };

/** The session client's part this flow uses. */
export interface ScriptPublishClient {
  readonly projection: { readonly revision: number };
  stageBehaviorSource(bytes: Uint8Array): Promise<{ ok: true; stageId: string; digest: string; byteLength: number } | { ok: false; error: { code: string; message: string } }>;
  acknowledgedDigests(): readonly string[];
  acknowledgeBehaviorTrust(sourceDigest: string, expectedRevision: number): Promise<{ ok: true; revision: number } | { ok: false; response: MutationResponse }>;
  publishBehaviorSource(
    args: { behaviorId: string; displayName: string; declaration: PropertyDeclaration; sourceDigest: string; sourceByteLength: number; stageId?: string },
    expectedRevision: number,
  ): Promise<{ ok: true; revision: number } | { ok: false; response: MutationResponse }>;
}

export async function publishScriptSource(
  c: ScriptPublishClient,
  behavior: { behaviorId: string; displayName: string; declaration: PropertyDeclaration },
  bytes: Uint8Array,
  acknowledge: boolean,
  onAcknowledged: (digest: string, revision: number) => void,
): Promise<ScriptPublishOutcome> {
  const staged = await c.stageBehaviorSource(bytes);
  if (!staged.ok) return { kind: 'failed', message: `${staged.error.code}: ${staged.error.message}` };
  let revision = c.projection.revision;
  const ack = async (digest: string): Promise<ScriptPublishOutcome | null> => {
    const r = await c.acknowledgeBehaviorTrust(digest, revision);
    if (!r.ok) {
      const e = r.response;
      return { kind: 'failed', message: e.ok ? 'the acknowledgment was not recorded' : `${e.code}: ${e.message ?? e.code}` };
    }
    revision = r.revision;
    onAcknowledged(digest, r.revision);
    return null;
  };
  // Each refusal names a digest not acknowledged yet; one named again after this
  // call acknowledged it means the acknowledgment does not take, so stop there.
  const done = new Set<string>();
  if (!c.acknowledgedDigests().includes(staged.digest)) {
    if (!acknowledge) return { kind: 'needs-ack', digest: staged.digest };
    const failed = await ack(staged.digest);
    if (failed !== null) return failed;
    done.add(staged.digest);
  }
  for (;;) {
    const res = await c.publishBehaviorSource(
      { behaviorId: behavior.behaviorId, displayName: behavior.displayName, declaration: behavior.declaration, sourceDigest: staged.digest, sourceByteLength: staged.byteLength, stageId: staged.stageId },
      revision,
    );
    if (res.ok) return { kind: 'published', revision: res.revision, digest: staged.digest };
    const r = res.response;
    if (r.ok) return { kind: 'failed', message: 'the source was not published' };
    if (r.code !== 'behavior_trust_unacknowledged' || r.sourceDigest === undefined) return { kind: 'failed', message: `${r.code}: ${r.message ?? r.code}` };
    if (!acknowledge) return { kind: 'needs-ack', digest: r.sourceDigest };
    if (done.has(r.sourceDigest)) return { kind: 'failed', message: `${r.code}: ${r.message ?? r.code}` };
    done.add(r.sourceDigest);
    const failed = await ack(r.sourceDigest);
    if (failed !== null) return failed;
  }
}

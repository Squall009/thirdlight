/**
 * Packet 53 — real-loader `setRoles` evidence over the committed media
 * fixtures (`tests/m3-animation/**`): the real `three@0.186.0` GLTFLoader
 * port loads the REAL `fixtures/m3/media/glb/courier-roles.glb` /
 * `courier-reordered.glb` bytes, and the role controller re-checks the
 * REAL-ROLES `modelAnimation` components from the committed
 * `fixtures/m3/media/roles/roles-cases.json` (packet 53, CC-47-1 / Gate L P3
 * — the real `AnimationRoleBinding` values the runtime loads) against the
 * LOADED clips (presentation.md §41.3.6 rule 7 / §41.3.2 stages 3, 5–6).
 *
 * The committed rows are the evidence input (frozen by the media checker's
 * digest + re-derivation); this test proves the adapter's setRoles path
 * accepts exactly the accepted rows and refuses exactly the rejected one —
 * the reorder-with-new-mapping case (§41.3.4 rule 5) and the stale-mapping
 * refusal (§41.3.4 rule 1/6: a reimport never silently keeps the old
 * mapping) included.
 *
 * Runs in Node (the repo-root test tree may use Node built-ins; the
 * `packages/**` code it drives does not).
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  createAnimationRoleController,
  prepareVisualResource,
  suppliedBytes,
  type AnimationRolesInput,
  type PreparedVisualResource,
  type VisualResourceHandle,
} from '@thirdlight/three-adapter';
import { createGltfLoaderPort } from '@thirdlight/three-adapter/gltf-loader';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const FIXTURES = join(REPO_ROOT, 'fixtures', 'm3', 'media');

interface RolesCase {
  id: string;
  file: string;
  component: { assetId: string; version: number; roles: AnimationRolesInput };
  expect: { verdict: 'accepted' | 'rejected'; code?: string };
}

const rolesCases: { cases: RolesCase[] } = JSON.parse(
  readFileSync(join(FIXTURES, 'roles', 'roles-cases.json'), 'utf8'),
) as { cases: RolesCase[] };

function glb(rel: string): Uint8Array {
  return new Uint8Array(readFileSync(join(FIXTURES, rel)));
}

/** Load one committed GLB through the REAL loader port (digest-pinned descriptor). */
async function prepare(rel: string, digest: string, version: number): Promise<{ resource: PreparedVisualResource; handle: VisualResourceHandle }> {
  const bytes = glb(rel);
  const handle = prepareVisualResource(
    suppliedBytes(
      { assetId: 'asset-model-courier', version, sourceDigest: digest, sourceByteLength: bytes.byteLength },
      bytes,
    ),
    { loader: createGltfLoaderPort() },
  );
  const result = await handle.result;
  if (!result.ok) throw new Error(`expected a ready resource, got ${result.error.code}: ${result.error.message}`);
  return { resource: result.resource, handle };
}

const DIGESTS: Record<string, { sha256: string }> = (JSON.parse(
  readFileSync(join(FIXTURES, 'index.json'), 'utf8'),
) as { files: Record<string, { sha256: string }> }).files;

describe('packet 53 — setRoles over the real courier GLBs (committed real-roles rows)', () => {
  const byId = new Map(rolesCases.cases.map((c) => [c.id, c]));

  it('the committed rows cover the three evidence cases', () => {
    expect(rolesCases.cases.map((c) => c.id)).toEqual([
      'roles-stored-order-v1',
      'roles-reordered-v2',
      'roles-stored-order-against-reordered-bytes',
    ]);
  });

  it('the stored-order v1 mapping installs and drives the roles', async () => {
    const c = byId.get('roles-stored-order-v1')!;
    const { resource } = await prepare(`glb/${c.file}`, DIGESTS[`glb/${c.file}`]!.sha256, c.component.version);
    expect(resource.clips.map((k) => k.name)).toEqual(['Idle', 'Run', 'Airborne']);
    const made = resource.createInstance();
    expect(made.ok).toBe(true);
    if (!made.ok) throw new Error('unreachable');
    const motion = { speed: 0, grounded: true };
    let step = 0;
    const controller = createAnimationRoleController(made.instance, () => ({ stepIndex: step, playerMotion: motion }));
    expect(controller.ok).toBe(true);
    if (!controller.ok) throw new Error('unreachable');
    const set = controller.controller.setRoles(c.component.roles, c.component.version);
    expect(set).toEqual({ ok: true });
    const r = controller.controller.update(0.016);
    expect(r).toEqual({ ok: true });
    expect(controller.controller.state().role).toBe('idle');
    motion.speed = 1.5;
    for (let i = 0; i < 14; i += 1) expect(controller.controller.update(0.016)).toEqual({ ok: true });
    const st = controller.controller.state();
    expect(st.role).toBe('run');
    expect(st.weights.run).toBeGreaterThan(1 - 1e-6);
    expect(st.blending).toBe(false);
    resource.dispose();
  });

  it('the reordered-v2 mapping installs against the reordered bytes (§41.3.4 rule 5)', async () => {
    const c = byId.get('roles-reordered-v2')!;
    const { resource } = await prepare(`glb/${c.file}`, DIGESTS[`glb/${c.file}`]!.sha256, c.component.version);
    // The bytes are the reordered ones: clip 0 is 'Airborne'.
    expect(resource.clips.map((k) => k.name)).toEqual(['Airborne', 'Run', 'Idle']);
    const made = resource.createInstance();
    expect(made.ok).toBe(true);
    if (!made.ok) throw new Error('unreachable');
    const motion = { speed: 0, grounded: true };
    const controller = createAnimationRoleController(made.instance, () => ({ stepIndex: 0, playerMotion: motion }));
    expect(controller.ok).toBe(true);
    if (!controller.ok) throw new Error('unreachable');
    const set = controller.controller.setRoles(c.component.roles, c.component.version);
    expect(set).toEqual({ ok: true });
    expect(controller.controller.update(0.016)).toEqual({ ok: true });
    expect(controller.controller.state().role).toBe('idle');
    motion.grounded = false;
    for (let i = 0; i < 14; i += 1) expect(controller.controller.update(0.016)).toEqual({ ok: true });
    const st = controller.controller.state();
    expect(st.role).toBe('airborne');
    expect(st.weights.airborne).toBeGreaterThan(1 - 1e-6);
    resource.dispose();
  });

  it('the stale stored-order mapping against the reordered bytes is refused (§41.3.4 rule 1/6)', async () => {
    const c = byId.get('roles-stored-order-against-reordered-bytes')!;
    expect(c.expect).toEqual({ verdict: 'rejected', code: 'animation_role_mismatch' });
    const { resource } = await prepare(`glb/${c.file}`, DIGESTS[`glb/${c.file}`]!.sha256, c.component.version);
    const made = resource.createInstance();
    expect(made.ok).toBe(true);
    if (!made.ok) throw new Error('unreachable');
    const motion = { speed: 0, grounded: true };
    const controller = createAnimationRoleController(made.instance, () => ({ stepIndex: 0, playerMotion: motion }));
    expect(controller.ok).toBe(true);
    if (!controller.ok) throw new Error('unreachable');
    const set = controller.controller.setRoles(c.component.roles, c.component.version);
    expect(set.ok).toBe(false);
    if (set.ok) throw new Error('unreachable');
    // The adapter's closed code (§41.7.2 D); the stage-5 mismatch detail is
    // bounded in the message (clip 0 is 'Airborne', the mapping claims 'Idle').
    expect(set.error.code).toBe('animation_role_unresolved');
    expect(set.error.message).toContain("clipName 'Idle'");
    // Rule 7: the refusal is hard — nothing is installed, the host renders
    // statically (update succeeds with no mixer activity; weights stay 0).
    expect(controller.controller.update(0.016)).toEqual({ ok: true });
    expect(controller.controller.state().weights).toEqual({ idle: 0, run: 0, airborne: 0 });
    resource.dispose();
  });
});
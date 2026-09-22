#!/usr/bin/env node
/**
 * Packet 14 — cold-init sample (ONE fresh Node process per invocation).
 * Times: ESM import -> RAPIER.init() -> world build + first fixed step.
 *
 * Standalone by design (plan-review BR-1): NOT typechecked/boundary-checked by
 * the repo toolchain; imports the candidate from the DISPOSABLE prefix
 * (env EVAL_PREFIX, default /tmp/tl-m2-eval-14), never the repo lockfile.
 *
 * Usage: node coldinit-sample.mjs   (print once; the caller runs N fresh
 * processes and stores the lines, e.g. in 07-coldinit.json)
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

const here = dirname(fileURLToPath(import.meta.url));
void here;
const PREFIX = process.env.EVAL_PREFIX ?? '/tmp/tl-m2-eval-14';

const t0 = process.hrtime.bigint();
// ESM entry (dist/rapier.mjs) — the same entry the IIFE bundle uses.
const RAPIER = (await import(join(PREFIX, 'rapier2d-compat/node_modules/@dimforge/rapier2d-compat/dist/rapier.mjs'))).default;
const t1 = process.hrtime.bigint();
await RAPIER.init();
const t2 = process.hrtime.bigint();
const world = new RAPIER.World({ x: 0, y: -19.62 });
world.timestep = 1 / 120;
const floorBody = world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(0, -0.25));
world.createCollider(RAPIER.ColliderDesc.cuboid(10, 0.25), floorBody);
const cc = world.createCharacterController(0.01);
const charCollider = world.createCollider(RAPIER.ColliderDesc.capsule(0.6, 0.3).setTranslation(0, 0.91)); // parentless (documented pattern)
cc.computeColliderMovement(charCollider, { x: 0.0333, y: 0 });
const m = cc.computedMovement();
const t = charCollider.translation();
charCollider.setTranslation({ x: t.x + m.x, y: t.y + m.y });
world.step();
const t3 = process.hrtime.bigint();

const ms = (a, b) => Number(((Number(b) - Number(a)) / 1e6).toFixed(3));
console.log(
  JSON.stringify({
    node: process.version,
    entry: 'dist/rapier.mjs (ESM, same as the IIFE bundle)',
    importMs: ms(t0, t1),
    initMs: ms(t1, t2),
    worldBuildPlusFirstStepMs: ms(t2, t3),
    totalMs: ms(t0, t3),
    note: 'container (NOT the reference desktop — directional only, plan-review BR-2); single-threaded Node, no GPU',
  }),
);
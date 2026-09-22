/**
 * Packet 14 — strict-TS + IIFE-bundle probe for @dimforge/rapier2d-compat@0.20.0.
 *
 * Standalone by design (plan-review BR-1): NOT typechecked/boundary-checked by the
 * repo toolchain (it imports the candidate, which is not in the repo lockfile).
 * Two evaluation runs over this file:
 *   1. `tsc --noEmit` with the repo's pinned TypeScript 5.9.3 and the repo's
 *      tsconfig.base.json (strict) — proves the candidate's .d.ts work under
 *      Thirdlight's strict settings (see run-eval.mjs).
 *   2. esbuild 0.28.2 (repo-pinned) with the EXACT pinned option set of
 *      export.md §5.3 (bundle/platform-browser/iife/treeShaking-off/sourcemap-off/
 *      minify-off) — proves the distribution builds under M1's browser-bundle
 *      configuration, including the no-top-level-await constraint (see
 *      build-iife.mjs; candidate resolved from the disposable prefix via nodePaths).
 *
 * The program: init the engine, build a one-collider world + capsule character
 * (the 0.20.0 parentless-collider pattern), run 10 fixed steps, print a marker.
 * Async via main().then — no top-level await (export.md §5.3 IIFE rule).
 */
import RAPIER from '@dimforge/rapier2d-compat';

const DT = 1 / 120;

async function main(): Promise<void> {
  await RAPIER.init();
  const world = new RAPIER.World({ x: 0, y: -19.62 });
  world.timestep = DT;
  const floorBody = world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(0, -0.25));
  world.createCollider(RAPIER.ColliderDesc.cuboid(10, 0.25), floorBody);
  // parentless collider (documented pattern for computeColliderMovement)
  const charCollider = world.createCollider(
    RAPIER.ColliderDesc.capsule(0.6, 0.3).setTranslation(0, 0.91),
  );
  const cc = world.createCharacterController(0.01);
  cc.setMaxSlopeClimbAngle((45 * Math.PI) / 180);
  cc.setMinSlopeSlideAngle((30 * Math.PI) / 180);
  cc.enableSnapToGround(0.1);
  for (let i = 0; i < 10; i++) {
    cc.computeColliderMovement(charCollider, { x: 0.0333, y: 0 });
    const m = cc.computedMovement();
    const t = charCollider.translation();
    charCollider.setTranslation({ x: t.x + m.x, y: t.y + m.y });
    world.step();
  }
  const t = charCollider.translation();
  console.log(
    JSON.stringify({
      tl14_probe: 'ok',
      version: RAPIER.version(),
      x: Number(t.x.toFixed(4)),
      y: Number(t.y.toFixed(4)),
      grounded: cc.computedGrounded(),
    }),
  );
}

main().then(() => undefined).catch((err: unknown): void => {
  console.error(JSON.stringify({ tl14_probe: 'fail', error: String(err) }));
  throw err; // unhandled rejection ⇒ non-zero exit in Node; on-page error in a browser
});

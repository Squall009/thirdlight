/**
 * Packet 32 — the controller contract constants (`docs/contracts/runtime.md`
 * §12.1/§12.2, promoted from `platformer.md` §7/§12 and `physics.md` §7).
 *
 * These are **contract constants, not settings** (platformer.md §10): changing
 * one changes the replay semantics and the frozen packet-14 course evidence.
 * They are exported as the `@thirdlight/platformer` `CONTROLLER_CONSTANTS`
 * surface (`dependencies.md` §3 `platformer` row) and mirror the settled
 * values in `bundle/platformer` only — the controller re-derives nothing.
 */

/** The accepted controller module ID (`runtime.md` §12.1 module inventory). */
export const PLATFORMER_MODULE_ID = 'thirdlight.platformer:controller' as const;

/**
 * Every contract constant the controller algorithm uses (`platformer.md`
 * §12). `autostep` is `false`: M2 never climbs stairs automatically. The
 * capsule is not here: since phase 14.0 it is the player's data
 * (`controller.capsule`), handed to the physics port by the host.
 */
export const CONTROLLER_CONSTANTS: Readonly<{
  offsetSkin: 0.01;
  groundSnap: 0.1;
  autostep: false;
  moveAccel: 40;
  moveDecel: 60;
  coyoteSteps: 6;
  jumpBufferSteps: 8;
  jumpReleaseFactor: 0.5;
  settlePreRollSteps: 12;
}> = Object.freeze({
  offsetSkin: 0.01,
  groundSnap: 0.1,
  autostep: false,
  moveAccel: 40,
  moveDecel: 60,
  coyoteSteps: 6,
  jumpBufferSteps: 8,
  jumpReleaseFactor: 0.5,
  settlePreRollSteps: 12,
});

/** The claimed fixed step the frozen traces were derived at (runtime.md §5). */
export const CONTROLLER_FIXED_STEP_HZ = 120 as const;

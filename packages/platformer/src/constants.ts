/**
 * Packet 32 — the controller's movement constants (`docs/contracts/runtime.md`
 * §12.1/§12.2, promoted from `platformer.md` §7/§12 and `physics.md` §7).
 *
 * Phase 15.3: these are no longer contract constants but the **defaults** of
 * the player's `controller` tuning data (acceleration, deceleration,
 * coyoteTime, jumpBuffer, jumpRelease, groundSnap, skin, autostep; the
 * project-model's `DEFAULT_CONTROLLER_TUNING` states the same values with
 * their reasons). A controller without those fields plays exactly as before,
 * so every recorded replay stays valid. The step counts are the 120 Hz form
 * of the second-based defaults (0.05 s = 6 steps, 1/15 s = 8 steps); the
 * module converts the seconds at its own step rate. The settle pre-roll is
 * the game block's `settleTime` (default 0.1 s = 12 steps), run by the runtime.
 */
/** The accepted controller module ID (`runtime.md` §12.1 module inventory). */
export const PLATFORMER_MODULE_ID = 'thirdlight.platformer:controller' as const;

/**
 * The default of every tuning value the controller algorithm uses
 * (`platformer.md` §12; phase 15.3: overridden by the player's `controller`
 * data). `autostep` is `false` by default: a platformer climbs by jumping.
 * The capsule is not here: since phase 14.0 it is the player's data
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

/**
 * Phase 15.3: the second-based defaults (the step counts above at 120 Hz):
 * coyote time 0.05 s, jump buffer 1/15 s.
 */
export const CONTROLLER_DEFAULT_SECONDS: Readonly<{ coyoteTime: number; jumpBuffer: number }> = Object.freeze({
  coyoteTime: 0.05,
  jumpBuffer: 8 / 120,
});

/** The fixed step the frozen traces were derived at (runtime.md §5; phase 15.3: the default of the `fixed_step_hz` setting). */
export const CONTROLLER_FIXED_STEP_HZ = 120 as const;

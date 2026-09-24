/**
 * The `gameplay`-phase session module — `docs/contracts/gameplay.md` §3.2
 * item 6, §4 and runtime.md §12.1 (the `thirdlight.platformer-game:session`
 * inventory row).
 *
 * The module is **stateless** (`gameplay.md` §3.3/§4.6): it holds no world,
 * no port, no per-zone latch and no memory between steps. Every executed step
 * it reads the committed run data and the last completed motion segment
 * through the frozen `ctx.gameplay` port, evaluates the pure predicate of
 * `./zones`, and commits at most exactly one decision through the three
 * port calls. All run state, counters, events and the committed view live in
 * the runtime (§1 ownership table).
 *
 * It imports `@thirdlight/runtime` **types only** (dependencies.md §4.1).
 */
import type {
  ModuleConfig,
  RuntimeSnapshot,
  SimulationModuleSpec,
  SimulationPhaseModule,
  StepContext,
} from '@thirdlight/runtime';
import { PLATFORMER_GAME_MODULE_ID } from './constants';
import { stepZones } from './zones';

/** Build the stateless session module instance. */
export function createGameSessionModule(
  snapshot: RuntimeSnapshot,
  cfg: ModuleConfig,
): SimulationPhaseModule {
  // The runtime validates the v3 snapshot/game block before `create`
  // (`gameplay.md` §3.4); these checks are the defensive path for a direct
  // caller, so a session module can never run without frozen content.
  if (cfg.sceneVersion !== 3 && cfg.sceneVersion !== 4) {
    throw new Error(`${PLATFORMER_GAME_MODULE_ID} requires a schemaVersion 3 snapshot scene`);
  }
  if (cfg.game === undefined || cfg.game === null) {
    throw new Error(`${PLATFORMER_GAME_MODULE_ID} requires a non-null content.game block`);
  }
  void snapshot;
  return {
    // The run/zone module owns no transform (`gameplay.md` §3.4 owner table).
    transformOwners: [],
    step(phase, ctx: StepContext): void {
      if (phase !== 'gameplay') return;
      const port = ctx.gameplay;
      if (port === undefined) {
        throw new Error(`${PLATFORMER_GAME_MODULE_ID} requires the M3 GameSessionPort`);
      }
      const run = port.run();
      // While `respawning`, `awaitingStart` or `won` no zone is evaluated and
      // no fall is checked (`gameplay.md` §2.4/§4.3) — the phase is a no-op.
      if (run.state !== 'playing') return;
      const content = port.content;
      const segment = port.lastMotionSegment(content.player.entityId);
      if (segment === undefined) return; // no completed motion segment yet
      const decision = stepZones({
        run: { checkpointId: run.checkpointId },
        zones: content.zones,
        // v4 has no kill height (falls are hazard zones or script rules).
        killY: content.game.killY ?? Number.NEGATIVE_INFINITY,
        from: segment.from,
        to: segment.to,
        capsule: content.player.capsule,
      });
      if (decision.kind === 'death') {
        if (decision.cause === 'hazard') port.beginRespawn('hazard', decision.zoneId);
        else port.beginRespawn('fall');
        return;
      }
      if (decision.kind === 'checkpoint') {
        // `stepZones` already applied the single-activation guard; the port
        // re-validates it as the run-state commit rule (§4.5).
        port.activateCheckpoint(decision.zoneId);
        return;
      }
      if (decision.kind === 'goal') {
        port.reachGoal(decision.zoneId);
      }
    },
    dispose(): void {
      /* stateless: nothing to release */
    },
  };
}

/**
 * The registered session module spec (runtime.md §12.1 inventory):
 * phases `["gameplay"]`, no transform owners, no physics-port requirement
 * (the runtime owns the port; the module never receives it).
 */
export const platformerGameSessionSpec: SimulationModuleSpec = {
  id: PLATFORMER_GAME_MODULE_ID,
  phases: ['gameplay'],
  create: createGameSessionModule,
};

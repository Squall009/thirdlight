/**
 * Adapter errors.
 *
 * Initialization failures are *returned* (`physics_init_failed` /
 * `physics_init_cancelled`, physics.md §6/§10) — never thrown, so the host can
 * report an actionable unavailable state. Runtime failures are *thrown* from
 * the port so the runtime's fail-stop path (`physics_port_error`, runtime.md
 * §13) applies:
 *
 * - a stale handle (any port call after `dispose()`) throws
 *   `physics_port_disposed` instead of touching the freed WASM world;
 * - a movement the adapter cannot sweep safely (a non-finite staged delta, or
 *   a non-finite correction result) throws `physics_port_error` with
 *   `reason: "collision_correction_failed"` and leaves the capsule where it
 *   was — the runtime never applies a partially corrected result.
 */

export type PhysicsPortErrorCode = 'physics_port_disposed' | 'physics_port_error';

export interface PhysicsPortErrorDetails {
  code: PhysicsPortErrorCode;
  reason?: string;
  detail: string;
}

export class PhysicsPortError extends Error {
  readonly code: PhysicsPortErrorCode;
  readonly reason?: string;

  constructor(details: PhysicsPortErrorDetails) {
    super(details.detail);
    this.name = 'PhysicsPortError';
    this.code = details.code;
    if (details.reason !== undefined) this.reason = details.reason;
  }
}

export function disposedError(operation: string): PhysicsPortError {
  return new PhysicsPortError({
    code: 'physics_port_disposed',
    detail:
      `${operation} after dispose(): the Rapier World has been released ` +
      '(physics.md §6 — a disposed port is never used; the host creates a fresh port)',
  });
}

export function correctionError(detail: string): PhysicsPortError {
  return new PhysicsPortError({
    code: 'physics_port_error',
    reason: 'collision_correction_failed',
    detail,
  });
}

export function resetError(detail: string): PhysicsPortError {
  return new PhysicsPortError({
    code: 'physics_port_error',
    reason: 'invalid_reset',
    detail,
  });
}

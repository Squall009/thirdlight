/**
 * Bodies outside the loaded world. Streaming loads collision only round the
 * camera, its target and the players, so a body far from them would fall
 * through the ground that is not there. A body the engine moves (a player
 * character, a patrol, a gravity body) that is not over loaded collision is
 * suspended instead: no gravity, no movement and no contacts, its state
 * (position, fall speed, walking direction, controller state) kept as it
 * was. It resumes in the step its area's collision arrives.
 *
 * One rule, at each step boundary right after the rings move: every body's
 * test points (its position's ground column; a walker's next step too) are
 * looked up in the streaming's loaded cells (`SimWorldStream.loadedAt`).
 * The answer holds for the whole step. It is read from the committed state
 * and the rings, both of which page and worker share, so they suspend and
 * resume the same bodies at the same steps.
 *
 * Path movers are not suspended: their motion needs no ground, and a mover
 * that stopped while far away would come back out of step with the others.
 */

/** Suspended bodies in a play's diagnostics (`runtime.worldStream.suspended`). */
export interface SuspensionDiagnostics {
  /** Bodies suspended this step. */
  bodies: number;
  /** Times a body was suspended, and resumed, since the play began. */
  suspensions: number;
  resumes: number;
}

/** Gives every body the engine moves: `test(id, x, z)` once per point it needs loaded (a body with any point unloaded is suspended). */
export type SuspensionCandidates = (test: (id: string, x: number, z: number) => void) => void;

const NONE: ReadonlySet<string> = new Set();

export class BodySuspension {
  private now: ReadonlySet<string> = NONE;
  private suspensions = 0;
  private resumes = 0;

  /** `loadedAt`: whether a ground column has its collision; `active`: whether anything streams (else nothing is tested). */
  constructor(
    private readonly loadedAt: (x: number, z: number) => boolean,
    private readonly active: () => boolean,
  ) {}

  /** The step boundary (after the rings moved): which bodies are suspended for this step. */
  update(candidates: SuspensionCandidates): void {
    if (!this.active()) {
      this.settle(NONE);
      return;
    }
    let next: Set<string> | null = null;
    candidates((id, x, z) => {
      if (next?.has(id) === true || this.loadedAt(x, z)) return;
      (next ??= new Set()).add(id);
    });
    this.settle(next ?? NONE);
  }

  /** Whether a body is suspended this step. */
  has(id: string): boolean {
    return this.now.size > 0 && this.now.has(id);
  }

  /** How many bodies are suspended this step. */
  get count(): number {
    return this.now.size;
  }

  diagnostics(): SuspensionDiagnostics {
    return { bodies: this.now.size, suspensions: this.suspensions, resumes: this.resumes };
  }

  private settle(next: ReadonlySet<string>): void {
    if (next.size === 0 && this.now.size === 0) return;
    for (const id of next) if (!this.now.has(id)) this.suspensions += 1;
    for (const id of this.now) if (!next.has(id)) this.resumes += 1;
    this.now = next;
  }
}

/**
 * The parts of the runtime's diagnostics it reads from what it composes: the
 * input source, the physics port and the behavior hosts. Each read is
 * guarded — a throwing or malformed answer reads as zeros — because a
 * diagnostics read must never break `getDiagnostics()`.
 */
import type { ActionSource } from './actions';
import type { PhysicsDiagnostics } from './ports';

const count = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0);

/** The input source's suspend/activate/disconnect/unsupported-mapping counts. */
export function actionDiagnostics(actions: ActionSource): { suspend: number; activate: number; disconnect: number; mappingUnsupported: number } {
  let d: { suspendCount?: number; activateCount?: number; disconnectCount?: number; mappingUnsupportedCount?: number } = {};
  if (typeof actions.diagnostics === 'function') {
    try {
      d = actions.diagnostics() ?? {};
    } catch {
      d = {};
    }
  }
  return { suspend: count(d.suspendCount), activate: count(d.activateCount), disconnect: count(d.disconnectCount), mappingUnsupported: count(d.mappingUnsupportedCount) };
}

/**
 * The physics port's stalled steps and corrected penetrations (2D or 3D port;
 * none: zeros), and the deepest overlap the character began a step in, named
 * as the entity pair (the character's first) once there was one.
 */
export function physicsDiagnostics(port: { diagnostics?(): PhysicsDiagnostics } | undefined, characterId: string | undefined): { stall: number; penetration: number; deepest: { physicsDeepestOverlap?: { entities: [string, string]; depth: number; physicsStep: number } } } {
  let stall = 0;
  let penetration = 0;
  let deepest = {};
  if (port && typeof port.diagnostics === 'function') {
    try {
      const d = port.diagnostics() ?? {};
      if (typeof d.stallSteps === 'number' && Number.isFinite(d.stallSteps)) stall = d.stallSteps;
      if (typeof d.penetrationCorrectedCount === 'number' && Number.isFinite(d.penetrationCorrectedCount)) penetration = d.penetrationCorrectedCount;
      const o = d.deepestOverlap;
      if (o !== undefined && typeof o.entityId === 'string' && Number.isFinite(o.depth) && Number.isFinite(o.step)) deepest = { physicsDeepestOverlap: { entities: [characterId ?? '', o.entityId], depth: o.depth, physicsStep: o.step } };
    } catch {
      /* diagnostics must never break getDiagnostics() */
    }
  }
  return { stall, penetration, deepest };
}

/** Cumulative behavior log totals the behavior host instances report (summed over the module instances). */
export function behaviorLogTotals(instances: readonly unknown[]): { logCount: number; logDropped: number } {
  let logCount = 0;
  let logDropped = 0;
  for (const instance of instances) {
    const probe = instance as { behaviorDiagnostics?: () => { logCount?: number; logDropped?: number } };
    if (typeof probe.behaviorDiagnostics !== 'function') continue;
    try {
      const d = probe.behaviorDiagnostics();
      if (typeof d?.logCount === 'number' && Number.isFinite(d.logCount)) logCount += d.logCount;
      if (typeof d?.logDropped === 'number' && Number.isFinite(d.logDropped)) logDropped += d.logDropped;
    } catch {
      /* diagnostics must never break getDiagnostics() */
    }
  }
  return { logCount, logDropped };
}

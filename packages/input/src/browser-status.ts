/**
 * The browser binding's diagnostics: the structured events it reports to the host's sink (a sink
 * that throws never breaks input), the unavailable state (reported once per attach) and the
 * counters `diagnostics()` returns.
 */

import type { InputBindingOptions } from './types';

/** One diagnostic event (the shape the binding's options declare). */
export type InputDiagnosticEvent = Parameters<NonNullable<InputBindingOptions['onDiagnostic']>>[0];

export function createInputStatus(options: Pick<InputBindingOptions, 'onDiagnostic'>) {
  let unavailableState: { reason: 'gamepad' | 'environment'; message: string } | null = null;
  let unavailableReported = false;
  const counters = {
    suspendCount: 0,
    activateCount: 0,
    disconnectCount: 0,
    mappingUnsupportedCount: 0,
  };

  const emit = (event: InputDiagnosticEvent): void => {
    if (!options.onDiagnostic) return;
    try {
      options.onDiagnostic(event);
    } catch {
      // A diagnostic sink must never break input (diagnostics only).
    }
  };

  const markUnavailable = (reason: 'gamepad' | 'environment', message: string): void => {
    if (unavailableState === null) unavailableState = { reason, message };
    if (unavailableReported) return;
    unavailableReported = true;
    emit({ code: 'input_unavailable', reason, message });
  };

  return {
    emit,
    markUnavailable,
    counters,
    unavailable: (): { reason: 'gamepad' | 'environment'; message: string } | null => (unavailableState ? { ...unavailableState } : null),
    diagnostics: (): {
      suspendCount: number;
      activateCount: number;
      disconnectCount: number;
      mappingUnsupportedCount: number;
    } => ({ ...counters }),
  };
}

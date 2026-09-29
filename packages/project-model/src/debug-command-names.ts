/**
 * The debug command the engine declares in every game: `signal <name>` emits
 * a signal. The runtime runs it; tools send it by this name (packages that may
 * only take types from here pin their copy with `SignalDebugCommandName`).
 */
export const SIGNAL_DEBUG_COMMAND_NAME = 'signal';
export type SignalDebugCommandName = typeof SIGNAL_DEBUG_COMMAND_NAME;

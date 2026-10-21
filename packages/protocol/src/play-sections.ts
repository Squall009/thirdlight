/**
 * The parts of a Play answer a tool can ask for alone (`sections` on
 * tl_diagnostics and tl_game_observe), so a big scene's answer can carry
 * just what a check needs, whole, inside its bound. A section is a
 * top-level part of the answer; an observation's header (its identity,
 * step and play state) always comes with it.
 */
import { sessionError, type SessionError } from './errors';
import { checkShape } from './strict';

/** The top-level parts of a Play diagnostics answer. */
export const PLAY_DIAGNOSTICS_SECTIONS = [
  'runtime',
  'renderer',
  'buildId',
  'frameDrops',
  'simulation',
  'framePacing',
  'mode',
  'startTimings',
  'assetReads',
  'catalogReads',
  'resources',
  'audio',
  'frameTimes',
  'saves',
] as const;

/** The top-level parts of a game observation besides its header (`GAME_OBSERVATION_HEADER`). */
export const GAME_OBSERVATION_SECTIONS = [
  'run',
  'simulation',
  'player',
  'players',
  'scenes',
  'loops',
  'camera',
  'environment',
  'audio',
  'sockets',
  'timeline',
  'pointer',
  'cursor',
  'hidden',
  'inputBindings',
  'counters',
  'health',
  'resources',
  'animators',
  'spawned',
  'renderer',
  'effects',
  'behaviors',
  'animator',
  'renderedBones',
  'debug',
  'debugCommands',
  'start',
  'saves',
  'ui',
  'dialogue',
  'mode',
  'paused',
  'pausePanel',
  'shell',
] as const;

/** Why a `sections` value is refused (it names the valid sections), or null. */
export function playSectionsProblem(value: unknown, valid: readonly string[]): string | null {
  const names = `the sections are: ${valid.join(', ')}`;
  if (!Array.isArray(value) || value.length === 0 || value.length > valid.length) return `sections must be a list of 1-${valid.length} section names; ${names}`;
  const unknown = value.filter((s) => typeof s !== 'string' || !valid.includes(s));
  if (unknown.length > 0) return `unknown section${unknown.length === 1 ? '' : 's'} ${unknown.map((s) => JSON.stringify(s)).join(', ').slice(0, 200)}; ${names}`;
  return null;
}

/** The answer with only the `header` parts and the asked `sections` (the whole answer without `sections`). */
export function pickPlaySections(answer: Record<string, unknown>, sections: readonly string[] | undefined, header: readonly string[] = []): Record<string, unknown> {
  if (sections === undefined) return answer;
  const wanted = new Set([...header, ...sections]);
  return Object.fromEntries(Object.entries(answer).filter(([k]) => wanted.has(k)));
}

export interface DiagnosticsRequest {
  /** Only these parts of the diagnostics (all of them when absent). */
  sections?: string[];
}

/** Parse the Play diagnostics request body `{ sections? }`. */
export function parseDiagnosticsRequest(value: unknown): { ok: true; request: DiagnosticsRequest } | { ok: false; error: SessionError } {
  const shape = checkShape(value ?? {}, '', new Map([['sections', `a list of section names (${PLAY_DIAGNOSTICS_SECTIONS.join(', ')})`]]), []);
  if (!shape.ok) return { ok: false, error: shape.error };
  return sectionsField(shape.value, PLAY_DIAGNOSTICS_SECTIONS, (sections) => ({ ok: true, request: sections !== undefined ? { sections } : {} }));
}

/** The body's optional `sections` checked against `valid`, handed to `then`. */
export function sectionsField<T>(body: Record<string, unknown>, valid: readonly string[], then: (sections: string[] | undefined) => { ok: true; request: T }): { ok: true; request: T } | { ok: false; error: SessionError } {
  if (body['sections'] === undefined) return then(undefined);
  const problem = playSectionsProblem(body['sections'], valid);
  if (problem !== null) return { ok: false, error: sessionError('field_value', 'validation', problem, { path: '/sections', expected: valid.join(', ') }) };
  return then([...new Set(body['sections'] as string[])]);
}

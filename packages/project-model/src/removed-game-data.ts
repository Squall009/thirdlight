/**
 * Game data the engine no longer has (the genre layer's components and the
 * content `game` block). A document that still holds it is refused with a
 * text that says what it was and where such behaviour belongs now, never
 * silently dropped (content never loses behaviour without saying so).
 */

/** The tail every refusal of removed game data carries. */
export const REMOVED_FROM_ENGINE = 'removed from the engine: build it as project scripts';

/** The components deleted with the genre layer (what each did, for the problem text). */
export const REMOVED_COMPONENTS: Readonly<Record<string, string>> = Object.freeze({
  enemy: 'an enemy (patrol, contact damage, stomp)',
  gameZone: 'a game zone (hazard, checkpoint, goal or exit)',
  cameraFollow: 'the game session camera follow',
  pickup: 'a pickup',
});

/** The problem text for a removed component (`component_unknown`). */
export function removedComponentMessage(name: string): string {
  const what = REMOVED_COMPONENTS[name];
  return `component "${name}"${what !== undefined ? ` (${what})` : ''} was ${REMOVED_FROM_ENGINE}`;
}

/** Whether a component name is one of the removed game components. */
export function isRemovedComponent(name: string): boolean {
  return Object.prototype.hasOwnProperty.call(REMOVED_COMPONENTS, name);
}

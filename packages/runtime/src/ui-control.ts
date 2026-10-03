/**
 * `ctx.ui` for one simulation phase: the scripts' side of the project UI
 * (view model, shown documents, tween and focus commands, the step's UI
 * events, the view the host draws over). The UI events are read in the
 * intent phase only, once per step.
 */
import type { BehaviorUi, SimulationPhase } from './types';
import type { UiEventRecord, UiState } from './ui';

const NO_EVENTS: readonly UiEventRecord[] = Object.freeze([]);

export function createUiControl(ui: UiState, phase: SimulationPhase): BehaviorUi {
  const events = (): readonly UiEventRecord[] => (phase === 'intent' ? ui.events() : NO_EVENTS);
  return Object.freeze({
    set: (path: string, value: unknown): boolean => ui.set(path, value),
    get: (path: string): unknown => ui.get(path),
    clear: (path: string): boolean => ui.clear(path),
    show: (docId: string, options?: { layer?: number; modal?: boolean }): boolean => ui.show(docId, options),
    hide: (docId: string): boolean => ui.hide(docId),
    isShown: (docId: string): boolean => ui.isShown(docId),
    play: (docId: string, tween: string, widgetId?: string): boolean => ui.command('play', docId, tween, widgetId),
    focus: (docId: string, widgetId: string, index?: number): boolean => ui.command('focus', docId, widgetId, undefined, index),
    view: () => ui.screenView(),
    events,
    event: (name: string): UiEventRecord | null => events().find((e) => e.name === name) ?? null,
  });
}

/**
 * `ctx.ui` for one simulation phase: the scripts' side of the project UI
 * (view model, shown documents, tween and focus commands, the step's UI
 * events, the view the host draws over). The UI events are read in the
 * intent phase only, once per step.
 */
import type { BehaviorUi, SimulationPhase } from './types';
import { MAX_FRAME_UI_EVENTS, validateUiEvent, type UiEventRecord, type UiState } from './ui';

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

/** `ctx.ui` for one phase, made once per phase and kept in `made`. */
export function uiControlOf(made: Map<SimulationPhase, BehaviorUi>, ui: UiState, phase: SimulationPhase): BehaviorUi {
  let c = made.get(phase);
  if (c === undefined) {
    c = createUiControl(ui, phase);
    made.set(phase, c);
  }
  return c;
}

/**
 * A UI event the host queues for the next sampled step (`Runtime.queueUiEvent`),
 * checked and put on `queue`; a refusal says why (`reason`, the field's `path`).
 */
export function queueUiEventChecked(ui: UiState, queue: UiEventRecord[], event: UiEventRecord): { ok: true } | { ok: false; message: string; reason: string; path?: string } {
  const checked = validateUiEvent(event);
  if (!checked.ok) return { ok: false, message: `UI event: ${checked.message}`, reason: 'ui_event', path: `/${checked.field}` };
  if ((checked.event.kind === 'show' || checked.event.kind === 'hide' || checked.event.kind === 'toggle') && !ui.hasDocument(checked.event.doc)) {
    return { ok: false, message: `no UI document "${checked.event.doc}"`, reason: 'ui_event' };
  }
  if (queue.length >= MAX_FRAME_UI_EVENTS * 4) return { ok: false, message: `at most ${MAX_FRAME_UI_EVENTS * 4} UI events may wait for the next step`, reason: 'pending' };
  queue.push(checked.event);
  return { ok: true };
}

/**
 * The settling of the edit modes' stored settings: a slider shows each move
 * at once, and the value is stored (one command) once the control rests, so
 * a drag is one command, not one per pointer move.
 *
 * The edits wait as functions of the stored value, by key, and are applied
 * together to the value as the project holds it when they are handed over —
 * not to the value of the render they were made in. So two sliders moved
 * within the wait both stick, and an undo (or an MCP edit) arriving within
 * it is built on, not reverted. Edits handed over keep being drawn over the
 * stored value until the project shows a new one (or refuses them).
 *
 * The class is plain TypeScript (tested without a browser); the hook binds
 * it to a React component.
 */
import { useEffect, useReducer, useRef } from 'react';

/** Milliseconds a settling control rests before its value is stored. */
export const SLIDER_SETTLE_MS = 250;

interface Edit<T> {
  label: string;
  apply: (doc: T) => T;
}

/** Stores one value (a component, a material) through `save`; `edit` queues a change of it. */
export class SettledEdits<T> {
  private stored: T;
  private readonly pending = new Map<string, Edit<T>>();
  /** Handed over, not shown back yet. */
  private readonly sent = new Map<string, Edit<T>>();
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    stored: T,
    private readonly save: (next: T, label: string) => unknown,
    private readonly changed: () => void = () => {},
    private readonly wait = SLIDER_SETTLE_MS,
  ) {
    this.stored = stored;
  }

  /** The project's value now. A new one has the handed-over edits in it (or has moved past them). */
  setStored(doc: T): void {
    if (Object.is(doc, this.stored)) return;
    this.stored = doc;
    this.sent.clear();
  }

  /** The stored value with the edits not shown back yet: what the controls show. */
  get value(): T {
    let d = this.stored;
    for (const e of this.sent.values()) d = e.apply(d);
    for (const e of this.pending.values()) d = e.apply(d);
    return d;
  }

  /** Queues `apply` under `key` (a later edit of the same key replaces it); `now` stores at once (a click, a name typed). */
  readonly edit = (key: string, label: string, apply: (doc: T) => T, now = false): void => {
    this.pending.delete(key);
    this.pending.set(key, { label, apply });
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.changed();
    if (now) this.flush();
    else this.timer = setTimeout(this.flush, this.wait);
  };

  /** Stores what waits, as one save named after the last edit. */
  readonly flush = (): void => {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    if (this.pending.size === 0) return;
    const next = this.value;
    const handed = [...this.pending];
    this.pending.clear();
    for (const [k, e] of handed) {
      this.sent.delete(k);
      this.sent.set(k, e);
    }
    const r = this.save(next, handed[handed.length - 1]![1].label);
    // A refused save is not drawn on: the controls show the stored value again.
    const drop = (): void => {
      let any = false;
      for (const [k, e] of handed) {
        if (this.sent.get(k) === e) {
          this.sent.delete(k);
          any = true;
        }
      }
      if (any) this.changed();
    };
    if (r instanceof Promise) r.then((ok) => ok === false && drop(), drop);
  };
}

/** `SettledEdits` for a component: re-rendered on each edit, the stored value followed, what waits stored when it goes. */
export function useSettledEdits<T>(stored: T, save: (next: T, label: string) => unknown): SettledEdits<T> {
  const [, bump] = useReducer((n: number) => n + 1, 0);
  const latestSave = useRef(save);
  latestSave.current = save;
  const q = useRef<SettledEdits<T> | null>(null);
  q.current ??= new SettledEdits(stored, (next, label) => latestSave.current(next, label), bump);
  q.current.setStored(stored);
  useEffect(() => () => q.current?.flush(), []);
  return q.current;
}

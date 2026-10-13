/**
 * A first-come, first-served gate for long requests: at most `max` run at
 * once, the rest wait their turn.
 *
 * Why: a browser opens about six HTTP/1.1 connections to one origin. A
 * request the backend takes seconds to answer (a texture array it
 * assembles) holds one for that long, so a burst of them — a layered
 * surface given four 2048² sheets asks for six arrays at once — fills every
 * connection, and the editor's commands, index pages and asset reads then
 * queue behind them (a texture browser that says "loading…" for a minute,
 * an edit that lands late). The backend makes those arrays one after the
 * other anyway, so holding the rest back in the page costs no time.
 */
export class FetchGate {
  private running = 0;
  private readonly waiting: (() => void)[] = [];

  constructor(private readonly max: number) {}

  /** How many requests run now and how many wait (tests, diagnostics). */
  get load(): { running: number; waiting: number } {
    return { running: this.running, waiting: this.waiting.length };
  }

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.running >= this.max) await new Promise<void>((go) => this.waiting.push(go));
    else this.running += 1;
    try {
      return await task();
    } finally {
      // The next waiter takes this place (the count stays), or the place is given back.
      const next = this.waiting.shift();
      if (next !== undefined) next();
      else this.running -= 1;
    }
  }
}

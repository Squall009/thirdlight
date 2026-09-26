/**
 * Phase 23.8: the in-game debug console — a small overlay that lists the
 * project's debug commands (the ones its scripts declared with
 * `ctx.debug.command`) and runs one from a typed line.
 *
 * Play always has it (a development tool); an exported game only when the
 * project enables the `debug_console` setting (off by default, so a release
 * build never ships a console by accident). The backquote key (` — the
 * common console key of PC games, not bound by any engine default) opens and
 * closes it. A line is `name arg1 arg2 …` (the declared order) or
 * `name key=value …`; text with spaces goes in double quotes. `help` lists the
 * commands. A command does not run here: it is queued into the next
 * simulation step's input (`Runtime.queueDebugCommand`), so a recording of the
 * run replays it exactly.
 *
 * Plain DOM built with `textContent` only (a command's text is never HTML);
 * its styles are a constructed stylesheet where the page supports it (the Play
 * page's CSP refuses inline styles), else a `<style>` element.
 */
import type { DebugCommandArgs, DebugCommandSpec, DebugCommandState } from '@thirdlight/runtime';
import type { HostDom, HostDomNode } from './hud';

/** The console key (`KeyboardEvent.code`). */
export const DEBUG_CONSOLE_KEY = 'Backquote';
/** Lines the console keeps (older ones scroll away). */
const MAX_LINES = 40;

export interface DebugConsoleDeps {
  readonly dom: HostDom;
  readonly container: HostDomNode;
  /** The game's debug commands now (registered, applied). */
  readonly state: () => DebugCommandState | null;
  /** Queue one call for the next step (the host's `debugCommand`). */
  readonly run: (name: string, args: DebugCommandArgs) => { ok: true } | { ok: false; message: string };
  /** Hand the keyboard back to the game when the console closes (focus its surface). */
  readonly focusGame?: () => void;
}

export interface DebugConsole {
  readonly open: boolean;
  setOpen(open: boolean): void;
  toggle(): void;
  /** Run one typed line (what Enter does). */
  submit(line: string): void;
  /** The host's per-frame call (reports calls the game ran while it is open). */
  frame(): void;
  /** The console's text lines (tests; newest last). */
  lines(): readonly string[];
  dispose(): void;
}

const CSS = `
.tl-console{position:fixed;left:8px;right:8px;bottom:8px;max-height:45%;display:flex;flex-direction:column;gap:4px;padding:8px;background:rgba(10,12,16,.9);color:#d8dee9;font:12px/1.4 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;border:1px solid #3b4252;border-radius:4px;z-index:2147483000;pointer-events:auto}
.tl-console.is-hidden{display:none}
.tl-console__log{overflow-y:auto;white-space:pre-wrap;flex:1 1 auto;min-height:3em}
.tl-console__line.is-error{color:#e5827a}
.tl-console__line.is-cmd{color:#88c0d0}
.tl-console__input{font:inherit;color:inherit;background:#1d2128;border:1px solid #4c566a;border-radius:3px;padding:4px 6px;outline:none}
`;

/** Split a console line into words (double quotes keep spaces; `\"` inside quotes is a quote). */
export function consoleWords(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  let any = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]!;
    if (quoted) {
      if (ch === '\\' && line[i + 1] === '"') {
        cur += '"';
        i += 1;
      } else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') {
      quoted = true;
      any = true;
    } else if (ch === ' ' || ch === '\t') {
      if (cur.length > 0 || any) out.push(cur);
      cur = '';
      any = false;
    } else cur += ch;
  }
  if (cur.length > 0 || any) out.push(cur);
  return out;
}

/**
 * Parse one console line against the registered commands: the command and
 * its typed arguments, or why it cannot run.
 */
export function parseConsoleLine(line: string, commands: readonly DebugCommandSpec[]): { ok: true; name: string; args: DebugCommandArgs } | { ok: false; message: string } {
  const words = consoleWords(line.trim());
  if (words.length === 0) return { ok: false, message: 'type a command (help lists them)' };
  const [name, ...rest] = words as [string, ...string[]];
  const spec = commands.find((c) => c.name === name);
  if (spec === undefined) return { ok: false, message: `unknown command "${name}" (help lists them)` };
  const args: Record<string, number | string | boolean> = {};
  let position = 0;
  for (const w of rest) {
    const eq = w.indexOf('=');
    let argName: string;
    let text: string;
    const named = eq > 0 ? spec.args.find((a) => a.name === w.slice(0, eq)) : undefined;
    if (named !== undefined) {
      argName = named.name;
      text = w.slice(eq + 1);
    } else {
      const a = spec.args[position];
      if (a === undefined) return { ok: false, message: `"${name}" takes ${spec.args.length} argument${spec.args.length === 1 ? '' : 's'}: ${usage(spec)}` };
      position += 1;
      argName = a.name;
      text = w;
    }
    const type = spec.args.find((a) => a.name === argName)!.type;
    if (type === 'number') {
      const v = Number(text);
      if (text.trim() === '' || !Number.isFinite(v)) return { ok: false, message: `${argName} must be a number (got "${text}")` };
      args[argName] = v;
    } else if (type === 'boolean') {
      const t = text.toLowerCase();
      if (t !== 'true' && t !== 'false' && t !== '1' && t !== '0' && t !== 'on' && t !== 'off') return { ok: false, message: `${argName} must be true or false (got "${text}")` };
      args[argName] = t === 'true' || t === '1' || t === 'on';
    } else args[argName] = text;
  }
  for (const a of spec.args) if (a.optional !== true && !(a.name in args)) return { ok: false, message: `"${name}" needs ${a.name}: ${usage(spec)}` };
  return { ok: true, name, args };
}

/** `name <arg:type> [opt:type]`. */
export function usage(spec: DebugCommandSpec): string {
  return [spec.name, ...spec.args.map((a) => (a.optional === true ? `[${a.name}:${a.type}]` : `<${a.name}:${a.type}>`))].join(' ');
}

function argsText(args: DebugCommandArgs): string {
  return Object.entries(args)
    .map(([k, v]) => `${k}=${typeof v === 'string' ? JSON.stringify(v) : String(v)}`)
    .join(' ');
}

export function createDebugConsole(deps: DebugConsoleDeps): DebugConsole {
  const { dom } = deps;
  const root = dom.createElement('div');
  root.setAttribute?.('class', 'tl-console is-hidden');
  root.setAttribute?.('data-open', 'false');
  root.setAttribute?.('role', 'dialog');
  root.setAttribute?.('aria-label', 'Debug console');
  const docLike = dom as unknown as { adoptedStyleSheets?: unknown[] };
  const Sheet = (globalThis as { CSSStyleSheet?: new () => { replaceSync(t: string): void } }).CSSStyleSheet;
  let adopted: unknown = null;
  if (Array.isArray(docLike.adoptedStyleSheets) && Sheet !== undefined) {
    try {
      const sheet = new Sheet();
      sheet.replaceSync(CSS);
      docLike.adoptedStyleSheets = [...docLike.adoptedStyleSheets, sheet];
      adopted = sheet;
    } catch {
      adopted = null;
    }
  }
  if (adopted === null) {
    const style = dom.createElement('style');
    style.textContent = CSS;
    root.appendChild(style);
  }
  const log = dom.createElement('div');
  log.setAttribute?.('class', 'tl-console__log');
  const input = dom.createElement('input');
  input.setAttribute?.('class', 'tl-console__input');
  input.setAttribute?.('aria-label', 'debug console command');
  input.setAttribute?.('autocomplete', 'off');
  input.setAttribute?.('spellcheck', 'false');
  root.appendChild(log);
  root.appendChild(input);
  deps.container.appendChild(root);

  const texts: string[] = [];
  const nodes: HostDomNode[] = [];
  let open = false;
  let disposed = false;
  let seenApplied = -1;
  /** Applied calls already printed (step:name:args). */
  const reported = new Set<string>();
  const history: string[] = [];
  let historyAt = 0;

  const print = (line: string, kind: 'cmd' | 'error' | 'info' = 'info'): void => {
    texts.push(line);
    const p = dom.createElement('div');
    p.setAttribute?.('class', kind === 'info' ? 'tl-console__line' : `tl-console__line is-${kind}`);
    p.textContent = line;
    log.appendChild(p);
    nodes.push(p);
    while (texts.length > MAX_LINES) {
      texts.shift();
      nodes.shift()?.remove();
    }
    (log as unknown as { scrollTop?: number; scrollHeight?: number }).scrollTop = (log as unknown as { scrollHeight?: number }).scrollHeight ?? 0;
  };

  const help = (): void => {
    const cmds = deps.state()?.registered ?? [];
    if (cmds.length === 0) {
      print('no debug commands yet: a script declares one with ctx.debug.command(name, { args })');
      return;
    }
    for (const c of cmds) print(c.description !== '' ? `${usage(c)} — ${c.description}` : usage(c));
  };

  const inputValue = (): string => String((input as unknown as { value?: unknown }).value ?? '');
  const setInputValue = (v: string): void => {
    (input as unknown as { value: string }).value = v;
  };

  const submit = (line: string): void => {
    const text = line.trim();
    if (text === '') return;
    history.push(text);
    if (history.length > 32) history.shift();
    historyAt = history.length;
    print(`> ${text}`, 'cmd');
    if (text === 'help' || text === '?') {
      help();
      return;
    }
    if (text === 'clear') {
      for (const n of nodes.splice(0)) n.remove();
      texts.splice(0);
      return;
    }
    const parsed = parseConsoleLine(text, deps.state()?.registered ?? []);
    if (!parsed.ok) {
      print(parsed.message, 'error');
      return;
    }
    const r = deps.run(parsed.name, parsed.args);
    if (!r.ok) print(r.message, 'error');
  };

  const setOpen = (next: boolean): void => {
    if (disposed || next === open) return;
    open = next;
    root.setAttribute?.('class', open ? 'tl-console' : 'tl-console is-hidden');
    root.setAttribute?.('data-open', open ? 'true' : 'false');
    if (open) {
      if (texts.length === 0) {
        print('Debug console — help lists the commands; ` closes.');
        help();
      }
      seenApplied = deps.state()?.revision ?? -1;
      (input as unknown as { focus?: () => void }).focus?.();
    } else {
      (input as unknown as { blur?: () => void }).blur?.();
      deps.focusGame?.();
    }
  };

  const onInputKey = (event?: unknown): void => {
    const e = event as { key?: string; code?: string; preventDefault?: () => void; stopPropagation?: () => void } | undefined;
    if (e === undefined) return;
    // The console's keys never reach the game (its input listens on the game surface only; this keeps menus out too).
    e.stopPropagation?.();
    if (e.key === 'Enter') {
      e.preventDefault?.();
      const v = inputValue();
      setInputValue('');
      submit(v);
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault?.();
      if (history.length === 0) return;
      historyAt = Math.max(0, Math.min(history.length, historyAt + (e.key === 'ArrowUp' ? -1 : 1)));
      setInputValue(history[historyAt] ?? '');
    } else if (e.key === 'Escape') {
      e.preventDefault?.();
      setOpen(false);
    }
  };
  (input.addEventListener as ((t: string, h: (e?: unknown) => void) => void) | undefined)?.call(input, 'keydown', onInputKey);

  // The toggle key, page-wide (the game surface and the console's own input).
  const win = globalThis as { addEventListener?: (t: string, h: (e: unknown) => void, o?: unknown) => void; removeEventListener?: (t: string, h: (e: unknown) => void, o?: unknown) => void };
  const onKey = (event: unknown): void => {
    const e = event as { code?: string; repeat?: boolean; target?: unknown; preventDefault?: () => void };
    if (e.code !== DEBUG_CONSOLE_KEY || e.repeat === true) return;
    // Another text field (outside the console) keeps its backquote.
    const t = e.target as { tagName?: string; isContentEditable?: boolean } | null | undefined;
    const editable = t !== null && t !== undefined && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable === true);
    if (editable && t !== (input as unknown)) return;
    e.preventDefault?.();
    setOpen(!open);
  };
  win.addEventListener?.('keydown', onKey, true);

  return {
    get open() {
      return open;
    },
    setOpen,
    toggle: () => setOpen(!open),
    submit,
    frame(): void {
      if (!open || disposed) return;
      const st = deps.state();
      if (st === null || st.revision === seenApplied) return;
      // The calls the game ran since the console last looked (a revision also moves when a command is declared).
      const before = seenApplied;
      seenApplied = st.revision;
      if (before < 0) return;
      for (const a of st.applied.slice(-8)) {
        const key = `${a.stepIndex}:${a.name}:${argsText(a.args)}`;
        if (reported.has(key)) continue;
        reported.add(key);
        print(`ran ${a.name}${Object.keys(a.args).length > 0 ? ` ${argsText(a.args)}` : ''} at step ${a.stepIndex}`);
      }
      if (reported.size > 256) reported.clear();
    },
    lines: () => [...texts],
    dispose(): void {
      if (disposed) return;
      disposed = true;
      win.removeEventListener?.('keydown', onKey, true);
      (input.removeEventListener as ((t: string, h: (e?: unknown) => void) => void) | undefined)?.call(input, 'keydown', onInputKey);
      root.remove();
      if (adopted !== null && Array.isArray(docLike.adoptedStyleSheets)) docLike.adoptedStyleSheets = docLike.adoptedStyleSheets.filter((x) => x !== adopted);
    },
  };
}


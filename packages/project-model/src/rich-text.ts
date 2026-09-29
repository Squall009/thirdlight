/**
 * Inline rich text of project UI texts — a small, safe markup
 * parsed to plain tokens (the host builds DOM from them with `textContent`,
 * never HTML):
 *
 *   [b]bold[/b]  [i]italic[/i]  [color=#ff8800]colour[/color]
 *   [size=20]bigger[/size]  [icon=star] (an icon of the document/theme)
 *   {hud.hp} (a view-model value)   [[ (a literal "[")   {{ (a literal "{")
 *   {action:jump} (the action's glyph for the device used last)
 *
 * Unknown or unbalanced tags are shown as the text they are. Pure.
 *
 * Moved here from the game host so the dialogue runner (in the
 * simulation) counts a line's visible characters with the host's rules — a
 * typewriter reveal of N characters shows the same N on screen.
 */

export type RichStyle = { readonly bold?: boolean; readonly italic?: boolean; readonly color?: string; readonly size?: number };
export type RichToken =
  | { readonly t: 'text'; readonly text: string; readonly style: RichStyle }
  | { readonly t: 'value'; readonly path: string; readonly style: RichStyle }
  | { readonly t: 'icon'; readonly name: string; readonly style: RichStyle }
  | { readonly t: 'glyph'; readonly action: string; readonly style: RichStyle };

const COLOR_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
const NAME_RE = /^[A-Za-z_][A-Za-z0-9_-]{0,31}$/;
/** `{action:name}`: the glyph of an input action. */
const GLYPH_RE = /^action:[A-Za-z_][A-Za-z0-9_]{0,31}$/;

/**
 * Parse a UI text into tokens (placeholders and icons kept as tokens).
 * `values: false` reads `{…}` as plain text (a text that is itself a
 * view-model value, e.g. a dialogue line: its braces are not placeholders),
 * except `{action:name}`, which is a glyph there too.
 */
export function parseRichText(src: string, options?: { readonly values?: boolean }): RichToken[] {
  const values = options?.values !== false;
  const out: RichToken[] = [];
  const stack: { tag: string; style: RichStyle }[] = [];
  let style: RichStyle = {};
  let buf = '';
  const flush = (): void => {
    if (buf === '') return;
    const last = out[out.length - 1];
    if (last !== undefined && last.t === 'text' && last.style === style) out[out.length - 1] = { t: 'text', text: last.text + buf, style };
    else out.push({ t: 'text', text: buf, style });
    buf = '';
  };
  let i = 0;
  while (i < src.length) {
    const ch = src[i]!;
    if (ch === '[' && src[i + 1] === '[') {
      buf += '[';
      i += 2;
      continue;
    }
    if (ch === '{' && src[i + 1] === '{') {
      buf += '{';
      i += 2;
      continue;
    }
    if (ch === '{') {
      const end = src.indexOf('}', i + 1);
      const inner = end > i + 1 ? src.slice(i + 1, end) : '';
      // An input action's glyph is markup in every text (a dialogue line's too); other braces are placeholders only with values.
      const glyph = GLYPH_RE.test(inner);
      if (glyph || (values && inner !== '')) {
        flush();
        out.push(glyph ? { t: 'glyph', action: inner.slice(7), style } : { t: 'value', path: inner, style });
        i = end + 1;
        continue;
      }
    }
    if (ch === '[') {
      const end = src.indexOf(']', i + 1);
      if (end > i) {
        const tag = src.slice(i + 1, end);
        const applied = applyTag(tag);
        if (applied !== null) {
          i = end + 1;
          continue;
        }
      }
    }
    buf += ch;
    i += 1;
  }
  flush();
  return out;

  function applyTag(tag: string): true | null {
    if (tag.startsWith('/')) {
      const name = tag.slice(1);
      const top = stack[stack.length - 1];
      if (top === undefined || top.tag !== name) return null;
      flush();
      stack.pop();
      style = top.style;
      return true;
    }
    const eq = tag.indexOf('=');
    const name = eq < 0 ? tag : tag.slice(0, eq);
    const arg = eq < 0 ? '' : tag.slice(eq + 1);
    let next: RichStyle | null = null;
    if (name === 'b' && eq < 0) next = { ...style, bold: true };
    else if (name === 'i' && eq < 0) next = { ...style, italic: true };
    else if (name === 'color' && COLOR_RE.test(arg)) next = { ...style, color: arg };
    else if (name === 'size' && /^\d{1,3}$/.test(arg) && Number(arg) >= 4 && Number(arg) <= 400) next = { ...style, size: Number(arg) };
    else if (name === 'icon' && NAME_RE.test(arg)) {
      flush();
      out.push({ t: 'icon', name: arg, style });
      return true;
    }
    if (next === null) return null;
    flush();
    stack.push({ tag: name, style });
    style = next;
    return true;
  }
}

/** A value as UI text (numbers trimmed to at most 4 decimals; objects and lists as JSON; null/undefined empty). */
export function uiValueText(v: unknown): string {
  if (v === undefined || v === null) return '';
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : String(Math.round(v * 10_000) / 10_000);
  if (typeof v === 'string') return v;
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  try {
    return JSON.stringify(v);
  } catch {
    return '';
  }
}

/**
 * The visible characters of parsed tokens — a text token's
 * characters (Unicode code points, so a surrogate pair is one), an icon is
 * one, a placeholder one per character of its value text (`valueText`;
 * absent: 0). A typewriter reveal counts these.
 */
export function richTextVisibleLength(tokens: readonly RichToken[], valueText?: (path: string) => string): number {
  let n = 0;
  for (const t of tokens) {
    if (t.t === 'text') n += codePointLength(t.text);
    else if (t.t === 'icon' || t.t === 'glyph') n += 1;
    else if (valueText !== undefined) n += codePointLength(valueText(t.path));
  }
  return n;
}

/** Unicode code points of a text. */
export function codePointLength(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i += 1) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const d = s.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) i += 1;
    }
    n += 1;
  }
  return n;
}

/**
 * Markdown building blocks of the generated reference: pages made of
 * sections, each with a stable anchor, and the size-based split that keeps a
 * page small enough for an agent to read in one call.
 *
 * Anchors are explicit (`<a id="…"></a>` before the heading) so a link or a
 * lookup by section id never depends on how a renderer slugs a heading.
 */

/** The largest page the generator writes (bytes); a bigger area is split. */
export const PAGE_BYTES_MAX = 48_000;

/** A table cell: one line, pipes escaped. */
export function cell(text) {
  return String(text ?? '')
    .replace(/\r?\n+/g, ' ')
    .replace(/\|/g, '\\|')
    .trim();
}

/** Inline code that survives backticks in the text. */
export function code(text) {
  const s = String(text);
  if (!s.includes('`')) return `\`${s}\``;
  return `\`\` ${s} \`\``;
}

/** A link to an anchor anywhere in the reference (resolved once every page is laid out). */
export const ref = (id, text) => `[${text}](@@${id}@@)`;

/** The anchor of a declaration on the type pages. */
export const typeId = (name) => `type-${slug(name)}`;

/** A JSON value as compact inline code. */
export function json(value) {
  return code(JSON.stringify(value));
}

/** A fenced block. */
export function fence(text, lang = '') {
  const ticks = text.includes('```') ? '````' : '```';
  return `${ticks}${lang}\n${text.replace(/\n+$/, '')}\n${ticks}\n`;
}

/** A markdown table from a header and rows (cells are escaped). */
export function table(header, rows) {
  if (rows.length === 0) return '';
  const line = (cells) => `| ${cells.map(cell).join(' | ')} |`;
  return [line(header), `|${header.map(() => '---').join('|')}|`, ...rows.map(line)].join('\n') + '\n';
}

/** An anchor id from free text (lower case, `-` between words). */
export function slug(text) {
  return String(text)
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * One section: an anchored heading and its body. `topics` are the lookup
 * keys (index.json) that answer with this section.
 */
export function section(id, title, body, { level = 2, topics = [] } = {}) {
  return { id, title, level, topics, text: `<a id="${id}"></a>\n${'#'.repeat(level)} ${title}\n\n${body.replace(/\n+$/, '')}\n` };
}

/**
 * A page: a title, an intro and its sections. `file` is relative to the
 * reference directory.
 */
export function page(file, title, intro, sections, topics = []) {
  return { file, title, intro, sections, topics };
}

export function pageText(p) {
  const head = `# ${p.title}\n\n${GENERATED_NOTE}\n\n${p.intro.replace(/\n+$/, '')}\n`;
  return [head, ...p.sections.map((s) => s.text)].join('\n');
}

/** The line every generated page starts with (the regeneration command). */
export const GENERATED_NOTE = '_Generated from the engine source by `node tools/gen-reference.mjs`; do not edit by hand._';

/**
 * A page's size once its links are resolved: a cross-page link
 * (`@@id@@`) becomes `<page file>#id`, at most this much longer than the id.
 */
const LINK_PAGE_BYTES = 40;

function measure(text) {
  return Buffer.byteLength(text.replace(/@@([^@]+)@@/g, (_, id) => `${id}${'.'.repeat(LINK_PAGE_BYTES)}`));
}

/**
 * Split an area into pages of at most `PAGE_BYTES_MAX`: sections stay
 * whole and in order; one page when it fits. `name(i, first, last)` gives
 * each part's file stem and title suffix from its first and last section.
 */
export function splitPages(stem, title, intro, sections, name) {
  const whole = page(`${stem}.md`, title, intro, sections);
  if (measure(pageText(whole)) <= PAGE_BYTES_MAX) return [whole];
  const parts = [];
  let current = [];
  const base = measure(pageText(page(`${stem}.md`, title, intro, []))) + 200;
  let size = base;
  for (const s of sections) {
    const bytes = measure(s.text) + 1;
    if (current.length > 0 && size + bytes > PAGE_BYTES_MAX) {
      parts.push(current);
      current = [];
      size = base;
    }
    current.push(s);
    size += bytes;
  }
  if (current.length > 0) parts.push(current);
  const used = new Set();
  return parts.map((secs, i) => {
    const n = name(i, secs[0], secs[secs.length - 1]);
    // Two parts may start and end alike (many names under one letter): number the later one.
    const file = used.has(n.stem) ? `${n.stem}-${i + 1}` : n.stem;
    used.add(file);
    return page(`${stem}-${file}.md`, `${title} (${n.title})`, intro, secs);
  });
}

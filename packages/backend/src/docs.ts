/**
 * The manual as the running backend serves it (`GET /api/v1/docs`, MCP's
 * `tl_docs`): the hand-written pages, the generated reference and the
 * deployment page, looked up by topic, section or search.
 *
 * The pages are read once, when the backend starts, from the copy the build
 * put in `dist/docs/` (so an agent reads the manual of the build that runs,
 * even after the checkout or dist/ moved on); a backend started from source
 * without that copy reads the checkout's `docs/`. Nothing here is part of an
 * exported game.
 *
 * Every answer is bounded: a page or section longer than `DOCS_PART_CHARS`
 * comes in parts, and the answer names the call that reads the next one.
 */
import { promises as fsp } from 'node:fs';
import { type IncomingMessage, type ServerResponse } from 'node:http';
import { join } from 'node:path';

/** The most text one answer carries (characters); a longer page or section comes in parts. */
export const DOCS_PART_CHARS = 20_000;
/** The most matches a search answers. */
export const DOCS_QUERY_MAX = 40;

/** One heading of a page: its anchor, title, level and the lines it spans (to the next heading of its level or above). */
export interface DocSection {
  readonly id: string;
  readonly title: string;
  readonly level: number;
  /** First line (its explicit anchor line when it has one, else the heading). */
  readonly start: number;
  /** One past its last line. */
  readonly end: number;
}

/** GitHub's heading anchor: lower case, links and tags reduced to their text, punctuation dropped, spaces to hyphens. */
export function headingSlug(title: string): string {
  return title
    .replace(/`/g, '')
    .replace(/<[^>]+>/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .replace(/\s/g, '-');
}

const ANCHOR_LINE = /^<a id="([^"]+)"><\/a>\s*$/;

/**
 * The sections of a markdown page, in order, and every anchor a link may
 * name. A heading's ids are its explicit `<a id>` (the line before it) and
 * its GitHub slug (repeats numbered as GitHub does); headings inside fenced
 * code are not headings. The manual's link test reads anchors with this, so
 * a link that passes it is a topic tl_docs answers.
 */
export function pageSections(text: string): { sections: DocSection[]; ids: Map<string, number> } {
  const lines = text.split('\n');
  const heads: { title: string; level: number; line: number; anchor: string | null }[] = [];
  let fence = false;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (/^(```|~~~)/.test(line)) fence = !fence;
    if (fence) continue;
    const m = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (m === null) continue;
    const prev = i > 0 ? ANCHOR_LINE.exec(lines[i - 1]!) : null;
    heads.push({ title: m[2]!, level: m[1]!.length, line: i, anchor: prev !== null ? prev[1]! : null });
  }
  const sections: DocSection[] = [];
  const ids = new Map<string, number>();
  const seen = new Map<string, number>();
  heads.forEach((h, n) => {
    let end = lines.length;
    for (let k = n + 1; k < heads.length; k += 1) {
      const next = heads[k]!;
      if (next.level <= h.level) {
        end = next.anchor !== null ? next.line - 1 : next.line;
        break;
      }
    }
    const base = headingSlug(h.title);
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    const slug = count === 0 ? base : `${base}-${count}`;
    const id = h.anchor ?? slug;
    sections.push({ id, title: h.title.replace(/`/g, ''), level: h.level, start: h.anchor !== null ? h.line - 1 : h.line, end });
    for (const key of [id, slug]) if (!ids.has(key)) ids.set(key, sections.length - 1);
  });
  // An anchor inside a section (a table row's) answers with the innermost section holding it.
  lines.forEach((line, i) => {
    for (const m of line.matchAll(/<a id="([^"]+)"><\/a>/g)) {
      if (ids.has(m[1]!)) continue;
      let inner = -1;
      sections.forEach((s, n) => {
        if (s.start <= i && i < s.end) inner = n;
      });
      if (inner >= 0) ids.set(m[1]!, inner);
    }
  });
  return { sections, ids };
}

interface Page {
  readonly key: string;
  readonly title: string;
  readonly text: string;
  readonly lines: string[];
  readonly sections: DocSection[];
  readonly ids: Map<string, number>;
}

export type DocsText = { ok: true; kind: 'contents' | 'page' | 'section'; topic: string; title: string; text: string; part: number; parts: number; next?: { topic: string; part: number }; sections?: { topic: string; title: string }[] };
export type DocsFailure = { ok: false; code: 'docs_topic_not_found' | 'docs_part_out_of_range' | 'docs_request_invalid'; message: string; suggestions?: { topic: string; title: string }[] };
export type DocsAnswer = DocsText | { ok: true; kind: 'query'; query: string; matches: { topic: string; title: string }[]; total: number } | DocsFailure;

/** A topic as an agent may write it: a link path (`../guides/terrain.md#x`), a page key or a reference topic. */
function normalizeTopic(raw: string): string {
  let t = raw.trim();
  t = t.replace(/^(\.\.?\/)+/, '').replace(/^docs\//, '').replace(/^manual\//, '');
  const hash = t.indexOf('#');
  const path = hash < 0 ? t : t.slice(0, hash);
  const anchor = hash < 0 ? '' : t.slice(hash);
  return `${path.replace(/\.md$/, '')}${anchor}`;
}

/** Split text into parts of at most `max` characters, at heading lines where it can, else at line ends. */
function splitParts(lines: string[], max: number): string[] {
  const parts: string[] = [];
  let current: string[] = [];
  let size = 0;
  const flush = (): void => {
    if (current.length > 0) parts.push(current.join('\n'));
    current = [];
    size = 0;
  };
  for (const line of lines) {
    if (line.length > max) {
      flush();
      for (let i = 0; i < line.length; i += max) parts.push(line.slice(i, i + max));
      continue;
    }
    // Start a new part at a heading once the current one is past half full, so parts end at section ends.
    const heading = /^#{1,6}\s/.test(line) || ANCHOR_LINE.test(line);
    if (size + line.length + 1 > max || (heading && size > max / 2)) flush();
    current.push(line);
    size += line.length + 1;
  }
  flush();
  return parts.length === 0 ? [''] : parts;
}

export class Manual {
  private readonly pages = new Map<string, Page>();
  private readonly topics: Record<string, { page: string; section?: string }>;
  /** Where the pages were read from and when. */
  readonly dir: string;

  constructor(files: ReadonlyMap<string, string>, dir: string) {
    this.dir = dir;
    for (const [key, text] of files) {
      if (!key.endsWith('.md')) continue;
      const lines = text.split('\n');
      const { sections, ids } = pageSections(text);
      const first = sections[0];
      const title = first !== undefined && first.level === 1 ? first.title : key;
      const pageKey = key.replace(/\.md$/, '');
      this.pages.set(pageKey, { key: pageKey, title, text, lines, sections, ids });
    }
    let topics: Record<string, { page: string; section?: string }> = {};
    const index = files.get('reference/index.json');
    if (index !== undefined) {
      try {
        topics = (JSON.parse(index) as { topics?: typeof topics }).topics ?? {};
      } catch {
        topics = {};
      }
    }
    this.topics = topics;
  }

  get pageCount(): number {
    return this.pages.size;
  }

  get topicCount(): number {
    return Object.keys(this.topics).length;
  }

  lookup(req: { topic?: string; query?: string; part?: number }): DocsAnswer {
    const part = req.part ?? 1;
    if (!Number.isInteger(part) || part < 1) return { ok: false, code: 'docs_request_invalid', message: 'part must be a whole number from 1' };
    if (req.query !== undefined && req.topic !== undefined) return { ok: false, code: 'docs_request_invalid', message: 'ask for a topic or a query, not both' };
    if (req.query !== undefined) return this.search(req.query);
    if (req.topic === undefined || req.topic.trim() === '' || req.topic.trim() === 'contents') return this.answer('contents', 'contents', 'Contents', this.contents().split('\n'), part);
    const topic = normalizeTopic(req.topic);
    // A reference topic (op.editBlocks, component.light, tool.tl_command …) first, then a page or page#section.
    const ref = this.topics[topic] ?? this.topics[req.topic.trim()];
    const at = ref !== undefined ? { page: `reference/${ref.page.replace(/\.md$/, '')}`, section: ref.section } : { page: topic.split('#')[0]!, section: topic.includes('#') ? topic.slice(topic.indexOf('#') + 1) : undefined };
    const page = this.pages.get(at.page);
    if (page === undefined) return this.notFound(req.topic);
    if (at.section === undefined || at.section === '') {
      const answer = this.answer('page', req.topic.trim(), page.title, page.lines, part);
      if (!answer.ok || answer.parts === 1) return answer;
      // A page in parts lists its sections, so a reader can go straight to one.
      return { ...answer, sections: page.sections.filter((s) => s.level === 2).slice(0, 200).map((s) => ({ topic: `${page.key}#${s.id}`, title: s.title })) };
    }
    const n = page.ids.get(at.section);
    if (n === undefined) return this.notFound(req.topic);
    const s = page.sections[n]!;
    return this.answer('section', req.topic.trim(), s.title, page.lines.slice(s.start, s.end), part);
  }

  private answer(kind: 'contents' | 'page' | 'section', topic: string, title: string, lines: string[], part: number): DocsText | DocsFailure {
    const parts = splitParts(lines, DOCS_PART_CHARS);
    if (part > parts.length) return { ok: false, code: 'docs_part_out_of_range', message: `"${topic}" has ${parts.length} part(s)` };
    return {
      ok: true,
      kind,
      topic,
      title,
      text: parts[part - 1]!,
      part,
      parts: parts.length,
      ...(part < parts.length ? { next: { topic, part: part + 1 } } : {}),
    };
  }

  private notFound(topic: string): DocsAnswer {
    const words = topic.replace(/[#./_-]+/g, ' ');
    const suggestions = this.matches(words).slice(0, 10);
    return { ok: false, code: 'docs_topic_not_found', message: `no page, section or reference topic "${topic}"; search with query, or read the contents (no topic)`, ...(suggestions.length > 0 ? { suggestions } : {}) };
  }

  /** The manual's contents page and how the reference's topics are named. */
  private contents(): string {
    const index = this.pages.get('index')?.text ?? '# Thirdlight manual\n';
    const kinds = new Map<string, string[]>();
    for (const key of Object.keys(this.topics)) {
      const kind = key.split('.')[0]!;
      const list = kinds.get(kind) ?? [];
      list.push(key);
      kinds.set(kind, list);
    }
    const rows = [...kinds.entries()]
      .sort((a, b) => b[1].length - a[1].length)
      .map(([kind, keys]) => `- \`${kind}.…\` (${keys.length}), e.g. ${keys.slice(0, 3).map((k) => `\`${k}\``).join(', ')}`);
    return (
      `${index.replace(/\n+$/, '')}\n\n` +
      '## Reading this manual through tl_docs\n\n' +
      'A page is its path without `.md` (`guides/terrain`, `concepts/game-flow`, `reference/ops`, `deployment`); ' +
      'a section is `page#anchor`, and a link in a page (`../guides/terrain.md#sculpting`) works as a topic as it is. ' +
      'A long page or section comes in parts: the answer names the next part. Search with `query` for topic names.\n\n' +
      '## Reference topics\n\n' +
      `The generated reference answers these lookup keys (${Object.keys(this.topics).length} in all):\n\n` +
      `${rows.join('\n')}\n`
    );
  }

  /** Candidates whose key or title holds every word, best first: exact key, key prefix, key, title. */
  private matches(query: string): { topic: string; title: string }[] {
    const words = query.toLowerCase().split(/\s+/).filter((w) => w.length > 0);
    if (words.length === 0) return [];
    const q = query.trim().toLowerCase();
    const ranked: { topic: string; title: string; rank: number }[] = [];
    const consider = (topic: string, title: string): void => {
      const key = topic.toLowerCase();
      const hay = `${key} ${title.toLowerCase()}`;
      if (!words.every((w) => hay.includes(w))) return;
      const rank = key === q ? 0 : key.endsWith(`.${q}`) || key.startsWith(q) ? 1 : words.every((w) => key.includes(w)) ? 2 : 3;
      ranked.push({ topic, title, rank });
    };
    const refSection = (page: string, section: string | undefined): string => {
      const p = this.pages.get(`reference/${page.replace(/\.md$/, '')}`);
      if (p === undefined) return page;
      if (section === undefined) return p.title;
      const n = p.ids.get(section);
      return n === undefined ? p.title : p.sections[n]!.title;
    };
    for (const [topic, at] of Object.entries(this.topics)) consider(topic, refSection(at.page, at.section));
    for (const page of this.pages.values()) {
      if (page.key.startsWith('reference/')) continue;
      consider(page.key, page.title);
      for (const s of page.sections) if (s.level > 1) consider(`${page.key}#${s.id}`, `${page.title}: ${s.title}`);
    }
    ranked.sort((a, b) => a.rank - b.rank || a.topic.length - b.topic.length || (a.topic < b.topic ? -1 : 1));
    return ranked.map(({ topic, title }) => ({ topic, title }));
  }

  private search(query: string): DocsAnswer {
    if (query.trim() === '') return { ok: false, code: 'docs_request_invalid', message: 'query is empty' };
    let found = this.matches(query);
    if (found.length === 0) {
      // Nothing is named so: the hand-written sections whose text holds every word.
      const words = query.toLowerCase().split(/\s+/).filter((w) => w.length > 0);
      found = [];
      for (const page of this.pages.values()) {
        if (page.key.startsWith('reference/')) continue;
        for (const s of page.sections) {
          const own = page.lines.slice(s.start, s.end).join('\n').toLowerCase();
          if (words.every((w) => own.includes(w)) && s.level > 1) found.push({ topic: `${page.key}#${s.id}`, title: `${page.title}: ${s.title}` });
        }
      }
    }
    return { ok: true, kind: 'query', query, matches: found.slice(0, DOCS_QUERY_MAX), total: found.length };
  }
}

async function markdownFiles(dir: string, prefix: string, out: Map<string, string>): Promise<void> {
  for (const entry of await fsp.readdir(dir, { withFileTypes: true })) {
    const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) await markdownFiles(join(dir, entry.name), rel, out);
    else if (entry.name.endsWith('.md') || rel === 'reference/index.json') out.set(rel, await fsp.readFile(join(dir, entry.name), 'utf8'));
  }
}

/**
 * The manual under the first of `docsDirs` that has one (`<dir>/manual/` and
 * `<dir>/deployment.md`), or null when none has.
 */
export async function loadManual(docsDirs: readonly string[]): Promise<Manual | null> {
  for (const dir of docsDirs) {
    const files = new Map<string, string>();
    try {
      await markdownFiles(join(dir, 'manual'), '', files);
    } catch {
      continue;
    }
    if (!files.has('index.md')) continue;
    try {
      files.set('deployment.md', await fsp.readFile(join(dir, 'deployment.md'), 'utf8'));
    } catch {
      // A manual without the deployment page still answers its own pages.
    }
    return new Manual(files, dir);
  }
  return null;
}

export interface DocsRouteContext {
  /** The manual this process read at start (null: none found). */
  readonly manual: Promise<Manual | null>;
  readonly authorized: (req: IncomingMessage) => boolean;
  readonly sendJson: (res: ServerResponse, status: number, body: unknown) => void;
}

/** `GET /api/v1/docs?topic=…|query=…&part=n` — any valid token (the manual is the engine's, not a project's). */
export function makeDocsRoute(ctx: DocsRouteContext) {
  return async (req: IncomingMessage, res: ServerResponse, query: ReadonlyMap<string, string>): Promise<void> => {
    if (req.method !== 'GET') {
      ctx.sendJson(res, 405, { ok: false, error: { code: 'invalid_request', cls: 'validation', message: 'method not allowed', expected: 'GET' } });
      return;
    }
    if (!ctx.authorized(req)) {
      ctx.sendJson(res, 401, { ok: false, error: { code: 'unauthorized', cls: 'validation', message: 'a valid bearer token is required' } });
      return;
    }
    const manual = await ctx.manual;
    if (manual === null) {
      ctx.sendJson(res, 503, { ok: false, error: { code: 'docs_unavailable', cls: 'unavailable', message: 'this backend found no manual (dist/docs/ from the build, or the checkout\'s docs/)' } });
      return;
    }
    const partRaw = query.get('part');
    const topic = query.get('topic');
    const q = query.get('query');
    const answer = manual.lookup({ ...(topic !== undefined ? { topic } : {}), ...(q !== undefined ? { query: q } : {}), ...(partRaw !== undefined ? { part: Number(partRaw) } : {}) });
    if (answer.ok) {
      ctx.sendJson(res, 200, answer);
      return;
    }
    const { code, message, ...rest } = answer;
    ctx.sendJson(res, code === 'docs_topic_not_found' ? 404 : 400, { ok: false, error: { code, cls: code === 'docs_topic_not_found' ? 'not_found' : 'validation', message, ...rest } });
  };
}

/** What `GET /api/v1/engine` says about the manual: where it was read from and its size, once read. */
export async function manualSummary(manual: Promise<Manual | null>): Promise<{ dir: string; pages: number; topics: number } | null> {
  const m = await manual;
  return m === null ? null : { dir: m.dir, pages: m.pageCount, topics: m.topicCount };
}

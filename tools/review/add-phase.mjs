#!/usr/bin/env node
/**
 * The owner's review page: one short section a phase, the phase being worked on and the one before it, nothing
 * else. Each section has a fixed form the owner answers with yes or no: what changed, the pictures with the
 * agent's read, what is wrong, the numbers, the questions. Adding a third phase drops the oldest from the page and
 * deletes its folder under the review root, so the page and the disk behind it never grow.
 *
 *   node tools/review/add-phase.mjs <phase> [--title "<title>"] [--acceptance <file.md>] [--pictures <pack dir>] [--root <dir>]
 *
 * The review root (default ~/.cache/thirdlight-owner-review) holds `phases.json` (the kept phases, oldest first),
 * one folder a phase (`<phase>/acceptance.txt` (served as plain text), `<phase>/pictures/…`, copies: the drop never reaches outside the
 * root), and the rendered `review.html` (also `index.html`). Static files with relative links only, so
 * `python3 -m http.server` serves it. The acceptance file's form is in docs/pictures.md ("The review page").
 */
import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** How many phases the page shows: the one being worked on and the one before it (the owner's choice). */
export const KEPT_PHASES = 2;
/** At most this many lines of "What changed" and this many questions: the section must stay a quick yes or no. */
export const MAX_CHANGED_LINES = 5;
export const MAX_QUESTIONS = 5;

export const DEFAULT_ROOT = join(homedir(), '.cache', 'thirdlight-owner-review');
const STATE_FILE = 'phases.json';
const PAGE_FILES = ['review.html', 'index.html'];
const IMAGE_EXT = /\.(png|jpe?g|webp|gif)$/i;
/** The pack's text files the page reads; everything else in a pack (its raw folder, logs) stays where it is. */
const PACK_TEXT = ['read.md', 'pictures.json', 'perf-report.md', 'README.md'];
/** A phase id is a folder name in the root: lower-case letters, digits, dots and dashes, never a path. */
const PHASE_ID = /^[0-9a-z][0-9a-z.-]{0,31}$/;
const NOT_PROVIDED = 'not provided';

// ---------------------------------------------------------------------------------------------------------------
// Parsing the pack's texts

/** Splits markdown into its `## ` sections: { heading (lower case, trimmed) → body lines }; the `# ` line apart. */
function sections(md) {
  const out = new Map();
  let title = null;
  let current = null;
  for (const line of md.split(/\r?\n/)) {
    const h1 = /^# (.+)$/.exec(line);
    const h2 = /^## (.+)$/.exec(line);
    if (h1 && title === null && current === null) title = h1[1].trim();
    else if (h2) {
      current = h2[1].trim().toLowerCase();
      if (!out.has(current)) out.set(current, []);
    } else if (current !== null) out.get(current).push(line);
  }
  return { title, sections: out };
}

/** The list items of a section: `- x` / `* x` / `1. x`, with indented continuation lines joined on. */
function listItems(lines) {
  const items = [];
  for (const line of lines) {
    const item = /^\s{0,1}(?:[-*]|\d+[.)])\s+(.*)$/.exec(line);
    if (item) items.push(item[1].trim());
    else if (line.trim() !== '' && items.length > 0 && /^\s+/.test(line)) items[items.length - 1] += ` ${line.trim()}`;
  }
  return items;
}

/**
 * The acceptance file: `# <title>`, then `## What changed` (at most five list lines), `## What is wrong`,
 * `## Numbers` (list lines each), `## Questions` (numbered, at most five, each with `Default: …` and optionally
 * `Answer: …`). Other sections are the full text and only linked. A missing section is null ("not provided");
 * a contract broken (too many lines, a question without its default) is an error, so the lead fixes the file.
 */
export function parseAcceptance(md) {
  const { title, sections: s } = sections(md);
  const list = (name) => (s.has(name) ? listItems(s.get(name)) : null);
  const changed = list('what changed');
  const errors = [];
  if (changed && changed.length > MAX_CHANGED_LINES) errors.push(`"What changed" has ${changed.length} lines; at most ${MAX_CHANGED_LINES}`);
  let questions = null;
  if (s.has('questions')) {
    questions = listItems(s.get('questions')).map((text, i) => {
      const plain = text.replace(/\*\*/g, '');
      const d = /\bDefault:\s*/i.exec(plain);
      const a = /\bAnswer(?:ed)?:\s*/i.exec(plain);
      if (!d) errors.push(`question ${i + 1} has no "Default:"`);
      const ask = plain.slice(0, d ? d.index : a ? a.index : plain.length).trim();
      const dflt = d ? plain.slice(d.index + d[0].length, a && a.index > d.index ? a.index : plain.length).trim() : null;
      const answer = a ? plain.slice(a.index + a[0].length, d && d.index > a.index ? d.index : plain.length).trim() : null;
      return { n: i + 1, ask, default: dflt, answer };
    });
    if (questions.length > MAX_QUESTIONS) errors.push(`${questions.length} questions; at most ${MAX_QUESTIONS}`);
  }
  return { title, changed, wrong: list('what is wrong'), numbers: list('numbers'), questions, errors };
}

/** A read field that was never filled (the skeleton's "TO WRITE", or empty) counts as not provided. */
const filled = (v) => (v && !/^TO WRITE$/i.test(v.trim()) ? v.trim() : null);

/**
 * The agent's read (docs/pictures.md): a summary of numbered lines before the first `## `, then one block a
 * picture, `## <id> — <title>` with `Sees:`, `Wrong:`, `Sure:` (a field runs on until the next field or block).
 */
export function parseRead(md) {
  const summary = [];
  const pictures = new Map();
  let block = null;
  let field = null;
  for (const line of md.split(/\r?\n/)) {
    const head = /^## (\S+)\s+[—-]\s+(.*)$/.exec(line);
    if (head) {
      block = { id: head[1], title: head[2].trim(), sees: null, wrong: null, sure: null };
      pictures.set(block.id, block);
      field = null;
      continue;
    }
    if (block === null) {
      const item = /^\s*\d+[.)]\s+(.*)$/.exec(line);
      if (item) summary.push(item[1].trim());
      continue;
    }
    const f = /^(Sees|Wrong|Sure):\s*(.*)$/.exec(line);
    if (f) {
      field = f[1].toLowerCase();
      block[field] = f[2];
    } else if (field && /^\s+\S/.test(line)) block[field] += ` ${line.trim()}`;
    else if (line.trim() !== '') field = null;
  }
  for (const b of pictures.values()) for (const k of ['sees', 'wrong', 'sure']) b[k] = filled(b[k]);
  return { summary, pictures };
}

/** A read says something is wrong unless its Wrong line is missing or starts "nothing seen". */
export const readsWrong = (read) => Boolean(read && read.wrong && !/^nothing seen\b/i.test(read.wrong));

/**
 * The pictures of a pack in the page's order: those whose read says something is wrong, or that did not settle,
 * first; each group in the list's own order. Without `pictures.json` the pack's image files are listed by name.
 */
export function packPictures(packDir) {
  const read = existsSync(join(packDir, 'read.md')) ? parseRead(readFileSync(join(packDir, 'read.md'), 'utf8')) : null;
  let listed;
  if (existsSync(join(packDir, 'pictures.json'))) {
    const json = JSON.parse(readFileSync(join(packDir, 'pictures.json'), 'utf8'));
    listed = (json.pictures ?? []).map((p) => ({ id: p.id ?? null, title: p.title ?? p.file, file: p.file, settled: p.settled !== false, settle: p.settle ?? null }));
  } else {
    listed = readdirSync(packDir).filter((f) => IMAGE_EXT.test(f)).sort().map((f) => ({ id: null, title: f, file: f, settled: true, settle: null }));
  }
  const pics = listed.map((p) => {
    const r = (p.id && read?.pictures.get(p.id)) || null;
    return { ...p, read: r, wrong: readsWrong(r) || !p.settled };
  });
  return [...pics.filter((p) => p.wrong), ...pics.filter((p) => !p.wrong)];
}

/** The markdown table lines of the perf report, as rows of cells (the header's separator row left out). */
export function perfTable(md) {
  return md
    .split(/\r?\n/)
    .filter((l) => /^\s*\|.*\|\s*$/.test(l) && !/^\s*\|[\s|:-]+\|\s*$/.test(l))
    .map((l) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim()));
}

// ---------------------------------------------------------------------------------------------------------------
// The root: state, copies, the drop

/** True when `p` names something strictly inside `root` (by real path of its parent: a link's target is not followed). */
export function insideRoot(root, p) {
  const realRoot = realpathSync(root);
  const parent = existsSync(dirname(p)) ? realpathSync(dirname(p)) : null;
  if (parent === null) return false;
  const rel = relative(realRoot, join(parent, basename(p)));
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

/** Bytes under a path, not following links (a link counts as itself). */
function bytesUnder(p) {
  const st = lstatSync(p);
  if (!st.isDirectory()) return st.size;
  let n = 0;
  for (const e of readdirSync(p)) n += bytesUnder(join(p, e));
  return n;
}

/**
 * Deletes a dropped phase's folder `<root>/<id>`, and only that: an id that is not a plain folder name, or a path
 * that is not inside the root, is refused; a link there is removed as a link, its target untouched.
 * Returns the bytes freed (0 when nothing was there).
 */
export function dropPhaseFolder(root, id) {
  if (!PHASE_ID.test(id)) throw new Error(`refused to delete "${id}": not a phase id`);
  const p = join(root, id);
  if (!existsSync(p) && !isLink(p)) return 0;
  if (!insideRoot(root, p)) throw new Error(`refused to delete ${p}: not inside ${root}`);
  const bytes = bytesUnder(p);
  if (isLink(p)) unlinkSync(p);
  else rmSync(p, { recursive: true, force: true });
  return bytes;
}

function isLink(p) {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

export function readState(root) {
  const f = join(root, STATE_FILE);
  return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : { phases: [] };
}

/** Copies a pack's pictures and its text files (flat; subfolders such as the raw output are left behind). */
function copyPack(src, dst) {
  if (existsSync(dst)) rmSync(dst, { recursive: true, force: true });
  mkdirSync(dst, { recursive: true });
  let n = 0;
  for (const f of readdirSync(src)) {
    const from = join(src, f);
    if (!lstatSync(from).isFile() && !lstatSync(from).isSymbolicLink()) continue;
    if (IMAGE_EXT.test(f) || PACK_TEXT.includes(f)) {
      copyFileSync(from, join(dst, f));
      n += 1;
    }
  }
  return n;
}

const writeAtomic = (file, text) => {
  writeFileSync(`${file}.tmp`, text);
  renameSync(`${file}.tmp`, file);
};

/**
 * Adds or updates one phase's section, drops phases past the kept count (deleting their folders under the root),
 * and renders the page. Returns { phases, dropped: [{ id, bytes }] }.
 */
export function addPhase({ root = DEFAULT_ROOT, id, title, acceptance, pictures, now = new Date() }) {
  if (!PHASE_ID.test(id)) throw new Error(`phase id "${id}": lower-case letters, digits, dots and dashes`);
  mkdirSync(root, { recursive: true });
  if (acceptance) {
    const parsed = parseAcceptance(readFileSync(acceptance, 'utf8'));
    if (parsed.errors.length) throw new Error(`${acceptance}: ${parsed.errors.join('; ')} (the form: docs/pictures.md)`);
  }
  if (pictures && !existsSync(pictures)) throw new Error(`no pack at ${pictures}`);
  const state = readState(root);
  let entry = state.phases.find((p) => p.id === id);
  if (!entry) {
    entry = { id, title: title ?? null, added: now.toISOString() };
    state.phases.push(entry);
  }
  const dir = join(root, id);
  mkdirSync(dir, { recursive: true });
  if (acceptance) copyFileSync(acceptance, join(dir, 'acceptance.txt'));
  if (pictures) copyPack(pictures, join(dir, 'pictures'));
  // An explicit title wins; else a newly given acceptance text names the section (its `# ` line).
  if (title) entry.title = title;
  else if (acceptance) entry.title = parseAcceptance(readFileSync(acceptance, 'utf8')).title ?? entry.title;
  const dropped = [];
  while (state.phases.length > KEPT_PHASES) {
    const old = state.phases.shift();
    dropped.push({ id: old.id, bytes: dropPhaseFolder(root, old.id) });
  }
  writeAtomic(join(root, STATE_FILE), `${JSON.stringify(state, null, 1)}\n`);
  const html = renderPage(root, state.phases);
  for (const f of PAGE_FILES) writeAtomic(join(root, f), html);
  return { phases: state.phases.map((p) => p.id), dropped };
}

// ---------------------------------------------------------------------------------------------------------------
// The page

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
/** Escaped text with markdown's `code` and **bold** kept as such; nothing else is interpreted. */
const inline = (s) =>
  esc(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
const enc = (p) => p.split('/').map(encodeURIComponent).join('/');
const missing = `<p class="none">${NOT_PROVIDED}</p>`;
const ul = (items) => (items && items.length ? `<ul>${items.map((i) => `<li>${inline(i)}</li>`).join('')}</ul>` : missing);

function pictureCard(id, p) {
  const src = enc(`${id}/pictures/${p.file}`);
  const r = p.read;
  const label = p.id ? `${esc(p.id)} — ${esc(p.title)}` : esc(p.title);
  const flag = p.wrong ? `<span class="flag">${p.settled ? 'wrong' : 'did not settle'}</span> ` : '';
  const line = (k, v) => `<p><b>${k}</b> ${v ? inline(v) : `<span class="none">${NOT_PROVIDED}</span>`}</p>`;
  return `<figure class="${p.wrong ? 'bad' : ''}"><a href="${src}"><img loading="lazy" decoding="async" src="${src}" alt="${esc(p.title)}"></a>
<figcaption><p class="t">${flag}${label}</p>${line('Sees', r?.sees)}${line('Wrong', r?.wrong)}${line('Sure', r?.sure)}</figcaption></figure>`;
}

function renderSection(root, phase, role) {
  const dir = join(root, phase.id);
  const accFile = join(dir, 'acceptance.txt');
  const packDir = join(dir, 'pictures');
  const acc = existsSync(accFile) ? parseAcceptance(readFileSync(accFile, 'utf8')) : null;
  const hasPack = existsSync(packDir);
  const pics = hasPack ? packPictures(packDir) : [];
  const read = hasPack && existsSync(join(packDir, 'read.md')) ? parseRead(readFileSync(join(packDir, 'read.md'), 'utf8')) : null;
  const perf = hasPack && existsSync(join(packDir, 'perf-report.md')) ? perfTable(readFileSync(join(packDir, 'perf-report.md'), 'utf8')) : [];
  const run = hasPack && existsSync(join(packDir, 'pictures.json')) ? JSON.parse(readFileSync(join(packDir, 'pictures.json'), 'utf8')) : null;

  const wrongCount = pics.filter((p) => p.wrong).length;
  const picturesHtml = hasPack
    ? `<p class="sub">${pics.length} pictures${read ? `, ${wrongCount} with something wrong in the read (first, marked)` : ', no read provided'}.</p><div class="grid">${pics.map((p) => pictureCard(phase.id, p)).join('\n')}</div>`
    : missing;

  const wrongParts = [];
  if (read && read.summary.length) wrongParts.push(`<p class="sub">The read's summary</p>${ul(read.summary)}`);
  if (acc && acc.wrong) wrongParts.push(`<p class="sub">From the acceptance text</p>${ul(acc.wrong)}`);

  const numbers = [];
  if (perf.length) {
    const [head, ...rows] = perf;
    numbers.push(`<p class="sub">Performance, recorded, never a gate</p><div class="scroll"><table><tr>${head.map((c) => `<th>${inline(c)}</th>`).join('')}</tr>${rows.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`).join('')}</table></div>`);
  }
  if (run && run.seconds != null) numbers.push(`<p>Picture run: ${esc(run.seconds)} s at ${esc(run.commit ?? '?')}.</p>`);
  if (acc && acc.numbers) numbers.push(ul(acc.numbers));

  const questions = acc && acc.questions && acc.questions.length
    ? `<ol class="q">${acc.questions.map((q) => `<li><p>${inline(q.ask)}</p><p class="d"><b>Default:</b> ${q.default ? inline(q.default) : NOT_PROVIDED}</p>${q.answer ? `<p class="a"><b>Answered:</b> ${inline(q.answer)}</p>` : ''}</li>`).join('')}</ol>`
    : missing;

  const full = existsSync(accFile) ? ` <a class="full" href="${enc(`${phase.id}/acceptance.txt`)}">full text</a>` : '';
  return `<section id="${esc(phase.id)}"><h2><span class="role">${role}</span> ${esc(phase.title ?? phase.id)}${full}</h2>
<h3>What changed</h3>${acc ? ul(acc.changed) : missing}
<h3>Pictures</h3>${picturesHtml}
<h3>What is wrong</h3>${wrongParts.length ? wrongParts.join('') : missing}
<h3>Numbers</h3>${numbers.length ? numbers.join('') : missing}
<h3>Questions</h3>${questions}
</section>`;
}

const STYLE = `:root{--bg:#fbfbfa;--fg:#1d1f22;--mute:#666b73;--line:#dcdde0;--card:#fff;--bad:#b3261e;--badbg:#fdecea;--link:#0b57d0;color-scheme:light}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--bg:#15171a;--fg:#e4e5e7;--mute:#9aa0a8;--line:#30343a;--card:#1d2024;--bad:#ff8a80;--badbg:#3a1d1b;--link:#8ab4f8;color-scheme:dark}}
:root[data-theme="dark"]{--bg:#15171a;--fg:#e4e5e7;--mute:#9aa0a8;--line:#30343a;--card:#1d2024;--bad:#ff8a80;--badbg:#3a1d1b;--link:#8ab4f8;color-scheme:dark}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.45 system-ui,sans-serif}
main{max-width:1200px;margin:0 auto;padding:12px 16px 48px}nav{display:flex;gap:16px;flex-wrap:wrap;font-size:14px}a{color:var(--link)}
section{border-top:2px solid var(--line);margin-top:20px;padding-top:4px}h2{font-size:20px;margin:12px 0 4px}h3{font-size:16px;margin:18px 0 6px}
.role{font-size:12px;text-transform:uppercase;letter-spacing:.05em;color:var(--mute);display:block}.full{font-size:13px;font-weight:normal;margin-left:8px}
ul,ol{margin:4px 0;padding-left:22px}li{margin:3px 0}.sub{color:var(--mute);font-size:13px;margin:6px 0 2px}.none{color:var(--mute);font-style:italic}
code{font:13px ui-monospace,monospace}.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(100%,280px),1fr));gap:12px}
figure{margin:0;background:var(--card);border:1px solid var(--line);border-radius:6px;overflow:hidden}figure.bad{border-color:var(--bad)}
figure img{display:block;width:100%;height:auto;aspect-ratio:16/9;object-fit:cover;background:var(--line)}figcaption{padding:6px 10px 8px;font-size:13px}
figcaption p{margin:3px 0}.t{font-weight:600}.flag{color:var(--bad);background:var(--badbg);border-radius:3px;padding:0 5px;font-size:12px;font-weight:600}
.scroll{overflow-x:auto}table{border-collapse:collapse;font-size:13px}td,th{border:1px solid var(--line);padding:3px 8px;text-align:left}
ol.q>li{margin:8px 0}ol.q p{margin:2px 0}.d,.a{font-size:14px}.a{color:var(--mute)}`;

/** The whole page: the kept phases, newest first. */
export function renderPage(root, phases) {
  const newestFirst = [...phases].reverse();
  const roles = ['Being worked on', 'The phase before'];
  const nav = newestFirst.map((p) => `<a href="#${esc(p.id)}">${esc(p.title ?? p.id)}</a>`).join('');
  const body = newestFirst.length ? newestFirst.map((p, i) => renderSection(root, p, roles[i] ?? 'Older')).join('\n') : missing;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Owner review</title><style>${STYLE}</style></head>
<body><main><nav>${nav}</nav>
${body}
</main></body></html>
`;
}

// ---------------------------------------------------------------------------------------------------------------
// Command line

const USAGE = 'usage: node tools/review/add-phase.mjs <phase> [--title "<title>"] [--acceptance <file.md>] [--pictures <pack dir>] [--root <dir>]';

export function parseArgs(argv) {
  const out = { root: DEFAULT_ROOT };
  const rest = [];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const key = { '--title': 'title', '--acceptance': 'acceptance', '--pictures': 'pictures', '--root': 'root' }[a];
    if (key) {
      if (argv[i + 1] === undefined) throw new Error(`${a} needs a value\n${USAGE}`);
      out[key] = key === 'title' ? argv[i + 1] : resolve(argv[i + 1]);
      i += 1;
    } else if (a.startsWith('--')) throw new Error(`unknown option ${a}\n${USAGE}`);
    else rest.push(a);
  }
  if (rest.length !== 1) throw new Error(USAGE);
  out.id = rest[0];
  return out;
}

const isMain = process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
if (isMain) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const r = addPhase(args);
    for (const d of r.dropped) console.log(`dropped ${d.id}: deleted ${join(args.root, d.id)}, ${(d.bytes / 1e6).toFixed(1)} MB freed`);
    console.log(`review page: ${r.phases.slice().reverse().join(', ')} (${join(args.root, 'review.html')})`);
  } catch (e) {
    console.error(e instanceof Error ? e.message : e);
    process.exit(2);
  }
}

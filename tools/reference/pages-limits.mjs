/**
 * The engine's limits and defaults: every exported constant whose name says
 * it is one (`MAX_…`, `…_LIMITS`, `…_DEFAULT`, `…_CAP`, `…_BUDGET`…), listed
 * once under the package and file that define it, with its value as the
 * running build has it and its doc comment.
 */
import { code, json, page, section, slug, splitPages, table } from './markdown.mjs';

const LIMIT_NAME = /(^|_)(MAX|MIN|LIMITS?|DEFAULTS?|CAP|BUDGETS?)(_|$)/;

function plainJson(v) {
  if (v === null || ['number', 'string', 'boolean'].includes(typeof v)) return true;
  if (Array.isArray(v)) return v.every(plainJson);
  if (typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype) return Object.values(v).every(plainJson);
  return false;
}

export function limitPages(values, owners) {
  const byFile = new Map();
  for (const [name, o] of owners) {
    if (!LIMIT_NAME.test(name)) continue;
    const ns = values[o.pkg];
    if (ns === undefined || !(name in ns) || !plainJson(ns[name])) continue;
    const list = byFile.get(o.file) ?? [];
    list.push({ name, value: ns[name], doc: o.doc });
    byFile.set(o.file, list);
  }
  const files = [...byFile.keys()].sort((a, b) => a.localeCompare(b));
  const pkgs = [...new Set(files.map((f) => f.split('/')[1]))];
  const pages = [];
  const overview = [];
  for (const pkg of pkgs) {
    const sections = files
      .filter((f) => f.split('/')[1] === pkg)
      .map((f) => {
        const rows = byFile
          .get(f)
          .sort((a, b) => a.name.localeCompare(b.name))
          .map((c) => [`<a id="limit-${slug(c.name)}"></a>${code(c.name)}`, json(c.value), c.doc.replace(/\s+/g, ' ')]);
        const stem = f.split('/').pop().replace(/\.ts$/, '');
        return section(`limits-${pkg}--${slug(stem)}`, code(f.split('/').slice(3).join('/')), table(['Constant', 'Value', 'What it is'], rows), { topics: byFile.get(f).map((c) => `limit.${c.name}`) });
      });
    const parts = splitPages(`limits-${pkg}`, `Limits and defaults: ${pkg}`, `The limits and defaults ${code(`@thirdlight/${pkg}`)} defines, by source file. Values are the running build's.`, sections, (i, first) => ({ stem: String(i + 1), title: `part ${i + 1}, from ${first.title}` }));
    pages.push(...parts);
    overview.push(`- ${code(`@thirdlight/${pkg}`)}: ${parts.map((p) => `[${p.title}](${p.file})`).join(', ')}`);
  }
  pages.unshift(
    page('limits.md', 'Limits and defaults', 'Every engine limit and default the packages export, each defined once in the package that owns it. Values are the running build\'s.', [section('limits-index', 'By package', overview.join('\n'), { topics: ['limits'] })]),
  );
  return pages;
}

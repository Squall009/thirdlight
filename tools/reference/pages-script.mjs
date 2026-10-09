/**
 * Reference pages for the script API: what a script exports
 * (`BehaviorSpec`), every `ctx.*` member a step receives with its doc
 * comment, and the declarations they reach — the same model the script
 * editor's typings come from (tools/gen-behavior-api.mjs).
 */
import { code, fence, page, ref, section, slug, splitPages, table } from './markdown.mjs';

const declId = (name) => `script-type-${slug(name)}`;

function firstSentence(doc) {
  const para = (doc ?? '').split('\n\n')[0].replace(/\s+/g, ' ').trim();
  const m = /^(.+?[.!?])(\s|$)/.exec(para);
  return m === null ? para : m[1];
}

export function scriptPages({ declarations, table: members }) {
  const declared = new Set(declarations.map((d) => d.name));
  const typeLink = (key) => (key !== undefined && declared.has(key) ? ref(declId(key), code(key)) : key === undefined ? '' : code(key));
  const memberRows = (list, prefix) =>
    list.map((m) => [code(`${prefix}${m.name}${m.optional === true ? '?' : ''}`), m.kind, code(m.detail), typeLink(m.type ?? m.returns), firstSentence(m.doc)]);
  const memberDocs = (list, prefix) =>
    list
      .filter((m) => (m.doc ?? '') !== '')
      .map((m) => `<a id="ctx-${slug(m.name)}"></a>**${code(`${prefix}${m.name}`)}** — ${m.doc}`)
      .join('\n\n');

  const ctx = members['BehaviorContext'] ?? [];
  const spec = members['BehaviorSpec'] ?? [];
  const header = ['Member', 'Kind', 'Type', 'Its type', 'Summary'];
  const sections = [
    section('script-spec', 'What a script exports', `A script's default export is a \`BehaviorSpec\`: its callbacks receive the object's state and the context \`ctx\`.\n\n${table(header, memberRows(spec, ''))}`, { topics: ['script.spec'] }),
    section('ctx', 'The context (`ctx`)', `What \`step(state, ctx)\` and the other callbacks receive. A member's own page section has its full declaration.\n\n${table(header, memberRows(ctx, 'ctx.'))}`, { topics: ['ctx'] }),
    section('ctx-docs', 'Context members in full', memberDocs(ctx, 'ctx.'), { topics: ctx.map((m) => `ctx.${m.name}`) }),
  ];
  for (const name of ['BehaviorPrepareConfig', 'BehaviorInstanceInfo']) {
    if (members[name] !== undefined) sections.push(section(`script-${slug(name)}`, code(name), table(header, memberRows(members[name], ''))));
  }
  const pages = [page('script-api.md', 'Script API', 'The API a script (a behavior) is written against: `import type { BehaviorContext } from \'@thirdlight/runtime\'`. Generated from the runtime\'s types; the script editor completes and checks the same declarations.', sections)];

  const declSections = declarations.map((d) => section(declId(d.name), code(d.name), fence(d.text, 'ts'), { level: 2, topics: [`script-type.${d.name}`] }));
  pages.push(...splitPages('script-types', 'Script API types', 'Every declaration the script API reaches, as the runtime declares it (doc comments included), in the order the API reaches them.', declSections, (i, first) => ({ stem: slug(first.id.slice('script-type-'.length)), title: `from ${first.title}` })));
  return pages;
}

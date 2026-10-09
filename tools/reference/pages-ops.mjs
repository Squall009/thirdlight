/**
 * Reference pages for the command ops: every op the validator accepts
 * (`MUTATION_OPS`), its request arguments as the validator's per-op union
 * types them and the content block it writes; and the type pages: the
 * declarations those argument shapes and the descriptors' JSON shapes name.
 */
import { code, fence, page, ref, section, splitPages, table, typeId } from './markdown.mjs';

export function opPages(ops, types, mutationOps, descriptors, envelope) {
  const writes = new Map();
  for (const b of descriptors.content) for (const op of b.ops) writes.set(op, [...(writes.get(op) ?? []), b.key]);
  const sorted = [...mutationOps].sort((a, b) => a.localeCompare(b));

  const opSection = (op) => {
    const o = ops[op];
    const lines = [];
    const w = writes.get(op);
    if (w !== undefined) lines.push(`Writes: ${w.map((k) => ref(`content-${k}`, code(`content.${k}`))).join(', ')}.`, '');
    lines.push('Arguments (`args`):', '');
    // A named argument type prints whole, its doc comment included; an inline shape as written.
    lines.push(fence(o.argsName !== undefined && types.has(o.argsName) ? types.get(o.argsName).text : o.argsText, 'ts'));
    const named = o.types.filter((t) => t !== o.argsName && types.has(t));
    if (named.length > 0) lines.push(`Types: ${named.map((t) => ref(typeId(t), code(t))).join(', ')}.`);
    return section(`op-${op}`, op, lines.join('\n'), { topics: [`op.${op}`] });
  };

  const summary = table(
    ['Op', 'Arguments', 'Writes'],
    sorted.map((op) => [ref(`op-${op}`, code(op)), ops[op].argsName ?? ops[op].argsText.replace(/\s+/g, ' ').slice(0, 120), (writes.get(op) ?? []).map((k) => code(k)).join(', ')]),
  );
  const pages = [
    page('ops.md', 'Command ops', 'Every edit of a project is a command (the one mutation path; the editor and MCP send the same ops). A request names its `op`, the project, the revision it expects and its `args`; the backend validates it strictly (an unknown field is refused) and answers with the new revision and the change, or an error naming the field.', [
      section('op-request', 'The request', `${fence(envelope.request, 'ts')}\nResults:\n\n${fence(envelope.results, 'ts')}`, { topics: ['ops.request'] }),
      section('op-index', 'Every op', summary, { topics: ['ops'] }),
    ]),
  ];
  const letter = (s) => s.id.slice(3, 4).toLowerCase();
  pages.push(...splitPages('ops-detail', 'Command op arguments', 'Each op\'s arguments as the validator types them. The full validation rules for a document value are its descriptor\'s (components and content pages).', sorted.map(opSection), (i, first, last) => ({ stem: `${letter(first)}-${letter(last)}`, title: `${first.title} to ${last.title}` })));

  return pages;
}

export function typePages(types) {
  const typeSections = [...types.keys()]
    .sort((a, b) => a.localeCompare(b))
    .map((name) => section(typeId(name), name, `Declared in ${code(types.get(name).file)}.\n\n${fence(types.get(name).text, 'ts')}`, { level: 3, topics: [`type.${name}`] }));
  return splitPages('types', 'Types', 'The declarations the ops\' arguments and the JSON-valued fields name, as the source declares them (doc comments included).', typeSections, (i, first, last) => ({ stem: `${first.title.charAt(0).toLowerCase()}-${last.title.charAt(0).toLowerCase()}`, title: `${first.title} to ${last.title}` }));
}

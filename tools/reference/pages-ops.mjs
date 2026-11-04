/**
 * Reference pages for the command ops: every op the validator accepts
 * (`MUTATION_OPS`) and the voxel world ops (`VOXEL_WORLD_OPS`), its request arguments as the validator's per-op union
 * types them (plus the scene a creating op names, which the workspace reads
 * before the validator) and the content block it writes; and the type pages: the
 * declarations those argument shapes and the descriptors' JSON shapes name.
 */
import { code, fence, page, ref, section, splitPages, table, typeId } from './markdown.mjs';

/** What every voxel world op's section says first: where it applies and what differs from a project op. */
const VOXEL_OP_NOTE =
  'A voxel world op: it rides the same command route and envelope (the editor and MCP send it alike) but changes the voxel world `args.world` ' +
  '(its files under `voxels/<world>/`), not the project, so it takes no `expectedRevision` and the project\'s `undo` does not take it back (`undoVoxels` does). ' +
  'It answers the world\'s new revision, the changed chunks, the box of cells it can have touched and the derived parts made stale; ' +
  'the connected editor gets the same as a `voxelsChanged` event.';
/** What each voxel world op adds to the note: its own refusal when there is nothing to do. */
const VOXEL_OP_REFUSAL = {
  editVoxels: 'A stroke that changes no voxel is refused with `no_change`.',
  undoVoxels: 'It takes back the world\'s newest edit still in this backend\'s undo history; with none left it is refused with `nothing_to_undo`.',
  writeKitTestScene: 'A scene written over the same scene changes no voxel and is refused with `no_change`.',
};

export function opPages(ops, types, opLists, descriptors, envelope, routing) {
  const writes = new Map();
  for (const b of descriptors.content) for (const op of b.ops) writes.set(op, [...(writes.get(op) ?? []), b.key]);
  const voxelOps = new Set(opLists.voxel);
  const sorted = [...opLists.project, ...opLists.voxel].sort((a, b) => a.localeCompare(b));

  const opSection = (op) => {
    const o = ops[op];
    const lines = [];
    if (voxelOps.has(op)) {
      if (VOXEL_OP_REFUSAL[op] === undefined) throw new Error(`voxel world op ${op} has no refusal line in the reference`);
      lines.push(`${VOXEL_OP_NOTE} ${VOXEL_OP_REFUSAL[op]}`, '');
    }
    const w = writes.get(op);
    if (w !== undefined) lines.push(`Writes: ${w.map((k) => ref(`content-${k}`, code(`content.${k}`))).join(', ')}.`, '');
    lines.push('Arguments (`args`):', '');
    // A named argument type prints whole, its doc comment included; an inline shape as written.
    lines.push(fence(o.argsName !== undefined && types.has(o.argsName) ? types.get(o.argsName).text : o.argsText, 'ts'));
    // The scene a new object goes into is read (and removed) by the workspace before the validator, so its types lack it.
    const routed = routing.SCENE_ROUTED_CREATES[op];
    if (routed !== undefined) lines.push(`Also ${code(`${routing.SCENE_ROUTED_ARG}?: string`)} (read before validation): ${routed}`, '');
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

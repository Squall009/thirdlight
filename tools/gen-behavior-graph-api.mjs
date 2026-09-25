#!/usr/bin/env node
/**
 * Phase 19.1: generate the visual-script API nodes from the runtime typings.
 *
 * Source of truth: `@thirdlight/runtime`'s `BehaviorContext` (what a
 * behavior's `step(state, ctx)` receives). With the pinned TypeScript
 * compiler API this tool walks every member of the context and writes one
 * node entry (project-model `BehaviorApiNodeSpec`) per reachable call or
 * value:
 *
 * - a method or function-valued member → a call node; its parameters become
 *   inputs (an options object is flattened into one input per option, a
 *   literal union becomes a choice field, `unknown` a value of a chosen type,
 *   a `{x?, y?, z?}` object a vector with a choice of axes), its result the
 *   outputs (an object result is flattened; a nullable one adds "found");
 * - a function-valued member returning a handle (an object of methods, e.g.
 *   `ctx.animator(id)`) → one node per handle method, the handle's
 *   parameters first;
 * - a method taking a union of `{kind: '…', …}` objects (`ctx.emit`) → one
 *   node per union member;
 * - a namespace (`ctx.game`, `ctx.timers`, …) → its members, category = the
 *   namespace; a data member (`ctx.stepIndex`, `ctx.settings.run_speed`) →
 *   a getter (data) node.
 *
 * Doc tags in the runtime typings steer it (see project-model
 * behavior-api.ts): `@graphNode <label>` / `@graphNode skip <reason>`,
 * `@graphPure`, `@graphDefault <arg> <value>`, `@graphLabel <arg> <label>`, `@graphPhase <phase>`,
 * `@graphType list` (a number array that is not a vector).
 *
 * Output: `packages/project-model/src/behavior-api.generated.ts` (checked
 * in). `node tools/gen-behavior-graph-api.mjs` rewrites it; `--check` exits 1
 * when it drifts; `tools/gen-behavior-graph-api.test.mjs` runs the same
 * check in the unit suite.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';

const ROOT = resolve(fileURLToPath(import.meta.url), '..', '..');
export const OUTPUT = join(ROOT, 'packages/project-model/src/behavior-api.generated.ts');
const ENTRY = join(ROOT, 'packages/runtime/src/index.ts');

const VALUE_TYPES = ['number', 'boolean', 'string', 'vector', 'list', 'map'];

function createProgram() {
  return ts.createProgram([ENTRY], {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    lib: ['lib.es2022.d.ts', 'lib.dom.d.ts'],
    strict: true,
    noEmit: true,
    types: [],
  });
}

// ---- doc tags --------------------------------------------------------------------------

function tagText(tag) {
  const c = tag.comment;
  if (c === undefined) return '';
  return (typeof c === 'string' ? c : c.map((p) => p.text ?? '').join('')).trim();
}

/** The `@graph…` tags of a declaration. */
function graphTags(decl) {
  const out = { node: null, skip: null, pure: false, defaults: new Map(), labels: new Map(), phase: null, type: null };
  if (decl === undefined) return out;
  for (const tag of ts.getJSDocTags(decl)) {
    const name = tag.tagName.text;
    const text = tagText(tag);
    if (name === 'graphNode') {
      if (text === 'skip' || text.startsWith('skip ')) out.skip = text.slice(4).trim() || 'not offered as a node';
      else out.node = text;
    } else if (name === 'graphPure') out.pure = true;
    else if (name === 'graphDefault') {
      const m = /^(\S+)\s+(.+)$/.exec(text);
      if (m === null) throw new Error(`gen-behavior-graph-api: @graphDefault needs "<arg> <value>" (got "${text}")`);
      const raw = m[2].trim();
      out.defaults.set(m[1], raw === 'true' ? true : raw === 'false' ? false : raw.startsWith('[') ? JSON.parse(raw) : Number.isFinite(Number(raw)) ? Number(raw) : raw);
    } else if (name === 'graphLabel') {
      const m = /^(\S+)\s+(.+)$/.exec(text);
      if (m === null) throw new Error(`gen-behavior-graph-api: @graphLabel needs "<arg> <label>" (got "${text}")`);
      out.labels.set(m[1], m[2].trim());
    } else if (name === 'graphPhase') {
      if (text !== 'intent' && text !== 'transform') throw new Error(`gen-behavior-graph-api: @graphPhase is intent or transform (got "${text}")`);
      out.phase = text;
    } else if (name === 'graphType') out.type = text;
  }
  return out;
}

/** The first paragraph of a symbol's doc comment, on one line. */
function docOf(checker, symbol) {
  return ts
    .displayPartsToString(symbol.getDocumentationComment(checker))
    .split('\n\n')[0]
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 400);
}

// ---- names -----------------------------------------------------------------------------

/** "setVisible" → "set visible", "gravity_y" → "gravity y", "entityId" → "entity". */
function words(name) {
  return name
    .replace(/Id$/, '')
    .replace(/_/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .trim();
}
const capital = (s) => (s.length === 0 ? s : s[0].toUpperCase() + s.slice(1));

// ---- types -----------------------------------------------------------------------------

const NULLISH = ts.TypeFlags.Null | ts.TypeFlags.Undefined | ts.TypeFlags.Void;

function parts(type) {
  return type.isUnion() ? type.types : [type];
}

/**
 * A type as a graph value: `{kind, nullable}` with kind one of the value
 * types, `enum` (options), `typed` (types), `vec2`, `axes` (keys), `object`
 * (props), `void`, or `unsupported`.
 */
function describe(checker, type, tags = { type: null }) {
  const all = parts(type);
  const nullable = all.some((t) => (t.flags & NULLISH) !== 0);
  let rest = all.filter((t) => (t.flags & NULLISH) === 0);
  if (rest.length === 0) return { kind: 'void', nullable };
  if (rest.some((t) => (t.flags & (ts.TypeFlags.Unknown | ts.TypeFlags.Any)) !== 0)) return { kind: 'typed', types: VALUE_TYPES, nullable: true };
  // `boolean` is the union true | false.
  const bools = rest.filter((t) => (t.flags & ts.TypeFlags.BooleanLiteral) !== 0);
  if (bools.length > 0) rest = [...rest.filter((t) => (t.flags & ts.TypeFlags.BooleanLiteral) === 0), { __boolean: true }];
  if (rest.every((t) => t.__boolean !== true && (t.flags & ts.TypeFlags.StringLiteral) !== 0)) return { kind: 'enum', options: rest.map((t) => t.value), nullable };
  const kinds = rest.map((t) => single(checker, t, tags));
  if (kinds.length === 1) return { ...kinds[0], nullable };
  const names = kinds.map((k) => k.kind);
  // `number | readonly number[]` (a scale): a vector.
  if (names.length === 2 && names.includes('number') && names.includes('vector')) return { kind: 'vector', nullable };
  const prim = names.map((n) => (n === 'enum' ? 'string' : n));
  if (prim.every((n) => ['number', 'boolean', 'string'].includes(n))) return { kind: 'typed', types: [...new Set(prim)].sort((a, b) => VALUE_TYPES.indexOf(a) - VALUE_TYPES.indexOf(b)), nullable };
  return { kind: 'unsupported', why: checker.typeToString(type), nullable };
}

function single(checker, t, tags) {
  if (t.__boolean === true) return { kind: 'boolean' };
  if ((t.flags & ts.TypeFlags.NumberLike) !== 0) return { kind: 'number' };
  if ((t.flags & ts.TypeFlags.StringLiteral) !== 0) return { kind: 'enum', options: [t.value] };
  if ((t.flags & ts.TypeFlags.StringLike) !== 0) return { kind: 'string' };
  if (checker.isTupleType(t) || checker.isArrayType(t)) {
    const args = checker.getTypeArguments(t);
    const numeric = args.length > 0 && args.every((a) => (a.flags & ts.TypeFlags.NumberLike) !== 0);
    if (numeric && tags.type !== 'list') {
      if (checker.isArrayType(t)) return { kind: 'vector' };
      if (args.length === 2 || args.length === 3) return { kind: 'vector' };
    }
    return { kind: 'list' };
  }
  if ((t.flags & ts.TypeFlags.Object) !== 0 || t.isIntersection()) {
    if (t.getCallSignatures().length > 0 && checker.getPropertiesOfType(t).length === 0) return { kind: 'unsupported', why: 'a function' };
    const props = checker.getPropertiesOfType(t);
    if (props.length === 0 && checker.getIndexInfoOfType(t, ts.IndexKind.String) !== undefined) return { kind: 'map' };
    const isNum = (p) => (checker.getNonNullableType(checker.getTypeOfSymbol(p)).flags & ts.TypeFlags.NumberLike) !== 0;
    const names = props.map((p) => p.getName()).sort().join(',');
    if (names === 'x,y' && props.every(isNum) && props.every((p) => (p.flags & ts.SymbolFlags.Optional) === 0)) return { kind: 'vec2' };
    if (props.length >= 2 && props.length <= 3 && props.every(isNum) && props.every((p) => (p.flags & ts.SymbolFlags.Optional) !== 0)) return { kind: 'axes', keys: props.map((p) => p.getName()) };
    return { kind: 'object', props };
  }
  return { kind: 'unsupported', why: checker.typeToString(t) };
}

const TYPE_DEFAULT = { number: 0, boolean: false, string: '', vector: [0, 0, 0] };

// ---- node building ---------------------------------------------------------------------

class Builder {
  constructor(checker) {
    this.checker = checker;
    this.nodes = [];
    this.skipped = [];
  }

  skip(path, reason) {
    this.skipped.push({ path, reason });
  }

  /** The args and call values of one parameter list. */
  params(signature, tags, pathText, prefixArgs = []) {
    const checker = this.checker;
    const args = [...prefixArgs];
    const values = [];
    const claim = (arg) => {
      if (args.some((a) => a.id === arg.id)) throw new Error(`gen-behavior-graph-api: ${pathText}: two arguments named "${arg.id}"`);
      args.push(arg);
    };
    for (const p of signature.getParameters()) {
      const decl = p.valueDeclaration;
      const ptype = checker.getTypeOfSymbolAtLocation(p, decl);
      const optional = decl !== undefined && ts.isParameter(decl) && (decl.questionToken !== undefined || decl.initializer !== undefined);
      if (decl !== undefined && ts.isParameter(decl) && decl.dotDotDotToken !== undefined) {
        // A rest parameter of texts: comma-separated text.
        const el = checker.getTypeArguments(ptype)[0];
        if (el === undefined || (el.flags & ts.TypeFlags.StringLike) === 0) throw new Error(`gen-behavior-graph-api: ${pathText}: only a rest parameter of strings is supported`);
        claim({ id: p.getName(), label: tags.labels.get(p.getName()) ?? `${words(p.getName())} (comma separated)`, type: 'string', default: '', rest: true });
        values.push({ rest: p.getName() });
        continue;
      }
      const d = describe(checker, ptype, graphTags(decl));
      if (d.kind === 'object') {
        // An options object: one argument per option, built back into the object.
        const entries = [];
        for (const prop of d.props) {
          const pd = prop.valueDeclaration ?? prop.declarations?.[0];
          const t = checker.getTypeOfSymbolAtLocation(prop, pd);
          const opt = (prop.flags & ts.SymbolFlags.Optional) !== 0;
          const arg = this.arg(prop.getName(), describe(checker, t, graphTags(pd)), opt, tags, pathText);
          claim(arg);
          entries.push([prop.getName(), { arg: arg.id, ...(arg.axes !== undefined ? { as: 'axes' } : {}) }]);
        }
        values.push({ object: entries });
        continue;
      }
      const arg = this.arg(p.getName(), d, optional, tags, pathText);
      claim(arg);
      values.push({ arg: arg.id, ...(d.kind === 'vec2' ? { as: 'vec2' } : d.kind === 'axes' ? { as: 'axes' } : {}) });
    }
    return { args, values };
  }

  /** One argument from a parameter or option. */
  arg(name, d, optional, tags, pathText) {
    const label = tags.labels.get(name) ?? (words(name) || name);
    const def = tags.defaults.get(name);
    const base = { id: name, label };
    switch (d.kind) {
      case 'enum':
        return { ...base, type: 'string', options: d.options, default: typeof def === 'string' ? def : d.options[0] };
      case 'number':
      case 'boolean':
        if (optional && def === undefined && d.kind === 'number') return { ...base, type: 'number' };
        return { ...base, type: d.kind, default: def ?? TYPE_DEFAULT[d.kind] };
      case 'string': {
        if (name === 'entityId') return { ...base, label: tags.labels.get(name) ?? 'entity', type: 'string', default: '', self: true };
        if (optional) return { ...base, type: 'string', default: def ?? '', omitEmpty: true };
        return { ...base, type: 'string', default: def ?? '', ...(def === undefined ? { required: true } : {}) };
      }
      case 'vector':
      case 'vec2':
        if (optional && def === undefined) return { ...base, type: 'vector' };
        return { ...base, type: 'vector', default: def ?? [0, 0, 0] };
      case 'axes':
        return { ...base, type: 'vector', default: [0, 0, 0], axes: optional ? [...d.keys, 'none'] : d.keys };
      case 'list':
      case 'map':
        return { ...base, type: d.kind };
      case 'typed':
        return { ...base, type: 'typed', types: d.types, default: '', ...(optional ? { omitEmpty: true } : {}) };
      default:
        throw new Error(`gen-behavior-graph-api: ${pathText}: parameter "${name}" has no graph type (${d.why ?? d.kind})`);
    }
  }

  /** The outputs of a result type. */
  outputs(type, pathText) {
    const checker = this.checker;
    const d = describe(checker, type);
    if (d.kind === 'void') return [];
    const out = [];
    const add = (id, label, dd, path) => {
      if (dd.kind === 'unsupported' || dd.kind === 'void') throw new Error(`gen-behavior-graph-api: ${pathText}: result "${path.join('.') || 'value'}" has no graph type (${dd.why ?? dd.kind})`);
      const t = dd.kind === 'enum' ? 'string' : dd.kind === 'vec2' || dd.kind === 'axes' ? 'vector' : dd.kind;
      if (t === 'object') {
        for (const prop of dd.props) {
          const pd = prop.valueDeclaration ?? prop.declarations?.[0];
          add(id === 'value' ? prop.getName() : `${id}_${prop.getName()}`, id === 'value' ? words(prop.getName()) || prop.getName() : `${label} ${words(prop.getName())}`, describe(checker, checker.getTypeOfSymbolAtLocation(prop, pd), graphTags(pd)), [...path, prop.getName()]);
        }
        return;
      }
      out.push({ id, label, type: t, ...(t === 'typed' ? { types: dd.types } : {}), path });
    };
    add('value', 'value', d, []);
    if (d.nullable && d.kind !== 'typed') out.push({ id: 'found', label: 'found', type: 'boolean', path: [], found: true });
    return out;
  }

  push(node) {
    if (this.nodes.some((n) => n.type === node.type)) throw new Error(`gen-behavior-graph-api: two nodes of type "${node.type}"`);
    this.nodes.push(node);
  }

  /** Walk one object type's members (the context or a namespace). */
  walk(type, steps, pathNames, category) {
    const checker = this.checker;
    for (const member of checker.getPropertiesOfType(type)) {
      const name = member.getName();
      const decl = member.valueDeclaration ?? member.declarations?.[0];
      const tags = graphTags(decl);
      const pathText = [...pathNames, name].join('.');
      if (tags.skip !== null) {
        this.skip(pathText, tags.skip);
        continue;
      }
      const optional = (member.flags & ts.SymbolFlags.Optional) !== 0;
      const mtype = checker.getNonNullableType(checker.getTypeOfSymbolAtLocation(member, decl));
      const memberStep = { prop: name, ...(optional ? { optional: true } : {}) };
      const cat = category ?? (pathNames.length === 0 ? null : capital(pathNames[0]));
      const sigs = mtype.getCallSignatures();
      const doc = docOf(checker, member);
      if (sigs.length > 0) {
        const sig = sigs[0];
        const ret = checker.getReturnTypeOfSignature(sig);
        const retNN = checker.getNonNullableType(ret);
        const retProps = checker.getPropertiesOfType(retNN);
        const isHandle = (retNN.flags & ts.TypeFlags.Object) !== 0 && !checker.isArrayType(retNN) && !checker.isTupleType(retNN) && retProps.length > 0 && retProps.every((p) => checker.getNonNullableType(checker.getTypeOfSymbol(p)).getCallSignatures().length > 0);
        const params = sig.getParameters();
        // ctx.emit(intent): one node per member of a union of {kind: '…'} objects.
        if (params.length === 1) {
          const ptype = checker.getTypeOfSymbolAtLocation(params[0], params[0].valueDeclaration);
          if (ptype.isUnion() && ptype.types.every((t) => checker.getPropertyOfType(t, 'kind') !== undefined)) {
            this.union(ptype, [...steps, memberStep], [...pathNames, name], cat ?? 'Intents');
            continue;
          }
        }
        if (isHandle) {
          // A handle factory (ctx.animator(id)): one node per handle method.
          const { args: prefix, values } = this.params(sig, tags, pathText);
          const handleCat = capital(name);
          for (const hm of retProps) {
            const hdecl = hm.valueDeclaration ?? hm.declarations[0];
            const htags = graphTags(hdecl);
            const hpath = `${pathText}().${hm.getName()}`;
            if (htags.skip !== null) {
              this.skip(hpath, htags.skip);
              continue;
            }
            const hsig = checker.getNonNullableType(checker.getTypeOfSymbolAtLocation(hm, hdecl)).getCallSignatures()[0];
            const own = this.params(hsig, htags, hpath, prefix);
            this.push({
              type: `api.${[...pathNames, name, hm.getName()].join('.')}`,
              label: htags.node || capital(words(hm.getName())),
              category: handleCat,
              description: docOf(checker, hm) || doc,
              exec: !htags.pure,
              access: [...steps, memberStep, { call: values, ...(describe(checker, ret).nullable ? { nullable: true } : {}) }, { prop: hm.getName() }, { call: own.values }],
              args: own.args,
              outputs: this.outputs(checker.getReturnTypeOfSignature(hsig), hpath),
            });
          }
          continue;
        }
        const { args, values } = this.params(sig, tags, pathText);
        this.push({
          type: `api.${[...pathNames, name].join('.')}`,
          label: tags.node || capital(words(name)),
          category: cat ?? 'Script',
          description: doc,
          exec: !tags.pure,
          access: [...steps, memberStep, { call: values }],
          args,
          outputs: this.outputs(ret, pathText),
        });
        continue;
      }
      // Only object types (not primitives' apparent members, not arrays) can be namespaces.
      const isObject = ((mtype.flags & ts.TypeFlags.Object) !== 0 || mtype.isIntersection()) && !checker.isArrayType(mtype) && !checker.isTupleType(mtype);
      const props = isObject ? checker.getPropertiesOfType(mtype) : [];
      const hasMethods = props.some((p) => checker.getNonNullableType(checker.getTypeOfSymbol(p)).getCallSignatures().length > 0);
      const d = describe(checker, checker.getTypeOfSymbolAtLocation(member, decl), tags);
      if (hasMethods) {
        // A namespace (ctx.game, ctx.timers…): its members, category = its name.
        this.walk(mtype, [...steps, memberStep], [...pathNames, name], cat ?? capital(name));
        continue;
      }
      if (d.kind === 'object' && pathNames.length === 0) {
        // A data object of the context (ctx.action, ctx.settings…): a getter per member.
        this.walk(mtype, [...steps, memberStep], [...pathNames, name], capital(name));
        continue;
      }
      // A value: a getter (data) node.
      this.push({
        type: `api.${[...pathNames, name].join('.')}`,
        label: tags.node || (pathNames.length === 0 ? capital(words(name)) : `${capital(words(pathNames[pathNames.length - 1]))} ${words(name)}`),
        category: cat ?? 'Script',
        description: doc,
        exec: false,
        access: [...steps, memberStep],
        args: [],
        outputs: this.outputs(checker.getTypeOfSymbolAtLocation(member, decl), pathText),
      });
    }
  }

  /** One node per member of a `{kind}` union (the argument object in the member's field order). */
  union(type, steps, pathNames, category) {
    const checker = this.checker;
    for (const member of type.types) {
      const sym = member.aliasSymbol ?? member.getSymbol();
      const decl = sym?.declarations?.[0];
      const tags = graphTags(decl);
      const kindProp = checker.getPropertyOfType(member, 'kind');
      const kind = checker.getTypeOfSymbol(kindProp).value;
      const pathText = `${pathNames.join('.')}(${kind})`;
      if (tags.skip !== null) {
        this.skip(pathText, tags.skip);
        continue;
      }
      const args = [];
      const entries = [];
      for (const prop of checker.getPropertiesOfType(member)) {
        if (prop.getName() === 'kind') {
          entries.push(['kind', { const: kind }]);
          continue;
        }
        const pd = prop.valueDeclaration ?? prop.declarations?.[0];
        const opt = (prop.flags & ts.SymbolFlags.Optional) !== 0;
        const arg = this.arg(prop.getName(), describe(checker, checker.getTypeOfSymbolAtLocation(prop, pd), graphTags(pd)), opt, tags, pathText);
        args.push(arg);
        entries.push([prop.getName(), { arg: arg.id, ...(arg.axes !== undefined ? { as: 'axes' } : {}) }]);
      }
      this.push({
        type: `api.${[...pathNames, kind].join('.')}`,
        label: tags.node || capital(words(kind)),
        category,
        description: sym !== undefined ? docOf(checker, sym) : '',
        exec: true,
        access: [...steps, { call: [{ object: entries }] }],
        args,
        outputs: [],
        ...(tags.phase !== null ? { phase: tags.phase } : {}),
        // An intent naming an entity moves it: the script must own that transform.
        ...(args.some((a) => a.id === 'entityId') ? { moves: 'entityId' } : {}),
      });
    }
  }
}

export function generateBehaviorGraphApi() {
  const program = createProgram();
  const checker = program.getTypeChecker();
  const entry = program.getSourceFile(ENTRY);
  if (entry === undefined) throw new Error(`gen-behavior-graph-api: ${ENTRY} not found`);
  const exports = new Map(checker.getExportsOfModule(checker.getSymbolAtLocation(entry)).map((s) => [s.name, s]));
  let ctxSym = exports.get('BehaviorContext');
  if (ctxSym === undefined) throw new Error('gen-behavior-graph-api: @thirdlight/runtime does not export BehaviorContext');
  if (ctxSym.flags & ts.SymbolFlags.Alias) ctxSym = checker.getAliasedSymbol(ctxSym);
  const b = new Builder(checker);
  b.walk(checker.getDeclaredTypeOfSymbol(ctxSym), [], [], null);
  return (
    '/**\n' +
    " * GENERATED by tools/gen-behavior-graph-api.mjs from @thirdlight/runtime's\n" +
    ' * BehaviorContext (phase 19.1). Do not edit: change the runtime types (and\n' +
    ' * their @graph… doc tags) and run `node tools/gen-behavior-graph-api.mjs`\n' +
    ' * (a unit test fails when this file drifts).\n' +
    ' */\n' +
    "import type { BehaviorApiNodeSpec } from './behavior-api';\n\n" +
    '/** One visual-script node per `ctx` call or value (in the order of the typings). */\n' +
    `export const BEHAVIOR_API_NODES: readonly BehaviorApiNodeSpec[] = [\n${b.nodes.map((n) => `  ${JSON.stringify(n)},\n`).join("")}];\n\n` +
    '/** `ctx` members that are not nodes, and why (their `@graphNode skip` reason). */\n' +
    `export const BEHAVIOR_API_SKIPPED: readonly { path: string; reason: string }[] = [\n${b.skipped.map((s) => `  ${JSON.stringify(s)},\n`).join("")}];\n`
  );
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const text = generateBehaviorGraphApi();
  if (process.argv.includes('--check')) {
    let current = '';
    try {
      current = readFileSync(OUTPUT, 'utf8');
    } catch {
      /* missing */
    }
    if (current !== text) {
      console.error('gen-behavior-graph-api: FAIL — behavior-api.generated.ts is out of date; run node tools/gen-behavior-graph-api.mjs');
      process.exit(1);
    }
    console.log('gen-behavior-graph-api: up to date');
  } else {
    writeFileSync(OUTPUT, text);
    console.log(`gen-behavior-graph-api: wrote ${OUTPUT.slice(ROOT.length + 1)}`);
  }
}

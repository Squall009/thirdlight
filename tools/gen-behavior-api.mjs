#!/usr/bin/env node
/**
 * Phase 16.3: generate the behavior API typings the script editor ships.
 *
 * Source of truth: `@thirdlight/runtime`'s `BehaviorContext` (what a
 * behavior's `step(state, ctx)` receives), `BehaviorSpec`,
 * `BehaviorPrepareConfig` and `BehaviorInstanceInfo`. With the pinned
 * TypeScript compiler API this tool
 *
 *   1. collects every declaration those types reach (interfaces, type
 *      aliases, enums, constants named by `typeof`) from the workspace
 *      sources and prints them — doc comments included — as one ambient
 *      `declare module '@thirdlight/runtime' { … }` (`BEHAVIOR_API_DTS`: a
 *      script's `import type { BehaviorContext } from '@thirdlight/runtime'`
 *      names it; the editor shows it read-only);
 *   2. resolves the member table the editor's completion walks
 *      (`BEHAVIOR_API_TYPES`: type key → members with their type text, doc
 *      and the key of the member's own type, so `ctx.game.` completes).
 *
 * Output: `packages/editor/src/ui/script/behavior-api.generated.ts`
 * (checked in). `node tools/gen-behavior-api.mjs` rewrites it;
 * `--check` exits 1 when it drifts. `tools/gen-behavior-api.test.mjs` runs
 * the same check in the unit suite and compiles the typings.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';

const ROOT = resolve(fileURLToPath(import.meta.url), '..', '..');
export const OUTPUT = join(ROOT, 'packages/editor/src/ui/script/behavior-api.generated.ts');
const ENTRY = join(ROOT, 'packages/runtime/src/index.ts');
/** The public entry points of the behavior API (roots of the walk). */
export const ROOTS = ['BehaviorContext', 'BehaviorSpec', 'BehaviorPrepareConfig', 'BehaviorInstanceInfo'];
/** The module name a script imports the types from (a pinned engine module). */
export const MODULE = '@thirdlight/runtime';

function isWorkspaceSource(fileName) {
  return fileName.includes('/packages/') && !fileName.includes('/node_modules/') && !fileName.endsWith('.d.ts');
}

function createProgram() {
  const options = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    lib: ['lib.es2022.d.ts', 'lib.dom.d.ts'],
    strict: true,
    noEmit: true,
    types: [],
  };
  return ts.createProgram([ENTRY], options);
}

function resolveSymbol(checker, symbol) {
  let s = symbol;
  for (let guard = 0; s !== undefined && guard < 16; guard++) {
    if (s.flags & ts.SymbolFlags.Alias) {
      s = checker.getAliasedSymbol(s);
      continue;
    }
    // `type X = X'` where X' is an imported type of the same name (a
    // re-export under the same name): follow it to the one declaration.
    const d = s.declarations?.length === 1 ? s.declarations[0] : undefined;
    if (d !== undefined && ts.isTypeAliasDeclaration(d) && d.typeParameters === undefined && ts.isTypeReferenceNode(d.type) && d.type.typeArguments === undefined && ts.isIdentifier(d.type.typeName)) {
      const target = checker.getSymbolAtLocation(d.type.typeName);
      const resolved = target === undefined ? undefined : target.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(target) : target;
      if (resolved !== undefined && resolved !== s && resolved.name === s.name) {
        s = resolved;
        continue;
      }
    }
    break;
  }
  return s;
}

function jsDocText(node) {
  const docs = ts.getJSDocCommentsAndTags(node).filter((d) => d.kind === ts.SyntaxKind.JSDoc);
  const last = docs[docs.length - 1];
  return last === undefined ? '' : `${last.getText()}\n`;
}

/** Strip `export` / `declare` modifiers from a top-level declaration's text. */
function declarationText(node) {
  const text = node.getText();
  return text.replace(/^export\s+/, '').replace(/^declare\s+/, '');
}

function collectDeclarations(program) {
  const checker = program.getTypeChecker();
  const entry = program.getSourceFile(ENTRY);
  if (entry === undefined) throw new Error(`gen-behavior-api: ${ENTRY} not found`);
  const moduleSymbol = checker.getSymbolAtLocation(entry);
  const exports = new Map(checker.getExportsOfModule(moduleSymbol).map((s) => [s.name, s]));
  const byName = new Map();
  const order = [];
  const queue = [];
  const enqueue = (symbol, via) => {
    const s = resolveSymbol(checker, symbol);
    if (s === undefined || s.flags & ts.SymbolFlags.TypeParameter) return;
    const decls = (s.declarations ?? []).filter((d) => isWorkspaceSource(d.getSourceFile().fileName));
    if (decls.length === 0) return;
    const seen = byName.get(s.name);
    if (seen !== undefined) {
      if (seen !== s) throw new Error(`gen-behavior-api: two different declarations named "${s.name}" (${via}) — rename one`);
      return;
    }
    byName.set(s.name, s);
    order.push(s);
    queue.push(s);
  };
  for (const name of ROOTS) {
    const s = exports.get(name);
    if (s === undefined) throw new Error(`gen-behavior-api: @thirdlight/runtime does not export ${name}`);
    enqueue(s, 'root');
  }
  const visit = (node, owner) => {
    if (ts.isTypeReferenceNode(node)) {
      const name = ts.isQualifiedName(node.typeName) ? node.typeName.left : node.typeName;
      const sym = checker.getSymbolAtLocation(name);
      if (sym !== undefined) enqueue(sym, owner);
    } else if (ts.isExpressionWithTypeArguments(node)) {
      const sym = checker.getSymbolAtLocation(node.expression);
      if (sym !== undefined) enqueue(sym, owner);
    } else if (ts.isTypeQueryNode(node)) {
      const name = ts.isQualifiedName(node.exprName) ? node.exprName.left : node.exprName;
      const sym = checker.getSymbolAtLocation(name);
      if (sym !== undefined) enqueue(sym, owner);
    }
    ts.forEachChild(node, (child) => visit(child, owner));
  };
  const blocks = new Map();
  while (queue.length > 0) {
    const s = queue.shift();
    const parts = [];
    for (const d of s.declarations ?? []) {
      if (!isWorkspaceSource(d.getSourceFile().fileName)) continue;
      if (ts.isInterfaceDeclaration(d) || ts.isTypeAliasDeclaration(d) || ts.isEnumDeclaration(d)) {
        parts.push(`${jsDocText(d)}export ${declarationText(d)}`);
        visit(d, s.name);
      } else if (ts.isVariableDeclaration(d)) {
        // A constant named by `typeof X` (e.g. a frozen list of levels).
        const type = checker.getTypeOfSymbolAtLocation(s, d);
        const text = checker.typeToString(type, undefined, ts.TypeFormatFlags.NoTruncation);
        const stmt = d.parent.parent;
        parts.push(`${jsDocText(stmt)}export const ${s.name}: ${text};`);
      } else if (ts.isClassDeclaration(d)) {
        throw new Error(`gen-behavior-api: the behavior API reaches class "${s.name}"; expose an interface instead`);
      } else {
        throw new Error(`gen-behavior-api: unsupported declaration kind ${ts.SyntaxKind[d.kind]} for "${s.name}"`);
      }
    }
    blocks.set(s.name, parts.join('\n'));
  }
  return { checker, exports, order: order.map((s) => ({ name: s.name, text: blocks.get(s.name) })) };
}

function indent(text, pad) {
  return text
    .split('\n')
    .map((line) => (line.length > 0 ? pad + line : line))
    .join('\n');
}

/** The ambient module text (`BEHAVIOR_API_DTS`). */
function dtsText(order) {
  const body = order.map((d) => indent(d.text, '  ')).join('\n\n');
  return (
    '// The Thirdlight behavior API (generated from @thirdlight/runtime; read-only).\n' +
    "// In a script: import type { BehaviorContext } from '@thirdlight/runtime';\n" +
    `declare module '${MODULE}' {\n${body}\n}\n`
  );
}

const LIB_OBJECTS = new Set(['Array', 'ReadonlyArray', 'Map', 'ReadonlyMap', 'Set', 'ReadonlySet', 'Function', 'String', 'Number', 'Boolean', 'Object', 'Promise', 'Date', 'RegExp', 'Error', 'Symbol']);

/** The member table the editor's completion walks (`BEHAVIOR_API_TYPES`). */
function memberTable(checker, exports) {
  const table = {};
  const flags = ts.TypeFormatFlags.NoTruncation | ts.TypeFormatFlags.UseSingleQuotesForStringLiteralType;
  const keyOf = (type, fallback) => {
    const t = checker.getNonNullableType(type);
    if (t.isUnion()) return null;
    // Only object types have members worth completing (not a primitive's apparent String/Number members).
    if ((t.flags & (ts.TypeFlags.Object | ts.TypeFlags.Intersection)) === 0) return null;
    if (checker.isArrayType(t) || checker.isTupleType(t)) return null;
    const props = checker.getPropertiesOfType(t);
    if (props.length === 0) return null;
    const sym = t.aliasSymbol ?? t.getSymbol();
    const name = sym?.getName();
    if (name !== undefined && LIB_OBJECTS.has(name)) return null;
    const decl = sym?.declarations?.[0];
    if (name === undefined || name.startsWith('__') || decl === undefined) return fallback;
    // Named types (and lib mapped types such as Readonly<X>) are keyed by their text.
    return checker.typeToString(t, undefined, flags);
  };
  const addType = (key, type) => {
    if (key in table) return;
    table[key] = [];
    const members = [];
    for (const p of checker.getPropertiesOfType(checker.getNonNullableType(type))) {
      const decl = p.valueDeclaration ?? p.declarations?.[0];
      if (decl === undefined) continue;
      const ptype = checker.getTypeOfSymbolAtLocation(p, decl);
      const nonNull = checker.getNonNullableType(ptype);
      const sigs = nonNull.getCallSignatures();
      const optional = (p.flags & ts.SymbolFlags.Optional) !== 0;
      const doc = ts.displayPartsToString(p.getDocumentationComment(checker)).split('\n\n')[0].replace(/\s+/g, ' ').trim().slice(0, 240);
      const isMethod = sigs.length > 0 && checker.getPropertiesOfType(nonNull).length === 0;
      const member = { name: p.getName(), kind: isMethod ? 'method' : 'property' };
      if (isMethod) {
        const sig = sigs[0];
        member.detail = checker.signatureToString(sig, undefined, flags);
        const ret = checker.getReturnTypeOfSignature(sig);
        const target = keyOf(ret, `${key}.${p.getName()}()`);
        if (target !== null) {
          member.returns = target;
          addType(target, ret);
        }
      } else {
        member.detail = checker.typeToString(ptype, undefined, flags);
        const target = keyOf(ptype, `${key}.${p.getName()}`);
        if (target !== null) {
          member.type = target;
          addType(target, ptype);
        }
      }
      if (optional) member.optional = true;
      if (doc.length > 0) member.doc = doc;
      members.push(member);
    }
    table[key] = members;
  };
  for (const name of ['BehaviorContext', 'BehaviorPrepareConfig', 'BehaviorInstanceInfo']) {
    const s = resolveSymbol(checker, exports.get(name));
    addType(name, checker.getDeclaredTypeOfSymbol(s));
  }
  return table;
}

/** The generated TypeScript module text. */
export function generateBehaviorApi() {
  const program = createProgram();
  const { checker, exports, order } = collectDeclarations(program);
  const dts = dtsText(order);
  const table = memberTable(checker, exports);
  const keys = Object.keys(table).sort();
  const sorted = Object.fromEntries(keys.map((k) => [k, table[k]]));
  return (
    '/**\n' +
    ' * GENERATED by tools/gen-behavior-api.mjs from @thirdlight/runtime\'s\n' +
    ' * BehaviorContext (phase 16.3). Do not edit: change the runtime types and run\n' +
    ' * `node tools/gen-behavior-api.mjs` (a unit test fails when this file drifts).\n' +
    ' */\n' +
    "import type { BehaviorApiMember } from './behavior-api-types';\n\n" +
    `/** The behavior API typings (\`declare module '${MODULE}'\`). */\n` +
    `export const BEHAVIOR_API_DTS: string = ${JSON.stringify(dts)};\n\n` +
    '/** Type key → members (completion walks `type` / `returns` keys). */\n' +
    `export const BEHAVIOR_API_TYPES: Readonly<Record<string, readonly BehaviorApiMember[]>> = ${JSON.stringify(sorted, null, 2)};\n`
  );
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const text = generateBehaviorApi();
  if (process.argv.includes('--check')) {
    let current = '';
    try {
      current = readFileSync(OUTPUT, 'utf8');
    } catch {
      /* missing */
    }
    if (current !== text) {
      console.error('gen-behavior-api: FAIL — behavior-api.generated.ts is out of date; run node tools/gen-behavior-api.mjs');
      process.exit(1);
    }
    console.log('gen-behavior-api: up to date');
  } else {
    writeFileSync(OUTPUT, text);
    console.log(`gen-behavior-api: wrote ${OUTPUT.slice(ROOT.length + 1)}`);
  }
}

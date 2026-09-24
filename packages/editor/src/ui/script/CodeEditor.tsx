/**
 * Phase 16.3: the script editor's code view — CodeMirror 6 (pinned; editor
 * bundle only) with TypeScript syntax highlighting, the behavior API
 * completion, inline diagnostics (squiggles + gutter markers) and Ctrl+S.
 *
 * One `EditorView` per mounted component; each file keeps its own
 * `EditorState` (text, selection, undo history) while the component lives,
 * so switching files in the list does not lose a file's undo steps.
 *
 * Browser-only (React + DOM).
 */
import { useEffect, useRef, type JSX } from 'react';
import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap, type CompletionContext, type CompletionResult } from '@codemirror/autocomplete';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { javascript, typescriptLanguage } from '@codemirror/lang-javascript';
import { bracketMatching, foldGutter, HighlightStyle, indentOnInput, syntaxHighlighting } from '@codemirror/language';
import { lintGutter, setDiagnostics, type Diagnostic } from '@codemirror/lint';
import { highlightSelectionMatches, searchKeymap } from '@codemirror/search';
import { EditorState, type Extension } from '@codemirror/state';
import { drawSelection, EditorView, highlightActiveLine, highlightActiveLineGutter, keymap, lineNumbers } from '@codemirror/view';
import { tags } from '@lezer/highlight';

import { exportedTypeNames, memberCompletion } from '../../session/script-sources';
import { BEHAVIOR_API_DTS, BEHAVIOR_API_TYPES } from './behavior-api.generated';

/** One diagnostic to mark in the open file (1-based line/column; column optional). */
export interface InlineDiagnostic {
  line: number;
  column?: number;
  severity: 'error' | 'warning';
  message: string;
}

export interface CodeEditorProps {
  /** The open file's path (a new path swaps in that file's state). */
  path: string;
  text: string;
  readOnly?: boolean;
  diagnostics: readonly InlineDiagnostic[];
  onChange: (path: string, text: string) => void;
  onSave: () => void;
  /** Accessible name of the editing surface. */
  label: string;
}

const TYPE_NAMES = exportedTypeNames(BEHAVIOR_API_DTS);

/** Completion from the generated behavior API typings (`ctx.` chains and type names). */
function behaviorApiCompletion(context: CompletionContext): CompletionResult | null {
  const line = context.state.doc.lineAt(context.pos);
  const before = line.text.slice(0, context.pos - line.from);
  const members = memberCompletion(before, context.state.doc.toString(), BEHAVIOR_API_TYPES);
  if (members !== null) {
    return {
      from: context.pos - members.prefix.length,
      options: members.members.map((m) => ({
        label: m.name,
        type: m.kind === 'method' ? 'method' : 'property',
        detail: m.optional === true ? `?: ${m.detail}` : m.detail,
        ...(m.doc !== undefined ? { info: m.doc } : {}),
      })),
      validFor: /^[\w$]*$/,
    };
  }
  // A type position (`: Beh…`) or the braces of `import type { … }`.
  const typeAt = /(?::\s*|import\s+type\s*\{[^}]*?)([A-Z][\w$]*)?$/.exec(before);
  if (typeAt !== null && (typeAt[1] !== undefined || context.explicit)) {
    const prefix = typeAt[1] ?? '';
    return {
      from: context.pos - prefix.length,
      options: TYPE_NAMES.map((name) => ({ label: name, type: 'type', detail: '@thirdlight/runtime' })),
      validFor: /^[\w$]*$/,
    };
  }
  return null;
}

/** Colours from the editor's theme variables (dark UI). */
const highlight = HighlightStyle.define([
  { tag: [tags.keyword, tags.controlKeyword, tags.moduleKeyword, tags.operatorKeyword, tags.definitionKeyword, tags.modifier], color: '#c39bff' },
  { tag: [tags.string, tags.special(tags.string), tags.regexp], color: '#9ad48a' },
  { tag: [tags.number, tags.bool, tags.null, tags.atom], color: '#f2b544' },
  { tag: [tags.comment, tags.lineComment, tags.blockComment], color: '#667082', fontStyle: 'italic' },
  { tag: [tags.typeName, tags.className, tags.namespace], color: '#8ec1ff' },
  { tag: [tags.function(tags.variableName), tags.function(tags.propertyName)], color: '#ffe27a' },
  { tag: [tags.propertyName], color: '#e8ebf0' },
  { tag: [tags.definition(tags.variableName)], color: '#e8ebf0' },
  { tag: tags.invalid, color: '#ff5d5d' },
]);

const theme = EditorView.theme(
  {
    '&': { height: '100%', fontSize: '12px', backgroundColor: 'var(--surface-0)', color: 'var(--text)' },
    '.cm-scroller': { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', lineHeight: '1.5' },
    '.cm-content': { caretColor: 'var(--text)' },
    '.cm-gutters': { backgroundColor: 'var(--surface-1)', color: 'var(--text-faint)', borderRight: '1px solid var(--line)' },
    '.cm-activeLine': { backgroundColor: 'rgba(255,255,255,0.03)' },
    '.cm-activeLineGutter': { backgroundColor: 'var(--surface-2)' },
    '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': { backgroundColor: 'var(--select-bg)' },
    '.cm-tooltip': { backgroundColor: 'var(--surface-2)', border: '1px solid var(--line-strong)', color: 'var(--text)' },
    '.cm-tooltip-autocomplete ul li[aria-selected]': { backgroundColor: 'var(--select-bg)', color: 'var(--text)' },
  },
  { dark: true },
);

function baseExtensions(onChange: (text: string) => void, onSave: () => void, readOnly: boolean, label: string): Extension[] {
  return [
    lineNumbers(),
    highlightActiveLineGutter(),
    foldGutter(),
    lintGutter(),
    history(),
    drawSelection(),
    indentOnInput(),
    bracketMatching(),
    closeBrackets(),
    highlightActiveLine(),
    highlightSelectionMatches(),
    // TypeScript syntax (the lezer TS grammar) + local-scope completion from the language package.
    javascript({ typescript: true }),
    typescriptLanguage.data.of({ autocomplete: behaviorApiCompletion }),
    autocompletion(),
    syntaxHighlighting(highlight),
    theme,
    EditorState.tabSize.of(2),
    EditorState.readOnly.of(readOnly),
    EditorView.editable.of(!readOnly),
    EditorView.contentAttributes.of({ 'aria-label': label }),
    keymap.of([
      { key: 'Mod-s', preventDefault: true, run: () => (onSave(), true) },
      ...closeBracketsKeymap,
      ...defaultKeymap,
      ...searchKeymap,
      ...historyKeymap,
      ...completionKeymap,
      indentWithTab,
    ]),
    EditorView.updateListener.of((u) => {
      if (u.docChanged) onChange(u.state.doc.toString());
    }),
  ];
}

function toCm(state: EditorState, d: InlineDiagnostic): Diagnostic {
  const lineNo = Math.min(Math.max(1, d.line), state.doc.lines);
  const line = state.doc.line(lineNo);
  let from = d.column !== undefined ? Math.min(line.from + Math.max(0, d.column - 1), line.to) : line.from;
  // Mark the word at the position (or the next character / the whole line).
  let to = from;
  const rest = state.doc.sliceString(from, line.to);
  const word = /^[\w$]+/.exec(rest);
  if (d.column === undefined) to = line.to;
  else if (word !== null) to = from + word[0].length;
  else to = Math.min(from + 1, line.to);
  if (to === from) {
    if (from > line.from) from -= 1;
    else to = Math.min(line.to, from + 1);
  }
  return { from, to, severity: d.severity, message: d.message };
}

export function CodeEditor(p: CodeEditorProps): JSX.Element {
  const host = useRef<HTMLDivElement | null>(null);
  const view = useRef<EditorView | null>(null);
  const states = useRef(new Map<string, EditorState>());
  const current = useRef<string>(p.path);
  // The latest callbacks (the extensions are built once per file state).
  const cb = useRef({ onChange: p.onChange, onSave: p.onSave });
  cb.current = { onChange: p.onChange, onSave: p.onSave };

  const makeState = (path: string, text: string): EditorState =>
    EditorState.create({
      doc: text,
      extensions: baseExtensions((t) => cb.current.onChange(path, t), () => cb.current.onSave(), p.readOnly === true, p.label),
    });

  // Create the view once.
  useEffect(() => {
    if (host.current === null) return;
    const state = makeState(p.path, p.text);
    states.current.set(p.path, state);
    current.current = p.path;
    const v = new EditorView({ state, parent: host.current });
    view.current = v;
    return () => {
      v.destroy();
      view.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Another file (or the file's text replaced from outside: a reload).
  useEffect(() => {
    const v = view.current;
    if (v === null) return;
    if (current.current !== p.path) {
      states.current.set(current.current, v.state);
      let next = states.current.get(p.path);
      if (next === undefined || next.doc.toString() !== p.text) next = makeState(p.path, p.text);
      current.current = p.path;
      v.setState(next);
    } else if (v.state.doc.toString() !== p.text) {
      v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: p.text } });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.path, p.text]);

  // Diagnostics for the open file.
  useEffect(() => {
    const v = view.current;
    if (v === null) return;
    v.dispatch(setDiagnostics(v.state, p.diagnostics.map((d) => toCm(v.state, d))));
  }, [p.diagnostics, p.path, p.text]);

  return <div className="tl-script__code" ref={host} data-path={p.path} />;
}

/** Move the cursor of the code view inside `root` to a 1-based line/column and focus it. */
export function revealPosition(root: HTMLElement | null, line: number, column?: number): void {
  const el = root?.querySelector('.cm-editor');
  if (!(el instanceof HTMLElement)) return;
  const v = EditorView.findFromDOM(el);
  if (v === null) return;
  const l = v.state.doc.line(Math.min(Math.max(1, line), v.state.doc.lines));
  const pos = Math.min(l.from + Math.max(0, (column ?? 1) - 1), l.to);
  v.dispatch({ selection: { anchor: pos }, scrollIntoView: true });
  v.focus();
}

/**
 * Project UI documents and themes (`content.uiDocuments`,
 * `content.uiThemes`).
 *
 * `setUiDocument {document}` creates or replaces one document (by
 * uiDocumentId — its whole widget tree, styles, tweens); `deleteUiDocument
 * {uiDocumentId}` removes one (refused by the resulting-state check while
 * another document's show/hide action or `flow.screens` names it);
 * `setUiTheme {theme}` / `deleteUiTheme {uiThemeId}` the same for themes (a
 * theme a document uses cannot be deleted). Each is one undo; the change
 * records the value before and after (`setUi {uiKind, id, previous, next}`).
 */
import { canonicalUiDocument, canonicalUiDocuments, canonicalUiTheme, canonicalUiThemes, projectInputMaps, validateUiDocument, validateUiTheme, type ModelErrorV2, type UiDocument, type UiTheme } from '@thirdlight/project-model';

import { fieldValue, type CommandError } from './errors';
import { contentOf, type OpInput } from './content-ops';
import { deepClone, gateResultState, type OpOutcome } from './ops';
import type { ContentDocument, SetUiChange } from './types';
import { withListRecord } from './record-lists';

type WithUi = ContentDocument & { uiDocuments?: UiDocument[]; uiThemes?: UiTheme[] };
export type UiKind = 'document' | 'theme';

function modelError(e: ModelErrorV2, prefix: string): CommandError {
  return { code: e.code, cls: 'validation', path: `${prefix}${e.path ?? ''}`, message: e.message, ...(e.found !== undefined ? { found: e.found } : {}), ...(e.expected !== undefined ? { expected: e.expected } : {}) } as unknown as CommandError;
}

export const uiDocumentsOf = (content: ContentDocument): UiDocument[] => (content as WithUi).uiDocuments ?? [];
export const uiThemesOf = (content: ContentDocument): UiTheme[] => (content as WithUi).uiThemes ?? [];

/** The document or theme with this id (null: none). */
export function uiOf(content: ContentDocument, kind: UiKind, id: string): UiDocument | UiTheme | null {
  return kind === 'document' ? (uiDocumentsOf(content).find((d) => d.uiDocumentId === id) ?? null) : (uiThemesOf(content).find((t) => t.uiThemeId === id) ?? null);
}

/** The content with one document/theme set (or removed when null); each list stays canonical and is absent when empty. */
export function withUi(content: ContentDocument, kind: UiKind, id: string, value: UiDocument | UiTheme | null): ContentDocument {
  const c = { ...(content as WithUi) };
  if (kind === 'document') {
    const list = withListRecord(c.uiDocuments, (d) => d.uiDocumentId, id, value === null ? null : canonicalUiDocuments([deepClone(value as UiDocument)])[0]!);
    if (list.length > 0) c.uiDocuments = list;
    else delete c.uiDocuments;
  } else {
    const list = withListRecord(c.uiThemes, (t) => t.uiThemeId, id, value === null ? null : canonicalUiThemes([deepClone(value as UiTheme)])[0]!);
    if (list.length > 0) c.uiThemes = list;
    else delete c.uiThemes;
  }
  return c as ContentDocument;
}

function commit(input: OpInput, next: ContentDocument, kind: UiKind, id: string, previous: UiDocument | UiTheme | null): OpOutcome {
  const catalog = contentOf(input.content);
  const resultScene = { ...input.scene, revision: input.scene.revision + 1 };
  const gate = gateResultState({ scene: input.scene, content: catalog, manifest: input.manifest }, resultScene, next);
  if (!gate.ok) return gate;
  const stored = uiOf((gate.content ?? next) as ContentDocument, kind, id);
  const change: SetUiChange = { type: 'setUi', uiKind: kind, id, previous: previous === null ? null : deepClone(previous), next: stored === null ? null : deepClone(stored) };
  return { ok: true, op: { scene: gate.scene, content: gate.content, change, inverse: { kind: 'setUi', uiKind: kind, id, restore: previous === null ? null : deepClone(previous) } } };
}

/** `setUiDocument`: create or replace one UI document. */
export function applySetUiDocument(input: OpInput, args: { document: UiDocument }): OpOutcome {
  const catalog = contentOf(input.content);
  const errors: ModelErrorV2[] = [];
  validateUiDocument(args.document, '', errors, projectInputMaps((catalog as { input?: unknown }).input));
  if (errors.length > 0) return { ok: false, error: modelError(errors[0]!, '/args/document') };
  const doc = canonicalUiDocument(args.document);
  const previous = uiOf(catalog, 'document', doc.uiDocumentId);
  return commit(input, withUi(catalog, 'document', doc.uiDocumentId, doc), 'document', doc.uiDocumentId, previous);
}

/** `setUiTheme`: create or replace one UI theme. */
export function applySetUiTheme(input: OpInput, args: { theme: UiTheme }): OpOutcome {
  const catalog = contentOf(input.content);
  const errors: ModelErrorV2[] = [];
  validateUiTheme(args.theme, '', errors);
  if (errors.length > 0) return { ok: false, error: modelError(errors[0]!, '/args/theme') };
  const theme = canonicalUiTheme(args.theme);
  const previous = uiOf(catalog, 'theme', theme.uiThemeId);
  return commit(input, withUi(catalog, 'theme', theme.uiThemeId, theme), 'theme', theme.uiThemeId, previous);
}

/** `deleteUiDocument` / `deleteUiTheme`: remove one (refused by the resulting-state check while something names it). */
export function applyDeleteUi(input: OpInput, kind: UiKind, id: string): OpOutcome {
  const catalog = contentOf(input.content);
  const previous = uiOf(catalog, kind, id);
  const field = kind === 'document' ? 'uiDocumentId' : 'uiThemeId';
  if (previous === null) return { ok: false, error: { ...fieldValue(`/args/${field}`, id, `an existing ${field}`, `no UI ${kind} with this id`), code: 'reference_missing' } };
  return commit(input, withUi(catalog, kind, id, null), kind, id, previous);
}

/**
 * `setSaveSchema {schema}` — the project's save schema
 * (`content.saveSchema`: the save document's version and migrations, the slot
 * count, the engine sections saves include, the thumbnail and the project
 * settings document's fields). `null` removes it (no project saves). One undo
 * step; the change carries the whole schema before and after.
 */

import { canonicalSaveSchema, validateSaveSchema, type ModelErrorV2, type SaveSchema } from '@thirdlight/project-model';

import type { CommandError } from './errors';
import { contentOf, type OpInput } from './content-ops';
import { deepClone, gateResultState, type OpOutcome } from './ops';
import type { ContentDocument, SetSaveSchemaChange } from './types';

type WithSchema = ContentDocument & { saveSchema?: SaveSchema };

function modelError(e: ModelErrorV2, prefix: string): CommandError {
  return { code: e.code, cls: 'validation', path: `${prefix}${e.path ?? ''}`, message: e.message, ...(e.found !== undefined ? { found: e.found } : {}), ...(e.expected !== undefined ? { expected: e.expected } : {}) } as unknown as CommandError;
}

/** The content with the save schema replaced (null removes the field, so the content bytes stay as before saves existed). */
export function withSaveSchema(content: ContentDocument, schema: SaveSchema | null): ContentDocument {
  const c = { ...(content as WithSchema) };
  if (schema !== null) c.saveSchema = canonicalSaveSchema(schema);
  else delete c.saveSchema;
  return c;
}

export function applySetSaveSchema(input: OpInput, args: { schema: SaveSchema | null }): OpOutcome {
  const catalog = contentOf(input.content) as WithSchema;
  if (args.schema !== null) {
    const errors: ModelErrorV2[] = [];
    validateSaveSchema(args.schema, '', errors);
    if (errors.length > 0) return { ok: false, error: modelError(errors[0] as ModelErrorV2, '/args/schema') };
  }
  const previous = catalog.saveSchema !== undefined ? deepClone(catalog.saveSchema) : null;
  const next = args.schema !== null ? canonicalSaveSchema(args.schema) : null;
  const content = withSaveSchema(catalog, next);
  const resultScene = { ...input.scene, revision: input.scene.revision + 1 };
  const gate = gateResultState({ scene: input.scene, content: catalog, manifest: input.manifest }, resultScene, content);
  if (!gate.ok) return gate;
  const change: SetSaveSchemaChange = { type: 'setSaveSchema', previous, next };
  return { ok: true, op: { scene: gate.scene, content: gate.content, change, inverse: { kind: 'setSaveSchema', restore: previous } } };
}

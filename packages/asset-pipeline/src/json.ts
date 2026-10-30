/**
 * Strict JSON parsing of the GLB JSON chunk:
 * UTF-8 without replacement, no BOM, RFC 8259 syntax only, root must be an
 * object, and repeated member names **rejected** (decoded, per object).
 *
 * The shared strict parser does the work; the importer's own rules are that
 * a string decoding to an unpaired surrogate is a syntax error and that
 * objects are built with a null prototype, so a hostile `__proto__` member
 * becomes an ordinary own property instead of a prototype write.
 */
import { escapePointer, hasUtf8Bom, parseStrictJsonText } from '@thirdlight/shared';

export { escapePointer };

export type StrictJsonReason = 'bom' | 'encoding' | 'syntax' | 'duplicate';

export type StrictJsonResult =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly reason: StrictJsonReason; readonly path: string };

/** Strictly parse `bytes` as a JSON document; total (never throws). */
export function strictJsonParse(bytes: Uint8Array): StrictJsonResult {
  if (hasUtf8Bom(bytes)) return { ok: false, reason: 'bom', path: '' };
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return { ok: false, reason: 'encoding', path: '' };
  }
  try {
    const r = parseStrictJsonText(text, { nullPrototype: true, rejectLoneSurrogates: true });
    if (r.ok) return { ok: true, value: r.value };
    return r.kind === 'duplicate' ? { ok: false, reason: 'duplicate', path: r.pointer } : { ok: false, reason: 'syntax', path: '' };
  } catch {
    return { ok: false, reason: 'syntax', path: '' };
  }
}

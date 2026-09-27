/**
 * Phase 23.9a: inline rich text of project UI texts. The parser lives in
 * project-model since 23.16 (the dialogue runner in the simulation counts a
 * line's visible characters with the same rules); the host reads it through
 * the runtime.
 */
export { parseRichText, richTextVisibleLength, uiValueText, type RichStyle, type RichToken } from '@thirdlight/runtime';

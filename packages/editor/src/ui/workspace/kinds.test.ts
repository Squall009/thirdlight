import { describe, expect, it } from 'vitest';

import { ITEM_KIND_OF_DOCUMENT } from '../../session/project-items';
import { DOCUMENT_KINDS, documentIcon } from './kinds';

describe('the editor window document kinds', () => {
  it('each edits an item kind and has its picture from the icon registry', () => {
    for (const k of DOCUMENT_KINDS) {
      expect(ITEM_KIND_OF_DOCUMENT[k.kind], k.kind).toBeDefined();
      expect(documentIcon(k.kind), k.kind).toMatch(/^\.\/icons\/kinds\/[a-z-]+\.webp$/);
    }
  });
});

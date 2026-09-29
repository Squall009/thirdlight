/**
 * The glTF extension allowlist is defined once in project-model; the importer
 * (asset-pipeline) and the loader guard (three-adapter) re-export it. They
 * must agree, or a file would import but not render (or the other way round).
 */
import { describe, expect, it } from 'vitest';

import { M2_GLTF_EXTENSION_ALLOWLIST as PIPELINE } from '@thirdlight/asset-pipeline';
import { M2_GLTF_EXTENSION_ALLOWLIST as MODEL } from '@thirdlight/project-model';
import { GLTF_LOADER_ALLOWED_EXTENSIONS as LOADER } from '@thirdlight/three-adapter/gltf-loader';

describe('glTF extension allowlist', () => {
  it('is the same list in the importer, the model and the loader', () => {
    expect([...MODEL]).toEqual([...PIPELINE]);
    expect([...LOADER]).toEqual([...PIPELINE]);
    expect([...PIPELINE]).toEqual([...PIPELINE].sort());
  });
});

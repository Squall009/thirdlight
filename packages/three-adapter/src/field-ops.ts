/**
 * The shader side of arithmetic written once for the CPU and the GPU
 * (`@thirdlight/shared`'s `ScalarOps`): the same steps run on TSL nodes.
 */
import * as TSLTyped from 'three/tsl';
import type { ScalarOps } from '@thirdlight/shared';

import type { N } from './effects-tsl';

const TSL: N = TSLTyped;

export const TSL_SCALAR_OPS: ScalarOps<N, N> = {
  n: (v) => TSL.float(v),
  add: (a, b) => a.add(b),
  sub: (a, b) => a.sub(b),
  mul: (a, b) => a.mul(b),
  div: (a, b) => a.div(b),
  min: (a, b) => TSL.min(a, b),
  max: (a, b) => TSL.max(a, b),
  sqrt: (a) => TSL.sqrt(a),
  floor: (a) => TSL.floor(a),
  lt: (a, b) => a.lessThan(b),
  select: (c, a, b) => TSL.select(c, a, b),
};

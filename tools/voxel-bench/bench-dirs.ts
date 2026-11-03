/**
 * Where a benchmark writes by default: one folder a bench, named after the
 * bench (`~/.cache/thirdlight-voxel-bench/<bench>`), on disk and never in
 * /tmp. A run that should keep its report elsewhere passes `--out`.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';

export function benchDir(bench: string, ...sub: string[]): string {
  return join(homedir(), '.cache', 'thirdlight-voxel-bench', bench, ...sub);
}

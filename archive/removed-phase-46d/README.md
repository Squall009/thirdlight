# Removed in phase 46d

- `voxel-far-half.ts`: the far bricks marched at half resolution and composited into the frame (the voxel world
  page's `?farRes=half`). Built as a switch for the high tier's misses; never needed (low's room at 30 Hz with the
  visibility pass sufficed), never reused the last frame (D574), so it stepped silhouettes and shimmered. Retired
  with the review of 46d-b (L7). The far bricks shade in the visibility pass (WebGPU) or each fragment (WebGL 2).

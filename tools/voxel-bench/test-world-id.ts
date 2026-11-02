/** A world id for test worlds (fixed bytes: the files are test data); browser-safe, so pages reading test files can check it. */
export const TEST_WORLD_ID = Uint8Array.from({ length: 16 }, (_, i) => (i * 29 + 7) & 0xff);

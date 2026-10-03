/**
 * The part of the `EmscriptenWasm` namespace that `@jsquash/webp`'s typings
 * name. The package declares it in a file its typings do not reference, so a
 * package compiling the backend would not see it; this is the subset the
 * backend uses (a module's WASM handed in, the module and its factory).
 */
declare namespace EmscriptenWasm {
  interface ModuleOpts {
    /** Emscripten calls this instead of fetching the WASM; `done` takes the instance. */
    instantiateWasm: (imports: WebAssembly.Imports, done: (instance: WebAssembly.Instance) => void) => WebAssembly.Exports;
  }
  /** The package's typings extend it; nothing of it is used here. */
  interface Module {}
  type ModuleFactory<T extends Module = Module> = (moduleOverrides?: Partial<ModuleOpts>) => Promise<T>;
}

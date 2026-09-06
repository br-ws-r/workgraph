import { createWorkgraphHostExtension, type WorkgraphExtensionOptions } from "./extension.js";

export type WorkgraphPiOptions = WorkgraphExtensionOptions;
export function createWorkgraphExtension(options: WorkgraphPiOptions = {}) {
  return createWorkgraphHostExtension("pi", options);
}
// Preserve the factory exported by the first OMP-compatible release.
export { createWorkgraphOmpExtension } from "./omp.js";
export default createWorkgraphExtension();

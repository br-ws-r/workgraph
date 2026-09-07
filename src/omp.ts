import { createWorkgraphHostExtension, type WorkgraphExtensionOptions } from "./extension.js";

export function createWorkgraphOmpExtension(options: WorkgraphExtensionOptions = {}) {
  return createWorkgraphHostExtension("omp", options);
}
export default createWorkgraphOmpExtension();

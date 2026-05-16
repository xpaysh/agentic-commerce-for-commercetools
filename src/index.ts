/**
 * Public package entry. Exports the adapter + the request handler factory
 * for use as a library (e.g. embedded in another Node service or invoked
 * from a commercetools Connect entry point).
 */

export { CommercetoolsAdapter, NotImplementedError } from "./adapter";
export type { CommercetoolsAdapterOptions } from "./adapter";
export { CommercetoolsClient, CommercetoolsError } from "./ct-client";
export { loadConfig } from "./config";
export type { AppConfig, CommercetoolsCredentials } from "./config";
export { buildHandler } from "./server";
export * as mappers from "./mappers";

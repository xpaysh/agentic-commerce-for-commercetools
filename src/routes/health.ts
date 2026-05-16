import type { CommercetoolsClient } from "../ct-client";
import type { RouteHandler } from "./types";

export function buildHealthRoute(ct: CommercetoolsClient, version: string): RouteHandler {
  return async () => {
    let ctReachable = false;
    let ctError: string | undefined;
    try {
      // Cheap reachability probe — list one product.
      await ct.fetchJson("/product-projections/search?limit=1");
      ctReachable = true;
    } catch (err) {
      ctError = err instanceof Error ? err.message : String(err);
    }
    return {
      status: ctReachable ? 200 : 503,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
      },
      body: JSON.stringify({
        ok: ctReachable,
        commercetools_reachable: ctReachable,
        commercetools_error: ctError,
        version,
        ts: new Date().toISOString(),
      }),
    };
  };
}

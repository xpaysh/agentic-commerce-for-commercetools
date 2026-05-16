#!/usr/bin/env node
/**
 * Standalone HTTP server — runs the agentic-commerce service alongside the
 * merchant's commercetools storefront. Same handler logic works as a
 * commercetools Connect application or behind any reverse proxy.
 *
 * Routes:
 *
 *   GET /healthz                           liveness + commercetools reachability
 *   GET /llms.txt                          llmstxt.org discovery
 *   GET /.well-known/ucp                   UCP business profile (Google + Shopify + … fetch this)
 *   GET /robots.txt                        AI-crawler allow blocks (template; storefront merges)
 *   GET /.well-known/oauth-protected-resource    RFC 9728 (opt-in via EMIT_OAUTH_PROTECTED_RESOURCE)
 *   GET /.well-known/agent-card.json       A2A 1.0 (opt-in via EMIT_AGENT_CARD)
 *   GET /api/v1/jsonld/product/:id         schema.org Product JSON-LD (storefront embeds)
 *   GET /cart/deeplink?token=<jwt>         redeem cart-deeplink → CT cart → 302 to checkout
 */

import http from "node:http";
import { URL } from "node:url";

import { loadConfig } from "./config";
import { CommercetoolsClient } from "./ct-client";
import { CommercetoolsAdapter } from "./adapter";
import { buildDiscoveryRoutes } from "./routes/discovery";
import { buildJsonLdRoute } from "./routes/jsonld";
import { buildCartDeeplinkRoute } from "./routes/cart-deeplink";
import { buildHealthRoute } from "./routes/health";
import type { RouteHandler, RouteRequest, RouteResponse } from "./routes/types";

const VERSION = "0.1.0";

function buildHandler() {
  const config = loadConfig();
  const ct = new CommercetoolsClient(config.ct);
  const adapter = new CommercetoolsAdapter({ ct, siteUrl: config.siteUrl });

  const exactRoutes: Record<string, RouteHandler> = {
    ...buildDiscoveryRoutes(config),
    "/healthz": buildHealthRoute(ct, VERSION),
    "/cart/deeplink": buildCartDeeplinkRoute(config, adapter),
  };

  const jsonLdRoute = buildJsonLdRoute(config, adapter);

  async function dispatch(req: RouteRequest): Promise<RouteResponse> {
    if (req.method !== "GET" && req.method !== "HEAD") {
      return {
        status: 405,
        headers: { "content-type": "application/json", "allow": "GET, HEAD" },
        body: JSON.stringify({ error: "method_not_allowed" }),
      };
    }
    const handler = exactRoutes[req.path];
    if (handler) return handler(req);

    if (req.path.startsWith("/api/v1/jsonld/product/")) {
      return jsonLdRoute(req);
    }

    return {
      status: 404,
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({ error: "not_found", path: req.path }),
    };
  }

  return { dispatch, config };
}

// ---------------------------------------------------------------------------
// Bare-Node HTTP entry
// ---------------------------------------------------------------------------

async function main() {
  const { dispatch, config } = buildHandler();

  const server = http.createServer(async (req, res) => {
    const started = Date.now();
    try {
      const u = new URL(req.url || "/", "http://placeholder.local/");
      const query: Record<string, string> = {};
      u.searchParams.forEach((v, k) => { query[k] = v; });
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.headers)) {
        if (typeof v === "string") headers[k.toLowerCase()] = v;
      }
      const out = await dispatch({
        method: req.method || "GET",
        path: u.pathname,
        query,
        headers,
      });
      res.writeHead(out.status, out.headers);
      res.end(out.body);
      logRequest(req.method, u.pathname, out.status, Date.now() - started);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "internal", message: msg }));
      logRequest(req.method, req.url, 500, Date.now() - started);
    }
  });

  server.listen(config.port, config.host, () => {
    // eslint-disable-next-line no-console
    console.log(`agentic-commerce-for-commercetools v${VERSION} listening on http://${config.host}:${config.port}`);
    // eslint-disable-next-line no-console
    console.log(`  merchant slug: ${config.merchantSlug}`);
    // eslint-disable-next-line no-console
    console.log(`  commercetools project: ${config.ct.projectKey}`);
    // eslint-disable-next-line no-console
    console.log(`  site url: ${config.siteUrl}`);
  });
}

function logRequest(method: string | undefined, path: string | undefined, status: number, durationMs: number) {
  // eslint-disable-next-line no-console
  console.log(`[${new Date().toISOString()}] ${method || "?"} ${path || "?"} → ${status} (${durationMs}ms)`);
}

// Allow `import { buildHandler }` from tests / Connect entry points
export { buildHandler };

// Run when invoked directly (CLI / Docker / Connect main)
if (require.main === module) {
  main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error("fatal:", err);
    process.exit(1);
  });
}

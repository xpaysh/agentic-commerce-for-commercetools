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
import { buildUcpRouteTable } from "./routes/ucp";
import { buildAcpRouteTable } from "./routes/acp";
import { buildAp2RouteTable } from "./routes/ap2";
import { withSigVerify } from "./middleware/sig-verify";
import type { RouteHandler, RouteRequest, RouteResponse } from "./routes/types";

const VERSION = "0.2.1";

function buildHandler() {
  const config = loadConfig();
  const ct = new CommercetoolsClient(config.ct);
  const adapter = new CommercetoolsAdapter({ ct, siteUrl: config.siteUrl });

  // Discovery + cart-deeplink + health + jsonld are exact-match (GET-only paths).
  const exactRoutes: Record<string, RouteHandler> = {
    ...buildDiscoveryRoutes(config),
    "/healthz": buildHealthRoute(ct, VERSION),
    "/cart/deeplink": buildCartDeeplinkRoute(config, adapter),
  };
  const jsonLdRoute = buildJsonLdRoute(config, adapter);

  // Protocol routes — one sub-table per protocol; iterate at dispatch time.
  // The route matcher (./routes/match.ts) supports path params + methods.
  const subTables = [
    buildUcpRouteTable(adapter),
    buildAcpRouteTable(adapter),
    buildAp2RouteTable(adapter, config.merchantSlug),
  ];

  async function dispatch(req: RouteRequest): Promise<RouteResponse> {
    // 1. Exact-match GET routes (discovery + health + cart-deeplink)
    if (req.method === "GET" || req.method === "HEAD") {
      const handler = exactRoutes[req.path];
      if (handler) return handler(req);

      if (req.path.startsWith("/api/v1/jsonld/product/")) {
        return jsonLdRoute(req);
      }
    }

    // 2. Protocol routes (UCP / ACP / AP2 — including POST / PATCH / GET with path params)
    for (const tbl of subTables) {
      const m = tbl.match(req.method, req.path);
      if (m) {
        req.params = m.params;
        return m.handler(req);
      }
    }

    // 3. 405 vs 404
    if (req.method !== "GET" && req.method !== "HEAD" && req.method !== "POST" && req.method !== "PATCH" && req.method !== "OPTIONS") {
      return {
        status: 405,
        headers: { "content-type": "application/json; charset=utf-8", "allow": "GET, HEAD, POST, PATCH" },
        body: JSON.stringify({ error: "method_not_allowed" }),
      };
    }

    return {
      status: 404,
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({ error: "not_found", path: req.path, method: req.method }),
    };
  }

  // Wrap dispatch with RFC 9421 signature verification on /ucp/* + /acp/* paths.
  // Off by default; flip VERIFY_UCP_SIGNATURES / VERIFY_ACP_SIGNATURES once signing
  // agents are registered. See src/middleware/sig-verify.ts.
  return { dispatch: withSigVerify(dispatch), config };
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
      const method = (req.method || "GET").toUpperCase();
      let body: string | undefined;
      if (method === "POST" || method === "PATCH" || method === "PUT" || method === "DELETE") {
        body = await readBody(req);
      }
      const out = await dispatch({ method, path: u.pathname, query, headers, body });
      res.writeHead(out.status, out.headers);
      res.end(out.body);
      logRequest(method, u.pathname, out.status, Date.now() - started);
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

/** Buffer the entire request body up to a sensible cap. POST endpoints in v0.2 receive JSON cart/checkout payloads; ~512 KB is more than enough headroom. */
function readBody(req: http.IncomingMessage, maxBytes = 512 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(new Error(`request body exceeds ${maxBytes} bytes`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
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

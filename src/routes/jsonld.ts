/**
 * Schema.org JSON-LD generator for product pages.
 *
 * commercetools is headless — there is no PDP HTML page coming from
 * commercetools itself. The merchant's storefront fetches this endpoint
 * server-side (or at build time) and embeds the returned JSON-LD inside
 * <script type="application/ld+json"> on each PDP.
 *
 *   GET /api/v1/jsonld/product/:id           → full Product + Offer + BuyAction
 *   GET /api/v1/jsonld/product/:id?slim=1    → BuyAction-only (use when the
 *                                              storefront already emits a
 *                                              Product block via SEO tooling)
 */

import { generateProductJsonLd, generateProductJsonLdSlim } from "@xpaysh/discovery";
import { CommercetoolsAdapter } from "../adapter";
import type { AppConfig } from "../config";
import type { RouteHandler, RouteResponse } from "./types";

export function buildJsonLdRoute(config: AppConfig, adapter: CommercetoolsAdapter): RouteHandler {
  return async (req): Promise<RouteResponse> => {
    const m = /^\/api\/v1\/jsonld\/product\/([^/?]+)\/?$/.exec(req.path);
    if (!m) {
      return { status: 404, headers: { "content-type": "application/json" }, body: JSON.stringify({ error: "not found" }) };
    }
    const productId = decodeURIComponent(m[1]!);
    const slim = req.query.slim === "1" || req.query.slim === "true";

    const product = await adapter.getProduct(productId);
    if (!product) {
      return { status: 404, headers: { "content-type": "application/json" }, body: JSON.stringify({ error: "product not found" }) };
    }

    const url = product.url || `${config.siteUrl}product/${productId}`;
    const buyActionTarget = `${url}?add-to-cart=${productId}`;

    const ld = slim
      ? generateProductJsonLdSlim({
          url,
          sku: product.sku || product.id,
          buyActionTarget,
        })
      : generateProductJsonLd({
          url,
          name: product.name,
          sku: product.sku || product.id,
          description: product.description,
          images: product.images?.map((i) => i.url),
          price: centsToString(product.price?.amount),
          priceCurrency: product.price?.currency || "USD",
          inStock: product.variants[0]?.inStock !== false,
          buyActionTarget,
        });

    return {
      status: 200,
      headers: {
        "content-type": "application/ld+json; charset=utf-8",
        "cache-control": "public, max-age=60",
        "access-control-allow-origin": "*",
      },
      body: JSON.stringify(ld, null, 2),
    };
  };
}

function centsToString(amount: number | undefined): string | null {
  if (amount === undefined || amount === null) return null;
  return (amount / 100).toFixed(2);
}

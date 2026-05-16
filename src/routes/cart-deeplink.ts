/**
 * Cart-deeplink redemption — accepts a signed JWT from `?xpay_cart=<token>`,
 * verifies it, materialises a commercetools cart with the requested items,
 * and 302s to the merchant's existing checkout.
 *
 *   GET /cart/deeplink?token=<jwt>
 *
 * In production deployments the merchant's storefront typically owns
 * `https://merchant.example/?xpay_cart=<token>` and proxies that path to
 * this handler. The handler is platform-agnostic — it returns a redirect
 * URL the storefront can complete the cart-cookie set on.
 */

import { verifyCartDeeplink } from "@xpaysh/cart-deeplinks";
import type { AppConfig } from "../config";
import type { CommercetoolsAdapter } from "../adapter";
import type { RouteHandler } from "./types";

export function buildCartDeeplinkRoute(config: AppConfig, adapter: CommercetoolsAdapter): RouteHandler {
  return async (req) => {
    const token = req.query.token || req.query.xpay_cart;
    if (!token) {
      return badRequest("token query parameter required (?token=<jwt> or ?xpay_cart=<jwt>)");
    }

    const result = verifyCartDeeplink(token, {
      apiKey: config.xpayApiKey,
      expectedMerchant: config.merchantSlug,
    });

    if (!result.ok) {
      return {
        status: result.error === "token expired" ? 410 : 400,
        headers: { "content-type": "application/json; charset=utf-8" },
        body: JSON.stringify({
          error: "cart_deeplink_rejected",
          reason: result.error,
        }),
      };
    }

    const { payload } = result;

    let cart;
    try {
      cart = await adapter.createCart({
        items: payload.items.map((it) => ({
          sku: it.sku,
          quantity: it.qty || 1,
          variantId: it.variation_id ? String(it.variation_id) : undefined,
        })),
        externalId: payload.cart_id,
      });
    } catch (err) {
      return {
        status: 500,
        headers: { "content-type": "application/json; charset=utf-8" },
        body: JSON.stringify({
          error: "create_cart_failed",
          detail: err instanceof Error ? err.message : String(err),
        }),
      };
    }

    // commercetools carts are anonymous by default — the storefront needs to
    // associate the new cart with the buyer's session. We expose the cart id
    // via a header AND a redirect query param; the storefront's checkout
    // page picks it up and calls commercetools to attach the session.
    const checkoutUrl = new URL(config.checkoutPath, config.siteUrl);
    checkoutUrl.searchParams.set("xpay_cart_id", cart.id);
    if (payload.agent) checkoutUrl.searchParams.set("xpay_agent", payload.agent);
    if (payload.surface) checkoutUrl.searchParams.set("xpay_surface", payload.surface);

    return {
      status: 302,
      headers: {
        location: checkoutUrl.toString(),
        "x-xpay-cart-id": cart.id,
        "x-xpay-cart-items": String(cart.items.length),
      },
      body: "",
    };
  };
}

function badRequest(message: string) {
  return {
    status: 400,
    headers: { "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify({ error: "bad_request", message }),
  };
}

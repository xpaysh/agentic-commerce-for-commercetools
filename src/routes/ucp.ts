/**
 * UCP REST endpoints — cart, checkout, catalog, order.
 *
 * Spec: https://ucp.dev/ — these are the endpoints advertised in the merchant's
 * /.well-known/ucp profile under `services.dev.ucp.shopping[0].endpoint`.
 *
 * Wire shapes follow UCP's request/response conventions (snake_case JSON,
 * SKU + quantity in cart items, ISO-currency money). Internal value types
 * are the @xpaysh/adapter-contract enums; this file's job is the wire ↔
 * contract translation.
 *
 * Request integrity: UCP requires RFC 9421 HTTP Message Signatures on
 * inbound requests. v0.2 wires verification through a configurable
 * middleware (defaults to off — turn on with VERIFY_UCP_SIGNATURES=1 once
 * signing_keys are populated in the merchant's UCP profile and the agent
 * platform is signing).
 */

import { RouteTable } from "./match";
import type { RouteHandler, RouteRequest, RouteResponse } from "./types";
import type { CommercetoolsAdapter } from "../adapter";
import type {
  Cart,
  Order,
  Product,
  ProductQuery,
} from "@xpaysh/adapter-contract";

export function buildUcpRouteTable(adapter: CommercetoolsAdapter): RouteTable<RouteHandler> {
  const table = new RouteTable<RouteHandler>();

  // -------- Catalog --------
  table.add("GET", "/api/ucp/v1/catalog/search", catalogSearch(adapter));
  table.add("GET", "/api/ucp/v1/catalog/products/:id", catalogLookup(adapter));

  // -------- Cart --------
  table.add("POST", "/api/ucp/v1/carts", createCart(adapter));
  table.add("GET",  "/api/ucp/v1/carts/:id", getCart(adapter));
  table.add("PATCH", "/api/ucp/v1/carts/:id", updateCart(adapter));

  // -------- Checkout --------
  table.add("POST", "/api/ucp/v1/checkout", checkout(adapter));

  // -------- Order --------
  table.add("GET", "/api/ucp/v1/orders/:id", getOrder(adapter));

  return table;
}

// ---------------------------------------------------------------------------
// Wire helpers
// ---------------------------------------------------------------------------

function jsonResponse(status: number, body: unknown): RouteResponse {
  return {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify(body, null, 2),
  };
}

function parseBody(req: RouteRequest): unknown {
  if (!req.body) return null;
  try { return JSON.parse(req.body); } catch { return null; }
}

function bad(status: number, code: string, message: string): RouteResponse {
  return jsonResponse(status, { error: { code, message } });
}

/** Wire shape — UCP product representation (snake_case + minor-units money). */
interface UcpProduct {
  id: string;
  sku?: string;
  name: string;
  description?: string;
  url?: string;
  price?: { amount: number; currency: string };
  images?: Array<{ url: string }>;
  in_stock: boolean;
  variants: Array<{
    id: string;
    sku: string;
    price?: { amount: number; currency: string };
    in_stock: boolean;
    attributes?: Record<string, string | number | boolean>;
  }>;
}

function toUcpProduct(p: Product): UcpProduct {
  const head = p.variants[0];
  return {
    id: p.id,
    sku: p.sku,
    name: p.name,
    description: p.description,
    url: p.url,
    price: p.price ? { amount: p.price.amount, currency: p.price.currency } : undefined,
    images: p.images?.map((i) => ({ url: i.url })),
    in_stock: head ? head.inStock : true,
    variants: p.variants.map((v) => ({
      id: v.id,
      sku: v.sku,
      price: v.price ? { amount: v.price.amount, currency: v.price.currency } : undefined,
      in_stock: v.inStock,
      attributes: v.attributes,
    })),
  };
}

interface UcpCart {
  id: string;
  items: Array<{
    sku: string;
    quantity: number;
    name: string;
    unit_price: { amount: number; currency: string };
    line_total: { amount: number; currency: string };
  }>;
  subtotal: { amount: number; currency: string };
  total?: { amount: number; currency: string } | null;
  tax?: { amount: number; currency: string } | null;
  updated_at?: string;
}

function toUcpCart(c: Cart): UcpCart {
  return {
    id: c.id,
    items: c.items.map((it) => ({
      sku: it.sku,
      quantity: it.quantity,
      name: it.name,
      unit_price: { amount: it.unitPrice.amount, currency: it.unitPrice.currency },
      line_total: { amount: it.lineTotal.amount, currency: it.lineTotal.currency },
    })),
    subtotal: { amount: c.subtotal.amount, currency: c.subtotal.currency },
    total: c.total ? { amount: c.total.amount, currency: c.total.currency } : null,
    tax: c.tax ? { amount: c.tax.amount, currency: c.tax.currency } : null,
    updated_at: c.updatedAt,
  };
}

interface UcpOrder {
  id: string;
  status: string;
  items: UcpCart["items"];
  subtotal: { amount: number; currency: string };
  total: { amount: number; currency: string };
  tax?: { amount: number; currency: string } | null;
  created_at: string;
  payment_status?: string;
}

function toUcpOrder(o: Order): UcpOrder {
  return {
    id: o.id,
    status: o.status,
    items: o.items.map((it) => ({
      sku: it.sku,
      quantity: it.quantity,
      name: it.name,
      unit_price: { amount: it.unitPrice.amount, currency: it.unitPrice.currency },
      line_total: { amount: it.lineTotal.amount, currency: it.lineTotal.currency },
    })),
    subtotal: { amount: o.subtotal.amount, currency: o.subtotal.currency },
    total: { amount: o.total.amount, currency: o.total.currency },
    tax: o.tax ? { amount: o.tax.amount, currency: o.tax.currency } : null,
    created_at: o.createdAt,
    payment_status: o.paymentStatus,
  };
}

// ---------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------

function catalogSearch(adapter: CommercetoolsAdapter): RouteHandler {
  return async (req): Promise<RouteResponse> => {
    const query: ProductQuery = {
      q: req.query.q,
      sku: req.query.sku,
      limit: req.query.limit ? parseInt(req.query.limit, 10) : undefined,
      cursor: req.query.cursor,
      category: req.query.category,
      sort: req.query.sort as ProductQuery["sort"],
    };
    try {
      const res = await adapter.listProducts(query);
      return jsonResponse(200, {
        results: res.items.map(toUcpProduct),
        next_cursor: res.nextCursor,
        total: res.total,
      });
    } catch (err) {
      return bad(500, "catalog_search_failed", err instanceof Error ? err.message : String(err));
    }
  };
}

function catalogLookup(adapter: CommercetoolsAdapter): RouteHandler {
  return async (req): Promise<RouteResponse> => {
    const id = req.params?.id;
    if (!id) return bad(400, "missing_id", "product id required in path");
    try {
      const product = await adapter.getProduct(id);
      if (!product) return bad(404, "product_not_found", `product ${id} not found`);
      return jsonResponse(200, toUcpProduct(product));
    } catch (err) {
      return bad(500, "catalog_lookup_failed", err instanceof Error ? err.message : String(err));
    }
  };
}

// ---------------------------------------------------------------------------
// Cart
// ---------------------------------------------------------------------------

function createCart(adapter: CommercetoolsAdapter): RouteHandler {
  return async (req): Promise<RouteResponse> => {
    const body = parseBody(req) as { items?: Array<{ sku: string; quantity?: number; variant_id?: string }>; currency?: string; external_id?: string } | null;
    if (!body || !Array.isArray(body.items) || body.items.length === 0) {
      return bad(400, "invalid_body", "items[] (non-empty) is required");
    }
    try {
      const cart = await adapter.createCart({
        items: body.items.map((it) => ({
          sku: it.sku,
          quantity: it.quantity ?? 1,
          variantId: it.variant_id,
        })),
        currency: body.currency,
        externalId: body.external_id,
      });
      return jsonResponse(201, toUcpCart(cart));
    } catch (err) {
      return bad(500, "create_cart_failed", err instanceof Error ? err.message : String(err));
    }
  };
}

function getCart(adapter: CommercetoolsAdapter): RouteHandler {
  return async (req): Promise<RouteResponse> => {
    const id = req.params?.id;
    if (!id) return bad(400, "missing_id", "cart id required in path");
    try {
      const cart = await adapter.getCart(id);
      if (!cart) return bad(404, "cart_not_found", `cart ${id} not found`);
      return jsonResponse(200, toUcpCart(cart));
    } catch (err) {
      return bad(500, "get_cart_failed", err instanceof Error ? err.message : String(err));
    }
  };
}

interface UcpCartMutation {
  set_items?: Array<{ sku: string; quantity: number; variant_id?: string }>;
  remove_skus?: string[];
  shipping_address?: import("@xpaysh/adapter-contract").Address;
  billing_address?: import("@xpaysh/adapter-contract").Address;
  discount_code?: string;
}

function updateCart(adapter: CommercetoolsAdapter): RouteHandler {
  return async (req): Promise<RouteResponse> => {
    const id = req.params?.id;
    if (!id) return bad(400, "missing_id", "cart id required in path");
    const body = (parseBody(req) || {}) as UcpCartMutation;
    try {
      const cart = await adapter.updateCart(id, {
        setItems: body.set_items?.map((it) => ({ sku: it.sku, quantity: it.quantity, variantId: it.variant_id })),
        removeSkus: body.remove_skus,
        shippingAddress: body.shipping_address,
        billingAddress: body.billing_address,
        discountCode: body.discount_code,
      });
      return jsonResponse(200, toUcpCart(cart));
    } catch (err) {
      return bad(500, "update_cart_failed", err instanceof Error ? err.message : String(err));
    }
  };
}

// ---------------------------------------------------------------------------
// Checkout
// ---------------------------------------------------------------------------

interface UcpCheckoutBody {
  cart_id: string;
  shipping_address?: import("@xpaysh/adapter-contract").Address;
  billing_address?: import("@xpaysh/adapter-contract").Address;
  payment?: Record<string, unknown>;
  note?: string;
}

function checkout(adapter: CommercetoolsAdapter): RouteHandler {
  return async (req): Promise<RouteResponse> => {
    const body = parseBody(req) as UcpCheckoutBody | null;
    if (!body || typeof body.cart_id !== "string") {
      return bad(400, "invalid_body", "cart_id (string) is required");
    }
    try {
      const order = await adapter.completeCheckout({
        cartId: body.cart_id,
        shippingAddress: body.shipping_address,
        billingAddress: body.billing_address,
        payment: body.payment,
        note: body.note,
      });
      return jsonResponse(201, toUcpOrder(order));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // UCP convention: structured error codes the agent can branch on
      if (msg.includes("not Active")) return bad(409, "cart_state_invalid", msg);
      return bad(500, "checkout_failed", msg);
    }
  };
}

// ---------------------------------------------------------------------------
// Order
// ---------------------------------------------------------------------------

function getOrder(adapter: CommercetoolsAdapter): RouteHandler {
  return async (req): Promise<RouteResponse> => {
    const id = req.params?.id;
    if (!id) return bad(400, "missing_id", "order id required in path");
    try {
      const order = await adapter.getOrder(id);
      if (!order) return bad(404, "order_not_found", `order ${id} not found`);
      return jsonResponse(200, toUcpOrder(order));
    } catch (err) {
      return bad(500, "get_order_failed", err instanceof Error ? err.message : String(err));
    }
  };
}

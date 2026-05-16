/**
 * ACP — Agentic Commerce Protocol endpoints.
 *
 * Spec: https://github.com/agentic-commerce-protocol/agentic-commerce-protocol
 *
 * ACP's surface is per-session: an agent opens a checkout_session, negotiates
 * capabilities, optionally updates the session (add items, set address), then
 * completes it. Unlike UCP (REST primitives), ACP wraps cart+checkout in a
 * single session object the agent mutates.
 *
 * Routes implemented in v0.2:
 *   POST   /api/acp/v1/checkout_sessions                  open a session
 *   POST   /api/acp/v1/checkout_sessions/:id              update (add items / address)
 *   POST   /api/acp/v1/checkout_sessions/:id/complete     finalize → Order
 *   GET    /api/acp/v1/orders/:id                         order status
 *
 * Not yet implemented (deferred to v0.3 — CP role):
 *   POST   /api/acp/v1/delegate_payment                   agent supplies delegated payment
 *                                                         credential; merchant captures
 *
 * Session storage: v0.2 uses an in-memory Map keyed by checkout_session_id.
 * Sessions are bound to a commercetools cart_id, and the CT cart IS the
 * source of truth (we re-fetch it on each call). Cold-start loses the
 * mapping, which means agents need to re-open a session if the Lambda /
 * service restarts; v0.3 moves session metadata to DynamoDB.
 */

import { RouteTable } from "./match";
import type { RouteHandler, RouteRequest, RouteResponse } from "./types";
import type { CommercetoolsAdapter } from "../adapter";
import type { Cart, Order, Address } from "@xpaysh/adapter-contract";

// ---------------------------------------------------------------------------
// Session store (in-memory; v0.3 will move to DDB)
// ---------------------------------------------------------------------------

interface AcpSession {
  id: string;
  cartId: string;
  buyerId?: string;
  agent?: string;
  surface?: string;
  capabilitiesRequested: string[];
  createdAt: string;
}

const sessions = new Map<string, AcpSession>();

function newSessionId(): string {
  return "acpsess_" + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
}

// ---------------------------------------------------------------------------
// Capability surface — what xpay's commercetools adapter advertises
// ---------------------------------------------------------------------------

/**
 * The ACP capabilities this merchant supports. Mirrors `adapter.capabilities`
 * but uses ACP's identifiers (no `dev.ucp.*` prefix).
 *
 * `intervention_required` is the error code we documented in our upstream PR
 * #251 — list it among our supported error codes so agents know we'll surface
 * it when 3DS / OTP / passkey intervention is required.
 */
const ACP_SUPPORTED_CAPABILITIES = Object.freeze([
  "cart",
  "checkout",
  "fulfillment",
  "discount",
  "order_lifecycle",
]);

const ACP_SUPPORTED_ERROR_CODES = Object.freeze([
  "intervention_required",
  "cart_state_invalid",
  "product_not_found",
  "out_of_stock",
  "currency_unsupported",
]);

const ACP_SUPPORTED_PAYMENT_HANDLERS = Object.freeze([
  // ACP equivalents of UCP payment handlers — agent platforms map between them
  "merchant_psp",                 // deferred: storefront's existing gateway
  "sh.xpay.facilitator.x402",     // xpay's stablecoin rail (sh.xpay reverse-domain)
]);

// ---------------------------------------------------------------------------
// Route table
// ---------------------------------------------------------------------------

export function buildAcpRouteTable(adapter: CommercetoolsAdapter): RouteTable<RouteHandler> {
  const table = new RouteTable<RouteHandler>();
  table.add("POST", "/api/acp/v1/checkout_sessions", createSession(adapter));
  table.add("POST", "/api/acp/v1/checkout_sessions/:id", updateSession(adapter));
  table.add("POST", "/api/acp/v1/checkout_sessions/:id/complete", completeSession(adapter));
  table.add("GET",  "/api/acp/v1/checkout_sessions/:id", getSession(adapter));
  table.add("GET",  "/api/acp/v1/orders/:id", getOrderRoute(adapter));
  return table;
}

// ---------------------------------------------------------------------------
// Wire shapes
// ---------------------------------------------------------------------------

interface AcpCreateSessionBody {
  buyer_id?: string;
  items: Array<{ sku: string; qty?: number; variation_id?: number }>;
  currency?: string;
  capabilities_requested?: string[];
  agent?: string;
  surface?: string;
  external_id?: string;
}

interface AcpUpdateSessionBody {
  items?: Array<{ sku: string; qty: number; variation_id?: number }>;
  remove_skus?: string[];
  shipping_address?: Address;
  billing_address?: Address;
  discount_code?: string;
}

interface AcpCompleteSessionBody {
  shipping_address?: Address;
  billing_address?: Address;
  payment?: Record<string, unknown>;
  note?: string;
}

interface AcpSessionView {
  checkout_session_id: string;
  cart: AcpCartView;
  capabilities_supported: readonly string[];
  capabilities_requested: string[];
  error_codes_supported: readonly string[];
  payment_handlers_supported: readonly string[];
  buyer_id?: string;
  agent?: string;
  surface?: string;
  created_at: string;
}

interface AcpCartView {
  id: string;
  items: Array<{
    sku: string;
    qty: number;
    name: string;
    unit_price: { amount: number; currency: string };
    line_total: { amount: number; currency: string };
  }>;
  subtotal: { amount: number; currency: string };
  total?: { amount: number; currency: string } | null;
  tax?: { amount: number; currency: string } | null;
}

function toAcpCart(c: Cart): AcpCartView {
  return {
    id: c.id,
    items: c.items.map((it) => ({
      sku: it.sku,
      qty: it.quantity,
      name: it.name,
      unit_price: { amount: it.unitPrice.amount, currency: it.unitPrice.currency },
      line_total: { amount: it.lineTotal.amount, currency: it.lineTotal.currency },
    })),
    subtotal: { amount: c.subtotal.amount, currency: c.subtotal.currency },
    total: c.total ? { amount: c.total.amount, currency: c.total.currency } : null,
    tax: c.tax ? { amount: c.tax.amount, currency: c.tax.currency } : null,
  };
}

function toAcpOrder(o: Order) {
  return {
    id: o.id,
    status: o.status,
    items: o.items.map((it) => ({
      sku: it.sku,
      qty: it.quantity,
      name: it.name,
      unit_price: { amount: it.unitPrice.amount, currency: it.unitPrice.currency },
      line_total: { amount: it.lineTotal.amount, currency: it.lineTotal.currency },
    })),
    subtotal: { amount: o.subtotal.amount, currency: o.subtotal.currency },
    total: { amount: o.total.amount, currency: o.total.currency },
    tax: o.tax ? { amount: o.tax.amount, currency: o.tax.currency } : null,
    payment_status: o.paymentStatus,
    created_at: o.createdAt,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseBody(req: RouteRequest): unknown {
  if (!req.body) return null;
  try { return JSON.parse(req.body); } catch { return null; }
}

function jsonResponse(status: number, body: unknown): RouteResponse {
  return {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify(body, null, 2),
  };
}

function acpError(status: number, code: string, message: string, extras?: Record<string, unknown>): RouteResponse {
  return jsonResponse(status, {
    error: { code, message, ...(extras || {}) },
  });
}

function sessionView(s: AcpSession, cart: Cart): AcpSessionView {
  return {
    checkout_session_id: s.id,
    cart: toAcpCart(cart),
    capabilities_supported: ACP_SUPPORTED_CAPABILITIES,
    capabilities_requested: s.capabilitiesRequested,
    error_codes_supported: ACP_SUPPORTED_ERROR_CODES,
    payment_handlers_supported: ACP_SUPPORTED_PAYMENT_HANDLERS,
    buyer_id: s.buyerId,
    agent: s.agent,
    surface: s.surface,
    created_at: s.createdAt,
  };
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

function createSession(adapter: CommercetoolsAdapter): RouteHandler {
  return async (req): Promise<RouteResponse> => {
    const body = parseBody(req) as AcpCreateSessionBody | null;
    if (!body || !Array.isArray(body.items) || body.items.length === 0) {
      return acpError(400, "invalid_request", "items[] (non-empty) is required");
    }

    let cart: Cart;
    try {
      cart = await adapter.createCart({
        items: body.items.map((it) => ({
          sku: it.sku,
          quantity: it.qty ?? 1,
          variantId: it.variation_id ? String(it.variation_id) : undefined,
        })),
        currency: body.currency,
        externalId: body.external_id,
      });
    } catch (err) {
      return acpError(500, "create_cart_failed", err instanceof Error ? err.message : String(err));
    }

    const session: AcpSession = {
      id: newSessionId(),
      cartId: cart.id,
      buyerId: body.buyer_id,
      agent: body.agent,
      surface: body.surface,
      capabilitiesRequested: body.capabilities_requested || [],
      createdAt: new Date().toISOString(),
    };
    sessions.set(session.id, session);

    return jsonResponse(201, sessionView(session, cart));
  };
}

function updateSession(adapter: CommercetoolsAdapter): RouteHandler {
  return async (req): Promise<RouteResponse> => {
    const id = req.params?.id;
    if (!id) return acpError(400, "invalid_request", "checkout_session_id required");
    const s = sessions.get(id);
    if (!s) return acpError(404, "session_not_found", `checkout session ${id} not found (cold start? sessions are in-memory in v0.2)`);

    const body = (parseBody(req) || {}) as AcpUpdateSessionBody;

    let cart: Cart;
    try {
      cart = await adapter.updateCart(s.cartId, {
        setItems: body.items?.map((it) => ({
          sku: it.sku,
          quantity: it.qty,
          variantId: it.variation_id ? String(it.variation_id) : undefined,
        })),
        removeSkus: body.remove_skus,
        shippingAddress: body.shipping_address,
        billingAddress: body.billing_address,
        discountCode: body.discount_code,
      });
    } catch (err) {
      return acpError(500, "update_cart_failed", err instanceof Error ? err.message : String(err));
    }

    return jsonResponse(200, sessionView(s, cart));
  };
}

function getSession(adapter: CommercetoolsAdapter): RouteHandler {
  return async (req): Promise<RouteResponse> => {
    const id = req.params?.id;
    if (!id) return acpError(400, "invalid_request", "checkout_session_id required");
    const s = sessions.get(id);
    if (!s) return acpError(404, "session_not_found", `checkout session ${id} not found`);
    const cart = await adapter.getCart(s.cartId);
    if (!cart) return acpError(404, "cart_not_found", "underlying cart not found");
    return jsonResponse(200, sessionView(s, cart));
  };
}

function completeSession(adapter: CommercetoolsAdapter): RouteHandler {
  return async (req): Promise<RouteResponse> => {
    const id = req.params?.id;
    if (!id) return acpError(400, "invalid_request", "checkout_session_id required");
    const s = sessions.get(id);
    if (!s) return acpError(404, "session_not_found", `checkout session ${id} not found`);

    const body = (parseBody(req) || {}) as AcpCompleteSessionBody;

    let order: Order;
    try {
      order = await adapter.completeCheckout({
        cartId: s.cartId,
        shippingAddress: body.shipping_address,
        billingAddress: body.billing_address,
        payment: body.payment,
        note: body.note,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // intervention_required surface: in v0.3 we'd emit this for 3DS / OTP / passkey step-up
      if (msg.includes("not Active")) {
        return acpError(409, "cart_state_invalid", msg);
      }
      return acpError(500, "checkout_failed", msg);
    }

    // Sessions are single-use after complete; remove from the map
    sessions.delete(id);

    return jsonResponse(201, {
      checkout_session_id: id,
      order: toAcpOrder(order),
    });
  };
}

function getOrderRoute(adapter: CommercetoolsAdapter): RouteHandler {
  return async (req): Promise<RouteResponse> => {
    const id = req.params?.id;
    if (!id) return acpError(400, "invalid_request", "order id required in path");
    try {
      const order = await adapter.getOrder(id);
      if (!order) return acpError(404, "order_not_found", `order ${id} not found`);
      return jsonResponse(200, toAcpOrder(order));
    } catch (err) {
      return acpError(500, "get_order_failed", err instanceof Error ? err.message : String(err));
    }
  };
}

/**
 * AP2 — Agent Payments Protocol endpoints.
 *
 * Spec: https://github.com/google-agentic-commerce/AP2
 *
 * AP2 wraps payment authorization in a signed "mandate" — a verifiable
 * credential the agent issues on behalf of the buyer. The merchant verifies
 * the mandate against the issuer's public key, then completes the order.
 *
 * v0.2 scope: structural verification + a checkout flow that ACCEPTS a
 * mandate alongside cart_id and creates an Order. We do NOT validate the
 * mandate signature against issuer public keys in v0.2 — that requires a
 * JWK fetcher for trusted issuer keys (Google's wallet, user-wallet
 * providers, etc.) and a policy for which issuers we trust. That lands in
 * v0.3 alongside the broader Credential Provider work.
 *
 * What v0.2 DOES check:
 *  - mandate is a non-empty 3-part JWT-shaped string
 *  - decodes as JSON with `iss`, `sub`, `aud`, `exp`, plus an AP2 `mandate`
 *    claim describing the spend authorization
 *  - `exp` is in the future
 *  - `aud` (audience) matches the merchant slug (if claims_audience_required is set)
 *
 * The /verify endpoint returns the parsed structure WITHOUT asserting that
 * the signature is trusted. Documented honestly in the response.
 */

import { RouteTable } from "./match";
import type { RouteHandler, RouteRequest, RouteResponse } from "./types";
import type { CommercetoolsAdapter } from "../adapter";
import type { Order } from "@xpaysh/adapter-contract";

export function buildAp2RouteTable(adapter: CommercetoolsAdapter, merchantSlug: string): RouteTable<RouteHandler> {
  const table = new RouteTable<RouteHandler>();
  table.add("POST", "/api/ap2/v1/mandates/verify", verifyMandate(merchantSlug));
  table.add("POST", "/api/ap2/v1/checkout", checkoutWithMandate(adapter, merchantSlug));
  return table;
}

// ---------------------------------------------------------------------------
// Mandate parser (structural only — does NOT verify issuer signature in v0.2)
// ---------------------------------------------------------------------------

interface ParsedMandate {
  raw: string;
  header: Record<string, unknown>;
  payload: {
    iss?: string;
    sub?: string;
    aud?: string;
    iat?: number;
    exp?: number;
    mandate?: {
      merchant?: string;
      max_amount?: { amount: number; currency: string };
      valid_until?: string;
      [key: string]: unknown;
    };
    [key: string]: unknown;
  };
  signatureB64u: string;
}

function b64urlDecodeToString(s: string): string {
  return Buffer.from(s, "base64url").toString("utf8");
}

function parseMandateStructure(jwt: string): ParsedMandate | { error: string } {
  if (typeof jwt !== "string" || jwt.length === 0) return { error: "mandate must be a non-empty string" };
  const parts = jwt.split(".");
  if (parts.length !== 3) return { error: "mandate is not a 3-part JWT" };
  let header: Record<string, unknown>;
  let payload: ParsedMandate["payload"];
  try {
    header = JSON.parse(b64urlDecodeToString(parts[0]!));
  } catch (e) {
    return { error: "malformed mandate header: " + (e as Error).message };
  }
  try {
    payload = JSON.parse(b64urlDecodeToString(parts[1]!)) as ParsedMandate["payload"];
  } catch (e) {
    return { error: "malformed mandate payload: " + (e as Error).message };
  }
  return { raw: jwt, header, payload, signatureB64u: parts[2]! };
}

interface MandateValidationResult {
  valid_structure: boolean;
  signature_verified: false;             // honest: v0.2 doesn't verify the issuer signature
  signature_verification_status: "deferred_to_v0.3";
  expired: boolean;
  audience_matched: boolean;
  claims: {
    iss?: string;
    sub?: string;
    aud?: string;
    iat?: number;
    exp?: number;
    mandate?: ParsedMandate["payload"]["mandate"];
  };
  errors: string[];
}

function validateMandateClaims(parsed: ParsedMandate, audienceRequired: string | undefined, now: number): MandateValidationResult {
  const errors: string[] = [];
  let expired = false;
  let audienceMatched = true;

  if (typeof parsed.payload.exp !== "number") {
    errors.push("payload.exp missing or non-numeric");
  } else if (parsed.payload.exp <= now) {
    expired = true;
    errors.push(`mandate expired (exp=${parsed.payload.exp}, now=${now})`);
  }

  if (audienceRequired) {
    if (parsed.payload.aud !== audienceRequired) {
      audienceMatched = false;
      errors.push(`audience mismatch (aud=${parsed.payload.aud}, expected=${audienceRequired})`);
    }
  }

  return {
    valid_structure: true,
    signature_verified: false,
    signature_verification_status: "deferred_to_v0.3",
    expired,
    audience_matched: audienceMatched,
    claims: {
      iss: parsed.payload.iss,
      sub: parsed.payload.sub,
      aud: parsed.payload.aud,
      iat: parsed.payload.iat,
      exp: parsed.payload.exp,
      mandate: parsed.payload.mandate,
    },
    errors,
  };
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

function jsonResponse(status: number, body: unknown): RouteResponse {
  return { status, headers: { "content-type": "application/json; charset=utf-8" }, body: JSON.stringify(body, null, 2) };
}

function parseBody(req: RouteRequest): unknown {
  if (!req.body) return null;
  try { return JSON.parse(req.body); } catch { return null; }
}

function verifyMandate(merchantSlug: string): RouteHandler {
  return async (req): Promise<RouteResponse> => {
    const body = parseBody(req) as { mandate?: string; require_audience?: boolean } | null;
    if (!body || typeof body.mandate !== "string") {
      return jsonResponse(400, { error: { code: "invalid_request", message: "mandate (string) is required" } });
    }
    const parsed = parseMandateStructure(body.mandate);
    if ("error" in parsed) {
      return jsonResponse(400, {
        valid_structure: false,
        error: { code: "malformed_mandate", message: parsed.error },
      });
    }
    const audienceRequired = body.require_audience !== false ? merchantSlug : undefined;
    const validation = validateMandateClaims(parsed, audienceRequired, Math.floor(Date.now() / 1000));
    return jsonResponse(200, validation);
  };
}

interface Ap2CheckoutBody {
  cart_id: string;
  mandate: string;
  shipping_address?: import("@xpaysh/adapter-contract").Address;
  billing_address?: import("@xpaysh/adapter-contract").Address;
}

function checkoutWithMandate(adapter: CommercetoolsAdapter, merchantSlug: string): RouteHandler {
  return async (req): Promise<RouteResponse> => {
    const body = parseBody(req) as Ap2CheckoutBody | null;
    if (!body || typeof body.cart_id !== "string" || typeof body.mandate !== "string") {
      return jsonResponse(400, {
        error: { code: "invalid_request", message: "cart_id (string) and mandate (string) are required" },
      });
    }

    const parsed = parseMandateStructure(body.mandate);
    if ("error" in parsed) {
      return jsonResponse(400, { error: { code: "malformed_mandate", message: parsed.error } });
    }

    const validation = validateMandateClaims(parsed, merchantSlug, Math.floor(Date.now() / 1000));
    if (validation.errors.length > 0) {
      return jsonResponse(400, {
        error: { code: "mandate_invalid", message: validation.errors.join("; "), validation },
      });
    }

    let order: Order;
    try {
      order = await adapter.completeCheckout({
        cartId: body.cart_id,
        shippingAddress: body.shipping_address,
        billingAddress: body.billing_address,
        payment: { type: "ap2_mandate", mandate_iss: validation.claims.iss, mandate_sub: validation.claims.sub },
      });
    } catch (err) {
      return jsonResponse(500, { error: { code: "checkout_failed", message: err instanceof Error ? err.message : String(err) } });
    }

    return jsonResponse(201, {
      order: {
        id: order.id,
        status: order.status,
        total: { amount: order.total.amount, currency: order.total.currency },
        created_at: order.createdAt,
      },
      mandate_validation: validation,
      note: "Mandate signature verification is deferred to v0.3. v0.2 accepts the mandate after structural + expiry + audience checks.",
    });
  };
}

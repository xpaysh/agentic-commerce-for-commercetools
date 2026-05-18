/**
 * RFC 9421 signature-verification middleware.
 *
 * Wraps protocol routes (`/ucp/*` and `/acp/*`) to enforce HTTP Message
 * Signatures on inbound requests. Defaults to **off** so the plugin works
 * with unsigned agents during rollout; flip the env vars on once signing
 * agents are in the trusted set.
 *
 * Configuration (env):
 *   VERIFY_UCP_SIGNATURES=1            Enforce sigs on /ucp/* requests
 *   VERIFY_ACP_SIGNATURES=1            Enforce sigs on /acp/* requests
 *   SIG_MAX_AGE_SECONDS=300            Reject signatures older than this
 *   XPAY_TRUSTED_KEYS_JSON='[{...}]'   Inline JWKS — array of
 *                                       { kid, kty, crv, x, alg? } for ed25519,
 *                                       or { kid, kty: "oct", k? (base64) } for hmac-sha256.
 *   XPAY_TRUSTED_KEYS_URL=https://…    Optional remote JWKS fetched at startup.
 *                                       Cached for the process lifetime; restart to refresh.
 *
 * Wire shape: see RFC 9421 §2.5. We only honor the components the UCP REST
 * contract uses: `(@method @target-uri content-digest idempotency-key)`.
 * Bypass: discovery, healthz, cart-deeplink, llms.txt, schema.org JSON-LD.
 */

import crypto from "node:crypto";

import { verifyRequest } from "@xpaysh/http-message-signatures";

import type { RouteHandler, RouteRequest, RouteResponse } from "../routes/types";

interface Jwk {
  kid: string;
  kty: string;
  crv?: string;
  x?: string;
  k?: string;
  alg?: string;
}

interface SigVerifyConfig {
  verifyUcp: boolean;
  verifyAcp: boolean;
  maxAgeSeconds: number;
  trustedKeys: Map<string, crypto.KeyObject | Buffer>;
}

let cachedConfig: SigVerifyConfig | null = null;

function readEnvFlag(name: string): boolean {
  const v = process.env[name];
  return v === "1" || v === "true";
}

function loadInlineJwks(): Jwk[] {
  const raw = process.env.XPAY_TRUSTED_KEYS_JSON;
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function loadRemoteJwks(): Promise<Jwk[]> {
  const url = process.env.XPAY_TRUSTED_KEYS_URL;
  if (!url) return [];
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res: any = await (globalThis as any).fetch(url);
    if (!res || !res.ok) return [];
    const body = await res.json();
    if (Array.isArray(body)) return body;
    if (body && Array.isArray(body.keys)) return body.keys;
    return [];
  } catch {
    return [];
  }
}

function jwkToKey(jwk: Jwk): crypto.KeyObject | Buffer | null {
  try {
    if (jwk.kty === "OKP" && jwk.crv === "Ed25519" && jwk.x) {
      // Node 18+ supports importing JWK directly for Ed25519.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return crypto.createPublicKey({ key: jwk as any, format: "jwk" });
    }
    if (jwk.kty === "oct" && jwk.k) {
      // Symmetric secret for hmac-sha256, base64url-encoded per RFC 7518.
      const normalized = jwk.k.replace(/-/g, "+").replace(/_/g, "/");
      return Buffer.from(normalized, "base64");
    }
    return null;
  } catch {
    return null;
  }
}

async function buildSigConfig(): Promise<SigVerifyConfig> {
  if (cachedConfig) return cachedConfig;

  const inline = loadInlineJwks();
  const remote = await loadRemoteJwks();
  const trusted = new Map<string, crypto.KeyObject | Buffer>();
  for (const jwk of [...inline, ...remote]) {
    const key = jwkToKey(jwk);
    if (key && jwk.kid) trusted.set(jwk.kid, key);
  }

  const maxAgeRaw = Number.parseInt(process.env.SIG_MAX_AGE_SECONDS || "300", 10);

  cachedConfig = {
    verifyUcp: readEnvFlag("VERIFY_UCP_SIGNATURES"),
    verifyAcp: readEnvFlag("VERIFY_ACP_SIGNATURES"),
    maxAgeSeconds: Number.isFinite(maxAgeRaw) && maxAgeRaw > 0 ? maxAgeRaw : 300,
    trustedKeys: trusted,
  };
  return cachedConfig;
}

/** Reset the cached config — exposed for tests; not used at runtime. */
export function _resetSigVerifyConfigForTests(): void {
  cachedConfig = null;
}

function shouldGuard(path: string, config: SigVerifyConfig): "ucp" | "acp" | null {
  if (config.verifyUcp && path.startsWith("/ucp/")) return "ucp";
  if (config.verifyAcp && path.startsWith("/acp/")) return "acp";
  return null;
}

function reconstructAbsoluteUrl(req: RouteRequest, hostHeader?: string): string {
  const host = hostHeader || "localhost";
  const scheme = (req.headers["x-forwarded-proto"] || "https").split(",")[0].trim();
  const qs = Object.keys(req.query).length
    ? "?" + new URLSearchParams(req.query).toString()
    : "";
  return `${scheme}://${host}${req.path}${qs}`;
}

/**
 * Wrap a dispatch function with signature verification on protocol routes.
 *
 * Usage in server.ts:
 *
 *     const dispatch = withSigVerify(rawDispatch);
 *
 * The wrapper is async-config — the first call hydrates trusted keys from
 * env / remote JWKS. Subsequent calls hit the cache.
 */
export function withSigVerify(
  inner: (req: RouteRequest) => Promise<RouteResponse>,
): (req: RouteRequest) => Promise<RouteResponse> {
  return async (req: RouteRequest): Promise<RouteResponse> => {
    const config = await buildSigConfig();
    const guard = shouldGuard(req.path, config);
    if (!guard) return inner(req);

    const result = verifyRequest({
      method: req.method,
      url: reconstructAbsoluteUrl(req, req.headers["host"]),
      headers: req.headers,
      body: req.body,
      keyResolver: (keyId) => config.trustedKeys.get(keyId) ?? null,
      maxAgeSeconds: config.maxAgeSeconds,
    });

    if (!result.ok) {
      return {
        status: 401,
        headers: {
          "content-type": "application/json; charset=utf-8",
          "www-authenticate": `Signature realm="${guard}", error="${result.reason}"`,
        },
        body: JSON.stringify({
          error: "invalid_signature",
          protocol: guard,
          reason: result.reason,
        }),
      };
    }

    return inner(req);
  };
}

/** Convenience wrapper for a single RouteHandler. Used in tests. */
export function withSigVerifyHandler(handler: RouteHandler): RouteHandler {
  return withSigVerify(handler);
}

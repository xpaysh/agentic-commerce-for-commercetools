/**
 * Runtime configuration — loaded from environment variables at startup.
 * Validated once; any missing required value crashes early with a clear message
 * rather than failing partway through a request.
 */

export interface CommercetoolsCredentials {
  /** commercetools Project key, e.g. 'acme-outdoors-prod'. */
  projectKey: string;
  /** OAuth client id (Project-scoped). */
  clientId: string;
  /** OAuth client secret. */
  clientSecret: string;
  /** OAuth scopes, space-separated. Default: 'manage_project:<projectKey>' may be too broad
   *  for production; recommended minimum: view_products view_orders view_categories manage_my_orders. */
  scope: string;
  /** OAuth token endpoint (region-dependent), e.g. 'https://auth.us-central1.gcp.commercetools.com'. */
  authUrl: string;
  /** Project API endpoint, e.g. 'https://api.us-central1.gcp.commercetools.com'. */
  apiUrl: string;
}

export interface AppConfig {
  /** Per-merchant slug (used in xpay-hosted URLs and as the UCP profile identifier). */
  merchantSlug: string;
  /** Public-facing site URL the discovery files describe. Trailing slash recommended. */
  siteUrl: string;
  /** Site display name (used in /llms.txt H1 and agent-card.json). */
  siteName: string;
  /** Optional short description for /llms.txt. */
  siteDescription?: string;
  /** Path the cart-deeplink handler redirects to after pre-filling the cart.
   *  Defaults to '/checkout' (relative to siteUrl). */
  checkoutPath: string;

  /** xpay merchant api_key — secret for HS256 cart-deeplink JWTs. Shared with the xpay backend. */
  xpayApiKey: string;

  /** commercetools project credentials. */
  ct: CommercetoolsCredentials;

  /** Bind host + port for the HTTP server. */
  host: string;
  port: number;

  /** Token cache TTL (seconds) for the OAuth bearer token from commercetools. Default 1800. */
  ctTokenTtlSeconds: number;

  /** Whether to emit /.well-known/oauth-protected-resource (turn on when UCP OAuth Identity Linking is enabled). */
  emitOauthProtectedResource: boolean;
  /** Whether to emit /.well-known/agent-card.json (A2A watchlist; off by default). */
  emitAgentCard: boolean;
}

function readRequired(name: string): string {
  const v = process.env[name];
  if (!v || !v.trim()) {
    throw new Error(`config: missing required env var ${name}`);
  }
  return v.trim();
}

function readOptional(name: string, defaultValue = ""): string {
  const v = process.env[name];
  return v && v.trim() ? v.trim() : defaultValue;
}

function readBool(name: string, defaultValue: boolean): boolean {
  const v = process.env[name];
  if (v === undefined) return defaultValue;
  return /^(1|true|yes|on)$/i.test(v.trim());
}

function readInt(name: string, defaultValue: number): number {
  const v = process.env[name];
  if (v === undefined || !v.trim()) return defaultValue;
  const n = parseInt(v.trim(), 10);
  return Number.isFinite(n) ? n : defaultValue;
}

export function loadConfig(): AppConfig {
  const merchantSlug = readRequired("XPAY_MERCHANT_SLUG");
  const siteUrl = readRequired("SITE_URL");
  const siteName = readRequired("SITE_NAME");

  return {
    merchantSlug,
    siteUrl: siteUrl.endsWith("/") ? siteUrl : siteUrl + "/",
    siteName,
    siteDescription: readOptional("SITE_DESCRIPTION") || undefined,
    checkoutPath: readOptional("CHECKOUT_PATH", "/checkout"),

    xpayApiKey: readRequired("XPAY_API_KEY"),

    ct: {
      projectKey: readRequired("CTP_PROJECT_KEY"),
      clientId: readRequired("CTP_CLIENT_ID"),
      clientSecret: readRequired("CTP_CLIENT_SECRET"),
      scope: readRequired("CTP_SCOPES"),
      authUrl: readRequired("CTP_AUTH_URL"),
      apiUrl: readRequired("CTP_API_URL"),
    },

    host: readOptional("HOST", "0.0.0.0"),
    port: readInt("PORT", 8787),

    ctTokenTtlSeconds: readInt("CTP_TOKEN_TTL_SECONDS", 1800),

    emitOauthProtectedResource: readBool("EMIT_OAUTH_PROTECTED_RESOURCE", false),
    emitAgentCard: readBool("EMIT_AGENT_CARD", false),
  };
}

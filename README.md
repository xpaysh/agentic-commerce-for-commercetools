# Agentic Commerce for commercetools

Connect Service that exposes a [commercetools](https://commercetools.com) Composable Commerce store to AI shopping agents — `/llms.txt`, `/.well-known/ucp` (UCP business profile), schema.org JSON-LD on PDPs (via API), and signed-JWT cart deeplinks that pre-fill a commercetools cart and redirect into the merchant's existing checkout.

**Status**: v0.2.0 — discovery surface, cart handoff, **full ACP/UCP/AP2 endpoint stack** on top of the `@xpaysh/adapter-contract` interface. Apache-2.0.

## Architecture

```
   AI Agent (ChatGPT, Claude, Gemini, …)
         │
         │   1. Fetches /llms.txt + /.well-known/ucp from the merchant's domain
         │   2. Negotiates capabilities, builds a cart, mints a signed deeplink
         │
         ▼
   merchant.example/?xpay_cart=<jwt>
         │
         │   3. Storefront proxies /cart/deeplink to THIS SERVICE
         ▼
   ┌─────────────────────────────────────────┐
   │ agentic-commerce-for-commercetools      │
   │  - Verifies the JWT (@xpaysh/cart-     │
   │    deeplinks; HS256 + sha256_hex(api_key)│
   │    matches the WC plugin's verifier)    │
   │  - Creates a commercetools Cart via the │
   │    CommercetoolsAdapter                 │
   │  - 302s to the merchant's checkout      │
   │    with ?xpay_cart_id=<ct-cart-id>     │
   └──────────────────┬──────────────────────┘
                      │   commercetools Project API
                      ▼
   ┌─────────────────────────────────────────┐
   │ commercetools                           │
   │  Products · Carts · Orders              │
   └──────────────────┬──────────────────────┘
                      │   merchant's existing payment integration
                      ▼
   Stripe / Adyen / Mollie / Braintree / etc.
```

The service is a **standalone Node app** running alongside the merchant's storefront (or as a [commercetools Connect](https://docs.commercetools.com/connect) service). The storefront proxies a handful of paths to it.

## What you get out of the box

### Discovery layer (v0.1+)

| Method | Path | Notes |
|---|---|---|
| GET | `/llms.txt` | llmstxt.org Markdown menu |
| GET | `/.well-known/ucp` | UCP business profile (Google + Shopify + Etsy + Wayfair + Target + Walmart fetch this) |
| GET | `/robots.txt` | AI-crawler allow blocks (template — storefront merges) |
| GET | `/.well-known/agent-card.json` | A2A 1.0; opt-in via `EMIT_AGENT_CARD=1` |
| GET | `/.well-known/oauth-protected-resource` | RFC 9728; opt-in via `EMIT_OAUTH_PROTECTED_RESOURCE=1` |
| GET | `/api/v1/jsonld/product/:id[?slim=1]` | schema.org Product JSON-LD; storefront embeds in PDP HTML |
| GET | `/cart/deeplink?token=<jwt>` | redeem cart-deeplink → CT cart → 302 to checkout |
| GET | `/healthz` | liveness + commercetools reachability |

### UCP — Universal Commerce Protocol (v0.2)

REST surface advertised in `/.well-known/ucp` under `services.dev.ucp.shopping[0].endpoint`. Snake-case JSON; minor-units money; ISO currency codes.

| Method | Path | Body / params |
|---|---|---|
| GET | `/api/ucp/v1/catalog/search?q=&sku=&limit=&cursor=&sort=` | search params |
| GET | `/api/ucp/v1/catalog/products/:id` | path |
| POST | `/api/ucp/v1/carts` | `{items[{sku,quantity,variant_id?}], currency?, external_id?}` |
| GET | `/api/ucp/v1/carts/:id` | — |
| PATCH | `/api/ucp/v1/carts/:id` | `{set_items[], remove_skus[], shipping_address, billing_address, discount_code}` |
| POST | `/api/ucp/v1/checkout` | `{cart_id, shipping_address?, billing_address?, payment?}` |
| GET | `/api/ucp/v1/orders/:id` | — |

**Request integrity**: UCP requires RFC 9421 HTTP Message Signatures. v0.2 ships the endpoint behavior; full signature verification middleware is configurable (off by default; enable via `VERIFY_UCP_SIGNATURES=1` once signing keys are populated in the profile — completes in v0.3).

### ACP — Agentic Commerce Protocol (v0.2)

Per-session surface — agent opens a `checkout_session`, mutates it, completes it.

| Method | Path | Body |
|---|---|---|
| POST | `/api/acp/v1/checkout_sessions` | `{items[{sku,qty,variation_id?}], currency?, capabilities_requested[], agent?, surface?, buyer_id?, external_id?}` |
| GET | `/api/acp/v1/checkout_sessions/:id` | — |
| POST | `/api/acp/v1/checkout_sessions/:id` | `{items[]?, remove_skus[]?, shipping_address?, billing_address?, discount_code?}` |
| POST | `/api/acp/v1/checkout_sessions/:id/complete` | `{shipping_address?, billing_address?, payment?, note?}` → `Order` |
| GET | `/api/acp/v1/orders/:id` | — |

Session storage is in-memory in v0.2 — cold-start loses the session→cart mapping. (CT cart IS the source of truth; agents just need to re-open a session.) v0.3 moves session metadata to DynamoDB.

`POST /api/acp/v1/delegate_payment` — deferred to v0.3 (CP role).

### AP2 — Agent Payments Protocol (v0.2)

| Method | Path | Body |
|---|---|---|
| POST | `/api/ap2/v1/mandates/verify` | `{mandate: "<jwt-vc>", require_audience?: boolean}` |
| POST | `/api/ap2/v1/checkout` | `{cart_id, mandate, shipping_address?, billing_address?}` |

**Mandate signature verification** is structural-only in v0.2 — the response includes `signature_verified: false` and `signature_verification_status: "deferred_to_v0.3"`. Audience + expiry checks DO run. Full issuer-key fetching + VC signature verification lands in v0.3 alongside the CP role.

`/llms.txt` and `/.well-known/ucp` advertise xpay's hosted protocol endpoints (`agent-commerce.xpay.sh/acp/v1/<slug>`, `…/ucp/v1/<slug>`, `…/ap2/v1/<slug>`). Standalone-mode merchants can override to point at their own endpoints; xpay-commercial-tier merchants leave the defaults.

## What's intentionally **not** here in v0.2

- **ACP `POST /delegate_payment`** — agent supplies a delegated-payment credential; merchant captures via PSP. Requires the Credential Provider role. v0.3.
- **AP2 mandate signature verification** — structural + audience + expiry checks pass; the actual issuer signature verification needs a trusted-issuer JWK fetcher. v0.3.
- **UCP request-signature verification (RFC 9421)** — middleware skeleton in place; defaults to off. Wire on once signing_keys are populated in the merchant's profile + agent platforms are signing. v0.3.
- **Refunds + disputes** — `adapter.refundOrder` / `adapter.openDispute`. `capabilities.{refunds, disputes} = false`. v0.3.
- **Webhooks for order state changes** — commercetools subscriptions. `capabilities.webhooks = false`. v0.3.

The `CommercetoolsAdapter` v0.2 capabilities: `{cart: true, checkout: true, catalogSearch: true, catalogLookup: true, order: true, refunds: false, disputes: false, inventoryRealtime: true, webhooks: false}`.

## Quickstart

### 1. Get credentials

- **commercetools**: in your Project → Settings → Developer Settings → API clients → "Create new API client". Use the "Mobile & single-page application client" template, or grant the minimum manual scopes for v0.1: `view_products`, `manage_my_orders`. Copy the project key, client id, secret, scopes, auth URL, API URL.
- **xpay**: get your merchant slug + api_key at [`app.xpay.sh/onboard/commercetools`](https://app.xpay.sh/onboard/commercetools) (or, in standalone mode, mint your own slug + random api_key — anything works as long as the same key signs and verifies).

### 2. Configure

```bash
git clone https://github.com/xpaysh/agentic-commerce-for-commercetools.git
cd agentic-commerce-for-commercetools
cp .env.example .env
# Edit .env with your credentials
```

### 3. Run (Docker)

```bash
docker compose -f examples/docker-compose.yml up --build
curl -sS http://localhost:8787/healthz | jq .
```

### 3-alt. Run (Node)

```bash
npm install
npm run build
node dist/server.js
```

Or in dev mode (TypeScript directly, no build step):

```bash
npm run dev
```

### 4. Wire the storefront

Add reverse-proxy rules to your storefront's web server (Vercel, Cloudflare, Nginx, Caddy, etc.):

```
/llms.txt                                  → agentic.merchant.example:8787/llms.txt
/.well-known/ucp                           → agentic.merchant.example:8787/.well-known/ucp
/.well-known/oauth-protected-resource      → agentic.merchant.example:8787/.well-known/oauth-protected-resource   (if enabled)
/.well-known/agent-card.json               → agentic.merchant.example:8787/.well-known/agent-card.json            (if enabled)
/cart/deeplink                             → agentic.merchant.example:8787/cart/deeplink
```

For schema.org JSON-LD on PDPs, the storefront's product-page renderer calls:

```ts
const ld = await fetch(`https://agentic.merchant.example/api/v1/jsonld/product/${productId}`).then(r => r.json());
// then embed: <script type="application/ld+json">{ldJson}</script>
```

For `robots.txt`, merge the AI-allow blocks from `GET /robots.txt` into your storefront's existing robots.txt (or proxy directly if you don't have one).

### 5. Smoke-test the deeplink flow

```bash
# Sign a deeplink using the same XPAY_API_KEY as the service
node -e "
const { signCartDeeplink } = require('@xpaysh/cart-deeplinks');
const { token } = signCartDeeplink({
  merchant: process.env.XPAY_MERCHANT_SLUG,
  items: [{ sku: 'SOME-SKU-IN-YOUR-CATALOG', qty: 1 }],
  ttlSeconds: 300,
  apiKey: process.env.XPAY_API_KEY,
});
console.log('https://merchant.example/cart/deeplink?token=' + token);
"

# Open the URL in a browser — you should land on /checkout?xpay_cart_id=<commercetools-cart-id>
```

## Deployment options

### commercetools Connect

The same handler runs as a commercetools Connect service. Add a `connect.yaml` at the project root pointing the `service` entry point at `dist/server.js`. Connect provides the runtime + URL; you map your project's credentials via Connect's secrets manager. Manifest example coming in v0.2; for now, the Docker path is the supported one.

### AWS Lambda / Vercel / Fly / your own VPS

Pure-Node, no platform-specific bindings — runs anywhere. The `Dockerfile` ships a multi-stage build (Alpine + Node 20). For Lambda specifically, wrap `buildHandler` from `src/server.ts` in a Lambda-event adapter (the audit service's `services/audit/src/lambda.js` in [xpaysh/agentic-commerce-plugin-template](https://github.com/xpaysh/agentic-commerce-plugin-template) is the reference shape).

### Cloudflare Workers

Adapt `buildHandler` to a `fetch` event handler. Worker adapter not included; contributions welcome.

## Environment

| Var | Required | Notes |
|---|---|---|
| `XPAY_MERCHANT_SLUG` | ✅ | Per-merchant identifier. Appears in xpay-hosted URLs. |
| `SITE_URL` | ✅ | Public site URL the discovery files describe. Trailing slash recommended. |
| `SITE_NAME` | ✅ | Display name (used in `/llms.txt` H1). |
| `XPAY_API_KEY` | ✅ | Shared HS256 secret for cart-deeplink JWTs. |
| `CTP_PROJECT_KEY` | ✅ | commercetools project key. |
| `CTP_CLIENT_ID` | ✅ | OAuth client id (Project-scoped). |
| `CTP_CLIENT_SECRET` | ✅ | OAuth client secret. |
| `CTP_SCOPES` | ✅ | OAuth scopes, space-separated. |
| `CTP_AUTH_URL` | ✅ | OAuth token endpoint URL (region-dependent). |
| `CTP_API_URL` | ✅ | Project API endpoint URL (region-dependent). |
| `SITE_DESCRIPTION` | | One-line description for `/llms.txt`. |
| `CHECKOUT_PATH` | | Path the cart-deeplink redirects to. Default `/checkout`. |
| `HOST` | | Bind host. Default `0.0.0.0`. |
| `PORT` | | Bind port. Default `8787`. |
| `EMIT_OAUTH_PROTECTED_RESOURCE` | | `1` to emit `/.well-known/oauth-protected-resource` (enable with UCP OAuth Identity Linking). |
| `EMIT_AGENT_CARD` | | `1` to emit `/.well-known/agent-card.json` (A2A 1.0; watchlist). |
| `CTP_TOKEN_TTL_SECONDS` | | commercetools bearer-token cache TTL. Default 1800. |

## Library usage (embed in your own Node app)

```ts
import { CommercetoolsAdapter, CommercetoolsClient, loadConfig } from 'agentic-commerce-for-commercetools';

const config = loadConfig();
const ct = new CommercetoolsClient(config.ct);
const adapter = new CommercetoolsAdapter({ ct, siteUrl: config.siteUrl });

const product = await adapter.getProduct('some-product-id');
const cart = await adapter.createCart({ items: [{ sku: 'SKU-1', quantity: 1 }] });
```

The adapter implements `@xpaysh/adapter-contract`'s `PlatformAdapter`, so any code written against that interface (the hosted backend, the audit's commerce checks, sibling-plugin orchestration) accepts this adapter unchanged.

## Family packages this service uses

| npm package | Role |
|---|---|
| [`@xpaysh/adapter-contract`](https://www.npmjs.com/package/@xpaysh/adapter-contract) | TypeScript `PlatformAdapter` interface |
| [`@xpaysh/discovery`](https://www.npmjs.com/package/@xpaysh/discovery) | `/llms.txt`, schema.org JSON-LD, `robots.txt`, A2A agent-card, RFC 9728 generators |
| [`@xpaysh/ucp-schemas`](https://www.npmjs.com/package/@xpaysh/ucp-schemas) | UCP profile generator (all 6 core + 2 extension capabilities); `sh.xpay` namespace |
| [`@xpaysh/cart-deeplinks`](https://www.npmjs.com/package/@xpaysh/cart-deeplinks) | HS256 cart-handoff JWT (wire-compatible with the WC plugin) |

## Verifying agent-readiness

After deploying:

```bash
# Anonymous audit
npx @xpaysh/storefront-audit https://store.merchant.example/

# Or browse to:
# https://audit.xpay.sh/?url=https://store.merchant.example/
```

## See also

- [Plugin template + family monorepo](https://github.com/xpaysh/agentic-commerce-plugin-template)
- [Reference plugin (WooCommerce, PHP)](https://github.com/xpaysh/agentic-commerce-for-woocommerce) — v0.2+ ships the same wire format
- [docs.xpay.sh — ACP vs UCP vs AP2](https://docs.xpay.sh/agentic-commerce-protocols/comparison)
- [Agentic commerce roadmap](https://docs.xpay.sh/merchants/agentic-commerce)
- [commercetools Composable Commerce](https://commercetools.com)

## License

Apache-2.0.

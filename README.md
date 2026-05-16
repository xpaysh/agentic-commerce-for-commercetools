# Agentic Commerce for commercetools

Connect Service that exposes a [commercetools](https://commercetools.com) Composable Commerce store to AI shopping agents — `/llms.txt`, `/.well-known/ucp` (UCP business profile), schema.org JSON-LD on PDPs (via API), and signed-JWT cart deeplinks that pre-fill a commercetools cart and redirect into the merchant's existing checkout.

**Status**: v0.1.0 — discovery surface + cart-handoff fully working. ACP/UCP REST protocol endpoints land in v0.2. Apache-2.0.

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

| Surface | Path | Default |
|---|---|---|
| Discovery — Markdown menu | `GET /llms.txt` | on |
| Discovery — UCP business profile (Google + Shopify + Etsy + Wayfair + Target + Walmart fetch this) | `GET /.well-known/ucp` | on |
| Discovery — AI-crawler allow blocks | `GET /robots.txt` | on |
| Discovery — A2A 1.0 agent card (watchlist) | `GET /.well-known/agent-card.json` | off (`EMIT_AGENT_CARD=1` to enable) |
| Discovery — RFC 9728 OAuth resource metadata | `GET /.well-known/oauth-protected-resource` | off (`EMIT_OAUTH_PROTECTED_RESOURCE=1` to enable) |
| JSON-LD per product (storefront embeds in PDP HTML) | `GET /api/v1/jsonld/product/:id[?slim=1]` | on |
| Cart-deeplink redemption | `GET /cart/deeplink?token=<jwt>` | on |
| Liveness + commercetools reachability | `GET /healthz` | on |

`/llms.txt` and `/.well-known/ucp` advertise xpay's hosted protocol endpoints (`agent-commerce.xpay.sh/acp/v1/<slug>`, `…/ucp/v1/<slug>`, `…/ap2/v1/<slug>`). Standalone-mode merchants can override to point at their own endpoints; xpay-commercial-tier merchants leave the defaults.

## What's intentionally **not** here in v0.1

- ACP `POST /checkout_sessions` + `/delegate_payment` endpoints — v0.2
- UCP REST surface (cart / checkout / order endpoints with RFC 9421 signed requests) — v0.2
- AP2 mandate acceptance — v0.2
- `completeCheckout` adapter method — v0.2 (needs payment-method wiring; for v0.1, buyers land on the merchant's existing CT checkout via the cart-deeplink handler)
- `listOrders` adapter method — v0.2 (`getOrder` by id works today)
- Refunds + disputes — v0.3

The `CommercetoolsAdapter` implements [`PlatformAdapter`](https://www.npmjs.com/package/@xpaysh/adapter-contract) with the v0.1 methods marked `capabilities.{checkout,order,refunds,disputes,webhooks} = false`. v0.2 flips them on as each is implemented.

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

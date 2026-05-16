# Agentic Commerce for commercetools

Multi-protocol agentic-commerce layer for [commercetools](https://commercetools.com) Composable Commerce. Speaks **[ACP](https://github.com/agentic-commerce-protocol/agentic-commerce-protocol)**, **[UCP](https://github.com/Universal-Commerce-Protocol/ucp)**, and **[AP2](https://github.com/google-agentic-commerce/AP2)** out of the box, emits real-standard discovery files (`/llms.txt`, schema.org JSON-LD, real-AI-crawler `robots.txt`), and settles through your existing commercetools payment integrations — cards, [Stripe MPP](https://mpp.dev), [x402](https://x402.org), stablecoins.

> Scaffold for the [`agentic-commerce-for-*`](https://github.com/xpaysh?q=agentic-commerce-for-) family. Full implementation lands in coming weeks alongside the [plugin template](https://github.com/xpaysh/agentic-commerce-plugin-template).

## What this gives a commercetools merchant

- **Agent-readable storefront** — your existing PIM/catalog gets exposed to ChatGPT, Claude, Gemini, and Perplexity via [llms.txt](https://llmstxt.org), schema.org JSON-LD on PDPs and listings, and a `robots.txt` allowlist for the real AI crawlers (`GPTBot`, `ClaudeBot`, `Google-Extended`, `PerplexityBot`, `CCBot`, `Amazonbot`).
- **Multi-protocol checkout endpoints** — ACP `POST /checkout_sessions` + `/delegate_payment` backed by commercetools `Cart` and `Order` resources; UCP REST surface with [RFC 9421](https://datatracker.ietf.org/doc/rfc9421/) signed-request verification; AP2 mandate acceptance for Google Agent Builder flows.
- **No new processor.** Agents settle through whichever payment integration your commercetools project already uses (Stripe Connect, Adyen, Mollie, Braintree, …). Optional MPP / x402 / stablecoin rails are configurable add-ons.
- **Cart deeplinks** — JWT-signed (commercial mode) or query-string (standalone) — pre-fill a commercetools Cart and redirect the buyer to your existing checkout.
- **Two-mode operation** — *standalone* (no xpay backend, discovery + protocol endpoints only) or *commercial* (xpay backend adds catalog hosting, attribution, multi-region analytics).

## Why commercetools first

The autocomplete probe (2026-05-16) showed `commercetools agentic …` has the densest cluster of search demand among the platforms surveyed — 7+ distinct agentic stems vs 4–5 for BigCommerce / Magento. Combined with commercetools' headless / JS-native shape, it lets the shared TypeScript template establish a clean foundation that the next platforms can inherit.

## Architecture (planned)

Headless commercetools projects don't have a "plugin" surface to install into — this ships as a **deployable Node.js service** designed to run alongside your storefront (or as a [commercetools Connect](https://docs.commercetools.com/connect) service):

```
   AI Agent  ───►  agentic-commerce-for-commercetools  ───►  commercetools API
                  (ACP / UCP / AP2 endpoints)               (Cart, Order, Product)
                          │
                          └──►  Your existing PSP / payment integration
                                (Stripe, Adyen, Mollie, MPP, x402, …)
```

Real discovery files (`/llms.txt`, schema.org JSON-LD) are emitted by your storefront via thin middleware adapters the service provides. The service is the protocol implementation; the storefront is the discovery surface.

## Status

- 🚧 **Scaffold** — README + LICENSE only. Implementation pending the [plugin template](https://github.com/xpaysh/agentic-commerce-plugin-template) extraction from [`agentic-commerce-for-woocommerce`](https://github.com/xpaysh/agentic-commerce-for-woocommerce).
- Target first usable release: alongside the template repo's first content drop.
- Track progress and adjacent platforms in the [awesome-agentic-commerce](https://github.com/xpaysh/awesome-agentic-commerce) registry.

## See also

- [Plugin template](https://github.com/xpaysh/agentic-commerce-plugin-template) — shared TypeScript core
- [awesome-agentic-commerce](https://github.com/xpaysh/awesome-agentic-commerce) — ecosystem registry
- [Agentic Commerce for WooCommerce](https://github.com/xpaysh/agentic-commerce-for-woocommerce) — reference implementation (live, v0.1.7+, GPLv2)
- [ACP vs UCP vs AP2 — Technical Comparison](https://docs.xpay.sh/agentic-commerce-protocols/comparison)
- [Agentic commerce roadmap on docs.xpay.sh](https://docs.xpay.sh/merchants/agentic-commerce)
- [commercetools docs](https://docs.commercetools.com) · [Connect framework](https://docs.commercetools.com/connect)

## License

Apache-2.0.

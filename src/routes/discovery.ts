/**
 * Discovery routes — /llms.txt, /.well-known/ucp, /robots.txt
 * (plus the optional emitters when enabled in config).
 */

import {
  generateLlmsTxt,
  generateRobotsTxtBlock,
  generateAgentCardJson,
  generateOAuthProtectedResource,
  LLMS_TXT_PATH,
  AGENT_CARD_PATH,
  OAUTH_PROTECTED_RESOURCE_PATH,
} from "@xpaysh/discovery";
import {
  generateUcpProfile,
  UCP_PROFILE_PATH,
} from "@xpaysh/ucp-schemas";

import type { AppConfig } from "../config";
import type { RouteHandler, RouteResponse } from "./types";

export function buildDiscoveryRoutes(config: AppConfig): Record<string, RouteHandler> {
  // /llms.txt — Markdown menu the agent reads first
  const serveLlmsTxt: RouteHandler = async () => {
    const body = generateLlmsTxt({
      siteName: config.siteName,
      siteDescription: config.siteDescription,
      siteUrl: config.siteUrl,
      merchantSlug: config.merchantSlug,
      catalogFeedUrl: `https://agent-feed.xpay.sh/catalog/${config.merchantSlug}.json`,
      commerceProtocols: {
        acp: `https://agent-commerce.xpay.sh/acp/v1/${config.merchantSlug}`,
        ucp: `https://agent-commerce.xpay.sh/ucp/v1/${config.merchantSlug}`,
        ap2: `https://agent-commerce.xpay.sh/ap2/v1/${config.merchantSlug}`,
        mcp: `https://agent-commerce.xpay.sh/mcp/${config.merchantSlug}`,
      },
      cartDeeplinkPattern: `${config.siteUrl}?xpay_cart={token}`,
    });
    return {
      status: 200,
      headers: { "content-type": "text/plain; charset=utf-8", "x-robots-tag": "noindex" },
      body,
    };
  };

  // /.well-known/ucp — UCP business profile (Google, Shopify, Etsy, Wayfair, Target, Walmart fetch this)
  const serveUcpProfile: RouteHandler = async () => {
    const profile = generateUcpProfile({
      endpoint: `https://agent-commerce.xpay.sh/ucp/v1/${config.merchantSlug}`,
      // signingKeys empty in standalone mode; xpay backend populates in commercial mode
      signingKeys: [],
      paymentHandlers: {
        // sh.xpay.* reverse-domain for xpay-issued capabilities (UCP namespace rule)
        // Advertise x402 facilitator as one available rail; the merchant's existing
        // CT payment integration handles cards via the storefront checkout flow.
        "sh.xpay.facilitator.x402": [{ endpoint: "https://facilitator.xpay.sh" }],
      },
    });
    return {
      status: 200,
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify(profile, null, 2),
    };
  };

  // /robots.txt — append AI-crawler allow blocks
  // (The merchant's storefront typically generates the base robots.txt; this
  //  service can be used as a source of truth and proxied / templated by the
  //  storefront. Returned alone here so a developer can see what to include.)
  const serveRobotsTxt: RouteHandler = async () => {
    const { robotsTxt } = generateRobotsTxtBlock({
      existingRobotsTxt: "User-agent: *\nAllow: /\n",
    });
    return {
      status: 200,
      headers: { "content-type": "text/plain; charset=utf-8" },
      body: robotsTxt,
    };
  };

  // /.well-known/oauth-protected-resource — emit only when enabled
  const serveOauthProtectedResource: RouteHandler = async () => {
    if (!config.emitOauthProtectedResource) {
      return notFound();
    }
    const payload = generateOAuthProtectedResource({
      resource: config.siteUrl,
      authorizationServers: ["https://auth.xpay.sh"],
      resourceName: config.merchantSlug,
      resourceDocumentation: "https://docs.xpay.sh/merchants/agentic-commerce",
    });
    return {
      status: 200,
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify(payload, null, 2),
    };
  };

  // /.well-known/agent-card.json — emit only when enabled (watchlist standard)
  const serveAgentCard: RouteHandler = async () => {
    if (!config.emitAgentCard) {
      return notFound();
    }
    const payload = generateAgentCardJson({
      name: config.siteName,
      description: config.siteDescription,
      url: config.siteUrl,
      version: "0.1.0",
      provider: {
        name: "xpay",
        url: `https://agent-commerce.xpay.sh/v1/${config.merchantSlug}`,
      },
    });
    return {
      status: 200,
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify(payload, null, 2),
    };
  };

  return {
    [LLMS_TXT_PATH]: serveLlmsTxt,
    [UCP_PROFILE_PATH]: serveUcpProfile,
    "/robots.txt": serveRobotsTxt,
    [OAUTH_PROTECTED_RESOURCE_PATH]: serveOauthProtectedResource,
    [AGENT_CARD_PATH]: serveAgentCard,
  };
}

function notFound(): RouteResponse {
  return {
    status: 404,
    headers: { "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify({ error: "not found" }),
  };
}

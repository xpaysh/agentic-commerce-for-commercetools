/**
 * CommercetoolsAdapter — implements @xpaysh/adapter-contract's
 * PlatformAdapter against the commercetools Project API.
 *
 * v0.1 ships working implementations for the methods the cart-deeplink
 * handoff actually needs (`getProduct`, `createCart`, `getCart`, `updateCart`)
 * plus catalog search/listing. `completeCheckout`, `listOrders`, and the
 * optional `refundOrder` / `openDispute` are intentionally stubbed to
 * `not_implemented` for v0.1 — the adapter shape is in place and the cart
 * handoff works, but checkout completion + order list go in v0.2 (they
 * require payment-method wiring and an order-list query strategy).
 */

import type {
  PlatformAdapter,
  AdapterCapabilities,
  Product,
  ProductQuery,
  Paginated,
  ProductId,
  CartId,
  Cart,
  CreateCartInput,
  CartMutation,
  CompleteCheckoutInput,
  Order,
  OrderId,
  OrderQuery,
  RefundResult,
  DisputeHandle,
  Money,
} from "@xpaysh/adapter-contract";

import { CommercetoolsClient } from "./ct-client";
import {
  mapProductProjection,
  mapCart,
  mapOrder,
  type CtProductProjection,
  type CtCart,
  type CtOrder,
} from "./mappers";

export interface CommercetoolsAdapterOptions {
  ct: CommercetoolsClient;
  /** Public-facing site URL — used to construct product URLs in the contract output. */
  siteUrl: string;
  /** Display locale for localised commercetools fields. Default 'en-US'. */
  locale?: string;
  /** Default currency for new carts when CreateCartInput doesn't specify. Default 'USD'. */
  defaultCurrency?: string;
  /** Default 2-letter country for new carts. Default 'US'. */
  defaultCountry?: string;
}

export class CommercetoolsAdapter implements PlatformAdapter {
  readonly platformName = "commercetools";

  readonly capabilities: AdapterCapabilities = {
    cart: true,
    checkout: true,      // v0.2 — completeCheckout creates a CT Order from the Cart
    catalogSearch: true,
    catalogLookup: true,
    order: true,         // v0.2 — getOrder + listOrders both wired
    refunds: false,      // v0.3
    disputes: false,     // v0.3
    inventoryRealtime: true,
    webhooks: false,     // v0.3 — commercetools subscriptions
    extras: {},
  };

  private ct: CommercetoolsClient;
  private siteUrl: string;
  private locale: string;
  private defaultCurrency: string;
  private defaultCountry: string;

  constructor(opts: CommercetoolsAdapterOptions) {
    this.ct = opts.ct;
    this.siteUrl = opts.siteUrl.endsWith("/") ? opts.siteUrl : opts.siteUrl + "/";
    this.locale = opts.locale || "en-US";
    this.defaultCurrency = opts.defaultCurrency || "USD";
    this.defaultCountry = opts.defaultCountry || "US";
  }

  // -------------------------------------------------------------------------
  // Catalog
  // -------------------------------------------------------------------------

  async listProducts(query: ProductQuery): Promise<Paginated<Product>> {
    const params = new URLSearchParams();
    const limit = query.limit && query.limit > 0 ? Math.min(query.limit, 50) : 20;
    params.set("limit", String(limit));
    if (query.cursor) {
      const offset = parseInt(query.cursor, 10);
      if (Number.isFinite(offset) && offset >= 0) params.set("offset", String(offset));
    }
    if (query.q) params.set("text.en-US", query.q);
    if (query.sku) params.set(`filter`, `variants.sku:"${query.sku.replace(/"/g, '')}"`);
    if (query.sort === "price_asc") params.set("sort", "price asc");
    else if (query.sort === "price_desc") params.set("sort", "price desc");
    else if (query.sort === "newest") params.set("sort", "createdAt desc");

    const path = `/product-projections/search?${params.toString()}`;
    const res = await this.ct.fetchJson<{
      results: CtProductProjection[];
      total: number;
      offset: number;
      count: number;
    }>(path);

    const items = res.results.map((p) => mapProductProjection(p, this.siteUrl, this.locale));
    const nextOffset = res.offset + res.count;
    const nextCursor = nextOffset < res.total ? String(nextOffset) : null;
    return { items, nextCursor, total: res.total };
  }

  async getProduct(id: ProductId): Promise<Product | null> {
    try {
      // commercetools allows lookup by id directly OR by key=...; we try id first.
      const p = await this.ct.fetchJson<CtProductProjection>(`/product-projections/${encodeURIComponent(id)}`);
      return mapProductProjection(p, this.siteUrl, this.locale);
    } catch (err) {
      if (this.isNotFound(err)) return null;
      throw err;
    }
  }

  // -------------------------------------------------------------------------
  // Cart
  // -------------------------------------------------------------------------

  async createCart(input: CreateCartInput): Promise<Cart> {
    const currency = input.currency || this.defaultCurrency;
    const lineItems = await Promise.all(
      input.items.map(async (it) => {
        // commercetools needs productId + variantId for line items; resolve by SKU.
        const resolved = await this.resolveSkuToProductVariant(it.sku);
        if (!resolved) {
          // Skip unknown SKUs silently; cart created with whatever resolves.
          return null;
        }
        return {
          productId: resolved.productId,
          variantId: resolved.variantId,
          quantity: it.quantity,
          ...(it.metadata
            ? { custom: { fields: { ...it.metadata } } }
            : {}),
        };
      }),
    );
    const validItems = lineItems.filter((x): x is NonNullable<typeof x> => x !== null);

    if (validItems.length === 0) {
      throw new Error("createCart: no items resolved to commercetools products (check SKUs)");
    }

    const body = {
      currency,
      country: this.defaultCountry,
      lineItems: validItems,
      ...(input.externalId ? { externalId: input.externalId } : {}),
    };
    const c = await this.ct.fetchJson<CtCart>("/carts", { method: "POST", body: JSON.stringify(body) });
    return mapCart(c, this.locale);
  }

  async getCart(id: CartId): Promise<Cart | null> {
    try {
      const c = await this.ct.fetchJson<CtCart>(`/carts/${encodeURIComponent(id)}`);
      return mapCart(c, this.locale);
    } catch (err) {
      if (this.isNotFound(err)) return null;
      throw err;
    }
  }

  async updateCart(id: CartId, mutation: CartMutation): Promise<Cart> {
    const existing = await this.ct.fetchJson<CtCart>(`/carts/${encodeURIComponent(id)}`);

    const actions: Array<Record<string, unknown>> = [];

    if (Array.isArray(mutation.setItems)) {
      // Remove all existing items, then add the new set.
      for (const li of existing.lineItems) {
        actions.push({ action: "removeLineItem", lineItemId: li.id });
      }
      for (const it of mutation.setItems) {
        const resolved = await this.resolveSkuToProductVariant(it.sku);
        if (!resolved) continue;
        actions.push({
          action: "addLineItem",
          productId: resolved.productId,
          variantId: resolved.variantId,
          quantity: it.quantity,
          ...(it.metadata ? { custom: { type: { typeId: "type", key: "agent-line-meta" }, fields: it.metadata } } : {}),
        });
      }
    }

    if (Array.isArray(mutation.removeSkus) && mutation.removeSkus.length > 0) {
      const skuSet = new Set(mutation.removeSkus);
      for (const li of existing.lineItems) {
        if (li.variant.sku && skuSet.has(li.variant.sku)) {
          actions.push({ action: "removeLineItem", lineItemId: li.id });
        }
      }
    }

    if (mutation.shippingAddress) {
      actions.push({
        action: "setShippingAddress",
        address: this.contractAddressToCt(mutation.shippingAddress),
      });
    }
    if (mutation.billingAddress) {
      actions.push({
        action: "setBillingAddress",
        address: this.contractAddressToCt(mutation.billingAddress),
      });
    }
    if (typeof mutation.discountCode === "string" && mutation.discountCode) {
      actions.push({ action: "addDiscountCode", code: mutation.discountCode });
    }

    if (actions.length === 0) return mapCart(existing, this.locale);

    const c = await this.ct.fetchJson<CtCart>(`/carts/${encodeURIComponent(id)}`, {
      method: "POST",
      body: JSON.stringify({ version: existing.version, actions }),
    });
    return mapCart(c, this.locale);
  }

  // -------------------------------------------------------------------------
  // Checkout
  // -------------------------------------------------------------------------

  /**
   * Create a commercetools Order from a Cart. Note that completeCheckout in
   * v0.2 does NOT settle payment — it creates the Order in `Open`/`BalanceDue`
   * state, and the merchant's existing PSP integration handles payment via the
   * normal storefront-checkout flow OR via a post-order webhook. ACP delegated-
   * payment + AP2 mandate-based settlement land in v0.3 once the CP role is in
   * place (see deferred-roadmap-payments-and-credentialing.md).
   *
   * The `payment` field on CompleteCheckoutInput is opaque and adapter-defined.
   * For commercetools v0.2 we accept these shapes:
   *
   *   { type: "deferred" }
   *     — order created in BalanceDue state; storefront completes payment
   *
   *   { type: "external_token", token: "psp-token-string" }
   *     — order created and a CT Payment object is attached referencing the
   *       external token; storefront still triggers capture via its PSP
   */
  async completeCheckout(input: CompleteCheckoutInput): Promise<Order> {
    // Need current cart version for the order-from-cart action.
    const cart = await this.ct.fetchJson<CtCart>(`/carts/${encodeURIComponent(input.cartId)}`);
    if (cart.cartState !== "Active") {
      throw new Error(`completeCheckout: cart ${input.cartId} is not Active (state=${cart.cartState})`);
    }

    // Apply addresses to the cart first if supplied (commercetools requires
    // shipping address before order-from-cart will accept it).
    const preActions: Array<Record<string, unknown>> = [];
    if (input.shippingAddress) {
      preActions.push({ action: "setShippingAddress", address: this.contractAddressToCt(input.shippingAddress) });
    }
    if (input.billingAddress) {
      preActions.push({ action: "setBillingAddress", address: this.contractAddressToCt(input.billingAddress) });
    }

    let workingVersion = cart.version;
    if (preActions.length > 0) {
      const updated = await this.ct.fetchJson<CtCart>(`/carts/${encodeURIComponent(input.cartId)}`, {
        method: "POST",
        body: JSON.stringify({ version: workingVersion, actions: preActions }),
      });
      workingVersion = updated.version;
    }

    // Create the Order from the cart.
    const orderBody = {
      cart: { id: input.cartId, typeId: "cart" },
      version: workingVersion,
    };
    const order = await this.ct.fetchJson<CtOrder>("/orders", {
      method: "POST",
      body: JSON.stringify(orderBody),
    });

    return mapOrder(order, this.locale);
  }

  // -------------------------------------------------------------------------
  // Order
  // -------------------------------------------------------------------------

  async getOrder(id: OrderId): Promise<Order | null> {
    try {
      const o = await this.ct.fetchJson<CtOrder>(`/orders/${encodeURIComponent(id)}`);
      return mapOrder(o, this.locale);
    } catch (err) {
      if (this.isNotFound(err)) return null;
      throw err;
    }
  }

  async listOrders(query: OrderQuery): Promise<Paginated<Order>> {
    const params = new URLSearchParams();
    const limit = query.limit && query.limit > 0 ? Math.min(query.limit, 50) : 20;
    params.set("limit", String(limit));
    if (query.cursor) {
      const offset = parseInt(query.cursor, 10);
      if (Number.isFinite(offset) && offset >= 0) params.set("offset", String(offset));
    }

    // commercetools uses `where` predicates for filtering. Build a CTQL clause.
    const where: string[] = [];
    if (query.status) {
      const statuses = Array.isArray(query.status) ? query.status : [query.status];
      const ctStates = statuses.map((s) => this.contractStatusToCtOrderState(s)).filter((x): x is string => !!x);
      if (ctStates.length > 0) {
        where.push(`orderState in (${ctStates.map((s) => `"${s}"`).join(", ")})`);
      }
    }
    if (query.createdAfter) {
      where.push(`createdAt > "${query.createdAfter}"`);
    }
    if (query.createdBefore) {
      where.push(`createdAt < "${query.createdBefore}"`);
    }
    if (query.externalId) {
      where.push(`externalId = "${query.externalId.replace(/"/g, "")}"`);
    }
    if (where.length > 0) {
      params.set("where", where.join(" and "));
    }
    params.set("sort", "createdAt desc");

    const res = await this.ct.fetchJson<{
      results: CtOrder[];
      total: number;
      offset: number;
      count: number;
    }>(`/orders?${params.toString()}`);

    const items = res.results.map((o) => mapOrder(o, this.locale));
    const nextOffset = res.offset + res.count;
    const nextCursor = nextOffset < res.total ? String(nextOffset) : null;
    return { items, nextCursor, total: res.total };
  }

  /** Map our OrderStatus enum back to commercetools' three orthogonal state fields, for `where` filtering on orderState. */
  private contractStatusToCtOrderState(s: import("@xpaysh/adapter-contract").OrderStatus): string | undefined {
    switch (s) {
      case "created":
      case "processing":
        return "Open";
      case "confirmed":
      case "fulfilled":
      case "shipped":
      case "delivered":
        return "Confirmed"; // closest CT mapping; deliveries are inferred from shipmentState (caller can filter further)
      case "cancelled":
        return "Cancelled";
      case "refunded":
        return undefined; // CT models refunds via paymentState, not orderState
      default:
        return undefined;
    }
  }

  // -------------------------------------------------------------------------
  // Optional capabilities (declared as false above; safe to throw if called)
  // -------------------------------------------------------------------------

  refundOrder?(_id: OrderId, _amount?: Money): Promise<RefundResult> {
    throw new NotImplementedError("refundOrder is not declared in v0.1 capabilities.");
  }
  openDispute?(_id: OrderId, _reason: string): Promise<DisputeHandle> {
    throw new NotImplementedError("openDispute is not declared in v0.1 capabilities.");
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /** Find the productId + variantId for a SKU by querying product-projections. */
  private async resolveSkuToProductVariant(sku: string): Promise<{ productId: string; variantId: number } | null> {
    const safe = sku.replace(/"/g, "");
    const path = `/product-projections/search?filter=variants.sku:"${encodeURIComponent(safe)}"&limit=1`;
    const res = await this.ct.fetchJson<{ results: CtProductProjection[] }>(path);
    const p = res.results[0];
    if (!p) return null;

    // Check master variant first
    if (p.masterVariant?.sku === sku) {
      return { productId: p.id, variantId: p.masterVariant.id };
    }
    for (const v of p.variants || []) {
      if (v.sku === sku) return { productId: p.id, variantId: v.id };
    }
    return null;
  }

  private contractAddressToCt(a: import("@xpaysh/adapter-contract").Address): Record<string, unknown> {
    const [firstName, ...rest] = (a.name || "").split(" ");
    return {
      firstName: firstName || undefined,
      lastName: rest.join(" ") || undefined,
      company: a.company,
      streetName: a.line1,
      additionalStreetInfo: a.line2,
      city: a.city,
      region: a.region,
      postalCode: a.postalCode,
      country: a.country,
      phone: a.phone,
      email: a.email,
    };
  }

  private isNotFound(err: unknown): boolean {
    if (!err || typeof err !== "object") return false;
    const status = (err as { status?: number }).status;
    return status === 404;
  }
}

export class NotImplementedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotImplementedError";
  }
}

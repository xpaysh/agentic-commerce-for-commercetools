/**
 * Map commercetools native shapes → @xpaysh/adapter-contract types.
 *
 * commercetools exposes prices as `{centAmount, currencyCode, fractionDigits}`;
 * the contract uses `Money = {amount, currency}` with `amount` as integer minor
 * units (cents). Locale-aware fields (name, description) are flattened to a
 * single language at the call site (en-US default; configurable).
 *
 * commercetools cart/order line items have a richer structure than the
 * contract's `LineItem`; we collapse to the contract shape and stash anything
 * platform-specific in `metadata` / `meta`.
 */

import type {
  Product,
  ProductVariant,
  Money,
  Image,
  Cart,
  LineItem,
  Order,
  OrderStatus,
  Address,
} from "@xpaysh/adapter-contract";

// Minimal subset of commercetools types we touch. The full SDK is much richer;
// we only model what the v0.1 routes use.

export interface CtMoney { centAmount: number; currencyCode: string; fractionDigits?: number; type?: string; }
export interface CtPrice { value: CtMoney; }
export interface CtImage { url: string; label?: string; dimensions?: { w: number; h: number }; }
export interface CtAttribute { name: string; value: unknown; }
export interface CtProductVariant {
  id: number;
  sku?: string;
  prices?: CtPrice[];
  images?: CtImage[];
  attributes?: CtAttribute[];
  availability?: { isOnStock?: boolean; availableQuantity?: number };
}
export interface CtLocalizedString { [locale: string]: string; }
export interface CtProductData {
  name: CtLocalizedString;
  description?: CtLocalizedString;
  slug: CtLocalizedString;
  masterVariant: CtProductVariant;
  variants?: CtProductVariant[];
  categories?: Array<{ id: string; obj?: { name?: CtLocalizedString } }>;
}
export interface CtProductProjection {
  id: string;
  key?: string;
  masterVariant: CtProductVariant;
  variants?: CtProductVariant[];
  name: CtLocalizedString;
  description?: CtLocalizedString;
  slug: CtLocalizedString;
  categories?: Array<{ id: string; obj?: { name?: CtLocalizedString } }>;
}

export interface CtCartLineItem {
  id: string;
  productId: string;
  variant: CtProductVariant;
  name: CtLocalizedString;
  quantity: number;
  price: CtPrice;
  totalPrice: CtMoney;
  custom?: { fields?: Record<string, string> };
}
export interface CtCart {
  id: string;
  version: number;
  lineItems: CtCartLineItem[];
  totalPrice: CtMoney;
  shippingAddress?: CtAddress;
  billingAddress?: CtAddress;
  taxedPrice?: { totalGross: CtMoney; totalNet: CtMoney };
  cartState: "Active" | "Merged" | "Ordered" | "Frozen";
  lastModifiedAt: string;
}

export interface CtAddress {
  firstName?: string; lastName?: string; company?: string;
  streetName?: string; streetNumber?: string; additionalStreetInfo?: string;
  postalCode?: string; city?: string; region?: string; state?: string;
  country: string;
  email?: string; phone?: string;
}

export interface CtOrder extends Omit<CtCart, "cartState" | "id"> {
  id: string;
  orderState: "Open" | "Confirmed" | "Complete" | "Cancelled";
  shipmentState?: "Pending" | "Ready" | "Shipped" | "Delayed" | "Backorder" | "Partial";
  paymentState?: "BalanceDue" | "Paid" | "Failed" | "Pending" | "CreditOwed";
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DEFAULT_LOCALE = "en-US";

export function pickLocalized(field: CtLocalizedString | undefined, locale: string = DEFAULT_LOCALE): string {
  if (!field) return "";
  if (field[locale]) return field[locale];
  // fall back to first available
  const first = Object.values(field)[0];
  return typeof first === "string" ? first : "";
}

export function mapMoney(m: CtMoney | undefined): Money {
  if (!m) return { amount: 0, currency: "USD" };
  return { amount: m.centAmount, currency: m.currencyCode };
}

export function mapImage(im: CtImage): Image {
  return {
    url: im.url,
    alt: im.label,
    width: im.dimensions?.w,
    height: im.dimensions?.h,
  };
}

function mapVariantAttributes(attrs?: CtAttribute[]): Record<string, string | number | boolean> | undefined {
  if (!Array.isArray(attrs) || attrs.length === 0) return undefined;
  const out: Record<string, string | number | boolean> = {};
  for (const a of attrs) {
    if (typeof a.value === "string" || typeof a.value === "number" || typeof a.value === "boolean") {
      out[a.name] = a.value;
    } else if (a.value && typeof a.value === "object" && "label" in (a.value as Record<string, unknown>)) {
      const lbl = (a.value as Record<string, unknown>).label;
      if (typeof lbl === "string") out[a.name] = lbl;
    }
  }
  return Object.keys(out).length ? out : undefined;
}

export function mapVariant(v: CtProductVariant): ProductVariant {
  const price = v.prices && v.prices[0] ? mapMoney(v.prices[0].value) : undefined;
  const inventory = v.availability?.availableQuantity ?? null;
  return {
    id: String(v.id),
    sku: v.sku || `ct-variant-${v.id}`,
    price,
    images: v.images?.map(mapImage),
    attributes: mapVariantAttributes(v.attributes),
    inventory,
    inStock: v.availability?.isOnStock !== false && (inventory === null || inventory > 0),
  };
}

export function mapProductProjection(p: CtProductProjection, siteUrl: string, locale: string = DEFAULT_LOCALE): Product {
  const masterVariant = mapVariant(p.masterVariant);
  const variants = [masterVariant];
  if (Array.isArray(p.variants)) {
    for (const v of p.variants) variants.push(mapVariant(v));
  }
  const slug = pickLocalized(p.slug, locale);
  return {
    id: p.id,
    sku: p.masterVariant.sku || masterVariant.sku,
    name: pickLocalized(p.name, locale),
    description: p.description ? pickLocalized(p.description, locale) : undefined,
    price: masterVariant.price,
    images: masterVariant.images,
    url: slug ? `${siteUrl.replace(/\/$/, "")}/${slug}` : undefined,
    variants,
    categories: p.categories?.map((c) => (c.obj?.name ? pickLocalized(c.obj.name, locale) : c.id)),
  };
}

export function mapAddress(a?: CtAddress): Address | undefined {
  if (!a) return undefined;
  return {
    name: [a.firstName, a.lastName].filter(Boolean).join(" ") || undefined,
    company: a.company,
    line1: [a.streetNumber, a.streetName].filter(Boolean).join(" ") || a.streetName || "",
    line2: a.additionalStreetInfo,
    city: a.city || "",
    region: a.region || a.state,
    postalCode: a.postalCode || "",
    country: a.country,
    phone: a.phone,
    email: a.email,
  };
}

export function mapLineItem(li: CtCartLineItem, locale: string = DEFAULT_LOCALE): LineItem {
  const unit = mapMoney(li.price.value);
  return {
    id: li.id,
    productId: li.productId,
    variantId: String(li.variant.id),
    sku: li.variant.sku || `ct-variant-${li.variant.id}`,
    name: pickLocalized(li.name, locale),
    quantity: li.quantity,
    unitPrice: unit,
    lineTotal: mapMoney(li.totalPrice),
    metadata: li.custom?.fields ? { ...li.custom.fields } : undefined,
  };
}

export function mapCart(c: CtCart, locale: string = DEFAULT_LOCALE): Cart {
  const items = c.lineItems.map((li) => mapLineItem(li, locale));
  const subtotal = items.reduce(
    (acc, it) => ({ amount: acc.amount + it.lineTotal.amount, currency: it.lineTotal.currency || acc.currency }),
    { amount: 0, currency: c.totalPrice.currencyCode },
  );
  return {
    id: c.id,
    items,
    subtotal,
    total: mapMoney(c.totalPrice),
    tax: c.taxedPrice ? mapMoney(c.taxedPrice.totalGross) : null,
    shippingAddress: mapAddress(c.shippingAddress),
    billingAddress: mapAddress(c.billingAddress),
    updatedAt: c.lastModifiedAt,
    meta: { ctVersion: c.version, ctState: c.cartState },
  };
}

export function mapOrderState(ct: CtOrder): OrderStatus {
  if (ct.orderState === "Cancelled") return "cancelled";
  if (ct.orderState === "Complete") return "fulfilled";
  if (ct.shipmentState === "Shipped") return "shipped";
  if (ct.shipmentState === "Ready") return "fulfilled";
  if (ct.paymentState === "Paid") return "confirmed";
  return "created";
}

export function mapOrder(o: CtOrder, locale: string = DEFAULT_LOCALE): Order {
  const items = o.lineItems.map((li) => mapLineItem(li, locale));
  const subtotal = items.reduce(
    (acc, it) => ({ amount: acc.amount + it.lineTotal.amount, currency: it.lineTotal.currency || acc.currency }),
    { amount: 0, currency: o.totalPrice.currencyCode },
  );
  return {
    id: o.id,
    status: mapOrderState(o),
    items,
    subtotal,
    total: mapMoney(o.totalPrice),
    tax: o.taxedPrice ? mapMoney(o.taxedPrice.totalGross) : null,
    shippingAddress: mapAddress(o.shippingAddress),
    billingAddress: mapAddress(o.billingAddress),
    createdAt: o.createdAt,
    updatedAt: o.lastModifiedAt,
    paymentStatus: o.paymentState,
    meta: { ctOrderState: o.orderState, ctShipmentState: o.shipmentState },
  };
}

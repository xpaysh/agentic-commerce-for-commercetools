/**
 * commercetools Subscriptions → normalized OrderStateChanged events.
 *
 * Spec:
 *   https://docs.commercetools.com/api/projects/subscriptions
 *
 * For HTTP destination subscriptions, commercetools POSTs JSON messages with
 * `resource.typeId === "order"` events: OrderCreated, OrderStateChanged,
 * OrderImported, etc. HTTP destinations have no built-in signature header
 * (unlike SNS destinations), so we authenticate via a shared secret header
 * configured at subscription-create time and validated here.
 *
 * Register the subscription one-time per project pointing destination to
 * `${SITE_URL}/webhooks/commercetools` with header
 * `X-Xpay-Webhook-Secret: $XPAY_WEBHOOK_SHARED_SECRET`.
 *
 * v0.3 will move to SNS subscription destinations for hardened delivery
 * (retries, message signing, dead-lettering).
 */

import { RouteTable } from "./match";
import type { RouteHandler, RouteResponse } from "./types";
import { getOrderEventEmitter, type OrderEventTopic, type OrderStateChanged } from "../events";

const CT_NOTIFICATION_TYPE_TO_TOPIC: Record<string, OrderEventTopic | undefined> = {
  OrderCreated: "order.created",
  OrderStateChanged: "order.updated",
  OrderImported: "order.created",
  OrderPaymentStateChanged: "order.updated",
  OrderShipmentStateChanged: "order.updated",
  OrderCustomerEmailSet: "order.updated",
  OrderShippingAddressSet: "order.updated",
};

export function buildWebhookRouteTable(): RouteTable<RouteHandler> {
  const table = new RouteTable<RouteHandler>();
  table.add("POST", "/webhooks/commercetools", buildCommercetoolsWebhookRoute());
  return table;
}

export function buildCommercetoolsWebhookRoute(): RouteHandler {
  return async (req): Promise<RouteResponse> => {
    const secret = process.env.XPAY_WEBHOOK_SHARED_SECRET || "";
    if (!secret) {
      return jsonError(503, "webhook_secret_unconfigured", "XPAY_WEBHOOK_SHARED_SECRET env required");
    }
    if (headerOf(req.headers, "x-xpay-webhook-secret") !== secret) {
      return jsonError(401, "invalid_signature", "shared-secret mismatch");
    }

    let payload: { notificationType?: string; resource?: { typeId?: string; id?: string } } & Record<string, unknown>;
    try {
      payload = JSON.parse(req.body || "{}");
    } catch {
      return jsonError(400, "invalid_json", "webhook body is not valid JSON");
    }

    const mapped = payload.notificationType ? CT_NOTIFICATION_TYPE_TO_TOPIC[payload.notificationType] : undefined;
    if (!mapped || payload.resource?.typeId !== "order") {
      return { status: 204, headers: {}, body: "" };
    }

    const orderId = payload.resource?.id;
    if (!orderId) return jsonError(400, "missing_order_id", "resource.id required");

    const event: OrderStateChanged = {
      source: "commercetools",
      topic: mapped,
      orderId,
      occurredAt: new Date().toISOString(),
      payload,
    };
    await getOrderEventEmitter().emit(event);
    return { status: 200, headers: { "content-type": "application/json; charset=utf-8" }, body: JSON.stringify({ ok: true }) };
  };
}

function headerOf(headers: Record<string, string | string[] | undefined> | undefined, name: string): string | undefined {
  if (!headers) return undefined;
  const lower = name.toLowerCase();
  for (const k of Object.keys(headers)) {
    if (k.toLowerCase() === lower) {
      const v = headers[k];
      return Array.isArray(v) ? v[0] : v;
    }
  }
  return undefined;
}

function jsonError(status: number, code: string, message: string): RouteResponse {
  return {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify({ error: { code, message } }),
  };
}

/**
 * Normalized order-state change event. Every platform-native webhook handler
 * lowers its platform payload into this shape before emitting.
 *
 * v0.2.3 ships logging + optional HTTP relay; v0.3 wires this into the merchant
 * dashboard's order timeline via SNS/SQS or a dedicated ingestion endpoint.
 */

export type OrderEventSource =
  | "shopify"
  | "bigcommerce"
  | "magento"
  | "saleor"
  | "prestashop"
  | "commercetools"
  | "salesforce-commerce";

export type OrderEventTopic =
  | "order.created"
  | "order.updated"
  | "order.fulfilled"
  | "order.cancelled"
  | "order.refunded";

export interface OrderStateChanged {
  source: OrderEventSource;
  topic: OrderEventTopic;
  orderId: string;
  platformShop?: string;
  occurredAt: string;
  payload: unknown;
}

export interface OrderEventEmitter {
  emit(event: OrderStateChanged): Promise<void>;
}

class DefaultOrderEventEmitter implements OrderEventEmitter {
  private relayUrl?: string;
  constructor(relayUrl?: string) {
    this.relayUrl = relayUrl;
  }

  async emit(event: OrderStateChanged): Promise<void> {
    // eslint-disable-next-line no-console
    console.log(JSON.stringify({ evt: "order_state_changed", ...event }));
    if (!this.relayUrl) return;
    try {
      await fetch(this.relayUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(event),
      });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("order_event_relay_failed", err instanceof Error ? err.message : String(err));
    }
  }
}

let _emitter: OrderEventEmitter | null = null;

export function getOrderEventEmitter(): OrderEventEmitter {
  if (_emitter) return _emitter;
  _emitter = new DefaultOrderEventEmitter(process.env.XPAY_ORDER_EVENTS_URL);
  return _emitter;
}

export function setOrderEventEmitter(emitter: OrderEventEmitter): void {
  _emitter = emitter;
}

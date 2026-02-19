/**
 * Connector Registry — tracks active delivery channels and last user interaction.
 *
 * Connectors (Telegram, webhook, Discord, etc.) register themselves on startup,
 * providing a deliver function. The scheduler uses this to route heartbeat/cron
 * responses back to the user through the last-interacted channel.
 *
 * Design: single-tenant, multi-channel. One user, potentially reachable via
 * multiple connectors. Delivery target follows the "last" strategy — replies
 * go to whichever channel the user most recently interacted through.
 */

// ==================== Types ====================

export interface ConnectorHandle {
  /** Channel identifier, e.g. "telegram", "discord", "webhook". */
  channel: string
  /** Recipient identifier (chat id, webhook url, etc.). */
  to: string
  /** Send a text message through this connector. */
  deliver: (text: string) => Promise<void>
}

export interface LastInteraction {
  channel: string
  to: string
  ts: number
}

// ==================== Registry ====================

const connectors = new Map<string, ConnectorHandle>()
let lastInteraction: LastInteraction | null = null

/** Register a connector's delivery capability. Replaces any existing registration for this channel. */
export function registerConnector(handle: ConnectorHandle): () => void {
  connectors.set(handle.channel, handle)
  return () => { connectors.delete(handle.channel) }
}

/** Record that the user just interacted via this channel. */
export function touchInteraction(channel: string, to: string): void {
  lastInteraction = { channel, to, ts: Date.now() }
}

/** Get the last interaction info (channel + recipient). */
export function getLastInteraction(): LastInteraction | null {
  return lastInteraction
}

/** Resolve the delivery target: the connector the user last interacted with. */
export function resolveDeliveryTarget(): ConnectorHandle | null {
  if (!lastInteraction) {
    // No interaction yet — fall back to first registered connector
    const first = connectors.values().next()
    return first.done ? null : first.value
  }

  // Prefer the last-interacted channel
  const handle = connectors.get(lastInteraction.channel)
  if (handle) return handle

  // Channel was unregistered since — fall back to first available
  const first = connectors.values().next()
  return first.done ? null : first.value
}

/** List all registered connectors. */
export function listConnectors(): ConnectorHandle[] {
  return [...connectors.values()]
}

/** Check if any connectors are registered. */
export function hasConnectors(): boolean {
  return connectors.size > 0
}

// ==================== Testing ====================

export function _resetForTest(): void {
  connectors.clear()
  lastInteraction = null
}

/**
 * Active connection tracking for SSE streams
 * Tracks in-flight streaming requests with activity monitoring
 *
 * This module monitors active streaming connections and aborts them
 * if no SSE activity is received within the configured timeout period.
 *
 * Key features:
 * - Activity-based timeout (not total request timeout)
 * - Background interval check for inactive connections
 * - Status progression: active → idle → timeout
 */

import { randomUUID } from 'crypto'

/**
 * Internal connection state including AbortController
 */
interface InternalActiveConnection {
  correlationId: string          // Links to request history
  scenario: string               // Pool scenario (default, think, background)
  model: string                 // Target model
  startTime: number            // When connection started (ms)
  lastActivityTime: number     // Last SSE event received (ms)
  status: 'active' | 'idle' | 'timeout'
  abortController: AbortController  // Controller to abort on timeout
}

/**
 * Public connection info (without AbortController)
 */
export interface ActiveConnection {
  correlationId: string
  scenario: string
  model: string
  startTime: number
  lastActivityTime: number
  status: 'active' | 'idle' | 'timeout'
}

/**
 * Context returned when starting a connection
 */
export interface ConnectionContext {
  correlationId: string
  signal: AbortSignal
  updateActivity: () => void
}

// Map of active connections: correlationId -> InternalActiveConnection
const activeConnections = new Map<string, InternalActiveConnection>()

// Activity check interval (default: 30 seconds)
const ACTIVITY_CHECK_INTERVAL_MS = 30_000

// Default SSE activity timeout (default: 3 minutes)
const DEFAULT_SSE_ACTIVITY_TIMEOUT_MS = 180_000

// Timer for checking inactive connections
let activityCheckTimer: NodeJS.Timeout | null = null

// Current timeout setting (updated when connections start)
let currentTimeoutMs = DEFAULT_SSE_ACTIVITY_TIMEOUT_MS

/**
 * Start tracking an active streaming connection
 * Returns the correlation ID, abort signal, and activity update function
 */
export function startConnection(
  scenario: string,
  model: string,
  timeoutMs: number = DEFAULT_SSE_ACTIVITY_TIMEOUT_MS
): ConnectionContext {
  const correlationId = randomUUID()
  const abortController = new AbortController()

  // Update timeout if different from current
  if (timeoutMs !== currentTimeoutMs && activeConnections.size === 0) {
    currentTimeoutMs = timeoutMs
  }

  const connection: InternalActiveConnection = {
    correlationId,
    scenario,
    model,
    startTime: Date.now(),
    lastActivityTime: Date.now(),
    status: 'active',
    abortController
  }

  activeConnections.set(correlationId, connection)

  // Start activity check timer if not running
  startActivityCheck()

  // Function to update activity timestamp
  const updateActivity = () => {
    const conn = activeConnections.get(correlationId)
    if (conn) {
      conn.lastActivityTime = Date.now()
      conn.status = 'active'
    }
  }

  return {
    correlationId,
    signal: abortController.signal,
    updateActivity
  }
}

/**
 * Update activity timestamp for a connection
 * Called on each SSE chunk received
 */
export function updateActivity(correlationId: string): void {
  const conn = activeConnections.get(correlationId)
  if (conn) {
    conn.lastActivityTime = Date.now()
    conn.status = 'active'
  }
}

/**
 * End tracking for a connection
 * Called when stream closes or errors
 */
export function endConnection(correlationId: string): void {
  activeConnections.delete(correlationId)

  // Stop activity check timer if no more connections
  if (activeConnections.size === 0 && activityCheckTimer) {
    clearInterval(activityCheckTimer)
    activityCheckTimer = null
  }
}

/**
 * Get all active connections (without AbortController)
 */
export function getActiveConnections(): ActiveConnection[] {
  return Array.from(activeConnections.values()).map(conn => ({
    correlationId: conn.correlationId,
    scenario: conn.scenario,
    model: conn.model,
    startTime: conn.startTime,
    lastActivityTime: conn.lastActivityTime,
    status: conn.status
  }))
}

/**
 * Get connections for a specific scenario
 */
export function getConnectionsByScenario(scenario: string): ActiveConnection[] {
  return getActiveConnections().filter(conn => conn.scenario === scenario)
}

/**
 * Get count of active connections
 */
export function getActiveConnectionCount(): number {
  return activeConnections.size
}

/**
 * Start the activity check timer
 * Runs periodically to check for inactive connections
 */
function startActivityCheck(): void {
  if (activityCheckTimer) return

  activityCheckTimer = setInterval(() => {
    const now = Date.now()

    for (const [id, conn] of activeConnections) {
      const inactiveMs = now - conn.lastActivityTime

      if (inactiveMs > currentTimeoutMs) {
        // Mark as timed out
        conn.status = 'timeout'

        // Abort the connection
        conn.abortController.abort(new DOMException(
          `SSE activity timeout: no data received for ${Math.round(inactiveMs / 1000)}s`,
          'TimeoutError'
        ) as any)

        // Remove from active connections
        activeConnections.delete(id)
      } else if (inactiveMs > currentTimeoutMs / 2) {
        // Mark as idle if halfway to timeout
        conn.status = 'idle'
      }
    }

    // Stop timer if no connections remain
    if (activeConnections.size === 0) {
      clearInterval(activityCheckTimer!)
      activityCheckTimer = null
    }
  }, ACTIVITY_CHECK_INTERVAL_MS)
}

/**
 * Get configuration for SSE activity timeout
 */
export function getSSEActivityTimeout(config: any): number {
  return config.SSE_ACTIVITY_TIMEOUT_MS ?? DEFAULT_SSE_ACTIVITY_TIMEOUT_MS
}

/**
 * Clear all connections (for testing/cleanup)
 */
export function clearAllConnections(): void {
  for (const conn of activeConnections.values()) {
    try {
      conn.abortController.abort(new DOMException('Connection cleared', 'AbortError') as any)
    } catch {
      // Ignore abort errors
    }
  }
  activeConnections.clear()
  if (activityCheckTimer) {
    clearInterval(activityCheckTimer)
    activityCheckTimer = null
  }
}

/**
 * Check if there are any active connections
 */
export function hasActiveConnections(): boolean {
  return activeConnections.size > 0
}

/**
 * Get the current activity timeout setting
 */
export function getCurrentTimeout(): number {
  return currentTimeoutMs
}
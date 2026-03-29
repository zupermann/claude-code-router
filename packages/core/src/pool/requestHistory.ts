/**
 * Request history tracking for pool monitoring
 * Ring buffer implementation for tracking individual request outcomes
 *
 * Tracks:
 * - Correlation ID to link retry chains (same request retried to different model)
 * - Request outcome (success, failure, retry)
 * - Timing data (latency)
 * - Error details (HTTP status, error message)
 */

import { randomUUID } from 'crypto'

/**
 * Outcome of a request attempt
 */
export type RequestOutcome = 'success' | 'failure' | 'retry'

/**
 * A single request history entry
 */
export interface RequestHistoryEntry {
  correlationId: string         // Unique ID linking related requests
  timestamp: number             // When request started (ms)
  scenario: string              // Pool scenario (default, think, background)
  targetModel: string           // Model selected for this request
  outcome: RequestOutcome       // success | failure | retry
  latencyMs: number             // Execution time in milliseconds
  httpStatus: number | null     // HTTP status code (200, 429, 500, 408 for timeout)
  errorMessage: string | null    // Error message if failed
  isRetry: boolean              // True if this is a retry of a failed request
  originalModel: string | null  // If isRetry, which model failed first
  originalCorrelationId: string | null  // If isRetry, correlation ID of original request
}

/**
 * Internal tracking entry for in-flight requests
 */
interface InFlightRequest {
  correlationId: string
  startTime: number
  scenario: string
  targetModel: string
  isRetry: boolean
  originalModel: string | null
  originalCorrelationId: string | null
}

// Ring buffer for request history
const MAX_REQUEST_HISTORY = 50
const requestHistory: RequestHistoryEntry[] = []

// Map of in-flight requests: correlationId -> InFlightRequest
const inFlightRequests = new Map<string, InFlightRequest>()

/**
 * Generate a new correlation ID
 */
export function generateCorrelationId(): string {
  return randomUUID()
}

/**
 * Record the start of a request
 * Returns the correlation ID to use for tracking
 */
export function recordRequestStart(
  scenario: string,
  targetModel: string
): string {
  const id = generateCorrelationId()

  inFlightRequests.set(id, {
    correlationId: id,
    startTime: Date.now(),
    scenario,
    targetModel,
    isRetry: false,
    originalModel: null,
    originalCorrelationId: null
  })

  return id
}

/**
 * Record a retry attempt
 * Links to the original failed request
 */
export function recordRetryStart(
  scenario: string,
  targetModel: string,
  originalCorrelationId: string,
  originalModel: string
): string {
  const id = generateCorrelationId()

  inFlightRequests.set(id, {
    correlationId: id,
    startTime: Date.now(),
    scenario,
    targetModel,
    isRetry: true,
    originalModel,
    originalCorrelationId
  })

  return id
}

/**
 * Record the end of a request
 * Moves from in-flight to history
 */
export function recordRequestEnd(
  correlationId: string,
  outcome: RequestOutcome,
  httpStatus: number | null = null,
  errorMessage: string | null = null
): void {
  const inFlight = inFlightRequests.get(correlationId)
  if (!inFlight) {
    // Request not tracked, skip
    return
  }

  const entry: RequestHistoryEntry = {
    correlationId: inFlight.correlationId,
    timestamp: inFlight.startTime,
    scenario: inFlight.scenario,
    targetModel: inFlight.targetModel,
    outcome,
    latencyMs: Date.now() - inFlight.startTime,
    httpStatus,
    errorMessage,
    isRetry: inFlight.isRetry,
    originalModel: inFlight.originalModel,
    originalCorrelationId: inFlight.originalCorrelationId
  }

  // Add to ring buffer
  requestHistory.push(entry)

  // Trim if exceeds max
  if (requestHistory.length > MAX_REQUEST_HISTORY) {
    requestHistory.shift()
  }

  // Remove from in-flight
  inFlightRequests.delete(correlationId)
}

/**
 * Get all request history entries (most recent last)
 */
export function getRequestHistory(): RequestHistoryEntry[] {
  return [...requestHistory]
}

/**
 * Get request history for a specific scenario
 */
export function getRequestHistoryByScenario(scenario: string): RequestHistoryEntry[] {
  return requestHistory.filter(e => e.scenario === scenario)
}

/**
 * Get request history for a specific model
 */
export function getRequestHistoryByModel(
  scenario: string,
  model: string
): RequestHistoryEntry[] {
  return requestHistory.filter(
    e => e.scenario === scenario && e.targetModel === model
  )
}

/**
 * Clear all request history
 */
export function clearRequestHistory(): void {
  requestHistory.length = 0
  inFlightRequests.clear()
}

/**
 * Get summary stats from request history
 */
export function getRequestHistoryStats(): {
  totalRequests: number
  successCount: number
  failureCount: number
  retryCount: number
  avgLatency: number | null
} {
  if (requestHistory.length === 0) {
    return {
      totalRequests: 0,
      successCount: 0,
      failureCount: 0,
      retryCount: 0,
      avgLatency: null
    }
  }

  let successCount = 0
  let failureCount = 0
  let retryCount = 0
  let totalLatency = 0

  for (const entry of requestHistory) {
    if (entry.outcome === 'success') successCount++
    else if (entry.outcome === 'failure') failureCount++
    else if (entry.outcome === 'retry') retryCount++
    totalLatency += entry.latencyMs
  }

  return {
    totalRequests: requestHistory.length,
    successCount,
    failureCount,
    retryCount,
    avgLatency: Math.round(totalLatency / requestHistory.length)
  }
}
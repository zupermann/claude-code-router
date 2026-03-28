/**
 * Stats collector for pool monitoring
 * Tracks per-target request metrics: hits, successes, failures
 * All state is process-local, consistent with poolStore
 */

import { FailureType } from './types'

/**
 * Statistics for a single target within a pool
 */
export interface TargetStats {
  model: string
  scenario: string
  totalRequests: number // incremented on every selectTargetFromPool
  successCount: number // incremented when request completes without error
  failureCount: number // incremented on recordFailure calls
  lastFailureType?: FailureType
  lastFailureAt?: number // ms timestamp
  lastSelectedAt?: number // ms timestamp - when last picked by WRR
}

/**
 * Health event for history tracking
 */
export interface HealthEvent {
  timestamp: number
  scenario: string
  model: string
  event: 'suppressed' | 'recovery_started' | 'recovered' | 'fail_open' | 'selected'
  details: {
    httpStatus?: number
    effectiveWeight?: number
    suppressedUntil?: number
  }
}

// Stats store: scenario -> model -> TargetStats
const statsStore = new Map<string, Map<string, TargetStats>>()

// Ring buffer for health events (last 500)
const MAX_HISTORY_EVENTS = 500
const healthHistory: HealthEvent[] = []

/**
 * Get or create stats entry for a target
 */
function getOrCreateStats(scenario: string, model: string): TargetStats {
  let scenarioMap = statsStore.get(scenario)
  if (!scenarioMap) {
    scenarioMap = new Map<string, TargetStats>()
    statsStore.set(scenario, scenarioMap)
  }

  let stats = scenarioMap.get(model)
  if (!stats) {
    stats = {
      model,
      scenario,
      totalRequests: 0,
      successCount: 0,
      failureCount: 0,
    }
    scenarioMap.set(model, stats)
  }

  return stats
}

/**
 * Record a target selection event
 * Called inside selectTargetFromPool right after target selection
 */
export function recordSelection(scenario: string, model: string): void {
  const stats = getOrCreateStats(scenario, model)
  stats.totalRequests++
  stats.lastSelectedAt = Date.now()

  // Also record to history
  recordHealthEvent(scenario, model, 'selected', {})
}

/**
 * Record a successful request completion
 * Called after provider responds successfully
 */
export function recordSuccess(scenario: string, model: string): void {
  const stats = getOrCreateStats(scenario, model)
  stats.successCount++
}

/**
 * Record a failed request
 * Called when a request fails (extends existing recordFailure)
 */
export function recordFailure(
  scenario: string,
  model: string,
  type: FailureType
): void {
  const stats = getOrCreateStats(scenario, model)
  stats.failureCount++
  stats.lastFailureType = type
  stats.lastFailureAt = Date.now()
}

/**
 * Get stats for a specific target
 */
export function getTargetStats(
  scenario: string,
  model: string
): TargetStats | null {
  const scenarioMap = statsStore.get(scenario)
  if (!scenarioMap) return null
  return scenarioMap.get(model) || null
}

/**
 * Get all stats for all scenarios and targets
 */
export function getAllStats(): Map<string, Map<string, TargetStats>> {
  return statsStore
}

/**
 * Reset stats for a target, scenario, or all
 * - resetStats() - clears all stats
 * - resetStats(scenario) - clears all stats for scenario
 * - resetStats(scenario, model) - clears stats for specific target
 */
export function resetStats(
  scenario?: string,
  model?: string
): { cleared: number } {
  let cleared = 0

  if (scenario === undefined) {
    // Clear all stats
    cleared = statsStore.size
    statsStore.clear()
    healthHistory.length = 0
    return { cleared }
  }

  const scenarioMap = statsStore.get(scenario)
  if (!scenarioMap) {
    return { cleared: 0 }
  }

  if (model === undefined) {
    // Clear all stats for this scenario
    cleared = scenarioMap.size
    statsStore.delete(scenario)
    // Clear related history events
    for (let i = healthHistory.length - 1; i >= 0; i--) {
      if (healthHistory[i].scenario === scenario) {
        healthHistory.splice(i, 1)
      }
    }
    return { cleared }
  }

  // Clear specific target
  if (scenarioMap.has(model)) {
    scenarioMap.delete(model)
    cleared = 1
    // Clear related history events
    for (let i = healthHistory.length - 1; i >= 0; i--) {
      if (healthHistory[i].scenario === scenario && healthHistory[i].model === model) {
        healthHistory.splice(i, 1)
      }
    }
  }

  return { cleared }
}

/**
 * Record a health event to history
 */
export function recordHealthEvent(
  scenario: string,
  model: string,
  event: HealthEvent['event'],
  details: HealthEvent['details']
): void {
  healthHistory.push({
    timestamp: Date.now(),
    scenario,
    model,
    event,
    details,
  })

  // Trim if exceeds max
  if (healthHistory.length > MAX_HISTORY_EVENTS) {
    healthHistory.shift()
  }
}

/**
 * Get health history for a target or all
 */
export function getHealthHistory(
  scenario?: string,
  model?: string
): HealthEvent[] {
  if (scenario === undefined) {
    return [...healthHistory]
  }

  if (model === undefined) {
    return healthHistory.filter((e) => e.scenario === scenario)
  }

  return healthHistory.filter(
    (e) => e.scenario === scenario && e.model === model
  )
}

/**
 * Get aggregated stats for monitoring dashboard
 */
export function getStatsSummary(): {
  totalRequests: number
  totalSuccesses: number
  totalFailures: number
  byScenario: Record<
    string,
    {
      totalRequests: number
      successCount: number
      failureCount: number
      targets: number
    }
  >
} {
  const summary = {
    totalRequests: 0,
    totalSuccesses: 0,
    totalFailures: 0,
    byScenario: {} as Record<
      string,
      {
        totalRequests: number
        successCount: number
        failureCount: number
        targets: number
      }
    >,
  }

  for (const [scenario, scenarioMap] of statsStore.entries()) {
    let scenarioRequests = 0
    let scenarioSuccesses = 0
    let scenarioFailures = 0

    for (const stats of scenarioMap.values()) {
      scenarioRequests += stats.totalRequests
      scenarioSuccesses += stats.successCount
      scenarioFailures += stats.failureCount
    }

    summary.totalRequests += scenarioRequests
    summary.totalSuccesses += scenarioSuccesses
    summary.totalFailures += scenarioFailures
    summary.byScenario[scenario] = {
      totalRequests: scenarioRequests,
      successCount: scenarioSuccesses,
      failureCount: scenarioFailures,
      targets: scenarioMap.size,
    }
  }

  return summary
}

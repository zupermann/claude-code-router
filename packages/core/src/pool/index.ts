import { RouteValue, PoolState, TargetState, FailureContext, isPoolConfig } from './types'
import { parseAllRoutes } from './config'
import { selectTarget, getCandidates } from './selection'
import { applyFailure, applySuccess, updateRecovery, classifyFailure } from './health'
import { poolLogger } from './logger'
import * as stats from './stats'
import * as requestHistory from './requestHistory'

// Re-export isPoolConfig for router
export { isPoolConfig }
// Re-export health functions
export { applyFailure, applySuccess }
// Re-export stats functions for external use
export {
  stats,
  type stats,
}

// Re-export request history functions for external use
export {
  requestHistory,
  type requestHistory,
}

/**
 * Global pool state store
 * Keyed by scenario (e.g., "default", "think", "background")
 */
const poolStore = new Map<string, PoolState>()

/**
 * Initialize pool state from router config
 * Call this at startup
 */
export function initializePools(routerConfig: Record<string, RouteValue>): void {
  const parsed = parseAllRoutes(routerConfig)

  for (const [scenario, route] of parsed) {
    if (typeof route === 'object' && route.strategy === 'weighted_round_robin') {
      poolStore.set(scenario, route)
    }
    // Legacy string routes are not stored
  }
}

/**
 * Get pool state for scenario, or null if not a pool
 */
export function getPoolState(scenario: string): PoolState | null {
  return poolStore.get(scenario) ?? null
}

/**
 * Get all pool scenarios
 */
export function getPoolScenarios(): string[] {
  return Array.from(poolStore.keys())
}

/**
 * Select target from pool
 * Returns { target, selectedFrom, candidates, policy }
 */
export function selectTargetFromPool(scenario: string) {
  const pool = poolStore.get(scenario)
  if (!pool) {
    throw new Error(`No pool for scenario: ${scenario}`)
  }

  const result = selectTarget(pool)
  const candidates = getCandidates(pool)

  // Record selection for stats tracking
  stats.recordSelection(scenario, result.target.model)

  return {
    target: result.target,
    selectedFrom: result.selectedFrom,
    candidates,
    policy: pool.health
  }
}

/**
 * Record failure for target
 * Updates health state, logs handled by caller
 */
export function recordFailure(
  scenario: string,
  model: string,
  httpStatus?: number,
  errorMessage?: string
): { suppressed: boolean; suppressedUntil?: number } {
  const pool = poolStore.get(scenario)
  if (!pool) {
    poolLogger.info(`[Pool recordFailure: no pool for scenario ${scenario}`)
    return { suppressed: false }
  }

  const target = pool.targets.get(model)
  if (!target) {
    poolLogger.info(`[Pool recordFailure: target ${model} not found in scenario ${scenario}. Available: ${Array.from(pool.targets.keys()).join(', ')}`)
    return { suppressed: false }
  }

  // Classify failure
  const failureType = classifyFailure(httpStatus, errorMessage)
  if (!failureType) {
    poolLogger.info(`[Pool recordFailure: failure not classified as health-relevant (status=${httpStatus}, msg=${errorMessage?.substring(0, 50)})`)
    return { suppressed: false }  // not a health failure
  }

  // Record failure in stats
  stats.recordFailure(scenario, model, failureType)
  poolLogger.info(`[Pool recordFailure: ${scenario}/${model} - type=${failureType}, prevWeight=${target.effectiveWeight}`)

  // Apply failure
  const prevWeight = target.effectiveWeight
  applyFailure(target, httpStatus, errorMessage, pool.health)

  return {
    suppressed: true,
    suppressedUntil: target.suppressedUntil
  }
}

/**
 * Record success for target - restores it to healthy state
 * Call this when a request succeeds for this target
 */
export function recordSuccess(
  scenario: string,
  model: string
): void {
  const pool = poolStore.get(scenario)
  if (!pool) {
    poolLogger.info(`[Pool recordSuccess: no pool for scenario ${scenario}`)
    return
  }

  const target = pool.targets.get(model)
  if (!target) {
    poolLogger.info(`[Pool recordSuccess: target ${model} not found in scenario ${scenario}`)
    return
  }

  // Always record success timestamp and clear last error code (requirements #6 and #9)
  target.lastSuccessAt = Date.now()
  target.lastFailureHttpStatus = undefined
  target.consecutiveFailures = 0 // Reset failure count for exponential backoff

  // Only restore weight if target was recovering
  // (i.e., effectiveWeight < defaultWeight)
  if (target.effectiveWeight < target.defaultWeight) {
    const prevWeight = target.effectiveWeight
    applySuccess(target)
    poolLogger.info(`[Pool recordSuccess: ${scenario}/${model} - weight ${prevWeight}->${target.effectiveWeight}, state=healthy`)
  }
}

/**
 * Update recovery state (call on every selection or periodically)
 */
export function updateTargetRecovery(scenario: string, model: string): void {
  const pool = poolStore.get(scenario)
  if (!pool) return

  const target = pool.targets.get(model)
  if (!target) return

  updateRecovery(target, pool.health)
}

/**
 * Apply success to target: restore to healthy state
 * Only call this when a request actually succeeds.
 */
export function applyTargetSuccess(
  scenario: string,
  model: string
): void {
  const pool = poolStore.get(scenario)
  if (!pool) {
    poolLogger.info(`[Pool applyTargetSuccess: no pool for scenario ${scenario}`)
    return
  }

  const target = pool.targets.get(model)
  if (!target) {
    poolLogger.info(`[Pool applyTargetSuccess: target ${model} not found in scenario ${scenario}`)
    return
  }

  const prevWeight = target.effectiveWeight
  applySuccess(target)
  poolLogger.info(`[Pool applyTargetSuccess: ${scenario}/${model} restored from ${prevWeight} to ${target.effectiveWeight}`)
}

/**
 * Reset all pools to default state (for testing or restart)
 */
export function resetPoolState(): void {
  for (const pool of poolStore.values()) {
    for (const target of pool.targets.values()) {
      target.effectiveWeight = target.defaultWeight
      target.suppressedUntil = undefined
      target.lastFailureAt = undefined
      target.lastRecoveryStartedAt = undefined
      target.consecutiveFailures = 0
      target.currentWeight = 0
    }
  }
}

/**
 * Export state for debugging/observability
 * Also triggers recovery updates for all targets
 */
export function getPoolDebugInfo(scenario: string) {
  const pool = poolStore.get(scenario)
  if (!pool) return null

  // Update recovery for ALL targets (including suppressed ones)
  // This is needed because updateRecovery is normally only called on selected targets
  for (const target of pool.targets.values()) {
    updateRecovery(target, pool.health)
  }

  return {
    scenario,
    strategy: pool.strategy,
    health: pool.health,
    targets: Array.from(pool.targets.values()).map(t => ({
      model: t.model,
      defaultWeight: t.defaultWeight,
      effectiveWeight: t.effectiveWeight,
      suppressed: t.suppressedUntil !== undefined && t.suppressedUntil > Date.now(),
      recovering: t.lastRecoveryStartedAt !== undefined,
      consecutiveFailures: t.consecutiveFailures,
      suppressedUntil: t.suppressedUntil,
      lastFailureAt: t.lastFailureAt,
      lastFailureHttpStatus: t.lastFailureHttpStatus,
      lastRecoveryStartedAt: t.lastRecoveryStartedAt,
      lastSuccessAt: t.lastSuccessAt
    }))
  }
}

/**
 * Get status summary for all pools
 * Status: suspended -> ready -> healthy
 */
export function getPoolStatusSummary() {
  const summary: Record<string, any> = {}

  for (const scenario of getPoolScenarios()) {
    const debug = getPoolDebugInfo(scenario)
    if (!debug) continue

    const now = Date.now()
    let suspended = 0
    let ready = 0
    let healthy = 0

    for (const t of debug.targets) {
      if (t.suppressed) {
        suspended++
      } else {
        // Check if we've had a success since the last failure
        const hasSuccessSinceLastFailure = t.lastSuccessAt &&
          (!t.lastFailureAt || t.lastSuccessAt > t.lastFailureAt)

        // Must have success since last failure to be healthy
        if ((t.effectiveWeight < t.defaultWeight || t.lastRecoveryStartedAt) ||
            !hasSuccessSinceLastFailure) {
          ready++
        } else {
          healthy++
        }
      }
    }

    summary[scenario] = {
      totalTargets: debug.targets.length,
      healthy,
      ready,
      suspended
    }
  }

  return summary
}

/**
 * Internal helper: get healthy targets as array with weights
 * Used by both selectHealthyPoolTarget and getHealthyPoolTargets
 */
function getHealthyTargetsWithWeight(
  pool: PoolState,
  excludeModel?: string
): { model: string; weight: number }[] {
  const healthyTargets: { model: string; weight: number }[] = []

  for (const [model, target] of pool.targets) {
    // Skip the failed model
    if (model === excludeModel) continue
    // Skip suppressed targets (effectiveWeight <= 0)
    if (target.effectiveWeight <= 0) continue
    // Skip permanently disabled targets
    if (target.defaultWeight <= 0) continue

    healthyTargets.push({ model, weight: target.effectiveWeight })
  }

  return healthyTargets
}

/**
 * Select a healthy pool target using weighted random selection
 * Excludes a specific model (the failed one)
 * Returns a single model selected proportionally to its effective weight
 */
export function selectHealthyPoolTarget(scenario: string, excludeModel?: string): string | null {
  const pool = poolStore.get(scenario)
  if (!pool) return null

  const healthyTargets = getHealthyTargetsWithWeight(pool, excludeModel)
  if (healthyTargets.length === 0) return null

  // Calculate total weight
  const totalWeight = healthyTargets.reduce((sum, t) => sum + t.weight, 0)
  if (totalWeight <= 0) return null

  // Weighted random selection (roulette wheel)
  const random = Math.random() * totalWeight
  let accumulated = 0
  for (const target of healthyTargets) {
    accumulated += target.weight
    if (random < accumulated) {
      return target.model
    }
  }

  // Fallback to last target (shouldn't happen)
  return healthyTargets[healthyTargets.length - 1].model
}

/**
 * Get list of healthy pool targets (excluding a specific model)
 * Returns models sorted by weight (highest first)
 * Used for logging/debugging purposes
 */
export function getHealthyPoolTargets(scenario: string, excludeModel?: string): string[] {
  const pool = poolStore.get(scenario)
  if (!pool) return []

  const healthyTargets = getHealthyTargetsWithWeight(pool, excludeModel)

  // Sort by weight descending
  healthyTargets.sort((a, b) => b.weight - a.weight)
  return healthyTargets.map(t => t.model)
}
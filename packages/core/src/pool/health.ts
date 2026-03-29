import { TargetState, FailureType, RouteHealthConfig, MAX_COOLDOWN_MS } from './types'

/**
 * Classify HTTP status + error into failure type
 * ALL errors (4xx, 5xx, timeout, network) are treated as failures
 * This ensures any non-success response triggers suppression and retry
 */
export function classifyFailure(
  httpStatus?: number,
  errorMessage?: string
): FailureType | null {
  // HTTP 429: rate limit
  if (httpStatus === 429) {
    return '429'
  }

  // HTTP 404: model not found (provider doesn't have this model)
  if (httpStatus === 404) {
    return 'network'
  }

  // HTTP 5xx: server error
  if (httpStatus && httpStatus >= 500 && httpStatus < 600) {
    return '5xx'
  }

  // HTTP 4xx (other than 429, 404): client errors - also treated as failures
  if (httpStatus && httpStatus >= 400 && httpStatus < 500) {
    return '5xx' // Use '5xx' type for all HTTP errors (they all suppress)
  }

  // Network/timeout errors
  if (errorMessage) {
    const msg = errorMessage.toLowerCase()
    if (
      msg.includes('timeout') ||
      msg.includes('econnrefused') ||
      msg.includes('econnreset') ||
      msg.includes('enotfound') ||
      msg.includes('network') ||
      msg.includes('socket')
    ) {
      return 'network'
    }
  }

  // If we have any error message but couldn't classify it, still treat as network error
  if (errorMessage) {
    return 'network'
  }

  return null
}

/**
 * Apply failure to target: suppress and mark
 * Uses exponential backoff: cooldown doubles with each consecutive failure
 */
export function applyFailure(
  target: TargetState,
  httpStatus?: number,
  errorMessage?: string,
  health?: Required<RouteHealthConfig>
): void {
  const now = Date.now()

  // Hard drop to 0
  target.effectiveWeight = 0

  // Increment failure count BEFORE calculating backoff
  target.consecutiveFailures += 1

  // Store last HTTP status
  if (httpStatus !== undefined) {
    target.lastFailureHttpStatus = httpStatus
  }

  // Exponential backoff: baseCooldown * 2^(failures-1)
  // Capped at MAX_COOLDOWN_MS
  const baseCooldown = target.baseCooldown ?? health?.cooldown_ms ?? 60000
  const backoffMultiplier = Math.pow(2, target.consecutiveFailures - 1)
  const exponentialCooldown = Math.min(
    baseCooldown * backoffMultiplier,
    MAX_COOLDOWN_MS
  )

  target.suppressedUntil = now + exponentialCooldown
  target.lastFailureAt = now
  target.lastRecoveryStartedAt = undefined // Reset recovery state

  // Log is done by caller (has context for structured logging)
}

/**
 * Update recovery state - gradually increases weight over time
 *
 * State Machine:
 *   suspended (cooldown) → recovering → healthy
 *
 * suspended:
 *   - effectiveWeight = 0
 *   - Countdown to suppressedUntil
 *   - After countdown ends, transition to recovering
 *
 * recovering:
 *   - effectiveWeight gradually increases
 *   - Every recovery_interval_ms, weight += recovery_step
 *   - Allows target to be probed with partial weight
 *   - Caps at defaultWeight
 *
 * healthy:
 *   - effectiveWeight = defaultWeight
 *   - Count up since reached max weight
 */
export function updateRecovery(
  target: TargetState,
  health: Required<RouteHealthConfig>
): void {
  const now = Date.now()

  // If still suppressed, do nothing
  if (target.suppressedUntil !== undefined && now < target.suppressedUntil) {
    return
  }

  // If suppression just ended, transition to recovering
  // Set lastRecoveryStartedAt to track when recovery began
  // Start with weight 1 immediately (no need to wait for first recovery interval)
  if (target.suppressedUntil !== undefined && target.lastRecoveryStartedAt === undefined) {
    target.lastRecoveryStartedAt = now
    target.effectiveWeight = health.recovery_step // Start at 1 (or recovery_step), not 0
    target.suppressedUntil = undefined // Clear suppression
    return
  }

  // If not in recovery (lastRecoveryStartedAt not set), nothing to do
  if (target.lastRecoveryStartedAt === undefined) {
    return
  }

  // Already at max weight - healthy state
  if (target.effectiveWeight >= target.defaultWeight) {
    target.effectiveWeight = target.defaultWeight
    target.lastRecoveryStartedAt = undefined // Mark as fully recovered
    target.consecutiveFailures = 0 // Reset failures only when fully healthy
    return
  }

  // In recovering state - gradually increase weight
  // Calculate how many recovery steps have elapsed since recovery started
  // Note: We start at weight = recovery_step immediately after cooldown ends
  const elapsedMs = now - target.lastRecoveryStartedAt
  const stepsCompleted = Math.floor(elapsedMs / health.recovery_interval_ms)

  // Calculate new weight: start at recovery_step, add recovery_step per interval
  // Weight progression: 1 -> 2 -> 3 (with recovery_step=1, defaultWeight=3)
  const newWeight = Math.min(
    target.defaultWeight,
    health.recovery_step * (stepsCompleted + 1)
  )

  target.effectiveWeight = newWeight

  // Check if we've reached full health
  if (target.effectiveWeight >= target.defaultWeight) {
    target.effectiveWeight = target.defaultWeight
    target.lastRecoveryStartedAt = undefined
    target.consecutiveFailures = 0
  }
}

/**
 * Reset target to healthy state (on success)
 * Immediately restores to full weight and records success timestamp
 */
export function applySuccess(target: TargetState): void {
  target.consecutiveFailures = 0
  target.effectiveWeight = target.defaultWeight
  target.lastRecoveryStartedAt = undefined
  target.suppressedUntil = undefined
  target.lastFailureHttpStatus = undefined // Clear last error code on success
  target.lastSuccessAt = Date.now() // Record success timestamp
  // Note: lastFailureAt is kept for diagnostic purposes
}

/**
 * Check if target is in cooldown (suppressed)
 */
export function isSuppressed(target: TargetState, now: number = Date.now()): boolean {
  return target.suppressedUntil !== undefined && now < target.suppressedUntil
}

/**
 * Check if target is in recovering phase
 */
export function isRecovering(target: TargetState, now: number = Date.now()): boolean {
  // Recovering if: not suppressed, has recovery started, and weight < max
  const suppressed = target.suppressedUntil !== undefined && now < target.suppressedUntil
  if (suppressed) return false

  return target.lastRecoveryStartedAt !== undefined ||
    (target.effectiveWeight > 0 && target.effectiveWeight < target.defaultWeight)
}

/**
 * Check if target is healthy (at full weight)
 */
export function isHealthy(target: TargetState): boolean {
  return target.effectiveWeight >= target.defaultWeight &&
    target.suppressedUntil === undefined
}

/**
 * Get time until target is eligible again (for suspended targets)
 */
export function getTimeUntilEligible(
  target: TargetState,
  now: number = Date.now()
): number {
  if (target.suppressedUntil !== undefined && now < target.suppressedUntil) {
    return target.suppressedUntil - now
  }
  return 0 // eligible now
}

/**
 * Get time until next weight increase (for recovering targets)
 */
export function getTimeUntilNextWeightIncrease(
  target: TargetState,
  health: Required<RouteHealthConfig>,
  now: number = Date.now()
): number {
  if (!target.lastRecoveryStartedAt) return 0

  const elapsedMs = now - target.lastRecoveryStartedAt
  const stepsCompleted = Math.floor(elapsedMs / health.recovery_interval_ms)
  const nextStepAt = target.lastRecoveryStartedAt + (stepsCompleted + 1) * health.recovery_interval_ms

  return Math.max(0, nextStepAt - now)
}

/**
 * Get time since target became healthy (for healthy targets)
 */
export function getTimeSinceHealthy(
  target: TargetState,
  now: number = Date.now()
): number {
  // If we tracked when target became healthy, we'd return that
  // For now, return time since last failure or 0
  if (target.lastFailureAt === undefined) return 0
  return now - target.lastFailureAt
}

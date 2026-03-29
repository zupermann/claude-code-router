import { PoolState, TargetState, SelectionResult } from './types'

/**
 * Random weighted selection
 *
 * Algorithm (Roulette Wheel / Weighted Random):
 * 1. Calculate total effective weight of all eligible targets
 * 2. Generate random number between 0 and total weight
 * 3. Iterate through targets, accumulating weights
 * 4. Select target when accumulated weight exceeds random number
 *
 * Each target's probability = effectiveWeight / totalEffectiveWeight
 * e.g., weight 3 out of total 12 = 25% chance
 */
export function selectTarget(pool: PoolState): SelectionResult {
  // Filter eligible targets:
  // - effectiveWeight > 0 (not temporarily suppressed)
  // - defaultWeight > 0 (not permanently disabled)
  const eligibleTargets = Array.from(pool.targets.values()).filter(
    t => t.effectiveWeight > 0 && t.defaultWeight > 0
  )

  // If no eligible targets, use fail-open policy
  if (eligibleTargets.length === 0) {
    return selectFailOpen(pool)
  }

  // Calculate total effective weight
  const totalWeight = eligibleTargets.reduce(
    (sum, t) => sum + t.effectiveWeight,
    0
  )

  // Generate random number in range [0, totalWeight)
  const random = Math.random() * totalWeight

  // Select target using roulette wheel selection
  let accumulated = 0
  for (const target of eligibleTargets) {
    accumulated += target.effectiveWeight
    if (random < accumulated) {
      return {
        target,
        selectedFrom: 'healthy'
      }
    }
  }

  // Fallback (shouldn't happen, but for safety)
  return {
    target: eligibleTargets[eligibleTargets.length - 1],
    selectedFrom: 'healthy'
  }
}

/**
 * Fail-open policy: select target with earliest suppression recovery time
 *
 * Logic:
 * - Skip targets with defaultWeight === 0 (permanently disabled)
 * - If suppressedUntil is set, use that
 * - Otherwise use lastFailureAt + cooldown_ms
 * - If neither exists, pick any (shouldn't happen)
 */
function selectFailOpen(pool: PoolState): SelectionResult {
  // Filter out permanently disabled targets
  const candidates = Array.from(pool.targets.values()).filter(
    t => t.defaultWeight > 0
  )

  if (candidates.length === 0) {
    throw new Error('No eligible targets: all targets have weight 0 (permanently disabled)')
  }

  let earliest = candidates[0]

  for (const target of candidates) {
    const earliestRecoveryTime = getRecoveryTime(target, pool.health.cooldown_ms)
    const candidateRecoveryTime = getRecoveryTime(earliest, pool.health.cooldown_ms)

    if (earliestRecoveryTime < candidateRecoveryTime) {
      earliest = target
    }
  }

  return {
    target: earliest,
    selectedFrom: 'fail_open'
  }
}

/**
 * Get timestamp when target will be eligible for selection again
 */
function getRecoveryTime(
  target: TargetState,
  cooldownMs: number
): number {
  if (target.suppressedUntil !== undefined) {
    return target.suppressedUntil
  }
  if (target.lastFailureAt !== undefined) {
    return target.lastFailureAt + cooldownMs
  }
  return 0  // no failure, eligible now
}

/**
 * Get candidates for selection (for logging)
 */
export function getCandidates(
  pool: PoolState
): Array<{ model: string; defaultWeight: number; effectiveWeight: number; isEligible: boolean; isDisabled: boolean }> {
  return Array.from(pool.targets.values()).map(t => ({
    model: t.model,
    defaultWeight: t.defaultWeight,
    effectiveWeight: t.effectiveWeight,
    isEligible: t.effectiveWeight > 0 && t.defaultWeight > 0,
    isDisabled: t.defaultWeight === 0
  }))
}
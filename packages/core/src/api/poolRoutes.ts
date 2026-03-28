/**
 * Pool monitoring API routes
 * Provides endpoints for load balancer observability and management
 */

import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import * as pool from '../pool'
import { stats } from '../pool'

/**
 * Format milliseconds to human-readable duration
 * e.g., 245000 -> "4m 5s"
 */
function formatDuration(ms: number): string | null {
  if (ms <= 0) return null
  const seconds = Math.floor(ms / 1000)
  const mins = Math.floor(seconds / 60)
  const secs = seconds % 60
  if (mins > 0) {
    return `${mins}m ${secs}s`
  }
  return `${secs}s`
}

/**
 * Get health status string from target state
 */
function getHealthStatus(target: any): 'healthy' | 'suppressed' | 'recovering' {
  const now = Date.now()
  if (target.suppressed && target.suppressedUntil > now) {
    return 'suppressed'
  }
  if (target.recovering) {
    return 'recovering'
  }
  return 'healthy'
}

/**
 * Calculate weight percentage
 */
function calculateWeightPercent(targets: any[]): number[] {
  const sumEffective = targets.reduce((sum, t) => sum + t.effectiveWeight, 0)
  if (sumEffective === 0) {
    return targets.map(() => 0)
  }
  return targets.map((t) => (t.effectiveWeight / sumEffective) * 100)
}

/**
 * Build target detail object with health, stats, and computed fields
 */
function buildTargetDetail(
  target: any,
  stats: any,
  weightPercent: number,
  now: number
): any {
  const status = getHealthStatus(target)
  const retryInMs =
    status === 'suppressed' && target.suppressedUntil
      ? Math.max(0, target.suppressedUntil - now)
      : 0

  return {
    model: target.model,
    health: {
      status,
      effectiveWeight: target.effectiveWeight,
      defaultWeight: target.defaultWeight,
      weightPercent: Math.round(weightPercent * 10) / 10, // round to 1 decimal
      suppressedUntil: target.suppressedUntil || null,
      retryInMs,
      retryInHuman: retryInMs > 0 ? formatDuration(retryInMs) : null,
      consecutiveFailures: target.consecutiveFailures,
      lastFailureAt: target.lastFailureAt || null,
      lastFailureType: target.lastFailureType || null,
      lastRecoveryStartedAt: target.lastRecoveryStartedAt || null,
    },
    stats: stats
      ? {
          totalRequests: stats.totalRequests,
          successCount: stats.successCount,
          failureCount: stats.failureCount,
          lastSelectedAt: stats.lastSelectedAt || null,
        }
      : {
          totalRequests: 0,
          successCount: 0,
          failureCount: 0,
          lastSelectedAt: null,
        },
  }
}

/**
 * Register pool monitoring routes
 * All routes live under /api/pool
 */
export async function registerPoolRoutes(fastify: FastifyInstance): Promise<void> {
  const now = Date.now()

  /**
   * GET /api/pool/status
   * High-level health summary for all scenarios
   */
  fastify.get('/api/pool/status', async (_req: FastifyRequest, reply: FastifyReply) => {
    const poolSummary = pool.getPoolStatusSummary()

    const pools: Record<string, any> = {}
    for (const [scenario, summary] of Object.entries(poolSummary)) {
      pools[scenario] = {
        totalTargets: summary.totalTargets,
        healthy: summary.healthy,
        recovering: summary.recovering,
        suppressed: summary.failed,
      }
    }

    return {
      timestamp: Date.now(),
      pools,
    }
  })

  /**
   * GET /api/pool/targets
   * Full detail for every target across all scenarios
   */
  fastify.get('/api/pool/targets', async (_req: FastifyRequest, reply: FastifyReply) => {
    const scenarios: Record<string, any> = {}
    const allStats = stats.getAllStats()
    const now = Date.now()

    for (const scenario of pool.getPoolScenarios()) {
      const debugInfo = pool.getPoolDebugInfo(scenario)
      if (!debugInfo) continue

      const scenarioStats = allStats.get(scenario)
      const weightPercents = calculateWeightPercent(debugInfo.targets)

      scenarios[scenario] = {
        strategy: debugInfo.strategy,
        health: debugInfo.health,
        targets: debugInfo.targets.map((target: any, idx: number) => {
          const targetStats = scenarioStats?.get(target.model)
          return buildTargetDetail(target, targetStats, weightPercents[idx], now)
        }),
      }
    }

    return {
      timestamp: Date.now(),
      scenarios,
    }
  })

  /**
   * GET /api/pool/targets/:scenario
   * Full detail for a specific scenario
   */
  fastify.get(
    '/api/pool/targets/:scenario',
    async (req: FastifyRequest<{ Params: { scenario: string } }>, reply: FastifyReply) => {
      const { scenario } = req.params
      const debugInfo = pool.getPoolDebugInfo(scenario)

      if (!debugInfo) {
        return reply.code(404).send({
          error: 'Scenario not found',
          scenario,
        })
      }

      const allStats = stats.getAllStats()
      const scenarioStats = allStats.get(scenario)
      const now = Date.now()
      const weightPercents = calculateWeightPercent(debugInfo.targets)

      return {
        timestamp: Date.now(),
        scenario: {
          name: scenario,
          strategy: debugInfo.strategy,
          health: debugInfo.health,
          targets: debugInfo.targets.map((target: any, idx: number) => {
            const targetStats = scenarioStats?.get(target.model)
            return buildTargetDetail(target, targetStats, weightPercents[idx], now)
          }),
        },
      }
    }
  )

  /**
   * GET /api/pool/targets/:scenario/:model
   * Single target detail with history
   * Note: model should be URL-encoded
   */
  fastify.get(
    '/api/pool/targets/:scenario/:model',
    async (
      req: FastifyRequest<{ Params: { scenario: string; model: string } }>,
      reply: FastifyReply
    ) => {
      const { scenario } = req.params
      const model = decodeURIComponent(req.params.model)
      const debugInfo = pool.getPoolDebugInfo(scenario)

      if (!debugInfo) {
        return reply.code(404).send({
          error: 'Scenario not found',
          scenario,
        })
      }

      const target = debugInfo.targets.find((t: any) => t.model === model)
      if (!target) {
        return reply.code(404).send({
          error: 'Target not found',
          scenario,
          model,
        })
      }

      const allStats = stats.getAllStats()
      const scenarioStats = allStats.get(scenario)
      const targetStats = scenarioStats?.get(model)

      // Get weight percent for this target
      const sumEffective = debugInfo.targets.reduce(
        (sum: number, t: any) => sum + t.effectiveWeight,
        0
      )
      const weightPercent =
        sumEffective > 0 ? (target.effectiveWeight / sumEffective) * 100 : 0

      // Get history for this target
      const history = stats.getHealthHistory(scenario, model)

      return {
        timestamp: Date.now(),
        target: {
          ...buildTargetDetail(target, targetStats, weightPercent, Date.now()),
          history: history.slice(-100), // Last 100 events
        },
      }
    }
  )

  /**
   * POST /api/pool/targets/:scenario/:model/reset
   * Admin action: manually clear suppression and reset stats
   */
  fastify.post(
    '/api/pool/targets/:scenario/:model/reset',
    async (
      req: FastifyRequest<{ Params: { scenario: string; model: string } }>,
      reply: FastifyReply
    ) => {
      const { scenario } = req.params
      const model = decodeURIComponent(req.params.model)

      // Check if scenario exists
      const debugInfo = pool.getPoolDebugInfo(scenario)
      if (!debugInfo) {
        return reply.code(404).send({
          error: 'Scenario not found',
          scenario,
        })
      }

      // Check if target exists
      const target = debugInfo.targets.find((t: any) => t.model === model)
      if (!target) {
        return reply.code(404).send({
          error: 'Target not found',
          scenario,
          model,
        })
      }

      // Reset pool state for this target
      const poolState = pool.getPoolState(scenario)
      if (poolState) {
        const targetState = poolState.targets.get(model)
        if (targetState) {
          targetState.effectiveWeight = targetState.defaultWeight
          targetState.suppressedUntil = undefined
          targetState.lastFailureAt = undefined
          targetState.lastRecoveryStartedAt = undefined
          targetState.consecutiveFailures = 0
          targetState.currentWeight = 0
        }
      }

      // Reset stats for this target
      stats.resetStats(scenario, model)

      return {
        ok: true,
        message: `Target ${model} in scenario ${scenario} has been reset.`,
        timestamp: Date.now(),
      }
    }
  )

  /**
   * POST /api/pool/reset
   * Admin action: reset all stats (optionally scoped to scenario)
   */
  fastify.post(
    '/api/pool/reset',
    async (
      req: FastifyRequest<{ Body: { scenario?: string } }>,
      reply: FastifyReply
    ) => {
      const { scenario } = req.body || {}

      if (scenario) {
        // Reset specific scenario
        const cleared = stats.resetStats(scenario)
        return {
          ok: true,
          message: `Stats reset for scenario: ${scenario}`,
          cleared: cleared.cleared,
          timestamp: Date.now(),
        }
      }

      // Reset all
      const cleared = stats.resetStats()
      return {
        ok: true,
        message: 'All stats reset',
        cleared: cleared.cleared,
        timestamp: Date.now(),
      }
    }
  )

  /**
   * GET /api/pool/history
   * Time-series of health events (last 500 events)
   */
  fastify.get('/api/pool/history', async (_req: FastifyRequest, reply: FastifyReply) => {
    const history = stats.getHealthHistory()

    return {
      timestamp: Date.now(),
      totalEvents: history.length,
      events: history,
    }
  })
}

import { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { api, type PoolStatusResponse, type PoolTargetsResponse, type PoolTarget, type RequestHistoryResponse } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Activity, RefreshCw, Server, AlertTriangle, CheckCircle, Clock, TrendingUp, RotateCcw, BarChart3, Shield, History, ChevronDown, ChevronUp } from 'lucide-react';

interface PoolDashboardProps {
  showToast?: (message: string, type: 'success' | 'error' | 'warning') => void;
}

export function PoolDashboard({ showToast }: PoolDashboardProps) {
  const { t } = useTranslation();
  const [status, setStatus] = useState<PoolStatusResponse | null>(null);
  const [targets, setTargets] = useState<PoolTargetsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [selectedTarget, setSelectedTarget] = useState<{ scenario: string; model: string } | null>(null);
  const [isResetDialogOpen, setIsResetDialogOpen] = useState(false);
  const [isResetting, setIsResetting] = useState(false);
  const [requestHistory, setRequestHistory] = useState<RequestHistoryResponse | null>(null);
  const [showRequestHistory, setShowRequestHistory] = useState(true);

  const fetchData = useCallback(async () => {
    try {
      const [statusData, targetsData, historyData] = await Promise.all([
        api.getPoolStatus(),
        api.getPoolTargets(),
        api.getRequestHistory(),
      ]);
      setStatus(statusData);
      setTargets(targetsData);
      setRequestHistory(historyData);
    } catch (error) {
      console.error('Failed to fetch pool data:', error);
      showToast?.(t('pool_dashboard.fetch_error'), 'error');
    } finally {
      setLoading(false);
    }
  }, [showToast, t]);

  useEffect(() => {
    fetchData();

    if (autoRefresh) {
      const interval = setInterval(fetchData, 5000);
      return () => clearInterval(interval);
    }
  }, [fetchData, autoRefresh]);

  const handleResetTarget = async () => {
    if (!selectedTarget) return;

    setIsResetting(true);
    try {
      const response = await api.resetPoolTarget(selectedTarget.scenario, selectedTarget.model);
      if (response.ok) {
        showToast?.(t('pool_dashboard.reset_success'), 'success');
        fetchData();
      } else {
        showToast?.(response.message || t('pool_dashboard.reset_failed'), 'error');
      }
    } catch (error) {
      console.error('Failed to reset target:', error);
      showToast?.(t('pool_dashboard.reset_failed'), 'error');
    } finally {
      setIsResetting(false);
      setIsResetDialogOpen(false);
      setSelectedTarget(null);
    }
  };

  const handleResetStats = async () => {
    try {
      const response = await api.resetPoolStats();
      if (response.ok) {
        showToast?.(t('pool_dashboard.reset_stats_success'), 'success');
        fetchData();
      } else {
        showToast?.(response.message || t('pool_dashboard.reset_failed'), 'error');
      }
    } catch (error) {
      console.error('Failed to reset stats:', error);
      showToast?.(t('pool_dashboard.reset_failed'), 'error');
    }
  };

  const getStatusIcon = (status: string) => {
    switch (status) {
      case 'healthy':
        return <CheckCircle className="h-4 w-4 text-green-500" />;
      case 'suspended':
        return <AlertTriangle className="h-4 w-4 text-red-500" />;
      case 'ready':
        return <Clock className="h-4 w-4 text-yellow-500" />;
      default:
        return <Activity className="h-4 w-4 text-gray-500" />;
    }
  };

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'healthy':
        return 'bg-green-100 text-green-800 border-green-200';
      case 'suspended':
        return 'bg-red-100 text-red-800 border-red-200';
      case 'ready':
        return 'bg-yellow-100 text-yellow-800 border-yellow-200';
      default:
        return 'bg-gray-100 text-gray-800 border-gray-200';
    }
  };

  const formatTimeAgo = (timestamp: number | null) => {
    if (!timestamp) return '-';
    const seconds = Math.floor((Date.now() - timestamp) / 1000);
    if (seconds < 60) return `${seconds}s ago`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    return `${hours}h ago`;
  };

  // Format countdown timer (for cooldown/recovery)
  const formatCountdown = (ms: number): string => {
    if (ms <= 0) return '0s';
    const seconds = Math.ceil(ms / 1000);
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    if (mins > 0) {
      return `${mins}m ${secs}s`;
    }
    return `${secs}s`;
  };

  // Request history helpers
  const getOutcomeColor = (outcome: string) => {
    switch (outcome) {
      case 'success':
        return 'bg-green-100 text-green-800 border-green-200';
      case 'failure':
        return 'bg-red-100 text-red-800 border-red-200';
      case 'retry':
        return 'bg-yellow-100 text-yellow-800 border-yellow-200';
      default:
        return 'bg-gray-100 text-gray-800 border-gray-200';
    }
  };

  const getOutcomeIcon = (outcome: string) => {
    switch (outcome) {
      case 'success':
        return <CheckCircle className="h-3 w-3" />;
      case 'failure':
        return <AlertTriangle className="h-3 w-3" />;
      case 'retry':
        return <RotateCcw className="h-3 w-3" />;
      default:
        return null;
    }
  };

  const formatLatency = (ms: number) => {
    if (ms < 1000) return `${ms}ms`;
    return `${(ms / 1000).toFixed(1)}s`;
  };

  // Generate a consistent color based on correlation ID hash
  // Used to visually group related requests (failures and retries with same ID)
  const getCorrelationIdColor = (id: string): string => {
    // Array of distinct, readable colors
    const colors = [
      'text-blue-600',
      'text-purple-600',
      'text-teal-600',
      'text-orange-600',
      'text-pink-600',
      'text-indigo-600',
      'text-cyan-600',
      'text-amber-600',
      'text-rose-600',
      'text-emerald-600',
      'text-violet-600',
      'text-lime-600',
      'text-fuchsia-600',
      'text-sky-600',
      'text-red-600',
      'text-green-600',
    ];
    // Simple hash: sum char codes and mod by colors length
    const hash = id.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0);
    return colors[hash % colors.length];
  };

  const formatTime = (timestamp: number) => {
    return new Date(timestamp).toLocaleTimeString();
  };

  // Render timer cell - uses server-provided timer info
  const renderTimerCell = (target: PoolTarget) => {
    const { timerLabel, timerHuman, timerDirection, status, recoveryProgress } = target.health;

    // suspended: countdown to ready
    if (status === 'suspended') {
      return (
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="text-red-600 font-medium">
              {timerLabel}: {timerHuman}
            </span>
          </TooltipTrigger>
          <TooltipContent>
            <p>Countdown until target is ready for recovery</p>
          </TooltipContent>
        </Tooltip>
      );
    }

    // ready: countdown to next weight increase + progress
    if (status === 'ready') {
      return (
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="text-yellow-600">
              {recoveryProgress}% → {timerHuman}
            </span>
          </TooltipTrigger>
          <TooltipContent>
            <p>Recovery: {target.health.effectiveWeight}/{target.health.defaultWeight} weight</p>
            <p>Next increase in: {timerHuman}</p>
          </TooltipContent>
        </Tooltip>
      );
    }

    // healthy: time since at max weight
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="text-green-600">
            {timerLabel}: {timerHuman}
          </span>
        </TooltipTrigger>
        <TooltipContent>
          <p>Target has been at full weight for {timerHuman}</p>
        </TooltipContent>
      </Tooltip>
    );
  };

  const calculateSuccessRate = (target: PoolTarget) => {
    const total = target.stats.totalRequests;
    if (total === 0) return 0;
    return Math.round((target.stats.successCount / total) * 100);
  };

  const scenarios = targets ? Object.entries(targets.scenarios) : [];

  return (
    <TooltipProvider>
      <div className="h-full flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b bg-white">
          <div className="flex items-center gap-2">
            <BarChart3 className="h-5 w-5 text-blue-500" />
            <h2 className="text-lg font-semibold">{t('pool_dashboard.title')}</h2>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setAutoRefresh(!autoRefresh)}
              className={autoRefresh ? 'bg-blue-50' : ''}
            >
              <Activity className="h-4 w-4 mr-1" />
              {autoRefresh ? t('pool_dashboard.auto_refresh_on') : t('pool_dashboard.auto_refresh_off')}
            </Button>
            <Button variant="outline" size="sm" onClick={fetchData}>
              <RefreshCw className="h-4 w-4 mr-1" />
              {t('pool_dashboard.refresh')}
            </Button>
            <Button variant="outline" size="sm" onClick={handleResetStats}>
              <RotateCcw className="h-4 w-4 mr-1" />
              {t('pool_dashboard.reset_stats')}
            </Button>
          </div>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-auto p-4 space-y-4">
          {/* Status Overview Cards */}
          {status && (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
              {Object.entries(status.pools).map(([scenario, poolData]) => (
                <Card key={scenario} className="relative overflow-hidden">
                  <CardHeader className="pb-2">
                    <CardTitle className="text-sm font-medium text-gray-600 flex items-center gap-2">
                      <Server className="h-4 w-4" />
                      {scenario}
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    <div className="grid grid-cols-3 gap-2 text-center">
                      <div className="p-2 bg-green-50 rounded-lg">
                        <div className="text-2xl font-bold text-green-600">{poolData.healthy}</div>
                        <div className="text-xs text-green-700">{t('pool_dashboard.healthy')}</div>
                      </div>
                      <div className="p-2 bg-yellow-50 rounded-lg">
                        <div className="text-2xl font-bold text-yellow-600">{poolData.ready}</div>
                        <div className="text-xs text-yellow-700">{t('pool_dashboard.ready')}</div>
                      </div>
                      <div className="p-2 bg-red-50 rounded-lg">
                        <div className="text-2xl font-bold text-red-600">{poolData.suspended}</div>
                        <div className="text-xs text-red-700">{t('pool_dashboard.suspended')}</div>
                      </div>
                    </div>
                    <div className="mt-3 text-xs text-gray-500 text-center">
                      {t('pool_dashboard.total_targets')}: {poolData.totalTargets}
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}

          {/* Detailed Targets */}
          {scenarios.length > 0 ? (
            <Tabs defaultValue={scenarios[0]?.[0]} className="w-full">
              <TabsList className="mb-4">
                {scenarios.map(([scenario]) => (
                  <TabsTrigger key={scenario} value={scenario} className="capitalize">
                    {scenario}
                  </TabsTrigger>
                ))}
              </TabsList>

              {scenarios.map(([scenario, scenarioData]) => (
                <TabsContent key={scenario} value={scenario} className="space-y-4">
                  {/* Scenario Health Config */}
                  <Card className="bg-gray-50">
                    <CardContent className="py-3">
                      <div className="flex items-center gap-6 text-sm text-gray-600">
                        <span className="flex items-center gap-1">
                          <Shield className="h-4 w-4" />
                          {t('pool_dashboard.cooldown')}: {scenarioData.health.cooldown_ms / 1000}s
                        </span>
                        <span className="flex items-center gap-1">
                          <Clock className="h-4 w-4" />
                          {t('pool_dashboard.recovery_interval')}: {scenarioData.health.recovery_interval_ms / 1000}s
                        </span>
                        <span className="flex items-center gap-1">
                          <TrendingUp className="h-4 w-4" />
                          {t('pool_dashboard.recovery_step')}: {scenarioData.health.recovery_step}
                        </span>
                      </div>
                    </CardContent>
                  </Card>

                  {/* Targets Table */}
                  <Card>
                    <CardHeader>
                      <CardTitle className="text-base">{t('pool_dashboard.targets')}</CardTitle>
                    </CardHeader>
                    <CardContent>
                      <div className="overflow-x-auto">
                        <table className="w-full text-sm">
                          <thead>
                            <tr className="border-b text-left text-gray-600">
                              <th className="pb-2 font-medium">{t('pool_dashboard.model')}</th>
                              <th className="pb-2 font-medium">{t('pool_dashboard.status')}</th>
                              <th className="pb-2 font-medium text-right">{t('pool_dashboard.weight')}</th>
                              <th className="pb-2 font-medium text-right text-xs">Success/Fail (Total)</th>
                              <th className="pb-2 font-medium text-right text-xs">{t('pool_dashboard.latency')}</th>
                              <th className="pb-2 font-medium text-right text-xs">Last Code</th>
                              <th className="pb-2 font-medium text-right">{t('pool_dashboard.success_rate')}</th>
                              <th className="pb-2 font-medium">{t('pool_dashboard.last_selected')}</th>
                              <th className="pb-2 font-medium">{t('pool_dashboard.actions')}</th>
                            </tr>
                          </thead>
                          <tbody>
                            {scenarioData.targets.map((target) => (
                              <tr key={target.model} className="border-b last:border-0 hover:bg-gray-50">
                                <td className="py-3 font-mono text-xs max-w-[200px] truncate" title={target.model}>
                                  {target.model}
                                </td>
                                <td className="py-3">
                                  <Badge variant="outline" className={getStatusColor(target.health.status)}>
                                    <span className="flex items-center gap-1">
                                      {getStatusIcon(target.health.status)}
                                      {target.health.status}
                                    </span>
                                  </Badge>
                                </td>
                                <td className="py-3 text-right">
                                  <Tooltip>
                                    <TooltipTrigger asChild>
                                      <span className="cursor-help">
                                        {target.health.effectiveWeight}/{target.health.defaultWeight}
                                        <span className="text-gray-400 text-xs ml-1">
                                          ({target.health.weightPercent}%)
                                        </span>
                                      </span>
                                    </TooltipTrigger>
                                    <TooltipContent>
                                      <p>{t('pool_dashboard.effective_weight')}: {target.health.effectiveWeight}</p>
                                      <p>{t('pool_dashboard.default_weight')}: {target.health.defaultWeight}</p>
                                      <p>{t('pool_dashboard.weight_percent')}: {target.health.weightPercent}%</p>
                                    </TooltipContent>
                                  </Tooltip>
                                </td>
                                <td className="py-3 text-right">
                                  <Tooltip>
                                    <TooltipTrigger asChild>
                                      <span className="cursor-help text-xs">
                                        <span className="text-green-600 font-medium">{target.stats.successCount}</span>
                                        <span className="text-gray-400 mx-0.5">/</span>
                                        <span className="text-red-600 font-medium">{target.stats.failureCount}</span>
                                        <span className="text-gray-500 ml-1">({target.stats.totalRequests})</span>
                                      </span>
                                    </TooltipTrigger>
                                    <TooltipContent>
                                      <p>{t('pool_dashboard.successes')}: {target.stats.successCount}</p>
                                      <p>{t('pool_dashboard.failures')}: {target.stats.failureCount}</p>
                                      <p>{t('pool_dashboard.requests')}: {target.stats.totalRequests}</p>
                                    </TooltipContent>
                                  </Tooltip>
                                </td>
                                <td className="py-3 text-right">
                                  {target.stats.avgLatency !== null ? (
                                    <Tooltip>
                                      <TooltipTrigger asChild>
                                        <span className={target.stats.avgLatency < 1000 ? 'text-green-600' : target.stats.avgLatency < 3000 ? 'text-yellow-600' : 'text-red-600'}>
                                          {target.stats.avgLatency < 1000 ? `${target.stats.avgLatency}ms` : `${(target.stats.avgLatency / 1000).toFixed(1)}s`}
                                        </span>
                                      </TooltipTrigger>
                                      <TooltipContent>
                                        <p>{t('pool_dashboard.avg_latency_tooltip')}</p>
                                      </TooltipContent>
                                    </Tooltip>
                                  ) : (
                                    <span className="text-gray-400">-</span>
                                  )}
                                </td>
                                <td className="py-3 text-right">
                                  {target.health.lastFailureHttpStatus ? (
                                    <span className={target.health.lastFailureHttpStatus >= 500 ? 'text-red-600' : target.health.lastFailureHttpStatus === 429 ? 'text-yellow-600' : 'text-gray-600'}>
                                      {target.health.lastFailureHttpStatus}
                                    </span>
                                  ) : (
                                    <span className="text-gray-400">-</span>
                                  )}
                                </td>
                                <td className="py-3 text-right">
                                  <span className={calculateSuccessRate(target) >= 90 ? 'text-green-600' : calculateSuccessRate(target) >= 50 ? 'text-yellow-600' : 'text-red-600'}>
                                    {calculateSuccessRate(target)}%
                                  </span>
                                </td>
                                <td className="py-3 text-xs">
                                  {renderTimerCell(target)}
                                </td>
                                <td className="py-3">
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    onClick={() => {
                                      setSelectedTarget({ scenario, model: target.model });
                                      setIsResetDialogOpen(true);
                                    }}
                                  >
                                    <RotateCcw className="h-4 w-4" />
                                  </Button>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </CardContent>
                  </Card>

                  {/* Request History Section */}
                  {requestHistory && (
                    <Card className="mt-4">
                      <CardHeader
                        className="cursor-pointer select-none"
                        onClick={() => setShowRequestHistory(!showRequestHistory)}
                      >
                        <CardTitle className="text-base flex items-center justify-between">
                          <div className="flex items-center gap-2">
                            <History className="h-4 w-4" />
                            {t('pool_dashboard.request_history')}
                          </div>
                          <div className="flex items-center gap-2">
                            <span className="text-sm font-normal text-gray-500">
                              <span className="text-green-600">{requestHistory.stats.successCount}</span>
                              <span className="text-gray-400"> / </span>
                              <span className="text-red-600">{requestHistory.stats.failureCount}</span>
                              <span className="text-gray-400"> / </span>
                              <span className="text-yellow-600">{requestHistory.stats.retryCount}</span>
                            </span>
                            {showRequestHistory ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                          </div>
                        </CardTitle>
                      </CardHeader>
                      {showRequestHistory && (
                        <CardContent>
                          <div className="overflow-auto max-h-64">
                            {requestHistory.requests.filter(r => r.scenario === scenario).length === 0 ? (
                              <p className="text-gray-500 text-sm text-center py-4">{t('pool_dashboard.no_requests')}</p>
                            ) : (
                              <table className="w-full text-sm">
                                <thead className="border-b text-left text-gray-600">
                                  <tr>
                                    <th className="pb-2 font-medium">{t('pool_dashboard.time')}</th>
                                    <th className="pb-2 font-medium">{t('pool_dashboard.correlation_id')}</th>
                                    <th className="pb-2 font-medium">{t('pool_dashboard.model')}</th>
                                    <th className="pb-2 font-medium">{t('pool_dashboard.outcome')}</th>
                                    <th className="pb-2 font-medium">{t('pool_dashboard.latency')}</th>
                                    <th className="pb-2 font-medium">HTTP</th>
                                    <th className="pb-2 font-medium">{t('pool_dashboard.error')}</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {requestHistory.requests
                                    .filter(r => r.scenario === scenario)
                                    .slice(-20)
                                    .reverse()
                                    .map((req) => (
                                      <tr key={req.correlationId} className="border-b last:border-0 hover:bg-gray-50">
                                        <td className="py-2 text-xs text-gray-500">
                                          {formatTime(req.timestamp)}
                                        </td>
                                        <td className="py-2 font-mono text-xs">
                                          <Tooltip>
                                            <TooltipTrigger asChild>
                                              <span className={`cursor-help hover:underline ${getCorrelationIdColor(req.isRetry && req.originalCorrelationId ? req.originalCorrelationId : req.correlationId)}`}>
                                                {req.isRetry && req.originalCorrelationId
                                                  ? req.originalCorrelationId.substring(0, 8)
                                                  : req.correlationId.substring(0, 8)}...
                                              </span>
                                            </TooltipTrigger>
                                            <TooltipContent>
                                              <p className="font-mono text-xs">Original: {req.isRetry && req.originalCorrelationId ? req.originalCorrelationId : req.correlationId}</p>
                                              {req.isRetry && (
                                                <p className="text-xs mt-1 text-yellow-600">Retry ID: {req.correlationId.substring(0, 8)}...</p>
                                              )}
                                            </TooltipContent>
                                          </Tooltip>
                                        </td>
                                        <td className="py-2 font-mono text-xs truncate max-w-[150px]" title={req.targetModel}>
                                          {req.isRetry && (
                                            <Tooltip>
                                              <TooltipTrigger asChild>
                                                <span className="text-yellow-600 mr-1" title={`Retry from ${req.originalModel}`}>
                                                  ↻
                                                </span>
                                              </TooltipTrigger>
                                              <TooltipContent>
                                                <p>Retry from {req.originalModel}</p>
                                              </TooltipContent>
                                            </Tooltip>
                                          )}
                                          {req.targetModel}
                                        </td>
                                        <td className="py-2">
                                          <Badge variant="outline" className={getOutcomeColor(req.outcome)}>
                                            <span className="flex items-center gap-1">
                                              {getOutcomeIcon(req.outcome)}
                                              {req.outcome}
                                            </span>
                                          </Badge>
                                        </td>
                                        <td className="py-2 text-xs">
                                          <span className={req.latencyMs < 1000 ? 'text-green-600' : req.latencyMs < 3000 ? 'text-yellow-600' : 'text-red-600'}>
                                            {formatLatency(req.latencyMs)}
                                          </span>
                                        </td>
                                        <td className="py-2 text-xs">
                                          {req.httpStatus === 408 ? (
                                            <span className="text-orange-600 font-medium">Timeout</span>
                                          ) : req.httpStatus ? (
                                            <span className={req.httpStatus >= 500 ? 'text-red-600' : req.httpStatus === 429 ? 'text-yellow-600' : req.httpStatus >= 400 ? 'text-orange-600' : 'text-gray-600'}>
                                              {req.httpStatus}
                                            </span>
                                          ) : (
                                            <span className="text-gray-400">-</span>
                                          )}
                                        </td>
                                        <td className="py-2 text-xs text-gray-500 truncate max-w-[200px]" title={req.errorMessage || ''}>
                                          {req.errorMessage || '-'}
                                        </td>
                                      </tr>
                                    ))}
                                </tbody>
                              </table>
                            )}
                          </div>
                        </CardContent>
                      )}
                    </Card>
                  )}
                </TabsContent>
              ))}
            </Tabs>
          ) : (
            <Card className="p-8 text-center text-gray-500">
              <Activity className="h-12 w-12 mx-auto mb-4 text-gray-300" />
              <p>{t('pool_dashboard.no_pools')}</p>
              <p className="text-sm text-gray-400 mt-2">{t('pool_dashboard.no_pools_description')}</p>
            </Card>
          )}
        </div>

        {/* Reset Dialog */}
        <Dialog open={isResetDialogOpen} onOpenChange={setIsResetDialogOpen}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{t('pool_dashboard.reset_target_title')}</DialogTitle>
              <DialogDescription>
                {t('pool_dashboard.reset_target_description', { model: selectedTarget?.model })}
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="outline" onClick={() => setIsResetDialogOpen(false)}>
                {t('common.cancel')}
              </Button>
              <Button onClick={handleResetTarget} disabled={isResetting}>
                {isResetting ? t('pool_dashboard.resetting') : t('pool_dashboard.reset')}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </TooltipProvider>
  );
}

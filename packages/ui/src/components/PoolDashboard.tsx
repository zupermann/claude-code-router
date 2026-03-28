import { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { api, type PoolStatusResponse, type PoolTargetsResponse, type PoolTarget } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Activity, RefreshCw, Server, AlertTriangle, CheckCircle, Clock, TrendingUp, RotateCcw, BarChart3, Shield } from 'lucide-react';

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

  const fetchData = useCallback(async () => {
    try {
      const [statusData, targetsData] = await Promise.all([
        api.getPoolStatus(),
        api.getPoolTargets(),
      ]);
      setStatus(statusData);
      setTargets(targetsData);
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
      case 'suppressed':
        return <AlertTriangle className="h-4 w-4 text-red-500" />;
      case 'recovering':
        return <Clock className="h-4 w-4 text-yellow-500" />;
      default:
        return <Activity className="h-4 w-4 text-gray-500" />;
    }
  };

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'healthy':
        return 'bg-green-100 text-green-800 border-green-200';
      case 'suppressed':
        return 'bg-red-100 text-red-800 border-red-200';
      case 'recovering':
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

  const calculateSuccessRate = (target: PoolTarget) => {
    const total = target.stats.totalRequests;
    if (total === 0) return 0;
    return Math.round((target.stats.successCount / total) * 100);
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-gray-500">{t('pool_dashboard.loading')}</div>
      </div>
    );
  }

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
                        <div className="text-2xl font-bold text-yellow-600">{poolData.recovering}</div>
                        <div className="text-xs text-yellow-700">{t('pool_dashboard.recovering')}</div>
                      </div>
                      <div className="p-2 bg-red-50 rounded-lg">
                        <div className="text-2xl font-bold text-red-600">{poolData.suppressed}</div>
                        <div className="text-xs text-red-700">{t('pool_dashboard.suppressed')}</div>
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
                              <th className="pb-2 font-medium text-right">{t('pool_dashboard.requests')}</th>
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
                                      <span className="cursor-help">
                                        {target.stats.totalRequests}
                                      </span>
                                    </TooltipTrigger>
                                    <TooltipContent>
                                      <p>{t('pool_dashboard.successes')}: {target.stats.successCount}</p>
                                      <p>{t('pool_dashboard.failures')}: {target.stats.failureCount}</p>
                                    </TooltipContent>
                                  </Tooltip>
                                </td>
                                <td className="py-3 text-right">
                                  <span className={calculateSuccessRate(target) >= 90 ? 'text-green-600' : calculateSuccessRate(target) >= 50 ? 'text-yellow-600' : 'text-red-600'}>
                                    {calculateSuccessRate(target)}%
                                  </span>
                                </td>
                                <td className="py-3 text-gray-500 text-xs">
                                  {formatTimeAgo(target.stats.lastSelectedAt)}
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

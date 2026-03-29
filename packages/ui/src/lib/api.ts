import type { Config, Provider, Transformer } from '@/types';

// 日志聚合响应类型
interface GroupedLogsResponse {
  grouped: boolean;
  groups: { [reqId: string]: Array<{ timestamp: string; level: string; message: string; source?: string; reqId?: string }> };
  summary: {
    totalRequests: number;
    totalLogs: number;
    requests: Array<{
      reqId: string;
      logCount: number;
      firstLog: string;
      lastLog: string;
    }>;
  };
}

// API Client Class for handling requests with baseUrl and apikey authentication
class ApiClient {
  private baseUrl: string;
  private apiKey: string;
  private tempApiKey: string | null;

  constructor(baseUrl: string = '/api', apiKey: string = '') {
    this.baseUrl = baseUrl;
    // Load API key from localStorage if available
    this.apiKey = apiKey || localStorage.getItem('apiKey') || '';
    // Load temp API key from URL if available
    this.tempApiKey = new URLSearchParams(window.location.search).get('tempApiKey');
  }

  // Update base URL
  setBaseUrl(url: string) {
    this.baseUrl = url;
  }

  // Update API key
  setApiKey(apiKey: string) {
    this.apiKey = apiKey;
    // Save API key to localStorage
    if (apiKey) {
      localStorage.setItem('apiKey', apiKey);
    } else {
      localStorage.removeItem('apiKey');
    }
  }

  // Update temp API key
  setTempApiKey(tempApiKey: string | null) {
    this.tempApiKey = tempApiKey;
  }

  // Create headers with API key authentication
  private createHeaders(contentType: string = 'application/json'): HeadersInit {
    const headers: Record<string, string> = {
      'Accept': 'application/json',
    };

    // Use temp API key if available, otherwise use regular API key
    if (this.tempApiKey) {
      headers['X-Temp-API-Key'] = this.tempApiKey;
    } else if (this.apiKey) {
      headers['X-API-Key'] = this.apiKey;
    }

    if (contentType) {
      headers['Content-Type'] = contentType;
    }

    return headers;
  }

  // Generic fetch wrapper with base URL and authentication
  private async apiFetch<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
    const url = `${this.baseUrl}${endpoint}`;

    const config: RequestInit = {
      ...options,
      headers: {
        ...this.createHeaders(),
        ...options.headers,
      },
    };

    try {
      const response = await fetch(url, config);

      // Handle 401 Unauthorized responses
      if (response.status === 401) {
        // Remove API key when it's invalid
        localStorage.removeItem('apiKey');
        // Redirect to login page if not already there
        // For memory router, we need to use the router instance
        // We'll dispatch a custom event that the app can listen to
        window.dispatchEvent(new CustomEvent('unauthorized'));
        // Return a promise that never resolves to prevent further execution
        return new Promise(() => {}) as Promise<T>;
      }

      if (!response.ok) {
        // Try to get detailed error message from response body
        let errorMessage = `API request failed: ${response.status} ${response.statusText}`;
        try {
          const errorData = await response.json();
          if (errorData.error || errorData.message) {
            errorMessage = errorData.message || errorData.error || errorMessage;
          }
        } catch {
          // If parsing fails, use default error message
        }
        throw new Error(errorMessage);
      }

      if (response.status === 204) {
        return {} as T;
      }

      const text = await response.text();
      return text ? JSON.parse(text) : ({} as T);

    } catch (error) {
      console.error('API request error:', error);
      throw error;
    }
  }

  // GET request
  async get<T>(endpoint: string): Promise<T> {
    return this.apiFetch<T>(endpoint, {
      method: 'GET',
    });
  }

  // POST request
  async post<T>(endpoint: string, data: unknown): Promise<T> {
    return this.apiFetch<T>(endpoint, {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  // PUT request
  async put<T>(endpoint: string, data: unknown): Promise<T> {
    return this.apiFetch<T>(endpoint, {
      method: 'PUT',
      body: JSON.stringify(data),
    });
  }

  // DELETE request
  async delete<T>(endpoint: string, body?: any): Promise<T> {
    return this.apiFetch<T>(endpoint, {
      method: 'DELETE',
      body: JSON.stringify(body || {}),
    });
  }

  // API methods for configuration
  // Get current configuration
  async getConfig(): Promise<Config> {
    return this.get<Config>('/config');
  }

  // Update entire configuration
  async updateConfig(config: Config): Promise<Config> {
    return this.post<Config>('/config', config);
  }

  // Get providers
  async getProviders(): Promise<Provider[]> {
    return this.get<Provider[]>('/api/providers');
  }

  // Add a new provider
  async addProvider(provider: Provider): Promise<Provider> {
    return this.post<Provider>('/api/providers', provider);
  }

  // Update a provider
  async updateProvider(index: number, provider: Provider): Promise<Provider> {
    return this.post<Provider>(`/api/providers/${index}`, provider);
  }

  // Delete a provider
  async deleteProvider(index: number): Promise<void> {
    return this.delete<void>(`/api/providers/${index}`);
  }

  // Get transformers
  async getTransformers(): Promise<Transformer[]> {
    return this.get<Transformer[]>('/api/transformers');
  }

  // Add a new transformer
  async addTransformer(transformer: Transformer): Promise<Transformer> {
    return this.post<Transformer>('/api/transformers', transformer);
  }

  // Update a transformer
  async updateTransformer(index: number, transformer: Transformer): Promise<Transformer> {
    return this.post<Transformer>(`/api/transformers/${index}`, transformer);
  }

  // Delete a transformer
  async deleteTransformer(index: number): Promise<void> {
    return this.delete<void>(`/api/transformers/${index}`);
  }

  // Get configuration (new endpoint)
  async getConfigNew(): Promise<Config> {
    return this.get<Config>('/config');
  }

  // Save configuration (new endpoint)
  async saveConfig(config: Config): Promise<unknown> {
    return this.post<Config>('/config', config);
  }

  // Restart service
  async restartService(): Promise<unknown> {
    return this.post<void>('/restart', {});
  }

  // Check for updates
  async checkForUpdates(): Promise<{ hasUpdate: boolean; latestVersion?: string; changelog?: string }> {
    return this.get<{ hasUpdate: boolean; latestVersion?: string; changelog?: string }>('/update/check');
  }

  // Perform update
  async performUpdate(): Promise<{ success: boolean; message: string }> {
    return this.post<{ success: boolean; message: string }>('/api/update/perform', {});
  }

  // Get log files list
  async getLogFiles(): Promise<Array<{ name: string; path: string; size: number; lastModified: string }>> {
    return this.get<Array<{ name: string; path: string; size: number; lastModified: string }>>('/logs/files');
  }

  // Get logs from specific file
  async getLogs(filePath: string): Promise<string[]> {
    return this.get<string[]>(`/logs?file=${encodeURIComponent(filePath)}`);
  }

  // Clear logs from specific file
  async clearLogs(filePath: string): Promise<void> {
    return this.delete<void>(`/logs?file=${encodeURIComponent(filePath)}`);
  }

  // ========== Preset API methods ==========

  // Get presets list
  async getPresets(): Promise<{ presets: Array<any> }> {
    return this.get<{ presets: Array<any> }>('/presets');
  }

  // Get preset details
  async getPreset(name: string): Promise<any> {
    return this.get<any>(`/presets/${encodeURIComponent(name)}`);
  }

  // Install preset from URL
  async installPresetFromUrl(url: string, name?: string): Promise<any> {
    return this.post<any>('/presets/install', { url, name });
  }

  // Upload preset file
  async uploadPresetFile(file: File, name?: string): Promise<any> {
    const formData = new FormData();
    formData.append('file', file);
    if (name) {
      formData.append('name', name);
    }

    const url = `${this.baseUrl}/presets/upload`;

    const headers: Record<string, string> = {
      'Accept': 'application/json',
    };

    // Use temp API key if available, otherwise use regular API key
    if (this.tempApiKey) {
      headers['X-Temp-API-Key'] = this.tempApiKey;
    } else if (this.apiKey) {
      headers['X-API-Key'] = this.apiKey;
    }

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: formData,
    });

    if (response.status === 401) {
      localStorage.removeItem('apiKey');
      window.dispatchEvent(new CustomEvent('unauthorized'));
      return new Promise(() => {}) as any;
    }

    if (!response.ok) {
      throw new Error(`Failed to upload preset: ${response.status} ${response.statusText}`);
    }

    return response.json();
  }

  // Apply preset (configure sensitive fields)
  async applyPreset(name: string, secrets: Record<string, string>): Promise<any> {
    return this.post<any>(`/presets/${encodeURIComponent(name)}/apply`, { secrets });
  }

  // Delete preset
  async deletePreset(name: string): Promise<any> {
    return this.delete<any>(`/presets/${encodeURIComponent(name)}`, {});
  }

  // Get market presets
  async getMarketPresets(): Promise<{ presets: Array<any> }> {
    return this.get<{ presets: Array<any> }>('/presets/market');
  }

  // Install preset from GitHub repository
  async installPresetFromGitHub(repo: string, name?: string): Promise<any> {
    return this.post<any>('/presets/install/github', { repo, name });
  }

  // Pool monitoring API methods
  async getPoolStatus(): Promise<PoolStatusResponse> {
    return this.get<PoolStatusResponse>('/pool/status');
  }

  async getPoolTargets(): Promise<PoolTargetsResponse> {
    return this.get<PoolTargetsResponse>('/pool/targets');
  }

  async getPoolTargetsByScenario(scenario: string): Promise<PoolScenarioResponse> {
    return this.get<PoolScenarioResponse>(`/pool/targets/${encodeURIComponent(scenario)}`);
  }

  async getPoolTargetDetail(scenario: string, model: string): Promise<PoolTargetDetailResponse> {
    return this.get<PoolTargetDetailResponse>(`/pool/targets/${encodeURIComponent(scenario)}/${encodeURIComponent(model)}`);
  }

  async resetPoolTarget(scenario: string, model: string): Promise<{ ok: boolean; message: string; timestamp: number }> {
    return this.post<{ ok: boolean; message: string; timestamp: number }>(`/pool/targets/${encodeURIComponent(scenario)}/${encodeURIComponent(model)}/reset`, {});
  }

  async resetPoolStats(scenario?: string): Promise<{ ok: boolean; message: string; timestamp: number; cleared?: number }> {
    return this.post<{ ok: boolean; message: string; timestamp: number; cleared?: number }>('/pool/reset', { scenario });
  }

  async getPoolHistory(): Promise<PoolHistoryResponse> {
    return this.get<PoolHistoryResponse>('/pool/history');
  }

  async getRequestHistory(): Promise<RequestHistoryResponse> {
    return this.get<RequestHistoryResponse>('/pool/requests');
  }

  async getRequestHistoryByScenario(scenario: string): Promise<{ timestamp: number; scenario: string; requests: RequestHistoryEntry[] }> {
    return this.get<{ timestamp: number; scenario: string; requests: RequestHistoryEntry[] }>(`/pool/requests/${encodeURIComponent(scenario)}`);
  }
}

// Pool monitoring types
export interface PoolStatusResponse {
  timestamp: number;
  pools: {
    [scenario: string]: {
      totalTargets: number;
      healthy: number;
      ready: number;
      suspended: number;
    };
  };
}

export interface PoolTargetHealth {
  status: 'healthy' | 'suspended' | 'ready';
  effectiveWeight: number;
  defaultWeight: number;
  weightPercent: number;
  suppressedUntil: number | null;
  consecutiveFailures: number;
  lastFailureAt: number | null;
  lastFailureType: string | null;
  lastFailureHttpStatus: number | null;
  lastRecoveryStartedAt: number | null;
  lastSuccessAt: number | null;
  // Timer info
  timerMs: number;
  timerLabel: string;
  timerDirection: 'down' | 'up';
  timerHuman: string | null;
  // Recovery progress (only for recovering state)
  recoveryProgress: number | null;
}

export interface PoolTargetStats {
  totalRequests: number;
  successCount: number;
  failureCount: number;
  lastSelectedAt: number | null;
  avgLatency: number | null;
}

export interface PoolTarget {
  model: string;
  health: PoolTargetHealth;
  stats: PoolTargetStats;
}

export interface PoolScenario {
  strategy: string;
  health: {
    cooldown_ms: number;
    recovery_interval_ms: number;
    recovery_step: number;
  };
  targets: PoolTarget[];
}

export interface PoolTargetsResponse {
  timestamp: number;
  scenarios: {
    [scenario: string]: PoolScenario;
  };
}

export interface PoolScenarioResponse {
  timestamp: number;
  scenario: {
    name: string;
    strategy: string;
    health: PoolScenario['health'];
    targets: PoolTarget[];
  };
}

export interface PoolTargetDetailResponse {
  timestamp: number;
  target: PoolTarget & {
    history: PoolHealthEvent[];
  };
}

export interface PoolHealthEvent {
  timestamp: number;
  scenario: string;
  model: string;
  event: 'suppressed' | 'recovery_started' | 'recovered' | 'fail_open' | 'selected';
  details: {
    httpStatus?: number;
    effectiveWeight?: number;
    suppressedUntil?: number;
  };
}

export interface PoolHistoryResponse {
  timestamp: number;
  totalEvents: number;
  events: PoolHealthEvent[];
}

export interface RequestHistoryEntry {
  correlationId: string;
  timestamp: number;
  scenario: string;
  targetModel: string;
  outcome: 'success' | 'failure' | 'retry';
  latencyMs: number;
  httpStatus: number | null;
  errorMessage: string | null;
  isRetry: boolean;
  originalModel: string | null;
  originalCorrelationId: string | null;
}

export interface RequestHistoryResponse {
  timestamp: number;
  stats: {
    totalRequests: number;
    successCount: number;
    failureCount: number;
    retryCount: number;
    avgLatency: number | null;
  };
  requests: RequestHistoryEntry[];
}

// Create a default instance of the API client
export const api = new ApiClient();

// Export the class for creating custom instances
export default ApiClient;

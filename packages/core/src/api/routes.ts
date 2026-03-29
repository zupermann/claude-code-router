import {
  FastifyInstance,
  FastifyPluginAsync,
  FastifyRequest,
  FastifyReply,
} from "fastify";
import { RegisterProviderRequest, LLMProvider } from "@/types/llm";
import { sendUnifiedRequest, wrapStreamWithActivityTracking } from "@/utils/request";
import { createApiError } from "./middleware";
import { version } from "../../package.json";
import { ConfigService } from "@/services/config";
import { ProviderService } from "@/services/provider";
import { TransformerService } from "@/services/transformer";
import { Transformer } from "@/types/transformer";
import { registerPoolRoutes } from "./poolRoutes";
import { stats, recordFailure, recordSuccess as recordPoolSuccess, getHealthyPoolTargets, selectHealthyPoolTarget, requestHistory, activeConnections } from "@/pool";
import { applySuccess as applyPoolSuccess } from "@/pool/health";

// Extend FastifyInstance to include custom services
declare module "fastify" {
  interface FastifyInstance {
    configService: ConfigService;
    providerService: ProviderService;
    transformerService: TransformerService;
  }

  interface FastifyRequest {
    provider?: string;
  }
}

/**
 * Main handler for transformer endpoints
 * Coordinates the entire request processing flow: validate provider, handle request transformers,
 * send request, handle response transformers, format response
 */
async function handleTransformerEndpoint(
  req: FastifyRequest,
  reply: FastifyReply,
  fastify: FastifyInstance,
  transformer: any
) {
  const body = req.body as any;
  const providerName = req.provider!;
  const provider = fastify.providerService.getProvider(providerName);
  const requestStartTime = Date.now(); // Track request start time for latency calculation

  // Get scenario and model for request history tracking
  const scenarioType = (req as any).selectedPoolScenario || (req as any).scenarioType || 'default';
  const modelId = (req as any).selectedPoolTarget || (req as any).body?.model;

  // Detect streaming request
  const isStreaming = body.stream === true;

  // For streaming requests, start activity tracking
  // This tracks "time since last SSE" and aborts if no activity for SSE_ACTIVITY_TIMEOUT_MS
  let activityContext: {
    correlationId: string;
    signal: AbortSignal;
    updateActivity: () => void;
  } | null = null;

  if (isStreaming && modelId) {
    const timeoutMs = fastify.configService.get('SSE_ACTIVITY_TIMEOUT_MS') ?? 180_000;
    activityContext = activeConnections.startConnection(scenarioType, modelId, timeoutMs);
  }

  // Track request start for history (for non-streaming or as additional tracking)
  const correlationId = modelId ? requestHistory.recordRequestStart(scenarioType, modelId) : '';
  // Store correlation ID on request for retry handlers
  (req as any).correlationId = correlationId;
  // Store activity context for streaming
  (req as any).activityContext = activityContext;

  // Validate provider exists
  if (!provider) {
    throw createApiError(
      `Provider '${providerName}' not found`,
      404,
      "provider_not_found"
    );
  }

  try {
    // Process request transformer chain
    const { requestBody, config, bypass } = await processRequestTransformers(
      body,
      provider,
      transformer,
      req.headers,
      {
        req,
      }
    );

    // Send request to LLM provider
    const response = await sendRequestToProvider(
      requestBody,
      config,
      provider,
      fastify,
      bypass,
      transformer,
      {
        req,
        isStreaming,
        activitySignal: activityContext?.signal,
      }
    );

    // Process response transformer chain
    const finalResponse = await processResponseTransformers(
      requestBody,
      response,
      provider,
      transformer,
      bypass,
      {
        req,
      }
    );

    // Calculate latency for this successful request
    const latencyMs = Date.now() - requestStartTime;

    // Record successful request for pool stats
    // Use selectedPoolTarget if available (from pool selection), otherwise fall back to request model
    if (scenarioType && modelId) {
      stats.recordSuccess(scenarioType, modelId, latencyMs);
      // Restore target to healthy state (effectiveWeight = defaultWeight)
      recordPoolSuccess(scenarioType, modelId);
    }

    // Record request history success
    if (correlationId) {
      requestHistory.recordRequestEnd(correlationId, 'success', 200);
    }

    // Format and return response
    // For streaming, pass activity context to wrap the stream
    return formatResponse(finalResponse, reply, body, activityContext);
  } catch (error: any) {
    // Clean up activity tracking on error
    if (activityContext) {
      activeConnections.endConnection(activityContext.correlationId);
    }

    // Classify error type for proper status code assignment
    const isTimeout = error.name === 'TimeoutError' ||
                      error.cause?.name === 'TimeoutError' ||
                      (error.message && /timeout/i.test(error.message));

    // Assign HTTP status: 408 for timeouts, otherwise use error's status or null
    const httpStatus = isTimeout ? 408 : error.statusCode;

    // Record failure for pool stats (all error types)
    if (scenarioType && modelId) {
      recordFailure(scenarioType, modelId, httpStatus ?? undefined, error.message);
    }

    // Record request history failure
    if (correlationId) {
      requestHistory.recordRequestEnd(correlationId, 'failure', httpStatus, error.message);
    }

    // Try other healthy pool targets first
    if (modelId) {
      const poolRetryResult = await handlePoolRetry(req, reply, fastify, transformer, modelId, correlationId);
      if (poolRetryResult) {
        return poolRetryResult;
      }
    }

    // Fall back to static fallback models
    const fallbackResult = await handleFallback(req, reply, fastify, transformer, error);
    if (fallbackResult) {
      return fallbackResult;
    }

    throw error;
  }
}

/**
 * Handle fallback logic when request fails
 * Tries each fallback model in sequence until one succeeds
 */
async function handleFallback(
  req: FastifyRequest,
  reply: FastifyReply,
  fastify: FastifyInstance,
  transformer: any,
  error: any
): Promise<any> {
  const scenarioType = (req as any).scenarioType || 'default';
  const fallbackConfig = fastify.configService.get<any>('fallback');

  if (!fallbackConfig || !fallbackConfig[scenarioType]) {
    return null;
  }

  const fallbackList = fallbackConfig[scenarioType] as string[];
  if (!Array.isArray(fallbackList) || fallbackList.length === 0) {
    return null;
  }

  req.log.warn(`Request failed for ${(req as any).scenarioType}, trying ${fallbackList.length} fallback models`);

  // Try each fallback model in sequence
  for (const fallbackModel of fallbackList) {
    const fallbackStartTime = Date.now(); // Track latency for this fallback attempt
    try {
      req.log.info(`Trying fallback model: ${fallbackModel}`);

      // Update request with fallback model
      const newBody = { ...(req.body as any) };
      const [fallbackProvider, ...fallbackModelName] = fallbackModel.split(',');
      newBody.model = fallbackModelName.join(',');

      // Create new request object with updated provider and body
      const newReq = {
        ...req,
        provider: fallbackProvider,
        body: newBody,
      };

      const provider = fastify.providerService.getProvider(fallbackProvider);
      if (!provider) {
        req.log.warn(`Fallback provider '${fallbackProvider}' not found, skipping`);
        continue;
      }

      // Process request transformer chain
      const { requestBody, config, bypass } = await processRequestTransformers(
        newBody,
        provider,
        transformer,
        req.headers,
        { req: newReq }
      );

      // Send request to LLM provider
      const response = await sendRequestToProvider(
        requestBody,
        config,
        provider,
        fastify,
        bypass,
        transformer,
        { req: newReq }
      );

      // Process response transformer chain
      const finalResponse = await processResponseTransformers(
        requestBody,
        response,
        provider,
        transformer,
        bypass,
        { req: newReq }
      );

      req.log.info(`Fallback model ${fallbackModel} succeeded`);

      // Record successful fallback request with latency
      const fallbackLatencyMs = Date.now() - fallbackStartTime;
      const fallbackScenario = (req as any).scenarioType || 'default';
      if (fallbackScenario && fallbackModel) {
        stats.recordSuccess(fallbackScenario, fallbackModel, fallbackLatencyMs);
        recordPoolSuccess(fallbackScenario, fallbackModel);
      }

      // Format and return response
      return formatResponse(finalResponse, reply, newBody);
    } catch (fallbackError: any) {
      req.log.warn(`Fallback model ${fallbackModel} failed: ${fallbackError.message}`);
      continue;
    }
  }

  req.log.error(`All fallback models failed for yichu ${scenarioType}`);
  return null;
}

/**
 * Try other healthy pool targets after a failure
 * Returns response if successful, null if no healthy targets or all failed
 */
async function handlePoolRetry(
  req: FastifyRequest,
  reply: FastifyReply,
  fastify: FastifyInstance,
  transformer: any,
  failedModel: string,
  originalCorrelationId: string
): Promise<any> {
  const scenario = (req as any).selectedPoolScenario || (req as any).scenarioType || 'default';

  // Get count of healthy targets for logging
  const healthyTargetsCount = getHealthyPoolTargets(scenario, failedModel).length;
  if (healthyTargetsCount === 0) {
    return null;
  }

  req.log.info(`Trying ${healthyTargetsCount} healthy pool targets after failure using weighted random selection`);

  // Keep trying with weighted random selection until we succeed or run out of healthy targets
  let attempts = 0;
  const maxAttempts = healthyTargetsCount; // Don't try more times than we have targets

  while (attempts < maxAttempts) {
    // Select a target using weighted random selection (same algorithm as initial selection)
    const targetModel = selectHealthyPoolTarget(scenario, failedModel);

    if (!targetModel) {
      // No healthy targets left (all weights went to 0)
      req.log.info(`No more healthy targets available after ${attempts} attempts`);
      return null;
    }

    attempts++;

    // Track retry attempt in request history
    const retryCorrelationId = requestHistory.recordRetryStart(
      scenario,
      targetModel,
      originalCorrelationId,
      failedModel
    );

    const retryStartTime = Date.now();
    try {
      req.log.info(`Retrying with pool target: ${targetModel} (attempt ${attempts}/${maxAttempts})`);

      // Get provider for this target (format: "provider,model" or just model)
      const [providerName, ...modelParts] = targetModel.split(',');
      const actualModel = modelParts.join(',') || providerName;
      const targetProvider = fastify.providerService.getProvider(providerName);
      if (!targetProvider) {
        req.log.warn(`Provider '${providerName}' not found for target ${targetModel}, skipping`);
        // Treat as failure, set weight to 0 and continue
        recordFailure(scenario, targetModel, 404, `Provider not found: ${providerName}`);
        continue;
      }

      // Update request with new target
      (req as any).selectedPoolTarget = targetModel;
      const newBody = { ...(req.body as any), model: actualModel };

      // Process request transformer chain
      const { requestBody, config, bypass } = await processRequestTransformers(
        newBody,
        targetProvider,
        transformer,
        req.headers,
        { req }
      );

      // Send request to LLM provider
      const response = await sendRequestToProvider(
        requestBody,
        config,
        targetProvider,
        fastify,
        bypass,
        transformer,
        { req }
      );

      // Process response transformer chain
      const finalResponse = await processResponseTransformers(
        requestBody,
        response,
        targetProvider,
        transformer,
        bypass,
        { req }
      );

      req.log.info(`Pool retry to ${targetModel} succeeded after ${attempts} attempt(s)`);

      // Record successful retry with latency
      const retryLatencyMs = Date.now() - retryStartTime;
      stats.recordSuccess(scenario, targetModel, retryLatencyMs);
      recordPoolSuccess(scenario, targetModel);

      // Record request history retry success
      requestHistory.recordRequestEnd(retryCorrelationId, 'retry', 200);

      return formatResponse(finalResponse, reply, newBody);
    } catch (retryError: any) {
      // Classify error type for proper status code
      const isTimeout = retryError.name === 'TimeoutError' ||
                        retryError.cause?.name === 'TimeoutError' ||
                        (retryError.message && /timeout/i.test(retryError.message));
      const httpStatus = isTimeout ? 408 : retryError.statusCode;

      // Record failure - this sets weight to 0, so next selection won't pick this target
      recordFailure(scenario, targetModel, httpStatus ?? undefined, retryError.message);
      req.log.warn(`Pool retry to ${targetModel} failed: ${retryError.message}`);

      // Record request history retry failure
      requestHistory.recordRequestEnd(retryCorrelationId, 'failure', httpStatus, retryError.message);

      // Continue to next attempt - the failed target's weight is now 0,
      // so the next weighted random selection will pick a different target
      continue;
    }
  }

  req.log.warn(`All ${healthyTargets.length} pool retry targets failed`);
  return null;
}

/**
 * Process request transformer chain
 * Sequentially execute transformRequestOut, provider transformers, model-specific transformers
 * Returns processed request body, config, and flag indicating whether to skip transformers
 */
async function processRequestTransformers(
  body: any,
  provider: any,
  transformer: any,
  headers: any,
  context: any
) {
  let requestBody = body;
  let config: any = {};
  let bypass = false;

  // Check if transformers should be bypassed (passthrough mode)
  bypass = shouldBypassTransformers(provider, transformer, body);

  if (bypass) {
    if (headers instanceof Headers) {
      headers.delete("content-length");
    } else {
      delete headers["content-length"];
    }
    config.headers = headers;
  }

  // Execute transformer's transformRequestOut method
  if (!bypass && typeof transformer.transformRequestOut === "function") {
    const transformOut = await transformer.transformRequestOut(requestBody);
    if (transformOut.body) {
      requestBody = transformOut.body;
      config = transformOut.config || {};
    } else {
      requestBody = transformOut;
    }
  }

  // Execute provider-level transformers
  if (!bypass && provider.transformer?.use?.length) {
    for (const providerTransformer of provider.transformer.use) {
      if (
        !providerTransformer ||
        typeof providerTransformer.transformRequestIn !== "function"
      ) {
        continue;
      }
      const transformIn = await providerTransformer.transformRequestIn(
        requestBody,
        provider,
        context
      );
      if (transformIn.body) {
        requestBody = transformIn.body;
        config = { ...config, ...transformIn.config };
      } else {
        requestBody = transformIn;
      }
    }
  }

  // Execute model-specific transformers
  if (!bypass && provider.transformer?.[body.model]?.use?.length) {
    for (const modelTransformer of provider.transformer[body.model].use) {
      if (
        !modelTransformer ||
        typeof modelTransformer.transformRequestIn !== "function"
      ) {
        continue;
      }
      requestBody = await modelTransformer.transformRequestIn(
        requestBody,
        provider,
        context
      );
    }
  }

  return { requestBody, config, bypass };
}

/**
 * Determine if transformers should be bypassed (passthrough mode)
 * Skip other transformers when provider only uses one transformer and it matches the current one
 */
function shouldBypassTransformers(
  provider: any,
  transformer: any,
  body: any
): boolean {
  return (
    provider.transformer?.use?.length === 1 &&
    provider.transformer.use[0].name === transformer.name &&
    (!provider.transformer?.[body.model]?.use.length ||
      (provider.transformer?.[body.model]?.use.length === 1 &&
        provider.transformer?.[body.model]?.use[0].name === transformer.name))
  );
}

/**
 * Send request to LLM provider
 * Handle authentication, build request config, send request and handle errors
 */
async function sendRequestToProvider(
  requestBody: any,
  config: any,
  provider: any,
  fastify: FastifyInstance,
  bypass: boolean,
  transformer: any,
  context: any
) {
  const url = config.url || new URL(provider.baseUrl);

  // Handle authentication in passthrough mode
  if (bypass && typeof transformer.auth === "function") {
    const auth = await transformer.auth(requestBody, provider);
    if (auth.body) {
      requestBody = auth.body;
      let headers = config.headers || {};
      if (auth.config?.headers) {
        headers = {
          ...headers,
          ...auth.config.headers,
        };
        delete headers.host;
        delete auth.config.headers;
      }
      config = {
        ...config,
        ...auth.config,
        headers,
      };
    } else {
      requestBody = auth;
    }
  }

  // Send HTTP request
  // Prepare headers
  const requestHeaders: Record<string, string> = {
    Authorization: `Bearer ${provider.apiKey}`,
    ...(config?.headers || {}),
  };

  for (const key in requestHeaders) {
    if (requestHeaders[key] === "undefined") {
      delete requestHeaders[key];
    } else if (
      ["authorization", "Authorization"].includes(key) &&
      requestHeaders[key]?.includes("undefined")
    ) {
      delete requestHeaders[key];
    }
  }

  // Build request config
  const requestConfig: any = {
    httpsProxy: fastify.configService.getHttpsProxy(),
    CONNECTION_TIMEOUT_MS: fastify.configService.get('CONNECTION_TIMEOUT_MS') ?? fastify.configService.get('API_TIMEOUT_MS') ?? 60000,
    REQUEST_TIMEOUT_MS: fastify.configService.get('REQUEST_TIMEOUT_MS') ?? fastify.configService.get('API_TIMEOUT_MS') ?? 600000,
    ...config,
    headers: JSON.parse(JSON.stringify(requestHeaders)),
  };

  // For streaming requests, pass the activity signal for timeout management
  if (context.isStreaming && context.activitySignal) {
    requestConfig.isStreaming = true;
    requestConfig.signal = context.activitySignal;
  }

  const response = await sendUnifiedRequest(
    url,
    requestBody,
    requestConfig,
    context,
    fastify.log
  );

  // Handle request errors
  if (!response.ok) {
    const errorText = await response.text();
    fastify.log.error(
      `[provider_response_error] Error from provider(${provider.name},${requestBody.model}: ${response.status}): ${errorText}`,
    );
    throw createApiError(
      `Error from provider(${provider.name},${requestBody.model}: ${response.status}): ${errorText}`,
      response.status,
      "provider_response_error"
    );
  }

  return response;
}

/**
 * Process response transformer chain
 * Sequentially execute provider transformers, model-specific transformers, transformer's transformResponseIn
 */
async function processResponseTransformers(
  requestBody: any,
  response: any,
  provider: any,
  transformer: any,
  bypass: boolean,
  context: any
) {
  let finalResponse = response;

  // Execute provider-level response transformers
  if (!bypass && provider.transformer?.use?.length) {
    for (const providerTransformer of Array.from(
      provider.transformer.use
    ).reverse() as Transformer[]) {
      if (
        !providerTransformer ||
        typeof providerTransformer.transformResponseOut !== "function"
      ) {
        continue;
      }
      finalResponse = await providerTransformer.transformResponseOut!(
        finalResponse,
        context
      );
    }
  }

  // Execute model-specific response transformers
  if (!bypass && provider.transformer?.[requestBody.model]?.use?.length) {
    for (const modelTransformer of Array.from(
      provider.transformer[requestBody.model].use
    ).reverse() as Transformer[]) {
      if (
        !modelTransformer ||
        typeof modelTransformer.transformResponseOut !== "function"
      ) {
        continue;
      }
      finalResponse = await modelTransformer.transformResponseOut!(
        finalResponse,
        context
      );
    }
  }

  // Execute transformer's transformResponseIn method
  if (!bypass && transformer.transformResponseIn) {
    finalResponse = await transformer.transformResponseIn(
      finalResponse,
      context
    );
  }

  return finalResponse;
}

/**
 * Format and return response
 * Handle HTTP status codes, format streaming and regular responses
 * For streaming responses, wrap with activity tracking to monitor SSE events
 */
function formatResponse(
  response: any,
  reply: FastifyReply,
  body: any,
  activityContext?: { correlationId: string; signal: AbortSignal; updateActivity: () => void } | null
) {
  // Set HTTP status code
  if (!response.ok) {
    reply.code(response.status);
  }

  // Handle streaming response
  const isStream = body.stream === true;
  if (isStream) {
    reply.header("Content-Type", "text/event-stream");
    reply.header("Cache-Control", "no-cache");
    reply.header("Connection", "keep-alive");

    // Wrap response body with activity tracking if available
    if (activityContext && response.body) {
      const wrappedStream = wrapStreamWithActivityTracking(
        response.body,
        activityContext.updateActivity,
        () => activeConnections.endConnection(activityContext.correlationId)
      );
      return reply.send(wrappedStream);
    }

    return reply.send(response.body);
  } else {
    // Handle regular JSON response
    return response.json();
  }
}

export const registerApiRoutes = async (
  fastify: FastifyInstance
) => {
  // Health and info endpoints
  fastify.get("/", async () => {
    return { message: "LLMs API", version };
  });

  fastify.get("/health", async () => {
    return { status: "ok", timestamp: new Date().toISOString() };
  });

  const transformersWithEndpoint =
    fastify.transformerService.getTransformersWithEndpoint();

  for (const { transformer } of transformersWithEndpoint) {
    if (transformer.endPoint) {
      fastify.post(
        transformer.endPoint,
        async (req: FastifyRequest, reply: FastifyReply) => {
          return handleTransformerEndpoint(req, reply, fastify, transformer);
        }
      );
    }
  }

  fastify.post(
    "/providers",
    {
      schema: {
        body: {
          type: "object",
          properties: {
            id: { type: "string" },
            name: { type: "string" },
            type: { type: "string", enum: ["openai", "anthropic"] },
            baseUrl: { type: "string" },
            apiKey: { type: "string" },
            models: { type: "array", items: { type: "string" } },
          },
          required: ["id", "name", "type", "baseUrl", "apiKey", "models"],
        },
      },
    },
    async (
      request: FastifyRequest<{ Body: RegisterProviderRequest }>,
      reply: FastifyReply
    ) => {
      // Validation
      const { name, baseUrl, apiKey, models } = request.body;

      if (!name?.trim()) {
        throw createApiError(
          "Provider name is required",
          400,
          "invalid_request"
        );
      }

      if (!baseUrl || !isValidUrl(baseUrl)) {
        throw createApiError(
          "Valid base URL is required",
          400,
          "invalid_request"
        );
      }

      if (!apiKey?.trim()) {
        throw createApiError("API key is required", 400, "invalid_request");
      }

      if (!models || !Array.isArray(models) || models.length === 0) {
        throw createApiError(
          "At least one model is required",
          400,
          "invalid_request"
        );
      }

      // Check if provider already exists
      if (fastify.providerService.getProvider(request.body.name)) {
        throw createApiError(
          `Provider with name '${request.body.name}' already exists`,
          400,
          "provider_exists"
        );
      }

      return fastify.providerService.registerProvider(request.body);
    }
  );

  fastify.get("/providers", async () => {
    return fastify.providerService.getProviders();
  });

  fastify.get(
    "/providers/:id",
    {
      schema: {
        params: {
          type: "object",
          properties: { id: { type: "string" } },
          required: ["id"],
        },
      },
    },
    async (request: FastifyRequest<{ Params: { id: string } }>) => {
      const provider = fastify.providerService.getProvider(
        request.params.id
      );
      if (!provider) {
        throw createApiError("Provider not found", 404, "provider_not_found");
      }
      return provider;
    }
  );

  fastify.put(
    "/providers/:id",
    {
      schema: {
        params: {
          type: "object",
          properties: { id: { type: "string" } },
          required: ["id"],
        },
        body: {
          type: "object",
          properties: {
            name: { type: "string" },
            type: { type: "string", enum: ["openai", "anthropic"] },
            baseUrl: { type: "string" },
            apiKey: { type: "string" },
            models: { type: "array", items: { type: "string" } },
            enabled: { type: "boolean" },
          },
        },
      },
    },
    async (
      request: FastifyRequest<{
        Params: { id: string };
        Body: Partial<LLMProvider>;
      }>,
      reply
    ) => {
      const provider = fastify.providerService.updateProvider(
        request.params.id,
        request.body
      );
      if (!provider) {
        throw createApiError("Provider not found", 404, "provider_not_found");
      }
      return provider;
    }
  );

  fastify.delete(
    "/providers/:id",
    {
      schema: {
        params: {
          type: "object",
          properties: { id: { type: "string" } },
          required: ["id"],
        },
      },
    },
    async (request: FastifyRequest<{ Params: { id: string } }>) => {
      const success = fastify.providerService.deleteProvider(
        request.params.id
      );
      if (!success) {
        throw createApiError("Provider not found", 404, "provider_not_found");
      }
      return { message: "Provider deleted successfully" };
    }
  );

  fastify.patch(
    "/providers/:id/toggle",
    {
      schema: {
        params: {
          type: "object",
          properties: { id: { type: "string" } },
          required: ["id"],
        },
        body: {
          type: "object",
          properties: { enabled: { type: "boolean" } },
          required: ["enabled"],
        },
      },
    },
    async (
      request: FastifyRequest<{
        Params: { id: string };
        Body: { enabled: boolean };
      }>,
      reply
    ) => {
      const success = fastify.providerService.toggleProvider(
        request.params.id,
        request.body.enabled
      );
      if (!success) {
        throw createApiError("Provider not found", 404, "provider_not_found");
      }
      return {
        message: `Provider ${
          request.body.enabled ? "enabled" : "disabled"
        } successfully`,
      };
    }
  );

  // Register pool monitoring routes
  await registerPoolRoutes(fastify);
};

// Helper function
function isValidUrl(url: string): boolean {
  try {
    new URL(url);
    return true;
  } catch {
    return false;
  }
}

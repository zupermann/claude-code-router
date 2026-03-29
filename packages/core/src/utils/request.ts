import { ProxyAgent } from "undici";
import { UnifiedChatRequest } from "../types/llm";

/**
 * Configuration for sending unified requests
 */
export interface RequestConfig {
  httpsProxy?: string;
  CONNECTION_TIMEOUT_MS?: number;
  REQUEST_TIMEOUT_MS?: number;
  TIMEOUT?: number;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  // For streaming: activity tracking
  isStreaming?: boolean;
}

export function sendUnifiedRequest(
  url: URL | string,
  request: UnifiedChatRequest,
  config: RequestConfig,
  context: any,
  logger?: any
): Promise<Response> {
  const headers = new Headers({
    "Content-Type": "application/json",
  });
  if (config.headers) {
    Object.entries(config.headers).forEach(([key, value]) => {
      if (value) {
        headers.set(key, value as string);
      }
    });
  }

  // For streaming requests, use the provided signal (managed by activeConnections)
  // For non-streaming requests, use traditional total timeout
  let combinedSignal: AbortSignal;

  if (config.isStreaming && config.signal) {
    // Streaming: use signal from activeConnections (activity-based timeout)
    combinedSignal = config.signal;
  } else if (config.signal) {
    // Non-streaming with external signal: combine both
    const timeoutSignal = AbortSignal.timeout(config.TIMEOUT ?? 60 * 1000 * 60);
    const controller = new AbortController();
    const abortHandler = () => controller.abort();
    config.signal.addEventListener("abort", abortHandler);
    timeoutSignal.addEventListener("abort", abortHandler);
    combinedSignal = controller.signal;
  } else {
    // No external signal: use timeout only
    combinedSignal = AbortSignal.timeout(config.TIMEOUT ?? 60 * 1000 * 60);
  }

  const fetchOptions: RequestInit = {
    method: "POST",
    headers: headers,
    body: JSON.stringify(request),
    signal: combinedSignal,
  };

  if (config.httpsProxy) {
    (fetchOptions as any).dispatcher = new ProxyAgent(
      new URL(config.httpsProxy).toString()
    );
  }
  logger?.debug(
    {
      reqId: context.req?.id,
      request: fetchOptions,
      headers: Object.fromEntries(headers.entries()),
      requestUrl: typeof url === "string" ? url : url.toString(),
      useProxy: config.httpsProxy,
      isStreaming: config.isStreaming,
    },
    "final request"
  );
  return fetch(typeof url === "string" ? url : url.toString(), fetchOptions);
}

/**
 * Wrap a streaming response body with activity tracking
 * Calls updateActivity on each chunk and cleanup on close/error
 *
 * @param responseBody - The original response body stream
 * @param updateActivity - Callback to update activity timestamp
 * @param onEnd - Callback when stream ends (for cleanup)
 * @returns A new ReadableStream with activity tracking
 */
export function wrapStreamWithActivityTracking(
  responseBody: ReadableStream<Uint8Array>,
  updateActivity: () => void,
  onEnd: () => void
): ReadableStream<Uint8Array> {
  const reader = responseBody.getReader();

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();

        if (done) {
          controller.close();
          onEnd();
          return;
        }

        // Update activity timestamp on each chunk
        updateActivity();
        controller.enqueue(value);
      } catch (error) {
        // Connection was aborted or errored
        onEnd();
        controller.error(error);
      }
    },
    cancel() {
      onEnd();
      reader.cancel();
    }
  });
}
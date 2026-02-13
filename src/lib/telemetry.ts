import { diag, DiagConsoleLogger, DiagLogLevel, trace, SpanStatusCode } from '@opentelemetry/api';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';

let sdk: NodeSDK | undefined;

type SpanAttributeValue = string | number | boolean;

function normalizeAttributes(
  attributes?: Record<string, unknown>,
): Record<string, SpanAttributeValue> {
  if (!attributes) {
    return {};
  }

  const normalized: Record<string, SpanAttributeValue> = {};
  for (const [key, value] of Object.entries(attributes)) {
    if (value === null || value === undefined) {
      continue;
    }
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      normalized[key] = value;
      continue;
    }
    normalized[key] = String(value);
  }
  return normalized;
}

export function getTracer(name = 'ralph-loop-orchestrator') {
  return trace.getTracer(name);
}

export async function withSpan<T>(
  name: string,
  options: {
    tracerName?: string;
    attributes?: Record<string, unknown>;
  },
  fn: () => Promise<T>,
): Promise<T> {
  const tracer = getTracer(options.tracerName);
  return tracer.startActiveSpan(name, async (span) => {
    const attributes = normalizeAttributes(options.attributes);
    if (Object.keys(attributes).length > 0) {
      span.setAttributes(attributes);
    }

    try {
      const result = await fn();
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (error) {
      span.recordException(error instanceof Error ? error : new Error(String(error)));
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: error instanceof Error ? error.message : 'unknown_error',
      });
      throw error;
    } finally {
      span.end();
    }
  });
}

export async function startTelemetry(enabled: boolean): Promise<void> {
  if (!enabled) {
    return;
  }

  diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.ERROR);
  sdk = new NodeSDK({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: 'ralph-loop-orchestrator',
      [ATTR_SERVICE_VERSION]: '0.1.0',
    }),
  });
  sdk.start();
}

export async function stopTelemetry(): Promise<void> {
  if (!sdk) {
    return;
  }
  await sdk.shutdown();
}

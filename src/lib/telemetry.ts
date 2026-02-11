import { diag, DiagConsoleLogger, DiagLogLevel } from '@opentelemetry/api';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';

let sdk: NodeSDK | undefined;

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

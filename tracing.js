// Loaded with `node -r`: instrumentations must patch modules before the app requires them.
// Not using auto-instrumentations-node/register: its SIGTERM listener disables Node's default
// exit, and tiledesk-server has no handler of its own (it would hang until SIGKILL).
if (process.env.OTEL_EXPORTER_OTLP_ENDPOINT) {
  try {
    const { NodeSDK } = require('@opentelemetry/sdk-node');
    const { getNodeAutoInstrumentations, getResourceDetectors } = require('@opentelemetry/auto-instrumentations-node');
    new NodeSDK({ instrumentations: getNodeAutoInstrumentations(), resourceDetectors: getResourceDetectors() }).start();
  } catch (err) {
    console.error('[otel] not started, running without APM:', err.message);
  }
}

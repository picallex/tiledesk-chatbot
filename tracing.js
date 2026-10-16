// Loaded with `node -r`: instrumentations must patch modules before the app requires them.
if (process.env.OTEL_EXPORTER_OTLP_ENDPOINT) {
  require('@opentelemetry/auto-instrumentations-node/register');
}

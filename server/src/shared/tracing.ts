/**
 * OpenTelemetry bootstrap. Preloaded with `node -r ./dist/shared/tracing.js` so the
 * http / undici / pg / ioredis modules are patched before anything imports them.
 * No-op unless OTEL_EXPORTER_OTLP_ENDPOINT is set.
 */
import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { UndiciInstrumentation } from '@opentelemetry/instrumentation-undici';
import { PgInstrumentation } from '@opentelemetry/instrumentation-pg';
import { IORedisInstrumentation } from '@opentelemetry/instrumentation-ioredis';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions';
import { ParentBasedSampler, TraceIdRatioBasedSampler } from '@opentelemetry/sdk-trace-base';

const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
if (endpoint) {
  // NodeSDK starts an OTLP *metrics* (and logs) pipeline by default when these are unset.
  // We use Prometheus for metrics, so that would be pure overhead (and Jaeger rejects it).
  process.env.OTEL_METRICS_EXPORTER ??= 'none';
  process.env.OTEL_LOGS_EXPORTER ??= 'none';
  const ignored = new Set(['/health', '/ready', '/metrics']);
  const sdk = new NodeSDK({
    resource: resourceFromAttributes({ [ATTR_SERVICE_NAME]: process.env.SERVICE_NAME ?? 'unknown' }),
    traceExporter: new OTLPTraceExporter({ url: `${endpoint.replace(/\/$/, '')}/v1/traces` }),
    // Head-sample OTEL_SAMPLE_RATIO of new traces (5% in compose) — tracing everything at sale-day volume
    // is itself an outage. Note the instrumentation still runs on every request; only export is sampled.
    sampler: new ParentBasedSampler({ root: new TraceIdRatioBasedSampler(Number(process.env.OTEL_SAMPLE_RATIO ?? 0.1)) }),
    instrumentations: [
      new HttpInstrumentation({
        ignoreIncomingRequestHook: (req) => ignored.has((req.url ?? '').split('?')[0]),
      }),
      new UndiciInstrumentation(),
      new PgInstrumentation({ requireParentSpan: true }),
      new IORedisInstrumentation({ requireParentSpan: true }),
    ],
  });
  sdk.start();
  process.on('SIGTERM', () => {
    void sdk.shutdown().catch(() => undefined);
  });
}

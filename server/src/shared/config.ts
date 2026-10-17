import type { ServiceName } from './defs';

function str(name: string, fallback: string): string {
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : v;
}

function num(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && process.env[name] !== '' ? v : fallback;
}

export const config = {
  service: str('SERVICE_NAME', 'unknown') as ServiceName,
  port: num('PORT', 3000),
  host: str('HOST', '0.0.0.0'),
  databaseUrl: str('DATABASE_URL', 'postgres://breakcart:breakcart@localhost:5440/breakcart'),
  redisUrl: str('REDIS_URL', 'redis://localhost:6390'),
  prometheusUrl: str('PROMETHEUS_URL', 'http://localhost:9091'),
  logLevel: str('LOG_LEVEL', 'info'),
  otlpEndpoint: str('OTEL_EXPORTER_OTLP_ENDPOINT', ''),
  urls: {
    gateway: str('GATEWAY_URL', 'http://localhost:3000'),
    catalog: str('CATALOG_URL', 'http://localhost:3001'),
    inventory: str('INVENTORY_URL', 'http://localhost:3002'),
    cart: str('CART_URL', 'http://localhost:3003'),
    orders: str('ORDERS_URL', 'http://localhost:3004'),
    payments: str('PAYMENTS_URL', 'http://localhost:3005'),
    recommendations: str('RECOMMENDATIONS_URL', 'http://localhost:3006'),
    controlPlane: str('CONTROL_PLANE_URL', 'http://localhost:3010'),
    loadgen: str('LOADGEN_URL', 'http://localhost:3011'),
    workers: str('WORKERS_URL', 'http://localhost:3012'),
  },
};

export type UpstreamName = keyof typeof config.urls;

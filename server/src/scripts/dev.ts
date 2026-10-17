/**
 * Local dev runner: starts every service with tsx in one terminal, prefixing output.
 * Needs Postgres (localhost:5440) and Redis (localhost:6390): `docker compose up -d postgres redis`.
 *
 *   npm run dev                 # all services
 *   npm run dev -- gateway cart # a subset
 */
import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';

const SERVICES: Record<string, { entry: string; port: number }> = {
  gateway: { entry: 'services/gateway/main.ts', port: 3000 },
  catalog: { entry: 'services/catalog/main.ts', port: 3001 },
  inventory: { entry: 'services/inventory/main.ts', port: 3002 },
  cart: { entry: 'services/cart/main.ts', port: 3003 },
  orders: { entry: 'services/orders/main.ts', port: 3004 },
  payments: { entry: 'services/payments/main.ts', port: 3005 },
  recommendations: { entry: 'services/recommendations/main.ts', port: 3006 },
  'control-plane': { entry: 'services/control-plane/main.ts', port: 3010 },
  loadgen: { entry: 'loadgen/main.ts', port: 3011 },
  workers: { entry: 'services/workers/main.ts', port: 3012 },
};

const COLORS = [31, 32, 33, 34, 35, 36, 91, 92, 93, 94];
const wanted = process.argv.slice(2).filter((a) => a in SERVICES);
const names = wanted.length ? wanted : Object.keys(SERVICES);
const children: ChildProcess[] = [];

names.forEach((name, i) => {
  const { entry, port } = SERVICES[name];
  const child = spawn(process.execPath, ['--import', 'tsx', path.join(__dirname, '..', entry)], {
    env: { ...process.env, SERVICE_NAME: name, PORT: String(port), PROMETHEUS_URL: process.env.PROMETHEUS_URL ?? 'http://localhost:9091', LOG_LEVEL: process.env.LOG_LEVEL ?? 'warn' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const tag = `\x1b[${COLORS[i % COLORS.length]}m${name.padEnd(15)}\x1b[0m`;
  const pipe = (buf: Buffer) => {
    for (const line of buf.toString().split('\n')) if (line.trim()) process.stdout.write(`${tag} ${line}\n`);
  };
  child.stdout?.on('data', pipe);
  child.stderr?.on('data', pipe);
  child.on('exit', (code) => process.stdout.write(`${tag} exited with ${code}\n`));
  children.push(child);
});

const stop = () => {
  for (const c of children) c.kill('SIGTERM');
  setTimeout(() => process.exit(0), 1500);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);

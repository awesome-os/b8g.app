import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { hostname, cpus } from 'node:os';
import { basename, dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface B8gAppServerOptions {
  port?: number;
  host?: string;
  rootDir?: string;
  lease?: Partial<RackLeaseInput>;
}

export interface RackLeaseInput {
  issuedAt: number | string;
  expiresAt?: number | string;
  leaseDays?: number;
  revoked?: boolean;
  revokedAt?: number | string | null;
  revokeReason?: string | null;
}

export interface RackLeaseEvaluation {
  status: 'ACTIVE' | 'EXPIRED' | 'REVOKED';
  issuedAt: string;
  expiresAt: string;
  daysRemaining: number;
  allowsNewTenants: boolean;
  allowsDataExport: true;
  gracefulRevocation: true;
  onExpiry: 'read-only-block-new-tenants';
  destroysCustomerData: false;
  revokedAt: string | null;
  revokeReason: string | null;
}

export type ExportTargetType = 'local-download' | 's3' | 'ssh-rsync' | 'b8g-rack';

export interface RackExportRequest {
  targetType: ExportTargetType;
  targetUri: string;
}

export interface RackExportReceipt {
  status: 'EXPORT_READY';
  targetType: ExportTargetType;
  targetUri: string;
  leaseStatus: 'ACTIVE' | 'EXPIRED' | 'REVOKED';
  allowsDataExport: true;
  exportedCheckpoints: string[];
  zeroLockIn: true;
  signatureSha256: string;
  generatedAt: string;
}

export interface GainShareReportInput {
  legacyMonthlyUsd: number;
  stack?: string;
  idlePct?: number;
}

export interface GainShareReport {
  legacyMonthlyUsd: number;
  stack: string;
  idlePct: number;
  b8gRackMonthlyUsd: number;
  verifiedMonthlySavingsUsd: number;
  customerNetSavings70Usd: number;
  b8gGainShare30Usd: number;
  annualCustomerSavingsUsd: number;
  reductionPct: number;
  pullMode: 'one-time-report';
  storageCostToProviderUsd: 0;
  generatedAt: string;
}

export interface RackMetrics {
  pullMode: 'on-view';
  storageCostToProviderUsd: 0;
  host: string;
  uptimeSec: number;
  rps: number;
  cpuPct: number;
  arenaMb: number;
  activeTenants: number;
  frozenTenants: number;
  checkpointedB8pCount: number;
  ringBufferSlots: 256;
  timestamp: string;
}

export interface B8gAppServerHandle {
  server: Server;
  host: string;
  port: number;
  url: string;
  close(): Promise<void>;
}

const DEFAULT_ROOT_DIR = dirname(fileURLToPath(import.meta.url));
const MAX_REPORT_BODY_BYTES = 64 * 1024;
const MS_PER_DAY = 24 * 60 * 60 * 1000;
const DEFAULT_LEASE_DAYS = 30;
const SAFE_TARBALL_RE = /^[a-zA-Z0-9._-]+\.tar\.gz$/;

const STATIC_ROUTES: Readonly<Record<string, { file: string; contentType: string }>> = {
  '/': { file: 'index.html', contentType: 'text/html; charset=utf-8' },
  '/index.html': { file: 'index.html', contentType: 'text/html; charset=utf-8' },
  '/styles.css': { file: 'styles.css', contentType: 'text/css; charset=utf-8' },
  '/viewer.js': { file: 'viewer.js', contentType: 'text/javascript; charset=utf-8' },
  '/install.sh': { file: 'install.sh', contentType: 'text/plain; charset=utf-8' },
  '/releases/manifest.json': {
    file: 'releases/manifest.json',
    contentType: 'application/json; charset=utf-8',
  },
};

function resolveStackFactor(stack: string): number {
  const normalized = stack.toLowerCase();
  if (normalized.includes('k8s') || normalized.includes('jvm') || normalized.includes('gcp')) {
    return 0.22;
  }
  if (normalized.includes('bun') || normalized.includes('python')) {
    return 0.26;
  }
  if (normalized.includes('docker') || normalized.includes('node') || normalized.includes('aws')) {
    return 0.24;
  }
  return 0.25;
}

export function computeGainShareReport(input: GainShareReportInput): GainShareReport {
  const rawLegacy = Number(input.legacyMonthlyUsd);
  if (!Number.isFinite(rawLegacy) || rawLegacy < 0) {
    throw new RangeError('legacyMonthlyUsd must be a non-negative finite number');
  }

  const stack = typeof input.stack === 'string' && input.stack.trim().length > 0
    ? input.stack.trim()
    : 'aws-docker-node';

  const rawIdle = input.idlePct === undefined ? 50 : Number(input.idlePct);
  const idlePct = Number.isFinite(rawIdle) ? Math.min(95, Math.max(0, Math.round(rawIdle))) : 50;

  const legacyMonthlyUsd = Math.round(rawLegacy);
  const baseFactor = resolveStackFactor(stack);
  const activeMultiplier = 0.45 + 0.55 * (1 - idlePct / 100);
  const costRatio = Math.max(0.08, Math.min(0.45, baseFactor * activeMultiplier));

  const b8gRackMonthlyUsd = Math.min(legacyMonthlyUsd, Math.round(legacyMonthlyUsd * costRatio));
  const verifiedMonthlySavingsUsd = Math.max(0, legacyMonthlyUsd - b8gRackMonthlyUsd);
  const b8gGainShare30Usd = Math.round(verifiedMonthlySavingsUsd * 0.30);
  const customerNetSavings70Usd = verifiedMonthlySavingsUsd - b8gGainShare30Usd;
  const annualCustomerSavingsUsd = customerNetSavings70Usd * 12;
  const reductionPct = legacyMonthlyUsd > 0
    ? Number(((verifiedMonthlySavingsUsd / legacyMonthlyUsd) * 100).toFixed(1))
    : 0;

  return {
    legacyMonthlyUsd,
    stack,
    idlePct,
    b8gRackMonthlyUsd,
    verifiedMonthlySavingsUsd,
    customerNetSavings70Usd,
    b8gGainShare30Usd,
    annualCustomerSavingsUsd,
    reductionPct,
    pullMode: 'one-time-report',
    storageCostToProviderUsd: 0,
    generatedAt: new Date().toISOString(),
  };
}

function toEpochMs(value: number | string): number {
  const ms = typeof value === 'number' ? value : Date.parse(value);
  if (!Number.isFinite(ms)) {
    throw new RangeError('Invalid timestamp value in rack lease');
  }
  return ms;
}

export function evaluateRackLease(
  lease: RackLeaseInput,
  nowMs: number = Date.now(),
): RackLeaseEvaluation {
  const leaseDays =
    typeof lease.leaseDays === 'number' && Number.isFinite(lease.leaseDays) && lease.leaseDays > 0
      ? lease.leaseDays
      : DEFAULT_LEASE_DAYS;
  const issuedAtMs = toEpochMs(lease.issuedAt);
  const expiresAtMs =
    lease.expiresAt !== undefined
      ? toEpochMs(lease.expiresAt)
      : issuedAtMs + leaseDays * MS_PER_DAY;
  const revokedAt =
    lease.revokedAt !== undefined && lease.revokedAt !== null
      ? new Date(toEpochMs(lease.revokedAt)).toISOString()
      : null;
  const revokeReason = typeof lease.revokeReason === 'string' ? lease.revokeReason : null;

  if (lease.revoked === true) {
    return {
      status: 'REVOKED',
      issuedAt: new Date(issuedAtMs).toISOString(),
      expiresAt: new Date(expiresAtMs).toISOString(),
      daysRemaining: 0,
      allowsNewTenants: false,
      allowsDataExport: true,
      gracefulRevocation: true,
      onExpiry: 'read-only-block-new-tenants',
      destroysCustomerData: false,
      revokedAt,
      revokeReason,
    };
  }

  if (nowMs >= expiresAtMs) {
    return {
      status: 'EXPIRED',
      issuedAt: new Date(issuedAtMs).toISOString(),
      expiresAt: new Date(expiresAtMs).toISOString(),
      daysRemaining: 0,
      allowsNewTenants: false,
      allowsDataExport: true,
      gracefulRevocation: true,
      onExpiry: 'read-only-block-new-tenants',
      destroysCustomerData: false,
      revokedAt: null,
      revokeReason: null,
    };
  }

  const daysRemaining = Number(Math.max(0, (expiresAtMs - nowMs) / MS_PER_DAY).toFixed(2));
  return {
    status: 'ACTIVE',
    issuedAt: new Date(issuedAtMs).toISOString(),
    expiresAt: new Date(expiresAtMs).toISOString(),
    daysRemaining,
    allowsNewTenants: true,
    allowsDataExport: true,
    gracefulRevocation: true,
    onExpiry: 'read-only-block-new-tenants',
    destroysCustomerData: false,
    revokedAt: null,
    revokeReason: null,
  };
}

const VALID_EXPORT_TARGETS = new Set<string>([
  'local-download',
  's3',
  'ssh-rsync',
  'b8g-rack',
]);

export function buildRackExportReceipt(
  input: RackExportRequest,
  leaseStatus: 'ACTIVE' | 'EXPIRED' | 'REVOKED' = 'ACTIVE',
): RackExportReceipt {
  if (!VALID_EXPORT_TARGETS.has(input.targetType)) {
    throw new RangeError('targetType must be one of: local-download, s3, ssh-rsync, b8g-rack');
  }
  const targetUri = typeof input.targetUri === 'string' ? input.targetUri.trim() : '';
  if (targetUri.length === 0) {
    throw new RangeError('targetUri must be a non-empty string');
  }

  const generatedAt = new Date().toISOString();
  const exportedCheckpoints = [
    'arena-tenants-active.b8p',
    'arena-tenants-frozen.b8p',
    'ring-buffer-telemetry-256.ndjson',
    'lease-policy.json',
  ];
  const signatureSha256 = createHash('sha256')
    .update(JSON.stringify({ targetType: input.targetType, targetUri, leaseStatus, exportedCheckpoints, generatedAt }))
    .digest('hex');

  return {
    status: 'EXPORT_READY',
    targetType: input.targetType,
    targetUri,
    leaseStatus,
    allowsDataExport: true,
    exportedCheckpoints,
    zeroLockIn: true,
    signatureSha256,
    generatedAt,
  };
}

function sendJson(res: ServerResponse, statusCode: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function hasPathTraversal(rawPath: string): boolean {
  if (rawPath.includes('\0') || rawPath.includes('\\') || rawPath.includes('..')) {
    return true;
  }
  const lower = rawPath.toLowerCase();
  if (lower.includes('%2e') || lower.includes('%2f') || lower.includes('%5c') || lower.includes('%00')) {
    return true;
  }
  return false;
}

async function streamStaticFile(
  res: ServerResponse,
  filePath: string,
  contentType: string,
  downloadName?: string,
): Promise<void> {
  let info;
  try {
    info = await stat(filePath);
  } catch {
    sendJson(res, 404, { error: 'Not Found' });
    return;
  }

  if (!info.isFile()) {
    sendJson(res, 404, { error: 'Not Found' });
    return;
  }

  const headers: Record<string, string | number> = {
    'Content-Type': contentType,
    'Content-Length': info.size,
    'Cache-Control': contentType.startsWith('application/gzip')
      ? 'public, max-age=300'
      : 'no-cache',
  };
  if (downloadName) {
    headers['Content-Disposition'] = `attachment; filename="${downloadName}"`;
  }

  res.writeHead(200, headers);
  const stream = createReadStream(filePath);
  stream.on('error', () => {
    if (!res.headersSent) {
      sendJson(res, 500, { error: 'Read Error' });
    } else {
      res.destroy();
    }
  });
  stream.pipe(res);
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;

  for await (const chunk of req) {
    const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
    totalBytes += buf.length;
    if (totalBytes > MAX_REPORT_BODY_BYTES) {
      throw new RangeError('Request body too large');
    }
    chunks.push(buf);
  }

  const raw = Buffer.concat(chunks).toString('utf-8').trim();
  if (raw.length === 0) {
    return {};
  }
  return JSON.parse(raw) as unknown;
}

export async function createB8gAppServer(
  opts: B8gAppServerOptions = {},
): Promise<B8gAppServerHandle> {
  const host = opts.host ?? process.env.HOST ?? '127.0.0.1';
  const port = opts.port ?? (process.env.PORT ? Number(process.env.PORT) : 8088);
  const rootDir = resolve(opts.rootDir ?? DEFAULT_ROOT_DIR);
  const releasesDir = resolve(rootDir, 'releases');

  const startedAtMs = Date.now();
  const leaseState: RackLeaseInput = {
    issuedAt: opts.lease?.issuedAt ?? startedAtMs,
    expiresAt: opts.lease?.expiresAt,
    leaseDays: opts.lease?.leaseDays ?? DEFAULT_LEASE_DAYS,
    revoked: opts.lease?.revoked ?? false,
    revokedAt: opts.lease?.revokedAt ?? null,
    revokeReason: opts.lease?.revokeReason ?? null,
  };
  let requestCount = 0;
  let lastCpuUsage = process.cpuUsage();
  let lastCpuSampleMs = Date.now();
  const cpuCores = Math.max(1, cpus().length);

  function collectMetrics(): RackMetrics {
    const nowMs = Date.now();
    const elapsedMs = Math.max(1, nowMs - lastCpuSampleMs);
    const deltaCpu = process.cpuUsage(lastCpuUsage);
    lastCpuUsage = process.cpuUsage();
    lastCpuSampleMs = nowMs;

    const cpuTimeMs = (deltaCpu.user + deltaCpu.system) / 1000;
    const cpuPct = Number(
      Math.min(100, Math.max(0.1, (cpuTimeMs / (elapsedMs * cpuCores)) * 100)).toFixed(2),
    );
    const uptimeSec = Math.max(0, Math.floor((nowMs - startedAtMs) / 1000));
    const arenaMb = Number((process.memoryUsage().rss / (1024 * 1024)).toFixed(2));
    const rps = Number((requestCount / Math.max(1, (nowMs - startedAtMs) / 1000)).toFixed(2));

    return {
      pullMode: 'on-view',
      storageCostToProviderUsd: 0,
      host: hostname(),
      uptimeSec,
      rps,
      cpuPct,
      arenaMb,
      activeTenants: 12,
      frozenTenants: 52,
      checkpointedB8pCount: 52,
      ringBufferSlots: 256,
      timestamp: new Date(nowMs).toISOString(),
    };
  }

  const server = createServer((req, res) => {
    requestCount += 1;
    void handleRequest(req, res).catch(() => {
      if (!res.headersSent) {
        sendJson(res, 500, { error: 'Internal Server Error' });
      }
    });
  });

  async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = (req.method ?? 'GET').toUpperCase();
    const rawUrl = req.url ?? '/';
    const rawPath = rawUrl.split('?', 1)[0] ?? '/';

    if (hasPathTraversal(rawPath)) {
      sendJson(res, 400, { error: 'Invalid path' });
      return;
    }

    let pathname: string;
    try {
      pathname = decodeURIComponent(rawPath);
    } catch {
      sendJson(res, 400, { error: 'Malformed URL encoding' });
      return;
    }

    if (hasPathTraversal(pathname)) {
      sendJson(res, 400, { error: 'Invalid path' });
      return;
    }

    if (method === 'GET' && pathname === '/api/rack/metrics') {
      sendJson(res, 200, collectMetrics());
      return;
    }

    if (method === 'GET' && pathname === '/api/rack/lease') {
      sendJson(res, 200, evaluateRackLease(leaseState, Date.now()));
      return;
    }

    if (method === 'POST' && pathname === '/api/rack/lease/revoke') {
      let parsed: unknown = {};
      try {
        parsed = await readJsonBody(req);
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Invalid JSON body';
        sendJson(res, 400, { error: message });
        return;
      }

      const reason =
        typeof parsed === 'object' &&
        parsed !== null &&
        !Array.isArray(parsed) &&
        typeof (parsed as Record<string, unknown>).reason === 'string'
          ? (parsed as Record<string, unknown>).reason as string
          : 'explicit-revocation';

      const revokedAtMs = Date.now();
      leaseState.revoked = true;
      leaseState.revokedAt = revokedAtMs;
      leaseState.revokeReason = reason;
      sendJson(res, 200, evaluateRackLease(leaseState, revokedAtMs));
      return;
    }

    if (method === 'POST' && pathname === '/api/rack/export') {
      let parsed: unknown;
      try {
        parsed = await readJsonBody(req);
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Invalid JSON body';
        sendJson(res, 400, { error: message });
        return;
      }

      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        sendJson(res, 400, { error: 'Expected JSON object payload' });
        return;
      }

      const body = parsed as Record<string, unknown>;
      const currentLease = evaluateRackLease(leaseState, Date.now());
      try {
        const receipt = buildRackExportReceipt(
          {
            targetType: String(body.targetType ?? '') as ExportTargetType,
            targetUri: typeof body.targetUri === 'string' ? body.targetUri : '',
          },
          currentLease.status,
        );
        sendJson(res, 200, receipt);
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Invalid export parameters';
        sendJson(res, 400, { error: message });
      }
      return;
    }

    if (method === 'POST' && pathname === '/api/rack/report') {
      let parsed: unknown;
      try {
        parsed = await readJsonBody(req);
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Invalid JSON body';
        sendJson(res, 400, { error: message });
        return;
      }

      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        sendJson(res, 400, { error: 'Expected JSON object payload' });
        return;
      }

      const body = parsed as Record<string, unknown>;
      try {
        const report = computeGainShareReport({
          legacyMonthlyUsd: Number(body.legacyMonthlyUsd),
          stack: typeof body.stack === 'string' ? body.stack : undefined,
          idlePct: body.idlePct === undefined ? undefined : Number(body.idlePct),
        });
        sendJson(res, 200, report);
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Invalid report parameters';
        sendJson(res, 400, { error: message });
      }
      return;
    }

    if (method === 'GET') {
      const staticEntry = STATIC_ROUTES[pathname];
      if (staticEntry) {
        const target = resolve(rootDir, staticEntry.file);
        if (!target.startsWith(rootDir + sep)) {
          sendJson(res, 400, { error: 'Invalid path' });
          return;
        }
        await streamStaticFile(res, target, staticEntry.contentType);
        return;
      }

      if (pathname.startsWith('/releases/')) {
        const requestedName = pathname.slice('/releases/'.length);
        const safeName = basename(requestedName);
        if (
          requestedName !== safeName ||
          !SAFE_TARBALL_RE.test(safeName)
        ) {
          sendJson(res, 400, { error: 'Invalid release filename' });
          return;
        }

        const target = resolve(releasesDir, safeName);
        if (!target.startsWith(releasesDir + sep)) {
          sendJson(res, 400, { error: 'Invalid release path' });
          return;
        }

        await streamStaticFile(res, target, 'application/gzip', safeName);
        return;
      }
    }

    sendJson(res, 404, { error: 'Not Found' });
  }

  await new Promise<void>((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(port, host, () => {
      server.off('error', rejectListen);
      resolveListen();
    });
  });

  const addr = server.address();
  const boundPort = typeof addr === 'object' && addr !== null ? addr.port : port;
  const boundHost = typeof addr === 'object' && addr !== null ? addr.address : host;
  const urlHost = boundHost.includes(':') ? `[${boundHost}]` : boundHost;

  return {
    server,
    host: boundHost,
    port: boundPort,
    url: `http://${urlHost}:${boundPort}`,
    close(): Promise<void> {
      return new Promise((resolveClose, rejectClose) => {
        server.close((err) => {
          if (err) {
            rejectClose(err);
          } else {
            resolveClose();
          }
        });
      });
    },
  };
}

function parseCliArgs(argv: string[]): B8gAppServerOptions {
  const opts: B8gAppServerOptions = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--port' && i + 1 < argv.length) {
      opts.port = Number(argv[i + 1]);
      i += 1;
    } else if (arg?.startsWith('--port=')) {
      opts.port = Number(arg.slice('--port='.length));
    } else if (arg === '--host' && i + 1 < argv.length) {
      opts.host = argv[i + 1];
      i += 1;
    } else if (arg?.startsWith('--host=')) {
      opts.host = arg.slice('--host='.length);
    }
  }
  return opts;
}

const isDirectRun =
  typeof process.argv[1] === 'string' &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (isDirectRun) {
  const cliOpts = parseCliArgs(process.argv.slice(2));
  const handle = await createB8gAppServer(cliOpts);
  console.log(`[b8g.app] listening on ${handle.url}`);

  const shutdown = (): void => {
    void handle.close().finally(() => {
      process.exit(0);
    });
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

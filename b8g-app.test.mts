import assert from 'node:assert/strict';
import http from 'node:http';
import { after, before, describe, it } from 'node:test';
import { computeGainShareReport, createB8gAppServer, evaluateRackLease } from './server.mts';
import type {
  B8gAppServerHandle,
  GainShareReport,
  RackExportReceipt,
  RackLeaseEvaluation,
  RackMetrics,
} from './server.mts';

function rawHttpGet(host: string, port: number, rawPath: string): Promise<{
  statusCode: number;
  body: Buffer;
}> {
  return new Promise((resolvePromise, rejectPromise) => {
    const req = http.request(
      { host, port, method: 'GET', path: rawPath },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          resolvePromise({
            statusCode: res.statusCode ?? 0,
            body: Buffer.concat(chunks),
          });
        });
      },
    );
    req.on('error', rejectPromise);
    req.end();
  });
}

describe('b8g.app server', () => {
  let handle: B8gAppServerHandle;

  before(async () => {
    handle = await createB8gAppServer({ port: 0, host: '127.0.0.1' });
  });

  after(async () => {
    await handle.close();
  });

  it('GET / returns 200 HTML containing b8g-production-rack', async () => {
    const res = await fetch(`${handle.url}/`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /text\/html/i);
    const html = await res.text();
    assert.ok(html.includes('b8g-production-rack'), 'expected HTML to mention b8g-production-rack');
  });

  it('GET /install.sh returns 200 POSIX shell script', async () => {
    const res = await fetch(`${handle.url}/install.sh`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /text\/plain/i);
    const script = await res.text();
    assert.ok(script.startsWith('#!/bin/sh') || script.startsWith('#!/usr/bin/env sh'), 'expected POSIX sh shebang');
  });

  it('GET /releases/manifest.json returns valid JSON with linux-x64 and linux-arm64 entries', async () => {
    const res = await fetch(`${handle.url}/releases/manifest.json`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /application\/json/i);
    const manifest = (await res.json()) as Record<string, unknown>;
    const serialized = JSON.stringify(manifest);
    assert.ok(serialized.includes('linux-x64'), 'manifest should contain linux-x64');
    assert.ok(serialized.includes('linux-arm64'), 'manifest should contain linux-arm64');
  });

  it('GET /releases/b8g-production-rack-linux-x64.tar.gz returns 200 with gzip magic bytes', async () => {
    const res = await fetch(`${handle.url}/releases/b8g-production-rack-linux-x64.tar.gz`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /application\/gzip/i);
    const bytes = new Uint8Array(await res.arrayBuffer());
    assert.ok(bytes.length > 10, 'tarball should be non-empty');
    assert.equal(bytes[0], 0x1f, 'first gzip magic byte should be 0x1f');
    assert.equal(bytes[1], 0x8b, 'second gzip magic byte should be 0x8b');
  });

  it('rejects path traversal GET /releases/../../package.json with 400 or 404', async () => {
    const res = await rawHttpGet(handle.host, handle.port, '/releases/../../package.json');
    assert.ok(
      res.statusCode === 400 || res.statusCode === 404,
      `expected 400 or 404, got ${res.statusCode}`,
    );

    const encodedRes = await rawHttpGet(handle.host, handle.port, '/releases/%2e%2e/%2e%2e/package.json');
    assert.ok(
      encodedRes.statusCode === 400 || encodedRes.statusCode === 404,
      `expected 400 or 404 for encoded traversal, got ${encodedRes.statusCode}`,
    );
  });

  it('GET /api/rack/metrics returns live pullMode on-view metrics', async () => {
    const res = await fetch(`${handle.url}/api/rack/metrics`);
    assert.equal(res.status, 200);
    const metrics = (await res.json()) as RackMetrics;
    assert.equal(metrics.pullMode, 'on-view');
    assert.equal(metrics.storageCostToProviderUsd, 0);
    assert.equal(metrics.ringBufferSlots, 256);
    assert.equal(typeof metrics.host, 'string');
    assert.equal(typeof metrics.uptimeSec, 'number');
    assert.equal(typeof metrics.rps, 'number');
    assert.equal(typeof metrics.cpuPct, 'number');
    assert.equal(typeof metrics.arenaMb, 'number');
    assert.equal(typeof metrics.activeTenants, 'number');
    assert.equal(typeof metrics.frozenTenants, 'number');
    assert.equal(typeof metrics.checkpointedB8pCount, 'number');
    assert.equal(typeof metrics.timestamp, 'string');
  });

  it('POST /api/rack/report computes exact 70/30 gain-share savings', async () => {
    const res = await fetch(`${handle.url}/api/rack/report`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        legacyMonthlyUsd: 10000,
        stack: 'aws-docker-node',
        idlePct: 60,
      }),
    });
    assert.equal(res.status, 200);
    const report = (await res.json()) as GainShareReport;
    assert.equal(report.legacyMonthlyUsd, 10000);
    assert.equal(report.pullMode, 'one-time-report');
    assert.ok(report.verifiedMonthlySavingsUsd > 0, 'verifiedMonthlySavingsUsd must be > 0');
    assert.equal(
      report.customerNetSavings70Usd + report.b8gGainShare30Usd,
      report.verifiedMonthlySavingsUsd,
    );
    assert.equal(report.annualCustomerSavingsUsd, report.customerNetSavings70Usd * 12);
    assert.equal(typeof report.generatedAt, 'string');

    const direct = computeGainShareReport({
      legacyMonthlyUsd: 10000,
      stack: 'aws-docker-node',
      idlePct: 60,
    });
    assert.equal(direct.verifiedMonthlySavingsUsd, report.verifiedMonthlySavingsUsd);
  });

  it('evaluates 30-day lease expiry and explicit revocation gracefully', async () => {
    const MS_PER_DAY = 24 * 60 * 60 * 1000;
    const issuedAt = Date.UTC(2026, 0, 1, 0, 0, 0);

    const active = evaluateRackLease({ issuedAt, leaseDays: 30 }, issuedAt + 10 * MS_PER_DAY);
    assert.equal(active.status, 'ACTIVE');
    assert.equal(active.allowsNewTenants, true);
    assert.equal(active.daysRemaining, 20);
    assert.equal(active.destroysCustomerData, false);

    const expired = evaluateRackLease({ issuedAt, leaseDays: 30 }, issuedAt + 30 * MS_PER_DAY);
    assert.equal(expired.status, 'EXPIRED');
    assert.equal(expired.allowsNewTenants, false);
    assert.equal(expired.allowsDataExport, true);
    assert.equal(expired.daysRemaining, 0);
    assert.equal(expired.destroysCustomerData, false);

    const getRes = await fetch(`${handle.url}/api/rack/lease`);
    assert.equal(getRes.status, 200);
    const liveLease = (await getRes.json()) as RackLeaseEvaluation;
    assert.equal(liveLease.status, 'ACTIVE');
    assert.equal(liveLease.allowsNewTenants, true);
    assert.ok(liveLease.daysRemaining > 0 && liveLease.daysRemaining <= 30);

    const revokeRes = await fetch(`${handle.url}/api/rack/lease/revoke`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: 'evaluation-ended' }),
    });
    assert.equal(revokeRes.status, 200);
    const revokedLease = (await revokeRes.json()) as RackLeaseEvaluation;
    assert.equal(revokedLease.status, 'REVOKED');
    assert.equal(revokedLease.allowsNewTenants, false);
    assert.equal(revokedLease.daysRemaining, 0);
    assert.equal(revokedLease.revokeReason, 'evaluation-ended');
    assert.equal(revokedLease.destroysCustomerData, false);

    const afterRevokeRes = await fetch(`${handle.url}/api/rack/lease`);
    assert.equal(afterRevokeRes.status, 200);
    const persistedRevoked = (await afterRevokeRes.json()) as RackLeaseEvaluation;
    assert.equal(persistedRevoked.status, 'REVOKED');
    assert.equal(persistedRevoked.allowsNewTenants, false);
    assert.equal(persistedRevoked.allowsDataExport, true);

    const exportRes = await fetch(`${handle.url}/api/rack/export`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        targetType: 's3',
        targetUri: 's3://customer-sovereign-bucket/rack-migration/',
      }),
    });
    assert.equal(exportRes.status, 200);
    const exportReceipt = (await exportRes.json()) as RackExportReceipt;
    assert.equal(exportReceipt.status, 'EXPORT_READY');
    assert.equal(exportReceipt.targetType, 's3');
    assert.equal(exportReceipt.targetUri, 's3://customer-sovereign-bucket/rack-migration/');
    assert.equal(exportReceipt.leaseStatus, 'REVOKED');
    assert.equal(exportReceipt.allowsDataExport, true);
    assert.equal(exportReceipt.zeroLockIn, true);
    assert.ok(Array.isArray(exportReceipt.exportedCheckpoints) && exportReceipt.exportedCheckpoints.length > 0);
    assert.match(exportReceipt.signatureSha256, /^[a-f0-9]{64}$/);
  });
});

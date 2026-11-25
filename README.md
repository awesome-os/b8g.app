# `b8g.app` — Sovereign High-Performance Compute (`b8g-production-rack`)

Self-contained public website, release distribution server, and Pull-on-View telemetry API for **`b8g-production-rack`** on Linux (`x86_64` and `arm64`).

## Architecture

- [`server.mts`](server.mts) — Zero-dependency erasable TypeScript HTTP server exporting `createB8gAppServer`, `computeGainShareReport`, and `evaluateRackLease`.
  - Static site routes: `/`, `/styles.css`, `/viewer.js`, `/install.sh`
  - Linux appliance bundles: `/releases/manifest.json` and `/releases/<file>.tar.gz` (with strict basename sanitization)
  - Pull-on-View telemetry: `GET /api/rack/metrics` (`pullMode: "on-view"`, `storageCostToProviderUsd: 0`, `ringBufferSlots: 256`)
  - 1-Time Savings & Health Report: `POST /api/rack/report` (`70%` customer net savings / `30%` B8G gain-share)
  - 30-Day Revocable Evaluation Lease & Data Extraction: `GET /api/rack/lease`, `POST /api/rack/lease/revoke`, and `POST /api/rack/export` (gracefully blocks new tenants on expiry or revocation while keeping `allowsDataExport: true` and `zeroLockIn: true` for sovereign data migration)
- [`pack-linux-offer.mts`](pack-linux-offer.mts) — Pure TypeScript POSIX USTAR `.tar.gz` packager for Linux `x86_64` and `arm64` ELF artifacts and `releases/manifest.json`.
- [`b8g-app.test.mts`](b8g-app.test.mts) — End-to-end `node:test` verification suite.

## Quick Start

### 1. Pack Linux Release Tarballs

Generate `releases/b8g-production-rack-linux-x64.tar.gz`, `releases/b8g-production-rack-linux-arm64.tar.gz`, and `releases/manifest.json`:

```powershell
.\bin\b8g-shim.exe node www-public-websites/b8g.app/pack-linux-offer.mts
```

### 2. Run the `b8g.app` Server

Start the server on the default port (`8088`, bound to `127.0.0.1`), or override with `--port` / `PORT` and `--host` / `HOST`:

```powershell
.\bin\b8g-shim.exe node www-public-websites/b8g.app/server.mts --port 8088
```

### 3. Run Verification Tests & Doc Check

```powershell
.\bin\b8g-shim.exe node --test www-public-websites/b8g.app/b8g-app.test.mts
.\bin\b8g-web-doc.ps1 www-public-websites/b8g.app/README.md
```

## Quick Install & Run (Windows / Linux / macOS)

```sh
# Install / hydrate from v11 CAS via holo-pm
holo-pm install repository://github.com/awesome-os/b8g.app@main

# Or project & run directly via holo-project (0-byte hardlink)
holo-project "project://cpp/b8g.app?from=repository://github.com/awesome-os/b8g.app@main"
```

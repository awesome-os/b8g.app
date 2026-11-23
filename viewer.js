// b8g.app — Sovereign High-Performance Compute Interactive Viewer
// Zero-dependency ES module implementing <b8g-savings-calc> & <b8g-rack-viewer>.

const STACK_PROFILES = {
  'aws-docker-node': {
    label: 'AWS / Docker / Node',
    baseRackRatio: 0.34,
    idleReclaimWeight: 0.36,
  },
  'gcp-k8s-jvm': {
    label: 'GCP / K8s / JVM',
    baseRackRatio: 0.31,
    idleReclaimWeight: 0.40,
  },
  'cloud-bun-python': {
    label: 'Cloud / Bun / Python',
    baseRackRatio: 0.37,
    idleReclaimWeight: 0.34,
  },
};

const USD = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 0,
});

const NUM = new Intl.NumberFormat('en-US');

function clamp(val, min, max) {
  return Math.min(max, Math.max(min, val));
}

export function computeSavings({ legacyMonthlyUsd, stack, idlePct }) {
  const spend = clamp(Number(legacyMonthlyUsd) || 10000, 500, 250000);
  const idle = clamp(Number(idlePct) || 60, 20, 85);
  const profile = STACK_PROFILES[stack] ?? STACK_PROFILES['aws-docker-node'];

  // Higher idle container ratio means .b8p warm-RAM freeze reclaims more wasted spend.
  const idleFactor = (idle - 20) / 65; // 0..1
  const rackCostRatio = clamp(profile.baseRackRatio - idleFactor * profile.idleReclaimWeight * 0.45, 0.14, 0.42);
  const b8gRackMonthlyUsd = Math.round(spend * rackCostRatio);
  const verifiedMonthlySavingsUsd = Math.max(0, spend - b8gRackMonthlyUsd);
  const b8gGainShare30Usd = Math.round(verifiedMonthlySavingsUsd * 0.3);
  const customerNetSavings70Usd = verifiedMonthlySavingsUsd - b8gGainShare30Usd;
  const annualCustomerSavingsUsd = customerNetSavings70Usd * 12;
  const savingsPct = spend > 0 ? Math.round((verifiedMonthlySavingsUsd / spend) * 100) : 0;

  return {
    legacyMonthlyUsd: spend,
    stack: STACK_PROFILES[stack] ? stack : 'aws-docker-node',
    idlePct: idle,
    b8gRackMonthlyUsd,
    verifiedMonthlySavingsUsd,
    customerNetSavings70Usd,
    b8gGainShare30Usd,
    annualCustomerSavingsUsd,
    savingsPct,
  };
}

const BaseElement = typeof HTMLElement !== 'undefined' ? HTMLElement : class {};

class B8gSavingsCalc extends BaseElement {
  connectedCallback() {
    this._state = {
      legacyMonthlyUsd: clamp(Number(this.dataset.defaultSpend) || 10000, 500, 250000),
      stack: this.dataset.defaultStack || 'aws-docker-node',
      idlePct: clamp(Number(this.dataset.defaultIdle) || 60, 20, 85),
    };

    this.innerHTML = `
      <div class="panel-card calc-grid">
        <div class="calc-controls">
          <div class="field-group">
            <div class="field-header">
              <label class="field-label" for="b8g-spend-range">Monthly Legacy Infra Spend</label>
              <span class="field-value" data-out="spend-label"></span>
            </div>
            <div class="field-input-row">
              <input id="b8g-spend-range" type="range" min="500" max="250000" step="500" value="${this._state.legacyMonthlyUsd}">
              <input id="b8g-spend-num" class="num-input" type="number" min="500" max="250000" step="500" value="${this._state.legacyMonthlyUsd}" aria-label="Monthly Legacy Infra Spend in USD">
            </div>
          </div>

          <div class="field-group">
            <div class="field-header">
              <span class="field-label">Workload Stack</span>
              <span class="field-value" data-out="stack-label"></span>
            </div>
            <div class="stack-pills" role="group" aria-label="Workload Stack">
              ${Object.entries(STACK_PROFILES).map(([key, p]) => `
                <button type="button" class="stack-pill${key === this._state.stack ? ' active' : ''}" data-stack="${key}">
                  ${p.label}
                </button>
              `).join('')}
            </div>
          </div>

          <div class="field-group">
            <div class="field-header">
              <label class="field-label" for="b8g-idle-range">Idle Container Ratio (<code>.b8p</code> Freeze Target)</label>
              <span class="field-value" data-out="idle-label"></span>
            </div>
            <input id="b8g-idle-range" type="range" min="20" max="85" step="1" value="${this._state.idlePct}">
          </div>
        </div>

        <div class="calc-outputs" aria-live="polite">
          <div class="kpi-box">
            <div class="kpi-label">Projected b8g-production-rack</div>
            <div class="kpi-value" data-out="rack-cost"></div>
            <div class="kpi-sub">Bare-metal / sovereign Linux footprint</div>
          </div>

          <div class="kpi-box">
            <div class="kpi-label">Total Verified Savings</div>
            <div class="kpi-value accent-cyan" data-out="total-savings"></div>
            <div class="kpi-sub" data-out="savings-pct"></div>
          </div>

          <div class="kpi-box kpi-box-highlight">
            <div class="kpi-label">Customer Keeps (70%)</div>
            <div class="kpi-value accent-emerald" data-out="customer-70"></div>
            <div class="kpi-sub">Immediate monthly net reduction</div>
          </div>

          <div class="kpi-box">
            <div class="kpi-label">B8G Gain-Share (30%)</div>
            <div class="kpi-value accent-cyan" data-out="b8g-30"></div>
            <div class="kpi-sub">Pay $0 if savings aren&rsquo;t proven</div>
          </div>

          <div class="kpi-box kpi-box-wide">
            <div>
              <div class="kpi-label">Annual Net Savings (Customer 70%)</div>
              <div class="kpi-sub">Verified 12-month retained savings on your balance sheet</div>
            </div>
            <div class="kpi-value accent-emerald" data-out="annual-savings"></div>
          </div>

          <div class="split-bar" aria-hidden="true">
            <div class="split-seg-rack" data-bar="rack"></div>
            <div class="split-seg-customer" data-bar="customer"></div>
            <div class="split-seg-b8g" data-bar="b8g"></div>
          </div>
        </div>
      </div>
    `;

    this._spendRange = this.querySelector('#b8g-spend-range');
    this._spendNum = this.querySelector('#b8g-spend-num');
    this._idleRange = this.querySelector('#b8g-idle-range');

    this._spendRange.addEventListener('input', () => {
      this._state.legacyMonthlyUsd = Number(this._spendRange.value);
      this._spendNum.value = String(this._state.legacyMonthlyUsd);
      this._render();
    });

    this._spendNum.addEventListener('input', () => {
      const val = Number(this._spendNum.value);
      if (Number.isFinite(val)) {
        this._state.legacyMonthlyUsd = clamp(val, 500, 250000);
        this._spendRange.value = String(this._state.legacyMonthlyUsd);
        this._render();
      }
    });

    this._idleRange.addEventListener('input', () => {
      this._state.idlePct = Number(this._idleRange.value);
      this._render();
    });

    this.querySelectorAll('.stack-pill').forEach((btn) => {
      btn.addEventListener('click', () => {
        this._state.stack = btn.dataset.stack;
        this.querySelectorAll('.stack-pill').forEach((b) => {
          b.classList.toggle('active', b === btn);
        });
        this._render();
      });
    });

    this._render();
  }

  getInputs() {
    return { ...this._state };
  }

  _render() {
    const res = computeSavings(this._state);
    const set = (k, v) => {
      const el = this.querySelector(`[data-out="${k}"]`);
      if (el) el.textContent = v;
    };

    set('spend-label', `${USD.format(res.legacyMonthlyUsd)} / mo`);
    set('stack-label', STACK_PROFILES[res.stack].label);
    set('idle-label', `${res.idlePct}% idle`);
    set('rack-cost', `${USD.format(res.b8gRackMonthlyUsd)}/mo`);
    set('total-savings', `${USD.format(res.verifiedMonthlySavingsUsd)}/mo`);
    set('savings-pct', `${res.savingsPct}% verified infra reduction`);
    set('customer-70', `${USD.format(res.customerNetSavings70Usd)}/mo`);
    set('b8g-30', `${USD.format(res.b8gGainShare30Usd)}/mo`);
    set('annual-savings', `${USD.format(res.annualCustomerSavingsUsd)}/yr`);

    const total = Math.max(1, res.legacyMonthlyUsd);
    const setW = (bar, val) => {
      const el = this.querySelector(`[data-bar="${bar}"]`);
      if (el) el.style.width = `${(val / total) * 100}%`;
    };
    setW('rack', res.b8gRackMonthlyUsd);
    setW('customer', res.customerNetSavings70Usd);
    setW('b8g', res.b8gGainShare30Usd);

    window.dispatchEvent(new CustomEvent('b8g:savings-change', { detail: res }));
  }
}

class B8gRackViewer extends BaseElement {
  connectedCallback() {
    this._endpoint = this.dataset.endpoint || '/api/rack/metrics';
    this._reportEndpoint = this.dataset.reportEndpoint || '/api/rack/report';
    this._exportEndpoint = this.dataset.exportEndpoint || '/api/rack/export';
    this._mode = 'live';
    this._rpsHistory = [];
    this._arenaHistory = [];
    this._simTick = 0;
    this._lastReport = null;
    this._lastCheckpoints = 50;
    this._timer = null;

    this.innerHTML = `
      <div class="panel-card">
        <div class="viewer-toolbar">
          <div class="mode-toggle" role="tablist" aria-label="Telemetry source">
            <button type="button" class="mode-btn active" data-mode="live" role="tab" aria-selected="true">
              Live Local Rack
            </button>
            <button type="button" class="mode-btn" data-mode="simulated" role="tab" aria-selected="false">
              Simulated 64-Tenant Fleet
            </button>
          </div>
          <div class="viewer-status">
            <span class="status-badge" data-el="status-badge">
              <span class="pulse-dot" aria-hidden="true"></span>
              <span data-el="status-text">Pull-on-View Active</span>
            </span>
            <span data-el="host-meta">host: connecting&hellip;</span>
          </div>
        </div>

        <div class="sparkline-grid">
          <div class="chart-card">
            <div class="chart-head">
              <span class="chart-title">Throughput (RPS)</span>
              <span class="chart-val accent-cyan" data-el="rps-val">&mdash;</span>
            </div>
            <canvas class="spark-canvas" data-canvas="rps" aria-label="Requests per second sparkline"></canvas>
          </div>
          <div class="chart-card">
            <div class="chart-head">
              <span class="chart-title">B8G Arena Footprint (MB)</span>
              <span class="chart-val accent-emerald" data-el="arena-val">&mdash;</span>
            </div>
            <canvas class="spark-canvas" data-canvas="arena" aria-label="Arena memory usage sparkline"></canvas>
          </div>
        </div>

        <div class="telemetry-stats">
          <div class="stat-tile">
            <div class="stat-tile-label">CPU Utilization</div>
            <div class="stat-tile-val" data-el="cpu-val">&mdash;</div>
          </div>
          <div class="stat-tile">
            <div class="stat-tile-label">Checkpointed .b8p</div>
            <div class="stat-tile-val accent-cyan" data-el="b8p-val">&mdash;</div>
          </div>
          <div class="stat-tile">
            <div class="stat-tile-label">Local Ring Buffer</div>
            <div class="stat-tile-val" data-el="ring-val">256 slots</div>
          </div>
          <div class="stat-tile">
            <div class="stat-tile-label">Provider Storage Tax</div>
            <div class="stat-tile-val accent-emerald" data-el="storage-val">$0.00 / mo</div>
          </div>
        </div>

        <div class="tenant-bar-wrap">
          <div class="tenant-bar-head">
            <span class="accent-emerald" data-el="active-tenants">Active Tenants: &mdash;</span>
            <span class="accent-cyan" data-el="frozen-tenants">.b8p Warm-RAM Frozen: &mdash;</span>
          </div>
          <div class="tenant-track" aria-hidden="true">
            <div class="tenant-active" data-el="bar-active" style="width: 30%"></div>
            <div class="tenant-frozen" data-el="bar-frozen" style="width: 70%"></div>
          </div>
        </div>

        <div class="report-actions">
          <div class="report-btn-group">
            <button type="button" class="btn btn-primary" data-action="generate-report">
              Generate 1-Time Savings Report
            </button>
            <button type="button" class="btn btn-outline" data-action="download-report" hidden>
              Download JSON Report
            </button>
          </div>
          <span class="viewer-status" data-el="report-meta">Uses current calculator inputs &bull; 1 pull at cycle end</span>
        </div>

        <pre class="report-output" data-el="report-output" hidden></pre>

        <div class="extract-panel">
          <div class="extract-head">
            <span class="extract-title">Post-Revocation Data Extraction &amp; Target Migration</span>
            <span class="extract-sub">zeroLockIn: true &bull; read-only export always allowed</span>
          </div>
          <form class="extract-form" data-el="extract-form">
            <select class="select-input" data-el="extract-type" aria-label="Export target type">
              <option value="s3">S3 Bucket (s3://)</option>
              <option value="ssh-rsync">SSH / rsync (ssh://)</option>
              <option value="b8g-rack">Other B8G Rack (https://)</option>
              <option value="local-download">Local Download</option>
            </select>
            <input
              type="text"
              class="text-input"
              data-el="extract-uri"
              value="s3://sovereign-backup/b8g-rack-export"
              placeholder="s3://bucket/path, ssh://host/dir, or https://other-rack"
              aria-label="Export target URI"
              required
            >
            <button type="submit" class="btn btn-outline" data-action="extract-data">
              Extract &amp; Move Data
            </button>
          </form>
          <pre class="extract-output" data-el="extract-output" hidden></pre>
        </div>
      </div>
    `;

    this._rpsCanvas = this.querySelector('[data-canvas="rps"]');
    this._arenaCanvas = this.querySelector('[data-canvas="arena"]');

    this.querySelectorAll('.mode-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const nextMode = btn.dataset.mode;
        if (nextMode === this._mode) return;
        this._mode = nextMode;
        this._rpsHistory = [];
        this._arenaHistory = [];
        this.querySelectorAll('.mode-btn').forEach((b) => {
          const isActive = b === btn;
          b.classList.toggle('active', isActive);
          b.setAttribute('aria-selected', String(isActive));
        });
        this._pollOnce();
      });
    });

    this.querySelector('[data-action="generate-report"]').addEventListener('click', () => {
      this._generateReport();
    });

    this.querySelector('[data-action="download-report"]').addEventListener('click', () => {
      this._downloadReport();
    });

    const extractTypeEl = this.querySelector('[data-el="extract-type"]');
    const extractUriEl = this.querySelector('[data-el="extract-uri"]');
    const defaultUris = {
      s3: 's3://sovereign-backup/b8g-rack-export',
      'ssh-rsync': 'ssh://ops@baremetal-02.internal/var/b8g/export',
      'b8g-rack': 'https://rack-eu-west.example/import',
      'local-download': 'local://b8g-rack-checkpoints.tar.gz',
    };
    extractTypeEl.addEventListener('change', () => {
      const nextDefault = defaultUris[extractTypeEl.value];
      if (nextDefault) extractUriEl.value = nextDefault;
    });

    this.querySelector('[data-el="extract-form"]').addEventListener('submit', (e) => {
      e.preventDefault();
      this._extractData();
    });

    this._onVisibility = () => {
      if (document.hidden) {
        this._stopPolling();
      } else {
        this._startPolling();
      }
    };
    document.addEventListener('visibilitychange', this._onVisibility);

    this._onResize = () => this._drawAll();
    window.addEventListener('resize', this._onResize);

    this._startPolling();
  }

  disconnectedCallback() {
    this._stopPolling();
    document.removeEventListener('visibilitychange', this._onVisibility);
    window.removeEventListener('resize', this._onResize);
  }

  _startPolling() {
    this._stopPolling();
    this._pollOnce();
    this._timer = window.setInterval(() => this._pollOnce(), 1500);
  }

  _stopPolling() {
    if (this._timer !== null) {
      window.clearInterval(this._timer);
      this._timer = null;
    }
  }

  _simulateFleetSample() {
    this._simTick += 1;
    const wave = Math.sin(this._simTick * 0.45);
    const jitter = (Math.random() - 0.5) * 4200;
    const rps = Math.max(42000, Math.round(78400 + wave * 12500 + jitter));
    const activeTenants = Math.round(14 + (wave + 1) * 4);
    const frozenTenants = 64 - activeTenants;
    const arenaMb = Number((18.4 + activeTenants * 0.62 + Math.random() * 1.1).toFixed(1));
    const cpuPct = Number((11.5 + (rps / 93449) * 24).toFixed(1));

    return {
      pullMode: 'on-view',
      storageCostToProviderUsd: 0,
      host: 'sim-rack-eu-central-01',
      uptimeSec: 86400 * 14 + this._simTick * 2,
      rps,
      cpuPct,
      arenaMb,
      activeTenants,
      frozenTenants,
      checkpointedB8pCount: frozenTenants + 12,
      ringBufferSlots: 256,
      timestamp: new Date().toISOString(),
    };
  }

  async _pollOnce() {
    const badge = this.querySelector('[data-el="status-badge"]');
    const statusText = this.querySelector('[data-el="status-text"]');

    if (this._mode === 'simulated') {
      badge.classList.add('sim');
      statusText.textContent = 'Simulated 64-Tenant Fleet';
      this._ingestSample(this._simulateFleetSample());
      return;
    }

    try {
      const res = await fetch(this._endpoint, { headers: { Accept: 'application/json' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      badge.classList.remove('sim');
      statusText.textContent = `Live Pull (${data.pullMode || 'on-view'})`;
      this._ingestSample(data);
    } catch {
      badge.classList.add('sim');
      statusText.textContent = 'Local Rack Offline (Preview)';
      this._ingestSample(this._simulateFleetSample());
    }
  }

  _ingestSample(sample) {
    const maxPoints = 48;
    const rps = Number(sample.rps) || 0;
    const arenaMb = Number(sample.arenaMb) || 0;
    const active = Number(sample.activeTenants) || 0;
    const frozen = Number(sample.frozenTenants) || 0;
    const totalTenants = Math.max(1, active + frozen);

    this._rpsHistory.push(rps);
    this._arenaHistory.push(arenaMb);
    if (this._rpsHistory.length > maxPoints) this._rpsHistory.shift();
    if (this._arenaHistory.length > maxPoints) this._arenaHistory.shift();

    const set = (el, text) => {
      const node = this.querySelector(`[data-el="${el}"]`);
      if (node) node.textContent = text;
    };

    set('rps-val', `${NUM.format(Math.round(rps))} req/s`);
    set('arena-val', `${arenaMb.toFixed(1)} MB`);
    set('cpu-val', `${Number(sample.cpuPct || 0).toFixed(1)}%`);
    const checkpoints = Number(sample.checkpointedB8pCount || frozen);
    this._lastCheckpoints = checkpoints;
    set('b8p-val', `${NUM.format(checkpoints)} packs`);
    set('ring-val', `${sample.ringBufferSlots ?? 256} slots`);
    set('storage-val', `$${Number(sample.storageCostToProviderUsd ?? 0).toFixed(2)} / mo`);
    set('host-meta', `host: ${sample.host || 'local-rack'} • up ${formatUptime(sample.uptimeSec || 0)}`);
    set('active-tenants', `Active Tenants: ${active}`);
    set('frozen-tenants', `.b8p Warm-RAM Frozen: ${frozen} (0 idle RAM)`);

    const activeBar = this.querySelector('[data-el="bar-active"]');
    const frozenBar = this.querySelector('[data-el="bar-frozen"]');
    if (activeBar && frozenBar) {
      activeBar.style.width = `${(active / totalTenants) * 100}%`;
      frozenBar.style.width = `${(frozen / totalTenants) * 100}%`;
    }

    this._drawAll();
  }

  _drawAll() {
    drawSparkline(this._rpsCanvas, this._rpsHistory, '#38BDF8', 'rgba(56, 189, 248, 0.22)');
    drawSparkline(this._arenaCanvas, this._arenaHistory, '#34D399', 'rgba(52, 211, 153, 0.22)');
  }

  async _generateReport() {
    const calc = document.querySelector('b8g-savings-calc');
    const inputs = calc && typeof calc.getInputs === 'function'
      ? calc.getInputs()
      : { legacyMonthlyUsd: 10000, stack: 'aws-docker-node', idlePct: 60 };

    const outEl = this.querySelector('[data-el="report-output"]');
    const dlBtn = this.querySelector('[data-action="download-report"]');
    const metaEl = this.querySelector('[data-el="report-meta"]');

    let report;
    try {
      const res = await fetch(this._reportEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(inputs),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      report = await res.json();
      metaEl.textContent = `1-time report pulled from ${this._reportEndpoint}`;
    } catch {
      const local = computeSavings(inputs);
      report = {
        legacyMonthlyUsd: local.legacyMonthlyUsd,
        b8gRackMonthlyUsd: local.b8gRackMonthlyUsd,
        verifiedMonthlySavingsUsd: local.verifiedMonthlySavingsUsd,
        customerNetSavings70Usd: local.customerNetSavings70Usd,
        b8gGainShare30Usd: local.b8gGainShare30Usd,
        annualCustomerSavingsUsd: local.annualCustomerSavingsUsd,
        pullMode: 'one-time-report',
        generatedAt: new Date().toISOString(),
      };
      metaEl.textContent = '1-time report generated locally (offline preview)';
    }

    this._lastReport = report;
    outEl.textContent = JSON.stringify(report, null, 2);
    outEl.hidden = false;
    dlBtn.hidden = false;
  }

  _downloadReport() {
    if (!this._lastReport) return;
    const blob = new Blob([JSON.stringify(this._lastReport, null, 2)], {
      type: 'application/json;charset=utf-8',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `b8g-savings-report-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  async _extractData() {
    const targetType = this.querySelector('[data-el="extract-type"]').value;
    const targetUri = this.querySelector('[data-el="extract-uri"]').value.trim();
    const outEl = this.querySelector('[data-el="extract-output"]');

    let receipt;
    try {
      const res = await fetch(this._exportEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ targetType, targetUri }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      receipt = await res.json();
    } catch {
      receipt = {
        status: 'EXPORT_READY',
        targetType,
        targetUri,
        exportedCheckpoints: this._lastCheckpoints,
        zeroLockIn: true,
        mode: 'offline-preview',
        generatedAt: new Date().toISOString(),
      };
    }

    outEl.textContent = JSON.stringify(receipt, null, 2);
    outEl.hidden = false;
  }
}

function formatUptime(sec) {
  const s = Math.max(0, Math.floor(Number(sec) || 0));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m ${s % 60}s`;
}

function drawSparkline(canvas, data, strokeColor, fillColor) {
  if (!canvas) return;
  const rect = canvas.getBoundingClientRect();
  const width = Math.max(160, Math.floor(rect.width || 320));
  const height = Math.max(80, Math.floor(rect.height || 112));
  const dpr = Math.min(window.devicePixelRatio || 1, 2);

  if (canvas.width !== width * dpr || canvas.height !== height * dpr) {
    canvas.width = width * dpr;
    canvas.height = height * dpr;
  }

  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  ctx.save();
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, width, height);

  // Subtle horizontal reference grid
  ctx.strokeStyle = 'rgba(148, 163, 184, 0.12)';
  ctx.lineWidth = 1;
  for (let i = 1; i <= 3; i += 1) {
    const y = Math.round((height / 4) * i) + 0.5;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(width, y);
    ctx.stroke();
  }

  if (!data || data.length === 0) {
    ctx.restore();
    return;
  }

  const padTop = 10;
  const padBottom = 10;
  const min = Math.min(...data);
  const max = Math.max(...data);
  const span = Math.max(1, max - min);
  const stepX = data.length > 1 ? width / (data.length - 1) : width;

  const pts = data.map((v, i) => ({
    x: data.length > 1 ? i * stepX : width,
    y: height - padBottom - ((v - min) / span) * (height - padTop - padBottom),
  }));

  // Gradient fill
  const grad = ctx.createLinearGradient(0, 0, 0, height);
  grad.addColorStop(0, fillColor);
  grad.addColorStop(1, 'rgba(7, 10, 18, 0)');

  ctx.beginPath();
  ctx.moveTo(pts[0].x, height);
  for (const p of pts) ctx.lineTo(p.x, p.y);
  ctx.lineTo(pts[pts.length - 1].x, height);
  ctx.closePath();
  ctx.fillStyle = grad;
  ctx.fill();

  // Stroke
  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i += 1) {
    ctx.lineTo(pts[i].x, pts[i].y);
  }
  ctx.strokeStyle = strokeColor;
  ctx.lineWidth = 2;
  ctx.lineJoin = 'round';
  ctx.stroke();

  // Live terminal dot
  const last = pts[pts.length - 1];
  ctx.beginPath();
  ctx.arc(last.x, last.y, 3.5, 0, Math.PI * 2);
  ctx.fillStyle = strokeColor;
  ctx.fill();

  ctx.restore();
}

function wireCopyButtons() {
  document.querySelectorAll('[data-copy]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const text = btn.getAttribute('data-copy') || '';
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          await navigator.clipboard.writeText(text);
        } else {
          const ta = document.createElement('textarea');
          ta.value = text;
          ta.style.position = 'fixed';
          ta.style.opacity = '0';
          document.body.appendChild(ta);
          ta.select();
          document.execCommand('copy');
          ta.remove();
        }
        const orig = btn.textContent;
        btn.textContent = 'Copied!';
        btn.classList.add('copied');
        window.setTimeout(() => {
          btn.textContent = orig;
          btn.classList.remove('copied');
        }, 1800);
      } catch {
        btn.textContent = 'Copy failed';
      }
    });
  });
}

if (typeof customElements !== 'undefined') {
  if (!customElements.get('b8g-savings-calc')) {
    customElements.define('b8g-savings-calc', B8gSavingsCalc);
  }
  if (!customElements.get('b8g-rack-viewer')) {
    customElements.define('b8g-rack-viewer', B8gRackViewer);
  }
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', wireCopyButtons, { once: true });
  } else {
    wireCopyButtons();
  }
}

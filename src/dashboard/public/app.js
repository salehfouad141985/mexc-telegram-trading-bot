/**
 * Shaabane Signals Bot — Dashboard Client JS
 * Real-time data polling and UI rendering
 */

const API_BASE = '';
const POLL_INTERVAL = 4000; // 4 seconds

let lastStats = null;
let lastSignalsCount = 0;

// ===========================
// Initialization
// ===========================

document.addEventListener('DOMContentLoaded', () => {
  fetchAll();
  setInterval(fetchAll, POLL_INTERVAL);
});

async function fetchAll() {
  try {
    await Promise.all([
      fetchStats(),
      fetchBalance(),
      fetchSignals(),
      fetchTrades(),
      fetchActivity(),
      fetchConfig(),
    ]);

    // Update connection status
    const badge = document.getElementById('statusBadge');
    badge.classList.add('connected');
    badge.querySelector('.status-text').textContent = 'متصل';

    // Update last refresh time
    document.getElementById('lastUpdate').textContent =
      'آخر تحديث: ' + new Date().toLocaleTimeString('ar-EG');
  } catch (err) {
    const badge = document.getElementById('statusBadge');
    badge.classList.remove('connected');
    badge.querySelector('.status-text').textContent = 'غير متصل';
  }
}

// ===========================
// API Fetchers
// ===========================

async function fetchStats() {
  const res = await fetch(`${API_BASE}/api/stats`);
  const data = await res.json();
  lastStats = data;

  document.getElementById('totalSignals').textContent = data.totalSignals;
  document.getElementById('todaySignals').textContent = `اليوم: ${data.todaySignals}`;
  document.getElementById('openTrades').textContent = data.openTrades;
  document.getElementById('totalTrades').textContent = `الإجمالي: ${data.totalTrades}`;
  document.getElementById('winRate').textContent = `${data.winRate}%`;
  document.getElementById('winCount').textContent = data.winTrades;
  document.getElementById('lossCount').textContent = data.lossTrades;

  const pnlEl = document.getElementById('totalPnl');
  const pnlVal = parseFloat(data.totalPnl);
  pnlEl.textContent = `$${pnlVal.toFixed(2)}`;
  pnlEl.classList.remove('positive', 'negative');
  pnlEl.classList.add(pnlVal >= 0 ? 'positive' : 'negative');

  const todayPnlVal = parseFloat(data.todayPnl);
  document.getElementById('todayPnl').textContent = `$${todayPnlVal.toFixed(2)}`;

  // Mode badge
  const modeBadge = document.getElementById('modeBadge');
  if (data.dryRun) {
    modeBadge.innerHTML = '<span>🧪 DRY RUN</span>';
    modeBadge.classList.remove('live');
  } else {
    modeBadge.innerHTML = '<span>🔴 LIVE</span>';
    modeBadge.classList.add('live');
  }
}

async function fetchBalance() {
  try {
    const res = await fetch(`${API_BASE}/api/balance`);
    const data = await res.json();
    const balVal = parseFloat(data.free || 0).toFixed(2);
    document.getElementById('balanceValue').textContent = balVal;
  } catch {
    document.getElementById('balanceValue').textContent = '—';
  }
}

async function fetchSignals() {
  const res = await fetch(`${API_BASE}/api/signals?limit=20`);
  const signals = await res.json();

  const listEl = document.getElementById('signalsList');
  const emptyEl = document.getElementById('signalsEmpty');

  if (signals.length === 0) {
    emptyEl.style.display = 'flex';
    listEl.innerHTML = '';
    return;
  }

  emptyEl.style.display = 'none';
  listEl.innerHTML = signals.map((s) => renderSignalCard(s)).join('');
}

function refreshSignals() {
  fetchSignals();
}

async function fetchTrades() {
  const filter = document.getElementById('tradesFilter').value;
  let url = `${API_BASE}/api/trades?limit=50`;
  if (filter === 'open') url = `${API_BASE}/api/trades/open`;

  const res = await fetch(url);
  let trades = await res.json();

  if (filter === 'closed') {
    trades = trades.filter((t) => t.status === 'FILLED' || t.status === 'CLOSED' || t.status === 'CANCELED');
  }

  const emptyEl = document.getElementById('tradesEmpty');
  const wrapperEl = document.getElementById('tradesTableWrapper');
  const tbody = document.getElementById('tradesTableBody');

  if (trades.length === 0) {
    emptyEl.style.display = 'flex';
    wrapperEl.style.display = 'none';
    return;
  }

  emptyEl.style.display = 'none';
  wrapperEl.style.display = 'block';
  tbody.innerHTML = trades.map((t) => renderTradeRow(t)).join('');
}

function refreshTrades() {
  fetchTrades();
}

async function fetchActivity() {
  const res = await fetch(`${API_BASE}/api/activity?limit=25`);
  const activities = await res.json();

  const listEl = document.getElementById('activityList');
  const emptyEl = document.getElementById('activityEmpty');

  if (activities.length === 0) {
    emptyEl.style.display = 'flex';
    listEl.innerHTML = '';
    return;
  }

  emptyEl.style.display = 'none';
  listEl.innerHTML = activities.map((a) => renderActivityItem(a)).join('');
}

function refreshActivity() {
  fetchActivity();
}

async function fetchConfig() {
  try {
    const res = await fetch(`${API_BASE}/api/config`);
    const cfg = await res.json();

    document.getElementById('settingDryRun').textContent = cfg.dryRun ? '🧪 تجريبي' : '🔴 حقيقي';
    document.getElementById('settingDryRun').style.color = cfg.dryRun ? 'var(--yellow)' : 'var(--red)';

    document.getElementById('settingAutoTrade').textContent = cfg.autoTrade ? '✅ مفعّل' : '❌ معطّل';
    document.getElementById('settingAutoTrade').style.color = cfg.autoTrade ? 'var(--green)' : 'var(--red)';

    document.getElementById('settingAmount').textContent = `${cfg.tradeAmountUsdt} USDT`;
    document.getElementById('settingMinScore').textContent = `${cfg.minScore} / 10`;
    document.getElementById('settingTP1').textContent = `${cfg.tp1Percent}%`;
    document.getElementById('settingTP2').textContent = `${cfg.tp2Percent}%`;
    document.getElementById('settingTP3').textContent = `${cfg.tp3Percent}%`;
    document.getElementById('settingTP4').textContent = `${cfg.tp4Percent}%`;
  } catch {
    // ignore
  }
}

// ===========================
// Renderers
// ===========================

function renderSignalCard(signal) {
  const scoreClass = signal.score >= 8 ? 'score-high' : signal.score >= 6 ? 'score-mid' : 'score-low';
  const statusClass = getSignalStatusClass(signal.status);

  const targets = [];
  if (signal.tp1) targets.push(`TP1: $${signal.tp1}`);
  if (signal.tp2) targets.push(`TP2: $${signal.tp2}`);
  if (signal.tp3) targets.push(`TP3: $${signal.tp3}`);
  if (signal.tp4) targets.push(`TP4: $${signal.tp4}`);

  const time = new Date(signal.created_at).toLocaleString('ar-EG', {
    hour: '2-digit',
    minute: '2-digit',
    month: 'short',
    day: 'numeric',
  });

  return `
    <div class="signal-card">
      <div class="signal-top">
        <span class="signal-symbol">${signal.symbol}</span>
        <span class="signal-score ${scoreClass}">⭐ ${signal.score || '—'}</span>
      </div>
      <div class="signal-prices">
        <div class="signal-price">
          <span class="signal-price-label">الدخول</span>
          <span class="signal-price-value price-entry">$${signal.entry_price}</span>
        </div>
        <div class="signal-price">
          <span class="signal-price-label">وقف الخسارة</span>
          <span class="signal-price-value price-sl">$${signal.stop_loss || '—'}</span>
        </div>
        <div class="signal-price">
          <span class="signal-price-label">الإطار</span>
          <span class="signal-price-value">${signal.timeframe || '—'}</span>
        </div>
      </div>
      <div class="signal-targets">
        ${targets.map((t) => `<span class="target-badge">${t}</span>`).join('')}
      </div>
      <div class="signal-meta">
        <span class="signal-status ${statusClass}">${translateStatus(signal.status)}</span>
        <span>${time}</span>
      </div>
    </div>
  `;
}

function renderTradeRow(trade) {
  const sideClass = trade.side === 'BUY' ? 'badge-buy' : 'badge-sell';
  const statusClass = getTradeStatusBadge(trade.status);
  const pnl = parseFloat(trade.pnl || 0);
  const pnlClass = pnl > 0 ? 'pnl-positive' : pnl < 0 ? 'pnl-negative' : '';

  const time = new Date(trade.created_at).toLocaleString('ar-EG', {
    hour: '2-digit',
    minute: '2-digit',
    month: 'short',
    day: 'numeric',
  });

  return `
    <tr>
      <td class="mono">${trade.symbol}</td>
      <td>${trade.type}</td>
      <td><span class="badge ${sideClass}">${trade.side === 'BUY' ? 'شراء' : 'بيع'}</span></td>
      <td class="mono">${trade.quantity}</td>
      <td class="mono">$${trade.price || '—'}</td>
      <td><span class="badge badge-simulated">${trade.target_label || '—'}</span></td>
      <td><span class="badge ${statusClass}">${translateTradeStatus(trade.status)}</span></td>
      <td class="mono ${pnlClass}">${pnl !== 0 ? '$' + pnl.toFixed(4) : '—'}</td>
      <td>${time}</td>
    </tr>
  `;
}

function renderActivityItem(activity) {
  const dotClass = getActivityDotClass(activity.type);
  const time = new Date(activity.created_at).toLocaleString('ar-EG', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });

  return `
    <div class="activity-item">
      <div class="activity-dot ${dotClass}"></div>
      <div class="activity-content">
        <div class="activity-message">${activity.message}</div>
        <div class="activity-time">${time}</div>
      </div>
    </div>
  `;
}

// ===========================
// Helpers
// ===========================

function getSignalStatusClass(status) {
  const map = {
    NEW: 'status-new',
    ACTIVE: 'status-active',
    PARTIALLY_FILLED: 'status-active',
    STOPPED: 'status-stopped',
    ERROR: 'status-stopped',
    SKIPPED: 'status-skipped',
    UNAVAILABLE: 'status-skipped',
    INSUFFICIENT_BALANCE: 'status-stopped',
  };
  return map[status] || 'status-new';
}

function translateStatus(status) {
  const map = {
    NEW: 'جديد',
    ACTIVE: 'نشط',
    PARTIALLY_FILLED: 'مملوء جزئياً',
    STOPPED: 'متوقف',
    ERROR: 'خطأ',
    SKIPPED: 'تم التجاوز',
    UNAVAILABLE: 'غير متاح',
    INSUFFICIENT_BALANCE: 'رصيد غير كافي',
    INVALID_QUANTITY: 'كمية خاطئة',
  };
  return map[status] || status;
}

function getTradeStatusBadge(status) {
  const map = {
    PENDING: 'badge-pending',
    FILLED: 'badge-filled',
    SIMULATED: 'badge-simulated',
    CANCELED: 'badge-canceled',
    CLOSED: 'badge-filled',
  };
  return map[status] || 'badge-pending';
}

function translateTradeStatus(status) {
  const map = {
    PENDING: 'معلق',
    FILLED: 'مُنفَّذ',
    SIMULATED: 'محاكاة',
    CANCELED: 'ملغي',
    CLOSED: 'مغلق',
    PARTIALLY_FILLED: 'جزئي',
  };
  return map[status] || status;
}

function getActivityDotClass(type) {
  const map = {
    SIGNAL: 'dot-signal',
    TRADE: 'dot-trade',
    TARGET: 'dot-trade',
    FILLED: 'dot-trade',
    ERROR: 'dot-error',
    SYSTEM: 'dot-system',
    BOT: 'dot-system',
    MONITOR: 'dot-system',
    SKIP: 'dot-skip',
    SAVED: 'dot-signal',
    SL_HIT: 'dot-error',
    SL_EXECUTED: 'dot-error',
    TP_HIT: 'dot-trade',
    TP_REACHED: 'dot-trade',
    UPDATE: 'dot-signal',
    UNAVAILABLE: 'dot-skip',
    INSUFFICIENT: 'dot-error',
  };
  return map[type] || 'dot-system';
}

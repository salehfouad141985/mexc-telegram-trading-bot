/**
 * Shaabane Signals Bot — Premium Dashboard Client JS v2.0
 * Real-time data polling, Futuristic UI rendering, and PnL Tracking
 */

const API_BASE = '';
const POLL_INTERVAL = 4000;

let pnlHistory = []; // For sparkline
let lastStats = null;

// ===========================
// Initialization
// ===========================

document.addEventListener('DOMContentLoaded', () => {
  initNavigation();
  fetchAll();
  setInterval(fetchAll, POLL_INTERVAL);
});

function initNavigation() {
  const navLinks = document.querySelectorAll('.nav-link');
  navLinks.forEach(link => {
    link.addEventListener('click', (e) => {
      e.preventDefault();
      navLinks.forEach(l => l.classList.remove('active'));
      link.classList.add('active');
      
      const target = link.id;
      const pageTitle = document.getElementById('pageTitle');
      
      if (target === 'navOverview') {
        pageTitle.textContent = 'نظرة عامة';
        window.scrollTo({ top: 0, behavior: 'smooth' });
      } else if (target === 'navSignals') {
        pageTitle.textContent = 'الإشارات النشطة';
        document.querySelector('.dashboard-grid').scrollIntoView({ behavior: 'smooth' });
      } else if (target === 'navTrades') {
        pageTitle.textContent = 'تاريخ الصفقات';
        document.getElementById('tradesTable').scrollIntoView({ behavior: 'smooth' });
      } else if (target === 'navSettings') {
        pageTitle.textContent = 'الإعدادات';
        document.getElementById('settingsView').scrollIntoView({ behavior: 'smooth' });
      }
    });
  });
}

async function fetchAll() {
  try {
    const results = await Promise.allSettled([
      fetchStats(),
      fetchBalance(),
      fetchSignals(),
      fetchTrades(),
      fetchActivity(),
      fetchConfig(),
    ]);

    // Check if any failed
    const someSuccess = results.some(r => r.status === 'fulfilled');
    
    const badge = document.getElementById('statusBadge');
    if (someSuccess) {
      badge.classList.add('connected');
      badge.querySelector('.status-label').textContent = 'متصل بالسحابة';
    } else {
      badge.classList.remove('connected');
      badge.querySelector('.status-label').textContent = 'جاري المحاولة...';
    }

    document.getElementById('lastUpdate').textContent =
      'آخر تحديث: ' + new Date().toLocaleTimeString('ar-EG');
  } catch (err) {
    console.error('Fetch error:', err);
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

  document.getElementById('todayPnl').textContent = `اليوم: $${parseFloat(data.todayPnl).toFixed(2)}`;

  // Update PnL History for Sparkline
  pnlHistory.push(pnlVal);
  if (pnlHistory.length > 20) pnlHistory.shift();
  drawSparkline('pnlSparkline', pnlHistory);

  // Mode badge
  const modeBadge = document.getElementById('modeBadge');
  if (data.dryRun) {
    modeBadge.innerHTML = '<i class="fas fa-flask"></i> <span>DRY RUN</span>';
    modeBadge.classList.remove('live');
  } else {
    modeBadge.innerHTML = '<i class="fas fa-satellite"></i> <span>LIVE MODE</span>';
    modeBadge.classList.add('live');
  }
}

async function fetchBalance() {
  try {
    const res = await fetch(`${API_BASE}/api/balance`);
    const data = await res.json();
    const balVal = parseFloat(data.free || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    document.getElementById('balanceValue').textContent = balVal;
  } catch {
    document.getElementById('balanceValue').textContent = '—';
  }
}

async function fetchSignals() {
  const res = await fetch(`${API_BASE}/api/signals?limit=10`);
  const signals = await res.json();

  const listEl = document.getElementById('signalsList');
  const emptyEl = document.getElementById('signalsEmpty');

  if (signals.length === 0) {
    emptyEl.style.display = 'flex';
    listEl.innerHTML = '';
    return;
  }

  emptyEl.style.display = 'none';
  listEl.innerHTML = signals.map(s => renderSignalCard(s)).join('');
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
    trades = trades.filter(t => ['FILLED', 'CLOSED', 'CANCELED'].includes(t.status));
  }

  const emptyEl = document.getElementById('tradesEmpty');
  const tbody = document.getElementById('tradesTableBody');

  if (trades.length === 0) {
    emptyEl.style.display = 'flex';
    tbody.innerHTML = '';
    return;
  }

  emptyEl.style.display = 'none';
  tbody.innerHTML = trades.map(t => renderTradeRow(t)).join('');
}

function refreshTrades() {
  fetchTrades();
}

async function fetchActivity() {
  const res = await fetch(`${API_BASE}/api/activity?limit=30`);
  const activities = await res.json();

  const listEl = document.getElementById('activityList');
  if (activities.length === 0) {
    listEl.innerHTML = '<div class="activity-line"><span class="line-msg">لا توجد سجلات حالياً...</span></div>';
    return;
  }

  listEl.innerHTML = activities.map(a => renderActivityLine(a)).join('');
}

function refreshActivity() {
  const listEl = document.getElementById('activityList');
  listEl.innerHTML = '';
  fetchActivity();
}

async function fetchConfig() {
  try {
    const res = await fetch(`${API_BASE}/api/config`);
    const cfg = await res.json();

    const dryEl = document.getElementById('settingDryRun');
    dryEl.textContent = cfg.dryRun ? 'تجريبي (Dry Run)' : 'حقيقي (Live)';
    dryEl.className = 'value ' + (cfg.dryRun ? 'text-warning' : 'pnl-negative');

    const autoEl = document.getElementById('settingAutoTrade');
    autoEl.textContent = cfg.autoTrade ? 'مفعّل ✅' : 'معطّل ❌';
    autoEl.style.color = cfg.autoTrade ? 'var(--accent-emerald)' : 'var(--accent-rose)';

    document.getElementById('settingAmount').textContent = `${cfg.tradeAmountUsdt} USDT`;
    document.getElementById('settingMinScore').textContent = `${cfg.minScore} / 10`;
    document.getElementById('settingTP1').textContent = `${cfg.tp1Percent}%`;
    document.getElementById('settingTP2').textContent = `${cfg.tp2Percent}%`;
    document.getElementById('settingTP3').textContent = `${cfg.tp3Percent}%`;
    document.getElementById('settingTP4').textContent = `${cfg.tp4Percent}%`;
  } catch (e) { console.error(e); }
}

// ===========================
// Renderers
// ===========================

function renderSignalCard(signal) {
  const scoreClass = signal.score >= 8 ? 'score-high' : signal.score >= 6 ? 'score-mid' : 'score-low';
  
  const targets = [];
  if (signal.tp1) targets.push(`TP1: $${signal.tp1}`);
  if (signal.tp2) targets.push(`TP2: $${signal.tp2}`);
  if (signal.tp3) targets.push(`TP3: $${signal.tp3}`);
  if (signal.tp4) targets.push(`TP4: $${signal.tp4}`);

  const time = new Date(signal.created_at).toLocaleString('ar-EG', {
    hour: '2-digit', minute: '2-digit', month: 'short', day: 'numeric'
  });

  return `
    <div class="signal-card">
      <div class="signal-top">
        <span class="signal-symbol">${signal.symbol}</span>
        <span class="signal-score ${scoreClass}"><i class="fas fa-star"></i> ${signal.score || '—'}</span>
      </div>
      <div class="signal-prices">
        <div class="price-item">
          <span class="price-label">الدخول</span>
          <span class="price-value">$${signal.entry_price}</span>
        </div>
        <div class="price-item">
          <span class="price-label">وقف الخسارة</span>
          <span class="price-value text-rose">$${signal.stop_loss || '—'}</span>
        </div>
        <div class="price-item">
          <span class="price-label">الإطار</span>
          <span class="price-value">${signal.timeframe || '—'}</span>
        </div>
      </div>
      <div class="target-pills">
        ${targets.map(t => `<span class="pill">${t}</span>`).join('')}
      </div>
      <div class="signal-meta mt-12 flex-between">
        <span class="status-pill ${getSignalStatusClass(signal.status)}">${translateStatus(signal.status)}</span>
        <span class="text-muted small">${time}</span>
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
    hour: '2-digit', minute: '2-digit', month: 'short', day: 'numeric'
  });

  return `
    <tr>
      <td class="mono">${trade.symbol}</td>
      <td class="small">${trade.type}</td>
      <td><span class="status-pill ${trade.side === 'BUY' ? 'status-filled' : 'status-canceled'}">${trade.side === 'BUY' ? 'شراء' : 'بيع'}</span></td>
      <td class="mono">${trade.quantity}</td>
      <td class="mono">$${trade.price || '—'}</td>
      <td><span class="pill hit">${trade.target_label || '—'}</span></td>
      <td><span class="status-pill ${statusClass}">${translateTradeStatus(trade.status)}</span></td>
      <td class="mono ${pnlClass}">${pnl !== 0 ? (pnl > 0 ? '+' : '') + '$' + pnl.toFixed(4) : '—'}</td>
      <td class="text-muted small">${time}</td>
    </tr>
  `;
}

function renderActivityLine(activity) {
  const typeClass = getActivityTypeClass(activity.type);
  const time = new Date(activity.created_at).toLocaleTimeString('ar-EG', {
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  });

  return `
    <div class="activity-line">
      <span class="line-time">[${time}]</span>
      <span class="line-msg ${typeClass}">${activity.message}</span>
    </div>
  `;
}

// ===========================
// Helpers & Graphics
// ===========================

function drawSparkline(canvasId, data) {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const width = canvas.width;
  const height = canvas.height;
  
  ctx.clearRect(0, 0, width, height);
  if (data.length < 2) return;

  const min = Math.min(...data);
  const max = Math.max(...data);
  const range = max - min || 1;

  ctx.beginPath();
  ctx.lineWidth = 2;
  ctx.strokeStyle = data[data.length-1] >= data[0] ? '#10b981' : '#f43f5e';
  
  data.forEach((val, i) => {
    const x = (i / (data.length - 1)) * width;
    const y = height - ((val - min) / range) * height;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();
}

function getSignalStatusClass(status) {
  const map = { ACTIVE: 'status-filled', NEW: 'status-pending', STOPPED: 'status-canceled', ERROR: 'status-canceled' };
  return map[status] || 'status-pending';
}

function translateStatus(status) {
  const map = { NEW: 'جديد', ACTIVE: 'نشط', STOPPED: 'متوقف', ERROR: 'خطأ', SKIPPED: 'تم التجاوز' };
  return map[status] || status;
}

function getTradeStatusBadge(status) {
  const map = { PENDING: 'status-pending', FILLED: 'status-filled', CLOSED: 'status-filled', CANCELED: 'status-canceled' };
  return map[status] || 'status-pending';
}

function translateTradeStatus(status) {
  const map = { PENDING: 'معلق', FILLED: 'مُنفَّذ', CLOSED: 'مغلق', CANCELED: 'ملغي' };
  return map[status] || status;
}

function getActivityTypeClass(type) {
  const map = { SIGNAL: 'type-signal', TRADE: 'type-trade', ERROR: 'type-error', SYSTEM: 'type-system' };
  return map[type] || 'type-system';
}

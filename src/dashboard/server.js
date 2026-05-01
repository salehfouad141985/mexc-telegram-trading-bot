const express = require('express');
const path = require('path');
const config = require('../config');
const logger = require('../utils/logger');
const db = require('../database/db');
const mexc = require('../exchange/mexcClient');

const app = express();

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// Helper to get real-time prices for active signals
async function enrichWithRealtimeData(signals) {
  if (!signals || signals.length === 0) return 0;
  
  try {
    const pricesData = await mexc.getAllPrices();
    const priceMap = new Map(pricesData.map(p => [p.symbol, parseFloat(p.price)]));
    
    let totalFloatingPnl = 0;
    const amount = parseFloat(config.trading.tradeAmountUsdt) || 10;

    signals.forEach(sig => {
      const currentPrice = priceMap.get(sig.symbol);
      if (currentPrice && sig.entry_price) {
        const pnlPercent = ((currentPrice - sig.entry_price) / sig.entry_price) * 100;
        const pnlUsdt = (pnlPercent / 100) * amount;
        
        sig.current_price = currentPrice;
        sig.floating_pnl_percent = pnlPercent.toFixed(2);
        sig.floating_pnl_usdt = pnlUsdt.toFixed(2);
        
        if (sig.status === 'ACTIVE' || sig.status === 'PARTIALLY_FILLED' || sig.status === 'NEW') {
           totalFloatingPnl += pnlUsdt;
        }
      }
    });
    return totalFloatingPnl;
  } catch (err) {
    logger.error('PnL enrichment failed', err);
    return 0;
  }
}

// ========================
// API Routes
// ========================

// Get dashboard stats
app.get('/api/stats', async (req, res) => {
  try {
    const stats = await db.getStats();
    const activeSignals = await db.getActiveSignals();
    const floatingPnl = await enrichWithRealtimeData(activeSignals);
    
    stats.floatingPnl = floatingPnl.toFixed(4);
    stats.realTimePnl = (parseFloat(stats.totalPnl) + floatingPnl).toFixed(4);
    
    stats.dryRun = config.trading.dryRun;
    stats.autoTrade = config.trading.autoTrade;
    stats.tradeAmount = config.trading.tradeAmountUsdt;
    stats.minScore = config.trading.minScore;
    res.json(stats);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get all signals
app.get('/api/signals', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 50;
    const signals = await db.getAllSignals(limit);
    await enrichWithRealtimeData(signals);
    res.json(signals);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get active signals
app.get('/api/signals/active', async (req, res) => {
  try {
    const signals = await db.getActiveSignals();
    await enrichWithRealtimeData(signals);
    res.json(signals);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get trades for a signal
app.get('/api/signals/:id/trades', async (req, res) => {
  try {
    const trades = await db.getTradesBySignalId(parseInt(req.params.id));
    res.json(trades);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get all trades
app.get('/api/trades', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 100;
    const trades = await db.getAllTrades(limit);
    res.json(trades);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get open trades
app.get('/api/trades/open', async (req, res) => {
  try {
    const trades = await db.getOpenTrades();
    res.json(trades);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get activity log
app.get('/api/activity', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 30;
    const activities = await db.getRecentActivities(limit);
    res.json(activities);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get MEXC balance (if connected)
app.get('/api/balance', async (req, res) => {
  try {
    if (config.trading.dryRun) {
      return res.json({ free: '1000.00', locked: '0.00', isDryRun: true });
    }
    const balance = await mexc.getUsdtBalance();
    res.json({ ...balance, isDryRun: false });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get config (safe fields only)
app.get('/api/config', (req, res) => {
  res.json({
    dryRun: config.trading.dryRun,
    autoTrade: config.trading.autoTrade,
    tradeAmountUsdt: config.trading.tradeAmountUsdt,
    minScore: config.trading.minScore,
    tp1Percent: config.risk.tp1Percent,
    tp2Percent: config.risk.tp2Percent,
    tp3Percent: config.risk.tp3Percent,
    tp4Percent: config.risk.tp4Percent,
  });
});

// Update settings
app.post('/api/settings', async (req, res) => {
  try {
    const settings = req.body;
    
    // Update each setting in DB
    for (const [key, value] of Object.entries(settings)) {
      await db.updateSetting(key, value);
    }
    
    // Reload config in memory
    await config.reload();
    
    // Sync bot state (start/stop monitors)
    try {
      const { syncBotState } = require('../index');
      await syncBotState();
    } catch (syncErr) {
      logger.error('Failed to sync bot state after settings update', syncErr);
    }
    
    await db.logActivity('SYSTEM', 'Bot settings updated via dashboard');
    res.json({ success: true, message: 'Settings updated successfully' });
  } catch (err) {
    logger.error('Failed to update settings:', err);
    res.status(500).json({ error: err.message });
  }
});

// Serve dashboard
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

/**
 * Start the dashboard server
 */
function startDashboard() {
  const port = config.dashboard.port;
  app.listen(port, '0.0.0.0', async () => {
    logger.info(`🖥️  Dashboard running at http://localhost:${port}`);
    await db.logActivity('SYSTEM', `Dashboard started on port ${port}`);
  });
}

module.exports = { app, startDashboard };

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

// Optional API authentication — set DASHBOARD_TOKEN env var to enable
const DASHBOARD_TOKEN = process.env.DASHBOARD_TOKEN;
if (DASHBOARD_TOKEN) {
  app.use('/api', (req, res, next) => {
    const auth = req.headers.authorization;
    if (auth !== `Bearer ${DASHBOARD_TOKEN}`) {
      return res.status(401).json({ error: 'Unauthorized — provide Bearer token' });
    }
    next();
  });
  logger.info('🔒 Dashboard API authentication enabled');
}

// Helper to get real-time prices and reached targets for active signals
async function enrichWithRealtimeData(signals) {
  if (!signals || signals.length === 0) return 0;
  
  try {
    const pricesData = await mexc.getAllPrices();
    const priceMap = new Map(pricesData.map(p => [p.symbol, parseFloat(p.price)]));
    
    let totalFloatingPnl = 0;
    const amount = parseFloat(config.trading.tradeAmountUsdt) || 10;

    // Process all signals in parallel for better performance
    await Promise.all(signals.map(async (sig) => {
      const currentPrice = priceMap.get(sig.symbol);
      
      // Get reached targets from trades table
      const trades = await db.getTradesBySignalId(sig.id);
      sig.reached_targets = trades
        .filter(t => t.side === 'SELL' && (t.status === 'FILLED' || t.status === 'SIMULATED'))
        .map(t => t.target_label)
        .filter(label => label && label.startsWith('TP'));

      if (currentPrice && sig.entry_price) {
        const pnlPercent = ((currentPrice - sig.entry_price) / sig.entry_price) * 100;
        
        // Calculate remaining quantity: Sum(BUYS) - Sum(SELLS)
        const totalBought = trades
          .filter(t => t.side === 'BUY' && (t.status === 'FILLED' || t.status === 'SIMULATED'))
          .reduce((sum, t) => sum + parseFloat(t.quantity || 0), 0);
          
        const totalSold = trades
          .filter(t => t.side === 'SELL' && (t.status === 'FILLED' || t.status === 'SIMULATED'))
          .reduce((sum, t) => sum + parseFloat(t.quantity || 0), 0);
          
        const remainingQty = Math.max(0, totalBought - totalSold);
        const currentValueUsdt = remainingQty * currentPrice;
        
        // P&L USDT should be based on initial investment for context
        const pnlUsdt = (pnlPercent / 100) * amount;

        sig.current_price = currentPrice;
        sig.floating_pnl_percent = pnlPercent.toFixed(2);
        sig.floating_pnl_usdt = pnlUsdt.toFixed(2);
        sig.current_value_usdt = currentValueUsdt.toFixed(2);
        sig.remaining_qty = remainingQty.toFixed(remainingQty < 1 ? 6 : 2);
        
        if (sig.status === 'ACTIVE' || sig.status === 'PARTIALLY_FILLED' || sig.status === 'NEW') {
           totalFloatingPnl += pnlUsdt;
        }
      }
    }));
    
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
      return res.json({ free: '1000.00', locked: '0.00', estimated: '1000.00', isDryRun: true });
    }
    const estBalance = await mexc.getEstimatedBalance();
    res.json({
      free: estBalance.freeUsdt.toFixed(2),
      locked: estBalance.lockedUsdt.toFixed(2),
      estimated: estBalance.estimated.toFixed(2),
      isDryRun: false
    });
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

// Close a signal/trade manually
app.post('/api/signals/:id/close', async (req, res) => {
  try {
    const { manualCloseSignal } = require('../trading/priceMonitor');
    const result = await manualCloseSignal(parseInt(req.params.id));
    res.json(result);
  } catch (err) {
    logger.error(`Failed to close signal ${req.params.id} manually:`, err);
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

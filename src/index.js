const config = require('./config');
const logger = require('./utils/logger');
const db = require('./database/db');
const telegramBot = require('./telegram/bot');
const tradeManager = require('./trading/tradeManager');
const priceMonitor = require('./trading/priceMonitor');
const { startDashboard } = require('./dashboard/server');
const fs = require('fs');
const path = require('path');

// Fix MaxListenersExceededWarning from GramJS library
require('events').EventEmitter.defaultMaxListeners = 0;

// =============================================
// 🤖 Shaabane Signals Trading Bot
// =============================================

async function main() {
  console.log(`
  ╔═══════════════════════════════════════════════╗
  ║   🤖 Shaabane Signals Trading Bot v1.0        ║
  ║   📡 Telegram: @shaabane_signals              ║
  ║   💹 Exchange: MEXC Spot                      ║
  ╚═══════════════════════════════════════════════╝
  `);

  // Ensure data directory exists
  const dataDir = path.join(__dirname, '../data');
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  // Step 1: Initialize database
  logger.info('🔄 Initializing database...');
  await db.initDatabase();

  // Load dynamic settings from DB
  await config.reload();

  // Step 2: Show config summary
  logger.info('⚙️ Configuration:', {
    dryRun: config.trading.dryRun,
    autoTrade: config.trading.autoTrade,
    tradeAmount: config.trading.tradeAmountUsdt,
    minScore: config.trading.minScore,
    dashboardPort: config.dashboard.port,
  });

  if (config.trading.dryRun) {
    logger.warn('🧪 DRY RUN mode is ENABLED — No real trades will be executed');
  } else {
    logger.warn('💰 LIVE TRADING mode — Real money will be used!');
  }

  await db.logActivity('SYSTEM', `Bot started (DRY_RUN: ${config.trading.dryRun}, Amount: ${config.trading.tradeAmountUsdt} USDT)`);

  // Step 3: Test MEXC connectivity (if not dry run)
  if (!config.trading.dryRun && config.mexc.apiKey) {
    try {
      await require('./exchange/mexcClient').ping();
      logger.info('✅ MEXC API connectivity: OK');

      const balance = await require('./exchange/mexcClient').getUsdtBalance();
      logger.info(`💰 USDT Balance: ${balance.free} (locked: ${balance.locked})`);
      await db.logActivity('SYSTEM', `MEXC connected. USDT Balance: ${balance.free}`);
    } catch (err) {
      logger.error('❌ MEXC API connection failed', { error: err.message });
      logger.warn('⚠️ Bot will continue but trading will not work until MEXC connection is restored');
    }
  }

  // Step 4: Start Dashboard
  startDashboard();

  // Step 5: Start Telegram Bot
  logger.info('🤖 Starting Telegram listener...');
  await telegramBot.startBot(async (signal) => {
    try {
      // === CRITICAL: Save signal to database FIRST to get signal.id ===
      const result = await db.insertSignal({
        symbol: signal.symbol,
        timeframe: signal.timeframe || 'unknown',
        entry_price: signal.entry,
        stop_loss: signal.stopLoss || null,
        tp1: signal.tp1 || null,
        tp2: signal.tp2 || null,
        tp3: signal.tp3 || null,
        tp4: signal.tp4 || null,
        score: signal.score || 0,
        setup: signal.setup || '',
        status: 'NEW',
        raw_message: signal.raw_message || '',
        telegram_msg_id: signal.telegram_msg_id || null,
      });
 
      // Set the database ID on the signal object
      signal.id = result.lastInsertRowid;
      logger.info(`📝 Signal saved to DB with ID: ${signal.id}`);
      
      // Now pass to trade manager with proper ID
      await tradeManager.handleSignal(signal);
    } catch (err) {
      logger.error('❌ Error saving signal to database', { error: err.message });
    }
  });

  // Step 6: Start Price Monitor
  await syncBotState();

  /**
   * Automatically close and sell positions for expired signals
   */
  const handleExpiredSignals = async () => {
    try {
      const expiredSignals = await db.cleanupStaleSignals();
      if (!expiredSignals || expiredSignals.length === 0) return;

      for (const signal of expiredSignals) {
        // Only sell if it was already entered (ACTIVE or PARTIALLY_FILLED)
        if (signal.status === 'ACTIVE' || signal.status === 'PARTIALLY_FILLED') {
          logger.info(`🚨 Auto-closing expired trade: ${signal.symbol}`);
          try {
            // Step 1: Close the signal on the exchange
            await priceMonitor.manualCloseSignal(signal.id);
            // Step 2: Update database status to EXPIRED (manualCloseSignal -> handleStopLoss sets it to STOPPED)
            await db.updateSignalStatus(signal.id, 'EXPIRED');
            
            await db.logActivity('SYSTEM', `Auto-closed expired trade: ${signal.symbol} and set status to EXPIRED`);
          } catch (err) {
            logger.error(`❌ Failed to auto-close expired trade: ${signal.symbol}`, { error: err.message });
          }
        } else if (signal.status === 'NEW') {
          // If it was NEW, it just never reached entry, so we just set it to EXPIRED
          logger.info(`🕰️ Pending signal expired without entering: ${signal.symbol}`);
          await db.updateSignalStatus(signal.id, 'EXPIRED');
          await db.logActivity('SYSTEM', `Pending signal expired without entering: ${signal.symbol}`);
        }
      }
    } catch (err) {
      logger.error('Error handling expired signals', { error: err.message });
    }
  };

  /**
   * Scan for any already EXPIRED signals on startup that have remaining open positions,
   * and force close them on the exchange.
   */
  const recoverStuckExpiredSignals = async () => {
    try {
      logger.info('🔍 Running startup recovery check for stuck EXPIRED signals...');
      
      const { data: expiredSignals, error } = await db.supabase
        .from('bot_signals')
        .select('*')
        .eq('status', 'EXPIRED');

      if (error) {
        logger.error('❌ Failed to fetch EXPIRED signals for recovery check', error);
        return;
      }

      if (!expiredSignals || expiredSignals.length === 0) {
        logger.info('✅ No EXPIRED signals found to recover.');
        return;
      }

      logger.info(`🔍 Found ${expiredSignals.length} EXPIRED signals. Checking for remaining quantities...`);

      for (const signal of expiredSignals) {
        const trades = await db.getTradesBySignalId(signal.id);
        const buyTrades = trades.filter(t => t.side === 'BUY' && (t.status === 'FILLED' || t.status === 'PENDING' || t.status === 'SIMULATED'));
        const sellTrades = trades.filter(t => t.side === 'SELL' && (t.status === 'FILLED' || t.status === 'SIMULATED'));
        
        const totalBought = buyTrades.reduce((sum, t) => sum + parseFloat(t.quantity || 0), 0);
        const totalSold = sellTrades.reduce((sum, t) => sum + parseFloat(t.quantity || 0), 0);
        const remainingQty = Math.floor((totalBought - totalSold) * 100) / 100;

        if (remainingQty > 0.0001) {
          logger.warn(`⚠️ Stuck position detected for expired signal ${signal.symbol} (ID: ${signal.id}) | Qty: ${remainingQty}`);
          try {
            // Force manual close to place market sell order
            await priceMonitor.manualCloseSignal(signal.id, true);
            // Ensure status remains EXPIRED in the database
            await db.updateSignalStatus(signal.id, 'EXPIRED');
            logger.info(`✅ Successfully closed stuck position for: ${signal.symbol}`);
            await db.logActivity('RECOVERY', `Closed stuck position for expired signal: ${signal.symbol} | Qty: ${remainingQty}`);
          } catch (closeErr) {
            logger.error(`❌ Failed to close stuck position for: ${signal.symbol}`, { error: closeErr.message });
          }
        }
      }
      logger.info('✅ Startup recovery check completed.');
    } catch (err) {
      logger.error('Error in recoverStuckExpiredSignals', { error: err.message });
    }
  };

  // Step 7: Schedule periodic maintenance (every 6 hours)
  setInterval(async () => {
    try {
      await db.cleanupOldLogs();
      await handleExpiredSignals();
      await recoverStuckExpiredSignals();
    } catch (err) {
      logger.error('Maintenance task error', { error: err.message });
    }
  }, 6 * 60 * 60 * 1000); // 6 hours

  // Run initial cleanup and recovery on startup
  await db.cleanupOldLogs();
  await handleExpiredSignals();
  await recoverStuckExpiredSignals();

  // Graceful shutdown
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  logger.info('🚀 Bot is running! Waiting for signals...');
}

/**
 * Synchronize bot components with current config
 */
async function syncBotState() {
  const isLive = !config.trading.dryRun;
  const isAuto = config.trading.autoTrade;

  logger.info(`🔄 Bot State Sync: | Mode: ${isLive ? 'LIVE 💰' : 'DRY RUN 🧪'} | AutoTrade: ${isAuto ? 'ON' : 'OFF'}`);

  // If switching to LIVE, check MEXC connectivity if not already done
  if (isLive && config.mexc.apiKey) {
    try {
      const mexc = require('./exchange/mexcClient');
      await mexc.ping();
      const balance = await mexc.getUsdtBalance();
      logger.info(`✅ MEXC Connectivity confirmed. Balance: ${balance.free} USDT`);
    } catch (err) {
      logger.warn(`⚠️ MEXC Connectivity check failed: ${err.message}`);
    }
  }

  if (isAuto) {
    await priceMonitor.startMonitoring();
  } else {
    await priceMonitor.stopMonitoring();
  }
}

async function shutdown() {
  logger.info('🛑 Shutting down...');
  telegramBot.stopBot();
  await priceMonitor.stopMonitoring();
  await db.logActivity('SYSTEM', 'Bot stopped');
  process.exit(0);
}

// Run
main().catch((err) => {
  logger.error('Fatal error', { error: err.message, stack: err.stack });
  process.exit(1);
});

module.exports = { syncBotState };

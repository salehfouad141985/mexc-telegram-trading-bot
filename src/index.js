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
  if (config.trading.autoTrade && !config.trading.dryRun) {
    await priceMonitor.startMonitoring();
  }

  // Graceful shutdown
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  logger.info('🚀 Bot is running! Waiting for signals...');
}

function shutdown() {
  logger.info('🛑 Shutting down...');
  telegramBot.stopBot();
  priceMonitor.stopMonitoring();
  db.logActivity('SYSTEM', 'Bot stopped');
  process.exit(0);
}

// Run
main().catch((err) => {
  logger.error('Fatal error', { error: err.message, stack: err.stack });
  process.exit(1);
});

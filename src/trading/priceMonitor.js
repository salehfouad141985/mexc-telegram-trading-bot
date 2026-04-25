const config = require('../config');
const logger = require('../utils/logger');
const mexcClient = require('../exchange/mexcClient');
const tradeManager = require('./tradeManager');
const db = require('../database/db');

let monitorInterval = null;
const POLL_INTERVAL = 10000; // 10 seconds

// Track which TP targets have been logged to avoid spam
const loggedTPReached = new Map(); // signalId -> Set of TP labels

/**
 * Start price monitoring for active trades
 */
function startMonitoring() {
  if (monitorInterval) {
    logger.warn('Price monitor already running');
    return;
  }

  logger.info('📈 Price monitor started (interval: 10s)');
  db.logActivity('MONITOR', 'Price monitor started');

  monitorInterval = setInterval(async () => {
    try {
      await checkPrices();
      await tradeManager.checkOpenOrders();
    } catch (err) {
      logger.error('Price monitor error', { error: err.message });
    }
  }, POLL_INTERVAL);
}

/**
 * Stop price monitoring
 */
function stopMonitoring() {
  if (monitorInterval) {
    clearInterval(monitorInterval);
    monitorInterval = null;
    logger.info('🛑 Price monitor stopped');
    db.logActivity('MONITOR', 'Price monitor stopped');
  }
}

/**
 * Check prices and handle SL/TP triggers
 */
async function checkPrices() {
  if (config.trading.dryRun) return; // Skip for dry run

  const activeSignals = db.getActiveSignals.all();
  if (activeSignals.length === 0) return;

  for (const signal of activeSignals) {
    try {
      const currentPrice = await mexcClient.getSymbolPrice(signal.symbol);
      if (!currentPrice) continue;

      // Check Stop Loss
      if (signal.stop_loss && currentPrice <= signal.stop_loss) {
        logger.warn(`🔴 STOP LOSS triggered: ${signal.symbol} @ $${currentPrice} (SL: $${signal.stop_loss})`);
        await handleStopLoss(signal, currentPrice);
        continue; // Don't check TPs if SL was triggered
      }

      // Check Take Profits (log only once per target)
      const targets = [
        { label: 'TP1', price: signal.tp1 },
        { label: 'TP2', price: signal.tp2 },
        { label: 'TP3', price: signal.tp3 },
        { label: 'TP4', price: signal.tp4 },
      ];

      // Initialize tracking set for this signal if not exists
      if (!loggedTPReached.has(signal.id)) {
        loggedTPReached.set(signal.id, new Set());
      }
      const logged = loggedTPReached.get(signal.id);

      for (const tp of targets) {
        if (tp.price && currentPrice >= tp.price && !logged.has(tp.label)) {
          logged.add(tp.label);
          logger.info(`🎯 ${tp.label} reached: ${signal.symbol} @ $${currentPrice} (Target: $${tp.price})`);
          db.logActivity('TP_REACHED', `${tp.label} reached: ${signal.symbol} @ $${currentPrice}`);
        }
      }

      // If all TPs reached, mark signal as completed
      const allTPsReached = targets.every(tp => !tp.price || logged.has(tp.label));
      if (allTPsReached && targets.some(tp => tp.price)) {
        db.updateSignalStatus.run({ id: signal.id, status: 'COMPLETED' });
        loggedTPReached.delete(signal.id);
        logger.info(`🏆 All targets reached! Signal completed: ${signal.symbol}`);
        db.logActivity('COMPLETED', `All targets reached: ${signal.symbol}`);
      }

    } catch (err) {
      // Throttle errors — don't spam logs
      if (!err.message.includes('429')) {
        logger.error(`Price check failed: ${signal.symbol}`, { error: err.message });
      }
    }
  }
}

/**
 * Handle stop loss trigger — cancel open TP orders and market sell
 */
async function handleStopLoss(signal, currentPrice) {
  try {
    // Cancel all open sell orders for this signal
    const trades = db.getTradesBySignalId.all(signal.id);
    for (const trade of trades) {
      if (trade.side === 'SELL' && trade.status === 'PENDING' && trade.mexc_order_id) {
        try {
          await mexcClient.cancelOrder(signal.symbol, trade.mexc_order_id);
          db.updateTradeStatus.run({
            id: trade.id,
            status: 'CANCELED',
            executed_price: 0,
            executed_qty: 0,
            pnl: 0,
            pnl_percent: 0,
          });
          logger.info(`❎ Cancelled TP order: ${trade.target_label} for ${signal.symbol}`);
        } catch (cancelErr) {
          logger.error(`Failed to cancel TP order on SL`, { error: cancelErr.message });
        }
      }
    }

    // Market sell remaining position — look for BUY orders with ANY filled status
    const entryTrade = trades.find((t) => t.side === 'BUY' && (t.status === 'FILLED' || t.status === 'PENDING'));
    if (entryTrade) {
      const remainingQty = entryTrade.quantity;

      try {
        // First check if we actually hold the token
        const balance = await mexcClient.getAccountInfo();
        const tokenSymbol = signal.symbol.replace('USDT', '');
        const tokenBalance = balance.balances?.find(b => b.asset === tokenSymbol);
        const freeQty = tokenBalance ? parseFloat(tokenBalance.free) : 0;

        if (freeQty > 0) {
          const sellQty = Math.min(remainingQty, freeQty);
          
          await mexcClient.createOrder({
            symbol: signal.symbol,
            side: 'SELL',
            type: 'MARKET',
            quantity: sellQty,
          });

          const pnl = (currentPrice - signal.entry_price) * sellQty;
          logger.warn(`🔴 SL SELL executed: ${signal.symbol} | Qty: ${sellQty} | Loss: $${pnl.toFixed(4)}`);
          db.logActivity('SL_EXECUTED', `Stop loss executed: ${signal.symbol} Qty: ${sellQty} Loss: $${pnl.toFixed(4)}`);
        } else {
          logger.warn(`⚠️ No ${tokenSymbol} balance to sell for SL`);
        }
      } catch (sellErr) {
        logger.error('Failed to execute SL sell', { error: sellErr.message });
      }
    }

    db.updateSignalStatus.run({ id: signal.id, status: 'STOPPED' });
    loggedTPReached.delete(signal.id); // Clean up tracking

  } catch (err) {
    logger.error('Failed to handle stop loss', { error: err.message });
  }
}

module.exports = {
  startMonitoring,
  stopMonitoring,
};

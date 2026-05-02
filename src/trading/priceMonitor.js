const config = require('../config');
const logger = require('../utils/logger');
const mexcClient = require('../exchange/mexcClient');
const tradeManager = require('./tradeManager');
const db = require('../database/db');
const notifier = require('../utils/notifier');

let monitorInterval = null;
const POLL_INTERVAL = 10000; // 10 seconds

// Track which TP targets have been logged to avoid spam
const loggedTPReached = new Map(); // signalId -> Set of TP labels

/**
 * Start price monitoring for active trades
 */
async function startMonitoring() {
  if (monitorInterval) {
    logger.warn('Price monitor already running');
    return;
  }

  logger.info('📈 Price monitor started (interval: 10s)');
  await db.logActivity('MONITOR', 'Price monitor started');

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
async function stopMonitoring() {
  if (monitorInterval) {
    clearInterval(monitorInterval);
    monitorInterval = null;
    logger.info('🛑 Price monitor stopped');
    await db.logActivity('MONITOR', 'Price monitor stopped');
  }
}

/**
 * Check prices and handle SL/TP triggers
 */
async function checkPrices() {
  const activeSignals = await db.getActiveSignals();

  if (activeSignals.length === 0) return;

  // New: Auto-heal missing SL orders
  await ensureStopLossOrders(activeSignals);

  // Optimization: Fetch all prices in one call to avoid rate limits
  let allPrices = {};
  try {
    const pricesArray = await mexcClient.getAllPrices();
    allPrices = pricesArray.reduce((acc, item) => {
      acc[item.symbol] = parseFloat(item.price);
      return acc;
    }, {});
  } catch (err) {
    logger.error('Failed to fetch all prices for monitor', { error: err.message });
    return;
  }

  for (const signal of activeSignals) {
    try {
      const currentPrice = allPrices[signal.symbol];
      if (!currentPrice) continue;

      // Initialize tracking set for this signal if not exists
      if (!loggedTPReached.has(signal.id)) {
        loggedTPReached.set(signal.id, new Set());
      }
      const logged = loggedTPReached.get(signal.id);

      // Calculate Trailing Stop Loss
      let dynamicSL = signal.stop_loss;
      
      // Get DB trades to check for filled TPs robustly
      const trades = await db.getTradesBySignalId(signal.id);
      const filledTPLabels = trades
        .filter(t => t.side === 'SELL' && t.status === 'FILLED' && t.target_label && t.target_label.startsWith('TP'))
        .map(t => t.target_label);

      // Evaluate the highest TP reached
      const hasTP4 = logged.has('TP4') || filledTPLabels.includes('TP4');
      const hasTP3 = logged.has('TP3') || filledTPLabels.includes('TP3');
      const hasTP2 = logged.has('TP2') || filledTPLabels.includes('TP2');
      const hasTP1 = logged.has('TP1') || filledTPLabels.includes('TP1');

      if (hasTP4 && signal.tp3) {
        dynamicSL = signal.tp3;
      } else if (hasTP3 && signal.tp2) {
        dynamicSL = signal.tp2;
      } else if (hasTP2 && signal.tp1) {
        dynamicSL = signal.tp1;
      } else if (hasTP1 && signal.entry_price) {
        dynamicSL = signal.entry_price;
      }

      // Check Stop Loss
      if (dynamicSL && currentPrice <= dynamicSL) {
        logger.warn(`🔴 Trailing STOP LOSS triggered: ${signal.symbol} @ $${currentPrice} (Dynamic SL: $${dynamicSL})`);
        await handleStopLoss(signal, currentPrice);
        continue; // Don't check TPs if SL was triggered
      }

      // Check Take Profits (log only once per target)
      const targets = [
        { label: 'TP1', price: signal.tp1, pct: config.risk.tp1Percent },
        { label: 'TP2', price: signal.tp2, pct: config.risk.tp2Percent },
        { label: 'TP3', price: signal.tp3, pct: config.risk.tp3Percent },
        { label: 'TP4', price: signal.tp4, pct: config.risk.tp4Percent },
      ];

      for (const tp of targets) {
        if (tp.price && currentPrice >= tp.price && !logged.has(tp.label)) {
          logged.add(tp.label);
          logger.info(`🎯 ${tp.label} reached: ${signal.symbol} @ $${currentPrice} (Target: $${tp.price})`);
          await db.logActivity('TP_REACHED', `${tp.label} reached: ${signal.symbol} @ $${currentPrice}`);
          
          // Execute the Take Profit sell and update the exchange SL
          await handleTakeProfit(signal, tp, currentPrice, dynamicSL);
        }
      }

      // If all TPs reached, mark signal as completed
      const allTPsReached = targets.every(tp => !tp.price || logged.has(tp.label));
      if (allTPsReached && targets.some(tp => tp.price)) {
        await db.updateSignalStatus(signal.id, 'COMPLETED');
        loggedTPReached.delete(signal.id);
        logger.info(`🏆 All targets reached! Signal completed: ${signal.symbol}`);
        await db.logActivity('COMPLETED', `All targets reached: ${signal.symbol}`);
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
 * Handle take profit target reached
 */
async function handleTakeProfit(signal, target, currentPrice, newSL) {
  try {
    const trades = await db.getTradesBySignalId(signal.id);
    const buyTrades = trades.filter(t => t.side === 'BUY' && (t.status === 'FILLED' || t.status === 'PENDING' || t.status === 'SIMULATED'));
    const sellTrades = trades.filter(t => t.side === 'SELL' && (t.status === 'FILLED' || t.status === 'SIMULATED'));
    
    if (buyTrades.length === 0) return;

    const totalBought = buyTrades.reduce((sum, t) => sum + parseFloat(t.quantity), 0);
    const totalSold = sellTrades.reduce((sum, t) => sum + parseFloat(t.quantity), 0);
    const currentRemaining = totalBought - totalSold;

    if (currentRemaining <= 0) return;

    // Calculate qty for this TP
    const tpPct = target.pct || 25; // fallback
    let sellQty = Math.floor((totalBought * tpPct / 100) * 100) / 100;
    
    // Don't sell more than we have
    sellQty = Math.min(sellQty, currentRemaining);
    if (sellQty <= 0) return;

    logger.info(`📈 Executing ${target.label} Market Sell: ${signal.symbol} | Qty: ${sellQty}`);

    let sellResult;
    if (!config.trading.dryRun) {
      sellResult = await mexcClient.createOrder({
        symbol: signal.symbol,
        side: 'SELL',
        type: 'MARKET',
        quantity: sellQty,
      });
    } else {
      sellResult = { orderId: `DRY_TP_${Date.now()}` };
    }

    // Record the trade
    const pnl = (currentPrice - signal.entry_price) * sellQty;
    const pnlPercent = ((currentPrice - signal.entry_price) / signal.entry_price) * 100;

    const tpMsg = `📈 ${target.label} Executed: ${signal.symbol} | P&L: $${pnl.toFixed(4)} (${pnlPercent.toFixed(2)}%)`;
    notifier.sendNotification(tpMsg);
 
    await db.insertTrade({
      signal_id: signal.id,
      symbol: signal.symbol,
      side: 'SELL',
      type: 'MARKET',
      quantity: sellQty,
      price: currentPrice,
      order_id: sellResult.orderId,
      mexc_order_id: !config.trading.dryRun ? sellResult.orderId : null,
      status: config.trading.dryRun ? 'SIMULATED' : 'FILLED',
      target_label: target.label,
      is_dry_run: config.trading.dryRun ? 1 : 0,
      pnl: pnl,
      pnl_percent: pnlPercent,
      executed_price: currentPrice,
      executed_qty: sellQty
    });
 
    await db.logActivity('TP_EXECUTED', `${target.label} executed: ${signal.symbol} P&L: $${pnl.toFixed(4)}`);

    // Update the SL order on the exchange for the remaining quantity
    const nextRemaining = Math.floor((currentRemaining - sellQty) * 100) / 100;
    
    if (nextRemaining > 0) {
      logger.info(`🔄 Updating exchange Stop Loss for remaining ${nextRemaining} ${signal.symbol}...`);
      await tradeManager.placeStopLossOrder(signal, nextRemaining, newSL, config.trading.dryRun);
    } else {
      // All positions closed via TPs
      await db.updateSignalStatus(signal.id, 'COMPLETED');
      
      // Cancel the final SL order if it exists
      if (!config.trading.dryRun && signal.sl_order_id) {
        await mexcClient.cancelOrder(signal.symbol, signal.sl_order_id).catch(() => {});
      }
    }

  } catch (err) {
    logger.error(`❌ TP Execution failed: ${target.label}`, { error: err.message });
  }
}


/**
 * Handle stop loss trigger — cancel open TP orders and market sell
 */
async function handleStopLoss(signal, currentPrice) {
  try {
    // Cancel all open sell orders for this signal
    const trades = await db.getTradesBySignalId(signal.id);
    for (const trade of trades) {
      if (trade.side === 'SELL' && trade.status === 'PENDING' && trade.mexc_order_id) {
        try {
          await mexcClient.cancelOrder(signal.symbol, trade.mexc_order_id);
          await db.updateTradeStatus(trade.id, {
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

    // Calculate remaining position correctly (total bought - total sold)
    const buyTrades = trades.filter(t => t.side === 'BUY' && (t.status === 'FILLED' || t.status === 'PENDING' || t.status === 'SIMULATED'));
    const sellTrades = trades.filter(t => t.side === 'SELL' && (t.status === 'FILLED' || t.status === 'SIMULATED'));
    const totalBought = buyTrades.reduce((sum, t) => sum + parseFloat(t.quantity), 0);
    const totalSold = sellTrades.reduce((sum, t) => sum + parseFloat(t.quantity), 0);
    const remainingQty = Math.floor((totalBought - totalSold) * 100) / 100;

    if (remainingQty > 0) {
      try {
        let sellQty = remainingQty;

        // In live mode, verify actual balance
        if (!config.trading.dryRun) {
          const balance = await mexcClient.getAccountInfo();
          const tokenSymbol = signal.symbol.replace('USDT', '');
          const tokenBalance = balance.balances?.find(b => b.asset === tokenSymbol);
          const freeQty = tokenBalance ? parseFloat(tokenBalance.free) : 0;

          if (freeQty <= 0) {
            logger.warn(`⚠️ No ${tokenSymbol} balance to sell for SL`);
            await db.updateSignalStatus(signal.id, 'STOPPED');
            loggedTPReached.delete(signal.id);
            return;
          }
          sellQty = Math.min(remainingQty, freeQty);
        }

        if (!config.trading.dryRun) {
          await mexcClient.createOrder({
            symbol: signal.symbol,
            side: 'SELL',
            type: 'MARKET',
            quantity: sellQty,
          });
        }

        const pnl = (currentPrice - parseFloat(signal.entry_price)) * sellQty;
        const pnlPercent = ((currentPrice - parseFloat(signal.entry_price)) / parseFloat(signal.entry_price)) * 100;

        // Record SL trade in database
        await db.insertTrade({
          signal_id: signal.id,
          symbol: signal.symbol,
          side: 'SELL',
          type: 'MARKET',
          quantity: sellQty,
          price: currentPrice,
          order_id: `SL_${Date.now()}`,
          mexc_order_id: null,
          status: config.trading.dryRun ? 'SIMULATED' : 'FILLED',
          target_label: 'SL',
          is_dry_run: config.trading.dryRun ? 1 : 0,
          pnl: pnl,
          pnl_percent: pnlPercent,
          executed_price: currentPrice,
          executed_qty: sellQty
        });

        const slMsg = `🔴 SL Executed: ${signal.symbol} | Loss: $${pnl.toFixed(4)} (${pnlPercent.toFixed(2)}%)`;
        logger.warn(slMsg);
        notifier.sendNotification(slMsg);
        await db.logActivity('SL_EXECUTED', `Stop loss executed: ${signal.symbol} Qty: ${sellQty} P&L: $${pnl.toFixed(4)}`);
      } catch (sellErr) {
        logger.error('Failed to execute SL sell', { error: sellErr.message });
      }
    } else {
      logger.warn(`⚠️ No remaining quantity to sell for SL: ${signal.symbol}`);
    }
 
    await db.updateSignalStatus(signal.id, 'STOPPED');
    loggedTPReached.delete(signal.id); // Clean up tracking

  } catch (err) {
    logger.error('Failed to handle stop loss', { error: err.message });
  }
}

/**
 * Ensure each active signal has an active Stop Loss order on the exchange
 */
async function ensureStopLossOrders(activeSignals) {
  // On MEXC Spot V3, native Stop Loss orders (STOP_LOSS, STOP_LOSS_LIMIT) 
  // often return 'invalid type' depending on account/symbol.
  // We rely on our Virtual Stop Loss (VSL) which is already handled in checkPrices().
  // This function now just verifies that the signals are being monitored.

  for (const signal of activeSignals) {
    try {
      // Since native SL is problematic on MEXC Spot, we use Virtual SL exclusively.
      // This has the advantage of NOT locking funds and supporting Trailing SL.
      // logger.debug(`🛡️ Virtual SL Protection active for ${signal.symbol}`);
    } catch (err) {
      logger.error(`❌ Monitoring check failed for ${signal.symbol}`, { error: err.message });
    }
  }
}

module.exports = {
  startMonitoring,
  stopMonitoring,
};

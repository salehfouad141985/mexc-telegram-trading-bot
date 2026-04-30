const config = require('../config');
const logger = require('../utils/logger');
const mexcClient = require('../exchange/mexcClient');
const db = require('../database/db');
const notifier = require('../utils/notifier');

class TradeManager {
  constructor() {
    this.activeTrades = new Map(); // signalId -> trade info
  }

  /**
   * Handle a new signal from Telegram
   * @param {object} signal - Parsed signal object
   */
  async handleSignal(signal) {
    try {
      // Send notification about new signal
      notifier.sendNotification(`🎯 *New Signal*: ${signal.symbol}\nScore: ${signal.score}\nEntry: ${signal.entry}`);

      // Check minimum score filter
      if (signal.score && signal.score < config.trading.minScore) {
        logger.info(`⏭️ Signal skipped (score ${signal.score} < ${config.trading.minScore}): ${signal.symbol}`);
        db.logActivity('SKIP', `Signal skipped (low score): ${signal.symbol} Score: ${signal.score}`);
        db.updateSignalStatus.run({ id: signal.id, status: 'SKIPPED' });
        return;
      }

      // Check auto trade is enabled
      if (!config.trading.autoTrade) {
        logger.info(`⏸️ Auto trade disabled. Signal saved: ${signal.symbol}`);
        db.logActivity('SAVED', `Signal saved (auto trade off): ${signal.symbol}`);
        return;
      }

      // Check if we already have an active signal for this symbol
      const activeSignals = db.getActiveSignals.all();
      const existingActive = activeSignals.find(s => s.symbol === signal.symbol && s.id !== signal.id);
      if (existingActive) {
        logger.info(`⏭️ Skipping duplicate — already have an active signal for ${signal.symbol} (ID: ${existingActive.id})`);
        db.logActivity('SKIP', `Duplicate signal skipped: ${signal.symbol} (existing ID: ${existingActive.id})`);
        db.updateSignalStatus.run({ id: signal.id, status: 'DUPLICATE' });
        return;
      }

      // Execute the trade
      await this.executeTrade(signal);
    } catch (err) {
      logger.error('❌ Error handling signal', { error: err.message, signal: signal.symbol });
      db.logActivity('ERROR', `Failed to handle signal: ${signal.symbol} - ${err.message}`);
    }
  }

  /**
   * Execute a trade based on a signal
   */
  async executeTrade(signal) {
    const isDryRun = config.trading.dryRun;
    const tradeAmount = config.trading.tradeAmountUsdt;

    logger.info(`${isDryRun ? '🧪 [DRY RUN]' : '💰 [LIVE]'} Processing trade: ${signal.symbol}`, {
      entry: signal.entry,
      sl: signal.stopLoss,
      amount: tradeAmount,
    });

    try {
      // Step 1: Check if symbol is available on MEXC
      if (!isDryRun) {
        const isAvailable = await mexcClient.isSymbolAvailable(signal.symbol);
        if (!isAvailable) {
          logger.warn(`⚠️ Symbol not available on MEXC: ${signal.symbol}`);
          db.logActivity('UNAVAILABLE', `Symbol not on MEXC: ${signal.symbol}`);
          db.updateSignalStatus.run({ id: signal.id, status: 'UNAVAILABLE' });
          return;
        }
      }

      // Step 2: Check USDT balance
      if (!isDryRun) {
        const balance = await mexcClient.getUsdtBalance();
        if (balance.free < tradeAmount) {
          logger.warn(`⚠️ Insufficient USDT balance: ${balance.free} < ${tradeAmount}`);
          db.logActivity('INSUFFICIENT', `Insufficient balance: ${balance.free} USDT`);
          db.updateSignalStatus.run({ id: signal.id, status: 'INSUFFICIENT_BALANCE' });
          return;
        }
      }

      // Step 3: Get current price and validate tolerance + spread
      let currentPrice;
      if (!isDryRun) {
        // Fetch current price and depth for spread check
        const [price, depth] = await Promise.all([
          mexcClient.getSymbolPrice(signal.symbol),
          mexcClient.getDepth(signal.symbol, 5)
        ]);
        
        currentPrice = price;

        // Spread check
        if (depth.asks && depth.bids && depth.asks.length > 0 && depth.bids.length > 0) {
          const bestAsk = parseFloat(depth.asks[0][0]);
          const bestBid = parseFloat(depth.bids[0][0]);
          const spread = ((bestAsk - bestBid) / bestBid) * 100;
          
          if (spread > config.trading.maxSpreadPercent) {
            const msg = `⚠️ High spread detected for ${signal.symbol}: ${spread.toFixed(2)}% > ${config.trading.maxSpreadPercent}%`;
            logger.warn(msg);
            notifier.sendNotification(msg);
            db.logActivity('SKIP', `High spread: ${signal.symbol} ${spread.toFixed(2)}%`);
            db.updateSignalStatus.run({ id: signal.id, status: 'SKIPPED_HIGH_SPREAD' });
            return;
          }
          logger.info(`📊 Spread for ${signal.symbol}: ${spread.toFixed(2)}% (OK)`);
        }
      } else {
        currentPrice = await mexcClient.getSymbolPrice(signal.symbol);
        if (!currentPrice) currentPrice = signal.entry;
      }
      
      const maxAllowedPrice = signal.entry * 1.005; // 0.5% above entry
      
      if (currentPrice > maxAllowedPrice) {
        const msg = `⚠️ Current price ($${currentPrice}) is > 0.5% above entry ($${signal.entry}). Skipping ${signal.symbol}.`;
        logger.warn(msg);
        notifier.sendNotification(msg);
        db.logActivity('SKIP', `Price too high: ${signal.symbol} @ $${currentPrice} (max: $${maxAllowedPrice.toFixed(4)})`);
        db.updateSignalStatus.run({ id: signal.id, status: 'SKIPPED_HIGH_PRICE' });
        return;
      }

      // Step 4: Calculate exact quantity based on current market price
      let quantity;
      if (!isDryRun) {
        // Estimate quantity using current price for database tracking
        const calcResult = await mexcClient.calculateQuantity(signal.symbol, tradeAmount);
        quantity = calcResult.quantity;
      } else {
        quantity = tradeAmount / currentPrice;
        quantity = Math.floor(quantity * 100) / 100;
      }

      if (!quantity || quantity <= 0) {
        logger.warn(`⚠️ Calculated quantity is 0 for ${signal.symbol}`);
        db.updateSignalStatus.run({ id: signal.id, status: 'INVALID_QUANTITY' });
        return;
      }

      // Step 5: Place MARKET BUY order
      let buyOrderResult;
      if (!isDryRun) {
        buyOrderResult = await mexcClient.createOrder({
          symbol: signal.symbol,
          side: 'BUY',
          type: 'MARKET',
          quoteOrderQty: tradeAmount, // Use quoteOrderQty for MARKET BUY on MEXC
        });
      } else {
        // Simulate order
        buyOrderResult = {
          symbol: signal.symbol,
          orderId: `DRY_${Date.now()}`,
          price: currentPrice.toString(),
          origQty: quantity.toString(),
          type: 'MARKET',
          side: 'BUY',
          status: 'NEW',
        };
      }

      // Save entry trade
      const entryTradeResult = db.insertTrade.run({
        signal_id: signal.id,
        symbol: signal.symbol,
        side: 'BUY',
        type: 'MARKET',
        quantity: quantity,
        price: currentPrice,
        order_id: buyOrderResult.orderId || `DRY_${Date.now()}`,
        mexc_order_id: buyOrderResult.orderId || null,
        status: isDryRun ? 'SIMULATED' : 'PENDING',
        target_label: 'ENTRY',
        is_dry_run: isDryRun ? 1 : 0,
      });

      db.updateSignalStatus.run({ id: signal.id, status: 'ACTIVE' });

      const msg = `${isDryRun ? '🧪' : '✅'} BUY order placed: ${signal.symbol} | Qty: ${quantity} @ $${signal.entry}`;
      logger.info(msg);
      notifier.sendNotification(msg);
      db.logActivity('TRADE', msg, {
        orderId: buyOrderResult.orderId,
        symbol: signal.symbol,
        quantity,
        price: signal.entry,
        isDryRun,
      });

      // Step 5: Wait for BUY order to be filled, then place Stop Loss and TP orders
      if (!isDryRun) {
        logger.info(`⏳ Waiting for BUY order to fill before placing exchange-side SL...`);
        await this.waitForFillAndPlaceTargets(signal, buyOrderResult.orderId, quantity);
      } else {
        // In dry run, we just simulate the setup
        await this.placeStopLossOrder(signal, quantity, signal.stopLoss, true);
        await this.placeTargetOrders(signal, quantity, true);
      }

      // Store active trade for monitoring
      this.activeTrades.set(signal.id, {
        signal,
        entryOrderId: buyOrderResult.orderId,
        quantity,
        entryTradeId: entryTradeResult.lastInsertRowid,
        status: 'ACTIVE',
      });

    } catch (err) {
      logger.error(`❌ Trade execution failed: ${signal.symbol}`, { error: err.message });
      db.logActivity('ERROR', `Trade failed: ${signal.symbol} - ${err.message}`);
      if (signal.id) {
        db.updateSignalStatus.run({ id: signal.id, status: 'ERROR' });
      }
    }
  }

  /**
   * Wait for buy order to fill, then place TP sell orders
   */
  async waitForFillAndPlaceTargets(signal, orderId, quantity) {
    const maxAttempts = 30;  // Try for up to 5 minutes (30 x 10s)
    
    for (let i = 0; i < maxAttempts; i++) {
      try {
        const orderStatus = await mexcClient.getOrder(signal.symbol, orderId);
        
        if (orderStatus.status === 'FILLED' || orderStatus.status === 'PARTIALLY_FILLED') {
          const filledQty = parseFloat(orderStatus.executedQty) || quantity;
          logger.info(`✅ BUY order FILLED! Qty: ${filledQty} — Now placing Stop Loss on exchange...`);
          db.logActivity('FILLED', `BUY filled: ${signal.symbol} Qty: ${filledQty}`);
          
          // Place Stop Loss order on exchange for the full quantity
          // This ensures capital protection even if the bot goes offline
          await this.placeStopLossOrder(signal, filledQty, signal.stopLoss, false);
          
          // Note: We don't place TP Limit orders here because MEXC locks funds for both.
          // priceMonitor.js will handle TP hits by cancelling the SL and selling the portion.
          return;
        } else if (orderStatus.status === 'CANCELED' || orderStatus.status === 'REJECTED') {
          logger.warn(`⚠️ BUY order ${orderStatus.status} — no TP orders will be placed`);
          db.updateSignalStatus.run({ id: signal.id, status: orderStatus.status });
          return;
        }
        
        // Order still pending, wait 10 seconds
        if (i < maxAttempts - 1) {
          await new Promise(resolve => setTimeout(resolve, 10000));
        }
      } catch (err) {
        logger.error(`Error checking buy order status (attempt ${i+1})`, { error: err.message });
      }
    }
    
    // If we get here, order didn't fill in time — DO NOT place TP orders anymore!
    logger.warn(`⚠️ BUY order not confirmed filled after ${maxAttempts} attempts — waiting for checkOpenOrders to handle it.`);
  }

  /**
   * Place a native Stop Loss Market order on MEXC
   */
  async placeStopLossOrder(signal, quantity, stopPrice, isDryRun = false) {
    if (!stopPrice) return null;

    try {
      let slResult;
      if (!isDryRun) {
        // Cancel existing SL order if any
        if (signal.sl_order_id) {
          try {
            await mexcClient.cancelOrder(signal.symbol, signal.sl_order_id);
          } catch (e) {
            // Ignore if already filled or cancelled
          }
        }

        slResult = await mexcClient.createOrder({
          symbol: signal.symbol,
          side: 'SELL',
          type: 'STOP_LOSS_MARKET',
          quantity: quantity,
          stopPrice: stopPrice,
        });
      } else {
        slResult = {
          orderId: `DRY_SL_${Date.now()}`,
          symbol: signal.symbol,
          status: 'NEW'
        };
      }

      // Save the SL order ID for future tracking/cancellation
      db.updateSlOrderId.run({ id: signal.id, sl_order_id: slResult.orderId });
      
      // Also record in trades table for tracking status
      db.insertTrade.run({
        signal_id: signal.id,
        symbol: signal.symbol,
        side: 'SELL',
        type: 'STOP_LOSS_MARKET',
        quantity: quantity,
        price: stopPrice,
        order_id: slResult.orderId,
        mexc_order_id: slResult.orderId || null,
        status: isDryRun ? 'SIMULATED' : 'PENDING',
        target_label: 'SL',
        is_dry_run: isDryRun ? 1 : 0,
      });

      const msg = `${isDryRun ? '🧪' : '🛡️'} Exchange Stop Loss placed: ${signal.symbol} @ $${stopPrice}`;
      logger.info(msg);
      db.logActivity('SL_PLACED', msg);
      
      return slResult.orderId;
    } catch (err) {
      logger.error(`❌ Failed to place Stop Loss order on exchange`, { error: err.message });
      return null;
    }
  }

  /**
   * Place take-profit sell orders at each target
   */
  async placeTargetOrders(signal, totalQuantity, isDryRun) {
    const targets = [
      { label: 'TP1', price: signal.tp1, pct: config.risk.tp1Percent },
      { label: 'TP2', price: signal.tp2, pct: config.risk.tp2Percent },
      { label: 'TP3', price: signal.tp3, pct: config.risk.tp3Percent },
      { label: 'TP4', price: signal.tp4, pct: config.risk.tp4Percent },
    ].filter((t) => t.price);

    for (const target of targets) {
      const qty = Math.floor((totalQuantity * target.pct / 100) * 100) / 100;
      if (qty <= 0) continue;

      try {
        let sellResult;
        if (!isDryRun) {
          sellResult = await mexcClient.createOrder({
            symbol: signal.symbol,
            side: 'SELL',
            type: 'LIMIT',
            quantity: qty,
            price: target.price,
          });
        } else {
          sellResult = {
            orderId: `DRY_SELL_${target.label}_${Date.now()}`,
            symbol: signal.symbol,
            side: 'SELL',
            price: target.price.toString(),
            origQty: qty.toString(),
          };
        }

        // Calculate potential PnL
        const pnl = (target.price - signal.entry) * qty;
        const pnlPercent = ((target.price - signal.entry) / signal.entry) * 100;

        db.insertTrade.run({
          signal_id: signal.id,
          symbol: signal.symbol,
          side: 'SELL',
          type: 'LIMIT',
          quantity: qty,
          price: target.price,
          order_id: sellResult.orderId,
          mexc_order_id: sellResult.orderId || null,
          status: isDryRun ? 'SIMULATED' : 'PENDING',
          target_label: target.label,
          is_dry_run: isDryRun ? 1 : 0,
        });

        const msg = `${isDryRun ? '🧪' : '📈'} ${target.label} SELL: ${signal.symbol} | ${qty} @ $${target.price} (P&L: $${pnl.toFixed(4)})`;
        logger.info(msg);
        db.logActivity('TARGET', msg, {
          target: target.label,
          price: target.price,
          qty,
          potentialPnl: pnl,
        });

      } catch (err) {
        logger.error(`Failed to place ${target.label} order`, { error: err.message });
      }
    }
  }

  /**
   * Check and update status of open orders
   */
  async checkOpenOrders() {
    if (config.trading.dryRun) return;

    const openTrades = db.getOpenTrades.all();
    for (const trade of openTrades) {
      if (trade.status === 'SIMULATED' || !trade.mexc_order_id) continue;

      try {
        const orderStatus = await mexcClient.getOrder(trade.symbol, trade.mexc_order_id);

        if (orderStatus.status === 'FILLED' && trade.status !== 'FILLED') {
          const executedPrice = parseFloat(orderStatus.price) || trade.price;
          const executedQty = parseFloat(orderStatus.executedQty) || trade.quantity;

          let pnl = 0;
          let pnlPercent = 0;

          if (trade.side === 'SELL') {
            pnl = (executedPrice - trade.signal_entry) * executedQty;
            pnlPercent = ((executedPrice - trade.signal_entry) / trade.signal_entry) * 100;
          }

          db.updateTradeStatus.run({
            id: trade.id,
            status: 'FILLED',
            executed_price: executedPrice,
            executed_qty: executedQty,
            pnl: pnl,
            pnl_percent: pnlPercent,
          });

          const emoji = pnl >= 0 ? '🟢' : '🔴';
          logger.info(`${emoji} Order FILLED: ${trade.target_label} ${trade.symbol} @ $${executedPrice} | P&L: $${pnl.toFixed(4)}`);
          db.logActivity('FILLED', `${trade.target_label} filled: ${trade.symbol} P&L: $${pnl.toFixed(4)}`);

          if (trade.target_label === 'SL') {
            db.updateSignalStatus.run({ id: trade.signal_id, status: 'STOPPED' });
            logger.warn(`🛑 Signal STOPPED due to exchange-side SL hit: ${trade.symbol}`);
          }

          if (trade.side === 'BUY' && trade.target_label === 'ENTRY') {
            const existingTPs = db.getTradesBySignalId.all(trade.signal_id).filter(t => t.side === 'SELL');
            if (existingTPs.length === 0) {
              const signal = db.getSignalById.get(trade.signal_id);
              if (signal) {
                logger.info(`🔄 Delayed ENTRY order filled for ${trade.symbol}. Placing TP orders...`);
                await this.placeTargetOrders(signal, executedQty, false);
              }
            }
          }
        } else if (orderStatus.status === 'CANCELED') {
          db.updateTradeStatus.run({
            id: trade.id,
            status: 'CANCELED',
            executed_price: 0,
            executed_qty: 0,
            pnl: 0,
            pnl_percent: 0,
          });
        }
      } catch (err) {
        logger.error(`Failed to check order ${trade.mexc_order_id}`, { error: err.message });
      }
    }
  }

  /**
   * Get map of active trades
   */
  getActiveTrades() {
    return this.activeTrades;
  }
}

module.exports = new TradeManager();

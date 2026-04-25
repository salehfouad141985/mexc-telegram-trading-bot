const config = require('../config');
const logger = require('../utils/logger');
const mexcClient = require('../exchange/mexcClient');
const db = require('../database/db');

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

      // Step 3: Calculate quantity
      let quantity, currentPrice;
      if (!isDryRun) {
        const calcResult = await mexcClient.calculateQuantity(signal.symbol, tradeAmount);
        quantity = calcResult.quantity;
        currentPrice = calcResult.price;
      } else {
        // Dry run: simulate
        currentPrice = signal.entry;
        quantity = tradeAmount / signal.entry;
        quantity = Math.floor(quantity * 100) / 100; // 2 decimal places
      }

      if (!quantity || quantity <= 0) {
        logger.warn(`⚠️ Calculated quantity is 0 for ${signal.symbol}`);
        db.updateSignalStatus.run({ id: signal.id, status: 'INVALID_QUANTITY' });
        return;
      }

      // Step 4: Place BUY order at entry price
      let buyOrderResult;
      if (!isDryRun) {
        buyOrderResult = await mexcClient.createOrder({
          symbol: signal.symbol,
          side: 'BUY',
          type: 'LIMIT',
          quantity: quantity,
          price: signal.entry,
        });
      } else {
        // Simulate order
        buyOrderResult = {
          symbol: signal.symbol,
          orderId: `DRY_${Date.now()}`,
          price: signal.entry.toString(),
          origQty: quantity.toString(),
          type: 'LIMIT',
          side: 'BUY',
          status: 'NEW',
        };
      }

      // Save entry trade
      const entryTradeResult = db.insertTrade.run({
        signal_id: signal.id,
        symbol: signal.symbol,
        side: 'BUY',
        type: 'LIMIT',
        quantity: quantity,
        price: signal.entry,
        order_id: buyOrderResult.orderId || `DRY_${Date.now()}`,
        mexc_order_id: buyOrderResult.orderId || null,
        status: isDryRun ? 'SIMULATED' : 'PENDING',
        target_label: 'ENTRY',
        is_dry_run: isDryRun ? 1 : 0,
      });

      db.updateSignalStatus.run({ id: signal.id, status: 'ACTIVE' });

      const msg = `${isDryRun ? '🧪' : '✅'} BUY order placed: ${signal.symbol} | Qty: ${quantity} @ $${signal.entry}`;
      logger.info(msg);
      db.logActivity('TRADE', msg, {
        orderId: buyOrderResult.orderId,
        symbol: signal.symbol,
        quantity,
        price: signal.entry,
        isDryRun,
      });

      // Step 5: Wait for BUY order to be filled, then place TP SELL orders
      if (!isDryRun) {
        // Wait a bit for the order to fill (market buy or limit at current price)
        logger.info(`⏳ Waiting for BUY order to fill before placing TP orders...`);
        await this.waitForFillAndPlaceTargets(signal, buyOrderResult.orderId, quantity);
      } else {
        await this.placeTargetOrders(signal, quantity, isDryRun);
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
          logger.info(`✅ BUY order FILLED! Qty: ${filledQty} — Now placing TP SELL orders...`);
          db.logActivity('FILLED', `BUY filled: ${signal.symbol} Qty: ${filledQty}`);
          
          // Place TP sell orders with the filled quantity
          await this.placeTargetOrders(signal, filledQty, false);
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
    
    // If we get here, order didn't fill in time — place TP orders anyway with original quantity
    logger.warn(`⚠️ BUY order not confirmed filled after ${maxAttempts} attempts — placing TP orders with original qty`);
    await this.placeTargetOrders(signal, quantity, false);
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

const { createClient } = require('@supabase/supabase-js');
const config = require('../config');
const logger = require('../utils/logger');

if (!config.supabase.url || !config.supabase.key) {
  logger.error('❌ Supabase credentials missing in config/env!');
}

const supabase = createClient(config.supabase.url, config.supabase.key);

/**
 * Initialize database
 */
async function initDatabase() {
  logger.info('🌐 Supabase connection established');
}

// ======================
// Signal Operations
// ======================

const signals = {
  async insert(signal) {
    const { data, error } = await supabase
      .from('bot_signals')
      .insert([{
        symbol: signal.symbol,
        timeframe: signal.timeframe,
        entry_price: signal.entry_price,
        stop_loss: signal.stop_loss,
        tp1: signal.tp1,
        tp2: signal.tp2,
        tp3: signal.tp3,
        tp4: signal.tp4,
        score: signal.score,
        setup: signal.setup,
        status: signal.status || 'NEW',
        raw_message: signal.raw_message,
        telegram_msg_id: signal.telegram_msg_id
      }])
      .select();
    
    if (error) {
      logger.error('Supabase insertSignal error', error);
      throw error;
    }
    return { lastInsertRowid: data[0].id };
  },

  async updateStatus(id, status) {
    const { error } = await supabase
      .from('bot_signals')
      .update({ status, updated_at: new Date() })
      .eq('id', id);
    if (error) logger.error('Supabase updateSignalStatus error', error);
  },

  async updateSlOrderId(id, sl_order_id) {
    const { error } = await supabase
      .from('bot_signals')
      .update({ sl_order_id, updated_at: new Date() })
      .eq('id', id);
    if (error) logger.error('Supabase updateSlOrderId error', error);
  },

  async getById(id) {
    const { data, error } = await supabase
      .from('bot_signals')
      .select('*')
      .eq('id', id)
      .single();
    if (error) return null;
    return data;
  },

  async getActive() {
    const { data, error } = await supabase
      .from('bot_signals')
      .select('*')
      .in('status', ['NEW', 'ACTIVE', 'PARTIALLY_FILLED'])
      .order('created_at', { ascending: false });
    if (error) return [];
    return data;
  },

  async getAll(limit = 50) {
    const { data, error } = await supabase
      .from('bot_signals')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(limit);
    if (error) return [];
    return data;
  },

  async getByTelegramMsgId(msgId) {
    const { data, error } = await supabase
      .from('bot_signals')
      .select('*')
      .eq('telegram_msg_id', msgId)
      .maybeSingle();
    if (error) return null;
    return data;
  }
};

// ======================
// Trade Operations
// ======================

const trades = {
  async insert(trade) {
    const { data, error } = await supabase
      .from('bot_trades')
      .insert([{
        signal_id: trade.signal_id,
        symbol: trade.symbol,
        side: trade.side,
        type: trade.type,
        quantity: trade.quantity,
        price: trade.price,
        order_id: trade.order_id,
        mexc_order_id: trade.mexc_order_id,
        status: trade.status || 'PENDING',
        target_label: trade.target_label,
        is_dry_run: !!trade.is_dry_run,
        pnl: trade.pnl || null,
        pnl_percent: trade.pnl_percent || null,
        executed_price: trade.executed_price || trade.price || null,
        executed_qty: trade.executed_qty || trade.quantity || null
      }])
      .select();
    
    if (error) {
      logger.error('Supabase insertTrade error', error);
      throw error;
    }
    return { lastInsertRowid: data[0].id };
  },

  async updateStatus(id, updateData) {
    const { error } = await supabase
      .from('bot_trades')
      .update({
        status: updateData.status,
        executed_price: updateData.executed_price,
        executed_qty: updateData.executed_qty,
        pnl: updateData.pnl,
        pnl_percent: updateData.pnl_percent,
        updated_at: new Date()
      })
      .eq('id', id);
    if (error) logger.error('Supabase updateTradeStatus error', error);
  },

  async getBySignalId(signalId) {
    const { data, error } = await supabase
      .from('bot_trades')
      .select('*')
      .eq('signal_id', signalId)
      .order('created_at', { ascending: true });
    if (error) return [];
    return data;
  },

  async getOpen() {
    // In PostgreSQL, we can use a join or just select trades with specific status
    const { data, error } = await supabase
      .from('bot_trades')
      .select('*, bot_signals(entry_price, stop_loss)')
      .in('status', ['PENDING', 'PARTIALLY_FILLED'])
      .order('created_at', { ascending: false });
    
    if (error) return [];
    
    // Flatten the result to match the expected format
    return data.map(t => ({
      ...t,
      signal_entry: t.bot_signals?.entry_price,
      signal_sl: t.bot_signals?.stop_loss
    }));
  },

  async getAll(limit = 50) {
    const { data, error } = await supabase
      .from('bot_trades')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(limit);
    if (error) return [];
    return data;
  }
};

// ======================
// Activity Log
// ======================

async function logActivity(type, message, data = null) {
  try {
    await supabase
      .from('bot_activity_log')
      .insert([{
        type,
        message,
        data: data ? data : null
      }]);
  } catch (err) {
    logger.error('Failed to log activity to Supabase', { error: err.message });
  }
}

async function getRecentActivities(limit = 50) {
  const { data, error } = await supabase
    .from('bot_activity_log')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) return [];
  return data;
}

// ======================
// Statistics
// ======================

async function getStats() {
  try {
    const { count: totalSignals } = await supabase.from('bot_signals').select('*', { count: 'exact', head: true });
    const { count: activeSignals } = await supabase.from('bot_signals').select('*', { count: 'exact', head: true }).in('status', ['NEW', 'ACTIVE', 'PARTIALLY_FILLED']);
    const { count: totalTrades } = await supabase.from('bot_trades').select('*', { count: 'exact', head: true });
    const { count: openTradesCount } = await supabase.from('bot_trades').select('*', { count: 'exact', head: true }).in('status', ['PENDING', 'PARTIALLY_FILLED']);
    
    // Get only SELL trades for PnL calculation
    const { data: sellTrades } = await supabase
      .from('bot_trades')
      .select('pnl, created_at')
      .eq('side', 'SELL')
      .in('status', ['FILLED', 'SIMULATED']);
    
    const winTrades = sellTrades?.filter(t => parseFloat(t.pnl) > 0).length || 0;
    const lossTrades = sellTrades?.filter(t => parseFloat(t.pnl) < 0).length || 0;
    const totalPnl = sellTrades?.reduce((sum, t) => sum + (parseFloat(t.pnl) || 0), 0) || 0;

    // Calculate today's stats
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayISO = today.toISOString();

    const { count: todaySignalsCount } = await supabase
      .from('bot_signals')
      .select('*', { count: 'exact', head: true })
      .gte('created_at', todayISO);

    const todayPnl = sellTrades
      ?.filter(t => new Date(t.created_at) >= today)
      .reduce((sum, t) => sum + (parseFloat(t.pnl) || 0), 0) || 0;

    return {
      totalSignals: totalSignals || 0,
      activeSignals: activeSignals || 0,
      totalTrades: totalTrades || 0,
      openTrades: openTradesCount || 0,
      winTrades,
      lossTrades,
      winRate: (winTrades + lossTrades) > 0 ? ((winTrades / (winTrades + lossTrades)) * 100).toFixed(1) : '0.0',
      totalPnl: totalPnl.toFixed(4),
      todaySignals: todaySignalsCount || 0,
      todayPnl: todayPnl.toFixed(4),
    };
  } catch (err) {
    logger.error('Failed to get stats from Supabase', err);
    return {};
  }
}

/**
 * Get all bot settings
 */
async function getSettings() {
  const { data, error } = await supabase
    .from('bot_settings')
    .select('*');
  
  if (error) {
    logger.error('Error fetching settings:', error);
    return [];
  }
  return data;
}

/**
 * Update a specific setting
 */
async function updateSetting(key, value) {
  const { error } = await supabase
    .from('bot_settings')
    .upsert({ key, value: String(value), updated_at: new Date() });
  
  if (error) {
    logger.error(`Error updating setting ${key}:`, error);
    throw error;
  }
  return true;
}

/**
 * Cleanup old activity logs (older than 7 days)
 */
async function cleanupOldLogs() {
  try {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 7);
    
    const { error, count } = await supabase
      .from('bot_activity_log')
      .delete({ count: 'exact' })
      .lt('created_at', cutoff.toISOString());
    
    if (error) {
      logger.error('Failed to cleanup old logs', error);
    } else if (count > 0) {
      logger.info(`🧹 Cleaned up ${count} old activity log entries`);
    }
  } catch (err) {
    logger.error('Log cleanup error', { error: err.message });
  }
}

/**
 * Cleanup stale ACTIVE signals (older than 7 days with no recent trades)
 */
async function cleanupStaleSignals() {
  try {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 7);
    
    const { data: staleSignals } = await supabase
      .from('bot_signals')
      .select('id, symbol')
      .in('status', ['ACTIVE', 'NEW'])
      .lt('created_at', cutoff.toISOString());
    
    if (!staleSignals || staleSignals.length === 0) return;
    
    for (const sig of staleSignals) {
      await supabase
        .from('bot_signals')
        .update({ status: 'EXPIRED', updated_at: new Date() })
        .eq('id', sig.id);
      
      logger.info(`🕰️ Signal expired: ${sig.symbol} (ID: ${sig.id})`);
    }
    
    if (staleSignals.length > 0) {
      await logActivity('SYSTEM', `Auto-expired ${staleSignals.length} stale signal(s)`);
    }
  } catch (err) {
    logger.error('Stale signal cleanup error', { error: err.message });
  }
}

module.exports = {
  supabase,
  initDatabase,
  // Signals
  insertSignal: signals.insert,
  updateSignalStatus: signals.updateStatus,
  updateSlOrderId: signals.updateSlOrderId,
  getSignalById: signals.getById,
  getActiveSignals: signals.getActive,
  getAllSignals: signals.getAll,
  getSignalByTelegramMsgId: signals.getByTelegramMsgId,
  // Trades
  insertTrade: trades.insert,
  updateTradeStatus: trades.updateStatus,
  getTradesBySignalId: trades.getBySignalId,
  getOpenTrades: trades.getOpen,
  getAllTrades: trades.getAll,
  // Activity
  logActivity,
  getRecentActivities,
  // Stats
  getStats,
  // Settings
  getSettings,
  updateSetting,
  // Maintenance
  cleanupOldLogs,
  cleanupStaleSignals,
};

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const logger = require('../utils/logger');

const DATA_DIR = path.join(__dirname, '../../data');
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const DB_PATH = path.join(DATA_DIR, 'bot.db');
const db = new Database(DB_PATH);

// Enable WAL mode for better concurrency
db.pragma('journal_mode = WAL');

/**
 * Initialize database tables
 */
function initDatabase() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS signals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      symbol TEXT NOT NULL,
      timeframe TEXT,
      entry_price REAL NOT NULL,
      stop_loss REAL,
      tp1 REAL,
      tp2 REAL,
      tp3 REAL,
      tp4 REAL,
      score REAL,
      setup TEXT,
      status TEXT DEFAULT 'NEW',
      raw_message TEXT,
      telegram_msg_id INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS trades (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      signal_id INTEGER REFERENCES signals(id),
      symbol TEXT NOT NULL,
      side TEXT NOT NULL,
      type TEXT NOT NULL,
      quantity REAL NOT NULL,
      price REAL,
      order_id TEXT,
      mexc_order_id TEXT,
      status TEXT DEFAULT 'PENDING',
      executed_price REAL,
      executed_qty REAL,
      pnl REAL DEFAULT 0,
      pnl_percent REAL DEFAULT 0,
      target_label TEXT,
      is_dry_run INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS activity_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,
      message TEXT NOT NULL,
      data TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  logger.info('✅ Database initialized successfully');
}

// Auto-initialize tables on module load
initDatabase();

// ======================
// Signal Operations
// ======================

const insertSignal = db.prepare(`
  INSERT INTO signals (symbol, timeframe, entry_price, stop_loss, tp1, tp2, tp3, tp4, score, setup, status, raw_message, telegram_msg_id)
  VALUES (@symbol, @timeframe, @entry_price, @stop_loss, @tp1, @tp2, @tp3, @tp4, @score, @setup, @status, @raw_message, @telegram_msg_id)
`);

const updateSignalStatus = db.prepare(`
  UPDATE signals SET status = @status, updated_at = CURRENT_TIMESTAMP WHERE id = @id
`);

const getSignalById = db.prepare('SELECT * FROM signals WHERE id = ?');

const getActiveSignals = db.prepare(`
  SELECT * FROM signals WHERE status IN ('NEW', 'ACTIVE', 'PARTIALLY_FILLED') ORDER BY created_at DESC
`);

const getAllSignals = db.prepare('SELECT * FROM signals ORDER BY created_at DESC LIMIT ?');

const getSignalByTelegramMsgId = db.prepare('SELECT * FROM signals WHERE telegram_msg_id = ?');

// ======================
// Trade Operations
// ======================

const insertTrade = db.prepare(`
  INSERT INTO trades (signal_id, symbol, side, type, quantity, price, order_id, mexc_order_id, status, target_label, is_dry_run)
  VALUES (@signal_id, @symbol, @side, @type, @quantity, @price, @order_id, @mexc_order_id, @status, @target_label, @is_dry_run)
`);

const updateTradeStatus = db.prepare(`
  UPDATE trades SET status = @status, executed_price = @executed_price, executed_qty = @executed_qty,
  pnl = @pnl, pnl_percent = @pnl_percent, updated_at = CURRENT_TIMESTAMP WHERE id = @id
`);

const getTradesBySignalId = db.prepare('SELECT * FROM trades WHERE signal_id = ? ORDER BY created_at ASC');

const getOpenTrades = db.prepare(`
  SELECT t.*, s.entry_price as signal_entry, s.stop_loss as signal_sl
  FROM trades t
  JOIN signals s ON t.signal_id = s.id
  WHERE t.status IN ('PENDING', 'FILLED', 'PARTIALLY_FILLED')
  ORDER BY t.created_at DESC
`);

const getAllTrades = db.prepare('SELECT * FROM trades ORDER BY created_at DESC LIMIT ?');

// ======================
// Activity Log Operations
// ======================

const insertActivity = db.prepare(`
  INSERT INTO activity_log (type, message, data) VALUES (@type, @message, @data)
`);

const getRecentActivities = db.prepare('SELECT * FROM activity_log ORDER BY created_at DESC LIMIT ?');

// ======================
// Statistics
// ======================

function getStats() {
  const totalSignals = db.prepare('SELECT COUNT(*) as count FROM signals').get().count;
  const activeSignals = db.prepare("SELECT COUNT(*) as count FROM signals WHERE status IN ('NEW', 'ACTIVE', 'PARTIALLY_FILLED')").get().count;
  const totalTrades = db.prepare('SELECT COUNT(*) as count FROM trades').get().count;
  const openTrades = db.prepare("SELECT COUNT(*) as count FROM trades WHERE status IN ('PENDING', 'FILLED')").get().count;
  const winTrades = db.prepare("SELECT COUNT(*) as count FROM trades WHERE pnl > 0 AND status = 'CLOSED'").get().count;
  const lossTrades = db.prepare("SELECT COUNT(*) as count FROM trades WHERE pnl < 0 AND status = 'CLOSED'").get().count;
  const totalPnl = db.prepare("SELECT COALESCE(SUM(pnl), 0) as total FROM trades WHERE status = 'CLOSED'").get().total;
  const todaySignals = db.prepare("SELECT COUNT(*) as count FROM signals WHERE date(created_at) = date('now')").get().count;
  const todayPnl = db.prepare("SELECT COALESCE(SUM(pnl), 0) as total FROM trades WHERE status = 'CLOSED' AND date(created_at) = date('now')").get().total;

  return {
    totalSignals,
    activeSignals,
    totalTrades,
    openTrades,
    winTrades,
    lossTrades,
    winRate: (winTrades + lossTrades) > 0 ? ((winTrades / (winTrades + lossTrades)) * 100).toFixed(1) : '0.0',
    totalPnl: totalPnl.toFixed(4),
    todaySignals,
    todayPnl: todayPnl.toFixed(4),
  };
}

// ======================
// Log Activity Helper
// ======================

function logActivity(type, message, data = null) {
  try {
    insertActivity.run({
      type,
      message,
      data: data ? JSON.stringify(data) : null,
    });
  } catch (err) {
    logger.error('Failed to log activity', { error: err.message });
  }
}

module.exports = {
  db,
  initDatabase,
  // Signals
  insertSignal,
  updateSignalStatus,
  getSignalById,
  getActiveSignals,
  getAllSignals,
  getSignalByTelegramMsgId,
  // Trades
  insertTrade,
  updateTradeStatus,
  getTradesBySignalId,
  getOpenTrades,
  getAllTrades,
  // Activity
  logActivity,
  getRecentActivities,
  // Stats
  getStats,
};

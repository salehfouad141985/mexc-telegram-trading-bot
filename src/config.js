require('dotenv').config();

const config = {
  // Telegram MTProto
  telegram: {
    apiId: parseInt(process.env.TELEGRAM_API_ID) || 0,
    apiHash: process.env.TELEGRAM_API_HASH || '',
    stringSession: process.env.TELEGRAM_STRING_SESSION || '',
    channel: process.env.TELEGRAM_CHANNEL || 'shaabane_signals',
  },

  // MEXC API
  mexc: {
    apiKey: process.env.MEXC_API_KEY || '',
    secretKey: process.env.MEXC_SECRET_KEY || '',
    baseUrl: 'https://api.mexc.com',
    recvWindow: 5000,
  },
  
  // Supabase (PostgreSQL)
  supabase: {
    url: process.env.SUPABASE_URL || '',
    key: process.env.SUPABASE_KEY || '',
  },

  // Trading
  trading: {
    tradeAmountUsdt: parseFloat(process.env.TRADE_AMOUNT_USDT) || 10,
    minScore: parseFloat(process.env.MIN_SCORE) || 7,
    autoTrade: process.env.AUTO_TRADE === 'true',
    dryRun: process.env.DRY_RUN !== 'false', // default true for safety
    maxSpreadPercent: parseFloat(process.env.MAX_SPREAD_PERCENT) || 1.0,
  },

  // Risk Management — target allocation percentages
  risk: {
    tp1Percent: parseFloat(process.env.TP1_PERCENT) || 30,
    tp2Percent: parseFloat(process.env.TP2_PERCENT) || 30,
    tp3Percent: parseFloat(process.env.TP3_PERCENT) || 25,
    tp4Percent: parseFloat(process.env.TP4_PERCENT) || 15,
  },

  // Dashboard (Render uses process.env.PORT)
  dashboard: {
    port: parseInt(process.env.PORT) || parseInt(process.env.DASHBOARD_PORT) || 3030,
  },
};

module.exports = config;

const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const path = require('path');
const config = require('./src/config');
const logger = require('./src/utils/logger');
const signalParser = require('./src/parser/signalParser');
const tradeManager = require('./src/trading/tradeManager');
const db = require('./src/database/db');

async function run() {
  if (!config.telegram.apiId || !config.telegram.apiHash) {
    logger.error('❌ TELEGRAM_API_ID or TELEGRAM_API_HASH is not set!');
    return;
  }

  // Force checking MEXC condition
  if (!config.trading.dryRun && (!config.mexc.apiKey || config.mexc.apiKey === 'your_mexc_api_key_here')) {
    logger.error('❌ MEXC API keys are missing in .env! Cannot execute real trades.');
    logger.info('💡 Please edit .env, add MEXC_API_KEY and MEXC_SECRET_KEY, and set DRY_RUN=false');
    process.exit(1);
  }

  const stringSession = new StringSession(config.telegram.stringSession);
  const client = new TelegramClient(stringSession, config.telegram.apiId, config.telegram.apiHash, {
    connectionRetries: 5,
  });

  logger.info('🤖 Connecting to Telegram...');
  await client.connect();
  logger.info('✅ Connected!');

  let targetChannel = config.telegram.channel.replace('@', '');
  if (/^-?\d+$/.test(targetChannel)) {
    targetChannel = BigInt(targetChannel);
  }

  try {
    logger.info(`⏳ Fetching latest messages from channel: ${targetChannel}...`);
    const history = await client.getMessages(targetChannel, { limit: 20 });
    
    let latestSignal = null;

    for (const msg of history) {
      const text = msg.text || msg.message;
      if (!text) continue;
      
      const parsedSignal = signalParser.parse(text);
      if (parsedSignal) {
        parsedSignal.raw_message = text;
        parsedSignal.telegram_msg_id = msg.id;
        latestSignal = parsedSignal;
        break; // Stop at the first valid signal (newest)
      }
    }

    if (latestSignal) {
      logger.info('🎯 Found Latest Signal:', {
        symbol: latestSignal.symbol,
        entry: latestSignal.entry,
        date: new Date().toLocaleString()
      });

      // Avoid duplicate trigger if it's already in DB and completely traded
      // But since user requested explicit fetch and execute, we will just pass it to tradeManager
      const exists = db.getSignalByTelegramMsgId.get(latestSignal.telegram_msg_id);
      
      if (!exists) {
        const signalObj = {
          symbol: latestSignal.symbol,
          timeframe: latestSignal.timeframe,
          entry_price: latestSignal.entry,
          stop_loss: latestSignal.stopLoss,
          tp1: latestSignal.tp1,
          tp2: latestSignal.tp2,
          tp3: latestSignal.tp3,
          tp4: latestSignal.tp4,
          score: latestSignal.score,
          setup: latestSignal.setup,
          status: 'NEW',
          raw_message: latestSignal.raw_message,
          telegram_msg_id: latestSignal.telegram_msg_id
        };
        const info = db.insertSignal.run(signalObj);
        latestSignal.id = info.lastInsertRowid;
      } else {
         latestSignal.id = exists.id;
         logger.info('⚠️ Warning: This signal exists in the database already.');
      }

      await tradeManager.handleSignal(latestSignal);
      logger.info('✅ Trade execution process completed via script!');

    } else {
      logger.warn('⚠️ No signal found in the last 20 messages.');
    }
  } catch (err) {
    logger.error('❌ Error fetching messages:', { error: err.message });
  }

  await client.disconnect();
  process.exit(0);
}

run();

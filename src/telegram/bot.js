const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { NewMessage } = require('telegram/events');
const input = require('input');
const fs = require('fs');
const path = require('path');
const config = require('../config');
const logger = require('../utils/logger');
const signalParser = require('../parser/signalParser');
const db = require('../database/db');

let client = null;

/**
 * Helper to update .env with the new session string to avoid re-login
 * @param {string} sessionString
 */
function saveSessionToEnv(sessionString) {
  try {
    const envPath = path.join(__dirname, '../../.env');
    let envContent = fs.readFileSync(envPath, 'utf8');
    
    if (envContent.includes('TELEGRAM_STRING_SESSION=')) {
      envContent = envContent.replace(/TELEGRAM_STRING_SESSION=.*/, `TELEGRAM_STRING_SESSION=${sessionString}`);
    } else {
      envContent += `\nTELEGRAM_STRING_SESSION=${sessionString}`;
    }
    
    fs.writeFileSync(envPath, envContent);
    logger.info('✅ Telegram session saved to .env file automatically.');
  } catch (err) {
    logger.error('Failed to save session to .env', { error: err.message });
  }
}

/**
 * Start MTProto Telegram UserBot Client
 * @param {Function} onSignal - Callback when a valid signal is detected
 */
async function startBot(onSignal) {
  if (!config.telegram.apiId || !config.telegram.apiHash) {
    logger.error('❌ TELEGRAM_API_ID or TELEGRAM_API_HASH is not set! Check your .env file.');
    return;
  }

  const stringSession = new StringSession(config.telegram.stringSession);

  client = new TelegramClient(stringSession, config.telegram.apiId, config.telegram.apiHash, {
    connectionRetries: 5,
  });

  logger.info('🤖 Starting Telegram UserBot MTProto connection...');

  try {
    // This will prompt via Terminal if stringSession is empty
    await client.start({
      phoneNumber: async () => await input.text('📱 Please enter your phone number (+1234...): '),
      password: async () => await input.password('🔒 Please enter your 2FA password (if applicable): '),
      phoneCode: async () => await input.text('✉️ Please enter the code you received on Telegram: '),
      onError: (err) => logger.error('Telegram Login Error:', err),
    });

    logger.info('✅ You are successfully logged in to Telegram!');
    
    // Save the session if it's new
    const sessionString = client.session.save();
    if (sessionString !== config.telegram.stringSession) {
      saveSessionToEnv(sessionString);
    }

    db.logActivity('SYSTEM', 'Telegram UserBot connected successfully');

    // Register event listener for the target channel
    let targetChannel = config.telegram.channel.replace('@', ''); // Remove @ if present
    
    // If targetChannel is a number (like -100123456), convert to BigInt for MTProto Private Channels
    if (/^-?\d+$/.test(targetChannel)) {
      targetChannel = BigInt(targetChannel);
    }
    
    logger.info(`📡 Listening for signals from channel: ${targetChannel}`);

    // Catch the absolute latest signal on startup and execute it (replacing historical skips)
    try {
      logger.info('⏳ Checking channel to catch and execute the latest signal...');
      const history = await client.getMessages(targetChannel, { limit: 20 });
      let latestSignal = null;
      let latestMsgId = null;
      let rawText = null;

      for (const msg of history) {
        const text = msg.text || msg.message;
        if (!text) continue;
        
        const parsedSignal = signalParser.parse(text);
        if (parsedSignal) {
          latestSignal = parsedSignal;
          latestMsgId = msg.id;
          rawText = text;
          break; // Stop at the very first (newest) signal we find traversing backwards
        }
      }

      if (latestSignal) {
        const exists = db.getSignalByTelegramMsgId.get(latestMsgId);
        if (!exists) {
          latestSignal.raw_message = rawText;
          latestSignal.telegram_msg_id = latestMsgId;
          
          logger.info(`🎯 Found latest signal on startup: ${latestSignal.symbol}! Executing immediately...`);
          db.logActivity('SIGNAL', `Startup signal detected: ${latestSignal.symbol}`);
          
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
          
          // Execute it
          if (onSignal) onSignal(latestSignal);
        } else {
          logger.info(`✅ Latest signal (${latestSignal.symbol}) has already been processed previously.`);
        }
      } else {
        logger.info('ℹ️ No valid signals found in recent messages.');
      }
    } catch (err) {
      logger.warn('⚠️ Could not fetch latest signal from channel:', { error: err.message });
    }

    client.addEventHandler(async (event) => {
      const message = event.message;
      
      try {
        const chat = await message.getChat();
        if (!chat) return;

        const chatUsername = chat.username ? chat.username.toLowerCase() : '';
        const chatTitle = chat.title ? chat.title.toLowerCase() : '';
        const targetString = targetChannel.toString().toLowerCase();

        // Match by username OR if it's a private channel check if the title contains 'shabaan'
        const isMatch = chatUsername === targetString || 
                       (chatTitle && chatTitle.includes('shabaan')) ||
                       (chatTitle && chatTitle.includes(targetString.replace(/_/g, ' '))) ||
                       (chat.id && chat.id.toString() === targetString);

        if (isMatch) {
          logger.info(`📩 New message received from ${chat.title || '@' + chatUsername}`);
          
          const text = message.text || message.message;
          if (!text) return;

          // Parse the signal (Fixed method name from parseTelegramMessage to parse)
          const parsedSignal = signalParser.parse(text);
          if (parsedSignal) {
            parsedSignal.raw_message = text;
            parsedSignal.telegram_msg_id = message.id;

            logger.info('🎯 Signal parsed successfully!', { symbol: parsedSignal.symbol });
            db.logActivity('SIGNAL', `New signal detected: ${parsedSignal.symbol}`);
            
            // Pass to TradeManager
            if (onSignal) onSignal(parsedSignal);
          } else {
            logger.warn('Message did not match signal format or was incomplete.');
          }
        }
      } catch (err) {
        logger.error('Error processing incoming message', { error: err.message });
        db.logActivity('ERROR', `Bot error: ${err.message}`);
      }
    }, new NewMessage({ incoming: true }));

  } catch (err) {
    logger.error('❌ Failed to connect Telegram UserBot', { error: err.message });
  }
}

/**
 * Stop the Telegram UserBot Client
 */
async function stopBot() {
  if (client) {
    logger.info('🛑 Stopping Telegram UserBot...');
    await client.disconnect();
    client = null;
  }
}

module.exports = {
  startBot,
  stopBot,
};

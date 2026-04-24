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
let onSignalCallback = null;
let reconnectTimer = null;
let healthCheckTimer = null;
let isReconnecting = false;

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
 * Setup the message event handler for the target channel
 */
function setupMessageHandler() {
  let targetChannel = config.telegram.channel.replace('@', '');
  
  if (/^-?\d+$/.test(targetChannel)) {
    targetChannel = BigInt(targetChannel);
  }
  
  logger.info(`📡 Listening strictly for NEW upcoming live signals from channel: ${targetChannel}`);

  client.addEventHandler(async (event) => {
    const message = event.message;
    
    try {
      const chat = await message.getChat();
      if (!chat) return;

      const chatUsername = chat.username ? chat.username.toLowerCase() : '';
      const chatTitle = chat.title ? chat.title.toLowerCase() : '';
      const chatId = chat.id ? chat.id.toString() : '';
      const targetString = targetChannel.toString().toLowerCase();

      // === DEBUG LOG: Show ALL incoming messages so we can diagnose ===
      logger.info(`🔍 [DEBUG] Incoming message from: username="${chatUsername}", title="${chatTitle}", id=${chatId}, target="${targetString}"`);

      // Match by username OR title OR chat id
      const isMatch = chatUsername === targetString || 
                     (chatTitle && chatTitle.includes('shabaan')) ||
                     (chatTitle && chatTitle.includes('signal')) ||
                     (chatTitle && chatTitle.includes(targetString.replace(/_/g, ' '))) ||
                     (chatId === targetString);

      if (isMatch) {
        const text = message.text || message.message;
        logger.info(`📩 ✅ MATCHED! New message from ${chat.title || '@' + chatUsername}: ${text ? text.substring(0, 80) + '...' : '[no text]'}`);
        
        if (!text) return;

        const parsedSignal = signalParser.parse(text);
        if (parsedSignal) {
          parsedSignal.raw_message = text;
          parsedSignal.telegram_msg_id = message.id;

          logger.info('🎯 Signal parsed successfully!', { symbol: parsedSignal.symbol, entry: parsedSignal.entry, score: parsedSignal.score });
          db.logActivity('SIGNAL', `New signal detected: ${parsedSignal.symbol}`);
          
          if (onSignalCallback) onSignalCallback(parsedSignal);
        } else {
          logger.warn(`⚠️ Message from target channel did not match signal format. Preview: ${text.substring(0, 100)}`);
        }
      }
    } catch (err) {
      logger.error('Error processing incoming message', { error: err.message });
      db.logActivity('ERROR', `Bot error: ${err.message}`);
    }
  }, new NewMessage({ incoming: true }));
}

/**
 * Periodic health check - verifies Telegram connection is alive
 * If connection dropped, triggers reconnection
 */
function startHealthCheck() {
  if (healthCheckTimer) clearInterval(healthCheckTimer);
  
  healthCheckTimer = setInterval(async () => {
    if (!client || isReconnecting) return;
    
    try {
      // Try to ping Telegram by getting own user info
      const me = await client.getMe();
      if (me) {
        logger.info(`💓 Health check OK — connected as ${me.firstName || me.username}`);
      }
    } catch (err) {
      logger.error(`💔 Health check FAILED: ${err.message} — triggering reconnect...`);
      db.logActivity('WARNING', `Telegram connection lost: ${err.message}`);
      attemptReconnect();
    }
  }, 30000); // Check every 30 seconds
}

/**
 * Attempt to reconnect to Telegram
 */
async function attemptReconnect() {
  if (isReconnecting) return;
  isReconnecting = true;
  
  logger.warn('🔄 Attempting Telegram reconnection...');
  db.logActivity('SYSTEM', 'Attempting Telegram reconnection...');
  
  try {
    // Try to disconnect cleanly first
    try {
      if (client) await client.disconnect();
    } catch (e) {
      // Ignore disconnect errors
    }
    
    // Reconnect
    await client.connect();
    
    // Verify connection
    const me = await client.getMe();
    logger.info(`✅ Reconnected successfully as ${me.firstName || me.username}!`);
    db.logActivity('SYSTEM', 'Telegram reconnected successfully');
    
    isReconnecting = false;
  } catch (err) {
    logger.error(`❌ Reconnection failed: ${err.message} — will retry in 10s...`);
    isReconnecting = false;
    
    // Schedule retry
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(() => attemptReconnect(), 10000);
  }
}

/**
 * Start MTProto Telegram UserBot Client
 * @param {Function} onSignal - Callback when a valid signal is detected
 */
async function startBot(onSignal) {
  onSignalCallback = onSignal;
  
  if (!config.telegram.apiId || !config.telegram.apiHash) {
    logger.error('❌ TELEGRAM_API_ID or TELEGRAM_API_HASH is not set! Check your .env file.');
    return;
  }

  const stringSession = new StringSession(config.telegram.stringSession);

  client = new TelegramClient(stringSession, config.telegram.apiId, config.telegram.apiHash, {
    connectionRetries: 20,
    retryDelay: 2000,
    autoReconnect: true,
  });

  logger.info('🤖 Starting Telegram UserBot MTProto connection...');

  try {
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

    // Log which user and verify connection
    const me = await client.getMe();
    logger.info(`👤 Logged in as: ${me.firstName} ${me.lastName || ''} (@${me.username || 'N/A'})`);

    db.logActivity('SYSTEM', 'Telegram UserBot connected successfully');

    // Setup the message handler
    setupMessageHandler();
    
    // Start periodic health checks to detect dropped connections
    startHealthCheck();

  } catch (err) {
    logger.error('❌ Failed to connect Telegram UserBot', { error: err.message });
    
    // Auto-retry after 10 seconds
    logger.info('🔄 Will retry connection in 10 seconds...');
    setTimeout(() => startBot(onSignal), 10000);
  }
}

/**
 * Stop the Telegram UserBot Client
 */
async function stopBot() {
  if (healthCheckTimer) clearInterval(healthCheckTimer);
  if (reconnectTimer) clearTimeout(reconnectTimer);
  
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

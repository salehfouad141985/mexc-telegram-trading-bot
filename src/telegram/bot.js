const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { Api } = require('telegram/tl');
const input = require('input');
const fs = require('fs');
const path = require('path');
const config = require('../config');
const logger = require('../utils/logger');
const signalParser = require('../parser/signalParser');
const db = require('../database/db');

let client = null;
let onSignalCallback = null;
let pollingTimer = null;
let healthCheckTimer = null;
let retryTimer = null;           // Track retry timer to prevent stacking
let lastProcessedMsgId = 0;     // Track the last message ID we processed
let targetEntity = null;         // Cached channel entity
let retryCount = 0;              // Track retry attempts
const MAX_RETRIES = 5;           // Max retries before generating a new session

/**
 * Cleanly disconnect and destroy the existing client
 */
async function cleanupClient() {
  try {
    if (healthCheckTimer) { clearInterval(healthCheckTimer); healthCheckTimer = null; }
    if (pollingTimer) { clearInterval(pollingTimer); pollingTimer = null; }
    if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
    
    if (client) {
      logger.info('🧹 Cleaning up previous Telegram client connection...');
      try {
        await client.disconnect();
      } catch (e) {
        // Ignore disconnect errors — we're cleaning up anyway
      }
      client = null;
    }
    targetEntity = null;
  } catch (err) {
    logger.error(`Cleanup error (non-fatal): ${err.message}`);
    client = null;
    targetEntity = null;
  }
}

/**
 * Helper to update .env with the new session string to avoid re-login
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
 * POLLING-BASED message fetcher
 * Periodically checks the target channel for new messages
 * This is far more reliable than event-based approach on VPS servers
 */
async function pollForMessages() {
  if (!client || !targetEntity) return;

  try {
    // Fetch the latest 5 messages from the target channel
    const messages = await client.getMessages(targetEntity, { limit: 5 });
    
    if (!messages || messages.length === 0) return;

    // Process messages newer than our last processed ID (oldest first)
    const newMessages = messages
      .filter(msg => msg.id > lastProcessedMsgId && msg.message)
      .reverse(); // Process oldest first

    for (const msg of newMessages) {
      const text = msg.message;
      lastProcessedMsgId = msg.id;

      logger.info(`📩 New message detected (ID: ${msg.id}): ${text.substring(0, 80)}...`);

      // Try to parse as a trading signal
      const parsedSignal = signalParser.parse(text);
      if (parsedSignal) {
        // === DUPLICATE CHECK: Skip if already processed ===
        const existing = db.getSignalByTelegramMsgId.get(msg.id);
        if (existing) {
          logger.info(`⏭️ Signal already processed (msg ID: ${msg.id}), skipping.`);
          continue;
        }

        parsedSignal.raw_message = text;
        parsedSignal.telegram_msg_id = msg.id;

        logger.info('🎯 Signal parsed successfully!', { 
          symbol: parsedSignal.symbol, 
          entry: parsedSignal.entry, 
          score: parsedSignal.score,
          targets: parsedSignal.targets.length
        });
        db.logActivity('SIGNAL', `New signal detected: ${parsedSignal.symbol}`);
        
        if (onSignalCallback) onSignalCallback(parsedSignal);
      } else {
        logger.info(`ℹ️ Message is not a trading signal, skipping.`);
      }
    }
  } catch (err) {
    logger.error(`❌ Polling error: ${err.message}`);
    // Don't crash — polling will retry on next interval
  }
}

/**
 * Start polling the target channel
 */
function startPolling() {
  if (pollingTimer) clearInterval(pollingTimer);
  
  const POLL_INTERVAL = 10000; // Check every 10 seconds
  
  logger.info(`🔄 Starting channel polling (every ${POLL_INTERVAL / 1000}s)...`);
  
  // First poll immediately
  pollForMessages();
  
  // Then poll regularly
  pollingTimer = setInterval(pollForMessages, POLL_INTERVAL);
}

/**
 * Periodic health check - verifies Telegram connection is alive
 */
function startHealthCheck() {
  if (healthCheckTimer) clearInterval(healthCheckTimer);
  
  healthCheckTimer = setInterval(async () => {
    if (!client) return;
    
    try {
      const me = await client.getMe();
      if (me) {
        logger.info(`💓 Health check OK — connected as ${me.firstName || me.username}`);
      }
    } catch (err) {
      logger.error(`💔 Health check FAILED: ${err.message} — restarting connection...`);
      db.logActivity('WARNING', `Telegram connection lost: ${err.message}`);
      
      // Force process exit — PM2 will restart us cleanly
      process.exit(1);
    }
  }, 60000); // Check every 60 seconds (reduced frequency since polling handles detection)
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

  // === CRITICAL: Clean up any existing client before creating a new one ===
  await cleanupClient();

  const stringSession = new StringSession(config.telegram.stringSession);

  client = new TelegramClient(stringSession, config.telegram.apiId, config.telegram.apiHash, {
    connectionRetries: 5,
    retryDelay: 3000,
    autoReconnect: true,
    useWSS: true,
    floodSleepThreshold: 60,
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
    retryCount = 0; // Reset retry counter on success
    
    // Save the session if it's new
    const sessionString = client.session.save();
    if (sessionString !== config.telegram.stringSession) {
      saveSessionToEnv(sessionString);
    }

    // Log which user
    const me = await client.getMe();
    logger.info(`👤 Logged in as: ${me.firstName} ${me.lastName || ''} (@${me.username || 'N/A'})`);
    db.logActivity('SYSTEM', 'Telegram UserBot connected successfully');

    // === RESOLVE TARGET CHANNEL ===
    const channelName = config.telegram.channel.replace('@', '');
    logger.info(`📡 Resolving target channel: ${channelName}...`);
    
    try {
      // Try to get the channel entity directly
      targetEntity = await client.getEntity(channelName);
      logger.info(`🎯 Target channel resolved! title="${targetEntity.title}", id=${targetEntity.id}, type=${targetEntity.className}`);
    } catch (err) {
      logger.warn(`⚠️ Direct entity resolution failed, trying via dialogs...`);
      
      // Fallback: search through dialogs
      const dialogs = await client.getDialogs({ limit: 100 });
      for (const dialog of dialogs) {
        const entity = dialog.entity;
        const username = entity.username ? entity.username.toLowerCase() : '';
        if (username === channelName.toLowerCase()) {
          targetEntity = entity;
          logger.info(`🎯 Target channel found via dialogs! title="${dialog.title}", id=${entity.id}`);
          break;
        }
      }
    }

    if (!targetEntity) {
      logger.error(`❌ FATAL: Could not find channel "${channelName}". Make sure you are subscribed to it!`);
      return;
    }

    // Get the latest message ID so we only process NEW messages going forward
    try {
      const latestMessages = await client.getMessages(targetEntity, { limit: 1 });
      if (latestMessages && latestMessages.length > 0) {
        lastProcessedMsgId = latestMessages[0].id;
        logger.info(`📌 Starting from message ID: ${lastProcessedMsgId} (will only process newer messages)`);
      }
    } catch (err) {
      logger.warn(`⚠️ Could not fetch latest message ID: ${err.message}`);
    }

    // Start polling for new messages (REPLACES broken event handler)
    startPolling();
    
    // Start periodic health checks
    startHealthCheck();

    // Verify polling works with a quick test
    logger.info('🧪 Polling system active — will check for new messages every 10 seconds');

  } catch (err) {
    logger.error('❌ Failed to connect Telegram UserBot', { error: err.message });
    
    // Clean up the failed client before retrying
    await cleanupClient();
    
    retryCount++;
    
    if (err.message && err.message.includes('AUTH_KEY_DUPLICATED')) {
      logger.error('🔑 AUTH_KEY_DUPLICATED: Your session string is being used elsewhere.');
      logger.error('   → Make sure NO other instance of this bot is running (locally, other VPS, etc.)');
      logger.error('   → If the problem persists, you need to generate a NEW session string.');
      
      if (retryCount >= MAX_RETRIES) {
        logger.error(`🛑 Max retries (${MAX_RETRIES}) reached for AUTH_KEY_DUPLICATED. Stopping retries.`);
        logger.error('   → Please terminate ALL other bot instances, then generate a new session string.');
        db.logActivity('ERROR', 'AUTH_KEY_DUPLICATED: Max retries reached. Need new session string.');
        return; // Stop retrying — the session is compromised
      }
    }
    
    if (retryCount >= MAX_RETRIES) {
      logger.error(`🛑 Max retries (${MAX_RETRIES}) reached. Giving up.`);
      db.logActivity('ERROR', 'Telegram connection failed after max retries');
      return;
    }
    
    // Exponential backoff: 15s, 30s, 60s, 120s, ...
    const retryDelay = Math.min(15000 * Math.pow(2, retryCount - 1), 120000);
    logger.info(`🔄 Will retry connection in ${retryDelay / 1000}s... (attempt ${retryCount}/${MAX_RETRIES})`);
    retryTimer = setTimeout(() => startBot(onSignal), retryDelay);
  }
}

/**
 * Stop the Telegram UserBot Client
 */
async function stopBot() {
  logger.info('🛑 Stopping Telegram UserBot...');
  await cleanupClient();
}

module.exports = {
  startBot,
  stopBot,
};

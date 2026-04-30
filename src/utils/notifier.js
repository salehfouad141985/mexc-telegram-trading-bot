const logger = require('./logger');
const config = require('../config');

// We use a lazy require for bot to avoid circular dependencies
let telegramBot = null;

/**
 * Send a notification to Telegram
 */
async function sendNotification(message) {
  try {
    if (!telegramBot) {
      telegramBot = require('../telegram/bot');
    }
    
    // Add prefix based on mode
    const prefix = config.trading.dryRun ? '🧪 [DRY RUN] ' : '💰 [LIVE] ';
    const fullMessage = prefix + message;
    
    // Log to console
    logger.info(`🔔 NOTIFICATION: ${fullMessage}`);
    
    // Send to Telegram
    await telegramBot.sendMessage(fullMessage);
  } catch (err) {
    logger.error('Failed to send notification', { error: err.message });
  }
}

module.exports = {
  sendNotification,
};

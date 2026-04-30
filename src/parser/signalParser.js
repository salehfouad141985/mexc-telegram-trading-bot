const logger = require('../utils/logger');

/**
 * Signal Parser for Shaabane Signals format
 *
 * Expected format:
 * 🔷 #FOGO | 🔮 15 m
 * 💰 Entry: $0.02051
 * 🔴 SL: $0.01877
 * 🎯 Targets:
 * 🟢 TP1 → $0.02154 (+5.02%)
 * 🟢 TP2 → $0.02256 (+10.0%)
 * 🟢 TP3 → $0.02666 (+29.99%)
 * 🟢 TP4 → $0.04102 (+100.0%)
 * 🔥 Score: 9.4 / 10
 * 📊 Setup: Compression + Pre-Breakout + Explosion
 * 🔥 Status: 🟢 Open
 */
class SignalParser {
  /**
   * Parse a raw message text into a structured signal object
   * @param {string} text - Raw message from Telegram
   * @returns {object|null} Parsed signal or null if not a valid signal
   */
  parse(text) {
    if (!text || typeof text !== 'string') return null;

    try {
      // Check if this looks like a trading signal
      if (!this.isSignal(text)) {
        return null;
      }

      const symbol = this.extractSymbol(text);
      const timeframe = this.extractTimeframe(text);
      const entry = this.extractEntry(text);
      const stopLoss = this.extractStopLoss(text);
      const targets = this.extractTargets(text);
      const score = this.extractScore(text);
      const setup = this.extractSetup(text);
      const status = this.extractStatus(text);

      // Must have at least symbol and entry
      if (!symbol || !entry) {
        logger.warn('⚠️ Signal missing required fields (symbol or entry)', { symbol, entry });
        return null;
      }

      const signal = {
        symbol: this.normalizeSymbol(symbol),
        timeframe: timeframe || 'unknown',
        entry: entry,
        stopLoss: stopLoss || null,
        targets: targets,
        tp1: targets[0] || null,
        tp2: targets[1] || null,
        tp3: targets[2] || null,
        tp4: targets[3] || null,
        score: score || 0,
        setup: setup || '',
        status: status || 'Open',
      };

      logger.info(`📊 Signal parsed: ${signal.symbol} @ $${signal.entry}`, {
        score: signal.score,
        targets: signal.targets.length,
        sl: signal.stopLoss,
      });

      return signal;
    } catch (err) {
      logger.error('❌ Error parsing signal', { error: err.message, text: text.substring(0, 100) });
      return null;
    }
  }

  /**
   * Check if message text appears to be a trading signal
   */
  isSignal(text) {
    // Must contain at least a hashtag symbol and entry price
    const hasSymbol = /#[A-Za-z0-9]+/.test(text);
    const hasEntry = /entry|Entry|ENTRY/i.test(text) && /\$[\d.]+/.test(text);
    const hasTargets = /TP\d|target/i.test(text);

    return hasSymbol && hasEntry && hasTargets;
  }

  /**
   * Extract coin symbol from text (e.g., #FOGO → FOGO)
   */
  extractSymbol(text) {
    // 1. Try hashtag format: #FOGO
    const hashtagMatch = text.match(/#([A-Za-z0-9]+)/);
    if (hashtagMatch) return hashtagMatch[1].toUpperCase();

    // 2. Try pattern: "SYMBOL |" or "SYMBOL -" at the start
    const startMatch = text.match(/^([A-Za-z0-9]{2,10})\s*[|\-\/]/);
    if (startMatch) return startMatch[1].toUpperCase();

    return null;
  }

  /**
   * Normalize symbol to MEXC format (append USDT if needed)
   */
  normalizeSymbol(symbol) {
    if (!symbol) return null;
    symbol = symbol.toUpperCase();
    // If it already ends with USDT, USDC, BTC, etc., return as-is
    if (symbol.endsWith('USDT') || symbol.endsWith('USDC') || symbol.endsWith('BTC')) {
      return symbol;
    }
    // Default to USDT pair
    return `${symbol}USDT`;
  }

  /**
   * Extract timeframe (e.g., "15 m" → "15m")
   */
  extractTimeframe(text) {
    // Match patterns like "15 m", "1 h", "4h", "1d"
    const match = text.match(/(\d+)\s*(m|min|h|hour|d|day|w|week)/i);
    if (match) {
      return `${match[1]}${match[2].charAt(0).toLowerCase()}`;
    }
    return null;
  }

  /**
   * Extract entry price (supports ranges like 0.02 - 0.025)
   */
  extractEntry(text) {
    // 1. Try range format: "Entry: $0.02 - $0.025"
    const rangeMatch = text.match(/entry[:\s]*\$?([\d.]+)\s*-\s*\$?([\d.]+)/i);
    if (rangeMatch) {
      const p1 = parseFloat(rangeMatch[1]);
      const p2 = parseFloat(rangeMatch[2]);
      return (p1 + p2) / 2; // Return average
    }

    // 2. Try standard format: "Entry: $0.02051"
    const match = text.match(/entry[:\s]*\$?([\d.]+)/i);
    return match ? parseFloat(match[1]) : null;
  }

  /**
   * Extract stop loss price
   */
  extractStopLoss(text) {
    // Match "SL: $0.01877" or "Stop Loss: $0.01877" or "SL $0.01877"
    const match = text.match(/(?:SL|stop\s*loss)[:\s]*\$?([\d.]+)/i);
    return match ? parseFloat(match[1]) : null;
  }

  /**
   * Extract target prices (TP1, TP2, TP3, TP4)
   */
  extractTargets(text) {
    const targets = [];

    // Match "TP1 → $0.02154" or "TP1: $0.02154" or "TP1 $0.02154"
    const regex = /TP(\d)[:\s→\->]*\$?([\d.]+)/gi;
    let match;

    while ((match = regex.exec(text)) !== null) {
      const tpIndex = parseInt(match[1]) - 1;
      const price = parseFloat(match[2]);
      if (!isNaN(price) && price > 0) {
        targets[tpIndex] = price;
      }
    }

    // Filter out undefined values and return
    return targets.filter((t) => t !== undefined);
  }

  /**
   * Extract score value
   */
  extractScore(text) {
    // Match "Score: 9.4 / 10" or "Score: 9.4/10" or "Score 9.4"
    const match = text.match(/score[:\s]*([\d.]+)\s*(?:\/\s*10)?/i);
    return match ? parseFloat(match[1]) : null;
  }

  /**
   * Extract setup description
   */
  extractSetup(text) {
    // Match "Setup: Compression + Pre-Breakout + Explosion"
    const match = text.match(/setup[:\s]*(.+?)(?:\n|$)/i);
    return match ? match[1].trim() : null;
  }

  /**
   * Extract status
   */
  extractStatus(text) {
    // Match "Status: 🟢 Open" or "Status: Open" or "Status: Closed"
    const match = text.match(/status[:\s]*(?:🟢|🔴|🟡)?\s*(open|closed|cancelled|hit|partial)/i);
    return match ? match[1].trim() : null;
  }

  /**
   * Check if a message is a status update for an existing signal
   */
  isStatusUpdate(text) {
    const hasSymbol = /#[A-Za-z0-9]+/.test(text);
    const hasStatusChange = /(?:status|update)[:\s]*(?:🟢|🔴|🟡)?\s*(closed|hit|cancelled|partial)/i.test(text);
    const hasTPHit = /TP\d\s*(?:hit|✅|reached|done)/i.test(text);
    const hasSLHit = /(?:SL|stop\s*loss)\s*(?:hit|✅|reached|triggered)/i.test(text);

    return hasSymbol && (hasStatusChange || hasTPHit || hasSLHit);
  }

  /**
   * Extract which TPs were hit from an update message
   */
  extractHitTargets(text) {
    const hits = [];
    const regex = /TP(\d)\s*(?:hit|✅|reached|done)/gi;
    let match;
    while ((match = regex.exec(text)) !== null) {
      hits.push(parseInt(match[1]));
    }
    return hits;
  }
}

module.exports = new SignalParser();

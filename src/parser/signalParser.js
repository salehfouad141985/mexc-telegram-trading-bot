const logger = require('../utils/logger');
const config = require('../config');

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
   * Clean and normalize raw text (remove invisible unicode, format dashes, convert Arabic digits)
   */
  cleanText(text) {
    if (!text || typeof text !== 'string') return '';
    return text
      // Remove invisible Unicode characters (BOM, RTL/LTR marks, zero-width spaces, directional marks, NBSP)
      .replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF\u00A0]/g, ' ')
      // Normalize different unicode dashes to standard hyphen
      .replace(/[–—−‒―]/g, '-')
      // Convert Eastern Arabic numerals to standard Western numerals (٠١٢٣٤٥٦٧٨٩ -> 0123456789)
      .replace(/[٠-٩]/g, d => '٠١٢٣٤٥٦٧٨٩'.indexOf(d))
      // Convert Persian numerals if any (۰۱۲۳۴۵۶۷۸۹ -> 0123456789)
      .replace(/[۰-۹]/g, d => '۰۱۲۳۴۵۶۷۸۹'.indexOf(d))
      // Normalize Arabic decimal separator comma
      .replace(/(\d+)[٫,](\d+)/g, '$1.$2');
  }

  /**
   * Parse a raw message text into a structured signal object
   * @param {string} text - Raw message from Telegram
   * @returns {object|null} Parsed signal or null if not a valid signal
   */
  parse(text) {
    if (!text || typeof text !== 'string') return null;

    try {
      const cleaned = this.cleanText(text);

      // Check if this looks like a trading signal
      if (!this.isSignal(cleaned)) {
        return null;
      }

      const symbol = this.extractSymbol(cleaned);
      const timeframe = this.extractTimeframe(cleaned);
      const entry = this.extractEntry(cleaned);
      const stopLoss = this.extractStopLoss(cleaned);
      const targets = this.extractTargets(cleaned);
      const targetPcts = this.extractTargetPercentages(cleaned);
      const score = this.extractScore(cleaned);
      const setup = this.extractSetup(cleaned);
      const status = this.extractStatus(cleaned);

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
        targetPcts: targetPcts,
        tp1: targets[0] || null,
        tp2: targets[1] || null,
        tp3: targets[2] || null,
        tp4: targets[3] || null,
        score: score !== null ? score : 10,
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
    if (!text) return false;
    const cleaned = this.cleanText(text);

    // 1. Check for symbol: #HASHTAG or uppercase word at start or with /USDT
    const hasSymbol = /#[A-Za-z0-9.]+/i.test(cleaned) || 
                      /^([A-Z0-9]{2,10})\s*[|\-\/]/i.test(cleaned) || 
                      /[A-Z0-9]{2,10}\/(USDT|USDC|BTC)/i.test(cleaned);
    
    // 2. Check for entry keyword and price (English & Arabic)
    const hasEntry = /(?:entry|الدخول|سعر الدخول|شراء|Buy)/i.test(cleaned) && 
                     (/\$[\d.]+/i.test(cleaned) || /(?:entry|الدخول|سعر الدخول|شراء|Buy)[:\s]*\$?[\d.]+/i.test(cleaned));
    
    // 3. Check for targets (English & Arabic & Keycap emojis)
    const hasTargets = /(?:TP\d|target|الأهداف|الهدف|[1-4]️⃣|[1-4]⃣)/i.test(cleaned);

    return (hasSymbol && hasEntry) || (hasSymbol && hasTargets);
  }

  /**
   * Extract coin symbol from text (e.g., #DOGE → DOGE, #TOWNS → TOWNS)
   */
  extractSymbol(text) {
    // 1. Try hashtag format: #DOGE
    const hashtagMatch = text.match(/#([A-Za-z0-9]+)/);
    if (hashtagMatch) {
      return hashtagMatch[1].toUpperCase();
    }

    // 2. Try pair format: FOGO/USDT or FOGO-USDT
    const pairMatch = text.match(/([A-Z0-9]{2,10})[\/\-](USDT|USDC|BTC|ETH)/i);
    if (pairMatch) {
      return pairMatch[1].toUpperCase();
    }

    // 3. Try pattern: "SYMBOL |" or "SYMBOL -" at the start
    const startMatch = text.match(/^([A-Z0-9.]{2,10})\s*[|\-\/]/i);
    if (startMatch) {
      return startMatch[1].replace(/\.+$/, '').toUpperCase();
    }

    return null;
  }

  /**
   * Normalize symbol to MEXC format (append USDT if needed)
   */
  normalizeSymbol(symbol) {
    if (!symbol) return null;
    symbol = symbol.toUpperCase();
    
    // 1. Determine the baseline target symbol (e.g. BTC -> BTCUSDT, BTCUSDT -> BTCUSDT)
    let target = symbol;
    if (!symbol.endsWith('USDT') && !symbol.endsWith('USDC') && !symbol.endsWith('BTC')) {
      target = `${symbol}USDT`;
    }

    // 2. Check if there's a mapped MEXC-specific alias (e.g. ALTUSDT -> ALTLAYERUSDT)
    if (config.symbolMappings && config.symbolMappings[target]) {
      const mapped = config.symbolMappings[target];
      logger.info(`🔀 Mapping symbol alias: ${target} -> ${mapped}`);
      return mapped;
    }

    return target;
  }

  /**
   * Extract timeframe (e.g., "15 m" → "15m", "4 ساعات" → "4h")
   */
  extractTimeframe(text) {
    const match = text.match(/(\d+)\s*(m|min|h|hour|d|day|w|week|ساعات|ساعة|دقيقة|دقائق)/i);
    if (match) {
      const unit = match[2].toLowerCase();
      if (unit.includes('ساع') || unit.startsWith('h')) return `${match[1]}h`;
      if (unit.includes('دقيق') || unit.startsWith('m')) return `${match[1]}m`;
      if (unit.includes('يوم') || unit.startsWith('d')) return `${match[1]}d`;
      return `${match[1]}${unit.charAt(0)}`;
    }
    return null;
  }

  /**
   * Extract entry price (supports ranges like 0.02 - 0.025 or 0.0685 - 0.07104)
   */
  extractEntry(text) {
    // 1. Try range format: "Entry: $0.02 - $0.025" or "الدخول: 0.0685 - 0.07104"
    const rangeMatch = text.match(/(?:entry|الدخول|سعر الدخول|شراء|Buy)[:\s]*\$?([\d.]+)\s*[\-–—~]\s*\$?([\d.]+)/i);
    if (rangeMatch) {
      const p1 = parseFloat(rangeMatch[1]);
      const p2 = parseFloat(rangeMatch[2]);
      if (!isNaN(p1) && !isNaN(p2)) {
        return (p1 + p2) / 2; // Return average
      }
    }

    // 2. Try standard format: "Entry: $0.02051" or "الدخول: 0.02051"
    const match = text.match(/(?:entry|الدخول|سعر الدخول|شراء|Buy)[:\s]*\$?([\d.]+)/i);
    return match ? parseFloat(match[1]) : null;
  }

  /**
   * Extract stop loss price (supports English and Arabic like "الستوب: إغلاق 4 ساعات أسفل 0.0675")
   */
  extractStopLoss(text) {
    const lines = text.split('\n');
    for (const line of lines) {
      if (/(?:SL|stop\s*loss|الستوب|وقف\s*الخسارة|وقف)/i.test(line)) {
        // If line contains "أسفل" or "below" or "<", match the price after it
        const belowMatch = line.match(/(?:أسفل|تحت|below|<)\s*\$?([\d.]+)/i);
        if (belowMatch) {
          const val = parseFloat(belowMatch[1]);
          if (!isNaN(val)) return val;
        }

        // Find numbers on the SL line and pick the actual price
        const numbers = line.match(/\$?([\d]+\.[\d]+|\b[\d]+\b)/g);
        if (numbers && numbers.length > 0) {
          const decimals = numbers.map(n => parseFloat(n.replace('$', ''))).filter(n => !isNaN(n));
          return decimals[decimals.length - 1];
        }
      }
    }
    return null;
  }

  /**
   * Extract target prices (TP1, TP2, TP3, TP4 or 1️⃣, 2️⃣, 3️⃣, 4️⃣)
   */
  extractTargets(text) {
    const targets = [];

    // Format 1: "TP1 → $0.02154" or "TP1: $0.02154"
    const tpRegex = /TP(\d)[:\s→\->]*\$?([\d.]+)/gi;
    let match;
    while ((match = tpRegex.exec(text)) !== null) {
      const tpIndex = parseInt(match[1]) - 1;
      const price = parseFloat(match[2]);
      if (!isNaN(price) && price > 0) {
        targets[tpIndex] = price;
      }
    }

    // Format 2: "1️⃣ 0.0750 | +5.6% | بيع 20%" or "1 0.0750" or "الهدف 1: 0.0750"
    const keycapRegex = /(?:(?:TP|الهدف)\s*)?([1-4])(?:[️⃣⃣\.\:\)\-\s]*)\s*\$?([\d]+\.[\d]+|\b[\d]+\b)/g;
    while ((match = keycapRegex.exec(text)) !== null) {
      const idx = parseInt(match[1]) - 1;
      const price = parseFloat(match[2]);
      if (!isNaN(price) && price > 0 && (!targets[idx] || targets.length === 0)) {
        targets[idx] = price;
      }
    }

    // Filter out undefined values and return
    return targets.filter((t) => t !== undefined);
  }

  /**
   * Extract target sell percentages per TP if specified (e.g. "بيع 20%")
   */
  extractTargetPercentages(text) {
    const pcts = [];
    const lines = text.split('\n');
    for (const line of lines) {
      const keycapMatch = line.match(/([1-4])(?:[️⃣⃣\.\:\)\-\s]*)/);
      const tpMatch = line.match(/TP([1-4])/i);
      const idx = keycapMatch ? parseInt(keycapMatch[1]) - 1 : (tpMatch ? parseInt(tpMatch[1]) - 1 : null);
      
      if (idx !== null) {
        const sellPctMatch = line.match(/(?:بيع|sell)\s*(\d+)%/i) || line.match(/(\d+)%\s*(?:بيع|sell)/i);
        if (sellPctMatch) {
          pcts[idx] = parseFloat(sellPctMatch[1]);
        }
      }
    }
    return pcts.length > 0 ? pcts : null;
  }

  /**
   * Extract score value
   */
  extractScore(text) {
    // Match "Score: 9.4 / 10" or "Score: 9.4/10" or "Score 9.4"
    const match = text.match(/score[:\s]*([\d.]+)\s*(?:\/\s*10)?/i);
    if (match) return parseFloat(match[1]);

    // If it's a SHAABAN ELITE SIGNAL, give full default score
    if (/ELITE\s*SIGNAL/i.test(text)) return 10;

    return null;
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
    if (!text) return false;
    const cleaned = this.cleanText(text);

    const hasSymbol = /#[A-Za-z0-9]+/i.test(cleaned) || 
                      /^([A-Z0-9]{2,10})\s*[|\-\/]/i.test(cleaned) ||
                      /[A-Z0-9]{2,10}\/(USDT|USDC|BTC)/i.test(cleaned);
                      
    const hasStatusChange = /(?:status|update|حالة|تحديث)[:\s]*(?:🟢|🔴|🟡)?\s*(closed|hit|cancelled|partial|open|مغلقة|تم|ضرب|ملغاة)/i.test(cleaned);
    const hasTPHit = /(?:TP\s*\d|[1-4]️⃣|[1-4]⃣|الهدف\s*(?:\d|الأول|الاول|الثاني|الثالث|الرابع)|تم\s*تحقيق\s*الهدف|ضرب\s*الهدف|وصل\s*الهدف|تحقيق\s*الهدف)/i.test(cleaned);
    const hasSLHit = /(?:SL|stop\s*loss|الستوب|وقف\s*الخسارة)\s*(?:hit|✅|reached|triggered|ضرب|ضربت)|(?:ضرب\s*الستوب|ضرب\s*وقف\s*الخسارة)/i.test(cleaned);

    return hasSymbol && (hasStatusChange || hasTPHit || hasSLHit);
  }

  /**
   * Extract which TPs were hit from an update message
   */
  extractHitTargets(text) {
    if (!text) return [];
    const cleaned = this.cleanText(text);
    const hits = [];
    
    // Numeric TPs: "TP2 hit", "الهدف 2 تم", "2️⃣ ✅"
    const regex = /(?:TP|الهدف\s*|[1-4]️⃣|[1-4]⃣)?(\d)\s*(?:hit|✅|reached|done|تحقق|تم|ضرب)/gi;
    let match;
    while ((match = regex.exec(cleaned)) !== null) {
      hits.push(parseInt(match[1]));
    }

    // Arabic words: "الهدف الأول", "الهدف الثاني", "الهدف الثالث", "الهدف الرابع"
    const wordMap = { 'الأول': 1, 'الاول': 1, 'الثاني': 2, 'الثالث': 3, 'الرابع': 4, 'الخامس': 5 };
    for (const [word, num] of Object.entries(wordMap)) {
      if (cleaned.includes(`الهدف ${word}`) || cleaned.includes(`هدف ${word}`)) {
        if (!hits.includes(num)) hits.push(num);
      }
    }

    return hits;
  }

  /**
   * Check if a message is a "Close All" command
   */
  isCloseAll(text) {
    if (!text || typeof text !== 'string') return false;
    const cleaned = this.cleanText(text);
    
    const hasAllPositions = /all\s*positions/i.test(cleaned);
    const hasBeenClosed = /been\s*closed/i.test(cleaned);
    const hasNoActive = /no\s*active\s*positions/i.test(cleaned);
    
    // Arabic patterns
    const hasArabicClose = /إغلاق\s*جميع\s*الصفقات/i.test(cleaned);
    const hasArabicNoActive = /لا\s*توجد\s*صفقات\s*مفتوحة/i.test(cleaned);

    return (hasAllPositions && hasBeenClosed) || hasNoActive || hasArabicClose || hasArabicNoActive;
  }
}

module.exports = new SignalParser();

const crypto = require('crypto');
const axios = require('axios');
const axiosRetry = require('axios-retry').default;
const config = require('../config');
const logger = require('../utils/logger');

class MexcClient {
  constructor() {
    this.baseUrl = config.mexc.baseUrl;
    this.apiKey = config.mexc.apiKey;
    this.secretKey = config.mexc.secretKey;
    this.recvWindow = config.mexc.recvWindow;

    this.client = axios.create({
      baseURL: this.baseUrl,
      timeout: 15000,
      headers: {
        'X-MEXC-APIKEY': this.apiKey,
        'Content-Type': 'application/json',
      },
    });

    // Configure retries
    axiosRetry(this.client, {
      retries: 3,
      retryDelay: (retryCount) => {
        logger.warn(`🔄 Retrying MEXC API call (attempt ${retryCount})...`);
        return retryCount * 2000; // 2s, 4s, 6s
      },
      retryCondition: (error) => {
        return axiosRetry.isNetworkOrIdempotentRequestError(error) || 
               (error.response && (error.response.status >= 500 || error.response.status === 429));
      },
    });
  }

  /**
   * Generate HMAC SHA256 signature
   */
  sign(queryString) {
    return crypto
      .createHmac('sha256', this.secretKey)
      .update(queryString)
      .digest('hex');
  }

  /**
   * Build signed query string with timestamp and signature
   */
  buildSignedParams(params = {}) {
    params.timestamp = Date.now();
    params.recvWindow = this.recvWindow;

    const queryString = Object.entries(params)
      .map(([key, val]) => `${key}=${val}`)
      .join('&');

    const signature = this.sign(queryString);
    return `${queryString}&signature=${signature}`;
  }

  // ========================
  // Public Endpoints
  // ========================

  /**
   * Test connectivity
   */
  async ping() {
    try {
      const res = await this.client.get('/api/v3/ping');
      return res.data;
    } catch (err) {
      logger.error('MEXC ping failed', { error: err.message });
      throw err;
    }
  }

  /**
   * Get server time
   */
  async getServerTime() {
    const res = await this.client.get('/api/v3/time');
    return res.data.serverTime;
  }

  /**
   * Get exchange info for a symbol
   */
  async getExchangeInfo(symbol) {
    try {
      const res = await this.client.get('/api/v3/exchangeInfo', {
        params: symbol ? { symbol } : {},
      });
      if (symbol) {
        const symbolInfo = res.data.symbols
          ? res.data.symbols.find((s) => s.symbol === symbol)
          : res.data;
        return symbolInfo;
      }
      return res.data;
    } catch (err) {
      logger.error('Failed to get exchange info', { error: err.message, symbol });
      throw err;
    }
  }

  /**
   * Get current price for a symbol
   */
  async getSymbolPrice(symbol) {
    try {
      const res = await this.client.get('/api/v3/ticker/price', {
        params: { symbol },
      });
      return parseFloat(res.data.price);
    } catch (err) {
      logger.error('Failed to get symbol price', { error: err.message, symbol });
      throw err;
    }
  }

  /**
   * Get all symbol prices
   */
  async getAllPrices() {
    try {
      const res = await this.client.get('/api/v3/ticker/price');
      return res.data; // Array of {symbol, price}
    } catch (err) {
      logger.error('Failed to get all prices', { error: err.message });
      throw err;
    }
  }
  async getDepth(symbol, limit = 5) {
    try {
      const res = await this.client.get('/api/v3/depth', {
        params: { symbol, limit },
      });
      return res.data;
    } catch (err) {
      logger.error('Failed to get depth', { error: err.message, symbol });
      throw err;
    }
  }

  /**
   * Get 24hr ticker stats
   */
  async get24hrTicker(symbol) {
    const res = await this.client.get('/api/v3/ticker/24hr', {
      params: { symbol },
    });
    return res.data;
  }

  // ========================
  // Signed Endpoints
  // ========================

  /**
   * Get account information (balances)
   */
  async getAccountInfo() {
    try {
      const signedParams = this.buildSignedParams({});
      const res = await this.client.get(`/api/v3/account?${signedParams}`);
      return res.data;
    } catch (err) {
      logger.error('Failed to get account info', { error: err.message });
      throw err;
    }
  }

  /**
   * Get USDT balance
   */
  async getUsdtBalance() {
    try {
      const account = await this.getAccountInfo();
      const usdtAsset = account.balances.find((b) => b.asset === 'USDT');
      return usdtAsset
        ? { free: parseFloat(usdtAsset.free), locked: parseFloat(usdtAsset.locked) }
        : { free: 0, locked: 0 };
    } catch (err) {
      logger.error('Failed to get USDT balance', { error: err.message });
      return { free: 0, locked: 0 };
    }
  }

  /**
   * Place a new order
   * @param {object} params - { symbol, side, type, quantity, price?, stopPrice? }
   */
  async createOrder({ symbol, side, type, quantity, price, quoteOrderQty, stopPrice }) {
    try {
      const orderParams = { symbol, side, type };

      if (quantity) orderParams.quantity = quantity;
      if (price) orderParams.price = price;
      if (quoteOrderQty) orderParams.quoteOrderQty = quoteOrderQty;
      if (stopPrice) orderParams.stopPrice = stopPrice;

      const signedParams = this.buildSignedParams(orderParams);

      logger.info(`📤 Creating order: ${side} ${symbol}`, {
        type,
        quantity,
        price,
        stopPrice,
      });

      const res = await this.client.post(`/api/v3/order?${signedParams}`);

      logger.info(`✅ Order created: ${res.data.orderId}`, {
        symbol: res.data.symbol,
        side: res.data.side,
        price: res.data.price,
      });

      return res.data;
    } catch (err) {
      const errData = err.response?.data || {};
      logger.error('❌ Failed to create order', {
        error: err.message,
        code: errData.code,
        msg: errData.msg,
        symbol,
        side,
        type,
      });
      throw err;
    }
  }

  /**
   * Cancel an order
   */
  async cancelOrder(symbol, orderId) {
    try {
      const signedParams = this.buildSignedParams({ symbol, orderId });
      const res = await this.client.delete(`/api/v3/order?${signedParams}`);
      logger.info(`❎ Order cancelled: ${orderId}`, { symbol });
      return res.data;
    } catch (err) {
      logger.error('Failed to cancel order', { error: err.message, symbol, orderId });
      throw err;
    }
  }

  /**
   * Query an order's status
   */
  async getOrder(symbol, orderId) {
    try {
      const signedParams = this.buildSignedParams({ symbol, orderId });
      const res = await this.client.get(`/api/v3/order?${signedParams}`);
      return res.data;
    } catch (err) {
      logger.error('Failed to get order', { error: err.message, symbol, orderId });
      throw err;
    }
  }

  /**
   * Get all open orders for a symbol
   */
  async getOpenOrders(symbol) {
    try {
      const params = symbol ? { symbol } : {};
      const signedParams = this.buildSignedParams(params);
      const res = await this.client.get(`/api/v3/openOrders?${signedParams}`);
      return res.data;
    } catch (err) {
      logger.error('Failed to get open orders', { error: err.message, symbol });
      throw err;
    }
  }

  /**
   * Check if a symbol exists and is tradeable on MEXC
   */
  async isSymbolAvailable(symbol) {
    try {
      const info = await this.getExchangeInfo(symbol);
      // MEXC API often uses '1' for enabled, but check for 'ENABLED' as well for safety
      const isEnabled = info && (info.status === '1' || info.status === 1 || info.status === 'ENABLED');
      return isEnabled && info.isSpotTradingAllowed !== false;
    } catch {
      return false;
    }
  }

  /**
   * Calculate correct quantity based on exchange precision
   */
  async calculateQuantity(symbol, usdtAmount) {
    try {
      const [price, info] = await Promise.all([
        this.getSymbolPrice(symbol),
        this.getExchangeInfo(symbol),
      ]);

      if (!price || price <= 0) {
        throw new Error(`Invalid price for ${symbol}: ${price}`);
      }

      let rawQty = usdtAmount / price;

      // Apply precision from exchange info
      const basePrecision = info?.baseAssetPrecision || 2;
      const baseSizePrecision = info?.baseSizePrecision
        ? parseFloat(info.baseSizePrecision)
        : null;

      if (baseSizePrecision && baseSizePrecision > 0) {
        // Round down to the nearest step size
        rawQty = Math.floor(rawQty / baseSizePrecision) * baseSizePrecision;
      }

      // Apply decimal precision
      const factor = Math.pow(10, basePrecision);
      rawQty = Math.floor(rawQty * factor) / factor;

      return {
        quantity: rawQty,
        price,
        basePrecision,
        baseSizePrecision,
      };
    } catch (err) {
      logger.error('Failed to calculate quantity', { error: err.message, symbol });
      throw err;
    }
  }
}

module.exports = new MexcClient();

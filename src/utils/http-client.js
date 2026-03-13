import axios from 'axios';
import pRetry from 'p-retry';
import { config } from '../config/index.js';
import { logger } from './logger.js';

const ROTATING_USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_4_1) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4.1 Safari/605.1.15',
];

function randomUserAgent() {
  return ROTATING_USER_AGENTS[Math.floor(Math.random() * ROTATING_USER_AGENTS.length)];
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function jitter(baseMs) {
  // Add ±30% random jitter to avoid thundering herd
  return baseMs + Math.floor((Math.random() - 0.5) * baseMs * 0.6);
}

function buildAxiosInstance() {
  const axiosConfig = {
    timeout: 30000,
    headers: {
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.5',
      'Accept-Encoding': 'gzip, deflate, br',
      'Connection': 'keep-alive',
    },
  };

  if (config.proxy.enabled) {
    axiosConfig.proxy = {
      host: config.proxy.host,
      port: config.proxy.port,
      auth: { username: config.proxy.user, password: config.proxy.pass },
    };
    logger.debug('Proxy enabled', { host: config.proxy.host });
  }

  return axios.create(axiosConfig);
}

const client = buildAxiosInstance();

/**
 * Fetch a URL with automatic retry, rate limiting, and rotating user agents.
 * @param {string} url
 * @param {object} options
 * @returns {Promise<{html: string, url: string, status: number, fetchedAt: string}>}
 */
export async function fetchPage(url, options = {}) {
  const { delayMs = config.scraping.requestDelayMs, retries = config.scraping.maxRetries } = options;

  return pRetry(async (attemptNumber) => {
    if (attemptNumber > 1) {
      const backoffMs = jitter(delayMs * Math.pow(2, attemptNumber - 1));
      logger.debug(`Retry ${attemptNumber} for ${url}, waiting ${backoffMs}ms`);
      await sleep(backoffMs);
    } else {
      await sleep(jitter(delayMs));
    }

    const userAgent = randomUserAgent();
    logger.debug(`Fetching ${url}`, { attempt: attemptNumber, userAgent: userAgent.slice(0, 40) });

    const response = await client.get(url, {
      headers: { 'User-Agent': userAgent },
    });

    return {
      html: response.data,
      url,
      status: response.status,
      fetchedAt: new Date().toISOString(),
    };
  }, {
    retries,
    onFailedAttempt: (error) => {
      logger.warn(`Fetch failed for ${url}`, {
        attempt: error.attemptNumber,
        retriesLeft: error.retriesLeft,
        status: error.response?.status,
        message: error.message,
      });
      // Don't retry on 404 or 403 — they won't change
      if (error.response?.status === 404 || error.response?.status === 403) {
        throw new pRetry.AbortError(`Non-retryable status ${error.response.status} for ${url}`);
      }
    },
  });
}

/**
 * Fetch a JSON API endpoint (used for ATS APIs like Greenhouse/Lever)
 */
export async function fetchJson(url, options = {}) {
  const { delayMs = config.scraping.requestDelayMs, retries = config.scraping.maxRetries } = options;

  return pRetry(async (attemptNumber) => {
    if (attemptNumber > 1) {
      await sleep(jitter(delayMs * Math.pow(2, attemptNumber - 1)));
    } else {
      await sleep(jitter(delayMs));
    }

    const response = await client.get(url, {
      headers: {
        'User-Agent': randomUserAgent(),
        'Accept': 'application/json',
      },
    });

    return response.data;
  }, {
    retries,
    onFailedAttempt: (error) => {
      logger.warn(`JSON fetch failed for ${url}`, {
        attempt: error.attemptNumber,
        status: error.response?.status,
      });
      if (error.response?.status === 404 || error.response?.status === 410) {
        throw new pRetry.AbortError(`Non-retryable ${error.response.status}`);
      }
    },
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// services/KlineService.ts — Binance Futures Kline + OI History Proxy
// ─────────────────────────────────────────────────────────────────────────────
// Binance USDT-M Futures kline + OI History verilerini çeker.
// Cache: interval bazlı, 10 saniye TTL.
// ─────────────────────────────────────────────────────────────────────────────

import axios from 'axios';
import { Logger } from '../utils/logger.js';

const log = new Logger('KlineService');

const BINANCE_FAPI = 'https://fapi.binance.com';
const TIMEOUT = 10_000;

// Geçerli interval'ler
const VALID_INTERVALS = new Set([
  '1m', '3m', '5m', '15m', '30m',
  '1h', '2h', '4h', '6h', '8h', '12h',
  '1d', '3d', '1w', '1M',
]);

// OI History geçerli periyodlar
const VALID_OI_PERIODS = new Set([
  '5m', '15m', '30m', '1h', '2h', '4h', '6h', '12h', '1d',
]);

export interface KlineBar {
  time: number;      // open time (seconds, UTC)
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;    // base asset volume
  turnover: number;  // quote asset volume (USDT)
  takerBuyVolume: number;   // taker buy base asset volume
  takerBuyTurnover: number; // taker buy quote asset volume
}

export interface OIHistoryBar {
  time: number;       // timestamp (seconds, UTC)
  sumOpenInterest: number;       // OI in contracts
  sumOpenInterestValue: number;  // OI in USDT
}

// ── Cache ────────────────────────────────────────────────────────────────────
interface CacheEntry<T> {
  data: T;
  ts: number;
}

const klineCache = new Map<string, CacheEntry<KlineBar[]>>();
const oiCache = new Map<string, CacheEntry<OIHistoryBar[]>>();
const CACHE_TTL = 10_000; // 10s

function cacheKey(prefix: string, symbol: string, interval: string, limit: number): string {
  return `${prefix}_${symbol}_${interval}_${limit}`;
}

// ── Fetch Klines ─────────────────────────────────────────────────────────────

export async function fetchKlines(
  symbol: string,
  interval: string,
  limit: number = 500,
): Promise<KlineBar[]> {
  if (!VALID_INTERVALS.has(interval)) {
    throw new Error(`Geçersiz interval: ${interval}`);
  }

  const key = cacheKey('kline', symbol, interval, limit);
  const cached = klineCache.get(key);
  if (cached && Date.now() - cached.ts < CACHE_TTL) {
    return cached.data;
  }

  try {
    const resp = await axios.get(`${BINANCE_FAPI}/fapi/v1/klines`, {
      params: { symbol, interval, limit },
      timeout: TIMEOUT,
    });

    // Binance kline response: array of arrays
    // [0:openTime, 1:open, 2:high, 3:low, 4:close, 5:volume, 6:closeTime,
    //  7:quoteVolume, 8:count, 9:takerBuyBaseVol, 10:takerBuyQuoteVol, 11:ignore]
    const raw = resp.data as unknown[][];

    const bars: KlineBar[] = raw.map((k) => ({
      time: Math.floor(Number(k[0]) / 1000), // ms → seconds
      open: parseFloat(String(k[1])),
      high: parseFloat(String(k[2])),
      low: parseFloat(String(k[3])),
      close: parseFloat(String(k[4])),
      volume: parseFloat(String(k[5])),
      turnover: parseFloat(String(k[7])),
      takerBuyVolume: parseFloat(String(k[9])),
      takerBuyTurnover: parseFloat(String(k[10])),
    }));

    klineCache.set(key, { data: bars, ts: Date.now() });
    return bars;
  } catch (err) {
    log.error(`Kline fetch error (${symbol} ${interval})`, err instanceof Error ? err : new Error(String(err)));
    throw err;
  }
}

// ── Fetch OI History ─────────────────────────────────────────────────────────

export async function fetchOIHistory(
  symbol: string,
  period: string,
  limit: number = 500,
): Promise<OIHistoryBar[]> {
  if (!VALID_OI_PERIODS.has(period)) {
    throw new Error(`Geçersiz OI period: ${period}`);
  }

  const key = cacheKey('oi', symbol, period, limit);
  const cached = oiCache.get(key);
  if (cached && Date.now() - cached.ts < CACHE_TTL) {
    return cached.data;
  }

  try {
    // Binance limit max 500
    const resp = await axios.get(`${BINANCE_FAPI}/futures/data/openInterestHist`, {
      params: { symbol, period, limit: Math.min(limit, 500) },
      timeout: TIMEOUT,
    });

    // Response: [{ symbol, sumOpenInterest, sumOpenInterestValue, timestamp }, ...]
    const raw = resp.data as Array<{
      symbol: string;
      sumOpenInterest: string;
      sumOpenInterestValue: string;
      timestamp: number;
    }>;

    const bars: OIHistoryBar[] = raw.map((r) => ({
      time: Math.floor(r.timestamp / 1000), // ms → seconds
      sumOpenInterest: parseFloat(r.sumOpenInterest),
      sumOpenInterestValue: parseFloat(r.sumOpenInterestValue),
    }));

    oiCache.set(key, { data: bars, ts: Date.now() });
    return bars;
  } catch (err) {
    log.error(`OI History fetch error (${symbol} ${period})`, err instanceof Error ? err : new Error(String(err)));
    throw err;
  }
}

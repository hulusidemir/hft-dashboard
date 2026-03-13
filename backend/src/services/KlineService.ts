// ─────────────────────────────────────────────────────────────────────────────
// services/KlineService.ts — Multi-Exchange Kline + OI History Proxy
// ─────────────────────────────────────────────────────────────────────────────
// Binance / Bybit / OKX USDT-M Futures kline + OI History verilerini çeker.
// Cache: exchange+interval bazlı, 10 saniye TTL.
// ─────────────────────────────────────────────────────────────────────────────

import axios from 'axios';
import { Logger } from '../utils/logger.js';

const log = new Logger('KlineService');

const BINANCE_FAPI = 'https://fapi.binance.com';
const BYBIT_REST   = 'https://api.bybit.com';
const OKX_REST     = 'https://www.okx.com';
const TIMEOUT = 10_000;

// ── Exchange type ────────────────────────────────────────────────────────────
export type KlineExchange = 'binance' | 'bybit' | 'okx';

// Geçerli interval'ler (Binance format — canonical)
const VALID_INTERVALS = new Set([
  '1m', '3m', '5m', '15m', '30m',
  '1h', '2h', '4h', '6h', '8h', '12h',
  '1d', '3d', '1w', '1M',
]);

// OI History geçerli periyodlar
const VALID_OI_PERIODS = new Set([
  '5m', '15m', '30m', '1h', '2h', '4h', '6h', '12h', '1d',
]);

// ── Bybit interval mapping (Binance format → Bybit format) ──────────────────
// Bybit uses minutes as string: '1','3','5','15','30','60','120','240','360','720','D','W','M'
const BYBIT_INTERVAL_MAP: Record<string, string> = {
  '1m': '1', '3m': '3', '5m': '5', '15m': '15', '30m': '30',
  '1h': '60', '2h': '120', '4h': '240', '6h': '360', '8h': '480', '12h': '720',
  '1d': 'D', '3d': 'D', '1w': 'W', '1M': 'M',
};

// ── OKX bar mapping (Binance format → OKX format) ───────────────────────────
// OKX uses: '1m','3m','5m','15m','30m','1H','2H','4H','6H','12H','1D','1W','1M'
const OKX_BAR_MAP: Record<string, string> = {
  '1m': '1m', '3m': '3m', '5m': '5m', '15m': '15m', '30m': '30m',
  '1h': '1H', '2h': '2H', '4h': '4H', '6h': '6H', '8h': '6H', '12h': '12H',
  '1d': '1D', '3d': '1D', '1w': '1W', '1M': '1M',
};

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

function cacheKey(prefix: string, exchange: string, symbol: string, interval: string, limit: number): string {
  return `${prefix}_${exchange}_${symbol}_${interval}_${limit}`;
}

// ── Symbol Helpers ───────────────────────────────────────────────────────────
/** BTCUSDT → BTC-USDT-SWAP */
function toOkxInstId(symbol: string): string {
  const base = symbol.replace(/USDT$/i, '');
  return `${base}-USDT-SWAP`;
}

// ── Fetch Klines (Multi-Exchange) ────────────────────────────────────────────

export async function fetchKlines(
  symbol: string,
  interval: string,
  limit: number = 500,
  exchange: KlineExchange = 'binance',
): Promise<KlineBar[]> {
  if (!VALID_INTERVALS.has(interval)) {
    throw new Error(`Geçersiz interval: ${interval}`);
  }

  const key = cacheKey('kline', exchange, symbol, interval, limit);
  const cached = klineCache.get(key);
  if (cached && Date.now() - cached.ts < CACHE_TTL) {
    return cached.data;
  }

  let bars: KlineBar[];

  switch (exchange) {
    case 'bybit':
      bars = await fetchBybitKlines(symbol, interval, limit);
      break;
    case 'okx':
      bars = await fetchOkxKlines(symbol, interval, limit);
      break;
    case 'binance':
    default:
      bars = await fetchBinanceKlines(symbol, interval, limit);
      break;
  }

  klineCache.set(key, { data: bars, ts: Date.now() });
  return bars;
}

// ── Binance ──────────────────────────────────────────────────────────────────
async function fetchBinanceKlines(
  symbol: string,
  interval: string,
  limit: number,
): Promise<KlineBar[]> {
  try {
    const resp = await axios.get(`${BINANCE_FAPI}/fapi/v1/klines`, {
      params: { symbol, interval, limit },
      timeout: TIMEOUT,
    });

    // [0:openTime, 1:open, 2:high, 3:low, 4:close, 5:volume, 6:closeTime,
    //  7:quoteVolume, 8:count, 9:takerBuyBaseVol, 10:takerBuyQuoteVol, 11:ignore]
    const raw = resp.data as unknown[][];

    return raw.map((k) => ({
      time: Math.floor(Number(k[0]) / 1000),
      open: parseFloat(String(k[1])),
      high: parseFloat(String(k[2])),
      low: parseFloat(String(k[3])),
      close: parseFloat(String(k[4])),
      volume: parseFloat(String(k[5])),
      turnover: parseFloat(String(k[7])),
      takerBuyVolume: parseFloat(String(k[9])),
      takerBuyTurnover: parseFloat(String(k[10])),
    }));
  } catch (err) {
    log.error(`Binance kline fetch error (${symbol} ${interval})`, err instanceof Error ? err : new Error(String(err)));
    throw err;
  }
}

// ── Bybit ────────────────────────────────────────────────────────────────────
async function fetchBybitKlines(
  symbol: string,
  interval: string,
  limit: number,
): Promise<KlineBar[]> {
  const bybitInterval = BYBIT_INTERVAL_MAP[interval] ?? '5';
  const bybitLimit = Math.min(limit, 1000); // Bybit max 1000

  try {
    const resp = await axios.get(`${BYBIT_REST}/v5/market/kline`, {
      params: { category: 'linear', symbol, interval: bybitInterval, limit: bybitLimit },
      timeout: TIMEOUT,
    });

    // Bybit response: result.list — array of string arrays (newest first!)
    // [0:startTime(ms), 1:open, 2:high, 3:low, 4:close, 5:volume, 6:turnover]
    const raw = (resp.data?.result?.list ?? []) as string[][];

    // Bybit returns newest first — reverse to chronological order
    const bars: KlineBar[] = raw.reverse().map((k) => ({
      time: Math.floor(Number(k[0]) / 1000),
      open: parseFloat(k[1]!),
      high: parseFloat(k[2]!),
      low: parseFloat(k[3]!),
      close: parseFloat(k[4]!),
      volume: parseFloat(k[5]!),
      turnover: parseFloat(k[6]!),
      takerBuyVolume: 0,   // Bybit kline has no taker buy breakdown
      takerBuyTurnover: 0,
    }));

    return bars;
  } catch (err) {
    log.error(`Bybit kline fetch error (${symbol} ${interval})`, err instanceof Error ? err : new Error(String(err)));
    throw err;
  }
}

// ── OKX ──────────────────────────────────────────────────────────────────────
async function fetchOkxKlines(
  symbol: string,
  interval: string,
  limit: number,
): Promise<KlineBar[]> {
  const instId = toOkxInstId(symbol);
  const bar = OKX_BAR_MAP[interval] ?? '5m';
  const okxLimit = Math.min(limit, 300); // OKX max 300 per request

  try {
    const resp = await axios.get(`${OKX_REST}/api/v5/market/candles`, {
      params: { instId, bar, limit: okxLimit },
      timeout: TIMEOUT,
    });

    // OKX response: data — array of string arrays (newest first!)
    // [0:ts(ms), 1:open, 2:high, 3:low, 4:close, 5:vol, 6:volCcy, 7:volCcyQuote, 8:confirm]
    const raw = (resp.data?.data ?? []) as string[][];

    // OKX returns newest first — reverse to chronological order
    const bars: KlineBar[] = raw.reverse().map((k) => ({
      time: Math.floor(Number(k[0]) / 1000),
      open: parseFloat(k[1]!),
      high: parseFloat(k[2]!),
      low: parseFloat(k[3]!),
      close: parseFloat(k[4]!),
      volume: parseFloat(k[5]!),
      turnover: parseFloat(k[7]!),     // volCcyQuote = USDT turnover
      takerBuyVolume: 0,
      takerBuyTurnover: 0,
    }));

    return bars;
  } catch (err) {
    log.error(`OKX kline fetch error (${symbol} ${interval})`, err instanceof Error ? err : new Error(String(err)));
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

  const key = cacheKey('oi', 'binance', symbol, period, limit);
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

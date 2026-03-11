// ─────────────────────────────────────────────────────────────────────────────
// services/MrService.ts — COIN MR (Market Reconnaissance) Servisi v3
// ─────────────────────────────────────────────────────────────────────────────
//
// ASKERİ STANDART — 3 borsadan eşzamanlı REST çekimleri:
//   1. Kesin startTime / endTime hesabı (zaman dilimine tepki verir)
//   2. OI: Anlık + Tarihsel → oiDelta hesabı
//   3. Tasfiyeler: SQLite DB'den gerçek WS verisiyle sorgulanır
//   4. OKX L/S: Doğru endpoint + doğru JSON parse
//   5. CVD: Her borsanın kline taker buy/sell deltası
//
// ─────────────────────────────────────────────────────────────────────────────

import axios from 'axios';
import { Logger } from '../utils/logger.js';
import {
  getSymbolConfig,
  toBinanceRestSymbol,
  toOkxSymbol,
} from '../config/symbols.js';
import { queryLiqForMR } from '../db/LiquidationDB.js';

const log = new Logger('MrService');

// ── REST Base URL'ler ────────────────────────────────────────────────────────
const BINANCE_REST = 'https://fapi.binance.com';
const BYBIT_REST   = 'https://api.bybit.com';
const OKX_REST     = 'https://www.okx.com';

const TIMEOUT = 15_000;

// ── Zaman Dilimi Eşlemesi ────────────────────────────────────────────────────
export type MrTimeframe = '15m' | '1h' | '4h' | '24h';

interface TimeframeConfig {
  /** Milisaniye cinsinden süre */
  periodMs: number;
  /** Binance kline interval string */
  binanceKline: string;
  /** Bybit kline interval (dakika veya D) */
  bybitKline: string;
  /** OKX candle bar string */
  okxBar: string;
  /** Binance globalLongShortAccountRatio period */
  binanceLsrPeriod: string;
  /** Bybit account-ratio period */
  bybitLsrPeriod: string;
  /** Bybit OI interval: 5min, 15min, 30min, 1h, 4h, 1d */
  bybitOiInterval: string;
  /** Liq/CVD hesabı için granüler Binance kline interval */
  liqBinKline: string;
  /** Liq/CVD hesabı için granüler Bybit kline interval */
  liqBybKline: string;
  /** Liq/CVD hesabı için granüler OKX bar */
  liqOkxBar: string;
  /** Liq/CVD kline interval milisaniye (chunking hesabı için) */
  liqIntervalMs: number;
}

const TIMEFRAME_MAP: Record<MrTimeframe, TimeframeConfig> = {
  '15m': {
    periodMs: 15 * 60 * 1000,
    binanceKline: '15m',
    bybitKline: '15',
    okxBar: '15m',
    binanceLsrPeriod: '15m',
    bybitLsrPeriod: '15min',
    bybitOiInterval: '15min',
    liqBinKline: '5m',
    liqBybKline: '5',
    liqOkxBar: '5m',
    liqIntervalMs: 5 * 60 * 1000,
  },
  '1h': {
    periodMs: 60 * 60 * 1000,
    binanceKline: '1h',
    bybitKline: '60',
    okxBar: '1H',
    binanceLsrPeriod: '1h',
    bybitLsrPeriod: '1h',
    bybitOiInterval: '1h',
    liqBinKline: '15m',
    liqBybKline: '15',
    liqOkxBar: '15m',
    liqIntervalMs: 15 * 60 * 1000,
  },
  '4h': {
    periodMs: 4 * 60 * 60 * 1000,
    binanceKline: '4h',
    bybitKline: '240',
    okxBar: '4H',
    binanceLsrPeriod: '4h',
    bybitLsrPeriod: '4h',
    bybitOiInterval: '4h',
    liqBinKline: '15m',
    liqBybKline: '15',
    liqOkxBar: '15m',
    liqIntervalMs: 15 * 60 * 1000,
  },
  '24h': {
    periodMs: 24 * 60 * 60 * 1000,
    binanceKline: '1d',
    bybitKline: 'D',
    okxBar: '1D',
    binanceLsrPeriod: '1d',
    bybitLsrPeriod: '1d',
    bybitOiInterval: '1d',
    liqBinKline: '1h',
    liqBybKline: '60',
    liqOkxBar: '1H',
    liqIntervalMs: 60 * 60 * 1000,
  },
};

// ── Sonuç Tipleri ────────────────────────────────────────────────────────────

export interface ExchangeMrData {
  openInterest: number;       // Anlık OI (USD)
  oiDelta: number;            // Zaman dilimindeki OI değişimi (USD)
  fundingRate: number;
  nextFundingTime: number;    // ms epoch — sonraki funding zamanı
  fundingIntervalHours: number; // Kaç saatte bir funding
  longShortRatio: number;
  longRatio: number;
  shortRatio: number;
  liqLongUsd: number;
  liqShortUsd: number;
  liqEstimated: boolean;     // true → OI ağırlıklı tahmin (ör. Bybit API yok)
  netCvd: number;
  orderbookBids: [number, number][];
  orderbookAsks: [number, number][];
}

export interface AggregatedMrData {
  totalOI: number;
  oiDelta: number;
  avgFunding: number;
  nearestFundingTime: number;  // ms epoch — en yakın funding zamanı
  combinedLongRatio: number;
  combinedShortRatio: number;
  combinedLongShortRatio: number;
  totalLiqLongUsd: number;
  totalLiqShortUsd: number;
  totalNetCvd: number;
  combinedOrderbookBids: [number, number][];
  combinedOrderbookAsks: [number, number][];
}

export interface MrResult {
  symbol: string;
  timeframe: MrTimeframe;
  timestamp: number;
  exchanges: {
    binance: ExchangeMrData;
    bybit: ExchangeMrData;
    okx: ExchangeMrData;
  };
  aggregated: AggregatedMrData;
}

// ── Funding bilgisi dönüş tipi ───────────────────────────────────────────────
interface FundingInfo {
  rate: number;
  nextFundingTime: number;   // ms epoch
  intervalHours: number;
}

// ── Yardımcı: Güvenli sayı parse ────────────────────────────────────────────
function sf(v: unknown): number {
  const n = parseFloat(String(v ?? '0'));
  return isFinite(n) ? n : 0;
}

// ── Binance fundingInfo önbelleği (interval saatini almak için) ──────────────
let binFundingInfoCache = new Map<string, number>(); // symbol → intervalHours
let binFundingInfoTs = 0;
const FUNDING_INFO_TTL = 60 * 60 * 1000; // 1 saat cache

async function ensureBinFundingInfo(): Promise<void> {
  if (Date.now() - binFundingInfoTs < FUNDING_INFO_TTL && binFundingInfoCache.size > 0) return;
  try {
    const r = await axios.get(`${BINANCE_REST}/fapi/v1/fundingInfo`, { timeout: TIMEOUT });
    const data = r.data as Array<{ symbol: string; fundingIntervalHours: number }>;
    const map = new Map<string, number>();
    for (const item of data) {
      map.set(item.symbol, item.fundingIntervalHours);
    }
    binFundingInfoCache = map;
    binFundingInfoTs = Date.now();
    log.debug(`Binance fundingInfo cached: ${map.size} symbols`);
  } catch (e: unknown) {
    log.warn('BIN fundingInfo cache fail', e instanceof Error ? e : undefined);
  }
}

// ── Chunked Kline Fetchers ──────────────────────────────────────────────────
// API limit aşılırsa zaman aralığını parçalara böler ve Promise.all ile çeker.

const BIN_KLINE_LIMIT = 1500;
const BYB_KLINE_LIMIT = 200;
const OKX_KLINE_LIMIT = 300;

function timeChunks(
  startTime: number,
  endTime: number,
  intervalMs: number,
  maxBars: number,
): Array<[number, number]> {
  const totalBars = Math.ceil((endTime - startTime) / intervalMs);
  if (totalBars <= maxBars) return [[startTime, endTime]];
  const chunkMs = maxBars * intervalMs;
  const chunks: Array<[number, number]> = [];
  let cur = startTime;
  while (cur < endTime) {
    chunks.push([cur, Math.min(cur + chunkMs, endTime)]);
    cur += chunkMs;
  }
  return chunks;
}

async function fetchBinKlines(
  symbol: string,
  interval: string,
  startTime: number,
  endTime: number,
  intervalMs: number,
): Promise<unknown[][]> {
  const chunks = timeChunks(startTime, endTime, intervalMs, BIN_KLINE_LIMIT);
  const results = await Promise.all(
    chunks.map(([s, e]) =>
      axios
        .get(`${BINANCE_REST}/fapi/v1/klines`, {
          params: { symbol, interval, startTime: s, endTime: e, limit: BIN_KLINE_LIMIT },
          timeout: TIMEOUT,
        })
        .then(r => (r.data ?? []) as unknown[][])
        .catch(() => [] as unknown[][]),
    ),
  );
  return results.flat();
}

async function fetchBybKlines(
  symbol: string,
  interval: string,
  startTime: number,
  endTime: number,
  intervalMs: number,
): Promise<string[][]> {
  const chunks = timeChunks(startTime, endTime, intervalMs, BYB_KLINE_LIMIT);
  const results = await Promise.all(
    chunks.map(([s, e]) =>
      axios
        .get(`${BYBIT_REST}/v5/market/kline`, {
          params: { category: 'linear', symbol, interval, start: s, end: e, limit: BYB_KLINE_LIMIT },
          timeout: TIMEOUT,
        })
        .then(r => (r.data?.result?.list ?? []) as string[][])
        .catch(() => [] as string[][]),
    ),
  );
  return results.flat();
}

async function fetchOkxKlines(
  instId: string,
  bar: string,
  startTime: number,
  endTime: number,
  intervalMs: number,
): Promise<string[][]> {
  const chunks = timeChunks(startTime, endTime, intervalMs, OKX_KLINE_LIMIT);
  const results = await Promise.all(
    chunks.map(([s, e]) =>
      axios
        .get(`${OKX_REST}/api/v5/market/candles`, {
          params: { instId, bar, after: e, before: s, limit: OKX_KLINE_LIMIT },
          timeout: TIMEOUT,
        })
        .then(r => (r.data?.data ?? []) as string[][])
        .catch(() => [] as string[][]),
    ),
  );
  return results.flat();
}

// ═════════════════════════════════════════════════════════════════════════════
//  BINANCE
// ═════════════════════════════════════════════════════════════════════════════

/** Anlık OI (base cinsinden — sonra midPrice ile USD'ye çevrilecek) */
async function binOI(symbol: string): Promise<number> {
  try {
    const r = await axios.get(`${BINANCE_REST}/fapi/v1/openInterest`, {
      params: { symbol },
      timeout: TIMEOUT,
    });
    return sf(r.data?.openInterest);
  } catch (e: unknown) {
    log.warn('BIN OI fail', e instanceof Error ? e : undefined);
    return 0;
  }
}

/**
 * Tarihsel OI — Binance /futures/data/openInterestHist
 * sumOpenInterestValue → doğrudan USD cinsinden döner.
 * NOT: midPrice ile çarpmaya GEREK YOK.
 */
async function binOIHist(symbol: string, period: string, startTime: number): Promise<number> {
  try {
    const r = await axios.get(`${BINANCE_REST}/futures/data/openInterestHist`, {
      params: { symbol, period, limit: 1, startTime },
      timeout: TIMEOUT,
    });
    const row = r.data?.[0];
    return sf(row?.sumOpenInterestValue); // USD cinsinden toplam
  } catch (e: unknown) {
    log.warn('BIN OI-hist fail', e instanceof Error ? e : undefined);
    return 0;
  }
}

/** Binance OI hist period dizgisi */
function binOIHistPeriod(tf: MrTimeframe): string {
  switch (tf) {
    case '15m': return '15m';
    case '1h':  return '1h';
    case '4h':  return '4h';
    case '24h': return '1d';
  }
}

async function binFunding(symbol: string): Promise<FundingInfo> {
  try {
    const [premiumRes] = await Promise.all([
      axios.get(`${BINANCE_REST}/fapi/v1/premiumIndex`, {
        params: { symbol },
        timeout: TIMEOUT,
      }),
      ensureBinFundingInfo(),
    ]);
    return {
      rate:            sf(premiumRes.data?.lastFundingRate),
      nextFundingTime: sf(premiumRes.data?.nextFundingTime),
      intervalHours:   binFundingInfoCache.get(symbol) ?? 8,
    };
  } catch (e: unknown) {
    log.warn('BIN funding fail', e instanceof Error ? e : undefined);
    return { rate: 0, nextFundingTime: 0, intervalHours: 8 };
  }
}

async function binLSR(
  symbol: string,
  period: string,
): Promise<{ long: number; short: number; ratio: number }> {
  try {
    const r = await axios.get(`${BINANCE_REST}/futures/data/globalLongShortAccountRatio`, {
      params: { symbol, period, limit: 1 },
      timeout: TIMEOUT,
    });
    const row = r.data?.[0];
    return {
      long:  sf(row?.longAccount),
      short: sf(row?.shortAccount),
      ratio: sf(row?.longShortRatio),
    };
  } catch (e: unknown) {
    log.warn('BIN LSR fail', e instanceof Error ? e : undefined);
    return { long: 0, short: 0, ratio: 0 };
  }
}

/**
 * Binance Net CVD — kline'lar üzerinden.
 * k[5] = totalBaseVol, k[9] = takerBuyBaseVol
 * sellVol = total - buy → CVD = Σ (buy - sell) * close
 */
async function binCVD(
  symbol: string,
  interval: string,
  intervalMs: number,
  startTime: number,
  endTime: number,
): Promise<number> {
  try {
    const klines = await fetchBinKlines(symbol, interval, startTime, endTime, intervalMs);
    let cvd = 0;
    for (const k of klines) {
      const totalVol = sf(k[5]);
      const buyVol   = sf(k[9]);
      const sellVol  = totalVol - buyVol;
      const close    = sf(k[4]);
      cvd += (buyVol - sellVol) * close;
    }
    return cvd;
  } catch (e: unknown) {
    log.warn('BIN CVD fail', e instanceof Error ? e : undefined);
    return 0;
  }
}

async function binOrderbook(symbol: string): Promise<{ bids: [number, number][]; asks: [number, number][] }> {
  try {
    const r = await axios.get(`${BINANCE_REST}/fapi/v1/depth`, {
      params: { symbol, limit: 1000 },
      timeout: TIMEOUT,
    });
    const bids: [number, number][] = (r.data?.bids ?? []).map(
      (b: [string, string]) => [parseFloat(b[0]), parseFloat(b[1])] as [number, number],
    );
    const asks: [number, number][] = (r.data?.asks ?? []).map(
      (a: [string, string]) => [parseFloat(a[0]), parseFloat(a[1])] as [number, number],
    );
    return { bids, asks };
  } catch (e: unknown) {
    log.warn('BIN OB fail', e instanceof Error ? e : undefined);
    return { bids: [], asks: [] };
  }
}

// ═════════════════════════════════════════════════════════════════════════════
//  BYBIT
// ═════════════════════════════════════════════════════════════════════════════

/** Anlık OI (base cinsinden) */
async function bybOI(symbol: string): Promise<number> {
  try {
    const r = await axios.get(`${BYBIT_REST}/v5/market/open-interest`, {
      params: { category: 'linear', symbol, intervalTime: '5min', limit: 1 },
      timeout: TIMEOUT,
    });
    return sf(r.data?.result?.list?.[0]?.openInterest);
  } catch (e: unknown) {
    log.warn('BYB OI fail', e instanceof Error ? e : undefined);
    return 0;
  }
}

/**
 * Tarihsel OI — Bybit v5 /v5/market/open-interest
 * limit=2 ile son 2 periyodu çeker. [0]=en yeni, [1]=bir önceki.
 * startTime/endTime kullanmıyoruz çünkü boş dönüyor.
 */
async function bybOIHist(
  symbol: string,
  intervalTime: string,
): Promise<number> {
  try {
    const r = await axios.get(`${BYBIT_REST}/v5/market/open-interest`, {
      params: { category: 'linear', symbol, intervalTime, limit: 2 },
      timeout: TIMEOUT,
    });
    const list = r.data?.result?.list ?? [];
    // DESC sıralı → [0]=en yeni, [1]=bir önceki periyot
    const prev = list[1] ?? list[0];
    return sf(prev?.openInterest);
  } catch (e: unknown) {
    log.warn('BYB OI-hist fail', e instanceof Error ? e : undefined);
    return 0;
  }
}

async function bybFunding(symbol: string): Promise<FundingInfo> {
  try {
    const r = await axios.get(`${BYBIT_REST}/v5/market/tickers`, {
      params: { category: 'linear', symbol },
      timeout: TIMEOUT,
    });
    const item = r.data?.result?.list?.[0];
    return {
      rate:            sf(item?.fundingRate),
      nextFundingTime: sf(item?.nextFundingTime),
      intervalHours:   sf(item?.fundingIntervalHour) || 8,
    };
  } catch (e: unknown) {
    log.warn('BYB funding fail', e instanceof Error ? e : undefined);
    return { rate: 0, nextFundingTime: 0, intervalHours: 8 };
  }
}

async function bybLSR(
  symbol: string,
  period: string,
): Promise<{ long: number; short: number; ratio: number }> {
  try {
    const r = await axios.get(`${BYBIT_REST}/v5/market/account-ratio`, {
      params: { category: 'linear', symbol, period, limit: 1 },
      timeout: TIMEOUT,
    });
    const row = r.data?.result?.list?.[0];
    const buyRatio  = sf(row?.buyRatio);
    const sellRatio = sf(row?.sellRatio);
    return {
      long:  buyRatio,
      short: sellRatio,
      ratio: sellRatio > 0 ? buyRatio / sellRatio : 0,
    };
  } catch (e: unknown) {
    log.warn('BYB LSR fail', e instanceof Error ? e : undefined);
    return { long: 0, short: 0, ratio: 0 };
  }
}

/**
 * Bybit CVD — kline verisi ile mum yönü + oran yaklaşımı.
 * Bybit kline'da taker buy/sell ayrımı yoktur.
 */
async function bybCVD(
  symbol: string,
  interval: string,
  intervalMs: number,
  startTime: number,
  endTime: number,
): Promise<number> {
  try {
    const klines = await fetchBybKlines(symbol, interval, startTime, endTime, intervalMs);
    let cvd = 0;
    for (const k of klines) {
      const open     = sf(k[1]);
      const high     = sf(k[2]);
      const low      = sf(k[3]);
      const close    = sf(k[4]);
      const turnover = sf(k[6]);
      const range    = high - low;
      const ratio    = range > 0 ? (close - open) / range : (close >= open ? 1 : -1);
      cvd += turnover * ratio;
    }
    return cvd;
  } catch (e: unknown) {
    log.warn('BYB CVD fail', e instanceof Error ? e : undefined);
    return 0;
  }
}

async function bybOrderbook(symbol: string): Promise<{ bids: [number, number][]; asks: [number, number][] }> {
  try {
    const r = await axios.get(`${BYBIT_REST}/v5/market/orderbook`, {
      params: { category: 'linear', symbol, limit: 200 },
      timeout: TIMEOUT,
    });
    const data = r.data?.result;
    const bids: [number, number][] = (data?.b ?? []).map(
      (b: [string, string]) => [parseFloat(b[0]), parseFloat(b[1])] as [number, number],
    );
    const asks: [number, number][] = (data?.a ?? []).map(
      (a: [string, string]) => [parseFloat(a[0]), parseFloat(a[1])] as [number, number],
    );
    return { bids, asks };
  } catch (e: unknown) {
    log.warn('BYB OB fail', e instanceof Error ? e : undefined);
    return { bids: [], asks: [] };
  }
}

// ═════════════════════════════════════════════════════════════════════════════
//  OKX
// ═════════════════════════════════════════════════════════════════════════════

/** Anlık OI (oiCcy → base cinsinden) */
async function okxOI(instId: string): Promise<number> {
  try {
    const r = await axios.get(`${OKX_REST}/api/v5/public/open-interest`, {
      params: { instType: 'SWAP', instId },
      timeout: TIMEOUT,
    });
    return sf(r.data?.data?.[0]?.oiCcy);
  } catch (e: unknown) {
    log.warn('OKX OI fail', e instanceof Error ? e : undefined);
    return 0;
  }
}

/**
 * OKX tarihsel OI — /api/v5/rubik/stat/contracts/open-interest-volume
 * ⚠ DİKKAT: Bu endpoint TÜM SWAP türleri dahil toplu USD OI döner!
 * Delta hesabında tutarlılık için hem current hem past rubik'ten alınır.
 * {currentUSD, pastUSD} olarak döner → delta = current - past.
 */
async function okxOIDelta(ccy: string, period: string, periodsBack: number): Promise<{ currentUSD: number; pastUSD: number }> {
  try {
    const r = await axios.get(`${OKX_REST}/api/v5/rubik/stat/contracts/open-interest-volume`, {
      params: { ccy, period },
      timeout: TIMEOUT,
    });
    const list = r.data?.data ?? [];
    if (list.length === 0) return { currentUSD: 0, pastUSD: 0 };

    const newestUSD = sf(list[0]?.[1]);
    const idx = Math.min(periodsBack, list.length - 1);
    const pastUSD = sf((list[idx] ?? list[list.length - 1])?.[1]);

    return { currentUSD: newestUSD, pastUSD };
  } catch (e: unknown) {
    log.warn('OKX OI-delta fail', e instanceof Error ? e : undefined);
    return { currentUSD: 0, pastUSD: 0 };
  }
}

function okxOIHistPeriod(tf: MrTimeframe): string {
  switch (tf) {
    case '15m': return '5m';
    case '1h':  return '1H';
    case '4h':  return '1H';
    case '24h': return '1D';
  }
}

/** Kaç rubik periyot geriye gidilecek */
function okxOIPeriodsBack(tf: MrTimeframe): number {
  switch (tf) {
    case '15m': return 3;   // 15m / 5m = 3
    case '1h':  return 1;   // 1h / 1H = 1
    case '4h':  return 4;   // 4h / 1H = 4
    case '24h': return 1;   // 24h / 1D = 1
  }
}

async function okxFunding(instId: string): Promise<FundingInfo> {
  try {
    const r = await axios.get(`${OKX_REST}/api/v5/public/funding-rate`, {
      params: { instId },
      timeout: TIMEOUT,
    });
    const item = r.data?.data?.[0];
    const rate            = sf(item?.fundingRate);
    const fundingTime     = sf(item?.fundingTime);
    const nextFundingTime = sf(item?.nextFundingTime);
    // interval hesapla: fundingTime(mevcut) → nextFundingTime arası
    const intervalHours = fundingTime > 0 && nextFundingTime > fundingTime
      ? (nextFundingTime - fundingTime) / (3600 * 1000)
      : 8;
    return { rate, nextFundingTime, intervalHours };
  } catch (e: unknown) {
    log.warn('OKX funding fail', e instanceof Error ? e : undefined);
    return { rate: 0, nextFundingTime: 0, intervalHours: 8 };
  }
}

/**
 * OKX Long/Short Oranı — DOĞRU ENDPOINT:
 * /api/v5/rubik/stat/contracts/long-short-account-ratio
 *
 * Yanıt: data: [ ["ts", "longShortRatio"], ... ]
 * ratio = longAccount / shortAccount
 * Örn: "1.52" → long% = 60.3%, short% = 39.7%
 */
async function okxLSR(
  ccy: string,
  period: string,
): Promise<{ long: number; short: number; ratio: number }> {
  try {
    const r = await axios.get(`${OKX_REST}/api/v5/rubik/stat/contracts/long-short-account-ratio`, {
      params: { ccy, period },
      timeout: TIMEOUT,
    });
    const list = r.data?.data ?? [];
    const row = list[0]; // En son veri
    if (!row) return { long: 0, short: 0, ratio: 0 };

    // OKX döner: [ts, longShortRatio]
    const ratio   = sf(row[1]);
    const longPct  = ratio > 0 ? ratio / (1 + ratio) : 0;
    const shortPct = ratio > 0 ? 1 / (1 + ratio) : 0;

    log.debug(`OKX LSR: ratio=${ratio}, long=${(longPct * 100).toFixed(1)}%, short=${(shortPct * 100).toFixed(1)}%`);
    return { long: longPct, short: shortPct, ratio };
  } catch (e: unknown) {
    log.warn('OKX LSR fail', e instanceof Error ? e : undefined);
    return { long: 0, short: 0, ratio: 0 };
  }
}

function okxLsrPeriod(tf: MrTimeframe): string {
  // OKX LSR sadece 5m, 1H, 1D destekler
  switch (tf) {
    case '15m': return '5m';
    case '1h':  return '1H';
    case '4h':  return '1H';  // 4H desteklenmiyor → 1H fallback
    case '24h': return '1D';
  }
}

/**
 * OKX CVD — kline ile mum yönü + hacim yaklaşımı.
 * OKX kline: [ts, o, h, l, c, vol, volCcy, volCcyQuote, confirm]
 * volCcyQuote (index 7) = USDT cinsinden hacim.
 */
async function okxCVD(
  instId: string,
  bar: string,
  intervalMs: number,
  startTime: number,
  endTime: number,
): Promise<number> {
  try {
    const klines = await fetchOkxKlines(instId, bar, startTime, endTime, intervalMs);
    let cvd = 0;
    for (const k of klines) {
      const open     = sf(k[1]);
      const high     = sf(k[2]);
      const low      = sf(k[3]);
      const close    = sf(k[4]);
      const volQuote = sf(k[7]);
      const range    = high - low;
      const ratio    = range > 0 ? (close - open) / range : (close >= open ? 1 : -1);
      cvd += volQuote * ratio;
    }
    return cvd;
  } catch (e: unknown) {
    log.warn('OKX CVD fail', e instanceof Error ? e : undefined);
    return 0;
  }
}

async function okxOrderbook(instId: string): Promise<{ bids: [number, number][]; asks: [number, number][] }> {
  try {
    const r = await axios.get(`${OKX_REST}/api/v5/market/books`, {
      params: { instId, sz: 400 },
      timeout: TIMEOUT,
    });
    const data = r.data?.data?.[0];
    const config = (() => {
      try {
        return getSymbolConfig(instId.replace('-USDT-SWAP', 'USDT'));
      } catch {
        return null;
      }
    })();
    const ctVal = config?.okxContractSize ?? 1;
    const bids: [number, number][] = (data?.bids ?? []).map(
      (b: string[]) => [sf(b[0]), sf(b[1]) * ctVal] as [number, number],
    );
    const asks: [number, number][] = (data?.asks ?? []).map(
      (a: string[]) => [sf(a[0]), sf(a[1]) * ctVal] as [number, number],
    );
    return { bids, asks };
  } catch (e: unknown) {
    log.warn('OKX OB fail', e instanceof Error ? e : undefined);
    return { bids: [], asks: [] };
  }
}

// ═════════════════════════════════════════════════════════════════════════════
//  ANA FONKSIYON — fetchMrData
// ═════════════════════════════════════════════════════════════════════════════

export async function fetchMrData(symbol: string, timeframe: MrTimeframe): Promise<MrResult> {
  const t0 = Date.now();
  log.info(`MR data çekiliyor: ${symbol} / ${timeframe}`);

  const tf        = TIMEFRAME_MAP[timeframe];
  const endTime   = Date.now();
  const startTime = endTime - tf.periodMs;

  const binSymbol = toBinanceRestSymbol(symbol); // BTCUSDT
  const bybSymbol = symbol;                       // BTCUSDT
  const okxInstId = toOkxSymbol(symbol);          // BTC-USDT-SWAP
  const baseCcy   = symbol.replace(/USDT$/i, ''); // BTC

  // ── SQLite'dan gerçek tasfiye verileri (senkronize — µs) ───────────────────
  const binLiqRes = queryLiqForMR(symbol, 'binance', startTime);
  const okxLiqRes = queryLiqForMR(symbol, 'okx',     startTime);

  // ── 3 Borsadan 18 Paralel REST Çağrısı ────────────────────────────────────
  const [
    // Binance (6)
    binOICurr, binOIPast, binFund, binLsrRes, binCvdRes, binOBRes,
    // Bybit (6)
    bybOICurr, bybOIPast, bybFund, bybLsrRes, bybCvdRes, bybOBRes,
    // OKX (6)
    okxOICurr, okxOIPast, okxFund, okxLsrRes, okxCvdRes, okxOBRes,
  ] = await Promise.all([
    // ── Binance ──
    binOI(binSymbol),
    binOIHist(binSymbol, binOIHistPeriod(timeframe), startTime),
    binFunding(binSymbol),
    binLSR(binSymbol, tf.binanceLsrPeriod),
    binCVD(binSymbol, tf.liqBinKline, tf.liqIntervalMs, startTime, endTime),
    binOrderbook(binSymbol),
    // ── Bybit ──
    bybOI(bybSymbol),
    bybOIHist(bybSymbol, tf.bybitOiInterval),
    bybFunding(bybSymbol),
    bybLSR(bybSymbol, tf.bybitLsrPeriod),
    bybCVD(bybSymbol, tf.liqBybKline, tf.liqIntervalMs, startTime, endTime),
    bybOrderbook(bybSymbol),
    // ── OKX ──
    okxOI(okxInstId),
    okxOIDelta(baseCcy, okxOIHistPeriod(timeframe), okxOIPeriodsBack(timeframe)),
    okxFunding(okxInstId),
    okxLSR(baseCcy, okxLsrPeriod(timeframe)),
    okxCVD(okxInstId, tf.liqOkxBar, tf.liqIntervalMs, startTime, endTime),
    okxOrderbook(okxInstId),
  ]);

  // ── MidPrice (base → USD dönüşüm) ────────────────────────────────────────
  const midPrice =
    binOBRes.bids.length > 0 && binOBRes.asks.length > 0
      ? (binOBRes.bids[0]![0] + binOBRes.asks[0]![0]) / 2
      : 0;

  // ── Borsa Bazlı Veri Yapıları ─────────────────────────────────────────────

  // Binance: binOIPast = sumOpenInterestValue (USD zaten)
  const binData: ExchangeMrData = {
    openInterest:   binOICurr * midPrice,
    oiDelta:        binOICurr * midPrice - binOIPast,
    fundingRate:    binFund.rate,
    nextFundingTime: binFund.nextFundingTime,
    fundingIntervalHours: binFund.intervalHours,
    longShortRatio: binLsrRes.ratio,
    longRatio:      binLsrRes.long,
    shortRatio:     binLsrRes.short,
    liqLongUsd:     binLiqRes.longUsd,
    liqShortUsd:    binLiqRes.shortUsd,
    liqEstimated:   false,
    netCvd:         binCvdRes,
    orderbookBids:  binOBRes.bids,
    orderbookAsks:  binOBRes.asks,
  };

  const bybOIUsd = bybOICurr * midPrice;

  // ── Bybit Liq Tahmini (OI ağırlıklı) ─────────────────────────────────────
  // Bybit V5 liq API'si kaldırıldı. Binance+OKX'in gerçek liq verisi +
  // 3 borsanın OI payı kullanılarak orantılı tahmin hesaplanır.
  const knownLiqLong  = binLiqRes.longUsd  + okxLiqRes.longUsd;
  const knownLiqShort = binLiqRes.shortUsd + okxLiqRes.shortUsd;
  const knownOI       = (binOICurr + okxOICurr) * midPrice;
  const bybOIRatio    = knownOI > 0 ? bybOIUsd / knownOI : 0;
  const bybEstLiqLong  = knownLiqLong  * bybOIRatio;
  const bybEstLiqShort = knownLiqShort * bybOIRatio;

  const bybData: ExchangeMrData = {
    openInterest:   bybOIUsd,
    oiDelta:        (bybOICurr - bybOIPast) * midPrice,
    fundingRate:    bybFund.rate,
    nextFundingTime: bybFund.nextFundingTime,
    fundingIntervalHours: bybFund.intervalHours,
    longShortRatio: bybLsrRes.ratio,
    longRatio:      bybLsrRes.long,
    shortRatio:     bybLsrRes.short,
    liqLongUsd:     bybEstLiqLong,
    liqShortUsd:    bybEstLiqShort,
    liqEstimated:   true,
    netCvd:         bybCvdRes,
    orderbookBids:  bybOBRes.bids,
    orderbookAsks:  bybOBRes.asks,
  };

  // OKX: rubik delta iç tutarlı (aynı kaynaktan current vs past)
  const okxData: ExchangeMrData = {
    openInterest:   okxOICurr * midPrice,
    oiDelta:        okxOIPast.currentUSD - okxOIPast.pastUSD,
    fundingRate:    okxFund.rate,
    nextFundingTime: okxFund.nextFundingTime,
    fundingIntervalHours: okxFund.intervalHours,
    longShortRatio: okxLsrRes.ratio,
    longRatio:      okxLsrRes.long,
    shortRatio:     okxLsrRes.short,
    liqLongUsd:     okxLiqRes.longUsd,
    liqShortUsd:    okxLiqRes.shortUsd,
    liqEstimated:   false,
    netCvd:         okxCvdRes,
    orderbookBids:  okxOBRes.bids,
    orderbookAsks:  okxOBRes.asks,
  };

  // ── Kümülatif (Aggregated) ────────────────────────────────────────────────

  const totalOI = binData.openInterest + bybData.openInterest + okxData.openInterest;
  const oiDelta = binData.oiDelta + bybData.oiDelta + okxData.oiDelta;

  // Funding: sıfır olmayanların ortalaması
  const fundings = [binData.fundingRate, bybData.fundingRate, okxData.fundingRate].filter(f => f !== 0);
  const avgFunding = fundings.length > 0 ? fundings.reduce((a, b) => a + b, 0) / fundings.length : 0;

  // En yakın funding zamanı
  const fundingTimes = [binData.nextFundingTime, bybData.nextFundingTime, okxData.nextFundingTime].filter(t => t > 0);
  const nearestFundingTime = fundingTimes.length > 0 ? Math.min(...fundingTimes) : 0;

  // L/S: sıfır olmayanların ortalaması
  const lsrEntries = [
    { l: binData.longRatio, s: binData.shortRatio, r: binData.longShortRatio },
    { l: bybData.longRatio, s: bybData.shortRatio, r: bybData.longShortRatio },
    { l: okxData.longRatio, s: okxData.shortRatio, r: okxData.longShortRatio },
  ].filter(e => e.r > 0);

  const combinedLongRatio  = lsrEntries.length > 0 ? lsrEntries.reduce((a, e) => a + e.l, 0) / lsrEntries.length : 0;
  const combinedShortRatio = lsrEntries.length > 0 ? lsrEntries.reduce((a, e) => a + e.s, 0) / lsrEntries.length : 0;
  const combinedLSR        = combinedShortRatio > 0 ? combinedLongRatio / combinedShortRatio : 0;

  // Combined liquidations
  const totalLiqLong  = binData.liqLongUsd + bybData.liqLongUsd + okxData.liqLongUsd;
  const totalLiqShort = binData.liqShortUsd + bybData.liqShortUsd + okxData.liqShortUsd;

  // Combined CVD
  const totalNetCvd = binData.netCvd + bybData.netCvd + okxData.netCvd;

  // Combined Orderbook
  const combinedBids = mergeOrderbookSide([...binOBRes.bids, ...bybOBRes.bids, ...okxOBRes.bids], 'desc');
  const combinedAsks = mergeOrderbookSide([...binOBRes.asks, ...bybOBRes.asks, ...okxOBRes.asks], 'asc');

  const elapsed = Date.now() - t0;
  log.info(`MR hazır: ${symbol}/${timeframe} (${elapsed}ms)`, {
    totalOI:  '$' + (totalOI / 1e6).toFixed(1) + 'M',
    oiDelta:  '$' + (oiDelta / 1e6).toFixed(2) + 'M',
    avgFund:  (avgFunding * 100).toFixed(4) + '%',
    liqLong:  '$' + (totalLiqLong / 1e6).toFixed(2) + 'M',
    liqShort: '$' + (totalLiqShort / 1e6).toFixed(2) + 'M',
    cvd:      '$' + (totalNetCvd / 1e6).toFixed(2) + 'M',
  });

  return {
    symbol,
    timeframe,
    timestamp: Date.now(),
    exchanges: {
      binance: binData,
      bybit: bybData,
      okx: okxData,
    },
    aggregated: {
      totalOI,
      oiDelta,
      avgFunding,
      nearestFundingTime,
      combinedLongRatio,
      combinedShortRatio,
      combinedLongShortRatio: combinedLSR,
      totalLiqLongUsd: totalLiqLong,
      totalLiqShortUsd: totalLiqShort,
      totalNetCvd,
      combinedOrderbookBids: combinedBids,
      combinedOrderbookAsks: combinedAsks,
    },
  };
}

// ── Orderbook birleştirme yardımcısı ─────────────────────────────────────────

function mergeOrderbookSide(
  levels: [number, number][],
  direction: 'asc' | 'desc',
): [number, number][] {
  if (levels.length === 0) return [];

  // Find a reference price to determine adaptive tick size
  let refPrice = 0;
  for (const [price] of levels) {
    if (price > 0) { refPrice = price; break; }
  }
  if (refPrice <= 0) return [];

  // Adaptive tick: ~0.01% of price → ~500 levels in ±2.5% range
  // Snap to a clean power-of-10 tick for deterministic rounding
  const rawTick = refPrice * 0.0001;
  const tickSize = Math.pow(10, Math.floor(Math.log10(rawTick)));
  const invTick = Math.round(1 / tickSize);

  const map = new Map<number, number>();
  for (const [price, qty] of levels) {
    if (price <= 0 || qty <= 0) continue;
    // Use integer key to avoid floating-point Map-key issues
    const key = Math.round(price * invTick);
    map.set(key, (map.get(key) ?? 0) + qty);
  }

  const merged = [...map.entries()].map(([k, q]) => [k / invTick, q] as [number, number]);
  merged.sort((a, b) => direction === 'desc' ? b[0] - a[0] : a[0] - b[0]);
  return merged;
}

// ─────────────────────────────────────────────────────────────────────────────
// services/MrService.ts — COIN MR (Market Reconnaissance) Servisi
// ─────────────────────────────────────────────────────────────────────────────
//
// Seçili sembol ve zaman dilimi için 3 borsadan (Binance, Bybit, OKX)
// eşzamanlı REST API çağrıları ile piyasa röntgeni çeker.
//
// Çekilen Veriler:
//   - Open Interest
//   - Funding Rate
//   - Long/Short Ratio
//   - Liquidation (tasfiye) özeti
//   - Orderbook snapshot (derinlik)
//   - Net CVD (kline volume delta)
//
// ─────────────────────────────────────────────────────────────────────────────

import axios from 'axios';
import { Logger } from '../utils/logger.js';
import {
  getSymbolConfig,
  toBinanceRestSymbol,
  toOkxSymbol,
} from '../config/symbols.js';

const log = new Logger('MrService');

// ── REST Base URL'ler ────────────────────────────────────────────────────────
const BINANCE_REST = 'https://fapi.binance.com';
const BYBIT_REST   = 'https://api.bybit.com';
const OKX_REST     = 'https://www.okx.com';

const TIMEOUT = 12_000;

// ── Zaman Dilimi Eşlemesi ────────────────────────────────────────────────────
type MrTimeframe = '15m' | '1h' | '4h' | '24h';

interface TimeframeConfig {
  binanceKlineInterval: string;
  bybitKlineInterval: string;
  okxKlineBar: string;
  periodMs: number;
  binanceLsrPeriod: string;
  bybitLsrPeriod: string;
}

const TIMEFRAME_MAP: Record<MrTimeframe, TimeframeConfig> = {
  '15m': {
    binanceKlineInterval: '15m',
    bybitKlineInterval: '15',
    okxKlineBar: '15m',
    periodMs: 15 * 60 * 1000,
    binanceLsrPeriod: '15m',
    bybitLsrPeriod: '15min',
  },
  '1h': {
    binanceKlineInterval: '1h',
    bybitKlineInterval: '60',
    okxKlineBar: '1H',
    periodMs: 60 * 60 * 1000,
    binanceLsrPeriod: '1h',
    bybitLsrPeriod: '1h',
  },
  '4h': {
    binanceKlineInterval: '4h',
    bybitKlineInterval: '240',
    okxKlineBar: '4H',
    periodMs: 4 * 60 * 60 * 1000,
    binanceLsrPeriod: '4h',
    bybitLsrPeriod: '4h',
  },
  '24h': {
    binanceKlineInterval: '1d',
    bybitKlineInterval: 'D',
    okxKlineBar: '1D',
    periodMs: 24 * 60 * 60 * 1000,
    binanceLsrPeriod: '1d',
    bybitLsrPeriod: '1d',
  },
};

// ── Sonuç Tipleri ────────────────────────────────────────────────────────────

export interface ExchangeMrData {
  openInterest: number;
  fundingRate: number;
  longShortRatio: number;
  longRatio: number;
  shortRatio: number;
  liqLongUsd: number;
  liqShortUsd: number;
  netCvd: number;
  orderbookBids: [number, number][];  // [price, qty]
  orderbookAsks: [number, number][];  // [price, qty]
}

export interface AggregatedMrData {
  totalOI: number;
  avgFunding: number;
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

// ── Yardımcı: Güvenli sayı parse ────────────────────────────────────────────
function safeFloat(v: unknown): number {
  const n = parseFloat(String(v ?? '0'));
  return isFinite(n) ? n : 0;
}

// ═════════════════════════════════════════════════════════════════════════════
// BINANCE — Veri Çekiciler
// ═════════════════════════════════════════════════════════════════════════════

async function fetchBinanceOI(symbol: string): Promise<number> {
  try {
    const url = `${BINANCE_REST}/fapi/v1/openInterest?symbol=${symbol}`;
    const res = await axios.get(url, { timeout: TIMEOUT });
    return safeFloat(res.data?.openInterest);
  } catch (e) { log.warn('Binance OI fetch fail', e instanceof Error ? e : undefined); return 0; }
}

async function fetchBinanceFunding(symbol: string): Promise<number> {
  try {
    const url = `${BINANCE_REST}/fapi/v1/premiumIndex?symbol=${symbol}`;
    const res = await axios.get(url, { timeout: TIMEOUT });
    return safeFloat(res.data?.lastFundingRate);
  } catch (e) { log.warn('Binance funding fetch fail', e instanceof Error ? e : undefined); return 0; }
}

async function fetchBinanceLSR(symbol: string, period: string): Promise<{ long: number; short: number; ratio: number }> {
  try {
    const url = `${BINANCE_REST}/futures/data/globalLongShortAccountRatio?symbol=${symbol}&period=${period}&limit=1`;
    const res = await axios.get(url, { timeout: TIMEOUT });
    const row = res.data?.[0];
    return {
      long: safeFloat(row?.longAccount),
      short: safeFloat(row?.shortAccount),
      ratio: safeFloat(row?.longShortRatio),
    };
  } catch (e) { log.warn('Binance LSR fetch fail', e instanceof Error ? e : undefined); return { long: 0, short: 0, ratio: 0 }; }
}

async function fetchBinanceLiquidations(symbol: string, periodMs: number): Promise<{ longUsd: number; shortUsd: number }> {
  try {
    const startTime = Date.now() - periodMs;
    const forceUrl = `${BINANCE_REST}/fapi/v1/allForceOrders?symbol=${symbol}&startTime=${startTime}&limit=1000`;
    const res = await axios.get(forceUrl, { timeout: TIMEOUT });
    const orders = res.data ?? [];
    let longUsd = 0, shortUsd = 0;
    for (const o of orders as Array<{ side: string; price: string; origQty: string; averagePrice: string }>) {
      const price = safeFloat(o.averagePrice) || safeFloat(o.price);
      const qty = safeFloat(o.origQty);
      const usd = price * qty;
      if (o.side === 'SELL') longUsd += usd;  // SELL force = long liquidation
      else shortUsd += usd;
    }
    return { longUsd, shortUsd };
  } catch (e) { log.warn('Binance liquidation fetch fail', e instanceof Error ? e : undefined); return { longUsd: 0, shortUsd: 0 }; }
}

async function fetchBinanceCVD(symbol: string, interval: string): Promise<number> {
  try {
    // Kline'dan buy/sell volume delta hesapla
    const url = `${BINANCE_REST}/fapi/v1/klines?symbol=${symbol}&interval=${interval}&limit=1`;
    const res = await axios.get(url, { timeout: TIMEOUT });
    const k = res.data?.[0];
    if (!k) return 0;
    // k[5] = volume, k[9] = taker buy base volume
    const totalVol = safeFloat(k[5]);
    const buyVol = safeFloat(k[9]);
    const closePrice = safeFloat(k[4]);
    const sellVol = totalVol - buyVol;
    return (buyVol - sellVol) * closePrice; // USD-cinsinden net CVD
  } catch (e) { log.warn('Binance CVD fetch fail', e instanceof Error ? e : undefined); return 0; }
}

async function fetchBinanceOrderbook(symbol: string): Promise<{ bids: [number, number][]; asks: [number, number][] }> {
  try {
    const url = `${BINANCE_REST}/fapi/v1/depth?symbol=${symbol}&limit=1000`;
    const res = await axios.get(url, { timeout: TIMEOUT });
    const bids: [number, number][] = (res.data?.bids ?? []).map((b: [string, string]) => [parseFloat(b[0]), parseFloat(b[1])]);
    const asks: [number, number][] = (res.data?.asks ?? []).map((a: [string, string]) => [parseFloat(a[0]), parseFloat(a[1])]);
    return { bids, asks };
  } catch (e) { log.warn('Binance orderbook fetch fail', e instanceof Error ? e : undefined); return { bids: [], asks: [] }; }
}

// ═════════════════════════════════════════════════════════════════════════════
// BYBIT — Veri Çekiciler
// ═════════════════════════════════════════════════════════════════════════════

async function fetchBybitOI(symbol: string): Promise<number> {
  try {
    const url = `${BYBIT_REST}/v5/market/open-interest?category=linear&symbol=${symbol}&intervalTime=5min&limit=1`;
    const res = await axios.get(url, { timeout: TIMEOUT });
    return safeFloat(res.data?.result?.list?.[0]?.openInterest);
  } catch (e) { log.warn('Bybit OI fetch fail', e instanceof Error ? e : undefined); return 0; }
}

async function fetchBybitFunding(symbol: string): Promise<number> {
  try {
    const url = `${BYBIT_REST}/v5/market/tickers?category=linear&symbol=${symbol}`;
    const res = await axios.get(url, { timeout: TIMEOUT });
    return safeFloat(res.data?.result?.list?.[0]?.fundingRate);
  } catch (e) { log.warn('Bybit funding fetch fail', e instanceof Error ? e : undefined); return 0; }
}

async function fetchBybitLSR(symbol: string, period: string): Promise<{ long: number; short: number; ratio: number }> {
  try {
    const url = `${BYBIT_REST}/v5/market/account-ratio?category=linear&symbol=${symbol}&period=${period}&limit=1`;
    const res = await axios.get(url, { timeout: TIMEOUT });
    const row = res.data?.result?.list?.[0];
    const buyRatio = safeFloat(row?.buyRatio);
    const sellRatio = safeFloat(row?.sellRatio);
    return {
      long: buyRatio,
      short: sellRatio,
      ratio: sellRatio > 0 ? buyRatio / sellRatio : 0,
    };
  } catch (e) { log.warn('Bybit LSR fetch fail', e instanceof Error ? e : undefined); return { long: 0, short: 0, ratio: 0 }; }
}

async function fetchBybitLiquidations(_symbol: string, _periodMs: number): Promise<{ longUsd: number; shortUsd: number }> {
  try {
    // Bybit doesn't have a dedicated public liquidation REST API
    // Liquidation data comes through WS stream — returning zero as REST fallback
    return { longUsd: 0, shortUsd: 0 };
  } catch (e) { log.warn('Bybit liquidation fetch fail', e instanceof Error ? e : undefined); return { longUsd: 0, shortUsd: 0 }; }
}

async function fetchBybitCVD(symbol: string, interval: string): Promise<number> {
  try {
    const url = `${BYBIT_REST}/v5/market/kline?category=linear&symbol=${symbol}&interval=${interval}&limit=1`;
    const res = await axios.get(url, { timeout: TIMEOUT });
    const k = res.data?.result?.list?.[0];
    if (!k) return 0;
    // Bybit kline: [startTime, open, high, low, close, volume, turnover]
    const turnover = safeFloat(k[6]); // USDT turnover
    const open = safeFloat(k[1]);
    const close = safeFloat(k[4]);
    const direction = close >= open ? 1 : -1;
    return direction * turnover * 0.1; // heuristic weight
  } catch (e) { log.warn('Bybit CVD fetch fail', e instanceof Error ? e : undefined); return 0; }
}

async function fetchBybitOrderbook(symbol: string): Promise<{ bids: [number, number][]; asks: [number, number][] }> {
  try {
    const url = `${BYBIT_REST}/v5/market/orderbook?category=linear&symbol=${symbol}&limit=200`;
    const res = await axios.get(url, { timeout: TIMEOUT });
    const data = res.data?.result;
    const bids: [number, number][] = (data?.b ?? []).map((b: [string, string]) => [parseFloat(b[0]), parseFloat(b[1])]);
    const asks: [number, number][] = (data?.a ?? []).map((a: [string, string]) => [parseFloat(a[0]), parseFloat(a[1])]);
    return { bids, asks };
  } catch (e) { log.warn('Bybit orderbook fetch fail', e instanceof Error ? e : undefined); return { bids: [], asks: [] }; }
}

// ═════════════════════════════════════════════════════════════════════════════
// OKX — Veri Çekiciler
// ═════════════════════════════════════════════════════════════════════════════

async function fetchOkxOI(instId: string): Promise<number> {
  try {
    const url = `${OKX_REST}/api/v5/public/open-interest?instType=SWAP&instId=${instId}`;
    const res = await axios.get(url, { timeout: TIMEOUT });
    const row = res.data?.data?.[0];
    // oiCcy is in base currency, oi is in contracts
    return safeFloat(row?.oiCcy);
  } catch (e) { log.warn('OKX OI fetch fail', e instanceof Error ? e : undefined); return 0; }
}

async function fetchOkxFunding(instId: string): Promise<number> {
  try {
    const url = `${OKX_REST}/api/v5/public/funding-rate?instId=${instId}`;
    const res = await axios.get(url, { timeout: TIMEOUT });
    return safeFloat(res.data?.data?.[0]?.fundingRate);
  } catch (e) { log.warn('OKX funding fetch fail', e instanceof Error ? e : undefined); return 0; }
}

async function fetchOkxLSR(instId: string): Promise<{ long: number; short: number; ratio: number }> {
  try {
    const url = `${OKX_REST}/api/v5/rubik/stat/contracts-long-short-account-ratio-contract-top-trader?instId=${instId}&period=5m`;
    const res = await axios.get(url, { timeout: TIMEOUT });
    const row = res.data?.data?.[0];
    const longRatio = safeFloat(row?.[1]);   // OKX: [ts, longRatio, shortRatio]
    const shortRatio = safeFloat(row?.[2]);
    return {
      long: longRatio,
      short: shortRatio,
      ratio: shortRatio > 0 ? longRatio / shortRatio : 0,
    };
  } catch (e) { log.warn('OKX LSR fetch fail', e instanceof Error ? e : undefined); return { long: 0, short: 0, ratio: 0 }; }
}

async function fetchOkxLiquidations(_instId: string, _periodMs: number): Promise<{ longUsd: number; shortUsd: number }> {
  try {
    // OKX public liquidation REST API uses /api/v5/public/liquidation-orders
    const url = `${OKX_REST}/api/v5/public/liquidation-orders?instType=SWAP&instId=${_instId}&state=filled&uly=${_instId.replace('-SWAP', '')}&limit=100`;
    const res = await axios.get(url, { timeout: TIMEOUT });
    const details = res.data?.data ?? [];
    let longUsd = 0, shortUsd = 0;
    for (const d of details as Array<{ details: Array<{ side: string; sz: string; bkPx: string }> }>) {
      for (const detail of d.details ?? []) {
        const sz = safeFloat(detail.sz);
        const px = safeFloat(detail.bkPx);
        const usd = sz * px;
        if (detail.side === 'sell') longUsd += usd;
        else shortUsd += usd;
      }
    }
    return { longUsd, shortUsd };
  } catch (e) { log.warn('OKX liquidation fetch fail', e instanceof Error ? e : undefined); return { longUsd: 0, shortUsd: 0 }; }
}

async function fetchOkxCVD(instId: string, bar: string): Promise<number> {
  try {
    const url = `${OKX_REST}/api/v5/market/candles?instId=${instId}&bar=${bar}&limit=1`;
    const res = await axios.get(url, { timeout: TIMEOUT });
    const k = res.data?.data?.[0];
    if (!k) return 0;
    // OKX candle: [ts, o, h, l, c, vol, volCcy, volCcyQuote, confirm]
    const open = safeFloat(k[1]);
    const close = safeFloat(k[4]);
    const volQuote = safeFloat(k[7]);
    const direction = close >= open ? 1 : -1;
    return direction * volQuote * 0.1;
  } catch (e) { log.warn('OKX CVD fetch fail', e instanceof Error ? e : undefined); return 0; }
}

async function fetchOkxOrderbook(instId: string): Promise<{ bids: [number, number][]; asks: [number, number][] }> {
  try {
    const url = `${OKX_REST}/api/v5/market/books?instId=${instId}&sz=400`;
    const res = await axios.get(url, { timeout: TIMEOUT });
    const data = res.data?.data?.[0];
    const config = (() => { try { return getSymbolConfig(instId.replace('-USDT-SWAP', 'USDT')); } catch { return null; } })();
    const ctVal = config?.okxContractSize ?? 1;
    const bids: [number, number][] = (data?.bids ?? []).map((b: string[]) => [parseFloat(b[0] ?? '0'), parseFloat(b[1] ?? '0') * ctVal]);
    const asks: [number, number][] = (data?.asks ?? []).map((a: string[]) => [parseFloat(a[0] ?? '0'), parseFloat(a[1] ?? '0') * ctVal]);
    return { bids, asks };
  } catch (e) { log.warn('OKX orderbook fetch fail', e instanceof Error ? e : undefined); return { bids: [], asks: [] }; }
}

// ═════════════════════════════════════════════════════════════════════════════
// ANA FONKSIYON — fetchMrData
// ═════════════════════════════════════════════════════════════════════════════

export async function fetchMrData(symbol: string, timeframe: MrTimeframe): Promise<MrResult> {
  const t0 = Date.now();
  log.info(`MR data çekiliyor: ${symbol} / ${timeframe}`);

  const tf = TIMEFRAME_MAP[timeframe];
  const binanceSymbol = toBinanceRestSymbol(symbol);  // BTCUSDT
  const bybitSymbol   = symbol;                        // BTCUSDT
  const okxInstId     = toOkxSymbol(symbol);           // BTC-USDT-SWAP

  // ── 3 Borsadan Paralel Veri Çekimi ────────────────────────────────────────
  const [
    binOI, binFunding, binLSR, binLiq, binCVD, binOB,
    bybOI, bybFunding, bybLSR, bybLiq, bybCVD, bybOB,
    okxOI, okxFunding, okxLSR, okxLiq, okxCVD, okxOB,
  ] = await Promise.all([
    // Binance
    fetchBinanceOI(binanceSymbol),
    fetchBinanceFunding(binanceSymbol),
    fetchBinanceLSR(binanceSymbol, tf.binanceLsrPeriod),
    fetchBinanceLiquidations(binanceSymbol, tf.periodMs),
    fetchBinanceCVD(binanceSymbol, tf.binanceKlineInterval),
    fetchBinanceOrderbook(binanceSymbol),
    // Bybit
    fetchBybitOI(bybitSymbol),
    fetchBybitFunding(bybitSymbol),
    fetchBybitLSR(bybitSymbol, tf.bybitLsrPeriod),
    fetchBybitLiquidations(bybitSymbol, tf.periodMs),
    fetchBybitCVD(bybitSymbol, tf.bybitKlineInterval),
    fetchBybitOrderbook(bybitSymbol),
    // OKX
    fetchOkxOI(okxInstId),
    fetchOkxFunding(okxInstId),
    fetchOkxLSR(okxInstId),
    fetchOkxLiquidations(okxInstId, tf.periodMs),
    fetchOkxCVD(okxInstId, tf.okxKlineBar),
    fetchOkxOrderbook(okxInstId),
  ]);

  // ── Borsa bazlı sonuçlar ──────────────────────────────────────────────────

  // OI'yi USD'ye çevirmek için Binance orderbook midprice kullanıyoruz
  const midPrice = binOB.bids.length > 0 && binOB.asks.length > 0
    ? (binOB.bids[0]![0] + binOB.asks[0]![0]) / 2
    : 0;

  const binanceData: ExchangeMrData = {
    openInterest: binOI * midPrice,
    fundingRate: binFunding,
    longShortRatio: binLSR.ratio,
    longRatio: binLSR.long,
    shortRatio: binLSR.short,
    liqLongUsd: binLiq.longUsd,
    liqShortUsd: binLiq.shortUsd,
    netCvd: binCVD,
    orderbookBids: binOB.bids,
    orderbookAsks: binOB.asks,
  };

  const bybitData: ExchangeMrData = {
    openInterest: bybOI * midPrice,
    fundingRate: bybFunding,
    longShortRatio: bybLSR.ratio,
    longRatio: bybLSR.long,
    shortRatio: bybLSR.short,
    liqLongUsd: bybLiq.longUsd,
    liqShortUsd: bybLiq.shortUsd,
    netCvd: bybCVD,
    orderbookBids: bybOB.bids,
    orderbookAsks: bybOB.asks,
  };

  const okxData: ExchangeMrData = {
    openInterest: okxOI * midPrice,
    fundingRate: okxFunding,
    longShortRatio: okxLSR.ratio,
    longRatio: okxLSR.long,
    shortRatio: okxLSR.short,
    liqLongUsd: okxLiq.longUsd,
    liqShortUsd: okxLiq.shortUsd,
    netCvd: okxCVD,
    orderbookBids: okxOB.bids,
    orderbookAsks: okxOB.asks,
  };

  // ── Kümülatif (Aggregated) ────────────────────────────────────────────────
  const totalOI = binanceData.openInterest + bybitData.openInterest + okxData.openInterest;

  // Ortalama funding (sıfır olmayan borsalar)
  const fundings = [binanceData.fundingRate, bybitData.fundingRate, okxData.fundingRate].filter(f => f !== 0);
  const avgFunding = fundings.length > 0 ? fundings.reduce((a, b) => a + b, 0) / fundings.length : 0;

  // Combined L/S
  const combinedLongRatio = (binanceData.longRatio + bybitData.longRatio + okxData.longRatio) / 3;
  const combinedShortRatio = (binanceData.shortRatio + bybitData.shortRatio + okxData.shortRatio) / 3;
  const combinedLongShortRatio = combinedShortRatio > 0 ? combinedLongRatio / combinedShortRatio : 0;

  // Combined liquidations
  const totalLiqLongUsd = binanceData.liqLongUsd + bybitData.liqLongUsd + okxData.liqLongUsd;
  const totalLiqShortUsd = binanceData.liqShortUsd + bybitData.liqShortUsd + okxData.liqShortUsd;

  // Combined CVD
  const totalNetCvd = binanceData.netCvd + bybitData.netCvd + okxData.netCvd;

  // Combined Orderbook — birleştir ve fiyat seviyesine göre grupla
  const combinedOrderbookBids = mergeOrderbookSide([...binOB.bids, ...bybOB.bids, ...okxOB.bids], 'desc');
  const combinedOrderbookAsks = mergeOrderbookSide([...binOB.asks, ...bybOB.asks, ...okxOB.asks], 'asc');

  const elapsed = Date.now() - t0;
  log.info(`MR data hazır: ${symbol}/${timeframe} (${elapsed}ms)`, {
    totalOI: (totalOI / 1e6).toFixed(1) + 'M',
    avgFunding: (avgFunding * 100).toFixed(4) + '%',
    liqLong: (totalLiqLongUsd / 1e6).toFixed(2) + 'M',
    liqShort: (totalLiqShortUsd / 1e6).toFixed(2) + 'M',
  });

  return {
    symbol,
    timeframe,
    timestamp: Date.now(),
    exchanges: {
      binance: binanceData,
      bybit: bybitData,
      okx: okxData,
    },
    aggregated: {
      totalOI,
      avgFunding,
      combinedLongRatio,
      combinedShortRatio,
      combinedLongShortRatio,
      totalLiqLongUsd,
      totalLiqShortUsd,
      totalNetCvd,
      combinedOrderbookBids,
      combinedOrderbookAsks,
    },
  };
}

// ── Orderbook birleştirme yardımcısı ─────────────────────────────────────────

function mergeOrderbookSide(
  levels: [number, number][],
  direction: 'asc' | 'desc',
): [number, number][] {
  const map = new Map<number, number>();

  for (const [price, qty] of levels) {
    if (price <= 0 || qty <= 0) continue;
    // Fiyatı 2 ondalığa yuvarla (gruplama için)
    const key = Math.round(price * 100) / 100;
    map.set(key, (map.get(key) ?? 0) + qty);
  }

  const merged = [...map.entries()].map(([p, q]) => [p, q] as [number, number]);

  if (direction === 'desc') {
    merged.sort((a, b) => b[0] - a[0]);
  } else {
    merged.sort((a, b) => a[0] - b[0]);
  }

  return merged;
}

// ─────────────────────────────────────────────────────────────────────────────
// services/OverviewService.ts — Market Overview (Piyasa Genel Durum) Servisi
// ─────────────────────────────────────────────────────────────────────────────
// Uzman trader'ın ihtiyaç duyduğu tüm makro/mikro piyasa verileri:
//   1. BTC Fiyat & Değişim
//   2. BTC OI (Open Interest) & OI Delta
//   3. BTC Funding Rate (3 borsa ortalaması)
//   4. BTC L/S Ratio (3 borsa ortalaması)
//   5. BTC CVD (Kümülatif Hacim Deltası)
//   6. BTC Tasfiye İstatistikleri (Long vs Short)
//   7. BTC.D (Dominans) — CoinGecko
//   8. Tüm zaman dilimleri paralel çekilir → bias puanı hesaplanır
// ─────────────────────────────────────────────────────────────────────────────

import axios from 'axios';
import { Logger } from '../utils/logger.js';
import { fetchMrData, type MrResult, type MrTimeframe } from './MrService.js';

const log = new Logger('OverviewSvc');

const BINANCE_REST = 'https://fapi.binance.com';
const COINGECKO    = 'https://api.coingecko.com/api/v3';
const TIMEOUT      = 15_000;

// ── Tipler ───────────────────────────────────────────────────────────────────

/** Tek bir zaman diliminin analizi */
export interface TimeframeBias {
  timeframe: MrTimeframe;

  // ── Ham Metrikler ──
  price: number;
  priceChange: number;       // % değişim
  priceChangeAbs: number;    // mutlak değişim $

  oiTotal: number;           // toplam OI (USD)
  oiDelta: number;           // OI değişimi (USD)
  oiDeltaPct: number;        // OI değişimi %

  fundingRate: number;       // ortalama funding (raw)
  fundingAnnualized: number; // yıllık funding %

  lsRatio: number;           // Long/Short oranı
  longPct: number;           // Long %
  shortPct: number;          // Short %

  cvd: number;               // net CVD (USD)

  liqLongUsd: number;        // Long tasfiyeler (USD)
  liqShortUsd: number;       // Short tasfiyeler (USD)
  liqDominance: 'long' | 'short' | 'balanced'; // Hangi taraf daha çok tasfiye edilmiş

  // ── Borsa Kırılımı ──
  exchanges: {
    binance: ExchangeMetrics;
    bybit: ExchangeMetrics;
    okx: ExchangeMetrics;
  };

  // ── Sinyal Puanları (−100 ile +100 arası) ──
  oiSignal: number;          // OI momentum sinyali
  fundingSignal: number;     // Funding sentiment sinyali
  lsSignal: number;          // L/S ratio sinyali
  cvdSignal: number;         // CVD momentum sinyali
  liqSignal: number;         // Tasfiye imbalance sinyali
  priceSignal: number;       // Fiyat momentum sinyali

  // ── Genel Yön ──
  totalScore: number;        // −100 ile +100 arası toplam skor
  bias: 'STRONG_LONG' | 'LONG' | 'NEUTRAL' | 'SHORT' | 'STRONG_SHORT';
  actionLabel: string;       // İnsan okunur eylem önerisi
}

export interface ExchangeMetrics {
  oi: number;
  oiDelta: number;
  funding: number;
  lsRatio: number;
  cvd: number;
  liqLong: number;
  liqShort: number;
}

export interface MarketOverview {
  symbol: string;
  timestamp: number;
  fetchDurationMs: number;

  // ── Global Metrikler ──
  btcPrice: number;
  btcDominance: number | null; // CoinGecko'dan — başarısız olursa null

  // ── Zaman Dilimi Analizleri ──
  timeframes: TimeframeBias[];

  // ── Genel Konsensüs ──
  overallScore: number;      // 4 TF'nin ağırlıklı ortalaması
  overallBias: 'STRONG_LONG' | 'LONG' | 'NEUTRAL' | 'SHORT' | 'STRONG_SHORT';
  overallAction: string;
}

// ── Yardımcılar ──────────────────────────────────────────────────────────────

function sf(v: unknown): number {
  const n = parseFloat(String(v ?? '0'));
  return isFinite(n) ? n : 0;
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

// ── BTC Fiyat Bilgisi ────────────────────────────────────────────────────────

interface PriceInfo {
  price: number;
  change24h: number;     // % değişim
  changeAbs24h: number;  // mutlak fark
}

async function fetchBtcPrice(): Promise<PriceInfo> {
  try {
    const r = await axios.get(`${BINANCE_REST}/fapi/v1/ticker/24hr`, {
      params: { symbol: 'BTCUSDT' },
      timeout: TIMEOUT,
    });
    return {
      price:       sf(r.data?.lastPrice),
      change24h:   sf(r.data?.priceChangePercent),
      changeAbs24h: sf(r.data?.priceChange),
    };
  } catch {
    return { price: 0, change24h: 0, changeAbs24h: 0 };
  }
}

// ── BTC Dominance (CoinGecko) ────────────────────────────────────────────────

let btcDomCache: { value: number; ts: number } | null = null;
const BTC_DOM_TTL = 5 * 60 * 1000; // 5 dakika cache

async function fetchBtcDominance(): Promise<number | null> {
  if (btcDomCache && Date.now() - btcDomCache.ts < BTC_DOM_TTL) {
    return btcDomCache.value;
  }
  try {
    const r = await axios.get(`${COINGECKO}/global`, { timeout: TIMEOUT });
    const dom = sf(r.data?.data?.market_cap_percentage?.btc);
    if (dom > 0) {
      btcDomCache = { value: dom, ts: Date.now() };
      return dom;
    }
    return btcDomCache?.value ?? null;
  } catch {
    return btcDomCache?.value ?? null;
  }
}

// ── Sinyal Hesaplayıcıları ───────────────────────────────────────────────────

/** OI Delta sinyali: büyüyen OI = momentum var, azalan = azalıyor */
function calcOISignal(oiDelta: number, oiTotal: number): number {
  if (oiTotal === 0) return 0;
  const pct = (oiDelta / oiTotal) * 100;
  // +2% OI artışı = +50 sinyal, -2% = -50
  return clamp(pct * 25, -100, 100);
}

/** Funding sinyali: pozitif funding = aşırı long = contrarian short */
function calcFundingSignal(rate: number): number {
  // 0.01% = nötr, 0.05% = aşırı bullish (contrarian bearish)
  const bps = rate * 10000; // basis points
  // Yüksek pozitif funding → contrarian short sinyali
  // Ama aşırı olumsuz funding da contrarian long sinyali
  // Normal aralık: -5 to +5 bps → nötr
  if (Math.abs(bps) <= 5) return 0;
  return clamp(-bps * 4, -100, 100);
}

/** L/S Ratio sinyali: crowd'un tersi — çoğunluk long ise short sinyali */
function calcLSSignal(ratio: number): number {
  if (ratio === 0) return 0;
  // ratio = 1.0 → nötr, 1.3 → %30 fazla long → -30 sinyal
  const deviation = (ratio - 1) * 100;
  return clamp(-deviation * 2, -100, 100);
}

/** CVD sinyali: pozitif CVD = alıcı ağırlıklı = long momentum */
function calcCVDSignal(cvd: number, oiTotal: number): number {
  if (oiTotal === 0) return 0;
  const pct = (cvd / oiTotal) * 100;
  return clamp(pct * 20, -100, 100);
}

/** Liq sinyali: çok long tasfiye edilmişse → dip yakın (long sinyal) */
function calcLiqSignal(liqLong: number, liqShort: number): number {
  const total = liqLong + liqShort;
  if (total < 100_000) return 0; // < $100K = insignificant
  const longPct = liqLong / total;
  // longPct > 0.7 → long tasfiye fazla → dip yakın → +40 sinyal
  // shortPct > 0.7 → short tasfiye fazla → top yakın → -40 sinyal
  const imbalance = (longPct - 0.5) * 2; // -1 to +1
  // Tersine: çok long tasfiye = alım fırsatı
  return clamp(imbalance * 60, -100, 100);
}

/** Fiyat değişim sinyali: momentum yönü */
function calcPriceSignal(priceChangePct: number): number {
  return clamp(priceChangePct * 10, -100, 100);
}

/** Fiyat değişim hesabı için BTC kline ile % */
async function fetchPriceChangeForTf(
  timeframe: MrTimeframe,
): Promise<{ changePct: number; changeAbs: number; lastPrice: number }> {
  try {
    const intervalMap: Record<MrTimeframe, string> = {
      '15m': '15m', '1h': '1h', '4h': '4h', '24h': '1d',
    };
    const r = await axios.get(`${BINANCE_REST}/fapi/v1/klines`, {
      params: { symbol: 'BTCUSDT', interval: intervalMap[timeframe], limit: 2 },
      timeout: TIMEOUT,
    });
    const klines = r.data as unknown[][];
    if (!klines || klines.length < 2) return { changePct: 0, changeAbs: 0, lastPrice: 0 };
    const prevClose = sf(klines[0]![4]);
    const currClose = sf(klines[1]![4]);
    if (prevClose === 0) return { changePct: 0, changeAbs: 0, lastPrice: currClose };
    return {
      changePct: ((currClose - prevClose) / prevClose) * 100,
      changeAbs: currClose - prevClose,
      lastPrice: currClose,
    };
  } catch {
    return { changePct: 0, changeAbs: 0, lastPrice: 0 };
  }
}

/** Bias etiketini hesapla */
function scoreToBias(score: number): 'STRONG_LONG' | 'LONG' | 'NEUTRAL' | 'SHORT' | 'STRONG_SHORT' {
  if (score >= 40)  return 'STRONG_LONG';
  if (score >= 15)  return 'LONG';
  if (score <= -40) return 'STRONG_SHORT';
  if (score <= -15) return 'SHORT';
  return 'NEUTRAL';
}

/** Eylem etiketi */
function biasToAction(bias: string, score: number): string {
  switch (bias) {
    case 'STRONG_LONG':  return `GÜÇLÜ LONG SİNYAL — Agresif alım alanı (skor: ${score > 0 ? '+' : ''}${score.toFixed(0)})`;
    case 'LONG':         return `LONG EĞİLİM — Dip alımlar düşünülebilir (skor: ${score > 0 ? '+' : ''}${score.toFixed(0)})`;
    case 'NEUTRAL':      return `KARARSIZ / BEKLE — Net yön yok, işlem yapma (skor: ${score > 0 ? '+' : ''}${score.toFixed(0)})`;
    case 'SHORT':        return `SHORT EĞİLİM — Tepe satışlar düşünülebilir (skor: ${score > 0 ? '+' : ''}${score.toFixed(0)})`;
    case 'STRONG_SHORT': return `GÜÇLÜ SHORT SİNYAL — Agresif satış alanı (skor: ${score > 0 ? '+' : ''}${score.toFixed(0)})`;
    default:             return `HESAPLANAMADI`;
  }
}

// ── MR Sonucundan TimeframeBias Oluştur ──────────────────────────────────────

function mrToTimeframeBias(
  mr: MrResult,
  priceChange: { changePct: number; changeAbs: number; lastPrice: number },
): TimeframeBias {
  const agg = mr.aggregated;
  const tf  = mr.timeframe as MrTimeframe;

  const oiDeltaPct   = agg.totalOI > 0 ? (agg.oiDelta / agg.totalOI) * 100 : 0;
  const fundingAnn  = agg.avgFunding * 3 * 365 * 100; // annualized %
  const liqTotal     = agg.totalLiqLongUsd + agg.totalLiqShortUsd;
  const liqDominance = liqTotal < 100_000 ? 'balanced' as const
    : agg.totalLiqLongUsd > agg.totalLiqShortUsd * 1.3 ? 'long' as const
    : agg.totalLiqShortUsd > agg.totalLiqLongUsd * 1.3 ? 'short' as const
    : 'balanced' as const;

  // Sinyal hesapla
  const oiSignal      = calcOISignal(agg.oiDelta, agg.totalOI);
  const fundingSignal = calcFundingSignal(agg.avgFunding);
  const lsSignal      = calcLSSignal(agg.combinedLongShortRatio);
  const cvdSignal     = calcCVDSignal(agg.totalNetCvd, agg.totalOI);
  const liqSignal     = calcLiqSignal(agg.totalLiqLongUsd, agg.totalLiqShortUsd);
  const priceSignal   = calcPriceSignal(priceChange.changePct);

  // Ağırlıklı toplam skor
  // OI: %20, Funding: %15, L/S: %10, CVD: %25, Liq: %15, Price: %15
  const totalScore = clamp(
    oiSignal * 0.20 +
    fundingSignal * 0.15 +
    lsSignal * 0.10 +
    cvdSignal * 0.25 +
    liqSignal * 0.15 +
    priceSignal * 0.15,
    -100, 100,
  );

  const bias = scoreToBias(totalScore);

  // Borsa kırılımı
  const exMap = (key: 'binance' | 'bybit' | 'okx'): ExchangeMetrics => ({
    oi:       mr.exchanges[key].openInterest,
    oiDelta:  mr.exchanges[key].oiDelta,
    funding:  mr.exchanges[key].fundingRate,
    lsRatio:  mr.exchanges[key].longShortRatio,
    cvd:      mr.exchanges[key].netCvd,
    liqLong:  mr.exchanges[key].liqLongUsd,
    liqShort: mr.exchanges[key].liqShortUsd,
  });

  return {
    timeframe: tf,
    price: priceChange.lastPrice,
    priceChange: priceChange.changePct,
    priceChangeAbs: priceChange.changeAbs,
    oiTotal: agg.totalOI,
    oiDelta: agg.oiDelta,
    oiDeltaPct: oiDeltaPct,
    fundingRate: agg.avgFunding,
    fundingAnnualized: fundingAnn,
    lsRatio: agg.combinedLongShortRatio,
    longPct: agg.combinedLongRatio * 100,
    shortPct: agg.combinedShortRatio * 100,
    cvd: agg.totalNetCvd,
    liqLongUsd: agg.totalLiqLongUsd,
    liqShortUsd: agg.totalLiqShortUsd,
    liqDominance,
    exchanges: {
      binance: exMap('binance'),
      bybit: exMap('bybit'),
      okx: exMap('okx'),
    },
    oiSignal,
    fundingSignal,
    lsSignal,
    cvdSignal,
    liqSignal,
    priceSignal,
    totalScore,
    bias,
    actionLabel: biasToAction(bias, totalScore),
  };
}

// ── Ana Fonksiyon ────────────────────────────────────────────────────────────

export async function fetchMarketOverview(symbol = 'BTCUSDT'): Promise<MarketOverview> {
  const t0 = Date.now();
  log.info(`Overview çekiliyor: ${symbol}`);

  // 4 TF MR + BTC fiyat + BTC dominance + 4 TF price change = 10 paralel çağrı
  const [
    mr15m, mr1h, mr4h, mr24h,
    btcPrice, btcDom,
    pc15m, pc1h, pc4h, pc24h,
  ] = await Promise.all([
    fetchMrData(symbol, '15m'),
    fetchMrData(symbol, '1h'),
    fetchMrData(symbol, '4h'),
    fetchMrData(symbol, '24h'),
    fetchBtcPrice(),
    fetchBtcDominance(),
    fetchPriceChangeForTf('15m'),
    fetchPriceChangeForTf('1h'),
    fetchPriceChangeForTf('4h'),
    fetchPriceChangeForTf('24h'),
  ]);

  const mrResults = [mr15m, mr1h, mr4h, mr24h];
  const priceChanges = [pc15m, pc1h, pc4h, pc24h];

  const tfBiases = mrResults.map((mr, i) => mrToTimeframeBias(mr, priceChanges[i]!));

  // Genel konsensüs — zaman dilimlerine ağırlık ver
  // 24h: %35, 4h: %30, 1h: %20, 15m: %15
  const weights = [0.15, 0.20, 0.30, 0.35]; // 15m, 1h, 4h, 24h
  let overallScore = 0;
  for (let i = 0; i < tfBiases.length; i++) {
    overallScore += tfBiases[i]!.totalScore * weights[i]!;
  }
  overallScore = clamp(overallScore, -100, 100);

  const overallBias = scoreToBias(overallScore);

  const elapsed = Date.now() - t0;
  log.info(`Overview hazır: ${symbol} (${elapsed}ms)`, {
    overall: overallBias,
    score: overallScore.toFixed(1),
    scores: tfBiases.map(b => `${b.timeframe}:${b.totalScore.toFixed(0)}`).join(', '),
  });

  return {
    symbol,
    timestamp: Date.now(),
    fetchDurationMs: elapsed,
    btcPrice: btcPrice.price,
    btcDominance: btcDom,
    timeframes: tfBiases,
    overallScore,
    overallBias,
    overallAction: biasToAction(overallBias, overallScore),
  };
}

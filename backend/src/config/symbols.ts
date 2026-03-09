// ─────────────────────────────────────────────────────────────────────────────
// config/symbols.ts — Dinamik Sembol Yönetimi & Bybit Instrument Registry
// ─────────────────────────────────────────────────────────────────────────────
//
// Hardcoded sembol listesi KALDIRILDI.
// Sembol bilgileri Bybit V5 instruments-info endpoint'inden çekilir.
// Binance ve OKX format dönüşümleri otomatik yapılır:
//   Bybit:   BTCUSDT
//   Binance: btcusdt (küçük harf)
//   OKX:     BTC-USDT-SWAP
//
// ─────────────────────────────────────────────────────────────────────────────

import axios from 'axios';
import { Exchange } from '../interfaces/index.js';
import { Logger } from '../utils/logger.js';

const log = new Logger('Symbols');

// ─── Tip Tanımları ───────────────────────────────────────────────────────────

/** Tek bir borsanın sembol format bilgisi */
export interface ExchangeSymbolInfo {
  /** O borsanın beklediği sembol formatı — WS abone olurken kullanılır */
  symbol: string;
  /** REST endpoint'lerinde kullanılan format */
  restSymbol: string;
}

/** Bir enstrümanın tüm borsa eşlemeleri ve piyasa parametreleri */
export interface SymbolConfig {
  /** Bizim sistemimizin normalize sembolü (key olarak kullanılır) */
  unified: string;

  /** Borsa bazlı sembol eşleştirmeleri */
  exchanges: Record<Exchange, ExchangeSymbolInfo>;

  /** Ortak fiyat adımı — emir defterlerini birleştirirken yuvarlanır */
  tickSize: number;

  /** Ortak miktar adımı */
  stepSize: number;

  /** Fiyat ondalık basamak sayısı — tickSize'dan türetilir */
  pricePrecision: number;

  /** Miktar ondalık basamak sayısı — stepSize'dan türetilir */
  quantityPrecision: number;

  /**
   * OKX sözleşme büyüklüğü (contract size).
   * OKX → base cinsine çevirmek için: quantity = contracts * contractSize
   * OKX'te bu pair yoksa 1 kullanılır.
   */
  okxContractSize: number;
}

// ─── Yardımcı: Ondalık basamak hesaplama ─────────────────────────────────────

function countDecimals(value: number): number {
  if (Math.floor(value) === value) return 0;
  const str = value.toString();
  const parts = str.split('.');
  return parts[1]?.length ?? 0;
}

// ─── Sembol Format Dönüşüm Fonksiyonları ────────────────────────────────────

/**
 * Bybit unified sembol → Binance WS formatı (küçük harf)
 * BTCUSDT → btcusdt
 */
export function toBinanceSymbol(unified: string): string {
  return unified.toLowerCase();
}

/**
 * Bybit unified sembol → Binance REST formatı (büyük harf)
 * BTCUSDT → BTCUSDT (aynı)
 */
export function toBinanceRestSymbol(unified: string): string {
  return unified;
}

/**
 * Bybit unified sembol → OKX format: BTC-USDT-SWAP
 * BTCUSDT → BTC-USDT-SWAP
 */
export function toOkxSymbol(unified: string): string {
  const base = unified.replace(/USDT$/i, '');
  return `${base}-USDT-SWAP`;
}

/** Verilen unified sembol için tüm borsa eşlemelerini oluştur */
function buildExchangeMapping(unified: string): Record<Exchange, ExchangeSymbolInfo> {
  return {
    [Exchange.BINANCE]: {
      symbol: toBinanceSymbol(unified),
      restSymbol: toBinanceRestSymbol(unified),
    },
    [Exchange.BYBIT]: {
      symbol: unified,
      restSymbol: unified,
    },
    [Exchange.OKX]: {
      symbol: toOkxSymbol(unified),
      restSymbol: toOkxSymbol(unified),
    },
  };
}

// ─── Dinamik Sembol Registry ─────────────────────────────────────────────────

/**
 * Runtime'da doldurulur — her sembol ilk seçildiğinde REST'ten
 * tickSize/stepSize/contractSize çekilir ve buraya kaydedilir.
 */
const SYMBOL_REGISTRY: Map<string, SymbolConfig> = new Map();

// ─── Bybit Instrument Tipi ──────────────────────────────────────────────────

interface BybitInstrumentRaw {
  symbol: string;
  baseCoin: string;
  quoteCoin: string;
  status: string;
  priceFilter: { tickSize: string };
  lotSizeFilter: { qtyStep: string };
}

// ─── Bybit Linear Sembol Listesi ─────────────────────────────────────────────

/** Tüm Bybit Linear USDT Perp sembollerini çeker, 24h hacime göre sıralar */
export async function fetchBybitLinearSymbols(): Promise<string[]> {
  log.info('Bybit Linear sembol listesi çekiliyor...');

  const allSymbols: string[] = [];
  let cursor = '';

  // Bybit V5 paginasyon — 1000 limit ile döngü
  for (;;) {
    const url =
      'https://api.bybit.com/v5/market/instruments-info?category=linear&limit=1000' +
      (cursor ? `&cursor=${cursor}` : '');
    const resp = await axios.get(url, { timeout: 15_000 });
    const result = resp.data?.result;
    const list = (result?.list ?? []) as BybitInstrumentRaw[];

    for (const inst of list) {
      if (inst.quoteCoin === 'USDT' && inst.status === 'Trading') {
        allSymbols.push(inst.symbol);
      }
    }

    cursor = result?.nextPageCursor ?? '';
    if (!cursor || list.length === 0) break;
  }

  log.info(`${allSymbols.length} Bybit Linear USDT Perp sembol bulundu`);

  // ── 24h hacim verisi ile sırala ─────────────────────────────────────────
  try {
    const tickerUrl = 'https://api.bybit.com/v5/market/tickers?category=linear';
    const tickerResp = await axios.get(tickerUrl, { timeout: 15_000 });
    const tickers = (tickerResp.data?.result?.list ?? []) as Array<{
      symbol: string;
      turnover24h: string;
    }>;

    // symbol → 24h USDT turnover haritası
    const volumeMap = new Map<string, number>();
    for (const t of tickers) {
      volumeMap.set(t.symbol, parseFloat(t.turnover24h) || 0);
    }

    // Hacime göre azalan sırala (en yüksek hacim en üstte)
    const symbolSet = new Set(allSymbols);
    allSymbols.length = 0;
    // Sadece aktif sembollerimizde olanları sırala
    const sorted = [...symbolSet].sort((a, b) => {
      return (volumeMap.get(b) ?? 0) - (volumeMap.get(a) ?? 0);
    });
    allSymbols.push(...sorted);

    log.info(`Semboller 24h hacime göre sıralandı (Top 5: ${allSymbols.slice(0, 5).join(', ')})`);
  } catch (err) {
    log.warn('Hacim verisi alınamadı, semboller alfabetik sıralanıyor');
    allSymbols.sort();
  }

  return allSymbols;
}

// ─── Tek Sembol Kayıt (REST Fetch + Registry) ───────────────────────────────

/**
 * Bybit'ten enstrüman bilgisini çeker, OKX contractSize'ı alır,
 * SymbolConfig oluşturur ve SYMBOL_REGISTRY'ye kaydeder.
 * Zaten kayıtlıysa cache'ten döner.
 */
export async function fetchAndRegisterSymbol(unified: string): Promise<SymbolConfig> {
  const existing = SYMBOL_REGISTRY.get(unified);
  if (existing) return existing;

  log.info(`Sembol bilgisi çekiliyor: ${unified}`);

  // 1) Bybit tickSize & stepSize
  const bybitUrl = `https://api.bybit.com/v5/market/instruments-info?category=linear&symbol=${unified}`;
  const bybitResp = await axios.get(bybitUrl, { timeout: 10_000 });
  const bybitList = (bybitResp.data?.result?.list ?? []) as BybitInstrumentRaw[];

  if (bybitList.length === 0) {
    throw new Error(`[symbols] Bybit'te bulunamadı: "${unified}"`);
  }

  const inst = bybitList[0]!;
  const tickSize = parseFloat(inst.priceFilter.tickSize);
  const stepSize = parseFloat(inst.lotSizeFilter.qtyStep);

  // 2) OKX contract size — opsiyonel, yoksa fallback=1
  let okxContractSize = 1;
  try {
    const okxInstId = toOkxSymbol(unified);
    const okxUrl = `https://www.okx.com/api/v5/public/instruments?instType=SWAP&instId=${okxInstId}`;
    const okxResp = await axios.get(okxUrl, { timeout: 5_000 });
    const okxData = okxResp.data?.data ?? [];
    if (okxData.length > 0 && okxData[0].ctVal) {
      okxContractSize = parseFloat(okxData[0].ctVal) || 1;
    }
  } catch {
    log.warn(`OKX contract size alınamadı (${unified}), fallback=1`);
  }

  const config: SymbolConfig = {
    unified,
    exchanges: buildExchangeMapping(unified),
    tickSize,
    stepSize,
    pricePrecision: countDecimals(tickSize),
    quantityPrecision: countDecimals(stepSize),
    okxContractSize,
  };

  SYMBOL_REGISTRY.set(unified, config);
  log.info(`Sembol kaydedildi: ${unified}`, {
    tickSize,
    stepSize,
    pricePrecision: config.pricePrecision,
    quantityPrecision: config.quantityPrecision,
    okxContractSize,
  });

  return config;
}

// ─── Public Accessor'lar (mevcut API uyumlu) ─────────────────────────────────

/**
 * Normalize sembol adından konfigürasyon döndürür.
 * fetchAndRegisterSymbol ile ÖNCEDEN kaydedilmiş olmalıdır.
 */
export function getSymbolConfig(unifiedSymbol: string): SymbolConfig {
  const config = SYMBOL_REGISTRY.get(unifiedSymbol);
  if (!config) {
    throw new Error(
      `[symbols] Tanımlanmamış sembol: "${unifiedSymbol}". ` +
      `Önce fetchAndRegisterSymbol() ile kaydedin. ` +
      `Kayıtlı: ${[...SYMBOL_REGISTRY.keys()].join(', ') || '(boş)'}`,
    );
  }
  return config;
}

/**
 * Belirli bir borsa için WS sembol formatını döndürür.
 * Örn: getExchangeSymbol('BTCUSDT', Exchange.OKX) → 'BTC-USDT-SWAP'
 */
export function getExchangeSymbol(unifiedSymbol: string, exchange: Exchange): string {
  return getSymbolConfig(unifiedSymbol).exchanges[exchange].symbol;
}

/**
 * Belirli bir borsa için REST sembol formatını döndürür.
 */
export function getExchangeRestSymbol(unifiedSymbol: string, exchange: Exchange): string {
  return getSymbolConfig(unifiedSymbol).exchanges[exchange].restSymbol;
}

/**
 * Tüm kayıtlı sembol adlarını döndürür.
 */
export function getAllSymbols(): string[] {
  return [...SYMBOL_REGISTRY.keys()];
}

/**
 * Varsayılan sembol — uygulama ilk açıldığında bu sembolle başlar.
 */
export const DEFAULT_SYMBOL = 'BTCUSDT';

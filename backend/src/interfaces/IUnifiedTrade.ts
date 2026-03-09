// ─────────────────────────────────────────────────────────────────────────────
// IUnifiedTrade.ts — Normalize Edilmiş İşlem (Tape / Time & Sales)
// ─────────────────────────────────────────────────────────────────────────────

import type { Exchange, TradeSide } from './IExchangeService.js';

/**
 * 3 borsanın birleştirilen trade akışındaki tek bir işlem kaydı.
 * Tape (Akan Bant) bileşeni bu verileri timestamp sırasıyla gösterir.
 */
export interface IUnifiedTrade {
  /**
   * Benzersiz tanımlayıcı — `${exchange}_${rawTradeId}` formatında.
   * Aynı trade'in farklı borsalarda tekrar sayılmasını engeller.
   */
  id: string;

  /** Normalize edilmiş sembol — örn: "BTCUSDT" */
  symbol: string;

  /** İşlemin gerçekleştiği borsa */
  exchange: Exchange;

  /** İşlem fiyatı */
  price: number;

  /** İşlem miktarı (base cinsinden — örn: BTC) */
  quantity: number;

  /** İşlem hacmi (quote cinsinden — price × quantity, USD eşdeğeri) */
  quoteQty: number;

  /**
   * Agresör (taker) tarafı:
   * - BUY  = Alıcı agresif (piyasa emri ile satıştan aldı → fiyat yukarı baskı)
   * - SELL = Satıcı agresif (piyasa emri ile alışa sattı → fiyat aşağı baskı)
   */
  side: TradeSide;

  /** İşlem zamanı — Unix epoch milisaniyesi (tüm borsalar bu formata normalize edilir) */
  timestamp: number;
}

/**
 * Trade batch + anlık CVD değeri.
 * TradeAggregator buffer'ı flush ettiğinde bu paket halinde gönderilir.
 */
export interface ITradeWithCVD {
  /** Zaman sırasına göre dizilmiş trade'ler */
  trades: IUnifiedTrade[];

  /** Kümülatif Hacim Deltası (USD cinsinden) */
  cvd: number;

  /** Bu batch'in zaman damgası */
  timestamp: number;
}

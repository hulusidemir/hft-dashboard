// ─────────────────────────────────────────────────────────────────────────────
// IUnifiedLiquidation.ts — Normalize Edilmiş Tasfiye Olayı
// ─────────────────────────────────────────────────────────────────────────────

import type { Exchange, LiquidationSide } from './IExchangeService.js';

/**
 * 3 borsadan gelen margin call patlamalarını temsil eden normalize edilmiş tasfiye kaydı.
 * Frontend'de "[BINANCE] 500k$ SHORT LIQ" gibi etiketlerle gösterilir.
 */
export interface IUnifiedLiquidation {
  /** Benzersiz tanımlayıcı — `${exchange}_liq_${timestamp}_${price}` */
  id: string;

  /** Normalize edilmiş sembol — örn: "BTCUSDT" */
  symbol: string;

  /** Tasfiyenin gerçekleştiği borsa */
  exchange: Exchange;

  /**
   * Tasfiye edilen pozisyon yönü:
   * - LONG  = Uzun pozisyon tasfiye edildi (fiyat düştü → zorla satış)
   * - SHORT = Kısa pozisyon tasfiye edildi (fiyat yükseldi → zorla alış)
   */
  side: LiquidationSide;

  /** Tasfiye fiyatı */
  price: number;

  /** Tasfiye edilen miktar (base cinsinden) */
  quantity: number;

  /**
   * Tasfiye edilen hacim (quote cinsinden — price × quantity).
   * Kullanıcı arayüzünde "500k$" gibi gösterilir.
   */
  quoteQty: number;

  /** Tasfiye zamanı — Unix epoch milisaniyesi */
  timestamp: number;
}

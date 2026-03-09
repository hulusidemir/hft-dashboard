// ─────────────────────────────────────────────────────────────────────────────
// IUnifiedOpenInterest.ts — Birleştirilmiş Açık Pozisyon Verisi
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 3 borsanın açık pozisyon (Open Interest) verisinin kümülatif birleşimi.
 * ~2 saniyelik REST polling döngüsüyle güncellenir.
 */
export interface IUnifiedOpenInterest {
  /** Normalize edilmiş sembol — örn: "BTCUSDT" */
  symbol: string;

  /** Ölçüm zamanı — Unix epoch milisaniyesi */
  timestamp: number;

  /** Binance açık pozisyon (USD cinsinden) */
  binanceOI: number;

  /** Bybit açık pozisyon (USD cinsinden) */
  bybitOI: number;

  /** OKX açık pozisyon (USD cinsinden) */
  okxOI: number;

  /** 3 borsanın toplamı (USD) */
  totalOI: number;

  /** Bir önceki ölçüme göre değişim (USD) — pozitif: artan, negatif: azalan */
  deltaOI: number;

  /** Bir önceki ölçüme göre yüzdesel değişim */
  deltaOIPercent: number;
}

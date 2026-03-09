// ─────────────────────────────────────────────────────────────────────────────
// IUnifiedOrderBook.ts — 3 Borsanın Birleştirilmiş Emir Defteri
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Tek bir fiyat kademesindeki birleştirilmiş likidite.
 * Toplam miktarın yanı sıra borsa bazlı kırılımı da taşır —
 * bu sayede ısı haritasında her borsanın katkısı ayrı renk katmanıyla gösterilebilir.
 */
export interface PriceLevel {
  /** Tick-size'a yuvarlanmış fiyat */
  price: number;

  /** 3 borsanın toplam miktarı (base cinsinden) */
  quantity: number;

  /** Binance'ın bu fiyat kademesindeki miktarı */
  binanceQty: number;

  /** Bybit'in bu fiyat kademesindeki miktarı */
  bybitQty: number;

  /** OKX'in bu fiyat kademesindeki miktarı */
  okxQty: number;
}

/**
 * Frontend'e iletilen yekpare (unified) emir defteri.
 * Her ~50ms'de yeniden hesaplanır.
 */
export interface IUnifiedOrderBook {
  /** Normalize edilmiş sembol — örn: "BTCUSDT" */
  symbol: string;

  /** Birleştirme anının Unix epoch zamanı (milisaniye) */
  timestamp: number;

  /** Orta fiyat: (bestBid + bestAsk) / 2 */
  midPrice: number;

  /** En düşük satış ile en yüksek alış arasındaki fark */
  spread: number;

  /**
   * Alış (bid) kademeleri — en yüksek fiyattan düşüğe doğru sıralı (desc).
   * İlk eleman = en iyi bid.
   */
  bids: PriceLevel[];

  /**
   * Satış (ask) kademeleri — en düşük fiyattan yükseğe doğru sıralı (asc).
   * İlk eleman = en iyi ask.
   */
  asks: PriceLevel[];

  /** Her borsa için ayrı ayrı en iyi bid/ask — spread analizi için */
  bestBids: {
    binance: number;
    bybit: number;
    okx: number;
  };

  bestAsks: {
    binance: number;
    bybit: number;
    okx: number;
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// IExchangeService.ts — Borsa Servis Kontratı & Dahili Ham Veri Tipleri
// ─────────────────────────────────────────────────────────────────────────────

/** Desteklenen borsalar */
export enum Exchange {
  BINANCE = 'BINANCE',
  BYBIT   = 'BYBIT',
  OKX     = 'OKX',
}

/** İşlem tarafı — agresör (taker) perspektifinden */
export type TradeSide = 'BUY' | 'SELL';

/** Tasfiye edilen pozisyon yönü */
export type LiquidationSide = 'LONG' | 'SHORT';

// ─────────────────────────────────────────────────────────────────────────────
// Borsalardan parse edildikten sonra, normalize edilmeden önce kullanılan
// dahili (internal) ham veri tipleri. Her service sınıfı bunları üretir,
// aggregator'lar tüketir.
// ─────────────────────────────────────────────────────────────────────────────

/** Borsa-spesifik order book snapshot (REST'ten alınır) */
export interface ExchangeOrderBookSnapshot {
  exchange: Exchange;
  symbol: string;
  lastUpdateId: number;
  bids: [price: number, qty: number][];
  asks: [price: number, qty: number][];
  timestamp: number;
}

/** Borsa-spesifik order book delta (WS'ten gelir) */
export interface ExchangeOrderBookDelta {
  exchange: Exchange;
  symbol: string;
  firstUpdateId?: number;
  lastUpdateId: number;
  bids: [price: number, qty: number][];
  asks: [price: number, qty: number][];
  timestamp: number;
}

/** Borsa-spesifik ham trade */
export interface ExchangeRawTrade {
  exchange: Exchange;
  id: string;
  symbol: string;
  price: number;
  quantity: number;
  side: TradeSide;
  timestamp: number;
}

/** Borsa-spesifik ham tasfiye */
export interface ExchangeRawLiquidation {
  exchange: Exchange;
  symbol: string;
  side: LiquidationSide;
  price: number;
  quantity: number;
  timestamp: number;
}

/** Borsa-spesifik ham açık pozisyon */
export interface ExchangeRawOI {
  exchange: Exchange;
  symbol: string;
  openInterest: number;   // Sözleşme veya base cinsinden
  openInterestUsd: number; // USD karşılığı
  timestamp: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Borsa Servis Arayüzü
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Her borsa servis sınıfının uygulaması gereken kontrat.
 * EventEmitter pattern ile veri akışı sağlanır.
 */
export interface IExchangeService {
  /** Bu servisin temsil ettiği borsa */
  readonly exchange: Exchange;

  /** En son ölçülen WebSocket round-trip gecikmesi (ms) */
  readonly pingMs: number;

  /** Belirtilen sembol için WS bağlantısını aç ve kanallara abone ol */
  connect(symbol: string): Promise<void>;

  /** Bağlantıyı temiz bir şekilde kapat */
  disconnect(): void;

  /** Bağlantı durumu */
  readonly isConnected: boolean;

  /** Yerel emir defteri — BID tarafı (fiyat → miktar) */
  readonly localBids: ReadonlyMap<number, number>;

  /** Yerel emir defteri — ASK tarafı (fiyat → miktar) */
  readonly localAsks: ReadonlyMap<number, number>;

  // ── Event Listener'lar ──────────────────────────────────────────────────

  on(event: 'orderbook_snapshot', cb: (data: ExchangeOrderBookSnapshot) => void): this;
  on(event: 'orderbook_delta',   cb: (data: ExchangeOrderBookDelta) => void): this;
  on(event: 'trade',             cb: (data: ExchangeRawTrade[]) => void): this;
  on(event: 'liquidation',       cb: (data: ExchangeRawLiquidation) => void): this;
  on(event: 'open_interest',     cb: (data: ExchangeRawOI) => void): this;
  on(event: 'ping',              cb: (latencyMs: number) => void): this;
  on(event: 'error',             cb: (err: Error) => void): this;
  on(event: 'connected',         cb: () => void): this;
  on(event: 'disconnected',      cb: (reason: string) => void): this;

  removeListener(event: string, listener: (...args: any[]) => void): this;
  emit(event: string, ...args: unknown[]): boolean;
  removeAllListeners(event?: string): this;
}

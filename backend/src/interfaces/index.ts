// ─────────────────────────────────────────────────────────────────────────────
// interfaces/index.ts — Tüm interfacelerin barrel export'u
// ─────────────────────────────────────────────────────────────────────────────

export {
  Exchange,
  type TradeSide,
  type LiquidationSide,
  type ExchangeOrderBookSnapshot,
  type ExchangeOrderBookDelta,
  type ExchangeRawTrade,
  type ExchangeRawLiquidation,
  type ExchangeRawOI,
  type IExchangeService,
} from './IExchangeService.js';

export {
  type PriceLevel,
  type IUnifiedOrderBook,
} from './IUnifiedOrderBook.js';

export {
  type IUnifiedTrade,
  type ITradeWithCVD,
} from './IUnifiedTrade.js';

export {
  type IUnifiedLiquidation,
} from './IUnifiedLiquidation.js';

export {
  type IUnifiedOpenInterest,
} from './IUnifiedOpenInterest.js';

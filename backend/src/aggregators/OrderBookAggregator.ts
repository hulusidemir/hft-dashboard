// ─────────────────────────────────────────────────────────────────────────────
// aggregators/OrderBookAggregator.ts
// 3 borsanın localBids/localAsks Map'lerini 50ms döngüyle birleştirir.
// ─────────────────────────────────────────────────────────────────────────────

import { EventEmitter } from 'node:events';
import type { IExchangeService } from '../interfaces/IExchangeService.js';
import type { PriceLevel, IUnifiedOrderBook } from '../interfaces/IUnifiedOrderBook.js';
import { getSymbolConfig } from '../config/symbols.js';
import { roundToTick, safeAdd, safeSub } from '../utils/priceUtils.js';
import { Logger } from '../utils/logger.js';

const AGGREGATE_INTERVAL_MS = 50;   // 20 fps
const MAX_LEVELS = 100;

/** Dahili çalışma yapısı — obje yaratımını minimize etmek için yeniden kullanılır */
interface MutableLevel {
  binanceQty: number;
  bybitQty: number;
  okxQty: number;
}

export class OrderBookAggregator extends EventEmitter {
  private readonly binance: IExchangeService;
  private readonly bybit: IExchangeService;
  private readonly okx: IExchangeService;
  private readonly log = new Logger('OrderBookAgg');

  private symbol: string = '';
  private tickSize: number = 0.5;
  private timer: ReturnType<typeof setInterval> | null = null;

  /** GC-dostu: her döngüde clear() edilerek tekrar kullanılan Map */
  private readonly bidMap: Map<number, MutableLevel> = new Map();
  private readonly askMap: Map<number, MutableLevel> = new Map();

  /** Reusable output dizileri — her döngüde length=0 yapılıp doldurulur */
  private bidArray: PriceLevel[] = [];
  private askArray: PriceLevel[] = [];

  constructor(binance: IExchangeService, bybit: IExchangeService, okx: IExchangeService) {
    super();
    this.setMaxListeners(30);
    this.binance = binance;
    this.bybit = bybit;
    this.okx = okx;
  }

  start(symbol: string): void {
    this.stop();
    this.symbol = symbol;
    this.tickSize = getSymbolConfig(symbol).tickSize;
    this.timer = setInterval(() => this.aggregate(), AGGREGATE_INTERVAL_MS);
    this.log.info('OrderBook aggregation başladı', { symbol, intervalMs: AGGREGATE_INTERVAL_MS });
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Tüm iç state'i sıfırla — sembol değişikliğinde memory leak önler */
  reset(): void {
    this.stop();
    this.bidMap.clear();
    this.askMap.clear();
    this.bidArray = [];
    this.askArray = [];
    this.symbol = '';
    this.tickSize = 0.5;
    this.log.info('OrderBook aggregator sıfırlandı');
  }

  // ─── Core Birleştirme ──────────────────────────────────────────────────

  private aggregate(): void {
    try {
      this.bidMap.clear();
      this.askMap.clear();

      // ── Bids birleştir ──────────────────────────────────────────────
      this.mergeBook(this.binance.localBids, this.bidMap, 'binance');
      this.mergeBook(this.bybit.localBids,   this.bidMap, 'bybit');
      this.mergeBook(this.okx.localBids,      this.bidMap, 'okx');

      // ── Asks birleştir ──────────────────────────────────────────────
      this.mergeBook(this.binance.localAsks, this.askMap, 'binance');
      this.mergeBook(this.bybit.localAsks,   this.askMap, 'bybit');
      this.mergeBook(this.okx.localAsks,      this.askMap, 'okx');

      // ── Map → sorted array ─────────────────────────────────────────
      this.bidArray = this.mapToLevels(this.bidMap);
      this.askArray = this.mapToLevels(this.askMap);

      // Bids desc, Asks asc
      this.bidArray.sort((a, b) => b.price - a.price);
      this.askArray.sort((a, b) => a.price - b.price);

      // İlk 100 kademe
      if (this.bidArray.length > MAX_LEVELS) this.bidArray.length = MAX_LEVELS;
      if (this.askArray.length > MAX_LEVELS) this.askArray.length = MAX_LEVELS;

      // ── Best prices ────────────────────────────────────────────────
      const bestBid = this.bidArray.length > 0 ? this.bidArray[0]!.price : 0;
      const bestAsk = this.askArray.length > 0 ? this.askArray[0]!.price : 0;

      if (bestBid === 0 || bestAsk === 0) return; // Henüz snapshot gelmemiş

      const midPrice = (bestBid + bestAsk) / 2;
      const spread = safeSub(bestAsk, bestBid);

      const result: IUnifiedOrderBook = {
        symbol: this.symbol,
        timestamp: Date.now(),
        midPrice,
        spread,
        bids: this.bidArray,
        asks: this.askArray,
        bestBids: {
          binance: this.bestPrice(this.binance.localBids, true),
          bybit:   this.bestPrice(this.bybit.localBids, true),
          okx:     this.bestPrice(this.okx.localBids, true),
        },
        bestAsks: {
          binance: this.bestPrice(this.binance.localAsks, false),
          bybit:   this.bestPrice(this.bybit.localAsks, false),
          okx:     this.bestPrice(this.okx.localAsks, false),
        },
      };

      this.emit('aggregated_orderbook', result);
    } catch (err) {
      this.log.error('Aggregation döngüsü hatası', err instanceof Error ? err : new Error(String(err)));
    }
  }

  /**
   * Tek bir borsanın yerel defterini birleştirme Map'ine ekler.
   * Her fiyat roundToTick ile ortak tick'e yuvarlanır.
   */
  private mergeBook(
    source: ReadonlyMap<number, number>,
    target: Map<number, MutableLevel>,
    exchange: 'binance' | 'bybit' | 'okx',
  ): void {
    for (const [rawPrice, qty] of source) {
      if (qty <= 0) continue;
      const price = roundToTick(rawPrice, this.tickSize);
      let level = target.get(price);
      if (!level) {
        level = { binanceQty: 0, bybitQty: 0, okxQty: 0 };
        target.set(price, level);
      }
      level[`${exchange}Qty` as keyof MutableLevel] += qty;
    }
  }

  /** Map<price, MutableLevel> → PriceLevel[] */
  private mapToLevels(map: Map<number, MutableLevel>): PriceLevel[] {
    const out: PriceLevel[] = new Array(map.size);
    let i = 0;
    for (const [price, lv] of map) {
      out[i++] = {
        price,
        quantity: safeAdd(safeAdd(lv.binanceQty, lv.bybitQty), lv.okxQty),
        binanceQty: lv.binanceQty,
        bybitQty: lv.bybitQty,
        okxQty: lv.okxQty,
      };
    }
    return out;
  }

  /** Bir Map'teki en iyi (bid=max, ask=min) fiyatı bulur */
  private bestPrice(book: ReadonlyMap<number, number>, isBid: boolean): number {
    let best = isBid ? 0 : Infinity;
    for (const price of book.keys()) {
      if (isBid ? price > best : price < best) best = price;
    }
    return best === Infinity ? 0 : best;
  }
}

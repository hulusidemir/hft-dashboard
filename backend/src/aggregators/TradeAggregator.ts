// ─────────────────────────────────────────────────────────────────────────────
// aggregators/TradeAggregator.ts
// 3 borsadan gelen trade'leri sıralar, IUnifiedTrade'e çevirir, CVD hesaplar.
// 20ms döngüyle buffer'ı flush edip emit eder.
// ─────────────────────────────────────────────────────────────────────────────

import { EventEmitter } from 'node:events';
import type { IExchangeService, ExchangeRawTrade } from '../interfaces/IExchangeService.js';
import type { IUnifiedTrade, ITradeWithCVD } from '../interfaces/IUnifiedTrade.js';
import { Logger } from '../utils/logger.js';
import { safeMul, safeAdd, safeSub } from '../utils/priceUtils.js';

const FLUSH_INTERVAL_MS = 20;

export class TradeAggregator extends EventEmitter {
  private readonly services: IExchangeService[];
  private readonly log = new Logger('TradeAgg');

  private tradeBuffer: IUnifiedTrade[] = [];
  private cvd: number = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private symbol: string = '';

  /** Listener referansları — disconnect'te kaldırmak için */
  private readonly boundHandlers: Array<{ service: IExchangeService; handler: (trades: ExchangeRawTrade[]) => void }> = [];

  constructor(binance: IExchangeService, bybit: IExchangeService, okx: IExchangeService) {
    super();
    this.setMaxListeners(30);
    this.services = [binance, bybit, okx];
  }

  start(symbol: string): void {
    this.stop();
    this.symbol = symbol;
    this.cvd = 0;
    this.tradeBuffer.length = 0;

    // Her servise trade listener ekle
    for (const svc of this.services) {
      const handler = (rawTrades: ExchangeRawTrade[]) => this.onTrades(rawTrades);
      svc.on('trade', handler);
      this.boundHandlers.push({ service: svc, handler });
    }

    this.timer = setInterval(() => this.flush(), FLUSH_INTERVAL_MS);
    this.log.info('Trade aggregation başladı', { symbol, flushMs: FLUSH_INTERVAL_MS });
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    // Listener'ları kaldır
    for (const { service, handler } of this.boundHandlers) {
      service.removeListener('trade', handler);
    }
    this.boundHandlers.length = 0;
  }

  /** Anlık CVD değerini döndürür */
  getCvd(): number {
    return this.cvd;
  }

  /** CVD'yi sıfırla (kullanıcı isteğiyle) */
  resetCvd(): void {
    this.cvd = 0;
  }

  /** Tüm iç state'i sıfırla — sembol değişikliğinde eski veriler temizlenir */
  reset(): void {
    this.stop();
    this.tradeBuffer = [];
    this.cvd = 0;
    this.symbol = '';
    this.log.info('Trade aggregator sıfırlandı');
  }

  // ─── Dahili ────────────────────────────────────────────────────────────

  private onTrades(rawTrades: ExchangeRawTrade[]): void {
    try {
      for (const raw of rawTrades) {
        const quoteQty = safeMul(raw.price, raw.quantity);
        const unified: IUnifiedTrade = {
          id: raw.id,
          symbol: this.symbol,
          exchange: raw.exchange,
          price: raw.price,
          quantity: raw.quantity,
          quoteQty,
          side: raw.side,
          timestamp: raw.timestamp,
        };

        this.tradeBuffer.push(unified);

        // CVD güncelle — BUY pozitif, SELL negatif
        this.cvd = raw.side === 'BUY'
          ? safeAdd(this.cvd, quoteQty)
          : safeSub(this.cvd, quoteQty);
      }
    } catch (err) {
      this.log.error('onTrades hatası', err instanceof Error ? err : new Error(String(err)));
    }
  }

  private flush(): void {
    if (this.tradeBuffer.length === 0) return;

    try {
      // Buffer'ın kopyasını al, orijinali sıfırla
      const batch = this.tradeBuffer;
      this.tradeBuffer = [];

      // Timestamp'e göre eskiden yeniye sıra
      batch.sort((a, b) => a.timestamp - b.timestamp);

      const packet: ITradeWithCVD = {
        trades: batch,
        cvd: this.cvd,
        timestamp: Date.now(),
      };

      this.emit('aggregated_trades', packet);
    } catch (err) {
      this.log.error('flush hatası', err instanceof Error ? err : new Error(String(err)));
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// aggregators/OpenInterestAggregator.ts
// 3 borsanın OI verilerini cache'ler, toplar, delta hesaplar.
// Sadece yeni veri geldiğinde emit eder — gereksiz trafik yok.
// ─────────────────────────────────────────────────────────────────────────────

import { EventEmitter } from 'node:events';
import type { IExchangeService, ExchangeRawOI } from '../interfaces/IExchangeService.js';
import { Exchange } from '../interfaces/IExchangeService.js';
import type { IUnifiedOpenInterest } from '../interfaces/IUnifiedOpenInterest.js';
import { safeSub } from '../utils/priceUtils.js';
import { Logger } from '../utils/logger.js';

export class OpenInterestAggregator extends EventEmitter {
  private readonly services: IExchangeService[];
  private readonly log = new Logger('OIAgg');

  private symbol: string = '';

  // Son cache'lenen OI değerleri (USD)
  private lastBinanceOI: number = 0;
  private lastBybitOI: number = 0;
  private lastOkxOI: number = 0;
  private previousTotalOI: number = 0;

  private readonly boundHandlers: Array<{ service: IExchangeService; handler: (oi: ExchangeRawOI) => void }> = [];

  constructor(binance: IExchangeService, bybit: IExchangeService, okx: IExchangeService) {
    super();
    this.setMaxListeners(30);
    this.services = [binance, bybit, okx];
  }

  start(symbol: string): void {
    this.stop();
    this.symbol = symbol;
    this.lastBinanceOI = 0;
    this.lastBybitOI = 0;
    this.lastOkxOI = 0;
    this.previousTotalOI = 0;

    for (const svc of this.services) {
      const handler = (raw: ExchangeRawOI) => this.onOI(raw);
      svc.on('open_interest', handler);
      this.boundHandlers.push({ service: svc, handler });
    }

    this.log.info('OI aggregation başladı', { symbol });
  }

  stop(): void {
    for (const { service, handler } of this.boundHandlers) {
      service.removeListener('open_interest', handler);
    }
    this.boundHandlers.length = 0;
  }

  /** Tüm iç state'i sıfırla — sembol değişikliğinde eski OI cache temizlenir */
  reset(): void {
    this.stop();
    this.symbol = '';
    this.lastBinanceOI = 0;
    this.lastBybitOI = 0;
    this.lastOkxOI = 0;
    this.previousTotalOI = 0;
    this.log.info('OI aggregator sıfırlandı');
  }

  // ─── Dahili ────────────────────────────────────────────────────────────

  private onOI(raw: ExchangeRawOI): void {
    try {
      // İlgili borsanın cache'ini güncelle
      switch (raw.exchange) {
        case Exchange.BINANCE: this.lastBinanceOI = raw.openInterestUsd; break;
        case Exchange.BYBIT:   this.lastBybitOI   = raw.openInterestUsd; break;
        case Exchange.OKX:     this.lastOkxOI     = raw.openInterestUsd; break;
      }

      const totalOI = this.lastBinanceOI + this.lastBybitOI + this.lastOkxOI;
      const deltaOI = safeSub(totalOI, this.previousTotalOI);
      const deltaOIPercent = this.previousTotalOI > 0
        ? (deltaOI / this.previousTotalOI) * 100
        : 0;

      this.previousTotalOI = totalOI;

      const unified: IUnifiedOpenInterest = {
        symbol: this.symbol,
        timestamp: raw.timestamp,
        binanceOI: this.lastBinanceOI,
        bybitOI: this.lastBybitOI,
        okxOI: this.lastOkxOI,
        totalOI,
        deltaOI,
        deltaOIPercent: Math.round(deltaOIPercent * 100) / 100,
      };

      this.emit('aggregated_oi', unified);
    } catch (err) {
      this.log.error('onOI hatası', err instanceof Error ? err : new Error(String(err)));
    }
  }
}

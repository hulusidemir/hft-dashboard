// ─────────────────────────────────────────────────────────────────────────────
// aggregators/LiquidationAggregator.ts
// 3 borsanın tasfiye event'lerini anlık olarak normalize edip yayınlar.
// Buffer yok — event bazlı, sıfır gecikme.
// ─────────────────────────────────────────────────────────────────────────────

import { EventEmitter } from 'node:events';
import type { IExchangeService, ExchangeRawLiquidation } from '../interfaces/IExchangeService.js';
import type { IUnifiedLiquidation } from '../interfaces/IUnifiedLiquidation.js';
import { safeMul } from '../utils/priceUtils.js';
import { Logger } from '../utils/logger.js';

export class LiquidationAggregator extends EventEmitter {
  private readonly services: IExchangeService[];
  private readonly log = new Logger('LiqAgg');

  /** Aktif izlenen sembol — Sıfır Güven filtresi için kullanılır */
  private activeSymbol: string = '';
  private symbol: string = '';
  private readonly boundHandlers: Array<{ service: IExchangeService; handler: (liq: ExchangeRawLiquidation) => void }> = [];

  constructor(binance: IExchangeService, bybit: IExchangeService, okx: IExchangeService) {
    super();
    this.setMaxListeners(30);
    this.services = [binance, bybit, okx];
  }

  start(symbol: string): void {
    this.stop();
    this.symbol = symbol;
    this.activeSymbol = symbol;

    for (const svc of this.services) {
      const handler = (raw: ExchangeRawLiquidation) => this.onLiquidation(raw);
      svc.on('liquidation', handler);
      this.boundHandlers.push({ service: svc, handler });
    }

    this.log.info('Liquidation aggregation başladı', { symbol });
  }

  stop(): void {
    for (const { service, handler } of this.boundHandlers) {
      service.removeListener('liquidation', handler);
    }
    this.boundHandlers.length = 0;
  }

  /** Tüm iç state'i sıfırla — sembol değişikliğinde */
  reset(): void {
    this.stop();
    this.symbol = '';
    this.activeSymbol = '';
    this.log.info('Liquidation aggregator sıfırlandı');
  }

  // ─── Dahili ────────────────────────────────────────────────────────────

  private onLiquidation(raw: ExchangeRawLiquidation): void {
    // ── Sıfır Güven Filtresi — aktif sembolle eşleşmeyen veriyi anında çöpe at ──
    if (!this.activeSymbol || raw.symbol !== this.activeSymbol) {
      this.log.debug('Liquidation reddedildi (sembol uyumsuz)', {
        expected: this.activeSymbol,
        received: raw.symbol,
        exchange: raw.exchange,
      });
      return;
    }

    try {
      const quoteQty = safeMul(raw.price, raw.quantity);

      const unified: IUnifiedLiquidation = {
        id: `${raw.exchange}_liq_${raw.timestamp}_${raw.price}`,
        symbol: this.symbol,
        exchange: raw.exchange,
        side: raw.side,
        price: raw.price,
        quantity: raw.quantity,
        quoteQty,
        timestamp: raw.timestamp,
      };

      this.emit('aggregated_liquidation', unified);
    } catch (err) {
      this.log.error('onLiquidation hatası', err instanceof Error ? err : new Error(String(err)));
    }
  }
}

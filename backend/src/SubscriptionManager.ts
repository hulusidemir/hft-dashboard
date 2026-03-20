// ─────────────────────────────────────────────────────────────────────────────
// SubscriptionManager.ts — Per-Client Sembol Abonelik Yöneticisi
// Her sembol için bağımsız exchange service + aggregator stack'i yönetir.
// Referans sayımı ile kullanılmayan stack'ler grace period sonrası kapatılır.
// ─────────────────────────────────────────────────────────────────────────────

import { BinanceService } from './services/BinanceService.js';
import { BybitService } from './services/BybitService.js';
import { OkxService } from './services/OkxService.js';
import { OrderBookAggregator } from './aggregators/OrderBookAggregator.js';
import { TradeAggregator } from './aggregators/TradeAggregator.js';
import { LiquidationAggregator } from './aggregators/LiquidationAggregator.js';
import { OpenInterestAggregator } from './aggregators/OpenInterestAggregator.js';
import { fetchAndRegisterSymbol } from './config/symbols.js';
import { Logger } from './utils/logger.js';

/** Kullanılmayan stack'in yıkılmadan önce bekleme süresi (ms) */
const TEARDOWN_GRACE_MS = 30_000;

/** Bir sembol için tam çalışan servis + aggregator seti */
export interface SymbolStack {
  symbol: string;
  binance: BinanceService;
  bybit: BybitService;
  okx: OkxService;
  obAgg: OrderBookAggregator;
  trAgg: TradeAggregator;
  liqAgg: LiquidationAggregator;
  oiAgg: OpenInterestAggregator;
  subscribers: Set<number>;
  teardownTimer: ReturnType<typeof setTimeout> | null;
}

/** Yeni stack oluşturulduğunda aggregator event'lerini pub/sub'a bağlayan callback */
export type WireStackFn = (stack: SymbolStack) => void;

export class SubscriptionManager {
  private readonly stacks = new Map<string, SymbolStack>();
  private readonly log = new Logger('SubMgr');
  private wireStackFn: WireStackFn | null = null;
  private readonly initializing = new Map<string, Promise<SymbolStack>>();

  /** server.ts tarafından çağrılır — aggregator event'lerini pub/sub'a bağlar */
  setWireCallback(fn: WireStackFn): void {
    this.wireStackFn = fn;
  }

  /**
   * Bir client'ı belirtilen sembolün veri akışına abone eder.
   * Stack yoksa oluşturulur, varsa teardown iptal edilip subscriber eklenir.
   */
  async subscribe(clientId: number, symbol: string): Promise<SymbolStack> {
    const existing = this.stacks.get(symbol);
    if (existing) {
      if (existing.teardownTimer) {
        clearTimeout(existing.teardownTimer);
        existing.teardownTimer = null;
        this.log.info(`Teardown iptal edildi: ${symbol}`);
      }
      existing.subscribers.add(clientId);
      this.log.info(`Client #${clientId} → ${symbol}`, { subscribers: existing.subscribers.size });
      return existing;
    }

    // Aynı sembol için başka bir initialize devam ediyorsa bekle
    const pending = this.initializing.get(symbol);
    if (pending) {
      const stack = await pending;
      stack.subscribers.add(clientId);
      this.log.info(`Client #${clientId} → ${symbol} (bekledi)`, { subscribers: stack.subscribers.size });
      return stack;
    }

    // Yeni stack oluştur
    const promise = this.createStack(symbol);
    this.initializing.set(symbol, promise);
    try {
      const stack = await promise;
      stack.subscribers.add(clientId);
      this.stacks.set(symbol, stack);
      this.log.info(`Client #${clientId} → ${symbol} (yeni stack)`, { subscribers: 1 });
      return stack;
    } finally {
      this.initializing.delete(symbol);
    }
  }

  /** Bir client'ın sembol aboneliğini kaldırır. Son subscriber çıkınca teardown zamanlanır. */
  unsubscribe(clientId: number, symbol: string): void {
    const stack = this.stacks.get(symbol);
    if (!stack) return;

    stack.subscribers.delete(clientId);
    this.log.info(`Client #${clientId} ✗ ${symbol}`, { remaining: stack.subscribers.size });

    if (stack.subscribers.size === 0) {
      stack.teardownTimer = setTimeout(() => this.teardownStack(symbol), TEARDOWN_GRACE_MS);
      this.log.info(`Teardown zamanlandı: ${symbol} (${TEARDOWN_GRACE_MS}ms)`);
    }
  }

  /** Varsayılan sembol stack'ini önceden oluşturur (subscriber olmadan) */
  async preloadSymbol(symbol: string): Promise<void> {
    if (this.stacks.has(symbol)) return;
    const promise = this.createStack(symbol);
    this.initializing.set(symbol, promise);
    try {
      const stack = await promise;
      this.stacks.set(symbol, stack);
    } finally {
      this.initializing.delete(symbol);
    }
  }

  hasStack(symbol: string): boolean {
    return this.stacks.has(symbol);
  }

  getStack(symbol: string): SymbolStack | undefined {
    return this.stacks.get(symbol);
  }

  getActiveSymbols(): string[] {
    return [...this.stacks.keys()];
  }

  /** Tüm stack'leri yıkır — graceful shutdown için */
  shutdown(): void {
    for (const symbol of [...this.stacks.keys()]) {
      this.teardownStack(symbol);
    }
  }

  // ─── Dahili ────────────────────────────────────────────────────────────

  private async createStack(symbol: string): Promise<SymbolStack> {
    this.log.info(`Stack oluşturuluyor: ${symbol}`);

    await fetchAndRegisterSymbol(symbol);

    const binance = new BinanceService();
    const bybit = new BybitService();
    const okx = new OkxService();

    const obAgg = new OrderBookAggregator(binance, bybit, okx);
    const trAgg = new TradeAggregator(binance, bybit, okx);
    const liqAgg = new LiquidationAggregator(binance, bybit, okx);
    const oiAgg = new OpenInterestAggregator(binance, bybit, okx);

    const stack: SymbolStack = {
      symbol, binance, bybit, okx, obAgg, trAgg, liqAgg, oiAgg,
      subscribers: new Set(),
      teardownTimer: null,
    };

    // Aggregator event'lerini pub/sub'a bağla — veri akmadan ÖNCE
    if (this.wireStackFn) {
      this.wireStackFn(stack);
    }

    // Borsalara bağlan
    const labels = ['Binance', 'Bybit', 'OKX'] as const;
    const results = await Promise.allSettled([
      binance.connect(symbol),
      bybit.connect(symbol),
      okx.connect(symbol),
    ]);
    for (let i = 0; i < results.length; i++) {
      const r = results[i]!;
      if (r.status === 'rejected') {
        this.log.warn(`${labels[i]} bağlantı başarısız (${symbol})`, {
          error: r.reason instanceof Error ? r.reason.message : String(r.reason),
        });
      }
    }

    // Aggregator'ları başlat
    obAgg.start(symbol);
    trAgg.start(symbol);
    liqAgg.start(symbol);
    oiAgg.start(symbol);

    this.log.info(`Stack hazır: ${symbol}`);
    return stack;
  }

  private teardownStack(symbol: string): void {
    const stack = this.stacks.get(symbol);
    if (!stack) return;

    if (stack.teardownTimer) {
      clearTimeout(stack.teardownTimer);
      stack.teardownTimer = null;
    }

    this.log.info(`Stack teardown: ${symbol}`);

    stack.obAgg.reset();
    stack.trAgg.reset();
    stack.liqAgg.reset();
    stack.oiAgg.reset();

    stack.binance.disconnect();
    stack.bybit.disconnect();
    stack.okx.disconnect();

    stack.obAgg.removeAllListeners();
    stack.trAgg.removeAllListeners();
    stack.liqAgg.removeAllListeners();
    stack.oiAgg.removeAllListeners();

    this.stacks.delete(symbol);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// index.ts — Scalping Dashboard Backend — Full Entry Point
// 3 Exchange Service + 4 Aggregator + uWebSockets.js Server + Graceful Shutdown
// Dinamik sembol değişikliği: WS mesajı → disconnect → reset → reconnect
// ─────────────────────────────────────────────────────────────────────────────

import { Logger } from './utils/logger.js';
import {
  DEFAULT_SYMBOL,
  fetchBybitLinearSymbols,
  fetchAndRegisterSymbol,
} from './config/symbols.js';
import { BinanceService } from './services/BinanceService.js';
import { BybitService } from './services/BybitService.js';
import { OkxService } from './services/OkxService.js';
import { OrderBookAggregator } from './aggregators/OrderBookAggregator.js';
import { TradeAggregator } from './aggregators/TradeAggregator.js';
import { LiquidationAggregator } from './aggregators/LiquidationAggregator.js';
import { OpenInterestAggregator } from './aggregators/OpenInterestAggregator.js';
import { startServer } from './server.js';
import { RadarService } from './services/RadarService.js';

// ── Config ───────────────────────────────────────────────────────────────────
const WS_PORT = Number(process.env['WS_PORT']) || 9000;

const log = new Logger('Main');

// ── Global State ─────────────────────────────────────────────────────────────
let currentSymbol: string = DEFAULT_SYMBOL;
let bybitSymbolList: string[] = [];

// ── Bootstrap ────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  log.info('Scalping Dashboard Backend başlatılıyor...', {
    defaultSymbol: DEFAULT_SYMBOL,
    port: WS_PORT,
    pid: process.pid,
    nodeVersion: process.version,
  });

  // ── 0. Bybit Sembol Listesini Çek ────────────────────────────────────────
  try {
    bybitSymbolList = await fetchBybitLinearSymbols();
    log.info(`Bybit sembol listesi hazır: ${bybitSymbolList.length} sembol`);
  } catch (err) {
    log.error('Bybit sembol listesi çekilemedi, boş liste ile devam ediliyor', err instanceof Error ? err : new Error(String(err)));
    bybitSymbolList = [];
  }

  // ── 0b. Varsayılan sembolü kaydet (tickSize/stepSize fetch) ───────────────
  await fetchAndRegisterSymbol(DEFAULT_SYMBOL);

  // ── 1. Exchange Services ──────────────────────────────────────────────────
  const binance = new BinanceService();
  const bybit   = new BybitService();
  const okx     = new OkxService();

  // ── 2. Aggregators (DI) ───────────────────────────────────────────────────
  const obAgg  = new OrderBookAggregator(binance, bybit, okx);
  const trAgg  = new TradeAggregator(binance, bybit, okx);
  const liqAgg = new LiquidationAggregator(binance, bybit, okx);
  const oiAgg  = new OpenInterestAggregator(binance, bybit, okx);

  // ── 2b. Radar Service (Global Screener) ─────────────────────────────
  const radar = new RadarService();
  radar.start();

  log.info('Tüm modüller instantiate edildi', {
    services: [binance.exchange, bybit.exchange, okx.exchange],
    aggregators: ['OrderBook', 'Trade', 'Liquidation', 'OpenInterest'],
  });

  // ── switchSymbol — Sembol Değişikliği Orkestratörü ────────────────────────
  async function switchSymbol(newSymbol: string): Promise<void> {
    log.info(`━━━ Sembol değişikliği: ${currentSymbol} → ${newSymbol} ━━━`);
    const t0 = Date.now();

    // 1) Aggregator'ları durdur ve sıfırla
    log.info('[1/5] Aggregator\'lar durduruluyor ve sıfırlanıyor...');
    obAgg.reset();
    trAgg.reset();
    liqAgg.reset();
    oiAgg.reset();

    // 2) Borsa bağlantılarını kes
    log.info('[2/5] Borsa bağlantıları kesiliyor...');
    binance.disconnect();
    bybit.disconnect();
    okx.disconnect();

    // 3) Yeni sembolün config'ini fetch et (tickSize/stepSize/contractSize)
    log.info(`[3/5] Sembol config çekiliyor: ${newSymbol}`);
    await fetchAndRegisterSymbol(newSymbol);

    // 4) 3 Borsaya yeni sembolle bağlan
    log.info(`[4/5] Borsalara yeniden bağlanılıyor: ${newSymbol}`);
    const connectResults = await Promise.allSettled([
      binance.connect(newSymbol),
      bybit.connect(newSymbol),
      okx.connect(newSymbol),
    ]);

    // Hangi borsalar bağlandı, hangileri başarısız?
    const labels = ['Binance', 'Bybit', 'OKX'] as const;
    for (let i = 0; i < connectResults.length; i++) {
      const r = connectResults[i]!;
      if (r.status === 'rejected') {
        log.warn(`${labels[i]} bağlantı başarısız (${newSymbol}) — devam ediliyor`, {
          error: r.reason instanceof Error ? r.reason.message : String(r.reason),
        });
      }
    }

    // 5) Aggregator'ları yeni sembolle başlat
    log.info(`[5/5] Aggregator'lar başlatılıyor: ${newSymbol}`);
    obAgg.start(newSymbol);
    trAgg.start(newSymbol);
    liqAgg.start(newSymbol);
    oiAgg.start(newSymbol);

    currentSymbol = newSymbol;
    const elapsed = Date.now() - t0;
    log.info(`━━━ Sembol değişikliği tamamlandı: ${newSymbol} (${elapsed}ms) ━━━`);
  }

  // ── 3. uWebSockets.js Server ─────────────────────────────────────────────
  const serverHandle = await startServer({
    aggregators: {
      orderBook:    obAgg,
      trade:        trAgg,
      liquidation:  liqAgg,
      openInterest: oiAgg,
    },
    services: { radar },
    port: WS_PORT,
    onSymbolChange: switchSymbol,
    getSymbolList: () => bybitSymbolList,
    getCurrentSymbol: () => currentSymbol,
  });

  // ── 4. Connect to Exchanges (parallel) ───────────────────────────────────
  log.info(`Borsalara bağlanılıyor... symbol=${DEFAULT_SYMBOL}`);

  await Promise.allSettled([
    binance.connect(DEFAULT_SYMBOL),
    bybit.connect(DEFAULT_SYMBOL),
    okx.connect(DEFAULT_SYMBOL),
  ]);

  log.info('Borsa bağlantı denemeleri tamamlandı');

  // ── 5. Start Aggregators ──────────────────────────────────────────────────
  obAgg.start(DEFAULT_SYMBOL);
  trAgg.start(DEFAULT_SYMBOL);
  liqAgg.start(DEFAULT_SYMBOL);
  oiAgg.start(DEFAULT_SYMBOL);

  log.info('Aggregator\'lar aktif', { symbol: DEFAULT_SYMBOL });

  // ── 6. Graceful Shutdown ──────────────────────────────────────────────────
  let isShuttingDown = false;

  async function shutdown(signal: string): Promise<void> {
    if (isShuttingDown) return;
    isShuttingDown = true;

    log.info(`${signal} alındı — graceful shutdown başlatılıyor...`);

    // 6a. Aggregator'ları durdur
    obAgg.reset();
    trAgg.reset();
    liqAgg.reset();
    oiAgg.reset();
    radar.stop();
    log.info('Aggregator\'lar ve Radar durduruldu ve sıfırlandı');

    // 6b. uWS sunucusunu kapat
    serverHandle.close();

    // 6c. Borsa bağlantılarını kes
    binance.disconnect();
    bybit.disconnect();
    okx.disconnect();
    log.info('Borsa bağlantıları kesildi');

    log.info('Graceful shutdown tamamlandı. Çıkılıyor...');
    process.exit(0);
  }

  process.on('SIGINT',  () => { void shutdown('SIGINT'); });
  process.on('SIGTERM', () => { void shutdown('SIGTERM'); });

  process.on('unhandledRejection', (reason) => {
    log.error('Unhandled rejection', { reason: String(reason) });
  });

  process.on('uncaughtException', (err) => {
    log.fatal('Uncaught exception — shutting down', { error: err.message, stack: err.stack });
    void shutdown('uncaughtException');
  });

  log.info('━━━ Scalping Dashboard Backend tam operasyonel ━━━', {
    symbol: currentSymbol,
    port: WS_PORT,
    exchanges: 3,
    aggregators: 4,
    availableSymbols: bybitSymbolList.length,
  });
}

// ── Run ──────────────────────────────────────────────────────────────────────
main().catch((err: Error) => {
  log.fatal('Bootstrap hatası — çıkılıyor', { error: err.message, stack: err.stack });
  process.exit(1);
});

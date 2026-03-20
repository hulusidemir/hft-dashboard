// ─────────────────────────────────────────────────────────────────────────────
// index.ts — Scalping Dashboard Backend — Full Entry Point
// SubscriptionManager ile per-client sembol aboneliği + uWebSockets.js Server
// Her client kendi sembolünü bağımsız olarak değiştirir, diğer client'lar etkilenmez.
// ─────────────────────────────────────────────────────────────────────────────

import { Logger } from './utils/logger.js';
import {
  DEFAULT_SYMBOL,
  fetchBybitLinearSymbols,
} from './config/symbols.js';
import { startServer } from './server.js';
import { SubscriptionManager } from './SubscriptionManager.js';
import { RadarService } from './services/RadarService.js';
import { initLiquidationDB, closeLiquidationDB } from './db/LiquidationDB.js';
import { startLiquidationListener, stopLiquidationListener, liqEvents } from './services/LiquidationListener.js';
import { startGlobalTradeListener, stopGlobalTradeListener, globalTradeEvents } from './services/GlobalTradeListener.js';
import type { LiquidationRecord } from './db/LiquidationDB.js';
import { Exchange } from './interfaces/IExchangeService.js';
import type { IUnifiedLiquidation } from './interfaces/IUnifiedLiquidation.js';

// ── Config ───────────────────────────────────────────────────────────────────
const WS_PORT = Number(process.env['WS_PORT']) || 9000;

const log = new Logger('Main');

// ── Global State ─────────────────────────────────────────────────────────────
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
  // fetchAndRegisterSymbol, SubscriptionManager.preloadSymbol içinde çağrılır

  // ── 0c. SQLite Tasfiye Veritabanı + Otonom Dinleyici ───────────────────
  initLiquidationDB();
  startLiquidationListener();

  // ── 1. SubscriptionManager + Radar Service ─────────────────────────
  const subMgr = new SubscriptionManager();

  // ── 1b. Radar Service (Global Screener) ───────────────────────────
  const radar = new RadarService();
  radar.start();

  log.info('Tüm modüller instantiate edildi', {
    services: ['Binance', 'Bybit', 'OKX'],
    aggregators: ['OrderBook', 'Trade', 'Liquidation', 'OpenInterest'],
    mode: 'per-client subscriptions',
  });

  // ── 2. uWebSockets.js Server ───────────────────────────────────────────────
  const serverHandle = await startServer({
    subscriptionManager: subMgr,
    services: { radar },
    port: WS_PORT,
    getSymbolList: () => bybitSymbolList,
    defaultSymbol: DEFAULT_SYMBOL,
  });

  // ── 3. Varsayılan sembol stack'ini önceden oluştur ────────────────────────
  log.info(`Varsayılan sembol stack'i oluşturuluyor: ${DEFAULT_SYMBOL}`);
  await subMgr.preloadSymbol(DEFAULT_SYMBOL);
  log.info('Varsayılan sembol stack\'i hazır');

  // ── 4b. Global War Log Event Wiring ───────────────────────────────────────────────
  // LiquidationListener (global tasfiye) + GlobalTradeListener (global whale) → war_log
  liqEvents.on('war_liq', (entry) => serverHandle.publishWarLog(entry));
  globalTradeEvents.on('war_whale', (entry) => serverHandle.publishWarLog(entry));

  // ── 4b2. LiquidationListener → Liquidation Feed ──────────────────────────────────
  // Global stream'lerden gelen tasfiyeler — aktif stack'i olan sembollere iletilir
  const EXCHANGE_MAP: Record<string, Exchange> = { binance: Exchange.BINANCE, bybit: Exchange.BYBIT, okx: Exchange.OKX };
  liqEvents.on('liq_all', (rec: LiquidationRecord) => {
    // Sadece aktif stack'i olan sembollerin tasfiyelerini ilet
    if (!subMgr.hasStack(rec.symbol)) return;

    const exEnum = EXCHANGE_MAP[rec.exchange] ?? Exchange.BINANCE;
    const unified: IUnifiedLiquidation = {
      id: `${rec.exchange}_liq_${rec.timestamp}_${rec.price}`,
      symbol: rec.symbol,
      exchange: exEnum,
      side: rec.side === 'long' ? 'LONG' : 'SHORT',
      price: rec.price,
      quantity: rec.qty,
      quoteQty: rec.usdValue,
      timestamp: rec.timestamp,
    };
    serverHandle.publishLiquidationToSymbol(unified, rec.symbol);
  });

  // ── 4c. Global Trade Listener — Top 50 coin whale trade dedektörü ──────────
  startGlobalTradeListener(bybitSymbolList);

  // ── 5. Aggregator'lar SubscriptionManager tarafından yönetiliyor ──────────
  log.info('Aggregator\'lar per-client subscription ile aktif', { defaultSymbol: DEFAULT_SYMBOL });

  // ── 6. Graceful Shutdown ──────────────────────────────────────────────────
  let isShuttingDown = false;

  async function shutdown(signal: string): Promise<void> {
    if (isShuttingDown) return;
    isShuttingDown = true;

    log.info(`${signal} alındı — graceful shutdown başlatılıyor...`);

    // 6a. SubscriptionManager — tüm stack'leri yık
    subMgr.shutdown();
    radar.stop();
    stopLiquidationListener();
    stopGlobalTradeListener();
    log.info('SubscriptionManager, Radar, Liq Listener ve Global Trade Listener durduruldu');

    // 6b. uWS sunucusunu kapat
    serverHandle.close();

    // 6c. SubscriptionManager zaten exchange bağlantılarını kapattı
    log.info('Borsa bağlantıları kesildi (SubscriptionManager tarafından)');

    closeLiquidationDB();
    log.info('LiquidationDB kapatıldı');

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
    defaultSymbol: DEFAULT_SYMBOL,
    port: WS_PORT,
    mode: 'per-client subscriptions',
    availableSymbols: bybitSymbolList.length,
  });
}

// ── Run ──────────────────────────────────────────────────────────────────────
main().catch((err: Error) => {
  log.fatal('Bootstrap hatası — çıkılıyor', { error: err.message, stack: err.stack });
  process.exit(1);
});

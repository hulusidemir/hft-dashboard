// ─────────────────────────────────────────────────────────────────────────────
// services/GlobalTradeListener.ts — Global Balina İşlem Dedektörü
// ─────────────────────────────────────────────────────────────────────────────
//
// Binance Futures combined stream ile top N sembolün aggTrade kanalını dinler.
// $100K+ işlemleri "whale trade" olarak tespit eder ve war_whale event'i emit eder.
//
// RadarPanel'in War Log tablosunu besler — currentSymbol'den BAĞIMSIZ.
// ─────────────────────────────────────────────────────────────────────────────

import WebSocket from 'ws';
import { EventEmitter } from 'node:events';
import { Logger } from '../utils/logger.js';

const log = new Logger('GlobTrade');

// ── Config ───────────────────────────────────────────────────────────────────

/** $100K+ = whale trade */
const WHALE_THRESHOLD_USD = 100_000;
const RECONNECT_DELAY_MS  = 5_000;
const PING_INTERVAL_MS    = 20_000;
/** Maximum sembol — Binance combined stream URL uzunluğu limiti */
const MAX_SYMBOLS         = 50;

// ── Global Event Emitter ─────────────────────────────────────────────────────
//
// Event: 'war_whale' — { type, symbol, price, quoteQty, exchange, timestamp }
//
export const globalTradeEvents = new EventEmitter();
globalTradeEvents.setMaxListeners(20);

// ── State ────────────────────────────────────────────────────────────────────

let ws: WebSocket | null = null;
let pingTimer: ReturnType<typeof setInterval> | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let running = false;
let activeSymbols: string[] = [];

// ── Helpers ──────────────────────────────────────────────────────────────────

function cleanup(): void {
  if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  if (ws) {
    ws.removeAllListeners();
    try { ws.close(); } catch { /* ignore */ }
    ws = null;
  }
}

function connect(): void {
  cleanup();
  if (!running || activeSymbols.length === 0) return;

  // Binance combined stream: wss://fstream.binance.com/ws/<stream1>/<stream2>/...
  const streams = activeSymbols.map(s => `${s.toLowerCase()}@aggTrade`);
  const url = `wss://fstream.binance.com/ws/${streams.join('/')}`;

  log.info(`Global trade listener bağlanıyor — ${activeSymbols.length} sembol`);

  const newWs = new WebSocket(url);
  ws = newWs;

  newWs.on('open', () => {
    log.info(`Global trade listener bağlandı — ${activeSymbols.length} sembol izleniyor`);
    pingTimer = setInterval(() => {
      if (newWs.readyState === WebSocket.OPEN) newWs.ping();
    }, PING_INTERVAL_MS);
  });

  newWs.on('message', (raw: WebSocket.RawData) => {
    try {
      const msg = JSON.parse(raw.toString()) as Record<string, unknown>;
      if (msg['e'] !== 'aggTrade') return;

      const price    = parseFloat(msg['p'] as string);
      const qty      = parseFloat(msg['q'] as string);
      const quoteQty = price * qty;

      if (quoteQty < WHALE_THRESHOLD_USD) return;

      // m=true → buyer is market maker → taker is SELLER
      const side = (msg['m'] as boolean) ? 'SELL' : 'BUY';
      const symbol = (msg['s'] as string).toUpperCase();

      globalTradeEvents.emit('war_whale', {
        type: side === 'BUY' ? 'WHALE_BUY' : 'WHALE_SELL',
        symbol,
        price,
        quoteQty,
        exchange: 'BINANCE',
        timestamp: (msg['T'] as number) || Date.now(),
      });
    } catch {
      // parse error — yoksay
    }
  });

  newWs.on('close', () => {
    log.warn('Bağlantı kapandı, yeniden bağlanılacak...');
    cleanup();
    if (running) {
      reconnectTimer = setTimeout(connect, RECONNECT_DELAY_MS);
    }
  });

  newWs.on('error', (err: Error) => {
    log.warn('WS hatası', err);
    cleanup();
    if (running) {
      reconnectTimer = setTimeout(connect, RECONNECT_DELAY_MS);
    }
  });
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Top N sembolün aggTrade kanallarını dinlemeye başlar.
 * @param symbols — Hacim sıralı sembol listesi (BTCUSDT, ETHUSDT, ...)
 */
export function startGlobalTradeListener(symbols: string[]): void {
  if (running) return;
  running = true;
  activeSymbols = symbols.slice(0, MAX_SYMBOLS);
  log.info(`Global trade listener başlatılıyor — ${activeSymbols.length} sembol (>=$${(WHALE_THRESHOLD_USD / 1000).toFixed(0)}K threshold)`);
  connect();
}

/**
 * WS bağlantısını kapatır. Graceful shutdown için.
 */
export function stopGlobalTradeListener(): void {
  running = false;
  cleanup();
  log.info('Global trade listener durduruldu');
}

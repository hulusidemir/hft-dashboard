// ─────────────────────────────────────────────────────────────────────────────
// services/LiquidationListener.ts — Otonom Tasfiye WebSocket Dinleyicisi
// ─────────────────────────────────────────────────────────────────────────────
//
// Server başlatıldığında arka planda çalışır.
// Binance, Bybit ve OKX'in TÜM USDT Perp tasfiye kanallarını dinler.
// Gelen her tasfiyeyi parse edip SQLite'a INSERT eder.
//
// Bağlantı koptuğunda otomatik reconnect yapar.
// ─────────────────────────────────────────────────────────────────────────────

import WebSocket from 'ws';
import { EventEmitter } from 'node:events';
import { Logger } from '../utils/logger.js';
import { insertLiquidation, type LiquidationRecord } from '../db/LiquidationDB.js';

const log = new Logger('LiqListener');

// ── Global Tasfiye Event Emitter ───────────────────────────────────────────
// Tüm coinlerdeki büyük tasfiye olaylarını dışıya (server.ts) yayınlar.
// Event: 'war_liq' — $50K+ tasfiyeler.
// ─────────────────────────────────────────────────────────────────
export const liqEvents = new EventEmitter();
liqEvents.setMaxListeners(20);

// ── Config ───────────────────────────────────────────────────────────────────

const RECONNECT_DELAY_MS   = 3_000;
const PING_INTERVAL_MS     = 20_000;

// ── Durum ────────────────────────────────────────────────────────────────────

let running = false;

// Her WS bağlantısı için timer referanslarını tutar
interface WsHandle {
  ws: WebSocket | null;
  pingTimer: ReturnType<typeof setInterval> | null;
  pongTimer: ReturnType<typeof setTimeout> | null;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
}

const handles: { binance: WsHandle; bybit: WsHandle; okx: WsHandle } = {
  binance: { ws: null, pingTimer: null, pongTimer: null, reconnectTimer: null },
  bybit:   { ws: null, pingTimer: null, pongTimer: null, reconnectTimer: null },
  okx:     { ws: null, pingTimer: null, pongTimer: null, reconnectTimer: null },
};

// ═════════════════════════════════════════════════════════════════════════════
//  ORTAK YARDIMCILAR
// ═════════════════════════════════════════════════════════════════════════════

function sf(v: unknown): number {
  const n = parseFloat(String(v ?? '0'));
  return isFinite(n) ? n : 0;
}

function clearHandle(h: WsHandle): void {
  if (h.pingTimer)      { clearInterval(h.pingTimer);  h.pingTimer = null; }
  if (h.pongTimer)      { clearTimeout(h.pongTimer);   h.pongTimer = null; }
  if (h.reconnectTimer) { clearTimeout(h.reconnectTimer); h.reconnectTimer = null; }
  if (h.ws) {
    h.ws.removeAllListeners();
    try { h.ws.close(); } catch { /* ignore */ }
    h.ws = null;
  }
}

function scheduleReconnect(exchange: string, connectFn: () => void): void {
  const h = handles[exchange as keyof typeof handles];
  if (!h || !running) return;
  if (h.reconnectTimer) return; // zaten planlanmış
  h.reconnectTimer = setTimeout(() => {
    h.reconnectTimer = null;
    if (running) connectFn();
  }, RECONNECT_DELAY_MS);
}

// ═════════════════════════════════════════════════════════════════════════════
//  BINANCE — wss://fstream.binance.com/ws/!forceOrder@arr
// ═════════════════════════════════════════════════════════════════════════════

function connectBinance(): void {
  const h = handles.binance;
  clearHandle(h);
  if (!running) return;

  const url = 'wss://fstream.binance.com/ws/!forceOrder@arr';
  log.info(`[BIN] Bağlanılıyor: ${url}`);

  const ws = new WebSocket(url);
  h.ws = ws;

  ws.on('open', () => {
    log.info('[BIN] Tasfiye kanalı bağlandı');
    // Binance WS ping/pong: ws kütüphanesi otomatik pong gönderir
    h.pingTimer = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) ws.ping();
    }, PING_INTERVAL_MS);
  });

  ws.on('message', (raw: WebSocket.RawData) => {
    try {
      const data = JSON.parse(raw.toString());
      // Binance !forceOrder@arr → { e: 'forceOrder', o: { s, S, q, p, ap, ... } }
      // Ayrıca array olarak gelebilir
      const events = Array.isArray(data) ? data as unknown[] : [data];
      for (const evt of events) {
        parseBinanceLiq(evt as BinForceOrder);
      }
    } catch {
      // parse error — yoksay
    }
  });

  ws.on('close', () => {
    log.warn('[BIN] Bağlantı kapandı, yeniden bağlanılacak...');
    clearHandle(h);
    scheduleReconnect('binance', connectBinance);
  });

  ws.on('error', (err: Error) => {
    log.warn('[BIN] WS hata', err);
    clearHandle(h);
    scheduleReconnect('binance', connectBinance);
  });
}

interface BinForceOrder {
  e: string;
  o: {
    s: string;    // BTCUSDT
    S: string;    // BUY | SELL
    q: string;    // quantity
    p: string;    // price
    ap: string;   // average price
    z: string;    // filled qty
    T: number;    // trade time
  };
}

function parseBinanceLiq(msg: BinForceOrder): void {
  if (msg.e !== 'forceOrder' || !msg.o) return;
  const o = msg.o;

  // ap = average fill price (gerçek dolum fiyatı)
  // p  = order/bankruptcy price (piyasa fiyatı DEĞİL — çok uzak olabilir!)
  // ap=0 → henüz dolum yok (NEW status) → ATLA
  const avgPrice = sf(o.ap);
  if (avgPrice <= 0) return;

  const price = avgPrice;
  // z = cumulative filled qty (gerçek), q = orijinal order qty
  const qty = sf(o.z) || sf(o.q);
  if (qty <= 0) return;

  // Binance: S=SELL → long tasfiye, S=BUY → short tasfiye
  const side = o.S === 'SELL' ? 'long' : 'short';

  const rec: LiquidationRecord = {
    exchange:  'binance',
    symbol:    o.s,  // BTCUSDT
    side,
    price,
    qty,
    usdValue:  price * qty,
    timestamp: o.T || Date.now(),
  };
  insertLiquidation(rec);

  // ALL liq events — frontend liquidation feed için (sembol filtresi index.ts'de yapılır)
  liqEvents.emit('liq_all', rec);

  // Global war_liq event — RadarPanel War Log için
  if (rec.usdValue >= 50_000) {
    liqEvents.emit('war_liq', {
      type: side === 'long' ? 'LIQ_LONG' : 'LIQ_SHORT',
      symbol: rec.symbol,
      price: rec.price,
      quoteQty: rec.usdValue,
      exchange: 'BINANCE',
      timestamp: rec.timestamp,
    });
  }
}

// ═════════════════════════════════════════════════════════════════════════════
//  BYBIT — DEVRE DIŞI
//  Bybit V5 liquidation WS topic'i ve REST endpoint'i kaldırıldı (2025+).
//  WS: "handler not found", REST /v5/market/liquidation: 404
//  Bybit tasfiye verisi artık mevcut değil — sadece Binance + OKX kullanılıyor.
// ═════════════════════════════════════════════════════════════════════════════

function connectBybit(): void {
  log.warn('[BYB] Bybit V5 liquidation API kaldırıldı — bağlantı atlanıyor (Binance + OKX yeterli)');
  // Bybit handle temizliğe gerek yok — bağlantı açılmadı
}

// ═════════════════════════════════════════════════════════════════════════════
//  OKX — wss://ws.okx.com:8443/ws/v5/public
//  Channel: liquidation-orders, instType: SWAP
//  OKX tüm SWAP tasfiyelerini tek subscription ile gönderir.
// ═════════════════════════════════════════════════════════════════════════════

function connectOkx(): void {
  const h = handles.okx;
  clearHandle(h);
  if (!running) return;

  const url = 'wss://ws.okx.com:8443/ws/v5/public';
  log.info(`[OKX] Bağlanılıyor: ${url}`);

  const ws = new WebSocket(url);
  h.ws = ws;

  ws.on('open', () => {
    log.info('[OKX] Bağlandı, liquidation-orders abone olunuyor...');
    ws.send(JSON.stringify({
      op: 'subscribe',
      args: [
        { channel: 'liquidation-orders', instType: 'SWAP' },
      ],
    }));
    // OKX ping: "ping" string gönder
    h.pingTimer = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send('ping');
      }
    }, PING_INTERVAL_MS);
  });

  ws.on('message', (raw: WebSocket.RawData) => {
    try {
      const text = raw.toString();
      if (text === 'pong') return;

      const data = JSON.parse(text) as Record<string, unknown>;
      // Subscribe ACK
      if (data['event']) return;

      const arg = data['arg'] as { channel?: string } | undefined;
      if (!arg || arg.channel !== 'liquidation-orders') return;

      parseOkxLiq(data as unknown as OkxLiqMsg);
    } catch {
      // parse error
    }
  });

  ws.on('close', () => {
    log.warn('[OKX] Bağlantı kapandı, yeniden bağlanılacak...');
    clearHandle(h);
    scheduleReconnect('okx', connectOkx);
  });

  ws.on('error', (err: Error) => {
    log.warn('[OKX] WS hata', err);
    clearHandle(h);
    scheduleReconnect('okx', connectOkx);
  });
}

interface OkxLiqDetail {
  side: string;   // buy | sell
  sz: string;     // contracts
  px: string;     // price
  bkPx: string;   // bankruptcy price
  ts: string;
}

interface OkxLiqMsg {
  arg: { channel: string; instType: string };
  data: Array<{
    instId: string;      // BTC-USDT-SWAP
    instType: string;
    totalLoss: string;
    details: OkxLiqDetail[];
  }>;
}

/**
 * OKX sembol formatını normalize eder: BTC-USDT-SWAP → BTCUSDT
 */
function okxInstIdToSymbol(instId: string): string {
  // BTC-USDT-SWAP → BTC + USDT
  return instId.replace(/-SWAP$/, '').replace(/-/, '');
}

/**
 * OKX contract size lookup —
 * Basit bir yaklaşım: quantity * price = usdValue
 * OKX tasfiye mesajlarında sz zaten kontrat cinsinden.
 * Kesin hesap için contractValue gerekir ama bunu bilmiyoruz.
 * Yaklaşım: bkPx veya px * sz (kontrat) → mini lot olarak ele alıyoruz.
 * OKX'te BTC-USDT-SWAP 1 kontrat = 0.01 BTC gibi.
 * Ama biz kontrat fiyatını doğrudan kullanıyoruz:
 * usdValue = price * sz yapıyoruz (OKX sz kontrat cinsinden,
 * ancak liq mesajında sz genelde USD-karşılığı büyüklük).
 *
 * NOT: OKX liq-orders WS'de sz = kontrat adedi.
 * Doğru hesap: usdValue = sz * ctVal * price
 * ctVal bilinmiyorsa yaklaşım.
 */
const OKX_CT_MAP: Record<string, number> = {
  'BTC-USDT-SWAP':  0.01,
  'ETH-USDT-SWAP':  0.1,
  'SOL-USDT-SWAP':  1,
  'XRP-USDT-SWAP':  100,
  'DOGE-USDT-SWAP': 1000,
  'ADA-USDT-SWAP':  100,
  'AVAX-USDT-SWAP': 1,
  'LINK-USDT-SWAP': 1,
  'DOT-USDT-SWAP':  1,
  'MATIC-USDT-SWAP': 100,
  'BNB-USDT-SWAP':  0.1,
  'SUI-USDT-SWAP':  1,
  'ARB-USDT-SWAP':  10,
  'OP-USDT-SWAP':   10,
  'PEPE-USDT-SWAP': 10000,
  'WIF-USDT-SWAP':  1,
  'FIL-USDT-SWAP':  1,
  'APT-USDT-SWAP':  1,
  'LTC-USDT-SWAP':  0.1,
  'UNI-USDT-SWAP':  10,
  'NEAR-USDT-SWAP': 10,
  'ATOM-USDT-SWAP': 1,
  'ETC-USDT-SWAP':  10,
  'TRX-USDT-SWAP':  1000,
  'SHIB-USDT-SWAP': 10000,
  'IMX-USDT-SWAP':  1,
  'AAVE-USDT-SWAP': 0.1,
  'INJ-USDT-SWAP':  1,
  'RENDER-USDT-SWAP': 1,
  'FET-USDT-SWAP':  10,
  'STX-USDT-SWAP':  10,
};

function getOkxCtVal(instId: string): number {
  return OKX_CT_MAP[instId] ?? 1;
}

function parseOkxLiq(msg: OkxLiqMsg): void {
  if (!msg.data || msg.data.length === 0) return;

  for (const entry of msg.data) {
    const instId = entry.instId;
    // Sadece USDT-SWAP
    if (!instId.endsWith('-USDT-SWAP')) continue;

    const symbol = okxInstIdToSymbol(instId);
    const ctVal = getOkxCtVal(instId);

    for (const d of entry.details ?? []) {
      // OKX liquidation-orders kanalında px YOKTUR — bkPx kullan
      const price = sf(d.bkPx);
      const contracts = sf(d.sz);
      if (price <= 0 || contracts <= 0) continue;

      const baseQty = contracts * ctVal;
      const usdValue = baseQty * price;

      // OKX: side=sell → long tasfiye, side=buy → short tasfiye
      const side = d.side === 'sell' ? 'long' : 'short';

      const rec: LiquidationRecord = {
        exchange:  'okx',
        symbol,
        side,
        price,
        qty: baseQty,
        usdValue,
        timestamp: sf(d.ts) || Date.now(),
      };
      insertLiquidation(rec);

      // ALL liq events — frontend liquidation feed için
      liqEvents.emit('liq_all', rec);

      // Global war_liq event — RadarPanel War Log için
      if (rec.usdValue >= 50_000) {
        liqEvents.emit('war_liq', {
          type: side === 'long' ? 'LIQ_LONG' : 'LIQ_SHORT',
          symbol: rec.symbol,
          price: rec.price,
          quoteQty: rec.usdValue,
          exchange: 'OKX',
          timestamp: rec.timestamp,
        });
      }
    }
  }
}

// ═════════════════════════════════════════════════════════════════════════════
//  PUBLIC API
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Binance + OKX tasfiye WebSocket kanallarına bağlanır.
 * Bybit V5 liquidation API kaldırıldığı için devre dışı.
 * index.ts bootstrap sırasında bir kez çağrılır.
 */
export function startLiquidationListener(): void {
  if (running) return;
  running = true;
  log.info('Tasfiye dinleyicisi başlatılıyor (Binance + OKX). Bybit liq API kaldırıldı — atlanıyor.');

  connectBinance();
  connectBybit();   // Sadece uyarı loglayacak, bağlantı açmayacak
  connectOkx();
}

/**
 * Tüm WS bağlantılarını kapatır. Graceful shutdown için.
 */
export function stopLiquidationListener(): void {
  running = false;
  log.info('Tasfiye dinleyicisi durduruluyor...');

  clearHandle(handles.binance);
  clearHandle(handles.bybit);
  clearHandle(handles.okx);
}

// ─────────────────────────────────────────────────────────────────────────────
// server.ts — uWebSockets.js Pub/Sub Server + msgpack binary encoding
// Tüm aggregated verileri frontend'e binary WebSocket üzerinden yayınlar.
// Sembol değişikliği WS mesajı ile tetiklenir, sembol listesi REST ile sunulur.
// ─────────────────────────────────────────────────────────────────────────────

import uWS from 'uWebSockets.js';
import { encode } from '@msgpack/msgpack';
import { Logger } from './utils/logger.js';
import type { OrderBookAggregator } from './aggregators/OrderBookAggregator.js';
import type { TradeAggregator } from './aggregators/TradeAggregator.js';
import type { LiquidationAggregator } from './aggregators/LiquidationAggregator.js';
import type { OpenInterestAggregator } from './aggregators/OpenInterestAggregator.js';
import type { RadarService } from './services/RadarService.js';
import type { IUnifiedOrderBook } from './interfaces/IUnifiedOrderBook.js';
import type { ITradeWithCVD } from './interfaces/IUnifiedTrade.js';
import type { IUnifiedLiquidation } from './interfaces/IUnifiedLiquidation.js';
import type { IUnifiedOpenInterest } from './interfaces/IUnifiedOpenInterest.js';
import { fetchMrData } from './services/MrService.js';

// ── Topic Constants ──────────────────────────────────────────────────────────
const TOPIC_LOB          = 'lob';
const TOPIC_TRADES       = 'trades';
const TOPIC_LIQUIDATIONS = 'liquidations';
const TOPIC_OI           = 'oi';

const ALL_TOPICS = [TOPIC_LOB, TOPIC_TRADES, TOPIC_LIQUIDATIONS, TOPIC_OI] as const;

// ── Types ────────────────────────────────────────────────────────────────────
interface WSUserData {
  id: number;
  connectedAt: number;
}

interface Aggregators {
  orderBook: OrderBookAggregator;
  trade: TradeAggregator;
  liquidation: LiquidationAggregator;
  openInterest: OpenInterestAggregator;
}

/** Opsiyonel servisler — Radar vb. */
interface Services {
  radar?: RadarService;
}

/** Frontend'ten gelen WS mesaj formatı */
interface ClientMessage {
  action: string;
  symbol?: string;
}

/** Sembol değişikliği callback — index.ts tarafından sağlanır */
export type OnSymbolChangeCallback = (newSymbol: string) => Promise<void>;

/** Sembol listesi sağlayıcı — index.ts tarafından sağlanır */
export type GetSymbolListCallback = () => string[];

interface ServerHandle {
  app: uWS.TemplatedApp;
  listenSocket: uWS.us_listen_socket | null;
  close: () => void;
}

interface ServerOptions {
  aggregators: Aggregators;
  services?: Services;
  port: number;
  onSymbolChange: OnSymbolChangeCallback;
  getSymbolList: GetSymbolListCallback;
  getCurrentSymbol: () => string;
}

// ── Reusable encode buffer wrapper ──────────────────────────────────────────
function packMessage(type: string, data: unknown): Uint8Array {
  return encode({ t: type, d: data });
}

// ── CORS Headers ────────────────────────────────────────────────────────────
function applyCors(res: uWS.HttpResponse): void {
  res.writeHeader('Access-Control-Allow-Origin', '*');
  res.writeHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.writeHeader('Access-Control-Allow-Headers', 'Content-Type');
}

// ── Server Factory ──────────────────────────────────────────────────────────
export function startServer(options: ServerOptions): Promise<ServerHandle> {
  const { aggregators, services, port, onSymbolChange, getSymbolList, getCurrentSymbol } = options;
  const log = new Logger('uWS');
  let connectionCounter = 0;
  let activeConnections  = 0;

  // Sembol değişikliği kilidi — eş zamanlı 2 değişikliği engeller
  let isChangingSymbol = false;

  const app = uWS.App();

  // ── Health check endpoint ─────────────────────────────────────────────────
  app.get('/health', (res, _req) => {
    res.cork(() => {
      applyCors(res);
      res.writeHeader('Content-Type', 'application/json')
         .end(JSON.stringify({
           status: 'ok',
           connections: activeConnections,
           symbol: getCurrentSymbol(),
           uptime: process.uptime(),
         }));
    });
  });

  // ── Sembol listesi REST endpoint ──────────────────────────────────────────
  app.get('/api/symbols', (res, _req) => {
    res.cork(() => {
      applyCors(res);
      res.writeHeader('Content-Type', 'application/json')
         .end(JSON.stringify({
           symbols: getSymbolList(),
           current: getCurrentSymbol(),
         }));
    });
  });

  // ── Radar Hot Targets REST endpoint ────────────────────────────────────────
  app.get('/api/radar/hot-targets', (res, _req) => {
    res.cork(() => {
      applyCors(res);
      res.writeHeader('Content-Type', 'application/json');
      if (services?.radar) {
        res.end(JSON.stringify(services.radar.getHotTargets()));
      } else {
        res.end(JSON.stringify({ topVolume: [], topGainers: [], topLosers: [], updatedAt: 0 }));
      }
    });
  });

  // ── COIN MR (Market Reconnaissance) REST endpoint ─────────────────────────
  app.get('/api/mr', (res, req) => {
    const symbol = (req.getQuery('symbol') || getCurrentSymbol()).toUpperCase();
    const timeframe = (req.getQuery('tf') || '1h') as '15m' | '1h' | '4h' | '24h';

    // uWS: response nesnesinin hâlâ geçerli olup olmadığını izle
    let aborted = false;
    res.onAborted(() => { aborted = true; });

    fetchMrData(symbol, timeframe)
      .then((result) => {
        if (aborted) return;
        res.cork(() => {
          applyCors(res);
          res.writeHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(result));
        });
      })
      .catch((err) => {
        if (aborted) return;
        log.error('MR fetch error', err instanceof Error ? err : new Error(String(err)));
        res.cork(() => {
          applyCors(res);
          res.writeStatus('500 Internal Server Error');
          res.writeHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
        });
      });
  });

  // ── CORS preflight handler ────────────────────────────────────────────────
  app.options('/*', (res, _req) => {
    res.cork(() => {
      applyCors(res);
      res.end();
    });
  });

  // ── WebSocket behavior ────────────────────────────────────────────────────
  app.ws<WSUserData>('/*', {

    /* Performance tuning */
    maxPayloadLength:       64 * 1024,
    maxBackpressure:        128 * 1024,
    closeOnBackpressureLimit: true,
    idleTimeout:            30,
    sendPingsAutomatically: true,
    compression:            uWS.DISABLED,

    /* ── open ──────────────────────────────────────────────────────────────── */
    open: (ws) => {
      const id = ++connectionCounter;
      activeConnections++;

      ws.getUserData().id = id;
      ws.getUserData().connectedAt = Date.now();

      // Tüm topic'lere subscribe et
      for (const topic of ALL_TOPICS) {
        ws.subscribe(topic);
      }

      // Bağlantı açıldığında mevcut sembolü bildir
      const initMsg = encode({
        t: 'init',
        d: {
          symbol: getCurrentSymbol(),
          symbols: getSymbolList(),
        },
      });
      ws.send(initMsg, true, false);

      log.info(`Client connected #${id}`, {
        active: activeConnections,
        topics: ALL_TOPICS.length,
      });
    },

    /* ── message ───────────────────────────────────────────────────────────── */
    message: (ws, message, _isBinary) => {
      try {
        const text = Buffer.from(message).toString('utf-8');

        // Basit ping/pong
        if (text === 'ping') {
          ws.send('pong', false, false);
          return;
        }

        // JSON komut parse
        const parsed = JSON.parse(text) as ClientMessage;

        if (parsed.action === 'change_symbol' && parsed.symbol) {
          const newSymbol = parsed.symbol.toUpperCase().trim();

          if (isChangingSymbol) {
            log.warn('Sembol değişikliği zaten devam ediyor, istek reddedildi', { newSymbol });
            return;
          }

          if (newSymbol === getCurrentSymbol()) {
            log.debug('Aynı sembol — değişiklik yok', { symbol: newSymbol });
            return;
          }

          log.info(`Sembol değişikliği başlatılıyor: ${getCurrentSymbol()} → ${newSymbol}`);
          isChangingSymbol = true;

          // Tüm client'lara "switching" bildir
          const switchingMsg = encode({ t: 'symbol_switching', d: { symbol: newSymbol } });
          app.publish(TOPIC_LOB, switchingMsg, true, false);

          onSymbolChange(newSymbol)
            .then(() => {
              isChangingSymbol = false;
              // Tüm client'lara "switched" bildir
              const switchedMsg = encode({ t: 'symbol_changed', d: { symbol: newSymbol } });
              app.publish(TOPIC_LOB, switchedMsg, true, false);
              log.info(`Sembol değişikliği tamamlandı: ${newSymbol}`);
            })
            .catch((err) => {
              isChangingSymbol = false;
              log.error('Sembol değişikliği başarısız', err instanceof Error ? err : new Error(String(err)));
              const errorMsg = encode({
                t: 'symbol_error',
                d: { error: err instanceof Error ? err.message : String(err) },
              });
              ws.send(errorMsg, true, false);
            });
        }
      } catch {
        // parse error — ignore
      }
    },

    /* ── drain ─────────────────────────────────────────────────────────────── */
    drain: (ws) => {
      const buffered = ws.getBufferedAmount();
      if (buffered > 0) {
        log.debug(`Client #${ws.getUserData().id} draining`, { buffered });
      }
    },

    /* ── close ──────────────────────────────────────────────────────────────── */
    close: (ws, code, _message) => {
      activeConnections = Math.max(0, activeConnections - 1);
      log.info(`Client disconnected #${ws.getUserData().id}`, {
        code,
        active: activeConnections,
      });
    },
  });

  // ── Aggregator event listeners → pub/sub publish ──────────────────────────

  // 1) OrderBook — 50ms interval'den gelir
  aggregators.orderBook.on('aggregated_orderbook', (data: IUnifiedOrderBook) => {
    if (activeConnections === 0) return;
    const packed = packMessage(TOPIC_LOB, data);
    app.publish(TOPIC_LOB, packed, true, false);
  });

  // 2) Trades — 20ms flush'tan gelir
  aggregators.trade.on('aggregated_trades', (data: ITradeWithCVD) => {
    if (activeConnections === 0) return;
    const packed = packMessage(TOPIC_TRADES, data);
    app.publish(TOPIC_TRADES, packed, true, false);
  });

  // 3) Liquidations — event-based, anında iletilir
  aggregators.liquidation.on('aggregated_liquidation', (data: IUnifiedLiquidation) => {
    if (activeConnections === 0) return;
    const packed = packMessage(TOPIC_LIQUIDATIONS, data);
    app.publish(TOPIC_LIQUIDATIONS, packed, true, false);
  });

  // 4) Open Interest — polling cycle'dan gelir
  aggregators.openInterest.on('aggregated_oi', (data: IUnifiedOpenInterest) => {
    if (activeConnections === 0) return;
    const packed = packMessage(TOPIC_OI, data);
    app.publish(TOPIC_OI, packed, true, false);
  });

  // ── Listen ────────────────────────────────────────────────────────────────
  return new Promise<ServerHandle>((resolve, reject) => {
    app.listen(port, (listenSocket) => {
      if (listenSocket) {
        log.info(`uWebSockets.js server listening`, { port, pid: process.pid });
        log.info(`Topics: ${ALL_TOPICS.join(', ')}`);
        log.info(`REST endpoints: /health, /api/symbols, /api/radar/hot-targets`);
        log.info(`Health check: http://localhost:${port}/health`);

        const handle: ServerHandle = {
          app,
          listenSocket,
          close: () => {
            uWS.us_listen_socket_close(listenSocket);
            log.info('uWebSockets.js server closed');
          },
        };
        resolve(handle);
      } else {
        reject(new Error(`Failed to listen on port ${port}`));
      }
    });
  });
}

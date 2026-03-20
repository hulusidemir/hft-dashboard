// ─────────────────────────────────────────────────────────────────────────────
// server.ts — uWebSockets.js Pub/Sub Server + msgpack binary encoding
// Tüm aggregated verileri frontend'e binary WebSocket üzerinden yayınlar.
// Sembol değişikliği WS mesajı ile tetiklenir, sembol listesi REST ile sunulur.
// ─────────────────────────────────────────────────────────────────────────────

import uWS from 'uWebSockets.js';
import { encode } from '@msgpack/msgpack';
import { Logger } from './utils/logger.js';
import type { SubscriptionManager, SymbolStack } from './SubscriptionManager.js';
import type { RadarService } from './services/RadarService.js';
import type { IUnifiedOrderBook } from './interfaces/IUnifiedOrderBook.js';
import type { ITradeWithCVD } from './interfaces/IUnifiedTrade.js';
import type { IUnifiedLiquidation } from './interfaces/IUnifiedLiquidation.js';
import type { IUnifiedOpenInterest } from './interfaces/IUnifiedOpenInterest.js';
import { fetchMrData } from './services/MrService.js';
import { getRecentLiquidations } from './db/LiquidationDB.js';
import { fetchCoinInfo } from './services/CoinInfoService.js';
import { fetchKlines, fetchOIHistory } from './services/KlineService.js';
import type { KlineExchange } from './services/KlineService.js';
import { fetchCoinNews } from './services/NewsService.js';
import { fetchMarketOverview } from './services/OverviewService.js';

// ── Topic Constants ──────────────────────────────────────────────────────────
const TOPIC_WAR_LOG = 'war_log';

/** Sembol bazlı pub/sub topic'leri — her client kendi sembolünün topic'lerine abone olur */
function symbolTopics(symbol: string): string[] {
  return [
    `lob:${symbol}`,
    `trades:${symbol}`,
    `liquidations:${symbol}`,
    `oi:${symbol}`,
  ];
}

// ── Types ────────────────────────────────────────────────────────────────────
interface WSUserData {
  id: number;
  connectedAt: number;
  symbol: string;
  isChangingSymbol: boolean;
  pendingSymbol?: string;
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

/** Sembol listesi sağlayıcı — index.ts tarafından sağlanır */
export type GetSymbolListCallback = () => string[];

interface ServerHandle {
  app: uWS.TemplatedApp;
  listenSocket: uWS.us_listen_socket | null;
  close: () => void;
  /** Global war log entry yayınla (tasfiye + balina) */
  publishWarLog: (entry: unknown) => void;
  /** Belirli bir sembolün liquidation topic'ine yayınla */
  publishLiquidationToSymbol: (data: IUnifiedLiquidation, symbol: string) => void;
}

interface ServerOptions {
  subscriptionManager: SubscriptionManager;
  services?: Services;
  port: number;
  getSymbolList: GetSymbolListCallback;
  defaultSymbol: string;
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
  const { subscriptionManager: subMgr, services, port, getSymbolList, defaultSymbol } = options;
  const log = new Logger('uWS');
  let connectionCounter = 0;
  let activeConnections  = 0;

  // Per-client ws referans map'i — async callback'lerde güvenli erişim için
  const clients = new Map<number, uWS.WebSocket<WSUserData>>();

  const app = uWS.App();

  // ── Her yeni sembol stack'i için aggregator event'lerini pub/sub'a bağla ──
  subMgr.setWireCallback((stack: SymbolStack) => {
    stack.obAgg.on('aggregated_orderbook', (data: IUnifiedOrderBook) => {
      if (activeConnections === 0) return;
      const packed = packMessage('lob', data);
      app.publish(`lob:${stack.symbol}`, packed, true, false);
    });
    stack.trAgg.on('aggregated_trades', (data: ITradeWithCVD) => {
      if (activeConnections === 0) return;
      const packed = packMessage('trades', data);
      app.publish(`trades:${stack.symbol}`, packed, true, false);
    });
    stack.liqAgg.on('aggregated_liquidation', (data: IUnifiedLiquidation) => {
      if (activeConnections === 0) return;
      const packed = packMessage('liquidations', data);
      app.publish(`liquidations:${stack.symbol}`, packed, true, false);
    });
    stack.oiAgg.on('aggregated_oi', (data: IUnifiedOpenInterest) => {
      if (activeConnections === 0) return;
      const packed = packMessage('oi', data);
      app.publish(`oi:${stack.symbol}`, packed, true, false);
    });
  });

  // ── Health check endpoint ─────────────────────────────────────────────────
  app.get('/health', (res, _req) => {
    res.cork(() => {
      applyCors(res);
      res.writeHeader('Content-Type', 'application/json')
         .end(JSON.stringify({
           status: 'ok',
           connections: activeConnections,
           symbol: defaultSymbol,
           activeSymbols: subMgr.getActiveSymbols(),
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
           current: defaultSymbol,
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
    const symbol = (req.getQuery('symbol') || defaultSymbol).toUpperCase();
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

  // ── Recent Liquidations REST endpoint ──────────────────────────────────────
  app.get('/api/liquidations/recent', (res, req) => {
    const symbol = (req.getQuery('symbol') || defaultSymbol).toUpperCase();
    const limit = Math.min(Number(req.getQuery('limit')) || 50, 200);
    res.cork(() => {
      applyCors(res);
      res.writeHeader('Content-Type', 'application/json');
      const rows = getRecentLiquidations(symbol, limit);
      res.end(JSON.stringify(rows));
    });
  });

  // ── Coin Info (CoinGecko) REST endpoint ─────────────────────────────────────
  app.get('/api/coin-info', (res, req) => {
    const symbol = (req.getQuery('symbol') || defaultSymbol).toUpperCase();

    let aborted = false;
    res.onAborted(() => { aborted = true; });

    fetchCoinInfo(symbol)
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
        log.error('CoinInfo fetch error', err instanceof Error ? err : new Error(String(err)));
        res.cork(() => {
          applyCors(res);
          res.writeStatus('500 Internal Server Error');
          res.writeHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
        });
      });
  });

  // ── Klines REST endpoint ──────────────────────────────────────────────────
  app.get('/api/klines', (res, req) => {
    const symbol = (req.getQuery('symbol') || defaultSymbol).toUpperCase();
    const interval = req.getQuery('interval') || '5m';
    const limitStr = req.getQuery('limit');
    const limit = limitStr ? Math.min(Number(limitStr), 1500) : 500;
    const exchange = (req.getQuery('exchange') || 'binance').toLowerCase() as KlineExchange;

    let aborted = false;
    res.onAborted(() => { aborted = true; });

    fetchKlines(symbol, interval, limit, exchange)
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
        log.error('Klines fetch error', err instanceof Error ? err : new Error(String(err)));
        res.cork(() => {
          applyCors(res);
          res.writeStatus('500 Internal Server Error');
          res.writeHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
        });
      });
  });

  // ── Coin News REST endpoint ─────────────────────────────────────────────────
  // ── OI History REST endpoint ────────────────────────────────────────────────
  app.get('/api/oi-history', (res, req) => {
    const symbol = (req.getQuery('symbol') || defaultSymbol).toUpperCase();
    const period = req.getQuery('period') || '5m';
    const limitStr = req.getQuery('limit');
    const limit = limitStr ? Math.min(Number(limitStr), 500) : 500;

    let aborted = false;
    res.onAborted(() => { aborted = true; });

    fetchOIHistory(symbol, period, limit)
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
        log.error('OI History fetch error', err instanceof Error ? err : new Error(String(err)));
        res.cork(() => {
          applyCors(res);
          res.writeStatus('500 Internal Server Error');
          res.writeHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
        });
      });
  });

  // ── Coin News REST endpoint ─────────────────────────────────────────────────
  app.get('/api/news', (res, req) => {
    const symbol = (req.getQuery('symbol') || defaultSymbol).toUpperCase();

    let aborted = false;
    res.onAborted(() => { aborted = true; });

    fetchCoinNews(symbol)
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
        log.error('News fetch error', err instanceof Error ? err : new Error(String(err)));
        res.cork(() => {
          applyCors(res);
          res.writeStatus('500 Internal Server Error');
          res.writeHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
        });
      });
  });

  // ── Market Overview REST endpoint ──────────────────────────────────────────
  app.get('/api/overview', (res, req) => {
    const symbol = (req.getQuery('symbol') || 'BTCUSDT').toUpperCase();

    let aborted = false;
    res.onAborted(() => { aborted = true; });

    fetchMarketOverview(symbol)
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
        log.error('Overview fetch error', err instanceof Error ? err : new Error(String(err)));
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

      const userData = ws.getUserData();
      userData.id = id;
      userData.connectedAt = Date.now();
      userData.symbol = defaultSymbol;
      userData.isChangingSymbol = false;

      clients.set(id, ws);

      // Varsayılan sembolün topic'lerine + global war_log'a abone ol
      for (const topic of symbolTopics(defaultSymbol)) {
        ws.subscribe(topic);
      }
      ws.subscribe(TOPIC_WAR_LOG);

      // SubscriptionManager'a kaydet (stack yoksa oluşturulur)
      subMgr.subscribe(id, defaultSymbol).catch((err) => {
        log.error(`Default subscribe hatası #${id}`, err instanceof Error ? err : new Error(String(err)));
      });

      // Bağlantı açıldığında mevcut sembolü bildir
      const initMsg = encode({
        t: 'init',
        d: {
          symbol: defaultSymbol,
          symbols: getSymbolList(),
        },
      });
      ws.send(initMsg, true, false);

      log.info(`Client connected #${id}`, {
        active: activeConnections,
        symbol: defaultSymbol,
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
          const userData = ws.getUserData();
          const newSymbol = parsed.symbol.toUpperCase().trim();

          // Per-client kilit — aynı client'ın eş zamanlı 2 değişikliğini engeller
          if (userData.isChangingSymbol) {
            log.warn(`Client #${userData.id}: Sembol değişikliği devam ediyor, reddedildi`, { newSymbol });
            return;
          }

          if (newSymbol === userData.symbol) {
            log.debug(`Client #${userData.id}: Aynı sembol`, { symbol: newSymbol });
            return;
          }

          const oldSymbol = userData.symbol;
          userData.isChangingSymbol = true;
          userData.pendingSymbol = newSymbol;
          const clientId = userData.id;

          log.info(`Client #${clientId}: Sembol değişikliği ${oldSymbol} → ${newSymbol}`);

          // Geçiş süresince eski topic'lerden çık. Yeni topic'e ancak yeni stack hazır olunca gir.
          for (const topic of symbolTopics(oldSymbol)) {
            ws.unsubscribe(topic);
          }

          // BU client'a "switching" bildir
          ws.send(encode({ t: 'symbol_switching', d: { symbol: newSymbol } }), true, false);

          subMgr.subscribe(clientId, newSymbol)
            .then(() => {
              const clientWs = clients.get(clientId);
              if (!clientWs) return; // client bağlantıyı kapattı
              const currentUserData = clientWs.getUserData();
              if (currentUserData.pendingSymbol !== newSymbol) {
                subMgr.unsubscribe(clientId, newSymbol);
                return;
              }

              for (const topic of symbolTopics(newSymbol)) {
                clientWs.subscribe(topic);
              }

              subMgr.unsubscribe(clientId, oldSymbol);
              currentUserData.symbol = newSymbol;
              currentUserData.pendingSymbol = undefined;
              currentUserData.isChangingSymbol = false;

              try {
                clientWs.send(encode({ t: 'symbol_changed', d: { symbol: newSymbol } }), true, false);
              } catch { /* client disconnected */ }
              log.info(`Client #${clientId}: Sembol değişikliği tamamlandı → ${newSymbol}`);
            })
            .catch((err) => {
              log.error(`Client #${clientId}: Sembol değişikliği başarısız`, err instanceof Error ? err : new Error(String(err)));
              const clientWs = clients.get(clientId);
              if (!clientWs) return;
              const cData = clientWs.getUserData();
              cData.pendingSymbol = undefined;
              cData.isChangingSymbol = false;
              try {
                clientWs.send(encode({
                  t: 'symbol_error',
                  d: { error: err instanceof Error ? err.message : String(err) },
                }), true, false);

                for (const topic of symbolTopics(oldSymbol)) {
                  clientWs.subscribe(topic);
                }
                clientWs.send(encode({ t: 'symbol_changed', d: { symbol: oldSymbol } }), true, false);
              } catch { /* client disconnected */ }

              subMgr.unsubscribe(clientId, newSymbol);
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
      const { id, symbol } = ws.getUserData();
      activeConnections = Math.max(0, activeConnections - 1);
      clients.delete(id);
      if (symbol) {
        subMgr.unsubscribe(id, symbol);
      }
      log.info(`Client disconnected #${id}`, {
        code,
        active: activeConnections,
        symbol,
      });
    },
  });

  // ── Listen ────────────────────────────────────────────────────────────────
  return new Promise<ServerHandle>((resolve, reject) => {
    app.listen(port, (listenSocket) => {
      if (listenSocket) {
        log.info(`uWebSockets.js server listening`, { port, pid: process.pid });
        log.info(`Global topic: ${TOPIC_WAR_LOG}`);
        log.info(`REST endpoints: /health, /api/symbols, /api/radar/hot-targets`);
        log.info(`Health check: http://localhost:${port}/health`);

        const handle: ServerHandle = {
          app,
          listenSocket,
          close: () => {
            uWS.us_listen_socket_close(listenSocket);
            log.info('uWebSockets.js server closed');
          },
          publishWarLog: (entry: unknown) => {
            if (activeConnections === 0) return;
            const packed = packMessage(TOPIC_WAR_LOG, entry);
            app.publish(TOPIC_WAR_LOG, packed, true, false);
          },
          publishLiquidationToSymbol: (data: IUnifiedLiquidation, symbol: string) => {
            if (activeConnections === 0) return;
            const packed = packMessage('liquidations', data);
            app.publish(`liquidations:${symbol}`, packed, true, false);
          },
        };
        resolve(handle);
      } else {
        reject(new Error(`Failed to listen on port ${port}`));
      }
    });
  });
}

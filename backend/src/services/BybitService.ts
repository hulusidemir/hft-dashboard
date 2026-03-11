// ─────────────────────────────────────────────────────────────────────────────
// services/BybitService.ts — Bybit V5 Linear WebSocket & LOB Senkronizasyonu
// ─────────────────────────────────────────────────────────────────────────────
//
// Bybit LOB senkronizasyonu Binance'a göre daha basittir:
//   1. WS'ye abone ol → orderbook.50.<symbol>
//   2. İlk mesaj type:"snapshot" → defteri sıfırla & doldur
//   3. Sonraki mesajlar type:"delta" → artımlı güncelle (qty=0 → sil)
//   4. REST snapshot gerekmez — WS kendisi yollar
//
// Bybit V5 API, mesajları "topic" alanıyla etiketler:
//   "orderbook.50.BTCUSDT"     → LOB
//   "publicTrade.BTCUSDT"      → Trades
//   "liquidation.BTCUSDT"      → Liquidations
//
// OI: REST polling /v5/market/open-interest (2300ms staggered)
//
// Önemli Bybit notları:
//   - Fiyat ve miktarlar STRING olarak gelir → parseFloat gerekir
//   - Bybit seq numarası sağlar — opsiyonel süreklilik kontrolü
//   - Ping: Bybit özel ping formatı ister: {"op":"ping"}
//
// ─────────────────────────────────────────────────────────────────────────────

import axios from 'axios';
import WebSocket from 'ws';

import { BaseExchangeService } from './base/BaseExchangeService.js';
import {
  Exchange,
  type ExchangeOrderBookSnapshot,
  type ExchangeOrderBookDelta,
  type ExchangeRawTrade,
  type ExchangeRawLiquidation,
  type ExchangeRawOI,
} from '../interfaces/IExchangeService.js';
import {
  getExchangeSymbol,
  getExchangeRestSymbol,
} from '../config/symbols.js';
import { normalizeTimestamp } from '../utils/timestampUtils.js';
import { hrNowMs } from '../utils/timestampUtils.js';

// ─── REST API Base URL ───────────────────────────────────────────────────────

const BYBIT_REST_BASE = 'https://api.bybit.com';
const BYBIT_WS_URL    = 'wss://stream.bybit.com/v5/public/linear';

/** OI polling aralığı — staggered: Bybit = 2300ms */
const OI_POLL_INTERVAL_MS = 2_300;

// ─── Bybit WS Mesaj Tipleri (dahili) ─────────────────────────────────────────

/** Bybit V5 genel WS mesaj zarfı */
interface BybitWsMessage {
  topic: string;
  type: 'snapshot' | 'delta';
  ts: number;          // Timestamp (ms)
  data: unknown;
  cts?: number;        // Cross timestamp
}

/** Bybit orderbook veri yapısı */
interface BybitOrderBookData {
  s: string;           // Symbol
  b: [string, string][]; // Bids [price, qty]
  a: [string, string][]; // Asks [price, qty]
  u: number;           // Update ID
  seq: number;         // Sequence number
}

/** Bybit publicTrade tek kayıt */
interface BybitTradeItem {
  i: string;           // Trade ID
  T: number;           // Timestamp
  p: string;           // Price
  v: string;           // Volume (quantity)
  S: 'Buy' | 'Sell';  // Side
  s: string;           // Symbol
  BT: string;          // Block trade flag
}

/** Bybit liquidation veri yapısı */
interface BybitLiquidationData {
  updatedTime: number;
  symbol: string;
  side: 'Buy' | 'Sell';
  size: string;
  price: string;
}

/** Bybit REST OI yanıtı */
interface BybitOIResponse {
  retCode: number;
  result: {
    symbol: string;
    category: string;
    list: Array<{
      openInterest: string;
      timestamp: string;
    }>;
  };
}



// ─────────────────────────────────────────────────────────────────────────────
// BybitService
// ─────────────────────────────────────────────────────────────────────────────

export class BybitService extends BaseExchangeService {
  readonly exchange = Exchange.BYBIT;

  // ── LOB State ───────────────────────────────────────────────────────────

  /** Snapshot alındı mı? */
  private isBookSynced: boolean = false;

  /** Son işlenen sequence numarası — süreklilik kontrolü (opsiyonel) */
  private lastSeq: number = -1;

  /** OI polling zamanlayıcısı */
  private oiPollTimer: ReturnType<typeof setInterval> | null = null;

  /** Ping gönderildiği zaman — Bybit özel ping için */
  private bybitPingSentAt: number = 0;

  // ─────────────────────────────────────────────────────────────────────────
  // Constructor
  // ─────────────────────────────────────────────────────────────────────────

  constructor() {
    super('BybitService');
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Abstract Implementasyonlar
  // ─────────────────────────────────────────────────────────────────────────

  protected buildWsUrl(_symbol: string): string {
    // Bybit V5 public linear — tek URL, kanal abone mesajıyla seçilir
    return BYBIT_WS_URL;
  }

  /**
   * Bybit V5 subscribe mesajları.
   * Tüm kanallar tek bir subscribe ile gönderilebilir.
   */
  protected buildSubscribeMessages(symbol: string): object[] {
    const bSymbol = getExchangeSymbol(symbol, Exchange.BYBIT); // "BTCUSDT"
    // NOT: Bybit V5 liquidation WS topic'i deprecated ("handler not found").
    // Sadece orderbook ve publicTrade kanallarına abone ol.
    return [{
      op: 'subscribe',
      args: [
        `orderbook.50.${bSymbol}`,
        `publicTrade.${bSymbol}`,
      ],
    }];
  }

  /**
   * Bybit özel ping mekanizması: {"op":"ping"} gönder.
   * Standart WS ping yerine bu kullanılır — Bybit bunu bekler.
   */
  protected override sendPing(): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.bybitPingSentAt = hrNowMs();
      this.ws.send(JSON.stringify({ op: 'ping' }));
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // connect() Override — OI polling başlat
  // ─────────────────────────────────────────────────────────────────────────

  override async connect(symbol: string): Promise<void> {
    this.resetBookState();
    await super.connect(symbol);
    this.startOIPolling(symbol);
  }

  override disconnect(): void {
    this.stopOIPolling();
    this.resetBookState();
    super.disconnect();
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Mesaj Router — handleMessage
  // ─────────────────────────────────────────────────────────────────────────

  protected handleMessage(data: unknown): void {
    try {
      const msg = data as Record<string, unknown>;

      // ── Bybit pong yanıtı ────────────────────────────────────────────
      if (msg['op'] === 'pong' || msg['ret_msg'] === 'pong') {
        this.handleBybitPong();
        return;
      }

      // ── Subscribe yanıtı ─────────────────────────────────────────────
      if (msg['op'] === 'subscribe') {
        const success = msg['success'] as boolean;
        if (!success) {
          this.log.error('Bybit subscribe hatası', msg);
        } else {
          this.log.debug('Bybit subscribe başarılı', { connId: msg['conn_id'] });
        }
        return;
      }

      // ── Veri mesajları — topic'e göre yönlendir ────────────────────
      const topic = msg['topic'] as string | undefined;
      if (!topic) return;

      const type = msg['type'] as string | undefined;

      if (topic.startsWith('orderbook.')) {
        this.handleOrderBook(msg as unknown as BybitWsMessage);
      } else if (topic.startsWith('publicTrade.')) {
        this.handleTrade(msg as unknown as BybitWsMessage);
      } else {
        this.log.debug('Bilinmeyen Bybit topic', { topic, type });
      }
    } catch (err) {
      this.log.error('handleMessage hatası', err instanceof Error ? err : new Error(String(err)));
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // LOB Senkronizasyonu — Snapshot + Delta
  // ─────────────────────────────────────────────────────────────────────────

  private handleOrderBook(msg: BybitWsMessage): void {
    try {
      const data = msg.data as BybitOrderBookData;

      if (msg.type === 'snapshot') {
        // İlk mesaj: defteri sıfırla ve doldur
        this.isBookSynced = true;
        this.lastSeq = data.seq;

        const bids: [number, number][] = data.b.map(([p, q]) => [parseFloat(p), parseFloat(q)]);
        const asks: [number, number][] = data.a.map(([p, q]) => [parseFloat(p), parseFloat(q)]);
        this.applySnapshot(bids, asks);

        const snapshot = this.parseOrderBookSnapshot(msg);
        this.emit('orderbook_snapshot', snapshot);

        this.log.info('Bybit LOB snapshot alındı', {
          updateId: data.u,
          seq: data.seq,
          bidLevels: bids.length,
          askLevels: asks.length,
        });

      } else if (msg.type === 'delta') {
        if (!this.isBookSynced) {
          this.log.warn('Delta geldi ama snapshot henüz alınmadı — atlanıyor');
          return;
        }

        // Opsiyonel: Sequence süreklilik kontrolü
        if (this.lastSeq > 0 && data.seq <= this.lastSeq) {
          this.log.warn('Eski sequence atlanıyor', {
            lastSeq: this.lastSeq,
            receivedSeq: data.seq,
          });
          return;
        }
        this.lastSeq = data.seq;

        const bids: [number, number][] = data.b.map(([p, q]) => [parseFloat(p), parseFloat(q)]);
        const asks: [number, number][] = data.a.map(([p, q]) => [parseFloat(p), parseFloat(q)]);
        this.applyDelta(bids, asks);

        const delta = this.parseOrderBookDelta(msg);
        this.emit('orderbook_delta', delta);
      }
    } catch (err) {
      this.log.error('OrderBook işleme hatası', err instanceof Error ? err : new Error(String(err)));
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Trade İşleme
  // ─────────────────────────────────────────────────────────────────────────

  private handleTrade(msg: BybitWsMessage): void {
    try {
      const trades = this.parseTrades(msg);
      if (trades.length > 0) {
        this.emit('trade', trades);
      }
    } catch (err) {
      this.log.error('Trade işleme hatası', err instanceof Error ? err : new Error(String(err)));
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Bybit Pong İşleme
  // ─────────────────────────────────────────────────────────────────────────

  private handleBybitPong(): void {
    // Bybit'in özel pong yanıtı geldi — gecikme hesapla
    // BaseExchangeService'teki handlePongReceived()'ı teker çağırabiliriz
    // ama Bybit için özel timestamp mantığı kullanıyoruz
    if (this.bybitPingSentAt > 0) {
      const rtt = hrNowMs() - this.bybitPingSentAt;
      if (this.pingMs < 0) {
        this.pingMs = rtt;
      } else {
        this.pingMs = this.pingMs * 0.7 + rtt * 0.3;
      }
      this.pingMs = Math.round(this.pingMs * 100) / 100;
      this.emit('ping', this.pingMs);
    }
    // Base class'ın pong timer'ını da temizle
    this.handlePongReceived();
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Open Interest REST Polling
  // ─────────────────────────────────────────────────────────────────────────

  private startOIPolling(symbol: string): void {
    this.stopOIPolling();
    this.pollOpenInterest(symbol).catch(() => {});

    this.oiPollTimer = setInterval(() => {
      this.pollOpenInterest(symbol).catch(() => {});
    }, OI_POLL_INTERVAL_MS);
  }

  private stopOIPolling(): void {
    if (this.oiPollTimer) {
      clearInterval(this.oiPollTimer);
      this.oiPollTimer = null;
    }
  }

  private async pollOpenInterest(symbol: string): Promise<void> {
    try {
      const restSymbol = getExchangeRestSymbol(symbol, Exchange.BYBIT);
      const url = `${BYBIT_REST_BASE}/v5/market/open-interest?category=linear&symbol=${restSymbol}&intervalTime=5min&limit=1`;

      const response = await axios.get<BybitOIResponse>(url, { timeout: 5_000 });
      const oi = this.parseOI(response.data);
      if (oi) {
        this.emit('open_interest', oi);
      }
    } catch (err) {
      this.log.warn('OI polling hatası', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Parser Metotları — Ham Bybit → Normalize Format
  // ─────────────────────────────────────────────────────────────────────────

  protected parseOrderBookSnapshot(raw: unknown): ExchangeOrderBookSnapshot {
    const msg = raw as BybitWsMessage;
    const data = msg.data as BybitOrderBookData;
    return {
      exchange: Exchange.BYBIT,
      symbol: this.currentSymbol,
      lastUpdateId: data.u,
      bids: data.b.map(([p, q]) => [parseFloat(p), parseFloat(q)]),
      asks: data.a.map(([p, q]) => [parseFloat(p), parseFloat(q)]),
      timestamp: normalizeTimestamp(msg.ts),
    };
  }

  protected parseOrderBookDelta(raw: unknown): ExchangeOrderBookDelta {
    const msg = raw as BybitWsMessage;
    const data = msg.data as BybitOrderBookData;
    return {
      exchange: Exchange.BYBIT,
      symbol: this.currentSymbol,
      lastUpdateId: data.u,
      bids: data.b.map(([p, q]) => [parseFloat(p), parseFloat(q)]),
      asks: data.a.map(([p, q]) => [parseFloat(p), parseFloat(q)]),
      timestamp: normalizeTimestamp(msg.ts),
    };
  }

  protected parseTrades(raw: unknown): ExchangeRawTrade[] {
    const msg = raw as BybitWsMessage;
    const items = msg.data as BybitTradeItem[];

    if (!Array.isArray(items)) return [];

    return items.map((item): ExchangeRawTrade => {
      const price = parseFloat(item.p);
      const quantity = parseFloat(item.v);
      return {
        exchange: Exchange.BYBIT,
        id: `BYBIT_${item.i}`,
        symbol: this.currentSymbol,
        price,
        quantity,
        // Bybit: "Buy" = buyer is taker = BUY, "Sell" = seller is taker = SELL
        side: item.S === 'Buy' ? 'BUY' : 'SELL',
        timestamp: normalizeTimestamp(item.T),
      };
    });
  }

  protected parseLiquidation(raw: unknown): ExchangeRawLiquidation | null {
    const msg = raw as BybitWsMessage;
    const data = msg.data as BybitLiquidationData;
    if (!data || !data.price) return null;

    const price = parseFloat(data.price);
    const quantity = parseFloat(data.size);

    return {
      exchange: Exchange.BYBIT,
      symbol: this.currentSymbol,
      // Bybit liquidation side: "Buy" → short was liquidated, "Sell" → long was liquidated
      side: data.side === 'Buy' ? 'SHORT' : 'LONG',
      price,
      quantity,
      timestamp: normalizeTimestamp(data.updatedTime || msg.ts),
    };
  }

  protected parseOI(raw: unknown): ExchangeRawOI | null {
    const data = raw as BybitOIResponse;
    if (data.retCode !== 0 || !data.result?.list?.length) return null;

    const item = data.result.list[0];
    if (!item) return null;

    const oi = parseFloat(item.openInterest);
    const midPrice = this.getMidPrice();

    return {
      exchange: Exchange.BYBIT,
      symbol: this.currentSymbol,
      openInterest: oi,
      openInterestUsd: midPrice > 0 ? oi * midPrice : 0,
      timestamp: normalizeTimestamp(item.timestamp),
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Yardımcı
  // ─────────────────────────────────────────────────────────────────────────

  private resetBookState(): void {
    this.isBookSynced = false;
    this.lastSeq = -1;
    this.clearOrderBook();
  }

  private getMidPrice(): number {
    let bestBid = 0;
    let bestAsk = Infinity;

    for (const price of this.localBids.keys()) {
      if (price > bestBid) bestBid = price;
    }
    for (const price of this.localAsks.keys()) {
      if (price < bestAsk) bestAsk = price;
    }

    if (bestBid === 0 || bestAsk === Infinity) return 0;
    return (bestBid + bestAsk) / 2;
  }
}

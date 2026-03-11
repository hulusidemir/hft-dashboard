// ─────────────────────────────────────────────────────────────────────────────
// services/OkxService.ts — OKX V5 Public WebSocket & LOB Senkronizasyonu
// ─────────────────────────────────────────────────────────────────────────────
//
// OKX LOB senkronizasyonu Bybit'e benzer:
//   1. WS'ye abone ol → books-l2-tbt (tick-by-tick, 100 seviye)
//   2. action:"snapshot" → defteri sıfırla & doldur
//   3. action:"update"   → artımlı güncelle (qty="0" → sil)
//   4. OKX CRC32 checksum gönderir — performans için es geçiyoruz
//
// OKX V5 WS mesaj yapısı:
//   { arg: { channel, instId }, action: "snapshot"|"update", data: [...] }
//
// Kanal Eşlemesi:
//   books-l2-tbt        → LOB (tick-by-tick depth, 100 seviye)
//   trades              → Trades
//   liquidation-orders  → Liquidations
//
// OKX Fark Noktaları:
//   - instId formatı: "BTC-USDT-SWAP" (tire ayrımlı + SWAP)
//   - Miktar "kontrat" cinsinden gelir → base'e çevirmek için contractSize ile çarp
//   - Ping: OKX özel metin "ping" gönderilmesini bekler, "pong" ile yanıtlar
//   - OI: REST polling /api/v5/public/open-interest (2700ms staggered)
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
  getSymbolConfig,
  getExchangeSymbol,
  getExchangeRestSymbol,
  type SymbolConfig,
} from '../config/symbols.js';
import { normalizeTimestamp, hrNowMs } from '../utils/timestampUtils.js';

// ─── REST API Base URL ───────────────────────────────────────────────────────

const OKX_REST_BASE = 'https://www.okx.com';
const OKX_WS_URL    = 'wss://ws.okx.com:8443/ws/v5/public';

/** OI polling aralığı — staggered: OKX = 2700ms */
const OI_POLL_INTERVAL_MS = 2_700;

// ─── OKX WS Mesaj Tipleri (dahili) ──────────────────────────────────────────

/** OKX V5 genel WS mesaj zarfı */
interface OkxWsMessage {
  arg: {
    channel: string;
    instId: string;
    instType?: string;
  };
  action?: 'snapshot' | 'update';
  data: unknown[];
}

/** OKX subscribe/unsubscribe yanıtı */
interface OkxEventMessage {
  event: 'subscribe' | 'unsubscribe' | 'error' | 'login';
  arg?: Record<string, string>;
  code?: string;
  msg?: string;
  connId?: string;
}

/** OKX books-l2-tbt tek veri objesi */
interface OkxBookData {
  asks: [string, string, string, string][];  // [price, qty, 0, numOrders]
  bids: [string, string, string, string][];  // [price, qty, 0, numOrders]
  ts: string;          // Timestamp (ms string)
  checksum: number;    // CRC32 checksum — es geçilecek
  seqId: number;       // Sequence ID
  prevSeqId: number;   // Previous sequence ID
}

/** OKX trades tek veri objesi */
interface OkxTradeData {
  instId: string;
  tradeId: string;
  px: string;          // Price
  sz: string;          // Size (kontrat cinsinden)
  side: 'buy' | 'sell';
  ts: string;          // Timestamp
  count: string;       // Trade count
}

/** OKX liquidation-orders tek veri objesi */
interface OkxLiquidationData {
  instId: string;
  instType: string;
  totalLoss: string;
  details: Array<{
    side: 'buy' | 'sell';
    sz: string;        // Size (kontrat)
    px: string;        // Price
    ts: string;
    bkPx: string;      // Bankruptcy price
    bkLoss: string;
  }>;
}

/** OKX REST OI yanıtı */
interface OkxOIResponse {
  code: string;
  data: Array<{
    instId: string;
    instType: string;
    oi: string;        // Open interest (kontrat)
    oiCcy: string;     // OI in currency
    ts: string;
  }>;
}

// ─────────────────────────────────────────────────────────────────────────────
// OkxService
// ─────────────────────────────────────────────────────────────────────────────

export class OkxService extends BaseExchangeService {
  readonly exchange = Exchange.OKX;

  // ── LOB State ───────────────────────────────────────────────────────────

  /** Snapshot alındı mı? */
  private isBookSynced: boolean = false;

  /** Son işlenen sequence ID — süreklilik kontrolü */
  private lastSeqId: number = -1;

  /** OI polling zamanlayıcısı */
  private oiPollTimer: ReturnType<typeof setInterval> | null = null;

  /** OKX özel ping zamanı */
  private okxPingSentAt: number = 0;

  /** Sembol konfigürasyonu (contractSize vb. için cache) */
  private symbolConfig: SymbolConfig | null = null;

  // ─────────────────────────────────────────────────────────────────────────
  // Constructor
  // ─────────────────────────────────────────────────────────────────────────

  constructor() {
    super('OkxService');
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Abstract Implementasyonlar
  // ─────────────────────────────────────────────────────────────────────────

  protected buildWsUrl(_symbol: string): string {
    return OKX_WS_URL;
  }

  /**
   * OKX V5 subscribe mesajları.
   * Her kanal ayrı bir subscribe argümanı olarak gönderilir.
   */
  protected buildSubscribeMessages(symbol: string): object[] {
    const instId = getExchangeSymbol(symbol, Exchange.OKX); // "BTC-USDT-SWAP"
    return [{
      op: 'subscribe',
      args: [
        { channel: 'books-l2-tbt', instId },
        { channel: 'trades', instId },
        // Liquidation: LiquidationListener global liquidation-orders (instType:SWAP) kullanıyor.
        // Per-symbol stream OKX’te çalışmıyor (instId filtresi ignored) — burada kullanmıyoruz.
      ],
    }];
  }

  /**
   * OKX özel ping mekanizması: düz "ping" text frame gönderir.
   * OKX düz "pong" text ile yanıtlar (JSON değil!).
   */
  protected override sendPing(): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.okxPingSentAt = hrNowMs();
      this.ws.send('ping');
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // connect() Override — Config cache + OI polling
  // ─────────────────────────────────────────────────────────────────────────

  override async connect(symbol: string): Promise<void> {
    this.resetBookState();
    this.symbolConfig = getSymbolConfig(symbol);
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
      // OKX "pong" basit text olarak gelir — JSON parse edildikten sonra string olabilir
      if (data === 'pong' || (typeof data === 'string' && data === 'pong')) {
        this.handleOkxPong();
        return;
      }

      const msg = data as Record<string, unknown>;

      // ── Event yanıtı (subscribe/error) ────────────────────────────────
      if (msg['event']) {
        this.handleEventMessage(msg as unknown as OkxEventMessage);
        return;
      }

      // ── Veri mesajları — arg.channel'a göre yönlendir ─────────────────
      const arg = msg['arg'] as { channel?: string; instId?: string } | undefined;
      if (!arg || !arg.channel) return;

      const channel = arg.channel;

      switch (channel) {
        case 'books-l2-tbt':
        case 'books5':
          this.handleOrderBook(msg as unknown as OkxWsMessage);
          break;

        case 'trades':
          this.handleTrade(msg as unknown as OkxWsMessage);
          break;

        case 'liquidation-orders':
          this.handleLiquidation(msg as unknown as OkxWsMessage);
          break;

        default:
          this.log.debug('Bilinmeyen OKX kanal', { channel });
          break;
      }
    } catch (err) {
      this.log.error('handleMessage hatası', err instanceof Error ? err : new Error(String(err)));
    }
  }

  /**
   * Subscribe/error event yanıtlarını işler.
   */
  private handleEventMessage(msg: OkxEventMessage): void {
    if (msg.event === 'error') {
      this.log.error('OKX event hatası', {
        code: msg.code,
        msg: msg.msg,
      });
    } else if (msg.event === 'subscribe') {
      this.log.debug('OKX subscribe başarılı', { arg: msg.arg });
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // LOB Senkronizasyonu — Snapshot + Update
  // ─────────────────────────────────────────────────────────────────────────

  private handleOrderBook(msg: OkxWsMessage): void {
    try {
      if (!msg.data || msg.data.length === 0) return;
      const bookData = msg.data[0] as OkxBookData;

      if (msg.action === 'snapshot') {
        // Defteri sıfırla ve doldur
        this.isBookSynced = true;
        this.lastSeqId = bookData.seqId;

        const bids = this.parseOkxLevels(bookData.bids);
        const asks = this.parseOkxLevels(bookData.asks);
        this.applySnapshot(bids, asks);

        const snapshot = this.parseOrderBookSnapshot(msg);
        this.emit('orderbook_snapshot', snapshot);

        this.log.info('OKX LOB snapshot alındı', {
          seqId: bookData.seqId,
          bidLevels: bids.length,
          askLevels: asks.length,
        });

      } else if (msg.action === 'update') {
        if (!this.isBookSynced) {
          this.log.warn('Update geldi ama snapshot henüz alınmadı — atlanıyor');
          return;
        }

        // Sequence süreklilik kontrolü
        if (this.lastSeqId > 0 && bookData.prevSeqId !== this.lastSeqId) {
          this.log.error('OKX LOB sequence bozuldu! Yeniden bağlanma gerekli.', {
            expected_prevSeqId: this.lastSeqId,
            received_prevSeqId: bookData.prevSeqId,
            seqId: bookData.seqId,
          });
          this.resetBookState();
          this.disconnect();
          setTimeout(() => {
            this.connect(this.currentSymbol).catch(err => {
              this.log.error('Yeniden bağlanma hatası', err instanceof Error ? err : new Error(String(err)));
            });
          }, 100);
          return;
        }
        this.lastSeqId = bookData.seqId;

        const bids = this.parseOkxLevels(bookData.bids);
        const asks = this.parseOkxLevels(bookData.asks);
        this.applyDelta(bids, asks);

        const delta = this.parseOrderBookDelta(msg);
        this.emit('orderbook_delta', delta);
      }
    } catch (err) {
      this.log.error('OrderBook işleme hatası', err instanceof Error ? err : new Error(String(err)));
    }
  }

  /**
   * OKX seviye dizisini [price, qty] çiftlerine dönüştürür.
   * OKX format: [price_str, qty_str, deprecated "0", numOrders_str]
   * Miktar kontrat cinsinden gelir → contractSize ile çarpılarak base'e çevrilir.
   */
  private parseOkxLevels(levels: [string, string, string, string][]): [number, number][] {
    const contractSize = this.symbolConfig?.okxContractSize ?? 1;
    return levels.map(([p, q]) => {
      const price = parseFloat(p);
      const contracts = parseFloat(q);
      // Kontrat → base dönüşümü
      const quantity = contracts * contractSize;
      return [price, quantity];
    });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Trade İşleme
  // ─────────────────────────────────────────────────────────────────────────

  private handleTrade(msg: OkxWsMessage): void {
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
  // Liquidation İşleme
  // ─────────────────────────────────────────────────────────────────────────

  private handleLiquidation(msg: OkxWsMessage): void {
    try {
      const liq = this.parseLiquidation(msg);
      if (liq) {
        this.emit('liquidation', liq);
      }
    } catch (err) {
      this.log.error('Liquidation işleme hatası', err instanceof Error ? err : new Error(String(err)));
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // OKX Pong İşleme
  // ─────────────────────────────────────────────────────────────────────────

  private handleOkxPong(): void {
    if (this.okxPingSentAt > 0) {
      const rtt = hrNowMs() - this.okxPingSentAt;
      if (this.pingMs < 0) {
        this.pingMs = rtt;
      } else {
        this.pingMs = this.pingMs * 0.7 + rtt * 0.3;
      }
      this.pingMs = Math.round(this.pingMs * 100) / 100;
      this.emit('ping', this.pingMs);
    }
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
      const instId = getExchangeRestSymbol(symbol, Exchange.OKX);
      const url = `${OKX_REST_BASE}/api/v5/public/open-interest?instType=SWAP&instId=${instId}`;

      const response = await axios.get<OkxOIResponse>(url, { timeout: 5_000 });
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
  // Parser Metotları — Ham OKX → Normalize Format
  // ─────────────────────────────────────────────────────────────────────────

  protected parseOrderBookSnapshot(raw: unknown): ExchangeOrderBookSnapshot {
    const msg = raw as OkxWsMessage;
    const data = msg.data[0] as OkxBookData;

    return {
      exchange: Exchange.OKX,
      symbol: this.currentSymbol,
      lastUpdateId: data.seqId,
      bids: this.parseOkxLevels(data.bids),
      asks: this.parseOkxLevels(data.asks),
      timestamp: normalizeTimestamp(data.ts),
    };
  }

  protected parseOrderBookDelta(raw: unknown): ExchangeOrderBookDelta {
    const msg = raw as OkxWsMessage;
    const data = msg.data[0] as OkxBookData;

    return {
      exchange: Exchange.OKX,
      symbol: this.currentSymbol,
      firstUpdateId: data.prevSeqId,
      lastUpdateId: data.seqId,
      bids: this.parseOkxLevels(data.bids),
      asks: this.parseOkxLevels(data.asks),
      timestamp: normalizeTimestamp(data.ts),
    };
  }

  protected parseTrades(raw: unknown): ExchangeRawTrade[] {
    const msg = raw as OkxWsMessage;
    if (!msg.data || !Array.isArray(msg.data)) return [];

    const contractSize = this.symbolConfig?.okxContractSize ?? 1;

    return msg.data.map((item): ExchangeRawTrade => {
      const trade = item as OkxTradeData;
      const price = parseFloat(trade.px);
      const contracts = parseFloat(trade.sz);
      const quantity = contracts * contractSize;

      return {
        exchange: Exchange.OKX,
        id: `OKX_${trade.tradeId}`,
        symbol: this.currentSymbol,
        price,
        quantity,
        // OKX: "buy" = buyer is taker = BUY, "sell" = seller is taker = SELL
        side: trade.side === 'buy' ? 'BUY' : 'SELL',
        timestamp: normalizeTimestamp(trade.ts),
      };
    });
  }

  protected parseLiquidation(raw: unknown): ExchangeRawLiquidation | null {
    const msg = raw as OkxWsMessage;
    if (!msg.data || msg.data.length === 0) return null;

    const liqData = msg.data[0] as OkxLiquidationData;
    if (!liqData.details || liqData.details.length === 0) return null;

    // OKX liquidation-orders kanalı instType:SWAP ile abone olunduğunda
    // TÜM SWAP enstrümanlarının tasfiyelerini gönderir (instId filtresi çalışmaz!).
    // Sadece izlenen sembolün tasfiyelerini geçir, geri kalanını at.
    const expectedInstId = getExchangeSymbol(this.currentSymbol, Exchange.OKX);
    if (liqData.instId !== expectedInstId) return null;

    // OKX, tek bir mesajda birden fazla detail gönderebilir
    // Şimdilik en son detail'i al — aggregator zaten hepsini birleştirecek
    const detail = liqData.details[liqData.details.length - 1];
    if (!detail) return null;

    const contractSize = this.symbolConfig?.okxContractSize ?? 1;
    // OKX liquidation-orders kanalında px YOKTUR — bkPx (bankruptcy/tasfiye fiyatı) kullanılır
    const price = parseFloat(detail.bkPx);
    const contracts = parseFloat(detail.sz);
    const quantity = contracts * contractSize;  // base cinsinden miktar

    if (!price || price <= 0 || !quantity || quantity <= 0) return null;

    return {
      exchange: Exchange.OKX,
      symbol: this.currentSymbol,
      // OKX: "buy" side → short was liquidated, "sell" side → long was liquidated
      side: detail.side === 'buy' ? 'SHORT' : 'LONG',
      price,
      quantity,
      timestamp: normalizeTimestamp(detail.ts),
    };
  }

  protected parseOI(raw: unknown): ExchangeRawOI | null {
    const data = raw as OkxOIResponse;
    if (data.code !== '0' || !data.data?.length) return null;

    const item = data.data[0];
    if (!item) return null;

    const contractSize = this.symbolConfig?.okxContractSize ?? 1;
    const oiContracts = parseFloat(item.oi);
    const oiBase = oiContracts * contractSize;
    const midPrice = this.getMidPrice();

    return {
      exchange: Exchange.OKX,
      symbol: this.currentSymbol,
      openInterest: oiBase,
      openInterestUsd: midPrice > 0 ? oiBase * midPrice : 0,
      timestamp: normalizeTimestamp(item.ts),
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Yardımcı
  // ─────────────────────────────────────────────────────────────────────────

  private resetBookState(): void {
    this.isBookSynced = false;
    this.lastSeqId = -1;
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

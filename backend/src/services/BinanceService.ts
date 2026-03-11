// ─────────────────────────────────────────────────────────────────────────────
// services/BinanceService.ts — Binance Futures WebSocket & LOB Senkronizasyonu
// ─────────────────────────────────────────────────────────────────────────────
//
// Binance LOB senkronizasyonu, 3 borsa arasında en karmaşık olanıdır.
// Resmi dokümantasyondaki "How to manage a local order book correctly":
//
//   1. WS bağlan → depth@100ms kanalına abone ol
//   2. Gelen deltaları bir BUFFER'da biriktir (henüz deftere yazma!)
//   3. REST /fapi/v1/depth?limit=1000 snapshot'ı al → lastUpdateId kaydet
//   4. Buffer'daki eski deltaları (u < lastUpdateId) at
//   5. İlk geçerli delta: U <= lastUpdateId+1 VE u >= lastUpdateId+1
//   6. Sonraki her delta: pu === bir_önceki_delta.u olmalı (süreklilik kontrolü)
//   7. Eşleşmezse LOB bozuk → disconnect & reconnect
//
// Kanal Eşlemesi:
//   OrderBook Delta  → <symbol>@depth@100ms
//   Trades           → <symbol>@aggTrade
//   Liquidations     → <symbol>@forceOrder
//   OI               → REST polling /fapi/v1/openInterest (2000ms)
//
// ─────────────────────────────────────────────────────────────────────────────

import axios from 'axios';

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

// ─── REST API Base URL ───────────────────────────────────────────────────────

const BINANCE_REST_BASE = 'https://fapi.binance.com';
const BINANCE_WS_BASE   = 'wss://fstream.binance.com/ws/';

/** OI polling aralığı — staggered: Binance = 2000ms */
const OI_POLL_INTERVAL_MS = 2_000;

// ─── Binance WS Mesaj Tipleri (dahili) ───────────────────────────────────────

/** Binance depth delta mesajı */
interface BinanceDepthDelta {
  e: 'depthUpdate';
  E: number;         // Event time (ms)
  T: number;         // Transaction time (ms)
  s: string;         // Symbol
  U: number;         // First update ID in event
  u: number;         // Final update ID in event
  pu: number;        // Previous final update ID
  b: [string, string][];  // Bids — [price, qty] string çiftleri
  a: [string, string][];  // Asks — [price, qty] string çiftleri
}

/** Binance aggTrade mesajı */
interface BinanceAggTrade {
  e: 'aggTrade';
  E: number;         // Event time
  s: string;         // Symbol
  a: number;         // Aggregate trade ID
  p: string;         // Price
  q: string;         // Quantity
  f: number;         // First trade ID
  l: number;         // Last trade ID
  T: number;         // Trade time
  m: boolean;        // Is buyer the market maker? true → SELL, false → BUY
}

/** Binance forceOrder (liquidation) mesajı */
interface BinanceForceOrder {
  e: 'forceOrder';
  E: number;
  o: {
    s: string;       // Symbol
    S: 'BUY' | 'SELL';  // Side — BUY = short liq, SELL = long liq
    o: string;       // Order type
    f: string;       // Time in force
    q: string;       // Original quantity
    p: string;       // Price
    ap: string;      // Average price
    X: string;       // Order status
    l: string;       // Last filled qty
    z: string;       // Cumulative filled qty
    T: number;       // Trade time
  };
}

/** Binance REST depth snapshot yanıtı */
interface BinanceDepthSnapshot {
  lastUpdateId: number;
  E: number;         // Message output time
  T: number;         // Transaction time
  bids: [string, string][];
  asks: [string, string][];
}

/** Binance REST OI yanıtı */
interface BinanceOIResponse {
  symbol: string;
  openInterest: string;
  time: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// BinanceService
// ─────────────────────────────────────────────────────────────────────────────

export class BinanceService extends BaseExchangeService {
  readonly exchange = Exchange.BINANCE;

  // ── LOB Senkronizasyon State'i ──────────────────────────────────────────

  /** Snapshot alınana kadar deltaları biriktiren tampon */
  private deltaBuffer: BinanceDepthDelta[] = [];

  /** REST snapshot'tan gelen lastUpdateId */
  private snapshotLastUpdateId: number = -1;

  /** Snapshot alındı ve buffer işlendi mi? */
  private isBookSynced: boolean = false;

  /** Son başarılı işlenen deltanın u (final update ID) değeri — süreklilik kontrolü */
  private lastProcessedUpdateId: number = -1;

  /** Snapshot isteği devam ediyor mu? (mükerrer istek engelleme) */
  private isFetchingSnapshot: boolean = false;

  /**
   * Buffer'da ilk geçerli delta bulunamadıysa true.
   * WS'ten gelen ilk delta'nın Step 5 (straddle) kontrolünden geçmesi gerekir.
   */
  private needsFirstValidDelta: boolean = false;

  /** OI polling zamanlayıcısı */
  private oiPollTimer: ReturnType<typeof setInterval> | null = null;

  // ─────────────────────────────────────────────────────────────────────────
  // Constructor
  // ─────────────────────────────────────────────────────────────────────────

  constructor() {
    super('BinanceService');
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Abstract Implementasyonlar
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Binance combined stream URL'si:
   * wss://fstream.binance.com/ws/<stream1>/<stream2>/...
   */
  protected buildWsUrl(symbol: string): string {
    const bSymbol = getExchangeSymbol(symbol, Exchange.BINANCE); // "btcusdt"
    const streams = [
      `${bSymbol}@depth@100ms`,
      `${bSymbol}@aggTrade`,
      // Liquidation: LiquidationListener global !forceOrder@arr kullanıyor.
      // Per-symbol @forceOrder stream’i güvenilmez/gecikmeli — burada kullanmıyoruz.
    ];
    return `${BINANCE_WS_BASE}${streams.join('/')}`;
  }

  /**
   * Binance combined stream'de ayrıca subscribe göndermeye gerek yok —
   * URL'de stream adları zaten belirtildi. Boş dizi döndür.
   */
  protected buildSubscribeMessages(_symbol: string): object[] {
    // Combined stream → subscribe mesajı gerekmez
    return [];
  }

  // ─────────────────────────────────────────────────────────────────────────
  // connect() Override — Snapshot fetch'i tetikle + OI polling başlat
  // ─────────────────────────────────────────────────────────────────────────

  override async connect(symbol: string): Promise<void> {
    // LOB state'ini sıfırla
    this.resetBookState();

    // Üst sınıfın WS bağlantısını kur
    await super.connect(symbol);

    // WS açıldıktan sonra REST snapshot'ı arka planda al
    this.fetchAndApplySnapshot(symbol);

    // OI polling'i başlat
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
      const eventType = msg['e'] as string | undefined;

      if (!eventType) {
        // Binance bazen subscription confirmation veya error gönderir
        if (msg['result'] === null && typeof msg['id'] === 'number') {
          return; // Subscription ACK — yoksay
        }
        return;
      }

      switch (eventType) {
        case 'depthUpdate':
          this.handleDepthUpdate(msg as unknown as BinanceDepthDelta);
          break;

        case 'aggTrade':
          this.handleAggTrade(msg as unknown as BinanceAggTrade);
          break;

        case 'forceOrder':
          this.handleForceOrder(msg as unknown as BinanceForceOrder);
          break;

        default:
          this.log.debug('Bilinmeyen Binance event tipi', { e: eventType });
          break;
      }
    } catch (err) {
      this.log.error('handleMessage hatası', err instanceof Error ? err : new Error(String(err)));
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // LOB Senkronizasyon Algoritması
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Depth delta geldiğinde çağrılır.
   * Snapshot henüz alınmadıysa → buffer'a ekle.
   * Alındıysa → süreklilik kontrolü yap → deftere işle.
   */
  private handleDepthUpdate(delta: BinanceDepthDelta): void {
    // Adım 1: Snapshot alınmamışsa buffer'a biriktir
    if (!this.isBookSynced) {
      this.deltaBuffer.push(delta);
      // Buffer taşma koruması — çok uzun süre snapshot gelmezse
      if (this.deltaBuffer.length > 5000) {
        this.log.warn('Delta buffer taştı (5000+), snapshot bekleniyor...');
        this.deltaBuffer = this.deltaBuffer.slice(-2000);
      }
      return;
    }

    // Adım 5 (gecikmeli): Buffer'da ilk geçerli delta bulunamadıysa
    // WS'ten gelen deltayı Step 5 kriteriyle kontrol et
    if (this.needsFirstValidDelta) {
      const snapshotId = this.snapshotLastUpdateId;

      // Hâlâ eski delta — atla
      if (delta.u < snapshotId) {
        return;
      }

      // Straddle kontrolü: U <= snapshotId+1 VE u >= snapshotId+1
      if (delta.U <= snapshotId + 1 && delta.u >= snapshotId + 1) {
        this.needsFirstValidDelta = false;
        this.log.debug('WS\'ten ilk geçerli delta bulundu (buffer miss sonrası)', {
          delta_U: delta.U,
          delta_u: delta.u,
          snapshotId,
        });
        this.processDepthDelta(delta);
        return;
      }

      // Gap: delta snapshot'tan çok ileri — yeniden senkronize et
      if (delta.U > snapshotId + 1) {
        this.log.warn('WS delta boşluğu algılandı — yeniden senkronizasyon', {
          delta_U: delta.U,
          snapshotLastUpdateId: snapshotId,
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

      // delta.u >= snapshotId ama U > snapshotId+1 → uyumsuz, atla
      return;
    }

    // Adım 6: Süreklilik kontrolü — pu === lastProcessedUpdateId
    if (this.lastProcessedUpdateId > 0 && delta.pu !== this.lastProcessedUpdateId) {
      this.log.error('LOB süreklilik bozuldu! Yeniden senkronizasyon gerekli.', {
        expected_pu: this.lastProcessedUpdateId,
        received_pu: delta.pu,
        delta_U: delta.U,
        delta_u: delta.u,
      });
      // Bağlantıyı kes — BaseExchangeService otomatik reconnect yapacak
      this.resetBookState();
      this.disconnect();
      // Yeniden bağlanmayı tetikle
      setTimeout(() => {
        this.connect(this.currentSymbol).catch(err => {
          this.log.error('Yeniden bağlanma hatası', err instanceof Error ? err : new Error(String(err)));
        });
      }, 100);
      return;
    }

    // Deltayı işle
    this.processDepthDelta(delta);
  }

  /**
   * REST snapshot alır, buffer'daki deltaları filtreler ve LOB'u senkronize eder.
   */
  private async fetchAndApplySnapshot(symbol: string): Promise<void> {
    if (this.isFetchingSnapshot) return;
    this.isFetchingSnapshot = true;

    try {
      const restSymbol = getExchangeRestSymbol(symbol, Exchange.BINANCE);
      const url = `${BINANCE_REST_BASE}/fapi/v1/depth?symbol=${restSymbol}&limit=1000`;

      this.log.info('REST snapshot isteniyor...', { url });

      const response = await axios.get<BinanceDepthSnapshot>(url, {
        timeout: 10_000,
      });

      const snapshot = response.data;
      const snapshotUpdateId = snapshot.lastUpdateId;

      this.log.info('REST snapshot alındı', {
        lastUpdateId: snapshotUpdateId,
        bidLevels: snapshot.bids.length,
        askLevels: snapshot.asks.length,
        bufferedDeltas: this.deltaBuffer.length,
      });

      // Adım 3: Snapshot'ı yerel deftere yaz
      this.snapshotLastUpdateId = snapshotUpdateId;
      const bids: [number, number][] = snapshot.bids.map(([p, q]) => [parseFloat(p), parseFloat(q)]);
      const asks: [number, number][] = snapshot.asks.map(([p, q]) => [parseFloat(p), parseFloat(q)]);
      this.applySnapshot(bids, asks);

      // Snapshot event'i emit et
      const snapshotEvent = this.parseOrderBookSnapshot(snapshot);
      this.emit('orderbook_snapshot', snapshotEvent);

      // Adım 4 & 5: Buffer'daki deltaları filtrele ve işle
      this.processBufferedDeltas();

      this.isBookSynced = true;
      this.log.info('LOB senkronizasyonu tamamlandı', {
        lastProcessedUpdateId: this.lastProcessedUpdateId,
        bidLevels: this.localBids.size,
        askLevels: this.localAsks.size,
      });

    } catch (err) {
      this.log.error('REST snapshot alma hatası', err instanceof Error ? err : new Error(String(err)));
      this.isFetchingSnapshot = false;
      // 1 saniye sonra tekrar dene
      setTimeout(() => {
        this.fetchAndApplySnapshot(symbol).catch(() => {});
      }, 1000);
      return;
    }

    this.isFetchingSnapshot = false;
  }

  /**
   * Buffer'daki deltaları Binance algoritmasına göre filtreler ve sırayla işler.
   *
   * Adım 4: u < snapshotLastUpdateId → at (eski delta)
   * Adım 5: İlk geçerli delta → U <= snapshotLastUpdateId+1 VE u >= snapshotLastUpdateId+1
   */
  private processBufferedDeltas(): void {
    const snapshotId = this.snapshotLastUpdateId;
    let foundFirst = false;

    for (const delta of this.deltaBuffer) {
      // Adım 4: Eski deltaları atla
      if (delta.u < snapshotId) {
        continue;
      }

      // Adım 5: İlk geçerli deltayı bul
      if (!foundFirst) {
        // U <= snapshotLastUpdateId+1 VE u >= snapshotLastUpdateId+1
        if (delta.U <= snapshotId + 1 && delta.u >= snapshotId + 1) {
          foundFirst = true;
          this.processDepthDelta(delta);
        } else if (delta.U > snapshotId + 1) {
          // Snapshot çok eski — buffer'da boşluk var. Yeniden snapshot al.
          this.log.warn('Buffer boşluğu algılandı — snapshot yenileniyor', {
            delta_U: delta.U,
            snapshotLastUpdateId: snapshotId,
          });
          this.resetBookState();
          this.fetchAndApplySnapshot(this.currentSymbol).catch(() => {});
          return;
        }
        // else: delta.u >= snapshotId ama U > snapshotId+1 → uyumsuz, atla
        continue;
      }

      // Adım 6: Sonraki deltalar — süreklilik kontrolü
      if (delta.pu !== this.lastProcessedUpdateId) {
        this.log.error('Buffer içinde süreklilik bozulması!', {
          expected_pu: this.lastProcessedUpdateId,
          received_pu: delta.pu,
        });
        this.resetBookState();
        this.fetchAndApplySnapshot(this.currentSymbol).catch(() => {});
        return;
      }

      this.processDepthDelta(delta);
    }

    // Buffer'ı temizle — artık ihtiyaç yok
    this.deltaBuffer = [];

    if (!foundFirst) {
      // Buffer'da hiç geçerli delta bulunamadı — sorun değil, yeni deltalar WS'ten gelecek.
      // lastProcessedUpdateId'yi snapshot'ın ID'sine set et
      this.lastProcessedUpdateId = snapshotId;
      this.needsFirstValidDelta = true;
      this.log.debug('Buffer\'da geçerli delta bulunamadı, WS\'ten ilk geçerli delta bekleniyor', {
        lastProcessedUpdateId: this.lastProcessedUpdateId,
      });
    }
  }

  /**
   * Tek bir depth deltasını yerel deftere işler ve event emit eder.
   */
  private processDepthDelta(delta: BinanceDepthDelta): void {
    const bids: [number, number][] = delta.b.map(([p, q]) => [parseFloat(p), parseFloat(q)]);
    const asks: [number, number][] = delta.a.map(([p, q]) => [parseFloat(p), parseFloat(q)]);

    this.applyDelta(bids, asks);
    this.lastProcessedUpdateId = delta.u;

    // Normalized delta event
    const normalized = this.parseOrderBookDelta(delta);
    this.emit('orderbook_delta', normalized);
  }

  /**
   * LOB state'ini tamamen sıfırlar. Yeni senkronizasyon döngüsüne hazırlar.
   */
  private resetBookState(): void {
    this.deltaBuffer = [];
    this.snapshotLastUpdateId = -1;
    this.isBookSynced = false;
    this.lastProcessedUpdateId = -1;
    this.isFetchingSnapshot = false;
    this.needsFirstValidDelta = false;
    this.clearOrderBook();
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Trade İşleme
  // ─────────────────────────────────────────────────────────────────────────

  private handleAggTrade(msg: BinanceAggTrade): void {
    try {
      const trades = this.parseTrades(msg);
      if (trades.length > 0) {
        this.emit('trade', trades);
      }
    } catch (err) {
      this.log.error('aggTrade işleme hatası', err instanceof Error ? err : new Error(String(err)));
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Liquidation İşleme
  // ─────────────────────────────────────────────────────────────────────────

  private handleForceOrder(msg: BinanceForceOrder): void {
    try {
      const liq = this.parseLiquidation(msg);
      if (liq) {
        this.emit('liquidation', liq);
      }
    } catch (err) {
      this.log.error('forceOrder işleme hatası', err instanceof Error ? err : new Error(String(err)));
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Open Interest REST Polling
  // ─────────────────────────────────────────────────────────────────────────

  private startOIPolling(symbol: string): void {
    this.stopOIPolling();

    // İlk polling'i hemen yap
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
      const restSymbol = getExchangeRestSymbol(symbol, Exchange.BINANCE);
      const url = `${BINANCE_REST_BASE}/fapi/v1/openInterest?symbol=${restSymbol}`;

      const response = await axios.get<BinanceOIResponse>(url, { timeout: 5_000 });
      const oi = this.parseOI(response.data);
      if (oi) {
        this.emit('open_interest', oi);
      }
    } catch (err) {
      // 429 rate limit veya ağ hatası — logla ama servisi durdurma
      this.log.warn('OI polling hatası', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Parser Metotları — Ham Binance → Normalize Format
  // ─────────────────────────────────────────────────────────────────────────

  protected parseOrderBookSnapshot(raw: unknown): ExchangeOrderBookSnapshot {
    const data = raw as BinanceDepthSnapshot;
    return {
      exchange: Exchange.BINANCE,
      symbol: this.currentSymbol,
      lastUpdateId: data.lastUpdateId,
      bids: data.bids.map(([p, q]) => [parseFloat(p), parseFloat(q)]),
      asks: data.asks.map(([p, q]) => [parseFloat(p), parseFloat(q)]),
      timestamp: normalizeTimestamp(data.E || Date.now()),
    };
  }

  protected parseOrderBookDelta(raw: unknown): ExchangeOrderBookDelta {
    const data = raw as BinanceDepthDelta;
    return {
      exchange: Exchange.BINANCE,
      symbol: this.currentSymbol,
      firstUpdateId: data.U,
      lastUpdateId: data.u,
      bids: data.b.map(([p, q]) => [parseFloat(p), parseFloat(q)]),
      asks: data.a.map(([p, q]) => [parseFloat(p), parseFloat(q)]),
      timestamp: normalizeTimestamp(data.E),
    };
  }

  protected parseTrades(raw: unknown): ExchangeRawTrade[] {
    const data = raw as BinanceAggTrade;
    const price = parseFloat(data.p);
    const quantity = parseFloat(data.q);
    return [{
      exchange: Exchange.BINANCE,
      id: `BINANCE_${data.a}`,
      symbol: this.currentSymbol,
      price,
      quantity,
      // m === true → buyer is market maker → taker is SELLER
      // m === false → buyer is taker → BUY
      side: data.m ? 'SELL' : 'BUY',
      timestamp: normalizeTimestamp(data.T),
    }];
  }

  protected parseLiquidation(raw: unknown): ExchangeRawLiquidation | null {
    const data = raw as BinanceForceOrder;
    const order = data.o;
    if (!order) return null;

    // Global !forceOrder@arr stream'den geliyoruz — sembol filtrele
    const expectedSymbol = getExchangeRestSymbol(this.currentSymbol, Exchange.BINANCE);
    if (order.s !== expectedSymbol) return null;

    // ap = average fill price (gerçek dolum fiyatı)
    // p  = order price (iflas/tasfiye emri fiyatı — piyasa fiyatına yakın ama tam değil)
    // FILLED → ap kullan; NEW → p fallback (yaklaşık ama sıfırdan iyi)
    const avgPrice = parseFloat(order.ap);
    const orderPrice = parseFloat(order.p);
    const price = (avgPrice && avgPrice > 0) ? avgPrice : orderPrice;
    if (!price || price <= 0) return null;

    // z = dolan miktar (gerçek), q = orijinal emir miktarı
    const quantity = parseFloat(order.z) || parseFloat(order.q);
    if (quantity <= 0) return null;

    return {
      exchange: Exchange.BINANCE,
      symbol: this.currentSymbol,
      // BUY side on liquidation → short was liquidated
      // SELL side on liquidation → long was liquidated
      side: order.S === 'BUY' ? 'SHORT' : 'LONG',
      price,
      quantity,
      timestamp: normalizeTimestamp(order.T || data.E),
    };
  }

  protected parseOI(raw: unknown): ExchangeRawOI | null {
    const data = raw as BinanceOIResponse;
    if (!data.openInterest) return null;

    const oi = parseFloat(data.openInterest);
    // Binance OI base cinsinden gelir — USD yaklaşımı için midPrice kullan
    const midPrice = this.getMidPrice();

    return {
      exchange: Exchange.BINANCE,
      symbol: this.currentSymbol,
      openInterest: oi,
      openInterestUsd: midPrice > 0 ? oi * midPrice : 0,
      timestamp: normalizeTimestamp(data.time || Date.now()),
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Yardımcı
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Yerel defterden mid price hesaplar (OI USD dönüşümü için).
   * Defter boşsa 0 döndürür.
   */
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

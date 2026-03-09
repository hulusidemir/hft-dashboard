// ─────────────────────────────────────────────────────────────────────────────
// services/base/BaseExchangeService.ts — Soyut Borsa Servis Temeli
// ─────────────────────────────────────────────────────────────────────────────
//
// Bu sınıf, 3 borsa servisinin (Binance, Bybit, OKX) ortak davranışlarını
// tek bir yerde toplar. Alt sınıflar SADECE borsaya özgü parse/build
// metotlarını implemente eder; bağlantı yönetimi tamamen burada yaşar.
//
// Sorumluluklar:
//   1. WebSocket bağlantı yaşam döngüsü (connect, disconnect, reconnect)
//   2. Exponential backoff ile yeniden bağlanma (100ms → max 5s)
//   3. Ping/Pong gecikme ölçümü (3 saniye aralıkla)
//   4. Yerel emir defteri (localBids, localAsks) Map yönetimi
//   5. Hata yakalama — bozuk JSON tüm sistemi çökertmez
//
// ─────────────────────────────────────────────────────────────────────────────

import { EventEmitter } from 'node:events';
import WebSocket from 'ws';

import type {
  IExchangeService,
  ExchangeOrderBookSnapshot,
  ExchangeOrderBookDelta,
  ExchangeRawTrade,
  ExchangeRawLiquidation,
  ExchangeRawOI,
} from '../../interfaces/IExchangeService.js';
import { Exchange } from '../../interfaces/IExchangeService.js';
import { Logger } from '../../utils/logger.js';
import { hrNowMs } from '../../utils/timestampUtils.js';

// ─── Yapılandırma Sabitleri ──────────────────────────────────────────────────

/** Yeniden bağlanma için başlangıç bekleme süresi (ms) */
const RECONNECT_BASE_MS = 100;

/** Yeniden bağlanma için maksimum bekleme süresi (ms) */
const RECONNECT_MAX_MS = 5_000;

/** Yeniden bağlanma üstel büyüme çarpanı */
const RECONNECT_MULTIPLIER = 2;

/** Ping gönderme aralığı (ms) */
const PING_INTERVAL_MS = 3_000;

/** Pong cevabı için zaman aşımı (ms) — bu sürede gelmezse bağlantı kopuk sayılır */
const PONG_TIMEOUT_MS = 5_000;

/** Maksimum ardışık yeniden bağlanma denemesi — aşılırsa servis duraklar */
const MAX_RECONNECT_ATTEMPTS = 50;

// ─── Soyut Temel Sınıf ──────────────────────────────────────────────────────

export abstract class BaseExchangeService extends EventEmitter implements IExchangeService {
  // ── Genel Sınıf Alanları ────────────────────────────────────────────────

  /** Bu servisin temsil ettiği borsa — alt sınıfta atanır */
  abstract readonly exchange: Exchange;

  /** En son ölçülen round-trip gecikme (ms) */
  pingMs: number = -1;

  /** Aktif WebSocket bağlantısı */
  protected ws: WebSocket | null = null;

  /**
   * Yerel emir defteri — BID tarafı.
   * Key: fiyat (number), Value: miktar (number).
   * Her borsa kendi yerel defterini burada tutar.
   * Aggregator bu Map'leri okuyarak birleştirilmiş defter oluşturur.
   */
  readonly localBids: Map<number, number> = new Map();

  /**
   * Yerel emir defteri — ASK tarafı.
   * Key: fiyat (number), Value: miktar (number).
   */
  readonly localAsks: Map<number, number> = new Map();

  /** Bağlantı durumu */
  private _isConnected: boolean = false;

  get isConnected(): boolean {
    return this._isConnected;
  }

  /** Bağlı sembol */
  protected currentSymbol: string = '';

  /** Ardışık yeniden bağlanma sayacı */
  private reconnectAttempts: number = 0;

  /** Yeniden bağlanma zamanlayıcısı */
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  /** Ping döngüsü zamanlayıcısı */
  private pingTimer: ReturnType<typeof setInterval> | null = null;

  /** Pong bekleme zamanlayıcısı */
  private pongTimer: ReturnType<typeof setTimeout> | null = null;

  /** Son ping gönderme zamanı (hrtime — gecikme hesabı için) */
  private lastPingSentAt: number = 0;

  /** Bağlantı kasıtlı olarak mı kapatıldı? */
  private intentionalClose: boolean = false;

  /** Modül logger'ı — alt sınıf adıyla oluşturulur */
  protected readonly log: Logger;

  // ── Constructor ─────────────────────────────────────────────────────────

  constructor(logTag: string) {
    super();
    // EventEmitter sınırsız listener uyarısını bastır
    this.setMaxListeners(50);
    this.log = new Logger(logTag);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Soyut Metotlar — Alt sınıflar ZORUNLU implemente eder
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Bu borsanın WebSocket URL'sini oluşturur.
   * @param symbol Normalize edilmiş sembol (örn: "BTCUSDT")
   */
  protected abstract buildWsUrl(symbol: string): string;

  /**
   * WS bağlantısı açıldıktan sonra gönderilecek abone (subscribe) mesajlarını döndürür.
   * Her mesaj JSON.stringify ile serialzie edilip gönderilir.
   * @param symbol Normalize edilmiş sembol
   */
  protected abstract buildSubscribeMessages(symbol: string): object[];

  /**
   * Gelen ham WS mesajını ayrıştırır ve ilgili event'i emit eder.
   * Her borsa kendi JSON yapısına göre implemente eder.
   * Bu metot try/catch ile korunur — fırlatılan hatalar sistemi çökertmez.
   * @param data Parse edilmiş JSON objesi
   */
  protected abstract handleMessage(data: unknown): void;

  /**
   * Borsa-spesifik order book snapshot ayrıştırması.
   * REST API'den alınan snapshot verisi bu metotla normalize edilir.
   */
  protected abstract parseOrderBookSnapshot(raw: unknown): ExchangeOrderBookSnapshot;

  /**
   * Borsa-spesifik order book delta (güncelleme) ayrıştırması.
   * WS'ten gelen artımlı güncellemeler bu metotla normalize edilir.
   */
  protected abstract parseOrderBookDelta(raw: unknown): ExchangeOrderBookDelta;

  /**
   * Borsa-spesifik trade ayrıştırması.
   * Bir WS mesajında birden fazla trade olabilir — dizi döndürür.
   */
  protected abstract parseTrades(raw: unknown): ExchangeRawTrade[];

  /**
   * Borsa-spesifik tasfiye (liquidation) ayrıştırması.
   * Her borsanın tasfiye kanalı farklı format kullanır.
   * Null döndürülürse mesaj atlanır (tanınmayan format).
   */
  protected abstract parseLiquidation(raw: unknown): ExchangeRawLiquidation | null;

  /**
   * Borsa-spesifik açık pozisyon (OI) ayrıştırması.
   * OI genellikle REST polling ile gelir ama bazı borsalar WS de sunar.
   * Null döndürülürse mesaj atlanır.
   */
  protected abstract parseOI(raw: unknown): ExchangeRawOI | null;

  /**
   * Borsaya özgü WS ping mekanizması.
   * Bazı borsalar (OKX) özel ping frame'i ister, bazıları (Binance) standart
   * WebSocket ping/pong kullanır. Alt sınıf kendi mekanizmasını tanımlar.
   *
   * Varsayılan davranış: standart WS ping frame gönderir.
   * Bu metodu override etmeye gerek yoksa üst sınıftaki varsayılan kalır.
   */
  protected sendPing(): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.lastPingSentAt = hrNowMs();
      this.ws.ping();
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Genel (Public) Bağlantı Yönetimi
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Belirtilen sembol için WebSocket bağlantısını açar ve kanallara abone olur.
   * Bağlantı başarılı olduğunda 'connected' event'i emit eder.
   *
   * @param symbol Normalize edilmiş sembol (örn: "BTCUSDT")
   */
  async connect(symbol: string): Promise<void> {
    // Önceki bağlantı varsa temizle
    if (this.ws) {
      this.disconnect();
    }

    this.currentSymbol = symbol;
    this.intentionalClose = false;
    this.reconnectAttempts = 0;

    return this.establishConnection();
  }

  /**
   * Bağlantıyı temiz bir şekilde kapatır.
   * Yeniden bağlanma tetiklenmez.
   */
  disconnect(): void {
    this.intentionalClose = true;
    this.cleanup();
    this.log.info('Bağlantı kasıtlı olarak kapatıldı', {
      symbol: this.currentSymbol,
    });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Dahili (Private) Bağlantı Mekanizması
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * WebSocket bağlantısını fiilen kurar.
   * Tüm event listener'ları bağlar.
   */
  private establishConnection(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      try {
        const url = this.buildWsUrl(this.currentSymbol);
        this.log.info('WebSocket bağlantısı açılıyor...', { url, symbol: this.currentSymbol });

        this.ws = new WebSocket(url, {
          // Performans optimizasyonları
          perMessageDeflate: false,   // Sıkıştırma kapalı — CPU tasarrufu
          skipUTF8Validation: true,   // UTF8 doğrulaması kapalı — parse hızı
          handshakeTimeout: 10_000,   // 10s el sıkışma zaman aşımı
        });

        // ── onopen ──────────────────────────────────────────────────────

        this.ws.on('open', () => {
          this._isConnected = true;
          this.reconnectAttempts = 0;
          this.log.info('WebSocket bağlantısı kuruldu', {
            symbol: this.currentSymbol,
          });

          // Kanallara abone ol
          this.sendSubscriptions();

          // Ping döngüsünü başlat
          this.startPingInterval();

          this.emit('connected');
          resolve();
        });

        // ── onmessage ───────────────────────────────────────────────────

        this.ws.on('message', (raw: WebSocket.RawData, _isBinary: boolean) => {
          let text = '';
          try {
            // RawData = Buffer | ArrayBuffer | Buffer[]
            // Hızlı dönüşüm: tüm varyantları UTF-8 stringe çevir
            if (Buffer.isBuffer(raw)) {
              text = raw.toString('utf-8');
            } else if (raw instanceof ArrayBuffer) {
              text = Buffer.from(raw).toString('utf-8');
            } else if (Array.isArray(raw)) {
              text = Buffer.concat(raw).toString('utf-8');
            } else {
              text = String(raw);
            }

            // OKX düz "pong" text frame gönderir — JSON değil, parse'a sokmadan
            // handleMessage'a ilet. Subclass (OkxService) bunu tanıyıp işler.
            if (text === 'pong') {
              this.handleMessage(text);
              return;
            }

            const data: unknown = JSON.parse(text);
            this.handleMessage(data);
          } catch (err) {
            // Bozuk JSON tüm servisi çökertmez — logla ve devam et
            this.log.warn('Mesaj ayrıştırma hatası', {
              error: err instanceof Error ? err.message : String(err),
              rawPreview: text.slice(0, 200) || '[empty]',
            });
          }
        });

        // ── onpong ──────────────────────────────────────────────────────

        this.ws.on('pong', () => {
          this.handlePongReceived();
        });

        // ── onerror ─────────────────────────────────────────────────────

        this.ws.on('error', (err: Error) => {
          this.log.error('WebSocket hatası', err);
          this.emit('error', err);

          // İlk bağlantı denemesinde hata → Promise'ı reject et
          if (!this._isConnected) {
            reject(err);
          }
        });

        // ── onclose ─────────────────────────────────────────────────────

        this.ws.on('close', (code: number, reason: Buffer) => {
          const reasonStr = reason.toString('utf-8') || `code=${code}`;
          this._isConnected = false;

          this.log.warn('WebSocket bağlantısı kapandı', {
            code,
            reason: reasonStr,
            intentional: this.intentionalClose,
          });

          this.emit('disconnected', reasonStr);

          // Ping zamanlayıcılarını temizle
          this.stopPingInterval();

          // Kasıtlı kapatma değilse yeniden bağlan
          if (!this.intentionalClose) {
            this.scheduleReconnect();
          }
        });

      } catch (err) {
        this.log.error('Bağlantı oluşturma hatası', err instanceof Error ? err : new Error(String(err)));
        reject(err);
      }
    });
  }

  /**
   * Abone (subscribe) mesajlarını WebSocket üzerinden gönderir.
   */
  private sendSubscriptions(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    try {
      const messages = this.buildSubscribeMessages(this.currentSymbol);
      for (const msg of messages) {
        this.ws.send(JSON.stringify(msg));
      }
      this.log.debug('Abone mesajları gönderildi', { count: messages.length });
    } catch (err) {
      this.log.error('Abone mesajı gönderme hatası', err instanceof Error ? err : new Error(String(err)));
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Ping / Pong Gecikme Ölçümü
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Periyodik ping gönderimini başlatır (varsayılan: 3 saniye).
   * Her ping'in ardından pong bekleme zamanlayıcısı kurulur.
   */
  private startPingInterval(): void {
    this.stopPingInterval();

    this.pingTimer = setInterval(() => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

      // Pong zaman aşımı kontrolü — önceki pong gelmemişse bağlantı kopuk
      this.pongTimer = setTimeout(() => {
        this.log.warn('Pong zaman aşımı — bağlantı kopuk sayılıyor', {
          timeoutMs: PONG_TIMEOUT_MS,
        });
        // Bağlantıyı zorla kapat → onclose tetiklenir → reconnect başlar
        this.ws?.terminate();
      }, PONG_TIMEOUT_MS);

      this.sendPing();
    }, PING_INTERVAL_MS);
  }

  /**
   * Ping zamanlayıcılarını durdurur. Bağlantı kapandığında çağrılır.
   */
  private stopPingInterval(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    if (this.pongTimer) {
      clearTimeout(this.pongTimer);
      this.pongTimer = null;
    }
  }

  /**
   * Pong frame'i alındığında çağrılır.
   * Round-trip gecikmeyi hesaplar ve 'ping' event'i emit eder.
   */
  protected handlePongReceived(): void {
    // Pong zaman aşımını temizle
    if (this.pongTimer) {
      clearTimeout(this.pongTimer);
      this.pongTimer = null;
    }

    if (this.lastPingSentAt > 0) {
      const rtt = hrNowMs() - this.lastPingSentAt;
      // Basit üstel hareketli ortalama (EMA) — ani spike'ları yumuşatır
      if (this.pingMs < 0) {
        this.pingMs = rtt;
      } else {
        this.pingMs = this.pingMs * 0.7 + rtt * 0.3;
      }
      this.pingMs = Math.round(this.pingMs * 100) / 100; // 2 ondalık

      this.emit('ping', this.pingMs);
      this.log.debug('Ping ölçüldü', { rttMs: rtt.toFixed(2), avgMs: this.pingMs });
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Yeniden Bağlanma — Exponential Backoff
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Exponential backoff ile yeniden bağlanma zamanlar.
   *
   * Formül: delay = min(BASE * 2^attempt, MAX)
   *   attempt 0 →  100ms
   *   attempt 1 →  200ms
   *   attempt 2 →  400ms
   *   attempt 3 →  800ms
   *   attempt 4 → 1600ms
   *   attempt 5 → 3200ms
   *   attempt 6 → 5000ms (max)
   *
   * Jitter eklenir: ±%20 rastgele varyans — "thundering herd" sorununu önler.
   */
  private scheduleReconnect(): void {
    if (this.intentionalClose) return;
    if (this.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      this.log.fatal('Maksimum yeniden bağlanma denemesi aşıldı — servis durdu', {
        attempts: this.reconnectAttempts,
        maxAttempts: MAX_RECONNECT_ATTEMPTS,
      });
      this.emit('error', new Error(
        `[${this.exchange}] ${MAX_RECONNECT_ATTEMPTS} yeniden bağlanma denemesi başarısız oldu`
      ));
      return;
    }

    // Üstel bekleme süresi hesapla
    const baseDelay = RECONNECT_BASE_MS * Math.pow(RECONNECT_MULTIPLIER, this.reconnectAttempts);
    const clampedDelay = Math.min(baseDelay, RECONNECT_MAX_MS);

    // ±%20 jitter
    const jitter = clampedDelay * 0.2 * (Math.random() * 2 - 1);
    const finalDelay = Math.max(0, Math.round(clampedDelay + jitter));

    this.reconnectAttempts++;

    this.log.info('Yeniden bağlanma zamanlandı', {
      attempt: this.reconnectAttempts,
      maxAttempts: MAX_RECONNECT_ATTEMPTS,
      delayMs: finalDelay,
    });

    this.reconnectTimer = setTimeout(async () => {
      try {
        await this.establishConnection();
      } catch (err) {
        this.log.error('Yeniden bağlanma başarısız', err instanceof Error ? err : new Error(String(err)));
        // Başarısız → tekrar zamanla (onclose da tetikler ama güvenlik katmanı)
        if (!this.intentionalClose) {
          this.scheduleReconnect();
        }
      }
    }, finalDelay);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Yerel Emir Defteri Yönetimi
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * REST API'den alınan snapshot ile yerel defteri sıfırdan yükler.
   * Mevcut veriler tamamen silinir ve yeniden yazılır.
   *
   * @param bids [fiyat, miktar] çiftleri
   * @param asks [fiyat, miktar] çiftleri
   */
  protected applySnapshot(
    bids: [price: number, qty: number][],
    asks: [price: number, qty: number][],
  ): void {
    this.localBids.clear();
    this.localAsks.clear();

    for (const [price, qty] of bids) {
      if (qty > 0) {
        this.localBids.set(price, qty);
      }
    }

    for (const [price, qty] of asks) {
      if (qty > 0) {
        this.localAsks.set(price, qty);
      }
    }

    this.log.debug('Snapshot uygulandı', {
      bidLevels: this.localBids.size,
      askLevels: this.localAsks.size,
    });
  }

  /**
   * WS'ten gelen artımlı güncellemeyi (delta) yerel deftere işler.
   * Kural: miktar = 0 → o fiyat kademesini sil, > 0 → güncelle/ekle.
   *
   * @param bids [fiyat, yeni_miktar] çiftleri
   * @param asks [fiyat, yeni_miktar] çiftleri
   */
  protected applyDelta(
    bids: [price: number, qty: number][],
    asks: [price: number, qty: number][],
  ): void {
    for (const [price, qty] of bids) {
      if (qty === 0) {
        this.localBids.delete(price);
      } else {
        this.localBids.set(price, qty);
      }
    }

    for (const [price, qty] of asks) {
      if (qty === 0) {
        this.localAsks.delete(price);
      } else {
        this.localAsks.set(price, qty);
      }
    }
  }

  /**
   * Yerel emir defterini tamamen temizler.
   * Sembol değişikliğinde veya snapshot öncesinde çağrılır.
   */
  protected clearOrderBook(): void {
    this.localBids.clear();
    this.localAsks.clear();
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Temizlik (Cleanup)
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Tüm zamanlayıcıları temizler ve WebSocket'i kapatır.
   * Bellek sızıntılarını önler.
   */
  private cleanup(): void {
    // Zamanlayıcıları durdur
    this.stopPingInterval();

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    // WebSocket'i kapat
    if (this.ws) {
      try {
        // Listener'ları kaldır — onclose'un tekrar reconnect tetiklemesini engelle
        this.ws.removeAllListeners();
        if (this.ws.readyState === WebSocket.OPEN ||
            this.ws.readyState === WebSocket.CONNECTING) {
          this.ws.close(1000, 'Intentional disconnect');
        }
        this.ws.terminate();
      } catch {
        // Kapatma sırasında hata olabilir — yoksay
      }
      this.ws = null;
    }

    this._isConnected = false;

    // Yerel defteri temizle
    this.clearOrderBook();

    // Ping istatistiğini sıfırla
    this.pingMs = -1;
    this.lastPingSentAt = 0;
  }
}

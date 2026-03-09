// ─────────────────────────────────────────────────────────────────────────────
// RadarService.ts — Global Piyasa Tarayıcı (Screener)
// Bybit V5 /market/tickers?category=linear → 10s polling
// Top 15 by turnover24h + Top movers by price24hPcnt
// Hafif REST-only servis — sıfır WebSocket bağlantısı
// ─────────────────────────────────────────────────────────────────────────────

import axios from 'axios';
import { Logger } from '../utils/logger.js';

const log = new Logger('RadarService');

// ── Types ────────────────────────────────────────────────────────────────────
export interface RadarTicker {
  symbol:        string;   // BTCUSDT
  lastPrice:     number;
  price24hPcnt:  number;   // -0.0312 = -%3.12
  turnover24h:   number;   // 24h USDT hacim
  volume24h:     number;   // 24h kontrat hacim
  highPrice24h:  number;
  lowPrice24h:   number;
  openInterest:  number;
  fundingRate:   number;
}

export interface HotTargets {
  topVolume:  RadarTicker[];  // Turnover sıralı ilk 15
  topGainers: RadarTicker[];  // En çok yükselen 10
  topLosers:  RadarTicker[];  // En çok düşen 10
  updatedAt:  number;         // ms timestamp
}

// ── Bybit V5 Ticker Response ─────────────────────────────────────────────────
interface BybitTickerItem {
  symbol:        string;
  lastPrice:     string;
  price24hPcnt:  string;
  turnover24h:   string;
  volume24h:     string;
  highPrice24h:  string;
  lowPrice24h:   string;
  openInterest:  string;
  fundingRate:   string;
}

interface BybitTickerResponse {
  retCode: number;
  result: {
    category: string;
    list: BybitTickerItem[];
  };
}

// ── Config ───────────────────────────────────────────────────────────────────
const BYBIT_TICKERS_URL = 'https://api.bybit.com/v5/market/tickers?category=linear';
const POLL_INTERVAL     = 10_000; // 10 saniye
const TOP_VOLUME_COUNT  = 15;
const TOP_MOVER_COUNT   = 10;
const MIN_TURNOVER      = 1_000_000; // Minimum $1M günlük hacim (gürültü filtresi)

// ── RadarService ─────────────────────────────────────────────────────────────
export class RadarService {
  private hotTargets: HotTargets = {
    topVolume:  [],
    topGainers: [],
    topLosers:  [],
    updatedAt:  0,
  };

  private timer: ReturnType<typeof setInterval> | null = null;

  /** Servisi başlat — ilk fetch + periyodik polling */
  start(): void {
    log.info('Radar tarayıcı başlatılıyor', { interval: `${POLL_INTERVAL / 1000}s` });
    // İlk fetch hemen
    void this.fetchAndProcess();
    // Periyodik polling
    this.timer = setInterval(() => {
      void this.fetchAndProcess();
    }, POLL_INTERVAL);
  }

  /** Servisi durdur */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    log.info('Radar tarayıcı durduruldu');
  }

  /** Güncel hot targets verisini döndür */
  getHotTargets(): HotTargets {
    return this.hotTargets;
  }

  /** Bybit'ten tüm linear ticker'ları çek, filtrele ve sırala */
  private async fetchAndProcess(): Promise<void> {
    try {
      const resp = await axios.get<BybitTickerResponse>(BYBIT_TICKERS_URL, {
        timeout: 8000,
      });

      if (resp.data.retCode !== 0) {
        log.warn('Bybit tickers API hata döndü', { retCode: resp.data.retCode });
        return;
      }

      const raw = resp.data.result.list;

      // Parse + USDT perp filtresi
      const tickers: RadarTicker[] = [];
      for (const item of raw) {
        if (!item.symbol.endsWith('USDT')) continue;
        const turnover = parseFloat(item.turnover24h) || 0;
        if (turnover < MIN_TURNOVER) continue;

        tickers.push({
          symbol:        item.symbol,
          lastPrice:     parseFloat(item.lastPrice)    || 0,
          price24hPcnt:  parseFloat(item.price24hPcnt) || 0,
          turnover24h:   turnover,
          volume24h:     parseFloat(item.volume24h)     || 0,
          highPrice24h:  parseFloat(item.highPrice24h)  || 0,
          lowPrice24h:   parseFloat(item.lowPrice24h)   || 0,
          openInterest:  parseFloat(item.openInterest)  || 0,
          fundingRate:   parseFloat(item.fundingRate)    || 0,
        });
      }

      // ── Top 15 by Turnover ─────────────────────────────────────────────
      const byTurnover = [...tickers]
        .sort((a, b) => b.turnover24h - a.turnover24h)
        .slice(0, TOP_VOLUME_COUNT);

      // ── Top Gainers — en yüksek pozitif price24hPcnt ───────────────────
      const topGainers = [...tickers]
        .sort((a, b) => b.price24hPcnt - a.price24hPcnt)
        .slice(0, TOP_MOVER_COUNT);

      // ── Top Losers — en düşük (negatif) price24hPcnt ───────────────────
      const topLosers = [...tickers]
        .sort((a, b) => a.price24hPcnt - b.price24hPcnt)
        .slice(0, TOP_MOVER_COUNT);

      this.hotTargets = {
        topVolume:  byTurnover,
        topGainers,
        topLosers,
        updatedAt:  Date.now(),
      };

      log.debug('Radar tarama tamamlandı', {
        total: tickers.length,
        topVol: byTurnover[0]?.symbol,
        topGain: topGainers[0]?.symbol,
        topLoss: topLosers[0]?.symbol,
      });

    } catch (err) {
      log.error('Radar fetch hatası', err instanceof Error ? err : new Error(String(err)));
    }
  }
}

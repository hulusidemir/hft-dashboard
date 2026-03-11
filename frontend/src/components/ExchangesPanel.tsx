// ─────────────────────────────────────────────────────────────────────────────
// components/ExchangesPanel.tsx — Borsa Bazlı Fiyat Grafikleri
// Seçili coinin Binance, Bybit, OKX fiyat grafiklerini yan yana gösterir.
// ─────────────────────────────────────────────────────────────────────────────

import { useRef, useEffect, useCallback, useState } from 'react';
import {
  createChart,
  CandlestickSeries,
  ColorType,
} from 'lightweight-charts';
import type {
  IChartApi,
  ISeriesApi,
  IPriceLine,
  UTCTimestamp,
} from 'lightweight-charts';
import { marketStore, useMarketStore, getTrades } from '../stores/marketStore';
import type { UnifiedTrade } from '../stores/marketStore';

// ── Config ──────────────────────────────────────────────────────────────────
const CANDLE_INTERVAL_S = 1;
const TZ_OFFSET = 3 * 3600; // UTC+3

const REST_BASE = import.meta.env.VITE_BACKEND_URL || 'http://localhost:9000';

const EXCHANGES = ['binance', 'bybit', 'okx'] as const;
type ExchangeName = typeof EXCHANGES[number];

const EXCHANGE_COLORS: Record<ExchangeName, { up: string; down: string; label: string }> = {
  binance: { up: '#f0b90b', down: '#f6465d', label: '#f0b90b' },
  bybit:   { up: '#20b26c', down: '#ef454a', label: '#f7a600' },
  okx:     { up: '#00c076', down: '#ff6838', label: '#00c076' },
};

const EXCHANGE_LABELS: Record<ExchangeName, string> = {
  binance: 'BINANCE',
  bybit: 'BYBIT',
  okx: 'OKX',
};

// ── Tape Config ─────────────────────────────────────────────────────────────
const TAPE_BG          = '#000000';
const TAPE_ROW_HEIGHT  = 15;
const TAPE_FONT        = '10px "Courier New", monospace';
const WHALE_THRESHOLD  = 50_000;
const WHALE_BG         = 'rgba(255, 220, 50, 0.12)';
const BUY_COLOR        = '#00ff00';
const SELL_COLOR       = '#ff0000';
const DIM_COLOR        = '#444444';
const MAX_TAPE_ROWS    = 80;

function fmtTime(ts: number): string {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}:${String(d.getSeconds()).padStart(2,'0')}.${String(d.getMilliseconds()).padStart(3,'0')}`;
}
function fmtPrice(p: number): string {
  if (p >= 10_000) return p.toFixed(1);
  if (p >= 100) return p.toFixed(2);
  if (p >= 1) return p.toFixed(4);
  if (p <= 0) return '0';
  // Küçük sayılar: baştaki sıfırlardan sonra 4 anlamlı basamak göster
  const e = Math.floor(Math.log10(p));
  const decimals = Math.max(4, -e + 3);
  return p.toFixed(decimals);
}
function fmtQty(q: number): string {
  if (q >= 1_000) return (q / 1_000).toFixed(2) + 'K';
  if (q >= 1) return q.toFixed(4);
  if (q >= 0.01) return q.toFixed(4);
  return q.toFixed(6);
}
function fmtUSD(u: number): string {
  if (u >= 1_000_000) return '$' + (u / 1_000_000).toFixed(2) + 'M';
  if (u >= 1_000) return '$' + (u / 1_000).toFixed(1) + 'K';
  return '$' + u.toFixed(0);
}

// ── LiveCandle ──────────────────────────────────────────────────────────────
interface LiveCandle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

// ── Funding Rate Types ────────────────────────────────────────────────────
interface ExchangeFunding {
  fundingRate: number;
  nextFundingTime: number;
  fundingIntervalHours: number;
}

type FundingMap = Record<ExchangeName, ExchangeFunding | null>;

function fmtCountdown(targetMs: number, nowMs: number): string {
  const diff = Math.max(0, Math.floor((targetMs - nowMs) / 1000));
  const h = Math.floor(diff / 3600);
  const m = Math.floor((diff % 3600) / 60);
  const s = diff % 60;
  return `${h}h${String(m).padStart(2, '0')}m${String(s).padStart(2, '0')}s`;
}

// ── Single Exchange Chart ─────────────────────────────────────────────────
function ExchangeChart({ exchange, funding, now }: { exchange: ExchangeName; funding: ExchangeFunding | null; now: number }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const priceLineRef = useRef<IPriceLine | null>(null);
  const currentCandle = useRef<LiveCandle | null>(null);
  const prevTradeLen = useRef(0);

  const colors = EXCHANGE_COLORS[exchange];

  const updateCandle = useCallback((trade: UnifiedTrade) => {
    const series = seriesRef.current;
    if (!series) return;

    const tradeTimeSec = Math.floor(trade.timestamp / 1000) + TZ_OFFSET;
    const candleTime = tradeTimeSec - (tradeTimeSec % CANDLE_INTERVAL_S);
    const price = trade.price;

    const candle = currentCandle.current;

    if (!candle || candleTime > candle.time) {
      const newCandle: LiveCandle = {
        time: candleTime,
        open: price,
        high: price,
        low: price,
        close: price,
      };
      currentCandle.current = newCandle;

      try {
        series.update({
          time: candleTime as UTCTimestamp,
          open: price,
          high: price,
          low: price,
          close: price,
        });
      } catch { /* stale */ }
    } else if (candleTime === candle.time) {
      candle.close = price;
      if (price > candle.high) candle.high = price;
      if (price < candle.low) candle.low = price;

      try {
        series.update({
          time: candle.time as UTCTimestamp,
          open: candle.open,
          high: candle.high,
          low: candle.low,
          close: candle.close,
        });
      } catch { /* stale */ }
    }

    if (priceLineRef.current) {
      priceLineRef.current.applyOptions({ price });
    }
  }, []);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const chart = createChart(container, {
      layout: {
        background: { type: ColorType.Solid, color: '#000000' },
        textColor: '#888888',
        fontFamily: 'Arial',
        fontSize: 10,
      },
      grid: {
        vertLines: { color: 'rgba(255,255,255,0.04)' },
        horzLines: { color: 'rgba(255,255,255,0.04)' },
      },
      crosshair: {
        vertLine: { color: 'rgba(255,255,255,0.15)', width: 1, labelBackgroundColor: '#333' },
        horzLine: { color: 'rgba(255,255,255,0.15)', width: 1, labelBackgroundColor: '#333' },
      },
      rightPriceScale: {
        borderColor: '#1a1a1a',
        scaleMargins: { top: 0.05, bottom: 0.05 },
      },
      timeScale: {
        borderColor: '#1a1a1a',
        timeVisible: true,
        secondsVisible: true,
        rightOffset: 8,
        barSpacing: 6,
        shiftVisibleRangeOnNewBar: true,
        fixLeftEdge: false,
        fixRightEdge: false,
      },
      handleScroll: true,
      handleScale: true,
    });

    chartRef.current = chart;

    const series = chart.addSeries(CandlestickSeries, {
      upColor: colors.up,
      downColor: colors.down,
      borderUpColor: colors.up,
      borderDownColor: colors.down,
      wickUpColor: colors.up,
      wickDownColor: colors.down,
      priceFormat: {
        type: 'price',
        precision: 8,
        minMove: 0.00000001,
      },
    });

    seriesRef.current = series;

    priceLineRef.current = series.createPriceLine({
      price: 0,
      color: colors.label,
      lineWidth: 1,
      lineStyle: 2,
      axisLabelVisible: true,
      title: 'Last',
    });

    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        if (width > 0 && height > 0) {
          chart.resize(width, height);
        }
      }
    });
    ro.observe(container);

    // ── Store subscription — sadece ilgili borsanın trade'lerini filtrele ──
    const unsubscribe = marketStore.subscribe((state, prevState) => {
      if (state.trades === prevState.trades) return;
      if (state.trades.length === 0) return;

      const newCount = state.trades.length - prevTradeLen.current;
      prevTradeLen.current = state.trades.length;

      const freshTrades = newCount > 0
        ? state.trades.slice(0, Math.min(newCount, state.trades.length))
        : state.trades.slice(0, 1);

      // Sadece bu borsanın trade'leri
      const filtered = freshTrades.filter(
        (t) => t.exchange.toLowerCase() === exchange
      );

      // Zaman sırasına çevir (eski → yeni)
      const sorted = [...filtered].reverse();

      for (const trade of sorted) {
        updateCandle(trade);
      }
    });

    // Double-click → scrollToRealTime
    const handleDblClick = () => {
      try { chart.timeScale().scrollToRealTime(); } catch { /* */ }
    };
    container.addEventListener('dblclick', handleDblClick);

    return () => {
      container.removeEventListener('dblclick', handleDblClick);
      unsubscribe();
      ro.disconnect();
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
      priceLineRef.current = null;
      currentCandle.current = null;
      prevTradeLen.current = 0;
    };
  }, [exchange, colors, updateCandle]);

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0, minHeight: 0 }}>
      {/* Exchange Label + Funding Rate */}
      <div style={{
        height: 26,
        display: 'flex',
        alignItems: 'center',
        padding: '0 8px',
        background: '#0a0a0a',
        borderBottom: '1px solid #1a1a1a',
        fontSize: 10,
        fontWeight: 700,
        letterSpacing: 1.5,
        color: colors.label,
        flexShrink: 0,
        gap: 8,
      }}>
        <span>{EXCHANGE_LABELS[exchange]}</span>
        {funding && (
          <span style={{ fontSize: 9, fontWeight: 400, letterSpacing: 0.5, display: 'flex', gap: 6 }}>
            <span style={{ color: '#555' }}>|</span>
            <span style={{ color: '#888' }}>FR:</span>
            <span style={{ color: funding.fundingRate >= 0 ? '#50ff50' : '#ff5050', fontWeight: 600 }}>
              {(funding.fundingRate * 100).toFixed(4)}%
            </span>
            <span style={{ color: '#888' }}>Countdown:</span>
            <span style={{ color: '#ff9900', fontWeight: 600 }}>
              {funding.nextFundingTime > 0 ? fmtCountdown(funding.nextFundingTime, now) : '—'}
            </span>
            <span style={{ color: '#888' }}>Interval:</span>
            <span style={{ color: '#aaa' }}>
              {funding.fundingIntervalHours > 0 ? `${funding.fundingIntervalHours}h` : '—'}
            </span>
          </span>
        )}
      </div>
      {/* Chart Container — 50% */}
      <div
        ref={containerRef}
        style={{ flex: 5, minHeight: 0, background: '#000' }}
      />
      {/* OI Bar */}
      <ExchangeOIBar exchange={exchange} />
      {/* OrderBook Delta */}
      <ExchangeOBDelta exchange={exchange} />
      {/* Tape — 40% */}
      <div style={{ borderTop: '1px solid #1a1a1a', flexShrink: 0, height: 18, display: 'flex', alignItems: 'center', padding: '0 6px', background: '#0a0a0a', fontSize: 9, fontWeight: 600, color: '#444', letterSpacing: 1 }}>
        TAPE · TIME &amp; SALES
      </div>
      <div style={{ flex: 4, minHeight: 0 }}>
        <ExchangeTape exchange={exchange} />
      </div>
    </div>
  );
}

// ── Exchange OI Bar ─────────────────────────────────────────────────────────

// ── Exchange OrderBook Delta ───────────────────────────────────────────────
const QTY_KEY_MAP: Record<ExchangeName, { bid: 'binanceQty' | 'bybitQty' | 'okxQty'; ask: 'binanceQty' | 'bybitQty' | 'okxQty' }> = {
  binance: { bid: 'binanceQty', ask: 'binanceQty' },
  bybit:   { bid: 'bybitQty',   ask: 'bybitQty' },
  okx:     { bid: 'okxQty',     ask: 'okxQty' },
};

function fmtDelta(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  if (abs >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return n.toFixed(2);
}

function ExchangeOBDelta({ exchange }: { exchange: ExchangeName }) {
  const ob = useMarketStore((s) => s.orderbook);
  const keys = QTY_KEY_MAP[exchange];

  let totalBid = 0;
  let totalAsk = 0;

  if (ob) {
    for (const level of ob.bids) {
      totalBid += level[keys.bid] * level.price;
    }
    for (const level of ob.asks) {
      totalAsk += level[keys.ask] * level.price;
    }
  }

  const delta = totalBid - totalAsk;
  const total = totalBid + totalAsk;
  const bidPct = total > 0 ? (totalBid / total) * 100 : 50;
  const askPct = total > 0 ? (totalAsk / total) * 100 : 50;

  return (
    <div style={{
      height: 26,
      display: 'flex',
      alignItems: 'center',
      padding: '0 8px',
      background: '#0a0a0a',
      borderBottom: '1px solid #1a1a1a',
      fontSize: 10,
      fontFamily: 'monospace',
      color: '#888',
      gap: 6,
      flexShrink: 0,
    }}>
      <span style={{ color: '#555', fontWeight: 600, letterSpacing: 1, fontSize: 9 }}>OBΔ</span>
      <span style={{ color: delta >= 0 ? '#50ff50' : '#ff5050', fontWeight: 700, fontSize: 10 }}>
        {delta >= 0 ? '+' : ''}{fmtDelta(delta)}
      </span>
      <span style={{ color: '#555' }}>·</span>
      {/* Bid/Ask bar */}
      <div style={{
        flex: 1,
        height: 6,
        display: 'flex',
        borderRadius: 3,
        overflow: 'hidden',
        minWidth: 30,
      }}>
        <div style={{
          width: `${bidPct}%`,
          height: '100%',
          background: '#26a69a',
          transition: 'width 0.3s',
        }} />
        <div style={{
          width: `${askPct}%`,
          height: '100%',
          background: '#ef5350',
          transition: 'width 0.3s',
        }} />
      </div>
      <span style={{ fontSize: 9, color: '#26a69a' }}>{bidPct.toFixed(0)}%</span>
      <span style={{ fontSize: 9, color: '#555' }}>/</span>
      <span style={{ fontSize: 9, color: '#ef5350' }}>{askPct.toFixed(0)}%</span>
    </div>
  );
}
const OI_KEY_MAP: Record<ExchangeName, 'binanceOI' | 'bybitOI' | 'okxOI'> = {
  binance: 'binanceOI',
  bybit: 'bybitOI',
  okx: 'okxOI',
};

function fmtOI(n: number): string {
  if (n >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
  if (n >= 1e6) return '$' + (n / 1e6).toFixed(2) + 'M';
  if (n >= 1e3) return '$' + (n / 1e3).toFixed(1) + 'K';
  return '$' + n.toFixed(0);
}

function ExchangeOIBar({ exchange }: { exchange: ExchangeName }) {
  const oi = useMarketStore((s) => s.openInterest);
  const oiKey = OI_KEY_MAP[exchange];
  const exchangeOI = oi ? oi[oiKey] : 0;
  const totalOI = oi ? oi.totalOI : 0;
  const share = totalOI > 0 ? ((exchangeOI / totalOI) * 100) : 0;

  return (
    <div style={{
      height: 26,
      display: 'flex',
      alignItems: 'center',
      padding: '0 8px',
      background: '#0a0a0a',
      borderTop: '1px solid #1a1a1a',
      borderBottom: '1px solid #1a1a1a',
      fontSize: 10,
      fontFamily: 'monospace',
      color: '#888',
      gap: 8,
      flexShrink: 0,
    }}>
      <span style={{ color: '#555', fontWeight: 600, letterSpacing: 1, fontSize: 9 }}>OI</span>
      <span style={{ color: '#ccc', fontWeight: 700 }}>{fmtOI(exchangeOI)}</span>
      <span style={{ color: '#555' }}>·</span>
      <span style={{ color: share >= 40 ? '#50ff50' : share >= 25 ? '#ffaa00' : '#ff5050', fontSize: 9 }}>
        {share.toFixed(1)}%
      </span>
      {/* Mini bar */}
      <div style={{
        flex: 1,
        height: 4,
        background: '#1a1a1a',
        borderRadius: 2,
        overflow: 'hidden',
        minWidth: 30,
      }}>
        <div style={{
          width: `${Math.min(share, 100)}%`,
          height: '100%',
          background: share >= 40 ? '#50ff50' : share >= 25 ? '#ffaa00' : '#ff5050',
          borderRadius: 2,
          transition: 'width 0.3s',
        }} />
      </div>
    </div>
  );
}

// ── Exchange Tape (Canvas) ──────────────────────────────────────────────────
function ExchangeTape({ exchange }: { exchange: ExchangeName }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const sizeRef = useRef({ w: 0, h: 0 });
  const rafRef = useRef<number>(0);

  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;

    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) return;

    function resize(): void {
      const rect = container!.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      const w = Math.floor(rect.width);
      const h = Math.floor(rect.height);
      if (w === sizeRef.current.w && h === sizeRef.current.h) return;
      sizeRef.current = { w, h };
      canvas!.width = w * dpr;
      canvas!.height = h * dpr;
      canvas!.style.width = w + 'px';
      canvas!.style.height = h + 'px';
    }

    const ro = new ResizeObserver(resize);
    ro.observe(container);
    resize();

    let running = true;

    function drawTape(): void {
      const { w, h } = sizeRef.current;
      const dpr = window.devicePixelRatio || 1;
      if (w <= 0 || h <= 0) return;

      const allTrades = getTrades();
      const trades = allTrades.filter((t) => t.exchange.toLowerCase() === exchange);

      ctx!.fillStyle = TAPE_BG;
      ctx!.fillRect(0, 0, w * dpr, h * dpr);
      ctx!.save();
      ctx!.scale(dpr, dpr);

      // Header
      const headerH = 18;
      ctx!.fillStyle = '#0a0a0a';
      ctx!.fillRect(0, 0, w, headerH);
      ctx!.font = '9px Arial';
      ctx!.fillStyle = '#555';
      ctx!.textAlign = 'left';

      const colTime = 4;
      const colSide = 80;
      const colPrice = 110;
      const colQty = 175;
      const colUSD = 230;

      ctx!.fillText('TIME', colTime, headerH - 5);
      ctx!.fillText('SIDE', colSide, headerH - 5);
      ctx!.fillText('PRICE', colPrice, headerH - 5);
      ctx!.fillText('QTY', colQty, headerH - 5);
      ctx!.fillText('USD', colUSD, headerH - 5);

      ctx!.strokeStyle = '#1a1a1a';
      ctx!.lineWidth = 1;
      ctx!.beginPath();
      ctx!.moveTo(0, headerH);
      ctx!.lineTo(w, headerH);
      ctx!.stroke();

      // Rows
      const maxRows = Math.min(
        Math.floor((h - headerH) / TAPE_ROW_HEIGHT),
        MAX_TAPE_ROWS,
        trades.length,
      );

      ctx!.font = TAPE_FONT;

      for (let i = 0; i < maxRows; i++) {
        const trade = trades[i];
        const y = headerH + i * TAPE_ROW_HEIGHT;

        if (trade.quoteQty >= WHALE_THRESHOLD) {
          ctx!.fillStyle = WHALE_BG;
          ctx!.fillRect(0, y, w, TAPE_ROW_HEIGHT);
        }

        const color = trade.side === 'BUY' ? BUY_COLOR : SELL_COLOR;

        ctx!.textAlign = 'left';

        ctx!.fillStyle = DIM_COLOR;
        ctx!.fillText(fmtTime(trade.timestamp), colTime, y + TAPE_ROW_HEIGHT - 3);

        ctx!.fillStyle = color;
        ctx!.fillText(trade.side, colSide, y + TAPE_ROW_HEIGHT - 3);

        ctx!.fillStyle = color;
        ctx!.fillText(fmtPrice(trade.price), colPrice, y + TAPE_ROW_HEIGHT - 3);

        ctx!.fillStyle = color;
        ctx!.fillText(fmtQty(trade.quantity), colQty, y + TAPE_ROW_HEIGHT - 3);

        ctx!.fillStyle = trade.quoteQty >= WHALE_THRESHOLD ? '#ffdd33' : color;
        ctx!.fillText(fmtUSD(trade.quoteQty), colUSD, y + TAPE_ROW_HEIGHT - 3);
      }

      if (trades.length === 0) {
        ctx!.font = '11px Arial';
        ctx!.fillStyle = '#444';
        ctx!.textAlign = 'center';
        ctx!.fillText('Waiting...', w / 2, h / 2);
      }

      ctx!.restore();
    }

    function loop(): void {
      if (!running) return;
      drawTape();
      rafRef.current = requestAnimationFrame(loop);
    }
    rafRef.current = requestAnimationFrame(loop);

    return () => {
      running = false;
      cancelAnimationFrame(rafRef.current);
      ro.disconnect();
    };
  }, [exchange]);

  return (
    <div ref={containerRef} style={{ width: '100%', height: '100%', background: TAPE_BG, overflow: 'hidden' }}>
      <canvas ref={canvasRef} style={{ display: 'block' }} />
    </div>
  );
}

// ── Main Panel ──────────────────────────────────────────────────────────────
export default function ExchangesPanel() {
  const currentSymbol = useMarketStore((s) => s.currentSymbol);
  const baseCoin = currentSymbol.replace(/USDT$/i, '');
  const [fundingMap, setFundingMap] = useState<FundingMap>({ binance: null, bybit: null, okx: null });
  const [now, setNow] = useState(Date.now());

  // 1s tick for countdown
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  // Fetch MR data for funding rates
  useEffect(() => {
    let cancelled = false;

    async function fetchFunding() {
      try {
        const res = await fetch(`${REST_BASE}/api/mr?symbol=${currentSymbol}&tf=1h`);
        if (!res.ok) return;
        const json = await res.json();
        if (cancelled) return;

        const map: FundingMap = { binance: null, bybit: null, okx: null };
        for (const ex of EXCHANGES) {
          const d = json.exchanges?.[ex];
          if (d) {
            map[ex] = {
              fundingRate: d.fundingRate ?? 0,
              nextFundingTime: d.nextFundingTime ?? 0,
              fundingIntervalHours: d.fundingIntervalHours ?? 0,
            };
          }
        }
        setFundingMap(map);
      } catch { /* silent */ }
    }

    fetchFunding();
    const interval = setInterval(fetchFunding, 30_000); // 30 saniyede bir güncelle

    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [currentSymbol]);
  return (
    <div style={{
      width: '100%',
      height: '100%',
      display: 'flex',
      flexDirection: 'column',
      background: '#060606',
      overflow: 'hidden',
    }}>
      {/* Header */}
      <div style={{
        height: 28,
        display: 'flex',
        alignItems: 'center',
        padding: '0 12px',
        background: '#0a0a0a',
        borderBottom: '1px solid #1a1a1a',
        fontSize: 10,
        fontWeight: 700,
        letterSpacing: 1,
        color: '#888',
        flexShrink: 0,
        gap: 8,
      }}>
        <span style={{ color: '#ff9900' }}>BORSALAR</span>
        <span style={{ color: '#555' }}>·</span>
        <span>{baseCoin}/USDT</span>
        <span style={{ color: '#555' }}>·</span>
        <span style={{ color: '#444' }}>1s Candlestick</span>
      </div>

      {/* 3 Exchange Charts */}
      <div style={{
        flex: 1,
        display: 'flex',
        flexDirection: 'row',
        gap: 1,
        minHeight: 0,
      }}>
        {EXCHANGES.map((ex) => (
          <ExchangeChart key={`${currentSymbol}_${ex}`} exchange={ex} funding={fundingMap[ex]} now={now} />
        ))}
      </div>
    </div>
  );
}

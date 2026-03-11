// ─────────────────────────────────────────────────────────────────────────────
// ChartPanel.tsx — Multi-Timeframe Chart (RT Line + Candlestick)
// lightweight-charts v5 · RT: 1s çizgi · 5m/15m/1h/4h: Mum grafik
// ─────────────────────────────────────────────────────────────────────────────

import { useRef, useEffect, useCallback } from 'react';
import {
  createChart,
  LineSeries,
  CandlestickSeries,
  ColorType,
  LineStyle,
} from 'lightweight-charts';
import type {
  IChartApi,
  ISeriesApi,
  UTCTimestamp,
  IPriceLine,
  CandlestickData,
  MouseEventParams,
  OhlcData,
} from 'lightweight-charts';
import { marketStore } from '../stores/marketStore';
import type { UnifiedTrade } from '../stores/marketStore';

// ── Config ──────────────────────────────────────────────────────────────────
const TICK_INTERVAL_S = 1;
const REST_BASE = import.meta.env.VITE_BACKEND_URL || 'http://localhost:9000';

export type ChartTimeframe = 'RT' | '5m' | '15m' | '1h' | '4h';
export const TIMEFRAMES: ChartTimeframe[] = ['RT', '5m', '15m', '1h', '4h'];

/** Fiyata göre uygun precision ve minMove döndür */
function pricePrecision(price: number): { precision: number; minMove: number } {
  if (price >= 10_000) return { precision: 1, minMove: 0.1 };
  if (price >= 1_000)  return { precision: 2, minMove: 0.01 };
  if (price >= 100)    return { precision: 3, minMove: 0.001 };
  if (price >= 10)     return { precision: 4, minMove: 0.0001 };
  if (price >= 1)      return { precision: 4, minMove: 0.0001 };
  if (price >= 0.1)    return { precision: 5, minMove: 0.00001 };
  if (price >= 0.01)   return { precision: 6, minMove: 0.000001 };
  if (price >= 0.001)  return { precision: 7, minMove: 0.0000001 };
  return { precision: 8, minMove: 0.00000001 };
}

/** OHLC legend: adaptive price formatting */
function fmtOhlc(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 10_000) return n.toFixed(1);
  if (abs >= 1_000)  return n.toFixed(2);
  if (abs >= 100)    return n.toFixed(3);
  if (abs >= 1)      return n.toFixed(4);
  if (abs >= 0.01)   return n.toFixed(6);
  return n.toFixed(8);
}

// ── Kline types ─────────────────────────────────────────────────────────────
interface KlineBar {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  turnover: number;
}

// ── Props ───────────────────────────────────────────────────────────────────
interface ChartPanelProps {
  onChartReady?: (chart: IChartApi) => void;
  timeframe: ChartTimeframe;
  onTimeframeChange: (tf: ChartTimeframe) => void;
}

export default function ChartPanel({ onChartReady, timeframe, onTimeframeChange }: ChartPanelProps) {
  const containerRef    = useRef<HTMLDivElement>(null);
  const chartRef        = useRef<IChartApi | null>(null);
  const lineSeriesRef   = useRef<ISeriesApi<'Line'> | null>(null);
  const candleSeriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const priceLineRef    = useRef<IPriceLine | null>(null);
  const ohlcRef         = useRef<HTMLDivElement>(null);
  const lastTickTime    = useRef(0);
  const prevTradeLen    = useRef(0);
  const precisionSet    = useRef(false);
  const currentTfRef    = useRef<ChartTimeframe>('RT');

  currentTfRef.current = timeframe;

  const chartReadyCb = useCallback((chart: IChartApi) => {
    if (onChartReady) onChartReady(chart);
  }, [onChartReady]);

  // ── Build chart once ──────────────────────────────────────────────────
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
        vertLines:   { color: 'rgba(255,255,255,0.04)' },
        horzLines:   { color: 'rgba(255,255,255,0.04)' },
      },
      crosshair: {
        vertLine: { color: 'rgba(255,255,255,0.15)', width: 1, labelBackgroundColor: '#333' },
        horzLine: { color: 'rgba(255,255,255,0.15)', width: 1, labelBackgroundColor: '#333' },
      },
      rightPriceScale: {
        borderColor: '#1a1a1a',
        scaleMargins: { top: 0.1, bottom: 0.1 },
      },
      timeScale: {
        borderColor: '#1a1a1a',
        timeVisible: true,
        secondsVisible: true,
        rightOffset: 5,
        barSpacing: 4,
        shiftVisibleRangeOnNewBar: true,
        fixLeftEdge: false,
        fixRightEdge: false,
      },
      handleScroll: true,
      handleScale: true,
    });

    chartRef.current = chart;

    // ResizeObserver
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        if (width > 0 && height > 0) chart.resize(width, height);
      }
    });
    ro.observe(container);

    chartReadyCb(chart);

    // Double-click → scroll to real time
    const handleDblClick = () => {
      try { chart.timeScale().scrollToRealTime(); } catch { /* */ }
    };
    container.addEventListener('dblclick', handleDblClick);

    return () => {
      container.removeEventListener('dblclick', handleDblClick);
      ro.disconnect();
      chart.remove();
      chartRef.current = null;
      lineSeriesRef.current = null;
      candleSeriesRef.current = null;
      priceLineRef.current = null;
      lastTickTime.current = 0;
      prevTradeLen.current = 0;
      precisionSet.current = false;
    };
  }, [chartReadyCb]);

  // ── Switch series based on timeframe ──────────────────────────────────
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;

    // Remove existing series
    if (lineSeriesRef.current) {
      try { chart.removeSeries(lineSeriesRef.current); } catch { /* */ }
      lineSeriesRef.current = null;
    }
    if (candleSeriesRef.current) {
      try { chart.removeSeries(candleSeriesRef.current); } catch { /* */ }
      candleSeriesRef.current = null;
    }
    priceLineRef.current = null;
    lastTickTime.current = 0;
    prevTradeLen.current = 0;
    precisionSet.current = false;

    // Clear OHLC legend
    if (ohlcRef.current) ohlcRef.current.textContent = '';

    if (timeframe === 'RT') {
      // ── Line series for real-time ──
      const series = chart.addSeries(LineSeries, {
        color: '#2196F3',
        lineWidth: 2,
        crosshairMarkerVisible: true,
        crosshairMarkerRadius: 3,
        priceFormat: { type: 'price', precision: 2, minMove: 0.01 },
      });
      lineSeriesRef.current = series;

      priceLineRef.current = series.createPriceLine({
        price: 0,
        color: '#ffaa00',
        lineWidth: 1,
        lineStyle: LineStyle.Dashed,
        axisLabelVisible: true,
        title: 'Last',
      });

      chart.timeScale().applyOptions({ secondsVisible: true, barSpacing: 4 });
    } else {
      // ── Candlestick series for historical ──
      const series = chart.addSeries(CandlestickSeries, {
        upColor: '#26a69a',
        downColor: '#ef5350',
        borderUpColor: '#26a69a',
        borderDownColor: '#ef5350',
        wickUpColor: '#26a69a',
        wickDownColor: '#ef5350',
        priceFormat: { type: 'price', precision: 2, minMove: 0.01 },
      });
      candleSeriesRef.current = series;

      chart.timeScale().applyOptions({
        secondsVisible: false,
        barSpacing: timeframe === '5m' ? 5 : timeframe === '15m' ? 6 : 8,
      });

      const symbol = marketStore.getState().currentSymbol;
      void fetchKlineData(symbol, timeframe, series);
    }
  }, [timeframe]);

  // ── OHLC legend via crosshair (candlestick mode) ─────────────────────
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart || timeframe === 'RT') return;

    const handler = (param: MouseEventParams) => {
      const el = ohlcRef.current;
      if (!el) return;
      const series = candleSeriesRef.current;
      if (!series) { el.textContent = ''; return; }
      const d = param.seriesData.get(series) as OhlcData | undefined;
      if (!d || d.open == null) { el.textContent = ''; return; }
      const up = d.close >= d.open;
      const clr = up ? '#26a69a' : '#ef5350';
      el.innerHTML =
        `<span style="color:#888">O</span> <span style="color:${clr}">${fmtOhlc(d.open)}</span>` +
        `  <span style="color:#888">H</span> <span style="color:${clr}">${fmtOhlc(d.high)}</span>` +
        `  <span style="color:#888">L</span> <span style="color:${clr}">${fmtOhlc(d.low)}</span>` +
        `  <span style="color:#888">C</span> <span style="color:${clr}">${fmtOhlc(d.close)}</span>`;
    };
    chart.subscribeCrosshairMove(handler);
    return () => { chart.unsubscribeCrosshairMove(handler); };
  }, [timeframe]);

  // ── Fetch kline data for candlestick chart ────────────────────────────
  async function fetchKlineData(
    symbol: string,
    tf: ChartTimeframe,
    series: ISeriesApi<'Candlestick'>,
  ) {
    try {
      const resp = await fetch(
        `${REST_BASE}/api/klines?symbol=${symbol}&interval=${tf}&limit=500`,
      );
      if (!resp.ok) return;
      const bars = (await resp.json()) as KlineBar[];
      if (!bars.length) return;

      const pp = pricePrecision(bars[0]!.close);
      series.applyOptions({
        priceFormat: { type: 'price', precision: pp.precision, minMove: pp.minMove },
      });

      const TZ_OFFSET = 3 * 3600;
      const candleData: CandlestickData[] = bars.map((b) => ({
        time: (b.time + TZ_OFFSET) as UTCTimestamp,
        open: b.open,
        high: b.high,
        low: b.low,
        close: b.close,
      }));

      series.setData(candleData);
      chartRef.current?.timeScale().fitContent();
    } catch {
      // silent
    }
  }

  // ── RT subscription ───────────────────────────────────────────────────
  useEffect(() => {
    if (timeframe !== 'RT') return;

    const unsubscribe = marketStore.subscribe((state, prevState) => {
      if (currentTfRef.current !== 'RT') return;
      if (state.trades === prevState.trades) return;
      if (state.trades.length === 0) return;

      const newCount = state.trades.length - prevTradeLen.current;
      prevTradeLen.current = state.trades.length;

      const freshTrades = newCount > 0
        ? state.trades.slice(0, Math.min(newCount, state.trades.length))
        : state.trades.slice(0, 1);

      const sorted = [...freshTrades].reverse();
      for (const trade of sorted) {
        updateLine(trade);
      }
    });

    return () => { unsubscribe(); };
  }, [timeframe]);

  // ── Auto-refresh klines every 15s for non-RT ─────────────────────────
  useEffect(() => {
    if (timeframe === 'RT') return;

    const interval = setInterval(() => {
      const series = candleSeriesRef.current;
      if (!series) return;
      const symbol = marketStore.getState().currentSymbol;
      void fetchKlineData(symbol, timeframe, series);
    }, 15_000);

    return () => clearInterval(interval);
  }, [timeframe]);

  // ── Line update (RT mode) ─────────────────────────────────────────────
  function updateLine(trade: UnifiedTrade): void {
    const series = lineSeriesRef.current;
    if (!series) return;

    const TZ_OFFSET    = 3 * 3600;
    const tradeTimeSec = Math.floor(trade.timestamp / 1000) + TZ_OFFSET;
    const tickTime     = tradeTimeSec - (tradeTimeSec % TICK_INTERVAL_S);
    const price        = trade.price;

    if (tickTime < lastTickTime.current) return;
    lastTickTime.current = tickTime;

    if (!precisionSet.current && price > 0) {
      precisionSet.current = true;
      const pp = pricePrecision(price);
      series.applyOptions({
        priceFormat: { type: 'price', precision: pp.precision, minMove: pp.minMove },
      });
    }

    try {
      series.update({ time: tickTime as UTCTimestamp, value: price });
    } catch { /* stale ts */ }

    if (priceLineRef.current) {
      priceLineRef.current.applyOptions({ price });
    }
  }

  return (
    <div style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column', background: '#000' }}>
      {/* ── Timeframe selector ─────────────────────────────────────── */}
      <div style={{
        display: 'flex',
        gap: 2,
        padding: '3px 6px',
        background: '#070707',
        borderBottom: '1px solid #1a1a1a',
        flexShrink: 0,
        alignItems: 'center',
      }}>
        {TIMEFRAMES.map((tf) => (
          <button
            key={tf}
            onClick={() => onTimeframeChange(tf)}
            style={{
              background: timeframe === tf
                ? (tf === 'RT' ? '#2196F3' : '#ff9900')
                : '#111',
              border: `1px solid ${timeframe === tf
                ? (tf === 'RT' ? '#2196F3' : '#ff9900')
                : '#333'}`,
              borderRadius: 3,
              padding: '2px 10px',
              cursor: 'pointer',
              fontFamily: 'monospace',
              fontSize: 10,
              fontWeight: 800,
              letterSpacing: 0.8,
              color: timeframe === tf ? '#000' : '#666',
              transition: 'all 0.12s',
            }}
          >
            {tf}
          </button>
        ))}
        <span style={{
          marginLeft: 'auto',
          fontFamily: 'monospace',
          fontSize: 9,
          color: '#444',
          letterSpacing: 0.5,
        }}>
          {timeframe === 'RT' ? 'Line · 1s tick' : `Candle · ${timeframe}`}
        </span>
      </div>

      {/* ── Chart container ────────────────────────────────────────── */}
      <div style={{ flex: 1, minHeight: 0, position: 'relative' }}>
        <div
          ref={containerRef}
          style={{ width: '100%', height: '100%' }}
        />
        {/* OHLC legend overlay (candlestick mode only) */}
        {timeframe !== 'RT' && (
          <div
            ref={ohlcRef}
            style={{
              position: 'absolute',
              top: 6,
              left: 8,
              zIndex: 10,
              pointerEvents: 'none',
              fontFamily: 'monospace',
              fontSize: 10,
              fontWeight: 700,
              letterSpacing: 0.3,
              whiteSpace: 'nowrap',
              textShadow: '0 0 4px #000, 0 0 8px #000',
            }}
          />
        )}
      </div>
    </div>
  );
}

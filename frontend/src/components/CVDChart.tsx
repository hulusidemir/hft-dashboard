// ─────────────────────────────────────────────────────────────────────────────
// CVDChart.tsx — Kümülatif Hacim Deltası (CVD)
// RT: Çizgi grafik · 5m/15m/1h/4h: Mum grafik (CVD candlestick)
// lightweight-charts v5 · ChartPanel ile X-ekseni senkronize
// ─────────────────────────────────────────────────────────────────────────────

import { useRef, useEffect, useCallback } from 'react';
import {
  createChart,
  LineSeries,
  CandlestickSeries,
  ColorType,
} from 'lightweight-charts';
import type {
  IChartApi,
  ISeriesApi,
  UTCTimestamp,
  CandlestickData,
  MouseEventParams,
  OhlcData,
} from 'lightweight-charts';
import { marketStore } from '../stores/marketStore';
import type { ChartTimeframe } from './ChartPanel';

const REST_BASE = import.meta.env.VITE_BACKEND_URL || 'http://localhost:9000';
const TZ_OFFSET = 3 * 3600; // UTC+3 (Turkey)

/** Format CVD value for OHLC legend ($1.2M, $450K, etc.) */
function fmtCvdVal(n: number): string {
  const abs = Math.abs(n);
  const sign = n < 0 ? '-' : '';
  if (abs >= 1e9) return `${sign}$${(abs / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${sign}$${(abs / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${sign}$${(abs / 1e3).toFixed(1)}K`;
  return `${sign}$${abs.toFixed(0)}`;
}

// ── Kline bar from backend (includes taker buy volumes) ─────────────────────
interface KlineBar {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  turnover: number;
  takerBuyVolume: number;
  takerBuyTurnover: number;
}

// ── Props ───────────────────────────────────────────────────────────────────
interface CVDChartProps {
  onChartReady?: (chart: IChartApi) => void;
  timeframe: ChartTimeframe;
}

// ── CVD veri noktası (RT mode) ──────────────────────────────────────────────
interface CVDPoint {
  time: number;
  value: number;
}

export default function CVDChart({ onChartReady, timeframe }: CVDChartProps) {
  const containerRef   = useRef<HTMLDivElement>(null);
  const chartRef       = useRef<IChartApi | null>(null);
  const lineSeriesRef  = useRef<ISeriesApi<'Line'> | null>(null);
  const candleSeriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const ohlcRef        = useRef<HTMLDivElement>(null);
  const lastPointRef   = useRef<CVDPoint | null>(null);
  const currentTfRef   = useRef<ChartTimeframe>('RT');

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
        vertLines: { color: 'rgba(255,255,255,0.04)' },
        horzLines: { color: 'rgba(255,255,255,0.04)' },
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
        rightOffset: 12,
        barSpacing: 6,
        shiftVisibleRangeOnNewBar: true,
        fixLeftEdge: false,
        fixRightEdge: false,
      },
      handleScroll: true,
      handleScale: true,
    });

    chartRef.current = chart;

    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        if (width > 0 && height > 0) chart.resize(width, height);
      }
    });
    ro.observe(container);

    chartReadyCb(chart);

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
      lastPointRef.current = null;
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
    lastPointRef.current = null;

    // Clear OHLC legend
    if (ohlcRef.current) ohlcRef.current.textContent = '';

    if (timeframe === 'RT') {
      // ── Line series for real-time CVD ──
      const series = chart.addSeries(LineSeries, {
        color: '#00bcd4',
        lineWidth: 2,
        priceFormat: { type: 'volume' },
        lastValueVisible: true,
        priceLineVisible: true,
      });
      lineSeriesRef.current = series;

      // Zero reference line
      series.createPriceLine({
        price: 0,
        color: 'rgba(255,255,255,0.15)',
        lineWidth: 1,
        lineStyle: 2,
        axisLabelVisible: false,
        title: '',
      });

      chart.timeScale().applyOptions({ secondsVisible: true, barSpacing: 6 });
    } else {
      // ── Candlestick series for historical CVD ──
      const series = chart.addSeries(CandlestickSeries, {
        upColor: '#00bcd4',
        downColor: '#e91e63',
        borderUpColor: '#00bcd4',
        borderDownColor: '#e91e63',
        wickUpColor: '#00bcd4',
        wickDownColor: '#e91e63',
        priceFormat: { type: 'volume' },
      });
      candleSeriesRef.current = series;

      chart.timeScale().applyOptions({
        secondsVisible: false,
        barSpacing: timeframe === '5m' ? 5 : timeframe === '15m' ? 6 : 8,
      });

      const symbol = marketStore.getState().currentSymbol;
      void fetchCVDKlines(symbol, timeframe, series);
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
      const clr = up ? '#00bcd4' : '#e91e63';
      el.innerHTML =
        `<span style="color:#888">O</span> <span style="color:${clr}">${fmtCvdVal(d.open)}</span>` +
        `  <span style="color:#888">H</span> <span style="color:${clr}">${fmtCvdVal(d.high)}</span>` +
        `  <span style="color:#888">L</span> <span style="color:${clr}">${fmtCvdVal(d.low)}</span>` +
        `  <span style="color:#888">C</span> <span style="color:${clr}">${fmtCvdVal(d.close)}</span>`;
    };
    chart.subscribeCrosshairMove(handler);
    return () => { chart.unsubscribeCrosshairMove(handler); };
  }, [timeframe]);

  // ── Fetch kline data and compute CVD candles ──────────────────────────
  async function fetchCVDKlines(
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

      // CVD = cumulative (takerBuyTurnover - takerSellTurnover)
      // takerSellTurnover = turnover - takerBuyTurnover
      // Per-candle delta = takerBuyTurnover - (turnover - takerBuyTurnover) = 2*takerBuyTurnover - turnover
      let cumCVD = 0;
      const candleData: CandlestickData[] = bars.map((b) => {
        const delta = 2 * b.takerBuyTurnover - b.turnover;
        const open = cumCVD;
        cumCVD += delta;
        const close = cumCVD;
        return {
          time: (b.time + TZ_OFFSET) as UTCTimestamp,
          open,
          high: Math.max(open, close),
          low: Math.min(open, close),
          close,
        };
      });

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
      if (state.cvd === prevState.cvd && state.lastMessageAt === prevState.lastMessageAt) return;

      const series = lineSeriesRef.current;
      if (!series) return;

      const now     = state.lastMessageAt || Date.now();
      const timeSec = Math.floor(now / 1000) + TZ_OFFSET;
      const cvdValue = state.cvd;

      const lastPt = lastPointRef.current;

      if (!lastPt || timeSec > lastPt.time) {
        const point: CVDPoint = { time: timeSec, value: cvdValue };
        lastPointRef.current = point;
        try { series.update({ time: timeSec as UTCTimestamp, value: cvdValue }); } catch { /* stale ts */ }
      } else if (timeSec === lastPt.time) {
        lastPt.value = cvdValue;
        try { series.update({ time: timeSec as UTCTimestamp, value: cvdValue }); } catch { /* stale ts */ }
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
      void fetchCVDKlines(symbol, timeframe, series);
    }, 15_000);

    return () => clearInterval(interval);
  }, [timeframe]);

  return (
    <div style={{ width: '100%', height: '100%', background: '#000', position: 'relative' }}>
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
            top: 4,
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
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// OIChart.tsx — Kümülatif Para Akışı (Cumulative Net Flow) Monitörü
// RT: BaselineSeries (yeşil/kırmızı akış) · 5m/15m/1h/4h: Mum grafik
// lightweight-charts v5 · ChartPanel/CVDChart ile X-ekseni senkronize
// ─────────────────────────────────────────────────────────────────────────────

import { useRef, useEffect, useCallback, useState } from 'react';
import {
  createChart,
  BaselineSeries,
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

// ── Props ───────────────────────────────────────────────────────────────────
interface OIChartProps {
  onChartReady?: (chart: IChartApi) => void;
  timeframe: ChartTimeframe;
}

// ── OI History bar from backend ─────────────────────────────────────────────
interface OIHistoryBar {
  time: number;
  sumOpenInterest: number;
  sumOpenInterestValue: number;
}

// ── Yardımcı: dolar formatı ($0, +$1.2M, -$500K vb.) ──────────────────────
function formatDelta(val: number): string {
  const abs = Math.abs(val);
  const sign = val >= 0 ? '+' : '-';
  if (abs >= 1_000_000_000) return `${sign}$${(abs / 1_000_000_000).toFixed(2)}B`;
  if (abs >= 1_000_000)     return `${sign}$${(abs / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000)         return `${sign}$${(abs / 1_000).toFixed(0)}K`;
  return `${sign}$${abs.toFixed(0)}`;
}

// ── Renkler ─────────────────────────────────────────────────────────────────
const COLOR_POS      = '#26a69a';
const COLOR_POS_FILL = 'rgba(38,166,154,0.25)';
const COLOR_NEG      = '#ef5350';
const COLOR_NEG_FILL = 'rgba(239,83,80,0.25)';

export default function OIChart({ onChartReady, timeframe }: OIChartProps) {
  const containerRef         = useRef<HTMLDivElement>(null);
  const legendRef            = useRef<HTMLDivElement>(null);
  const ohlcRef              = useRef<HTMLDivElement>(null);
  const chartRef             = useRef<IChartApi | null>(null);
  const baselineSeriesRef    = useRef<ISeriesApi<'Baseline'> | null>(null);
  const candleSeriesRef      = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const initialTotalOIRef    = useRef<number | null>(null);
  const lastCumulativeDeltaRef = useRef<number | null>(null);
  const lastPlottedRef       = useRef<{ time: number; value: number }>({ time: 0, value: 0 });
  const currentTfRef         = useRef<ChartTimeframe>('RT');

  currentTfRef.current = timeframe;
  const [showScrollBtn, setShowScrollBtn] = useState(false);

  const chartReadyCb = useCallback((chart: IChartApi) => {
    if (onChartReady) onChartReady(chart);
  }, [onChartReady]);

  // ── Build chart once ──────────────────────────────────────────────────
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    // Refs sıfırla
    initialTotalOIRef.current    = null;
    lastCumulativeDeltaRef.current = null;
    lastPlottedRef.current       = { time: 0, value: 0 };

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
        scaleMargins: { top: 0.15, bottom: 0.15 },
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

    // Scroll-to-latest detection
    chart.timeScale().subscribeVisibleLogicalRangeChange(() => {
      try {
        setShowScrollBtn(chart.timeScale().scrollPosition() < 3);
      } catch { /* chart removed */ }
    });

    const handleDblClick = () => {
      try { chart.timeScale().scrollToRealTime(); } catch { /* */ }
    };
    container.addEventListener('dblclick', handleDblClick);

    return () => {
      container.removeEventListener('dblclick', handleDblClick);
      ro.disconnect();
      chart.remove();
      chartRef.current           = null;
      baselineSeriesRef.current  = null;
      candleSeriesRef.current    = null;
      initialTotalOIRef.current  = null;
      lastCumulativeDeltaRef.current = null;
      lastPlottedRef.current     = { time: 0, value: 0 };
    };
  }, [chartReadyCb]);

  // ── Switch series based on timeframe ──────────────────────────────────
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;

    // Remove existing series
    if (baselineSeriesRef.current) {
      try { chart.removeSeries(baselineSeriesRef.current); } catch { /* */ }
      baselineSeriesRef.current = null;
    }
    if (candleSeriesRef.current) {
      try { chart.removeSeries(candleSeriesRef.current); } catch { /* */ }
      candleSeriesRef.current = null;
    }
    initialTotalOIRef.current    = null;
    lastCumulativeDeltaRef.current = null;
    lastPlottedRef.current       = { time: 0, value: 0 };

    // Clear OHLC legend
    if (ohlcRef.current) ohlcRef.current.textContent = '';

    if (timeframe === 'RT') {
      // ── Baseline series for real-time OI ──
      const series = chart.addSeries(BaselineSeries, {
        baseValue: { type: 'price' as const, price: 0 },
        topLineColor:    COLOR_POS,
        topFillColor1:   COLOR_POS_FILL,
        topFillColor2:   'transparent',
        bottomLineColor: COLOR_NEG,
        bottomFillColor1: COLOR_NEG_FILL,
        bottomFillColor2: 'transparent',
        lineWidth: 2,
        priceFormat: { type: 'volume' },
        lastValueVisible: true,
        priceLineVisible: false,
      });
      baselineSeriesRef.current = series;

      chart.timeScale().applyOptions({ secondsVisible: true, barSpacing: 6 });

      // Seed with current OI — prevents empty chart flash on TF→RT switch
      const currentState = marketStore.getState();
      const oi = currentState.openInterest;
      if (oi && oi.totalOI > 0) {
        initialTotalOIRef.current = oi.totalOI;
        const cumulativeDelta = 0;
        lastCumulativeDeltaRef.current = cumulativeDelta;
        const timeSeed = Math.floor(oi.timestamp / 1000) + TZ_OFFSET;
        lastPlottedRef.current = { time: timeSeed, value: cumulativeDelta };
        try { series.update({ time: timeSeed as UTCTimestamp, value: cumulativeDelta }); } catch { /* */ }
        updateLegend(cumulativeDelta);
      }

      chart.timeScale().scrollToRealTime();
      setShowScrollBtn(false);
    } else {
      // ── Candlestick series for historical OI delta ──
      const series = chart.addSeries(CandlestickSeries, {
        upColor: COLOR_POS,
        downColor: COLOR_NEG,
        borderUpColor: COLOR_POS,
        borderDownColor: COLOR_NEG,
        wickUpColor: COLOR_POS,
        wickDownColor: COLOR_NEG,
        priceFormat: { type: 'volume' },
      });
      candleSeriesRef.current = series;

      chart.timeScale().applyOptions({
        secondsVisible: false,
        barSpacing: timeframe === '5m' ? 5 : timeframe === '15m' ? 6 : 8,
      });

      const symbol = marketStore.getState().currentSymbol;
      void fetchOIHistory(symbol, timeframe, series);
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
      const clr = up ? COLOR_POS : COLOR_NEG;
      el.innerHTML =
        `<span style="color:#888">O</span> <span style="color:${clr}">${formatDelta(d.open)}</span>` +
        `  <span style="color:#888">H</span> <span style="color:${clr}">${formatDelta(d.high)}</span>` +
        `  <span style="color:#888">L</span> <span style="color:${clr}">${formatDelta(d.low)}</span>` +
        `  <span style="color:#888">C</span> <span style="color:${clr}">${formatDelta(d.close)}</span>`;
    };
    chart.subscribeCrosshairMove(handler);
    return () => { chart.unsubscribeCrosshairMove(handler); };
  }, [timeframe]);

  // ── Fetch OI history and compute delta candles ────────────────────────
  async function fetchOIHistory(
    symbol: string,
    tf: ChartTimeframe,
    series: ISeriesApi<'Candlestick'>,
  ) {
    try {
      const resp = await fetch(
        `${REST_BASE}/api/oi-history?symbol=${symbol}&period=${tf}&limit=500`,
      );
      if (!resp.ok) return;
      const bars = (await resp.json()) as OIHistoryBar[];
      if (!bars.length) return;

      // Compute cumulative OI delta from first bar
      const baseOI = bars[0]!.sumOpenInterestValue;
      let prevOIValue = baseOI;
      const candleData: CandlestickData[] = bars.map((b, i) => {
        const cumDelta = b.sumOpenInterestValue - baseOI;
        const prevCumDelta = i === 0 ? 0 : (prevOIValue - baseOI);
        const open = prevCumDelta;
        const close = cumDelta;
        prevOIValue = b.sumOpenInterestValue;
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

      // Legend güncelle
      if (bars.length > 0) {
        const lastDelta = bars[bars.length - 1]!.sumOpenInterestValue - baseOI;
        updateLegend(lastDelta);
      }
    } catch {
      // silent
    }
  }

  // ── Lejant DOM güncelleme ─────────────────────────────────────────────
  function updateLegend(cumulativeDelta: number): void {
    const el = legendRef.current;
    if (!el) return;
    const color = cumulativeDelta >= 0 ? COLOR_POS : COLOR_NEG;
    el.textContent = formatDelta(cumulativeDelta);
    el.style.color = color;
  }

  // ── RT subscription — OI updates ──────────────────────────────────────
  useEffect(() => {
    if (timeframe !== 'RT') return;

    const unsubscribeOI = marketStore.subscribe((state, prevState) => {
      if (currentTfRef.current !== 'RT') return;
      if (state.openInterest === prevState.openInterest) return;
      const oi = state.openInterest;
      if (!oi || oi.totalOI === 0) return;

      const series = baselineSeriesRef.current;
      if (!series) return;

      const timeSec = Math.floor(oi.timestamp / 1000) + TZ_OFFSET;

      if (initialTotalOIRef.current === null) {
        initialTotalOIRef.current = oi.totalOI;
      }

      const cumulativeDelta = oi.totalOI - initialTotalOIRef.current;
      lastCumulativeDeltaRef.current = cumulativeDelta;

      const last = lastPlottedRef.current;
      if (timeSec < last.time) return;
      if (timeSec === last.time && cumulativeDelta === last.value) return;

      lastPlottedRef.current = { time: timeSec, value: cumulativeDelta };

      try {
        series.update({ time: timeSec as UTCTimestamp, value: cumulativeDelta });
      } catch { /* */ }

      updateLegend(cumulativeDelta);
    });

    // CVD timestamp sync — keep X-axis aligned
    const unsubscribeCVD = marketStore.subscribe((state, prevState) => {
      if (currentTfRef.current !== 'RT') return;
      if (state.cvd === prevState.cvd && state.lastMessageAt === prevState.lastMessageAt) return;
      if (lastCumulativeDeltaRef.current === null) return;

      const series = baselineSeriesRef.current;
      if (!series) return;

      const now     = state.lastMessageAt || Date.now();
      const timeSec = Math.floor(now / 1000) + TZ_OFFSET;
      const val     = lastCumulativeDeltaRef.current;

      if (timeSec <= lastPlottedRef.current.time) return;

      lastPlottedRef.current = { time: timeSec, value: val };
      try {
        series.update({ time: timeSec as UTCTimestamp, value: val });
      } catch { /* */ }
    });

    return () => {
      unsubscribeOI();
      unsubscribeCVD();
    };
  }, [timeframe]);

  // ── Auto-refresh OI history every 15s for non-RT ──────────────────────
  useEffect(() => {
    if (timeframe === 'RT') return;

    const interval = setInterval(() => {
      const series = candleSeriesRef.current;
      if (!series) return;
      const symbol = marketStore.getState().currentSymbol;
      void fetchOIHistory(symbol, timeframe, series);
    }, 15_000);

    return () => clearInterval(interval);
  }, [timeframe]);

  return (
    <div style={{ width: '100%', height: '100%', background: '#000', position: 'relative' }}>
      <div
        ref={containerRef}
        style={{ width: '100%', height: '100%' }}
      />
      {/* Scroll to latest button */}
      {showScrollBtn && (
        <button
          onClick={() => {
            try { chartRef.current?.timeScale().scrollToRealTime(); } catch { /* */ }
            setShowScrollBtn(false);
          }}
          title="Scroll to latest"
          style={{
            position: 'absolute',
            bottom: 28,
            right: 8,
            zIndex: 20,
            background: 'rgba(40,40,40,0.9)',
            border: '1px solid #555',
            borderRadius: 4,
            color: '#ccc',
            fontSize: 14,
            fontWeight: 700,
            cursor: 'pointer',
            padding: '3px 10px',
            boxShadow: '0 2px 8px rgba(0,0,0,0.5)',
          }}
        >
          »
        </button>
      )}
      {/* ── Sol üst: Başlık lejantı ──────────────────────────────────────── */}
      <div
        style={{
          position: 'absolute',
          top: 4,
          left: 8,
          zIndex: 10,
          pointerEvents: 'none',
          fontFamily: 'monospace',
          fontSize: 10,
          color: '#555',
          letterSpacing: 0.5,
        }}
      >
        OI DELTA — CUMULATIVE NET FLOW
      </div>

      {/* ── OHLC legend (candlestick mode only) ─────────────────────────── */}
      {timeframe !== 'RT' && (
        <div
          ref={ohlcRef}
          style={{
            position: 'absolute',
            top: 18,
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

      {/* ── Sağ üst: Dinamik kümülatif delta — DOM ref ile güncellenir ─── */}
      <div
        ref={legendRef}
        style={{
          position: 'absolute',
          top: 4,
          right: 8,
          zIndex: 10,
          pointerEvents: 'none',
          fontFamily: 'monospace',
          fontSize: 11,
          fontWeight: 700,
          color: COLOR_POS,
          letterSpacing: 0.5,
        }}
      >
        +$0
      </div>
    </div>
  );
}

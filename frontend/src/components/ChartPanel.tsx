// ─────────────────────────────────────────────────────────────────────────────
// ChartPanel.tsx — Gerçek Zamanlı Çizgi (Line) Grafiği
// lightweight-charts v5 · 1 saniyelik noktalar · anlık price line
// ─────────────────────────────────────────────────────────────────────────────

import { useRef, useEffect, useCallback } from 'react';
import {
  createChart,
  LineSeries,
  ColorType,
  LineStyle,
} from 'lightweight-charts';
import type {
  IChartApi,
  ISeriesApi,
  UTCTimestamp,
  IPriceLine,
} from 'lightweight-charts';
import { marketStore } from '../stores/marketStore';
import type { UnifiedTrade } from '../stores/marketStore';

// ── Config ──────────────────────────────────────────────────────────────────
const TICK_INTERVAL_S = 1;            // 1 saniyelik noktalar

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

// ── Props ───────────────────────────────────────────────────────────────────
interface ChartPanelProps {
  onChartReady?: (chart: IChartApi) => void;
}

export default function ChartPanel({ onChartReady }: ChartPanelProps) {
  const containerRef   = useRef<HTMLDivElement>(null);
  const chartRef       = useRef<IChartApi | null>(null);
  const seriesRef      = useRef<ISeriesApi<'Line'> | null>(null);
  const priceLineRef   = useRef<IPriceLine | null>(null);
  const lastTickTime   = useRef(0);
  const prevTradeLen   = useRef(0);
  const precisionSet   = useRef(false);

  const chartReadyCb = useCallback((chart: IChartApi) => {
    if (onChartReady) onChartReady(chart);
  }, [onChartReady]);

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

    // ── Line Series — başlangıçta genel precision, ilk trade'de güncellenir
    const series = chart.addSeries(LineSeries, {
      color: '#2196F3',
      lineWidth: 2,
      crosshairMarkerVisible: true,
      crosshairMarkerRadius: 3,
      priceFormat: {
        type: 'price',
        precision: 2,
        minMove: 0.01,
      },
    });

    seriesRef.current = series;
    precisionSet.current = false;

    // ── Price Line ──────────────────────────────────────────────────────
    priceLineRef.current = series.createPriceLine({
      price: 0,
      color: '#ffaa00',
      lineWidth: 1,
      lineStyle: LineStyle.Dashed,
      axisLabelVisible: true,
      title: 'Last',
    });

    // ── ResizeObserver ──────────────────────────────────────────────────
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        if (width > 0 && height > 0) chart.resize(width, height);
      }
    });
    ro.observe(container);

    // ── Store subscription ──────────────────────────────────────────────
    const unsubscribe = marketStore.subscribe((state, prevState) => {
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

    chartReadyCb(chart);

    // ── Double-click → scrollToRealTime ─────────────────────────────────
    const handleDblClick = () => {
      try { chart.timeScale().scrollToRealTime(); } catch { /* */ }
    };
    container.addEventListener('dblclick', handleDblClick);

    return () => {
      container.removeEventListener('dblclick', handleDblClick);
      unsubscribe();
      ro.disconnect();
      chart.remove();
      chartRef.current  = null;
      seriesRef.current = null;
      priceLineRef.current = null;
      lastTickTime.current = 0;
      prevTradeLen.current = 0;
      precisionSet.current = false;
    };
  }, [chartReadyCb]);

  // ── Çizgi güncelleme ──────────────────────────────────────────────────
  function updateLine(trade: UnifiedTrade): void {
    const series = seriesRef.current;
    if (!series) return;

    const TZ_OFFSET    = 3 * 3600;
    const tradeTimeSec = Math.floor(trade.timestamp / 1000) + TZ_OFFSET;
    const tickTime     = tradeTimeSec - (tradeTimeSec % TICK_INTERVAL_S);
    const price        = trade.price;

    if (tickTime < lastTickTime.current) return;
    lastTickTime.current = tickTime;

    // İlk trade geldiğinde precision'ı fiyata göre ayarla
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
    <div
      ref={containerRef}
      style={{ width: '100%', height: '100%', background: '#000' }}
    />
  );
}

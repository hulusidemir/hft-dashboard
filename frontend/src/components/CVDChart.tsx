// ─────────────────────────────────────────────────────────────────────────────
// CVDChart.tsx — Kümülatif Hacim Deltası (CVD) Çizgi Grafiği
// lightweight-charts v5 · ChartPanel ile X-ekseni senkronize
// ─────────────────────────────────────────────────────────────────────────────

import { useRef, useEffect, useCallback } from 'react';
import {
  createChart,
  LineSeries,
  ColorType,
} from 'lightweight-charts';
import type {
  IChartApi,
  ISeriesApi,
  UTCTimestamp,
} from 'lightweight-charts';
import { marketStore } from '../stores/marketStore';

// ── Props ───────────────────────────────────────────────────────────────────
interface CVDChartProps {
  onChartReady?: (chart: IChartApi) => void;
}

// ── CVD veri noktası ────────────────────────────────────────────────────────
interface CVDPoint {
  time: number;   // UTC seconds
  value: number;  // kümülatif CVD
}

export default function CVDChart({ onChartReady }: CVDChartProps) {
  const containerRef   = useRef<HTMLDivElement>(null);
  const chartRef       = useRef<IChartApi | null>(null);
  const seriesRef      = useRef<ISeriesApi<'Line'> | null>(null);
  const lastPointRef   = useRef<CVDPoint | null>(null);

  const chartReadyCb = useCallback((chart: IChartApi) => {
    if (onChartReady) onChartReady(chart);
  }, [onChartReady]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    // ── Chart oluştur ───────────────────────────────────────────────────
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

    // ── Line Series — CVD çizgisi (turkuaz) ─────────────────────────────
    const series = chart.addSeries(LineSeries, {
      color:     '#00bcd4',    // turkuaz
      lineWidth: 2,
      priceFormat: {
        type: 'volume',
      },
      lastValueVisible: true,
      priceLineVisible: true,
    });

    seriesRef.current = series;

    // ── Zero Line — sıfır referans çizgisi ──────────────────────────────
    series.createPriceLine({
      price: 0,
      color: 'rgba(255,255,255,0.15)',
      lineWidth: 1,
      lineStyle: 2,   // Dashed
      axisLabelVisible: false,
      title: '',
    });

    // ── ResizeObserver ──────────────────────────────────────────────────
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        if (width > 0 && height > 0) {
          chart.resize(width, height);
        }
      }
    });
    ro.observe(container);

    // ── Store subscription — her CVD güncellemesinde çizgiyi güncelle ───
    const unsubscribe = marketStore.subscribe((state, prevState) => {
      if (state.cvd === prevState.cvd && state.lastMessageAt === prevState.lastMessageAt) return;

      const TZ_OFFSET   = 3 * 3600; // UTC+3 (Turkey)
      const now         = state.lastMessageAt || Date.now();
      const timeSec     = Math.floor(now / 1000) + TZ_OFFSET;
      const cvdValue    = state.cvd;

      const lastPt = lastPointRef.current;

      if (!lastPt || timeSec > lastPt.time) {
        // Yeni zaman noktası
        const point: CVDPoint = { time: timeSec, value: cvdValue };
        lastPointRef.current = point;
        try { series.update({ time: timeSec as UTCTimestamp, value: cvdValue }); } catch { /* stale ts */ }
      } else if (timeSec === lastPt.time) {
        // Aynı saniye — güncelle
        lastPt.value = cvdValue;
        try { series.update({ time: timeSec as UTCTimestamp, value: cvdValue }); } catch { /* stale ts */ }
      }
    });

    // expose chart
    chartReadyCb(chart);

    // ── Double-click → scrollToRealTime ─────────────────────────────────
    const handleDblClick = () => {
      try { chart.timeScale().scrollToRealTime(); } catch { /* chart removed */ }
    };
    container.addEventListener('dblclick', handleDblClick);

    // ── Cleanup ─────────────────────────────────────────────────────────
    return () => {
      container.removeEventListener('dblclick', handleDblClick);
      unsubscribe();
      ro.disconnect();
      chart.remove();
      chartRef.current   = null;
      seriesRef.current  = null;
      lastPointRef.current = null;
    };
  }, [chartReadyCb]);

  return (
    <div
      ref={containerRef}
      style={{ width: '100%', height: '100%', background: '#000' }}
    />
  );
}

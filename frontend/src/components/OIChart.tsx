// ─────────────────────────────────────────────────────────────────────────────
// OIChart.tsx — Kümülatif Para Akışı (Cumulative Net Flow) Monitörü
// lightweight-charts v5 · BaselineSeries · Sıfır tabanlı yeşil/kırmızı akış
// Plot = oi.totalOI - initialTotalOI  →  Lejant ≡ Plot (tek kaynak, sıfır sapma)
// ChartPanel/CVDChart ile X-ekseni senkronize (onChartReady callback)
// ─────────────────────────────────────────────────────────────────────────────

import { useRef, useEffect, useCallback } from 'react';
import {
  createChart,
  BaselineSeries,
  ColorType,
} from 'lightweight-charts';
import type {
  IChartApi,
  ISeriesApi,
  UTCTimestamp,
} from 'lightweight-charts';
import { marketStore } from '../stores/marketStore';

// ── Props ───────────────────────────────────────────────────────────────────
interface OIChartProps {
  onChartReady?: (chart: IChartApi) => void;
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

export default function OIChart({ onChartReady }: OIChartProps) {
  const containerRef      = useRef<HTMLDivElement>(null);
  const legendRef         = useRef<HTMLDivElement>(null);
  const chartRef          = useRef<IChartApi | null>(null);
  const seriesRef         = useRef<ISeriesApi<'Baseline'> | null>(null);
  const initialTotalOIRef    = useRef<number | null>(null);
  const lastCumulativeDeltaRef = useRef<number | null>(null);
  const lastPlottedRef        = useRef<{ time: number; value: number }>({ time: 0, value: 0 });

  const chartReadyCb = useCallback((chart: IChartApi) => {
    if (onChartReady) onChartReady(chart);
  }, [onChartReady]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    // Refs sıfırla (component remount veya effect re-run)
    initialTotalOIRef.current    = null;
    lastCumulativeDeltaRef.current = null;
    lastPlottedRef.current       = { time: 0, value: 0 };

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

    // ── Baseline Series — sıfır tabanlı kümülatif OI değişim eğrisi ─────
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

    seriesRef.current = series;

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

    // ── Lejant DOM güncelleme (React render bypass — sıfır gecikme) ─────
    function updateLegend(cumulativeDelta: number): void {
      const el = legendRef.current;
      if (!el) return;
      const color = cumulativeDelta >= 0 ? COLOR_POS : COLOR_NEG;
      el.textContent = formatDelta(cumulativeDelta);
      el.style.color = color;
    }

    // ── Store subscription — her OI güncellemesinde baseline güncelle ───
    const unsubscribe = marketStore.subscribe((state, prevState) => {
      if (state.openInterest === prevState.openInterest) return;
      const oi = state.openInterest;
      if (!oi || oi.totalOI === 0) return;

      const TZ_OFFSET = 3 * 3600; // UTC+3 (Turkey)
      const timeSec = Math.floor(oi.timestamp / 1000) + TZ_OFFSET;

      // İlk geçerli totalOI değerini referans noktası olarak kaydet
      if (initialTotalOIRef.current === null) {
        initialTotalOIRef.current = oi.totalOI;
      }

      // ── Tek Kaynak: Kümülatif delta — çizgi VE lejant bunu kullanır ──
      const cumulativeDelta = oi.totalOI - initialTotalOIRef.current;
      lastCumulativeDeltaRef.current = cumulativeDelta;

      // ── Optimization: sadece zaman ilerlediğinde güncelle ──────────────
      const last = lastPlottedRef.current;
      if (timeSec < last.time) return; // Geriye gitme yasak
      if (timeSec === last.time && cumulativeDelta === last.value) return;

      lastPlottedRef.current = { time: timeSec, value: cumulativeDelta };

      // Grafiğe bas
      try {
        series.update({
          time: timeSec as UTCTimestamp,
          value: cumulativeDelta,
        });
      } catch {
        // lightweight-charts "Cannot update oldest data" — ignore
      }

      // Lejantı aynı değerle güncelle — sıfır sapma
      updateLegend(cumulativeDelta);
    });

    // ── Double-click → scrollToRealTime ─────────────────────────────────
    const handleDblClick = () => {
      try { chart.timeScale().scrollToRealTime(); } catch { /* chart removed */ }
    };
    container.addEventListener('dblclick', handleDblClick);

    // ── CVD Zaman Damgası Aboneliği — OI'yi CVD ile byte-for-byte eşitle ─
    // CVD her güncellendiğinde (trade batch başına ~20/s), aynı zaman damgasını
    // OI grafiğine de basarak iki grafiğin X-ekseni indeksini birebir kilitler.
    const unsubscribeCVD = marketStore.subscribe((state, prevState) => {
      // CVD veya lastMessageAt değişmediyse atla
      if (state.cvd === prevState.cvd && state.lastMessageAt === prevState.lastMessageAt) return;
      // Henüz OI referans noktası yoksa atla
      if (lastCumulativeDeltaRef.current === null) return;

      const TZ_CVD = 3 * 3600; // UTC+3 (Turkey)
      const now    = state.lastMessageAt || Date.now();
      const timeSec = Math.floor(now / 1000) + TZ_CVD;
      const val    = lastCumulativeDeltaRef.current;

      // Aynı saniyeyi aynı değerle tekrar basma veya geriye gitme
      if (timeSec <= lastPlottedRef.current.time) return;

      lastPlottedRef.current = { time: timeSec, value: val };
      try {
        series.update({
          time: timeSec as UTCTimestamp,
          value: val,
        });
      } catch {
        // lightweight-charts "Cannot update oldest data" — ignore
      }
    });

    // expose chart for cross-sync
    chartReadyCb(chart);

    // ── Cleanup ─────────────────────────────────────────────────────────
    return () => {
      container.removeEventListener('dblclick', handleDblClick);
      unsubscribeCVD();
      unsubscribe();
      ro.disconnect();
      chart.remove();
      chartRef.current            = null;
      seriesRef.current           = null;
      initialTotalOIRef.current   = null;
      lastCumulativeDeltaRef.current = null;
      lastPlottedRef.current      = { time: 0, value: 0 };
    };
  }, [chartReadyCb]);

  return (
    <div
      ref={containerRef}
      style={{ width: '100%', height: '100%', background: '#000', position: 'relative' }}
    >
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

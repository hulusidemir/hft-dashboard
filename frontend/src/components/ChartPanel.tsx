// ─────────────────────────────────────────────────────────────────────────────
// ChartPanel.tsx — Gerçek Zamanlı Candlestick (Mum) Grafiği
// lightweight-charts v5 · 1 saniyelik mumlar · anlık price line
// ─────────────────────────────────────────────────────────────────────────────

import { useRef, useEffect, useCallback } from 'react';
import {
  createChart,
  CandlestickSeries,
  ColorType,
} from 'lightweight-charts';
import type {
  IChartApi,
  ISeriesApi,
  CandlestickData,
  UTCTimestamp,
  IPriceLine,
} from 'lightweight-charts';
import { marketStore } from '../stores/marketStore';
import type { UnifiedTrade } from '../stores/marketStore';

// ── Config ──────────────────────────────────────────────────────────────────
const CANDLE_INTERVAL_S = 1;          // 1 saniyelik mumlar

// ── Mum verisi tutma ────────────────────────────────────────────────────────
interface LiveCandle {
  time: number;   // UTC seconds — başlangıç zamanı
  open: number;
  high: number;
  low: number;
  close: number;
}

// ── Props ───────────────────────────────────────────────────────────────────
interface ChartPanelProps {
  onChartReady?: (chart: IChartApi) => void;
}

export default function ChartPanel({ onChartReady }: ChartPanelProps) {
  const containerRef   = useRef<HTMLDivElement>(null);
  const chartRef       = useRef<IChartApi | null>(null);
  const seriesRef      = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const priceLineRef   = useRef<IPriceLine | null>(null);
  const currentCandle  = useRef<LiveCandle | null>(null);
  const prevTradeLen   = useRef(0);

  // chart'ı dışarıya expose etmek için callback ref
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
        vertLines:   { color: 'rgba(255,255,255,0.04)' },
        horzLines:   { color: 'rgba(255,255,255,0.04)' },
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

    // ── Candlestick Series ──────────────────────────────────────────────
    const series = chart.addSeries(CandlestickSeries, {
      upColor:          '#26a69a',
      downColor:        '#ef5350',
      borderUpColor:    '#26a69a',
      borderDownColor:  '#ef5350',
      wickUpColor:      '#26a69a',
      wickDownColor:    '#ef5350',
    });

    seriesRef.current = series;

    // ── Price Line (anlık fiyat göstergesi) ─────────────────────────────
    priceLineRef.current = series.createPriceLine({
      price: 0,
      color: '#ffaa00',
      lineWidth: 1,
      lineStyle: 2,  // Dashed
      axisLabelVisible: true,
      title: 'Last',
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

    // ── Store subscription — her trade batch geldiğinde mum güncelle ────
    const unsubscribe = marketStore.subscribe((state, prevState) => {
      if (state.trades === prevState.trades) return;         // aynı referans → skip
      if (state.trades.length === 0) return;

      // Yeni gelen trade'leri bul
      const newCount = state.trades.length - prevTradeLen.current;
      prevTradeLen.current = state.trades.length;

      // trades dizisi başa ekleniyor (en yeni = index 0)
      // Yeni trade'ler: trades[0..newCount-1]
      const freshTrades = newCount > 0
        ? state.trades.slice(0, Math.min(newCount, state.trades.length))
        : state.trades.slice(0, 1);   // fallback: minimum 1 trade

      // Zaman sırasına çevir (eski → yeni)
      const sorted = [...freshTrades].reverse();

      for (const trade of sorted) {
        updateCandle(trade);
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
      chartRef.current  = null;
      seriesRef.current = null;
      priceLineRef.current = null;
      currentCandle.current = null;
      prevTradeLen.current = 0;
    };
  }, [chartReadyCb]);

  // ── Mum güncelleme mantığı ────────────────────────────────────────────
  function updateCandle(trade: UnifiedTrade): void {
    const series = seriesRef.current;
    if (!series) return;

    const TZ_OFFSET    = 3 * 3600; // UTC+3 (Turkey)
    const tradeTimeSec = Math.floor(trade.timestamp / 1000) + TZ_OFFSET;
    const candleTime   = tradeTimeSec - (tradeTimeSec % CANDLE_INTERVAL_S);
    const price        = trade.price;

    const candle = currentCandle.current;

    if (!candle || candleTime > candle.time) {
      // Yeni mum başlat
      const newCandle: LiveCandle = {
        time:  candleTime,
        open:  price,
        high:  price,
        low:   price,
        close: price,
      };
      currentCandle.current = newCandle;

      try {
        series.update({
          time:  candleTime as UTCTimestamp,
          open:  price,
          high:  price,
          low:   price,
          close: price,
        });
      } catch { /* stale ts */ }
    } else if (candleTime === candle.time) {
      // Mevcut mumu güncelle
      candle.close = price;
      if (price > candle.high) candle.high = price;
      if (price < candle.low)  candle.low  = price;

      try {
        series.update({
          time:  candle.time as UTCTimestamp,
          open:  candle.open,
          high:  candle.high,
          low:   candle.low,
          close: candle.close,
        });
      } catch { /* stale ts */ }
    }
    // else: geçmişe ait trade → yoksay

    // Price Line güncelle
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

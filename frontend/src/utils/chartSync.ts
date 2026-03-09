// ─────────────────────────────────────────────────────────────────────────────
// chartSync.ts — N adet lightweight-charts'ın X-ekseni senkronizasyonu
// ChartPanel ↔ CVDChart ↔ OIChart arası çok yönlü timeScale bağlantısı.
// ─────────────────────────────────────────────────────────────────────────────

import type { IChartApi, LogicalRange } from 'lightweight-charts';

/**
 * İki chart'ı birbirine bağlar.
 * Biri scroll/zoom yaptığında diğeri de aynı logical range'e geçer.
 * Dönen cleanup fn'ı useEffect return'ünde çağırılmalı.
 */
export function syncCharts(chartA: IChartApi, chartB: IChartApi): () => void {
  let isSyncing = false;

  const onAChange = (range: LogicalRange | null) => {
    if (isSyncing || !range) return;
    isSyncing = true;
    try {
      chartB.timeScale().setVisibleLogicalRange(range);
    } catch { /* ignore if chart removed */ }
    isSyncing = false;
  };

  const onBChange = (range: LogicalRange | null) => {
    if (isSyncing || !range) return;
    isSyncing = true;
    try {
      chartA.timeScale().setVisibleLogicalRange(range);
    } catch { /* ignore if chart removed */ }
    isSyncing = false;
  };

  chartA.timeScale().subscribeVisibleLogicalRangeChange(onAChange);
  chartB.timeScale().subscribeVisibleLogicalRangeChange(onBChange);

  return () => {
    chartA.timeScale().unsubscribeVisibleLogicalRangeChange(onAChange);
    chartB.timeScale().unsubscribeVisibleLogicalRangeChange(onBChange);
  };
}

/**
 * N adet chart'ı birbirine bağlar.
 * Herhangi birinde scroll/zoom olduğunda diğerleri de aynı logical range'e geçer.
 * Dönen cleanup fn tüm listener'ları temizler.
 */
export function syncMultipleCharts(charts: IChartApi[]): () => void {
  if (charts.length < 2) return () => {};

  let isSyncing = false;
  const handlers: Array<{ chart: IChartApi; handler: (range: LogicalRange | null) => void }> = [];

  for (const source of charts) {
    const handler = (range: LogicalRange | null) => {
      if (isSyncing || !range) return;
      isSyncing = true;
      for (const target of charts) {
        if (target === source) continue;
        try {
          target.timeScale().setVisibleLogicalRange(range);
        } catch { /* ignore if chart removed */ }
      }
      isSyncing = false;
    };

    source.timeScale().subscribeVisibleLogicalRangeChange(handler);
    handlers.push({ chart: source, handler });
  }

  return () => {
    for (const { chart, handler } of handlers) {
      try {
        chart.timeScale().unsubscribeVisibleLogicalRangeChange(handler);
      } catch { /* ignore */ }
    }
  };
}

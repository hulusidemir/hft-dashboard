import { useEffect, useRef, useCallback } from 'react';
import type { IChartApi } from 'lightweight-charts';
import { startMarketConnection, stopMarketConnection, useMarketStore } from './stores/marketStore';
import { syncMultipleCharts } from './utils/chartSync';
import HeatmapCanvas from './components/HeatmapCanvas';
import ChartPanel from './components/ChartPanel';
import CVDChart from './components/CVDChart';
import OIChart from './components/OIChart';
import TapeCanvas from './components/TapeCanvas';
import LiquidationFeed from './components/LiquidationFeed';
import SystemMonitor from './components/SystemMonitor';
import RadarPanel from './components/RadarPanel';
import CoinMRPanel from './components/CoinMRPanel';
import ExchangesPanel from './components/ExchangesPanel';
import TopBar from './components/TopBar';

// ── Status Bar (düşük frekanslı — React re-render güvenli) ──────────────────
function StatusBar() {
  const connected      = useMarketStore((s) => s.connected);
  const reconnectCount = useMarketStore((s) => s.reconnectCount);
  const isChanging     = useMarketStore((s) => s.isChangingSymbol);
  const oi             = useMarketStore((s) => s.openInterest);

  return (
    <div style={{
      height: 26,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      padding: '0 10px',
      background: '#0a0a0a',
      borderBottom: '1px solid #1a1a1a',
      fontFamily: 'Arial, sans-serif',
      fontSize: 10,
      color: '#888',
      flexShrink: 0,
    }}>
      <div style={{ display: 'flex', gap: 14, alignItems: 'center' }}>
        <span style={{ color: '#ff9900', fontWeight: 700, letterSpacing: 1 }}>
          SCALPING DASHBOARD
        </span>
        <TopBar />
        <span style={{
          color: connected ? (isChanging ? '#ffaa00' : '#50ff50') : '#ff5050',
          fontWeight: 600,
        }}>
          {!connected
            ? `○ OFFLINE${reconnectCount > 0 ? ` (retry ${reconnectCount})` : ''}`
            : isChanging
              ? '◌ SWITCHING...'
              : '● LIVE'}
        </span>
      </div>
      <div style={{ display: 'flex', gap: 14 }}>
        {oi && (
          <>
            <span>
              OI: <span style={{ color: '#ccc' }}>${formatCompact(oi.totalOI)}</span>
            </span>
            <span style={{ color: oi.deltaOI >= 0 ? '#50ff50' : '#ff5050' }}>
              Δ {oi.deltaOI >= 0 ? '+' : ''}{formatCompact(oi.deltaOI)}
              {' '}({oi.deltaOIPercent >= 0 ? '+' : ''}{oi.deltaOIPercent.toFixed(2)}%)
            </span>
          </>
        )}
      </div>
    </div>
  );
}

function formatCompact(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1e9) return (n / 1e9).toFixed(2) + 'B';
  if (abs >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  if (abs >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return n.toFixed(0);
}

// ── Panel Label ─────────────────────────────────────────────────────────────
function PanelLabel({ text }: { text: string }) {
  return (
    <div style={{
      height: 18,
      display: 'flex',
      alignItems: 'center',
      padding: '0 6px',
      background: '#0a0a0a',
      borderBottom: '1px solid #1a1a1a',
      fontSize: 9,
      fontWeight: 600,
      color: '#444',
      letterSpacing: 1,
      textTransform: 'uppercase' as const,
      flexShrink: 0,
    }}>
      {text}
    </div>
  );
}

// ── App Root — Bloomberg Terminal CSS Grid Layout ────────────────────────────
//
// ┌────────────────────────────────────────────────────────────────────────┐
// │ StatusBar                                                              │
// ├──────────────┬──────────────────────────────────┬─────────────────────┤
// │ SystemMonitor│  CHART · Candlestick 1s (60%h)   │  LIQUIDATIONS (30%) │
// │              ├──────────────────────────────────┤                     │
// │  HEATMAP     │  CVD · Volume Delta    (20%h)    ├─────────────────────┤
// │  LOB (25%w)  ├──────────────────────────────────┤  TAPE (70%)         │
// │              │  OI · Open Interest    (20%h)    │  Time & Sales       │
// └──────────────┴──────────────────────────────────┴─────────────────────┘

function App() {
  const currentSymbol = useMarketStore((s) => s.currentSymbol);
  const activeView    = useMarketStore((s) => s.activeView);

  const priceChartRef = useRef<IChartApi | null>(null);
  const cvdChartRef   = useRef<IChartApi | null>(null);
  const oiChartRef    = useRef<IChartApi | null>(null);
  const syncCleanup   = useRef<(() => void) | null>(null);

  useEffect(() => {
    startMarketConnection();
    return () => {
      stopMarketConnection();
      if (syncCleanup.current) syncCleanup.current();
    };
  }, []);

  // 3 chart hazır olduğunda N-yönlü senkronize et
  const trySync = useCallback(() => {
    const charts: IChartApi[] = [];
    if (priceChartRef.current) charts.push(priceChartRef.current);
    if (cvdChartRef.current)   charts.push(cvdChartRef.current);
    if (oiChartRef.current)    charts.push(oiChartRef.current);

    if (charts.length >= 2) {
      if (syncCleanup.current) syncCleanup.current();
      syncCleanup.current = syncMultipleCharts(charts);
    }
  }, []);

  const onPriceChartReady = useCallback((chart: IChartApi) => {
    priceChartRef.current = chart;
    trySync();
  }, [trySync]);

  const onCVDChartReady = useCallback((chart: IChartApi) => {
    cvdChartRef.current = chart;
    trySync();
  }, [trySync]);

  const onOIChartReady = useCallback((chart: IChartApi) => {
    oiChartRef.current = chart;
    trySync();
  }, [trySync]);

  return (
    <div style={{
      width: '100vw',
      height: '100vh',
      display: 'flex',
      flexDirection: 'column',
      background: '#060606',
      overflow: 'hidden',
    }}>
      {/* ── Status Bar ─────────────────────────────────────────────── */}
      <StatusBar />

      {/* ── RADAR View ──────────────────────────────────────────────── */}
      {activeView === 'radar' && (
        <div style={{ flex: 1, minHeight: 0, overflow: 'hidden' }}>
          <RadarPanel />
        </div>
      )}
      {/* ── COIN MR View ──────────────────────────────────────────────────── */}
      {activeView === 'mr' && (
        <div style={{ flex: 1, minHeight: 0, overflow: 'hidden' }}>
          <CoinMRPanel />
        </div>
      )}
      {/* ── EXCHANGES View ─────────────────────────────────────────────────── */}
      {activeView === 'exchanges' && (
        <div style={{ flex: 1, minHeight: 0, overflow: 'hidden' }}>
          <ExchangesPanel />
        </div>
      )}
      {/* ── Main Grid: 3 sütun (display:none ile gizle — WS kopmaz) ── */}
      <div style={{
        flex: 1,
        minHeight: 0,
        display: activeView === 'dashboard' ? 'grid' : 'none',
        gridTemplateColumns: '25% 1fr 20%',
        gridTemplateRows: '1fr',
        gap: 0,
      }}>

        {/* ═══════════ SOL SÜTUN (25%): SystemMonitor + LOB ═══════════ */}
        <div style={{
          display: 'flex',
          flexDirection: 'column',
          borderRight: '1px solid #1a1a1a',
          minWidth: 0,
          minHeight: 0,
          overflow: 'hidden',
        }}>
          {/* SystemMonitor — üst köşe */}
          <div style={{
            borderBottom: '1px solid #1a1a1a',
            flexShrink: 0,
          }}>
            <PanelLabel text="System · Health Monitor" />
            <SystemMonitor />
          </div>

          {/* LOB Isı Haritası — kalan alan */}
          <PanelLabel text="LOB · Order Book Heatmap" />
          <div style={{ flex: 1, minHeight: 0 }}>
            <HeatmapCanvas key={currentSymbol} />
          </div>
        </div>

        {/* ═══════════ ORTA SÜTUN (55%): Chart + CVD + OI ═════════════ */}
        <div style={{
          display: 'flex',
          flexDirection: 'column',
          borderRight: '1px solid #1a1a1a',
          minWidth: 0,
          minHeight: 0,
          overflow: 'hidden',
        }}>
          {/* Candlestick — %60 yükseklik */}
          <PanelLabel text="Price · Line 1s" />
          <div style={{ flex: 6, minHeight: 0 }}>
            <ChartPanel key={currentSymbol} onChartReady={onPriceChartReady} />
          </div>

          {/* CVD — %20 yükseklik */}
          <div style={{ borderTop: '1px solid #1a1a1a', flexShrink: 0 }}>
            <PanelLabel text="CVD · Cumulative Volume Delta" />
          </div>
          <div style={{ flex: 2, minHeight: 0 }}>
            <CVDChart key={currentSymbol} onChartReady={onCVDChartReady} />
          </div>

          {/* OI — %20 yükseklik */}
          <div style={{ borderTop: '1px solid #1a1a1a', flexShrink: 0 }}>
            <PanelLabel text="OI · Open Interest" />
          </div>
          <div style={{ flex: 2, minHeight: 0 }}>
            <OIChart key={currentSymbol} onChartReady={onOIChartReady} />
          </div>
        </div>

        {/* ═══════════ SAĞ SÜTUN (20%): Liquidations + Tape ═══════════ */}
        <div style={{
          display: 'flex',
          flexDirection: 'column',
          minWidth: 0,
          minHeight: 0,
          overflow: 'hidden',
        }}>
          {/* Liquidation Feed — %30 yükseklik */}
          <PanelLabel text="Liquidations · Margin Calls" />
          <div style={{
            flex: 3,
            minHeight: 0,
            borderBottom: '1px solid #1a1a1a',
          }}>
            <LiquidationFeed key={currentSymbol} />
          </div>

          {/* Tape — %70 yükseklik */}
          <PanelLabel text="Tape · Time & Sales" />
          <div style={{ flex: 7, minHeight: 0 }}>
            <TapeCanvas key={currentSymbol} />
          </div>
        </div>
      </div>
    </div>
  );
}

export default App;

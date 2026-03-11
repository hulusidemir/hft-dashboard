// ─────────────────────────────────────────────────────────────────────────────
// components/CoinMRPanel.tsx — COIN MR (Market Reconnaissance) Paneli
// ─────────────────────────────────────────────────────────────────────────────
// Operasyon öncesi piyasa röntgeni: 3 borsadan tarihsel analiz.
//   ÜST: Kümülatif Özet Kartları
//   ORTA: Borsa Kırılım Tablosu (Binance | Bybit | OKX)
//   ALT: Kümülatif Depth Chart (Dağ Grafiği)
//   EN ALT: Dashboard'a dönüş butonu
// ─────────────────────────────────────────────────────────────────────────────

import { useState, useEffect, useRef, useCallback } from 'react';
import { useMarketStore, setActiveView } from '../stores/marketStore';

const REST_BASE = 'http://localhost:9000';

// ── Tipler ─────────────────────────────────────────────────────────────────

interface ExchangeMrData {
  openInterest: number;
  oiDelta: number;
  fundingRate: number;
  nextFundingTime: number;
  fundingIntervalHours: number;
  longShortRatio: number;
  longRatio: number;
  shortRatio: number;
  liqLongUsd: number;
  liqShortUsd: number;
  liqEstimated: boolean;
  netCvd: number;
  orderbookBids: [number, number][];
  orderbookAsks: [number, number][];
}

interface AggregatedMrData {
  totalOI: number;
  oiDelta: number;
  avgFunding: number;
  nearestFundingTime: number;
  combinedLongRatio: number;
  combinedShortRatio: number;
  combinedLongShortRatio: number;
  totalLiqLongUsd: number;
  totalLiqShortUsd: number;
  totalNetCvd: number;
  combinedOrderbookBids: [number, number][];
  combinedOrderbookAsks: [number, number][];
}

interface MrResult {
  symbol: string;
  timeframe: string;
  timestamp: number;
  exchanges: {
    binance: ExchangeMrData;
    bybit: ExchangeMrData;
    okx: ExchangeMrData;
  };
  aggregated: AggregatedMrData;
}

type Timeframe = '15m' | '1h' | '4h' | '24h';

// ── Yardımcılar ─────────────────────────────────────────────────────────────

function fmt(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1e9) return (n / 1e9).toFixed(2) + 'B';
  if (abs >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  if (abs >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return n.toFixed(0);
}

function fmtUsd(n: number): string {
  return '$' + fmt(n);
}

function fmtPct(n: number): string {
  return (n * 100).toFixed(4) + '%';
}

function fmtRatio(n: number): string {
  return n.toFixed(2);
}

/** ms epoch → "2h 15m 30s" countdown string */
function fmtCountdown(targetMs: number, nowMs: number): string {
  const diff = targetMs - nowMs;
  if (diff <= 0) return 'NOW';
  const h = Math.floor(diff / 3_600_000);
  const m = Math.floor((diff % 3_600_000) / 60_000);
  const s = Math.floor((diff % 60_000) / 1_000);
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

// ── Component ───────────────────────────────────────────────────────────────

export default function CoinMRPanel() {
  const currentSymbol = useMarketStore((s) => s.currentSymbol);
  const [timeframe, setTimeframe] = useState<Timeframe>('1h');
  const [data, setData] = useState<MrResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  const depthCanvasRef = useRef<HTMLCanvasElement>(null);

  // ── 1s tick for funding countdown ───────────────────────────────────────
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  // ── Data fetch ──────────────────────────────────────────────────────────
  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${REST_BASE}/api/mr?symbol=${currentSymbol}&tf=${timeframe}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json() as MrResult;
      setData(json);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [currentSymbol, timeframe]);

  useEffect(() => {
    void fetchData();
  }, [fetchData]);

  // ── Depth Chart Canvas ──────────────────────────────────────────────────
  useEffect(() => {
    if (!data || !depthCanvasRef.current) return;
    drawDepthChart(depthCanvasRef.current, data.aggregated.combinedOrderbookBids, data.aggregated.combinedOrderbookAsks);
  }, [data]);

  const baseCoin = currentSymbol.replace(/USDT$/i, '');
  const TIMEFRAMES: Timeframe[] = ['15m', '1h', '4h', '24h'];

  return (
    <div style={{
      width: '100%',
      height: '100%',
      background: '#060606',
      overflow: 'auto',
      fontFamily: 'monospace',
      color: '#ccc',
      display: 'flex',
      flexDirection: 'column',
    }}>

      {/* ═══════════ HEADER ═══════════════════════════════════════════════ */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '12px 20px',
        borderBottom: '1px solid #1a1a1a',
        flexShrink: 0,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
          <span style={{ fontSize: 18, fontWeight: 900, color: '#ff9900', letterSpacing: 2 }}>
            🩻 COIN MR
          </span>
          <span style={{ fontSize: 14, color: '#888' }}>
            <span style={{ color: '#ff9900', fontWeight: 700 }}>{baseCoin}</span>/USDT
          </span>
        </div>

        {/* Zaman Dilimi Seçici */}
        <div style={{ display: 'flex', gap: 4 }}>
          {TIMEFRAMES.map((tf) => (
            <button
              key={tf}
              onClick={() => setTimeframe(tf)}
              style={{
                background: timeframe === tf ? '#ff9900' : '#1a1a1a',
                border: `1px solid ${timeframe === tf ? '#ff9900' : '#333'}`,
                borderRadius: 4,
                padding: '4px 14px',
                cursor: 'pointer',
                fontFamily: 'monospace',
                fontSize: 12,
                fontWeight: 800,
                letterSpacing: 1,
                color: timeframe === tf ? '#000' : '#666',
                transition: 'all 0.15s',
              }}
            >
              {tf.toUpperCase()}
            </button>
          ))}
          <button
            onClick={fetchData}
            disabled={loading}
            style={{
              background: '#111',
              border: '1px solid #333',
              borderRadius: 4,
              padding: '4px 12px',
              cursor: loading ? 'wait' : 'pointer',
              fontFamily: 'monospace',
              fontSize: 11,
              color: '#888',
              marginLeft: 8,
            }}
          >
            {loading ? '⟳ ...' : '↻ REFRESH'}
          </button>
        </div>
      </div>

      {/* ═══════════ LOADING / ERROR ════════════════════════════════════ */}
      {loading && !data && (
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 16, color: '#ff9900' }}>
          <span style={{ animation: 'blink 0.8s infinite' }}>⟳ Veriler çekiliyor...</span>
        </div>
      )}

      {error && (
        <div style={{ padding: 20, color: '#ff4444', textAlign: 'center', fontSize: 13 }}>
          ⚠ Hata: {error}
        </div>
      )}

      {data && (
        <div style={{ flex: 1, overflow: 'auto', padding: '16px 20px' }}>

          {/* ═══════════ ÜST BÖLÜM — AGGREGATED ÖZET KARTLARI ═════════ */}
          <SectionTitle text="AGGREGATED SUMMARY" />
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
            gap: 12,
            marginBottom: 24,
          }}>
            <SummaryCard
              label="Net CVD (Para Girişi)"
              value={fmtUsd(data.aggregated.totalNetCvd)}
              color={data.aggregated.totalNetCvd >= 0 ? '#50ff50' : '#ff5050'}
              large
            />
            <SummaryCard
              label="Total Open Interest"
              value={fmtUsd(data.aggregated.totalOI)}
              sub={`${timeframe.toUpperCase()} Δ: ${data.aggregated.oiDelta >= 0 ? '+' : ''}${fmtUsd(data.aggregated.oiDelta)}`}
              color="#00bfff"
              subColor={data.aggregated.oiDelta >= 0 ? '#50ff50' : '#ff5050'}
              large
            />
            <SummaryCard
              label="Avg Funding Rate"
              value={fmtPct(data.aggregated.avgFunding)}
              color={data.aggregated.avgFunding >= 0 ? '#50ff50' : '#ff5050'}
              sub={data.aggregated.nearestFundingTime > 0
                ? `Next: ${fmtCountdown(data.aggregated.nearestFundingTime, now)}`
                : undefined}
              subColor="#ff9900"
              large
            />
            <SummaryCard
              label="Long/Short Ratio"
              value={fmtRatio(data.aggregated.combinedLongShortRatio)}
              sub={`L: ${(data.aggregated.combinedLongRatio * 100).toFixed(1)}% | S: ${(data.aggregated.combinedShortRatio * 100).toFixed(1)}%`}
              color={data.aggregated.combinedLongShortRatio >= 1 ? '#50ff50' : '#ff5050'}
              large
            />
            <SummaryCard
              label="Liquidated Longs"
              value={fmtUsd(data.aggregated.totalLiqLongUsd)}
              color="#ff5050"
              large
            />
            <SummaryCard
              label="Liquidated Shorts"
              value={fmtUsd(data.aggregated.totalLiqShortUsd)}
              color="#50ff50"
              large
            />
          </div>

          {/* ═══════════ ORTA BÖLÜM — BORSA KIRILIM TABLOSU ═══════════ */}
          <SectionTitle text="EXCHANGE BREAKDOWN" />
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(3, 1fr)',
            gap: 12,
            marginBottom: 24,
          }}>
            <ExchangeColumn label="BINANCE" data={data.exchanges.binance} color="#f0b90b" now={now} />
            <ExchangeColumn label="BYBIT" data={data.exchanges.bybit} color="#ff6600" now={now} />
            <ExchangeColumn label="OKX" data={data.exchanges.okx} color="#00e5ff" now={now} />
          </div>

          {/* ═══════════ ALT BÖLÜM — KÜMÜLATİF DEPTH CHART ═══════════ */}
          <SectionTitle text="COMBINED DEPTH CHART" />
          <div style={{
            background: '#0a0a12',
            border: '1px solid #1a1a2e',
            borderRadius: 8,
            padding: 8,
            marginBottom: 24,
          }}>
            <canvas
              ref={depthCanvasRef}
              style={{ width: '100%', height: 320, display: 'block' }}
            />
          </div>

          {/* ═══════════ DASHBOARD'A DÖNÜŞ BUTONU ═══════════════════════ */}
          <button
            onClick={() => setActiveView('dashboard')}
            style={{
              width: '100%',
              padding: '18px 0',
              background: 'linear-gradient(135deg, #ff8c00, #ff6000)',
              border: 'none',
              borderRadius: 10,
              cursor: 'pointer',
              fontFamily: 'monospace',
              fontSize: 18,
              fontWeight: 900,
              letterSpacing: 3,
              color: '#000',
              marginBottom: 20,
              transition: 'transform 0.1s, box-shadow 0.15s',
              boxShadow: '0 4px 24px rgba(255,140,0,0.3)',
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.transform = 'scale(1.01)';
              e.currentTarget.style.boxShadow = '0 6px 32px rgba(255,140,0,0.5)';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.transform = 'scale(1)';
              e.currentTarget.style.boxShadow = '0 4px 24px rgba(255,140,0,0.3)';
            }}
          >
            İSTİHBARAT TAMAM — OPERASYONA (DASHBOARD) GEÇ
          </button>
        </div>
      )}

      <style>{`
        @keyframes blink {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.3; }
        }
      `}</style>
    </div>
  );
}

// ── Alt Bileşenler ───────────────────────────────────────────────────────────

function SectionTitle({ text }: { text: string }) {
  return (
    <div style={{
      fontSize: 11,
      fontWeight: 800,
      letterSpacing: 2,
      color: '#555',
      marginBottom: 10,
      borderBottom: '1px solid #1a1a1a',
      paddingBottom: 6,
    }}>
      {text}
    </div>
  );
}

function SummaryCard({ label, value, color, sub, subColor, large }: {
  label: string;
  value: string;
  color: string;
  sub?: string;
  subColor?: string;
  large?: boolean;
}) {
  return (
    <div style={{
      background: '#0a0a14',
      border: '1px solid #1a1a2e',
      borderRadius: 8,
      padding: large ? '16px 18px' : '10px 14px',
      display: 'flex',
      flexDirection: 'column',
      gap: 4,
    }}>
      <div style={{ fontSize: 9, color: '#666', letterSpacing: 1, textTransform: 'uppercase' }}>
        {label}
      </div>
      <div style={{
        fontSize: large ? 26 : 18,
        fontWeight: 900,
        color,
        letterSpacing: 1,
      }}>
        {value}
      </div>
      {sub && (
        <div style={{ fontSize: 10, color: subColor ?? '#888', fontWeight: subColor ? 700 : 400 }}>{sub}</div>
      )}
    </div>
  );
}

function ExchangeColumn({ label, data, color, now }: {
  label: string;
  data: ExchangeMrData;
  color: string;
  now: number;
}) {
  return (
    <div style={{
      background: '#0a0a14',
      border: '1px solid #1a1a2e',
      borderRadius: 8,
      padding: '14px 16px',
    }}>
      <div style={{
        fontSize: 13,
        fontWeight: 900,
        color,
        letterSpacing: 2,
        marginBottom: 12,
        textAlign: 'center',
        borderBottom: `2px solid ${color}33`,
        paddingBottom: 8,
      }}>
        {label}
      </div>

      <ExchangeRow label="Open Interest" value={fmtUsd(data.openInterest)} />
      <ExchangeRow label="OI Delta" value={`${data.oiDelta >= 0 ? '+' : ''}${fmtUsd(data.oiDelta)}`} color={data.oiDelta >= 0 ? '#50ff50' : '#ff5050'} />
      <ExchangeRow label="Funding Rate" value={fmtPct(data.fundingRate)} color={data.fundingRate >= 0 ? '#50ff50' : '#ff5050'} />
      <ExchangeRow
        label="Next Funding"
        value={data.nextFundingTime > 0 ? fmtCountdown(data.nextFundingTime, now) : '—'}
        color="#ff9900"
      />
      <ExchangeRow
        label="Funding Interval"
        value={data.fundingIntervalHours > 0 ? `${data.fundingIntervalHours}h` : '—'}
        color="#888"
      />
      <ExchangeRow label="Net CVD" value={fmtUsd(data.netCvd)} color={data.netCvd >= 0 ? '#50ff50' : '#ff5050'} />
      <ExchangeRow label="L/S Ratio" value={fmtRatio(data.longShortRatio)} color={data.longShortRatio >= 1 ? '#50ff50' : '#ff5050'} />
      <ExchangeRow label="Long %" value={(data.longRatio * 100).toFixed(1) + '%'} color="#50ff50" />
      <ExchangeRow label="Short %" value={(data.shortRatio * 100).toFixed(1) + '%'} color="#ff5050" />

      <div style={{ height: 1, background: '#1a1a2e', margin: '8px 0' }} />

      <ExchangeRow
        label={data.liqEstimated ? 'Liq. Longs ~' : 'Liq. Longs'}
        value={fmtUsd(data.liqLongUsd)}
        color="#ff5050"
      />
      <ExchangeRow
        label={data.liqEstimated ? 'Liq. Shorts ~' : 'Liq. Shorts'}
        value={fmtUsd(data.liqShortUsd)}
        color="#50ff50"
      />
      {data.liqEstimated && (
        <div style={{ fontSize: 8, color: '#555', textAlign: 'right', marginTop: 2 }}>
          OI ağırlıklı tahmin (API yok)
        </div>
      )}
    </div>
  );
}

function ExchangeRow({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div style={{
      display: 'flex',
      justifyContent: 'space-between',
      alignItems: 'center',
      padding: '4px 0',
      fontSize: 11,
    }}>
      <span style={{ color: '#777' }}>{label}</span>
      <span style={{ color: color ?? '#ccc', fontWeight: 700 }}>{value}</span>
    </div>
  );
}

// ── Depth Chart çizim fonksiyonu ────────────────────────────────────────────

function drawDepthChart(
  canvas: HTMLCanvasElement,
  bids: [number, number][],
  asks: [number, number][],
) {
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  const W = rect.width;
  const H = 320;

  canvas.width = W * dpr;
  canvas.height = H * dpr;
  canvas.style.height = H + 'px';

  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, W, H);

  if (bids.length === 0 && asks.length === 0) {
    ctx.fillStyle = '#555';
    ctx.font = '12px monospace';
    ctx.textAlign = 'center';
    ctx.fillText('No orderbook data', W / 2, H / 2);
    return;
  }

  // Sort: bids descending, asks ascending
  const sortedBids = [...bids].sort((a, b) => b[0] - a[0]);
  const sortedAsks = [...asks].sort((a, b) => a[0] - b[0]);

  // Cumulative volumes
  const bidCum: { price: number; vol: number }[] = [];
  let cumVol = 0;
  for (const [p, q] of sortedBids) {
    cumVol += q;
    bidCum.push({ price: p, vol: cumVol });
  }

  const askCum: { price: number; vol: number }[] = [];
  cumVol = 0;
  for (const [p, q] of sortedAsks) {
    cumVol += q;
    askCum.push({ price: p, vol: cumVol });
  }

  // Ranges
  const midPrice = sortedBids.length > 0 && sortedAsks.length > 0
    ? (sortedBids[0]![0] + sortedAsks[0]![0]) / 2
    : (sortedBids[0]?.[0] ?? sortedAsks[0]?.[0] ?? 0);

  // Show ±2.5% from mid
  const range = midPrice * 0.025;
  const minPrice = midPrice - range;
  const maxPrice = midPrice + range;
  const maxVol = Math.max(
    ...bidCum.filter(b => b.price >= minPrice).map(b => b.vol),
    ...askCum.filter(a => a.price <= maxPrice).map(a => a.vol),
    1,
  );

  const PAD = 40;
  const chartW = W - PAD * 2;
  const chartH = H - 50;

  const priceToX = (p: number) => PAD + ((p - minPrice) / (maxPrice - minPrice)) * chartW;
  const volToY = (v: number) => 20 + chartH - (v / maxVol) * chartH;

  // Grid lines
  ctx.strokeStyle = '#151520';
  ctx.lineWidth = 0.5;
  for (let i = 0; i <= 4; i++) {
    const y = 20 + (chartH / 4) * i;
    ctx.beginPath(); ctx.moveTo(PAD, y); ctx.lineTo(W - PAD, y); ctx.stroke();
  }

  // Mid price line
  const midX = priceToX(midPrice);
  ctx.strokeStyle = '#ff990044';
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 4]);
  ctx.beginPath(); ctx.moveTo(midX, 20); ctx.lineTo(midX, 20 + chartH); ctx.stroke();
  ctx.setLineDash([]);

  ctx.fillStyle = '#ff9900';
  ctx.font = '10px monospace';
  ctx.textAlign = 'center';
  ctx.fillText(`Mid: $${midPrice.toFixed(2)}`, midX, 14);

  // Draw bid mountain (green)
  const filteredBids = bidCum.filter(b => b.price >= minPrice && b.price <= maxPrice);
  if (filteredBids.length > 0) {
    ctx.beginPath();
    ctx.moveTo(priceToX(filteredBids[0]!.price), volToY(0));

    for (const b of filteredBids) {
      ctx.lineTo(priceToX(b.price), volToY(b.vol));
    }

    ctx.lineTo(priceToX(filteredBids[filteredBids.length - 1]!.price), volToY(0));
    ctx.closePath();

    const bidGrad = ctx.createLinearGradient(0, 20, 0, 20 + chartH);
    bidGrad.addColorStop(0, 'rgba(80, 255, 80, 0.35)');
    bidGrad.addColorStop(1, 'rgba(80, 255, 80, 0.02)');
    ctx.fillStyle = bidGrad;
    ctx.fill();

    ctx.strokeStyle = '#50ff50';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    for (let i = 0; i < filteredBids.length; i++) {
      const b = filteredBids[i]!;
      if (i === 0) ctx.moveTo(priceToX(b.price), volToY(b.vol));
      else ctx.lineTo(priceToX(b.price), volToY(b.vol));
    }
    ctx.stroke();
  }

  // Draw ask mountain (red)
  const filteredAsks = askCum.filter(a => a.price >= minPrice && a.price <= maxPrice);
  if (filteredAsks.length > 0) {
    ctx.beginPath();
    ctx.moveTo(priceToX(filteredAsks[0]!.price), volToY(0));

    for (const a of filteredAsks) {
      ctx.lineTo(priceToX(a.price), volToY(a.vol));
    }

    ctx.lineTo(priceToX(filteredAsks[filteredAsks.length - 1]!.price), volToY(0));
    ctx.closePath();

    const askGrad = ctx.createLinearGradient(0, 20, 0, 20 + chartH);
    askGrad.addColorStop(0, 'rgba(255, 80, 80, 0.35)');
    askGrad.addColorStop(1, 'rgba(255, 80, 80, 0.02)');
    ctx.fillStyle = askGrad;
    ctx.fill();

    ctx.strokeStyle = '#ff5050';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    for (let i = 0; i < filteredAsks.length; i++) {
      const a = filteredAsks[i]!;
      if (i === 0) ctx.moveTo(priceToX(a.price), volToY(a.vol));
      else ctx.lineTo(priceToX(a.price), volToY(a.vol));
    }
    ctx.stroke();
  }

  // Find biggest walls (top 3 single levels by qty) and label them
  const allLevels = [
    ...bids.filter(b => b[0] >= minPrice && b[0] <= maxPrice).map(b => ({ price: b[0], qty: b[1], side: 'bid' as const })),
    ...asks.filter(a => a[0] >= minPrice && a[0] <= maxPrice).map(a => ({ price: a[0], qty: a[1], side: 'ask' as const })),
  ];
  allLevels.sort((a, b) => b.qty - a.qty);
  const topWalls = allLevels.slice(0, 5);
  const labelMinGap = 65; // px minimum horizontal gap between labels
  const placedLabelXs: number[] = [];

  for (const wall of topWalls) {
    const wx = priceToX(wall.price);

    // Draw vertical line always
    ctx.strokeStyle = wall.side === 'bid' ? '#50ff5033' : '#ff505033';
    ctx.lineWidth = 0.5;
    ctx.beginPath(); ctx.moveTo(wx, 20); ctx.lineTo(wx, 20 + chartH); ctx.stroke();

    // Skip label if overlaps with already placed one
    if (placedLabelXs.some(px => Math.abs(px - wx) < labelMinGap)) continue;
    placedLabelXs.push(wx);

    const wy = 20 + chartH * 0.1;
    ctx.fillStyle = wall.side === 'bid' ? '#50ff50aa' : '#ff5050aa';
    ctx.font = 'bold 9px monospace';
    ctx.textAlign = 'center';
    ctx.fillText(`$${wall.price.toFixed(0)}`, wx, wy - 6);
    ctx.fillText(`${fmt(wall.qty)}`, wx, wy + 6);
  }

  // Price axis labels — adaptive count to prevent overlap
  ctx.fillStyle = '#555';
  ctx.font = '9px monospace';
  ctx.textAlign = 'center';
  const pxPerLabel = 80;
  const labelCount = Math.max(3, Math.min(8, Math.floor(chartW / pxPerLabel)));
  for (let i = 0; i <= labelCount; i++) {
    const p = minPrice + ((maxPrice - minPrice) / labelCount) * i;
    const x = priceToX(p);
    ctx.fillText('$' + p.toFixed(0), x, 20 + chartH + 14);
  }

  // Vol axis labels
  ctx.textAlign = 'right';
  for (let i = 0; i <= 4; i++) {
    const v = (maxVol / 4) * (4 - i);
    const y = 20 + (chartH / 4) * i;
    ctx.fillText(fmt(v), PAD - 4, y + 3);
  }
}

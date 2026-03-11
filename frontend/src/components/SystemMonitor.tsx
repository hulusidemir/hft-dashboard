// ─────────────────────────────────────────────────────────────────────────────
// SystemMonitor.tsx — Gecikme ve Sağlık Radarı
// Frontend ↔ Backend WS round-trip ping ölçümü + bağlantı durumu
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useState } from 'react';
import { useMarketStore, marketStore } from '../stores/marketStore';

// ── Config ──────────────────────────────────────────────────────────────────
const STALE_THRESHOLD = 5000;  // 5s veri gelmezse "stale" sayılır

// ── Gecikme renk mantığı ────────────────────────────────────────────────────
function latencyColor(ms: number | null): string {
  if (ms === null) return '#ff0000';  // bağlantı yok
  if (ms < 50)  return '#00ff66';     // yeşil
  if (ms < 150) return '#ffaa00';     // sarı
  return '#ff0000';                   // kırmızı
}

function latencyLabel(ms: number | null): string {
  if (ms === null) return '---';
  return ms.toFixed(0) + 'ms';
}

// ── Gösterge noktası ────────────────────────────────────────────────────────
function Dot({ color, blink }: { color: string; blink: boolean }) {
  return (
    <span style={{
      display: 'inline-block',
      width: 8,
      height: 8,
      borderRadius: '50%',
      background: color,
      boxShadow: `0 0 4px ${color}`,
      animation: blink ? 'blink 1s infinite' : 'none',
      flexShrink: 0,
    }} />
  );
}

// ── Feed freshness kontrol ──────────────────────────────────────────────────
interface FeedStatus {
  label: string;
  latency: number | null;
  stale: boolean;
}

function useFeedHealth(): { ws: FeedStatus; feeds: FeedStatus[] } {
  const connected = useMarketStore((s) => s.connected);
  const isChangingSymbol = useMarketStore((s) => s.isChangingSymbol);
  const [wsLatency, setWsLatency] = useState<number | null>(null);
  const [dataAge, setDataAge]     = useState(0);

  // Periodically compute data staleness + WS effective latency
  useEffect(() => {
    // İlk ölçümü hemen yap — 3 saniye beklemeden
    function measure() {
      const last = marketStore.getState().lastMessageAt;
      const age = last > 0 ? Date.now() - last : Infinity;
      setDataAge(age);
      if (last > 0 && connected) {
        setWsLatency(age);
      } else if (!connected) {
        setWsLatency(null);
      }
    }
    measure(); // hemen ölç
    const iv = setInterval(measure, 1000);
    return () => clearInterval(iv);
  }, [connected]);

  // Sembol değişimi sırasında stale/offline gösterme — bağlantı hâlâ canlı
  const isStale = isChangingSymbol ? false : dataAge > STALE_THRESHOLD;

  // Sembol değişimi sırasında → latency 0 göster (yeşil), veri akışı yokken kırmızı olmasın
  const effectiveLatency = isChangingSymbol ? 0 : wsLatency;

  const orderbook = marketStore.getState().orderbook;
  const hasData = connected && (orderbook != null || isChangingSymbol);

  const feeds: FeedStatus[] = [
    { label: 'BIN', latency: hasData ? effectiveLatency : null, stale: isStale },
    { label: 'BYB', latency: hasData ? effectiveLatency : null, stale: isStale },
    { label: 'OKX', latency: hasData ? effectiveLatency : null, stale: isStale },
  ];

  return {
    ws: {
      label: 'WS',
      latency: connected ? (isChangingSymbol ? 0 : wsLatency) : null,
      stale: !connected || isStale,
    },
    feeds,
  };
}

// ── Bileşen ─────────────────────────────────────────────────────────────────
export default function SystemMonitor(): JSX.Element {
  const { ws, feeds } = useFeedHealth();

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      gap: 4,
      padding: '6px 8px',
      background: '#060606',
      fontFamily: 'Arial, sans-serif',
      fontSize: 10,
      color: '#888',
    }}>
      {/* Global blink animation */}
      <style>{`
        @keyframes blink {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.2; }
        }
      `}</style>

      {/* WS bağlantı */}
      <Row label={ws.label} latency={ws.latency} stale={ws.stale} />

      {/* Borsa bazlı */}
      {feeds.map((f) => (
        <Row key={f.label} label={f.label} latency={f.latency} stale={f.stale} />
      ))}
    </div>
  );
}

function Row({ label, latency, stale }: { label: string; latency: number | null; stale: boolean }) {
  const color = latencyColor(latency);
  const shouldBlink = latency === null || latency >= 150 || stale;

  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      gap: 6,
      height: 16,
    }}>
      <Dot color={color} blink={shouldBlink} />
      <span style={{ minWidth: 24, color: '#666', fontWeight: 600 }}>{label}</span>
      <span style={{ color, fontVariantNumeric: 'tabular-nums' }}>
        {latencyLabel(latency)}
      </span>
    </div>
  );
}

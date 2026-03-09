// ─────────────────────────────────────────────────────────────────────────────
// LiquidationFeed.tsx — Tasfiye Şelalesi
// Margin call yiyen pozisyonlar — "Başkalarının kanı, senin fırsatındır."
// ─────────────────────────────────────────────────────────────────────────────

import { useMarketStore } from '../stores/marketStore';
import type { UnifiedLiquidation } from '../stores/marketStore';

// ── Config ──────────────────────────────────────────────────────────────────
const MAX_DISPLAY = 20;
const WHALE_LIQ   = 100_000; // USD — bu üzeri büyük ve kalın

// ── Formatlayıcılar ─────────────────────────────────────────────────────────
function fmtUSD(n: number): string {
  if (n >= 1_000_000) return '$' + (n / 1_000_000).toFixed(2) + 'M';
  if (n >= 1_000)     return '$' + (n / 1_000).toFixed(1) + 'K';
  return '$' + n.toFixed(0);
}

function fmtPrice(price: number): string {
  if (price >= 10_000) return price.toFixed(1);
  if (price >= 100)    return price.toFixed(2);
  return price.toFixed(3);
}

function fmtExchange(ex: string): string {
  switch (ex) {
    case 'BINANCE': return 'BIN';
    case 'BYBIT':   return 'BYB';
    case 'OKX':     return 'OKX';
    default:         return ex.slice(0, 3);
  }
}

function fmtTime(ts: number): string {
  const d = new Date(ts);
  return (
    String(d.getHours()).padStart(2, '0') + ':' +
    String(d.getMinutes()).padStart(2, '0') + ':' +
    String(d.getSeconds()).padStart(2, '0')
  );
}

// ── Row ─────────────────────────────────────────────────────────────────────
function LiqRow({ liq }: { liq: UnifiedLiquidation }) {
  // SHORT patlaması = yeşil (zorla alım), LONG patlaması = kırmızı (zorla satım)
  const isShort = liq.side === 'SHORT';
  const color   = isShort ? '#00ff66' : '#ff3333';
  const isWhale = liq.quoteQty >= WHALE_LIQ;

  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      gap: 6,
      padding: '3px 6px',
      borderBottom: '1px solid #111',
      fontSize: isWhale ? 12 : 10,
      fontWeight: isWhale ? 700 : 400,
      color,
      fontFamily: 'Arial, sans-serif',
      background: isWhale ? 'rgba(255,255,255,0.04)' : 'transparent',
    }}>
      <span style={{ color: '#555', fontSize: 9, minWidth: 48, flexShrink: 0 }}>
        {fmtTime(liq.timestamp)}
      </span>
      <span style={{ color: '#777', minWidth: 28, flexShrink: 0 }}>
        {fmtExchange(liq.exchange)}
      </span>
      <span style={{ minWidth: 42, flexShrink: 0 }}>
        {liq.side}
      </span>
      <span style={{ flex: 1, textAlign: 'right' }}>
        {fmtUSD(liq.quoteQty)}
      </span>
      <span style={{ color: '#888', fontSize: 9, flexShrink: 0 }}>
        @{fmtPrice(liq.price)}
      </span>
    </div>
  );
}

// ── Bileşen ─────────────────────────────────────────────────────────────────
export default function LiquidationFeed(): JSX.Element {
  const liquidations = useMarketStore((s) => s.liquidations);
  const visible = liquidations.slice(0, MAX_DISPLAY);

  return (
    <div style={{
      width: '100%',
      height: '100%',
      display: 'flex',
      flexDirection: 'column',
      background: '#000',
      overflow: 'hidden',
    }}>
      {visible.length === 0 ? (
        <div style={{
          flex: 1,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: '#333',
          fontSize: 11,
          fontFamily: 'Arial',
        }}>
          Waiting for liquidations...
        </div>
      ) : (
        <div style={{ flex: 1, overflowY: 'auto' }}>
          {visible.map((liq) => (
            <LiqRow key={liq.id} liq={liq} />
          ))}
        </div>
      )}
    </div>
  );
}

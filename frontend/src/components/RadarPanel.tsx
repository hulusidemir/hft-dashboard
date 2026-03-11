// ─────────────────────────────────────────────────────────────────────────────
// RadarPanel.tsx — Global Piyasa Tarama & Savaş Günlüğü
// SOL: Hot Targets (Top Volume + Top Movers) — REST 10s polling
// SAĞ: War Log (Whale $100K+ & Liquidation $50K+ kayıtları)
// Askeri terminal görünümü — monospace, yeşil/kırmızı, sıfır gereksiz metin
// ─────────────────────────────────────────────────────────────────────────────

import { useState, useEffect, useRef, useCallback } from 'react';
import { useMarketStore, changeSymbol, setActiveView } from '../stores/marketStore';
import type { WarLogEntry } from '../stores/marketStore';
import { t, useLang } from '../utils/i18n';

// ── Types — Backend RadarService mirror ──────────────────────────────────────
interface RadarTicker {
  symbol:        string;
  lastPrice:     number;
  price24hPcnt:  number;
  turnover24h:   number;
  volume24h:     number;
  highPrice24h:  number;
  lowPrice24h:   number;
  openInterest:  number;
  fundingRate:   number;
}

interface HotTargets {
  topVolume:  RadarTicker[];
  topGainers: RadarTicker[];
  topLosers:  RadarTicker[];
  updatedAt:  number;
}

// ── Config ───────────────────────────────────────────────────────────────────
const REST_BASE     = import.meta.env.VITE_BACKEND_URL || 'http://localhost:9000';
const POLL_INTERVAL = 10_000;

// ── Formatters ───────────────────────────────────────────────────────────────
function fmtCompact(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1e9) return (n / 1e9).toFixed(2) + 'B';
  if (abs >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (abs >= 1e3) return (n / 1e3).toFixed(0) + 'K';
  return n.toFixed(0);
}

function fmtPcnt(p: number): string {
  const val = (p * 100).toFixed(2);
  return p >= 0 ? `+${val}%` : `${val}%`;
}

function fmtPrice(p: number): string {
  if (p >= 1000) return p.toFixed(2);
  if (p >= 1) return p.toFixed(4);
  return p.toFixed(6);
}

function fmtTime(ts: number): string {
  const d = new Date(ts);
  const h = d.getHours().toString().padStart(2, '0');
  const m = d.getMinutes().toString().padStart(2, '0');
  const s = d.getSeconds().toString().padStart(2, '0');
  return `${h}:${m}:${s}`;
}

function fmtQty(q: number): string {
  if (q >= 1e6) return `$${(q / 1e6).toFixed(2)}M`;
  if (q >= 1e3) return `$${(q / 1e3).toFixed(0)}K`;
  return `$${q.toFixed(0)}`;
}

// ── Colors ───────────────────────────────────────────────────────────────────
const C_POS  = '#26a69a';
const C_NEG  = '#ef5350';
const C_GOLD = '#ff9900';
const C_DIM  = '#555';
const C_TEXT = '#aaa';
const C_BG   = '#060606';
const C_ROW  = '#0a0a0a';
const C_BORDER = '#1a1a1a';

// ── Styles ───────────────────────────────────────────────────────────────────
const MONO: React.CSSProperties = {
  fontFamily: "'Courier New', Courier, monospace",
  fontSize: 11,
};

const TH_STYLE: React.CSSProperties = {
  ...MONO,
  padding: '4px 6px',
  textAlign: 'right',
  color: C_DIM,
  fontWeight: 700,
  fontSize: 9,
  letterSpacing: 0.8,
  textTransform: 'uppercase',
  borderBottom: `1px solid ${C_BORDER}`,
  position: 'sticky',
  top: 0,
  background: '#050505',
  zIndex: 2,
};

const TD_STYLE: React.CSSProperties = {
  ...MONO,
  padding: '3px 6px',
  textAlign: 'right',
  color: C_TEXT,
  borderBottom: `1px solid #111`,
};

// ── TickerRow ────────────────────────────────────────────────────────────────
function TickerRow({ t, onClick }: { t: RadarTicker; onClick: () => void }) {
  const base = t.symbol.replace(/USDT$/i, '');
  const pcntColor = t.price24hPcnt >= 0 ? C_POS : C_NEG;

  return (
    <tr
      onClick={onClick}
      style={{ cursor: 'pointer', transition: 'background 0.1s' }}
      onMouseEnter={(e) => { (e.currentTarget as HTMLTableRowElement).style.background = '#111118'; }}
      onMouseLeave={(e) => { (e.currentTarget as HTMLTableRowElement).style.background = 'transparent'; }}
    >
      <td style={{ ...TD_STYLE, textAlign: 'left', color: C_GOLD, fontWeight: 700 }}>
        {base}<span style={{ color: '#444' }}>/USDT</span>
      </td>
      <td style={TD_STYLE}>{fmtPrice(t.lastPrice)}</td>
      <td style={{ ...TD_STYLE, color: pcntColor, fontWeight: 600 }}>{fmtPcnt(t.price24hPcnt)}</td>
      <td style={TD_STYLE}>${fmtCompact(t.turnover24h)}</td>
      <td style={TD_STYLE}>${fmtCompact(t.openInterest)}</td>
      <td style={{ ...TD_STYLE, color: t.fundingRate >= 0 ? C_POS : C_NEG }}>
        {(t.fundingRate * 100).toFixed(4)}%
      </td>
    </tr>
  );
}

// ── Section Header ───────────────────────────────────────────────────────────
function SectionHeader({ text, icon }: { text: string; icon: string }) {
  return (
    <div style={{
      padding: '6px 8px',
      background: '#0a0a10',
      borderBottom: `1px solid ${C_BORDER}`,
      borderTop: `1px solid ${C_BORDER}`,
      ...MONO,
      fontSize: 10,
      fontWeight: 700,
      color: C_GOLD,
      letterSpacing: 1.2,
    }}>
      {icon} {text}
    </div>
  );
}

// ── Exchange badge renkleri ──────────────────────────────────────────────────
const EXCHANGE_STYLE: Record<string, { bg: string; fg: string; label: string }> = {
  binance: { bg: '#f0b90b22', fg: '#f0b90b', label: 'BIN' },
  bybit:   { bg: '#ff660022', fg: '#ff6600', label: 'BYB' },
  okx:     { bg: '#00e5ff22', fg: '#00e5ff', label: 'OKX' },
};

function ExchangeBadge({ exchange }: { exchange: string }) {
  const key = exchange.toLowerCase();
  const style = EXCHANGE_STYLE[key] ?? { bg: '#ffffff11', fg: '#888', label: exchange.slice(0, 3).toUpperCase() };
  return (
    <span style={{
      display: 'inline-block',
      padding: '1px 5px',
      borderRadius: 3,
      background: style.bg,
      color: style.fg,
      fontSize: 8,
      fontWeight: 800,
      letterSpacing: 0.6,
      border: `1px solid ${style.fg}44`,
    }}>
      {style.label}
    </span>
  );
}

// ── WarLogRow ────────────────────────────────────────────────────────────────
function WarLogRow({ entry }: { entry: WarLogEntry }) {
  const isWhale = entry.type === 'WHALE_BUY' || entry.type === 'WHALE_SELL';
  const isBuy   = entry.type === 'WHALE_BUY';
  const isLong  = entry.type === 'LIQ_LONG';

  let typeLabel: string;
  let typeColor: string;

  if (isWhale) {
    typeLabel = isBuy ? '🐋 BUY' : '🐋 SELL';
    typeColor = isBuy ? C_POS : C_NEG;
  } else {
    typeLabel = isLong ? '💀 LONG' : '💀 SHORT';
    typeColor = isLong ? C_NEG : C_POS; // Long liq = kırmızı (çöküş), Short liq = yeşil (sıkışma)
  }

  const base = entry.symbol.replace(/USDT$/i, '');

  return (
    <tr>
      <td style={{ ...TD_STYLE, textAlign: 'left', color: '#666', fontSize: 10 }}>
        {fmtTime(entry.timestamp)}
      </td>
      <td style={{ ...TD_STYLE, textAlign: 'left', color: typeColor, fontWeight: 700, fontSize: 10 }}>
        {typeLabel}
      </td>
      <td style={{ ...TD_STYLE, textAlign: 'left', color: C_GOLD, fontWeight: 600 }}>
        {base}
      </td>
      <td style={TD_STYLE}>{fmtPrice(entry.price)}</td>
      <td style={{ ...TD_STYLE, color: '#ddd', fontWeight: 700 }}>{fmtQty(entry.quoteQty)}</td>
      <td style={{ ...TD_STYLE, textAlign: 'center' }}><ExchangeBadge exchange={entry.exchange} /></td>
    </tr>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// ── RadarPanel ────────────────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════
export default function RadarPanel() {
  useLang(); // re-render on language change
  const [hotTargets, setHotTargets] = useState<HotTargets | null>(null);
  const [lastUpdate, setLastUpdate] = useState<number>(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const warLog = useMarketStore((s) => s.warLog);

  // ── Fetch hot targets ──────────────────────────────────────────────────
  const fetchTargets = useCallback(async () => {
    try {
      const resp = await fetch(`${REST_BASE}/api/radar/hot-targets`);
      const data = await resp.json() as HotTargets;
      setHotTargets(data);
      setLastUpdate(Date.now());
    } catch {
      // silent — will retry
    }
  }, []);

  useEffect(() => {
    void fetchTargets();
    timerRef.current = setInterval(() => { void fetchTargets(); }, POLL_INTERVAL);
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [fetchTargets]);

  // ── Symbol click → lock + switch to dashboard ──────────────────────────
  const handleSymbolClick = useCallback((symbol: string) => {
    changeSymbol(symbol);
    setActiveView('dashboard');
  }, []);

  // ── Table component for ticker lists ──────────────────────────────────
  const TickerTable = ({ tickers }: { tickers: RadarTicker[] }) => (
    <table style={{ width: '100%', borderCollapse: 'collapse' }}>
      <thead>
        <tr>
          <th style={{ ...TH_STYLE, textAlign: 'left' }}>SYMBOL</th>
          <th style={TH_STYLE}>PRICE</th>
          <th style={TH_STYLE}>24h %</th>
          <th style={TH_STYLE}>VOLUME</th>
          <th style={TH_STYLE}>OI</th>
          <th style={TH_STYLE}>FUND</th>
        </tr>
      </thead>
      <tbody>
        {tickers.map((t) => (
          <TickerRow key={t.symbol} t={t} onClick={() => handleSymbolClick(t.symbol)} />
        ))}
      </tbody>
    </table>
  );

  return (
    <div style={{
      width: '100%',
      height: '100%',
      display: 'grid',
      gridTemplateColumns: '1fr 380px',
      gap: 0,
      background: C_BG,
      overflow: 'hidden',
    }}>

      {/* ═══════════ SOL SÜTUN — Sıcak Hedefler ═══════════ */}
      <div style={{
        display: 'flex',
        flexDirection: 'column',
        borderRight: `1px solid ${C_BORDER}`,
        overflow: 'hidden',
        minHeight: 0,
      }}>
        {/* Title bar */}
        <div style={{
          padding: '6px 10px',
          background: '#050508',
          borderBottom: `1px solid ${C_BORDER}`,
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
        }}>
          <span style={{ ...MONO, fontSize: 10, fontWeight: 700, color: C_GOLD, letterSpacing: 1.5 }}>
            ◎ GLOBAL RADAR — HOT TARGETS
          </span>
          <span style={{ ...MONO, fontSize: 9, color: '#444' }}>
            {lastUpdate > 0 ? `Updated ${fmtTime(lastUpdate)}` : 'Loading...'}
          </span>
        </div>

        {/* Scrollable content */}
        <div style={{ flex: 1, overflow: 'auto', minHeight: 0 }}>
          {/* ── Top Volume ──────────────────────────────────────────────── */}
          <SectionHeader text="TOP VOLUME — 24H TURNOVER" icon="▰" />
          {hotTargets && hotTargets.topVolume.length > 0 ? (
            <TickerTable tickers={hotTargets.topVolume} />
          ) : (
            <div style={{ ...MONO, padding: 12, color: '#444', textAlign: 'center' }}>
              {t('scanWaiting')}
            </div>
          )}

          {/* ── Top Gainers ─────────────────────────────────────────────── */}
          <SectionHeader text="TOP GAINERS — PRICE INCREASE" icon="▲" />
          {hotTargets && hotTargets.topGainers.length > 0 ? (
            <TickerTable tickers={hotTargets.topGainers} />
          ) : (
            <div style={{ ...MONO, padding: 12, color: '#444', textAlign: 'center' }}>—</div>
          )}

          {/* ── Top Losers ──────────────────────────────────────────────── */}
          <SectionHeader text="TOP LOSERS — PRICE DROP" icon="▼" />
          {hotTargets && hotTargets.topLosers.length > 0 ? (
            <TickerTable tickers={hotTargets.topLosers} />
          ) : (
            <div style={{ ...MONO, padding: 12, color: '#444', textAlign: 'center' }}>—</div>
          )}
        </div>
      </div>

      {/* ═══════════ SAĞ SÜTUN — Savaş Günlüğü ═══════════ */}
      <div style={{
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        minHeight: 0,
        background: C_ROW,
      }}>
        {/* Title bar */}
        <div style={{
          padding: '6px 10px',
          background: '#050508',
          borderBottom: `1px solid ${C_BORDER}`,
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
        }}>
          <span style={{ ...MONO, fontSize: 10, fontWeight: 700, color: C_NEG, letterSpacing: 1.5 }}>
            ✦ WAR LOG — WHALE & LIQUIDATION
          </span>
          <span style={{ ...MONO, fontSize: 9, color: '#444' }}>
            {warLog.length} events
          </span>
        </div>

        {/* Scrollable log */}
        <div style={{ flex: 1, overflow: 'auto', minHeight: 0 }}>
          {warLog.length === 0 ? (
            <div style={{
              ...MONO,
              padding: 24,
              color: '#333',
              textAlign: 'center',
              fontSize: 10,
            }}>
              {t('noWhaleYet')}
              <br />
              {t('alarmWillAppear')}
            </div>
          ) : (
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  <th style={{ ...TH_STYLE, textAlign: 'left' }}>TIME</th>
                  <th style={{ ...TH_STYLE, textAlign: 'left' }}>TYPE</th>
                  <th style={{ ...TH_STYLE, textAlign: 'left' }}>COIN</th>
                  <th style={TH_STYLE}>PRICE</th>
                  <th style={TH_STYLE}>SIZE</th>
                  <th style={TH_STYLE}>SRC</th>
                </tr>
              </thead>
              <tbody>
                {warLog.map((entry) => (
                  <WarLogRow key={entry.id} entry={entry} />
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}

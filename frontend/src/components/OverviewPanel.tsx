// ─────────────────────────────────────────────────────────────────────────────
// components/OverviewPanel.tsx — MARKET OVERVIEW (Piyasa Genel Durum Ekranı)
// ─────────────────────────────────────────────────────────────────────────────
// Uzman kripto trader perspektifinden tam piyasa röntgeni:
//   • 4 zaman diliminde (15m / 1h / 4h / 24h) ayrı ayrı bias analizi
//   • Her TF için: OI, Funding, L/S, CVD, Tasfiye, Fiyat sinyalleri
//   • Genel konsensüs skoru ve yön tayini
//   • Görsel skor bar'lar ve renk kodlu kartlar
// ─────────────────────────────────────────────────────────────────────────────

import { useState, useEffect, useCallback } from 'react';
import { setActiveView, useMarketStore } from '../stores/marketStore';
import { t, useLang, getLocale } from '../utils/i18n';

const REST_BASE = import.meta.env.VITE_BACKEND_URL || 'http://localhost:9000';

// ── Tipler ───────────────────────────────────────────────────────────────────

interface ExchangeMetrics {
  oi: number;
  oiDelta: number;
  funding: number;
  lsRatio: number;
  cvd: number;
  liqLong: number;
  liqShort: number;
}

interface TimeframeBias {
  timeframe: string;
  price: number;
  priceChange: number;
  priceChangeAbs: number;
  oiTotal: number;
  oiDelta: number;
  oiDeltaPct: number;
  fundingRate: number;
  fundingAnnualized: number;
  lsRatio: number;
  longPct: number;
  shortPct: number;
  cvd: number;
  liqLongUsd: number;
  liqShortUsd: number;
  liqDominance: 'long' | 'short' | 'balanced';
  exchanges: {
    binance: ExchangeMetrics;
    bybit: ExchangeMetrics;
    okx: ExchangeMetrics;
  };
  oiSignal: number;
  fundingSignal: number;
  lsSignal: number;
  cvdSignal: number;
  liqSignal: number;
  priceSignal: number;
  totalScore: number;
  bias: 'STRONG_LONG' | 'LONG' | 'NEUTRAL' | 'SHORT' | 'STRONG_SHORT';
  actionLabel: string;
}

interface MarketOverview {
  symbol: string;
  timestamp: number;
  fetchDurationMs: number;
  btcPrice: number;
  btcDominance: number | null;
  timeframes: TimeframeBias[];
  overallScore: number;
  overallBias: 'STRONG_LONG' | 'LONG' | 'NEUTRAL' | 'SHORT' | 'STRONG_SHORT';
  overallAction: string;
}

// ── Yardımcılar ──────────────────────────────────────────────────────────────

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

function fmtPct(n: number, decimals = 2): string {
  return (n >= 0 ? '+' : '') + n.toFixed(decimals) + '%';
}

function fmtFunding(n: number): string {
  return (n >= 0 ? '+' : '') + (n * 100).toFixed(4) + '%';
}

const BIAS_CONFIG: Record<string, { color: string; bg: string; icon: string; labelKey: string }> = {
  STRONG_LONG:  { color: '#00ff88', bg: '#00ff8818', icon: '⬆⬆', labelKey: 'strongLong' },
  LONG:         { color: '#50ff50', bg: '#50ff5012', icon: '⬆',   labelKey: 'long' },
  NEUTRAL:      { color: '#ffaa00', bg: '#ffaa0010', icon: '◆',   labelKey: 'neutral' },
  SHORT:        { color: '#ff5050', bg: '#ff505012', icon: '⬇',   labelKey: 'short' },
  STRONG_SHORT: { color: '#ff0044', bg: '#ff004418', icon: '⬇⬇', labelKey: 'strongShort' },
};

// ── Component ────────────────────────────────────────────────────────────────

export default function OverviewPanel() {
  useLang(); // re-render on language change
  const currentSymbol = useMarketStore(s => s.currentSymbol);
  const [data, setData] = useState<MarketOverview | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${REST_BASE}/api/overview?symbol=${encodeURIComponent(currentSymbol)}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json() as MarketOverview;
      setData(json);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [currentSymbol]);

  useEffect(() => { void fetchData(); }, [fetchData]);

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
            📊 MARKET OVERVIEW
          </span>
          <span style={{ fontSize: 12, color: '#666' }}>
            {t('overviewSubtitle', { symbol: currentSymbol })}
          </span>
        </div>
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
          }}
        >
          {loading ? '⟳ ...' : t('refresh')}
        </button>
      </div>

      {/* ═══════════ LOADING / ERROR ════════════════════════════════════ */}
      {loading && !data && (
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 16, color: '#ff9900' }}>
          <span style={{ animation: 'blink 0.8s infinite' }}>{t('loadingOverview')}</span>
        </div>
      )}

      {error && (
        <div style={{ padding: 20, color: '#ff4444', textAlign: 'center', fontSize: 13 }}>
          {t('error')}{error}
        </div>
      )}

      {data && (
        <div style={{ flex: 1, overflow: 'auto', padding: '16px 20px' }}>

          {/* ═══════════ GENEL KONSENSÜS KARTI ════════════════════════════ */}
          <OverallConsensusCard data={data} />

          {/* ═══════════ BTC FİYAT + GLOBAL BİLGİ ════════════════════════ */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 10, marginBottom: 20 }}>
            <InfoCard label={t('btcPrice')} value={`$${data.btcPrice.toLocaleString('en-US', { maximumFractionDigits: 1 })}`} color="#ff9900" />
            {data.btcDominance != null && (
              <InfoCard label={t('btcDominance')} value={`${data.btcDominance.toFixed(1)}%`} color="#00bfff" />
            )}
            <InfoCard label={t('fetchDuration')} value={`${(data.fetchDurationMs / 1000).toFixed(1)}s`} color="#555" />
            <InfoCard label={t('lastUpdate')} value={new Date(data.timestamp).toLocaleTimeString(getLocale())} color="#555" />
          </div>

          {/* ═══════════ ZAMAN DİLİMİ KARTLARI ═══════════════════════════ */}
          <SectionTitle text={t('timeframeAnalysis')} />

          <div style={{ display: 'flex', flexDirection: 'column', gap: 16, marginBottom: 24 }}>
            {[...data.timeframes].reverse().map((tf) => (
              <TimeframeCard key={tf.timeframe} tf={tf} />
            ))}
          </div>

          {/* ═══════════ BORSA KARŞILAŞTIRMA TABLOSU ══════════════════════ */}
          <SectionTitle text={t('exchangeComparison')} />

          <ExchangeComparisonTable timeframes={data.timeframes} />

          {/* ═══════════ SİNYAL AÇIKLAMALARI ═════════════════════════════ */}
          <SectionTitle text={t('signalGuide')} />
          <SignalGuide />

          {/* ═══════════ DASHBOARD'A DÖNÜŞ BUTONU ═════════════════════════ */}
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
            {t('backToDash')}
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

function InfoCard({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <div style={{
      background: '#0a0a14',
      border: '1px solid #1a1a2e',
      borderRadius: 8,
      padding: '10px 14px',
    }}>
      <div style={{ fontSize: 9, color: '#666', letterSpacing: 1, textTransform: 'uppercase', marginBottom: 4 }}>
        {label}
      </div>
      <div style={{ fontSize: 18, fontWeight: 900, color, letterSpacing: 1 }}>
        {value}
      </div>
    </div>
  );
}

// ── Genel Konsensüs Kartı ────────────────────────────────────────────────────

function OverallConsensusCard({ data }: { data: MarketOverview }) {
  const cfg = BIAS_CONFIG[data.overallBias] ?? BIAS_CONFIG['NEUTRAL']!;

  return (
    <div style={{
      background: cfg.bg,
      border: `2px solid ${cfg.color}44`,
      borderRadius: 12,
      padding: '20px 24px',
      marginBottom: 20,
      position: 'relative',
      overflow: 'hidden',
    }}>
      {/* Arka plan dekorasyon */}
      <div style={{
        position: 'absolute',
        right: 20,
        top: '50%',
        transform: 'translateY(-50%)',
        fontSize: 80,
        opacity: 0.06,
        fontWeight: 900,
        color: cfg.color,
        pointerEvents: 'none',
      }}>
        {cfg.icon}
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 12 }}>
        <span style={{ fontSize: 32, fontWeight: 900, color: cfg.color, letterSpacing: 2 }}>
          {cfg.icon} {t(cfg.labelKey)}
        </span>
        <ScoreBadge score={data.overallScore} size="large" />
      </div>

      <div style={{ fontSize: 13, color: '#bbb', lineHeight: 1.6, maxWidth: '80%' }}>
        {data.overallAction}
      </div>

      {/* Mini TF skor bar'ları */}
      <div style={{ display: 'flex', gap: 12, marginTop: 16 }}>
        {[...data.timeframes].reverse().map((tf) => {
          const c = BIAS_CONFIG[tf.bias] ?? BIAS_CONFIG['NEUTRAL']!;
          return (
            <div key={tf.timeframe} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ fontSize: 10, color: '#666', fontWeight: 700 }}>{tf.timeframe.toUpperCase()}</span>
              <ScoreBadge score={tf.totalScore} size="small" />
              <span style={{ fontSize: 9, color: c.color, fontWeight: 700 }}>{t(c.labelKey)}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Skor Rozeti ──────────────────────────────────────────────────────────────

function ScoreBadge({ score, size }: { score: number; size: 'large' | 'small' }) {
  const color = score >= 15 ? '#50ff50' : score <= -15 ? '#ff5050' : '#ffaa00';
  const isLarge = size === 'large';

  return (
    <span style={{
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      minWidth: isLarge ? 64 : 40,
      height: isLarge ? 28 : 18,
      borderRadius: isLarge ? 6 : 4,
      background: `${color}18`,
      border: `1px solid ${color}44`,
      color,
      fontSize: isLarge ? 14 : 10,
      fontWeight: 900,
      letterSpacing: 0.5,
    }}>
      {score > 0 ? '+' : ''}{score.toFixed(0)}
    </span>
  );
}

// ── Sinyal Bar (−100 to +100 görsel bar) ─────────────────────────────────────

function SignalBar({ value, label, showValue = true }: { value: number; label: string; showValue?: boolean }) {
  const pct = Math.abs(value);
  const isPos = value >= 0;
  const color = value >= 15 ? '#50ff50' : value <= -15 ? '#ff5050' : '#ffaa00';

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
      <span style={{ width: 55, fontSize: 9, color: '#666', textAlign: 'right', flexShrink: 0 }}>
        {label}
      </span>
      <div style={{ flex: 1, height: 10, background: '#151520', borderRadius: 5, overflow: 'hidden', position: 'relative' }}>
        {/* Center line */}
        <div style={{ position: 'absolute', left: '50%', top: 0, bottom: 0, width: 1, background: '#333' }} />
        {/* Fill bar */}
        <div style={{
          position: 'absolute',
          top: 1,
          bottom: 1,
          borderRadius: 4,
          background: color,
          opacity: 0.7,
          ...(isPos
            ? { left: '50%', width: `${pct / 2}%` }
            : { right: '50%', width: `${pct / 2}%` }),
        }} />
      </div>
      {showValue && (
        <span style={{ width: 35, fontSize: 9, color, fontWeight: 700, textAlign: 'right', flexShrink: 0 }}>
          {value > 0 ? '+' : ''}{value.toFixed(0)}
        </span>
      )}
    </div>
  );
}

// ── Zaman Dilimi Kartı ───────────────────────────────────────────────────────

function TimeframeCard({ tf }: { tf: TimeframeBias }) {
  const cfg = BIAS_CONFIG[tf.bias] ?? BIAS_CONFIG['NEUTRAL']!;
  const liqTotal = tf.liqLongUsd + tf.liqShortUsd;

  return (
    <div style={{
      background: '#0a0a14',
      border: `1px solid ${cfg.color}33`,
      borderRadius: 10,
      padding: '16px 20px',
      borderLeft: `4px solid ${cfg.color}`,
    }}>
      {/* Başlık satırı */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <span style={{
            fontSize: 16,
            fontWeight: 900,
            color: cfg.color,
            letterSpacing: 2,
            padding: '4px 12px',
            background: `${cfg.color}15`,
            borderRadius: 6,
          }}>
            {tf.timeframe.toUpperCase()}
          </span>
          <span style={{ fontSize: 22, fontWeight: 900, color: cfg.color }}>
            {cfg.icon} {t(cfg.labelKey)}
          </span>
          <ScoreBadge score={tf.totalScore} size="large" />
        </div>
        <div style={{ textAlign: 'right' }}>
          <div style={{ fontSize: 16, fontWeight: 900, color: '#fff' }}>
            ${tf.price.toLocaleString('en-US', { maximumFractionDigits: 1 })}
          </div>
          <div style={{
            fontSize: 11,
            fontWeight: 700,
            color: tf.priceChange >= 0 ? '#50ff50' : '#ff5050',
          }}>
            {fmtPct(tf.priceChange)} ({tf.priceChangeAbs >= 0 ? '+' : ''}{fmtUsd(tf.priceChangeAbs)})
          </div>
        </div>
      </div>

      {/* Sinyal bar'ları */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: '1fr 1fr',
        gap: '0 24px',
        marginBottom: 16,
      }}>
        <div>
          <SignalBar value={tf.oiSignal} label="OI" />
          <SignalBar value={tf.fundingSignal} label="Funding" />
          <SignalBar value={tf.lsSignal} label="L/S" />
        </div>
        <div>
          <SignalBar value={tf.cvdSignal} label="CVD" />
          <SignalBar value={tf.liqSignal} label="Liq" />
          <SignalBar value={tf.priceSignal} label={t('priceLabel')} />
        </div>
      </div>

      {/* Metrik grid */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))',
        gap: 8,
        marginBottom: 12,
      }}>
        <MetricCell label={t('totalOI')} value={fmtUsd(tf.oiTotal)} />
        <MetricCell
          label="OI Delta"
          value={`${tf.oiDelta >= 0 ? '+' : ''}${fmtUsd(tf.oiDelta)}`}
          sub={fmtPct(tf.oiDeltaPct)}
          color={tf.oiDelta >= 0 ? '#50ff50' : '#ff5050'}
        />
        <MetricCell
          label={t('fundingAvg')}
          value={fmtFunding(tf.fundingRate)}
          sub={t('annualized', { val: fmtPct(tf.fundingAnnualized, 1) })}
          color={tf.fundingRate >= 0 ? '#50ff50' : '#ff5050'}
        />
        <MetricCell
          label="L/S Ratio"
          value={tf.lsRatio.toFixed(2)}
          sub={`L: ${tf.longPct.toFixed(1)}% / S: ${tf.shortPct.toFixed(1)}%`}
          color={tf.lsRatio >= 1 ? '#50ff50' : '#ff5050'}
        />
        <MetricCell
          label="Net CVD"
          value={fmtUsd(tf.cvd)}
          color={tf.cvd >= 0 ? '#50ff50' : '#ff5050'}
        />
        <MetricCell
          label={t('liquidations')}
          value={fmtUsd(liqTotal)}
          sub={`L: ${fmtUsd(tf.liqLongUsd)} / S: ${fmtUsd(tf.liqShortUsd)}`}
          color={tf.liqDominance === 'long' ? '#ff5050' : tf.liqDominance === 'short' ? '#50ff50' : '#888'}
        />
      </div>

      {/* Açıklama */}
      <div style={{
        fontSize: 11,
        color: '#888',
        lineHeight: 1.5,
        padding: '8px 12px',
        background: '#08081a',
        borderRadius: 6,
        border: `1px solid ${cfg.color}22`,
      }}>
        {tf.actionLabel}
      </div>
    </div>
  );
}

// ── Metrik Hücresi ───────────────────────────────────────────────────────────

function MetricCell({ label, value, sub, color }: {
  label: string;
  value: string;
  sub?: string;
  color?: string;
}) {
  return (
    <div style={{
      background: '#08081a',
      borderRadius: 6,
      padding: '8px 10px',
      border: '1px solid #151520',
    }}>
      <div style={{ fontSize: 8, color: '#555', letterSpacing: 1, textTransform: 'uppercase', marginBottom: 3 }}>
        {label}
      </div>
      <div style={{ fontSize: 14, fontWeight: 800, color: color ?? '#ccc' }}>
        {value}
      </div>
      {sub && (
        <div style={{ fontSize: 9, color: '#666', marginTop: 2 }}>{sub}</div>
      )}
    </div>
  );
}

// ── Borsa Karşılaştırma Tablosu ──────────────────────────────────────────────

function ExchangeComparisonTable({ timeframes }: { timeframes: TimeframeBias[] }) {
  const reversed = [...timeframes].reverse(); // 24h → 15m

  return (
    <div style={{
      overflow: 'auto',
      marginBottom: 24,
      background: '#0a0a14',
      border: '1px solid #1a1a2e',
      borderRadius: 8,
      padding: 12,
    }}>
      <table style={{
        width: '100%',
        borderCollapse: 'collapse',
        fontSize: 10,
        fontFamily: 'monospace',
      }}>
        <thead>
          <tr>
            <Th>TF</Th>
            <Th>{t('exchangeHeader')}</Th>
            <Th align="right">OI</Th>
            <Th align="right">OI Δ</Th>
            <Th align="right">Funding</Th>
            <Th align="right">L/S</Th>
            <Th align="right">CVD</Th>
            <Th align="right">Liq Long</Th>
            <Th align="right">Liq Short</Th>
          </tr>
        </thead>
        <tbody>
          {reversed.map((tf) => (
            (['binance', 'bybit', 'okx'] as const).map((ex, i) => {
              const d = tf.exchanges[ex];
              const exColors: Record<string, string> = { binance: '#F0B90B', bybit: '#f7a600', okx: '#00e5ff' };
              return (
                <tr key={`${tf.timeframe}-${ex}`} style={{ borderBottom: i === 2 ? '2px solid #222' : '1px solid #151520' }}>
                  {i === 0 && (
                    <td rowSpan={3} style={{
                      padding: '6px 8px',
                      verticalAlign: 'middle',
                      textAlign: 'center',
                      fontWeight: 900,
                      fontSize: 12,
                      color: (BIAS_CONFIG[tf.bias] ?? BIAS_CONFIG['NEUTRAL']!).color,
                      borderRight: '1px solid #222',
                    }}>
                      {tf.timeframe.toUpperCase()}
                    </td>
                  )}
                  <td style={{ padding: '4px 8px', color: exColors[ex], fontWeight: 700 }}>
                    {ex.charAt(0).toUpperCase() + ex.slice(1)}
                  </td>
                  <Td>{fmtUsd(d.oi)}</Td>
                  <Td color={d.oiDelta >= 0 ? '#50ff50' : '#ff5050'}>{(d.oiDelta >= 0 ? '+' : '') + fmtUsd(d.oiDelta)}</Td>
                  <Td color={d.funding >= 0 ? '#50ff50' : '#ff5050'}>{fmtFunding(d.funding)}</Td>
                  <Td color={d.lsRatio >= 1 ? '#50ff50' : '#ff5050'}>{d.lsRatio.toFixed(2)}</Td>
                  <Td color={d.cvd >= 0 ? '#50ff50' : '#ff5050'}>{fmtUsd(d.cvd)}</Td>
                  <Td color="#ff5050">{fmtUsd(d.liqLong)}</Td>
                  <Td color="#50ff50">{fmtUsd(d.liqShort)}</Td>
                </tr>
              );
            })
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Th({ children, align = 'left' }: { children: React.ReactNode; align?: string }) {
  return (
    <th style={{
      padding: '6px 8px',
      textAlign: align as 'left' | 'right' | 'center',
      color: '#555',
      fontWeight: 800,
      fontSize: 9,
      letterSpacing: 1,
      borderBottom: '2px solid #222',
      textTransform: 'uppercase',
      whiteSpace: 'nowrap',
    }}>
      {children}
    </th>
  );
}

function Td({ children, color }: { children: React.ReactNode; color?: string }) {
  return (
    <td style={{
      padding: '4px 8px',
      textAlign: 'right',
      color: color ?? '#aaa',
      fontWeight: 600,
      whiteSpace: 'nowrap',
    }}>
      {children}
    </td>
  );
}

// ── Sinyal Rehberi ───────────────────────────────────────────────────────────

function SignalGuide() {
  const signals = [
    {
      name: 'OI (Open Interest)',
      weight: '20%',
      descKey: 'oiDesc',
    },
    {
      name: 'Funding Rate',
      weight: '15%',
      descKey: 'fundingDesc',
    },
    {
      name: 'L/S Ratio',
      weight: '10%',
      descKey: 'lsDesc',
    },
    {
      name: 'CVD (Cumulative Volume Delta)',
      weight: '25%',
      descKey: 'cvdDesc',
    },
    {
      name: t('liqName'),
      weight: '15%',
      descKey: 'liqDesc',
    },
    {
      name: t('priceMomentum'),
      weight: '15%',
      descKey: 'priceDesc',
    },
  ];

  return (
    <div style={{
      display: 'grid',
      gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
      gap: 8,
      marginBottom: 24,
    }}>
      {signals.map((s) => (
        <div key={s.name} style={{
          background: '#08081a',
          border: '1px solid #151520',
          borderRadius: 6,
          padding: '10px 12px',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
            <span style={{ fontSize: 10, fontWeight: 800, color: '#ff9900' }}>{s.name}</span>
            <span style={{
              fontSize: 8,
              fontWeight: 700,
              color: '#666',
              padding: '1px 6px',
              background: '#151520',
              borderRadius: 3,
              border: '1px solid #222',
            }}>
              {t('weight', { val: s.weight })}
            </span>
          </div>
          <div style={{ fontSize: 9, color: '#777', lineHeight: 1.5 }}>
            {t(s.descKey)}
          </div>
        </div>
      ))}
    </div>
  );
}

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
import { t, useLang, getLocale } from '../utils/i18n';

const REST_BASE = import.meta.env.VITE_BACKEND_URL || 'http://localhost:9000';

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

// ── CoinGecko Coin Info tipi ─────────────────────────────────────────────────
interface CoinInfo {
  symbol: string;
  name: string;
  image: string;
  marketCap: number;
  marketCapRank: number | null;
  categories: string[];
  descriptionTr: string;
  descriptionEn: string;
  genesisDate: string | null;
  homepage: string;
  twitter: string;
  telegram: string;
  reddit: string;
  discord: string;
  github: string;
  website: string;
  spotExchanges: string[];
  perpExchanges: string[];
  // Price milestones
  currentPrice: number;
  athPrice: number | null;
  athDate: string | null;
  athChangePercentage: number | null;
  atlPrice: number | null;
  atlDate: string | null;
  atlChangePercentage: number | null;
  launchPrice: number | null;
  launchChangePercentage: number | null;
}

// ── Haber tipi ───────────────────────────────────────────────────────────────
interface NewsItem {
  title: string;
  titleOriginal: string;
  source: string;
  url: string;
  publishedAt: string;
  importance: 'critical' | 'high' | 'medium' | 'low';
  currency: string;
}

interface NewsResult {
  symbol: string;
  news: NewsItem[];
  fetchedAt: number;
  source: string;
}

export default function CoinMRPanel() {
  useLang(); // re-render on language change
  const currentSymbol = useMarketStore((s) => s.currentSymbol);
  const [timeframe, setTimeframe] = useState<Timeframe>('1h');
  const [data, setData] = useState<MrResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  const depthCanvasRef = useRef<HTMLCanvasElement>(null);
  const [coinInfo, setCoinInfo] = useState<CoinInfo | null>(null);
  const [infoExpanded, setInfoExpanded] = useState(false);
  const [newsData, setNewsData] = useState<NewsResult | null>(null);
  const [newsLoading, setNewsLoading] = useState(false);

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

  // ── CoinGecko coin info fetch ───────────────────────────────────────────
  useEffect(() => {
    setCoinInfo(null);
    setInfoExpanded(false);
    let cancelled = false;
    fetch(`${REST_BASE}/api/coin-info?symbol=${currentSymbol}`)
      .then((r) => r.ok ? r.json() as Promise<CoinInfo> : null)
      .then((info) => { if (!cancelled && info) setCoinInfo(info); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [currentSymbol]);

  // ── News fetch ──────────────────────────────────────────────────────────
  useEffect(() => {
    setNewsData(null);
    setNewsLoading(true);
    let cancelled = false;
    fetch(`${REST_BASE}/api/news?symbol=${currentSymbol}`)
      .then((r) => r.ok ? r.json() as Promise<NewsResult> : null)
      .then((result) => {
        if (!cancelled && result) setNewsData(result);
      })
      .catch(() => {})
      .finally(() => { if (!cancelled) setNewsLoading(false); });
    return () => { cancelled = true; };
  }, [currentSymbol]);

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
          <span style={{ animation: 'blink 0.8s infinite' }}>{t('loadingData')}</span>
        </div>
      )}

      {error && (
        <div style={{ padding: 20, color: '#ff4444', textAlign: 'center', fontSize: 13 }}>
          {t('error')}{error}
        </div>
      )}

      {data && (
        <div style={{ flex: 1, overflow: 'auto', padding: '16px 20px' }}>

          {/* ═══════════ COIN BİLGİSİ (CoinGecko) ═════════════════════ */}
          {coinInfo && (
            <div style={{
              background: '#0c0c14',
              border: '1px solid #1a1a2e',
              borderRadius: 10,
              padding: '14px 20px',
              marginBottom: 20,
              display: 'flex',
              flexDirection: 'column',
              gap: 10,
              position: 'relative',
            }}>
              {/* Sağ üst: Borsa listeleme rozetleri — Spot & Perp */}
              <div style={{
                position: 'absolute',
                top: 8,
                right: 14,
                display: 'flex',
                flexDirection: 'column',
                gap: 4,
                alignItems: 'flex-end',
              }}>
                {([['SPOT', coinInfo.spotExchanges], ['PERP', coinInfo.perpExchanges]] as const).map(([label, list]) => (
                  <div key={label} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                    <span style={{
                      fontSize: 8,
                      fontWeight: 800,
                      color: label === 'SPOT' ? '#888' : '#666',
                      letterSpacing: 1,
                      width: 30,
                      textAlign: 'right',
                    }}>{label}</span>
                    {(['Binance', 'Coinbase', 'OKX', 'Bybit'] as const).map((ex) => {
                      const listed = list.includes(ex);
                      return (
                        <span
                          key={ex}
                          title={listed ? `${ex} ${label}` : t('noExListing', { ex, label })}
                          style={{
                            fontSize: 8,
                            fontWeight: 700,
                            padding: '1px 6px',
                            borderRadius: 3,
                            letterSpacing: 0.3,
                            background: listed ? (label === 'SPOT' ? '#18422a' : '#1a2a4a') : '#1a1a22',
                            color: listed ? (label === 'SPOT' ? '#4ade80' : '#60a5fa') : '#333',
                            border: `1px solid ${listed ? (label === 'SPOT' ? '#2d7a4a' : '#2d4a7a') : '#222'}`,
                            opacity: listed ? 1 : 0.45,
                          }}
                        >
                          {ex}
                        </span>
                      );
                    })}
                  </div>
                ))}
              </div>
              {/* Üst satır: Logo + İsim + Market Cap + Rank + Kategoriler */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
                {coinInfo.image && (
                  <img
                    src={coinInfo.image}
                    alt={coinInfo.name}
                    style={{ width: 32, height: 32, borderRadius: 6 }}
                  />
                )}
                <span style={{ fontSize: 16, fontWeight: 900, color: '#fff' }}>
                  {coinInfo.name}
                </span>
                {coinInfo.marketCapRank && (
                  <span style={{
                    background: '#ff990022',
                    color: '#ff9900',
                    fontSize: 10,
                    fontWeight: 800,
                    padding: '2px 8px',
                    borderRadius: 4,
                  }}>
                    #{coinInfo.marketCapRank}
                  </span>
                )}
                <span style={{ fontSize: 13, color: '#00bfff', fontWeight: 600 }}>
                  MCap: ${coinInfo.marketCap >= 1e9
                    ? (coinInfo.marketCap / 1e9).toFixed(2) + 'B'
                    : coinInfo.marketCap >= 1e6
                      ? (coinInfo.marketCap / 1e6).toFixed(1) + 'M'
                      : fmt(coinInfo.marketCap)}
                </span>
                {/* Kategoriler */}
                <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                  {coinInfo.categories.slice(0, 4).map((cat, i) => (
                    <span
                      key={i}
                      style={{
                        background: '#151520',
                        border: '1px solid #2a2a3a',
                        borderRadius: 4,
                        padding: '2px 8px',
                        fontSize: 9,
                        color: '#888',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {cat}
                    </span>
                  ))}
                </div>
              </div>

              {/* Sosyal linkler */}
              {(() => {
                const links: { url: string; label: string; icon: string }[] = [];
                if (coinInfo.website) links.push({ url: coinInfo.website, label: 'Website', icon: '🌐' });
                if (coinInfo.twitter) links.push({ url: coinInfo.twitter, label: 'X / Twitter', icon: '𝕏' });
                if (coinInfo.telegram) links.push({ url: coinInfo.telegram, label: 'Telegram', icon: '✈️' });
                if (coinInfo.discord) links.push({ url: coinInfo.discord, label: 'Discord', icon: '💬' });
                if (coinInfo.reddit) links.push({ url: coinInfo.reddit, label: 'Reddit', icon: '🔴' });
                if (coinInfo.github) links.push({ url: coinInfo.github, label: 'GitHub', icon: '🐙' });
                if (!links.length) return null;
                return (
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                    {links.map((l, i) => (
                      <a
                        key={i}
                        href={l.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        title={l.label}
                        style={{
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: 4,
                          background: '#151520',
                          border: '1px solid #2a2a3a',
                          borderRadius: 6,
                          padding: '3px 10px',
                          fontSize: 11,
                          color: '#aaa',
                          textDecoration: 'none',
                          cursor: 'pointer',
                          transition: 'border-color .15s',
                        }}
                        onMouseEnter={(e) => { (e.currentTarget as HTMLAnchorElement).style.borderColor = '#ff9900'; }}
                        onMouseLeave={(e) => { (e.currentTarget as HTMLAnchorElement).style.borderColor = '#2a2a3a'; }}
                      >
                        <span style={{ fontSize: 13 }}>{l.icon}</span>
                        <span>{l.label}</span>
                      </a>
                    ))}
                  </div>
                );
              })()}

              {/* ── Fiyat Kilometre Taşları: Lansman / ATH / ATL ─────── */}
              {(coinInfo.athPrice != null || coinInfo.atlPrice != null || coinInfo.launchPrice != null) && (
                <div style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
                  gap: 8,
                }}>
                  {/* LAUNCH */}
                  {coinInfo.genesisDate && (
                    <div style={{
                      background: '#0d1117',
                      border: '1px solid #1a2a3a',
                      borderLeft: '3px solid #00bfff',
                      borderRadius: 8,
                      padding: '10px 14px',
                    }}>
                      <div style={{ fontSize: 9, fontWeight: 800, color: '#00bfff', letterSpacing: 1, marginBottom: 6 }}>
                        🚀 {t('launchInfo')}
                      </div>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                          <span style={{ fontSize: 9, color: '#666' }}>{t('launchDate')}</span>
                          <span style={{ fontSize: 10, color: '#ccc', fontWeight: 700 }}>
                            {new Date(coinInfo.genesisDate).toLocaleDateString(getLocale(), { day: '2-digit', month: 'short', year: 'numeric' })}
                          </span>
                        </div>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                          <span style={{ fontSize: 9, color: '#666' }}>{t('launchPrice')}</span>
                          <span style={{ fontSize: 10, color: '#ccc', fontWeight: 700 }}>
                            {coinInfo.launchPrice != null
                              ? `$${coinInfo.launchPrice < 1 ? coinInfo.launchPrice.toPrecision(4) : coinInfo.launchPrice.toLocaleString('en-US', { maximumFractionDigits: 2 })}`
                              : t('noData')}
                          </span>
                        </div>
                        {coinInfo.launchChangePercentage != null && (
                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                            <span style={{ fontSize: 9, color: '#666' }}>{t('launchDistance')}</span>
                            <span style={{
                              fontSize: 11,
                              fontWeight: 900,
                              color: coinInfo.launchChangePercentage >= 0 ? '#50ff50' : '#ff5050',
                            }}>
                              {coinInfo.launchChangePercentage >= 0 ? '+' : ''}{coinInfo.launchChangePercentage.toFixed(1)}%
                            </span>
                          </div>
                        )}
                      </div>
                    </div>
                  )}

                  {/* ATH */}
                  {coinInfo.athPrice != null && (
                    <div style={{
                      background: '#0d1117',
                      border: '1px solid #1a3a1a',
                      borderLeft: '3px solid #50ff50',
                      borderRadius: 8,
                      padding: '10px 14px',
                    }}>
                      <div style={{ fontSize: 9, fontWeight: 800, color: '#50ff50', letterSpacing: 1, marginBottom: 6 }}>
                        👑 {t('athInfo')}
                      </div>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                          <span style={{ fontSize: 9, color: '#666' }}>{t('athDate')}</span>
                          <span style={{ fontSize: 10, color: '#ccc', fontWeight: 700 }}>
                            {coinInfo.athDate
                              ? new Date(coinInfo.athDate).toLocaleDateString(getLocale(), { day: '2-digit', month: 'short', year: 'numeric' })
                              : t('noData')}
                          </span>
                        </div>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                          <span style={{ fontSize: 9, color: '#666' }}>ATH</span>
                          <span style={{ fontSize: 12, color: '#50ff50', fontWeight: 900 }}>
                            ${coinInfo.athPrice < 1 ? coinInfo.athPrice.toPrecision(4) : coinInfo.athPrice.toLocaleString('en-US', { maximumFractionDigits: 2 })}
                          </span>
                        </div>
                        {coinInfo.athChangePercentage != null && (
                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                            <span style={{ fontSize: 9, color: '#666' }}>{t('athDistance')}</span>
                            <span style={{
                              fontSize: 11,
                              fontWeight: 900,
                              color: '#ff5050',
                            }}>
                              {coinInfo.athChangePercentage.toFixed(1)}%
                            </span>
                          </div>
                        )}
                      </div>
                    </div>
                  )}

                  {/* ATL */}
                  {coinInfo.atlPrice != null && (
                    <div style={{
                      background: '#0d1117',
                      border: '1px solid #3a1a1a',
                      borderLeft: '3px solid #ff5050',
                      borderRadius: 8,
                      padding: '10px 14px',
                    }}>
                      <div style={{ fontSize: 9, fontWeight: 800, color: '#ff5050', letterSpacing: 1, marginBottom: 6 }}>
                        📉 {t('atlInfo')}
                      </div>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                          <span style={{ fontSize: 9, color: '#666' }}>{t('atlDate')}</span>
                          <span style={{ fontSize: 10, color: '#ccc', fontWeight: 700 }}>
                            {coinInfo.atlDate
                              ? new Date(coinInfo.atlDate).toLocaleDateString(getLocale(), { day: '2-digit', month: 'short', year: 'numeric' })
                              : t('noData')}
                          </span>
                        </div>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                          <span style={{ fontSize: 9, color: '#666' }}>ATL</span>
                          <span style={{ fontSize: 12, color: '#ff5050', fontWeight: 900 }}>
                            ${coinInfo.atlPrice < 1 ? coinInfo.atlPrice.toPrecision(4) : coinInfo.atlPrice.toLocaleString('en-US', { maximumFractionDigits: 2 })}
                          </span>
                        </div>
                        {coinInfo.atlChangePercentage != null && (
                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                            <span style={{ fontSize: 9, color: '#666' }}>{t('atlDistance')}</span>
                            <span style={{
                              fontSize: 11,
                              fontWeight: 900,
                              color: '#50ff50',
                            }}>
                              +{coinInfo.atlChangePercentage.toFixed(1)}%
                            </span>
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* Açıklama — collapse/expand */}
              {(coinInfo.descriptionTr || coinInfo.descriptionEn) && (
                <div>
                  <button
                    onClick={() => setInfoExpanded(!infoExpanded)}
                    style={{
                      background: 'none',
                      border: 'none',
                      color: '#ff9900',
                      cursor: 'pointer',
                      fontFamily: 'monospace',
                      fontSize: 10,
                      padding: 0,
                      marginBottom: infoExpanded ? 6 : 0,
                    }}
                  >
                    {infoExpanded ? t('hideDesc') : t('showDesc')}
                  </button>
                  {infoExpanded && (
                    <div
                      style={{
                        fontSize: 11,
                        lineHeight: '1.6',
                        color: '#999',
                        maxHeight: 200,
                        overflow: 'auto',
                      }}
                      dangerouslySetInnerHTML={{
                        __html: coinInfo.descriptionTr || coinInfo.descriptionEn,
                      }}
                    />
                  )}
                </div>
              )}
            </div>
          )}

          {/* ═══════════ ÜST BÖLÜM — AGGREGATED ÖZET KARTLARI ═════════ */}
          <SectionTitle text="AGGREGATED SUMMARY" />
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
            gap: 12,
            marginBottom: 24,
          }}>
            <SummaryCard
              label={t('netCvdInflow')}
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
            <LiquidationTotalCard
              totalLong={data.aggregated.totalLiqLongUsd}
              totalShort={data.aggregated.totalLiqShortUsd}
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

          {/* ═══════════ HABER BÖLÜMü — SON 1 AY ═══════════════════════ */}
          <SectionTitle text={t('newsTitle', { coin: baseCoin })} />
          <div style={{
            background: '#0a0a12',
            border: '1px solid #1a1a2e',
            borderRadius: 8,
            padding: 12,
            marginBottom: 24,
            maxHeight: 500,
            overflow: 'auto',
          }}>
            {newsLoading && !newsData && (
              <div style={{ textAlign: 'center', color: '#ff9900', fontSize: 12, padding: 20 }}>
                {t('loadingNews')}
              </div>
            )}
            {!newsLoading && (!newsData || newsData.news.length === 0) && (
              <div style={{ textAlign: 'center', color: '#555', fontSize: 11, padding: 20 }}>
                {t('noNewsFound', { coin: baseCoin })}
              </div>
            )}
            {newsData && newsData.news.length > 0 && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {newsData.news.map((item, i) => (
                  <NewsRow key={i} item={item} />
                ))}
              </div>
            )}
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
            {t('backToDashboard')}
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

function LiquidationTotalCard({ totalLong, totalShort }: {
  totalLong: number;
  totalShort: number;
}) {
  const total = totalLong + totalShort;
  const dominant = totalLong >= totalShort ? 'long' : 'short';
  const totalColor = dominant === 'long' ? '#ff5050' : '#50ff50';

  return (
    <div style={{
      background: '#0a0a14',
      border: '1px solid #1a1a2e',
      borderRadius: 8,
      padding: '16px 18px',
      display: 'flex',
      flexDirection: 'column',
      gap: 6,
    }}>
      <div style={{ fontSize: 9, color: '#666', letterSpacing: 1, textTransform: 'uppercase' }}>
        TOTAL LIQUIDATIONS
      </div>
      <div style={{
        fontSize: 26,
        fontWeight: 900,
        color: totalColor,
        letterSpacing: 1,
      }}>
        {fmtUsd(total)}
      </div>
      <div style={{
        display: 'flex',
        gap: 12,
        marginTop: 2,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <span style={{ fontSize: 9, color: '#ff5050', fontWeight: 700 }}>LONG</span>
          <span style={{ fontSize: 12, color: '#ff5050', fontWeight: 800 }}>{fmtUsd(totalLong)}</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <span style={{ fontSize: 9, color: '#50ff50', fontWeight: 700 }}>SHORT</span>
          <span style={{ fontSize: 12, color: '#50ff50', fontWeight: 800 }}>{fmtUsd(totalShort)}</span>
        </div>
      </div>
      {/* Mini bar showing ratio */}
      <div style={{
        height: 4,
        borderRadius: 2,
        background: '#151520',
        overflow: 'hidden',
        display: 'flex',
      }}>
        <div style={{
          width: total > 0 ? `${(totalLong / total * 100).toFixed(1)}%` : '50%',
          background: '#ff5050',
          borderRadius: '2px 0 0 2px',
        }} />
        <div style={{
          flex: 1,
          background: '#50ff50',
          borderRadius: '0 2px 2px 0',
        }} />
      </div>
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
          {t('oiEstimated')}
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

/** Dynamic price formatter — adjusts decimals based on price magnitude */
function fmtDepthPrice(p: number): string {
  if (p === 0) return '$0';
  const abs = Math.abs(p);
  if (abs >= 100000) return '$' + (p / 1000).toFixed(1) + 'K';
  if (abs >= 10000)  return '$' + (p / 1000).toFixed(2) + 'K';
  if (abs >= 1000)   return '$' + (p / 1000).toFixed(3) + 'K';
  if (abs >= 100)    return '$' + p.toFixed(2);
  if (abs >= 10)     return '$' + p.toFixed(3);
  if (abs >= 1)      return '$' + p.toFixed(3);
  // Sub-$1: show 4 significant digits after leading zeros
  const digits = Math.max(4, -Math.floor(Math.log10(abs)) + 3);
  return '$' + p.toFixed(digits);
}

/** Safe array max that doesn't blow the stack for large arrays */
function safeMax(arr: number[], fallback = 1): number {
  let m = fallback;
  for (const v of arr) { if (v > m) m = v; }
  return m;
}

/** Downsample a sorted array to at most maxN entries, keeping first and last */
function downsample<T>(arr: T[], maxN: number): T[] {
  if (arr.length <= maxN) return arr;
  const result: T[] = [arr[0]!];
  const step = (arr.length - 1) / (maxN - 1);
  for (let i = 1; i < maxN - 1; i++) {
    result.push(arr[Math.round(i * step)]!);
  }
  result.push(arr[arr.length - 1]!);
  return result;
}

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
  const maxVol = safeMax([
    ...bidCum.filter(b => b.price >= minPrice).map(b => b.vol),
    ...askCum.filter(a => a.price <= maxPrice).map(a => a.vol),
  ]);

  const PAD_L = 55;
  const PAD_R = 40;
  const chartW = W - PAD_L - PAD_R;
  const chartH = H - 50;

  const priceToX = (p: number) => PAD_L + ((p - minPrice) / (maxPrice - minPrice)) * chartW;
  const volToY = (v: number) => 20 + chartH - (v / maxVol) * chartH;

  // Grid lines
  ctx.strokeStyle = '#151520';
  ctx.lineWidth = 0.5;
  for (let i = 0; i <= 4; i++) {
    const y = 20 + (chartH / 4) * i;
    ctx.beginPath(); ctx.moveTo(PAD_L, y); ctx.lineTo(W - PAD_R, y); ctx.stroke();
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
  ctx.fillText(`Mid: ${fmtDepthPrice(midPrice)}`, midX, 14);

  // Downsample for smooth rendering (max ~1000 points per side)
  const MAX_PTS = 1000;

  // Draw bid mountain (green)
  const filteredBids = downsample(
    bidCum.filter(b => b.price >= minPrice && b.price <= maxPrice),
    MAX_PTS,
  );
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
  const filteredAsks = downsample(
    askCum.filter(a => a.price >= minPrice && a.price <= maxPrice),
    MAX_PTS,
  );
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

  // Find biggest walls — sort by USD value (qty × price) for fair comparison
  const allLevels = [
    ...bids.filter(b => b[0] >= minPrice && b[0] <= maxPrice).map(b => ({ price: b[0], qty: b[1], usd: b[0] * b[1], side: 'bid' as const })),
    ...asks.filter(a => a[0] >= minPrice && a[0] <= maxPrice).map(a => ({ price: a[0], qty: a[1], usd: a[0] * a[1], side: 'ask' as const })),
  ];
  allLevels.sort((a, b) => b.usd - a.usd);
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
    ctx.fillText(fmtDepthPrice(wall.price), wx, wy - 6);
    ctx.fillText(`$${fmt(wall.usd)}`, wx, wy + 6);
  }

  // Price axis labels — adaptive count to prevent overlap
  ctx.fillStyle = '#555';
  ctx.font = '9px monospace';
  ctx.textAlign = 'center';
  const sampleLabel = fmtDepthPrice(midPrice);
  const pxPerLabel = Math.max(80, sampleLabel.length * 6 + 16);
  const labelCount = Math.max(3, Math.min(8, Math.floor(chartW / pxPerLabel)));
  for (let i = 0; i <= labelCount; i++) {
    const p = minPrice + ((maxPrice - minPrice) / labelCount) * i;
    const x = priceToX(p);
    ctx.fillText(fmtDepthPrice(p), x, 20 + chartH + 14);
  }

  // Vol axis labels
  ctx.textAlign = 'right';
  for (let i = 0; i <= 4; i++) {
    const v = (maxVol / 4) * (4 - i);
    const y = 20 + (chartH / 4) * i;
    ctx.fillText(fmt(v), PAD_L - 4, y + 3);
  }
}

// ── Importance Badge ─────────────────────────────────────────────────────────
const IMPORTANCE_STYLES: Record<string, { bg: string; fg: string; labelKey: string }> = {
  critical: { bg: '#ff000025', fg: '#ff4444', labelKey: 'critical' },
  high:     { bg: '#ff990025', fg: '#ff9900', labelKey: 'high' },
  medium:   { bg: '#00bfff20', fg: '#00bfff', labelKey: 'medium' },
  low:      { bg: '#88888815', fg: '#888',    labelKey: 'low' },
};

function ImportanceBadge({ importance }: { importance: string }) {
  const style = IMPORTANCE_STYLES[importance] ?? IMPORTANCE_STYLES['low']!;
  return (
    <span style={{
      display: 'inline-block',
      padding: '2px 8px',
      borderRadius: 4,
      background: style.bg,
      color: style.fg,
      fontSize: 8,
      fontWeight: 800,
      letterSpacing: 0.8,
      border: `1px solid ${style.fg}33`,
      whiteSpace: 'nowrap',
    }}>
      {t(style.labelKey)}
    </span>
  );
}

// ── NewsRow ──────────────────────────────────────────────────────────────────
function NewsRow({ item }: { item: NewsItem }) {
  const date = new Date(item.publishedAt);
  const dateStr = `${date.toLocaleDateString('tr-TR', { day: '2-digit', month: '2-digit', year: 'numeric' })} ${date.toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' })}`;
  const hasTranslation = item.title !== item.titleOriginal;

  return (
    <a
      href={item.url}
      target="_blank"
      rel="noopener noreferrer"
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
        padding: '10px 14px',
        background: '#0c0c18',
        border: '1px solid #1a1a2e',
        borderRadius: 6,
        textDecoration: 'none',
        cursor: 'pointer',
        transition: 'border-color 0.15s, background 0.15s',
      }}
      onMouseEnter={(e) => {
        (e.currentTarget as HTMLAnchorElement).style.borderColor = '#ff990066';
        (e.currentTarget as HTMLAnchorElement).style.background = '#0e0e1e';
      }}
      onMouseLeave={(e) => {
        (e.currentTarget as HTMLAnchorElement).style.borderColor = '#1a1a2e';
        (e.currentTarget as HTMLAnchorElement).style.background = '#0c0c18';
      }}
    >
      {/* Üst satır: importance + source + tarih */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <ImportanceBadge importance={item.importance} />
        <span style={{
          fontSize: 9,
          fontWeight: 700,
          color: '#666',
          padding: '1px 6px',
          background: '#151520',
          borderRadius: 3,
          border: '1px solid #222',
        }}>
          {item.source}
        </span>
        <span style={{ fontSize: 9, color: '#555', marginLeft: 'auto' }}>
          {dateStr}
        </span>
      </div>
      {/* Başlık (çevrilmiş) */}
      <div style={{
        fontSize: 12,
        fontWeight: 600,
        color: '#ddd',
        lineHeight: '1.5',
      }}>
        {item.title}
      </div>
      {/* Orijinal başlık (çeviri varsa) */}
      {hasTranslation && (
        <div style={{
          fontSize: 10,
          color: '#555',
          fontStyle: 'italic',
          lineHeight: '1.4',
        }}>
          {item.titleOriginal}
        </div>
      )}
    </a>
  );
}

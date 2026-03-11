// ─────────────────────────────────────────────────────────────────────────────
// utils/i18n.ts — Lightweight i18n (TR / EN)
// ─────────────────────────────────────────────────────────────────────────────
// Usage:
//   import { t, useLang } from '../utils/i18n';
//   const lang = useLang();          // reactive hook for components
//   t('exchanges')                   // returns translated string
//   t('newsTitle', { coin: 'BTC' })  // with interpolation
// ─────────────────────────────────────────────────────────────────────────────

import { createStore, useStore } from 'zustand';

export type Lang = 'tr' | 'en';

interface LangState {
  lang: Lang;
}

const langStore = createStore<LangState>(() => ({
  lang: (typeof localStorage !== 'undefined' && localStorage.getItem('hft-lang') as Lang) || 'tr',
}));

export function setLang(lang: Lang): void {
  langStore.setState({ lang });
  if (typeof localStorage !== 'undefined') {
    localStorage.setItem('hft-lang', lang);
  }
}

export function getLang(): Lang {
  return langStore.getState().lang;
}

/** React hook — triggers re-render on lang change */
export function useLang(): Lang {
  return useStore(langStore, (s) => s.lang);
}

// ── Translation Dictionary ──────────────────────────────────────────────────

type TranslationDict = Record<string, Record<Lang, string>>;

const dict: TranslationDict = {
  // ── Navigation ─────────────────────────────────────────────────────────────
  exchanges:           { tr: 'BORSALAR',   en: 'EXCHANGES' },
  overview:            { tr: 'GENEL BAKIŞ', en: 'OVERVIEW' },

  // ── Radar Panel ────────────────────────────────────────────────────────────
  scanWaiting:         { tr: 'Tarama bekleniyor...', en: 'Scanning...' },
  noWhaleYet:          { tr: 'Henüz $100K+ whale veya $10K+ tasfiye tespit edilmedi.', en: 'No $100K+ whale trades or $10K+ liquidations detected yet.' },
  alarmWillAppear:     { tr: 'Alarm tetiklendiğinde burada kayıt oluşacak.', en: 'Records will appear here when alerts trigger.' },

  // ── CoinMR Panel ───────────────────────────────────────────────────────────
  loadingData:         { tr: '⟳ Veriler çekiliyor...', en: '⟳ Loading data...' },
  error:               { tr: '⚠ Hata: ', en: '⚠ Error: ' },
  hideDesc:            { tr: '▼ Açıklamayı gizle', en: '▼ Hide description' },
  showDesc:            { tr: '▶ Açıklamayı göster', en: '▶ Show description' },
  netCvdInflow:        { tr: 'Net CVD (Para Girişi)', en: 'Net CVD (Money Flow)' },
  newsTitle:           { tr: '{coin} HABERLERİ — SON 30 GÜN', en: '{coin} NEWS — LAST 30 DAYS' },
  loadingNews:         { tr: '⟳ Haberler çekiliyor...', en: '⟳ Loading news...' },
  noNewsFound:         { tr: '{coin} için son 30 günde haber bulunamadı.', en: 'No news found for {coin} in the last 30 days.' },
  backToDashboard:     { tr: 'İSTİHBARAT TAMAM — OPERASYONA (DASHBOARD) GEÇ', en: 'RECON COMPLETE — RETURN TO DASHBOARD' },
  oiEstimated:         { tr: 'OI ağırlıklı tahmin (API yok)', en: 'OI-weighted estimate (no API)' },
  noExListing:         { tr: '{ex} {label} yok', en: '{ex} no {label}' },

  // ── Importance Badges ──────────────────────────────────────────────────────
  critical:            { tr: 'KRİTİK',  en: 'CRITICAL' },
  high:                { tr: 'YÜKSEK',  en: 'HIGH' },
  medium:              { tr: 'ORTA',    en: 'MEDIUM' },
  low:                 { tr: 'DÜŞÜK',   en: 'LOW' },

  // ── Price Milestones (CoinMR) ──────────────────────────────────────────────
  launchInfo:          { tr: 'LANSMAN',                        en: 'LAUNCH' },
  launchDate:          { tr: 'Çıkış Tarihi',                   en: 'Launch Date' },
  launchPrice:         { tr: 'Çıkış Fiyatı',                   en: 'Launch Price' },
  launchDistance:      { tr: 'Çıkıştan Uzaklık',               en: 'From Launch' },
  athInfo:             { tr: 'ATH (Tüm Zamanların En Yükseği)', en: 'ATH (All-Time High)' },
  athDate:             { tr: 'ATH Tarihi',                      en: 'ATH Date' },
  athDistance:          { tr: "ATH'ye Uzaklık",                  en: 'Distance to ATH' },
  atlInfo:             { tr: 'ATL (Tüm Zamanların En Düşüğü)',  en: 'ATL (All-Time Low)' },
  atlDate:             { tr: 'ATL Tarihi',                      en: 'ATL Date' },
  atlDistance:          { tr: "ATL'ye Uzaklık",                  en: 'Distance from ATL' },
  noData:              { tr: 'Veri yok',                        en: 'N/A' },

  // ── Overview Panel ─────────────────────────────────────────────────────────
  strongLong:          { tr: 'GÜÇLÜ LONG',    en: 'STRONG LONG' },
  long:                { tr: 'LONG',           en: 'LONG' },
  neutral:             { tr: 'NÖTR / BEKLE',   en: 'NEUTRAL / WAIT' },
  short:               { tr: 'SHORT',          en: 'SHORT' },
  strongShort:         { tr: 'GÜÇLÜ SHORT',    en: 'STRONG SHORT' },
  overviewSubtitle:    { tr: '{symbol} — Genel Piyasa Yön Analizi', en: '{symbol} — Market Direction Analysis' },
  refresh:             { tr: '↻ YENİLE',       en: '↻ REFRESH' },
  loadingOverview:     { tr: '⟳ 4 zaman diliminde 72+ API çağrısı yapılıyor... (10-30sn)', en: '⟳ Fetching 72+ APIs across 4 timeframes... (10-30s)' },
  btcPrice:            { tr: 'BTC FİYAT',      en: 'BTC PRICE' },
  btcDominance:        { tr: 'BTC.D (Dominans)', en: 'BTC.D (Dominance)' },
  fetchDuration:       { tr: 'Çekim Süresi',    en: 'Fetch Duration' },
  lastUpdate:          { tr: 'Güncelleme',       en: 'Last Update' },
  timeframeAnalysis:   { tr: 'ZAMAN DİLİMİ ANALİZİ',                        en: 'TIMEFRAME ANALYSIS' },
  exchangeComparison:  { tr: 'BORSA KARŞILAŞTIRMA — DETAYLI KIRILIM',        en: 'EXCHANGE COMPARISON — DETAILED BREAKDOWN' },
  signalGuide:         { tr: 'SİNYAL REHBERİ',                               en: 'SIGNAL GUIDE' },
  backToDash:          { tr: "DASHBOARD'A DÖN",                               en: 'BACK TO DASHBOARD' },
  totalOI:             { tr: 'Toplam OI',        en: 'Total OI' },
  fundingAvg:          { tr: 'Funding (Ort)',     en: 'Funding (Avg)' },
  annualized:          { tr: 'Yıllık: {val}',    en: 'Annual: {val}' },
  liquidations:        { tr: 'Tasfiyeler',       en: 'Liquidations' },
  priceLabel:          { tr: 'Fiyat',            en: 'Price' },
  exchangeHeader:      { tr: 'Borsa',            en: 'Exchange' },
  weight:              { tr: 'Ağırlık: {val}',   en: 'Weight: {val}' },

  // ── Signal Guide Descriptions ──────────────────────────────────────────────
  oiDesc:         { tr: 'Toplam açık pozisyon değişimi. Artan OI = momentum var, azalan OI = momentum kaybı. OI artışı + fiyat yükselişi = sağlıklı trend.',
                    en: 'Total open position change. Rising OI = momentum present, declining OI = momentum fading. OI increase + price rise = healthy trend.' },
  fundingDesc:    { tr: "Pozitif funding = long'lar short'lara ödüyor (aşırı long kalabalığı → contrarian short sinyali). Negatif funding = short'lar long'lara ödüyor (contrarian long sinyali).",
                    en: 'Positive funding = longs pay shorts (overcrowded longs → contrarian short signal). Negative funding = shorts pay longs (contrarian long signal).' },
  lsDesc:         { tr: 'Long/Short hesap oranı. Kalabalığın tersi genelde doğru: çoğunluk long ise → contrarian short, çoğunluk short ise → contrarian long.',
                    en: 'Long/Short account ratio. The opposite of the crowd is usually correct: majority long → contrarian short, majority short → contrarian long.' },
  cvdDesc:        { tr: 'Alıcı vs satıcı hacim farkı. Pozitif CVD = net alıcı baskısı = bullish momentum. Negatif CVD = net satıcı baskısı = bearish momentum.',
                    en: 'Buyer vs seller volume difference. Positive CVD = net buyer pressure = bullish momentum. Negative CVD = net seller pressure = bearish momentum.' },
  liqName:        { tr: 'Tasfiyeler (Liquidations)',        en: 'Liquidations' },
  liqDesc:        { tr: 'Çok long tasfiye edilmişse → dip yakın (long fırsatı). Çok short tasfiye edilmişse → top yakın (short fırsatı). Cascade likidasyonlar = tersine dönüş sinyali.',
                    en: 'Many long liquidations → bottom near (long opportunity). Many short liquidations → top near (short opportunity). Cascade liquidations = reversal signal.' },
  priceMomentum:  { tr: 'Fiyat Momentum',                  en: 'Price Momentum' },
  priceDesc:      { tr: 'Seçili TF içindeki fiyat değişim yüzdesi. Güçlü yükseliş = long sinyali, güçlü düşüş = short sinyali. Diğer sinyallerle teyitlenmeli.',
                    en: 'Price change percentage within selected TF. Strong rise = long signal, strong drop = short signal. Should be confirmed with other signals.' },

  // ── ExchangesPanel ─────────────────────────────────────────────────────────
  exchangesTitle:      { tr: 'BORSALAR', en: 'EXCHANGES' },
};

// ── Translate Function ──────────────────────────────────────────────────────

export function t(key: string, params?: Record<string, string>): string {
  const lang = langStore.getState().lang;
  const entry = dict[key];
  if (!entry) return key;
  let text = entry[lang] ?? entry['tr'] ?? key;
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      text = text.replace(`{${k}}`, v);
    }
  }
  return text;
}

/** Get locale string for date formatting */
export function getLocale(): string {
  return langStore.getState().lang === 'tr' ? 'tr-TR' : 'en-US';
}

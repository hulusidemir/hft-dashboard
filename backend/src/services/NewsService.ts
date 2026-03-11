// ─────────────────────────────────────────────────────────────────────────────
// services/NewsService.ts — Coin Haber Servisi
// ─────────────────────────────────────────────────────────────────────────────
// Birincil: CryptoCompare News API (ücretsiz, API key gerektirmez)
// İkincil: CryptoPanic (CRYPTOPANIC_API_KEY varsa)
// Ek:      Binance duyurular
// Cache:   sembol bazlı, 10 dakika TTL.
// ─────────────────────────────────────────────────────────────────────────────

import axios from 'axios';
import { Logger } from '../utils/logger.js';

const log = new Logger('NewsService');

const TIMEOUT = 15_000;

// ── CryptoCompare Config (FREE — no API key) ───────────────────────────────
const CRYPTOCOMPARE_NEWS = 'https://min-api.cryptocompare.com/data/v2/news/';

// ── CryptoPanic Config (optional) ──────────────────────────────────────────
const CRYPTOPANIC_BASE = 'https://cryptopanic.com/api/free/v1/posts/';
const CRYPTOPANIC_TOKEN = process.env['CRYPTOPANIC_API_KEY'] || '';

// ── MyMemory Translation Config ─────────────────────────────────────────────
const MYMEMORY_BASE = 'https://api.mymemory.translated.net/get';

// ── Types ────────────────────────────────────────────────────────────────────
export interface NewsItem {
  title: string;          // Türkçe çeviri (varsa), yoksa orijinal
  titleOriginal: string;  // Orijinal başlık
  source: string;         // Kaynak adı
  url: string;            // Haber linki
  publishedAt: string;    // ISO tarih
  importance: 'critical' | 'high' | 'medium' | 'low';
  currency: string;       // İlgili coin
  imageUrl?: string;      // Haber görseli (varsa)
}

export interface NewsResult {
  symbol: string;
  news: NewsItem[];
  fetchedAt: number;
  source: string;         // 'cryptocompare' | 'cryptopanic' | 'mixed' | 'none'
}

// ── Cache ────────────────────────────────────────────────────────────────────
interface CacheEntry {
  data: NewsResult;
  ts: number;
}

const newsCache = new Map<string, CacheEntry>();
const CACHE_TTL = 10 * 60 * 1000; // 10 dakika

// ── Symbol → Currency Code ──────────────────────────────────────────────────
function symbolToCurrency(symbol: string): string {
  return symbol.replace(/USDT$/i, '').toUpperCase();
}

// ── Importance Helper (CryptoCompare) ────────────────────────────────────────
function ccImportance(categories: string): 'critical' | 'high' | 'medium' | 'low' {
  const lower = categories.toLowerCase();
  if (lower.includes('sponsored')) return 'low';
  if (lower.includes('regulation') || lower.includes('ico') || lower.includes('exchange')) return 'high';
  if (lower.includes('mining') || lower.includes('trading') || lower.includes('market')) return 'medium';
  return 'medium';
}

// ── Importance Helper (CryptoPanic) ──────────────────────────────────────────
function cpImportance(votes: { positive?: number; negative?: number; important?: number; liked?: number; saved?: number } | undefined): 'critical' | 'high' | 'medium' | 'low' {
  if (!votes) return 'low';
  const imp = votes.important ?? 0;
  const pos = votes.positive ?? 0;
  const liked = votes.liked ?? 0;
  const total = imp + pos + liked;

  if (imp >= 3 || total >= 10) return 'critical';
  if (imp >= 1 || total >= 5) return 'high';
  if (pos >= 2 || liked >= 2) return 'medium';
  return 'low';
}

// ── Translation Helper ──────────────────────────────────────────────────────
async function translateToTurkish(text: string): Promise<string> {
  if (!text || text.length < 3) return text;

  try {
    const resp = await axios.get(MYMEMORY_BASE, {
      params: {
        q: text.slice(0, 500),
        langpair: 'en|tr',
      },
      timeout: 8_000,
    });

    const data = resp.data as {
      responseStatus: number;
      responseData?: { translatedText?: string };
    };

    if (data.responseStatus === 200 && data.responseData?.translatedText) {
      const translated = data.responseData.translatedText;
      if (translated.toUpperCase().includes('PLEASE SELECT')) return text;
      if (translated.length < 5 || translated === text) return text;
      return translated;
    }
    return text;
  } catch {
    return text;
  }
}

// ── Batch translate (rate limiting ile) ─────────────────────────────────────
async function batchTranslate(titles: string[]): Promise<string[]> {
  const results: string[] = [];
  for (const title of titles) {
    const translated = await translateToTurkish(title);
    results.push(translated);
    await new Promise(r => setTimeout(r, 200));
  }
  return results;
}

// ═══════════════════════════════════════════════════════════════════════════════
// ── CryptoCompare News Fetch (BİRİNCİL — ÜCRETSİZ) ─────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════
interface CryptoCompareNewsItem {
  id: string;
  published_on: number;
  imageurl: string;
  title: string;
  url: string;
  body: string;
  tags: string;
  categories: string;
  source: string;
  source_info?: { name: string; img: string; lang: string };
}

interface CryptoCompareNewsResponse {
  Data: CryptoCompareNewsItem[];
  Type: number;
  Message: string;
}

async function fetchFromCryptoCompare(currency: string): Promise<NewsItem[]> {
  try {
    const resp = await axios.get<CryptoCompareNewsResponse>(CRYPTOCOMPARE_NEWS, {
      params: {
        lang: 'EN',
        categories: currency,
        sortOrder: 'popular',
        extraParams: 'hft-dashboard',
      },
      timeout: TIMEOUT,
    });

    if (!resp.data?.Data?.length) {
      log.warn(`CryptoCompare: ${currency} için haber bulunamadı`);
      return [];
    }

    const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;

    const items: NewsItem[] = resp.data.Data
      .filter(p => (p.published_on * 1000) > thirtyDaysAgo)
      .slice(0, 30)
      .map(p => ({
        title: p.title,
        titleOriginal: p.title,
        source: p.source_info?.name || p.source || 'CryptoCompare',
        url: p.url,
        publishedAt: new Date(p.published_on * 1000).toISOString(),
        importance: ccImportance(p.categories),
        currency,
        imageUrl: p.imageurl || undefined,
      }));

    log.info(`CryptoCompare: ${currency} için ${items.length} haber çekildi`);
    return items;
  } catch (err) {
    log.error('CryptoCompare fetch hatası', err instanceof Error ? err : new Error(String(err)));
    return [];
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// ── CryptoPanic Fetch (İKİNCİL — API key gerektirir) ────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════
interface CryptoPanicPost {
  kind: string;
  domain?: string;
  title: string;
  published_at: string;
  url: string;
  source?: { title: string; domain: string };
  votes?: {
    positive?: number;
    negative?: number;
    important?: number;
    liked?: number;
    saved?: number;
  };
  currencies?: Array<{ code: string; title: string }>;
}

interface CryptoPanicResponse {
  count: number;
  results: CryptoPanicPost[];
}

async function fetchFromCryptoPanic(currency: string): Promise<NewsItem[]> {
  if (!CRYPTOPANIC_TOKEN) {
    // API key yoksa sessizce atla — CryptoCompare birincil kaynak
    return [];
  }

  try {
    const resp = await axios.get<CryptoPanicResponse>(CRYPTOPANIC_BASE, {
      params: {
        auth_token: CRYPTOPANIC_TOKEN,
        currencies: currency,
        kind: 'news',
        filter: 'hot',
        public: 'true',
      },
      timeout: TIMEOUT,
    });

    const posts = resp.data.results || [];
    const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;

    return posts
      .filter(p => new Date(p.published_at).getTime() > thirtyDaysAgo)
      .map(p => ({
        title: p.title,
        titleOriginal: p.title,
        source: p.source?.title || p.domain || 'CryptoPanic',
        url: p.url,
        publishedAt: p.published_at,
        importance: cpImportance(p.votes),
        currency,
      }));
  } catch (err) {
    log.error('CryptoPanic fetch hatası', err instanceof Error ? err : new Error(String(err)));
    return [];
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// ── Binance Announcements (Ek kaynak) ────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════
async function fetchBinanceAnnouncements(currency: string): Promise<NewsItem[]> {
  try {
    const resp = await axios.get('https://www.binance.com/bapi/composite/v1/public/cms/article/list/query', {
      params: {
        type: 1,
        catalogId: 48,
        pageNo: 1,
        pageSize: 20,
      },
      timeout: TIMEOUT,
      headers: {
        'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36',
      },
    });

    const data = resp.data as {
      data?: {
        articles?: Array<{
          title: string;
          releaseDate: number;
          code: string;
        }>;
      };
    };

    if (!data.data?.articles) return [];

    const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
    const currencyLower = currency.toLowerCase();

    return data.data.articles
      .filter(a => a.releaseDate > thirtyDaysAgo && a.title.toLowerCase().includes(currencyLower))
      .map(a => ({
        title: a.title,
        titleOriginal: a.title,
        source: 'Binance',
        url: `https://www.binance.com/en/support/announcement/${a.code}`,
        publishedAt: new Date(a.releaseDate).toISOString(),
        importance: 'high' as const,
        currency,
      }));
  } catch {
    return [];
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// ── Public API ───────────────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════

export async function fetchCoinNews(symbol: string): Promise<NewsResult> {
  const currency = symbolToCurrency(symbol);

  // Cache kontrol
  const cached = newsCache.get(currency);
  if (cached && Date.now() - cached.ts < CACHE_TTL) {
    log.info(`Haber cache hit: ${currency} (${cached.data.news.length} haber)`);
    return cached.data;
  }

  log.info(`Haberler çekiliyor: ${currency}`);

  // Paralel fetch — CryptoCompare (birincil) + CryptoPanic (opsiyonel) + Binance
  const [ccNews, cpNews, binanceNews] = await Promise.all([
    fetchFromCryptoCompare(currency),
    fetchFromCryptoPanic(currency),
    fetchBinanceAnnouncements(currency),
  ]);

  // Kaynak belirleme
  const sources: string[] = [];
  if (ccNews.length > 0) sources.push('cryptocompare');
  if (cpNews.length > 0) sources.push('cryptopanic');
  if (binanceNews.length > 0) sources.push('binance');

  // Birleştir, duplikatları URL'e göre filtrele, tarih sırala
  const seenUrls = new Set<string>();
  let allNews = [...ccNews, ...cpNews, ...binanceNews]
    .filter(n => {
      if (seenUrls.has(n.url)) return false;
      seenUrls.add(n.url);
      return true;
    })
    .sort((a, b) => new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime())
    .slice(0, 30);

  // Çeviri — sadece en önemli 15 haberi çevir (rate limit tasarrufu)
  if (allNews.length > 0) {
    try {
      const toTranslate = allNews.slice(0, 15);
      const titles = toTranslate.map(n => n.titleOriginal);
      const translated = await batchTranslate(titles);
      allNews = allNews.map((n, i) => ({
        ...n,
        title: i < 15 ? (translated[i] ?? n.titleOriginal) : n.titleOriginal,
      }));
    } catch {
      // Çeviri başarısız — orijinalleri kullan
    }
  }

  const sourceType = sources.length > 1 ? 'mixed' : (sources[0] || 'none');

  const result: NewsResult = {
    symbol,
    news: allNews,
    fetchedAt: Date.now(),
    source: sourceType,
  };

  log.info(`Haberler tamamlandı: ${currency} — ${allNews.length} haber (kaynak: ${sourceType})`);
  newsCache.set(currency, { data: result, ts: Date.now() });
  return result;
}

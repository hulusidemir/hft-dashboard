// ─────────────────────────────────────────────────────────────────────────────
// CoinInfoService.ts — CoinGecko üzerinden coin bilgisi çekme
// Market cap, kategori, Türkçe açıklama.  10 dk cache.
// ─────────────────────────────────────────────────────────────────────────────

import axios from 'axios';
import { Logger } from '../utils/logger.js';

const log = new Logger('CoinInfo');

const COINGECKO_BASE = 'https://api.coingecko.com/api/v3';
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 dakika

// ── Tipler ──────────────────────────────────────────────────────────────────

export interface CoinInfoResult {
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
  // Social links
  twitter: string;
  telegram: string;
  reddit: string;
  discord: string;
  github: string;
  website: string;
  // Exchange listings
  spotExchanges: string[];   // e.g. ['Binance','Coinbase','OKX','Bybit']
  perpExchanges: string[];   // e.g. ['Binance','OKX','Bybit']
  // Price milestones
  currentPrice: number;
  athPrice: number | null;
  athDate: string | null;              // ISO date, e.g. '2021-11-10T00:00:00.000Z'
  athChangePercentage: number | null;  // e.g. -52.3  (current is 52.3% below ATH)
  atlPrice: number | null;
  atlDate: string | null;
  atlChangePercentage: number | null;  // e.g. 12345.6 (current is 12345.6% above ATL)
  launchPrice: number | null;          // price on genesis_date (from /history)
  launchChangePercentage: number | null; // % change from launch to current
}

interface CacheEntry {
  data: CoinInfoResult;
  fetchedAt: number;
}

// ── Cache ───────────────────────────────────────────────────────────────────

const cache = new Map<string, CacheEntry>();

// ── CoinGecko ID mapping cache ──────────────────────────────────────────────
let coinListCache: { id: string; symbol: string; name: string }[] = [];
let coinListFetchedAt = 0;

async function getCoinList(): Promise<{ id: string; symbol: string; name: string }[]> {
  if (coinListCache.length > 0 && Date.now() - coinListFetchedAt < 60 * 60 * 1000) {
    return coinListCache;
  }
  try {
    const { data } = await axios.get<{ id: string; symbol: string; name: string }[]>(
      `${COINGECKO_BASE}/coins/list`,
      { timeout: 15000 },
    );
    coinListCache = data;
    coinListFetchedAt = Date.now();
    log.info(`CoinGecko coin list loaded: ${data.length} coins`);
    return data;
  } catch (err) {
    log.error('Failed to fetch coin list', err instanceof Error ? err : new Error(String(err)));
    return coinListCache; // stale data better than nothing
  }
}

/** BTCUSDT → BTC */
function stripQuote(symbol: string): string {
  return symbol.replace(/USDT$/i, '').toLowerCase();
}

/** Find CoinGecko ID from our symbol */
async function resolveGeckoId(symbol: string): Promise<string | null> {
  const base = stripQuote(symbol);

  // Well-known overrides — CoinGecko has many coins sharing the same ticker
  const KNOWN: Record<string, string> = {
    btc: 'bitcoin',
    eth: 'ethereum',
    sol: 'solana',
    bnb: 'binancecoin',
    xrp: 'ripple',
    doge: 'dogecoin',
    ada: 'cardano',
    trx: 'tron',
    avax: 'avalanche-2',
    dot: 'polkadot',
    link: 'chainlink',
    matic: 'matic-network',
    pol: 'matic-network',
    shib: 'shiba-inu',
    ltc: 'litecoin',
    atom: 'cosmos',
    uni: 'uniswap',
    apt: 'aptos',
    arb: 'arbitrum',
    op: 'optimism',
    near: 'near',
    sui: 'sui',
    sei: 'sei-network',
    fil: 'filecoin',
    pepe: 'pepe',
    wif: 'dogwifcoin',
    ftm: 'fantom',
    icp: 'internet-computer',
    vet: 'vechain',
    render: 'render-token',
    inj: 'injective-protocol',
    fet: 'fetch-ai',
    grt: 'the-graph',
    algo: 'algorand',
    floki: 'floki',
    sand: 'the-sandbox',
    mana: 'decentraland',
    aave: 'aave',
    mkr: 'maker',
    crv: 'curve-dao-token',
    ldo: 'lido-dao',
    pixel: 'pixels',
    ondo: 'ondo-finance',
    wld: 'worldcoin-wld',
    jup: 'jupiter-exchange-solana',
    bonk: 'bonk',
    '1000bonk': 'bonk',
    '1000pepe': 'pepe',
    '1000shib': 'shiba-inu',
    '1000floki': 'floki',
    ape: 'apecoin',
    axs: 'axie-infinity',
    ens: 'ethereum-name-service',
    snx: 'havven',
    comp: 'compound-governance-token',
    hbar: 'hedera-hashgraph',
    xlm: 'stellar',
    egld: 'elrond-erd-2',
    one: 'harmony',
    rose: 'oasis-network',
    zil: 'zilliqa',
    eos: 'eos',
    xtz: 'tezos',
    cake: 'pancakeswap-token',
    rune: 'thorchain',
    ar: 'arweave',
    jasmy: 'jasmycoin',
    pendle: 'pendle',
    w: 'wormhole',
    stx: 'blockstack',
    tia: 'celestia',
    ton: 'the-open-network',
    kas: 'kaspa',
    not: 'notcoin',
    bome: 'book-of-meme',
  };

  if (KNOWN[base]) return KNOWN[base]!;

  const list = await getCoinList();
  const candidates = list.filter((c) => c.symbol === base);

  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0]!.id;

  // Multiple matches — prefer the one whose ID contains the base name
  const nameMatch = candidates.find((c) => c.id.includes(base));
  if (nameMatch) return nameMatch.id;

  // Fallback: first result
  return candidates[0]!.id;
}

// ── API ─────────────────────────────────────────────────────────────────────

/** Google Translate ücretsiz endpoint ile İngilizce → Türkçe çeviri */
async function translateToTurkish(text: string): Promise<string> {
  if (!text || text.trim().length === 0) return '';
  try {
    // HTML taglarını temizle, sadece düz metin çevir
    const plain = text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    // Max 5000 karakter (API limiti)
    const truncated = plain.slice(0, 5000);

    const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=tr&dt=t&q=${encodeURIComponent(truncated)}`;
    const { data } = await axios.get(url, { timeout: 10000 });

    // Response format: [[["translated text","source text",null,null,x],...]]
    if (Array.isArray(data) && Array.isArray(data[0])) {
      return data[0].map((seg: unknown[]) => seg[0]).join('');
    }
    return '';
  } catch (err) {
    log.warn(`Translation failed, falling back to English`);
    return '';
  }
}

export async function fetchCoinInfo(symbol: string): Promise<CoinInfoResult> {
  const key = symbol.toUpperCase();

  // Cache hit?
  const cached = cache.get(key);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.data;
  }

  const geckoId = await resolveGeckoId(symbol);
  if (!geckoId) {
    throw new Error(`CoinGecko ID not found for ${symbol}`);
  }

  log.info(`Fetching coin info from CoinGecko: ${geckoId} (${symbol})`);

  const { data } = await axios.get(
    `${COINGECKO_BASE}/coins/${geckoId}`,
    {
      params: {
        localization: true,
        tickers: true,
        market_data: true,
        community_data: false,
        developer_data: false,
        sparkline: false,
      },
      timeout: 15000,
    },
  );

  const descEn = data.description?.en || '';
  const descTrRaw = data.description?.tr || '';

  // CoinGecko Türkçe açıklama yoksa, İngilizce'yi otomatik çevir
  let descTr = descTrRaw;
  if (!descTr && descEn) {
    descTr = await translateToTurkish(descEn);
  }

  // ── Price milestones from market_data ─────────────────────────────────
  const md = data.market_data ?? {};
  const currentPrice: number = md.current_price?.usd ?? 0;
  const athPrice: number | null = md.ath?.usd ?? null;
  const athDate: string | null = md.ath_date?.usd ?? null;
  const athChangePct: number | null = md.ath_change_percentage?.usd ?? null;
  const atlPrice: number | null = md.atl?.usd ?? null;
  const atlDate: string | null = md.atl_date?.usd ?? null;
  const atlChangePct: number | null = md.atl_change_percentage?.usd ?? null;

  // Fetch launch price from CoinGecko /history endpoint if genesis_date exists
  let launchPrice: number | null = null;
  let launchChangePct: number | null = null;
  const genesisDateStr: string | null = data.genesis_date ?? null;
  if (genesisDateStr && geckoId) {
    try {
      // CoinGecko history expects dd-mm-yyyy format
      const [y, m, d] = genesisDateStr.split('-');
      const historyDate = `${d}-${m}-${y}`;
      const histRes = await axios.get(
        `${COINGECKO_BASE}/coins/${geckoId}/history`,
        { params: { date: historyDate, localization: false }, timeout: 10000 },
      );
      const histPrice = histRes.data?.market_data?.current_price?.usd;
      if (typeof histPrice === 'number' && histPrice > 0) {
        launchPrice = histPrice;
        if (currentPrice > 0) {
          launchChangePct = ((currentPrice - histPrice) / histPrice) * 100;
        }
      }
    } catch (err) {
      log.warn(`Failed to fetch historical price for ${geckoId} on genesis date ${genesisDateStr}`);
    }
  }

  const result: CoinInfoResult = {
    symbol: key,
    name: data.name ?? '',
    image: data.image?.large ?? data.image?.small ?? '',
    marketCap: md.market_cap?.usd ?? 0,
    marketCapRank: data.market_cap_rank ?? null,
    categories: (data.categories ?? []).filter((c: unknown) => c != null && c !== ''),
    descriptionTr: descTr,
    descriptionEn: descEn,
    genesisDate: genesisDateStr,
    homepage: data.links?.homepage?.[0] ?? '',
    // Social links
    twitter: data.links?.twitter_screen_name ? `https://x.com/${data.links.twitter_screen_name}` : '',
    telegram: data.links?.telegram_channel_identifier ? `https://t.me/${data.links.telegram_channel_identifier}` : '',
    reddit: data.links?.subreddit_url ?? '',
    discord: (data.links?.chat_url ?? []).find((u: string) => u?.includes('discord')) ?? '',
    github: (data.links?.repos_url?.github ?? [])[0] ?? '',
    website: data.links?.homepage?.[0] ?? '',
    // Exchange listings — detect Spot & Perp from CoinGecko ticker identifiers
    // CoinGecko uses distinct identifiers for spot vs derivatives markets:
    //   Spot: binance, gdax (Coinbase), okex, bybit_spot
    //   Perp: binance_futures, coinbase_derivatives, okex_swap, bybit
    ...(() => {
      const SPOT_IDS: Record<string, string> = {
        binance: 'Binance',
        gdax: 'Coinbase',
        okex: 'OKX',
        bybit_spot: 'Bybit',
      };
      const spotFound = new Set<string>();
      const matches: string[] = [];
      for (const t of (data.tickers ?? [])) {
        const id = t.market?.identifier;
        if (!id) continue;
        const pair = t.base && t.target ? `${t.base}/${t.target}` : '';
        if (SPOT_IDS[id]) {
          spotFound.add(SPOT_IDS[id]);
          matches.push(`SPOT:${SPOT_IDS[id]}:${pair}:${id}`);
        }
      }
      const order = ['Binance', 'Coinbase', 'OKX', 'Bybit'];
      const spotExchanges = order.filter(e => spotFound.has(e));
      log.info('CoinInfo spot tickers scan', { geckoId: data.id, tickers: (data.tickers ?? []).length, matches, spotExchanges });
      return { spotExchanges };
    })(),
    // Perp exchanges will be filled below via direct REST API checks
    perpExchanges: [],
    // Price milestones
    currentPrice,
    athPrice,
    athDate,
    athChangePercentage: athChangePct,
    atlPrice,
    atlDate,
    atlChangePercentage: atlChangePct,
    launchPrice,
    launchChangePercentage: launchChangePct,
  };

  // ── Perp detection: CoinGecko free API does not return derivatives tickers,
  //    so we query each exchange REST API directly to check if a perp exists. ──
  const base = key.replace(/USDT$/i, '');
  // OKX uses clean base without "1000" prefix (e.g. PEPE-USDT-SWAP, not 1000PEPE-USDT-SWAP)
  const okxBase = base.replace(/^1000/i, '');
  const perpFound: string[] = [];
  const perpChecks = await Promise.allSettled([
    // Binance Futures
    axios.get(`https://fapi.binance.com/fapi/v1/ticker/24hr`, {
      params: { symbol: `${base}USDT` }, timeout: 5000,
    }).then(() => 'Binance'),
    // Bybit Linear
    axios.get(`https://api.bybit.com/v5/market/instruments-info`, {
      params: { category: 'linear', symbol: `${base}USDT` }, timeout: 5000,
    }).then(r => {
      const list = r.data?.result?.list ?? [];
      if (list.length > 0 && list[0].status === 'Trading') return 'Bybit';
      throw new Error('not found');
    }),
    // OKX Swap — try with clean base first, fallback to original base
    axios.get(`https://www.okx.com/api/v5/public/instruments`, {
      params: { instType: 'SWAP', instId: `${okxBase}-USDT-SWAP` }, timeout: 5000,
    }).then(r => {
      const list = r.data?.data ?? [];
      if (list.length > 0) return 'OKX';
      // If okxBase differs from base, try original as fallback
      if (okxBase !== base) {
        return axios.get(`https://www.okx.com/api/v5/public/instruments`, {
          params: { instType: 'SWAP', instId: `${base}-USDT-SWAP` }, timeout: 5000,
        }).then(r2 => {
          if ((r2.data?.data ?? []).length > 0) return 'OKX';
          throw new Error('not found');
        });
      }
      throw new Error('not found');
    }),
  ]);
  const perpOrder = ['Binance', 'OKX', 'Bybit'];
  for (const check of perpChecks) {
    if (check.status === 'fulfilled' && check.value) perpFound.push(check.value);
  }
  result.perpExchanges = perpOrder.filter(e => perpFound.includes(e));
  log.info('CoinInfo perp detection', { symbol: key, perpExchanges: result.perpExchanges });

  cache.set(key, { data: result, fetchedAt: Date.now() });
  return result;
}

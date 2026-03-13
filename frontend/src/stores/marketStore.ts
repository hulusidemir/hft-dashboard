// ─────────────────────────────────────────────────────────────────────────────
// marketStore.ts — Zustand WebSocket Yöneticisi
// ws://localhost:9000 → msgpack decode → transient state (React re-render yok)
// Dinamik sembol değişikliği: resetStore + WS change_symbol mesajı
// ─────────────────────────────────────────────────────────────────────────────

import { createStore } from 'zustand/vanilla';
import { decode } from '@msgpack/msgpack';
import { audioManager } from '../utils/audioManager';

// ── Shared Types (backend IUnifiedOrderBook mirror) ─────────────────────────

export interface PriceLevel {
  price: number;
  quantity: number;
  binanceQty: number;
  bybitQty: number;
  okxQty: number;
}

export interface UnifiedOrderBook {
  symbol: string;
  timestamp: number;
  midPrice: number;
  spread: number;
  bids: PriceLevel[];
  asks: PriceLevel[];
  bestBids: { binance: number; bybit: number; okx: number };
  bestAsks: { binance: number; bybit: number; okx: number };
}

export interface UnifiedTrade {
  id: string;
  symbol: string;
  exchange: string;
  price: number;
  quantity: number;
  quoteQty: number;
  side: 'BUY' | 'SELL';
  timestamp: number;
}

export interface TradeWithCVD {
  trades: UnifiedTrade[];
  cvd: number;
  timestamp: number;
}

export interface UnifiedLiquidation {
  id: string;
  symbol: string;
  exchange: string;
  side: 'LONG' | 'SHORT';
  price: number;
  quantity: number;
  quoteQty: number;
  timestamp: number;
}

// ── War Log Entry (Radar Savaş Günlüğü) ─────────────────────────────────

export interface WarLogEntry {
  id: number;
  timestamp: number;
  type: 'WHALE_BUY' | 'WHALE_SELL' | 'LIQ_LONG' | 'LIQ_SHORT';
  symbol: string;
  price: number;
  quoteQty: number;
  exchange: string;
}

export interface UnifiedOpenInterest {
  symbol: string;
  timestamp: number;
  binanceOI: number;
  bybitOI: number;
  okxOI: number;
  totalOI: number;
  deltaOI: number;
  deltaOIPercent: number;
}

// ── WebSocket Message Envelope ──────────────────────────────────────────────
interface WSMessage {
  t: string;           // topic: 'lob' | 'trades' | 'liquidations' | 'oi' | 'init' | 'symbol_changed' | ...
  d: unknown;          // data payload
}

// ── Store State ─────────────────────────────────────────────────────────────
export interface MarketState {
  // ── Transient Data (yüksek frekanslı — React subscribe ETMEZ) ─────────
  orderbook: UnifiedOrderBook | null;

  // ── Semi-transient Data ───────────────────────────────────────────────
  trades: UnifiedTrade[];
  cvd: number;

  // ── Low-frequency Data (React subscribe edebilir) ─────────────────────
  openInterest: UnifiedOpenInterest | null;
  liquidations: UnifiedLiquidation[];

  // ── Symbol State ──────────────────────────────────────────────────────
  currentSymbol: string;
  symbolList: string[];
  isChangingSymbol: boolean;

  // ── Alarm State ───────────────────────────────────────────────────────
  isAlarmEnabled: boolean;

  // ── View State ────────────────────────────────────────────────────────
  activeView: 'dashboard' | 'radar' | 'mr' | 'exchanges' | 'overview';

  // ── War Log (Savaş Günlüğü) ────────────────────────────────────────
  warLog: WarLogEntry[];

  // ── Connection State ──────────────────────────────────────────────────
  connected: boolean;
  reconnectCount: number;
  lastMessageAt: number;
}

// ── Config ──────────────────────────────────────────────────────────────────
const _backendUrl      = import.meta.env.VITE_BACKEND_URL || 'http://localhost:9000';
const WS_URL           = _backendUrl.replace(/^http/, 'ws');
const REST_BASE        = _backendUrl;
const MAX_TRADES       = 50_000;    // Tape'de trade'leri uzun süre tut — sayfa yenilenene kadar kaybolmasın
const MAX_LIQUIDATIONS = 50;
const RECONNECT_BASE   = 500;
const RECONNECT_MAX    = 8000;
const RECONNECT_JITTER = 0.2;

// ── Vanilla Store ───────────────────────────────────────────────────────────
export const marketStore = createStore<MarketState>(() => ({
  orderbook: null,
  trades: [],
  cvd: 0,
  openInterest: null,
  liquidations: [],
  currentSymbol: 'BTCUSDT',
  symbolList: [],
  isChangingSymbol: false,
  isAlarmEnabled: false,
  activeView: 'dashboard',
  warLog: [],
  connected: false,
  reconnectCount: 0,
  lastMessageAt: 0,
}));

// ── Convenience Accessors ───────────────────────────────────────────────────
export function getOrderBook(): UnifiedOrderBook | null {
  return marketStore.getState().orderbook;
}

export function getTrades(): UnifiedTrade[] {
  return marketStore.getState().trades;
}

export function getCVD(): number {
  return marketStore.getState().cvd;
}

export function getOpenInterest(): UnifiedOpenInterest | null {
  return marketStore.getState().openInterest;
}

export function getLiquidations(): UnifiedLiquidation[] {
  return marketStore.getState().liquidations;
}

// ── Alarm Toggle ────────────────────────────────────────────────────────────
export function toggleAlarm(): void {
  const current = marketStore.getState().isAlarmEnabled;
  marketStore.setState({ isAlarmEnabled: !current });
  console.log(`[marketStore] Alarm ${!current ? 'ON' : 'OFF'}`);
}

// ── View Toggle ──────────────────────────────────────────────────────────
export function setActiveView(view: 'dashboard' | 'radar' | 'mr' | 'exchanges' | 'overview'): void {
  marketStore.setState({ activeView: view });
}

// ── War Log Helpers ───────────────────────────────────────────────────────
const MAX_WAR_LOG = 200;
let warLogCounter = 0;

function pushWarLog(entry: Omit<WarLogEntry, 'id'>): void {
  const prev = marketStore.getState().warLog;
  const newEntry: WarLogEntry = { ...entry, id: ++warLogCounter };
  const updated = prev.length >= MAX_WAR_LOG
    ? [newEntry, ...prev.slice(0, MAX_WAR_LOG - 1)]
    : [newEntry, ...prev];
  marketStore.setState({ warLog: updated });
}

// ── Reset Store — Sembol değişikliğinde tüm eski veriyi temizler ────────────
export function resetStore(): void {
  marketStore.setState({
    orderbook: null,
    trades: [],
    cvd: 0,
    openInterest: null,
    liquidations: [],
    lastMessageAt: Date.now(),   // 0 yerine Date.now() — stale algılama bekleme payı
  });
  console.log('[marketStore] Store sıfırlandı');
}

// ── Message Handlers ────────────────────────────────────────────────────────

function handleOrderBook(data: unknown): void {
  const updates: Partial<MarketState> = {
    orderbook: data as UnifiedOrderBook,
    lastMessageAt: Date.now(),
  };
  // Sembol değişikliği warmup tamamlandı — ilk gerçek veri geldi
  if (marketStore.getState().isChangingSymbol) {
    updates.isChangingSymbol = false;
    console.log('[marketStore] İlk orderbook verisi geldi — isChangingSymbol temizlendi');
  }
  marketStore.setState(updates);
}

function handleTrades(data: unknown): void {
  const batch = data as TradeWithCVD;
  const prev = marketStore.getState().trades;

  // GC-dostu birleştirme: büyük buffer'ı her seferinde kopyalamaktan kaçın
  let merged: UnifiedTrade[];
  const totalLen = batch.trades.length + prev.length;
  if (totalLen > MAX_TRADES) {
    // Sadece taşma olduğunda yeni dizi oluştur ve kes
    merged = new Array(MAX_TRADES);
    const bLen = batch.trades.length;
    for (let i = 0; i < bLen && i < MAX_TRADES; i++) merged[i] = batch.trades[i]!;
    const remain = MAX_TRADES - bLen;
    for (let i = 0; i < remain; i++) merged[bLen + i] = prev[i]!;
  } else {
    // Küçük batch — spread hâlâ verimli
    merged = [...batch.trades, ...prev];
  }

  const tradeUpdates: Partial<MarketState> = {
    trades: merged,
    cvd: batch.cvd,
    lastMessageAt: Date.now(),
  };
  // Sembol değişikliği warmup — ilk trade verisi geldi
  if (marketStore.getState().isChangingSymbol) {
    tradeUpdates.isChangingSymbol = false;
    console.log('[marketStore] İlk trade verisi geldi — isChangingSymbol temizlendi');
  }
  marketStore.setState(tradeUpdates);

  // ── Whale Alarm — batch içinde $100K+ tekil işlem varsa ses tetikle ───
  if (marketStore.getState().isAlarmEnabled && audioManager.ready) {
    for (const t of batch.trades) {
      if (t.quoteQty >= 100_000) {
        if (t.side === 'BUY') {
          audioManager.playWhaleBuy();
        } else {
          audioManager.playWhaleSell();
        }
        break; // batch başına en fazla 1 ses — üst üste binme engeli
      }
    }
  }

  // ── War Log — Bybit/OKX balina ($100K+) — Binance whale'ler GlobalTradeListener'dan gelir
  for (const t of batch.trades) {
    if (t.quoteQty >= 100_000 && t.exchange !== 'BINANCE') {
      pushWarLog({
        timestamp: t.timestamp,
        type: t.side === 'BUY' ? 'WHALE_BUY' : 'WHALE_SELL',
        symbol: t.symbol,
        price: t.price,
        quoteQty: t.quoteQty,
        exchange: t.exchange,
      });
    }
  }
}

function handleLiquidation(data: unknown): void {
  const liq = data as UnifiedLiquidation;
  const prev = marketStore.getState().liquidations;

  const updated = prev.length >= MAX_LIQUIDATIONS
    ? [liq, ...prev.slice(0, MAX_LIQUIDATIONS - 1)]
    : [liq, ...prev];

  marketStore.setState({ liquidations: updated, lastMessageAt: Date.now() });

  // ── Liquidation Alarm — $10K+ tasfiye sesi ────────────────────
  if (marketStore.getState().isAlarmEnabled && audioManager.ready && liq.quoteQty >= 10_000) {
    audioManager.playLiquidation();
  }
  // War Log artık global stream'den (war_log topic) geliyor — burada push YAPILMAZ
}

function handleOpenInterest(data: unknown): void {
  marketStore.setState({ openInterest: data as UnifiedOpenInterest, lastMessageAt: Date.now() });
}

function handleInit(data: unknown): void {
  const payload = data as { symbol: string; symbols: string[] };
  marketStore.setState({
    currentSymbol: payload.symbol,
    symbolList: payload.symbols,
    lastMessageAt: Date.now(),   // Stale algılama grace period — veri akana kadar bekleme payı
  });
  console.log(`[marketStore] Init: symbol=${payload.symbol}, ${payload.symbols.length} symbols available`);
  // SQLite'tan son tasfiye kayıtlarını çek — feed'i başlangıçta doldur
  fetchRecentLiquidations(payload.symbol);
  startLiqPoll(payload.symbol);
}

function handleSymbolSwitching(data: unknown): void {
  const payload = data as { symbol: string };
  marketStore.setState({ isChangingSymbol: true });
  console.log(`[marketStore] Sembol değişiyor: ${payload.symbol}`);
  // Eski verileri hemen temizle — yeni sembol verisi gelene kadar ekran boş olsun
  resetStore();
}

function handleSymbolChanged(data: unknown): void {
  const payload = data as { symbol: string };
  marketStore.setState({
    currentSymbol: payload.symbol,
    lastMessageAt: Date.now(),
  });
  console.log(`[marketStore] Sembol değişikliği tamamlandı: ${payload.symbol} — veri bekleniyor...`);
  // Yeni sembol için son tasfiye kayıtlarını çek + periyodik poll başlat
  fetchRecentLiquidations(payload.symbol);
  startLiqPoll(payload.symbol);
}

function handleSymbolError(data: unknown): void {
  const payload = data as { error: string };
  marketStore.setState({ isChangingSymbol: false });
  console.error(`[marketStore] Sembol değişikliği hatası: ${payload.error}`);
}

// ── War Log Global Handler — Backend'den gelen global balina + tasfiye olayları
function handleWarLog(data: unknown): void {
  const entry = data as Omit<WarLogEntry, 'id'>;
  pushWarLog(entry);

  // Global alarmlar sadece RADAR sayfasında duyulsun
  const state = marketStore.getState();
  if (!state.isAlarmEnabled || !audioManager.ready || state.activeView !== 'radar') return;

  // Global tasfiye alarm — ses tetikle
  if (
    (entry.type === 'LIQ_LONG' || entry.type === 'LIQ_SHORT') &&
    entry.quoteQty >= 10_000
  ) {
    audioManager.playLiquidation();
  }
  // Global whale alarm — ses tetikle
  if (
    (entry.type === 'WHALE_BUY' || entry.type === 'WHALE_SELL') &&
    entry.quoteQty >= 100_000
  ) {
    if (entry.type === 'WHALE_BUY') {
      audioManager.playWhaleBuy();
    } else {
      audioManager.playWhaleSell();
    }
  }
}

// ── Topic Router ────────────────────────────────────────────────────────────
const TOPIC_HANDLERS: Record<string, (data: unknown) => void> = {
  lob:              handleOrderBook,
  trades:           handleTrades,
  liquidations:     handleLiquidation,
  oi:               handleOpenInterest,
  war_log:          handleWarLog,
  init:             handleInit,
  symbol_switching:  handleSymbolSwitching,
  symbol_changed:   handleSymbolChanged,
  symbol_error:     handleSymbolError,
};

// ── WebSocket Manager ───────────────────────────────────────────────────────
let ws: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let intentionalClose = false;

function jitter(base: number): number {
  return base * (1 + (Math.random() * 2 - 1) * RECONNECT_JITTER);
}

function scheduleReconnect(): void {
  if (intentionalClose) return;

  const count = marketStore.getState().reconnectCount;
  const delay = Math.min(RECONNECT_BASE * Math.pow(2, count), RECONNECT_MAX);
  const jittered = jitter(delay);

  console.log(`[marketStore] Reconnecting in ${Math.round(jittered)}ms (attempt ${count + 1})`);
  reconnectTimer = setTimeout(() => {
    marketStore.setState({ reconnectCount: count + 1 });
    connectWS();
  }, jittered);
}

function connectWS(): void {
  if (ws) {
    try { ws.close(); } catch { /* ignore */ }
    ws = null;
  }

  intentionalClose = false;

  const socket = new WebSocket(WS_URL);
  socket.binaryType = 'arraybuffer';

  socket.onopen = () => {
    console.log('[marketStore] WebSocket connected');
    marketStore.setState({ connected: true, reconnectCount: 0 });
  };

  socket.onmessage = (event: MessageEvent) => {
    try {
      const msg = decode(new Uint8Array(event.data as ArrayBuffer)) as WSMessage;
      const handler = TOPIC_HANDLERS[msg.t];
      if (handler) {
        handler(msg.d);
      }
    } catch (err) {
      console.error('[marketStore] Decode error:', err);
    }
  };

  socket.onclose = () => {
    console.log('[marketStore] WebSocket disconnected');
    marketStore.setState({ connected: false });
    ws = null;
    scheduleReconnect();
  };

  socket.onerror = (err) => {
    console.error('[marketStore] WebSocket error:', err);
  };

  ws = socket;
}

// ── Sembol Değiştirme — Frontend'ten Backend'e WS mesajı gönderir ───────────
export function changeSymbol(newSymbol: string): void {
  const state = marketStore.getState();

  // Aynı sembolü tekrar seçme
  if (newSymbol === state.currentSymbol) return;

  // Zaten değişim devam ediyorken engelle
  if (state.isChangingSymbol) {
    console.warn('[marketStore] Sembol değişikliği zaten devam ediyor');
    return;
  }

  if (!ws || ws.readyState !== WebSocket.OPEN) {
    console.error('[marketStore] WS bağlı değil — sembol değişikliği yapılamaz');
    return;
  }

  console.log(`[marketStore] Sembol değişikliği gönderiliyor: ${newSymbol}`);

  // Hemen UI'da temizle
  marketStore.setState({ isChangingSymbol: true });
  resetStore();

  // Backend'e gönder
  ws.send(JSON.stringify({ action: 'change_symbol', symbol: newSymbol }));
}

// ── Sembol Listesi Fetch (REST fallback — WS init ile de gelir) ─────────────
export async function fetchSymbolList(): Promise<string[]> {
  try {
    const resp = await fetch(`${REST_BASE}/api/symbols`);
    const data = await resp.json() as { symbols: string[]; current: string };
    marketStore.setState({
      symbolList: data.symbols,
      currentSymbol: data.current,
    });
    return data.symbols;
  } catch (err) {
    console.error('[marketStore] Symbol list fetch error:', err);
    return [];
  }
}

// ── Son Tasfiye Kayıtlarını SQLite'tan Çek ──────────────────────────────────
// İlk bağlantı, sembol değişikliği ve periyodik poll ile feed'i güncel tutar.
let liqPollTimer: ReturnType<typeof setInterval> | null = null;
const LIQ_POLL_INTERVAL = 15_000; // 15 saniye

async function fetchRecentLiquidations(symbol: string): Promise<void> {
  try {
    const resp = await fetch(`${REST_BASE}/api/liquidations/recent?symbol=${symbol}&limit=50`);
    if (!resp.ok) return;
    const rows = await resp.json() as Array<{
      exchange: string; symbol: string; side: string;
      price: number; qty: number; usdValue: number; timestamp: number;
    }>;
    if (!rows.length) return;

    const EXCHANGE_MAP: Record<string, string> = { binance: 'BINANCE', bybit: 'BYBIT', okx: 'OKX' };
    const incoming: UnifiedLiquidation[] = rows.map(r => ({
      id: `${r.exchange}_liq_${r.timestamp}_${r.price}`,
      symbol: r.symbol,
      exchange: EXCHANGE_MAP[r.exchange] ?? r.exchange.toUpperCase(),
      side: (r.side === 'long' ? 'LONG' : 'SHORT') as 'LONG' | 'SHORT',
      price: r.price,
      quantity: r.qty,
      quoteQty: r.usdValue,
      timestamp: r.timestamp,
    }));

    // Mevcut feed ile birleştir — tekrar eden id'leri filtrele
    const current = marketStore.getState().liquidations;
    const existingIds = new Set(current.map(l => l.id));
    const newOnes = incoming.filter(l => !existingIds.has(l.id));

    if (newOnes.length > 0 || current.length === 0) {
      // Tümünü birleştir, timestamp'e göre sırala (yeniden eskiye), limit uygula
      const merged = [...current, ...newOnes]
        .sort((a, b) => b.timestamp - a.timestamp)
        .slice(0, MAX_LIQUIDATIONS);
      marketStore.setState({ liquidations: merged });
      if (current.length === 0) {
        console.log(`[marketStore] ${merged.length} geçmiş tasfiye kaydı yüklendi (${symbol})`);
      } else if (newOnes.length > 0) {
        console.log(`[marketStore] ${newOnes.length} yeni tasfiye eklendi (REST poll, ${symbol})`);
      }
    }
  } catch {
    // Sessiz hata — WS üzerinden veri akacak
  }
}

/** Periyodik tasfiye REST poll başlat/yenile (sembol değiştiğinde çağrılır) */
function startLiqPoll(symbol: string): void {
  stopLiqPoll();
  // İlk fetch zaten handleInit/handleSymbolChanged'den yapılıyor
  liqPollTimer = setInterval(() => {
    const currentSym = marketStore.getState().currentSymbol;
    if (currentSym) fetchRecentLiquidations(currentSym);
  }, LIQ_POLL_INTERVAL);
}

function stopLiqPoll(): void {
  if (liqPollTimer) {
    clearInterval(liqPollTimer);
    liqPollTimer = null;
  }
}

// ── Public API ──────────────────────────────────────────────────────────────
export function startMarketConnection(): void {
  intentionalClose = false;
  connectWS();
}

export function stopMarketConnection(): void {
  intentionalClose = true;
  stopLiqPoll();
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (ws) {
    ws.close();
    ws = null;
  }
  marketStore.setState({ connected: false });
}

// ── React Hook Helper ───────────────────────────────────────────────────────
import { useStore } from 'zustand';

export function useMarketStore<T>(selector: (state: MarketState) => T): T {
  return useStore(marketStore, selector);
}

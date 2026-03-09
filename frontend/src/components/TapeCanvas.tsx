// ─────────────────────────────────────────────────────────────────────────────
// TapeCanvas.tsx — HFT Akan Bant (Time & Sales)
// Saf Canvas + requestAnimationFrame — DOM elemanı yok, sıfır React re-render.
// ─────────────────────────────────────────────────────────────────────────────

import { useRef, useEffect } from 'react';
import { getTrades } from '../stores/marketStore';
import type { UnifiedTrade } from '../stores/marketStore';

// ── Config ──────────────────────────────────────────────────────────────────
const BG_COLOR         = '#000000';
const MAX_VISIBLE      = 100;                   // ekranda gösterilecek max satır
const ROW_HEIGHT       = 16;                    // her trade satırının piksel yüksekliği
const FONT             = '10px "Courier New", monospace';
const WHALE_THRESHOLD  = 50_000;                // USD — bu üzeri "balina" sayılır
const WHALE_BG         = 'rgba(255, 220, 50, 0.12)';   // sarımsı parlama

// Renkler
const BUY_COLOR        = '#00ff00';
const SELL_COLOR       = '#ff0000';
const HEADER_BG        = '#0a0a0a';
const HEADER_COLOR     = '#555555';
const DIM_COLOR        = '#444444';

// ── Formatlayıcılar ─────────────────────────────────────────────────────────

function fmtTime(ts: number): string {
  const d  = new Date(ts);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  const ms = String(d.getMilliseconds()).padStart(3, '0');
  return `${hh}:${mm}:${ss}.${ms}`;
}

function fmtPrice(price: number): string {
  if (price >= 10_000)  return price.toFixed(1);
  if (price >= 100)     return price.toFixed(2);
  if (price >= 1)       return price.toFixed(3);
  return price.toFixed(4);
}

function fmtQty(qty: number): string {
  if (qty >= 1_000) return (qty / 1_000).toFixed(2) + 'K';
  if (qty >= 1)     return qty.toFixed(4);
  if (qty >= 0.01)  return qty.toFixed(4);
  return qty.toFixed(6);
}

function fmtUSD(usd: number): string {
  if (usd >= 1_000_000) return '$' + (usd / 1_000_000).toFixed(2) + 'M';
  if (usd >= 1_000)     return '$' + (usd / 1_000).toFixed(1) + 'K';
  return '$' + usd.toFixed(0);
}

// ── Exchange kısaltma ───────────────────────────────────────────────────────
function fmtExchange(ex: string): string {
  switch (ex) {
    case 'BINANCE': return 'BIN';
    case 'BYBIT':   return 'BYB';
    case 'OKX':     return 'OKX';
    default:         return ex.slice(0, 3).toUpperCase();
  }
}

// ── Çizim Motoru ────────────────────────────────────────────────────────────

function drawTape(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  dpr: number,
): void {
  const trades = getTrades();

  // Temizle
  ctx.fillStyle = BG_COLOR;
  ctx.fillRect(0, 0, width * dpr, height * dpr);

  ctx.save();
  ctx.scale(dpr, dpr);

  // ── Header satırı ─────────────────────────────────────────────────────
  const headerH = 20;
  ctx.fillStyle = HEADER_BG;
  ctx.fillRect(0, 0, width, headerH);

  ctx.font      = '9px Arial';
  ctx.fillStyle = HEADER_COLOR;
  ctx.textAlign = 'left';

  // Sütun pozisyonları
  const colTime     = 4;
  const colExchange = 100;
  const colPrice    = 135;
  const colQty      = 210;
  const colUSD      = 275;

  ctx.fillText('TIME',     colTime,     headerH - 6);
  ctx.fillText('EX',       colExchange, headerH - 6);
  ctx.fillText('PRICE',    colPrice,    headerH - 6);
  ctx.fillText('QTY',      colQty,      headerH - 6);
  ctx.fillText('USD',      colUSD,      headerH - 6);

  // Ayırıcı çizgi
  ctx.strokeStyle = '#1a1a1a';
  ctx.lineWidth   = 1;
  ctx.beginPath();
  ctx.moveTo(0, headerH);
  ctx.lineTo(width, headerH);
  ctx.stroke();

  // ── Trade satırları ───────────────────────────────────────────────────
  const maxRows = Math.min(
    Math.floor((height - headerH) / ROW_HEIGHT),
    MAX_VISIBLE,
    trades.length,
  );

  ctx.font = FONT;

  for (let i = 0; i < maxRows; i++) {
    const trade = trades[i] as UnifiedTrade;
    const y     = headerH + i * ROW_HEIGHT;

    // ── Balina highlight ────────────────────────────────────────────────
    if (trade.quoteQty >= WHALE_THRESHOLD) {
      ctx.fillStyle = WHALE_BG;
      ctx.fillRect(0, y, width, ROW_HEIGHT);
    }

    // ── Satır rengi ─────────────────────────────────────────────────────
    const rowColor = trade.side === 'BUY' ? BUY_COLOR : SELL_COLOR;

    ctx.textAlign = 'left';

    // Zaman
    ctx.fillStyle = DIM_COLOR;
    ctx.fillText(fmtTime(trade.timestamp), colTime, y + ROW_HEIGHT - 4);

    // Exchange
    ctx.fillStyle = '#666666';
    ctx.fillText(fmtExchange(trade.exchange), colExchange, y + ROW_HEIGHT - 4);

    // Fiyat
    ctx.fillStyle = rowColor;
    ctx.fillText(fmtPrice(trade.price), colPrice, y + ROW_HEIGHT - 4);

    // Miktar
    ctx.fillStyle = rowColor;
    ctx.fillText(fmtQty(trade.quantity), colQty, y + ROW_HEIGHT - 4);

    // USD hacim
    ctx.fillStyle = trade.quoteQty >= WHALE_THRESHOLD ? '#ffdd33' : rowColor;
    ctx.fillText(fmtUSD(trade.quoteQty), colUSD, y + ROW_HEIGHT - 4);
  }

  // Boş durum mesajı
  if (trades.length === 0) {
    ctx.font      = '12px Arial';
    ctx.fillStyle = '#444';
    ctx.textAlign = 'center';
    ctx.fillText('Waiting for trades...', width / 2, height / 2);
  }

  ctx.restore();
}

// ── React Bileşeni ──────────────────────────────────────────────────────────

export default function TapeCanvas(): JSX.Element {
  const canvasRef    = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const sizeRef      = useRef({ w: 0, h: 0 });
  const rafRef       = useRef<number>(0);

  useEffect(() => {
    const canvas    = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;

    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) return;

    // ── ResizeObserver ──────────────────────────────────────────────────
    function resize(): void {
      const rect = container!.getBoundingClientRect();
      const dpr  = window.devicePixelRatio || 1;
      const w    = Math.floor(rect.width);
      const h    = Math.floor(rect.height);

      if (w === sizeRef.current.w && h === sizeRef.current.h) return;
      sizeRef.current = { w, h };

      canvas!.width  = w * dpr;
      canvas!.height = h * dpr;
      canvas!.style.width  = w + 'px';
      canvas!.style.height = h + 'px';
    }

    const ro = new ResizeObserver(resize);
    ro.observe(container);
    resize();

    // ── RAF Döngüsü ─────────────────────────────────────────────────────
    let running = true;

    function loop(): void {
      if (!running) return;
      const { w, h } = sizeRef.current;
      const dpr = window.devicePixelRatio || 1;
      if (w > 0 && h > 0) {
        drawTape(ctx!, w, h, dpr);
      }
      rafRef.current = requestAnimationFrame(loop);
    }

    rafRef.current = requestAnimationFrame(loop);

    // ── Cleanup ─────────────────────────────────────────────────────────
    return () => {
      running = false;
      cancelAnimationFrame(rafRef.current);
      ro.disconnect();
    };
  }, []);

  return (
    <div
      ref={containerRef}
      style={{
        width: '100%',
        height: '100%',
        background: BG_COLOR,
        overflow: 'hidden',
      }}
    >
      <canvas ref={canvasRef} style={{ display: 'block' }} />
    </div>
  );
}

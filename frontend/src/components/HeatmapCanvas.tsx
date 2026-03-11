// ─────────────────────────────────────────────────────────────────────────────
// HeatmapCanvas.tsx — LOB Isı Haritası + Dikey Emir Defteri
// React render döngüsünden bağımsız, saf Canvas piksel çizimi.
// requestAnimationFrame @ 60fps — marketStore.getState() ile veri çeker.
// ─────────────────────────────────────────────────────────────────────────────

import { useRef, useEffect } from 'react';
import { getOrderBook } from '../stores/marketStore';
import type { UnifiedOrderBook, PriceLevel } from '../stores/marketStore';

// ── Renk / Stil sabitleri ───────────────────────────────────────────────────
const BG_COLOR          = '#000000';
const MID_DIVIDER_H     = 28;            // midPrice bandı yüksekliği
const ROW_HEIGHT        = 18;            // her fiyat kademesi satır yüksekliği
const FONT              = '10px Arial';
const FONT_COLOR        = 'rgba(255,255,255,0.85)';
const FONT_DIM          = 'rgba(255,255,255,0.45)';
const MID_BG            = '#111111';
const MID_TEXT_COLOR     = '#FFFFFF';
const SPREAD_TEXT_COLOR  = '#888888';

// Isı renk aralıkları (düşük → yüksek hacim)
const ASK_COLOR_LOW  = { r: 80,  g: 0,  b: 0 };    // koyu kırmızı
const ASK_COLOR_HIGH = { r: 255, g: 50, b: 50 };    // parlak kırmızı
const BID_COLOR_LOW  = { r: 0,   g: 60, b: 0 };     // koyu yeşil
const BID_COLOR_HIGH = { r: 50,  g: 255, b: 50 };   // parlak yeşil

// ── Yardımcı fonksiyonlar ───────────────────────────────────────────────────

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function lerpColor(
  low: { r: number; g: number; b: number },
  high: { r: number; g: number; b: number },
  t: number,
): string {
  const clamped = Math.max(0, Math.min(1, t));
  const r = Math.round(lerp(low.r, high.r, clamped));
  const g = Math.round(lerp(low.g, high.g, clamped));
  const b = Math.round(lerp(low.b, high.b, clamped));
  return `rgb(${r},${g},${b})`;
}

/** Sayıları kısaltılmış formatta göster: 1234567 → "1.23M" */
function formatQty(qty: number): string {
  if (qty >= 1_000_000) return (qty / 1_000_000).toFixed(2) + 'M';
  if (qty >= 1_000)     return (qty / 1_000).toFixed(2) + 'K';
  if (qty >= 1)         return qty.toFixed(2);
  if (qty >= 0.001)     return qty.toFixed(4);
  return qty.toFixed(6);
}

/** Fiyatı anlamlı ondalıklı göster — düşük fiyatlı coinler için dinamik hassasiyet */
function formatPrice(price: number): string {
  if (price >= 10_000)  return price.toFixed(1);
  if (price >= 100)     return price.toFixed(2);
  if (price >= 1)       return price.toFixed(3);
  if (price <= 0)       return '0';
  // Sub-$1: show enough decimals for 4 significant digits
  const leadingZeros = -Math.floor(Math.log10(price));   // e.g. 0.016 → 1
  return price.toFixed(leadingZeros + 4);                 // 0.016427 → 5 decimals → "0.01643"
}

// ── Çizim Motoru ────────────────────────────────────────────────────────────

function drawFrame(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  dpr: number,
): void {
  const book = getOrderBook();

  // Temizle
  ctx.fillStyle = BG_COLOR;
  ctx.fillRect(0, 0, width * dpr, height * dpr);

  if (!book || book.bids.length === 0 || book.asks.length === 0) {
    // Bağlantı bekleniyor
    ctx.save();
    ctx.scale(dpr, dpr);
    ctx.font = '14px Arial';
    ctx.fillStyle = FONT_DIM;
    ctx.textAlign = 'center';
    ctx.fillText('Waiting for orderbook data...', width / 2, height / 2);
    ctx.restore();
    return;
  }

  ctx.save();
  ctx.scale(dpr, dpr);

  // ── Layout hesapla ──────────────────────────────────────────────────────
  const midY         = Math.floor(height / 2);
  const askZoneTop   = 0;
  const askZoneH     = midY - MID_DIVIDER_H / 2;
  const bidZoneTop   = midY + MID_DIVIDER_H / 2;
  const bidZoneH     = height - bidZoneTop;

  const maxAskRows   = Math.floor(askZoneH / ROW_HEIGHT);
  const maxBidRows   = Math.floor(bidZoneH / ROW_HEIGHT);

  const visibleAsks  = book.asks.slice(0, maxAskRows);
  const visibleBids  = book.bids.slice(0, maxBidRows);

  // En yüksek hacmi bul — bar genişliği normalizasyonu için
  const maxQty = findMaxQuantity(visibleBids, visibleAsks);
  if (maxQty === 0) { ctx.restore(); return; }

  // ── Asks çiz (yukarıdan aşağı — en uzak ask'tan en yakın ask'a) ───────
  // visibleAsks[0] = best ask (en düşük fiyat) — ekranın ortasına en yakın olmalı
  // Bu yüzden ters sırada çiziyoruz: en uzak ask en üstte

  // Fiyat sütunu genişliğini referans fiyata göre hesapla
  const sampleText = formatPrice(book.midPrice);
  const priceColWidth = Math.max(70, sampleText.length * 7 + 16);
  const qtyColWidth   = 70;            // miktar sütunu genişliği (sağ taraf)
  const barMaxWidth   = width - priceColWidth - qtyColWidth - 4; // bar için kullanılabilir alan

  for (let i = 0; i < visibleAsks.length; i++) {
    const level = visibleAsks[visibleAsks.length - 1 - i]!; // ters sıra
    const y     = askZoneTop + i * ROW_HEIGHT;
    drawLevelRow(ctx, level, y, width, barMaxWidth, priceColWidth, qtyColWidth, maxQty, 'ask', dpr);
  }

  // ── Bids çiz (yukarıdan aşağı — en iyi bid'den en uzak bid'e) ─────────
  for (let i = 0; i < visibleBids.length; i++) {
    const level = visibleBids[i]!;
    const y     = bidZoneTop + i * ROW_HEIGHT;
    drawLevelRow(ctx, level, y, width, barMaxWidth, priceColWidth, qtyColWidth, maxQty, 'bid', dpr);
  }

  // ── MidPrice bandı ────────────────────────────────────────────────────
  drawMidPriceBand(ctx, book, midY, width);

  ctx.restore();
}

// ── Level Row Çizimi ────────────────────────────────────────────────────────

function drawLevelRow(
  ctx: CanvasRenderingContext2D,
  level: PriceLevel,
  y: number,
  canvasW: number,
  barMaxW: number,
  priceColW: number,
  qtyColW: number,
  maxQty: number,
  side: 'ask' | 'bid',
  _dpr: number,
): void {
  const intensity = level.quantity / maxQty;   // 0..1

  // Bar genişliği
  const barW = Math.max(1, barMaxW * intensity);

  // Isı rengi
  const colorLow  = side === 'ask' ? ASK_COLOR_LOW  : BID_COLOR_LOW;
  const colorHigh = side === 'ask' ? ASK_COLOR_HIGH : BID_COLOR_HIGH;
  const barColor  = lerpColor(colorLow, colorHigh, intensity);

  // Bar — fiyat sütununun hemen sağından başlar
  const barX = priceColW + 2;
  ctx.fillStyle = barColor;
  ctx.fillRect(barX, y + 1, barW, ROW_HEIGHT - 2);  // 1px padding üst/alt

  // Fiyat — sol sütun
  ctx.font      = FONT;
  ctx.textAlign = 'right';
  ctx.fillStyle = FONT_COLOR;
  ctx.fillText(formatPrice(level.price), priceColW - 4, y + ROW_HEIGHT - 5);

  // Miktar — sağ sütun
  ctx.textAlign = 'left';
  ctx.fillStyle = FONT_DIM;
  ctx.fillText(formatQty(level.quantity), canvasW - qtyColW + 4, y + ROW_HEIGHT - 5);
}

// ── MidPrice Bandı ──────────────────────────────────────────────────────────

function drawMidPriceBand(
  ctx: CanvasRenderingContext2D,
  book: UnifiedOrderBook,
  midY: number,
  width: number,
): void {
  const bandTop = midY - MID_DIVIDER_H / 2;

  // Arka plan
  ctx.fillStyle = MID_BG;
  ctx.fillRect(0, bandTop, width, MID_DIVIDER_H);

  // Üst ve alt çizgi
  ctx.strokeStyle = '#333333';
  ctx.lineWidth   = 1;
  ctx.beginPath();
  ctx.moveTo(0, bandTop);
  ctx.lineTo(width, bandTop);
  ctx.moveTo(0, bandTop + MID_DIVIDER_H);
  ctx.lineTo(width, bandTop + MID_DIVIDER_H);
  ctx.stroke();

  // MidPrice — ortaya
  ctx.font      = '12px Arial';
  ctx.textAlign = 'center';
  ctx.fillStyle = MID_TEXT_COLOR;
  ctx.fillText(formatPrice(book.midPrice), width / 2, bandTop + 12);

  // Spread — midPrice'ın altına
  ctx.font      = '10px Arial';
  ctx.fillStyle = SPREAD_TEXT_COLOR;
  ctx.fillText(
    `Spread: ${formatPrice(book.spread)}`,
    width / 2,
    bandTop + MID_DIVIDER_H - 4,
  );

  // Best Bid / Ask — sol ve sağ köşe
  ctx.font      = '10px Arial';
  ctx.textAlign = 'left';
  ctx.fillStyle = '#50FF50';
  if (book.bids.length > 0) {
    ctx.fillText(`Bid: ${formatPrice(book.bids[0]!.price)}`, 8, bandTop + 12);
  }

  ctx.textAlign = 'right';
  ctx.fillStyle = '#FF5050';
  if (book.asks.length > 0) {
    ctx.fillText(`Ask: ${formatPrice(book.asks[0]!.price)}`, width - 8, bandTop + 12);
  }
}

// ── Max Quantity Bulma ──────────────────────────────────────────────────────

function findMaxQuantity(bids: PriceLevel[], asks: PriceLevel[]): number {
  let max = 0;
  for (let i = 0; i < bids.length; i++) {
    if (bids[i]!.quantity > max) max = bids[i]!.quantity;
  }
  for (let i = 0; i < asks.length; i++) {
    if (asks[i]!.quantity > max) max = asks[i]!.quantity;
  }
  return max;
}

// ── React Bileşeni ──────────────────────────────────────────────────────────

export default function HeatmapCanvas(): JSX.Element {
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

    // ── ResizeObserver — container boyutlarını takip et ──────────────────
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
    resize();  // ilk boyutlandırma

    // ── RAF Döngüsü ─────────────────────────────────────────────────────
    let running = true;

    function loop(): void {
      if (!running) return;

      const { w, h } = sizeRef.current;
      const dpr = window.devicePixelRatio || 1;

      if (w > 0 && h > 0) {
        drawFrame(ctx!, w, h, dpr);
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
      <canvas
        ref={canvasRef}
        style={{ display: 'block' }}
      />
    </div>
  );
}

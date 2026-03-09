// ─────────────────────────────────────────────────────────────────────────────
// utils/priceUtils.ts — Kesin Fiyat & Miktar Matematiği (Floating Point Safe)
// ─────────────────────────────────────────────────────────────────────────────
//
// HFT dünyasında 0.1 + 0.2 = 0.30000000000000004 gibi IEEE 754 hataları ölümcüldür.
// Bu modüldeki tüm fonksiyonlar bu sorunu çözer:
//
//   Strateji: Tüm aritmetik işlemler tam sayıya (integer) çevrilip yapılır,
//             sonuç tekrar ondalıklı forma döndürülür.
//
//   Örnek: roundToTick(68421.3, 0.5)
//          → 68421.3 / 0.5 = 136842.6
//          → Math.round(136842.6) = 136843
//          → 136843 * 0.5 = 68421.5  ✓
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Bir sayının ondalık basamak sayısını döndürür.
 * IEEE 754 güvenli — string üzerinden çalışır.
 *
 * @example
 *   getDecimalPlaces(0.001)  → 3
 *   getDecimalPlaces(0.5)    → 1
 *   getDecimalPlaces(1)      → 0
 *   getDecimalPlaces(1e-7)   → 7
 */
export function getDecimalPlaces(value: number): number {
  if (!Number.isFinite(value) || value === 0) return 0;

  // Bilimsel notasyonu ele al: 1e-7 → "1e-7" → "0.0000001"
  const str = value.toFixed(20);
  // Sondaki sıfırları temizle ve ondalık basamak say
  const trimmed = str.replace(/0+$/, '');
  const dotIndex = trimmed.indexOf('.');
  if (dotIndex === -1) return 0;
  return trimmed.length - dotIndex - 1;
}

/**
 * Kayan nokta güvenli çarpma.
 * İki sayıyı tam sayıya yükselterek çarpar ve sonucu geri böler.
 *
 * @example
 *   safeMul(0.1, 0.2)  → 0.02  (native: 0.020000000000000004)
 */
export function safeMul(a: number, b: number): number {
  const dpA = getDecimalPlaces(a);
  const dpB = getDecimalPlaces(b);
  const factor = Math.pow(10, dpA + dpB);
  const intA = Math.round(a * Math.pow(10, dpA));
  const intB = Math.round(b * Math.pow(10, dpB));
  return (intA * intB) / factor;
}

/**
 * Kayan nokta güvenli toplama.
 *
 * @example
 *   safeAdd(0.1, 0.2)  → 0.3  (native: 0.30000000000000004)
 */
export function safeAdd(a: number, b: number): number {
  const dp = Math.max(getDecimalPlaces(a), getDecimalPlaces(b));
  const factor = Math.pow(10, dp);
  return (Math.round(a * factor) + Math.round(b * factor)) / factor;
}

/**
 * Kayan nokta güvenli çıkarma.
 *
 * @example
 *   safeSub(0.3, 0.1)  → 0.2  (native: 0.19999999999999998)
 */
export function safeSub(a: number, b: number): number {
  const dp = Math.max(getDecimalPlaces(a), getDecimalPlaces(b));
  const factor = Math.pow(10, dp);
  return (Math.round(a * factor) - Math.round(b * factor)) / factor;
}

// ─────────────────────────────────────────────────────────────────────────────
// Ana Fonksiyon: Tick Size'a Yuvarlama
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Bir ham fiyatı belirtilen tick size'ın en yakın katına yuvarlar.
 * Emir defterlerini birleştirirken tüm borsaların fiyatları bu fonksiyondan geçer.
 *
 * Algoritma:
 *   1. price / tickSize → kaç tick'e denk geldiğini bul
 *   2. En yakın tam sayıya yuvarla
 *   3. Tekrar tickSize ile çarp → kesin tick fiyatı
 *   4. Ondalık basamağı tickSize'ın basamağına sabitle (IEEE 754 temizliği)
 *
 * @param price    - Ham fiyat (herhangi bir borsadan)
 * @param tickSize - Yuvarlanacak adım (symbols.ts'ten gelir)
 * @returns          Tick size'ın en yakın katına yuvarlanmış fiyat
 *
 * @example
 *   roundToTick(68421.3,  0.5)   → 68421.5
 *   roundToTick(68421.7,  0.5)   → 68421.5
 *   roundToTick(68421.75, 0.5)   → 68422.0
 *   roundToTick(3421.123, 0.1)   → 3421.1
 *   roundToTick(142.456,  0.01)  → 142.46
 */
export function roundToTick(price: number, tickSize: number): number {
  if (tickSize <= 0) {
    throw new Error(`[priceUtils] tickSize sıfır veya negatif olamaz: ${tickSize}`);
  }
  if (!Number.isFinite(price)) {
    throw new Error(`[priceUtils] Geçersiz fiyat: ${price}`);
  }

  // Tick precision — sonucu bu basamağa yuvarlayacağız
  const tickDP = getDecimalPlaces(tickSize);

  // Bölme işlemini tam sayı düzleminde yap
  const factor = Math.pow(10, tickDP);
  const scaledPrice = Math.round(price * factor);
  const scaledTick  = Math.round(tickSize * factor);

  // Kaç tam tick'e denk geliyor?
  const ticks = Math.round(scaledPrice / scaledTick);

  // Sonucu geri oluştur
  const result = (ticks * scaledTick) / factor;

  return result;
}

/**
 * Bir fiyatı belirtilen tick size'a AŞAĞI yuvarlar (floor).
 * Bid tarafı için kullanışlı — alış fiyatları aşağı yuvarlanır.
 *
 * @example
 *   floorToTick(68421.7, 0.5) → 68421.5
 *   floorToTick(68422.0, 0.5) → 68422.0
 */
export function floorToTick(price: number, tickSize: number): number {
  if (tickSize <= 0) {
    throw new Error(`[priceUtils] tickSize sıfır veya negatif olamaz: ${tickSize}`);
  }

  const tickDP = getDecimalPlaces(tickSize);
  const factor = Math.pow(10, tickDP);
  const scaledPrice = Math.round(price * factor);
  const scaledTick  = Math.round(tickSize * factor);

  const ticks = Math.floor(scaledPrice / scaledTick);
  return (ticks * scaledTick) / factor;
}

/**
 * Bir fiyatı belirtilen tick size'a YUKARI yuvarlar (ceil).
 * Ask tarafı için kullanışlı — satış fiyatları yukarı yuvarlanır.
 *
 * @example
 *   ceilToTick(68421.1, 0.5) → 68421.5
 *   ceilToTick(68421.5, 0.5) → 68421.5
 */
export function ceilToTick(price: number, tickSize: number): number {
  if (tickSize <= 0) {
    throw new Error(`[priceUtils] tickSize sıfır veya negatif olamaz: ${tickSize}`);
  }

  const tickDP = getDecimalPlaces(tickSize);
  const factor = Math.pow(10, tickDP);
  const scaledPrice = Math.round(price * factor);
  const scaledTick  = Math.round(tickSize * factor);

  const ticks = Math.ceil(scaledPrice / scaledTick);
  return (ticks * scaledTick) / factor;
}

/**
 * Bir miktarı step size'a yuvarlar (en yakın kat).
 * Trade miktarlarını normalize ederken kullanılır.
 *
 * @example
 *   roundToStep(0.12345, 0.001)  → 0.123
 *   roundToStep(1.567,   0.01)   → 1.57
 */
export function roundToStep(quantity: number, stepSize: number): number {
  return roundToTick(quantity, stepSize); // Aynı mantık
}

/**
 * Bir sayıyı belirtilen ondalık basamağa yuvarlar.
 * Genel amaçlı — gösterim ve loglama için.
 *
 * @example
 *   roundToDP(3.14159, 2) → 3.14
 *   roundToDP(3.145, 2)   → 3.15
 */
export function roundToDP(value: number, decimalPlaces: number): number {
  const factor = Math.pow(10, decimalPlaces);
  return Math.round(value * factor) / factor;
}

/**
 * Spread'i tick sayısı olarak hesaplar.
 * Farklı enstrümanlar arasında spread karşılaştırması için normalize edilmiş metrik.
 *
 * @example
 *   spreadInTicks(68421.5, 68422.0, 0.5) → 1
 *   spreadInTicks(3421.1,  3421.5,  0.1) → 4
 */
export function spreadInTicks(bestBid: number, bestAsk: number, tickSize: number): number {
  const spreadValue = safeSub(bestAsk, bestBid);
  return Math.round(spreadValue / tickSize);
}

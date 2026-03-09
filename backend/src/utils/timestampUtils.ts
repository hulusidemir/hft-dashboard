// ─────────────────────────────────────────────────────────────────────────────
// utils/timestampUtils.ts — Zaman Damgası Normalizasyonu
// ─────────────────────────────────────────────────────────────────────────────
//
// Borsalar farklı zaman damgası formatları kullanır:
//   - Binance: Unix epoch milisaniye (ms)
//   - Bybit:   Unix epoch milisaniye (ms) veya bazen mikrosaniye (µs)
//   - OKX:     Unix epoch milisaniye (ms) — string olarak da gelebilir
//
// Bu modül, gelen her türlü formatı GÜVENLİ bir şekilde ms epoch'a normalize eder.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Herhangi bir formattaki zaman damgasını Unix epoch milisaniyeye normalize eder.
 *
 * Algılama mantığı:
 *   - 10 hane → saniye (s) → 1000 ile çarp
 *   - 13 hane → milisaniye (ms) → olduğu gibi
 *   - 16 hane → mikrosaniye (µs) → 1000'e böl
 *   - 19 hane → nanosaniye (ns) → 1_000_000'a böl
 *   - string → önce number'a çevir → aynı mantık
 *
 * @param raw - Zaman damgası (number veya string)
 * @returns Unix epoch milisaniye
 *
 * @example
 *   normalizeTimestamp(1709000000)          → 1709000000000  (saniye → ms)
 *   normalizeTimestamp(1709000000000)       → 1709000000000  (ms → ms)
 *   normalizeTimestamp(1709000000000000)    → 1709000000000  (µs → ms)
 *   normalizeTimestamp("1709000000000")     → 1709000000000  (string ms)
 */
export function normalizeTimestamp(raw: string | number): number {
  let ts: number;

  if (typeof raw === 'string') {
    ts = Number(raw);
    if (!Number.isFinite(ts)) {
      // ISO 8601 string denemesi
      const parsed = Date.parse(raw);
      if (!Number.isFinite(parsed)) {
        throw new Error(`[timestampUtils] Ayrıştırılamayan zaman damgası: "${raw}"`);
      }
      return parsed;
    }
  } else {
    ts = raw;
  }

  if (!Number.isFinite(ts) || ts <= 0) {
    throw new Error(`[timestampUtils] Geçersiz zaman damgası: ${raw}`);
  }

  // Hane sayısına göre birim tespiti
  const digits = Math.floor(Math.log10(ts)) + 1;

  if (digits <= 10) {
    // Saniye cinsinden
    return Math.floor(ts * 1000);
  } else if (digits <= 13) {
    // Zaten milisaniye
    return Math.floor(ts);
  } else if (digits <= 16) {
    // Mikrosaniye
    return Math.floor(ts / 1000);
  } else {
    // Nanosaniye
    return Math.floor(ts / 1_000_000);
  }
}

/**
 * Şu anki zamanı Unix epoch milisaniye olarak döndürür.
 * Performans için Date.now() kullanır (V8'de optimize edilmiştir).
 */
export function nowMs(): number {
  return Date.now();
}

/**
 * Yüksek çözünürlüklü zaman damgası (mikrosaniye doğruluğuna yakın).
 * performance.now() yerel monotonik saat kullanır — duvar saatinden sapma yoktur.
 * Gecikme ölçümlerinde tercihen bu kullanılır.
 */
export function hrNowMs(): number {
  return performance.now();
}

/**
 * İki zaman damgası arasındaki milisaniye farkını döndürür.
 * Negatif sonuçları sıfıra sabitler — saat kaymaları için güvenli.
 */
export function diffMs(startMs: number, endMs: number): number {
  const diff = endMs - startMs;
  return diff > 0 ? diff : 0;
}

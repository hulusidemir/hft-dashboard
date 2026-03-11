// ─────────────────────────────────────────────────────────────────────────────
// db/LiquidationDB.ts — SQLite Tasfiye Veritabanı (better-sqlite3)
// ─────────────────────────────────────────────────────────────────────────────
//
// Görev:
//   1. liquidations.db dosyasını oluşturur / açar
//   2. Gelen gerçek tasfiye verilerini INSERT eder
//   3. MR sayfası için timeframe-bazlı SUM sorguları çalıştırır
//   4. 48 saatten eski kayıtları periyodik olarak temizler
//
// Senkronize better-sqlite3 kullanır — saniyede binlerce yazma kapasitesi.
// ─────────────────────────────────────────────────────────────────────────────

import Database from 'better-sqlite3';
import path from 'node:path';
import { Logger } from '../utils/logger.js';

const log = new Logger('LiquidationDB');

/** 48 saat — ms cinsinden */
const MAX_AGE_MS = 48 * 60 * 60 * 1000; // 172_800_000

/** Temizlik aralığı — 5 dakikada bir */
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;

// ── Singleton DB Bağlantısı ──────────────────────────────────────────────────

let db: Database.Database | null = null;
let cleanupTimer: ReturnType<typeof setInterval> | null = null;

// ── Prepared Statements (lazy init) ─────────────────────────────────────────

let stmtInsert: Database.Statement | null = null;
let stmtSumBySide: Database.Statement | null = null;
let stmtCleanup: Database.Statement | null = null;

// ── Başlatma ─────────────────────────────────────────────────────────────────

/**
 * Veritabanını başlatır. Zaten açıksa tekrar açmaz.
 * Server bootstrap sırasında bir kez çağrılır.
 */
export function initLiquidationDB(): void {
  if (db) return;

  const dbPath = path.resolve(process.cwd(), 'liquidations.db');
  log.info(`SQLite veritabanı açılıyor: ${dbPath}`);

  db = new Database(dbPath);

  // WAL mode — yüksek eşzamanlı okuma/yazma performansı
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');

  // Tablo oluştur
  db.exec(`
    CREATE TABLE IF NOT EXISTS liquidations (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      exchange  TEXT    NOT NULL,
      symbol    TEXT    NOT NULL,
      side      TEXT    NOT NULL,
      price     REAL    NOT NULL,
      qty       REAL    NOT NULL,
      usdValue  REAL    NOT NULL,
      timestamp INTEGER NOT NULL
    )
  `);

  // İndeksler — sorgu performansı için
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_liq_symbol_ts
      ON liquidations (symbol, timestamp);
    CREATE INDEX IF NOT EXISTS idx_liq_exchange_symbol_side_ts
      ON liquidations (exchange, symbol, side, timestamp);
  `);

  // Prepared statement'ları hazırla
  stmtInsert = db.prepare(`
    INSERT INTO liquidations (exchange, symbol, side, price, qty, usdValue, timestamp)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  stmtSumBySide = db.prepare(`
    SELECT COALESCE(SUM(usdValue), 0) AS total
    FROM liquidations
    WHERE symbol = ? AND exchange = ? AND side = ? AND timestamp >= ?
  `);

  stmtCleanup = db.prepare(`
    DELETE FROM liquidations WHERE timestamp < ?
  `);

  // İlk temizlik
  cleanup();

  // Periyodik temizlik
  cleanupTimer = setInterval(cleanup, CLEANUP_INTERVAL_MS);

  const count = (db.prepare('SELECT COUNT(*) AS cnt FROM liquidations').get() as { cnt: number }).cnt;
  log.info(`LiquidationDB hazır — mevcut kayıt: ${count}`);
}

// ── INSERT ───────────────────────────────────────────────────────────────────

export interface LiquidationRecord {
  exchange: string;  // 'binance' | 'bybit' | 'okx'
  symbol: string;    // 'BTCUSDT'
  side: string;      // 'long' | 'short'
  price: number;
  qty: number;
  usdValue: number;
  timestamp: number; // ms epoch
}

/**
 * Tek bir tasfiye kaydını veritabanına yazar.
 * Senkronize — µs mertebesinde çalışır.
 */
export function insertLiquidation(rec: LiquidationRecord): void {
  if (!stmtInsert) return;
  try {
    stmtInsert.run(
      rec.exchange,
      rec.symbol,
      rec.side,
      rec.price,
      rec.qty,
      rec.usdValue,
      rec.timestamp,
    );
  } catch (e: unknown) {
    log.warn('INSERT hatası', e instanceof Error ? e : undefined);
  }
}

/**
 * Birden fazla kaydı tek bir transaction içinde yazar.
 * Batch performansı için çok daha hızlı.
 */
export function insertLiquidationBatch(records: LiquidationRecord[]): void {
  if (!db || !stmtInsert || records.length === 0) return;
  const insertMany = db.transaction((rows: LiquidationRecord[]) => {
    for (const r of rows) {
      stmtInsert!.run(r.exchange, r.symbol, r.side, r.price, r.qty, r.usdValue, r.timestamp);
    }
  });
  try {
    insertMany(records);
  } catch (e: unknown) {
    log.warn('Batch INSERT hatası', e instanceof Error ? e : undefined);
  }
}

// ── QUERY (MR sayfası için) ──────────────────────────────────────────────────

/**
 * Belirtilen borsa + sembol + taraf + zaman aralığı için toplam tasfiye USD döner.
 * Kayıt yoksa 0 döner.
 */
export function sumLiquidations(
  symbol: string,
  exchange: string,
  side: string,
  startTime: number,
): number {
  if (!stmtSumBySide) return 0;
  try {
    const row = stmtSumBySide.get(symbol, exchange, side, startTime) as { total: number } | undefined;
    return row?.total ?? 0;
  } catch (e: unknown) {
    log.warn('SUM sorgu hatası', e instanceof Error ? e : undefined);
    return 0;
  }
}

/**
 * MR sayfası için tek seferde borsa bazlı liqLong + liqShort döner.
 */
export function queryLiqForMR(
  symbol: string,
  exchange: string,
  startTime: number,
): { longUsd: number; shortUsd: number } {
  return {
    longUsd:  sumLiquidations(symbol, exchange, 'long', startTime),
    shortUsd: sumLiquidations(symbol, exchange, 'short', startTime),
  };
}

/**
 * Belirli bir sembol için son N tasfiye kaydını getirir.
 * Frontend liquidation feed'i başlangıçta doldurmak için kullanılır.
 */
export function getRecentLiquidations(symbol: string, limit: number = 50): LiquidationRecord[] {
  if (!db) return [];
  try {
    const stmt = db.prepare(`
      SELECT exchange, symbol, side, price, qty, usdValue, timestamp
      FROM liquidations
      WHERE symbol = ?
      ORDER BY timestamp DESC
      LIMIT ?
    `);
    const rows = stmt.all(symbol, limit) as LiquidationRecord[];
    return rows.reverse(); // Eskiden yeniye sırala
  } catch (e: unknown) {
    log.warn('getRecentLiquidations hatası', e instanceof Error ? e : undefined);
    return [];
  }
}

// ── Temizlik ─────────────────────────────────────────────────────────────────

function cleanup(): void {
  if (!stmtCleanup) return;
  try {
    const cutoff = Date.now() - MAX_AGE_MS;
    const result = stmtCleanup.run(cutoff);
    if (result.changes > 0) {
      log.info(`Temizlik: ${result.changes} eski kayıt silindi (cutoff: ${new Date(cutoff).toISOString()})`);
    }
  } catch (e: unknown) {
    log.warn('Temizlik hatası', e instanceof Error ? e : undefined);
  }
}

// ── Graceful Shutdown ────────────────────────────────────────────────────────

export function closeLiquidationDB(): void {
  if (cleanupTimer) {
    clearInterval(cleanupTimer);
    cleanupTimer = null;
  }
  if (db) {
    db.close();
    db = null;
    stmtInsert = null;
    stmtSumBySide = null;
    stmtCleanup = null;
    log.info('LiquidationDB kapatıldı');
  }
}

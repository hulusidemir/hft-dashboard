// ─────────────────────────────────────────────────────────────────────────────
// utils/logger.ts — Yapılandırılmış Loglama Modülü
// ─────────────────────────────────────────────────────────────────────────────
//
// HFT sistemlerinde loglama performans düşürücüdür.
// Bu logger:
//   1. Seviye bazlı filtreleme yapar (gereksiz loglar yazdırılmaz)
//   2. ISO timestamp ekler
//   3. Borsa/modül etiketi ile aranabilir log üretir
//   4. JSON serialize sırasında circular referans yakalanır
//
// Üretim ortamında LOG_LEVEL=warn ayarlanarak debug/info sessizleştirilir.
// ─────────────────────────────────────────────────────────────────────────────

export enum LogLevel {
  DEBUG = 0,
  INFO  = 1,
  WARN  = 2,
  ERROR = 3,
  FATAL = 4,
  SILENT = 5,
}

/** Ortam değişkeninden log seviyesi */
function getLogLevelFromEnv(): LogLevel {
  const envLevel = (process.env['LOG_LEVEL'] ?? 'debug').toUpperCase();
  switch (envLevel) {
    case 'DEBUG':  return LogLevel.DEBUG;
    case 'INFO':   return LogLevel.INFO;
    case 'WARN':   return LogLevel.WARN;
    case 'ERROR':  return LogLevel.ERROR;
    case 'FATAL':  return LogLevel.FATAL;
    case 'SILENT': return LogLevel.SILENT;
    default:       return LogLevel.DEBUG;
  }
}

/** Seviye etiketi */
const LEVEL_LABELS: Record<LogLevel, string> = {
  [LogLevel.DEBUG]:  'DEBUG',
  [LogLevel.INFO]:   'INFO ',
  [LogLevel.WARN]:   'WARN ',
  [LogLevel.ERROR]:  'ERROR',
  [LogLevel.FATAL]:  'FATAL',
  [LogLevel.SILENT]: '     ',
};

/** Konsol renk kodları */
const LEVEL_COLORS: Record<LogLevel, string> = {
  [LogLevel.DEBUG]:  '\x1b[36m',   // Cyan
  [LogLevel.INFO]:   '\x1b[32m',   // Green
  [LogLevel.WARN]:   '\x1b[33m',   // Yellow
  [LogLevel.ERROR]:  '\x1b[31m',   // Red
  [LogLevel.FATAL]:  '\x1b[41m',   // Red background
  [LogLevel.SILENT]: '',
};

const RESET = '\x1b[0m';
const DIM   = '\x1b[2m';

/**
 * Modül bazlı logger. Her modül kendi etiketiyle bir Logger oluşturur.
 *
 * @example
 *   const log = new Logger('BinanceService');
 *   log.info('Bağlantı kuruldu', { symbol: 'BTCUSDT', pingMs: 12 });
 *   // → 2026-03-09T14:30:00.123Z [INFO ] [BinanceService] Bağlantı kuruldu {"symbol":"BTCUSDT","pingMs":12}
 */
export class Logger {
  private static globalLevel: LogLevel = getLogLevelFromEnv();
  private readonly tag: string;

  constructor(tag: string) {
    this.tag = tag;
  }

  /** Çalışma zamanında global seviyeyi değiştir */
  static setLevel(level: LogLevel): void {
    Logger.globalLevel = level;
  }

  /** Mevcut global log seviyesini döndürür */
  static getLevel(): LogLevel {
    return Logger.globalLevel;
  }

  debug(message: string, data?: unknown): void {
    this.log(LogLevel.DEBUG, message, data);
  }

  info(message: string, data?: unknown): void {
    this.log(LogLevel.INFO, message, data);
  }

  warn(message: string, data?: unknown): void {
    this.log(LogLevel.WARN, message, data);
  }

  error(message: string, data?: unknown): void {
    this.log(LogLevel.ERROR, message, data);
  }

  fatal(message: string, data?: unknown): void {
    this.log(LogLevel.FATAL, message, data);
  }

  private log(level: LogLevel, message: string, data?: unknown): void {
    if (level < Logger.globalLevel) return;

    const timestamp = new Date().toISOString();
    const color = LEVEL_COLORS[level] ?? '';
    const label = LEVEL_LABELS[level] ?? 'UNKN ';

    let dataStr = '';
    if (data !== undefined) {
      try {
        if (data instanceof Error) {
          dataStr = ` ${data.message}${data.stack ? '\n' + data.stack : ''}`;
        } else {
          dataStr = ` ${JSON.stringify(data)}`;
        }
      } catch {
        dataStr = ' [Serialization Error]';
      }
    }

    const line = `${DIM}${timestamp}${RESET} ${color}[${label}]${RESET} [${this.tag}] ${message}${dataStr}`;

    if (level >= LogLevel.ERROR) {
      process.stderr.write(line + '\n');
    } else {
      process.stdout.write(line + '\n');
    }
  }
}

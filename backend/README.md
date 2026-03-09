# HFT Dashboard Backend

Gerçek zamanlı kripto piyasa verilerini (order book, trade, liquidation, open interest) birleştirip frontend'e düşük gecikmeli WebSocket yayınlayan TypeScript backend servisidir.

## Özellikler

- Binance, Bybit ve OKX kaynaklarından veri toplama
- Birleşik veri katmanı (aggregator) ile tek formatta yayın
- `uWebSockets.js` ile yüksek performanslı WebSocket server
- Sembol değişimini çalışma anında (hot switch) destekleme
- Radar endpoint'i ile hot target verisi sunma
- Health endpoint ve graceful shutdown desteği

## Teknoloji

- Node.js (ESM)
- TypeScript
- uWebSockets.js
- msgpack (`@msgpack/msgpack`)

## Proje Yapısı

```text
src/
	index.ts                 # Uygulama giriş noktası, bootstrap ve sembol orkestrasyonu
	server.ts                # REST + WebSocket yayın katmanı
	aggregators/             # Unified veri üretimi (OB/Trade/Liq/OI)
	services/                # Borsa servisleri (Binance/Bybit/OKX/Radar)
	interfaces/              # Unified tip tanımları
	config/                  # Sembol ve borsa konfigürasyon yardımcıları
	utils/                   # Logger, fiyat ve zaman yardımcıları
```

## Kurulum

```bash
npm install
```

## Çalıştırma

### Geliştirme

```bash
npm run dev
```

### Build

```bash
npm run build
```

### Production Başlatma

```bash
npm start
```

## Scriptler

- `npm run dev` → `src/index.ts` için watch modda geliştirme
- `npm run build` → TypeScript derleme (`dist/`)
- `npm start` → derlenmiş uygulamayı çalıştırma
- `npm run typecheck` → çıktı üretmeden tip kontrolü

## Konfigürasyon

Ortam değişkenleri:

- `WS_PORT` (opsiyonel): WebSocket/HTTP server portu (varsayılan: `9000`)

Örnek:

```bash
WS_PORT=9100 npm run dev
```

## API ve Yayınlar

### REST

- `GET /health`
- `GET /api/symbols`
- `GET /api/radar/hot-targets`

### WebSocket

Sunucu, binary msgpack mesajları yayınlar.

Temel topic/mesaj tipleri:

- `lob`
- `trades`
- `liquidations`
- `oi`
- `init`, `symbol_switching`, `symbol_changed`, `symbol_error`

## GitHub'a Göndermeden Önce

- `.env` dosyalarını repoya ekleme
- `node_modules/` ve `dist/` klasörlerini commit etme
- `npm run typecheck` ve mümkünse `npm run build` çalıştırma

## Lisans

Bu depoda lisans dosyası tanımlı değil. Açık kaynak yayımlayacaksan `LICENSE` eklemen önerilir.

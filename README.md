# HFT Dashboard

High-frequency crypto market dashboard monorepo.

Bu depo iki ana parçadan oluşur:

- `backend/`: Gerçek zamanlı veri toplama, birleştirme ve yayın katmanı
- `frontend/`: React + Vite tabanlı görselleştirme ve dashboard arayüzü

## Mimari

- Backend, Binance/Bybit/OKX kaynaklarından market stream verilerini toplar.
- Aggregator katmanı order book, trade, liquidation ve open interest verilerini unified formata çevirir.
- uWebSockets.js server üzerinden binary msgpack mesajları frontend'e yayınlanır.
- Frontend, bu streamleri grafik/panel bileşenleri üzerinde render eder.

## Klasör Yapısı

```text
.
├── backend/
│   ├── src/
│   ├── package.json
│   └── README.md
├── frontend/
│   ├── src/
│   ├── package.json
│   └── README.md
└── README.md
```

## Hızlı Başlangıç

### 1) Backend

```bash
cd backend
npm install
npm run dev
```

Varsayılan backend portu: `9000`

### 2) Frontend

Yeni terminalde:

```bash
cd frontend
npm install
npm run dev
```

## Script Özeti

### Backend (`backend/package.json`)

- `npm run dev`: TSX watch ile geliştirme
- `npm run build`: TypeScript derleme
- `npm start`: derlenmiş çıktıyı çalıştırma
- `npm run typecheck`: tip kontrolü

### Frontend (`frontend/package.json`)

- `npm run dev`: Vite geliştirme sunucusu
- `npm run build`: TS + Vite production build
- `npm run preview`: build önizleme
- `npm run lint`: ESLint kontrolü

## Ortam Değişkenleri

- Backend: `WS_PORT` (opsiyonel)

Örnek:

```bash
WS_PORT=9100 npm run dev
```

## Git ve Yayınlama

Bu repo monorepo olarak tek kökten yönetilmelidir:

```bash
git init
git add .
git commit -m "Initial monorepo commit"
git branch -M main
git remote add origin https://github.com/hulusidemir/hft-dashboard.git
git push -u origin main
```

Eğer daha önce sadece `backend/` içinde Git başlattıysan, kökten tek repo yönetimi için `backend/.git` klasörünü kaldırıp yukarıdaki adımları kökte çalıştır.

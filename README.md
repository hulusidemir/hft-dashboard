# HFT Scalping Dashboard

<div align="center">

**Real-time, multi-exchange cryptocurrency scalping dashboard**

*Binance · Bybit · OKX — unified in one terminal-style interface*

![TypeScript](https://img.shields.io/badge/TypeScript-5.9-blue?logo=typescript)
![React](https://img.shields.io/badge/React-19-61dafb?logo=react)
![Node.js](https://img.shields.io/badge/Node.js-20+-339933?logo=node.js)
![License](https://img.shields.io/badge/License-MIT-green)

</div>

---

## Overview

A professional-grade, high-frequency crypto market dashboard built for scalpers and day traders. Aggregates real-time data from **Binance**, **Bybit**, and **OKX** into a unified, low-latency terminal interface.

### Key Features

| Feature | Description |
|---------|-------------|
| **Live Order Book Heatmap** | Canvas-rendered LOB heatmap with grouping modes (RT/Short/Mid/Long) |
| **Trade Tape** | Real-time trade flow with whale detection ($100K+) and minimum USD filter |
| **Liquidation Feed** | Live margin liquidation waterfall across all 3 exchanges |
| **Price Charts** | Real-time line chart + historical OHLC candlesticks (5m/15m/1h/4h) with scroll-to-latest |
| **CVD Chart** | Cumulative Volume Delta — buyer vs seller pressure momentum |
| **OI Monitor** | Open Interest net flow with baseline visualization |
| **Radar Panel** | Global market scanner — whale trades + large liquidations war log |
| **Coin MR (Market Recon)** | Pre-trade intelligence: OI, funding, L/S ratio, CVD, depth chart, news + Exchange Breakdown table |
| **Market Overview** | 4-timeframe directional bias analysis with signal scoring system |
| **Exchange Comparison** | Side-by-side charts (Binance/Bybit/OKX) with shared timeframe selector (RT/5m/15m/1h/4h) and per-exchange klines |
| **Multi-language** | Turkish + English UI with one-click toggle |

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                        FRONTEND                              │
│  React 19 + Vite 7 + Zustand 5 + Lightweight Charts v5     │
│  Canvas rendering (LOB, Tape) — zero DOM re-renders         │
│  Binary msgpack WebSocket client                             │
└─────────────────────┬───────────────────────────────────────┘
                      │ msgpack over WebSocket
┌─────────────────────▼───────────────────────────────────────┐
│                        BACKEND                               │
│  Node.js + uWebSockets.js (C++ bound) + TypeScript          │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐                    │
│  │ Binance  │ │  Bybit   │ │   OKX    │  Exchange Services │
│  │ Service  │ │ Service  │ │ Service  │  (WebSocket feeds) │
│  └────┬─────┘ └────┬─────┘ └────┬─────┘                    │
│       └─────────────┼───────────┘                            │
│  ┌──────────────────▼───────────────────┐                   │
│  │         Aggregators Layer             │                   │
│  │  OrderBook | Trade | OI | Liquidation │                   │
│  └──────────────────┬───────────────────┘                   │
│  ┌──────────────────▼───────────────────┐                   │
│  │     uWebSockets.js Server (Port 9000) │                   │
│  │  WS: binary msgpack pub/sub           │                   │
│  │  REST: /api/mr, /api/news, /api/etc   │                   │
│  └──────────────────────────────────────┘                   │
│  + SQLite (liquidation history) + Radar + Global Listeners  │
└─────────────────────────────────────────────────────────────┘
```

### Data Flow

1. **Exchange Services** connect to Binance, Bybit, and OKX WebSocket feeds simultaneously
2. **Aggregators** normalize order book, trade, liquidation, and OI data into unified formats
3. **uWebSockets.js** broadcasts aggregated data as binary msgpack messages (~1ms latency)
4. **Frontend** receives and renders via Canvas (LOB, Tape) and lightweight-charts (Price, CVD, OI)
5. **REST API** serves historical klines, market reconnaissance, news, and overview analytics

## Tech Stack

### Backend
- **Runtime:** Node.js 20+
- **Server:** [uWebSockets.js](https://github.com/uNetworking/uWebSockets.js) v20.60 (C++ HTTP/WS)
- **Serialization:** [msgpack](https://msgpack.org/) (binary, ~40% smaller than JSON)
- **Database:** [better-sqlite3](https://github.com/WiseLibs/better-sqlite3) (liquidation history)
- **HTTP Client:** axios
- **Language:** TypeScript 5.5+

### Frontend
- **Framework:** React 19
- **Build Tool:** Vite 7
- **State:** [Zustand](https://zustand-demo.pmnd.rs/) 5 (vanilla store + React hooks)
- **Charts:** [Lightweight Charts](https://tradingview.github.io/lightweight-charts/) v5
- **Rendering:** Native Canvas API (LOB heatmap, trade tape)
- **Language:** TypeScript 5.9

## Project Structure

```
hft-dashboard/
├── backend/
│   ├── src/
│   │   ├── index.ts                 # Entry point — orchestrates all services
│   │   ├── server.ts                # uWebSockets.js HTTP + WS server
│   │   ├── aggregators/
│   │   │   ├── OrderBookAggregator.ts
│   │   │   ├── TradeAggregator.ts
│   │   │   ├── LiquidationAggregator.ts
│   │   │   └── OpenInterestAggregator.ts
│   │   ├── config/
│   │   │   └── symbols.ts           # Dynamic symbol list from Bybit
│   │   ├── db/
│   │   │   └── LiquidationDB.ts     # SQLite liquidation store
│   │   ├── interfaces/              # Unified exchange data types
│   │   ├── services/
│   │   │   ├── BinanceService.ts    # Binance WS + REST
│   │   │   ├── BybitService.ts      # Bybit WS + REST
│   │   │   ├── OkxService.ts        # OKX WS + REST
│   │   │   ├── MrService.ts         # Market Recon (18 parallel API calls)
│   │   │   ├── OverviewService.ts   # 4-TF overview analytics
│   │   │   ├── NewsService.ts       # CryptoCompare + CryptoPanic news
│   │   │   ├── CoinInfoService.ts   # CoinGecko coin metadata
│   │   │   ├── RadarService.ts      # Global market scanner
│   │   │   ├── GlobalTradeListener.ts
│   │   │   ├── LiquidationListener.ts
│   │   │   └── base/
│   │   │       └── BaseExchangeService.ts
│   │   └── utils/
│   │       ├── logger.ts
│   │       ├── priceUtils.ts
│   │       └── timestampUtils.ts
│   ├── package.json
│   └── tsconfig.json
├── frontend/
│   ├── src/
│   │   ├── App.tsx                  # Main layout + view routing
│   │   ├── main.tsx                 # React entry point
│   │   ├── components/
│   │   │   ├── TopBar.tsx           # Symbol selector + nav buttons + lang toggle
│   │   │   ├── HeatmapCanvas.tsx    # LOB heatmap (Canvas)
│   │   │   ├── TapeCanvas.tsx       # Trade tape (Canvas)
│   │   │   ├── LiquidationFeed.tsx  # Liquidation waterfall
│   │   │   ├── ChartPanel.tsx       # Price chart (RT + OHLC)
│   │   │   ├── CVDChart.tsx         # CVD chart
│   │   │   ├── OIChart.tsx          # Open Interest chart
│   │   │   ├── SystemMonitor.tsx    # Latency & health monitor
│   │   │   ├── RadarPanel.tsx       # Global scanner
│   │   │   ├── CoinMRPanel.tsx      # Market reconnaissance
│   │   │   ├── OverviewPanel.tsx    # Market overview
│   │   │   └── ExchangesPanel.tsx   # Exchange comparison
│   │   ├── stores/
│   │   │   └── marketStore.ts       # Zustand state management
│   │   └── utils/
│   │       ├── audioManager.ts      # Whale alert sounds
│   │       ├── chartSync.ts         # Multi-chart crosshair sync
│   │       └── i18n.ts              # Internationalization (TR/EN)
│   ├── package.json
│   ├── vite.config.ts
│   └── tsconfig.json
└── README.md
```

## Quick Start

### Prerequisites

- **Node.js** 20+ (LTS recommended)
- **npm** 9+

### 1) Clone & Install

```bash
git clone <repo-url> hft-dashboard
cd hft-dashboard

# Install all dependencies at once (root)
npm run install:all

# Or manually:
# cd backend && npm install
# cd ../frontend && npm install
```

### 2) Start Both Servers (Recommended)

```bash
# From root — starts backend + frontend concurrently
npm run dev
```

### 3) (Alternative) Start Separately

```bash
# Backend
cd backend && npm run dev

# Frontend (new terminal)
cd frontend && npm run dev
```

### 4) Open Dashboard

Navigate to `http://localhost:5173` in your browser.

## Configuration

### Backend Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `WS_PORT` | `9000` | WebSocket + REST API server port |
| `CRYPTOPANIC_API_KEY` | *(empty)* | Optional CryptoPanic API key for additional news |

```bash
# Example: custom port + CryptoPanic key
WS_PORT=9100 CRYPTOPANIC_API_KEY=your_key npm run dev
```

### Frontend Environment Variables

Create a `.env.local` file in the `frontend/` directory:

| Variable | Default | Description |
|----------|---------|-------------|
| `VITE_BACKEND_URL` | `http://localhost:9000` | Backend server URL |

```bash
# frontend/.env.local — for remote server
VITE_BACKEND_URL=http://192.168.1.100:9000
```

## Scripts

### Root (`/`)

| Script | Command | Description |
|--------|---------|-------------|
| `dev` | `npm run dev` | Start backend + frontend concurrently |
| `dev:backend` | `npm run dev:backend` | Backend only |
| `dev:frontend` | `npm run dev:frontend` | Frontend only |
| `build` | `npm run build` | Build both backend and frontend |
| `install:all` | `npm run install:all` | Install all dependencies |
| `typecheck` | `npm run typecheck` | Type-check both projects |

### Backend (`backend/`)

| Script | Command | Description |
|--------|---------|-------------|
| `dev` | `npm run dev` | Development mode with hot-reload (tsx watch) |
| `build` | `npm run build` | TypeScript compilation |
| `start` | `npm start` | Run compiled output (`dist/`) |
| `typecheck` | `npm run typecheck` | Type checking only |

### Frontend (`frontend/`)

| Script | Command | Description |
|--------|---------|-------------|
| `dev` | `npm run dev` | Vite development server with HMR |
| `build` | `npm run build` | Production build (TS + Vite) |
| `preview` | `npm run preview` | Preview production build locally |
| `lint` | `npm run lint` | ESLint check |

## API Endpoints

All REST endpoints are served from the backend on the configured port.

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/mr?symbol=BTCUSDT&tf=1h` | GET | Market reconnaissance data (3 exchanges) |
| `/api/news?symbol=BTCUSDT` | GET | Coin news (CryptoCompare + CryptoPanic) |
| `/api/coin-info?symbol=BTCUSDT` | GET | Coin metadata from CoinGecko |
| `/api/overview?symbol=BTCUSDT` | GET | 4-timeframe market overview analysis |
| `/api/klines?symbol=BTCUSDT&interval=1h&limit=300&exchange=binance` | GET | Historical OHLCV klines (exchange: binance\|bybit\|okx) |
| `/api/oi-history?symbol=BTCUSDT&interval=1h&limit=300` | GET | Historical open interest |
| `/api/symbols` | GET | Available trading symbols |
| `/api/liquidations/history` | GET | Liquidation history from SQLite |

## WebSocket Protocol

The WebSocket connection uses **binary msgpack** encoding for minimal latency.

### Message Topics

| Topic | Direction | Description |
|-------|-----------|-------------|
| `lob` | Server → Client | Order book snapshot (bids + asks + mid price) |
| `trades` | Server → Client | Aggregated trade batch |
| `oi` | Server → Client | Open interest update |
| `liquidations` | Server → Client | Liquidation events |
| `init` | Server → Client | Initial state on connection |
| `symbol_switching` | Server → Client | Symbol change in progress |
| `symbol_changed` | Server → Client | Symbol change complete |
| `change_symbol` | Client → Server | Request symbol change |
| `ping` / `pong` | Bidirectional | Latency measurement |

## Views

### Dashboard (Default)
The main trading view with 3-column layout:
- **Left:** System monitor + LOB heatmap
- **Center:** Price chart + CVD chart + OI chart
- **Right:** Trade tape + liquidation feed

### Radar
Global market scanner monitoring all major coins for:
- Whale trades ($100K+)
- Large liquidations ($10K+)
- Hot targets with volume/price alerts

### Coin MR (Market Reconnaissance)
Pre-trade intelligence panel:
- Aggregated metrics from 3 exchanges
- OI, Funding, L/S ratio, CVD data
- Combined depth chart
- Latest news (last 30 days)

### Overview
4-timeframe directional bias analysis:
- Signal scoring: OI (20%) + CVD (25%) + Funding (15%) + L/S (10%) + Liquidations (15%) + Price (15%)
- Bias classification: Strong Long / Long / Neutral / Short / Strong Short
- Weighted consensus across 15m, 1h, 4h, 24h timeframes

### Exchanges
Side-by-side price comparison from Binance, Bybit, and OKX:
- **Shared timeframe selector** for all 3 charts: RT (1s live candle), 5m, 15m, 1h, 4h
- Per-exchange kline data fetched from each exchange's native API (Binance FAPI, Bybit V5, OKX)
- Shared minimum USD filter for all 3 tape streams
- OI share bar, Order Book delta bar per exchange
- Scroll-to-latest (`»`) button on each chart
- Funding rate + countdown per exchange

## Performance Notes

- **Canvas rendering** for LOB heatmap and trade tape — zero DOM nodes, pure pixel painting via `requestAnimationFrame`
- **Vanilla Zustand store** with selective subscriptions — components only re-render on relevant state changes
- **Binary msgpack** over WebSocket — ~40% smaller payload vs JSON
- **uWebSockets.js** backend — handles 100K+ msg/sec with sub-millisecond latency

## License

MIT
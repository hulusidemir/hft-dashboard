# HFT Dashboard

High-frequency crypto market dashboard monorepo.

This repository consists of two main parts:

- `backend/`: Real-time data ingestion, aggregation, and streaming layer
- `frontend/`: React + Vite-based visualization and dashboard interface

## Architecture

- The backend ingests market stream data from Binance, Bybit, and OKX.
- The aggregator layer transforms order book, trade, liquidation, and open interest data into a unified format.
- Data is published to the frontend via binary msgpack messages over uWebSockets.js.
- The frontend renders these streams in chart and panel components.

## Folder Structure

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

## Quick Start

### 1) Backend

```bash
cd backend
npm install
npm run dev
```

Default backend port: `9000`

### 2) Frontend

In a new terminal:

```bash
cd frontend
npm install
npm run dev
```

## Scripts Overview

### Backend (`backend/package.json`)

- `npm run dev`: Development mode with TSX watch
- `npm run build`: TypeScript build
- `npm start`: Run compiled output
- `npm run typecheck`: Type checking

### Frontend (`frontend/package.json`)

- `npm run dev`: Vite development server
- `npm run build`: TS + Vite production build
- `npm run preview`: Preview production build
- `npm run lint`: ESLint check

## Environment Variables

- Backend: `WS_PORT` (optional)

Example:

```bash
WS_PORT=9100 npm run dev
```
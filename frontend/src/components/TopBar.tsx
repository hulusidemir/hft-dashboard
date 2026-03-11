// ─────────────────────────────────────────────────────────────────────────────
// components/TopBar.tsx — Aranabilir Sembol Seçici (Searchable Dropdown)
// Bybit Linear USDT Perp sembollerini listeler, seçim yapıldığında
// backend'e change_symbol mesajı gönderir ve store'u sıfırlar.
// ─────────────────────────────────────────────────────────────────────────────

import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { useMarketStore, changeSymbol, toggleAlarm, setActiveView } from '../stores/marketStore';
import { audioManager } from '../utils/audioManager';

// ── Sabitler ─────────────────────────────────────────────────────────────────
const MAX_VISIBLE_ITEMS = 12;

// ── SymbolSelector Bileşeni ─────────────────────────────────────────────────
export default function TopBar() {
  const currentSymbol    = useMarketStore((s) => s.currentSymbol);
  const symbolList       = useMarketStore((s) => s.symbolList);
  const isChanging       = useMarketStore((s) => s.isChangingSymbol);
  const isAlarmEnabled   = useMarketStore((s) => s.isAlarmEnabled);
  const activeView        = useMarketStore((s) => s.activeView);

  const [isOpen, setIsOpen]       = useState(false);
  const [search, setSearch]       = useState('');
  const [focusIdx, setFocusIdx]   = useState(0);

  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef     = useRef<HTMLInputElement>(null);
  const listRef      = useRef<HTMLDivElement>(null);

  // ── Filtrelenmiş liste ──────────────────────────────────────────────────
  const filtered = useMemo(() => {
    if (!search.trim()) return symbolList;
    const q = search.toUpperCase().trim();
    return symbolList.filter((s) => s.includes(q));
  }, [symbolList, search]);

  // ── Dış tıklama ile kapat ───────────────────────────────────────────────
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // ── Açıldığında input'a focus ──────────────────────────────────────────
  useEffect(() => {
    if (isOpen && inputRef.current) {
      inputRef.current.focus();
      setSearch('');
      setFocusIdx(0);
    }
  }, [isOpen]);

  // ── Seçim ──────────────────────────────────────────────────────────────
  const handleSelect = useCallback((symbol: string) => {
    setIsOpen(false);
    setSearch('');
    if (symbol !== currentSymbol) {
      changeSymbol(symbol);
    }
  }, [currentSymbol]);

  // ── Klavye navigasyonu ─────────────────────────────────────────────────
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setFocusIdx((prev) => Math.min(prev + 1, filtered.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setFocusIdx((prev) => Math.max(prev - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (filtered[focusIdx]) {
        handleSelect(filtered[focusIdx]);
      }
    } else if (e.key === 'Escape') {
      setIsOpen(false);
    }
  }, [filtered, focusIdx, handleSelect]);

  // ── Scroll focused item into view ──────────────────────────────────────
  useEffect(() => {
    if (!listRef.current) return;
    const item = listRef.current.children[focusIdx] as HTMLElement | undefined;
    item?.scrollIntoView({ block: 'nearest' });
  }, [focusIdx]);

  // Sembol adından base coin'i çıkar (BTCUSDT → BTC)
  const baseCoin = currentSymbol.replace(/USDT$/i, '');

  // ── Alarm Toggle Handler ────────────────────────────────────────────────
  const handleAlarmToggle = useCallback(() => {
    audioManager.init(); // İlk tıklamada tarayıcı ses kilidini aç
    toggleAlarm();
  }, []);

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>

    {/* ── View Tabs ────────────────────────────────────────────────── */}
    <div style={{ display: 'flex', gap: 2 }}>
      <button
        onClick={() => setActiveView('dashboard')}
        style={{
          background: activeView === 'dashboard' ? '#1a0f00' : 'transparent',
          border: `1px solid ${activeView === 'dashboard' ? '#ff9900' : '#333'}`,
          borderRadius: 3,
          padding: '2px 8px',
          height: 20,
          cursor: 'pointer',
          fontFamily: 'monospace',
          fontSize: 9,
          fontWeight: 700,
          letterSpacing: 1,
          color: activeView === 'dashboard' ? '#ff9900' : '#555',
          transition: 'all 0.15s',
        }}
      >
        DASHBOARD
      </button>
      <button
        onClick={() => setActiveView('radar')}
        style={{
          background: activeView === 'radar' ? '#1a0f00' : 'transparent',
          border: `1px solid ${activeView === 'radar' ? '#ff9900' : '#333'}`,
          borderRadius: 3,
          padding: '2px 8px',
          height: 20,
          cursor: 'pointer',
          fontFamily: 'monospace',
          fontSize: 9,
          fontWeight: 700,
          letterSpacing: 1,
          color: activeView === 'radar' ? '#ff9900' : '#555',
          transition: 'all 0.15s',
        }}
      >
        RADAR
      </button>
      <button
        onClick={() => setActiveView('mr')}
        style={{
          background: activeView === 'mr' ? '#1a0f00' : 'transparent',
          border: `1px solid ${activeView === 'mr' ? '#ff9900' : '#333'}`,
          borderRadius: 3,
          padding: '2px 8px',
          height: 20,
          cursor: 'pointer',
          fontFamily: 'monospace',
          fontSize: 9,
          fontWeight: 700,
          letterSpacing: 1,
          color: activeView === 'mr' ? '#ff9900' : '#555',
          transition: 'all 0.15s',
        }}
      >
        COIN MR
      </button>
      <button
        onClick={() => setActiveView('exchanges')}
        style={{
          background: activeView === 'exchanges' ? '#1a0f00' : 'transparent',
          border: `1px solid ${activeView === 'exchanges' ? '#ff9900' : '#333'}`,
          borderRadius: 3,
          padding: '2px 8px',
          height: 20,
          cursor: 'pointer',
          fontFamily: 'monospace',
          fontSize: 9,
          fontWeight: 700,
          letterSpacing: 1,
          color: activeView === 'exchanges' ? '#ff9900' : '#555',
          transition: 'all 0.15s',
        }}
      >
        BORSALAR
      </button>
    </div>
    <div ref={containerRef} style={{ position: 'relative', userSelect: 'none' }}>
      {/* ── Trigger Button ─────────────────────────────────────────────── */}
      <button
        onClick={() => setIsOpen(!isOpen)}
        disabled={isChanging}
        style={{
          background: isOpen ? '#1a1a2e' : '#0e0e1a',
          border: '1px solid #2a2a3e',
          borderRadius: 4,
          padding: '3px 10px',
          color: isChanging ? '#666' : '#ff9900',
          fontWeight: 700,
          fontSize: 11,
          fontFamily: 'monospace',
          cursor: isChanging ? 'wait' : 'pointer',
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          height: 22,
          letterSpacing: 0.5,
          transition: 'background 0.15s, border-color 0.15s',
        }}
      >
        {isChanging ? (
          <span style={{ color: '#ff9900', animation: 'blink 0.6s infinite' }}>
            ⟳ Switching...
          </span>
        ) : (
          <>
            <span style={{ color: '#ff9900' }}>{baseCoin}</span>
            <span style={{ color: '#555' }}>/</span>
            <span style={{ color: '#888' }}>USDT</span>
            <span style={{ color: '#444', fontSize: 8, marginLeft: 2 }}>
              {isOpen ? '▲' : '▼'}
            </span>
          </>
        )}
      </button>

      {/* ── Dropdown Panel ─────────────────────────────────────────────── */}
      {isOpen && (
        <div
          style={{
            position: 'absolute',
            top: '100%',
            left: 0,
            marginTop: 4,
            width: 220,
            maxHeight: 340,
            background: '#0c0c18',
            border: '1px solid #2a2a3e',
            borderRadius: 6,
            boxShadow: '0 8px 32px rgba(0,0,0,0.8)',
            zIndex: 1000,
            overflow: 'hidden',
            display: 'flex',
            flexDirection: 'column',
          }}
        >
          {/* ── Arama Kutusu ────────────────────────────────────────────── */}
          <div style={{ padding: '6px 8px', borderBottom: '1px solid #1a1a2e' }}>
            <input
              ref={inputRef}
              type="text"
              placeholder="Search symbol..."
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setFocusIdx(0);
              }}
              onKeyDown={handleKeyDown}
              style={{
                width: '100%',
                background: '#111122',
                border: '1px solid #2a2a3e',
                borderRadius: 3,
                padding: '5px 8px',
                color: '#ddd',
                fontSize: 11,
                fontFamily: 'monospace',
                outline: 'none',
                boxSizing: 'border-box',
              }}
            />
            <div style={{
              fontSize: 9,
              color: '#444',
              marginTop: 3,
              textAlign: 'right',
            }}>
              {filtered.length} / {symbolList.length} symbols
            </div>
          </div>

          {/* ── Sembol Listesi ──────────────────────────────────────────── */}
          <div
            ref={listRef}
            style={{
              flex: 1,
              overflowY: 'auto',
              overflowX: 'hidden',
            }}
          >
            {filtered.length === 0 ? (
              <div style={{
                padding: '12px 8px',
                color: '#555',
                fontSize: 10,
                textAlign: 'center',
              }}>
                No matching symbols
              </div>
            ) : (
              filtered.slice(0, MAX_VISIBLE_ITEMS * 3).map((sym, idx) => {
                const isActive = sym === currentSymbol;
                const isFocused = idx === focusIdx;
                const symBase = sym.replace(/USDT$/i, '');

                return (
                  <div
                    key={sym}
                    onClick={() => handleSelect(sym)}
                    onMouseEnter={() => setFocusIdx(idx)}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      padding: '5px 10px',
                      cursor: 'pointer',
                      background: isFocused
                        ? '#1a1a2e'
                        : isActive
                          ? '#0a0a1e'
                          : 'transparent',
                      borderLeft: isActive ? '2px solid #ff9900' : '2px solid transparent',
                      transition: 'background 0.1s',
                    }}
                  >
                    <span style={{
                      fontFamily: 'monospace',
                      fontSize: 11,
                      color: isActive ? '#ff9900' : '#ccc',
                      fontWeight: isActive ? 700 : 400,
                    }}>
                      {symBase}
                      <span style={{ color: '#555' }}>/USDT</span>
                    </span>
                    {isActive && (
                      <span style={{ color: '#ff9900', fontSize: 8 }}>●</span>
                    )}
                  </div>
                );
              })
            )}
          </div>
        </div>
      )}

      {/* ── Blink animation (inline style) ─────────────────────────────── */}
      <style>{`
        @keyframes blink {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.3; }
        }
        @keyframes alarmPulse {
          0%, 100% { box-shadow: 0 0 4px rgba(0,255,100,0.4); }
          50% { box-shadow: 0 0 10px rgba(0,255,100,0.8); }
        }
      `}</style>
    </div>

    {/* ── Alarm Toggle Button ────────────────────────────────────────── */}
    <button
      onClick={handleAlarmToggle}
      style={{
        background: isAlarmEnabled ? '#0a2010' : '#1a1a1a',
        border: `1px solid ${isAlarmEnabled ? '#00ff64' : '#333'}`,
        borderRadius: 4,
        padding: '3px 10px',
        height: 22,
        cursor: 'pointer',
        fontFamily: 'monospace',
        fontSize: 10,
        fontWeight: 700,
        letterSpacing: 0.8,
        color: isAlarmEnabled ? '#00ff64' : '#666',
        transition: 'all 0.2s',
        whiteSpace: 'nowrap',
        animation: isAlarmEnabled ? 'alarmPulse 1.5s ease-in-out infinite' : 'none',
      }}
    >
      {isAlarmEnabled ? '🔔 ALARM: ON' : '🔕 ALARM: OFF'}
    </button>
    </div>
  );
}

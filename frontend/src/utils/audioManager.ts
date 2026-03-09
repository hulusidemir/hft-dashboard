// ─────────────────────────────────────────────────────────────────────────────
// utils/audioManager.ts — Taktiksel Alarm Sentezleyici Motor (Singleton)
// Web Audio API ile sıfır gecikme, harici ses dosyası yok.
// Tarayıcı politikası gereği init() ilk kullanıcı etkileşiminde çağrılmalı.
// ─────────────────────────────────────────────────────────────────────────────

class AudioManager {
  private ctx: AudioContext | null = null;
  private initialized = false;

  /** Throttle: aynı kategoride ardışık seslerin üst üste binmesini engeller */
  private lastPlayTime: Record<string, number> = {};
  private static readonly THROTTLE_MS = 150;

  // ── Singleton ───────────────────────────────────────────────────────────
  private static instance: AudioManager;
  static getInstance(): AudioManager {
    if (!AudioManager.instance) {
      AudioManager.instance = new AudioManager();
    }
    return AudioManager.instance;
  }

  private constructor() {}

  // ── Init — İlk kullanıcı tıklamasında çağrılır ─────────────────────────
  init(): void {
    if (this.initialized && this.ctx) return;
    try {
      this.ctx = new AudioContext();
      // Bazı tarayıcılar "suspended" durumda başlatır
      if (this.ctx.state === 'suspended') {
        void this.ctx.resume();
      }
      this.initialized = true;
      console.log('[AudioManager] AudioContext başlatıldı');
    } catch (err) {
      console.error('[AudioManager] AudioContext oluşturulamadı:', err);
    }
  }

  /** Ses çalınabilir durumda mı? */
  get ready(): boolean {
    return this.initialized && this.ctx !== null && this.ctx.state === 'running';
  }

  // ── Throttle kontrolü ───────────────────────────────────────────────────
  private canPlay(category: string): boolean {
    const now = performance.now();
    const last = this.lastPlayTime[category] ?? 0;
    if (now - last < AudioManager.THROTTLE_MS) return false;
    this.lastPlayTime[category] = now;
    return true;
  }

  // ── 🟢 Whale Buy — Yükselen tiz beep (600→800 Hz, 100ms) ──────────────
  playWhaleBuy(): void {
    if (!this.ctx || !this.canPlay('whaleBuy')) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const duration = 0.1; // 100ms

    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = 'sine';
    osc.frequency.setValueAtTime(600, now);
    osc.frequency.linearRampToValueAtTime(800, now + duration);

    gain.gain.setValueAtTime(0.25, now);
    gain.gain.linearRampToValueAtTime(0, now + duration + 0.02);

    osc.connect(gain);
    gain.connect(ctx.destination);

    osc.start(now);
    osc.stop(now + duration + 0.03);
  }

  // ── 🔴 Whale Sell — Düşen tok boop (400→200 Hz, 100ms) ────────────────
  playWhaleSell(): void {
    if (!this.ctx || !this.canPlay('whaleSell')) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const duration = 0.1; // 100ms

    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = 'sine';
    osc.frequency.setValueAtTime(400, now);
    osc.frequency.linearRampToValueAtTime(200, now + duration);

    gain.gain.setValueAtTime(0.3, now);
    gain.gain.linearRampToValueAtTime(0, now + duration + 0.02);

    osc.connect(gain);
    gain.connect(ctx.destination);

    osc.start(now);
    osc.stop(now + duration + 0.03);
  }

  // ── 💥 Liquidation — Agresif sawtooth çift ton uyarısı (200ms) ─────────
  playLiquidation(): void {
    if (!this.ctx || !this.canPlay('liquidation')) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const duration = 0.2; // 200ms

    // Ton 1: Testere dişi 520 Hz — keskin dikkat çekici
    const osc1 = ctx.createOscillator();
    osc1.type = 'sawtooth';
    osc1.frequency.setValueAtTime(520, now);
    osc1.frequency.linearRampToValueAtTime(320, now + duration);

    // Ton 2: Kare dalga 660 Hz — üst harmonik katman
    const osc2 = ctx.createOscillator();
    osc2.type = 'square';
    osc2.frequency.setValueAtTime(660, now);
    osc2.frequency.linearRampToValueAtTime(440, now + duration);

    // Gain envelope — sert başlangıç, hızlı düşüş
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.22, now);
    gain.gain.setValueAtTime(0.22, now + duration * 0.7);
    gain.gain.linearRampToValueAtTime(0, now + duration + 0.02);

    osc1.connect(gain);
    osc2.connect(gain);
    gain.connect(ctx.destination);

    osc1.start(now);
    osc2.start(now);
    osc1.stop(now + duration + 0.03);
    osc2.stop(now + duration + 0.03);
  }
}

// ── Export singleton ────────────────────────────────────────────────────────
export const audioManager = AudioManager.getInstance();

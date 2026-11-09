'use strict';
// Screen effects (confetti, balloons, fireworks, love, celebration, lasers, spotlight, echo) on a
// full-window canvas, plus synthesized send/receive sounds. Loaded before app.js.

const FX = (() => {
  const canvas = document.getElementById('fx');
  const ctx = canvas.getContext('2d');
  const COLORS = ['#ff3b30', '#ff9500', '#ffcc00', '#34c759', '#5ac8fa', '#0a84ff', '#af52de', '#ff2d55'];
  const rand = (a, b) => a + Math.random() * (b - a);
  let W = 0, H = 0, parts = [], scene = null, t0 = 0, raf = 0;

  const LABELS = {
    impact: 'Slam', loud: 'Loud Effect', gentle: 'Gentle Effect', invisibleink: 'Invisible Ink',
    CKConfettiEffect: 'Confetti', CKHappyBirthdayEffect: 'Balloons', CKFireworksEffect: 'Fireworks',
    CKHeartEffect: 'Love', CKShootingStarEffect: 'Celebration', CKSparklesEffect: 'Celebration',
    CKLasersEffect: 'Lasers', CKSpotlightEffect: 'Spotlight', CKEchoEffect: 'Echo',
  };
  const SCREEN = {
    CKConfettiEffect: 'confetti', CKHappyBirthdayEffect: 'balloons', CKFireworksEffect: 'fireworks',
    CKHeartEffect: 'love', CKShootingStarEffect: 'celebration', CKSparklesEffect: 'celebration',
    CKLasersEffect: 'lasers', CKSpotlightEffect: 'spotlight', CKEchoEffect: 'echo',
  };

  function resize() {
    const dpr = window.devicePixelRatio || 1;
    W = window.innerWidth; H = window.innerHeight;
    canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function heart(x, y, s, color) {
    ctx.save(); ctx.translate(x, y); ctx.scale(s / 32, s / 32); ctx.fillStyle = color; ctx.beginPath();
    ctx.moveTo(0, 10); ctx.bezierCurveTo(-26, -6, -14, -26, 0, -12); ctx.bezierCurveTo(14, -26, 26, -6, 0, 10);
    ctx.fill(); ctx.restore();
  }

  function star(x, y, r, color) {
    ctx.fillStyle = color; ctx.beginPath();
    for (let i = 0; i < 8; i++) {
      const a = (Math.PI / 4) * i, rr = i % 2 ? r * 0.35 : r;
      ctx.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr);
    }
    ctx.fill();
  }

  function shade(hex, k = 0.68) {
    const n = parseInt(hex.slice(1), 16);
    const f = c => Math.round(c * k);
    return `rgb(${f(n >> 16)},${f((n >> 8) & 255)},${f(n & 255)})`;
  }

  function burst(x, y, color) {
    for (let i = 0; i < 70; i++) {
      const a = rand(0, Math.PI * 2), v = rand(60, 260);
      parts.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, life: rand(1.1, 1.8), max: 1.8, c: Math.random() < 0.3 ? '#fff' : color });
    }
  }

  const SCENES = {
    confetti: {
      dur: 3800,
      init() {
        for (let i = 0; i < 230; i++) {
          parts.push({ x: rand(0, W), y: rand(-H, -10), vx: rand(-40, 40), vy: rand(130, 270), r: rand(0, 6.3), vr: rand(-7, 7),
            w: rand(6, 11), h: rand(9, 17), c: COLORS[i % COLORS.length], sw: rand(0, 6.3) });
        }
      },
      step(p, dt) { p.sw += dt * 3; p.x += (p.vx + Math.sin(p.sw) * 34) * dt; p.y += p.vy * dt; p.r += p.vr * dt; },
      draw(p) {
        ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.r); ctx.scale(1, Math.cos(p.sw * 1.7));
        ctx.fillStyle = p.c; ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h); ctx.restore();
      },
    },
    balloons: {
      dur: 5600,
      init() {
        for (let i = 0; i < 15; i++) {
          parts.push({ x: rand(50, W - 50), y: H + rand(60, 620), vy: rand(-170, -105), r: rand(36, 56), c: COLORS[i % COLORS.length], sw: rand(0, 6.3) });
        }
      },
      step(p, dt) { p.sw += dt * 1.5; p.y += p.vy * dt; p.x += Math.sin(p.sw) * 20 * dt; },
      draw(p) {
        ctx.strokeStyle = 'rgba(140,140,140,.7)'; ctx.lineWidth = 1.2; ctx.beginPath();
        ctx.moveTo(p.x, p.y + p.r * 1.1);
        ctx.bezierCurveTo(p.x - 12, p.y + p.r * 1.6, p.x + 12, p.y + p.r * 2.1, p.x, p.y + p.r * 2.7); ctx.stroke();
        const g = ctx.createRadialGradient(p.x - p.r * 0.35, p.y - p.r * 0.45, p.r * 0.08, p.x, p.y, p.r * 1.2);
        g.addColorStop(0, 'rgba(255,255,255,.9)'); g.addColorStop(0.22, p.c); g.addColorStop(1, shade(p.c));
        ctx.fillStyle = g; ctx.beginPath(); ctx.ellipse(p.x, p.y, p.r * 0.86, p.r * 1.05, 0, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = shade(p.c, 0.8); ctx.beginPath();
        ctx.moveTo(p.x - 5, p.y + p.r * 1.14); ctx.lineTo(p.x + 5, p.y + p.r * 1.14); ctx.lineTo(p.x, p.y + p.r * 1.02); ctx.fill();
      },
    },
    fireworks: {
      dur: 4600, dim: 0.5,
      init() { this.fired = 0; },
      tick(t) {
        while (this.fired < 7 && t > this.fired * 520) {
          burst(rand(W * 0.15, W * 0.85), rand(H * 0.12, H * 0.5), COLORS[(this.fired * 3) % COLORS.length]);
          this.fired++;
        }
      },
      step(p, dt) { p.vy += 95 * dt; p.vx *= 0.99; p.x += p.vx * dt; p.y += p.vy * dt; p.life -= dt; },
      draw(p) {
        ctx.globalAlpha = Math.max(0, p.life / p.max); ctx.fillStyle = p.c;
        ctx.beginPath(); ctx.arc(p.x, p.y, 2.3, 0, Math.PI * 2); ctx.fill(); ctx.globalAlpha = 1;
      },
    },
    love: {
      dur: 4000,
      init() {
        parts.push({ big: true, x: W / 2, y: H / 2, s: 20, life: 1.9 });
        for (let i = 0; i < 44; i++) {
          parts.push({ x: rand(0, W), y: H + rand(0, 700), vy: rand(-230, -120), s: rand(14, 34), sw: rand(0, 6.3),
            c: ['#ff2d55', '#ff375f', '#ff6482', '#ff3b30'][i % 4] });
        }
      },
      step(p, dt) {
        if (p.big) { p.s += (Math.min(W, H) * 0.34 - p.s) * dt * 2.6; p.life -= dt; return; }
        p.sw += dt * 2; p.y += p.vy * dt; p.x += Math.sin(p.sw) * 26 * dt;
      },
      draw(p) {
        if (p.big) heart(p.x, p.y, p.s, `rgba(255,45,85,${Math.max(0, Math.min(1, p.life)) * 0.9})`);
        else heart(p.x, p.y, p.s, p.c);
      },
    },
    celebration: {
      dur: 3800,
      init() { for (let i = 0; i < 140; i++) parts.push(this.spawn()); },
      spawn() { return { x: W - rand(0, W * 0.25), y: rand(-20, H * 0.25), vx: rand(-320, -90), vy: rand(30, 200), life: rand(0.8, 2.6), max: 2.6, s: rand(2, 5.5) }; },
      step(p, dt, t) {
        p.x += p.vx * dt; p.y += p.vy * dt; p.life -= dt;
        if (p.life <= 0 && t < this.dur - 1300) Object.assign(p, this.spawn());
      },
      draw(p) { star(p.x, p.y, p.s, `rgba(255,214,10,${Math.max(0, p.life / p.max)})`); },
    },
    lasers: {
      dur: 3400, dim: 0.62,
      init() {},
      frame(t) {
        const cx = W / 2, cy = H / 2, n = 10, len = Math.hypot(W, H);
        ctx.globalCompositeOperation = 'lighter';
        for (let i = 0; i < n; i++) {
          const a = t / 900 + (i * Math.PI * 2) / n + Math.sin(t / 700 + i) * 0.25;
          ctx.strokeStyle = COLORS[i % COLORS.length]; ctx.globalAlpha = 0.55; ctx.lineWidth = 3 + 2 * Math.sin(t / 300 + i);
          ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx + Math.cos(a) * len, cy + Math.sin(a) * len); ctx.stroke();
        }
        ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
      },
    },
    spotlight: {
      dur: 3000,
      init(opts) { this.at = opts.rect || { x: W / 2, y: H / 2, r: 140 }; },
      frame(t) {
        const k = Math.min(1, t / 400) * Math.min(1, (this.dur - t) / 500);
        const { x, y, r } = this.at;
        const g = ctx.createRadialGradient(x, y, r * 0.8, x, y, r * 1.8);
        g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(1, `rgba(0,0,0,${0.78 * k})`);
        ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
      },
    },
    echo: {
      dur: 3400,
      init(opts) {
        this.text = (opts.text || '').slice(0, 60);
        for (let i = 0; i < 26; i++) {
          parts.push({ x: rand(-W * 0.2, W * 0.9), y: rand(0, H), vx: rand(60, 200), s: rand(13, 26), a: rand(0.3, 0.9), c: COLORS[i % COLORS.length] });
        }
      },
      step(p, dt) { p.x += p.vx * dt; },
      draw(p) {
        ctx.font = `600 ${p.s}px Inter, Segoe UI, sans-serif`;
        ctx.globalAlpha = p.a; ctx.fillStyle = p.c; ctx.fillText(this.text, p.x, p.y); ctx.globalAlpha = 1;
      },
    },
  };

  function loop(now) {
    const t = now - t0;
    const s = scene;
    ctx.clearRect(0, 0, W, H);
    if (!s || t > s.dur) { stop(); return; }
    if (s.dim) {
      const k = Math.min(1, t / 350) * Math.min(1, (s.dur - t) / 600);
      ctx.fillStyle = `rgba(0,0,0,${s.dim * k})`; ctx.fillRect(0, 0, W, H);
    }
    if (s.tick) s.tick(t);
    if (s.frame) s.frame(t);
    const dt = Math.min(0.05, (now - (loop.last || now)) / 1000);
    loop.last = now;
    if (s.step) {
      for (const p of parts) { s.step(p, dt, t); s.draw(p); }
      parts = parts.filter(p => p.life === undefined || p.life > 0 || p.big);
    }
    raf = requestAnimationFrame(loop);
  }

  function stop() {
    cancelAnimationFrame(raf);
    raf = 0; scene = null; parts = [];
    ctx.clearRect(0, 0, W, H);
  }

  function play(effect, opts = {}) {
    const name = SCREEN[effect] || effect;
    const s = SCENES[name];
    if (!s) return false;
    stop();
    resize();
    scene = s;
    s.init.call(s, opts);
    t0 = performance.now();
    loop.last = t0;
    raf = requestAnimationFrame(loop);
    return true;
  }

  window.addEventListener('resize', () => { if (scene) resize(); });
  return {
    play,
    label: effect => LABELS[effect] || null,
    isScreen: effect => !!SCREEN[effect],
    isBubble: effect => ['impact', 'loud', 'gentle', 'invisibleink'].includes(effect),
  };
})();

// Short synthesized cues; not Apple's sounds, just the same idea.
const Sound = (() => {
  let ac = null;
  const audio = () => (ac = ac || new (window.AudioContext || window.webkitAudioContext)());

  function send() {
    const a = audio(), t = a.currentTime;
    const len = 0.28, buf = a.createBuffer(1, Math.ceil(a.sampleRate * len), a.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / d.length);
    const src = a.createBufferSource(); src.buffer = buf;
    const bp = a.createBiquadFilter(); bp.type = 'bandpass'; bp.Q.value = 1.4;
    bp.frequency.setValueAtTime(500, t); bp.frequency.exponentialRampToValueAtTime(3400, t + 0.22);
    const g = a.createGain(); g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.22, t + 0.03); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.27);
    src.connect(bp).connect(g).connect(a.destination); src.start(t); src.stop(t + len);
  }

  // Tri-tone style: three quick rising mallet notes. Each note is a sine plus a bar-like
  // inharmonic partial (2.76x) that dies fast, which gives the glassy marimba attack.
  function receive() {
    const a = audio();
    if (a.state === 'suspended') a.resume();
    const t = a.currentTime + 0.02;
    const out = a.createGain(); out.gain.value = 0.9; out.connect(a.destination);
    [[1318.5, 0], [1661.2, 0.115], [1975.5, 0.23]].forEach(([f, dt]) => {
      [[1, 0.22, 0.42], [2.76, 0.07, 0.09], [4, 0.025, 0.05]].forEach(([mul, peak, decay]) => {
        const o = a.createOscillator(); o.type = 'sine'; o.frequency.value = f * mul;
        const g = a.createGain();
        g.gain.setValueAtTime(0.0001, t + dt);
        g.gain.exponentialRampToValueAtTime(peak, t + dt + 0.006);
        g.gain.exponentialRampToValueAtTime(0.0001, t + dt + decay);
        o.connect(g).connect(out); o.start(t + dt); o.stop(t + dt + decay + 0.02);
      });
    });
  }

  const safe = fn => () => { try { fn(); } catch { /* audio unavailable */ } };
  return { send: safe(send), receive: safe(receive) };
})();

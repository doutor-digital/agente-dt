import { useEffect, useRef, type CSSProperties } from 'react';

const PARTICLES = 520;
const MAX_DPR = 2;
const TRAIL_FADE = 0.019;
const ACCENT_SHARE = 0.12;
const LIFE_MIN = 120;
const LIFE_MAX = 320;
const FIELD_SCALE = 0.0030;
const ALPHA_BUCKETS = 5;

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.trim().replace('#', '');
  const full =
    h.length === 3
      ? h
          .split('')
          .map((c) => c + c)
          .join('')
      : h;
  const n = Number.parseInt(full, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

interface Particle {
  x: number;
  y: number;
  speed: number;
  life: number;
  maxLife: number;
  accent: boolean;
}

export function LatentField({
  className,
  style,
}: {
  className?: string;
  style?: CSSProperties;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const cs = getComputedStyle(canvas);
    const readVar = (name: string, fallback: string) =>
      hexToRgb(cs.getPropertyValue(name).trim() || fallback);
    const ACCENT = readVar('--b-400', '#2ee68e');
    const DIM = readVar('--z-300', '#adb1b6');

    const rand = mulberry32(0x9e37);
    let w = 0;
    let h = 0;
    let dpr = 1;

    const particles: Particle[] = [];

    const spawn = (p: Particle) => {
      p.x = rand() * w;
      p.y = rand() * h;
      p.life = 0;
      p.maxLife = LIFE_MIN + rand() * (LIFE_MAX - LIFE_MIN);
      p.speed = 0.85 + rand() * 1.9;
      p.accent = rand() < ACCENT_SHARE;
    };

    const resize = () => {
      const r = canvas.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return;
      dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
      w = r.width;
      h = r.height;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      for (const p of particles) {
        if (p.x > w || p.y > h) spawn(p);
      }
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);

    for (let i = 0; i < PARTICLES; i++) {
      const p: Particle = { x: 0, y: 0, speed: 1, life: 0, maxLife: 1, accent: false };
      spawn(p);
      p.life = rand() * p.maxLife;
      particles.push(p);
    }

    function angleAt(x: number, y: number, t: number): number {
      const sx = x * FIELD_SCALE;
      const sy = y * FIELD_SCALE;
      return (
        Math.sin(sx + t * 0.42) * 1.6 +
        Math.cos(sy * 1.3 - t * 0.31) * 1.4 +
        Math.sin((sx + sy) * 0.7 + t * 0.19) * 1.1
      );
    }

    const lanes = Array.from({ length: ALPHA_BUCKETS * 2 }, () => ({
      path: new Path2D(),
      n: 0,
    }));

    let time = 0;

    function step(dt: number) {
      if (w === 0 || h === 0) return;
      const f = dt / 16.67;
      time += dt * 0.00028;

      ctx!.globalCompositeOperation = 'destination-out';
      ctx!.fillStyle = `rgba(0,0,0,${TRAIL_FADE * f})`;
      ctx!.fillRect(0, 0, w, h);
      ctx!.globalCompositeOperation = 'source-over';

      for (const lane of lanes) lane.n = 0;
      for (const p of particles) {
        const a = angleAt(p.x, p.y, time);
        const nx = p.x + Math.cos(a) * p.speed * f;
        const ny = p.y + Math.sin(a) * p.speed * f;

        const age = p.life / p.maxLife;
        const fade = Math.sin(age * Math.PI);

        if (fade > 0.02) {
          const bi = Math.min(ALPHA_BUCKETS - 1, (fade * ALPHA_BUCKETS) | 0);
          const lane = lanes[(p.accent ? ALPHA_BUCKETS : 0) + bi];
          if (lane.n === 0) lane.path = new Path2D();
          lane.path.moveTo(p.x, p.y);
          lane.path.lineTo(nx, ny);
          lane.n++;
        }

        p.x = nx;
        p.y = ny;
        p.life += f;
        if (p.life >= p.maxLife || p.x < -20 || p.x > w + 20 || p.y < -20 || p.y > h + 20) {
          spawn(p);
        }
      }

      ctx!.lineCap = 'round';
      for (let i = 0; i < lanes.length; i++) {
        const lane = lanes[i];
        if (lane.n === 0) continue;
        const accent = i >= ALPHA_BUCKETS;
        const c = accent ? ACCENT : DIM;
        const fade = ((i % ALPHA_BUCKETS) + 0.6) / ALPHA_BUCKETS;
        ctx!.strokeStyle = `rgba(${c[0]},${c[1]},${c[2]},${(accent ? 0.8 : 0.34) * fade})`;
        ctx!.lineWidth = accent ? 1.5 : 1;
        ctx!.stroke(lane.path);
      }
    }

    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduced) {
      for (let i = 0; i < 260; i++) step(16.67);
      return () => ro.disconnect();
    }

    let raf = 0;
    let last = performance.now();
    const loop = (t: number) => {
      const dt = Math.min(t - last, 48);
      last = t;
      step(dt);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);

    const onVisibility = () => {
      cancelAnimationFrame(raf);
      if (!document.hidden) {
        last = performance.now();
        raf = requestAnimationFrame(loop);
      }
    };
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, []);

  return <canvas ref={canvasRef} className={className} style={style} aria-hidden="true" />;
}

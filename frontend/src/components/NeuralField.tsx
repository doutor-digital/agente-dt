// ============================================================================
// NeuralField — malha neural 3D animada da tela de login.
//
// POR QUE CANVAS 2D E NÃO THREE.JS
// --------------------------------
// O efeito aqui é uma nuvem de pontos com profundidade, arestas por
// proximidade e pacotes viajando. Isso é projeção em perspectiva + desenho de
// linha: ~3KB de código. O three.js resolveria o mesmo por ~150KB gzipped
// entrando na PRIMEIRA tela que o usuário carrega. Só vale a pena quando a
// cena precisa de malha real, luz, sombra ou shader (bloom, depth of field) —
// aí sim, e entrando por lazy-load.
//
// COMO FUNCIONA
// -------------
// Nós vivem num cubo normalizado [-1,1]³ e derivam devagar. A cada frame o
// campo gira em Y (e oscila em X), projeta em perspectiva (k = f/(f+z)) e
// desenha:
//   - arestas entre pares próximos, com alpha por proximidade E profundidade
//   - pacotes de sinal percorrendo pares conectados, no verde da marca
//   - nós, com raio e brilho pela profundidade; alguns "acesos" com halo
//
// O ponteiro inclina a câmera de leve (paralaxe) — dá volume sem exigir
// interação nenhuma de quem só quer logar.
//
// CUSTO: 88 nós → ~7.7k testes de distância por frame. Trivial. A malha pausa
// com a aba em segundo plano e vira UM frame estático em prefers-reduced-
// motion, então nunca é o que esquenta o notebook de ninguém.
// ============================================================================

import { useEffect, useRef, type CSSProperties } from 'react';

const NODE_COUNT = 124;
const LINK_DIST = 0.5; // distância máxima (espaço normalizado) pra ligar dois nós
const FOCAL = 2.7; // distância focal da projeção
const MAX_DPR = 2; // acima disso o ganho é invisível e o custo, real
const PACKETS = 14;
const HOT_EVERY = 15; // 1 nó aceso a cada N
const EDGE_MAX_ALPHA = 0.72;
/** Faixas de alpha das arestas — ver o laço de desenho. */
const ALPHA_BUCKETS = 6;

/** PRNG com semente — layout reproduzível entre recargas e em review. */
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

/** "#2ee68e" → [46, 230, 142]. Aceita a forma curta também. */
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

interface Node {
  x: number;
  y: number;
  z: number;
  dx: number;
  dy: number;
  dz: number;
  hot: boolean;
  /** Fase do halo, pra os nós acesos não respirarem em uníssono. */
  phase: number;
  // Preenchidos a cada frame pela projeção.
  px: number;
  py: number;
  k: number;
}

interface Packet {
  from: number;
  to: number;
  t: number;
  speed: number;
}

export function NeuralField({
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

    // Cores vêm do tema (var(--b-400) / var(--z-*)), então o desenho acompanha
    // se o acento mudar. Fallback pros valores atuais se a var não resolver.
    const cs = getComputedStyle(canvas);
    const readVar = (name: string, fallback: string) =>
      hexToRgb(cs.getPropertyValue(name).trim() || fallback);
    const ACCENT = readVar('--b-400', '#2ee68e');
    const EDGE = readVar('--z-400', '#82878e');
    const NODE = readVar('--z-300', '#adb1b6');
    const rgba = (c: [number, number, number], a: number) =>
      `rgba(${c[0]},${c[1]},${c[2]},${a})`;

    const rand = mulberry32(0x51f7);
    const nodes: Node[] = Array.from({ length: NODE_COUNT }, (_, i) => ({
      // Distribuição achatada em Y: a coluna é alta e estreita, uma esfera
      // perfeita desperdiçaria o topo e a base.
      x: rand() * 2 - 1,
      y: (rand() * 2 - 1) * 0.82,
      z: rand() * 2 - 1,
      dx: (rand() - 0.5) * 0.00042,
      dy: (rand() - 0.5) * 0.00042,
      dz: (rand() - 0.5) * 0.00042,
      hot: i % HOT_EVERY === 0,
      phase: rand() * Math.PI * 2,
      px: 0,
      py: 0,
      k: 1,
    }));

    const packets: Packet[] = Array.from({ length: PACKETS }, () => ({
      from: Math.floor(rand() * NODE_COUNT),
      to: Math.floor(rand() * NODE_COUNT),
      t: rand(),
      speed: 0.0022 + rand() * 0.004,
    }));

    let w = 0;
    let h = 0;
    let dpr = 1;
    const resize = () => {
      const r = canvas.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return;
      dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
      w = r.width;
      h = r.height;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);

    // Paralaxe: alvo move com o ponteiro, valor real persegue com atraso —
    // sem o easing o movimento fica nervoso.
    let targetTiltX = 0;
    let targetTiltY = 0;
    let tiltX = 0;
    let tiltY = 0;
    const onPointer = (e: PointerEvent) => {
      targetTiltY = (e.clientX / window.innerWidth - 0.5) * 0.5;
      targetTiltX = (e.clientY / window.innerHeight - 0.5) * 0.28;
    };

    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (!reduced) window.addEventListener('pointermove', onPointer, { passive: true });

    // Reusadas a cada frame (ver o laço de arestas).
    const buckets = Array.from({ length: ALPHA_BUCKETS }, () => ({
      path: new Path2D(),
      n: 0,
    }));

    let spin = 0;
    let raf = 0;

    function frame(dt: number) {
      ctx!.clearRect(0, 0, w, h);
      if (w === 0 || h === 0) return;

      spin += dt * 0.000055;
      tiltX += (targetTiltX - tiltX) * 0.045;
      tiltY += (targetTiltY - tiltY) * 0.045;

      const ay = spin + tiltY;
      const ax = Math.sin(spin * 1.7) * 0.13 + tiltX;
      const cosY = Math.cos(ay);
      const sinY = Math.sin(ay);
      const cosX = Math.cos(ax);
      const sinX = Math.sin(ax);

      const cx = w / 2;
      const cy = h / 2;
      const spreadX = w * 0.52;
      const spreadY = h * 0.46;

      // ── Projeção ────────────────────────────────────────────────────────
      for (const n of nodes) {
        n.x += n.dx * dt;
        n.y += n.dy * dt;
        n.z += n.dz * dt;
        // Rebate nas paredes do cubo pra nuvem não se dissolver com o tempo.
        if (n.x < -1 || n.x > 1) n.dx *= -1;
        if (n.y < -0.85 || n.y > 0.85) n.dy *= -1;
        if (n.z < -1 || n.z > 1) n.dz *= -1;

        const x1 = n.x * cosY - n.z * sinY;
        const z1 = n.x * sinY + n.z * cosY;
        const y1 = n.y * cosX - z1 * sinX;
        const z2 = n.y * sinX + z1 * cosX;

        n.k = FOCAL / (FOCAL + z2);
        n.px = cx + x1 * n.k * spreadX;
        n.py = cy + y1 * n.k * spreadY;
      }

      // ── Arestas por proximidade ─────────────────────────────────────────
      // As arestas vão pra FAIXAS de alpha em vez de cada uma virar seu
      // próprio stroke(): ~500 arestas viravam 500 mudanças de estado do
      // contexto por frame. Agrupadas em 6 Path2D, são 6 stroke() — a
      // diferença de cor entre faixas vizinhas é imperceptível, o ganho de
      // CPU não é.
      for (const path of buckets) path.n = 0;
      for (let i = 0; i < NODE_COUNT; i++) {
        const a = nodes[i];
        for (let j = i + 1; j < NODE_COUNT; j++) {
          const b = nodes[j];
          const dx = a.x - b.x;
          const dy = a.y - b.y;
          const dz = a.z - b.z;
          const d2 = dx * dx + dy * dy + dz * dz;
          if (d2 > LINK_DIST * LINK_DIST) continue;
          const d = Math.sqrt(d2);
          // Alpha cai com a distância (aresta longa some) e com a
          // profundidade (k pequeno = longe = mais apagado).
          const prox = 1 - d / LINK_DIST;
          const depth = (a.k + b.k) * 0.5;
          const alpha = prox * Math.sqrt(prox) * EDGE_MAX_ALPHA * depth;
          if (alpha < 0.015) continue;
          const bi = Math.min(
            ALPHA_BUCKETS - 1,
            (((alpha / EDGE_MAX_ALPHA) * ALPHA_BUCKETS) | 0),
          );
          const slot = buckets[bi];
          if (slot.n === 0) slot.path = new Path2D();
          slot.path.moveTo(a.px, a.py);
          slot.path.lineTo(b.px, b.py);
          slot.n++;
        }
      }
      ctx!.lineWidth = 1;
      for (let b = 0; b < ALPHA_BUCKETS; b++) {
        const slot = buckets[b];
        if (slot.n === 0) continue;
        ctx!.strokeStyle = rgba(EDGE, ((b + 0.6) / ALPHA_BUCKETS) * EDGE_MAX_ALPHA);
        ctx!.stroke(slot.path);
      }

      // ── Nós ─────────────────────────────────────────────────────────────
      const now = performance.now();
      for (const n of nodes) {
        const r = Math.max(0.7, n.k * (n.hot ? 3.1 : 1.9));
        if (n.hot) {
          const breath = 0.5 + 0.5 * Math.sin(now * 0.0013 + n.phase);
          ctx!.fillStyle = rgba(ACCENT, 0.1 * n.k * (0.45 + breath * 0.55));
          ctx!.beginPath();
          ctx!.arc(n.px, n.py, r * (4.5 + breath * 2.2), 0, Math.PI * 2);
          ctx!.fill();
        }
        ctx!.fillStyle = n.hot ? rgba(ACCENT, 0.95 * n.k) : rgba(NODE, 0.66 * n.k);
        ctx!.beginPath();
        ctx!.arc(n.px, n.py, r, 0, Math.PI * 2);
        ctx!.fill();
      }

      // ── Pacotes de sinal ────────────────────────────────────────────────
      for (const p of packets) {
        p.t += p.speed * dt * 0.06;
        if (p.t >= 1) {
          // Reaproveita o destino como origem: o sinal "caminha" pela malha em
          // vez de teleportar, e o olho segue o percurso.
          p.from = p.to;
          p.to = Math.floor(Math.random() * NODE_COUNT);
          p.t = 0;
          p.speed = 0.0022 + Math.random() * 0.004;
        }
        const a = nodes[p.from];
        const b = nodes[p.to];
        const k = a.k + (b.k - a.k) * p.t;
        const x = a.px + (b.px - a.px) * p.t;
        const y = a.py + (b.py - a.py) * p.t;
        // Some nas pontas do percurso: entra e sai sem "pop".
        const fade = Math.sin(p.t * Math.PI);

        const trail = ctx!.createLinearGradient(a.px, a.py, x, y);
        trail.addColorStop(0, rgba(ACCENT, 0));
        trail.addColorStop(1, rgba(ACCENT, 0.4 * fade * k));
        ctx!.strokeStyle = trail;
        ctx!.lineWidth = 1.4 * k;
        ctx!.beginPath();
        ctx!.moveTo(a.px, a.py);
        ctx!.lineTo(x, y);
        ctx!.stroke();

        ctx!.fillStyle = rgba(ACCENT, 0.16 * fade * k);
        ctx!.beginPath();
        ctx!.arc(x, y, 7 * k, 0, Math.PI * 2);
        ctx!.fill();
        ctx!.fillStyle = rgba(ACCENT, 0.95 * fade);
        ctx!.beginPath();
        ctx!.arc(x, y, 2.1 * k, 0, Math.PI * 2);
        ctx!.fill();
      }
    }

    // Movimento é decoração: quem pediu menos movimento recebe um frame só.
    if (reduced) {
      frame(0);
      return () => ro.disconnect();
    }

    let last = performance.now();
    const loop = (t: number) => {
      // Clamp do delta: voltar pra aba depois de 5min não pode teleportar a
      // simulação (dt gigante faria os nós atravessarem as paredes do cubo).
      const dt = Math.min(t - last, 48);
      last = t;
      frame(dt);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);

    // Aba escondida não desenha — nada de queimar bateria em background.
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
      window.removeEventListener('pointermove', onPointer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, []);

  return <canvas ref={canvasRef} className={className} style={style} aria-hidden="true" />;
}

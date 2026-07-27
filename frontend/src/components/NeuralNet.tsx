// ============================================================================
// NeuralNet — ilustração da tela de login: um grafo de rede neural com pulsos
// percorrendo as conexões.
//
// Por que SVG inline e não uma imagem:
//   - zero requisição de rede (a de antes baixava 2000px de stock)
//   - nítida em qualquer densidade de tela, sem @2x/@3x
//   - lê as cores do tema (var(--b-*) / var(--z-*)), então nunca "descola" da
//     identidade se o acento mudar
//
// A geometria é FIXA e escrita à mão (nada de Math.random): o mesmo desenho em
// todo render, sem cintilar entre montagens. As arestas são declaradas por
// adjacência explícita — uma malha esparsa lê melhor que all-to-all, que vira
// borrão cinza.
// ============================================================================

import type { CSSProperties } from 'react';

const VIEW_W = 640;
const VIEW_H = 460;

/** Camadas do grafo: x da coluna + y de cada nó. */
const LAYERS: { x: number; ys: number[] }[] = [
  { x: 70, ys: [150, 230, 310] },
  { x: 230, ys: [70, 150, 230, 310, 390] },
  { x: 390, ys: [70, 150, 230, 310, 390] },
  { x: 550, ys: [190, 270] },
];

/** Adjacência por vão: para cada nó da camada N, os índices na camada N+1. */
const EDGES: number[][][] = [
  [[0, 1, 2], [1, 2, 3], [2, 3, 4]],
  [[0, 1], [0, 1, 2], [1, 2, 3], [2, 3, 4], [3, 4]],
  [[0], [0], [0, 1], [1], [1]],
];

/**
 * Arestas que ganham um pulso animado. Escolhidas a dedo para formarem dois
 * caminhos que atravessam o grafo inteiro — o olho segue o percurso em vez de
 * ver piscadas soltas. [vão, índiceOrigem, índiceDestino, atrasoEmSegundos]
 */
const PULSES: [number, number, number, number][] = [
  [0, 0, 1, 0],
  [1, 1, 2, 0.55],
  [2, 2, 0, 1.1],
  [0, 2, 3, 1.6],
  [1, 3, 4, 2.15],
  [2, 4, 1, 2.7],
];

/** Nós com halo — os "ativos". [camada, índice] */
const HOT_NODES: [number, number][] = [
  [0, 1],
  [1, 2],
  [2, 0],
  [3, 0],
];

function isHot(layer: number, index: number): boolean {
  return HOT_NODES.some(([l, i]) => l === layer && i === index);
}

export function NeuralNet({
  className,
  style,
}: {
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <svg
      viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
      className={className}
      style={style}
      fill="none"
      aria-hidden="true"
      role="presentation"
    >
      <defs>
        {/* Halo difuso atrás do miolo do grafo — dá profundidade sem peso. */}
        <radialGradient id="nn-glow" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="var(--b-500)" stopOpacity="0.18" />
          <stop offset="100%" stopColor="var(--b-500)" stopOpacity="0" />
        </radialGradient>

        {/* As arestas escurecem nas pontas: o grafo "nasce" e "morre" no fundo
            em vez de terminar num corte seco. */}
        <linearGradient id="nn-edge" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor="var(--z-600)" stopOpacity="0.12" />
          <stop offset="50%" stopColor="var(--z-400)" stopOpacity="0.75" />
          <stop offset="100%" stopColor="var(--z-600)" stopOpacity="0.12" />
        </linearGradient>
      </defs>

      <ellipse cx={VIEW_W / 2} cy={VIEW_H / 2} rx={280} ry={210} fill="url(#nn-glow)" />

      {/* ── Arestas ─────────────────────────────────────────────────────── */}
      <g stroke="url(#nn-edge)" strokeWidth="1">
        {EDGES.map((gap, gi) =>
          gap.map((targets, si) =>
            targets.map((ti) => (
              <line
                key={`e-${gi}-${si}-${ti}`}
                x1={LAYERS[gi].x}
                y1={LAYERS[gi].ys[si]}
                x2={LAYERS[gi + 1].x}
                y2={LAYERS[gi + 1].ys[ti]}
              />
            )),
          ),
        )}
      </g>

      {/* ── Pulsos ──────────────────────────────────────────────────────────
          `pathLength="240"` normaliza o comprimento de TODAS as arestas, então
          um único stroke-dasharray produz um pulso do mesmo tamanho em linhas
          de comprimentos diferentes. */}
      <g stroke="var(--b-400)" strokeWidth="2" strokeLinecap="round">
        {PULSES.map(([gi, si, ti, delay]) => (
          <line
            key={`p-${gi}-${si}-${ti}`}
            className="neural-pulse"
            pathLength={240}
            x1={LAYERS[gi].x}
            y1={LAYERS[gi].ys[si]}
            x2={LAYERS[gi + 1].x}
            y2={LAYERS[gi + 1].ys[ti]}
            style={{ animationDelay: `${delay}s` }}
          />
        ))}
      </g>

      {/* ── Nós ─────────────────────────────────────────────────────────── */}
      {LAYERS.map((layer, li) =>
        layer.ys.map((y, ni) => {
          const hot = isHot(li, ni);
          const edge = li === 0 || li === LAYERS.length - 1;
          return (
            <g key={`n-${li}-${ni}`}>
              {hot && (
                <circle
                  className="neural-halo"
                  cx={layer.x}
                  cy={y}
                  r={14}
                  fill="var(--b-400)"
                  opacity={0.18}
                  style={{ animationDelay: `${li * 0.4}s` }}
                />
              )}
              <circle
                cx={layer.x}
                cy={y}
                r={edge ? 6 : 4.5}
                fill={hot ? 'var(--b-400)' : 'var(--z-950)'}
                stroke={hot ? 'var(--b-400)' : 'var(--z-500)'}
                strokeWidth="1.25"
              />
            </g>
          );
        }),
      )}
    </svg>
  );
}

/**
 * O funil como fita que afina — do primeiro "oi" até o tratamento fechado.
 *
 * Por que não é gráfico de barras: a queda aqui é brutal (376 → 2) e barra some.
 * A fita mostra o estrangulamento como FORMA, e a taxa entre um passo e outro
 * aparece embaixo — que é o número que o dono da clínica procura.
 *
 * Escala: espessura ∝ valor^0.45. Proporcional puro deixaria os três últimos
 * passos invisíveis; raiz simples achata demais e faz o desastre parecer estável.
 * O número real está sempre escrito, então a suavização não engana ninguém.
 */
export interface PassoFunil {
  rotulo: string;
  valor: number;
  bom?: boolean;
}

const ALTURA = 132;
const GROSSURA_MAX = 104;
const GROSSURA_MIN = 5;

function grossura(v: number, topo: number): number {
  if (topo <= 0 || v <= 0) return GROSSURA_MIN;
  return Math.max(GROSSURA_MIN, GROSSURA_MAX * Math.pow(v / topo, 0.45));
}

export function Funil({ passos }: { passos: PassoFunil[] }) {
  const topo = Math.max(...passos.map((p) => p.valor), 1);
  const largura = 1000;
  const passoX = largura / (passos.length - 1 || 1);
  const meio = ALTURA / 2;

  const pontos = passos.map((p, i) => ({ x: i * passoX, r: grossura(p.valor, topo) / 2 }));

  // curva suave: cada tramo vira uma cúbica com controles no meio do caminho
  const cima = pontos
    .map((pt, i) => {
      if (i === 0) return `M${pt.x},${meio - pt.r}`;
      const ant = pontos[i - 1];
      const cx = (ant.x + pt.x) / 2;
      return `C${cx},${meio - ant.r} ${cx},${meio - pt.r} ${pt.x},${meio - pt.r}`;
    })
    .join(' ');
  const baixo = [...pontos]
    .reverse()
    .map((pt, i, arr) => {
      if (i === 0) return `L${pt.x},${meio + pt.r}`;
      const ant = arr[i - 1];
      const cx = (ant.x + pt.x) / 2;
      return `C${cx},${meio + ant.r} ${cx},${meio + pt.r} ${pt.x},${meio + pt.r}`;
    })
    .join(' ');

  return (
    <div>
      <svg
        viewBox={`0 0 ${largura} ${ALTURA}`}
        className="h-[132px] w-full"
        preserveAspectRatio="none"
        aria-hidden="true"
      >
        <defs>
          <linearGradient id="fita" x1="0" x2="1">
            <stop offset="0" stopColor="var(--vida)" stopOpacity=".9" />
            <stop offset="0.55" stopColor="var(--vida)" stopOpacity=".75" />
            <stop offset="1" stopColor="var(--carne)" stopOpacity=".95" />
          </linearGradient>
        </defs>
        <path d={`${cima} ${baixo} Z`} fill="url(#fita)" className="fita" />
      </svg>

      <div
        className="mt-1 grid"
        style={{ gridTemplateColumns: `repeat(${passos.length}, minmax(0, 1fr))` }}
      >
        {passos.map((p, i) => {
          const antes = i > 0 ? passos[i - 1].valor : null;
          const taxa = antes && antes > 0 ? Math.round((p.valor / antes) * 100) : null;
          const gargalo =
            taxa != null &&
            taxa ===
              Math.min(
                ...passos
                  .map((q, j) =>
                    j > 0 && passos[j - 1].valor > 0
                      ? Math.round((q.valor / passos[j - 1].valor) * 100)
                      : 101,
                  )
                  .filter((x) => x <= 100),
              );
          return (
            <div key={p.rotulo} className="text-center">
              <div className="text-[11.5px] leading-tight text-[var(--bruma)]">{p.rotulo}</div>
              <div
                className={`font-display mt-1.5 text-[23px] font-bold leading-none tabular-nums ${
                  p.bom ? 'text-[var(--carne)]' : 'text-[var(--osso)]'
                }`}
              >
                {p.valor}
              </div>
              {taxa != null && (
                <div
                  className={`mt-1 text-[11px] tabular-nums ${
                    gargalo ? 'font-bold text-[var(--alerta)]' : 'text-[var(--bruma)]'
                  }`}
                >
                  {taxa}%
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

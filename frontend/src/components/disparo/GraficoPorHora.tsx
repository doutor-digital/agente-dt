import { useEffect, useMemo, useRef, useState } from 'react';
import { ChartColumn, Table2 } from 'lucide-react';
import type { DisparoResultado } from '../../types/disparo';
import { chaveDoDia, dia, hora, horasEmOrdem, numero } from './formato';

const ALTURA = 232;
const M = { t: 24, r: 12, b: 46, l: 34 };

/** Passo "redondo" do eixo: 5, 10, 20, 25, 50, 100… para ter ~4 marcas. */
function passoRedondo(max: number): number {
  const bruto = max / 4;
  for (const p of [1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000]) if (p >= bruto) return p;
  return 1000;
}

/**
 * Envios por hora. Um só tipo de dado, uma só cor: sem legenda (o título do painel já diz o que é).
 * A linha tracejada é o limite por hora: bateu nela, o robô espera a hora seguinte (e o texto dela diz isso).
 * Acessível: cada barra é focável e fala o valor; o botão "Ver em tabela" troca o desenho pelos mesmos números.
 */
export function GraficoPorHora({
  porHora,
  tetoPorHora,
}: {
  porHora: DisparoResultado['porHora'];
  tetoPorHora: number;
}) {
  const caixa = useRef<HTMLDivElement>(null);
  const [largura, setLargura] = useState(640);
  const [ativo, setAtivo] = useState<number | null>(null);
  const [tabela, setTabela] = useState(false);

  useEffect(() => {
    const el = caixa.current;
    if (!el) return;
    const medir = () => setLargura(Math.max(240, Math.floor(el.clientWidth)));
    medir();
    const ro = new ResizeObserver(medir);
    ro.observe(el);
    return () => ro.disconnect();
  }, [tabela, porHora.length]);

  const dados = useMemo(() => horasEmOrdem(porHora), [porHora]);

  if (dados.length === 0) {
    return (
      <div className="dsp-vazio">
        <strong>Nenhuma mensagem saiu ainda.</strong>
        <span>Quando a primeira sair, o gráfico de envios por hora aparece aqui.</span>
      </div>
    );
  }

  const maxDado = Math.max(...dados.map((d) => d.enviados));
  const passo = passoRedondo(Math.max(tetoPorHora, maxDado) * 1.1);
  const topo = Math.ceil((Math.max(tetoPorHora, maxDado) * 1.1) / passo) * passo;
  const ticks: number[] = [];
  for (let v = 0; v <= topo; v += passo) ticks.push(v);

  const W = largura;
  const iw = W - M.l - M.r;
  const ih = ALTURA - M.t - M.b;
  // Poucas barras não se esticam pela largura toda: ficam lado a lado, coladas à esquerda.
  const faixa = Math.min(iw / dados.length, 84);
  const larg = Math.max(8, Math.min(44, faixa * 0.62));
  const y = (v: number) => M.t + ih - (v / topo) * ih;
  const rotuloCada = Math.max(1, Math.ceil(dados.length / Math.max(1, Math.floor(iw / 36))));
  const comNumero = dados.length <= 12;

  const resumo = `Envios por hora: ${dados.map((d) => `${dia(d.hora)} ${hora(d.hora)}h, ${d.enviados}`).join('; ')}. Limite por hora: ${tetoPorHora}.`;

  const tip = ativo != null ? dados[ativo] : null;
  const tipX = ativo != null ? M.l + faixa * ativo + faixa / 2 : 0;

  return (
    <div>
      <div className="dsp-grafico-barra">
        <button type="button" onClick={() => setTabela((v) => !v)} className="dsp-btn" style={{ minHeight: '2.75rem' }}>
          {tabela ? <ChartColumn size={14} aria-hidden /> : <Table2 size={14} aria-hidden />}
          {tabela ? 'Ver como gráfico' : 'Ver em tabela'}
        </button>
      </div>

      {tabela ? (
        <div style={{ overflowX: 'auto' }}>
          <table className="dsp-tabela">
            <caption style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)' }}>
              Mensagens enviadas em cada hora
            </caption>
            <thead>
              <tr>
                <th scope="col">Dia</th>
                <th scope="col">Hora</th>
                <th scope="col">Enviadas</th>
              </tr>
            </thead>
            <tbody>
              {dados.map((d) => (
                <tr key={d.hora}>
                  <td>{dia(d.hora)}</td>
                  <td>{hora(d.hora)}h</td>
                  <td>{numero(d.enviados)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div ref={caixa} style={{ position: 'relative', width: '100%' }}>
          <svg width={W} height={ALTURA} role="img" aria-label={resumo} style={{ display: 'block', overflow: 'visible' }}>
            {ticks.map((t) => (
              <g key={t}>
                <line x1={M.l} x2={W - M.r} y1={y(t)} y2={y(t)} stroke="var(--dsp-line)" strokeWidth={1} />
                <text x={M.l - 8} y={y(t) + 4} textAnchor="end" fontSize={11} fill="var(--dsp-mute)" style={{ fontVariantNumeric: 'tabular-nums' }}>
                  {t}
                </text>
              </g>
            ))}

            {dados.map((d, i) => {
              const cx = M.l + faixa * i + faixa / 2;
              const h = (d.enviados / topo) * ih;
              const r = Math.min(3, larg / 2, h);
              const x0 = cx - larg / 2;
              const yy = y(d.enviados);
              const novoDia = i === 0 || chaveDoDia(dados[i - 1]!.hora) !== chaveDoDia(d.hora);
              const mostraRotulo = i % rotuloCada === 0 || novoDia;
              return (
                <g
                  key={d.hora}
                  tabIndex={0}
                  role="img"
                  aria-label={`${dia(d.hora)}, ${hora(d.hora)}h: ${d.enviados} enviadas`}
                  onMouseEnter={() => setAtivo(i)}
                  onMouseLeave={() => setAtivo(null)}
                  onFocus={() => setAtivo(i)}
                  onBlur={() => setAtivo(null)}
                  style={{ outline: 'none' }}
                >
                  {/* alvo de toque maior que a barra */}
                  <rect x={cx - faixa / 2} y={M.t} width={faixa} height={ih + M.b} fill="transparent" />
                  {d.enviados > 0 && (
                    <path
                      d={`M${x0},${M.t + ih} V${yy + r} Q${x0},${yy} ${x0 + r},${yy} H${x0 + larg - r} Q${x0 + larg},${yy} ${x0 + larg},${yy + r} V${M.t + ih} Z`}
                      fill="var(--dsp-blue)"
                      opacity={ativo == null || ativo === i ? 1 : 0.55}
                    />
                  )}
                  {comNumero && (
                    <text x={cx} y={yy - 6} textAnchor="middle" fontSize={12} fontWeight={500} fill="var(--dsp-ink)" style={{ fontVariantNumeric: 'tabular-nums' }}>
                      {d.enviados}
                    </text>
                  )}
                  {mostraRotulo && (
                    <text x={cx} y={M.t + ih + 16} textAnchor="middle" fontSize={11} fill="var(--dsp-mute)">
                      {hora(d.hora)}h
                    </text>
                  )}
                  {novoDia && (
                    <text x={cx} y={M.t + ih + 31} textAnchor="middle" fontSize={11} fontWeight={600} fill="var(--dsp-mute)">
                      {dia(d.hora)}
                    </text>
                  )}
                  {ativo === i && <rect x={x0 - 3} y={M.t} width={larg + 6} height={ih} fill="none" stroke="var(--dsp-focus)" strokeWidth={1.5} rx={3} />}
                </g>
              );
            })}

            {/* limite por hora: por cima das barras, tracejado, com nome direto */}
            <line x1={M.l} x2={W - M.r} y1={y(tetoPorHora)} y2={y(tetoPorHora)} stroke="var(--dsp-amber)" strokeWidth={1.5} strokeDasharray="6 4" />
            <text x={W - M.r} y={y(tetoPorHora) - 5} textAnchor="end" fontSize={11} fontWeight={600} fill="var(--dsp-amber)">
              Limite: {tetoPorHora} por hora
            </text>
          </svg>

          {tip && (
            <div className="dsp-tip" style={{ left: Math.min(Math.max(tipX, 60), W - 60), top: Math.max(0, y(tip.enviados) - 58) }}>
              <div style={{ opacity: 0.75 }}>
                {dia(tip.hora)} · {hora(tip.hora)}h
              </div>
              <div style={{ fontWeight: 600 }}>{numero(tip.enviados)} enviadas</div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

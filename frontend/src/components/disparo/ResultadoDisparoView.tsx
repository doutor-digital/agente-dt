import { useId, useState, type ReactNode } from 'react';
import {
  CheckCheck,
  Eye,
  Loader2,
  MessageCircle,
  OctagonX,
  RefreshCw,
  Send,
  TriangleAlert,
} from 'lucide-react';
import type { DisparoFonte, DisparoPessoa, DisparoResultado } from '../../types/disparo';
import { GraficoPorHora } from './GraficoPorHora';
import './disparo.css';
import {
  TEXTO_DO_NIVEL,
  corDoAvatar,
  dia,
  dolares,
  explicarAusencia,
  fracao,
  hora,
  horaMinuto,
  horasEmOrdem,
  inicial,
  lerEstado,
  lerPessoa,
  nivelDoFreio,
  nomeCurto,
  numero,
  porcento,
  quando,
  quandoCurto,
  reais,
  variacaoDaHora,
  type NivelDoFreio,
} from './formato';

/**
 * Referência para dizer se o custo está "acima" ou "abaixo do esperado": tarifa de lista da Meta para mensagem de
 * MARKETING no Brasil, em dólar por mensagem. É uma referência de tabela, não medida; está escrita na tela ao lado da conta.
 */
export const TARIFA_MARKETING_USD = 0.0625;

export type CarregamentoDePessoas =
  | { estado: 'carregando' }
  | { estado: 'erro'; tentarDeNovo?: () => void }
  | { estado: 'ok'; itens: DisparoPessoa[] };

interface Props {
  dados: DisparoResultado;
  pessoas?: CarregamentoDePessoas;
  /** "agora" injetável: a prévia fixa o relógio para a captura sair sempre igual */
  agora?: Date;
  onAtualizar?: () => void;
  atualizando?: boolean;
}

export function ResultadoDisparoView({ dados, pessoas = { estado: 'carregando' }, agora = new Date(), onAtualizar, atualizando }: Props) {
  const { onda, funil, freios, fontes } = dados;
  const estado = lerEstado(onda, freios.janela);
  const listaPessoas = pessoas.estado === 'ok' ? pessoas.itens : null;

  return (
    <div className="dsp">
      <header className="dsp-top">
        <div className="titulo">
          <h1>Resultado do disparo</h1>
          <span className="sub">
            {onda.campanhaNome} · {onda.unidadeNome}
          </span>
        </div>
        <div className="acoes">
          <span className="dsp-estado" data-tom={estado.tom}>
            <i aria-hidden /> {estado.titulo}
          </span>
          <span className="dsp-quando" title={dados.atualizadoEm}>
            Atualizado {quando(dados.atualizadoEm, agora)}
          </span>
          {onAtualizar && (
            <button type="button" className="dsp-btn" onClick={onAtualizar} disabled={atualizando} aria-label="Atualizar agora">
              {atualizando ? <Loader2 size={16} className="animate-spin" aria-hidden /> : <RefreshCw size={16} aria-hidden />}
              <span>Atualizar</span>
            </button>
          )}
        </div>
      </header>

      {(estado.tom === 'pausada' || estado.tom === 'parada') && (
        <div className="dsp-aviso" role="status" data-tom={estado.tom}>
          {estado.tom === 'parada' ? <OctagonX size={20} aria-hidden /> : <TriangleAlert size={20} aria-hidden />}
          <div>
            <strong>{estado.titulo}</strong>
            {estado.porque}
          </div>
        </div>
      )}

      <div className="dsp-corpo">
        <div className="dsp-principal">
          <Kpis dados={dados} agora={agora} />

          <div className="dsp-bloco">
            <div className="dsp-trio">
              <CartaoEnvios dados={dados} />
              <CartaoCusto dados={dados} agora={agora} />
              <CartaoRespostas dados={dados} agora={agora} />
            </div>

            <PainelFunil dados={dados} agora={agora} />

            <div className="dsp-dupla">
              <CartaoPessoas pessoas={pessoas} total={funil.selecionados} agora={agora} />
              <CartaoLinhaDoTempo dados={dados} pessoas={listaPessoas} agora={agora} />
            </div>
          </div>

          <p className="dsp-rodape">
            Entregues, lidos e custo vêm da Meta e só aparecem quando a conta fecha com o que a onda enviou: logo depois do envio é
            normal estarem indisponíveis.{' '}
            {fontes.entreguesAtualizadoEm
              ? `A Meta atualizou entregues e lidos ${quando(fontes.entreguesAtualizadoEm, agora)}. `
              : 'A Meta ainda não deu entregues e lidos para esta onda. '}
            Kommo, agenda e câmbio conferidos {quando(fontes.atualizadoEm, agora)}.
          </p>
        </div>

        <aside className="dsp-lateral" aria-label="Limites e atividades">
          <Freios dados={dados} />
          <Atividades dados={dados} pessoas={listaPessoas} agora={agora} />
        </aside>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* peças pequenas                                                      */
/* ------------------------------------------------------------------ */

/** "a Meta ainda…" vira "A Meta ainda….": a nota vem do servidor em minúscula e sem ponto. */
function frase(t: string): string {
  const s = t.trim();
  const c = s.charAt(0).toUpperCase() + s.slice(1);
  return /[.!?]$/.test(c) ? c : `${c}.`;
}

/** Asterisco ao lado do número: o texto da nota aparece ao passar o mouse, focar ou tocar. */
function Nota({ texto }: { texto: string | null }) {
  const id = useId();
  const [aberta, setAberta] = useState(false);
  if (!texto) return null;
  return (
    <span className="dsp-nota" onMouseEnter={() => setAberta(true)} onMouseLeave={() => setAberta(false)}>
      <button
        type="button"
        aria-label="Ver a ressalva deste número"
        aria-describedby={aberta ? id : undefined}
        aria-expanded={aberta}
        onClick={() => setAberta(true)}
        onFocus={() => setAberta(true)}
        onBlur={() => setAberta(false)}
        onKeyDown={(e) => e.key === 'Escape' && setAberta(false)}
      >
        *
      </button>
      {aberta && (
        <span role="tooltip" id={id}>
          {frase(texto)}
        </span>
      )}
    </span>
  );
}

function Triangulo({ sobe }: { sobe: boolean }) {
  return (
    <svg width="8" height="6" viewBox="0 0 8 6" aria-hidden>
      <path d={sobe ? 'M4 0 8 6H0z' : 'M4 6 0 0h8z'} fill="currentColor" />
    </svg>
  );
}

/** Linha fina com os pontos acumulados (só desenho: o número vem escrito ao lado). */
function Sparkline({ valores }: { valores: number[] }) {
  const W = 64;
  const H = 22;
  const max = Math.max(...valores, 1);
  const passo = W / (valores.length - 1);
  const pts = valores.map((v, i) => `${(i * passo).toFixed(1)},${(H - 2 - (v / max) * (H - 4)).toFixed(1)}`).join(' ');
  return (
    <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} aria-hidden>
      <polyline points={pts} fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

function Ausencia({ nota, fonte, quandoFoi, agora }: { nota: string | null; fonte: DisparoFonte; quandoFoi: string | null; agora: Date }) {
  return (
    <>
      {nota && <>{frase(nota)} </>}
      {explicarAusencia(fonte, quandoFoi, agora)}
    </>
  );
}

/* ------------------------------ faixa de KPIs ------------------------------ */

function Kpis({ dados, agora }: { dados: DisparoResultado; agora: Date }) {
  const { funil, fontes } = dados;
  const horas = horasEmOrdem(dados.porHora);
  let acum = 0;
  const acumulado = horas.map((h) => (acum += h.enviados));
  const v = variacaoDaHora(dados.porHora);

  return (
    <section className="dsp-kpis" aria-label="Números principais">
      <Kpi
        icone={<Send size={16} aria-hidden />}
        rotulo="Enviados"
        valor={funil.enviados}
        canto={
          v ? (
            <span className="canto" data-sobe={v.pct >= 0 ? '1' : '0'} title="Última hora com envio contra a anterior">
              <Triangulo sobe={v.pct >= 0} />
              <span className="num">{Math.abs(v.pct)}%</span>
            </span>
          ) : null
        }
        rodape={
          acumulado.length >= 2 ? (
            <span title={`Enviados acumulados por hora: ${acumulado.join(', ')}`}>
              <Sparkline valores={acumulado} />
            </span>
          ) : (
            <Taxa parte={funil.enviados} base={funil.selecionados} texto="dos escolhidos" />
          )
        }
      />
      <Kpi
        icone={<CheckCheck size={16} aria-hidden />}
        rotulo="Entregues"
        valor={funil.entregues}
        nota={fontes.notas.entregues}
        fonte={fontes.entregues}
        checado={fontes.entreguesAtualizadoEm ?? fontes.atualizadoEm}
        agora={agora}
        canto={funil.entregues != null ? <CantoTaxa parte={funil.entregues} base={funil.enviados} /> : null}
        rodape={funil.entregues != null ? <Taxa parte={funil.entregues} base={funil.enviados} texto="dos enviados" /> : null}
      />
      <Kpi
        icone={<Eye size={16} aria-hidden />}
        rotulo="Lidos"
        valor={funil.lidas}
        nota={fontes.notas.entregues}
        fonte={fontes.entregues}
        checado={fontes.entreguesAtualizadoEm ?? fontes.atualizadoEm}
        agora={agora}
        canto={funil.lidas != null ? <CantoTaxa parte={funil.lidas} base={funil.enviados} /> : null}
        rodape={funil.lidas != null ? <Taxa parte={funil.lidas} base={funil.enviados} texto="dos enviados" /> : null}
      />
      <Kpi
        icone={<MessageCircle size={16} aria-hidden />}
        rotulo="Responderam"
        valor={funil.responderam}
        nota={fontes.notas.responderam}
        fonte={fontes.responderam}
        checado={fontes.atualizadoEm}
        agora={agora}
        canto={funil.responderam != null ? <CantoTaxa parte={funil.responderam} base={funil.enviados} /> : null}
        rodape={funil.responderam != null ? <Taxa parte={funil.responderam} base={funil.enviados} texto="dos enviados" /> : null}
      />
    </section>
  );
}

function CantoTaxa({ parte, base }: { parte: number; base: number }) {
  return (
    <span className="canto num" title="Parte dos enviados">
      {porcento(parte, base)}
    </span>
  );
}

function Taxa({ parte, base, texto }: { parte: number; base: number; texto: string }) {
  return (
    <span className="dsp-taxa">
      <span className="trilho" aria-hidden>
        <i style={{ width: `${fracao(parte, base) * 100}%` }} />
      </span>
      <span>
        {porcento(parte, base)} {texto}
      </span>
    </span>
  );
}

function Kpi({
  icone,
  rotulo,
  valor,
  nota,
  fonte = 'indisponivel',
  checado = null,
  agora = new Date(),
  canto,
  rodape,
}: {
  icone: ReactNode;
  rotulo: string;
  valor: number | null;
  nota?: string | null;
  fonte?: DisparoFonte;
  checado?: string | null;
  agora?: Date;
  canto?: ReactNode;
  rodape?: ReactNode;
}) {
  const [aberto, setAberto] = useState(false);
  const ausente = valor === null;
  return (
    <div className="dsp-kpi">
      <span className="ico">{icone}</span>
      {canto}
      {ausente ? (
        <p className="valor ausente">indisponível</p>
      ) : (
        <p className="valor">
          {numero(valor)}
          {nota && <Nota texto={nota} />}
        </p>
      )}
      <p className="rotulo">{rotulo}</p>
      <div className="rodape">
        {ausente ? (
          <button type="button" className="dsp-link" aria-expanded={aberto} onClick={() => setAberto((a) => !a)}>
            {aberto ? 'Esconder o motivo' : 'Por quê?'}
          </button>
        ) : (
          rodape
        )}
      </div>
      {ausente && aberto && (
        <p className="dsp-porque">
          <Ausencia nota={nota ?? null} fonte={fonte} quandoFoi={checado} agora={agora} />
        </p>
      )}
    </div>
  );
}

/* ------------------------------ cartões com rodapé colorido ------------------------------ */

function CartaoEnvios({ dados }: { dados: DisparoResultado }) {
  const { freios } = dados;
  const horas = horasEmOrdem(dados.porHora).slice(-8);
  const v = variacaoDaHora(dados.porHora);
  const topo = Math.max(freios.tetoPorHora, ...horas.map((h) => h.enviados), 1) * 1.2;
  return (
    <section className="dsp-cartao" aria-labelledby="c-envios">
      <header>
        <h2 id="c-envios">Envios por hora</h2>
        <p className="legenda">Mensagens que saíram em cada hora</p>
      </header>
      <div className="area">
        {horas.length === 0 ? (
          <p className="dsp-mudo">Nenhuma mensagem saiu ainda. Quando a primeira sair, as barras aparecem aqui.</p>
        ) : (
          <div>
            <div className="dsp-mini" role="img" aria-label={`Envios nas últimas ${horas.length} horas: ${horas.map((h) => `${hora(h.hora)}h, ${h.enviados}`).join('; ')}. Limite: ${freios.tetoPorHora} por hora.`}>
              <span className="teto" style={{ bottom: `calc(${freios.tetoPorHora / topo} * 5.25rem)` }} title={`Limite: ${freios.tetoPorHora} por hora`} />
              {horas.map((h, i) => (
                <span key={h.hora} className="b" data-ultima={i === horas.length - 1 ? '1' : '0'} title={`${dia(h.hora)} ${hora(h.hora)}h: ${h.enviados}`}>
                  <i style={{ height: `${(h.enviados / topo) * 100}%` }}>
                    <span className="num">{h.enviados}</span>
                  </i>
                </span>
              ))}
            </div>
            <div className="dsp-mini-eixo" aria-hidden>
              {horas.map((h) => (
                <span key={h.hora}>{hora(h.hora)}h</span>
              ))}
            </div>
          </div>
        )}
        <p className="dsp-mudo">
          Última hora: <strong className="num" style={{ fontWeight: 500 }}>{numero(freios.enviadosUltimaHora)}</strong> de {numero(freios.tetoPorHora)} permitidos
        </p>
      </div>
      <footer className="cor" data-cor={v ? 'blue' : 'gray'}>
        {v ? (
          <>
            <span className="dsp-pilula">
              {v.pct !== 0 && <Triangulo sobe={v.pct > 0} />} {Math.abs(v.pct)}%
            </span>
            <span>{v.pct === 0 ? 'igual à hora anterior' : v.pct > 0 ? 'a mais que na hora anterior' : 'a menos que na hora anterior'}</span>
          </>
        ) : (
          <span>Só há uma hora de envio</span>
        )}
      </footer>
    </section>
  );
}

function CartaoCusto({ dados, agora }: { dados: DisparoResultado; agora: Date }) {
  const { custo, funil, fontes } = dados;
  const temCusto = custo.brl != null || custo.usd != null;
  const esperadoUsd = funil.enviados * TARIFA_MARKETING_USD;
  const dif = custo.usd != null && esperadoUsd > 0 ? Math.round(((custo.usd - esperadoUsd) / esperadoUsd) * 100) : null;
  const acima = dif != null && dif > 0;
  const cor = dif == null ? 'gray' : acima ? 'red' : 'green';

  return (
    <section className="dsp-cartao" aria-labelledby="c-custo">
      <header>
        <h2 id="c-custo">Custo</h2>
        <p className="legenda">O que a Meta cobrou por esta onda</p>
      </header>
      <div className="area">
        {temCusto ? (
          <>
            <p className="dsp-grande">
              {custo.brl != null ? reais(custo.brl) : dolares(custo.usd!)}
              <Nota texto={fontes.notas.custo} />
            </p>
            <p className="dsp-mudo">
              {custo.usd != null && custo.brl != null ? `${dolares(custo.usd)} na cobrança da Meta` : 'Câmbio indisponível: só o valor em dólar'}
              {custo.atualizadoEm && ` · atualizado ${quando(custo.atualizadoEm, agora)}`}
            </p>
            {esperadoUsd > 0 && (
              <p className="dsp-mudo">
                Esperado: {numero(funil.enviados)} mensagens × US$ {TARIFA_MARKETING_USD.toLocaleString('pt-BR')} (tarifa de marketing da Meta no Brasil) = {dolares(esperadoUsd)}
              </p>
            )}
            <dl className="dsp-pares">
              <div>
                <dt>Por resposta</dt>
                <dd className={custo.porResposta == null ? 'ausente' : ''}>{custo.porResposta != null ? reais(custo.porResposta) : 'indisponível'}</dd>
              </div>
              <div>
                <dt>Por agendamento</dt>
                <dd className={custo.porAgendamento == null ? 'ausente' : ''}>{custo.porAgendamento != null ? reais(custo.porAgendamento) : 'indisponível'}</dd>
              </div>
            </dl>
          </>
        ) : (
          <>
            <p className="dsp-grande ausente">indisponível</p>
            <p className="dsp-mudo">
              <Ausencia nota={fontes.notas.custo} fonte={fontes.custo} quandoFoi={custo.atualizadoEm ?? fontes.atualizadoEm} agora={agora} />
            </p>
            <p className="dsp-mudo">Custo total, por resposta e por agendamento aparecem aqui assim que a Meta fechar a cobrança.</p>
          </>
        )}
      </div>
      <footer className="cor" data-cor={cor}>
        {dif != null ? (
          <>
            <span className="dsp-pilula">
              <Triangulo sobe={acima} /> {Math.abs(dif)}%
            </span>
            <span>
              {acima ? 'acima' : 'abaixo'} do esperado
            </span>
          </>
        ) : (
          <span>Sem custo para comparar</span>
        )}
      </footer>
    </section>
  );
}

function CartaoRespostas({ dados, agora }: { dados: DisparoResultado; agora: Date }) {
  const { funil, fontes } = dados;
  const resp = funil.responderam;
  const taxa = resp != null ? fracao(resp, funil.enviados) : 0;
  const R = 44;
  const C = 2 * Math.PI * R;
  return (
    <section className="dsp-cartao" aria-labelledby="c-resp">
      <header>
        <h2 id="c-resp">Respostas</h2>
        <p className="legenda">Quem escreveu de volta depois de receber</p>
      </header>
      <div className="area">
        <div className="dsp-anel">
          <div className="roda">
            <svg width="104" height="104" viewBox="0 0 104 104" aria-hidden>
              <circle cx="52" cy="52" r={R} fill="none" stroke="var(--dsp-line)" strokeWidth="9" strokeDasharray={resp == null ? '5 6' : undefined} />
              {resp != null && (
                <circle
                  cx="52"
                  cy="52"
                  r={R}
                  fill="none"
                  stroke="var(--dsp-green-bar)"
                  strokeWidth="9"
                  strokeLinecap="round"
                  strokeDasharray={`${C * taxa} ${C}`}
                />
              )}
            </svg>
            <span className="centro">{resp != null ? porcento(resp, funil.enviados) : <span className="dsp-mudo">sem dado</span>}</span>
          </div>
          <div className="lista">
            <span>
              <strong>{resp != null ? numero(resp) : 'indisponível'}</strong>
              {resp != null && <Nota texto={fontes.notas.responderam} />} responderam
            </span>
            <span>
              <strong>{funil.agendaram != null ? numero(funil.agendaram) : 'indisponível'}</strong>
              {funil.agendaram != null && <Nota texto={fontes.notas.agendaram} />} agendaram
            </span>
            <span>
              <strong>{numero(funil.saiu)}</strong> pediram SAIR
            </span>
          </div>
        </div>
        {resp == null && (
          <p className="dsp-mudo">
            <Ausencia nota={fontes.notas.responderam} fonte={fontes.responderam} quandoFoi={fontes.atualizadoEm} agora={agora} />
          </p>
        )}
      </div>
      <footer className="cor" data-cor={resp != null ? 'green' : 'gray'}>
        {resp != null ? (
          <>
            <span className="dsp-pilula">{porcento(resp, funil.enviados)}</span>
            <span>dos enviados responderam</span>
          </>
        ) : (
          <span>Aguardando as respostas</span>
        )}
      </footer>
    </section>
  );
}

/* ------------------------------ painel: funil + gráfico ------------------------------ */

interface Etapa {
  chave: string;
  rotulo: string;
  valor: number | null;
  base: number | null;
  cor: 'blue' | 'green' | 'red';
  fonte?: DisparoFonte;
  nota?: string | null;
  checado?: string | null;
  /** repete o motivo de outra linha: diz isso em vez de escrever o texto de novo */
  mesmoMotivoQue?: string;
}

function PainelFunil({ dados, agora }: { dados: DisparoResultado; agora: Date }) {
  const { funil: f, fontes, freios } = dados;
  const entreguesEm = fontes.entreguesAtualizadoEm ?? fontes.atualizadoEm;
  const etapas: Etapa[] = [
    { chave: 'sel', rotulo: 'Selecionados', valor: f.selecionados, base: null, cor: 'blue' },
    { chave: 'env', rotulo: 'Enviados', valor: f.enviados, base: f.selecionados, cor: 'blue' },
    { chave: 'ent', rotulo: 'Entregues', valor: f.entregues, base: f.enviados, cor: 'green', fonte: fontes.entregues, nota: fontes.notas.entregues, checado: entreguesEm },
    { chave: 'lid', rotulo: 'Lidos', valor: f.lidas, base: f.enviados, cor: 'green', fonte: fontes.entregues, nota: fontes.notas.entregues, checado: entreguesEm, mesmoMotivoQue: 'Entregues' },
    { chave: 'res', rotulo: 'Responderam', valor: f.responderam, base: f.enviados, cor: 'green', fonte: fontes.responderam, nota: fontes.notas.responderam, checado: fontes.atualizadoEm },
    { chave: 'sai', rotulo: 'Pediram SAIR', valor: f.saiu, base: f.enviados, cor: 'red' },
    { chave: 'age', rotulo: 'Agendaram', valor: f.agendaram, base: f.enviados, cor: 'green', fonte: fontes.agendaram, nota: fontes.notas.agendaram, checado: fontes.atualizadoEm },
  ];

  return (
    <section className="dsp-painel" aria-labelledby="p-funil">
      <header>
        <h2 id="p-funil">Funil da onda</h2>
        <span className="legenda">{numero(f.selecionados)} pessoas escolhidas</span>
      </header>
      <div className="divisao">
        <div className="esq">
          <ol className="dsp-funil">
            {etapas.map((e) => {
              const ausente = e.valor === null;
              const larg = !ausente ? fracao(e.valor!, f.selecionados) * 100 : 0;
              return (
                <li key={e.chave} data-cor={e.cor}>
                  <div className="linha">
                    <span>{e.rotulo}</span>
                    {ausente ? (
                      <span className="qtd ausente">indisponível</span>
                    ) : (
                      <span className="qtd">
                        <b>{numero(e.valor!)}</b>
                        {e.nota && <Nota texto={e.nota} />}
                        {e.base != null && <span className="pct">{porcento(e.valor!, e.base)}</span>}
                      </span>
                    )}
                  </div>
                  <div className={ausente ? 'barra ausente' : 'barra'} aria-hidden>
                    {!ausente && <i style={{ width: `${e.valor! > 0 ? Math.max(larg, 1.5) : 0}%` }} />}
                  </div>
                  {ausente && (
                    <p className="porque">
                      {e.mesmoMotivoQue ? (
                        <>Mesma fonte e mesmo motivo de {e.mesmoMotivoQue}.</>
                      ) : (
                        <Ausencia nota={e.nota ?? null} fonte={e.fonte ?? 'indisponivel'} quandoFoi={e.checado ?? null} agora={agora} />
                      )}
                    </p>
                  )}
                </li>
              );
            })}
          </ol>
          <p className="dsp-fora">
            Cada barra compara com as {numero(f.selecionados)} escolhidas; a porcentagem compara com os enviados. Fora do envio:{' '}
            <b>{numero(f.pendentes)}</b> na fila · <b>{numero(f.falhas)}</b> falharam · <b>{numero(f.descartados)}</b> barradas antes do envio.
          </p>
        </div>
        <div className="dir">
          <h3 style={{ fontSize: '1rem', fontWeight: 400, marginBottom: '0.125rem' }}>Envios por hora</h3>
          <p className="dsp-mudo" style={{ marginBottom: '0.5rem' }}>
            A linha tracejada é o máximo por hora. Bateu nela, o robô espera a hora seguinte.
          </p>
          <GraficoPorHora porHora={dados.porHora} tetoPorHora={freios.tetoPorHora} />
        </div>
      </div>
    </section>
  );
}

/* ------------------------------ pessoas ------------------------------ */

const LIMITE_INICIAL = 5;

function CartaoPessoas({ pessoas, total, agora }: { pessoas: CarregamentoDePessoas; total: number; agora: Date }) {
  const [todas, setTodas] = useState(false);
  return (
    <section className="dsp-cartao" aria-labelledby="c-pessoas">
      <header className="cabeca" style={{ padding: '1rem 1rem 0' }}>
        <div>
          <h2 id="c-pessoas">Pessoas da onda</h2>
          <p className="legenda">Quem recebeu e quem está na fila</p>
        </div>
        <span className="dsp-contagem" title={`${numero(total)} pessoas escolhidas`}>
          {numero(total)}
        </span>
      </header>
      <div className="corpo" style={{ paddingTop: '1rem' }}>
        {pessoas.estado === 'carregando' && (
          <div role="status" aria-label="Carregando a lista de pessoas" style={{ display: 'grid', gap: '0.875rem' }}>
            {[0, 1, 2].map((i) => (
              <div key={i} className="dsp-esqueleto" style={{ height: '2.5rem' }} />
            ))}
          </div>
        )}
        {pessoas.estado === 'erro' && (
          <div>
            <p className="dsp-mudo">
              Não consegui carregar a lista de pessoas agora. O resto da tela não depende dela e continua certo.
            </p>
            {pessoas.tentarDeNovo && (
              <button type="button" className="dsp-mais" onClick={pessoas.tentarDeNovo}>
                Tentar de novo
              </button>
            )}
          </div>
        )}
        {pessoas.estado === 'ok' &&
          (pessoas.itens.length === 0 ? (
            <p className="dsp-mudo">A lista aparece aqui assim que a onda for montada.</p>
          ) : (
            <>
              <ul className="dsp-pessoas">
                {(todas ? pessoas.itens : pessoas.itens.slice(0, LIMITE_INICIAL)).map((p, i) => {
                  const l = lerPessoa(p);
                  return (
                    <li key={`${p.kommoLeadId ?? p.nome}-${i}`} className="dsp-pessoa">
                      <span className="dsp-avatar" data-c={corDoAvatar(p.nome)} aria-hidden>
                        {inicial(p.nome)}
                        <span className="ponto" data-tom={l.tom} />
                      </span>
                      <span className="txt">
                        <span className="nome" style={{ display: 'block' }}>{nomeCurto(p.nome)}</span>
                        <span className="detalhe" style={{ display: 'block' }}>
                          <b data-tom={l.tom}>{l.texto}</b>
                          {p.enviadoEm && ` · ${quandoCurto(p.enviadoEm, agora)}`}
                        </span>
                      </span>
                    </li>
                  );
                })}
              </ul>
              {pessoas.itens.length > LIMITE_INICIAL && (
                <button type="button" className="dsp-mais" aria-expanded={todas} onClick={() => setTodas((v) => !v)}>
                  {todas ? 'Mostrar menos' : `Mais ${pessoas.itens.length - LIMITE_INICIAL}`}
                </button>
              )}
            </>
          ))}
      </div>
    </section>
  );
}

/* ------------------------------ linha do tempo ------------------------------ */

interface Marco {
  chave: string;
  hora?: string;
  texto: string;
  detalhe?: string;
  tom: 'ok' | 'alerta' | 'ruim' | 'neutro';
  feito: boolean;
  atual?: boolean;
  futuro?: boolean;
}

function montarMarcos(d: DisparoResultado, pessoas: DisparoPessoa[] | null, agora: Date): Marco[] {
  const { onda, funil: f, freios } = d;
  const m: Marco[] = [];
  const horas = horasEmOrdem(d.porHora).filter((h) => h.enviados > 0);
  const enviadas = (pessoas ?? []).map((p) => p.enviadoEm).filter((x): x is string => !!x).sort();

  if (onda.aprovadaEm) {
    m.push({
      chave: 'aprovada',
      hora: quandoCurto(onda.aprovadaEm, agora),
      texto: 'Onda liberada',
      detalhe: onda.aprovadaPor ? `Por ${onda.aprovadaPor}` : undefined,
      tom: 'ok',
      feito: true,
    });
  }
  if (horas.length > 0) {
    // A lista de pessoas é cortada (as mais recentes primeiro): serve para a ÚLTIMA mensagem, nunca para a primeira.
    m.push({
      chave: 'primeiro',
      hora: `${dia(horas[0]!.hora)} ${hora(horas[0]!.hora)}h`,
      texto: 'Primeira mensagem enviada',
      detalhe: 'Na hora cheia, como no gráfico por hora.',
      tom: 'ok',
      feito: true,
    });
  }
  const noLimite = horas.filter((h) => h.enviados >= freios.tetoPorHora);
  if (noLimite.length > 0) {
    m.push({
      chave: 'limite',
      hora: `${dia(noLimite[0]!.hora)} ${hora(noLimite[0]!.hora)}h`,
      texto: `Bateu o limite de ${freios.tetoPorHora} por hora${noLimite.length > 1 ? ` (${noLimite.length} vezes)` : ''}`,
      detalhe: 'O robô esperou a hora seguinte.',
      tom: 'alerta',
      feito: true,
    });
  }
  if (f.falhas > 0) {
    m.push({
      chave: 'falhas',
      texto: f.falhas === 1 ? '1 mensagem falhou' : `${numero(f.falhas)} mensagens falharam`,
      detalhe: 'Falhou, não foi enviada. A hora da falha não é guardada.',
      tom: 'ruim',
      feito: true,
    });
  }
  if (f.saiu > 0) {
    m.push({
      chave: 'sair',
      texto: f.saiu === 1 ? '1 pessoa pediu SAIR' : `${numero(f.saiu)} pessoas pediram SAIR`,
      detalhe: f.saiu >= freios.maxSair ? `Máximo de ${freios.maxSair}: a unidade para sozinha.` : `A unidade para sozinha acima de ${freios.maxSair}.`,
      tom: f.saiu > freios.maxSair ? 'ruim' : 'alerta',
      feito: true,
    });
  }

  switch (onda.estado) {
    case 'pausada':
      m.push({ chave: 'pausa', hora: 'agora', texto: 'Onda pausada', detalhe: onda.pausaMotivo ?? undefined, tom: 'alerta', feito: true, atual: true });
      break;
    case 'concluida': {
      const ultima = enviadas[enviadas.length - 1];
      const h = horas[horas.length - 1];
      m.push({
        chave: 'fim',
        hora: ultima ? quandoCurto(ultima, agora) : h ? `${dia(h.hora)} ${hora(h.hora)}h` : undefined,
        texto: 'Onda concluída',
        detalhe: 'Todas as pessoas da lista foram tratadas.',
        tom: 'ok',
        feito: true,
        atual: true,
      });
      break;
    }
    case 'cancelada':
      m.push({ chave: 'fim', texto: 'Onda cancelada', detalhe: onda.pausaMotivo ?? undefined, tom: 'ruim', feito: true, atual: true });
      break;
    case 'aprovada':
      m.push({ chave: 'agora', hora: `agora, ${horaMinuto(d.atualizadoEm)}`, texto: 'Enviando', detalhe: `Dentro do horário (${freios.janela})`, tom: 'ok', feito: true, atual: true });
      break;
    default:
      m.push({ chave: 'espera', hora: 'agora', texto: lerEstado(onda, freios.janela).titulo, tom: 'neutro', feito: false, atual: true });
  }
  if (f.pendentes > 0 && onda.estado !== 'cancelada') {
    m.push({
      chave: 'fila',
      texto: `Faltam ${numero(f.pendentes)} na fila`,
      detalhe: onda.estado === 'aprovada' ? 'Saem quando o horário e os limites deixarem.' : undefined,
      tom: 'neutro',
      feito: false,
      futuro: true,
    });
  }
  return m;
}

function CartaoLinhaDoTempo({ dados, pessoas, agora }: { dados: DisparoResultado; pessoas: DisparoPessoa[] | null; agora: Date }) {
  const marcos = montarMarcos(dados, pessoas, agora);
  return (
    <section className="dsp-cartao" aria-labelledby="c-tempo">
      <header>
        <h2 id="c-tempo">Linha do tempo da onda</h2>
        <p className="legenda">O que aconteceu desde que foi liberada</p>
      </header>
      <div className="corpo" style={{ paddingTop: '1rem' }}>
        <ol className="dsp-tempo">
          {marcos.map((x) => (
            <li key={x.chave} data-tom={x.tom} data-feito={x.feito && !x.atual ? '1' : '0'} data-atual={x.atual ? '1' : '0'} data-futuro={x.futuro ? '1' : '0'}>
              {x.hora && <span className="h">{x.hora}</span>}
              <span className="t">
                {x.texto}
                {x.detalhe && <small>{x.detalhe}</small>}
              </span>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}

/* ------------------------------ coluna da direita ------------------------------ */

function Freios({ dados }: { dados: DisparoResultado }) {
  const { freios: fr, funil } = dados;
  const itens: Array<{ rotulo: string; usado: number; teto: number; nota: string }> = [
    { rotulo: 'Última hora', usado: fr.enviadosUltimaHora, teto: fr.tetoPorHora, nota: 'Bateu o limite, o robô espera a hora seguinte.' },
    { rotulo: 'Últimas 24 horas', usado: fr.enviadosUltimas24h, teto: fr.tetoPorDia, nota: 'Máximo de mensagens por dia nesta unidade.' },
    { rotulo: 'Pedidos de SAIR', usado: funil.saiu, teto: fr.maxSair, nota: `Passou de ${fr.maxSair}, a unidade para sozinha.` },
  ];
  return (
    <section aria-labelledby="l-freios">
      <h2 id="l-freios">Limites de segurança</h2>
      <ul className="dsp-freios">
        <li>
          <span className="p" style={{ background: 'var(--dsp-mute)' }} aria-hidden />
          <span>
            <span className="l">
              <span>Horário de envio</span>
            </span>
            <span className="n" style={{ display: 'block' }}>{fr.janela}. Fora dele a fila espera.</span>
          </span>
        </li>
        {itens.map((i) => {
          const nivel: NivelDoFreio = nivelDoFreio(i.usado, i.teto);
          return (
            <li key={i.rotulo} data-nivel={nivel}>
              <span className="p" aria-hidden />
              <span>
                <span className="l">
                  <span>{i.rotulo}</span>
                  <b>
                    {numero(i.usado)} de {numero(i.teto)}
                  </b>
                </span>
                <span className="n" style={{ display: 'block' }}>
                  {nivel === 'folga' ? i.nota : `${TEXTO_DO_NIVEL[nivel]}. ${i.nota}`}
                </span>
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

interface Atividade {
  chave: string;
  texto: ReactNode;
  quando: string;
  tom: 'ok' | 'info' | 'alerta' | 'ruim';
}

function Atividades({ dados, pessoas, agora }: { dados: DisparoResultado; pessoas: DisparoPessoa[] | null; agora: Date }) {
  const { onda, funil: f, freios, fontes } = dados;
  const visto = `visto ${quando(dados.atualizadoEm, agora)}`;
  const lista: Atividade[] = [];

  if (onda.estado === 'pausada') {
    lista.push({ chave: 'pausa', texto: <>Onda <strong>pausada</strong>. {onda.pausaMotivo}</>, quando: visto, tom: 'alerta' });
  } else if (onda.estado === 'cancelada') {
    lista.push({ chave: 'cancel', texto: <>Onda <strong>cancelada</strong>.</>, quando: visto, tom: 'ruim' });
  } else if (onda.estado === 'concluida') {
    lista.push({ chave: 'fim', texto: <>Onda <strong>concluída</strong>.</>, quando: visto, tom: 'ok' });
  }
  if (f.saiu > 0) {
    lista.push({
      chave: 'sair',
      texto: (
        <>
          <strong>{numero(f.saiu)}</strong> {f.saiu === 1 ? 'pessoa pediu' : 'pessoas pediram'} SAIR (máximo {freios.maxSair}).
        </>
      ),
      quando: visto,
      tom: f.saiu > freios.maxSair ? 'ruim' : 'alerta',
    });
  }
  if (f.falhas > 0) {
    const quem = (pessoas ?? []).filter((p) => p.estado === 'falhou').slice(0, 3).map((p) => nomeCurto(p.nome));
    lista.push({
      chave: 'falhas',
      texto: (
        <>
          <strong>{numero(f.falhas)}</strong> {f.falhas === 1 ? 'mensagem falhou' : 'mensagens falharam'}
          {quem.length > 0 ? <>: {quem.join(', ')}{quem[quem.length - 1]!.endsWith('.') ? '' : '.'}</> : '.'}
        </>
      ),
      quando: visto,
      tom: 'ruim',
    });
  }
  if (f.responderam != null) {
    lista.push({ chave: 'resp', texto: <><strong>{numero(f.responderam)}</strong> {f.responderam === 1 ? 'pessoa respondeu' : 'pessoas responderam'}.</>, quando: `Kommo, ${quando(fontes.atualizadoEm, agora)}`, tom: 'info' });
  }
  if (f.agendaram != null) {
    lista.push({ chave: 'age', texto: <><strong>{numero(f.agendaram)}</strong> {f.agendaram === 1 ? 'consulta marcada' : 'consultas marcadas'}{fontes.notas.agendaram ? ' (mínimo conhecido)' : ''}.</>, quando: `Agenda, ${quando(fontes.atualizadoEm, agora)}`, tom: 'ok' });
  }
  if (onda.aprovadaEm) {
    lista.push({ chave: 'aprov', texto: <>Liberada{onda.aprovadaPor ? <> por <strong>{onda.aprovadaPor}</strong></> : null}.</>, quando: quandoCurto(onda.aprovadaEm, agora), tom: 'ok' });
  }

  return (
    <section aria-labelledby="l-ativ">
      <h2 id="l-ativ">Atividades</h2>
      {lista.length === 0 ? (
        <p className="vazio dsp-mudo">Nada para olhar por enquanto: sem SAIR, sem falhas, sem pausa.</p>
      ) : (
        <ul className="dsp-atividades">
          {lista.map((a) => (
            <li key={a.chave} data-tom={a.tom}>
              {a.texto}
              <span className="quando">{a.quando}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

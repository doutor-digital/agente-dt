/**
 * Carga de implantação: traz pro Kommo os pacientes que só existem na franquia.
 *
 * Nasceu do caso de Petrópolis (28/09/2026): a franquia tinha 183 pacientes com agenda e o Kommo
 * tinha 1 lead. O sincronizador rodava de 15 em 15 minutos e gravava zero, porque não havia cartão
 * pra preencher. Pedido do João: "preciso ter o controle do que está acontecendo de fato" — por isso
 * a tela mostra o número antes, em vez de um botão que faz algo invisível.
 *
 * A tela é deliberadamente uma escada de um sentido só: conferir a conexão → ver o que seria criado
 * → criar. O botão de criar fica desabilitado até a prévia existir, e some quando há bloqueio. Não
 * existe apagar lead por API: um clique errado aqui é permanente, então a tela inteira é desenhada
 * pra que ninguém chegue no último degrau sem ter lido os dois primeiros.
 */
import { useCallback, useEffect, useState } from 'react';
import {
  PiArrowClockwiseBold,
  PiCheckCircleFill,
  PiPlugsConnectedBold,
  PiSpinnerGapBold,
  PiUsersThreeBold,
  PiWarningCircleBold,
} from 'react-icons/pi';
import { api, type CargaPrevia, type CargaResultado } from '../lib/api';
import { useUnit } from '../context/UnitContext';

/** Cor da etapa no resumo: o que é bom, o que é neutro, o que é perda. */
function corDaEtapa(etapa: string): string {
  const e = etapa.toUpperCase();
  if (e.includes('PERDIDO') || e.includes('NÃO COMPARECEU')) return 'text-rose-300 border-rose-500/25';
  if (e.includes('TRATAMENTO') || e.includes('GANHO') || e.includes('ALTA')) return 'text-emerald-300 border-emerald-500/25';
  if (e.includes('AGENDADO') || e.includes('COMPARECEU')) return 'text-sky-300 border-sky-500/25';
  return 'text-zinc-300 border-zinc-700';
}

export default function ImplantacaoPanel() {
  const { selectedUnit: unit } = useUnit();
  const [previa, setPrevia] = useState<CargaPrevia | null>(null);
  const [carregando, setCarregando] = useState(false);
  const [aplicando, setAplicando] = useState(false);
  const [confirmando, setConfirmando] = useState(false);
  const [resultado, setResultado] = useState<CargaResultado | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [meses, setMeses] = useState(4);

  // troca de unidade zera tudo: prévia de uma conta não pode virar botão de outra
  useEffect(() => {
    setPrevia(null);
    setResultado(null);
    setErro(null);
    setConfirmando(false);
  }, [unit?.id]);

  const verPrevia = useCallback(async () => {
    if (!unit) return;
    setCarregando(true);
    setErro(null);
    setResultado(null);
    setConfirmando(false);
    try {
      setPrevia(await api.implantacaoPrevia(unit.id, meses));
    } catch (e) {
      const err = e as { response?: { data?: { detalhe?: string; error?: string } } };
      const code = err.response?.data?.error;
      setErro(code === 'franquia_nao_ligada' ? 'franquia_nao_ligada' : (err.response?.data?.detalhe ?? code ?? 'não consegui falar com a franquia'));
      setPrevia(null);
    } finally {
      setCarregando(false);
    }
  }, [unit, meses]);

  const aplicar = useCallback(async () => {
    if (!unit) return;
    setAplicando(true);
    setErro(null);
    try {
      const r = await api.implantacaoAplicar(unit.id, meses);
      setResultado(r);
      setPrevia(null);
      setConfirmando(false);
    } catch (e) {
      const err = e as { response?: { data?: { detalhe?: string; error?: string } } };
      setErro(err.response?.data?.detalhe ?? err.response?.data?.error ?? 'a criação falhou');
    } finally {
      setAplicando(false);
    }
  }, [unit, meses]);

  if (!unit) return <p className="p-8 text-sm text-zinc-400">Selecione uma unidade.</p>;

  // a ligação com a franquia é verdade do backend (422 `franquia_nao_ligada`), não do tipo Unit
  const semFranquia = erro === 'franquia_nao_ligada';
  const podeAplicar = !!previa && previa.criaria > 0 && !previa.bloqueio;

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="mx-auto max-w-[1100px] space-y-6 p-8 pb-28">
        <header>
          <h1 className="text-lg font-semibold text-zinc-50">Implantação — trazer os pacientes da franquia</h1>
          <p className="mt-1 max-w-3xl text-sm leading-relaxed text-zinc-400">
            Numa unidade nova o CRM nasce vazio, mas a franquia já tem meses de histórico. Isto cria o
            cartão de quem só existe lá, <strong className="text-zinc-300">já na etapa certa</strong> — quem
            tem consulta marcada em AGENDADO, quem está em sessões no funil TRATAMENTO, quem sumiu há
            um ano em PERDIDO. Serve também para arrumar uma conta cujos cartões estão todos no lugar errado.
          </p>
        </header>

        {/* 1 — a conexão com a franquia */}
        <section className="surface p-5">
          <div className="flex flex-wrap items-center gap-3">
            <PiPlugsConnectedBold size={16} className={semFranquia ? 'text-amber-400' : 'text-zinc-500'} />
            <span className="text-sm text-zinc-200">{unit.name}</span>
            {semFranquia && (
              <span className="text-xs text-amber-300">
                esta unidade ainda não está ligada na franquia — preencha o token e ligue o acesso em Unidades
              </span>
            )}
          </div>
        </section>

        {/* 2 — o que seria criado */}
        <section className="surface p-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-sm font-medium text-zinc-100">O que seria criado</p>
              <p className="mt-0.5 text-xs text-zinc-500">
                Só olha, não escreve nada no Kommo — mas conversa com a franquia paciente por
                paciente, então leva alguns minutos numa unidade cheia.
              </p>
            </div>
            <div className="flex items-center gap-2">
              <label className="text-xs text-zinc-500">
                histórico de
                <select
                  className="ml-2 rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1 text-xs text-zinc-200"
                  value={meses}
                  onChange={(e) => setMeses(Number(e.target.value))}
                  disabled={carregando || aplicando}
                >
                  {[2, 4, 6, 12].map((m) => (
                    <option key={m} value={m}>{m} meses</option>
                  ))}
                </select>
              </label>
              <button className="btn-primary" onClick={verPrevia} disabled={carregando || semFranquia || aplicando}>
                {carregando ? <PiSpinnerGapBold size={14} className="animate-spin" /> : <PiArrowClockwiseBold size={14} />}
                {carregando ? 'Perguntando à franquia… (pode levar minutos)' : 'Ver o que seria criado'}
              </button>
            </div>
          </div>

          {erro && erro !== 'franquia_nao_ligada' && (
            <div className="mt-4 flex items-start gap-2 rounded-lg border border-rose-500/30 p-3 text-sm text-rose-300">
              <PiWarningCircleBold size={16} className="mt-0.5 shrink-0" />
              <span>{erro}</span>
            </div>
          )}

          {previa && (
            <div className="mt-5 space-y-5">
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <span className="text-3xl font-semibold tabular-nums text-zinc-50">{previa.criaria}</span>
                <span className="text-sm text-zinc-400">
                  cartões novos, de {previa.pacientesNaFranquia} pacientes que a franquia tem em agenda
                </span>
              </div>

              {previa.criaria > 0 && (
                <div className="flex flex-wrap gap-2">
                  {Object.entries(previa.porEtapa)
                    .sort((a, b) => b[1] - a[1])
                    .map(([etapa, n]) => (
                      <span
                        key={etapa}
                        className={`inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs ${corDaEtapa(etapa)}`}
                      >
                        <strong className="tabular-nums">{n}</strong> {etapa}
                      </span>
                    ))}
                </div>
              )}

              <div className="grid gap-2 text-xs text-zinc-500 sm:grid-cols-3">
                <span>{previa.fora.jaTemCartao} já têm cartão</span>
                <span>{previa.fora.semTelefone} sem telefone utilizável</span>
                <span>{previa.fora.semFato} sem consulta nem tratamento</span>
              </div>

              {previa.exemplos.length > 0 && (
                <details className="text-xs text-zinc-400">
                  <summary className="cursor-pointer text-zinc-500 hover:text-zinc-300">
                    ver alguns nomes e por que cada um cai na etapa
                  </summary>
                  <ul className="mt-2 space-y-1.5">
                    {previa.exemplos.map((e) => (
                      <li key={e.nome} className="flex flex-wrap items-baseline gap-x-2">
                        <PiUsersThreeBold size={13} className="shrink-0 text-zinc-600" />
                        <span className="text-zinc-300">{e.nome}</span>
                        <span className="text-zinc-500">→ {e.etapa}</span>
                        <span className="text-zinc-600">({e.porque})</span>
                      </li>
                    ))}
                  </ul>
                </details>
              )}

              {previa.bloqueio && (
                <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-sm text-amber-200">
                  <PiWarningCircleBold size={16} className="mt-0.5 shrink-0" />
                  <div>
                    <p className="font-medium">Não dá pra criar ainda</p>
                    <p className="mt-0.5 text-amber-200/80">{previa.bloqueio}</p>
                  </div>
                </div>
              )}
            </div>
          )}
        </section>

        {/* 3 — criar */}
        {podeAplicar && (
          <section className="surface border-emerald-500/20 p-5">
            {!confirmando ? (
              <div className="flex flex-wrap items-center justify-between gap-3">
                <p className="text-sm text-zinc-300">
                  Conferiu os números acima? Então pode criar.
                </p>
                <button className="btn-primary" onClick={() => setConfirmando(true)}>
                  Criar {previa.criaria} cartões
                </button>
              </div>
            ) : (
              <div className="space-y-3">
                <p className="text-sm text-zinc-100">
                  Vou criar <strong>{previa.criaria} cartões</strong> em {unit.name}.
                </p>
                <p className="text-xs text-rose-300">
                  Não existe apagar lead pela API do Kommo. O que for criado errado fica.
                </p>
                <div className="flex gap-2">
                  <button className="btn-ghost" onClick={() => setConfirmando(false)} disabled={aplicando}>
                    Cancelar
                  </button>
                  <button className="btn-primary" onClick={aplicar} disabled={aplicando}>
                    {aplicando ? <PiSpinnerGapBold size={14} className="animate-spin" /> : null}
                    {aplicando ? 'Criando…' : 'Confirmo, pode criar'}
                  </button>
                </div>
              </div>
            )}
          </section>
        )}

        {/* 4 — o que aconteceu */}
        {resultado && (
          <section className="surface border-emerald-500/25 p-5">
            <div className="flex items-center gap-2">
              <PiCheckCircleFill size={18} className="text-emerald-400" />
              <p className="text-sm text-zinc-100">
                <strong className="tabular-nums">{resultado.criados ?? 0}</strong> cartões criados
                {(resultado.falhas ?? 0) > 0 && (
                  <span className="text-rose-300"> · {resultado.falhas} falharam</span>
                )}
              </p>
            </div>
            {resultado.porEtapa && Object.keys(resultado.porEtapa).length > 0 && (
              <div className="mt-3 flex flex-wrap gap-2">
                {Object.entries(resultado.porEtapa).map(([etapa, n]) => (
                  <span key={etapa} className={`inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs ${corDaEtapa(etapa)}`}>
                    <strong className="tabular-nums">{n}</strong> {etapa}
                  </span>
                ))}
              </div>
            )}
            {resultado.erros && resultado.erros.length > 0 && (
              <ul className="mt-3 space-y-1 text-xs text-rose-300">
                {resultado.erros.map((e) => <li key={e}>{e}</li>)}
              </ul>
            )}
            <p className="mt-4 text-xs text-zinc-500">
              O sincronizador preenche os campos destes cartões na próxima varredura, em até 15 minutos.
              Depois disso, pode religar os bots.
            </p>
          </section>
        )}
      </div>
    </div>
  );
}

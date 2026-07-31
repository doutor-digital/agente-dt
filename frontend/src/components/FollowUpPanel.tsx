// ============================================================================
// FollowUpPanel — reengajamento por etapa do funil.
//
// POR QUE A TELA MOSTRA O QUE AINDA NÃO EXISTE
// --------------------------------------------
// Listar só o que está salvo começaria vazio, e tela vazia não ensina nada:
// ninguém descobriria que dá pra reengajar quem foi perdido por "achou caro".
// Então o cardápio inteiro aparece, com as escadas já escritas, e cada uma diz
// se está ligada, desligada ou ainda nem criada.
//
// POR QUE OS MOTIVOS INTOCÁVEIS APARECEM
// --------------------------------------
// Eles não são configuráveis — e é justamente por isso que precisam estar à
// vista, com o motivo. Regra invisível é regra que ninguém entende, e alguém
// ia perguntar por que "sem condições financeiras" não está na lista. Ver o
// "porquê" também comunica um critério: não se persegue quem já disse que não
// pode pagar.
//
// A CHAVE GERAL É SEPARADA DAS REGRAS
// -----------------------------------
// Ligar uma regra não faz nada enquanto a chave geral estiver desligada, e a
// tela diz isso na cara. É proposital: dá pra montar tudo com calma e só
// depois abrir a torneira — em vez de a primeira regra salva já começar a
// mandar mensagem pra paciente de verdade.
// ============================================================================

import { useCallback, useEffect, useState } from 'react';
import {
  PiWarningCircleBold,
  PiCheckCircleFill,
  PiSpinnerGapBold,
  PiProhibitBold,
  PiClockBold,
  PiPencilSimpleBold,
} from 'react-icons/pi';
import { api } from '../lib/api';
import { useUnit } from '../context/UnitContext';
import type { FollowUpRulesResponse, FollowUpRegra } from '../types/api';

/** "90" -> "1h30". Minuto cru não se lê numa escada de cinco degraus. */
function tempoLegivel(min: number): string {
  if (min < 60) return `${min}min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h}h${String(m).padStart(2, '0')}` : `${h}h`;
}

export default function FollowUpPanel() {
  const { selectedUnit: unit } = useUnit();
  const [dados, setDados] = useState<FollowUpRulesResponse | null>(null);
  const [carregando, setCarregando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const [salvando, setSalvando] = useState<string | null>(null);

  const carregar = useCallback(async () => {
    if (!unit) return;
    setCarregando(true);
    setErro(null);
    try {
      setDados(await api.followUpRules(unit.id));
    } catch (e) {
      setErro(e instanceof Error ? e.message : 'Falha ao carregar');
    } finally {
      setCarregando(false);
    }
  }, [unit?.id]);

  useEffect(() => {
    void carregar();
  }, [carregar]);

  async function alternarRegra(r: FollowUpRegra, ligar: boolean) {
    if (!unit) return;
    const chave = `${r.statusId}:${r.lossReasonId ?? 'null'}`;
    setSalvando(chave);
    setErro(null);
    try {
      await api.saveFollowUpRule(unit.id, {
        statusId: r.statusId,
        lossReasonId: r.lossReasonId,
        lossReasonName: r.lossReasonName,
        enabled: ligar,
        // Na primeira vez a escada do modelo vai junto — senão a regra nasceria
        // ligada e sem nenhum degrau, que é pior que não existir.
        ...(r.existe ? {} : { steps: r.steps }),
      });
      await carregar();
    } catch (e) {
      setErro(e instanceof Error ? e.message : 'Falha ao salvar');
    } finally {
      setSalvando(null);
    }
  }

  async function alternarGeral(ligar: boolean) {
    if (!unit) return;
    setSalvando('geral');
    try {
      await api.toggleFollowUp(unit.id, ligar);
      await carregar();
    } catch (e) {
      setErro(e instanceof Error ? e.message : 'Falha ao salvar');
    } finally {
      setSalvando(null);
    }
  }

  if (!unit) return <p className="p-8 text-sm text-zinc-400">Selecione um agente.</p>;

  const geral = dados?.followUpEnabled ?? false;
  const porEtapa = new Map<string, FollowUpRegra[]>();
  for (const r of dados?.regras ?? []) {
    const k = r.statusName;
    porEtapa.set(k, [...(porEtapa.get(k) ?? []), r]);
  }

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="mx-auto max-w-[1500px] space-y-7 p-8 pb-28">
        <header>
          <h1 className="text-lg font-semibold text-zinc-50">Follow-up</h1>
          <p className="mt-1 max-w-3xl text-sm leading-relaxed text-zinc-400">
            Quando o paciente para de responder, a Sofia volta a falar. O que ela diz depende da
            etapa em que ele está — quem sumiu antes de marcar precisa de uma coisa, quem já marcou
            e não pagou precisa de outra.
          </p>
        </header>

        {erro && (
          <div className="surface flex items-start gap-2 border-rose-500/30 p-4 text-sm text-rose-300">
            <PiWarningCircleBold size={16} className="mt-0.5 shrink-0" />
            {erro}
          </div>
        )}

        {/* CHAVE GERAL. Separada das regras de propósito — ver o cabeçalho. */}
        <section
          className={`surface p-6 ${geral ? 'border-emerald-500/25' : 'border-zinc-800'}`}
        >
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div>
              <h2 className="text-sm font-semibold text-zinc-100">
                {geral ? 'Reengajamento ligado' : 'Reengajamento desligado'}
              </h2>
              <p className="mt-1 max-w-2xl text-sm leading-relaxed text-zinc-400">
                {geral
                  ? `${dados?.ligadas ?? 0} regra(s) ativa(s). A Sofia só escreve dentro do horário de atendimento.`
                  : 'Nenhuma mensagem é enviada, mesmo com regras ligadas abaixo. Monte tudo com calma e abra a torneira depois.'}
              </p>
            </div>
            <button
              className={geral ? 'btn-ghost' : 'btn-primary'}
              disabled={salvando === 'geral'}
              onClick={() => void alternarGeral(!geral)}
            >
              {salvando === 'geral' && <PiSpinnerGapBold size={14} className="animate-spin" />}
              {geral ? 'Desligar' : 'Ligar reengajamento'}
            </button>
          </div>
        </section>

        {carregando && !dados && (
          <div className="surface flex items-center justify-center p-10 text-zinc-500">
            <PiSpinnerGapBold size={18} className="animate-spin" />
          </div>
        )}

        {[...porEtapa.entries()].map(([etapa, regras]) => (
          <section key={etapa} className="surface overflow-hidden">
            <div className="border-b border-zinc-800 px-6 py-4">
              <h2 className="text-sm font-semibold text-zinc-100">{etapa}</h2>
            </div>
            <div className="divide-y divide-zinc-800">
              {regras.map((r) => {
                const chave = `${r.statusId}:${r.lossReasonId ?? 'null'}`;
                return (
                  <Regra
                    key={chave}
                    regra={r}
                    ocupado={salvando === chave}
                    geralLigado={geral}
                    onAlternar={(v) => void alternarRegra(r, v)}
                  />
                );
              })}
            </div>
          </section>
        ))}

        {/* OS INTOCÁVEIS. Não são configuráveis — e por isso precisam estar
            visíveis, com o porquê de cada um. */}
        {dados?.intocaveis?.length ? (
          <section className="surface p-6">
            <div className="flex items-start gap-2.5">
              <PiProhibitBold size={17} className="mt-0.5 shrink-0 text-zinc-500" />
              <div>
                <h2 className="text-sm font-semibold text-zinc-100">Motivos que nunca recebem follow-up</h2>
                <p className="mt-1 max-w-3xl text-sm leading-relaxed text-zinc-400">
                  Não têm interruptor de propósito. Insistir nestes casos não converte — gera
                  bloqueio no WhatsApp, e bloqueio derruba a reputação do número da clínica.
                </p>
              </div>
            </div>
            <ul className="mt-4 grid gap-x-8 gap-y-2 sm:grid-cols-2">
              {dados.intocaveis.map((m) => (
                <li key={m.id} className="text-xs leading-relaxed">
                  <span className="text-zinc-300">{m.nome}</span>
                  <span className="text-zinc-600"> — {m.porque}</span>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        <p className="text-xs leading-relaxed text-zinc-600">
          Todas as escadas terminam em até 20 horas porque o WhatsApp só entrega mensagem livre
          dentro de 24h desde a última fala do paciente. Depois disso só template aprovado pela
          Meta, que é pago e não aceita texto escrito na hora.
        </p>
      </div>
    </div>
  );
}

function Regra({
  regra,
  ocupado,
  geralLigado,
  onAlternar,
}: {
  regra: FollowUpRegra;
  ocupado: boolean;
  geralLigado: boolean;
  onAlternar: (v: boolean) => void;
}) {
  const [aberto, setAberto] = useState(false);
  const passos = Array.isArray(regra.steps) ? regra.steps : [];

  return (
    <div className="p-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2.5">
            <span className="text-[13px] font-medium text-zinc-100">
              {regra.lossReasonName ?? 'Regra da etapa'}
            </span>
            {regra.enabled ? (
              <span className="inline-flex items-center gap-1 text-xs text-emerald-400">
                <PiCheckCircleFill size={12} /> ligada
              </span>
            ) : (
              <span className="text-xs text-zinc-600">{regra.existe ? 'desligada' : 'não criada'}</span>
            )}
            {regra.editada && (
              <span className="inline-flex items-center gap-1 text-xs text-amber-400">
                <PiPencilSimpleBold size={11} /> editada
              </span>
            )}
          </div>
          {regra.notes && (
            <p className="mt-1 max-w-2xl text-xs leading-relaxed text-zinc-500">{regra.notes}</p>
          )}

          {/* A escada em uma linha: é o que a pessoa quer saber de relance —
              quantas mensagens e em que ritmo. */}
          <div className="mt-3 flex flex-wrap items-center gap-1.5">
            {passos.map((p, i) => (
              <span key={i} className="inline-flex items-center gap-1">
                {i > 0 && <span className="text-zinc-700">→</span>}
                <span className="inline-flex items-center gap-1 rounded-md border border-zinc-800 px-2 py-1 text-[11px] tabular-nums text-zinc-400">
                  <PiClockBold size={10} />
                  {tempoLegivel(p.aposMin)}
                </span>
              </span>
            ))}
            <button
              type="button"
              onClick={() => setAberto((v) => !v)}
              className="ml-1 text-[11px] text-zinc-500 underline-offset-2 hover:text-zinc-300 hover:underline"
            >
              {aberto ? 'esconder' : 'ver o que ela diz'}
            </button>
          </div>
        </div>

        <button
          className={regra.enabled ? 'btn-ghost' : 'btn-primary'}
          disabled={ocupado}
          onClick={() => onAlternar(!regra.enabled)}
        >
          {ocupado && <PiSpinnerGapBold size={13} className="animate-spin" />}
          {regra.enabled ? 'Desligar' : 'Ligar'}
        </button>
      </div>

      {aberto && (
        <ol className="mt-4 space-y-2.5 border-t border-zinc-800 pt-4">
          {passos.map((p, i) => (
            <li key={i} className="flex gap-3 text-xs leading-relaxed">
              <span className="shrink-0 rounded-md bg-zinc-800 px-2 py-0.5 tabular-nums text-zinc-400">
                {tempoLegivel(p.aposMin)}
              </span>
              <span className="text-zinc-400">{p.intencao}</span>
            </li>
          ))}
          <li className="pt-1 text-[11px] leading-relaxed text-zinc-600">
            Isto é a INTENÇÃO, não o texto. A Sofia escreve na hora, a partir do que aquele paciente
            contou — cinco frases prontas em sequência soariam como robô na segunda.
          </li>
        </ol>
      )}

      {regra.enabled && !geralLigado && (
        <p className="mt-3 text-[11px] text-amber-400">
          Ligada, mas nada é enviado enquanto o reengajamento geral estiver desligado.
        </p>
      )}
    </div>
  );
}

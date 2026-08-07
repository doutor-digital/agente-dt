// ============================================================================
// AgendaPanel — painel operacional da agenda + kill switch.
//
// LÓGICA DE PRODUTO
// -----------------
// Esta tela tem DOIS públicos com urgências opostas, e o desenho segue isso:
//
//   A RECEPÇÃO, no meio de um problema. O médico atrasou, a sala encheu, e ela
//   precisa parar a IA AGORA. Para essa pessoa, o botão vermelho ocupa o topo
//   inteiro, tem alvo grande e não compete com nada. Um clique, uma confirmação,
//   pronto. Nada de scroll, nada de escolher unidade, nada de ler.
//
//   QUEM CONFIGURA, uma vez. Token, fuso, horário de funcionamento e almoço
//   ficam embaixo, fora do caminho de quem está com pressa.
//
// POR QUE O KILL SWITCH EXISTE
// ----------------------------
// A API da franquia não expõe bloqueios de agenda. Quando o médico trava um
// horário à mão, ele fica invisível para nós e a IA marcaria em cima. Não há
// conserto por código — o dado não existe. A contenção é humana, e este botão
// é ela.
//
// Por isso a tela mostra `incerto` como categoria própria, em vez de somar aos
// livres: horário que o paciente desmarcou pode ter virado bloqueio médico.
// Esconder essa dúvida numa contagem de "livres" seria mentir com número.
// ============================================================================

import { useCallback, useEffect, useState } from 'react';
import {
  PiWarningCircleBold,
  PiSpinnerGapBold,
  PiArrowsClockwiseBold,
  PiArrowRightBold,
  PiPauseBold,
  PiPlayBold,
  PiCalendarBlankBold,
  PiPlugsConnectedBold,
  PiQuestionBold,
  PiLockSimpleOpenBold,
  PiBellRingingBold,
  PiRobotBold,
  PiClockBold,
} from 'react-icons/pi';
import { api } from '../lib/api';
import { BloquearIcon } from './BloquearIcon';
import { useUnit } from '../context/UnitContext';
import type { SpineStatus, SpineSchedulesResponse } from '../types/api';


export default function AgendaPanel() {
  const { selectedUnit: unit } = useUnit();
  const [status, setStatus] = useState<SpineStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [erro, setErro] = useState<string | null>(null);

  const carregar = useCallback(async () => {
    if (!unit) return;
    setLoading(true);
    setErro(null);
    try {
      setStatus(await api.spineStatus(unit.id));
    } catch (e) {
      setErro(e instanceof Error ? e.message : 'Falha ao carregar');
    } finally {
      setLoading(false);
    }
  }, [unit?.id]);

  useEffect(() => {
    void carregar();
  }, [carregar]);

  if (!unit) return <p className="text-sm text-zinc-400">Selecione um agente.</p>;

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="mx-auto max-w-[1500px] space-y-7 p-8">
        <KillSwitch unit={unit} status={status} onChange={carregar} />
        <ReminderCard unitId={unit.id} status={status} onChange={carregar} />
        {erro && (
          <div className="surface flex items-start gap-2 border-rose-500/30 p-4 text-sm text-rose-300">
            <PiWarningCircleBold size={16} className="mt-0.5 shrink-0" />
            {erro}
          </div>
        )}
        <Agenda
          unit={unit}
          paused={status?.paused ?? false}
          passoMin={status?.agenda?.slotMinutes ?? 30}
        />
        <ParaConfiguracao />
        {loading && !status && (
          <div className="surface flex items-center justify-center p-10 text-zinc-500">
            <PiSpinnerGapBold size={18} className="animate-spin" />
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Esta tela é do dia a dia da recepção. Token, horários da clínica e
 * espelhamento de leads são decisões que se toma uma vez e moram em CRM da
 * franquia — deixá-las aqui enterrava a configuração embaixo do calendário e
 * criava dois lugares salvando o mesmo campo.
 */
function ParaConfiguracao() {
  return (
    <a
      href="/crm-franquia"
      className="surface flex items-center gap-3 p-5 transition-colors hover:border-zinc-700"
    >
      <PiPlugsConnectedBold size={18} className="shrink-0 text-zinc-500" />
      <span className="min-w-0">
        <span className="block text-sm font-medium text-zinc-200">CRM da franquia</span>
        <span className="block text-xs leading-relaxed text-zinc-500">
          Token, horários da clínica, fuso e espelhamento de leads.
        </span>
      </span>
      <PiArrowRightBold size={14} className="ml-auto shrink-0 text-zinc-600" />
    </a>
  );
}

// ---------------------------------------------------------------------------
// O botão
// ---------------------------------------------------------------------------

function KillSwitch({
  unit,
  status,
  onChange,
}: {
  unit: { id: string; name: string };
  status: SpineStatus | null;
  onChange: () => Promise<void>;
}) {
  const [confirmando, setConfirmando] = useState(false);
  const [ocupado, setOcupado] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const pausada = status?.paused ?? false;

  async function acionar(pausar: boolean) {
    setOcupado(true);
    setErro(null);
    try {
      if (pausar) await api.emergencyPause(unit.id);
      else await api.resumeAi(unit.id);
      await onChange();
      setConfirmando(false);
    } catch (e) {
      setErro(e instanceof Error ? e.message : 'Falha ao acionar');
    } finally {
      setOcupado(false);
    }
  }

  return (
    <section
      className={`surface overflow-hidden ${
        pausada ? 'border-rose-500/40' : 'border-emerald-500/25'
      }`}
    >
      <div className="flex flex-wrap items-center justify-between gap-4 p-6">
        <div className="flex items-center gap-4">
          {/* O indicador pisca só quando está pausado. Piscar no estado normal
              treinaria a recepção a ignorar o movimento — e aí ele não avisa
              mais nada quando importa. */}
          <span
            className={`inline-flex h-3.5 w-3.5 rounded-full ${
              pausada ? 'animate-pulse bg-rose-500' : 'bg-emerald-500'
            }`}
          />
          <div>
            <p
              className={`text-xl font-semibold tracking-tight ${
                pausada ? 'text-rose-300' : 'text-emerald-300'
              }`}
            >
              {pausada ? 'I.A. PAUSADA' : 'I.A. ATIVA'}
            </p>
            <p className="mt-0.5 text-sm text-zinc-400">
              {pausada
                ? status?.pausedReason
                  ? `${status.pausedReason} · desde ${new Date(status.pausedAt ?? '').toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}`
                  : 'Nenhum agendamento novo será feito'
                : `${unit.name} — agendando normalmente`}
            </p>
          </div>
        </div>

        {pausada ? (
          <button
            onClick={() => void acionar(false)}
            disabled={ocupado}
            className="inline-flex items-center gap-2 rounded-xl bg-emerald-600 px-6 py-4 text-base font-semibold text-white transition-colors hover:bg-emerald-500 disabled:opacity-50"
          >
            {ocupado ? (
              <PiSpinnerGapBold size={20} className="animate-spin" />
            ) : (
              <PiPlayBold size={20} />
            )}
            Reativar I.A.
          </button>
        ) : (
          <button
            onClick={() => setConfirmando(true)}
            disabled={ocupado}
            className="inline-flex items-center gap-2 rounded-xl bg-rose-600 px-7 py-4 text-base font-bold uppercase tracking-wide text-white shadow-lg shadow-rose-900/40 transition-colors hover:bg-rose-500 disabled:opacity-50"
          >
            <PiPauseBold size={20} />
            Pausar I.A. (Intercorrência)
          </button>
        )}
      </div>

      {erro && <p className="px-6 pb-4 text-sm text-rose-300">{erro}</p>}

      {confirmando && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
          <div className="surface w-full max-w-md p-6">
            <h2 className="text-lg font-semibold text-zinc-100">Pausar os agendamentos da I.A.?</h2>
            <p className="mt-2 text-sm leading-relaxed text-zinc-400">
              A I.A. para de marcar imediatamente. As conversas em andamento continuam — ela
              apenas não fecha horário novo até você reativar.
            </p>
            <div className="mt-5 flex gap-3">
              <button
                onClick={() => void acionar(true)}
                disabled={ocupado}
                className="inline-flex flex-1 items-center justify-center gap-2 rounded-lg bg-rose-600 px-4 py-3 font-semibold text-white hover:bg-rose-500 disabled:opacity-50"
              >
                {ocupado ? <PiSpinnerGapBold size={16} className="animate-spin" /> : <PiPauseBold size={16} />}
                Sim, pausar agora
              </button>
              <button className="btn-ghost" onClick={() => setConfirmando(false)} disabled={ocupado}>
                Cancelar
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Agenda do dia
// ---------------------------------------------------------------------------

function Agenda({
  unit,
  paused,
  passoMin,
}: {
  unit: { id: string };
  paused: boolean;
  passoMin: number;
}) {
  const [dia, setDia] = useState(() => new Date().toISOString().slice(0, 10));
  const [dados, setDados] = useState<SpineSchedulesResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const [salvandoBloco, setSalvandoBloco] = useState<string | null>(null);
  // Slot escolhido para bloquear, aguardando o motivo.
  const [aBloquear, setABloquear] = useState<{ day: string; time: string } | null>(null);
  const [motivo, setMotivo] = useState('');
  const [ateHora, setAteHora] = useState('');
  const [periodo, setPeriodo] = useState(false);

  const buscar = useCallback(async () => {
    setLoading(true);
    setErro(null);
    try {
      setDados(await api.spineSchedules(unit.id, { initialDate: dia, endDate: dia }));
    } catch (e) {
      setErro(e instanceof Error ? e.message : 'Falha ao consultar a agenda');
      setDados(null);
    } finally {
      setLoading(false);
    }
  }, [unit.id, dia]);

  useEffect(() => {
    void buscar();
  }, [buscar]);

  /**
   * Bloquear é o oposto de pausar: cirúrgico em vez de nuclear. O horário sai
   * da oferta da I.A. e o resto do dia segue funcionando.
   */
  async function alternarBloqueio(slot: { day: string; time: string; status: string }) {
    const chave = `${slot.day}-${slot.time}`;
    setSalvandoBloco(chave);
    setErro(null);
    try {
      if (slot.status === 'bloqueado') {
        const b = dados?.blocks.find(
          (x) => x.dayLocal === slot.day && slot.time >= x.startTime && slot.time < x.endTime,
        );
        if (b) await api.unblockAgenda(unit.id, b.id);
      } else {
        // Bloquear ABRE O MODAL em vez de gravar direto. O motivo não é
        // burocracia: quem vê "14:00 bloqueado" amanhã precisa saber se pode
        // desfazer. Sem ele, o bloqueio vira mistério e alguém libera na
        // dúvida — justo o horário que não podia ser oferecido.
        const [h, m] = slot.time.split(':').map(Number);
        const fimMin = h * 60 + m + passoMin;
        setABloquear({ day: slot.day, time: slot.time });
        setMotivo('');
        setAteHora(
          `${String(Math.floor(fimMin / 60)).padStart(2, '0')}:${String(fimMin % 60).padStart(2, '0')}`,
        );
        setSalvandoBloco(null);
        return;
      }
      await buscar();
    } catch (e) {
      setErro(e instanceof Error ? e.message : 'Falha ao alterar o bloqueio');
    } finally {
      setSalvandoBloco(null);
    }
  }

  async function confirmarBloqueio() {
    if (!aBloquear) return;
    setSalvandoBloco(`${aBloquear.day}-${aBloquear.time}`);
    setErro(null);
    try {
      await api.blockAgenda(unit.id, {
        dayLocal: aBloquear.day,
        startTime: aBloquear.time,
        endTime: ateHora,
        reason: motivo.trim() || null,
      });
      setABloquear(null);
      await buscar();
    } catch (e) {
      setErro(e instanceof Error ? e.message : 'Falha ao bloquear');
    } finally {
      setSalvandoBloco(null);
    }
  }

  async function removerBloco(id: string) {
    setErro(null);
    try {
      await api.unblockAgenda(unit.id, id);
      await buscar();
    } catch (e) {
      setErro(e instanceof Error ? e.message : 'Falha ao liberar');
    }
  }

  return (
    <section className="surface p-7">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 text-sm font-semibold text-zinc-100">
            <PiCalendarBlankBold size={15} /> Agenda
          </h2>
          <p className="mt-1 text-sm text-zinc-400">
            Horários deduzidos do histórico da franquia — a API não informa bloqueios.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <input
            type="date"
            className="field w-auto"
            value={dia}
            onChange={(e) => setDia(e.target.value)}
          />
          <button className="btn-ghost" onClick={() => setPeriodo(true)}>
            <BloquearIcon size={14} />
            Bloquear período
          </button>
          <button className="btn-ghost" onClick={() => void buscar()} disabled={loading}>
            {loading ? (
              <PiSpinnerGapBold size={14} className="animate-spin" />
            ) : (
              <PiArrowsClockwiseBold size={14} />
            )}
            Atualizar
          </button>
        </div>
      </div>

      {erro && (
        <p className="mt-4 flex items-start gap-2 text-sm text-rose-300">
          <PiWarningCircleBold size={15} className="mt-0.5 shrink-0" />
          {erro}
        </p>
      )}

      {dados && (
        <>
          <div className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Tile label="Livres" valor={dados.resumo.livres} cor="text-emerald-400" />
            <Tile label="Ocupados" valor={dados.resumo.ocupados} cor="text-zinc-400" />
            <Tile
              label="Precisam de conferência"
              valor={dados.resumo.incertos}
              cor="text-amber-400"
              hint="paciente desmarcou — pode ter virado bloqueio"
            />
            <Tile
              label="Bloqueados por você"
              valor={dados.resumo.bloqueados ?? 0}
              cor="text-rose-400"
              hint="a I.A. não oferece"
            />
          </div>

          <p className="mt-5 text-xs text-zinc-500">
            Clique num horário para bloquear — a I.A. deixa de oferecê-lo. Clique de novo para
            liberar. É assim que se registra o que a franquia não conta: intercorrência, reunião,
            médico que saiu.
          </p>

          <div className="mt-3 flex flex-wrap gap-2">
            {dados.slots.length === 0 && (
              <p className="text-sm text-zinc-500">
                Nenhum horário nesta data — fora dos dias de atendimento, ou tudo já passou.
              </p>
            )}
            {dados.slots.map((s) => {
              const bloqueado = s.status === 'bloqueado';
              const podeClicar = s.status === 'livre' || bloqueado || s.status === 'incerto';
              return (
                <button
                  key={`${s.day}-${s.time}`}
                  type="button"
                  title={s.motivo ?? 'livre — clique para bloquear'}
                  disabled={!podeClicar || salvandoBloco === `${s.day}-${s.time}`}
                  onClick={() => void alternarBloqueio(s)}
                  className={`inline-flex items-center gap-1 rounded-lg px-3 py-1.5 text-sm font-medium tabular-nums ring-1 transition-colors ${
                    bloqueado
                      ? 'bg-rose-500/15 text-rose-300 ring-rose-500/30 hover:bg-rose-500/25'
                      : s.status === 'livre'
                        ? 'bg-emerald-500/10 text-emerald-300 ring-emerald-500/25 hover:bg-emerald-500/20'
                        : s.status === 'ocupado'
                          ? 'cursor-default bg-zinc-800 text-zinc-500 ring-zinc-700 line-through'
                          : 'bg-amber-500/10 text-amber-300 ring-amber-500/25 hover:bg-amber-500/20'
                  }`}
                >
                  {s.time}
                  {bloqueado && <BloquearIcon size={12} />}
                  {s.status === 'incerto' && <PiQuestionBold size={11} />}
                </button>
              );
            })}
          </div>

          {dados.blocks.length > 0 && (
            <div className="mt-5 rounded-lg border border-zinc-800 p-4">
              <p className="flex items-center gap-1.5 text-xs font-medium text-zinc-300">
                <BloquearIcon size={13} /> Bloqueios deste dia
              </p>
              <ul className="mt-2 space-y-1.5">
                {dados.blocks.map((b) => (
                  <li key={b.id} className="flex items-center gap-2 text-xs text-zinc-400">
                    <span className="tabular-nums text-zinc-300">
                      {b.startTime}–{b.endTime}
                    </span>
                    <span className="truncate">{b.reason || 'sem motivo informado'}</span>
                    {b.createdBy && <span className="text-zinc-600">· {b.createdBy}</span>}
                    <button
                      className="ml-auto inline-flex items-center gap-1 text-zinc-500 hover:text-emerald-400"
                      onClick={() => void removerBloco(b.id)}
                    >
                      <PiLockSimpleOpenBold size={12} /> liberar
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {paused && (
            <p className="mt-4 text-xs text-rose-300">
              A I.A. está pausada — estes horários não estão sendo oferecidos a ninguém.
            </p>
          )}
        </>
      )}

      {periodo && (
        <BloqueioEmLote
          unitId={unit.id}
          diaBase={dia}
          onFechar={() => setPeriodo(false)}
          onPronto={async () => {
            setPeriodo(false);
            await buscar();
          }}
        />
      )}

      {aBloquear && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
          <div className="surface w-full max-w-md p-6">
            <h3 className="flex items-center gap-2 text-base font-semibold text-zinc-100">
              <BloquearIcon size={18} />
              Bloquear {aBloquear.time} de {aBloquear.day.split('-').reverse().join('/')}
            </h3>
            <p className="mt-1.5 text-sm leading-relaxed text-zinc-400">
              A I.A. deixa de oferecer este horário. O resto do dia continua funcionando.
            </p>

            <label className="mt-4 block">
              <span className="text-xs font-medium text-zinc-300">Bloquear até</span>
              <input
                type="time"
                className="field mt-1"
                value={ateHora}
                onChange={(e) => setAteHora(e.target.value)}
              />
              <span className="mt-1 block text-[11px] text-zinc-500">
                Para bloquear várias horas seguidas, estenda este horário.
              </span>
            </label>

            <label className="mt-4 block">
              <span className="text-xs font-medium text-zinc-300">Motivo</span>
              <input
                className="field mt-1"
                value={motivo}
                autoFocus
                placeholder="ex: médico em cirurgia"
                onChange={(e) => setMotivo(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void confirmarBloqueio();
                }}
              />
              <span className="mt-1 block text-[11px] leading-relaxed text-zinc-500">
                Quem olhar amanhã precisa saber se pode liberar. Sem motivo, alguém libera na
                dúvida — e justo o horário que não podia ser oferecido volta pra fila.
              </span>
            </label>

            <div className="mt-3 flex flex-wrap gap-1.5">
              {['Intercorrência', 'Médico em cirurgia', 'Reunião', 'Ausência', 'Encaixe manual'].map(
                (m) => (
                  <button
                    key={m}
                    type="button"
                    onClick={() => setMotivo(m)}
                    className={`rounded-lg px-2.5 py-1 text-xs ring-1 transition-colors ${
                      motivo === m
                        ? 'bg-zinc-800 text-zinc-100 ring-zinc-700'
                        : 'text-zinc-400 ring-zinc-800 hover:text-zinc-200'
                    }`}
                  >
                    {m}
                  </button>
                ),
              )}
            </div>

            <div className="mt-5 flex gap-3">
              <button
                className="inline-flex flex-1 items-center justify-center gap-2 rounded-lg bg-rose-600 px-4 py-2.5 font-semibold text-white hover:bg-rose-500 disabled:opacity-50"
                onClick={() => void confirmarBloqueio()}
                disabled={salvandoBloco !== null}
              >
                {salvandoBloco ? (
                  <PiSpinnerGapBold size={16} className="animate-spin" />
                ) : (
                  <BloquearIcon size={16} inner="#fff" />
                )}
                Bloquear
              </button>
              <button className="btn-ghost" onClick={() => setABloquear(null)}>
                Cancelar
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

function Tile({
  label,
  valor,
  cor,
  hint,
}: {
  label: string;
  valor: number;
  cor: string;
  hint?: string;
}) {
  return (
    <div className="rounded-xl border border-zinc-800 p-4">
      <p className="text-xs text-zinc-400">{label}</p>
      <p className={`mt-1 text-2xl font-semibold tabular-nums ${cor}`}>{valor}</p>
      {hint && <p className="mt-1 text-[11px] leading-relaxed text-zinc-600">{hint}</p>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Bloqueio em lote
// ---------------------------------------------------------------------------
// Clicar horário por horário serve pra "das 14h às 15h de quinta". Não serve
// pra recesso, congresso ou férias: uma semana em blocos de 30 min são ~180
// cliques. Quem precisa disso e não tem essa tela acaba usando o kill switch,
// que para a I.A. inteira — inclusive nos dias em que ela poderia atender.

const SEMANA = [
  { n: 1, label: 'Seg' },
  { n: 2, label: 'Ter' },
  { n: 3, label: 'Qua' },
  { n: 4, label: 'Qui' },
  { n: 5, label: 'Sex' },
  { n: 6, label: 'Sáb' },
  { n: 0, label: 'Dom' },
];

function BloqueioEmLote({
  unitId,
  diaBase,
  onFechar,
  onPronto,
}: {
  unitId: string;
  diaBase: string;
  onFechar: () => void;
  onPronto: () => Promise<void>;
}) {
  const [de, setDe] = useState(diaBase);
  const [ate, setAte] = useState(diaBase);
  const [diaInteiro, setDiaInteiro] = useState(true);
  const [inicio, setInicio] = useState('08:00');
  const [fim, setFim] = useState('18:00');
  const [dias, setDias] = useState<number[]>([1, 2, 3, 4, 5]);
  const [motivo, setMotivo] = useState('');
  const [ocupado, setOcupado] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const [feito, setFeito] = useState<string | null>(null);

  async function bloquear() {
    setOcupado(true);
    setErro(null);
    setFeito(null);
    try {
      const r = await api.blockAgendaBulk(unitId, {
        fromDay: de,
        toDay: ate,
        startTime: diaInteiro ? '00:00' : inicio,
        endTime: diaInteiro ? '23:59' : fim,
        weekdays: dias.length > 0 && dias.length < 7 ? dias : undefined,
        reason: motivo.trim() || null,
      });
      setFeito(`${r.dias} dia(s) bloqueado(s).`);
      await onPronto();
    } catch (e) {
      setErro(e instanceof Error ? e.message : 'Falha ao bloquear o período');
    } finally {
      setOcupado(false);
    }
  }

  async function liberar() {
    setOcupado(true);
    setErro(null);
    setFeito(null);
    try {
      const r = await api.unblockAgendaBulk(unitId, { fromDay: de, toDay: ate });
      setFeito(`${r.removidos} bloqueio(s) removido(s).`);
      await onPronto();
    } catch (e) {
      setErro(e instanceof Error ? e.message : 'Falha ao liberar');
    } finally {
      setOcupado(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
      <div className="surface max-h-[90vh] w-full max-w-lg overflow-y-auto p-6">
        <h3 className="flex items-center gap-2 text-base font-semibold text-zinc-100">
          <BloquearIcon size={18} /> Bloquear um período
        </h3>
        <p className="mt-1.5 text-sm leading-relaxed text-zinc-400">
          Para recesso, congresso, férias ou reforma — de uma vez, sem clicar dia a dia.
        </p>

        <div className="mt-5 grid gap-4 sm:grid-cols-2">
          <label className="block">
            <span className="text-xs font-medium text-zinc-300">De</span>
            <input type="date" className="field mt-1" value={de} onChange={(e) => setDe(e.target.value)} />
          </label>
          <label className="block">
            <span className="text-xs font-medium text-zinc-300">Até</span>
            <input type="date" className="field mt-1" value={ate} onChange={(e) => setAte(e.target.value)} />
          </label>
        </div>

        <button
          type="button"
          onClick={() => setDiaInteiro(!diaInteiro)}
          className="mt-4 flex w-full items-start gap-3 rounded-lg border border-zinc-800 p-3 text-left transition-colors hover:bg-zinc-900"
        >
          <span
            className={`mt-0.5 inline-flex h-5 w-9 shrink-0 items-center rounded-full p-0.5 transition-colors ${
              diaInteiro ? 'bg-rose-500' : 'bg-zinc-700'
            }`}
          >
            <span
              className={`h-4 w-4 rounded-full bg-white transition-transform ${diaInteiro ? 'translate-x-4' : ''}`}
            />
          </span>
          <span>
            <span className="block text-sm font-medium text-zinc-200">Dia inteiro</span>
            <span className="mt-0.5 block text-xs text-zinc-400">
              Desligue para bloquear só uma faixa de horário em cada dia.
            </span>
          </span>
        </button>

        {!diaInteiro && (
          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            <label className="block">
              <span className="text-xs font-medium text-zinc-300">A partir de</span>
              <input type="time" className="field mt-1" value={inicio} onChange={(e) => setInicio(e.target.value)} />
            </label>
            <label className="block">
              <span className="text-xs font-medium text-zinc-300">Até</span>
              <input type="time" className="field mt-1" value={fim} onChange={(e) => setFim(e.target.value)} />
            </label>
          </div>
        )}

        <div className="mt-4">
          <span className="text-xs font-medium text-zinc-300">Só nestes dias da semana</span>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {SEMANA.map((d) => {
              const on = dias.includes(d.n);
              return (
                <button
                  key={d.n}
                  type="button"
                  onClick={() => setDias(on ? dias.filter((x) => x !== d.n) : [...dias, d.n])}
                  className={`rounded-lg px-3 py-1.5 text-xs font-medium ring-1 transition-colors ${
                    on ? 'bg-rose-500/10 text-rose-300 ring-rose-500/30' : 'text-zinc-500 ring-zinc-800 hover:text-zinc-300'
                  }`}
                >
                  {d.label}
                </button>
              );
            })}
          </div>
          <span className="mt-1.5 block text-[11px] leading-relaxed text-zinc-500">
            Evita criar bloqueio inútil em dia que a clínica já não atende.
          </span>
        </div>

        <label className="mt-4 block">
          <span className="text-xs font-medium text-zinc-300">Motivo</span>
          <input
            className="field mt-1"
            value={motivo}
            placeholder="ex: recesso de fim de ano"
            onChange={(e) => setMotivo(e.target.value)}
          />
        </label>
        <div className="mt-2 flex flex-wrap gap-1.5">
          {['Recesso', 'Férias', 'Congresso', 'Feriado', 'Reforma'].map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => setMotivo(m)}
              className={`rounded-lg px-2.5 py-1 text-xs ring-1 transition-colors ${
                motivo === m ? 'bg-zinc-800 text-zinc-100 ring-zinc-700' : 'text-zinc-400 ring-zinc-800 hover:text-zinc-200'
              }`}
            >
              {m}
            </button>
          ))}
        </div>

        {erro && <p className="mt-3 text-xs text-rose-300">{erro}</p>}
        {feito && <p className="mt-3 text-xs text-emerald-400">{feito}</p>}

        <div className="mt-5 flex flex-wrap gap-3">
          <button
            className="inline-flex flex-1 items-center justify-center gap-2 rounded-lg bg-rose-600 px-4 py-2.5 font-semibold text-white hover:bg-rose-500 disabled:opacity-50"
            onClick={() => void bloquear()}
            disabled={ocupado}
          >
            {ocupado ? <PiSpinnerGapBold size={16} className="animate-spin" /> : <BloquearIcon size={16} />}
            Bloquear período
          </button>
          {/* Desfazer precisa ser tão barato quanto fazer — senão um intervalo
              digitado errado vira trabalho manual de limpeza. */}
          <button className="btn-ghost" onClick={() => void liberar()} disabled={ocupado}>
            <PiLockSimpleOpenBold size={14} /> Liberar período
          </button>
          <button className="btn-ghost" onClick={onFechar} disabled={ocupado}>
            Fechar
          </button>
        </div>
      </div>
    </div>
  );
}


// ---------------------------------------------------------------------------
// Espelhar leads no CRM da franquia
// ---------------------------------------------------------------------------
// Controle SEPARADO do da agenda, e isso não é preciosismo: consultar a agenda
// é leitura e não deixa rastro; criar lead é escrita PERMANENTE — a API da
// franquia não tem exclusão de lead. Ligar a agenda não pode significar, de
// tabela, começar a escrever no CRM do cliente.
//
// Por isso a tela explica ANTES de ligar o que exatamente vai acontecer, e
// mostra o histórico depois: sem ele, "está sincronizando?" não tem resposta.

// ---------------------------------------------------------------------------
// ReminderCard — o lembrete de véspera, visível e operável no painel.
//
// Antes isso vivia só no banco (reminder_enabled etc.) e ninguém via o que
// estava ligado. Aqui o operador vê o estado, entende o que o worker faz, e
// liga/desliga sem depender de dev — e sem poder ligar "no vazio" (o backend
// recusa ligar sem Salesbot).
// ---------------------------------------------------------------------------
function ReminderCard({
  unitId,
  status,
  onChange,
}: {
  unitId: string;
  status: SpineStatus | null;
  onChange: () => void;
}) {
  const [salvando, setSalvando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const r = status?.reminder;
  if (!r) return null;

  const ligado = r.enabled;
  const podeeLigar = !r.bloqueado;

  async function toggle() {
    setErro(null);
    setSalvando(true);
    try {
      await api.updateReminder(unitId, { enabled: !ligado });
      onChange();
    } catch (e) {
      const msg = (e as { response?: { data?: { motivo?: string } } })?.response?.data?.motivo;
      setErro(msg ?? 'Não consegui alterar. Tente de novo.');
    } finally {
      setSalvando(false);
    }
  }

  return (
    <section className="surface p-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-4">
          <div
            className={`grid size-11 place-items-center rounded-xl ${
              ligado ? 'bg-emerald-500/15 text-emerald-400' : 'bg-zinc-800 text-zinc-500'
            }`}
          >
            <PiBellRingingBold size={22} />
          </div>
          <div>
            <p className="text-sm font-semibold text-zinc-100">Lembrete de véspera</p>
            <p className="mt-0.5 text-xs text-zinc-400">
              {ligado
                ? 'Ativo — todo dia às ' +
                  String(r.hourLocal).padStart(2, '0') +
                  'h o sistema avisa quem tem consulta amanhã.'
                : 'Desligado — nenhum lembrete é enviado.'}
            </p>
          </div>
        </div>

        <button
          type="button"
          onClick={toggle}
          disabled={salvando || (!ligado && !podeeLigar)}
          className={`inline-flex items-center gap-2 rounded-xl px-6 py-3 text-sm font-semibold text-white transition-colors disabled:opacity-50 ${
            ligado ? 'bg-rose-600 hover:bg-rose-500' : 'bg-emerald-600 hover:bg-emerald-500'
          }`}
        >
          {salvando ? (
            <PiSpinnerGapBold size={18} className="animate-spin" />
          ) : ligado ? (
            <PiPauseBold size={18} />
          ) : (
            <PiPlayBold size={18} />
          )}
          {ligado ? 'Desligar' : 'Ligar lembrete'}
        </button>
      </div>

      {/* Estado detalhado — o que uma consultoria perguntaria "está configurado?" */}
      <div className="mt-5 grid gap-3 sm:grid-cols-3">
        <Info
          icon={<PiRobotBold size={15} />}
          label="Bot do Kommo"
          value={r.salesbotId ? `#${r.salesbotId}` : 'não configurado'}
          ok={!!r.salesbotId}
        />
        <Info
          icon={<PiClockBold size={15} />}
          label="Horário do disparo"
          value={`${String(r.hourLocal).padStart(2, '0')}:00 (véspera)`}
          ok
        />
        <Info
          icon={<PiCalendarBlankBold size={15} />}
          label="Fonte da data"
          value="campo Data da Consulta"
          ok
        />
      </div>

      {r.bloqueado && (
        <p className="mt-4 flex items-center gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-300">
          <PiWarningCircleBold size={14} className="shrink-0" />
          Não dispara: {r.bloqueado}.
        </p>
      )}
      {erro && <p className="mt-3 text-xs text-rose-300">{erro}</p>}

      <p className="mt-4 text-[11px] leading-relaxed text-zinc-500">
        Como funciona: o sistema lê a agenda da franquia ao vivo, pega o horário
        atual de cada consulta de amanhã (mesmo que a recepção tenha remarcado) e
        aciona o bot, que envia o template aprovado com os botões “Confirmar
        presença” e “Remarcar consulta”.
      </p>
    </section>
  );
}

function Info({
  icon,
  label,
  value,
  ok,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  ok: boolean;
}) {
  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-3">
      <div className="flex items-center gap-1.5 text-[11px] uppercase tracking-wide text-zinc-500">
        {icon}
        {label}
      </div>
      <div className={`mt-1 text-sm font-medium ${ok ? 'text-zinc-100' : 'text-amber-300'}`}>
        {value}
      </div>
    </div>
  );
}

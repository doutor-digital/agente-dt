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
  PiCheckBold,
  PiCheckCircleFill,
  PiSpinnerGapBold,
  PiArrowsClockwiseBold,
  PiArrowRightBold,
  PiPauseBold,
  PiPlayBold,
  PiCalendarBlankBold,
  PiPlugsConnectedBold,
  PiQuestionBold,
  PiLockSimpleOpenBold,
} from 'react-icons/pi';
import { api } from '../lib/api';
import { BloquearIcon } from './BloquearIcon';
import { useUnit } from '../context/UnitContext';
import type { SpineStatus, SpineSchedulesResponse, SpineLeadLinksResponse } from '../types/api';

const DIAS = [
  { n: 0, label: 'Dom' },
  { n: 1, label: 'Seg' },
  { n: 2, label: 'Ter' },
  { n: 3, label: 'Qua' },
  { n: 4, label: 'Qui' },
  { n: 5, label: 'Sex' },
  { n: 6, label: 'Sáb' },
];

export default function AgendaPanel() {
  const { selectedUnit: unit, refresh } = useUnit();
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
        <Configuracao unit={unit} status={status} onSaved={async () => {
          await refresh();
          await carregar();
        }} />
        <EspelharLeads unit={unit} status={status} onSaved={async () => {
          await refresh();
          await carregar();
        }} />
        {loading && !status && (
          <div className="surface flex items-center justify-center p-10 text-zinc-500">
            <PiSpinnerGapBold size={18} className="animate-spin" />
          </div>
        )}
      </div>
    </div>
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
// Configuração
// ---------------------------------------------------------------------------

function Configuracao({
  unit,
  status,
  onSaved,
}: {
  unit: {
    id: string;
    spineEnabled?: boolean;
    spineBaseUrl?: string;
    spineToken?: string | null;
    spineTimezone?: string;
    spineAgendaStart?: string;
    spineAgendaEnd?: string;
    spineLunchStart?: string | null;
    spineLunchEnd?: string | null;
    spineAgendaDays?: number[];
    spineSlotMinutes?: number;
  };
  status: SpineStatus | null;
  onSaved: () => Promise<void>;
}) {
  // TODO CAMPO COM DEFAULT. O painel e o backend sobem por pipelines
  // diferentes (Vercel e VPS), então existe uma janela de minutos em que o
  // front novo conversa com uma API que ainda não devolve estes campos.
  // Sem os defaults, `spineAgendaDays.includes(...)` explode e a tela inteira
  // fica branca — falha total por causa de um campo ausente.
  const [d, setD] = useState({
    spineEnabled: unit.spineEnabled ?? false,
    spineBaseUrl: unit.spineBaseUrl ?? 'https://app-api-prod.doutorhernia.com.br',
    spineToken: '',
    spineTimezone: unit.spineTimezone ?? 'America/Sao_Paulo',
    spineAgendaStart: unit.spineAgendaStart ?? '08:00',
    spineAgendaEnd: unit.spineAgendaEnd ?? '18:00',
    spineLunchStart: unit.spineLunchStart ?? '',
    spineLunchEnd: unit.spineLunchEnd ?? '',
    spineAgendaDays: unit.spineAgendaDays ?? [1, 2, 3, 4, 5],
    spineSlotMinutes: unit.spineSlotMinutes ?? 30,
  });
  const [salvando, setSalvando] = useState(false);
  const [salvo, setSalvo] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const [ping, setPing] = useState<{ ok: boolean; msg: string } | null>(null);
  const [testando, setTestando] = useState(false);

  async function salvar() {
    setSalvando(true);
    setErro(null);
    setSalvo(false);
    try {
      const payload: Record<string, unknown> = {
        spineEnabled: d.spineEnabled,
        spineBaseUrl: d.spineBaseUrl,
        spineTimezone: d.spineTimezone,
        spineAgendaStart: d.spineAgendaStart,
        spineAgendaEnd: d.spineAgendaEnd,
        spineLunchStart: d.spineLunchStart || null,
        spineLunchEnd: d.spineLunchEnd || null,
        spineAgendaDays: d.spineAgendaDays,
        spineSlotMinutes: d.spineSlotMinutes,
      };
      // Token em branco = manter o que está salvo. A API devolve mascarado,
      // então mandar '' apagaria a credencial da franquia.
      if (d.spineToken.trim()) payload.spineToken = d.spineToken.trim();
      await api.updateUnit(unit.id, payload);
      await onSaved();
      setD((x) => ({ ...x, spineToken: '' }));
      setSalvo(true);
      setTimeout(() => setSalvo(false), 2500);
    } catch (e) {
      setErro(e instanceof Error ? e.message : 'Falha ao salvar');
    } finally {
      setSalvando(false);
    }
  }

  async function testar() {
    setTestando(true);
    setPing(null);
    try {
      const r = await api.spinePing(unit.id);
      setPing({ ok: r.ok, msg: r.ok ? 'Token válido, API respondendo.' : (r.error ?? 'falhou') });
    } catch (e) {
      setPing({ ok: false, msg: e instanceof Error ? e.message : 'falhou' });
    } finally {
      setTestando(false);
    }
  }

  return (
    <section className="surface p-7">
      <h2 className="text-sm font-semibold text-zinc-100">Conexão com a franquia</h2>
      <p className="mt-1 text-sm text-zinc-400">
        Token da API Spine e janela de atendimento da clínica.
      </p>

      <div className="mt-5 grid gap-5 lg:grid-cols-2">
        <label className="block">
          <span className="flex items-center gap-2 text-xs font-medium text-zinc-300">
            Token da API Spine
            {status?.hasToken && (
              <span className="inline-flex items-center gap-1 text-[10px] font-normal text-emerald-400">
                <PiCheckCircleFill size={11} /> salvo
              </span>
            )}
          </span>
          <input
            type="password"
            className="field mt-1"
            value={d.spineToken}
            placeholder={status?.hasToken ? '•••••••• (deixe vazio pra manter)' : 'cole o token aqui'}
            onChange={(e) => setD({ ...d, spineToken: e.target.value })}
          />
          <span className="mt-1 block text-[11px] leading-relaxed text-zinc-500">
            Pedido ao suporte da franquia. Fica só no servidor — nunca é exposto no navegador.
          </span>
        </label>

        <label className="block">
          <span className="text-xs font-medium text-zinc-300">Ambiente</span>
          <select
            className="field mt-1"
            value={d.spineBaseUrl}
            onChange={(e) => setD({ ...d, spineBaseUrl: e.target.value })}
          >
            <option value="https://app-api-prod.doutorhernia.com.br">Produção</option>
            <option value="https://app-api-hom.doutorhernia.com.br">Homologação</option>
          </select>
          <span className="mt-1 block text-[11px] text-zinc-500">
            Teste em homologação antes de apontar pra produção.
          </span>
        </label>
      </div>

      <div className="mt-3 flex items-center gap-3">
        <button className="btn-ghost" onClick={() => void testar()} disabled={testando}>
          {testando ? (
            <PiSpinnerGapBold size={14} className="animate-spin" />
          ) : (
            <PiPlugsConnectedBold size={14} />
          )}
          Testar conexão
        </button>
        {ping && (
          <span className={`text-xs ${ping.ok ? 'text-emerald-400' : 'text-rose-300'}`}>
            {ping.msg}
          </span>
        )}
      </div>

      <div className="mt-6 border-t border-zinc-800 pt-6">
        <h3 className="text-sm font-semibold text-zinc-100">Quando a clínica atende</h3>
        <p className="mt-1 text-sm text-zinc-400">
          A I.A. não oferece horário fora desta janela nem dentro do almoço.
        </p>

        <div className="mt-4 grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
          <Hora label="Abre" v={d.spineAgendaStart} on={(v) => setD({ ...d, spineAgendaStart: v })} />
          <Hora label="Fecha" v={d.spineAgendaEnd} on={(v) => setD({ ...d, spineAgendaEnd: v })} />
          <Hora
            label="Almoço começa"
            v={d.spineLunchStart}
            on={(v) => setD({ ...d, spineLunchStart: v })}
          />
          <Hora label="Almoço termina" v={d.spineLunchEnd} on={(v) => setD({ ...d, spineLunchEnd: v })} />
        </div>

        <div className="mt-5 grid gap-5 sm:grid-cols-2">
          <div>
            <span className="text-xs font-medium text-zinc-300">Dias de atendimento</span>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {DIAS.map((dia) => {
                const ativo = (d.spineAgendaDays ?? []).includes(dia.n);
                return (
                  <button
                    key={dia.n}
                    type="button"
                    onClick={() =>
                      setD({
                        ...d,
                        spineAgendaDays: ativo
                          ? (d.spineAgendaDays ?? []).filter((x) => x !== dia.n)
                          : [...(d.spineAgendaDays ?? []), dia.n].sort(),
                      })
                    }
                    className={`rounded-lg px-3 py-1.5 text-xs font-medium ring-1 transition-colors ${
                      ativo
                        ? 'bg-emerald-500/10 text-emerald-300 ring-emerald-500/25'
                        : 'text-zinc-500 ring-zinc-800 hover:text-zinc-300'
                    }`}
                  >
                    {dia.label}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="grid gap-5 sm:grid-cols-2">
            <label className="block">
              <span className="text-xs font-medium text-zinc-300">Duração do horário</span>
              <select
                className="field mt-1"
                value={d.spineSlotMinutes}
                onChange={(e) => setD({ ...d, spineSlotMinutes: Number(e.target.value) })}
              >
                {[15, 20, 30, 45, 60].map((m) => (
                  <option key={m} value={m}>
                    {m} min
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="text-xs font-medium text-zinc-300">Fuso da clínica</span>
              <select
                className="field mt-1"
                value={d.spineTimezone}
                onChange={(e) => setD({ ...d, spineTimezone: e.target.value })}
              >
                <option value="America/Sao_Paulo">Brasília (UTC-3)</option>
                <option value="America/Manaus">Manaus (UTC-4)</option>
                <option value="America/Rio_Branco">Rio Branco (UTC-5)</option>
                <option value="America/Belem">Belém (UTC-3)</option>
                <option value="America/Fortaleza">Fortaleza (UTC-3)</option>
              </select>
              <span className="mt-1 block text-[11px] leading-relaxed text-zinc-500">
                A franquia responde em UTC. Errar aqui marca o paciente na hora errada.
              </span>
            </label>
          </div>
        </div>
      </div>

      <div className="mt-6 flex items-center gap-3 border-t border-zinc-800 pt-5">
        <button className="btn-primary" onClick={() => void salvar()} disabled={salvando}>
          {salvando ? <PiSpinnerGapBold size={14} className="animate-spin" /> : <PiCheckBold size={14} />}
          Salvar
        </button>
        {salvo && (
          <span className="inline-flex items-center gap-1.5 text-xs text-emerald-400">
            <PiCheckCircleFill size={13} /> salvo
          </span>
        )}
        {erro && <span className="text-xs text-rose-300">{erro}</span>}
      </div>
    </section>
  );
}

function Hora({ label, v, on }: { label: string; v: string; on: (v: string) => void }) {
  return (
    <label className="block">
      <span className="text-xs font-medium text-zinc-300">{label}</span>
      <input type="time" className="field mt-1" value={v} onChange={(e) => on(e.target.value)} />
    </label>
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

const ORIGENS_FRANQUIA = [
  { id: 20, nome: 'WHATSAPP' },
  { id: 23, nome: 'INSTAGRAM' },
  { id: 22, nome: 'FACEBOOK' },
  { id: 7, nome: 'Site / Landing Page' },
  { id: 3, nome: 'INDICAÇÃO' },
  { id: 1, nome: 'GOOGLE' },
  { id: 9999, nome: 'IA2GO' },
];

function EspelharLeads({
  unit,
  status,
  onSaved,
}: {
  unit: { id: string; spineSyncLeads?: boolean; spineDefaultSourceId?: number };
  status: SpineStatus | null;
  onSaved: () => Promise<void>;
}) {
  const [ligado, setLigado] = useState(unit.spineSyncLeads ?? false);
  const [origem, setOrigem] = useState(unit.spineDefaultSourceId ?? 20);
  const [salvando, setSalvando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const [hist, setHist] = useState<SpineLeadLinksResponse | null>(null);

  const carregarHist = useCallback(async () => {
    try {
      setHist(await api.spineLeadLinks(unit.id));
    } catch {
      setHist(null);
    }
  }, [unit.id]);

  useEffect(() => {
    void carregarHist();
  }, [carregarHist]);

  async function salvar(novoLigado: boolean, novaOrigem: number) {
    setSalvando(true);
    setErro(null);
    try {
      await api.updateUnit(unit.id, {
        spineSyncLeads: novoLigado,
        spineDefaultSourceId: novaOrigem,
      } as Record<string, unknown>);
      await onSaved();
      await carregarHist();
    } catch (e) {
      setErro(e instanceof Error ? e.message : 'Falha ao salvar');
      setLigado(!novoLigado);
    } finally {
      setSalvando(false);
    }
  }

  const semToken = !status?.hasToken;

  return (
    <section className="surface p-7">
      <h2 className="text-sm font-semibold text-zinc-100">Espelhar leads no CRM da franquia</h2>
      <p className="mt-1 text-sm leading-relaxed text-zinc-400">
        Quando alguém entra em contato no Kommo, o cadastro é criado também no sistema da
        clínica — sem ninguém digitar duas vezes.
      </p>

      <div className="mt-5 rounded-xl border border-zinc-800 p-4">
        <button
          type="button"
          disabled={semToken || salvando}
          onClick={() => {
            const novo = !ligado;
            setLigado(novo);
            void salvar(novo, origem);
          }}
          className="flex w-full items-start gap-3 text-left disabled:opacity-50"
        >
          <span
            className={`mt-0.5 inline-flex h-5 w-9 shrink-0 items-center rounded-full p-0.5 transition-colors ${
              ligado ? 'bg-emerald-500' : 'bg-zinc-700'
            }`}
          >
            <span
              className={`h-4 w-4 rounded-full bg-white transition-transform ${ligado ? 'translate-x-4' : ''}`}
            />
          </span>
          <span className="min-w-0">
            <span className="block text-sm font-medium text-zinc-200">
              Enviar leads do Kommo para a franquia
            </span>
            <span className="mt-0.5 block text-xs leading-relaxed text-zinc-400">
              {semToken
                ? 'Configure o token da franquia acima primeiro.'
                : ligado
                  ? 'Ligado — cada lead novo com nome vai para o CRM da clínica.'
                  : 'Desligado — nada é enviado.'}
            </span>
          </span>
        </button>
      </div>

      {/* O QUE ACONTECE — antes de ligar, não depois. Escrita permanente
          merece que a pessoa saiba no que está mexendo. */}
      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <div className="rounded-lg border border-zinc-800 bg-zinc-950/60 p-4">
          <p className="text-xs font-medium text-zinc-300">Quando envia</p>
          <ul className="mt-2 space-y-1.5 text-xs leading-relaxed text-zinc-500">
            <li>· depois de cada resposta da IA, se o lead já tiver nome de verdade</li>
            <li>· uma vez só por lead — reenvio não cria cadastro duplicado</li>
            <li>· leva nome, WhatsApp, cidade, UF, origem e a queixa</li>
          </ul>
        </div>
        <div className="rounded-lg border border-amber-500/25 bg-amber-500/5 p-4">
          <p className="text-xs font-medium text-amber-300">Quando NÃO envia</p>
          <ul className="mt-2 space-y-1.5 text-xs leading-relaxed text-zinc-400">
            <li>· lead ainda com título automático (&quot;Lead #123&quot;, só o telefone)</li>
            <li>
              · a franquia <span className="text-zinc-300">não permite apagar lead</span> — por
              isso o filtro é rígido: cadastro errado lá é permanente
            </li>
          </ul>
        </div>
      </div>

      <label className="mt-5 block max-w-sm">
        <span className="text-xs font-medium text-zinc-300">Origem quando não houver correspondente</span>
        <select
          className="field mt-1"
          value={origem}
          disabled={salvando}
          onChange={(e) => {
            const v = Number(e.target.value);
            setOrigem(v);
            void salvar(ligado, v);
          }}
        >
          {ORIGENS_FRANQUIA.map((o) => (
            <option key={o.id} value={o.id}>
              {o.nome} · {o.id}
            </option>
          ))}
        </select>
        <span className="mt-1 block text-[11px] leading-relaxed text-zinc-500">
          Instagram, Facebook, WhatsApp e Site são traduzidos automaticamente. Esta é a origem
          para o que não casar com nenhuma.
        </span>
      </label>

      {erro && <p className="mt-3 text-xs text-rose-300">{erro}</p>}

      {hist && (
        <div className="mt-6 border-t border-zinc-800 pt-5">
          <div className="flex flex-wrap items-baseline gap-4">
            <p className="text-xs font-medium text-zinc-300">Enviados</p>
            <p className="text-sm text-zinc-400">
              <span className="font-semibold text-zinc-100">{hist.hoje}</span> hoje ·{' '}
              <span className="font-semibold text-zinc-100">{hist.total}</span> no total
            </p>
          </div>
          {hist.links.length > 0 && (
            <ul className="mt-3 space-y-1">
              {hist.links.slice(0, 8).map((l) => (
                <li key={l.id} className="flex items-center gap-2 text-xs text-zinc-500">
                  <span className="tabular-nums text-zinc-400">Kommo {l.kommoLeadId}</span>
                  <ArrowRightIcon />
                  <span className="tabular-nums text-emerald-400">franquia {l.spineIdLead}</span>
                  <span className="ml-auto">
                    {new Date(l.createdAt).toLocaleString('pt-BR', {
                      day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
                    })}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {hist.links.length === 0 && (
            <p className="mt-2 text-xs text-zinc-500">Nenhum lead enviado ainda.</p>
          )}
        </div>
      )}
    </section>
  );
}

function ArrowRightIcon() {
  return <PiArrowRightBold size={11} className="text-zinc-600" />;
}

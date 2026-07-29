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
  PiPauseBold,
  PiPlayBold,
  PiCalendarBlankBold,
  PiPlugsConnectedBold,
  PiQuestionBold,
} from 'react-icons/pi';
import { api } from '../lib/api';
import { useUnit } from '../context/UnitContext';
import type { SpineStatus, SpineSchedulesResponse } from '../types/api';

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
        <Agenda unit={unit} paused={status?.paused ?? false} />
        <Configuracao unit={unit} status={status} onSaved={async () => {
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

function Agenda({ unit, paused }: { unit: { id: string }; paused: boolean }) {
  const [dia, setDia] = useState(() => new Date().toISOString().slice(0, 10));
  const [dados, setDados] = useState<SpineSchedulesResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [erro, setErro] = useState<string | null>(null);

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
          <div className="mt-5 grid gap-3 sm:grid-cols-3">
            <Tile label="Livres" valor={dados.resumo.livres} cor="text-emerald-400" />
            <Tile label="Ocupados" valor={dados.resumo.ocupados} cor="text-zinc-400" />
            <Tile
              label="Precisam de conferência"
              valor={dados.resumo.incertos}
              cor="text-amber-400"
              hint="paciente desmarcou — pode ter virado bloqueio"
            />
          </div>

          <div className="mt-5 flex flex-wrap gap-2">
            {dados.slots.length === 0 && (
              <p className="text-sm text-zinc-500">
                Nenhum horário nesta data — fora dos dias de atendimento, ou tudo já passou.
              </p>
            )}
            {dados.slots.map((s) => (
              <span
                key={`${s.day}-${s.time}`}
                title={s.motivo ?? 'livre'}
                className={`rounded-lg px-3 py-1.5 text-sm font-medium tabular-nums ring-1 ${
                  s.status === 'livre'
                    ? 'bg-emerald-500/10 text-emerald-300 ring-emerald-500/25'
                    : s.status === 'ocupado'
                      ? 'bg-zinc-800 text-zinc-500 ring-zinc-700 line-through'
                      : 'bg-amber-500/10 text-amber-300 ring-amber-500/25'
                }`}
              >
                {s.time}
                {s.status === 'incerto' && <PiQuestionBold size={11} className="ml-1 inline" />}
              </span>
            ))}
          </div>

          {paused && (
            <p className="mt-4 text-xs text-rose-300">
              A I.A. está pausada — estes horários não estão sendo oferecidos a ninguém.
            </p>
          )}
        </>
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
    spineEnabled: boolean;
    spineBaseUrl: string;
    spineToken: string | null;
    spineTimezone: string;
    spineAgendaStart: string;
    spineAgendaEnd: string;
    spineLunchStart: string | null;
    spineLunchEnd: string | null;
    spineAgendaDays: number[];
    spineSlotMinutes: number;
  };
  status: SpineStatus | null;
  onSaved: () => Promise<void>;
}) {
  const [d, setD] = useState({
    spineEnabled: unit.spineEnabled,
    spineBaseUrl: unit.spineBaseUrl,
    spineToken: '',
    spineTimezone: unit.spineTimezone,
    spineAgendaStart: unit.spineAgendaStart,
    spineAgendaEnd: unit.spineAgendaEnd,
    spineLunchStart: unit.spineLunchStart ?? '',
    spineLunchEnd: unit.spineLunchEnd ?? '',
    spineAgendaDays: unit.spineAgendaDays,
    spineSlotMinutes: unit.spineSlotMinutes,
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
                const ativo = d.spineAgendaDays.includes(dia.n);
                return (
                  <button
                    key={dia.n}
                    type="button"
                    onClick={() =>
                      setD({
                        ...d,
                        spineAgendaDays: ativo
                          ? d.spineAgendaDays.filter((x) => x !== dia.n)
                          : [...d.spineAgendaDays, dia.n].sort(),
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

import { useEffect, useMemo, useState } from 'react';
import { Loader2, Save, Power, CalendarClock, Flame, PhoneCall, Repeat, Layers, Timer } from 'lucide-react';
import clsx from 'clsx';
import { Toggle } from './ui/formkit';
import { api } from '../lib/api';
import { useUnit } from '../context/UnitContext';
import { useToast } from '../context/ToastContext';
import type { Unit, UnitInput, KommoPipelinesResponse } from '../types/api';

type Draft = Pick<
  Unit,
  | 'isActive'
  | 'kommoAllowedStatusIds'
  | 'spineEnabled'
  | 'qualificationEnabled'
  | 'handoffEnabled'
  | 'followUpEnabled'
  | 'pipelineIntents'
  | 'slaAlertStatusIds'
>;

function unitToDraft(u: Unit): Draft {
  return {
    isActive: u.isActive,
    kommoAllowedStatusIds: u.kommoAllowedStatusIds ?? [],
    spineEnabled: u.spineEnabled,
    qualificationEnabled: u.qualificationEnabled,
    handoffEnabled: u.handoffEnabled,
    followUpEnabled: u.followUpEnabled,
    pipelineIntents: u.pipelineIntents,
    slaAlertStatusIds: u.slaAlertStatusIds ?? [],
  };
}

export function ActivationPanel() {
  const { selectedUnitId } = useUnit();
  const toast = useToast();
  const [unit, setUnit] = useState<Unit | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [pipes, setPipes] = useState<KommoPipelinesResponse | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!selectedUnitId) {
      setUnit(null);
      setDraft(null);
      setPipes(null);
      return;
    }
    let alive = true;
    setUnit(null);
    setDraft(null);
    Promise.all([
      api.getUnit(selectedUnitId),
      api.kommoPipelines(selectedUnitId).catch(() => null),
    ]).then(([u, p]) => {
      if (!alive) return;
      setUnit(u);
      setDraft(unitToDraft(u));
      setPipes(p);
    });
    return () => {
      alive = false;
    };
  }, [selectedUnitId]);

  const dirty = useMemo(
    () => (unit && draft ? JSON.stringify(draft) !== JSON.stringify(unitToDraft(unit)) : false),
    [unit, draft],
  );

  if (!selectedUnitId) {
    return (
      <div className="flex-1 flex items-center justify-center text-zinc-500 text-sm">
        Selecione uma unidade pra ver a ativação.
      </div>
    );
  }
  if (!unit || !draft) {
    return (
      <div className="flex-1 flex items-center justify-center text-zinc-500">
        <Loader2 className="animate-spin mr-2" size={18} /> Carregando…
      </div>
    );
  }

  const allowed = draft.kommoAllowedStatusIds ?? [];
  const respondeEmTodas = allowed.length === 0;
  const update = (patch: Partial<Draft>) => setDraft({ ...draft, ...patch });

  const pintents = (draft.pipelineIntents as Record<string, number> | null) ?? {};
  const slaMinutes = Number(pintents.sla_alert_minutes ?? 0);
  const setSla = (min: number) => {
    const novo = { ...pintents };
    if (min > 0) novo.sla_alert_minutes = min;
    else delete novo.sla_alert_minutes;
    update({ pipelineIntents: novo });
  };

  function toggleStage(id: number) {
    const set = new Set(allowed);
    if (set.has(id)) set.delete(id);
    else set.add(id);
    update({ kommoAllowedStatusIds: [...set] });
  }

  const slaStages = draft.slaAlertStatusIds ?? [];
  function toggleSlaStage(id: number) {
    const set = new Set(slaStages);
    if (set.has(id)) set.delete(id);
    else set.add(id);
    update({ slaAlertStatusIds: [...set] });
  }

  async function handleSave() {
    setSaving(true);
    try {
      const saved = await api.updateUnit(selectedUnitId!, draft as Partial<UnitInput>);
      setUnit(saved);
      setDraft(unitToDraft(saved));
      toast.success('Ativação salva. Vale já na próxima mensagem.');
    } catch (err) {
      const e = err as { message?: string };
      toast.error(`Falha ao salvar: ${e?.message ?? 'erro'}`);
    } finally {
      setSaving(false);
    }
  }

  const pipelines = (pipes?.pipelines ?? []).filter((p) => !p.isArchive);
  const nEtapas = respondeEmTodas ? 'todas' : String(allowed.length);

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-3xl mx-auto px-6 pb-24">
        <div className="flex items-end justify-between gap-4 sticky top-0 backdrop-blur pt-6 pb-4 z-10 border-b border-zinc-800/60">
          <div>
            <div className="text-[11px] uppercase tracking-[0.16em] text-zinc-500 mb-1.5">
              Configuração do agente
            </div>
            <h1 className="text-xl font-semibold text-zinc-50 tracking-tight">Etapas &amp; Ativação</h1>
          </div>
          <button
            onClick={handleSave}
            disabled={!dirty || saving}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-md bg-zinc-100 hover:bg-white disabled:bg-zinc-800 disabled:text-zinc-600 disabled:cursor-not-allowed text-zinc-900 text-[13px] font-medium transition-colors shrink-0"
          >
            {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
            {saving ? 'Salvando…' : dirty ? 'Salvar' : 'Salvo'}
          </button>
        </div>

        <div
          className={clsx(
            'mt-5 rounded-xl border p-4 flex items-center gap-3',
            draft.isActive ? 'border-emerald-500/30 bg-emerald-500/[0.06]' : 'border-zinc-700 bg-zinc-900/40',
          )}
        >
          <span
            className={clsx(
              'h-2.5 w-2.5 rounded-full shrink-0',
              draft.isActive ? 'bg-emerald-400 shadow-[0_0_8px] shadow-emerald-400/60' : 'bg-zinc-600',
            )}
          />
          <div className="text-[13px] text-zinc-300">
            Esta IA está{' '}
            <span className={draft.isActive ? 'text-emerald-300 font-semibold' : 'text-zinc-400 font-semibold'}>
              {draft.isActive ? 'ATIVA' : 'INATIVA'}
            </span>{' '}
            · responde em <span className="text-zinc-100 font-medium">{nEtapas}</span> etapa(s) · agenda{' '}
            <span className={draft.spineEnabled ? 'text-sky-300' : 'text-zinc-400'}>
              {draft.spineEnabled ? 'ligada' : 'desligada'}
            </span>
          </div>
        </div>

        <Row
          icon={<Power size={16} className="text-emerald-300" />}
          title="IA ativa"
          desc="Desligada, esta IA não responde nada — nem entra no roteamento por etapa."
        >
          <Toggle value={draft.isActive} onChange={(v) => update({ isActive: v })} />
        </Row>

        <section className="mt-6 border-t border-zinc-800/60 pt-6">
          <div className="flex items-center gap-2 mb-1">
            <Layers size={16} className="text-zinc-400" />
            <h2 className="text-[15px] font-semibold text-zinc-100">Em que etapas esta IA responde</h2>
          </div>
          <p className="text-[12.5px] text-zinc-500 mb-4 leading-relaxed">
            O lead é atendido pela IA <span className="text-zinc-300">dona da etapa em que ele está</span>.
            Assim cada etapa tem uma IA só — sem resposta dupla.
          </p>

          <div className="inline-flex gap-1 p-1 rounded-lg bg-zinc-900 border border-zinc-800 mb-4">
            <ModeBtn
              active={respondeEmTodas}
              onClick={() => update({ kommoAllowedStatusIds: [] })}
              label="Todas as etapas"
            />
            <ModeBtn
              active={!respondeEmTodas}
              onClick={() => {
                if (respondeEmTodas) update({ kommoAllowedStatusIds: [] });
              }}
              label="Só as que eu escolher"
            />
          </div>

          {!respondeEmTodas && (
            <div className="space-y-4">
              {pipes === null && (
                <div className="text-[12px] text-amber-300/80">
                  Não consegui listar as etapas do Kommo — confira o subdomínio/token da unidade.
                </div>
              )}
              {pipelines.map((p) => (
                <div key={p.id} className="rounded-lg border border-zinc-800 bg-zinc-900/40 overflow-hidden">
                  <div className="px-3 py-2 text-[11px] uppercase tracking-wider text-zinc-500 font-semibold border-b border-zinc-800/60">
                    {p.name}
                  </div>
                  <div className="p-2 grid sm:grid-cols-2 gap-1">
                    {p.statuses.map((s) => {
                      const on = allowed.includes(s.id);
                      return (
                        <button
                          key={s.id}
                          type="button"
                          onClick={() => toggleStage(s.id)}
                          className={clsx(
                            'flex items-center gap-2.5 px-2.5 py-2 rounded-md text-left transition',
                            on ? 'bg-brand-500/10 ring-1 ring-brand-500/40' : 'hover:bg-zinc-800/50',
                          )}
                        >
                          <span
                            className={clsx(
                              'h-4 w-4 rounded flex items-center justify-center shrink-0 text-[10px]',
                              on ? 'bg-brand-500 text-white' : 'bg-zinc-800 ring-1 ring-zinc-700',
                            )}
                          >
                            {on ? '✓' : ''}
                          </span>
                          <span className="flex items-center gap-1.5 min-w-0">
                            {s.color && (
                              <span
                                className="h-2.5 w-2.5 rounded-full shrink-0"
                                style={{ backgroundColor: s.color }}
                              />
                            )}
                            <span className="text-[13px] text-zinc-200 truncate">{s.name}</span>
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>

        <Row
          icon={<CalendarClock size={16} className="text-sky-300" />}
          title="Agenda da franquia (marcar/remarcar)"
          desc="Ligada, a IA consulta o calendário da franquia e agenda, remarca e confirma consultas sozinha."
        >
          <Toggle value={draft.spineEnabled} onChange={(v) => update({ spineEnabled: v })} />
        </Row>

        <section className="mt-6 border-t border-zinc-800/60 pt-6">
          <h2 className="text-[15px] font-semibold text-zinc-100 mb-1">Capacidades</h2>
          <p className="text-[12.5px] text-zinc-500 mb-3">Ligue/desligue o que esta IA pode fazer.</p>

          <Row
            icon={<Flame size={16} className="text-amber-300" />}
            title="Qualificação automática (Quente/Frio)"
            desc="A IA marca o lead conforme o interesse, sozinha."
            compact
          >
            <Toggle value={draft.qualificationEnabled} onChange={(v) => update({ qualificationEnabled: v })} />
          </Row>
          <Row
            icon={<PhoneCall size={16} className="text-violet-300" />}
            title="Passar pra humano por palavra-chave"
            desc="Quando o cliente pede um atendente, a IA pausa e chama a equipe."
            compact
          >
            <Toggle value={draft.handoffEnabled} onChange={(v) => update({ handoffEnabled: v })} />
          </Row>
          <Row
            icon={<Repeat size={16} className="text-cyan-300" />}
            title="Follow-up"
            desc="A IA retoma conversas que ficaram no meio."
            compact
          >
            <Toggle value={draft.followUpEnabled} onChange={(v) => update({ followUpEnabled: v })} />
          </Row>
          <Row
            icon={<Timer size={16} className="text-rose-300" />}
            title="Alertar SDR se ninguém responder (SLA)"
            desc="Com a IA pausada (humano no controle), se ninguém responder o lead dentro do tempo, um alerta com o nome do lead cai no grupo de WhatsApp da unidade."
            compact
          >
            <div className="flex items-center gap-3">
              {slaMinutes > 0 && (
                <div className="flex items-center gap-1.5">
                  <StepBtn label="−" onClick={() => setSla(Math.max(1, slaMinutes - 1))} />
                  <span className="tabular-nums text-[13px] text-zinc-100 w-14 text-center">
                    {slaMinutes} min
                  </span>
                  <StepBtn label="+" onClick={() => setSla(Math.min(120, slaMinutes + 1))} />
                </div>
              )}
              <Toggle value={slaMinutes > 0} onChange={(v) => setSla(v ? 5 : 0)} />
            </div>
          </Row>
        </section>

        {slaMinutes > 0 && (
          <section className="mt-6 border-t border-zinc-800/60 pt-6">
            <div className="flex items-center gap-2 mb-1">
              <Timer size={16} className="text-rose-300" />
              <h2 className="text-[15px] font-semibold text-zinc-100">
                Etapas em que o alerta de SLA vale
              </h2>
            </div>
            <p className="text-[12.5px] text-zinc-500 mb-4 leading-relaxed">
              O alerta só dispara quando o lead está numa destas etapas. Marque as ativas (ex:{' '}
              <span className="text-zinc-300">Entrada, Em Qualificação, Em Negociação</span>) — assim
              lead <span className="text-zinc-300">Perdido, Ganho ou em Tratamento</span> nunca gera
              alerta, mesmo com a IA pausada.
            </p>
            {slaStages.length === 0 && (
              <div className="text-[12px] text-amber-300/80 mb-3">
                Nenhuma etapa marcada = alerta em qualquer etapa (menos as terminais). Recomendo
                marcar as ativas.
              </div>
            )}
            <StagePicker
              pipelines={pipelines}
              pipesLoaded={pipes !== null}
              selected={slaStages}
              onToggle={toggleSlaStage}
            />
          </section>
        )}
      </div>
    </div>
  );
}

function StagePicker({
  pipelines,
  pipesLoaded,
  selected,
  onToggle,
}: {
  pipelines: NonNullable<KommoPipelinesResponse['pipelines']>;
  pipesLoaded: boolean;
  selected: number[];
  onToggle: (id: number) => void;
}) {
  return (
    <div className="space-y-4">
      {!pipesLoaded && (
        <div className="text-[12px] text-amber-300/80">
          Não consegui listar as etapas do Kommo — confira o subdomínio/token da unidade.
        </div>
      )}
      {pipelines.map((p) => (
        <div key={p.id} className="rounded-lg border border-zinc-800 bg-zinc-900/40 overflow-hidden">
          <div className="px-3 py-2 text-[11px] uppercase tracking-wider text-zinc-500 font-semibold border-b border-zinc-800/60">
            {p.name}
          </div>
          <div className="p-2 grid sm:grid-cols-2 gap-1">
            {p.statuses.map((s) => {
              const on = selected.includes(s.id);
              return (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => onToggle(s.id)}
                  className={clsx(
                    'flex items-center gap-2.5 px-2.5 py-2 rounded-md text-left transition',
                    on ? 'bg-brand-500/10 ring-1 ring-brand-500/40' : 'hover:bg-zinc-800/50',
                  )}
                >
                  <span
                    className={clsx(
                      'h-4 w-4 rounded flex items-center justify-center shrink-0 text-[10px]',
                      on ? 'bg-brand-500 text-white' : 'bg-zinc-800 ring-1 ring-zinc-700',
                    )}
                  >
                    {on ? '✓' : ''}
                  </span>
                  <span className="flex items-center gap-1.5 min-w-0">
                    {s.color && (
                      <span
                        className="h-2.5 w-2.5 rounded-full shrink-0"
                        style={{ backgroundColor: s.color }}
                      />
                    )}
                    <span className="text-[13px] text-zinc-200 truncate">{s.name}</span>
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

function Row({
  icon,
  title,
  desc,
  children,
  compact,
}: {
  icon: React.ReactNode;
  title: string;
  desc: string;
  children: React.ReactNode;
  compact?: boolean;
}) {
  return (
    <div
      className={clsx(
        'flex items-start justify-between gap-4',
        compact ? 'py-3 border-b border-zinc-800/40 last:border-b-0' : 'mt-6 border-t border-zinc-800/60 pt-6',
      )}
    >
      <div className="flex items-start gap-3 min-w-0">
        <span className="mt-0.5 shrink-0">{icon}</span>
        <div className="min-w-0">
          <div className="text-[14px] font-medium text-zinc-100">{title}</div>
          <p className="text-[12px] text-zinc-500 mt-0.5 leading-relaxed max-w-md">{desc}</p>
        </div>
      </div>
      <div className="mt-0.5 shrink-0">{children}</div>
    </div>
  );
}

function StepBtn({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="h-6 w-6 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-300 text-[15px] leading-none flex items-center justify-center transition-colors"
    >
      {label}
    </button>
  );
}

function ModeBtn({ active, onClick, label }: { active: boolean; onClick: () => void; label: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={clsx(
        'px-3 py-1.5 text-[12.5px] rounded-md transition-colors',
        active ? 'bg-zinc-800 text-zinc-100 font-medium' : 'text-zinc-500 hover:text-zinc-200',
      )}
    >
      {label}
    </button>
  );
}

export default ActivationPanel;

// ============================================================================
// CrmFranquiaPanel — tudo que liga o agente ao CRM da franquia, num lugar só.
//
// POR QUE É UMA PÁGINA SEPARADA DA AGENDA
// ---------------------------------------
// A Agenda é OPERAÇÃO: a recepção abre todo dia pra ver horário, bloquear e,
// no pior caso, pausar a IA. Isto aqui é CONFIGURAÇÃO E INTEGRIDADE: token,
// horários da clínica, espelhamento de leads e a prova de que está chegando.
// Misturar as duas fazia a tela do dia a dia carregar decisões que se toma uma
// vez — e enterrava a configuração embaixo do calendário.
//
// A REGRA QUE MOLDA A TELA INTEIRA
// --------------------------------
// A API da franquia NÃO APAGA LEAD (testado: 404 nas duas formas). Cadastro
// errado lá vira chamado no suporte deles e limpeza manual. Então:
//   - o que é permanente tem interruptor próprio, não herdado da agenda;
//   - dá pra VER o cadastro que sairia antes de ele sair (prévia);
//   - "salvo" só aparece quando o servidor confirma — ver a barra de estado.
//
// A BARRA DE ESTADO
// -----------------
// O formulário compara o que está na tela com o que o servidor devolveu depois
// de salvar. Se um campo não for gravado, a barra continua dizendo "alterações
// não salvas" em vez de piscar um "salvo" que mente. Isso não é enfeite: por
// 35 campos e várias semanas, o backend respondia 200 e não gravava nada.
// ============================================================================

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  PiWarningCircleBold,
  PiCheckBold,
  PiCheckCircleFill,
  PiSpinnerGapBold,
  PiArrowRightBold,
  PiPlugsConnectedBold,
  PiEyeBold,
  PiXCircleFill,
  PiArrowsClockwiseBold,
} from 'react-icons/pi';
import { api } from '../lib/api';
import { useUnit } from '../context/UnitContext';
import type {
  SpineStatus,
  SpineLeadLinksResponse,
  SpineLeadPreview,
  SpineProntidao,
  Unit,
} from '../types/api';

const DIAS = [
  { n: 0, label: 'Dom' },
  { n: 1, label: 'Seg' },
  { n: 2, label: 'Ter' },
  { n: 3, label: 'Qua' },
  { n: 4, label: 'Qui' },
  { n: 5, label: 'Sex' },
  { n: 6, label: 'Sáb' },
];

const ORIGENS_FRANQUIA = [
  { id: 20, nome: 'WHATSAPP' },
  { id: 23, nome: 'INSTAGRAM' },
  { id: 22, nome: 'FACEBOOK' },
  { id: 7, nome: 'Site / Landing Page' },
  { id: 3, nome: 'INDICAÇÃO' },
  { id: 1, nome: 'GOOGLE' },
  { id: 9999, nome: 'IA2GO' },
];

// ---------------------------------------------------------------------------
// O formulário inteiro é UM objeto. Salvar manda ele todo e compara o que
// voltou: é o que permite a tela afirmar "salvo" sem estar chutando.
// ---------------------------------------------------------------------------

interface Form {
  spineEnabled: boolean;
  spineBaseUrl: string;
  spineTimezone: string;
  spineAgendaStart: string;
  spineAgendaEnd: string;
  spineLunchStart: string;
  spineLunchEnd: string;
  spineAgendaDays: number[];
  spineSlotMinutes: number;
  spineSyncLeads: boolean;
  spineDefaultSourceId: number;
}

/**
 * O que o servidor diz que está gravado. Todo campo tem default: o painel
 * (Vercel) e a API (VPS) sobem por pipelines diferentes, então existe uma
 * janela em que o front novo fala com uma API que ainda não devolve o campo.
 * Sem default, `spineAgendaDays.includes(...)` derruba a tela inteira.
 */
function doServidor(u: Partial<Unit>): Form {
  return {
    spineEnabled: u.spineEnabled ?? false,
    spineBaseUrl: u.spineBaseUrl ?? 'https://app-api-prod.doutorhernia.com.br',
    spineTimezone: u.spineTimezone ?? 'America/Sao_Paulo',
    spineAgendaStart: u.spineAgendaStart ?? '08:00',
    spineAgendaEnd: u.spineAgendaEnd ?? '18:00',
    spineLunchStart: u.spineLunchStart ?? '',
    spineLunchEnd: u.spineLunchEnd ?? '',
    spineAgendaDays: u.spineAgendaDays ?? [1, 2, 3, 4, 5],
    spineSlotMinutes: u.spineSlotMinutes ?? 30,
    spineSyncLeads: u.spineSyncLeads ?? false,
    spineDefaultSourceId: u.spineDefaultSourceId ?? 20,
  };
}

export default function CrmFranquiaPanel() {
  const { selectedUnit: unit, refresh } = useUnit();
  const [status, setStatus] = useState<SpineStatus | null>(null);
  const [prontidao, setProntidao] = useState<SpineProntidao | null>(null);
  const [hist, setHist] = useState<SpineLeadLinksResponse | null>(null);
  const [erro, setErro] = useState<string | null>(null);

  const servidor = useMemo(() => doServidor(unit ?? {}), [unit]);
  const [form, setForm] = useState<Form>(servidor);
  const [token, setToken] = useState('');
  const [salvando, setSalvando] = useState(false);
  const [erroSalvar, setErroSalvar] = useState<string | null>(null);

  const sujo = JSON.stringify(form) !== JSON.stringify(servidor) || token.trim() !== '';

  // Adota o valor do servidor quando não há edição pendente — assim outra aba
  // (ou o próprio salvamento) atualiza a tela sem sobrescrever o que a pessoa
  // está digitando agora.
  const chaveServidor = JSON.stringify(servidor);
  useEffect(() => {
    if (!sujo) setForm(servidor);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chaveServidor]);

  const carregar = useCallback(async () => {
    if (!unit) return;
    setErro(null);
    try {
      const [s, h] = await Promise.all([api.spineStatus(unit.id), api.spineLeadLinks(unit.id)]);
      setStatus(s);
      setHist(h);
    } catch (e) {
      setErro(e instanceof Error ? e.message : 'Falha ao carregar');
    }
    try {
      setProntidao(await api.spineProntidao(unit.id));
    } catch {
      setProntidao(null); // a checagem bate na franquia; falhar aqui não é fatal
    }
  }, [unit?.id]);

  useEffect(() => {
    void carregar();
  }, [carregar]);

  async function salvar() {
    if (!unit) return;
    setSalvando(true);
    setErroSalvar(null);
    try {
      const payload: Record<string, unknown> = {
        ...form,
        spineLunchStart: form.spineLunchStart || null,
        spineLunchEnd: form.spineLunchEnd || null,
      };
      // Token em branco = manter o atual. A API devolve mascarado, então
      // mandar '' apagaria a credencial da franquia.
      if (token.trim()) payload.spineToken = token.trim();
      await api.updateUnit(unit.id, payload);
      setToken('');
      await refresh(); // re-lê do servidor: é o refresh que apaga o "não salvo"
      await carregar();
    } catch (e) {
      setErroSalvar(e instanceof Error ? e.message : 'Falha ao salvar');
    } finally {
      setSalvando(false);
    }
  }

  if (!unit) return <p className="p-8 text-sm text-zinc-400">Selecione um agente.</p>;

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="mx-auto max-w-[1500px] space-y-7 p-8 pb-28">
        <header>
          <h1 className="text-lg font-semibold text-zinc-50">CRM da franquia</h1>
          <p className="mt-1 max-w-3xl text-sm leading-relaxed text-zinc-400">
            Tudo que conecta o agente ao sistema da clínica: a credencial, quando ela atende, e o
            espelhamento dos leads. O que é enviado para lá é permanente — a franquia não tem
            exclusão de lead.
          </p>
        </header>

        {erro && (
          <div className="surface flex items-start gap-2 border-rose-500/30 p-4 text-sm text-rose-300">
            <PiWarningCircleBold size={16} className="mt-0.5 shrink-0" />
            {erro}
          </div>
        )}

        <Pecas prontidao={prontidao} onRecarregar={carregar} />

        <Conexao
          form={form}
          setForm={setForm}
          token={token}
          setToken={setToken}
          temToken={status?.hasToken ?? false}
          unitId={unit.id}
        />

        <Horarios form={form} setForm={setForm} />

        <Espelhamento form={form} setForm={setForm} temToken={status?.hasToken ?? false} />

        <Previa unitId={unit.id} />

        <Historico hist={hist} onRecarregar={carregar} />
      </div>

      <BarraDeEstado
        sujo={sujo}
        salvando={salvando}
        erro={erroSalvar}
        onSalvar={() => void salvar()}
        onDescartar={() => {
          setForm(servidor);
          setToken('');
          setErroSalvar(null);
        }}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Barra de estado — fica fixa no rodapé enquanto houver o que salvar.
//
// Um botão "Salvar" solto no meio da página não responde a pergunta que
// importa: "o que eu mudei já está valendo?". A barra responde, e só some
// quando o servidor confirmou. Se um campo não gravar, ela NÃO some — o
// sintoma aparece na hora, em vez de semanas depois.
// ---------------------------------------------------------------------------

function BarraDeEstado({
  sujo,
  salvando,
  erro,
  onSalvar,
  onDescartar,
}: {
  sujo: boolean;
  salvando: boolean;
  erro: string | null;
  onSalvar: () => void;
  onDescartar: () => void;
}) {
  if (!sujo && !erro) {
    return (
      <div className="pointer-events-none sticky bottom-0 flex justify-center pb-5">
        <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-500/25 bg-zinc-950/90 px-3.5 py-1.5 text-xs text-emerald-400 backdrop-blur">
          <PiCheckCircleFill size={13} /> tudo salvo
        </span>
      </div>
    );
  }
  return (
    <div className="sticky bottom-0 border-t border-amber-500/30 bg-zinc-950/95 px-8 py-4 backdrop-blur">
      <div className="mx-auto flex max-w-[1500px] flex-wrap items-center gap-3">
        <PiWarningCircleBold size={16} className="shrink-0 text-amber-400" />
        <span className="text-sm text-zinc-200">
          {erro ? 'Não salvou.' : 'Alterações não salvas.'}
        </span>
        {erro && <span className="text-xs text-rose-300">{erro}</span>}
        {!erro && (
          <span className="text-xs text-zinc-500">
            Nada disto vale pra IA antes de salvar.
          </span>
        )}
        <div className="ml-auto flex items-center gap-2">
          <button className="btn-ghost" onClick={onDescartar} disabled={salvando}>
            Descartar
          </button>
          <button className="btn-primary" onClick={onSalvar} disabled={salvando}>
            {salvando ? (
              <PiSpinnerGapBold size={14} className="animate-spin" />
            ) : (
              <PiCheckBold size={14} />
            )}
            Salvar alterações
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// As peças
// ---------------------------------------------------------------------------

function Pecas({
  prontidao,
  onRecarregar,
}: {
  prontidao: SpineProntidao | null;
  onRecarregar: () => Promise<void>;
}) {
  const [conferindo, setConferindo] = useState(false);

  return (
    <section className="surface p-7">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-zinc-100">As peças do encaixe</h2>
          <p className="mt-1 text-sm text-zinc-400">
            Cada uma verificada agora, contra a franquia — não contra o que salvamos.
          </p>
        </div>
        <div className="flex items-center gap-3">
          {prontidao && (
            <span
              className={`text-xs tabular-nums ${
                prontidao.prontas === prontidao.total ? 'text-emerald-400' : 'text-amber-400'
              }`}
            >
              {prontidao.prontas}/{prontidao.total} prontas
            </span>
          )}
          <button
            className="btn-ghost"
            disabled={conferindo}
            onClick={async () => {
              setConferindo(true);
              await onRecarregar();
              setConferindo(false);
            }}
          >
            <PiArrowsClockwiseBold size={14} className={conferindo ? 'animate-spin' : ''} />
            Conferir de novo
          </button>
        </div>
      </div>

      {!prontidao ? (
        <p className="mt-5 text-sm text-zinc-500">Conferindo…</p>
      ) : (
        <ul className="mt-5 space-y-2">
          {prontidao.pecas.map((p) => (
            <li
              key={p.id}
              className={`flex items-start gap-3 rounded-lg border p-3.5 ${
                p.ok ? 'border-zinc-800' : 'border-amber-500/25 bg-amber-500/5'
              }`}
            >
              {p.ok ? (
                <PiCheckCircleFill size={16} className="mt-0.5 shrink-0 text-emerald-400" />
              ) : (
                <PiXCircleFill size={16} className="mt-0.5 shrink-0 text-amber-400" />
              )}
              <div className="min-w-0">
                <p className="text-sm font-medium text-zinc-200">{p.titulo}</p>
                <p className="mt-0.5 text-xs leading-relaxed text-zinc-400">{p.detalhe}</p>
                {!p.ok && p.comoResolver && (
                  <p className="mt-1 text-xs leading-relaxed text-amber-300/80">{p.comoResolver}</p>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Conexão
// ---------------------------------------------------------------------------

function Conexao({
  form,
  setForm,
  token,
  setToken,
  temToken,
  unitId,
}: {
  form: Form;
  setForm: (f: Form) => void;
  token: string;
  setToken: (v: string) => void;
  temToken: boolean;
  unitId: string;
}) {
  const [ping, setPing] = useState<{ ok: boolean; msg: string } | null>(null);
  const [testando, setTestando] = useState(false);

  async function testar() {
    setTestando(true);
    setPing(null);
    try {
      const r = await api.spinePing(unitId);
      setPing({ ok: r.ok, msg: r.ok ? 'Token válido, API respondendo.' : (r.error ?? 'falhou') });
    } catch (e) {
      setPing({ ok: false, msg: e instanceof Error ? e.message : 'falhou' });
    } finally {
      setTestando(false);
    }
  }

  return (
    <section className="surface p-7">
      <h2 className="text-sm font-semibold text-zinc-100">Conexão</h2>
      <p className="mt-1 text-sm text-zinc-400">
        A credencial que dá ao agente acesso ao sistema da franquia.
      </p>

      <div className="mt-5 grid gap-5 lg:grid-cols-2">
        <label className="block">
          <span className="flex items-center gap-2 text-xs font-medium text-zinc-300">
            Token da API Spine
            {temToken && (
              <span className="inline-flex items-center gap-1 text-[10px] font-normal text-emerald-400">
                <PiCheckCircleFill size={11} /> salvo
              </span>
            )}
          </span>
          <input
            type="password"
            className="field mt-1"
            value={token}
            placeholder={temToken ? '•••••••• (deixe vazio pra manter)' : 'cole o token aqui'}
            onChange={(e) => setToken(e.target.value)}
          />
          <span className="mt-1 block text-[11px] leading-relaxed text-zinc-500">
            Pedido ao suporte da franquia. Fica só no servidor — nunca volta pro navegador.
          </span>
        </label>

        <label className="block">
          <span className="text-xs font-medium text-zinc-300">Ambiente</span>
          <select
            className="field mt-1"
            value={form.spineBaseUrl}
            onChange={(e) => setForm({ ...form, spineBaseUrl: e.target.value })}
          >
            <option value="https://app-api-prod.doutorhernia.com.br">Produção</option>
            <option value="https://app-api-hom.doutorhernia.com.br">Homologação</option>
          </select>
          <span className="mt-1 block text-[11px] text-zinc-500">
            Teste em homologação antes de apontar pra produção.
          </span>
        </label>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-3">
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
        <span className="text-[11px] text-zinc-600">testa o token já salvo, não o digitado</span>
      </div>

      <div className="mt-6 border-t border-zinc-800 pt-5">
        <Interruptor
          ligado={form.spineEnabled}
          onChange={(v) => setForm({ ...form, spineEnabled: v })}
          titulo="Deixar a IA usar a agenda da franquia"
          ligadoTexto="A IA consulta horários livres e cria o agendamento no sistema da clínica."
          desligadoTexto="A IA não consulta nem agenda nada na franquia."
        />
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Horários
// ---------------------------------------------------------------------------

function Horarios({ form, setForm }: { form: Form; setForm: (f: Form) => void }) {
  return (
    <section className="surface p-7">
      <h2 className="text-sm font-semibold text-zinc-100">Quando a clínica atende</h2>
      <p className="mt-1 text-sm text-zinc-400">
        A IA não oferece horário fora desta janela nem dentro do almoço.
      </p>

      <div className="mt-5 grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
        <Hora label="Abre" v={form.spineAgendaStart} on={(v) => setForm({ ...form, spineAgendaStart: v })} />
        <Hora label="Fecha" v={form.spineAgendaEnd} on={(v) => setForm({ ...form, spineAgendaEnd: v })} />
        <Hora
          label="Almoço começa"
          v={form.spineLunchStart}
          on={(v) => setForm({ ...form, spineLunchStart: v })}
        />
        <Hora
          label="Almoço termina"
          v={form.spineLunchEnd}
          on={(v) => setForm({ ...form, spineLunchEnd: v })}
        />
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <div>
          <span className="text-xs font-medium text-zinc-300">Dias de atendimento</span>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {DIAS.map((dia) => {
              const ativo = form.spineAgendaDays.includes(dia.n);
              return (
                <button
                  key={dia.n}
                  type="button"
                  onClick={() =>
                    setForm({
                      ...form,
                      spineAgendaDays: ativo
                        ? form.spineAgendaDays.filter((x) => x !== dia.n)
                        : [...form.spineAgendaDays, dia.n].sort((a, b) => a - b),
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
              value={form.spineSlotMinutes}
              onChange={(e) => setForm({ ...form, spineSlotMinutes: Number(e.target.value) })}
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
              value={form.spineTimezone}
              onChange={(e) => setForm({ ...form, spineTimezone: e.target.value })}
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
// Espelhamento
// ---------------------------------------------------------------------------

function Espelhamento({
  form,
  setForm,
  temToken,
}: {
  form: Form;
  setForm: (f: Form) => void;
  temToken: boolean;
}) {
  return (
    <section className="surface p-7">
      <h2 className="text-sm font-semibold text-zinc-100">Espelhar leads no CRM da franquia</h2>
      <p className="mt-1 max-w-3xl text-sm leading-relaxed text-zinc-400">
        Quando alguém entra em contato no Kommo, o cadastro é criado também no sistema da clínica —
        sem ninguém digitar duas vezes.
      </p>

      <div className="mt-5 rounded-xl border border-zinc-800 p-4">
        <Interruptor
          ligado={form.spineSyncLeads}
          desabilitado={!temToken}
          onChange={(v) => setForm({ ...form, spineSyncLeads: v })}
          titulo="Enviar leads do Kommo para a franquia"
          ligadoTexto="Ligado — cada lead novo com nome vai para o CRM da clínica."
          desligadoTexto={
            temToken ? 'Desligado — nada é enviado.' : 'Configure o token da franquia acima primeiro.'
          }
        />
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
              · a franquia <span className="text-zinc-300">não permite apagar lead</span> — por isso
              o filtro é rígido: cadastro errado lá é permanente
            </li>
          </ul>
        </div>
      </div>

      <label className="mt-5 block max-w-sm">
        <span className="text-xs font-medium text-zinc-300">
          Origem quando não houver correspondente
        </span>
        <select
          className="field mt-1"
          value={form.spineDefaultSourceId}
          onChange={(e) => setForm({ ...form, spineDefaultSourceId: Number(e.target.value) })}
        >
          {ORIGENS_FRANQUIA.map((o) => (
            <option key={o.id} value={o.id}>
              {o.nome} · {o.id}
            </option>
          ))}
        </select>
        <span className="mt-1 block text-[11px] leading-relaxed text-zinc-500">
          Instagram, Facebook, WhatsApp e Site são traduzidos automaticamente. Esta é a origem para
          o que não casar com nenhuma.
        </span>
      </label>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Prévia — ver o cadastro antes de ele existir do outro lado.
//
// É a única defesa barata contra o que não dá pra desfazer. Consulta o Kommo,
// monta exatamente o que sairia e devolve; nada é escrito na franquia.
// ---------------------------------------------------------------------------

function Previa({ unitId }: { unitId: string }) {
  const [leadId, setLeadId] = useState('');
  const [r, setR] = useState<SpineLeadPreview | null>(null);
  const [carregando, setCarregando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);

  async function ver() {
    const id = Number(leadId);
    if (!Number.isFinite(id) || id <= 0) {
      setErro('Informe o id do lead no Kommo.');
      return;
    }
    setCarregando(true);
    setErro(null);
    setR(null);
    try {
      setR(await api.spineLeadPreview(unitId, id));
    } catch (e) {
      setErro(e instanceof Error ? e.message : 'Falha ao consultar');
    } finally {
      setCarregando(false);
    }
  }

  return (
    <section className="surface p-7">
      <h2 className="text-sm font-semibold text-zinc-100">Prévia — o que seria enviado</h2>
      <p className="mt-1 max-w-3xl text-sm leading-relaxed text-zinc-400">
        Monta o cadastro a partir de um lead do Kommo e mostra aqui, sem escrever nada na franquia.
        Use antes de ligar o espelhamento, ou sempre que desconfiar de um campo.
      </p>

      <div className="mt-5 flex flex-wrap items-end gap-3">
        <label className="block">
          <span className="text-xs font-medium text-zinc-300">Id do lead no Kommo</span>
          <input
            className="field mt-1 w-48"
            inputMode="numeric"
            placeholder="ex: 21715659"
            value={leadId}
            onChange={(e) => setLeadId(e.target.value.replace(/\D/g, ''))}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void ver();
            }}
          />
        </label>
        <button className="btn-ghost" onClick={() => void ver()} disabled={carregando}>
          {carregando ? (
            <PiSpinnerGapBold size={14} className="animate-spin" />
          ) : (
            <PiEyeBold size={14} />
          )}
          Ver sem enviar
        </button>
      </div>

      {erro && <p className="mt-3 text-xs text-rose-300">{erro}</p>}

      {r && !r.payload && (
        <div className="mt-5 rounded-lg border border-amber-500/25 bg-amber-500/5 p-4">
          <p className="text-sm text-amber-300">
            {r.etapa === 'ja-enviado'
              ? `Este lead já está na franquia com o id ${r.spineIdLead}. Não seria enviado de novo.`
              : 'Não seria enviado agora.'}
          </p>
          {r.motivo && <p className="mt-1 text-xs leading-relaxed text-zinc-400">{r.motivo}</p>}
        </div>
      )}

      {r?.payload && (
        <div className="mt-5 rounded-lg border border-zinc-800 bg-zinc-950/60 p-5">
          <p className="text-xs font-medium text-zinc-300">
            Cadastro que sairia — e nada além disto
          </p>
          <dl className="mt-3 grid gap-x-8 gap-y-2.5 sm:grid-cols-2">
            <Campo rotulo="Nome" valor={r.payload.name} />
            <Campo rotulo="WhatsApp" valor={r.payload.whatsapp} alerta="a recepção fica sem como ligar" />
            <Campo
              rotulo="Origem"
              valor={`${r.origemLegivel ?? ''} · ${r.payload.idSource}`}
            />
            <Campo rotulo="Cidade" valor={r.payload.addressCity} />
            <Campo rotulo="UF" valor={r.payload.addressUf} />
            <div className="sm:col-span-2">
              <dt className="text-[11px] uppercase tracking-wide text-zinc-500">Descrição</dt>
              <dd className="mt-0.5 text-sm leading-relaxed text-zinc-200">
                {r.payload.description}
              </dd>
            </div>
          </dl>
          {r.tituloKommo && r.tituloKommo !== r.payload.name && (
            <p className="mt-4 border-t border-zinc-800 pt-3 text-[11px] leading-relaxed text-zinc-500">
              No Kommo o título é &quot;{r.tituloKommo}&quot; — a data do fim é removida antes de
              enviar.
            </p>
          )}
        </div>
      )}
    </section>
  );
}

function Campo({
  rotulo,
  valor,
  alerta,
}: {
  rotulo: string;
  valor: string | null;
  alerta?: string;
}) {
  return (
    <div>
      <dt className="text-[11px] uppercase tracking-wide text-zinc-500">{rotulo}</dt>
      <dd className={`mt-0.5 text-sm ${valor ? 'text-zinc-200' : 'text-amber-400'}`}>
        {valor || `vazio${alerta ? ` — ${alerta}` : ''}`}
      </dd>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Histórico + conferência
// ---------------------------------------------------------------------------

function Historico({
  hist,
  onRecarregar,
}: {
  hist: SpineLeadLinksResponse | null;
  onRecarregar: () => Promise<void>;
}) {
  if (!hist) return null;
  const faltando = hist.conferencia.faltando?.length ?? 0;

  return (
    <section className="surface p-7">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-zinc-100">Está chegando lá?</h2>
          <p className="mt-1 text-sm text-zinc-400">
            Conferido consultando o CRM da franquia — não o nosso contador.
          </p>
        </div>
        <button className="btn-ghost" onClick={() => void onRecarregar()}>
          <PiArrowsClockwiseBold size={14} />
          Atualizar
        </button>
      </div>

      <div className="mt-5 grid gap-3 sm:grid-cols-3">
        <Tile label="Enviados hoje" valor={hist.hoje} cor="text-emerald-400" />
        <Tile
          label="Falharam"
          valor={hist.contagem.falhou}
          cor={hist.contagem.falhou > 0 ? 'text-rose-400' : 'text-zinc-600'}
          hint={hist.contagem.falhou > 0 ? 'veja o motivo na lista' : undefined}
        />
        <Tile
          label="Aguardando nome"
          valor={hist.contagem.ignorado}
          cor="text-zinc-500"
          hint="entram sozinhos quando a IA descobrir o nome"
        />
      </div>

      <div
        className={`mt-4 rounded-lg border p-4 ${
          !hist.conferencia.checado
            ? 'border-zinc-800'
            : faltando > 0
              ? 'border-rose-500/30 bg-rose-500/5'
              : 'border-emerald-500/25 bg-emerald-500/5'
        }`}
      >
        <p className="text-xs font-medium text-zinc-300">Conferência na franquia</p>
        {!hist.conferencia.checado ? (
          <p className="mt-1 text-xs leading-relaxed text-zinc-500">
            {hist.conferencia.erro
              ? `Não consegui conferir agora: ${hist.conferencia.erro}`
              : 'Nada enviado ainda para conferir.'}
          </p>
        ) : faltando === 0 ? (
          <p className="mt-1 text-xs leading-relaxed text-emerald-300">
            Os {hist.conferencia.enviadosPorNos} leads que enviamos nos últimos 7 dias estão lá.
          </p>
        ) : (
          <p className="mt-1 text-xs leading-relaxed text-rose-300">
            {faltando} de {hist.conferencia.enviadosPorNos} leads que enviamos NÃO estão no CRM da
            franquia (ids {hist.conferencia.faltando?.slice(0, 5).join(', ')}). Algo mudou do lado
            deles — ou o lead foi apagado por lá.
          </p>
        )}
      </div>

      {hist.links.length > 0 ? (
        <ul className="mt-4 space-y-1.5">
          {hist.links.slice(0, 15).map((l) => (
            <li key={l.id} className="flex flex-wrap items-center gap-2 text-xs">
              <span
                className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                  l.status === 'ok'
                    ? 'bg-emerald-400'
                    : l.status === 'falhou'
                      ? 'bg-rose-400'
                      : 'bg-zinc-600'
                }`}
              />
              <span className="tabular-nums text-zinc-400">Kommo {l.kommoLeadId}</span>
              {l.spineIdLead ? (
                <>
                  <PiArrowRightBold size={11} className="text-zinc-600" />
                  <span className="tabular-nums text-emerald-400">franquia {l.spineIdLead}</span>
                </>
              ) : (
                <span className="truncate text-zinc-500">{l.motivo}</span>
              )}
              {l.tentativas > 3 && !l.spineIdLead && (
                <span className="text-amber-400">{l.tentativas} tentativas</span>
              )}
              <span className="ml-auto text-zinc-600">
                {new Date(l.updatedAt).toLocaleString('pt-BR', {
                  day: '2-digit',
                  month: '2-digit',
                  hour: '2-digit',
                  minute: '2-digit',
                })}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-4 text-xs text-zinc-500">Nenhum lead processado ainda.</p>
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

function Interruptor({
  ligado,
  onChange,
  titulo,
  ligadoTexto,
  desligadoTexto,
  desabilitado,
}: {
  ligado: boolean;
  onChange: (v: boolean) => void;
  titulo: string;
  ligadoTexto: string;
  desligadoTexto: string;
  desabilitado?: boolean;
}) {
  return (
    <button
      type="button"
      disabled={desabilitado}
      onClick={() => onChange(!ligado)}
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
        <span className="block text-sm font-medium text-zinc-200">{titulo}</span>
        <span className="mt-0.5 block text-xs leading-relaxed text-zinc-400">
          {ligado ? ligadoTexto : desligadoTexto}
        </span>
      </span>
    </button>
  );
}

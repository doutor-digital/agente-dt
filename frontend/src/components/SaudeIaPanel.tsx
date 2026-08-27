import { useEffect, useState } from 'react';
import { Loader2, RefreshCw, ShieldCheck, ShieldAlert, ShieldX, Zap } from 'lucide-react';
import clsx from 'clsx';
import { api } from '../lib/api';
import { useUnit } from '../context/UnitContext';
import type { SaudeIa, ItemSaude, EstadoItem } from '../types/api';

/**
 * "Saúde da IA" — o que ela tem, o que está ligado e o que falta.
 *
 * Esta tela existe por um motivo específico: aqui, recurso pronto e desligado
 * custou mais caro que recurso inexistente. A IA tinha todas as ferramentas de
 * agendamento e uma regra escondida mandava não usar — 82 transferências contra
 * 39 agendamentos em 30 dias, sem ninguém saber. O guardar-token da franquia
 * estava pronto há meses e nunca teve tela.
 *
 * Por isso os itens vêm do servidor lendo ambiente e configuração de verdade, e
 * não de uma lista escrita à mão: um painel que mente é pior que nenhum painel.
 * E o que dá pra ligar sem código aparece com a instrução do lado — senão vira
 * mais uma coisa que só o desenvolvedor sabe resolver.
 */

const ESTADO = {
  ok: {
    Icon: ShieldCheck,
    rotulo: 'no ar',
    cor: 'text-emerald-300',
    fundo: 'bg-emerald-400/10 ring-emerald-400/20',
    ponto: 'bg-emerald-400',
  },
  parcial: {
    Icon: ShieldAlert,
    rotulo: 'pela metade',
    cor: 'text-amber-300',
    fundo: 'bg-amber-400/10 ring-amber-400/20',
    ponto: 'bg-amber-400',
  },
  falta: {
    Icon: ShieldX,
    rotulo: 'falta',
    cor: 'text-rose-300',
    fundo: 'bg-rose-400/10 ring-rose-400/20',
    ponto: 'bg-rose-400',
  },
} as const satisfies Record<EstadoItem, unknown>;

function Cartao({ item }: { item: ItemSaude }) {
  const e = ESTADO[item.estado];
  return (
    <div className="rounded-xl border border-white/[0.07] bg-white/[0.02] p-4">
      <div className="flex items-start justify-between gap-3">
        <h4 className="text-[13.5px] font-medium text-slate-100">{item.titulo}</h4>
        <span
          className={clsx(
            'shrink-0 rounded px-1.5 py-0.5 text-[9.5px] font-semibold uppercase tracking-[0.08em] ring-1 ring-inset',
            e.fundo,
            e.cor,
          )}
        >
          {e.rotulo}
        </span>
      </div>

      <p className="mt-2 text-[12px] leading-relaxed text-slate-400">{item.oQueFaz}</p>

      {item.oQueFalta ? (
        <p className="mt-2 text-[12px] leading-relaxed text-slate-500">
          <span className="text-slate-400">O que falta:</span> {item.oQueFalta}
        </p>
      ) : null}

      {item.comoLigar ? (
        <p className="mt-2.5 flex items-start gap-1.5 rounded-lg bg-sky-400/[0.07] px-2.5 py-2 text-[11.5px] leading-relaxed text-sky-100 ring-1 ring-inset ring-sky-400/15">
          <Zap className="mt-[2px] h-3 w-3 shrink-0" />
          <span>{item.comoLigar}</span>
        </p>
      ) : null}

      {item.onde ? (
        <p className="mt-2 font-mono text-[10.5px] text-slate-600">{item.onde}</p>
      ) : null}
    </div>
  );
}

export function SaudeIaPanel() {
  const { selectedUnit } = useUnit();
  const unitId = selectedUnit?.id ?? '';
  const [data, setData] = useState<SaudeIa | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [carregando, setCarregando] = useState(true);

  async function carregar() {
    setCarregando(true);
    setErro(null);
    try {
      setData(await api.saudeIa(unitId));
    } catch (e) {
      setErro(e instanceof Error ? e.message : 'Falha ao carregar');
    } finally {
      setCarregando(false);
    }
  }

  useEffect(() => {
    if (!unitId) return;
    void carregar();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [unitId]);

  if (!unitId) {
    return <p className="p-6 text-[13px] text-slate-500">Escolha uma unidade para ver a saúde da IA.</p>;
  }

  if (carregando && !data) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="h-5 w-5 animate-spin text-white/30" />
      </div>
    );
  }

  if (erro) {
    return <p className="p-6 text-[13px] text-rose-300">{erro}</p>;
  }
  if (!data) return null;

  const { resumo } = data;
  const pendentes = data.grupos
    .flatMap((g) => g.itens)
    .filter((i) => i.estado !== 'ok' && i.comoLigar);

  return (
    <div className="mx-auto max-w-5xl space-y-6 p-4 sm:p-6">
      <header>
        <h2 className="text-[19px] font-semibold tracking-tight text-slate-100">Saúde da IA</h2>
        <p className="mt-1 max-w-[68ch] text-[12.5px] leading-relaxed text-slate-500">
          O que a IA desta unidade tem, o que está ligado e o que falta. Lido da configuração real —
          não é uma lista escrita à mão.
        </p>
      </header>

      <div className="flex flex-wrap items-center gap-3">
        {(['ok', 'parcial', 'falta'] as const).map((k) => (
          <div
            key={k}
            className="flex items-center gap-2 rounded-lg border border-white/[0.07] bg-white/[0.02] px-3 py-2"
          >
            <span className={clsx('h-2 w-2 rounded-full', ESTADO[k].ponto)} />
            <span className="font-mono text-[15px] tabular-nums text-slate-100">{resumo[k]}</span>
            <span className="text-[11.5px] text-slate-500">{ESTADO[k].rotulo}</span>
          </div>
        ))}
        <button
          onClick={() => void carregar()}
          disabled={carregando}
          className="ml-auto flex items-center gap-1.5 rounded-md border border-white/[0.1] px-2.5 py-1.5 text-[12px] text-slate-300 transition hover:bg-white/[0.05] disabled:opacity-40"
        >
          <RefreshCw className={clsx('h-3 w-3', carregando && 'animate-spin')} />
          Atualizar
        </button>
      </div>

      {pendentes.length > 0 ? (
        <div className="rounded-xl border border-sky-400/20 bg-sky-400/[0.05] p-4">
          <h3 className="flex items-center gap-2 text-[13px] font-medium text-sky-100">
            <Zap className="h-3.5 w-3.5" />
            {pendentes.length === 1
              ? '1 item liga sem precisar de código'
              : `${pendentes.length} itens ligam sem precisar de código`}
          </h3>
          <ul className="mt-2 space-y-1">
            {pendentes.map((i) => (
              <li key={i.chave} className="text-[12px] leading-relaxed text-sky-100/80">
                <span className="text-sky-100">{i.titulo}</span> — {i.comoLigar}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {data.grupos.map((g) => (
        <section key={g.grupo}>
          <h3 className="mb-3 text-[10.5px] font-medium uppercase tracking-[0.12em] text-slate-500">
            {g.grupo}
          </h3>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            {g.itens.map((i) => (
              <Cartao key={i.chave} item={i} />
            ))}
          </div>
        </section>
      ))}

      <p className="border-t border-white/[0.06] pt-4 text-[11.5px] leading-relaxed text-slate-600">
        Esta tela existe porque recurso pronto e desligado já custou mais caro aqui que recurso
        inexistente — ninguém lembra do que não vê.
      </p>
    </div>
  );
}

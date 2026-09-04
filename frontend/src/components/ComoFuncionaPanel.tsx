import { useEffect, useState } from 'react';
import { ArrowUpRight, ListChecks, Loader2, RefreshCw } from 'lucide-react';
import clsx from 'clsx';
import { api } from '../lib/api';
import { useUnit } from '../context/UnitContext';
import type { AppTab } from '../lib/nav';
import type { Funcionamento, Unit } from '../types/api';

/**
 * "Como a Sofia funciona" — o catálogo dos comportamentos da IA, com número ao lado.
 *
 * Pedido do João (04/09/2026): "quero ver isso tudo no meu front, senão eu não
 * consigo entender; senão fica internalizado só no backend". Cada comportamento
 * aparece com o que faz, por que existe (o caso real que o motivou), onde se
 * controla, se está ligado nesta unidade, e quantas vezes aconteceu no período.
 * Comportamento sem número é comportamento que ninguém sabe se está acontecendo.
 */

type Estado = 'ligado' | 'desligado' | 'sempre';

interface Item {
  titulo: string;
  oQueFaz: string;
  porQue: string;
  onde?: { tab: AppTab; rotulo: string };
  estado: (u: Unit) => Estado;
  contador: (f: Funcionamento) => string | null;
}

interface Grupo {
  titulo: string;
  descricao: string;
  itens: Item[];
}

const sempre = () => 'sempre' as const;
const flag = (k: keyof Unit) => (u: Unit) => ((u[k] as boolean | undefined) ? 'ligado' : 'desligado') as Estado;
const n = (v: number, um: string, varios: string) => `${v} ${v === 1 ? um : varios}`;

const GRUPOS: Grupo[] = [
  {
    titulo: '1. Quando a mensagem chega',
    descricao: 'Antes de pensar em resposta, a IA decide se e quando responder.',
    itens: [
      {
        titulo: 'Agrupar mensagens em rajada',
        oQueFaz: 'Se o paciente manda "oi" / "tudo bem?" / "queria marcar" em sequência, a IA espera alguns segundos e responde uma vez só, ao conjunto.',
        porQue: 'Sem isso cada linha virava uma resposta e a conversa ficava com três "oi, tudo bem" seguidos.',
        estado: sempre,
        contador: (f) => `${n(f.contadores.burstsAgrupados, 'rajada agrupada', 'rajadas agrupadas')} · espera de ${Math.round(f.agenda.coalesceMs / 1000)} s`,
      },
      {
        titulo: 'Encerramento sem eco',
        oQueFaz: 'Um "obrigado" ganha uma despedida. O segundo agradecimento em sequência (ou um emoji solto) fica sem resposta.',
        porQue: 'Carlos, Parauapebas, 04/09: "Ok obrigado" → "Eu que agradeço" → 🙏 → "Por nada". Cada agradecimento virava mais uma despedida.',
        estado: sempre,
        contador: (f) => n(f.rastros.encerramentoRepetido, 'agradecimento deixado em silêncio', 'agradecimentos deixados em silêncio'),
      },
      {
        titulo: 'IA pausada pela equipe',
        oQueFaz: 'Quando a recepção assume o lead (campo "Pausar IA"), a IA lê a mensagem, não responde e avisa a equipe se o paciente insistir.',
        porQue: 'Neta, Boa Vista, 29/08: escreveu "urgente!!!!" com a IA pausada e ninguém viu. Agora a insistência gera alerta.',
        estado: sempre,
        contador: (f) => n(f.rastros.pausados, 'mensagem recebida com a IA pausada', 'mensagens recebidas com a IA pausada'),
      },
      {
        titulo: 'Só responde nas etapas dela',
        oQueFaz: 'Cada IA (comercial, resgate) é dona de algumas etapas do funil. Lead em outra etapa não recebe resposta desta IA.',
        porQue: 'Duas IAs falando com o mesmo paciente disputavam o lead. Uma etapa, uma dona.',
        onde: { tab: 'config', rotulo: 'Etapas & Ativação' },
        estado: sempre,
        contador: (f) => n(f.rastros.etapaNaoPermitida, 'mensagem fora das etapas desta IA', 'mensagens fora das etapas desta IA'),
      },
      {
        titulo: 'Horário comercial e feriados',
        oQueFaz: 'Fora do horário configurado (e em feriado nacional), a IA não responde: manda a mensagem automática de fora do expediente.',
        porQue: 'Feriado nacional entrou no código em 04/09 depois de Porto Nacional dizer "teremos atendimento" em 07/09.',
        onde: { tab: 'wizard', rotulo: 'Wizard › Horário comercial' },
        estado: flag('businessHoursEnabled'),
        contador: (f) => `${n(f.rastros.foraDoHorario, 'mensagem fora do horário', 'mensagens fora do horário')} · próximos feriados: ${f.agenda.feriadosProximos.map((x) => x.data.slice(8, 10) + '/' + x.data.slice(5, 7)).join(', ') || 'nenhum em 30 dias'}`,
      },
    ],
  },
  {
    titulo: '2. Entendendo o paciente',
    descricao: 'O que a IA sabe antes de escrever: data de hoje, quem é o paciente, o que ele já disse.',
    itens: [
      {
        titulo: 'Calendário com dia da semana e feriados',
        oQueFaz: 'A IA recebe "hoje é sexta-feira, 04/09/2026" e os próximos 21 dias com o dia da semana calculado. Ferramentas devolvem "terça-feira, 08/09".',
        porQue: 'Serra, 02/09: confirmou "segunda-feira, 08/09". Era terça. O modelo usava o calendário de 2025.',
        estado: sempre,
        contador: (f) => `hoje ${f.agenda.hoje.slice(8, 10)}/${f.agenda.hoje.slice(5, 7)} no fuso ${f.agenda.fuso}`,
      },
      {
        titulo: 'Captura de dados no cartão',
        oQueFaz: 'Queixa, intenção, qualificação, cidade, sexo, preferência de horário, sentimento: a IA grava no Kommo conforme o paciente fala.',
        porQue: 'Campo manual fica vazio em 9 de 10 unidades. Campo que a IA preenche vira dado.',
        onde: { tab: 'captures', rotulo: 'Capturas' },
        estado: sempre,
        contador: (f) => n(f.contadores.capturas, 'dado gravado no cartão', 'dados gravados no cartão'),
      },
      {
        titulo: 'Nome antes de tudo',
        oQueFaz: 'Pede o nome no primeiro contato e renomeia o cartão ("Nome DD/MM/AAAA"). Se a IA esquecer, uma rede de segurança faz por ela.',
        porQue: 'Cartão "Lead #7815460" não serve para a SDR nem para o relatório.',
        onde: { tab: 'wizard', rotulo: 'Wizard › Coleta de nome' },
        estado: flag('collectNameEnabled'),
        contador: (f) => n(f.contadores.safetyNet, 'vez que a rede de segurança completou o nome', 'vezes que a rede de segurança completou o nome'),
      },
      {
        titulo: 'Memória do lead',
        oQueFaz: 'Fatos ditos pelo paciente (queixa, exames, cidade, plano) ficam guardados e voltam para a IA em cada mensagem, mesmo dias depois.',
        porQue: 'Sem memória, a IA repetia perguntas e o paciente sentia que falava com um robô diferente a cada vez.',
        onde: { tab: 'conversations', rotulo: 'Conversas' },
        estado: sempre,
        contador: (f) => n(f.conversas.total, 'conversa no período', 'conversas no período'),
      },
    ],
  },
  {
    titulo: '3. Respondendo',
    descricao: 'Regras que valem em toda resposta, antes de ela sair.',
    itens: [
      {
        titulo: 'Persona, tom e fontes oficiais',
        oQueFaz: 'Quem é a Sofia, como fala, o que a clínica oferece, endereço, Pix e valores. Tudo vem das fontes da unidade, nunca de cabeça.',
        porQue: 'Em agosto, todas as unidades tinham Pix e endereço da Imperatriz herdados no clone.',
        onde: { tab: 'sources', rotulo: 'Fontes' },
        estado: sempre,
        contador: () => null,
      },
      {
        titulo: 'Trava de preço',
        oQueFaz: 'Preço que não está nas fontes é corrigido antes de sair. A confirmação de agendamento usa a linha de valor da unidade: "R$ X antecipado (pago antes) ou R$ Y no dia".',
        porQue: 'Serra, 02/09: "R$ 220 no PIX à vista" para paciente particular. O modelo da mensagem tinha um valor fixo no código.',
        onde: { tab: 'sources', rotulo: 'Fontes › Produtos e valores' },
        estado: sempre,
        contador: () => null,
      },
      {
        titulo: 'Triagem e qualificação',
        oQueFaz: 'Uma pergunta por vez: onde dói, há quanto tempo, sinais de alarme. Quente/morno/frio vai para o cartão.',
        porQue: 'Sem triagem a IA vendia consulta para quem precisava de emergência.',
        onde: { tab: 'wizard', rotulo: 'Wizard › Triagem' },
        estado: (u) => (u.triageEnabled || u.qualificationEnabled ? 'ligado' : 'desligado'),
        contador: () => null,
      },
    ],
  },
  {
    titulo: '4. Agendando na franquia',
    descricao: 'A parte que vira dinheiro: horários reais, confirmados com o sistema da clínica.',
    itens: [
      {
        titulo: 'Consulta à agenda com sondagem',
        oQueFaz: 'Monta a grade do dia (janela, almoço, bloqueios, consultas), escolhe até 4 horários e testa cada um na franquia criando e cancelando. Só oferece o que a franquia aceitou.',
        porQue: 'Boa Vista ficou 60 dias sem marcar: sem paciente de sondagem, oferecia horário que a franquia recusava. A recusa depende da agenda do profissional, não do que aparece na busca.',
        onde: { tab: 'crm-franquia', rotulo: 'CRM da franquia' },
        estado: flag('spineEnabled'),
        contador: (f) => `${n(f.sondagem.consultas, 'consulta à agenda', 'consultas à agenda')} · ${f.sondagem.sondados} horários testados · ${f.sondagem.recusados} recusados · ${f.sondagem.oferecidos} oferecidos`,
      },
      {
        titulo: 'Bloqueios da recepção',
        oQueFaz: 'Três vezes ao dia lê a agenda da franquia e importa feriados, folgas e "sem atendimento" marcados pela recepção. Falha vira aviso no WhatsApp.',
        porQue: 'A senha venceu em 28/08 e ninguém soube por 7 dias. Agora avisa.',
        onde: { tab: 'agenda', rotulo: 'Agenda' },
        estado: flag('spineEnabled'),
        contador: (f) => n(f.agenda.bloqueiosFuturos, 'bloqueio futuro conhecido', 'bloqueios futuros conhecidos'),
      },
      {
        titulo: 'Horário por dia da semana',
        oQueFaz: 'Cada dia pode ter janela própria. O sábado costuma ir até 12h ou 13h, diferente da semana.',
        porQue: 'Todas as unidades atendem sábado e a IA recusava, porque a configuração era segunda a sexta.',
        onde: { tab: 'crm-franquia', rotulo: 'CRM da franquia › Quando a clínica atende' },
        estado: flag('spineEnabled'),
        contador: (f) => {
          const j = f.agenda.janela;
          const sab = j.porDia?.['6'];
          return `${j.inicio}–${j.fim}${j.almoco[0] ? ` (almoço ${j.almoco[0]}–${j.almoco[1]})` : ''}${sab ? ` · sábado ${sab.start}–${sab.end}` : j.dias.includes(6) ? ' · sábado igual à semana' : ' · sem sábado'}`;
        },
      },
      {
        titulo: 'Marcar, remarcar, cancelar, confirmar',
        oQueFaz: 'Cria a consulta na franquia, grava data, responsável e situação no Kommo, e move o lead para AGENDADO. Um paciente, uma consulta.',
        porQue: 'Marcação só existe se a franquia aceitou. A IA nunca diz "confirmado" antes disso.',
        onde: { tab: 'agenda', rotulo: 'Agenda' },
        estado: flag('spineEnabled'),
        contador: (f) => `${n(f.contadores.consultasMarcadas, 'consulta marcada', 'consultas marcadas')} · ${f.contadores.agendarFalhou} recusadas pela franquia`,
      },
      {
        titulo: 'Conferência de paciente',
        oQueFaz: 'Antes de marcar, remarcar ou cancelar, confere se o paciente é o desta conversa. Divergiu, não mexe.',
        porQue: 'O estrago de cancelar a consulta de outra pessoa é invisível: a resposta parece normal.',
        estado: sempre,
        contador: () => null,
      },
    ],
  },
  {
    titulo: '5. Depois da conversa',
    descricao: 'O que acontece quando o paciente para de responder ou quando um humano entra.',
    itens: [
      {
        titulo: 'Follow-up',
        oQueFaz: 'Escada de retomadas para quem parou de responder, dentro da janela de 24 h do WhatsApp e do horário da clínica.',
        porQue: 'Lead que esfria em silêncio é lead perdido. A escada é configurável por unidade.',
        onde: { tab: 'follow-up', rotulo: 'Follow-up' },
        estado: flag('followUpEnabled'),
        contador: (f) => n(f.conversas.followUps, 'follow-up enviado', 'follow-ups enviados'),
      },
      {
        titulo: 'EM ESPERA em vez de PERDIDO',
        oQueFaz: 'Quem quer, mas agora não pode (exames, viagem, decisão), vai para EM ESPERA com data de retomada e motivo. A retomada é por template na data.',
        porQue: 'Imperatriz tinha 2.000 leads em PERDIDO e o motivo "exames" usado uma vez.',
        onde: { tab: 'config', rotulo: 'Etapas & Ativação' },
        estado: sempre,
        contador: (f) => n(f.contadores.leadsMovidos, 'lead movido de etapa', 'leads movidos de etapa'),
      },
      {
        titulo: 'Passagem para humano',
        oQueFaz: 'Quando o caso pede gente (sinal de alarme, pedido explícito, irritação), a IA carimba o handoff, resume a conversa numa nota e para.',
        porQue: 'Handoff sem resumo obrigava a SDR a ler tudo de novo.',
        onde: { tab: 'wizard', rotulo: 'Wizard › Handoff' },
        estado: flag('handoffEnabled'),
        contador: (f) => `${n(f.conversas.handoffs, 'passagem para humano', 'passagens para humano')} · ${f.contadores.resumosSdr} resumos para a SDR`,
      },
      {
        titulo: 'Reativação do lead quente',
        oQueFaz: 'Se a equipe assumiu e não agiu em 30 minutos, a IA volta para não perder o lead.',
        porQue: 'Lead quente esquecido depois do handoff era a perda mais cara.',
        estado: sempre,
        contador: (f) => n(f.conversas.reativacoes, 'reativação', 'reativações'),
      },
      {
        titulo: 'Alertas para a equipe',
        oQueFaz: 'Lead sem resposta há N minutos, agendamento que a IA ofereceu e não fechou, paciente insistindo com a IA pausada: vira tarefa no Kommo e mensagem no grupo da unidade.',
        porQue: 'Só a Imperatriz alimentava alertas até 03/09. Agora 11 unidades.',
        estado: sempre,
        contador: (f) => `${n(f.contadores.alertas, 'alerta', 'alertas')} · ${f.contadores.tarefasCriadas} tarefas criadas`,
      },
      {
        titulo: 'Juiz de qualidade e lições',
        oQueFaz: 'Um segundo modelo lê as conversas, aponta o que saiu do combinado e gera lições que voltam para o prompt na semana seguinte.',
        porQue: 'Aprender com o que deu errado, sem depender de alguém ler 3.800 conversas por mês.',
        onde: { tab: 'training', rotulo: 'Treinamento' },
        estado: sempre,
        contador: () => null,
      },
      {
        titulo: 'Livro de resultados',
        oQueFaz: 'De cada conversa: marcou? compareceu? Lido do Kommo e da franquia. É a recompensa real da IA, base dos próximos experimentos.',
        porQue: 'Nota de estilo não paga consulta. Comparecimento paga.',
        onde: { tab: 'resultados', rotulo: 'Resultados' },
        estado: sempre,
        contador: (f) => `${f.resultados.agendouQualquer} marcaram de ${f.resultados.comPaciente} conversas (${f.resultados.dias} dias) · comparecimento ${f.resultados.taxaComparecimento ?? '—'}%`,
      },
    ],
  },
  {
    titulo: '6. Entregando a resposta',
    descricao: 'O caminho da resposta até o WhatsApp do paciente, e o que acontece quando o Kommo falha.',
    itens: [
      {
        titulo: 'Entrega pelo Salesbot',
        oQueFaz: 'A resposta é gravada no campo "Resposta da IA" e o Salesbot da unidade a envia. Em modo widget, vai direto.',
        porQue: 'O Kommo relia o campo e reenviava em loop; o modo widget mata duplicata e chunking.',
        onde: { tab: 'delivery', rotulo: 'Monitor de entrega' },
        estado: (u) => (u.kommoSalesbotExecuteEnabled || u.kommoWidgetReplyEnabled ? 'ligado' : 'desligado'),
        contador: (f) => `${n(f.contadores.entregasSalesbot, 'resposta entregue', 'respostas entregues')} · ${f.contadores.entregasNota} viraram nota interna`,
      },
      {
        titulo: 'Leitura de confirmação e fallback',
        oQueFaz: 'Depois de gravar, relê o campo para conferir se o Kommo guardou o texto. Se a gravação falhar, a resposta vira nota interna e a equipe é avisada.',
        porQue: 'Emoji de 4 bytes cortava a mensagem no meio; o readback pegou.',
        onde: { tab: 'delivery', rotulo: 'Monitor de entrega' },
        estado: sempre,
        contador: (f) => `${f.contadores.readbackDivergiu} divergências · ${f.contadores.patchFalhou} falhas de gravação · ${f.contadores.fallbackNota} fallbacks`,
      },
      {
        titulo: 'Custo do modelo',
        oQueFaz: 'Cada chamada ao modelo é registrada com custo, latência e erro.',
        porQue: 'Política: mediana 2–4 s, p95 até 6 s; energia vai para custo, não para latência.',
        onde: { tab: 'llm', rotulo: 'Chamadas ao modelo' },
        estado: sempre,
        contador: (f) => `${f.llm.chamadas} chamadas · US$ ${f.llm.custoUsd.toFixed(2)}`,
      },
    ],
  },
];

const BADGE: Record<Estado, { rotulo: string; cls: string }> = {
  ligado: { rotulo: 'ligado', cls: 'bg-emerald-400/10 text-emerald-300 ring-emerald-400/20' },
  desligado: { rotulo: 'desligado', cls: 'bg-rose-400/10 text-rose-300 ring-rose-400/20' },
  sempre: { rotulo: 'sempre ativo', cls: 'bg-sky-400/10 text-sky-300 ring-sky-400/20' },
};

export function ComoFuncionaPanel({ onNavigate }: { onNavigate: (tab: AppTab) => void }) {
  const { selectedUnit } = useUnit();
  const unitId = selectedUnit?.id ?? '';
  const [dias, setDias] = useState(7);
  const [f, setF] = useState<Funcionamento | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [carregando, setCarregando] = useState(true);

  async function carregar() {
    setCarregando(true);
    setErro(null);
    try {
      setF(await api.funcionamento(unitId, dias));
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
  }, [unitId, dias]);

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="flex items-center gap-2 text-lg font-semibold text-zinc-100">
            <ListChecks size={18} className="text-sky-300" /> Como a Sofia funciona
          </h1>
          <p className="mt-1 max-w-3xl text-sm leading-relaxed text-zinc-400">
            Cada comportamento da IA, do jeito que acontece de verdade: o que faz, por que existe, onde se controla e
            quantas vezes aconteceu nesta unidade no período. O que está marcado como <span className="text-sky-300">sempre ativo</span> vive
            no código e vale para todas as unidades.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {[7, 30].map((p) => (
            <button
              key={p}
              type="button"
              onClick={() => setDias(p)}
              className={clsx(
                'rounded-lg px-3 py-1.5 text-xs font-medium ring-1 transition-colors',
                dias === p ? 'bg-sky-500/10 text-sky-300 ring-sky-500/25' : 'text-zinc-500 ring-zinc-800 hover:text-zinc-300',
              )}
            >
              {p} dias
            </button>
          ))}
          <button type="button" onClick={() => void carregar()} className="ml-2 inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs text-zinc-300 ring-1 ring-zinc-800 hover:text-zinc-100">
            {carregando ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />} Atualizar
          </button>
        </div>
      </header>

      {erro ? <div className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-200">{erro}</div> : null}

      {f ? (
        <section className="grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
          {[
            ['Mensagens recebidas', f.rastros.total],
            ['Respondidas pela IA', f.rastros.respondidos],
            ['Com a IA pausada', f.rastros.pausados],
            ['Fora das etapas dela', f.rastros.etapaNaoPermitida],
            ['Agrupadas em rajada', f.rastros.agrupados],
            ['Sem eco de despedida', f.rastros.encerramentoRepetido],
          ].map(([r, v]) => (
            <div key={String(r)} className="rounded-xl border border-white/[0.07] bg-white/[0.02] p-3">
              <div className="text-[10.5px] uppercase tracking-[0.08em] text-slate-500">{r}</div>
              <div className="mt-1 text-xl font-semibold tabular-nums text-slate-100">{v}</div>
            </div>
          ))}
        </section>
      ) : null}

      {GRUPOS.map((g) => (
        <section key={g.titulo} className="surface p-6">
          <h2 className="text-sm font-semibold text-zinc-100">{g.titulo}</h2>
          <p className="mt-1 text-[12.5px] text-zinc-500">{g.descricao}</p>
          <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {g.itens.map((it) => {
              const estado = selectedUnit ? it.estado(selectedUnit) : 'sempre';
              const b = BADGE[estado];
              const contador = f ? it.contador(f) : null;
              return (
                <div key={it.titulo} className="rounded-xl border border-white/[0.07] bg-white/[0.02] p-4">
                  <div className="flex items-start justify-between gap-3">
                    <h4 className="text-[13.5px] font-medium text-slate-100">{it.titulo}</h4>
                    <span className={clsx('shrink-0 rounded px-1.5 py-0.5 text-[9.5px] font-semibold uppercase tracking-[0.08em] ring-1 ring-inset', b.cls)}>{b.rotulo}</span>
                  </div>
                  <p className="mt-2 text-[12px] leading-relaxed text-slate-400">{it.oQueFaz}</p>
                  <p className="mt-2 text-[11.5px] leading-relaxed text-slate-500"><span className="text-slate-400">Por que existe:</span> {it.porQue}</p>
                  {contador ? (
                    <p className="mt-2.5 rounded-lg bg-emerald-400/[0.07] px-2.5 py-2 text-[11.5px] leading-relaxed text-emerald-100 ring-1 ring-inset ring-emerald-400/15 tabular-nums">
                      Nos últimos {f?.dias} dias: {contador}
                    </p>
                  ) : null}
                  {it.onde ? (
                    <button type="button" onClick={() => onNavigate(it.onde!.tab)} className="mt-2.5 inline-flex items-center gap-1 text-[11.5px] text-sky-300 hover:text-sky-200">
                      Controlar em {it.onde.rotulo} <ArrowUpRight size={12} />
                    </button>
                  ) : (
                    <p className="mt-2.5 text-[11px] text-slate-600">Regra do código, igual em todas as unidades.</p>
                  )}
                </div>
              );
            })}
          </div>
        </section>
      ))}
    </div>
  );
}

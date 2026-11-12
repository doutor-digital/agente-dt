/**
 * Tela "HOJE" do Chatwoot (design da tela Início do painel da Lia, pedido do João em 12/11/2026). Aqui só a CONTA (pura): dadas as
 * conversas que a pessoa enxerga (a listagem do Chatwoot, com o login dela), o dia em Belém e quais conversas entraram em
 * «Agendado» hoje (memória da régua), devolve os números do dia, «A Lia separou», «Faça agora» e «Por usuário hoje».
 *
 * Definições (o que cada número conta), escritas também na tela:
 *  - Chegaram hoje: conversa criada hoje.
 *  - Esperando resposta: o Chatwoot marca `waiting_since` (paciente falou e ninguém respondeu).
 *  - Não interagiram: etiqueta `sem-resposta`, ou em qualificação com a última mensagem NOSSA há mais de 24 h.
 *  - Agendaram hoje: entraram em «Agendado» hoje (o worker da régua anota quando a etapa muda).
 *  - Hoje na agenda: `data_consulta` = hoje. Falta confirmar: consulta hoje ou amanhã ainda «Agendado».
 *  - A Lia separou: consultaram e não fecharam; alta há 60 dias ou mais (retorno); `retomar_em` vencido; faltaram (7 dias).
 *  - Meta do dia: agendamentos por dia de cada caixa (`META_AGENDAMENTOS_POR_CAIXA`), somada nas caixas que a pessoa enxerga.
 */
const DIA = 86_400_000;
const UTC_MENOS_3 = 3 * 3600_000;
const ETAPAS_QUALIFICACAO = new Set(['Novo lead', 'Sofia qualifica', 'Esperando humano']);
export const MAX_FACA_AGORA = 8;
/** caixa do Chatwoot → meta de agendamentos por dia (decisão 30 do João, 12/11/2026: Parauapebas = 5). */
export const META_AGENDAMENTOS_POR_CAIXA: Readonly<Record<number, number>> = { 2: 5 };

export interface ItemDoDia {
  id: number;
  nome: string;
  detalhe: string;
}

export interface Hoje {
  dia: string;
  numeros: { chegaram: number; esperando: number; naoInteragiram: number; agendaram: number; naAgenda: number; faltaConfirmar: number };
  /** meta de agendamentos do dia nas caixas da lista (null = nenhuma caixa com meta) */
  meta: number | null;
  separou: { naoFecharam: ItemDoDia[]; retorno60: ItemDoDia[]; verDepois: ItemDoDia[]; faltaram: ItemDoDia[] };
  facaAgora: Array<ItemDoDia & { quente: boolean; esperandoMin: number }>;
  porUsuario: Array<{ nome: string; conversas: number; esperando: number; responderamHoje: number; agendaram: number }>;
}

/** "2026-11-12" em Belém para um instante. */
export function diaEmBelem(t: number): string {
  return new Date(t - UTC_MENOS_3).toISOString().slice(0, 10);
}
const somar = (dia: string, n: number) => new Date(Date.parse(`${dia}T00:00:00Z`) + n * DIA).toISOString().slice(0, 10);
const str = (v: unknown) => (typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : '');
const sim = (v: unknown) => v === true || ['true', 'sim', '1'].includes(str(v).toLowerCase());
const data10 = (v: unknown) => (/^\d{4}-\d{2}-\d{2}/.test(str(v)) ? str(v).slice(0, 10) : '');

function nomeDe(c: any): string {
  return str(c?.meta?.sender?.name) || str(c?.meta?.sender?.phone_number) || `Conversa ${c?.id}`;
}

function minutos(ms: number): string {
  const m = Math.max(0, Math.round(ms / 60_000));
  if (m < 60) return `${m} min`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h} h` : `${Math.round(h / 24)} dias`;
}

/** As conversas cruas das páginas da listagem do Chatwoot (`data.payload`), sem grupo e sem repetir. */
export function conversasDasPaginas(paginas: unknown[]): any[] {
  const vistos = new Set<number>();
  const saida: any[] = [];
  for (const p of paginas as any[]) {
    for (const c of p?.data?.payload ?? []) {
      const id = Number(c?.id);
      if (!Number.isInteger(id) || vistos.has(id)) continue;
      if (/@g\.us$/i.test(str(c?.meta?.sender?.identifier))) continue;
      vistos.add(id);
      saida.push(c);
    }
  }
  return saida;
}

export function montarHoje(conversas: any[], agora: number, agendadasHoje: ReadonlySet<number>): Hoje {
  const dia = diaEmBelem(agora);
  const amanha = somar(dia, 1);
  const n = { chegaram: 0, esperando: 0, naoInteragiram: 0, agendaram: 0, naAgenda: 0, faltaConfirmar: 0 };
  const separou: Hoje['separou'] = { naoFecharam: [], retorno60: [], verDepois: [], faltaram: [] };
  const facaAgora: Hoje['facaAgora'] = [];
  const porUsuario = new Map<string, Hoje['porUsuario'][number]>();
  const caixas = new Set<number>();

  for (const c of conversas) {
    const a = c?.custom_attributes ?? {};
    const etiquetas: string[] = Array.isArray(c?.labels) ? c.labels.map(String) : [];
    const etapa = str(a.etapa);
    const id = Number(c.id);
    const nome = nomeDe(c);
    const criada = Number(c?.created_at) * 1000;
    const esperandoDesde = Number(c?.waiting_since) * 1000;
    const ultima = c?.last_non_activity_message;
    const ultimaNossa = ultima && Number(ultima.message_type) === 1 && ultima.private !== true;
    const ultimaEm = Number(ultima?.created_at) * 1000;
    const quente = str(a.qualificacao) === 'Quente' || etiquetas.includes('quente');
    const responsavel = str(c?.meta?.assignee?.name) || 'Sem responsável';
    const caixa = Number(c?.inbox_id);
    if (Number.isInteger(caixa)) caixas.add(caixa);

    if (criada && diaEmBelem(criada) === dia) n.chegaram++;
    const esperando = Number.isFinite(esperandoDesde) && esperandoDesde > 0 && c?.status !== 'resolved';
    if (esperando) {
      n.esperando++;
      facaAgora.push({ id, nome, quente, esperandoMin: Math.round((agora - esperandoDesde) / 60_000), detalhe: `${quente ? 'Quente · ' : ''}esperando você há ${minutos(agora - esperandoDesde)}${etapa ? ` · ${etapa}` : ''}` });
    }
    if (etiquetas.includes('sem-resposta') || (ETAPAS_QUALIFICACAO.has(etapa) && ultimaNossa && agora - ultimaEm > DIA)) n.naoInteragiram++;
    if (agendadasHoje.has(id)) n.agendaram++;

    const consulta = data10(a.data_consulta);
    const situ = str(a.situacao_consulta);
    if (consulta === dia) n.naAgenda++;
    if ((consulta === dia || consulta === amanha) && (situ === '' || situ === 'Agendado')) n.faltaConfirmar++;

    if ((etapa === 'Compareceu' || etapa === 'Pós-consulta') && !sim(a.fechou_tratamento)) separou.naoFecharam.push({ id, nome, detalhe: etapa });
    const alta = data10(a.data_alta);
    if (alta && somar(alta, 60) <= dia) separou.retorno60.push({ id, nome, detalhe: `alta em ${alta.split('-').reverse().join('/')}` });
    const retomar = data10(a.retomar_em);
    if (retomar && retomar <= dia) separou.verDepois.push({ id, nome, detalhe: `${str(a.motivo_espera) || 'ficou de ver'} · retomar em ${retomar.split('-').reverse().join('/')}` });
    if (situ === 'Não compareceu' && consulta && consulta >= somar(dia, -7) && consulta <= dia) separou.faltaram.push({ id, nome, detalhe: `faltou em ${consulta.split('-').reverse().join('/')}` });

    const u = porUsuario.get(responsavel) ?? { nome: responsavel, conversas: 0, esperando: 0, responderamHoje: 0, agendaram: 0 };
    if (c?.status !== 'resolved') u.conversas++;
    if (esperando) u.esperando++;
    if (ultimaNossa && ultimaEm && diaEmBelem(ultimaEm) === dia) u.responderamHoje++;
    if (agendadasHoje.has(id)) u.agendaram++;
    porUsuario.set(responsavel, u);
  }
  // quentes primeiro, depois quem espera há mais tempo
  facaAgora.sort((x, y) => Number(y.quente) - Number(x.quente) || y.esperandoMin - x.esperandoMin);
  let meta: number | null = null;
  for (const cx of caixas) if (META_AGENDAMENTOS_POR_CAIXA[cx]) meta = (meta ?? 0) + META_AGENDAMENTOS_POR_CAIXA[cx]!;
  return {
    dia,
    numeros: n,
    meta,
    separou,
    facaAgora: facaAgora.slice(0, MAX_FACA_AGORA),
    porUsuario: [...porUsuario.values()].sort((x, y) => y.conversas - x.conversas),
  };
}

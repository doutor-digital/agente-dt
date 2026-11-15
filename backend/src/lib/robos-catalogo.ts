/**
 * O catálogo dos robôs da régua do Chatwoot para a tela «Robôs».
 *
 * O QUE VEM DO CÓDIGO (nunca à mão): quais regras existem, que modelo(s) cada uma manda e se ela respeita o `sem-follow-up`. Isso é
 * DESCOBERTO rodando `candidatos()` (a função real da régua) sobre conversas de exemplo que acendem cada regra; o texto de cada modelo
 * vem de `TEXTOS_PARAU` preenchido por `renderizar()` com um paciente de exemplo; as internas vêm de `DESCRICAO_INTERNA`.
 *
 * O QUE É TEXTO NOSSO: o nome em português simples, o «quando manda» e em que grupo/etapa a regra aparece (`META`). Está aqui, ao lado,
 * e os testes quebram nos dois sentidos: regra nova no código sem entrada aqui (também achada varrendo o fonte da régua) ou entrada
 * aqui que o código não monta mais.
 */
import {
  candidatos,
  DESCRICAO_INTERNA,
  renderizar,
  type ConversaRegua,
  type DadosDaUnidade,
  type Vistos,
  type Visto,
} from './chatwoot-regua.js';
import { TEXTOS_PARAU } from './chatwoot-regua-textos.js';

export type GrupoDoRobo = 'comercial' | 'tratamento' | 'sdr';

export const ROTULO_DO_GRUPO: Readonly<Record<GrupoDoRobo, string>> = {
  comercial: 'Comercial',
  tratamento: 'Tratamento',
  sdr: 'SDR (por etiqueta)',
};

interface Meta {
  grupo: GrupoDoRobo;
  /** em que etapa/momento do funil o robô aparece */
  etapa: string;
  nome: string;
  /** SEM número de tempo (o tempo, que a Gestora pode mudar, aparece à parte): só o gatilho e a condição */
  quando: string;
  /** robô sem tempo para mudar: quando ele age, em poucas palavras */
  marca?: string;
}

/** Na ordem em que aparecem na tela. */
const META: Readonly<Record<string, Meta>> = {
  // Comercial
  prepagamento: { grupo: 'comercial', etapa: 'Agendado', nome: 'Pré-pagamento da consulta', quando: 'Quando a conversa entra em Agendado com pagamento antecipado ainda não pago', marca: 'ao virar Agendado' },
  'prepagamento-pendente': { grupo: 'comercial', etapa: 'Agendado', nome: 'Pré-pagamento ainda pendente', quando: 'Se o pagamento antecipado não foi identificado' },
  'consulta-vespera': { grupo: 'comercial', etapa: 'Agendado', nome: 'Lembrete da véspera (consulta ou sessão)', quando: 'Consulta ou sessão com hora marcada. Sem hora, sai às 09:00 do dia anterior. É um robô só para consulta e sessão' },
  'consulta-dia': { grupo: 'comercial', etapa: 'Agendado', nome: 'Confirmação do dia da consulta', quando: 'Lembrete no dia da consulta, com hora marcada' },
  'consulta-preparo': { grupo: 'comercial', etapa: 'Agendado', nome: 'Preparo da consulta (o que levar)', quando: 'Lembrete de preparo, com hora marcada' },
  'falta-mesmo-dia': { grupo: 'comercial', etapa: 'Não compareceu', nome: 'Falta no mesmo dia', quando: 'Quando marcam «Não compareceu», se foi no dia da consulta', marca: 'na hora da falta' },
  'falta-48h': { grupo: 'comercial', etapa: 'Não compareceu', nome: 'Remarcação depois da falta', quando: 'Para quem faltou à consulta' },
  'pos-atendimento': { grupo: 'comercial', etapa: 'Compareceu / Pós-consulta', nome: 'Pós-atendimento', quando: 'Para quem está em Compareceu' },
  'decisao-4d': { grupo: 'comercial', etapa: 'Compareceu / Pós-consulta', nome: 'Retomada da decisão', quando: 'Em Compareceu ou Pós-consulta' },
  'decisao-7d': { grupo: 'comercial', etapa: 'Compareceu / Pós-consulta', nome: 'Encerramento da decisão', quando: 'Em Compareceu ou Pós-consulta' },
  'decisao-30d': { grupo: 'comercial', etapa: 'Compareceu / Pós-consulta', nome: 'Reengajamento', quando: 'Em Pós-consulta ou Perdido' },
  'followup-48h': { grupo: 'comercial', etapa: 'Perdido', nome: 'Follow-up 1 (reengajamento)', quando: 'Depois de a conversa virar Perdido' },
  'followup-96h': { grupo: 'comercial', etapa: 'Perdido', nome: 'Follow-up 2 (convite ao método)', quando: 'Depois de a conversa virar Perdido' },
  'followup-120h': { grupo: 'comercial', etapa: 'Perdido', nome: 'Follow-up 3 (encerramento)', quando: 'Depois de a conversa virar Perdido' },
  'espera-retomar': { grupo: 'comercial', etapa: 'Em espera', nome: 'Retomada da espera', quando: 'No dia de «Retomar em», com o texto do motivo (exames, viagem, decisão ou financeiro)', marca: 'dia de «Retomar em», 09:00' },
  'espera-retomada2': { grupo: 'comercial', etapa: 'Em espera', nome: '2ª retomada da espera', quando: 'Se o paciente não respondeu à primeira retomada' },
  'lead-quente-parado': { grupo: 'comercial', etapa: 'Internas (não falam com o paciente)', nome: 'Lead quente parado', quando: 'Lead Quente sem andamento: passa para a gerente e avisa no WhatsApp dela' },
  'sem-resposta-24h': { grupo: 'comercial', etapa: 'Internas (não falam com o paciente)', nome: 'Sem resposta', quando: 'A nossa última mensagem ficou sem resposta: nota para a equipe' },
  'pendencia-fechou': { grupo: 'comercial', etapa: 'Internas (não falam com o paciente)', nome: 'Fechou sem «Fechou tratamento»', quando: 'Ao entrar em Fechou sem marcar «Fechou tratamento»: nota para a equipe', marca: 'ao virar Fechou' },
  // Tratamento
  'sessao-dia': { grupo: 'tratamento', etapa: 'Sessões', nome: 'Confirmação do dia da sessão', quando: 'Lembrete no dia da sessão, com hora marcada' },
  'sessao-falta': { grupo: 'tratamento', etapa: 'Sessões', nome: 'Falta na sessão', quando: 'Quando marcam a falta, no dia da sessão', marca: 'na hora da falta' },
  'sessao-aderencia-meio': { grupo: 'tratamento', etapa: 'Sessões', nome: 'Meio do tratamento', quando: 'Quando chega a etiqueta aderencia-meio (metade das sessões)', marca: 'ao entrar a etiqueta' },
  'pendencia-documento': { grupo: 'tratamento', etapa: 'Sessões', nome: 'Cobrança do exame', quando: 'Quando pediram exame e o paciente já foi avisado' },
  'alta-conclusao': { grupo: 'tratamento', etapa: 'Alta', nome: 'Parabéns pela alta', quando: 'Quando o tratamento entra em Alta', marca: 'na hora da alta' },
  'alta-nps': { grupo: 'tratamento', etapa: 'Alta', nome: 'Pesquisa de satisfação (NPS)', quando: 'Se o paciente ainda não avaliou no Google' },
  'alta-retorno-60d': { grupo: 'tratamento', etapa: 'Alta', nome: 'Retorno depois da alta', quando: 'Para quem tem retorno pós-tratamento' },
  'cancelamento-acolhimento': { grupo: 'tratamento', etapa: 'Tratamento cancelado', nome: 'Acolhimento do cancelamento', quando: 'Quando o tratamento é marcado como cancelado', marca: 'na hora do cancelamento' },
  'cancelamento-retorno': { grupo: 'tratamento', etapa: 'Tratamento cancelado', nome: 'Retorno marcado depois de cancelar', quando: 'Na véspera (09:00) do retorno marcado', marca: 'véspera do retorno, 09:00' },
  // SDR por etiqueta
  'sdr-confirmar-retorno': { grupo: 'sdr', etapa: 'Etiqueta confirmar-retorno', nome: 'Confirmar retorno', quando: 'Quando a etiqueta «confirmar-retorno» chega, para retorno pós-tratamento ou funil Tratamento', marca: 'ao entrar a etiqueta' },
  'sdr-retomada': { grupo: 'sdr', etapa: 'Etiqueta retomada', nome: 'Retomada depois da ligação', quando: 'Quando a etiqueta «retomada» chega, em Novo lead, qualificação ou Agendado', marca: 'ao entrar a etiqueta' },
  'sdr-reativacao': { grupo: 'sdr', etapa: 'Etiqueta reativacao', nome: 'Reativação de lead frio', quando: 'Quando a etiqueta «reativacao» chega, em qualificação, Perdido ou Não compareceu', marca: 'ao entrar a etiqueta' },
  'sdr-boas-vindas': { grupo: 'sdr', etapa: 'Etiqueta boas-vindas', nome: 'Boas-vindas ao programa', quando: 'Quando a etiqueta «boas-vindas» chega, em Compareceu, Pós-consulta, Fechou ou Tratamento', marca: 'ao entrar a etiqueta' },
};

/**
 * O que cada robô exige além do gatilho, em palavras (SÓ para mostrar no bloco «Só se»; a regra de verdade é o código de `candidatos()`).
 * «Não pediu para parar» NÃO está aqui: é descoberto do código (`respeitaSemFollowUp`) e entra sozinho.
 */
const CONDICOES: Readonly<Record<string, readonly string[]>> = {
  prepagamento: ['Consulta com pagamento antecipado', 'Ainda não pagou'],
  'prepagamento-pendente': ['Ainda não pagou'],
  'consulta-vespera': ['Consulta ou sessão de pé'],
  'consulta-dia': ['Consulta de pé'],
  'consulta-preparo': ['Consulta de pé'],
  'falta-mesmo-dia': ['Falta marcada no dia da consulta'],
  'falta-48h': ['Consulta marcada como «Não compareceu»'],
  'pos-atendimento': ['Etapa Compareceu'],
  'decisao-4d': ['Etapa Compareceu ou Pós-consulta'],
  'decisao-7d': ['Etapa Compareceu ou Pós-consulta'],
  'decisao-30d': ['Etapa Pós-consulta ou Perdido'],
  'espera-retomar': ['Motivo da espera preenchido'],
  'espera-retomada2': ['Paciente não respondeu depois da 1ª retomada'],
  'lead-quente-parado': ['Qualificação Quente'],
  'sem-resposta-24h': ['Última mensagem foi nossa'],
  'pendencia-fechou': ['«Fechou tratamento» sem marcar'],
  'sessao-dia': ['Sessão de pé'],
  'sessao-falta': ['Falta marcada no dia da sessão'],
  'pendencia-documento': ['Exame pedido e paciente já avisado'],
  'alta-nps': ['Sem avaliação no Google'],
  'alta-retorno-60d': ['Retorno pós-tratamento'],
  'cancelamento-retorno': ['Retorno marcado'],
  'sdr-confirmar-retorno': ['Retorno pós-tratamento ou funil Tratamento'],
  'sdr-retomada': ['Novo lead, qualificação ou Agendado'],
  'sdr-reativacao': ['Qualificação, Perdido ou Não compareceu'],
  'sdr-boas-vindas': ['Compareceu, Pós-consulta, Fechou ou Tratamento'],
};

export interface ModeloDoRobo {
  modelo: string;
  /** o texto com um paciente de exemplo no lugar dos {{…}}; null = a régua não consegue montar este exemplo */
  texto: string | null;
}

export interface Robo {
  regra: string;
  grupo: GrupoDoRobo;
  grupoRotulo: string;
  etapa: string;
  nome: string;
  quando: string;
  /** robô sem tempo para mudar: quando age, em poucas palavras ('' nos que têm tempo) */
  marca: string;
  /** os modelos que esta regra pode mandar (descobertos do código); interna = nenhum */
  modelos: ModeloDoRobo[];
  /** descoberto do código: com a etiqueta `sem-follow-up` a regra deixa de ser montada */
  respeitaSemFollowUp: boolean;
  /** o que o bloco «Só se» mostra (somente leitura na Fase A) */
  condicoes: string[];
  /** regra interna: nota/ação para a equipe, nunca mensagem ao paciente */
  interna: boolean;
  /** só no catálogo manual ou só no código (os testes não deixam acontecer) */
  semMeta?: boolean;
}

// ── a descoberta ──────────────────────────────────────────────────────────────────────────────────

const T = (iso: string) => new Date(iso);
const AGORA = T('2026-11-16T12:00:00Z');
const visto = (valor = 'sim'): Visto => ({ valor, desde: AGORA, inicial: false });

function conversa(attrs: Record<string, unknown>, etiquetas: string[] = [], ultima: ConversaRegua['ultima'] = null): ConversaRegua {
  return { id: 1, nome: 'Maria da Silva', etiquetas, attrs, criadaEm: T('2026-10-01T12:00:00Z'), atendente: 'Ana', ultima, telefone: '+5594999990000' };
}
const vistos = (o: Record<string, string>): Vistos => new Map(Object.entries(o).map(([k, v]) => [k, visto(v)]));
const CONSULTA = { data_consulta: '2026-11-18', hora_consulta: '14:30' };

/**
 * Conversas de exemplo que acendem cada regra de `candidatos()`. Quem mexer na régua e criar regra que nenhuma delas acende
 * ainda aparece no teste que varre o fonte; aqui só se acrescenta uma conversa nova.
 */
function exemplos(): Array<{ c: ConversaRegua; v: Vistos }> {
  const saiu = { saida: true, privada: false, autorId: 4, autorTipo: 'user', criadaEm: T('2026-11-15T12:00:00Z') };
  const lista: Array<{ c: ConversaRegua; v: Vistos }> = [
    // Perdido
    { c: conversa({ etapa: 'Perdido' }), v: vistos({ etapa: 'Perdido' }) },
    // Agendado: pré-pagamento + lembretes de consulta
    { c: conversa({ etapa: 'Agendado', situacao_consulta: 'Agendado', pagamento_antecipado: 'sim', ...CONSULTA }), v: vistos({ etapa: 'Agendado' }) },
    // Fechou: véspera com o texto de sessão + pendência
    { c: conversa({ etapa: 'Fechou', situacao_consulta: 'Agendado', ...CONSULTA }), v: vistos({ etapa: 'Fechou' }) },
    // Não compareceu no dia
    { c: conversa({ etapa: 'Agendado', situacao_consulta: 'Não compareceu', data_consulta: '2026-11-16', hora_consulta: '09:00' }), v: vistos({ situacao_consulta: 'Não compareceu' }) },
    // Atendido: pós-atendimento, 4d, 7d / 30d
    { c: conversa({ etapa: 'Compareceu', situacao_consulta: 'Atendido', data_consulta: '2026-11-10', hora_consulta: '10:00' }), v: new Map() },
    { c: conversa({ etapa: 'Pós-consulta', situacao_consulta: 'Atendido', data_consulta: '2026-11-10', hora_consulta: '10:00' }), v: new Map() },
    // internas da qualificação
    { c: conversa({ etapa: 'Sofia qualifica', qualificacao: 'Quente' }, [], saiu), v: new Map() },
    // SDR por etiqueta
    { c: conversa({ categoria_consulta: 'Retorno após tratamento', data_alta: '2026-10-01' }, ['confirmar-retorno']), v: vistos({ 'etiqueta:confirmar-retorno': 'sim' }) },
    { c: conversa({ etapa: 'Novo lead' }, ['retomada']), v: vistos({ 'etiqueta:retomada': 'sim' }) },
    { c: conversa({ etapa: 'Perdido' }, ['reativacao']), v: vistos({ 'etiqueta:reativacao': 'sim' }) },
    { c: conversa({ etapa: 'Compareceu' }, ['boas-vindas']), v: vistos({ 'etiqueta:boas-vindas': 'sim' }) },
    // tratamento
    { c: conversa({ funil: 'Tratamento', etapa_tratamento: 'Alta' }), v: vistos({ etapa_tratamento: 'Alta' }) },
    { c: conversa({ funil: 'Tratamento', etapa_tratamento: 'Tratamento cancelado', data_retorno: '2026-11-25' }), v: vistos({ etapa_tratamento: 'Tratamento cancelado' }) },
    {
      c: conversa(
        { funil: 'Tratamento', etapa_tratamento: 'Em tratamento', proxima_sessao: '2026-11-18', hora_sessao: '10:00', compareceu_ultima_sessao: 'Não', motivo_nao_fechamento: 'Solicitado exames', data_consulta: '2026-11-10', hora_consulta: '10:00' },
        ['aderencia-meio', 'pendencia-exame-avisado'],
      ),
      v: vistos({ 'etiqueta:aderencia-meio': 'sim', compareceu_ultima_sessao: 'Não' }),
    },
    // sessão vinda da agenda
    { c: conversa({ categoria_consulta: 'Sessão', situacao_consulta: 'Agendado', ...CONSULTA }), v: new Map() },
    { c: conversa({ categoria_consulta: 'Sessão', situacao_consulta: 'Não compareceu', data_consulta: '2026-11-16', hora_consulta: '09:00' }), v: vistos({ situacao_consulta: 'Não compareceu' }) },
  ];
  // em espera: um por motivo
  for (const motivo of ['Exames', 'Viajando', 'Vai decidir', 'Financeiro agora não']) {
    lista.push({ c: conversa({ etapa: 'Sofia qualifica', retomar_em: '2026-11-18', motivo_espera: motivo }), v: new Map() });
  }
  return lista;
}

interface Achado {
  modelos: Set<string>;
  respeitaSemFollowUp: boolean;
  interna: boolean;
}

/** regra → o que o código monta (modelos, interna, respeita sem-follow-up). Roda `candidatos()` de verdade. */
export function descobrir(): Map<string, Achado> {
  const achados = new Map<string, Achado>();
  for (const { c, v } of exemplos()) {
    const com = candidatos(c, v);
    const sem = new Set(candidatos({ ...c, etiquetas: [...c.etiquetas, 'sem-follow-up'] }, v).map((k) => k.regra));
    for (const k of com) {
      const a = achados.get(k.regra) ?? { modelos: new Set<string>(), respeitaSemFollowUp: false, interna: false };
      a.modelos.add(k.modelo);
      if (k.interna) a.interna = true;
      // respeita o `sem-follow-up` se, numa conversa em que a regra é montada, a etiqueta a faz sumir
      if (!sem.has(k.regra)) a.respeitaSemFollowUp = true;
      achados.set(k.regra, a);
    }
  }
  return achados;
}

// ── o exemplo de texto ────────────────────────────────────────────────────────────────────────────

const UNIDADE_EXEMPLO: DadosDaUnidade = { nome: 'Doutor Hérnia Parauapebas', pixKey: 'pix@exemplo.com', valorAntecipado: 250 };
const PACIENTE_EXEMPLO = conversa(
  { data_consulta: '2026-11-18', hora_consulta: '14:30', proxima_sessao: '2026-11-18', hora_sessao: '14:30', data_retorno: '2026-11-25', programa: 'Coluna Forte' },
  [],
  null,
);

export function textoDeExemplo(modelo: string): string | null {
  if (modelo.startsWith('interna:')) return null;
  if (!(modelo in TEXTOS_PARAU)) return null;
  return renderizar(modelo, PACIENTE_EXEMPLO, UNIDADE_EXEMPLO).texto;
}

// ── o catálogo ────────────────────────────────────────────────────────────────────────────────────

let memo: Robo[] | null = null;

export function catalogo(): Robo[] {
  if (memo) return memo;
  const achados = descobrir();
  const regras = [...new Set([...Object.keys(META), ...achados.keys()])];
  const ordem = Object.keys(META);
  regras.sort((a, b) => {
    const ia = ordem.indexOf(a);
    const ib = ordem.indexOf(b);
    return (ia < 0 ? 999 : ia) - (ib < 0 ? 999 : ib);
  });
  memo = regras.map((regra): Robo => {
    const m = META[regra];
    const a = achados.get(regra);
    const interna = a?.interna ?? false;
    const modelos = [...(a?.modelos ?? [])].sort().map((modelo) => ({
      modelo,
      texto: interna ? (DESCRICAO_INTERNA[modelo.replace('interna:', '') as keyof typeof DESCRICAO_INTERNA] ?? null) : textoDeExemplo(modelo),
    }));
    return {
      regra,
      grupo: m?.grupo ?? 'comercial',
      grupoRotulo: ROTULO_DO_GRUPO[m?.grupo ?? 'comercial'],
      etapa: m?.etapa ?? 'Outros',
      nome: m?.nome ?? regra,
      quando: m?.quando ?? 'Sem descrição ainda',
      marca: m?.marca ?? '',
      modelos,
      respeitaSemFollowUp: a?.respeitaSemFollowUp ?? false,
      condicoes: [...(CONDICOES[regra] ?? []), ...(a?.respeitaSemFollowUp ? ['Não pediu para parar'] : [])],
      interna,
      ...(m && a ? {} : { semMeta: true }),
    };
  });
  return memo;
}

export function regraDoCatalogo(regra: string): Robo | undefined {
  return catalogo().find((r) => r.regra === regra);
}

/** Só para os testes. */
export const REGRAS_COM_DESCRICAO: readonly string[] = Object.keys(META);

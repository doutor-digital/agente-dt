/**
 * Rotina diária, régua 3 — ANIVERSÁRIO (chave `ROTINA_ANIVERSARIO_SLUGS`, automação `rotina-aniversario`).
 *
 * No dia do aniversário (fuso da unidade, entre 9h e 12h) o paciente e o ex-paciente recebem a ▶ Aniversário (parabéns e um convite);
 * quem está em TRATAMENTO ATIVO recebe a ▶ Aniversário tratamento (só parabéns, sem convite). TRATAMENTO/ALTA não é trava aqui.
 *
 * A DATA É DA FRANQUIA. Só manda com `⚙ idClient` no cartão E a ficha da franquia (`GET /clients/{id}`) com `birthdate` que bate com
 * hoje: sem idClient, sem franquia na unidade, ficha que não responde, ficha sem data ou com OUTRA data = não manda. O campo
 * ◷ Data de nascimento do cartão só serve de peneira (para não ler a ficha de todo mundo); ele não decide sozinho. Nunca por busca de
 * nome ou telefone (o telefone do cartão pode ser de um familiar).
 *
 * «Paciente falecido na franquia»: a trava lê o `status` da ficha por /óbito|falec/, MAS ISSO NÃO TEM PROVA — nas 80 fichas reais lidas
 * em 06/11/2026 (Timbó e Açailândia, todas de cartões com idClient) o `status` era sempre «ATIVO». É defesa para "se aparecer", não
 * garantia. O que protege de verdade quem faleceu é a SDR marcar NO_FOLLOW_UP/NAO_PERTURBAR (que travam aqui).
 *
 * Uma por ano por PESSOA (a marca é do contato: dois cartões da mesma pessoa não recebem dois), nunca no mesmo dia de outro toque
 * (da rotina ou do `etiquetas-auto`; as réguas por etapa cedem o cartão de quem faz anos quando esta está LIGADA). Fim de semana ou
 * feriado: cumprimenta no 1º dia útil (até 3 dias de atraso: sábado + segunda feriado = terça). NO DIA EM QUE A RÉGUA É LIGADA, quem fez anos nos 3 dias anteriores também recebe (uma vez): é o mesmo atraso, e a marca de «1 por ano» impede o repique. Nunca para NO_FOLLOW_UP, NAO_PERTURBAR, opt-out, CURRÍCULO nem motivo
 * de perda encerrado. Pausar IA, ◷ Retomar em e consulta futura NÃO impedem um parabéns. Sem a etiqueta ▶ Aniversário tratamento na
 * conta, quem está em tratamento não recebe nada (o convite não vale para quem já se trata).
 */
import type { KommoLead } from '../services/kommo.service.js';
import { fichaDoPaciente } from '../services/spine.service.js';
import { logger } from './logger.js';
import { prisma } from './prisma.js';
import { acharNaConta } from './ponte-etiquetas.js';
import { ETAPA, TRATAMENTO_EM_ANDAMENTO } from './franquia-move.js';
import { pularCartao } from './crm-compartilhado.js';
import { idClientDoCartao } from './franquia-sync-worker.js';
import { diaDoCampoData, hojeNaUnidade } from './espera-retomada.js';
import {
  ATRASO_MAX_ANIVERSARIO_DIAS,
  DIA_S,
  HORA_S,
  ID_ROTINA_ANIVERSARIO,
  anoDoAniversario,
  aniversarioHoje,
  aniversarioNoDia,
  conta,
  criarWorker,
  diaDeNascimentoDaFicha,
  estadoDoAniversario,
  idDaMarca,
  jaRecebeuHoje,
  jaVisto,
  marcarVisto,
  nascimentoDoCartao,
  pessoaDoCartao,
  porQueNaoTocar,
  resumoNovo,
  tocar,
  type Ctx,
  type OpcoesDeCartao,
  type Regua,
  type ResumoDaRegua,
  cabeMais,
} from './rotina-nucleo.js';

export { ID_ROTINA_ANIVERSARIO, estadoDoAniversario };

export const CHAVE_ANIVERSARIO = 'aniv';
export const ETIQUETA_ANIVERSARIO = '▶ Aniversário';
export const ETIQUETA_ANIVERSARIO_TRATAMENTO = '▶ Aniversário tratamento';
/** O aniversário sai de manhã (hora local da unidade): de HORA_ANIVERSARIO_DE até HORA_ANIVERSARIO_ATE. */
export const HORA_ANIVERSARIO_DE = 9;
export const HORA_ANIVERSARIO_ATE = 12;
const MAX_PAGINAS_ANIVERSARIO = 12;

export function horaLocal(agora: number, tz: string): number {
  return Number(new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', hour12: false }).format(new Date(agora * 1000))) % 24;
}

export function naJanelaDoAniversario(agora: number, tz: string): boolean {
  const h = horaLocal(agora, tz);
  return h >= HORA_ANIVERSARIO_DE && h < HORA_ANIVERSARIO_ATE;
}

/** Texto da ficha que a franquia chama de óbito: nunca recebe parabéns. SEM PROVA em ficha real (só «ATIVO» foi visto): "se aparecer". */
export function statusDeFalecido(status: string | null | undefined): boolean {
  return /[oó]bito|falec|faleceu/i.test(String(status ?? ''));
}

/** `unidade:dia` → cartões com idClient que fazem aniversário naquele dia (varrer o funil inteiro uma vez por dia basta). */
const aniversariantes = new Map<string, KommoLead[]>();
export function _limparAniversariantes(): void {
  aniversariantes.clear();
}

async function cartoesDoUniverso(ctx: Ctx): Promise<KommoLead[]> {
  const alvos: Array<{ pipelineId: number; statusId: number }> = [];
  for (const e of [ETAPA.AGENDADO, ETAPA.NAO_COMPARECEU, ETAPA.COMPARECEU, ETAPA.NEGOCIACAO, ETAPA.RETORNO]) {
    const a = ctx.funis.idDe('COMERCIAL', e);
    if (a) alvos.push(a);
  }
  alvos.push({ pipelineId: ctx.funis.comercialId, statusId: 142 }, { pipelineId: ctx.funis.comercialId, statusId: 143 });
  for (const e of [ETAPA.EM_TRATAMENTO, ETAPA.ALTA, ETAPA.CANCELADO]) {
    const a = ctx.funis.idDe('TRATAMENTO', e);
    if (a) alvos.push(a);
  }
  if (ctx.funis.tratamentoId !== null) alvos.push({ pipelineId: ctx.funis.tratamentoId, statusId: 142 }, { pipelineId: ctx.funis.tratamentoId, statusId: 143 });
  const vistos = new Map<number, KommoLead>();
  for (const alvo of alvos) {
    for (let page = 1; page <= MAX_PAGINAS_ANIVERSARIO; page++) {
      const pag = await ctx.kommo.listLeadsPorEtapa(alvo.pipelineId, alvo.statusId, 250, page, true, 'desc');
      for (const l of pag) vistos.set(l.id, l);
      if (pag.length < 250) break;
      if (page === MAX_PAGINAS_ANIVERSARIO) logger.warn({ ...alvo }, 'rotina: etapa com mais cartões que o teto de leitura — aniversariantes dos mais antigos podem ficar de fora');
    }
  }
  return [...vistos.values()];
}

export async function varrerAniversario(ctx: Ctx, seco: boolean, resumo: Record<string, ResumoDaRegua>): Promise<void> {
  const r = (resumo[CHAVE_ANIVERSARIO] = resumoNovo());
  const { unit, agora, tz, kommo } = ctx;
  if (!naJanelaDoAniversario(agora, tz)) {
    r.seguradas['fora-da-janela-da-manha'] = 1;
    return;
  }
  if (!unit.spineEnabled || !unit.spineToken) {
    // sem a franquia não há data confiável: o aniversário não sai
    r.seguradas['unidade-sem-franquia'] = 1;
    return;
  }
  if (!acharNaConta(ETIQUETA_ANIVERSARIO, [...ctx.tagsDaConta])) {
    logger.warn({ unit: unit.slug, etiqueta: ETIQUETA_ANIVERSARIO }, 'rotina: a conta não tem a etiqueta de aniversário — nada a fazer');
    r.seguradas['sem-etiqueta-na-conta'] = 1;
    return;
  }
  const dia = hojeNaUnidade(agora, tz);
  const chave = `${unit.id}:${dia}`;
  let doDia = aniversariantes.get(chave);
  if (!doDia) {
    for (const k of aniversariantes.keys()) if (!k.endsWith(`:${dia}`)) aniversariantes.delete(k);
    const todos = await cartoesDoUniverso(ctx);
    r.lidos = todos.length;
    // peneira do cartão: tem ⚙ idClient e a data de nascimento do cartão cai na janela. Quem decide é a ficha da franquia.
    doDia = todos.filter((l) => idClientDoCartao(l, []) !== null && aniversarioHoje(nascimentoDoCartao(l), agora, tz, ATRASO_MAX_ANIVERSARIO_DIAS));
    aniversariantes.set(chave, doDia);
  }
  const opcoes: OpcoesDeCartao = { agora, tz, pausarIaFieldId: null, conferirMotivoMorto: true, soNaoContatar: true };

  /** o ano do aniversário que vale agora (pode ser o anterior, se a unidade só abriu depois da virada do ano) */
  const anoDoCartao = (l: KommoLead): number => {
    const n = nascimentoDoCartao(l);
    return (n === null ? null : anoDoAniversario(diaDoCampoData(n), agora, tz, ATRASO_MAX_ANIVERSARIO_DIAS)) ?? Number(dia.slice(0, 4));
  };

  let fila = doDia.filter((l) => {
    if (pularCartao(ctx.grupo, unit.id, l, {})) return false; // Kommo dividido: só os desta unidade
    const razao = porQueNaoTocar(l, opcoes);
    if (razao) {
      conta(r.barrados, razao.codigo);
      return false;
    }
    return true;
  });
  const jaDoAno = new Set(
    (await prisma.executionTrace.findMany({ where: { id: { in: fila.map((l) => idDaMarca(unit.id, pessoaDoCartao(l), CHAVE_ANIVERSARIO, 1, anoDoCartao(l))) } }, select: { id: true } })).map((x) => x.id),
  );
  const filtrada: KommoLead[] = [];
  for (const l of fila) {
    if (jaDoAno.has(idDaMarca(unit.id, pessoaDoCartao(l), CHAVE_ANIVERSARIO, 1, anoDoCartao(l)))) {
      conta(r.barrados, 'ja-recebeu-este-ano');
    } else if (await jaRecebeuHoje(ctx, pessoaDoCartao(l))) {
      conta(r.barrados, 'ja-recebeu-toque-hoje');
    } else filtrada.push(l);
  }
  fila = filtrada;

  const tratamentoEm = ctx.funis.tratamentoId !== null ? ctx.funis.idDe('TRATAMENTO', ETAPA.EM_TRATAMENTO) : null;
  const chaveDoCache = `${CHAVE_ANIVERSARIO}:${seco ? 'seco' : 'ligado'}`;
  for (const velho of fila) {
    if (!(await cabeMais(ctx, seco))) {
      r.paradoPeloTeto = true;
      break;
    }
    if (jaVisto(unit.id, chaveDoCache, velho.id, agora)) continue;
    r.avaliados++;
    try {
      // a lista do dia vem da primeira leitura (pode ter 3 h): a etapa que decide «só parabéns × com convite» é a de AGORA
      const lead = await kommo.getLead(velho.id);
      lead.name ??= velho.name;
      if (porQueNaoTocar(lead, { ...opcoes, agora })) {
        marcarVisto(unit.id, chaveDoCache, velho.id, agora + 6 * HORA_S);
        continue;
      }
      const idClient = idClientDoCartao(lead, []);
      if (idClient === null) {
        conta(r.barrados, 'sem-idclient');
        marcarVisto(unit.id, chaveDoCache, velho.id, agora + DIA_S);
        continue;
      }
      // a franquia é o cadastro: a data VEM da ficha (e só vale se for hoje), e ela diz se o paciente está em tratamento
      const res = await (ctx.ficha ?? fichaDoPaciente)(unit as never, idClient);
      if (!res.ok || !res.data) throw new Error(`franquia não respondeu (paciente ${idClient}): ${res.error ?? 'erro'}`);
      const ficha = res.data.ficha;
      if (statusDeFalecido(ficha.status)) {
        conta(r.barrados, 'falecido-na-franquia');
        marcarVisto(unit.id, chaveDoCache, velho.id, agora + DIA_S);
        continue;
      }
      const nasc = diaDeNascimentoDaFicha(ficha.birthdate);
      if (nasc === null) {
        conta(r.seguradas, 'ficha-sem-data-de-nascimento');
        marcarVisto(unit.id, chaveDoCache, velho.id, agora + DIA_S);
        continue;
      }
      if (!aniversarioNoDia(nasc, agora, tz, ATRASO_MAX_ANIVERSARIO_DIAS)) {
        conta(r.seguradas, 'franquia-diz-outra-data');
        marcarVisto(unit.id, chaveDoCache, velho.id, agora + DIA_S);
        continue;
      }
      const anoFicha = anoDoAniversario(nasc, agora, tz, ATRASO_MAX_ANIVERSARIO_DIAS) as number;
      const emTratamento =
        (tratamentoEm !== null && lead.pipeline_id === tratamentoEm.pipelineId && lead.status_id === tratamentoEm.statusId) ||
        ficha.treatments.some((t) => (t as { idStatus?: number }).idStatus === TRATAMENTO_EM_ANDAMENTO);
      const etiqueta = emTratamento ? ETIQUETA_ANIVERSARIO_TRATAMENTO : ETIQUETA_ANIVERSARIO;
      const aindaVale = (fresco: KommoLead): string | null => {
        const razao = porQueNaoTocar(fresco, { ...opcoes, agora: Math.floor(Date.now() / 1000) });
        return razao ? razao.texto : null;
      };
      const etapa = ctx.funis.nomeDe(lead.pipeline_id, lead.status_id)?.status ?? '';
      const motivo = emTratamento ? 'aniversário (em tratamento: só parabéns, sem convite)' : 'aniversário do paciente (data da ficha da franquia)';
      const resTocar = await tocar(ctx, seco, { lead, automacao: ID_ROTINA_ANIVERSARIO, chave: CHAVE_ANIVERSARIO, toque: 1, etiqueta, tp: anoFicha, etapa, motivo, aindaVale }, r);
      if (resTocar === 'teto') {
        r.paradoPeloTeto = true;
        break;
      }
      marcarVisto(unit.id, chaveDoCache, velho.id, agora + 3 * HORA_S);
    } catch (err) {
      r.erros++;
      marcarVisto(unit.id, chaveDoCache, velho.id, agora + 3 * HORA_S);
      logger.warn({ err: String(err), unit: unit.slug, leadId: velho.id }, 'rotina: erro no aniversário de um cartão — pulei');
    }
  }
}

export const reguaDoAniversario: Regua = { id: ID_ROTINA_ANIVERSARIO, estado: (slug) => estadoDoAniversario(slug), primeiraEmMin: 8, rodar: varrerAniversario };

const worker = criarWorker(reguaDoAniversario);
export const startRotinaAniversarioWorker = worker.start;
export const stopRotinaAniversarioWorker = worker.stop;

/**
 * O motor das réguas de SILÊNCIO da rotina diária (esquecidos por etapa e ex-lead): "N dias sem o paciente responder → o degrau N".
 * Idêntico nos PRs das duas réguas; as regras do núcleo (marca por pessoa, teto, seco, etiqueta) estão em `rotina-nucleo.ts`.
 *
 * FONTE DO "PARADO" (a que o resto do código já usa): o evento `incoming_chat_message` do CONTATO PRINCIPAL no Kommo
 * (`ultimaMensagemDoContatoDesde`, a mesma do `parados` e da ligação pelo WhatsApp), 1 chamada por cartão. "Equipe conversando" e
 * "falaram com ele hoje" saem das conversas oficiais (`/talks`, a leitura da perda-ia e do botão «Sugerir motivo»), lidas só do
 * cartão que já passou por tudo o que é barato. O banco do agente entra como peneira de graça (mensagem nas últimas 24 h).
 *
 * ORDEM DAS CONFERÊNCIAS (do barato ao caro): o próprio cartão → banco (conversa recente, marcas da pessoa) → o evento de mensagem
 * do paciente (1 chamada) → o degrau da vez → conversa oficial → franquia → a trava extra da régua → releitura antes de escrever.
 *
 * O DESENHO é o da régua de PERDIDO que já existe no Kommo (`lead_reengajamento_48h` / `metodo_convite_96h` /
 * `encerramento_120h`): um robô e um modelo por degrau, NO_FOLLOW_UP corta tudo. A diferença é o gatilho: lá é "N horas depois de
 * entrar na etapa" (evento), aqui é "N dias sem o paciente escrever" (estado) — o Kommo não sabe contar isso.
 */
import type { KommoLead } from '../services/kommo.service.js';
import { logger } from './logger.js';
import { registrarSimulacao } from './so-no-papel.js';
import { pularCartao } from './crm-compartilhado.js';
import { lerFalasDoCartao } from './conversa-do-cartao.js';
import { franquiaDoPaciente } from './parados-worker.js';
import { leadPausadoPorJanela } from './pausa-lead.js';
import { idClientDoCartao } from './franquia-sync-worker.js';
import {
  ATRASO_MAX_ANIVERSARIO_DIAS,
  DIA_S,
  HORAS_DA_EQUIPE,
  HORAS_DE_QUALQUER_FALA,
  HORA_S,
  MAX_AVALIACOES,
  MAX_TOQUES,
  aniversarioHoje,
  cabeMais,
  cartaoMostraConsulta,
  contatoPrincipal,
  conta,
  franquiaTemHistorico,
  inteiro,
  jaRecebeuHoje,
  jaVisto,
  marcarVisto,
  marcasDaUnidade,
  marcasDoSilencio,
  nascimentoDoCartao,
  pessoaDoCartao,
  porQueNaoTocar,
  tocar,
  ultimasMensagensNoBanco,
  type Ctx,
  type MarcaLida,
  type OpcoesDeCartao,
  type RazaoDeFicar,
  type ResumoDaRegua,
} from './rotina-nucleo.js';

const MAX_PAGINAS = 6;
/** O atalho «já enviou o último degrau pronto» vale por este tempo; depois disso o cartão é reavaliado (o paciente pode ter voltado e calado de novo). */
const VALIDADE_DO_ATALHO_S = 30 * DIA_S;

// ─── prazos ───────────────────────────────────────────────────────────────────────────────────────

/**
 * Os dias de cada degrau de uma régua: o padrão, o ambiente da rede (`ROTINA_ROBOS_DIAS_…`, "2,4,7") e a unidade
 * (`<prefixo>_d1..d3` em `pipelineIntents`). Prazos que não crescem (4, 2, 7) ou fora de 1..365 = os padrões, e fica anotado.
 */
export function prazos(padrao: readonly number[], intents: Record<string, unknown>, prefixo: string, env: string | undefined, invalidas: string[]): number[] {
  const doEnv = String(env ?? '')
    .split(',')
    .map((s) => inteiro(s.trim()))
    .filter((n): n is number => n !== null);
  const base = doEnv.length ? doEnv.slice(0, MAX_TOQUES) : [...padrao];
  const lista = base.map((d, i) => inteiro(intents[`${prefixo}_d${i + 1}`]) ?? d);
  const ok = lista.every((d, i) => d <= 365 && (i === 0 || d > lista[i - 1]));
  if (!ok) {
    invalidas.push(`${prefixo}: ${lista.join(',')}`);
    return [...padrao];
  }
  return lista;
}

// ─── o degrau da vez (puro) ───────────────────────────────────────────────────────────────────────

export type DecisaoDoToque =
  | { tipo: 'toca'; toque: number; etiqueta: string; silencioDias: number; atrasado: boolean }
  /** o degrau existe e vence, mas a conta não tem o gatilho dele confirmado: no papel aparece, ligado não manda */
  | { tipo: 'sem-gatilho'; toque: number; etiqueta: string; silencioDias: number }
  | { tipo: 'espera'; porque: string; ate: number | null }
  | { tipo: 'esgotada' }
  | { tipo: 'fora'; porque: string };

export interface EntradaDoToque {
  agora: number;
  /** dias sem resposta de cada degrau */
  dias: readonly number[];
  etiquetas: readonly string[];
  /** quantos degraus têm etiqueta + robô + gatilho prontos na conta */
  prontos: number;
  /** a âncora do silêncio (epoch s): a última mensagem do paciente, ou a entrada na etapa/perda se for mais recente. null = não escreveu na janela olhada */
  ultimaDoPaciente: number | null;
  /** os degraus já enviados NESTE silêncio (depois da âncora) */
  marcas: ReadonlyArray<{ toque: number; em: number }>;
  /** o 1º degrau só vale se o silêncio for menor que isto (dias): estoque mais velho não entra */
  entradaAteDias: number;
}

/**
 * Qual degrau sai AGORA para este cartão — ou por que nenhum:
 *  - sem mensagem do paciente na janela: não é "esquecido", é lead que nunca respondeu (régua da Sofia e `parados`);
 *  - ordem 1→2→3, sem repetir e sem pular: o próximo é o maior degrau já enviado + 1;
 *  - o degrau N só sai com N dias de silêncio E com o espaço do desenho (dias[N] − dias[N−1]) depois do anterior — quem entra
 *    atrasado leva o 1º hoje e o 2º só no espaço certo, nunca dois no mesmo dia;
 *  - acabou a régua sem resposta: não manda mais nada (quem move é o `parados`).
 */
export function decidirToque(e: EntradaDoToque): DecisaoDoToque {
  if (e.ultimaDoPaciente === null) return { tipo: 'fora', porque: 'o paciente não escreveu na janela olhada: não é esquecido' };
  const silencio = e.agora - e.ultimaDoPaciente;
  const silencioDias = Math.floor(silencio / DIA_S);
  const ultimoEnviado = e.marcas.reduce((m, x) => Math.max(m, x.toque), 0);
  const proximo = ultimoEnviado + 1;
  if (proximo > e.dias.length) return { tipo: 'esgotada' };
  if (ultimoEnviado === 0 && silencio >= e.entradaAteDias * DIA_S) {
    return { tipo: 'fora', porque: `calado há ${silencioDias} dias, mais que a janela de entrada (${e.entradaAteDias}): estoque antigo` };
  }
  const prazo = e.dias[proximo - 1] * DIA_S;
  if (silencio < prazo) return { tipo: 'espera', porque: `${silencioDias} dia(s) de silêncio; o ${proximo}º toque é com ${e.dias[proximo - 1]}`, ate: e.ultimaDoPaciente + prazo };
  if (proximo > 1) {
    const anterior = e.marcas.filter((m) => m.toque === ultimoEnviado).reduce((m, x) => Math.max(m, x.em), 0);
    const espaco = (e.dias[proximo - 1] - e.dias[proximo - 2]) * DIA_S;
    if (e.agora - anterior < espaco) return { tipo: 'espera', porque: `o ${proximo}º toque espera ${e.dias[proximo - 1] - e.dias[proximo - 2]} dia(s) depois do anterior`, ate: anterior + espaco };
  }
  const etiqueta = e.etiquetas[proximo - 1];
  if (!etiqueta) return { tipo: 'esgotada' };
  if (proximo > e.prontos) return { tipo: 'sem-gatilho', toque: proximo, etiqueta, silencioDias };
  // já passou do prazo do degrau seguinte: pelo calendário estaria mais adiante, mas entra pelo próximo da fila (não pula)
  const seguinte = e.dias[proximo];
  return { tipo: 'toca', toque: proximo, etiqueta, silencioDias, atrasado: seguinte !== undefined && silencio >= seguinte * DIA_S };
}

// ─── o motor ──────────────────────────────────────────────────────────────────────────────────────

export interface ParamsDoSilencio {
  automacao: string;
  chave: string;
  etapa: string;
  dias: readonly number[];
  etiquetas: readonly string[];
  prontos: number;
  entradaAteDias: number;
  /** quantos dias para trás procurar a última mensagem do paciente */
  janelaOlhadaDias: number;
  opcoesDoCartao: Partial<OpcoesDeCartao>;
  /** só do ex-lead: quem já teve consulta no cartão ou na franquia não é ex-lead */
  soQuemNuncaAgendou?: boolean;
  /**
   * O silêncio conta da última mensagem OU da entrada em PERDIDO, o que for mais recente (ex-lead): sem isto o estoque que o
   * `parados` manda para PERDIDO depois de 90 dias calado nunca entraria, e ninguém recebe «e aí?» horas depois de a SDR fechar.
   */
  ancorarNaPerda?: boolean;
  /**
   * O silêncio conta da última mensagem OU da entrada na etapa, o que for mais recente (NÃO COMPARECEU): a última mensagem pode
   * ser de semanas antes da falta, e a falta de ontem não é «20 dias sem resposta». Sem a data de entrada, o cartão fica.
   */
  ancorarNaEntrada?: boolean;
  /** marcas de outras fontes que valem como degrau já enviado (a Reativação do `etiquetas-auto`), por cartão */
  marcasExtras?: (ctx: Ctx, leads: KommoLead[]) => Promise<Map<number, Array<Omit<MarcaLida, 'pessoa'>>>>;
  /** a última trava da régua, depois da franquia (ex-lead: as do `etiquetas-auto`); devolve o porquê de segurar */
  travaExtra?: (ctx: Ctx, lead: KommoLead, toque: number) => Promise<(RazaoDeFicar & { horas?: number }) | null>;
}

export async function cartoesDaEtapa(kommo: Ctx['kommo'], alvo: { pipelineId: number; statusId: number }): Promise<KommoLead[]> {
  const out: KommoLead[] = [];
  for (let page = 1; page <= MAX_PAGINAS; page++) {
    const pag = await kommo.listLeadsPorEtapa(alvo.pipelineId, alvo.statusId, 250, page, true, 'desc');
    out.push(...pag);
    if (pag.length < 250) break;
    if (page === MAX_PAGINAS) logger.warn({ ...alvo, lidos: out.length }, 'rotina: etapa com mais cartões que o teto de leitura — só os mais novos foram lidos; os mais antigos ficam de fora');
  }
  return out;
}

export async function varrerSilencio(ctx: Ctx, seco: boolean, p: ParamsDoSilencio, leads: KommoLead[], r: ResumoDaRegua): Promise<void> {
  const { unit, kommo, agora, tz } = ctx;
  r.lidos += leads.length;
  // o que se decidiu «no papel» não pode segurar a mesma decisão depois que a régua é ligada
  const chaveDoCache = `${p.chave}:${seco ? 'seco' : 'ligado'}`;
  const opcoes: OpcoesDeCartao = { agora, tz, pausarIaFieldId: ctx.pausarIaFieldId, ...p.opcoesDoCartao };

  // 1) o cartão, de graça
  let fila: KommoLead[] = [];
  for (const lead of leads) {
    if (pularCartao(ctx.grupo, unit.id, lead, {})) continue; // Kommo dividido: só os cartões desta unidade
    if (jaVisto(unit.id, chaveDoCache, lead.id, agora)) continue;
    const razao = porQueNaoTocar(lead, opcoes);
    if (razao) {
      conta(r.barrados, razao.codigo);
      continue;
    }
    // no dia do aniversário o cartão é do toque de aniversário: nada de retomada junto (só vale onde ele está LIGADO, e para quem
    // seria paciente — lead que nunca consultou não ganha parabéns, então não há o que esperar)
    if (ctx.aniversarioLigado && aniversarioHoje(nascimentoDoCartao(lead), agora, tz, ATRASO_MAX_ANIVERSARIO_DIAS) && (cartaoMostraConsulta(lead) || idClientDoCartao(lead, []) !== null)) {
      conta(r.barrados, 'aniversario-hoje');
      continue;
    }
    if (p.soQuemNuncaAgendou && cartaoMostraConsulta(lead)) {
      conta(r.barrados, 'ja-teve-consulta-no-cartao');
      marcarVisto(unit.id, chaveDoCache, lead.id, agora + 7 * DIA_S);
      continue;
    }
    fila.push(lead);
  }

  // 2) o banco, de graça: marcas da PESSOA dizem em que degrau está; conversa nas últimas 24 h não é esquecida
  const marcasDaUni = await marcasDaUnidade(ctx);
  const [ultimas, extras] = await Promise.all([
    ultimasMensagensNoBanco(unit.id, fila.map((l) => l.id)),
    p.marcasExtras ? p.marcasExtras(ctx, fila) : Promise.resolve(new Map<number, Array<Omit<MarcaLida, 'pessoa'>>>()),
  ]);
  const marcasDe = (lead: KommoLead): MarcaLida[] => {
    const pessoa = pessoaDoCartao(lead);
    return [...(marcasDaUni.porPessoa.get(pessoa) ?? []), ...(extras.get(lead.id) ?? []).map((m) => ({ ...m, pessoa }))];
  };
  const ultimoPronto = Math.min(p.prontos, p.dias.length);
  const filtrada: KommoLead[] = [];
  for (const lead of fila) {
    if (await jaRecebeuHoje(ctx, pessoaDoCartao(lead))) {
      conta(r.barrados, 'ja-recebeu-toque-hoje');
      continue;
    }
    const ultima = ultimas.get(lead.id);
    if (ultima !== undefined && agora - ultima < HORA_S * HORAS_DE_QUALQUER_FALA) {
      conta(r.barrados, 'conversa-nas-ultimas-24h');
      continue;
    }
    // já enviou o ÚLTIMO degrau pronto e ninguém falou depois: sai da fila sem gastar chamada (esgotada, ou à espera de os próximos
    // degraus ficarem prontos na conta). Com o padrão (1 degrau pronto) é a maioria do estoque — sem isto eles voltariam a cada 6 h,
    // ficariam na frente da fila e esgotariam a cota de avaliações.
    const dela = marcasDe(lead).filter((m) => m.chave === p.chave);
    const ultimoEm = dela.reduce((m, x) => Math.max(m, x.em), 0);
    if (dela.some((m) => m.toque >= ultimoPronto) && (ultima === undefined || ultima <= ultimoEm) && agora - ultimoEm < VALIDADE_DO_ATALHO_S) {
      if (ultimoPronto >= p.dias.length) r.esgotadas++;
      else conta(r.seguradas, 'aguarda-proximo-degrau-pronto');
      marcarVisto(unit.id, chaveDoCache, lead.id, agora + 12 * HORA_S);
      continue;
    }
    filtrada.push(lead);
  }
  filtrada.sort((a, b) => (b.updated_at ?? 0) - (a.updated_at ?? 0));

  // 3) o caro, no teto: a mensagem do paciente (1 chamada), o degrau da vez, a conversa, a franquia
  let leituras = 0;
  for (const lead of filtrada) {
    if (leituras >= MAX_AVALIACOES) break;
    if (!(await cabeMais(ctx, seco))) {
      r.paradoPeloTeto = true; // o teto do dia (ou da varredura) acabou: o resto não gasta nem a chamada
      break;
    }
    const contato = contatoPrincipal(lead);
    if (contato === null) {
      conta(r.barrados, 'sem-contato');
      continue;
    }
    leituras++;
    r.avaliados++;
    try {
      const ultima = await kommo.ultimaMensagemDoContatoDesde(contato, agora - p.janelaOlhadaDias * DIA_S);
      let tp = ultima;
      // quem nunca escreveu continua «fora»: as âncoras só adiantam o relógio de quem JÁ conversou
      if (ultima !== null && p.ancorarNaPerda && lead.status_id === 143 && lead.closed_at) tp = Math.max(ultima, lead.closed_at);
      if (ultima !== null && p.ancorarNaEntrada) {
        const entrou = await kommo.ultimaMudancaDeEtapa(lead.id);
        if (entrou === null) {
          conta(r.seguradas, 'sem-data-de-entrada-na-etapa');
          marcarVisto(unit.id, chaveDoCache, lead.id, agora + 3 * HORA_S);
          continue;
        }
        tp = Math.max(ultima, entrou);
      }
      const d = decidirToque({
        agora,
        dias: p.dias,
        etiquetas: p.etiquetas,
        prontos: p.prontos,
        ultimaDoPaciente: tp,
        marcas: tp === null ? [] : marcasDoSilencio(marcasDe(lead), p.chave, tp),
        entradaAteDias: p.entradaAteDias,
      });
      if (d.tipo === 'fora') {
        r.foraDaJanela++;
        marcarVisto(unit.id, chaveDoCache, lead.id, agora + DIA_S);
        continue;
      }
      if (d.tipo === 'esgotada') {
        r.esgotadas++;
        marcarVisto(unit.id, chaveDoCache, lead.id, agora + 12 * HORA_S);
        continue;
      }
      if (d.tipo === 'espera') {
        r.esperando++;
        marcarVisto(unit.id, chaveDoCache, lead.id, d.ate ?? agora + 6 * HORA_S);
        continue;
      }
      const alvo = `${d.toque}º toque · ${d.etiqueta}`;
      if (d.tipo === 'sem-gatilho') {
        conta(r.seguradas, 'sem-gatilho-confirmado');
        if (seco) registrarSimulacao(unit, p.automacao, { leadId: lead.id, acao: 'pularia', alvo, deEtapa: p.etapa, valor: d.toque, motivo: `o ${d.toque}º degrau ainda não tem robô e gatilho confirmados nesta conta (degraus prontos)` });
        marcarVisto(unit.id, chaveDoCache, lead.id, agora + 6 * HORA_S);
        continue;
      }

      // venceu: agora as conferências que custam chamada. Qualquer uma que segure registra o motivo (no seco, na tela).
      const segura = async (codigo: string, motivo: string, horas = 6) => {
        conta(r.seguradas, codigo);
        if (seco) registrarSimulacao(unit, p.automacao, { leadId: lead.id, acao: 'pularia', alvo, deEtapa: p.etapa, valor: d.toque, motivo });
        marcarVisto(unit.id, chaveDoCache, lead.id, agora + horas * HORA_S);
      };
      if (await leadPausadoPorJanela(unit.id, lead.id)) {
        await segura('lead-pausado', 'a recepção pausou este cartão');
        continue;
      }
      const { falas } = await lerFalasDoCartao(kommo, lead.id, { maxTalks: 2 });
      if (falas.some((f) => f.autor === 'EQUIPE' && (f.em ?? 0) >= agora - HORAS_DA_EQUIPE * HORA_S)) {
        await segura('equipe-conversando', `a equipe falou com o paciente nas últimas ${HORAS_DA_EQUIPE} h`);
        continue;
      }
      if (falas.some((f) => f.autor !== 'PACIENTE' && (f.em ?? 0) >= agora - HORAS_DE_QUALQUER_FALA * HORA_S)) {
        await segura('falaram-hoje', `já falaram com o paciente nas últimas ${HORAS_DE_QUALQUER_FALA} h`);
        continue;
      }
      if (falas.some((f) => f.autor === 'PACIENTE' && (f.em ?? 0) > (tp ?? 0))) {
        await segura('paciente-escreveu', 'o paciente escreveu agora há pouco');
        continue;
      }
      const f = await (ctx.franquia ?? franquiaDoPaciente)(unit, lead.id, lead.name ?? null, agora);
      if (f.consultaFutura || f.emAndamento) {
        await segura('franquia-segura', f.emAndamento ? 'tratamento em andamento na franquia' : 'consulta futura na franquia', 12);
        continue;
      }
      if (p.soQuemNuncaAgendou && franquiaTemHistorico(f)) {
        await segura('ja-agendou-na-franquia', 'a franquia tem agendamento ou tratamento deste paciente: não é ex-lead', 24 * 7);
        continue;
      }
      const extra = p.travaExtra ? await p.travaExtra(ctx, lead, d.toque) : null;
      if (extra) {
        await segura(extra.codigo, extra.texto, extra.horas ?? 6);
        continue;
      }

      const aindaVale = (fresco: KommoLead): string | null => {
        if (fresco.status_id !== lead.status_id || fresco.pipeline_id !== lead.pipeline_id) return 'mudou de etapa';
        const razao = porQueNaoTocar(fresco, { ...opcoes, agora: Math.floor(Date.now() / 1000) });
        return razao ? razao.texto : null;
      };
      const motivo = d.atrasado
        ? `${d.silencioDias} dias sem o paciente escrever (pelo calendário já passou do prazo; entra pelo ${d.toque}º degrau)`
        : `${d.silencioDias} dias sem o paciente escrever em ${p.etapa}`;
      const res = await tocar(ctx, seco, { lead, automacao: p.automacao, chave: p.chave, toque: d.toque, etiqueta: d.etiqueta, tp: tp as number, etapa: p.etapa, motivo, aindaVale }, r);
      if (res === 'teto') {
        r.paradoPeloTeto = true;
        break;
      }
      // falha da conta (sem a etiqueta do degrau), marca que não gravou, cartão que mudou: não reavaliar em toda varredura
      marcarVisto(unit.id, chaveDoCache, lead.id, agora + (res === 'ok' ? 6 : 3) * HORA_S);
    } catch (err) {
      r.erros++;
      marcarVisto(unit.id, chaveDoCache, lead.id, agora + 3 * HORA_S);
      // erro do Kommo ou da franquia num cartão: pula o cartão, nunca vira "pode mandar"
      logger.warn({ err: String(err), unit: unit.slug, leadId: lead.id, regua: p.chave }, 'rotina: erro num cartão — pulei');
    }
  }
}

/**
 * Rotina diária, régua 1 — ESQUECIDOS POR ETAPA (chave `ROTINA_ROBOS_SLUGS`, automação `rotina-robos`).
 *
 * Quem o paciente parou de responder e ninguém tocou, em três etapas do COMERCIAL, recebe a ▶ Retomada (1º toque), a ▶ Retomada 2 e
 * a ▶ Retomada 3 conforme os dias sem resposta:
 *   EM QUALIFICAÇÃO 2/4/7 d · NÃO COMPARECEU 1/3/6 d · EM NEGOCIAÇÃO 2/5/9 d.
 * O dia 1 da QUALIFICAÇÃO NÃO é daqui: nas primeiras 24 h o `follow-up-24h` da Sofia fala DENTRO da janela do WhatsApp (5 min, 30 min,
 * 2 h, 6 h, 20 h). A rotina começa depois, com MODELO. As regras comuns (marca por pessoa, teto, seco) e o motor do silêncio estão em
 * `rotina-nucleo.ts` e `rotina-silencio.ts`.
 *
 * O relógio do NÃO COMPARECEU conta da última mensagem do paciente OU da entrada na etapa, o que for mais recente: a falta de ontem não
 * é "20 dias sem resposta" só porque a última mensagem foi de quando ele agendou. QUALIFICAÇÃO e NEGOCIAÇÃO contam da última mensagem
 * (decisão do João: "N dias sem resposta").
 *
 * SOBREPOSIÇÃO COM O QUE JÁ EXISTE (conferir antes de ligar numa unidade):
 *  - EM NEGOCIAÇÃO: os robôs `decisao_retomada_4d` / `decisao_encerramento_7d` (e `decisao_reengajamento_30d`) disparam em COMPARECEU e
 *    EM NEGOCIAÇÃO relativos à ◷ Data da Consulta (Situação = Atendido). Um cartão em negociação pode receber o deles E o 1º toque
 *    daqui no mesmo período. A trava «falaram com ele nas últimas 24 h» (qualquer fala, inclusive de robô) evita o mesmo dia, não os
 *    dias seguintes. Onde esses robôs existem, ligue a NEGOCIAÇÃO com prazos maiores (rotina_negociacao_d1..d3) ou deixe-a de fora.
 *  - EM QUALIFICAÇÃO / entrada com o `parados` ligado: a régua esgotada da Sofia («⬢ Status da conversa» = Sem resposta, 24 h depois do
 *    último toque) leva o cartão a PERDIDO ANTES do 2º dia. Nessas unidades esta régua só alcança o que o `parados` não pegou.
 *  - NÃO COMPARECEU com o `parados`: ele move para EM ESPERA com 7 dias (30 com os estoques); os degraus 1/3/6 cabem antes.
 */
import type { KommoLead } from '../services/kommo.service.js';
import { logger } from './logger.js';
import { estadoDaAutomacao, type Estado } from './automacoes-estado.js';
import { ETAPA } from './franquia-move.js';
import { acharNaConta } from './ponte-etiquetas.js';
import { cartoesDaEtapa, prazos, varrerSilencio } from './rotina-silencio.js';
import { criarWorker, inteiro, intentsDe, limitar, MAX_TOQUES, resumoNovo, type Ctx, type Regua, type ResumoDaRegua } from './rotina-nucleo.js';

export const ID_ROTINA_ETAPAS = 'rotina-robos';

export interface ReguaPorEtapa {
  /** vai no id da marca: sem hífen */
  chave: 'qualificacao' | 'naocompareceu' | 'negociacao';
  etapa: string;
  /** dias sem resposta de cada toque */
  dias: readonly number[];
  /** conta também da entrada na etapa (a última mensagem pode ser de antes do evento que pôs o cartão aqui) */
  ancorarNaEntrada?: boolean;
}

/** Os prazos do João (06/11/2026). */
export const REGUAS_POR_ETAPA: readonly ReguaPorEtapa[] = [
  { chave: 'qualificacao', etapa: ETAPA.QUALIFICACAO, dias: [2, 4, 7] },
  { chave: 'naocompareceu', etapa: ETAPA.NAO_COMPARECEU, dias: [1, 3, 6], ancorarNaEntrada: true },
  { chave: 'negociacao', etapa: ETAPA.NEGOCIACAO, dias: [2, 5, 9] },
];

/** Uma etiqueta por degrau: o robô de cada uma manda o modelo daquele degrau (o gatilho é «etiqueta adicionada»). */
export const ETIQUETAS_RETOMADA: readonly string[] = ['▶ Retomada', '▶ Retomada 2', '▶ Retomada 3'];
/** Quem está calado há mais que isto e nunca recebeu o 1º degrau é ESTOQUE ANTIGO: não entra (é do `parados`). */
export const MAX_SILENCIO_ETAPAS_DIAS = 30;

export interface ConfigDasEtapas {
  etapas: Record<ReguaPorEtapa['chave'], number[]>;
  /** quantos degraus de ▶ Retomada têm etiqueta + robô + modelo prontos NA CONTA (o gatilho do Kommo só se lê com sessão) */
  toquesProntos: number;
  invalidas: string[];
}

/** Chaves da unidade (`pipelineIntents`): `rotina_<etapa>_d1..d3` e `rotina_toques_prontos`. */
export function configDasEtapas(pipelineIntents: unknown, env: Record<string, string | undefined> = process.env): ConfigDasEtapas {
  const intents = intentsDe(pipelineIntents);
  const invalidas: string[] = [];
  const etapas = {} as ConfigDasEtapas['etapas'];
  for (const r of REGUAS_POR_ETAPA) etapas[r.chave] = prazos(r.dias, intents, `rotina_${r.chave}`, env[`ROTINA_ROBOS_DIAS_${r.chave.toUpperCase()}`], invalidas);
  return { etapas, toquesProntos: limitar(inteiro(intents.rotina_toques_prontos), MAX_TOQUES, 1), invalidas };
}

export const estadoDasEtapas = (slug: string, raw: string | undefined = process.env.ROTINA_ROBOS_SLUGS): Estado => estadoDaAutomacao(slug, ID_ROTINA_ETAPAS, raw);

export async function varrerEtapas(ctx: Ctx, seco: boolean, resumo: Record<string, ResumoDaRegua>): Promise<void> {
  if (!acharNaConta(ETIQUETAS_RETOMADA[0], [...ctx.tagsDaConta])) {
    logger.warn({ unit: ctx.unit.slug, etiqueta: ETIQUETAS_RETOMADA[0] }, 'rotina: a conta não tem a etiqueta do 1º toque — nada a fazer nas etapas');
    resumo.etapas = { ...resumoNovo(), seguradas: { 'sem-etiqueta-na-conta': 1 } };
    return;
  }
  const cfg = configDasEtapas(ctx.unit.pipelineIntents);
  if (cfg.invalidas.length) logger.warn({ unit: ctx.unit.slug, invalidas: cfg.invalidas }, 'rotina: prazos inválidos na unidade — usei os padrões');
  for (const regua of REGUAS_POR_ETAPA) {
    const r = (resumo[regua.chave] = resumoNovo());
    const alvo = ctx.funis.idDe('COMERCIAL', regua.etapa);
    if (!alvo) continue;
    const dias = cfg.etapas[regua.chave];
    const leads: KommoLead[] = await cartoesDaEtapa(ctx.kommo, alvo);
    await varrerSilencio(
      ctx,
      seco,
      {
        automacao: ID_ROTINA_ETAPAS,
        chave: regua.chave,
        etapa: regua.etapa,
        dias,
        etiquetas: ETIQUETAS_RETOMADA,
        prontos: cfg.toquesProntos,
        entradaAteDias: MAX_SILENCIO_ETAPAS_DIAS,
        // com a âncora na entrada a última mensagem pode ser bem anterior à falta (agendou há 40 dias, faltou ontem)
        janelaOlhadaDias: regua.ancorarNaEntrada ? 365 : MAX_SILENCIO_ETAPAS_DIAS + dias[dias.length - 1],
        opcoesDoCartao: {},
        ancorarNaEntrada: regua.ancorarNaEntrada,
      },
      leads,
      r,
    );
  }
}

export const reguaDasEtapas: Regua = { id: ID_ROTINA_ETAPAS, estado: estadoDasEtapas, primeiraEmMin: 12, rodar: varrerEtapas };

const worker = criarWorker(reguaDasEtapas);
export const startRotinaEtapasWorker = worker.start;
export const stopRotinaEtapasWorker = worker.stop;

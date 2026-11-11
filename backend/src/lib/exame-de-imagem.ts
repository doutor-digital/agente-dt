/**
 * Exame de imagem que o paciente manda no chat (pedido da dona de Timbó, 10/11/2026; decisão do João, 11/11/2026).
 *
 * Paciente manda foto ou PDF de ressonância, tomografia, raio-X, ultrassom ou o laudo de um desses → a Sofia diz que
 * vai passar o exame ao especialista, PAUSA a IA naquele cartão e a equipe é avisada: mensagem no grupo de WhatsApp
 * da unidade (quando configurado) e tarefa no cartão. Não é sinal de alerta: sem 🔴 PRIORIDADE e sem LIGAR AGORA.
 *
 * Automação `exame-de-imagem-pausa-alerta` (EXAME_DE_IMAGEM_SLUGS), nasce desligada. Desligada, NADA muda — nem o
 * prompt da visão, que só ganha a linha do "EXAME DE IMAGEM:" quando a chave está ligada para a unidade.
 *
 * Comprovante Pix tem prioridade: a visão marca "COMPROVANTE:" e o fluxo do comprovante segue como sempre. Foto do
 * corpo, print, figurinha: seguem como hoje.
 *
 * Mesmo molde do áudio que não deu para ouvir (webhook.controller.ts): o aviso sai em código ANTES das travas (fora do
 * horário ou com o cartão pausado o modelo nem roda, e o exame ficaria sem ninguém saber); a pausa e a frase ao
 * paciente ficam com o modelo, pela instrução na mensagem dele.
 *
 * Env do grupo (sem ele, só a tarefa no cartão):
 *  - EXAME_DE_IMAGEM_GRUPOS: JSON {"<slug>": "<id do grupo>@g.us"}.
 *  - EXAME_DE_IMAGEM_EVOLUTION_URL: …/message/sendText/<instância que envia>.
 *  - EXAME_DE_IMAGEM_EVOLUTION_HEADER / _VALUE: o cabeçalho da chave da Evolution (padrão: os do EVOLUTION_ALERT_*).
 */
import axios from 'axios';
import type { Unit } from '@prisma/client';
import { automacaoLigada } from './automacoes-estado.js';
import { logger } from './logger.js';

export const ID_DA_AUTOMACAO = 'exame-de-imagem-pausa-alerta';

export function exameDeImagemLigado(unit: Pick<Unit, 'slug'>): boolean {
  return automacaoLigada(unit.slug, ID_DA_AUTOMACAO, process.env.EXAME_DE_IMAGEM_SLUGS);
}

/** A marca que a visão põe no começo da leitura de um exame de imagem (só com a chave ligada). */
export const MARCA_DO_EXAME = 'EXAME DE IMAGEM:';

/** Linha a mais no prompt da visão (services/vision.service.ts), só com a chave ligada. */
export const LINHA_DA_VISAO =
  `- EXAME DE IMAGEM (ressonância, tomografia, raio-X, ultrassom, densitometria — a imagem do exame OU o laudo/relatório de um ` +
  `desses): comece a resposta com "${MARCA_DO_EXAME}", diga qual exame é e de que região, e resuma o laudo se houver texto. ` +
  `Pedido médico, receita, atestado, comprovante e foto do corpo NÃO são exame de imagem.`;

/** A leitura da visão é de um exame de imagem? Comprovante nunca é (a marca dele vem primeiro e tem fluxo próprio). */
export function ehLeituraDeExame(leitura: string | null | undefined): boolean {
  const t = (leitura ?? '').trimStart();
  if (/^COMPROVANTE:/i.test(t)) return false;
  return t.toUpperCase().startsWith(MARCA_DO_EXAME);
}

/** O que vai na mensagem do modelo (não entra em `humanMessage`, como a instrução do áudio). */
export const INSTRUCAO_DO_EXAME =
  '[o paciente mandou um EXAME DE IMAGEM (ver acima). Chame pausar_ia (motivo: "exame de imagem para o especialista") e ' +
  'responda UMA frase acolhedora: que recebeu o exame e vai passar para o especialista da nossa equipe, que continua o ' +
  'atendimento por aqui. NÃO comente nem interprete o exame, NÃO diagnostique, NÃO diga se é grave ou se precisa de ' +
  'cirurgia, NÃO prometa prazo ("em instantes", "já já", "logo te chamam") e não siga a conversa depois disso. Se na ' +
  'mesma mensagem o paciente contou um sinal de alerta, a regra <sinal_de_alerta> vale antes desta.]';

function resumoCurto(leituras: string[]): string {
  return leituras
    .map((l) => l.trimStart().slice(MARCA_DO_EXAME.length).trim())
    .join(' | ')
    .replace(/\s+/g, ' ')
    .slice(0, 600);
}

export function linkDoCartao(unit: Pick<Unit, 'kommoSubdomain'>, leadId: number): string | null {
  const sub = unit.kommoSubdomain?.trim();
  return sub ? `https://${sub}.kommo.com/leads/detail/${leadId}` : null;
}

/** Texto do grupo. Sem diagnóstico: o resumo é o que a visão leu do laudo, dito como "o que chegou". */
export function textoDoGrupo(a: { unidade: string; leadId: number; link: string | null; leituras: string[] }): string {
  return [
    `📄 Exame de imagem recebido — ${a.unidade}`,
    `Cartão ${a.leadId}${a.link ? `: ${a.link}` : ''}`,
    `O que chegou: ${resumoCurto(a.leituras) || '(sem leitura)'}`,
    'A Sofia pausou nesse cartão e disse ao paciente que o exame vai para o especialista. Alguém da equipe continua por lá.',
  ].join('\n');
}

/** Texto da tarefa no cartão (formato `ALERTA · <slug> ·` que o roteador de alertas lê). */
export function textoDaTarefa(slug: string, leituras: string[]): string {
  return (
    `ALERTA · ${slug} · Exame de imagem enviado pelo paciente — a IA pausou. Ver o exame e responder por aqui. ` +
    `O que chegou: ${resumoCurto(leituras).slice(0, 300) || '(sem leitura)'}`
  );
}

export function grupoDoExame(slug: string, raw: string | undefined = process.env.EXAME_DE_IMAGEM_GRUPOS): string | null {
  if (!raw?.trim()) return null;
  try {
    const mapa = JSON.parse(raw.trim().replace(/^'|'$/g, '')) as Record<string, unknown>;
    const g = mapa?.[slug];
    return typeof g === 'string' && g.trim() ? g.trim() : null;
  } catch {
    logger.warn('exame-de-imagem: EXAME_DE_IMAGEM_GRUPOS não é JSON válido — sem grupo');
    return null;
  }
}

/** Manda no grupo. true = mandou; false = sem config ou falhou (já logado). Nunca lança. */
export async function mandarNoGrupo(
  grupo: string,
  texto: string,
  deps: { post?: typeof axios.post } = {},
): Promise<boolean> {
  const url = process.env.EXAME_DE_IMAGEM_EVOLUTION_URL;
  const header = process.env.EXAME_DE_IMAGEM_EVOLUTION_HEADER || process.env.EVOLUTION_ALERT_HEADER;
  const value = process.env.EXAME_DE_IMAGEM_EVOLUTION_VALUE || process.env.EVOLUTION_ALERT_VALUE;
  if (!url || !header || !value) {
    logger.warn('exame-de-imagem: sem EXAME_DE_IMAGEM_EVOLUTION_URL/HEADER/VALUE — o grupo não recebe, fica a tarefa');
    return false;
  }
  try {
    await (deps.post ?? axios.post)(url, { number: grupo, text: texto.slice(0, 1500) }, {
      headers: { 'Content-Type': 'application/json', [header]: value },
      timeout: 15_000,
    });
    return true;
  } catch (err) {
    logger.warn({ err: String(err) }, 'exame-de-imagem: falha ao mandar no grupo (fica a tarefa)');
    return false;
  }
}

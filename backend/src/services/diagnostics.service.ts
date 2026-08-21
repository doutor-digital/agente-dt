// ============================================================================
// diagnostics.service.ts — o raio-x do sistema numa chamada.
//
// Nasceu de um incidente real: a conta da OpenAI ficou sem crédito e derrubou
// juiz, memória de longo prazo, transcrição de áudio, leitura de imagem e a
// busca na base de conhecimento — TUDO em silêncio, porque o atendimento em si
// roda na Anthropic e continuou respondendo. Levou horas de SSH e leitura de
// log pra achar. Este módulo responde àquela pergunta em segundos.
//
// A regra aqui é: NÃO diga "de pé", PROVE. Cada checagem faz a chamada mais
// barata possível contra a dependência real e reporta o que dá pra agir.
// ============================================================================

import { prisma } from '../lib/prisma.js';
import { env } from '../lib/env.js';

export type Estado = 'ok' | 'alerta' | 'falha' | 'nao_configurado';

export interface Checagem {
  nome: string;
  estado: Estado;
  /** Frase curta, em português, do que está acontecendo. */
  detalhe: string;
  /** O que fazer se não estiver ok. */
  acao?: string;
  latenciaMs?: number;
}

async function cronometrar<T>(fn: () => Promise<T>): Promise<[T, number]> {
  const t0 = Date.now();
  const r = await fn();
  return [r, Date.now() - t0];
}

/** Banco: a query mais barata que prova que dá pra ler de verdade. */
async function checarBanco(): Promise<Checagem> {
  try {
    const [, ms] = await cronometrar(() => prisma.$queryRaw`SELECT 1`);
    return {
      nome: 'Banco de dados',
      estado: ms > 1000 ? 'alerta' : 'ok',
      detalhe: ms > 1000 ? `Respondendo devagar (${ms}ms)` : 'Respondendo normalmente',
      latenciaMs: ms,
    };
  } catch (err) {
    return {
      nome: 'Banco de dados',
      estado: 'falha',
      detalhe: err instanceof Error ? err.message.slice(0, 160) : 'Sem resposta',
      acao: 'O sistema não funciona sem o banco. Verificar o contêiner do Postgres.',
    };
  }
}

/**
 * OpenAI: a checagem mais importante do arquivo. Distingue os três casos que
 * confundem: chave ausente, chave inválida e — o que nos pegou — chave válida
 * SEM CRÉDITO.
 *
 * CUSTO ZERO, e isso é deliberado: usa GET /v1/models, que é metadado e NÃO
 * consome token. NÃO troque por uma chamada de completion "só pra testar" —
 * viraria custo por diagnóstico, no exato sistema onde o crédito já acabou uma
 * vez. O 429 aparece igual no /models quando a conta está sem saldo.
 */
async function checarOpenAI(): Promise<Checagem> {
  const key = env.OPENAI_API_KEY;
  if (!key) {
    return {
      nome: 'OpenAI',
      estado: 'nao_configurado',
      detalhe: 'Sem chave configurada',
      acao: 'Define OPENAI_API_KEY. Sem ela: juiz, memória, áudio, imagem e busca de conhecimento ficam parados.',
    };
  }
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 8000);
    const [res, ms] = await cronometrar(() =>
      fetch('https://api.openai.com/v1/models?limit=1', {
        headers: { Authorization: `Bearer ${key}` },
        signal: ctrl.signal,
      }),
    );
    clearTimeout(t);

    if (res.ok) return { nome: 'OpenAI', estado: 'ok', detalhe: 'Chave válida e respondendo', latenciaMs: ms };
    if (res.status === 401) {
      return {
        nome: 'OpenAI',
        estado: 'falha',
        detalhe: 'Chave inválida ou revogada',
        acao: 'Gerar uma chave nova e atualizar OPENAI_API_KEY.',
        latenciaMs: ms,
      };
    }
    if (res.status === 429) {
      return {
        nome: 'OpenAI',
        estado: 'falha',
        detalhe: 'Sem crédito ou limite estourado',
        acao: 'Adicionar crédito na conta. Enquanto isso: juiz, memória, ÁUDIO DO PACIENTE, imagem e busca de conhecimento ficam parados — sem erro na tela.',
        latenciaMs: ms,
      };
    }
    return { nome: 'OpenAI', estado: 'alerta', detalhe: `Resposta inesperada (HTTP ${res.status})`, latenciaMs: ms };
  } catch {
    return { nome: 'OpenAI', estado: 'falha', detalhe: 'Não consegui falar com a OpenAI', acao: 'Verificar rede/saída da VPS.' };
  }
}

/** Anthropic: é quem atende o paciente na maioria das unidades. */
async function checarAnthropic(): Promise<Checagem> {
  const unit = await prisma.unit.findFirst({
    where: { anthropicApiKey: { not: null }, llmProvider: 'anthropic' },
    select: { anthropicApiKey: true },
  });
  const key = unit?.anthropicApiKey;
  if (!key) {
    return { nome: 'Anthropic (Claude)', estado: 'nao_configurado', detalhe: 'Nenhuma unidade com chave Claude' };
  }
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 8000);
    const [res, ms] = await cronometrar(() =>
      fetch('https://api.anthropic.com/v1/models?limit=1', {
        headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
        signal: ctrl.signal,
      }),
    );
    clearTimeout(t);
    if (res.ok) return { nome: 'Anthropic (Claude)', estado: 'ok', detalhe: 'Chave válida e respondendo', latenciaMs: ms };
    return {
      nome: 'Anthropic (Claude)',
      estado: 'falha',
      detalhe: res.status === 401 ? 'Chave inválida' : `HTTP ${res.status}`,
      acao: 'É o modelo que atende o paciente na maioria das unidades — resolver com prioridade.',
      latenciaMs: ms,
    };
  } catch {
    return { nome: 'Anthropic (Claude)', estado: 'falha', detalhe: 'Não consegui falar com a Anthropic' };
  }
}

/** O juiz alimenta o painel de qualidade por versão de prompt. */
async function checarJuiz(): Promise<Checagem> {
  const [total, recentes] = await Promise.all([
    prisma.conversationEvaluation.count(),
    prisma.conversationEvaluation.count({
      where: { createdAt: { gte: new Date(Date.now() - 24 * 3_600_000) } },
    }),
  ]);
  if (total === 0) {
    return {
      nome: 'Juiz de conversas',
      estado: 'alerta',
      detalhe: 'Nenhuma conversa avaliada ainda',
      acao: 'O painel de Prompts fica vazio sem isto. Costuma ser falta de crédito na OpenAI.',
    };
  }
  return {
    nome: 'Juiz de conversas',
    estado: recentes > 0 ? 'ok' : 'alerta',
    detalhe: `${total} avaliadas no total, ${recentes} nas últimas 24h`,
    acao: recentes === 0 ? 'Parou de avaliar. Checar crédito da OpenAI e os logs do judge-worker.' : undefined,
  };
}

/** Entrega ao paciente: o dado que diz se a IA está de fato falando. */
async function checarAtendimento(): Promise<Checagem> {
  const desde = new Date(Date.now() - 24 * 3_600_000);
  const [msgs, erros] = await Promise.all([
    prisma.message.count({ where: { role: 'assistant', createdAt: { gte: desde } } }),
    prisma.executionStep.count({ where: { kind: 'ERROR', createdAt: { gte: desde } } }),
  ]);
  if (msgs === 0) {
    return {
      nome: 'Atendimento (respostas ao paciente)',
      estado: 'falha',
      detalhe: 'Nenhuma resposta enviada nas últimas 24h',
      acao: 'A IA pode estar muda. Checar chave do modelo, webhook do Kommo e o campo de entrega.',
    };
  }
  const taxa = msgs > 0 ? erros / msgs : 0;
  return {
    nome: 'Atendimento (respostas ao paciente)',
    estado: taxa > 0.25 ? 'alerta' : 'ok',
    detalhe: `${msgs} respostas nas últimas 24h, ${erros} passos com erro`,
    acao: taxa > 0.25 ? 'Proporção de erro alta — abrir a aba Erros.' : undefined,
  };
}

/** Unidades sem o básico configurado não atendem, e isso passa despercebido. */
async function checarUnidades(): Promise<Checagem> {
  const units = await prisma.unit.findMany({
    select: { name: true, kommoAccessToken: true, kommoReplyFieldId: true, llmProvider: true, anthropicApiKey: true, openaiApiKey: true },
  });
  const ativas = units.filter((u) => u.kommoAccessToken);
  const quebradas = ativas.filter((u) => {
    const semEntrega = !u.kommoReplyFieldId;
    const semModelo =
      u.llmProvider === 'anthropic' ? !u.anthropicApiKey : u.llmProvider === 'openai' ? !u.openaiApiKey && !env.OPENAI_API_KEY : false;
    return semEntrega || semModelo;
  });
  return {
    nome: 'Unidades',
    estado: quebradas.length > 0 ? 'alerta' : 'ok',
    detalhe:
      quebradas.length > 0
        ? `${quebradas.length} de ${ativas.length} sem configuração completa: ${quebradas.map((u) => u.name).join(', ')}`
        : `${ativas.length} unidades conectadas e configuradas`,
    acao: quebradas.length > 0 ? 'Falta campo de resposta ou chave do modelo — a IA delas não responde.' : undefined,
  };
}

export interface Diagnostico {
  resumo: { estado: Estado; falhas: number; alertas: number };
  checagens: Checagem[];
  geradoEm: string;
}

/** Roda tudo em paralelo — o diagnóstico inteiro custa o tempo do mais lento. */
export async function rodarDiagnostico(): Promise<Diagnostico> {
  const checagens = await Promise.all([
    checarBanco(),
    checarOpenAI(),
    checarAnthropic(),
    checarAtendimento(),
    checarJuiz(),
    checarUnidades(),
  ]);
  const falhas = checagens.filter((c) => c.estado === 'falha').length;
  const alertas = checagens.filter((c) => c.estado === 'alerta').length;
  return {
    resumo: { estado: falhas > 0 ? 'falha' : alertas > 0 ? 'alerta' : 'ok', falhas, alertas },
    checagens,
    geradoEm: new Date().toISOString(),
  };
}

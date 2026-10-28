/**
 * Dados de mentira para PRÉVIA da tela (só entram no pacote em desenvolvimento; ver main.tsx).
 * Não são resultado de campanha nenhuma. O formato é o contrato final de GET /api/disparo/ondas/:id/resultado (PR #153).
 */
import type { DisparoPessoa, DisparoResultado } from '../../types/disparo';

/** "Agora" fixo das prévias, para a tela dizer sempre "às 14:47" e a captura sair igual. 28/10/2026 14:47 em Brasília. */
export const AGORA_DA_PREVIA = new Date('2026-10-28T17:47:00Z');

const JANELA = '9h às 18h, segunda a sexta, sem feriado nacional';

/** A onda real de hoje (Canaã): 31 enviados, 15 na fila. Meta e Kommo ainda sem resposta: prova o estado vazio. */
export const MOCK_VAZIO: DisparoResultado = {
  ok: true,
  onda: {
    id: 'cmvr6c1f0mock',
    estado: 'aprovada',
    unidade: 'canaa',
    unidadeNome: 'Canaã dos Carajás',
    campanha: 'ciatico-onde-doi',
    campanhaNome: 'Ciático · Onde dói?',
    etiqueta: 'Disparo Ciático',
    aprovadaEm: '2026-10-28T16:05:00Z',
    aprovadaPor: 'João',
    pausaMotivo: null,
  },
  funil: {
    selecionados: 46,
    enviados: 31,
    falhas: 0,
    pendentes: 15,
    saiu: 0,
    descartados: 0,
    entregues: null,
    lidas: null,
    responderam: null,
    agendaram: null,
  },
  custo: { usd: null, brl: null, porResposta: null, porAgendamento: null, atualizadoEm: null },
  porHora: [
    { hora: '2026-10-28T16:00:00Z', enviados: 12 },
    { hora: '2026-10-28T17:00:00Z', enviados: 19 },
  ],
  freios: {
    janela: JANELA,
    tetoPorHora: 30,
    tetoPorDia: 100,
    maxSair: 3,
    enviadosUltimaHora: 19,
    enviadosUltimas24h: 31,
  },
  fontes: {
    entregues: 'meta-template-analytics',
    custo: 'meta-pricing-analytics',
    responderam: 'kommo',
    agendaram: 'franquia',
    entreguesAtualizadoEm: null,
    atualizadoEm: '2026-10-28T17:30:00Z',
    notas: {
      entregues: 'a Meta ainda não contou todos os envios (22 de 31): dado atrasado',
      custo: 'sem o número de entregues conferido não dá para saber se a cobrança da Meta já fechou',
      responderam: 'o Kommo ainda não respondeu à conferência das mensagens recebidas',
      agendaram: 'a agenda da franquia ainda não foi conferida para esta onda',
    },
  },
  atualizadoEm: '2026-10-28T17:47:00Z',
};

/** Onda concluída com tudo preenchido, em dois dias. Prova o estado cheio. */
export const MOCK_CHEIO: DisparoResultado = {
  ok: true,
  onda: {
    ...MOCK_VAZIO.onda,
    id: 'cmvr6c1f0cheio',
    estado: 'concluida',
    aprovadaEm: '2026-10-27T12:10:00Z',
  },
  funil: {
    selecionados: 120,
    enviados: 117,
    falhas: 2,
    pendentes: 0,
    saiu: 2,
    descartados: 1,
    entregues: 111,
    lidas: 71,
    responderam: 23,
    agendaram: 6,
  },
  custo: { usd: 6.95, brl: 38.9, porResposta: 1.69, porAgendamento: 6.48, atualizadoEm: '2026-10-28T16:15:00Z' },
  porHora: [
    { hora: '2026-10-27T12:00:00Z', enviados: 22 },
    { hora: '2026-10-27T13:00:00Z', enviados: 30 },
    { hora: '2026-10-27T14:00:00Z', enviados: 28 },
    { hora: '2026-10-27T15:00:00Z', enviados: 4 },
    { hora: '2026-10-28T12:00:00Z', enviados: 24 },
    { hora: '2026-10-28T13:00:00Z', enviados: 9 },
  ],
  freios: {
    janela: JANELA,
    tetoPorHora: 30,
    tetoPorDia: 100,
    maxSair: 3,
    enviadosUltimaHora: 0,
    enviadosUltimas24h: 33,
  },
  fontes: {
    entregues: 'meta-template-analytics',
    custo: 'meta-pricing-analytics',
    responderam: 'kommo',
    agendaram: 'franquia',
    entreguesAtualizadoEm: '2026-10-28T16:15:00Z',
    atualizadoEm: '2026-10-28T17:30:00Z',
    notas: {
      entregues: null,
      custo: null,
      responderam: null,
      agendaram: 'limite inferior: só conta quem a agenda da franquia reconhece pelo nome inteiro',
    },
  },
  atualizadoEm: '2026-10-28T17:47:00Z',
};

/** Pausada por SAIR, com custo acima do esperado: confere a faixa de pausa, o rodapé vermelho e os freios no limite. */
export const MOCK_PAUSADA: DisparoResultado = {
  ...MOCK_CHEIO,
  onda: {
    ...MOCK_CHEIO.onda,
    id: 'cmvr6c1f0pausa',
    estado: 'pausada',
    aprovadaEm: '2026-10-28T12:10:00Z',
    pausaMotivo: 'Quatro pessoas pediram SAIR (o máximo é 3). A unidade parou sozinha para você olhar.',
  },
  funil: {
    selecionados: 120,
    enviados: 84,
    falhas: 2,
    pendentes: 32,
    saiu: 4,
    descartados: 2,
    entregues: 80,
    lidas: 49,
    responderam: 15,
    agendaram: 3,
  },
  porHora: [
    { hora: '2026-10-28T11:00:00Z', enviados: 4 },
    { hora: '2026-10-28T12:00:00Z', enviados: 20 },
    { hora: '2026-10-28T13:00:00Z', enviados: 30 },
    { hora: '2026-10-28T14:00:00Z', enviados: 30 },
  ],
  freios: { ...MOCK_CHEIO.freios, enviadosUltimaHora: 29, enviadosUltimas24h: 84 },
};

/* ------------------------- pessoas (GET /disparo/ondas/:id) ------------------------- */

const NOMES = [
  'Maria Aparecida Silva',
  'José Ribeiro Costa',
  'Antônia Ferreira Lima',
  'Raimundo Nonato Sousa',
  'Francisca Alves Pereira',
  'Luiz Carlos Santos',
  'Ana Paula Oliveira',
  'Edvaldo Barbosa Rocha',
  'Josefa Martins Cardoso',
  'Sebastião Gomes Araújo',
  'Rita de Cássia Moreira',
  'Pedro Henrique Dias',
  'Conceição Teixeira Nunes',
  'Manoel Batista Freitas',
];

/** Lista de pessoas coerente com o funil da onda (mais recentes primeiro, falhas e SAIR logo depois). */
export function pessoasDaPrevia(d: DisparoResultado): DisparoPessoa[] {
  const out: DisparoPessoa[] = [];
  let i = 0;
  const nome = () => NOMES[i++ % NOMES.length]!;
  const ultima = d.porHora.length ? new Date(d.porHora[d.porHora.length - 1]!.hora).getTime() : new Date(AGORA_DA_PREVIA).getTime();
  const enviadoEm = (k: number) => new Date(ultima + (50 - k * 7) * 60_000).toISOString();
  const recebeu = Math.min(5, d.funil.enviados - d.funil.saiu);
  for (let k = 0; k < recebeu; k++) {
    out.push({ nome: nome(), estado: 'enviado', motivo: null, enviadoEm: enviadoEm(k), kommoLeadId: 1000 + k });
  }
  for (let k = 0; k < Math.min(2, d.funil.saiu); k++) {
    out.push({ nome: nome(), estado: 'saiu', motivo: null, enviadoEm: enviadoEm(recebeu + k), kommoLeadId: 2000 + k });
  }
  for (let k = 0; k < Math.min(2, d.funil.falhas); k++) {
    out.push({
      nome: nome(),
      estado: 'falhou',
      motivo: 'A Meta recusou o número (não tem WhatsApp).',
      enviadoEm: null,
      kommoLeadId: 3000 + k,
    });
  }
  for (let k = 0; k < Math.min(3, d.funil.pendentes); k++) {
    out.push({ nome: nome(), estado: 'pendente', motivo: null, enviadoEm: null, kommoLeadId: 4000 + k });
  }
  return out;
}

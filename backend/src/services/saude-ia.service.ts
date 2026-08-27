import type { Unit } from '@prisma/client';

import { TETO_CONVERSA_USD } from '../agent/teto-conversa.js';

/**
 * Retrato do que a IA tem, do que está ligado e do que falta.
 *
 * Existe porque a coisa mais cara que aconteceu neste projeto não foi falta de
 * recurso — foi recurso pronto que ninguém sabia que existia, ou que estava
 * desligado por uma variável de ambiente. Três casos no mesmo dia:
 *   • o guardar-token da franquia estava pronto há meses e nunca teve tela;
 *   • o playground existia pra testar a IA e não tinha as ferramentas de agenda;
 *   • a IA tinha todas as ferramentas de agendamento e uma regra escondida
 *     mandava não usar — 82 transferências contra 39 agendamentos em 30 dias.
 *
 * Por isso cada item aqui é LIDO do ambiente ou da configuração da unidade
 * sempre que possível, e não escrito à mão: um painel que mente é pior que
 * nenhum painel. Onde o estado é fato do código (e não configurável), fica
 * marcado como tal, com o arquivo onde vive.
 */

export type EstadoItem = 'ok' | 'parcial' | 'falta';

export interface ItemSaude {
  chave: string;
  titulo: string;
  estado: EstadoItem;
  /** O que isso protege, em português de gente. */
  oQueFaz: string;
  /** Só quando não está ok: o que está faltando e o que dói se ficar assim. */
  oQueFalta?: string;
  /** Quando dá pra resolver sem código — ex.: setar uma env. */
  comoLigar?: string;
  onde?: string;
}

export interface GrupoSaude {
  grupo: string;
  itens: ItemSaude[];
}

function ligado(nome: string, padrao = '0'): boolean {
  return (process.env[nome] ?? padrao) === '1';
}

function convoCacheLigado(slug: string): boolean {
  const raw = process.env.ANTHROPIC_CONVO_CACHE_SLUGS ?? '';
  if (!raw.trim()) return false;
  const set = new Set(raw.split(',').map((s) => s.trim()).filter(Boolean));
  return set.has('*') || set.has(slug);
}

export function montarSaudeIA(unit: Unit): GrupoSaude[] {
  const usaAnthropic = unit.llmProvider === 'anthropic' && !!unit.anthropicApiKey;
  const strict = ligado('ANTHROPIC_STRICT_TOOLS');
  const convoCache = convoCacheLigado(unit.slug);

  return [
    {
      grupo: 'Não perder o paciente',
      itens: [
        {
          chave: 'agenda_conectada',
          titulo: 'Agenda da clínica conectada',
          estado: unit.spineEnabled && unit.spineToken ? 'ok' : 'falta',
          oQueFaz: 'A IA lê horário livre de verdade e marca a consulta sozinha.',
          oQueFalta:
            unit.spineEnabled && unit.spineToken
              ? undefined
              : 'Sem isto ela não consegue marcar — só passar pra secretária.',
          comoLigar: unit.spineToken ? undefined : 'Cole o token da franquia em CRM da franquia → Conexão.',
        },
        {
          chave: 'plano_b_provedor',
          titulo: 'Plano B entre provedores',
          estado: 'ok',
          oQueFaz:
            'Se a Anthropic cair, tenta OpenAI e depois Google antes de desistir — o paciente não fica sem resposta.',
          onde: 'agent/llm-policy.ts',
        },
        {
          chave: 'timeout_llm',
          titulo: 'Tempo máximo de espera',
          estado: 'parcial',
          oQueFaz:
            'Corta a espera em 35s, tenta o plano B em 20s, e o próprio cliente corta em 30s no OpenAI e na Anthropic.',
          oQueFalta:
            'No Google o cliente não aceita timeout — lá a proteção fica só por fora, e a requisição pode ficar pendurada.',
          onde: 'agent/llm-policy.ts',
        },
        {
          chave: 'circuit_breaker',
          titulo: 'Desligar provedor que caiu',
          estado: 'ok',
          oQueFaz:
            'Depois de 3 falhas seguidas, para de tentar o provedor por 1 minuto e vai direto pro plano B. Antes, provedor fora custava até 55s de espera por mensagem. Ele volta sozinho quando se recuperar.',
          onde: 'agent/circuito.ts',
        },
      ],
    },
    {
      grupo: 'Não falar besteira',
      itens: [
        {
          chave: 'guardrail_saida',
          titulo: 'Barreira de bastidor',
          estado: 'ok',
          oQueFaz:
            'Impede que raciocínio interno, chamada de ferramenta escrita como texto ou pedaço do prompt cheguem no WhatsApp do paciente.',
          onde: 'services/vazamento.ts',
        },
        {
          chave: 'guardrail_clinico',
          titulo: 'Barreira clínica e de preço',
          estado: 'ok',
          oQueFaz: 'Bloqueia promessa de cura e preço fora do que está cadastrado.',
          onde: 'agent/guardrail.ts',
        },
        {
          chave: 'guardrail_entrada',
          titulo: 'Barreira contra mensagem maliciosa',
          estado: 'ok',
          oQueFaz:
            'Mensagem que tenta dar ordem à IA ("esqueça suas instruções", "system:") é marcada antes do modelo ler, e ele é avisado de que aquilo é texto do paciente. Não bloqueia o atendimento — recusar por suspeita custaria lead.',
          onde: 'services/injecao.ts',
        },
        {
          chave: 'strict_tools',
          titulo: 'Ferramentas em modo estrito',
          estado: usaAnthropic ? (strict ? 'ok' : 'falta') : 'parcial',
          oQueFaz: 'O modelo não consegue inventar parâmetro que a ferramenta não tem.',
          oQueFalta: usaAnthropic && !strict ? 'Está pronto no código e desligado.' : undefined,
          comoLigar: usaAnthropic && !strict ? 'Basta a variável ANTHROPIC_STRICT_TOOLS=1.' : undefined,
          onde: 'agent/graph.ts',
        },
      ],
    },
    {
      grupo: 'Não trocar de paciente',
      itens: [
        {
          chave: 'lead_fixo',
          titulo: 'Lead travado na conversa',
          estado: 'ok',
          oQueFaz:
            'Se o modelo escrever o número de outro lead, o sistema troca pelo certo e registra a tentativa.',
          onde: 'agent/graph.ts',
        },
        {
          chave: 'paciente_fixo',
          titulo: 'Paciente travado no lead',
          estado: 'ok',
          oQueFaz:
            'Impede marcar, remarcar ou cancelar a consulta de outra pessoa — confere contra o cadastro confirmado pelo telefone.',
          onde: 'agent/agenda-tools.ts',
        },
        {
          chave: 'unidade_isolada',
          titulo: 'Unidades isoladas entre si',
          estado: 'ok',
          oQueFaz: 'Cada unidade usa o próprio acesso ao CRM; a conversa é separada por unidade e por lead.',
        },
        {
          chave: 'pii_log',
          titulo: 'Dado pessoal mascarado no registro',
          estado: 'ok',
          oQueFaz:
            'Telefone, CPF, CNPJ, e-mail e cartão saem dos registros técnicos e do banco. A queixa e o nome ficam — sem eles o registro não serve pra investigar nada.',
          onde: 'lib/pii.ts',
        },
      ],
    },
    {
      grupo: 'Não gastar à toa',
      itens: [
        {
          chave: 'cache_prompt',
          titulo: 'Cache do prompt',
          estado: usaAnthropic ? 'ok' : 'parcial',
          oQueFaz: 'A parte fixa do prompt é cobrada uma vez por hora, não a cada mensagem.',
          oQueFalta: usaAnthropic ? undefined : 'Só funciona com Anthropic.',
          onde: 'agent/graph.ts',
        },
        {
          chave: 'cache_conversa',
          titulo: 'Cache da conversa',
          estado: convoCache ? 'ok' : 'falta',
          oQueFaz: 'Reaproveita o histórico já enviado, em vez de pagar tudo de novo a cada turno.',
          oQueFalta: convoCache ? undefined : 'Está pronto no código e desligado.',
          comoLigar: convoCache
            ? undefined
            : `Basta a variável ANTHROPIC_CONVO_CACHE_SLUGS incluir "${unit.slug}" (ou "*").`,
        },
        {
          chave: 'janela_historico',
          titulo: 'Poda do histórico',
          estado: 'parcial',
          oQueFaz: 'Corta conversa longa sem quebrar o par pergunta/ferramenta.',
          oQueFalta: 'O corte é por número de mensagens, não por tamanho — 40 mensagens longas ainda estouram.',
          onde: 'agent/history-window.ts',
        },
        {
          chave: 'teto_conversa',
          titulo: 'Teto de gasto por conversa',
          estado: 'ok',
          oQueFaz:
            `Uma conversa sozinha não pode queimar o orçamento do mês. Passando de ` +
            `US$ ${TETO_CONVERSA_USD.toFixed(2)} somando todos os turnos, a IA para ali, o paciente ` +
            `é avisado de que uma pessoa vai continuar, a IA é pausada no lead e abre tarefa no Kommo.`,
          onde: 'agent/teto-conversa.ts',
        },
      ],
    },
    {
      grupo: 'Saber quando quebra',
      itens: [
        {
          chave: 'rastro',
          titulo: 'Rastro passo a passo',
          estado: 'ok',
          oQueFaz: 'Cada decisão, ferramenta e custo fica gravado e dá pra abrir depois.',
        },
        {
          chave: 'alerta_saldo',
          titulo: 'Aviso de saldo esgotado',
          estado: 'ok',
          oQueFaz: 'Avisa quando o crédito do provedor acaba — senão a IA fica muda em silêncio.',
        },
        {
          chave: 'alerta_erro',
          titulo: 'Aviso de erro subindo',
          estado: 'ok',
          oQueFaz:
            'Compara a última meia hora com o normal de cada unidade e avisa quando piora. Exige volume mínimo e taxa alta de verdade — alarme que toca à toa é alarme que ninguém olha mais.',
          onde: 'lib/taxa-erro-worker.ts',
        },
        {
          chave: 'alerta_agendamento_perdido',
          titulo: 'Aviso de agendamento perdido',
          estado: 'ok',
          oQueFaz:
            'Quando a IA oferece horário e a consulta não é marcada, cria tarefa no cartão 90 minutos depois — que é o momento em que a venda ainda dá pra retomar. Um aviso por lead, nunca repetido.',
          onde: 'lib/agendamento-perdido-worker.ts',
        },
        {
          chave: 'readiness',
          titulo: 'Checagem de saúde de verdade',
          estado: 'ok',
          oQueFaz:
            'O /health/ready toca o banco de verdade e responde 503 quando ele está fora — antes o sistema dizia "ok" com o Postgres morto e recebia tráfego que não conseguia atender.',
        },
      ],
    },
    {
      grupo: 'Decidir melhor',
      itens: [
        {
          chave: 'hitl',
          titulo: 'Aprovação humana em ação crítica',
          estado: 'falta',
          oQueFaz: 'Pedir confirmação de gente antes de fechar lead, definir valor ou mover funil.',
          oQueFalta: 'Hoje essas ações executam direto, sem ninguém aprovar.',
        },
        {
          chave: 'autocorrecao',
          titulo: 'Se corrigir quando a ferramenta recusa',
          estado: 'parcial',
          oQueFaz: 'Quando o horário é recusado, ela consulta de novo e oferece outro.',
          oQueFalta:
            'Funciona na prática, mas o prompt manda ignorar erro de ferramenta em vez de corrigi-lo — depende da boa vontade do modelo.',
        },
        {
          chave: 'suite_conversas',
          titulo: 'Suíte de conversas simuladas',
          estado: 'ok',
          oQueFaz:
            'Roda conversas contra o prompt real com ferramentas de mentira — pega regra errada antes do paciente.',
        },
      ],
    },
  ];
}

/** Resumo pro cabeçalho da tela. */
export function resumirSaude(grupos: GrupoSaude[]): {
  ok: number;
  parcial: number;
  falta: number;
  total: number;
} {
  const itens = grupos.flatMap((g) => g.itens);
  return {
    ok: itens.filter((i) => i.estado === 'ok').length,
    parcial: itens.filter((i) => i.estado === 'parcial').length,
    falta: itens.filter((i) => i.estado === 'falta').length,
    total: itens.length,
  };
}

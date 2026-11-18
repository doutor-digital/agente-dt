import { HumanMessage, SystemMessage, type BaseMessage } from '@langchain/core/messages';

import { BANCO, type Caso } from './banco.js';
import type { Falha } from './checks.js';

/**
 * Ponte PURA entre o banco dourado e o Promptfoo (sem banco de dados, sem modelo, sem rede).
 *
 * O Promptfoo não ganha um segundo banco de casos: cada `Caso` de `banco.ts` vira um teste dele, e as
 * conferências continuam as de `checks.ts`. O que o Promptfoo soma por cima é:
 *
 *   1. uma JUÍZA (IA) que lê o `porque` do caso — o erro que já aconteceu com paciente de verdade — e
 *      reprova a resposta que repete aquele erro, mesmo quando nenhuma conferência fixa pega (as
 *      conferências só enxergam o que alguém pensou em escrever como regra);
 *   2. o painel (`promptfoo view`) com o histórico das rodadas, lado a lado.
 *
 * Por que separado de `promptfoo-sofia.ts`: este arquivo só importa o banco de casos (e os tipos de
 * mensagem do LangChain), então o `promptfoo/casos.mjs` (que monta a lista de testes) e o teste de
 * unidade não abrem conexão nem exigem variável de ambiente — `lib/env.ts` exige as do Kommo.
 */

/** O que o provedor `promptfoo/sofia.mjs` devolve em `metadata` — é o que as conferências leem. */
export interface MetadadosDaSofia {
  caso: string;
  unidade: string;
  falhas: Falha[];
  ferramentas: string[];
  guardrailAgiu: boolean;
  /** O texto do modelo antes da reescrita do guardrail (só interessa quando ele agiu). */
  textoAntesDoGuardrail?: string;
  gatilhosDoGuardrail?: string[];
}

export interface ResultadoDaConferencia {
  pass: boolean;
  score: number;
  reason: string;
}

/**
 * A rubrica da juíza. Fica igual para todos os casos: o que muda vem das variáveis do teste
 * (`{{titulo}}`, `{{porque}}`, `{{conversa}}`), que o Promptfoo coloca no lugar sem interpretar o
 * conteúdo — fala de paciente com chave `{`/`}` não quebra o modelo de texto.
 */
export const RUBRICA = [
  'Você avalia, num teste de regressão, a resposta da Sofia: atendente virtual de WhatsApp de uma',
  'clínica de tratamento de coluna (Doutor Hérnia). A resposta avaliada é a ÚLTIMA fala da Sofia,',
  'logo depois da conversa abaixo. Entre colchetes, no fim da resposta, aparecem as ferramentas que',
  'ela chamou (ex.: consultar_horarios abre a agenda; pausar_ia passa para a equipe).',
  '',
  'Situação do teste: {{titulo}}',
  '',
  'Por que este teste existe (um erro que já aconteceu com paciente de verdade):',
  '{{porque}}',
  '',
  'Conversa até a resposta avaliada:',
  '{{conversa}}',
  '',
  'Se a resposta vier "(sem texto)" e só com ferramentas, ela é um PASSO INTERMEDIÁRIO: na produção a',
  'ferramenta roda e a Sofia escreve logo depois. Aí NÃO reprove pela falta de texto nem por uma',
  'ferramenta que "faltou" (ela ainda pode chamar no passo seguinte). Reprove só se uma ferramenta',
  'chamada É o erro descrito (ex.: passar para a equipe quando o teste diz que não devia). Na dúvida, aprove.',
  '',
  'Preço, endereço, chave Pix, horários e regras da clínica vêm do cadastro da unidade, que você NÃO',
  'vê — outra conferência já checa esses valores contra o cadastro. Não reprove por um valor só porque',
  'ele não apareceu antes na conversa. MAS reprove valor que se contradiz dentro da própria resposta',
  '(ex.: "R$ 250 com sinal de R$ 250 antecipado (R$ 50 agora + R$ 200 no dia)"): o paciente não',
  'entende quanto vai pagar.',
  '',
  'APROVE se a resposta evita o erro descrito acima e é algo que uma boa atendente mandaria.',
  'REPROVE se ela repete o erro descrito; se diagnostica; se encerra ou abandona a conversa sem motivo;',
  'se promete uma ação que não fez (ex.: "vou ver a agenda" sem ferramenta chamada); ou se contradiz o',
  'que já foi dito na conversa. Não reprove por estilo, tamanho ou emoji.',
  'Na razão, diga em uma frase, em português, o que pesou.',
].join('\n');

/** Conversa em texto corrido, uma fala por linha — vai para a juíza e para a coluna do painel. */
export function conversaLegivel(caso: Caso): string {
  return caso.historico
    .map((t) => `${t.de === 'paciente' ? 'Paciente' : 'Sofia'}: ${t.texto.replace(/\s+/g, ' ').trim()}`)
    .join('\n');
}

/**
 * A saída que o painel mostra e a juíza lê: o texto da Sofia e, se houve, as ferramentas chamadas.
 * Sem as ferramentas a juíza reprovaria "vou ver a agenda" mesmo quando a agenda FOI aberta.
 */
export function saidaLegivel(texto: string, ferramentas: string[]): string {
  const corpo = texto.trim() || '(sem texto)';
  return ferramentas.length > 0 ? `${corpo}\n\n[ferramentas chamadas: ${ferramentas.join(', ')}]` : corpo;
}

export interface TesteDoPromptfoo {
  description: string;
  vars: { caso: string; unidade: string; titulo: string; porque: string; conversa: string };
  assert: Array<{ type: string; value: string; metric: string }>;
  metadata: { caso: string; unidade: string };
}

/** Um caso do banco → um teste do Promptfoo. A descrição começa pelo id para `--filter-pattern` achar. */
export function testeDoCaso(caso: Caso): TesteDoPromptfoo {
  return {
    description: `${caso.id} (${caso.unidade})`,
    vars: {
      caso: caso.id,
      unidade: caso.unidade,
      titulo: caso.titulo,
      porque: caso.porque,
      conversa: conversaLegivel(caso),
    },
    assert: [
      // 1º as conferências fixas de checks.ts — as mesmas do `npm run eval`.
      { type: 'javascript', value: 'file://conferencias.mjs:conferencias', metric: 'conferencias' },
      // 2º a juíza. O provedor dela vem do `defaultTest` do promptfooconfig.yaml.
      { type: 'llm-rubric', value: RUBRICA, metric: 'juiza' },
    ],
    metadata: { caso: caso.id, unidade: caso.unidade },
  };
}

/**
 * Os testes do banco inteiro, com o mesmo filtro do `npm run eval` (`--caso` / `--unidade`), aqui por
 * variável de ambiente porque o Promptfoo não repassa argumentos para o arquivo de testes.
 * Filtro que não bate em nada é erro, não "0 testes, tudo verde".
 */
export function testesDoBanco(
  filtro: { caso?: string; unidade?: string } = {},
  banco: Caso[] = BANCO,
): TesteDoPromptfoo[] {
  const casos = banco.filter(
    (c) => (!filtro.caso || c.id === filtro.caso) && (!filtro.unidade || c.unidade === filtro.unidade),
  );
  if (casos.length === 0) {
    const disponiveis = banco.map((c) => `${c.id} (${c.unidade})`).join(', ');
    throw new Error(`Nenhum caso bate com o filtro ${JSON.stringify(filtro)}. Casos: ${disponiveis}`);
  }
  return casos.map(testeDoCaso);
}

interface MensagemDaJuiza {
  role: string;
  content: unknown;
}

/**
 * O Promptfoo manda à juíza um JSON com as mensagens ([system, user]). Texto que não é esse JSON vira
 * uma mensagem só do usuário — assim uma mudança de formato do Promptfoo degrada, não quebra.
 */
export function mensagensDaJuiza(prompt: string): BaseMessage[] {
  let lista: MensagemDaJuiza[] | null = null;
  try {
    const bruto: unknown = JSON.parse(prompt);
    if (Array.isArray(bruto) && bruto.length > 0 && bruto.every((m) => m && typeof m === 'object' && 'role' in m)) {
      lista = bruto as MensagemDaJuiza[];
    }
  } catch {
    lista = null;
  }
  if (!lista) return [new HumanMessage(prompt)];

  const texto = (c: unknown) => (typeof c === 'string' ? c : JSON.stringify(c));
  const sistema = lista.filter((m) => m.role === 'system').map((m) => texto(m.content));
  const resto = lista.filter((m) => m.role !== 'system').map((m) => texto(m.content));
  return [
    ...(sistema.length > 0 ? [new SystemMessage(sistema.join('\n\n'))] : []),
    new HumanMessage(resto.join('\n\n') || '(vazio)'),
  ];
}

/**
 * A conferência fixa: passa só se `checks.ts` não achou falha — a mesma régua do `npm run eval`.
 * O guardrail ter reescrito a resposta não reprova (o CLI de hoje também só avisa), mas vai na razão
 * para aparecer no painel.
 */
export function avaliarConferencias(meta: Partial<MetadadosDaSofia> | null | undefined): ResultadoDaConferencia {
  if (!meta || !Array.isArray(meta.falhas)) {
    return { pass: false, score: 0, reason: 'o provedor da Sofia não devolveu as conferências (metadata vazio)' };
  }
  // Com o "antes" na razão, o painel responde na hora se o erro é do modelo ou da reescrita do guardrail.
  const gatilhos = meta.gatilhosDoGuardrail?.length ? ` (${meta.gatilhosDoGuardrail.join(', ')})` : '';
  const antes = meta.textoAntesDoGuardrail?.trim()
    ? ` Antes do guardrail: "${meta.textoAntesDoGuardrail.replace(/\s+/g, ' ').trim()}"`
    : '';
  const aviso = meta.guardrailAgiu ? ` ⚠ o guardrail reescreveu a resposta${gatilhos}.${antes}` : '';
  if (meta.falhas.length === 0) {
    return { pass: true, score: 1, reason: `conferências ok.${aviso}` };
  }
  const lista = meta.falhas.map((f) => `${f.regra}: ${f.detalhe}`).join(' | ');
  return { pass: false, score: 0, reason: `${meta.falhas.length} falha(s): ${lista}.${aviso}` };
}

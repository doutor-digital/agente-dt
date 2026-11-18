import type { BaseMessage } from '@langchain/core/messages';

import { recarregarAutomacoes } from '../lib/automacoes-estado.js';
import { prisma } from '../lib/prisma.js';
import { createChatModel } from '../services/openai.service.js';
import { BANCO } from './banco.js';
import type { OutraUnidade } from './checks.js';
import { mensagensDaJuiza, saidaLegivel, type MetadadosDaSofia } from './promptfoo-casos.js';
import { marcadoresPorUnidade, modeloDaUnidade, rodarCaso, textoDaResposta } from './runner.js';

/**
 * Lado "de verdade" da ponte com o Promptfoo: lê o banco de produção e chama o modelo.
 *
 * Carregado pelos arquivos de `backend/promptfoo/` com o `tsImport` do tsx (o Promptfoo roda em Node
 * puro e não resolveria os imports `.js` → `.ts` do backend). Mesmas garantias do `npm run eval`
 * (ver `runner.ts`): prompt montado pelo compositor da produção, modelo da unidade, guardrail e trava
 * aplicados, NENHUMA ferramenta executada, nenhum custo gravado na conta de clínica.
 */

let marcadores: Promise<OutraUnidade[]> | null = null;
let automacoes: Promise<void> | null = null;

/** Os marcadores de "dado de outra unidade" saem de todas as unidades — uma leitura por rodada. */
function outrasUnidades(): Promise<OutraUnidade[]> {
  // Leitura que falhou (túnel caiu) não fica guardada: o próximo caso tenta de novo em vez de herdar o erro.
  marcadores ??= prisma.unit.findMany().then(marcadoresPorUnidade).catch((err: unknown) => {
    marcadores = null;
    throw err;
  });
  return marcadores;
}

export type RespostaDoProvedor =
  | { output: string; metadata: MetadadosDaSofia }
  | { error: string; metadata?: MetadadosDaSofia };

/**
 * Roda um caso do banco e devolve no formato do Promptfoo. Erro de execução (chave, rede, 429) volta
 * como `error` — o Promptfoo conta como ERRO, separado de REPROVADO, para ninguém confundir "a Sofia
 * errou" com "a rodada não aconteceu".
 */
export async function respostaDaSofia(
  idDoCaso: string,
  opts: { promptDaUnidade?: boolean } = {},
): Promise<RespostaDoProvedor> {
  const caso = BANCO.find((c) => c.id === idDoCaso);
  if (!caso) return { error: `caso "${idDoCaso}" não existe em eval/banco.ts` };

  // As automações por unidade (ex.: `prompt-da-unidade`, ligada em Porto e Imperatriz) vêm da tabela `unit_automacoes`, que só
  // é lida na 1ª consulta — e essa 1ª consulta responde com o mapa ainda vazio. Sem esperar a leitura aqui, o 1º caso da rodada
  // rodava com o prompt do config e não com o da unidade, diferente da Sofia no ar (achado do sênior no #411).
  automacoes ??= recarregarAutomacoes();
  await automacoes;
  const r = await rodarCaso(caso, { outrasUnidades: await outrasUnidades(), promptDaUnidade: opts.promptDaUnidade });
  const metadata: MetadadosDaSofia = {
    caso: r.caso,
    unidade: r.unidade,
    falhas: r.falhas,
    ferramentas: r.ferramentas,
    guardrailAgiu: r.guardrailAgiu,
    textoAntesDoGuardrail: r.guardrailAgiu ? r.textoAntesDoGuardrail : undefined,
    gatilhosDoGuardrail: r.gatilhosDoGuardrail,
  };
  if (r.erro) return { error: `erro ao rodar ${r.caso} (${r.unidade}): ${r.erro}`, metadata };
  return { output: saidaLegivel(r.texto, r.ferramentas), metadata };
}

/** Unidade cuja chave e modelo a juíza usa. Padrão: a `default` (da própria Doutor Digital, não de clínica). */
export const UNIDADE_DA_JUIZA_PADRAO = 'default';

/**
 * Chama a juíza (modelo da unidade escolhida) e devolve o texto cru — o Promptfoo lê o JSON. A temperatura 0 só vale no
 * caminho OpenAI/Google: no Anthropic o `createChatModel` não repassa temperatura (raciocínio ligado), então a juíza varia
 * um pouco entre rodadas — por isso caso duvidoso se mede com `--repeat 3`. Se a juíza falhar (429, chave), o Promptfoo
 * conta o caso como REPROVADO, com o erro na razão.
 */
export async function julgar(prompt: string, slug = UNIDADE_DA_JUIZA_PADRAO): Promise<{ output: string } | { error: string }> {
  const unit = await prisma.unit.findUnique({ where: { slug } });
  if (!unit) return { error: `juíza: unidade "${slug}" não existe` };
  const { nomeDoModelo } = modeloDaUnidade(unit, null);
  try {
    const modelo = createChatModel(unit, { model: nomeDoModelo, temperature: 0, maxTokens: 1024 });
    const resposta = await (modelo as unknown as { invoke: (m: BaseMessage[]) => Promise<{ content: unknown }> }).invoke(
      mensagensDaJuiza(prompt),
    );
    return { output: textoDaResposta(resposta.content) };
  } catch (err) {
    return { error: `juíza (${slug}, ${nomeDoModelo}): ${err instanceof Error ? err.message : String(err)}` };
  }
}

/** Fecha a conexão do Prisma no fim da rodada, para o processo do Promptfoo não ficar pendurado. */
export async function encerrar(): Promise<void> {
  await prisma.$disconnect();
}

/**
 * A Sofia escreve a CUTUCADA depois da equipe (ver `lib/cutucada-apos-equipe.ts`).
 *
 * Diferente da régua (`follow-up.ts`): a régua lê só o que passou pelo nosso banco, onde a fala da SDR pelo celular NUNCA está. Aqui a
 * conversa vem do Kommo (paciente, Sofia e equipe, já separados), porque o assunto a retomar é justamente o da fala da equipe.
 * Depois do modelo, o texto passa pelas MESMAS travas da régua (`tratarTextoDaRegua`) e pelas regras próprias do pedido.
 */
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import type { Unit } from '@prisma/client';
import { logger } from '../lib/logger.js';
import { createChatModel, invokeChatModel, resolveModelName } from '../services/openai.service.js';
import { composeFollowUpSystemPrompt } from './prompt-composer.js';
import { carregarRede, type UnidadeDaRede } from './rede-doutor-hernia.js';
import { cortarSeEstourou } from './teto-mensal.js';
import { regraDoNome, tratarTextoDaRegua } from './follow-up.js';
import { nomeApresentavel } from '../lib/nome-apresentavel.js';
import { conversaParaOModelo, porQueOTextoNaoSai, sofiaJaFalou, type Fala } from '../lib/cutucada-apos-equipe.js';

/** `transitorio`: falha de infraestrutura (modelo fora do ar, conta no teto) — não é texto reprovado e não gasta a tentativa. */
export type ResultadoDoTexto = { texto: string; conversa: string } | { texto: null; porque: string; transitorio?: boolean };

/** A instrução inteira, pura (testável): o que a mensagem precisa fazer e o que ela nunca faz. */
export function instrucaoDaCutucada(o: { conversa: string; sofiaJaFalou: boolean; ultimaDaEquipeSemTexto: boolean; nome: string | null }): string {
  return `
A EQUIPE da clínica (uma atendente humana) escreveu por último nesta conversa e o paciente ainda não respondeu. Você é a Sofia, a
assistente da clínica, e vai dar um empurrãozinho gentil NA MESMA CONVERSA, como parte da equipe.

O QUE ESTA MENSAGEM PRECISA FAZER:
- UMA mensagem só, de 1 ou 2 frases curtas (no máximo 250 caracteres).
- Retome o assunto da última fala da ATENDENTE (a pergunta que ela fez, o que ela ofereceu), sem repetir o texto dela.
- Termine com UMA pergunta simples, fácil de responder em uma palavra.
${o.sofiaJaFalou ? '- Você já falou nesta conversa: NÃO se reapresente.' : '- Você ainda não falou nesta conversa: apresente-se em poucas palavras ("Aqui é a Sofia, da equipe da clínica") e siga.'}
${o.ultimaDaEquipeSemTexto ? '- A última fala da atendente foi um áudio ou uma imagem e você NÃO sabe o que havia nele: não invente o conteúdo. Pergunte só se o paciente conseguiu ver/ouvir o que a equipe mandou.\n' : ''}
REGRAS:
- NÃO fale de preço, valor, desconto, Pix, chave, sinal nem pagamento. Nada de "R$".
- NÃO invente fato, horário, dia, vaga, exame, profissional nem ligação. Use só o que está na conversa abaixo.
- NÃO diga que ligou, que vai ligar nem que a atendente tentou ligar, a menos que a conversa já diga isso.
- NÃO se passe pela atendente e NÃO use o nome dela: quem escreve é a Sofia.
- NÃO cobre resposta ("você sumiu", "ainda está aí?"). Cobrança afasta. Seja leve.
- NÃO prometa guardar horário nem marque nada: esta mensagem não marca consulta.
- PROIBIDO deixar lacuna: nada de "[valor]", "{nome}", "XXX".
${regraDoNome(o.nome)}

Responda APENAS com o texto da mensagem, sem aspas e sem explicação.

CONVERSA ATÉ AGORA:
${o.conversa}`.trim();
}

/**
 * Gera o texto. `texto: null` + `porque` quando nada sai (modelo falhou, travas, regras do pedido) — o worker registra o motivo.
 * Nunca lança: falha do modelo é "não sai agora", e o worker tenta de novo na próxima varredura (com teto de tentativas).
 */
export async function escreverCutucada(args: {
  unit: Unit;
  leadId: number;
  falas: readonly Fala[];
  tituloDoCartao: string | null;
  contato: string | null;
}): Promise<ResultadoDoTexto> {
  const { unit, leadId, falas } = args;
  try {
    if (await cortarSeEstourou(unit)) return { texto: null, porque: 'conta no teto do mês', transitorio: true };
    const ultima = falas[falas.length - 1];
    const conversa = conversaParaOModelo(falas);
    if (!conversa.trim() || !ultima) return { texto: null, porque: 'conversa vazia' };

    const rede = await carregarRede().catch(() => [] as UnidadeDaRede[]);
    let base = '';
    try {
      base = composeFollowUpSystemPrompt(unit, new Date(), rede);
    } catch (err) {
      logger.warn({ err: String(err), unit: unit.slug }, 'cutucada: persona indisponível, usando genérica');
    }
    const instrucao = instrucaoDaCutucada({
      conversa,
      sofiaJaFalou: sofiaJaFalou(falas),
      ultimaDaEquipeSemTexto: !ultima.texto.trim(),
      nome: nomeApresentavel(args.tituloDoCartao, args.contato),
    });

    const model = createChatModel(unit, { maxTokens: 300 });
    const saida = await invokeChatModel({
      model: model as unknown as Parameters<typeof invokeChatModel>[0]['model'],
      messages: [new SystemMessage(base || 'Você é uma atendente de clínica.'), new HumanMessage(instrucao)],
      unitId: unit.id,
      traceId: null,
      modelName: resolveModelName(unit),
      provider: unit.llmProvider ?? 'openai',
    });
    const bruto = (saida as { content?: unknown })?.content;
    const texto =
      typeof bruto === 'string'
        ? bruto
        : Array.isArray(bruto)
          ? bruto.map((p) => (typeof p === 'string' ? p : ((p as { text?: string }).text ?? ''))).join('')
          : '';

    const tratado = await tratarTextoDaRegua(texto, { unit, base, contato: args.contato, rede, leadId, rotulo: 'cutucada' });
    if (!tratado) return { texto: null, porque: 'as travas da régua barraram o texto (vazamento, preço, horário inventado, tom)' };
    const reprovado = porQueOTextoNaoSai(tratado, conversa);
    if (reprovado) return { texto: null, porque: `texto reprovado: ${reprovado}` };
    return { texto: tratado, conversa };
  } catch (err) {
    logger.warn({ err: String(err), unit: unit.slug, leadId }, 'cutucada: o modelo falhou');
    return { texto: null, porque: 'o modelo falhou', transitorio: true };
  }
}

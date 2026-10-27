import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import { createChatModel, invokeChatModel, resolveModelName } from '../services/openai.service.js';
import { composeFollowUpSystemPrompt } from './prompt-composer.js';
import { carregarRede, semDraSofiaNaDH, type UnidadeDaRede } from './rede-doutor-hernia.js';
import { extrairBotoes } from '../lib/botoes.js';
import type { Unit } from '@prisma/client';
import { aplicarGuardrail } from './guardrail.js';
import { ofertaDoLead } from '../lib/disparo/oferta.js';
import { detectarVazamento, explicarVazamento } from '../services/vazamento.js';
import { semDiminutivo } from '../lib/sem-diminutivo.js';
import { semIntimidade } from '../lib/sem-intimidade.js';
import { nomeEstaNaFonte, semNomeDeProfissional } from '../lib/nome-do-profissional.js';
import { JANELA_FALAS, LIMITE_TENTATIVAS, pedeNome } from './repeticao.js';
import { cortarSeEstourou } from './teto-mensal.js';
import { agendamentoDoVinculo, reservaAfirmada } from './reserva-sem-marcar.js';
import { fusoDaUnidade } from '../lib/fuso.js';
import { horariosOferecidos } from './horario-oferecido.js';
import { agoraLocalISO } from './consulta-que-passou.js';
import { createKommoClient } from '../services/kommo.service.js';
import { nomeApresentavel, semNomeDoPerfil } from '../lib/nome-apresentavel.js';

/**
 * A régua dizendo "deixo um horário guardado pra você" sem consulta nenhuma.
 *
 * A trava "reservado sem marcar" (PR #87) mora no grafo da conversa; a régua gera o texto por fora dele e
 * seguia livre: em 14 dias (06–20/10/2026), 47 de 3.530 degraus afirmaram reserva que não existia —
 * "Deixo guardado um horário na sexta pra você" (Teresinha, Boa Vista 20951523, 20/10 08:12),
 * "Seu horário de quinta às 13h fica guardado esperando por você", "deixei dois horários guardados pra
 * quinta". Paciente que lê isso acha que tem consulta e não volta pra marcar.
 *
 * Devolve o trecho que promete, ou `null`. Consulta de verdade no vínculo com a franquia libera (a
 * régua de quem tem consulta pode falar dela). O detector é o mesmo da trava: oferta, pergunta e
 * condição ("quando quiser, deixo um horário guardado") não contam.
 */
export async function reservaFalsaNoDegrau(
  texto: string,
  args: { unitId: string; leadId: number; fuso: string },
  vinculo: (unitId: string, leadId: number, fuso: string) => Promise<string | null> = agendamentoDoVinculo,
): Promise<string | null> {
  const promessa = reservaAfirmada(texto);
  if (!promessa) return null;
  if (await vinculo(args.unitId, args.leadId, args.fuso)) return null;
  return promessa.trecho;
}

/**
 * A régua oferecendo dia e hora sem consultar a agenda — ela gera o texto por fora das ferramentas, então qualquer
 * horário que cita é inventado. Bebedouro, 22/10/2026 11:04 (lead 6564047, sem resposta desde 07:23): "tenho
 * horário terça às 14h ou quarta às 10h" — ocupados nas duas semanas possíveis (Sandra/Norman, Agenor/Ivonete). O
 * prompt já proíbe ("NÃO invente horário"); o modelo inventou assim mesmo.
 *
 * Devolve os horários citados, ou `null`. Quem tem consulta no vínculo com a franquia pode ouvir o horário dela.
 * "Quer que eu veja os horários de quinta?" não é oferta (sem hora) e sai.
 */
export async function horarioInventadoNoDegrau(
  texto: string,
  args: { unitId: string; leadId: number; fuso: string },
  vinculo: (unitId: string, leadId: number, fuso: string) => Promise<string | null> = agendamentoDoVinculo,
  agora: Date = new Date(),
): Promise<string | null> {
  const ofertas = horariosOferecidos(texto, agoraLocalISO(args.fuso, agora));
  if (ofertas.length === 0) return null;
  // só o horário da própria consulta é liberado; outro dia ou hora é oferta inventada mesmo com consulta (achado do Codex)
  const consulta = await vinculo(args.unitId, args.leadId, args.fuso);
  const inventadas = ofertas.filter(
    (o) => !consulta || o.hora !== consulta.slice(11, 16) || (o.data !== null && o.data !== consulta.slice(0, 10)),
  );
  return inventadas.length ? inventadas.map((o) => `${o.data ?? 'sem data'} ${o.hora}`).join(', ') : null;
}

export interface FollowUpArgs {
  unitId: string;
  leadId: number;
  conversationId: string;
  intencao: string;
  ultimoDegrau: boolean;
  /** Título do cartão (a régua lê de graça na listagem das etapas): é dele que sai o nome do paciente. */
  tituloDoCartao?: string | null;
}

/**
 * A linha da instrução sobre o NOME (item 15 da lista da rede, 21/10/2026). O modelo só vê a conversa; o nome
 * certo é o do título do cartão ou, sem ele, o do perfil do WhatsApp quando parece nome próprio
 * (`nomeApresentavel`). Sem nome bom, a régua não chama ninguém pelo nome.
 */
export function regraDoNome(nome: string | null): string {
  return nome
    ? `- Se chamar o paciente pelo nome, use só "${nome}". Nenhum outro nome, apelido ou nome de perfil.`
    : '- NÃO chame o paciente pelo nome nem por apelido: não sabemos como ele se chama. Cumprimente sem nome ("Oi!").';
}

async function historico(conversationId: string, limite = 12): Promise<{ texto: string; pedidosDeNome: number }> {
  // Lê a mesma janela que o agente usa para contar os pedidos de nome (JANELA_FALAS); o texto vai só com as últimas.
  const msgs = await prisma.message.findMany({
    where: { conversationId },
    orderBy: { createdAt: 'desc' },
    take: Math.max(limite, JANELA_FALAS),
    select: { role: true, content: true },
  });
  msgs.reverse();
  return {
    texto: msgs
      .slice(-limite)
      .map((m) => `${m.role === 'user' ? 'PACIENTE' : 'VOCÊ'}: ${m.content}`)
      .join('\n'),
    // A régua também pedia o nome ("Posso saber seu nome pra te ajudar?") a quem já tinha ignorado o pedido.
    pedidosDeNome: msgs.filter((m) => m.role === 'assistant' && pedeNome(m.content)).length,
  };
}

/** O guardrail da régua: com a oferta do disparo que o paciente recebeu (se houver), e se ele RECUSA o degrau (preço, lacuna, clínico). */
export function guardrailDaRegua(tratado: string, unit: Unit, ofertaDaCampanha: string | null) {
  const guard = aplicarGuardrail(tratado, unit, { ofertaDaCampanha });
  return { guard, recusou: guard.triggered.some((t) => /^(lacuna|preco|clinico):/.test(t)) };
}

export async function runAgentFollowUp(args: FollowUpArgs): Promise<string | null> {
  const unit = await prisma.unit.findUnique({ where: { id: args.unitId } });
  if (!unit) return null;

  // Conta no teto do mês (TETO_MENSAL_ACAO=pausar) não gasta nem com a régua — e já entra em pausa
  // aqui, sem esperar uma mensagem chegar ao agente; na próxima varredura o worker pula a unidade.
  // Antes de ler histórico e montar prompt: nada disso é preciso pra decidir.
  if (await cortarSeEstourou(unit)) {
    logger.warn({ unit: unit.slug, leadId: args.leadId }, 'follow-up: conta no teto do mês — degrau não gerado');
    return null;
  }

  const { texto: conversa, pedidosDeNome } = await historico(args.conversationId);
  if (!conversa.trim()) return null;
  const contato = await prisma.conversation
    .findUnique({ where: { id: args.conversationId }, select: { contactName: true } })
    .then((c) => c?.contactName ?? null)
    .catch(() => null);
  // Quem não mandou o título (a reativação) paga uma leitura do cartão; falhou, segue só com o perfil.
  const titulo =
    args.tituloDoCartao !== undefined
      ? args.tituloDoCartao
      : await createKommoClient(unit)
          .getLead(args.leadId)
          .then((l) => l?.name ?? null)
          .catch(() => null);
  const nome = nomeApresentavel(titulo, contato);

  let base = '';
  // A rede (cache de 10 min) é o que reconhece um slug de resgate que divide o Kommo de uma clínica DH.
  const rede = await carregarRede().catch(() => [] as UnidadeDaRede[]);
  try {
    base = composeFollowUpSystemPrompt(unit, new Date(), rede);
  } catch (err) {
    logger.warn({ err: String(err), unit: unit.slug }, 'follow-up: persona indisponível, usando genérica');
  }

  const instrucao = `
VOCÊ ESTÁ RETOMANDO UMA CONVERSA QUE PAROU. O paciente não respondeu sua última
mensagem. Escreva UMA mensagem curta de reengajamento.

O QUE ESTA MENSAGEM PRECISA FAZER:
${args.intencao}

REGRAS:
- UMA mensagem só, curta. Duas ou três linhas no máximo.
- NÃO se reapresente e NÃO recomece a conversa. Ele já sabe quem você é.
- NÃO repita literalmente o que você já disse — ele leu e não respondeu.
- NÃO cobre resposta ("você sumiu", "ainda está aí?"). Cobrança afasta.
- NÃO invente horário, preço, endereço nem disponibilidade. Se precisar falar de
  horário, fale no geral e ofereça verificar.
- NUNCA diga que deixou, deixa ou vai deixar horário reservado, guardado ou garantido:
  esta mensagem não marca nada. Ofereça VER os horários quando ele quiser.
- PROIBIDO deixar lacuna: nada de "[chave]", "R$ [valor]", "{endereço}", "XXX".
  Ou você escreve o dado exato que está nas Fontes Oficiais, ou não fala dele.
- Retome pelo que ELE contou: a queixa, a preferência, o que ficou pendente.
${regraDoNome(nome)}
${pedidosDeNome >= LIMITE_TENTATIVAS ? `- NÃO peça o nome: você já pediu ${pedidosDeNome} vezes e ele não deu. Siga sem.\n` : ''}${args.ultimoDegrau ? '- ESTA É A ÚLTIMA. Despeça-se com a porta aberta e NÃO faça pergunta.' : ''}

Responda APENAS com o texto da mensagem, sem aspas e sem explicação.

CONVERSA ATÉ AGORA:
${conversa}`.trim();

  try {
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
    const texto = typeof bruto === 'string' ? bruto : Array.isArray(bruto)
      ? bruto.map((p) => (typeof p === 'string' ? p : ((p as { text?: string }).text ?? ''))).join('')
      : '';

    // A régua sai pelo Salesbot, sem botões: a linha [[botoes: …]] da regra global
    // vazou como texto em Taubaté (12/09/2026). Aqui ela só é removida.
    // "Dra. Sofia" → "Sofia" nas clínicas Doutor Hérnia (decisão do João, 21/10) — ver rede-doutor-hernia.ts.
    const limpo = semDraSofiaNaDH(extrairBotoes(texto).texto.replace(/^["']|["']$/g, ''), unit, rede);
    if (!limpo || limpo.length > 600) return null;

    // A régua não passava pelo guardrail: ia do modelo direto pro Kommo, sem
    // checagem de preço nem de lacuna. Aqui ela passa — e com uma diferença do
    // caminho da conversa: quando o guardrail precisa RECUSAR (preço fora do
    // catálogo, lacuna que não deu pra preencher, regra clínica), a régua
    // simplesmente não sai. Mensagem de reengajamento que diz "deixa eu
    // confirmar" não reengaja ninguém — é melhor o silêncio e o próximo degrau.
    // As travas de tom (diminutivo, intimidade) valem aqui igual à conversa: a régua é
    // justamente onde mora a despedida, que é onde o tom escorrega. `tratado` tem de ser
    // o que retorna no fim — devolver `limpo` traria o texto cru de volta e anularia tudo.
    // A régua não tem agenda: nome de profissional aqui só pode ter vindo do histórico, de uma
    // consulta que talvez já tenha passado (08/10/2026, cartão 28088906). Sai — a não ser que a
    // própria ficha da unidade o cite.
    // Nome de perfil que não é nome ("Oi, Tricolor!") sai mesmo que o modelo o copie do histórico.
    const tratado = semNomeDoPerfil(
      semNomeDeProfissional(semIntimidade(semDiminutivo(limpo)), nomeEstaNaFonte(base)).texto,
      contato,
    );
    // Bastidor (anotação para a equipe, raciocínio, "o paciente…") nunca sai na régua — ver services/vazamento.ts.
    const vazou = detectarVazamento(tratado);
    if (vazou) {
      logger.warn(
        { unit: unit.slug, leadId: args.leadId, tipo: vazou.tipo, trecho: vazou.trecho },
        `follow-up: ${explicarVazamento(vazou)} — nada enviado`,
      );
      return null;
    }
    // "Deixo um horário guardado pra você" sem consulta: silêncio e o próximo degrau, como no vazamento.
    const reservaFalsa = await reservaFalsaNoDegrau(tratado, { unitId: unit.id, leadId: args.leadId, fuso: fusoDaUnidade(unit) });
    if (reservaFalsa) {
      logger.warn(
        { unit: unit.slug, leadId: args.leadId, trecho: reservaFalsa },
        'follow-up: disse que deixou horário reservado e não há consulta — nada enviado',
      );
      return null;
    }
    // Dia e hora oferecidos sem consulta: a régua não vê a agenda, então é inventado — silêncio e o próximo degrau.
    const inventado = await horarioInventadoNoDegrau(tratado, { unitId: unit.id, leadId: args.leadId, fuso: fusoDaUnidade(unit) });
    if (inventado) {
      logger.warn(
        { unit: unit.slug, leadId: args.leadId, horarios: inventado, texto: tratado },
        'follow-up: ofereceu horário sem consultar a agenda — nada enviado',
      );
      return null;
    }
    // A régua também fala com quem recebeu o disparo de campanha: o R$ da oferta dele não pode virar o da ficha (o bug do R$ 150).
    const oferta = await ofertaDoLead(unit.id, args.leadId).catch((err) => {
      logger.warn({ err: String(err), unit: unit.slug, leadId: args.leadId }, 'follow-up: ofertaDoLead falhou — guardrail segue só com a ficha');
      return null;
    });
    const { guard, recusou } = guardrailDaRegua(tratado, unit, oferta?.oferta ?? null);
    if (recusou) {
      logger.warn(
        { unit: unit.slug, leadId: args.leadId, motivos: guard.triggered, texto: tratado },
        'follow-up: guardrail barrou o degrau — nada enviado',
      );
      return null;
    }
    return guard.rewritten ? guard.text : tratado;
  } catch (err) {
    logger.warn({ err: String(err), unit: unit.slug, leadId: args.leadId }, 'follow-up: modelo falhou');
    return null;
  }
}

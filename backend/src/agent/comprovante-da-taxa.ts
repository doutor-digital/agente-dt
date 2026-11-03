/**
 * Boa Vista (unidade com taxa de reserva): o que acontece em volta do `agendar_consulta` quando a Sofia marca pelo comprovante.
 * Decisão do João, 03/11/2026 — reverte, só nessas unidades, a de 26/10 («comprovante não autoriza marcar»).
 *
 * Quem decide se o comprovante vale é `lib/comprovante-pix.ts` (puro) e a trava `decidirTrava` (confirmacao-so-com-crm.ts). Aqui moram
 * as três coisas que falam com o mundo:
 *  1. o registro do E2E (tabela `comprovantes_pix_usados`): o mesmo comprovante nunca marca duas consultas — antes de marcar o E2E é
 *     RESERVADO para este paciente; se outro já o tem, a consulta não é marcada;
 *  2. a tarefa «Conferir no extrato» depois de marcar: a imagem não prova pagamento, só o extrato prova. Se o Pix não caiu, a consulta
 *     está marcada à toa e é a equipe quem desfaz — este é o risco que o João aceitou;
 *  3. a tarefa da recusa, quando o comprovante não passou (motivo técnico), e o texto que o modelo lê depois de marcar.
 *
 * NÃO marca «✓ Consulta pg antecipado» no cartão: esse campo é da equipe, depois de conferir o extrato (a régua de cobrança de Pix lê esse campo).
 */
import { Prisma } from '@prisma/client';
import { logger } from '../lib/logger.js';
import { prisma } from '../lib/prisma.js';
import { enviarTelegram } from '../lib/telegram.js';
import { resumoDaLeitura } from '../lib/comprovante-pix.js';
import type { KommoClient } from '../services/kommo.service.js';
import {
  abrirTarefaParaEquipe,
  RECADO_COMPROVANTE,
  type ComprovanteAceito,
  type ComprovanteRecusado,
  type GanchosDoComprovante,
  type TurnoDoComprovante,
} from './confirmacao-so-com-crm.js';
import type { TraceRecorder } from './trace-recorder.js';

// --- Registro do E2E -------------------------------------------------------------------------------------------------------

export type ResultadoDaReserva =
  /** o E2E era novo (ou era deste mesmo paciente, ainda sem consulta): pode marcar */
  | 'reservado'
  /** outro paciente já usou ESTE comprovante */
  | 'outro_paciente'
  /** este paciente já marcou uma consulta com ESTE comprovante (a equipe decide se o crédito vale para a nova) */
  | 'mesmo_paciente_ja_marcou'
  /** outro paciente usou um comprovante do mesmo banco, minuto e valor, com o ID lido diferente — pode ser o mesmo, lido com um caractere trocado */
  | 'parecido_de_outro'
  /** o banco não respondeu: sem registro não há como impedir o reuso */
  | 'indisponivel';

export interface RegistroDeE2E {
  reservar(info: { e2e: string; unitId: string; leadId: number; valorCentavos: number; favorecido: string | null }): Promise<ResultadoDaReserva>;
  concluir(e2e: string, info: { idSchedule: number | null; consultaEm: string | null }): Promise<void>;
}

/** `E` + ISPB + data/hora: a parte do E2E que já identifica banco e minuto. */
const PREFIXO = 21;
/** Quantos dos 11 caracteres finais podem diferir para o ID ainda ser tido como «o mesmo lido com erro» (a visão troca `l`/`I`, `0`/`O`). */
const ERROS_DE_LEITURA = 3;

function diferencas(a: string, b: string): number {
  if (a.length !== b.length) return Infinity;
  let n = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) n++;
  return n;
}

/** O E2E é comparado sem caixa: ler `l` por `I` ou `o` por `O` não pode abrir um segundo uso do mesmo comprovante. */
export const chaveDoE2E = (e2e: string) => e2e.trim().toUpperCase();

/** O pedaço do Prisma que o registro usa (os testes passam um banco de mentira). */
export type BancoDeComprovantes = Pick<typeof prisma, 'comprovantePixUsado'>;

type Linha = { unitId: string; kommoLeadId: number; idSchedule: number | null; consultaEm: string | null };
/** «Já marcou» = a consulta foi marcada com este comprovante: o id vem do vínculo; a data/hora vai sempre, mesmo se o id não veio. */
const jaMarcou = (r: Pick<Linha, 'idSchedule' | 'consultaEm'>) => r.idSchedule !== null || r.consultaEm !== null;

export function criarRegistroNoBanco(db: BancoDeComprovantes = prisma): RegistroDeE2E {
  return {
    async reservar({ e2e, unitId, leadId, valorCentavos, favorecido }) {
      const chave = chaveDoE2E(e2e);
      const meu = (r: Pick<Linha, 'unitId' | 'kommoLeadId'>) => r.unitId === unitId && r.kommoLeadId === leadId;
      try {
        const parecidos = await db.comprovantePixUsado.findMany({
          where: { e2e: { startsWith: chave.slice(0, PREFIXO) }, valorCentavos },
          select: { e2e: true, unitId: true, kommoLeadId: true, idSchedule: true, consultaEm: true },
        });
        const igual = parecidos.find((r) => r.e2e === chave);
        if (igual) {
          if (!meu(igual)) return 'outro_paciente';
          return jaMarcou(igual) ? 'mesmo_paciente_ja_marcou' : 'reservado';
        }
        // outro paciente, mesmo banco, minuto e valor, e o final do ID quase igual: o mesmo comprovante lido com erro
        if (parecidos.some((r) => !meu(r) && diferencas(r.e2e.slice(PREFIXO), chave.slice(PREFIXO)) <= ERROS_DE_LEITURA)) return 'parecido_de_outro';
        try {
          await db.comprovantePixUsado.create({ data: { e2e: chave, unitId, kommoLeadId: leadId, valorCentavos, favorecido } });
        } catch (err) {
          // duas conversas com o mesmo comprovante ao mesmo tempo: a unicidade do banco decide quem ficou
          if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
            const dono = await db.comprovantePixUsado.findUnique({ where: { e2e: chave }, select: { unitId: true, kommoLeadId: true, idSchedule: true, consultaEm: true } });
            if (dono && meu(dono)) return jaMarcou(dono) ? 'mesmo_paciente_ja_marcou' : 'reservado';
            return 'outro_paciente';
          }
          throw err;
        }
        return 'reservado';
      } catch (err) {
        logger.error({ err: String(err), unitId, leadId }, 'comprovante: registro do E2E indisponível — a consulta NÃO é marcada por comprovante');
        return 'indisponivel';
      }
    },
    async concluir(e2e, info) {
      await db.comprovantePixUsado.updateMany({ where: { e2e: chaveDoE2E(e2e) }, data: { idSchedule: info.idSchedule, consultaEm: info.consultaEm } });
    },
  };
}

export const registroNoBanco: RegistroDeE2E = criarRegistroNoBanco();

async function idDaConsultaNoVinculo(unitId: string, leadId: number): Promise<number | null> {
  const v = await prisma.spineLeadLink.findUnique({ where: { unitId_kommoLeadId: { unitId, kommoLeadId: leadId } }, select: { spineIdSchedule: true } });
  return v?.spineIdSchedule ?? null;
}

// --- Textos ----------------------------------------------------------------------------------------------------------------

const brl = (v: number) => `R$ ${v.toFixed(2).replace('.', ',')}`;
const dataBR = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;

/** O que o modelo lê depois de marcar pelo comprovante (some-se ao «Consulta marcada para…», que fica na frente). */
export const ADENDO_DA_MARCACAO_POR_COMPROVANTE =
  ' O COMPROVANTE do Pix da taxa chegou e foi conferido (favorecido, valor e código da transação): a consulta está CONFIRMADA e a taxa de reserva já está paga. ' +
  'Na mensagem de confirmação diga que RECEBEU O COMPROVANTE e que a consulta está confirmada, e use a linha de valor «R$ … no total — R$ … antecipado (já pago, garante o horário) + R$ … no dia». ' +
  'NÃO envie a chave Pix, NÃO peça pagamento nem comprovante e NÃO escreva «pagamento confirmado», «Pix aprovado» nem «o Pix caiu»: o dinheiro quem confere é a equipe, no extrato.';

/** A frase da tarefa «Conferir no extrato». */
export function textoDaTarefaDoExtrato(a: ComprovanteAceito, args: { data: string; hora: string }, nomeDoCartao: string | null): string {
  const de = a.pagador ?? nomeDoCartao ?? 'o paciente';
  return (
    `CONFERIR NO EXTRATO o Pix de ${brl(a.valor)} de ${de} — consulta JÁ lançada pela IA para ${dataBR(args.data)} às ${args.hora}. ` +
    `A imagem do comprovante não prova o pagamento, só o extrato prova. Se o Pix caiu: marque «✓ Consulta pg antecipado» no cartão. ` +
    `Se NÃO caiu: desmarque a consulta e fale com o paciente (a consulta está ocupando o horário). ` +
    `Comprovante: ${resumoDaLeitura(a.dados)}`
  );
}

/** Texto técnico para a tarefa da recusa. */
export function detalheDaRecusa(r: ComprovanteRecusado): string {
  return `a conferência automática NÃO aceitou o comprovante (${r.codigo}): ${r.motivo}. Lido: ${resumoDaLeitura(r.dados)}`;
}

// --- Os ganchos da trava ---------------------------------------------------------------------------------------------------

export interface ContextoDosGanchos {
  unit: { id: string; slug: string };
  /** o lead DA CONVERSA (o `leadId` que o modelo escreve pode estar errado: `fixarLeadDaConversa` roda por dentro desta trava) */
  leadId: number | undefined;
  kommo: Pick<KommoClient, 'createTask' | 'getLead'> | undefined;
  recorder: Pick<TraceRecorder, 'step'>;
  /** o estado do turno: os ganchos marcam `tarefaDaRecusaAberta` para o grafo não abrir a tarefa genérica por cima */
  turno: TurnoDoComprovante & { tarefaDaRecusaAberta?: boolean };
  registro?: RegistroDeE2E;
  /** o id da consulta que `agendar_consulta` gravou no vínculo do lead (injetável nos testes) */
  lerIdDaConsulta?: (unitId: string, leadId: number) => Promise<number | null>;
  alertar?: (texto: string) => Promise<unknown>;
  /** injetável nos testes */
  abrirTarefa?: typeof abrirTarefaParaEquipe;
}

const NAO_MARCOU =
  'A consulta NÃO foi marcada. NÃO chame agendar_consulta de novo neste turno e NÃO diga que está confirmada, agendada, reservada ou garantida, nem que o pagamento foi confirmado. ';

/** O que o modelo lê quando o comprovante vai para a equipe: o recado de sempre, sem prometer nada além de «a equipe confere». */
const TEXTO_PARA_EQUIPE = (motivo: string) =>
  `RECUSADO: não consegui usar o comprovante que o paciente mandou (motivo técnico, NÃO cite ao paciente: ${motivo}). ${NAO_MARCOU}A equipe confere e confirma. ` +
  `Responda ao paciente só isto, com as suas palavras: "${RECADO_COMPROVANTE}"`;

/** E2E com `agendar_consulta` em andamento neste processo: duas chamadas ao mesmo tempo (o modelo pode emitir duas) não marcam duas consultas. */
const EM_ANDAMENTO = new Map<string, number>();
const VALIDADE_DO_ANDAMENTO_MS = 2 * 60_000;

export function criarGanchosDaTaxa(ctx: ContextoDosGanchos): GanchosDoComprovante {
  const registro = ctx.registro ?? registroNoBanco;
  const abrir = ctx.abrirTarefa ?? abrirTarefaParaEquipe;
  const alertar = ctx.alertar ?? ((t: string) => enviarTelegram(t));

  const recusado = (
    aceito: ComprovanteAceito,
    destino: 'reenviar' | 'equipe',
    codigo: 'e2e_ja_usado' | 'e2e_do_mesmo_paciente' | 'registro_indisponivel',
    motivo: string,
    texto: string,
  ) => ({
    libera: false as const,
    titulo: `agendar_consulta recusado — reserva sem pagamento: comprovante não aceito (${codigo}) — ${motivo}`,
    texto,
    rejeicao: { ok: false as const, destino, codigo, motivo, dados: aceito.dados },
  });

  return {
    async antes(aceito) {
      if (!ctx.leadId) {
        const motivo = 'a conversa não tem lead: sem como registrar o comprovante';
        return recusado(aceito, 'equipe', 'registro_indisponivel', motivo, TEXTO_PARA_EQUIPE(motivo));
      }
      const r = await registro.reservar({
        e2e: aceito.e2e,
        unitId: ctx.unit.id,
        leadId: ctx.leadId,
        valorCentavos: Math.round(aceito.valor * 100),
        favorecido: aceito.favorecido,
      });
      if (r === 'reservado') {
        const chave = chaveDoE2E(aceito.e2e);
        const desde = EM_ANDAMENTO.get(chave);
        if (desde !== undefined && Date.now() - desde < VALIDADE_DO_ANDAMENTO_MS) {
          const motivo = 'duas marcações ao mesmo tempo com o mesmo comprovante: só uma vale';
          return recusado(aceito, 'equipe', 'e2e_do_mesmo_paciente', motivo, TEXTO_PARA_EQUIPE(motivo));
        }
        EM_ANDAMENTO.set(chave, Date.now());
        return { libera: true as const };
      }

      if (r === 'outro_paciente') {
        // Pode ser um print repassado, ou o mesmo paciente com o cartão do Kommo duplicado: pedir «outro comprovante» a quem já pagou seria
        // injusto. Ninguém ganha consulta por ele; a equipe vê o motivo na tarefa e decide.
        const motivo = 'este comprovante (mesmo ID da transação) já foi usado em outro cartão/conversa: print repassado, ou o mesmo paciente com o cartão do Kommo duplicado';
        return recusado(aceito, 'equipe', 'e2e_ja_usado', motivo, TEXTO_PARA_EQUIPE(motivo));
      }
      if (r === 'indisponivel') {
        const motivo = 'o registro de comprovantes não respondeu: sem ele não há como impedir o mesmo comprovante em duas consultas';
        return recusado(aceito, 'equipe', 'registro_indisponivel', motivo, TEXTO_PARA_EQUIPE(motivo));
      }
      // mesmo paciente que já marcou uma consulta com este comprovante, ou um comprovante parecido demais com o de outro: a equipe decide
      const motivo =
        r === 'mesmo_paciente_ja_marcou'
          ? 'este comprovante já pagou uma consulta deste paciente que foi marcada antes (a equipe decide se o crédito vale para a nova)'
          : 'outro paciente usou um comprovante do mesmo banco, minuto e valor, com o ID diferente por poucos caracteres (pode ser o mesmo comprovante lido com um caractere trocado)';
      return recusado(aceito, 'equipe', 'e2e_do_mesmo_paciente', motivo, TEXTO_PARA_EQUIPE(motivo));
    },

    async depois(aceito, args, resultado) {
      const marcou = /^Consulta marcada para/.test(resultado.trim());
      if (!marcou) {
        EM_ANDAMENTO.delete(chaveDoE2E(aceito.e2e));
        return resultado; // a franquia recusou (horário ocupado…): o E2E fica reservado para este paciente, que pode escolher outro horário
      }
      const data = String(args.data ?? '');
      const hora = String(args.hora ?? '');
      const leadId = ctx.leadId;

      // Completa o registro com a consulta ANTES de devolver (o vínculo foi gravado por agendar_consulta antes de ela responder): a
      // próxima tentativa com o mesmo comprovante já o encontra como «usado numa consulta».
      try {
        const idSchedule = leadId ? await (ctx.lerIdDaConsulta ?? idDaConsultaNoVinculo)(ctx.unit.id, leadId).catch(() => null) : null;
        await registro.concluir(aceito.e2e, { idSchedule, consultaEm: `${data}T${hora}` });
      } catch (err) {
        logger.warn({ err: String(err), leadId }, 'comprovante: não consegui completar o registro do E2E');
      }
      EM_ANDAMENTO.delete(chaveDoE2E(aceito.e2e));

      // A tarefa «Conferir no extrato». Sem ela ninguém sabe que um Pix não conferido segurou um horário: se não sair, o João é avisado.
      let saiu = false;
      let alertado = false; // `abrirTarefaParaEquipe` já avisa o João quando a tarefa falha
      if (ctx.kommo && leadId) {
        const nome = await ctx.kommo.getLead(leadId).then((l) => l?.name?.trim() || null).catch(() => null);
        const r = await abrir({
          slug: ctx.unit.slug,
          unitId: ctx.unit.id,
          leadId,
          kommo: ctx.kommo,
          recorder: ctx.recorder,
          motivo: 'conferir_extrato',
          chaveExtra: chaveDoE2E(aceito.e2e),
          detalhe: textoDaTarefaDoExtrato(aceito, { data, hora }, nome),
          alertar,
        });
        saiu = r !== 'falhou';
        alertado = !saiu;
      }
      if (!saiu && !alertado) {
        await alertar(
          `⚠️ ${ctx.unit.slug} — a IA MARCOU a consulta ${data} ${hora} pelo comprovante de Pix de ${brl(aceito.valor)} (lead ${leadId ?? '?'}, ID ${aceito.e2e}) e a tarefa «conferir no extrato» NÃO foi aberta. Conferir o Pix à mão.`,
        ).catch(() => undefined);
      }
      await ctx.recorder.step({
        kind: 'KOMMO_ACTION',
        title: `🧾 Consulta marcada pelo comprovante de ${brl(aceito.valor)} (ID ${aceito.e2e}) — tarefa «conferir no extrato» ${saiu ? 'aberta' : 'NÃO aberta'}`,
        payload: { leadId, data, hora, valor: aceito.valor, e2e: aceito.e2e, favorecido: aceito.favorecido, porDocumento: aceito.porDocumento, porNome: aceito.porNome, leitura: aceito.dados },
      });
      return resultado + ADENDO_DA_MARCACAO_POR_COMPROVANTE;
    },

    aoFalhar(aceito) {
      EM_ANDAMENTO.delete(chaveDoE2E(aceito.e2e));
    },

    async aoRecusar(rejeicao) {
      if (!ctx.kommo || !ctx.leadId) return;
      ctx.turno.tarefaDaRecusaAberta = true;
      await abrir({
        slug: ctx.unit.slug,
        unitId: ctx.unit.id,
        leadId: ctx.leadId,
        kommo: ctx.kommo,
        recorder: ctx.recorder,
        // `equipe` = não dá para verificar e o paciente ouviu «a equipe confere»: é a tarefa de sempre. `reenviar` = o paciente foi
        // convidado a mandar outro: a tarefa só informa, com o motivo técnico.
        motivo: rejeicao.destino === 'equipe' ? 'comprovante' : 'comprovante_recusado',
        // outro motivo na segunda tentativa (valor errado e depois favorecido errado) é outra tarefa; o MESMO motivo em rajada, não
        chaveExtra: rejeicao.codigo,
        detalhe: detalheDaRecusa(rejeicao),
        alertar,
      });
    },
  };
}

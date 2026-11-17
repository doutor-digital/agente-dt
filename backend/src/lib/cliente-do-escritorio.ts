/**
 * CLIENTE DO ESCRITÓRIO não é lead: a IA do escritório (Sophia, da Magalhães) não responde quem já é cliente.
 *
 * A trava por etapa (`kommo_allowed_status_ids`) olha só o CARTÃO que recebeu a mensagem. Cliente que escreve e cai num cartão
 * novo em "Incoming leads"/"1 - Lead novo" do Comercial passaria por ela — e levaria a conversa de captação de quem já assinou.
 * Esta porta faz a MESMA pergunta do disparo (`DISPARO_REGRA_CLIENTE`, #318/#322): a PESSOA — todos os cartões dos contatos do lead
 * E os cartões de outros contatos com o MESMO TELEFONE (contato duplicado criado pelo WhatsApp) — está num funil ou numa etapa de
 * cliente? Um cartão basta. O telefone é comparado pela `mesmoNumero` do disparo (dígito a mais, U+00AD e invisíveis), não por outra função.
 *
 * FALHA FECHADA: a IA só segue quando a conferência PROVA `livre`. Tudo o mais cala, sem nota: cliente (`ja-cliente`, com UMA nota por
 * dia no cartão), Kommo que falha (429, rede), busca incompleta, telefone ilegível (`indisponivel`), cartão que sumiu e regra
 * ausente na unidade. Atender cliente como se fosse lead é o erro caro; deixar de responder um lead numa falha do Kommo é barato (a
 * equipe vê no histórico da execução e o lead escreve de novo).
 *
 * Chave `calar-cliente-do-escritorio` (por unidade; `seco` = decide e registra, não cala). Desligada, nem lê o cartão. Com a regra de
 * cliente da unidade no servidor, a chave também falha fechada quando o BANCO está fora (ver `estadoDoPortaoDeSeguranca`).
 */
import type { Unit } from '@prisma/client';
import { logger } from './logger.js';
import { avisoRecente, marcarAviso } from './aviso-dedupe.js';
import { estadoDoPortaoDeSeguranca, type Estado } from './automacoes-estado.js';
import { createKommoClient } from '../services/kommo.service.js';
import {
  conferenciaPorRegraDeCliente,
  portaDoKommo,
  regraDeClienteDoAmbiente,
  type RegraDeCliente,
} from './disparo/conferencia.js';
import type { PessoaParaConferir } from './disparo/franquia.js';
import { telefoneWhatsapp, type SituacaoNaFranquia } from './disparo/regras.js';
import { telefoneDoCartao } from './ia-so-numeros-de-teste.js';

export const ID_CALAR_CLIENTE = 'calar-cliente-do-escritorio';
/** Também é a `rule_key` do dedupe de 1 nota por dia por lead. */
export const REGRA_NOTA_CLIENTE = 'cliente-do-escritorio';

export function calarClienteEstado(slug: string, raw: string | undefined = process.env.CALAR_CLIENTE_ESCRITORIO_SLUGS): Estado {
  return estadoDoPortaoDeSeguranca(slug, ID_CALAR_CLIENTE, raw, regraDeClienteDoAmbiente(slug) !== null);
}

export function notaClienteDoEscritorio(mensagem: string): string {
  const trecho = mensagem.replace(/\s+/g, ' ').trim().slice(0, 140);
  return `🤫 Quem escreveu já é CLIENTE do escritório (tem cartão em funil/etapa de cliente) — a Sophia não respondeu; a equipe decide.${trecho ? ` Disse: "${trecho}${mensagem.trim().length > 140 ? '…' : ''}"` : ''}`;
}

export type SituacaoDaPorta = SituacaoNaFranquia | 'sem-regra' | 'falhou';

export interface ResultadoClienteDoEscritorio {
  estado: Exclude<Estado, 'desligado'>;
  /** true = a IA NÃO responde (qualquer coisa que não seja `livre`) */
  calar: boolean;
  situacao: SituacaoDaPorta;
  /** a nota foi deixada agora (só para `ja-cliente`, no estado ligado, 1x/dia por lead) */
  anotou: boolean;
}

export interface PortaDeps {
  estado?: Estado;
  regra?: RegraDeCliente | null;
  telefone?: (args: { unit: Unit; leadId: number; contactId: string | null }) => Promise<string | null>;
  conferir?: (p: PessoaParaConferir) => Promise<SituacaoNaFranquia>;
  jaAvisou?: (leadId: number) => Promise<boolean>;
  marcou?: (leadId: number) => Promise<void>;
  anotar?: (leadId: number, texto: string) => Promise<{ id?: number } | null | undefined>;
}

/** `null` = chave desligada: a IA segue como sempre. Nunca lança. */
export async function portaClienteDoEscritorio(
  args: { unit: Pick<Unit, 'id' | 'slug'> & Partial<Unit>; leadId: number; contactId?: string | null; humanMessage: string },
  deps: PortaDeps = {},
): Promise<ResultadoClienteDoEscritorio | null> {
  const { unit, leadId, humanMessage } = args;
  const estado = deps.estado ?? calarClienteEstado(unit.slug);
  if (estado === 'desligado') return null;
  try {
    const regra = deps.regra !== undefined ? deps.regra : regraDeClienteDoAmbiente(unit.slug);
    if (!regra) {
      logger.warn({ unit: unit.slug, leadId }, 'cliente-do-escritorio: chave ligada mas DISPARO_REGRA_CLIENTE não tem regra desta unidade — a IA fica CALADA (falha fechada)');
      return { estado, calar: true, situacao: 'sem-regra', anotou: false };
    }
    const lerTelefone = deps.telefone ?? telefoneDoCartao;
    const telefone = telefoneWhatsapp(await lerTelefone({ unit: unit as Unit, leadId, contactId: args.contactId ?? null })) ?? '';
    const conferir = deps.conferir ?? conferenciaPorRegraDeCliente(unit, regra, portaDoKommo(unit as Unit));
    const situacao = await conferir({ leadId, nomeCompleto: '', telefone });
    const calar = situacao !== 'livre';
    let anotou = false;
    if (situacao === 'ja-cliente' && estado === 'ligado') {
      const jaAvisou = deps.jaAvisou ?? ((id: number) => avisoRecente(unit.id, id, REGRA_NOTA_CLIENTE));
      if (!(await jaAvisou(leadId))) {
        const anotar = deps.anotar ?? ((id: number, texto: string) => createKommoClient(unit as Unit).addLeadNote(id, texto));
        try {
          await anotar(leadId, notaClienteDoEscritorio(humanMessage));
          // a chamada não falhou: a nota existe, mesmo que o Kommo não devolva o id — marca, senão sai uma nota por mensagem
          await (deps.marcou ?? ((id: number) => marcarAviso(unit.id, id, REGRA_NOTA_CLIENTE)))(leadId);
          anotou = true;
        } catch (err) {
          logger.warn({ err: String(err), unit: unit.slug, leadId }, 'cliente-do-escritorio: falha ao deixar a nota (segue calada)');
        }
      }
    }
    return { estado, calar, situacao, anotou };
  } catch (err) {
    logger.warn({ err: String(err), unit: unit.slug, leadId }, 'cliente-do-escritorio: porta falhou — a IA fica CALADA (falha fechada)');
    return { estado, calar: true, situacao: 'falhou', anotou: false };
  }
}

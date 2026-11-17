/**
 * CLIENTE DO ESCRITÓRIO não é lead: a IA do escritório (Ana, da Magalhães) não responde quem já é cliente.
 *
 * A trava por etapa (`kommo_allowed_status_ids`) olha só o CARTÃO que recebeu a mensagem. Cliente que escreve e cai num cartão
 * novo em "Incoming leads"/"1 - Lead novo" do Comercial passaria por ela — e levaria a conversa de captação de quem já assinou.
 * Esta porta faz a MESMA pergunta do disparo (`DISPARO_REGRA_CLIENTE`, #318): a PESSOA — todos os cartões dos contatos do lead —
 * está num funil ou numa etapa de cliente? Um cartão basta.
 *
 * Chave `calar-cliente-do-escritorio` (por unidade; `seco` = decide e registra, não cala). Desligada, nem lê o cartão.
 * Lado do erro: leitura que falha, regra ausente ou cartão que sumiu = a IA segue como sempre (o mesmo critério das outras portas
 * do webhook: uma falha do Kommo não pode calar o atendimento inteiro). O `ligar-ia-magalhaes.sh` só liga a chave se a regra existe.
 * Quando cala, deixa UMA nota por dia no cartão e a equipe decide.
 */
import type { Unit } from '@prisma/client';
import { logger } from './logger.js';
import { avisoRecente, marcarAviso } from './aviso-dedupe.js';
import { estadoDaAutomacao, type Estado } from './automacoes-estado.js';
import { createKommoClient } from '../services/kommo.service.js';
import {
  conferenciaPorRegraDeCliente,
  portaDoKommo,
  regraDeClienteDoAmbiente,
  type RegraDeCliente,
} from './disparo/conferencia.js';
import type { PessoaParaConferir } from './disparo/franquia.js';
import type { SituacaoNaFranquia } from './disparo/regras.js';

export const ID_CALAR_CLIENTE = 'calar-cliente-do-escritorio';
/** Também é a `rule_key` do dedupe de 1 nota por dia por lead. */
export const REGRA_NOTA_CLIENTE = 'cliente-do-escritorio';

export function calarClienteEstado(slug: string, raw: string | undefined = process.env.CALAR_CLIENTE_ESCRITORIO_SLUGS): Estado {
  return estadoDaAutomacao(slug, ID_CALAR_CLIENTE, raw);
}

export function notaClienteDoEscritorio(mensagem: string): string {
  const trecho = mensagem.replace(/\s+/g, ' ').trim().slice(0, 140);
  return `🤫 Quem escreveu já é CLIENTE do escritório (tem cartão em funil/etapa de cliente) — a Ana não respondeu; a equipe decide.${trecho ? ` Disse: "${trecho}${mensagem.trim().length > 140 ? '…' : ''}"` : ''}`;
}

export interface ResultadoClienteDoEscritorio {
  estado: Exclude<Estado, 'desligado'>;
  calar: boolean;
  situacao: SituacaoNaFranquia | 'sem-regra' | 'falhou';
  /** a nota foi deixada agora (só no estado ligado, 1x/dia por lead) */
  anotou: boolean;
}

export interface PortaDeps {
  estado?: Estado;
  regra?: RegraDeCliente | null;
  conferir?: (p: PessoaParaConferir) => Promise<SituacaoNaFranquia>;
  jaAvisou?: (leadId: number) => Promise<boolean>;
  marcou?: (leadId: number) => Promise<void>;
  anotar?: (leadId: number, texto: string) => Promise<{ id?: number } | null | undefined>;
}

/** `null` = chave desligada: a IA segue como sempre. Nunca lança. */
export async function portaClienteDoEscritorio(
  args: { unit: Pick<Unit, 'id' | 'slug'> & Partial<Unit>; leadId: number; humanMessage: string },
  deps: PortaDeps = {},
): Promise<ResultadoClienteDoEscritorio | null> {
  const { unit, leadId, humanMessage } = args;
  const estado = deps.estado ?? calarClienteEstado(unit.slug);
  if (estado === 'desligado') return null;
  try {
    const regra = deps.regra !== undefined ? deps.regra : regraDeClienteDoAmbiente(unit.slug);
    if (!regra) {
      logger.warn({ unit: unit.slug, leadId }, 'cliente-do-escritorio: chave ligada mas DISPARO_REGRA_CLIENTE não tem regra desta unidade — a IA segue');
      return { estado, calar: false, situacao: 'sem-regra', anotou: false };
    }
    const conferir = deps.conferir ?? conferenciaPorRegraDeCliente(unit, regra, portaDoKommo(unit as Unit));
    const situacao = await conferir({ leadId, nomeCompleto: '', telefone: '' });
    const calar = situacao === 'ja-cliente';
    let anotou = false;
    if (calar && estado === 'ligado') {
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
    logger.warn({ err: String(err), unit: unit.slug, leadId }, 'cliente-do-escritorio: porta falhou — a IA responde como sempre');
    return { estado, calar: false, situacao: 'falhou', anotou: false };
  }
}

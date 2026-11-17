/**
 * IA SÓ PARA OS NÚMEROS DE TESTE: o "primeiro só no meu número" de uma IA nova.
 *
 * Ligar o webhook do Kommo de uma unidade é ir ao ar para TODO MUNDO que escrever (a IA da Magalhães vai atender 250 respostas por
 * dia do disparo). Esta porta deixa o webhook ligado e a IA falando só com quem está em `DISPARO_LISTA_DE_TESTE` da unidade — a MESMA lista
 * do disparo, para uma decisão só: o número do João entra uma vez e vale para o disparo e para a IA; `slug=*` solta os dois.
 *
 * Chave `ia-so-numeros-de-teste` (por unidade):
 *  - `ligado`    → a IA só responde telefone da lista. Telefone que não dá para ler = NÃO responde (o piloto existe para proteger gente de verdade);
 *  - `seco`      → decide e registra quem NÃO receberia, mas responde (para medir o tamanho do que ficaria de fora);
 *  - `desligado` → como sempre: a IA responde todo mundo (é o padrão — nada muda nas outras unidades).
 * Lista com `*` (ou a unidade com `*`) = todos. Unidade sem entrada na lista = ninguém (mesma regra do disparo).
 * Ir ao ar para todos = pôr a chave em `desligado` (sem reiniciar nada) ou pôr `slug=*` na lista.
 */
import type { Unit } from '@prisma/client';
import { logger } from './logger.js';
import { createKommoClient } from '../services/kommo.service.js';
import { contatoPrincipal } from './kommo-lead-util.js';
import { estadoDaAutomacao, type Estado } from './automacoes-estado.js';
import { listaDeTesteDoAmbiente } from './disparo/porto.js';
import { telefoneWhatsapp } from './disparo/regras.js';

export const ID_PILOTO_NUMEROS = 'ia-so-numeros-de-teste';

export function pilotoDeNumerosEstado(slug: string, raw: string | undefined = process.env.IA_SO_NUMEROS_DE_TESTE_SLUGS): Estado {
  return estadoDaAutomacao(slug, ID_PILOTO_NUMEROS, raw);
}

/** Puro: este telefone pode receber a IA enquanto o piloto vale? `lista` null = todos. */
export function telefoneNaLista(lista: ReadonlySet<string> | null, telefone: string | null | undefined): boolean {
  if (lista === null) return true;
  const t = telefoneWhatsapp(telefone);
  return !!t && lista.has(t);
}

export interface ResultadoDoPiloto {
  estado: Exclude<Estado, 'desligado'>;
  /** o telefone está na lista (ou a lista libera todos)? */
  naLista: boolean;
  /** o telefone não pôde ser lido */
  semTelefone: boolean;
}

export interface PilotoDeps {
  estado?: Estado;
  lista?: ReadonlySet<string> | null;
  telefone?: (args: { unit: Unit; leadId: number; contactId: string | null }) => Promise<string | null>;
}

async function telefoneDoCartao({ unit, leadId, contactId }: { unit: Unit; leadId: number; contactId: string | null }): Promise<string | null> {
  const kommo = createKommoClient(unit);
  const idContato = contactId && Number.isFinite(Number(contactId)) ? Number(contactId) : contatoPrincipal(await kommo.getLead(leadId));
  return idContato ? kommo.getContactPhone(idContato) : null;
}

/** `null` = chave desligada (ou lista libera todos sem precisar ler o telefone): a IA responde como sempre. Nunca lança. */
export async function portaPilotoDeNumeros(
  args: { unit: Unit; leadId: number; contactId: string | null },
  deps: PilotoDeps = {},
): Promise<ResultadoDoPiloto | null> {
  const { unit, leadId } = args;
  const estado = deps.estado ?? pilotoDeNumerosEstado(unit.slug);
  if (estado === 'desligado') return null;
  const lista = deps.lista !== undefined ? deps.lista : listaDeTesteDoAmbiente(unit.slug);
  if (lista === null) return null; // `slug=*`: todos
  try {
    const telefone = await (deps.telefone ?? telefoneDoCartao)(args);
    const semTelefone = !telefoneWhatsapp(telefone);
    return { estado, naLista: telefoneNaLista(lista, telefone), semTelefone };
  } catch (err) {
    // não consegui ler o telefone: no piloto, quem não dá para identificar não recebe
    logger.warn({ err: String(err), unit: unit.slug, leadId }, 'ia-so-numeros-de-teste: não li o telefone do cartão');
    return { estado, naLista: false, semTelefone: true };
  }
}

/**
 * IA SÓ PARA OS NÚMEROS DE TESTE: o "primeiro só no meu número" de uma IA nova.
 *
 * Ligar o webhook do Kommo de uma unidade é ir ao ar para TODO MUNDO que escrever (a IA da Magalhães vai atender 250 respostas por
 * dia do disparo). Esta porta deixa o webhook ligado e a IA falando só com quem está em `IA_NUMEROS_DE_TESTE` da unidade
 * (`slug=telefone,telefone;outro=...`, o mesmo molde do disparo).
 *
 * LISTA PRÓPRIA, não a do disparo, e o `*` NÃO ABRE: abrir o disparo (`DISPARO_LISTA_DE_TESTE` com `slug=*`) não pode abrir a IA por
 * tabela, nem deixar o painel dizendo "piloto ligado" enquanto todo mundo é respondido. A IA só abre pela chave (`--abrir`, ou a tela).
 * Entrada `slug=*` aqui é tratada como lista vazia (ninguém) e vira aviso no log.
 *
 * Chave `ia-so-numeros-de-teste` (por unidade):
 *  - `ligado`    → a IA só responde telefone da lista. Telefone que não dá para ler = NÃO responde (o piloto existe para proteger gente de verdade);
 *  - `seco`      → decide e registra quem NÃO receberia, mas responde (para medir o tamanho do que ficaria de fora);
 *  - `desligado` → como sempre: a IA responde todo mundo (é o padrão — nada muda nas outras unidades).
 * FALHA FECHADA: unidade que tem entrada na lista e o banco ainda mudo (processo recém-subido com o banco fora) = `ligado`
 * (`estadoDoPortaoDeSeguranca`); sem isso a leitura falha cairia no `.env` vazio e a IA responderia todo mundo.
 */
import type { Unit } from '@prisma/client';
import { logger } from './logger.js';
import { createKommoClient } from '../services/kommo.service.js';
import { contatoPrincipal } from './kommo-lead-util.js';
import { estadoDoPortaoDeSeguranca, type Estado } from './automacoes-estado.js';
import { listaDeTesteDoAmbiente } from './disparo/porto.js';
import { telefoneWhatsapp } from './disparo/regras.js';

export const ID_PILOTO_NUMEROS = 'ia-so-numeros-de-teste';

/** A lista PRÓPRIA do piloto desta unidade. Nunca `null`: `*` não abre a IA; unidade sem entrada = lista vazia (ninguém). */
export function listaDoPiloto(slug: string, env: NodeJS.ProcessEnv = process.env): ReadonlySet<string> {
  const lista = listaDeTesteDoAmbiente(slug, { DISPARO_LISTA_DE_TESTE: env.IA_NUMEROS_DE_TESTE } as NodeJS.ProcessEnv);
  if (lista === null) {
    logger.warn({ unit: slug }, 'ia-so-numeros-de-teste: IA_NUMEROS_DE_TESTE com "*" não abre a IA — para abrir, desligue a chave; a lista fica vazia');
    return new Set();
  }
  return lista;
}

/** A unidade tem entrada em `IA_NUMEROS_DE_TESTE` (mesmo `*` ou vazia)? É o que a faz "protegida" quando o banco está fora. */
export function temEntradaNoPiloto(slug: string, env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.IA_NUMEROS_DE_TESTE ?? '').split(/[;\n]/).some((e) => {
    const i = e.indexOf('=');
    return i > 0 && e.slice(0, i).trim() === slug;
  });
}

export function pilotoDeNumerosEstado(slug: string, raw: string | undefined = process.env.IA_SO_NUMEROS_DE_TESTE_SLUGS): Estado {
  return estadoDoPortaoDeSeguranca(slug, ID_PILOTO_NUMEROS, raw, temEntradaNoPiloto(slug));
}

/** Puro: este telefone pode receber a IA enquanto o piloto vale? */
export function telefoneNaLista(lista: ReadonlySet<string>, telefone: string | null | undefined): boolean {
  const t = telefoneWhatsapp(telefone);
  return !!t && lista.has(t);
}

export interface ResultadoDoPiloto {
  estado: Exclude<Estado, 'desligado'>;
  /** o telefone está na lista do piloto? */
  naLista: boolean;
  /** o telefone não pôde ser lido */
  semTelefone: boolean;
}

export interface PilotoDeps {
  estado?: Estado;
  lista?: ReadonlySet<string>;
  telefone?: (args: { unit: Unit; leadId: number; contactId: string | null }) => Promise<string | null>;
}

export async function telefoneDoCartao({ unit, leadId, contactId }: { unit: Unit; leadId: number; contactId: string | null }): Promise<string | null> {
  const kommo = createKommoClient(unit);
  const idContato = contactId && Number.isFinite(Number(contactId)) ? Number(contactId) : contatoPrincipal(await kommo.getLead(leadId));
  return idContato ? kommo.getContactPhone(idContato) : null;
}

/** `null` = chave desligada: a IA responde como sempre. Nunca lança. */
export async function portaPilotoDeNumeros(
  args: { unit: Unit; leadId: number; contactId: string | null },
  deps: PilotoDeps = {},
): Promise<ResultadoDoPiloto | null> {
  const { unit, leadId } = args;
  const estado = deps.estado ?? pilotoDeNumerosEstado(unit.slug);
  if (estado === 'desligado') return null;
  const lista = deps.lista !== undefined ? deps.lista : listaDoPiloto(unit.slug);
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

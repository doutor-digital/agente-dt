/**
 * Nome confirmado pela IA → contato do Kommo (pedido do João, 19/10/2026 — relatório de Canaã).
 *
 * Os modelos de WhatsApp da rede abrem com "Olá, {{contact.name}}" (36 só em Canaã). O contato nasce
 * com o nome do PERFIL do WhatsApp, e a Sofia gravava o nome confirmado só no TÍTULO do cartão — então
 * a confirmação saía "Olá, Deus Forte", "Olá, ARENA SABOR", "Olá, .". Medido em Canaã (14 dias, 150
 * cartões com nome no título): 48 com outro nome no contato, 55 só parecidos, 2 vazios.
 *
 * Quem grava aqui é SÓ a ferramenta `atualizar_titulo_lead` — a IA entendeu que aquilo é o nome. A rede
 * de segurança do grafo (nome achado por regra na mensagem) fica de fora de propósito: foi ela que pôs
 * "Obg", "Mas" e "Unable" nos títulos. A regra de campo com `updatesLeadTitle` também fica: nenhuma
 * unidade usa (19/10) e ela não sabe dizer quando o nome é de outra pessoa.
 *
 * Nome de OUTRA pessoa (a esposa passando o nome do marido) não vem pra cá — quem chama decide pelo
 * `nomeDeOutraPessoa` da ferramenta. O contato é de quem escreve no WhatsApp; o título, do paciente.
 *
 * Ligado por unidade na tela de Automações (`nome-no-contato`); "só no papel" registra o que faria.
 */
import type { Unit } from '@prisma/client';
import type { KommoClient } from '../services/kommo.service.js';
import { looksLikeName } from '../agent/name-capture.js';
import { estadoDaAutomacao } from './automacoes-estado.js';

export function estadoNomeNoContato(slug: string, raw: string | undefined = process.env.NOME_NO_CONTATO_SLUGS) {
  return estadoDaAutomacao(slug, 'nome-no-contato', raw);
}

/** "José" → "jose": comparar sem acento, caixa, emoji nem pontuação. */
function tokens(nome: string): string[] {
  return nome
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .split(/[^a-z'\-]+/)
    .filter(Boolean);
}

const CONECTORES = new Set(['de', 'da', 'do', 'das', 'dos', 'e']);

/**
 * "JOSÉ RODRIGUES PEREIRA" / "maria do amparo" → "José Rodrigues Pereira" / "Maria do Amparo". Só mexe
 * na caixa quando o nome veio todo maiúsculo ou todo minúsculo; caixa mista ("D'Ávila") fica como veio.
 */
export function nomeParaContato(nome: string): string {
  const limpo = nome.trim().replace(/\s+/g, ' ');
  if (limpo !== limpo.toUpperCase() && limpo !== limpo.toLowerCase()) return limpo;
  return limpo
    .toLowerCase()
    .split(' ')
    .map((p, i) => (i > 0 && CONECTORES.has(p) ? p : p.charAt(0).toUpperCase() + p.slice(1)))
    .join(' ');
}

export type DecisaoDoContato =
  | { gravar: true; nome: string; motivo: string }
  | { gravar: false; motivo: string };

/**
 * Decide se o contato recebe o nome confirmado. Só NÃO grava quando o contato já tem todas as palavras
 * do nome, em qualquer ordem, e ele mesmo parece nome: "Anny Santos" fica com "Anny" confirmado,
 * "Claudio Pereira Souza" fica com "Claudio Souza", "José Daires" fica com "Daires José".
 * Número no nome do contato é sujeira de importação ("Dayse Moreira 28/04/25 Sem Origem"): grava.
 */
export function decidirNomeDoContato(atual: string | null | undefined, confirmado: string): DecisaoDoContato {
  const nome = nomeParaContato(confirmado);
  if (!looksLikeName(nome)) return { gravar: false, motivo: `"${confirmado}" não parece nome` };
  const bruto = String(atual ?? '').trim();
  const doContato = tokens(bruto);
  if (doContato.length === 0) return { gravar: true, nome, motivo: 'contato sem nome' };
  if (/\d/.test(bruto)) return { gravar: true, nome, motivo: 'nome do contato tem número' };
  const jaTemTudo = tokens(nome).every((t) => doContato.includes(t));
  // a versão do contato só vale se ela mesma parece nome ("Aline Forrozeira Oficial" passa; "nalldobarros" também —
  // mas aí não tem "nalldo" nem "barros" separados e grava "Nalldo Barros")
  if (jaTemTudo && looksLikeName(doContato.join(' '))) {
    return { gravar: false, motivo: `contato já tem "${bruto}"` };
  }
  return { gravar: true, nome, motivo: `contato tinha "${bruto}"` };
}

export type DesfechoDoContato =
  | { acao: 'desligado' }
  | { acao: 'sem-contato' }
  | { acao: 'manteve'; contatoId: number; motivo: string }
  | { acao: 'gravou' | 'gravaria'; contatoId: number; de: string; para: string; motivo: string };

/**
 * Lê o contato, decide e (se a unidade estiver ligada) grava. Lança só quando o Kommo falha — quem
 * chama registra o erro sem desfazer o título, que já gravou.
 */
export async function gravarNomeConfirmadoNoContato(args: {
  unit: Pick<Unit, 'slug'>;
  kommo: Pick<KommoClient, 'getContactNome' | 'updateContactName'>;
  contatoId: number | null;
  nome: string;
  ambiente?: string;
}): Promise<DesfechoDoContato> {
  const estado = estadoNomeNoContato(args.unit.slug, args.ambiente ?? process.env.NOME_NO_CONTATO_SLUGS);
  if (estado === 'desligado') return { acao: 'desligado' };
  if (!args.contatoId) return { acao: 'sem-contato' };
  const atual = await args.kommo.getContactNome(args.contatoId);
  const decisao = decidirNomeDoContato(atual, args.nome);
  if (!decisao.gravar) return { acao: 'manteve', contatoId: args.contatoId, motivo: decisao.motivo };
  if (estado === 'seco') {
    return { acao: 'gravaria', contatoId: args.contatoId, de: atual, para: decisao.nome, motivo: decisao.motivo };
  }
  await args.kommo.updateContactName(args.contatoId, decisao.nome);
  return { acao: 'gravou', contatoId: args.contatoId, de: atual, para: decisao.nome, motivo: decisao.motivo };
}

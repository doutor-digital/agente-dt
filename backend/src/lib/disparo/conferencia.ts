/**
 * A conferência de "esta pessoa já é nossa?" por unidade — a regra escolhe a fonte:
 *  1. unidade COM franquia (`spineToken`) → agenda e tratamentos da franquia (`franquia.ts`), como sempre;
 *  2. unidade SEM franquia mas COM `DISPARO_REGRA_CLIENTE` → o cartão do lead no Kommo (escritório de advocacia:
 *     cliente é quem está num funil ou numa etapa de "cliente");
 *  3. sem uma coisa nem outra → `indisponivel` para todo mundo (o padrão seguro de sempre: na dúvida, não manda).
 *
 * `DISPARO_REGRA_CLIENTE` — POR UNIDADE, nunca global (mesmo molde de `DISPARO_LISTA_DE_TESTE`):
 *
 *   `magalhaes-advocacia=14026239,13964971/108260519,13964971/142`
 *
 *  - `<funil>`          → QUEM ESTÁ em qualquer etapa desse funil (inclusive ganho/perdido) é cliente;
 *  - `<funil>/<etapa>`  → só quem está nessa etapa desse funil é cliente;
 *  - entradas de unidades diferentes separadas por `;` (ou quebra de linha), itens da unidade por vírgula;
 *  - qualquer item que não seja número (ou número/número) invalida a entrada INTEIRA: regra pela metade deixaria passar
 *    cliente. Unidade que não aparece, ou entrada inválida = sem regra = `indisponivel`.
 *
 * A conferência é da PESSOA, não do cartão etiquetado (como na franquia): lê o lead, os contatos dele e TODOS os cartões de
 * cada contato, mais os cartões de outros contatos com o MESMO TELEFONE (contato duplicado, sem etiqueta); UM cartão em funil/etapa de cliente basta para `ja-cliente`. Quem tem um cartão perdido etiquetado e
 * outro no Jurídico sem etiqueta é cliente.
 *
 * Falha ao ler QUALQUER coisa no caminho (lead, contato, cartões do contato, cartão que sumiu da resposta) NUNCA vira
 * `livre`: vira `indisponivel`, e quem chama não manda (e adia, não descarta). Exceção deliberada: o cartão etiquetado
 * que não existe mais (204/resposta vazia: apagado ou mesclado; o 404 NÃO conta, pode ser conta errada) vira `lead-inexistente`, descartado de vez — adiar para sempre uma
 * pessoa que não tem mais cartão só acenderia alerta falso.
 * Tudo é lido FRESCO a cada conferência (funil e etapa de agora): a reconferência da hora do envio pega quem fechou
 * contrato depois de a onda ser montada. O cliente do Kommo é o SEM FREIO: um 429 daqui não congela o Kommo da Sofia.
 */
import type { Unit } from '@prisma/client';
import { logger } from '../logger.js';
import { createKommoClientSemFreio, type KommoLead } from '../../services/kommo.service.js';
import { conferenciaDaFranquia, type FranquiaPorta, type PessoaParaConferir } from './franquia.js';
import { campanhaUsaPrimeiroNome, chaveDaPessoa, telefoneWhatsapp, type SituacaoNaFranquia } from './regras.js';
import { finalDoTelefone } from '../campanha/metricas.js';

export interface RegraDeCliente {
  /** funis inteiros: qualquer etapa conta como cliente */
  funis: ReadonlySet<number>;
  /** etapas soltas: `"<funil>/<etapa>"` */
  etapas: ReadonlySet<string>;
}

const chaveDaEtapa = (funil: number, etapa: number) => `${funil}/${etapa}`;

/** O que importa do lead para a regra. */
export interface LeadNoKommo {
  pipeline_id: number;
  status_id: number;
}

function lerEntrada(valor: string): RegraDeCliente | null {
  const funis = new Set<number>();
  const etapas = new Set<string>();
  const itens = valor.split(',').map((i) => i.trim());
  for (const item of itens) {
    const m = /^(\d+)(?:\/(\d+))?$/.exec(item);
    if (!m) return null;
    const funil = Number(m[1]);
    if (!Number.isSafeInteger(funil) || funil <= 0) return null;
    if (m[2] === undefined) {
      funis.add(funil);
      continue;
    }
    const etapa = Number(m[2]);
    if (!Number.isSafeInteger(etapa) || etapa <= 0) return null; // "funil/0" é erro de digitação, não etapa
    etapas.add(chaveDaEtapa(funil, etapa));
  }
  return funis.size + etapas.size > 0 ? { funis, etapas } : null;
}

/** A regra de cliente da unidade, ou `null` (sem regra, regra inválida, ou variável ausente). */
export function regraDeClienteDoAmbiente(slug: string, env: NodeJS.ProcessEnv = process.env): RegraDeCliente | null {
  for (const entrada of (env.DISPARO_REGRA_CLIENTE ?? '').split(/[;\n]/)) {
    const i = entrada.indexOf('=');
    if (i < 0 || entrada.slice(0, i).trim() !== slug) continue;
    return lerEntrada(entrada.slice(i + 1));
  }
  return null;
}

/** O que a variável tem de errado, para o log de subida avisar: a entrada inválida não vale e a unidade fica `indisponivel`. */
export function avisosDaRegraDeCliente(env: NodeJS.ProcessEnv = process.env): string[] {
  const avisos: string[] = [];
  const vistos = new Set<string>();
  for (const bruta of (env.DISPARO_REGRA_CLIENTE ?? '').split(/[;\n]/)) {
    const e = bruta.trim();
    if (!e) continue;
    const i = e.indexOf('=');
    const slug = i > 0 ? e.slice(0, i).trim() : '';
    if (!/^[a-z0-9][a-z0-9-]*$/i.test(slug) || !lerEntrada(e.slice(i + 1))) {
      avisos.push(`DISPARO_REGRA_CLIENTE: a entrada "${e.slice(0, 40)}" não vale (o formato é slug=funil,funil/etapa); a unidade fica sem regra e ninguém recebe`);
      continue;
    }
    if (vistos.has(slug)) avisos.push(`DISPARO_REGRA_CLIENTE: "${slug}" aparece mais de uma vez; só a PRIMEIRA entrada vale`);
    vistos.add(slug);
  }
  return avisos;
}

/** Pura: este lead, no funil e na etapa de agora, é cliente? */
export function ehCliente(regra: RegraDeCliente, lead: LeadNoKommo): boolean {
  return regra.funis.has(lead.pipeline_id) || regra.etapas.has(chaveDaEtapa(lead.pipeline_id, lead.status_id));
}

/** O cartão como a conferência precisa dele (o `KommoLead` real serve; o teste monta um mínimo). */
export interface LeadLido {
  id?: number;
  pipeline_id?: number;
  status_id?: number;
  _embedded?: { contacts?: Array<{ id: number }> };
}

/** As leituras do Kommo que a conferência faz. Em produção são as do Kommo da unidade; o teste troca por um Kommo falso. */
export interface PortaDoKommo {
  /** o cartão (com contatos). 204/vazio = não existe mais. Qualquer erro, 404 inclusive, LANÇA (vira `indisponivel`: pode ser conta errada, não cartão apagado) */
  getLead(leadId: number): Promise<LeadLido | null | ''>;
  /** ids dos cartões do contato; `null` = não consegui perguntar (não é "nenhum") */
  leadsDoContato(contactId: number): Promise<number[] | null>;
  /** os cartões por id (funil e etapa de agora) */
  listLeadsPorIds(ids: number[]): Promise<LeadLido[]>;
  /** os contatos que a busca do Kommo devolve para os 8 últimos dígitos (a busca é difusa: quem chama confere o número). Erro LANÇA */
  contatosPorTelefone(final8: string): Promise<Array<{ id: number; telefones: string[]; leadIds: number[] }>>;
}

/** A busca de contatos por telefone devolve no máximo isto; chegar ao teto = lista possivelmente incompleta = não dá para afirmar nada. */
const TETO_DA_BUSCA_POR_TELEFONE = 50;

/**
 * Este VALOR do campo de telefone do contato inclui o número da pessoa? O campo pode trazer mais de um número
 * ("63 99102-1043 / 63 98888-0000"), ramal ou recado ("63 99102-1043 - 12", "(63) 99102-1043 (12)"): o valor é quebrado em
 * TRECHOS que parecem telefone (dígitos com espaço, parêntese, ponto ou hífen; qualquer outra coisa — "/", ";", ",", letras —
 * separa) e cada trecho é conferido, nunca os 8 últimos do texto inteiro. Antes de separar, travessões, hífens "bonitos"
 * (U+2010 a U+2015, U+2212, U+FE58/FE63/FF0D) viram "-" e espaços estranhos (NBSP etc.) já contam como espaço; caracteres
 * invisíveis (U+200B a U+200F, U+2060) somem.
 *  - trecho que dá para ler como celular com DDD (`telefoneWhatsapp`): compara DDD + 8 últimos (atravessa DDI e nono dígito;
 *    mesmos 8 dígitos em OUTRO DDD não casa);
 *  - trecho que NÃO dá para ler como celular (ramal grudado, fixo, 10 dígitos, sem DDD, colados): casa se os 8 dígitos da pessoa
 *    aparecem EM QUALQUER LUGAR do trecho. Pode casar a mais (DDD não conferível), e isso é o lado seguro: um cartão a mais
 *    conferido, ninguém recebe a mais.
 */
export function mesmoNumero(valorDoContato: string, chaveDaPessoaConferida: string): boolean {
  const final8 = chaveDaPessoaConferida.slice(2);
  const limpo = valorDoContato.replace(/[\u200B-\u200F\u2060]/g, '').replace(/[\u2010-\u2015\u2212\uFE58\uFE63\uFF0D]/g, '-');
  const trechos = limpo.match(/\+?\d[\d\s().-]{6,}\d/g) ?? [];
  return trechos.some((t) => {
    const digitos = t.replace(/\D/g, '');
    const completo = digitos.length <= 13 ? telefoneWhatsapp(t) : null;
    if (completo) return chaveDaPessoa(completo) === chaveDaPessoaConferida;
    return digitos.includes(final8);
  });
}

export function portaDoKommo(unit: Unit): PortaDoKommo {
  let kommo: ReturnType<typeof createKommoClientSemFreio> | null = null;
  const k = () => (kommo ??= createKommoClientSemFreio(unit));
  return {
    getLead: (id) => k().getLead(id) as Promise<KommoLead | ''>,
    leadsDoContato: (id) => k().leadsDoContato(id),
    listLeadsPorIds: (ids) => k().listLeadsPorIds(ids) as Promise<KommoLead[]>,
    contatosPorTelefone: (final8) => k().buscarContatosPorTelefone(final8, TETO_DA_BUSCA_POR_TELEFONE),
  };
}

const temFunilEEtapa = (l: LeadLido): l is LeadLido & LeadNoKommo => typeof l.pipeline_id === 'number' && typeof l.status_id === 'number';

/** A conferência de uma unidade SEM franquia, pela regra de cliente: a pessoa inteira, não só o cartão etiquetado. */
export function conferenciaPorRegraDeCliente(unit: Pick<Unit, 'slug'>, regra: RegraDeCliente, kommo: PortaDoKommo): (p: PessoaParaConferir) => Promise<SituacaoNaFranquia> {
  return async (p) => {
    if (!p.leadId) return 'indisponivel'; // sem cartão não há o que olhar
    const chave = chaveDaPessoa(p.telefone);
    const final8 = finalDoTelefone(p.telefone);
    if (!final8) return 'indisponivel'; // sem 8 dígitos não há como procurar o mesmo telefone em outro contato
    try {
      // 204/vazio = o cartão não existe mais. 404 NÃO: pode ser subdomínio ou integração errada, e aí descartaria a onda toda;
      // erro (404 inclusive) lança, cai no catch e vira `indisponivel` (adia, tenta de novo).
      const lead = await kommo.getLead(p.leadId);
      if (!lead) return 'lead-inexistente';
      // Resposta sem funil ou sem etapa não é "lead novo": é leitura que não deu certo.
      if (!temFunilEEtapa(lead)) return 'indisponivel';
      if (ehCliente(regra, lead)) return 'ja-cliente';

      // Os outros cartões da pessoa: todos os cartões de cada contato do lead.
      const contatos = (lead._embedded?.contacts ?? []).map((c) => c.id).filter((id) => typeof id === 'number');
      const outros = new Set<number>();
      for (const contato of contatos) {
        const ids = await kommo.leadsDoContato(contato);
        if (ids === null) return 'indisponivel';
        for (const id of ids) if (id !== p.leadId) outros.add(id);
      }
      // Os cartões de OUTROS contatos com o mesmo telefone (contato duplicado, sem etiqueta): a busca do Kommo é difusa, então cada
      // contato devolvido é conferido pelo número. Busca cheia (teto) não prova nada; erro lança e vira `indisponivel`.
      const achados = await kommo.contatosPorTelefone(final8);
      if (achados.length >= TETO_DA_BUSCA_POR_TELEFONE) return 'indisponivel';
      // A busca é difusa e já falhou em silêncio antes: o contato do PRÓPRIO cartão tem de voltar nela. Se não voltou, a busca não
      // enxerga este número (formato, token, índice atrasado) e não prova que não há duplicado: a pessoa fica de fora, com motivo claro.
      if (contatos.length === 0 || !contatos.some((id) => achados.some((c) => c.id === id))) {
        logger.warn({ unit: unit.slug, leadId: p.leadId, contatos, achados: achados.length }, 'disparo: a busca por telefone do Kommo não devolveu o contato do próprio cartão — pessoa fica de fora (indisponível)');
        return 'indisponivel';
      }
      for (const c of achados) {
        if (!c.telefones.some((t) => mesmoNumero(t, chave))) continue;
        for (const id of c.leadIds) if (id !== p.leadId) outros.add(id);
      }
      if (outros.size === 0) return 'livre';
      const lidos = await kommo.listLeadsPorIds([...outros]);
      const porId = new Map(lidos.map((l) => [l.id, l] as const));
      let faltou = false;
      for (const id of outros) {
        const l = porId.get(id);
        if (!l || !temFunilEEtapa(l)) faltou = true;
        else if (ehCliente(regra, l)) return 'ja-cliente'; // UM cartão de cliente basta, mesmo que outro não tenha vindo
      }
      return faltou ? 'indisponivel' : 'livre';
    } catch (err) {
      logger.warn({ err: String(err), unit: unit.slug, leadId: p.leadId }, 'disparo: não consegui ler o lead no Kommo — pessoa fica de fora');
      return 'indisponivel';
    }
  };
}

/** Pode conferir "já é nosso?" nesta unidade? Sem franquia e sem regra, não: a onda nem abre. */
export function unidadeConfere(unit: Pick<Unit, 'slug' | 'spineToken'>, env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(unit.spineToken) || regraDeClienteDoAmbiente(unit.slug, env) !== null;
}

/**
 * O nome da pessoa é exigido na triagem? Em unidade COM franquia, sempre (a franquia casa por nome e a triagem é a de antes).
 * Só a unidade que confere pelo Kommo pode dispensar o nome, e só se a campanha não usa `primeiroNome` em nenhuma variável.
 */
export function exigeNomeNaTriagem(unit: Pick<Unit, 'slug' | 'spineToken'>, variaveis: readonly unknown[], env: NodeJS.ProcessEnv = process.env): boolean {
  return !usaRegraDeCliente(unit, env) || campanhaUsaPrimeiroNome(variaveis);
}

/** A unidade confere pelo cartão no Kommo (sem franquia, com regra)? Liga a conferência direta dos cartões repetidos, decide o nome exigido na triagem e os textos "Kommo" (painel, alerta, MCP). */
export function usaRegraDeCliente(unit: Pick<Unit, 'slug' | 'spineToken'>, env: NodeJS.ProcessEnv = process.env): boolean {
  return !unit.spineToken && regraDeClienteDoAmbiente(unit.slug, env) !== null;
}

/** A conferência que a montagem e a reconferência do envio usam — a MESMA nos dois, para uma só regra por unidade. */
export function conferenciaDaUnidade(
  unit: Unit,
  opcoes: { env?: NodeJS.ProcessEnv; kommo?: PortaDoKommo; franquia?: FranquiaPorta } = {},
): (p: PessoaParaConferir) => Promise<SituacaoNaFranquia> {
  if (unit.spineToken) return conferenciaDaFranquia(unit, undefined, opcoes.franquia);
  const regra = regraDeClienteDoAmbiente(unit.slug, opcoes.env);
  if (!regra) return conferenciaDaFranquia(unit, undefined, opcoes.franquia); // sem token: 'indisponivel' para todos, como hoje
  return conferenciaPorRegraDeCliente(unit, regra, opcoes.kommo ?? portaDoKommo(unit));
}

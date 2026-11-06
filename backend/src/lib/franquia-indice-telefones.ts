/**
 * Índice de TELEFONES da franquia, por unidade (06/11/2026).
 *
 * Por que existe: o ⬢ Tipo de lead da chegada (`tipo-lead-chegada.ts`) precisa saber se o telefone JÁ estava na franquia
 * (paciente OU lead). A franquia ignora o filtro de telefone — `/api/clients/search` só filtra `name`, `/api/leads/search`
 * só por janela de datas (≤100 dias). Então o telefone é procurado do NOSSO lado: lemos a base da franquia página a página,
 * guardamos a chave (últimos 8 dígitos) no banco e perguntamos aqui.
 *
 * Guardado em tabela (`franquia_telefones` + `franquia_indice_status`, migration aditiva): sobrevive a restart/deploy; em
 * memória cada deploy recarregaria a base inteira da franquia.
 *
 * O contrato que protege o dado (Cadastro por falta de índice seria erro permanente):
 *  - `completoEm` só avança quando a carga terminou INTEIRA — sem erro, sem corte por teto. Índice ausente, velho
 *    (mais de 36 h), cortado ou com erro NUNCA autoriza "não está em lugar nenhum";
 *  - achar o telefone vale mesmo com índice velho (a prova positiva não envelhece);
 *  - cada linha guarda o cadastro MAIS ANTIGO daquele telefone com a data em que nasceu na franquia: o lead/paciente que NÓS
 *    mesmos acabamos de criar para o cartão (cadastro-todo-lead, Sofia) tem data posterior à chegada e não conta.
 *
 * A carga:
 *  - pacientes: todas as páginas (100 por linha de página), do mais antigo ao mais novo; teto `MAX_PAGINAS_PACIENTES`;
 *  - leads: janelas de 90 dias para trás até `DIAS_DE_LEADS` (3 anos), cada janela com teto de páginas. Lead mais velho que
 *    isso não entra — o paciente (que vale desde sempre) cobre quem virou paciente;
 *  - incremental depois da primeira carga inteira: só os pacientes novos (a partir da página onde parou, desde que a ordem
 *    "do mais antigo ao mais novo" se confirme) e os leads dos últimos dias; carga completa de novo a cada 7 dias;
 *  - pausa entre chamadas e teto de chamadas por carga: a franquia não pode sentir. Uma carga por vez no processo;
 *  - nunca roda para unidade que não tem a automação ligada ou em seco (`agendarIndice` só é chamado por quem está ativo).
 */
import type { Unit } from '@prisma/client';
import { prisma } from './prisma.js';
import { logger } from './logger.js';
import { chaveTelefone } from './franquia-sync.js';
import { paginaDeTelefones, type SpineItemTelefone, type SpinePaginaTelefones, type SpineResult } from '../services/spine.service.js';

export const POR_PAGINA = 100;
/** 40 mil pacientes. Acima disso a carga é CORTADA e o índice não autoriza Cadastro (o log avisa). */
export const MAX_PAGINAS_PACIENTES = 400;
/** Páginas por janela de leads (3 mil leads em 90 dias). */
export const MAX_PAGINAS_POR_JANELA = 30;
/** Janela de leads: a franquia aceita até 100 dias; 90 deixa folga. */
export const DIAS_POR_JANELA = 90;
/** Quanto da história de LEADS a carga completa cobre. */
export const DIAS_DE_LEADS = 1095;
/** Teto de chamadas por carga (todas as janelas e páginas juntas). */
export const MAX_CHAMADAS_POR_CARGA = 900;
export const PAUSA_ENTRE_CHAMADAS_MS = 350;

/** Índice mais velho que isto não autoriza Cadastro. */
export const VALIDADE_MS = 36 * 3600_000;
/** Recarrega depois disto (a carga leva minutos, então sobra folga até as 36 h). */
export const REFAZER_APOS_MS = 20 * 3600_000;
/** Carga completa (do zero) de novo depois disto; entre elas, incremental. */
export const COMPLETA_A_CADA_MS = 7 * 24 * 3600_000;
/** Espera para tentar de novo depois de um erro / de uma carga cortada pelo teto. */
export const ESPERA_APOS_ERRO_MS = 60 * 60_000;
export const ESPERA_APOS_CORTE_MS = 24 * 3600_000;
/** Os leads são relidos desde alguns dias antes do último dia coberto (cadastro que chegou atrasado). */
const FOLGA_LEADS_DIAS = 3;

const DIA_MS = 86_400_000;

export type Origem = 'paciente' | 'lead';

export interface Entrada {
  chave: string;
  origem: Origem;
  id: number | null;
  criado: Date | null;
}

export interface StatusDoIndice {
  completoEm: Date | null;
  cargaCompletaEm: Date | null;
  tentativaEm: Date | null;
  clientesTotal: number | null;
  leadsAte: string | null;
  resultado: string | null;
}

/** Onde o índice mora. O de verdade é o banco; o teste entrega um em memória. */
export interface Armazem {
  lerStatus(unitId: string): Promise<StatusDoIndice | null>;
  salvarStatus(unitId: string, patch: Partial<StatusDoIndice> & { pacientes?: number; leads?: number; erro?: string | null }): Promise<void>;
  /** Grava as entradas NOVAS (chave+origem já existentes ficam como estão: a primeira lida é a mais antiga). */
  gravar(unitId: string, entradas: Entrada[]): Promise<number>;
  procurar(unitId: string, chave: string): Promise<Entrada[]>;
}

export const armazemPadrao: Armazem = {
  async lerStatus(unitId) {
    const s = await prisma.franquiaIndiceStatus.findUnique({ where: { unitId } });
    return s
      ? { completoEm: s.completoEm, cargaCompletaEm: s.cargaCompletaEm, tentativaEm: s.tentativaEm, clientesTotal: s.clientesTotal, leadsAte: s.leadsAte, resultado: s.resultado }
      : null;
  },
  async salvarStatus(unitId, patch) {
    await prisma.franquiaIndiceStatus.upsert({ where: { unitId }, create: { unitId, ...patch }, update: patch });
  },
  async gravar(unitId, entradas) {
    let novos = 0;
    for (let i = 0; i < entradas.length; i += 1000) {
      const r = await prisma.franquiaTelefone.createMany({
        data: entradas.slice(i, i + 1000).map((e) => ({ unitId, chave: e.chave, origem: e.origem, idNaFranquia: e.id, criadoNaFranquia: e.criado })),
        skipDuplicates: true,
      });
      novos += r.count;
    }
    return novos;
  },
  async procurar(unitId, chave) {
    const linhas = await prisma.franquiaTelefone.findMany({ where: { unitId, chave } });
    return linhas.map((l) => ({ chave: l.chave, origem: l.origem as Origem, id: l.idNaFranquia, criado: l.criadoNaFranquia }));
  },
};

// ── a chave e as entradas (puro) ─────────────────────────────────────────────────────────────

/** Últimos 8 dígitos, ou null se o telefone não tem 8 dígitos (não dá para comparar com segurança). */
export function chaveDoTelefone(bruto: string | null | undefined): string | null {
  const c = chaveTelefone(bruto);
  return c.length === 8 ? c : null;
}

function dataDe(iso: string | null): Date | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? new Date(ms) : null;
}

/**
 * Itens da franquia → entradas, UMA por (telefone, origem): a mais antiga. Dentro de um lote, repetir a chave deixaria o
 * `createMany` ficar com a primeira da lista, não com a mais antiga. Sem telefone utilizável, fora.
 */
export function entradasDosItens(itens: ReadonlyArray<SpineItemTelefone>, origem: Origem): Entrada[] {
  const porChave = new Map<string, Entrada>();
  for (const it of itens) {
    const chave = chaveDoTelefone(it.whatsapp);
    if (!chave) continue;
    const e: Entrada = { chave, origem, id: it.id, criado: dataDe(it.created) };
    const atual = porChave.get(chave);
    // data conhecida e mais antiga vence; sem data nunca substitui uma com data
    if (!atual || (e.criado && (!atual.criado || e.criado < atual.criado))) porChave.set(chave, e);
  }
  return [...porChave.values()];
}

/** AAAA-MM-DD (UTC) de um instante somado de `dias`. */
function diaIso(ms: number, dias = 0): string {
  return new Date(ms + dias * DIA_MS).toISOString().slice(0, 10);
}

/** Janelas [de, até] de `DIAS_POR_JANELA` dias, da mais antiga à mais nova, cobrindo `desde`..`ate` (AAAA-MM-DD). */
export function janelasDeLeads(desde: string, ate: string): Array<{ de: string; ate: string }> {
  const out: Array<{ de: string; ate: string }> = [];
  const fim = Date.parse(`${ate}T00:00:00Z`);
  for (let ini = Date.parse(`${desde}T00:00:00Z`); ini <= fim; ini += DIAS_POR_JANELA * DIA_MS) {
    out.push({ de: diaIso(ini), ate: diaIso(Math.min(fim, ini + (DIAS_POR_JANELA - 1) * DIA_MS)) });
  }
  return out;
}

// ── a carga ────────────────────────────────────────────────────────────────────────────────

export type BuscarPagina = (e: { tipo: 'paciente' } | { tipo: 'lead'; initialDate: string; endDate: string }, page: number) => Promise<SpineResult<SpinePaginaTelefones>>;

export interface DepsDaCarga {
  armazem: Armazem;
  buscar: BuscarPagina;
  pausa: (ms: number) => Promise<void>;
  agora: () => number;
  /** só para teste */
  maxChamadas?: number;
}

export interface ResultadoDaCarga {
  resultado: 'ok' | 'erro' | 'cortado';
  modo: 'completa' | 'incremental';
  chamadas: number;
  pacientes: number;
  leads: number;
  erro?: string;
}

class Parar extends Error {
  constructor(readonly tipo: 'erro' | 'cortado', msg: string) {
    super(msg);
  }
}

/**
 * Uma carga do índice. Nunca lança. Só marca o índice como completo se terminou inteira; o que já foi lido fica gravado
 * mesmo quando a carga é interrompida (a próxima aproveita: gravar é idempotente).
 */
export async function carregarIndice(unit: Pick<Unit, 'id' | 'slug'>, deps: DepsDaCarga): Promise<ResultadoDaCarga> {
  const { armazem, buscar, pausa } = deps;
  const inicio = deps.agora();
  const status = await armazem.lerStatus(unit.id).catch(() => null);
  let modo: 'completa' | 'incremental' =
    status?.cargaCompletaEm && status.clientesTotal !== null && status.leadsAte && inicio - status.cargaCompletaEm.getTime() < COMPLETA_A_CADA_MS ? 'incremental' : 'completa';

  let chamadas = 0;
  let pacientes = 0;
  let leads = 0;
  let totalPacientes: number | null = null;

  const pagina = async (e: Parameters<BuscarPagina>[0], page: number): Promise<SpinePaginaTelefones> => {
    const teto = deps.maxChamadas ?? MAX_CHAMADAS_POR_CARGA;
    if (chamadas >= teto) throw new Parar('cortado', `teto de ${teto} chamadas por carga`);
    if (chamadas > 0) await pausa(PAUSA_ENTRE_CHAMADAS_MS);
    chamadas++;
    const r = await buscar(e, page);
    if (!r.ok || !r.data) throw new Parar('erro', `a franquia não respondeu (${e.tipo}, página ${page}): ${r.error ?? 'sem resposta'}`);
    return r.data;
  };

  try {
    await armazem.salvarStatus(unit.id, { tentativaEm: new Date(inicio) });

    // ── pacientes ──
    const primeira = await pagina({ tipo: 'paciente' }, 1);
    totalPacientes = primeira.total;
    const totalPaginas = primeira.totalPages ?? (primeira.total !== null ? Math.max(1, Math.ceil(primeira.total / POR_PAGINA)) : null);
    if (totalPaginas === null) throw new Parar('erro', 'a franquia não informou o total de páginas de pacientes — não dá para saber se li tudo');

    let comecaEm = 1;
    if (modo === 'incremental') {
      // só vale se a ordem "do mais antigo ao mais novo" se confirma nesta página e a base não encolheu
      const datas = primeira.itens.map((i) => dataDe(i.created)).filter((d): d is Date => d !== null);
      const crescente = datas.length >= 2 && datas[0]! <= datas[datas.length - 1]!;
      const anterior = status!.clientesTotal!;
      if (!crescente || primeira.total === null || primeira.total < anterior) modo = 'completa';
      else comecaEm = Math.max(1, Math.floor(anterior / POR_PAGINA)); // uma página de folga
    }
    if (totalPaginas - comecaEm + 1 > MAX_PAGINAS_PACIENTES) {
      // melhor admitir já do que gastar 400 chamadas para chegar num índice que não vai valer
      await gravarEntradas(unit.id, armazem, primeira.itens, 'paciente').then((n) => (pacientes += n));
      throw new Parar('cortado', `a base tem ${totalPaginas} páginas de pacientes (teto ${MAX_PAGINAS_PACIENTES})`);
    }
    for (let p = comecaEm; p <= totalPaginas; p++) {
      const dados = p === 1 ? primeira : await pagina({ tipo: 'paciente' }, p);
      pacientes += await gravarEntradas(unit.id, armazem, dados.itens, 'paciente');
    }

    // ── leads ──
    const hoje = diaIso(deps.agora());
    const desde = modo === 'incremental' ? diaIso(Date.parse(`${status!.leadsAte}T00:00:00Z`), -FOLGA_LEADS_DIAS) : diaIso(deps.agora(), -DIAS_DE_LEADS);
    for (const janela of janelasDeLeads(desde, hoje)) {
      const e = { tipo: 'lead' as const, initialDate: janela.de, endDate: janela.ate };
      const primeiraJ = await pagina(e, 1);
      const totalJ = primeiraJ.totalPages ?? (primeiraJ.total !== null ? Math.max(1, Math.ceil(primeiraJ.total / POR_PAGINA)) : 1);
      if (totalJ > MAX_PAGINAS_POR_JANELA) {
        await gravarEntradas(unit.id, armazem, primeiraJ.itens, 'lead').then((n) => (leads += n));
        throw new Parar('cortado', `a janela de leads ${janela.de}..${janela.ate} tem ${totalJ} páginas (teto ${MAX_PAGINAS_POR_JANELA})`);
      }
      for (let p = 1; p <= totalJ; p++) {
        const dados = p === 1 ? primeiraJ : await pagina(e, p);
        leads += await gravarEntradas(unit.id, armazem, dados.itens, 'lead');
      }
    }

    const fim = new Date(deps.agora());
    await armazem.salvarStatus(unit.id, {
      completoEm: fim,
      ...(modo === 'completa' ? { cargaCompletaEm: fim } : {}),
      clientesTotal: totalPacientes,
      leadsAte: hoje,
      pacientes,
      leads,
      resultado: 'ok',
      erro: null,
    });
    logger.info({ unit: unit.slug, modo, chamadas, pacientes, leads }, 'franquia-indice: carga inteira');
    return { resultado: 'ok', modo, chamadas, pacientes, leads };
  } catch (err) {
    const tipo = err instanceof Parar ? err.tipo : 'erro';
    const msg = err instanceof Error ? err.message : String(err);
    await armazem.salvarStatus(unit.id, { resultado: tipo, erro: msg.slice(0, 500), pacientes, leads }).catch(() => undefined);
    logger.warn({ unit: unit.slug, modo, chamadas, motivo: msg }, `franquia-indice: carga ${tipo === 'cortado' ? 'CORTADA — o índice não autoriza Cadastro' : 'falhou'}`);
    return { resultado: tipo, modo, chamadas, pacientes, leads, erro: msg };
  }
}

async function gravarEntradas(unitId: string, armazem: Armazem, itens: ReadonlyArray<SpineItemTelefone>, origem: Origem): Promise<number> {
  const entradas = entradasDosItens(itens, origem);
  return entradas.length ? armazem.gravar(unitId, entradas) : 0;
}

// ── a consulta ─────────────────────────────────────────────────────────────────────────────

export interface RespostaDoIndice {
  entradas: Entrada[];
  /** O índice da unidade está inteiro e tem menos de 36 h: autoriza afirmar que o telefone NÃO está na franquia. */
  fresco: boolean;
  /** há quantas horas a última carga inteira terminou (null = nunca) */
  idadeHoras: number | null;
}

export function indiceFresco(status: Pick<StatusDoIndice, 'completoEm'> | null, agora: number): boolean {
  return !!status?.completoEm && agora - status.completoEm.getTime() <= VALIDADE_MS;
}

/** Lança se o banco falhar (quem chama trata como "índice desconhecido": nunca vira Cadastro). */
export async function consultarIndice(unitId: string, chave: string, armazem: Armazem = armazemPadrao, agora: number = Date.now()): Promise<RespostaDoIndice> {
  const [status, entradas] = await Promise.all([armazem.lerStatus(unitId), armazem.procurar(unitId, chave)]);
  return {
    entradas,
    fresco: indiceFresco(status, agora),
    idadeHoras: status?.completoEm ? Math.round((agora - status.completoEm.getTime()) / 360_000) / 10 : null,
  };
}

// ── quando carregar ────────────────────────────────────────────────────────────────────────

/** Puro. Hora de carregar? Nunca carregou, ou passou de 20 h — respeitando a espera depois de erro/corte. */
export function precisaCarregar(status: StatusDoIndice | null, agora: number): boolean {
  if (!status) return true;
  if (status.tentativaEm) {
    const espera = status.resultado === 'cortado' ? ESPERA_APOS_CORTE_MS : status.resultado === 'erro' ? ESPERA_APOS_ERRO_MS : 5 * 60_000;
    if (agora - status.tentativaEm.getTime() < espera) return false;
  }
  return !status.completoEm || agora - status.completoEm.getTime() >= REFAZER_APOS_MS;
}

/** Cargas em andamento / fila: uma por vez em todo o processo (a franquia não pode sentir 22 unidades de uma vez). */
const emCurso = new Set<string>();
let fila: Promise<unknown> = Promise.resolve();

const depsPadrao = (unit: Unit): DepsDaCarga => ({
  armazem: armazemPadrao,
  buscar: (e, page) => paginaDeTelefones(unit, e, page),
  pausa: (ms) => new Promise((r) => setTimeout(r, ms)),
  agora: () => Date.now(),
});

/**
 * Pede a carga do índice desta unidade se for hora, em segundo plano e sem esperar. Barato quando não é hora (uma leitura
 * do status). Nunca lança. Quem chama só deve pedir para unidade COM a automação em seco ou ligada.
 */
export function agendarIndice(unit: Unit, deps: DepsDaCarga = depsPadrao(unit)): void {
  if (!unit.spineEnabled || !unit.spineToken || emCurso.has(unit.id)) return;
  emCurso.add(unit.id);
  fila = fila
    .then(async () => {
      const status = await deps.armazem.lerStatus(unit.id).catch(() => null);
      if (!precisaCarregar(status, deps.agora())) return;
      await carregarIndice(unit, deps);
    })
    .catch((err) => logger.warn({ err: String(err), unit: unit.slug }, 'franquia-indice: falha ao carregar'))
    .finally(() => emCurso.delete(unit.id));
}

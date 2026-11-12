/**
 * Contatos duplicados no Chatwoot (decisão 22 do João, 12/11/2026) — automação `chatwoot-duplicados`, padrão DESLIGADO.
 *
 * O mesmo paciente aparece com e sem o 9 (o WhatsApp entrega 559484325883, o cadastro tem 5594984325883). A cada 30 min lê os
 * contatos da conta e agrupa pela chave DDD + 8 últimos dígitos (só número do Brasil, 55 + 10 ou 11 dígitos).
 *  - SÓ NO PAPEL: deixa uma NOTA no contato mais antigo: «🧪 [SECO] Juntaria o contato #X …». Uma vez por par (confere as notas).
 *  - LIGADO: junta (POST actions/contact_merge: o mais antigo fica, as conversas do outro passam para ele, o outro SOME) e deixa
 *    nota «🔗 Juntei o contato #X …» no que ficou.
 * Juntar NÃO TEM VOLTA: teto de junções por ciclo; o estado vem da unidade da caixa do mapa (hoje só Parauapebas).
 */
import { logger } from './logger.js';
import { estadoDaAutomacao, type Estado } from './automacoes-estado.js';
import { chamar, contaChatwootDoAmbiente, criarContextoChatwoot, type ContextoChatwoot } from '../mcp-remoto/chatwoot.js';
import { CAIXAS_REGUA } from './chatwoot-regua.js';

export const ID_DUPLICADOS = 'chatwoot-duplicados';
export const MAX_JUNCOES_POR_CICLO = 5;
const MAX_PAGINAS = 100;
const SWEEP_MS = 30 * 60_000;
const PRIMEIRA_MS = 200_000;

export interface Contato {
  id: number;
  nome: string;
  telefone: string;
}

/** DDD + 8 últimos dígitos de um telefone do Brasil; null = não é celular/fixo brasileiro completo. */
export function chaveDoTelefone(telefone: string | null | undefined): string | null {
  const d = String(telefone ?? '').replace(/\D/g, '');
  if (!d.startsWith('55') || (d.length !== 12 && d.length !== 13)) return null;
  return d.slice(2, 4) + d.slice(-8);
}

/** Grupos de contatos com a mesma chave: [o que fica (id menor = mais antigo), ...os que entram nele]. */
export function gruposDuplicados(contatos: readonly Contato[]): Array<{ fica: Contato; entram: Contato[] }> {
  const porChave = new Map<string, Contato[]>();
  for (const c of contatos) {
    const k = chaveDoTelefone(c.telefone);
    if (!k) continue;
    const g = porChave.get(k) ?? [];
    if (!g.some((x) => x.id === c.id)) g.push(c);
    porChave.set(k, g);
  }
  const saida: Array<{ fica: Contato; entram: Contato[] }> = [];
  for (const g of porChave.values()) {
    if (g.length < 2) continue;
    const ordem = [...g].sort((a, b) => a.id - b.id);
    saida.push({ fica: ordem[0]!, entram: ordem.slice(1) });
  }
  return saida;
}

const descrever = (c: Contato) => `#${c.id} (${[c.nome, c.telefone].filter(Boolean).join(', ')})`;
export const notaSeco = (fica: Contato, entra: Contato) =>
  `🧪 [SECO] Juntaria o contato ${descrever(entra)} neste (${fica.telefone}): mesmo DDD e mesmos 8 últimos dígitos. Ligado, as conversas dele passam para cá e ele some.`;
export const notaJuntou = (fica: Contato, entra: Contato) =>
  `🔗 Juntei o contato ${descrever(entra)} neste (${fica.telefone}): mesmo DDD e mesmos 8 últimos dígitos (com e sem o 9).`;

export interface PortasDuplicados {
  pagina(n: number): Promise<Contato[]>;
  notas(contato: number): Promise<string[]>;
  nota(contato: number, texto: string): Promise<void>;
  juntar(fica: number, entra: number): Promise<void>;
}

export function portasDoChatwoot(ctx: ContextoChatwoot): PortasDuplicados {
  return {
    async pagina(n) {
      const r = (await chamar(ctx, 'GET', 'contacts', { query: { page: String(n) } })) as { payload?: any[] } | null;
      return (Array.isArray(r?.payload) ? r.payload : []).map((c) => ({ id: Number(c?.id), nome: String(c?.name ?? '').trim(), telefone: String(c?.phone_number ?? '') }));
    },
    async notas(contato) {
      const r = (await chamar(ctx, 'GET', `contacts/${contato}/notes`)) as any;
      const lista: any[] = Array.isArray(r) ? r : Array.isArray(r?.payload) ? r.payload : [];
      return lista.map((n) => String(n?.content ?? ''));
    },
    async nota(contato, texto) {
      await chamar(ctx, 'POST', `contacts/${contato}/notes`, { corpo: { content: texto } });
    },
    async juntar(fica, entra) {
      await chamar(ctx, 'POST', 'actions/contact_merge', { corpo: { base_contact_id: fica, mergee_contact_id: entra } });
    },
  };
}

export async function cicloDuplicados(p: PortasDuplicados, modo: 'seco' | 'ligado'): Promise<{ grupos: number; notas: number; juntados: number; falhas: number }> {
  const contatos: Contato[] = [];
  for (let n = 1; n <= MAX_PAGINAS; n++) {
    const pg = await p.pagina(n);
    if (!pg.length) break;
    contatos.push(...pg.filter((c) => Number.isInteger(c.id) && c.id > 0));
  }
  const grupos = gruposDuplicados(contatos);
  const r = { grupos: grupos.length, notas: 0, juntados: 0, falhas: 0 };
  for (const { fica, entram } of grupos) {
    for (const entra of entram) {
      try {
        if (modo === 'seco') {
          const marca = `contato #${entra.id} `;
          if ((await p.notas(fica.id)).some((t) => t.includes('[SECO] Juntaria') && t.includes(marca))) continue;
          await p.nota(fica.id, notaSeco(fica, entra));
          r.notas++;
        } else {
          if (r.juntados >= MAX_JUNCOES_POR_CICLO) continue;
          await p.juntar(fica.id, entra.id);
          r.juntados++;
          await p.nota(fica.id, notaJuntou(fica, entra)).catch(() => undefined);
        }
      } catch (err) {
        r.falhas++;
        logger.warn({ err: String(err), fica: fica.id, entra: entra.id, modo }, `${ID_DUPLICADOS}: falhou num par`);
      }
    }
  }
  logger.info({ modo, contatos: contatos.length, ...r }, `${ID_DUPLICADOS}: ciclo`);
  return r;
}

/** O estado vem da unidade da caixa do mapa (a conta do Chatwoot hoje é de uma unidade só). */
export const estadoDuplicados = (): Estado => {
  const slug = Object.values(CAIXAS_REGUA)[0];
  return slug ? estadoDaAutomacao(slug, ID_DUPLICADOS, process.env.CHATWOOT_DUPLICADOS_SLUGS) : 'desligado';
};

let timer: NodeJS.Timeout | null = null;
let rodando = false;

async function varrer(ctx: ContextoChatwoot): Promise<void> {
  if (rodando) return;
  const modo = estadoDuplicados();
  if (modo === 'desligado') return;
  rodando = true;
  try {
    await cicloDuplicados(portasDoChatwoot(ctx), modo);
  } catch (err) {
    logger.warn({ err: String(err) }, `${ID_DUPLICADOS}: ciclo falhou — tento no próximo`);
  } finally {
    rodando = false;
  }
}

export function startChatwootDuplicadosWorker(): void {
  if (timer) return;
  const conta = contaChatwootDoAmbiente();
  if (!conta) return;
  const ctx = criarContextoChatwoot(conta);
  setTimeout(() => void varrer(ctx), PRIMEIRA_MS);
  timer = setInterval(() => void varrer(ctx), SWEEP_MS);
  logger.info(`${ID_DUPLICADOS}: worker iniciado`);
}

export function stopChatwootDuplicadosWorker(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

/**
 * ANIVERSÁRIO no CRM (rotina da Kommo trazida para o Chatwoot, 14/11/2026). Este arquivo só responde «quem faz anos e a franquia confirma»;
 * quem manda a mensagem é a régua (`candidatos()`, regras `aniversario` / `aniversario-tratamento`, 9–12 h, até 3 dias de atraso, 1 por ano).
 *
 * A DATA É DA FRANQUIA e só vale com CASAMENTO SEGURO. O Chatwoot não guarda idClient nem nascimento, então cada conversa é ligada à ficha assim:
 * a busca por nome da franquia só vale se houver UMA ficha com o nome COMPLETO igual (sem acento e caixa) E o WhatsApp da ficha igual ao da conversa
 * (DDI+DDD e 8 últimos dígitos). Nome parecido, dois com o mesmo nome, ficha sem WhatsApp, WhatsApp de outra pessoa: não casa, não manda.
 * (Memória do projeto: marcar a identidade a partir do 1º resultado de uma busca ambígua é para sempre — aqui nada é gravado, e mesmo assim só o seguro vale.)
 * A trava de falecido lê o `status` da ficha, mas NÃO TEM PROVA (só se viu «ATIVO»); o que protege de verdade é o sem-follow-up.
 */
import { logger } from './logger.js';
import { mesmoTelefone } from './chatwoot-lida.js';
import { diaEmBelem } from './chatwoot-regua.js';
import type { ConversaRegua } from './chatwoot-regua.js';

export const ATRASO_MAX_DO_ANIVERSARIO_DIAS = 3;
/** a franquia só é consultada de manhã (8–13 h de Belém): a mensagem sai das 9 às 12 */
export const HORAS_DE_CONSULTA = [8, 13] as const;
const MAX_BUSCAS_NOVAS_POR_CICLO = 120;
const VALIDADE_DA_BUSCA_MS = 6 * 3600_000;
const VALIDADE_DA_FICHA_MS = 24 * 3600_000;

const semAcento = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();

/** O dia (AAAA-MM-DD) que a ficha diz (ISO ou dd/mm/aaaa), ou null. */
export function diaDeNascimentoDaFicha(bruto: string | null | undefined): string | null {
  const s = String(bruto ?? '').trim();
  const br = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(s);
  const iso = br ? `${br[3]}-${br[2]}-${br[1]}` : /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : null;
  return iso && !Number.isNaN(Date.parse(`${iso}T12:00:00Z`)) ? iso : null;
}

const dias = (iso: string, n: number): string => new Date(Date.parse(`${iso}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

/**
 * O aniversário que vale agora: o dia (AAAA-MM-DD, deste ano) de hoje ou dos `atrasoMax` dias anteriores em que a pessoa faz anos, ou null.
 * 29/02 comemora em 28/02 nos anos sem bissexto. Ano de nascimento absurdo (futuro, antes de 1900) = null: data digitada errada é pior que não mandar.
 */
export function ocorrenciaDoAniversario(nascimento: string | null, hoje: string, atrasoMax = ATRASO_MAX_DO_ANIVERSARIO_DIAS): string | null {
  const dia = diaDeNascimentoDaFicha(nascimento);
  if (!dia) return null;
  const ano = Number(dia.slice(0, 4));
  if (ano < 1900 || ano >= Number(hoje.slice(0, 4))) return null;
  const md = dia.slice(5);
  for (let k = 0; k <= atrasoMax; k++) {
    const d = dias(hoje, -k);
    const y = Number(d.slice(0, 4));
    const bissexto = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
    if (md === d.slice(5) || (md === '02-29' && !bissexto && d.slice(5) === '02-28')) return d;
  }
  return null;
}

/** Texto da ficha que a franquia chama de óbito: nunca recebe parabéns. SEM PROVA em ficha real: «se aparecer». */
export function statusDeFalecido(status: string | null | undefined): boolean {
  return /[oó]bito|falec|faleceu/i.test(String(status ?? ''));
}

export interface ClienteDaBusca {
  idClient: number | null;
  name: string | null;
  whatsapp: string | null;
}

/** O idClient SÓ se há exatamente uma ficha com o nome completo igual E o WhatsApp igual ao da conversa; senão null. */
export function casamentoSeguro(clientes: readonly ClienteDaBusca[], nome: string, telefone: string): number | null {
  const n = semAcento(nome);
  if (n.split(' ').length < 2) return null; // só o primeiro nome não identifica ninguém
  const iguais = clientes.filter((c) => c.idClient !== null && c.name !== null && semAcento(c.name) === n);
  if (iguais.length !== 1) return null;
  const c = iguais[0]!;
  const fone = String(c.whatsapp ?? '').replace(/\D/g, '');
  if (!fone || !mesmoTelefone(fone.length <= 11 ? `55${fone}` : fone, telefone)) return null;
  return c.idClient;
}

export interface DepsDoAniversario {
  buscar(nome: string): Promise<ClienteDaBusca[] | null>;
  ficha(idClient: number): Promise<{ birthdate: string | null; status: string | null } | null>;
  dormir(ms: number): Promise<void>;
}

const buscasFeitas = new Map<string, { ate: number; id: number | null }>();
const fichasLidas = new Map<number, { ate: number; birthdate: string | null; status: string | null }>();
export function _esquecerAniversariantes(): void {
  buscasFeitas.clear();
  fichasLidas.clear();
}

/**
 * conversa → aniversário confirmado (AAAA-MM-DD). Fora de 8–13 h de Belém não consulta nada. Cada nome é buscado uma vez a cada 6 h (inclusive
 * o «não casou») e cada ficha uma vez por dia; no máximo 120 buscas novas por ciclo — o universo vai sendo coberto ciclo a ciclo.
 */
export async function aniversariantesDaFranquia(deps: DepsDoAniversario, slug: string, conversas: readonly ConversaRegua[], agora: Date): Promise<Map<number, string>> {
  const saida = new Map<number, string>();
  const hora = new Date(agora.getTime() - 3 * 3600_000).getUTCHours();
  if (hora < HORAS_DE_CONSULTA[0] || hora >= HORAS_DE_CONSULTA[1]) return saida;
  const hoje = diaEmBelem(agora);
  let novas = 0;
  for (const c of conversas) {
    if (!c.telefone || !c.nome.trim() || c.etiquetas.includes('interno')) continue;
    const k = `${slug}|${semAcento(c.nome)}|${c.telefone.replace(/\D/g, '')}`;
    let achado = buscasFeitas.get(k);
    if (!achado || achado.ate < agora.getTime()) {
      if (novas >= MAX_BUSCAS_NOVAS_POR_CICLO) continue;
      novas++;
      const lista = await deps.buscar(c.nome.trim()).catch(() => null);
      if (lista === null) continue; // a franquia não respondeu: tenta no próximo ciclo (não guarda o «não»)
      achado = { ate: agora.getTime() + VALIDADE_DA_BUSCA_MS, id: casamentoSeguro(lista, c.nome, c.telefone) };
      buscasFeitas.set(k, achado);
      await deps.dormir(250);
    }
    if (achado.id === null) continue;
    let ficha = fichasLidas.get(achado.id);
    if (!ficha || ficha.ate < agora.getTime()) {
      const f = await deps.ficha(achado.id).catch(() => null);
      if (!f) continue;
      ficha = { ate: agora.getTime() + VALIDADE_DA_FICHA_MS, birthdate: f.birthdate, status: f.status };
      fichasLidas.set(achado.id, ficha);
      await deps.dormir(250);
    }
    if (statusDeFalecido(ficha.status)) continue;
    const dia = ocorrenciaDoAniversario(ficha.birthdate, hoje);
    if (dia) saida.set(c.id, dia);
  }
  if (saida.size) logger.info({ slug, aniversariantes: saida.size }, 'chatwoot-aniversario: aniversariantes confirmados pela franquia');
  return saida;
}

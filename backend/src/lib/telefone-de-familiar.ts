/**
 * Telefone do paciente mandado por um familiar no chat → vira contato do MESMO cartão (Olímpia, 21/10/2026).
 *
 * Caso Aline × Nilson (Olímpia, leads 5441607 e 5734865): a esposa conversou, marcou a consulta e a equipe
 * preencheu o cartão dela. Em 21/10 09:26 ela mandou, em três mensagens, "Bom dia" / "17991135549" / "Esse é o
 * número dele, se puder mandar msg para ele". A equipe escreveu para o número — que não estava em contato
 * nenhum — e o Kommo abriu um cartão NOVO e vazio. A Sofia tratou o paciente como desconhecido ("Como posso te
 * chamar?") e a negociação ficou partida em dois cartões.
 *
 * O Kommo cola a conversa no contato cujo telefone bate como texto (caso Wilson, cadastro-duplicado.ts). Então,
 * se o número entra como contato do cartão ANTES de alguém escrever para ele, a conversa dele cai aqui. Grava nos
 * dois formatos, com e sem o nono dígito: no caso Wilson o WhatsApp entregou o número sem o 9 e não casou.
 *
 * Só com o número E uma palavra que diga de quem é ("dele", "do meu marido", "esse é o número"), nas últimas
 * mensagens do paciente — a Aline mandou o número numa mensagem e o "é dele" na seguinte. Telefone solto pode ser
 * da clínica, do trabalho, de outro médico. CPF não entra (dígito verificador e a palavra "CPF" na linha).
 *
 * Atrás da chave `telefone-de-familiar` (TELEFONE_FAMILIAR_SLUGS), que nasce em "só no papel": a tela mostra
 * "gravaria contato do cartão" com o número, e nada muda no Kommo até ligar a unidade.
 */
import type { Unit } from '@prisma/client';
import type { KommoClient } from '../services/kommo.service.js';
import { prisma } from './prisma.js';
import { logger } from './logger.js';
import { chaveTelefone } from './franquia-sync.js';
import { mesmoTelefoneCompleto } from './ponte-duplicados.js';
import { estadoDaAutomacao, type Estado } from './automacoes-estado.js';
import { registrarSimulacao } from './so-no-papel.js';
import { claimMessageId } from './dedup-cache.js';

export const AUTOMACAO_TELEFONE_FAMILIAR = 'telefone-de-familiar';

export function estadoDoTelefoneDeFamiliar(slug: string, env: NodeJS.ProcessEnv = process.env): Estado {
  return estadoDaAutomacao(slug, AUTOMACAO_TELEFONE_FAMILIAR, env.TELEFONE_FAMILIAR_SLUGS);
}

// ── parte pura ──────────────────────────────────────────────────────────────────────────────────

/** Falas do paciente olhadas juntas: o número numa mensagem, o "é dele" na seguinte. */
export const FALAS_OLHADAS = 3;
/** Só as falas recentes: um número de semana passada não é "o número dele" de hoje. */
export const JANELA_FALAS_MIN = 15;

const DDDS = new Set(
  '11 12 13 14 15 16 17 18 19 21 22 24 27 28 31 32 33 34 35 37 38 41 42 43 44 45 46 47 48 49 51 53 54 55 61 62 63 64 65 66 67 68 69 71 73 74 75 77 79 81 82 83 84 85 86 87 88 89 91 92 93 94 95 96 97 98 99'.split(
    ' ',
  ),
);

/** Número escrito com ou sem +55, parênteses, espaço, ponto ou traço. */
const NUMERO = /(?<![\d])(?:\+?\s*55[\s.-]*)?\(?\s*\d{2}\s*\)?[\s.-]*9?\s*\d{4}[\s.-]*\d{4}(?![\d])/g;

/** Palavra que diz que o número é de OUTRA pessoa — o paciente, um parente. */
const DE_QUEM = new RegExp(
  [
    String.raw`\bd[eo]l[ea]s?\b`,
    String.raw`\b(?:do|da)\s+(?:meu|minha)\s+(?:marido|esposo|esposa|mulher|filh[oa]|pai|m[aã]e|irm[aã]o?|namorad[oa]|av[oóô]|net[oa]|sogr[oa]|genro|nora|ti[oa]|prim[oa]|cunhad[oa]|companheir[oa])\b`,
    String.raw`\b(?:esse|este|segue|aqui)\s+(?:[eé]\s+)?o\s+(?:n[uú]mero|contato|zap|whats(?:app)?|telefone|celular)\b`,
    String.raw`\b(?:mand[ae]r?|chama(?:r)?|liga(?:r)?|fala(?:r)?)\s+(?:(?:uma\s+)?(?:msg|mensagem)\s+)?(?:pra|para|com)\s+(?:ele|ela)\b`,
  ].join('|'),
  'i',
);

/** Linha que fala de documento ou pagamento: o número ali não é telefone. */
const NAO_E_TELEFONE = /\b(?:cpf|rg|cnpj|pix|chave|carteirinha|cart[aã]o|protocolo|pedido|c[oó]digo|boleto|conta|ag[eê]ncia|cep|sus)\b/i;

function cpfValido(d: string): boolean {
  if (d.length !== 11 || /^(\d)\1{10}$/.test(d)) return false;
  const dv = (n: number) => {
    let s = 0;
    for (let i = 0; i < n; i++) s += Number(d[i]) * (n + 1 - i);
    const r = (s * 10) % 11;
    return r === 10 ? 0 : r;
  };
  return dv(9) === Number(d[9]) && dv(10) === Number(d[10]);
}

/**
 * Os dígitos viram "55" + DDD + número de celular com o nono dígito, ou nulo. Só celular (é o que tem WhatsApp):
 * 9 dígitos começando com 9, ou 8 dígitos começando com 6–9 (o número antigo, sem o 9).
 */
export function normalizarCelular(bruto: string): string | null {
  let d = bruto.replace(/\D+/g, '');
  if ((d.length === 12 || d.length === 13) && d.startsWith('55')) d = d.slice(2);
  if (d.length !== 10 && d.length !== 11) return null;
  const ddd = d.slice(0, 2);
  const numero = d.slice(2);
  if (!DDDS.has(ddd)) return null;
  if (numero.length === 9 && numero[0] !== '9') return null;
  if (numero.length === 8 && !/^[6-9]/.test(numero)) return null;
  return `55${ddd}${numero.length === 8 ? `9${numero}` : numero}`;
}

/** "+55 17 99113-5549" e "+55 17 9113-5549": os dois formatos em que o WhatsApp pode entregar o número. */
export function formatosDoCelular(n: string): string[] {
  const ddd = n.slice(2, 4);
  const num = n.slice(4);
  const sem9 = num.slice(1);
  return [`+55 ${ddd} ${num.slice(0, 5)}-${num.slice(5)}`, `+55 ${ddd} ${sem9.slice(0, 4)}-${sem9.slice(4)}`];
}

/**
 * PURA: nas falas recentes do paciente (da mais antiga para a mais nova), um celular que é de OUTRA pessoa. Nulo
 * se não tem número, se tem mais de um número diferente (não dá para saber qual), se nada diz de quem é, ou se o
 * número está numa linha de documento/pagamento.
 */
export function telefoneDeFamiliar(falas: ReadonlyArray<string>): string | null {
  const texto = falas.slice(-FALAS_OLHADAS).join('\n');
  if (!DE_QUEM.test(texto)) return null;
  const achados = new Set<string>();
  for (const linha of texto.split(/\n+/)) {
    for (const m of linha.matchAll(NUMERO)) {
      const digitos = m[0].replace(/\D+/g, '');
      if (NAO_E_TELEFONE.test(linha) || cpfValido(digitos)) continue;
      const n = normalizarCelular(digitos);
      if (n) achados.add(n);
    }
  }
  return achados.size === 1 ? [...achados][0] : null;
}

/** O título do cartão sem a data do fim e sem "Lead #123": "Nilson Nunes da Silva 15/10/2026" → "Nilson Nunes da Silva". */
export function nomeDoTitulo(titulo: string | null | undefined): string | null {
  const t = String(titulo ?? '')
    .replace(/\s*\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\s*$/, '')
    .trim();
  if (!t || /^lead\b/i.test(t) || !/\p{L}{2}/u.test(t)) return null;
  return t;
}

/**
 * O nome do contato novo. O título do cartão costuma ser o nome do PACIENTE (a equipe renomeia: no caso da Aline, o
 * título já era "Nilson Nunes da Silva"); se o título é o nome de quem está escrevendo, não serve.
 */
export function nomeDoContatoNovo(titulo: string | null | undefined, remetente: string | null | undefined): string {
  const doTitulo = nomeDoTitulo(titulo);
  const quem = String(remetente ?? '').trim();
  const primeiro = (s: string) => s.split(/\s+/)[0]?.toLowerCase() ?? '';
  if (doTitulo && (!quem || primeiro(doTitulo) !== primeiro(quem))) return doTitulo;
  return quem ? `Telefone enviado por ${quem}` : 'Telefone enviado no chat';
}

export function textoDaNota(a: { formatado: string; remetente: string | null; contatoNovo: boolean; outrosCartoes: number[] }): string {
  const quem = a.remetente?.trim() || 'o contato deste cartão';
  const linhas = [
    `📞 Telefone enviado no chat por ${quem}: ${a.formatado}.`,
    a.contatoNovo
      ? 'Adicionado como contato DESTE cartão: quando a equipe ou a Sofia escreverem para ele, a conversa cai aqui.'
      : 'O número já era um contato e foi ligado a este cartão também.',
  ];
  if (a.outrosCartoes.length) {
    linhas.push(`Atenção: esse número já tem outro cartão (${a.outrosCartoes.join(', ')}) — confira e use Mesclar no Kommo.`);
  }
  return linhas.join('\n');
}

// ── com Kommo ───────────────────────────────────────────────────────────────────────────────────

/**
 * Uma vez por cartão + número por processo: as próximas mensagens dos 15 minutos achariam o mesmo número de novo, e
 * isto poupa a busca no Kommo. Quem garante "um contato só" é o `claimMessageId` (no banco), porque o webhook e o
 * widget podem chegar juntos e o servidor roda em mais de uma cópia.
 */
const vistos = new Set<string>();
const PRAZO_DA_TRAVA_MS = 24 * 3600_000;

async function falasRecentes(conversationId: string): Promise<string[]> {
  const desde = new Date(Date.now() - JANELA_FALAS_MIN * 60_000);
  const msgs = await prisma.message.findMany({
    where: { conversationId, role: 'user', createdAt: { gte: desde } },
    orderBy: { createdAt: 'desc' },
    take: FALAS_OLHADAS,
    select: { content: true },
  });
  return msgs.map((m) => m.content ?? '').reverse();
}

/**
 * Chamada a cada mensagem do paciente, em segundo plano (nunca segura a resposta). Desligada = nada; "só no papel"
 * = registra o que faria; ligada = liga o número ao cartão (contato que já existe, ou um novo) e deixa nota.
 */
export async function telefoneDeFamiliarNoCartao(
  unit: Unit,
  a: { kommo: KommoClient; leadId: number; conversationId: string; remetente?: string | null },
): Promise<void> {
  const estado = estadoDoTelefoneDeFamiliar(unit.slug);
  if (estado === 'desligado' || !Number.isFinite(a.leadId) || a.leadId <= 0) return;
  const numero = telefoneDeFamiliar(await falasRecentes(a.conversationId));
  if (!numero) return;
  const chave = `${unit.id}:${a.leadId}:${numero}`;
  if (vistos.has(chave)) return;
  vistos.add(chave);

  const [formatado] = formatosDoCelular(numero);
  const encontrados = await a.kommo.buscarContatosPorTexto(chaveTelefone(numero), 10);
  const fones = await a.kommo.telefonesDosContatos(encontrados.map((c) => c.id));
  const mesmos = encontrados.filter((c) => mesmoTelefoneCompleto(fones.get(c.id), numero));
  if (mesmos.some((c) => c._embedded?.leads?.some((l) => l.id === a.leadId))) return; // já está no cartão
  const outrosCartoes = [...new Set(mesmos.flatMap((c) => (c._embedded?.leads ?? []).map((l) => l.id)))];

  if (estado === 'seco') {
    registrarSimulacao(unit, AUTOMACAO_TELEFONE_FAMILIAR, {
      leadId: a.leadId,
      acao: 'gravaria',
      alvo: 'contato do cartão',
      valor: formatado,
      motivo: mesmos.length
        ? `o número já é o contato ${mesmos[0].id}${outrosCartoes.length ? ` (cartões ${outrosCartoes.join(', ')})` : ''}`
        : 'contato novo',
    });
    return;
  }

  if (!(await claimMessageId('telefone-familiar', chave, PRAZO_DA_TRAVA_MS))) return;

  let contatoId = mesmos[0]?.id ?? null;
  const contatoNovo = !contatoId;
  if (!contatoId) {
    const lead = await a.kommo.getLead(a.leadId).catch(() => null);
    contatoId = await a.kommo.criarContato({
      nome: nomeDoContatoNovo(lead?.name, a.remetente),
      telefones: formatosDoCelular(numero),
    });
  }
  if (!contatoId) {
    logger.warn({ unit: unit.slug, leadId: a.leadId }, 'telefone-de-familiar: o Kommo não criou o contato');
    return;
  }
  await a.kommo.vincularContatoAoLead(a.leadId, contatoId);
  await a.kommo.addLeadNote(a.leadId, textoDaNota({ formatado, remetente: a.remetente ?? null, contatoNovo, outrosCartoes }));
  logger.info({ unit: unit.slug, leadId: a.leadId, contatoId, contatoNovo, outrosCartoes }, 'telefone-de-familiar: número ligado ao cartão');
}

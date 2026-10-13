/**
 * "Impressão" de uma mensagem do paciente — o jeito da extensão Ponte (WhatsApp Web → cartão do Kommo)
 * apontar a conversa sem que o texto saia do navegador da atendente (13/10/2026).
 *
 * A extensão manda só isto: o SHA-256 de `<texto normalizado>|<HH:MM>` de cada uma das últimas
 * mensagens RECEBIDAS da conversa aberta, com o minuto no fuso de São Paulo. O servidor calcula o mesmo
 * hash sobre as mensagens do paciente que já guarda (tabela `messages`, unidades com a Sofia) e acha a
 * conversa — sem nunca receber o texto. Nada disto é gravado: as impressões vivem só na requisição.
 *
 * CONTRATO COM A EXTENSÃO: `extensao-ponte/impressao.js` tem a MESMA normalização e o MESMO hash em JS.
 * Mudou aqui, muda lá — `ponte-impressao.test.ts` carrega o arquivo da extensão e compara as duas saídas
 * sobre os vetores fixos de `extensao-ponte/testes/vetores-impressao.json`; se divergirem, o teste quebra.
 */
import { createHash } from 'node:crypto';

export const FUSO_DA_IMPRESSAO = 'America/Sao_Paulo';

/**
 * Minúsculas, sem acento, e TUDO que não é letra ou dígito vira um espaço só.
 *
 * Tirar a pontuação (e não só colapsar os espaços) é de propósito: o WhatsApp Web não mostra o texto cru.
 * `*negrito*` aparece sem os asteriscos, emoji vira `<img>`, link vira `<a>`, quebra de linha vira bloco.
 * O que a extensão lê na tela e o que o Kommo nos entregou só batem depois de ficarem apenas as letras e
 * os números. Mensagem que é só emoji ou só pontuação fica vazia — e mensagem vazia não tem impressão.
 */
export function normalizarParaImpressao(texto: string | null | undefined): string {
  return String(texto ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

const MINUTO = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Hash de um texto JÁ normalizado num minuto. Separado para o servidor normalizar uma vez e variar o minuto. */
function hashDoNormalizado(normalizado: string, minuto: string): string {
  return createHash('sha256').update(`${normalizado}|${minuto}`, 'utf8').digest('hex');
}

/** A impressão de uma mensagem: `null` quando o texto fica vazio depois de normalizar ou o minuto não é HH:MM. */
export function impressaoDaMensagem(texto: string | null | undefined, minuto: string): string | null {
  const n = normalizarParaImpressao(texto);
  if (!n || !MINUTO.test(minuto)) return null;
  return hashDoNormalizado(n, minuto);
}

// Um formatador por fuso, reaproveitado: criar `Intl.DateTimeFormat` custa caro, e o passo da impressão formata
// a hora de milhares de mensagens por chamada (a revisão mediu 1,4 s de laço de eventos travado criando um por vez).
const formatadores = new Map<string, Intl.DateTimeFormat>();
function formatadorDoFuso(tz: string): Intl.DateTimeFormat {
  let f = formatadores.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', hour: '2-digit', minute: '2-digit' });
    formatadores.set(tz, f);
  }
  return f;
}

const dois = (n: number) => String(n).padStart(2, '0');

/** "HH:MM" (00–23) do instante no fuso pedido. */
export function minutoNoFuso(d: Date, tz: string = FUSO_DA_IMPRESSAO): string {
  const partes = formatadorDoFuso(tz).formatToParts(d);
  const pega = (t: string) => Number(partes.find((p) => p.type === t)?.value ?? '0');
  return `${dois(pega('hour') % 24)}:${dois(pega('minute'))}`;
}

/** "10:01" + (-2) → "09:59", dando a volta na meia-noite. */
function somarMinutos(hhmm: string, delta: number): string {
  const total = (((Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3)) + delta) % 1440) + 1440) % 1440;
  return `${dois(Math.floor(total / 60))}:${dois(total % 60)}`;
}

/**
 * Os minutos em que uma mensagem GUARDADA pode ter aparecido na tela do WhatsApp.
 *
 * O WhatsApp mostra a hora em que o paciente mandou; o nosso `createdAt` é a hora em que o webhook do
 * Kommo chegou aqui — depois, às vezes um ou dois minutos depois. Por isso vale o minuto gravado e os dois
 * anteriores. E um minuto para frente, para o relógio do servidor que estiver uns segundos atrasado na virada.
 */
export function minutosDaMensagemGuardada(em: Date, tz: string = FUSO_DA_IMPRESSAO): string[] {
  const base = minutoNoFuso(em, tz);
  return [-2, -1, 0, 1].map((m) => somarMinutos(base, m));
}

const HASH = /^[0-9a-f]{64}$/;

/** Só o que parece SHA-256 em hex, sem repetição, no máximo `max`. Qualquer outra coisa é descartada calada. */
export function impressoesValidas(bruto: unknown, max = 8): string[] {
  const lista = Array.isArray(bruto) ? bruto : typeof bruto === 'string' ? bruto.split(',') : [];
  const out: string[] = [];
  for (const item of lista) {
    const h = typeof item === 'string' ? item.trim().toLowerCase() : '';
    if (HASH.test(h) && !out.includes(h)) out.push(h);
    if (out.length >= max) break;
  }
  return out;
}

export interface MensagemGuardada {
  /** Id do cartão no Kommo (é o `leadId` da conversa — texto no banco). */
  leadId: string;
  texto: string;
  em: Date;
}

export type ResultadoDaImpressao = { leadId: string; batidas: number } | { ambiguo: true } | null;

/** Até onde o servidor olha para trás (o controller busca só isto no banco). */
export const JANELA_DA_IMPRESSAO_MS = 48 * 3_600_000;
/**
 * Com UMA impressão só, menos de um dia: a impressão não tem data, e "bom dia" às 08:01 de ONTEM, de outro
 * paciente, é a mesma impressão de "bom dia" às 08:01 de hoje. Numa janela menor que 24 h, cada HH:MM é um
 * instante só. (Com duas ou mais, a coincidência teria de se repetir em duas mensagens da mesma conversa.)
 */
export const JANELA_DE_UMA_IMPRESSAO_MS = 23 * 3_600_000;

/**
 * Qual conversa guardada tem as mensagens que a extensão viu na tela.
 *
 * Regra: a conversa precisa bater com pelo menos DUAS impressões diferentes (ou com a única, quando a
 * extensão só mandou uma — e aí só nas últimas 23 h). "Oi" às 08:01 pode ter vindo de dois pacientes; duas
 * mensagens iguais no mesmo minuto, não. Empate entre conversas = ambíguo = não aponta ninguém — cartão
 * errado é pior que nenhum.
 */
export function casarPorImpressoes(impressoes: string[], mensagens: MensagemGuardada[], agora: Date = new Date()): ResultadoDaImpressao {
  const alvo = new Set(impressoesValidas(impressoes, 64));
  if (!alvo.size) return null;
  const minimo = alvo.size === 1 ? 1 : 2;
  const desde = agora.getTime() - (alvo.size === 1 ? JANELA_DE_UMA_IMPRESSAO_MS : JANELA_DA_IMPRESSAO_MS);

  const porLead = new Map<string, Set<string>>();
  for (const m of mensagens) {
    if (m.em.getTime() < desde) continue;
    const n = normalizarParaImpressao(m.texto);
    if (!n) continue;
    for (const minuto of minutosDaMensagemGuardada(m.em)) {
      const h = hashDoNormalizado(n, minuto);
      if (!alvo.has(h)) continue;
      const s = porLead.get(m.leadId) ?? new Set<string>();
      s.add(h);
      porLead.set(m.leadId, s);
    }
  }

  const ranking = [...porLead.entries()]
    .map(([leadId, s]) => ({ leadId, batidas: s.size }))
    .filter((r) => r.batidas >= minimo)
    .sort((a, b) => b.batidas - a.batidas);
  if (!ranking.length) return null;
  if (ranking.length > 1 && ranking[1].batidas === ranking[0].batidas) return { ambiguo: true };
  return ranking[0];
}

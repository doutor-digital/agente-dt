/**
 * Ponte, fase 3 (14/10/2026) — RESPOSTAS PRONTAS para COPIAR.
 *
 * A lista são os modelos gerais do Kommo (`GET /api/v4/chats/templates`, `type: "amocrm"`): os textos livres que a
 * equipe cadastra em Configurações › Modelos › Modelos gerais. Os modelos do WhatsApp (`type: "waba"`, aprovados
 * pela Meta) ficam de fora: esses só saem pelo Kommo.
 *
 * A Ponte NUNCA põe texto na caixa do WhatsApp nem envia: a atendente copia, cola e envia. Aqui o servidor só
 * entrega os textos, com os marcadores de campo do cartão (`{{lead.cf.2449844}}`) trocados pelo NOME do campo
 * entre colchetes ("[◷ Data da Consulta]"), para a atendente ver o que completar. O marcador de nome
 * (`{{contact.name}}`) fica como está: quem troca pelo primeiro nome do paciente é o painel (`respostas.js`).
 */
import type { KommoChatTemplate } from '../services/kommo.service.js';
import { limparNome } from './widget-agenda.js';
import { CacheDaConta } from './ponte-cache.js';

export const CACHE_RESPOSTAS_MS = 10 * 60_000;

/** Onde a equipe cadastra (conferido na ajuda do Kommo em pt-BR, 14/10/2026). */
export const ONDE_CADASTRAR_RESPOSTAS = 'No Kommo: Configurações › Modelos › Modelos gerais › Adicionar um novo modelo (só administrador).';

export interface RespostaPronta {
  id: number;
  nome: string;
  texto: string;
  /** O modelo tem arquivo anexo: a Ponte copia só o texto. */
  temAnexo: boolean;
}

/** Marcadores de nome do contato: o painel troca pelo primeiro nome do paciente. */
const MARCADOR_DE_NOME = /^\s*contact\.(?:first_)?name\s*$/i;

/**
 * `{{lead.cf.123}}` → "[Nome do campo]"; outros marcadores (menos o de nome) → "[o que estava dentro]". Assim a
 * atendente vê, antes de colar, o que precisa completar à mão.
 */
export function trocarMarcadores(texto: string, nomeDoCampo: (id: number) => string | null): string {
  return texto.replace(/\{\{([^{}]{1,80})\}\}/g, (inteiro, dentro: string) => {
    if (MARCADOR_DE_NOME.test(dentro)) return inteiro;
    const cf = /^\s*lead\.cf\.(\d+)\s*$/i.exec(dentro);
    if (cf) return `[${nomeDoCampo(Number(cf[1])) ?? 'campo do cartão'}]`;
    return `[${dentro.trim()}]`;
  });
}

/** Só os modelos gerais (texto livre), com texto, em ordem alfabética. */
export function respostasProntas(modelos: ReadonlyArray<KommoChatTemplate>, nomeDoCampo: (id: number) => string | null): RespostaPronta[] {
  return modelos
    .filter((t) => {
      const tipo = String(t.type ?? '').trim().toLowerCase();
      return tipo !== 'waba' && !tipo.includes('whatsapp') && typeof t.content === 'string' && t.content.trim();
    })
    .map((t) => ({
      id: t.id,
      nome: String(t.name ?? '').trim() || `Modelo ${t.id}`,
      texto: trocarMarcadores(String(t.content).trim(), nomeDoCampo),
      temAnexo: !!t.attachment,
    }))
    .sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'));
}

const NAO_E_NOME = new Set(['lead', 'leads', 'de', 'da', 'do', 'dos', 'das', 'e', 'sr', 'sra', 'srta', 'dr', 'dra']);

/** "MARIA" → "Maria"; "joão" → "João". */
function comMaiuscula(p: string): string {
  const m = p.toLocaleLowerCase('pt-BR');
  return m.charAt(0).toLocaleUpperCase('pt-BR') + m.slice(1);
}

function primeiraPalavraDeNome(s: string | null | undefined): string | null {
  for (const p of limparNome(s).split(' ')) {
    const palavra = p.replace(/^[^\p{L}]+|[^\p{L}]+$/gu, '');
    if (palavra.length < 2 || !/^\p{L}+(?:['-]\p{L}+)*$/u.test(palavra)) continue;
    if (NAO_E_NOME.has(palavra.toLocaleLowerCase('pt-BR'))) continue;
    return comMaiuscula(palavra);
  }
  return null;
}

/**
 * O primeiro nome do paciente, para as respostas prontas: do título do cartão (o padrão da casa é
 * "MARIA SOUZA 03/10/2026") e, se o título não tiver nome ("Lead 22261987"), do contato (perfil do WhatsApp).
 * `null` quando nenhum dos dois parece nome de gente — aí o painel deixa "[nome]" para a atendente completar.
 */
export function primeiroNomeDoPaciente(titulo: string | null | undefined, nomeDoContato: string | null | undefined): string | null {
  return primeiraPalavraDeNome(titulo) ?? primeiraPalavraDeNome(nomeDoContato);
}

// ── com o Kommo ──

const cacheRespostas = new CacheDaConta<RespostaPronta[]>(CACHE_RESPOSTAS_MS);

export function limparCacheDasRespostas(): void {
  cacheRespostas.limpar();
}

/** As respostas prontas da conta, com cache de 10 min por conta. */
export function respostasDaConta(
  conta: string,
  buscar: () => Promise<{ modelos: KommoChatTemplate[]; nomeDoCampo: (id: number) => string | null }>,
): Promise<RespostaPronta[]> {
  return cacheRespostas.obter(conta, async () => {
    const { modelos, nomeDoCampo } = await buscar();
    return respostasProntas(modelos, nomeDoCampo);
  });
}

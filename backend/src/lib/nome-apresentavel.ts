/**
 * NOME APRESENTÁVEL — o único jeito de o servidor chamar o paciente pelo nome (item 15 da lista da rede e
 * auditoria de Araguaína, 21/10/2026).
 *
 * O que saía: "Olá, Meu Único Amigo É Deus." (Araguaína, lead 28659614, 20/10), "Olá, ,", "Olá, tricolor",
 * e-mail no lugar do nome. Quem escreve "Olá, {{contact.name}}" nos modelos é o robô do Kommo, e o contato
 * nasce com o nome do PERFIL do WhatsApp. No servidor, a véspera (`confirmacao-d1.ts`) e as respostas ao
 * lembrete pegavam a primeira palavra do que viesse, sem trava nenhuma.
 *
 * A REGRA:
 *  1. Primeiro o TÍTULO do cartão: é onde a Sofia grava o nome que o paciente disse ("CRISTINA REGIA 15/10/26").
 *     A data do fim sai.
 *  2. Depois o nome do CONTATO (perfil do WhatsApp), só se parecer nome próprio — e com régua mais dura,
 *     porque é ali que mora o apelido, a frase e o nome de loja.
 *  3. Nenhum serve → sem nome: "Olá!". Nome errado é pior que nome nenhum.
 *
 * O que derruba: vazio, e-mail, telefone (qualquer número fora a data do título), frase (palavra de conversa,
 * queixa ou pergunta — `looksLikeName`), emoji sozinho, apelido óbvio ("tricolor", "princesa"), palavra de
 * loja ("Espaço", "Store"), abreviação de loja ("Conv."), palavra sem vogal e letra esticada ("Aaaa").
 *
 * Devolve só o PRIMEIRO nome, com maiúscula na primeira letra quando veio tudo maiúsculo ou tudo minúsculo.
 */
import { looksLikeName } from '../agent/name-capture.js';

/** Data no título ("Nome DD/MM/AAAA") e o que vier depois dela ("Dayse Moreira 28/04/25 Sem Origem"). */
const DATA_E_RESTO = /\s*\d{1,2}[/.-]\d{1,2}(?:[/.-]\d{2,4})?(?!\d)[\s\S]*$/;
/** "Lead #28222940", "Lead 22261987", "Novo lead": título automático, não é nome. */
const TITULO_AUTOMATICO = /^(novo\s+)?lead\b/i;
/** Emoji e enfeite colados ao nome ("Rosa❤️", "✨ Júlia ✨"). */
const ENFEITE = /[\p{Extended_Pictographic}☀-➿️‍]/gu;
/** Separadores de "nome — complemento" no título ("Maria (mãe do João)", "Ana - Instagram", "José | indicação"). */
const COMPLEMENTO = /\s*(?:\(|\[|\||,|;|\s[-–—]\s)[\s\S]*$/;
const VOGAL = /[aeiouyáàâãéêíóôõúü]/i;

/** Pronome de tratamento antes do nome: sai, e o nome é a palavra seguinte ("Dra. Ana Lima" → Ana). */
const TRATAMENTO = new Set([
  'sr', 'sra', 'srta', 'dr', 'dra', 'dona', 'prof', 'profa', 'pastor', 'pastora', 'pr', 'pra',
  'irmã', 'irmão', 'missionária', 'missionário', 'padre', 'frei', 'bispo', 'apóstolo',
  'tia', 'tio', 'vó', 'vô', 'vovó', 'vovô',
]);

/**
 * Não é nome quando vem na FRENTE (sem acento, minúsculo). Algumas são sobrenome comum no meio do nome
 * ("Maria da Luz", "José da Paz", "Ana de Jesus") e por isso só contam como primeira palavra.
 */
const NAO_E_PRIMEIRO_NOME = new Set([
  // fé e frase de perfil
  'deus', 'jesus', 'cristo', 'senhor', 'senhora', 'amor', 'vida', 'fe', 'paz', 'luz', 'gratidao',
  'abencoado', 'abencoada', 'fiel',
  // apelido e carinho
  'princesa', 'principe', 'rainha', 'rei', 'gata', 'gato', 'gatinha', 'gatinho', 'linda', 'lindo', 'lindinha',
  'bebe', 'baby', 'mamae', 'papai', 'vovo', 'vovozinha', 'anjo', 'anjinho', 'nega', 'nego', 'neguinha',
  'neguinho', 'preta', 'pretinha', 'preto', 'loira', 'loiro', 'morena', 'moreno', 'baixinha', 'baixinho',
  'gordinha', 'gordinho', 'magrinha', 'magrinho', 'tricolor', 'flamengo', 'mengao', 'fluminense', 'vasco',
  'botafogo', 'fogao', 'corinthians', 'timao', 'palmeiras', 'verdao', 'gremio', 'colorado', 'galo',
  'cruzeiro', 'atletico', 'sport', 'paysandu', 'remo',
  // sem nome de verdade
  'user', 'usuario', 'usuaria', 'desconhecido', 'unknown', 'null', 'undefined', 'contato', 'cliente',
  'business', 'admin', 'eu', 'nome',
  // recado no lugar do nome ("Oi, Ocupado!" — visto em 20/09/2026)
  'ocupado', 'ocupada', 'trabalhando', 'indisponivel', 'ausente',
]);

/** Palavra de LOJA ou de grupo em qualquer posição: o perfil é de um negócio, não de gente. */
const PALAVRA_DE_NEGOCIO = new Set([
  'loja', 'lojas', 'empresa', 'oficial', 'store', 'shop', 'vendas', 'delivery', 'distribuidora', 'comercio',
  'imoveis', 'imobiliaria', 'consultoria', 'boutique', 'modas', 'cosmeticos', 'estetica', 'salao', 'barbearia',
  'studio', 'estudio', 'espaco', 'arena', 'sabor', 'sabores', 'lanches', 'lanchonete', 'restaurante', 'pizzaria',
  'conveniencia', 'conv', 'hookah', 'tabacaria', 'motos', 'pecas', 'servicos', 'transportes', 'materiais',
  'construcao', 'igreja', 'ministerio', 'assembleia', 'clinica', 'contabilidade', 'advocacia', 'academia',
  'fitness', 'nails', 'makeup', 'celulares', 'informatica', 'ltda', 'eireli', 'deus',
]);

function semAcento(s: string): string {
  return s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
}

function comMaiuscula(p: string): string {
  if (p !== p.toLocaleUpperCase('pt-BR') && p !== p.toLocaleLowerCase('pt-BR')) return p;
  const m = p.toLocaleLowerCase('pt-BR');
  return m.charAt(0).toLocaleUpperCase('pt-BR') + m.slice(1);
}

/**
 * PURA. O primeiro nome de UMA fonte, ou null. `contato` = régua dura do perfil do WhatsApp (até 4 palavras de
 * nome, sem abreviação de loja); título = a régua do `looksLikeName` (até 6).
 */
function primeiroNomeDe(bruto: string | null | undefined, fonte: 'titulo' | 'contato'): string | null {
  let s = String(bruto ?? '').replace(ENFEITE, ' ').replace(/\s+/g, ' ').trim();
  if (!s) return null;
  if (s.includes('@')) return null; // e-mail
  if (fonte === 'titulo' && TITULO_AUTOMATICO.test(s)) return null;
  s = s.replace(DATA_E_RESTO, '').replace(COMPLEMENTO, '').trim();
  if (!s || /\d/.test(s)) return null; // telefone, "Lead 123", número solto
  // "/" separa quem escreve de quem é o paciente ("Milena/Leomar dos Santos"); "_" e "~" são enfeite de perfil.
  s = s.replace(/[/_~*"“”]+/g, ' ').replace(/\s+/g, ' ').trim();

  let palavras = s.split(' ').filter(Boolean);
  // Abreviação que não é tratamento ("Space Conv. Hookah"): nome de loja.
  if (fonte === 'contato' && palavras.some((p) => p.endsWith('.') && !TRATAMENTO.has(p.slice(0, -1).toLocaleLowerCase('pt-BR')))) {
    return null;
  }
  palavras = palavras.map((p) => p.replace(/^[.'-]+|[.'-]+$/g, '')).filter(Boolean);
  while (palavras.length > 1 && TRATAMENTO.has(palavras[0].toLocaleLowerCase('pt-BR'))) palavras.shift();
  if (palavras.length === 0) return null;

  const juntas = palavras.join(' ');
  if (!looksLikeName(juntas)) return null;
  const reais = palavras.filter((p) => !['de', 'da', 'do', 'das', 'dos', 'e'].includes(semAcento(p)));
  if (fonte === 'contato' && reais.length > 4) return null;
  for (const p of palavras) {
    const n = semAcento(p);
    if (PALAVRA_DE_NEGOCIO.has(n)) return null;
    if (!VOGAL.test(p)) return null; // "Jhnn", "Ktr"
    if (/(.)\1\1/i.test(n)) return null; // "Aaaa", "Liiiinda"
  }
  const primeiro = reais[0];
  if (!primeiro || primeiro.length < 2) return null;
  // Só o tratamento ("Dra", "Tia", "Pastor"): não sobrou nome.
  if (TRATAMENTO.has(primeiro.toLocaleLowerCase('pt-BR'))) return null;
  if (NAO_E_PRIMEIRO_NOME.has(semAcento(primeiro))) return null;
  return comMaiuscula(primeiro);
}

/**
 * O primeiro nome que dá para usar com o paciente: do título do cartão; se o título não tiver nome, do contato
 * (perfil do WhatsApp) quando ele parecer nome próprio. `null` = cumprimentar sem nome.
 */
export function nomeApresentavel(titulo: string | null | undefined, contato?: string | null | undefined): string | null {
  return primeiroNomeDe(titulo, 'titulo') ?? primeiroNomeDe(contato, 'contato');
}

/** ", Maria" ou "" — para "Confirmado, Maria!" / "Confirmado!". Recebe o nome já escolhido ou um candidato cru. */
export function vocativo(nome: string | null | undefined): string {
  const n = primeiroNomeDe(nome, 'contato');
  return n ? `, ${n}` : '';
}

/** "Olá, Maria!" ou "Olá!" — nunca "Olá, ," nem "Olá, tricolor". */
export function saudacao(nome: string | null | undefined, abertura = 'Olá'): string {
  return `${abertura}${vocativo(nome)}!`;
}

function escaparRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * PURA. Tira do texto gerado pelo modelo (régua, reativação) o nome do PERFIL usado como vocativo quando esse
 * nome não é apresentável: "Oi, Tricolor! Tudo bem?" → "Oi! Tudo bem?"; "Tudo certo, Meu Único Amigo É Deus?"
 * → "Tudo certo?". O modelo não recebe o perfil, mas pode tê-lo copiado do histórico. Nome apresentável fica.
 */
export function semNomeDoPerfil(texto: string, contato: string | null | undefined): string {
  const perfil = String(contato ?? '').replace(ENFEITE, ' ').replace(/\s+/g, ' ').trim();
  if (!perfil || primeiroNomeDe(perfil, 'contato')) return texto;
  const candidatos = [perfil];
  const primeira = perfil.split(' ')[0];
  if (primeira && primeira.length >= 3 && primeira !== perfil) candidatos.push(primeira);
  let out = texto;
  for (const c of candidatos) {
    const nome = escaparRegex(c);
    // "Oi, Fulano!" / "Olá Fulano," → "Oi!" / "Olá,"
    out = out.replace(new RegExp(`(^|[\\n.!?]\\s*)((?:oi[eê]?|ol[aá]|opa|ei|bom dia|boa tarde|boa noite)),?\\s+${nome}(?=\\s*[!,.?\\n]|$)`, 'giu'), '$1$2');
    // "…, Fulano?" no meio ou no fim da frase
    out = out.replace(new RegExp(`,\\s*${nome}(?=\\s*[!,.?\\n]|$)`, 'giu'), '');
  }
  return out;
}

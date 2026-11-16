/**
 * CUTUCADA DEPOIS DA EQUIPE (pedido da clínica de Petrópolis, 16/11/2026, decisão do João).
 *
 * "A IA passa a mandar uma mensagem aos leads que não responderem à primeira abordagem feita pela Mariana (SDR do dia).
 * Teste de 3 dias para decidir se fica." A Sofia lê a conversa e manda UMA mensagem curta, 2 h depois da fala da equipe, em
 * horário comercial, uma vez por lead.
 *
 * ESTE ARQUIVO É A PARTE PURA (sem banco, sem Kommo): quem falou por último, o prazo, as travas do cartão e o texto aprovado.
 * O worker (`cutucada-apos-equipe-worker.ts`) lê o mundo e chama isto.
 *
 * QUEM É QUEM NO WHATSAPP LITE (medido em Petrópolis, 16/11/2026, 85 conversas, 413 mensagens enviadas):
 *   - a SOFIA sai pelo Salesbot: autor `bot` "Salesbot" — 48 de 48 falas dela no nosso banco casaram com uma saída "Salesbot" em
 *     menos de 1 s;
 *   - a SDR pelo CELULAR sai como autor `bot` "WhatsApp Lite" (202 mensagens) — o Kommo a chama de robô, mas é gente;
 *   - a SDR escrevendo DENTRO do Kommo sai como `internal` "Doutor Hérnia Petrópolis" (157) — o mesmo login do robô de ▶ Retomada;
 *   - "Agradecemos o seu contato! Nosso atendimento é de segunda a…" é a resposta automática do app (23), no máximo ~16 s depois
 *     da mensagem do paciente.
 * O classificador compartilhado (`classificarAutor`) lê `bot` como Sofia, então em Lite a equipe do celular vira "Sofia" lá (a
 * régua e a pausa pela equipe não a enxergam). Aqui NÃO se mexe nele — o comportamento das outras unidades fica como está —, e a
 * cutucada reclassifica as saídas pelo que prova de quem é cada uma (`reclassificarFalas`).
 */
import type { MensagemOficial } from '../services/kommo-talks-normalizar.js';
import { JANELA_DO_ENVIO_MS } from '../services/kommo-talks-normalizar.js';
import { porQueNaoTocar, intentsDe, inteiro, temEtiqueta, type Cartao, type OpcoesDeCartao, type RazaoDeFicar } from './rotina-nucleo.js';
import { ETIQUETAS_RETOMADA } from './rotina-etapas-worker.js';
import { AVISO_DO_SISTEMA as AVISO_BASE, RESPOSTA_AUTOMATICA_ANTES_MS, RESPOSTA_AUTOMATICA_MS, RESPOSTA_AUTOMATICA_MIN_CARACTERES } from './pausa-equipe.js';
import { normalizarNome } from './kommo-schema.js';
import { retornoDaEquipe } from './retorno-da-equipe.js';
import { fusoDaUnidade } from './fuso.js';
import type { Unit } from '@prisma/client';

export const ID_CUTUCADA = 'cutucada-apos-equipe';
/** Quanto a equipe fica sem resposta até a Sofia cutucar (padrão do João: 2 h). Por unidade: `pipelineIntents.cutucada_espera_min`. */
export const ESPERA_PADRAO_MIN = 120;
/**
 * Fala da equipe mais velha que isto não vira cutucada. Cobre a noite e o domingo (SDR fala sábado 18h50, a unidade fecha 19h e só
 * volta segunda 9h = 38 h) e não acorda conversa de semana atrás. Por unidade: `pipelineIntents.cutucada_idade_max_h`.
 */
export const IDADE_MAX_PADRAO_H = 48;

export type AutorDaFala = 'paciente' | 'sofia' | 'equipe' | 'robo';

export interface Fala {
  id: string;
  em: Date;
  autor: AutorDaFala;
  autorNome: string;
  texto: string;
  anexo: string | null;
}

export interface ConfigDaCutucada {
  esperaMin: number;
  idadeMaxH: number;
}

export function configDaCutucada(pipelineIntents: unknown): ConfigDaCutucada {
  const i = intentsDe(pipelineIntents);
  // pisos: prazo de 1 min cutucaria quem a SDR acabou de escrever; idade máxima menor que o prazo + 1 h nunca cutucaria ninguém
  const esperaMin = Math.min(Math.max(inteiro(i.cutucada_espera_min) ?? ESPERA_PADRAO_MIN, 15), 24 * 60);
  const idadeMaxH = Math.min(Math.max(inteiro(i.cutucada_idade_max_h) ?? IDADE_MAX_PADRAO_H, Math.ceil(esperaMin / 60) + 1), 24 * 14);
  return { esperaMin, idadeMaxH };
}

// ─── quem falou ───────────────────────────────────────────────────────────────────────────────────

/** O app do celular da clínica: WhatsApp Business (coexistência) e WhatsApp Lite (QR code). O Kommo os marca como robô; quem escreve ali é gente. */
const APPS_DO_CELULAR = ['whatsapp lite', 'whatsapp business'];

/** Saudação/ausência que o app manda sozinho (Lite: "Agradecemos o seu contato! Nosso atendimento é de segunda a sexta…"). */
const RESPOSTA_AUTOMATICA = /agradecemos o seu contato|nosso atendimento (é|e) de |fora do (nosso )?hor[aá]rio|hor[aá]rio de atendimento (é|e) /i;
/** Aviso do Kommo/WhatsApp que sai como mensagem de saída: o da `pausa-equipe` + o «messageContextInfo» que o Lite mostra. */
const AVISO_DO_SISTEMA = new RegExp(`${AVISO_BASE.source}|^'?messagecontextinfo'? is not yet supported`, 'i');

/**
 * Textos de robô do Kommo que saem como o USUÁRIO `internal` — o mesmo login com que a SDR escreve dentro do Kommo, então o autor
 * não os separa da gente. A etiqueta ▶ Retomada no cartão é a marca geral (abaixo); estes cobrem o robô de gatilho de etapa que
 * não põe etiqueta (Petrópolis, 13/11/2026: 6 de 22 saídas de robô estavam em cartão sem a etiqueta). Na dúvida é robô: o erro
 * custa uma cutucada a menos, nunca uma a mais.
 */
export const TEXTOS_DE_ROBO: readonly RegExp[] = [
  /passando novamente porque vi que voc[eê] procurou ajuda/i,
  /vi que voc[eê] demonstrou interesse no nosso tratamento, tentei contato/i,
];

/** A mensagem é a resposta automática do app (saudação, ausência) ou aviso do sistema? Mesma ideia da `pausa-equipe`, estendida ao Lite. */
export function ehRespostaAutomaticaDoApp(m: Pick<MensagemOficial, 'direcao' | 'texto' | 'autorNome' | 'anexo' | 'em'>, todas: ReadonlyArray<Pick<MensagemOficial, 'direcao' | 'em'>>): boolean {
  if (m.direcao !== 'saida') return false;
  const texto = m.texto.trim();
  if (AVISO_DO_SISTEMA.test(texto)) return true;
  if (!APPS_DO_CELULAR.includes(m.autorNome.trim().toLowerCase())) return false;
  if (m.anexo) return false;
  if (RESPOSTA_AUTOMATICA.test(texto)) return true;
  if (texto.length < RESPOSTA_AUTOMATICA_MIN_CARACTERES) return false;
  const t = m.em.getTime();
  return todas.some((p) => {
    if (p.direcao !== 'entrada') return false;
    const d = t - p.em.getTime();
    return d >= -RESPOSTA_AUTOMATICA_ANTES_MS && d <= RESPOSTA_AUTOMATICA_MS;
  });
}

/**
 * Quem escreveu cada mensagem, pelo que se PROVA:
 *  - entrada = paciente;
 *  - saída do app do celular (Lite/Business) = equipe, salvo resposta automática do app (= robô);
 *  - saída de bot/sessão com nome da Sofia = Sofia SÓ se casa com um envio que o nosso agente registrou (±3 min); sem casar, o
 *    bot é outro robô (régua, Salesbot da conta) e a sessão com nome da Sofia é a equipe usando o mesmo login;
 *  - saída de usuário do Kommo (`internal`) = equipe, salvo texto de robô conhecido ou cartão com a etiqueta ▶ Retomada (robô).
 */
export function reclassificarFalas(
  msgs: readonly MensagemOficial[],
  enviosDaSofia: readonly Date[],
  o: { cartaoComEtiquetaDeRobo: boolean; janelaMs?: number },
): Fala[] {
  const janela = o.janelaMs ?? JANELA_DO_ENVIO_MS;
  const casaComEnvio = (m: MensagemOficial) => enviosDaSofia.some((e) => Math.abs(e.getTime() - m.em.getTime()) <= janela);
  return msgs.map((m): Fala => {
    const base = { id: m.id, em: m.em, autorNome: m.autorNome, texto: m.texto, anexo: m.anexo?.tipo ?? null };
    if (m.direcao === 'entrada') return { ...base, autor: 'paciente' };
    if (APPS_DO_CELULAR.includes(m.autorNome.trim().toLowerCase()) || AVISO_DO_SISTEMA.test(m.texto.trim())) {
      return { ...base, autor: ehRespostaAutomaticaDoApp(m, msgs) ? 'robo' : 'equipe' };
    }
    if (m.autor === 'sofia') {
      if (m.pelaSessao) return { ...base, autor: casaComEnvio(m) ? 'sofia' : 'equipe' };
      return { ...base, autor: casaComEnvio(m) ? 'sofia' : 'robo' };
    }
    if (m.autor === 'paciente') return { ...base, autor: 'paciente' };
    const robo = o.cartaoComEtiquetaDeRobo || TEXTOS_DE_ROBO.some((r) => r.test(m.texto));
    return { ...base, autor: robo ? 'robo' : 'equipe' };
  });
}

/** O cartão carrega a marca de que um robô de retomada falou com ele (▶ Retomada, ▶ Retomada 2, ▶ Retomada 3). */
export function cartaoComEtiquetaDeRobo(lead: Cartao): boolean {
  return ETIQUETAS_RETOMADA.some((t) => temEtiqueta(lead, t));
}

// ─── a decisão pela conversa ──────────────────────────────────────────────────────────────────────

// ─── horário de verdade ───────────────────────────────────────────────────────────────────────────

/**
 * A clínica está ATENDENDO agora? Usa o horário real da unidade (`retornoDaEquipe`): dias da agenda, o horário PRÓPRIO de cada dia
 * (`spine_day_hours` — Petrópolis atende o sábado das 7h30 às 13h, não até 19h), fuso e feriado nacional. Sem agenda cadastrada,
 * "não sei" = fechada (mensagem que ninguém vai acompanhar não sai). E nunca fora de 8h–20h locais, mesmo que o cadastro diga mais.
 */
export function clinicaAtendendoAgora(unit: Pick<Unit, 'spineEnabled' | 'spineAgendaDays' | 'spineAgendaStart' | 'spineAgendaEnd' | 'spineDayHours' | 'spineTimezone' | 'businessHoursTimezone'>, agora: Date): boolean {
  if (retornoDaEquipe(unit as Unit, agora).tipo !== 'aberta') return false;
  const p = new Intl.DateTimeFormat('en-GB', { timeZone: fusoDaUnidade(unit), hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(agora);
  const min = (Number(p.find((x) => x.type === 'hour')?.value ?? 0) % 24) * 60 + Number(p.find((x) => x.type === 'minute')?.value ?? 0);
  return min >= 8 * 60 && min < 20 * 60;
}

// ─── a clínica deve o retorno ─────────────────────────────────────────────────────────────────────

const PROMESSA_A = /\b(te|lhe|vos)\s+(retorno|retornamos|retornarei|retornaremos|aviso|avisamos|respondo|respondemos|chamo|chamamos|falo|ligo|ligamos|dou\s+(um\s+)?retorno|damos\s+(um\s+)?retorno)\b/i;
const PROMESSA_B = /\b(vou|vamos|irei|iremos|assim que|logo que|em breve)\b[^.?!\n]{0,140}\b(retorn\w*|avis\w*|respond\w*|entr\w+\s+em\s+contato|dar\s+(um\s+)?retorno|volt\w+|lig\w+)\b/i;

/** A fala da equipe PROMETE um retorno («vou verificar e te retorno», «vou pedir para a equipe analisar e retorno»)? Então quem deve é a clínica. */
export function prometeRetorno(texto: string): boolean {
  return PROMESSA_A.test(texto) || PROMESSA_B.test(texto);
}

/** O pedaço curto da fala, sem telefone, para o motivo que o João lê na tela. */
export function trechoSemTelefone(texto: string, max = 90): string {
  const t = texto.replace(/\s+/g, ' ').trim().replace(/\+?\(?\d[\d\s().-]{6,}\d/g, '…');
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

export type PorQuePular =
  | 'sem_conversa'
  | 'paciente_falou_por_ultimo'
  | 'sofia_falou_por_ultimo'
  | 'robo_falou_por_ultimo'
  | 'dentro_do_prazo'
  | 'fala_muito_antiga'
  | 'fala_de_encerramento'
  | 'clinica_deve_retorno';

/**
 * «Beleza», «Obrigada, bom fim de semana», «Ok!»: a equipe FECHOU a conversa, não deixou pergunta no ar. Cutucar aí é cutucar quem
 * já combinou tudo (visto em Petrópolis, 16/11: a equipe respondeu «beleza» ao paciente e a conversa acabou). Curto, sem «?» e com
 * cara de despedida/confirmação.
 */
const PALAVRAS_DE_ENCERRAMENTO = new Set(
  (
    'ok okay beleza blz certo combinado perfeito tá ta bom boa tudo bem obrigado obrigada obrigadão de nada por disponha imagina valeu ' +
    'até ate mais logo amanhã amanha abraço abraco abraços fim final semana noite tarde dia igualmente também tambem se e a o um uma ' +
    'senhor senhora sr sra dona você voce vc fica com deus tchau flw'
  ).split(' '),
);
/** Palavras que FECHAM («Boa tarde!» e «Tudo bem» sozinhos são abertura, não despedida — pedem resposta). */
const PALAVRAS_QUE_FECHAM = new Set('ok okay beleza blz certo combinado perfeito obrigado obrigada obrigadão nada disponha imagina valeu até ate abraço abraco abraços fim final igualmente tchau flw'.split(' '));
/** Despedida/confirmação = curta, sem «?», SÓ com palavras de fechamento e com ao menos uma que fecha: «Certo! Me manda a foto do exame» tem pedido em aberto e não entra. */
export function ehEncerramento(f: Pick<Fala, 'texto' | 'anexo'>): boolean {
  const t = f.texto.trim();
  if (f.anexo || !t || t.length > 60 || t.includes('?')) return false;
  const palavras = t.toLowerCase().match(/\p{L}+/gu) ?? [];
  return palavras.length > 0 && palavras.length <= 8 && palavras.every((p) => PALAVRAS_DE_ENCERRAMENTO.has(p)) && palavras.some((p) => PALAVRAS_QUE_FECHAM.has(p));
}

export type DecisaoDaConversa =
  | { tipo: 'cutucar'; ultimaDaEquipe: Fala }
  | { tipo: 'pular'; porque: PorQuePular; /** quando deixa de ser "dentro do prazo" (epoch ms) */ depoisDe?: number };

/**
 * A conversa pede a cutucada? Só quando a ÚLTIMA fala é da equipe, o paciente não escreveu depois dela, e já passou o prazo
 * (padrão 2 h) sem passar da idade máxima. Paciente, Sofia ou robô por último: não é caso de cutucar.
 */
export function decidirPelaConversa(falas: readonly Fala[], agora: Date, cfg: ConfigDaCutucada): DecisaoDaConversa {
  const ultima = falas[falas.length - 1];
  if (!ultima) return { tipo: 'pular', porque: 'sem_conversa' };
  if (ultima.autor === 'paciente') return { tipo: 'pular', porque: 'paciente_falou_por_ultimo' };
  if (ultima.autor === 'sofia') return { tipo: 'pular', porque: 'sofia_falou_por_ultimo' };
  if (ultima.autor === 'robo') return { tipo: 'pular', porque: 'robo_falou_por_ultimo' };
  const idadeMs = agora.getTime() - ultima.em.getTime();
  if (idadeMs < cfg.esperaMin * 60_000) return { tipo: 'pular', porque: 'dentro_do_prazo', depoisDe: ultima.em.getTime() + cfg.esperaMin * 60_000 };
  if (idadeMs > cfg.idadeMaxH * 3_600_000) return { tipo: 'pular', porque: 'fala_muito_antiga' };
  if (ehEncerramento(ultima)) return { tipo: 'pular', porque: 'fala_de_encerramento' };
  // quem deve a resposta é a clínica: qualquer fala da equipe depois da última do paciente que prometa retorno
  // (um «ok, obrigado» do paciente só acusa o recebimento: a promessa de antes continua devida)
  let ultimoDoPaciente = -1;
  for (let i = falas.length - 1; i >= 0; i--) if (falas[i].autor === 'paciente' && !ehEncerramento(falas[i])) { ultimoDoPaciente = i; break; }
  if (falas.slice(ultimoDoPaciente + 1).some((f) => f.autor === 'equipe' && prometeRetorno(f.texto))) return { tipo: 'pular', porque: 'clinica_deve_retorno' };
  return { tipo: 'cutucar', ultimaDaEquipe: ultima };
}

// ─── o que o CARTÃO diz ───────────────────────────────────────────────────────────────────────────

const n = normalizarNome;

/** Entrada ("Incoming leads", "Etapa de leads de entrada") ou EM QUALIFICAÇÃO — as duas etapas onde a SDR faz a 1ª abordagem. */
export function etapaDaCutucada(nomeDaEtapa: string | null | undefined): boolean {
  if (!nomeDaEtapa) return false;
  const s = n(nomeDaEtapa);
  return s.includes('entrada') || s.includes('incoming') || s === n('EM QUALIFICAÇÃO');
}

/**
 * Por que este cartão NÃO recebe cutucada, só pelo que o cartão mostra (de graça): etiqueta NO_FOLLOW_UP / NAO_PERTURBAR / CURRÍCULO /
 * opt-out, «Pausar IA», ◷ Retomar em de hoje em diante, consulta futura no cartão. É a MESMA conferência das réguas da rotina
 * diária (`porQueNaoTocar`): uma lista só, para a cutucada nunca ser mais permissiva que a régua. `null` = segue.
 */
export function porQueOCartaoFicaQuieto(lead: Cartao, o: Pick<OpcoesDeCartao, 'agora' | 'tz' | 'pausarIaFieldId'>): RazaoDeFicar | null {
  return porQueNaoTocar(lead, { agora: o.agora, tz: o.tz, pausarIaFieldId: o.pausarIaFieldId });
}

// ─── o texto ──────────────────────────────────────────────────────────────────────────────────────

export const MAX_CARACTERES = 240;
const MIN_CARACTERES = 15;
const FALA_DE_VALOR = /R\$|\bpix\b|\bpagamento\b|\bpagar\b|\bsinal\b|\bvalor(es)?\b|\bdesconto\b|\bpre[cç]o\b|\bboleto\b|\bcart[aã]o de cr[eé]dito\b/i;
const FALA_DE_LIGACAO = /\bliga(r|rei|mos|ndo|[cç][aã]o|[cç][oõ]es)?\b|\bliguei\b|\bligou\b|\btelefon(ei|ar|ou|ema)\b/i;
/** A cutucada sai a qualquer hora do expediente e pode ser lida depois: saudação de turno erra ("Bom dia" às 15h). */
const SAUDACAO_DE_TURNO = /\b(bom\s+dia|boa\s+tarde|boa\s+noite)\b/i;
/** A fala da atendente pode ser de outro dia: "amanhã às 10h30" repetido na manhã seguinte vira a data errada. */
const TEMPO_RELATIVO = /(?<![\p{L}])(hoje|amanh[ãa]|ontem|agora|mais\s+tarde|daqui\s+a\s+pouco)(?![\p{L}])/iu;

/**
 * O texto que o modelo escreveu pode sair? Aqui só as regras DESTE pedido; o resto (vazamento, lacuna, preço fora do catálogo,
 * horário e reserva inventados, tom) é do `tratarTextoDaRegua`, o mesmo da régua. `null` = pode; senão o motivo.
 *  - curto (até 240 caracteres) e termina em pergunta;
 *  - nada de preço, Pix, sinal, pagamento;
 *  - nada de ligação, a não ser que a própria conversa já fale em ligação (a Sofia não liga e não sabe se a equipe ligou).
 */
export function porQueOTextoNaoSai(texto: string, conversa: string): string | null {
  const t = texto.trim();
  if (t.length < MIN_CARACTERES) return 'texto curto demais';
  if (t.length > MAX_CARACTERES) return `texto com mais de ${MAX_CARACTERES} caracteres`;
  if (!/\?\s*[\p{Emoji_Presentation}\p{Extended_Pictographic}\s]*$/u.test(t)) return 'não termina com uma pergunta';
  if ((t.match(/\n/g) ?? []).length > 2) return 'texto em muitos parágrafos';
  if (FALA_DE_VALOR.test(t)) return 'fala de valor, Pix ou pagamento';
  if (/\b(da|na|nossa|sou da|faço parte da)\s+equipe\s+(d[ao]\s+)?(cl[ií]nica|atendimento)\b|\bfa[cç]o parte da equipe\b|\bsou (da|a) equipe\b/i.test(t)) return 'se apresenta como «da equipe» (parece uma 2ª atendente humana)';
  if (FALA_DE_LIGACAO.test(t) && !FALA_DE_LIGACAO.test(conversa)) return 'fala de ligação que a conversa não menciona';
  // 16/11 (1ª hora ligada em Petrópolis): "Bom dia, Monique!" às 15h e "amanhã às 10h30" repetido de uma fala que pode ser de outro dia.
  if (SAUDACAO_DE_TURNO.test(t)) return 'usa saudação de turno (bom dia/boa tarde/boa noite)';
  if (TEMPO_RELATIVO.test(t)) return 'usa tempo relativo (hoje/amanhã/ontem/agora): a data pode ficar errada';
  return null;
}

/** A conversa como o modelo a lê (as últimas `max` falas). Áudio e imagem da equipe aparecem como marca: o conteúdo não é conhecido. */
export function conversaParaOModelo(falas: readonly Fala[], max = 14): string {
  const rotulo: Record<AutorDaFala, string> = { paciente: 'PACIENTE', sofia: 'VOCÊ (Sofia)', equipe: 'ATENDENTE DA CLÍNICA (humana)', robo: 'MENSAGEM AUTOMÁTICA' };
  return falas
    .slice(-max)
    .map((f) => {
      const marca = f.anexo ? (f.anexo === 'voice' ? '[áudio]' : f.anexo === 'picture' ? '[imagem]' : `[${f.anexo}]`) : '';
      const corpo = [f.texto.replace(/\s+/g, ' ').trim().slice(0, 500), marca].filter(Boolean).join(' ') || '[mensagem vazia]';
      return `${rotulo[f.autor]}: ${corpo}`;
    })
    .join('\n');
}

/** A Sofia já falou nesta conversa? (para ela se apresentar em poucas palavras só quando é a primeira vez) */
export function sofiaJaFalou(falas: readonly Fala[]): boolean {
  return falas.some((f) => f.autor === 'sofia');
}

// ─── a marca de «uma vez por lead» ────────────────────────────────────────────────────────────────

/** O id da marca persistente: um por lead, para sempre. Gravar de novo falha na chave primária — é isso que torna a cutucada idempotente. */
export function idDaMarcaDaCutucada(unitId: string, leadId: number): string {
  return `${ID_CUTUCADA}-${unitId}-${leadId}`;
}

/** A marca que a mensagem gravada leva em `meta` (a conta do teto do dia a conhece: `CHAVES_DE_RETOMADA`). */
export const META_DA_CUTUCADA = { cutucada: 1 } as const;

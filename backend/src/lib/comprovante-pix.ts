/**
 * Comprovante de Pix lido pela visão, conferido por CÓDIGO antes de a Sofia marcar consulta sozinha.
 *
 * Decisão do João (03/11/2026), só para unidade com `spine_booking_requires_payment` (hoje, Boa Vista): o paciente manda o
 * comprovante da taxa de reserva e a Sofia lança a consulta no CRM da franquia sem esperar a equipe. Reverte, só nessas
 * unidades, a decisão de 26/10 (`lib/pagamento-antecipado.ts`). Imagem NÃO prova pagamento — só o extrato prova; por isso
 * este módulo existe: ele tira da frente o comprovante errado, repetido, velho ou editado, e a equipe ganha a tarefa de
 * conferir o extrato depois (`agent/comprovante-da-taxa.ts`).
 *
 * A visão devolve CAMPOS (`DadosDoComprovante`, `services/vision.service.ts`) e eles são GUARDADOS NO BANCO (`lib/comprovante-lido.ts`),
 * presos à unidade, ao cartão e à imagem lida. Na fala do paciente só vai uma referência opaca `[comprovante-lido:<uuid>]`. NADA que
 * está no texto da conversa vale como dado do comprovante: texto digitado pelo paciente (WhatsApp, salesbot, Meta, áudio transcrito,
 * conversa oficial do Kommo) não consegue fabricar uma leitura, porque a decisão só confia no que o servidor gravou ao ler a imagem.
 * Tudo aqui é puro e determinístico; o que fala com banco/Kommo está fora.
 *
 * Identificação fim a fim do Pix (E2E, Manual de Padrões para Iniciação do Pix, Bacen): 32 caracteres =
 * `E` + ISPB de quem pagou (8 dígitos) + data e hora da transação `AAAAMMDDhhmm` (12 dígitos, em UTC) + 11 alfanuméricos.
 * ATENÇÃO: o formato acima é o do manual conforme conhecido pelo autor deste módulo; não foi conferido contra o PDF do Bacen
 * neste ambiente (sem acesso). Por isso a data do E2E é comparada com a do recibo aceitando UTC, Brasília (UTC-3) e hora local
 * de Boa Vista (UTC-4) — ver `DESLOCAMENTOS_HORAS`.
 */
import { cnpjValido, cpfValido } from './integracoes/mascaras.js';

/** O que a visão leu do comprovante. Campo ausente na imagem = `null` (a visão é instruída a nunca deduzir). */
export interface DadosDoComprovante {
  /** pix | ted | doc | boleto | cartao | outro — só `pix` tem E2E */
  tipo: string | null;
  valor: number | null;
  /** "AAAA-MM-DDTHH:mm" como está IMPRESSO no recibo (sem fuso) */
  dataHora: string | null;
  favorecidoNome: string | null;
  /** CPF/CNPJ do favorecido como impresso (pode vir mascarado: "**.485.277/****-**") */
  favorecidoDocumento: string | null;
  pagadorNome: string | null;
  bancoPagador: string | null;
  bancoRecebedor: string | null;
  /** ID da transação / E2E, copiado caractere por caractere */
  idTransacao: string | null;
  /** fonte desalinhada, valor sobreposto, layout que não parece app de banco, print de print… ("" = nenhum) */
  sinaisDeEdicao: string;
  /** o modelo achou que a imagem é um recibo genuíno? `null` = não avaliou */
  pareceAutentico: boolean | null;
  motivoAutenticidade: string;
}

// --- A referência na fala do paciente ----------------------------------------------------------------------------------------

const MARCA_DO_CARIMBO = /\[recebido-em:([^\]]+)\]/g;
const REFERENCIA = /\[comprovante-lido:([0-9a-fA-F-]{36})\]/g;
const MARCAS_DO_SISTEMA = /\[(?=\s*(?:(?:imagem|arquivo)\s+do\s+cliente\s*\]|comprovante-lido\s*:|dados-do-comprovante\s*:|recebido-em\s*:))/gi;

/** O carimbo de recebimento do segmento (epoch ms), ou null — só do fluxo antigo (espera da equipe); a decisão de marcar usa a hora do banco. */
export function carimboDoSegmento(segmento: string): number | null {
  let ultima: string | null = null;
  for (const m of String(segmento ?? '').matchAll(MARCA_DO_CARIMBO)) ultima = m[1];
  const t = ultima ? Date.parse(ultima) : NaN;
  return Number.isNaN(t) ? null : t;
}

/** `[comprovante-lido:<uuid>]` — aponta para a leitura guardada no banco. */
export function referenciaDaLeitura(id: string): string {
  return `[comprovante-lido:${id}]`;
}

/** Os ids de leitura citados no texto (sem repetição, na ordem). Citar um id não prova nada: o banco só devolve o que é DESTE cartão. */
export function referenciasNoTexto(texto: string): string[] {
  return [...new Set([...String(texto ?? '').matchAll(REFERENCIA)].map((m) => m[1].toLowerCase()))];
}

/** Tira a referência do texto que vai ao modelo: o modelo lê a transcrição; a leitura em campos é para o código. */
export function semAReferencia(texto: string): string {
  return String(texto ?? '').replace(/ ?\[comprovante-lido:[0-9a-fA-F-]{36}\]/g, '');
}

/**
 * O que o PACIENTE digita (ou a visão transcreve de dentro da imagem) não pode se passar por leitura nossa: "[imagem do cliente]: …",
 * as referências e a hora de recebimento perdem o colchete de abertura. É só defesa extra: o que sustenta a trava é a leitura no banco.
 */
export function neutralizarMarcasDoSistema(texto: string): string {
  return String(texto ?? '').replace(MARCAS_DO_SISTEMA, '(');
}

const texto = (v: unknown, max = 200): string | null => {
  if (typeof v !== 'string') return null;
  const t = v.replace(/\s+/g, ' ').trim().slice(0, max);
  return t === '' ? null : t;
};

/** Valida o que veio da visão (ou do banco) e devolve só campos do tipo certo. `null` se não é um objeto. */
export function normalizarDados(bruto: unknown): DadosDoComprovante | null {
  if (!bruto || typeof bruto !== 'object' || Array.isArray(bruto)) return null;
  const o = bruto as Record<string, unknown>;
  const valor = typeof o.valor === 'number' && Number.isFinite(o.valor) && o.valor >= 0 && o.valor < 1_000_000 ? o.valor : null;
  return {
    tipo: texto(o.tipo, 20)?.toLowerCase() ?? null,
    valor,
    dataHora: texto(o.dataHora, 25),
    favorecidoNome: texto(o.favorecidoNome),
    favorecidoDocumento: texto(o.favorecidoDocumento, 40),
    pagadorNome: texto(o.pagadorNome),
    bancoPagador: texto(o.bancoPagador, 80),
    bancoRecebedor: texto(o.bancoRecebedor, 80),
    idTransacao: texto(o.idTransacao, 80),
    sinaisDeEdicao: texto(o.sinaisDeEdicao, 400) ?? '',
    pareceAutentico: typeof o.pareceAutentico === 'boolean' ? o.pareceAutentico : null,
    motivoAutenticidade: texto(o.motivoAutenticidade, 400) ?? '',
  };
}

// --- E2E ------------------------------------------------------------------------------------------------------------------

/** `E` + ISPB(8) + AAAAMMDDhhmm(12) + 11 alfanuméricos = 32. */
export const FORMATO_DO_E2E = /^E\d{8}\d{12}[A-Za-z0-9]{11}$/;

/** Tira espaços, hífens e quebras que o recibo pode ter no meio do código e põe em maiúsculas (a visão erra a caixa com frequência). Vazio = null. */
export function normalizarE2E(s: string | null | undefined): string | null {
  const t = String(s ?? '').replace(/[\s\-–—_]/g, '').toUpperCase();
  return t === '' ? null : t;
}

/** epoch ms de uma data/hora lida como UTC, ou null se ela não existe (`Date.UTC` "arruma" 31/02 em 03/03: se voltar diferente, não existia). */
function utcSeExiste(a: number, mes: number, d: number, h: number, mi: number): number | null {
  const ms = Date.UTC(a, mes - 1, d, h, mi);
  const t = new Date(ms);
  if (t.getUTCFullYear() !== a || t.getUTCMonth() !== mes - 1 || t.getUTCDate() !== d || t.getUTCHours() !== h || t.getUTCMinutes() !== mi) return null;
  return ms;
}

/** O instante (epoch ms, UTC) gravado no E2E, ou null se o formato ou a data não existem. */
export function instanteDoE2E(e2e: string): number | null {
  if (!FORMATO_DO_E2E.test(e2e)) return null;
  return utcSeExiste(Number(e2e.slice(9, 13)), Number(e2e.slice(13, 15)), Number(e2e.slice(15, 17)), Number(e2e.slice(17, 19)), Number(e2e.slice(19, 21)));
}

/** "AAAA-MM-DDTHH:mm" impresso no recibo → epoch ms lendo os campos como se fossem UTC (o fuso entra em `DESLOCAMENTOS_HORAS`). */
export function instanteImpresso(dataHora: string | null | undefined): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/.exec(String(dataHora ?? '').trim());
  if (!m) return null;
  return utcSeExiste(Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5]));
}

/**
 * Quantas horas somar à hora IMPRESSA para chegar à do E2E: 3 = recibo em Brasília e E2E em UTC (o normal); 4 = recibo na hora de
 * Boa Vista; 0 = o banco gravou a hora local no E2E (acontece) ou o recibo está em UTC.
 */
export const DESLOCAMENTOS_HORAS = [3, 4, 0] as const;
export const TOLERANCIA_DA_HORA_MIN = 10;
const MIN = 60_000;
const HORA = 3_600_000;

export function horaDoReciboBateComE2E(e2eMs: number, impressoMs: number, toleranciaMin = TOLERANCIA_DA_HORA_MIN): boolean {
  return DESLOCAMENTOS_HORAS.some((h) => Math.abs(e2eMs - (impressoMs + h * HORA)) <= toleranciaMin * MIN);
}

/** Idade máxima da transação, medida até o momento em que a Sofia vai marcar. */
export const IDADE_MAXIMA_MS = 48 * HORA;

// --- Favorecido -----------------------------------------------------------------------------------------------------------

const soDigitos = (s: string | null | undefined) => String(s ?? '').replace(/\D/g, '');

/** Nome sem acento, caixa, pontuação e sem "Ltda" (que o banco ora escreve, ora corta). */
export function palavrasDoNome(s: string | null | undefined): string[] {
  return String(s ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter((p) => p !== '' && p !== 'ltda');
}

/**
 * O nome do recibo é o do cadastro, todas as palavras e na ordem; o recibo pode continuar depois ("Bensag Fisioterapia" × "Bensag
 * Fisioterapia e Pilates"). Recibo MAIS CURTO que o cadastro não vale: "Maria Silva" não é "Maria Silva Santos".
 */
export function nomeConfere(doRecibo: string | null | undefined, doCadastro: string | null | undefined, opcoes: { exato?: boolean } = {}): boolean {
  const recibo = palavrasDoNome(doRecibo);
  const cadastro = palavrasDoNome(doCadastro);
  if (recibo.length === 0 || cadastro.length === 0 || recibo.length < cadastro.length) return false;
  if (opcoes.exato && recibo.length !== cadastro.length) return false;
  return cadastro.every((p, i) => recibo[i] === p);
}

export type ResultadoDoDocumento = 'igual' | 'parcial' | 'diferente' | 'ausente';

/**
 * O CPF/CNPJ do recibo contra a chave Pix da unidade (só dígitos). A chave que não é CPF/CNPJ (e-mail, telefone, aleatória) não
 * tem como ser comparada: `ausente`. Recibo mascarado ("**.485.277/****-**"): vale se os dígitos visíveis (6 ou mais) batem na posição.
 */
export function compararDocumento(doRecibo: string | null | undefined, chavePix: string | null | undefined): ResultadoDoDocumento {
  const chave = String(chavePix ?? '').trim();
  if (!/^[\d.\-/\s]+$/.test(chave)) return 'ausente';
  const alvo = soDigitos(chave);
  // Chave só de dígitos pode ser telefone (11 dígitos) ou CPF/CNPJ: só se o dígito verificador fecha ela é tratada como documento.
  if (!(alvo.length === 11 ? cpfValido(alvo) : alvo.length === 14 ? cnpjValido(alvo) : false)) return 'ausente';
  const limpo = String(doRecibo ?? '').replace(/[.\-/\s]/g, '');
  if (limpo === '' || !/^[\d*•xX#]+$/.test(limpo)) return 'ausente';
  if (/^\d+$/.test(limpo)) return limpo === alvo ? 'igual' : 'diferente';
  if (limpo.length !== alvo.length) return 'ausente';
  let visiveis = 0;
  for (let i = 0; i < limpo.length; i++) {
    if (!/\d/.test(limpo[i])) continue;
    visiveis++;
    if (limpo[i] !== alvo[i]) return 'diferente';
  }
  return visiveis >= 6 ? 'parcial' : 'ausente';
}

// --- A decisão sobre UM comprovante ----------------------------------------------------------------------------------------

/**
 * Para onde vai quem não passou:
 *  - `reenviar`: o comprovante tem algo errado que o paciente pode consertar (valor menor, outro favorecido, outro dia…). Ele
 *    ganha um pedido educado de outro comprovante — sem acusação — e a equipe ganha a tarefa com o motivo técnico.
 *  - `equipe`: o comprovante não dá para VERIFICAR (o banco não mostra o E2E, a leitura falhou…). Não adianta pedir outro: vai
 *    para a equipe conferir, como era antes (fluxo de 26/10).
 */
export type DestinoDaRejeicao = 'reenviar' | 'equipe';

export type CodigoDaRejeicao =
  | 'sem_leitura'
  | 'nao_e_pix'
  | 'nao_autentico'
  | 'autenticidade_nao_avaliada'
  | 'sem_valor'
  | 'valor_menor'
  | 'sem_favorecido'
  | 'favorecido_diferente'
  | 'documento_diferente'
  | 'sem_e2e'
  | 'e2e_formato'
  | 'sem_data'
  | 'data_incoerente'
  | 'e2e_no_futuro'
  | 'comprovante_velho'
  | 'de_outra_negociacao'
  | 'e2e_ja_usado'
  | 'e2e_do_mesmo_paciente'
  | 'registro_indisponivel'
  | 'taxa_nao_cadastrada';

export interface Rejeicao {
  ok: false;
  destino: DestinoDaRejeicao;
  codigo: CodigoDaRejeicao;
  /** o motivo técnico, para a tarefa da equipe e para o rastro — nunca para o paciente */
  motivo: string;
}

export interface Aceito {
  ok: true;
  valor: number;
  e2e: string;
  instanteMs: number;
  favorecido: string | null;
  pagador: string | null;
  /** como o favorecido foi reconhecido */
  porDocumento: ResultadoDoDocumento;
  porNome: boolean;
}

export interface ContextoDaAvaliacao {
  /** a taxa de reserva da unidade (R$) — `null` = não cadastrada */
  taxa: number | null;
  pixKey: string | null;
  pixHolder: string | null;
  /** quando o comprovante chegou na conversa (carimbo do webhook); sem ele vale `agora` */
  recebidoEm: number | null;
  /** o instante da conferência (epoch ms) — a idade da transação é medida até aqui */
  agora: number;
}

const rejeita = (destino: DestinoDaRejeicao, codigo: CodigoDaRejeicao, motivo: string): Rejeicao => ({ ok: false, destino, codigo, motivo });
export const brl = (v: number) => `R$ ${v.toFixed(2).replace('.', ',')}`;

/**
 * As checagens, na ordem. O que é inválido (`reenviar`) vem antes do que é só não verificável (`equipe`): o paciente que pagou a
 * menos precisa ouvir isso mesmo que o banco dele não mostre o E2E. A checagem de E2E já usado (banco) é do módulo do agente.
 */
export function avaliarComprovante(dados: DadosDoComprovante | null, ctx: ContextoDaAvaliacao): Aceito | Rejeicao {
  if (!dados) return rejeita('equipe', 'sem_leitura', 'a visão não devolveu os campos do comprovante (falha ou arquivo ilegível)');
  if (ctx.taxa === null || !(ctx.taxa > 0)) return rejeita('equipe', 'taxa_nao_cadastrada', 'a taxa de reserva não está cadastrada na unidade');

  if (dados.pareceAutentico === false) {
    return rejeita('reenviar', 'nao_autentico', `a leitura achou a imagem suspeita: ${dados.motivoAutenticidade || 'sem motivo'}${dados.sinaisDeEdicao ? ` (sinais: ${dados.sinaisDeEdicao})` : ''}`);
  }

  if (dados.valor === null) return rejeita('equipe', 'sem_valor', 'valor ilegível ou ausente no comprovante');
  if (Math.round(dados.valor * 100) < Math.round(ctx.taxa * 100)) {
    return rejeita('reenviar', 'valor_menor', `valor ${brl(dados.valor)} menor que a taxa ${brl(ctx.taxa)}`);
  }

  const doc = compararDocumento(dados.favorecidoDocumento, ctx.pixKey);
  const nomeLido = palavrasDoNome(dados.favorecidoNome).length > 0;
  // O nome sozinho (sem documento que o confirme) tem de ser IGUAL ao do titular: «Clínica X Silva ME» não é «Clínica X». O recibo que continua
  // o nome só vale quando o documento mascarado já bateu nos dígitos visíveis.
  const nomeBate = nomeConfere(dados.favorecidoNome, ctx.pixHolder, { exato: doc !== 'parcial' });
  if (doc === 'diferente') {
    return rejeita('reenviar', 'documento_diferente', `CPF/CNPJ do favorecido (${dados.favorecidoDocumento}) não é o da chave Pix da unidade`);
  }
  if (doc === 'ausente' && !nomeLido) {
    return rejeita('equipe', 'sem_favorecido', 'o comprovante não traz o nome nem o CPF/CNPJ do favorecido de forma legível');
  }
  if (doc !== 'igual' && !nomeBate) {
    // Titular sem cadastro, ou nome PARECIDO (começa igual, mas não é igual): não dá para dizer ao paciente que pagou a outra pessoa. A equipe confere.
    if (palavrasDoNome(ctx.pixHolder).length === 0) return rejeita('equipe', 'sem_favorecido', 'o titular da chave Pix não está cadastrado na unidade: não há com o que comparar o favorecido');
    if (nomeConfere(dados.favorecidoNome, ctx.pixHolder)) {
      return rejeita('equipe', 'favorecido_diferente', `favorecido «${dados.favorecidoNome}» começa igual ao da unidade («${ctx.pixHolder}») mas não é igual, e o recibo não traz CPF/CNPJ que confirme`);
    }
    return rejeita(
      'reenviar',
      'favorecido_diferente',
      `favorecido «${dados.favorecidoNome ?? '?'}» não é o da unidade («${ctx.pixHolder}»)` + (doc === 'parcial' ? ' (documento mascarado confere, nome não)' : ''),
    );
  }

  if (dados.tipo && dados.tipo !== 'pix') return rejeita('equipe', 'nao_e_pix', `o comprovante é de ${dados.tipo}, não de Pix: não tem E2E para conferir`);
  const e2e = normalizarE2E(dados.idTransacao);
  if (!e2e) return rejeita('equipe', 'sem_e2e', 'o comprovante não mostra o ID da transação (E2E): não dá para verificar nem impedir o reuso');
  const e2eMs = instanteDoE2E(e2e);
  if (e2eMs === null) return rejeita('reenviar', 'e2e_formato', `ID da transação «${e2e.slice(0, 40)}» não tem o formato do Pix (E + 8 dígitos + data/hora + 11 caracteres) ou a data nele não existe`);

  const impressoMs = instanteImpresso(dados.dataHora);
  if (impressoMs === null) return rejeita('equipe', 'sem_data', 'data e hora ilegíveis no comprovante');
  if (!horaDoReciboBateComE2E(e2eMs, impressoMs)) {
    return rejeita('reenviar', 'data_incoerente', `a data/hora impressa (${dados.dataHora}) não bate com a do ID da transação (${new Date(e2eMs).toISOString().slice(0, 16)} UTC)`);
  }

  // A transação não pode ser posterior à chegada do comprovante, nem ter mais de 48 h até AGORA (quando a Sofia vai marcar): um
  // comprovante guardado de outra consulta não vale só porque o paciente o mostrou de novo.
  if (e2eMs - (ctx.recebidoEm ?? ctx.agora) > TOLERANCIA_DA_HORA_MIN * MIN) return rejeita('reenviar', 'e2e_no_futuro', 'a transação é posterior ao momento em que o comprovante chegou na conversa');
  if (ctx.agora - e2eMs > IDADE_MAXIMA_MS) {
    // Pedir «outro comprovante» a quem pagou certo e esperou não resolve (soa como pagar de novo): a equipe confere no extrato.
    return rejeita('equipe', 'comprovante_velho', `a transação é de ${new Date(e2eMs).toISOString().slice(0, 16)} UTC, mais de 48 h antes de agora`);
  }

  if (dados.pareceAutentico === null) return rejeita('equipe', 'autenticidade_nao_avaliada', 'a leitura não avaliou a autenticidade da imagem');

  return {
    ok: true,
    valor: dados.valor,
    e2e,
    instanteMs: e2eMs,
    favorecido: dados.favorecidoNome,
    pagador: dados.pagadorNome,
    porDocumento: doc,
    porNome: nomeBate,
  };
}

// --- Qual comprovante vale para ESTA consulta ------------------------------------------------------------------------------

export interface MensagemDaConversa {
  /** `human` | `ai` | `tool` (o `getType()` do LangChain) */
  tipo: string;
  texto: string;
}

/** A leitura guardada no banco de UMA imagem: o que o servidor leu e quando. É a única fonte dos campos do comprovante. */
export interface LeituraGuardada {
  dados: DadosDoComprovante | null;
  /** quando o servidor leu a imagem (hora do banco) */
  recebidoEm: number;
}

/** O que `agendar_consulta` e `remarcar_consulta` devolvem quando marcam. */
export const RESPOSTA_QUE_MARCA = /^(Consulta marcada para|Remarcada (de|para)|A CONSULTA NOVA ESTÁ MARCADA)/;
/** …e o que `cancelar_consulta` devolve: cada uma abre uma negociação nova. */
const MARCO_DA_NEGOCIACAO = new RegExp(`${RESPOSTA_QUE_MARCA.source}|^Consulta de .+ cancelada`);

export function ehMarcoDaNegociacao(textoDaFerramenta: string): boolean {
  return MARCO_DA_NEGOCIACAO.test(String(textoDaFerramenta ?? '').trim());
}

export interface AnaliseDoComprovante {
  /** há leitura guardada de comprovante (foto/PDF) DESTA negociação — depois da última consulta marcada, remarcada ou cancelada */
  temComprovante: boolean;
  aceito?: Aceito & { dados: DadosDoComprovante; posicao: number };
  /** a falha do comprovante mais recente, quando nenhum passou */
  falha?: Rejeicao & { dados: DadosDoComprovante | null };
  /** comprovantes lidos que ficaram de fora por serem de antes da última consulta marcada, remarcada ou cancelada */
  deOutraNegociacao: number;
}

/**
 * O comprovante que vale para a consulta que o paciente quer marcar agora.
 *
 * FONTE DOS CAMPOS: `leituras`, o que o servidor guardou no banco ao ler a imagem (preso à unidade e ao cartão desta conversa). O texto
 * das mensagens só serve para dizer ONDE na conversa cada leitura apareceu (a referência `[comprovante-lido:<uuid>]`): texto digitado,
 * transcrito de áudio ou vindo da conversa oficial do Kommo não traz leitura nenhuma, então não fabrica comprovante.
 *
 * Critério de «desta negociação» (o histórico não tem data por mensagem, então vale a ORDEM da conversa):
 *  1. só conta o comprovante que veio DEPOIS da última consulta marcada, remarcada ou cancelada pela Sofia nesta conversa — o de uma
 *     consulta anterior não paga a próxima (a resposta da ferramenta fica no histórico, e o cancelamento feito neste turno invalida o
 *     comprovante de uma fala anterior). Exceção: o comprovante da ÚLTIMA fala do paciente não vira «de outra negociação» porque a Sofia
 *     cancelou/remarcou depois dele, neste mesmo turno — é para a consulta que ela vai marcar agora;
 *  2. a transação tem de ter no máximo 48 h até o momento de marcar (`avaliarComprovante`) — não há limite de 24 h de espera pela equipe;
 *  3. o E2E nunca foi usado antes (banco, `agent/comprovante-da-taxa.ts`).
 * NÃO se exige que a Sofia tenha mandado a chave Pix antes: a recepção também manda a chave, por fora da conversa da IA, e exigir isso
 * jogaria fora o comprovante de quem pagou certo (e foi justamente a queixa de Boa Vista).
 * Dos que passam, o MAIS RECENTE vale; se nenhum passar, a falha do mais recente é a que se explica.
 */
export function analisarConversa(
  mensagens: ReadonlyArray<MensagemDaConversa>,
  ctx: Omit<ContextoDaAvaliacao, 'recebidoEm'>,
  leituras: ReadonlyMap<string, LeituraGuardada>,
): AnaliseDoComprovante {
  let ultimaFala = -1;
  mensagens.forEach((m, i) => {
    if (m.tipo === 'human') ultimaFala = i;
  });
  const marcos: number[] = [];
  mensagens.forEach((m, i) => {
    if (m.tipo === 'tool' && ehMarcoDaNegociacao(m.texto)) marcos.push(i);
  });
  // a leitura vale se nenhum marco veio depois dela — a menos que ela seja da última fala (os marcos depois são deste turno)
  const valeNestaNegociacao = (i: number) => i === ultimaFala || !marcos.some((m) => m > i);

  // a leitura vale onde a referência aparece pela ÚLTIMA vez (citar de novo uma antiga não a rejuvenesce além disso: o E2E já usado barra)
  const lugar = new Map<string, number>();
  mensagens.forEach((m, i) => {
    if (m.tipo !== 'human') return;
    for (const ref of referenciasNoTexto(m.texto)) if (leituras.has(ref)) lugar.set(ref, i);
  });

  const doEscopo: Array<LeituraGuardada & { posicao: number }> = [];
  let deOutraNegociacao = 0;
  [...lugar.entries()]
    .sort((x, y) => x[1] - y[1])
    .forEach(([ref, i], posicao) => {
      const l = leituras.get(ref) as LeituraGuardada;
      if (valeNestaNegociacao(i)) doEscopo.push({ ...l, posicao });
      else deOutraNegociacao++;
    });

  const analise: AnaliseDoComprovante = { temComprovante: doEscopo.length > 0, deOutraNegociacao };
  for (const c of [...doEscopo].reverse()) {
    const r = avaliarComprovante(c.dados, { ...ctx, recebidoEm: c.recebidoEm });
    if (r.ok) {
      analise.aceito = { ...r, dados: c.dados as DadosDoComprovante, posicao: c.posicao };
      delete analise.falha;
      return analise;
    }
    analise.falha ??= { ...r, dados: c.dados };
  }
  return analise;
}

/** A linha técnica que vai na tarefa da equipe e no rastro: o que foi lido e por que não passou. */
export function resumoDaLeitura(dados: DadosDoComprovante | null): string {
  if (!dados) return 'sem leitura estruturada';
  const partes = [
    dados.valor !== null ? brl(dados.valor) : 'valor ilegível',
    `favorecido: ${dados.favorecidoNome ?? '?'}${dados.favorecidoDocumento ? ` (${dados.favorecidoDocumento})` : ''}`,
    `pagador: ${dados.pagadorNome ?? '?'}`,
    `data: ${dados.dataHora ?? '?'}`,
    `ID: ${dados.idTransacao ?? 'não aparece'}`,
    `autêntico: ${dados.pareceAutentico === null ? 'não avaliado' : dados.pareceAutentico ? 'sim' : 'NÃO'}`,
  ];
  if (dados.sinaisDeEdicao) partes.push(`sinais: ${dados.sinaisDeEdicao}`);
  return partes.join('; ');
}

/**
 * Histórico do KOMMO de uma unidade → CRM (Chatwoot): a DECISÃO, pura (sem rede, sem banco, sem Prisma). Cada cartão da Kommo vira uma
 * `LinhaDoCartao` (uma linha de JSON) com tudo já em nomes do CRM — contato, atributos da conversa, etiquetas, nota-resumo e as últimas
 * mensagens. Quem lê a Kommo é `kommo-historico-leitura.ts`; quem grava no Chatwoot é o importador Ruby (ops/crm-historico-kommo), que não
 * decide nada de negócio: só valida o contrato e insere sem callbacks.
 *
 * De/para das etapas: o MESMO decidido em 12/11/2026 para Parauapebas (comentário de `chatwoot-regua.ts`), estendido ao que Timbó tem:
 *   COMERCIAL  Incoming leads→Novo lead · EM QUALIFICAÇÃO→Sofia qualifica (ou Esperando humano se «Atendimento assumido por humano» = Sim)
 *              · AGENDADO→Agendado (ou Confirmado) · NÃO COMPARECEU→continua Agendado com situação «Não compareceu» · COMPARECEU→Compareceu
 *              · EM NEGOCIAÇÃO→Pós-consulta · GANHO→Fechou · PERDIDO→Perdido
 *              · SEM coluna no CRM (etapa vazia + etiqueta `conferir-etapa`, o dado vai nos atributos e na nota): EM ESPERA (leva `retomar_em` e
 *                `motivo_espera`), CONFERIR NA FRANQUIA, RETORNO PÓS-TRATAMENTO (leva a categoria «Retorno após tratamento»)
 *   TRATAMENTO funil=Tratamento e `etapa_tratamento`: Incoming leads→Entrada · EM TRATAMENTO→Em tratamento · ALTA→Alta · TRATAMENTO CANCELADO→Tratamento cancelado
 *              (quem está em tratamento não leva etapa comercial)
 *
 * A etiqueta `historico` é a TRAVA que protege o paciente: a régua e o CAPI tratam o que já vem com ela como «estado inicial» e nunca disparam
 * por ele. Por isso ela vai em TODA conversa importada (e o importador não a tira).
 */

export const ETIQUETA_HISTORICO = 'historico';
export const ETIQUETA_CONFERIR_ETAPA = 'conferir-etapa';
export const TETO_DE_MENSAGENS = 50;
export const LIMITE_DA_NOTA = 3500;
const STATUS_GANHO = 142;
const STATUS_PERDIDO = 143;
const UTC_MENOS_3_MS = 3 * 3600_000;

/** As listas de opções da conta de Timbó (conta 3). Valor fora da lista NÃO é gravado (vai para a nota). */
export const LISTAS_DO_CRM = {
  situacao_consulta: ['Agendado', 'Confirmado', 'Atendido', 'Não compareceu', 'Remarcado', 'Desmarcado'],
  categoria_consulta: ['Avaliação', 'Sessão', 'Retorno', 'Retorno com exames', 'Retorno após tratamento'],
  qualificacao: ['Quente', 'Morno', 'Frio'],
  motivo_espera: ['Exames', 'Vai decidir', 'Viajando', 'Financeiro agora não', 'Outro'],
  motivo_nao_agendamento: [
    'Não interagiu', 'Não deu continuidade', 'Clicou por engano', 'Sem interesse', 'Outra cidade', 'Vai se organizar', 'Informação para terceiro',
    'Outra patologia', 'Plano de saúde', 'Currículo', 'Sem condições', 'Viajando', 'Fornecedor/propaganda', 'Solicitado exames', 'Caso enviado para a franquia',
    'Decidir com a família', 'Bandeira vermelha', 'Achou caro', 'Não perturbar', 'Lead morto', 'Cancelamento de tratamento',
  ],
  motivo_nao_fechamento: [
    'Plano de saúde', 'Outra patologia', 'Solicitado exames', 'Caso enviado para a franquia', 'Decidir com a familia', 'Mora em outra cidade', 'Bandeira vermelha',
    'Vai viajar', 'Achou caro', 'Vai se organizar financeiramente', 'Assinou contrato', 'Financeiramente vulnerável',
  ],
} as const;

/** Etiquetas `perdido-*` que a conta de Timbó já tem (motivo do CRM → etiqueta). */
const ETIQUETA_DO_MOTIVO: Readonly<Record<string, string>> = {
  'Não deu continuidade': 'perdido-nao-deu-continuidade',
  'Outra cidade': 'perdido-outra-cidade',
  'Plano de saúde': 'perdido-plano-de-saude',
  'Sem interesse': 'perdido-sem-interesse',
};

export const semAcento = (s: unknown): string =>
  String(s ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase();

/** «◷ Data da Consulta» → «DATA DA CONSULTA»: tira o símbolo do começo e o acento. */
export const nomeLimpo = (s: unknown): string => semAcento(s).replace(/^[^A-Z0-9]+/, '').trim();

// ── tipos ────────────────────────────────────────────────────────────────────────────────────────────

/** O que a leitura entrega de um cartão (já resolvido para nomes). */
export interface CartaoDaKommo {
  id: number;
  nome: string;
  funil: string;
  etapa: string;
  statusId: number;
  preco: number;
  criadoEm: number;
  atualizadoEm: number;
  fechadoEm: number | null;
  responsavel: string | null;
  motivoPerda: string | null;
  etiquetas: string[];
  campos: Array<{ nome: string; tipo: string; valor: unknown }>;
}

export interface ContatoDaKommo {
  id: number;
  nome: string | null;
  telefone: string | null;
}

export interface MensagemDaKommo {
  id: string;
  type?: string;
  text?: string | null;
  created_at: number;
  author?: { type?: string | null; name?: string | null } | null;
  attachment?: { type?: string | null } | null;
}

export interface MensagemParaCrm {
  id: string;
  em: number;
  entrada: boolean;
  texto: string;
}

export interface LinhaDoCartao {
  tipo: 'cartao';
  v: 1;
  lead_id: number;
  contato_id: number | null;
  nome: string;
  /** só dígitos com DDI (ex.: 5547991234567); null = sem telefone utilizável (o importador pula e conta) */
  telefone: string | null;
  sem_telefone: 'ausente' | 'invalido' | null;
  funil_kommo: string;
  etapa_kommo: string;
  aberto: boolean;
  criado_em: number;
  atualizado_em: number;
  fechado_em: number | null;
  atributos: Record<string, string | number | boolean>;
  etiquetas: string[];
  nota: string;
  mensagens: MensagemParaCrm[];
  mensagens_total: number;
  /** códigos curtos (sem dado de paciente) do que não pôde ser mapeado */
  avisos: string[];
}

// ── telefone ─────────────────────────────────────────────────────────────────────────────────────────

/**
 * Telefone para o WhatsApp do CRM: só dígitos, com DDI. O Kommo guarda muita gente sem o 55 (DDD + número): 10 ou 11 dígitos ganham o 55.
 * Número que não parece telefone (curto, ou comprido demais) volta null. Não mexe no 9 (o Chatwoot casa as duas formas do Brasil).
 */
/** DDDs que existem no Brasil. */
const DDDS = new Set([11, 12, 13, 14, 15, 16, 17, 18, 19, 21, 22, 24, 27, 28, 31, 32, 33, 34, 35, 37, 38, 41, 42, 43, 44, 45, 46, 47, 48, 49, 51, 53, 54, 55, 61, 62, 63, 64, 65, 66, 67, 68, 69, 71, 73, 74, 75, 77, 79, 81, 82, 83, 84, 85, 86, 87, 88, 89, 91, 92, 93, 94, 95, 96, 97, 98, 99]);

export function foneParaWhatsApp(bruto: string | null | undefined): string | null {
  let d = String(bruto ?? '').replace(/\D/g, '');
  if (d.startsWith('00')) d = d.slice(2); // prefixo de ligação internacional
  else if (d.startsWith('0')) d = d.replace(/^0+/, ''); // prefixo de tronco brasileiro: «047 99123-4567» = DDD 47
  // sem DDI: 10 dígitos = DDD + número (fixo/celular antigo), 11 = DDD + 9 + número; o DDD tem de existir. Fora desse formato e sem DDI de país: não é telefone.
  if (d.length === 10 && DDDS.has(Number(d.slice(0, 2)))) d = `55${d}`;
  else if (d.length === 11 && DDDS.has(Number(d.slice(0, 2))) && d[2] === '9') d = `55${d}`;
  else if (d.length === 10 || d.length === 11) return null;
  if (d.length < 12 || d.length > 15) return null;
  if (d.startsWith('55') && d.length > 13) return null;
  return d;
}

// ── datas ────────────────────────────────────────────────────────────────────────────────────────────

/** Corta por PONTO DE CÓDIGO (um emoji não vira meio-emoji) e tira surrogate solitário: texto que vai para JSON/Postgres tem de ser válido. */
export const cortar = (texto: string, n: number): string => Array.from(String(texto).toWellFormed()).slice(0, n).join('');

const doisD = (n: number) => String(n).padStart(2, '0');
function emBelem(epochSeg: number): Date {
  return new Date(epochSeg * 1000 - UTC_MENOS_3_MS);
}
export const dataDoCrm = (epochSeg: number): string => emBelem(epochSeg).toISOString().slice(0, 10);
export const horaDoCrm = (epochSeg: number): string => {
  const d = emBelem(epochSeg);
  return `${doisD(d.getUTCHours())}:${doisD(d.getUTCMinutes())}`;
};
const dataBr = (epochSeg: number): string => {
  const [a, m, d] = dataDoCrm(epochSeg).split('-');
  return `${d}/${m}/${a}`;
};

// ── leitura dos campos do cartão ─────────────────────────────────────────────────────────────────────

const vazio = (v: unknown): boolean => v === undefined || v === null || (typeof v === 'string' && v.trim() === '');

/** O 1º valor NÃO vazio do campo com este nome (nome sem símbolo/acento). Há nomes repetidos na Kommo («Forma de pagamento»). */
export function valorDoCampo(c: CartaoDaKommo, nome: string): unknown {
  const alvo = nomeLimpo(nome);
  for (const f of c.campos) if (nomeLimpo(f.nome) === alvo && !vazio(f.valor)) return f.valor;
  return undefined;
}
const txt = (v: unknown): string => (typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : typeof v === 'boolean' ? (v ? 'Sim' : 'Não') : '');
const epochDe = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^\d{9,11}$/.test(v.trim()) ? Number(v) : NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
};
const ehSim = (v: unknown): boolean => semAcento(txt(v)) === 'SIM' || v === true;

/** Valor em reais: aceita número ou texto; sem valor/zero = null. */
function dinheiro(v: unknown): number | null {
  const n = typeof v === 'number' ? v : Number(String(v ?? '').replace(',', '.'));
  return Number.isFinite(n) && n > 0 ? n : null;
}
const reais = (n: number): string => `R$ ${n.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** Valor de uma lista, mapeado por nome (sem acento/maiúsculas) para a opção do CRM; fora da lista = null. */
function daLista(valor: string, lista: readonly string[], apelidos: Readonly<Record<string, string>> = {}): string | null {
  const k = semAcento(valor);
  const apelido = apelidos[k];
  if (apelido && lista.includes(apelido)) return apelido;
  return lista.find((o) => semAcento(o) === k) ?? null;
}

/** Motivo de perda/não agendamento da Kommo (campo OU motivo nativo do cartão) → lista `motivo_nao_agendamento` do CRM. */
const APELIDOS_MOTIVO_PERDA: Readonly<Record<string, string>> = {
  'SEM CONDICOES FINANCEIRA': 'Sem condições',
  'SEM CONDICOES FINANCEIRAS': 'Sem condições',
  'ORCAMENTO INSUFICIENTE': 'Sem condições',
  'FINANCEIRAMENTE VULNERAVEL': 'Sem condições',
  'ESTA VIAJANDO': 'Viajando',
  'VAI VIAJAR': 'Viajando',
  'NAO DEU CONTINUIDADE AO ATENDIMENTO': 'Não deu continuidade',
  'PLANO DE SAUDE': 'Plano de saúde',
  'NAO E PACIENTE (CURRICULO)': 'Currículo',
  'MORA EM OUTRA CIDADE': 'Outra cidade',
  'DECIDIR COM A FAMILIA': 'Decidir com a família',
  'VAI SE ORGANIZAR FINANCEIRAMENTE': 'Vai se organizar',
};
export function motivoDeNaoAgendamento(nome: string | null | undefined): string | null {
  return nome ? daLista(nome, LISTAS_DO_CRM.motivo_nao_agendamento, APELIDOS_MOTIVO_PERDA) : null;
}
const APELIDOS_ESPERA: Readonly<Record<string, string>> = {
  'NAO INTERAGIU': 'Outro',
  'NAO DEU CONTINUIDADE': 'Outro',
  'ACHOU CARO': 'Financeiro agora nao',
  'QUERIA CONVENIO': 'Outro',
  'HORARIO NAO ENCAIXA': 'Outro',
  'MORA LONGE / OUTRA CIDADE': 'Outro',
  'VAI FALAR COM A FAMILIA': 'Vai decidir',
};
function motivoDeEspera(nome: string): string | null {
  const k = semAcento(nome);
  const ap = APELIDOS_ESPERA[k];
  if (ap) return daLista(ap, LISTAS_DO_CRM.motivo_espera);
  return daLista(nome, LISTAS_DO_CRM.motivo_espera);
}

// ── etapa ────────────────────────────────────────────────────────────────────────────────────────────

export interface Traducao {
  funil: 'Comercial' | 'Tratamento' | null;
  etapa: string | null;
  etapaTratamento: string | null;
  /** situação da consulta que a etapa IMPÕE (NÃO COMPARECEU) */
  situacao: string | null;
  categoria: string | null;
  etiquetas: string[];
  aviso: string | null;
}

export function traduzirEtapa(c: CartaoDaKommo): Traducao {
  const funil = semAcento(c.funil);
  const etapa = semAcento(c.etapa);
  const base: Traducao = { funil: null, etapa: null, etapaTratamento: null, situacao: null, categoria: null, etiquetas: [], aviso: null };
  const semColuna = (aviso: string, extra: Partial<Traducao> = {}): Traducao => ({ ...base, funil: 'Comercial', etiquetas: [ETIQUETA_CONFERIR_ETAPA], aviso, ...extra });
  if (funil === 'COMERCIAL') {
    if (c.statusId === STATUS_GANHO) return { ...base, funil: 'Comercial', etapa: 'Fechou' };
    if (c.statusId === STATUS_PERDIDO) return { ...base, funil: 'Comercial', etapa: 'Perdido' };
    switch (etapa) {
      case 'INCOMING LEADS':
        return { ...base, funil: 'Comercial', etapa: 'Novo lead' };
      case 'EM QUALIFICACAO':
        return { ...base, funil: 'Comercial', etapa: ehSim(valorDoCampo(c, 'Atendimento assumido por humano')) ? 'Esperando humano' : 'Sofia qualifica' };
      case 'AGENDADO':
        return { ...base, funil: 'Comercial', etapa: semAcento(txt(valorDoCampo(c, 'Situação da consulta'))) === 'CONFIRMADO' ? 'Confirmado' : 'Agendado' };
      case 'NAO COMPARECEU':
        return { ...base, funil: 'Comercial', etapa: 'Agendado', situacao: 'Não compareceu' };
      case 'COMPARECEU':
        return { ...base, funil: 'Comercial', etapa: 'Compareceu' };
      case 'EM NEGOCIACAO':
        return { ...base, funil: 'Comercial', etapa: 'Pós-consulta' };
      case 'EM ESPERA':
        return semColuna('etapa-em-espera');
      case 'CONFERIR NA FRANQUIA':
        return semColuna('etapa-conferir-na-franquia');
      case 'RETORNO POS-TRATAMENTO':
        return semColuna('etapa-retorno-pos-tratamento', { categoria: 'Retorno após tratamento' });
      default:
        return semColuna('etapa-desconhecida');
    }
  }
  if (funil === 'TRATAMENTO') {
    if (c.statusId === STATUS_GANHO) return { ...base, funil: 'Tratamento', etapaTratamento: 'Alta', etiquetas: ['alta'] };
    if (c.statusId === STATUS_PERDIDO) return { ...base, funil: 'Tratamento', etapaTratamento: 'Tratamento cancelado' };
    if (etapa === 'INCOMING LEADS') return { ...base, funil: 'Tratamento', etapaTratamento: 'Entrada' };
    if (etapa === 'EM TRATAMENTO') return { ...base, funil: 'Tratamento', etapaTratamento: 'Em tratamento' };
    return { ...base, funil: 'Tratamento', etiquetas: [ETIQUETA_CONFERIR_ETAPA], aviso: 'etapa-desconhecida' };
  }
  return { ...base, etiquetas: [ETIQUETA_CONFERIR_ETAPA], aviso: 'funil-desconhecido' };
}

// ── atributos da conversa ────────────────────────────────────────────────────────────────────────────

export interface Montagem {
  atributos: Record<string, string | number | boolean>;
  etiquetas: string[];
  avisos: string[];
}

export function atributosDoCartao(c: CartaoDaKommo): Montagem {
  const t = traduzirEtapa(c);
  const a: Record<string, string | number | boolean> = {};
  const avisos: string[] = [];
  const etiquetas = new Set<string>([ETIQUETA_HISTORICO, ...t.etiquetas]);
  if (t.aviso) avisos.push(t.aviso);
  if (t.funil) a.funil = t.funil;
  if (t.etapa) a.etapa = t.etapa;
  if (t.etapaTratamento) a.etapa_tratamento = t.etapaTratamento;

  // consulta
  const consulta = epochDe(valorDoCampo(c, 'Data da Consulta'));
  if (consulta) {
    a.data_consulta = dataDoCrm(consulta);
    a.hora_consulta = horaDoCrm(consulta);
  }
  const situacaoKommo = txt(valorDoCampo(c, 'Situação da consulta'));
  const situacao = t.situacao ?? (situacaoKommo ? daLista(situacaoKommo, LISTAS_DO_CRM.situacao_consulta) : null);
  if (situacao) a.situacao_consulta = situacao;
  else if (situacaoKommo) avisos.push('situacao-fora-da-lista');
  const categoriaKommo = txt(valorDoCampo(c, 'Categoria da consulta'));
  const categoria = t.categoria ?? (categoriaKommo ? daLista(categoriaKommo, LISTAS_DO_CRM.categoria_consulta) : null);
  if (categoria) a.categoria_consulta = categoria;
  else if (categoriaKommo) avisos.push('categoria-fora-da-lista');

  // qualificação e pagamento
  const qual = txt(valorDoCampo(c, 'Qualificação (Quente/Morno/Frio)'));
  const qualificacao = qual ? daLista(qual, LISTAS_DO_CRM.qualificacao) : null;
  if (qualificacao) {
    a.qualificacao = qualificacao;
    if (qualificacao === 'Quente' && !c.fechadoEm) etiquetas.add('quente');
  }
  const antecipado = valorDoCampo(c, 'Pagamento antecipado');
  if (!vazio(antecipado)) a.pagamento_antecipado = ehSim(antecipado);
  const fechou = valorDoCampo(c, 'Fechou tratamento');
  if (t.etapa === 'Fechou') a.fechou_tratamento = true;
  else if (!vazio(fechou)) a.fechou_tratamento = ehSim(fechou);

  // espera
  const retomar = epochDe(valorDoCampo(c, 'Retomar em'));
  if (retomar) a.retomar_em = dataDoCrm(retomar);
  const espera = txt(valorDoCampo(c, 'Motivo da espera'));
  if (espera) {
    const m = motivoDeEspera(espera);
    if (m) a.motivo_espera = m;
    else avisos.push('motivo-espera-fora-da-lista');
  }

  // perda
  if (t.etapa === 'Perdido') {
    const doCampo = txt(valorDoCampo(c, 'Motivo do não agendamento'));
    const motivo = motivoDeNaoAgendamento(doCampo) ?? motivoDeNaoAgendamento(c.motivoPerda);
    if (motivo) {
      a.motivo_nao_agendamento = motivo;
      const e = ETIQUETA_DO_MOTIVO[motivo];
      if (e) etiquetas.add(e);
    } else {
      avisos.push('perdido-sem-motivo-mapeavel');
      etiquetas.add('pendente-de-revisao');
    }
  }
  const naoFechou = txt(valorDoCampo(c, 'Motivo de não fechamento do tratamento'));
  if (naoFechou) {
    const m = daLista(naoFechou, LISTAS_DO_CRM.motivo_nao_fechamento);
    if (m) a.motivo_nao_fechamento = m;
    else avisos.push('motivo-nao-fechamento-fora-da-lista');
  }

  // tratamento
  const sessao = epochDe(valorDoCampo(c, 'Próxima sessão'));
  if (sessao) {
    a.proxima_sessao = dataDoCrm(sessao);
    a.hora_sessao = horaDoCrm(sessao);
  }
  const alta = epochDe(valorDoCampo(c, 'Data de alta'));
  if (alta) a.data_alta = dataDoCrm(alta);
  const retorno = epochDe(valorDoCampo(c, 'Data de retorno com exames'));
  if (retorno) a.data_retorno = dataDoCrm(retorno);
  const compareceu = txt(valorDoCampo(c, 'Compareceu à última sessão marcada'));
  if (compareceu) a.compareceu_ultima_sessao = ehSim(compareceu) ? 'Sim' : 'Não';
  const google = valorDoCampo(c, 'Deixou avaliação (Google)');
  if (!vazio(google)) a.deixou_avaliacao_google = ehSim(google);

  // chaves SEM atributo definido na conta de Timbó (a tela só mostra quando o kit as criar; o código do CRM já as lê)
  const origem = txt(valorDoCampo(c, 'Origem'));
  if (origem) {
    a.origem = origem;
    if (semAcento(origem).startsWith('META')) etiquetas.add('anuncio');
  }
  if (t.etapa === 'Fechou') {
    const valor = dinheiro(valorDoCampo(c, 'Valor do tratamento'));
    if (valor) a.valor_fechado = valor;
  }
  a.kommo_lead_id = c.id;
  return { atributos: a, etiquetas: [...etiquetas], avisos };
}

// ── nota-resumo ──────────────────────────────────────────────────────────────────────────────────────

/** Os campos que entram na nota, nesta ordem (nome na Kommo → rótulo). Só os que tiverem valor. */
const CAMPOS_DA_NOTA: ReadonlyArray<readonly [string, string]> = [
  ['Responsável agendamento', 'Quem agendou'],
  ['Origem', 'Origem'],
  ['Campanha', 'Campanha'],
  ['Plataforma de origem', 'Plataforma'],
  ['Título do anúncio', 'Anúncio'],
  ['Quem indicou', 'Indicação'],
  ['Queixa', 'Queixa'],
  ['Região da dor', 'Região da dor'],
  ['Observações', 'Observações'],
  ['Observações de consulta', 'Observações da consulta'],
  ['Valor da Consulta', 'Valor da consulta'],
  ['Valor do tratamento', 'Valor do tratamento'],
  ['Valor pago / entrada', 'Valor pago/entrada'],
  ['Desconto concedido', 'Desconto'],
  ['Forma de pagamento', 'Forma de pagamento'],
  ['Nº de parcelas', 'Parcelas'],
  ['Tratamento fechado', 'Tratamento fechado'],
  ['Negociação feita', 'Negociação'],
  ['Motivo do não agendamento', 'Motivo do não agendamento (Kommo)'],
  ['Motivo de não fechamento do tratamento', 'Motivo de não fechar (Kommo)'],
  ['Motivo da espera', 'Motivo da espera (Kommo)'],
  ['Sessões previstas', 'Sessões previstas'],
  ['Sessões realizadas', 'Sessões realizadas'],
  ['Nº de faltas em sessão', 'Faltas em sessão'],
  ['Alta', 'Tipo de alta'],
  ['Motivo da insatisfação', 'Motivo da insatisfação'],
  ['Motivo do cancelamento do tratamento', 'Motivo do cancelamento'],
  ['Semáforo', 'Semáforo'],
  ['Plano de saúde', 'Plano de saúde'],
  ['Profissão', 'Profissão'],
  ['Cidade', 'Cidade'],
];

function formatar(f: { tipo: string; valor: unknown }): string {
  if (f.tipo === 'date' || f.tipo === 'date_time') {
    const e = epochDe(f.valor);
    return e ? (f.tipo === 'date_time' ? `${dataBr(e)} ${horaDoCrm(e)}` : dataBr(e)) : txt(f.valor);
  }
  if (f.tipo === 'monetary') {
    const n = dinheiro(f.valor);
    return n ? reais(n) : '';
  }
  if (Array.isArray(f.valor)) return f.valor.map(txt).filter(Boolean).join(', ');
  return txt(f.valor).replace(/\s+/g, ' ');
}

export function notaDoCartao(c: CartaoDaKommo, m: Montagem, extra: { importadoEm: Date; mensagensTotal: number; mensagensNaConversa: number; conversaNaoLida?: boolean }): string {
  const t = traduzirEtapa(c);
  const l: string[] = [];
  l.push(`📥 Histórico da Kommo — cartão #${c.id} (importado em ${dataBr(Math.floor(extra.importadoEm.getTime() / 1000))})`);
  l.push(`Na Kommo: ${c.funil} › ${c.etapa}${t.aviso ? ' — esta etapa não tem coluna no CRM: confira' : ''}`);
  if (c.responsavel) l.push(`Responsável na Kommo: ${c.responsavel}`);
  l.push(`Criado ${dataBr(c.criadoEm)} · atualizado ${dataBr(c.atualizadoEm)}${c.fechadoEm ? ` · fechado ${dataBr(c.fechadoEm)}` : ''}`);
  const consulta = epochDe(valorDoCampo(c, 'Data da Consulta'));
  if (consulta || m.atributos.situacao_consulta) {
    l.push(`Consulta: ${consulta ? `${dataBr(consulta)} ${horaDoCrm(consulta)}` : 'sem data'}${m.atributos.situacao_consulta ? ` · ${m.atributos.situacao_consulta}` : ''}${m.atributos.categoria_consulta ? ` · ${m.atributos.categoria_consulta}` : ''}`);
  }
  if (c.motivoPerda) l.push(`Motivo de perda (Kommo): ${c.motivoPerda}`);
  if (c.preco > 0) l.push(`Orçamento do cartão: ${reais(c.preco)}`);
  const vistos = new Set<string>();
  for (const [nome, rotulo] of CAMPOS_DA_NOTA) {
    const alvo = nomeLimpo(nome);
    for (const f of c.campos) {
      if (nomeLimpo(f.nome) !== alvo || vistos.has(alvo)) continue;
      const v = formatar(f);
      if (!v) continue;
      vistos.add(alvo);
      l.push(`${rotulo}: ${cortar(v, 400)}`);
    }
  }
  // o RODAPÉ (etiquetas, o que conferir, a situação da conversa) nunca é cortado: o que passar do limite sai do MEIO (campos)
  const rodape: string[] = [];
  if (c.etiquetas.length) rodape.push(`Etiquetas na Kommo: ${c.etiquetas.slice(0, 20).join(', ')}`);
  if (m.avisos.length) rodape.push(`Para conferir: ${m.avisos.join(', ')}`);
  rodape.push(
    extra.conversaNaoLida
      ? 'Conversa: a Kommo não entregou a conversa deste cartão (sem permissão de chats ou sem conversa).'
      : extra.mensagensTotal > extra.mensagensNaConversa
      ? `Conversa: as ${extra.mensagensNaConversa} últimas de ${extra.mensagensTotal} mensagens estão abaixo.`
      : extra.mensagensTotal > 0
        ? `Conversa: ${extra.mensagensTotal} mensagens estão abaixo.`
        : 'Conversa: nenhuma mensagem na Kommo.',
  );
  const fim = cortar(rodape.join('\n'), 1500);
  const todo = l.join('\n');
  const folga = Math.max(200, LIMITE_DA_NOTA - fim.length - 3);
  return todo.length > folga ? `${cortar(todo, folga)}\n…\n${fim}` : `${todo}\n${fim}`;
}

// ── mensagens ────────────────────────────────────────────────────────────────────────────────────────

const ROTULO_DO_ANEXO: Readonly<Record<string, string>> = { picture: '[imagem]', voice: '[áudio]', audio: '[áudio]', file: '[arquivo]', video: '[vídeo]', sticker: '[figurinha]' };

/** As últimas `teto` mensagens, em ordem de hora; o texto leva «[imagem]» etc. no lugar do anexo (a mídia da Kommo não é baixada). */
export function mensagensParaCrm(msgs: readonly MensagemDaKommo[], teto = TETO_DE_MENSAGENS): { mensagens: MensagemParaCrm[]; total: number } {
  const vistas = new Set<string>();
  const todas: MensagemParaCrm[] = [];
  for (const m of [...msgs].sort((x, y) => x.created_at - y.created_at)) {
    const id = String(m.id ?? '');
    if (!id || vistas.has(id)) continue;
    vistas.add(id);
    const anexo = m.attachment?.type ? (ROTULO_DO_ANEXO[String(m.attachment.type)] ?? `[${String(m.attachment.type).slice(0, 20)}]`) : '';
    const corpo = String(m.text ?? '').replace(/\u0000/g, '').trim();
    const texto = cortar([corpo, anexo].filter(Boolean).join('\n'), 20_000);
    if (!texto) continue;
    todas.push({ id, em: m.created_at, entrada: m.author?.type === 'external', texto });
  }
  return { mensagens: todas.slice(-teto), total: todas.length };
}

// ── o cartão inteiro ─────────────────────────────────────────────────────────────────────────────────

/** `msgs` null = a Kommo não entregou a conversa (a nota diz isso, em vez de «nenhuma mensagem»). */
export function linhaDoCartao(c: CartaoDaKommo, contato: ContatoDaKommo | null, msgs: readonly MensagemDaKommo[] | null, agora: Date): LinhaDoCartao {
  const m = atributosDoCartao(c);
  const { mensagens, total } = mensagensParaCrm(msgs ?? []);
  const telefone = foneParaWhatsApp(contato?.telefone);
  const nome = (contato?.nome ?? '').trim() || c.nome.trim() || `Cartão ${c.id}`;
  return {
    tipo: 'cartao',
    v: 1,
    lead_id: c.id,
    contato_id: contato?.id ?? null,
    nome: cortar(nome, 255),
    telefone,
    sem_telefone: telefone ? null : contato?.telefone ? 'invalido' : 'ausente',
    funil_kommo: c.funil,
    etapa_kommo: c.etapa,
    aberto: c.statusId !== STATUS_GANHO && c.statusId !== STATUS_PERDIDO,
    criado_em: c.criadoEm,
    atualizado_em: c.atualizadoEm,
    fechado_em: c.fechadoEm,
    atributos: m.atributos,
    etiquetas: m.etiquetas,
    nota: notaDoCartao(c, m, { importadoEm: agora, mensagensTotal: total, mensagensNaConversa: mensagens.length, conversaNaoLida: msgs === null }),
    mensagens,
    mensagens_total: total,
    avisos: m.avisos,
  };
}

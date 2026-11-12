/**
 * A RÉGUA do Kommo de Parauapebas, no Chatwoot (pedido do João, 12/11/2026): "as automações iguais às da Kommo, tudo que der,
 * em seco primeiro". Aqui mora SÓ a decisão (pura, sem rede nem banco): dada uma conversa, o que o worker já viu dela e a hora,
 * quais mensagens da régua estão na hora. Quem fala com o Chatwoot e com o banco é `chatwoot-regua-worker.ts`.
 *
 * Como cada regra é decidida:
 *  - Regra de DATA (consulta, sessão, alta, vencimento, retomar em): o alvo sai do campo da conversa (data + hora, em UTC-3).
 *  - Regra de ENTRADA (perdido há 48 h, etapa nova, etiqueta nova): o Chatwoot não guarda "desde quando", então o worker anota
 *    a 1ª vez que viu aquele valor (`Visto`). O que já estava lá na partida do worker é marcado `inicial` e NUNCA dispara regra
 *    de entrada: sem isso, o 1º ciclo mandaria "reengajamento" a todo o estoque de perdidos de uma vez.
 *  - ATRASO MÁXIMO: regra "X h antes" vale até 2 h depois do alvo (e nunca depois da própria consulta); regra "depois"/em horário
 *    fixo vale até 12 h depois. Passou: não manda (vira só uma linha de log), para não disparar atrasado em massa depois de uma queda.
 *  - JANELA: só entre 08:00 e 20:00 de Belém (UTC-3), segunda a sábado. Fora dela espera — dentro do atraso máximo.
 *  - NUNCA REPETE: a `chave` amarra a ocorrência (a consulta, o `desde` da etapa…). Remarcou → chave nova → avisa de novo.
 *  - Campo faltando no texto → não manda; o seco deixa UMA nota dizendo o que falta (por chave).
 */
import { TEXTOS_PARAU } from './chatwoot-regua-textos.js';

export const ID_REGUA = 'chatwoot-regua';
/** caixa do Chatwoot → slug da unidade. Uma unidade por enquanto. */
export const CAIXAS_REGUA: Readonly<Record<number, string>> = { 2: 'doutor-hernia-parauapebas' };
/** O usuário "📱 Celular da unidade": autor das mensagens que a equipe manda pelo celular (o Evolution usa o token dele). */
export const USUARIO_CELULAR = 7;
export const ETIQUETA_CELULAR = 'respondeu-pelo-celular';
/** O contato do bot do Evolution (não é paciente). */
export const TELEFONE_BOT_EVOLUTION = '+123456';

const HORA = 3600_000;
const DIA = 24 * HORA;
export const ATRASO_MAX_ANTES_MS = 2 * HORA;
export const ATRASO_MAX_DEPOIS_MS = 12 * HORA;
/** Fuso fixo da unidade (Pará não tem horário de verão). */
const UTC_MENOS_3 = 3 * HORA;
/** Consulta sem hora: nas regras "depois" ela conta como meio-dia. */
const HORA_PADRAO_DEPOIS = 12;
/** Perdida só entra na lista se acabou de expirar (para o log não repetir a mesma a cada ciclo). */
export const JANELA_DO_LOG_PERDIDA_MS = 25 * 60_000;
/** Sufixo da regra quando o que se registra é "faltou campo" (não a mensagem). */
export const SUFIXO_FALTA = '!falta';

// ── tipos ──────────────────────────────────────────────────────────────────────────────────────────

export interface MensagemResumo {
  saida: boolean;
  privada: boolean;
  autorId: number | null;
  /** 'user' (agente do Chatwoot), 'contact', 'agent_bot'… */
  autorTipo: string | null;
  criadaEm: Date;
}

export interface ConversaRegua {
  id: number;
  nome: string;
  etiquetas: string[];
  attrs: Record<string, unknown>;
  criadaEm: Date;
  /** nome do agente atribuído à conversa (assignee), se houver */
  atendente: string | null;
  ultima: MensagemResumo | null;
}

/** A 1ª vez que o worker viu a conversa com este valor neste campo. */
export interface Visto {
  valor: string;
  desde: Date;
  /** já estava assim quando o worker passou a olhar: não vale como "entrou agora" */
  inicial: boolean;
}
export type Vistos = ReadonlyMap<string, Visto>;

export interface Memoria {
  vistos: Vistos;
  /** `regra|chave` já registrados (mensagem ou nota de campo faltando) */
  feitos: ReadonlySet<string>;
}

export interface DadosDaUnidade {
  nome: string;
  pixKey: string | null;
  /** valor da consulta com pagamento antecipado, em reais */
  valorAntecipado: number | null;
}

export interface Disparo {
  regra: string;
  chave: string;
  /** nome do modelo no Kommo (rastreio) */
  modelo: string;
  /** texto pronto; null quando falta campo */
  texto: string | null;
  faltando: string[];
  alvo: Date;
}

export interface Decisao {
  disparos: Disparo[];
  /** regras que acabaram de passar do atraso máximo sem disparar (só para o log) */
  perdidas: string[];
}

// ── texto/valor ────────────────────────────────────────────────────────────────────────────────────

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : '');

export function ehSim(v: unknown): boolean {
  if (v === true || v === 1) return true;
  return typeof v === 'string' && ['true', 'sim', '1', 'yes'].includes(v.trim().toLowerCase());
}

interface DataCivil {
  y: number;
  m: number;
  d: number;
  iso: string;
}

/** "2026-11-13" ou ISO ("2026-11-13T03:00:00.000Z"): vale o dia que está escrito. Data impossível = null. */
export function lerData(v: unknown): DataCivil | null {
  const mt = /^(\d{4})-(\d{2})-(\d{2})/.exec(str(v));
  if (!mt) return null;
  const y = Number(mt[1]);
  const m = Number(mt[2]);
  const d = Number(mt[3]);
  const t = new Date(Date.UTC(y, m - 1, d));
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== m - 1 || t.getUTCDate() !== d) return null;
  return { y, m, d, iso: `${mt[1]}-${mt[2]}-${mt[3]}` };
}

/** "14:30", "9:30", "14h30", "14h". Hora impossível ou texto solto = null. */
export function lerHora(v: unknown): { hh: number; mm: number } | null {
  const mt = /^(\d{1,2})(?::(\d{2})|h(\d{2})?)$/i.exec(str(v));
  if (!mt) return null;
  const hh = Number(mt[1]);
  const mm = Number(mt[2] ?? mt[3] ?? 0);
  return hh <= 23 && mm <= 59 ? { hh, mm } : null;
}

const doisDigitos = (n: number) => String(n).padStart(2, '0');

/** Horário de Belém (UTC-3) → instante. */
function emBelem(d: Pick<DataCivil, 'y' | 'm' | 'd'>, hh: number, mm = 0): Date {
  return new Date(Date.UTC(d.y, d.m - 1, d.d, hh, mm) + UTC_MENOS_3);
}

function somarDias(d: DataCivil, n: number): DataCivil {
  const t = new Date(Date.UTC(d.y, d.m - 1, d.d + n));
  const y = t.getUTCFullYear();
  const m = t.getUTCMonth() + 1;
  const dia = t.getUTCDate();
  return { y, m, d: dia, iso: `${y}-${doisDigitos(m)}-${doisDigitos(dia)}` };
}

/** O dia (civil) em Belém de um instante. */
export function diaEmBelem(t: Date): string {
  return new Date(t.getTime() - UTC_MENOS_3).toISOString().slice(0, 10);
}

/** 08:00–20:00 de Belém, segunda a sábado. */
export function janelaAberta(agora: Date): boolean {
  const l = new Date(agora.getTime() - UTC_MENOS_3);
  const h = l.getUTCHours();
  return l.getUTCDay() !== 0 && h >= 8 && h < 20;
}

interface Momento {
  data: DataCivil;
  hora: { hh: number; mm: number } | null;
  /** data + hora, o que identifica a ocorrência (remarcou = outra) */
  chave: string;
}

function momento(dataV: unknown, horaV: unknown): Momento | null {
  const data = lerData(dataV);
  if (!data) return null;
  const hora = lerHora(horaV);
  return { data, hora, chave: hora ? `${data.iso}T${doisDigitos(hora.hh)}:${doisDigitos(hora.mm)}` : data.iso };
}

function instante(m: Momento, horaPadrao: number): Date {
  return emBelem(m.data, m.hora ? m.hora.hh : horaPadrao, m.hora ? m.hora.mm : 0);
}

const ddmm = (d: DataCivil) => `${doisDigitos(d.d)}/${doisDigitos(d.m)}`;
const textoDoMomento = (m: Momento) => (m.hora ? `${ddmm(m.data)} às ${doisDigitos(m.hora.hh)}:${doisDigitos(m.hora.mm)}` : ddmm(m.data));

/** "R$ 350", "R$ 1.234,50". */
export function brl(v: number): string {
  const inteiro = Number.isInteger(v);
  const [i, c] = v.toFixed(2).split('.') as [string, string];
  return `R$ ${i.replace(/\B(?=(\d{3})+(?!\d))/g, '.')}${inteiro ? '' : `,${c}`}`;
}

function valorEmReais(v: unknown): number {
  if (typeof v === 'number') return Number.isFinite(v) && v > 0 ? v : 0;
  let s = str(v).replace(/[^0-9.,]/g, '');
  if (!s) return 0;
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
  const n = Number(s);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** Primeiro nome do contato, com maiúscula; nome sem letra (telefone) = null. */
export function primeiroNome(nome: string): string | null {
  const t = nome.trim().split(/\s+/)[0] ?? '';
  if (!/\p{L}/u.test(t)) return null;
  const limpo = t.replace(/^[^\p{L}]+|[^\p{L}'-]+$/gu, '');
  if (!limpo) return null;
  return limpo === limpo.toLowerCase() || limpo === limpo.toUpperCase() ? limpo.charAt(0).toUpperCase() + limpo.slice(1).toLowerCase() : limpo;
}

// ── o que o worker observa (memória) ───────────────────────────────────────────────────────────────

export const CAMPO_VISTO_CONVERSA = '_visto';
export const CAMPO_PARTIDA = '_partida';
const ETIQUETAS_SDR = ['confirmar-retorno', 'retomada', 'reativacao', 'boas-vindas'] as const;

/** Os valores (não vazios) que a régua acompanha na conversa. Campo ausente aqui = vazio. */
export function camposObservados(c: ConversaRegua): Record<string, string> {
  const a = c.attrs;
  const o: Record<string, string> = {};
  const etapa = str(a.etapa);
  if (etapa) o.etapa = etapa;
  const situ = str(a.situacao_consulta);
  if (situ) o.situacao_consulta = situ;
  if (ehSim(a.fechou_tratamento)) o.fechou_tratamento = 'sim';
  const alta = lerData(a.data_alta);
  if (alta) o.data_alta = alta.iso;
  const sessao = momento(a.proxima_sessao, a.hora_sessao);
  if (sessao) o.proxima_sessao = sessao.chave;
  if (aderenciaNoMeio(a)) o.aderencia_meio = 'sim';
  for (const e of ETIQUETAS_SDR) if (c.etiquetas.includes(e)) o[`etiqueta:${e}`] = 'sim';
  return o;
}

function aderenciaNoMeio(a: Record<string, unknown>): boolean {
  const previstas = Number(a.sessoes_previstas);
  const feitas = Number(a.sessoes_realizadas);
  return Number.isFinite(previstas) && Number.isFinite(feitas) && previstas >= 2 && feitas >= 1 && feitas * 2 >= previstas;
}

export type Mudanca =
  | { tipo: 'criar'; campo: string; valor: string; desde: Date; inicial: boolean }
  | { tipo: 'atualizar'; campo: string; valor: string; desde: Date }
  | { tipo: 'remover'; campo: string };

/**
 * Compara o que a conversa mostra agora com o que o worker tinha visto. Devolve a memória nova e o que gravar no banco.
 * Conversa que o worker nunca viu: o que ela já mostra é `inicial` se é a partida do worker, ou se a conversa é mais velha que a
 * partida (não dá para saber desde quando é assim); conversa nascida depois da partida mostra tudo como novo.
 */
export function atualizarVistos(
  c: ConversaRegua,
  vistos: Vistos,
  agora: Date,
  partida: { primeiraVez: boolean; desde: Date | null },
): { vistos: Vistos; mudancas: Mudanca[] } {
  const conhecida = vistos.has(CAMPO_VISTO_CONVERSA);
  const inicialNovo = conhecida ? false : partida.primeiraVez || (partida.desde !== null && c.criadaEm.getTime() < partida.desde.getTime());
  const obs = camposObservados(c);
  const novo = new Map(vistos);
  const mudancas: Mudanca[] = [];
  if (!conhecida) {
    novo.set(CAMPO_VISTO_CONVERSA, { valor: '1', desde: agora, inicial: inicialNovo });
    mudancas.push({ tipo: 'criar', campo: CAMPO_VISTO_CONVERSA, valor: '1', desde: agora, inicial: inicialNovo });
  }
  for (const [campo, valor] of Object.entries(obs)) {
    const antes = vistos.get(campo);
    if (!antes) {
      novo.set(campo, { valor, desde: agora, inicial: inicialNovo });
      mudancas.push({ tipo: 'criar', campo, valor, desde: agora, inicial: inicialNovo });
    } else if (antes.valor !== valor) {
      novo.set(campo, { valor, desde: agora, inicial: false });
      mudancas.push({ tipo: 'atualizar', campo, valor, desde: agora });
    }
  }
  for (const campo of vistos.keys()) {
    if (campo === CAMPO_VISTO_CONVERSA || campo in obs) continue;
    novo.delete(campo);
    mudancas.push({ tipo: 'remover', campo });
  }
  return { vistos: novo, mudancas };
}

// ── o texto ────────────────────────────────────────────────────────────────────────────────────────

/** Troca os campos {{…}} do modelo do Kommo pelos dados da conversa e da unidade. Campo sem valor entra em `faltando`. */
export function renderizar(modelo: string, c: ConversaRegua, u: DadosDaUnidade): { texto: string | null; faltando: string[] } {
  const bruto = TEXTOS_PARAU[modelo];
  if (bruto === undefined) return { texto: null, faltando: [`texto do modelo ${modelo}`] };
  const a = c.attrs;
  const consulta = momento(a.data_consulta, a.hora_consulta);
  const sessao = momento(a.proxima_sessao, a.hora_sessao);
  const vencimento = lerData(a.vencimento);
  const valorParcela = valorEmReais(a.valor_parcela);
  const faltando: string[] = [];
  const falta = (o: string) => {
    if (!faltando.includes(o)) faltando.push(o);
    return '';
  };
  const texto = bruto.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_todo, nome: string) => {
    switch (nome) {
      case 'contact.name':
        return primeiroNome(c.nome) ?? falta('nome do contato');
      case 'lead.cf.2450736':
        return consulta ? textoDoMomento(consulta) : falta('data da consulta (data_consulta)');
      case 'lead.cf.2450928': {
        // próxima sessão; os modelos do SDR de retorno usam o mesmo campo para o retorno agendado: sem sessão, vale a consulta
        const m = sessao ?? consulta;
        return m ? textoDoMomento(m) : falta('data da próxima sessão (proxima_sessao)');
      }
      case 'lead.cf.2450998':
        return vencimento ? ddmm(vencimento) : falta('vencimento');
      case 'lead.cf.2451112':
      case 'lead.cf.2451110':
        return valorParcela > 0 ? brl(valorParcela) : falta('valor da parcela (valor_parcela)');
      case 'lead.cf.2451104':
        return u.valorAntecipado && u.valorAntecipado > 0 ? brl(u.valorAntecipado) : falta('valor da consulta com pagamento antecipado (não achei no cadastro da unidade)');
      case 'lead.cf.2450798':
        return u.nome.trim() || falta('nome da unidade');
      case 'lead.cf.2451006':
        return u.pixKey?.trim() || falta('chave Pix da unidade (pix_key)');
      case 'lead.cf.2450732':
        return c.atendente?.trim() || falta('atendente atribuído à conversa');
      case 'lead.cf.2450750':
        return str(a.programa) || falta('nome do programa (o Chatwoot não tem esse campo)');
      default:
        return falta(`campo {{${nome}}} sem correspondente no Chatwoot`);
    }
  });
  return faltando.length ? { texto: null, faltando } : { texto, faltando: [] };
}

// ── as regras ──────────────────────────────────────────────────────────────────────────────────────

interface Candidato {
  regra: string;
  chave: string;
  modelo: string;
  alvo: Date;
  kind: 'antes' | 'depois';
  /** regra "antes" nunca vale depois deste instante (a própria consulta) */
  teto?: Date;
}

const ETAPAS_DA_CONSULTA = new Set(['Agendado', 'Confirmado', 'Fechou']);
/** situação em que a consulta ainda está de pé */
const SITUACOES_DE_PE = new Set(['', 'Agendado', 'Confirmado', 'Remarcado']);
const MODELO_DA_ESPERA: Record<string, string> = {
  Exames: 'parau_espera_exames',
  Viajando: 'parau_espera_viagem',
  'Vai decidir': 'parau_espera_decisao',
  'Financeiro agora não': 'parau_espera_financeiro',
};
const MODELO_DA_ETIQUETA: Record<string, { regra: string; modelo: string; respeitaSemFollowUp: boolean }> = {
  'confirmar-retorno': { regra: 'sdr-confirmar-retorno', modelo: 'parau_sdr_confirmacao_retorno', respeitaSemFollowUp: false },
  retomada: { regra: 'sdr-retomada', modelo: 'parau_sdr_retomada_pos_ligacao', respeitaSemFollowUp: true },
  reativacao: { regra: 'sdr-reativacao', modelo: 'parau_sdr_reativacao_lead_frio', respeitaSemFollowUp: true },
  'boas-vindas': { regra: 'sdr-boas-vindas', modelo: 'parau_sdr_boas_vindas_programa', respeitaSemFollowUp: false },
};

/** "X horas antes" de um compromisso (consulta ou sessão): sem hora, a véspera vale 09:00 do dia anterior e as outras duas não existem. */
function lembretes(m: Momento, regras: { vespera: [string, string]; dia?: [string, string]; preparo?: [string, string] }): Candidato[] {
  const saida: Candidato[] = [];
  const teto = m.hora ? instante(m, 0) : emBelem(m.data, 8);
  saida.push({
    regra: regras.vespera[0],
    modelo: regras.vespera[1],
    chave: m.chave,
    kind: 'antes',
    teto,
    alvo: m.hora ? new Date(instante(m, 0).getTime() - DIA) : emBelem(somarDias(m.data, -1), 9),
  });
  if (m.hora && regras.dia) saida.push({ regra: regras.dia[0], modelo: regras.dia[1], chave: m.chave, kind: 'antes', teto, alvo: new Date(teto.getTime() - 3 * HORA) });
  if (m.hora && regras.preparo) saida.push({ regra: regras.preparo[0], modelo: regras.preparo[1], chave: m.chave, kind: 'antes', teto, alvo: new Date(teto.getTime() - HORA) });
  return saida;
}

function candidatos(c: ConversaRegua, vistos: Vistos): Candidato[] {
  const a = c.attrs;
  const etapa = str(a.etapa);
  const situ = str(a.situacao_consulta);
  const tratamento = str(a.funil) === 'Tratamento' || ehSim(a.fechou_tratamento);
  const semFollowUp = c.etiquetas.includes('sem-follow-up');
  const consulta = momento(a.data_consulta, a.hora_consulta);
  const saida: Candidato[] = [];
  /** o valor visto agora (não o que já estava na partida) */
  const novo = (campo: string, valor?: string): Visto | null => {
    const v = vistos.get(campo);
    return v && !v.inicial && (valor === undefined || v.valor === valor) ? v : null;
  };

  if (!tratamento) {
    // 1–3: perdido há 48/96/120 h
    const perdido = etapa === 'Perdido' ? novo('etapa', 'Perdido') : null;
    if (perdido && !semFollowUp) {
      const chave = `perdido@${perdido.desde.toISOString()}`;
      for (const [h, regra, modelo] of [
        [48, 'followup-48h', 'parau_lead_reengajamento_48h'],
        [96, 'followup-96h', 'parau_lead_metodo_convite_96h'],
        [120, 'followup-120h', 'parau_lead_encerramento_120h'],
      ] as const) {
        saida.push({ regra, modelo, chave, kind: 'depois', alvo: new Date(perdido.desde.getTime() + h * HORA) });
      }
    }
    // 4–5: pré-pagamento
    const agendado = etapa === 'Agendado' ? novo('etapa', 'Agendado') : null;
    if (agendado && ehSim(a.pagamento_antecipado) && situ === 'Agendado' && !c.etiquetas.includes('pagou-antecipado')) {
      const chave = `agendado@${agendado.desde.toISOString()}`;
      saida.push({ regra: 'prepagamento', modelo: 'parau_consulta_prepagamento', chave, kind: 'depois', alvo: agendado.desde });
      saida.push({ regra: 'prepagamento-pendente', modelo: 'parau_consulta_prepagamento_pendente', chave, kind: 'depois', alvo: new Date(agendado.desde.getTime() + 3 * HORA) });
    }
    // 6–8: véspera, dia, preparo
    if (consulta && ETAPAS_DA_CONSULTA.has(etapa) && SITUACOES_DE_PE.has(situ)) {
      saida.push(
        ...lembretes(consulta, {
          vespera: ['consulta-vespera', 'parau_consulta_lembrete_vespera'],
          dia: ['consulta-dia', 'parau_consulta_confirmacao_dia'],
          preparo: ['consulta-preparo', 'parau_consulta_preparo'],
        }),
      );
    }
    // 9–10: falta
    const faltou = situ === 'Não compareceu' ? novo('situacao_consulta', 'Não compareceu') : null;
    // o texto diz "a consulta de hoje": só vale se a falta foi marcada no dia da consulta
    if (faltou && consulta && consulta.data.iso === diaEmBelem(faltou.desde)) {
      saida.push({ regra: 'falta-mesmo-dia', modelo: 'parau_consulta_falta_mesmo_dia', chave: `faltou@${faltou.desde.toISOString()}`, kind: 'depois', alvo: faltou.desde });
    }
    if (situ === 'Não compareceu' && consulta && !semFollowUp) {
      saida.push({ regra: 'falta-48h', modelo: 'parau_consulta_falta_48h', chave: consulta.chave, kind: 'depois', alvo: new Date(instante(consulta, HORA_PADRAO_DEPOIS).getTime() + 2 * DIA) });
    }
    // 11–14: depois do atendimento
    if (consulta && situ === 'Atendido' && (etapa === 'Compareceu' || etapa === 'Pós-consulta')) {
      const base = instante(consulta, HORA_PADRAO_DEPOIS).getTime();
      saida.push({ regra: 'pos-atendimento', modelo: 'parau_consulta_pos_atendimento', chave: consulta.chave, kind: 'depois', alvo: new Date(base + DIA) });
      if (!semFollowUp) {
        saida.push({ regra: 'decisao-4d', modelo: 'parau_decisao_retomada_4d', chave: consulta.chave, kind: 'depois', alvo: new Date(base + 4 * DIA) });
        saida.push({ regra: 'decisao-7d', modelo: 'parau_decisao_encerramento_7d', chave: consulta.chave, kind: 'depois', alvo: new Date(base + 7 * DIA) });
        saida.push({ regra: 'decisao-30d', modelo: 'parau_decisao_reengajamento_30d', chave: consulta.chave, kind: 'depois', alvo: new Date(base + 30 * DIA) });
      }
    }
    // 15–16: retomar em
    const retomar = lerData(a.retomar_em);
    if (retomar && !semFollowUp) {
      const modelo = MODELO_DA_ESPERA[str(a.motivo_espera)];
      const primeira = emBelem(retomar, 9);
      if (modelo) saida.push({ regra: 'espera-retomar', modelo, chave: `retomar@${retomar.iso}`, kind: 'depois', alvo: primeira });
      // a 2ª retomada não vai para quem já respondeu depois da 1ª
      const respondeu = !!c.ultima && !c.ultima.saida && !c.ultima.privada && c.ultima.criadaEm.getTime() > primeira.getTime();
      if (!respondeu) saida.push({ regra: 'espera-retomada2', modelo: 'parau_espera_retomada2', chave: `retomar2@${retomar.iso}`, kind: 'depois', alvo: emBelem(somarDias(retomar, 3), 18) });
    }
    // 17: etiquetas da SDR (ao ver a etiqueta nova)
    for (const [etiqueta, r] of Object.entries(MODELO_DA_ETIQUETA)) {
      const v = c.etiquetas.includes(etiqueta) ? novo(`etiqueta:${etiqueta}`) : null;
      if (v && !(r.respeitaSemFollowUp && semFollowUp)) saida.push({ regra: r.regra, modelo: r.modelo, chave: `${etiqueta}@${v.desde.toISOString()}`, kind: 'depois', alvo: v.desde });
    }
  }

  if (tratamento) {
    // 18: boas-vindas
    const fechou = ehSim(a.fechou_tratamento) ? novo('fechou_tratamento', 'sim') : null;
    if (fechou) saida.push({ regra: 'tratamento-boas-vindas', modelo: 'parau_tratamento_boas_vindas', chave: `fechou@${fechou.desde.toISOString()}`, kind: 'depois', alvo: fechou.desde });
    // 19: primeira sessão (uma vez por proxima_sessao)
    const sessao = momento(a.proxima_sessao, a.hora_sessao);
    const realizadas = Number(a.sessoes_realizadas);
    if (sessao && ehSim(a.fechou_tratamento) && str(a.categoria_consulta) === 'Sessão' && !(realizadas > 0)) {
      const v = novo('proxima_sessao', sessao.chave);
      if (v) saida.push({ regra: 'primeira-sessao', modelo: 'parau_tratamento_primeira_sessao', chave: `primeira@${sessao.chave}`, kind: 'depois', alvo: v.desde });
    }
    // 20–21: véspera e dia da sessão
    if (sessao) saida.push(...lembretes(sessao, { vespera: ['sessao-vespera', 'parau_sessao_lembrete_vespera'], dia: ['sessao-dia', 'parau_sessao_confirmacao_dia'] }));
    // 22: metade das sessões
    const meio = aderenciaNoMeio(a) ? novo('aderencia_meio', 'sim') : null;
    if (meio) saida.push({ regra: 'sessao-aderencia-meio', modelo: 'parau_sessao_aderencia_meio', chave: 'meio', kind: 'depois', alvo: meio.desde });
    // 23–25: alta
    const alta = lerData(a.data_alta);
    if (alta) {
      const v = novo('data_alta', alta.iso);
      if (v) saida.push({ regra: 'alta-conclusao', modelo: 'parau_alta_conclusao', chave: `alta@${alta.iso}`, kind: 'depois', alvo: v.desde });
      saida.push({ regra: 'alta-nps', modelo: 'parau_alta_pesquisa_nps', chave: `alta@${alta.iso}`, kind: 'depois', alvo: emBelem(somarDias(alta, 1), 10) });
      saida.push({ regra: 'alta-retorno-60d', modelo: 'parau_alta_retorno_60d', chave: `alta@${alta.iso}`, kind: 'depois', alvo: emBelem(somarDias(alta, 60), 9) });
    }
    // 26–27: vencimento da parcela
    const venc = lerData(a.vencimento);
    if (venc) {
      saida.push({ regra: 'vencimento-3d', modelo: 'parau_financeiro_vencimento_3d', chave: `venc@${venc.iso}`, kind: 'depois', alvo: emBelem(somarDias(venc, -3), 9) });
      saida.push({ regra: 'vencimento-hoje', modelo: 'parau_financeiro_vencimento_hoje', chave: `venc@${venc.iso}`, kind: 'depois', alvo: emBelem(venc, 9) });
    }
  }
  return saida;
}

/** Até quando a regra ainda vale. */
function limiteDe(k: Candidato): Date {
  if (k.kind === 'depois') return new Date(k.alvo.getTime() + ATRASO_MAX_DEPOIS_MS);
  const ate = k.alvo.getTime() + ATRASO_MAX_ANTES_MS;
  // exclusivo: na hora da própria consulta o lembrete já não faz sentido
  return new Date(k.teto ? Math.min(ate, k.teto.getTime() - 1) : ate);
}

/**
 * Função PURA: o que está na hora de mandar para esta conversa. `memoria.vistos` já deve conter a observação de agora
 * (`atualizarVistos`). Remarcar muda a chave; repetir não acontece (`memoria.feitos`).
 */
export function decidirRegua(c: ConversaRegua, memoria: Memoria, agora: Date, unidade: DadosDaUnidade): Decisao {
  const disparos: Disparo[] = [];
  const perdidas: string[] = [];
  const aberta = janelaAberta(agora);
  for (const k of candidatos(c, memoria.vistos)) {
    if (agora.getTime() < k.alvo.getTime()) continue;
    if (memoria.feitos.has(`${k.regra}|${k.chave}`)) continue;
    const limite = limiteDe(k);
    if (agora.getTime() > limite.getTime()) {
      if (agora.getTime() - limite.getTime() <= JANELA_DO_LOG_PERDIDA_MS) perdidas.push(k.regra);
      continue;
    }
    if (!aberta) continue;
    const r = renderizar(k.modelo, c, unidade);
    if (r.faltando.length && memoria.feitos.has(`${k.regra}${SUFIXO_FALTA}|${k.chave}`)) continue;
    disparos.push({ regra: k.regra, chave: k.chave, modelo: k.modelo, texto: r.texto, faltando: r.faltando, alvo: k.alvo });
  }
  return { disparos, perdidas };
}

/** A nota privada que o modo seco deixa na conversa. */
export function notaDoSeco(d: Disparo): string {
  return d.texto === null
    ? `🧪 [SECO] Régua «${d.regra}» — NÃO enviaria agora, falta: ${d.faltando.join('; ')}.`
    : `🧪 [SECO] Régua «${d.regra}» — enviaria agora:\n\n${d.texto}`;
}

/** Regra 28: a etiqueta `respondeu-pelo-celular`. 'por' | 'tirar' | null (nada a fazer). */
export function decidirEtiquetaCelular(c: ConversaRegua): 'por' | 'tirar' | null {
  const u = c.ultima;
  // nota privada (inclusive as do seco) não diz quem respondeu por último; mensagem do paciente não muda a etiqueta
  if (!u || u.privada || !u.saida || u.autorTipo !== 'user') return null;
  const tem = c.etiquetas.includes(ETIQUETA_CELULAR);
  if (u.autorId === USUARIO_CELULAR) return tem ? null : 'por';
  return tem ? 'tirar' : null;
}

/**
 * Uma conversa da listagem do Chatwoot → o que a régua precisa. null = não é paciente (grupo, bot do Evolution).
 * `last_non_activity_message` vem na própria listagem: nenhuma chamada por conversa.
 */
export function conversaDoChatwoot(raw: any): ConversaRegua | null {
  const id = Number(raw?.id);
  if (!Number.isInteger(id) || id <= 0) return null;
  const sender = raw?.meta?.sender ?? {};
  const identificador = str(sender.identifier);
  const adicionais = raw?.additional_attributes ?? {};
  if (/@g\.us$/i.test(identificador) || str(adicionais.type).toLowerCase() === 'group' || adicionais.group === true) return null;
  if (str(sender.phone_number) === TELEFONE_BOT_EVOLUTION) return null;
  const m = raw?.last_non_activity_message;
  const tipo = Number(m?.message_type);
  const ultima: MensagemResumo | null =
    m && [0, 1, 3].includes(tipo)
      ? {
          saida: tipo === 1 || tipo === 3,
          privada: m.private === true,
          autorId: Number.isInteger(Number(m?.sender?.id)) && m?.sender?.id !== null ? Number(m.sender.id) : null,
          autorTipo: typeof m?.sender?.type === 'string' ? m.sender.type.toLowerCase() : null,
          criadaEm: new Date(Number(m.created_at) * 1000 || 0),
        }
      : null;
  return {
    id,
    nome: str(sender.name),
    etiquetas: Array.isArray(raw?.labels) ? raw.labels.map(String) : [],
    attrs: raw?.custom_attributes && typeof raw.custom_attributes === 'object' ? raw.custom_attributes : {},
    criadaEm: new Date(Number(raw?.created_at) * 1000 || 0),
    atendente: str(raw?.meta?.assignee?.name) || null,
    ultima,
  };
}

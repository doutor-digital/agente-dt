/**
 * Sessões e tratamento da franquia espelhados no bloco EM TRATAMENTO do cartão — e ATUALIZADOS.
 *
 * Por que isto existe, ao lado de `tratamento-para-cartao.ts`: aquele grava "só se vazio", o que é
 * certo para queixa e protocolo e errado para contador. `# Sessões realizadas` que foi gravada uma
 * vez e nunca mais mexida está errada na semana seguinte. Aqui a franquia vence: o valor é
 * recalculado a cada varredura e só vai ao Kommo quando mudou.
 *
 * Definições (combinadas com o João em 02/10/2026; mudar aqui muda o que a SDR lê):
 *  - sessão = agendamento que não é avaliação nem retorno (`ehConsulta`) e pertence a ESTE tratamento:
 *    tem o `idTreatment` dele, ou não traz id nenhum (a ficha do paciente não manda o id de cada
 *    sessão) e então:
 *      · se o paciente tem OUTRO tratamento, a sessão tem de trazer o rótulo deste ("PROTOCOLO 03 MESES -
 *        LOMBAR"): é o que a ficha põe em cada sessão no lugar do id. Sem isso, quem faz cervical e
 *        lombar ao mesmo tempo tinha as duas somadas em cada cartão (Açailândia, 24/10/2026);
 *      · e é posterior à criação do tratamento — o que deixa de fora o ciclo anterior de quem voltou
 *        depois da alta;
 *  - realizadas = status ATENDIDO · faltas = NÃO COMPARECEU;
 *  - marcadas = AGENDADO ou CONFIRMADO ainda por vir;
 *  - previstas = realizadas + faltas + marcadas (desmarcada e remarcada não entram — é arrumação
 *    de agenda, e contá-las faria o tratamento parecer maior do que é);
 *  - próxima = a primeira sessão marcada por vir; última = a última ATENDIDA. Com a chave `chegada-do-dia`
 *    ligada, a «◷ Próxima sessão» do CARTÃO deixa de ser a do tratamento e passa a ser a CHEGADA do paciente
 *    (o primeiro atendimento do dia, somando todos os tratamentos) — ver `chegada-do-dia.ts`;
 *  Sessão agendada com data já passada e sem desfecho na franquia não conta em nada: ninguém sabe
 *  se foi atendida, e chutar aqui seria inventar dado.
 *
 * Campo que a conta não tem é pulado em silêncio (cada clínica nasceu de uma versão do cartão).
 */
import { SPINE_STATUS, type SpineSchedule, type SpineTreatment } from '../services/spine.service.js';
import { ehConsulta, normalizar } from './franquia-sync.js';
import { chegadaDoCartao } from './chegada-do-dia.js';
import type { Estado } from './automacoes-estado.js';

export const CAMPOS_SESSOES = {
  PREVISTAS: '# Sessões no histórico',
  REALIZADAS: '# Sessões realizadas',
  MARCADAS: '# Sessões agendadas (por vir)',
  FALTAS: '# Nº de faltas',
  PROXIMA: '◷ Próxima sessão',
  ULTIMA: '◷ Última sessão',
  LOCAL: '⚕ Local do tratamento',
  GRAU: '⚕ Grau',
  STATUS_TRAT: '⚕ Status do tratamento',
  ID_TRAT: '⚙ idTreatment (franquia)',
} as const;

/**
 * Nomes antigos dos dois campos que foram renomeados em 02/10/2026 ("previstas" era lido como o total
 * do plano e "marcadas" como o que se marcou no mês — nenhum dos dois é o que o número mostra).
 * As contas que ainda não renomearam seguem funcionando: o nome novo vence, o antigo é o plano B.
 */
export const NOMES_ANTIGOS_SESSOES: Record<string, string[]> = {
  [CAMPOS_SESSOES.PREVISTAS]: ['# Sessões previstas'],
  [CAMPOS_SESSOES.MARCADAS]: ['# Sessões marcadas'],
};

/** Acha o campo da conta pelo nome novo ou, na falta, por um nome antigo. `chave` normaliza o nome (igual ao do mapa). */
export function acharCampoDeSessao<T>(porNome: Map<string, T>, nome: string, chave: (n: string) => string): T | undefined {
  for (const n of [nome, ...(NOMES_ANTIGOS_SESSOES[nome] ?? [])]) {
    const achou = porNome.get(chave(n));
    if (achou !== undefined) return achou;
  }
  return undefined;
}

/** Como a ficha do paciente descreve cada tratamento dele (`GET /clients/{id}` → `treatments[]`). */
export interface TratamentoDaFicha {
  idTreatment?: number | null;
  /** "PROTOCOLO 03 MESES, LOMBAR, CRÔNICO" (categoria, local, grau) — ou só "PROTOCOLO 02 MESES" quando não há local */
  typeName?: string | null;
}

/**
 * O rótulo que a ficha põe em cada SESSÃO no lugar do `idTreatment`: "PROTOCOLO 03 MESES - LOMBAR".
 * Medido na Açailândia em 24/10/2026: a ficha manda 0 de 1.238 sessões com idTreatment, mas o rótulo
 * da sessão é exatamente `categoria - local` do tratamento — 2.174 de 2.174 sessões que a agenda
 * (esta sim com o id) permitiu conferir, e nenhum paciente com dois tratamentos de rótulo igual.
 */
export function protocoloDoTratamento(t: { category?: string | null; local?: string | null } | null | undefined): string | null {
  const categoria = String(t?.category ?? '').trim();
  const local = String(t?.local ?? '').trim();
  return categoria && local ? `${categoria} - ${local}` : null;
}

/** "PROTOCOLO 03 MESES, LOMBAR, CRÔNICO" → "PROTOCOLO 03 MESES - LOMBAR"; "PROTOCOLO 02 MESES" → "PROTOCOLO 02 MESES - N/A". Formato que não conheço → null. */
export function protocoloDoTipo(typeName: string | null | undefined): string | null {
  const partes = String(typeName ?? '').split(',').map((x) => x.trim()).filter(Boolean);
  if (partes.length === 1) return `${partes[0]} - N/A`;
  if (partes.length >= 3) return `${partes.slice(0, -2).join(', ')} - ${partes[partes.length - 2]}`;
  return null;
}

export interface CicloDoTratamento {
  /** rótulo que as sessões SEM id deste tratamento carregam; null = não há o que filtrar (tratamento único) ou não sei */
  protocolo: string | null;
  /** false = há outro tratamento e não consigo dizer de qual é cada sessão: não grave contador */
  separavel: boolean;
}

/**
 * Dá para separar as sessões deste tratamento das dos outros do mesmo paciente?
 *  - tratamento único: nada a separar, vale a regra antiga (`desde`);
 *  - vários, rótulo próprio conhecido e diferente dos outros: separa pelo rótulo;
 *  - vários, mesmo rótulo (renovação do mesmo protocolo): só a data de criação separa, então só vale
 *    se ela está em mãos (`temCriacao`); sem ela, não afirma;
 *  - vários e rótulo próprio desconhecido: não afirma.
 */
export function separarCiclo(
  idTreatment: number | null,
  doPaciente: TratamentoDaFicha[] | undefined,
  proprio: { category?: string | null; local?: string | null } | null | undefined,
  temCriacao: boolean,
): CicloDoTratamento {
  const outros = (doPaciente ?? []).filter((t) => t.idTreatment !== idTreatment);
  if (outros.length === 0) return { protocolo: null, separavel: true };
  const meu = (doPaciente ?? []).find((t) => t.idTreatment === idTreatment);
  const protocolo = protocoloDoTipo(meu?.typeName) ?? protocoloDoTratamento(proprio);
  if (!protocolo) return { protocolo: null, separavel: false };
  const repetido = outros.some((o) => normalizar(protocoloDoTipo(o.typeName)) === normalizar(protocolo));
  return { protocolo, separavel: !repetido || temCriacao };
}

export interface ResumoDeSessoes {
  realizadas: number;
  faltas: number;
  marcadas: number;
  previstas: number;
  /** epoch (s) da primeira sessão marcada por vir */
  proxima: number | null;
  /** última sessão atendida: epoch (s) e o dia no fuso da clínica (AAAA-MM-DD) */
  ultima: { epoch: number; dia: string | null } | null;
}

const epochDe = (iso: string | null | undefined): number | null => {
  const ms = Date.parse(String(iso ?? ''));
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
};

/**
 * Conta as sessões do tratamento `idTreatment`. Devolve null quando não há NENHUMA sessão dele na
 * lista — caso em que gravar zero seria afirmar que o tratamento não tem sessão, quando talvez só
 * não tenhamos a agenda dele em mãos.
 */
export function resumirSessoes(
  schedules: SpineSchedule[],
  idTreatment: number | null,
  agoraEpoch: number,
  criadoEm: string | null = null,
  protocolo: string | null = null,
): ResumoDeSessoes | null {
  if (!idTreatment) return null;
  const desde = epochDe(criadoEm);
  const rotulo = protocolo ? normalizar(protocolo) : null;
  const vistos = new Set<number>();
  const sessoes = schedules.filter((s) => {
    if (ehConsulta(s) || !s.dateAttendanceUtc) return false;
    if (s.idTreatment !== null && s.idTreatment !== idTreatment) return false;
    // sem id (é como a ficha chega) e com outro tratamento no paciente: só o rótulo diz de quem é
    if (s.idTreatment === null && rotulo !== null && normalizar(s.categoryName) !== rotulo) return false;
    if (s.idTreatment === null && desde !== null) {
      const quando = epochDe(s.dateAttendanceUtc);
      if (quando === null || quando < desde) return false;
    }
    if (s.idSchedule !== null) {
      if (vistos.has(s.idSchedule)) return false;
      vistos.add(s.idSchedule);
    }
    return true;
  });
  if (sessoes.length === 0) return null;

  let realizadas = 0;
  let faltas = 0;
  let marcadas = 0;
  let proxima: number | null = null;
  let ultima: ResumoDeSessoes['ultima'] = null;
  for (const s of sessoes) {
    const epoch = epochDe(s.dateAttendanceUtc);
    if (epoch === null) continue;
    if (s.idStatus === SPINE_STATUS.ATENDIDO) {
      realizadas++;
      if (!ultima || epoch > ultima.epoch) ultima = { epoch, dia: s.dayLocal ?? (s.dateAttendanceLocal ? s.dateAttendanceLocal.slice(0, 10) : null) };
    } else if (s.idStatus === SPINE_STATUS.NAO_COMPARECEU) {
      faltas++;
    } else if ((s.idStatus === SPINE_STATUS.AGENDADO || s.idStatus === SPINE_STATUS.CONFIRMADO) && epoch > agoraEpoch) {
      marcadas++;
      if (proxima === null || epoch < proxima) proxima = epoch;
    }
  }
  return { realizadas, faltas, marcadas, previstas: realizadas + faltas + marcadas, proxima, ultima };
}

/** "2026-09-28" → "28/09/2026". */
export function diaParaTexto(dia: string | null): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(dia ?? '');
  return m ? `${m[3]}/${m[2]}/${m[1]}` : null;
}

/** O que o planejador precisa saber de um campo da conta: o tipo REAL (cada clínica nasceu de uma versão) e o valor no cartão. */
export interface CampoDoCartao {
  tipo: string;
  valor: string | null;
}

export type EscritaDeSessao = (
  | { campo: string; tipo: 'numeric' | 'date' | 'text' | 'textarea'; valor: string | number; motivo: string; limpar?: false }
  | { campo: string; limpar: true; motivo: string }
) & {
  /**
   * Escrita de uma automação em «só no papel» (chegada-do-dia): quem aplica NÃO grava no Kommo, só registra
   * na tela o que gravaria. Fica na mesma lista para que nenhum caminho novo escape do portão do seco.
   */
  soNoPapel?: 'chegada-do-dia';
};

export interface EntradaSessoes {
  schedules: SpineSchedule[];
  tratamento: (Pick<SpineTreatment, 'idTreatment' | 'local' | 'degree' | 'statusName' | 'created'> & { category?: string | null }) | null;
  /** todos os tratamentos do paciente, como a ficha os descreve; sem isto, o tratamento é tratado como único */
  tratamentosDoPaciente?: TratamentoDaFicha[];
  agoraEpoch: number;
  /** Devolve o campo da conta pelo nome, ou null se a conta não o tem. */
  campo: (nome: string) => CampoDoCartao | null;
  /**
   * Estado da chave `chegada-do-dia` nesta unidade. `ligado` = a ◷ Próxima sessão é a chegada do paciente;
   * `seco` = continua a do tratamento e devolve, à parte (`soNoPapel`), o que a nova gravaria; ausente/`desligado` = como sempre foi.
   */
  chegadaDoDia?: Estado;
  /**
   * Os agendamentos que são SEGURAMENTE deste paciente (ver `agendamentosDoPaciente`), de todos os tratamentos.
   * `schedules` pode misturar homônimos (a agenda é agrupada por nome); a chegada só pode sair desta lista.
   * Ausente = lista vazia (nada se grava nem se limpa por chute): quem liga a chave tem de passá-la.
   */
  schedulesDoPaciente?: SpineSchedule[];
}

const num = (v: string | null): number | null => {
  if (v === null || String(v).trim() === '') return null;
  const n = Number(String(v).replace(',', '.'));
  return Number.isFinite(n) ? n : null;
};

/** Puro: dado o que a franquia sabe e o que o cartão mostra, devolve só o que precisa mudar. */
export function escritasDeSessoes(e: EntradaSessoes): EscritaDeSessao[] {
  const out: EscritaDeSessao[] = [];
  const t = e.tratamento;
  if (!t?.idTreatment) return out;

  // Cada clínica nasceu de uma versão do cartão: o mesmo nome pode ser número numa conta e seleção
  // noutra. Gravar o tipo errado dá 400 do Kommo a cada varredura, então campo de tipo incompatível
  // é pulado — como o campo que a conta não tem.
  const numerico = (nome: string, valor: number, motivo: string) => {
    const c = e.campo(nome);
    if (!c || c.tipo !== 'numeric') return;
    if (num(c.valor) === valor) return;
    out.push({ campo: nome, tipo: 'numeric', valor, motivo });
  };
  const decidirData = (nome: string, epoch: number, motivo: string, atualSeraEste?: number | null): EscritaDeSessao | null => {
    const c = e.campo(nome);
    if (!c || (c.tipo !== 'date' && c.tipo !== 'date_time')) return null;
    const atual = atualSeraEste !== undefined ? atualSeraEste : num(c.valor);
    // `date_time` guarda a hora; `date` guarda só o dia (meia-noite do fuso da conta), então a mesma
    // sessão volta do Kommo até ~24 h diferente do epoch exato — comparar em 60 s regravaria o cartão
    // inteiro a cada varredura.
    const tolerancia = c.tipo === 'date' ? 86_399 : 60;
    if (atual !== null && Math.abs(atual - epoch) <= tolerancia) return null;
    return { campo: nome, tipo: 'date', valor: epoch, motivo };
  };
  const data = (nome: string, epoch: number, motivo: string) => {
    const w = decidirData(nome, epoch, motivo);
    if (w) out.push(w);
  };
  const texto = (nome: string, valor: string | null | undefined, motivo: string) => {
    const v = String(valor ?? '').trim();
    const c = e.campo(nome);
    if (!c || !v || (c.tipo !== 'text' && c.tipo !== 'textarea')) return;
    if (normalizar(c.valor) === normalizar(v)) return;
    out.push({ campo: nome, tipo: c.tipo, valor: v, motivo });
  };

  numerico(CAMPOS_SESSOES.ID_TRAT, t.idTreatment, 'tratamento na franquia');
  texto(CAMPOS_SESSOES.LOCAL, t.local, 'local do tratamento na franquia');
  texto(CAMPOS_SESSOES.GRAU, t.degree, 'grau do tratamento na franquia');
  texto(CAMPOS_SESSOES.STATUS_TRAT, t.statusName, 'status do tratamento na franquia');

  // Paciente com dois tratamentos ao mesmo tempo (cervical + lombar): sem separar as sessões, cada cartão
  // somava as dos dois. Não dá para separar → grava só o que é do tratamento, nunca um contador chutado.
  const ciclo = separarCiclo(t.idTreatment, e.tratamentosDoPaciente, t, t.created != null);
  if (!ciclo.separavel) return out;

  const r = resumirSessoes(e.schedules, t.idTreatment, e.agoraEpoch, t.created ?? null, ciclo.protocolo);
  if (!r) return out; // sem agenda do tratamento em mãos: não afirma zero

  numerico(CAMPOS_SESSOES.REALIZADAS, r.realizadas, 'sessões atendidas na franquia');
  numerico(CAMPOS_SESSOES.FALTAS, r.faltas, 'sessões NÃO COMPARECEU na franquia');
  numerico(CAMPOS_SESSOES.MARCADAS, r.marcadas, 'sessões agendadas por vir na franquia');
  numerico(CAMPOS_SESSOES.PREVISTAS, r.previstas, 'realizadas + faltas + marcadas');

  // A «◷ Próxima sessão». Uma só fonte por vez: a do tratamento (como sempre foi) ou a do paciente (chegada do dia).
  // Em «só no papel» a do tratamento segue gravando e a do paciente só devolve o que gravaria — nunca as duas valendo.
  type Proxima = { epoch: number; motivo?: string } | 'limpar' | 'manter';
  /** O valor que uma escrita deixa no campo: número, null (limpou) ou undefined (não há escrita). */
  const valorDeixado = (w: EscritaDeSessao | null): number | null | undefined => {
    if (!w) return undefined;
    if (w.limpar) return null;
    return typeof w.valor === 'number' ? w.valor : num(String(w.valor));
  };
  // `seraEste`: o valor que o cartão terá depois de outra escrita já decidida (só no «papel»); undefined = o que está nele agora.
  const escritaDaProxima = (p: Proxima, motivo: string, seraEste?: number | null): EscritaDeSessao | null => {
    if (p === 'manter') return null;
    if (p !== 'limpar') return decidirData(CAMPOS_SESSOES.PROXIMA, p.epoch, p.motivo ?? motivo, seraEste);
    // a data que estava lá passou (ou a sessão foi desmarcada): deixar seria mostrar uma "próxima" no passado
    const c = e.campo(CAMPOS_SESSOES.PROXIMA);
    const valorDepois = seraEste !== undefined ? seraEste : c ? num(c.valor) : null;
    const temData = !!c && (c.tipo === 'date' || c.tipo === 'date_time') && valorDepois !== null;
    return temData ? { campo: CAMPOS_SESSOES.PROXIMA, limpar: true, motivo: 'não há sessão marcada por vir' } : null;
  };
  const doTratamento: Proxima = r.proxima !== null ? { epoch: r.proxima } : 'limpar';
  const doPaciente = (): Proxima => {
    // O tratamento DO CARTÃO não tem sessão por vir (ALTA, FINALIZADO): limpa como sempre — sessão de OUTRO tratamento do paciente
    // é do cartão dele. O dia da chegada é o da próxima sessão do tratamento do cartão.
    if (r.proxima === null) return 'limpar';
    const c = chegadaDoCartao(e.schedulesDoPaciente ?? [], r.proxima, e.agoraEpoch);
    // âncora fora da lista do paciente (ficha em cache): o valor de sempre, o do tratamento — e o log diz que a chegada não foi calculada
    if (!c) return { epoch: r.proxima, motivo: 'próxima sessão marcada na franquia (chegada do dia não calculada: a ficha do paciente ainda não tem esta sessão)' };
    if (!c.jaComecou) return { epoch: c.epoch };
    // Já começou: mexer agora faria o gatilho de lembrete do Kommo ler um valor novo (disparo retroativo) — mas só vale proteger um valor
    // que JÁ está no cartão para este dia. Cartão vazio ou com data de outro dia não tem gatilho armado a proteger: recebe a próxima sessão.
    const noCartao = num(e.campo(CAMPOS_SESSOES.PROXIMA)?.valor ?? null);
    return noCartao !== null && Math.abs(noCartao - c.epoch) < 86_400 ? 'manter' : { epoch: r.proxima, motivo: 'próxima sessão marcada na franquia (o cartão não tinha a chegada de hoje)' };
  };
  const modoChegada = e.chegadaDoDia ?? 'desligado';
  const MOTIVO_CHEGADA = 'chegada do dia: primeiro atendimento do paciente (todos os tratamentos)';
  const vale =
    modoChegada === 'ligado'
      ? escritaDaProxima(doPaciente(), MOTIVO_CHEGADA)
      : escritaDaProxima(doTratamento, 'próxima sessão marcada na franquia');
  if (vale) out.push(vale);
  if (modoChegada === 'seco') {
    // contra o que o cartão terá DEPOIS da escrita real (a do tratamento), senão o papel esconderia um vai-e-volta a cada varredura
    const depoisDoReal = valorDeixado(vale);
    const papel = escritaDaProxima(doPaciente(), MOTIVO_CHEGADA, depoisDoReal);
    if (papel && valorDeixado(papel) !== valorDeixado(vale)) out.push({ ...papel, soNoPapel: 'chegada-do-dia' });
  }

  if (r.ultima) {
    const c = e.campo(CAMPOS_SESSOES.ULTIMA);
    if (c && (c.tipo === 'date' || c.tipo === 'date_time')) {
      data(CAMPOS_SESSOES.ULTIMA, r.ultima.epoch, 'última sessão atendida na franquia');
    } else {
      texto(CAMPOS_SESSOES.ULTIMA, diaParaTexto(r.ultima.dia), 'última sessão atendida na franquia');
    }
  }
  return out;
}

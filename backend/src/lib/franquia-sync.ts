/**
 * Franquia → Kommo (fase 1: só campos, nunca etapa).
 *
 * A API da franquia (Spine) é a fonte da verdade da agenda e dos tratamentos.
 * Aqui mora a parte PURA do sincronizador: mapear o que a franquia devolve para
 * as opções exatas do cartão e decidir o que escrever em cada lead. O worker
 * (`franquia-sync-worker.ts`) só busca dados, casa lead com paciente e aplica.
 *
 * Regras combinadas com o João em 14/09/2026 (valor revisto em 19/09/2026):
 *  - campos que a franquia SABE (data, situação, fisioterapeuta, categoria,
 *    tratamento fechado) espelham a franquia — se divergir, a franquia vence;
 *  - "¤ Valor do tratamento" NÃO é espelhado: a rede não lança valor na franquia
 *    (price sempre 0,00), então o Kommo é a fonte (SDR digita / backfill da planilha
 *    base do Drive) e este módulo nunca escreve nem sobrescreve esse campo;
 *  - campos de "quem/quando agendou" só são preenchidos se estiverem vazios;
 *  - nada de mover etapa nesta fase (mover dispara bot no Kommo).
 */
import { SPINE_STATUS, type SpineSchedule } from '../services/spine.service.js';

export const CAMPOS_SYNC = {
  DATA_CONSULTA: '◷ Data da Consulta',
  SITUACAO: '✓ Situação da consulta',
  FISIO: '⚕ Fisioterapeuta',
  CATEGORIA: '⌂ Categoria da consulta',
  AGENDADO_SDR_EM: '◷ Agendado pela SDR em',
  FEITO_POR: '⬢ Agendamento feito por',
  FECHOU_TRAT: '✓ Fechou tratamento',
  TRAT_FECHADO: '⚕ Tratamento fechado',
  VALOR_TRAT: '¤ Valor do tratamento',
} as const;

export type CampoSync = keyof typeof CAMPOS_SYNC;

export function normalizar(s: string | null | undefined): string {
  return String(s ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Só os dígitos, sem o 55 do país — bom pra comparar telefone Kommo × franquia. */
export function chaveTelefone(bruto: string | null | undefined): string {
  let d = String(bruto ?? '').replace(/\D+/g, '');
  if (d.length >= 12 && d.startsWith('55')) d = d.slice(2);
  // compara pelos últimos 8 dígitos: cobre celular com/sem o 9 e DDD divergente
  return d.length > 8 ? d.slice(-8) : d;
}

/**
 * Limpa o título do cartão pra virar busca na franquia: tira a data que a SDR escreve, os parênteses
 * e a pontuação. NÃO separa os nomes — quem faz isso é `termosDeBuscaDoNome`, porque num cartão
 * "MARIA DA PENHA - ALEXANDRO SANT ANA" o paciente pode ser qualquer um dos dois (achado do João, 23/09/2026).
 * "Lead #123" e "Lead 23/09/2026" viram "" (não têm nome pra buscar).
 */
export function nomeParaBusca(nome: string | null | undefined): string {
  let s = String(nome ?? '').replace(/\(.*?\)/g, ' ');
  s = s.replace(/\s*\d{1,2}\/\d{1,2}(\/\d{2,4})?.*$/, '');
  s = s.replace(/[.,;:!?]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (/^lead\b/i.test(s) || s.length < 3) return '';
  return s;
}

/** A franquia prefixa quem nasceu pela IA/n8n ("IA-MARIA DA PENHA", "N-KELLY"): não é parte do nome. Já normalizado. */
export function nomeDaFranquia(n: string | null | undefined): string {
  return normalizar(String(n ?? '').replace(/^(IA|N)-\s*/i, ''));
}

export function situacaoDaConsulta(idStatus: number | null): string | null {
  switch (idStatus) {
    case SPINE_STATUS.AGENDADO: return 'Agendado';
    case SPINE_STATUS.CONFIRMADO: return 'Confirmado';
    case SPINE_STATUS.ATENDIDO: return 'Atendido';
    case SPINE_STATUS.NAO_COMPARECEU: return 'Não compareceu';
    case SPINE_STATUS.REMARCADO: return 'Remarcado';
    case SPINE_STATUS.DESMARCADO: return 'Desmarcado';
    default: return null;
  }
}

/** Categoria da franquia ("AVALIAÇÃO", "Sessão", "Retorno c/ exames"…) → opção do cartão. */
export function categoriaDaConsulta(categoryName: string | null | undefined, opcoes: string[]): string | null {
  const c = normalizar(categoryName);
  if (!c) return null;
  const quer = c.includes('exame')
    ? 'retorno com exames'
    : c.includes('apos') || c.includes('pos tratamento')
      ? 'retorno apos tratamento'
      : c.includes('retorno')
        ? 'retorno'
        : c.includes('sessao')
          ? 'sessao'
          : c.includes('avalia')
            ? 'avaliacao'
            : null;
  if (!quer) return null;
  return opcoes.find((o) => normalizar(o) === quer) ?? null;
}

/**
 * "Bárbara Wirtzbiki" (franquia) → "DRA. BÁRBARA WIRTZBIKI" (opção do cartão).
 * Casa quando TODAS as palavras do nome da franquia (≥ 3 letras) aparecem na
 * opção; se mais de uma opção casar, devolve null (melhor vazio do que errado).
 */
export function casarFisioterapeuta(nomeFranquia: string | null | undefined, opcoes: string[]): string | null {
  const palavras = normalizar(nomeFranquia).split(' ').filter((p) => p.length >= 3 && !['dra', 'dr', 'dos', 'das', 'de'].includes(p));
  if (palavras.length === 0) return null;
  const candidatas = opcoes.filter((o) => {
    const n = ` ${normalizar(o)} `;
    return palavras.every((p) => n.includes(` ${p} `));
  });
  if (candidatas.length === 1) return candidatas[0];
  if (candidatas.length > 1) {
    // várias opções contêm todas as palavras: fica com a que tem exatamente elas
    const exata = candidatas.filter((o) => normalizar(o).replace(/^dra? /, '').split(' ').filter((p) => p.length >= 3).length === palavras.length);
    return exata.length === 1 ? exata[0] : null;
  }
  return null;
}

export interface TratamentoFranquia {
  idTreatment: number | null;
  idClient: number | null;
  clientName: string | null;
  category: string | null;
  local: string | null;
  degree: string | null;
  staffName: string | null;
  statusName: string | null;
  price: number | null;
}

/**
 * "PROTOCOLO 03 MESES" + "CERVICAL" + "CRÔNICO" (franquia) → "03 Meses — CERVICAL CRÔNICO" (cartão):
 * a opção que contém os três pedaços. "Protocolo" é só rótulo da franquia e sai da comparação.
 */
export function opcaoDoTratamento(t: Pick<TratamentoFranquia, 'category' | 'local' | 'degree'>, opcoes: string[]): string | null {
  const pedacos = [t.category, t.local, t.degree]
    .map((p) => normalizar(p).replace(/\bprotocolos?\b/g, '').replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  if (pedacos.length === 0) return null;
  const candidatas = opcoes.filter((o) => {
    const n = normalizar(o);
    return pedacos.every((p) => n.includes(p));
  });
  return candidatas.length === 1 ? candidatas[0] : null;
}

/**
 * Sessão de tratamento NÃO é consulta: o bloco CONSULTA do cartão (Data da
 * Consulta, Situação, Agendado pela SDR em…) é da avaliação/retorno que a SDR
 * marca. Na 1ª varredura (14/09/2026) a próxima sessão de pacientes antigos
 * virou "a consulta" e carimbou "Agendado pela SDR em = agora" — o que inflaria
 * o placar de agendamentos do dia. Só Avaliação e Retorno* contam aqui.
 */
export function ehConsulta(s: Pick<SpineSchedule, 'categoryName'>): boolean {
  const c = normalizar(s.categoryName);
  if (!c) return false;
  if (c.includes('sessao')) return false;
  return c.includes('avalia') || c.includes('retorno');
}

/** Avaliação = o agendamento que a SDR fez; só ela ganha carimbo de "quando/quem agendou". */
export function ehAvaliacao(s: Pick<SpineSchedule, 'categoryName'>): boolean {
  return normalizar(s.categoryName).includes('avalia');
}

/**
 * Qual consulta representa o lead no cartão: a mais recente (avaliação ou
 * retorno) que não foi desmarcada; se todas foram desmarcadas, a mais recente
 * delas (pra Situação virar "Desmarcado" e não ficar "Agendado" pra sempre).
 */
export function escolherConsulta(schedules: SpineSchedule[]): SpineSchedule | null {
  const comData = schedules.filter((s) => s.dateAttendanceUtc && ehConsulta(s));
  if (comData.length === 0) return null;
  const ordem = [...comData].sort((a, b) => String(b.dateAttendanceUtc).localeCompare(String(a.dateAttendanceUtc)));
  return ordem.find((s) => s.idStatus !== SPINE_STATUS.DESMARCADO) ?? ordem[0];
}

export interface ValoresDoLead {
  /** valor atual de cada campo no cartão (string do Kommo; data = epoch em segundos como string) */
  [campo: string]: string | null;
}

export interface Escrita {
  campo: CampoSync;
  nome: string;
  tipo: 'date' | 'select' | 'monetary';
  valor: string | number;
  motivo: string;
}

export interface Entrada {
  valores: ValoresDoLead;
  consulta: SpineSchedule | null;
  /** epoch (s) da consulta segundo a franquia — já convertida do horário local da clínica */
  consultaEpoch: number | null;
  tratamento: TratamentoFranquia | null;
  feitoPelaIa: boolean;
  agoraEpoch: number;
  opcoes: { fisio: string[]; categoria: string[]; tratamento: string[] };
}

function epochDoCartao(v: string | null): number | null {
  if (!v) return null;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Decide o que escrever. Puro: recebe o cartão e a franquia, devolve a lista de escritas. */
export function planejarEscritas(e: Entrada): Escrita[] {
  const out: Escrita[] = [];
  const atual = (c: CampoSync) => e.valores[CAMPOS_SYNC[c]] ?? null;
  const igual = (c: CampoSync, v: string) => normalizar(atual(c)) === normalizar(v);

  if (e.consulta) {
    if (e.consultaEpoch !== null) {
      const noCartao = epochDoCartao(atual('DATA_CONSULTA'));
      if (noCartao === null || Math.abs(noCartao - e.consultaEpoch) > 60) {
        out.push({ campo: 'DATA_CONSULTA', nome: CAMPOS_SYNC.DATA_CONSULTA, tipo: 'date', valor: e.consultaEpoch, motivo: noCartao === null ? 'vazio' : 'franquia diverge' });
      }
    }
    const situacao = situacaoDaConsulta(e.consulta.idStatus);
    if (situacao && !igual('SITUACAO', situacao)) {
      out.push({ campo: 'SITUACAO', nome: CAMPOS_SYNC.SITUACAO, tipo: 'select', valor: situacao, motivo: atual('SITUACAO') ? 'franquia diverge' : 'vazio' });
    }
    const fisio = casarFisioterapeuta(e.consulta.physicalTherapist, e.opcoes.fisio);
    if (fisio && !igual('FISIO', fisio)) {
      out.push({ campo: 'FISIO', nome: CAMPOS_SYNC.FISIO, tipo: 'select', valor: fisio, motivo: atual('FISIO') ? 'franquia diverge' : 'vazio' });
    }
    const categoria = categoriaDaConsulta(e.consulta.categoryName, e.opcoes.categoria);
    if (categoria && !igual('CATEGORIA', categoria)) {
      out.push({ campo: 'CATEGORIA', nome: CAMPOS_SYNC.CATEGORIA, tipo: 'select', valor: categoria, motivo: atual('CATEGORIA') ? 'franquia diverge' : 'vazio' });
    }
    // "quando/quem agendou": só na AVALIAÇÃO (é o agendamento da SDR), só se vazio,
    // e só se a consulta ainda está por vir (senão viraria data inventada)
    const futura = e.consultaEpoch !== null && e.consultaEpoch > e.agoraEpoch;
    if (ehAvaliacao(e.consulta)) {
      if (!atual('AGENDADO_SDR_EM') && futura && e.consulta.idStatus !== SPINE_STATUS.DESMARCADO) {
        out.push({ campo: 'AGENDADO_SDR_EM', nome: CAMPOS_SYNC.AGENDADO_SDR_EM, tipo: 'date', valor: e.agoraEpoch, motivo: 'vazio (carimbo na 1ª detecção)' });
      }
      if (!atual('FEITO_POR')) {
        out.push({ campo: 'FEITO_POR', nome: CAMPOS_SYNC.FEITO_POR, tipo: 'select', valor: e.feitoPelaIa ? 'IA' : 'Humano', motivo: 'vazio' });
      }
    }
  }

  if (e.tratamento) {
    if (!igual('FECHOU_TRAT', 'Sim')) {
      out.push({ campo: 'FECHOU_TRAT', nome: CAMPOS_SYNC.FECHOU_TRAT, tipo: 'select', valor: 'Sim', motivo: 'tratamento em andamento na franquia' });
    }
    const opcao = opcaoDoTratamento(e.tratamento, e.opcoes.tratamento);
    if (opcao && !igual('TRAT_FECHADO', opcao)) {
      out.push({ campo: 'TRAT_FECHADO', nome: CAMPOS_SYNC.TRAT_FECHADO, tipo: 'select', valor: opcao, motivo: atual('TRAT_FECHADO') ? 'franquia diverge' : 'vazio' });
    }
    // "¤ Valor do tratamento" NÃO é escrito pela franquia (decisão de 19/09/2026): a rede não lança o valor lá,
    // a SDR digita no Kommo (obrigatório em EM TRATAMENTO) e esse é o número da receita. O `price` da franquia é ignorado.
    if (!atual('FISIO')) {
      const fisio = casarFisioterapeuta(e.tratamento.staffName, e.opcoes.fisio);
      if (fisio && !out.some((w) => w.campo === 'FISIO')) {
        out.push({ campo: 'FISIO', nome: CAMPOS_SYNC.FISIO, tipo: 'select', valor: fisio, motivo: 'vazio (fisio do tratamento)' });
      }
    }
  }
  return out;
}

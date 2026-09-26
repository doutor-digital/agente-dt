/**
 * O TRATAMENTO da franquia espelhado no cartão.
 *
 * A ficha do paciente (`GET /api/clients/{id}`) devolve, além da pessoa, duas listas que
 * a gente vinha jogando fora: `schedules` (25 sessões num paciente real) e `treatments`
 * (protocolo, preço, fisioterapeuta e a **avaliação clínica**). Medido em 26/09/2026:
 * **19 dos 26 campos do bloco TRATAMENTO da Serra nunca foram preenchidos** — tudo isso
 * é conta sobre dados que a franquia já entrega, digitados hoje à mão ou nunca.
 *
 * A QUEIXA merece uma nota. O `assessment.problem` é escrito pelo fisioterapeuta com o
 * paciente na frente ("DOR LOMBAR IRRADIADA PARA MIE") e tem qualidade clínica que o
 * texto do WhatsApp não tem. Mesmo assim ele **não sobrescreve** o que a IA capturou: o
 * que o paciente disse com as palavras dele é outra informação, não uma versão pior da
 * mesma. Só preenche o buraco — e o buraco é mais da metade dos cartões.
 */
import type { EscritaDoPaciente } from './paciente-para-cartao.js';

export interface SessaoDaFranquia {
  idSchedule?: number | null;
  dateAttendance?: string | null;
  category?: string | null;
  physicalTherapist?: string | null;
  statusName?: string | null;
}

export interface TratamentoDaFranquia {
  idTreatment?: number | null;
  typeName?: string | null;
  price?: string | number | null;
  physicalTherapist?: string | null;
  statusName?: string | null;
  assessment?: { problem?: string | null; description?: string | null } | null;
}

const norm = (s: unknown) =>
  String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();

/** "NÃO COMPARECEU" na franquia — a falta de verdade, que não é desmarcação. */
const FALTOU = /nao compareceu|faltou/;

/**
 * Casa o protocolo da franquia com a opção do cartão.
 *
 * A franquia escreve "PROTOCOLO 03 MESES, LOMBAR, CRÔNICO"; o cartão oferece
 * "03 Meses — LOMBAR CRÔNICO". Não batem por texto, então o casamento é por PEDAÇOS:
 * a duração e a região precisam estar as duas na opção. Sem os dois, devolve `null` —
 * gravar o protocolo errado num campo que decide preço é pior que deixar vazio.
 */
export function protocoloDoCartao(typeName: string | null | undefined, opcoes: string[]): string | null {
  const t = norm(typeName);
  if (!t) return null;

  const duracao = /(\d+)\s*(mes|meses)/.exec(t);
  const regiao = t.includes('cervical') ? 'cervical' : t.includes('lombar') ? 'lombar' : null;
  if (!duracao || !regiao) return null;

  const meses = String(Number(duracao[1]));
  // O qualificador (crônico, agudo, manutenção…) desempata quando há mais de um candidato.
  const qualificadores = ['cronico', 'agudo', 'manutencao', 'preventivo', 'descompressao', 'postural'];
  const qual = qualificadores.find((q) => t.includes(q)) ?? null;

  const candidatos = opcoes.filter((o) => {
    const n = norm(o);
    const d = /(\d+)\s*(mes|meses)/.exec(n);
    return !!d && String(Number(d[1])) === meses && n.includes(regiao);
  });
  if (!candidatos.length) return null;
  if (candidatos.length === 1) return candidatos[0]!;
  if (qual) {
    const exato = candidatos.find((o) => norm(o).includes(qual));
    if (exato) return exato;
  }
  return null; // ambíguo: melhor vazio que o protocolo errado
}

export interface EntradaTratamento {
  sessoes: SessaoDaFranquia[];
  tratamento: TratamentoDaFranquia | null;
  /** Opções do campo `⚕ Tratamento fechado` naquela conta. */
  opcoesProtocolo: string[];
  valorAtual: (campo: string) => string | null;
  agora?: Date;
}

/** O que gravar no bloco TRATAMENTO a partir do que a franquia entrega. */
export function escritasDoTratamento(e: EntradaTratamento): EscritaDoPaciente[] {
  const out: EscritaDoPaciente[] = [];
  const vazio = (c: string) => {
    const v = e.valorAtual(c);
    return v === null || String(v).trim() === '';
  };
  const sePuder = (campo: string, valor: string | number | null, motivo: string, tipo: EscritaDoPaciente['tipo']) => {
    if (valor === null || valor === '' || !vazio(campo)) return;
    out.push({ campo, tipo, valor, motivo, sobrescreve: false });
  };

  const t = e.tratamento;
  if (t) {
    // A queixa clínica do fisioterapeuta — só onde a IA não capturou nada.
    const problema = String(t.assessment?.problem ?? '').trim();
    sePuder('✎ Queixa', problema || null, 'avaliação do fisioterapeuta na franquia', 'textarea');

    const preco = Number(t.price);
    if (Number.isFinite(preco) && preco > 0) {
      sePuder('¤ Valor do tratamento', preco, 'valor do tratamento na franquia', 'numeric');
    }
    const protocolo = protocoloDoCartao(t.typeName, e.opcoesProtocolo);
    sePuder('⚕ Tratamento fechado', protocolo, `protocolo "${t.typeName}" na franquia`, 'select');
    sePuder('⚕ Fisioterapeuta', String(t.physicalTherapist ?? '').trim() || null, 'quem atende na franquia', 'select');
  }

  const sessoes = (e.sessoes ?? []).filter((s) => s?.dateAttendance);
  if (sessoes.length) {
    sePuder('# Sessões previstas', sessoes.length, 'contadas na agenda da franquia', 'numeric');

    const ordenadas = [...sessoes].sort((a, b) =>
      String(a.dateAttendance).localeCompare(String(b.dateAttendance)),
    );
    const ultima = ordenadas[ordenadas.length - 1]!;
    const epoch = Date.parse(String(ultima.dateAttendance).replace(' ', 'T'));
    if (Number.isFinite(epoch)) {
      sePuder('◷ Última sessão marcada', Math.floor(epoch / 1000), 'última sessão na agenda da franquia', 'date');
      sePuder(
        '✓ Compareceu à última sessão marcada',
        FALTOU.test(norm(ultima.statusName)) ? 'Não' : 'Sim',
        `status "${ultima.statusName}" na franquia`,
        'select',
      );
    }

    // Falta é NÃO COMPARECEU. Desmarcado e remarcado não contam — são arrumação de
    // cadastro, e contá-los faria a clínica parecer que perde paciente que não perdeu.
    const faltas = sessoes.filter((s) => FALTOU.test(norm(s.statusName))).length;
    if (faltas > 0) sePuder('# Nº de faltas em sessão', faltas, 'sessões NÃO COMPARECEU na franquia', 'numeric');
  }

  return out;
}

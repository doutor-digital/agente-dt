/**
 * Aviso no WhatsApp do João toda vez que a IA marca uma consulta.
 *
 * Pedido em 18/09/2026, quando Mossoró entrou no ar: nos primeiros dias de uma
 * unidade nova, saber que ela marcou — e para quando — vale mais que qualquer
 * painel. O relatório das 20h conta o dia inteiro; isto conta no instante.
 *
 * É por unidade, de propósito. Ligar na rede toda transformaria o WhatsApp dele
 * em metralhadora: são dezenas de agendamentos por dia somando as 22 unidades,
 * e aviso que chega demais deixa de ser lido. A lista vive em
 * `AVISO_AGENDAMENTO_SLUGS`, no .env do stack.
 */

/** Unidades que avisam. Vazio = nenhuma; `*` = todas (não recomendado). */
export function avisoLigadoPara(slug: string, lista = process.env.AVISO_AGENDAMENTO_SLUGS): boolean {
  const raw = (lista ?? '').trim();
  if (!raw) return false;
  const itens = new Set(raw.split(',').map((s) => s.trim()).filter(Boolean));
  return itens.has('*') || itens.has(slug);
}

export interface AgendamentoParaAvisar {
  unidade: string;
  paciente: string | null;
  /** Já por extenso: "quinta-feira, 25 de setembro". */
  dia: string;
  hora: string;
  especialista?: string | null;
  formaPagamento?: string | null;
  remarcando?: boolean;
}

/**
 * A chave de silêncio. Inclui dia e hora: remarcar a mesma pessoa para outro
 * horário É um evento novo e precisa avisar de novo. Só repetição idêntica
 * (a mesma tool chamada duas vezes no mesmo turno) fica de fora.
 */
export function chaveDoAviso(slug: string, leadId: number | undefined, dia: string, hora: string): string {
  return `agendou:${slug}:${leadId ?? 's/lead'}:${dia}:${hora}`;
}

const PAGAMENTO: Record<string, string> = {
  pix_antecipado: '💳 vai pagar por Pix antecipado',
  na_clinica: '💵 vai pagar na clínica, no dia',
};

export function textoDoAviso(a: AgendamentoParaAvisar): string {
  const quem = a.paciente?.trim() || 'paciente sem nome no cartão';
  const linhas = [
    `${a.remarcando ? '🔄' : '📅'} *${a.unidade}* — a IA ${a.remarcando ? 'remarcou' : 'marcou'} uma consulta`,
    '',
    `👤 ${quem}`,
    `🗓️ ${a.dia} às ${a.hora}`,
  ];
  if (a.especialista?.trim()) linhas.push(`🩺 ${a.especialista.trim()}`);
  const pg = a.formaPagamento ? PAGAMENTO[a.formaPagamento] : null;
  if (pg) linhas.push(pg);
  return linhas.join('\n');
}

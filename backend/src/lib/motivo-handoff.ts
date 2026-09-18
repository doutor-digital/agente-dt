/**
 * Traduz o `motivo` livre que a IA passa em `pausar_ia` pra uma das opções do campo
 * "⬢ Motivo do handoff" (bloco DIGITAL do cartão). O campo é preenchido pela IA, nunca
 * pela SDR — quando nada casa, fica vazio em vez de chutar.
 */
export const MOTIVOS_HANDOFF = ['Pedido do lead', 'IA não soube', 'Fechamento', 'Fora do horário', 'Escalonamento'] as const;
export type MotivoHandoff = (typeof MOTIVOS_HANDOFF)[number];

const REGRAS: Array<[MotivoHandoff, RegExp]> = [
  ['Fora do horário', /fora do hor[aá]rio|fora do expediente|plant[aã]o|hor[aá]rio comercial|fim de semana|feriado/i],
  ['Escalonamento', /irrita|brig|reclama|xing|urg[eê]n|emerg[eê]n|bandeira vermelha|dor (muito )?forte|m[eé]dic|escalon|gest[oã]|supervis|amea[cç]/i],
  ['Fechamento', /fech|pagamento|pagou|comprovante|pix|contrato|cart[aã]o|parcel|boleto|entrada|assin/i],
  ['Pedido do lead', /pediu|pede|quer falar|falar com|prefer[ei]|humano|atendente|pessoa|recep[cç][aã]o|equipe|algu[eé]m/i],
  ['IA não soube', /n[aã]o (sei|soube|consigo|consegui|tenho|encontr|achei)|sem (informa|resposta)|fora do (meu )?escopo|n[aã]o (est[aá] )?(nas|na|em) (fontes|base)|d[uú]vida t[eé]cnica|pergunta (m[eé]dica|cl[ií]nica)|sem vaga|agenda (cheia|lotada|sem)/i],
];

export function classificarMotivoHandoff(motivo: string | null | undefined): MotivoHandoff | null {
  const t = (motivo ?? '').trim();
  if (!t) return null;
  for (const [opcao, re] of REGRAS) if (re.test(t)) return opcao;
  return null;
}

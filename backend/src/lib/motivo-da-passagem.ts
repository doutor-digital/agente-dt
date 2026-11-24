/**
 * Por que a Sofia passou uma conversa para a equipe, em categorias que dá para contar (tela Agente → «Passou para a equipe»).
 *
 * Antes isto não era estruturado: o motivo só existia como TEXTO LIVRE na nota privada do Chatwoot (escrito pelo modelo no `pausar_ia`,
 * ou pelo código nos avisos da agenda e do Pix) e o evento `equipe` do painel não guardava nada. Agora cada passagem grava uma categoria
 * (código curto) em `sofia_evento.detalhe`. Passagens de antes disto ficam «sem motivo registrado». O texto do motivo NÃO vai para o
 * banco do painel (pode ter nome e telefone): só o código.
 *
 * Quem decide a categoria:
 *  - o CÓDIGO sabe a origem dos avisos fixos (Pix que não saiu, agenda/cadastro com problema, horário que não bate): categoria exata;
 *  - o MODELO escreve o motivo do `pausar_ia` em texto livre: aqui ele vira categoria por palavras-chave (heurística, sem inventar: o que
 *    não casa vira «Outro motivo»).
 */

export const MOTIVOS_DA_PASSAGEM = {
  'pediu-pessoa': 'O paciente pediu para falar com uma pessoa',
  'valor-pagamento': 'Valor, desconto ou pagamento',
  convenio: 'Convênio ou plano de saúde',
  clinico: 'Assunto clínico (exame, dor, medicação)',
  reclamacao: 'Reclamação ou insatisfação',
  agenda: 'Problema na agenda ou no cadastro',
  'pix-falhou': 'O Pix do sinal não saiu',
  'horario-divergente': 'Horário combinado não bate com a agenda',
  outro: 'Outro motivo',
} as const;

export type CodigoDoMotivo = keyof typeof MOTIVOS_DA_PASSAGEM;
export const SEM_MOTIVO = 'sem-registro';
export const ROTULO_SEM_MOTIVO = 'Sem motivo registrado';

export const ehCodigoDoMotivo = (v: unknown): v is CodigoDoMotivo => typeof v === 'string' && Object.prototype.hasOwnProperty.call(MOTIVOS_DA_PASSAGEM, v);

/** O rótulo de um código vindo do banco; vazio ou desconhecido = «sem motivo registrado» (nunca inventa). */
export function rotuloDoMotivo(codigo: string | null | undefined): { codigo: string; rotulo: string } {
  return ehCodigoDoMotivo(codigo) ? { codigo, rotulo: MOTIVOS_DA_PASSAGEM[codigo] } : { codigo: SEM_MOTIVO, rotulo: ROTULO_SEM_MOTIVO };
}

const limpar = (t: string): string => t.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/** Regras na ordem: a primeira que casa vence (reclamação e pedido de pessoa antes; clínico antes de valor, para «dor forte» não virar preço). */
const PALAVRAS: ReadonlyArray<[CodigoDoMotivo, RegExp]> = [
  ['reclamacao', /reclam|insatisf|irritad|absurd|procon|processar|pessim/],
  ['pediu-pessoa', /(pede|pediu|quer|prefere|precisa de|exige) (um |uma )?(atendente|humano|pessoa de verdade)|atendente humano|pessoa de verdade|(falar|conversar) com (uma |um )?(pessoa|alguem|a equipe|a recepcao|a secretaria|atendente)|pediu (para )?(falar|conversar)|quer (falar|conversar)|prefere (falar|conversar)/],
  ['convenio', /convenio|plano de saude|unimed|amil|bradesco saude|sulamerica|reembolso do plano/],
  ['clinico', /exame|laudo|ressonancia|tomografia|raio.?x|medicac|remedio|receita|dor (muito )?forte|urgenc|emergenc|cirurgia|pos.?operat|diagnostic|gravidez|gestante/],
  ['valor-pagamento', /valor|preco|desconto|pagamento|parcel|cartao de credito|boleto|pix|cobranca|reembolso|negoci/],
  ['agenda', /agenda|horario|cadastro|duplicad|vaga|remarc|desmarc|cancel|encaixe/],
];

/** Origem do aviso: `modelo` = `pausar_ia` (texto livre do modelo); os outros são avisos fixos do código. */
export type OrigemDaPassagem = 'modelo' | 'agenda' | 'pix' | 'horario';

export function categoriaDoMotivo(texto: string, origem: OrigemDaPassagem = 'modelo'): CodigoDoMotivo {
  if (origem === 'pix') return 'pix-falhou';
  if (origem === 'horario') return 'horario-divergente';
  if (origem === 'agenda') return 'agenda';
  const t = limpar(texto);
  for (const [codigo, re] of PALAVRAS) if (re.test(t)) return codigo;
  return 'outro';
}

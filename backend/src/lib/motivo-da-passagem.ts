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
 *    não casa, ou casa com mais de uma categoria, vira «Outro motivo»).
 */

export const MOTIVOS_DA_PASSAGEM = {
  'pediu-pessoa': 'O paciente pediu para falar com uma pessoa',
  'valor-pagamento': 'Valor, desconto ou pagamento',
  convenio: 'Convênio ou plano de saúde',
  clinico: 'Assunto clínico (exame, dor, medicação)',
  reclamacao: 'Reclamação ou insatisfação',
  agenda: 'Problema na agenda ou no cadastro',
  'pix-falhou': 'O Pix do sinal não saiu',
  'pix-sem-registro': 'Pix enviado, mas sem registro do sinal',
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

/**
 * Palavras-chave por categoria, em texto sem acento e minúsculo, SEMPRE com limite de palavra (`\b`): «amil» não casa dentro de «família», «vaga»
 * não casa em «devagar». Só vale quando UMA categoria casa; se duas casam («preço da ressonância» = valor + clínico) ou nenhuma, é «outro»: categoria
 * errada gravada para sempre é pior que «outro».
 */
const PALAVRAS: ReadonlyArray<[CodigoDoMotivo, RegExp]> = [
  // reclamação = queixa do ATENDIMENTO/serviço (nunca «reclama de dor»: paciente que se queixa da coluna é assunto clínico, não reclamação)
  ['reclamacao', /\binsatisf|\bprocon\b|\bprocessar\b|\bpessim[oa] (atendimento|servico)|\breclam\w* (do|da|de|sobre|com) (o |a )?(atendimento|clinica|demora|cobranca|valor|preco|medico|doutor|doutora|recepcao|secretaria|funcionari\w*|espera|resultado)\b|\breclamacao (do|da|sobre)\b/],
  // pedir uma PESSOA: o pedido explícito («falar com uma pessoa», «quer um atendente»), não a palavra solta
  ['pediu-pessoa', /\b(pede|pediu|quer|prefere|precisa de|exige) (um |uma )?(atendente|humano|pessoa de verdade)\b|\batendente humano\b|\bpessoa de verdade\b|\b(falar|conversar) com (uma |um )?(pessoa|alguem|a equipe|a recepcao|a secretaria|atendente)\b/],
  ['convenio', /\bconvenio\b|\bplano de saude\b|\bunimed\b|\bamil\b|\bbradesco saude\b|\bsulamerica\b|\breembolso do plano\b/],
  ['clinico', /\bexame\b|\blaudo\b|\bressonancia\b|\btomografia\b|\braio.?x\b|\bmedicac\w*|\bremedio\b|\breceita\b|\bdor (muito )?forte\b|\burgenc\w*|\bemergenc\w*|\bcirurgia\b|\bpos.?operat\w*|\bdiagnostic\w*|\bgravidez\b|\bgestante\b/],
  ['valor-pagamento', /\bvalor\b|\bpreco\b|\bdesconto\b|\bpagamento\b|\bparcel\w*|\bcartao de credito\b|\bboleto\b|\bpix\b|\bcobranca\b|\breembolso\b|\bnegoci\w*/],
  ['agenda', /\bagenda\b|\bhorario\b|\bcadastro\b|\bduplicad\w*|\bvaga\b|\bremarc\w*|\bdesmarc\w*|\bcancel\w*|\bencaixe\b/],
];

/** Origem do aviso: `modelo` = `pausar_ia` (texto livre do modelo); os outros são avisos fixos do código. */
export type OrigemDaPassagem = 'modelo' | 'agenda' | 'pix' | 'pix-sem-registro' | 'horario';

export function categoriaDoMotivo(texto: string, origem: OrigemDaPassagem = 'modelo'): CodigoDoMotivo {
  if (origem === 'pix') return 'pix-falhou';
  if (origem === 'pix-sem-registro') return 'pix-sem-registro';
  if (origem === 'horario') return 'horario-divergente';
  if (origem === 'agenda') return 'agenda';
  const t = limpar(texto);
  const casam = PALAVRAS.filter(([, re]) => re.test(t)).map(([codigo]) => codigo);
  return casam.length === 1 ? casam[0]! : 'outro';
}

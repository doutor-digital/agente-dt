/**
 * Diminutivo não sai mais nas mensagens da Sofia.
 *
 * Pedido do João em 23/09/2026, olhando uma mensagem real da Serra: *"Ainda separei dois
 * horarinhos bem tranquilos pra te encaixar essa semana"*. Medido antes de mexer: **~11 mil
 * diminutivos em 30 dias**, em TODAS as unidades — Serra 1.313, Boa Vista 1.179, Araguaína 1.108,
 * Rio Verde 994. Não é vício de uma clínica, é da rede.
 *
 * A causa não era o modelo inventar sozinho: as fichas ENSINAVAM. O exemplo
 * *"deixa eu confirmar isso certinho com a equipe"* estava no material de todas as unidades, e o
 * nosso próprio código mandava "chegue uns 15 minutinhos antes". Foi a mesma história do coração
 * (ver `sem-coracao.ts`): enquanto o exemplo ensina, a regra no prompt não pega.
 *
 * Por isso são três camadas, e esta é a última: os exemplos saíram das fichas e do código, o
 * prompt ganhou a regra, e aqui o que escapar é trocado antes de chegar ao paciente.
 *
 * POR QUE UMA LISTA, E NÃO UMA REGRA GERAL de "-inho/-inha":
 * a regra geral estraga português correto e nome de gente. Na medição apareceram, junto com os
 * diminutivos de verdade: **carteirinha** (palavra que a gente PRECISA, é o convênio),
 * *sobrinho*, *encaminho* (verbo), *figurinha*, *cafezinho*, *postinho*, *campainha*, e nomes
 * como *Terezinha*, *Agostinho*, *Izildinha*, *Coutinho*, *Joaninha*. Trocar qualquer um desses
 * seria pior que o problema. Lista explícita não tem esse risco: o que não está nela não é
 * tocado, nunca.
 */

/**
 * Diminutivo → palavra normal. Só entram os casos em que a troca é sempre gramatical, porque o
 * gênero e o número são os mesmos dos dois lados.
 *
 * Ordenado pela frequência medida em 30 dias, que é o que decide o que vale a pena estar aqui.
 */
const TROCAS: Record<string, string> = {
  // os campeões
  certinho: 'certo', certinha: 'certa', certinhos: 'certos', certinhas: 'certas',
  horarinho: 'horário', horarinhos: 'horários', horariozinho: 'horário',
  vaguinha: 'vaga', vaguinhas: 'vagas',
  pertinho: 'perto', tempinho: 'tempo', pouquinho: 'pouco', pouquinhos: 'poucos',
  direitinho: 'direito', rapidinho: 'rápido', rapidinha: 'rápida',
  jeitinho: 'jeito', coisinha: 'coisa', coisinhas: 'coisas',
  dorzinha: 'dor', dorzinhas: 'dores',
  minutinho: 'minuto', minutinhos: 'minutos',
  instantinho: 'instante', instantinhos: 'instantes',
  agorinha: 'agora', olhadinha: 'olhada',

  // guardar / reservar / separar — a família toda aparece no agendamento
  guardadinho: 'guardado', guardadinha: 'guardada', guardadinhos: 'guardados', guardadinhas: 'guardadas',
  reservadinho: 'reservado', reservadinha: 'reservada', reservadinhos: 'reservados', reservadinhas: 'reservadas',
  separadinho: 'separado', separadinha: 'separada', separadinhos: 'separados', separadinhas: 'separadas',
  marcadinho: 'marcado', marcadinha: 'marcada',
  anotadinho: 'anotado', anotadinha: 'anotada',
  confirmadinho: 'confirmado', confirmadinha: 'confirmada',
  registradinho: 'registrado', registradinha: 'registrada',
  prontinho: 'pronto', prontinha: 'pronta', prontinhos: 'prontos', prontinhas: 'prontas',
  garantidinho: 'garantido', garantidinha: 'garantida',

  // substantivos da conversa
  probleminha: 'problema', perguntinha: 'pergunta', palavrinha: 'palavra',
  espacinho: 'espaço', folguinha: 'folga', consultinha: 'consulta',
  valorzinho: 'valor', nomezinho: 'nome', localzinho: 'local', cadastrinho: 'cadastro',
  detalhezinho: 'detalhe', detalhinho: 'detalhe',
  comecinho: 'começo', finalzinho: 'final', 'manhãzinha': 'manhã',

  // adjetivos que sobraram na medição
  completinho: 'completo', completinha: 'completa',
  curtinho: 'curto', curtinha: 'curta',
  juntinho: 'junto', juntinha: 'junta', juntinhos: 'juntos', juntinhas: 'juntas',
  quietinho: 'quieto', quietinha: 'quieta',
  caladinho: 'calado', caladinha: 'calada',
  tranquilinho: 'tranquilo', tranquilinha: 'tranquila',
  resumidinho: 'resumido', resumidinha: 'resumida',
  detalhadinho: 'detalhado', detalhadinha: 'detalhada',
  perfeitinho: 'perfeito', perfeitinha: 'perfeita',
};

/**
 * Uma varredura só, com as palavras em ordem decrescente de tamanho.
 *
 * O tamanho importa: sem isso `certinho` casaria antes de `certinhos` e deixaria um "s" solto.
 */
const RE = new RegExp(
  `\\b(${Object.keys(TROCAS).sort((a, b) => b.length - a.length).join('|')})\\b`,
  'giu',
);

/** Mantém a caixa do original: "Certinho" no começo da frase não vira "certo". */
function comAMesmaCaixa(original: string, novo: string): string {
  if (original === original.toUpperCase() && original.length > 1) return novo.toUpperCase();
  if (original[0] === original[0]?.toUpperCase()) return novo[0].toUpperCase() + novo.slice(1);
  return novo;
}

export function temDiminutivo(texto: string): boolean {
  return new RegExp(RE.source, 'iu').test(texto);
}

export function semDiminutivo(texto: string): string {
  if (!texto) return texto;
  return texto.replace(RE, (achado) => {
    const troca = TROCAS[achado.toLowerCase()];
    return troca ? comAMesmaCaixa(achado, troca) : achado;
  });
}

/**
 * "Esse telefone já tem OUTRO cartão nesta conta?"
 *
 * Caso Wilson (Rio Verde, 15/09/2026): ele tinha RETORNO marcado para as 14h30,
 * respondeu ao template de véspera — e a resposta caiu num cartão NOVO, porque o
 * telefone estava gravado com o nono dígito e o WhatsApp entrega sem. O Kommo
 * compara telefone como TEXTO, então não casou. A Sofia abriu ficha em branco,
 * tratou um paciente de 12 dias como desconhecido, viu as 14h30 "ocupadas" (por
 * ele mesmo) e terminou remarcando o cara para dois dias depois.
 *
 * O bloco `<etapa_do_lead>` existia justamente para isso, mas só olhava o cartão
 * da conversa. Cartão novo = cartão vazio = bloco mudo.
 *
 * Aqui a pergunta muda de "o que diz este cartão?" para "o que diz este
 * TELEFONE?" — e aí não importa quantos cartões duplicados existam. Medido em
 * 15/09: 36.964 números da rede têm mais de um cadastro.
 *
 * Por que a busca é pelos ÚLTIMOS 8 DÍGITOS: é o que sobrevive às duas formas do
 * mesmo número (com e sem o nono dígito) e ao DDD escrito de jeitos diferentes.
 * Confirmado no Kommo: `?query=92135721` devolve os DOIS cartões do Wilson.
 *
 * ATENÇÃO — a franquia NÃO busca por telefone. `/api/clients/search` ignora em
 * silêncio os parâmetros `whatsapp`/`phone`/`telefone` e devolve a primeira
 * página inteira, sem filtrar. Quem confiar nisso casa o paciente errado.
 */

/** Últimos 8 dígitos: imune ao nono dígito e ao +55. */
export function chaveTelefone(bruto: string | null | undefined): string {
  const d = String(bruto ?? '').replace(/\D+/g, '');
  return d.length > 8 ? d.slice(-8) : d;
}

export interface CartaoIrmao {
  leadId: number;
  contatoId: number;
  nome: string | null;
  /** já é paciente/tem consulta, segundo a etapa ou o campo de data */
  ehPaciente: boolean;
  /** epoch em segundos, se o cartão tiver data de consulta */
  dataConsulta: number | null;
  etapa: string | null;
}

export interface Duplicidade {
  /** o cartão irmão que melhor explica quem é a pessoa */
  irmao: CartaoIrmao;
  /** quantos cartões o telefone tem além do atual */
  outros: number;
}

/**
 * Escolhe o irmão que vale mostrar ao modelo: entre os que dizem "é paciente",
 * o de consulta mais recente; se nenhum disser, não há o que informar — cartão
 * novo sem irmão relevante é conversa nova mesmo.
 */
export function escolherIrmao(
  irmaos: CartaoIrmao[],
  leadAtual: number | null | undefined,
): Duplicidade | null {
  const outros = irmaos.filter((i) => i.leadId !== leadAtual);
  if (outros.length === 0) return null;
  const pacientes = outros.filter((i) => i.ehPaciente);
  if (pacientes.length === 0) return null;
  const ordenado = [...pacientes].sort(
    (a, b) => (b.dataConsulta ?? 0) - (a.dataConsulta ?? 0),
  );
  return { irmao: ordenado[0], outros: outros.length };
}

/**
 * O texto que entra no prompt. Diz o que fazer, não só o que aconteceu: um
 * aviso que apenas informa faz o modelo seguir o caminho que ele já conhece —
 * foi assim que `buscar_paciente` acabou mandando agendar quem já tinha horário.
 */
export function avisoDeCartaoDuplicado(d: Duplicidade, timeZone: string): string {
  const { irmao, outros } = d;
  const quando = irmao.dataConsulta
    ? new Intl.DateTimeFormat('pt-BR', {
        timeZone,
        weekday: 'long',
        day: '2-digit',
        month: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      }).format(new Date(irmao.dataConsulta * 1000))
    : null;
  return [
    'ATENÇÃO: este telefone JÁ TEM outro cadastro nesta clínica' +
      (outros > 1 ? ` (${outros} no total)` : '') +
      '. Este cartão é novo porque o telefone foi gravado em dois formatos, não porque a pessoa é nova.',
    irmao.nome ? `Ela já está cadastrada como: ${irmao.nome}.` : '',
    irmao.etapa ? `Situação no outro cartão: ${irmao.etapa}.` : '',
    quando ? `Consulta registrada lá: ${quando}.` : '',
    '',
    'REGRAS (valem acima do histórico desta conversa):',
    '- NÃO trate como primeiro contato e NÃO ofereça "vamos agendar sua consulta" do zero.',
    '- Se ela está confirmando um horário, confirme — não abra agendamento novo.',
    '- Se quiser mudar, é REMARCAR.',
    '- Ao checar a agenda, o horário DELA aparece ocupado porque é dela; nunca diga que o horário dela já foi tomado.',
    '- Se o que ela disser não bater com o que está acima, NÃO discuta nem ofereça horário: passe para a equipe conferir.',
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * Remarcar consulta — o passo que a franquia não tem.
 *
 * O Guia de Integração da API Spine (v1.9.3) lista, para `/api/schedules`, quatro
 * ações: **search · insert · cancel (DELETE) · confirm**. Não existe endpoint de
 * remarcação. Mover um paciente de terça para quinta é, obrigatoriamente, duas
 * chamadas: cria a nova e apaga a velha.
 *
 * Duas chamadas querem dizer que existe um MEIO DO CAMINHO. Quando a segunda
 * falha, o paciente fica com duas consultas e a antiga continua ocupando uma vaga
 * que ninguém vai usar — a recepção vê "ocupado" num horário que está livre.
 * Aconteceu duas vezes em produção (Canaã 02/09/2026, idSchedule 3619159; Rio
 * Verde 16/09/2026, idSchedule 3662621) e nas duas a IA respondeu "remarcada"
 * como se estivesse tudo certo. O paciente saiu achando uma coisa, a agenda ficou
 * outra.
 *
 * Nem toda sobra é problema, e essa distinção é o coração deste arquivo: nos dois
 * casos reais a consulta antiga **já tinha passado** — a franquia recusa cancelar
 * horário no passado (`400: Agendamento não pode ser cancelado`). Vaga no passado
 * não bloqueia ninguém. Cancelar por cima a consulta NOVA só pra "ficar
 * consistente" tiraria do paciente o horário que ele acabou de pedir.
 *
 * Então: se a antiga já passou, a remarcação valeu e a IA fala normalmente. Se a
 * antiga é futura, existe uma vaga presa de verdade — e aí a IA não pode dizer
 * que cancelou, porque não cancelou.
 */

/**
 * O primeiro passo deu certo?
 *
 * `agendar_consulta` responde em prosa, para a IA ler. A versão anterior disto
 * perguntava `/marcada/i` — que casa com "A consulta **NÃO** foi marcada.", a
 * frase exata que a ferramenta devolve quando a recepção pausou a unidade ou o
 * horário foi tomado no meio da conversa. Recusa lida como sucesso, e o passo 2
 * ia em frente e CANCELAVA a consulta que o paciente tinha: ele pedia para mudar
 * de dia e ficava sem consulta nenhuma — o desfecho que a ordem cria-depois-cancela
 * existe justamente para impedir.
 *
 * Âncora positiva no começo da frase de sucesso, mais a negativa explícita.
 */
export function agendamentoDeuCerto(resposta: string): boolean {
  if (/N[ÃA]O foi marcada/i.test(resposta)) return false;
  return /^Consulta marcada para /i.test(resposta.trim());
}

/** O que sobrou depois do segundo passo. */
export type Desfecho =
  /** Criou a nova e cancelou a antiga. O caminho feliz. */
  | { tipo: 'trocada' }
  /** Não cancelou, mas a antiga já tinha passado — não prende vaga nenhuma. */
  | { tipo: 'sobra_no_passado'; idSchedule: number }
  /** Não cancelou e a antiga é futura: tem vaga presa na agenda da clínica. */
  | { tipo: 'vaga_presa'; idSchedule: number; quando: string | null };

/**
 * Compara dois instantes em hora LOCAL da clínica, como texto.
 *
 * Os dois lados nascem no mesmo fuso (`agendadoPara` é gravado local, e
 * `instanteNoFuso` devolve local), então comparar string resolve — `2026-09-20T14:30`
 * vem antes de `2026-09-20T15:00` em ordem alfabética. Cortar em 16 porque um lado
 * tem segundos e o outro não.
 */
function jaPassou(quando: string | null, agoraNaClinica: string): boolean {
  if (!quando) return false; // não sei quando era → trato como futura, que é o lado seguro
  return quando.slice(0, 16) < agoraNaClinica.slice(0, 16);
}

export function desfechoDaRemarcacao(a: {
  cancelou: boolean;
  idScheduleAntiga: number;
  /** Hora local da clínica, `AAAA-MM-DDTHH:mm`. */
  quandoAntiga: string | null;
  /** Hora local da clínica, agora. */
  agoraNaClinica: string;
}): Desfecho {
  if (a.cancelou) return { tipo: 'trocada' };
  if (jaPassou(a.quandoAntiga, a.agoraNaClinica)) {
    return { tipo: 'sobra_no_passado', idSchedule: a.idScheduleAntiga };
  }
  return { tipo: 'vaga_presa', idSchedule: a.idScheduleAntiga, quando: a.quandoAntiga };
}

/**
 * O recado para a IA.
 *
 * Em `vaga_presa` o texto é escrito para tirar dela a única frase que ela não pode
 * dizer — "cancelei a anterior" — sem assustar o paciente, que de fato tem a
 * consulta nova marcada. A parte chata dessa sobra é da clínica, não dele.
 */
export function recadoDaRemarcacao(a: {
  desfecho: Desfecho;
  /** Já por extenso. */
  antigaPorExtenso: string;
  /** Já por extenso. */
  novaPorExtenso: string;
  /** O que a ferramenta de agendar devolveu — a IA ainda precisa dessas instruções. */
  daNova: string;
}): string {
  switch (a.desfecho.tipo) {
    case 'trocada':
      return `Remarcada de ${a.antigaPorExtenso} para ${a.novaPorExtenso}. ${a.daNova}`;
    case 'sobra_no_passado':
      // A antiga já tinha passado: para o paciente, a remarcação aconteceu inteira.
      return `Remarcada para ${a.novaPorExtenso}. ${a.daNova}`;
    case 'vaga_presa':
      // `daNova` carrega a régua de pagamento (chave Pix, valor) e o dia da semana
      // que a IA precisa repetir. Descartar isso deixava quem escolheu Pix sem a
      // chave — o paciente pagaria o preço de um problema que é da clínica.
      return (
        `A CONSULTA NOVA ESTÁ MARCADA para ${a.novaPorExtenso} — pode confirmar isso ao paciente. ${a.daNova} ` +
        `MAS eu NÃO consegui cancelar a anterior, de ${a.antigaPorExtenso}. ` +
        'NÃO diga que a anterior foi cancelada nem que ela "não vale mais". ' +
        'Diga apenas que a nova ficou marcada e que a equipe da clínica cuida do resto.'
      );
  }
}

/**
 * A tarefa que a recepção vê no Kommo. Só existe para `vaga_presa`.
 *
 * O prefixo `ALERTA · slug ·` não é enfeite: é a chave que o roteador de alertas
 * procura para encaminhar a tarefa ao grupo das SDRs. Sem ele a tarefa nasce no
 * cartão e morre ali — que era o caso da primeira versão, enquanto a IA dizia ao
 * paciente que já tinha avisado a recepção.
 */
export function tarefaDaVagaPresa(a: {
  slug: string;
  antigaPorExtenso: string;
  novaPorExtenso: string;
  idSchedule: number;
  erro: string | null;
}): string {
  const linhas = [
    `ALERTA · ${a.slug} · ⚠️ VAGA PRESA NA AGENDA — cancelar na mão`,
    '',
    `Remarquei este paciente para ${a.novaPorExtenso}, mas não consegui cancelar a consulta anterior, de ${a.antigaPorExtenso} (idSchedule ${a.idSchedule}).`,
  ];
  if (a.erro) linhas.push(`Motivo: ${a.erro}`);
  linhas.push(
    '',
    `A vaga de ${a.antigaPorExtenso} segue ocupada na franquia e ninguém consegue marcar nela.`,
    'Cancelar esse agendamento no sistema da clínica resolve.',
  );
  return linhas.join('\n');
}

/**
 * Qual consulta remarcar, quando o vínculo local não sabe.
 *
 * `spineIdSchedule` só é gravado por `agendar_consulta` — ou seja, só quando foi a
 * IA que marcou. Quem foi marcado pela recepção não tem esse vínculo: são 54 leads
 * com ele na rede inteira, e ZERO em Mossoró. Sem vínculo, `consultaAtual` devolve
 * `null`, e a versão antiga desta ferramenta seguia em frente e criava a segunda
 * consulta — o paciente pedia para MUDAR de dia e terminava com dois horários.
 *
 * Por isso a busca na franquia, e por isso ela recusa no plural: com duas consultas
 * futuras eu não tenho como saber qual delas o paciente quer mudar, e chutar aqui
 * significa cancelar a consulta errada de alguém.
 */
export type SemAlvo =
  | { tipo: 'nenhuma' }
  | { tipo: 'varias'; quantas: number }
  /**
   * A franquia não respondeu. Precisa ser diferente de `nenhuma`: com as duas
   * colapsadas, um timeout da API virava "este paciente não tem consulta" e a IA
   * marcava uma SEGUNDA para quem já tinha uma — dizendo a ele que não tinha
   * nenhuma. Não saber não é a mesma coisa que não existir.
   */
  | { tipo: 'nao_sei' };

export function escolherAlvo<T extends { idSchedule: number | null }>(
  futuras: T[],
): { tipo: 'achei'; consulta: T } | SemAlvo {
  const comId = futuras.filter((c) => c.idSchedule);
  if (comId.length === 0) return { tipo: 'nenhuma' };
  if (comId.length > 1) return { tipo: 'varias', quantas: comId.length };
  return { tipo: 'achei', consulta: comId[0] };
}

const NAO_SEI_AINDA =
  'NÃO cite dia nem hora. Diga que vai confirmar o agendamento com a equipe e retornar em instantes.';

export function recadoSemAlvo(alvo: SemAlvo): string {
  switch (alvo.tipo) {
    case 'nenhuma':
      return (
        'Este paciente NÃO tem consulta marcada — não há o que remarcar. ' +
        'Não invente que existia uma. Trate como agendamento novo: ofereça os horários ' +
        'disponíveis e use agendar_consulta.'
      );
    case 'varias':
      // Chutar aqui é cancelar a consulta errada de alguém.
      return (
        `NÃO REMARQUEI: este paciente tem ${alvo.quantas} consultas marcadas e eu não sei qual delas ele quer mudar. ` +
        `NÃO chute. ${NAO_SEI_AINDA}`
      );
    case 'nao_sei':
      return `NÃO REMARQUEI: não consegui consultar a agenda da clínica agora. ${NAO_SEI_AINDA}`;
  }
}

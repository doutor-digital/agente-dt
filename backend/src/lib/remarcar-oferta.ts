/**
 * Quem não vai conseguir ir recebe 2 horários novos na hora (decisão do João, 27/11/2026).
 *
 * Medido em produção em 27/11: das consultas marcadas pela Sofia nos 30 dias anteriores e já resolvidas (sem Caxias e Petrópolis), 27 foram
 * DESMARCADAS e só 6 faltaram. Quem desmarca hoje ouve "vou pedir para a equipe combinar um novo horário" (tarefa) ou o cancelamento é
 * confirmado e a conversa acaba: o paciente que queria só trocar o dia some.
 *
 * Três caminhos, uma chave (`remarcar-oferta`, nasce desligada):
 *  1. A Sofia, em conversa livre: ganha no prompt a regra de oferecer 2 horários de `consultar_horarios` ANTES de cancelar (bloco abaixo).
 *     Os horários vêm da ferramenta, que confere com a franquia: nada é inventado em código.
 *  2. O toque em «Preciso remarcar» (ou «2») da pergunta de véspera/reforço/manhã: em vez da resposta pronta + tarefa, a conversa segue
 *     com a Sofia (`confirmacao-d1.ts`, resultado `remarcar_sofia`). A tarefa para a equipe continua (prazo de 1 h): é a rede de segurança
 *     se a Sofia estiver calada ou o paciente não escolher.
 *  3. «Só no papel»: o caminho 2 anota na tela o que faria e segue como hoje; o prompt (caminho 1) NÃO muda.
 * Só remarca se ele escolher. «Não quero mais» é respeitado.
 *
 * Fora Caxias e Petrópolis, sempre (`UNIDADES_FORA`, mesmo com `*`).
 */
import type { Estado } from './automacoes-estado.js';
import { estadoDoPlano } from './confirmacao-manha.js';

export const ID_REMARCAR_OFERTA = 'remarcar-oferta';

export function oferecerNovoHorario(slug: string, env: NodeJS.ProcessEnv = process.env): Estado {
  return estadoDoPlano(slug, ID_REMARCAR_OFERTA, env.REMARCAR_OFERTA_SLUGS);
}

/** O bloco do prompt da Sofia. Só entra com a chave LIGADA. */
export function blocoOfertaDeRemarcar(): string {
  return `
QUANDO O PACIENTE NÃO VAI CONSEGUIR IR (vale ACIMA da regra de cancelamento acima):
- Vale quando ele JÁ TEM consulta e diz que não vai conseguir, que teve um imprevisto, que precisa desmarcar, cancelar ou remarcar,
  ou responde "2" / "Preciso remarcar" a um lembrete de confirmação.
- Na MESMA resposta, sem pedir antes que ele confirme o cancelamento: chame consultar_horarios (a partir de amanhã se ele disse que hoje
  não dá; a partir do dia que ele pedir; senão a partir de hoje) e ofereça EXATAMENTE 2 horários da lista devolvida, os mais próximos que
  cabem, com a linha [[botoes: …]]. NUNCA outro horário: nem de memória, nem do histórico, nem de consulta feita em outro momento.
- NÃO chame cancelar_consulta nem remarcar_consulta nessa resposta: a consulta dele continua de pé até ele ESCOLHER.
- Só chame remarcar_consulta depois que ele escolher um dos 2 (ou outro horário que consultar_horarios confirmou). Se ele não escolher
  nenhum, pergunte UMA vez que dia e período ficam melhores e consulte de novo; não insista além disso.
- EXCEÇÃO que você respeita: se ele diz claramente que NÃO QUER MAIS ("não quero mais", "desisti", "não tenho mais interesse", "já resolvi",
  "vou fazer em outro lugar"), NÃO ofereça horário e NÃO tente convencer: agradeça e siga o fluxo de cancelamento da unidade.
- Nunca diga que a consulta está remarcada ou cancelada antes de a ferramenta confirmar.`;
}

/** Tarefa da equipe quando a conversa passou à Sofia: ela oferece os horários; a equipe só entra se o paciente não escolher. */
export function textoTarefaRemarcarComOferta(args: { slug: string; nome: string | null | undefined; quando: string | null; texto: string }): string {
  const dia = args.quando ? ` de ${args.quando.slice(8, 10)}/${args.quando.slice(5, 7)} às ${args.quando.slice(11, 16)}` : '';
  return (
    `ALERTA · ${args.slug} · [Contato: ${args.nome ?? 'paciente'}] 🔁 Pediu para remarcar a consulta${dia}: "${args.texto.slice(0, 120)}". ` +
    'A Sofia deve ter oferecido 2 horários na conversa (confira). A consulta continua marcada até ele escolher: se ele não escolheu, ligue.'
  );
}

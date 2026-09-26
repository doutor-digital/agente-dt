/**
 * Quando criar o lead no CRM da franquia — e por que quase nunca.
 *
 * Até 26/09/2026 o cadastro rodava ao fim de TODA mensagem processada, sem condição
 * nenhuma além da chave da unidade estar ligada. Medido nesse dia: **4.270 leads criados
 * na franquia em 30 dias, dos quais 75 agendaram e 484 viraram paciente.** Os outros 96%
 * eram clique de anúncio que mandou uma mensagem e sumiu.
 *
 * Isso tinha três custos: sujava a base da franqueadora com gente que nunca foi paciente,
 * enchia a fila de `CONFERIR NA FRANQUIA` (que existe justamente pra cartão cujo paciente
 * a franquia não reconhece — e ela não reconhecia porque a pessoa não era paciente de
 * nada), e gastava 96% das chamadas à API deles à toa.
 *
 * REGRA DO JOÃO (26/09/2026): **a pessoa só vira lead na franquia se agendar consulta.**
 * Vale para todas as unidades. Não se cadastra lead aleatório que chega no Kommo.
 */

/** As ferramentas cuja chamada significa que houve — ou está havendo — agendamento. */
const FERRAMENTAS_DE_AGENDA = new Set([
  'agendar_consulta',
  'remarcar_consulta',
  'confirmar_presenca',
  'cadastrar_paciente',
]);

/**
 * `consultar_horarios` NÃO entra: perguntar horário é intenção, não agendamento. Metade
 * de quem consulta não fecha, e cadastrar na consulta traria de volta boa parte do lixo
 * que esta regra veio remover.
 */

interface ChamadaDeFerramenta {
  name?: string;
}

interface MensagemDoAgente {
  tool_calls?: ChamadaDeFerramenta[];
  additional_kwargs?: { tool_calls?: Array<{ function?: { name?: string } }> };
}

/** Os nomes de ferramenta chamados nesta execução, venham no formato que vierem. */
export function ferramentasChamadas(mensagens: unknown): string[] {
  if (!Array.isArray(mensagens)) return [];
  const out: string[] = [];
  for (const m of mensagens as MensagemDoAgente[]) {
    for (const t of m?.tool_calls ?? []) if (t?.name) out.push(t.name);
    for (const t of m?.additional_kwargs?.tool_calls ?? []) {
      const n = t?.function?.name;
      if (n) out.push(n);
    }
  }
  return out;
}

export interface SinaisDeCadastro {
  /** Ferramentas que a IA chamou nesta execução. */
  ferramentas: string[];
  /** Nome da etapa do cartão no Kommo, se conhecido. */
  etapaDoCartao?: string | null;
  /** Já existe consulta ligada a este cartão na franquia. */
  jaTemConsulta?: boolean;
}

export interface DecisaoDeCadastro {
  criar: boolean;
  motivo: string;
}

/** Etapas a partir das quais a pessoa já é, de fato, gente com consulta. */
const ETAPAS_COM_CONSULTA = ['agendado', 'nao compareceu', 'compareceu', 'em negociacao', 'em tratamento', 'alta'];

const semAcento = (s: string) =>
  s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

export function deveCriarNaFranquia(s: SinaisDeCadastro): DecisaoDeCadastro {
  if (s.jaTemConsulta) return { criar: true, motivo: 'já tem consulta na franquia' };

  const agenda = (s.ferramentas ?? []).find((f) => FERRAMENTAS_DE_AGENDA.has(f));
  if (agenda) return { criar: true, motivo: `a IA chamou ${agenda}` };

  const etapa = semAcento(String(s.etapaDoCartao ?? ''));
  if (etapa && ETAPAS_COM_CONSULTA.some((e) => etapa.includes(e))) {
    return { criar: true, motivo: `cartão em ${s.etapaDoCartao}` };
  }

  return { criar: false, motivo: 'sem agendamento — não entra na base da franquia' };
}

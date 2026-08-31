/**
 * Põe os fatos do lead sempre na mesma gaveta.
 *
 * O schema dos fatos é livre (`[key: string]`), e quem escolhe o nome da chave é
 * o modelo, a cada conversa. O resultado em produção são quatro nomes para a
 * mesma informação — `queixa`, `queixa_principal`, `dor`, `localizacao_dor` —
 * e dois para "marcou consulta" (`agendou`, `consulta_marcada`).
 *
 * Isso não é só feio: fragmenta a memória. O que a IA grava como `dor` numa
 * conversa ela procura como `queixa` na seguinte e não acha, então volta a
 * perguntar o que o paciente já respondeu. E qualquer coisa que leia os fatos —
 * o bloco "o que falta para agendar", um relatório, uma auditoria — precisa
 * adivinhar todos os apelidos possíveis.
 *
 * A normalização acontece na ESCRITA. Ler tudo e aceitar sinônimo depois seria
 * remendo eterno: bastaria o modelo inventar um nome novo pra memória furar de
 * novo.
 */

/** apelido -> nome canônico. Só entra aqui o que já apareceu em produção. */
const APELIDOS: Record<string, string> = {
  queixa_principal: 'queixa',
  dor: 'queixa',
  localizacao_dor: 'queixa',
  tempo_de_dor: 'tempo_dor',
  consulta_marcada: 'agendou',
  consulta_agendada: 'agendou',
  horario_preferido: 'preferencia_horario',
  horario_escolhido: 'preferencia_horario',
  localizacao: 'cidade',
  qualificado: 'qualificacao',
  interesse_tratamento: 'interesse',
};

function normalizarNome(chave: string): string {
  const limpa = chave.trim().toLowerCase().replace(/\s+/g, '_');
  return APELIDOS[limpa] ?? limpa;
}

const vazio = (v: unknown): boolean =>
  v === null || v === undefined || String(v).trim() === '';

/**
 * Junta os apelidos no nome canônico.
 *
 * Quando dois apelidos trazem valor para a mesma gaveta, o primeiro a chegar
 * fica. É de propósito: `queixa` (o nome canônico) costuma vir da tool que grava
 * com intenção, enquanto `dor` costuma vir do resumo automático — e o que foi
 * registrado de propósito vale mais do que o que foi inferido.
 */
export function canonizarFatos(
  fatos: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!fatos) return out;

  // canônicos primeiro, pra que apelido nunca sobrescreva o nome de verdade
  const entradas = Object.entries(fatos).sort(([a], [b]) => {
    const aApelido = a.toLowerCase() in APELIDOS ? 1 : 0;
    const bApelido = b.toLowerCase() in APELIDOS ? 1 : 0;
    return aApelido - bApelido;
  });

  for (const [chave, valor] of entradas) {
    if (!chave.trim() || vazio(valor)) continue;
    const nome = normalizarNome(chave);
    if (vazio(out[nome])) out[nome] = valor;
  }
  return out;
}

/**
 * Como ESTA unidade funciona, lido do sistema na hora (não de documento antigo): se a Sofia está entregando, em quais etapas ela
 * atende, se a franquia move o cartão sozinha e se o sincronizador copia os dados para o cartão. É o que impede o Copiloto de
 * ensinar o processo velho ("mova o cartão", "salve o nome no título") onde hoje quem faz isso é a automação ou a IA.
 */
import type { KommoPipeline } from '../../services/kommo.service.js';
import type { Estado } from '../automacoes-estado.js';
import { ACEITE_O_QUE_A_PESSOA_CONTAR, DIVISAO_COM_A_IA } from './divisao-com-a-ia.js';

export interface PerfilDaUnidade {
  temSofia: boolean;
  /** Nomes das etapas em que a Sofia responde (a lista de etapas permitidas da unidade). */
  etapasDaSofia: string[];
  /** A franquia move a etapa sozinha (automação `franquia-move` LIGADA; em "só no papel" ainda não move). */
  moveAutomatico: boolean;
  /** O sincronizador copia da franquia para o cartão a cada 15 minutos (`franquia-sync` LIGADA). */
  sincronizaFranquia: boolean;
}

export interface UnidadeParaOPerfil {
  kommoSalesbotExecuteEnabled: boolean;
  kommoAllowedStatusIds: number[];
}

export function perfilDaUnidade(unit: UnidadeParaOPerfil, funis: KommoPipeline[], estado: (idDaAutomacao: string) => Estado): PerfilDaUnidade {
  const temSofia = !!unit.kommoSalesbotExecuteEnabled;
  const permitidas = new Set(unit.kommoAllowedStatusIds ?? []);
  const nomes: string[] = [];
  if (temSofia) {
    for (const f of funis) for (const s of f.statuses) if (permitidas.has(s.id) && !nomes.includes(s.name)) nomes.push(s.name);
  }
  return { temSofia, etapasDaSofia: nomes, moveAutomatico: estado('franquia-move') === 'ligado', sincronizaFranquia: estado('franquia-sync') === 'ligado' };
}

/** O texto que entra nas instruções (voz e texto). Sem perfil, cai na regra geral. */
export function regrasDaUnidade(p: PerfilDaUnidade | null): string {
  if (!p) return DIVISAO_COM_A_IA;
  const linhas = ['COMO ESTA UNIDADE FUNCIONA (dados reais do sistema; valem mais que qualquer regra geral ou aula antiga):'];
  linhas.push(
    p.temSofia
      ? `- Esta unidade TEM a Sofia, a IA de atendimento.${p.etapasDaSofia.length ? ` Ela atende nas etapas: ${p.etapasDaSofia.join(', ')}.` : ''} Nessas etapas é ELA quem lê a mensagem que chegou, registra o nome e o que descobre (queixa, intenção, qualificação, sexo, cidade), agenda, confirma e remarca consulta e move o cartão de etapa. A atendente quase não preenche: ela OLHA e CONFERE o que a Sofia fez, corrige o que estiver errado e completa o que faltar. Diga "confira", não "preencha". A atendente assume quando a IA está pausada, não respondeu ou a etapa não é da Sofia.`
      : '- Esta unidade NÃO tem a Sofia: a atendente atende, registra e preenche tudo à mão.',
  );
  linhas.push(
    p.moveAutomatico
      ? '- O CARTÃO ANDA SOZINHO: a franquia move a etapa (marcou vira AGENDADO, foi atendido vira COMPARECEU, começou as sessões vai para EM TRATAMENTO). A atendente NÃO arrasta cartão na mão e não deve ensinar isso. O que vale é o que se registra na franquia; atendido, valor e alta são registrados na tela da franquia e dali o cartão anda.'
      : '- A movimentação automática pela franquia está DESLIGADA nesta unidade: a atendente move o cartão na mão, depois de registrar na franquia (o que vale é a franquia).',
  );
  linhas.push(
    p.sincronizaFranquia
      ? '- A cada 15 minutos o sistema copia da franquia para o cartão: data da consulta, situação, fisioterapeuta, sessões, faltas, tratamento e dados da pessoa. A atendente não digita esses campos: só confere.'
      : '- O sincronizador da franquia está desligado nesta unidade: esses dados não chegam sozinhos ao cartão.',
  );
  linhas.push(ACEITE_O_QUE_A_PESSOA_CONTAR);
  return linhas.join('\n');
}

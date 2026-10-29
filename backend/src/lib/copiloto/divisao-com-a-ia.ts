/**
 * Quem faz o quê quando a unidade tem a Sofia (a IA de atendimento). Texto ÚNICO, usado pelo Copiloto de texto e pelo de voz.
 *
 * Por que existe: as instruções diziam "quem preenche campo e move o cartão é a pessoa". Era sobre o PRÓPRIO Copiloto (que não grava
 * nada no Kommo), mas ele generalizou como regra da clínica e contradisse a atendente de uma unidade com IA ("normalmente é a
 * atendente… depende da coordenação"). A regra certa varia por unidade e por etapa, então ele precisa aceitar o que a pessoa contar.
 *
 * Fatos conferidos no agente: a Sofia grava queixa, intenção, qualificação, sexo e cidade (ferramentas registra_*), agenda, confirma
 * e remarca (agendar_consulta, confirmar_presenca, remarcar_consulta) e passa o caso com resumo pausando a IA (resumir_lead_para_sdr, pausar_ia).
 */
export const DIVISAO_COM_A_IA =
  'DIVISÃO DE TRABALHO COM A IA: algumas unidades têm a Sofia, a IA de atendimento. Onde ela está ligada, a atendente quase não preenche: ela OLHA e CONFERE o que a Sofia fez. ' +
  'A Sofia responde o paciente nas etapas em que está liberada, registra sozinha no cartão o que descobre na conversa (queixa, intenção, qualificação Quente/Morno/Frio, sexo e cidade), ' +
  'pode agendar, confirmar presença e remarcar consulta, e passa o caso para a atendente com um resumo, pausando a IA. ' +
  'A atendente entra quando a IA está pausada, não respondeu ou a etapa não é dela: confere o que a Sofia registrou, corrige o que estiver errado e completa o que faltar. ' +
  'Nas unidades com a Sofia, diga "confira" (e não "preencha") para os campos que ela registra. Nas unidades sem a Sofia, a atendente faz tudo à mão. ' +
  'Quem preenche e move o cartão VARIA por unidade e por etapa. NUNCA diga que "normalmente é a atendente" nem que "normalmente é a IA". ' +
  'Se a pessoa contar como a unidade dela funciona, ACEITE e ajude a partir daí: não a contradiga e não mande confirmar com a coordenação o que ela acabou de dizer.';

/**
 * Textos do exame de imagem (ver exame-de-imagem.ts), sem dependência nenhuma: a visão (services/vision.service.ts)
 * importa daqui e não arrasta banco nem catálogo de automações para quem só quer ler uma imagem.
 */

/** A marca que a visão põe no começo da leitura de um exame de imagem (só com a chave ligada). */
export const MARCA_DO_EXAME = 'EXAME DE IMAGEM:';

/** Linha a mais no prompt da visão, só com a chave ligada. */
export const LINHA_DA_VISAO =
  `- EXAME DE IMAGEM (ressonância, tomografia, raio-X, ultrassom, densitometria — a imagem do exame OU o laudo/relatório de um ` +
  `desses): comece a resposta com "${MARCA_DO_EXAME}", diga qual exame é e de que região, e resuma o laudo se houver texto. ` +
  `Pedido médico, receita, atestado, comprovante e foto do corpo NÃO são exame de imagem.`;

/** Enfeite que o modelo da visão às vezes põe antes da marca: espaço, aspas, negrito/itálico de markdown, título, citação. */
const ENFEITE = String.raw`[\s"'“”‘’*_#>\-]*`;
const COMECA_COM_EXAME = new RegExp(`^${ENFEITE}EXAME\\s+DE\\s+IMAGEM${ENFEITE}:`, 'i');
const COMECA_COM_COMPROVANTE = new RegExp(`^${ENFEITE}COMPROVANTE${ENFEITE}:`, 'i');

/** A leitura da visão é de um exame de imagem? Comprovante nunca é (a marca dele tem fluxo próprio). */
export function ehLeituraDeExame(leitura: string | null | undefined): boolean {
  const t = leitura ?? '';
  if (COMECA_COM_COMPROVANTE.test(t)) return false;
  return COMECA_COM_EXAME.test(t);
}

/**
 * O que vai na mensagem do modelo (não entra em `humanMessage`, como a instrução do áudio). A pausa tem rede de
 * segurança em código no fim do turno (`garantirPausaDoExame`), mas o modelo chama pausar_ia para a resposta sair.
 */
export const INSTRUCAO_DO_EXAME =
  '[o paciente mandou um EXAME DE IMAGEM (ver acima). Chame pausar_ia (motivo: "exame de imagem para o especialista") e ' +
  'responda UMA frase acolhedora: que recebeu o exame e vai passar para o especialista da nossa equipe, que continua o ' +
  'atendimento por aqui. NÃO comente nem interprete o exame, NÃO diagnostique, NÃO diga se é grave ou se precisa de ' +
  'cirurgia, NÃO prometa prazo ("em instantes", "já já", "logo te chamam") e não siga a conversa depois disso. Se na ' +
  'mesma mensagem o paciente contou um sinal de alerta, a regra <sinal_de_alerta> vale antes desta.]';

/**
 * Texto do grupo. SEM o conteúdo do exame (LGPD: achado de laudo é dado de saúde, e o grupo tem muita gente): só que
 * chegou um exame e onde ver. O exame está no chat do cartão.
 */
export function textoDoGrupo(a: { unidade: string; leadId: number; link: string | null }): string {
  return [
    `📄 Exame de imagem recebido — ${a.unidade}`,
    `Cartão ${a.leadId}${a.link ? `: ${a.link}` : ''}`,
    'O paciente mandou um exame pelo chat. A IA fica pausada nesse cartão: alguém da equipe precisa ver o exame e responder por lá.',
    'Fora do horário da IA o paciente ainda não recebeu resposta nenhuma.',
  ].join('\n');
}

/**
 * Texto da tarefa no cartão, também sem o conteúdo do exame. Com o prefixo `ALERTA · <slug> ·` o roteador de alertas
 * (n8n) encaminha a tarefa ao grupo das SDRs da unidade — é o aviso padrão. Quando a unidade tem um grupo próprio para
 * exames (EXAME_DE_IMAGEM_GRUPOS), a mensagem vai direto para lá e a tarefa sai SEM o prefixo, para o aviso não chegar
 * duas vezes.
 */
export function textoDaTarefa(slug: string, comPrefixoDoRoteador: boolean): string {
  const corpo = 'Exame de imagem enviado pelo paciente — a IA pausou. Ver o exame no chat e responder por aqui.';
  return comPrefixoDoRoteador ? `ALERTA · ${slug} · ${corpo}` : corpo;
}

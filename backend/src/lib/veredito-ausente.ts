/**
 * O veredito que o juiz grava quando a resposta dele veio quebrada (JSON inválido ou sem o campo `verdict`): nesse
 * caso as cinco notas viram 0 (`parseJudgeOutput`, em `services/conversation-judge.service.ts`). Essa avaliação NÃO é
 * uma nota 0 de verdade — o resumo de qualidade a tira da média e do ranking e a conta à parte.
 *
 * Fica num arquivo próprio, sem dependências, para o juiz (que grava) e o resumo (que lê) usarem a MESMA constante.
 */
export const VEREDITO_AUSENTE = '(sem veredito)';

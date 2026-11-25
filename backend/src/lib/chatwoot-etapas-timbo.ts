/**
 * As etapas de TIMBÓ (conta 3 do CRM) como a Kommo de Timbó tem — pipelines COMERCIAL e TRATAMENTO lidas pela API v4 em 25/11/2026, na ordem real.
 * É o que vai em `unit_chatwoot.etapas` da unidade `doutor-hernia-timbo`. Decisões do João: ordem e lugar da Kommo (CONFERIR NA FRANQUIA antes de
 * AGENDADO, RETORNO PÓS-TRATAMENTO no Comercial entre EM NEGOCIAÇÃO e GANHO), grafia igual à Kommo; só a entrada do TRATAMENTO se chama «Leads de entrada».
 * «Confirmado» é alias de AGENDADO (a diferença é `situacao_consulta`); «Esperando humano», «Frio» e «Resgate» não têm etapa na Kommo (ver `SUBSTITUTO_DO_PAPEL`).
 */
export const ETAPAS_DE_TIMBO_NA_COLUNA = {
  comercial: [
    { papel: 'Novo lead', nome: 'Leads de entrada' },
    { papel: 'Sofia qualifica', nome: 'EM QUALIFICAÇÃO' },
    { papel: 'Em espera', nome: 'EM ESPERA' },
    { papel: 'Conferir na franquia', nome: 'CONFERIR NA FRANQUIA' },
    { papel: 'Agendado', nome: 'AGENDADO' },
    { papel: 'Confirmado', nome: 'AGENDADO' },
    { papel: 'Faltou', nome: 'NÃO COMPARECEU' },
    { papel: 'Compareceu', nome: 'COMPARECEU' },
    { papel: 'Pós-consulta', nome: 'EM NEGOCIAÇÃO' },
    { papel: 'Retorno pós-tratamento', nome: 'RETORNO PÓS-TRATAMENTO' },
    { papel: 'Fechou', nome: 'GANHO / CONCLUÍDO' },
    { papel: 'Perdido', nome: 'PERDIDO' },
  ],
  tratamento: [
    { papel: 'Entrada', nome: 'Leads de entrada' },
    { papel: 'Em tratamento', nome: 'EM TRATAMENTO' },
    { papel: 'Alta', nome: 'ALTA' },
    { papel: 'Tratamento cancelado', nome: 'TRATAMENTO CANCELADO' },
  ],
};

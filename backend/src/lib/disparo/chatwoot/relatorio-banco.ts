/**
 * Os números do relatório lidos NO BANCO, agrupados por onda (uma consulta, nenhuma linha de destinatário vem para a memória): é o mesmo
 * cálculo de `numerosDoRelatorio` (relatorio.ts, que é a definição e tem os testes), escrito em SQL com `FILTER`.
 * O teste confere os dois lado a lado nas mesmas linhas; e o SQL foi rodado contra o Postgres de produção (só leitura, com `VALUES`).
 */
import { Prisma } from '@prisma/client';
import { prisma } from '../../prisma.js';
import { JANELA_DA_RESPOSTA_MS, type NumerosDoRelatorio } from './relatorio.js';

/** «A mensagem foi aceita pelo CRM»: o wamid é `cw:<id>` (o mesmo `idDaMensagem` de mensagens.ts). */
const ACEITA = "(wamid ~ '^cw:[0-9]{1,12}$')";
const HORAS = JANELA_DA_RESPOSTA_MS / 3_600_000;

/** A lista de colunas agregadas (texto fixo, sem dado de ninguém dentro). */
export const SQL_DOS_NUMEROS = `
  COUNT(*)::int AS selecionadas,
  COUNT(*) FILTER (WHERE ${ACEITA})::int AS enviadas,
  (COUNT(*) FILTER (WHERE ${ACEITA}) + COUNT(*) FILTER (WHERE estado = 'falhou' AND enviado_em IS NULL AND NOT COALESCE(${ACEITA}, false)))::int AS tentadas,
  COUNT(*) FILTER (WHERE ${ACEITA} AND (entregue_em IS NOT NULL OR lida_em IS NOT NULL))::int AS entregues,
  COUNT(*) FILTER (WHERE ${ACEITA} AND lida_em IS NOT NULL)::int AS lidas,
  COUNT(*) FILTER (WHERE ${ACEITA} AND NOT (estado = 'saiu' AND enviado_em IS NOT NULL) AND respondeu_em IS NOT NULL AND enviado_em IS NOT NULL
                    AND respondeu_em >= enviado_em AND respondeu_em <= enviado_em + interval '${HORAS} hours')::int AS responderam,
  COUNT(*) FILTER (WHERE estado = 'saiu' AND enviado_em IS NOT NULL AND ${ACEITA})::int AS pediram_sair,
  COUNT(*) FILTER (WHERE estado = 'falhou' AND NOT (NOT COALESCE(${ACEITA}, false) AND enviado_em IS NOT NULL))::int AS falharam,
  COUNT(*) FILTER (WHERE estado IN ('falhou', 'saiu') AND NOT COALESCE(${ACEITA}, false) AND enviado_em IS NOT NULL)::int AS incertas,
  COUNT(*) FILTER (WHERE estado IN ('pendente', 'enviando'))::int AS na_fila,
  COUNT(*) FILTER (WHERE estado = 'descartado' OR (estado = 'saiu' AND enviado_em IS NULL))::int AS descartadas,
  COUNT(*) FILTER (WHERE simulado_em IS NOT NULL)::int AS receberiam`;

export interface LinhaAgregada {
  onda_id: string;
  selecionadas: number;
  enviadas: number;
  tentadas: number;
  entregues: number;
  lidas: number;
  responderam: number;
  pediram_sair: number;
  falharam: number;
  incertas: number;
  na_fila: number;
  descartadas: number;
  receberiam: number;
}

export const numerosDaLinha = (l: LinhaAgregada): NumerosDoRelatorio => ({
  selecionadas: Number(l.selecionadas), enviadas: Number(l.enviadas), tentadas: Number(l.tentadas), entregues: Number(l.entregues), lidas: Number(l.lidas),
  responderam: Number(l.responderam), pediramSair: Number(l.pediram_sair), falharam: Number(l.falharam), incertas: Number(l.incertas), naFila: Number(l.na_fila),
  descartadas: Number(l.descartadas), receberiam: Number(l.receberiam),
});

export const NUMEROS_VAZIOS: NumerosDoRelatorio = { selecionadas: 0, enviadas: 0, tentadas: 0, entregues: 0, lidas: 0, responderam: 0, pediramSair: 0, falharam: 0, incertas: 0, naFila: 0, descartadas: 0, receberiam: 0 };

/** Os números de cada onda (as que não têm destinatário vêm zeradas). Uma consulta só. */
export async function lerNumerosDosDisparos(ondaIds: readonly string[]): Promise<Map<string, NumerosDoRelatorio>> {
  const m = new Map<string, NumerosDoRelatorio>(ondaIds.map((id) => [id, NUMEROS_VAZIOS]));
  if (!ondaIds.length) return m;
  const linhas = await prisma.$queryRaw<LinhaAgregada[]>(
    Prisma.sql`SELECT onda_id, ${Prisma.raw(SQL_DOS_NUMEROS)} FROM disparo_destinatarios WHERE onda_id IN (${Prisma.join([...ondaIds])}) GROUP BY onda_id`,
  );
  for (const l of linhas) m.set(l.onda_id, numerosDaLinha(l));
  return m;
}

/** Envios por hora cheia (que o CRM aceitou), no fuso da unidade: `AAAA-MM-DD HH`. */
export async function lerEnviosPorHora(ondaId: string, fuso: string): Promise<Array<{ hora: string; enviadas: number }>> {
  const linhas = await prisma.$queryRaw<Array<{ hora: string; enviadas: number }>>(
    Prisma.sql`SELECT to_char((enviado_em AT TIME ZONE 'UTC') AT TIME ZONE ${fuso}, 'YYYY-MM-DD HH24') AS hora, COUNT(*)::int AS enviadas
      FROM disparo_destinatarios WHERE onda_id = ${ondaId} AND enviado_em IS NOT NULL AND ${Prisma.raw(ACEITA)}
      GROUP BY 1 ORDER BY 1`,
  );
  return linhas.map((l) => ({ hora: l.hora, enviadas: Number(l.enviadas) }));
}

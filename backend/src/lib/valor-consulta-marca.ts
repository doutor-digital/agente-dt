/**
 * A marca de "foi o robô quem gravou": o que o `valor-consulta` pôs em "¤ Valor da Consulta" de cada cartão.
 *
 * Por que uma tabela (e não o autor do evento no Kommo, nem o log): `created_by = 0` no Kommo é "qualquer integração" (a Sofia, os
 * outros robôs), não distingue quem gravou ESTE valor; o log gira e não se consulta no meio de uma varredura. A tabela guarda o
 * número exato: se o cartão ainda tem esse número, foi o robô e ninguém mexeu depois (ou alguém digitou o mesmo número, que o
 * robô também pode corrigir sem prejuízo: o autor do campo, conferido no Kommo, tem de ser integração). Uma linha por cartão.
 */
import { prisma } from './prisma.js';

export interface MarcaDoValor {
  centavos: number;
  qual: 'antecipado' | 'no-dia';
}

/** O pedaço de banco que isto usa (o teste passa um de mentira). */
export interface MarcasDoValor {
  ler(unitId: string, leadId: number): Promise<MarcaDoValor | null>;
  guardar(unitId: string, leadId: number, m: MarcaDoValor, origem: 'sofia' | 'sincronizador'): Promise<void>;
}

export const marcasNoBanco: MarcasDoValor = {
  async ler(unitId, leadId) {
    const r = await prisma.valorConsultaGravado.findUnique({
      where: { unitId_kommoLeadId: { unitId, kommoLeadId: leadId } },
      select: { centavos: true, qual: true },
    });
    return r ? { centavos: r.centavos, qual: r.qual === 'antecipado' ? 'antecipado' : 'no-dia' } : null;
  },
  async guardar(unitId, leadId, m, origem) {
    await prisma.valorConsultaGravado.upsert({
      where: { unitId_kommoLeadId: { unitId, kommoLeadId: leadId } },
      create: { unitId, kommoLeadId: leadId, centavos: m.centavos, qual: m.qual, origem },
      update: { centavos: m.centavos, qual: m.qual, origem, gravadoEm: new Date() },
    });
  },
};

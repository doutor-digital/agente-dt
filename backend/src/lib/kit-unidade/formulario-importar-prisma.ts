/** `BancoFormularios` de verdade (tabelas `nova_clinica_convite`, `unit_chatwoot` e `units` do banco do agente). */
import { prisma } from '../prisma.js';
import type { BancoFormularios } from './formulario-importar.js';

export const bancoFormulariosPrisma: BancoFormularios = {
  async acharEnviados({ hash, ref }) {
    return prisma.novaClinicaConvite.findMany({
      where: { enviadoEm: { not: null }, OR: [...(hash ? [{ codigoHash: hash }] : []), { id: ref }, { slugSugerido: ref }] },
      orderBy: { enviadoEm: 'desc' },
      take: 5,
      select: { id: true, enviadoEm: true, importadoEm: true, slugSugerido: true, respostas: true },
    });
  },
  async colisoes({ slug, subdominio, sufixo, prefixo }) {
    // a unidade de MESMO slug é a própria clínica (rodar de novo é normal): só conta quem é de outro slug
    const outras = await prisma.unitChatwoot.findMany({
      where: { OR: [{ subdominio }, { envSufixo: sufixo }, { prefixoModelos: prefixo }], unit: { slug: { not: slug } } },
      select: { subdominio: true, envSufixo: true, prefixoModelos: true, unit: { select: { slug: true } } },
    });
    const m: string[] = [];
    for (const o of outras) {
      if (o.subdominio === subdominio) m.push(`o subdomínio «${subdominio}» já é da unidade ${o.unit.slug}`);
      if (o.envSufixo === sufixo) m.push(`o sufixo das chaves «${sufixo}» já é da unidade ${o.unit.slug}`);
      if (o.prefixoModelos === prefixo) m.push(`o prefixo dos modelos «${prefixo}» já é da unidade ${o.unit.slug}`);
    }
    return m;
  },
  async marcarImportado(id, agora) {
    await prisma.novaClinicaConvite.updateMany({ where: { id, importadoEm: null }, data: { importadoEm: agora } });
  },
};

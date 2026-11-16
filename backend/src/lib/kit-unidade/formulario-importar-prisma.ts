/** `BancoFormularios` de verdade (tabelas `nova_clinica_convite`, `unit_chatwoot` e `units` do banco do agente). */
import { prisma } from '../prisma.js';
import { colisoesDoSufixo, type BancoFormularios } from './formulario-importar.js';

export const bancoFormulariosPrisma: BancoFormularios = {
  async acharEnviados({ hash, ref }) {
    return prisma.novaClinicaConvite.findMany({
      // «Referência» = os últimos 6 caracteres do id (cuid, minúsculo): o que o dono vê na tela «Recebemos»
      where: { enviadoEm: { not: null }, OR: [...(hash ? [{ codigoHash: hash }] : []), { id: ref }, { slugSugerido: ref }, ...(/^[A-Za-z0-9]{6}$/.test(ref) ? [{ id: { endsWith: ref.toLowerCase() } }] : [])] },
      orderBy: { enviadoEm: 'desc' },
      take: 5,
      select: { id: true, enviadoEm: true, importadoEm: true, slugSugerido: true, respostas: true },
    });
  },
  async colisoes({ slug, nome, subdominio, sufixo, prefixo }) {
    const m: string[] = [];
    const slugs = (await prisma.unit.findMany({ select: { slug: true } })).map((u) => u.slug);
    // unidade de MESMO slug: se tem o MESMO nome é a própria clínica (rodar de novo depois de criada é normal); com outro nome é OUTRA clínica da mesma cidade — o kit a «reconheceria» e mexeria nela
    const mesma = await prisma.unit.findUnique({ where: { slug }, select: { name: true } });
    const norm = (t: string) => t.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    if (mesma && norm(mesma.name) !== norm(nome)) m.push(`já existe a unidade «${mesma.name}» com o slug ${slug} (o formulário é de «${nome}»): é OUTRA clínica; escolha outro slug com --set unidade.slug=…`);
    const outras = await prisma.unitChatwoot.findMany({
      where: { OR: [{ subdominio }, { envSufixo: sufixo }, { prefixoModelos: prefixo }], unit: { slug: { not: slug } } },
      select: { subdominio: true, envSufixo: true, prefixoModelos: true, unit: { select: { slug: true } } },
    });
    for (const o of outras) {
      if (o.subdominio === subdominio) m.push(`o subdomínio «${subdominio}» já é da unidade ${o.unit.slug}`);
      if (o.envSufixo === sufixo) m.push(`o sufixo das chaves «${sufixo}» já é da unidade ${o.unit.slug}`);
      if (o.prefixoModelos === prefixo) m.push(`o prefixo dos modelos «${prefixo}» já é da unidade ${o.unit.slug}`);
    }
    const doSufixo = colisoesDoSufixo({ slug, sufixo, slugsExistentes: slugs, unidadeExiste: !!mesma, env: process.env });
    return { bloqueios: [...m, ...doSufixo.bloqueios], avisos: doSufixo.avisos };
  },
  async marcarImportado(id, agora) {
    await prisma.novaClinicaConvite.updateMany({ where: { id, importadoEm: null }, data: { importadoEm: agora } });
  },
};

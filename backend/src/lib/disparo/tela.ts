/**
 * Tudo o que a tela de uma onda mostra, lido do banco. Serve à tela do console (HTML e JSON) e ao conector do Claude
 * (que devolve o resumo e o link, nunca o botão de liberar).
 */
import { prisma } from '../prisma.js';
import { estadoDaAutomacao } from '../automacoes-estado.js';
import { conferirModeloNaMeta, podeAprovar } from './modelo.js';
import { definicaoDaOnda } from './onda.js';
import { freiosDoAmbiente } from './freios.js';
import { quemPediuSair } from './saidas.js';
import { diasDaOferta } from './oferta.js';
import { AUTOMACAO_DISPARO, listaDeTesteDoAmbiente } from './porto.js';
import type { DadosDoPainel } from './painel.js';

export async function dadosDaTela(ondaId: string, email: string | null | undefined): Promise<DadosDoPainel | null> {
  const onda = await prisma.disparoOnda.findUnique({ where: { id: ondaId }, include: { unit: true, campanha: { select: { nome: true } } } });
  if (!onda) return null;
  const retomavel = onda.estado === 'pausada' && onda.pausaCausa === 'sair';
  const [porEstado, simulados, amostra, saidas] = await Promise.all([
    prisma.disparoDestinatario.groupBy({ by: ['estado'], where: { ondaId }, _count: true }),
    prisma.disparoDestinatario.count({ where: { ondaId, simuladoEm: { not: null } } }),
    prisma.disparoDestinatario.findMany({ where: { ondaId }, orderBy: [{ criadoEm: 'asc' }, { id: 'asc' }], take: 15, select: { nome: true, telefone: true } }),
    // Quem pediu SAIR interessa sempre que a campanha já tem algum: é o que o João lê antes de retomar (e vale como aviso nas outras ondas).
    onda.estado === 'montando' || onda.estado === 'cancelada' ? Promise.resolve([]) : quemPediuSair(onda.unit, onda.campanhaId),
  ]);
  // Só pergunta à Meta enquanto ainda dá para aprovar ou retomar: é a prova que destrava (ou trava) o botão.
  const conferenciaMeta = onda.estado === 'montada' || retomavel ? await conferirModeloNaMeta(onda.unit, definicaoDaOnda(onda)) : null;
  const teste = listaDeTesteDoAmbiente();
  return {
    onda: {
      ...definicaoDaOnda(onda),
      id: onda.id,
      estado: onda.estado,
      total: onda.total,
      etiqueta: onda.etiqueta,
      impressao: onda.impressao,
      aprovadaPor: onda.aprovadaPor,
      aprovadaEm: onda.aprovadaEm,
      pausaMotivo: onda.pausaMotivo,
      pausaCausa: onda.pausaCausa,
      retomadaPor: onda.retomadaPor,
      retomadaEm: onda.retomadaEm,
      sairAceitos: onda.sairAceitos,
    },
    campanhaNome: onda.campanha.nome,
    oferta: onda.oferta,
    ofertaDias: diasDaOferta(),
    unidade: { slug: onda.unit.slug, nome: onda.unit.name },
    modo: estadoDaAutomacao(onda.unit.slug, AUTOMACAO_DISPARO, process.env.DISPARO_CAMPANHA_SLUGS),
    freios: freiosDoAmbiente(),
    resumo: (onda.resumo ?? {}) as DadosDoPainel['resumo'],
    contagem: Object.fromEntries(porEstado.map((g) => [g.estado, g._count])),
    simulados,
    amostra,
    saidas,
    conferenciaMeta,
    podeAprovar: podeAprovar(email),
    listaDeTeste: teste ? [...teste] : null,
  };
}

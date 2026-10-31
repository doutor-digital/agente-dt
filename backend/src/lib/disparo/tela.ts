/**
 * Tudo o que a tela de uma onda mostra, lido do banco. Serve à tela do console (HTML e JSON) e ao conector do Claude
 * (que devolve o resumo e o link, nunca o botão de liberar).
 */
import { prisma } from '../prisma.js';
import { conferirModeloNaMeta, podeAprovar } from './modelo.js';
import { definicaoDaOnda } from './onda.js';
import { freiosDoAmbiente } from './freios.js';
import { quemPediuSair } from './saidas.js';
import { diasDaOferta } from './oferta.js';
import { listaDeTesteDoAmbiente } from './porto.js';
import { modoDaUnidade } from './modo.js';
import { LIMITE_DA_TABELA, ordenarDestinatarios, type DadosDoPainel } from './painel.js';

export async function dadosDaTela(ondaId: string, email: string | null | undefined): Promise<DadosDoPainel | null> {
  const onda = await prisma.disparoOnda.findUnique({ where: { id: ondaId }, include: { unit: true, campanha: { select: { nome: true } } } });
  if (!onda) return null;
  const retomavel = onda.estado === 'pausada' && onda.pausaCausa === 'sair';
  const colunas = { id: true, nome: true, telefone: true, estado: true, motivo: true, enviadoEm: true, simuladoEm: true, kommoLeadId: true, atualizadoEm: true, criadoEm: true } as const;
  const [porEstado, simulados, amostra, saidas, enviados, falhas, pendentes] = await Promise.all([
    prisma.disparoDestinatario.groupBy({ by: ['estado'], where: { ondaId }, _count: true }),
    prisma.disparoDestinatario.count({ where: { ondaId, simuladoEm: { not: null } } }),
    prisma.disparoDestinatario.findMany({ where: { ondaId }, orderBy: [{ criadoEm: 'asc' }, { id: 'asc' }], take: 15, select: { nome: true, telefone: true } }),
    // Quem pediu SAIR interessa sempre que a campanha já tem algum: é o que o João lê antes de retomar (e vale como aviso nas outras ondas).
    // Sem ninguém em `saiu` a função devolve [] só com uma consulta indexada: a varredura de mensagens só roda quando há quem procurar.
    onda.estado === 'montando' || onda.estado === 'cancelada' ? Promise.resolve([]) : quemPediuSair(onda.unit, onda.campanhaId),
    // A tabela por pessoa: um pedaço de cada grupo (cada um já na sua ordem), que `ordenarDestinatarios` junta e corta.
    // Só leitura, só colunas que já existem; o índice (ondaId, estado) atende os três.
    prisma.disparoDestinatario.findMany({ where: { ondaId, estado: { in: ['enviado', 'enviando'] } }, orderBy: [{ enviadoEm: { sort: 'desc', nulls: 'first' } }, { id: 'asc' }], take: LIMITE_DA_TABELA, select: colunas }),
    prisma.disparoDestinatario.findMany({ where: { ondaId, estado: { notIn: ['enviado', 'enviando', 'pendente'] } }, orderBy: [{ atualizadoEm: 'desc' }, { id: 'asc' }], take: LIMITE_DA_TABELA, select: colunas }),
    prisma.disparoDestinatario.findMany({ where: { ondaId, estado: 'pendente' }, orderBy: [{ atualizadoEm: 'asc' }, { id: 'asc' }], take: LIMITE_DA_TABELA, select: colunas }),
  ]);
  const destinatarios = ordenarDestinatarios([...enviados, ...falhas, ...pendentes]).map(({ id: _i, atualizadoEm: _a, criadoEm: _c, ...linha }) => linha);
  // Só pergunta à Meta enquanto ainda dá para aprovar ou retomar: é a prova que destrava (ou trava) o botão.
  const conferenciaMeta = onda.estado === 'montada' || retomavel ? await conferirModeloNaMeta(onda.unit, definicaoDaOnda(onda)) : null;
  const teste = listaDeTesteDoAmbiente(onda.unit.slug);
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
    modo: modoDaUnidade(onda.unit.slug),
    freios: freiosDoAmbiente(),
    resumo: (onda.resumo ?? {}) as DadosDoPainel['resumo'],
    contagem: Object.fromEntries(porEstado.map((g) => [g.estado, g._count])),
    simulados,
    amostra,
    destinatarios,
    destinatariosTotal: porEstado.reduce((soma, g) => soma + g._count, 0),
    kommoSubdominio: onda.unit.kommoSubdomain,
    saidas,
    conferenciaMeta,
    podeAprovar: podeAprovar(email),
    listaDeTeste: teste ? [...teste] : null,
  };
}

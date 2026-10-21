/**
 * Auditoria de Araguaína (21/10/2026), item 3: cidade sem unidade → oferecer as do mesmo estado.
 *
 * Lead 28778230, 19/10: "Moro no para" / "Vcs tem clínicas em Belém ou castanhal no para" → a Sofia: "nossas
 * unidades Doutor Hérnia são aqui em Araguaína/TO — não tenho informação de unidade em Belém ou Castanhal". A
 * equipe completou: "não temos unidades nesses locais". Ninguém disse que no Pará há Marabá, Parauapebas e Canaã
 * dos Carajás. Pedido do João: a lista vai por estado; cidade sem unidade → dizer quais unidades existem no estado
 * dele (e a mais próxima, se souber), oferecer o encaminhamento, e a tarefa para a equipe continua. Nunca "não
 * temos" nem "não tenho informação".
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Unit } from '@prisma/client';

import {
  cidadeDaUnidade,
  montarRede,
  nomeDoEstado,
  renderRedeDeUnidades,
  ufDaCidade,
  type LinhaDeUnidade,
} from './rede-doutor-hernia.js';

function linha(slug: string, over: Partial<LinhaDeUnidade> = {}): LinhaDeUnidade {
  return {
    id: `id-${slug}`,
    slug,
    name: null,
    isActive: true,
    kommoSubdomain: null,
    clinicAddress: null,
    igWhatsappNumber: null,
    fbWhatsappNumber: null,
    crmCompartilhado: null,
    ...over,
  };
}

const REDE = montarRede([
  linha('doutor-hernia-araguaina', { id: 'u-aragua', name: 'Doutor Hérnia Araguaína', kommoSubdomain: 'doutorherniaaraguaina' }),
  linha('doutor-hernia-maraba', { name: 'Doutor Hérnia Marabá', igWhatsappNumber: '5594991110000' }),
  linha('doutor-hernia-parauapebas', { name: 'Doutor Hérnia Parauapebas' }),
  linha('doutor-hernia-canaa', { name: 'Doutor Hérnia Canaã' }),
  linha('doutor-hernia-porto', { name: 'Doutor Hérnia Porto Nacional' }),
  linha('doutor-hernia-imperatriz', { name: 'Comercial' }),
  linha('doutor-hernia-divinopolis', { name: 'Doutor Hérnia Divinópolis' }),
  linha('doutor-hernia-nova-cidade', { name: 'Doutor Hérnia Nova Cidade' }),
]);

const ARAGUAINA = { id: 'u-aragua', slug: 'doutor-hernia-araguaina', name: 'Doutor Hérnia Araguaína', personaCompanyName: null, kommoSubdomain: 'doutorherniaaraguaina' } as unknown as Unit;

/** O trecho de um estado na lista: do título até o próximo título (ou o fim da lista). */
function estado(bloco: string, titulo: string): string {
  const ini = bloco.indexOf(titulo);
  assert.ok(ini >= 0, `faltou o estado: ${titulo}`);
  const resto = bloco.slice(ini + titulo.length);
  const fim = resto.search(/\n(?:[A-Z]{2} — |Estado não cadastrado|\n)/);
  return fim < 0 ? resto : resto.slice(0, fim);
}

test('item 3: a UF de cada unidade — do mapa do ⌂ Unidade e, fora dele, das conhecidas', () => {
  assert.equal(ufDaCidade('Marabá/PA'), 'PA');
  assert.equal(ufDaCidade('Duque de Caxias/RJ'), 'RJ');
  assert.equal(ufDaCidade('Teresópolis'), null);
  assert.equal(ufDaCidade('Cidade/XX'), null);
  assert.equal(nomeDoEstado('PA'), 'Pará');
  assert.equal(nomeDoEstado('TO'), 'Tocantins');
  assert.equal(cidadeDaUnidade('doutor-hernia-divinopolis', 'Doutor Hérnia Divinópolis'), 'Divinópolis/MG');
  assert.equal(cidadeDaUnidade('doutor-hernia-nova-cidade', 'Doutor Hérnia Nova Cidade'), 'Nova Cidade');
});

test('item 3: a Sofia de Araguaína vê as unidades agrupadas por estado — o Pará com as três', () => {
  const bloco = renderRedeDeUnidades(ARAGUAINA, REDE);
  assert.match(bloco, /Você atende a unidade de Araguaína\/TO\./);
  assert.match(bloco, /por estado:/);
  const para = estado(bloco, 'PA — Pará:');
  assert.match(para, /- Canaã dos Carajás\/PA — sem contato cadastrado/);
  assert.match(para, /- Marabá\/PA — WhatsApp \(94\) 99111-0000/);
  assert.match(para, /- Parauapebas\/PA — sem contato cadastrado/);
  assert.doesNotMatch(para, /Porto Nacional|Imperatriz/);
  // o mesmo estado desta unidade vem marcado
  assert.match(estado(bloco, 'TO — Tocantins (o mesmo estado desta unidade):'), /- Porto Nacional\/TO/);
  assert.match(estado(bloco, 'MA — Maranhão:'), /- Imperatriz\/MA/);
  assert.match(estado(bloco, 'MG — Minas Gerais:'), /- Divinópolis\/MG/);
  // sem UF reconhecida: no fim, sem sumir
  assert.match(estado(bloco, 'Estado não cadastrado:'), /- Nova Cidade/);
  assert.ok(bloco.indexOf('MA — Maranhão:') < bloco.indexOf('PA — Pará:'), 'estados em ordem');
  assert.ok(bloco.indexOf('TO — Tocantins') < bloco.indexOf('Estado não cadastrado:'), 'sem UF por último');
  assert.doesNotMatch(bloco, /- Araguaína\/TO/, 'não lista a si mesma');
});

test('item 3: cidade sem unidade → as do mesmo estado, a mais próxima, o encaminhamento — e a tarefa continua', () => {
  const bloco = renderRedeDeUnidades(ARAGUAINA, REDE);
  assert.match(bloco, /CIDADE QUE NÃO ESTÁ NA LISTA: não negue, e nunca "não tenho informação de unidade aí"/);
  assert.match(bloco, /HÁ UNIDADE NO MESMO ESTADO \(na lista acima, ou esta mesma\) → diga quais são/);
  assert.match(bloco, /No Pará a gente tem\s+unidade em Canaã dos Carajás, Marabá e Parauapebas/);
  assert.match(bloco, /diga qual fica mais perto dele se você souber/);
  assert.match(bloco, /pergunte se ele quer ser encaminhado para uma delas ou atendido aqui/);
  assert.match(bloco, /NÃO HÁ UNIDADE DA LISTA NO ESTADO DELE → diga que vai confirmar com a equipe qual a unidade mais\s+próxima/);
  assert.match(bloco, /Nos dois casos chame criar_tarefa com o texto "Paciente pergunta se há unidade em \{cidade\} —\s+confirmar e responder"/);
  // continua valendo o que o #98 já dizia
  assert.match(bloco, /NUNCA diga que não existe unidade numa cidade, nem "não temos unidade aí"/);
  assert.doesNotMatch(bloco, /avaliação/);
});

test('item 3: o bloco é igual a cada chamada (vai no prefixo cacheado)', () => {
  assert.equal(renderRedeDeUnidades(ARAGUAINA, REDE), renderRedeDeUnidades(ARAGUAINA, REDE));
});

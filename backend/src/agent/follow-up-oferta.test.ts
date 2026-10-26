import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { Unit } from '@prisma/client';
import { guardrailDaRegua } from './follow-up.js';
import { semTextoDeSair, type DadosDoPainel } from '../lib/disparo/painel.js';
import { FREIOS_PADRAO } from '../lib/disparo/freios.js';

const UNIT = { id: 'u1', slug: 'doutor-hernia-canaa', category: 'saude', sourceProdutos: 'Consulta presencial: R$ 350 no dia, ou R$ 280 antecipado.', sourcePapel: null, sourceNegocio: null, systemPrompt: null, spineBookingRequiresPayment: false, updatedAt: new Date(0) } as unknown as Unit;
const OFERTA = 'Consulta de avaliação por R$ 150 até 31/10.';
const TEXTO = 'Ainda dá tempo da condição de R$ 150 que te mandamos, quer ver os horários?';

test('régua: SEM a oferta o R$ 150 vira o valor da ficha (o bug); COM a oferta do disparo que ele recebeu, sai como está', () => {
  const sem = guardrailDaRegua(TEXTO, UNIT, null);
  assert.equal(sem.guard.rewritten, true);
  assert.ok(!sem.guard.text.includes('R$ 150'));
  const com = guardrailDaRegua(TEXTO, UNIT, OFERTA);
  assert.equal(com.guard.rewritten, false);
  assert.equal(com.guard.text, TEXTO);
  assert.equal(com.recusou, false);
});

test('régua: com a oferta, um preço inventado continua cortado, e a recusa (preço sem substituto) continua valendo', () => {
  const inventado = guardrailDaRegua('Hoje fica R$ 200 pra você.', UNIT, OFERTA);
  assert.equal(inventado.guard.rewritten, true);
  assert.ok(!inventado.guard.text.includes('R$ 200'));
  const clinico = guardrailDaRegua('Pelo que você descreveu, você tem hérnia de disco.', UNIT, OFERTA);
  assert.equal(clinico.recusou, true);
});

test('a régua carrega a oferta do paciente antes do guardrail (e o código do follow-up passa por guardrailDaRegua)', () => {
  const src = readFileSync(new URL('./follow-up.ts', import.meta.url), 'utf8');
  assert.match(src, /ofertaDoLead\(unit\.id, args\.leadId\)/);
  assert.match(src, /guardrailDaRegua\(tratado, unit, oferta\?\.oferta \?\? null\)/);
  assert.doesNotMatch(src, /aplicarGuardrail\(tratado, unit\)/, 'nenhuma chamada sem a oferta');
});

test('chave de serviço não recebe o texto do SAIR (só o primeiro nome); a sessão do João, sim', () => {
  const dados = {
    onda: { id: 'o1', estado: 'pausada', total: 1, etiqueta: 'e', impressao: 'x', aprovadaPor: null, aprovadaEm: null, pausaMotivo: null, template: 't', idioma: 'pt_BR', textoModelo: 'Oi', variaveis: [], cabecalho: null },
    campanhaNome: 'C', unidade: { slug: 'u', nome: 'U' }, modo: 'seco', freios: FREIOS_PADRAO, resumo: {}, contagem: {}, simulados: 0, amostra: [],
    saidas: [{ nome: 'Maria', resposta: 'não quero mais, meu problema de saúde é X', quando: null }],
    conferenciaMeta: null, podeAprovar: false, listaDeTeste: null,
  } as unknown as DadosDoPainel;
  const cega = semTextoDeSair(dados);
  assert.deepEqual(cega.saidas, [{ nome: 'Maria', resposta: '', quando: null }]);
  assert.equal(dados.saidas![0]!.resposta.length > 0, true, 'não muda o original');
  const ctl = readFileSync(new URL('../controllers/disparo.controller.ts', import.meta.url), 'utf8');
  assert.match(ctl, /req\.user \? lida : semTextoDeSair\(lida\)/g, 'o JSON e a página passam pelo filtro quando não há sessão');
  assert.equal(ctl.match(/semTextoDeSair\(lida\)/g)?.length, 2);
});

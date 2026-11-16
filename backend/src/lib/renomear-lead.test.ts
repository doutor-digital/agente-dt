import { test } from 'node:test';
import assert from 'node:assert/strict';

import { dataCurta, desdeDaUnidade, ehTituloGenerico, estadoDoCartao, estadoMaisFraco, nomeDaFranquia, nomeDeGente, nomesCompativeis, planejarRenomeacao, unidadeListada, type NomesNaFranquia } from './renomear-lead.js';
import { _limparParaTeste, nomesNaFranquiaPadrao, renomearConta, type DepsDaFranquia, type KommoDoRenomear } from './renomear-lead-worker.js';
import type { KommoLead } from '../services/kommo.service.js';
import type { MembroDoCrm } from './crm-compartilhado.js';

const TZ = 'America/Sao_Paulo';
// 26/10/2026 14:00 em Brasília = 17:00 UTC
const AGORA = Date.UTC(2026, 9, 26, 17, 0, 0) / 1000;

test('dataCurta: dd/mm/aa no fuso da unidade, não em UTC', () => {
  assert.equal(dataCurta(AGORA, TZ), '26/10/26');
  // 27/10 01:30 UTC ainda é 26/10 22:30 em Brasília
  assert.equal(dataCurta(Date.UTC(2026, 9, 27, 1, 30) / 1000, TZ), '26/10/26');
  // e em Boa Vista (UTC-4) 27/10 03:30 UTC ainda é 26/10
  assert.equal(dataCurta(Date.UTC(2026, 9, 27, 3, 30) / 1000, 'America/Boa_Vista'), '26/10/26');
});

test('nomeDeGente: os nomes de verdade da amostra das SDRs passam, com capitalização normal', () => {
  assert.equal(nomeDeGente('Carla Ruth'), 'Carla Ruth');
  assert.equal(nomeDeGente('Simone Katia'), 'Simone Katia');
  assert.equal(nomeDeGente('Sérgio Luis'), 'Sérgio Luis');
  assert.equal(nomeDeGente('Perpétua Fernandes'), 'Perpétua Fernandes');
  assert.equal(nomeDeGente('Marlucia'), 'Marlucia');
  assert.equal(nomeDeGente('Vera Lucia Hilario'), 'Vera Lucia Hilario');
  assert.equal(nomeDeGente('Lage Josy'), 'Lage Josy');
  assert.equal(nomeDeGente('silvia leticia Rocha'), 'Silvia Leticia Rocha');
  assert.equal(nomeDeGente('  MARIA   DA SILVA '), 'Maria da Silva');
  assert.equal(nomeDeGente("joão d'ávila"), "João D'Ávila");
  assert.equal(nomeDeGente('ana-maria souza'), 'Ana-Maria Souza');
  assert.equal(nomeDeGente('Maria Paz'), 'Maria Paz', 'Paz/Vida/Dia sozinhos são sobrenome');
  assert.equal(nomeDeGente('João Vida'), 'João Vida');
  assert.equal(nomeDeGente('Ana Dia'), 'Ana Dia');
  assert.equal(nomeDeGente('Sueli Jesus'), 'Sueli Jesus', 'Jesus é sobrenome comum — só a frase "é Fiel" derruba');
  assert.equal(nomeDeGente('Cláudio McDonald'), 'Cláudio McDonald', 'maiúscula no meio é como a pessoa escreveu');
});

test('nomeDeGente: os lixos da amostra e do mundo real viram null (melhor "Lead" do que lixo)', () => {
  for (const lixo of [
    'Sueli Jesus é Fiel....',
    'Deus é  Deus',
    'Deus é Deus',
    '-',
    '',
    '   ',
    null,
    undefined,
    '.',
    '🙏🏼',
    'Maria 🌹',
    'Joana ❤',
    '+55 24 99999-9999',
    '5524999999999',
    'Ana 2',
    'Ana e Pedro',
    'Maria Jose da Silva Santos Oliveira', // 5 palavras
    'Bom dia',
    'Boa Tarde',
    'Paz e Bem',
    'Luz e Paz',
    'Dr. Hérnia',
    'Doutor Hérnia',
    'Clínica Central',
    'Contato #123',
    'Lead',
    'Kkkkkk',
    'Aaaaa Bbbbb',
    'Mrs Dlt',
    'J',
    'M R',
    'Ana!',
    'Ana, Maria',
    'Oi, tudo bem?',
    'a'.repeat(70),
  ]) {
    assert.equal(nomeDeGente(lixo), null, `deveria recusar ${JSON.stringify(lixo)}`);
  }
});

test('planejarRenomeacao: a amostra real das SDRs, caso a caso', () => {
  const d = '24/10/26';
  const plano = (contato: string | null, nomesDoDia: string[] = []) =>
    planejarRenomeacao({ nomeDoLead: 'Lead #22647811', nomeDoContato: contato, data: d, nomesDoDia })?.para;
  assert.equal(plano('Carla Ruth'), 'Carla Ruth 24/10/26');
  assert.equal(plano('Simone Katia'), 'Simone Katia 24/10/26');
  assert.equal(plano('Sérgio Luis'), 'Sérgio Luis 24/10/26');
  assert.equal(plano('Perpétua Fernandes'), 'Perpétua Fernandes 24/10/26');
  assert.equal(plano('Marlucia'), 'Marlucia 24/10/26');
  assert.equal(plano('Vera Lucia Hilario'), 'Vera Lucia Hilario 24/10/26');
  assert.equal(plano('Lage Josy'), 'Lage Josy 24/10/26');
  assert.equal(plano('silvia leticia Rocha'), 'Silvia Leticia Rocha 24/10/26');
  // lixos → "Lead dd/mm/aa", nunca o lixo
  assert.equal(plano('Sueli Jesus é Fiel....'), 'Lead 24/10/26');
  assert.equal(plano('Deus é  Deus'), 'Lead 24/10/26');
  assert.equal(plano('-'), 'Lead 24/10/26');
  assert.equal(plano(null), 'Lead 24/10/26');
});

test('planejarRenomeacao: numeração "Lead 2 …" pelo MAIOR número já usado no dia, mesmo com ano de 2 dígitos', () => {
  const plano = (nomesDoDia: string[]) => planejarRenomeacao({ nomeDoLead: 'Lead #1', nomeDoContato: '-', data: '24/10/26', nomesDoDia })?.para;
  assert.equal(plano([]), 'Lead 24/10/26');
  assert.equal(plano(['Maria 24/10/26', 'Lead 25/10/26']), 'Lead 24/10/26', 'nome de gente e outro dia não contam');
  assert.equal(plano(['Lead 24/10/26']), 'Lead 2 24/10/26');
  assert.equal(plano(['Lead 24/10/26', 'Lead 2 24/10/26', 'Lead 5 24/10/26']), 'Lead 6 24/10/26');
});

test('planejarRenomeacao: nome que a SDR já deu NUNCA é tocado (e fora de unidade listada só o "Lead #123" do Kommo é sem nome — como sempre)', () => {
  for (const nome of ['Simone Katia 26/10/26', 'Mauriza', 'Carla Ruth', 'Lead 26/10/26', 'Lead 2 26/10/2026', 'Sem Nome 24/10/26']) {
    assert.equal(planejarRenomeacao({ nomeDoLead: nome, nomeDoContato: 'Outra Pessoa', data: '26/10/26', nomesDoDia: [] }), null, nome);
  }
  // os do Kommo ainda são "sem nome"
  for (const nome of ['Lead #22647811', 'Lead 22647811', 'Lead', '', null]) {
    assert.ok(planejarRenomeacao({ nomeDoLead: nome, nomeDoContato: 'Ana Paula', data: '26/10/26', nomesDoDia: [] }), String(nome));
  }
});

// Daqui em diante: unidade LISTADA em RENOMEAR_LEAD_DESDE (ampliado)
const plan = (e: Parameters<typeof planejarRenomeacao>[0]) => planejarRenomeacao({ ampliado: true, ...e });

test('planejarRenomeacao ampliado: nome que a SDR deu continua intocado; o provisório do titulo-padrao e o nosso são "sem nome"', () => {
  for (const nome of ['Simone Katia 26/10/26', 'Mauriza', 'Carla Ruth', 'Sem Nome 24/10/26', 'Leandro 16/11/2026', 'Lead Silva', 'Lead 26/10']) {
    assert.equal(plan({ nomeDoLead: nome, nomeDoContato: 'Outra Pessoa', data: '26/10/26', nomesDoDia: [] }), null, nome);
  }
  for (const nome of ['Lead #22647811', 'Lead 22647811', 'Lead', '', null, 'Lead 16/11/2026', 'Lead 6 13/11/2026', 'lead 2 26/10/26', 'Lead 26/10/26']) {
    assert.ok(plan({ nomeDoLead: nome, nomeDoContato: 'Ana Paula', data: '26/10/26', nomesDoDia: [] }), String(nome));
  }
});

test('ehTituloGenerico: sem ampliar é só o do Kommo; ampliado reconhece o do titulo-padrao e o nosso, e só esses', () => {
  for (const g of ['Lead 16/11/2026', 'Lead 6 13/11/2026', 'LEAD 2 13/11/2026', 'Lead 16/11/26']) {
    assert.equal(ehTituloGenerico(g), false, `sem ampliar: ${g}`);
    assert.equal(ehTituloGenerico(g, true), true, `ampliado: ${g}`);
  }
  for (const g of ['Lead #123', '', null, undefined]) {
    assert.equal(ehTituloGenerico(g), true, String(g));
    assert.equal(ehTituloGenerico(g, true), true, String(g));
  }
  for (const n of ['Alex Sandre 13/11/26', 'Alex Sandre 13/11/2026', 'Lead Silva 13/11/2026', 'Maria', 'Lead 13/11']) {
    assert.equal(ehTituloGenerico(n, true), false, n);
  }
});

// ── de onde vem o nome: franquia → contato → (nada) ──────────────────────────────────────────────────────────

test('planejarRenomeacao: título do titulo-padrao vira o nome do contato (o caso de Petrópolis, 13/11)', () => {
  const p = plan({ nomeDoLead: 'Lead 6 13/11/2026', nomeDoContato: 'alex sandre', data: '13/11/26', nomesDoDia: [] });
  assert.deepEqual(p, { tipo: 'nome', para: 'Alex Sandre 13/11/26', fonte: 'contato', motivo: 'nome do contato' });
});

test('planejarRenomeacao: a franquia vence o contato quando é UM paciente e o contato (2+ palavras) está no cadastro (traz o nome inteiro)', () => {
  const p = plan({
    nomeDoLead: 'Lead 16/11/2026',
    nomeDoContato: 'Alex Sandre',
    franquia: { tipo: 'pacientes', nomes: ['ALEX SANDRE DA SILVA'] },
    data: '16/11/26',
    nomesDoDia: [],
  });
  assert.equal(p?.para, 'Alex Sandre da Silva 16/11/26');
  assert.equal(p?.tipo === 'nome' && p.fonte, 'franquia');
});

test('confere contra o nome CRU do cadastro e só encurta para exibir (Maria Aparecida, Lucilene Coelho, Ana Maria)', () => {
  const casos: Array<[string, string, string]> = [
    ['Maria Aparecida', 'MARIA APARECIDA DA SILVA SANTOS', 'Maria Aparecida Santos'],
    ['Lucilene Coelho', 'Lucilene Coelho Sendra Pereira Lima', 'Lucilene Coelho Lima'],
    ['Ana Maria', 'ANA MARIA OLIVEIRA SANTOS SOUZA', 'Ana Maria Souza'],
  ];
  for (const [contato, cadastro, exibido] of casos) {
    assert.ok(nomesCompativeis(contato, cadastro), `${contato} × ${cadastro}`);
    const p = plan({ nomeDoLead: 'Lead 1 16/11/2026', nomeDoContato: contato, franquia: { tipo: 'pacientes', nomes: [cadastro] }, data: '16/11/26', nomesDoDia: [] });
    assert.equal(p?.para, `${exibido} 16/11/26`, contato);
    assert.equal(p?.tipo === 'nome' && p.fonte, 'franquia', `${contato}: o motivo não pode ser "outro nome"`);
  }
  // e o nome cru comprido que não tem nada a ver continua recusado, com o motivo certo
  const q = plan({ nomeDoLead: 'Lead 1 16/11/2026', nomeDoContato: 'Maria Eduarda', franquia: { tipo: 'pacientes', nomes: ['maria aparecida da silva santos'] }, data: '16/11/26', nomesDoDia: [] });
  assert.equal(q?.para, 'Maria Eduarda 16/11/26');
  assert.match(q?.motivo ?? '', /outro nome que o contato/);
});

test('contato com UMA palavra só ("Maria") NÃO usa a franquia — o título alimenta o franquia-sync (título → idClient → etapa)', () => {
  assert.ok(!nomesCompativeis('Maria', 'Maria Clara Souza'));
  const p = plan({ nomeDoLead: 'Lead 16/11/2026', nomeDoContato: 'Maria', franquia: { tipo: 'pacientes', nomes: ['Maria Clara Souza'] }, data: '16/11/26', nomesDoDia: [] });
  assert.equal(p?.para, 'Maria 16/11/26');
  assert.equal(p?.tipo === 'nome' && p.fonte, 'contato');
  assert.match(p?.motivo ?? '', /uma palavra só/);
});

test('planejarRenomeacao: DOIS pacientes no mesmo telefone (mãe e filha) → não usa a franquia, fica o nome do contato', () => {
  const p = plan({
    nomeDoLead: 'Lead 3 16/11/2026',
    nomeDoContato: 'Maria Souza',
    franquia: { tipo: 'pacientes', nomes: ['Maria Souza', 'Júlia Souza'] },
    data: '16/11/26',
    nomesDoDia: [],
  });
  assert.equal(p?.para, 'Maria Souza 16/11/26');
  assert.equal(p?.tipo === 'nome' && p.fonte, 'contato');
  assert.match(p?.motivo ?? '', /2 pacientes no mesmo telefone/);
  // e sem nome de contato aproveitável, dois pacientes não dão nome algum: o genérico fica
  const q = plan({ nomeDoLead: 'Lead 3 16/11/2026', nomeDoContato: '🙏', franquia: { tipo: 'pacientes', nomes: ['Maria Souza', 'Júlia Souza'] }, data: '16/11/26', nomesDoDia: [] });
  assert.equal(q?.tipo, 'deixa');
});

test('planejarRenomeacao: o contato tem outro nome que o paciente da franquia (familiar escrevendo) → não usa a franquia', () => {
  const p = plan({ nomeDoLead: 'Lead 16/11/2026', nomeDoContato: 'Carla Souza', franquia: { tipo: 'pacientes', nomes: ['Júlia Souza'] }, data: '16/11/26', nomesDoDia: [] });
  assert.equal(p?.para, 'Carla Souza 16/11/26');
  assert.match(p?.motivo ?? '', /outro nome que o contato/);
});

test('planejarRenomeacao: sobrenome em comum NÃO confere (Maria Silva × Ana Silva = mãe e filha) → nome do contato', () => {
  const p = plan({ nomeDoLead: 'Lead 16/11/2026', nomeDoContato: 'Maria Silva', franquia: { tipo: 'pacientes', nomes: ['Ana Silva'] }, data: '16/11/26', nomesDoDia: [] });
  assert.equal(p?.para, 'Maria Silva 16/11/26');
  assert.equal(p?.tipo === 'nome' && p.fonte, 'contato');
  assert.ok(nomesCompativeis('Lucilene coelho', 'LUCILENE COELHO SENDRA'));
  assert.ok(nomesCompativeis('João Pedro', 'JOAO PEDRO DA SILVA'), 'sem acento, caixa ou "da"');
  assert.ok(!nomesCompativeis('Maria Silva', 'Ana Silva'));
  assert.ok(!nomesCompativeis('Maria Eduarda', 'Maria Clara Souza'), 'primeiro nome composto: outra pessoa');
  assert.ok(!nomesCompativeis('Alex Sandre Silva', 'Alex Sandre'), 'contato mais completo que o cadastro: fica o do contato');
  const p2 = plan({ nomeDoLead: 'Lead 16/11/2026', nomeDoContato: 'Alex Sandre Silva', franquia: { tipo: 'pacientes', nomes: ['Alex Sandre'] }, data: '16/11/26', nomesDoDia: [] });
  assert.equal(p2?.para, 'Alex Sandre Silva 16/11/26');
});

test('planejarRenomeacao: "Lead #123" do Kommo sem nome é numerado junto com os "Lead N dd/mm/aaaa" do titulo-padrao do mesmo dia (ampliado)', () => {
  const nomesDoDia = ['Lead 16/11/2026', 'Lead 2 16/11/2026', 'Lead 5 15/11/2026'];
  assert.equal(plan({ nomeDoLead: 'Lead #9', nomeDoContato: '-', data: '16/11/26', nomesDoDia })?.para, 'Lead 3 16/11/26');
  // fora de unidade listada a numeração é a de sempre (só os de 2 dígitos)
  assert.equal(planejarRenomeacao({ nomeDoLead: 'Lead #9', nomeDoContato: '-', data: '16/11/26', nomesDoDia })?.para, 'Lead 16/11/26');
});

test('planejarRenomeacao: contato sem nome de pessoa NÃO usa a franquia (não dá para conferir se é a mãe ou a filha) — o genérico fica, com o motivo', () => {
  const p = plan({ nomeDoLead: 'Lead 16/11/2026', nomeDoContato: '🙏🏼', franquia: { tipo: 'pacientes', nomes: ['Júlia Souza'] }, data: '16/11/26', nomesDoDia: [] });
  assert.equal(p?.tipo, 'deixa');
  assert.match(p?.motivo ?? '', /há paciente da franquia neste telefone, mas o contato não tem nome de pessoa/);
  assert.doesNotMatch(p?.motivo ?? '', /Júlia|Souza/, 'o motivo não carrega o nome do paciente');
});

test('planejarRenomeacao: franquia sem o telefone (ou só lead lá) → nome do contato', () => {
  for (const franquia of [{ tipo: 'nenhum' as const }, null, undefined]) {
    const p = plan({ nomeDoLead: 'Lead 16/11/2026', nomeDoContato: 'Bia Souza', franquia, data: '16/11/26', nomesDoDia: [] });
    assert.equal(p?.para, 'Bia Souza 16/11/26');
  }
});

test('planejarRenomeacao: contato sem nome de pessoa NÃO troca genérico por genérico — o título fica como está', () => {
  for (const contato of ['-', '', null, 'Deus é Deus', '🙏🏼', '+55 24 99999-9999']) {
    for (const titulo of ['Lead 16/11/2026', 'Lead 6 13/11/2026', 'Lead 16/11/26']) {
      const p = plan({ nomeDoLead: titulo, nomeDoContato: contato, data: '16/11/26', nomesDoDia: [] });
      assert.equal(p?.tipo, 'deixa', `${titulo} / ${contato}`);
      assert.equal(p?.para, null);
    }
  }
  // já o "Lead #123" do Kommo, sem nome nenhum, continua virando "Lead dd/mm/aa" (como sempre)
  assert.equal(plan({ nomeDoLead: 'Lead #123', nomeDoContato: '-', data: '16/11/26', nomesDoDia: [] })?.para, 'Lead 16/11/26');
});

test('nomeDaFranquia: só letras, capitalizado; lixo vira null', () => {
  assert.equal(nomeDaFranquia('ALEX SANDRE'), 'Alex Sandre');
  assert.equal(nomeDaFranquia('  maria   da  silva '), 'Maria da Silva');
  assert.equal(nomeDaFranquia('Ana Paula Souza'), 'Ana Paula Souza');
  assert.equal(nomeDaFranquia('maria aparecida da silva santos'), 'Maria Santos');
  for (const lixo of ['', null, undefined, '12345', 'Maria 2', 'J', 'Maria 🌹', 'da de']) assert.equal(nomeDaFranquia(lixo), null, String(lixo));
});

test('desdeDaUnidade: começo do dia no fuso da unidade; fora da lista, inválido, futuro ou velho demais = null (unidade NÃO listada)', () => {
  const raw = 'doutor-hernia-petropolis=2026-11-13, outra=2026-01-01';
  const agora = Date.UTC(2026, 10, 16, 15, 0, 0) / 1000;
  assert.equal(desdeDaUnidade('doutor-hernia-petropolis', raw, TZ, agora), Date.UTC(2026, 10, 13, 3, 0, 0) / 1000, '13/11 00:00 em Brasília = 03:00 UTC');
  assert.equal(desdeDaUnidade('doutor-hernia-petropolis', raw, 'America/Boa_Vista', agora), Date.UTC(2026, 10, 13, 4, 0, 0) / 1000);
  assert.equal(desdeDaUnidade('doutor-hernia-caxias', raw, TZ, agora), null, 'unidade fora da lista');
  assert.equal(desdeDaUnidade('outra', raw, TZ, agora), null, 'mais de 30 dias');
  assert.equal(desdeDaUnidade('x', 'x=2026-12-01', TZ, agora), null, 'no futuro');
  assert.equal(desdeDaUnidade('x', 'x=ontem', TZ, agora), null);
  assert.equal(desdeDaUnidade('x', 'x=2026-11-31', TZ, agora), null, 'dia que não existe');
  assert.equal(desdeDaUnidade('x', undefined, TZ, agora), null);
  assert.equal(desdeDaUnidade('x', "'x=2026-11-13'", TZ, agora), Date.UTC(2026, 10, 13, 3, 0, 0) / 1000, 'aspas do .env');
  assert.equal(desdeDaUnidade('x', 'x=amanha,x=2026-11-13', TZ, agora), Date.UTC(2026, 10, 13, 3, 0, 0) / 1000, 'a entrada de data válida vale, mesmo depois de uma inválida');
});

test('unidadeListada: o interruptor do trabalho novo NÃO expira com a data do estoque (30 dias) — só exige um dia que existe', () => {
  const raw = 'velha=2026-01-01,futura=2027-01-01,boa=2026-11-13,ruim=ontem,inexistente=2026-02-31';
  assert.equal(unidadeListada('boa', raw), true);
  assert.equal(unidadeListada('velha', raw), true, 'passou de 30 dias: segue listada (só deixa de alcançar o estoque)');
  assert.equal(unidadeListada('futura', raw), true);
  assert.equal(unidadeListada('ruim', raw), false);
  assert.equal(unidadeListada('inexistente', raw), false);
  assert.equal(unidadeListada('outra', raw), false);
  assert.equal(unidadeListada('boa', undefined), false);
  assert.equal(unidadeListada('boa', ''), false);
});

// ── qual chave vale para o cartão ────────────────────────────────────────────────────────────────────────────

const PETRO: MembroDoCrm = { unitId: 'u-petro', contaUnitId: 'u-petro', rotulo: 'Petrópolis', slug: 'doutor-hernia-petropolis' };
const CAXIAS: MembroDoCrm = { unitId: 'u-caxias', contaUnitId: 'u-petro', rotulo: 'Caxias', slug: 'doutor-hernia-caxias' };
const CONTA = { id: 'u-petro', slug: 'doutor-hernia-petropolis' };
const estados = (m: Record<string, 'ligado' | 'seco' | 'desligado'>) => (slug: string) => m[slug] ?? 'desligado';

test('estadoMaisFraco', () => {
  assert.equal(estadoMaisFraco([]), 'desligado');
  assert.equal(estadoMaisFraco(['ligado', 'ligado']), 'ligado');
  assert.equal(estadoMaisFraco(['ligado', 'seco']), 'seco');
  assert.equal(estadoMaisFraco(['seco', 'desligado', 'ligado']), 'desligado');
});

test('estadoDoCartao: Kommo de uma unidade só vale a chave dela; dividido, a da unidade do cartão', () => {
  const e = estados({ 'doutor-hernia-petropolis': 'ligado', 'doutor-hernia-caxias': 'seco' });
  assert.deepEqual(estadoDoCartao(null, e, null, CONTA), { dono: null, estado: 'ligado' });
  assert.deepEqual(estadoDoCartao([PETRO, CAXIAS], e, 'Petrópolis', CONTA), { dono: { id: 'u-petro', slug: 'doutor-hernia-petropolis' }, estado: 'ligado' });
  assert.deepEqual(estadoDoCartao([PETRO, CAXIAS], e, 'caxias', CONTA), { dono: { id: 'u-caxias', slug: 'doutor-hernia-caxias' }, estado: 'seco' });
  // sem unidade (ou unidade que ninguém usa): a mais fraca — nunca ligada se a outra está em seco
  assert.deepEqual(estadoDoCartao([PETRO, CAXIAS], e, null, CONTA), { dono: null, estado: 'seco' });
  assert.deepEqual(estadoDoCartao([PETRO, CAXIAS], e, 'Niterói', CONTA), { dono: null, estado: 'seco' });
  const soPetro = estados({ 'doutor-hernia-petropolis': 'ligado' });
  assert.equal(estadoDoCartao([PETRO, CAXIAS], soPetro, null, CONTA).estado, 'desligado');
  assert.equal(estadoDoCartao([PETRO, CAXIAS], soPetro, 'Caxias', CONTA).estado, 'desligado');
  assert.equal(estadoDoCartao([PETRO, CAXIAS], soPetro, 'Petrópolis', CONTA).estado, 'ligado');
});

// ── a rodada inteira, com um Kommo falso ─────────────────────────────────────────────────────────────────────

interface Cartao { id: number; nome: string; contato: number | null; unidade?: string; minutosDeVida?: number; status?: number }

function cenario(cartoes: Cartao[], contatos: Record<number, string | null>, opcoes: { aoRelero?: (id: number) => string; telefones?: Record<number, string> } = {}) {
  const gravados: Array<{ id: number; nome: string }> = [];
  const lidos: number[] = [];
  const leads: KommoLead[] = cartoes.map((c) => ({
    id: c.id,
    name: c.nome,
    status_id: c.status ?? 1,
    pipeline_id: 1,
    created_at: AGORA - (c.minutosDeVida ?? 30) * 60,
    custom_fields_values: c.unidade ? [{ field_id: 479786, field_name: '⌂ Unidade de atendimento', values: [{ value: c.unidade }] }] : [],
    _embedded: { contacts: c.contato === null ? [] : [{ id: c.contato, is_main: true }] },
  })) as KommoLead[];
  const kommo: KommoDoRenomear = {
    listLeadsNaJanela: async () => ({ leads, truncado: false }),
    contatosBasicos: async (ids: number[]) => new Map(ids.filter((i) => i in contatos).map((i) => [i, { nome: contatos[i], telefone: opcoes.telefones?.[i] ?? null }])),
    getLead: async (id: number) => {
      lidos.push(id);
      const l = leads.find((x) => x.id === id)!;
      return { ...l, name: opcoes.aoRelero ? opcoes.aoRelero(id) : l.name } as KommoLead;
    },
    updateLeadName: async (id: number, nome: string) => {
      gravados.push({ id, nome });
    },
  } as unknown as KommoDoRenomear;
  const simulados: Array<{ leadId: number; valor: unknown; slug: string }> = [];
  const registrar = ((unit: { slug: string }, _a: string, s: { leadId: number; valor?: unknown }) => {
    simulados.push({ leadId: s.leadId, valor: s.valor, slug: unit.slug });
  }) as never;
  return { kommo, gravados, lidos, simulados, registrar };
}

const unit = { id: 'u-petro', slug: 'doutor-hernia-petropolis', businessHoursTimezone: TZ, spineTimezone: TZ };
const SEM_NOME = (n: number) => `Lead #${n}`;

test('rodada em SECO: registra o que renomearia e NÃO escreve no Kommo', async () => {
  const c = cenario(
    [
      { id: 1, nome: SEM_NOME(1), contato: 11 },
      { id: 2, nome: SEM_NOME(2), contato: 12 },
      { id: 3, nome: SEM_NOME(3), contato: 13 },
    ],
    { 11: 'Carla Ruth', 12: 'Deus é  Deus', 13: '-' },
  );
  const r = await renomearConta({ unit, membros: null, kommo: c.kommo, estadoDe: estados({ [unit.slug]: 'seco' }), agora: AGORA, registrar: c.registrar });
  assert.deepEqual(c.gravados, [], 'seco não grava');
  assert.deepEqual(c.lidos, [], 'seco nem relê');
  assert.equal(r?.simulados, 3);
  assert.deepEqual(c.simulados.map((s) => s.valor), ['Carla Ruth 26/10/26', 'Lead 26/10/26', 'Lead 2 26/10/26']);
});

test('rodada LIGADA: grava só o nome, numera os sem nome do dia e nunca toca nome que a SDR deu', async () => {
  const c = cenario(
    [
      { id: 1, nome: 'Simone Katia 26/10/26', contato: 11 }, // SDR já nomeou
      { id: 2, nome: SEM_NOME(2), contato: 12 },
      { id: 3, nome: SEM_NOME(3), contato: 13 },
      { id: 4, nome: 'Mauriza', contato: 14 },
      { id: 5, nome: 'Lead 26/10/26', contato: 15 }, // título nosso de antes: não é "sem nome"
    ],
    { 11: 'Simone Katia', 12: 'Sérgio Luis', 13: 'Sueli Jesus é Fiel....', 14: 'silvia leticia Rocha', 15: '-' },
  );
  const r = await renomearConta({ unit, membros: null, kommo: c.kommo, estadoDe: estados({ [unit.slug]: 'ligado' }), agora: AGORA, registrar: c.registrar });
  assert.deepEqual(c.gravados, [
    { id: 2, nome: 'Sérgio Luis 26/10/26' },
    { id: 3, nome: 'Lead 2 26/10/26' }, // "Lead 26/10/26" do id 5 já existe no dia
  ]);
  assert.equal(r?.gravados, 2);
});

test('rodada LIGADA: a SDR nomeou no meio da varredura — releitura impede de sobrescrever', async () => {
  const c = cenario([{ id: 2, nome: SEM_NOME(2), contato: 12 }], { 12: 'Sérgio Luis' }, { aoRelero: () => 'Sérgio 26/10/26' });
  const r = await renomearConta({ unit, membros: null, kommo: c.kommo, estadoDe: estados({ [unit.slug]: 'ligado' }), agora: AGORA, registrar: c.registrar });
  assert.deepEqual(c.gravados, []);
  assert.equal(r?.jaNomeados, 1);
});

test('rodada: lead com menos de 3 minutos ou com mais de 24 h fica para as SDRs / para a próxima', async () => {
  const c = cenario(
    [
      { id: 1, nome: SEM_NOME(1), contato: 11, minutosDeVida: 1 },
      { id: 2, nome: SEM_NOME(2), contato: 12, minutosDeVida: 25 * 60 },
      { id: 3, nome: SEM_NOME(3), contato: 13, minutosDeVida: 10 },
    ],
    { 11: 'Ana Paula', 12: 'Bia Souza', 13: 'Célia Dias' },
  );
  await renomearConta({ unit, membros: null, kommo: c.kommo, estadoDe: estados({ [unit.slug]: 'ligado' }), agora: AGORA, registrar: c.registrar });
  assert.deepEqual(c.gravados, [{ id: 3, nome: 'Célia Dias 26/10/26' }]);
});

test('numeração só conta o MESMO dia local: "Lead" de ontem não vira "Lead 2" hoje', async () => {
  const c = cenario(
    [
      { id: 1, nome: 'Lead 25/10/26', contato: 11, minutosDeVida: 14 * 60 + 5 }, // 25/10 23:55 em Brasília, ontem
      { id: 2, nome: SEM_NOME(2), contato: 12, minutosDeVida: 30 },
    ],
    { 11: 'Ana Paula', 12: '-' },
  );
  await renomearConta({ unit, membros: null, kommo: c.kommo, estadoDe: estados({ [unit.slug]: 'ligado' }), agora: AGORA, registrar: c.registrar });
  assert.deepEqual(c.gravados, [{ id: 2, nome: 'Lead 26/10/26' }]);
});

test('conta dividida: cada cartão vale a chave da SUA unidade; sem unidade vale a mais fraca; desligada não grava', async () => {
  const c = cenario(
    [
      { id: 1, nome: SEM_NOME(1), contato: 11, unidade: 'Petrópolis' },
      { id: 2, nome: SEM_NOME(2), contato: 12, unidade: 'Caxias' },
      { id: 3, nome: SEM_NOME(3), contato: 13 },
    ],
    { 11: 'Ana Paula', 12: 'Bia Souza', 13: 'Célia Dias' },
  );
  const r = await renomearConta({
    unit,
    membros: [PETRO, CAXIAS],
    kommo: c.kommo,
    estadoDe: estados({ 'doutor-hernia-petropolis': 'ligado', 'doutor-hernia-caxias': 'seco' }),
    agora: AGORA,
    registrar: c.registrar,
  });
  assert.deepEqual(c.gravados, [{ id: 1, nome: 'Ana Paula 26/10/26' }], 'só o de Petrópolis grava');
  assert.deepEqual(c.simulados.map((s) => [s.leadId, s.slug]), [[2, 'doutor-hernia-caxias'], [3, 'doutor-hernia-petropolis']], 'Caxias e o sem unidade ficam no papel');
  assert.equal(r?.gravados, 1);

  const d = cenario([{ id: 1, nome: SEM_NOME(1), contato: 11, unidade: 'Caxias' }], { 11: 'Ana Paula' });
  const r2 = await renomearConta({ unit, membros: [PETRO, CAXIAS], kommo: d.kommo, estadoDe: estados({ 'doutor-hernia-petropolis': 'ligado' }), agora: AGORA, registrar: d.registrar });
  assert.deepEqual(d.gravados, []);
  assert.equal(r2?.desligados, 1);
});

test('tudo desligado: nem lê o Kommo', async () => {
  let chamou = false;
  const kommo = { listLeadsNaJanela: async () => { chamou = true; return { leads: [], truncado: false }; } } as unknown as KommoDoRenomear;
  const r = await renomearConta({ unit, membros: [PETRO, CAXIAS], kommo, estadoDe: estados({}), agora: AGORA });
  assert.equal(r, null);
  assert.equal(chamou, false);
});

test('lista cortada (truncada): não renomeia nada — numeração do dia ficaria errada', async () => {
  const c = cenario([{ id: 1, nome: SEM_NOME(1), contato: 11 }], { 11: 'Ana Paula' });
  c.kommo.listLeadsNaJanela = (async () => ({ leads: [], truncado: true })) as never;
  const r = await renomearConta({ unit, membros: null, kommo: c.kommo, estadoDe: estados({ [unit.slug]: 'ligado' }), agora: AGORA, registrar: c.registrar });
  assert.equal(r, null);
  assert.deepEqual(c.gravados, []);
});

test('contato que não veio na leitura NÃO vira "Lead" logo: espera a próxima rodada', async () => {
  const c = cenario([{ id: 1, nome: SEM_NOME(1), contato: 11, minutosDeVida: 10 }], {}); // contatosBasicos devolve mapa vazio
  await renomearConta({ unit, membros: null, kommo: c.kommo, estadoDe: estados({ [unit.slug]: 'ligado' }), agora: AGORA, registrar: c.registrar });
  assert.deepEqual(c.gravados, []);
});

test('o teto de 50 conta só gravações: leads de unidade desligada não tomam a vaga dos da ligada', async () => {
  const cartoes: Cartao[] = [];
  const contatos: Record<number, string> = {};
  for (let i = 1; i <= 60; i++) { cartoes.push({ id: i, nome: SEM_NOME(i), contato: 100 + i, unidade: 'Caxias', minutosDeVida: 600 }); contatos[100 + i] = 'Ana Paula'; }
  cartoes.push({ id: 999, nome: SEM_NOME(999), contato: 999, unidade: 'Petrópolis', minutosDeVida: 5 });
  contatos[999] = 'Zélia Souza';
  const c = cenario(cartoes, contatos);
  await renomearConta({ unit, membros: [PETRO, CAXIAS], kommo: c.kommo, estadoDe: estados({ 'doutor-hernia-petropolis': 'ligado' }), agora: AGORA, registrar: c.registrar });
  assert.deepEqual(c.gravados, [{ id: 999, nome: 'Zélia Souza 26/10/26' }]);
});

test('contato que sumiu (apagado/mesclado): espera 30 min e então vira "Lead dd/mm/aa", sem ficar "Lead #123" para sempre', async () => {
  const novo = cenario([{ id: 1, nome: SEM_NOME(1), contato: 11, minutosDeVida: 10 }], {});
  await renomearConta({ unit, membros: null, kommo: novo.kommo, estadoDe: estados({ [unit.slug]: 'ligado' }), agora: AGORA, registrar: novo.registrar });
  assert.deepEqual(novo.gravados, []);
  const velho = cenario([{ id: 1, nome: SEM_NOME(1), contato: 11, minutosDeVida: 45 }], {});
  await renomearConta({ unit, membros: null, kommo: velho.kommo, estadoDe: estados({ [unit.slug]: 'ligado' }), agora: AGORA, registrar: velho.registrar });
  assert.deepEqual(velho.gravados, [{ id: 1, nome: 'Lead 26/10/26' }]);
});

test('falha ao gravar: segue para os outros e para depois de 3 falhas seguidas', async () => {
  const c = cenario(
    [1, 2, 3, 4, 5].map((i) => ({ id: i, nome: SEM_NOME(i), contato: 10 + i })),
    { 11: 'Ana Paula', 12: 'Bia Souza', 13: 'Célia Dias', 14: 'Dora Lima', 15: 'Eva Reis' },
  );
  c.kommo.updateLeadName = (async () => { throw new Error('429'); }) as never;
  const r = await renomearConta({ unit, membros: null, kommo: c.kommo, estadoDe: estados({ [unit.slug]: 'ligado' }), agora: AGORA, registrar: c.registrar });
  assert.equal(r?.erros, 3);
  assert.equal(r?.gravados, 0);
});

// ── título genérico do titulo-padrao, franquia e estoque (16/11/2026) ────────────────────────────────────────

const DIA = 24 * 60; // minutos
// unidades LISTADAS em RENOMEAR_LEAD_DESDE (o trabalho novo só vale nelas); 26/10 = hoje no cenário, então a janela segue sendo as 24 h
const LISTADA = 'doutor-hernia-petropolis=2026-10-26,doutor-hernia-caxias=2026-10-26';
const franquiaFalsa = (resp: Record<string, NomesNaFranquia>, chamadas: string[] = []) => async (_q: { id: string; slug: string }, tel: string | null): Promise<NomesNaFranquia> => {
  chamadas.push(String(tel));
  return resp[String(tel)] ?? { tipo: 'nenhum' };
};

test('rodada LIGADA: o "Lead N dd/mm/aaaa" do titulo-padrao vira o nome; franquia vence contato; dois pacientes não usa franquia; sem nome fica', async () => {
  _limparParaTeste();
  const c = cenario(
    [
      { id: 1, nome: 'Lead 26/10/2026', contato: 11 }, // contato com nome de pessoa
      { id: 2, nome: 'Lead 2 26/10/2026', contato: 12 }, // franquia confere com o contato → nome inteiro
      { id: 3, nome: 'Lead 3 26/10/2026', contato: 13 }, // mãe e filha no mesmo número
      { id: 4, nome: 'Lead 4 26/10/2026', contato: 14 }, // contato não é nome de pessoa e franquia não conhece
      { id: 5, nome: 'Simone Katia 26/10/26', contato: 15 }, // a SDR já nomeou: intocado
    ],
    { 11: 'Bia Souza', 12: 'Alex Sandre', 13: 'Maria Souza', 14: 'Deus é Deus', 15: 'Outra Pessoa' },
    { telefones: { 11: '5524990000011', 12: '5524990000012', 13: '5524990000013', 14: '5524990000014', 15: '5524990000015' } },
  );
  const franquia = franquiaFalsa({
    '5524990000012': { tipo: 'pacientes', nomes: ['ALEX SANDRE'] },
    '5524990000013': { tipo: 'pacientes', nomes: ['Maria Souza', 'Júlia Souza'] },
  });
  const r = await renomearConta({ desde: LISTADA, unit, membros: null, kommo: c.kommo, estadoDe: estados({ [unit.slug]: 'ligado' }), agora: AGORA, registrar: c.registrar, franquia });
  assert.deepEqual(c.gravados, [
    { id: 1, nome: 'Bia Souza 26/10/26' },
    { id: 2, nome: 'Alex Sandre 26/10/26' },
    { id: 3, nome: 'Maria Souza 26/10/26' },
  ]);
  assert.equal(r?.gravados, 3);
  assert.equal(r?.semNomeParaDar, 1, 'o 4 fica "Lead 4 26/10/2026": nunca genérico por genérico');
});

test('rodada em SECO: mostra "gravaria" com a fonte, "pularia" para o que fica genérico, e não escreve nada', async () => {
  _limparParaTeste();
  const c = cenario(
    [
      { id: 1, nome: 'Lead 26/10/2026', contato: 11 },
      { id: 2, nome: 'Lead 2 26/10/2026', contato: 12 },
    ],
    { 11: 'Alex Sandre', 12: '-' },
    { telefones: { 11: '5524990000011' } },
  );
  const sim: Array<{ leadId: number; acao: string; valor: unknown; noCartao: unknown; motivo: unknown }> = [];
  const registrar = ((_u: unknown, _a: string, s: { leadId: number; acao: string; valor: unknown; noCartao: unknown; motivo: unknown }) => { sim.push(s); }) as never;
  const franquia = franquiaFalsa({ '5524990000011': { tipo: 'pacientes', nomes: ['ALEX SANDRE SILVA'] } });
  const r = await renomearConta({ desde: LISTADA, unit, membros: null, kommo: c.kommo, estadoDe: estados({ [unit.slug]: 'seco' }), agora: AGORA, registrar, franquia });
  assert.deepEqual(c.gravados, []);
  assert.deepEqual(c.lidos, []);
  assert.equal(r?.simulados, 1);
  assert.equal(r?.semNomeParaDar, 1);
  assert.deepEqual(sim.map((s) => [s.leadId, s.acao, s.valor, s.noCartao]), [
    [1, 'gravaria', 'Alex Sandre Silva 26/10/26', 'Lead 26/10/2026'],
    [2, 'pularia', 'Lead 2 26/10/2026', 'Lead 2 26/10/2026'],
  ]);
  assert.match(String(sim[0].motivo), /fonte: franquia\]/);
});

test('franquia sem resposta: espera algumas rodadas (a franquia completa o sobrenome) e depois segue com o nome do contato — nunca trava para sempre', async () => {
  _limparParaTeste();
  const fora = async (): Promise<NomesNaFranquia> => { throw new Error('franquia fora do ar'); };
  const c = cenario([{ id: 1, nome: 'Lead 26/10/2026', contato: 11 }], { 11: 'Bia Souza' }, { telefones: { 11: '5524990000011' } });
  const rodar = (franquia: typeof fora) => renomearConta({ desde: LISTADA, unit, membros: null, kommo: c.kommo, estadoDe: estados({ [unit.slug]: 'ligado' }), agora: AGORA, registrar: c.registrar, franquia });
  const r = await rodar(fora);
  assert.deepEqual(c.gravados, []);
  assert.equal(r?.adiados, 1);
  for (let i = 0; i < 5; i++) await rodar(fora); // 6 esperas no total
  assert.deepEqual(c.gravados, []);
  const r7 = await rodar(fora); // a sétima segue sem a franquia
  assert.deepEqual(c.gravados, [{ id: 1, nome: 'Bia Souza 26/10/26' }]);
  assert.equal(r7?.gravados, 1);

  // e se a franquia volta antes do limite, o nome vem dela
  _limparParaTeste();
  const d = cenario([{ id: 2, nome: 'Lead 26/10/2026', contato: 12 }], { 12: 'Alex Sandre' }, { telefones: { 12: '5524990000012' } });
  await renomearConta({ desde: LISTADA, unit, membros: null, kommo: d.kommo, estadoDe: estados({ [unit.slug]: 'ligado' }), agora: AGORA, registrar: d.registrar, franquia: fora });
  // (a falha fica guardada 10 min: uma ficha que falha sempre não repete a mesma chamada a cada rodada)
  await renomearConta({ desde: LISTADA, unit, membros: null, kommo: d.kommo, estadoDe: estados({ [unit.slug]: 'ligado' }), agora: AGORA + 11 * 60, registrar: d.registrar, franquia: franquiaFalsa({ '5524990000012': { tipo: 'pacientes', nomes: ['Alex Sandre Silva'] } }) });
  assert.deepEqual(d.gravados, [{ id: 2, nome: 'Alex Sandre Silva 26/10/26' }]);
});

test('contato sem nome de pessoa não gasta consulta à franquia (ela seria posta de lado de qualquer jeito)', async () => {
  _limparParaTeste();
  const chamadas: string[] = [];
  const c = cenario([{ id: 1, nome: 'Lead 26/10/2026', contato: 11 }, { id: 2, nome: 'Lead 2 26/10/2026', contato: 12 }], { 11: '🙏', 12: 'Bia Souza' }, { telefones: { 11: '5524990000011', 12: '5524990000012' } });
  await renomearConta({ desde: LISTADA, unit, membros: null, kommo: c.kommo, estadoDe: estados({ [unit.slug]: 'ligado' }), agora: AGORA, registrar: c.registrar, franquia: franquiaFalsa({}, chamadas) });
  assert.deepEqual(chamadas, ['5524990000012']);
  assert.deepEqual(c.gravados, [{ id: 2, nome: 'Bia Souza 26/10/26' }]);
});

test('o título provisório do titulo-padrao espera 30 min (a Sofia tem a vez); o "Lead #123" do Kommo só 3', async () => {
  _limparParaTeste();
  const c = cenario(
    [
      { id: 1, nome: 'Lead 26/10/2026', contato: 11, minutosDeVida: 10 },
      { id: 2, nome: 'Lead #2', contato: 12, minutosDeVida: 10 },
      { id: 3, nome: 'Lead 2 26/10/2026', contato: 13, minutosDeVida: 31 },
    ],
    { 11: 'Ana Paula', 12: 'Bia Souza', 13: 'Célia Dias' },
  );
  await renomearConta({ desde: LISTADA, unit, membros: null, kommo: c.kommo, estadoDe: estados({ [unit.slug]: 'ligado' }), agora: AGORA, registrar: c.registrar });
  assert.deepEqual(c.gravados.map((g) => g.id).sort(), [2, 3]);
});

test('garantirIndice: pede o índice da franquia só das unidades com a chave em seco ou ligada', async () => {
  _limparParaTeste();
  const pedidos: string[] = [];
  const c = cenario([], {});
  await renomearConta({ desde: LISTADA,
    unit, membros: [PETRO, CAXIAS], kommo: c.kommo, agora: AGORA, registrar: c.registrar, garantirIndice: (q) => { pedidos.push(q.slug); },
    estadoDe: estados({ 'doutor-hernia-petropolis': 'seco' }),
  });
  assert.deepEqual(pedidos, ['doutor-hernia-petropolis']);
});

test('a resposta da franquia fica guardada: o mesmo telefone não consulta de novo na rodada seguinte', async () => {
  _limparParaTeste();
  const chamadas: string[] = [];
  const mk = () => cenario([{ id: 1, nome: 'Lead 26/10/2026', contato: 11 }], { 11: 'Bia Souza' }, { telefones: { 11: '5524990000011' } });
  const franquia = franquiaFalsa({}, chamadas);
  await renomearConta({ desde: LISTADA, unit, membros: null, kommo: mk().kommo, estadoDe: estados({ [unit.slug]: 'seco' }), agora: AGORA, registrar: (() => undefined) as never, franquia });
  await renomearConta({ desde: LISTADA, unit, membros: null, kommo: mk().kommo, estadoDe: estados({ [unit.slug]: 'seco' }), agora: AGORA, registrar: (() => undefined) as never, franquia });
  assert.equal(chamadas.length, 1);
});

test('conta dividida: cartão SEM unidade não consulta a franquia (não se sabe qual olhar)', async () => {
  _limparParaTeste();
  const chamadas: string[] = [];
  const c = cenario(
    [
      { id: 1, nome: 'Lead 26/10/2026', contato: 11, unidade: 'Petrópolis' },
      { id: 2, nome: 'Lead 2 26/10/2026', contato: 12 },
    ],
    { 11: 'Ana Paula', 12: 'Bia Souza' },
    { telefones: { 11: '5524990000011', 12: '5524990000012' } },
  );
  await renomearConta({ desde: LISTADA,
    unit, membros: [PETRO, CAXIAS], kommo: c.kommo, agora: AGORA, registrar: c.registrar, franquia: franquiaFalsa({}, chamadas),
    estadoDe: estados({ 'doutor-hernia-petropolis': 'ligado', 'doutor-hernia-caxias': 'ligado' }),
  });
  assert.deepEqual(chamadas, ['5524990000011']);
  assert.deepEqual(c.gravados, [{ id: 1, nome: 'Ana Paula 26/10/26' }, { id: 2, nome: 'Bia Souza 26/10/26' }]);
});

test('estoque: sem RENOMEAR_LEAD_DESDE só vale 24 h; com a data, alcança os abertos desde aquele dia e nunca os fechados', async () => {
  _limparParaTeste();
  const cartoes: Cartao[] = [
    { id: 1, nome: 'Lead 24/10/2026', contato: 11, minutosDeVida: 2 * DIA + 60 }, // 24/10 13h em Brasília: dentro de "desde 24/10"
    { id: 2, nome: 'Lead 2 23/10/2026', contato: 12, minutosDeVida: 3 * DIA + 60 }, // 23/10: antes do dia pedido
    { id: 3, nome: 'Lead 3 24/10/2026', contato: 13, minutosDeVida: 2 * DIA + 120, status: 143 }, // fechado
    { id: 4, nome: 'Lead 26/10/2026', contato: 14, minutosDeVida: 30 }, // recente
  ];
  const nomes = { 11: 'Ana Paula', 12: 'Bia Souza', 13: 'Célia Dias', 14: 'Dora Lima' };
  const padrao = cenario(cartoes, nomes);
  await renomearConta({ desde: LISTADA, unit, membros: null, kommo: padrao.kommo, estadoDe: estados({ [unit.slug]: 'ligado' }), agora: AGORA, registrar: padrao.registrar, pausaMs: 0 });
  assert.deepEqual(padrao.gravados, [{ id: 4, nome: 'Dora Lima 26/10/26' }], 'padrão: só as últimas 24 h');

  const c = cenario(cartoes, nomes);
  const r = await renomearConta({ unit, membros: null, kommo: c.kommo, estadoDe: estados({ [unit.slug]: 'ligado' }), agora: AGORA, registrar: c.registrar, pausaMs: 0, desde: `${unit.slug}=2026-10-24` });
  assert.deepEqual(c.gravados.map((g) => g.id).sort(), [1, 4]);
  assert.equal(c.gravados.find((g) => g.id === 1)?.nome, 'Ana Paula 24/10/26', 'a data do nome é a da criação do cartão, não a de hoje');
  assert.equal(r?.foraDaJanela, 1, 'o fechado; o de 23/10 nem entra na leitura');

  // só outra unidade na lista: esta NÃO está listada, então nada do trabalho novo (nem estoque, nem o título do titulo-padrao)
  const o = cenario(cartoes, nomes);
  await renomearConta({ unit, membros: null, kommo: o.kommo, estadoDe: estados({ [unit.slug]: 'ligado' }), agora: AGORA, registrar: o.registrar, pausaMs: 0, desde: 'doutor-hernia-caxias=2026-10-24' });
  assert.deepEqual(o.gravados, []);
});

test('UNIDADE FORA DE RENOMEAR_LEAD_DESDE (ou variável vazia): comportamento da main — só "Lead #N", sem franquia, sem índice, sem estoque, mesmos textos', async () => {
  for (const desde of [undefined, '', 'outra-unidade=2026-10-01', `${unit.slug}=ontem`]) {
    _limparParaTeste();
    const chamouFranquia: string[] = [];
    const indices: string[] = [];
    const c = cenario(
      [
        { id: 1, nome: 'Lead 26/10/2026', contato: 11 }, // titulo-padrao: NÃO é "sem nome" fora da lista
        { id: 2, nome: 'Lead 2 26/10/2026', contato: 12 },
        { id: 3, nome: 'Lead 26/10/26', contato: 13 },
        { id: 4, nome: 'Lead #4', contato: 14, minutosDeVida: 5 }, // este sim, e aos 5 min
        { id: 5, nome: 'Lead #5', contato: 15, minutosDeVida: 2 * DIA }, // estoque: ninguém pediu
        { id: 6, nome: 'Lead #6', contato: 16 },
      ],
      { 11: 'Ana Paula', 12: 'Bia Souza', 13: 'Célia Dias', 14: 'Alex Sandre', 15: 'Eva Reis', 16: '-' },
      { telefones: { 14: '5524990000014' } },
    );
    const sim: Array<{ valor: unknown; motivo: unknown }> = [];
    const registrar = ((_u: unknown, _a: string, s: { valor: unknown; motivo: unknown }) => { sim.push(s); }) as never;
    const franquia = async (_q: unknown, tel: string | null): Promise<NomesNaFranquia> => { chamouFranquia.push(String(tel)); return { tipo: 'pacientes', nomes: ['Alex Sandre Silva'] }; };
    const r = await renomearConta({ unit, membros: null, kommo: c.kommo, estadoDe: estados({ [unit.slug]: 'ligado' }), agora: AGORA, registrar, desde, franquia, garantirIndice: (q) => { indices.push(q.slug); } });
    assert.deepEqual(c.gravados, [{ id: 6, nome: 'Lead 2 26/10/26' }, { id: 4, nome: 'Alex Sandre 26/10/26' }], `desde=${String(desde)}`);
    assert.deepEqual(chamouFranquia, [], 'nenhuma consulta à franquia');
    assert.deepEqual(indices, [], 'nenhum pedido de carga do índice da franquia');
    assert.equal(r?.candidatos, 2, 'só os dois "Lead #N" recentes são candidatos');
    assert.equal(r?.semNomeParaDar, 0);

    // seco: mesmos textos de antes (sem "[fonte: …]")
    const s = cenario([{ id: 4, nome: 'Lead #4', contato: 14, minutosDeVida: 5 }], { 14: 'Alex Sandre' });
    await renomearConta({ unit, membros: null, kommo: s.kommo, estadoDe: estados({ [unit.slug]: 'seco' }), agora: AGORA, registrar, desde });
    assert.deepEqual(sim[sim.length - 1], { acao: 'gravaria', alvo: 'Nome do cartão', valor: 'Alex Sandre 26/10/26', noCartao: 'Lead #4', motivo: 'nome do contato', leadId: 4 });
  }
});

test('nomesNaFranquiaPadrao: paciente apagado e índice velho/nunca montado caem na hora no contato; só ficha COM ERRO é "sem resposta"', async () => {
  const Q = { id: 'u1', slug: 'x' };
  const TEL = '5524990000011';
  const base = (o: Partial<DepsDaFranquia>): DepsDaFranquia => ({
    unidade: async () => ({ id: 'u1', spineEnabled: true, spineToken: 't' }),
    indice: async () => ({ entradas: [{ origem: 'paciente', id: 77 }] }),
    ficha: async () => ({ ok: true, client: { name: 'Alex Sandre Silva', whatsapp: TEL } }),
    ...o,
  });
  assert.deepEqual(await nomesNaFranquiaPadrao(Q, TEL, base({})), { tipo: 'pacientes', nomes: ['Alex Sandre Silva'] });
  // paciente apagado na franquia (a ficha vem ok, sem cliente): não é "sem resposta"
  assert.deepEqual(await nomesNaFranquiaPadrao(Q, TEL, base({ ficha: async () => ({ ok: true, client: null }) })), { tipo: 'nenhum' });
  // índice nunca montado / velho e sem o telefone: não segura o cartão
  assert.deepEqual(await nomesNaFranquiaPadrao(Q, TEL, base({ indice: async () => ({ entradas: [] }) })), { tipo: 'nenhum' });
  // a ficha ERROU: aí sim, sem resposta
  assert.equal((await nomesNaFranquiaPadrao(Q, TEL, base({ ficha: async () => ({ ok: false, client: null }) }))).tipo, 'indisponivel');
  // id do índice que é de outro telefone, unidade sem franquia, telefone ilegível
  assert.deepEqual(await nomesNaFranquiaPadrao(Q, TEL, base({ ficha: async () => ({ ok: true, client: { name: 'Outro', whatsapp: '5524990009999' } }) })), { tipo: 'nenhum' });
  assert.deepEqual(await nomesNaFranquiaPadrao(Q, TEL, base({ unidade: async () => ({ id: 'u1', spineEnabled: false, spineToken: null }) })), { tipo: 'nenhum' });
  assert.deepEqual(await nomesNaFranquiaPadrao(Q, 'abc', base({})), { tipo: 'nenhum' });
});

test('unidade listada com a data VELHA (passou de 30 dias): segue renomeando o título do titulo-padrao, só não alcança o estoque', async () => {
  _limparParaTeste();
  const c = cenario(
    [
      { id: 1, nome: 'Lead 26/10/2026', contato: 11 },
      { id: 2, nome: 'Lead 20/10/2026', contato: 12, minutosDeVida: 6 * DIA },
    ],
    { 11: 'Bia Souza', 12: 'Célia Dias' },
  );
  await renomearConta({ desde: `${unit.slug}=2026-01-01`, unit, membros: null, kommo: c.kommo, estadoDe: estados({ [unit.slug]: 'ligado' }), agora: AGORA, registrar: c.registrar, pausaMs: 0 });
  assert.deepEqual(c.gravados, [{ id: 1, nome: 'Bia Souza 26/10/26' }]);
});

test('título genérico cujo contato sumiu: marca e não pede o contato de novo na hora seguinte (volta depois de 1 h)', async () => {
  _limparParaTeste();
  let lidos = 0;
  const c = cenario([{ id: 1, nome: 'Lead 26/10/2026', contato: 11, minutosDeVida: 45 }], {}); // contatosBasicos devolve vazio
  const original = c.kommo.contatosBasicos;
  c.kommo.contatosBasicos = (async (ids: number[]) => { lidos++; return original(ids); }) as never;
  const rodar = (agora: number) => renomearConta({ desde: LISTADA, unit, membros: null, kommo: c.kommo, estadoDe: estados({ [unit.slug]: 'ligado' }), agora, registrar: c.registrar });
  const r1 = await rodar(AGORA);
  assert.equal(r1?.semContato, 1);
  await rodar(AGORA + 5 * 60);
  assert.equal(lidos, 1, 'a rodada seguinte nem leu o contato');
  await rodar(AGORA + 61 * 60);
  assert.equal(lidos, 2);
  assert.deepEqual(c.gravados, []);
});

test('estoque: no máximo 15 gravações por rodada (sem fazer o recente esperar) e o resto fica para a rodada seguinte', async () => {
  _limparParaTeste();
  const cartoes: Cartao[] = [];
  const nomes: Record<number, string> = {};
  for (let i = 1; i <= 40; i++) { cartoes.push({ id: i, nome: `Lead ${i} 24/10/2026`, contato: 100 + i, minutosDeVida: 2 * DIA }); nomes[100 + i] = 'Ana Paula'; }
  cartoes.push({ id: 999, nome: 'Lead 26/10/2026', contato: 999, minutosDeVida: 40 });
  nomes[999] = 'Zélia Souza';
  const c = cenario(cartoes, nomes);
  const r = await renomearConta({ unit, membros: null, kommo: c.kommo, estadoDe: estados({ [unit.slug]: 'ligado' }), agora: AGORA, registrar: c.registrar, pausaMs: 0, desde: `${unit.slug}=2026-10-20` });
  assert.equal(c.gravados.filter((g) => g.id !== 999).length, 15);
  assert.ok(c.gravados.some((g) => g.id === 999), 'o cartão novo não fica atrás do estoque');
  assert.equal(r?.adiados, 25);
});

test('a janela do estoque estoura o teto de leitura: volta às 24 h em vez de derrubar o caminho normal', async () => {
  _limparParaTeste();
  const c = cenario(
    [
      { id: 1, nome: 'Lead 24/10/2026', contato: 11, minutosDeVida: 2 * DIA },
      { id: 2, nome: 'Lead 26/10/2026', contato: 12, minutosDeVida: 30 },
    ],
    { 11: 'Ana Paula', 12: 'Bia Souza' },
  );
  const leituras: number[] = [];
  const lista = c.kommo.listLeadsNaJanela;
  c.kommo.listLeadsNaJanela = (async (campo: 'created_at', de: number, ate: number, ...resto: unknown[]) => {
    leituras.push(de);
    return leituras.length === 1 ? { leads: [], truncado: true } : (lista as unknown as (...a: unknown[]) => Promise<unknown>)(campo, de, ate, ...resto);
  }) as never;
  const r = await renomearConta({ unit, membros: null, kommo: c.kommo, estadoDe: estados({ [unit.slug]: 'ligado' }), agora: AGORA, registrar: c.registrar, pausaMs: 0, desde: `${unit.slug}=2026-10-20` });
  assert.equal(leituras.length, 2);
  assert.ok(leituras[1] > leituras[0], 'a segunda leitura começa mais tarde (24 h + folga)');
  assert.deepEqual(c.gravados, [{ id: 2, nome: 'Bia Souza 26/10/26' }], 'só o recente; o estoque espera a janela caber');
  assert.equal(r?.gravados, 1);
  // e lembra por uma hora: a rodada seguinte já lê só as 24 h (não relê 8 páginas à toa)
  await renomearConta({ unit, membros: null, kommo: c.kommo, estadoDe: estados({ [unit.slug]: 'ligado' }), agora: AGORA + 300, registrar: c.registrar, pausaMs: 0, desde: `${unit.slug}=2026-10-20` });
  assert.equal(leituras.length, 3);
  assert.equal(leituras[2], leituras[1] + 300);
});

test('genérico sem nome em nenhuma fonte: não gasta contato nem franquia de novo na hora seguinte', async () => {
  _limparParaTeste();
  let contatosLidos = 0;
  const c = cenario([{ id: 1, nome: 'Lead 26/10/2026', contato: 11 }], { 11: '-' });
  const original = c.kommo.contatosBasicos;
  c.kommo.contatosBasicos = (async (ids: number[]) => { contatosLidos++; return original(ids); }) as never;
  const rodar = (agora: number) => renomearConta({ desde: LISTADA, unit, membros: null, kommo: c.kommo, estadoDe: estados({ [unit.slug]: 'ligado' }), agora, registrar: c.registrar });
  const r1 = await rodar(AGORA);
  assert.equal(r1?.semNomeParaDar, 1);
  await rodar(AGORA + 5 * 60);
  assert.equal(contatosLidos, 1, 'a segunda rodada nem leu o contato');
  await rodar(AGORA + 61 * 60);
  assert.equal(contatosLidos, 2, 'passada uma hora olha de novo (o contato pode ter ganhado nome)');
  assert.deepEqual(c.gravados, []);
});

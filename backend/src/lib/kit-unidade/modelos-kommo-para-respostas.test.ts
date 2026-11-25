import { test } from 'node:test';
import assert from 'node:assert/strict';
import { atalhoDoNome, importar, planejarImportacao, relatorio, textoParaOCrm, type Portas } from './modelos-kommo-para-respostas.js';
import type { KommoChatTemplate } from '../../services/kommo.service.js';

const CAMPOS: Record<number, string> = { 385924: '◷ Data da Consulta' };
const nomeDoCampo = (id: number) => CAMPOS[id] ?? null;

const modelos: KommoChatTemplate[] = [
  { id: 1, name: '⚡ Lead primeiro contato', type: 'amocrm', content: 'Olá, {{contact.name}}. Aqui é da clínica.' },
  { id: 2, name: '⚡ Consulta prepagamento pendente', type: 'amocrm', content: 'Olá, {{contact.name}}. O horário de {{lead.cf.385924}} segue reservado. {{lead.cf.999}}' },
  { id: 3, name: '⚡ Cancelamento acolhimento', type: 'waba', content: 'modelo da Meta: fica de fora' },
  { id: 4, name: '⚡ Sem texto', type: 'amocrm', content: '   ' },
];

test('atalho: sem emoji, sem acento, minúsculas, hífen', () => {
  assert.equal(atalhoDoNome('⚡ Consulta pós-atendimento (Açaí)'), 'consulta-pos-atendimento-acai');
  assert.equal(atalhoDoNome('⚡ 01 Primeira saudação'), '01-primeira-saudacao');
  assert.equal(atalhoDoNome('⚡'), '');
});

test('texto: contact.name vira first_name; o resto fica', () => {
  assert.equal(textoParaOCrm('Oi, {{contact.name}}! {{ contact.first_name }}'), 'Oi, {{contact.first_name}}! {{contact.first_name}}');
});

test('plano: só texto livre com texto; waba e vazio ficam de fora; campo do cartão vira [Nome]', () => {
  const l = planejarImportacao(modelos, nomeDoCampo, [], 'timbocrm_');
  assert.deepEqual(l.map((x) => x.atalho), ['timbocrm-consulta-prepagamento-pendente', 'timbocrm-lead-primeiro-contato']);
  const pre = l[0]!;
  assert.match(pre.texto, /^Olá, \{\{contact\.first_name\}\}\. O horário de \[◷ Data da Consulta\] segue reservado\. \[campo do cartão\]$/);
  assert.deepEqual(pre.avisos, ['lead.cf.999']);
  assert.ok(l.every((x) => x.situacao === 'criar'));
});

test('plano: casa pelo atalho — igual = já existe; texto diferente = divergente (nunca sobrescreve)', () => {
  const base = planejarImportacao(modelos, nomeDoCampo, [], 'timbocrm');
  const existentes = [
    { short_code: base[1]!.atalho, content: base[1]!.texto },
    { short_code: base[0]!.atalho, content: 'a equipe editou isto' },
  ];
  const l = planejarImportacao(modelos, nomeDoCampo, existentes, 'timbocrm');
  assert.deepEqual(l.map((x) => x.situacao), ['divergente', 'ja-existe']);
});

test('plano: dois modelos com o mesmo atalho ganham -2 (estável)', () => {
  const dois: KommoChatTemplate[] = [
    { id: 10, name: '⚡ Retorno', type: 'amocrm', content: 'a' },
    { id: 11, name: 'Retorno!', type: 'amocrm', content: 'b' },
  ];
  const l = planejarImportacao(dois, nomeDoCampo, [], 'x_');
  assert.equal(new Set(l.map((x) => x.atalho)).size, 2);
  assert.ok(l.every((x) => /^x-retorno(-2)?$/.test(x.atalho)));
});

function portasFalsas(existentes: Array<{ short_code: string; content: string }>) {
  const criados: Array<[string, string]> = [];
  const portas: Portas = {
    modelosDoKommo: async () => modelos,
    nomeDoCampo: async () => nomeDoCampo,
    respostasDoCrm: async () => existentes,
    criarNoCrm: async (a, t) => {
      criados.push([a, t]);
    },
  };
  return { portas, criados };
}

test('--so-conferir (padrão): NÃO escreve nada, nem os que faltam', async () => {
  const { portas, criados } = portasFalsas([]);
  const r = await importar(portas, 'timbocrm_', false);
  assert.equal(criados.length, 0);
  assert.equal(r.criadas.length, 0);
  assert.equal(r.linhas.filter((x) => x.situacao === 'criar').length, 2);
  assert.match(relatorio(r, false).join('\n'), /SÓ CONFERIR: nada foi escrito/);
});

test('--aplicar: cria só os que faltam e, rodando de novo, não duplica', async () => {
  const existentes: Array<{ short_code: string; content: string }> = [];
  const { portas, criados } = portasFalsas(existentes);
  portas.criarNoCrm = async (a, t) => {
    criados.push([a, t]);
    existentes.push({ short_code: a, content: t });
  };
  const r1 = await importar(portas, 'timbocrm_', true);
  assert.equal(r1.criadas.length, 2);
  const r2 = await importar(portas, 'timbocrm_', true);
  assert.equal(r2.criadas.length, 0);
  assert.equal(criados.length, 2);
  assert.ok(r2.linhas.every((x) => x.situacao === 'ja-existe'));
});

test('--aplicar: uma falha não derruba as outras e fica no relatório', async () => {
  const { portas } = portasFalsas([]);
  portas.criarNoCrm = async (a) => {
    if (a.includes('lead')) throw new Error('422 Short code has already been taken');
  };
  const r = await importar(portas, 'timbocrm_', true);
  assert.equal(r.criadas.length, 1);
  assert.equal(r.falhas.length, 1);
  assert.match(relatorio(r, true).join('\n'), /FALHOU/);
});

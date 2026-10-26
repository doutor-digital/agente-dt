// Testa o montador de nós (aplicar-v3.mjs) contra um workflow no molde dos 18 do n8n. Não toca em n8n nem Meta.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const aqui = path.dirname(fileURLToPath(import.meta.url));

import { workflow } from './fixture-workflow.mjs';

function aplicar(wf, env = {}) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'capi-v3-'));
  fs.writeFileSync(path.join(d, 'wf.json'), JSON.stringify(wf));
  const r = spawnSync(process.execPath, [path.join(aqui, 'aplicar-v3.mjs')], {
    env: { PATH: process.env.PATH, WF_JSON: path.join(d, 'wf.json'), OUT_JSON: path.join(d, 'out.json'), DIR: aqui, ...env },
    encoding: 'utf8',
  });
  const nodes = r.status === 0 ? JSON.parse(fs.readFileSync(path.join(d, 'out.json'), 'utf8')) : null;
  return { ...r, nodes, d };
}
const no = (nodes, nome) => nodes.find((n) => n.name === nome).parameters;

test('aplicar: sem flags a unidade fica DESLIGADA nos dois recursos e o resto da cfg v2 sobrevive', () => {
  const r = aplicar(workflow());
  assert.equal(r.status, 0, r.stderr);
  const cfg = no(r.nodes, 'Config').jsCode;
  assert.match(cfg, /pediuHorario: \{"modo":"desligado","tag":"IA · Pediu horário"/);
  assert.match(cfg, /status: \{"modo":"desligado","pageId":""\}/);
  assert.match(cfg, /cadeia: \{"142"/, 'a cadeia da v2 continua');
  assert.match(cfg, /preAgendado: \["106820083"/);
  assert.equal(no(r.nodes, 'Classificar etapa').jsCode, fs.readFileSync(path.join(aqui, 'classificar-etapa.v3.js'), 'utf8'));
  assert.equal(no(r.nodes, 'Montar evento').jsCode, fs.readFileSync(path.join(aqui, 'montar-evento.v3.js'), 'utf8'));
  assert.equal(no(r.nodes, 'Reservar envio').query, fs.readFileSync(path.join(aqui, 'reservar-envio.v3.sql'), 'utf8'));
  assert.match(no(r.nodes, 'Buscar telefone e nome').options.queryReplacement, /cfg\.unidade/);
});

test('aplicar: o IF do modo teste passa a olhar o _seco do item, sem perder o dryRun global', () => {
  const r = aplicar(workflow());
  const e = no(r.nodes, 'Modo teste (nao chama a Meta)?').conditions.conditions[0].leftValue;
  assert.match(e, /cfg\.dryRun === true/);
  assert.match(e, /\$json\._seco === true/);
});

test('aplicar: o reenvio do relógio ganha "ctwa_clid IS NOT NULL", uma vez só (idempotente)', () => {
  const r1 = aplicar(workflow());
  const q1 = no(r1.nodes, 'Cliques e reenvios').query;
  assert.equal((q1.match(/v\.ctwa_clid IS NOT NULL/g) || []).length, 1);
  const r2 = aplicar({ ...workflow(), nodes: r1.nodes });
  assert.equal((no(r2.nodes, 'Cliques e reenvios').query.match(/v\.ctwa_clid IS NOT NULL/g) || []).length, 1);
});

test('aplicar: rodar de novo PRESERVA os modos já ligados e troca o bloco em vez de empilhar', () => {
  const r1 = aplicar(workflow(), { PEDIU_MODO: 'seco', STATUS_MODO: 'seco', PAGE_ID: '123456789012345' });
  assert.equal(r1.status, 0, r1.stderr);
  const r2 = aplicar({ ...workflow(), nodes: r1.nodes }); // sem flags: não pode desligar o que o João ligou
  const cfg = no(r2.nodes, 'Config').jsCode;
  assert.match(cfg, /pediuHorario: \{"modo":"seco"/);
  assert.match(cfg, /status: \{"modo":"seco","pageId":"123456789012345"\}/);
  assert.equal((cfg.match(/pediuHorario:/g) || []).length, 1);
  assert.equal((cfg.match(/\/\/ v3:/g) || []).length, 1);
  const r3 = aplicar({ ...workflow(), nodes: r2.nodes }, { PEDIU_MODO: 'ligado' });
  assert.match(no(r3.nodes, 'Config').jsCode, /pediuHorario: \{"modo":"ligado"/);
  assert.match(no(r3.nodes, 'Config').jsCode, /status: \{"modo":"seco"/, 'o Status não mexeu');
});

test('aplicar: Status ligado ou seco SEM page_id é recusado (a Meta rejeita evento sem page_id)', () => {
  const r = aplicar(workflow(), { STATUS_MODO: 'ligado' });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /page-id/);
  assert.equal(r.nodes, null, 'nada gravado');
});

test('aplicar: modo inválido e page_id que não é número são recusados', () => {
  assert.equal(aplicar(workflow(), { PEDIU_MODO: 'talvez' }).status, 2);
  assert.equal(aplicar(workflow(), { STATUS_MODO: 'seco', PAGE_ID: 'doutorherniabalsas' }).status, 2);
});

test('aplicar: workflow fora do molde (nó faltando) falha ALTO e não grava nada', () => {
  for (const faltando of ['Montar evento', 'Reservar envio', 'Cliques e reenvios', 'Modo teste (nao chama a Meta)?']) {
    const r = aplicar(workflow({ semNo: [faltando] }));
    assert.equal(r.status, 2, faltando);
    assert.match(r.stderr, new RegExp(faltando.replace(/[?()]/g, '.')));
    assert.equal(r.nodes, null);
  }
});

test('aplicar: SQL de reenvio que mudou (âncora sumiu) falha alto em vez de gravar um reenvio sem a trava', () => {
  const wf = workflow();
  wf.nodes.find((n) => n.name === 'Cliques e reenvios').parameters.query = 'SELECT outra coisa';
  const r = aplicar(wf);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /reenvio mudou/);
});

test('aplicar: Config cuja última propriedade não termina em vírgula continua sintaticamente válido', () => {
  const wf = workflow();
  const cfg = wf.nodes.find((n) => n.name === 'Config');
  cfg.parameters.jsCode = cfg.parameters.jsCode.replace(/\n  \/\/ v2:[\s\S]*?\n\};/, '\n  janelaDias: 7\n};');
  const r = aplicar(wf, { PEDIU_MODO: 'seco' });
  assert.equal(r.status, 0, r.stderr);
  const js = no(r.nodes, 'Config').jsCode;
  assert.doesNotThrow(() => new Function('$input', js));
  assert.match(js, /janelaDias: 7,\n/);
});

test('aplicar: bloco v3 do Config ilegível (editado na mão) falha alto em vez de "preservar" desligando', () => {
  const r1 = aplicar(workflow(), { PEDIU_MODO: 'ligado' });
  const wf = { ...workflow(), nodes: r1.nodes };
  const cfg = wf.nodes.find((n) => n.name === 'Config');
  cfg.parameters.jsCode = cfg.parameters.jsCode.replace(/pediuHorario: (\{[^\n]*\}),/, 'pediuHorario: {\n    modo: "ligado",\n  },');
  const r = aplicar(wf);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /pediuHorario/);
});

test('aplicar: "statusQualificacao:" não é confundido com o bloco "status:" ao preservar', () => {
  const r = aplicar(workflow(), { PEDIU_MODO: 'seco' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(no(r.nodes, 'Config').jsCode, /status: \{"modo":"desligado"/);
});

test('aplicar: sem a ligação direta Rehidratar -> IF "Modo teste" recusa (o _seco poderia se perder e o seco chamar a Meta)', () => {
  const r = aplicar(workflow({ semLigacao: true }));
  assert.equal(r.status, 2);
  assert.match(r.stderr, /Rehidratar/);
});

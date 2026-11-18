import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { MOTIVO_PARADA_NAO_PACIENTE, OPCAO_NAO_PACIENTE, etapaDeReentrada, planoNaoPaciente, telefoneMarcadoNaoPaciente } from './nao-paciente-manual.js';

test('os textos copiados batem com os de nao-paciente.ts (a marca da Sofia e a da equipe são a mesma)', () => {
  // lido do arquivo (importar nao-paciente.ts puxa a validação do .env): a marca da Sofia e a da equipe precisam ser a MESMA
  const fonte = readFileSync(new URL('./nao-paciente.ts', import.meta.url), 'utf8');
  assert.ok(fonte.includes(`MOTIVO_DE_PARADA_DO_FOLLOW_UP = '${MOTIVO_PARADA_NAO_PACIENTE}'`));
  assert.ok(fonte.includes(`OPCAO_MOTIVO_CURRICULO = '${OPCAO_NAO_PACIENTE}'`));
});

test('prompt-composer: nao_paciente_reentrada_status_id é chave de configuração (senão a Sofia lia "mover_etapa(111915771)")', () => {
  const fonte = readFileSync(new URL('../agent/prompt-composer.ts', import.meta.url), 'utf8');
  const inicio = fonte.indexOf('PIPELINE_INTENT_CONFIG_KEYS = new Set([');
  assert.ok(inicio > 0, 'a lista de chaves de configuração do prompt sumiu');
  const bloco = fonte.slice(inicio, fonte.indexOf(']);', inicio));
  assert.ok(bloco.includes(`'nao_paciente_reentrada_status_id'`));
});

test('planoNaoPaciente: só o motivo "Não é paciente (currículo)"; com a etiqueta, só a conversa', () => {
  const naoContatar = 'NO_FOLLOW_UP';
  // o Heitor (Petrópolis, 17/11): PERDIDO "currículo" marcado à mão, sem a etiqueta
  assert.equal(planoNaoPaciente({ motivo: 'Não é paciente (currículo)', tags: ['PETRÓPOLIS'], naoContatar }), 'etiquetar');
  assert.equal(planoNaoPaciente({ motivo: 'não é paciente (curriculo)', tags: [], naoContatar }), 'etiquetar');
  assert.equal(planoNaoPaciente({ motivo: 'Não é paciente (currículo)', tags: ['no_follow_up'], naoContatar }), 'so_conversa');
  assert.equal(planoNaoPaciente({ motivo: 'Não deu continuidade ao atendimento', tags: [], naoContatar }), 'nada');
  assert.equal(planoNaoPaciente({ motivo: null, tags: [], naoContatar }), 'nada');
});

test('etapaDeReentrada: só inteiro positivo, nunca PERDIDO nem GANHO', () => {
  assert.equal(etapaDeReentrada({ nao_paciente_reentrada_status_id: 111915771 }), 111915771);
  assert.equal(etapaDeReentrada({ nao_paciente_reentrada_status_id: 143 }), null);
  assert.equal(etapaDeReentrada({ nao_paciente_reentrada_status_id: 142 }), null);
  assert.equal(etapaDeReentrada({ nao_paciente_reentrada_status_id: '111915771' }), null);
  assert.equal(etapaDeReentrada(null), null);
});

test('telefoneMarcadoNaoPaciente: com a chave desligada não consulta nada e não cala ninguém', async () => {
  const antes = process.env.NAO_PACIENTE_MANUAL_SLUGS;
  delete process.env.NAO_PACIENTE_MANUAL_SLUGS;
  try {
    assert.equal(await telefoneMarcadoNaoPaciente({ id: 'u-nao-existe', slug: 'unidade-sem-chave' }, '+5524988646467'), false);
  } finally {
    if (antes !== undefined) process.env.NAO_PACIENTE_MANUAL_SLUGS = antes;
  }
});

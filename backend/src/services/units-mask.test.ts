import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { maskUnitSecrets } from './units.service.js';
import type { Unit } from '@prisma/client';

const aqui = dirname(fileURLToPath(import.meta.url));
const SCHEMA = resolve(aqui, '../../prisma/schema.prisma');
const SERVICE = resolve(aqui, 'units.service.ts');

/**
 * Campos que casam com "segredo" pelo nome mas NÃO são segredo de verdade.
 * pixKey é a chave Pix que a clínica entrega ao paciente — publicá-la é o
 * objetivo dela, não um vazamento.
 */
const NAO_SAO_SEGREDO = new Set(['pixKey']);

function camposSecretosDoSchema(): string[] {
  const schema = readFileSync(SCHEMA, 'utf8');
  const bloco = /model Unit \{([\s\S]*?)\n\}/.exec(schema);
  assert.ok(bloco, 'model Unit não encontrado no schema');
  const campos = [...bloco[1].matchAll(/^\s*(\w+)\s+String/gm)].map((m) => m[1]);
  return campos.filter(
    (c) => /token|apikey|secret|password|senha|key$/i.test(c) && !NAO_SAO_SEGREDO.has(c),
  );
}

// Este teste existe porque um campo secreto NOVO nasce desmascarado por padrão:
// quem adiciona a coluna raramente lembra de editar maskUnitSecrets, e o
// vazamento só aparece quando alguém preenche o campo em produção. Foi o caso
// real de googleAccessToken/googleRefreshToken.
test('todo campo secreto da Unit está na máscara da API', () => {
  const servico = readFileSync(SERVICE, 'utf8');
  const trecho = servico.slice(servico.indexOf('export function maskUnitSecrets'));
  const mascarados = new Set([...trecho.matchAll(/(\w+):\s*mask\(/g)].map((m) => m[1]));

  const faltando = camposSecretosDoSchema().filter((c) => !mascarados.has(c));
  assert.deepEqual(
    faltando,
    [],
    `Campos secretos SEM máscara (vazam inteiros na API): ${faltando.join(', ')}. ` +
      'Adicione em maskUnitSecrets (units.service.ts).',
  );
});

test('a máscara esconde o miolo e preserva as pontas', () => {
  const unit = {
    openaiApiKey: 'sk-proj-ABCDEFGHIJKLMNOPQRSTUVWXYZ1234',
    spineToken: null,
  } as unknown as Unit;
  const out = maskUnitSecrets(unit);
  assert.ok(!out.openaiApiKey?.includes('MNOPQRSTUVWXYZ'), 'o miolo não pode aparecer');
  assert.ok(out.openaiApiKey?.startsWith('sk-pro'), 'as primeiras letras ajudam a identificar');
  assert.match(out.openaiApiKey ?? '', /••••/);
});

test('campo vazio continua vazio (não vira máscara falsa)', () => {
  const out = maskUnitSecrets({ openaiApiKey: null } as unknown as Unit);
  assert.equal(out.openaiApiKey, null);
});

test('_hasSecrets diz se existe segredo sem revelar o valor', () => {
  const out = maskUnitSecrets({
    openaiApiKey: 'sk-abcdefghijklmnop',
    anthropicApiKey: null,
  } as unknown as Unit);
  assert.equal(out._hasSecrets.openaiApiKey, true);
  assert.equal(out._hasSecrets.anthropicApiKey, false);
});

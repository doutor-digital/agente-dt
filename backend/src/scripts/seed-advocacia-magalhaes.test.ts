import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SLUG_MAGALHAES, KOMMO_SUBDOMAIN_MAGALHAES } from '../lib/magalhaes.js';
import { unitConteudo, unitCriacao, montarAcoes } from './seed-advocacia-magalhaes.js';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..');
const ler = (rel: string) => readFileSync(join(SRC, rel), 'utf8');

function arquivosTs(dir: string, acc: string[] = []): string[] {
  for (const nome of readdirSync(dir)) {
    const p = join(dir, nome);
    if (statSync(p).isDirectory()) arquivosTs(p, acc);
    else if (p.endsWith('.ts')) acc.push(p);
  }
  return acc;
}

test('o slug é o da unidade que existe em produção, e o grafo usa o mesmo (a tag de data de entrada valia para um slug fantasma)', () => {
  assert.equal(SLUG_MAGALHAES, 'magalhaes-advocacia');
  assert.equal(KOMMO_SUBDOMAIN_MAGALHAES, 'magalhaesadv2025');
  const graph = ler('agent/graph.ts');
  assert.match(graph, /ENTRY_DATE_TAG_SLUGS = new Set\(\[SLUG_MAGALHAES\]\)/);
  assert.equal(graph.includes("'advocacia-magalhaes'"), false);
  assert.equal(ler('scripts/seed-advocacia-magalhaes.ts').includes("'advocacia-magalhaes'"), false);
});

test('nenhum token JWT no código (o repositório é público)', () => {
  const jwt = /eyJ[A-Za-z0-9_-]{15,}\.eyJ[A-Za-z0-9_-]{15,}\./;
  for (const f of arquivosTs(SRC)) {
    if (f.endsWith('seed-advocacia-magalhaes.test.ts')) continue;
    assert.equal(jwt.test(readFileSync(f, 'utf8')), false, `JWT em ${f}`);
  }
});

test('a atualização grava SÓ conteúdo: provider, modelo, chaves, etapas, bot, janela e Kommo da unidade ficam como estão', () => {
  const proibidos = /^(kommo|llm|anthropic|openai|isActive$|name$|slug$|businessHours|followUp|reactivation|spine|voice|meta|waba)/i;
  for (const chave of Object.keys(unitConteudo)) assert.equal(proibidos.test(chave), false, `unitConteudo.${chave} sobrescreveria configuração`);
});

test('banco novo: a unidade nasce INATIVA, sem etapa permitida, sem bot e sem chave; o token só vem do ambiente', () => {
  const sem = unitCriacao({} as NodeJS.ProcessEnv);
  assert.equal(sem.slug, SLUG_MAGALHAES);
  assert.equal(sem.kommoAccessToken, null);
  assert.equal(sem.isActive, false); // allowlist vazia = responde em qualquer etapa: quem liga define as etapas antes
  assert.equal('kommoAllowedStatusIds' in sem, false);
  assert.equal('kommoSalesbotId' in sem, false);
  assert.equal('anthropicApiKey' in sem, false);
  const com = unitCriacao({ MAGALHAES_KOMMO_ACCESS_TOKEN: ' abc ' } as NodeJS.ProcessEnv);
  assert.equal(com.kommoAccessToken, 'abc');
});

test('handoff: sempre pausa e passa para a equipe; só atribui se houver um usuário real do Kommo', () => {
  const tipos = (userId: number | null) => montarAcoes(userId).flatMap((a) => a.actions.map((x) => x.kind as string));
  assert.equal(tipos(null).includes('assign_responsible'), false);
  assert.equal(tipos(null).filter((k) => k === 'transfer_without_permission').length, 2);
  assert.equal(tipos(15454203).filter((k) => k === 'assign_responsible').length, 2);
  assert.equal(JSON.stringify(montarAcoes(null)).includes('15490579'), false, 'o id 15490579 não existe na conta do Kommo da Magalhães');
});

test('persona: Sophia (assistente virtual do escritório); o nome antigo não sobra no que o modelo lê, e ela continua se assumindo virtual', () => {
  const lido = [unitConteudo.personaGreeting, unitConteudo.sourcePapel, unitConteudo.triageInstructions].join('\n');
  assert.match(unitConteudo.personaGreeting, /Sophia/);
  assert.match(unitConteudo.sourcePapel, /Você é a Sophia, assistente virtual/);
  assert.equal(/\bAna\b/.test(lido), false);
  assert.match(unitConteudo.sourcePapel, /Você é um robô\?/);
});

test('a Sophia não agenda e não fala de honorário (regra dura do prompt)', () => {
  assert.match(unitConteudo.sourcePapel, /VOCÊ NÃO AGENDA/);
  assert.match(unitConteudo.sourcePapel, /Valor de honorário/);
  assert.equal(unitConteudo.handoffEnabled, true);
  assert.equal(unitConteudo.triageEnabled, true);
});

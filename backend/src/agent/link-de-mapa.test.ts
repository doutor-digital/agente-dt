import { test } from 'node:test';
import assert from 'node:assert/strict';

import { corrigirLinkDeMapa } from './link-de-mapa.js';
import { aplicarGuardrail } from './guardrail.js';
import { renderOndeFica } from './prompt-composer.js';
import type { Unit } from '@prisma/client';

// Rio Verde, 21/10/2026 (lead 6271810): o que a Sofia mandou — o Google põe esse texto quarteirões longe da clínica.
const INVENTADO =
  'Aqui está: https://www.google.com/maps/search/?api=1&query=R.+Abel+Pereira+de+Castro%2C+792+%E2%80%94+Setor+Central%2C+Rio+Verde%2FGO+%E2%80%94+CEP+75901-060 ➤ Qualquer dúvida no caminho, me chama, tá bom? ☺';
const CERTO = 'https://maps.app.goo.gl/WWDRhSTCuANt19bu6';
const ENDERECO = 'R. Abel Pereira de Castro, 792 — Setor Central, Rio Verde/GO — CEP 75901-060';

test('link montado a partir do endereço vira o link cadastrado', () => {
  const r = corrigirLinkDeMapa(INVENTADO, { clinicMapUrl: CERTO, clinicAddress: ENDERECO });
  assert.equal(r.trocou, true);
  assert.equal(r.texto, `Aqui está: ${CERTO} ➤ Qualquer dúvida no caminho, me chama, tá bom? ☺`);
});

test('o link cadastrado passa intacto, mesmo com ponto no fim da frase', () => {
  const t = `Como chegar: ${CERTO}.`;
  assert.deepEqual(corrigirLinkDeMapa(t, { clinicMapUrl: CERTO, clinicAddress: ENDERECO }), { texto: t, trocou: false });
});

test('sem link cadastrado, o inventado vira o endereço escrito', () => {
  const r = corrigirLinkDeMapa(INVENTADO, { clinicMapUrl: null, clinicAddress: ENDERECO });
  assert.equal(r.trocou, true);
  assert.ok(r.texto.startsWith(`Aqui está: ${ENDERECO} ➤`));
  assert.doesNotMatch(r.texto, /google\.com\/maps/);
});

test('outros formatos do Google Maps também', () => {
  for (const l of ['https://maps.google.com/?q=Rua+X', 'https://goo.gl/maps/abc', 'https://maps.app.goo.gl/OUTRO123', 'https://www.google.com.br/maps/place/Rua+X/@-17.79,-50.93']) {
    const r = corrigirLinkDeMapa(`Veja: ${l}`, { clinicMapUrl: CERTO, clinicAddress: ENDERECO });
    assert.equal(r.texto, `Veja: ${CERTO}`, l);
  }
});

test('link que não é de mapa fica como está', () => {
  const t = 'Nosso Instagram: https://instagram.com/doutorhernia e o site https://www.google.com/search?q=doutor+hernia';
  assert.deepEqual(corrigirLinkDeMapa(t, { clinicMapUrl: CERTO, clinicAddress: ENDERECO }), { texto: t, trocou: false });
});

test('o guardrail aplica a troca na resposta que vai pro paciente', () => {
  const unit = { category: 'saude', clinicMapUrl: CERTO, clinicAddress: ENDERECO } as unknown as Unit;
  const r = aplicarGuardrail(INVENTADO, unit);
  assert.ok(r.triggered.includes('mapa:link_inventado'));
  assert.match(r.text, /maps\.app\.goo\.gl\/WWDRhSTCuANt19bu6/);
  assert.doesNotMatch(r.text, /maps\/search/);
});

test('prompt: sem mapa cadastrado, proíbe montar link; com mapa, manda usar só o cadastrado', () => {
  const sem = renderOndeFica({ clinicAddress: ENDERECO, clinicMapUrl: null } as Unit);
  assert.match(sem, /NÃO monte link do Google Maps/);
  const com = renderOndeFica({ clinicAddress: ENDERECO, clinicMapUrl: CERTO } as Unit);
  assert.match(com, new RegExp(`Mapa: ${CERTO.replace(/[.]/g, '\\.')}`));
  assert.match(com, /use SÓ o de cima/);
});

test('link cadastrado que termina em pontuação continua reconhecido (achado do Codex)', () => {
  const comParenteses = 'https://www.google.com/maps/place/Doutor+H%C3%A9rnia+(Rio+Verde)';
  for (const t of [`Mapa: ${comParenteses}`, `Mapa: ${comParenteses}.`, `(veja ${comParenteses})`]) {
    assert.deepEqual(corrigirLinkDeMapa(t, { clinicMapUrl: comParenteses, clinicAddress: ENDERECO }), { texto: t, trocou: false }, t);
  }
});

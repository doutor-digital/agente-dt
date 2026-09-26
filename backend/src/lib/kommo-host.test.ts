/**
 * Trava dos dois vazamentos de token do Kommo (auditoria 26/09/2026): o servidor só
 * pode mandar o Bearer do CRM para host do próprio Kommo/amoCRM.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ehHostDoKommo } from './kommo-host.js';

test('aceita o host exato da unidade e os domínios da marca', () => {
  assert.equal(ehHostDoKommo('https://minhaclinica.kommo.com/api/v4/salesbot/1', 'minhaclinica'), true);
  assert.equal(ehHostDoKommo('https://qualquer.kommo.com/x'), true);
  assert.equal(ehHostDoKommo('https://files.amocrm.com/x'), true);
  assert.equal(ehHostDoKommo('https://x.amocrm.ru/y'), true);
  assert.equal(ehHostDoKommo('https://kommo.com/x'), true);
});

test('recusa host do atacante, http, e truques de URL', () => {
  assert.equal(ehHostDoKommo('https://atacante.tld/', 'minhaclinica'), false);
  assert.equal(ehHostDoKommo('http://minhaclinica.kommo.com/x'), false, 'http não, só https');
  assert.equal(ehHostDoKommo('https://kommo.com.atacante.tld/x'), false, 'sufixo falso');
  assert.equal(ehHostDoKommo('https://atacante.tld/kommo.com'), false, 'kommo só no path');
  assert.equal(ehHostDoKommo('https://169.254.169.254/latest/meta-data/'), false);
  assert.equal(ehHostDoKommo('não-é-url'), false);
  assert.equal(ehHostDoKommo('https://evilkommo.com/x'), false, 'sem o ponto do sufixo');
});

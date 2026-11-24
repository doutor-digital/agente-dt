import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ErroDaAgenda, acharUsuario, isoLocal } from './agenda.js';
import { instante } from './horarios.js';

const usuarios = [
  { id: 'user_1', name: 'Amanda Exemplo Silva' },
  { id: 'user_2', name: 'Victor Hugo Exemplo' },
  { id: 'user_3', name: 'Amanda Outra Pessoa' },
  { id: 'user_4', name: 'Thiago Exemplo' },
];
const adv = (tramitacao: string | null, tramitacaoId: string | null = null) => ({ tramitacao, tramitacaoId, nome: 'Dr. Teste' });

test('usuário da Tramitação: o nome completo configurado acha UM; id configurado vale direto', () => {
  assert.equal(acharUsuario(usuarios, adv('Amanda Exemplo')), 'user_1');
  assert.equal(acharUsuario(usuarios, adv('victor')), 'user_2');
  assert.equal(acharUsuario(usuarios, adv('qualquer', 'user_99')), 'user_99');
});

test('nome que bate em mais de um usuário, ou em nenhum, é ERRO — nunca "o primeiro" (palpite virando agenda errada)', () => {
  assert.throws(() => acharUsuario(usuarios, adv('Amanda')), (e: unknown) => e instanceof ErroDaAgenda && /mais de um/.test(e.message));
  assert.throws(() => acharUsuario(usuarios, adv('Fulano')), (e: unknown) => e instanceof ErroDaAgenda && /nenhum/.test(e.message));
  assert.throws(() => acharUsuario(usuarios, adv(null)), ErroDaAgenda);
  assert.throws(() => acharUsuario(usuarios, adv('Vic')), ErroDaAgenda, 'pedaço de palavra não conta');
});

test('instante → ISO com o offset do escritório', () => {
  assert.equal(isoLocal(instante('2026-11-18', '09:00')), '2026-11-18T09:00:00-03:00');
  assert.equal(isoLocal(instante('2026-11-18', '17:50')), '2026-11-18T17:50:00-03:00');
});

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import type { KommoChatTemplate } from '../services/kommo.service.js';
import { ONDE_CADASTRAR_RESPOSTAS, primeiroNomeDoPaciente, respostasProntas, trocarMarcadores } from './ponte-respostas.js';

// O mesmo `respostas.js` que a extensão carrega: o texto que sai daqui tem de virar o texto certo lá.
const EXTENSAO = new URL('../../../extensao-ponte/', import.meta.url);
const daExtensao = createRequire(import.meta.url)(new URL('respostas.js', EXTENSAO).pathname) as {
  preencherNome(texto: string, nome: string | null): string;
  temLacuna(texto: string): boolean;
};

const CAMPOS = new Map([
  [2449844, '◷ Data da Consulta'],
  [2450036, '¤ Valor da Consulta'],
]);
const nomeDoCampo = (id: number) => CAMPOS.get(id) ?? null;

/** Como vêm de `GET /api/v4/chats/templates` (formato do dump de Açailândia, 07/10/2026). */
const MODELOS: KommoChatTemplate[] = [
  { id: 1, type: 'waba', name: 'sdr_confirmacao_retorno', content: 'Olá, {{contact.name}}! Confirmando o retorno.' },
  { id: 2, type: 'amocrm', name: '⚡ Consulta prepagamento', content: 'Olá, {{contact.name}}. A sua consulta está pré-agendada.\nData e horário: {{lead.cf.2449844}}', attachment: null },
  { id: 3, type: 'amocrm', name: 'Endereço', content: 'Estamos na Rua das Flores, 100.', attachment: { file_uuid: 'x' } },
  { id: 4, type: 'amocrm', name: 'Vazio', content: '   ' },
  { id: 5, type: 'amocrm', name: 'Outro campo', content: 'Valor {{lead.cf.2450036}} e {{lead.cf.1}} e {{lead.price}}' },
];

describe('respostas prontas — o que entra', () => {
  it('só os modelos gerais (texto livre), com texto, em ordem alfabética (o ⚡ não conta); os do WhatsApp (waba) ficam de fora', () => {
    const r = respostasProntas(MODELOS, nomeDoCampo);
    assert.deepEqual(r.map((x) => x.nome), ['⚡ Consulta prepagamento', 'Endereço', 'Outro campo']);
    assert.ok(!r.some((x) => x.id === 1), 'modelo do WhatsApp não é resposta pronta');
    assert.equal(r.find((x) => x.id === 3)?.temAnexo, true);
    assert.equal(r.find((x) => x.id === 2)?.temAnexo, false);
  });

  it('campo do cartão vira o NOME do campo entre colchetes; o marcador de nome fica para o painel', () => {
    const r = respostasProntas(MODELOS, nomeDoCampo);
    assert.equal(r.find((x) => x.id === 2)?.texto, 'Olá, {{contact.name}}. A sua consulta está pré-agendada.\nData e horário: [◷ Data da Consulta]');
    assert.equal(r.find((x) => x.id === 5)?.texto, 'Valor [¤ Valor da Consulta] e [campo do cartão] e [lead.price]');
    assert.equal(trocarMarcadores('Oi {{ contact.first_name }}', nomeDoCampo), 'Oi {{ contact.first_name }}');
  });

  it('servidor + painel: o texto copiado sai com o primeiro nome e com a lacuna marcada', () => {
    const r = respostasProntas(MODELOS, nomeDoCampo).find((x) => x.id === 2)!;
    const copiado = daExtensao.preencherNome(r.texto, primeiroNomeDoPaciente('MARIA SOUZA 03/10/2026', null));
    assert.equal(copiado, 'Olá, Maria. A sua consulta está pré-agendada.\nData e horário: [◷ Data da Consulta]');
    assert.equal(daExtensao.temLacuna(copiado), true);
  });

  it('onde cadastrar', () => {
    assert.match(ONDE_CADASTRAR_RESPOSTAS, /Configurações › Modelos › Modelos gerais/);
  });
});

describe('respostas prontas — o primeiro nome do paciente', () => {
  it('do título do cartão (o padrão da casa), com maiúscula só na primeira letra', () => {
    assert.equal(primeiroNomeDoPaciente('MARIA SOUZA 03/10/2026', 'Mãe ❤️'), 'Maria');
    assert.equal(primeiroNomeDoPaciente('joão da silva', null), 'João');
    assert.equal(primeiroNomeDoPaciente('Dra. Ana Lima', null), 'Ana');
  });

  it('título sem nome ("Lead 22261987"): usa o contato do WhatsApp', () => {
    assert.equal(primeiroNomeDoPaciente('Lead 22261987', 'Sandra Cruz'), 'Sandra');
    assert.equal(primeiroNomeDoPaciente('Lead #2 25/09/2026', '✨ Júlia ✨'), 'Júlia');
  });

  it('nada que pareça nome: null (o painel deixa "[nome]")', () => {
    assert.equal(primeiroNomeDoPaciente('Lead 22261987', '+55 99 90000-0043'), null);
    assert.equal(primeiroNomeDoPaciente(null, null), null);
    assert.equal(primeiroNomeDoPaciente('', '🙂'), null);
  });
});

/**
 * Aniversário no CRM: a data é da franquia e só vale com casamento seguro (nome completo igual + WhatsApp igual + uma só ficha); datas, 29/02,
 * atraso de até 3 dias, falecido, horário de consulta e cache. Nada é gravado em lugar nenhum.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.KOMMO_SUBDOMAIN ??= 'teste';
process.env.KOMMO_ACCESS_TOKEN ??= 'token-de-teste-123';
process.env.OPENAI_API_KEY ??= 'sk-teste-1234567890';

const A = await import('./chatwoot-aniversario.js');
type Conv = import('./chatwoot-regua.js').ConversaRegua;

const conv = (id: number, nome: string, telefone: string, extra: Partial<Conv> = {}): Conv => ({ id, nome, etiquetas: [], attrs: {}, criadaEm: new Date('2026-10-01T00:00:00Z'), atendente: null, ultima: null, telefone, ...extra });
const cl = (idClient: number | null, name: string | null, whatsapp: string | null) => ({ idClient, name, whatsapp });

test('data de nascimento da ficha: ISO ou dd/mm/aaaa; lixo é null', () => {
  assert.equal(A.diaDeNascimentoDaFicha('1980-11-17'), '1980-11-17');
  assert.equal(A.diaDeNascimentoDaFicha('1980-11-17T00:00:00.000Z'), '1980-11-17');
  assert.equal(A.diaDeNascimentoDaFicha('17/11/1980'), '1980-11-17');
  assert.equal(A.diaDeNascimentoDaFicha('1980-13-45'), null);
  assert.equal(A.diaDeNascimentoDaFicha(''), null);
  assert.equal(A.diaDeNascimentoDaFicha(null), null);
  assert.equal(A.diaDeNascimentoDaFicha('quinta'), null);
});

test('ocorrência do aniversário: hoje ou nos 3 dias anteriores; 29/02 em ano sem bissexto; ano absurdo não vale', () => {
  assert.equal(A.ocorrenciaDoAniversario('1980-11-17', '2026-11-17'), '2026-11-17');
  assert.equal(A.ocorrenciaDoAniversario('1980-11-14', '2026-11-17'), '2026-11-14', 'sábado cumprimentado na terça: 3 dias de atraso');
  assert.equal(A.ocorrenciaDoAniversario('1980-11-13', '2026-11-17'), null, '4 dias: passou');
  assert.equal(A.ocorrenciaDoAniversario('1980-11-18', '2026-11-17'), null, 'amanhã não');
  assert.equal(A.ocorrenciaDoAniversario('1992-02-29', '2026-02-28'), '2026-02-28', '29/02 comemora no dia 28');
  assert.equal(A.ocorrenciaDoAniversario('1992-02-29', '2028-02-29'), '2028-02-29');
  assert.equal(A.ocorrenciaDoAniversario('1992-02-29', '2028-02-28'), null, 'em ano bissexto é no 29');
  assert.equal(A.ocorrenciaDoAniversario('1980-12-31', '2027-01-02'), '2026-12-31', 'virada de ano: o ano do aniversário é o que fez anos');
  assert.equal(A.ocorrenciaDoAniversario('2026-11-17', '2026-11-17'), null, 'nasceu este ano: data errada');
  assert.equal(A.ocorrenciaDoAniversario('1850-11-17', '2026-11-17'), null, 'ano antes de 1900');
  assert.equal(A.ocorrenciaDoAniversario('2031-11-17', '2026-11-17'), null, 'ano no futuro');
  assert.equal(A.ocorrenciaDoAniversario(null, '2026-11-17'), null);
  assert.equal(A.statusDeFalecido('Óbito'), true);
  assert.equal(A.statusDeFalecido('FALECIDO'), true);
  assert.equal(A.statusDeFalecido('ATIVO'), false);
  assert.equal(A.statusDeFalecido(null), false);
});

test('casamento seguro: nome COMPLETO igual (sem acento/caixa) + WhatsApp igual (com ou sem o 9) + uma única ficha; senão null', () => {
  const tel = '+5594999745062';
  const ok = [cl(10, 'Maria da Silva', '(94) 99974-5062')];
  assert.equal(A.casamentoSeguro(ok, 'maria da silva', tel), 10);
  assert.equal(A.casamentoSeguro([cl(10, 'MARIA DA SILVA', '94999745062')], 'Maria da Silva', tel), 10);
  assert.equal(A.casamentoSeguro([cl(10, 'Maria da Silva', '9499745062')], 'Maria da Silva', tel), 10, 'sem o 9');
  assert.equal(A.casamentoSeguro([cl(10, 'María da Silva', '94999745062')], 'maria da silva', tel), 10, 'acento');
  // a ficha da FILHA com o mesmo nome e outro telefone não casa (nunca estampar a identidade errada)
  assert.equal(A.casamentoSeguro([cl(11, 'Maria da Silva', '94988887777')], 'Maria da Silva', tel), null);
  // nome parecido, só o primeiro nome, ficha sem WhatsApp
  assert.equal(A.casamentoSeguro([cl(12, 'Maria da Silva Souza', '94999745062')], 'Maria da Silva', tel), null);
  assert.equal(A.casamentoSeguro([cl(13, 'Maria', '94999745062')], 'Maria', tel), null);
  assert.equal(A.casamentoSeguro([cl(14, 'Maria da Silva', null)], 'Maria da Silva', tel), null);
  assert.equal(A.casamentoSeguro([cl(null, 'Maria da Silva', '94999745062')], 'Maria da Silva', tel), null);
  // duas fichas com o mesmo nome (mesmo que uma tenha o telefone certo): ambíguo, não casa
  assert.equal(A.casamentoSeguro([...ok, cl(15, 'Maria da Silva', '94911112222')], 'Maria da Silva', tel), null);
  assert.equal(A.casamentoSeguro([], 'Maria da Silva', tel), null);
});

function deps(o: { clientes?: Record<string, ReturnType<typeof cl>[] | null>; fichas?: Record<number, { birthdate: string | null; status: string | null } | null> } = {}) {
  const buscas: string[] = [];
  const fichas: number[] = [];
  const d: import('./chatwoot-aniversario.js').DepsDoAniversario = {
    async buscar(nome) {
      buscas.push(nome);
      return o.clientes && nome in o.clientes ? o.clientes[nome]! : [];
    },
    async ficha(id) {
      fichas.push(id);
      return o.fichas?.[id] ?? null;
    },
    dormir: async () => undefined,
  };
  return { d, buscas, fichas };
}
const MANHA = new Date('2026-11-17T12:30:00Z'); // terça 09:30 em Belém

test('aniversariantes: só com a ficha casada e a data de hoje; cache de busca e de ficha; fora de 8–13 h não consulta nada', async () => {
  A._esquecerAniversariantes();
  const conversas = [conv(1, 'Maria da Silva', '+5594999745062'), conv(2, 'Ana Souza', '+5594988887777'), conv(3, 'João', '+5594977776666'), conv(4, 'Bruno Lima', '+5594966665555', { etiquetas: ['interno'] }), conv(5, 'Carla Dias', '+5594955554444')];
  const { d, buscas, fichas } = deps({
    clientes: { 'Maria da Silva': [cl(10, 'Maria da Silva', '94999745062')], 'Ana Souza': [cl(11, 'Ana Souza', '94988887777')], 'Carla Dias': [cl(12, 'Carla Dias', '94955554444')] },
    fichas: { 10: { birthdate: '1980-11-17', status: 'ATIVO' }, 11: { birthdate: '1990-05-01', status: 'ATIVO' }, 12: { birthdate: '1975-11-17', status: 'Óbito' } },
  });
  const r = await A.aniversariantesDaFranquia(d, 'u', conversas, MANHA);
  assert.deepEqual([...r.entries()], [[1, '2026-11-17']], 'Ana faz anos em maio; Carla (óbito) não recebe; João sem sobrenome e Bruno interno nem são buscados');
  assert.deepEqual(buscas.sort(), ['Ana Souza', 'Carla Dias', 'Maria da Silva']);
  // o ciclo seguinte (10 min depois) não repete a busca nem a ficha
  const r2 = await A.aniversariantesDaFranquia(d, 'u', conversas, new Date(MANHA.getTime() + 600_000));
  assert.deepEqual([...r2.entries()], [[1, '2026-11-17']]);
  assert.equal(buscas.length, 3);
  assert.equal(fichas.length, 3);
  // à noite e de madrugada não consulta a franquia
  A._esquecerAniversariantes();
  const n = deps({ clientes: { 'Maria da Silva': [cl(10, 'Maria da Silva', '94999745062')] } });
  assert.equal((await A.aniversariantesDaFranquia(n.d, 'u', conversas, new Date('2026-11-17T22:00:00Z'))).size, 0);
  assert.equal((await A.aniversariantesDaFranquia(n.d, 'u', conversas, new Date('2026-11-17T09:00:00Z'))).size, 0);
  assert.equal(n.buscas.length, 0);
});

test('aniversariantes: a franquia fora do ar não vira «não casou» (tenta no próximo ciclo); ficha sem data ou que não lê não manda; fim de semana alcança 3 dias', async () => {
  A._esquecerAniversariantes();
  const c = [conv(1, 'Maria da Silva', '+5594999745062')];
  const fora = deps({ clientes: { 'Maria da Silva': null } });
  assert.equal((await A.aniversariantesDaFranquia(fora.d, 'u', c, MANHA)).size, 0);
  const volta = deps({ clientes: { 'Maria da Silva': [cl(10, 'Maria da Silva', '94999745062')] }, fichas: { 10: { birthdate: '1980-11-17', status: 'ATIVO' } } });
  assert.equal((await A.aniversariantesDaFranquia(volta.d, 'u', c, new Date(MANHA.getTime() + 600_000))).size, 1, 'a falha não foi guardada');
  A._esquecerAniversariantes();
  const semData = deps({ clientes: { 'Maria da Silva': [cl(10, 'Maria da Silva', '94999745062')] }, fichas: { 10: { birthdate: null, status: 'ATIVO' } } });
  assert.equal((await A.aniversariantesDaFranquia(semData.d, 'u', c, MANHA)).size, 0);
  A._esquecerAniversariantes();
  const naoLe = deps({ clientes: { 'Maria da Silva': [cl(10, 'Maria da Silva', '94999745062')] }, fichas: { 10: null } });
  assert.equal((await A.aniversariantesDaFranquia(naoLe.d, 'u', c, MANHA)).size, 0);
  // fez anos no sábado 14/11: na segunda 16/11 de manhã ainda entra (a régua cumprimenta; 1 por ano)
  A._esquecerAniversariantes();
  const sab = deps({ clientes: { 'Maria da Silva': [cl(10, 'Maria da Silva', '94999745062')] }, fichas: { 10: { birthdate: '1980-11-14', status: 'ATIVO' } } });
  assert.deepEqual([...(await A.aniversariantesDaFranquia(sab.d, 'u', c, new Date('2026-11-16T12:30:00Z'))).entries()], [[1, '2026-11-14']]);
});

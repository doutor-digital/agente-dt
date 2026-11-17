import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ACABOU_DE_AGENDAR_MS,
  confirmacaoDaUnidade,
  diaUtilAnterior,
  diasQueConfirmamHoje,
  ehDiaUtil,
  jaConfirmou,
  saudacaoDaHora,
  textoDaUnidade,
} from './confirmacao-unidade.js';

// Novembro de 2026: 17 é terça, 20 (sexta) é feriado nacional (Consciência Negra), 21–22 fim de semana.

test('ehDiaUtil: segunda a sexta, sem feriado nacional', () => {
  assert.equal(ehDiaUtil('2026-11-17'), true); // terça
  assert.equal(ehDiaUtil('2026-11-20'), false); // sexta, Consciência Negra
  assert.equal(ehDiaUtil('2026-11-21'), false); // sábado
  assert.equal(ehDiaUtil('2026-11-22'), false); // domingo
  assert.equal(ehDiaUtil('lixo'), false);
});

test('diaUtilAnterior: segunda → sexta; depois do feriado → antes dele; meio da semana → véspera', () => {
  assert.equal(diaUtilAnterior('2026-11-30'), '2026-11-27'); // segunda → sexta
  assert.equal(diaUtilAnterior('2026-11-23'), '2026-11-19'); // segunda depois da sexta-feriado → quinta
  assert.equal(diaUtilAnterior('2026-11-21'), '2026-11-19'); // sábado (a clínica abre) → quinta, a sexta é feriado
  assert.equal(diaUtilAnterior('2026-11-18'), '2026-11-17'); // quarta → terça
});

test('diasQueConfirmamHoje: de amanhã até o próximo dia útil; fim de semana e feriado não confirmam nada', () => {
  assert.deepEqual(diasQueConfirmamHoje('2026-11-17'), ['2026-11-18']);
  assert.deepEqual(diasQueConfirmamHoje('2026-11-27'), ['2026-11-28', '2026-11-29', '2026-11-30']); // sexta
  assert.deepEqual(diasQueConfirmamHoje('2026-11-19'), ['2026-11-20', '2026-11-21', '2026-11-22', '2026-11-23']); // véspera do feriado
  assert.deepEqual(diasQueConfirmamHoje('2026-11-21'), []); // sábado
  assert.deepEqual(diasQueConfirmamHoje('2026-11-20'), []); // feriado
});

test('diasQueConfirmamHoje e diaUtilAnterior concordam: cada dia de consulta é confirmado UMA vez', () => {
  const vistos = new Map<string, number>();
  for (let d = Date.parse('2026-11-01T00:00:00Z'); d < Date.parse('2027-01-31T00:00:00Z'); d += 86_400_000) {
    const hoje = new Date(d).toISOString().slice(0, 10);
    for (const alvo of diasQueConfirmamHoje(hoje)) {
      assert.equal(diaUtilAnterior(alvo), hoje, `${alvo} sairia em ${hoje}`);
      vistos.set(alvo, (vistos.get(alvo) ?? 0) + 1);
    }
  }
  for (const [alvo, n] of vistos) assert.equal(n, 1, `${alvo} confirmado ${n} vezes`);
});

const MODELO_PETROPOLIS =
  '{saudacao}\nEstou entrando em contato para confirmar sua consulta agendada para *{data} ({DIA}) às {hora}hrs*, na Doutor Hérnia.\nEndereço: Rua Coronel Veiga, 543. \n\nEquipe Doutor Hérnia';

test('textoDaUnidade: o modelo de Petrópolis sai como a equipe escrevia', () => {
  const t = textoDaUnidade(MODELO_PETROPOLIS, { quando: '2026-11-18T17:30', horaDoEnvio: 9 });
  assert.equal(
    t,
    'Bom dia!\nEstou entrando em contato para confirmar sua consulta agendada para *18/11 (QUARTA) às 17:30hrs*, na Doutor Hérnia.\nEndereço: Rua Coronel Veiga, 543. \n\nEquipe Doutor Hérnia',
  );
});

test('textoDaUnidade: saudação pela hora, campos opcionais e chave desconhecida intacta', () => {
  const t = textoDaUnidade('{saudacao} {nome}, {dia} {data} {hora} com {fisioterapeuta} em {endereco} {xyz}', {
    quando: '2026-11-23T08:00',
    nome: ' Ana ',
    especialista: 'Dr. Heitor',
    endereco: 'R. Cel. Veiga, 543',
    horaDoEnvio: 14,
  });
  assert.equal(t, 'Boa tarde! Ana, segunda 23/11 08:00 com Dr. Heitor em R. Cel. Veiga, 543 {xyz}');
  assert.equal(saudacaoDaHora(19), 'Boa noite!');
});

test('jaConfirmou: CONFIRMADO na franquia ou "Agendamento confirmado" há menos de 12 h', () => {
  const agora = new Date('2026-11-17T12:07:00Z');
  assert.match(jaConfirmou({ idStatus: 38, oficiais: [], agora }) ?? '', /CONFIRMADA na franquia/);
  assert.equal(jaConfirmou({ idStatus: 37, oficiais: [], agora }), null);
  // a Patrícia (Petrópolis, 17/11): "✅ Agendamento confirmado" 7 min antes do reforço
  const sofia = { direcao: 'saida' as const, em: new Date(agora.getTime() - 7 * 60_000), texto: '✅ Agendamento confirmado, Patrícia!\n\n⭐ Data: quinta-feira' };
  assert.match(jaConfirmou({ idStatus: 37, oficiais: [sofia], agora }) ?? '', /menos de 12 h/);
  // antiga demais: pergunta
  const velha = { ...sofia, em: new Date(agora.getTime() - ACABOU_DE_AGENDAR_MS - 60_000) };
  assert.equal(jaConfirmou({ idStatus: 37, oficiais: [velha], agora }), null);
  // o PACIENTE escrever "agendamento confirmado?" não é a confirmação da clínica
  assert.equal(jaConfirmou({ idStatus: 37, oficiais: [{ ...sofia, direcao: 'entrada' }], agora }), null);
  assert.equal(jaConfirmou({ idStatus: null, oficiais: null, agora }), null);
});

test('confirmacaoDaUnidade: sem a chave = padrão da rede; com a chave, só true liga', () => {
  assert.equal(confirmacaoDaUnidade(null), null);
  assert.equal(confirmacaoDaUnidade({ outra: 1 }), null);
  assert.equal(confirmacaoDaUnidade({ confirmacao_unidade: [] }), null);
  assert.deepEqual(confirmacaoDaUnidade({ confirmacao_unidade: { dia_util: true, texto: 'oi', sem_janela: 'sim', pular_confirmada: true } }), {
    diaUtil: true,
    texto: 'oi',
    semJanela: false,
    pularConfirmada: true,
  });
  assert.equal(confirmacaoDaUnidade({ confirmacao_unidade: { texto: '   ' } })?.texto, null);
});

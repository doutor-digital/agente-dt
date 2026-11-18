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
  // relógio adiantado: "Agendamento confirmado" com data no FUTURO não segura a pergunta (Codex, 18/11)
  const futura = { ...sofia, em: new Date(agora.getTime() + 3600_000) };
  assert.equal(jaConfirmou({ idStatus: 37, oficiais: [futura], agora }), null);
});

test('confirmacaoDaUnidade: desligada = padrão da rede; ligada fora da lista = texto da rede, sem tirar a janela', () => {
  assert.equal(confirmacaoDaUnidade('doutor-hernia-petropolis', false), null);
  assert.deepEqual(confirmacaoDaUnidade('doutor-hernia-serra', true), { diaUtil: true, texto: null, semJanela: false, pularConfirmada: true });
  const p = confirmacaoDaUnidade('doutor-hernia-petropolis', true);
  assert.equal(p?.semJanela, true);
  assert.equal(p?.pularConfirmada, true);
  // o texto que a equipe de Petrópolis mandava à mão, com "consulta" no lugar de "sessão"
  assert.equal(
    textoDaUnidade(p?.texto ?? '', { quando: '2026-11-23T17:30', horaDoEnvio: 9 }),
    'Bom dia!\nEstou entrando em contato para confirmar sua consulta agendada para *23/11 (SEGUNDA) às 17:30hrs*, na Doutor Hérnia.\n' +
      'Endereço: Rua Coronel Veiga, 543. \n\n' +
      'Favor vir com roupa confortável\n *não podemos tolerar atrasos superiores a 5 minutos*. Isso evita impactos na agenda e garante que todos sejam atendidos no horário previsto.\n\n' +
      '*Por favor, confirme sua presença em até 12 horas para garantir o horário. Caso contrário, ele será liberado para a lista de espera.*\n\n' +
      'Equipe Doutor Hérnia',
  );
});

test('Caxias: o texto que a equipe mandava à mão (lead 2778872), com "consulta" no lugar de "sessão"; consulta na segunda → mensagem na sexta', () => {
  const c = confirmacaoDaUnidade('doutor-hernia-caxias', true);
  assert.equal(c?.semJanela, true); // WhatsApp Lite (QR): sem janela de 24 h
  assert.equal(c?.diaUtil, true);
  assert.equal(c?.pularConfirmada, true);
  assert.equal(confirmacaoDaUnidade('doutor-hernia-caxias', false), null);
  // consulta na segunda 30/11 → mensagem na sexta 27/11; a de segunda 23/11 vai na quinta 19/11 (sexta 20/11 é feriado nacional)
  assert.equal(diaUtilAnterior('2026-11-23'), '2026-11-19');
  assert.equal(diaUtilAnterior('2026-11-30'), '2026-11-27');
  assert.deepEqual(diasQueConfirmamHoje('2026-11-27'), ['2026-11-28', '2026-11-29', '2026-11-30']);
  // sem {saudacao} no modelo: o preenchimento não deixa chave solta nem quebra (qualquer hora do envio)
  for (const horaDoEnvio of [0, 9, 17]) {
    const t = textoDaUnidade(c?.texto ?? '', { quando: '2026-11-30T17:30', horaDoEnvio });
    assert.doesNotMatch(t, /\{\w+\}/);
    assert.equal(
      t,
      '*CLÍNICA DOUTOR HÉRNIA DUQUE DE CAXIAS:*\nOlá, aqui é da Clínica Doutor Hérnia! 😀\n\n' +
        'Estou entrando em contato para confirmar sua consulta agendada para:\n*Dia 30/11 às 17:30*\n' +
        'Endereço: Rua Mariano Sendra dos Santos 44 sala 206, Galeria Alvarenga.\n\n' +
        'Favor vir com roupa confortável\n*Traga apenas um acompanhante, para maior conforto e organização de todos os pacientes*\n\n' +
        '*Não podemos tolerar atrasos superiores a 5 minutos.* Isso evita impactos na agenda e garante que todos sejam atendidos no horário previsto.\n\n' +
        'Equipe Doutor Hérnia',
    );
  }
  assert.doesNotMatch(c?.texto ?? '', /sess[aã]o/i); // só consulta
});

test('unidade fora do mapa continua com o texto da rede (Caxias não vaza para as outras)', () => {
  for (const slug of ['doutor-hernia-serra', 'doutor-hernia-salto']) {
    assert.deepEqual(confirmacaoDaUnidade(slug, true), { diaUtil: true, texto: null, semJanela: false, pularConfirmada: true });
  }
  assert.notEqual(confirmacaoDaUnidade('doutor-hernia-caxias', true)?.texto, confirmacaoDaUnidade('doutor-hernia-petropolis', true)?.texto);
});

test('Caxias: a Sofia manda "✅ Agendamento confirmado, X!" à noite e a regra das 12 h segura a pergunta da manhã seguinte', () => {
  const sofia = (em: string) => ({ direcao: 'saida' as const, em: new Date(em), texto: '✅ Agendamento confirmado, Ubiratã!\n\n⭐ Data: segunda-feira, 23/11\n⏰ Horário: 17:00' });
  // 23:14 BRT (02:14Z) → varredura às 09:00 BRT do dia seguinte = 9 h 46 min depois
  assert.match(jaConfirmou({ oficiais: [sofia('2026-11-18T02:14:54Z')], agora: new Date('2026-11-18T12:00:00Z') }) ?? '', /Agendamento confirmado/);
  // agendado à tarde (17:00 BRT) e perguntado às 09:00 do dia seguinte: 16 h depois, passou das 12 h — a pergunta sai (limite conhecido)
  assert.equal(jaConfirmou({ oficiais: [sofia('2026-11-17T20:00:00Z')], agora: new Date('2026-11-18T12:00:00Z') }), null);
});

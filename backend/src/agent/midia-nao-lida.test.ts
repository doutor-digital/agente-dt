/**
 * Áudio, foto ou arquivo que a Sofia não leu: a resposta que sai (relatório de 27/11/2026). Prende também que não duplica o que
 * já existia (transcrição, leitura de anexos, passagem para a equipe) e que nunca responde em dobro.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  fraseDeMidiaNaoLida,
  horariosNaMesa,
  INSTRUCAO_DE_PASSAR_PARA_EQUIPE,
  audioDoTurnoFoiTranscrito,
  contarFalhaDoLite,
  esquecerFalhasDoLite,
  idsDeAudioNaoLido,
  liteAudioSemLeitura,
  MARCA_ANEXO_NAO_LIDO_DO_TURNO,
  midiaNaoLidaDoTurno,
  respostaDeMidiaNaoLida,
  respostaJaTrataDaMidia,
  rotuloDoHorario,
} from './midia-nao-lida.js';
import { AUDIO_NAO_OUVIDO, instrucaoAudioNaoTranscrito } from '../controllers/webhook.controller.js';
import { MARCA_ANEXO_NAO_LIDO } from '../lib/anexos-do-turno.js';
import { semDiminutivo } from '../lib/sem-diminutivo.js';
import { semIntimidade } from '../lib/sem-intimidade.js';
import { MARCA_AUDIO_NAO_OUVIDO, type Fala } from './repeticao.js';
import type { MensagemOficial } from '../services/kommo-talks.service.js';

const p = (texto: string): Fala => ({ papel: 'paciente', texto });
const ia = (texto: string): Fala => ({ papel: 'ia', texto });

// sexta-feira, 27/11/2026, 10h (relógio da unidade)
const AGORA = '2026-11-27T10:00';
const AUDIO_SEM_OUVIR = `${AUDIO_NAO_OUVIDO}\n\n${instrucaoAudioNaoTranscrito(false)}`;

test('as marcas daqui são as mesmas que o webhook e a leitura de anexos já usam (nada duplicado, nada divergente)', () => {
  assert.equal(MARCA_AUDIO_NAO_OUVIDO, AUDIO_NAO_OUVIDO);
  assert.equal(MARCA_ANEXO_NAO_LIDO_DO_TURNO, MARCA_ANEXO_NAO_LIDO);
});

test('áudio que não deu pra ouvir, sem texto dele: é mídia não lida', () => {
  assert.equal(midiaNaoLidaDoTurno(AUDIO_SEM_OUVIR), 'audio');
});

test('foto/arquivo ilegível: imagem, arquivo ou genérico', () => {
  assert.equal(midiaNaoLidaDoTurno('[imagem do cliente]: [imagem sem conteúdo legível]'), 'imagem');
  assert.equal(midiaNaoLidaDoTurno('[arquivo do cliente]: [arquivo sem conteúdo legível]'), 'arquivo');
  assert.equal(midiaNaoLidaDoTurno(MARCA_ANEXO_NAO_LIDO), 'midia');
  assert.equal(midiaNaoLidaDoTurno(`${AUDIO_SEM_OUVIR}\n\n${MARCA_ANEXO_NAO_LIDO}`), 'midia');
});

test('Lite: o aviso de mídia sozinho (sem a marca de áudio não ouvido) o código não trata', () => {
  const aviso = 'Você recebeu uma mensagem de mídia (ID da mensagem: 3EB0A1B2C3D4E5F6)';
  assert.equal(midiaNaoLidaDoTurno(aviso), null);
  assert.equal(midiaNaoLidaDoTurno(`'messageContextInfo' is not yet supported`), null);
  // com a marca (o webhook a põe quando o áudio do Lite não foi lido) vira pedido para escrever
  assert.equal(midiaNaoLidaDoTurno(`${aviso}\n\n${AUDIO_SEM_OUVIR}`), 'audio');
});

test('se ele escreveu algo junto, ou a mídia foi lida (transcrição), o modelo responde: o código não age', () => {
  assert.equal(midiaNaoLidaDoTurno(`Boa tarde, queria marcar\n\n${AUDIO_SEM_OUVIR}`), null);
  assert.equal(midiaNaoLidaDoTurno(`[áudio do cliente]: quero marcar pra terça\n\n${AUDIO_SEM_OUVIR}`), null);
  assert.equal(midiaNaoLidaDoTurno('[imagem do cliente]: laudo de ressonância lombar com protrusão L4-L5'), null);
  assert.equal(midiaNaoLidaDoTurno('oi, quero marcar'), null);
});

test('liteAudioSemLeitura: só ÁUDIO do paciente que a rota oficial lista e ninguém leu (figurinha, reação e foto ficam como antes)', () => {
  const aviso = 'Você recebeu uma mensagem de mídia (ID da mensagem: 3EB0A1B2C3D4E5F6)';
  const agora = Date.parse('2026-11-27T13:00:00Z');
  const msg = (extra: Partial<MensagemOficial>): MensagemOficial =>
    ({ id: 'm1', em: new Date(agora - 60_000), autor: 'paciente', direcao: 'entrada', texto: '', anexo: { tipo: 'voice', link: null }, ...extra }) as MensagemOficial;
  const base = { humanMessage: aviso, transcritos: new Set<string>(), leituraNoWebhook: false, msgs: [msg({})], agora };
  // o áudio está listado (ainda sem link, ou com link mas sem transcrição): não foi lido
  assert.equal(liteAudioSemLeitura(base), true);
  assert.equal(liteAudioSemLeitura({ ...base, msgs: [msg({ anexo: { tipo: 'voice', link: 'https://x/a.ogg' } })] }), true);
  // foi transcrito pela rota oficial, ou o webhook já leu
  assert.equal(liteAudioSemLeitura({ ...base, transcritos: new Set(['m1']) }), false);
  // o áudio ANTIGO já transcrito (outro id) não desliga a marca do áudio novo
  assert.equal(liteAudioSemLeitura({ ...base, transcritos: new Set(['m0-antigo']) }), true);
  assert.equal(liteAudioSemLeitura({ ...base, leituraNoWebhook: true }), false);
  // figurinha/foto/reação: o aviso é o mesmo, mas não é áudio
  assert.equal(liteAudioSemLeitura({ ...base, msgs: [msg({ anexo: { tipo: 'sticker', link: null } })] }), false);
  assert.equal(liteAudioSemLeitura({ ...base, msgs: [msg({ anexo: { tipo: 'pic', link: null } })] }), false);
  // rota oficial não lida, áudio antigo, áudio que a Sofia já respondeu, ou nem é aviso de mídia
  assert.equal(liteAudioSemLeitura({ ...base, msgs: null }), false);
  assert.equal(liteAudioSemLeitura({ ...base, msgs: [msg({ em: new Date(agora - 20 * 60_000) })] }), false);
  assert.equal(liteAudioSemLeitura({ ...base, msgs: [msg({}), msg({ id: 'm2', autor: 'sofia', direcao: 'saida', anexo: undefined, em: new Date(agora - 30_000) })] }), false);
  assert.equal(liteAudioSemLeitura({ ...base, humanMessage: 'oi, quero marcar' }), false);
});

test('a resposta do modelo que já pede para escrever ou passa para a equipe NÃO é trocada (nunca em dobro)', () => {
  for (const r of [
    'Não consegui ouvir seu áudio agora 🙏 Pode me escrever rapidinho?',
    'Ai, não consegui abrir a sua foto. Me escreve o que você queria falar?',
    'Puxa, o áudio não carregou. Pode mandar de novo ou digitar aqui pra mim?',
    'Já pedi pra alguém da nossa equipe ouvir seu áudio e continuar por aqui 🙏',
  ]) {
    assert.ok(respostaJaTrataDaMidia(r), r);
    assert.equal(respostaDeMidiaNaoLida({ entrada: AUDIO_SEM_OUVIR, resposta: r, ferramentas: [], falas: [p('...')], agoraLocal: AGORA }), null, r);
  }
});

test('silêncio, despedida ou "ótimo!" como se tivesse ouvido: sai a frase fixa', () => {
  for (const r of [
    '',
    'Qualquer coisa, é só me chamar por aqui ☺',
    'Perfeito! Então fica combinado, te espero lá 😊',
    'Entendi! Nossa equipe confirma o horário com você.',
  ]) {
    const saida = respostaDeMidiaNaoLida({ entrada: AUDIO_SEM_OUVIR, resposta: r, ferramentas: [], falas: [p('oi'), ia('Oi! Como posso te chamar?'), p('...')], agoraLocal: AGORA });
    assert.equal(saida?.tipo, 'audio', r);
    assert.equal(saida?.texto, 'Não consegui abrir seu áudio aqui 🙏 Pode me escrever o que você queria falar?', r);
  }
});

test('o texto muda com o tipo da mídia', () => {
  assert.equal(fraseDeMidiaNaoLida('imagem'), 'Não consegui abrir sua foto aqui 🙏 Pode me escrever o que você queria falar?');
  assert.equal(fraseDeMidiaNaoLida('arquivo'), 'Não consegui abrir seu arquivo aqui 🙏 Pode me escrever o que você queria falar?');
  assert.equal(fraseDeMidiaNaoLida('midia'), 'Não consegui abrir o que você mandou aqui 🙏 Pode me escrever o que você queria falar?');
});

test('já passou para a equipe neste turno (pausar_ia): não mexe', () => {
  assert.equal(
    respostaDeMidiaNaoLida({ entrada: AUDIO_SEM_OUVIR, resposta: 'Tá bom', ferramentas: ['pausar_ia'], falas: [p('...')], agoraLocal: AGORA }),
    null,
  );
});

test('não repete a mesma frase duas vezes seguidas', () => {
  const falas = [p('...'), ia('Não consegui abrir seu áudio aqui 🙏 Pode me escrever o que você queria falar?'), p('...')];
  assert.equal(respostaDeMidiaNaoLida({ entrada: AUDIO_SEM_OUVIR, resposta: '', ferramentas: [], falas, agoraLocal: AGORA }), null);
});

test('horários na mesa: repete os 2 da última fala da Sofia, com dia da semana', () => {
  const falas = [
    p('quero marcar'),
    ia('Tenho terça 01/12 às 16h ou quarta 02/12 às 9h30. Qual fica melhor pra você?'),
    p(AUDIO_SEM_OUVIR),
  ];
  assert.deepEqual(horariosNaMesa(falas, AGORA), ['terça 01/12 às 16h', 'quarta 02/12 às 9h30']);
  const saida = respostaDeMidiaNaoLida({ entrada: AUDIO_SEM_OUVIR, resposta: '', ferramentas: [], falas, agoraLocal: AGORA });
  assert.equal(
    saida?.texto,
    'Não consegui abrir seu áudio aqui 🙏 Pode me escrever o que você queria falar? Se for sobre o horário: terça 01/12 às 16h ou quarta 02/12 às 9h30?',
  );
});

test('horário que já passou, oferta sem dia ou fala que não oferece nada: não entra', () => {
  assert.deepEqual(horariosNaMesa([ia('Tenho sexta 27/11 às 8h ou segunda 30/11 às 15h, qual prefere?')], AGORA), ['segunda 30/11 às 15h']);
  assert.deepEqual(horariosNaMesa([ia('Oi! Como posso te chamar?')], AGORA), []);
  assert.deepEqual(horariosNaMesa([], AGORA), []);
  // só a ÚLTIMA fala dela conta: a oferta de antes já foi superada
  assert.deepEqual(
    horariosNaMesa([ia('Tenho terça 01/12 às 16h ou quarta 02/12 às 9h, qual prefere?'), p('hum'), ia('Tudo bem, fico no aguardo 😊')], AGORA),
    [],
  );
});

test('rótulo do horário: dia da semana certo e minutos só quando existem', () => {
  assert.equal(rotuloDoHorario({ data: '2026-12-01', hora: '16:00' }), 'terça 01/12 às 16h');
  assert.equal(rotuloDoHorario({ data: '2026-12-05', hora: '08:30' }), 'sábado 05/12 às 8h30');
});

test('unidade que não ouve áudio: o recado manda passar para a equipe e proíbe pedir para escrever — o código não contraria', () => {
  const handoff = `${AUDIO_NAO_OUVIDO}\n\n${instrucaoAudioNaoTranscrito(true)}`;
  assert.ok(instrucaoAudioNaoTranscrito(true).includes(INSTRUCAO_DE_PASSAR_PARA_EQUIPE));
  assert.ok(!instrucaoAudioNaoTranscrito(false).includes(INSTRUCAO_DE_PASSAR_PARA_EQUIPE));
  assert.equal(midiaNaoLidaDoTurno(handoff), null);
  assert.equal(respostaDeMidiaNaoLida({ entrada: handoff, resposta: 'Certo!', ferramentas: [], falas: [p('...')], agoraLocal: AGORA }), null);
});

test('nit: o modelo AGENDOU/remarcou/cancelou/confirmou neste turno: a frase fixa não troca a resposta', () => {
  for (const f of ['agendar_consulta', 'remarcar_consulta', 'cancelar_consulta', 'confirmar_presenca']) {
    assert.equal(
      respostaDeMidiaNaoLida({ entrada: AUDIO_SEM_OUVIR, resposta: 'Pronto, deixei marcado!', ferramentas: ['consultar_horarios', f], falas: [p('...')], agoraLocal: AGORA }),
      null,
      f,
    );
  }
  // consultar a agenda sozinho não é resolver: a frase fixa ainda entra
  assert.equal(
    respostaDeMidiaNaoLida({ entrada: AUDIO_SEM_OUVIR, resposta: '', ferramentas: ['consultar_horarios'], falas: [p('...')], agoraLocal: AGORA })?.tipo,
    'audio',
  );
});

test('7: o <conversa_oficial> com texto da equipe ou áudio recuperado conta como conteúdo; o que continua mídia sem leitura não', () => {
  const comTexto = `<conversa_oficial>\nO que aconteceu no WhatsApp desde a sua última mensagem (rota oficial), em ordem:\n- 27/11 10:00 · Paciente: [áudio transcrito] "quero marcar na terça"\nConsidere estas mensagens do paciente como parte da conversa.\n</conversa_oficial>\n\n${AUDIO_SEM_OUVIR}`;
  assert.equal(midiaNaoLidaDoTurno(comTexto), null);
  assert.equal(respostaDeMidiaNaoLida({ entrada: comTexto, resposta: 'Perfeito, terça então!', ferramentas: [], falas: [p('...')], agoraLocal: AGORA }), null);
  const daEquipe = `<conversa_oficial>\n- 27/11 10:00 · Equipe (Lia): "Oi, tudo bem? Posso te ajudar?"\nA EQUIPE HUMANA já falou.\n</conversa_oficial>\n\n${AUDIO_SEM_OUVIR}`;
  assert.equal(midiaNaoLidaDoTurno(daEquipe), null);
  // o bloco só com mídia que continua sem leitura NÃO conta como conteúdo
  const semLeitura = `<conversa_oficial>\nO que aconteceu:\n- 27/11 10:00 · Paciente: [áudio]\n- 27/11 10:01 · Paciente: [mensagem vazia]\nConsidere estas mensagens.\n</conversa_oficial>\n\n${AUDIO_SEM_OUVIR}`;
  assert.equal(midiaNaoLidaDoTurno(semLeitura), 'audio');
});

test('o texto FINAL é o testado: a frase fixa passa intacta pelo filtro de diminutivos e de intimidade do grafo', () => {
  const horarios = ['terça 01/12 às 16h', 'quarta 02/12 às 9h30'];
  for (const tipo of ['audio', 'imagem', 'arquivo', 'midia'] as const) {
    for (const h of [[], horarios]) {
      const frase = fraseDeMidiaNaoLida(tipo, h);
      assert.equal(semIntimidade(semDiminutivo(frase)), frase, `${tipo} ${h.length}`);
      assert.doesNotMatch(frase, /inh[oa]\b/i);
    }
  }
});

const agoraLite = Date.parse('2026-11-27T13:00:00Z');
const voz = (id: string, minAtras: number): MensagemOficial =>
  ({ id, em: new Date(agoraLite - minAtras * 60_000), autor: 'paciente', direcao: 'entrada', texto: '', anexo: { tipo: 'voice', link: null } }) as MensagemOficial;

test('6: só o áudio DESTE turno transcrito zera a contagem; um áudio antigo transcrito não', () => {
  const msgs = [voz('antigo', 4), voz('novo', 1)];
  // o antigo foi transcrito, o do turno não: nada a zerar, e o do turno continua não lido
  assert.equal(audioDoTurnoFoiTranscrito(msgs, new Set(['antigo']), agoraLite), false);
  assert.deepEqual(idsDeAudioNaoLido(msgs, new Set(['antigo']), agoraLite), ['novo']);
  // todos os do turno transcritos: zera
  assert.equal(audioDoTurnoFoiTranscrito(msgs, new Set(['antigo', 'novo']), agoraLite), true);
  assert.deepEqual(idsDeAudioNaoLido(msgs, new Set(['antigo', 'novo']), agoraLite), []);
  // sem áudio nenhum no turno: não zera
  assert.equal(audioDoTurnoFoiTranscrito([], new Set(['x']), agoraLite), false);
  assert.equal(audioDoTurnoFoiTranscrito(null, new Set(), agoraLite), false);
  // transcrição "sem fala" (vazia) conta como lida: o webhook põe o id em `transcritos` mesmo com texto vazio (conversa-oficial.ts)
  assert.equal(audioDoTurnoFoiTranscrito([voz('mudo', 1)], new Set(['mudo']), agoraLite), true);
});

test('nit: cada áudio não lido conta UMA vez, pelo id (o mesmo áudio em 2 turnos não é a 2ª falha)', () => {
  let n = 0;
  const registrar = () => ++n;
  esquecerFalhasDoLite('c1');
  assert.equal(contarFalhaDoLite('c1', ['a1'], registrar), 1);
  assert.equal(contarFalhaDoLite('c1', ['a1'], registrar), 1); // mesmo áudio de novo
  assert.equal(contarFalhaDoLite('c1', ['a1'], registrar), 1);
  assert.equal(contarFalhaDoLite('c1', ['a2'], registrar), 2); // outro áudio: 2ª falha seguida
  assert.equal(contarFalhaDoLite('c1', ['a1', 'a2'], registrar), 2);
  esquecerFalhasDoLite('c1');
  n = 0;
  assert.equal(contarFalhaDoLite('c1', ['a1'], registrar), 1); // depois de zerar, conta de novo
});

test('rajada: DOIS áudios novos no MESMO turno contam como UMA falha (como o webhook), não vão para a equipe no 1º turno', () => {
  let n = 0;
  const registrar = () => ++n;
  esquecerFalhasDoLite('c2');
  assert.equal(contarFalhaDoLite('c2', ['b1', 'b2'], registrar), 1);
  assert.equal(n, 1, 'registrar chamado uma vez só no turno');
  assert.equal(contarFalhaDoLite('c2', ['b1', 'b2', 'b3'], registrar), 2); // turno seguinte, áudio novo: 2ª falha seguida
  esquecerFalhasDoLite('c2');
});

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
  liteAudioSemLeitura,
  MARCA_ANEXO_NAO_LIDO_DO_TURNO,
  midiaNaoLidaDoTurno,
  respostaDeMidiaNaoLida,
  respostaJaTrataDaMidia,
  rotuloDoHorario,
} from './midia-nao-lida.js';
import { AUDIO_NAO_OUVIDO, instrucaoAudioNaoTranscrito } from '../controllers/webhook.controller.js';
import { MARCA_ANEXO_NAO_LIDO } from '../lib/anexos-do-turno.js';
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
  const base = { humanMessage: aviso, blocoOficial: '', leituraNoWebhook: false, msgs: [msg({})], agora };
  // o áudio está listado (ainda sem link, ou com link mas sem transcrição): não foi lido
  assert.equal(liteAudioSemLeitura(base), true);
  assert.equal(liteAudioSemLeitura({ ...base, msgs: [msg({ anexo: { tipo: 'voice', link: 'https://x/a.ogg' } })] }), true);
  // foi transcrito pela rota oficial, ou o webhook já leu
  assert.equal(liteAudioSemLeitura({ ...base, blocoOficial: '<conversa_oficial>\n- 10:00 · Paciente: [áudio transcrito] "quero marcar"\n</conversa_oficial>' }), false);
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
    assert.equal(saida?.texto, 'Não consegui abrir seu áudio aqui 🙏 Me escreve rapidinho?', r);
  }
});

test('o texto muda com o tipo da mídia', () => {
  assert.equal(fraseDeMidiaNaoLida('imagem'), 'Não consegui abrir sua foto aqui 🙏 Me escreve rapidinho?');
  assert.equal(fraseDeMidiaNaoLida('arquivo'), 'Não consegui abrir seu arquivo aqui 🙏 Me escreve rapidinho?');
  assert.equal(fraseDeMidiaNaoLida('midia'), 'Não consegui abrir o que você mandou aqui 🙏 Me escreve rapidinho?');
});

test('já passou para a equipe neste turno (pausar_ia): não mexe', () => {
  assert.equal(
    respostaDeMidiaNaoLida({ entrada: AUDIO_SEM_OUVIR, resposta: 'Tá bom', ferramentas: ['pausar_ia'], falas: [p('...')], agoraLocal: AGORA }),
    null,
  );
});

test('não repete a mesma frase duas vezes seguidas', () => {
  const falas = [p('...'), ia('Não consegui abrir seu áudio aqui 🙏 Me escreve rapidinho?'), p('...')];
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
    'Não consegui abrir seu áudio aqui 🙏 Me escreve rapidinho? Se for sobre o horário: terça 01/12 às 16h ou quarta 02/12 às 9h30?',
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

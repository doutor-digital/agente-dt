/**
 * IA no Chatwoot: só mensagem do paciente em caixa do mapa; áudio vira nota de transcrição; a Sofia roda 60 s depois da ÚLTIMA fala,
 * só se a equipe não respondeu, com teto por dia, e deixa nota com resposta + ações. Desligado não faz nada.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Unit } from '@prisma/client';
import type { Estado } from './automacoes-estado.js';
import {
  aoChegar,
  chaveDoEvento,
  chaveDoEventoConfere,
  ESPERA_SOFIA_MS,
  falasDaConversa,
  mensagemDoPaciente,
  notaDaSofia,
  notaDaTranscricao,
  novaMemoriaDaIa,
  rodarSofia,
  TETO_SOFIA_POR_DIA,
  type Fala,
  type PortasDaIa,
} from './chatwoot-ia.js';

const evento = (o: Record<string, unknown> = {}) => ({
  event: 'message_created',
  message_type: 'incoming',
  private: false,
  content: 'oi',
  conversation: { id: 12, inbox_id: 2 },
  sender: { identifier: '559481854046@s.whatsapp.net' },
  attachments: [],
  ...o,
});

test('chave do evento: 32 caracteres, só a certa', () => {
  const k = chaveDoEvento('tok');
  assert.equal(k.length, 32);
  assert.equal(chaveDoEventoConfere('tok', k), true);
  assert.equal(chaveDoEventoConfere('outro', k), false);
  assert.equal(chaveDoEventoConfere(undefined, k), false);
});

test('mensagem do paciente: só incoming, pública, de caixa do mapa, fora de grupo; pega os áudios', () => {
  assert.deepEqual(mensagemDoPaciente(evento()), { conversa: 12, caixa: 2, slug: 'doutor-hernia-parauapebas', audios: [] });
  assert.equal(mensagemDoPaciente(evento({ message_type: 'outgoing' })), null);
  assert.equal(mensagemDoPaciente(evento({ private: true })), null);
  assert.equal(mensagemDoPaciente(evento({ conversation: { id: 12, inbox_id: 1 } })), null);
  assert.equal(mensagemDoPaciente(evento({ event: 'conversation_updated' })), null);
  assert.equal(mensagemDoPaciente(evento({ sender: { identifier: '1203630@g.us' } })), null);
  const a = mensagemDoPaciente(evento({ attachments: [{ file_type: 'audio', data_url: 'https://x/a.ogg' }, { file_type: 'image', data_url: 'https://x/i.jpg' }] }));
  assert.deepEqual(a!.audios, ['https://x/a.ogg']);
});

const msg = (tipo: number, content: string, o: Record<string, unknown> = {}) => ({ message_type: tipo, content, private: false, ...o });

test('falas: só públicas, junta o mesmo lado, áudio usa a transcrição da nota, termina no paciente', () => {
  const m = [
    msg(1, 'Olá! Aqui é da Doutor Hérnia.'),
    msg(0, 'oi'),
    msg(0, 'tenho dor na lombar'),
    msg(1, 'nota interna', { private: true }),
    msg(0, '', { attachments: [{ file_type: 'audio' }] }),
    msg(1, notaDaTranscricao('faz seis meses que dói'), { private: true }),
    msg(2, 'Atribuído a Fulana'),
  ];
  assert.deepEqual(falasDaConversa(m), [{ role: 'user', content: 'oi\ntenho dor na lombar\nfaz seis meses que dói' }]);
  // a equipe respondeu por último: não roda
  assert.equal(falasDaConversa([...m, msg(1, 'Entendi, me conta mais')]), null);
  // áudio sem transcrição
  assert.deepEqual(falasDaConversa([msg(0, '', { attachments: [{ file_type: 'audio' }] })]), [{ role: 'user', content: '[áudio]' }]);
  assert.equal(falasDaConversa([]), null);
});

test('falas: corta no máximo e começa sempre pelo paciente', () => {
  const m: any[] = [];
  for (let i = 0; i < 10; i++) m.push(msg(0, `p${i}`), msg(1, `n${i}`));
  m.push(msg(0, 'última'));
  const f = falasDaConversa(m, 4)!;
  assert.equal(f[0]!.role, 'user');
  assert.equal(f.at(-1)!.content, 'última');
  assert.ok(f.length <= 4);
});

test('nota da Sofia: resposta e ações em português curto', () => {
  const n = notaDaSofia('Oi! Onde dói?', [{ tool: 'atualizar_campos', args: { queixa: 'lombar', vazio: '' } }]);
  assert.ok(n.startsWith('🧪 [SECO] Sofia responderia:\n\nOi! Onde dói?'));
  assert.match(n, /Ações que ela tomaria:\n• atualizar_campos — queixa: lombar$/);
  assert.equal(notaDaSofia('ok', []), '🧪 [SECO] Sofia responderia:\n\nok');
});

function portas(o: { estado?: Estado; mensagens?: any[]; falhaTranscricao?: boolean } = {}) {
  const notas: Array<{ conversa: number; texto: string }> = [];
  const agendados: Array<{ fn: () => void; ms: number; cancelado: boolean }> = [];
  const sofias: Fala[][] = [];
  const p: PortasDaIa = {
    estado: () => o.estado ?? 'seco',
    unidade: async () => ({ slug: 'doutor-hernia-parauapebas' }) as Unit,
    mensagens: async () => o.mensagens ?? [msg(0, 'oi, quanto custa?')],
    nota: async (conversa, texto) => {
      notas.push({ conversa, texto });
    },
    transcrever: async () => {
      if (o.falhaTranscricao) throw new Error('sem chave');
      return 'dor no joelho';
    },
    sofia: async (_u, falas) => {
      sofias.push(falas);
      return { resposta: 'A consulta é R$ 350.', acoes: [] };
    },
    agendar: (fn, ms) => {
      const a = { fn, ms, cancelado: false };
      agendados.push(a);
      return a;
    },
    cancelar: (t) => {
      (t as { cancelado: boolean }).cancelado = true;
    },
    hoje: () => '2026-11-12',
  };
  return { p, notas, agendados, sofias };
}

const M = { conversa: 12, caixa: 2, slug: 'doutor-hernia-parauapebas', audios: [] as string[] };

test('desligado: nada (nem transcrição, nem Sofia)', async () => {
  const { p, notas, agendados } = portas({ estado: 'desligado' });
  await aoChegar({ ...M, audios: ['https://x/a.ogg'] }, p, novaMemoriaDaIa());
  assert.equal(notas.length, 0);
  assert.equal(agendados.length, 0);
});

test('áudio vira nota de transcrição na hora; falha de transcrição não derruba a Sofia', async () => {
  const a = portas();
  await aoChegar({ ...M, audios: ['https://x/a.ogg'] }, a.p, novaMemoriaDaIa());
  assert.equal(a.notas[0]!.texto, notaDaTranscricao('dor no joelho'));
  assert.equal(a.agendados.length, 1);
  const b = portas({ falhaTranscricao: true });
  await aoChegar({ ...M, audios: ['https://x/a.ogg'] }, b.p, novaMemoriaDaIa());
  assert.equal(b.notas.length, 0);
  assert.equal(b.agendados.length, 1);
});

test('Sofia: 60 s depois da ÚLTIMA fala (cada fala nova reagenda); deixa a nota', async () => {
  const { p, notas, agendados, sofias } = portas();
  const mem = novaMemoriaDaIa();
  await aoChegar(M, p, mem);
  await aoChegar(M, p, mem);
  assert.equal(agendados.length, 2);
  assert.equal(agendados[0]!.cancelado, true);
  assert.equal(agendados[1]!.ms, ESPERA_SOFIA_MS);
  agendados[1]!.fn();
  await new Promise((r) => setImmediate(r));
  assert.equal(sofias.length, 1);
  assert.equal(notas.at(-1)!.texto, '🧪 [SECO] Sofia responderia:\n\nA consulta é R$ 350.');
});

test('Sofia: não roda se a equipe respondeu por último; teto por dia', async () => {
  const a = portas({ mensagens: [msg(0, 'oi'), msg(1, 'Olá!')] });
  assert.equal(await rodarSofia(M, a.p, novaMemoriaDaIa()), 'equipe-respondeu');
  assert.equal(a.sofias.length, 0);
  const b = portas();
  const mem = novaMemoriaDaIa();
  mem.rodadas.set('doutor-hernia-parauapebas|2026-11-12', TETO_SOFIA_POR_DIA);
  assert.equal(await rodarSofia(M, b.p, mem), 'teto');
  assert.equal(b.sofias.length, 0);
  mem.rodadas.set('doutor-hernia-parauapebas|2026-11-12', TETO_SOFIA_POR_DIA - 1);
  assert.equal(await rodarSofia(M, b.p, mem), 'nota');
});

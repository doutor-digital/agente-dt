/**
 * "Lida" do Evolution → Chatwoot: lê o webhook, acha a conversa pelo telefone (com e sem o 9) e marca como vista; rajada do mesmo
 * telefone vira uma marcação só; alvo velho (conversa trocou) é refeito uma vez.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  avisoDaLeitura,
  chaveDaLida,
  chaveDaLidaConfere,
  INTERVALO_MESMO_TELEFONE_MS,
  mesmoTelefone,
  novaMemoriaDaLida,
  processarLeitura,
  type Alvo,
  type PortaDaLida,
} from './chatwoot-lida.js';

const lido = (o: Record<string, unknown> = {}) => ({
  event: 'messages.update',
  instance: 'parauapebas-unidade',
  data: { keyId: 'A55D', remoteJid: '559499745062@s.whatsapp.net', fromMe: true, status: 'READ', ...o },
});

test('chave: 32 caracteres, confere só a certa', () => {
  const k = chaveDaLida('tok');
  assert.equal(k.length, 32);
  assert.equal(chaveDaLidaConfere('tok', k), true);
  assert.equal(chaveDaLidaConfere('tok', k.replace(/.$/, k.endsWith('0') ? '1' : '0')), false);
  assert.equal(chaveDaLidaConfere(undefined, k), false);
  assert.equal(chaveDaLidaConfere('tok', undefined), false);
});

test('aviso: só leitura (READ/PLAYED) de mensagem NOSSA, com telefone', () => {
  assert.deepEqual(avisoDaLeitura(lido()), { instancia: 'parauapebas-unidade', telefone: '559499745062' });
  assert.deepEqual(avisoDaLeitura({ ...lido(), event: 'MESSAGES_UPDATE' })?.telefone, '559499745062');
  assert.ok(avisoDaLeitura(lido({ status: 'PLAYED' })));
  assert.equal(avisoDaLeitura(lido({ status: 'DELIVERY_ACK' })), null);
  assert.equal(avisoDaLeitura(lido({ fromMe: false })), null);
  assert.equal(avisoDaLeitura(lido({ remoteJid: '1203630@g.us' })), null);
  // @lid sem número: fora; @lid com o número alternativo: usa o alternativo
  assert.equal(avisoDaLeitura(lido({ remoteJid: '1234567890@lid' })), null);
  assert.equal(avisoDaLeitura(lido({ remoteJid: '1234567890@lid', remoteJidAlt: '5594988887777@s.whatsapp.net' }))?.telefone, '5594988887777');
  assert.equal(avisoDaLeitura({ ...lido(), event: 'messages.upsert' }), null);
  // lista: pega o primeiro que vale
  assert.equal(avisoDaLeitura({ ...lido(), data: [{ status: 'DELIVERY_ACK', fromMe: true }, lido().data] })?.telefone, '559499745062');
  assert.equal(avisoDaLeitura(null), null);
});

test('mesmo telefone: com e sem o 9, mesmo DDD', () => {
  assert.equal(mesmoTelefone('+559499745062', '5594999745062'), true);
  assert.equal(mesmoTelefone('+5594999745062', '559499745062'), true);
  assert.equal(mesmoTelefone('+5563999745062', '559499745062'), false);
  assert.equal(mesmoTelefone('+559499745063', '559499745062'), false);
  assert.equal(mesmoTelefone('123', '559499745062'), false);
});

function portaFalsa(o: { alvos?: Array<Alvo | null>; falhaNoPrimeiroMarcar?: boolean } = {}) {
  const alvos = [...(o.alvos ?? [{ conversa: 14, sourceId: 'src' }])];
  const chamadas = { identificador: 0, alvo: 0, marcar: [] as Array<{ id: string; alvo: Alvo }> };
  let falhou = false;
  const porta: PortaDaLida = {
    async inboxIdentifier() {
      chamadas.identificador++;
      return 'IDENT';
    },
    async alvo() {
      chamadas.alvo++;
      return alvos.length > 1 ? alvos.shift()! : (alvos[0] ?? null);
    },
    async marcar(id, alvo) {
      if (o.falhaNoPrimeiroMarcar && !falhou) {
        falhou = true;
        throw new Error('Chatwoot 404');
      }
      chamadas.marcar.push({ id, alvo });
    },
  };
  return { porta, chamadas };
}

const AVISO = { instancia: 'parauapebas-unidade', telefone: '559499745062' };

test('processar: marca; rajada do mesmo telefone vira uma só; depois do intervalo marca de novo usando o alvo guardado', async () => {
  const { porta, chamadas } = portaFalsa();
  const mem = novaMemoriaDaLida();
  assert.equal(await processarLeitura(AVISO, porta, mem, 1_000), 'marcada');
  assert.equal(await processarLeitura(AVISO, porta, mem, 2_000), 'repetida');
  assert.equal(await processarLeitura(AVISO, porta, mem, 1_000 + INTERVALO_MESMO_TELEFONE_MS), 'marcada');
  assert.equal(chamadas.marcar.length, 2);
  assert.deepEqual(chamadas.marcar[0], { id: 'IDENT', alvo: { conversa: 14, sourceId: 'src' } });
  assert.equal(chamadas.identificador, 1);
  assert.equal(chamadas.alvo, 1);
});

test('processar: instância fora do mapa é ignorada; contato sem conversa na caixa não marca', async () => {
  const { porta, chamadas } = portaFalsa({ alvos: [null] });
  const mem = novaMemoriaDaLida();
  assert.equal(await processarLeitura({ ...AVISO, instancia: 'analista-dt' }, porta, mem, 0), 'ignorada');
  assert.equal(await processarLeitura(AVISO, porta, mem, 0), 'sem-conversa');
  assert.equal(chamadas.marcar.length, 0);
});

test('processar: alvo guardado falhou (conversa trocou) → acha de novo e marca na nova', async () => {
  const { porta, chamadas } = portaFalsa({ alvos: [{ conversa: 14, sourceId: 'src' }, { conversa: 20, sourceId: 'src' }], falhaNoPrimeiroMarcar: true });
  const mem = novaMemoriaDaLida();
  assert.equal(await processarLeitura(AVISO, porta, mem, 0), 'marcada');
  assert.deepEqual(chamadas.marcar.map((m) => m.alvo.conversa), [20]);
  assert.equal(mem.alvos.get('2:559499745062')!.alvo.conversa, 20);
});

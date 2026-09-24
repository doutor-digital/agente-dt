import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

/**
 * A trava de coração precisa estar em TODOS os caminhos que falam com o paciente,
 * não só no principal.
 *
 * Em 21/09/2026 eu disse ao João que o coração tinha acabado. O Codex mostrou que
 * não: a trava vivia só no cliente do Kommo (`downgradeEmoji`), e resposta COM
 * BOTÃO sai por outro caminho — `enviarMensagemDeChat` — que mandava o texto cru.
 * Botão está ligado por padrão em todas as unidades, então era o caminho comum.
 *
 * Este teste é um vigia de arquitetura: se alguém criar um novo caminho de envio
 * sem a trava, ele falha aqui em vez de falhar na frente de um paciente.
 */
const arquivo = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');

test('o envio direto de chat (botões, cartão de chegada) limpa coração', () => {
  const src = arquivo('../services/kommo-chat.service.ts');
  assert.match(src, /import \{ semCoracao \}/, 'kommo-chat.service não importa semCoracao');
  // o texto e o rótulo do botão passam por semCoracao antes de sair
  assert.match(src, /const texto = semCoracao\(/, 'o texto da mensagem não passa por semCoracao');
  assert.match(src, /text: semCoracao\(/, 'o rótulo do botão não passa por semCoracao');
});

/**
 * Mesmo vigia, para o diminutivo (23/09/2026).
 *
 * Aqui a medição foi de ~11 mil diminutivos em 30 dias, em todas as unidades. A trava vale pelo
 * mesmo motivo do coração: enquanto o exemplo ensina, a regra do prompt não pega — e caminho de
 * envio novo sem a trava é o jeito de o problema voltar.
 */
test('a trava de diminutivo fica no ponto único, antes de qualquer entrega', () => {
  const graph = arquivo('../agent/graph.ts');
  assert.match(graph, /import \{ semDiminutivo \}/, 'graph.ts não importa semDiminutivo');
  assert.match(
    graph,
    /aplicarGuardrail\(semDiminutivo\(textoFinal\)/,
    'a resposta final não passa por semDiminutivo',
  );
});

test('a trava de diminutivo NÃO fica no cliente do Kommo — lá ela reescreveria o CRM', () => {
  // `downgradeEmoji` não é porta de saída: é o sanitizador do cliente, usado também para gravar
  // campo, nota e tarefa. Uma observação do paciente ("sente uma dorzinha") não pode ser
  // reescrita no cartão — isso muda o que ele disse.
  const kommo = arquivo('../services/kommo.service.ts');
  assert.doesNotMatch(kommo, /semDiminutivo/, 'semDiminutivo voltou para o cliente do Kommo');
  const chat = arquivo('../services/kommo-chat.service.ts');
  assert.doesNotMatch(chat, /semDiminutivo/, 'semDiminutivo voltou para o serviço de chat');
});

test('o cliente do Kommo limpa coração antes de qualquer envio', () => {
  const src = arquivo('../services/kommo.service.ts');
  const fn = src.slice(src.indexOf('export function downgradeEmoji'));
  assert.match(fn.slice(0, 600), /semCoracao\(/, 'downgradeEmoji não chama semCoracao');
});

test('a tabela de downgrade não converte coração em ♥ de novo', () => {
  // era isto que fazia a regra do prompt nunca pegar: ❤️ virava ♥ em vez de sumir
  const src = arquivo('../services/kommo.service.ts');
  const mapa = src.slice(src.indexOf('EMOJI_BMP_DOWNGRADE'), src.indexOf('export function paraNumero'));
  assert.doesNotMatch(mapa, /'♥'/, 'a tabela de downgrade voltou a produzir ♥');
});

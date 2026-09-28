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
test('as travas de tom envolvem textoFinal na MESMA expressão, antes do guardrail', () => {
  const graph = arquivo('../agent/graph.ts');
  assert.match(graph, /import \{ semDiminutivo \}/, 'graph.ts não importa semDiminutivo');
  assert.match(graph, /import \{ semIntimidade \}/, 'graph.ts não importa semIntimidade');
  // O invariante é a composição: as duas travas em volta de textoFinal, dentro do
  // guardrail. A ordem entre elas não importa; ficar de fora, sim. Uma asserção solta
  // em /semIntimidade\(/ passaria mesmo se a trava fosse aplicada a outra variável.
  assert.match(
    graph,
    /aplicarGuardrail\(\s*sem(?:Intimidade|Diminutivo)\(\s*sem(?:Intimidade|Diminutivo)\(\s*textoFinal\s*\)\s*\)/,
    'textoFinal não passa pelas duas travas de tom dentro do aplicarGuardrail',
  );
});

/**
 * A régua de follow-up é um segundo caminho de fala, e ela escapou na primeira versão
 * (26/09/2026): ia do modelo pro guardrail sem passar por trava de tom nenhuma. É o pior
 * lugar pra escapar, porque despedida — onde o tom escorrega — é quase todo o texto dela.
 *
 * Tinha uma armadilha a mais: o `return` devolvia o texto CRU quando o guardrail não
 * reescrevia, então envolver só a chamada do guardrail não resolveria nada.
 */
test('a régua de follow-up passa pelas mesmas travas, e devolve o texto TRATADO', () => {
  const src = arquivo('../agent/follow-up.ts');
  assert.match(src, /import \{ semDiminutivo \}/, 'follow-up.ts não importa semDiminutivo');
  assert.match(src, /import \{ semIntimidade \}/, 'follow-up.ts não importa semIntimidade');
  assert.match(
    src,
    /sem(?:Intimidade|Diminutivo)\(\s*sem(?:Intimidade|Diminutivo)\(\s*limpo\s*\)\s*\)/,
    'o texto da régua não passa pelas duas travas de tom',
  );
  assert.doesNotMatch(
    src,
    /guard\.rewritten \? guard\.text : limpo/,
    'a régua voltou a devolver o texto cru quando o guardrail não reescreve',
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

/**
 * A Sofia tem de ver a conversa da SDR nos DOIS caminhos de entrada.
 *
 * Em 26/09/2026 descobrimos que `blocoDaConversaOficial` vivia só no webhook, e que 16
 * unidades falam pelo salesbot — Serra, Bebedouro, Rio Verde, Boa Vista, Taubaté e outras.
 * Nelas a Sofia respondia cega para o que a SDR havia combinado. O lead 22828271 da Serra
 * pagou a conta: pediu a chave Pix e ouviu "vou confirmar com a equipe", com a chave certa
 * no prompt.
 *
 * É o mesmo vigia dos outros testes deste arquivo, pelo mesmo motivo: caminho novo sem a
 * peça é como o problema volta.
 */
test('os dois caminhos de entrada leem a conversa oficial do Kommo', () => {
  for (const arq of ['../controllers/webhook.controller.ts', '../controllers/salesbot.controller.ts']) {
    const src = arquivo(arq);
    assert.match(src, /import \{ blocoDaConversaOficial \}/, `${arq} não importa blocoDaConversaOficial`);
    assert.match(src, /await blocoDaConversaOficial\(/, `${arq} não chama blocoDaConversaOficial`);
    // O bloco tem de chegar ao modelo, não só ser calculado e jogado fora.
    assert.match(
      src,
      /new HumanMessage\(entradaDoModelo\)/,
      `${arq} calcula o bloco mas manda outra coisa pro modelo`,
    );
  }
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

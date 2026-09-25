/**
 * A faxina do inbox — e as duas coisas que ela nunca pode fazer.
 *
 * 1. Fechar conversa NÃO LIDA. Medido em 25/09/2026: das 3.285 abertas na rede, 372
 *    estavam sem ler. Fechá-las esconde paciente que escreveu e não foi respondido — o
 *    inbox fica bonito e o atendimento fica pior.
 * 2. Fechar sem alguém ter pedido. O padrão é SIMULAR: quem esquecer o parâmetro não
 *    varre o inbox de ninguém.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const FONTE = readFileSync(new URL('./fechar-conversas.ts', import.meta.url), 'utf8');
const CTRL = readFileSync(new URL('../controllers/faxina.controller.ts', import.meta.url), 'utf8');

test('conversa não lida nunca entra na lista de fechar', () => {
  assert.ok(
    /if\s*\(\s*!t\.is_read\s*\)\s*\{[\s\S]{0,120}continue/.test(FONTE),
    'a não lida tem de ser contada e pulada antes de virar alvo',
  );
});

test('simula por padrão: só o `false` literal fecha de verdade', () => {
  assert.ok(
    /simular\s*=\s*opts\.simular\s*!==\s*false/.test(FONTE),
    'omitir o parâmetro tem de simular, não fechar',
  );
  assert.ok(
    /corpo\.simular\s*!==\s*false/.test(CTRL),
    'a rota tem de exigir o `false` explícito — `!!simular` deixaria um corpo vazio fechar tudo',
  );
});

test('a simulação sai antes de qualquer fechamento', () => {
  const i = FONTE.indexOf('if (simular) return base;');
  // `kommo.fecharConversa`, com o objeto na frente: procurar só `fecharConversa` acha
  // antes o nome da própria `fecharConversasLidas`, e o teste passa a comparar a função
  // com ela mesma — foi o que aconteceu na primeira versão.
  const j = FONTE.indexOf('kommo.fecharConversa');
  assert.ok(i > 0, 'não achei o retorno da simulação');
  assert.ok(j > i, 'o retorno da simulação tem de vir antes da chamada que fecha');
});

test('existe teto por rodada', () => {
  assert.ok(/alvos\.slice\(0,\s*maximo\)/.test(FONTE), 'sem teto, uma chamada errada varre a conta inteira');
});

test('uma conta com várias unidades é varrida uma vez só', () => {
  assert.ok(
    /porConta/.test(CTRL) && /kommoSubdomain/.test(CTRL),
    'Imperatriz tem quatro unidades na mesma conta: rodar por unidade fecharia tudo quatro vezes',
  );
});

test('falha ao fechar não derruba a rodada', () => {
  assert.ok(/falhas\+\+/.test(FONTE), 'a falha tem de ser contada e relatada, não lançada');
});

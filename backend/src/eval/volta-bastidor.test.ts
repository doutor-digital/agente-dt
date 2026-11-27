import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { AIMessage, HumanMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages';

import {
  ehDeBastidor,
  invocarComVoltas,
  MAX_VOLTAS,
  precisaDeOutraVolta,
  producaoAceitaria,
  respostasSimuladas,
  resultadoSimulado,
  vaziaDepoisDaVolta,
  type ContextoDaVolta,
} from './volta-bastidor.js';

const ctx: ContextoDaVolta = {
  nomesDeCampo: new Set(['registra_queixa', 'registra_regiao_dor', 'salvar_cidade']),
  falasDoPaciente: ['Oi, meu nome é Maria Aparecida', 'onde fica a clínica de vcs?'],
};

const textoDe = (c: unknown) => (typeof c === 'string' ? c : '');
const ia = (content: string, chamadas: Array<{ name: string; id?: string; args?: Record<string, unknown> }> = []) =>
  new AIMessage({ content, tool_calls: chamadas.map((c) => ({ name: c.name, id: c.id, args: c.args ?? {} })) });

describe('volta-bastidor — a segunda chamada que a produção faz e o eval não fazia', () => {
  it('caso real de 27/11 (Boa Vista, "onde fica?"): só aplicar_tag e nenhum texto → outra volta', () => {
    assert.equal(precisaDeOutraVolta('', [{ name: 'aplicar_tag', id: 'toolu_1', args: { tag: 'Quente' } }], ctx), true);
  });

  it('caso real de 26/11 (Porto): atualizar_titulo_lead com o nome que o paciente disse → outra volta', () => {
    assert.equal(precisaDeOutraVolta('  \n', [{ name: 'atualizar_titulo_lead', id: 't2', args: { nome: 'Maria' } }], ctx), true);
  });

  it('registrar_campo (captura unificada, ligada no ambiente do serviço) é bastidor — 4 de 9 "(sem texto)" de 25–27/11', () => {
    assert.equal(ehDeBastidor('registrar_campo'), true);
    assert.equal(precisaDeOutraVolta('', [{ name: 'registrar_campo', id: 'a' }], ctx), true);
  });

  it('as ferramentas por regra de campo vêm da UNIDADE (registra_*, salvar_*…), não de um prefixo', () => {
    assert.equal(ehDeBastidor('salvar_cidade', ctx.nomesDeCampo), true);
    assert.equal(ehDeBastidor('registra_queixa', ctx.nomesDeCampo), true);
    assert.equal(ehDeBastidor('registra_inventada'), false);
    assert.equal(
      precisaDeOutraVolta(
        '',
        [
          { name: 'registra_queixa', id: 'a' },
          { name: 'mover_etapa', id: 'c', args: { statusId: 110676935 } },
        ],
        ctx,
      ),
      true,
    );
  });

  it('título que a produção RECUSARIA não ganha "OK" (não parece nome, ou nome que o paciente não disse)', () => {
    assert.equal(producaoAceitaria({ name: 'atualizar_titulo_lead', args: { nome: 'Ocupado' } }, ctx), false);
    assert.equal(producaoAceitaria({ name: 'atualizar_titulo_lead', args: { nome: 'Joana' } }, ctx), false);
    assert.equal(producaoAceitaria({ name: 'atualizar_titulo_lead', args: {} }, ctx), false);
    assert.equal(precisaDeOutraVolta('', [{ name: 'atualizar_titulo_lead', id: 'x', args: { nome: 'Joana' } }], ctx), false);
  });

  it('mover para ganho/perdido (142/143) a produção recusa → sem volta', () => {
    for (const statusId of [142, 143]) {
      assert.equal(producaoAceitaria({ name: 'mover_etapa', args: { statusId } }, ctx), false);
      assert.equal(precisaDeOutraVolta('', [{ name: 'mover_etapa', id: 'x', args: { statusId } }], ctx), false);
    }
    assert.equal(producaoAceitaria({ name: 'mover_etapa', args: {} }, ctx), false);
  });

  it('com texto NÃO volta: o eval avalia a fala que já veio', () => {
    assert.equal(precisaDeOutraVolta('A clínica fica na Av. Ville Roy, 4301', [{ name: 'aplicar_tag', id: 'x' }], ctx), false);
  });

  it('sem chamada nenhuma NÃO volta: resposta vazia de verdade continua reprovando', () => {
    assert.equal(precisaDeOutraVolta('', [], ctx), false);
  });

  it('ferramenta cujo resultado muda a fala NÃO volta', () => {
    for (const nome of ['consultar_horarios', 'agendar_consulta', 'remarcar_consulta', 'cancelar_consulta', 'pausar_ia']) {
      assert.equal(precisaDeOutraVolta('', [{ name: nome, id: 'x' }], ctx), false, nome);
      assert.equal(ehDeBastidor(nome, ctx.nomesDeCampo), false, nome);
    }
  });

  it('mistura de bastidor com ferramenta de verdade NÃO volta', () => {
    assert.equal(
      precisaDeOutraVolta('', [{ name: 'aplicar_tag', id: 'a' }, { name: 'consultar_horarios', id: 'b' }], ctx),
      false,
    );
  });

  it('chamada sem id NÃO volta', () => {
    assert.equal(precisaDeOutraVolta('', [{ name: 'aplicar_tag' }], ctx), false);
    assert.equal(precisaDeOutraVolta('', [{ name: 'aplicar_tag', id: '' }], ctx), false);
  });

  it('as respostas simuladas fecham cada chamada pelo id, na mesma ordem, no estilo "OK — …"', () => {
    const r = respostasSimuladas([{ name: 'aplicar_tag', id: 'toolu_1' }, { name: 'registrar_campo', id: 'toolu_2' }]);
    assert.deepEqual(r.map((m) => m.tool_call_id), ['toolu_1', 'toolu_2']);
    for (const m of r) assert.match(String(m.content), /^OK — /);
  });

  it('o resultado simulado nunca fala em teste, eval ou simulação', () => {
    for (const nome of ['aplicar_tag', 'mover_etapa', 'atualizar_titulo_lead', 'registrar_campo', 'salvar_cidade']) {
      assert.doesNotMatch(resultadoSimulado({ name: nome }), /teste|eval|simula/i, nome);
    }
  });
});

describe('invocarComVoltas — o laço, com um modelo falso', () => {
  it('bastidor sem texto → devolve resultado e chama de novo; a fala da 2ª chamada é a avaliada', async () => {
    const respostas = [ia('', [{ name: 'aplicar_tag', id: 't1', args: { tag: 'Quente' } }]), ia('Fica na Av. Ville Roy, 4301')];
    const vistas: BaseMessage[][] = [];
    const mensagens: BaseMessage[] = [new HumanMessage('onde fica?')];
    const r = await invocarComVoltas(
      async (m) => {
        vistas.push([...m]);
        return respostas.shift() as AIMessage;
      },
      mensagens,
      ctx,
      textoDe,
    );
    assert.equal(r.voltas, 1);
    assert.equal(textoDe(r.resposta.content), 'Fica na Av. Ville Roy, 4301');
    assert.deepEqual(r.anteriores.map((c) => c.name), ['aplicar_tag']);
    // a 2ª chamada viu: pergunta, a resposta com a ferramenta e o resultado dela, fechado pelo id
    assert.equal(vistas[1].length, 3);
    assert.ok(vistas[1][2] instanceof ToolMessage);
    assert.equal((vistas[1][2] as ToolMessage).tool_call_id, 't1');
  });

  it('para em MAX_VOLTAS mesmo se o modelo insistir só no bastidor', async () => {
    let chamadas = 0;
    const r = await invocarComVoltas(
      async () => {
        chamadas++;
        return ia('', [{ name: 'aplicar_tag', id: `t${chamadas}` }]);
      },
      [new HumanMessage('oi')],
      ctx,
      textoDe,
    );
    assert.equal(r.voltas, MAX_VOLTAS);
    assert.equal(chamadas, MAX_VOLTAS + 1);
  });

  it('resposta com texto na 1ª chamada: nenhuma volta, nenhuma mensagem nova', async () => {
    const mensagens: BaseMessage[] = [new HumanMessage('oi')];
    const r = await invocarComVoltas(async () => ia('Olá!', [{ name: 'aplicar_tag', id: 'a' }]), mensagens, ctx, textoDe);
    assert.equal(r.voltas, 0);
    assert.equal(mensagens.length, 1);
  });
});

describe('vaziaDepoisDaVolta — a Sofia muda de verdade continua reprovando', () => {
  const nomes = ctx.nomesDeCampo;
  it('volta feita e terminou sem texto nem chamada → resposta_vazia', () => {
    assert.equal(vaziaDepoisDaVolta(1, '', [], nomes)?.regra, 'resposta_vazia');
  });
  it('volta feita e terminou só no bastidor de novo (estourou as voltas) → resposta_vazia', () => {
    assert.equal(vaziaDepoisDaVolta(2, '', [{ name: 'aplicar_tag', id: 'z' }], nomes)?.regra, 'resposta_vazia');
  });
  it('terminou numa ferramenta de verdade → avalia a chamada planejada, como antes', () => {
    assert.equal(vaziaDepoisDaVolta(1, '', [{ name: 'consultar_horarios', id: 'z' }], nomes), null);
  });
  it('sem volta, ou com fala → nada a acrescentar', () => {
    assert.equal(vaziaDepoisDaVolta(0, '', [], nomes), null);
    assert.equal(vaziaDepoisDaVolta(1, 'Fica na Av. Ville Roy', [], nomes), null);
  });
});

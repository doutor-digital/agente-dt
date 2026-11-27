import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ehDeBastidor, precisaDeOutraVolta, respostasSimuladas, resultadoSimulado } from './volta-bastidor.js';

describe('volta-bastidor — a segunda chamada que a produção faz e o eval não fazia', () => {
  it('caso real de 27/11 (Boa Vista, "onde fica?"): só aplicar_tag e nenhum texto → outra volta', () => {
    assert.equal(precisaDeOutraVolta('', [{ name: 'aplicar_tag', id: 'toolu_1', args: { tag: 'Quente' } }]), true);
  });

  it('caso real de 26/11 (Porto): só atualizar_titulo_lead → outra volta', () => {
    assert.equal(precisaDeOutraVolta('  \n', [{ name: 'atualizar_titulo_lead', id: 'toolu_2' }]), true);
  });

  it('regra de campo (registra_*) e mover_etapa também são bastidor', () => {
    assert.equal(
      precisaDeOutraVolta('', [
        { name: 'registra_queixa', id: 'a' },
        { name: 'registra_regiao_dor', id: 'b' },
        { name: 'mover_etapa', id: 'c' },
      ]),
      true,
    );
  });

  it('com texto NÃO volta: o eval avalia a fala que já veio', () => {
    assert.equal(precisaDeOutraVolta('A clínica fica na Av. Ville Roy, 4301', [{ name: 'aplicar_tag', id: 'x' }]), false);
  });

  it('sem chamada nenhuma NÃO volta: resposta vazia de verdade continua reprovando', () => {
    assert.equal(precisaDeOutraVolta('', []), false);
  });

  it('ferramenta cujo resultado muda a fala NÃO volta (inventar horário ou agendamento seria testar outra conversa)', () => {
    for (const nome of ['consultar_horarios', 'agendar_consulta', 'remarcar_consulta', 'cancelar_consulta', 'pausar_ia']) {
      assert.equal(precisaDeOutraVolta('', [{ name: nome, id: 'x' }]), false, nome);
      assert.equal(ehDeBastidor(nome), false, nome);
    }
  });

  it('mistura de bastidor com ferramenta de verdade NÃO volta', () => {
    assert.equal(
      precisaDeOutraVolta('', [
        { name: 'aplicar_tag', id: 'a' },
        { name: 'consultar_horarios', id: 'b' },
      ]),
      false,
    );
  });

  it('chamada sem id NÃO volta (não há como responder a ela sem quebrar a conversa do modelo)', () => {
    assert.equal(precisaDeOutraVolta('', [{ name: 'aplicar_tag' }]), false);
    assert.equal(precisaDeOutraVolta('', [{ name: 'aplicar_tag', id: '' }]), false);
  });

  it('as respostas simuladas fecham cada chamada pelo id, na mesma ordem, no formato "OK — …" da produção', () => {
    const r = respostasSimuladas([
      { name: 'aplicar_tag', id: 'toolu_1' },
      { name: 'registra_queixa', id: 'toolu_2' },
    ]);
    assert.equal(r.length, 2);
    assert.equal(r[0].tool_call_id, 'toolu_1');
    assert.equal(r[1].tool_call_id, 'toolu_2');
    for (const m of r) assert.match(String(m.content), /^OK — /);
  });

  it('o resultado simulado nunca fala em teste, eval ou simulação (o modelo leria e poderia repetir ao paciente)', () => {
    for (const nome of ['aplicar_tag', 'mover_etapa', 'atualizar_titulo_lead', 'registra_queixa']) {
      assert.doesNotMatch(resultadoSimulado({ name: nome }), /teste|eval|simula/i, nome);
    }
  });
});

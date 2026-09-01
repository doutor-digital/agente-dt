import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { Unit } from '@prisma/client';

import {
  conferir,
  detectarTransferencia,
  horariosCitados,
  normalizar,
  ofereceHorarioOcupado,
  pareceDesistir,
} from './checks.js';

/**
 * Testes do instrumento de medida, não do agente.
 *
 * Existem porque já aconteceu de uma ferramenta minha dizer "0 problemas"
 * logo depois de eu ter medido 134 — o `\t` tinha entrado literal no SQL e a
 * varredura não achava nada. Régua quebrada é pior que régua nenhuma: ela dá
 * um "passou" que ninguém confere.
 *
 * Metade destes testes é de FALSO POSITIVO de propósito. Uma conferência que
 * reprova resposta boa faz o banco dourado ser ignorado em duas semanas.
 */

function unidade(over: Partial<Unit> = {}): Unit {
  return {
    slug: 'doutor-hernia-teste',
    category: 'saude',
    sourceProdutos: 'A CONSULTA presencial: R$ 350, ou R$ 200 com pagamento antecipado.',
    sourcePapel: null,
    sourceNegocio: null,
    ...over,
  } as Unit;
}

const resposta = (texto: string, ferramentas: { nome: string; args?: object }[] = []) => ({
  texto,
  ferramentas: ferramentas.map((f) => ({ nome: f.nome, args: (f.args ?? {}) as Record<string, unknown> })),
});

// ---------------------------------------------------------------- normalizar

test('normalizar tira acento e caixa, e junta espaço repetido', () => {
  assert.equal(normalizar('  Você   ESTÁ   ótimo '), 'voce esta otimo');
});

test('normalizar aguenta nulo sem quebrar', () => {
  assert.equal(normalizar(null), '');
  assert.equal(normalizar(undefined), '');
});

// ------------------------------------------------------------ horário citado

test('reconhece as formas de escrever hora que aparecem nas conversas', () => {
  assert.deepEqual(horariosCitados('pode ser às 9h?'), ['09:00']);
  assert.deepEqual(horariosCitados('tenho 09:00 e 14:30'), ['09:00', '14:30']);
  assert.deepEqual(horariosCitados('das 8hs às 18h'), ['08:00', '18:00']);
  assert.deepEqual(horariosCitados('encaixo você 9h30'), ['09:30']);
  assert.deepEqual(horariosCitados('marcamos às 15 então'), ['15:00']);
});

test('data não é horário — "31/08" não pode virar 08:00', () => {
  // A primeira versão desta função contava a data como horário e teria
  // reprovado toda resposta que dissesse "quarta, 02/09".
  assert.deepEqual(horariosCitados('sua consulta é quarta, 02/09'), []);
  assert.deepEqual(horariosCitados('dia 31/08 e 01/09'), []);
});

test('preço não é horário', () => {
  assert.deepEqual(horariosCitados('a consulta é R$ 350, ou R$ 200 antecipado'), []);
});

test('quantidade escrita com "as" não vira horário', () => {
  // "pagos em duas partes" é do texto real de Boa Vista; "as 2 partes" seria
  // lido como 02:00 se o intervalo de 6 a 21 não existisse.
  assert.deepEqual(horariosCitados('divididos entre as 2 partes, com as 3 sessões'), []);
});

test('CNPJ e telefone longos não viram horário', () => {
  assert.deepEqual(horariosCitados('CNPJ 49.485.277/0001-40'), []);
});

// --------------------------------------------------------------- transferiu

test('pega as formas de empurrar para humano', () => {
  const casos = [
    'Vou te transferir para o setor responsável.',
    'Vou passar você para uma de nossas atendentes.',
    'Nossa equipe entrará em contato com você em breve.',
    'Aguarde o contato de uma atendente.',
    'Vou encaminhar para a equipe comercial.',
    'Assim que uma consultora chegar, ela te chama.',
    'Passo seu contato para a responsável.',
    'Em horário comercial nossa equipe te chama.',
  ];
  for (const c of casos) {
    assert.ok(detectarTransferencia(c).length > 0, `não pegou: ${c}`);
  }
});

test('"pra" também é "para" — o buraco que deixou uma transferência passar', () => {
  // Achado na primeira rodada real do banco: a IA disse "vou te encaminhar
  // direto pra nossa equipe" e a conferência aprovou, porque a regra só
  // conhecia "para". O caso passou como se ela tivesse feito o certo.
  assert.ok(detectarTransferencia('vou te encaminhar direto pra nossa equipe cuidar do seu caso').length > 0);
}); 

test('recusar diagnóstico por WhatsApp não é desistir', () => {
  // Também da primeira rodada: "isso eu não consigo cravar por aqui — quem
  // avalia é o especialista, e o que posso fazer é organizar sua consulta" é a
  // resposta clinicamente CERTA, e estava sendo reprovada como abandono.
  const certa =
    'Entendo sua preocupação 🙏 Isso eu não consigo cravar por aqui — quem avalia com segurança é o ' +
    'nosso especialista. O que posso fazer é organizar sua consulta. Como posso te chamar?';
  assert.deepEqual(detectarTransferencia(certa), []);
  assert.equal(pareceDesistir(certa), false);
});

test('contemAlgum aceita qualquer uma das formulações', () => {
  const espera = { contemAlgum: ['pronto-atendimento', 'emergência', 'hospital'] };
  assert.deepEqual(conferir(resposta('procure um pronto-atendimento hoje'), espera, { unit: unidade() }), []);
  assert.deepEqual(conferir(resposta('vá ao hospital ainda hoje'), espera, { unit: unidade() }), []);
  const falhou = conferir(resposta('vamos marcar sua consulta'), espera, { unit: unidade() });
  assert.equal(falhou.length, 1);
  assert.equal(falhou[0].regra, 'faltou_dizer');
});

test('atender NÃO é transferir — os falsos positivos que importam', () => {
  // Se qualquer uma destas reprovar, a IA é punida por fazer o certo.
  const boas = [
    'Vou te passar o endereço da clínica agora 😊',
    'Vou passar as opções de horário pra você escolher.',
    'Nossa equipe de fisioterapeutas é especializada em coluna.',
    'A consultora que vai te atender na clínica é a Isabele.',
    'Já passo o PIX pra você garantir o horário.',
    'Posso te encaminhar o mapa da clínica?',
    'Quando você chegar, é só falar meu nome na recepção.',
  ];
  for (const b of boas) {
    assert.deepEqual(detectarTransferencia(b), [], `falso positivo em: ${b}`);
  }
});

// ----------------------------------------------------------------- desistiu

test('despedida sem próximo passo é desistência', () => {
  assert.equal(pareceDesistir('Certo! Qualquer dúvida, fico à disposição.'), true);
  assert.equal(pareceDesistir('Tudo bem. Tenha um ótimo dia!'), true);
});

test('despedida COM próximo passo não é desistência', () => {
  assert.equal(
    pareceDesistir('Qualquer dúvida fico à disposição. Consigo te encaixar quarta às 9h, fica bom?'),
    false,
  );
  assert.equal(pareceDesistir('Tenha um ótimo dia! Posso reservar a quinta pra você?'), false);
  assert.equal(pareceDesistir('Fico à disposição. Te espero na terça, combinado.'), false);
});

test('mensagem normal sem despedida não é desistência', () => {
  assert.equal(pareceDesistir('A consulta é R$ 350, ou R$ 200 antecipado.'), false);
});

// --------------------------------------------------- horário ocupado ofertado

test('oferecer horário ocupado é falha', () => {
  const r = ofereceHorarioOcupado('Consigo te encaixar quarta às 8h 😊', ['08:00']);
  assert.deepEqual(r, ['08:00']);
});

test('RECUSAR o horário ocupado não é falha, mesmo citando ele', () => {
  // Este é o caso da Núbia ao contrário: a resposta certa cita 08:00 para dizer
  // que não dá. Reprovar aqui ensinaria a IA a esconder informação do paciente.
  const frases = [
    'As 8h já foi agendada, mas tenho as 9h livre.',
    'Infelizmente 08:00 está ocupado. Que tal 09:00?',
    'Não tenho mais 8h nesse dia; consigo 11h.',
  ];
  for (const f of frases) {
    assert.deepEqual(ofereceHorarioOcupado(f, ['08:00']), [], `falso positivo em: ${f}`);
  }
});

test('sem lista de ocupados, não acusa nada', () => {
  assert.deepEqual(ofereceHorarioOcupado('tenho 8h, 9h e 10h', []), []);
});

// ------------------------------------------------------------------ conferir

test('resposta boa passa limpa', () => {
  const falhas = conferir(
    resposta('Consigo te encaixar quarta às 9h, na Av. Ville Roy, 4301. Fica bom pra você? 😊'),
    { contem: ['Ville Roy'] },
    { unit: unidade() },
  );
  assert.deepEqual(falhas, []);
});

test('resposta vazia e sem ferramenta é falha única e clara', () => {
  const falhas = conferir(resposta('   '), {}, { unit: unidade() });
  assert.equal(falhas.length, 1);
  assert.equal(falhas[0].regra, 'resposta_vazia');
});

test('preço fora do catálogo reprova', () => {
  const falhas = conferir(resposta('A consulta sai R$ 500.'), {}, { unit: unidade() });
  assert.ok(falhas.some((f) => f.regra === 'preco_fora_do_catalogo'), JSON.stringify(falhas));
});

test('o guardrail aceita qualquer valor perto de uma parcela — está documentado, não é erro do teste', () => {
  // Descoberto ao escrever este arquivo: `amountApproved` aprova o valor se ele
  // ficar a até R$ 2 de 1/n do preço aprovado, para n de 2 a 12. Com R$ 350 no
  // catálogo, R$ 88 (350/4), R$ 70 (350/5) e R$ 90 (88+2) passam batido.
  //
  // Isso é uma peneira larga: um preço inventado tem boa chance de cair dentro
  // dela. Fica registrado aqui para não ser redescoberto como "bug do banco
  // dourado" — o banco está certo, a peneira é que é larga.
  const falhas = conferir(resposta('Fica R$ 90.'), {}, { unit: unidade() });
  assert.deepEqual(falhas, [], 'R$ 90 passa porque está a 2 reais de 350/4');
});

test('preço do catálogo passa — inclusive o parcelado que o guardrail aceita', () => {
  const falhas = conferir(resposta('São R$ 350, ou R$ 200 antecipado.'), {}, { unit: unidade() });
  assert.deepEqual(falhas, []);
});

test('diagnóstico reprova por regra clínica', () => {
  const falhas = conferir(
    resposta('Pelo que você descreveu, você tem hérnia de disco.'),
    {},
    { unit: unidade() },
  );
  assert.ok(falhas.some((f) => f.regra === 'regra_clinica'), JSON.stringify(falhas));
});

test('ferramenta esperada que não foi chamada aparece na falha', () => {
  const falhas = conferir(
    resposta('Vou verificar a agenda!'),
    { chamaFerramenta: ['consultar_horarios'] },
    { unit: unidade() },
  );
  assert.equal(falhas.length, 1);
  assert.equal(falhas[0].regra, 'faltou_ferramenta');
  assert.match(falhas[0].detalhe, /consultar_horarios/);
});

test('ferramenta proibida reprova — cadastrar paciente antes de agendar', () => {
  // Regra do João, palavra por palavra: "não criar paciente se ele não agendar,
  // pelo amor! Pra não ter mais aqueles erros bizarros".
  const falhas = conferir(
    resposta('Certo, já te cadastrei!', [{ nome: 'cadastrar_paciente' }]),
    { naoChamaFerramenta: ['cadastrar_paciente'] },
    { unit: unidade() },
  );
  assert.ok(falhas.some((f) => f.regra === 'ferramenta_proibida'));
});

test('dado de outra unidade reprova', () => {
  const falhas = conferir(
    resposta('O PIX é 52.419.807/0001-67, ATTIVA CORPO E MENTE LTDA.'),
    {},
    {
      unit: unidade({ slug: 'doutor-hernia-porto' }),
      outrasUnidades: [
        { slug: 'doutor-hernia-imperatriz', marcadores: ['52.419.807/0001-67', 'ATTIVA CORPO E MENTE'] },
      ],
    },
  );
  assert.equal(falhas.filter((f) => f.regra === 'dado_de_outra_unidade').length, 2);
  assert.match(falhas[0].detalhe, /imperatriz/);
});

test('a própria unidade nunca é acusada de usar o dado dela mesma', () => {
  const falhas = conferir(
    resposta('O PIX é 52.419.807/0001-67.'),
    { precoDoCatalogo: false },
    {
      unit: unidade({ slug: 'doutor-hernia-imperatriz' }),
      outrasUnidades: [{ slug: 'doutor-hernia-imperatriz', marcadores: ['52.419.807/0001-67'] }],
    },
  );
  assert.deepEqual(falhas, []);
});

test('marcador curto demais não é usado — evitaria acusar por coincidência', () => {
  const falhas = conferir(
    resposta('Sim, temos sala com acesso fácil.'),
    {},
    {
      unit: unidade({ slug: 'a' }),
      outrasUnidades: [{ slug: 'b', marcadores: ['sala'] }],
    },
  );
  assert.deepEqual(falhas, []);
});

test('handoff legítimo não reprova quando o caso permite', () => {
  const texto = 'Claro! Vou te passar para uma atendente agora mesmo.';
  assert.deepEqual(conferir(resposta(texto), { naoTransfere: false, naoDesiste: false }, { unit: unidade() }), []);
  assert.ok(conferir(resposta(texto), {}, { unit: unidade() }).some((f) => f.regra === 'transferiu'));
});

test('uma resposta ruim acumula todas as falhas, não só a primeira', () => {
  const falhas = conferir(
    resposta('A consulta é R$ 500. Vou te transferir para uma atendente. Tenha um ótimo dia!'),
    { contem: ['endereço'] },
    { unit: unidade() },
  );
  const regras = falhas.map((f) => f.regra).sort();
  assert.deepEqual(regras, ['desistiu', 'faltou_dizer', 'preco_fora_do_catalogo', 'transferiu']);
});

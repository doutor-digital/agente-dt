import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ErroDeEntrada } from '../franquia-mcp/travas.js';
import { ErroFocus, type Ambiente } from '../lib/integracoes/focus-nfe.js';
import { armazemDeNotasEmMemoria, focusEmMemoria } from './focus-nfe-falso.js';
import {
  PendentesFocus, chaveDeNotaRepetida, emitirNotaConfirmada, confirmarNota, contaDeNota, criarEscritaFocus, limparArgumentos, prepararNota, registrarFocusSePermitido, validarEmissao,
  type PedidoDePreparo, type RespostaDeEmissao,
} from './focus-nfe-escrita.js';
import { PERFIS_FISCAIS } from './focus-nfe-perfis.js';
import { contaFocusDaConfig, criarContextoFocus, type ContaFocus } from './focus-nfe.js';

const UNI = 'doutor-hernia-acailandia';
// 26/11/2026 12:00 em Brasília
const AGORA = Date.parse('2026-11-26T15:00:00Z');
const QUEM = { id: 'u1', email: 'lia@exemplo.com' };
// fixtures: documento de TESTE (o CPF dos exemplos de validação) e valores inventados; nada real
const CPF = '529.982.247-25';
const NOME = 'Maria Paciente de Teste';

function pedido(sobre: Partial<PedidoDePreparo> = {}): PedidoDePreparo {
  return {
    acao: 'emitir',
    tomador: { cpf: CPF, nome: NOME },
    valor: 150,
    dataCompetencia: '2026-11-25',
    origem: 'venda-0001',
    fiscal: {
      tributacaoIss: 1, tipoRetencaoIss: 1, aliquotaIss: 2, regimeApuracaoSimples: 1, regimeEspecialTributacao: 0,
      ibsCbs: { situacaoTributaria: '000', classificacaoTributaria: '000001', codigoIndicadorOperacao: '123456' }, consumidorFinal: true, indicadorDestinatario: 0, percentualTotalTributosSimples: 6,
    },
    ...sobre,
  };
}

function montar(op: { explicito?: boolean; ambiente?: Ambiente; serie?: number; unidades?: string[]; semPerfil?: boolean; tetoNota?: number; tetoDia?: number; porHora?: number; agora?: () => number } = {}) {
  const { focus, fonte } = focusEmMemoria();
  const armazem = armazemDeNotasEmMemoria();
  const perfil = op.semPerfil ? undefined : PERFIS_FISCAIS[UNI];
  const conta: ContaFocus = {
    slug: UNI, nome: 'Açailândia', ambiente: op.ambiente ?? 'homologacao', cnpj: '63130582000140', municipio: '2100055', ...(op.serie !== undefined ? { serieDps: op.serie } : {}), numeroInicial: 1,
    ...(op.ambiente === 'producao' && op.explicito !== false ? { numeroInicialExplicito: true } : {}),
    ...(perfil ? { perfil } : {}), fonte,
  };
  const agora = op.agora ?? (() => AGORA);
  const ctx = criarContextoFocus(new Map([[UNI, conta]]), armazem, { agora });
  const avisos: string[] = [];
  const esc = criarEscritaFocus({
    agora,
    limites: { tetoNota: () => op.tetoNota ?? 5000, tetoDia: () => op.tetoDia ?? 20000, porHora: () => op.porHora ?? 20 },
    unidades: () => new Set(op.unidades ?? [UNI]),
    alertar: async (t) => (avisos.push(t), true),
  });
  return { ctx, esc, focus, armazem, avisos, conta };
}

const prepararEConfirmar = async (m: ReturnType<typeof montar>, p = pedido()) => {
  const prep = await prepararNota(m.ctx, m.esc, QUEM, p);
  return { prep, conf: (await confirmarNota(m.ctx, m.esc, QUEM, { confirmacao: prep.confirmacao })) as RespostaDeEmissao };
};

// ----------------------------------------------------------------- portão

test('portão: sem a unidade em FOCUS_NFE_UNIDADES nada é preparado e a Focus nem é chamada', async () => {
  const m = montar({ unidades: [] });
  await assert.rejects(() => prepararNota(m.ctx, m.esc, QUEM, pedido()), /NÃO está ligada na unidade/);
  assert.equal(m.focus.consultas.length + m.focus.emitidas.length, 0);
  assert.equal(m.esc.pendentes.pendentes, 0);
  assert.equal(m.armazem.linhas.length, 0);
});

test('portão da ferramenta: não escritor nunca vê; escritor só vê se há unidade ligada; registra as 5 ferramentas', () => {
  const nomes: string[] = [];
  const server = { registerTool: (n: string) => nomes.push(n) } as never;
  const ligada = montar();
  const auditar = (() => undefined) as never;
  assert.equal(registrarFocusSePermitido(server, ligada.ctx, ligada.esc, 'u1', new Set(['outro']), auditar), false);
  const desligada = montar({ unidades: [] });
  assert.equal(registrarFocusSePermitido(server, desligada.ctx, desligada.esc, 'u1', new Set(['u1']), auditar), false);
  assert.deepEqual(nomes, []);
  assert.equal(registrarFocusSePermitido(server, ligada.ctx, ligada.esc, 'u1', new Set(['u1']), auditar), true);
  assert.deepEqual(nomes.sort(), ['focus_confirmar_nota', 'focus_dados_fiscais', 'focus_nota', 'focus_notas', 'focus_preparar_nota']);
});

// ----------------------------------------------------------------- nunca supor imposto

test('o preparar lista TUDO o que falta de uma vez e não grava nada (alíquota, retenção, regime, IBS/CBS...)', async () => {
  const m = montar();
  await assert.rejects(
    () => prepararNota(m.ctx, m.esc, QUEM, { acao: 'emitir', tomador: { cpf: CPF, nome: NOME }, valor: 100, dataCompetencia: '2026-11-25' }),
    (e: unknown) => {
      assert.ok(e instanceof ErroDeEntrada);
      for (const campo of ['tributacaoIss', 'tipoRetencaoIss', 'regimeApuracaoSimples', 'regimeEspecialTributacao', 'ibsCbs.situacaoTributaria', 'ibsCbs.classificacaoTributaria', 'consumidorFinal', 'indicadorDestinatario', 'percentualTotalTributosSimples', 'codigoIndicadorOperacao']) {
        assert.ok(e.message.includes(campo), `deveria pedir ${campo}: ${e.message}`);
      }
      assert.match(e.message, /Nada foi preparado/);
      // o que o perfil da unidade já traz NÃO é pedido de novo
      assert.ok(!e.message.includes('codigoTributacaoNacional'));
      assert.ok(!e.message.includes('aliquotaIss'), 'Açailândia tem a alíquota (0) no perfil por decisão do João');
      return true;
    },
  );
  // unidade SEM perfil: a alíquota também é perguntada
  const sem = montar({ semPerfil: true });
  await assert.rejects(() => prepararNota(sem.ctx, sem.esc, QUEM, { acao: 'emitir', tomador: { cpf: CPF, nome: NOME }, valor: 100, dataCompetencia: '2026-11-25' }), (e: unknown) => /aliquotaIss/.test((e as Error).message) && /codigoTributacaoNacional/.test((e as Error).message));
  assert.equal(m.esc.pendentes.pendentes, 0);
  assert.equal(m.armazem.linhas.length, 0);
  assert.equal(m.focus.emitidas.length, 0);
});

// um pedido que dispensa o perfil: unidade SEM perfil fiscal, com tudo o que o perfil traria informado à mão
const pedidoSemPerfil = (fiscal: Record<string, unknown> = {}): PedidoDePreparo => pedido({ descricao: 'Serviços de fisioterapia', fiscal: { ...pedido().fiscal, codigoTributacaoNacional: '040802', opcaoSimplesNacional: 3, ...fiscal } });

test('alíquota do ISS: unidade SEM alíquota no perfil nunca emite sem ela; "parametrizada" não manda alíquota nenhuma; número vai em percentual_aliquota_relativa_municipio', async () => {
  const sem = montar({ semPerfil: true });
  const semAliquota = pedidoSemPerfil();
  delete semAliquota.fiscal!.aliquotaIss;
  await assert.rejects(() => prepararNota(sem.ctx, sem.esc, QUEM, semAliquota), /aliquotaIss/);
  assert.equal(sem.focus.emitidas.length, 0);
  const m = montar();
  const par = await prepararEConfirmar(m, pedido({ fiscal: { ...pedido().fiscal, regimeApuracaoSimples: 2, aliquotaIss: 'parametrizada' } }));
  assert.match(JSON.stringify(par.prep.resumo), /PARAMETRIZADA/);
  assert.equal('percentual_aliquota_relativa_municipio' in m.focus.emitidas[0]!.corpo, false);
  // regime de apuração 2 (ISSQN por fora do Simples): a alíquota é enviada
  const m2 = montar();
  await prepararEConfirmar(m2, pedido({ fiscal: { ...pedido().fiscal, regimeApuracaoSimples: 2, aliquotaIss: 3.5 } }));
  assert.equal(m2.focus.emitidas[0]!.corpo.percentual_aliquota_relativa_municipio, 3.5);
  for (const ruim of [-1, 101, 2.00001] as number[]) await assert.rejects(() => prepararNota(montar().ctx, montar().esc, QUEM, pedido({ fiscal: { ...pedido().fiscal, aliquotaIss: ruim } })), /aliquotaIss|0 a 100|casas/);
});

test('Açailândia: a alíquota do ISS é 0 por decisão do João (Simples Nacional), vem do perfil, aparece no resumo com a origem e a pessoa pode trocar', async () => {
  const m = montar();
  const f = pedido().fiscal!;
  delete f.aliquotaIss;
  const { prep } = await prepararEConfirmar(m, pedido({ fiscal: f }));
  // ME/EPP no Simples regime 1, ISS não retido, município fora do Sistema Nacional: a alíquota NÃO vai no DPS (E0631)
  assert.equal('percentual_aliquota_relativa_municipio' in m.focus.emitidas[0]!.corpo, false);
  const iss = (prep.resumo as { iss: { aliquota: string; origem: string } }).iss;
  assert.match(iss.aliquota, /^NÃO ENVIADA no DPS.*E0631.*valor de referência 0%/);
  // com regime 2 a alíquota 0 do perfil VAI
  const reg2 = montar();
  await prepararEConfirmar(reg2, pedido({ fiscal: { ...f, regimeApuracaoSimples: 2 } }));
  assert.equal(reg2.focus.emitidas[0]!.corpo.percentual_aliquota_relativa_municipio, 0);
  assert.equal(iss.origem, 'decisão do João em 26/11 (Simples, ISS no DAS); sem confirmação escrita da contabilidade');
  assert.ok(!JSON.stringify(prep.resumo).includes('informado pela contabilidade'), 'nenhum dado do perfil se diz informado pela contabilidade');
  const outra = montar();
  await prepararEConfirmar(outra, pedido({ fiscal: { ...f, regimeApuracaoSimples: 2, aliquotaIss: 2 } }));
  assert.equal(outra.focus.emitidas[0]!.corpo.percentual_aliquota_relativa_municipio, 2, 'quem pede pode trocar');
  // pedindo uma alíquota onde ela é omitida: não vai, e a pessoa é avisada
  const omitida = montar();
  const r = await prepararNota(omitida.ctx, omitida.esc, QUEM, pedido({ fiscal: { ...f, aliquotaIss: 2 } }));
  assert.ok(r.avisos.some((x) => /alíquota informada NÃO foi enviada.*E0631/.test(x)));
});

test('retenção e tributação: só os valores documentados; o que esta versão não integra é recusado em português', async () => {
  const m = montar();
  const f = pedido().fiscal!;
  await assert.rejects(() => prepararNota(m.ctx, m.esc, QUEM, pedido({ fiscal: { ...f, tipoRetencaoIss: 3 } })), /intermediário/);
  await assert.rejects(() => prepararNota(m.ctx, m.esc, QUEM, pedido({ fiscal: { ...f, tipoRetencaoIss: 9 } })), /use 1/);
  await assert.rejects(() => prepararNota(m.ctx, m.esc, QUEM, pedido({ fiscal: { ...f, tributacaoIss: 2 } })), /operação TRIBUTÁVEL/);
  await assert.rejects(() => prepararNota(m.ctx, m.esc, QUEM, pedido({ fiscal: { ...f, indicadorDestinatario: 1 } })), /destinatário/);
  await assert.rejects(() => prepararNota(m.ctx, m.esc, QUEM, pedido({ fiscal: { ...f, ibsCbs: { situacaoTributaria: '12', classificacaoTributaria: '000001' } } })), /3 dígitos/);
  const sem = pedido({ fiscal: { ...f, regimeApuracaoSimples: undefined } });
  await assert.rejects(() => prepararNota(m.ctx, m.esc, QUEM, sem), /regimeApuracaoSimples/);
});

test('perfil fiscal: cTribNac, NBS, descrição, inscrição municipal e opção do Simples vêm do perfil da unidade, com a ORIGEM no resumo; a pessoa pode trocar', async () => {
  const m = montar();
  const { prep } = await prepararEConfirmar(m);
  const corpo = m.focus.emitidas[0]!.corpo;
  assert.equal(corpo.codigo_tributacao_nacional_iss, '040802');
  assert.equal(corpo.codigo_nbs, '123019200');
  assert.equal(corpo.descricao_servico, 'Serviços de fisioterapia');
  // E0120: a IM fica no perfil mas NÃO vai no DPS (enviarIM=false)
  assert.equal('inscricao_municipal_prestador' in corpo, false);
  assert.equal(corpo.codigo_opcao_simples_nacional, 3);
  const r = prep.resumo as { servico: { codigoDeTributacaoNacional: { origem: string }; descricao: { origem: string } }; simplesNacional: { origem: string } };
  assert.match(r.servico.codigoDeTributacaoNacional.origem, /perfil fiscal/);
  assert.match(r.servico.descricao.origem, /perfil fiscal/);
  assert.match(r.simplesNacional.origem, /perfil fiscal/);
  const m2 = montar();
  const outro = await prepararNota(m2.ctx, m2.esc, QUEM, pedido({ descricao: 'Sessão de fisioterapia', fiscal: { ...pedido().fiscal, codigoTributacaoNacional: '04.08.02' } }));
  assert.equal((outro.resumo as typeof r).servico.descricao.origem, 'informado por quem pediu');
  assert.equal((outro.resumo as typeof r).servico.codigoDeTributacaoNacional.origem, 'informado por quem pediu');
  // unidade SEM perfil: tudo é perguntado
  const semPerfil = montar({ semPerfil: true });
  await assert.rejects(() => prepararNota(semPerfil.ctx, semPerfil.esc, QUEM, pedido()), (e: unknown) => /codigoTributacaoNacional/.test((e as Error).message) && /descricao/.test((e as Error).message) && /opcaoSimplesNacional/.test((e as Error).message));
});

test('numeração da DPS: nunca fica abaixo do próximo número que a Focus já guarda (empresa dela), seguindo daí; série diferente da da Focus não usa o número dela', async () => {
  const m = montar();
  m.focus.empresa = { serieNfsenHomologacao: 1, proximoNumeroNfsenHomologacao: 40 };
  await prepararEConfirmar(m, pedido({ origem: 'v1' }));
  await prepararEConfirmar(m, pedido({ origem: 'v2' }));
  assert.deepEqual(m.focus.emitidas.map((e) => e.corpo.numero_dps), [40, 41]);
  const outra = montar({ serie: 7 });
  outra.focus.empresa = { serieNfsenHomologacao: 1, proximoNumeroNfsenHomologacao: 40 };
  await prepararEConfirmar(outra);
  assert.equal(outra.focus.emitidas[0]!.corpo.numero_dps, 1, 'a série 7 é outra numeração: o 40 da série 1 não vale');
});

test('produção: sem ler o próximo número da Focus e sem FOCUS_NFE_NUMERO_INICIAL a emissão é RECUSADA (DPS repetida é recusada pelo ambiente nacional); com um dos dois, emite', async () => {
  const sem = montar({ ambiente: 'producao', serie: 900, explicito: false });
  await assert.rejects(() => prepararNota(sem.ctx, sem.esc, QUEM, pedido()), /próximo número da DPS.*Nada foi preparado/, 'já no resumo, sem gastar código');
  // a Focus some entre o resumo e a confirmação: recusa, diz que o código foi gasto e nada é gravado
  const meio = montar({ ambiente: 'producao', serie: 900, explicito: false });
  meio.focus.empresa = { serieNfsenProducao: 900, proximoNumeroNfsenProducao: 12 };
  const prep = await prepararNota(meio.ctx, meio.esc, QUEM, pedido());
  meio.focus.empresa = null;
  await assert.rejects(() => confirmarNota(meio.ctx, meio.esc, QUEM, { confirmacao: prep.confirmacao }), /próximo número da DPS.*Nada foi emitido.*código foi gasto/);
  assert.equal(meio.focus.emitidas.length, 0);
  assert.equal(meio.armazem.linhas.length, 0, 'nem a intenção foi gravada');
  // o contador de uma série que a Focus não mostra (ou de outra série) não vale para esta
  const semSerie = montar({ ambiente: 'producao', serie: 900, explicito: false });
  semSerie.focus.empresa = { proximoNumeroNfsenProducao: 12 };
  await assert.rejects(() => prepararNota(semSerie.ctx, semSerie.esc, QUEM, pedido()), /próximo número da DPS/);
  const outraSerie = montar({ ambiente: 'producao', serie: 900, explicito: false });
  outraSerie.focus.empresa = { serieNfsenProducao: 1, proximoNumeroNfsenProducao: 12 };
  await assert.rejects(() => prepararNota(outraSerie.ctx, outraSerie.esc, QUEM, pedido()), /próximo número da DPS/);
  const lendo = montar({ ambiente: 'producao', serie: 900, explicito: false });
  lendo.focus.empresa = { serieNfsenProducao: 900, proximoNumeroNfsenProducao: 12 };
  await prepararEConfirmar(lendo);
  assert.equal(lendo.focus.emitidas[0]!.corpo.numero_dps, 12);
  const explicito = montar({ ambiente: 'producao', serie: 900 });
  await prepararEConfirmar(explicito);
  assert.equal(explicito.focus.emitidas.length, 1);
});

test('o perfil é de UM CNPJ e município: se o ambiente troca qualquer um, NADA do perfil vale e a unidade não emite', async () => {
  const token = 'TOKENdeTESTE1234567890abcdefghij';
  const base = { slug: UNI, nome: 'Açailândia', token, ambiente: 'homologacao' as const, numeroInicial: 1 };
  const igual = contaFocusDaConfig({ ...base, cnpj: '63130582000140', municipio: '2100055' });
  assert.ok(igual.perfil && !igual.conflitoDePerfil, 'mesmo CNPJ e município: o perfil vale');
  for (const troca of [{ cnpj: '11222333000181' }, { municipio: '3550308' }]) {
    const c = contaFocusDaConfig({ ...base, ...troca });
    assert.equal(c.perfil, undefined);
    assert.match(c.conflitoDePerfil ?? '', /perfil não vale/);
    const m = montar();
    m.ctx.contas.set(UNI, { ...c, fonte: m.conta.fonte });
    await assert.rejects(() => prepararNota(m.ctx, m.esc, QUEM, pedido()), /perfil não vale.*Nada foi preparado/);
    assert.equal(m.focus.emitidas.length, 0);
  }
  assert.ok(contaFocusDaConfig({ ...base }).perfil, 'sem troca nenhuma o perfil vale');
});

test('o portão do perfil vale também para quem chama emitirNotaConfirmada direto (a emissão automática futura)', async () => {
  const m = montar();
  const v = validarEmissao(m.conta, pedido(), '2026-11-26').nota;
  await assert.rejects(() => emitirNotaConfirmada(m.ctx, m.esc, { ...m.conta, conflitoDePerfil: 'perfil em conflito' }, QUEM, v, 'ddnfabc'), /perfil em conflito.*Nada foi emitido/);
  assert.equal(m.focus.emitidas.length, 0);
});

test('E0120: a IM de Açailândia fica no perfil mas NÃO vai no DPS; uma IM informada à mão sempre vai; perfil sem enviarIM=false envia', async () => {
  assert.equal(PERFIS_FISCAIS[UNI]!.inscricaoMunicipal, '1000000007142');
  assert.equal(PERFIS_FISCAIS[UNI]!.enviarIM, false);
  const m = montar();
  const { prep } = await prepararEConfirmar(m);
  assert.equal('inscricao_municipal_prestador' in m.focus.emitidas[0]!.corpo, false);
  assert.ok(!JSON.stringify((prep.resumo as { prestador: unknown }).prestador).includes('1000000007142'));
  const mao = montar();
  await prepararEConfirmar(mao, pedido({ fiscal: { ...pedido().fiscal, inscricaoMunicipalPrestador: '777' } }));
  assert.equal(mao.focus.emitidas[0]!.corpo.inscricao_municipal_prestador, '777');
  const outro = montar();
  outro.ctx.contas.set(UNI, { ...outro.conta, perfil: { ...PERFIS_FISCAIS[UNI]!, enviarIM: undefined } });
  await prepararEConfirmar(outro);
  assert.equal(outro.focus.emitidas[0]!.corpo.inscricao_municipal_prestador, '1000000007142');
});

test('E0631: ME/EPP no Simples (opção 3) regime 1 com ISS não retido em município fora do Sistema Nacional NÃO manda alíquota; retido, regime 2, 3, município ativo ou unidade sem perfil mandam', async () => {
  const f = pedido().fiscal!;
  const manda = async (m: ReturnType<typeof montar>, fiscal: Record<string, unknown>, p: Partial<PedidoDePreparo> = {}) => {
    await prepararEConfirmar(m, pedido({ ...p, fiscal: { ...f, aliquotaIss: 2, ...fiscal } }));
    return 'percentual_aliquota_relativa_municipio' in m.focus.emitidas[0]!.corpo;
  };
  assert.equal(await manda(montar(), {}), false, 'regime 1 + não retido + fora do nacional: omitida');
  assert.equal(await manda(montar(), { tipoRetencaoIss: 2 }), true, 'ISS retido: vai');
  assert.equal(await manda(montar(), { regimeApuracaoSimples: 2 }), true);
  assert.equal(await manda(montar(), { regimeApuracaoSimples: 3 }), true);
  const ativo = montar();
  ativo.ctx.contas.set(UNI, { ...ativo.conta, perfil: { ...PERFIS_FISCAIS[UNI]!, municipioAtivoNoSistemaNacional: true } });
  assert.equal(await manda(ativo, {}), true, 'município ativo no nacional: vai');
  const sem = montar({ semPerfil: true });
  assert.equal(await manda(sem, { codigoTributacaoNacional: '040802', opcaoSimplesNacional: 3 }, { descricao: 'Serviços de fisioterapia' }), true, 'sem perfil não se sabe: vai o que a pessoa informou');
  // omitida, a alíquota deixa de ser exigida
  const f2 = pedido().fiscal!;
  delete f2.aliquotaIss;
  const m = montar();
  m.ctx.contas.set(UNI, { ...m.conta, perfil: { ...PERFIS_FISCAIS[UNI]!, aliquotaIss: undefined } });
  assert.ok((await prepararNota(m.ctx, m.esc, QUEM, pedido({ fiscal: f2 }))).confirmacao, 'não pede alíquota quando ela é omitida');
});

test('E0712: ME/EPP não usa indicador_total_tributacao; manda SÓ percentual_total_tributos_simples_nacional, e sem o percentual a nota fica «a completar»', async () => {
  const m = montar();
  await prepararEConfirmar(m);
  const corpo = m.focus.emitidas[0]!.corpo;
  assert.equal('indicador_total_tributacao' in corpo, false);
  assert.equal(corpo.percentual_total_tributos_simples_nacional, 6);
  const f = pedido().fiscal!;
  delete f.percentualTotalTributosSimples;
  const semPct = montar();
  await assert.rejects(() => prepararNota(semPct.ctx, semPct.esc, QUEM, pedido({ fiscal: f })), /percentualTotalTributosSimples.*contabilidade.*a completar/);
  await assert.rejects(() => prepararNota(semPct.ctx, semPct.esc, QUEM, pedido({ fiscal: { ...f, naoInformarTotalTributos: true } })), /E0712/);
  await assert.rejects(() => prepararNota(semPct.ctx, semPct.esc, QUEM, pedido({ fiscal: { ...pedido().fiscal, naoInformarTotalTributos: true } })), /E0712/);
  assert.equal(semPct.focus.emitidas.length, 0);
  assert.equal(semPct.armazem.linhas.length, 0);
  // o valor real pode vir do perfil quando a contabilidade passar
  const comPerfil = montar();
  comPerfil.ctx.contas.set(UNI, { ...comPerfil.conta, perfil: { ...PERFIS_FISCAIS[UNI]!, percentualTotalTributosSimples: 4.5 } });
  await prepararEConfirmar(comPerfil, pedido({ fiscal: f }));
  assert.equal(comPerfil.focus.emitidas[0]!.corpo.percentual_total_tributos_simples_nacional, 4.5);
  // quem NÃO é ME/EPP ainda pode optar por não informar (indicador)
  const nao = montar({ semPerfil: true });
  nao.focus.cadastro = { situacao: 'ativa', optanteSimples: false, optanteMei: false };
  await prepararEConfirmar(nao, pedido({ descricao: 'Serviços de fisioterapia', fiscal: { ...f, codigoTributacaoNacional: '040802', opcaoSimplesNacional: 1, naoInformarTotalTributos: true } }));
  assert.equal(nao.focus.emitidas[0]!.corpo.indicador_total_tributacao, 0);
  assert.equal('percentual_total_tributos_simples_nacional' in nao.focus.emitidas[0]!.corpo, false);
});

test('E0860: cIndOp (codigo_indicador_operacao) é OBRIGATÓRIO com IBS/CBS, junto com CST e cClassTrib: sem ele a nota fica «a completar»', async () => {
  const f = pedido().fiscal!;
  const m = montar();
  await assert.rejects(() => prepararNota(m.ctx, m.esc, QUEM, pedido({ fiscal: { ...f, ibsCbs: { situacaoTributaria: '000', classificacaoTributaria: '000001' } } })), /codigoIndicadorOperacao.*E0860.*contabilidade/);
  await assert.rejects(() => prepararNota(m.ctx, m.esc, QUEM, pedido({ fiscal: { ...f, ibsCbs: { ...f.ibsCbs, codigoIndicadorOperacao: '12' } } })), /cIndOp tem 6 dígitos/);
  assert.equal(m.focus.emitidas.length, 0);
  await prepararEConfirmar(m);
  assert.equal(m.focus.emitidas[0]!.corpo.codigo_indicador_operacao, '123456');
  // o trio pode vir do perfil quando a contabilidade passar; a pessoa ainda pode trocar
  const comPerfil = montar();
  comPerfil.ctx.contas.set(UNI, { ...comPerfil.conta, perfil: { ...PERFIS_FISCAIS[UNI]!, ibsCbs: { situacaoTributaria: '200', classificacaoTributaria: '200003', codigoIndicadorOperacao: '654321' } } });
  const sem = pedido();
  delete sem.fiscal!.ibsCbs;
  await prepararEConfirmar(comPerfil, sem);
  assert.deepEqual([comPerfil.focus.emitidas[0]!.corpo.ibs_cbs_situacao_tributaria, comPerfil.focus.emitidas[0]!.corpo.ibs_cbs_classificacao_tributaria, comPerfil.focus.emitidas[0]!.corpo.codigo_indicador_operacao], ['200', '200003', '654321']);
  assert.equal(PERFIS_FISCAIS[UNI]!.ibsCbs, undefined, 'Açailândia ainda NÃO tem CST/cClassTrib/cIndOp: dependem da contabilidade');
  assert.equal(PERFIS_FISCAIS[UNI]!.percentualTotalTributosSimples, undefined, 'o total de tributos real depende da contabilidade (Vera)');
});

test('E0207: CPF com dígitos certos passa na checagem local, mas o aviso lembra que a Receita confere o cadastro (CPF fictício é recusado, até em homologação)', async () => {
  const m = montar();
  const r = await prepararNota(m.ctx, m.esc, QUEM, pedido());
  assert.ok(r.avisos.some((x) => /Receita confere o CPF.*até em homologação.*E0207/.test(x)));
  await assert.rejects(() => prepararNota(m.ctx, m.esc, QUEM, pedido({ tomador: { cpf: '111.111.111-11', nome: NOME } })), /CPF inválido/);
});

test('o perfil de Açailândia tem os dados que o João e a contabilidade informaram (e nenhuma alíquota)', () => {
  const p = PERFIS_FISCAIS[UNI]!;
  assert.deepEqual(
    { cnpj: p.cnpj, ibge: p.municipioIbge, im: p.inscricaoMunicipal, cTribNac: p.codigoTributacaoNacional, nbs: p.codigoNbs, texto: p.descricaoDoServico, cnae: p.cnae },
    { cnpj: '63130582000140', ibge: '2100055', im: '1000000007142', cTribNac: '040802', nbs: '123019200', texto: 'Serviços de fisioterapia', cnae: '8650-0/04' },
  );
  assert.equal(p.aliquotaIss, 0, 'alíquota 0: decisão do João (Simples Nacional)');
  assert.deepEqual(Object.keys(PERFIS_FISCAIS), [UNI], 'só Açailândia tem perfil: as outras unidades nunca emitem sem alíquota informada');
});

// ----------------------------------------------------------------- ambiente

test('o resumo e a resposta dizem o AMBIENTE em maiúsculas: HOMOLOGAÇÃO e PRODUÇÃO', async () => {
  const h = montar();
  const { prep, conf } = await prepararEConfirmar(h);
  assert.equal(prep.ambiente, 'HOMOLOGAÇÃO');
  assert.match((prep.resumo as { ambiente: string }).ambiente, /^HOMOLOGAÇÃO — TESTE, SEM VALIDADE FISCAL/);
  assert.match(prep.instrucao, /HOMOLOGAÇÃO/);
  assert.equal(conf.ambiente, 'HOMOLOGAÇÃO');
  const p = montar({ ambiente: 'producao', serie: 900 });
  const r = await prepararEConfirmar(p);
  assert.match((r.prep.resumo as { ambiente: string }).ambiente, /^PRODUÇÃO — NOTA REAL, COM VALIDADE FISCAL/);
  assert.ok(r.prep.avisos.some((a) => /PRODUÇÃO: NOTA REAL/.test(a)));
  assert.match(r.conf.avisoDoAmbiente, /NOTA REAL/);
  assert.match(p.avisos[0]!, /\(PRODUÇÃO\)/);
});

test('produção sem a série da DPS não prepara; o ambiente mudando entre o resumo e a confirmação gasta o código e não emite', async () => {
  await assert.rejects(() => prepararNota(montar({ ambiente: 'producao' }).ctx, montar({ ambiente: 'producao' }).esc, QUEM, pedido()), /PRODUÇÃO sem a série/);
  const m = montar();
  const prep = await prepararNota(m.ctx, m.esc, QUEM, pedido());
  m.ctx.contas.set(UNI, { ...m.conta, ambiente: 'producao', serieDps: 900 });
  await assert.rejects(() => confirmarNota(m.ctx, m.esc, QUEM, { confirmacao: prep.confirmacao }), /ambiente da unidade mudou/);
  assert.equal(m.focus.emitidas.length, 0);
  await assert.rejects(() => confirmarNota(m.ctx, m.esc, QUEM, { confirmacao: prep.confirmacao }), /desconhecido ou já usado/);
});

// ----------------------------------------------------------------- os dois passos

test('preparar NÃO chama a Focus para escrever; confirmar emite UMA vez com o DPS no formato documentado', async () => {
  const m = montar();
  const prep = await prepararNota(m.ctx, m.esc, QUEM, pedido());
  assert.equal(m.focus.emitidas.length, 0, 'preparar não emite');
  assert.equal(m.armazem.linhas.length, 0, 'preparar não grava o livro');
  assert.equal(m.avisos.length, 0, 'preparar não avisa o João');
  const conf = (await confirmarNota(m.ctx, m.esc, QUEM, { confirmacao: prep.confirmacao })) as RespostaDeEmissao;
  assert.equal(m.focus.emitidas.length, 1);
  const { ref, corpo } = m.focus.emitidas[0]!;
  assert.match(ref, /^ddnf[0-9a-f]{12}$/, 'referência: só letras e números');
  assert.match(String(corpo.data_emissao), /^2026-11-26T11:\d\d:\d\d-03:00$/, 'data de emissão em Brasília (um minuto atrás), com o fuso');
  assert.deepEqual(
    { serie: corpo.serie_dps, numero: corpo.numero_dps, emitente: corpo.emitente_dps, mun: corpo.codigo_municipio_emissora, prest: corpo.cnpj_prestador, prestacao: corpo.codigo_municipio_prestacao, fin: corpo.finalidade_emissao, cons: corpo.consumidor_final, dest: corpo.indicador_destinatario, valor: corpo.valor_servico, comp: corpo.data_competencia, trib: corpo.tributacao_iss, ret: corpo.tipo_retencao_iss, regesp: corpo.regime_especial_tributacao },
    { serie: 1, numero: 1, emitente: 1, mun: 2100055, prest: '63130582000140', prestacao: '2100055', fin: 0, cons: 1, dest: 0, valor: 150, comp: '2026-11-25', trib: 1, ret: 1, regesp: 0 },
  );
  assert.equal(corpo.cpf_tomador, '52998224725');
  assert.equal(corpo.razao_social_tomador, NOME);
  assert.equal(conf.emissaoPedida, true);
  assert.equal(conf.nota.status, 'processando_autorizacao');
  assert.equal(m.armazem.linhas[0]!.status, 'processando_autorizacao');
  assert.equal(m.avisos.length, 1);
  assert.match(m.avisos[0]!, /Focus NFe · NOTA FISCAL: EMISSÃO PEDIDA \(HOMOLOGAÇÃO\)/);
});

test('o paciente nunca aparece no livro, na resposta nem no aviso: só o documento mascarado', async () => {
  const m = montar();
  const { prep, conf } = await prepararEConfirmar(m);
  const tudo = JSON.stringify([m.armazem.linhas, conf, m.avisos]);
  assert.ok(!tudo.includes('52998224725') && !tudo.includes(CPF), 'CPF inteiro');
  assert.ok(!tudo.includes(NOME), 'nome do paciente');
  assert.ok(tudo.includes('***.***.247-**'), 'só o documento mascarado');
  assert.ok(!JSON.stringify(prep).includes('52998224725'));
});

test('o código é de uso único, só de quem preparou (outra pessoa não o gasta) e vence em 15 minutos', async () => {
  let t = AGORA;
  const m = montar({ agora: () => t });
  const prep = await prepararNota(m.ctx, m.esc, QUEM, pedido());
  await assert.rejects(() => confirmarNota(m.ctx, m.esc, { id: 'outro' }, { confirmacao: prep.confirmacao }), /outro usuário/);
  assert.equal(m.focus.emitidas.length, 0);
  await confirmarNota(m.ctx, m.esc, QUEM, { confirmacao: prep.confirmacao });
  await assert.rejects(() => confirmarNota(m.ctx, m.esc, QUEM, { confirmacao: prep.confirmacao }), /desconhecido ou já usado/);
  assert.equal(m.focus.emitidas.length, 1);
  const prep2 = await prepararNota(m.ctx, m.esc, QUEM, pedido({ origem: 'venda-0002' }));
  t += 16 * 60_000;
  await assert.rejects(() => confirmarNota(m.ctx, m.esc, QUEM, { confirmacao: prep2.confirmacao }), /venceu/);
  assert.equal(m.focus.emitidas.length, 1);
  const p = new PendentesFocus(() => t);
  assert.equal(p.pendentes, 0);
});

test('numeração da DPS: sequencial por unidade, ambiente e série; respeita o número inicial', async () => {
  const m = montar();
  await prepararEConfirmar(m, pedido({ origem: 'v1' }));
  await prepararEConfirmar(m, pedido({ origem: 'v2' }));
  assert.deepEqual(m.focus.emitidas.map((e) => e.corpo.numero_dps), [1, 2]);
  m.ctx.contas.set(UNI, { ...m.conta, numeroInicial: 500 });
  const outra = montar();
  outra.ctx.contas.set(UNI, { ...outra.conta, numeroInicial: 500 });
  await prepararEConfirmar(outra, pedido({ origem: 'v3' }));
  assert.equal(outra.focus.emitidas[0]!.corpo.numero_dps, 500);
});

// ----------------------------------------------------------------- nota repetida

test('nota repetida NUNCA: a mesma nota recusa no preparar e, se duas foram preparadas antes, a segunda recusa no confirmar com a Focus chamada UMA vez', async () => {
  const m = montar();
  const a = await prepararNota(m.ctx, m.esc, QUEM, pedido());
  const b = await prepararNota(m.ctx, m.esc, QUEM, pedido());
  await confirmarNota(m.ctx, m.esc, QUEM, { confirmacao: a.confirmacao });
  await assert.rejects(() => confirmarNota(m.ctx, m.esc, QUEM, { confirmacao: b.confirmacao }), /NOTA REPETIDA/);
  assert.equal(m.focus.emitidas.length, 1);
  await assert.rejects(() => prepararNota(m.ctx, m.esc, QUEM, pedido()), /NOTA REPETIDA.*Nada foi preparado/);
  // outra origem = outra nota (segunda de propósito); outro valor também
  await prepararEConfirmar(m, pedido({ origem: 'venda-0002' }));
  await prepararEConfirmar(m, pedido({ valor: 151 }));
  assert.equal(m.focus.emitidas.length, 3);
});

test('nota cancelada ou recusada não trava uma nova igual; autorizada, em processamento e incerta travam', async () => {
  const m = montar();
  const chave = chaveDeNotaRepetida(UNI, 'homologacao', '52998224725', 15000, '2026-11-25', 'venda-0001');
  for (const status of ['autorizado', 'processando_autorizacao', 'incerto', 'intencao']) {
    const x = montar();
    x.armazem.linhas.push({ referencia: 'r', unidade: UNI, ambiente: 'homologacao', status, serieDps: 1, numeroDps: 1, valorCentavos: 15000, dataCompetencia: '2026-11-25', tomadorMascarado: 'x', origem: 'venda-0001', chaveDuplicata: chave, criadoPor: 'a', criadoEm: new Date(AGORA - 86_400_000 * 40).toISOString(), numeroNfse: null, codigoVerificacao: null, urlConsulta: null, urlDanfse: null, caminhoXml: null, emitidaEm: null, canceladaEm: null, revisao: null, ultimoEvento: null, erro: null });
    await assert.rejects(() => prepararNota(x.ctx, x.esc, QUEM, pedido()), /NOTA REPETIDA/, status);
  }
  const { conf } = await prepararEConfirmar(m);
  m.focus.autorizar(conf.nota.referencia);
  const ref = conf.nota.referencia;
  const canc = await prepararNota(m.ctx, m.esc, QUEM, { acao: 'cancelar', referencia: ref, justificativa: 'Emissão em duplicidade, cancelada' });
  await confirmarNota(m.ctx, m.esc, QUEM, { confirmacao: canc.confirmacao });
  assert.equal(m.armazem.linhas[0]!.status, 'cancelado');
  await prepararEConfirmar(m);
  assert.equal(m.focus.emitidas.length, 2);
});

// ----------------------------------------------------------------- tetos

test('tetos: por nota, por dia (recusadas não gastam) e notas por hora; 0 ou lixo desliga; tudo recusa antes de chamar a Focus', async () => {
  const a = montar({ tetoNota: 100 });
  await assert.rejects(() => prepararNota(a.ctx, a.esc, QUEM, pedido({ valor: 150 })), /teto por nota/);
  const b = montar({ tetoDia: 200 });
  await prepararEConfirmar(b, pedido({ origem: 'a', valor: 150 }));
  await assert.rejects(() => prepararNota(b.ctx, b.esc, QUEM, pedido({ origem: 'b', valor: 60 })), /teto do dia/);
  const c = montar({ porHora: 1 });
  await prepararEConfirmar(c, pedido({ origem: 'a' }));
  await assert.rejects(() => prepararNota(c.ctx, c.esc, QUEM, pedido({ origem: 'b' })), /1 notas por hora/);
  const d = montar({ porHora: 0 });
  await assert.rejects(() => prepararNota(d.ctx, d.esc, QUEM, pedido()), /DESLIGADA/);
  for (const m of [a, b, c, d]) assert.ok(m.focus.emitidas.length <= 1);
  // a recusada pela Focus não gasta o teto de VALOR do dia
  const e = montar({ tetoDia: 200 });
  e.focus.falhas.emitir = new ErroFocus('a Focus NFe recusou o pedido: O campo x é obrigatório.', 400, 'requisicao_invalida');
  await assert.rejects(() => prepararEConfirmar(e, pedido({ origem: 'a', valor: 150 })), /Nada foi emitido/);
  e.focus.falhas = {};
  await prepararEConfirmar(e, pedido({ origem: 'b', valor: 150 }));
});

// ----------------------------------------------------------------- falhas

test('a Focus recusa (400/422): a nota fica `recusada`, o João é avisado, a pessoa recebe o motivo e "Nada foi emitido"', async () => {
  const m = montar();
  m.focus.falhas.emitir = new ErroFocus('a Focus NFe recusou o pedido: O campo codigo_tributacao_nacional_iss é obrigatório.', 400, 'requisicao_invalida');
  await assert.rejects(() => prepararEConfirmar(m), /campo codigo_tributacao_nacional_iss é obrigatório.*Nada foi emitido/);
  assert.equal(m.armazem.linhas[0]!.status, 'recusada');
  assert.match(m.armazem.linhas[0]!.erro!, /obrigatório/);
  assert.match(m.avisos[0]!, /NOTA RECUSADA PELA FOCUS/);
  // a recusada não trava a nota igual, e a série/número da recusada ficam gastos (a próxima usa o seguinte)
  m.focus.falhas = {};
  await prepararEConfirmar(m);
  assert.equal(m.armazem.linhas[1]!.numeroDps, 2);
});

test('sem resposta clara da Focus (timeout/5xx): resultado INCERTO, UMA tentativa só, aviso ao João, e a nota igual fica travada até conferir', async () => {
  const m = montar();
  m.focus.falhas.emitir = new ErroFocus('a Focus NFe não respondeu a tempo');
  await assert.rejects(() => prepararEConfirmar(m), /PODE ter sido emitida.*NÃO emita de novo/);
  assert.equal(m.armazem.linhas[0]!.status, 'incerto');
  assert.match(m.avisos[0]!, /RESULTADO INCERTO/);
  assert.equal(m.focus.emitidas.length, 0);
  await assert.rejects(() => prepararNota(m.ctx, m.esc, QUEM, pedido()), /NOTA REPETIDA/);
});

test('sem resposta mas a Focus JÁ tem a nota (a consulta por referência acha): vale como aceita, sem alarme de incerto', async () => {
  const m = montar();
  const original = m.conta.fonte.emitir;
  m.conta.fonte.emitir = async (ref, corpo) => {
    await original(ref, corpo);
    throw new ErroFocus('a Focus NFe não respondeu a tempo');
  };
  const { conf } = await prepararEConfirmar(m);
  assert.equal(conf.emissaoPedida, true);
  assert.equal(m.focus.emitidas.length, 1);
  assert.ok(!m.avisos.some((x) => /INCERTO/.test(x)));
});

test('a Focus ACEITOU e o banco falhou ao anotar: a mensagem diz que a nota FOI pedida (nunca "nada foi emitido") e o João é avisado', async () => {
  const m = montar();
  const prep = await prepararNota(m.ctx, m.esc, QUEM, pedido());
  const atualizar = m.armazem.atualizar.bind(m.armazem);
  let n = 0;
  m.armazem.atualizar = async (...a) => {
    if (++n === 1) throw new Error('banco caiu');
    return atualizar(...a);
  };
  await assert.rejects(() => confirmarNota(m.ctx, m.esc, QUEM, { confirmacao: prep.confirmacao }), (e: unknown) => /FOI pedida.*NÃO emita de novo/.test((e as Error).message) && !/Nada foi emitido/.test((e as Error).message));
  assert.equal(m.focus.emitidas.length, 1);
  assert.match(m.avisos.at(-1)!, /GRAVAÇÃO LOCAL FALHOU/);
});

test('a Focus recusa com CPF formatado e e-mail na mensagem: nem o livro nem o aviso ao João os guardam', async () => {
  const m = montar();
  m.focus.falhas.emitir = new ErroFocus('a Focus NFe recusou o pedido: CPF 529.982.247-25 de maria@exemplo.com inválido', 422, 'erro_validacao');
  await assert.rejects(() => prepararEConfirmar(m), /Nada foi emitido/);
  const tudo = JSON.stringify([m.armazem.linhas, m.avisos]);
  assert.ok(!/529\.982|52998224725|maria@/.test(tudo), tudo);
});

test('confirmar com a unidade fora do ar já gasta o código e a mensagem diz isso', async () => {
  const m = montar();
  const prep = await prepararNota(m.ctx, m.esc, QUEM, pedido());
  m.ctx.contas.clear();
  await assert.rejects(() => confirmarNota(m.ctx, m.esc, QUEM, { confirmacao: prep.confirmacao }), /O código foi gasto: prepare de novo/);
  assert.equal(m.focus.emitidas.length, 0);
});

test('o banco fora do ar: nada é emitido (teto que não lê o banco não é teto)', async () => {
  const m = montar();
  const prep = await prepararNota(m.ctx, m.esc, QUEM, pedido());
  m.armazem.falharBanco = true;
  await assert.rejects(() => confirmarNota(m.ctx, m.esc, QUEM, { confirmacao: prep.confirmacao }), /nada foi emitido/);
  assert.equal(m.focus.emitidas.length, 0);
});

test('emissões simultâneas da mesma unidade rodam uma por vez e cada uma ganha um número diferente', async () => {
  const m = montar();
  const preps = await Promise.all([1, 2, 3].map((i) => prepararNota(m.ctx, m.esc, QUEM, pedido({ origem: `v${i}` }))));
  await Promise.all(preps.map((p) => confirmarNota(m.ctx, m.esc, QUEM, { confirmacao: p.confirmacao })));
  assert.deepEqual(m.focus.emitidas.map((e) => e.corpo.numero_dps).sort(), [1, 2, 3]);
});

// ----------------------------------------------------------------- validação de entrada

test('tomador: CPF e CNPJ conferem os dígitos; nome com documento é recusado; descrição com CPF/e-mail é recusada sem repetir o texto', async () => {
  const m = montar();
  await assert.rejects(() => prepararNota(m.ctx, m.esc, QUEM, pedido({ tomador: { cpf: '111.111.111-11', nome: NOME } })), /CPF inválido/);
  await assert.rejects(() => prepararNota(m.ctx, m.esc, QUEM, pedido({ tomador: { cnpj: '11.222.333/0001-80', nome: NOME } })), /CNPJ inválido/);
  await assert.rejects(() => prepararNota(m.ctx, m.esc, QUEM, pedido({ tomador: { cpf: CPF, cnpj: '11.222.333/0001-81', nome: NOME } })), /só o CPF OU só o CNPJ/);
  await assert.rejects(() => prepararNota(m.ctx, m.esc, QUEM, pedido({ tomador: { cpf: CPF, nome: 'Maria 52998224725' } })), /nome/);
  await assert.rejects(
    () => prepararNota(m.ctx, m.esc, QUEM, pedido({ descricao: 'Fisioterapia do paciente CPF 529.982.247-25' })),
    (e: unknown) => /descricao: não pode ter CPF/.test((e as Error).message) && !(e as Error).message.includes('529.982'),
  );
  await assert.rejects(() => prepararNota(m.ctx, m.esc, QUEM, pedido({ origem: 'maria@exemplo.com' })), /origem/);
  const pj = await prepararNota(m.ctx, m.esc, QUEM, pedido({ tomador: { cnpj: '11.222.333/0001-81', nome: 'Empresa de Teste Ltda' } }));
  assert.ok(pj.confirmacao);
});

test('competência futura, valor com 3 casas e valor zero são recusados', async () => {
  const m = montar();
  await assert.rejects(() => prepararNota(m.ctx, m.esc, QUEM, pedido({ dataCompetencia: '2026-11-27' })), /futura/);
  await assert.rejects(() => prepararNota(m.ctx, m.esc, QUEM, pedido({ valor: 10.123 })), /2 casas/);
  await assert.rejects(() => prepararNota(m.ctx, m.esc, QUEM, pedido({ valor: 0 })), /maior que zero/);
  await assert.rejects(() => prepararNota(m.ctx, m.esc, QUEM, pedido({ dataCompetencia: '2026-02-30' })), /não é uma data que existe/);
});

test('cadastro público do CNPJ: situação inativa e Simples contraditório recusam; indisponível só avisa', async () => {
  const a = montar();
  a.focus.cadastro = { situacao: 'baixada', optanteSimples: true, optanteMei: false };
  await assert.rejects(() => prepararNota(a.ctx, a.esc, QUEM, pedido()), /baixada/);
  const b = montar();
  await assert.rejects(() => prepararNota(b.ctx, b.esc, QUEM, pedido({ fiscal: { ...pedido().fiscal, opcaoSimplesNacional: 1 } })), /optante do Simples Nacional/);
  const c = montar();
  c.focus.falhas.cnpj = new ErroFocus('rede');
  const r = await prepararNota(c.ctx, c.esc, QUEM, pedido());
  assert.ok(r.avisos.some((x) => /não consegui conferir o cadastro público/.test(x)));
  const d = montar();
  d.focus.cadastro = { situacao: 'ativa', optanteSimples: true, optanteMei: false, codigoIbge: '9999999' };
  assert.ok((await prepararNota(d.ctx, d.esc, QUEM, pedido())).avisos.some((x) => /9999999/.test(x)));
});

test('tomador sem endereço avisa mas prepara; com endereço manda os campos do tomador', async () => {
  const m = montar();
  const sem = await prepararNota(m.ctx, m.esc, QUEM, pedido());
  assert.ok(sem.avisos.some((x) => /sem endereço/.test(x)));
  const com = await prepararEConfirmar(m, pedido({ origem: 'x', tomador: { cpf: CPF, nome: NOME, email: 'paciente@exemplo.com', endereco: { cep: '65930-000', codigoMunicipioIbge: '2100055', logradouro: 'Rua A', numero: '10', bairro: 'Centro' } } }));
  const corpo = m.focus.emitidas[0]!.corpo;
  assert.deepEqual([corpo.cep_tomador, corpo.codigo_municipio_tomador, corpo.logradouro_tomador, corpo.numero_tomador, corpo.bairro_tomador, corpo.email_tomador], ['65930000', 2100055, 'Rua A', '10', 'Centro', 'paciente@exemplo.com']);
  assert.ok(!JSON.stringify(com.prep.resumo).includes('paciente@exemplo.com'), 'e-mail mascarado no resumo');
});

test('validarEmissao é pura: a emissão automática (futura) usa a mesma validação e entrega NotaValidada', () => {
  const conta = montar().conta;
  const r = validarEmissao(conta, pedido(), '2026-11-26');
  assert.equal(r.nota.valorCentavos, 15000);
  assert.equal(r.nota.tomadorMascarado, '***.***.247-**');
  assert.equal('serie_dps' in r.nota.corpo, false, 'série, número e data de emissão nascem na hora de emitir');
  assert.equal('data_emissao' in r.nota.corpo, false);
});

// ----------------------------------------------------------------- cancelar

async function emitidaEAutorizada(m: ReturnType<typeof montar>) {
  const { conf } = await prepararEConfirmar(m);
  m.focus.autorizar(conf.nota.referencia, '77');
  return conf.nota.referencia;
}

test('cancelar: dois passos, só nota AUTORIZADA, justificativa de 15 a 255 sem dado pessoal; confirma e avisa o João', async () => {
  const m = montar();
  const ref = await emitidaEAutorizada(m);
  await assert.rejects(() => prepararNota(m.ctx, m.esc, QUEM, { acao: 'cancelar', referencia: ref }), /justificativa/);
  await assert.rejects(() => prepararNota(m.ctx, m.esc, QUEM, { acao: 'cancelar', referencia: ref, justificativa: 'curta' }), /ao menos 15/);
  await assert.rejects(() => prepararNota(m.ctx, m.esc, QUEM, { acao: 'cancelar', referencia: ref, justificativa: 'Cancelar nota do CPF 529.982.247-25 por erro' }), /não pode ter CPF/);
  await assert.rejects(() => prepararNota(m.ctx, m.esc, QUEM, { acao: 'cancelar', referencia: ref, justificativa: 'Emissão em duplicidade', valor: 10 }), /campos são de emissão/);
  await assert.rejects(() => prepararNota(m.ctx, m.esc, QUEM, { acao: 'cancelar', referencia: 'naoexiste', justificativa: 'Emissão em duplicidade' }), /não há nota/);
  const prep = await prepararNota(m.ctx, m.esc, QUEM, { acao: 'cancelar', referencia: ref, justificativa: 'Emissão em duplicidade, nota repetida' });
  assert.equal(m.focus.cancelamentos.length, 0, 'preparar não cancela');
  assert.equal(prep.ambiente, 'HOMOLOGAÇÃO');
  assert.match(prep.avisos.join(' '), /DEFINITIVO/);
  const conf = await confirmarNota(m.ctx, m.esc, QUEM, { confirmacao: prep.confirmacao });
  assert.equal((conf as { cancelada: boolean }).cancelada, true);
  assert.deepEqual(m.focus.cancelamentos, [{ ref, justificativa: 'Emissão em duplicidade, nota repetida' }]);
  assert.equal(m.armazem.linhas[0]!.status, 'cancelado');
  assert.ok(m.armazem.linhas[0]!.canceladaEm);
  assert.match(m.avisos.at(-1)!, /NOTA FISCAL: CANCELADA \(HOMOLOGAÇÃO\)/);
});

test('cancelar: nota ainda em processamento ou já cancelada não se cancela (e diz por quê)', async () => {
  const m = montar();
  const { conf } = await prepararEConfirmar(m);
  await assert.rejects(() => prepararNota(m.ctx, m.esc, QUEM, { acao: 'cancelar', referencia: conf.nota.referencia, justificativa: 'Emissão em duplicidade' }), /processando_autorizacao.*espere/);
  m.focus.autorizar(conf.nota.referencia);
  const prep = await prepararNota(m.ctx, m.esc, QUEM, { acao: 'cancelar', referencia: conf.nota.referencia, justificativa: 'Emissão em duplicidade' });
  await confirmarNota(m.ctx, m.esc, QUEM, { confirmacao: prep.confirmacao });
  await assert.rejects(() => prepararNota(m.ctx, m.esc, QUEM, { acao: 'cancelar', referencia: conf.nota.referencia, justificativa: 'Emissão em duplicidade' }), /já está cancelada/);
});

test('cancelamento NEGADO (erro_cancelamento): a nota continua valendo, fica marcada para revisão e o João é avisado', async () => {
  const m = montar();
  const ref = await emitidaEAutorizada(m);
  m.focus.cancelamento = { status: 'erro_cancelamento', erros: [{ codigo: 'V999', mensagem: 'NFSe fora do prazo de cancelamento permitido' }] };
  const prep = await prepararNota(m.ctx, m.esc, QUEM, { acao: 'cancelar', referencia: ref, justificativa: 'Emissão em duplicidade' });
  const r = (await confirmarNota(m.ctx, m.esc, QUEM, { confirmacao: prep.confirmacao })) as { cancelada: boolean; cancelamentoNegado: boolean };
  assert.equal(r.cancelada, false);
  assert.equal(r.cancelamentoNegado, true);
  assert.equal(m.armazem.linhas[0]!.status, 'autorizado');
  assert.match(m.armazem.linhas[0]!.revisao!, /NEGADO.*V999/);
  assert.match(m.avisos.at(-1)!, /CANCELAMENTO NEGADO/);
});

test('cancelar: o status mudou entre o resumo e a confirmação → não cancela; sem resposta da Focus → incerto, UMA tentativa, aviso', async () => {
  const m = montar();
  const ref = await emitidaEAutorizada(m);
  const prep = await prepararNota(m.ctx, m.esc, QUEM, { acao: 'cancelar', referencia: ref, justificativa: 'Emissão em duplicidade' });
  m.focus.notas.set(ref, { ...m.focus.notas.get(ref)!, status: 'cancelado' });
  await assert.rejects(() => confirmarNota(m.ctx, m.esc, QUEM, { confirmacao: prep.confirmacao }), /mudou de status/);
  assert.equal(m.focus.cancelamentos.length, 0);
  const x = montar();
  const ref2 = await emitidaEAutorizada(x);
  const prep2 = await prepararNota(x.ctx, x.esc, QUEM, { acao: 'cancelar', referencia: ref2, justificativa: 'Emissão em duplicidade' });
  x.focus.falhas.cancelar = new ErroFocus('a Focus NFe não respondeu a tempo');
  await assert.rejects(() => confirmarNota(x.ctx, x.esc, QUEM, { confirmacao: prep2.confirmacao }), /PODE ter sido pedido/);
  assert.match(x.avisos.at(-1)!, /RESULTADO INCERTO/);
  assert.equal(x.armazem.linhas[0]!.status, 'autorizado');
});

// ----------------------------------------------------------------- auditoria, token e ferramentas

test('a auditoria nunca vê CPF, nome, e-mail, telefone nem endereço do paciente (só o documento mascarado)', () => {
  const limpo = JSON.stringify(
    limparArgumentos(pedido({ tomador: { cpf: CPF, nome: NOME, email: 'p@exemplo.com', telefone: '(98) 99999-0000', endereco: { logradouro: 'Rua A' } }, descricao: 'paciente CPF 529.982.247-25', origem: 'venda-1' })),
  );
  for (const proibido of ['529.982.247-25', '52998224725', NOME, 'p@exemplo.com', '99999-0000', 'Rua A']) assert.ok(!limpo.includes(proibido), proibido);
  assert.ok(limpo.includes('***.***.247-**'));
  assert.ok(limpo.includes('venda-1'));
});

test('a ferramenta registrada audita SEM o paciente e devolve erro mascarado', async () => {
  const handlers = new Map<string, (a: unknown) => Promise<{ isError?: boolean; content: Array<{ text: string }> }>>();
  const server = { registerTool: (n: string, _d: unknown, h: never) => handlers.set(n, h) } as never;
  const m = montar();
  const auditados: unknown[] = [];
  registrarFocusSePermitido(server, m.ctx, m.esc, 'u1', new Set(['u1']), ((r: unknown) => auditados.push(r)) as never, { email: 'lia@exemplo.com' });
  const r = await handlers.get('focus_preparar_nota')!(pedido());
  assert.equal(r.isError, undefined);
  const resposta = JSON.parse(r.content[0]!.text) as { confirmacao: string; ambiente: string };
  assert.equal(resposta.ambiente, 'HOMOLOGAÇÃO');
  const ruim = await handlers.get('focus_preparar_nota')!(pedido({ valor: undefined }));
  assert.equal(ruim.isError, true);
  assert.match(ruim.content[0]!.text, /valor/);
  const tudo = JSON.stringify(auditados);
  assert.ok(!tudo.includes('52998224725') && !tudo.includes(CPF) && !tudo.includes(NOME));
  assert.equal(auditados.length, 2);
  const conf = await handlers.get('focus_confirmar_nota')!({ confirmacao: resposta.confirmacao });
  assert.equal(conf.isError, undefined);
  assert.equal(m.focus.emitidas.length, 1);
});

test('o token nunca sai da conta: serializada, a conta não tem o token', () => {
  const token = 'SEGREDOdoTOKEN1234567890abcdef';
  const c = contaFocusDaConfig({ slug: UNI, nome: 'Açailândia', token, ambiente: 'homologacao', numeroInicial: 1 });
  assert.ok(!JSON.stringify(c).includes(token));
  assert.ok(!Object.values(c).some((v) => typeof v === 'string' && v.includes(token)));
  assert.equal(contaDeNota(criarContextoFocus(new Map([[UNI, c]]), armazemDeNotasEmMemoria()), { unidades: () => new Set([UNI]) }, UNI).slug, UNI);
});

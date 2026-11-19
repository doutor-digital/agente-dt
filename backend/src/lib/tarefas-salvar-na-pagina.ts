/**
 * O pedaço de JavaScript da tela «Tarefas» que SALVA uma tarefa sem mentir para a atendente. UMA cópia só: a página tem o marcador `/*__SALVAR_JS__*\/` e
 * `paginaDasTarefas` chama `comSalvarNaPagina`. Fica fora do texto da página para os testes poderem rodá-lo de verdade (`vm`), com um servidor de mentira.
 *
 * O PROBLEMA (19/11/2026, duas vezes na gravação do vídeo): ao agendar apareceu «Failed to fetch» com a tarefa JÁ CRIADA. Dois buracos no `salvarForm` antigo:
 *  1. depois do POST que deu certo, a tela relia a lista (`await carregar()`) DENTRO do mesmo `try`: se a releitura caísse (rede, aba mexendo, tempo), o erro dela
 *     aparecia como se fosse o do agendamento — «Failed to fetch» com a tarefa criada;
 *  2. se o próprio POST ficasse sem resposta (a conexão caiu depois de o servidor gravar), a tela dizia «erro» sem saber se criou — e a atendente, na dúvida, criava de novo.
 *
 * O CONSERTO: erro de verdade (o servidor RESPONDEU recusando) continua erro e nada foi criado; SEM RESPOSTA é «não sei» — a tela não pergunta de novo ao servidor «cria»,
 * ela LÊ a lista e vê se a tarefa pedida (mesma conversa, tipo, hora, texto, criada agora há pouco) está lá; se está, deu certo; se não dá para saber, diz isso com todas as
 * letras e manda conferir a lista antes de tentar de novo. A releitura da lista depois de salvar nunca vira erro do agendamento.
 *
 * Sem crase nem `${` (a página é um String.raw) e sem sintaxe nova demais (a página roda em iPhone antigo).
 */

export const MARCADOR_DO_SALVAR = '/*__SALVAR_JS__*/';

/** Esperas (ms) entre as conferências da lista depois de um POST sem resposta. */
export const ESPERAS_DA_CONFERENCIA_MS = [700, 2500, 6000];
/**
 * Tempo máximo de cada chamada: a que grava e cada leitura da conferência. O pior caso inteiro (POST + esperas + 3 leituras) tem de caber na janela em que a tarefa ainda
 * «foi criada agora há pouco» (180 s em `tarefaPedida`): 45 + 9,2 + 3 × 10 = 84 s.
 */
export const TEMPO_DA_ESCRITA_MS = 45_000;
export const TEMPO_DA_LEITURA_NA_CONFERENCIA_MS = 10_000;
/** Por quanto tempo depois de criada a tarefa ainda vale como prova de «acabei de pedir». */
export const JANELA_DA_PROVA_MS = 180_000;
/** Estados em que a tarefa existe de verdade: cancelada, falhada e barrada NÃO provam que o pedido entrou (podem ser de um pedido anterior). */
export const ESTADOS_QUE_PROVAM = ['pendente', 'enviando', 'aguardando', 'feita'];

export const SALVAR_NA_PAGINA_JS =
  'var TEMPO_DA_ESCRITA_MS = ' + TEMPO_DA_ESCRITA_MS + ', TEMPO_DA_LEITURA_MS = ' + TEMPO_DA_LEITURA_NA_CONFERENCIA_MS + ', ESTADOS_QUE_PROVAM = ' + JSON.stringify(ESTADOS_QUE_PROVAM) + ';\n' +
  '  // a tarefa pedida está na lista? p = { id (só ao editar), verificavel (editar: mudou hora, texto ou responsável), conversaId, tipo, quandoLocal, texto, responsavelId, criadoPor }\n' +
  '  function tarefaPedida(d, p){\n' +
  '    var lista = (d && d.tarefas) || [];\n' +
  '    var agora = d && d.agora ? new Date(d.agora).getTime() : Date.now();\n' +
  '    for (var i = 0; i < lista.length; i++) {\n' +
  '      var t = lista[i];\n' +
  '      // cancelada/falhada/barrada pode ser de um pedido anterior igual: só prova a que existe de verdade\n' +
  '      if (ESTADOS_QUE_PROVAM.indexOf(t.estado) < 0) continue;\n' +
  "      if (t.quandoLocal !== p.quandoLocal || (t.texto || '') !== (p.texto || '')) continue;\n" +
  '      if (p.responsavelId && t.responsavel && t.responsavel.id !== p.responsavelId) continue;\n' +
  '      // editar: só prova a edição quem mudou algo que a lista mostra (salvar sem mudar nada, ou mudar só o modelo, não dá para conferir)\n' +
  '      if (p.id) { if (t.id === p.id && p.verificavel) return true; continue; }\n' +
  '      if (t.tipo !== p.tipo) continue;\n' +
  '      if (p.conversaId && t.conversaId !== p.conversaId) continue;\n' +
  '      // a tarefa igual de uma colega não prova a minha\n' +
  '      if (p.criadoPor && t.criadoPor !== p.criadoPor) continue;\n' +
  '      // criada agora há pouco: uma tarefa igual de ontem não prova nada\n' +
  '      var criada = t.criadaEm ? new Date(t.criadaEm).getTime() : 0;\n' +
  '      if (criada && agora - criada <= ' + JANELA_DA_PROVA_MS + ' && agora - criada >= -60000) return true;\n' +
  '    }\n' +
  '    return false;\n' +
  '  }\n' +
  '  // Manda o pedido. Erro COM status = o servidor respondeu e recusou: nada foi criado, lança. Sem status = sem resposta: a tarefa PODE ter sido criada, então confere a lista.\n' +
  '  async function agendarConferindo(enviar, listar, confere, espera){\n' +
  '    try { return { resposta: await enviar(), conferida: false }; }\n' +
  '    catch (e) {\n' +
  '      if (e && e.status) throw e;\n' +
  '      var esperas = ' +
  JSON.stringify(ESPERAS_DA_CONFERENCIA_MS) +
  ';\n' +
  '      for (var i = 0; i < esperas.length; i++) {\n' +
  '        await espera(esperas[i]);\n' +
  '        var d = null;\n' +
  '        try { d = await listar(); } catch (e2) { d = null; }\n' +
  '        if (d && confere(d)) return { resposta: { ok: true }, conferida: true };\n' +
  '      }\n' +
  "      var er = new Error('Não consegui confirmar se a tarefa foi agendada (a conexão caiu). Confira a lista antes de tentar de novo.');\n" +
  '      er.incerto = true;\n' +
  '      throw er;\n' +
  '    }\n' +
  '  }\n' +
  '  // Salva e atualiza a tela. O que lança aqui é erro do AGENDAMENTO; a releitura da lista que falha só vira atualizou: false.\n' +
  '  async function salvarTarefa(x){\n' +
  '    var r = await agendarConferindo(x.enviar, x.listar, x.confere, x.espera);\n' +
  '    var atualizou = true;\n' +
  '    try { await x.atualizar(); } catch (e) { atualizou = false; }\n' +
  '    return { resposta: r.resposta, conferida: r.conferida, atualizou: atualizou };\n' +
  '  }\n' +
  '  // Grava (erro lança: é do agendamento) e DEPOIS atualiza a tela; a atualização que falha só vira atualizou: false — vale para cancelar, confirmar, feita, resultado e WhatsApp.\n' +
  '  async function gravarEAtualizar(gravar, atualizar){\n' +
  '    var r = await gravar();\n' +
  '    var atualizou = true;\n' +
  '    try { await atualizar(); } catch (e) { atualizou = false; }\n' +
  '    return { resposta: r, atualizou: atualizou };\n' +
  '  }\n' +
  '  // A chamada ao servidor com tempo máximo. Só a REDE vira «sem resposta» (erro sem status, texto de gente, nunca o «Failed to fetch» cru do navegador); bug de montagem do pedido não.\n' +
  '  // O tempo vale também para ler o corpo da resposta.\n' +
  '  async function buscar(fetchFn, url, opcoes, ms){\n' +
  '    var ctl = typeof AbortController !== \'undefined\' ? new AbortController() : null;\n' +
  '    var estourou = false;\n' +
  '    var corte = ctl ? setTimeout(function(){ estourou = true; ctl.abort(); }, ms) : null;\n' +
  '    var semResposta = function(){ var er = new Error(\'Sem resposta do servidor (a conexão caiu ou demorou demais).\'); er.semResposta = true; return er; };\n' +
  '    try {\n' +
  '      var r;\n' +
  '      try { r = await fetchFn(url, ctl ? Object.assign({}, opcoes, { signal: ctl.signal }) : opcoes); } catch (e0) { throw semResposta(); }\n' +
  '      var j;\n' +
  '      try { j = await r.json(); } catch (e1) { if (estourou) throw semResposta(); j = {}; }\n' +
  '      return { r: r, j: j };\n' +
  '    } finally { if (corte) clearTimeout(corte); }\n' +
  '  }';

/** Troca o marcador pela cópia única. */
export const comSalvarNaPagina = (html: string): string => html.split(MARCADOR_DO_SALVAR).join(SALVAR_NA_PAGINA_JS);

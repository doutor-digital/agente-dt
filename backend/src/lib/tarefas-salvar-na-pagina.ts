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

export const SALVAR_NA_PAGINA_JS =
  '// a tarefa pedida está na lista? p = { id (só ao editar), conversaId, tipo, quandoLocal, texto, responsavelId }\n' +
  '  function tarefaPedida(d, p){\n' +
  '    var lista = (d && d.tarefas) || [];\n' +
  '    var agora = d && d.agora ? new Date(d.agora).getTime() : Date.now();\n' +
  '    for (var i = 0; i < lista.length; i++) {\n' +
  '      var t = lista[i];\n' +
  "      if (t.quandoLocal !== p.quandoLocal || (t.texto || '') !== (p.texto || '')) continue;\n" +
  '      if (p.id) { if (t.id === p.id) return true; continue; }\n' +
  '      if (t.tipo !== p.tipo) continue;\n' +
  '      if (p.conversaId && t.conversaId !== p.conversaId) continue;\n' +
  '      if (p.responsavelId && t.responsavel && t.responsavel.id !== p.responsavelId) continue;\n' +
  '      // criada agora há pouco: uma tarefa igual de ontem não prova nada\n' +
  '      var criada = t.criadaEm ? new Date(t.criadaEm).getTime() : 0;\n' +
  '      if (criada && agora - criada <= 180000 && agora - criada >= -60000) return true;\n' +
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
  '  }';

/** Troca o marcador pela cópia única. */
export const comSalvarNaPagina = (html: string): string => html.split(MARCADOR_DO_SALVAR).join(SALVAR_NA_PAGINA_JS);

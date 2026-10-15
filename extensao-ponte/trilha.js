/**
 * Ponte 0.5.0 — a TRILHA do cartão e o que cada etapa pede. Pura: sem chrome.* e sem DOM (o teste roda no node).
 *
 * A regra que o painel ensina (decisão do João com a chefe da DH, 18/09/2026, `backend/src/lib/franquia-move.ts`):
 * a franquia é onde a clínica registra o que aconteceu, e o cartão do Kommo ANDA SOZINHO atrás do fato. Então cada
 * etapa tem um "dono":
 *   - 'franquia' — o cartão chega e sai dela sozinho, pelo que a clínica lança na franquia (consulta marcada, baixa,
 *     tratamento, sessão, alta): AGENDADO, COMPARECEU, NÃO COMPARECEU, GANHO, EM TRATAMENTO, ALTA e RETORNO;
 *   - 'voce' — é a atendente quem trabalha e decide: entrada, EM QUALIFICAÇÃO, EM ESPERA, CONFERIR NA FRANQUIA,
 *     EM NEGOCIAÇÃO, PERDIDO e TRATAMENTO CANCELADO.
 * As etapas são reconhecidas pelo NOME (cada conta do Kommo tem os seus ids).
 *
 * 0.5.1: marcar consulta — paciente NOVO se cadastra e marca pelo widget "Assistente do cartão" do Kommo ("Cadastrar e
 * marcar na franquia"), NUNCA direto na franquia (é na redigitação que nascem os cadastros com nome e telefone errados,
 * `backend/src/lib/marcacao-widget.ts`); paciente já cadastrado marca na franquia ou pelo widget. E o nome da unidade do
 * topo do painel sai sempre do servidor, com acento (`nomeCurtoDaUnidade`), nunca do slug.
 */
(function (raiz, fabrica) {
  var api = fabrica();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else raiz.PonteTrilha = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var GANHO = 142, PERDIDO = 143;

  function normalizar(s) {
    return String(s == null ? '' : s)
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
  }

  /** A etapa pelo nome: devolve a chave da etapa ('agendado', 'qualificacao'…) ou null. A ordem importa. */
  var ETAPAS = [
    ['nao-compareceu', /\bnao compareceu\b|\bfaltou\b/],
    ['compareceu', /\bcompareceu\b/],
    ['qualificacao', /\bqualifica/],
    ['espera', /\bem espera\b|^espera\b/],
    ['conferir', /\bconferir\b/],
    ['agendado', /\bagendad/],
    ['negociacao', /\bnegocia/],
    ['retorno', /\bretorno\b/],
    ['cancelado', /\bcancelad/],
    ['em-tratamento', /\bem tratamento\b/],
    ['alta', /^alta\b|\balta\b/],
    ['ganho', /\bganho\b|\bconclu/],
    ['perdido', /\bperdid/],
    ['entrada', /\bentrada\b|^incoming/],
  ];

  function chaveDaEtapa(nome) {
    var n = normalizar(nome);
    if (!n) return null;
    for (var i = 0; i < ETAPAS.length; i++) if (ETAPAS[i][1].test(n)) return ETAPAS[i][0];
    return null;
  }

  var DONO = {
    entrada: 'voce',
    qualificacao: 'voce',
    espera: 'voce',
    conferir: 'voce',
    negociacao: 'voce',
    perdido: 'voce',
    cancelado: 'voce',
    agendado: 'franquia',
    'nao-compareceu': 'franquia',
    compareceu: 'franquia',
    ganho: 'franquia',
    'em-tratamento': 'franquia',
    alta: 'franquia',
    retorno: 'franquia',
  };

  /** 'franquia' (anda sozinha), 'voce' (é da atendente) ou null (etapa que a Ponte não conhece). */
  function donoDaEtapa(nome) {
    return DONO[chaveDaEtapa(nome)] || null;
  }

  var ROTULO_DO_DONO = {
    franquia: 'Anda sozinha pela franquia',
    voce: 'É sua: você trabalha esta etapa',
  };

  /**
   * Unidade em que o cartão NÃO anda sozinho (o servidor diz `franquiaAndaSozinha: false`: "A franquia move a etapa" ou
   * o "Sincronizador da franquia" não está ligado na tela de Automações): a etapa continua sendo da franquia, mas o painel
   * não promete movimento automático.
   */
  var ROTULO_DO_DONO_SEM_ROBO = {
    franquia: 'A recepção atualiza pela franquia',
    voce: ROTULO_DO_DONO.voce,
  };

  function rotuloDoDono(dono, semRobo) {
    return (semRobo ? ROTULO_DO_DONO_SEM_ROBO : ROTULO_DO_DONO)[dono] || null;
  }

  /** O que vem depois de cada etapa, e quem faz o cartão andar. Uma frase, do jeito que a atendente fala. */
  var DEPOIS = {
    entrada: 'Vai para EM QUALIFICAÇÃO quando alguém responder.',
    qualificacao: 'Vai sozinho para AGENDADO quando a consulta for marcada na franquia. EM ESPERA ou PERDIDO, você move pelo guia.',
    espera: 'Vai sozinho para AGENDADO quando a consulta for marcada na franquia. EM QUALIFICAÇÃO ou PERDIDO, você move.',
    conferir: 'Volta sozinho para AGENDADO quando a franquia achar a consulta. Se não marcou de verdade, você move.',
    agendado: 'Vai sozinho para COMPARECEU ou NÃO COMPARECEU quando a franquia der baixa na consulta.',
    'nao-compareceu': 'Volta sozinho para AGENDADO quando a consulta for remarcada na franquia.',
    compareceu: 'Vai sozinho para GANHO quando o tratamento for aberto na franquia.',
    negociacao: 'Vai sozinho para GANHO quando o tratamento for aberto na franquia. Se não fechar, você move para PERDIDO.',
    retorno: 'Segue sozinho como avaliação quando a franquia der baixa no retorno.',
    ganho: 'Vai sozinho para EM TRATAMENTO na 1ª sessão atendida na franquia.',
    'em-tratamento': 'Vai sozinho para ALTA quando a franquia finalizar o tratamento.',
    alta: 'Vai sozinho para RETORNO PÓS-TRATAMENTO se a franquia marcar um retorno.',
    perdido: 'Se o paciente voltar a conversar, você move para EM QUALIFICAÇÃO pelo guia.',
    cancelado: 'Fim do caminho deste tratamento.',
  };

  /** O mesmo, sem prometer que anda sozinho: quem atualiza o cartão é a recepção. */
  var DEPOIS_SEM_ROBO = {
    qualificacao: 'Vai para AGENDADO quando a consulta for marcada na franquia (a recepção atualiza o cartão). EM ESPERA ou PERDIDO, você move pelo guia.',
    espera: 'Vai para AGENDADO quando a consulta for marcada na franquia (a recepção atualiza o cartão). EM QUALIFICAÇÃO ou PERDIDO, você move.',
    conferir: 'Volta para AGENDADO quando a recepção achar a consulta na franquia. Se não marcou de verdade, você move.',
    agendado: 'Vai para COMPARECEU ou NÃO COMPARECEU quando a recepção der baixa na consulta, na franquia.',
    'nao-compareceu': 'Volta para AGENDADO quando a consulta for remarcada na franquia (a recepção atualiza o cartão).',
    compareceu: 'Vai para GANHO quando o tratamento for aberto na franquia (a recepção atualiza o cartão).',
    negociacao: 'Vai para GANHO quando o tratamento for aberto na franquia. Se não fechar, você move para PERDIDO.',
    retorno: 'Segue como avaliação quando a recepção der baixa no retorno, na franquia.',
    ganho: 'Vai para EM TRATAMENTO quando a 1ª sessão for atendida (a recepção atualiza o cartão).',
    'em-tratamento': 'Vai para ALTA quando a franquia finalizar o tratamento (a recepção atualiza o cartão).',
    alta: 'Vai para RETORNO PÓS-TRATAMENTO se a franquia marcar um retorno (a recepção atualiza o cartão).',
  };

  function depoisDaEtapa(nome, semRobo) {
    var k = chaveDaEtapa(nome);
    return (semRobo && DEPOIS_SEM_ROBO[k]) || DEPOIS[k] || null;
  }

  /**
   * As estações da trilha a partir da barra do servidor (`{ funil, noFunil, etapas: [{ id, nome, atual }] }`).
   * "Feita" é só etapa do caminho antes da atual; as saídas (GANHO/PERDIDO) nunca são feitas, e um cartão PERDIDO
   * não diz até onde chegou — nada se pinta como feito (a mesma regra da barrinha da 0.4.0).
   */
  function estacoes(barra) {
    var lista = (barra && barra.etapas) || [];
    var atual = -1;
    lista.forEach(function (e, i) { if (e.atual) atual = i; });
    var perdido = atual >= 0 && (lista[atual].id === PERDIDO || chaveDaEtapa(lista[atual].nome) === 'perdido');
    return lista.map(function (e, i) {
      var saida = e.id === GANHO || e.id === PERDIDO;
      var estado = i === atual ? 'atual' : !perdido && !saida && i < atual ? 'feita' : 'futura';
      return { id: e.id, nome: e.nome, dono: donoDaEtapa(e.nome), saida: saida, estado: estado, chave: chaveDaEtapa(e.nome) };
    });
  }

  /** "há 2 dias", "há 5 h", "há 20 min", "agora há pouco" — o tempo do cartão nesta etapa. */
  function tempoNaEtapa(iso, agora) {
    var t = new Date(iso).getTime();
    if (!iso || isNaN(t)) return null;
    var s = Math.max(0, Math.floor(((agora || new Date()).getTime() - t) / 1000));
    if (s < 60) return 'agora há pouco';
    if (s < 3600) return 'há ' + Math.floor(s / 60) + ' min';
    if (s < 86400) return 'há ' + Math.floor(s / 3600) + ' h';
    var d = Math.floor(s / 86400);
    return d === 1 ? 'há 1 dia' : 'há ' + d + ' dias';
  }

  /** Quanto tempo é "parado demais" na etapa (dias), para a cor do relógio. Só as etapas em que esperar custa. */
  var DIAS_DE_ALERTA = { entrada: 1, qualificacao: 2, 'nao-compareceu': 3, compareceu: 2, negociacao: 3, conferir: 2 };

  function relogioAtrasado(nome, iso, agora) {
    var lim = DIAS_DE_ALERTA[chaveDaEtapa(nome)];
    var t = new Date(iso).getTime();
    if (!lim || !iso || isNaN(t)) return false;
    return ((agora || new Date()).getTime() - t) / 86400000 >= lim;
  }

  /**
   * "O que é seu agora": de 1 a 3 ações claras para a etapa. A primeira é o próximo passo que o servidor já monta
   * (`resumo.proximoPasso`, que sabe a data da consulta), quando há. `ctx`: { proximoPasso, qualificacao,
   * proximaSessao: { dia, hora } }.
   */
  function acoesDaEtapa(nome, ctx) {
    var c = ctx || {};
    var k = chaveDaEtapa(nome);
    var lista = [];
    var sessao = c.proximaSessao && c.proximaSessao.dia ? c.proximaSessao.dia + (c.proximaSessao.hora ? ' às ' + c.proximaSessao.hora : '') : null;
    switch (k) {
      case 'entrada':
      case 'qualificacao':
        lista = ['Responder, entender a dor e oferecer a avaliação.'];
        if (c.qualificacao === null) lista.push('Marcar a ★ Qualificação: Quente, Morno ou Frio.');
        lista.push('Não quer marcar agora? Mova para EM ESPERA, com a data de retomar.');
        break;
      case 'espera':
        lista = ['Retomar o contato no dia do ◷ Retomar em.', 'Oferecer um horário de novo. Paciente novo se cadastra e marca pelo widget "Assistente do cartão".'];
        break;
      case 'conferir':
        lista = ['Procurar o paciente na franquia pelo nome e pelo telefone.', 'Não marcou de verdade? Mova pelo guia (EM QUALIFICAÇÃO ou PERDIDO).'];
        break;
      case 'agendado':
        lista = ['Confirmar a presença na véspera da consulta.', 'Mandar o endereço da clínica (aba Respostas).',
          c.semRobo ? 'Paciente desmarcou? Desmarque na franquia.' : 'Paciente desmarcou? Desmarque na franquia: o cartão anda sozinho.'];
        break;
      case 'nao-compareceu':
        lista = ['Ligar e oferecer um novo horário.', 'Anotar o ⊘ Motivo da falta.'];
        break;
      case 'compareceu':
        lista = ['Apresentar o plano de tratamento e combinar o início.', 'Ficou de pensar? Mova para EM NEGOCIAÇÃO pelo guia.'];
        break;
      case 'negociacao':
        lista = ['Retomar a conversa: tirar as dúvidas de valor e de forma de pagamento.', 'Não vai fechar? Mova para PERDIDO, com o motivo.'];
        break;
      case 'retorno':
        lista = ['Confirmar a presença no retorno marcado.'];
        break;
      case 'ganho':
        lista = [c.semRobo ? 'Nada no Kommo: o tratamento segue pela franquia.' : 'Nada no Kommo: a 1ª sessão atendida leva o cartão para EM TRATAMENTO.'];
        break;
      case 'em-tratamento':
        lista = [sessao ? 'Lembrar a próxima sessão: ' + sessao + '.' : 'Lembrar o paciente das sessões marcadas.', 'Faltou a uma sessão? Chame para remarcar (a remarcação é na franquia).'];
        break;
      case 'alta':
        lista = ['Nada no Kommo: o tratamento terminou.', 'Quer voltar? O retorno se marca na franquia.'];
        break;
      case 'perdido':
        lista = ['Nada a fazer, a não ser que o paciente volte a conversar.'];
        break;
      case 'cancelado':
        lista = ['Nada a fazer: o cancelamento já está registrado.'];
        break;
      default:
        lista = [];
    }
    // o próximo passo do servidor (com a data da consulta) entra no lugar da primeira ação, que é a mesma ideia
    if (c.proximoPasso && lista.length && (k === 'agendado' || k === 'qualificacao' || k === 'entrada' || k === 'espera' || k === 'nao-compareceu' || k === 'compareceu' || k === 'retorno')) {
      lista[0] = c.proximoPasso;
    } else if (c.proximoPasso && !lista.length) {
      lista = [c.proximoPasso];
    }
    return lista.slice(0, 3);
  }

  /**
   * O que NÃO se faz à mão no Kommo: é da franquia, e o cartão anda sozinho atrás. 0.5.1: marcar consulta tem regra
   * própria — paciente NOVO, só pelo widget "Assistente do cartão" ("Cadastrar e marcar na franquia"), nunca direto na
   * franquia; paciente já cadastrado, na franquia ou pelo widget.
   */
  var COMO_MARCAR = 'Paciente novo: cadastre e marque pelo widget "Assistente do cartão" do Kommo (Cadastrar e marcar na franquia), nunca direto na franquia. ' +
    'Já cadastrado: marque na franquia ou pelo widget.';
  var DA_FRANQUIA = COMO_MARCAR + ' Dar baixa e lançar sessão se faz NA FRANQUIA; o cartão anda sozinho aqui.';
  var DA_FRANQUIA_SEM_ROBO = COMO_MARCAR + ' Dar baixa e lançar sessão se faz NA FRANQUIA; nesta unidade, a recepção atualiza o cartão pela franquia.';

  function regraDaFranquia(semRobo) {
    return semRobo ? DA_FRANQUIA_SEM_ROBO : DA_FRANQUIA;
  }

  /** A qualificação do campo ★ Qualificação: nível (para a cor) e ícone. Sem o campo na conta → null. */
  function qualificacao(valor) {
    if (valor === undefined) return null;
    var n = normalizar(valor);
    if (/quente/.test(n)) return { nivel: 'quente', rotulo: 'Quente', icone: 'chama' };
    if (/morno/.test(n)) return { nivel: 'morno', rotulo: 'Morno', icone: 'morno' };
    if (/frio/.test(n)) return { nivel: 'frio', rotulo: 'Frio', icone: 'frio' };
    if (!n) return { nivel: 'sem', rotulo: 'Sem qualificação', icone: 'estrela' };
    return { nivel: 'outra', rotulo: String(valor), icone: 'estrela' };
  }

  /** Cores dos selos de unidade (fundo claro + texto escuro, contraste ≥ 4,5). A mesma unidade, a mesma cor. */
  var CORES_DE_UNIDADE = ['indigo', 'teal', 'magenta', 'verde', 'laranja', 'azul'];

  /** As unidades que dividem um Kommo têm cores FIXAS e diferentes (o hash podia dar a mesma cor para as duas). */
  var COR_FIXA = { petropolis: 'indigo', caxias: 'magenta', 'duque de caxias': 'magenta' };

  function corDaUnidade(nome) {
    var n = normalizar(nome);
    if (!n) return null;
    if (COR_FIXA[n]) return COR_FIXA[n];
    // FNV-1a: espalha melhor que o "×31" entre nomes parecidos
    var h = 2166136261;
    for (var i = 0; i < n.length; i++) h = Math.imul(h ^ n.charCodeAt(i), 16777619) >>> 0;
    return CORES_DE_UNIDADE[h % CORES_DE_UNIDADE.length];
  }

  /**
   * O selo da unidade. `c.unidade` (0.5.0): `{ nome, compartilhada }` — `nome` é o ⌂ Unidade de atendimento do cartão
   * (conta de duas unidades, como Petrópolis + Caxias) ou o nome da unidade (conta de uma só). Sem isso (servidor
   * antigo), o nome da unidade que a franquia devolveu.
   */
  function unidadeDoCartao(c, franquia) {
    var u = c && c.unidade;
    if (u && typeof u === 'object') {
      var nome = u.nome ? String(u.nome) : null;
      return { nome: nome, vazia: !nome && !!u.compartilhada, compartilhada: !!u.compartilhada, cor: corDaUnidade(nome) };
    }
    // servidor de hoje, conta de duas unidades com o campo vazio: a franquia RECUSA (e o nome que vem é o da conta,
    // não o do cartão) — o selo pede a unidade em vez de mostrar uma unidade que pode estar errada
    if (franquiaPedeUnidade(franquia)) return { nome: null, vazia: true, compartilhada: true, cor: null };
    var daFranquia = franquia && franquia.unidade ? String(franquia.unidade) : null;
    return daFranquia ? { nome: daFranquia, vazia: false, compartilhada: false, cor: corDaUnidade(daFranquia) } : null;
  }

  /** "doutor-hernia-petropolis" → "Petropolis": só quando o servidor não disse o nome (sem acento — último recurso). */
  function nomeDoSlug(slug) {
    return String(slug || '').replace(/^doutor-hernia-/, '').split('-').filter(Boolean)
      .map(function (p) { return p.charAt(0).toUpperCase() + p.slice(1); }).join(' ');
  }

  /** Nome que não diz a cidade (a unidade de Imperatriz se chama "Comercial" no banco). */
  var NOMES_GENERICOS = ['comercial', 'unidade', 'clinica'];

  /**
   * 0.5.1: o nome da unidade para o topo do painel, do jeito do servidor (`nomeCurtoDaUnidade`, em
   * `backend/src/lib/ponte-painel.ts`): "Doutor Hérnia Petrópolis" → "Petrópolis". O cartão já manda o curto; a fila e o
   * `/ping` mandam o nome inteiro — os três viram o MESMO texto, com acento. Nome genérico cai no slug.
   */
  function nomeCurtoDaUnidade(nome, slug) {
    var curto = String(nome == null ? '' : nome).replace(/^\s*doutor\s+h[eé]rnia\s*[-–·:]?\s*/i, '').trim();
    if (curto && NOMES_GENERICOS.indexOf(normalizar(curto)) < 0) return curto.slice(0, 60);
    return nomeDoSlug(slug);
  }

  /** A franquia recusou porque o cartão está sem o ⌂ Unidade de atendimento (conta de duas unidades)? */
  function franquiaPedeUnidade(franquia) {
    if (!franquia) return false;
    return franquia.codigo === 'sem_unidade' || /unidade de atendimento/i.test(String(franquia.erro || ''));
  }

  /** A consulta da franquia, do jeito que a atendente fala: veio, faltou, desmarcou, confirmada… */
  function situacaoDaConsulta(status) {
    var n = normalizar(status);
    if (!n) return null;
    if (/nao compareceu|falt/.test(n)) return { rotulo: 'Faltou', nivel: 'ruim' };
    if (/atendid|compareceu|realizad/.test(n)) return { rotulo: 'Compareceu', nivel: 'bom' };
    if (/desmarc|cancel/.test(n)) return { rotulo: 'Desmarcada', nivel: 'neutro' };
    if (/confirmad/.test(n)) return { rotulo: 'Confirmada', nivel: 'bom' };
    if (/remarcad/.test(n)) return { rotulo: 'Remarcada', nivel: 'info' };
    if (/agendad/.test(n)) return { rotulo: 'Agendada', nivel: 'info' };
    return { rotulo: String(status), nivel: 'neutro' };
  }

  /** "hoje", "amanhã", "em 3 dias", "há 2 dias" — a distância em dias corridos (no fuso `tz`) até `iso`. */
  function diasAte(iso, agora, tz) {
    var t = new Date(iso);
    if (!iso || isNaN(t.getTime())) return null;
    var dia = function (d) {
      var p = d.toLocaleDateString('en-CA', { timeZone: tz || 'America/Sao_Paulo' }).split('-');
      return Date.UTC(+p[0], +p[1] - 1, +p[2]);
    };
    var n = Math.round((dia(t) - dia(agora || new Date())) / 86400000);
    if (n === 0) return 'hoje';
    if (n === 1) return 'amanhã';
    if (n === -1) return 'ontem';
    return n > 0 ? 'em ' + n + ' dias' : 'há ' + -n + ' dias';
  }

  /** Dia da semana curto ("qui") no fuso da unidade. */
  function diaDaSemana(iso, tz) {
    var t = new Date(iso);
    if (!iso || isNaN(t.getTime())) return null;
    return t.toLocaleDateString('pt-BR', { weekday: 'short', timeZone: tz || 'America/Sao_Paulo' }).replace('.', '');
  }

  /** O tratamento terminou? (status da franquia ou o cartão em ALTA) */
  function teveAlta(tratamento, etapa) {
    if (chaveDaEtapa(etapa) === 'alta') return true;
    return !!(tratamento && /finaliz|conclu|\balta\b/.test(normalizar(tratamento.status)));
  }

  return Object.freeze({
    GANHO: GANHO,
    PERDIDO: PERDIDO,
    normalizar: normalizar,
    chaveDaEtapa: chaveDaEtapa,
    donoDaEtapa: donoDaEtapa,
    ROTULO_DO_DONO: ROTULO_DO_DONO,
    rotuloDoDono: rotuloDoDono,
    regraDaFranquia: regraDaFranquia,
    DA_FRANQUIA_SEM_ROBO: DA_FRANQUIA_SEM_ROBO,
    depoisDaEtapa: depoisDaEtapa,
    estacoes: estacoes,
    tempoNaEtapa: tempoNaEtapa,
    relogioAtrasado: relogioAtrasado,
    acoesDaEtapa: acoesDaEtapa,
    DA_FRANQUIA: DA_FRANQUIA,
    COMO_MARCAR: COMO_MARCAR,
    nomeDoSlug: nomeDoSlug,
    nomeCurtoDaUnidade: nomeCurtoDaUnidade,
    qualificacao: qualificacao,
    corDaUnidade: corDaUnidade,
    unidadeDoCartao: unidadeDoCartao,
    franquiaPedeUnidade: franquiaPedeUnidade,
    situacaoDaConsulta: situacaoDaConsulta,
    diasAte: diasAte,
    diaDaSemana: diaDaSemana,
    teveAlta: teveAlta,
  });
});

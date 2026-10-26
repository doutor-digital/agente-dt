/**
 * VIGIA DE UNIDADE — o MEDIDOR. Zero IA, zero escrita, zero envio.
 *
 * Conta 9 coisas que a dona (Suzanne) pediu para não precisar mais digitar, imprime UM JSON e sai.
 * Quem compara com a rodada anterior, quem alerta e quem acorda o auditor é o `vigia-unidade.py`,
 * que roda no host da VPS. Aqui dentro NADA é gravado: nem no Kommo, nem no banco, nem no Telegram.
 *
 * COMO RODA (o host não tem node; o agente tem, dentro do container):
 *   CID=$(docker ps --filter name=ddagent_agent --format '{{.ID}}' | head -1)
 *   docker exec -i -w /repo/backend -e LOG_LEVEL=silent -e VIGIA_SLUG=doutor-hernia-petropolis \
 *     "$CID" node --input-type=module - < /root/vigia-petropolis/medir-unidade.mjs
 *
 * Por que stdin e não um arquivo dentro do container: o script não precisa de deploy nem de
 * `docker cp` — o container continua sendo exatamente a imagem que o GHCR publicou.
 *
 * PARÂMETROS (por variável de ambiente; o stdin já é o código):
 *   VIGIA_SLUG              slug da unidade (padrão doutor-hernia-petropolis)
 *   VIGIA_ROTULO_UNIDADE    valor do campo "⌂ Unidade de atendimento" desta unidade (padrão Petrópolis)
 *   VIGIA_CAMPO_UNIDADE     id do campo (padrão 479786)
 *   VIGIA_HORAS_TALKS       quantas horas de conversa entram na varredura (padrão 12; passo fundo: 72)
 *   VIGIA_TETO_LEITURAS     teto de conversas lidas na rodada (padrão 120) — a API é compartilhada
 *   VIGIA_PAUSA_MS          espaço entre leituras (padrão 260 ms) — deixa folga para o atendimento
 *   VIGIA_PROFUNDO=1        passo fundo: mede também o que é de estoque/dia (2, 5, 6, 8)
 *   VIGIA_USUARIO_INTEGRACAO nome do usuário de integração (padrão "Doutor Digital")
 *
 * REGRA: o vigia vigia o SISTEMA, não as pessoas. Nenhum nome de SDR, nenhum número por pessoa,
 * nenhum texto de paciente sai daqui — só contagem e número de cartão.
 */

const env = process.env;
const SLUG = env.VIGIA_SLUG || 'doutor-hernia-petropolis';
const ROTULO = env.VIGIA_ROTULO_UNIDADE || 'Petrópolis';
const CAMPO_UNIDADE = Number(env.VIGIA_CAMPO_UNIDADE || 479786);
const HORAS_TALKS = Number(env.VIGIA_HORAS_TALKS || 12);
const TETO_LEITURAS = Number(env.VIGIA_TETO_LEITURAS || 120);
const PAUSA_MS = Number(env.VIGIA_PAUSA_MS || 260);
const PROFUNDO = env.VIGIA_PROFUNDO === '1';
const NOME_INTEGRACAO = (env.VIGIA_USUARIO_INTEGRACAO || 'Doutor Digital').toLowerCase();
const AGORA = new Date();

const { prisma } = await import('/repo/backend/dist/lib/prisma.js');
const { createKommoClient, buildHttp } = await import('/repo/backend/dist/services/kommo.service.js');
const { mensagensOficiais } = await import('/repo/backend/dist/services/kommo-talks.service.js');
const { searchSchedules } = await import('/repo/backend/dist/services/spine.service.js');
const { recarregarAutomacoes, panoramaDaUnidade } = await import('/repo/backend/dist/lib/automacoes-estado.js');

const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
const saida = {
  ok: false,
  slug: SLUG,
  em: AGORA.toISOString(),
  passo: PROFUNDO ? 'profundo' : 'janela',
  janelaHoras: HORAS_TALKS,
  leituras: 0,
  tetoAtingido: false,
  contadores: {},
  erros: [],
};
const conta = (id, nome, valor, extra = {}) => {
  saida.contadores[id] = { nome, valor, ...extra };
};
const naoMedido = (id, nome, motivo) => {
  saida.contadores[id] = { nome, valor: null, naoMedido: motivo };
};

try {
  const unit = await prisma.unit.findUnique({ where: { slug: SLUG } });
  if (!unit) throw new Error(`unidade ${SLUG} não existe no banco do agente`);
  const kommo = createKommoClient(unit);
  const http = buildHttp({ subdomain: unit.kommoSubdomain, accessToken: unit.kommoAccessToken });

  // ───────────────────────── relógio local da unidade ─────────────────────────
  const TZ = unit.spineTimezone || 'America/Sao_Paulo';
  const dia = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
  const minutosDoDia = (d) => {
    const [h, m] = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(d).split(':');
    return Number(h) * 60 + Number(m);
  };
  const diaDaSemana = (d) => new Date(`${dia(d)}T12:00:00Z`).getUTCDay();
  /** De quanto o fuso da unidade está do UTC NAQUELE instante (resolve horário de verão sem tabela). */
  const desvioDoFuso = (d) => Date.parse(`${dia(d)}T${String(Math.floor(minutosDoDia(d) / 60)).padStart(2, '0')}:${String(minutosDoDia(d) % 60).padStart(2, '0')}:00Z`) - Math.floor(d.getTime() / 60000) * 60000;
  /** O instante UTC de `AAAA-MM-DD hh:mm` no relógio da unidade. */
  const instanteLocal = (yyyymmdd, hhmm) => {
    const palpite = Date.parse(`${yyyymmdd}T${hhmm}:00Z`);
    return new Date(palpite - desvioDoFuso(new Date(palpite)));
  };
  const paraMinutos = (hhmmss) => {
    const m = /^(\d{1,2}):(\d{2})/.exec(String(hhmmss ?? ''));
    return m ? Number(m[1]) * 60 + Number(m[2]) : null;
  };
  // O plantão: a agenda da unidade, com o mesmo teto do alerta de SLA (8h–20h). Fora dele o
  // contador 1 não é medido — a noite é assunto do contador 2.
  const ABRE = Math.max(paraMinutos(unit.spineAgendaStart) ?? 8 * 60, 8 * 60);
  const FECHA = Math.min(paraMinutos(unit.spineAgendaEnd) ?? 18 * 60, 20 * 60);
  const DIAS = unit.spineAgendaDays?.length ? unit.spineAgendaDays : [1, 2, 3, 4, 5];
  const noPlantao = (d) => DIAS.includes(diaDaSemana(d)) && minutosDoDia(d) >= ABRE && minutosDoDia(d) < FECHA;
  saida.plantao = { abre: ABRE, fecha: FECHA, dias: DIAS, tz: TZ, agoraNoPlantao: noPlantao(AGORA) };

  // ───────────────────────── candidatos (incremental) ─────────────────────────
  // Só as conversas mexidas na janela — nunca as 200 do mês. É isto que mantém a API livre
  // para o atendimento das outras cidades.
  const desde = Math.floor((AGORA.getTime() - HORAS_TALKS * 3600_000) / 1000);
  let talks = [];
  let completa = true;
  try {
    const r = await kommo.listarConversasDesde(desde, 6);
    talks = r.conversas;
    completa = r.completa;
  } catch (err) {
    saida.erros.push(`talks: ${String(err).slice(0, 120)}`);
  }
  const idsDeConversa = [...new Set(talks.map((t) => Number(t.entity_id)).filter(Boolean))];

  /** Busca os cartões em lotes de 50, com os campos — é onde se descobre de quem é o cartão. */
  const cartoesPorId = async (ids) => {
    const out = [];
    for (let i = 0; i < ids.length; i += 50) {
      try {
        out.push(...(await kommo.listLeadsPorIds(ids.slice(i, i + 50))));
      } catch (err) {
        saida.erros.push(`leads: ${String(err).slice(0, 120)}`);
      }
    }
    return out;
  };
  const unidadeDo = (l) => (l.custom_fields_values ?? []).find((x) => x.field_id === CAMPO_UNIDADE)?.values?.[0]?.value ?? null;

  const cartoesDaJanela = idsDeConversa.length ? await cartoesPorId(idsDeConversa) : [];
  const meus = cartoesDaJanela.filter((l) => unidadeDo(l) === ROTULO);
  // Cartão sem unidade conversando AGORA é ponto cego: não entra em Petrópolis nem em Caxias, e
  // portanto não entra em contador nenhum. Medido em 26/10: 9 de 67 na janela de 12 h.
  const semUnidadeFalando = cartoesDaJanela.filter((l) => !unidadeDo(l)).map((l) => l.id);

  // ───────────────────────── a leitura da conversa (uma só vez) ─────────────────────────
  // Contadores 1, 3 e 9 saem todos da MESMA leitura. Ler duas vezes seria pagar a API duas vezes.
  const COBRANCA = /não tive retorno|nao tive retorno|não tivemos retorno|nao tivemos retorno/i;
  const ehAudio = (m) => /\[áudio\]/i.test(m.texto ?? '') || (m.anexo?.tipo ?? '').toLowerCase().includes('audio');
  const ehArquivo = (m) => /\[arquivo\]|\[imagem\]/i.test(m.texto ?? '') || (!!m.anexo && !ehAudio(m));

  const semResposta = [];      // 1
  const cobrancaInjusta = [];  // 3
  const arquivoParado = [];    // 9
  const suspeitosArquivo = [];

  for (const l of meus) {
    if (saida.leituras >= TETO_LEITURAS) { saida.tetoAtingido = true; break; }
    let msgs = [];
    try {
      msgs = await mensagensOficiais(kommo, l.id, 40);
      saida.leituras++;
    } catch {
      continue; // cartão sem conversa não é defeito
    }
    await dormir(PAUSA_MS);
    if (!msgs.length) continue;
    msgs.sort((a, b) => +a.em - +b.em);
    const entradas = msgs.filter((m) => m.direcao === 'entrada');
    const saidas = msgs.filter((m) => m.direcao === 'saida');

    // 1 — espera do paciente: a 1ª mensagem dele depois da última que saiu.
    const ultimaSaida = saidas.length ? +saidas[saidas.length - 1].em : 0;
    const esperando = entradas.find((m) => +m.em > ultimaSaida);
    if (esperando) {
      const esperaMin = Math.round((AGORA.getTime() - +esperando.em) / 60000);
      if (esperaMin > 15 && noPlantao(esperando.em) && noPlantao(AGORA)) {
        semResposta.push({ cartao: l.id, esperaMin });
      }
    }

    // 3 — cobrança injusta: o robô disse "não tive retorno" com o paciente tendo escrito há <= 3 h.
    for (const c of saidas.filter((m) => COBRANCA.test(m.texto ?? ''))) {
      const antes = entradas.filter((m) => +m.em < +c.em).pop();
      if (antes && (+c.em - +antes.em) / 60000 <= 180) {
        cobrancaInjusta.push({ cartao: l.id, em: c.em.toISOString(), minutosDepoisDoPaciente: Math.round((+c.em - +antes.em) / 60000) });
        break;
      }
    }

    // 9 — mandou arquivo/imagem e o cartão não andou: só os de 24 h+ viram suspeita.
    const arq = entradas.filter(ehArquivo).pop();
    if (arq && AGORA.getTime() - +arq.em >= 24 * 3600_000) suspeitosArquivo.push({ lead: l, em: +arq.em });
  }

  semResposta.sort((a, b) => b.esperaMin - a.esperaMin);
  conta('1_sem_resposta_15min', 'pacientes sem resposta há mais de 15 min no plantão',
    noPlantao(AGORA) ? semResposta.length : null,
    noPlantao(AGORA)
      ? {
          limiar: 0,
          maiorEsperaMin: semResposta[0]?.esperaMin ?? 0,
          cartoes: semResposta.slice(0, 10),
          base: 'mediana do plantão hoje = 5 min (26/10) — acima de 15 min é anomalia de verdade',
        }
      : { naoMedido: 'fora do plantão — a noite é do contador 2' });

  conta('3_cobranca_injusta', 'cartões que levaram "não tive retorno" tendo o paciente escrito antes',
    cobrancaInjusta.length, { limiar: 0, tolerancia: 'zero — qualquer novo é alerta', cartoes: cobrancaInjusta.slice(0, 10), base: '35 no mês (26/10)' });

  // 9 — confirma a etapa parada só nos suspeitos (1 chamada por suspeito, não por cartão).
  for (const s of suspeitosArquivo) {
    try {
      const mudou = await kommo.ultimaMudancaDeEtapa(s.lead.id);
      await dormir(PAUSA_MS);
      if (!mudou || mudou * 1000 < s.em) arquivoParado.push({ cartao: s.lead.id, horasParado: Math.round((AGORA.getTime() - s.em) / 3600_000) });
    } catch { /* evento indisponível: não inventa defeito */ }
  }
  conta('9_arquivo_sem_andar', 'pacientes que mandaram arquivo/imagem e o cartão não mudou de etapa em 24 h',
    arquivoParado.length, { limiar: 0, cartoes: arquivoParado.slice(0, 10) });

  // ───────────────────────── 4 — tarefas abertas e vencidas (conta inteira) ─────────────────────────
  try {
    const agoraSeg = Math.floor(AGORA.getTime() / 1000);
    let total = 0;
    const porTitulo = {};
    for (let page = 1; page <= 20; page++) {
      const { data, status } = await http.get('/tasks', {
        params: { limit: 250, page, 'filter[is_completed]': 0, 'filter[complete_till][to]': agoraSeg },
      });
      if (status === 204 || !data) break;
      const lote = data?._embedded?.tasks ?? [];
      for (const t of lote) {
        total++;
        const chave = String(t.text ?? '').slice(0, 60);
        porTitulo[chave] = (porTitulo[chave] ?? 0) + 1;
      }
      if (lote.length < 250) break;
    }
    conta('4_tarefas_vencidas', 'tarefas abertas e vencidas na conta', total, {
      limiar: 50,
      base: '781 em 26/10 (robô "[GUIA] Novo lead em QUALIFICAÇÃO", prazo de 5 min)',
      topo: Object.entries(porTitulo).sort((a, b) => b[1] - a[1]).slice(0, 3),
    });
  } catch (err) {
    naoMedido('4_tarefas_vencidas', 'tarefas abertas e vencidas na conta', `falha na API: ${String(err).slice(0, 80)}`);
  }

  // ───────────────────────── 7 — "Ligada" na tela, rodando em seco ─────────────────────────
  // O defeito que escondeu o franquia-sync por 12 dias. Não é volume: é CONFIGURAÇÃO, e por isso
  // é o contador mais valioso. Duas provas independentes:
  //   (a) a automação está "Ligada" e mesmo assim registrou decisão CONDICIONAL ("moveria",
  //       "gravaria", "etiquetaria", "alertaria") DEPOIS da hora em que foi ligada. Condicional =
  //       não fez. "confere"/"diverge"/"pularia" não entram: esses robôs registram ligados também,
  //       e contá-los daria alarme falso todo dia (514 "confere" do unidade-por-canal hoje).
  //   (b) portão global de seco que a tela NÃO mostra (`FRANQUIA_REVISAO_SECO=1` vale pra rede
  //       inteira e vence o "Ligada" da revisão). O `PARADOS_SECO` não entra aqui porque a tela
  //       ganha dele no código (`parados.ts: modoSeco`) — medido, não suposto.
  const ACOES_CONDICIONAIS = ['moveria', 'gravaria', 'etiquetaria', 'alertaria'];
  try {
    await recarregarAutomacoes();
    const panorama = panoramaDaUnidade(SLUG);
    const ligadas = new Map(panorama.filter((a) => a.estado === 'ligado').map((a) => [a.id, a.nome]));
    const linhas = await prisma.unitAutomacao.findMany({ where: { unitId: unit.id }, select: { automacao: true, atualizadoEm: true } });
    const ligadaDesde = new Map(linhas.map((l) => [l.automacao, l.atualizadoEm]));
    const simuladas = await prisma.automacaoSimulacao.groupBy({
      by: ['automacao'],
      where: {
        unitId: unit.id,
        acao: { in: ACOES_CONDICIONAIS },
        ultimaEm: { gte: new Date(AGORA.getTime() - 24 * 3600_000) },
      },
      _count: { _all: true },
      _max: { ultimaEm: true },
    });
    const mentirosas = [];
    for (const s of simuladas) {
      if (!ligadas.has(s.automacao)) continue; // em "Só no papel" a tela já diz a verdade
      const desde = ligadaDesde.get(s.automacao);
      const ultima = s._max.ultimaEm;
      // Simulação ANTES de a chave ser ligada é história, não defeito.
      if (desde && ultima && ultima <= desde) continue;
      mentirosas.push({
        automacao: s.automacao,
        nome: ligadas.get(s.automacao),
        decisoesEmSeco24h: s._count._all,
        ultimaEm: ultima ? ultima.toISOString() : null,
        ligadaDesde: desde ? desde.toISOString() : '(vem do .env)',
      });
    }
    const portoes = [];
    if (/^(1|true|sim)$/i.test((env.FRANQUIA_REVISAO_SECO ?? '').trim()) && ligadas.has('franquia-revisao')) {
      portoes.push({ chave: 'FRANQUIA_REVISAO_SECO=1', automacao: 'franquia-revisao', efeito: 'a tela diz Ligada e a revisão só registra' });
    }
    conta('7_ligada_mas_seca', 'automações que a tela mostra "Ligada" e que rodaram em seco',
      mentirosas.length + portoes.length, {
        limiar: 0,
        automacoes: mentirosas,
        portoesGlobais: portoes,
        ligadasNaTela: ligadas.size,
        base: 'o franquia-sync ficou 12 dias assim sem ninguém ver',
      });
  } catch (err) {
    naoMedido('7_ligada_mas_seca', 'automações "Ligada" rodando em seco', `falha: ${String(err).slice(0, 80)}`);
  }

  // ───────────────────────── passo fundo (1×/dia): 2, 5, 6, 8 ─────────────────────────
  if (!PROFUNDO) {
    for (const [id, nome] of [
      ['2_madrugada_sem_retomada', 'leads da madrugada não retomados até as 9h'],
      ['5_responsavel_integracao', 'cartões com responsável = usuário de integração'],
      ['6_sem_campo_unidade', 'cartões sem "⌂ Unidade de atendimento"'],
      ['8_avaliacoes_7dias', 'avaliações marcadas nos próximos 7 dias'],
    ]) naoMedido(id, nome, 'só no passo fundo (VIGIA_PROFUNDO=1)');
  } else {
    // 2 — entrou entre 19h e 7h e ninguém retomou até as 9h. Só vale depois das 9h.
    const hoje = dia(AGORA);
    const nove = instanteLocal(hoje, '09:00');
    if (AGORA < nove) {
      naoMedido('2_madrugada_sem_retomada', 'leads da madrugada não retomados até as 9h', 'ainda não deu 9h');
    } else {
      const ontem = dia(new Date(AGORA.getTime() - 86_400_000));
      const inicioNoite = instanteLocal(ontem, '19:00');
      const fimNoite = instanteLocal(hoje, '07:00');
      let noturnos = [];
      try {
        const brutos = await kommo.listLeadsCriadosEntre(Math.floor(+inicioNoite / 1000), Math.floor(+fimNoite / 1000));
        const cheios = brutos.length && !brutos[0]?.custom_fields_values ? await cartoesPorId(brutos.map((l) => l.id)) : brutos;
        noturnos = cheios.filter((l) => unidadeDo(l) === ROTULO);
      } catch (err) {
        saida.erros.push(`noturnos: ${String(err).slice(0, 120)}`);
      }
      const esquecidos = [];
      for (const l of noturnos) {
        if (saida.leituras >= TETO_LEITURAS) { saida.tetoAtingido = true; break; }
        try {
          const msgs = await mensagensOficiais(kommo, l.id, 20);
          saida.leituras++;
          await dormir(PAUSA_MS);
          const respondeuAte9 = msgs.some((m) => m.direcao === 'saida' && +m.em <= +nove);
          if (!respondeuAte9) esquecidos.push(l.id);
        } catch { /* sem conversa */ }
      }
      conta('2_madrugada_sem_retomada', 'leads da madrugada (19h–7h) sem retomada até as 9h',
        esquecidos.length, { limiar: 0, entraramNaNoite: noturnos.length, cartoes: esquecidos.slice(0, 10), base: '45% do volume entra entre 19h e 7h' });
    }

    // 5 e 6 — estoque do mês (2 a 10 chamadas; não lê conversa nenhuma).
    try {
      const inicioMes = instanteLocal(`${hoje.slice(0, 7)}-01`, '00:00');
      const brutos = await kommo.listLeadsCriadosEntre(Math.floor(+inicioMes / 1000), Math.floor(AGORA.getTime() / 1000));
      const mes = brutos.length && !brutos[0]?.custom_fields_values ? await cartoesPorId(brutos.map((l) => l.id)) : brutos;
      let idIntegracao = null;
      try {
        const usuarios = await kommo.listUsers();
        idIntegracao = usuarios.find((u) => (u.name ?? '').toLowerCase() === NOME_INTEGRACAO)?.id ?? null;
      } catch { /* sem lista de usuários */ }
      const doRotulo = mes.filter((l) => unidadeDo(l) === ROTULO);
      const semUnidade = mes.filter((l) => !unidadeDo(l));
      const deIntegracao = idIntegracao ? doRotulo.filter((l) => l.responsible_user_id === idIntegracao) : [];
      conta('5_responsavel_integracao', `cartões do mês com responsável "${env.VIGIA_USUARIO_INTEGRACAO || 'Doutor Digital'}"`,
        idIntegracao ? deIntegracao.length : null, idIntegracao
          ? { limiar: 0, de: doRotulo.length, base: '389 de 390 em 26/10' }
          : { naoMedido: 'usuário de integração não encontrado na conta' });
      conta('6_sem_campo_unidade', 'cartões do mês sem "⌂ Unidade de atendimento" (conta inteira)',
        semUnidade.length, { limiar: 0, de: mes.length, cartoes: semUnidade.slice(0, 10).map((l) => l.id), base: '8 no mês (26/10)' });
    } catch (err) {
      naoMedido('5_responsavel_integracao', 'cartões com responsável de integração', `falha: ${String(err).slice(0, 80)}`);
      naoMedido('6_sem_campo_unidade', 'cartões sem unidade de atendimento', `falha: ${String(err).slice(0, 80)}`);
    }

    // 8 — avaliações (categoria 1) marcadas nos próximos 7 dias, na franquia.
    try {
      const fim = dia(new Date(AGORA.getTime() + 7 * 86_400_000));
      const r = await searchSchedules(unit, { initialDate: hoje, endDate: fim, rowsPerPage: 100 });
      if (!r.ok) throw new Error(String(r.error).slice(0, 80));
      const avaliacoes = r.data.schedules.filter((s) => s.idCategory === 1 && s.isBusy);
      conta('8_avaliacoes_7dias', 'avaliações marcadas nos próximos 7 dias', avaliacoes.length, {
        limiar: 5, direcao: 'abaixo', base: '1 em 26/10 — alerta se ficar abaixo de 5',
      });
    } catch (err) {
      naoMedido('8_avaliacoes_7dias', 'avaliações marcadas nos próximos 7 dias', `franquia: ${String(err).slice(0, 80)}`);
    }
  }

  saida.cartoesNaJanela = meus.length;
  saida.conversasNaJanela = idsDeConversa.length;
  saida.semUnidadeNaJanela = { total: semUnidadeFalando.length, cartoes: semUnidadeFalando.slice(0, 10) };
  saida.janelaCompleta = completa;
  saida.ok = true;
} catch (err) {
  saida.erros.push(String(err?.stack ?? err).slice(0, 300));
} finally {
  try { await prisma.$disconnect(); } catch { /* nada */ }
}

// Marcadores para o host separar o JSON de qualquer linha de log que escape.
process.stdout.write(`\n#VIGIA-JSON#${JSON.stringify(saida)}#FIM#\n`);

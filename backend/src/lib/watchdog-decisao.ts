/**
 * As REGRAS do vigia externo (GitHub Actions, `.github/workflows/vigia-externo.yml`). Puras, sem import e só com sintaxe
 * que o Node apaga sozinho (sem enum): o mesmo arquivo roda no workflow (`node` direto, sem instalar nada) e na suíte.
 *
 * Por que existe (27/11/2026): a Sofia ficou 15 h fora por falta de crédito, o erro estava todo em `llm_calls` e o alerta
 * não chegou a ninguém. Todo alarme que vive DENTRO do servidor (e-mail pelo relay, Evolution) morre junto com ele. Este
 * olha de fora: consulta `GET /api/health/ia`, decide e avisa por canais que não dependem da VPS.
 *
 * O workflow é stateless: o que ele lembra entre uma rodada e outra (para o throttle e o «voltou ao normal») vai em
 * `Estado`, gravado no cache do Actions.
 */

export type EstadoDaSaude = 'ok' | 'degradado' | 'fora';
export type Causa = 'credito' | 'autenticacao' | 'limite' | 'indisponivel' | 'outra';

// ── O que o endpoint de saúde diz (lado do servidor) ────────────────────────────────────────────────────────────────

export interface LinhaDoProvedor {
  /** `rede` = tudo somado; senão o provedor (`openai`, `anthropic`…). */
  escopo: string;
  total: number;
  erros: number;
  /** Unidades distintas com erro: uma conversa quebrada sozinha não é queda. */
  unidadesComErro: number;
  /** Erros da unidade que mais errou: uma unidade em laço mais um erro isolado de outra não é queda. */
  maiorUnidade: number;
  errosCredito: number;
  errosChave: number;
  errosLimite: number;
  errosIndisponivel: number;
  /** Minutos desde a última chamada que deu certo (null = nenhuma na janela de consulta). */
  minutosSemSucesso: number | null;
}

export interface Regras {
  /** Fração de erro que faz da rede, ou de um provedor, «fora». */
  foraTaxa: number;
  /** Amostra mínima para julgar «fora»: pequena de propósito (de madrugada são ~20 chamadas por 10 min na rede toda). */
  foraMinimo: number;
  degradadoTaxa: number;
  degradadoMinimo: number;
  /** Um PROVEDOR isolado: fração e amostra mínima para «degradado» (e precisa de erro em 2 unidades, como o «fora»). */
  provedorDegradadoTaxa: number;
  provedorDegradadoMinimo: number;
}

export const REGRAS_PADRAO: Regras = { foraTaxa: 0.9, foraMinimo: 5, degradadoTaxa: 0.25, degradadoMinimo: 10, provedorDegradadoTaxa: 0.5, provedorDegradadoMinimo: 5 };

export interface Saude {
  estado: EstadoDaSaude;
  causa: Causa | null;
  /** Frase curta, SEM dado de paciente, de unidade ou mensagem de erro do provedor. */
  motivo: string;
  escopo: string | null;
}

function causaDe(l: LinhaDoProvedor): Causa {
  const ordem: Array<[Causa, number]> = [
    ['credito', l.errosCredito],
    ['autenticacao', l.errosChave],
    ['limite', l.errosLimite],
    ['indisponivel', l.errosIndisponivel],
    // o que nenhuma regra reconhece também é causa: 19 «outra» + 1 de crédito não são «saldo esgotado»
    ['outra', Math.max(0, l.erros - l.errosCredito - l.errosChave - l.errosLimite - l.errosIndisponivel)],
  ];
  let melhor: Causa = 'outra';
  let n = 0;
  for (const [c, q] of ordem) {
    if (q > n) {
      melhor = c;
      n = q;
    }
  }
  return melhor;
}

/** Erro espalhado: 2 unidades ou mais com erro e nenhuma respondendo por mais de 70% deles. */
const espalhado = (l: LinhaDoProvedor) => l.unidadesComErro >= 2 && (l.erros === 0 || l.maiorUnidade / l.erros <= 0.7);

const taxa = (l: LinhaDoProvedor) => (l.total > 0 ? l.erros / l.total : 0);
const pct = (x: number) => `${Math.round(x * 100)}%`;

/**
 * ok / degradado / fora. FORA = a REDE inteira falhando em 90% ou mais, mesmo com amostra pequena, com erro em 2 unidades ou mais, sem
 * exceção (nem crédito, nem chave): cada unidade pode ter a PRÓPRIA chave (`Unit.anthropicApiKey`), e a de uma acabando não é «a Sofia
 * fora do ar». Um PROVEDOR isolado a 100% é «degradado» (a chave de reserva ou o outro provedor pode estar atendendo), com o provedor
 * e a causa no texto. DEGRADADO = um quarto da rede falhando com amostra decente, ou metade de um provedor, também com erro em 2
 * unidades ou mais. Limite conhecido: um incidente em que só UMA unidade tem tráfego fica abaixo de «2 unidades» até uma segunda falar.
 * Silêncio (nenhuma chamada) NÃO é queda: madrugada sem paciente é normal.
 */
export function decidirSaude(linhas: LinhaDoProvedor[], regras: Regras = REGRAS_PADRAO): Saude {
  const rede = linhas.find((l) => l.escopo === 'rede');
  const provedores = linhas.filter((l) => l.escopo !== 'rede');
  // FORA é a REDE inteira: um provedor sozinho a 100% pode ter a chave de reserva ou o outro provedor atendendo (o primeiro erro é
  // gravado como `anthropic` e o sucesso que o salvou como outro provedor); a Sofia segue respondendo. Esse caso é «degradado».
  if (rede && rede.total >= regras.foraMinimo && taxa(rede) >= regras.foraTaxa && espalhado(rede)) {
    return { estado: 'fora', causa: causaDe(rede), escopo: 'rede', motivo: `${pct(taxa(rede))} das chamadas à IA falhando (${rede.erros} de ${rede.total})` };
  }
  const degradados: LinhaDoProvedor[] = [];
  if (rede && rede.total >= regras.degradadoMinimo && taxa(rede) >= regras.degradadoTaxa && espalhado(rede)) degradados.push(rede);
  for (const p of provedores) {
    // um provedor a 90% ou mais também cai aqui (taxa >= 50%): o aviso diz o provedor e a causa; «fora» fica para a rede inteira
    if (p.total >= regras.provedorDegradadoMinimo && taxa(p) >= regras.provedorDegradadoTaxa && espalhado(p)) degradados.push(p);
  }
  if (degradados.length) {
    const l = degradados.sort((a, b) => taxa(b) - taxa(a))[0];
    return {
      estado: 'degradado',
      causa: causaDe(l),
      escopo: l.escopo,
      motivo: `${pct(taxa(l))} das chamadas à IA falhando (${l.erros} de ${l.total})${l.escopo === 'rede' ? '' : ` no provedor ${l.escopo}`}`,
    };
  }
  return { estado: 'ok', causa: null, escopo: null, motivo: 'IA respondendo' };
}

// ── O que o vigia viu nesta rodada ──────────────────────────────────────────────────────────────────────────────────

export type TipoDeIncidente = 'ok' | 'fora' | 'degradado' | 'inacessivel' | 'cego';

export interface Observacao {
  tipo: TipoDeIncidente;
  causa: Causa | null;
  resumo: string;
}

export interface RespostaHttp {
  /** null = não respondeu (rede, DNS, timeout, TLS). */
  status: number | null;
  corpo: unknown;
}

const CAUSAS: ReadonlySet<string> = new Set(['credito', 'autenticacao', 'limite', 'indisponivel', 'outra']);

/**
 * Traduz a resposta HTTP em observação. Dois fracassos DIFERENTES de «a IA caiu»:
 *  - `inacessivel`: o servidor não respondeu, ou respondeu 5xx sem corpo de saúde (VPS, Traefik ou processo fora);
 *  - `cego`: 401/403/404 — o vigia não consegue LER a saúde (segredo errado, endpoint desligado). Vigia cego não pode
 *    parecer vigia tranquilo: avisa também.
 */
export function observar(r: RespostaHttp): Observacao {
  if (r.status === null) return { tipo: 'inacessivel', causa: null, resumo: 'o servidor não respondeu (sem resposta ou tempo esgotado)' };
  const c = r.corpo as { estado?: unknown; causa?: unknown; motivo?: unknown } | null;
  const doApp = c && typeof c === 'object' && ['not_found', 'unauthorized', 'url_invalida'].includes(String((c as { error?: unknown }).error));
  // 404 SEM o JSON do app (texto puro do Traefik, «page not found») é a rota que sumiu com o contêiner: servidor fora, não vigia cego
  if ((r.status === 401 || r.status === 403 || r.status === 404) && (doApp || r.status !== 404)) {
    return { tipo: 'cego', causa: null, resumo: `o endpoint de saúde respondeu ${r.status}: conferir os segredos HEALTH_URL e HEALTH_IA_TOKEN no GitHub e HEALTH_IA_TOKEN no servidor` };
  }
  const estado = c && typeof c === 'object' ? c.estado : undefined;
  if (estado === 'ok' || estado === 'degradado' || estado === 'fora') {
    const causa = typeof c?.causa === 'string' && CAUSAS.has(c.causa) ? (c.causa as Causa) : null;
    // o motivo vem do NOSSO servidor, mas é texto livre: corta e tira quebra de linha antes de ir para um modelo de WhatsApp.
    const motivo = typeof c?.motivo === 'string' ? umaLinha(c.motivo, 200) : '';
    return { tipo: estado, causa, resumo: motivo };
  }
  if (c && typeof c === 'object' && (c as { error?: unknown }).error === 'db_unavailable') {
    return { tipo: 'inacessivel', causa: null, resumo: 'o servidor está de pé, mas o banco de dados não respondeu' };
  }
  if (r.status === 404) return { tipo: 'inacessivel', causa: null, resumo: 'a rota respondeu 404 fora do aplicativo (o contêiner saiu do roteador?)' };
  if (r.status >= 500 || r.status === 429 || r.status === 408) {
    return { tipo: 'inacessivel', causa: null, resumo: `o servidor respondeu ${r.status} sem dados de saúde` };
  }
  return { tipo: 'cego', causa: null, resumo: `resposta inesperada do endpoint de saúde (${r.status})` };
}

// ── Memória entre rodadas, throttle e «voltou ao normal» ────────────────────────────────────────────────────────────

export interface Estado {
  /** Quando começou o incidente corrente (ms), sem contar trocas de tipo no meio (degradado → fora continua o mesmo). */
  desde: number | null;
  /** Último aviso por tipo de incidente (`tipo:causa`), em ms. Guardado mesmo depois de resolvido, para o throttle valer na oscilação. */
  ultimoAviso: Record<string, number>;
  /** Rodadas OK seguidas desde o último incidente. */
  okSeguidos: number;
  /** O que estava em aberto (para a mensagem de «voltou»). */
  ultimaObservacao: Observacao | null;
  /** Rodadas seguidas em que o vigia não conseguiu LER a saúde (servidor mudo ou cego), ainda sem aviso. */
  suspeitas: number;
  suspeitaDesde: number | null;
  /** A leitura que ABRIU o incidente (a que o «voltou ao normal» cita; a última pode já ser outra coisa, como degradado → fora). */
  abertura: Observacao | null;
}

export const ESTADO_VAZIO: Estado = { desde: null, ultimoAviso: {}, okSeguidos: 0, ultimaObservacao: null, suspeitas: 0, suspeitaDesde: null, abertura: null };

/**
 * `inacessivel` e `cego` só abrem incidente na 2ª rodada seguida: um deploy ou reinício de ~1 min (a retentativa de 8 s do
 * script não cobre) não pode acordar ninguém, e o «voltou ao normal» que viria depois seria a 2ª mensagem falsa. «fora» e
 * «degradado» já nascem de 10 min de dados do banco, então não precisam disso.
 */
export const SUSPEITAS_PARA_ABRIR = 2;

/** No máximo 1 aviso por tipo a cada 30 min; incidente aberto há mais de 2 h lembra só de 2 em 2 h. */
export const INTERVALO_MIN = 30;
export const INTERVALO_LONGO_MIN = 120;
export const LIMITE_LONGO_MIN = 120;
/** Rodadas OK seguidas para dar o incidente por encerrado (uma só poderia ser um respiro no meio da queda). */
export const OK_PARA_RESOLVER = 2;

export type TipoDeAviso = 'novo' | 'lembrete' | 'voltou' | 'teste';

export interface Aviso {
  tipo: TipoDeAviso;
  chave: string;
  texto: string;
}

/** O throttle é por TIPO de incidente: a causa dominante pode mudar de uma rodada para a outra (429 × crédito) e não pode virar alerta novo a cada troca. A causa vai no texto. */
export const chaveDe = (o: Observacao) => o.tipo;

/** Uma linha só, sem tabulação nem 4 espaços seguidos: o modelo de WhatsApp da Meta recusa variável com quebra de linha. */
export function umaLinha(t: string, max = 600): string {
  const s = String(t).replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

const TITULO: Record<TipoDeIncidente, string> = {
  ok: 'tudo certo',
  fora: 'a Sofia está FORA DO AR',
  degradado: 'a IA está DEGRADADA',
  inacessivel: 'o servidor do agente NÃO RESPONDE',
  cego: 'o vigia externo está CEGO (não consegue consultar a saúde)',
};

const ACAO: Record<Causa, string> = {
  credito: 'Causa provável: saldo de crédito esgotado. Recarregar no console do provedor (Anthropic ou OpenAI).',
  autenticacao: 'Causa provável: chave de API recusada (401/403). Conferir se a chave foi revogada ou trocada.',
  limite: 'Causa provável: limite de uso (429) estourado no provedor.',
  indisponivel: 'Causa provável: provedor fora do ar ou lento (5xx, timeout).',
  outra: 'Causa não identificada: ver llm_calls.error_message no banco.',
};

export function minutosEntre(deMs: number, ateMs: number): number {
  return Math.max(0, Math.round((ateMs - deMs) / 60_000));
}

function textoDoAlerta(o: Observacao, minutos: number, lembrete: boolean): string {
  const quando = minutos >= 1 ? ` Aberto há ${minutos} min.` : '';
  const acao = o.causa ? ` ${ACAO[o.causa]}` : '';
  const detalhe = o.resumo ? ` ${o.resumo}.` : '';
  return umaLinha(`${lembrete ? 'LEMBRETE' : 'ALERTA'} Doutor Digital: ${TITULO[o.tipo]}.${detalhe}${acao}${quando}`);
}

/**
 * Uma rodada: recebe o estado anterior, o que o vigia viu e a hora; devolve os avisos a mandar e o estado novo.
 * Nunca manda mais de 1 aviso por tipo a cada 30 min (2 h depois de 2 h de incidente), e manda «voltou ao normal»
 * quando o incidente encerra (2 rodadas OK seguidas).
 */
export function avancar(anterior: Estado | null, obs: Observacao, agoraMs: number): { avisos: Aviso[]; estado: Estado } {
  const e: Estado = { ...ESTADO_VAZIO, ...(anterior ?? {}), ultimoAviso: { ...(anterior?.ultimoAviso ?? {}) } };
  // poda: aviso de mais de 24 h não segura throttle nenhum
  for (const [k, t] of Object.entries(e.ultimoAviso)) if (agoraMs - t > 24 * 3_600_000) delete e.ultimoAviso[k];

  const jaAberto = e.desde !== null;
  const cegueira = obs.tipo === 'inacessivel' || obs.tipo === 'cego';
  if (!cegueira) {
    e.suspeitas = 0;
    e.suspeitaDesde = null;
  }

  if (obs.tipo === 'ok') {
    if (e.desde === null) return { avisos: [], estado: { ...e, okSeguidos: 0, ultimaObservacao: null } };
    const okSeguidos = e.okSeguidos + 1;
    if (okSeguidos < OK_PARA_RESOLVER) return { avisos: [], estado: { ...e, okSeguidos } };
    // incidente que nunca foi anunciado (nenhum canal entregou): «voltou» sairia do nada; encerra em silêncio
    if (Object.keys(e.ultimoAviso).length === 0) return { avisos: [], estado: { ...ESTADO_VAZIO } };
    const minutos = minutosEntre(e.desde, agoraMs);
    const abriu = e.abertura ?? e.ultimaObservacao;
    const antes = abriu ? `${TITULO[abriu.tipo]}${abriu.resumo ? ` (${abriu.resumo})` : ''}` : 'o problema';
    return {
      avisos: [{ tipo: 'voltou', chave: 'voltou', texto: umaLinha(`VOLTOU AO NORMAL, Doutor Digital: ${antes} por cerca de ${minutos} min e a IA está respondendo de novo.`) }],
      // Incidente encerrado: o throttle zera. Queda nova depois do «voltou» é OUTRO incidente e avisa como queda (o debounce de 2 rodadas
      // ok para encerrar e de 2 rodadas ruins para abrir já impede o vai-e-vem de virar spam).
      estado: { ...ESTADO_VAZIO },
    };
  }

  if (cegueira) {
    const suspeitas = e.suspeitas + 1;
    const suspeitaDesde = e.suspeitaDesde ?? agoraMs;
    // também com incidente aberto: um solavanco de rede no meio de uma queda não pode virar um 2º alerta («NÃO RESPONDE»)
    if (suspeitas < SUSPEITAS_PARA_ABRIR) {
      return { avisos: [], estado: { ...e, suspeitas, suspeitaDesde, okSeguidos: 0 } };
    }
    e.suspeitas = suspeitas;
    e.suspeitaDesde = suspeitaDesde;
  }

  const desde = e.desde ?? e.suspeitaDesde ?? agoraMs;
  const chave = chaveDe(obs);
  const minutos = minutosEntre(desde, agoraMs);
  const intervaloMs = (minutos >= LIMITE_LONGO_MIN ? INTERVALO_LONGO_MIN : INTERVALO_MIN) * 60_000;
  const ultimo = e.ultimoAviso[chave];
  // folga de 2 min: o cron do GitHub tem jitter de minutos e uma rodada que chega 29m50s depois não pode adiar o lembrete em 10 min
  const devido = ultimo === undefined || agoraMs - ultimo >= intervaloMs - 2 * 60_000;
  const estado: Estado = {
    desde,
    ultimoAviso: devido ? { ...e.ultimoAviso, [chave]: agoraMs } : e.ultimoAviso,
    okSeguidos: 0,
    ultimaObservacao: obs,
    suspeitas: e.suspeitas,
    suspeitaDesde: e.suspeitaDesde,
    abertura: jaAberto ? (e.abertura ?? obs) : obs,
  };
  if (!devido) return { avisos: [], estado };
  // LEMBRETE é repetição do MESMO incidente que segue aberto; queda nova (nada aberto antes) é «ALERTA», com o tipo 'novo'
  const lembrete = jaAberto && ultimo !== undefined;
  return { avisos: [{ tipo: lembrete ? 'lembrete' : 'novo', chave, texto: textoDoAlerta(obs, minutos, lembrete) }], estado };
}

export function avisoDeTeste(motivo: string): Aviso {
  return { tipo: 'teste', chave: 'teste', texto: umaLinha(`TESTE do vigia externo Doutor Digital (${motivo}). Se você está lendo isto, o alerta de fora do servidor chega.`) };
}

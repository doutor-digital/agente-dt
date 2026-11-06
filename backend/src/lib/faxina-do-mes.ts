/**
 * «Faxina do mês» (pedido do João, 06/11/2026): no dia 1, de madrugada, unidade por unidade, arruma o que o dia a dia deixa
 * para trás e conta o que fez no Telegram dele. Regras de cada passo aqui; quem agenda, pega a trava e fala com o Telegram é
 * `faxina-do-mes-worker.ts`.
 *
 * O QUE A FAXINA FAZ, E O QUE NÃO FAZ
 *  1. Duplicados: chat da fila de entrada com o telefone de UM cartão aberto → «vincular», pela regra do #233 (`entrada-automatica.ts`,
 *     modo estoque; `faxina-duplicados.ts`). Se a `entrada-estoque` já está ligada na conta, só relata o resumo dela.
 *  2. Tarefas vencidas há mais de 30 dias, criadas por robô (created_by 0 e uma marca de alerta no texto) → concluir.
 *     Tarefa de pessoa nunca: `created_by` ausente ou diferente de 0 é tratado como pessoa.
 *  3. Etapa errada: NÃO move nada por regra própria e NÃO dispara passada extra. LÊ o resumo da última varredura de cada automação
 *     que já existe (parados + estoques parados, sincronizador/revisão dos agendados velhos), no estado que a tela lhe deu:
 *     ligada = o que ela moveu, em «só no papel» = o que «moveria», desligada = só diz que está desligada.
 *  4. Motivo de perda: chama o `motivo-perdido-ia` (só onde está ligado — e só na faxina ligada — ou em «só no papel»). Campos
 *     que a franquia sabe: o relatório conta o que o sincronizador gravou na última varredura; não há caminho barato em lote.
 *  5. Etiquetas ▶ presas (no cartão há mais de 7 dias sem o cartão ter sido tocado) → remover, para o gatilho poder disparar
 *     de novo. Etiqueta ▶ sem nenhum cartão só é relatada.
 *
 * ALERTA CLÍNICO NUNCA É FECHADO: tarefa vencida cujo texto é aviso de sinal de alerta / URGENTE / LIGAR AGORA fica aberta e vai
 * para «precisam da equipe», com o link do cartão (risco a paciente: ninguém ligou, e a faxina não pode esconder isso).
 *
 * SECO NÃO GRAVA NADA NO KOMMO: nenhum vínculo, nenhuma tarefa concluída, nenhuma etiqueta tirada. Os passos 3 e 4 só LEEM resumos,
 * exceto o `motivo-perdido-ia` (que na faxina seca só roda se ele próprio estiver em «só no papel»).
 *
 * DOIS ESCRITORES DO MESMO CAMPO: a etiqueta ▶ também é posta por `etiquetas-auto`. Não há regravação eterna porque as
 * janelas dela (48 h, 24 h, 2 dias) são menores que os 7 dias daqui, e ela grava uma marca por decisão antes de pôr a
 * etiqueta: o que a faxina tira, ela não repõe.
 */
import type { KommoLead, KommoTarefa } from '../services/kommo.service.js';
import { ehTarefaDeSinal } from '../agent/sinal-de-alerta.js';
import type { ResultadoDosDuplicados } from './faxina-duplicados.js';
import type { Estado } from './automacoes-estado.js';
import { partesNoFuso, FUSO_PADRAO } from './fuso.js';

export const ID_FAXINA = 'faxina-do-mes';

export const DIAS_TAREFA_VELHA = 30;
export const DIAS_ETIQUETA_PRESA = 7;
/** Tetos por unidade e por faxina: o que passar entra na faxina do mês seguinte (ou numa rodada sob demanda). */
export const MAX_TAREFAS_FECHADAS = 300;
export const MAX_ETIQUETAS_TIRADAS = 100;
/** 12 páginas = 3.000 tarefas vencidas lidas. O Kommo não filtra por quem criou, então as de pessoa também entram na leitura. */
const MAX_PAGINAS_TAREFAS = 12;
const MAX_PAGINAS_POR_ETIQUETA = 4;
/** `listLeadTags` lê até 4 páginas de 250 (o padrão dele); se vier cheio, avisa. */
export const MAX_PAGINAS_DE_ETIQUETAS = 4;
/** Falhas SEGUIDAS do Kommo que encerram um passo (e 429/403 encerram a unidade): bater de novo só alonga o freio. */
const FALHAS_QUE_PARAM = 3;
/** Quantos links por unidade o Telegram mostra em «precisam da equipe». */
const LINKS_POR_UNIDADE = 5;

/** O texto da tarefa de robô: alerta do roteador, guia de etapa, alerta clínico da Sofia, conferência de horário. */
export const MARCAS_DE_ROBO: readonly string[] = ['ALERTA ·', '[GUIA]', '[Contato:', 'CONFERIR HORÁRIO'];

// ─── passo 2: tarefas ─────────────────────────────────────────────────────────────────────────────

/** Só robô: `created_by` é EXATAMENTE 0 (usuário real tem id; ausente = não sabemos = pessoa). */
export function criadaPorRobo(t: Pick<KommoTarefa, 'created_by'>): boolean {
  return t.created_by === 0;
}

export function temMarcaDeRobo(t: Pick<KommoTarefa, 'text'>): boolean {
  const texto = String(t.text ?? '');
  return MARCAS_DE_ROBO.some((m) => texto.includes(m));
}

/** Aberta, vencida há mais de 30 dias, de robô e com marca de robô. */
export function tarefaVelhaDeRobo(t: KommoTarefa, agoraEpoch: number): boolean {
  if (t.is_completed) return false;
  if (!t.complete_till || t.complete_till > agoraEpoch - DIAS_TAREFA_VELHA * 86_400) return false;
  return criadaPorRobo(t) && temMarcaDeRobo(t) && !ehAlertaClinico(t);
}

/** Aviso de risco ao paciente: sinal de alerta clínico, URGENTE, LIGAR AGORA. O `ehTarefaDeSinal` é o do agente; o resto cobre o formato antigo. */
export function ehAlertaClinico(t: Pick<KommoTarefa, 'text'>): boolean {
  const texto = String(t.text ?? '');
  return ehTarefaDeSinal(texto) || /\bURGENTE\b|LIGAR AGORA/i.test(texto);
}

export const RESULTADO_DA_TAREFA = `Concluída pela faxina do mês: vencida há mais de ${DIAS_TAREFA_VELHA} dias e criada por robô.`;

// ─── passo 5: etiquetas ▶ ─────────────────────────────────────────────────────────────────────────

export const ehEtiquetaSeta = (nome: string): boolean => nome.trim().startsWith('▶');

/**
 * Presa = tem a ▶ e o cartão não é tocado há 7 dias. A busca do Kommo acha etiqueta por texto; a de UM caractere só («▶») não
 * é pesquisável, então fica de fora (e é dito no relatório) em vez de adivinhada.
 */
export function etiquetaPesquisavel(nome: string): boolean {
  return ehEtiquetaSeta(nome) && nome.trim().length >= 2;
}

export function etiquetaPresa(lead: Pick<KommoLead, 'updated_at'>, agoraEpoch: number): boolean {
  return typeof lead.updated_at === 'number' && lead.updated_at < agoraEpoch - DIAS_ETIQUETA_PRESA * 86_400;
}

// ─── o resultado ──────────────────────────────────────────────────────────────────────────────────

export interface EtapaDaAutomacao {
  id: string;
  nome: string;
  estado: Estado;
  /** a passada foi pedida (ou, na faxina seca, não pedida de propósito) */
  executou: boolean;
  /** movidos DE VERDADE nesta passada */
  movidos: number;
  /** o que decidiu mover sem gravar (só no papel) */
  moveria: number;
  nota?: string;
}

export interface ResultadoEtapas {
  automacoes: EtapaDaAutomacao[];
  /** campos que o sincronizador gravou (ligado) nesta passada */
  camposGravados: number;
  /** pacientes sem cartão achado — o que ele não consegue arrumar sozinho */
  semCartao: number;
}

export interface ResultadoMotivos {
  estado: Estado;
  executou: boolean;
  gravados: number;
  gravaria: number;
  nota?: string;
}

export interface ResultadoUnidade {
  slug: string;
  nome: string;
  subdominio: string;
  /** o modo DA FAXINA nesta unidade */
  modo: 'ligado' | 'seco';
  duplicados: {
    juntados: number;
    semCartao: number;
    falhas: number;
    sobraram: number;
      equipe: Array<{ cartaoId: number; motivo: string }>;
    pulado?: string;
  };
  tarefas: { fechadas: number; sobraram: number; deRoboSemMarca: number; listaCortada: boolean; falhas: number; alertasClinicos: Array<{ cartaoId: number | null; tarefaId: number }> };
  etapas: ResultadoEtapas | null;
  motivos: ResultadoMotivos | null;
  etiquetas: { removidas: number; sobraram: number; semUso: string[]; naoPesquisadas: string[]; falhas: number };
  avisos: string[];
  erros: string[];
  /** parou antes de terminar (freio do Kommo ou exceção): a unidade pode ser retomada na mesma janela */
  interrompida: boolean;
  /** a interrupção foi perda de liderança (deploy), não o Kommo: não gasta uma das rodadas da noite */
  perdeuLideranca: boolean;
}

export const resultadoVazio = (slug: string, nome: string, subdominio: string, modo: 'ligado' | 'seco'): ResultadoUnidade => ({
  slug,
  nome,
  subdominio,
  modo,
  duplicados: { juntados: 0, semCartao: 0, falhas: 0, sobraram: 0, equipe: [] },
  tarefas: { fechadas: 0, sobraram: 0, deRoboSemMarca: 0, listaCortada: false, falhas: 0, alertasClinicos: [] },
  etapas: null,
  motivos: null,
  etiquetas: { removidas: 0, sobraram: 0, semUso: [], naoPesquisadas: [], falhas: 0 },
  avisos: [],
  erros: [],
  interrompida: false,
  perdeuLideranca: false,
});

// ─── a unidade ────────────────────────────────────────────────────────────────────────────────────

/** O pedaço do Kommo que a faxina usa (o `KommoClient` real serve; o teste põe um falso). */
export interface KommoDaFaxina {
  listarTarefas: (args: { concluidas?: boolean; completeTillAte?: number; maxPaginas?: number }) => Promise<{ tarefas: KommoTarefa[]; completa: boolean }>;
  fecharTarefa: (taskId: number, resultado: string) => Promise<void>;
  listLeadTags: (maxPaginas?: number) => Promise<Array<{ id: number; name: string }>>;
  listLeadsComEtiqueta: (etiqueta: string, maxPaginas?: number) => Promise<KommoLead[]>;
  removeTag: (leadId: number, tag: string) => Promise<void>;
}

export interface CtxFaxina {
  slug: string;
  nome: string;
  subdominio: string;
  modo: 'ligado' | 'seco';
  /** esta unidade faz os passos da CONTA do Kommo (tarefas, etiquetas, duplicados). A irmã de um Kommo dividido não. */
  cuidaDaConta: boolean;
  /** Kommo dividido (Petrópolis × Caxias): o cartão não diz de qual unidade é, então nada de vincular chat */
  contaDividida: boolean;
  agoraEpoch: number;
}

export interface DepsDaFaxina {
  kommo: KommoDaFaxina;
  /** passo 1: regra do #233 (`rodarConta` em modo estoque) atrás de `faxina-duplicados.ts`. Só é chamado se não for conta dividida. */
  duplicados: (ctx: CtxFaxina) => Promise<ResultadoDosDuplicados>;
  /** passo 3 e campos do passo 4: pede a passada das automações de etapa/sincronizador */
  etapas: (ctx: CtxFaxina) => Promise<ResultadoEtapas>;
  /** passo 4: motivo do cartão perdido */
  motivos: (ctx: CtxFaxina) => Promise<ResultadoMotivos>;
  /** respiro entre escritas no Kommo */
  pausa: () => Promise<void>;
  /** este processo ainda lidera os workers? Conferido entre os passos e a cada escrita: perdeu = para */
  lider?: () => boolean;
}

/** 429 e 403 são o Kommo pedindo calma (ou a conta sem permissão): continuar só alonga o freio de TODAS as unidades. */
export const pediuFreio = (err: unknown): boolean => {
  const status = (err as { status?: number } | null)?.status;
  return status === 429 || status === 403;
};

export const linkDoCartao = (subdominio: string, id: number) => `https://${subdominio}.kommo.com/leads/detail/${id}`;

/** Uma faxina numa unidade. Cada passo é independente: um que falha vira `erros` e os outros seguem (salvo o freio do Kommo). */
export async function faxinaDaUnidade(ctx: CtxFaxina, deps: DepsDaFaxina): Promise<ResultadoUnidade> {
  const r = resultadoVazio(ctx.slug, ctx.nome, ctx.subdominio, ctx.modo);
  const gravar = ctx.modo === 'ligado';
  let freou = false;
  let semLider = false;
  const perdeuALideranca = () => {
    if (!semLider && deps.lider && !deps.lider()) semLider = true;
    return semLider;
  };
  const falhar = (passo: string, err: unknown) => {
    r.erros.push(`${passo}: ${String(err).slice(0, 160)}`);
    if (pediuFreio(err)) freou = true;
  };

  if (ctx.cuidaDaConta) {
    // 1) duplicados
    if (ctx.contaDividida) {
      r.duplicados.pulado = 'conta dividida entre duas unidades: o cartão não diz de qual é o chat, então não juntei nada';
    } else {
      try {
        const d = await deps.duplicados(ctx);
        const { avisos, erros, freio, incompleto, ...numeros } = d;
        Object.assign(r.duplicados, numeros);
        r.avisos.push(...avisos);
        r.erros.push(...erros);
        if (freio) freou = true;
        if (incompleto) r.interrompida = true;
      } catch (err) {
        falhar('duplicados', err);
      }
    }

    // 2) tarefas velhas de robô
    if (!freou && !perdeuALideranca()) {
      try {
        const { tarefas, completa } = await deps.kommo.listarTarefas({
          concluidas: false,
          completeTillAte: ctx.agoraEpoch - DIAS_TAREFA_VELHA * 86_400,
          maxPaginas: MAX_PAGINAS_TAREFAS,
        });
        r.tarefas.listaCortada = !completa;
        const velhas = tarefas.filter((t) => !t.is_completed && t.complete_till && t.complete_till <= ctx.agoraEpoch - DIAS_TAREFA_VELHA * 86_400);
        r.tarefas.deRoboSemMarca = velhas.filter((t) => criadaPorRobo(t) && !temMarcaDeRobo(t)).length;
        r.tarefas.alertasClinicos = velhas
          .filter(ehAlertaClinico)
          .map((t) => ({ cartaoId: t.entity_type === 'leads' && t.entity_id ? t.entity_id : null, tarefaId: t.id }));
        const alvo = velhas.filter((t) => tarefaVelhaDeRobo(t, ctx.agoraEpoch));
        const lote = alvo.slice(0, MAX_TAREFAS_FECHADAS);
        r.tarefas.sobraram = alvo.length - lote.length;
        let seguidas = 0;
        for (const [i, t] of lote.entries()) {
          if (!gravar) {
            r.tarefas.fechadas++;
            continue;
          }
          if (perdeuALideranca()) {
            r.tarefas.sobraram += lote.length - i;
            break;
          }
          if (seguidas >= FALHAS_QUE_PARAM) {
            r.tarefas.sobraram += lote.length - i;
            break;
          }
          try {
            await deps.kommo.fecharTarefa(t.id, RESULTADO_DA_TAREFA);
            r.tarefas.fechadas++;
            seguidas = 0;
          } catch (err) {
            seguidas++;
            r.tarefas.falhas++;
            if (pediuFreio(err)) {
              freou = true;
              r.tarefas.sobraram += lote.length - i;
              r.erros.push(`tarefas: ${String(err).slice(0, 160)}`);
              break;
            }
          }
          await deps.pausa();
        }
        if (r.tarefas.falhas && !freou) r.erros.push(`tarefas: ${r.tarefas.falhas} não consegui concluir`);
      } catch (err) {
        falhar('tarefas', err);
      }
    }
  }

  // 3 e 4) o que já existe. Também fala com o Kommo, então respeita o freio.
  if (!freou && !perdeuALideranca()) {
    try {
      r.etapas = await deps.etapas(ctx);
    } catch (err) {
      falhar('etapas', err);
    }
  }
  if (!freou && !perdeuALideranca()) {
    try {
      r.motivos = await deps.motivos(ctx);
    } catch (err) {
      falhar('motivo de perda', err);
    }
  }

  // 5) etiquetas ▶ presas
  if (ctx.cuidaDaConta && !freou && !perdeuALideranca()) {
    try {
      const todas = await deps.kommo.listLeadTags();
      if (todas.length >= MAX_PAGINAS_DE_ETIQUETAS * 250) r.avisos.push(`a conta tem mais de ${MAX_PAGINAS_DE_ETIQUETAS * 250} etiquetas: a lista foi cortada e alguma ▶ pode não ter sido vista`);
      const setas = todas.map((t) => t.name).filter(ehEtiquetaSeta);
      r.etiquetas.naoPesquisadas = setas.filter((n) => !etiquetaPesquisavel(n));
      let tiradas = 0;
      let seguidas = 0;
      for (const nome of setas.filter(etiquetaPesquisavel)) {
        if (freou || perdeuALideranca() || seguidas >= FALHAS_QUE_PARAM) break;
        let cartoes: KommoLead[];
        try {
          cartoes = await deps.kommo.listLeadsComEtiqueta(nome, MAX_PAGINAS_POR_ETIQUETA);
        } catch (err) {
          seguidas++;
          falhar(`etiqueta ${nome}`, err);
          continue;
        }
        seguidas = 0;
        if (cartoes.length === 0) {
          r.etiquetas.semUso.push(nome);
          continue;
        }
        for (const c of cartoes.filter((l) => etiquetaPresa(l, ctx.agoraEpoch))) {
          if (tiradas >= MAX_ETIQUETAS_TIRADAS) {
            r.etiquetas.sobraram++;
            continue;
          }
          if (!gravar) {
            tiradas++;
            r.etiquetas.removidas++;
            continue;
          }
          if (perdeuALideranca()) break;
          try {
            await deps.kommo.removeTag(c.id, nome);
            tiradas++;
            r.etiquetas.removidas++;
            seguidas = 0;
          } catch (err) {
            r.etiquetas.falhas++;
            seguidas++;
            if (pediuFreio(err)) {
              falhar(`etiqueta ${nome}`, err);
              break;
            }
            if (seguidas >= FALHAS_QUE_PARAM) {
              r.erros.push(`etiquetas: ${seguidas} falhas seguidas ao tirar ${nome} (${String(err).slice(0, 120)}): parei este passo`);
              break;
            }
          }
          await deps.pausa();
        }
      }
      if (r.etiquetas.falhas && !r.erros.some((e) => e.startsWith('etiquetas:'))) r.erros.push(`etiquetas: ${r.etiquetas.falhas} não consegui tirar`);
    } catch (err) {
      falhar('etiquetas', err);
    }
  }

  if (semLider) r.avisos.push('este processo perdeu a liderança dos workers no meio: parei os passos que faltavam (o novo líder retoma depois dos 90 min)');
  r.interrompida = r.interrompida || freou || semLider;
  r.perdeuLideranca = semLider;
  if (r.interrompida && !semLider) r.avisos.push('interrompida: será retomada depois de 90 min se ainda estiver na janela (até 7h); passou disso, rode sob demanda');
  if (freou) r.avisos.push('o Kommo pediu calma (429/403) ou recusou: parei os passos que faltavam nesta unidade');
  return r;
}

// ─── agenda ───────────────────────────────────────────────────────────────────────────────────────

/** A faxina começa depois das 2h e não começa unidade nova depois das 7h (São Paulo), só no dia 1. */
export const HORA_INICIAL = 2;
export const HORA_FINAL = 7;

export const MESES = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];

export interface JanelaDaFaxina {
  dentro: boolean;
  /** AAAA-MM do dia em que roda: a chave da trava «uma vez por mês» */
  chaveDoMes: string;
  /** o mês de que o relatório fala: no dia 1, o que acabou; fora dele, o corrente */
  mesDoRelatorio: string;
}

export function janelaDaFaxina(agora: Date): JanelaDaFaxina {
  const p = partesNoFuso(agora, FUSO_PADRAO);
  const chaveDoMes = `${String(p.ano).padStart(4, '0')}-${String(p.mes).padStart(2, '0')}`;
  const idx = p.dia === 1 ? (p.mes + 10) % 12 : p.mes - 1;
  return { dentro: p.dia === 1 && p.hora >= HORA_INICIAL && p.hora < HORA_FINAL, chaveDoMes, mesDoRelatorio: MESES[idx] };
}

// ─── o relatório ──────────────────────────────────────────────────────────────────────────────────

const plural = (n: number, um: string, varios: string) => `${n} ${n === 1 ? um : varios}`;
const precisaDaEquipe = (n: number) => plural(n, 'precisa da equipe', 'precisam da equipe');

export function precisamDaEquipe(r: ResultadoUnidade): number {
  return r.duplicados.equipe.length + r.tarefas.alertasClinicos.length;
}

/**
 * O que as automações de etapa fizeram na última varredura (movidas) e o que fariam em «só no papel» (moveria). Automação DESLIGADA não
 * conta em nenhum dos dois: o `moveria` dela é o histórico de 30 dias do papel (só o detalhe da unidade o cita, como informação).
 */
export function etapasDaUnidade(r: ResultadoUnidade): { movidas: number; moveria: number } {
  const a = (r.etapas?.automacoes ?? []).filter((x) => x.estado !== 'desligado');
  return { movidas: a.reduce((s, x) => s + x.movidos, 0), moveria: a.reduce((s, x) => s + x.moveria, 0) };
}

/** Unidade retomada: o que a faxina GRAVOU nas duas rodadas se soma (o resto é o retrato da última). */
export function acumular(anterior: ResultadoUnidade, atual: ResultadoUnidade): ResultadoUnidade {
  return {
    ...atual,
    duplicados: { ...atual.duplicados, juntados: anterior.duplicados.juntados + atual.duplicados.juntados },
    tarefas: { ...atual.tarefas, fechadas: anterior.tarefas.fechadas + atual.tarefas.fechadas },
    etiquetas: { ...atual.etiquetas, removidas: anterior.etiquetas.removidas + atual.etiquetas.removidas },
  };
}

/** Uma linha por unidade, em português simples: «Timbó, outubro: 12 duplicados juntados · 40 tarefas velhas fechadas · …». */
export function linhaDaUnidade(r: ResultadoUnidade, mes: string): string {
  const e = etapasDaUnidade(r);
  const equipe = precisamDaEquipe(r);
  if (r.modo === 'seco') {
    // SÓ NO PAPEL: o que a faxina FARIA. O que as automações já moveram de verdade (última varredura delas) vem à parte, nunca somado ao «moveria»
    const jaMovidas = e.movidas ? ` · ${plural(e.movidas, 'etapa já movida de verdade', 'etapas já movidas de verdade')} pelas próprias automações (última varredura, não é a faxina)` : '';
    return (
      `${r.nome}, ${mes} (só no papel, nada foi gravado): faria juntar ${plural(r.duplicados.juntados, 'duplicado', 'duplicados')} · ` +
      `faria fechar ${plural(r.tarefas.fechadas, 'tarefa velha', 'tarefas velhas')} · ` +
      `${plural(e.moveria, 'etapa que as automações em papel moveriam', 'etapas que as automações em papel moveriam')}${jaMovidas} · ` +
      `${plural(r.etiquetas.removidas, 'etiqueta ▶ presa que tiraria', 'etiquetas ▶ presas que tiraria')} · ${precisaDaEquipe(equipe)}`
    );
  }
  return (
    `${r.nome}, ${mes}: ${plural(r.duplicados.juntados, 'duplicado juntado', 'duplicados juntados')} · ` +
    `${plural(r.tarefas.fechadas, 'tarefa velha fechada', 'tarefas velhas fechadas')} · ` +
    `${plural(e.movidas, 'etapa corrigida', 'etapas corrigidas')} (última varredura)${e.moveria ? ` (+${e.moveria} no papel)` : ''} · ` +
    `${plural(r.etiquetas.removidas, 'etiqueta ▶ presa tirada', 'etiquetas ▶ presas tiradas')} · ${precisaDaEquipe(equipe)}`
  );
}

/** As linhas de baixo da unidade: o que a equipe precisa ver (com link) e o que ficou de fora. */
export function detalhesDaUnidade(r: ResultadoUnidade): string[] {
  const out: string[] = [];
  const links: string[] = [];
  for (const d of r.duplicados.equipe) links.push(`${linkDoCartao(r.subdominio, d.cartaoId)} (${d.motivo})`);
  for (const a of r.tarefas.alertasClinicos) links.push(`${a.cartaoId ? linkDoCartao(r.subdominio, a.cartaoId) : `tarefa ${a.tarefaId} (sem cartão)`} (ALERTA CLÍNICO vencido há mais de ${DIAS_TAREFA_VELHA} dias: não fechei, ligar)`);
  for (const l of links.slice(0, LINKS_POR_UNIDADE)) out.push(`  - equipe: ${l}`);
  if (links.length > LINKS_POR_UNIDADE) out.push(`  - equipe: e mais ${links.length - LINKS_POR_UNIDADE}`);

  if (r.duplicados.pulado) out.push(`  - duplicados: ${r.duplicados.pulado}`);
  if (r.duplicados.sobraram) out.push(`  - duplicados: ${r.duplicados.sobraram} chats adiados (outro chat do mesmo telefone foi tratado agora); entram na próxima rodada`);
  if (r.duplicados.falhas) out.push(`  - duplicados: ${r.duplicados.falhas} chats deram erro (contato apagado ou recusa do Kommo) e ficaram na caixa`);
  if (r.tarefas.sobraram) out.push(`  - tarefas: ${r.tarefas.sobraram} ficaram para a próxima rodada (teto)`);
  if (r.tarefas.listaCortada) out.push('  - tarefas: a lista de vencidas é maior do que a faxina lê de uma vez');
  if (r.tarefas.deRoboSemMarca) out.push(`  - tarefas: ${r.tarefas.deRoboSemMarca} vencidas de robô sem marca de alerta: não mexi`);
  if (r.etiquetas.semUso.length) out.push(`  - etiquetas sem nenhum cartão: ${r.etiquetas.semUso.join(', ')}`);
  if (r.etiquetas.sobraram) out.push(`  - etiquetas: ${r.etiquetas.sobraram} ficaram para a próxima rodada (teto)`);

  for (const a of r.etapas?.automacoes ?? []) {
    if (a.estado === 'desligado') out.push(`  - etapa: ${a.nome} está desligada nesta unidade: não mexi${a.moveria ? ` (a última leitura no papel dizia que moveria ${a.moveria})` : ''}`);
    else if (!a.executou) out.push(`  - etapa: ${a.nome} sem número desta vez${a.nota ? ` (${a.nota})` : ''}`);
    else if (a.movidos === 0 && a.estado === 'seco') out.push(`  - etapa: ${a.nome} (só no papel) moveria ${a.moveria}`);
    else out.push(`  - etapa: ${a.nome} moveu ${a.movidos}${a.moveria ? ` e, só no papel, moveria mais ${a.moveria}` : ''}${a.nota ? ` (${a.nota})` : ''}`);
  }
  if (r.etapas && r.etapas.camposGravados) out.push(`  - campos que a franquia sabe: ${r.etapas.camposGravados} gravados pelo sincronizador`);
  if (r.etapas && r.etapas.semCartao) out.push(`  - ${r.etapas.semCartao} pacientes da franquia sem cartão achado`);
  const m = r.motivos;
  if (m) {
    if (m.estado === 'desligado') out.push('  - motivo de perda: a IA do motivo está desligada nesta unidade');
    else if (!m.executou) out.push(`  - motivo de perda: não rodou${m.nota ? ` (${m.nota})` : ''}`);
    else out.push(`  - motivo de perda: ${m.estado === 'seco' ? `a IA gravaria ${m.gravaria}` : `a IA gravou ${m.gravados}`}`);
  }
  for (const a of r.avisos) out.push(`  - aviso: ${a}`);
  for (const e of r.erros) out.push(`  - ERRO ${e}`);
  return out;
}

const TETO_MENSAGEM = 3300;
const MAX_NOMES_NO_RODAPE = 15;

const nomesCurtos = (nomes: readonly string[]) => (nomes.length > MAX_NOMES_NO_RODAPE ? `${nomes.slice(0, MAX_NOMES_NO_RODAPE).join(', ')} e mais ${nomes.length - MAX_NOMES_NO_RODAPE}` : nomes.join(', '));

/**
 * O relatório em quantas mensagens precisar (o Telegram corta em ~4000; o envio corta em 3500), sem partir uma unidade no meio.
 * Em lotes: `semTotal` deixa o total para o último lote, que passa `totalDe` com TODAS as unidades da rodada.
 */
export function montarRelatorio(
  resultados: readonly ResultadoUnidade[],
  o: { mes: string; naoComecaram?: string[]; quando?: 'dia-1' | 'sob-demanda'; semTotal?: boolean; totalDe?: readonly ResultadoUnidade[] },
): string[] {
  const todas = o.totalDe ?? resultados;
  const seco = todas.some((r) => r.modo === 'seco');
  const soSeco = todas.length > 0 && todas.every((r) => r.modo === 'seco');
  const cab = `Faxina do mês, ${o.mes}${soSeco ? ' (SÓ NO PAPEL: nada foi gravado no Kommo, o que segue é o que ela FARIA)' : seco ? ' (algumas unidades só no papel)' : ''}${o.quando === 'sob-demanda' ? ' - rodada sob demanda' : ''}`;

  const blocos: string[] = resultados.map((r) => [linhaDaUnidade(r, o.mes), ...detalhesDaUnidade(r)].join('\n').slice(0, TETO_MENSAGEM - cab.length - 20));

  let rodape = '';
  if (!o.semTotal) {
    // uma unidade interrompida e retomada aparece duas vezes nos lotes: no total vale a ÚLTIMA rodada dela
    const ultimas = [...new Map(todas.map((r) => [r.slug, r])).values()];
    const gravadas = ultimas.filter((r) => r.modo === 'ligado');
    const emPapel = ultimas.filter((r) => r.modo === 'seco');
    const somar = (lista: readonly ResultadoUnidade[], f: (r: ResultadoUnidade) => number) => lista.reduce((s, r) => s + f(r), 0);
    const linhas = [`TOTAL DA REDE (${plural(ultimas.length, 'unidade', 'unidades')}: ${gravadas.length} ligadas, ${emPapel.length} só no papel)`];
    // GRAVADO e SÓ NO PAPEL nunca se misturam: rede mista não pode virar «a juntar» para o que já foi feito
    if (gravadas.length) {
      linhas.push(
        `GRAVADO pela faxina (${plural(gravadas.length, 'unidade ligada', 'unidades ligadas')}): ` +
          `${plural(somar(gravadas, (r) => r.duplicados.juntados), 'duplicado juntado', 'duplicados juntados')} · ` +
          `${plural(somar(gravadas, (r) => r.tarefas.fechadas), 'tarefa velha fechada', 'tarefas velhas fechadas')} · ` +
          `${plural(somar(gravadas, (r) => r.etiquetas.removidas), 'etiqueta ▶ tirada', 'etiquetas ▶ tiradas')}`,
      );
    }
    if (emPapel.length) {
      linhas.push(
        `SÓ NO PAPEL, nada gravado (${plural(emPapel.length, 'unidade', 'unidades')}): ` +
          `faria juntar ${plural(somar(emPapel, (r) => r.duplicados.juntados), 'duplicado', 'duplicados')} · ` +
          `faria fechar ${plural(somar(emPapel, (r) => r.tarefas.fechadas), 'tarefa velha', 'tarefas velhas')} · ` +
          `tiraria ${plural(somar(emPapel, (r) => r.etiquetas.removidas), 'etiqueta ▶', 'etiquetas ▶')}`,
      );
    }
    linhas.push(
      `ETAPAS (última varredura das automações, não é a faxina): ${plural(somar(ultimas, (r) => etapasDaUnidade(r).movidas), 'movida de verdade', 'movidas de verdade')} · ` +
        `${plural(somar(ultimas, (r) => etapasDaUnidade(r).moveria), 'moveria', 'moveriam')} (só no papel)`,
    );
    linhas.push(`PRECISAM DA EQUIPE (todas as unidades): ${somar(ultimas, precisamDaEquipe)}`);
    const total = linhas.join('\n');
    const falhas = ultimas.filter((r) => r.erros.length).map((r) => r.nome);
    rodape = [total, ...(falhas.length ? [`Com erro em: ${nomesCurtos(falhas)}`] : []), ...(o.naoComecaram?.length ? [`Não deu tempo (rodar sob demanda): ${nomesCurtos(o.naoComecaram)}`] : [])].join('\n');
  }

  const mensagens: string[] = [];
  let atual = cab;
  let temBloco = false;
  for (const b of blocos) {
    if (temBloco && atual.length + b.length + 2 > TETO_MENSAGEM) {
      mensagens.push(atual);
      atual = `${cab} (continua)`;
      temBloco = false;
    }
    atual += `\n\n${b}`;
    temBloco = true;
  }
  if (rodape) {
    if (temBloco && atual.length + rodape.length + 2 > TETO_MENSAGEM) {
      mensagens.push(atual);
      atual = `${cab} (fim)`;
    }
    atual += `\n\n${rodape}`;
  }
  mensagens.push(atual);
  return mensagens;
}

/**
 * Rotas públicas da extensão "Ponte" (WhatsApp Web). Fase 1 (só leitura) e fase 2 (13/10/2026): pausar a Sofia
 * neste paciente, o resumo do lead (com o botão "Resumir com IA") e — em `ponte-fila.controller.ts` — a fila do dia.
 *
 * `POST /api/public/widget/:slug/ponte/cartao` → o cartão do Kommo do paciente da conversa aberta no
 * WhatsApp Web, para o painel lateral. Mesma chave por unidade dos widgets do cartão (`X-Widget-Key`, ver
 * `widget-franquia.controller.ts` → `unidadeDaPonte`), com limite próprio.
 *
 * É POST só para nome e telefone do paciente irem no CORPO: na URL de um GET eles ficariam no log de acesso
 * do proxy e no log de debug (`req.url`) a cada troca de conversa. Não escreve nada.
 *
 * Corpo JSON (tudo opcional, a extensão manda o que tiver):
 *   - `telefone`   — só dígitos, e só quando o WhatsApp mostrou o número de verdade (JID `@c.us`);
 *   - `impressoes` — até 8 hashes SHA-256 (lista) das últimas mensagens RECEBIDAS
 *                    (ver `lib/ponte-impressao.ts`). O texto da conversa NUNCA chega aqui;
 *   - `nome`       — o nome do cabeçalho da conversa;
 *   - `manual`     — `true`: a atendente digitou o nome na busca manual;
 *   - `lead`       — a atendente escolheu um cartão da lista de candidatos.
 *
 * Casamento em 4 passos (telefone → impressão → nome → nada), em `lib/ponte-cartao.ts`.
 * A rota do cartão não escreve nada; nome, telefone e impressões não vão para o log.
 *
 * Fase 2:
 *   - `POST/DELETE /api/public/widget/:slug/ponte/pausa` `{ leadId, ate, motivo, por }` → a MESMA pausa do widget
 *     "Pausar a Sofia" (`lib/pausa-lead.ts`): linha em `lead_pausas` + caixinha "Pausar IA"; o worker solta no fim.
 *     É a única escrita da Ponte, e vai no Kommo pela chave da unidade — nunca no WhatsApp;
 *   - `POST /api/public/widget/:slug/ponte/resumo-ia` `{ leadId }` → o resumo do lead escrito pela IA, só quando a
 *     atendente clica. Modelo barato, chave da unidade, cache de 6 h por lead (`lib/ponte-resumo.ts`).
 *
 * Fase 3 (14/10/2026): a resposta do cartão ganha `duplicados` (os outros cartões ABERTOS do mesmo paciente — do
 * mesmo contato ou de outro contato com o mesmo telefone completo; ver `lib/ponte-duplicados.ts`), `primeiroNome`
 * (para as respostas prontas) e `origem` (⚑ Origem). As ações novas (etiquetas, ligação, respostas) estão em
 * `ponte-acoes.controller.ts`.
 */
import type { Request, Response } from 'express';
import type { Unit } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import { unidadeDaPonte } from './widget-franquia.controller.js';
import { KommoApiError, createKommoClient, type KommoClient, type KommoLead, type KommoPipeline } from '../services/kommo.service.js';
import { chaveTelefone } from '../lib/franquia-sync.js';
import { limparNome, termosDeBusca } from '../lib/widget-agenda.js';
import { JANELA_DA_IMPRESSAO_MS, casarPorImpressoes, impressoesValidas } from '../lib/ponte-impressao.js';
import {
  GANHO,
  PERDIDO,
  barraDoFunil,
  caixinhaDaSdr,
  caixinhaMarcada,
  casarCartao,
  estadoDaSofia,
  funilComercial,
  nomeCasa,
  ordenarCartoes,
  telefoneConfere,
  telefoneDaPonte,
  type Casamento,
  type ContatoAchado,
} from '../lib/ponte-cartao.js';
import { estadoDaPausaDoLead, pausarLead, retomarLead, type EstadoDaPausaDoLead } from '../lib/pausa-lead.js';
import { checkBusinessHours } from '../agent/prompt-composer.js';
import { lerAnuncioDoLead } from '../agent/anuncio-de-origem.js';
import { resumoDoPacienteNaFranquia, type ResumoDoPaciente } from '../lib/paciente-na-franquia.js';
import { POR_PADRAO, leadIdDoPedido, lerPedidoDePausa, lerPedidoDeRetomada } from '../lib/ponte-pausa.js';
import {
  CACHE_RESUMO_IA_MS,
  MAX_TOKENS_RESUMO_IA,
  MODELO_RESUMO_IA,
  camposDoQuemE,
  interpretarResumoDaIa,
  montarPromptDoResumoIa,
  montarResumo,
  type MemoriaDoLead,
  type ResumoDoLead,
} from '../lib/ponte-resumo.js';
import { getLeadMemoryForAgent } from '../services/lead-memory.service.js';
import { MAX_CARTOES_DUPLICADOS, cartoesDuplicados, mesmoTelefoneCompleto, origemDoCartao, telefoneCompleto, type CartaoDuplicado } from '../lib/ponte-duplicados.js';
import { primeiroNomeDoPaciente } from '../lib/ponte-respostas.js';
import { ehEtiquetaDeRobo, etiquetasDeRoboDaUnidade } from '../lib/ponte-etiquetas.js';
import { mensagensOficiais } from '../services/kommo-talks.service.js';
import { recordLlmCall } from '../services/openai.service.js';
import { camposDaConta, type DefinicaoDeCampo } from '../lib/ponte-ligacao.js';
import { contaDaUnidade } from '../lib/ponte-cache.js';
import { grupoDaUnidade, valorDaUnidadeNoCartao, type GrupoDoCrm } from '../lib/crm-compartilhado.js';
import {
  barraDoTratamento,
  desdeEmIso,
  franquiaAndaSozinha,
  nomeCurtoDaUnidade,
  qualificacaoDoCartao,
  slugDaUnidadeDoCartao,
  sofiaNaUnidade,
  telefoneDoPainel,
  unidadeDoPainel,
} from '../lib/ponte-painel.js';

// ── funis e usuários da conta: mudam pouco, e a Ponte chama a cada troca de conversa ──
const CONTA_TTL_MS = 10 * 60_000;
export interface DadosDaConta {
  em: number;
  funis: KommoPipeline[];
  usuarios: Map<number, string>;
}
const cacheConta = new Map<string, DadosDaConta>();

/** Funis e usuários da conta, com cache de 10 min por unidade. A fila da Ponte usa o mesmo cache. */
export async function dadosDaConta(unit: Unit, kommo: KommoClient): Promise<DadosDaConta> {
  const c = cacheConta.get(unit.id);
  if (c && Date.now() - c.em < CONTA_TTL_MS) return c;
  const [funis, usuarios] = await Promise.all([kommo.listPipelines().catch(() => null), kommo.listUsers().catch(() => null)]);
  const novo: DadosDaConta = {
    em: Date.now(),
    funis: funis ?? c?.funis ?? [],
    usuarios: usuarios ? new Map(usuarios.map((u) => [u.id, u.name])) : (c?.usuarios ?? new Map()),
  };
  // só guarda por 10 min o que veio inteiro: um 429 do Kommo não pode deixar a barrinha vazia até lá
  if (funis && usuarios) cacheConta.set(unit.id, novo);
  return novo;
}

function nomesDaEtapa(conta: DadosDaConta, l: Pick<KommoLead, 'pipeline_id' | 'status_id'>): { funil: string | null; etapa: string | null } {
  const funil = conta.funis.find((p) => p.id === l.pipeline_id) ?? null;
  return { funil: funil?.name ?? null, etapa: funil?.statuses.find((s) => s.id === l.status_id)?.name ?? null };
}

function resumoCurto(conta: DadosDaConta, l: KommoLead) {
  return { id: l.id, nome: l.name, ...nomesDaEtapa(conta, l), fechado: l.status_id === GANHO || l.status_id === PERDIDO };
}

// ── os três passos com acesso ao mundo ──

type BuscaPorTelefone = (telefone: string) => ReturnType<KommoClient['buscarContatos']>;

/**
 * A busca de contatos por telefone, UMA vez por número na mesma requisição: o passo 1 do casamento e o aviso de
 * cartão duplicado procuram quase sempre o mesmo número (o da conversa é o do contato).
 */
function buscaPorTelefoneDaRequisicao(kommo: KommoClient): BuscaPorTelefone {
  const feitas = new Map<string, ReturnType<KommoClient['buscarContatos']>>();
  return (telefone) => {
    const chave = chaveTelefone(telefone);
    let p = feitas.get(chave);
    if (!p) {
      p = kommo.buscarContatos(chave, 25);
      feitas.set(chave, p);
    }
    return p;
  };
}

/** Passo 1: contatos cujo telefone CONFERE (a busca do Kommo só sugere — casa pelos últimos dígitos). */
async function contatosPorTelefone(buscar: BuscaPorTelefone, telefone: string): Promise<ContatoAchado[]> {
  const contatos = await buscar(telefone);
  if (contatos === null) throw new Error('busca de contatos por telefone falhou');
  return contatos.filter((c) => c.telefones.some((t) => telefoneConfere(telefone, t))).map((c) => ({ nome: c.nome, leadIds: c.leadIds }));
}

/**
 * Passo 2: as mensagens do paciente das últimas 48 h que a Sofia guardou nesta unidade. O hash é calculado
 * aqui, na hora, e jogado fora com a requisição. Unidade sem a Sofia não tem mensagem guardada — o passo
 * simplesmente não acha.
 */
async function cartaoPorImpressao(unit: Unit, impressoes: string[]): Promise<number | null> {
  const msgs = await prisma.message.findMany({
    where: { role: 'user', createdAt: { gte: new Date(Date.now() - JANELA_DA_IMPRESSAO_MS) }, conversation: { unitId: unit.id } },
    select: { content: true, createdAt: true, conversation: { select: { leadId: true } } },
    orderBy: { createdAt: 'desc' },
    take: 5_000,
  });
  const r = casarPorImpressoes(
    impressoes,
    msgs.map((m) => ({ leadId: m.conversation.leadId, texto: m.content, em: m.createdAt })),
  );
  if (!r || 'ambiguo' in r) return null;
  const id = Number(r.leadId);
  return Number.isInteger(id) && id > 0 ? id : null;
}

/**
 * Passo 3: contatos cujo nome tem todas as palavras do cabeçalho. Do termo mais específico ao mais largo
 * (a busca do Kommo é por pedaço de texto: "Maria Silva" não acha "Maria da Silva"), parando no primeiro
 * termo que devolver alguém que case.
 */
async function contatosPorNome(kommo: KommoClient, nome: string): Promise<number[][]> {
  let falhou = false;
  for (const termo of termosDeBusca(nome, '').slice(0, 3)) {
    const contatos = await kommo.buscarContatos(termo, 50);
    if (contatos === null) {
      falhou = true;
      continue;
    }
    const casam = contatos.filter((c) => c.leadIds.length && nomeCasa(nome, c.nome));
    if (casam.length) return casam.map((c) => c.leadIds);
  }
  if (falhou) throw new Error('busca de contatos por nome falhou');
  return [];
}

// ── o que o cartão e o resumo dividem ──

function contatoPrincipalDe(lead: KommoLead): number | null {
  return lead._embedded?.contacts?.find((c) => c.is_main)?.id ?? lead._embedded?.contacts?.[0]?.id ?? null;
}

/** Nome e telefone do contato principal — só quando a franquia está ligada (é para casar o paciente lá). */
async function contatoParaFranquia(unit: Unit, kommo: KommoClient, lead: KommoLead): Promise<{ nome: string | null; telefone: string | null } | null> {
  if (!unit.spineEnabled || !unit.spineToken) return null;
  const contatoId = contatoPrincipalDe(lead);
  return contatoId ? kommo.getContactBasico(contatoId) : { nome: null, telefone: null };
}

async function franquiaDoCartao(
  unit: Unit,
  lead: KommoLead,
  contato: { nome: string | null; telefone: string | null } | null,
  telefone: string | null,
): Promise<ResumoDoPaciente | null> {
  if (!unit.spineEnabled || !unit.spineToken) return null;
  return resumoDoPacienteNaFranquia(unit, {
    leadId: lead.id,
    nome: (contato?.nome ?? '').slice(0, 120),
    titulo: (lead.name ?? '').slice(0, 120),
    telefone: contato?.telefone ?? telefone ?? '',
  }).catch((err) => {
    logger.warn({ err: String(err), unit: unit.slug, leadId: lead.id }, 'ponte: franquia indisponível');
    return { unidade: unit.name, franquia: true, paciente: null, erro: 'franquia indisponível' };
  });
}

const textoOuNulo = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

/** A memória que a Sofia guarda do lead (resumo + fatos), também das unidades irmãs da mesma conta. */
async function memoriaDoLead(unit: Unit, leadId: number): Promise<(MemoriaDoLead & { queixa: string | null; cidade: string | null }) | null> {
  const m = await getLeadMemoryForAgent(unit, leadId).catch(() => null);
  if (!m) return null;
  const f = (m.facts && typeof m.facts === 'object' ? m.facts : {}) as Record<string, unknown>;
  return {
    resumo: textoOuNulo(m.summary),
    desfecho: textoOuNulo(f.ultimo_desfecho),
    travouEm: textoOuNulo(f.travou_em),
    ultimoContato: textoOuNulo(f.ultimo_contato),
    queixa: textoOuNulo(f.queixa),
    cidade: textoOuNulo(f.cidade),
  };
}

interface ContextoDoResumo {
  /** Epoch (s) da última mudança de etapa, ou null. */
  desde: number | null;
  memoria: (MemoriaDoLead & { queixa: string | null; cidade: string | null }) | null;
}

/**
 * O que o resumo precisa além do cartão e da franquia: o evento de etapa (Kommo) e a memória da Sofia (banco).
 * Começa JUNTO com a franquia (quem chama só espera no fim). Nunca lança: sem isso, o resumo só fica mais curto.
 */
function contextoDoResumo(unit: Unit, kommo: KommoClient, lead: KommoLead): Promise<ContextoDoResumo> {
  return Promise.all([kommo.ultimaMudancaDeEtapa(lead.id), memoriaDoLead(unit, lead.id)]).then(
    ([desde, memoria]) => ({ desde, memoria }),
    () => ({ desde: null, memoria: null }),
  );
}

/** O resumo sem IA: campos do cartão, memória da Sofia, franquia e há quanto tempo está na etapa. */
function resumoDoCartao(
  lead: KommoLead,
  conta: DadosDaConta,
  franquia: ResumoDoPaciente | null,
  nomeDoContato: string | null,
  { desde, memoria }: ContextoDoResumo,
): ResumoDoLead {
  const doCartao = camposDoQuemE(lead.custom_fields_values);
  const { funil, etapa } = nomesDaEtapa(conta, lead);
  return montarResumo({
    nome: limparNome(lead.name) || nomeDoContato,
    cidade: doCartao.cidade ?? memoria?.cidade ?? null,
    queixa: doCartao.queixa ?? memoria?.queixa ?? null,
    regiao: doCartao.regiao,
    funil,
    etapa,
    naEtapaDesde: desde ?? lead.created_at ?? null,
    franquia,
    memoria,
  });
}

type ContatoComCartoes = NonNullable<Awaited<ReturnType<KommoClient['contatoComCartoes']>>>;

/**
 * Fase 3: os OUTROS cartões abertos do paciente — em que ele é o contato PRINCIPAL (`via: 'contato'`), ou em que o
 * principal é outro contato com o MESMO telefone completo (`via: 'telefone'`, pode ser da família). `null` = não deu
 * para saber (contato não lido, Kommo fora): o painel só não mostra a faixa. Nunca lança.
 */
async function duplicadosDoCartao(
  unit: Unit,
  kommo: KommoClient,
  conta: DadosDaConta,
  lead: KommoLead,
  contato: ContatoComCartoes | null,
  buscar: BuscaPorTelefone,
): Promise<CartaoDuplicado[] | null> {
  try {
    if (!contatoPrincipalDe(lead)) return [];
    if (!contato) return null;
    const ids = new Set<number>(contato.leadIds);
    const doMesmoTelefone = new Set<number>();
    // os dois primeiros números do contato bastam (contato com 5 telefones é raro, e cada um é uma busca)
    for (const tel of contato.telefones.slice(0, 2)) {
      if (!telefoneCompleto(tel)) continue; // número sem DDD não diz "mesma pessoa"
      const achados = await buscar(tel);
      if (achados === null) return null;
      for (const c of achados) {
        if (c.id === contato.id || !c.telefones.some((t) => mesmoTelefoneCompleto(tel, t))) continue;
        doMesmoTelefone.add(c.id);
        for (const id of c.leadIds) ids.add(id);
      }
    }
    ids.delete(lead.id);
    const lista = [...ids].slice(0, MAX_CARTOES_DUPLICADOS);
    if (!lista.length) return [];
    // com os contatos (is_main): quem só aparece como contato secundário não conta
    const cartoes = await kommo.listLeadsPorIds(lista, { contatos: true });
    return cartoesDuplicados(
      lead,
      cartoes,
      { contato: contato.id, doMesmoTelefone },
      (l) => nomesDaEtapa(conta, l),
      (id) => `https://${unit.kommoSubdomain}.kommo.com/leads/detail/${id}`,
    );
  } catch (err) {
    logger.warn({ err: String(err), unit: unit.slug, leadId: lead.id }, 'ponte: não consegui conferir cartões duplicados');
    return null;
  }
}

function pausaParaOPainel(p: EstadoDaPausaDoLead | null): { ate: string; motivo: string | null; por: string | null } | null {
  return p?.emPausa && p.ate ? { ate: p.ate.toISOString(), motivo: p.motivo, por: p.por } : null;
}

// ── a rota ──

/** A Ponte consulta a cada troca de conversa; várias atendentes dividem o IP da clínica. Balde próprio. */
const LIMITE_DA_PONTE = { balde: 'ponte', max: 150 };

export async function ponteCartaoHandler(req: Request, res: Response): Promise<void> {
  const unit = await unidadeDaPonte(req, res, LIMITE_DA_PONTE);
  if (!unit) return;
  if (!unit.kommoSubdomain || !unit.kommoAccessToken) {
    res.status(409).json({ error: 'unidade sem Kommo conectado' });
    return;
  }
  const kommo = createKommoClient(unit);
  const buscarTelefone = buscaPorTelefoneDaRequisicao(kommo);
  const b = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>;
  const leadDireto = Number(b.lead);
  const telefone = telefoneDaPonte(b.telefone);
  const nome = typeof b.nome === 'string' ? b.nome.trim().slice(0, 120) : '';
  const manual = b.manual === true;

  try {
    const casamento: Casamento =
      Number.isInteger(leadDireto) && leadDireto > 0
        ? { tipo: 'achado', como: 'manual', leadIds: [leadDireto], incompleto: false }
        : await casarCartao(
            { telefone, impressoes: impressoesValidas(b.impressoes, 8), nome: nome || null, manual },
            {
              porTelefone: (t) => contatosPorTelefone(buscarTelefone, t),
              porImpressao: (h) => cartaoPorImpressao(unit, h),
              porNome: (n) => contatosPorNome(kommo, n),
            },
          );

    if (casamento.tipo === 'nada') {
      logger.info({ unit: unit.slug, passos: casamento.passos, incompleto: casamento.incompleto }, 'ponte: nenhum cartão');
      res.json({ achado: false, incompleto: casamento.incompleto });
      return;
    }

    const conta = await dadosDaConta(unit, kommo);

    if (casamento.tipo === 'candidatos') {
      const ids = [...new Set(casamento.grupos.flat())].slice(0, 100);
      const porId = new Map((await kommo.listLeadsPorIds(ids)).map((l) => [l.id, l]));
      const candidatos = casamento.grupos
        .map((g) => ordenarCartoes(g.map((id) => porId.get(id)).filter((l): l is KommoLead => !!l))[0])
        .filter((l): l is KommoLead => !!l)
        .slice(0, 8)
        .map((l) => resumoCurto(conta, l));
      logger.info({ unit: unit.slug, como: casamento.como, candidatos: candidatos.length }, 'ponte: candidatos para escolher');
      res.json({ achado: false, como: casamento.como, candidatos, incompleto: casamento.incompleto });
      return;
    }

    // Um paciente pode ter vários cartões (voltou meses depois): mostra o aberto mais mexido e lista os outros.
    const ordenados = casamento.leadIds.length > 1 ? ordenarCartoes(await kommo.listLeadsPorIds(casamento.leadIds.slice(0, 50))) : [];
    const principalId = casamento.leadIds.length > 1 ? ordenados[0]?.id : casamento.leadIds[0];
    const lead = principalId ? await kommo.getLead(principalId).catch((err) => {
      // cartão apagado (a conversa guardada pode ser de um cartão que não existe mais) = não achou
      if (err instanceof KommoApiError && (err.status === 404 || err.status === 204)) return null;
      throw err;
    }) : null;
    if (!lead || typeof lead !== 'object' || !lead.id) {
      res.json({ achado: false, incompleto: casamento.incompleto });
      return;
    }

    const campos = lead.custom_fields_values ?? [];
    const caixinha = unit.kommoPausedFieldId
      ? caixinhaMarcada(campos.find((f) => f.field_id === unit.kommoPausedFieldId)?.values?.[0]?.value)
      : false;
    const pausa = await estadoDaPausaDoLead(unit.id, lead.id).catch(() => null);
    const horario = checkBusinessHours(unit);
    const comercial = funilComercial(conta.funis);
    const anuncio = lerAnuncioDoLead(campos, (n) => campos.find((f) => (f.field_name ?? '').trim() === n)?.field_id ?? null);

    // resumo: sem IA (cartão + memória da Sofia + franquia). O que ele lê a mais começa já, junto da franquia.
    const contexto = contextoDoResumo(unit, kommo, lead);
    // 0.5.0 (visual novo): os campos da conta (a qualificação; cache de 10 min, o mesmo do guia e da ligação) e o grupo
    // de unidades (Petrópolis + Caxias; em memória). Começam já; nenhum dos dois derruba o cartão.
    const defsDaConta = camposDaConta(contaDaUnidade(unit), kommo).catch(() => [] as DefinicaoDeCampo[]);
    const grupoDaConta = grupoDaUnidade(unit.id).catch(() => null as GrupoDoCrm | null);
    // o contato principal, com os cartões dele (fase 3): franquia, primeiro nome e o aviso de duplicado
    const contatoId = contatoPrincipalDe(lead);
    const contatoLido = contatoId ? await kommo.contatoComCartoes(contatoId) : null;
    const duplicados = duplicadosDoCartao(unit, kommo, conta, lead, contatoLido, buscarTelefone);
    // franquia: a mesma resposta do widget "Agenda da franquia". Cair aqui não derruba o cartão.
    const contato = unit.spineEnabled && unit.spineToken ? { nome: contatoLido?.nome ?? null, telefone: contatoLido?.telefone ?? null } : null;
    const franquia = await franquiaDoCartao(unit, lead, contato, telefone);
    let resumo: ResumoDoLead | null = null;
    const ctxDoResumo = await contexto;
    try {
      resumo = resumoDoCartao(lead, conta, franquia, contato?.nome ?? null, ctxDoResumo);
    } catch (err) {
      // cair aqui também não derruba o cartão
      logger.warn({ err: String(err), unit: unit.slug, leadId: lead.id }, 'ponte: resumo do lead falhou');
    }

    logger.info({ unit: unit.slug, como: casamento.como, leadId: lead.id, outros: Math.max(0, ordenados.length - 1) }, 'ponte: cartão achado');
    const listaDeDuplicados = await duplicados;
    const [defs, grupo] = await Promise.all([defsDaConta, grupoDaConta]);
    const valorDaUnidade = valorDaUnidadeNoCartao(lead);
    const qualificacao = qualificacaoDoCartao(defs, campos);
    res.json({
      achado: true,
      como: casamento.como,
      incompleto: casamento.incompleto,
      cartao: {
        id: lead.id,
        nome: lead.name,
        link: `https://${unit.kommoSubdomain}.kommo.com/leads/detail/${lead.id}`,
        ...nomesDaEtapa(conta, lead),
        fechado: lead.status_id === GANHO || lead.status_id === PERDIDO,
        barra: {
          funil: comercial?.name ?? null,
          noFunil: !!comercial && comercial.id === lead.pipeline_id,
          etapas: barraDoFunil(comercial, lead),
        },
        responsavel: (lead.responsible_user_id && conta.usuarios.get(lead.responsible_user_id)) || null,
        etiquetas: (lead._embedded?.tags ?? []).map((t) => t.name).filter(Boolean),
        // fase 3: as que disparam robô que manda mensagem (▶ + a lista da unidade, ex.: "Aderência meio")
        etiquetasRobo: (lead._embedded?.tags ?? []).map((t) => t.name).filter((n) => n && ehEtiquetaDeRobo(n, etiquetasDeRoboDaUnidade(unit.slug))),
        // fase 3: as respostas prontas trocam o marcador de nome por este
        primeiroNome: primeiroNomeDoPaciente(lead.name, contatoLido?.nome ?? null),
        origem: origemDoCartao(lead),
        sofia: estadoDaSofia({
          unidade: unit,
          foraDoHorario: horario.enabled && !horario.isOpen,
          caixinha: caixinhaDaSdr(caixinha, pausa),
          janelaAte: pausa?.ate ?? null,
        }),
        pausaDoLead: pausaParaOPainel(pausa),
        anuncio,
        atualizadoEm: lead.updated_at ? new Date(lead.updated_at * 1000).toISOString() : null,
        // 0.5.0 (visual novo): o cabeçalho e a trilha
        telefone: telefoneDoPainel(contatoLido?.telefone, telefone),
        unidade: unidadeDoPainel(grupo, nomeCurtoDaUnidade(unit.name, unit.slug), valorDaUnidade),
        // `undefined` (a conta não tem o campo) fica fora do JSON; `null` = tem e está vazio
        ...(qualificacao === undefined ? {} : { qualificacao }),
        naEtapaDesde: desdeEmIso(ctxDoResumo.desde ?? lead.created_at ?? null),
        barraTratamento: barraDoTratamento(conta.funis, lead),
      },
      outrosCartoes: ordenados.filter((l) => l.id !== lead.id).slice(0, 5).map((l) => resumoCurto(conta, l)),
      // fase 3: outros cartões ABERTOS do mesmo paciente (null = não deu para conferir agora)
      duplicados: listaDeDuplicados,
      franquia,
      resumo,
      // o botão "Resumir com IA" só aparece com a chave da PRÓPRIA unidade (é ela quem paga)
      iaDisponivel: !!unit.anthropicApiKey,
      // 0.5.0: sem a Sofia na unidade, o painel esconde o estado dela e a pausa
      sofiaNaUnidade: sofiaNaUnidade(unit),
      unidadeDaConta: nomeCurtoDaUnidade(unit.name, unit.slug),
      // 0.5.0: o cartão anda sozinho atrás da franquia (franquia-move E franquia-sync ligados para a unidade DO CARTÃO)?
      // Senão o painel diz "a recepção atualiza pela franquia" e não promete movimento automático.
      franquiaAndaSozinha: franquiaAndaSozinha(slugDaUnidadeDoCartao(grupo, unit, valorDaUnidade)),
      agora: new Date(),
    });
  } catch (err) {
    logger.warn({ err: String(err), unit: unit.slug }, 'ponte: falha ao montar o cartão');
    res.status(502).json({ error: 'kommo indisponível' });
  }
}

// ── fase 2: pausar a Sofia neste paciente (a MESMA pausa do widget "Pausar a Sofia") ──

/** Escrita: balde próprio e baixo. Uma atendente pausa poucos pacientes por dia. */
const LIMITE_DA_PAUSA = { balde: 'ponte-pausa', max: 30 };

function respostaDaPausa(e: EstadoDaPausaDoLead) {
  return { leadId: e.leadId, pausaDoLead: pausaParaOPainel(e), campoMarcado: e.campoMarcado, agora: new Date() };
}

/** `POST /api/public/widget/:slug/ponte/pausa` `{ leadId, ate, motivo?, por? }` */
export async function pontePausarHandler(req: Request, res: Response): Promise<void> {
  const unit = await unidadeDaPonte(req, res, LIMITE_DA_PAUSA);
  if (!unit) return;
  if (!unit.kommoSubdomain || !unit.kommoAccessToken) {
    res.status(409).json({ error: 'unidade sem Kommo conectado' });
    return;
  }
  const lido = lerPedidoDePausa(req.body);
  if (!lido.ok) {
    res.status(400).json({ error: lido.erro });
    return;
  }
  const { leadId, ate, motivo, por } = lido.pedido;
  try {
    const estado = await pausarLead(unit, leadId, { ate, motivo, por: por ?? POR_PADRAO });
    logger.info({ unit: unit.slug, leadId, ate, origem: 'ponte' }, 'ponte: Sofia pausada neste paciente');
    res.json(respostaDaPausa(estado));
  } catch (err) {
    logger.warn({ err: String(err), unit: unit.slug, leadId }, 'ponte: falha ao pausar a Sofia');
    res.status(502).json({ error: 'não consegui pausar agora' });
  }
}

/** `DELETE /api/public/widget/:slug/ponte/pausa` `{ leadId, por? }` */
export async function ponteRetomarHandler(req: Request, res: Response): Promise<void> {
  const unit = await unidadeDaPonte(req, res, LIMITE_DA_PAUSA);
  if (!unit) return;
  if (!unit.kommoSubdomain || !unit.kommoAccessToken) {
    res.status(409).json({ error: 'unidade sem Kommo conectado' });
    return;
  }
  const lido = lerPedidoDeRetomada(req.body);
  if (!lido.ok) {
    res.status(400).json({ error: lido.erro });
    return;
  }
  try {
    const estado = await retomarLead(unit, lido.pedido.leadId, lido.pedido.por ?? POR_PADRAO);
    res.json(respostaDaPausa(estado));
  } catch (err) {
    logger.warn({ err: String(err), unit: unit.slug, leadId: lido.pedido.leadId }, 'ponte: falha ao retomar a Sofia');
    res.status(502).json({ error: 'não consegui retomar agora' });
  }
}

// ── fase 2: "Resumir com IA" — só quando a atendente clica ──

const LIMITE_DA_IA = { balde: 'ponte-ia', max: 20 };

interface RespostaDoResumoIa {
  leadId: number;
  linhas: string[];
  geradoEm: string;
  /** falso = não havia conversa para a IA ler, e as linhas são o resumo do cartão (sem custo). */
  ia: boolean;
  aviso?: string;
}

const cacheResumoIa = new Map<string, { em: number; corpo: RespostaDoResumoIa }>();
const resumoIaEmAndamento = new Map<string, Promise<RespostaDoResumoIa>>();

const ANEXO: Record<string, string> = { voice: 'áudio', audio: 'áudio', picture: 'imagem', video: 'vídeo', file: 'arquivo', sticker: 'figurinha' };

async function gerarResumoIa(unit: Unit, chave: string, leadId: number): Promise<RespostaDoResumoIa> {
  const kommo = createKommoClient(unit);
  // A conversa oficial do Kommo (paciente, Sofia e equipe) só precisa do id: começa já, junto com o resto.
  // Áudio entra como "[áudio]": transcrever custa.
  const conversa = mensagensOficiais(kommo, leadId, 40).catch(() => []);
  const [lead, conta] = await Promise.all([kommo.getLead(leadId), dadosDaConta(unit, kommo)]);
  const contexto = contextoDoResumo(unit, kommo, lead);
  const contato = await contatoParaFranquia(unit, kommo, lead).catch(() => null);
  const franquia = await franquiaDoCartao(unit, lead, contato, null);
  const ctx = await contexto;
  const base = resumoDoCartao(lead, conta, franquia, contato?.nome ?? null, ctx);
  const memoria = ctx.memoria;
  const falas = (await conversa)
    .map((m) => ({ autor: m.autor, texto: m.texto || (m.anexo ? `[${ANEXO[m.anexo.tipo] ?? 'anexo'}]` : '') }))
    .filter((f) => f.texto);
  const geradoEm = new Date().toISOString();

  if (!falas.length && !memoria?.resumo) {
    // nada para a IA ler além do que o cartão já disse: não gasta
    return {
      leadId,
      linhas: [...base.linhas, ...(base.proximoPasso ? [`Próximo passo: ${base.proximoPasso}`] : [])],
      geradoEm,
      ia: false,
      aviso: 'Não há conversa no Kommo para a IA ler: este é o resumo do cartão.',
    };
  }

  const inicio = performance.now();
  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': chave, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({
      model: MODELO_RESUMO_IA,
      max_tokens: MAX_TOKENS_RESUMO_IA,
      messages: [{ role: 'user', content: montarPromptDoResumoIa(base, memoria?.resumo ?? null, falas) }],
    }),
    signal: AbortSignal.timeout(30_000),
  });
  const data = (await resp.json().catch(() => ({}))) as {
    content?: Array<{ type?: string; text?: string }>;
    usage?: { input_tokens?: number; output_tokens?: number };
    error?: unknown;
  };
  // o custo entra na mesma conta da IA da unidade (tela de custo), como toda chamada de modelo
  void recordLlmCall({
    unitId: unit.id,
    traceId: null,
    provider: 'anthropic',
    model: MODELO_RESUMO_IA,
    promptTokens: data.usage?.input_tokens ?? 0,
    completionTokens: data.usage?.output_tokens ?? 0,
    latencyMs: Math.round(performance.now() - inicio),
    status: resp.ok && !data.error ? 'success' : 'error',
    errorMessage: data.error ? JSON.stringify(data.error).slice(0, 300) : undefined,
  });
  if (!resp.ok || data.error) throw new Error(`Anthropic ${resp.status}: ${JSON.stringify(data.error ?? '').slice(0, 160)}`);
  const linhas = interpretarResumoDaIa((data.content ?? []).filter((b) => b.type === 'text').map((b) => b.text ?? '').join('\n'));
  if (!linhas.length) throw new Error('a IA devolveu um resumo vazio');
  return { leadId, linhas, geradoEm, ia: true };
}

/** `POST /api/public/widget/:slug/ponte/resumo-ia` `{ leadId }` */
export async function ponteResumoIaHandler(req: Request, res: Response): Promise<void> {
  const unit = await unidadeDaPonte(req, res, LIMITE_DA_IA);
  if (!unit) return;
  const chave = unit.anthropicApiKey;
  if (!chave) {
    res.status(404).json({ error: 'unidade sem chave da IA' });
    return;
  }
  if (!unit.kommoSubdomain || !unit.kommoAccessToken) {
    res.status(409).json({ error: 'unidade sem Kommo conectado' });
    return;
  }
  const leadId = leadIdDoPedido((req.body as { leadId?: unknown } | undefined)?.leadId);
  if (!leadId) {
    res.status(400).json({ error: 'lead inválido' });
    return;
  }
  const k = `${unit.id}:${leadId}`;
  const guardado = cacheResumoIa.get(k);
  if (guardado && Date.now() - guardado.em < CACHE_RESUMO_IA_MS) {
    res.json({ ...guardado.corpo, cache: true });
    return;
  }
  try {
    // dois cliques seguidos (ou duas atendentes no mesmo paciente) viram UMA chamada à IA
    let p = resumoIaEmAndamento.get(k);
    if (!p) {
      p = gerarResumoIa(unit, chave, leadId).finally(() => resumoIaEmAndamento.delete(k));
      resumoIaEmAndamento.set(k, p);
    }
    const corpo = await p;
    // só guarda o que a IA escreveu: o "sem conversa para ler" não custou nada e precisa valer assim que o
    // paciente escrever, não daqui a 6 h
    if (corpo.ia) {
      if (cacheResumoIa.size > 2_000) cacheResumoIa.clear();
      cacheResumoIa.set(k, { em: Date.now(), corpo });
    }
    logger.info({ unit: unit.slug, leadId, ia: corpo.ia, linhas: corpo.linhas.length }, 'ponte: resumo do lead gerado');
    res.json({ ...corpo, cache: false });
  } catch (err) {
    logger.warn({ err: String(err), unit: unit.slug, leadId }, 'ponte: resumo com IA falhou');
    res.status(502).json({ error: 'não consegui resumir agora' });
  }
}

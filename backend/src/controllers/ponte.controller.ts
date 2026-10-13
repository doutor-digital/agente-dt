/**
 * Rota pública da extensão "Ponte" (WhatsApp Web, fase 1 — SÓ LEITURA, 13/10/2026).
 *
 * `POST /api/public/widget/:slug/ponte/cartao` → o cartão do Kommo do paciente da conversa aberta no
 * WhatsApp Web, para o painel lateral. Mesma chave por unidade dos widgets do cartão (`X-Widget-Key`, ver
 * `widget-franquia.controller.ts` → `unidadeDoWidget`), com limite próprio.
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
 * Nada aqui escreve no Kommo, na franquia ou no banco; nome, telefone e impressões não vão para o log.
 */
import type { Request, Response } from 'express';
import type { Unit } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import { unidadeDoWidget } from './widget-franquia.controller.js';
import { KommoApiError, createKommoClient, type KommoClient, type KommoLead, type KommoPipeline } from '../services/kommo.service.js';
import { chaveTelefone } from '../lib/franquia-sync.js';
import { termosDeBusca } from '../lib/widget-agenda.js';
import { JANELA_DA_IMPRESSAO_MS, casarPorImpressoes, impressoesValidas } from '../lib/ponte-impressao.js';
import {
  GANHO,
  PERDIDO,
  barraDoFunil,
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
import { estadoDaPausaDoLead } from '../lib/pausa-lead.js';
import { checkBusinessHours } from '../agent/prompt-composer.js';
import { lerAnuncioDoLead } from '../agent/anuncio-de-origem.js';
import { resumoDoPacienteNaFranquia, type ResumoDoPaciente } from '../lib/paciente-na-franquia.js';

// ── funis e usuários da conta: mudam pouco, e a Ponte chama a cada troca de conversa ──
const CONTA_TTL_MS = 10 * 60_000;
interface DadosDaConta {
  em: number;
  funis: KommoPipeline[];
  usuarios: Map<number, string>;
}
const cacheConta = new Map<string, DadosDaConta>();

async function dadosDaConta(unit: Unit, kommo: KommoClient): Promise<DadosDaConta> {
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

/** Passo 1: contatos cujo telefone CONFERE (a busca do Kommo só sugere — casa pelos últimos dígitos). */
async function contatosPorTelefone(kommo: KommoClient, telefone: string): Promise<ContatoAchado[]> {
  const contatos = await kommo.buscarContatos(chaveTelefone(telefone), 25);
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

// ── a rota ──

/** A Ponte consulta a cada troca de conversa; várias atendentes dividem o IP da clínica. Balde próprio. */
const LIMITE_DA_PONTE = { balde: 'ponte', max: 150 };

export async function ponteCartaoHandler(req: Request, res: Response): Promise<void> {
  const unit = await unidadeDoWidget(req, res, LIMITE_DA_PONTE);
  if (!unit) return;
  if (!unit.kommoSubdomain || !unit.kommoAccessToken) {
    res.status(409).json({ error: 'unidade sem Kommo conectado' });
    return;
  }
  const kommo = createKommoClient(unit);
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
              porTelefone: (t) => contatosPorTelefone(kommo, t),
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
    const janelaAte = await estadoDaPausaDoLead(unit.id, lead.id).then((p) => p.ate).catch(() => null);
    const horario = checkBusinessHours(unit);
    const comercial = funilComercial(conta.funis);
    const anuncio = lerAnuncioDoLead(campos, (n) => campos.find((f) => (f.field_name ?? '').trim() === n)?.field_id ?? null);

    // franquia: a mesma resposta do widget "Agenda da franquia". Cair aqui não derruba o cartão.
    let franquia: ResumoDoPaciente | null = null;
    if (unit.spineEnabled && unit.spineToken) {
      const contatoId = lead._embedded?.contacts?.find((c) => c.is_main)?.id ?? lead._embedded?.contacts?.[0]?.id ?? null;
      const contato = contatoId ? await kommo.getContactBasico(contatoId) : { nome: null, telefone: null };
      franquia = await resumoDoPacienteNaFranquia(unit, {
        leadId: lead.id,
        nome: (contato.nome ?? '').slice(0, 120),
        titulo: (lead.name ?? '').slice(0, 120),
        telefone: contato.telefone ?? telefone ?? '',
      }).catch((err) => {
        logger.warn({ err: String(err), unit: unit.slug, leadId: lead.id }, 'ponte: franquia indisponível');
        return { unidade: unit.name, franquia: true, paciente: null, erro: 'franquia indisponível' };
      });
    }

    logger.info({ unit: unit.slug, como: casamento.como, leadId: lead.id, outros: Math.max(0, ordenados.length - 1) }, 'ponte: cartão achado');
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
        sofia: estadoDaSofia({ unidade: unit, foraDoHorario: horario.enabled && !horario.isOpen, caixinha, janelaAte }),
        anuncio,
        atualizadoEm: lead.updated_at ? new Date(lead.updated_at * 1000).toISOString() : null,
      },
      outrosCartoes: ordenados.filter((l) => l.id !== lead.id).slice(0, 5).map((l) => resumoCurto(conta, l)),
      franquia,
      agora: new Date(),
    });
  } catch (err) {
    logger.warn({ err: String(err), unit: unit.slug }, 'ponte: falha ao montar o cartão');
    res.status(502).json({ error: 'kommo indisponível' });
  }
}

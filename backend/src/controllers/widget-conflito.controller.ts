/**
 * "Qual é o paciente deste cartão?" — a escolha da SDR no widget quando dois pacientes da franquia usam o mesmo telefone
 * (decisão 1 do João, 16/10/2026).
 *
 * `GET  /api/public/widget/:slug/conflito?lead=ID`          → os candidatos (nome, final do telefone, última consulta)
 * `POST /api/public/widget/:slug/conflito/escolher`          → { leadId, idClient, usuario? } grava o `⚙ idClient (franquia)`
 *                                                               no cartão, tira a etiqueta CONFLITO_FRANQUIA e deixa nota.
 *
 * Só oferece — e só aceita — paciente que o robô viu no telefone deste cartão (os candidatos guardados pelo sincronizador,
 * ou os que a busca da franquia acha agora pelo título e pelo telefone). Um idClient qualquer, vindo de fora, não grava.
 * Mesma chave por unidade dos outros widgets (`unidadeDoWidget`). A escrita só vale com a chave `casamento-jornada`
 * LIGADA: em "só no papel" o widget mostra a lista, mas não grava.
 */
import type { Request, Response } from 'express';
import type { Unit } from '@prisma/client';
import { logger } from '../lib/logger.js';
import { unidadeDoWidget } from './widget-franquia.controller.js';
import { createKommoClient, type KommoClient, type KommoLead } from '../services/kommo.service.js';
import { SpineService } from '../services/spine.service.js';
import { contaDoKommo, unidadeParaOCartao } from '../lib/crm-compartilhado.js';
import { CAMPO_ID_CLIENT, TAG_CONFLITO, estadoCasamentoJornada } from '../lib/casamento-jornada.js';
import { candidatosGuardados, escolhaDaSdr, gravarEscolhaDaSdr } from '../lib/conflito-paciente.js';
import { camposDaConta, campoDaConta, casarPacienteDoCartao, idClientDoCartao, type CampoBruto, type CampoDaConta } from '../lib/franquia-sync-worker.js';
import { chaveTelefone, ehConsulta } from '../lib/franquia-sync.js';

const MAX_CANDIDATOS = 5;

interface Contexto {
  unitDaFranquia: Unit;
  kommo: KommoClient;
  lead: KommoLead;
  campos: CampoDaConta[];
  idDoCartao: number | null;
  temEtiqueta: boolean;
}

async function contexto(unit: Unit, leadId: number): Promise<{ ok: true; c: Contexto } | { ok: false; status: number; erro: string }> {
  const dono = await unidadeParaOCartao(unit, leadId);
  if (dono.tipo === 'recusa') return { ok: false, status: 409, erro: dono.motivo };
  const kommo = createKommoClient(await contaDoKommo(unit));
  const [lead, bruto] = await Promise.all([
    kommo.getLead(leadId),
    kommo.listLeadCustomFields() as Promise<{ _embedded?: { custom_fields?: CampoBruto[] } } | undefined>,
  ]);
  const campos = camposDaConta(bruto?._embedded?.custom_fields ?? []);
  return {
    ok: true,
    c: {
      unitDaFranquia: dono.unit,
      kommo,
      lead,
      campos,
      idDoCartao: idClientDoCartao(lead, campos),
      temEtiqueta: (lead._embedded?.tags ?? []).some((t) => t.name === TAG_CONFLITO),
    },
  };
}

/**
 * Quem o robô viu no telefone deste cartão: o que o sincronizador guardou; sem isso, a busca de agora — só para cartão
 * com a etiqueta CONFLITO_FRANQUIA (a busca custa até 10 chamadas à franquia; o widget abre em todo cartão).
 */
async function candidatosDoCartao(c: Contexto, leadId: number): Promise<number[]> {
  const guardados = await candidatosGuardados(c.unitDaFranquia.id, leadId);
  if (guardados.length >= 2 || !c.temEtiqueta) return guardados.slice(0, MAX_CANDIDATOS);
  const agora = await casarPacienteDoCartao(c.unitDaFranquia, leadId, c.lead.name ?? null, {
    kommo: c.kommo,
    contatoId: c.lead._embedded?.contacts?.[0]?.id ?? null,
    campos: c.campos,
  }).catch((err) => {
    logger.warn({ err: String(err), leadId }, 'widget-conflito: busca na franquia falhou');
    return null;
  });
  const ids = agora?.tipo === 'conflito' || agora?.tipo === 'desempatar' ? agora.candidatos.map((x) => x.idClient).filter((x): x is number => !!x) : [];
  return [...new Set([...guardados, ...ids])].slice(0, MAX_CANDIDATOS);
}

function leadIdDe(v: unknown): number | null {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** GET /public/widget/:slug/conflito?lead=ID */
export async function widgetConflitoHandler(req: Request, res: Response): Promise<void> {
  const unit = await unidadeDoWidget(req, res);
  if (!unit) return;
  const leadId = leadIdDe(req.query.lead);
  if (!leadId) { res.status(400).json({ error: 'lead inválido' }); return; }
  const estado = estadoCasamentoJornada(unit.slug);
  if (estado === 'desligado') { res.json({ estado, conflito: false, candidatos: [] }); return; }
  if (!unit.spineEnabled || !unit.spineToken) { res.json({ estado, conflito: false, candidatos: [], motivo: 'franquia não conectada' }); return; }
  try {
    const ctx = await contexto(unit, leadId);
    if (!ctx.ok) { res.status(ctx.status).json({ error: ctx.erro }); return; }
    const c = ctx.c;
    const ids = await candidatosDoCartao(c, leadId);
    const escolhido = await escolhaDaSdr(c.unitDaFranquia.id, leadId);
    const agora = Date.now();
    const candidatos = await Promise.all(ids.map(async (idClient) => {
      const r = await SpineService.getClient(c.unitDaFranquia, idClient).catch(() => null);
      const cli = r?.ok ? r.data?.client ?? null : null;
      const consultas = (cli?.schedules ?? []).filter((s) => ehConsulta(s) && s.dateAttendanceUtc);
      const passadas = consultas.filter((s) => Date.parse(String(s.dateAttendanceUtc)) <= agora).sort((a, b) => String(b.dateAttendanceUtc).localeCompare(String(a.dateAttendanceUtc)));
      const futuras = consultas.filter((s) => Date.parse(String(s.dateAttendanceUtc)) > agora).sort((a, b) => String(a.dateAttendanceUtc).localeCompare(String(b.dateAttendanceUtc)));
      const resumo = (s: (typeof consultas)[number] | undefined) => (s ? { dia: s.dayLocal, hora: s.timeLocal, categoria: s.categoryName, status: s.statusName } : null);
      return {
        idClient,
        nome: cli?.name ?? null,
        telefoneFinal: cli?.whatsapp ? `…${chaveTelefone(cli.whatsapp).slice(-4)}` : null,
        ultimaConsulta: resumo(passadas[0]),
        proximaConsulta: resumo(futuras[0]),
        tratamentos: (cli?.treatments ?? []).map((t) => t.statusName).filter(Boolean),
      };
    }));
    res.json({
      estado,
      conflito: ids.length >= 2 && c.idDoCartao === null,
      etiqueta: c.temEtiqueta,
      idClientNoCartao: c.idDoCartao,
      escolhido,
      podeGravar: estado === 'ligado',
      candidatos,
    });
  } catch (err) {
    logger.warn({ err: String(err), unit: unit.slug, leadId }, 'widget-conflito: falha ao montar os candidatos');
    res.status(502).json({ error: 'franquia ou Kommo indisponível' });
  }
}

/** POST /public/widget/:slug/conflito/escolher { leadId, idClient, usuario? } */
export async function widgetEscolherPacienteHandler(req: Request, res: Response): Promise<void> {
  const unit = await unidadeDoWidget(req, res);
  if (!unit) return;
  const b = (req.body ?? {}) as Record<string, unknown>;
  const leadId = leadIdDe(b.leadId);
  const idClient = leadIdDe(b.idClient);
  if (!leadId || !idClient) { res.status(400).json({ error: 'leadId e idClient são obrigatórios' }); return; }
  const estado = estadoCasamentoJornada(unit.slug);
  if (estado !== 'ligado') {
    res.status(409).json({ error: estado === 'seco' ? 'a regra de 16/10 está "só no papel" nesta unidade: a escolha não é gravada' : 'a regra de 16/10 está desligada nesta unidade' });
    return;
  }
  const usuario = typeof b.usuario === 'string' ? b.usuario.trim().slice(0, 60) : '';
  try {
    const ctx = await contexto(unit, leadId);
    if (!ctx.ok) { res.status(ctx.status).json({ error: ctx.erro }); return; }
    const c = ctx.c;
    const permitidos = await candidatosDoCartao(c, leadId);
    if (!permitidos.includes(idClient)) {
      res.status(400).json({ error: 'este paciente não está entre os que usam o telefone deste cartão', candidatos: permitidos });
      return;
    }
    const campo = campoDaConta(c.campos, CAMPO_ID_CLIENT);
    if (!campo) { res.status(409).json({ error: `a conta do Kommo não tem o campo "${CAMPO_ID_CLIENT}"` }); return; }
    const cli = await SpineService.getClient(c.unitDaFranquia, idClient).catch(() => null);
    const nome = cli?.ok ? cli.data?.client?.name ?? null : null;

    await c.kommo.setLeadCustomFieldValue(leadId, campo.id, 'numeric', idClient);
    await gravarEscolhaDaSdr(c.unitDaFranquia.id, leadId, idClient);
    if (c.temEtiqueta) await c.kommo.removeTag(leadId, TAG_CONFLITO).catch((err) => logger.warn({ err: String(err), leadId }, 'widget-conflito: não tirei a etiqueta'));
    const outros = permitidos.filter((x) => x !== idClient);
    await c.kommo
      .addLeadNote(leadId, `✔ Paciente deste cartão escolhido${usuario ? ` por ${usuario}` : ''} no widget: idClient ${idClient}${nome ? ` (${nome})` : ''}. O robô passa a usar só este paciente; ${outros.length ? `o${outros.length > 1 ? 's' : ''} outro${outros.length > 1 ? 's' : ''} do mesmo telefone (idClient ${outros.join(', ')}) não grava${outros.length > 1 ? 'm' : ''} mais aqui` : 'nenhum outro grava aqui'}.`)
      .catch((err) => logger.warn({ err: String(err), leadId }, 'widget-conflito: nota não foi'));
    logger.info({ unit: unit.slug, leadId, idClient, outros }, 'widget-conflito: SDR escolheu o paciente do cartão');
    res.json({ ok: true, idClient, nome });
  } catch (err) {
    logger.warn({ err: String(err), unit: unit.slug, leadId }, 'widget-conflito: falha ao gravar a escolha');
    res.status(502).json({ error: 'não consegui gravar no cartão' });
  }
}

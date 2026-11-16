/**
 * A rodada da origem «chatwoot»: pega as ondas APROVADAS do CRM e roda `rodarUnidade` (o motor, com os freios) com o `Porto` do CRM; e a
 * varredura do que o paciente fez DEPOIS do envio — pediu para sair (alimenta a parada por SAIR) e a mensagem que o CRM marcou como falha.
 * Chamada pelo `disparo-worker.ts`: a rodada de envio na mesma trava da do Kommo (uma por vez), a varredura À PARTE (lenta: não atrasa envio).
 */
import type { Unit } from '@prisma/client';
import { prisma } from '../../prisma.js';
import { logger } from '../../logger.js';
import { fusoDaUnidade } from '../../fuso.js';
import { enviarTelegram } from '../../telegram.js';
import { freiosDoAmbiente } from '../freios.js';
import { rodarUnidade, rodadasSemAndar, type OndaNoLote } from '../lote.js';
import { portoReal } from '../porto.js';
import { definicaoDaOnda } from '../onda.js';
import { ajusteDaUnidade, freiosComOTier } from './ajuste.js';
import { lerMensagens, ultimoPedidoDeSaida } from './mensagens.js';
import { ctxDaUnidadeNoCrm, ORIGEM_CRM } from './onda.js';
import { idDaMensagem, portoChatwoot, unidadesDoMesmoNumeroKapso, type OndaDaRodada } from './porto.js';
import { JANELA_DA_RESPOSTA_MS } from './relatorio.js';
import type { ContextoChatwoot } from '../../../mcp-remoto/chatwoot.js';

const HORAS_OLHANDO = 72;
/** A varredura confere TODOS os envios das últimas 72 h (sem corte: o freio por SAIR não pode contar menos que a realidade), até este tempo. */
const ORCAMENTO_DA_VARREDURA_MS = 4 * 60_000;
const SIMULTANEAS = 4;
const VARRER_A_CADA_MS = Number(process.env.DISPARO_CRM_VARRER_A_CADA_MS) > 0 ? Number(process.env.DISPARO_CRM_VARRER_A_CADA_MS) : 300_000;

let ultimaVarredura = 0;
let varrendo = false;
export const _zerarVarreduraDoCrm = (): void => {
  ultimaVarredura = 0;
  varrendo = false;
};

export interface VarredorDeps {
  ctx?: (slug: string) => ContextoChatwoot | null;
  mensagens?: typeof lerMensagens;
  agora?: () => number;
}

/** Códigos da Meta que NÃO passam com o tempo: restrição do número por qualidade/spam. */
const RESTRICAO = /\b131048\b|\b131056\b/;

/**
 * Quem recebeu e DEPOIS escreveu SAIR vira `saiu` (é isso que alimenta o freio por SAIR); a mensagem que o CRM marcou como falha
 * (a entrega pela Meta falhou depois de o CRM aceitar) vira `falhou`, o que alimenta o freio por falhas seguidas. Lê só a conversa do
 * disparo (a resposta do paciente à mensagem chega nela); o SAIR dito em OUTRA conversa dele é pego na reconferência do próximo envio.
 */
export async function varrerRespostasDoCrm(deps: VarredorDeps = {}): Promise<{ saiu: number; falhou: number; restritos: string[]; restritosUnitIds: string[]; conferidos: number; faltaram: number }> {
  const relogio = deps.agora ?? Date.now;
  const inicio = relogio();
  const ler = deps.mensagens ?? lerMensagens;
  const ctxDe = deps.ctx ?? ctxDaUnidadeNoCrm;
  const enviados = await prisma.disparoDestinatario.findMany({
    where: { onda: { origem: ORIGEM_CRM }, estado: { in: ['enviado', 'falhou', 'saiu'] }, conversaChatwoot: { not: null }, enviadoEm: { gte: new Date(inicio - HORAS_OLHANDO * 3_600_000) } },
    orderBy: { enviadoEm: 'asc' },
    select: { id: true, estado: true, wamid: true, conversaChatwoot: true, enviadoEm: true, entregueEm: true, lidaEm: true, respondeuEm: true, onda: { select: { unitId: true, contaChatwoot: true, unit: { select: { slug: true } } } } },
  });
  // quem pode MUDAR de estado (SAIR, falha) vem primeiro; quem já saiu só renova marcas, por último, e some quando já tem tudo
  const fila = enviados.filter((e) => !(e.estado === 'saiu' && e.entregueEm && e.respondeuEm)).sort((a, b) => Number(a.estado === 'saiu') - Number(b.estado === 'saiu'));
  // a resposta é da ÚLTIMA mensagem nossa antes dela: na mesma conversa, um disparo mais novo "rouba" a resposta do mais velho
  const enviosDaConversa = new Map<string, number[]>();
  for (const e of enviados) {
    const k = `${e.onda.contaChatwoot}:${e.conversaChatwoot}`;
    enviosDaConversa.set(k, [...(enviosDaConversa.get(k) ?? []), e.enviadoEm!.getTime()]);
  }
  let saiu = 0;
  let falhou = 0;
  let conferidos = 0;
  const restritos = new Set<string>();
  const restritosUnitIds = new Set<string>();
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(SIMULTANEAS, fila.length) }, async () => {
      while (i < fila.length && relogio() - inicio < ORCAMENTO_DA_VARREDURA_MS) {
        const e = fila[i++]!;
        const ctx = ctxDe(e.onda.unit.slug);
        if (!ctx?.conta || ctx.conta.conta !== e.onda.contaChatwoot) continue;
        try {
          const msgs = await ler(ctx, e.conversaChatwoot!, 3);
          conferidos++;
          const mid = idDaMensagem(e.wamid);
          const nossa = mid ? msgs.find((m) => m.id === mid) : undefined;
          // As marcas do relatório (entregue, lida, respondeu): gravadas uma vez, na primeira varredura que as vê. A hora é a da varredura.
          const marcas: Record<string, Date> = {};
          const visto = new Date(relogio());
          if (nossa && (nossa.status === 'delivered' || nossa.status === 'read') && !e.entregueEm) marcas.entregueEm = visto;
          if (nossa?.status === 'read') {
            if (!e.lidaEm) marcas.lidaEm = visto;
            if (!e.entregueEm) marcas.entregueEm = visto;
          }
          const outrosEnvios = (enviosDaConversa.get(`${e.onda.contaChatwoot}:${e.conversaChatwoot}`) ?? []).filter((t) => t > e.enviadoEm!.getTime());
          const primeiraResposta = msgs
            .filter((m) => m.tipo === 0 && !m.privada && m.criadaEm >= e.enviadoEm! && m.criadaEm.getTime() - e.enviadoEm!.getTime() <= JANELA_DA_RESPOSTA_MS)
            .filter((m) => !outrosEnvios.some((t) => t <= m.criadaEm.getTime()))
            .sort((a, b) => a.criadaEm.getTime() - b.criadaEm.getTime())[0];
          if (primeiraResposta && !e.respondeuEm) marcas.respondeuEm = primeiraResposta.criadaEm;
          if (Object.keys(marcas).length) await prisma.disparoDestinatario.updateMany({ where: { id: e.id }, data: marcas });
          if (e.estado === 'saiu') continue; // já contado; só as marcas acima ainda importavam
          const pediu = ultimoPedidoDeSaida(msgs);
          if (pediu && pediu.getTime() >= e.enviadoEm!.getTime()) {
            const r = await prisma.disparoDestinatario.updateMany({ where: { id: e.id, estado: { in: ['enviado', 'falhou'] } }, data: { estado: 'saiu', motivo: 'respondeu SAIR depois do envio' } });
            saiu += r.count;
            continue;
          }
          if (e.estado === 'enviado' && nossa?.status === 'failed') {
            const motivo = `o CRM marcou a entrega como falha${nossa.erro ? `: ${nossa.erro}` : ''}`.slice(0, 300);
            const r = await prisma.disparoDestinatario.updateMany({ where: { id: e.id, estado: 'enviado' }, data: { estado: 'falhou', motivo } });
            falhou += r.count;
            if (RESTRICAO.test(nossa.erro ?? '')) {
              restritos.add(e.onda.unit.slug);
              if (e.onda.unitId) restritosUnitIds.add(e.onda.unitId);
            }
          }
        } catch (err) {
          logger.warn({ err: String(err), unit: e.onda.unit.slug }, 'disparo-crm: não consegui ler as mensagens de um envio (tento na próxima varredura)');
        }
      }
    }),
  );
  return { saiu, falhou, restritos: [...restritos], restritosUnitIds: [...restritosUnitIds], conferidos, faltaram: Math.max(0, fila.length - i) };
}

/** O aviso da restrição do número: cita TODAS as unidades pausadas (o número é delas todas). */
export const alertaDeRestricao = (slugs: readonly string[]): string =>
  `🚨 Disparo do CRM PAUSADO — ${slugs.join(' + ')}\nMotivo: a Meta restringiu o número (131048/131056) numa mensagem do disparo${slugs.length > 1 ? `; as ${slugs.length} unidades que usam este número foram pausadas juntas` : ''}. Continuar mandando agrava a restrição. Resolva com a Meta e monte o disparo de novo.`;

/** Roda a varredura se já passou o intervalo e não há outra andando. Nunca lança. O relógio só anda quando ela TERMINOU. */
export async function varrerSeChegouAHora(deps: VarredorDeps = {}): Promise<void> {
  const agora = deps.agora?.() ?? Date.now();
  if (varrendo || agora - ultimaVarredura < VARRER_A_CADA_MS) return;
  varrendo = true;
  try {
    const r = await varrerRespostasDoCrm(deps);
    ultimaVarredura = agora;
    if (r.saiu || r.falhou || r.faltaram) logger.warn(r, 'disparo-crm: varredura depois do envio');
    if (r.restritos.length) {
      const slug = r.restritos.join(', ');
      // a restrição é do NÚMERO: pausa as ondas do CRM de TODAS as unidades que usam o mesmo número do Kapso, não só a da mensagem
      const ids = new Set<string>();
      for (const id of r.restritosUnitIds) for (const x of await unidadesDoMesmoNumeroKapso(id).catch(() => [id])) ids.add(x);
      logger.error({ unit: slug, unidadesDoNumero: ids.size }, 'disparo-crm: o número foi RESTRINGIDO pela Meta (131048/131056) — pauso as ondas do CRM das unidades do número');
      await prisma.disparoOnda.updateMany({
        where: ids.size ? { unitId: { in: [...ids] }, origem: ORIGEM_CRM, estado: 'aprovada' } : { unit: { slug }, origem: ORIGEM_CRM, estado: 'aprovada' },
        data: { estado: 'pausada', pausaMotivo: 'a Meta restringiu o número (spam/qualidade): resolva com a Meta e monte o disparo de novo', pausaCausa: 'meta' },
      });
      const slugsDoNumero = ids.size ? (await prisma.unit.findMany({ where: { id: { in: [...ids] } }, select: { slug: true } }).catch(() => [])).map((u) => u.slug).sort() : [];
      const todas = [...new Set([...r.restritos, ...slugsDoNumero])].join(' + ');
      await enviarTelegram(alertaDeRestricao(todas.split(' + '))).catch(() => undefined);
    }
  } catch (err) {
    logger.warn({ err: String(err) }, 'disparo-crm: a varredura falhou');
  } finally {
    varrendo = false;
  }
}

/** Rodadas seguidas, por unidade, em que só houve gente adiada (CRM fora do ar, token caído, franquia fora) e ninguém andou. */
const SEM_ANDAR_PARA_ALERTAR = 5;
const semAndar = new Map<string, number>();
export const _zerarSemAndarDoCrm = (): void => semAndar.clear();

/** Avisa o João UMA vez por episódio (como o Kommo): sem isto, token do CRM caído é silêncio. */
export async function avisarSeSemAndar(slug: string, unitId: string, r: Parameters<typeof rodadasSemAndar>[1], avisar: (t: string) => Promise<unknown> = (t) => enviarTelegram(t)): Promise<void> {
  const n = rodadasSemAndar(semAndar.get(unitId) ?? 0, r);
  semAndar.set(unitId, n);
  if (n >= SEM_ANDAR_PARA_ALERTAR && n % SEM_ANDAR_PARA_ALERTAR === 0) logger.error({ unit: slug, rodadas: n, adiados: r.adiados }, 'disparo-crm: a onda está SEM ANDAR — rodadas seguidas só com pessoas adiadas (CRM, token ou franquia fora?)');
  if (n === SEM_ANDAR_PARA_ALERTAR) {
    await avisar(`⏳ Disparo do CRM SEM ANDAR — ${slug}\nMotivo: ${n} rodadas seguidas só com pessoas adiadas (${r.adiados} agora). Costuma ser o CRM (Chatwoot) fora do ar ou com token caído, ou a franquia fora.\nO que fazer: conferir o CRM e o token da conta da unidade; a onda continua aprovada e retoma sozinha quando voltar.`).catch(() => undefined);
  }
}

/** Uma rodada das ondas aprovadas da origem CRM. Os freios, a janela e a parada por SAIR são os do motor (`rodarUnidade`). */
export async function rodadaDoDisparoNoCrm(): Promise<void> {
  void varrerSeChegouAHora(); // à parte: a varredura é lenta e não pode atrasar o envio nem a rodada do Kommo
  const ondas = await prisma.disparoOnda.findMany({ where: { estado: 'aprovada', origem: ORIGEM_CRM }, orderBy: { criadoEm: 'asc' }, include: { unit: true } });
  if (ondas.length === 0) return;
  // onda do CRM sem caixa/conta não existe de verdade: pausa (e avisa no log) em vez de adiar a gente dela para sempre e travar a unidade
  const lixo = ondas.filter((o) => o.caixaChatwoot == null || o.contaChatwoot == null);
  if (lixo.length) {
    await prisma.disparoOnda.updateMany({ where: { id: { in: lixo.map((o) => o.id) }, estado: 'aprovada' }, data: { estado: 'pausada', pausaMotivo: 'onda do CRM sem caixa ou conta gravada: monte o disparo de novo', pausaCausa: 'falhas' } });
    logger.error({ ondas: lixo.map((o) => o.id) }, 'disparo-crm: onda aprovada sem caixa/conta — pausada');
  }
  const boas = ondas.filter((o) => !lixo.includes(o));
  if (boas.length === 0) return;
  const unidades = new Map<string, Unit>(boas.map((o) => [o.unitId, o.unit]));
  const info = new Map<string, OndaDaRodada>(
    boas.map((o) => [o.id, { caixa: o.caixaChatwoot!, conta: o.contaChatwoot!, template: o.template, idioma: o.idioma, textoModelo: o.textoModelo, variaveis: (o.variaveis as unknown[]).map(String) }]),
  );
  const porto = portoChatwoot({ base: portoReal(unidades), unidades, ondas: info });
  const f = freiosDoAmbiente();

  for (const unitId of new Set(boas.map((o) => o.unitId))) {
    const deste = boas.filter((o) => o.unitId === unitId);
    const unit = deste[0]!.unit;
    const vivas = await prisma.disparoOnda.findMany({ where: { id: { in: deste.map((o) => o.id) }, estado: 'aprovada' }, orderBy: { criadoEm: 'asc' }, include: { campanha: { select: { nome: true } } } });
    if (vivas.length === 0) continue;
    try {
      const noLote: OndaNoLote[] = vivas.map((o) => ({ id: o.id, campanhaId: o.campanhaId, campanhaNome: o.campanha.nome, aprovadaEm: o.aprovadaEm, aprovadaModo: o.aprovadaModo, sairAceitos: o.sairAceitos, ...definicaoDaOnda(o) }));
      const ajuste = await ajusteDaUnidade(unit.id);
      const r = await rodarUnidade(porto, freiosComOTier(f, ajuste.tierDoNumero), { id: unit.id, slug: unit.slug, nome: unit.name, fuso: fusoDaUnidade(unit) }, noLote);
      // 429 do Chatwoot: a pessoa volta para a fila (não é «adiado» para o motor), mas para o alerta de «sem andar» é uma rodada sem andar
      await avisarSeSemAndar(unit.slug, unit.id, porto.ocupouAUnidade(unit.id) ? { ...r, adiados: r.adiados + 1 } : r);
      if (r.processados > 0 || (r.parou && r.parou !== 'automação desligada nesta unidade')) logger.info({ unit: unit.slug, origem: ORIGEM_CRM, ...r }, 'disparo-crm: rodada');
    } catch (err) {
      logger.error({ err: String(err), unit: unit.slug }, 'disparo-crm: a rodada da unidade falhou');
    }
  }
}

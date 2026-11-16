/**
 * O `Porto` da ORIGEM «chatwoot»: o MESMO contrato do `Porto` do Kommo (`lote.ts`), trocando só o que é de lá —
 * quem enviou (a conversa do CRM, não a Graph API direta), o espelho (a própria mensagem na conversa), o SAIR (as mensagens do CRM) e o modo
 * (`chatwoot-disparo`). Os freios (`freios.ts`), a parada por SAIR, a trava do modo seco (`rodarUnidade`/`enviarUm`) e a checagem da
 * franquia são os do motor: nenhuma regra foi reescrita aqui — o que não é trocado vem de `portoReal`.
 *
 * COMO A MENSAGEM SAI (a mesma da régua, `chatDoChatwoot.mensagem`): `POST conversations/:id/messages` com `template_params`
 * (`name` + `language` + `processed_params.body`). O Chatwoot grava a mensagem NA conversa e a entrega pela caixa de WhatsApp oficial.
 * Só a caixa `Channel::Whatsapp` serve: confere na montagem, na aprovação e antes de cada envio (e a Clínica Demonstração, canal API, é recusada).
 */
import type { Unit } from '@prisma/client';
import { logger } from '../../logger.js';
import { estadoDaAutomacao } from '../../automacoes-estado.js';
import { chamar, contextoDaUnidade, contextoDoAmbiente, type ContextoChatwoot } from '../../../mcp-remoto/chatwoot.js';
import { CAIXAS_REGUA } from '../../chatwoot-regua.js';
import { paramsDoTemplate } from '../../chatwoot-regua-worker.js';
import { conferenciaDaFranquia } from '../franquia.js';
import { chaveDaPessoa, telefoneWhatsapp, textoFinal } from '../regras.js';
import { listaDeTesteDoAmbiente } from '../porto.js';
import type { Modo, Porto, VereditoExtra } from '../lote.js';
import type { ResultadoDoTemplate } from '../../whatsapp-meta.js';
import { caixaWhatsappOficial, conferirModeloDaOnda, type CaixaOficial, type ConferenciaDoModelo } from './canal.js';
import { idDaMensagem, ultimoPedidoDeSaidaDoContato } from './mensagens.js';
import { conversaDoPublico, situacaoPeloCrm, DIAS_SEM_REPETIR_DISPARO } from './publico.js';
import { ETIQUETA_SEM_FOLLOW_UP } from './filtro.js';
import { prisma } from '../../prisma.js';

/** O id desta automação no catálogo (`lib/automacoes.ts`). */
export const AUTOMACAO_DISPARO_CRM = 'chatwoot-disparo';

export const modoDoDisparoNoCrm = (slug: string, env: NodeJS.ProcessEnv = process.env): Modo =>
  estadoDaAutomacao(slug, AUTOMACAO_DISPARO_CRM, env.CHATWOOT_DISPARO_SLUGS);

/** O que o Porto precisa saber de cada onda da rodada (a caixa e a conta vêm do banco; o resto é o que a pessoa aprovou). */
export interface OndaDaRodada {
  caixa: number;
  conta: number;
  template: string;
  idioma: string;
  textoModelo: string;
  variaveis: string[];
}

export interface DepsDoPortoChatwoot {
  /** o Porto do Kommo: tudo o que não é trocado aqui vem dele (tetos, estados, pausas, fila, lista de teste) */
  base: Porto;
  unidades: ReadonlyMap<string, Unit>;
  ondas: ReadonlyMap<string, OndaDaRodada>;
  /** o contexto da CONTA da unidade (null = unidade sem conta/token válidos: não chama o Chatwoot) */
  ctxDaUnidade?: (slug: string) => ContextoChatwoot | null;
  caixaOficial?: typeof caixaWhatsappOficial;
  conferirModelo?: typeof conferirModeloDaOnda;
  conversa?: (ctx: ContextoChatwoot, id: number) => Promise<unknown>;
  pedidoDeSaida?: typeof ultimoPedidoDeSaidaDoContato;
  mandar?: (ctx: ContextoChatwoot, conversaId: number, corpo: Record<string, unknown>) => Promise<unknown>;
  franquiaDaUnidade?: typeof conferenciaDaFranquia;
  contarEnvios?: (unitIds: string[], desde: Date, modo: 'ligado' | 'seco') => Promise<number>;
  /** quantos envios (de OUTRA onda) a pessoa recebeu desde `desde` nesta unidade; `> 0` = recebeu disparo há pouco */
  recebeuDesde?: (unitId: string, chave: string, ondaId: string, desde: Date) => Promise<number>;
  agora?: () => Date;
}

const padraoCtx = (slug: string): ContextoChatwoot | null => {
  const base = contextoDoAmbiente();
  return base ? contextoDaUnidade(base, slug) : null;
};

const VALIDADE_MS = 5 * 60_000;

const recebeuDesdeNoBanco = (unitId: string, chave: string, ondaId: string, desde: Date): Promise<number> =>
  prisma.disparoDestinatario.count({ where: { unitId, chave, enviadoEm: { gte: desde }, estado: { in: ['enviando', 'enviado', 'falhou', 'saiu'] }, NOT: { ondaId } } });

/** O contador de rodadas com limite de taxa do CRM: uma chave própria (o do Kommo é o número da Graph API, outro número). */
export const chaveDoLimiteDoCrm = (unitId: string): string => `crm:${unitId}`;

export { idDaMensagem };

export function portoChatwoot(deps: DepsDoPortoChatwoot): Porto & { ocupouAUnidade(unitId: string): boolean } {
  const { base, unidades, ondas } = deps;
  const ctxDe = deps.ctxDaUnidade ?? padraoCtx;
  const oficial = deps.caixaOficial ?? caixaWhatsappOficial;
  const conferirModelo = deps.conferirModelo ?? conferirModeloDaOnda;
  const lerConversa = deps.conversa ?? ((ctx, id) => chamar(ctx, 'GET', `conversations/${id}`));
  const pedido = deps.pedidoDeSaida ?? ultimoPedidoDeSaidaDoContato;
  const mandar = deps.mandar ?? ((ctx, id, corpo) => chamar(ctx, 'POST', `conversations/${id}/messages`, { corpo }));
  const franquiaDe = deps.franquiaDaUnidade ?? conferenciaDaFranquia;
  const agora = deps.agora ?? (() => new Date());
  let chatwootOcupado = false;
  const unidadesOcupadas = new Set<string>();
  const franquias = new Map<string, ReturnType<typeof conferenciaDaFranquia>>();
  const caixas = new Map<string, { ate: number; v: Promise<CaixaOficial> }>();
  const modelos = new Map<string, { ate: number; v: Promise<ConferenciaDoModelo> }>();

  const unidade = (id: string): Unit => {
    const u = unidades.get(id);
    if (!u) throw new Error(`unidade ${id} fora da rodada`);
    return u;
  };
  const caixaOk = (ctx: ContextoChatwoot, slug: string, caixa: number): Promise<CaixaOficial> => {
    const k = `${slug}|${caixa}`;
    const feito = caixas.get(k);
    if (feito && feito.ate > agora().getTime()) return feito.v;
    const v = oficial(ctx, caixa);
    caixas.set(k, { ate: agora().getTime() + VALIDADE_MS, v });
    // leitura que falhou não fica guardada: tenta de novo na próxima pessoa
    v.catch(() => caixas.delete(k));
    return v;
  };

  const porto: Porto = {
    ...base,

    modoDaUnidade: (slug): Modo => modoDoDisparoNoCrm(slug),
    nomeDaListaDeTeste: 'CHATWOOT_DISPARO_LISTA_DE_TESTE',

    // A lista de teste do CRM é PRÓPRIA (`CHATWOOT_DISPARO_LISTA_DE_TESTE`): `slug=*` na do Kommo não solta o CRM, e a unidade que não está nela não recebe ninguém.
    listaDeTeste: (slug) => listaDeTesteDoAmbiente(slug, { DISPARO_LISTA_DE_TESTE: process.env.CHATWOOT_DISPARO_LISTA_DE_TESTE } as NodeJS.ProcessEnv),

    // Teto do NÚMERO do CRM (o número do Kapso da unidade): só o que saiu por esta origem. O disparo do Kommo usa outro número (o da Graph API).
    contarNaJanela: async (unitId, desde, modo) => {
      if (deps.contarEnvios) return deps.contarEnvios([unitId], desde, modo);
      const ids = await unidadesDoMesmoNumeroKapso(unitId);
      return prisma.disparoDestinatario.count({
        where: { unitId: { in: ids }, onda: { origem: 'chatwoot' }, ...(modo === 'ligado' ? { enviadoEm: { gte: desde } } : { simuladoEm: { gte: desde } }) },
      });
    },

    // Tudo o que conta, pausa ou zera é DESTA origem: o limite de taxa, a restrição e as falhas do CRM não pausam o Kommo (outro número), nem o contrário.
    // Ordena pelo MOMENTO DO ENVIO, não por `atualizadoEm`: a varredura (entregue/lida/respondeu) regrava `atualizadoEm` e uma falha recente
    // sumiria atrás de envios velhos que acabaram de ser lidos. A recusa definitiva (sem `enviadoEm`) entra pela hora em que foi decidida.
    ultimosResultados: async (unitId, n, desde) => {
      const base = { unitId, onda: { origem: 'chatwoot' }, estado: { in: ['enviado', 'falhou'] } };
      const [enviados, recusados] = await Promise.all([
        prisma.disparoDestinatario.findMany({ where: { ...base, enviadoEm: { gte: desde } }, orderBy: { enviadoEm: 'desc' }, take: n, select: { estado: true, enviadoEm: true } }),
        prisma.disparoDestinatario.findMany({ where: { ...base, estado: 'falhou', enviadoEm: null, atualizadoEm: { gte: desde } }, orderBy: { atualizadoEm: 'desc' }, take: n, select: { estado: true, atualizadoEm: true } }),
      ]);
      const quando = (x: { enviadoEm?: Date | null; atualizadoEm?: Date }): number => (x.enviadoEm ?? x.atualizadoEm)?.getTime() ?? 0;
      return [...enviados, ...recusados]
        .sort((a, b) => quando(b) - quando(a))
        .slice(0, n)
        .map((x) => (x.estado === 'enviado' ? 'enviado' : 'falhou'));
    },

    pausarOndas: async (unitId, campanhaId, motivo, causa) => {
      await prisma.disparoOnda.updateMany({
        where: { unitId, origem: 'chatwoot', estado: 'aprovada', ...(campanhaId ? { campanhaId } : {}) },
        data: { estado: 'pausada', pausaMotivo: motivo.slice(0, 300), pausaCausa: causa ?? null },
      });
    },

    limiteDeTaxa: async (unitId, houve) => {
      if (houve && chatwootOcupado) {
        chatwootOcupado = false;
        unidadesOcupadas.add(unitId);
        logger.warn({ unit: unidades.get(unitId)?.slug }, 'disparo-crm: o Chatwoot respondeu 429 (ocupado) — tento de novo na próxima rodada; não conta como limite da Meta');
        return 0;
      }
      const chave = chaveDoLimiteDoCrm(unitId);
      if (!houve) {
        await prisma.disparoLimite.deleteMany({ where: { unitId: chave } });
        return 0;
      }
      const linha = await prisma.disparoLimite.upsert({ where: { unitId: chave }, create: { unitId: chave, seguidas: 1 }, update: { seguidas: { increment: 1 } } });
      return linha.seguidas;
    },

    pausarNumero: async (unitId, motivo, causa) => {
      const ids = await unidadesDoMesmoNumeroKapso(unitId);
      const ondas = await prisma.disparoOnda.findMany({ where: { unitId: { in: ids }, origem: 'chatwoot', estado: 'aprovada' }, select: { id: true } });
      await prisma.disparoOnda.updateMany({ where: { id: { in: ondas.map((o) => o.id) }, estado: 'aprovada' }, data: { estado: 'pausada', pausaMotivo: motivo.slice(0, 300), pausaCausa: causa } });
      await prisma.disparoLimite.deleteMany({ where: { unitId: chaveDoLimiteDoCrm(unitId) } });
      const slugs = (await prisma.unit.findMany({ where: { id: { in: ids } }, select: { slug: true } })).map((u) => u.slug).sort();
      return { unidades: slugs, ondas: ondas.map((o) => o.id) };
    },

    // O SAIR de campanhas anteriores (banco). O das MENSAGENS do CRM está em `reconferir`, onde uma leitura que falha adia em vez de passar.
    pediuSair: (d) => base.pediuSair({ ...d, kommoLeadId: null }),

    async reconferir(d): Promise<VereditoExtra | null> {
      const onda = ondas.get(d.ondaId);
      const u = unidades.get(d.unitId);
      if (!onda || !u) return { tipo: 'adiar', motivo: 'a onda ou a unidade saiu da rodada' };
      const ctx = ctxDe(u.slug);
      if (!ctx?.conta || ctx.conta.conta !== onda.conta) return { tipo: 'barrou', estado: 'descartado', motivo: 'a conta do CRM da unidade não é a da onda' };
      if (CAIXAS_REGUA[onda.caixa] !== u.slug) return { tipo: 'barrou', estado: 'descartado', motivo: `a caixa ${onda.caixa} não é desta unidade` };
      if (d.conversaChatwoot == null) return { tipo: 'barrou', estado: 'descartado', motivo: 'destinatário sem conversa no CRM' };
      try {
        const c = await caixaOk(ctx, u.slug, onda.caixa);
        if (!c.ok) return { tipo: 'barrou', estado: 'descartado', motivo: c.motivo };
        // o modelo ainda está aprovado, com o texto que a pessoa viu? (a Meta pode pausar um modelo depois de aprovado)
        const kM = `${d.ondaId}`;
        let m = modelos.get(kM);
        if (!m || m.ate <= agora().getTime()) {
          m = { ate: agora().getTime() + VALIDADE_MS, v: conferirModelo(ctx, onda.caixa, onda) };
          modelos.set(kM, m);
        }
        const conf = await m.v;
        if (!conf.ok && conf.transitorio) {
          modelos.delete(kM);
          return { tipo: 'adiar', motivo: conf.motivo.slice(0, 200) };
        }
        if (!conf.ok) {
          // não é a pessoa: é a onda. Pausa (sem retomada: o modelo mudou, monte de novo) e adia esta.
          await base.pausarOnda(d.ondaId, `o modelo não confere mais com o CRM: ${conf.motivo}`.slice(0, 300), 'meta').catch(() => undefined);
          return { tipo: 'adiar', motivo: conf.motivo.slice(0, 200) };
        }
        let raw: any;
        try {
          raw = await lerConversa(ctx, d.conversaChatwoot);
        } catch (err) {
          if ((err as { status?: number })?.status === 404) return { tipo: 'barrou', estado: 'descartado', motivo: 'a conversa não existe mais no CRM (apagada ou mesclada)' };
          throw err;
        }
        const conv = conversaDoPublico(raw);
        if (!conv || Number(raw?.inbox_id) !== onda.caixa) return { tipo: 'barrou', estado: 'descartado', motivo: 'a conversa saiu da caixa da onda (ou virou grupo)' };
        const tel = telefoneWhatsapp(conv.telefone);
        if (!tel || chaveDaPessoa(tel) !== d.chave) return { tipo: 'barrou', estado: 'descartado', motivo: 'o telefone da conversa mudou desde que a lista foi montada' };
        if (conv.etiquetas.some((e) => e.trim().toLowerCase() === ETIQUETA_SEM_FOLLOW_UP)) return { tipo: 'barrou', estado: 'descartado', motivo: 'ganhou a etiqueta sem-follow-up depois da montagem' };
        if (conv.interno) return { tipo: 'barrou', estado: 'descartado', motivo: 'contato interno' };
        if (!u.spineToken) {
          const s = situacaoPeloCrm(conv.attrs);
          if (s !== 'livre') return { tipo: 'barrou', estado: 'descartado', motivo: `já é paciente pela etapa do CRM (${s})` };
        }
        // recebeu OUTRO disparo desde a montagem (a lista foi montada há horas; a regra dos 7 dias vale na hora de mandar, não só na montagem)
        const desde = new Date(agora().getTime() - DIAS_SEM_REPETIR_DISPARO * 86_400_000);
        if ((await (deps.recebeuDesde ?? recebeuDesdeNoBanco)(u.id, d.chave, d.ondaId, desde)) > 0) return { tipo: 'barrou', estado: 'descartado', motivo: `recebeu outro disparo nos últimos ${DIAS_SEM_REPETIR_DISPARO} dias` };
        // SAIR nas mensagens do CRM: a conversa do disparo e as outras do contato. Falha ao ler = adiar, nunca «não pediu».
        if (await pedido(ctx, d.conversaChatwoot, d.contatoChatwoot ?? conv.contatoId, 3)) return { tipo: 'barrou', estado: 'saiu', motivo: 'pediu para sair (SAIR) antes do envio' };
        return null;
      } catch (err) {
        logger.warn({ err: String(err), unit: u.slug, onda: d.ondaId }, 'disparo-crm: não consegui reconferir a conversa — adio');
        return { tipo: 'adiar', motivo: 'o CRM não respondeu à reconferência' };
      }
    },

    // Franquia: a MESMA conferência do Kommo (agenda e tratamentos), só que sem cartão: casa pelo nome inteiro e pelo telefone. Unidade sem
    // agenda: a conferência é a etapa do CRM, e já foi feita em `reconferir`.
    franquia: async (d) => {
      const u = unidade(d.unitId);
      if (!u.spineToken) return 'livre';
      let conferir = franquias.get(u.id);
      if (!conferir) franquias.set(u.id, (conferir = franquiaDe(u)));
      return conferir({ leadId: null, nomeCompleto: d.nomeCompleto, telefone: d.telefone });
    },

    // O ÚNICO envio da origem. `rodarUnidade` só chega aqui com o modo `ligado` (a trava do seco é a do motor).
    enviar: async (onda, d, valores): Promise<ResultadoDoTemplate> => {
      const recusa = (detalhe: string): ResultadoDoTemplate => ({ ok: false, wamid: null, detalhe, incerto: false });
      const info = ondas.get(onda.id);
      const u = unidades.get(d.unitId);
      if (!info || !u || d.conversaChatwoot == null) return recusa('onda ou conversa desconhecida');
      const ctx = ctxDe(u.slug);
      if (!ctx?.conta || ctx.conta.conta !== info.conta) return recusa('a unidade não tem a conta do CRM da onda');
      // a trava que vale mesmo se alguém chamar `enviar` sem passar por `reconferir`: só caixa WhatsApp oficial
      let c: CaixaOficial;
      try {
        c = await caixaOk(ctx, u.slug, info.caixa);
      } catch {
        return recusa('não consegui confirmar que a caixa é WhatsApp oficial');
      }
      if (!c.ok) return recusa(c.motivo);
      try {
        const r = (await mandar(ctx, d.conversaChatwoot, {
          content: textoFinal(onda.textoModelo, valores),
          message_type: 'outgoing',
          private: false,
          template_params: paramsDoTemplate({ nome: onda.template, idioma: onda.idioma, variaveis: valores }),
        })) as { id?: unknown } | null;
        const id = Number(r?.id);
        // sem o id da mensagem não há prova de que entrou: INCERTO (conta no teto e nunca é reenviada sozinha)
        if (!Number.isInteger(id) || id <= 0) return { ok: false, wamid: null, detalhe: 'o CRM não devolveu o id da mensagem', incerto: true };
        return { ok: true, wamid: `cw:${id}`, detalhe: { mensagem: id }, incerto: false };
      } catch (err) {
        const status = (err as { status?: number })?.status;
        const texto = String(err instanceof Error ? err.message : err).slice(0, 300);
        // 429 do PRÓPRIO Chatwoot: a pessoa volta para a fila e a rodada acaba (o motor trata como «esperar»), mas NÃO é limite da Meta —
        // `limiteDeTaxa` abaixo não soma rodadas para ele (senão pausaria o número e avisaria «a Meta pediu para esperar»)
        if (status === 429) {
          chatwootOcupado = true;
          return { ok: false, wamid: null, detalhe: texto, incerto: false, limiteDeTaxa: true };
        }
        // 4xx: o CRM RECUSOU (não entrou). Sem resposta ou 5xx: pode ter entrado — INCERTO, nunca reenvia sozinho.
        return { ok: false, wamid: null, detalhe: texto, incerto: !(status !== undefined && status >= 400 && status < 500) };
      }
    },

    // A mensagem aparece na própria conversa do CRM: não há "nota no cartão" a deixar (e uma nota privada contaria como atividade).
    espelhar: async () => undefined,
    linkDoPainel: () => null,
  };
  // O 429 do Chatwoot não conta como «adiado» no resumo do motor (ele acaba a rodada como «esperar»); quem chama usa isto para contá-lo: sem isso um 429 repetido
  // deixava a onda parada sem o alerta de «sem andar».
  return Object.assign(porto, { ocupouAUnidade: (unitId: string): boolean => unidadesOcupadas.has(unitId) });
}

/** As unidades que usam o MESMO número do Kapso (o teto é do número). Sem número cadastrado, só a própria. */
export async function unidadesDoMesmoNumeroKapso(unitId: string): Promise<string[]> {
  const eu = await prisma.unitChatwoot.findUnique({ where: { unitId }, select: { kapsoPhoneNumberId: true } });
  const numero = eu?.kapsoPhoneNumberId?.trim();
  if (!numero) return [unitId];
  const todas = await prisma.unitChatwoot.findMany({ where: { kapsoPhoneNumberId: numero }, select: { unitId: true } });
  return [...new Set([unitId, ...todas.map((t) => t.unitId)])];
}

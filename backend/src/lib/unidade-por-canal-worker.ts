/**
 * Marca no cartão a unidade de atendimento — Petrópolis × Caxias no mesmo Kommo. Regras em `unidade-por-canal.ts`
 * (anúncio pela conta de anúncios → DDD → vazio para a SDR; o robô corrige a si mesmo, nunca a SDR).
 *
 * A cada 5 minutos lê as conversas da conta (as mais novas primeiro), junta os cartões, e marca o campo
 * "⌂ Unidade de atendimento" e a etiqueta da cidade. Não depende da Sofia: a unidade pode ainda não ter IA.
 *
 * Chave `unidade-por-canal` na tela de Automações: desligado não faz nada; "só no papel" registra o que
 * gravaria/corrigiria na lista "o que ela faria"; ligado grava.
 */
import { prisma } from './prisma.js';
import { logger } from './logger.js';
import { createKommoClient, type KommoClient, type KommoLead } from '../services/kommo.service.js';
import { estadoDaAutomacao } from './automacoes-estado.js';
import { registrarSimulacao } from './so-no-papel.js';
import { contaDoAnuncio } from './conta-do-anuncio.js';
import { normalizarNome } from './kommo-schema.js';
import {
  CAMPO_UNIDADE,
  CAMPOS_ANUNCIO,
  REGRAS_POR_UNIDADE,
  dddDe,
  decidirUnidade,
  etiquetaDe,
  etiquetasSobrando,
  planejarUnidade,
  roboCorrige,
  type RegrasDaUnidade,
} from './unidade-por-canal.js';

const SWEEP_MS = 5 * 60_000;
const PRIMEIRA_VARREDURA_MS = 90_000;
/** 4 páginas de 250 conversas cobrem com folga o movimento de 5 minutos e o histórico de Petrópolis. */
const MAX_PAGINAS = 4;
const PAUSA_ENTRE_ESCRITAS_MS = 300;
/** Quem pôs o valor do campo: pessoa não muda à toa (6 h); "foi o robô" vale pouco (10 min), pra uma SDR que
 *  mexer nesse meio tempo não ser atropelada; falha ao perguntar não vai pro cache. */
const AUTOR_HUMANO_TTL_MS = 6 * 60 * 60_000;
const AUTOR_ROBO_TTL_MS = 10 * 60_000;

let timer: NodeJS.Timeout | null = null;
let primeira: NodeJS.Timeout | null = null;
let rodando = false;

const pausa = () => new Promise((r) => setTimeout(r, PAUSA_ENTRE_ESCRITAS_MS));
const autores = new Map<string, { autor: number; ate: number }>();

async function autorDoCampo(kommo: KommoClient, slug: string, leadId: number, fieldId: number): Promise<number | undefined> {
  const chave = `${slug}:${leadId}`;
  const hit = autores.get(chave);
  if (hit && hit.ate > Date.now()) return hit.autor;
  autores.delete(chave);
  const autor = await kommo.autorDaUltimaMudancaDoCampo(leadId, fieldId);
  if (autor !== undefined) autores.set(chave, { autor, ate: Date.now() + (autor === 0 ? AUTOR_ROBO_TTL_MS : AUTOR_HUMANO_TTL_MS) });
  return autor;
}

function valor(v: unknown): string | null {
  return v === undefined || v === null || String(v).trim() === '' ? null : String(v).trim();
}

/** Campo pelo id (o da unidade, que o robô já conhece). */
function valorPorId(lead: KommoLead, fieldId: number): string | null {
  return valor(lead.custom_fields_values?.find((f) => f.field_id === fieldId)?.values?.[0]?.value);
}

/** Campo pelo nome, sem ligar pra acento/símbolo (os de anúncio, gravados pelo rastreio). */
function valorPorNome(lead: KommoLead, nome: string): string | null {
  const alvo = normalizarNome(nome);
  return valor(lead.custom_fields_values?.find((f) => normalizarNome(f.field_name ?? '') === alvo)?.values?.[0]?.value);
}

function contatoPrincipal(lead: KommoLead): number | null {
  const cs = lead._embedded?.contacts ?? [];
  return (cs.find((c) => c.is_main) ?? cs[0])?.id ?? null;
}

/**
 * O anúncio que decide e a conta dele: tenta o "ID do anúncio" e depois o "Último anúncio", parando no primeiro
 * de conta conhecida. `incerto` = a Meta falhou em algum e nenhum se resolveu — não decida pelo DDD nesta rodada.
 */
async function anuncioDoCartao(lead: KommoLead, regras: RegrasDaUnidade, token: string | null | undefined) {
  const anuncios = CAMPOS_ANUNCIO.map((n) => valorPorNome(lead, n)).filter((v): v is string => v !== null);
  let incerto = false;
  for (const anuncio of anuncios) {
    const conhecida = regras.anunciosConhecidos[anuncio];
    if (conhecida) return { anuncio, conta: conhecida, incerto: false };
    const r = await contaDoAnuncio(anuncio, token);
    if (r.conta && regras.contasDeAnuncio[r.conta]) return { anuncio, conta: r.conta, incerto: false };
    if (r.falhou) incerto = true;
  }
  return { anuncio: anuncios[0] ?? null, conta: null, incerto };
}

async function varrerUnidade(slug: string, regras: RegrasDaUnidade): Promise<void> {
  const estado = estadoDaAutomacao(slug, 'unidade-por-canal', process.env.UNIDADE_POR_CANAL_SLUGS);
  if (estado === 'desligado') return;
  const seco = estado === 'seco';

  const unit = await prisma.unit.findUnique({ where: { slug } });
  if (!unit?.kommoAccessToken) return;
  const kommo = createKommoClient(unit);

  const campos = await kommo.listLeadCustomFieldsTyped();
  const campo = campos.find((f) => f.name === CAMPO_UNIDADE);
  if (!campo) {
    logger.warn({ unit: slug }, `unidade-por-canal: a conta não tem o campo "${CAMPO_UNIDADE}"`);
    return;
  }

  const conversas = await kommo.listarConversas(MAX_PAGINAS);
  const ids = [...new Set(conversas.filter((t) => t.entity_type === 'lead' && t.entity_id).map((t) => t.entity_id as number))];
  if (ids.length === 0) return;

  const leads = await kommo.listLeadsPorIds(ids, { contatos: true });
  const telefones = await kommo.telefonesDosContatos(leads.map(contatoPrincipal).filter((x): x is number => x !== null));
  const resumo = { gravados: 0, corrigidos: 0, confere: 0, diverge: 0, semRegra: 0, adiados: 0, erros: 0 };

  for (const lead of leads) {
    const noCartao = valorPorId(lead, campo.id);
    const etiquetas = (lead._embedded?.tags ?? []).map((t) => t.name);
    const { anuncio, conta, incerto } = await anuncioDoCartao(lead, regras, unit.metaAccessToken);
    if (incerto) {
      resumo.adiados++;
      continue;
    }
    const contato = contatoPrincipal(lead);
    const ddd = dddDe(contato !== null ? telefones.get(contato) : null);

    const decisao = decidirUnidade({ anuncio, contaDoAnuncio: conta, ddd, regras });
    const plano = planejarUnidade({ decisao, noCartao, etiquetas });
    if (!plano) {
      resumo.semRegra++;
      continue;
    }
    const enumDe = (unidade: string) => campo.enums?.find((e) => normalizarNome(e.value) === normalizarNome(unidade))?.id ?? null;

    if (plano.acao === 'diverge' && roboCorrige(plano, decisao, await autorDoCampo(kommo, slug, lead.id, campo.id))) {
      const enumId = enumDe(plano.unidade);
      if (enumId === null) {
        logger.warn({ unit: slug, unidade: plano.unidade }, `unidade-por-canal: o campo não tem a opção "${plano.unidade}"`);
        continue;
      }
      if (seco) {
        // "gravaria" com o valor atual preenchido = trocaria o que o robô pôs (a lista da tela não tem ação própria pra isso)
        registrarSimulacao(unit, 'unidade-por-canal', { leadId: lead.id, acao: 'gravaria', alvo: CAMPO_UNIDADE, valor: plano.unidade, noCartao: plano.noCartao, motivo: `corrige o robô: ${plano.motivo}` });
        continue;
      }
      try {
        await kommo.atualizarCampoEEtiquetas(lead.id, {
          campo: { fieldId: campo.id, enumId },
          adicionar: [etiquetaDe(plano.unidade)],
          remover: etiquetasSobrando(plano.unidade, etiquetas, regras),
        });
        autores.delete(`${slug}:${lead.id}`);
        resumo.corrigidos++;
        logger.info({ unit: slug, leadId: lead.id, de: plano.noCartao, para: plano.unidade, motivo: plano.motivo }, 'unidade-por-canal: corrigi o que o robô tinha marcado');
      } catch (err) {
        resumo.erros++;
        logger.warn({ err: String(err), unit: slug, leadId: lead.id }, 'unidade-por-canal: falha ao corrigir');
      }
      await pausa();
      continue;
    }

    if (plano.acao !== 'gravar') {
      resumo[plano.acao]++;
      registrarSimulacao(unit, 'unidade-por-canal', { leadId: lead.id, acao: plano.acao, alvo: CAMPO_UNIDADE, valor: plano.unidade, noCartao: plano.noCartao, motivo: plano.motivo });
      // a etiqueta acompanha o campo: põe a que falta e tira a da outra cidade, mesmo quando o campo já estava preenchido
      const sobrando = etiquetasSobrando(plano.noCartao, etiquetas, regras);
      if ((plano.etiqueta || sobrando.length) && !seco) {
        await kommo
          .atualizarCampoEEtiquetas(lead.id, { adicionar: plano.etiqueta ? [plano.etiqueta] : [], remover: sobrando })
          .catch((err) => {
            resumo.erros++;
            logger.warn({ err: String(err), unit: slug, leadId: lead.id }, 'unidade-por-canal: falha ao acertar a etiqueta');
          });
        await pausa();
      }
      continue;
    }

    if (seco) {
      registrarSimulacao(unit, 'unidade-por-canal', { leadId: lead.id, acao: 'gravaria', alvo: CAMPO_UNIDADE, valor: plano.unidade, motivo: plano.motivo });
      continue;
    }
    try {
      const enumId = enumDe(plano.unidade);
      if (enumId === null) throw new Error(`o campo não tem a opção "${plano.unidade}"`);
      await kommo.atualizarCampoEEtiquetas(lead.id, {
        campo: { fieldId: campo.id, enumId },
        adicionar: [plano.etiqueta],
        remover: etiquetasSobrando(plano.unidade, etiquetas, regras),
      });
      resumo.gravados++;
      logger.info({ unit: slug, leadId: lead.id, unidade: plano.unidade, motivo: plano.motivo }, 'unidade-por-canal: unidade marcada');
    } catch (err) {
      resumo.erros++;
      logger.warn({ err: String(err), unit: slug, leadId: lead.id }, 'unidade-por-canal: falha ao marcar');
    }
    await pausa();
  }
  if (resumo.gravados || resumo.corrigidos || resumo.diverge || resumo.adiados || resumo.erros) logger.info({ unit: slug, seco, ...resumo }, 'unidade-por-canal: varredura');
}

async function varrer(): Promise<void> {
  if (rodando) return;
  rodando = true;
  try {
    for (const [slug, regras] of Object.entries(REGRAS_POR_UNIDADE)) {
      await varrerUnidade(slug, regras).catch((err) => logger.warn({ err: String(err), unit: slug }, 'unidade-por-canal: varredura falhou'));
    }
  } finally {
    rodando = false;
  }
}

export function startUnidadePorCanalWorker(): void {
  if (timer) return;
  primeira = setTimeout(() => void varrer(), PRIMEIRA_VARREDURA_MS);
  timer = setInterval(() => void varrer(), SWEEP_MS);
  logger.info('unidade-por-canal: worker iniciado');
}

export function stopUnidadePorCanalWorker(): void {
  if (primeira) clearTimeout(primeira);
  if (timer) clearInterval(timer);
  primeira = null;
  timer = null;
}

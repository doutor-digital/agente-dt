/**
 * O sinal da Sofia 2.0 por LINK DA INFINITEPAY (`SOFIA_SINAL_VIA_<UNIDADE>=infinitepay`, ver sinal-via.ts). O link é criado pela MESMA função do conector do claude.ai
 * (`criarLink` de mcp-remoto/infinitepay-escrita.ts), com o MESMO estado do servidor (infinitepay-servidor.ts): mesmos tetos por link e por dia, mesmo limite por hora,
 * mesma trava de uma criação por vez, a intenção gravada antes da chamada, o aviso assinado de pagamento e o /payment_check com o valor conferido antes de dar `pago`.
 * A reserva, o «um link por consulta», o reaproveitamento do link aberto e o teto de links do dia são os de `gerarSinalPix` (sinal-pix.ts): este arquivo só cria o link.
 *
 * O que a página de pagamento já traz: nome e telefone do paciente (do contato do cartão que a Sofia está atendendo) e, nas opções, sem pedir endereço de entrega.
 * CPF: a InfinitePay não tem esse campo no link e a Sofia não o coleta; quem precisar dele (a nota fiscal) o pede ao paciente depois do pagamento.
 * Nada daqui vai para o log: nem nome, nem telefone, nem CPF.
 */
import { randomBytes } from 'node:crypto';
import type { KommoClient } from '../services/kommo.service.js';
import { logger } from './logger.js';
import { criarLink, LinkIncertoInfinitepay } from '../mcp-remoto/infinitepay-escrita.js';
import { mascararPii } from './pii.js';
import type { ClienteDoLink } from './integracoes/infinitepay.js';
import { infinitepayDoServidor } from './infinitepay-servidor.js';
import { depsReais, LinkIncertoDoSinal, type CriadorDeLinkDoSinal, type DepsDoSinal } from './sinal-pix.js';
import { sinalViaDaUnidade } from './sinal-via.js';

const AGUARDA_CONTATO_MS = 6_000;

/** O nome que vai para a página: letras, espaço, ponto, apóstrofo e hífen. «Lead 123», emoji sozinho e nome de uma letra não são nome. */
export function nomeParaAPagina(bruto: string | null | undefined): string | undefined {
  const t = (bruto ?? '').normalize('NFC').replace(/[^\p{L} .'-]/gu, ' ').replace(/\s+/g, ' ').trim();
  if (t.length < 2 || /^lead\b/i.test(bruto?.trim() ?? '')) return undefined;
  return t.slice(0, 60);
}

/** "(66) 99999-1234", "5566999991234" → "+5566999991234"; o que não tem DDD + 8/9 dígitos fica de fora. */
export function telefoneParaAPagina(bruto: string | null | undefined): string | undefined {
  let d = (bruto ?? '').replace(/\D/g, '');
  if ((d.length === 12 || d.length === 13) && d.startsWith('55')) d = d.slice(2);
  return d.length === 10 || d.length === 11 ? `+55${d}` : undefined;
}

/** Nome e telefone do contato principal do cartão. Qualquer falha ou demora = sem dados (a página pede; o sinal não espera por isso). */
export async function clienteDoCartao(kommo: Pick<KommoClient, 'getLead' | 'getContactBasico'>, leadId: number): Promise<ClienteDoLink> {
  const ler = async (): Promise<ClienteDoLink> => {
    const lead = await kommo.getLead(leadId);
    const contatos = lead._embedded?.contacts ?? [];
    const id = (contatos.find((c) => c.is_main) ?? contatos[0])?.id;
    if (!id) return {};
    const c = await kommo.getContactBasico(id);
    const nome = nomeParaAPagina(c.nome);
    const telefone = telefoneParaAPagina(c.telefone);
    return { ...(nome ? { nome } : {}), ...(telefone ? { telefone } : {}) };
  };
  let espera: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([ler(), new Promise<ClienteDoLink>((r) => (espera = setTimeout(() => r({}), AGUARDA_CONTATO_MS)))]);
  } catch {
    return {};
  } finally {
    clearTimeout(espera);
  }
}

const diasEntre = (de: string, ate: string): number => Math.round((Date.parse(`${ate}T00:00:00Z`) - Date.parse(`${de}T00:00:00Z`)) / 86_400_000);

/** "2026-11-30T08:00" → "30/11 08:00". */
const quandoCurto = (iso: string | null): string => (iso && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(iso) ? `${iso.slice(8, 10)}/${iso.slice(5, 7)} ${iso.slice(11, 16)}` : '');

/**
 * A descrição aparece na tela de pagamento (sem CPF/telefone: `descricaoLimpa` recusa, e um id de cartão de 10 dígitos pareceria telefone: por isso o «ref» é o id em base 36). O «ref» (o cartão) deixa cada paciente com um texto só seu: o conector recusa
 * link IGUAL (mesmo valor e descrição) feito há menos de 10 minutos, e dois pacientes marcando juntos têm o mesmo valor.
 */
export function descricaoDoSinal(nomeDaClinica: string, consultaEm: string | null, leadId: number): string {
  const quando = quandoCurto(consultaEm);
  return `Sinal da consulta - Doutor Hérnia ${nomeDaClinica}${quando ? ` - ${quando}` : ''} - ref ${leadId.toString(36).toUpperCase()}`.slice(0, 120);
}

export interface DepsDoCriador {
  servidor?: typeof infinitepayDoServidor;
  criar?: typeof criarLink;
  cliente?: (leadId: number) => Promise<ClienteDoLink>;
}

/** O criador que `gerarSinalPix` chama (`deps.infinitepay`). Lança em qualquer falha: quem chama cai no Pix do Asaas. */
export function criadorDeLinkDoSinal(kommo: Pick<KommoClient, 'getLead' | 'getContactBasico'> | undefined, d: DepsDoCriador = {}): CriadorDeLinkDoSinal {
  return async (p) => {
    const srv = (d.servidor ?? infinitepayDoServidor)();
    if (!srv) throw new Error('a InfinitePay deste servidor ainda não foi carregada');
    const cliente = d.cliente ? await d.cliente(p.leadId) : kommo ? await clienteDoCartao(kommo, p.leadId) : {};
    // vale até o fim do dia do vencimento do sinal (a véspera da consulta); a API não cancela link, então ele PRECISA vencer
    // (a API conta validade em dias inteiros, no mínimo 1: o link pode valer até o dia SEGUINTE ao pedido; quem manda é o `validoAte` que o `criarLink` devolve, e é ele que vira o `venceEm` do sinal)
    const validadeDias = Math.min(90, Math.max(1, diasEntre(p.hoje, p.venceEm)));
    const pedido = {
      unidade: p.slug,
      valor: p.valorCentavos / 100,
      descricao: descricaoDoSinal(p.nomeDaClinica, p.consultaEm, p.leadId),
      validadeDias,
    };
    const criar = d.criar ?? criarLink;
    const referencia = () => `sinal-${p.leadId.toString(36)}-${randomBytes(4).toString('hex')}`;
    const quem = { id: 'sofia-sinal' };
    const levaNomeOuTelefone = !!(cliente.nome || cliente.telefone);
    const tentar = async (comExtras: boolean) => {
      try {
        return await criar(srv.ctx, srv.esc, quem, { ...pedido, origem: 'sofia', referencia: referencia(), ...(comExtras ? { ...(levaNomeOuTelefone ? { cliente } : {}), semEndereco: true } : {}) });
      } catch (err) {
        // criação sem resposta clara: o link PODE existir. Sobe com a referência para o sinal não cair em outra forma de cobrança (ver LinkIncertoDoSinal).
        if (err instanceof LinkIncertoInfinitepay) throw new LinkIncertoDoSinal(err.message, err.orderNsu);
        throw err;
      }
    };
    let r;
    try {
      r = await tentar(true);
    } catch (err) {
      // A InfinitePay RECUSOU o pedido (400/422): pode ser ela não aceitar nome/telefone ou a opção de endereço (o pedido sempre leva ao menos esta). Tenta UMA vez sem eles antes de desistir, para o
      // campo extra nunca tirar o sinal da InfinitePay. Outra falha (timeout/5xx, chave, nosso teto ou portão) não repete.
      if (!(err instanceof Error) || err instanceof LinkIncertoDoSinal || !/^a InfinitePay respondeu (400|422)\b/.test(err.message)) throw err;
      logger.warn({ unit: p.slug, motivo: mascararPii(err.message).slice(0, 200) }, 'sinal-infinitepay: a InfinitePay recusou o pedido com nome/telefone — tento de novo sem eles');
      r = await tentar(false);
    }
    return { url: r.url, orderNsu: r.orderNsu, venceEm: r.validoAte.slice(0, 10) };
  };
}

/**
 * As dependências de `gerarSinalPix` para a unidade: SÓ com `sinalVia = infinitepay` ganham o criador do link da InfinitePay (e só no Kommo: a conversa do Chatwoot,
 * sem cartão para ler nome e telefone e com a baixa pelo etiqueta, segue no Asaas). `undefined` = o Pix do Asaas de sempre, byte a byte.
 */
export function depsDoSinalPorVia(
  slug: string,
  o: { kommo?: Pick<KommoClient, 'getLead' | 'getContactBasico'> | undefined; conversaGarantida?: boolean },
  e: NodeJS.ProcessEnv = process.env,
): DepsDoSinal | undefined {
  if (o.conversaGarantida || !o.kommo || sinalViaDaUnidade(slug, e) !== 'infinitepay') return undefined;
  return { ...depsReais(), infinitepay: criadorDeLinkDoSinal(o.kommo) };
}

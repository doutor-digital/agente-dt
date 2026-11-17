/**
 * Retroativo do anúncio no CRM (Chatwoot): conversas da caixa de WhatsApp oficial cujo referral JÁ está na mensagem do Chatwoot mas nunca foi
 * guardado — ficaram sem etiqueta `anuncio`, sem a nota «Veio do anúncio» e sem Origem/Campanha/Conjunto no contato.
 *
 * Por que existe (17/11/2026): desde 14/11 o Chatwoot passou a trazer `content_attributes.referral`, e o servidor entendia isso como «nada a
 * buscar» e não fazia nada (4 conversas de anúncio entre 14 e 16/11, 0 etiquetas). O conserto vale daqui para frente; isto aqui é o passado.
 *
 * Faz exatamente o caminho do webhook (`aplicarReferralDoKapso` + `aoAcharReferral`): guarda a linha `kapso-referral` (idempotente), etiqueta,
 * deixa a nota (só se a linha é nova) e preenche a Origem (respeita o modo da automação `chatwoot-origem`: desligado/seco não grava).
 * Conversa cuja mensagem JÁ está guardada é pulada. A saída não tem nome nem telefone: só conversa, data, id do anúncio e o que faria/fez.
 *
 *   node dist/scripts/referral-do-crm-retroativo.js --so-conferir            # só lista (não grava nada)
 *   node dist/scripts/referral-do-crm-retroativo.js                          # aplica
 *   opções: --dias=10  --caixa=3
 */
import { prisma } from '../lib/prisma.js';
import { aplicarReferralDoKapso, referralDoChatwoot, REGRA_KAPSO_REFERRAL } from '../lib/kapso-referral.js';
import { aoAcharReferral, estadoDoReceptor } from '../lib/chatwoot-ia.js';
import { chamar, contextoDaCaixa, contextoDoAmbiente, type ContextoChatwoot } from '../mcp-remoto/chatwoot.js';

const SO_CONFERIR = process.argv.includes('--so-conferir');
const arg = (nome: string) => (process.argv.find((a) => a.startsWith(`--${nome}=`)) ?? '').split('=')[1] ?? '';
const DIAS = Number(arg('dias')) || 10;
const CAIXA = Number(arg('caixa')) || 3;
const MAX_PAGINAS_DE_CONVERSAS = 60;
const MAX_PAGINAS_DE_MENSAGENS = 15;

const dia = (seg: number) => new Date(seg * 1000).toISOString().slice(0, 10);

async function conversasRecentes(ctx: ContextoChatwoot, desde: number): Promise<Array<{ id: number; contato: number | null }>> {
  const achadas: Array<{ id: number; contato: number | null }> = [];
  for (let pagina = 1; pagina <= MAX_PAGINAS_DE_CONVERSAS; pagina++) {
    const r = (await chamar(ctx, 'GET', 'conversations', { query: { inbox_id: String(CAIXA), status: 'all', assignee_type: 'all', page: String(pagina) } })) as {
      data?: { payload?: any[] };
      payload?: any[];
    } | null;
    const lista = r?.data?.payload ?? r?.payload ?? [];
    if (!Array.isArray(lista) || lista.length === 0) break;
    // vêm da atividade mais nova para a mais antiga: página inteira fora da janela = acabou
    let algumaNaJanela = false;
    for (const c of lista) {
      if (Number(c?.last_activity_at) < desde) continue;
      algumaNaJanela = true;
      const id = Number(c?.id);
      const contato = Number(c?.meta?.sender?.id);
      if (Number.isInteger(id) && id > 0) achadas.push({ id, contato: Number.isInteger(contato) && contato > 0 ? contato : null });
    }
    if (!algumaNaJanela) break;
  }
  return achadas;
}

/** Mensagens de paciente da janela que trazem referral, com o wamid. */
async function referraisDaConversa(ctx: ContextoChatwoot, conversa: number, desde: number) {
  const saida: Array<{ wamid: string; ref: NonNullable<ReturnType<typeof referralDoChatwoot>>; criadaEm: number }> = [];
  let antes: number | undefined;
  for (let i = 0; i < MAX_PAGINAS_DE_MENSAGENS; i++) {
    const r = (await chamar(ctx, 'GET', `conversations/${conversa}/messages`, { query: antes ? { before: String(antes) } : {} })) as { payload?: any[] } | null;
    const lista = Array.isArray(r?.payload) ? r.payload : [];
    if (lista.length === 0) break;
    for (const m of lista) {
      if (Number(m?.message_type) !== 0 || m?.private === true) continue;
      const criadaEm = Number(m?.created_at);
      if (!(criadaEm >= desde)) continue;
      const wamid = String(m?.source_id ?? '');
      if (!/^wamid\.[A-Za-z0-9_=+/-]{10,400}$/.test(wamid)) continue;
      const ref = referralDoChatwoot(m?.content_attributes?.referral, criadaEm);
      if (ref) saida.push({ wamid, ref, criadaEm });
    }
    const primeiro = Math.min(...lista.map((m) => Number(m?.id) || Infinity));
    const maisAntiga = Math.min(...lista.map((m) => Number(m?.created_at) || Infinity));
    if (!Number.isFinite(primeiro) || (antes !== undefined && primeiro >= antes) || maisAntiga < desde) break;
    antes = primeiro;
  }
  return saida;
}

async function main() {
  const base = contextoDoAmbiente();
  const ctx = base ? contextoDaCaixa(base, CAIXA) : null;
  const conta = ctx?.conta?.conta;
  if (!ctx || !conta) throw new Error(`o Chatwoot não está configurado para a caixa ${CAIXA} neste servidor`);
  const estado = SO_CONFERIR ? null : estadoDoReceptor(conta);
  if (!SO_CONFERIR && !estado) throw new Error(`a conta ${conta} não tem estado da IA (sem unidade/token): não aplico`);

  const desde = Math.floor(Date.now() / 1000) - DIAS * 86_400;
  const conversas = await conversasRecentes(ctx, desde);
  console.log(`caixa ${CAIXA}: ${conversas.length} conversas com atividade nos últimos ${DIAS} dias — ${SO_CONFERIR ? 'SÓ CONFERIR (nada é gravado)' : 'APLICANDO'}`);

  const cont = { comReferral: 0, jaGuardado: 0, faltava: 0, aplicado: 0, falhou: 0 };
  for (const c of conversas) {
    let achados;
    try {
      achados = await referraisDaConversa(ctx, c.id, desde);
    } catch (err) {
      cont.falhou++;
      console.log(`ERRO   conversa ${c.id}: não consegui ler as mensagens (${err instanceof Error ? err.message.slice(0, 120) : 'erro'})`);
      continue;
    }
    for (const a of achados) {
      cont.comReferral++;
      const guardado = await prisma.chatwootReguaDisparo.findFirst({ where: { caixa: CAIXA, conversationId: c.id, regra: REGRA_KAPSO_REFERRAL, chave: a.wamid.slice(0, 190) }, select: { id: true } });
      const quem = `conversa ${c.id}  ${dia(a.criadaEm)}  anúncio ${a.ref.anuncio ?? '-'}  tipo ${a.ref.tipo ?? '-'}  ctwa_clid ${a.ref.ctwaClid ? 'sim' : 'não'}`;
      if (guardado) {
        cont.jaGuardado++;
        console.log(`ok     ${quem}  (já guardado)`);
        continue;
      }
      cont.faltava++;
      if (SO_CONFERIR) {
        console.log(`FALTA  ${quem}  (guardaria + etiqueta + nota + origem)`);
        continue;
      }
      const r = await aplicarReferralDoKapso({ conversa: c.id, caixa: CAIXA, wamid: a.wamid, contato: c.contato, referral: a.ref }, { aoAchar: aoAcharReferral(estado) });
      if (r === 'guardado') cont.aplicado++;
      else cont.falhou++;
      console.log(`${r === 'guardado' ? 'FEITO ' : 'FALHOU'} ${quem}`);
    }
  }
  console.log('\nresumo:', cont, SO_CONFERIR ? '(nada foi gravado: rode sem --so-conferir para aplicar)' : '');
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());

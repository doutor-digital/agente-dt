/**
 * Retroativo do anúncio no CRM (Chatwoot): conversas da caixa de WhatsApp oficial cujo referral JÁ está na mensagem do Chatwoot mas nunca foi
 * guardado — ficaram sem etiqueta `anuncio`, sem a nota «Veio do anúncio» e sem Origem/Campanha/Conjunto no contato.
 *
 * Por que existe (17/11/2026): desde 14/11 o Chatwoot passou a trazer `content_attributes.referral`, e o servidor entendia isso como «nada a
 * buscar» e não fazia nada (4 conversas de anúncio entre 14 e 16/11, 0 etiquetas). O conserto vale daqui para frente; isto aqui é o passado.
 *
 * Faz exatamente o caminho do webhook (`aplicarReferralDoKapso` + `aoAcharReferral`): guarda a linha `kapso-referral` (idempotente), etiqueta,
 * deixa a nota (só se a linha é nova) e preenche a Origem (respeita o modo da automação `chatwoot-origem`, lido da TELA: desligado/seco não grava).
 * Conversa já guardada é REAPLICADA (etiqueta + origem, sem nota nova): rodar de novo conserta o que falhou. Imprime, por conversa, o que cada
 * parte fez. A saída não tem nome nem telefone: só conversa, data, id do anúncio e o resultado.
 *
 *   node dist/scripts/referral-do-crm-retroativo.js --so-conferir            # só lista (não grava nada)
 *   node dist/scripts/referral-do-crm-retroativo.js                          # aplica
 *   opções: --desde=AAAA-MM-DD (padrão 2026-11-13: a véspera do bug)  --caixa=3
 */
import { prisma } from '../lib/prisma.js';
import { REGRA_KAPSO_REFERRAL, referralDoChatwoot } from '../lib/kapso-referral.js';
import { aoAcharReferral, estadoDoReceptor } from '../lib/chatwoot-ia.js';
import { CAIXAS_REGUA } from '../lib/chatwoot-regua.js';
import { lerArgumentos, prepararEstadoDasAutomacoes, rodarRetroativo, type PortasDoRetroativo } from '../lib/chatwoot-referral-retroativo.js';
import { chamar, contextoDaCaixa, contextoDoAmbiente, type ContextoChatwoot } from '../mcp-remoto/chatwoot.js';

const MAX_PAGINAS_DE_CONVERSAS = 60;
const MAX_PAGINAS_DE_MENSAGENS = 15;

function portasReais(ctx: ContextoChatwoot, caixa: number, desdeSeg: number, etiquetas: (conversa: number) => Promise<string[] | null>): PortasDoRetroativo {
  return {
    async conversas() {
      const lista: Array<{ id: number; contato: number | null }> = [];
      for (let pagina = 1; pagina <= MAX_PAGINAS_DE_CONVERSAS; pagina++) {
        const r = (await chamar(ctx, 'GET', 'conversations', { query: { inbox_id: String(caixa), status: 'all', assignee_type: 'all', page: String(pagina) } })) as {
          data?: { payload?: any[] };
          payload?: any[];
        } | null;
        const pag = r?.data?.payload ?? r?.payload ?? [];
        if (!Array.isArray(pag) || pag.length === 0) return { lista, truncado: false };
        // vêm da atividade mais nova para a mais antiga: página inteira fora da janela = acabou
        let algumaNaJanela = false;
        for (const c of pag) {
          if (Number(c?.last_activity_at) < desdeSeg) continue;
          algumaNaJanela = true;
          const id = Number(c?.id);
          const contato = Number(c?.meta?.sender?.id);
          if (Number.isInteger(id) && id > 0) lista.push({ id, contato: Number.isInteger(contato) && contato > 0 ? contato : null });
        }
        if (!algumaNaJanela) return { lista, truncado: false };
      }
      return { lista, truncado: true };
    },
    async referrais(conversa) {
      const achados: Awaited<ReturnType<PortasDoRetroativo['referrais']>>['achados'] = [];
      let antes: number | undefined;
      for (let i = 0; i < MAX_PAGINAS_DE_MENSAGENS; i++) {
        const r = (await chamar(ctx, 'GET', `conversations/${conversa}/messages`, { query: antes ? { before: String(antes) } : {} })) as { payload?: any[] } | null;
        const lista = Array.isArray(r?.payload) ? r.payload : [];
        if (lista.length === 0) return { achados, truncado: false };
        for (const m of lista) {
          if (Number(m?.message_type) !== 0 || m?.private === true) continue;
          const criadaEm = Number(m?.created_at);
          if (!(criadaEm >= desdeSeg)) continue;
          const wamid = String(m?.source_id ?? '');
          if (!/^wamid\.[A-Za-z0-9_=+/-]{10,400}$/.test(wamid)) continue;
          const ref = referralDoChatwoot(m?.content_attributes?.referral, criadaEm);
          if (ref) achados.push({ wamid, ref, criadaEm });
        }
        const primeiro = Math.min(...lista.map((m) => Number(m?.id) || Infinity));
        const maisAntiga = Math.min(...lista.map((m) => Number(m?.created_at) || Infinity));
        if (!Number.isFinite(primeiro) || (antes !== undefined && primeiro >= antes) || maisAntiga < desdeSeg) return { achados, truncado: false };
        antes = primeiro;
      }
      return { achados, truncado: true };
    },
    async guardado(conversa, wamid) {
      const l = await prisma.chatwootReguaDisparo.findFirst({ where: { caixa, conversationId: conversa, regra: REGRA_KAPSO_REFERRAL, chave: wamid.slice(0, 190) }, select: { id: true } });
      return !!l;
    },
    async temEtiqueta(conversa) {
      const e = await etiquetas(conversa);
      return e ? e.some((x) => x.trim().toLowerCase() === 'anuncio') : null;
    },
  };
}

async function main() {
  const { soConferir, caixa, desde } = lerArgumentos(process.argv.slice(2));
  // 1º de tudo: o estado das automações ligado pela TELA (tabela) — o servidor lê no boot; este processo é novo
  await prepararEstadoDasAutomacoes();
  const base = contextoDoAmbiente();
  const ctx = base ? contextoDaCaixa(base, caixa) : null;
  const conta = ctx?.conta?.conta;
  if (!ctx || !conta) throw new Error(`o Chatwoot não está configurado para a caixa ${caixa} neste servidor`);
  const estado = estadoDoReceptor(conta);
  if (!estado) throw new Error(`a conta ${conta} não tem estado da IA (sem unidade/token): não aplico`);
  const slug = CAIXAS_REGUA[caixa];
  if (!slug) throw new Error(`a caixa ${caixa} não é de nenhuma unidade configurada`);
  const modoDaOrigem = estado.origem.estado(slug);
  const desdeSeg = Math.floor(Date.parse(`${desde}T00:00:00-03:00`) / 1000);

  console.log(`caixa ${caixa} (${slug}), desde ${desde} — ${soConferir ? 'SÓ CONFERIR (nada é gravado)' : 'APLICANDO'}; automação chatwoot-origem: ${modoDaOrigem}`);
  if (!soConferir && modoDaOrigem !== 'ligado') console.log(`AVISO  a origem está «${modoDaOrigem}»: o contato NÃO será preenchido (etiqueta e nota seguem). Ligue a automação na tela e rode de novo para completar.`);

  const portas = portasReais(ctx, caixa, desdeSeg, async (c) => {
    const conv = await estado.chat.conversa(c);
    return conv ? conv.etiquetas : null;
  });
  const c = await rodarRetroativo({ caixa, soConferir, modoDaOrigem }, portas, aoAcharReferral(estado), (l) => console.log(l));
  console.log('\nresumo:', c, soConferir ? '(nada foi gravado: rode sem --so-conferir para aplicar)' : '');
  if (c.truncado) console.log('AVISO  houve teto de páginas atingido: rode com --desde mais perto se faltar conversa na lista.');
  if (!soConferir && c.falhou) process.exitCode = 1;
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());

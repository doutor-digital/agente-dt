/**
 * Preenchimento retroativo dos campos do CRM (Chatwoot) — LOTE 2: etapa, funil, motivo e qualificação VAZIOS das conversas da caixa de WhatsApp
 * oficial, a partir do cartão do Kommo (só leitura), da agenda da franquia (o que o `chatwoot-agenda` já gravou) e da classificação da Sofia.
 * As regras e a segurança (régua, CAPI, webhook) estão em `lib/chatwoot-campos-retroativos.ts`; a ordem de gravação em `…-run.ts`.
 *
 *   node dist/scripts/preencher-campos-crm.js --so-conferir        # só mostra, por conversa, campo: antes → depois + regra. NÃO grava nada
 *   node dist/scripts/preencher-campos-crm.js                      # grava (as linhas «REG {…}» da saída são o registro para desfazer)
 *   node dist/scripts/preencher-campos-crm.js --desfazer < saida   # devolve ao que era (lê as linhas REG pelo stdin)
 *   opções: --caixa=3  --max=150 (teto de conversas gravadas)  --conversas=12,34 (só estas)
 *
 * Kommo e franquia: SÓ LEITURA, num ritmo baixo (uma consulta por telefone, 250 ms entre elas). A saída não tem nome nem telefone.
 */
import { createInterface } from 'node:readline';
import { prisma } from '../lib/prisma.js';
import { CAIXAS_REGUA, CAMPO_VISTO_CONVERSA, type Vistos, type Visto } from '../lib/chatwoot-regua.js';
import { recarregarAutomacoes } from '../lib/automacoes-estado.js';
import { portaDoChatwoot } from '../lib/chatwoot-porta.js';
import { createKommoClientSemFreio } from '../services/kommo.service.js';
import { finalDoTelefone } from '../lib/chatwoot-regua-worker.js';
import { mesmoTelefone } from '../lib/chatwoot-lida.js';
import { chamar, contextoDaCaixa, contextoDoAmbiente } from '../mcp-remoto/chatwoot.js';
import { desfazerCampos, lerArgumentos, rodarCampos, type PortasDosCampos } from '../lib/chatwoot-campos-retroativos-run.js';
import type { FatoDeQualificacao, LeadDoKommo } from '../lib/chatwoot-campos-retroativos.js';

const MAX_PAGINAS = 60;

async function portasReais(caixa: number, slug: string): Promise<PortasDosCampos> {
  const base = contextoDoAmbiente();
  const ctx = base ? contextoDaCaixa(base, caixa) : null;
  if (!ctx?.conta) throw new Error(`o Chatwoot não está configurado para a caixa ${caixa} neste servidor`);
  const unit = await prisma.unit.findUnique({ where: { slug } });
  if (!unit) throw new Error(`unidade ${slug} não encontrada`);
  if (!unit.kommoSubdomain || !unit.kommoAccessToken) throw new Error(`a unidade ${slug} não tem Kommo configurado`);
  const kommo = createKommoClientSemFreio(unit);
  const chat = portaDoChatwoot(ctx);
  const [pipelines, motivos] = await Promise.all([kommo.listPipelines(), kommo.listLossReasons()]);
  const funilDe = new Map(pipelines.map((p) => [p.id, p] as const));
  const motivoDe = new Map(motivos.map((m) => [m.id, m.name] as const));

  return {
    async conversas() {
      const lista: any[] = [];
      for (let pagina = 1; pagina <= MAX_PAGINAS; pagina++) {
        const r = (await chamar(ctx, 'GET', 'conversations', { query: { inbox_id: String(caixa), status: 'all', assignee_type: 'all', page: String(pagina) } })) as { data?: { payload?: any[] }; payload?: any[] } | null;
        const pag = r?.data?.payload ?? r?.payload ?? [];
        if (!Array.isArray(pag) || pag.length === 0) return { lista, truncado: false };
        lista.push(...pag);
      }
      return { lista, truncado: true };
    },
    async fresca(id) {
      return (await chamar(ctx, 'GET', `conversations/${id}`)) as any;
    },
    async leadsDoKommo(telefone) {
      const fim = finalDoTelefone(telefone);
      if (!fim) return [];
      const contatos = await kommo.buscarContatosPorTelefone(fim, 10);
      // o mesmo número (DDI+DDD e os 8 últimos dígitos): os 8 dígitos sozinhos juntariam gente de DDD diferente
      const ids = [...new Set(contatos.filter((c) => c.telefones.some((t) => mesmoTelefone(t, telefone))).flatMap((c) => c.leadIds))].slice(0, 8);
      const saida: LeadDoKommo[] = [];
      for (const id of ids) {
        const l = await kommo.getLead(id);
        const funil = funilDe.get(l.pipeline_id);
        const status = funil?.statuses.find((s) => s.id === l.status_id);
        if (!funil || !status) continue;
        saida.push({ id: l.id, funil: funil.name, etapa: status.name, statusId: l.status_id, atualizadoEm: Number(l.updated_at) || 0, motivoPerda: l.loss_reason_id ? motivoDe.get(l.loss_reason_id) ?? null : null });
      }
      return saida;
    },
    async qualificacoes(leadIds) {
      const linhas = await prisma.leadFactEvent.findMany({
        where: { unitId: unit.id, leadId: { in: leadIds.map(String) }, chave: 'qualificacao', observadoEm: { gte: new Date(Date.now() - 31 * 86_400_000) } },
        select: { leadId: true, valor: true, observadoEm: true },
        orderBy: { observadoEm: 'desc' },
        take: 50,
      });
      return linhas.map((l): FatoDeQualificacao => ({ leadId: Number(l.leadId), valor: l.valor, observadoEm: l.observadoEm }));
    },
    async vistosDaCaixa() {
      const linhas = await prisma.chatwootReguaVisto.findMany({ where: { caixa }, select: { conversationId: true, campo: true, valor: true, desde: true, inicial: true } });
      const m = new Map<number, Map<string, Visto>>();
      for (const l of linhas) {
        if (l.conversationId === 0) continue;
        const v = m.get(l.conversationId) ?? new Map<string, Visto>();
        v.set(l.campo, { valor: l.valor, desde: l.desde, inicial: l.inicial });
        m.set(l.conversationId, v);
      }
      return m as Map<number, Vistos>;
    },
    async vistosDe(id) {
      const linhas = await prisma.chatwootReguaVisto.findMany({ where: { caixa, conversationId: id }, select: { campo: true, valor: true, desde: true, inicial: true } });
      return new Map(linhas.map((l) => [l.campo, { valor: l.valor, desde: l.desde, inicial: l.inicial }] as const));
    },
    async motivosValidos() {
      return chat.valoresDoAtributo('motivo_nao_agendamento');
    },
    async marcarVisto(id, campo, valor, agora) {
      if (campo === CAMPO_VISTO_CONVERSA) throw new Error('marca da conversa inteira não é desta ferramenta');
      const onde = { caixa_conversationId_campo: { caixa, conversationId: id, campo } };
      const antes = await prisma.chatwootReguaVisto.findUnique({ where: onde, select: { valor: true, inicial: true } });
      await prisma.chatwootReguaVisto.upsert({ where: onde, create: { caixa, conversationId: id, campo, valor, desde: agora, inicial: true }, update: { valor, desde: agora, inicial: true } });
      return !antes ? 'criou' : antes.valor === valor && antes.inicial ? 'igual' : 'atualizou';
    },
    async marcarCapi(id, evento, agora) {
      try {
        await prisma.chatwootReguaDisparo.create({ data: { caixa, conversationId: id, regra: `capi-visto:${evento}`, chave: 'v1', modo: 'inicial', texto: '', criadoEm: agora } });
        return 'criou';
      } catch (err) {
        if ((err as { code?: string })?.code === 'P2002') return 'ja-existia';
        throw err;
      }
    },
    async apagarVisto(id, campo) {
      await prisma.chatwootReguaVisto.deleteMany({ where: { caixa, conversationId: id, campo } });
    },
    async apagarCapi(id, evento) {
      await prisma.chatwootReguaDisparo.deleteMany({ where: { caixa, conversationId: id, regra: `capi-visto:${evento}`, chave: 'v1', modo: 'inicial' } });
    },
    async gravarAtributos(id, attrs) {
      await chamar(ctx, 'POST', `conversations/${id}/custom_attributes`, { corpo: { custom_attributes: attrs } });
    },
    async gravarEtiquetas(id, etiquetas) {
      // o Chatwoot SUBSTITUI a lista inteira: quem chama manda a lista completa
      await chamar(ctx, 'POST', `conversations/${id}/labels`, { corpo: { labels: etiquetas } });
    },
    pausa: (ms) => new Promise((r) => setTimeout(r, ms)),
  };
}

async function main() {
  const o = lerArgumentos(process.argv.slice(2));
  // o estado das automações ligado pela TELA só existe depois de lido (o servidor lê no boot; este processo é novo)
  await recarregarAutomacoes();
  const slug = CAIXAS_REGUA[o.caixa];
  if (!slug) throw new Error(`a caixa ${o.caixa} não é de nenhuma unidade configurada`);
  const portas = await portasReais(o.caixa, slug);
  const log = (l: string) => console.log(l);
  if (o.desfazer) {
    const linhas: string[] = [];
    for await (const l of createInterface({ input: process.stdin })) linhas.push(l);
    const r = await desfazerCampos(linhas, portas, log);
    console.log('\nresumo do desfazer:', r);
    return;
  }
  console.log(`caixa ${o.caixa} (${slug}) — ${o.soConferir ? 'SÓ CONFERIR (nada é gravado; Kommo e franquia só leitura)' : 'GRAVANDO'}${o.so ? ` — só as conversas ${o.so.join(',')}` : ''}`);
  const r = await rodarCampos(o, portas, log);
  console.log('\nresumo:', JSON.stringify(r, null, 1));
  if (o.soConferir) console.log('(nada foi gravado: rode sem --so-conferir para aplicar)');
  if (!o.soConferir && (r.falhas || r.erros)) process.exitCode = 1;
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());

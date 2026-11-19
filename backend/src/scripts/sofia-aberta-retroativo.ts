/**
 * Retroativo do «Sofia atendendo» na caixa de WhatsApp oficial do CRM: tira de «Pendentes» (abre) as conversas que o robô deixou lá e
 * etiqueta `sofia-atendendo` as que a Sofia ainda atende. NÃO manda mensagem a ninguém. A saída não tem nome nem telefone.
 *
 *   node dist/scripts/sofia-aberta-retroativo.js --so-conferir     # só lista o que faria (não grava nada)
 *   node dist/scripts/sofia-aberta-retroativo.js                   # aplica
 *   opções: --caixa=3  --etiquetar-horas=24
 */
import { prisma } from '../lib/prisma.js';
import { chamar, contextoDaCaixa, contextoDoAmbiente, ehContaDoAmbiente } from '../mcp-remoto/chatwoot.js';
import { CAIXAS_REGUA } from '../lib/chatwoot-regua.js';
import { prepararEstadoDasAutomacoes } from '../lib/chatwoot-referral-retroativo.js';
import { estadoDaAutomacao } from '../lib/automacoes-estado.js';
import { ID_IA, estadoDoReceptor } from '../lib/chatwoot-ia.js';
import { portaDoRobo, tokenDoRobo } from '../lib/chatwoot-sofia-bot.js';
import { atendimentoLigado, portaDoAtendimento } from '../lib/chatwoot-sofia-atendendo.js';
import { configDaUnidade } from '../lib/chatwoot-unidades.js';
import { acertarPendentes, lerArgumentosDoAcerto, podeEtiquetar, type PendenteDaCaixa } from '../lib/chatwoot-sofia-atendendo-retroativo.js';

const MAX_PAGINAS = 40;

async function main() {
  const a = lerArgumentosDoAcerto(process.argv.slice(2));
  await prepararEstadoDasAutomacoes();
  const base = contextoDoAmbiente();
  const ctx = base ? contextoDaCaixa(base, a.caixa) : null;
  const conta = ctx?.conta?.conta;
  if (!base || !ctx || !conta) throw new Error(`o Chatwoot não está configurado para a caixa ${a.caixa} neste servidor`);
  const slug = CAIXAS_REGUA[a.caixa];
  if (!slug) throw new Error(`a caixa ${a.caixa} não é de nenhuma unidade configurada`);
  if (!estadoDoReceptor(conta)) throw new Error(`a conta ${conta} não tem estado da IA (sem unidade/token): não aplico`);

  const modo = estadoDaAutomacao(slug, ID_IA, process.env.CHATWOOT_IA_SLUGS);
  // o robô DESTA conta: o do ambiente em Parauapebas, o da própria clínica nas de conta própria (o token de uma nunca vale na outra)
  const token = ehContaDoAmbiente(conta) ? tokenDoRobo() : tokenDoRobo(process.env, configDaUnidade(slug)?.envSufixo);
  const robo = token ? portaDoRobo(ctx, token) : null;
  const chaveLigada = atendimentoLigado();
  console.log(`caixa ${a.caixa} (${slug}) — ${a.soConferir ? 'SÓ CONFERIR (nada é gravado)' : 'APLICANDO'}`);
  console.log(`Sofia (${ID_IA}): ${modo}; robô do Chatwoot: ${robo ? 'configurado' : 'NÃO configurado (abro com o token da conta)'}; CHATWOOT_SOFIA_ATENDENDO: ${chaveLigada ? 'ligado' : 'DESLIGADO (=0)'}`);
  // a etiqueta só entra onde o fluxo ao vivo também a poria: Sofia LIGADA na unidade, robô configurado e a chave não desligada
  const etiquetar = podeEtiquetar({ modo, temRobo: !!robo, chaveLigada });
  if (!etiquetar.pode) console.log(`AVISO  NENHUMA conversa levará a etiqueta (${etiquetar.porque}). As pendentes serão abertas.`);

  const atendimento = portaDoAtendimento(ctx, async (id) => {
    if (robo) return robo.abrirParaEquipe(id);
    await chamar(ctx, 'POST', `conversations/${id}/toggle_status`, { corpo: { status: 'open' } });
  });
  const r = await acertarPendentes(
    a,
    {
      atendimento,
      sofiaLigada: etiquetar.pode,
      async pendentes() {
        const lista: PendenteDaCaixa[] = [];
        for (let pagina = 1; pagina <= MAX_PAGINAS; pagina++) {
          const res = (await chamar(ctx, 'GET', 'conversations', { query: { inbox_id: String(a.caixa), status: 'pending', assignee_type: 'all', page: String(pagina) } })) as {
            data?: { payload?: any[] };
            payload?: any[];
          } | null;
          const pag = res?.data?.payload ?? res?.payload ?? [];
          if (!Array.isArray(pag) || pag.length === 0) return { lista, truncado: false };
          for (const c of pag) {
            const id = Number(c?.id);
            const quando = Number(c?.last_activity_at);
            if (Number.isInteger(id) && id > 0) lista.push({ id, ultimaAtividade: Number.isFinite(quando) && quando > 0 ? quando : null });
          }
        }
        return { lista, truncado: true };
      },
    },
    new Date(),
    (l) => console.log(l),
  );
  console.log('\nresumo:', r, a.soConferir ? '(nada foi gravado: rode sem --so-conferir para aplicar)' : '');
  if (r.truncado) console.log(`AVISO  parei em ${MAX_PAGINAS} páginas: rode de novo para pegar o resto.`);
  if (!a.soConferir && r.falhou) process.exitCode = 1;
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());

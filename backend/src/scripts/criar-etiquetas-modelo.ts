/**
 * Cria no Chatwoot as etiquetas `modelo-*` (uma por modelo de WhatsApp de Parauapebas, 32 dos 33: o de boas-vindas ao programa fica de fora,
 * porque pede o nome do programa e o Chatwoot não tem esse campo): quem põe a etiqueta numa conversa
 * manda aquele modelo pela régua (`chatwoot-regua.ts`, regra `modelo-etiqueta`). Só cria as que ainda não existem (lê `labels` antes).
 * Por padrão NÃO escreve nada: só lista o que criaria. `--aplicar` cria.
 *
 *   CHATWOOT_API_TOKEN=… CHATWOOT_CONTA_ID=… [CHATWOOT_URL=…] node dist/scripts/criar-etiquetas-modelo.js            # seco
 *   CHATWOOT_API_TOKEN=… CHATWOOT_CONTA_ID=… [CHATWOOT_URL=…] node dist/scripts/criar-etiquetas-modelo.js --aplicar  # cria
 */
import { MODELO_POR_ETIQUETA, MODELOS_SEM_ETIQUETA } from '../lib/chatwoot-regua.js';
import { TEXTOS_PARAU } from '../lib/chatwoot-regua-textos.js';
import { chamar, contaChatwootDoAmbiente, criarContextoChatwoot } from '../mcp-remoto/chatwoot.js';

const aplicar = process.argv.includes('--aplicar');
const COR = '#7F56D9';

const conta = contaChatwootDoAmbiente();
if (!conta) {
  console.error('Faltam CHATWOOT_API_TOKEN e CHATWOOT_CONTA_ID (e, se não for o padrão, CHATWOOT_URL) no ambiente.');
  process.exit(1);
}
const ctx = criarContextoChatwoot(conta);

/** Primeiros ~120 caracteres do texto do modelo, numa linha só. */
function descricaoDo(modelo: string): string {
  const linha = (TEXTOS_PARAU[modelo] ?? '').replace(/\s+/g, ' ').trim();
  return linha.length <= 120 ? linha : `${linha.slice(0, 119).trimEnd()}…`;
}

if (MODELOS_SEM_ETIQUETA.length) console.log(`Sem etiqueta (campo que o Chatwoot não tem): ${MODELOS_SEM_ETIQUETA.join(', ')}.`);
const resposta = (await chamar(ctx, 'GET', 'labels')) as { payload?: unknown } | null;
const existentes = new Set((Array.isArray(resposta?.payload) ? resposta.payload : []).map((l: any) => String(l?.title ?? '').toLowerCase()));

const faltam = Object.entries(MODELO_POR_ETIQUETA).filter(([etiqueta]) => !existentes.has(etiqueta));
console.log(`${Object.keys(MODELO_POR_ETIQUETA).length} etiquetas de modelo; ${Object.keys(MODELO_POR_ETIQUETA).length - faltam.length} já existem; ${faltam.length} a criar. Modo: ${aplicar ? 'APLICAR' : 'seco (nada é escrito)'}.`);

let criadas = 0;
let falhas = 0;
for (const [etiqueta, modelo] of faltam) {
  const corpo = { title: etiqueta, description: descricaoDo(modelo), color: COR, show_on_sidebar: false };
  if (!aplicar) {
    console.log(`[seco] criaria ${etiqueta}  (${modelo})  «${corpo.description}»`);
    continue;
  }
  try {
    await chamar(ctx, 'POST', 'labels', { corpo });
    criadas++;
    console.log(`criada ${etiqueta}`);
  } catch (err) {
    falhas++;
    console.error(`FALHOU ${etiqueta}: ${err instanceof Error ? err.message : String(err)}`);
  }
}
if (aplicar) console.log(`Pronto: ${criadas} criadas, ${falhas} falhas.`);
else if (faltam.length) console.log('Seco: nada foi criado. Rode de novo com --aplicar para criar.');
process.exit(falhas ? 1 : 0);

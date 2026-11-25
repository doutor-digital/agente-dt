/**
 * Leva os «Modelos gerais» (texto livre) do Kommo de uma unidade para as RESPOSTAS PRONTAS do CRM dela. Roda DENTRO do contêiner do agente (é lá
 * que estão o banco, o token do Kommo da unidade e o do Chatwoot); o João chama por `ops/kit-unidade/importar-modelos-kommo-joao.sh`.
 *
 *   node dist/scripts/importar-modelos-kommo.js <slug>                  # padrão = --so-conferir: só LÊ (Kommo e CRM) e mostra o plano
 *   node dist/scripts/importar-modelos-kommo.js <slug> --so-conferir
 *   node dist/scripts/importar-modelos-kommo.js <slug> --aplicar        # cria no CRM os que faltam (casa pelo atalho: não duplica, não sobrescreve)
 *
 *   node dist/scripts/importar-modelos-kommo.js <slug> --arquivo -    # os modelos vêm de um BACKUP em JSON lido da entrada padrão (o .sh manda o arquivo
 *                                                                     por ssh, sem gravar nada na VPS), NÃO da API do Kommo; mesmas regras
 *
 * Só escreve na conta PRÓPRIA da unidade no Chatwoot: unidade sem conta própria (a que mora na conta do ambiente, a 1) é RECUSADA. Os modelos do
 * WhatsApp (`waba`) não entram: o Chatwoot já os sincroniza da WABA. Nenhum token é impresso.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { prisma } from '../lib/prisma.js';
import { contaDaUnidade, configDaUnidade } from '../lib/chatwoot-unidades.js';
import { importar, lerBackup, modelosDoBackup, relatorio } from '../lib/kit-unidade/modelos-kommo-para-respostas.js';
import { createKommoClientSemFreio } from '../services/kommo.service.js';
import { unidadeSemAntecipado } from '../agent/pagamento-da-unidade.js';
import { chamar, contaChatwootDoAmbiente, contextoDaUnidade, contextoDoAmbiente, temTokenProprio, type ContextoChatwoot } from '../mcp-remoto/chatwoot.js';

async function principal(): Promise<number> {
  const args = process.argv.slice(2);
  const iArq = args.indexOf('--arquivo');
  const arquivo = iArq >= 0 ? args[iArq + 1] : undefined;
  if (iArq >= 0 && (!arquivo || arquivo.startsWith('--'))) return console.error('--arquivo precisa do caminho do JSON, ou «-» para ler da entrada padrão'), 2;
  if (iArq >= 0) args.splice(iArq, 2);
  const posicionais = args.filter((a) => !a.startsWith('--'));
  const slug = posicionais[0];
  const flags = args.filter((a) => a.startsWith('--'));
  if (posicionais.length > 1) return console.error(`mais de uma unidade (${posicionais.join(', ')}): rode uma por vez`), 2;
  for (const f of flags) if (f !== '--so-conferir' && f !== '--aplicar') return console.error(`argumento desconhecido: ${f} (use --so-conferir, --aplicar ou --arquivo <json|->)`), 2;
  if (!slug) return console.error('uso: importar-modelos-kommo <slug> [--so-conferir | --aplicar] [--arquivo <json|->]'), 2;
  if (flags.includes('--so-conferir') && flags.includes('--aplicar')) return console.error('--so-conferir e --aplicar juntos: escolha um'), 2;
  const aplicar = flags.includes('--aplicar');

  const { iniciarConfigChatwoot, pararConfigChatwoot } = await import('../lib/chatwoot-unidades-banco.js');
  await iniciarConfigChatwoot();
  try {
    const conta = contaDaUnidade(slug);
    const cfg = configDaUnidade(slug);
    if (!cfg || typeof conta !== 'number') return console.error(`a unidade «${slug}» não tem conta PRÓPRIA no CRM (conta=${String(conta)}): recuso, para nunca escrever na conta de outra clínica`), 1;
    const ambiente = contaChatwootDoAmbiente();
    if (conta === 1 || ambiente?.conta === conta) return console.error(`a conta ${conta} é a do ambiente (Parauapebas): recuso`), 1;
    const base = contextoDoAmbiente();
    // o contexto DESTA unidade (não o da «dona» da conta, que pode ser outra unidade que divide a conta)
    const ctx: ContextoChatwoot | null = base ? contextoDaUnidade(base, slug) : null;
    if (!ctx || ctx.conta?.conta !== conta) return console.error(`não achei credencial do CRM para a unidade ${slug} (conta ${conta})`), 1;
    const propria = temTokenProprio(slug);
    if (aplicar && !propria) return console.error(`recuso --aplicar (decisão do sênior no #462): a unidade ${slug} não tem token PRÓPRIO do CRM (cairia no token global da instalação). Conferir (--so-conferir) pode.`), 1;

    const unit = await prisma.unit.findUnique({ where: { slug } });
    if (!unit) return console.error(`a unidade «${slug}» não existe no banco`), 1;
    let kommo: ReturnType<typeof createKommoClientSemFreio> | null = null;
    let cabecalho: string;
    if (arquivo === undefined) {
      if (!unit.kommoSubdomain || !unit.kommoAccessToken) return console.error(`a unidade «${slug}» não tem credencial do Kommo no banco`), 1;
      kommo = createKommoClientSemFreio(unit);
      cabecalho = `Kommo ${unit.kommoSubdomain}`;
    } else {
      cabecalho = `arquivo de backup (${arquivo === '-' ? 'entrada padrão' : 'caminho no contêiner'}), sem consultar o Kommo`;
    }
    // a MESMA decisão do guia e do cartão (`accepts_advance_payment=false` e sem taxa de reserva): os modelos «Financeiro …» ficam de fora
    const semAntecipado = unidadeSemAntecipado(unit);

    console.log(`${aplicar ? 'APLICANDO' : 'SÓ CONFERIR (padrão): nada será escrito'} — unidade ${slug}, ${cabecalho}, CRM conta ${conta}${propria ? '' : ' (token global da instalação: a conta não tem token próprio)'}.`);
    const r = await importar(
      {
        modelosDoKommo: async () => (arquivo !== undefined ? modelosDoBackup(arquivo === '-' ? await lerBackup(process.stdin) : readFileSync(arquivo, 'utf8')) : kommo!.listChatTemplates(8)),
        nomeDoCampo: async () => {
          // do backup não há Kommo para perguntar o nome do campo: o marcador fica «[campo do cartão]» e é AVISADO no relatório
          if (arquivo !== undefined || !kommo) return () => null;
          // todos os tipos (a lista «Typed» esconde os campos de data/hora, que são os que os lembretes usam)
          const por = new Map((await kommo.listarCamposDoCartao()).map((c) => [c.id, c.name]));
          return (id) => por.get(id) ?? null;
        },
        respostasDoCrm: async () => {
          // falha FECHADO: resposta que não é lista não vira «não existe nenhuma» (aí tudo apareceria como «criar»)
          const r = (await chamar(ctx, 'GET', 'canned_responses')) as unknown;
          const lista = Array.isArray(r) ? r : Array.isArray((r as { payload?: unknown } | null)?.payload) ? ((r as { payload: unknown[] }).payload) : null;
          if (!lista) throw new Error('o CRM não devolveu a lista de respostas prontas (formato inesperado): não vou adivinhar o que já existe');
          return lista.map((x) => ({ short_code: String((x as { short_code?: unknown }).short_code ?? ''), content: String((x as { content?: unknown }).content ?? '') }));
        },
        criarNoCrm: async (atalho, texto) => {
          await chamar(ctx, 'POST', 'canned_responses', { corpo: { short_code: atalho, content: texto } });
        },
      },
      cfg.prefixoModelos,
      aplicar,
      { semAntecipado },
    );
    for (const linha of relatorio(r, aplicar)) console.log(linha);
    return r.falhas.length ? 1 : 0;
  } finally {
    pararConfigChatwoot();
    await prisma.$disconnect();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  principal().then(
    (c) => process.exit(c),
    (e) => {
      console.error(`erro: ${String(e instanceof Error ? e.message : e).slice(0, 200)}`);
      process.exit(1);
    },
  );
}

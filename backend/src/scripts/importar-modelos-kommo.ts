/**
 * Leva os «Modelos gerais» (texto livre) do Kommo de uma unidade para as RESPOSTAS PRONTAS do CRM dela. Roda DENTRO do contêiner do agente (é lá
 * que estão o banco, o token do Kommo da unidade e o do Chatwoot); o João chama por `ops/kit-unidade/importar-modelos-kommo-joao.sh`.
 *
 *   node dist/scripts/importar-modelos-kommo.js <slug>                  # padrão = --so-conferir: só LÊ (Kommo e CRM) e mostra o plano
 *   node dist/scripts/importar-modelos-kommo.js <slug> --so-conferir
 *   node dist/scripts/importar-modelos-kommo.js <slug> --aplicar        # cria no CRM os que faltam (casa pelo atalho: não duplica, não sobrescreve)
 *
 * Só escreve na conta PRÓPRIA da unidade no Chatwoot: unidade sem conta própria (a que mora na conta do ambiente, a 1) é RECUSADA. Os modelos do
 * WhatsApp (`waba`) não entram: o Chatwoot já os sincroniza da WABA. Nenhum token é impresso.
 */
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { prisma } from '../lib/prisma.js';
import { contaDaUnidade, configDaUnidade } from '../lib/chatwoot-unidades.js';
import { listaDaResposta } from '../lib/kit-unidade/fase2.js';
import { importar, relatorio } from '../lib/kit-unidade/modelos-kommo-para-respostas.js';
import { createKommoClientSemFreio } from '../services/kommo.service.js';
import { chamar, contaChatwootDoAmbiente, contextoDoAmbiente, donaDaConta, type ContextoChatwoot } from '../mcp-remoto/chatwoot.js';

async function principal(): Promise<number> {
  const args = process.argv.slice(2);
  const slug = args.find((a) => !a.startsWith('--'));
  const flags = args.filter((a) => a.startsWith('--'));
  for (const f of flags) if (f !== '--so-conferir' && f !== '--aplicar') return console.error(`argumento desconhecido: ${f} (use --so-conferir ou --aplicar)`), 2;
  if (!slug) return console.error('uso: importar-modelos-kommo <slug> [--so-conferir | --aplicar]'), 2;
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
    const dona = base ? donaDaConta(base, conta) : null;
    if (!dona || dona.ctx.conta?.conta !== conta) return console.error(`não achei credencial do CRM para a conta ${conta}`), 1;
    const ctx: ContextoChatwoot = dona.ctx;

    const unit = await prisma.unit.findUnique({ where: { slug } });
    if (!unit?.kommoSubdomain || !unit.kommoAccessToken) return console.error(`a unidade «${slug}» não tem credencial do Kommo no banco`), 1;
    const kommo = createKommoClientSemFreio(unit);

    console.log(`${aplicar ? 'APLICANDO' : 'SÓ CONFERIR (padrão): nada será escrito'} — unidade ${slug}, Kommo ${unit.kommoSubdomain}, CRM conta ${conta}${dona.propria ? '' : ' (token global da instalação: a conta não tem token próprio)'}.`);
    const r = await importar(
      {
        modelosDoKommo: () => kommo.listChatTemplates(8),
        nomeDoCampo: async () => {
          // todos os tipos (a lista «Typed» esconde os campos de data/hora, que são os que os lembretes usam)
          const por = new Map((await kommo.listarCamposDoCartao()).map((c) => [c.id, c.name]));
          return (id) => por.get(id) ?? null;
        },
        respostasDoCrm: async () => listaDaResposta(await chamar(ctx, 'GET', 'canned_responses')).map((x) => ({ short_code: String(x.short_code ?? ''), content: String(x.content ?? '') })),
        criarNoCrm: async (atalho, texto) => {
          await chamar(ctx, 'POST', 'canned_responses', { corpo: { short_code: atalho, content: texto } });
        },
      },
      cfg.prefixoModelos,
      aplicar,
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

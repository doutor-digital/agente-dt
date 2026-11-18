/**
 * Retroativo do `origem-texto-pronto`: nos cartões criados desde uma data, com ⚑ Origem VAZIO e cuja 1ª fala do paciente começa com uma
 * frase da lista da unidade (`units.pipeline_intents.origem_por_texto`), preenche a ⚑ Origem.
 *
 * Por que existe (18/11/2026): Petrópolis e Caxias estão no WhatsApp Lite, o Kommo não recebe o anúncio, e desde 12/11 os cartões ficaram
 * sem origem. A automação nova (`lib/origem-texto-pronto.ts`) cuida dos leads daqui para frente; isto aqui é o passado.
 *
 * SÓ LEITURA por padrão: imprime «lead · frase · antes → depois» e não escreve nada. Só grava com --gravar. A decisão por cartão é a MESMA da
 * automação (`planejarOrigem`): campo com valor nunca é reescrito, opção que não existe na conta não grava, cartão de outra unidade (Kommo
 * dividido) fica de fora. Relê o cartão logo antes de gravar. Deixa a mesma nota da automação. Independe do estado da chave na tela: quem roda é gente.
 *
 *   node dist/scripts/origem-texto-pronto-retroativo.js --unidade=doutor-hernia-petropolis,doutor-hernia-caxias --desde=2026-11-12
 *   node dist/scripts/origem-texto-pronto-retroativo.js --unidade=doutor-hernia-petropolis --desde=2026-11-12 --gravar
 */
import { prisma } from '../lib/prisma.js';
import { createKommoClient } from '../services/kommo.service.js';
import { addChangeLog } from '../services/change-log.service.js';
import { grupoDaUnidade, pularCartao } from '../lib/crm-compartilhado.js';
import type { DefinicaoDeCampo } from '../lib/ponte-ligacao.js';
import { MAX_FALAS_OLHADAS, NOME_DO_CAMPO_ORIGEM, casarPrimeirasFalas, lerListaDeTextos, planejarOrigem, textoDaNota } from '../lib/origem-texto-pronto.js';

const GRAVAR = process.argv.includes('--gravar');
const arg = (nome: string) => (process.argv.find((a) => a.startsWith(`--${nome}=`)) ?? '').split('=').slice(1).join('=');
const SLUGS = arg('unidade')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const DESDE = new Date(`${arg('desde') || '2026-11-12'}T00:00:00-03:00`);
/** Pausa entre cartões: o Kommo é compartilhado com a operação (7 req/s por conta; aqui são ~2 por cartão). */
const PAUSA_MS = 300;
const dormir = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  if (SLUGS.length === 0) throw new Error('falta --unidade=<slug>[,<slug>]');
  if (Number.isNaN(DESDE.getTime())) throw new Error('--desde inválido (use AAAA-MM-DD)');
  console.log(`${GRAVAR ? 'GRAVANDO' : 'SIMULAÇÃO (nada será escrito; use --gravar)'} · cartões criados desde ${DESDE.toISOString()} · ${SLUGS.join(', ')}\n`);

  const total = { vistos: 0, casam: 0, gravar: 0, gravados: 0, jaTinham: 0, pulados: 0, erros: 0 };

  for (const slug of SLUGS) {
    const unit = await prisma.unit.findUnique({ where: { slug } });
    if (!unit) {
      console.log(`!! unidade ${slug} não existe`);
      continue;
    }
    const lista = lerListaDeTextos(unit.pipelineIntents, (m) => console.log(`!! ${slug}: ${m}`));
    if (lista.length === 0) {
      console.log(`-- ${slug}: sem pipeline_intents.origem_por_texto — nada a fazer\n`);
      continue;
    }
    const kommo = createKommoClient(unit);
    const defs = (await kommo.listarCamposDoCartao()) as DefinicaoDeCampo[];
    const grupo = await grupoDaUnidade(unit.id);
    const conversas = await prisma.conversation.findMany({
      where: { unitId: unit.id, createdAt: { gte: DESDE } },
      orderBy: { createdAt: 'asc' },
      select: { leadId: true, messages: { where: { role: 'user' }, orderBy: { createdAt: 'asc' }, take: MAX_FALAS_OLHADAS, select: { content: true } } },
    });
    const vistosNaUnidade = new Set<number>();
    const gravadosDaUnidade: string[] = [];
    console.log(`== ${slug}: ${conversas.length} conversas criadas desde ${DESDE.toISOString().slice(0, 10)}, ${lista.length} frases na lista`);

    for (const c of conversas) {
      total.vistos++;
      const leadId = Number(c.leadId);
      if (!Number.isFinite(leadId) || leadId <= 0 || vistosNaUnidade.has(leadId)) continue; // um cartão com duas conversas conta uma vez
      vistosNaUnidade.add(leadId);
      const achou = casarPrimeirasFalas(c.messages.map((m) => m.content), lista);
      if (!achou) continue;
      total.casam++;
      try {
        await dormir(PAUSA_MS);
        const lead = await kommo.getLead(leadId);
        if (pularCartao(grupo, unit.id, lead, {})) {
          total.pulados++;
          console.log(`pula    ${leadId}  cartão de outra unidade (ou sem unidade)`);
          continue;
        }
        const plano = planejarOrigem(lead, defs, achou.entrada);
        const frase = achou.fala.replace(/\s+/g, ' ').trim().slice(0, 70);
        if (plano.tipo === 'pular') {
          if (plano.aviso) total.pulados++;
          else total.jaTinham++;
          console.log(`${plano.aviso ? 'PULA   ' : 'já tem '} ${leadId}  «${frase}»  ${plano.motivo}`);
          continue;
        }
        total.gravar++;
        console.log(`${GRAVAR ? 'GRAVA  ' : 'gravaria'} ${leadId}  «${frase}»  ${NOME_DO_CAMPO_ORIGEM} (vazio) → ${achou.entrada.origem}${achou.entrada.anuncio ? '  [anúncio]' : ''}`);
        if (GRAVAR) {
          await kommo.gravarCamposDoLead(leadId, [{ field_id: plano.campo.def.id, values: [{ enum_id: plano.campo.opcao.id }] }]);
          await kommo.addLeadNote(leadId, textoDaNota(achou.entrada)).catch(() => undefined);
          total.gravados++;
          gravadosDaUnidade.push(`${leadId}: ⚑ Origem (vazio) → ${achou.entrada.origem}`);
        }
      } catch (err) {
        total.erros++;
        console.log(`ERRO    ${leadId}  ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (GRAVAR && gravadosDaUnidade.length > 0) {
      await addChangeLog(unit.id, {
        category: 'kommo',
        summary: `⚑ Origem preenchida pelo texto pronto da 1ª mensagem (retroativo desde ${DESDE.toISOString().slice(0, 10)})`,
        details: gravadosDaUnidade.join('\n'),
      }).catch((err) => console.log(`!! não registrei o change-log de ${slug}: ${String(err)}`));
    }
    console.log('');
  }
  console.log(`${total.vistos} conversas vistas · ${total.casam} começam com frase da lista · ${total.gravar} ${GRAVAR ? 'a gravar' : 'seriam gravadas'} · ${total.jaTinham} já tinham origem · ${total.pulados} puladas · ${total.erros} erros`, GRAVAR ? `· ${total.gravados} GRAVADAS` : '(simulação)');
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());

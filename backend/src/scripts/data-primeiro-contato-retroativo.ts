/**
 * Preenche "◷ Data do primeiro contato" com a data de criação do cartão, onde está VAZIO. Sem IA. Nunca sobrescreve.
 * Decisão em `lib/data-primeiro-contato-retroativo.ts`.
 *
 * Simula por padrão. Só grava com --aplicar. Relê o cartão logo antes de gravar (se alguém preencheu no meio, pula).
 *
 *   node dist/scripts/data-primeiro-contato-retroativo.js --unidade=doutor-hernia-salto,doutor-hernia-tatui
 *   node dist/scripts/data-primeiro-contato-retroativo.js --unidade=doutor-hernia-salto,doutor-hernia-tatui --aplicar
 *   opções: --incluir-fechados (também Ganho/Perdido; padrão só os ativos)
 */
import { prisma } from '../lib/prisma.js';
import { createKommoClient } from '../services/kommo.service.js';
import { addChangeLog } from '../services/change-log.service.js';
import { ETAPAS_FECHADAS, planejarDataDoPrimeiroContato, type CartaoParaData } from '../lib/data-primeiro-contato-retroativo.js';
import type { KommoClient } from '../services/kommo.service.js';

const APLICAR = process.argv.includes('--aplicar');
const FECHADOS = process.argv.includes('--incluir-fechados');
const SLUGS = (process.argv.find((a) => a.startsWith('--unidade=')) ?? '')
  .split('=')
  .slice(1)
  .join('=')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const PAUSA_MS = 300;
const dormir = (ms: number) => new Promise((r) => setTimeout(r, ms));
const MAX_PAGINAS_POR_ETAPA = 100;

/**
 * Todos os cartões, etapa por etapa, LANÇANDO erro se qualquer página falhar: ler pela metade e gravar como se fosse tudo deixaria
 * centenas de cartões sem a data sem ninguém saber (o `listLeads` engole o erro da 2ª página em diante).
 */
async function lerTodosOsCartoes(kommo: KommoClient, incluirFechados: boolean): Promise<CartaoParaData[]> {
  const todos = new Map<number, CartaoParaData>();
  for (const funil of await kommo.listPipelines()) {
    for (const etapa of funil.statuses) {
      if (!incluirFechados && ETAPAS_FECHADAS.has(etapa.id)) continue;
      for (let pagina = 1; ; pagina++) {
        if (pagina > MAX_PAGINAS_POR_ETAPA) throw new Error(`etapa ${funil.name}/${etapa.name} passou de ${MAX_PAGINAS_POR_ETAPA} páginas: leitura incompleta`);
        const lote = (await kommo.listLeadsPorEtapa(funil.id, etapa.id, 250, pagina)) as CartaoParaData[];
        for (const c of lote) todos.set(c.id, c);
        await dormir(250);
        if (lote.length < 250) break;
      }
    }
  }
  return [...todos.values()];
}

async function main(): Promise<void> {
  if (SLUGS.length === 0) throw new Error('falta --unidade=<slug>[,<slug>]');
  console.log(`${APLICAR ? 'GRAVANDO' : 'SIMULAÇÃO (nada será gravado; use --aplicar)'} · ${FECHADOS ? 'todos os cartões' : 'só cartões ativos'}\n`);

  for (const slug of SLUGS) {
    const unit = await prisma.unit.findUnique({ where: { slug } });
    if (!unit?.kommoSubdomain || !unit.kommoAccessToken) {
      console.log(`!! ${slug}: unidade ou credencial do Kommo ausente`);
      continue;
    }
    const kommo = createKommoClient(unit);
    const campos = await kommo.listarCamposDoCartao();
    let cartoes: CartaoParaData[];
    try {
      cartoes = await lerTodosOsCartoes(kommo, FECHADOS);
    } catch (err) {
      console.log(`=== ${slug}\n  !! leitura do Kommo falhou, NADA foi planejado nem gravado: ${String(err).slice(0, 160)}\n`);
      continue;
    }
    const plano = planejarDataDoPrimeiroContato(cartoes, campos, FECHADOS);
    console.log(`=== ${slug} — ${cartoes.length} cartões lidos`);
    if (!plano.campo || plano.semCampo) {
      console.log(`  nada a fazer: ${plano.semCampo}\n`);
      continue;
    }
    console.log(
      `  campo ${plano.campo.id} (${plano.campo.type}) · ${plano.gravar.length} ${APLICAR ? 'a gravar' : 'seriam gravados'} · ${plano.jaTinham} já tinham · ${plano.semCriacao} sem data de criação · ${plano.fechadosIgnorados} fechados ignorados`,
    );
    for (const g of plano.gravar.slice(0, 10)) console.log(`    ${g.leadId}  → ${new Date(g.epoch * 1000).toISOString()}`);
    if (plano.gravar.length > 10) console.log(`    … e mais ${plano.gravar.length - 10}`);

    if (!APLICAR) {
      console.log('');
      continue;
    }
    let gravados = 0;
    let mudaramNoMeio = 0;
    let erros = 0;
    for (const g of plano.gravar) {
      try {
        const agora = await kommo.getLead(g.leadId);
        const jaTem = (agora.custom_fields_values ?? []).find((f) => f.field_id === plano.campo!.id)?.values?.[0]?.value;
        if (jaTem !== null && jaTem !== undefined && jaTem !== '' && jaTem !== 0) {
          mudaramNoMeio++;
          continue;
        }
        await kommo.gravarCamposDoLead(g.leadId, [{ field_id: plano.campo.id, values: [{ value: g.epoch }] }]);
        gravados++;
      } catch (err) {
        erros++;
        console.log(`  ! ${g.leadId}: ${String(err).slice(0, 100)}`);
      }
      await dormir(PAUSA_MS);
    }
    console.log(`  → ${gravados} gravados · ${mudaramNoMeio} preenchidos por outro no meio · ${erros} erros\n`);
    if (gravados > 0) {
      await addChangeLog(unit.id, {
        category: 'kommo',
        summary: `"Data do primeiro contato" preenchida com a criação do cartão em ${gravados} cartões (retroativo)`,
      });
    }
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());

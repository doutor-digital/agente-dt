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
import { planejarDataDoPrimeiroContato, type CartaoParaData } from '../lib/data-primeiro-contato-retroativo.js';

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
    const cartoes = (await kommo.listLeads(40)) as CartaoParaData[];
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

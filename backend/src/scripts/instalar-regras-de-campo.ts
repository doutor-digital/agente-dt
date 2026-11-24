/**
 * Instala as regras de captura (`lead_field_rules`) de uma unidade-modelo (Timbó) em outras unidades, resolvendo cada campo
 * PELO NOME na conta Kommo de destino. Ver `lib/regras-de-campo-por-nome.ts` para as regras de decisão.
 *
 * Por que existe: Salto e Tatuí estão com ZERO regras (24/11/2026). A Sofia não recebe ferramenta de gravar e o
 * `backfill-campos` não tem o que usar.
 *
 * ATENÇÃO — isto liga a captura AO VIVO: com a regra instalada, a Sofia daquela unidade passa a gravar Queixa, Qualificação,
 * Região da dor etc. a partir da próxima conversa. Por isso o padrão instala só as regras que uma conversa responde (as mesmas
 * do backfill); `--todas` copia TODAS as habilitadas do modelo (pagamento, situação da consulta, opt-out...) e muda mais o
 * comportamento da IA — só com ok explícito.
 *
 * Simula por padrão. Só grava com --aplicar. Idempotente: regra que a unidade já tem (mesma ferramenta ou mesmo campo) não é
 * duplicada. Não toca em regra existente, não apaga nada, não escreve no Kommo (só LÊ os campos da conta).
 *
 *   node dist/scripts/instalar-regras-de-campo.js --unidade=doutor-hernia-salto,doutor-hernia-tatui
 *   node dist/scripts/instalar-regras-de-campo.js --unidade=doutor-hernia-salto,doutor-hernia-tatui --aplicar
 *   opções: --modelo=doutor-hernia-timbo  --todas  --sem=<parte do nome>[,<parte>]   (ex.: --sem=motivo não instala "Motivo do não agendamento")
 */
import { prisma } from '../lib/prisma.js';
import { createKommoClient } from '../services/kommo.service.js';
import { createLeadFieldRule } from '../services/lead-field-rules.service.js';
import { addChangeLog } from '../services/change-log.service.js';
import { DA_CONVERSA } from '../lib/backfill-campos-regras.js';
import { normalizar } from '../lib/franquia-sync.js';
import { planejarRegras, type ModeloDeRegra } from '../lib/regras-de-campo-por-nome.js';

const APLICAR = process.argv.includes('--aplicar');
const TODAS = process.argv.includes('--todas');
const arg = (nome: string) => (process.argv.find((a) => a.startsWith(`--${nome}=`)) ?? '').split('=').slice(1).join('=');
const SLUGS = arg('unidade')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const SLUG_MODELO = arg('modelo') || 'doutor-hernia-timbo';
const SEM = arg('sem')
  .split(',')
  .map((s) => normalizar(s))
  .filter(Boolean);

async function main(): Promise<void> {
  if (SLUGS.length === 0) throw new Error('falta --unidade=<slug>[,<slug>]');
  if (SLUGS.includes(SLUG_MODELO)) throw new Error(`${SLUG_MODELO} é a unidade-modelo: não instalo regras nela mesma`);

  const modeloUnit = await prisma.unit.findUnique({ where: { slug: SLUG_MODELO } });
  if (!modeloUnit) throw new Error(`unidade-modelo ${SLUG_MODELO} não existe`);
  const todas = await prisma.leadFieldRule.findMany({ where: { unitId: modeloUnit.id, enabled: true }, orderBy: { createdAt: 'asc' } });
  const modelo: ModeloDeRegra[] = todas
    .filter((r) => TODAS || DA_CONVERSA.test(r.kommoFieldName))
    .filter((r) => !SEM.some((parte) => normalizar(r.kommoFieldName).includes(parte)));
  console.log(
    `${APLICAR ? 'GRAVANDO' : 'SIMULAÇÃO (nada será gravado; use --aplicar)'} · modelo ${SLUG_MODELO}: ${modelo.length} de ${todas.length} regras habilitadas${TODAS ? ' (--todas)' : ' (só as de conversa)'}\n`,
  );

  const resumo: Array<{ slug: string; criar: number; jaExistem: number; deFora: number; gravadas: number }> = [];

  for (const slug of SLUGS) {
    try {
      const unit = await prisma.unit.findUnique({ where: { slug } });
      if (!unit) {
        console.log(`!! unidade ${slug} não existe`);
        continue;
      }
      if (!unit.kommoSubdomain || !unit.kommoAccessToken) {
        console.log(`!! ${slug}: sem credencial do Kommo — não dá para ler os campos da conta`);
        continue;
      }
      const campos = await createKommoClient(unit).listarCamposDoCartao();
      const existentes = await prisma.leadFieldRule.findMany({ where: { unitId: unit.id }, select: { toolName: true, kommoFieldId: true, enabled: true } });
      const plano = planejarRegras(modelo, campos, existentes);

      console.log(`=== ${slug} — ${campos.length} campos na conta, ${existentes.length} regras já instaladas`);
      for (const r of plano.criar) {
        const op = r.kommoFieldEnums?.length ? ` · ${r.kommoFieldEnums.length} opções` : '';
        console.log(`  + ${r.kommoFieldName}  [${r.kommoFieldType}${op}]  campo ${r.kommoFieldId}  ferramenta ${r.toolName}`);
      }
      for (const a of plano.avisos) {
        console.log(`  ? ${a.nome}: opções do modelo que a conta NÃO tem: ${a.soNoModelo.join(' | ')}  (a conta tem: ${a.naConta.join(' | ')})`);
      }
      for (const j of plano.jaExistem) console.log(`  = ${j.nome}: já existe (${j.porque})${j.desligada ? ' — DESLIGADA na tela, não religo' : ''}`);
      for (const f of plano.deFora) console.log(`  - ${f.nome}: FICA DE FORA — ${f.motivo}${f.detalhe ? ` (${f.detalhe})` : ''}`);

      let gravadas = 0;
      if (APLICAR) {
        for (const r of plano.criar) {
          try {
            await createLeadFieldRule(unit.id, r);
            gravadas++;
          } catch (err) {
            // corrida (alguém criou a mesma ferramenta no meio): a restrição única do banco segura, e a próxima rodada vê "já existe"
            console.log(`  ! ${r.kommoFieldName}: ${String(err).slice(0, 120)}`);
          }
        }
        if (gravadas > 0) {
          await addChangeLog(unit.id, {
            category: 'kommo',
            summary: `Regras de captura instaladas a partir de ${SLUG_MODELO}: ${gravadas}`,
            details: plano.criar.map((r) => `${r.kommoFieldName} (${r.toolName})`).join('\n'),
          });
        }
      }
      resumo.push({ slug, criar: plano.criar.length, jaExistem: plano.jaExistem.length, deFora: plano.deFora.length, gravadas });
      console.log('');
    } catch (err) {
      console.log(`!! ${slug}: falhou, passo para a próxima unidade: ${String(err).slice(0, 200)}`);
      process.exitCode = 1;
    }
  }

  console.log('RESUMO');
  for (const r of resumo) {
    console.log(
      `  ${r.slug}: ${APLICAR ? `${r.gravadas} gravadas (de ${r.criar} planejadas)` : `${r.criar} regras GRAVARIA`} · ${r.jaExistem} já existiam · ${r.deFora} ficaram de fora`,
    );
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());

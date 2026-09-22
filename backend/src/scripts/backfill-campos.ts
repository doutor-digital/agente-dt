/**
 * Preenche, nos cartões antigos, os campos que a Sofia deveria ter gravado.
 *
 * Por que existe: em 22/09/2026 descobrimos que cinco unidades nunca tiveram as
 * regras de captura instaladas — Bebedouro e Mossoró com ZERO, Rio Verde com 3,
 * Olímpia 8, Taubaté 9, contra as 32 do padrão. Sem regra, a IA não recebe a
 * ferramenta de gravar, então ela conversava bem e não tinha onde anotar. Em 7
 * dias foram 622 leads atendidos sem um único campo preenchido.
 *
 * As regras já foram instaladas e valem daqui pra frente. Isto aqui é o passado:
 * 3.319 conversas guardadas no nosso histórico (25/07 a 22/09) que podem virar
 * campo no cartão.
 *
 * COMO DECIDE O QUE GRAVAR: usa as MESMAS `lead_field_rules` que a IA usa ao
 * vivo — mesmo campo, mesma instrução, mesmas opções de select. Assim o
 * retroativo preenche exatamente o que ela teria preenchido, e não uma segunda
 * interpretação que ninguém revisou.
 *
 * O QUE NUNCA FAZ:
 *   - não sobrescreve campo que já tem valor (humano ou IA);
 *   - não inventa: o que a conversa não disser fica null e não é gravado;
 *   - em campo de lista, só aceita opção que existe naquela conta.
 *
 * Modo simulação por padrão. Só grava com --aplicar.
 *
 *   node dist/scripts/backfill-campos.js --unidade=doutor-hernia-bebedouro --limite=10
 *   node dist/scripts/backfill-campos.js --unidade=doutor-hernia-bebedouro --aplicar
 */
import type { LeadFieldRule, Unit } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { createKommoClient, type KommoFieldType } from '../services/kommo.service.js';

const APLICAR = process.argv.includes('--aplicar');
const arg = (nome: string) => (process.argv.find((a) => a.startsWith(`--${nome}=`)) ?? '').split('=')[1] ?? '';
const SLUG = arg('unidade');
const LIMITE = Number(arg('limite')) || Infinity;
const MODELO = arg('modelo') || 'claude-haiku-4-5-20251001';
/** Quantas conversas por chamada. Agrupar faz a instrução viajar uma vez, não dez. */
const LOTE = Number(arg('lote')) || 10;

/**
 * Campos que uma CONVERSA pode responder. Os outros da régua (data de pagamento,
 * situação da consulta, motivo da espera) são operacionais: quem sabe é a agenda
 * ou a recepção, não o texto — e chutar neles sujaria o relatório em vez de
 * enriquecê-lo.
 *
 * "Preferência de horário" ficou DE FORA por outro motivo: na amostra ele voltava
 * com data concreta e vencida ("17 de setembro às 14h"). Gravar isso hoje não
 * informa, engana — a recepção lê como se fosse o que a pessoa quer agora.
 */
const DA_CONVERSA = /queixa|qualifica|sexo|cidade|bairro|estado|profiss|plano|tipo de lead|regi[ãa]o|tempo|idade|motivo do n[ãa]o/i;

interface Conversa {
  leadId: number;
  texto: string;
}

async function conversasSemCampo(unit: Unit, limite: number): Promise<Conversa[]> {
  const linhas = await prisma.$queryRawUnsafe<Array<{ lead_id: string; texto: string }>>(
    `
    with alvo as (
      select t.lead_id,
             count(*) filter (where s.kind = 'WEBHOOK_RECEIVED') as msgs,
             bool_or(s.kind = 'KOMMO_ACTION' and (s.title like '%✎ Queixa%' or s.title like '%Qualificação%' or s.title like '%⚥ Sexo%')) as ja
      from execution_traces t
      join execution_steps s on s.trace_id = t.id
      where t.unit_id = $1 and t.lead_id is not null
      group by t.lead_id
    )
    select a.lead_id,
           string_agg(regexp_replace(s.title, '^[^:]*: ', ''), E'\\n' order by s.created_at) as texto
    from alvo a
    join execution_traces t on t.lead_id = a.lead_id and t.unit_id = $1
    join execution_steps s on s.trace_id = t.id
    where a.msgs >= 3 and not a.ja
      and (s.kind = 'WEBHOOK_RECEIVED' or s.title like '%Áudio transcrito%')
    group by a.lead_id
    limit $2
    `,
    unit.id,
    Math.min(limite, 100000),
  );
  return linhas
    .map((l) => ({ leadId: Number(l.lead_id), texto: (l.texto ?? '').slice(0, 3000) }))
    .filter((c) => Number.isFinite(c.leadId) && c.texto.trim().length > 30);
}

/** A régua vira instrução de extração: nome do campo, o que é, e as opções válidas. */
function instrucaoDasRegras(regras: LeadFieldRule[]): string {
  return regras
    .map((r) => {
      const enums = ((r.kommoFieldEnums as Array<{ value: string }> | null) ?? [])
        .map((e) => e.value)
        .filter(Boolean);
      const opcoes = enums.length ? `\n    opções válidas (use EXATAMENTE uma delas): ${enums.join(' | ')}` : '';
      const dica = r.valueHint ? `\n    formato: ${r.valueHint}` : '';
      return `- "${r.kommoFieldName}": ${r.instruction}${dica}${opcoes}`;
    })
    .join('\n');
}

const SISTEMA = `Você lê conversas de WhatsApp entre uma clínica de coluna e pacientes, e extrai
campos de cadastro do que o paciente REALMENTE disse.

REGRA MAIS IMPORTANTE: o que a conversa não disser, você devolve null. Não deduza,
não estime, não complete. Um campo vazio é melhor que um campo errado — esses dados
viram relatório e decisão de gente.

ANTES DE EXTRAIR QUALQUER COISA, pergunte-se: isto é um PACIENTE procurando
tratamento? Muita conversa no CRM não é. Devolva TODOS os campos null quando for:
- equipe da clínica conversando entre si (cita nome de colega, "abre o chamado",
  link de reunião, combinação interna);
- só confirmação de horário, sem a pessoa contar nada ("pode confirmar", "ok");
- mensagem solta, engano, número errado, propaganda.
Nesses casos o cartão vazio é a informação correta.

Devolva SÓ um array JSON, um objeto por conversa, na mesma ordem em que receber:
[{"leadId": 123, "campos": {"Nome do campo": "valor", "Outro": null}}]`;

interface Extracao {
  leadId: number;
  campos: Record<string, string | null>;
}

async function extrair(unit: Unit, regras: LeadFieldRule[], lote: Conversa[]): Promise<Extracao[]> {
  const chave = unit.anthropicApiKey ?? process.env.ANTHROPIC_API_KEY;
  if (!chave) throw new Error(`${unit.slug}: sem chave da Anthropic`);

  const corpo = lote
    .map((c) => `### CONVERSA leadId=${c.leadId}\n${c.texto}`)
    .join('\n\n');

  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': chave, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({
      model: MODELO,
      max_tokens: 4000,
      system: SISTEMA,
      messages: [
        {
          role: 'user',
          content: `CAMPOS A EXTRAIR:\n${instrucaoDasRegras(regras)}\n\n${corpo}`,
        },
      ],
    }),
  });
  const data = (await resp.json()) as { content?: Array<{ text?: string }>; error?: unknown };
  if (data.error) throw new Error(`Anthropic: ${JSON.stringify(data.error).slice(0, 200)}`);
  const txt = (data.content ?? []).map((c) => c.text ?? '').join('');
  const m = txt.match(/\[[\s\S]*\]/);
  if (!m) return [];
  try {
    return JSON.parse(m[0]) as Extracao[];
  } catch {
    return [];
  }
}

/** Só aceita opção que existe naquela conta — o modelo às vezes inventa um rótulo parecido. */
function valorValido(regra: LeadFieldRule, bruto: string): string | null {
  const v = String(bruto ?? '').trim();
  if (!v || v.toLowerCase() === 'null') return null;
  const enums = ((regra.kommoFieldEnums as Array<{ value: string }> | null) ?? []).map((e) => e.value);
  if (enums.length === 0) return v;
  const casa = enums.find((e) => e.toLowerCase() === v.toLowerCase());
  return casa ?? null;
}

async function main(): Promise<void> {
  const unidades = SLUG
    ? await prisma.unit.findMany({ where: { slug: SLUG } })
    : await prisma.unit.findMany({ where: { isActive: true, kommoAccessToken: { not: null } }, orderBy: { slug: 'asc' } });

  console.log(`modo ${APLICAR ? 'APLICAR' : 'SIMULAÇÃO'} · modelo ${MODELO} · lotes de ${LOTE}\n`);

  for (const unit of unidades) {
    const regras = (await prisma.leadFieldRule.findMany({ where: { unitId: unit.id, enabled: true } })).filter((r) =>
      DA_CONVERSA.test(r.kommoFieldName),
    );
    if (regras.length === 0) {
      console.log(`${unit.slug}: sem regras de conversa — pulando`);
      continue;
    }

    const conversas = await conversasSemCampo(unit, LIMITE);
    if (conversas.length === 0) {
      console.log(`${unit.slug}: nada a preencher`);
      continue;
    }
    console.log(`\n=== ${unit.slug} — ${conversas.length} conversas, ${regras.length} campos ===`);

    const kommo = createKommoClient(unit);
    const porNome = new Map(regras.map((r) => [r.kommoFieldName.toLowerCase(), r]));
    let gravados = 0;
    let pulados = 0;

    for (let i = 0; i < conversas.length; i += LOTE) {
      const lote = conversas.slice(i, i + LOTE);
      let extracoes: Extracao[] = [];
      try {
        extracoes = await extrair(unit, regras, lote);
      } catch (err) {
        console.log(`  ! lote ${i / LOTE + 1} falhou: ${String(err).slice(0, 120)}`);
        continue;
      }

      for (const ex of extracoes) {
        const lead = await kommo.getLead(ex.leadId).catch(() => null);
        if (!lead) continue;
        const preenchidos = new Set(
          ((lead as { custom_fields_values?: Array<{ field_id: number; values?: Array<{ value?: unknown }> }> })
            .custom_fields_values ?? [])
            .filter((f) => {
              const v = (f.values ?? [{}])[0]?.value;
              return v !== null && v !== undefined && v !== '';
            })
            .map((f) => f.field_id),
        );

        // Qualificação sem queixa é chute: se a pessoa não contou a dor, não há
        // base pra dizer se ela é quente. Na amostra de 22/09 o modelo carimbou
        // "Quente" em conversa da equipe interna — o guarda aqui embaixo é o que
        // impede isso de virar 3.319 cartões com qualificação inventada.
        const temQueixa = Object.entries(ex.campos ?? {}).some(
          ([nome, v]) => /queixa/i.test(nome) && v != null && String(v).trim() !== '',
        );

        const aGravar: Array<{ regra: LeadFieldRule; valor: string }> = [];
        for (const [nome, bruto] of Object.entries(ex.campos ?? {})) {
          const regra = porNome.get(String(nome).toLowerCase());
          if (!regra || bruto == null) continue;
          if (!temQueixa && /qualifica/i.test(regra.kommoFieldName)) continue;
          if (preenchidos.has(regra.kommoFieldId)) {
            pulados++;
            continue; // já tem valor — nunca sobrescrevo
          }
          const valor = valorValido(regra, String(bruto));
          if (valor) aGravar.push({ regra, valor });
        }
        if (aGravar.length === 0) continue;

        console.log(
          `  ${String(ex.leadId).padEnd(9)} ${aGravar.map((g) => `${g.regra.kommoFieldName}="${g.valor.slice(0, 28)}"`).join(' · ')}`,
        );
        if (APLICAR) {
          for (const g of aGravar) {
            await kommo
              .setLeadCustomFieldValue(
                ex.leadId,
                g.regra.kommoFieldId,
                g.regra.kommoFieldType as KommoFieldType,
                g.valor,
                ((g.regra.kommoFieldEnums as Array<{ id: number; value: string }> | null) ?? []),
              )
              .catch((err) => console.log(`     ! ${g.regra.kommoFieldName}: ${String(err).slice(0, 90)}`));
            await new Promise((r) => setTimeout(r, 160));
          }
          gravados += aGravar.length;
        } else {
          gravados += aGravar.length;
        }
      }
    }
    console.log(`  → ${gravados} campos ${APLICAR ? 'gravados' : 'seriam gravados'} · ${pulados} pulados (já tinham valor)`);
  }
  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

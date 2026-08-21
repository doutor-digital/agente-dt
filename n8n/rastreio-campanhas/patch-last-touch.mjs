#!/usr/bin/env node
/**
 * Patches sobre o workflow nativo em produção (`producao/4T4HALkkLJtcNAY1.json`),
 * aplicados em 2026-08-19 depois de auditar um lead orgânico real:
 *
 * 1. **Tag condicional.** A tag era fixa (`Origem: Anuncio pago`) e caía também em
 *    lead que veio de post/Reel orgânico — inflando "lead pago" no relatório.
 * 2. **Erro de Graph em orgânico não é erro.** Post não tem campo `campaign`, então
 *    a Graph responde `(#100) Tried accessing nonexisting field (campaign)`. Isso
 *    virava "Falha ao consultar a Graph API" na nota do lead e parecia defeito.
 * 3. **Last-touch.** Além do first-touch (que nunca é sobrescrito), todo clique passa
 *    a gravar `⌂ Último anúncio` (2446113) e incrementar `⌂ Cliques no anúncio`
 *    (2446115), e a deixar uma nota — é o histórico de cliques dentro do lead.
 * 4. **Log de preservados.** O log gravava só `gravados`. Sem `preservados` não dá
 *    para explicar por que um campo ficou com valor antigo — foi exatamente o dado
 *    que faltou para diagnosticar o `⚑ Origem` errado sem adivinhação.
 *
 * Uso: node patch-last-touch.mjs   →  escreve rastreio-campanhas-nativo.json
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const aqui = dirname(fileURLToPath(import.meta.url));
const entrada = resolve(aqui, 'producao/4T4HALkkLJtcNAY1.json');
const saidaPath = resolve(aqui, 'rastreio-campanhas-nativo.json');

/** Cada patch precisa casar EXATAMENTE uma vez, senão o script aborta. */
const PATCHES = [
  {
    no: 'Config',
    porque: 'ids dos campos de last-touch + tag de orgânico',
    de: `    imagemAnuncio:   inteiro($env.KOMMO_CF_IMAGEM_ANUNCIO) || 2444385,`,
    para: `    imagemAnuncio:   inteiro($env.KOMMO_CF_IMAGEM_ANUNCIO) || 2444385,
    // Last-touch: gravados em TODO clique, sem violar o first-touch dos demais.
    // Criados em 19/08/2026; fallback fixo porque a env var ainda nao foi aplicada
    // (aplicar env var reinicia os 3 servicos do n8n — vale juntar com outra mudanca).
    ultimoAnuncio:   inteiro($env.KOMMO_CF_ULTIMO_ANUNCIO) || 2446113,
    cliques:         inteiro($env.KOMMO_CF_CLIQUES) || 2446115,`,
  },
  {
    no: 'Config',
    porque: 'tag separada para origem orgânica',
    de: `  tagOrigem: $env.KOMMO_TAG_ORIGEM || 'Origem: Anuncio pago',`,
    para: `  tagOrigem: $env.KOMMO_TAG_ORIGEM || 'Origem: Anuncio pago',
  // Reel/post organico NAO e anuncio pago. Marcar os dois com a mesma tag infla o
  // numero de "leads pagos" no relatorio e distorce a avaliacao da verba.
  tagOrganico: $env.KOMMO_TAG_ORGANICO || 'Origem: Organico',`,
  },
  {
    no: 'Normalizar atribuicao',
    porque: 'erro de Graph em post orgânico é esperado, não é falha',
    de: `  const erroGraph = g.error
    ? String((g.error && (g.error.message || g.error.error_user_msg)) || g.error).slice(0, 500)
    : null;
  const ad = erroGraph ? {} : g;`,
    para: `  // Post organico (source_type = 'post') nao tem campanha: perguntar \`campaign\` a
  // Graph devolve "(#100) Tried accessing nonexisting field (campaign)". E esperado,
  // nao e defeito — nao vira erroGraph e nao suja a nota do lead com falso alarme.
  const ehAnuncio = (ref.sourceType || 'ad') === 'ad';
  const erroBruto = g.error
    ? String((g.error && (g.error.message || g.error.error_user_msg)) || g.error).slice(0, 500)
    : null;
  const erroGraph = ehAnuncio ? erroBruto : null;
  const ad = erroBruto ? {} : g;`,
  },
  {
    no: 'Montar PATCH (first-touch)',
    porque: 'last-touch (último anúncio + contador) e tag condicional',
    de: `const patchBody = {};
if (custom.length) patchBody.custom_fields_values = custom;
// tags_to_add vai na RAIZ do body. Dentro de _embedded o Kommo aceita a
// requisicao e ignora silenciosamente (200 OK, tag nao aplicada).
if (cfg.tagOrigem) patchBody.tags_to_add = [{ name: cfg.tagOrigem }];

const temAlgoParaGravar = custom.length > 0;`,
    para: `// LAST-TOUCH — gravado em todo clique, por cima do valor anterior. Nao conflita
// com o first-touch: sao campos proprios, e os campos de first-touch acima seguem
// intocados. E o que responde "de qual anuncio ele veio DESTA vez".
const anuncioAtual = a.anuncioNome || a.anuncioId || null;
const cliquesAntes = Number(atuais.get(cfg.campos.cliques) || 0);
const cliquesAgora = (Number.isFinite(cliquesAntes) ? cliquesAntes : 0) + 1;

if (cfg.campos.ultimoAnuncio && anuncioAtual) {
  custom.push({ field_id: cfg.campos.ultimoAnuncio, values: [{ value: anuncioAtual }] });
}
if (cfg.campos.cliques) {
  custom.push({ field_id: cfg.campos.cliques, values: [{ value: cliquesAgora }] });
}

const patchBody = {};
if (custom.length) patchBody.custom_fields_values = custom;
// tags_to_add vai na RAIZ do body. Dentro de _embedded o Kommo aceita a
// requisicao e ignora silenciosamente (200 OK, tag nao aplicada).
// Pago e organico levam tags DIFERENTES — ver comentario em Config.
const tagEscolhida = a.pago ? cfg.tagOrigem : cfg.tagOrganico;
if (tagEscolhida) patchBody.tags_to_add = [{ name: tagEscolhida }];

// Com o last-touch sempre presente, o ramo "nada a gravar" deixa de existir:
// todo clique atualiza contador e deixa nota. O que era preservado continua
// preservado — e agora aparece no log (ver no 'Log — sucesso').
const temAlgoParaGravar = custom.length > 0;`,
  },
  {
    no: 'Montar PATCH (first-touch)',
    porque: '⚑ Origem: corrige valor posto por outro mecanismo',
    de: `// LAST-TOUCH — gravado em todo clique, por cima do valor anterior.`,
    para: `// ⚑ ORIGEM — exceção deliberada ao first-touch, restrita ao erro que causa dano.
// O que importa nesse campo é a FAMÍLIA: Meta-* = veio de anúncio pago, Org-* = veio
// de post/Reel orgânico. Marcar orgânico como pago infla o resultado da verba; o
// contrário esconde retorno de anúncio. O \`referral\` da Meta é evidência dura de
// como ESTE lead chegou, então ele corrige conflito de família.
//
// Duas assimetrias de propósito:
//  - orgânico -> pago sempre pode: referral de anúncio (source_type='ad') é prova.
//  - pago -> orgânico SÓ se não houver campanha gravada. Campanha preenchida
//    significa anúncio pago rastreado antes; um clique orgânico posterior não pode
//    apagar esse first-touch.
// Diferença dentro da mesma família (Meta-Facebook x Meta-Instagram) não é tocada:
// não muda decisão de verba e first-touch continua mandando.
const corrigidos = [];
if (cfg.campos.origemTipo && a.origemTipo && preservados.includes('origemTipo')) {
  const origemAtual = String(atuais.get(cfg.campos.origemTipo) || '');
  const familiaAtual = /^Meta-/.test(origemAtual) ? 'pago'
                     : (/^Org-/.test(origemAtual) ? 'organico' : null);
  const familiaReal = a.pago ? 'pago' : 'organico';
  const temCampanha = !!atuais.get(cfg.campos.campanha);
  const conflito = !!familiaAtual && familiaAtual !== familiaReal;

  if (conflito && (familiaReal === 'pago' || !temCampanha)) {
    custom.push({ field_id: cfg.campos.origemTipo, values: [{ value: a.origemTipo }] });
    corrigidos.push('origem: ' + origemAtual + ' -> ' + a.origemTipo);
    preservados.splice(preservados.indexOf('origemTipo'), 1);
  }
}

// LAST-TOUCH — gravado em todo clique, por cima do valor anterior.`,
  },
  {
    no: 'Montar PATCH (first-touch)',
    porque: 'nota vira histórico de clique, com número do toque',
    de: `const nota =
  'Atribuicao de origem (CTWA) — ' + (a.pago ? 'ANUNCIO PAGO' : 'ORGANICO (' + (a.tipoCru || '-') + ')') + '\\n' +`,
    para: `const nota =
  (cliquesAgora > 1 ? 'Clique nº ' + cliquesAgora + ' deste lead — ' : 'Primeiro clique — ') +
  'Atribuicao de origem (CTWA) — ' + (a.pago ? 'ANUNCIO PAGO' : 'ORGANICO (' + (a.tipoCru || '-') + ')') + '\\n' +`,
  },
  {
    no: 'Montar PATCH (first-touch)',
    porque: 'expõe preservados/corrigidos no retorno, para o log gravar',
    de: `return [{ json: { ...ctx, patchBody, temAlgoParaGravar, gravados, preservados, nota } }];`,
    para: `return [{ json: { ...ctx, patchBody, temAlgoParaGravar, gravados, preservados, corrigidos, cliquesAgora, nota } }];`,
  },
];

/** O log gravava só `gravados`; sem `preservados` não dá para explicar campo antigo. */
const PATCH_LOG = {
  no: 'Log — sucesso',
  porque: 'registrar preservados e o número do clique',
  de: `"gravados: " + (c.gravados || []).join(", ")`,
  para: `"clique #" + (c.cliquesAgora || 1) + " | gravados: " + (c.gravados || []).join(", ") + " | preservados: " + ((c.preservados || []).join(", ") || "nenhum") + ((c.corrigidos || []).length ? " | CORRIGIDO: " + c.corrigidos.join(", ") : "")`,
};

const wf = JSON.parse(readFileSync(entrada, 'utf8'));
const acharNo = (nome) => {
  const no = wf.nodes.find((n) => n.name === nome);
  if (!no) throw new Error(`Nó não encontrado: ${nome}`);
  return no;
};

for (const p of PATCHES) {
  const no = acharNo(p.no);
  const antes = no.parameters.jsCode;
  const ocorrencias = antes.split(p.de).length - 1;
  if (ocorrencias !== 1) {
    throw new Error(`Patch "${p.porque}" casou ${ocorrencias}x em "${p.no}" (esperado 1). O nó mudou?`);
  }
  no.parameters.jsCode = antes.replace(p.de, p.para);
  console.log(`ok  ${p.no} — ${p.porque}`);
}

{
  const no = acharNo(PATCH_LOG.no);
  const antes = no.parameters.options.queryReplacement;
  const ocorrencias = antes.split(PATCH_LOG.de).length - 1;
  if (ocorrencias !== 1) {
    throw new Error(`Patch do log casou ${ocorrencias}x (esperado 1). O nó mudou?`);
  }
  no.parameters.options.queryReplacement = antes.replace(PATCH_LOG.de, PATCH_LOG.para);
  console.log(`ok  ${PATCH_LOG.no} — ${PATCH_LOG.porque}`);
}

writeFileSync(saidaPath, `${JSON.stringify({ ...wf, active: undefined }, null, 2)}\n`);
console.log(`\nescrito: ${saidaPath}`);

import { BANCO } from './banco.js';
import { rodarBanco, type ResultadoDoCaso } from './runner.js';

/**
 * `npm run eval` — roda o banco de conversas douradas contra a IA de verdade.
 *
 *   npm run eval                                  todos os casos, uma passada
 *   npm run eval -- --repeticoes 3                três passadas (pega instabilidade)
 *   npm run eval -- --caso objecao-vou-pensar     um caso só
 *   npm run eval -- --unidade doutor-hernia-porto uma unidade só
 *   npm run eval -- --json                        saída para script
 *   npm run eval -- --prompt-da-unidade           usa o playbook escrito na unidade
 *
 * Sai com código 1 se algum caso reprovar, para poder travar um deploy.
 */

const argv = process.argv.slice(2);
const opt = (nome: string): string | undefined => {
  const i = argv.indexOf(`--${nome}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const flag = (nome: string) => argv.includes(`--${nome}`);

const filtroCaso = opt('caso');
const filtroUnidade = opt('unidade');
const repeticoes = Number(opt('repeticoes') ?? 1);
const comoJson = flag('json');
// Compara o comportamento de hoje com o de quando o playbook da unidade chega
// ao modelo. Ver `promptDaUnidade` no runner.
const promptDaUnidade = flag('prompt-da-unidade');

const casos = BANCO.filter(
  (c) => (!filtroCaso || c.id === filtroCaso) && (!filtroUnidade || c.unidade === filtroUnidade),
);

if (casos.length === 0) {
  console.error('Nenhum caso bate com esse filtro. Casos disponíveis:');
  for (const c of BANCO) console.error(`  ${c.id}  (${c.unidade})`);
  process.exit(2);
}

const recorta = (s: string, n = 240) =>
  s.replace(/\s+/g, ' ').trim().slice(0, n) + (s.length > n ? '…' : '');

function imprimir(r: ResultadoDoCaso) {
  const marca = r.passou ? '✔' : '✖';
  console.log(`${marca} ${r.caso}  (${r.unidade}, ${Math.round(r.ms)}ms)`);
  if (r.passou && !r.guardrailAgiu) return;

  if (r.guardrailAgiu) {
    console.log('    ⚠ o guardrail precisou reescrever a resposta');
  }
  for (const f of r.falhas) {
    console.log(`    → ${f.regra}: ${f.detalhe}`);
  }
  if (r.ferramentas.length > 0) {
    console.log(`    ferramentas: ${r.ferramentas.join(', ')}`);
  }
  if (r.texto) {
    console.log(`    disse: "${recorta(r.texto)}"`);
  }
}

const resultados = await rodarBanco(casos, {
  repeticoes,
  promptDaUnidade,
  aoTerminar: comoJson ? undefined : imprimir,
});

if (comoJson) {
  console.log(JSON.stringify(resultados, null, 2));
} else {
  const passaram = resultados.filter((r) => r.passou).length;
  console.log(`\n${passaram}/${resultados.length} passaram`);

  // Um caso que passa numa volta e reprova na outra é pior que um que reprova
  // sempre: em produção ele é o paciente atendido de um jeito hoje e de outro
  // amanhã, e ninguém consegue reproduzir a reclamação.
  if (repeticoes > 1) {
    const porCaso = new Map<string, boolean[]>();
    for (const r of resultados) porCaso.set(r.caso, [...(porCaso.get(r.caso) ?? []), r.passou]);
    const instaveis = [...porCaso].filter(([, v]) => v.includes(true) && v.includes(false));
    if (instaveis.length > 0) {
      console.log('\ninstáveis (passam às vezes):');
      for (const [id, v] of instaveis) {
        console.log(`  ${id}: ${v.filter(Boolean).length}/${v.length}`);
      }
    }
  }

  const porRegra = new Map<string, number>();
  for (const r of resultados) {
    for (const f of r.falhas) porRegra.set(f.regra, (porRegra.get(f.regra) ?? 0) + 1);
  }
  if (porRegra.size > 0) {
    console.log('\nfalhas por regra:');
    for (const [regra, n] of [...porRegra].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${n.toString().padStart(3)}  ${regra}`);
    }
  }
}

process.exit(resultados.some((r) => !r.passou) ? 1 : 0);

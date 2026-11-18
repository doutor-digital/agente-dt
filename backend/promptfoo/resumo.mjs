// Resumo de uma rodada do Promptfoo (o JSON de `promptfoo eval -o resultado.json`), em dois formatos:
//   node promptfoo/resumo.mjs <resultado.json> markdown          -> tabela para o resumo do GitHub Actions
//   node promptfoo/resumo.mjs <resultado.json> telegram [link]   -> texto curto para o Telegram do João (≤ 3.500 caracteres)
// Sai com código 1 quando a rodada não tem NENHUM resultado: "0/0 passaram" não é verde.
// Sem dependência: roda com o Node da imagem de produção.
import { readFileSync } from 'node:fs';

const [arquivo, formato = 'markdown', link = ''] = process.argv.slice(2);
const bruto = JSON.parse(readFileSync(arquivo, 'utf8'));
const linhas = bruto.results?.results ?? [];

const corta = (s, n) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

// failureReason do Promptfoo: 1 = reprovou numa asserção, 2 = ERRO de execução (provedor lançou, 429, chave…).
const ERRO = 2;

// Um caso pode rodar várias vezes (--repeat): agrupa por caso.
const porCaso = new Map();
for (const r of linhas) {
  const nome = r.testCase?.description ?? r.vars?.caso ?? '?';
  const v = porCaso.get(nome) ?? { ok: 0, n: 0, erro: 0, motivos: [] };
  v.n++;
  if (r.success) v.ok++;
  else if (r.failureReason === ERRO) v.erro++;
  if (!r.success) {
    const comp = r.gradingResult?.componentResults ?? [];
    const falhas = comp.filter((c) => !c.pass).map((c) => `${c.assertion?.metric ?? '?'}: ${c.reason}`);
    v.motivos.push(falhas.length ? falhas.join(' | ') : (r.response?.error ?? r.error ?? 'sem motivo'));
  }
  porCaso.set(nome, v);
}

const casos = [...porCaso];
const reprovados = casos.filter(([, v]) => v.ok < v.n);
const total = casos.length;

if (formato === 'telegram') {
  const cab = total === 0
    ? '🧪 Sofia — Promptfoo diário: ❌ nenhum caso rodou.'
    : reprovados.length === 0
      ? `🧪 Sofia — Promptfoo diário: ✅ ${total}/${total} casos passaram.`
      : `🧪 Sofia — Promptfoo diário: ⚠️ ${reprovados.length} de ${total} casos reprovaram.`;
  const corpo = reprovados
    .map(([nome, v]) => `• ${nome} — ${v.ok}/${v.n}${v.erro ? ` (${v.erro} erro de execução)` : ''}\n  ${corta(v.motivos[0], 260)}`)
    .join('\n');
  // o link vem logo depois do cabeçalho: o corte de tamanho no fim nunca come o link
  const msg = [cab, link && `Relatório: ${link}`, corpo].filter(Boolean).join('\n\n');
  console.log(msg.length > 3500 ? `${msg.slice(0, 3499)}…` : msg);
} else {
  console.log(`### Promptfoo da Sofia — ${total - reprovados.length}/${total} casos passaram\n`);
  if (total === 0) console.log('**Nenhum caso rodou.**');
  else {
    console.log('| Caso | Passou | Motivo (1ª falha) |\n|---|---|---|');
    for (const [nome, v] of casos) {
      const erro = v.erro ? ` (${v.erro} erro)` : '';
      console.log(`| ${nome} | ${v.ok}/${v.n} ${v.ok === v.n ? '✅' : '❌'}${erro} | ${v.ok === v.n ? '' : corta(v.motivos[0], 300).replace(/\|/g, '/')} |`);
    }
  }
}
process.exit(total === 0 ? 1 : 0);

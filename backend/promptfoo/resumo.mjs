// Resumo de uma rodada do Promptfoo (o JSON de `promptfoo eval -o resultado.json`), em dois formatos:
//   node promptfoo/resumo.mjs <resultado.json> markdown   -> tabela para o resumo do GitHub Actions
//   node promptfoo/resumo.mjs <resultado.json> telegram   -> texto curto para o Telegram do João (≤ 3.500 caracteres)
// Sem dependência: roda com o Node da imagem de produção.
import { readFileSync } from 'node:fs';

const [arquivo, formato = 'markdown', link = ''] = process.argv.slice(2);
const bruto = JSON.parse(readFileSync(arquivo, 'utf8'));
const linhas = bruto.results?.results ?? [];

const corta = (s, n) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

// Um caso pode rodar várias vezes (--repeat): agrupa por caso.
const porCaso = new Map();
for (const r of linhas) {
  const nome = r.testCase?.description ?? r.vars?.caso ?? '?';
  const v = porCaso.get(nome) ?? { ok: 0, n: 0, erro: 0, motivos: [] };
  v.n++;
  if (r.success) v.ok++;
  else if (r.response?.error && !r.gradingResult) v.erro++;
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
  const cab = reprovados.length === 0
    ? `🧪 Sofia — Promptfoo diário: ✅ ${total}/${total} casos passaram.`
    : `🧪 Sofia — Promptfoo diário: ⚠️ ${reprovados.length} de ${total} casos reprovaram.`;
  const corpo = reprovados
    .map(([nome, v]) => `• ${nome} — ${v.ok}/${v.n}${v.erro ? ` (${v.erro} erro de execução)` : ''}\n  ${corta(v.motivos[0], 260)}`)
    .join('\n');
  const msg = [cab, corpo, link && `Relatório: ${link}`].filter(Boolean).join('\n\n');
  console.log(msg.length > 3500 ? `${msg.slice(0, 3499)}…` : msg);
} else {
  console.log(`### Promptfoo da Sofia — ${total - reprovados.length}/${total} casos passaram\n`);
  console.log('| Caso | Passou | Motivo (1ª falha) |\n|---|---|---|');
  for (const [nome, v] of casos) {
    console.log(`| ${nome} | ${v.ok}/${v.n} ${v.ok === v.n ? '✅' : '❌'} | ${v.ok === v.n ? '' : corta(v.motivos[0], 300).replace(/\|/g, '/')} |`);
  }
}
process.exit(0);

/**
 * SONDA do classificador do `adiamento-propoe-dia` com o modelo REAL (gpt-4o-mini, o mesmo prompt e schema do PR). Lê o corpus de
 * `agent/adiamento-propoe-dia.corpus.ts`, classifica cada frase N vezes (padrão 3) e imprime a matriz de acerto e quantas despedidas/recusas
 * VIRARIAM proposta (modelo sozinho × modelo + vetos em código). Só LÊ e chama a OpenAI; não grava nada.
 *
 *   OPENAI_API_KEY=… DATABASE_URL=postgresql://x:x@127.0.0.1:1/x KOMMO_SUBDOMAIN=x KOMMO_ACCESS_TOKEN=xxxxxxxxxxx SESSION_JWT_SECRET=xxxxxxxxxxxxxxxxxxxxxxxx \
 *     pnpm exec tsx src/scripts/sonda-classificador-adiamento.ts [rodadas]
 */
import { createChatOpenAI } from '../services/openai.service.js';
import {
  MODELO_DO_CLASSIFICADOR,
  TIPOS_DE_FALA,
  classificarComModelo,
  temDespedidaClara,
  temEscolhaDeHorario,
  temRecusaClara,
  valeClassificar,
  type ModeloComSaidaEstruturada,
  type TipoDeFala,
} from '../agent/adiamento-propoe-dia.js';
import { corpusRotulado, OFERTA_DA_SONDA } from '../agent/adiamento-propoe-dia.corpus.js';

const rodadas = Number(process.argv[2]) || 3;
if (!process.env.OPENAI_API_KEY || process.env.OPENAI_API_KEY.length < 20) {
  console.error('Sem OPENAI_API_KEY de verdade no ambiente: a sonda precisa do modelo real.');
  process.exit(2);
}
const modelo = createChatOpenAI(null, { model: MODELO_DO_CLASSIFICADOR, temperature: 0, maxTokens: 150 }) as unknown as ModeloComSaidaEstruturada;

type Linha = { frase: string; esperado: TipoDeFala; votos: Record<string, number>; chamou: boolean; vetado: boolean };
const linhas: Linha[] = [];
for (const { frase, esperado } of corpusRotulado()) {
  const vetado = temDespedidaClara(frase) || temRecusaClara(frase) || temEscolhaDeHorario(frase);
  const chamou = valeClassificar(frase) && !vetado;
  const votos: Record<string, number> = {};
  for (let i = 0; i < rodadas; i++) {
    const c = await classificarComModelo(modelo, { falaDoPaciente: frase, ultimaFalaDaIa: [OFERTA_DA_SONDA] }).catch(() => null);
    const t = c?.tipo ?? 'ERRO';
    votos[t] = (votos[t] ?? 0) + 1;
  }
  linhas.push({ frase, esperado, votos, chamou, vetado });
}

// matriz esperado × obtido (cada rodada conta uma vez)
const colunas = [...TIPOS_DE_FALA, 'ERRO'];
console.log(`\nMATRIZ (linhas = esperado, colunas = o que o modelo respondeu; ${rodadas} rodadas por frase)`);
console.log(['esperado'.padEnd(18), ...colunas.map((c) => c.slice(0, 10).padEnd(10))].join(' '));
for (const esp of TIPOS_DE_FALA) {
  const dele = linhas.filter((l) => l.esperado === esp);
  if (!dele.length) continue;
  console.log([`${esp} (${dele.length})`.padEnd(18), ...colunas.map((c) => String(dele.reduce((n, l) => n + (l.votos[c] ?? 0), 0)).padEnd(10))].join(' '));
}

const total = linhas.length * rodadas;
const certas = linhas.reduce((n, l) => n + (l.votos[l.esperado] ?? 0), 0);
console.log(`\nACERTO do modelo sozinho: ${certas}/${total} (${((100 * certas) / total).toFixed(1)}%)`);

// quantas despedidas/recusas VIRARIAM proposta: o modelo disse adiou_com_motivo E nenhum veto/pré-filtro barrou
const ruins = linhas.filter((l) => l.esperado === 'despedida' || l.esperado === 'recusa' || l.esperado === 'escolheu_horario' || l.esperado === 'adiou_sem_motivo');
const soModelo = ruins.reduce((n, l) => n + (l.votos.adiou_com_motivo ?? 0), 0);
const comCodigo = ruins.reduce((n, l) => n + (l.chamou ? (l.votos.adiou_com_motivo ?? 0) : 0), 0);
console.log(`PROPOSTAS INDEVIDAS (despedida/recusa/escolha de horário/sem motivo que virariam proposta; ${ruins.length * rodadas} rodadas): só o modelo = ${soModelo}; modelo + vetos + pré-filtro = ${comCodigo}`);
const porTipo = (t: TipoDeFala) => {
  const d = linhas.filter((l) => l.esperado === t);
  const a = d.reduce((n, l) => n + (l.votos.adiou_com_motivo ?? 0), 0);
  const b = d.reduce((n, l) => n + (l.chamou ? (l.votos.adiou_com_motivo ?? 0) : 0), 0);
  return `${t}: só modelo ${a}/${d.length * rodadas}, com código ${b}/${d.length * rodadas}`;
};
for (const t of ['despedida', 'recusa', 'escolheu_horario', 'adiou_sem_motivo'] as TipoDeFala[]) console.log('  ' + porTipo(t));
const adia = linhas.filter((l) => l.esperado === 'adiou_com_motivo');
const propoe = adia.reduce((n, l) => n + (l.chamou ? (l.votos.adiou_com_motivo ?? 0) : 0), 0);
console.log(`ADIAMENTOS que viram proposta: ${propoe}/${adia.length * rodadas}`);
console.log('\nFRASES COM ERRO (esperado ≠ maioria):');
for (const l of linhas) {
  const [top] = Object.entries(l.votos).sort((a, b) => b[1] - a[1])[0] ?? ['?'];
  if (top !== l.esperado) console.log(`  [${l.esperado} → ${JSON.stringify(l.votos)}${l.vetado ? ' VETADA' : ''}${l.chamou ? '' : ' (sem chamada)'}] ${l.frase}`);
}
process.exit(0);

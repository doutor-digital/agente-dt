/**
 * Prova do Joaoof em SECO sobre mensagens reais: repete, na cadência de produção, a leitura dos grupos «Mkt | Dr Hérnia» de um período e
 * mostra o que a triagem teria criado e como ficaria o resumo das 8h. NADA vai ao banco, ao Telegram ou a unidade: tudo em memória.
 *
 * Entrada: um arquivo JSON com os registros brutos da Evolution (`findMessages`) de cada grupo, cada um com `slug` (ver `ev-raw.js` no PR).
 * Modelo: `--modelo cli` usa o Claude Code logado (`claude -p`, sem chave de API) só para esta prova; `--modelo api` usa
 * JOAOOF_ANTHROPIC_API_KEY como em produção. O CÉREBRO, as FERRAMENTAS, a máscara de telefone e o resumo são o código de produção.
 *
 *   pnpm exec tsx src/scripts/joaoof-seco.ts --arquivo raw8d.json --ate 2026-11-27T11:00:00Z --dias 7 --saida ./saida --modelo cli
 */
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AIMessage, HumanMessage, SystemMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages';
import { toJsonSchema } from '@langchain/core/utils/json_schema';
import { rodarCerebro, type ModeloDeChat } from '../joaoof/cerebro.js';
import { orcamentoDoJoaoof } from '../joaoof/config.js';
import { criarFreio, type ChamadaRegistrada } from '../joaoof/custo.js';
import { entradaEmMemoria } from '../joaoof/entrada.js';
import { normalizarRegistro, type RegistroEvolution } from '../joaoof/evolution.js';
import { criarFerramentas, limpoParaPedido } from '../joaoof/ferramentas.js';
import { repoEmMemoria, type UnidadeJoaoof } from '../joaoof/repo.js';
import { montarResumo } from '../joaoof/resumo.js';
import { MAX_PASSOS_DA_TRIAGEM, rodarLote, type DepsTriagem } from '../joaoof/triagem.js';
import { calculateCost } from '../services/openai.service.js';

function arg(nome: string, padrao?: string): string {
  const i = process.argv.indexOf(`--${nome}`);
  const v = i >= 0 ? process.argv[i + 1] : padrao;
  if (v === undefined) throw new Error(`falta --${nome}`);
  return v;
}

const ARQUIVO = arg('arquivo');
const ATE = new Date(arg('ate', new Date().toISOString()));
const DIAS = Number(arg('dias', '7'));
const SAIDA = arg('saida', './joaoof-saida');
const MODELO = arg('modelo', 'cli');
const PASSO_MIN = Number(arg('passo-min', '20'));
const BARATO = arg('barato', 'claude-haiku-4-5');
const FORTE = arg('forte', 'claude-sonnet-5');

const UNIDADES: UnidadeJoaoof[] = [
  { slug: 'doutor-hernia-parauapebas', nome: 'Parauapebas', grupoJid: 'doutor-hernia-parauapebas', notas: '', ativa: true },
  { slug: 'doutor-hernia-acailandia', nome: 'Açailândia', grupoJid: 'doutor-hernia-acailandia', notas: '', ativa: true },
  { slug: 'doutor-hernia-araguaina', nome: 'Araguaína', grupoJid: 'doutor-hernia-araguaina', notas: '', ativa: true },
];

type Bruto = RegistroEvolution & { slug: string };
const brutos = JSON.parse(readFileSync(ARQUIVO, 'utf8')) as Bruto[];
const tsDe = (r: RegistroEvolution) => Number(typeof r.messageTimestamp === 'object' ? (r.messageTimestamp?.low ?? 0) : (r.messageTimestamp ?? 0));

// ─── modelo: o Claude Code logado, falando o protocolo de ferramentas em JSON (só para a prova) ───────────────────
const estimaTokens = (s: string) => Math.ceil(s.length / 3.2);
let usoDoCli = { entrada: 0, saida: 0, chamadas: 0, custoUsd: 0 };

function claudeCli(alias: string, sistema: string, usuario: string): Promise<{ texto: string; entrada: number; saida: number; custo: number }> {
  return new Promise((resolve, reject) => {
    const cwd = mkdtempSync(join(tmpdir(), 'joaoof-cli-'));
    const p = spawn('claude', ['-p', '--model', alias, '--output-format', 'json', '--no-session-persistence', '--tools', '', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--setting-sources', '', '--disable-slash-commands', '--system-prompt', sistema], { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('error', reject);
    p.on('close', (code) => {
      if (code !== 0) return reject(new Error(`claude saiu com ${code}: ${err.slice(0, 300)}`));
      try {
        const j = JSON.parse(out) as { is_error?: boolean; result?: string; usage?: { input_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number; output_tokens?: number }; total_cost_usd?: number };
        if (j.is_error) return reject(new Error(`claude devolveu erro: ${String(j.result).slice(0, 200)}`));
        const u = j.usage ?? {};
        resolve({ texto: j.result ?? '', entrada: (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0), saida: u.output_tokens ?? 0, custo: j.total_cost_usd ?? 0 });
      } catch (e) {
        reject(new Error(`saída do claude ilegível: ${out.slice(0, 200)}`));
      }
    });
    p.stdin.end(usuario);
  });
}

function modeloPeloCli(nome: string, alias: string): ModeloDeChat {
  return {
    nome,
    bindTools: (ferramentas) => {
      const catalogo = ferramentas
        .map((t) => `- ${t.name}: ${t.description}\n  argumentos (JSON Schema): ${JSON.stringify(toJsonSchema(t.schema as never))}`)
        .join('\n');
      return {
        async invoke(mensagens: BaseMessage[]) {
          const sistema = String(mensagens.find((m) => m instanceof SystemMessage)?.content ?? '');
          const conversa = mensagens
            .filter((m) => !(m instanceof SystemMessage))
            .map((m) => {
              if (m instanceof HumanMessage) return `### PEDIDO\n${m.content}`;
              if (m instanceof ToolMessage) return `### RESULTADO DA FERRAMENTA (${m.tool_call_id})\n${m.content}`;
              if (m instanceof AIMessage) return `### SUA RESPOSTA ANTERIOR\n${JSON.stringify({ chamadas: (m.tool_calls ?? []).map((c) => ({ nome: c.name, args: c.args })), final: typeof m.content === 'string' ? m.content : '' })}`;
              return '';
            })
            .join('\n\n');
          const protocolo =
            `${conversa}\n\n### COMO RESPONDER\nVocê tem estas ferramentas:\n${catalogo}\n\n` +
            'Responda SOMENTE com um objeto JSON, sem texto fora dele: {"chamadas":[{"nome":"<ferramenta>","args":{...}}],"final":"<texto>"}. ' +
            'Se precisa de ferramentas, preencha "chamadas" (pode ser mais de uma) e deixe "final" vazio. Quando terminar, "chamadas" vazio e "final" com sua resposta.';
          const r = await claudeCli(alias, sistema, protocolo);
          usoDoCli = { entrada: usoDoCli.entrada + r.entrada, saida: usoDoCli.saida + r.saida, chamadas: usoDoCli.chamadas + 1, custoUsd: usoDoCli.custoUsd + r.custo };
          const limpo = r.texto.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
          let obj: { chamadas?: Array<{ nome: string; args: Record<string, unknown> }>; final?: string };
          try {
            obj = JSON.parse(limpo.slice(limpo.indexOf('{'), limpo.lastIndexOf('}') + 1));
          } catch {
            obj = { chamadas: [], final: limpo };
          }
          const entrada = estimaTokens(sistema + protocolo);
          const saida = estimaTokens(r.texto);
          return new AIMessage({
            content: obj.final ?? '',
            tool_calls: (obj.chamadas ?? []).map((c, i) => ({ name: c.nome, args: c.args ?? {}, id: `t${Date.now()}_${i}`, type: 'tool_call' as const })),
            usage_metadata: { input_tokens: entrada, output_tokens: saida, total_tokens: entrada + saida },
          });
        },
      };
    },
  };
}

async function modeloDaApi(nome: string): Promise<ModeloDeChat> {
  const { criarModelo } = await import('../joaoof/producao.js');
  return criarModelo(nome);
}

// ─── a prova ────────────────────────────────────────────────────────────────────────────────────────────────────
async function main() {
  mkdirSync(SAIDA, { recursive: true });
  let agora = new Date(ATE.getTime() - DIAS * 86_400_000);
  const repo = repoEmMemoria(() => agora, UNIDADES);
  const entradas = entradaEmMemoria();
  const enviados: string[] = [];
  const chamadas: ChamadaRegistrada[] = [];
  const diario: Array<{ em: string; papel: string; modelo: string; custoUsd: number }> = [];
  const freio = criarFreio(
    {
      agora: () => agora,
      gastoDesdeUsd: async () => 0,
      gravarChamada: async (c) => {
        chamadas.push(c);
        diario.push({ em: agora.toISOString(), papel: c.papel, modelo: c.modelo, custoUsd: c.custoUsd });
      },
      jaAvisou: async () => true,
      marcarAviso: async () => {},
      avisar: async () => true,
      calcularCustoUsd: (m, u) => calculateCost(m, u.entrada, u.saida, u.cacheLeitura, u.cacheEscrita, 0),
    },
    orcamentoDoJoaoof({}),
  );
  const modeloBarato = MODELO === 'api' ? await modeloDaApi(BARATO) : modeloPeloCli(BARATO, 'haiku');
  const modeloForte = MODELO === 'api' ? await modeloDaApi(FORTE) : modeloPeloCli(FORTE, 'sonnet');

  // `ler_mensagens_grupo` sobre o arquivo: as últimas falas (mascaradas) da unidade até o instante simulado
  const leitorDoArquivo = async (slug: string, n: number) => {
    const falas = brutos
      .filter((r) => r.slug === slug && tsDe(r) <= agora.getTime() / 1000)
      .map((r) => normalizarRegistro(r, slug, 'segredo-so-da-prova-de-seco-123456'))
      .filter((m): m is NonNullable<typeof m> => m !== null)
      .sort((a, b) => b.ts - a.ts)
      .slice(0, n)
      .reverse()
      .map((m) => `${new Date(m.ts * 1000).toISOString().slice(5, 16).replace('T', ' ')}Z ${limpoParaPedido(m.autorNome || 'alguém', 80)}: ${limpoParaPedido(m.texto, 300)}`);
    return falas.length ? falas.join('\n') : 'Sem mensagens nesse grupo no período.';
  };

  const deps: DepsTriagem = {
    repo,
    entradas,
    modo: () => 'seco',
    agora: () => agora,
    enviar: async (t) => (enviados.push(t), true),
    evolution: { url: 'dump', instancia: 'dump', apikey: 'dump' },
    segredoPessoa: 'segredo-so-da-prova-de-seco-123456',
    // o «Evolution» é o arquivo: só devolve o que já existia no instante simulado (como a leitura real)
    // como a Evolution: da mais NOVA para a mais velha, só o que já existia no instante simulado
    lerGrupo: async (_c, jid, desde) => ({ ok: true, truncado: false, registros: brutos.filter((r) => r.slug === jid && tsDe(r) > desde && tsDe(r) <= agora.getTime() / 1000).sort((a, b) => tsDe(b) - tsDe(a)) }),
    executar: (o) =>
      rodarCerebro(
        {
          modelo: o.forte ? modeloForte : modeloBarato,
          ferramentas: criarFerramentas({ repo, fonte: 'grupo', refsDoLote: o.refsDoLote, escopo: o.escopo, lerMensagens: leitorDoArquivo }).filter((t) => !o.apenasFerramentas || o.apenasFerramentas.includes(t.name)),
          freio,
          papel: o.papel,
          maxPassos: o.maxPassos ?? MAX_PASSOS_DA_TRIAGEM,
        },
        o.sistema,
        o.pedido,
      ),
    intervaloMin: PASSO_MIN,
    retroativoHoras: DIAS * 24,
    maxPorChamada: 60,
    registrar: () => {},
  };

  const lotes: Array<Record<string, unknown>> = [];
  const resumos: Array<{ em: string; texto: string | null }> = [];
  const fim = ATE.getTime();
  let ultimoResumo = '';
  while (agora.getTime() <= fim) {
    const r = await rodarLote(deps);
    if (r.rodou && r.motivo !== 'sem-mensagens') {
      lotes.push({ em: agora.toISOString(), ...r });
      process.stderr.write(`${agora.toISOString()} lote: ${r.processadas} msg, +${r.demandasCriadas} demandas, ${r.chamadas} chamadas, US$ ${r.custoUsd.toFixed(4)}\n`);
    }
    // o resumo das 8h e das 18h (Brasília = UTC−3) de cada dia simulado
    const hh = agora.toISOString().slice(0, 13);
    if ((hh.endsWith('T11') || hh.endsWith('T21')) && ultimoResumo !== hh) {
      ultimoResumo = hh;
      const abertas = await repo.listarDemandas({ status: ['aberta', 'em_andamento'], limite: 200 });
      resumos.push({ em: agora.toISOString(), texto: montarResumo({ agora, hora: hh.endsWith('T11') ? 8 : 18, abertas, unidades: UNIDADES }) });
    }
    agora = new Date(agora.getTime() + PASSO_MIN * 60_000);
  }

  const demandas = await repo.listarDemandas({ limite: 200 });
  const custoTotal = chamadas.reduce((s, c) => s + c.custoUsd, 0);
  const entradaTotal = chamadas.reduce((s, c) => s + c.uso.entrada, 0);
  const saidaTotal = chamadas.reduce((s, c) => s + c.uso.saida, 0);
  const resultado = {
    periodo: { de: new Date(ATE.getTime() - DIAS * 86_400_000).toISOString(), ate: ATE.toISOString(), passoMin: PASSO_MIN },
    lidas: entradas._itens.length,
    lotesComModelo: lotes.length,
    chamadasAoModelo: chamadas.length,
    tokens: { entrada: entradaTotal, saida: saidaTotal },
    custoUsdPeriodo: Number(custoTotal.toFixed(4)),
    custoUsdPorDia: Number((custoTotal / DIAS).toFixed(4)),
    usoRealDoCli: usoDoCli,
    telegramEnviados: enviados.length,
    avisosSecosRegistrados: repo._avisos.filter((a) => a.seco).length,
    demandas,
    avisosSecos: repo._avisos.map((a) => ({ tipo: a.tipo, chave: a.chave, texto: a.texto })),
    resumoDeHoje8h: resumos.filter((r) => r.em.startsWith(ATE.toISOString().slice(0, 10)) && r.em.includes('T11')).at(-1)?.texto ?? null,
    resumos,
    lotes,
  };
  writeFileSync(join(SAIDA, 'resultado.json'), JSON.stringify(resultado, null, 2));
  process.stdout.write(JSON.stringify({ ...resultado, demandas: undefined, resumos: undefined, lotes: undefined, avisosSecos: undefined, resumoDeHoje8h: undefined }, null, 2) + '\n');
}

main().catch((e) => {
  process.stderr.write(`${e instanceof Error ? e.stack : String(e)}\n`);
  process.exit(1);
});

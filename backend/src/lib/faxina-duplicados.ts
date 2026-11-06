/**
 * Passo 1 da faxina (duplicados): REUSA a regra do #233 (`entrada-automatica.ts`) em modo ESTOQUE, com o estado da faxina.
 * Não existe regra própria de par único aqui: `rodarConta` + `decidir` + `mesmoTelefone` (DDD obrigatório e igual) são os dele.
 *
 *  - Faxina ligada → `entrada-estoque` em «ligado»: VINCULA o chat ao cartão quando há UM cartão aberto com o telefone. Ambíguo
 *    (2+ cartões) e sem par ficam na caixa; o ambíguo vai para «precisam da equipe» com os links.
 *  - Faxina em seco → `entrada-estoque` em «seco»: só conta o «vincularia»; nada é escrito (nem nota).
 *  - Se a `entrada-estoque` JÁ está ligada ou em só no papel em alguma unidade da conta, o worker do #233 está cuidando da caixa:
 *    a faxina NÃO roda de novo, só relata o resumo da última rodada dele (se houver).
 *
 * Contato repetido dentro do MESMO cartão não é mais listado: o #233 não mede isso (mesclar contato é pela tela do Kommo).
 */
import type { ResumoDaRodada, ContextoDaRodada, PortaKommo } from './entrada-automatica.js';
import { ID_ESTOQUE, configDoAmbiente, memoriaNova, rodarConta } from './entrada-automatica.js';
import type { Estado } from './automacoes-estado.js';

export interface ResultadoDosDuplicados {
  juntados: number;
  semCartao: number;
  falhas: number;
  sobraram: number;
 
  equipe: Array<{ cartaoId: number; motivo: string }>;
  avisos: string[];
  erros: string[];
  /** o Kommo pediu calma (429/5xx/rede, ou a leitura da caixa falhou): a faxina para a unidade e a retoma depois */
  freio: boolean;
  /** a rodada parou antes do fim POR FREIO do Kommo: a unidade fica interrompida (retomada 1× depois dos 90 min). Token sem direito e perda de liderança são só aviso */
  incompleto: boolean;
}

export const vazioDosDuplicados = (): ResultadoDosDuplicados => ({ juntados: 0, semCartao: 0, falhas: 0, sobraram: 0, equipe: [], avisos: [], erros: [], freio: false, incompleto: false });

/** Tetos da faxina: maiores que os do worker de 3 em 3 minutos, porque roda uma vez por mês. */
export const TETOS_DA_FAXINA = { maxAvaliacoes: 100, maxEscritas: 60, maxPaginas: 8 } as const;

/** Falha de leitura/transitória = o Kommo pedindo calma. 400/401/403/422 (token sem direito) é da conta: não trava os outros passos. */
export function ehFreioDoKommo(encerrouCedo: string): boolean {
  if (/429, 5xx ou rede/.test(encerrouCedo)) return true;
  return /não consegui ler o Kommo/.test(encerrouCedo) && !/\b(400|401|403|422)\b/.test(encerrouCedo);
}

/** O que o `rodarConta` disse, no formato do relatório da faxina. `gravou`: faxina ligada (vinculados) ou seca (vincularia). */
export function resumoParaRelatorio(
  resumo: ResumoDaRodada,
  gravou: boolean,
  ambiguosComCartoes: Array<{ cartoes: number[] }> = [],
  tetos: { maxAvaliacoes: number; maxEscritas: number } = TETOS_DA_FAXINA,
): ResultadoDosDuplicados {
  const r = vazioDosDuplicados();
  r.juntados = gravou ? resumo.vinculados : resumo.vincularia;
  r.semCartao = resumo.semParVelho;
  r.falhas = resumo.erros;
  r.sobraram = resumo.adiados;
  // um link por conjunto de cartões (vários chats do mesmo telefone dão o mesmo link)
  const vistos = new Set<string>();
  for (const a of ambiguosComCartoes) {
    const chave = [...a.cartoes].sort((x, y) => x - y).join(',');
    const [primeiro] = a.cartoes;
    if (!primeiro || vistos.has(chave)) continue;
    vistos.add(chave);
    r.equipe.push({ cartaoId: primeiro, motivo: `mais de um cartão aberto com esse telefone: ${a.cartoes.join(', ')}` });
  }
  if (resumo.ambiguos > ambiguosComCartoes.length) r.avisos.push(`${resumo.ambiguos - ambiguosComCartoes.length} chats com mais de um cartão aberto no mesmo telefone ficaram na caixa, sem link aqui (ver «Só no papel» da entrada-estoque)`);
  if (resumo.semTelefone > 0) r.avisos.push(`${resumo.semTelefone} chats sem telefone no contato ficaram na caixa`);
  if (resumo.listaTruncada) r.avisos.push('a caixa de entrada é maior do que a faxina lê de uma vez');
  if (resumo.avaliados >= tetos.maxAvaliacoes || resumo.vinculados + resumo.vincularia >= tetos.maxEscritas) {
    r.avisos.push(`a faxina bateu o teto (${tetos.maxAvaliacoes} chats olhados, ${tetos.maxEscritas} vínculos): pode haver mais chats na caixa; rode de novo sob demanda`);
  }
  if (resumo.encerrouCedo) {
    r.avisos.push(`a caixa de entrada parou cedo: ${resumo.encerrouCedo}`);
    // só o freio do Kommo (429/5xx/rede/leitura que falhou) deixa a unidade INTERROMPIDA e a faz ser retomada. 401/403/422 (token sem direito) e
    // perda de liderança são só aviso: a unidade conclui com o que deu e ganha a trava mensal (refazer não adiantaria — ou faria laço)
    r.freio = ehFreioDoKommo(resumo.encerrouCedo);
    r.incompleto = r.freio;
  }
  return r;
}

export interface OpcoesDosDuplicados {
  kommo: PortaKommo;
  unit: { id: string; slug: string };
  /** o modo DA FAXINA */
  gravar: boolean;
  /** estado da `entrada-estoque` na CONTA (o mais cauteloso entre as unidades que a ligaram, como no worker do #233) */
  estadoDoEstoqueNaConta: Estado;
  /** o resumo da última rodada do worker do #233 nesta conta */
  ultimoResumoDoWorker: () => { em: number; resumo: ResumoDaRodada } | null;
  agora?: () => number;
  /** o processo perdeu a liderança: para antes da próxima escrita */
  cancelado?: () => boolean;
  pausa?: () => Promise<void>;
}

export async function duplicadosPelaEntradaAutomatica(o: OpcoesDosDuplicados): Promise<ResultadoDosDuplicados> {
  const agora = o.agora ?? Date.now;
  if (o.estadoDoEstoqueNaConta !== 'desligado') {
    // o worker do #233 já cuida desta caixa: não roda de novo, só relata
    const ult = o.ultimoResumoDoWorker();
    const r = vazioDosDuplicados();
    // SEM número no balanço: a última rodada de 3 minutos não é o trabalho do mês (e o estado dela pode ser outro que o da faxina)
    const x = ult?.resumo;
    r.avisos.push(
      `a entrada-estoque já está ${o.estadoDoEstoqueNaConta === 'ligado' ? 'ligada' : 'em só no papel'} nesta conta: a faxina não rodou de novo, só relata a última rodada dela` +
        (ult && x
          ? ` (há ${Math.max(0, Math.round((agora() - ult.em) / 60_000))} min): ${o.estadoDoEstoqueNaConta === 'ligado' ? `${x.vinculados} vinculados` : `${x.vincularia} vincularia`}, ${x.ambiguos} com mais de um cartão aberto, ${x.semParVelho} sem par, ${x.erros} erros — é a rodada de 3 em 3 minutos, não o balanço do mês`
          : ' (ainda não rodou desde o último reinício do servidor)'),
    );
    if (x && x.ambiguos > 0) r.avisos.push(`${x.ambiguos} chats com mais de um cartão aberto: decidir quem é da conversa é da recepção («Só no papel» da entrada-estoque tem a lista)`);
    return r;
  }

  const ambiguos: Array<{ cartoes: number[] }> = [];
  const ctx: ContextoDaRodada = {
    unit: o.unit,
    recente: 'desligado',
    estoque: o.gravar ? 'ligado' : 'seco',
    agora: Math.floor(agora() / 1000),
    cfg: { ...configDoAmbiente(), ...TETOS_DA_FAXINA },
    memoria: memoriaNova(),
    // não polui a tela «Só no papel» da entrada-estoque (que está desligada): o relatório da faxina é o lugar disso
    registrar: (s) => {
      if (s.automacao === ID_ESTOQUE && s.acao === 'pularia' && typeof s.valor === 'string' && /^\d+(, \d+)*$/.test(s.valor)) {
        ambiguos.push({ cartoes: s.valor.split(', ').map(Number) });
      }
    },
    cancelado: o.cancelado,
    pausa: o.pausa,
  };
  const resumo = await rodarConta(o.kommo, ctx);
  return resumoParaRelatorio(resumo, o.gravar, ambiguos);
}

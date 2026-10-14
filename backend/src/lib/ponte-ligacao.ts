/**
 * Ponte, fase 3 (14/10/2026) — a FILA DE LIGAÇÕES com 1 clique.
 *
 * O João queria um discador automático pelo WhatsApp. Automatizar o clique de ligar é automação do WhatsApp
 * (risco de banir o número), então a decisão foi: a Ponte faz tudo MENOS ligar. Ela abre a conversa do próximo
 * paciente (navegação, como o "Abrir conversa" da fila) e a atendente dá o ÚNICO clique, no 📞 do próprio
 * WhatsApp Web. A Ponte nunca clica, digita nem envia nada no WhatsApp.
 *
 * Aqui fica a parte do servidor:
 *   - o RITMO, para não parecer spam: intervalo mínimo entre abrir uma ligação e a próxima, e um teto por hora.
 *     Quem conta é a extensão (é ela que abre as conversas); o servidor só manda os números, no mesmo estilo de
 *     `PRAZOS_DA_FILA`, cada um com variável de ambiente;
 *   - o RESULTADO de cada ligação (`POST …/ponte/ligacao`), gravado nos campos ☎ do cartão, ACHADOS PELO NOME
 *     na conta (nunca id fixo): ☎ Última ligação = agora, ☎ Resultado = a opção do select, ☎ Tentativas + 1,
 *     ☎ Agente = "Ponte · <nome>", e ☎ Campanha 3C VAZIO — é assim que se separa a ligação da SDR da discadora
 *     3C. Sempre com uma nota curta "☎ Ligação pela Ponte: <resultado> · por <nome>". Conta sem os campos ☎:
 *     só a nota.
 *
 * Não põe ▶ Retomada nem etiqueta nenhuma depois da ligação (decisão do João).
 */
import { KommoApiError } from '../services/kommo.service.js';
import { normalizarNome } from './kommo-schema.js';
import { numeroDoAmbiente } from './ponte-fila.js';
import { CacheDaConta } from './ponte-cache.js';
import { leadIdDoPedido, textoCurto, type Lido } from './ponte-pausa.js';

export interface RitmoDasLigacoes {
  /** Segundos, no mínimo, entre abrir a conversa de uma ligação e a da próxima. */
  intervaloS: number;
  /** No máximo quantas conversas de ligação a Ponte abre por hora (janela corrida de 60 min). */
  tetoPorHora: number;
}

/**
 * O ritmo da fila de ligações. Piso de 15 s no intervalo e teto de 120 por hora: uma variável de ambiente
 * errada não pode transformar a Ponte num disparador.
 */
export const RITMO_DAS_LIGACOES: Readonly<RitmoDasLigacoes> = Object.freeze({
  intervaloS: Math.max(15, numeroDoAmbiente(process.env.PONTE_LIGACAO_INTERVALO_S, 40)),
  tetoPorHora: Math.min(120, Math.floor(numeroDoAmbiente(process.env.PONTE_LIGACAO_TETO_HORA, 40))),
});

/** Os resultados que a atendente marca (o "Pular" não chega aqui: não grava nada). */
export const RESULTADOS_DA_LIGACAO = Object.freeze({
  atendeu: { rotulo: 'atendeu', opcao: 'Atendida' },
  'nao-atendeu': { rotulo: 'não atendeu', opcao: 'Não atendida' },
  'caixa-postal': { rotulo: 'caixa postal', opcao: 'Caixa postal' },
  'numero-errado': { rotulo: 'número errado', opcao: 'Número inválido' },
} as const);

export type ResultadoDaLigacao = keyof typeof RESULTADOS_DA_LIGACAO;

export function ehResultadoDaLigacao(v: unknown): v is ResultadoDaLigacao {
  return typeof v === 'string' && Object.prototype.hasOwnProperty.call(RESULTADOS_DA_LIGACAO, v);
}

/** Os campos ☎ que a Ponte mexe, pelo nome (conferidos num cartão de Açailândia em 14/10/2026). */
export const CAMPOS_DA_LIGACAO = Object.freeze({
  ultima: '☎ Última ligação',
  resultado: '☎ Resultado',
  tentativas: '☎ Tentativas',
  agente: '☎ Agente',
  campanha: '☎ Campanha 3C',
} as const);

type ChaveDoCampo = keyof typeof CAMPOS_DA_LIGACAO;

export interface DefinicaoDeCampo {
  id: number;
  name: string;
  type: string;
  enums?: ReadonlyArray<{ id: number; value: string }>;
}

/**
 * Os campos ☎ da conta, pelo NOME. Só vale campo cujo nome começa com ☎: comparar sem os símbolos faria
 * "☎ Resultado" casar com qualquer outro campo "Resultado" da conta.
 */
export function camposDaLigacaoNaConta(defs: ReadonlyArray<DefinicaoDeCampo>): Partial<Record<ChaveDoCampo, DefinicaoDeCampo>> {
  const doTelefone = defs.filter((d) => String(d.name ?? '').trim().startsWith('☎'));
  const out: Partial<Record<ChaveDoCampo, DefinicaoDeCampo>> = {};
  for (const [k, nome] of Object.entries(CAMPOS_DA_LIGACAO) as Array<[ChaveDoCampo, string]>) {
    const alvo = normalizarNome(nome);
    const achado = doTelefone.find((d) => normalizarNome(d.name) === alvo);
    if (achado) out[k] = achado;
  }
  return out;
}

export interface ValorDoCartao {
  field_id: number;
  values?: ReadonlyArray<{ value?: unknown }> | null;
}

const valorAtual = (campos: ReadonlyArray<ValorDoCartao> | null | undefined, id: number): unknown =>
  (campos ?? []).find((c) => c.field_id === id)?.values?.[0]?.value;

const vazio = (v: unknown) => v == null || (typeof v === 'string' && !v.trim());

/** "Ponte · Ana" (ou só "Ponte") — o ☎ Agente diz que a ligação foi da SDR pela Ponte, não da discadora. */
export function agenteDaPonte(por: string | null): string {
  return por ? `Ponte · ${por}` : 'Ponte';
}

/** "☎ Ligação pela Ponte: não atendeu · por Ana" */
export function notaDaLigacao(resultado: ResultadoDaLigacao, por: string | null): string {
  return `☎ Ligação pela Ponte: ${RESULTADOS_DA_LIGACAO[resultado].rotulo}${por ? ` · por ${por}` : ''}`;
}

export interface GravacaoDaLigacao {
  /** O PATCH dos campos ☎ (vazio = a conta não tem os campos: só a nota). */
  campos: Array<{ field_id: number; values: Array<Record<string, unknown>> | null }>;
  /** As tentativas depois desta ligação (null = a conta não tem o ☎ Tentativas). */
  tentativas: number | null;
  /** O que não deu para gravar como devia (vai para a resposta, para a atendente saber). */
  avisos: string[];
}

/**
 * O que gravar nos campos ☎ para esta ligação. Puro: recebe os campos da conta e os valores atuais do cartão.
 * O ☎ Campanha 3C é ESVAZIADO quando tem valor de uma ligação antiga da 3C — os campos ☎ dizem como foi a
 * ÚLTIMA ligação, e esta não foi da discadora. Gravação e duração da 3C não são tocadas.
 */
export function montarGravacaoDaLigacao(p: {
  defs: ReadonlyArray<DefinicaoDeCampo>;
  atuais: ReadonlyArray<ValorDoCartao> | null | undefined;
  resultado: ResultadoDaLigacao;
  por: string | null;
  agora: Date;
}): GravacaoDaLigacao {
  const c = camposDaLigacaoNaConta(p.defs);
  const campos: GravacaoDaLigacao['campos'] = [];
  const avisos: string[] = [];
  let tentativas: number | null = null;

  if (c.ultima) campos.push({ field_id: c.ultima.id, values: [{ value: Math.floor(p.agora.getTime() / 1000) }] });
  if (c.resultado) {
    const alvo = normalizarNome(RESULTADOS_DA_LIGACAO[p.resultado].opcao);
    const opcao = (c.resultado.enums ?? []).find((e) => normalizarNome(e.value) === alvo);
    if (opcao) campos.push({ field_id: c.resultado.id, values: [{ enum_id: opcao.id }] });
    else {
      // sem a opção, o resultado antigo ficaria ao lado da data nova: esvazia, e o resultado vai na nota
      campos.push({ field_id: c.resultado.id, values: null });
      avisos.push(`O campo ${CAMPOS_DA_LIGACAO.resultado} não tem a opção "${RESULTADOS_DA_LIGACAO[p.resultado].opcao}": o resultado ficou só na nota.`);
    }
  }
  if (c.tentativas) {
    const antes = Number(valorAtual(p.atuais, c.tentativas.id));
    tentativas = (Number.isFinite(antes) && antes > 0 ? Math.floor(antes) : 0) + 1;
    campos.push({ field_id: c.tentativas.id, values: [{ value: tentativas }] });
  }
  if (c.agente) campos.push({ field_id: c.agente.id, values: [{ value: agenteDaPonte(p.por) }] });
  if (c.campanha && !vazio(valorAtual(p.atuais, c.campanha.id))) campos.push({ field_id: c.campanha.id, values: null });
  // só a campanha a esvaziar não é "gravar a ligação": sem nenhum dos outros campos, fica só a nota
  if (!c.ultima && !c.resultado && !c.tentativas && !c.agente) return { campos: [], tentativas: null, avisos };
  return { campos, tentativas, avisos };
}

export interface PedidoDeLigacao {
  leadId: number;
  resultado: ResultadoDaLigacao;
  por: string | null;
}

/** `POST …/ponte/ligacao` → `{ leadId, resultado, por? }`. */
export function lerPedidoDeLigacao(corpo: unknown): Lido<PedidoDeLigacao> {
  const b = (corpo && typeof corpo === 'object' ? corpo : {}) as Record<string, unknown>;
  const leadId = leadIdDoPedido(b.leadId);
  if (!leadId) return { ok: false, erro: 'lead inválido' };
  if (!ehResultadoDaLigacao(b.resultado)) return { ok: false, erro: 'resultado inválido' };
  return { ok: true, pedido: { leadId, resultado: b.resultado, por: textoCurto(b.por, 80) } };
}

// ── com o Kommo ──

export interface KommoDaLigacao {
  listarCamposDoCartao(): Promise<DefinicaoDeCampo[]>;
  getLead(leadId: number): Promise<{ id: number; custom_fields_values?: ValorDoCartao[] | null }>;
  gravarCamposDoLead(leadId: number, campos: GravacaoDaLigacao['campos']): Promise<void>;
  addLeadNote(leadId: number, texto: string): Promise<unknown>;
}

/** Os campos da conta mudam pouco: cache de 10 min por conta (também serve às respostas prontas). */
const cacheCampos = new CacheDaConta<DefinicaoDeCampo[]>(10 * 60_000);

export function camposDaConta(conta: string, kommo: Pick<KommoDaLigacao, 'listarCamposDoCartao'>): Promise<DefinicaoDeCampo[]> {
  return cacheCampos.obter(conta, () => kommo.listarCamposDoCartao());
}

export function limparCacheDosCampos(): void {
  cacheCampos.limpar();
}

export type ResultadoDoRegistro =
  | {
      ok: true;
      leadId: number;
      resultado: ResultadoDaLigacao;
      /** Os campos ☎ foram gravados. */
      campos: boolean;
      nota: boolean;
      tentativas: number | null;
      avisos: string[];
    }
  | { ok: false; status: number; erro: string };

/**
 * Grava a ligação no cartão: os campos ☎ num PATCH só e a nota. Se os campos falharem, a nota ainda vai (a
 * ligação não pode sumir); se nada gravar, é erro e a atendente tenta de novo.
 */
export async function registrarLigacao(conta: string, kommo: KommoDaLigacao, pedido: PedidoDeLigacao, agora = new Date()): Promise<ResultadoDoRegistro> {
  let lead: Awaited<ReturnType<KommoDaLigacao['getLead']>> | null;
  try {
    lead = await kommo.getLead(pedido.leadId);
  } catch (err) {
    if (err instanceof KommoApiError && (err.status === 404 || err.status === 204)) lead = null;
    else throw err;
  }
  if (!lead || typeof lead !== 'object' || !lead.id) return { ok: false, status: 404, erro: 'cartão não encontrado no Kommo' };

  const defs = await camposDaConta(conta, kommo).catch(() => [] as DefinicaoDeCampo[]);
  const g = montarGravacaoDaLigacao({ defs, atuais: lead.custom_fields_values, resultado: pedido.resultado, por: pedido.por, agora });
  const avisos = [...g.avisos];
  if (!defs.length) avisos.push('Não consegui ler os campos da conta agora: a ligação ficou só na nota.');
  else if (!g.campos.length) avisos.push('Esta conta não tem os campos ☎: a ligação ficou só na nota.');

  let campos = false;
  if (g.campos.length) {
    campos = await kommo.gravarCamposDoLead(pedido.leadId, g.campos).then(
      () => true,
      () => false,
    );
    if (!campos) avisos.push('O Kommo não aceitou os campos ☎ agora: a ligação ficou só na nota.');
  }
  const nota = await kommo.addLeadNote(pedido.leadId, notaDaLigacao(pedido.resultado, pedido.por)).then(
    () => true,
    () => false,
  );
  if (!campos && !nota) return { ok: false, status: 502, erro: 'não consegui gravar a ligação no Kommo agora' };
  if (!nota) avisos.push('A nota da ligação não entrou no cartão.');
  return { ok: true, leadId: pedido.leadId, resultado: pedido.resultado, campos, nota, tentativas: campos ? g.tentativas : null, avisos };
}

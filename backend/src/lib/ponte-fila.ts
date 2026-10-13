/**
 * Ponte, fase 2 — a FILA DO DIA da atendente (pedido do João em 13/10/2026: "ligações por etapa").
 *
 * Interpretação: uma aba "Fila" no painel com quem a atendente precisa chamar ou ligar HOJE, separada por
 * etapa do funil COMERCIAL, cada grupo com contador. Cada grupo tem UMA regra, todas aqui:
 *
 *   - entrada / EM QUALIFICAÇÃO → "sem resposta": o paciente escreveu, a conversa do Kommo está aberta e
 *     NÃO LIDA há mais de `semRespostaHoras`, e a última fala não é da Sofia;
 *   - EM ESPERA        → "retomar contato": o "◷ Retomar em" do cartão já chegou (hoje ou antes);
 *   - AGENDADO         → "confirmar presença": a "◷ Data da Consulta" é daqui a `confirmarDiasAntes` dias
 *     (1 = amanhã) e a "✓ Situação da consulta" ainda não diz confirmada;
 *   - NÃO COMPARECEU   → "faltou: remarcar": todo cartão da etapa, menos quem já tem consulta nova no futuro;
 *   - EM NEGOCIAÇÃO    → "retomar negociação": o cartão não mudou de etapa e a conversa não mexeu há
 *     `negociacaoParadaDias` (o mesmo "parado" do worker de parados).
 *
 * Etapas e campos são lidos pelo NOME (os ids mudam por conta). Os prazos ficam todos em `PRAZOS_DA_FILA`,
 * e cada um aceita variável de ambiente para mudar sem mexer no código.
 *
 * Esta é a parte PURA (regras, ordem, textos). Quem lê o Kommo, o banco e guarda o cache é
 * `controllers/ponte-fila.controller.ts`. Nada aqui escreve em lugar nenhum.
 */
import { normalizarNome } from './kommo-schema.js';
import { ETAPA, ehEtapaDeEntrada } from './franquia-move.js';
import { CAMPOS_SYNC } from './franquia-sync.js';
import { CAMPO } from './parados.js';
import { dataLocalISO } from './feriados.js';

const numeroDoAmbiente = (bruto: string | undefined, padrao: number): number => {
  const n = Number(bruto);
  return Number.isFinite(n) && n > 0 ? n : padrao;
};

export interface PrazosDaFila {
  /** AGENDADO: entra quem tem consulta daqui a N dias (1 = amanhã) — "confirmar presença". */
  confirmarDiasAntes: number;
  /** EM NEGOCIAÇÃO: entra depois de N dias sem mexer no cartão e sem conversa. */
  negociacaoParadaDias: number;
  /** Entrada / EM QUALIFICAÇÃO: o paciente escreveu e ninguém leu há mais de N horas. */
  semRespostaHoras: number;
  /** Até quantos dias para trás olhar as conversas do Kommo (para "sem resposta" e "parado"). */
  janelaConversasDias: number;
  /** Quantos itens de cada grupo vão para o painel (o contador mostra o total). */
  maxPorGrupo: number;
  /** A fila de uma conta do Kommo é montada no máximo uma vez a cada N ms (cache). */
  cacheMs: number;
}

/** TODOS os prazos da fila, num lugar só. */
export const PRAZOS_DA_FILA: Readonly<PrazosDaFila> = Object.freeze({
  confirmarDiasAntes: numeroDoAmbiente(process.env.PONTE_FILA_CONFIRMAR_DIAS, 1),
  negociacaoParadaDias: numeroDoAmbiente(process.env.PONTE_FILA_NEGOCIACAO_DIAS, 3),
  semRespostaHoras: numeroDoAmbiente(process.env.PONTE_FILA_SEM_RESPOSTA_HORAS, 2),
  janelaConversasDias: numeroDoAmbiente(process.env.PONTE_FILA_JANELA_CONVERSAS_DIAS, 7),
  maxPorGrupo: numeroDoAmbiente(process.env.PONTE_FILA_MAX_POR_GRUPO, 30),
  cacheMs: numeroDoAmbiente(process.env.PONTE_FILA_CACHE_MS, 2 * 60_000),
});

export const DIA_S = 86_400;

/**
 * A Sofia responde em segundos, mas a hora da conversa no Kommo é a da ENTREGA (depois do Salesbot) e a nossa
 * é a de quando ela escreveu. Fala da Sofia até 5 min antes da última mexida na conversa conta como resposta.
 */
export const FOLGA_DA_SOFIA_S = 5 * 60;

export type IdDoGrupo = 'sem-resposta' | 'retomar' | 'confirmar' | 'faltou' | 'negociacao';

export interface DefinicaoDoGrupo {
  id: IdDoGrupo;
  /** A etapa do funil COMERCIAL (pelo nome). "sem resposta" vale também para a etapa de entrada. */
  etapa: string;
  /** O motivo da fila, do jeito que a atendente lê. */
  rotulo: string;
  /** Ordem dentro do grupo: `antigo` = quem espera há mais tempo primeiro; `recente` = o mais quente primeiro. */
  ordem: 'antigo' | 'recente';
}

/** Na ordem do funil. */
export const GRUPOS_DA_FILA: readonly DefinicaoDoGrupo[] = Object.freeze([
  { id: 'sem-resposta', etapa: ETAPA.QUALIFICACAO, rotulo: 'sem resposta', ordem: 'antigo' },
  { id: 'retomar', etapa: ETAPA.ESPERA, rotulo: 'retomar contato', ordem: 'antigo' },
  { id: 'confirmar', etapa: ETAPA.AGENDADO, rotulo: 'confirmar presença', ordem: 'antigo' },
  { id: 'faltou', etapa: ETAPA.NAO_COMPARECEU, rotulo: 'faltou: remarcar', ordem: 'recente' },
  { id: 'negociacao', etapa: ETAPA.NEGOCIACAO, rotulo: 'retomar negociação', ordem: 'recente' },
] as const);

const mesmaEtapa = (a: string | null | undefined, b: string) => !!a && normalizarNome(a) === normalizarNome(b);

/** A etapa do grupo "sem resposta": a de entrada (tipo 1 do Kommo ou pelo nome) ou EM QUALIFICAÇÃO. */
export function etapaDoSemResposta(nome: string | null | undefined, tipo?: number | null): boolean {
  if (!nome) return false;
  return tipo === 1 || ehEtapaDeEntrada(nome) || mesmaEtapa(nome, ETAPA.QUALIFICACAO);
}

// ── leitura dos campos do cartão (pelo nome) ──

export interface CampoDoCartao {
  field_name?: string | null;
  values?: ReadonlyArray<{ value?: unknown }> | null;
}

export function valorDoCampo(campos: ReadonlyArray<CampoDoCartao> | null | undefined, nome: string): unknown {
  const alvo = normalizarNome(nome);
  return (campos ?? []).find((c) => normalizarNome(c.field_name ?? '') === alvo)?.values?.[0]?.value;
}

/** Campo de data do Kommo vem como epoch em segundos; aceita ms e ISO por segurança. `null` se vazio ou lixo. */
export function epochDoValor(v: unknown): number | null {
  if (v == null || v === '' || typeof v === 'boolean') return null;
  const n = typeof v === 'number' ? v : Number(v);
  if (Number.isFinite(n) && n > 0) return n > 1e11 ? Math.floor(n / 1000) : Math.floor(n);
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}/.test(v.trim())) return null;
  const t = Date.parse(v.trim());
  return Number.isFinite(t) ? Math.floor(t / 1000) : null;
}

/** O que a fila precisa de um cartão — montado pelo controller a partir do lead do Kommo. */
export interface CartaoDaFila {
  id: number;
  nome: string;
  etapa: string;
  criadoEpoch: number | null;
  atualizadoEpoch: number | null;
  /** "◷ Data da Consulta" */
  consultaEpoch: number | null;
  /** "✓ Situação da consulta" */
  situacao: string | null;
  /** "◷ Retomar em" */
  retomarEmEpoch: number | null;
  contatoId: number | null;
}

export function cartaoDaFila(
  lead: {
    id: number;
    name?: string | null;
    created_at?: number;
    updated_at?: number;
    custom_fields_values?: ReadonlyArray<CampoDoCartao> | null;
    _embedded?: { contacts?: ReadonlyArray<{ id: number; is_main?: boolean }> } | null;
  },
  etapa: string,
): CartaoDaFila {
  const campos = lead.custom_fields_values ?? [];
  const contatos = lead._embedded?.contacts ?? [];
  const situacao = valorDoCampo(campos, CAMPOS_SYNC.SITUACAO);
  return {
    id: lead.id,
    nome: (lead.name ?? '').trim() || `Cartão ${lead.id}`,
    etapa,
    criadoEpoch: lead.created_at ?? null,
    atualizadoEpoch: lead.updated_at ?? null,
    consultaEpoch: epochDoValor(valorDoCampo(campos, CAMPOS_SYNC.DATA_CONSULTA)),
    situacao: situacao == null || situacao === '' ? null : String(situacao),
    retomarEmEpoch: epochDoValor(valorDoCampo(campos, CAMPO.RETOMAR_EM)),
    contatoId: (contatos.find((c) => c.is_main) ?? contatos[0])?.id ?? null,
  };
}

// ── datas no fuso da unidade ──

/** 'AAAA-MM-DD' + N dias, sem passar por fuso (a data já é local). */
export function somarDias(isoData: string, dias: number): string {
  const [a, m, d] = isoData.split('-').map(Number);
  const t = new Date(Date.UTC(a, m - 1, d + dias, 12));
  return t.toISOString().slice(0, 10);
}

const diaDoEpoch = (epoch: number, tz: string) => dataLocalISO(new Date(epoch * 1000), tz);

/** "14/10" no fuso da unidade. */
export function diaCurto(epoch: number, tz: string): string {
  const [, m, d] = diaDoEpoch(epoch, tz).split('-');
  return `${d}/${m}`;
}

/** "08:00" no fuso da unidade. */
export function horaNoFuso(epoch: number, tz: string): string {
  return new Intl.DateTimeFormat('pt-BR', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(epoch * 1000));
}

/** "14/10 às 08:00" (ou só "14/10" quando a hora é meia-noite — campo só de data). */
export function diaEHora(epoch: number, tz: string): string {
  const hora = horaNoFuso(epoch, tz);
  return hora === '00:00' ? diaCurto(epoch, tz) : `${diaCurto(epoch, tz)} às ${hora}`;
}

// ── as regras, uma por grupo. Cada uma devolve a pista (o que mostrar e a hora de referência) ou null ──

export interface Pista {
  /** O que a atendente lê ao lado do nome: "consulta 14/10 às 08:00", "retomar desde 10/10"… */
  detalhe: string;
  /** Epoch (s) de referência: ordena o grupo e vira o "há quanto tempo" no painel (quando é passado). */
  quando: number;
  /** `quando` só serve para ordenar: o painel não mostra "há quanto tempo" (não se sabe o dia exato). */
  semTempo?: boolean;
}

export function situacaoConfirmada(situacao: string | null | undefined): boolean {
  return normalizarNome(situacao ?? '').includes('confirm');
}

/** AGENDADO: consulta daqui a `confirmarDiasAntes` dias, ainda não confirmada. */
export function regraConfirmar(c: CartaoDaFila, agora: Date, tz: string, prazos: PrazosDaFila = PRAZOS_DA_FILA): Pista | null {
  if (c.consultaEpoch === null || situacaoConfirmada(c.situacao)) return null;
  const alvo = somarDias(dataLocalISO(agora, tz), prazos.confirmarDiasAntes);
  if (diaDoEpoch(c.consultaEpoch, tz) !== alvo) return null;
  const dia = prazos.confirmarDiasAntes === 1 ? 'amanhã' : diaCurto(c.consultaEpoch, tz);
  const hora = horaNoFuso(c.consultaEpoch, tz);
  return { detalhe: `consulta ${dia}${hora === '00:00' ? '' : ` às ${hora}`}`, quando: c.consultaEpoch };
}

/** NÃO COMPARECEU: todo cartão da etapa, menos quem já tem consulta nova no futuro (remarcou e o cartão não andou). */
export function regraFaltou(c: CartaoDaFila, agora: Date, tz: string): Pista | null {
  const agoraEpoch = Math.floor(agora.getTime() / 1000);
  if (c.consultaEpoch !== null && c.consultaEpoch > agoraEpoch) return null;
  const quando = c.consultaEpoch ?? c.atualizadoEpoch ?? c.criadoEpoch;
  if (!quando) return null;
  return { detalhe: c.consultaEpoch !== null ? `faltou em ${diaCurto(c.consultaEpoch, tz)}` : 'faltou', quando };
}

/** EM ESPERA: o "◷ Retomar em" já chegou. Sem data de retomada, a espera é da SDR — não entra. */
export function regraRetomar(c: CartaoDaFila, agora: Date, tz: string): Pista | null {
  if (c.retomarEmEpoch === null) return null;
  const dia = diaDoEpoch(c.retomarEmEpoch, tz);
  const hoje = dataLocalISO(agora, tz);
  if (dia > hoje) return null;
  return { detalhe: dia === hoje ? 'retomar hoje' : `retomar desde ${diaCurto(c.retomarEmEpoch, tz)}`, quando: c.retomarEmEpoch };
}

export interface SinaisDaNegociacao {
  /** A última mexida na conversa do cartão (dentro da janela lida), ou null se não houve conversa na janela. */
  ultimaConversaEpoch: number | null;
  /**
   * O cartão entrou na etapa dentro do prazo? `null` = não deu para ler os eventos do Kommo: aí o `updated_at`
   * do cartão faz as vezes (pior — robô que grava campo também mexe nele), e o controller avisa.
   */
  entrouNaEtapaNoPrazo: boolean | null;
  /** Quantos dias de conversa foram lidos (para o texto "sem conversa há mais de N dias"). */
  janelaDias: number;
}

/**
 * EM NEGOCIAÇÃO: parado há `negociacaoParadaDias`, no MESMO sentido do worker de parados (`parados.ts`): o
 * cartão não mudou de etapa nesse tempo, não é novo, e a conversa do Kommo não mexeu. O `updated_at` do cartão
 * NÃO conta quando há os eventos: robô que grava campo (a resposta da IA, o sincronizador) também mexe nele, e o
 * cartão parado sumiria da fila.
 */
export function regraNegociacao(
  c: CartaoDaFila,
  sinais: SinaisDaNegociacao,
  agora: Date,
  tz: string,
  prazos: PrazosDaFila = PRAZOS_DA_FILA,
): Pista | null {
  const agoraEpoch = Math.floor(agora.getTime() / 1000);
  const desde = agoraEpoch - prazos.negociacaoParadaDias * DIA_S;
  if (c.criadoEpoch !== null && c.criadoEpoch > desde) return null; // cartão novo
  if (sinais.entrouNaEtapaNoPrazo === true) return null; // acabou de chegar na etapa
  if (sinais.entrouNaEtapaNoPrazo === null && (c.atualizadoEpoch ?? 0) > desde) return null;
  const conversa = sinais.ultimaConversaEpoch;
  if (conversa !== null && conversa > desde) return null; // conversou dentro do prazo
  if (conversa !== null) return { detalhe: `sem conversa desde ${diaCurto(conversa, tz)}`, quando: conversa };
  // sem conversa na janela lida: não se sabe o dia exato — o painel não mostra "há quanto tempo"
  return { detalhe: `sem conversa há mais de ${sinais.janelaDias} dias`, quando: c.criadoEpoch ?? desde, semTempo: true };
}

export interface ConversaDaFila {
  /** `is_read` da conversa no Kommo. */
  lida: boolean;
  /** `is_in_work`: conversa aberta (não concluída). */
  aberta: boolean;
  /** `updated_at`: a última mexida na conversa (mensagem que entrou ou saiu). */
  atualizadaEpoch: number;
}

/**
 * Entrada / EM QUALIFICAÇÃO: conversa aberta, NÃO LIDA, parada há mais de `semRespostaHoras`, e a última
 * mexida não foi a Sofia respondendo (`ultimaDaSofiaEpoch`, do nosso banco — a Sofia fala pelo Salesbot e a
 * conversa pode ficar "não lida" mesmo respondida).
 */
export function regraSemResposta(
  conv: ConversaDaFila,
  ultimaDaSofiaEpoch: number | null,
  agora: Date,
  tz: string,
  prazos: PrazosDaFila = PRAZOS_DA_FILA,
): Pista | null {
  if (conv.lida || !conv.aberta || !conv.atualizadaEpoch) return null;
  const agoraEpoch = Math.floor(agora.getTime() / 1000);
  if (agoraEpoch - conv.atualizadaEpoch < prazos.semRespostaHoras * 3600) return null;
  if (ultimaDaSofiaEpoch !== null && ultimaDaSofiaEpoch >= conv.atualizadaEpoch - FOLGA_DA_SOFIA_S) return null;
  const hoje = dataLocalISO(agora, tz) === diaDoEpoch(conv.atualizadaEpoch, tz);
  const hora = horaNoFuso(conv.atualizadaEpoch, tz);
  return { detalhe: hoje ? `escreveu às ${hora}` : `escreveu em ${diaCurto(conv.atualizadaEpoch, tz)} às ${hora}`, quando: conv.atualizadaEpoch };
}

// ── telefone para "Abrir conversa" e "Copiar telefone" ──

/**
 * O telefone do contato no formato do link do WhatsApp (só dígitos, com o país): `+1 555…` fica como está;
 * número brasileiro sem o 55 ganha o 55; zero de discagem na frente sai. `null` quando não parece telefone.
 */
export function telefoneParaWhatsapp(bruto: string | null | undefined): string | null {
  const s = String(bruto ?? '').trim();
  if (!s || s.includes('@')) return null;
  const internacional = s.startsWith('+');
  const d = s.replace(/\D+/g, '').replace(/^0+/, '');
  if (internacional) return d.length >= 10 && d.length <= 15 ? d : null;
  if (d.length === 10 || d.length === 11) return `55${d}`;
  if ((d.length === 12 || d.length === 13) && d.startsWith('55')) return d;
  return null;
}

/** Como a atendente lê (e copia para ligar): "(63) 99102-1043"; de fora do Brasil, "+<dígitos>". */
export function telefoneParaMostrar(digitos: string): string {
  if (digitos.startsWith('55') && (digitos.length === 12 || digitos.length === 13)) {
    const n = digitos.slice(2);
    const ddd = n.slice(0, 2);
    const resto = n.slice(2);
    return `(${ddd}) ${resto.slice(0, resto.length - 4)}-${resto.slice(-4)}`;
  }
  return `+${digitos}`;
}

// ── montar os grupos ──

export interface CandidatoDaFila {
  grupo: IdDoGrupo;
  cartao: CartaoDaFila;
  pista: Pista;
}

export interface GrupoMontado {
  def: DefinicaoDoGrupo;
  total: number;
  itens: CandidatoDaFila[];
}

/**
 * Junta os candidatos por grupo, na ordem do funil, ordena cada grupo e corta em `maxPorGrupo`. O mesmo
 * cartão só aparece uma vez (no primeiro grupo da ordem do funil em que caiu).
 */
export function montarGrupos(candidatos: CandidatoDaFila[], prazos: PrazosDaFila = PRAZOS_DA_FILA): GrupoMontado[] {
  const vistos = new Set<number>();
  return GRUPOS_DA_FILA.map((def) => {
    const doGrupo = candidatos
      .filter((c) => c.grupo === def.id)
      .filter((c) => (vistos.has(c.cartao.id) ? false : (vistos.add(c.cartao.id), true)))
      .sort((a, b) => (def.ordem === 'antigo' ? a.pista.quando - b.pista.quando : b.pista.quando - a.pista.quando) || a.cartao.id - b.cartao.id);
    return { def, total: doGrupo.length, itens: doGrupo.slice(0, prazos.maxPorGrupo) };
  });
}

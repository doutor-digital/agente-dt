/**
 * As REGRAS PURAS das tarefas do CRM (mensagem agendada, ligação com lembrete, lembrete): horário, atraso, janela de 24 h do WhatsApp, em que aba da
 * tela a tarefa cai e os textos do lembrete. Nada aqui fala com o banco nem com o Chatwoot — o worker (`ciclo.ts`) e a tela (`tarefas.controller.ts`)
 * chamam estas funções, então tela e robô nunca discordam do que é «atrasada» ou «dentro do horário».
 */
import { FOLGA_DA_JANELA_MS, JANELA_24H_MS, janelaDe24hAberta } from '../chatwoot-regua.js';
import { fusoValido, offsetMinutosNoFuso, partesNoFuso, FUSO_PADRAO } from '../fuso.js';
import { primeiroNomeSeguro, problemaNoModelo, telefoneWhatsapp } from '../disparo/regras.js';

/** O id desta automação no catálogo (`lib/automacoes.ts`) e a lista do `.env` (quem está LIGADO). */
export const AUTOMACAO_TAREFAS = 'chatwoot-tarefas';

export const TIPOS = ['mensagem', 'ligacao', 'lembrete'] as const;
export type Tipo = (typeof TIPOS)[number];
export const ROTULO_DO_TIPO: Record<Tipo, string> = { mensagem: 'Mensagem', ligacao: 'Ligação', lembrete: 'Lembrete' };

export const ESTADOS = ['pendente', 'enviando', 'aguardando', 'feita', 'falhou', 'barrada', 'cancelada'] as const;
export type EstadoDaTarefa = (typeof ESTADOS)[number];
/** Ainda precisa de alguém (ou do robô): conta como «a fazer». */
export const ESTADOS_ABERTOS: readonly EstadoDaTarefa[] = ['pendente', 'enviando', 'aguardando'];
export const ehAberto = (e: string): boolean => (ESTADOS_ABERTOS as readonly string[]).includes(e);

export const RESULTADOS = ['atendeu', 'nao_atendeu', 'remarcar'] as const;
export type ResultadoDaLigacao = (typeof RESULTADOS)[number];

const MIN = 60_000;
const HORA = 60 * MIN;

/** Quanto a tarefa pode passar do horário e ainda sair SOZINHA. Depois disso a menina precisa confirmar (o servidor pode ter ficado fora do ar). */
export function atrasoMaximoDaMensagemMs(env: NodeJS.ProcessEnv = process.env): number {
  const min = Number(env.CRM_TAREFAS_ATRASO_MAX_MIN);
  return Number.isFinite(min) && min >= 5 && min <= 24 * 60 ? min * MIN : 2 * HORA;
}
/** Lembrete (ligação, lembrete) atrasado demais não vira WhatsApp na madrugada seguinte: fica só na tela. */
export const ATRASO_MAXIMO_DO_LEMBRETE_MS = 3 * HORA;
/** O robô pegou a tarefa e não terminou: depois disto vira «não sei se saiu» (nunca reenvia sozinho). */
export const PRESA_ENVIANDO_MS = 10 * MIN;
/** Tarefa que ainda está dentro do ciclo do robô não conta como atrasada (o ciclo roda a cada minuto). */
export const TOLERANCIA_DO_CICLO_MS = 5 * MIN;
export const MAX_TENTATIVAS_DE_LEITURA = 3;

/** A janela em que o robô pode falar com o PACIENTE: padrão 8h–20h (hora cheia do fuso da unidade). `CRM_TAREFAS_JANELA="9-18"`. */
export interface JanelaDeEnvio {
  inicio: number;
  fim: number;
}
export function janelaDeEnvio(env: NodeJS.ProcessEnv = process.env): JanelaDeEnvio {
  const m = /^\s*(\d{1,2})\s*-\s*(\d{1,2})\s*$/.exec(env.CRM_TAREFAS_JANELA ?? '');
  if (m) {
    const inicio = Number(m[1]);
    const fim = Number(m[2]);
    if (inicio >= 0 && fim <= 24 && inicio < fim) return { inicio, fim };
  }
  return { inicio: 8, fim: 20 };
}

export const fusoOuPadrao = (tz: string | null | undefined): string => (fusoValido(tz) ? (tz as string) : FUSO_PADRAO);

/** «2026-11-18T14:30» (o que o campo de data e hora da tela entrega) no relógio do fuso → o instante UTC. `null` se a data é inválida. */
export function localParaUtc(local: string, tz: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})$/.exec(local.trim());
  if (!m) return null;
  const [ano, mes, dia, hora, min] = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5])];
  if (mes < 1 || mes > 12 || dia < 1 || dia > 31 || hora > 23 || min > 59) return null;
  const fuso = fusoOuPadrao(tz);
  const relogio = Date.UTC(ano, mes - 1, dia, hora, min);
  // duas passadas: o deslocamento do fuso é o do próprio instante (cobre mudança de horário de verão)
  let utc = relogio - offsetMinutosNoFuso(new Date(relogio), fuso) * MIN;
  utc = relogio - offsetMinutosNoFuso(new Date(utc), fuso) * MIN;
  const d = new Date(utc);
  // «31 de novembro» não existe: o relógio de volta tem que ser o pedido
  const p = partesNoFuso(d, fuso);
  return p.ano === ano && p.mes === mes && p.dia === dia && p.hora === hora && p.min === min ? d : null;
}

/** O instante UTC → «2026-11-18T14:30» no relógio do fuso (para preencher o campo da tela ao editar). */
export function utcParaLocal(d: Date, tz: string): string {
  const p = partesNoFuso(d, fusoOuPadrao(tz));
  const z = (n: number) => String(n).padStart(2, '0');
  return `${p.ano}-${z(p.mes)}-${z(p.dia)}T${z(p.hora)}:${z(p.min)}`;
}

export function dentroDaJanela(d: Date, tz: string, j: JanelaDeEnvio): boolean {
  const { hora } = partesNoFuso(d, fusoOuPadrao(tz));
  return hora >= j.inicio && hora < j.fim;
}

/** Quando a mensagem PODE sair: o próprio horário se está dentro da janela; senão a próxima abertura (hoje às 8h, ou amanhã às 8h). */
export function proximaAbertura(d: Date, tz: string, j: JanelaDeEnvio): Date {
  const fuso = fusoOuPadrao(tz);
  if (dentroDaJanela(d, tz, j)) return d;
  const p = partesNoFuso(d, fuso);
  const z = (n: number) => String(n).padStart(2, '0');
  // antes da abertura: hoje; depois do fechamento: o dia seguinte (+12 h cai sempre no dia seguinte, mesmo com mudança de horário de verão)
  const base = p.hora < j.inicio ? d : new Date(d.getTime() + 12 * HORA);
  const b = partesNoFuso(base, fuso);
  return localParaUtc(`${b.ano}-${z(b.mes)}-${z(b.dia)}T${z(j.inicio)}:00`, fuso) ?? d;
}

/** O instante de referência do atraso: o horário que vale (ajustado à janela) ou a confirmação da menina, o que for mais tarde. */
export function referenciaDoAtraso(t: { quando: Date; confirmadaEm: Date | null }, tz: string, j: JanelaDeEnvio): Date {
  const efetivo = proximaAbertura(t.quando, tz, j);
  if (!t.confirmadaEm) return efetivo;
  // confirmar às 20h30 vale a partir das 8h do dia seguinte (a mensagem só sai dentro do horário): senão o atraso nasceria já estourado
  const confirmada = proximaAbertura(t.confirmadaEm, tz, j);
  return confirmada > efetivo ? confirmada : efetivo;
}

// ── a janela de 24 h do WhatsApp (caixa oficial) ─────────────────────────────────────────────────────────────

/** Margem ao agendar: a janela precisa estar aberta ATÉ 2 h depois do horário combinado, senão a tela exige um modelo. */
export const MARGEM_DA_JANELA_MS = 2 * HORA;

/** Dá para GARANTIR que o texto livre sai? Conta a hora em que a mensagem de fato pode sair (dentro do horário), não a combinada. Caixa que não é a oficial não tem janela. */
export function janelaGarantida(ultimaDoPaciente: Date | null, quando: Date, caixaOficial: boolean, tz: string, j: JanelaDeEnvio): boolean {
  if (!caixaOficial) return true;
  return janelaDe24hAberta(ultimaDoPaciente, new Date(proximaAbertura(quando, tz, j).getTime() + MARGEM_DA_JANELA_MS));
}

/** Até quando a janela de 24 h (com a margem) deixa o texto livre sair. `null` = o paciente nunca escreveu: só por modelo. */
function limiteDaJanela(ultimaDoPaciente: Date | null): Date | null {
  if (!ultimaDoPaciente || !Number.isFinite(ultimaDoPaciente.getTime())) return null;
  return new Date(ultimaDoPaciente.getTime() + JANELA_24H_MS - FOLGA_DA_JANELA_MS - MARGEM_DA_JANELA_MS);
}

/**
 * A partir de que horário MARCADO a tela EXIGE um modelo. A mensagem só sai dentro do horário de falar com o paciente (8h–20h): marcada para as 20h30, ela sai às 8h do
 * dia seguinte, e é a essa hora que a janela precisa estar aberta. Então o limite é o da janela de 24 h; se ele cai fora do horário, vale o último fechamento antes dele.
 * `null` = nunca houve mensagem do paciente: sempre exige.
 */
export function modeloAPartirDe(ultimaDoPaciente: Date | null, tz: string, j: JanelaDeEnvio): Date | null {
  const limite = limiteDaJanela(ultimaDoPaciente);
  if (!limite) return null;
  if (dentroDaJanela(limite, tz, j)) return limite;
  const fuso = fusoOuPadrao(tz);
  const p = partesNoFuso(limite, fuso);
  // depois do fechamento: o fechamento é hoje; antes da abertura: foi ontem (−12 h cai sempre no dia anterior)
  const dia = partesNoFuso(p.hora >= j.fim ? limite : new Date(limite.getTime() - 12 * HORA), fuso);
  const z = (n: number) => String(n).padStart(2, '0');
  return localParaUtc(`${dia.ano}-${z(dia.mes)}-${z(dia.dia)}T${z(j.fim)}:00`, fuso) ?? limite;
}

export type ViaDoEnvio = { tipo: 'texto' } | { tipo: 'modelo' } | { tipo: 'nenhuma'; motivo: string };

/** Texto livre se a janela está aberta; senão o modelo; sem nenhum dos dois, não sai. */
export function escolherVia(a: { caixaOficial: boolean; ultimaDoPaciente: Date | null; agora: Date; temTexto: boolean; temModelo: boolean }): ViaDoEnvio {
  if (!a.caixaOficial) return a.temTexto ? { tipo: 'texto' } : { tipo: 'nenhuma', motivo: 'a tarefa não tem texto' };
  const aberta = janelaDe24hAberta(a.ultimaDoPaciente, a.agora);
  if (aberta && a.temTexto) return { tipo: 'texto' };
  if (a.temModelo) return { tipo: 'modelo' };
  if (aberta) return { tipo: 'nenhuma', motivo: 'a tarefa não tem texto nem modelo' };
  return { tipo: 'nenhuma', motivo: 'a janela de 24 h do WhatsApp fechou e a tarefa não tem modelo aprovado para esse caso' };
}

// ── validar o que a tela manda ───────────────────────────────────────────────────────────────────────────────

export interface ModeloDaTarefa {
  nome: string;
  idioma: string;
  texto: string;
  variaveis: string[];
}

export interface PedidoDeTarefa {
  tipo: Tipo;
  texto: string;
  modelo: ModeloDaTarefa | null;
}

export const MAX_TEXTO = 1000;

/** `null` = o pedido serve. Confere o que o servidor sabe SEM o Chatwoot: texto, modelo e nome para a saudação. */
export function problemaNoPedido(p: PedidoDeTarefa, contatoNome: string): string | null {
  const texto = p.texto.trim();
  if (texto.length > MAX_TEXTO) return `o texto passa de ${MAX_TEXTO} caracteres`;
  if (p.tipo !== 'mensagem') {
    if (p.modelo) return 'só mensagem usa modelo';
    return null;
  }
  if (!texto && !p.modelo) return 'escreva a mensagem ou escolha um modelo';
  if (p.modelo) {
    const erro = problemaNoModelo(p.modelo.texto, p.modelo.variaveis);
    if (erro) return erro;
    if (p.modelo.variaveis.includes('primeiroNome') && !primeiroNomeSeguro(contatoNome)) {
      return 'o nome do contato não serve para a saudação do modelo: use «Texto fixo» na variável ou corrija o nome no CRM';
    }
  }
  return null;
}

// ── em que aba da tela a tarefa cai ──────────────────────────────────────────────────────────────────────────

export type Grupo = 'hoje' | 'atrasadas' | 'proximas' | 'feitas';

const diaDoCalendario = (d: Date, tz: string): string => {
  const p = partesNoFuso(d, tz);
  return `${p.ano}-${p.mes}-${p.dia}`;
};

export function grupoDaTarefa(t: { estado: string; quando: Date }, agora: Date, tz: string): Grupo {
  if (!ehAberto(t.estado)) return 'feitas';
  if (t.estado === 'aguardando') return 'atrasadas';
  const fuso = fusoOuPadrao(tz);
  if (t.quando.getTime() < agora.getTime() - TOLERANCIA_DO_CICLO_MS) return 'atrasadas';
  return diaDoCalendario(t.quando, fuso) === diaDoCalendario(agora, fuso) ? 'hoje' : 'proximas';
}

// ── textos ───────────────────────────────────────────────────────────────────────────────────────────────────

export const horaCurta = (d: Date, tz: string): string => {
  const p = partesNoFuso(d, fusoOuPadrao(tz));
  const z = (n: number) => String(n).padStart(2, '0');
  return `${z(p.dia)}/${z(p.mes)} ${z(p.hora)}:${z(p.min)}`;
};

/** Só o nome da pessoa, sem o que o CRM costuma pôr depois (data, origem): primeiras palavras. */
export const nomeCurto = (nome: string): string => nome.trim().split(/\s+/).slice(0, 3).join(' ') || 'o contato';

/** O texto que aparece na nota privada (menção ao responsável) e no WhatsApp da menina. */
export function textoDoLembrete(t: { tipo: Tipo; contatoNome: string; quando: Date; texto: string }, tz: string): string {
  const quando = horaCurta(t.quando, tz);
  const nota = t.texto.trim() ? `\n${t.texto.trim().slice(0, 300)}` : '';
  if (t.tipo === 'ligacao') return `Hora de ligar para ${nomeCurto(t.contatoNome)} (combinado para ${quando}).${nota}`;
  if (t.tipo === 'mensagem') return `Mensagem para ${nomeCurto(t.contatoNome)} agendada para ${quando}.${nota}`;
  return `Lembrete sobre ${nomeCurto(t.contatoNome)} (${quando}).${nota}`;
}

/** A nota privada com a menção: o Chatwoot avisa a pessoa no sininho do CRM. O nome vai codificado na menção. */
export function notaComMencao(responsavel: { id: number; nome: string }, texto: string): string {
  const primeiro = responsavel.nome.trim().split(/\s+/)[0] || 'atendente';
  const limpo = primeiro.replace(/[\[\]()]/g, '');
  return `🔔 [@${limpo}](mention://user/${responsavel.id}/${encodeURIComponent(limpo)}) ${texto}`;
}

/** O celular só com dígitos, 55 e o nono dígito (5594999990000), ou `null` (fixo, DDD que não existe e número de outro país não servem). */
export function telefoneDaMenina(bruto: unknown): string | null {
  const txt = String(bruto ?? '').trim();
  // «+1 415…» é número de outro país: só entra quem diz +55 (ou escreve só DDD + número). O resto é a MESMA regra do disparo (DDD que existe, celular com o 9)
  if (txt.startsWith('+') && !txt.replace(/\D/g, '').startsWith('55')) return null;
  return telefoneWhatsapp(txt);
}

export const telefoneMascarado = (t: string): string => (t.length > 4 ? `…${t.slice(-4)}` : t);

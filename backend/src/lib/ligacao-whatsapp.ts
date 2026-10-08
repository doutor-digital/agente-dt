/**
 * Ligação pelo WhatsApp de dentro do cartão do Kommo — as REGRAS (08/10/2026).
 *
 * Pedido do João: "faça um melhor widget de chamada mesmo, a gente pode ter dentro do Kommo". A SDR liga
 * do navegador (WebRTC) para o WhatsApp do paciente pela Calling API da Meta. A preocupação dele é o que
 * mata o número: "se o pessoal não atender, a gente se dá mal". A Meta só deixa a empresa ligar para quem
 * deu PERMISSÃO, e vai tirando essa permissão de quem não atende (o WhatsApp pergunta ao paciente depois
 * de 2 seguidas sem atender e corta na 4ª). Por isso as travas abaixo existem ANTES do botão:
 *
 *   1. COMBINAR ANTES — a SDR manda "Posso te ligar agora?" no chat. O botão Ligar só fica verde depois
 *      que o paciente responde; sem resposta ele avisa forte e pede confirmação.
 *   2. "1 DE 2 SEM ATENDER" — a 2ª ligação seguida sem atender trava aquele paciente. Volta a liberar UMA
 *      tentativa quando ele escreve no chat; a 3ª seguida trava de vez (fica uma antes do corte da Meta).
 *      Zera quando ele atende ou quando dá permissão de novo.
 *   3. VIGIA DO NÚMERO — taxa de atendimento do dia na unidade. Abaixo do limite, a fila "Ligar próximo"
 *      pausa sozinha até o dia seguinte e abre uma tarefa ALERTA no cartão.
 *   4. O widget mostra o estado da permissão, as tentativas e a última ligação.
 *
 * Este arquivo é só regra: nada aqui fala com a Meta, com o Kommo ou com o banco — por isso é testado à
 * parte (`ligacao-whatsapp.test.ts`). Quem orquestra é `ligacao-whatsapp-servico.ts`.
 */

// ── números padrão (cada unidade pode ajustar em `whatsapp_ligacao_config`) ─────────────────────────

export const PADROES = {
  /** Ligações seguidas sem atender que travam o paciente. O WhatsApp pergunta ao paciente na 2ª. */
  maxSemAtender: 2,
  /** Teto absoluto: mesmo com o paciente escrevendo, a partir daqui só volta com permissão nova. A Meta corta na 4ª. */
  tetoSemAtender: 3,
  /** % mínimo de atendidas no dia antes de a fila pausar. */
  taxaMinima: 50,
  /** Ligações no dia antes de o vigia julgar a taxa (com 2 ligações, 1 não atendida não diz nada). */
  amostraMinima: 6,
  /** Por quanto tempo vale a resposta do paciente ao "Posso te ligar agora?". */
  combinadoValeMin: 30,
  /** Depois disso, a pergunta sem resposta é considerada velha (perguntar de novo). */
  perguntaValeMin: 120,
  /** Pedidos de permissão (limite da Meta): 1 a cada 24 h e 2 a cada 7 dias. */
  pedidosPor24h: 1,
  pedidosPor7d: 2,
  /** Ligação que ninguém encerrou (webhook perdido): depois disso o vigia fecha sozinho. */
  semRetornoChamandoMin: 3,
  semRetornoEmLigacaoMin: 120,
} as const;

const MIN = 60_000;
const HORA = 60 * MIN;
const DIA = 24 * HORA;

export interface Ajustes {
  maxSemAtender: number;
  tetoSemAtender: number;
  taxaMinima: number;
  amostraMinima: number;
}

/** Junta o que a unidade gravou com o padrão, sem deixar ninguém passar do corte da Meta (4ª seguida). */
export function ajustesDaUnidade(c: { maxSemAtender?: number | null; taxaMinima?: number | null; amostraMinima?: number | null } | null): Ajustes {
  const max = inteiroEntre(c?.maxSemAtender, 1, 3) ?? PADROES.maxSemAtender;
  return {
    maxSemAtender: max,
    tetoSemAtender: Math.min(max + 1, PADROES.tetoSemAtender),
    taxaMinima: inteiroEntre(c?.taxaMinima, 0, 100) ?? PADROES.taxaMinima,
    amostraMinima: inteiroEntre(c?.amostraMinima, 1, 100) ?? PADROES.amostraMinima,
  };
}

function inteiroEntre(v: number | null | undefined, min: number, max: number): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  const n = Math.round(v);
  return n < min || n > max ? null : n;
}

// ── telefone ─────────────────────────────────────────────────────────────────────────────────────

/**
 * O número como a Meta quer (só dígitos, com 55). Devolve null para o que não é celular brasileiro
 * plausível — ligar para número errado também é ligação não atendida.
 */
export function telefoneParaMeta(bruto: string | null | undefined): string | null {
  let d = String(bruto ?? '').replace(/\D+/g, '');
  if (!d) return null;
  if (d.startsWith('00')) d = d.slice(2);
  if (d.length === 10 || d.length === 11) d = `55${d}`;
  if (!d.startsWith('55')) return d.length >= 10 && d.length <= 15 ? d : null; // estrangeiro: deixa a Meta decidir
  return d.length === 12 || d.length === 13 ? d : null;
}

/** 8 últimos dígitos: o mesmo casamento do resto do sistema (cobre o nono dígito que o `wa_id` às vezes não tem). */
export function chaveDoTelefone(bruto: string | null | undefined): string {
  const d = String(bruto ?? '').replace(/\D+/g, '');
  return d.length > 8 ? d.slice(-8) : d;
}

/** "…4321" — o que aparece na tela e no log. Telefone inteiro não sai do servidor. */
export function telefoneMascarado(bruto: string | null | undefined): string {
  const d = String(bruto ?? '').replace(/\D+/g, '');
  return d ? `…${d.slice(-4)}` : '';
}

// ── permissão ────────────────────────────────────────────────────────────────────────────────────

export type Permissao = 'sem' | 'pedida' | 'aceita' | 'recusada' | 'caiu';

export interface PermissaoGravada {
  permissao: string;
  permissaoAte: Date | null;
  permanente: boolean;
  pedidosEm: Date[];
}

/** O estado que vale AGORA: "aceita" vencida vira "caiu". */
export function permissaoAgora(p: PermissaoGravada | null, agora: Date): { estado: Permissao; ate: Date | null; permanente: boolean } {
  if (!p) return { estado: 'sem', ate: null, permanente: false };
  const estado = (['sem', 'pedida', 'aceita', 'recusada', 'caiu'] as const).find((e) => e === p.permissao) ?? 'sem';
  if (estado === 'aceita' && !p.permanente && p.permissaoAte && p.permissaoAte.getTime() <= agora.getTime()) {
    return { estado: 'caiu', ate: p.permissaoAte, permanente: false };
  }
  return { estado, ate: p.permissaoAte, permanente: estado === 'aceita' && p.permanente };
}

/**
 * Pode mandar outro pedido de permissão? A Meta aceita 1 a cada 24 h e 2 a cada 7 dias por paciente; passar
 * disso volta erro e, pior, irrita o paciente. A conta é nossa (os horários ficam gravados) e a Meta confere
 * de novo do lado dela.
 */
export function podePedirPermissao(
  pedidosEm: Date[],
  agora: Date,
  estado: Permissao,
  /** O que a Meta diz (`call_permissions` → send_call_permission_request). Ela zera a conta quando uma
   * ligação conecta, coisa que a nossa conta não enxerga — então, quando ela responde, ela manda. */
  metaPodePedir: boolean | null = null,
): { ok: true; usados7d: number } | { ok: false; motivo: string; liberaEm: Date | null; usados7d: number } {
  const t = agora.getTime();
  const semana = pedidosEm.map((d) => d.getTime()).filter((x) => t - x < 7 * DIA).sort((a, b) => a - b);
  const usados7d = semana.length;
  if (estado === 'aceita') return { ok: false, motivo: 'O paciente já deu permissão — pode ligar.', liberaEm: null, usados7d };
  if (metaPodePedir === true) return { ok: true, usados7d };
  if (metaPodePedir === false) {
    return { ok: false, motivo: 'A Meta não deixa pedir de novo agora (1 pedido por dia e 2 por semana). Combine pelo chat.', liberaEm: null, usados7d };
  }
  const ultimo = semana[semana.length - 1];
  if (ultimo !== undefined && t - ultimo < DIA / PADROES.pedidosPor24h) {
    return { ok: false, motivo: 'Já foi pedido nas últimas 24 h. A Meta só deixa pedir 1 vez por dia.', liberaEm: new Date(ultimo + DIA), usados7d };
  }
  if (usados7d >= PADROES.pedidosPor7d) {
    return { ok: false, motivo: 'Já foram 2 pedidos nesta semana — o limite da Meta. Combine pelo chat.', liberaEm: new Date(semana[0] + 7 * DIA), usados7d };
  }
  return { ok: true, usados7d };
}

/** Texto padrão do pedido de permissão (o WhatsApp mostra junto os botões de permitir/recusar). */
export function textoDoPedido(unidade: string, personalizado?: string | null): string {
  const t = (personalizado ?? '').trim();
  if (t) return t.slice(0, 1024);
  const nome = unidade.trim() || 'a clínica';
  return `Olá! Aqui é da ${nome}. Podemos te ligar por aqui, pelo WhatsApp, quando precisarmos falar com você? É mais rápido que mensagem — e você escolhe se permite.`;
}

// ── trava 1: combinar antes ──────────────────────────────────────────────────────────────────────

export type Combinado = 'nao-perguntou' | 'esperando' | 'respondeu' | 'vencido';

/**
 * O "Posso te ligar agora?". `respondeuEm` = primeira mensagem do paciente no chat DEPOIS da pergunta
 * (o serviço lê do Kommo). Resposta vale 30 min; pergunta sem resposta fica velha em 2 h.
 */
export function estadoDoCombinado(perguntouEm: Date | null, respondeuEm: Date | null, agora: Date): Combinado {
  if (!perguntouEm) return 'nao-perguntou';
  const t = agora.getTime();
  if (respondeuEm && respondeuEm.getTime() >= perguntouEm.getTime()) {
    return t - respondeuEm.getTime() <= PADROES.combinadoValeMin * MIN ? 'respondeu' : 'vencido';
  }
  return t - perguntouEm.getTime() <= PADROES.perguntaValeMin * MIN ? 'esperando' : 'vencido';
}

/** O texto que a SDR cola no chat. Curto, com o primeiro nome, sem prometer nada. */
export function textoDoCombinado(nome: string | null | undefined): string {
  const primeiro = String(nome ?? '')
    .replace(/\s+\d{1,2}\/\d{1,2}(\/\d{2,4})?\s*$/, '')
    .trim()
    .split(/\s+/)[0];
  const ok = primeiro && /^[\p{L}'-]{2,}$/u.test(primeiro) && !/^lead$/i.test(primeiro);
  const nomeBonito = ok ? primeiro.charAt(0).toUpperCase() + primeiro.slice(1).toLowerCase() : '';
  return `Oi${nomeBonito ? `, ${nomeBonito}` : ''}! Posso te ligar agora pelo WhatsApp? É rapidinho.`;
}

// ── trava 2: "1 de 2 sem atender" ────────────────────────────────────────────────────────────────

export interface Trava {
  travado: boolean;
  /** travado de vez: só volta com permissão nova (a Meta já perguntou ao paciente se quer continuar). */
  firme: boolean;
  seguidas: number;
  limite: number;
  /** "1 de 2 sem atender" */
  rotulo: string;
  explicacao: string;
}

export function travaDoPaciente(
  a: { naoAtendidasSeguidas: number; ultimaNaoAtendidaEm: Date | null; escreveuDepois: boolean },
  aj: Ajustes,
): Trava {
  const seguidas = Math.max(0, a.naoAtendidasSeguidas | 0);
  const limite = aj.maxSemAtender;
  const rotulo = seguidas > 0 ? `${Math.min(seguidas, limite)} de ${limite} sem atender` : '';
  if (seguidas >= aj.tetoSemAtender) {
    return {
      travado: true, firme: true, seguidas, limite, rotulo: `${seguidas} seguidas sem atender`,
      explicacao: `Travado: ${seguidas} ligações seguidas sem atender. Mais uma e o WhatsApp corta a permissão. Mande mensagem; só volta quando ele der permissão de novo.`,
    };
  }
  if (seguidas >= limite) {
    if (a.escreveuDepois) {
      return {
        travado: false, firme: false, seguidas, limite, rotulo,
        explicacao: 'Ele escreveu depois da última ligação — libera UMA tentativa. Combine o horário antes.',
      };
    }
    return {
      travado: true, firme: false, seguidas, limite, rotulo,
      explicacao: `Travado: ${seguidas} ligações seguidas sem atender. Mande mensagem e espere ele responder — aí libera de novo.`,
    };
  }
  return { travado: false, firme: false, seguidas, limite, rotulo, explicacao: '' };
}

// ── a decisão de ligar ───────────────────────────────────────────────────────────────────────────

export type ModoChave = 'ligado' | 'seco' | 'desligado';
export type Origem = 'cartao' | 'fila';

export interface PedidoDeLigacao {
  modo: ModoChave;
  /** O número está na lista de teste (`LIGACAO_TESTE_TELEFONES`) — o único que liga em "só no papel". */
  numeroDeTeste: boolean;
  temCredencial: boolean;
  telefoneValido: boolean;
  permissao: Permissao;
  /** O que a Meta diz agora (`call_permissions` → start_call). null = não conferido. */
  metaDeixa: boolean | null;
  trava: Trava;
  combinado: Combinado;
  confirmouSemCombinar: boolean;
  origem: Origem;
  filaPausada: boolean;
  emAndamento: boolean;
}

export type DecisaoDeLigacao =
  | { ok: true; semCombinar: boolean }
  | { ok: false; codigo: string; motivo: string; precisaConfirmar?: boolean };

/** Ordem importa: o primeiro "não" é o que a SDR lê. Os mais graves vêm antes. */
export function decidirLigacao(p: PedidoDeLigacao): DecisaoDeLigacao {
  if (p.modo === 'desligado') return { ok: false, codigo: 'desligada', motivo: 'A ligação pelo WhatsApp está desligada nesta unidade.' };
  if (p.modo === 'seco' && !p.numeroDeTeste) {
    return { ok: false, codigo: 'so-teste', motivo: 'Modo teste: por enquanto só liga para o número de teste. Nada foi feito.' };
  }
  if (!p.temCredencial) return { ok: false, codigo: 'sem-credencial', motivo: 'A unidade ainda não tem o número oficial do WhatsApp configurado.' };
  if (!p.telefoneValido) return { ok: false, codigo: 'sem-telefone', motivo: 'O contato do cartão não tem um celular válido.' };
  if (p.emAndamento) return { ok: false, codigo: 'em-andamento', motivo: 'Já tem uma ligação em andamento com este paciente.' };
  if (p.permissao !== 'aceita') {
    const frase: Record<Permissao, string> = {
      sem: 'O paciente ainda não deu permissão para receber ligação. Peça a permissão primeiro.',
      pedida: 'A permissão foi pedida e o paciente ainda não respondeu.',
      recusada: 'O paciente recusou receber ligação. Fale por mensagem.',
      caiu: 'A permissão do paciente acabou. Peça de novo.',
      aceita: '',
    };
    return { ok: false, codigo: 'sem-permissao', motivo: frase[p.permissao] };
  }
  if (p.metaDeixa === false) return { ok: false, codigo: 'meta-nao-deixa', motivo: 'A Meta não deixa ligar para este paciente agora (limite do dia ou permissão retirada).' };
  if (p.trava.travado) return { ok: false, codigo: 'travado', motivo: p.trava.explicacao };
  if (p.origem === 'fila' && p.filaPausada) return { ok: false, codigo: 'fila-pausada', motivo: 'A fila está pausada hoje: muitas ligações sem atender. Ligue só combinando antes, pelo cartão.' };
  if (p.combinado !== 'respondeu') {
    if (!p.confirmouSemCombinar) {
      const quando = p.combinado === 'esperando' ? 'Ele ainda não respondeu ao "Posso te ligar agora?".' : 'Você não combinou a ligação antes.';
      return {
        ok: false,
        codigo: 'combinar',
        precisaConfirmar: true,
        motivo: `${quando} Ligação sem combinar é a que mais fica sem atender — e ${p.trava.limite} seguidas travam este paciente.`,
      };
    }
    return { ok: true, semCombinar: true };
  }
  return { ok: true, semCombinar: false };
}

// ── o resultado de uma ligação ───────────────────────────────────────────────────────────────────

export type Resultado = 'atendida' | 'nao_atendida' | 'recusada' | 'falhou';

/**
 * O que aconteceu, pelo que chegou da Meta. Atendeu = a Meta mandou ACCEPTED ou a duração passou de zero.
 * "falhou" é problema técnico (a ligação nem saiu) e NÃO conta como sem atender.
 */
export function resultadoDaLigacao(l: {
  atendidaEm: Date | null;
  duracaoSeg: number | null;
  recusada: boolean;
  falhaTecnica: boolean;
}): Resultado {
  if (l.atendidaEm || (l.duracaoSeg ?? 0) > 0) return 'atendida';
  if (l.recusada) return 'recusada';
  if (l.falhaTecnica) return 'falhou';
  return 'nao_atendida';
}

/** Conta para a trava 2? Recusar também é "não atendeu" para o WhatsApp — e para nós, por segurança. */
export function contaComoSemAtender(r: Resultado): boolean {
  return r === 'nao_atendida' || r === 'recusada';
}

/** Novo contador de seguidas sem atender depois de uma ligação. */
export function proximoContador(atual: number, r: Resultado): number {
  if (r === 'atendida') return 0;
  if (contaComoSemAtender(r)) return Math.max(0, atual | 0) + 1;
  return Math.max(0, atual | 0);
}

export function duracaoLegivel(seg: number | null | undefined): string {
  const s = Math.max(0, Math.round(seg ?? 0));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return m ? `${m}min${r ? ` ${String(r).padStart(2, '0')}s` : ''}` : `${r}s`;
}

// ── registro no Kommo (POST /api/v4/calls, igual à 3C) ──────────────────────────────────────────

export const FONTE_KOMMO = 'DD · Ligação WhatsApp';

/**
 * Status do Kommo: 1 deixou recado · 2 retornar depois · 3 indisponível · 4 conversou · 5 número errado ·
 * 6 não conseguiu falar · 7 ocupado. "Recusou" vira 7 (o paciente derrubou), "não atendeu" e "falhou" viram 6.
 */
export function statusNoKommo(r: Resultado): number {
  return r === 'atendida' ? 4 : r === 'recusada' ? 7 : 6;
}

export function textoDoResultado(r: Resultado, l: { duracaoSeg: number | null; seguidas?: number; limite?: number; semCombinar?: boolean; erro?: string | null }): string {
  const sem = l.semCombinar ? ' (sem combinar antes)' : '';
  if (r === 'atendida') return `Ligação pelo WhatsApp atendida · ${duracaoLegivel(l.duracaoSeg)}${sem}`;
  if (r === 'recusada') return `O paciente recusou a ligação pelo WhatsApp${l.seguidas ? ` · ${l.seguidas} de ${l.limite} sem atender` : ''}${sem}`;
  if (r === 'falhou') return `A ligação pelo WhatsApp não completou${l.erro ? ` (${l.erro.slice(0, 120)})` : ''}`;
  return `Não atendeu a ligação pelo WhatsApp${l.seguidas ? ` · ${l.seguidas} de ${l.limite} sem atender` : ''}${sem}`;
}

export interface RegistroKommo {
  direction: 'outbound';
  uniq: string;
  duration: number;
  source: string;
  phone: string;
  call_status: number;
  call_result: string;
  created_at: number;
  responsible_user_id?: number;
  created_by?: number;
}

export function registroParaKommo(l: {
  id: string;
  waCallId: string | null;
  telefone: string;
  duracaoSeg: number | null;
  criadaEm: Date;
  kommoUserId: number | null;
  resultado: Resultado;
  texto: string;
}): RegistroKommo {
  const r: RegistroKommo = {
    direction: 'outbound',
    uniq: l.waCallId || `dd-${l.id}`,
    duration: Math.max(0, Math.round(l.duracaoSeg ?? 0)),
    source: FONTE_KOMMO,
    phone: `+${l.telefone.replace(/\D+/g, '')}`,
    call_status: statusNoKommo(l.resultado),
    call_result: l.texto.slice(0, 250),
    created_at: Math.floor(l.criadaEm.getTime() / 1000),
  };
  if (l.kommoUserId && l.kommoUserId > 0) {
    r.responsible_user_id = l.kommoUserId;
    r.created_by = l.kommoUserId; // sem isto o Kommo mostra a ligação como "feita por robô" nas estatísticas
  }
  return r;
}

// ── trava 3: o vigia do número ───────────────────────────────────────────────────────────────────

export interface TaxaDoDia {
  total: number;
  atendidas: number;
  /** 0–100, ou null sem ligação */
  taxa: number | null;
}

/** Só conta ligação que chegou ao paciente: falha técnica não diz nada sobre a equipe. */
export function taxaDeAtendimento(resultados: Array<string | null>): TaxaDoDia {
  const validos = resultados.filter((r): r is Resultado => r === 'atendida' || r === 'nao_atendida' || r === 'recusada');
  const atendidas = validos.filter((r) => r === 'atendida').length;
  return { total: validos.length, atendidas, taxa: validos.length ? Math.round((atendidas / validos.length) * 100) : null };
}

export function vigiaDecide(t: TaxaDoDia, aj: Ajustes): { pausar: boolean; motivo: string } {
  if (t.total < aj.amostraMinima || t.taxa === null) return { pausar: false, motivo: '' };
  if (t.taxa >= aj.taxaMinima) return { pausar: false, motivo: '' };
  return {
    pausar: true,
    motivo: `Hoje só ${t.atendidas} de ${t.total} ligações pelo WhatsApp foram atendidas (${t.taxa}%; o mínimo é ${aj.taxaMinima}%).`,
  };
}

export function textoDoAlertaDoVigia(slug: string, motivo: string): string {
  return (
    `ALERTA · ${slug} · ☎ ${motivo} A fila "Ligar próximo" pausou até amanhã para proteger o número. ` +
    'Ligue só depois de combinar no chat ("Posso te ligar agora?") e só para quem respondeu.'
  );
}

// ── dia no fuso da unidade ───────────────────────────────────────────────────────────────────────

/** Meia-noite de hoje no fuso da unidade, e a de amanhã (quando a pausa da fila acaba). */
export function diaNoFuso(agora: Date, tz: string): { inicio: Date; fim: Date } {
  const dia = agora.toLocaleDateString('en-CA', { timeZone: tz }); // AAAA-MM-DD
  const [a, m, d] = dia.split('-').map(Number);
  const meiaNoite = (ano: number, mes: number, diaN: number): Date => {
    const comoUtc = Date.UTC(ano, mes - 1, diaN, 0, 0, 0);
    // offset do fuso naquele instante (São Paulo: -180)
    const p = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
      .formatToParts(new Date(comoUtc));
    const n = (t: string) => Number(p.find((x) => x.type === t)?.value ?? '0');
    const local = Date.UTC(n('year'), n('month') - 1, n('day'), n('hour'), n('minute'), n('second'));
    const offsetMin = Math.round((local - comoUtc) / MIN);
    return new Date(comoUtc - offsetMin * MIN);
  };
  const inicio = meiaNoite(a, m, d);
  const amanha = new Date(Date.UTC(a, m - 1, d + 1));
  const fim = meiaNoite(amanha.getUTCFullYear(), amanha.getUTCMonth() + 1, amanha.getUTCDate());
  return { inicio, fim };
}

// ── erros da Meta em português ───────────────────────────────────────────────────────────────────

/** O que a SDR lê quando a Meta recusa. Código desconhecido devolve a frase genérica + o código. */
export function erroDaMetaEmPortugues(codigo: number | null | undefined, mensagem?: string | null): string {
  const c = Number(codigo);
  // Tabela da doc oficial (calling/troubleshooting, lida em 08/10/2026). 138024 vem do Health Status da Meta;
  // 138038 não está na doc oficial — definição de SDK de terceiros (roteamento de conversas).
  const mapa: Record<number, string> = {
    138000: 'As ligações não estão ligadas neste número na Meta. Precisa ativar nas configurações de chamada.',
    138001: 'O WhatsApp deste paciente não recebe ligação (app antigo ou número fora do WhatsApp).',
    138002: 'Limite de ligações ao mesmo tempo atingido. Tente em instantes.',
    138003: 'Já tem uma ligação acontecendo com este paciente — espere terminar.',
    138004: 'Erro de conexão com a Meta. Tente de novo.',
    138005: 'Muitas ligações em pouco tempo. Espere um pouco.',
    138006: 'O paciente não deu permissão para receber ligação (ou a permissão acabou). Peça de novo.',
    138007: 'A conexão de áudio não fechou a tempo. Tente de novo.',
    138009: 'Limite de pedidos de permissão atingido para este paciente (1 por dia, 2 por semana).',
    138012: 'Limite de ligações para este paciente nas últimas 24 h.',
    138013: 'Ligação da empresa indisponível para este número ou país.',
    138014: 'A Meta suspendeu as ligações deste número por um tempo (denúncias ou bloqueios). Fale só por mensagem.',
    138015: 'O número ainda não pode ligar: a Meta exige limite de 2.000 conversas por dia.',
    138017: 'O paciente já deu permissão permanente.',
    138018: 'Falta a configuração técnica do número (webhook de ligações).',
    138019: 'A ligação não conseguiu começar. Tente de novo.',
    138020: 'A ligação não conseguiu começar. Tente de novo.',
    138021: 'O áudio não chegou. Confira o microfone e a internet.',
    138022: 'O áudio não saiu. Confira o microfone e a internet.',
    138023: 'A ligação ficou sem áudio depois de atendida.',
    138024: 'Configuração de chamada do número incompleta.',
    138038: 'Outro aplicativo está como responsável pelas ligações deste número (roteamento de conversas da Meta).',
    131047: 'A janela de 24 h está fechada: o paciente não escreve há mais de 24 h. Peça a permissão quando ele responder, ou cadastre o modelo aprovado.',
    131026: 'Este número não recebe mensagem do WhatsApp.',
    131044: 'A conta do WhatsApp está sem forma de pagamento na Meta.',
    131056: 'Muitas mensagens para este paciente em pouco tempo.',
    141006: 'A conta do WhatsApp está bloqueada por pagamento na Meta.',
    613: 'Muitas consultas seguidas na Meta. Espere um minuto.',
    190: 'O token da Meta desta unidade venceu ou foi trocado.',
  };

  if (mapa[c]) return mapa[c];
  return `A Meta recusou${c ? ` (código ${c})` : ''}${mensagem ? `: ${String(mensagem).slice(0, 140)}` : '.'}`;
}

/**
 * Leitura da TELA de edição do atendimento da franquia (app.doutorhernia.com.br/agendamentos/editar/<id>).
 *
 * Por que existe: a API Spine não devolve os campos de "Informações Adicionais" (data do retorno, forma de
 * pagamento, tratamento a ser realizado, perfil, motivo para não realizar o tratamento) — só a tela mostra.
 * O João quer que a SDR digite UMA vez, na franquia, e o Kommo reflita. Mesmo caminho do raspador de bloqueios
 * (/root/sync-bloqueios.mjs): login com e-mail e senha, troca de unidade pelo seletor, leitura do HTML.
 *
 * Só LÊ. Nunca envia o formulário de edição (isso alteraria um atendimento real).
 *
 * O login vem de `FRANQUIA_TELA_USER` / `FRANQUIA_TELA_PASS` — nunca do código. A sessão é POR UNIDADE e dura
 * uma varredura: "unidade ativa" é estado da sessão no servidor da franquia, então uma sessão compartilhada entre
 * unidades se atropelaria.
 */
import { logger } from './logger.js';

const BASE = 'https://app.doutorhernia.com.br';
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/126 Safari/537.36';
const TIMEOUT_MS = 30_000;

/** slug no banco da Sofia → id_company no seletor de unidade da franquia (mesmo mapa do raspador de bloqueios). */
export const ID_COMPANY_POR_SLUG: Readonly<Record<string, number>> = {
  'doutor-hernia-imperatriz': 133,
  'doutor-hernia-acailandia': 333,
  'doutor-hernia-araguaina': 93,
  'doutor-hernia-balsas': 132,
  'doutor-hernia-boa-vista': 128,
  'doutor-hernia-canaa': 166,
  'doutor-hernia-maraba': 114,
  'doutor-hernia-parauapebas': 131,
  'doutor-hernia-porto': 320,
  'doutor-hernia-serra': 77,
  'doutor-hernia-bebedouro': 346,
  'doutor-hernia-mossoro': 232,
  'doutor-hernia-taubate': 197,
  'doutor-hernia-olimpia': 214,
  'doutor-hernia-rioverde': 440,
};

/** O que a tela de edição tem em "Informações Adicionais". `null` = vazio na franquia. */
export interface AtendimentoTela {
  /** AAAA-MM-DDTHH:mm (hora local da clínica). A franquia usa 01/01/1900 como "sem data" — aqui vira null. */
  retornoLocal: string | null;
  formaPagamento: string | null;
  /** "PROTOCOLO 03 MESES" etc. — só a duração; o Kommo tem 18 tipos, por isso este campo não é espelhado. */
  tratamentoFuturo: string | null;
  perfil: string | null;
  motivoNaoRealizar: string | null;
}

/** `&amp;` por ÚLTIMO: decodificar primeiro transformaria "&amp;lt;" (o texto "&lt;" digitado) em "<". */
function decodificar(s: string): string {
  return s
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0*39;/g, "'")
    .replace(/&#(\d{1,7});/g, (m, n: string) => {
      const c = Number(n);
      return c > 0 && c <= 0x10ffff ? String.fromCodePoint(c) : m;
    })
    .replace(/&amp;/g, '&');
}

const vazioParaNull = (v: string | null | undefined): string | null => {
  const t = decodificar(String(v ?? '')).replace(/\s+/g, ' ').trim();
  return t === '' || /^selecione$/i.test(t) ? null : t;
};

function escapar(nome: string): string {
  return nome.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Texto da opção marcada de um <select name="...">; null se não há select, ou nenhuma opção real marcada. */
function selecionado(html: string, nome: string): string | null {
  const m = new RegExp(`<select\\b[^>]*\\bname="${escapar(nome)}"[^>]*>([\\s\\S]*?)</select>`, 'i').exec(html);
  if (!m) return null;
  const opcoes = m[1].matchAll(/<option\b([^>]*)>([\s\S]*?)<\/option>/gi);
  for (const o of opcoes) if (/\bselected\b/i.test(o[1])) return vazioParaNull(o[2].replace(/<[^>]+>/g, ''));
  return null;
}

/**
 * Valor de um campo de texto da tela: `value` do <input name="..."> (em qualquer ordem de atributos) ou o miolo de um
 * <textarea>. `value=` não pode casar com `data-value=` — por isso o lookbehind.
 */
function valorDoInput(html: string, nome: string): string | null {
  for (const tag of html.matchAll(/<input\b[^>]*>/gi)) {
    if (!new RegExp(`\\bname="${escapar(nome)}"`, 'i').test(tag[0])) continue;
    const v = /(?<![\w-])value="([^"]*)"/i.exec(tag[0]);
    return vazioParaNull(v?.[1]);
  }
  const t = new RegExp(`<textarea\\b[^>]*\\bname="${escapar(nome)}"[^>]*>([\\s\\S]*?)</textarea>`, 'i').exec(html);
  return t ? vazioParaNull(t[1]) : null;
}

/** "02/10/2026 14:30" → "2026-10-02T14:30". 01/01/1900 (o "sem data" da franquia) e lixo viram null. */
export function dataDaTela(bruto: string | null): string | null {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})(?:\s+(\d{2}):(\d{2}))?/.exec(String(bruto ?? '').trim());
  if (!m) return null;
  const ano = Number(m[3]);
  if (ano <= 1900) return null;
  const dia = Number(m[1]);
  const mes = Number(m[2]);
  if (mes < 1 || mes > 12 || dia < 1 || dia > 31) return null;
  return `${m[3]}-${m[2]}-${m[1]}T${m[4] ?? '00'}:${m[5] ?? '00'}`;
}

/** A página tem o formulário de edição? Sem isso (sessão caiu, id de outra unidade) o resto não vale nada. */
export function ehTelaDeEdicao(html: string): boolean {
  return /name="id_form_payment"/.test(html) && /name="reason_refusal"/.test(html);
}

/** A página é o formulário de login? Só isso prova que a sessão caiu — "este id não abre" (apagado, de outra unidade) é outra coisa. */
export function ehTelaDeLogin(html: string): boolean {
  return /name="password"/i.test(html) && !ehTelaDeEdicao(html);
}

/** Puro. Devolve null se a página não for a de edição. */
export function lerAtendimentoDaTela(html: string): AtendimentoTela | null {
  if (!ehTelaDeEdicao(html)) return null;
  return {
    retornoLocal: dataDaTela(valorDoInput(html, 'return_at')),
    formaPagamento: selecionado(html, 'id_form_payment'),
    tratamentoFuturo: selecionado(html, 'id_future_treatment'),
    perfil: valorDoInput(html, 'client_profile'),
    motivoNaoRealizar: valorDoInput(html, 'reason_refusal'),
  };
}

export type ProblemaDaTela = 'entrar' | 'sessao' | 'layout';

const AVISOS: Record<ProblemaDaTela, { titulo: string; houve: string; causa: string; fazer: string }> = {
  entrar: {
    titulo: 'Robô da franquia não conseguiu entrar',
    houve: 'o login na tela da franquia não passou.',
    causa: 'senha vencida, login ausente no servidor ou site fora do ar.',
    fazer: 'conferir FRANQUIA_TELA_USER e FRANQUIA_TELA_PASS no servidor e se app.doutorhernia.com.br abre.',
  },
  sessao: {
    titulo: 'Robô da franquia perdeu a sessão',
    houve: 'a franquia devolveu a tela de login 3 vezes seguidas.',
    causa: 'senha vencida ou trocada.',
    fazer: 'atualizar FRANQUIA_TELA_PASS no servidor.',
  },
  layout: {
    titulo: 'Robô da franquia não reconhece mais a tela',
    houve: 'a tela de edição do atendimento abriu 5 vezes seguidas sem os campos esperados.',
    causa: 'a franquia mudou a página.',
    fazer: 'chamar o Claude para ajustar o leitor (franquia-tela.ts).',
  },
};

/** Texto do aviso no WhatsApp (formatação do próprio WhatsApp: *negrito*, _itálico_). Puro, para poder testar. */
export function montarAvisoDaTela(unidade: string, tipo: ProblemaDaTela): string {
  const a = AVISOS[tipo];
  return [
    `🚨 *${a.titulo}* — ${unidade}`,
    '',
    `*O que houve:* ${a.houve}`,
    `*Provável causa:* ${a.causa}`,
    '',
    '*Efeito agora:*',
    '• Forma de pagamento, retorno e motivo *não chegam* no cartão do Kommo',
    '• O resto do sincronizador segue normal',
    '',
    `*O que fazer:* ${a.fazer}`,
    '',
    '_Aviso automático. Se o problema continuar, repito em 6 h._',
  ].join('\n');
}

type Buscar = typeof fetch;

export class SessaoTela {
  private cookies = new Map<string, string>();
  /** leituras seguidas que deram tela de login ou erro de rede — 3, e a sessão caiu: a varredura desiste desta unidade. */
  private falhasSeguidas = 0;
  /** páginas seguidas que abriram (200), não eram login e também não eram a tela de edição — o layout da franquia pode ter mudado. */
  private telasInesperadas = 0;

  constructor(
    private readonly user: string,
    private readonly pass: string,
    private readonly buscar: Buscar = fetch,
  ) {}

  get quebrada(): boolean {
    return this.falhasSeguidas >= 3;
  }

  /** 5 telas seguidas que abrem mas não têm o formulário: a franquia mudou a página, e o parser precisa de ajuste. */
  get layoutMudou(): boolean {
    return this.telasInesperadas >= 5;
  }

  private guardar(res: Response): void {
    for (const linha of res.headers.getSetCookie?.() ?? []) {
      const par = linha.split(';')[0];
      const nome = par.split('=')[0];
      if (nome) this.cookies.set(nome, par);
    }
  }

  private async pedir(caminho: string, corpo?: Record<string, string>, seguir = true): Promise<{ status: number; html: string }> {
    const res = await this.buscar(BASE + caminho, {
      method: corpo ? 'POST' : 'GET',
      headers: {
        'User-Agent': UA,
        'Accept-Language': 'pt-BR,pt;q=0.9',
        Cookie: [...this.cookies.values()].join('; '),
        ...(corpo ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
      },
      body: corpo ? new URLSearchParams(corpo).toString() : undefined,
      redirect: seguir ? 'follow' : 'manual',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    this.guardar(res);
    return { status: res.status, html: await res.text() };
  }

  /** Entra e deixa a unidade `idCompany` ativa. true = a agenda abriu logada. */
  async entrar(idCompany: number): Promise<boolean> {
    await this.pedir('/login', { email: this.user, password: this.pass }, false);
    await this.pedir('/dashboard/alterar_unidade', { id_company: String(idCompany) });
    const agenda = await this.pedir('/dashboard/agenda');
    return agenda.status === 200 && agenda.html.length > 50_000 && agenda.html.includes('id_company');
  }

  /** Lê a tela de edição de um atendimento. null = não consegui (não é "vazio": vazio vem com campos null). */
  async lerAtendimento(idSchedule: number): Promise<AtendimentoTela | null> {
    if (this.quebrada || this.layoutMudou) return null;
    try {
      const { status, html } = await this.pedir(`/agendamentos/editar/${idSchedule}`);
      const a = status === 200 ? lerAtendimentoDaTela(html) : null;
      if (a) {
        this.falhasSeguidas = 0;
        this.telasInesperadas = 0;
      } else if (ehTelaDeLogin(html)) {
        this.falhasSeguidas++;
        this.telasInesperadas = 0;
      } else if (status === 200) {
        this.telasInesperadas++;
      }
      // 404, atendimento apagado, id de outra unidade: este atendimento não abre, a sessão está boa
      return a;
    } catch (err) {
      this.falhasSeguidas++;
      logger.warn({ err: String(err), idSchedule }, 'franquia-tela: falha ao ler o atendimento');
      return null;
    }
  }
}

/**
 * Abre uma sessão para a unidade. null (com aviso no log) se faltar login no ambiente, a unidade não estiver no
 * mapa, ou o login não passar — quem chama simplesmente não faz nada nessa varredura.
 */
export async function abrirSessaoTela(slug: string, env: NodeJS.ProcessEnv = process.env, buscar: Buscar = fetch): Promise<SessaoTela | null> {
  const user = env.FRANQUIA_TELA_USER;
  const pass = env.FRANQUIA_TELA_PASS;
  if (!user || !pass) {
    logger.warn({ unit: slug }, 'franquia-tela: sem FRANQUIA_TELA_USER/FRANQUIA_TELA_PASS no ambiente — nada lido');
    return null;
  }
  const idCompany = ID_COMPANY_POR_SLUG[slug];
  if (!idCompany) {
    logger.warn({ unit: slug }, 'franquia-tela: unidade sem id_company no mapa — nada lido');
    return null;
  }
  const sessao = new SessaoTela(user, pass, buscar);
  try {
    if (await sessao.entrar(idCompany)) return sessao;
  } catch (err) {
    logger.warn({ err: String(err), unit: slug }, 'franquia-tela: erro ao entrar');
    return null;
  }
  logger.warn({ unit: slug }, 'franquia-tela: login não passou (senha vencida?) — nada lido');
  return null;
}

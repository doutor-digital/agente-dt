/**
 * Ligação pelo WhatsApp — quem ORQUESTRA: o widget pede, aqui se decide (regras em `ligacao-whatsapp.ts`),
 * fala com a Meta, guarda no banco e registra no Kommo.
 *
 * Tudo que sai daqui entra por interfaces (`Repositorio`, `MetaLigacoes`, `KommoLigacoes`) para os testes
 * rodarem sem Meta, sem Kommo e sem banco. As implementações de verdade estão em
 * `ligacao-whatsapp-prisma.ts` (banco), `ligacao-whatsapp-meta.ts` (Graph API) e no controller (Kommo).
 *
 * O caminho de uma ligação:
 *   1. widget → `iniciar` (com a oferta SDP do navegador) → travas → POST /{phone}/calls na Meta
 *   2. Meta → webhook `calls` → `receberEventos`: "connect" traz a resposta SDP (o navegador busca e liga o
 *      áudio), depois RINGING / ACCEPTED / REJECTED, e no fim "terminate" com a duração
 *   3. `finalizar` (uma vez só): resultado, contador "sem atender", registro no Kommo, vigia do número
 * Se o webhook se perder, `fecharSemRetorno` (worker) encerra a ligação parada para nada ficar pendurado.
 */
import {
  PADROES,
  ajustesDaUnidade,
  chaveDoTelefone,
  decidirLigacao,
  diaNoFuso,
  erroDaMetaEmPortugues,
  estadoDoCombinado,
  permissaoAgora,
  podePedirPermissao,
  proximoContador,
  registroParaKommo,
  resultadoDaLigacao,
  taxaDeAtendimento,
  telefoneMascarado,
  telefoneParaMeta,
  textoDoAlertaDoVigia,
  textoDoCombinado,
  textoDoPedido,
  textoDoResultado,
  travaDoPaciente,
  vigiaDecide,
  type Ajustes,
  type ModoChave,
  type Origem,
  type Permissao,
  type Resultado,
} from './ligacao-whatsapp.js';
import type { EventoDeLigacao, PermissaoNaMeta } from './ligacao-whatsapp-meta.js';

// ── o que o serviço precisa do mundo ─────────────────────────────────────────────────────────────

export interface LinhaLigacao {
  id: string;
  unitId: string;
  leadId: number;
  telefone: string;
  chaveTelefone: string;
  waCallId: string | null;
  kommoUserId: number | null;
  kommoUserNome: string | null;
  origem: string;
  status: string;
  resultado: string | null;
  semCombinar: boolean;
  modo: string;
  sdpResposta: string | null;
  tocouEm: Date | null;
  atendidaEm: Date | null;
  encerradaEm: Date | null;
  duracaoSeg: number | null;
  erro: string | null;
  registradaEm: Date | null;
  kommoRegistro: string | null;
  criadaEm: Date;
  atualizadaEm: Date;
}

export interface LinhaPaciente {
  unitId: string;
  chaveTelefone: string;
  telefone: string;
  leadId: number | null;
  nome: string | null;
  permissao: string;
  permissaoAte: Date | null;
  permanente: boolean;
  respondeuEm: Date | null;
  pedidosEm: Date[];
  conferidaEm: Date | null;
  perguntouEm: Date | null;
  naoAtendidasSeguidas: number;
  ultimaNaoAtendidaEm: Date | null;
  ultimaLigacaoEm: Date | null;
  ultimoResultado: string | null;
}

export interface LinhaConfig {
  taxaMinima: number | null;
  amostraMinima: number | null;
  maxSemAtender: number | null;
  textoPermissao: string | null;
  modeloPermissao: string | null;
  filaPausadaAte: Date | null;
  filaPausadaMotivo: string | null;
}

export interface Repositorio {
  config(unitId: string): Promise<LinhaConfig | null>;
  paciente(unitId: string, chave: string): Promise<LinhaPaciente | null>;
  salvarPaciente(unitId: string, chave: string, dados: Partial<Omit<LinhaPaciente, 'unitId' | 'chaveTelefone'>> & { telefone: string }): Promise<LinhaPaciente>;
  criarLigacao(dados: Pick<LinhaLigacao, 'unitId' | 'leadId' | 'telefone' | 'chaveTelefone' | 'kommoUserId' | 'kommoUserNome' | 'origem' | 'semCombinar' | 'modo'>): Promise<LinhaLigacao>;
  ligacao(id: string): Promise<LinhaLigacao | null>;
  ligacaoPorWaId(waCallId: string): Promise<LinhaLigacao | null>;
  atualizarLigacao(id: string, dados: Partial<LinhaLigacao>): Promise<LinhaLigacao>;
  /** Marca `registradaEm` SÓ se ainda vazio. true = esta chamada ganhou o direito de finalizar (idempotência). */
  reservarFinalizacao(id: string, quando: Date): Promise<boolean>;
  /** Ligação ainda aberta para este paciente, criada desde `desde`. */
  aberta(unitId: string, chave: string, desde: Date): Promise<LinhaLigacao | null>;
  ultima(unitId: string, chave: string): Promise<LinhaLigacao | null>;
  /** Ligação que ainda espera o id da Meta, para um destes telefones (chaves), criada desde `desde`. */
  esperandoIdDaMeta(unitId: string, chaves: string[], desde: Date): Promise<LinhaLigacao | null>;
  resultadosEntre(unitId: string, de: Date, ate: Date): Promise<Array<string | null>>;
  /** Pausa a fila até `ate`. true = pausou AGORA (não estava pausada) — só aí sai o alerta. */
  pausarFila(unitId: string, ate: Date, motivo: string, agora: Date): Promise<boolean>;
  comPermissao(unitId: string): Promise<LinhaPaciente[]>;
  abertasParadas(antesDe: Date): Promise<LinhaLigacao[]>;
}

export interface ResultadoMeta<T = undefined> {
  ok: boolean;
  dado?: T;
  codigo?: number | null;
  mensagem?: string | null;
}

export interface MetaLigacoes {
  iniciar(para: string, sdp: string, opaco: string): Promise<ResultadoMeta<{ callId: string }>>;
  encerrar(callId: string): Promise<ResultadoMeta>;
  permissao(para: string): Promise<ResultadoMeta<PermissaoNaMeta>>;
  pedirPermissao(para: string, texto: string): Promise<ResultadoMeta>;
  pedirPermissaoPorModelo(para: string, modelo: string): Promise<ResultadoMeta>;
}

export interface ContatoDoLead {
  contatoId: number | null;
  telefone: string | null;
  nome: string | null;
}

export interface KommoLigacoes {
  contatoDoLead(leadId: number): Promise<ContatoDoLead>;
  /** epoch s da última mensagem do paciente desde `desdeEpoch`, ou null. */
  ultimaMensagemDesde(contatoId: number, desdeEpoch: number): Promise<number | null>;
  registrarChamada(corpo: Record<string, unknown>): Promise<{ ids: number[]; erros: unknown[] }>;
  nota(leadId: number, texto: string): Promise<void>;
  tarefa(leadId: number, texto: string, responsavel: number | null): Promise<void>;
}

export interface Contexto {
  unit: { id: string; slug: string; nome: string; tz: string };
  modo: ModoChave;
  /** A unidade tem o número oficial (phone_number_id + token)? Sem isto `meta` é null. */
  meta: MetaLigacoes | null;
  kommo: KommoLigacoes;
  repo: Repositorio;
  /** Chaves (8 dígitos) dos números que ligam em "só no papel". */
  numerosDeTeste: string[];
  /** Gravação ligada nesta unidade (só informativo no widget; ver o PR). */
  gravar: boolean;
  agora: () => Date;
  log: (nivel: 'info' | 'warn', dados: Record<string, unknown>, msg: string) => void;
}

const MIN = 60_000;

// ── painel do cartão ─────────────────────────────────────────────────────────────────────────────

export interface Painel {
  modo: ModoChave;
  unidade: string;
  gravar: boolean;
  credencial: boolean;
  paciente: { nome: string | null; telefone: string; numeroDeTeste: boolean } | null;
  permissao: {
    estado: Permissao;
    ate: string | null;
    permanente: boolean;
    pedidosNaSemana: number;
    podePedir: boolean;
    motivoNaoPode: string | null;
    liberaEm: string | null;
    conferidaNaMeta: boolean;
  };
  combinado: { estado: string; perguntouEm: string | null; respondeuEm: string | null; texto: string };
  trava: { travado: boolean; firme: boolean; seguidas: number; limite: number; rotulo: string; explicacao: string };
  ultima: { em: string; resultado: string | null; duracaoSeg: number | null; por: string | null } | null;
  aberta: { id: string; status: string } | null;
  fila: { pausada: boolean; ate: string | null; motivo: string | null };
  hoje: { total: number; atendidas: number; taxa: number | null; taxaMinima: number };
  /** O que acontece se clicar Ligar agora (sem confirmar nada). */
  decisao: { ok: boolean; codigo: string | null; motivo: string | null; precisaConfirmar: boolean };
}

async function ajustes(ctx: Contexto): Promise<{ aj: Ajustes; cfg: LinhaConfig | null }> {
  const cfg = await ctx.repo.config(ctx.unit.id);
  return { aj: ajustesDaUnidade(cfg), cfg };
}

function filaPausada(cfg: LinhaConfig | null, agora: Date): boolean {
  return !!cfg?.filaPausadaAte && cfg.filaPausadaAte.getTime() > agora.getTime();
}

const iso = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null);

/**
 * Confere a permissão na Meta (fonte da verdade) e espelha no banco. No máximo 1 vez por minuto por paciente:
 * o widget recarrega o painel a cada poucos segundos e a Meta não precisa ver isso.
 */
async function conferirPermissao(ctx: Contexto, p: LinhaPaciente, forcar = false): Promise<{ p: LinhaPaciente; metaDeixa: boolean | null; metaPodePedir: boolean | null; conferida: boolean }> {
  const agora = ctx.agora();
  if (!ctx.meta || ctx.modo === 'desligado') return { p, metaDeixa: null, metaPodePedir: null, conferida: false };
  if (!forcar && p.conferidaEm && agora.getTime() - p.conferidaEm.getTime() < MIN) return { p, metaDeixa: null, metaPodePedir: null, conferida: true };
  const r = await ctx.meta.permissao(p.telefone).catch(() => ({ ok: false }) as ResultadoMeta<PermissaoNaMeta>);
  if (!r.ok || !r.dado) return { p, metaDeixa: null, metaPodePedir: null, conferida: false };
  const m = r.dado;
  const dados: Partial<LinhaPaciente> & { telefone: string } = { telefone: p.telefone, conferidaEm: agora };
  if (m.estado === 'aceita') {
    dados.permissao = 'aceita';
    dados.permissaoAte = m.ate;
    dados.permanente = m.permanente;
    if (p.permissao !== 'aceita') {
      dados.respondeuEm = p.respondeuEm ?? agora;
      dados.naoAtendidasSeguidas = 0; // permissão nova: o WhatsApp recomeçou a conta dele, a nossa também
    }
  } else if (p.permissao === 'aceita') {
    dados.permissao = 'caiu'; // a nossa dizia aceita e a Meta diz que não: venceu ou o paciente retirou
  }
  const atual = await ctx.repo.salvarPaciente(ctx.unit.id, p.chaveTelefone, dados);
  return { p: atual, metaDeixa: m.podeLigar, metaPodePedir: m.podePedir, conferida: true };
}

async function pacienteDoLead(ctx: Contexto, leadId: number): Promise<{ contato: ContatoDoLead; telefone: string | null; chave: string; p: LinhaPaciente | null }> {
  const contato = await ctx.kommo.contatoDoLead(leadId);
  const telefone = telefoneParaMeta(contato.telefone);
  const chave = telefone ? chaveDoTelefone(telefone) : '';
  const p = chave ? await ctx.repo.paciente(ctx.unit.id, chave) : null;
  return { contato, telefone, chave, p };
}

async function garantirPaciente(ctx: Contexto, leadId: number, telefone: string, chave: string, nome: string | null, p: LinhaPaciente | null): Promise<LinhaPaciente> {
  if (p && p.leadId === leadId && p.telefone === telefone) return p;
  return ctx.repo.salvarPaciente(ctx.unit.id, chave, { telefone, leadId, nome: nome ?? p?.nome ?? null });
}

async function respondeuDepois(ctx: Contexto, contatoId: number | null, desde: Date | null): Promise<Date | null> {
  // Cada pergunta é uma ida ao Kommo, que tem um portão de velocidade dividido com a Sofia: só pergunta o que
  // ainda pode mudar a decisão (pergunta/ligação das últimas 24 h).
  if (!contatoId || !desde || ctx.agora().getTime() - desde.getTime() > 24 * 60 * MIN) return null;
  const t = await ctx.kommo.ultimaMensagemDesde(contatoId, Math.floor(desde.getTime() / 1000)).catch(() => null);
  return t ? new Date(t * 1000) : null;
}

/** Só no limite de "sem atender" importa saber se ele escreveu depois (é o que libera uma tentativa). */
function precisaSaberSeEscreveu(p: LinhaPaciente | null, aj: Ajustes): boolean {
  const n = p?.naoAtendidasSeguidas ?? 0;
  return n >= aj.maxSemAtender && n < aj.tetoSemAtender;
}

export async function montarPainel(ctx: Contexto, leadId: number): Promise<Painel> {
  const agora = ctx.agora();
  const { aj, cfg } = await ajustes(ctx);
  const { contato, telefone, chave, p: p0 } = await pacienteDoLead(ctx, leadId);
  const numeroDeTeste = !!chave && ctx.numerosDeTeste.includes(chave);
  let p = p0;
  let metaDeixa: boolean | null = null;
  let metaPodePedir: boolean | null = null;
  let conferida = false;
  if (telefone && chave) {
    p = await garantirPaciente(ctx, leadId, telefone, chave, contato.nome, p0);
    const c = await conferirPermissao(ctx, p);
    p = c.p;
    metaDeixa = c.metaDeixa;
    metaPodePedir = c.metaPodePedir;
    conferida = c.conferida;
  }
  const perm = permissaoAgora(p, agora);
  const pode = podePedirPermissao(p?.pedidosEm ?? [], agora, perm.estado, metaPodePedir);
  const respondeuEm = await respondeuDepois(ctx, contato.contatoId, p?.perguntouEm ?? null);
  const combinado = estadoDoCombinado(p?.perguntouEm ?? null, respondeuEm, agora);
  const escreveuDepois = precisaSaberSeEscreveu(p, aj) && !!(await respondeuDepois(ctx, contato.contatoId, p?.ultimaNaoAtendidaEm ?? null));
  const trava = travaDoPaciente({ naoAtendidasSeguidas: p?.naoAtendidasSeguidas ?? 0, ultimaNaoAtendidaEm: p?.ultimaNaoAtendidaEm ?? null, escreveuDepois }, aj);
  const ultima = chave ? await ctx.repo.ultima(ctx.unit.id, chave) : null;
  const aberta = chave ? await ctx.repo.aberta(ctx.unit.id, chave, new Date(agora.getTime() - PADROES.semRetornoEmLigacaoMin * MIN)) : null;
  const dia = diaNoFuso(agora, ctx.unit.tz);
  const hoje = taxaDeAtendimento(await ctx.repo.resultadosEntre(ctx.unit.id, dia.inicio, dia.fim));
  const pausada = filaPausada(cfg, agora);
  const d = decidirLigacao({
    modo: ctx.modo,
    numeroDeTeste,
    temCredencial: !!ctx.meta,
    telefoneValido: !!telefone,
    permissao: perm.estado,
    metaDeixa,
    trava,
    combinado,
    confirmouSemCombinar: false,
    origem: 'cartao',
    filaPausada: pausada,
    emAndamento: !!aberta,
  });
  return {
    modo: ctx.modo,
    unidade: ctx.unit.nome,
    gravar: ctx.gravar,
    credencial: !!ctx.meta,
    paciente: telefone ? { nome: contato.nome, telefone: telefoneMascarado(telefone), numeroDeTeste } : null,
    permissao: {
      estado: perm.estado,
      ate: iso(perm.ate),
      permanente: perm.permanente,
      pedidosNaSemana: pode.usados7d,
      podePedir: pode.ok,
      motivoNaoPode: pode.ok ? null : pode.motivo,
      liberaEm: pode.ok ? null : iso(pode.liberaEm),
      conferidaNaMeta: conferida,
    },
    combinado: { estado: combinado, perguntouEm: iso(p?.perguntouEm), respondeuEm: iso(respondeuEm), texto: textoDoCombinado(contato.nome) },
    trava: { travado: trava.travado, firme: trava.firme, seguidas: trava.seguidas, limite: trava.limite, rotulo: trava.rotulo, explicacao: trava.explicacao },
    ultima: ultima ? { em: ultima.criadaEm.toISOString(), resultado: ultima.resultado, duracaoSeg: ultima.duracaoSeg, por: ultima.kommoUserNome } : null,
    aberta: aberta ? { id: aberta.id, status: aberta.status } : null,
    fila: { pausada, ate: pausada ? iso(cfg?.filaPausadaAte) : null, motivo: pausada ? cfg?.filaPausadaMotivo ?? null : null },
    hoje: { ...hoje, taxaMinima: aj.taxaMinima },
    decisao: d.ok ? { ok: true, codigo: null, motivo: null, precisaConfirmar: false } : { ok: false, codigo: d.codigo, motivo: d.motivo, precisaConfirmar: !!d.precisaConfirmar },
  };
}

// ── pedir permissão ──────────────────────────────────────────────────────────────────────────────

export interface QuemPede {
  leadId: number;
  kommoUserId: number | null;
  nomeSdr: string | null;
}

export async function pedirPermissao(ctx: Contexto, q: QuemPede): Promise<{ ok: boolean; motivo: string; via?: 'mensagem' | 'modelo' }> {
  const agora = ctx.agora();
  if (ctx.modo === 'desligado') return { ok: false, motivo: 'A ligação pelo WhatsApp está desligada nesta unidade.' };
  if (!ctx.meta) return { ok: false, motivo: 'A unidade ainda não tem o número oficial do WhatsApp configurado.' };
  const { contato, telefone, chave, p: p0 } = await pacienteDoLead(ctx, q.leadId);
  if (!telefone) return { ok: false, motivo: 'O contato do cartão não tem um celular válido.' };
  if (ctx.modo === 'seco' && !ctx.numerosDeTeste.includes(chave)) {
    return { ok: false, motivo: 'Modo teste: o pedido de permissão só sai para o número de teste. Nada foi enviado.' };
  }
  const c = await conferirPermissao(ctx, await garantirPaciente(ctx, q.leadId, telefone, chave, contato.nome, p0), true);
  const p = c.p;
  const perm = permissaoAgora(p, agora);
  const pode = podePedirPermissao(p.pedidosEm, agora, perm.estado, c.metaPodePedir);
  if (!pode.ok) return { ok: false, motivo: pode.motivo };

  const { cfg } = await ajustes(ctx);
  const texto = textoDoPedido(ctx.unit.nome, cfg?.textoPermissao);
  let via: 'mensagem' | 'modelo' = 'mensagem';
  let r = await ctx.meta.pedirPermissao(telefone, texto);
  // Fora da janela de 24 h a Meta só aceita modelo aprovado. Sem modelo cadastrado, a SDR pede pelo chat depois.
  if (!r.ok && r.codigo === 131047 && cfg?.modeloPermissao) {
    via = 'modelo';
    r = await ctx.meta.pedirPermissaoPorModelo(telefone, cfg.modeloPermissao);
  }
  if (!r.ok) {
    ctx.log('warn', { unit: ctx.unit.slug, leadId: q.leadId, codigo: r.codigo }, 'ligacao-whatsapp: pedido de permissão recusado pela Meta');
    return { ok: false, motivo: erroDaMetaEmPortugues(r.codigo, r.mensagem) };
  }
  await ctx.repo.salvarPaciente(ctx.unit.id, chave, {
    telefone,
    permissao: perm.estado === 'aceita' ? 'aceita' : 'pedida',
    pedidosEm: [...p.pedidosEm.filter((d) => agora.getTime() - d.getTime() < 7 * 24 * 60 * MIN), agora],
  });
  // Mensagem enviada pela Meta NÃO aparece no chat do Kommo: sem esta nota, o "permitir" do paciente chega
  // no cartão respondendo a uma pergunta que ninguém vê.
  await ctx.kommo
    .nota(q.leadId, `☎ Pedido de permissão para ligar pelo WhatsApp enviado${q.nomeSdr ? ` por ${q.nomeSdr}` : ''}${via === 'modelo' ? ' (modelo aprovado)' : ''}. Texto: "${texto}". Esta mensagem não aparece no chat do Kommo.`)
    .catch(() => undefined);
  ctx.log('info', { unit: ctx.unit.slug, leadId: q.leadId, via }, 'ligacao-whatsapp: permissão pedida');
  return { ok: true, motivo: 'Pedido enviado. Quando o paciente tocar em "Permitir", o botão Ligar libera.', via };
}

/** A SDR copiou o "Posso te ligar agora?" para o chat. */
export async function marcarPergunta(ctx: Contexto, leadId: number): Promise<{ ok: boolean; texto: string; motivo?: string }> {
  const { contato, telefone, chave, p } = await pacienteDoLead(ctx, leadId);
  const texto = textoDoCombinado(contato.nome);
  if (!telefone) return { ok: false, texto, motivo: 'O contato do cartão não tem um celular válido.' };
  const atual = await garantirPaciente(ctx, leadId, telefone, chave, contato.nome, p);
  await ctx.repo.salvarPaciente(ctx.unit.id, chave, { telefone: atual.telefone, perguntouEm: ctx.agora() });
  return { ok: true, texto };
}

// ── ligar ────────────────────────────────────────────────────────────────────────────────────────

export interface PedidoDeLigar extends QuemPede {
  sdp: string;
  origem: Origem;
  confirmouSemCombinar: boolean;
}

export type RespostaLigar =
  | { ok: true; ligacaoId: string; semCombinar: boolean }
  | { ok: false; codigo: string; motivo: string; precisaConfirmar?: boolean; ligacaoId?: string };

export async function iniciarLigacao(ctx: Contexto, l: PedidoDeLigar): Promise<RespostaLigar> {
  const agora = ctx.agora();
  if (!l.sdp || !/^v=0/m.test(l.sdp) || l.sdp.length > 20_000) return { ok: false, codigo: 'sdp', motivo: 'O navegador não conseguiu preparar o áudio. Recarregue a página e tente de novo.' };
  const { aj, cfg } = await ajustes(ctx);
  const { contato, telefone, chave, p: p0 } = await pacienteDoLead(ctx, l.leadId);
  const numeroDeTeste = !!chave && ctx.numerosDeTeste.includes(chave);
  let p = telefone ? await garantirPaciente(ctx, l.leadId, telefone, chave, contato.nome, p0) : null;
  let metaDeixa: boolean | null = null;
  if (p) {
    const c = await conferirPermissao(ctx, p, true);
    p = c.p;
    metaDeixa = c.metaDeixa;
  }
  const perm = permissaoAgora(p, agora);
  const respondeuEm = await respondeuDepois(ctx, contato.contatoId, p?.perguntouEm ?? null);
  const escreveuDepois = precisaSaberSeEscreveu(p, aj) && !!(await respondeuDepois(ctx, contato.contatoId, p?.ultimaNaoAtendidaEm ?? null));
  const trava = travaDoPaciente({ naoAtendidasSeguidas: p?.naoAtendidasSeguidas ?? 0, ultimaNaoAtendidaEm: p?.ultimaNaoAtendidaEm ?? null, escreveuDepois }, aj);
  const aberta = chave ? await ctx.repo.aberta(ctx.unit.id, chave, new Date(agora.getTime() - PADROES.semRetornoEmLigacaoMin * MIN)) : null;
  const d = decidirLigacao({
    modo: ctx.modo,
    numeroDeTeste,
    temCredencial: !!ctx.meta,
    telefoneValido: !!telefone,
    permissao: perm.estado,
    metaDeixa,
    trava,
    combinado: estadoDoCombinado(p?.perguntouEm ?? null, respondeuEm, agora),
    confirmouSemCombinar: l.confirmouSemCombinar,
    origem: l.origem,
    filaPausada: filaPausada(cfg, agora),
    emAndamento: !!aberta,
  });
  if (!d.ok) {
    ctx.log('info', { unit: ctx.unit.slug, leadId: l.leadId, codigo: d.codigo }, 'ligacao-whatsapp: ligação barrada pela trava');
    return { ok: false, codigo: d.codigo, motivo: d.motivo, precisaConfirmar: d.precisaConfirmar };
  }
  // daqui pra baixo `telefone`, `p` e `ctx.meta` existem (decidirLigacao barrou o contrário)
  const lig = await ctx.repo.criarLigacao({
    unitId: ctx.unit.id,
    leadId: l.leadId,
    telefone: telefone!,
    chaveTelefone: chave,
    kommoUserId: l.kommoUserId,
    kommoUserNome: l.nomeSdr,
    origem: l.origem,
    semCombinar: d.semCombinar,
    modo: ctx.modo,
  });
  const r = await ctx.meta!.iniciar(telefone!, l.sdp, lig.id).catch((err) => ({ ok: false, codigo: null, mensagem: String(err) }) as ResultadoMeta<{ callId: string }>);
  if (!r.ok || !r.dado?.callId) {
    const motivo = erroDaMetaEmPortugues(r.codigo, r.mensagem);
    await ctx.repo.atualizarLigacao(lig.id, { erro: `${r.codigo ?? ''} ${r.mensagem ?? ''}`.trim().slice(0, 300) });
    await finalizar(ctx, lig.id, { falhaTecnica: true });
    ctx.log('warn', { unit: ctx.unit.slug, leadId: l.leadId, codigo: r.codigo }, 'ligacao-whatsapp: a Meta recusou a ligação');
    return { ok: false, codigo: 'meta', motivo, ligacaoId: lig.id };
  }
  // O webhook "connect" pode ter chegado ANTES desta linha (ele não traz o nosso id de volta) e já ter avançado o
  // status — então só passa de "iniciando" para "chamando", nunca volta atrás.
  const atual = await ctx.repo.ligacao(lig.id);
  await ctx.repo.atualizarLigacao(lig.id, { waCallId: r.dado.callId, ...(atual?.status === 'iniciando' ? { status: 'chamando' } : {}) });
  await ctx.repo.salvarPaciente(ctx.unit.id, chave, { telefone: telefone!, ultimaLigacaoEm: agora });
  ctx.log('info', { unit: ctx.unit.slug, leadId: l.leadId, ligacao: lig.id, semCombinar: d.semCombinar, origem: l.origem }, 'ligacao-whatsapp: ligação saiu');
  return { ok: true, ligacaoId: lig.id, semCombinar: d.semCombinar };
}

// ── o que o navegador acompanha durante a ligação ────────────────────────────────────────────────

export interface EstadoDaLigacao {
  id: string;
  status: string;
  sdpResposta: string | null;
  tocouEm: string | null;
  atendidaEm: string | null;
  encerradaEm: string | null;
  resultado: string | null;
  duracaoSeg: number | null;
  texto: string | null;
  registrada: boolean;
}

export async function estadoDaLigacao(ctx: Contexto, id: string): Promise<EstadoDaLigacao | null> {
  const l = await ctx.repo.ligacao(id);
  if (!l || l.unitId !== ctx.unit.id) return null;
  const encerrada = l.status === 'encerrada';
  return {
    id: l.id,
    status: l.status,
    sdpResposta: encerrada ? null : l.sdpResposta,
    tocouEm: iso(l.tocouEm),
    atendidaEm: iso(l.atendidaEm),
    encerradaEm: iso(l.encerradaEm),
    resultado: l.resultado,
    duracaoSeg: l.duracaoSeg,
    texto: encerrada && l.resultado ? textoDoResultado(l.resultado as Resultado, { duracaoSeg: l.duracaoSeg, semCombinar: l.semCombinar, erro: l.erro }) : null,
    registrada: !!l.kommoRegistro,
  };
}

/** A SDR desligou. Pede à Meta para encerrar; quem fecha a conta é o webhook "terminate" (ou o vigia). */
export async function encerrarLigacao(ctx: Contexto, id: string): Promise<{ ok: boolean; motivo?: string }> {
  const l = await ctx.repo.ligacao(id);
  if (!l || l.unitId !== ctx.unit.id) return { ok: false, motivo: 'ligação não encontrada' };
  if (l.status === 'encerrada') return { ok: true };
  if (!l.waCallId || !ctx.meta) {
    await finalizar(ctx, l.id, { falhaTecnica: !l.waCallId });
    return { ok: true };
  }
  const r = await ctx.meta.encerrar(l.waCallId).catch(() => ({ ok: false }) as ResultadoMeta);
  if (!r.ok) {
    // A Meta pode já ter encerrado do lado dela (o paciente desligou junto). O vigia fecha se o webhook não vier.
    ctx.log('warn', { unit: ctx.unit.slug, ligacao: id, codigo: r.codigo }, 'ligacao-whatsapp: encerrar na Meta falhou');
  }
  return { ok: true };
}

// ── webhook `calls` ──────────────────────────────────────────────────────────────────────────────

export async function receberEventos(ctx: Contexto, eventos: EventoDeLigacao[]): Promise<{ tratados: number; ignorados: number }> {
  let tratados = 0;
  let ignorados = 0;
  for (const e of eventos) {
    if (e.tipo === 'permissao') {
      const chave = chaveDoTelefone(e.telefone);
      const p = await ctx.repo.paciente(ctx.unit.id, chave);
      if (!p && e.resposta !== 'aceita') { ignorados++; continue; }
      await ctx.repo.salvarPaciente(ctx.unit.id, chave, {
        telefone: p?.telefone ?? (telefoneParaMeta(e.telefone) || e.telefone),
        permissao: e.resposta === 'aceita' ? 'aceita' : 'recusada',
        permissaoAte: e.ate,
        permanente: e.permanente,
        respondeuEm: e.quando,
        conferidaEm: null, // força conferir de novo na Meta no próximo painel
        ...(e.resposta === 'aceita' ? { naoAtendidasSeguidas: 0 } : {}),
      });
      ctx.log('info', { unit: ctx.unit.slug, resposta: e.resposta, permanente: e.permanente }, 'ligacao-whatsapp: paciente respondeu ao pedido de permissão');
      tratados++;
      continue;
    }
    let l = (e.callId ? await ctx.repo.ligacaoPorWaId(e.callId) : null) ?? (e.opaco ? await ctx.repo.ligacao(e.opaco) : null);
    if (!l && e.tipo === 'connect') {
      // Corrida: a Meta mandou o "connect" (com a resposta SDP) antes de gravarmos o id que ela devolveu no POST, e
      // esse evento não traz o nosso id de volta. Casa pelo telefone com a ligação que acabou de sair.
      const chaves = e.numeros.map((n) => chaveDoTelefone(n)).filter((c) => c.length === 8);
      l = chaves.length ? await ctx.repo.esperandoIdDaMeta(ctx.unit.id, chaves, new Date(ctx.agora().getTime() - 2 * MIN)) : null;
    }
    if (!l || l.unitId !== ctx.unit.id) { ignorados++; continue; }
    if (l.status === 'encerrada') { ignorados++; continue; }
    if (e.tipo === 'connect') {
      if (e.sdp && (e.sdpTipo ?? 'answer') === 'answer') {
        await ctx.repo.atualizarLigacao(l.id, { sdpResposta: e.sdp, waCallId: l.waCallId ?? e.callId, status: l.status === 'iniciando' ? 'chamando' : l.status });
      }
    } else if (e.tipo === 'status') {
      const s = e.status.toUpperCase();
      if (s === 'RINGING') await ctx.repo.atualizarLigacao(l.id, { tocouEm: l.tocouEm ?? e.quando, status: l.atendidaEm ? l.status : 'tocando' });
      else if (s === 'ACCEPTED') await ctx.repo.atualizarLigacao(l.id, { atendidaEm: l.atendidaEm ?? e.quando, status: 'em_ligacao' });
      else if (s === 'REJECTED') await ctx.repo.atualizarLigacao(l.id, { resultado: 'recusada' });
    } else if (e.tipo === 'terminate') {
      await finalizar(ctx, l.id, { duracaoSeg: e.duracaoSeg, falhaTecnica: e.status.toUpperCase() === 'FAILED' && !l.tocouEm && !l.atendidaEm, inicio: e.inicio });
    }
    tratados++;
  }
  return { tratados, ignorados };
}

// ── fechar a conta de uma ligação (uma vez só) ───────────────────────────────────────────────────

export async function finalizar(
  ctx: Contexto,
  id: string,
  info: { duracaoSeg?: number | null; falhaTecnica?: boolean; inicio?: Date | null; semRetorno?: boolean },
): Promise<void> {
  const agora = ctx.agora();
  // Webhook repetido, vigia e SDR podem chegar juntos: só quem ganha a reserva fecha a conta.
  if (!(await ctx.repo.reservarFinalizacao(id, agora))) return;
  const l = await ctx.repo.ligacao(id);
  if (!l) return;
  const atendidaEm = l.atendidaEm ?? (info.duracaoSeg && info.duracaoSeg > 0 ? info.inicio ?? agora : null);
  let duracaoSeg = info.duracaoSeg ?? null;
  if (duracaoSeg === null && l.atendidaEm) duracaoSeg = Math.max(0, Math.round((agora.getTime() - l.atendidaEm.getTime()) / 1000));
  const resultado = resultadoDaLigacao({ atendidaEm, duracaoSeg, recusada: l.resultado === 'recusada', falhaTecnica: !!info.falhaTecnica });
  const { aj, cfg } = await ajustes(ctx);

  const p = await ctx.repo.paciente(ctx.unit.id, l.chaveTelefone);
  const seguidas = proximoContador(p?.naoAtendidasSeguidas ?? 0, resultado);
  if (p) {
    await ctx.repo.salvarPaciente(ctx.unit.id, l.chaveTelefone, {
      telefone: p.telefone,
      naoAtendidasSeguidas: seguidas,
      ultimaLigacaoEm: l.criadaEm,
      ultimoResultado: resultado,
      ...(resultado === 'nao_atendida' || resultado === 'recusada' ? { ultimaNaoAtendidaEm: agora } : {}),
    });
  }
  const texto = textoDoResultado(resultado, {
    duracaoSeg,
    seguidas: resultado === 'nao_atendida' || resultado === 'recusada' ? seguidas : undefined,
    limite: aj.maxSemAtender,
    semCombinar: l.semCombinar,
    erro: l.erro,
  });
  await ctx.repo.atualizarLigacao(l.id, {
    status: 'encerrada',
    resultado,
    duracaoSeg,
    atendidaEm,
    encerradaEm: agora,
    sdpResposta: null,
    ...(info.semRetorno ? { erro: (l.erro ? `${l.erro} · ` : '') + 'encerrada pelo vigia: a Meta não avisou o fim' } : {}),
  });

  // Registro no cartão — falha técnica (nem saiu) não vira ligação no histórico.
  if (resultado !== 'falhou') {
    let registro = 'falhou';
    try {
      const corpo = registroParaKommo({ id: l.id, waCallId: l.waCallId, telefone: l.telefone, duracaoSeg, criadaEm: l.criadaEm, kommoUserId: l.kommoUserId, resultado, texto });
      const r = await ctx.kommo.registrarChamada(corpo as unknown as Record<string, unknown>);
      if (r.ids.length) registro = String(r.ids[0]);
      else {
        // O Kommo não achou o contato pelo telefone: a ligação vira nota no cartão para não sumir.
        await ctx.kommo.nota(l.leadId, `☎ ${texto}${l.kommoUserNome ? ` — ${l.kommoUserNome}` : ''}.`);
        registro = 'nota';
      }
    } catch (err) {
      ctx.log('warn', { unit: ctx.unit.slug, ligacao: l.id, err: String(err) }, 'ligacao-whatsapp: não registrei a ligação no Kommo');
      await ctx.kommo.nota(l.leadId, `☎ ${texto}${l.kommoUserNome ? ` — ${l.kommoUserNome}` : ''}.`).then(() => { registro = 'nota'; }, () => undefined);
    }
    await ctx.repo.atualizarLigacao(l.id, { kommoRegistro: registro });
  }
  ctx.log('info', { unit: ctx.unit.slug, ligacao: l.id, leadId: l.leadId, resultado, duracaoSeg, seguidas }, 'ligacao-whatsapp: ligação encerrada');

  // Trava 3: o vigia do número.
  if (resultado === 'nao_atendida' || resultado === 'recusada') {
    const dia = diaNoFuso(agora, ctx.unit.tz);
    const taxa = taxaDeAtendimento(await ctx.repo.resultadosEntre(ctx.unit.id, dia.inicio, dia.fim));
    const v = vigiaDecide(taxa, aj);
    if (v.pausar && !filaPausada(cfg, agora)) {
      const pausouAgora = await ctx.repo.pausarFila(ctx.unit.id, dia.fim, v.motivo, agora);
      if (pausouAgora) {
        ctx.log('warn', { unit: ctx.unit.slug, ...taxa }, 'ligacao-whatsapp: vigia pausou a fila');
        await ctx.kommo.tarefa(l.leadId, textoDoAlertaDoVigia(ctx.unit.slug, v.motivo), l.kommoUserId).catch((err) => {
          ctx.log('warn', { unit: ctx.unit.slug, err: String(err) }, 'ligacao-whatsapp: não consegui abrir a tarefa do vigia');
        });
      }
    }
  }
}

// ── fila "Ligar próximo" ─────────────────────────────────────────────────────────────────────────

export interface ItemDaFila {
  leadId: number;
  nome: string | null;
  telefone: string;
  permissaoAte: string | null;
  permanente: boolean;
  ultimaLigacaoEm: string | null;
  ultimoResultado: string | null;
  seguidas: number;
}

/**
 * Só quem deu permissão (válida), não está travado e não recebeu ligação nas últimas 2 h. Quem vence antes
 * vem primeiro. A SDR abre o cartão e liga ela mesma — a fila não disca sozinha.
 */
export async function montarFila(ctx: Contexto): Promise<{ pausada: boolean; ate: string | null; motivo: string | null; itens: ItemDaFila[] }> {
  const agora = ctx.agora();
  const { aj, cfg } = await ajustes(ctx);
  const pausada = filaPausada(cfg, agora);
  const lista = await ctx.repo.comPermissao(ctx.unit.id);
  const itens = lista
    .filter((p) => p.leadId && permissaoAgora(p, agora).estado === 'aceita')
    .filter((p) => p.naoAtendidasSeguidas < aj.maxSemAtender)
    .filter((p) => !p.ultimaLigacaoEm || agora.getTime() - p.ultimaLigacaoEm.getTime() > 2 * 60 * MIN)
    .sort((a, b) => (a.permanente ? Infinity : a.permissaoAte?.getTime() ?? Infinity) - (b.permanente ? Infinity : b.permissaoAte?.getTime() ?? Infinity))
    .slice(0, 50)
    .map((p) => ({
      leadId: p.leadId!,
      nome: p.nome,
      telefone: telefoneMascarado(p.telefone),
      permissaoAte: iso(p.permissaoAte),
      permanente: p.permanente,
      ultimaLigacaoEm: iso(p.ultimaLigacaoEm),
      ultimoResultado: p.ultimoResultado,
      seguidas: p.naoAtendidasSeguidas,
    }));
  return { pausada, ate: pausada ? iso(cfg?.filaPausadaAte) : null, motivo: pausada ? cfg?.filaPausadaMotivo ?? null : null, itens };
}

// ── vigia de ligações penduradas (webhook perdido) ───────────────────────────────────────────────

/** Ligação que ficou "chamando" sem notícia da Meta por minutos, ou "em ligação" por horas: fecha a conta. */
export function ligacaoParada(l: Pick<LinhaLigacao, 'status' | 'atualizadaEm'>, agora: Date): boolean {
  const idadeMin = (agora.getTime() - l.atualizadaEm.getTime()) / MIN;
  if (l.status === 'encerrada') return false;
  if (l.status === 'em_ligacao') return idadeMin > PADROES.semRetornoEmLigacaoMin;
  return idadeMin > PADROES.semRetornoChamandoMin;
}

export async function fecharSemRetorno(ctx: Contexto, l: LinhaLigacao): Promise<boolean> {
  if (!ligacaoParada(l, ctx.agora())) return false;
  await finalizar(ctx, l.id, { falhaTecnica: !l.waCallId, semRetorno: true });
  return true;
}

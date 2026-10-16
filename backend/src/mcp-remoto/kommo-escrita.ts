/**
 * Alterar cartões do Kommo pelo claude.ai — só para quem está em MCP_ESCRITA_EMAILS, e sempre em DOIS passos:
 * `kommo_preparar_alteracao` mostra o que vai mudar (cartão por cartão, de → para) e devolve um código;
 * `kommo_confirmar_alteracao` com esse código grava. Sem o código, nada muda: a IA não altera 80 cartões
 * por ter entendido errado. Cada cartão alterado fica no registro do conector com antes e depois.
 *
 * O que dá para alterar: etapa, responsável, campos, etiquetas, nota e tarefa. Não apaga nada e não manda
 * mensagem para o paciente.
 */
import { randomBytes } from 'node:crypto';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { CampoDoCartaoDaConta, KommoLead, KommoPipeline } from '../services/kommo.service.js';
import type { Auditar } from '../franquia-mcp/ferramentas.js';
import { ErroDeEntrada } from '../franquia-mcp/travas.js';
import { executar } from './ferramenta.js';
import { donoDoCartao, resolverUnidadesKommo, type ContextoKommo } from './kommo.js';

export const MAX_CARTOES = 50;
const VALIDADE_MS = 15 * 60_000;
const FUSO = 'America/Sao_Paulo';

type PatchLead = {
  id: number;
  status_id?: number;
  pipeline_id?: number;
  responsible_user_id?: number;
  custom_fields_values?: Array<{ field_id: number; values: Array<Record<string, unknown>> | null }>;
  tags_to_add?: Array<{ name: string }>;
  tags_to_delete?: Array<{ name: string }>;
};

/** O que a escrita precisa do Kommo da unidade. Em produção, o KommoClient; nos testes, um falso. */
export interface FonteEscrita {
  leads(ids: number[]): Promise<KommoLead[]>;
  funis(): Promise<KommoPipeline[]>;
  campos(): Promise<CampoDoCartaoDaConta[]>;
  usuarios(): Promise<Array<{ id: number; name: string; email?: string }>>;
  etiquetaExiste(nome: string): Promise<boolean>;
  atualizar(lote: PatchLead[]): Promise<number[]>;
  nota(leadId: number, texto: string): Promise<unknown>;
  tarefa(t: { leadId: number; text: string; completeAt: number; responsibleUserId?: number }): Promise<unknown>;
}

export interface Mudancas {
  etapa?: string;
  responsavel?: string;
  campos?: Record<string, string | number | boolean | null>;
  adicionarEtiquetas?: string[];
  removerEtiquetas?: string[];
  nota?: string;
  tarefa?: { texto: string; prazo: string; responsavel?: string };
}

interface Pendente {
  usuario: string;
  unidade: string;
  criadoEm: number;
  patches: PatchLead[];
  antes: Map<number, { etapa: number; responsavel: number | undefined }>;
  resumo: unknown[];
  nota?: string;
  tarefa?: { text: string; completeAt: number; responsibleUserId?: number };
}

/** Pedidos preparados à espera da confirmação. Em memória: o agente roda numa réplica só; reinício = preparar de novo. */
export class Pendentes {
  private itens = new Map<string, Pendente>();
  constructor(private agora: () => number = Date.now) {}
  guardar(p: Omit<Pendente, 'criadoEm'>): { codigo: string; expiraEm: string } {
    for (const [k, v] of this.itens) if (this.agora() - v.criadoEm > VALIDADE_MS) this.itens.delete(k);
    const codigo = randomBytes(4).toString('hex').toUpperCase();
    const criadoEm = this.agora();
    this.itens.set(codigo, { ...p, criadoEm });
    return { codigo, expiraEm: new Date(criadoEm + VALIDADE_MS).toISOString() };
  }
  tirar(codigo: string, usuario: string): Pendente {
    const p = this.itens.get(codigo.trim().toUpperCase());
    if (!p) throw new ErroDeEntrada('código de confirmação desconhecido ou já usado: prepare a alteração de novo');
    if (p.usuario !== usuario) throw new ErroDeEntrada('este código foi gerado por outro usuário');
    this.itens.delete(codigo.trim().toUpperCase());
    if (this.agora() - p.criadoEm > VALIDADE_MS) throw new ErroDeEntrada('o código venceu (15 minutos): prepare a alteração de novo');
    return p;
  }
}

const norm = (s: string) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

function acharUm<T>(itens: T[], nome: (x: T) => string, pedido: string, oQue: string): T {
  const p = norm(pedido);
  const exatos = itens.filter((x) => norm(nome(x)) === p);
  if (exatos.length === 1) return exatos[0]!;
  const parecidos = exatos.length ? exatos : itens.filter((x) => norm(nome(x)).includes(p));
  if (parecidos.length === 1) return parecidos[0]!;
  const opcoes = (parecidos.length ? parecidos : itens).slice(0, 25).map(nome).join(' | ');
  throw new ErroDeEntrada(`${oQue} "${pedido}" ${parecidos.length > 1 ? 'é ambíguo' : 'não existe'}. Opções: ${opcoes}`);
}

/** Data/hora local (AAAA-MM-DD, AAAA-MM-DD HH:MM ou DD/MM/AAAA [HH:MM]) → epoch s no fuso de São Paulo. */
export function dataLocal(v: string, horaPadrao = '12:00'): number {
  const t = v.trim();
  let m = t.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?$/);
  let ano: string, mes: string, dia: string, hh: string | undefined, mm: string | undefined;
  if (m) [, ano, mes, dia, hh, mm] = m as unknown as string[];
  else {
    m = t.match(/^(\d{2})\/(\d{2})\/(\d{4})(?:\s+(\d{2}):(\d{2}))?$/);
    if (!m) throw new ErroDeEntrada(`data "${v}": use AAAA-MM-DD ou DD/MM/AAAA, com HH:MM opcional`);
    [, dia, mes, ano, hh, mm] = m as unknown as string[];
  }
  const [h, mi] = (hh ? `${hh}:${mm}` : horaPadrao).split(':');
  const ms = Date.parse(`${ano}-${mes}-${dia}T${h}:${mi}:00-03:00`);
  if (!Number.isFinite(ms)) throw new ErroDeEntrada(`data inválida: ${v}`);
  return Math.floor(ms / 1000);
}

/** Valor pedido → formato do Kommo para o tipo do campo. `null`/"" esvazia o campo. */
export function valorDoCampo(campo: CampoDoCartaoDaConta, valor: string | number | boolean | null): Array<Record<string, unknown>> | null {
  if (valor === null || valor === '') return null;
  const s = String(valor).trim();
  switch (campo.type) {
    case 'text': case 'textarea': case 'url': case 'streetaddress':
      return [{ value: s }];
    case 'numeric': case 'monetary': {
      const n = Number(s.replace(/\./g, '').replace(',', '.'));
      if (!Number.isFinite(n)) throw new ErroDeEntrada(`campo "${campo.name}" é numérico; recebi "${s}"`);
      return [{ value: n }];
    }
    case 'checkbox': {
      const sim = /^(sim|s|true|1|marcar|marcado|x)$/i.test(s);
      const nao = /^(n[aã]o|n|false|0|desmarcar|desmarcado)$/i.test(s);
      if (!sim && !nao) throw new ErroDeEntrada(`campo "${campo.name}" é de marcar: use sim ou não`);
      return [{ value: sim }];
    }
    case 'select': case 'radiobutton': {
      const e = acharUm(campo.enums, (x) => x.value, s, `opção do campo "${campo.name}"`);
      return [{ enum_id: e.id }];
    }
    case 'multiselect':
      return s.split(/\s*[;,]\s*/).filter(Boolean).map((x) => ({ enum_id: acharUm(campo.enums, (o) => o.value, x, `opção do campo "${campo.name}"`).id }));
    case 'date': case 'date_time': case 'birthday':
      return [{ value: dataLocal(s, '00:00') }];
    default:
      throw new ErroDeEntrada(`campo "${campo.name}" é do tipo ${campo.type}, que esta ferramenta ainda não grava`);
  }
}

function valorAtual(lead: KommoLead, fieldId: number): string | null {
  const f = (lead.custom_fields_values ?? []).find((x) => x.field_id === fieldId);
  if (!f?.values?.length) return null;
  return f.values.map((v) => String((v as { value?: unknown }).value ?? '')).join(', ');
}

export async function prepararAlteracao(
  ctx: ContextoKommo,
  fonteDe: (slug: string) => FonteEscrita,
  pendentes: Pendentes,
  usuario: string,
  a: { unidade: string; cartoes: number[]; mudancas: Mudancas },
) {
  const [u] = resolverUnidadesKommo(ctx, a.unidade, 1);
  const fonte = fonteDe(u!.slug);
  const ids = [...new Set(a.cartoes)];
  if (ids.length === 0) throw new ErroDeEntrada('informe pelo menos um cartão');
  if (ids.length > MAX_CARTOES) throw new ErroDeEntrada(`no máximo ${MAX_CARTOES} cartões por alteração`);
  const m = a.mudancas ?? {};
  if (!m.etapa && !m.responsavel && !m.campos && !m.adicionarEtiquetas?.length && !m.removerEtiquetas?.length && !m.nota && !m.tarefa) {
    throw new ErroDeEntrada('nenhuma mudança pedida');
  }

  const leads = await fonte.leads(ids);
  const faltam = ids.filter((id) => !leads.some((l) => l.id === id));
  if (faltam.length) throw new ErroDeEntrada(`cartões que não existem nesta conta: ${faltam.join(', ')}`);
  // conta dividida (Petrópolis × Caxias): cartão da outra unidade nunca é alterado por esta
  const daOutra = leads.flatMap((l) => {
    const d = donoDoCartao(u!, l);
    return d.tipo === 'outra' ? [`${l.id} (${d.rotulo}: unidade="${d.slug}")`] : [];
  });
  if (daOutra.length) throw new ErroDeEntrada(`cartões de outra unidade (⌂ Unidade de atendimento), nada foi preparado: ${daOutra.join(', ')}`);
  const semDono = leads.filter((l) => donoDoCartao(u!, l).tipo === 'ninguem').map((l) => l.id);

  const funis = m.etapa ? await fonte.funis() : [];
  const nomeEtapa = (pid: number, sid: number) => {
    const f = funis.find((x) => x.id === pid);
    return `${f?.name ?? pid} / ${f?.statuses.find((s) => s.id === sid)?.name ?? sid}`;
  };
  const camposDaConta = m.campos || m.etapa ? await fonte.campos() : [];
  const usuarios = m.responsavel || m.tarefa?.responsavel ? await fonte.usuarios() : [];
  const responsavel = m.responsavel ? acharUm(usuarios, (x) => `${x.name}${x.email ? ` <${x.email}>` : ''}`, m.responsavel, 'usuário') : null;

  const campos = Object.entries(m.campos ?? {}).map(([nome, valor]) => {
    const c = acharUm(camposDaConta, (x) => x.name, nome, 'campo');
    return { campo: c, values: valorDoCampo(c, valor), pedido: valor };
  });

  const avisos: string[] = [];
  if (semDono.length) avisos.push(`cartões que não são de nenhuma unidade (⌂ Unidade de atendimento vazio ou com valor que ninguém usa): ${semDono.join(', ')}`);
  for (const nome of m.adicionarEtiquetas ?? []) {
    if (!(await fonte.etiquetaExiste(nome))) avisos.push(`a etiqueta "${nome}" ainda não existe nesta conta: será criada`);
  }

  let tarefa: Pendente['tarefa'];
  if (m.tarefa) {
    if (!m.tarefa.texto?.trim()) throw new ErroDeEntrada('tarefa sem texto');
    const quem = m.tarefa.responsavel ? acharUm(usuarios, (x) => x.name, m.tarefa.responsavel, 'usuário da tarefa') : null;
    tarefa = { text: m.tarefa.texto.trim().slice(0, 1000), completeAt: dataLocal(m.tarefa.prazo, '18:00'), ...(quem ? { responsibleUserId: quem.id } : {}) };
  }

  const patches: PatchLead[] = [];
  const resumo: unknown[] = [];
  const antes = new Map<number, { etapa: number; responsavel: number | undefined }>();
  for (const lead of leads) {
    const p: PatchLead = { id: lead.id };
    const r: Record<string, unknown> = { cartao: lead.id, nome: lead.name };
    antes.set(lead.id, { etapa: lead.status_id, responsavel: lead.responsible_user_id });
    if (m.etapa) {
      // primeiro no funil do próprio cartão; se não houver, num único outro funil (muda de funil junto)
      const doFunil = funis.find((f) => f.id === lead.pipeline_id);
      const busca = (f: KommoPipeline) => f.statuses.filter((s) => norm(s.name) === norm(m.etapa!) || String(s.id) === m.etapa!.trim());
      let alvo = doFunil ? busca(doFunil).map((s) => ({ f: doFunil, s })) : [];
      if (!alvo.length) alvo = funis.flatMap((f) => busca(f).map((s) => ({ f, s })));
      if (alvo.length !== 1) {
        const opcoes = (doFunil?.statuses ?? []).map((s) => s.name).join(' | ');
        throw new ErroDeEntrada(`etapa "${m.etapa}" ${alvo.length ? 'existe em mais de um funil' : 'não existe'} para o cartão ${lead.id}. Etapas do funil dele: ${opcoes}`);
      }
      const { f, s } = alvo[0]!;
      if (s.id !== lead.status_id || f.id !== lead.pipeline_id) {
        p.status_id = s.id;
        if (f.id !== lead.pipeline_id) p.pipeline_id = f.id;
        r.etapa = { de: nomeEtapa(lead.pipeline_id, lead.status_id), para: nomeEtapa(f.id, s.id) };
        const exigidos = camposDaConta
          .filter((c) => c.required_statuses?.some((e) => e.pipeline_id === f.id && e.status_id === s.id))
          .filter((c) => !valorAtual(lead, c.id) && !campos.some((x) => x.campo.id === c.id))
          .map((c) => c.name);
        if (exigidos.length) r.atencao = `na tela, essa etapa exige: ${exigidos.join(', ')} (pela API o Kommo grava mesmo assim)`;
      } else r.etapa = 'já está nessa etapa';
    }
    if (responsavel && responsavel.id !== lead.responsible_user_id) {
      p.responsible_user_id = responsavel.id;
      r.responsavel = { para: responsavel.name };
    }
    if (campos.length) {
      p.custom_fields_values = campos.map((x) => ({ field_id: x.campo.id, values: x.values }));
      r.campos = campos.map((x) => ({ campo: x.campo.name, de: valorAtual(lead, x.campo.id), para: x.pedido === '' ? null : x.pedido }));
    }
    const tem = new Set((lead._embedded?.tags ?? []).map((t) => norm(t.name)));
    const add = (m.adicionarEtiquetas ?? []).filter((t) => !tem.has(norm(t)));
    const del = (m.removerEtiquetas ?? []).filter((t) => tem.has(norm(t)));
    if (add.length) p.tags_to_add = add.map((name) => ({ name }));
    if (del.length) p.tags_to_delete = del.map((name) => ({ name }));
    if (add.length || del.length) r.etiquetas = { adicionar: add, remover: del };
    if (m.nota) r.nota = m.nota.slice(0, 200);
    if (tarefa) r.tarefa = { texto: tarefa.text.slice(0, 200), prazo: new Intl.DateTimeFormat('pt-BR', { timeZone: FUSO, dateStyle: 'short', timeStyle: 'short' }).format(tarefa.completeAt * 1000) };
    if (Object.keys(p).length > 1) patches.push(p);
    resumo.push(r);
  }

  const { codigo, expiraEm } = pendentes.guardar({ usuario, unidade: u!.slug, patches, antes, resumo, ...(m.nota ? { nota: m.nota.slice(0, 4000) } : {}), ...(tarefa ? { tarefa } : {}) });
  return {
    unidade: u!.slug,
    cartoes: leads.length,
    mudam: patches.length,
    resumo,
    avisos,
    confirmacao: codigo,
    expiraEm,
    instrucao: `Nada foi gravado ainda. Mostre este resumo à pessoa e, se ela aprovar, chame kommo_confirmar_alteracao com confirmacao="${codigo}" (vale 15 minutos).`,
  };
}

export async function confirmarAlteracao(
  ctx: ContextoKommo,
  fonteDe: (slug: string) => FonteEscrita,
  pendentes: Pendentes,
  usuario: string,
  a: { confirmacao: string },
  registrar: (r: { unidade: string; cartao: number; antes: unknown; depois: unknown; ok: boolean; erro?: string }) => void,
) {
  const p = pendentes.tirar(a.confirmacao, usuario);
  // a unidade de novo: se saiu do conector (ou da conta dividida) desde a prévia, nada é gravado
  const [u] = resolverUnidadesKommo(ctx, p.unidade, 1);
  const fonte = fonteDe(u!.slug);
  // Confere se ninguém mexeu na etapa/responsável desde a prévia: cartão mudado fica de fora.
  const agora = await fonte.leads(p.patches.map((x) => x.id).concat(p.nota || p.tarefa ? [...p.antes.keys()] : []).filter((v, i, arr) => arr.indexOf(v) === i));
  const mudouDesde = new Set<number>();
  const foiPraOutra = new Map<number, string>();
  for (const l of agora) {
    const a0 = p.antes.get(l.id);
    if (a0 && (a0.etapa !== l.status_id || a0.responsavel !== l.responsible_user_id)) mudouDesde.add(l.id);
    // conta dividida: o cartão pode ter passado para a outra unidade depois da prévia
    const d = donoDoCartao(u!, l);
    if (d.tipo === 'outra') {
      mudouDesde.add(l.id);
      foiPraOutra.set(l.id, d.rotulo);
    }
  }
  const lote = p.patches.filter((x) => !mudouDesde.has(x.id));
  const resultado: Array<{ cartao: number; ok: boolean; erro?: string }> = [];
  if (lote.length) {
    try {
      await fonte.atualizar(lote);
      for (const x of lote) {
        resultado.push({ cartao: x.id, ok: true });
        registrar({ unidade: p.unidade, cartao: x.id, antes: p.antes.get(x.id), depois: x, ok: true });
      }
    } catch (e) {
      const erro = e instanceof Error ? e.message.slice(0, 300) : String(e);
      for (const x of lote) {
        resultado.push({ cartao: x.id, ok: false, erro });
        registrar({ unidade: p.unidade, cartao: x.id, antes: p.antes.get(x.id), depois: x, ok: false, erro });
      }
    }
  }
  for (const id of mudouDesde) {
    const outra = foiPraOutra.get(id);
    resultado.push({ cartao: id, ok: false, erro: outra ? `o cartão passou para ${outra} (⌂ Unidade de atendimento) desde a prévia: não alterei` : 'o cartão mudou de etapa ou responsável desde a prévia: não alterei; prepare de novo' });
  }
  const alvoNotaTarefa = [...p.antes.keys()].filter((id) => !mudouDesde.has(id));
  let notas = 0;
  let tarefas = 0;
  for (const id of alvoNotaTarefa) {
    if (p.nota) {
      try { await fonte.nota(id, p.nota); notas++; registrar({ unidade: p.unidade, cartao: id, antes: null, depois: { nota: p.nota.slice(0, 200) }, ok: true }); }
      catch (e) { resultado.push({ cartao: id, ok: false, erro: `nota: ${e instanceof Error ? e.message.slice(0, 200) : e}` }); }
    }
    if (p.tarefa) {
      try { await fonte.tarefa({ leadId: id, ...p.tarefa }); tarefas++; registrar({ unidade: p.unidade, cartao: id, antes: null, depois: { tarefa: p.tarefa.text.slice(0, 200) }, ok: true }); }
      catch (e) { resultado.push({ cartao: id, ok: false, erro: `tarefa: ${e instanceof Error ? e.message.slice(0, 200) : e}` }); }
    }
  }
  return {
    unidade: p.unidade,
    alterados: resultado.filter((r) => r.ok).length,
    comErro: resultado.filter((r) => !r.ok),
    notasCriadas: notas,
    tarefasCriadas: tarefas,
    registro: 'Cada alteração ficou registrada com o usuário, o antes e o depois.',
  };
}

export function registrarEscritaKommo(
  server: McpServer,
  ctx: ContextoKommo,
  fonteDe: (slug: string) => FonteEscrita,
  pendentes: Pendentes,
  usuario: string,
  auditar: Auditar,
): void {
  const valor = z.union([z.string(), z.number(), z.boolean(), z.null()]);
  server.registerTool(
    'kommo_preparar_alteracao',
    {
      title: 'Preparar alteração em cartões (Kommo)',
      description:
        'PASSO 1 de 2 para ALTERAR cartões do Kommo de UMA unidade (até 50 por vez): mover de etapa, trocar responsável, preencher ' +
        'campos, adicionar/tirar etiquetas, escrever nota, criar tarefa. NÃO grava nada: devolve o resumo cartão a cartão (de → para), ' +
        'avisos e um código. Mostre o resumo à pessoa e só chame kommo_confirmar_alteracao se ela aprovar. Etapa, campo, opção e ' +
        'usuário podem ser escritos pelo nome. Datas: AAAA-MM-DD ou DD/MM/AAAA [HH:MM].',
      inputSchema: {
        unidade: z.string().min(1).describe('UMA unidade: slug ou nome curto ("serra")'),
        cartoes: z.array(z.number().int().positive()).min(1).max(MAX_CARTOES).describe('números dos cartões (leads)'),
        mudancas: z.object({
          etapa: z.string().optional().describe('nome da etapa de destino (ex.: "NÃO COMPARECEU")'),
          responsavel: z.string().optional().describe('nome ou e-mail do usuário do Kommo'),
          campos: z.record(z.string(), valor).optional().describe('{ "nome do campo": valor }; vazio ou null esvazia'),
          adicionarEtiquetas: z.array(z.string().min(1)).optional(),
          removerEtiquetas: z.array(z.string().min(1)).optional(),
          nota: z.string().max(4000).optional().describe('nota a escrever em cada cartão'),
          tarefa: z.object({ texto: z.string().min(1), prazo: z.string(), responsavel: z.string().optional() }).optional(),
        }),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    (args) => executar('kommo_preparar_alteracao', args, auditar, () => prepararAlteracao(ctx, fonteDe, pendentes, usuario, args)),
  );
  server.registerTool(
    'kommo_confirmar_alteracao',
    {
      title: 'Confirmar alteração em cartões (Kommo)',
      description:
        'PASSO 2 de 2: grava no Kommo a alteração preparada, com o código que kommo_preparar_alteracao devolveu. Só chame depois que a ' +
        'pessoa aprovou o resumo. O código vale 15 minutos e uma vez; cartão que mudou desde a prévia fica de fora.',
      inputSchema: { confirmacao: z.string().min(4).max(16) },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    (args) =>
      executar('kommo_confirmar_alteracao', args, auditar, () =>
        confirmarAlteracao(ctx, fonteDe, pendentes, usuario, args, (r) =>
          auditar({ ferramenta: 'kommo_alteracao_gravada', argumentos: r, ok: r.ok, ms: 0, ...(r.erro ? { erro: r.erro } : {}) }),
        ),
      ),
  );
}

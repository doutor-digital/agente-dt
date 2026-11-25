/**
 * Funil de etapas do Chatwoot (pedido do João, 11/11/2026): o Chatwoot não tem quadro de etapas como o Kommo, e mexer no
 * código dele prenderia a gente numa versão. Então o funil é NOSSO, encaixado nele como "Dashboard App" (uma aba dentro da
 * conversa): a etapa mora num atributo personalizado da conversa (`etapa`, tipo lista — a Suzanne edita as etapas no próprio
 * Chatwoot) e o quadro lê/grava pela API da conta. Atualizar o Chatwoot não quebra nada.
 *
 * Aqui só a lógica pura (chave, montar o quadro); quem fala HTTP é `controllers/funil.controller.ts`.
 */
import { ehMensagemDeEspera } from './crm-demora/marca.js';
import { ehMolde, nomeDoTratamentoParaGravar, nomeParaGravar, papelDaEtapa, papelDaEtapaDoTratamento, type MapaDeEtapas } from './chatwoot-etapas.js';
import { createHmac, timingSafeEqual } from 'node:crypto';

export const ATRIBUTO_ETAPA = 'etapa';
/** Etapas de partida, se o atributo ainda não existir no Chatwoot. A lista que vale é a do atributo. */
export const ETAPAS_PADRAO = ['Novo', 'Em atendimento', 'Aguardando paciente', 'Agendado', 'Compareceu', 'Fechou tratamento', 'Perdido'] as const;
/** O funil do paciente (Comercial × Tratamento) e a etapa dele DENTRO do tratamento: dois atributos que a régua, a Sofia e o kit já usam. */
export const ATRIBUTO_FUNIL = 'funil';
export const ATRIBUTO_ETAPA_TRATAMENTO = 'etapa_tratamento';
export type FunilDoQuadro = 'comercial' | 'tratamento';
export const NOME_DO_FUNIL: Readonly<Record<FunilDoQuadro, string>> = { comercial: 'Comercial', tratamento: 'Tratamento' };
export const ehFunilDoQuadro = (v: unknown): v is FunilDoQuadro => v === 'comercial' || v === 'tratamento';

/** Quantas páginas de conversa (25 cada) o quadro lê de uma vez. */
export const MAX_PAGINAS = 8;

/**
 * Chave do funil, derivada do token do Chatwoot que o servidor já tem (CHATWOOT_API_TOKEN): sem variável nova no .env. Hoje só no link
 * avulso do João (v2: a v1 ia na URL do Dashboard App, que qualquer agente vê no iframe; a aba agora usa o login da pessoa) e no cabeçalho X-Funil-Chave das chamadas; o log mascara.
 */
export function chaveDoFunil(tokenChatwoot: string): string {
  return createHmac('sha256', tokenChatwoot).update('funil-v2').digest('hex').slice(0, 32);
}

export function chaveConfere(tokenChatwoot: string | undefined, recebida: unknown): boolean {
  if (!tokenChatwoot || typeof recebida !== 'string' || recebida.length !== 32) return false;
  const a = Buffer.from(chaveDoFunil(tokenChatwoot));
  const b = Buffer.from(recebida);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Login do próprio Chatwoot (o funil aberto pelo item "Funil" do menu, sem chave na URL): o script do menu lê o cookie de
 * sessão do Chatwoot (`cw_d_session_info`, que o painel deles já guarda legível) e passa para a página do funil, que manda
 * nos cabeçalhos X-CW-Token / X-CW-Client / X-CW-Uid. O servidor confere no `GET /api/v1/profile` do Chatwoot — quem não
 * está logado lá não vê nada, e a nota da mudança leva o nome de quem está logado (não o que a página diz).
 */
export interface SessaoChatwoot {
  token: string;
  client: string;
  uid: string;
}

export function sessaoDosCabecalhos(get: (nome: string) => string | undefined): SessaoChatwoot | null {
  const token = get('x-cw-token')?.trim() ?? '';
  const client = get('x-cw-client')?.trim() ?? '';
  const uid = get('x-cw-uid')?.trim() ?? '';
  const ok = (s: string, max: number) => s.length > 0 && s.length <= max && !/[\r\n]/.test(s);
  return ok(token, 200) && ok(client, 200) && ok(uid, 320) ? { token, client, uid } : null;
}

/** O nome de quem está logado, se o perfil do Chatwoot tem acesso à conta do funil; senão null. */
export function nomeSeTemConta(perfil: unknown, conta: number): string | null {
  const p = perfil as { name?: unknown; accounts?: unknown } | null;
  const contas = Array.isArray(p?.accounts) ? (p!.accounts as Array<{ id?: unknown }>) : [];
  if (!contas.some((a) => Number(a?.id) === conta)) return null;
  return texto(p?.name, 80) || 'alguém da equipe';
}

/** A lista de etapas do atributo `etapa` (definições de atributo da conversa); sem ele, a padrão. */
export function etapasDoAtributo(definicoes: unknown): string[] {
  const lista = Array.isArray(definicoes) ? definicoes : [];
  const def = lista.find((d: any) => d?.attribute_key === ATRIBUTO_ETAPA) as { attribute_values?: unknown } | undefined;
  const vals = Array.isArray(def?.attribute_values) ? def!.attribute_values.map((v) => String(v).trim()).filter(Boolean) : [];
  return vals.length ? [...new Set(vals)] : [...ETAPAS_PADRAO];
}

/**
 * As etapas do funil de TRATAMENTO (opções do atributo `etapa_tratamento`: Entrada, Em tratamento, Alta, Tratamento cancelado). Lista vazia = a conta não tem esse atributo:
 * o quadro segue como sempre, um funil só.
 */
export function etapasDoTratamento(definicoes: unknown): string[] {
  return valoresDoAtributo(definicoes, ATRIBUTO_ETAPA_TRATAMENTO);
}

/**
 * De qual funil é a conversa? A MESMA regra da régua (`chatwoot-regua.ts`) e da Sofia (`chatwoot-sofia.ts`): é do Tratamento quem tem `funil` = Tratamento OU `etapa_tratamento` preenchida; o resto é Comercial.
 * (A conversa de Tratamento não tem etapa comercial: antes de existir o quadro do Tratamento ela caía na 1ª coluna do Comercial, «Novo lead».)
 */
export function funilDaConversa(attrs: Record<string, unknown>): FunilDoQuadro {
  const f = typeof attrs[ATRIBUTO_FUNIL] === 'string' ? attrs[ATRIBUTO_FUNIL].trim().toLowerCase() : '';
  if (f === 'tratamento') return 'tratamento';
  return typeof attrs[ATRIBUTO_ETAPA_TRATAMENTO] === 'string' && attrs[ATRIBUTO_ETAPA_TRATAMENTO].trim() ? 'tratamento' : 'comercial';
}

/** Atributos da conversa que a ficha do funil edita (os outros, ela só mostra). */
export const CAMPOS_EDITAVEIS = ['qualificacao', 'valor_fechado', 'motivo_nao_agendamento'] as const;
export type CampoEditavel = (typeof CAMPOS_EDITAVEIS)[number];

/** Situação da tarefa no cartão, como o Kommo: sem tarefa, vencida (há N dias), hoje ou mais adiante. */
export type SituacaoTarefa = { tipo: 'sem' } | { tipo: 'vencida'; dias: number } | { tipo: 'hoje' } | { tipo: 'futura' };

export interface Cartao {
  id: number;
  nome: string;
  telefone: string | null;
  avatar: string | null;
  caixaId: number | null;
  /** a etapa no funil em que o cartão aparece: do Comercial (`etapa`) ou do Tratamento (`etapa_tratamento`) */
  etapa: string;
  funil: FunilDoQuadro;
  status: string;
  responsavel: string | null;
  responsavelId: number | null;
  ultimaMensagem: string;
  /** a última mensagem é da paciente (ela está esperando resposta) */
  ultimaDela: boolean;
  /** segundos desde 1970 (como o Chatwoot manda) */
  atividade: number;
  criado: number;
  etiquetas: string[];
  qualificacao: string | null;
  valor: number;
  tarefa: SituacaoTarefa;
}

function texto(v: unknown, max: number): string {
  const s = typeof v === 'string' ? v : '';
  const limpo = s.replace(/\s+/g, ' ').trim();
  return limpo.length > max ? `${limpo.slice(0, max - 1)}…` : limpo;
}

/** "R$ 1.234,50", "1234.5", 350 → número (reais). Lixo = 0. */
export function valorEmReais(v: unknown): number {
  if (typeof v === 'number') return Number.isFinite(v) && v > 0 ? Math.round(v * 100) / 100 : 0;
  if (typeof v !== 'string') return 0;
  let s = v.replace(/[^0-9.,-]/g, '');
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
  // sem vírgula: "1.800" e "2.000.000" são milhar (jeito brasileiro); "350.5" segue decimal
  else if (/^\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, '');
  const n = Number(s);
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : 0;
}

/** Situação da tarefa aberta mais próxima (`venceEm` das tarefas NÃO feitas) em relação a `agora`, pelo dia no fuso de SP. */
export function situacaoDaTarefa(vencimentos: Date[], agora: Date): SituacaoTarefa {
  if (!vencimentos.length) return { tipo: 'sem' };
  const dia = (d: Date) => Math.floor((d.getTime() - 3 * 3600_000) / 86_400_000); // dia em SP (UTC-3)
  const prox = vencimentos.reduce((a, b) => (a.getTime() <= b.getTime() ? a : b));
  if (prox.getTime() < agora.getTime()) return { tipo: 'vencida', dias: Math.max(0, dia(agora) - dia(prox)) };
  return dia(prox) === dia(agora) ? { tipo: 'hoje' } : { tipo: 'futura' };
}

/**
 * A coluna do funil de um valor de etapa (NOME da conta). Valor vazio ou fora da lista = a 1ª etapa; conversa que ainda tem o nome antigo do molde (conta
 * recém-trocada) cai na coluna do MESMO papel, não na 1ª. Sem mapa: como sempre. O quadro, a ficha e o «de» da nota ao mover usam esta mesma conta.
 */
export function colunaDaEtapa(nome: string, lista: readonly string[], mapa: MapaDeEtapas | null | undefined, doTratamento: boolean): string {
  if (lista.includes(nome)) return nome;
  if (nome && !ehMolde(mapa)) {
    const dela = doTratamento ? nomeDoTratamentoParaGravar(mapa, papelDaEtapaDoTratamento(mapa, nome)) : nomeParaGravar(mapa, papelDaEtapa(mapa, nome));
    if (dela && lista.includes(dela)) return dela;
  }
  return lista[0]!;
}

/** Uma conversa do Chatwoot vira cartão. Etapa vazia ou fora da lista = a 1ª etapa (o lead novo cai em "Novo"). */
export function cartaoDaConversa(c: any, etapas: string[], tarefa: SituacaoTarefa = { tipo: 'sem' }, etapasDoTrat: readonly string[] = [], mapa?: MapaDeEtapas | null): Cartao {
  const attrs = c?.custom_attributes && typeof c.custom_attributes === 'object' ? c.custom_attributes : {};
  const bruta = typeof attrs[ATRIBUTO_ETAPA] === 'string' ? attrs[ATRIBUTO_ETAPA].trim() : '';
  // conta SEM `etapa_tratamento`: um funil só, como sempre. Com ela, a conversa do Tratamento mostra a etapa DO tratamento
  const funil: FunilDoQuadro = etapasDoTrat.length ? funilDaConversa(attrs) : 'comercial';
  const brutaTrat = typeof attrs[ATRIBUTO_ETAPA_TRATAMENTO] === 'string' ? attrs[ATRIBUTO_ETAPA_TRATAMENTO].trim() : '';
  const etapa = funil === 'tratamento' ? colunaDaEtapa(brutaTrat, etapasDoTrat, mapa, true) : colunaDaEtapa(bruta, etapas, mapa, false);
  const msgs = Array.isArray(c?.messages) ? c.messages : [];
  // a última mensagem de verdade (avisos do sistema, tipo 2, como "Atribuído a…", não contam)
  const reais = msgs.filter((m: any) => Number(m?.message_type) !== 2);
  // nota interna NÃO é conversa: a última que conta é a última PÚBLICA. A nota «Veio do anúncio» (chatwoot-anuncio.ts) nasce logo
  // depois da 1ª mensagem do paciente e não pode tirar o lead de «Esperando resposta» (achado do sênior no #334).
  const publicas = reais.filter((m: any) => !m?.private);
  const lna = c?.last_non_activity_message;
  const ultima = publicas.length ? publicas[publicas.length - 1] : lna && !lna.private ? lna : null;
  // só veio nota (a listagem traz só a última mensagem quando a conversa já foi vista): quem diz se o paciente espera é o
  // `waiting_since` do Chatwoot (> 0 = mensagem do cliente sem resposta da equipe)
  const soNota = !ultima && (reais.length > 0 || !!lna);
  const remetente = c?.meta?.sender ?? {};
  const avatar = typeof remetente.thumbnail === 'string' && /^https:\/\//.test(remetente.thumbnail) ? remetente.thumbnail : null;
  return {
    id: Number(c?.id),
    nome: texto(remetente.name, 60) || `Conversa ${c?.id}`,
    telefone: texto(remetente.phone_number, 25) || null,
    avatar,
    caixaId: Number.isInteger(c?.inbox_id) ? c.inbox_id : null,
    etapa,
    funil,
    status: String(c?.status ?? ''),
    responsavel: texto(c?.meta?.assignee?.name, 40) || null,
    responsavelId: Number.isInteger(Number(c?.meta?.assignee?.id)) && Number(c?.meta?.assignee?.id) > 0 ? Number(c.meta.assignee.id) : null,
    ultimaMensagem: ultima ? texto(ultima.content, 120) : soNota ? '(nota interna)' : texto(undefined, 120),
    // a nossa mensagem de espera (crm-demora) só sai quando o paciente está sem resposta: se ela é a última, a paciente ainda espera
    ultimaDela: ultima ? Number(ultima.message_type) === 0 || ehMensagemDeEspera(ultima) : Number(c?.waiting_since ?? 0) > 0,
    atividade: Number(c?.last_activity_at ?? c?.timestamp ?? 0) || 0,
    criado: Number(c?.created_at ?? 0) || 0,
    etiquetas: Array.isArray(c?.labels) ? c.labels.map(String).slice(0, 5) : [],
    qualificacao: texto(attrs.qualificacao, 20) || null,
    valor: valorEmReais(attrs.valor_fechado),
    tarefa,
  };
}

/**
 * Junta as páginas da API (`data.payload`), sem repetir conversa, e monta as colunas na ordem das etapas (com a soma em R$).
 * Com `etapasDoTrat` (a conta tem `etapa_tratamento`) o quadro vira DOIS: o pedido (`funil`) mostra só as conversas daquele funil, com as etapas dele, e `funis` traz os dois totais para o seletor.
 */
export function montarQuadro(paginas: unknown[], etapas: string[], tarefas: Map<number, SituacaoTarefa> = new Map(), etapasDoTrat: readonly string[] = [], funil: FunilDoQuadro = 'comercial', mapa?: MapaDeEtapas | null) {
  const vistos = new Set<number>();
  const cartoes: Cartao[] = [];
  for (const p of paginas) {
    const lista = (p as any)?.data?.payload ?? (p as any)?.payload ?? [];
    for (const c of Array.isArray(lista) ? lista : []) {
      const k = Number(c?.id);
      if (!Number.isInteger(k) || vistos.has(k)) continue;
      vistos.add(k);
      cartoes.push(cartaoDaConversa(c, etapas, tarefas.get(k), etapasDoTrat, mapa));
    }
  }
  cartoes.sort((a, b) => b.atividade - a.atividade);
  const separa = etapasDoTrat.length > 0;
  const funilPedido: FunilDoQuadro = separa ? funil : 'comercial';
  const doFunil = separa ? cartoes.filter((c) => c.funil === funilPedido) : cartoes;
  const etapasDoFunil = funilPedido === 'tratamento' ? [...etapasDoTrat] : etapas;
  const colunas = etapasDoFunil.map((etapa) => {
    const cs = doFunil.filter((c) => c.etapa === etapa);
    return { etapa, soma: Math.round(cs.reduce((t, c) => t + c.valor, 0) * 100) / 100, cartoes: cs };
  });
  const funis = separa ? (['comercial', 'tratamento'] as const).map((id) => ({ id, nome: NOME_DO_FUNIL[id], total: cartoes.filter((c) => c.funil === id).length })) : [];
  return { etapas: etapasDoFunil, total: doFunil.length, colunas, funil: funilPedido, funis };
}

/** Os ids das conversas que aparecem nas páginas (para buscar as tarefas delas de uma vez). */
export function idsDasPaginas(paginas: unknown[]): number[] {
  const ids = new Set<number>();
  for (const p of paginas) {
    const lista = (p as any)?.data?.payload ?? (p as any)?.payload ?? [];
    for (const c of Array.isArray(lista) ? lista : []) if (Number.isInteger(Number(c?.id))) ids.add(Number(c.id));
  }
  return [...ids];
}

export interface ItemDoHistorico {
  id: number;
  tipo: 'ela' | 'nos' | 'nota' | 'sis';
  texto: string;
  quem: string | null;
  /** segundos desde 1970 */
  quando: number;
  anexo: boolean;
}

/** Mensagens do Chatwoot viram o histórico da ficha: da paciente, nossas, notas internas e avisos do sistema. */
export function historicoDasMensagens(payload: unknown): ItemDoHistorico[] {
  const lista = Array.isArray(payload) ? payload : Array.isArray((payload as any)?.payload) ? (payload as any).payload : [];
  return lista
    .map((m: any): ItemDoHistorico => {
      const t = Number(m?.message_type);
      const tipo: ItemDoHistorico['tipo'] = m?.private ? 'nota' : t === 0 ? 'ela' : t === 1 || t === 3 ? 'nos' : 'sis';
      const anexo = Array.isArray(m?.attachments) && m.attachments.length > 0;
      return {
        id: Number(m?.id),
        tipo,
        texto: texto(m?.content, 2000) || (anexo ? '(anexo)' : ''),
        quem: texto(m?.sender?.name, 60) || null,
        quando: Number(m?.created_at ?? 0) || 0,
        anexo,
      };
    })
    .filter((m: ItemDoHistorico) => Number.isInteger(m.id) && (m.texto || m.anexo))
    .sort((a: ItemDoHistorico, b: ItemDoHistorico) => a.quando - b.quando);
}

/** Desde quando a conversa está na etapa atual: a última nota "📋 Etapa: … → <etapa>" do funil; sem ela, a criação. */
export function desdeAEtapa(historico: ItemDoHistorico[], etapa: string, criado: number, doTratamento = false): number {
  const prefixo = doTratamento ? '📋 Etapa do tratamento:' : '📋 Etapa:';
  for (let i = historico.length - 1; i >= 0; i--) {
    const h = historico[i]!;
    if (h.tipo === 'nota' && h.texto.startsWith(prefixo) && h.texto.includes(`→ ${etapa}`)) return h.quando;
  }
  return criado;
}

/** Valores permitidos de um atributo de lista (definições de atributo da conversa). */
export function valoresDoAtributo(definicoes: unknown, chave: string): string[] {
  const lista = Array.isArray(definicoes) ? definicoes : [];
  const def = lista.find((d: any) => d?.attribute_key === chave) as { attribute_values?: unknown } | undefined;
  return Array.isArray(def?.attribute_values) ? [...new Set(def!.attribute_values.map((v) => String(v).trim()).filter(Boolean))] : [];
}

/**
 * Confere os campos que a ficha manda gravar: só os editáveis; listas só com valor da lista (ou vazio = limpar);
 * valor em reais vira número. Devolve o que gravar ou o motivo da recusa.
 */
export function camposParaGravar(
  pedido: Record<string, unknown>,
  definicoes: unknown,
): { ok: true; campos: Partial<Record<CampoEditavel, string | number | null>> } | { ok: false; erro: string } {
  const campos: Partial<Record<CampoEditavel, string | number | null>> = {};
  for (const [k, v] of Object.entries(pedido ?? {})) {
    if (!(CAMPOS_EDITAVEIS as readonly string[]).includes(k)) return { ok: false, erro: `campo não editável: ${k}` };
    const chave = k as CampoEditavel;
    if (v === null || v === '') {
      campos[chave] = null;
      continue;
    }
    if (chave === 'valor_fechado') {
      const n = valorEmReais(v);
      if (!n && v !== 0 && v !== '0') return { ok: false, erro: 'valor inválido' };
      campos[chave] = n;
      continue;
    }
    const s = String(v).trim();
    const permitidos = valoresDoAtributo(definicoes, chave);
    if (permitidos.length && !permitidos.includes(s)) return { ok: false, erro: `valor fora da lista em ${chave}` };
    campos[chave] = s.slice(0, 80);
  }
  return Object.keys(campos).length ? { ok: true, campos } : { ok: false, erro: 'nada para gravar' };
}

/** Telefone para cadastro (Adição rápida): só dígitos com +; BR sem DDI ganha +55. */
export function telefoneParaCadastro(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  let d = v.replace(/\D/g, '');
  if (d.length === 10 || d.length === 11) d = `55${d}`;
  return d.length >= 12 && d.length <= 15 ? `+${d}` : null;
}

/** Nota interna deixada na conversa a cada mudança (histórico de quem moveu e quando). */
export function notaDaMudanca(de: string, para: string, quem: string | null): string {
  return `📋 Etapa: ${de} → ${para}${quem ? ` (por ${quem})` : ''} — pelo funil`;
}

/** Etapas do tratamento que a RÉGUA observa (mandam mensagem ao paciente): mover para elas pelo funil pede confirmação. */
export const ETAPAS_DO_TRATAMENTO_QUE_A_REGUA_OBSERVA: readonly string[] = ['Alta', 'Tratamento cancelado'];
export const exigeConfirmacao = (etapa: string, mapa?: MapaDeEtapas | null): boolean => ETAPAS_DO_TRATAMENTO_QUE_A_REGUA_OBSERVA.includes(papelDaEtapaDoTratamento(mapa, etapa));

/** A mesma nota para a etapa DO TRATAMENTO (outro prefixo: `desdeAEtapa` só lê as notas da etapa comercial). */
export function notaDaMudancaDeTratamento(de: string, para: string, quem: string | null): string {
  return `📋 Etapa do tratamento: ${de} → ${para}${quem ? ` (por ${quem})` : ''} — pelo funil`;
}

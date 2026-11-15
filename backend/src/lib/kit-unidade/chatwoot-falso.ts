/**
 * UM CHATWOOT (E UM KAPSO) DE MENTIRA, NO NÍVEL DO HTTP, para provar o `--aplicar` inteiro sem tocar em nada de verdade. É um `fetch` que
 * entende os endereços de plataforma e de conta que o kit usa e FALHA como o Chatwoot falha (nome repetido = 422, token de outra conta = 401,
 * usuário já existente = 422), para que um passo que não seja idempotente apareça no teste.
 *
 * Não é o Chatwoot: os formatos aqui são os que o kit ESPERA (developers.chatwoot.com). A prova de que batem com o Chatwoot real só vem do
 * primeiro `--aplicar` de verdade.
 */

interface Etiqueta { id: number; title: string; description: string; color: string; show_on_sidebar: boolean }
interface Atributo { id: number; attribute_key: string; attribute_display_name: string; attribute_display_type: number; attribute_values: string[]; attribute_model: number; attribute_description: string }
interface Regra { id: number; name: string; description: string; event_name: string; active: boolean; conditions: unknown[]; actions: unknown[] }
interface ContaFalsa {
  id: number;
  name: string;
  labels: Etiqueta[];
  attrs: Atributo[];
  rules: Regra[];
  canned: Array<{ id: number; short_code: string; content: string }>;
  inboxes: Array<{ id: number; name: string; channel_type: string; channel: Record<string, unknown>; agent_bot: number | null; membros: number[] }>;
  teams: Array<{ id: number; name: string; membros: number[] }>;
  agents: Array<{ id: number; name: string; email: string; role: string }>;
  bots: Array<{ id: number; name: string; outgoing_url: string; access_token: string }>;
  webhooks: Array<{ id: number; url: string; subscriptions: string[] }>;
  apps: Array<{ id: number; title: string; content: unknown[] }>;
}

export interface OpcoesDoFalso {
  tokenDaPlataforma?: string;
  tokenDeReferencia?: string;
  /** sem isto a conta de referência (a 1) nasce vazia */
  referencia?: Partial<Pick<ContaFalsa, 'labels' | 'attrs' | 'rules'>>;
  /** liga/desliga a plataforma (conta que o João ainda não criou o Platform App) */
  semPlataforma?: boolean;
}

export interface ChamadaFalsa { metodo: string; caminho: string; corpo: unknown; conta: number | 'plataforma' | 'kapso' | null }

let proximoId = 1000;
const id = () => ++proximoId;

export function chatwootFalso(o: OpcoesDoFalso = {}) {
  const tokenDaPlataforma = o.tokenDaPlataforma ?? 'plat-secreto';
  const tokenDeReferencia = o.tokenDeReferencia ?? 'ref-secreto';
  const contas = new Map<number, ContaFalsa>();
  const usuarios = new Map<number, { id: number; name: string; email: string; access_token: string; contas: Map<number, string> }>();
  const kapso = new Map<string, Map<string, { name: string; status: string; corpo: unknown }>>();
  const chamadas: ChamadaFalsa[] = [];
  const conta = (n: number, name: string, extra: Partial<ContaFalsa> = {}): ContaFalsa => {
    const c: ContaFalsa = { id: n, name, labels: [], attrs: [], rules: [], canned: [], inboxes: [], teams: [], agents: [], bots: [], webhooks: [], apps: [], ...extra };
    contas.set(n, c);
    return c;
  };
  conta(1, 'Parauapebas (referência)', {
    labels: o.referencia?.labels ?? [],
    attrs: o.referencia?.attrs ?? [],
    rules: o.referencia?.rules ?? [],
  });

  const resposta = (status: number, corpo: unknown): Response => new Response(corpo === null ? '' : JSON.stringify(corpo), { status });
  const erro422 = (m: string) => resposta(422, { message: m });

  async function tratar(url: string, init: RequestInit = {}): Promise<Response> {
    const u = new URL(url);
    const metodo = String(init.method ?? 'GET').toUpperCase();
    const corpo = init.body ? JSON.parse(String(init.body)) : undefined;
    const cab = (init.headers ?? {}) as Record<string, string>;
    const caminho = u.pathname;

    // ── Kapso ──
    const k = /^\/meta\/whatsapp\/v[\d.]+\/(\d+)\/message_templates$/.exec(caminho);
    if (k) {
      chamadas.push({ metodo, caminho, corpo, conta: 'kapso' });
      if (!cab['X-API-Key']) return resposta(401, { error: { message: 'sem chave' } });
      const waba = kapso.get(k[1]!) ?? kapso.set(k[1]!, new Map()).get(k[1]!)!;
      if (metodo === 'GET') return resposta(200, { data: [...waba.values()].map((m) => ({ name: m.name, status: m.status })), paging: {} });
      if (waba.has(corpo.name)) return resposta(400, { error: { message: 'Já existe um modelo com este nome' } });
      waba.set(corpo.name, { name: corpo.name, status: 'PENDING', corpo });
      return resposta(200, { id: String(id()), status: 'PENDING' });
    }

    // ── plataforma ──
    const p = /^\/platform\/api\/v1\/(.*)$/.exec(caminho);
    if (p) {
      chamadas.push({ metodo, caminho, corpo, conta: 'plataforma' });
      if (o.semPlataforma || cab.api_access_token !== tokenDaPlataforma) return resposta(401, { error: 'Invalid Access Token' });
      const rota = p[1]!;
      let m: RegExpExecArray | null;
      if (metodo === 'POST' && rota === 'accounts') {
        const novo = conta(id(), corpo.name);
        return resposta(200, { id: novo.id, name: novo.name });
      }
      if (metodo === 'GET' && (m = /^accounts\/(\d+)$/.exec(rota))) {
        const c = contas.get(Number(m[1]));
        return c ? resposta(200, { id: c.id, name: c.name }) : resposta(404, { error: 'Resource could not be found' });
      }
      if (metodo === 'POST' && rota === 'users') {
        if ([...usuarios.values()].some((x) => x.email === corpo.email)) return erro422('Email has already been taken');
        if (!corpo.password || String(corpo.password).length < 8) return erro422('Password is too short');
        const uid = id();
        const usuario = { id: uid, name: corpo.name, email: corpo.email, access_token: `tok-usuario-${uid}-${Math.random().toString(36).slice(2, 12)}`, contas: new Map<number, string>() };
        usuarios.set(uid, usuario);
        return resposta(200, { id: uid, name: usuario.name, email: usuario.email, access_token: usuario.access_token });
      }
      if (metodo === 'POST' && (m = /^accounts\/(\d+)\/account_users$/.exec(rota))) {
        const c = contas.get(Number(m[1]));
        const usuario = usuarios.get(Number(corpo.user_id));
        if (!c || !usuario) return resposta(404, { error: 'Resource could not be found' });
        usuario.contas.set(c.id, corpo.role);
        if (!c.agents.some((a) => a.id === usuario.id)) c.agents.push({ id: usuario.id, name: usuario.name, email: usuario.email, role: corpo.role });
        return resposta(200, { ok: true });
      }
      return resposta(404, { error: 'rota desconhecida no falso' });
    }

    // ── conta ──
    const a = /^\/api\/v1\/accounts\/(\d+)(?:\/(.*))?$/.exec(caminho);
    if (!a) return resposta(404, { error: 'rota desconhecida no falso' });
    const n = Number(a[1]);
    chamadas.push({ metodo, caminho, corpo, conta: n });
    const c = contas.get(n);
    const token = cab.api_access_token;
    const autorizado = !!c && (n === 1 ? token === tokenDeReferencia : [...usuarios.values()].some((x) => x.access_token === token && x.contas.get(n) === 'administrator'));
    if (!autorizado) return resposta(401, { error: 'Invalid Access Token' });
    const rota = a[2] ?? '';
    const c2 = c!;
    let m: RegExpExecArray | null;

    if (rota === 'labels') {
      if (metodo === 'GET') return resposta(200, { payload: c2.labels });
      if (c2.labels.some((x) => x.title === corpo.title)) return erro422('Title has already been taken');
      const novo = { id: id(), title: corpo.title, description: corpo.description ?? '', color: corpo.color ?? '#1f93ff', show_on_sidebar: !!corpo.show_on_sidebar };
      c2.labels.push(novo);
      return resposta(200, novo);
    }
    if (rota === 'custom_attribute_definitions') {
      const modelo = Number(u.searchParams.get('attribute_model') ?? 0);
      if (metodo === 'GET') return resposta(200, c2.attrs.filter((x) => x.attribute_model === modelo));
      const mod = corpo.attribute_model === 'contact_attribute' ? 1 : Number(corpo.attribute_model ?? 0);
      if (c2.attrs.some((x) => x.attribute_key === corpo.attribute_key && x.attribute_model === mod)) return erro422('Attribute key has already been taken');
      const novo: Atributo = { id: id(), attribute_key: corpo.attribute_key, attribute_display_name: corpo.attribute_display_name, attribute_display_type: Number(corpo.attribute_display_type ?? 0), attribute_values: corpo.attribute_values ?? [], attribute_model: mod, attribute_description: corpo.attribute_description ?? '' };
      c2.attrs.push(novo);
      return resposta(200, novo);
    }
    if (rota === 'automation_rules') {
      if (metodo === 'GET') return resposta(200, { payload: c2.rules });
      if (c2.rules.some((x) => x.name === corpo.name)) return erro422('Name has already been taken');
      const nova: Regra = { id: id(), name: corpo.name, description: corpo.description ?? '', event_name: corpo.event_name, active: corpo.active !== false, conditions: corpo.conditions ?? [], actions: corpo.actions ?? [] };
      c2.rules.push(nova);
      return resposta(200, { payload: nova });
    }
    if (rota === 'canned_responses') {
      if (metodo === 'GET') return resposta(200, c2.canned);
      if (c2.canned.some((x) => x.short_code === corpo.short_code)) return erro422('Short code has already been taken');
      const nova = { id: id(), short_code: corpo.short_code, content: corpo.content };
      c2.canned.push(nova);
      return resposta(200, nova);
    }
    if (rota === 'inboxes') {
      if (metodo === 'GET') return resposta(200, { payload: c2.inboxes.map((x) => ({ id: x.id, name: x.name, channel_type: x.channel_type, agent_bot: x.agent_bot })) });
      if (c2.inboxes.some((x) => x.name === corpo.name)) return erro422('Name has already been taken');
      const tipo = corpo.channel?.type === 'api' ? 'Channel::Api' : 'Channel::Whatsapp';
      const nova = { id: id(), name: corpo.name, channel_type: tipo, channel: corpo.channel ?? {}, agent_bot: null as number | null, membros: [] as number[] };
      c2.inboxes.push(nova);
      return resposta(200, { id: nova.id, name: nova.name, channel_type: tipo });
    }
    if (metodo === 'POST' && (m = /^inboxes\/(\d+)\/set_agent_bot$/.exec(rota))) {
      const i = c2.inboxes.find((x) => x.id === Number(m![1]));
      if (!i) return resposta(404, { error: 'Resource could not be found' });
      i.agent_bot = Number(corpo.agent_bot);
      return resposta(200, { ok: true });
    }
    if (metodo === 'GET' && (m = /^inbox_members\/(\d+)$/.exec(rota))) {
      const i = c2.inboxes.find((x) => x.id === Number(m![1]));
      return i ? resposta(200, { payload: c2.agents.filter((a) => i.membros.includes(a.id)).map((a) => ({ id: a.id, name: a.name })) }) : resposta(404, { error: 'Resource could not be found' });
    }
    if (rota === 'inbox_members') {
      const i = c2.inboxes.find((x) => x.id === Number(corpo.inbox_id));
      if (!i) return resposta(404, { error: 'Resource could not be found' });
      i.membros = [...new Set([...i.membros, ...corpo.user_ids.map(Number)])];
      return resposta(200, { payload: i.membros });
    }
    if (rota === 'teams') {
      if (metodo === 'GET') return resposta(200, c2.teams.map((t) => ({ id: t.id, name: t.name })));
      if (c2.teams.some((x) => x.name === corpo.name)) return erro422('Name has already been taken');
      const novo = { id: id(), name: corpo.name, membros: [] as number[] };
      c2.teams.push(novo);
      return resposta(200, { id: novo.id, name: novo.name });
    }
    if (metodo === 'GET' && (m = /^teams\/(\d+)\/team_members$/.exec(rota))) {
      const t = c2.teams.find((x) => x.id === Number(m![1]));
      return t ? resposta(200, c2.agents.filter((a) => t.membros.includes(a.id)).map((a) => ({ id: a.id, name: a.name }))) : resposta(404, { error: 'Resource could not be found' });
    }
    if (metodo === 'POST' && (m = /^teams\/(\d+)\/team_members$/.exec(rota))) {
      const t = c2.teams.find((x) => x.id === Number(m![1]));
      if (!t) return resposta(404, { error: 'Resource could not be found' });
      t.membros = [...new Set([...t.membros, ...corpo.user_ids.map(Number)])];
      return resposta(200, { payload: t.membros });
    }
    if (rota === 'agents') {
      if (metodo === 'GET') return resposta(200, c2.agents);
      if (c2.agents.some((x) => x.email === corpo.email)) return erro422('Email has already been taken');
      const novo = { id: id(), name: corpo.name, email: corpo.email, role: corpo.role ?? 'agent' };
      c2.agents.push(novo);
      return resposta(200, novo);
    }
    if (rota === 'agent_bots') {
      if (metodo === 'GET') return resposta(200, c2.bots.map((b) => ({ id: b.id, name: b.name, outgoing_url: b.outgoing_url })));
      if (c2.bots.some((x) => x.name === corpo.name)) return erro422('Name has already been taken');
      const novo = { id: id(), name: corpo.name, outgoing_url: corpo.outgoing_url ?? '', access_token: `tok-robo-${Math.random().toString(36).slice(2, 14)}` };
      c2.bots.push(novo);
      return resposta(200, { id: novo.id, name: novo.name, access_token: novo.access_token });
    }
    if (rota === 'webhooks') {
      if (metodo === 'GET') return resposta(200, { payload: { webhooks: c2.webhooks } });
      if (c2.webhooks.some((x) => x.url === corpo.url)) return erro422('Url has already been taken');
      const novo = { id: id(), url: corpo.url, subscriptions: corpo.subscriptions ?? [] };
      c2.webhooks.push(novo);
      return resposta(200, { payload: { webhook: novo } });
    }
    if (rota === 'dashboard_apps') {
      if (metodo === 'GET') return resposta(200, c2.apps);
      if (c2.apps.some((x) => x.title === corpo.title)) return erro422('Title has already been taken');
      const novo = { id: id(), title: corpo.title, content: corpo.content };
      c2.apps.push(novo);
      return resposta(200, novo);
    }
    return resposta(404, { error: `rota desconhecida no falso: ${metodo} ${rota}` });
  }

  return {
    fetch: tratar as unknown as typeof fetch,
    chamadas,
    tokenDaPlataforma,
    tokenDeReferencia,
    /** o que o falso guardou (para o teste conferir) */
    contas,
    usuarios,
    kapso,
    /** conta de referência com o molde mínimo (etiquetas, atributos e uma regra), como a de Parauapebas */
    semear(c: Partial<Pick<ContaFalsa, 'labels' | 'attrs' | 'rules'>>) {
      const ref = contas.get(1)!;
      ref.labels.push(...(c.labels ?? []));
      ref.attrs.push(...(c.attrs ?? []));
      ref.rules.push(...(c.rules ?? []));
    },
  };
}

export type ChatwootFalso = ReturnType<typeof chatwootFalso>;

/**
 * Do FORMULÁRIO do franqueado para o QUESTIONÁRIO do kit (`--do-formulario`). O dono respondeu o que ele sabe; aqui entra o que o KIT sabe sugerir (slug,
 * subdomínio, sufixo, nomes das variáveis, nome da caixa e do time, fuso) e o que só o João/Suzanne sabem (ids do Kapso e do WhatsApp Business, e, se o
 * dono não soube dizer, o código da franquia e a conta de anúncios) vira PENDÊNCIA com a mensagem do próprio questionário — o arquivo sai mesmo assim,
 * para o João completar com `--set caminho=valor` (lista fechada, abaixo) sem editar YAML à mão.
 *
 * SEGREDO NUNCA ENTRA: o questionário só tem NOMES de variáveis (FRANQUIA_TOKEN_<SUF>, META_ADS_TOKEN_<SUF>…). O arquivo gerado tem dado pessoal (e-mails da
 * equipe, Pix, telefone): vai para `unidades/privado/` da VPS, modo 600 — nunca para o GitHub nem para log.
 */
import type { RespostasFormulario } from './formulario.js';
import { kebab, objecaoMudou, sugestoesDoKit } from './formulario.js';
import { OBJECOES_PADRAO } from './assistente-padrao.js';
import { validarQuestionario } from './questionario.js';

/** Fuso por estado (o questionário assume America/Belem; clínica no ES ou no AC não pode herdar isso). */
const FUSO_POR_UF: Record<string, string> = {
  AC: 'America/Rio_Branco',
  AM: 'America/Manaus', RR: 'America/Manaus', RO: 'America/Manaus',
  MT: 'America/Cuiaba', MS: 'America/Campo_Grande',
  PA: 'America/Belem', AP: 'America/Belem',
  MA: 'America/Fortaleza', CE: 'America/Fortaleza', PI: 'America/Fortaleza', RN: 'America/Fortaleza', PB: 'America/Fortaleza', PE: 'America/Recife', AL: 'America/Maceio', SE: 'America/Maceio', BA: 'America/Bahia',
  TO: 'America/Araguaina',
};
export const fusoDaUf = (uf: string): string => FUSO_POR_UF[uf] ?? 'America/Sao_Paulo';

/** O que o João pode completar na linha de comando (`--set caminho=valor`). Tudo aqui é identificador, não segredo. */
export const AJUSTES_PERMITIDOS = [
  'unidade.slug', 'chatwoot.subdominio', 'whatsapp.prefixo_modelos', 'whatsapp.numero_oficial', 'whatsapp.kapso_phone_number_id', 'whatsapp.waba_id',
  'franquia.id_company', 'meta.ad_account', 'meta.business_manager_id', 'sufixo',
] as const;
const FORMATO_DO_AJUSTE: Record<(typeof AJUSTES_PERMITIDOS)[number], { re: RegExp; dica: string }> = {
  'unidade.slug': { re: /^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$/, dica: 'minúsculas, dígitos e hífen (3 a 50), ex.: doutor-hernia-serra' },
  'chatwoot.subdominio': { re: /^[a-z0-9]{3,40}$/, dica: 'minúsculas e dígitos, sem hífen (3 a 40)' },
  'whatsapp.prefixo_modelos': { re: /^[a-z][a-z0-9]{1,15}_$/, dica: 'minúsculas/dígitos e «_» no fim, ex.: serra_' },
  'whatsapp.numero_oficial': { re: /^\+\d{12,14}$/, dica: 'formato +5527999990000' },
  'whatsapp.kapso_phone_number_id': { re: /^\d{5,25}$/, dica: 'só dígitos' },
  'whatsapp.waba_id': { re: /^\d{5,25}$/, dica: 'só dígitos' },
  'franquia.id_company': { re: /^[1-9]\d{0,8}$/, dica: 'só dígitos (número inteiro positivo)' },
  'meta.ad_account': { re: /^act_\d{5,25}$/, dica: 'act_ e os dígitos' },
  'meta.business_manager_id': { re: /^\d{5,25}$/, dica: 'só dígitos' },
  sufixo: { re: /^[A-Z0-9]{2,30}$/, dica: 'MAIÚSCULAS e dígitos, sem _ (2 a 30), ex.: SERRA' },
};

export type Ajustes = Partial<Record<(typeof AJUSTES_PERMITIDOS)[number], string>>;

export function lerAjustes(pares: string[]): { ok: true; ajustes: Ajustes } | { ok: false; erro: string } {
  const ajustes: Record<string, string> = {};
  for (const p of pares) {
    const i = p.indexOf('=');
    const k = i > 0 ? p.slice(0, i) : p;
    const v = i > 0 ? p.slice(i + 1).trim() : '';
    if (!(AJUSTES_PERMITIDOS as readonly string[]).includes(k)) return { ok: false, erro: `--set ${k}: não posso mudar isso por aqui. Campos aceitos: ${AJUSTES_PERMITIDOS.join(', ')}.` };
    if (!v) return { ok: false, erro: `--set ${k}: falta o valor (--set ${k}=valor).` };
    if (/\s|[\\'"`$;&|<>]/.test(v)) return { ok: false, erro: `--set ${k}: valor com espaço ou caractere estranho.` };
    const formato = FORMATO_DO_AJUSTE[k as (typeof AJUSTES_PERMITIDOS)[number]];
    if (!formato.re.test(v)) return { ok: false, erro: `--set ${k}: ${formato.dica}` };
    ajustes[k] = v;
  }
  return { ok: true, ajustes: ajustes as Ajustes };
}

export interface QuestionarioGerado {
  /** o objeto (já no formato do questionário; pode estar INCOMPLETO — ver pendencias) */
  objeto: Record<string, unknown>;
  slug: string;
  subdominio: string;
  sufixo: string;
  modo: 'real';
  /** o que falta para o questionário passar na validação do kit (mensagens do próprio kit, com o campo) */
  pendencias: string[];
  valido: boolean;
}

/** `PARAUAPEBAS` → `parau_` (5 letras + `_`); o João troca com `--set whatsapp.prefixo_modelos=` se colidir com outra unidade. */
export function prefixoDeModelos(cidade: string): string {
  const letras = kebab(cidade).replace(/-/g, '').slice(0, 5);
  return /^[a-z]/.test(letras) && letras.length >= 2 ? `${letras}_` : 'clin_';
}

/** Só campo preenchido entra (o questionário não carrega vazio). */
const sem = <T extends Record<string, unknown>>(o: T): Partial<T> => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== '')) as Partial<T>;

/**
 * A seção «Assistente virtual» do formulário → bloco `assistente` do questionário. `quer: false` → só isso (a Sofia não é configurada). Das objeções só vão as que o dono MUDOU ou criou:
 * as que ficaram iguais ao padrão da rede já estão no roteiro da rede e não viram aprendizado. O tom «próximo» do formulário é o `friendly` do kit.
 */
export function assistenteDoFormulario(a: RespostasFormulario['assistente']): Record<string, unknown> {
  if (!a.quer) return { quer: false };
  const objecoes = (a.objecoes ?? [])
    .filter((o) => objecaoMudou(o.id, o.resposta))
    .map((o) => ({ gatilho: o.id === 'outra' ? o.gatilho! : OBJECOES_PADRAO.find((p) => p.id === o.id)!.gatilho, resposta: o.resposta! }));
  const pc = a.primeira_consulta ? sem(a.primeira_consulta) : undefined;
  const pg = a.pagamento ? sem(a.pagamento) : undefined;
  const qr = a.quem_recebe ? sem(a.quem_recebe) : undefined;
  return sem({
    quer: true,
    emoji: a.emoji,
    quando_atende: a.quando_atende,
    quando_atende_detalhe: a.quando_atende === 'personalizado' ? a.quando_atende_detalhe : undefined,
    saudacao: a.saudacao,
    diferenciais: a.diferenciais,
    primeira_consulta: pc && Object.keys(pc).length ? pc : undefined,
    pagamento: pg && Object.keys(pg).length ? pg : undefined,
    nao_atende: a.nao_atende,
    objecoes: objecoes.length ? objecoes : undefined,
    nunca_extra: a.nunca_extra,
    passar_extra: a.passar_extra,
    quem_recebe: qr && Object.keys(qr).length ? qr : undefined,
    faq: a.faq?.length ? a.faq.map((f) => ({ pergunta: f.pergunta, resposta: f.resposta })) : undefined,
  });
}

export function questionarioDoFormulario(r: RespostasFormulario, ajustes: Ajustes = {}): QuestionarioGerado {
  const sug = sugestoesDoKit(r.clinica.cidade);
  const slug = ajustes['unidade.slug'] ?? sug.slug;
  const subdominio = ajustes['chatwoot.subdominio'] ?? sug.subdominio;
  const sufixo = ajustes.sufixo ?? sug.sufixo;
  const numero = ajustes['whatsapp.numero_oficial'] ?? r.whatsapp.numero;
  const idCompany = ajustes['franquia.id_company'] !== undefined ? Number(ajustes['franquia.id_company']) : r.franquia_id_company;
  const adAccount = ajustes['meta.ad_account'] ?? r.meta.ad_account;
  const bm = ajustes['meta.business_manager_id'] ?? r.meta.business_manager_id;
  const kapso = ajustes['whatsapp.kapso_phone_number_id'];
  const waba = ajustes['whatsapp.waba_id'];
  const v = r.valores;

  // chaves na ordem do questionário de exemplo; campo ausente simplesmente não entra (a validação do kit diz o que falta)
  const objeto: Record<string, unknown> = {
    versao: 1,
    unidade: {
      nome: r.clinica.nome, slug, cidade: r.clinica.cidade, uf: r.clinica.uf, endereco: r.clinica.endereco, mapa_url: r.clinica.mapa_url,
      ...(r.clinica.telefone ? { telefone: r.clinica.telefone } : {}), fuso: fusoDaUf(r.clinica.uf),
    },
    horarios: {
      dias: [...r.horarios.dias].sort((a, b) => a - b), inicio: r.horarios.inicio, fim: r.horarios.fim,
      ...(r.horarios.almoco_inicio ? { almoco_inicio: r.horarios.almoco_inicio, almoco_fim: r.horarios.almoco_fim } : {}), duracao_min: r.horarios.duracao_min,
    },
    profissionais: r.profissionais.map((p) => ({ nome: p.nome, funcao: p.funcao })),
    valores: {
      consulta_no_dia: v.consulta_no_dia,
      ...(v.consulta_antecipada !== undefined ? { consulta_antecipada: v.consulta_antecipada } : {}),
      ...(v.sinal_pix !== undefined ? { sinal_pix: v.sinal_pix } : {}),
      aceita_antecipado: v.consulta_antecipada !== undefined,
      ...(v.chave_pix ? { chave_pix: v.chave_pix } : {}), ...(v.favorecido ? { favorecido: v.favorecido } : {}),
    },
    whatsapp: {
      modo: 'real',
      ...(numero ? { numero_oficial: numero } : {}),
      ...(kapso ? { kapso_phone_number_id: kapso } : {}),
      ...(waba ? { waba_id: waba } : {}),
      prefixo_modelos: ajustes['whatsapp.prefixo_modelos'] ?? prefixoDeModelos(r.clinica.cidade),
      conexao: r.whatsapp.conexao,
    },
    chatwoot: {
      subdominio, caixa_nome: `${r.clinica.cidade} · WhatsApp oficial`, time_nome: r.clinica.cidade, meta_agendamentos_dia: 5,
      atendentes: r.equipe.map((p) => ({ nome: p.nome, email: p.email, funcao: p.funcao })),
      ...(r.celular_email ? { usuario_celular_email: r.celular_email } : {}),
    },
    franquia: { ...(idCompany !== undefined ? { id_company: idCompany } : {}), token_env: `FRANQUIA_TOKEN_${sufixo}` },
    meta: {
      ...(adAccount ? { ad_account: adAccount } : {}), ...(bm ? { business_manager_id: bm } : {}),
      token_env: `META_ADS_TOKEN_${sufixo}`, conta_env: `META_ADS_CONTA_${sufixo}`, dataset_id_env: `META_DATASET_ID_${sufixo}`,
    },
    sofia: { nome_ia: r.assistente.quer ? (r.assistente.nome_ia ?? 'Sofia') : 'Sofia', tom: r.assistente.quer && r.assistente.tom === 'formal' ? 'formal' : 'friendly' },
    assistente: assistenteDoFormulario(r.assistente),
  };
  // o que o dono NÃO tem como saber vira pendência com nome claro (o zod só diria «Required»); o resto vem da validação do próprio kit
  const faltando: [string, string][] = [];
  if (!numero) faltando.push(['whatsapp.numero_oficial', 'número do WhatsApp da clínica (o dono ainda não tem número, ou não informou)']);
  if (!kapso) faltando.push(['whatsapp.kapso_phone_number_id', 'identificador do número no painel do Kapso (Números): só o João/Suzanne sabem']);
  if (!waba) faltando.push(['whatsapp.waba_id', 'identificador da conta do WhatsApp Business (Meta Business → Contas do WhatsApp): só o João/Suzanne sabem']);
  if (idCompany === undefined) faltando.push(['franquia.id_company', 'código da unidade no seletor da franquia (o dono não informou)']);
  if (!adAccount) faltando.push(['meta.ad_account', 'conta de anúncios, act_… (o dono não informou)']);
  if (!bm) faltando.push(['meta.business_manager_id', 'Business Manager da Meta (o dono não informou)']);
  const val = validarQuestionario(objeto);
  const jaDitos = new Set(faltando.map(([c]) => c));
  const outros = val.ok ? [] : val.erros.filter((e) => !jaDitos.has(e.split(':')[0]!));
  const pendencias = [...faltando.map(([c, m]) => `${c}: ${m}`), ...outros];
  return { objeto, slug, subdominio, sufixo, modo: 'real', pendencias, valido: pendencias.length === 0 && val.ok };
}

// ── YAML de saída (só o subconjunto que o leitor do kit entende; texto entre aspas duplas, como JSON) ─────────────────

const SIMPLES = /^[A-Za-z][A-Za-z0-9_-]*$/;
function escalar(v: unknown): string {
  if (typeof v === 'string') return SIMPLES.test(v) && !/^(true|false|null|yes|no|on|off)$/i.test(v) ? v : JSON.stringify(v);
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  throw new Error(`valor não suportado no YAML de saída: ${typeof v}`);
}

export function paraYaml(obj: Record<string, unknown>, cabecalho = ''): string {
  const out: string[] = cabecalho ? cabecalho.split('\n').map((l) => `# ${l}`.trimEnd()) : [];
  const mapa = (o: Record<string, unknown>, nivel: number) => {
    const pad = '  '.repeat(nivel);
    for (const [k, v] of Object.entries(o)) {
      if (v === undefined) continue;
      if (Array.isArray(v)) {
        if (v.every((x) => typeof x !== 'object')) out.push(`${pad}${k}: [${v.map(escalar).join(', ')}]`);
        else {
          out.push(`${pad}${k}:`);
          for (const item of v as Record<string, unknown>[]) {
            const [primeiro, ...resto] = Object.entries(item).filter(([, x]) => x !== undefined);
            out.push(`${pad}  - ${primeiro![0]}: ${escalar(primeiro![1])}`);
            for (const [kk, vv] of resto) out.push(`${pad}    ${kk}: ${escalar(vv)}`);
          }
        }
      } else if (v && typeof v === 'object') {
        out.push(`${pad}${k}:`);
        mapa(v as Record<string, unknown>, nivel + 1);
      } else out.push(`${pad}${k}: ${escalar(v)}`);
    }
  };
  mapa(obj, 0);
  return `${out.join('\n')}\n`;
}


/**
 * O QUESTIONÁRIO DE UNIDADE NOVA (kit de unidade, 14/11/2026): só o que é específico ou sensível. Todo o resto o script monta.
 *
 * A fonte da verdade da forma é ESTE esquema (zod); `ops/kit-unidade/questionario.schema.json` é a mesma forma em JSON Schema para
 * o editor e tem um teste que falha se os dois se afastarem. Campos SENSÍVEIS ficam marcados (`CAMPOS_SENSIVEIS`): o plano os mostra
 * mascarados e o relatório não os repete.
 *
 * SEGREDO NUNCA ENTRA AQUI: onde existe um token, o questionário pede o NOME da variável de ambiente (`META_ADS_TOKEN_PARAUAPEBAS`),
 * nunca o valor. O valor mora no env do serviço / no arquivo de segredos da VPS, como sempre.
 */
import { z } from 'zod';
import type { ConfigChatwootUnidade } from '../chatwoot-unidades.js';
import { lerYamlOuJson } from './yaml-minimo.js';

const hora = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'use HH:MM (24 h)');
const nomeDeVariavel = z.string().regex(/^[A-Z][A-Z0-9_]{2,60}$/, 'é o NOME da variável de ambiente (MAIÚSCULAS e _), nunca o valor');
/** Identificador só de dígitos. No YAML sem aspas ele vira número: aceita e guarda como texto (o schema pede texto; entre aspas é o jeito certo). */
const digitos = (min = 5, max = 25) => z.preprocess((v) => (typeof v === 'number' && Number.isSafeInteger(v) ? String(v) : v), z.string().regex(new RegExp(`^\\d{${min},${max}}$`), `só dígitos (${min} a ${max})`));
/** Objeto que recusa campo desconhecido (typo ou token colado no lugar errado vira erro, não é ignorado). */
const obj = <T extends z.ZodRawShape>(shape: T) => z.object(shape).strict();
const email = z.string().email().max(120);
const dinheiro = z.number().positive().max(100000);

/**
 * Subdomínios que NENHUMA clínica pode pegar: são do nosso próprio sistema (o formulário, o agente, o Chatwoot, os painéis…) ou nomes que enganam. «demo» é só da Clínica Demonstração
 * (`whatsapp.modo: demonstracao`). O DNS curinga já aponta tudo para a VPS: uma clínica com «cadastro» ou «atendimento» tomaria o lugar do serviço de verdade.
 */
export const SUBDOMINIOS_RESERVADOS: readonly string[] = [
  'cadastro', 'atendimento', 'agente', 'agentevps', 'automacao', 'franquia', 'suporte', 'api', 'app', 'www', 'mail', 'smtp', 'admin', 'painel', 'dashboard', 'chatwoot', 'kommo', 'crm',
  'vps', 'ddagent', 'doutordigital', 'portal', 'status', 'docs', 'mcp', 'login', 'oauth', 'auth', 'webhook', 'webhooks', 'ftp', 'ns1', 'ns2', 'aulas', 'demo',
];

export const Questionario = z
  .object({
    versao: z.literal(1),
    unidade: obj({
      nome: z.string().min(5).max(80),
      slug: z.string().regex(/^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$/, 'kebab-case, 3 a 50 caracteres'),
      cidade: z.string().min(2).max(60),
      uf: z.string().regex(/^[A-Z]{2}$/),
      endereco: z.string().min(10).max(200),
      mapa_url: z.string().regex(/^https:\/\/\S+$/, 'link https do "Como chegar"'),
      telefone: z.string().regex(/^[\d\s()+-]{8,20}$/).optional(),
      fuso: z.string().default('America/Belem'),
    }),
    horarios: obj({
      /** 0 = domingo … 6 = sábado */
      dias: z.array(z.number().int().min(0).max(6)).min(1).max(7),
      inicio: hora,
      fim: hora,
      almoco_inicio: hora.optional(),
      almoco_fim: hora.optional(),
      duracao_min: z.number().int().min(10).max(120).default(30),
    }),
    profissionais: z
      .array(
        obj({
          nome: z.string().min(3).max(80),
          funcao: z.enum(['medico', 'fisioterapeuta']),
          /** id da pessoa na franquia (idStaff); sem ele a franquia escolhe a primeira da lista */
          franquia_staff_id: z.number().int().positive().optional(),
        }),
      )
      .min(1),
    valores: obj({
      consulta_no_dia: dinheiro,
      /** valor com pagamento antecipado (ou com sinal, quando há sinal) */
      consulta_antecipada: dinheiro.optional(),
      /** sinal por Pix gerado pela Sofia (Asaas da unidade); sem isto a unidade segue "antecipado ou no dia" */
      sinal_pix: dinheiro.optional(),
      aceita_antecipado: z.boolean().default(true),
      chave_pix: z.string().min(5).max(120).optional(),
      favorecido: z.string().min(3).max(120).optional(),
    }),
    whatsapp: obj({
      /** `real`: a clínica tem número e WABA. `demonstracao`: clínica de vitrine SEM número nem WABA — a caixa é do tipo API, os modelos da Meta ficam em SECO (nada vai à Meta) */
      modo: z.enum(['real', 'demonstracao']).default('real'),
      /** obrigatório no modo real */
      numero_oficial: z.string().regex(/^\+\d{12,14}$/, 'formato +5594984420153').optional(),
      /** phone_number_id do número no Kapso (obrigatório no modo real) */
      kapso_phone_number_id: digitos().optional(),
      /** obrigatório no modo real */
      waba_id: digitos().optional(),
      /** prefixo dos modelos na Meta, com "_" no fim */
      prefixo_modelos: z.string().regex(/^[a-z][a-z0-9]{1,15}_$/, 'minúsculas/dígitos e "_" no fim (ex.: parau_)'),
      conexao: z.enum(['coexistencia', 'numero-novo']),
    }),
    chatwoot: obj({
      /** subdomínio próprio: <subdominio>.doutordigitalconsultoria.com */
      subdominio: z.string().regex(/^[a-z0-9]{3,40}$/, 'minúsculas e dígitos, sem hífen'),
      caixa_nome: z.string().min(5).max(80),
      time_nome: z.string().min(3).max(60),
      meta_agendamentos_dia: z.number().int().min(1).max(100).default(5),
      atendentes: z
        .array(
          obj({
            nome: z.string().min(3).max(80),
            email,
            funcao: z.enum(['gerente', 'secretaria', 'sdr', 'observador']),
          }),
        )
        .min(1),
      /** administradores da Doutor Digital que entram na conta nova (e-mails de usuários que JÁ existem na conta de referência); sem isto vale KIT_ADMINS_DD ou o padrão */
      admins_dd: z.array(email).max(10).optional(),
      /** e-mail do usuário "📱 Celular da unidade" (autor do que a equipe manda pelo aparelho); sem ele a unidade não tem esse usuário */
      usuario_celular_email: email.optional(),
    }),
    franquia: obj({
      /** id_company no seletor de unidade da franquia (app.doutorhernia.com.br) */
      id_company: z.number().int().positive(),
      /** NOME da variável com o token da API da franquia (Spine) */
      token_env: nomeDeVariavel,
    }),
    meta: obj({
      ad_account: z.string().regex(/^act_\d{5,25}$/, 'act_ e os dígitos'),
      business_manager_id: digitos(),
      /** NOMES das variáveis: META_ADS_TOKEN_<SUFIXO>, META_ADS_CONTA_<SUFIXO> e META_DATASET_ID_<SUFIXO> (mesmo sufixo) */
      token_env: nomeDeVariavel,
      conta_env: nomeDeVariavel,
      dataset_id_env: nomeDeVariavel,
    }),
    sofia: z
      .object({
        nome_ia: z.string().min(2).max(30).default('Sofia'),
        tom: z.enum(['casual', 'formal', 'friendly']).default('friendly'),
      })
      .default({}),
    /**
     * A assistente virtual (a Sofia) como a clínica quer. AUSENTE = como sempre foi (Sofia configurada com o padrão da rede). `quer: false` = a clínica NÃO quer a IA: a Sofia não é
     * configurada e o plano diz isso. O texto da clínica é DADO: vira informação nas fontes ou «aprendizado» (abaixo das regras da rede, que sempre vencem); nunca muda preço nem destrava regra.
     */
    assistente: obj({
      quer: z.boolean().default(true),
      emoji: z.enum(['sim', 'pouco', 'nao']).default('pouco'),
      quando_atende: z.enum(['sempre', 'fora-expediente', 'noite-fim-semana', 'personalizado']).default('sempre'),
      quando_atende_detalhe: z.string().max(200).optional(),
      /** como a clínica quer ser apresentada (vira aprendizado) */
      saudacao: z.string().max(300).optional(),
      diferenciais: z.string().max(500).optional(),
      primeira_consulta: obj({ como_funciona: z.string().max(500).optional(), duracao: z.string().max(100).optional(), o_que_levar: z.string().max(300).optional(), chegada: z.string().max(100).optional() }).optional(),
      pagamento: obj({ formas: z.string().max(300).optional(), parcelamento: z.string().max(300).optional(), convenio: z.enum(['nao', 'sim', 'reembolso']).optional(), convenio_quais: z.string().max(200).optional(), remarcacao: z.string().max(400).optional() }).optional(),
      nao_atende: z.string().max(400).optional(),
      /** só as objeções que a clínica MUDOU ou criou (as que ficaram iguais já estão no roteiro da rede); cada uma vira um aprendizado */
      objecoes: z.array(obj({ gatilho: z.string().min(3).max(80), resposta: z.string().min(10).max(230) })).max(14).optional(),
      nunca_extra: z.string().max(300).optional(),
      passar_extra: z.string().max(300).optional(),
      /** quem recebe o atendimento quando a Sofia chama uma pessoa; contato só da equipe (e-mail ou telefone), nunca senha */
      quem_recebe: obj({ nome: z.string().max(80).optional(), contato: z.string().max(80).optional() }).optional(),
      faq: z.array(obj({ pergunta: z.string().min(5).max(120), resposta: z.string().min(3).max(300) })).max(10).optional(),
    }).optional(),
  })
  .strict()
  .superRefine((q, ctx) => {
    const aviso = (path: (string | number)[], message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, path, message });
    const gerentes = q.chatwoot.atendentes.filter((a) => a.funcao === 'gerente');
    if (gerentes.length !== 1) aviso(['chatwoot', 'atendentes'], `precisa haver exatamente 1 gerente (há ${gerentes.length})`);
    const emails = q.chatwoot.atendentes.map((a) => a.email.toLowerCase());
    if (new Set(emails).size !== emails.length) aviso(['chatwoot', 'atendentes'], 'e-mail repetido');
    if (q.chatwoot.usuario_celular_email && emails.includes(q.chatwoot.usuario_celular_email.toLowerCase())) aviso(['chatwoot', 'usuario_celular_email'], 'o usuário do celular não pode ser uma atendente');
    if (q.horarios.fim <= q.horarios.inicio) aviso(['horarios', 'fim'], 'o fim tem de ser depois do início');
    if (!!q.horarios.almoco_inicio !== !!q.horarios.almoco_fim) aviso(['horarios', 'almoco_inicio'], 'informe o início e o fim do almoço, ou nenhum');
    if (q.valores.consulta_antecipada !== undefined && q.valores.consulta_antecipada >= q.valores.consulta_no_dia) aviso(['valores', 'consulta_antecipada'], 'o valor antecipado tem de ser menor que o do dia');
    if (q.valores.sinal_pix !== undefined) {
      if (q.valores.consulta_antecipada === undefined) aviso(['valores', 'sinal_pix'], 'sinal exige o valor antecipado (é o valor "garantindo com sinal")');
      else if (q.valores.sinal_pix >= q.valores.consulta_antecipada) aviso(['valores', 'sinal_pix'], 'o sinal tem de ser menor que o valor antecipado');
      if (!q.valores.aceita_antecipado) aviso(['valores', 'sinal_pix'], 'sinal não combina com aceita_antecipado: false');
    }
    if (q.valores.aceita_antecipado && q.valores.consulta_antecipada === undefined) aviso(['valores', 'consulta_antecipada'], 'a unidade aceita antecipado: informe o valor antecipado (ou aceita_antecipado: false)');
    if (!q.valores.aceita_antecipado && q.valores.consulta_antecipada !== undefined) aviso(['valores', 'consulta_antecipada'], 'aceita_antecipado é false, mas há valor antecipado');
    const suf = (v: string, prefixo: string) => (v.startsWith(prefixo) ? v.slice(prefixo.length) : null);
    const sufixo = suf(q.meta.token_env, 'META_ADS_TOKEN_');
    if (!sufixo) aviso(['meta', 'token_env'], 'precisa ser META_ADS_TOKEN_<SUFIXO> (é o nome que o rastreio e a CAPI já leem)');
    else {
      if (suf(q.meta.conta_env, 'META_ADS_CONTA_') !== sufixo) aviso(['meta', 'conta_env'], `precisa ser META_ADS_CONTA_${sufixo}`);
      if (suf(q.meta.dataset_id_env, 'META_DATASET_ID_') !== sufixo) aviso(['meta', 'dataset_id_env'], `precisa ser META_DATASET_ID_${sufixo}`);
    }
    if (q.unidade.slug.includes('--')) aviso(['unidade', 'slug'], 'slug com "--"');
    if (SUBDOMINIOS_RESERVADOS.includes(q.chatwoot.subdominio) && !(q.chatwoot.subdominio === 'demo' && q.whatsapp.modo === 'demonstracao')) aviso(['chatwoot', 'subdominio'], `«${q.chatwoot.subdominio}» é um subdomínio reservado do nosso sistema: escolha outro`);
    if (q.whatsapp.modo === 'real') {
      for (const campo of ['numero_oficial', 'kapso_phone_number_id', 'waba_id'] as const) if (!q.whatsapp[campo]) aviso(['whatsapp', campo], 'obrigatório quando a clínica tem número de verdade (modo: real); a demonstração não precisa');
    } else if (q.whatsapp.numero_oficial || q.whatsapp.kapso_phone_number_id || q.whatsapp.waba_id) {
      aviso(['whatsapp', 'modo'], 'modo demonstracao não tem número nem WABA: tire os campos (ou passe para modo: real)');
    }
  });

export type Questionario = z.infer<typeof Questionario>;

/** Campos PESSOAIS, financeiros ou de identidade: o plano os mostra mascarados. Caminho com "[]" para listas. */
export const CAMPOS_SENSIVEIS: Readonly<Record<string, string>> = {
  'unidade.telefone': 'telefone da clínica',
  'valores.chave_pix': 'chave Pix (financeiro)',
  'valores.favorecido': 'favorecido do Pix (financeiro)',
  'whatsapp.numero_oficial': 'número do WhatsApp oficial',
  'whatsapp.kapso_phone_number_id': 'identificador do número no Kapso',
  'whatsapp.waba_id': 'identificador da conta do WhatsApp Business',
  'chatwoot.atendentes[].email': 'e-mail pessoal da atendente (LGPD)',
  'chatwoot.usuario_celular_email': 'e-mail de acesso',
  'assistente.quem_recebe.contato': 'contato de quem recebe o atendimento (e-mail ou telefone da equipe)',
  'chatwoot.admins_dd': 'e-mails de administradores da Doutor Digital',
  'franquia.id_company': 'identificador da unidade na franquia',
  'meta.ad_account': 'conta de anúncios',
  'meta.business_manager_id': 'Business Manager',
};

/**
 * Campos IMPORTANTES: decisão da franquia que vira texto dito ao paciente. Não são mascarados (quem aprova precisa conferir), mas o
 * relatório os lista para o dono da unidade confirmar antes de ligar qualquer coisa.
 */
export const CAMPOS_IMPORTANTES: Readonly<Record<string, string>> = {
  'unidade.endereco': 'vai no texto dos modelos aprovados na Meta (trocar depois exige novo modelo)',
  'unidade.mapa_url': 'vai no texto dos modelos aprovados na Meta',
  'valores.consulta_no_dia': 'a Sofia fala este preço ao paciente',
  'valores.consulta_antecipada': 'a Sofia fala este preço ao paciente',
  'valores.sinal_pix': 'a Sofia gera um Pix deste valor',
  'horarios.dias': 'a Sofia só oferece horário dentro disto',
  'horarios.inicio': 'a Sofia só oferece horário dentro disto',
  'horarios.fim': 'a Sofia só oferece horário dentro disto',
  'profissionais[].nome': 'a Sofia cita o nome',
};

/** Segredo NÃO tem campo: estes são os NOMES das variáveis onde o valor mora (env do serviço / arquivo de segredos da VPS). */
export const VARIAVEIS_DE_SEGREDO: readonly string[] = ['franquia.token_env', 'meta.token_env', 'meta.conta_env', 'meta.dataset_id_env'];

/** Todos os caminhos de campo do esquema (folhas), com "[]" nas listas. Serve ao teste de deriva do JSON Schema. */
export function caminhosDoEsquema(esquema: z.ZodTypeAny = Questionario, prefixo = ''): string[] {
  let s: z.ZodTypeAny = esquema;
  for (;;) {
    if (s instanceof z.ZodEffects) s = s.innerType();
    else if (s instanceof z.ZodOptional || s instanceof z.ZodNullable) s = s.unwrap();
    else if (s instanceof z.ZodDefault) s = s.removeDefault();
    else break;
  }
  if (s instanceof z.ZodObject) {
    const shape = s.shape as Record<string, z.ZodTypeAny>;
    return Object.entries(shape).flatMap(([k, v]) => caminhosDoEsquema(v, prefixo ? `${prefixo}.${k}` : k));
  }
  if (s instanceof z.ZodArray) {
    let el = s.element as z.ZodTypeAny;
    while (el instanceof z.ZodOptional || el instanceof z.ZodDefault) el = el instanceof z.ZodOptional ? el.unwrap() : el.removeDefault();
    return el instanceof z.ZodObject ? caminhosDoEsquema(el, `${prefixo}[]`) : [prefixo];
  }
  return prefixo ? [prefixo] : [];
}

export type ResultadoDaLeitura = { ok: true; q: Questionario } | { ok: false; erros: string[] };

export function validarQuestionario(bruto: unknown): ResultadoDaLeitura {
  const r = Questionario.safeParse(bruto);
  if (r.success) return { ok: true, q: r.data };
  return { ok: false, erros: r.error.issues.map((i) => `${i.path.join('.') || '(raiz)'}: ${i.message}`) };
}

export function lerQuestionario(fonte: string): ResultadoDaLeitura {
  let bruto: unknown;
  try {
    bruto = lerYamlOuJson(fonte);
  } catch (err) {
    return { ok: false, erros: [`não consegui ler o arquivo: ${(err as Error).message}`] };
  }
  return validarQuestionario(bruto);
}

// ── derivados ────────────────────────────────────────────────────────────────────────────────────

export const sufixoDoQuestionario = (q: Questionario): string => q.meta.token_env.slice('META_ADS_TOKEN_'.length);

const brl = (v: number) => `R$ ${Number.isInteger(v) ? String(v) : v.toFixed(2).replace('.', ',')}`;

/** A configuração do CRM que vai para `unit_chatwoot` (sem caixas: elas só existem depois que a caixa é criada no Chatwoot). */
export function configChatwootDoQuestionario(q: Questionario, extras: { gerenteId?: number | null; usuarioCelularId?: number | null; caixas?: ConfigChatwootUnidade['caixas']; contaId?: number | null } = {}): ConfigChatwootUnidade {
  return {
    slug: q.unidade.slug,
    contaId: extras.contaId ?? null,
    subdominio: q.chatwoot.subdominio,
    prefixoModelos: q.whatsapp.prefixo_modelos,
    usuarioCelularId: extras.usuarioCelularId ?? null,
    gerenteId: extras.gerenteId ?? null,
    metaAgendamentosDia: q.chatwoot.meta_agendamentos_dia,
    kapsoPhoneNumberId: q.whatsapp.kapso_phone_number_id ?? null,
    wabaId: q.whatsapp.waba_id ?? null,
    envSufixo: sufixoDoQuestionario(q),
    dadosModelos: {
      nome: q.unidade.nome,
      cidade: q.unidade.cidade,
      endereco: q.unidade.endereco,
      mapa: q.unidade.mapa_url,
      ...(q.unidade.telefone ? { telefone: q.unidade.telefone } : {}),
      valorConsulta: brl(q.valores.consulta_no_dia),
      ...(q.valores.consulta_antecipada !== undefined ? { valorComSinal: brl(q.valores.consulta_antecipada) } : {}),
    },
    caixas: extras.caixas ?? [],
  };
}

/** `a.b[].c` → valor(es) no objeto, para a máscara. */
export function mascarar(valor: unknown, motivo: string): string {
  const s = String(valor);
  if (/mail/.test(motivo) || s.includes('@')) {
    const [u, d] = s.split('@');
    return `${u!.slice(0, 1)}***@${d ?? '***'}`;
  }
  if (/^[A-Z][A-Z0-9_]+$/.test(s)) return s; // nome de variável não é segredo
  if (s.length <= 4) return '***';
  return `${s.slice(0, 2)}***${s.slice(-2)}`;
}

/** Mascara SÓ o que é e-mail (o resto da lista — um aviso, um nome de variável — passa como está). Para tudo que o plano/relatório imprime. */
export const mascararEmails = (lista: readonly string[]): string[] => lista.map((v) => (v.includes('@') ? mascarar(v, 'e-mail') : v));
/** Mascara um valor sensível que NÃO é e-mail (número, identificador); ausente vira «—». */
export const mascararCampo = (valor: unknown): string => (valor === undefined || valor === null || valor === '' ? '—' : mascarar(valor, 'campo'));

/** Cópia do questionário com os campos sensíveis mascarados, para imprimir. */
export function questionarioMascarado(q: Questionario): unknown {
  const copia = JSON.parse(JSON.stringify(q)) as Record<string, any>;
  for (const [caminho, motivo] of Object.entries(CAMPOS_SENSIVEIS)) {
    const partes = caminho.split('.');
    const descer = (obj: any, i: number): void => {
      if (obj === undefined || obj === null) return;
      const p = partes[i]!;
      const lista = p.endsWith('[]');
      const chave = lista ? p.slice(0, -2) : p;
      if (i === partes.length - 1) {
        if (lista) return;
        if (Array.isArray(obj[chave])) obj[chave] = (obj[chave] as unknown[]).map((v) => mascarar(v, motivo));
        else if (obj[chave] !== undefined) obj[chave] = mascarar(obj[chave], motivo);
        return;
      }
      const filho = obj[chave];
      if (lista && Array.isArray(filho)) for (const x of filho) descer(x, i + 1);
      else descer(filho, i + 1);
    };
    descer(copia, 0);
  }
  return copia;
}

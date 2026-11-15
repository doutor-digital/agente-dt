/**
 * O PLANO da unidade nova: dado o questionário (já validado) e o que JÁ existe, diz o que o script criaria ou alteraria em cada
 * sistema, na ordem certa. Função PURA (sem rede nem banco): o seco imprime este plano; o `--aplicar` percorre os mesmos passos.
 * Idempotente por construção — cada passo olha o estado atual e responde `nada` quando já está como deveria.
 *
 * Estado desconhecido (`undefined` na parte do estado) NUNCA vira "já existe": o passo aparece como `criar` com a ressalva
 * "estado atual não consultado". Seco sem consultar nada é um plano do que faria numa conta vazia.
 */
import { AUTOMACOES } from '../automacoes.js';
import { comDadosDaUnidade, modelosDaUnidade } from '../chatwoot-modelos.js';
import { problemasDaConfig, type ConfigChatwootUnidade } from '../chatwoot-unidades.js';
import {
  ATRIBUTOS_DE_CONTATO,
  ATRIBUTOS_DE_CONVERSA,
  AUTOMACOES_DA_CONTA,
  DOMINIO_DOS_CRMS,
  ETIQUETAS_DO_CODIGO,
  MENSAGENS_PRONTAS,
  PASTAS_PADRAO,
  SERVICO_DO_PROXY,
} from './catalogo.js';
import { camposDaSofia, camposDaUnidade } from './molde-sofia.js';
import { configChatwootDoQuestionario, type Questionario } from './questionario.js';

export type Sistema = 'banco' | 'chatwoot' | 'meta' | 'vps' | 'sofia';
export type Acao = 'criar' | 'alterar' | 'nada' | 'manual' | 'bloqueado';

export interface Passo {
  id: string;
  sistema: Sistema;
  titulo: string;
  acao: Acao;
  /** o que o passo faz, em linhas curtas (sem segredo) */
  itens: string[];
  /** `sim`: o `--aplicar` executa; `esqueleto`: depende de API externa ainda não ligada (Fase 2) — o plano mostra o que faria, a execução para */
  execucao: 'sim' | 'esqueleto' | 'manual';
  /** ressalvas que o dono precisa ver */
  avisos: string[];
  /** ids dos passos que precisam ter dado certo antes */
  depende: string[];
}

/** O que já existe. Cada parte `undefined` = não consultado. */
export interface EstadoAtual {
  banco?: {
    unidade: { id: string; campos: Record<string, unknown> } | null;
    /** a configuração do CRM gravada (sem as caixas), ou null */
    configChatwoot: { prefixoModelos: string; metaAgendamentosDia: number | null; kapsoPhoneNumberId: string | null; wabaId: string | null; envSufixo: string; dadosModelos: Record<string, unknown> } | null;
    caixasRegistradas: number[];
    /** id da automação → estado gravado para esta unidade */
    automacoes: Record<string, string>;
    /** campos de persona/fontes/prompt da unidade hoje */
    sofia: Record<string, unknown>;
  };
  chatwoot?: {
    etiquetas: string[];
    atributosConversa: string[];
    atributosContato: string[];
    caixas: Array<{ id: number; nome: string; robo?: boolean }>;
    times: string[];
    /** e-mail (minúsculo) → agente */
    agentes: Record<string, { id: number; nome: string }>;
    /** e-mail da atendente → nomes das pastas que ela já tem */
    pastas: Record<string, string[]>;
    mensagensProntas: string[];
    automacoesDaConta: number;
  };
  kapso?: { modelos: Record<string, string> };
  meta?: { datasetCapi: boolean };
  vps?: { hostNoProxy: boolean };
  /** nomes de variável de ambiente → presente? (nunca o valor) */
  segredos?: Record<string, boolean>;
}

export interface Plano {
  unidade: string;
  config: ConfigChatwootUnidade;
  passos: Passo[];
  /** o que falta para a unidade funcionar, em ordem de quem faz */
  relatorio: string[];
}

/** O que `unit_chatwoot` guarda (sem as caixas, o gerente e o usuário do celular, que só existem depois do convite). */
export const configGravavel = (c: ConfigChatwootUnidade) => ({ prefixoModelos: c.prefixoModelos, metaAgendamentosDia: c.metaAgendamentosDia, kapsoPhoneNumberId: c.kapsoPhoneNumberId, wabaId: c.wabaId, envSufixo: c.envSufixo, dadosModelos: { ...c.dadosModelos } });

/** JSON com as chaves em ordem (o jsonb do Postgres devolve as chaves em outra ordem que a gravada). */
export function canonico(v: unknown): string {
  const ordenar = (x: unknown): unknown => (Array.isArray(x) ? x.map(ordenar) : x && typeof x === 'object' ? Object.fromEntries(Object.entries(x as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, y]) => [k, ordenar(y)])) : x);
  return JSON.stringify(ordenar(v));
}

const NAO_CONSULTADO = 'estado atual não consultado — assumindo que não existe';
const lc = (s: string) => s.toLowerCase();
const faltantes = (precisa: readonly string[], tem: readonly string[]) => precisa.filter((x) => !tem.includes(x));

export interface OpcoesDoPlano {
  /** texto do molde da Sofia (ops/kit-unidade/molde-sofia/bloco-conversa.md); null = não achei o arquivo */
  molde: string | null;
}

export function montarPlano(q: Questionario, estado: EstadoAtual, opcoes: OpcoesDoPlano): Plano {
  const slug = q.unidade.slug;
  const config = configChatwootDoQuestionario(q);
  const passos: Passo[] = [];
  const add = (p: Omit<Passo, 'avisos' | 'depende'> & { avisos?: string[]; depende?: string[] }) => passos.push({ avisos: [], depende: [], ...p });
  const b = estado.banco;
  const cw = estado.chatwoot;

  // ── 1. BANCO: a unidade, a configuração do CRM e as automações em seco ──────────────────────────
  const campos = camposDaUnidade(q);
  const hoje = b?.unidade?.campos ?? {};
  const mudou = Object.keys(campos).filter((k) => canonico((hoje as Record<string, unknown>)[k] ?? null) !== canonico(campos[k] ?? null));
  add({
    id: 'unidade',
    sistema: 'banco',
    titulo: `Unidade «${q.unidade.nome}» em units (identidade, agenda, pagamento — sem segredo)`,
    acao: !b ? 'criar' : !b.unidade ? 'criar' : mudou.length ? 'alterar' : 'nada',
    itens: !b?.unidade ? [`slug ${slug}`, `${Object.keys(campos).length} campos: ${Object.keys(campos).join(', ')}`, 'nasce INATIVA (isActive=false) até a equipe confirmar'] : mudou.length ? [`campos que mudam: ${mudou.join(', ')}`] : ['já está como o questionário'],
    execucao: 'sim',
    avisos: b ? [] : [NAO_CONSULTADO],
  });
  const problemasCfg = problemasDaConfig({ ...config, caixas: [{ id: 1, tipo: 'cloud' }] });
  add({
    id: 'config-chatwoot',
    sistema: 'banco',
    titulo: 'Configuração do CRM da unidade (unit_chatwoot): prefixo dos modelos, gerente, usuário do celular, número do Kapso, WABA, sufixo da Meta, dados dos modelos',
    acao: !b ? 'criar' : !b.configChatwoot ? 'criar' : canonico(configGravavel(config)) === canonico(b.configChatwoot) ? 'nada' : 'alterar',
    itens: [
      `prefixo dos modelos ${config.prefixoModelos}`,
      `sufixo das variáveis da Meta ${config.envSufixo}`,
      `meta de agendamentos por dia ${config.metaAgendamentosDia}`,
      'gerente e usuário do celular: o id do Chatwoot só existe depois do convite — gravados no passo «registrar-caixa»',
    ],
    execucao: 'sim',
    avisos: [...(b ? [] : [NAO_CONSULTADO]), ...problemasCfg.map((p) => `configuração inválida: ${p}`)],
    depende: ['unidade'],
  });
  const chatwootAutomacoes = AUTOMACOES.filter((a) => a.id.startsWith('chatwoot-') && a.temSeco);
  const semLinha = chatwootAutomacoes.filter((a) => !b?.automacoes[a.id]);
  add({
    id: 'automacoes-seco',
    sistema: 'banco',
    titulo: `Automações do Chatwoot em SECO (${chatwootAutomacoes.length}): decidem e anotam, não escrevem em ninguém`,
    acao: !b ? 'criar' : semLinha.length ? 'criar' : 'nada',
    itens: [...(semLinha.length ? semLinha.map((a) => `${a.id} → seco`) : ['todas já têm estado gravado (não mexo no que a equipe já decidiu)'])],
    execucao: 'sim',
    avisos: [...(b ? [] : [NAO_CONSULTADO]), 'só entra em seco quem NÃO tem linha: linha existente (ligado/seco/desligado) nunca é trocada'],
    depende: ['unidade'],
  });

  // ── 2. CHATWOOT: estrutura da conta, caixa, time, atendentes, pastas, mensagens ─────────────────
  const etFalta = cw ? faltantes(ETIQUETAS_DO_CODIGO, cw.etiquetas) : [...ETIQUETAS_DO_CODIGO];
  add({
    id: 'etiquetas',
    sistema: 'chatwoot',
    titulo: 'Etiquetas da conta que o código usa (a conta é uma só: já existem desde Parauapebas)',
    acao: etFalta.length ? 'criar' : 'nada',
    itens: etFalta.length ? [`${etFalta.length} etiqueta(s): ${etFalta.join(', ')}`] : [`as ${ETIQUETAS_DO_CODIGO.length} já existem`],
    execucao: 'esqueleto',
    avisos: cw ? [] : [NAO_CONSULTADO],
  });
  const atFalta = cw ? faltantes(ATRIBUTOS_DE_CONVERSA, cw.atributosConversa) : [...ATRIBUTOS_DE_CONVERSA];
  const atcFalta = cw ? faltantes(ATRIBUTOS_DE_CONTATO, cw.atributosContato) : [...ATRIBUTOS_DE_CONTATO];
  add({
    id: 'atributos',
    sistema: 'chatwoot',
    titulo: 'Atributos de conversa e de contato que a régua, a agenda e a Sofia leem',
    acao: atFalta.length || atcFalta.length ? 'criar' : 'nada',
    itens: atFalta.length || atcFalta.length ? [...(atFalta.length ? [`${atFalta.length} de conversa: ${atFalta.join(', ')}`] : []), ...(atcFalta.length ? [`${atcFalta.length} de contato: ${atcFalta.join(', ')}`] : [])] : [`os ${ATRIBUTOS_DE_CONVERSA.length + ATRIBUTOS_DE_CONTATO.length} já existem`],
    execucao: 'esqueleto',
    avisos: cw ? [] : [NAO_CONSULTADO],
  });
  add({
    id: 'automacoes-conta',
    sistema: 'chatwoot',
    titulo: 'Automações da conta (as 8 de Parauapebas valem para todas as caixas)',
    acao: cw && cw.automacoesDaConta >= AUTOMACOES_DA_CONTA.length ? 'nada' : cw ? 'manual' : 'manual',
    itens: AUTOMACOES_DA_CONTA.map((a) => a),
    execucao: 'manual',
    avisos: [cw ? `a conta tem ${cw.automacoesDaConta} automação(ões)` : NAO_CONSULTADO, 'só conferir: a definição completa está nas automações 1–8 da conta; o script não as recria'],
  });
  const caixaExiste = cw?.caixas.find((c) => c.nome === q.chatwoot.caixa_nome);
  add({
    id: 'caixa',
    sistema: 'chatwoot',
    titulo: `Caixa «${q.chatwoot.caixa_nome}» — WhatsApp Cloud pelo Kapso`,
    acao: !cw ? 'criar' : caixaExiste ? 'nada' : 'criar',
    itens: caixaExiste ? [`caixa ${caixaExiste.id} já existe`] : [`canal whatsapp_cloud, número ${q.whatsapp.numero_oficial}`, `phone_number_id ${q.whatsapp.kapso_phone_number_id} e WABA ${q.whatsapp.waba_id} (Kapso)`, 'chave do Kapso: KAPSO_API_KEY do ambiente (nunca impressa)'],
    execucao: 'esqueleto',
    avisos: cw ? [] : [NAO_CONSULTADO],
    depende: ['config-chatwoot'],
  });
  const timeExiste = cw?.times.includes(q.chatwoot.time_nome);
  add({
    id: 'time',
    sistema: 'chatwoot',
    titulo: `Time «${q.chatwoot.time_nome}»`,
    acao: !cw ? 'criar' : timeExiste ? 'nada' : 'criar',
    itens: timeExiste ? ['já existe'] : [`time ${q.chatwoot.time_nome}`],
    execucao: 'esqueleto',
    avisos: cw ? [] : [NAO_CONSULTADO],
  });
  const novos = q.chatwoot.atendentes.filter((a) => !cw?.agentes[lc(a.email)]);
  add({
    id: 'atendentes',
    sistema: 'chatwoot',
    titulo: `Atendentes: convite, caixa e time (${q.chatwoot.atendentes.length})`,
    acao: !cw ? 'criar' : novos.length ? 'criar' : 'nada',
    itens: q.chatwoot.atendentes.map((a) => `${a.nome} (${a.funcao}) — ${cw?.agentes[lc(a.email)] ? 'já é agente' : 'convite por e-mail'}; entra na caixa e no time`),
    execucao: 'esqueleto',
    avisos: [...(cw ? [] : [NAO_CONSULTADO]), 'o convite sai por e-mail: sem SMTP configurado no Chatwoot a atendente não recebe (ver relatório)'],
    depende: ['caixa', 'time'],
  });
  if (q.chatwoot.usuario_celular_email) {
    add({
      id: 'usuario-celular',
      sistema: 'chatwoot',
      titulo: 'Usuário «📱 Celular da unidade» (autor do que a equipe manda pelo aparelho)',
      acao: cw?.agentes[lc(q.chatwoot.usuario_celular_email)] ? 'nada' : 'criar',
      itens: ['agente com o nome «📱 Celular da unidade», na caixa'],
      execucao: 'esqueleto',
      avisos: cw ? [] : [NAO_CONSULTADO],
      depende: ['caixa'],
    });
  }
  add({
    id: 'registrar-caixa',
    sistema: 'banco',
    titulo: 'Registrar no banco a caixa criada (unit_chatwoot_caixa) e gravar gerente e usuário do celular na configuração',
    acao: b && caixaExiste && b.caixasRegistradas.includes(caixaExiste.id) ? 'nada' : 'criar',
    itens: ['caixa tipo cloud', 'gerente = a atendente com função «gerente»', ...(q.chatwoot.usuario_celular_email ? ['usuário do celular'] : [])],
    execucao: 'esqueleto',
    avisos: ['só depois deste passo a configuração passa a valer: antes, o código ignora a unidade (config sem caixa é inválida) e nada dispara'],
    depende: ['config-chatwoot', 'caixa', 'atendentes'],
  });
  const faltaPasta = q.chatwoot.atendentes.flatMap((a) => faltantes(PASTAS_PADRAO, cw?.pastas[lc(a.email)] ?? []).map((p) => `${a.nome}: ${p}`));
  add({
    id: 'pastas',
    sistema: 'chatwoot',
    titulo: `Pastas padrão por atendente (${PASTAS_PADRAO.length} cada)`,
    acao: faltaPasta.length ? 'criar' : 'nada',
    itens: faltaPasta.length ? [`${faltaPasta.length} pasta(s) a criar (${PASTAS_PADRAO.join(', ')})`] : ['todas já existem'],
    execucao: 'esqueleto',
    avisos: [...(cw ? [] : [NAO_CONSULTADO]), 'a pasta é da pessoa: só dá para criar depois que ela aceitar o convite e existir como agente'],
    depende: ['atendentes'],
  });
  const prontas = MENSAGENS_PRONTAS.map((m) => ({ cod: `${q.whatsapp.prefixo_modelos.replace(/_$/, '')}-${m.codigo}`, ...comDadosDaUnidade(m.texto, config.dadosModelos) }));
  const prontasFalta = prontas.filter((m) => !cw?.mensagensProntas.includes(m.cod));
  add({
    id: 'mensagens-prontas',
    sistema: 'chatwoot',
    titulo: 'Mensagens prontas da unidade (endereço, chegada)',
    acao: prontasFalta.length ? 'criar' : 'nada',
    itens: prontas.map((m) => `/${m.cod}${m.faltando.length ? ` (FALTA ${m.faltando.join(', ')})` : ''}`),
    execucao: 'esqueleto',
    avisos: cw ? [] : [NAO_CONSULTADO],
  });
  // ── 3. META / KAPSO: número, modelos, CAPI ──────────────────────────────────────────────────────
  add({
    id: 'numero',
    sistema: 'meta',
    titulo: `Número ${q.whatsapp.numero_oficial} conectado ao Kapso (${q.whatsapp.conexao === 'coexistencia' ? 'coexistência: o número segue no celular' : 'número novo'})`,
    acao: 'manual',
    itens: [q.whatsapp.conexao === 'coexistencia' ? 'quem tem o celular da unidade lê o QR/aceita a coexistência no app do WhatsApp Business' : 'verificar o número na Meta (código por SMS/ligação)'],
    execucao: 'manual',
    avisos: ['depende de gente com o celular na mão e de aprovação da Meta; o script não consegue fazer'],
  });
  const { modelos, faltando: faltaDado } = modelosDaUnidade(config.dadosModelos, config.prefixoModelos);
  const jaNaMeta = (m: string) => estado.kapso?.modelos[m];
  const aEnviar = modelos.filter((m) => !jaNaMeta(m.meta.name));
  const comProblema = modelos.filter((m) => m.problemas.length);
  const inferidos = modelos.filter((m) => m.inferido).map((m) => m.meta.name);
  add({
    id: 'modelos',
    sistema: 'meta',
    titulo: `Modelos do WhatsApp na Meta (${modelos.length} da régua, gerados dos textos-base com os dados da unidade)`,
    acao: aEnviar.length ? 'criar' : 'nada',
    itens: aEnviar.length
      ? [`${aEnviar.length} a enviar: ${aEnviar.map((m) => m.meta.name).slice(0, 4).join(', ')}${aEnviar.length > 4 ? '…' : ''}`, `categoria: ${modelos.filter((m) => m.meta.category === 'UTILITY').length} utilidade, ${modelos.filter((m) => m.meta.category === 'MARKETING').length} marketing (com «responda SAIR»)`]
      : ['todos já estão na Meta'],
    execucao: 'esqueleto',
    avisos: [
      ...(estado.kapso ? [] : [NAO_CONSULTADO]),
      ...(Object.keys(faltaDado).length ? [`dado da unidade faltando nos textos: ${Object.entries(faltaDado).map(([m, f]) => `${m}: ${f.join(',')}`).join('; ')}`] : []),
      ...(comProblema.length ? [`a Meta recusaria: ${comProblema.map((m) => `${m.meta.name} (${m.problemas.join('; ')})`).join(' | ')}`] : []),
      ...(inferidos.length ? [`${inferidos.length} modelo(s) com categoria/botões NÃO conferidos na Meta (criados fora dos arquivos de replicação) — o dono revisa antes do envio: ${inferidos.slice(0, 3).join(', ')}…`] : []),
      'a Meta leva de minutos a 48 h para aprovar; enquanto não aprova, a régua só manda dentro da janela de 24 h (texto) e deixa nota nas outras',
    ],
  });
  add({
    id: 'dataset-capi',
    sistema: 'meta',
    titulo: 'Dataset da CAPI (conversões do WhatsApp para a Meta)',
    acao: estado.meta?.datasetCapi || estado.segredos?.[q.meta.dataset_id_env] ? 'nada' : 'criar',
    itens: [`POST /${q.whatsapp.waba_id}/dataset (ou usar ${q.meta.dataset_id_env} se o dataset já existe)`, `token: ${q.meta.token_env} (do ambiente)`],
    execucao: 'esqueleto',
    avisos: estado.meta ? [] : [NAO_CONSULTADO],
  });

  // ── 4. A SOFIA da unidade ───────────────────────────────────────────────────────────────────────
  const sofia = camposDaSofia(q, opcoes.molde);
  const mudouSofia = Object.keys(sofia.campos).filter((k) => canonico(b?.sofia[k] ?? null) !== canonico(sofia.campos[k] ?? null));
  add({
    id: 'sofia',
    sistema: 'sofia',
    titulo: 'Sofia da unidade: persona, fontes (negócio e produtos com os preços) e, com sinal, o roteiro da Sofia 2.0 a partir do molde',
    acao: !b ? 'criar' : mudouSofia.length ? 'alterar' : 'nada',
    itens: [...Object.keys(sofia.campos).map((k) => (k === 'systemPrompt' ? `systemPrompt (${String(sofia.campos[k]).length} caracteres, do molde)` : k)), 'automação prompt-da-unidade: NÃO ligo — antes roda `testar-prompt.ts --slug` e o dono lê as respostas'],
    execucao: 'sim',
    avisos: [...(b ? [] : [NAO_CONSULTADO]), ...sofia.avisos, 'a Sofia só atende com agenda: falta o token da franquia (passo «franquia») e os turnos por profissional (spine_staff_por_turno)'],
    depende: ['unidade'],
  });

  add({
    id: 'robo-sofia',
    sistema: 'chatwoot',
    titulo: 'Robô Sofia (Agent Bot) ligado na caixa',
    acao: caixaExiste?.robo ? 'nada' : 'criar',
    itens: ['POST inboxes/<caixa>/set_agent_bot — só DEPOIS do teste da Sofia (passo «sofia») e de ligar a automação chatwoot-ia'],
    execucao: 'esqueleto',
    avisos: ['a Sofia só fala quando a automação chatwoot-ia estiver ligada; o robô na caixa é o canal por onde ela responde'],
    depende: ['caixa', 'sofia'],
  });

  // ── 5. VPS: subdomínio e segredos ───────────────────────────────────────────────────────────────
  const host = `${q.chatwoot.subdominio}.${DOMINIO_DOS_CRMS}`;
  add({
    id: 'subdominio',
    sistema: 'vps',
    titulo: `Subdomínio ${host} no proxy ${SERVICO_DO_PROXY} (Traefik)`,
    acao: estado.vps?.hostNoProxy ? 'nada' : 'manual',
    itens: [`acrescentar Host(\`${host}\`) na regra do serviço ${SERVICO_DO_PROXY} (receita no README do repo doutor-digital/chatwoot)`, 'DNS: o curinga *.doutordigitalconsultoria.com já aponta para a VPS — não precisa criar registro', 'certificado: o Traefik emite sozinho (letsencryptresolver)'],
    execucao: 'esqueleto',
    avisos: estado.vps ? [] : [NAO_CONSULTADO],
    depende: ['caixa'],
  });
  const variaveis = [q.franquia.token_env, q.meta.token_env, q.meta.conta_env, q.meta.dataset_id_env];
  const ausentes = variaveis.filter((v) => estado.segredos?.[v] !== true);
  add({
    id: 'segredos',
    sistema: 'vps',
    titulo: 'Segredos: as variáveis que o questionário nomeou precisam existir no ambiente do serviço (valor nunca passa por aqui)',
    acao: ausentes.length ? 'manual' : 'nada',
    itens: variaveis.map((v) => `${v}: ${estado.segredos ? (estado.segredos[v] ? 'presente' : 'AUSENTE') : 'não consultado'}`),
    execucao: 'manual',
    avisos: ausentes.length ? [`o João/Suzanne coloca no arquivo de segredos da VPS e no env do serviço ddagent_agent: ${ausentes.join(', ')}`] : [],
  });
  add({
    id: 'franquia',
    sistema: 'banco',
    titulo: `Franquia: id_company ${q.franquia.id_company} e token da API (units.spine_token)`,
    acao: 'manual',
    itens: ['o token da franquia fica em units.spine_token (como nas outras unidades) e NÃO passa pelo questionário nem pelo script', `id_company ${q.franquia.id_company} entra em ID_COMPANY_POR_SLUG (lib/franquia-tela.ts, hoje no código — Fase 2)`, 'depois: spine_enabled=true e a automação chatwoot-agenda em seco'],
    execucao: 'manual',
    avisos: [],
  });

  const relatorio = montarRelatorio(q, passos, { aEnviar: aEnviar.length, ausentes, inferidos: inferidos.length });
  return { unidade: slug, config, passos, relatorio };
}

/** O que falta para a unidade estar de pé, na ordem de quem faz. */
function montarRelatorio(q: Questionario, passos: Passo[], x: { aEnviar: number; ausentes: string[]; inferidos: number }): string[] {
  const r: string[] = [];
  const tem = (id: string) => passos.find((p) => p.id === id)?.acao !== 'nada';
  if (tem('numero')) r.push(`NÚMERO: conectar ${q.whatsapp.numero_oficial} ao Kapso (${q.whatsapp.conexao}) — quem tem o celular da unidade`);
  if (x.aEnviar) r.push(`MODELOS: ${x.aEnviar} modelo(s) vão à Meta e ficam PENDENTES (minutos a 48 h). Conferir a aprovação em Kapso → Modelos${x.inferidos ? `; revisar categoria/botões de ${x.inferidos} deles` : ''}`);
  if (x.ausentes.length) r.push(`SEGREDOS: colocar no ambiente do serviço e no arquivo de segredos da VPS: ${x.ausentes.join(', ')}`);
  r.push('FRANQUIA: gravar o token da API da franquia em units.spine_token, ligar spine_enabled e definir os turnos por profissional (spine_staff_por_turno)');
  r.push(`ATENDENTES: ${q.chatwoot.atendentes.length} convite(s) saem por e-mail — cada uma aceita e define a senha; só depois dá para criar as pastas dela`);
  r.push(`SOFIA: rodar testar-prompt.ts --slug ${q.unidade.slug} e o dono ler as respostas ANTES de ligar prompt-da-unidade e chatwoot-ia`);
  r.push('AUTOMAÇÕES: ficam em SECO; observar 24 h de notas na conversa e só então ligar pela tela Automações (uma por vez, começando por agenda)');
  r.push('UNIDADE: nasce inativa (isActive=false); ativar na tela da unidade quando tudo acima estiver de pé');
  r.push(`SUBDOMÍNIO: ${q.chatwoot.subdominio}.${DOMINIO_DOS_CRMS} só funciona depois do passo da VPS (proxy chatwoot_franquias)`);
  r.push('CONFERIR PELO DONO: endereço, link do mapa, preços, horários e nomes dos profissionais — viram frase dita ao paciente e texto dos modelos aprovados na Meta');
  return r;
}

// ── a saída do seco ──────────────────────────────────────────────────────────────────────────────

const ROTULO: Record<Acao, string> = { criar: 'CRIAR', alterar: 'ALTERAR', nada: 'JÁ ESTÁ', manual: 'MANUAL', bloqueado: 'BLOQUEADO' };
const SISTEMA: Record<Sistema, string> = { banco: 'Banco', chatwoot: 'Chatwoot', meta: 'Meta/Kapso', vps: 'VPS', sofia: 'Sofia' };

export function textoDoPlano(p: Plano): string {
  const l: string[] = [`PLANO DA UNIDADE ${p.unidade}  (SECO: nada foi gravado em lugar nenhum)`, ''];
  p.passos.forEach((s, i) => {
    l.push(`${String(i + 1).padStart(2, ' ')}. [${SISTEMA[s.sistema]}] ${ROTULO[s.acao]} — ${s.titulo}   (${s.execucao === 'sim' ? 'executa no --aplicar' : s.execucao === 'esqueleto' ? 'ESQUELETO: Fase 2' : 'manual'})`);
    for (const it of s.itens) l.push(`      · ${it}`);
    for (const a of s.avisos) l.push(`      ! ${a}`);
  });
  l.push('', 'O QUE VAI FALTAR DEPOIS (relatório final):');
  p.relatorio.forEach((x, i) => l.push(`  ${i + 1}. ${x}`));
  return l.join('\n');
}

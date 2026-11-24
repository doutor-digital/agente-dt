/**
 * O PLANO da unidade nova: dado o questionário (já validado) e o que JÁ existe, diz o que o script criaria ou alteraria em cada
 * sistema, na ordem certa. Função PURA (sem rede nem banco): o seco imprime este plano; o `--aplicar` percorre os mesmos passos.
 * Idempotente por construção — cada passo olha o estado atual e responde `nada` quando já está como deveria.
 *
 * Estado desconhecido (`undefined` na parte do estado) NUNCA vira "já existe": o passo aparece como `criar` com a ressalva
 * "estado atual não consultado". Seco sem consultar nada é um plano do que faria numa conta vazia.
 */
import { MAX_REGRAS_DA_UNIDADE } from '../aprendizados-unidade.js';
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
import { camposDaSofia, camposDaUnidade, horarioDaAssistente, informacoesDaClinica, licoesDaAssistente } from './molde-sofia.js';
import { aGravar, dadosDosModelosAGravar } from './protecao.js';
import { configChatwootDoQuestionario, mascararCampo, mascararEmails, sufixoDoQuestionario, type Questionario } from './questionario.js';

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
    configChatwoot: { subdominio?: string | null; prefixoModelos: string; metaAgendamentosDia: number | null; kapsoPhoneNumberId: string | null; wabaId: string | null; envSufixo: string; dadosModelos: Record<string, unknown>; contaId?: number | null } | null;
    caixasRegistradas: number[];
    /** id da automação → estado gravado para esta unidade */
    automacoes: Record<string, string>;
    /** campos de persona/fontes/prompt da unidade hoje */
    sofia: Record<string, unknown>;
    /** textos dos aprendizados (regras) que a unidade já tem; ausente = não consultado */
    licoes?: string[];
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
    /** o webhook desta conta para o agente, com a chave DESTA conta, já existe? */
    webhookDaConta?: boolean;
    /** títulos das abas (Dashboard Apps) da conta */
    abas?: string[];
  };
  kapso?: { modelos: Record<string, string> };
  meta?: { datasetCapi: boolean };
  vps?: { hostNoProxy: boolean };
  /** nomes de variável de ambiente → presente? (nunca o valor) */
  segredos?: Record<string, boolean>;
  /** o token do Platform App (CHATWOOT_PLATFORM_TOKEN) está disponível? Sem ele não dá para criar conta */
  plataforma?: boolean;
}

export interface Plano {
  unidade: string;
  config: ConfigChatwootUnidade;
  passos: Passo[];
  /** o que falta para a unidade funcionar, em ordem de quem faz */
  relatorio: string[];
}

/** O que `unit_chatwoot` guarda (sem as caixas, o gerente e o usuário do celular, que só existem depois do convite). */
export const configGravavel = (c: ConfigChatwootUnidade) => ({ subdominio: c.subdominio ?? null, prefixoModelos: c.prefixoModelos, metaAgendamentosDia: c.metaAgendamentosDia, kapsoPhoneNumberId: c.kapsoPhoneNumberId, wabaId: c.wabaId, envSufixo: c.envSufixo, dadosModelos: { ...c.dadosModelos } });

/** JSON com as chaves em ordem (o jsonb do Postgres devolve as chaves em outra ordem que a gravada). */
export function canonico(v: unknown): string {
  const ordenar = (x: unknown): unknown => (Array.isArray(x) ? x.map(ordenar) : x && typeof x === 'object' ? Object.fromEntries(Object.entries(x as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, y]) => [k, ordenar(y)])) : x);
  return JSON.stringify(ordenar(v));
}

const NAO_CONSULTADO = 'estado atual não consultado — assumindo que não existe';
const lc = (s: string) => s.toLowerCase();
const faltantes = (precisa: readonly string[], tem: readonly string[]) => precisa.filter((x) => !tem.includes(x));

/** O que o passo «config-chatwoot» escreveria numa configuração que JÁ existe (só campo vazio; `--sobrescrever` troca o resto). */
function configAEscrever(hoje: NonNullable<EstadoAtual['banco']>['configChatwoot'] & object, config: ConfigChatwootUnidade, sobrescrever: boolean): { escrever: boolean; preservados: string[] } {
  const novos = configGravavel(config);
  const { dadosModelos, ...resto } = novos;
  const a = aGravar(hoje as unknown as Record<string, unknown>, resto as unknown as Record<string, unknown>, sobrescrever);
  const d = dadosDosModelosAGravar(hoje.dadosModelos, dadosModelos as Record<string, unknown>, sobrescrever);
  return { escrever: Object.keys(a.gravar).length > 0 || Object.keys(d.gravar).length > 0, preservados: [...a.preservados, ...d.preservados.map((k) => `dadosModelos.${k}`)] };
}

/** As automações do Chatwoot que nascem em SECO. Clínica SEM assistente, ou `--so-crm` (a Sofia da unidade segue só pelo Kommo), não ganha a de IA (chatwoot-ia). UM lugar só: o plano e o executor usam esta lista. */
export const automacoesEmSeco = (q: Questionario, soCrm = false) => AUTOMACOES.filter((a) => a.id.startsWith('chatwoot-') && a.temSeco && !((q.assistente?.quer === false || soCrm) && a.id === 'chatwoot-ia'));

/**
 * `--so-crm` é o modo que NUNCA escreve em `units` nem mexe na Sofia da unidade: não combina com nenhuma flag que faz isso (ou que liga o robô). UM lugar só: o CLI, o plano e o executor chamam esta.
 * Devolve o motivo (texto pronto) ou null.
 */
export function conflitoDoSoCrm(o: { soCrm?: boolean; sobrescrever?: boolean; sobrescreverPrompt?: boolean; reimportarAprendizados?: boolean; ligarRobo?: boolean }): string | null {
  if (!o.soCrm) return null;
  const ruins = [o.sobrescrever && '--sobrescrever', o.sobrescreverPrompt && '--sobrescrever-prompt', o.reimportarAprendizados && '--reimportar-aprendizados', o.ligarRobo && '--ligar-robo'].filter(Boolean);
  return ruins.length ? `--so-crm não combina com ${ruins.join(', ')}: ele nunca escreve em units nem mexe na Sofia ou no robô da unidade (essas flags fazem exatamente isso)` : null;
}

export interface OpcoesDoPlano {
  /** texto do molde da Sofia (ops/kit-unidade/molde-sofia/bloco-conversa.md); null = não achei o arquivo */
  molde: string | null;
  /** a lista EFETIVA dos administradores da Doutor Digital (KIT_ADMINS_DD ou o padrão), para o plano mostrar quem vai entrar; o questionário (`chatwoot.admins_dd`) vence */
  adminsDD?: string[];
  /** `--sobrescrever`: troca também o que já está preenchido e deixa tocar numa unidade ATIVA */
  sobrescrever?: boolean;
  /**
   * `--so-crm`: a unidade JÁ EXISTE (e pode estar ATIVA, no ar pelo Kommo) e o kit só monta o CRM dela (unit_chatwoot, caixa, automações em seco, conta do Chatwoot). A linha de `units`
   * NÃO é tocada — nem campo vazio, nem persona, fontes, prompt ou aprendizados da Sofia. Não combina com `sobrescrever` (que faz o contrário).
   */
  soCrm?: boolean;
  /** `--reimportar-aprendizados`: repete a importação dos aprendizados da clínica (sem duplicar). Flag PRÓPRIA: `--sobrescrever` não mexe nos aprendizados que a clínica já administra. */
  reimportarAprendizados?: boolean;
}

export function montarPlano(q: Questionario, estado: EstadoAtual, opcoes: OpcoesDoPlano): Plano {
  const conflito = conflitoDoSoCrm(opcoes);
  if (conflito) throw new Error(conflito);
  const slug = q.unidade.slug;
  const config = configChatwootDoQuestionario(q);
  const passos: Passo[] = [];
  const add = (p: Omit<Passo, 'avisos' | 'depende'> & { avisos?: string[]; depende?: string[] }) => passos.push({ avisos: [], depende: [], ...p });
  const b = estado.banco;
  const cw = estado.chatwoot;

  // ── 1. BANCO: a unidade, a configuração do CRM e as automações em seco ──────────────────────────
  const campos = camposDaUnidade(q);
  const sobrescrever = !!opcoes.sobrescrever;
  const existente = b?.unidade ?? null;
  // unidade que já existe: só se PREENCHE campo vazio (ver protecao.ts); a ATIVA só com --sobrescrever
  const { gravar: aEscrever, preservados } = aGravar(existente?.campos ?? null, campos, sobrescrever);
  const ativa = existente?.campos.isActive === true;
  const soCrm = !!opcoes.soCrm;
  const divergentes = existente ? Object.keys(aGravar(existente.campos, campos, true).gravar) : [];
  add({
    id: 'unidade',
    sistema: 'banco',
    titulo: `Unidade «${q.unidade.nome}» em units (identidade, agenda, pagamento — sem segredo)`,
    // --so-crm: a linha de units não é escrita; só importa que a unidade exista (os passos seguintes usam o id dela)
    acao: soCrm ? (!b || !existente ? 'bloqueado' : 'nada') : !b ? 'criar' : !existente ? 'criar' : ativa && !sobrescrever ? 'bloqueado' : Object.keys(aEscrever).length ? 'alterar' : 'nada',
    itens: soCrm
      ? [`--so-crm: a unidade ${slug} é só LIDA (para achar o id): nenhum campo de units é escrito, nem vazio${ativa ? ' (ela está ATIVA e segue como está)' : ''}`]
      : !existente
      ? [`slug ${slug}`, `${Object.keys(campos).length} campos: ${Object.keys(campos).join(', ')}`, 'nasce INATIVA (isActive=false) até a equipe confirmar']
      : Object.keys(aEscrever).length
        ? [`campos vazios que o questionário preenche: ${Object.keys(aEscrever).join(', ')}`]
        : ['já está preenchida (nada vazio a preencher)'],
    execucao: 'sim',
    avisos: [
      ...(b ? [] : [NAO_CONSULTADO]),
      ...(soCrm && b && !existente ? [`a unidade ${slug} não existe: --so-crm só vale para unidade que já existe (crie a unidade sem a flag)`] : []),
      ...(soCrm && !b ? ['--so-crm exige que a unidade já exista, e sem ler o banco isso não dá para conferir: o passo fica BLOQUEADO (rode o seco com acesso ao banco, sem --offline)'] : []),
      ...(soCrm && existente && divergentes.length ? [`o questionário DIFERE de units em: ${divergentes.join(', ')} — units NÃO é escrita, mas os textos dos modelos da Meta (unit_chatwoot.dados_modelos) e os preços/endereço das mensagens prontas usam o do QUESTIONÁRIO: confira com o dono`] : []),
      ...(ativa && !sobrescrever && !soCrm ? [`a unidade ${slug} está ATIVA (no ar): o script NÃO mexe nela sem --sobrescrever — nenhum passo de banco roda. Para montar SÓ o CRM dela sem tocar em units, use --so-crm (--sobrescrever troca persona, fontes e prompt: NÃO use numa unidade no ar)`] : []),
      ...(preservados.length && !(ativa && !sobrescrever) && !soCrm ? [`já preenchidos e diferentes do questionário (ficam como estão; --sobrescrever troca): ${preservados.join(', ')}`] : []),
    ],
  });
  const problemasCfg = problemasDaConfig({ ...config, caixas: [{ id: 1, tipo: 'cloud' }] });
  add({
    id: 'config-chatwoot',
    sistema: 'banco',
    titulo: 'Configuração do CRM da unidade (unit_chatwoot): prefixo dos modelos, gerente, usuário do celular, número do Kapso, WABA, sufixo da Meta, dados dos modelos',
    acao: !b ? 'criar' : !b.configChatwoot ? 'criar' : configAEscrever(b.configChatwoot, config, sobrescrever).escrever ? 'alterar' : 'nada',
    itens: [
      `prefixo dos modelos ${config.prefixoModelos}`,
      `sufixo das variáveis da Meta ${config.envSufixo}`,
      `meta de agendamentos por dia ${config.metaAgendamentosDia}`,
      'gerente e usuário do celular: o id do Chatwoot só existe depois do convite — gravados no passo «registrar-caixa»',
    ],
    execucao: 'sim',
    avisos: [
      ...(b ? [] : [NAO_CONSULTADO]),
      ...problemasCfg.map((p) => `configuração inválida: ${p}`),
      ...(b?.configChatwoot && configAEscrever(b.configChatwoot, config, sobrescrever).preservados.length ? [`já preenchidos e diferentes do questionário (ficam como estão; --sobrescrever troca): ${configAEscrever(b.configChatwoot, config, sobrescrever).preservados.join(', ')}`] : []),
    ],
    depende: ['unidade'],
  });
  const sufixo = config.envSufixo;
  const nomeToken = `CHATWOOT_API_TOKEN_${sufixo}`;
  const contaId = b?.configChatwoot?.contaId ?? null;
  const temToken = estado.segredos?.[nomeToken] === true;
  add({
    id: 'conta',
    sistema: 'chatwoot',
    titulo: `Conta própria da clínica no Chatwoot (API de plataforma) e o usuário conector dela`,
    acao: !b ? 'criar' : contaId !== null && temToken ? 'nada' : contaId === null && (!estado.plataforma || b.caixasRegistradas.length > 0) ? 'bloqueado' : 'criar',
    itens: contaId !== null
      ? [`conta ${contaId} já gravada em unit_chatwoot.conta_id`, temToken ? `${nomeToken} já está no cofre/ambiente` : `${nomeToken} NÃO está no cofre/ambiente: cria outro usuário conector (precisa do Platform App)`, `administradores da Doutor Digital: ${mascararEmails(q.chatwoot.admins_dd ?? opcoes.adminsDD ?? ['KIT_ADMINS_DD (padrão: a Suzanne e o João)']).join(', ')} — vai pôr os que ainda não estão na conta (pelo id na conta de referência; sem permissão sobre usuário)`]
      : [`criar a conta «${q.unidade.nome}»`, `pôr os administradores da Doutor Digital na conta nova: ${mascararEmails(q.chatwoot.admins_dd ?? opcoes.adminsDD ?? ['KIT_ADMINS_DD (padrão: a Suzanne e o João)']).join(', ')}`, `usuário conector administrador (${`conector+${slug}@…`}); o token dele vai para o cofre como ${nomeToken} (nunca impresso)`, 'o id da conta é gravado em unit_chatwoot.conta_id NA HORA (uma queda não deixa conta órfã)'],
    execucao: 'sim',
    avisos: [
      ...(b ? [] : [NAO_CONSULTADO]),
      ...(contaId === null && (b?.caixasRegistradas.length ?? 0) > 0 ? ['a unidade JÁ tem caixa(s) na conta do ambiente (em uso): o kit NÃO cria conta nova para ela, nem com --sobrescrever (levaria tudo para uma conta vazia)'] : []),
      ...(contaId === null && !estado.plataforma ? ['falta o token do Platform App (CHATWOOT_PLATFORM_TOKEN): o João roda ops/kit-unidade/criar-platform-app-joao.sh uma vez'] : []),
      'a clínica nova nasce em SECO em todas as automações do Chatwoot (conta com conta_id numérico)',
    ],
    depende: ['config-chatwoot'],
  });
  // clínica SEM assistente: a automação de IA (chatwoot-ia) NÃO nasce, nem em seco (senão gastaria modelo lendo conversa de uma clínica que não contratou IA)
  const chatwootAutomacoes = automacoesEmSeco(q, !!opcoes.soCrm);
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
    titulo: 'Etiquetas da conta da clínica que o código usa (cada clínica tem a sua conta no Chatwoot)',
    acao: etFalta.length ? 'criar' : 'nada',
    itens: etFalta.length ? [`${etFalta.length} etiqueta(s): ${etFalta.join(', ')}`, 'cor e descrição copiadas da conta de referência (Parauapebas); as «perdido-*» vêm de lá'] : [`as ${ETIQUETAS_DO_CODIGO.length} já existem`],
    execucao: 'sim',
    avisos: cw ? [] : [NAO_CONSULTADO],
    depende: ['conta'],
  });
  const atFalta = cw ? faltantes(ATRIBUTOS_DE_CONVERSA, cw.atributosConversa) : [...ATRIBUTOS_DE_CONVERSA];
  const atcFalta = cw ? faltantes(ATRIBUTOS_DE_CONTATO, cw.atributosContato) : [...ATRIBUTOS_DE_CONTATO];
  add({
    id: 'atributos',
    sistema: 'chatwoot',
    titulo: 'Atributos de conversa e de contato que a régua, a agenda e a Sofia leem',
    acao: atFalta.length || atcFalta.length ? 'criar' : 'nada',
    itens: atFalta.length || atcFalta.length ? [...(atFalta.length ? [`${atFalta.length} de conversa: ${atFalta.join(', ')}`] : []), ...(atcFalta.length ? [`${atcFalta.length} de contato: ${atcFalta.join(', ')}`] : []), 'tipo e lista de opções copiados da conta de referência'] : [`os ${ATRIBUTOS_DE_CONVERSA.length + ATRIBUTOS_DE_CONTATO.length} já existem`],
    execucao: 'sim',
    avisos: cw ? [] : [NAO_CONSULTADO],
    depende: ['conta'],
  });
  add({
    id: 'automacoes-conta',
    sistema: 'chatwoot',
    titulo: 'Automações nativas da conta da clínica (as 8 de Parauapebas: só etiqueta, prioridade e nota)',
    acao: cw && cw.automacoesDaConta >= AUTOMACOES_DA_CONTA.length ? 'nada' : 'criar',
    itens: AUTOMACOES_DA_CONTA.map((a) => a),
    execucao: 'sim',
    avisos: [cw ? `a conta tem ${cw.automacoesDaConta} automação(ões)` : NAO_CONSULTADO, 'copiadas da conta de referência pelo nome; a que aponta para caixa, time ou agente de outra conta NÃO é copiada (o relatório diz qual)'],
    depende: ['conta'],
  });
  const caixaExiste = cw?.caixas.find((c) => c.nome === q.chatwoot.caixa_nome);
  add({
    id: 'caixa',
    sistema: 'chatwoot',
    titulo: q.whatsapp.modo === 'demonstracao' ? `Caixa «${q.chatwoot.caixa_nome}» — canal API (demonstração)` : `Caixa «${q.chatwoot.caixa_nome}» — WhatsApp Cloud pelo Kapso`,
    acao: !cw ? 'criar' : caixaExiste ? 'nada' : 'criar',
    itens: caixaExiste
      ? [`caixa ${caixaExiste.id} já existe`]
      : q.whatsapp.modo === 'demonstracao'
        ? ['DEMONSTRAÇÃO: canal API (não há número de WhatsApp nem Kapso)']
        : [`canal whatsapp_cloud, número ${mascararCampo(q.whatsapp.numero_oficial)}`, `phone_number_id ${mascararCampo(q.whatsapp.kapso_phone_number_id)} e WABA ${mascararCampo(q.whatsapp.waba_id)} (Kapso)`, 'chave do Kapso: KAPSO_API_KEY do ambiente (nunca impressa)'],
    execucao: 'sim',
    avisos: cw ? [] : [NAO_CONSULTADO],
    depende: ['conta'],
  });
  const timeExiste = cw?.times.includes(q.chatwoot.time_nome);
  add({
    id: 'time',
    sistema: 'chatwoot',
    titulo: `Time «${q.chatwoot.time_nome}»`,
    acao: !cw ? 'criar' : timeExiste ? 'nada' : 'criar',
    itens: timeExiste ? ['já existe'] : [`time ${q.chatwoot.time_nome}`],
    execucao: 'sim',
    avisos: cw ? [] : [NAO_CONSULTADO],
    depende: ['conta'],
  });
  const novos = q.chatwoot.atendentes.filter((a) => !cw?.agentes[lc(a.email)]);
  add({
    id: 'atendentes',
    sistema: 'chatwoot',
    titulo: `Atendentes: convite, caixa e time (${q.chatwoot.atendentes.length})`,
    acao: !cw ? 'criar' : novos.length ? 'criar' : 'nada',
    itens: q.chatwoot.atendentes.map((a) => `${a.nome} (${a.funcao}) — ${cw?.agentes[lc(a.email)] ? 'já é agente' : 'convite por e-mail'}; entra na caixa e no time`),
    execucao: 'sim',
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
      execucao: 'sim',
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
    execucao: 'sim',
    avisos: ['só depois deste passo a configuração passa a valer: antes, o código ignora a unidade (config sem caixa é inválida) e nada dispara'],
    depende: ['config-chatwoot', 'caixa', 'atendentes', ...(q.chatwoot.usuario_celular_email ? ['usuario-celular'] : [])],
  });
  add({
    id: 'webhook',
    sistema: 'chatwoot',
    titulo: 'Webhook da conta para o agente, com a chave DESTA conta (derivada do token dela; a de outra conta não vale)',
    acao: cw?.webhookDaConta ? 'nada' : 'criar',
    itens: ['POST webhooks na conta, com os eventos de mensagem e conversa', 'o servidor só aceita o evento se a chave for a da conta que o evento diz ser'],
    execucao: 'sim',
    avisos: [cw ? 'se o webhook já existe com a mesma chave, nada é criado' : NAO_CONSULTADO],
    depende: ['conta'],
  });
  add({
    id: 'dashboard-app',
    sistema: 'chatwoot',
    titulo: 'Abas «Funil» e «Tarefas» (Dashboard Apps) CRIADAS nesta conta, apontando para as telas desta conta (nunca copiadas de Parauapebas)',
    acao: cw?.abas?.includes('Funil') && cw?.abas?.includes('Tarefas') ? 'nada' : 'criar',
    itens: ['/funil?conta=<id da conta> e /funil/tarefas?conta=<id da conta> no endereço do agente', 'a chave do token da conta NÃO vai na URL (qualquer agente vê a URL no iframe): a aba usa o login da pessoa'],
    execucao: 'sim',
    avisos: [cw ? 'se a aba já existe, nada é criado (a que falta é criada)' : NAO_CONSULTADO],
    depende: ['conta'],
  });
  const faltaPasta = q.chatwoot.atendentes.flatMap((a) => faltantes(PASTAS_PADRAO, cw?.pastas[lc(a.email)] ?? []).map((p) => `${a.nome}: ${p}`));
  add({
    id: 'pastas',
    sistema: 'chatwoot',
    titulo: `Pastas padrão por atendente (${PASTAS_PADRAO.length} cada)`,
    acao: faltaPasta.length ? 'criar' : 'nada',
    itens: faltaPasta.length ? [`${faltaPasta.length} pasta(s) a criar (${PASTAS_PADRAO.join(', ')})`] : ['todas já existem'],
    execucao: 'manual',
    avisos: [...(cw ? [] : [NAO_CONSULTADO]), 'a pasta é da pessoa: só dá para criar depois que ela aceitar o convite e entrar (cada uma cria as suas 10 pastas); o script não faz'],
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
    execucao: 'sim',
    avisos: cw ? [] : [NAO_CONSULTADO],
    depende: ['conta'],
  });
  // ── 3. META / KAPSO: número, modelos, CAPI ──────────────────────────────────────────────────────
  add({
    id: 'numero',
    sistema: 'meta',
    titulo: q.whatsapp.modo === 'demonstracao' ? 'Número de WhatsApp: DEMONSTRAÇÃO, não há número nem WABA' : `Número ${mascararCampo(q.whatsapp.numero_oficial)} conectado ao Kapso (${q.whatsapp.conexao === 'coexistencia' ? 'coexistência: o número segue no celular' : 'número novo'})`,
    acao: q.whatsapp.modo === 'demonstracao' ? 'nada' : 'manual',
    itens: q.whatsapp.modo === 'demonstracao' ? ['a demonstração não usa WhatsApp de verdade'] : [q.whatsapp.conexao === 'coexistencia' ? 'quem tem o celular da unidade lê o QR/aceita a coexistência no app do WhatsApp Business' : 'verificar o número na Meta (código por SMS/ligação)'],
    execucao: 'manual',
    avisos: ['depende de gente com o celular na mão e de aprovação da Meta; o script não consegue fazer', ...(soCrm ? ['--so-crm: ligar o número ao Kapso pode CORTAR a entrada de leads da Kommo (coexistência derruba os aparelhos vinculados, caso Tatuí 18/11). É decisão SEPARADA, só depois de confirmar como o canal está ligado na Kommo hoje'] : [])],
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
    acao: q.whatsapp.modo === 'demonstracao' ? 'criar' : aEnviar.length ? 'criar' : 'nada',
    itens: q.whatsapp.modo === 'demonstracao' ? [`SECO (demonstração, sem WABA): ${modelos.length} modelo(s) seriam gerados e NENHUM vai à Meta`] : aEnviar.length
      ? [`${aEnviar.length} a enviar: ${aEnviar.map((m) => m.meta.name).slice(0, 4).join(', ')}${aEnviar.length > 4 ? '…' : ''}`, `categoria: ${modelos.filter((m) => m.meta.category === 'UTILITY').length} utilidade, ${modelos.filter((m) => m.meta.category === 'MARKETING').length} marketing (com «responda SAIR»)`]
      : ['todos já estão na Meta'],
    execucao: 'sim',
    depende: [],
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
    acao: q.whatsapp.modo === 'demonstracao' || estado.meta?.datasetCapi || estado.segredos?.[q.meta.dataset_id_env] ? 'nada' : 'manual',
    itens: q.whatsapp.modo === 'demonstracao' ? ['DEMONSTRAÇÃO: sem WABA, sem CAPI'] : [`POST /${mascararCampo(q.whatsapp.waba_id)}/dataset (ou usar ${q.meta.dataset_id_env} se o dataset já existe)`, `token: ${q.meta.token_env} (do ambiente)`],
    execucao: 'manual',
    avisos: estado.meta ? [] : [NAO_CONSULTADO, 'a criação do dataset usa o token da Meta da clínica: o script não faz (conferir a tela do Business Manager)'],
  });

  // ── 4. A SOFIA da unidade ───────────────────────────────────────────────────────────────────────
  const sofia = camposDaSofia(q, opcoes.molde);
  const semIA = q.assistente?.quer === false;
  const licoes = licoesDaAssistente(q);
  const normLicao = (t: string) => t.trim().replace(/\s+/g, ' ').toLowerCase();
  const jaTemLicao = new Set((b?.licoes ?? []).map(normLicao));
  // o kit grava os aprendizados UMA vez (marca em units.kit_aprendizados_em): depois disso a clínica manda neles (/aprendizados) e o kit não regrava, nem o que ela apagou ou editou
  const importadoEm = (b?.unidade?.campos as { kitAprendizadosEm?: Date | string | null } | undefined)?.kitAprendizadosEm ?? null;
  const jaImportados = !!importadoEm && !opcoes.reimportarAprendizados;
  const licoesNovas = jaImportados ? [] : licoes.textos.filter((t) => !jaTemLicao.has(normLicao(t)));
  const { gravar: sofiaAEscrever, preservados: sofiaPreservados } = aGravar(b?.sofia ?? null, sofia.campos, sobrescrever);
  const mudouSofia = Object.keys(sofiaAEscrever);
  add({
    id: 'sofia',
    sistema: 'sofia',
    titulo: semIA ? 'Sofia da unidade: a clínica NÃO quer a assistente virtual, nada é configurado' : 'Sofia da unidade: persona, fontes (negócio e produtos com os preços), aprendizados da clínica e, com sinal, o roteiro da Sofia 2.0 a partir do molde',
    acao: semIA || soCrm ? 'nada' : !b ? 'criar' : mudouSofia.length || licoesNovas.length ? 'alterar' : 'nada',
    itens: soCrm
      ? ['--so-crm: persona, fontes, systemPrompt e aprendizados da unidade NÃO são tocados (a Sofia dela segue exatamente como está)']
      : semIA
      ? ['sem persona, sem fontes, sem prompt e sem aprendizados: a unidade fica SEM IA (para contratar depois: assistente.quer: true no questionário e rodar de novo)']
      : [
          ...Object.keys(sofia.campos).map((k) => (k === 'systemPrompt' ? `systemPrompt (${String(sofia.campos[k]).length} caracteres, do molde)` : k)),
          ...(q.assistente ? [`aprendizados da clínica (fonte «unidade», editáveis em /aprendizados/${slug}): ${licoesNovas.length} a gravar (${jaImportados ? 'JÁ importados pelo kit: não regravo; a clínica os administra em /aprendizados (--reimportar-aprendizados repete)' : `${licoes.textos.length - licoesNovas.length} já existem`}) — o que a clínica pediu sobre saudação, emoji, objeções, o que nunca dizer e quando chamar uma pessoa; ficam ABAIXO das regras da rede`] : []),
          'automação prompt-da-unidade: NÃO ligo — antes roda `testar-prompt.ts --slug` e o dono lê as respostas',
          ...textoExatoDaSofia(q, sofia.campos, licoesNovas),
        ],
    execucao: semIA ? 'manual' : 'sim',
    avisos: [...(b ? [] : semIA ? [] : [NAO_CONSULTADO]), ...sofia.avisos, ...(q.assistente?.quer && q.assistente.quando_atende !== 'sempre' ? [`QUANDO A IA ATENDE («${horarioDaAssistente(q)}») NÃO é aplicado pelo kit: a janela se configura na automação/robô ao ligar; até lá a Sofia, ligada, responderia 24 h`] : []), ...licoes.recusadas.map((r) => `aprendizado RECUSADO pelas travas da rede (não será gravado): «${r.texto}» — ${r.motivo}`), ...((b?.licoes?.length ?? 0) + licoesNovas.length > MAX_REGRAS_DA_UNIDADE ? [`com os ${licoesNovas.length} novos a unidade passa de ${MAX_REGRAS_DA_UNIDADE} aprendizados: a página /aprendizados só aceita ${MAX_REGRAS_DA_UNIDADE} regras da clínica ligadas`] : []), ...(sofiaPreservados.length && !soCrm ? [`já preenchidos e diferentes do questionário (ficam como estão; --sobrescrever troca): ${sofiaPreservados.filter((k) => k !== 'systemPrompt').join(', ')}${sofiaPreservados.includes('systemPrompt') ? ' (o systemPrompt só troca com --sobrescrever-prompt)' : ''}`] : []), ...(soCrm ? [] : ['a Sofia só atende com agenda: falta o token da franquia (passo «franquia») e os turnos por profissional (spine_staff_por_turno)'])],
    depende: ['unidade'],
  });

  add({
    id: 'robo-sofia',
    sistema: 'chatwoot',
    titulo: 'Robô Sofia (Agent Bot) criado na conta; ligado na caixa só com --ligar-robo',
    acao: semIA || soCrm || caixaExiste?.robo ? 'nada' : 'criar',
    itens: soCrm ? ['--so-crm: o robô Sofia NÃO é criado nem ligado (a Sofia da unidade segue só pelo Kommo). Dar IA ao CRM é decisão à parte, depois de testar-prompt']
      : semIA ? ['a clínica não quer a assistente: o robô Sofia NÃO é criado'] : ['POST agent_bots (token do robô vai para o cofre como CHATWOOT_SOFIA_BOT_TOKEN_<SUFIXO>)', 'POST inboxes/<caixa>/set_agent_bot — só com --ligar-robo, DEPOIS do teste da Sofia (passo «sofia») e de ligar a automação chatwoot-ia'],
    execucao: semIA || soCrm ? 'manual' : 'sim',
    avisos: semIA || soCrm ? [] : ['a Sofia só fala quando a automação chatwoot-ia estiver ligada; o robô na caixa é o canal por onde ela responde'],
    depende: ['caixa', 'sofia'],
  });

  // ── 5. VPS: subdomínio e segredos ───────────────────────────────────────────────────────────────
  const host = `${q.chatwoot.subdominio}.${DOMINIO_DOS_CRMS}`;
  add({
    id: 'subdominio',
    sistema: 'vps',
    titulo: `Subdomínio ${host} no proxy ${SERVICO_DO_PROXY} (Traefik)`,
    acao: estado.vps?.hostNoProxy ? 'nada' : 'manual',
    itens: [`o João roda ops/kit-unidade/regra-traefik-joao.sh ${q.chatwoot.subdominio} (acrescenta Host(\`${host}\`) à regra do serviço ${SERVICO_DO_PROXY}; idempotente)`, 'DNS: o curinga *.doutordigitalconsultoria.com já aponta para a VPS — não precisa criar registro', 'certificado: o Traefik emite sozinho (letsencryptresolver)'],
    execucao: 'manual',
    avisos: estado.vps ? [] : [NAO_CONSULTADO],
    depende: ['caixa'],
  });
  // --so-crm: a franquia da unidade já está em units (spine_*), não se pede o token dela no ambiente
  const variaveis = [...(soCrm ? [] : [q.franquia.token_env]), q.meta.token_env, q.meta.conta_env, q.meta.dataset_id_env];
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
    titulo: `Franquia: id_company ${mascararCampo(q.franquia.id_company)} e token da API (units.spine_token)`,
    acao: soCrm ? 'nada' : 'manual',
    itens: soCrm ? ['--so-crm: token, agenda e turnos da franquia já estão em units (a unidade está no ar) e NÃO são tocados: nada a gravar, ligar ou definir aqui'] : ['o token da franquia fica em units.spine_token (como nas outras unidades) e NÃO passa pelo questionário nem pelo script', `id_company ${mascararCampo(q.franquia.id_company)} entra em ID_COMPANY_POR_SLUG (lib/franquia-tela.ts, hoje no código — Fase 2)`, 'depois: spine_enabled=true e a automação chatwoot-agenda em seco'],
    execucao: 'manual',
    avisos: [],
  });

  const relatorio = montarRelatorio(q, passos, { aEnviar: aEnviar.length, ausentes, inferidos: inferidos.length, soCrm });
  return { unidade: slug, config, passos, relatorio };
}

/** O que falta para a unidade estar de pé, na ordem de quem faz. */
function montarRelatorio(q: Questionario, passos: Passo[], x: { aEnviar: number; ausentes: string[]; inferidos: number; soCrm?: boolean }): string[] {
  const r: string[] = [];
  const tem = (id: string) => passos.find((p) => p.id === id)?.acao !== 'nada';
  if (tem('numero')) r.push(x.soCrm ? `NÚMERO (decisão SEPARADA, não faz parte do --so-crm): conectar ${mascararCampo(q.whatsapp.numero_oficial)} ao Kapso pode CORTAR a entrada de leads da Kommo (coexistência derruba aparelhos vinculados, como em Tatuí 18/11). Só depois de confirmar como o canal está ligado na Kommo hoje` : `NÚMERO: conectar ${mascararCampo(q.whatsapp.numero_oficial)} ao Kapso (${q.whatsapp.conexao}) — quem tem o celular da unidade`);
  if (q.whatsapp.modo === 'demonstracao') r.push('DEMONSTRAÇÃO: os modelos ficaram em SECO e a caixa é API. Para virar clínica de verdade: modo: real, número e WABA no questionário, e rodar de novo');
  r.push(q.assistente?.quer === false || x.soCrm ? `COFRE: o token do usuário conector (CHATWOOT_API_TOKEN_${sufixoDoQuestionario(q)}) fica na pasta KIT_SEGREDOS_DIR (${x.soCrm ? '--so-crm: sem robô' : 'clínica SEM assistente: não há robô'}, então não há CHATWOOT_SOFIA_BOT_TOKEN; use cofre-para-servico-joao.sh ${sufixoDoQuestionario(q)} --sem-ia):` : `COFRE: o token do usuário conector (CHATWOOT_API_TOKEN_${sufixoDoQuestionario(q)}) e o do robô (CHATWOOT_SOFIA_BOT_TOKEN_${sufixoDoQuestionario(q)}) ficam na pasta KIT_SEGREDOS_DIR: o João os coloca no arquivo de segredos da VPS e no env do serviço ddagent_agent e REINICIA o serviço (é quando o servidor passa a conhecer a conta)`);
  r.push('PASTAS: cada atendente cria as 10 pastas dela depois do primeiro login (a pasta é da pessoa; o script não consegue)');
  if (x.aEnviar && q.whatsapp.modo !== 'demonstracao') r.push(`MODELOS: ${x.aEnviar} modelo(s) vão à Meta e ficam PENDENTES (minutos a 48 h). Conferir a aprovação em Kapso → Modelos${x.inferidos ? `; revisar categoria/botões de ${x.inferidos} deles` : ''}`);
  if (x.ausentes.length) r.push(`SEGREDOS: colocar no ambiente do serviço e no arquivo de segredos da VPS: ${x.ausentes.join(', ')}`);
  if (!x.soCrm) r.push('FRANQUIA: gravar o token da API da franquia em units.spine_token, ligar spine_enabled e definir os turnos por profissional (spine_staff_por_turno)');
  r.push(`ATENDENTES: ${q.chatwoot.atendentes.length} convite(s) saem por e-mail — cada uma aceita e define a senha; só depois dá para criar as pastas dela`);
  if (x.soCrm) r.push('SOFIA: --so-crm não mexeu na Sofia da unidade (persona, fontes, prompt e aprendizados ficam como estão) e NÃO criou nem ligou robô no CRM: ela segue só pelo Kommo. IA no CRM é decisão à parte.');
  else if (q.assistente?.quer === false) r.push('SOFIA: a clínica NÃO quer a assistente virtual — nada foi configurado e não há robô nem automação de IA para ligar. (Para contratar depois: assistente.quer: true e rodar de novo.)');
  else {
    r.push(`SOFIA: rodar testar-prompt.ts --slug ${q.unidade.slug} e o dono ler as respostas ANTES de ligar prompt-da-unidade e chatwoot-ia`);
    if (q.assistente) {
      r.push(`ASSISTENTE: o que o dono escreveu entrou nas fontes da Sofia e em aprendizados da clínica (abaixo das regras da rede, que sempre vencem; preço só o do cadastro). Conferir no teste e em /aprendizados/${q.unidade.slug}`);
      r.push(`QUANDO A IA ATENDE: ${horarioDaAssistente(q)} — a janela é configurada na automação/robô (o kit não liga nada)`);
      if (q.assistente.quem_recebe?.nome) r.push(`QUEM RECEBE O ATENDIMENTO QUANDO A IA CHAMA UMA PESSOA: ${q.assistente.quem_recebe.nome}${q.assistente.quem_recebe.contato ? ` (contato ${mascararCampo(q.assistente.quem_recebe.contato)})` : ''} — conferir se está como gerente/SDR no CRM`);
    }
  }
  r.push(q.assistente?.quer === false ? 'AUTOMAÇÕES: ficam em SECO (a de IA, chatwoot-ia, NÃO existe nesta clínica: ela não quer assistente); observar 24 h de notas na conversa e só então ligar pela tela Automações as que forem de agenda e régua, uma por vez' : 'AUTOMAÇÕES: ficam em SECO; observar 24 h de notas na conversa e só então ligar pela tela Automações (uma por vez, começando por agenda)');
  r.push(x.soCrm ? 'UNIDADE: já existia e segue como está (--so-crm não escreveu em units: ativa continua ativa pelo Kommo). O CRM dela só passa a valer quando as automações do Chatwoot forem ligadas, uma por vez, pela tela Automações.' : 'UNIDADE: nasce inativa (isActive=false); ativar na tela da unidade quando tudo acima estiver de pé');
  r.push(`SUBDOMÍNIO: ${q.chatwoot.subdominio}.${DOMINIO_DOS_CRMS} só funciona depois do passo da VPS (proxy chatwoot_franquias)`);
  r.push('CONFERIR PELO DONO: endereço, link do mapa, preços, horários e nomes dos profissionais — viram frase dita ao paciente e texto dos modelos aprovados na Meta');
  return r;
}

// ── a saída do seco ──────────────────────────────────────────────────────────────────────────────

const ROTULO: Record<Acao, string> = { criar: 'CRIAR', alterar: 'ALTERAR', nada: 'JÁ ESTÁ', manual: 'MANUAL', bloqueado: 'BLOQUEADO' };
const SISTEMA: Record<Sistema, string> = { banco: 'Banco', chatwoot: 'Chatwoot', meta: 'Meta/Kapso', vps: 'VPS', sofia: 'Sofia' };

/**
 * O texto EXATO que o passo «sofia» grava, para o João LER antes de confirmar a etapa: o bloco «INFORMAÇÕES DA CLÍNICA» (acrescentado à fonte «negócio») e cada aprendizado, palavra por palavra.
 * O que o dono escreveu vira dado da Sofia; quem confere o texto final é a pessoa, não só as travas.
 */
function textoExatoDaSofia(q: Questionario, campos: Record<string, unknown>, licoesNovas: string[]): string[] {
  if (!q.assistente || q.assistente.quer === false) return [];
  const bloco = informacoesDaClinica(q);
  const l: string[] = [];
  l.push('── TEXTO EXATO que vai para a fonte «negócio» da Sofia (bloco INFORMAÇÕES DA CLÍNICA; leia antes de confirmar) ──');
  l.push(...(bloco ? bloco.split('\n') : ['(nenhuma informação da clínica)']));
  l.push(`── APRENDIZADOS que vão para a Sofia, palavra por palavra (${licoesNovas.length}) ──`);
  if (licoesNovas.length) licoesNovas.forEach((t, i) => l.push(...t.split('\n').map((linha, k) => (k === 0 ? `[${i + 1}] ${linha}` : `    ${linha}`))));
  else l.push('(nenhum a gravar agora)');
  if (typeof campos.sourceNegocio === 'string' && bloco && !campos.sourceNegocio.includes(bloco)) l.push('! o bloco acima NÃO está na fonte «negócio» que será gravada: confira antes de aplicar');
  return l;
}

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

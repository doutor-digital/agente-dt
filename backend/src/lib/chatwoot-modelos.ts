/**
 * OS MODELOS DO WHATSAPP POR UNIDADE (kit de unidade nova, 14/11/2026).
 *
 * Os 33 textos da régua (`chatwoot-regua-textos.ts`) foram escritos e aprovados na Meta para Parauapebas, com o nome da clínica,
 * o endereço e o link do mapa DENTRO do texto. Para uma unidade nova o texto é o mesmo, com os dados dela. Este módulo faz as duas pontas:
 *
 *  1. `TEXTOS_BASE`: os mesmos textos com os dados da unidade trocados por `{{unidade.nome}}`, `{{unidade.cidade}}`, `{{unidade.endereco}}`
 *     e `{{unidade.mapa}}` (derivados de `TEXTOS_PARAU` trocando EXATAMENTE os dados da semente de Parauapebas: o arquivo de textos
 *     não muda, então quem edita a régua não briga com isto). `textosDaUnidade(dados)` volta os dados — para Parauapebas o resultado é
 *     idêntico, caractere a caractere, a `TEXTOS_PARAU` (teste). Os campos `{{contact.name}}` e `{{lead.cf.N}}` NÃO são da unidade: ficam
 *     para a hora do envio (`renderizar`) e viram `{{1}}`, `{{2}}`… no modelo da Meta.
 *  2. `modeloParaMeta`: o corpo que vai à Meta (categoria, botões de resposta rápida, rodapé de SAIR nos de marketing, exemplos).
 *
 * Aqui não tem rede: quem manda à Meta (via Kapso) é o script `nova-unidade`.
 */
import { TEXTOS_PARAU } from './chatwoot-regua-textos.js';
import { SEMENTE_PARAUAPEBAS, configDaUnidade, nomeDoModeloNaMeta, type DadosDosModelos } from './chatwoot-unidades.js';

export type CategoriaDoModelo = 'UTILITY' | 'MARKETING';

export interface MetadadosDoModelo {
  categoria: CategoriaDoModelo;
  /** botões de resposta rápida (até 3, 25 caracteres cada) */
  botoes: readonly string[];
  /** rodapé "responda SAIR" (marketing exige opção de sair) */
  rodape?: true;
  /** categoria/botões NÃO conferidos na Meta (o modelo foi criado fora dos arquivos de replicação): conferir antes de enviar */
  inferido?: true;
}

export const RODAPE_SAIR = 'Para não receber mais mensagens deste tipo, responda SAIR.';

/** Categoria, botões e rodapé de cada modelo — como foram aprovados para Parauapebas (parau_ready.json, em_espera/espera_templates.py). */
export const METADADOS_DOS_MODELOS: Readonly<Record<string, MetadadosDoModelo>> = {
  parau_lead_reengajamento_48h: { categoria: 'MARKETING', botoes: ['Piorou', 'Continua igual', 'Melhorou'], rodape: true },
  parau_lead_metodo_convite_96h: { categoria: 'MARKETING', botoes: ['Ver horários', 'Tenho uma dúvida', 'Quanto custa?'], rodape: true },
  parau_lead_encerramento_120h: { categoria: 'UTILITY', botoes: ['Quero retomar', 'Pode encerrar'] },
  parau_consulta_prepagamento: { categoria: 'UTILITY', botoes: ['Enviar dados PIX', 'Preciso remarcar', 'Tenho uma dúvida'] },
  parau_consulta_prepagamento_pendente: { categoria: 'UTILITY', botoes: ['Já paguei', 'Preciso de ajuda', 'Prefiro pagar no dia'] },
  parau_consulta_lembrete_vespera: { categoria: 'UTILITY', botoes: ['Confirmar presença', 'Preciso remarcar'] },
  parau_consulta_confirmacao_dia: { categoria: 'UTILITY', botoes: ['Confirmar presença', 'Preciso remarcar'] },
  parau_consulta_preparo: { categoria: 'UTILITY', botoes: ['Está tudo certo', 'Tenho uma dúvida'] },
  parau_consulta_falta_mesmo_dia: { categoria: 'UTILITY', botoes: ['Quero remarcar', 'Me chama depois'] },
  parau_consulta_falta_48h: { categoria: 'UTILITY', botoes: ['Quero remarcar', 'Agora não posso'] },
  parau_consulta_pos_atendimento: { categoria: 'UTILITY', botoes: ['Tenho uma dúvida', 'Está tudo claro'] },
  parau_decisao_retomada_4d: { categoria: 'UTILITY', botoes: ['Quero iniciar', 'agendar retorno', 'Ainda decidindo'] },
  parau_decisao_encerramento_7d: { categoria: 'UTILITY', botoes: ['Quero retomar', 'Pode encerrar'] },
  parau_decisao_reengajamento_30d: { categoria: 'MARKETING', botoes: ['Piorou', 'Continua igual', 'Melhorou'], rodape: true },
  parau_espera_exames: { categoria: 'MARKETING', botoes: ['Já tenho o exame', 'Ainda não saiu'], rodape: true, inferido: true },
  parau_espera_viagem: { categoria: 'MARKETING', botoes: ['Já voltei, vamos marcar', 'Ainda viajando'], rodape: true, inferido: true },
  parau_espera_decisao: { categoria: 'MARKETING', botoes: ['Quero marcar', 'Tenho uma dúvida', 'Ainda não'], rodape: true, inferido: true },
  parau_espera_financeiro: { categoria: 'MARKETING', botoes: ['Quero ver horários', 'Ainda não dá'], rodape: true, inferido: true },
  parau_espera_retomada2: { categoria: 'MARKETING', botoes: ['Quero marcar', 'Não quero mais receber'], rodape: true, inferido: true },
  parau_sdr_confirmacao_retorno: { categoria: 'UTILITY', botoes: [], inferido: true },
  parau_sdr_retomada_pos_ligacao: { categoria: 'UTILITY', botoes: [], inferido: true },
  parau_sdr_reativacao_lead_frio: { categoria: 'MARKETING', botoes: [], rodape: true, inferido: true },
  parau_sdr_boas_vindas_programa: { categoria: 'UTILITY', botoes: [], inferido: true },
  parau_sessao_lembrete_vespera: { categoria: 'UTILITY', botoes: ['Confirmar presença', 'Preciso remarcar'] },
  parau_sessao_confirmacao_dia: { categoria: 'UTILITY', botoes: ['Confirmar', 'Preciso remarcar'] },
  parau_sessao_aderencia_meio: { categoria: 'UTILITY', botoes: ['Tenho uma dúvida', 'Está tudo certo'] },
  parau_alta_conclusao: { categoria: 'UTILITY', botoes: ['Tenho uma dúvida', 'Quero indicar alguém'] },
  parau_alta_pesquisa_nps: { categoria: 'UTILITY', botoes: ['9 ou 10', '7 ou 8', 'De 0 a 6'] },
  parau_alta_retorno_60d: { categoria: 'UTILITY', botoes: ['Quero agendar', 'Agora não'] },
  parau_cancelamento_acolhimento: { categoria: 'UTILITY', botoes: ['Financeiro', 'Horários', 'Outro motivo'] },
  parau_cancelamento_retorno_confirmado: { categoria: 'UTILITY', botoes: ['Confirmar presença', 'Preciso remarcar'] },
  parau_pendencia_documento: { categoria: 'UTILITY', botoes: ['Agendar', 'Ainda não fiz o exame'] },
  parau_sessao_falta: { categoria: 'UTILITY', botoes: ['Quero repor', 'Preciso remarcar'] },
};

/** Valor de exemplo de cada campo `{{…}}` (a Meta exige um exemplo por variável). */
export const EXEMPLOS_DOS_CAMPOS: Readonly<Record<string, string>> = {
  'contact.name': 'Maria',
  'lead.cf.2450736': '14/08 às 15h',
  'lead.cf.2450928': '18/08 às 09h',
  'lead.cf.2451104': 'R$ 200,00',
  'lead.cf.2450732': 'Ana',
  'lead.cf.2450750': 'Coluna Saudável',
  'lead.cf.2450798': 'Doutor Hérnia',
  'lead.cf.2451006': 'chave@exemplo.com',
  'lead.cf.2450998': '15/08',
  'lead.cf.2451112': 'R$ 150,00',
  'lead.cf.2451110': 'R$ 150,00',
};

// ── texto base ↔ texto da unidade ────────────────────────────────────────────────────────────────

const CHAVES_DA_UNIDADE = ['nome', 'cidade', 'endereco', 'mapa', 'telefone', 'valorConsulta', 'valorComSinal'] as const;
type ChaveDaUnidade = (typeof CHAVES_DA_UNIDADE)[number];

/** `{{unidade.endereco}}`, `{{unidade.valor_consulta}}`… (snake_case no texto, camelCase no dado) */
const NOME_NO_TEXTO: Readonly<Record<ChaveDaUnidade, string>> = {
  nome: 'unidade.nome',
  cidade: 'unidade.cidade',
  endereco: 'unidade.endereco',
  mapa: 'unidade.mapa',
  telefone: 'unidade.telefone',
  valorConsulta: 'unidade.valor_consulta',
  valorComSinal: 'unidade.valor_com_sinal',
};

/** Troca TODAS as ocorrências de `de` por `para` (sem regex: o endereço tem ponto e barra). */
function trocar(texto: string, de: string, para: string): string {
  return de ? texto.split(de).join(para) : texto;
}

/**
 * Troca os dados da unidade `d` pelos marcadores. Ordem: do mais longo ao mais curto (o endereço contém a cidade; o nome contém a cidade),
 * e "na unidade <cidade>" por último.
 */
export function paraBase(texto: string, d: DadosDosModelos): string {
  let t = texto;
  t = trocar(t, d.endereco, `{{${NOME_NO_TEXTO.endereco}}}`);
  t = trocar(t, d.mapa, `{{${NOME_NO_TEXTO.mapa}}}`);
  t = trocar(t, d.nome, `{{${NOME_NO_TEXTO.nome}}}`);
  t = trocar(t, `unidade ${d.cidade}`, `unidade {{${NOME_NO_TEXTO.cidade}}}`);
  return t;
}

/** Os marcadores `{{unidade.*}}` que ainda estão no texto. */
export function marcadoresDaUnidade(texto: string): string[] {
  return [...new Set(Array.from(texto.matchAll(/\{\{\s*(unidade\.[a-z_]+)\s*\}\}/g), (m) => m[1]!))];
}

/** Põe os dados da unidade no texto base. Marcador sem dado entra em `faltando` e fica no texto (nunca vira vazio em silêncio). */
export function comDadosDaUnidade(base: string, d: DadosDosModelos): { texto: string; faltando: string[] } {
  const faltando: string[] = [];
  const texto = base.replace(/\{\{\s*(unidade\.[a-z_]+)\s*\}\}/g, (todo, nome: string) => {
    const chave = CHAVES_DA_UNIDADE.find((k) => NOME_NO_TEXTO[k] === nome);
    const valor = chave ? d[chave] : undefined;
    if (typeof valor === 'string' && valor.trim()) return valor;
    if (!faltando.includes(nome)) faltando.push(nome);
    return todo;
  });
  return { texto, faltando };
}

/** Os textos da régua com os dados da unidade em marcadores. */
export const TEXTOS_BASE: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(TEXTOS_PARAU).map(([nome, t]) => [nome, paraBase(t, SEMENTE_PARAUAPEBAS.dadosModelos)]),
);

/** Os textos da régua para uma unidade, com o nome BASE do modelo (`parau_x`). Falta de dado vai em `faltando` (por modelo). */
export function textosDaUnidade(d: DadosDosModelos): { textos: Record<string, string>; faltando: Record<string, string[]> } {
  const textos: Record<string, string> = {};
  const faltando: Record<string, string[]> = {};
  for (const [nome, base] of Object.entries(TEXTOS_BASE)) {
    const r = comDadosDaUnidade(base, d);
    textos[nome] = r.texto;
    if (r.faltando.length) faltando[nome] = r.faltando;
  }
  return { textos, faltando };
}

const guardados = new Map<string, { chave: string; textos: Record<string, string> }>();

/**
 * Os textos que a régua usa para a unidade `slug`, ou `undefined` se a unidade não tem configuração (aí vale `TEXTOS_PARAU`, como sempre).
 * Guarda o resultado enquanto os dados da unidade não mudam.
 */
export function textosDoSlug(slug: string): Record<string, string> | undefined {
  const c = configDaUnidade(slug);
  if (!c) return undefined;
  const chave = JSON.stringify(c.dadosModelos);
  const g = guardados.get(slug);
  if (g && g.chave === chave) return g.textos;
  const { textos } = textosDaUnidade(c.dadosModelos);
  guardados.set(slug, { chave, textos });
  return textos;
}

// ── o modelo na Meta ─────────────────────────────────────────────────────────────────────────────

/** Os campos `{{…}}` do texto, sem repetir, na ordem da primeira aparição (a ordem de {{1}}, {{2}}… do modelo). */
export function camposDoTexto(texto: string): string[] {
  const campos: string[] = [];
  for (const m of texto.matchAll(/\{\{\s*([^}]+?)\s*\}\}/g)) if (!campos.includes(m[1]!)) campos.push(m[1]!);
  return campos;
}

/** O corpo como a Meta quer: campos viram {{1}}, {{2}}…; a ordem é a de `camposDoTexto`. */
export function corpoParaMeta(texto: string): { corpo: string; campos: string[] } {
  const campos = camposDoTexto(texto);
  const corpo = texto.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_t, nome: string) => `{{${campos.indexOf(nome) + 1}}}`);
  return { corpo, campos };
}

export interface ModeloParaMeta {
  /** nome na Meta, com o prefixo da unidade */
  name: string;
  language: 'pt_BR';
  category: CategoriaDoModelo;
  components: Array<Record<string, unknown>>;
}

export interface ModeloGerado {
  nomeBase: string;
  meta: ModeloParaMeta;
  campos: string[];
  inferido: boolean;
  /** problemas que a Meta recusaria; vazio = pode enviar */
  problemas: string[];
}

/** O que a Meta recusa, conferido ANTES de enviar. */
export function problemasDoModelo(m: ModeloParaMeta, campos: readonly string[]): string[] {
  const p: string[] = [];
  if (!/^[a-z0-9_]{1,512}$/.test(m.name)) p.push('nome do modelo fora do padrão (minúsculas, dígitos e _)');
  const corpo = String((m.components.find((c) => c.type === 'BODY') as { text?: string } | undefined)?.text ?? '');
  if (!corpo.trim()) p.push('corpo vazio');
  if (corpo.length > 1024) p.push(`corpo com ${corpo.length} caracteres (máximo 1024)`);
  if (/^\s*\{\{\d+\}\}/.test(corpo) || /\{\{\d+\}\}\s*$/.test(corpo)) p.push('a Meta recusa variável no começo ou no fim do corpo');
  if (/\{\{unidade\./.test(corpo)) p.push('sobrou marcador {{unidade.*}} sem dado da unidade');
  for (const c of m.components) {
    if (c.type === 'FOOTER' && String((c as { text?: string }).text ?? '').length > 60) p.push('rodapé com mais de 60 caracteres');
    if (c.type === 'BUTTONS') {
      const bs = ((c as { buttons?: Array<{ text?: string }> }).buttons ?? []);
      if (bs.length > 3) p.push('mais de 3 botões de resposta rápida');
      for (const b of bs) if (String(b.text ?? '').length > 25) p.push(`botão «${b.text}» com mais de 25 caracteres`);
    }
  }
  if (m.category === 'MARKETING' && !m.components.some((c) => c.type === 'FOOTER')) p.push('modelo de marketing sem rodapé de SAIR');
  for (const f of campos) if (!(f in EXEMPLOS_DOS_CAMPOS)) p.push(`sem valor de exemplo para o campo {{${f}}}`);
  return p;
}

/** O modelo `nomeBase` (`parau_x`) para a unidade (prefixo e dados dela), no formato da API de modelos da Meta. */
export function modeloParaMeta(nomeBase: string, texto: string, prefixo: string): ModeloGerado {
  const md = METADADOS_DOS_MODELOS[nomeBase];
  const { corpo, campos } = corpoParaMeta(texto);
  const nome = nomeDoModeloNaMeta(nomeBase, prefixo);
  const components: Array<Record<string, unknown>> = [
    {
      type: 'BODY',
      text: corpo,
      ...(campos.length ? { example: { body_text: [campos.map((c) => EXEMPLOS_DOS_CAMPOS[c] ?? 'Exemplo')] } } : {}),
    },
  ];
  if (md?.rodape) components.push({ type: 'FOOTER', text: RODAPE_SAIR });
  if (md?.botoes.length) components.push({ type: 'BUTTONS', buttons: md.botoes.map((text) => ({ type: 'QUICK_REPLY', text })) });
  const meta: ModeloParaMeta = { name: nome, language: 'pt_BR', category: md?.categoria ?? 'UTILITY', components };
  return { nomeBase, meta, campos, inferido: !!md?.inferido || !md, problemas: problemasDoModelo(meta, campos) };
}

/** Todos os modelos da régua para a unidade (dados + prefixo). */
export function modelosDaUnidade(d: DadosDosModelos, prefixo: string): { modelos: ModeloGerado[]; faltando: Record<string, string[]> } {
  const { textos, faltando } = textosDaUnidade(d);
  return { modelos: Object.entries(textos).map(([nome, t]) => modeloParaMeta(nome, t, prefixo)), faltando };
}

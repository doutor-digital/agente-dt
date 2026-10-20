/**
 * Casamento cartão ↔ paciente da franquia e jornada — as regras que o João decidiu em 16/10/2026.
 *
 * Tudo aqui fica atrás da chave `casamento-jornada` (tela de Automações), por unidade:
 *  - desligado: o robô faz exatamente o que fazia antes;
 *  - só no papel: o robô continua agindo pelas regras antigas e registra na tela o que as novas fariam
 *    de diferente (etiqueta, nota, tarefa, etapa, cadastro);
 *  - ligado: as regras novas valem.
 *
 * As decisões (16/10/2026):
 *  1. Dois pacientes da franquia com o MESMO telefone: etiqueta CONFLITO_FRANQUIA no cartão, nada é gravado; a SDR
 *     escolhe uma vez no widget qual é o paciente; o `⚙ idClient (franquia)` fica gravado no cartão e, dali em
 *     diante, o casamento usa o idClient e não pergunta de novo.
 *  2. Ex-paciente que volta vai para RETORNO PÓS-TRATAMENTO. Tratamento FINALIZADO nunca leva o cartão para GANHO.
 *     A Sofia não tira o cartão do funil TRATAMENTO.
 *  3. Casamento (o robô CONFERIR / revisão): idClient → telefone → nome (nome só no fim).
 *  4. Falta em RETORNO ou em SESSÃO não muda a etapa: vira nota + tarefa no cartão.
 *  5. A âncora da jornada é a última AVALIAÇÃO do paciente.
 *  6. Cancelou na franquia: o robô continua movendo (sem mudança).
 *  7. Robô × SDR em conflito: a franquia manda.
 *
 * Este arquivo é a parte PURA (decisão e textos) mais a porta da chave. Quem lê a franquia e escreve no Kommo
 * continua sendo o sincronizador (`franquia-sync-worker.ts`); a máquina de etapas mora em `franquia-move.ts`.
 */
import { SPINE_STATUS, type SpineSchedule } from '../services/spine.service.js';
import { estadoDaAutomacao, type Estado } from './automacoes-estado.js';
import { chaveTelefone, ehAvaliacao, ehConsulta, nomeDaFranquia, nomeParaBusca, normalizar } from './franquia-sync.js';
import { normalizarNome } from './kommo-schema.js';

export const ID_AUTOMACAO = 'casamento-jornada';

/** A chave por unidade (tela de Automações; sem linha no banco vale `CASAMENTO_JORNADA_SLUGS`). */
export function estadoCasamentoJornada(slug: string, raw: string | undefined = process.env.CASAMENTO_JORNADA_SLUGS): Estado {
  return estadoDaAutomacao(slug, ID_AUTOMACAO, raw);
}

/** Etiqueta que a SDR filtra no Kommo. A mesma do conflito antigo (cartão com `⚙ idClient` de outro paciente). */
export const TAG_CONFLITO = 'CONFLITO_FRANQUIA';

/** Campo do cartão onde mora o paciente da franquia (gravado pela carga, pela marcação do widget e pela escolha da SDR). */
export const CAMPO_ID_CLIENT = '⚙ idClient (franquia)';

// ── decisão 1 e 3: quem é o paciente deste cartão ─────────────────────────────────────────────────

export type ClienteCandidato = { idClient: number | null; name: string | null; whatsapp: string | null };

export type EscolhaDoPaciente =
  | { tipo: 'achou'; idClient: number; por: 'idClient' | 'telefone' | 'nome' }
  /** Mais de um paciente DIFERENTE (nomes diferentes) no mesmo telefone: quem decide é a SDR, no widget. */
  | { tipo: 'conflito'; candidatos: ClienteCandidato[] }
  /** O mesmo nome e o mesmo telefone em dois cadastros = o mesmo paciente cadastrado duas vezes: fica o de agenda mais recente. */
  | { tipo: 'desempatar'; candidatos: ClienteCandidato[] }
  | { tipo: 'nenhum'; motivo: 'sem candidatos' | 'homonimos' | 'nome nao casa' };

export interface EntradaDaEscolha {
  /** `⚙ idClient (franquia)` gravado no cartão, ou o vínculo que a Sofia gravou (no cadastro, já conferido pelo nome). */
  idDoCartao: number | null;
  /** Candidatos que a busca por NOME na franquia devolveu (a franquia não busca por telefone). */
  candidatos: ClienteCandidato[];
  /** Pacientes dos OUTROS cartões do Kommo com o mesmo telefone (campo ⚙ ou vínculo da Sofia), com o nome da franquia. */
  irmaos?: ClienteCandidato[];
  /** Telefone do cartão, já em `chaveTelefone` ('' = desconhecido). */
  fone: string;
  /** Termos do título do cartão, já normalizados por `nomeDaFranquia`. */
  alvos: Set<string>;
  /** O nome de quem é o cartão (título, ou o nome que a Sofia vai cadastrar) — para conferir irmãos e, no cadastro, tudo. */
  nome?: string | null;
  /**
   * `robo` (sincronizador): o telefone da franquia manda, o nome não importa (regra de 23/09). `cadastro` (a Sofia vai criar
   * alguém): o paciente do telefone só vale se o nome bater — a filha marcando pelo WhatsApp da mãe é OUTRA pessoa.
   */
  modo?: 'robo' | 'cadastro';
}

/**
 * PURA. A ordem do João (16/10/2026): **idClient → telefone → nome**.
 *  1. idClient: o que está no cartão (ou no vínculo) é o paciente, sem buscar nada.
 *  2. telefone: candidato da franquia com o mesmo telefone; sem ele, outro cartão do Kommo com o mesmo telefone que já sabe
 *     o idClient. Dois pacientes DIFERENTES no mesmo telefone = conflito (a SDR escolhe), nunca escolha automática.
 *  3. nome: só nome exato e único, e nunca contra um telefone diferente do que o cartão conhece.
 */
export function escolherPacienteDoCartao(e: EntradaDaEscolha): EscolhaDoPaciente {
  if (e.idDoCartao && e.idDoCartao > 0) return { tipo: 'achou', idClient: e.idDoCartao, por: 'idClient' };
  const cadastro = e.modo === 'cadastro';
  const bateNome = (c: ClienteCandidato) => !!e.nome && nomeCompativelComTitulo(e.nome, c.name);
  const vivos = dedupe(e.candidatos.filter((c) => c.idClient));
  if (e.fone) {
    const doTelefoneTodos = vivos.filter((c) => chaveTelefone(c.whatsapp) === e.fone);
    // no cadastro, o paciente do telefone com OUTRO nome é outra pessoa da família: não casa (cadastra a pessoa nova)
    const doTelefone = cadastro ? doTelefoneTodos.filter(bateNome) : doTelefoneTodos;
    // o irmão do Kommo só vale com nome compatível (o cartão irmão pode ser de outro paciente do mesmo número)
    const extras = dedupe((e.irmaos ?? []).filter((c) => c.idClient && bateNome(c))).filter((c) => !doTelefone.some((x) => x.idClient === c.idClient));
    const todos = [...doTelefone, ...extras];
    if (todos.length === 1) return { tipo: 'achou', idClient: todos[0].idClient as number, por: 'telefone' };
    if (todos.length > 1) {
      // nome desconhecido não prova que é a mesma pessoa: conta como pessoa diferente
      const nomes = new Set(todos.map((c) => (c.name ? nomeDaFranquia(c.name) : `?${c.idClient}`)));
      return nomes.size > 1 ? { tipo: 'conflito', candidatos: todos } : { tipo: 'desempatar', candidatos: todos };
    }
    if (cadastro && doTelefoneTodos.length > 0) return { tipo: 'nenhum', motivo: 'nome nao casa' };
  }
  const exatos = vivos.filter((c) => e.alvos.has(nomeDaFranquia(c.name)) && (!e.fone || !chaveTelefone(c.whatsapp) || chaveTelefone(c.whatsapp) === e.fone));
  if (exatos.length === 1) return { tipo: 'achou', idClient: exatos[0].idClient as number, por: 'nome' };
  if (vivos.length === 0) return { tipo: 'nenhum', motivo: 'sem candidatos' };
  return { tipo: 'nenhum', motivo: exatos.length > 1 ? 'homonimos' : 'nome nao casa' };
}

const PARTICULAS = new Set(['da', 'de', 'do', 'das', 'dos', 'e']);

function partesDoNome(n: string | null | undefined): string[] {
  return nomeDaFranquia(n).split(' ').filter((p) => p.length >= 2 && !PARTICULAS.has(p));
}

/** Distância de edição (Levenshtein), para "ALEXANDRO" × "ALEXSANDRO". */
function distancia(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array<number>(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  }
  return d[a.length][b.length];
}

function parecido(a: string, b: string): boolean {
  if (a === b) return true;
  if (a.length < 5 || b.length < 5) return false;
  return distancia(a, b) <= (Math.max(a.length, b.length) >= 8 ? 2 : 1);
}

/**
 * PURA. Dois nomes podem ser a MESMA pessoa? O primeiro nome tem de bater (com folga de digitação) e, quando os dois têm
 * sobrenome, pelo menos um sobrenome em comum. "Ana Souza" × "Maria Souza" = não (mãe e filha); "Maria Souza" × "MARIA DA
 * SILVA SOUZA" = sim; sem nome de um dos lados = não (sem nome não se prova nada).
 */
export function nomeCompativel(a: string | null | undefined, b: string | null | undefined): boolean {
  const pa = partesDoNome(a);
  const pb = partesDoNome(b);
  if (pa.length === 0 || pb.length === 0) return false;
  if (!parecido(pa[0], pb[0])) return false;
  const sa = pa.slice(1);
  const sb = pb.slice(1);
  if (sa.length === 0 || sb.length === 0) return true;
  return sa.some((x) => sb.some((y) => parecido(x, y)));
}

/** O título do cartão pode ter duas pessoas ("MARIA DA PENHA - ALEXANDRO SANT ANA"): vale se alguma delas bater. */
export function nomeCompativelComTitulo(titulo: string | null | undefined, nome: string | null | undefined): boolean {
  const pessoas = nomeParaBusca(titulo).split(/\s+[/\-–]\s+|\//).map((x) => x.trim()).filter(Boolean);
  return pessoas.some((p) => nomeCompativel(p, nome));
}

function dedupe(lista: ClienteCandidato[]): ClienteCandidato[] {
  const vistos = new Map<number, ClienteCandidato>();
  for (const c of lista) if (c.idClient && !vistos.has(c.idClient)) vistos.set(c.idClient, c);
  return [...vistos.values()];
}

/**
 * PURA. Na varredura da agenda, vários pacientes podem cair no MESMO cartão (o casamento é pelo telefone). Devolve os cartões
 * que receberam pacientes diferentes — é o caso do cartão que alternava idade 51↔81 a cada 15 min (Petrópolis, 14/10).
 * `quem` identifica o paciente: o idClient quando se sabe, senão o nome normalizado.
 */
export function cartoesComMaisDeUmPaciente(casados: Array<{ leadId: number | null; quem: string }>): Map<number, string[]> {
  const porCartao = new Map<number, Set<string>>();
  for (const c of casados) {
    if (!c.leadId) continue;
    const s = porCartao.get(c.leadId) ?? new Set<string>();
    s.add(c.quem);
    porCartao.set(c.leadId, s);
  }
  const out = new Map<number, string[]>();
  for (const [leadId, s] of porCartao) if (s.size > 1) out.set(leadId, [...s]);
  return out;
}

/** Quem é o paciente, para `cartoesComMaisDeUmPaciente`: idClient quando se sabe; senão o nome. */
export function identidadeDoPaciente(idClient: number | null | undefined, idsClient: number[], nome: string): string {
  const id = idClient ?? idsClient[0] ?? null;
  return id ? `id:${id}` : `nome:${normalizar(nome)}`;
}

export function notaConflitoDeTelefone(pacientes: Array<{ idClient: number | null; nome?: string | null }>): string {
  const lista = pacientes.map((p) => (p.idClient ? `idClient ${p.idClient}${p.nome ? ` (${p.nome})` : ''}` : (p.nome ?? 'sem id'))).join(' e ');
  return `⚠ Dois pacientes da franquia usam o telefone deste cartão: ${lista}. O robô não grava nada aqui até alguém escolher qual deles é o dono do cartão. Escolha no widget do cartão (bloco da franquia → "Qual é o paciente deste cartão?"). Escolhido, o ⚙ idClient fica gravado e o robô não pergunta de novo. Etiqueta ${TAG_CONFLITO}.`;
}

/** ruleKey (tabela `card_alert`) que guarda os candidatos do conflito: o widget lê daqui quem oferecer. */
export const PREFIXO_CONFLITO = 'conflito-franquia:';
/** ruleKey que lembra a escolha da SDR: com ela, o conflito com outro paciente não volta a pedir decisão. */
export const PREFIXO_ESCOLHA = 'paciente-escolhido:';

export function chaveDoConflito(ids: number[]): string {
  return `${PREFIXO_CONFLITO}${[...new Set(ids)].sort((a, b) => a - b).join(',')}`;
}

export function idsDoConflito(ruleKey: string): number[] {
  if (!ruleKey.startsWith(PREFIXO_CONFLITO)) return [];
  return ruleKey.slice(PREFIXO_CONFLITO.length).split(',').map(Number).filter((n) => Number.isInteger(n) && n > 0);
}

// ── decisão 4: falta em RETORNO ou SESSÃO vira nota + tarefa ─────────────────────────────────────

/** Só falta recente vira tarefa: o histórico velho de faltas não pode encher o cartão no dia em que a chave liga. */
export const FALTA_AVISO_MAX_DIAS = 7;

function epochDe(s: Pick<SpineSchedule, 'dateAttendanceUtc'>): number | null {
  if (!s.dateAttendanceUtc) return null;
  const t = Math.floor(Date.parse(s.dateAttendanceUtc) / 1000);
  return Number.isFinite(t) ? t : null;
}

function ehSessao(s: Pick<SpineSchedule, 'categoryName'>): boolean {
  return !!normalizar(s.categoryName) && !ehConsulta(s);
}

export type TipoDeFalta = 'sessão' | 'retorno';

/**
 * PURA. As faltas que viram nota + tarefa (decisão 4): falta em SESSÃO, falta em consulta de RETORNO (qualquer
 * consulta que não é avaliação) e qualquer falta de quem está na etapa RETORNO PÓS-TRATAMENTO. Falta em AVALIAÇÃO
 * continua sendo da máquina de etapas (NÃO COMPARECEU). Só as dos últimos `FALTA_AVISO_MAX_DIAS` dias.
 */
export function faltasParaAvisar(e: { agendamentos: SpineSchedule[]; etapa: string | null; agoraEpoch: number }): Array<{ s: SpineSchedule; tipo: TipoDeFalta }> {
  const emRetorno = !!e.etapa && normalizarNome(e.etapa) === normalizarNome('RETORNO PÓS-TRATAMENTO');
  const out: Array<{ s: SpineSchedule; tipo: TipoDeFalta }> = [];
  const vistos = new Set<number>();
  for (const s of e.agendamentos) {
    if (s.idStatus !== SPINE_STATUS.NAO_COMPARECEU || !s.idSchedule || vistos.has(s.idSchedule)) continue;
    const t = epochDe(s);
    if (t === null || t > e.agoraEpoch || e.agoraEpoch - t > FALTA_AVISO_MAX_DIAS * 86_400) continue;
    let tipo: TipoDeFalta | null = null;
    if (ehSessao(s)) tipo = 'sessão';
    else if (ehConsulta(s) && (!ehAvaliacao(s) || emRetorno)) tipo = 'retorno';
    if (!tipo) continue;
    vistos.add(s.idSchedule);
    out.push({ s, tipo });
  }
  return out;
}

export function chaveDaFalta(idSchedule: number): string {
  return `falta-franquia:${idSchedule}`;
}

function quando(s: SpineSchedule): string {
  if (s.dayLocal && s.timeLocal) return `${s.dayLocal.split('-').reverse().join('/')} às ${s.timeLocal}`;
  return s.dateAttendanceLocal ?? s.dateAttendanceUtc ?? '';
}

export function notaDaFalta(f: { s: SpineSchedule; tipo: TipoDeFalta }): string {
  const oQue = f.tipo === 'sessão' ? 'à sessão' : `ao ${f.s.categoryName ? `atendimento "${f.s.categoryName}"` : 'retorno'}`;
  return `📌 Falta registrada na franquia: o paciente faltou ${oQue} de ${quando(f.s)}. Pela regra de 16/10, falta em retorno ou sessão NÃO muda a etapa do cartão — ficou uma tarefa para ligar e remarcar.`;
}

export function tarefaDaFalta(f: { s: SpineSchedule; tipo: TipoDeFalta }): string {
  return `Faltou ${f.tipo === 'sessão' ? 'à sessão' : 'ao retorno'} de ${quando(f.s)}: ligar, entender o motivo e remarcar na franquia.`;
}

// ── decisão 7: "a franquia manda" no PERDIDO e na ALTA, uma vez por fato ─────────────────────────

export type EtapaQueAFranquiaReabre = 'PERDIDO' | 'ALTA';

/** ruleKey (card_alert) de "já tirei este cartão desta etapa por este fato" — durável, sobrevive a deploy. */
export function chaveDaDevolucao(etapa: EtapaQueAFranquiaReabre, gatilho: string): string {
  return `franquia-manda:${etapa}:${gatilho}`;
}
/** ruleKey da tarefa "a equipe pôs de volta, conferir" — também uma vez por fato. */
export function chaveDaTarefaDeDevolucao(etapa: EtapaQueAFranquiaReabre, gatilho: string): string {
  return `franquia-manda-tarefa:${etapa}:${gatilho}`;
}

function oQueAFranquiaTem(gatilho: string): string {
  return gatilho === 'sessao' ? 'sessão de tratamento marcada' : 'consulta marcada';
}

export function notaDaDevolucao(etapa: EtapaQueAFranquiaReabre, para: string, gatilho: string): string {
  return `↩ A franquia tem ${oQueAFranquiaTem(gatilho)} para este paciente, então o robô tirou o cartão de ${etapa} e levou para ${para} (regra de 16/10: a franquia manda). Se o certo é ${etapa}, desmarque na franquia. Se alguém puser o cartão de volta em ${etapa}, o robô não insiste: deixa onde está e abre uma tarefa para conferir.`;
}

export function tarefaDaDevolucao(etapa: EtapaQueAFranquiaReabre, gatilho: string): string {
  return `Conferir: a franquia tem ${oQueAFranquiaTem(gatilho)}, mas o cartão voltou para ${etapa}. Se o paciente não vem, desmarque na franquia; se vem, tire o cartão de ${etapa}.`;
}

// ── mesmo nome e mesmo telefone em dois cadastros: o robô escolhe e avisa uma vez ─────────────────

export function chaveDoDuplicado(ids: number[]): string {
  return `duplicado-franquia:${[...new Set(ids)].sort((a, b) => a - b).join(',')}`;
}

export function notaCadastroDuplicado(ids: number[], escolhido: number | null): string {
  const lista = [...new Set(ids)].sort((a, b) => a - b).join(' e ');
  return `ℹ A franquia tem ${ids.length > 2 ? 'mais de um cadastro' : 'dois cadastros'} do mesmo paciente (mesmo nome e mesmo telefone): idClient ${lista}. O robô usa ${escolhido ? `o ${escolhido}` : 'o cadastro'} com a agenda mais recente. Peça à unidade para juntar os cadastros na franquia.`;
}

// ── tratamento FINALIZADO com sessão ainda marcada: sujeira da franquia, vira tarefa (não move) ──

export function chaveDaSujeira(idSchedule: number | string): string {
  return `franquia-sujeira:sessao:${idSchedule}`;
}

export function tarefaDaSujeira(s: Pick<SpineSchedule, 'dayLocal' | 'timeLocal' | 'dateAttendanceLocal' | 'dateAttendanceUtc'>): string {
  const quandoFoi = s.dayLocal && s.timeLocal ? `${s.dayLocal.split('-').reverse().join('/')} às ${s.timeLocal}` : (s.dateAttendanceLocal ?? s.dateAttendanceUtc ?? '');
  return `Conferir na franquia: o tratamento está FINALIZADO, mas ainda há sessão marcada (${quandoFoi}). Desmarque a sessão, ou reabra o tratamento se o paciente continua. O cartão não foi movido por causa disso.`;
}

/** ruleKey de "o ROBÔ pôs este cartão nesta etapa" — é o que separa "a equipe pôs de volta" de "o próprio robô pôs". */
export function chaveDoRoboPos(etapa: EtapaQueAFranquiaReabre): string {
  return `robo-pos:${etapa}`;
}

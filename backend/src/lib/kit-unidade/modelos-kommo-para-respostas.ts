/**
 * MODELOS DE CHAT DO KOMMO → RESPOSTAS PRONTAS DO CRM (canned responses do Chatwoot), 25/11/2026.
 *
 * Unidade que sai do Kommo (Timbó) leva para o CRM os «Modelos gerais» que a equipe tinha (`GET /api/v4/chats/templates`, `type: "amocrm"`:
 * texto livre; os `waba` são modelos da Meta e seguem na WABA — o Chatwoot os sincroniza sozinho). Parte PURA, sem rede: o script
 * `scripts/importar-modelos-kommo.ts` busca, chama isto e (só com `--aplicar`) grava.
 *
 * Regras (cada uma existe por um motivo):
 *  - o atalho é `<prefixo>-<nome-do-modelo>` (`timbocrm-lead-primeiro-contato`): casa pelo atalho, então rodar duas vezes não duplica;
 *  - atalho que já existe no CRM NUNCA é sobrescrito (a equipe pode ter editado): igual → «já existe»; texto diferente → «divergente», só avisa;
 *  - `{{contact.name}}` vira `{{contact.first_name}}` (o Chatwoot troca na hora de usar; é o primeiro nome que a equipe escreve);
 *  - `{{lead.cf.N}}` (campo do cartão do Kommo: no CRM não existe) vira `[Nome do campo]`, como a Ponte já faz (`respostasProntas`): a atendente
 *    vê o que completar. Qualquer outro `{{…}}` desconhecido também vira `[…]` e é listado nos avisos.
 */
import type { KommoChatTemplate } from '../../services/kommo.service.js';
import { respostasProntas } from '../ponte-respostas.js';

export type Situacao = 'criar' | 'ja-existe' | 'divergente' | 'bloqueado' | 'de-fora';

export interface LinhaDaImportacao {
  /** atalho depois da barra (sem a barra) */
  atalho: string;
  /** nome do modelo no Kommo, sem o ⚡ */
  nome: string;
  kommoId: number;
  texto: string;
  situacao: Situacao;
  /** marcadores do Kommo que o CRM não troca sozinho (viraram «[…]»), e o que impede de criar (`bloqueado`) */
  avisos: string[];
  /** o modelo tem arquivo anexo no Kommo: só o texto vai para o CRM */
  temAnexo: boolean;
  /** o que a atendente precisa completar à mão: `[Campo do cartão]` e `⟨hora⟩` */
  completar: string[];
  /** `ja-existe` por ter o MESMO texto sob outro atalho (não vira dois atalhos) */
  igualA?: string;
  /** `de-fora`: por que não entra */
  motivo?: string;
}

export interface ExistenteNoCrm {
  short_code: string;
  content: string;
}

export interface OpcoesDoPlano {
  /** a unidade não aceita pagamento antecipado (`unidadeSemAntecipado`, a mesma decisão do guia e do cartão): os modelos «Financeiro …» (cobrança de parcela) ficam de fora */
  semAntecipado?: boolean;
}

/** `⚡ Lead primeiro contato` → `lead-primeiro-contato` (sem acento, minúsculas, só letras/dígitos e hífen). O acento sai ANTES de limpar o resto (texto decomposto não vira espaço). */
export function atalhoDoNome(nome: string): string {
  return nome
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '');
}

/** Para comparar: o Kommo manda `\r\n`, o Chatwoot guarda `\n`; espaço no fim da linha não é diferença. */
export const normalizar = (t: string): string => t.replace(/\r\n?/g, '\n').split('\n').map((l) => l.trimEnd()).join('\n').trim();

/** O texto do Kommo na linguagem do Chatwoot (sem `\r`). Os `{{lead.cf.N}}` já chegam trocados por `[Campo]` (`respostasProntas`). */
export function textoParaOCrm(texto: string): string {
  return texto.replace(/\r\n?/g, '\n').replace(/\{\{\s*contact\.(?:first_)?name\s*\}\}/gi, '{{contact.first_name}}');
}

/** Sobrou `{{` ou `}}` que não é o `{{contact.first_name}}`? (marcador vazio, quebrado, com chave dentro, maior que 80 caracteres, triplo…) */
export function chaveSolta(textoDoCrm: string): boolean {
  if (/\{\{\{|\}\}\}/.test(textoDoCrm)) return true;
  return /\{\{|\}\}/.test(textoDoCrm.replace(/\{\{contact\.first_name\}\}/g, ''));
}

/** O que a atendente completa à mão: `[Nome do campo]` (que veio de `{{lead.cf.N}}`) e `⟨hora⟩` (que a equipe já escrevia nos modelos). */
export function paraCompletar(textoDoCrm: string): string[] {
  const out: string[] = [];
  for (const m of textoDoCrm.matchAll(/\[[^\[\]\n]{1,80}\]|⟨[^⟩\n]{1,40}⟩/g)) if (!out.includes(m[0])) out.push(m[0]);
  return out;
}

/** Marcadores `{{…}}` do Kommo que o CRM não sabe traduzir (campo sem nome na conta, `{{profile.name}}`…): viram `[…]` e são avisados. */
function avisosDoTexto(textoOriginal: string, nomeDoCampo: (id: number) => string | null): string[] {
  const out: string[] = [];
  for (const m of textoOriginal.matchAll(/\{\{([^{}]{1,80})\}\}/g)) {
    const dentro = m[1]!.trim();
    if (/^contact\.(?:first_)?name$/i.test(dentro)) continue;
    const cf = /^lead\.cf\.(\d+)$/i.exec(dentro);
    if (cf && nomeDoCampo(Number(cf[1]))) continue;
    if (!out.includes(dentro)) out.push(dentro);
  }
  return out;
}

/** Nomes dos modelos que só existem para quem aceita pagamento antecipado (cobrança de parcela, dados do Pix, pré-pagamento). */
const NOME_DE_PAGAMENTO = /^(?:financeiro|consulta-dados-pix|consulta-prepagamento)(?:-|$)/;
/** Texto que pede Pix, sinal ou pagamento antecipado (não pega «sinal de alerta»). */
const TEXTO_DE_PAGAMENTO = /\bpix\b|\bsinal\s+(?:de\s+)?(?:reserva|r\$|\d|antecipado)|pagamento\s+antecipado|pr[eé]-?\s?pagamento/i;
/** Em conta SEM antecipado este modelo não serve: pelo nome (a lista acima) ou porque o texto pede Pix/sinal. */
export const pedePagamentoAntecipado = (nome: string, texto: string): boolean => NOME_DE_PAGAMENTO.test(atalhoDoNome(nome)) || TEXTO_DE_PAGAMENTO.test(texto);

/**
 * O plano: uma linha por modelo geral do Kommo. `prefixo` sem o `_` (`timbocrm`). Dois modelos do Kommo que dariam o MESMO atalho ficam
 * os dois com o id do Kommo no fim (`timbocrm-retorno-123`): o atalho não depende de quem vem antes na lista, então apagar ou
 * acrescentar um modelo no Kommo nunca troca o texto de um atalho já criado.
 *
 * Situações: `criar`; `ja-existe` (mesmo atalho com o mesmo texto, OU o mesmo texto já existe sob outro atalho — nunca vira dois atalhos);
 * `divergente` (o atalho existe com outro texto: não sobrescreve); `bloqueado` (sobrou `{{`/`}}` que o CRM mostraria cru: NÃO é criado);
 * `de-fora` (unidade sem antecipado: modelos «Financeiro»). LANÇA se dois atalhos do plano saírem iguais (a rodada inteira para).
 */
export function planejarImportacao(
  modelos: ReadonlyArray<KommoChatTemplate>,
  nomeDoCampo: (id: number) => string | null,
  existentes: ReadonlyArray<ExistenteNoCrm>,
  prefixo: string,
  opcoes: OpcoesDoPlano = {},
): LinhaDaImportacao[] {
  const p = atalhoDoNome(prefixo.replace(/_+$/, ''));
  if (!p) throw new Error('prefixo dos modelos vazio: o atalho ficaria sem o nome da unidade');
  const noCrm = new Map(existentes.map((e) => [e.short_code, e.content]));
  // «mesmo texto» só vale sob um atalho DESTA unidade (a conta pode ser dividida: o /outra-saudacao de outra unidade não pode impedir o nosso)
  const textoJaNoCrm = new Map(existentes.filter((e) => e.short_code.startsWith(`${p}-`)).map((e) => [normalizar(e.content), e.short_code]));
  const originais = new Map(modelos.map((m) => [m.id, String(m.content ?? '')]));
  const prontas = respostasProntas(modelos, nomeDoCampo).map((r) => {
    const nome = r.nome.replace(/^[^\p{L}\p{N}]+/u, '').trim() || `modelo ${r.id}`;
    return { r, nome, base: `${p}-${atalhoDoNome(nome) || `modelo-${r.id}`}` };
  });
  const quantos = new Map<string, number>();
  for (const x of prontas) quantos.set(x.base, (quantos.get(x.base) ?? 0) + 1);
  const textoNaRodada = new Map<string, string>();
  const linhas = prontas.map(({ r, nome, base }): LinhaDaImportacao => {
    const atalho = (quantos.get(base) ?? 0) > 1 ? `${base}-${r.id}` : base;
    const texto = textoParaOCrm(r.texto);
    const avisos = avisosDoTexto(originais.get(r.id) ?? '', nomeDoCampo);
    const comum = { atalho, nome, kommoId: r.id, texto, temAnexo: r.temAnexo, completar: paraCompletar(texto) };
    if (opcoes.semAntecipado && pedePagamentoAntecipado(nome, texto)) return { ...comum, situacao: 'de-fora', avisos, motivo: 'sem pagamento antecipado' };
    if (chaveSolta(texto)) return { ...comum, situacao: 'bloqueado', avisos: [...avisos, 'sobrou «{{» ou «}}» fora do padrão: o CRM mostraria o marcador cru'] };
    const ja = noCrm.get(atalho);
    if (ja !== undefined) return { ...comum, situacao: normalizar(ja) === normalizar(texto) ? 'ja-existe' : 'divergente', avisos };
    const igual = textoJaNoCrm.get(normalizar(texto)) ?? textoNaRodada.get(normalizar(texto));
    if (igual !== undefined) return { ...comum, situacao: 'ja-existe', avisos, igualA: igual };
    textoNaRodada.set(normalizar(texto), atalho);
    return { ...comum, situacao: 'criar', avisos };
  });
  const vistos = new Map<string, number>();
  for (const l of linhas) vistos.set(l.atalho, (vistos.get(l.atalho) ?? 0) + 1);
  const repetidos = [...vistos].filter(([, n]) => n > 1).map(([a]) => `/${a}`);
  if (repetidos.length) throw new Error(`atalho repetido no plano (a rodada parou, nada foi escrito): ${repetidos.join(', ')}`);
  return linhas;
}

/**
 * Os modelos de um BACKUP em JSON (a lista que a API `chats/templates` devolvia, guardada antes de apagar do Kommo), no lugar da API.
 * Só confere o formato (lista de objetos com `id` e `name`) e devolve; as regras de importação são as mesmas de quem veio da API. Formato
 * inesperado LANÇA: nunca vira «lista vazia» em silêncio.
 */
export const BACKUP_MAX_BYTES = 1_000_000;
export const BACKUP_MAX_MODELOS = 500;

/** Lê o backup da entrada (assíncrono: `readFileSync(0)` pode dar EAGAIN em pipe) parando no limite de tamanho. */
export async function lerBackup(fonte: AsyncIterable<Buffer | string>): Promise<string> {
  const partes: Buffer[] = [];
  let total = 0;
  for await (const c of fonte) {
    const b = typeof c === 'string' ? Buffer.from(c, 'utf8') : c;
    total += b.length;
    if (total > BACKUP_MAX_BYTES) throw new Error(`o arquivo passa de ${BACKUP_MAX_BYTES} bytes (não é um backup de modelos)`);
    partes.push(b);
  }
  return Buffer.concat(partes).toString('utf8');
}

export function modelosDoBackup(json: string): KommoChatTemplate[] {
  if (Buffer.byteLength(json, 'utf8') > BACKUP_MAX_BYTES) throw new Error(`o arquivo passa de ${BACKUP_MAX_BYTES} bytes (não é um backup de modelos)`);
  let dados: unknown;
  try {
    dados = JSON.parse(json);
  } catch {
    throw new Error('o arquivo não é um JSON válido');
  }
  if (!Array.isArray(dados) || dados.length === 0) throw new Error('o arquivo precisa ser uma lista de modelos (não vazia)');
  if (dados.length > BACKUP_MAX_MODELOS) throw new Error(`o arquivo tem ${dados.length} modelos (máximo ${BACKUP_MAX_MODELOS})`);
  const ids = new Set<number>();
  return dados.map((x, i) => {
    const m = x as Partial<KommoChatTemplate> | null;
    if (!m || typeof m !== 'object' || !Number.isInteger(m.id) || typeof m.name !== 'string') throw new Error(`modelo ${i + 1} do arquivo sem «id» numérico e «name»`);
    if (m.content !== undefined && m.content !== null && typeof m.content !== 'string') throw new Error(`modelo ${i + 1} do arquivo com «content» que não é texto`);
    if (ids.has(m.id as number)) throw new Error(`o id ${m.id} aparece duas vezes no arquivo`);
    ids.add(m.id as number);
    return { id: m.id as number, name: m.name, content: typeof m.content === 'string' ? m.content : '', type: m.type ?? null, attachment: m.attachment ?? null };
  });
}

// ── o roteiro (sem rede: as portas são de quem chama) ──

/** O que o script precisa de fora (o teste troca por mentira). */
export interface Portas {
  modelosDoKommo(): Promise<KommoChatTemplate[]>;
  nomeDoCampo(): Promise<(id: number) => string | null>;
  respostasDoCrm(): Promise<ExistenteNoCrm[]>;
  criarNoCrm(atalho: string, texto: string): Promise<void>;
}

export interface Resultado {
  linhas: LinhaDaImportacao[];
  /** o que NÃO entra, por motivo (modelo do WhatsApp fica na WABA; sem texto não há o que levar) */
  deFora: { waba: number; semTexto: number };
  criadas: string[];
  falhas: Array<{ atalho: string; erro: string }>;
}

export async function importar(portas: Portas, prefixo: string, aplicar: boolean, opcoes: OpcoesDoPlano = {}): Promise<Resultado> {
  const [modelos, nomeDoCampo, existentes] = await Promise.all([portas.modelosDoKommo(), portas.nomeDoCampo(), portas.respostasDoCrm()]);
  const linhas = planejarImportacao(modelos, nomeDoCampo, existentes, prefixo, opcoes);
  const criadas: string[] = [];
  const falhas: Array<{ atalho: string; erro: string }> = [];
  if (aplicar) {
    for (const l of linhas.filter((x) => x.situacao === 'criar')) {
      try {
        await portas.criarNoCrm(l.atalho, l.texto);
        criadas.push(l.atalho);
      } catch (e) {
        falhas.push({ atalho: l.atalho, erro: String(e instanceof Error ? e.message : e).slice(0, 120) });
      }
    }
  }
  const ehWaba = (m: KommoChatTemplate) => { const t = String(m.type ?? '').trim().toLowerCase(); return t === 'waba' || t.includes('whatsapp'); };
  const waba = modelos.filter(ehWaba).length;
  return { linhas, deFora: { waba, semTexto: modelos.length - waba - linhas.length }, criadas, falhas };
}

const ROTULO = { criar: 'CRIAR', 'ja-existe': 'já existe', divergente: 'DIVERGENTE (não sobrescrevo)', bloqueado: 'BLOQUEADO (não crio)', 'de-fora': 'de fora' } as const;

export function relatorio(r: Resultado, aplicar: boolean): string[] {
  const l: string[] = [];
  for (const x of r.linhas) {
    const feito = aplicar && r.criadas.includes(x.atalho) ? ' → CRIADA' : aplicar && r.falhas.some((f) => f.atalho === x.atalho) ? ' → FALHOU' : '';
    const extras = [
      x.igualA ? `mesmo texto de /${x.igualA}` : '',
      x.motivo ? x.motivo : '',
      x.avisos.length ? `ATENÇÃO ${x.situacao === 'bloqueado' ? '' : 'marcador não traduzido: '}${x.avisos.join(', ')}` : '',
      x.completar.length ? `para completar: ${x.completar.join(' ')}` : '',
      x.temAnexo ? 'ATENÇÃO: tem anexo no Kommo, só o texto vai' : '',
    ].filter(Boolean);
    l.push(`  /${x.atalho}  [${ROTULO[x.situacao]}${feito}]  (${x.texto.length} car.)${extras.length ? `  ${extras.join(' · ')}` : ''}`);
  }
  const por = (s: string) => r.linhas.filter((x) => x.situacao === s).length;
  const comCompletar = r.linhas.filter((x) => x.situacao === 'criar' && x.completar.length).length;
  l.push(`${r.linhas.length} modelo(s) de texto livre: ${por('criar')} a criar, ${por('ja-existe')} já existem, ${por('divergente')} divergentes, ${por('bloqueado')} bloqueados, ${por('de-fora')} de fora (sem pagamento antecipado). Também ficam de fora: ${r.deFora.waba} do WhatsApp (já estão na WABA) e ${r.deFora.semTexto} sem texto.`);
  l.push(`${comCompletar} modelo(s) a criar têm algo para a atendente completar à mão ([Campo] ou ⟨…⟩).`);
  if (aplicar) l.push(`Criadas agora: ${r.criadas.length}. Falhas: ${r.falhas.length}${r.falhas.length ? ` (${r.falhas.map((f) => `/${f.atalho}: ${f.erro}`).join('; ')})` : ''}.`);
  else if (por('criar')) l.push('SÓ CONFERIR: nada foi escrito. Para criar os que faltam, rode de novo com --aplicar.');
  return l;
}

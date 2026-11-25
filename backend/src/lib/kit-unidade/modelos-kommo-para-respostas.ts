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

export type Situacao = 'criar' | 'ja-existe' | 'divergente';

export interface LinhaDaImportacao {
  /** atalho depois da barra (sem a barra) */
  atalho: string;
  /** nome do modelo no Kommo, sem o ⚡ */
  nome: string;
  kommoId: number;
  texto: string;
  situacao: Situacao;
  /** marcadores do Kommo que o CRM não troca sozinho (viraram «[…]») */
  avisos: string[];
}

export interface ExistenteNoCrm {
  short_code: string;
  content: string;
}

/** `⚡ Lead primeiro contato` → `lead-primeiro-contato` (sem acento, minúsculas, só letras/dígitos e hífen). */
export function atalhoDoNome(nome: string): string {
  return nome
    .replace(/[^\p{L}\p{N}\s_-]/gu, ' ')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '');
}

/** O texto do Kommo na linguagem do Chatwoot. Os `{{lead.cf.N}}` já chegam trocados por `[Campo]` (`respostasProntas`). */
export function textoParaOCrm(texto: string): string {
  return texto.replace(/\{\{\s*contact\.(?:first_)?name\s*\}\}/gi, '{{contact.first_name}}');
}

/** Marcadores `[x]` que sobraram porque o Kommo não tem como traduzir (diferentes de `[Nome do campo]` conhecido). */
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

/**
 * O plano: uma linha por modelo geral do Kommo. `prefixo` sem o `_` (`timbocrm`). Atalhos repetidos entre dois modelos do Kommo ganham `-2`, `-3`…
 * (na ordem alfabética do nome, para o resultado ser o mesmo em toda rodada).
 */
export function planejarImportacao(
  modelos: ReadonlyArray<KommoChatTemplate>,
  nomeDoCampo: (id: number) => string | null,
  existentes: ReadonlyArray<ExistenteNoCrm>,
  prefixo: string,
): LinhaDaImportacao[] {
  const p = prefixo.replace(/_+$/, '');
  const noCrm = new Map(existentes.map((e) => [e.short_code, e.content]));
  const usados = new Set<string>();
  const originais = new Map(modelos.map((m) => [m.id, String(m.content ?? '')]));
  return respostasProntas(modelos, nomeDoCampo).map((r) => {
    const nome = r.nome.replace(/^[^\p{L}\p{N}]+/u, '').trim() || `modelo ${r.id}`;
    const base = `${p}-${atalhoDoNome(nome) || `modelo-${r.id}`}`;
    let atalho = base;
    for (let n = 2; usados.has(atalho); n++) atalho = `${base}-${n}`;
    usados.add(atalho);
    const texto = textoParaOCrm(r.texto);
    const ja = noCrm.get(atalho);
    const situacao: Situacao = ja === undefined ? 'criar' : ja.trim() === texto.trim() ? 'ja-existe' : 'divergente';
    return { atalho, nome, kommoId: r.id, texto, situacao, avisos: avisosDoTexto(originais.get(r.id) ?? '', nomeDoCampo) };
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
  criadas: string[];
  falhas: Array<{ atalho: string; erro: string }>;
}

export async function importar(portas: Portas, prefixo: string, aplicar: boolean): Promise<Resultado> {
  const [modelos, nomeDoCampo, existentes] = await Promise.all([portas.modelosDoKommo(), portas.nomeDoCampo(), portas.respostasDoCrm()]);
  const linhas = planejarImportacao(modelos, nomeDoCampo, existentes, prefixo);
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
  return { linhas, criadas, falhas };
}

const ROTULO = { criar: 'CRIAR', 'ja-existe': 'já existe', divergente: 'DIVERGENTE (não sobrescrevo)' } as const;

export function relatorio(r: Resultado, aplicar: boolean): string[] {
  const l: string[] = [];
  for (const x of r.linhas) {
    const feito = aplicar && r.criadas.includes(x.atalho) ? ' → CRIADA' : aplicar && r.falhas.some((f) => f.atalho === x.atalho) ? ' → FALHOU' : '';
    l.push(`  /${x.atalho}  [${ROTULO[x.situacao]}${feito}]  (${x.texto.length} car.)${x.avisos.length ? `  ATENÇÃO marcador não traduzido: ${x.avisos.join(', ')}` : ''}`);
  }
  const por = (s: string) => r.linhas.filter((x) => x.situacao === s).length;
  l.push(`${r.linhas.length} modelo(s) gerais do Kommo: ${por('criar')} a criar, ${por('ja-existe')} já existem, ${por('divergente')} divergentes.`);
  if (aplicar) l.push(`Criadas agora: ${r.criadas.length}. Falhas: ${r.falhas.length}${r.falhas.length ? ` (${r.falhas.map((f) => `/${f.atalho}: ${f.erro}`).join('; ')})` : ''}.`);
  else if (por('criar')) l.push('SÓ CONFERIR: nada foi escrito. Para criar os que faltam, rode de novo com --aplicar.');
  return l;
}

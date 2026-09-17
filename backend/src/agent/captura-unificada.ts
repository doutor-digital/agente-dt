/**
 * Captura unificada (17/09/2026): UMA ferramenta `registrar_campo(campo, valor)` no lugar das ~30 `registra_*`.
 *
 * Por quê: as definições de ferramenta são ~15 mil tokens do prefixo de ~40 mil que vai em TODA chamada
 * (lidas do cache a US$ 0,20/M e regravadas a US$ 4/M). Medido em 10–16/09: leitura de cache US$ 10,9/dia e
 * gravação US$ 7,2/dia na rede. Trocar 30 ferramentas por uma com a lista dos campos corta ~11 mil tokens do
 * prefixo (−25% do custo da chamada) sem tirar do modelo nenhuma informação: o "quando chamar" de cada campo
 * continua na descrição, só que uma linha por campo em vez de um schema inteiro.
 *
 * Liga por unidade: env `CAPTURA_UNIFICADA_SLUGS` (csv de slugs ou `*`). Desligado = comportamento antigo.
 * A parte pura (coerção de valor, descrição) fica aqui pra ser testada sem Kommo.
 */
import type { LeadFieldRule } from '@prisma/client';

export function capturaUnificada(slug: string | null | undefined): boolean {
  const raw = process.env.CAPTURA_UNIFICADA_SLUGS ?? '';
  const lista = new Set(raw.split(',').map((s) => s.trim()).filter(Boolean));
  return lista.has('*') || (!!slug && lista.has(slug));
}

type Enum = { id: number; value: string };
export type ValorCoercido = { ok: true; valor: string | number | string[] } | { ok: false; erro: string };

function normalizar(s: string): string {
  return s.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function acharOpcao(valor: string, enums: Enum[]): string | null {
  const alvo = normalizar(valor);
  const exata = enums.find((e) => normalizar(e.value) === alvo);
  if (exata) return exata.value;
  // "quente" casa com "Quente 🔥"; "cadastro" com "Cadastro (paciente novo)"
  const parcial = enums.filter((e) => normalizar(e.value).startsWith(alvo) || normalizar(e.value).includes(alvo));
  return parcial.length === 1 ? parcial[0].value : null;
}

/** Converte o `valor` (sempre texto, vindo do modelo) pro tipo que o campo do Kommo exige. */
export function coergirValor(rule: Pick<LeadFieldRule, 'kommoFieldType' | 'kommoFieldEnums' | 'kommoFieldName'>, valor: unknown): ValorCoercido {
  const tipo = rule.kommoFieldType;
  const enums = ((rule.kommoFieldEnums as Enum[] | null) ?? []).filter((e) => e && typeof e.value === 'string');
  const texto = Array.isArray(valor) ? valor.join(';') : String(valor ?? '').trim();
  if (!texto) return { ok: false, erro: `valor vazio para "${rule.kommoFieldName}"` };

  if (tipo === 'numeric' || tipo === 'monetary') {
    const limpo = texto.replace(/r\$/i, '').replace(/\s/g, '').replace(/\.(?=\d{3}(\D|$))/g, '').replace(',', '.');
    const n = Number(limpo);
    return Number.isFinite(n) ? { ok: true, valor: n } : { ok: false, erro: `"${texto}" não é número para "${rule.kommoFieldName}"` };
  }
  if (tipo === 'date' || tipo === 'birthday' || tipo === 'date_time') {
    const br = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})(?:\s+(\d{1,2}):(\d{2}))?$/.exec(texto);
    if (br) {
      const ano = br[3].length === 2 ? `20${br[3]}` : br[3];
      const data = `${ano}-${br[2].padStart(2, '0')}-${br[1].padStart(2, '0')}`;
      return { ok: true, valor: br[4] ? `${data}T${br[4].padStart(2, '0')}:${br[5]}:00` : data };
    }
    if (/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2})?)?/.test(texto)) return { ok: true, valor: texto };
    return { ok: false, erro: `"${texto}" não é data (use AAAA-MM-DD ou DD/MM/AAAA) para "${rule.kommoFieldName}"` };
  }
  if (tipo === 'multiselect') {
    const partes = texto.split(/[;|,\n]/).map((p) => p.trim()).filter(Boolean);
    if (!enums.length) return { ok: true, valor: partes };
    const achadas: string[] = []; const erradas: string[] = [];
    for (const p of partes) { const o = acharOpcao(p, enums); if (o) { if (!achadas.includes(o)) achadas.push(o); } else erradas.push(p); }
    if (erradas.length) return { ok: false, erro: `opção inválida (${erradas.join(', ')}) para "${rule.kommoFieldName}". Opções: ${enums.map((e) => e.value).join(' | ')}` };
    return { ok: true, valor: achadas };
  }
  if ((tipo === 'select' || tipo === 'radiobutton') && enums.length) {
    const o = acharOpcao(texto, enums);
    return o ? { ok: true, valor: o } : { ok: false, erro: `opção inválida ("${texto}") para "${rule.kommoFieldName}". Opções: ${enums.map((e) => e.value).join(' | ')}` };
  }
  if (tipo === 'checkbox') {
    const n = normalizar(texto);
    return { ok: true, valor: /^(sim|s|true|1|yes|verdadeiro|marcad)/.test(n) ? 'true' : 'false' };
  }
  return { ok: true, valor: texto.slice(0, 2000) };
}

function encurtar(s: string, max: number): string {
  const t = s.replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  const corte = t.slice(0, max);
  const fim = Math.max(corte.lastIndexOf('. '), corte.lastIndexOf('; '), corte.lastIndexOf(', '));
  return (fim > max * 0.6 ? corte.slice(0, fim) : corte).trim() + '…';
}

/** Uma linha por campo: quando chamar + formato/opções. É o que substitui 30 schemas no prefixo. */
export function linhaDoCampo(rule: LeadFieldRule): string {
  const enums = ((rule.kommoFieldEnums as Enum[] | null) ?? []).map((e) => e.value).filter(Boolean);
  const tipo = rule.kommoFieldType;
  let formato = '';
  if ((tipo === 'select' || tipo === 'radiobutton') && enums.length) formato = ` Opções: ${enums.join(' | ')}.`;
  else if (tipo === 'multiselect') formato = enums.length ? ` Uma ou mais, separadas por ";": ${enums.join(' | ')}.` : ' Uma ou mais, separadas por ";".';
  else if (tipo === 'numeric' || tipo === 'monetary') formato = ' Só o número.';
  else if (tipo === 'date' || tipo === 'birthday' || tipo === 'date_time') formato = ' Data AAAA-MM-DD.';
  const titulo = rule.updatesLeadTitle ? ' (também vira o título do card)' : '';
  return `• ${rule.toolName}: ${encurtar(rule.instruction, 140)}${formato}${titulo}`;
}

export function descricaoRegistrarCampo(rules: LeadFieldRule[]): string {
  return (
    'Grava UMA informação no card do paciente no Kommo, em silêncio (nunca anuncie que anotou). ' +
    '`campo` diz qual informação; `valor` vai como texto, no formato indicado. Idempotente: repetir o mesmo valor não duplica. ' +
    'Chame assim que a informação aparecer na conversa, uma chamada por campo.\nCampos:\n' +
    rules.map(linhaDoCampo).join('\n')
  );
}

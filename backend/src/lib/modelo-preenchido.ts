/**
 * MODELO DO WHATSAPP MANDADO À MÃO: os parâmetros já vêm preenchidos (pedido do João, 25/11/2026). A atendente abre o seletor de modelos do Chatwoot, escolhe um modelo e as caixinhas
 * de {{1}}, {{2}}… aparecem sugeridas; ela edita, apaga ou envia. NUNCA envia sozinho: só sugere. Aqui está a regra do SERVIDOR (o bloco do `menu.js` está em
 * `chatwoot-modelo-preenchido-ui.ts`); a pergunta é «conversa + nome do modelo (+ corpo do modelo) → valores sugeridos».
 *
 *  - Modelo do CRM (nome com o prefixo da unidade e texto conhecido da régua): os MESMOS campos e a MESMA regra da régua (`variaveisDoModeloCampoACampo`, que é a de `renderizar`):
 *    primeiro nome, data e horário da consulta, unidade, endereço… Não existe uma segunda regra. Campo sem dado fica vazio (a régua não envia nesse caso; a atendente completa).
 *  - Modelo de fora (ex.: os `timbo_*` que a Kommo criou na WABA de Timbó, «Olá, {{1}}… 🗓 Data e horário: {{2}}»): o texto do modelo diz o que cada {{n}} é —
 *      · {{n}} logo depois de uma saudação («Olá, {{1}}», «Oi, », «Bom dia, »…) = primeiro nome do contato;
 *      · {{n}} logo depois de «Data e horário:» = a próxima data marcada da conversa (consulta; sem ela, sessão; sem ela, retorno) — os atributos que a agenda mantém. DATA QUE JÁ PASSOU nunca é sugerida
 *        (passada a consulta, vale a próxima futura; nada futuro = vazio; vale também para os campos de data dos modelos do CRM);
 *      · os outros ficam vazios.
 *  - Sem dado, vazio. Nunca inventa.
 */
import { TEXTOS_PARAU } from './chatwoot-regua-textos.js';
import { PREFIXO_BASE_DOS_MODELOS } from './chatwoot-unidades.js';
import { paraParametro, primeiroNome, proximaDataDaConversa, variaveisDoModeloCampoACampo, type ConversaRegua, type DadosDaUnidade } from './chatwoot-regua.js';

export interface Preenchimento {
  /** de onde veio a regra: `crm` (modelo da régua), `externo` (modelo criado fora, lido pelo texto) ou `nenhuma` (nada a sugerir) */
  origem: 'crm' | 'externo' | 'nenhuma';
  /** chave do parâmetro («1», «2»…) → valor sugerido; só entram os que têm dado */
  valores: Record<string, string>;
}

const NENHUM: Preenchimento = { origem: 'nenhuma', valores: {} };

/** `timbocrm_consulta_x` → `parau_consulta_x` (o nome BASE da régua, `nomeDoModeloNaMeta` ao contrário). null = o nome não é de modelo desta unidade. */
export function nomeBaseDoModelo(nome: string, prefixoDaUnidade: string | undefined | null): string | null {
  const p = prefixoDaUnidade || PREFIXO_BASE_DOS_MODELOS;
  if (!nome.startsWith(p) || nome.length === p.length) return null;
  return p === PREFIXO_BASE_DOS_MODELOS ? nome : PREFIXO_BASE_DOS_MODELOS + nome.slice(p.length);
}

/** Os parâmetros {{x}} do corpo, na ordem da 1ª aparição, cada um com o texto que vem imediatamente antes dele (na mesma linha). */
export function parametrosDoCorpo(corpo: string): Array<{ chave: string; antes: string }> {
  const saida: Array<{ chave: string; antes: string }> = [];
  for (const m of corpo.matchAll(/\{\{\s*([^}\s]+)\s*\}\}/g)) {
    const chave = m[1]!;
    if (saida.some((x) => x.chave === chave)) continue;
    const ate = corpo.slice(0, m.index ?? 0);
    saida.push({ chave, antes: ate.slice(ate.lastIndexOf('\n') + 1) });
  }
  return saida;
}

const SAUDACAO = /(?:^|[^\p{L}])(?:ol[áa]|oi|bom dia|boa tarde|boa noite|prezad[oa]s?|car[oa])\s*[,!:]?\s*$/iu;
const DATA_E_HORARIO = /data\s+e\s+hor[áa]rio\s*:\s*$/iu;

/** O que o texto diz que é cada parâmetro de um modelo criado fora do CRM. */
export function papelDoParametro(antes: string): 'nome' | 'data' | null {
  if (DATA_E_HORARIO.test(antes)) return 'data';
  if (SAUDACAO.test(antes)) return 'nome';
  return null;
}

/**
 * Os valores sugeridos para o modelo `modelo` (nome na Meta) nesta conversa. `corpo` = o texto do modelo como o seletor mostra (com {{1}}…), só usado nos modelos de fora.
 * Nunca lança: o que não dá para decidir volta vazio.
 */
export function preencherModelo(p: { modelo: string; corpo?: string }, c: ConversaRegua, u: DadosDaUnidade, agora: Date = new Date()): Preenchimento {
  const modelo = String(p.modelo ?? '').trim();
  if (!/^[a-z0-9_]{1,200}$/.test(modelo)) return NENHUM;
  const textos = u.textos ?? TEXTOS_PARAU;
  const base = nomeBaseDoModelo(modelo, u.prefixoModelos);
  if (base && textos[base] !== undefined) {
    const valores: Record<string, string> = {};
    variaveisDoModeloCampoACampo(base, c, u, undefined, agora).forEach((v, i) => {
      if (v.valor) valores[String(i + 1)] = v.valor;
    });
    return { origem: 'crm', valores };
  }
  const corpo = String(p.corpo ?? '').slice(0, 4000);
  const valores: Record<string, string> = {};
  for (const { chave, antes } of parametrosDoCorpo(corpo)) {
    const papel = papelDoParametro(antes);
    const v = papel === 'nome' ? primeiroNome(c.nome) : papel === 'data' ? proximaDataDaConversa(c, agora) : null;
    const limpo = v ? paraParametro(v) : '';
    if (limpo) valores[chave] = limpo;
  }
  return { origem: 'externo', valores };
}

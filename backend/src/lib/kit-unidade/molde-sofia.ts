/**
 * A SOFIA DA UNIDADE a partir de um molde (kit de unidade, 14/11/2026).
 *
 * O prompt efetivo da Sofia é montado em tempo de execução pelo `prompt-composer` a partir de CAMPOS da unidade (persona, fontes,
 * endereço, agenda, sinal) + o `systemPrompt` + o bloco da rede Doutor Hérnia. O kit preenche esses campos a partir do questionário e,
 * quando a unidade usa sinal por Pix, também o `systemPrompt` com o roteiro de venda da Sofia 2.0 (molde em
 * `ops/kit-unidade/molde-sofia/bloco-conversa.md`, com os preços da unidade nos marcadores). O preço nunca é inventado: sai do questionário,
 * e o texto das fontes é escrito de modo que `precosDaConsulta` o leia de volta (teste).
 */
import { normalizarRegra, recusaDaRegra } from '../aprendizados-unidade.js';
import { QUANDO_ATENDE } from './assistente-padrao.js';
import type { Questionario } from './questionario.js';

const DIAS = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'];

export const brl = (v: number): string => `R$ ${Number.isInteger(v) ? String(v) : v.toFixed(2).replace('.', ',')}`;

/** "segunda a sexta" / "segunda, quarta e sexta" */
export function textoDosDias(dias: readonly number[]): string {
  const d = [...new Set(dias)].sort((a, b) => a - b);
  const seguidos = d.every((x, i) => i === 0 || x === d[i - 1]! + 1);
  if (d.length >= 3 && seguidos) return `${DIAS[d[0]!]} a ${DIAS[d[d.length - 1]!]}`;
  const nomes = d.map((x) => DIAS[x]!);
  return nomes.length <= 1 ? nomes.join('') : `${nomes.slice(0, -1).join(', ')} e ${nomes[nomes.length - 1]}`;
}

/** Fonte "negócio": endereço, contato, horário, profissionais. */
export function fonteNegocio(q: Questionario): string {
  const h = q.horarios;
  const linhas = [
    `${q.unidade.nome} — ${q.unidade.endereco}.`,
    `Como chegar: ${q.unidade.mapa_url}`,
    ...(q.unidade.telefone ? [`Telefone: ${q.unidade.telefone}`] : []),
    `Atendimento: ${textoDosDias(h.dias)}, das ${h.inicio} às ${h.fim}${h.almoco_inicio ? ` (pausa para almoço das ${h.almoco_inicio} às ${h.almoco_fim})` : ''}. Consultas de ${h.duracao_min} minutos.`,
    'Profissionais:',
    ...q.profissionais.map((p) => `- ${p.nome} (${p.funcao === 'medico' ? 'médico(a)' : 'fisioterapeuta'})`),
  ];
  return linhas.join('\n');
}

const CONVENIO_TEXTO = { nao: 'não aceita convênio (atendimento particular)', sim: 'aceita convênio', reembolso: 'não é credenciada a convênio, mas dá o recibo para reembolso' } as const;

/**
 * O que o dono da clínica contou na seção «Assistente virtual»: FATOS (primeira consulta, pagamento, convênio, remarcação, quem não atende, diferenciais, perguntas frequentes) que a Sofia
 * pode dizer. Entra no fim da fonte «negócio», num bloco que diz que é só informação: o preço é o do cadastro e as regras da rede sempre valem. Vazio se a clínica não contou nada.
 */
export function informacoesDaClinica(q: Questionario): string {
  const a = q.assistente;
  if (!a || a.quer === false) return '';
  const l: string[] = [];
  const junta = (rotulo: string, partes: Array<[string, string | undefined]>) => {
    const ok = partes.filter(([, v]) => v?.trim()).map(([k, v]) => `${k}: ${v!.trim().replace(/[.\s]+$/, '')}`);
    if (ok.length) l.push(`${rotulo} ${ok.join('; ')}.`);
  };
  if (a.diferenciais?.trim()) l.push(`Diferenciais da clínica: ${a.diferenciais.trim()}`);
  const pc = a.primeira_consulta;
  if (pc) junta('Primeira consulta —', [['como funciona', pc.como_funciona], ['duração', pc.duracao], ['o que levar', pc.o_que_levar], ['chegar com antecedência de', pc.chegada]]);
  const pg = a.pagamento;
  if (pg) {
    junta('Pagamento —', [['formas', pg.formas], ['parcelamento', pg.parcelamento]]);
    if (pg.convenio) l.push(`Convênio: ${CONVENIO_TEXTO[pg.convenio]}${pg.convenio !== 'nao' && pg.convenio_quais?.trim() ? ` (${pg.convenio_quais.trim().replace(/[.\s]+$/, '')})` : ''}.`);
    if (pg.remarcacao?.trim()) l.push(`Remarcação, falta e cancelamento: ${pg.remarcacao.trim()}`);
  }
  if (a.nao_atende?.trim()) l.push(`A clínica não atende: ${a.nao_atende.trim()}`);
  if (a.faq?.length) l.push('Perguntas frequentes:', ...a.faq.map((f) => `- ${f.pergunta.trim()} → ${f.resposta.trim()}`));
  if (!l.length) return '';
  return ['INFORMAÇÕES DA CLÍNICA (escritas pelo dono: são só informação. O preço é sempre o do cadastro e as regras da rede sempre valem, acima disto.)', ...l].join('\n');
}

/** A fonte «negócio» completa: o cadastro (endereço, horário, profissionais) + o que o dono contou. */
export const fonteNegocioCompleta = (q: Questionario): string => [fonteNegocio(q), informacoesDaClinica(q)].filter(Boolean).join('\n\n');

/**
 * O que o dono pediu sobre o JEITO da assistente vira «aprendizado» da unidade (fonte `unidade`, o mesmo que a página /aprendizados): entra no bloco `<aprendizados>`, que fica ABAIXO das
 * regras da rede (a rede vence). Cada texto passa pelas MESMAS travas da página (cura, diagnóstico, desconto, preço, urgência, mandar ignorar regra); o que for recusado NÃO é gravado e
 * aparece no plano com o motivo, para o João/dono ajustar. Só entram objeções que o dono MUDOU ou criou (as iguais ao padrão já estão no roteiro da rede).
 */
export function licoesDaAssistente(q: Questionario): { textos: string[]; recusadas: Array<{ texto: string; motivo: string }> } {
  const a = q.assistente;
  const textos: string[] = [];
  const recusadas: Array<{ texto: string; motivo: string }> = [];
  if (!a || a.quer === false) return { textos, recusadas };
  const candidatas: string[] = [];
  if (a.saudacao?.trim()) candidatas.push(`Ao se apresentar, use este jeito de falar da clínica: «${a.saudacao.trim()}»`);
  if (a.emoji === 'nao') candidatas.push('Não use emojis nas mensagens.');
  if (a.emoji === 'pouco') candidatas.push('Use emojis com muita moderação: no máximo um a cada poucas mensagens.');
  for (const o of a.objecoes ?? []) candidatas.push(`Se o paciente disser «${o.gatilho.trim()}», responda neste estilo: «${o.resposta.trim()}»`);
  if (a.nunca_extra?.trim()) candidatas.push(`Nunca diga nem prometa: ${a.nunca_extra.trim()}`);
  if (a.passar_extra?.trim()) candidatas.push(`Além das regras da rede, chame uma pessoa da equipe quando: ${a.passar_extra.trim()}`);
  for (const c of candidatas) {
    const t = normalizarRegra(c);
    const motivo = recusaDaRegra(t);
    if (motivo) recusadas.push({ texto: t.length > 90 ? `${t.slice(0, 87)}…` : t, motivo });
    else textos.push(t);
  }
  return { textos, recusadas };
}

export const horarioDaAssistente = (q: Questionario): string => {
  const a = q.assistente;
  if (!a) return 'o padrão (24 horas)';
  const base = QUANDO_ATENDE.find(([k]) => k === a.quando_atende)?.[1] ?? 'o padrão (24 horas)';
  return a.quando_atende === 'personalizado' && a.quando_atende_detalhe ? `${base}: ${a.quando_atende_detalhe}` : base;
};

/** Fonte "produtos": os dois preços, na frase que `precosDaConsulta` lê de volta. */
export function fonteProdutos(q: Questionario): string {
  const v = q.valores;
  if (!v.aceita_antecipado || v.consulta_antecipada === undefined) return `Consulta com o nosso especialista: ${brl(v.consulta_no_dia)} no dia, pagos na clínica.`;
  const sinal = v.sinal_pix !== undefined ? ` O sinal de ${brl(v.sinal_pix)} é pago por Pix e garante a vaga; o restante é pago no dia.` : '';
  return `Consulta com o nosso especialista: ${brl(v.consulta_no_dia)} no dia, ou ${brl(v.consulta_antecipada)} com pagamento antecipado.${sinal}`;
}

/** Preenche o molde (marcadores {{…}}). Marcador sem valor é erro: o roteiro não pode sair com «{{valor_sinal}}» no meio. */
export function renderizarMolde(molde: string, q: Questionario): { texto: string; faltando: string[] } {
  const v = q.valores;
  const resto = v.consulta_antecipada !== undefined && v.sinal_pix !== undefined ? v.consulta_antecipada - v.sinal_pix : undefined;
  const valores: Record<string, string | undefined> = {
    cidade: q.unidade.cidade,
    nome_ia: q.sofia.nome_ia,
    valor_no_dia: brl(v.consulta_no_dia),
    valor_com_sinal: v.consulta_antecipada !== undefined ? brl(v.consulta_antecipada) : undefined,
    valor_sinal: v.sinal_pix !== undefined ? brl(v.sinal_pix) : undefined,
    valor_resto: resto !== undefined ? brl(resto) : undefined,
  };
  const faltando: string[] = [];
  const texto = molde
    .replace(/<!--[\s\S]*?-->\s*/, '')
    .replace(/\{\{\s*([a-z_]+)\s*\}\}/g, (todo, nome: string) => {
      const x = valores[nome];
      if (x === undefined) {
        if (!faltando.includes(nome)) faltando.push(nome);
        return todo;
      }
      return x;
    });
  return { texto, faltando };
}

/** O molde da Sofia 2.0 é de unidade COM sinal. Sem sinal o `systemPrompt` fica como está e a unidade usa o prompt em camadas do composer. */
export const moldeServe = (q: Questionario): boolean => q.valores.sinal_pix !== undefined && q.valores.aceita_antecipado && q.valores.consulta_antecipada !== undefined;

/** Só na CRIAÇÃO da unidade: uma unidade que já existe mantém a categoria que tem. */
export const CAMPOS_SO_NA_CRIACAO: Readonly<Record<string, unknown>> = { category: 'saude' };

/**
 * Os campos de `units` que NÃO são segredo (nenhum token passa por aqui). Campo opcional que o questionário não preencheu é OMITIDO
 * (não vira `null`): rodar o script sobre uma unidade que já existe nunca apaga chave Pix, sinal ou almoço que ela já tem.
 */
export function camposDaUnidade(q: Questionario): Record<string, unknown> {
  const h = q.horarios;
  const v = q.valores;
  const so = <T>(valor: T | undefined, chave: string): Record<string, T> => (valor === undefined ? {} : { [chave]: valor });
  return {
    name: q.unidade.nome,
    clinicAddress: q.unidade.endereco,
    clinicMapUrl: q.unidade.mapa_url,
    ...so(v.chave_pix, 'pixKey'),
    ...so(v.favorecido, 'pixHolder'),
    acceptsAdvancePayment: v.aceita_antecipado,
    ...so(v.sinal_pix !== undefined ? Math.round(v.sinal_pix * 100) : undefined, 'sinalPixCentavos'),
    spineAgendaStart: h.inicio,
    spineAgendaEnd: h.fim,
    ...so(h.almoco_inicio, 'spineLunchStart'),
    ...so(h.almoco_fim, 'spineLunchEnd'),
    spineAgendaDays: [...h.dias],
    spineSlotMinutes: h.duracao_min,
    spineTimezone: q.unidade.fuso,
  };
}

/** Persona e fontes da Sofia (+ `systemPrompt` quando o molde serve). */
export function camposDaSofia(q: Questionario, molde: string | null): { campos: Record<string, unknown>; avisos: string[] } {
  const avisos: string[] = [];
  const campos: Record<string, unknown> = {
    personaCompanyName: q.unidade.nome,
    personaAgentName: q.sofia.nome_ia,
    personaTone: q.sofia.tom,
    personaLanguage: 'pt-BR',
    sourceNegocio: fonteNegocioCompleta(q),
    sourceProdutos: fonteProdutos(q),
  };
  // a clínica NÃO quer a assistente: a Sofia não é configurada (nem persona, nem fontes, nem prompt)
  if (q.assistente?.quer === false) return { campos: {}, avisos: ['a clínica NÃO quer a assistente virtual: a Sofia não é configurada (nada de persona, fontes, prompt nem aprendizados)'] };
  if (!moldeServe(q)) avisos.push('sem sinal por Pix: o molde da Sofia 2.0 não se aplica; o systemPrompt fica como está e a Sofia usa o prompt em camadas do composer + o bloco da rede');
  else if (molde === null) avisos.push('molde da Sofia (ops/kit-unidade/molde-sofia/bloco-conversa.md) não encontrado: o systemPrompt não será gravado');
  else {
    const r = renderizarMolde(molde, q);
    if (r.faltando.length) avisos.push(`molde com marcador sem valor: ${r.faltando.join(', ')}`);
    else campos.systemPrompt = r.texto;
  }
  return { campos, avisos };
}

/**
 * O FORMULÁRIO DO FRANQUEADO (nova clínica, 16/11/2026): o dono da clínica preenche sozinho, num link com código, o que o kit pergunta ao João.
 *
 * Este esquema (zod) é o que a página envia e o servidor aceita. Ele é um SUBCONJUNTO do questionário do kit (`questionario.ts`): só o que o dono da
 * clínica sabe responder. O que é do kit (nome da caixa e do time, subdomínio, nome das variáveis, sufixo, ids do Kapso/WABA) o kit sugere ou o João completa.
 *
 * SEGREDO NUNCA TEM CAMPO AQUI: nada de token, senha ou chave de API. Dado pessoal (e-mail das atendentes, chave Pix, telefone) é guardado no banco do agente e
 * NUNCA vai para log, para o GitHub nem para o aviso do João.
 *
 * As regras entre campos repetem as do questionário (1 gerente, valor antecipado menor que o do dia, sinal, almoço), em português de dono de clínica:
 * assim a pessoa vê o erro na hora, e não só o João quando for rodar o kit.
 */
import { z } from 'zod';
import { INVISIVEIS_BENIGNOS, recusaDaRegra, recusaDeFato, recusaDePergunta, textoComDisfarce } from '../aprendizados-unidade.js';
import { MAX_OBJECOES_EXTRAS, MAX_RESPOSTA_OBJECAO, OBJECOES_PADRAO, licaoDaObjecao, licaoDaSaudacao, licaoDeChamarPessoa, licoesDoNunca } from './assistente-padrao.js';

const hora = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use o formato 08:00 (hora:minuto).');
/** Troca caractere de controle e quebra de linha por espaço (o texto vai para o terminal do João e para frases ditas ao paciente: nada de linha forjada nem ANSI). */
const umaLinha = (v: unknown) => (typeof v === 'string' ? v.replace(INVISIVEIS_BENIGNOS, '').replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ').replace(/[«»]/g, '"').replace(/[‹›]/g, "'").replace(/\s+/g, ' ').trim() : v);
const texto = (min: number, max: number, nome: string) =>
  z.preprocess(
    umaLinha,
    z
      .string({ required_error: `Preencha: ${nome}.`, invalid_type_error: `Preencha: ${nome}.` })
      .min(1, `Preencha: ${nome}.`)
      .min(min, `${nome}: escreva um pouco mais (mínimo ${min} letras).`)
      .max(max, `${nome}: muito longo (máximo ${max} letras).`),
  );
/** Texto de VÁRIAS linhas (uma ideia por linha, como «o que a assistente nunca diz»): cada linha limpa como `umaLinha`, linhas vazias somem e a quebra de linha fica. */
const variasLinhas = (min: number, max: number, nome: string) =>
  z.preprocess(
    (v) => (typeof v === 'string' ? v.split(/\r?\n/).map((l) => umaLinha(l) as string).filter(Boolean).join('\n') : v),
    z
      .string({ required_error: `Preencha: ${nome}.`, invalid_type_error: `Preencha: ${nome}.` })
      .min(1, `Preencha: ${nome}.`)
      .min(min, `${nome}: escreva um pouco mais (mínimo ${min} letras).`)
      .max(max, `${nome}: muito longo (máximo ${max} letras).`),
  );
/** Aceita 350, "350", "350,50" e "R$ 350": vira número. Valor inválido vira NaN e o `.positive()` recusa. */
const dinheiro = (nome: string) =>
  z.preprocess(
    (v) => {
      if (typeof v === 'number') return v;
      if (typeof v !== 'string') return v;
      const limpo = v.replace(/^\s*R\$\s*/i, '').trim();
      if (limpo === '') return undefined;
      // só o que um brasileiro digita: 350 | 350,50 | 350.50 | 1.250 | 1.250,50 (nada de 0x10, 1e3, sinais ou letras)
      const ok = /^\d{1,3}(\.\d{3})+(,\d{1,2})?$/.test(limpo) || /^\d+([.,]\d{1,2})?$/.test(limpo);
      if (!ok) return Number.NaN;
      return Number(/^\d{1,3}(\.\d{3})+(,\d{1,2})?$/.test(limpo) ? limpo.replace(/\./g, '').replace(',', '.') : limpo.replace(',', '.'));
    },
    z.number({ invalid_type_error: `${nome}: digite só o valor, por exemplo 350.`, required_error: `Preencha: ${nome}.` }).positive(`${nome}: digite um valor maior que zero.`).max(100000, `${nome}: valor alto demais.`),
  );
/** Campo opcional em branco chega como "" ou null: vira ausente. */
const opcional = <T extends z.ZodTypeAny>(s: T) => z.preprocess((v) => (v === '' || v === null ? undefined : v), s.optional());
const email = z.string({ required_error: 'Preencha o e-mail.' }).trim().toLowerCase().email('Esse e-mail não parece certo.').max(120);
const telefone = z.string().trim().regex(/^[\d\s()+-]{8,20}$/, 'Digite o telefone com DDD, só números, espaço, parênteses ou traço.');

/** Texto de FATO (vai para as fontes da Sofia): sem marcação, sem mandar ignorar regra, sem pronto-socorro, sem valor em reais. */
const fato = (min: number, max: number, nome: string, opcoes: { permiteParcelamento?: boolean } = {}) => texto(min, max, nome).superRefine((v, ctx) => {
  const m = recusaDeFato(v, opcoes);
  if (m) ctx.addIssue({ code: z.ZodIssueCode.custom, message: m });
});
/** Texto que vira REGRA da unidade (aprendizado): passa pelas mesmas travas da página /aprendizados (cura, desconto, diagnóstico, urgência…). */
const regra = (min: number, max: number, nome: string) => texto(min, max, nome).superRefine((v, ctx) => {
  const m = recusaDaRegra(v);
  if (m) ctx.addIssue({ code: z.ZodIssueCode.custom, message: m });
});
const contatoDaEquipe = z.string().trim().max(80).refine((v) => /^[\w.+-]+@[\w-]+(\.[\w-]+)+$/.test(v) || /^[\d\s()+-]{8,20}$/.test(v), 'Escreva um e-mail ou um telefone da equipe. Nunca senha nem código de acesso.');
const normaliza = (t: string) => t.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();

const IDS_DE_OBJECAO = [...OBJECOES_PADRAO.map((o) => o.id), 'outra'] as unknown as [string, ...string[]];

/**
 * A seção «Assistente virtual (IA)»: opcional. `quer: false` = nada mais é aceito (a Sofia não é configurada). Com `quer: true` os campos marcados são obrigatórios.
 * O que o dono escreve é DADO: vira fonte de informação ou «aprendizado» abaixo das regras da rede (que sempre vencem), nunca instrução do sistema.
 */
const Assistente = z
  .object({
    quer: z.boolean({ required_error: 'Diga se a clínica quer a assistente virtual.', invalid_type_error: 'Diga se a clínica quer a assistente virtual.' }),
    nome_ia: z.preprocess((v) => (v === '' || v === null ? undefined : v), texto(2, 30, 'Nome da assistente').refine((v) => /^[\p{L}\p{N} .'-]+$/u.test(v), 'O nome só pode ter letras, números, espaço, ponto, apóstrofo e hífen.').superRefine((v, ctx) => { const m = recusaDeFato(v); if (m) ctx.addIssue({ code: z.ZodIssueCode.custom, message: m }); }).optional()),
    tom: z.enum(['proximo', 'formal'], { errorMap: () => ({ message: 'Escolha o jeito de falar.' }) }).optional(),
    emoji: z.enum(['sim', 'pouco', 'nao'], { errorMap: () => ({ message: 'Escolha como usar emojis.' }) }).optional(),
    quando_atende: z.enum(['sempre', 'fora-expediente', 'noite-fim-semana', 'personalizado'], { errorMap: () => ({ message: 'Escolha quando a assistente atende.' }) }).optional(),
    quando_atende_detalhe: opcional(fato(3, 200, 'Horário da assistente')),
    saudacao: opcional(regra(10, 300, 'Como a clínica quer ser apresentada')),
    diferenciais: opcional(fato(5, 500, 'Diferenciais')),
    primeira_consulta: z
      .object({
        como_funciona: opcional(fato(10, 500, 'Como funciona a primeira consulta')),
        duracao: opcional(fato(2, 100, 'Duração')),
        o_que_levar: opcional(fato(3, 300, 'O que levar')),
        chegada: opcional(fato(3, 100, 'Antecedência de chegada')),
      })
      .strict()
      .optional(),
    pagamento: z
      .object({
        formas: opcional(fato(3, 300, 'Formas de pagamento')),
        parcelamento: opcional(fato(3, 300, 'Parcelamento', { permiteParcelamento: true })),
        convenio: z.enum(['nao', 'sim', 'reembolso'], { errorMap: () => ({ message: 'Diga se a clínica aceita convênio.' }) }).optional(),
        convenio_quais: opcional(fato(2, 200, 'Quais convênios')),
        remarcacao: opcional(fato(10, 400, 'Remarcação, falta e cancelamento')),
      })
      .strict()
      .optional(),
    nao_atende: opcional(fato(3, 400, 'Quem a clínica não atende')),
    objecoes: z
      .array(
        z
          .object({
            id: z.enum(IDS_DE_OBJECAO, { errorMap: () => ({ message: 'Objeção desconhecida.' }) }),
            gatilho: opcional(fato(3, 80, 'O que o paciente diz')),
            resposta: opcional(regra(10, MAX_RESPOSTA_OBJECAO, 'Resposta')),
          })
          .strict(),
      )
      .max(OBJECOES_PADRAO.length + MAX_OBJECOES_EXTRAS, 'Muitas objeções.')
      .optional(),
    nunca_extra: opcional(variasLinhas(10, 300, 'O que a assistente nunca pode dizer')),
    passar_extra: opcional(regra(10, 300, 'Outras situações para chamar uma pessoa')),
    quem_recebe: z.object({ nome: opcional(texto(3, 80, 'Nome de quem recebe')), contato: opcional(contatoDaEquipe) }).strict().optional(),
    faq: z
      .array(
        z
          .object({ pergunta: fato(5, 120, 'Pergunta'), resposta: fato(3, 300, 'Resposta') })
          .strict()
          // pergunta e resposta valem JUNTAS: «A avaliação tem custo?» + «Não, é gratuita.» só diz de graça lendo as duas
          .superRefine((f, ctx) => {
            const m = recusaDePergunta(f.pergunta, f.resposta);
            if (m) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['resposta'], message: m });
          }),
      )
      .max(10, 'No máximo 10 perguntas frequentes.')
      .optional(),
  })
  .strict()
  .superRefine((a, ctx) => {
    const erro = (path: (string | number)[], message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, path, message });
    if (!a.quer) {
      const { quer: _q, ...resto } = a;
      if (Object.values(resto).some((v) => v !== undefined && !(Array.isArray(v) && v.length === 0))) erro(['quer'], 'A clínica disse que NÃO quer a assistente: não envie os outros campos dela.');
      return;
    }
    const obrigatorio = (ok: unknown, path: (string | number)[], msg: string) => {
      if (!ok) erro(path, msg);
    };
    obrigatorio(a.tom, ['tom'], 'Escolha o jeito de falar.');
    obrigatorio(a.emoji, ['emoji'], 'Escolha como usar emojis.');
    obrigatorio(a.quando_atende, ['quando_atende'], 'Escolha quando a assistente atende.');
    if (a.quando_atende === 'personalizado') obrigatorio(a.quando_atende_detalhe, ['quando_atende_detalhe'], 'Escreva em que horários a assistente atende.');
    obrigatorio(a.saudacao, ['saudacao'], 'Escreva como a clínica quer ser apresentada.');
    obrigatorio(a.primeira_consulta?.como_funciona, ['primeira_consulta', 'como_funciona'], 'Explique como funciona a primeira consulta.');
    obrigatorio(a.primeira_consulta?.o_que_levar, ['primeira_consulta', 'o_que_levar'], 'Diga o que levar (se não precisa de nada, escreva «nada»).');
    obrigatorio(a.primeira_consulta?.chegada, ['primeira_consulta', 'chegada'], 'Diga com quanta antecedência chegar.');
    obrigatorio(a.pagamento?.formas, ['pagamento', 'formas'], 'Diga as formas de pagamento.');
    obrigatorio(a.pagamento?.convenio, ['pagamento', 'convenio'], 'Diga se a clínica aceita convênio.');
    if (a.pagamento?.convenio && a.pagamento.convenio !== 'nao') obrigatorio(a.pagamento.convenio_quais, ['pagamento', 'convenio_quais'], 'Diga quais convênios (ou como funciona o reembolso).');
    obrigatorio(a.pagamento?.remarcacao, ['pagamento', 'remarcacao'], 'Explique a política de remarcação, falta e cancelamento.');
    obrigatorio(a.quem_recebe?.nome, ['quem_recebe', 'nome'], 'Diga quem da equipe recebe o atendimento quando a assistente chama uma pessoa.');
    // o texto que vira aprendizado é conferido JÁ COMPOSTO, do jeito que o kit o grava: se a página /aprendizados o recusaria, o dono fica sabendo AQUI (e não só o João, no plano)
    const confere = (composto: string | undefined, path: (string | number)[]) => {
      if (!composto) return;
      const m = recusaDaRegra(composto);
      if (m) erro(path, m);
    };
    if (a.saudacao) confere(licaoDaSaudacao(a.saudacao), ['saudacao']);
    if (a.nunca_extra) {
      const n = licoesDoNunca(a.nunca_extra);
      if (n.ok) {
        confere(n.licao, ['nunca_extra']);
      }
      else erro(['nunca_extra'], n.motivo);
    }
    if (a.passar_extra) confere(licaoDeChamarPessoa(a.passar_extra), ['passar_extra']);
    // objeções: cada padrão no máximo uma vez; «outra» exige o que o paciente diz E a resposta
    const vistos = new Set<string>();
    let extras = 0;
    (a.objecoes ?? []).forEach((o, i) => {
      const padrao = OBJECOES_PADRAO.find((p) => p.id === o.id);
      if (o.id === 'outra') {
        extras += 1;
        if (!o.gatilho) erro(['objecoes', i, 'gatilho'], 'Escreva o que o paciente diz.');
        if (!o.resposta) erro(['objecoes', i, 'resposta'], 'Escreva a resposta.');
      } else if (vistos.has(o.id)) erro(['objecoes', i, 'id'], 'Essa objeção aparece duas vezes.');
      vistos.add(o.id);
      // só a que o dono MUDOU (ou criou) vira aprendizado: é essa que é conferida inteira
      if (o.resposta && (o.id === 'outra' || objecaoMudou(o.id, o.resposta))) confere(licaoDaObjecao(o.id === 'outra' ? (o.gatilho ?? '') : padrao!.gatilho, o.resposta), ['objecoes', i, 'resposta']);
    });
    if (extras > MAX_OBJECOES_EXTRAS) erro(['objecoes'], `No máximo ${MAX_OBJECOES_EXTRAS} objeções suas além das da lista.`);
  });

export const FUNCOES_DA_EQUIPE = ['gerente', 'secretaria', 'sdr', 'observador'] as const;

export const RespostasFormulario = z
  .object({
    quem: z.object({ nome: texto(3, 80, 'Seu nome'), email, whatsapp: opcional(telefone) }).strict(),
    clinica: z
      .object({
        nome: texto(5, 80, 'Nome da clínica'),
        cidade: texto(2, 60, 'Cidade'),
        uf: z.string({ required_error: 'Escolha o estado.' }).trim().toUpperCase().regex(/^[A-Z]{2}$/, 'Escolha o estado.'),
        endereco: texto(10, 200, 'Endereço completo'),
        mapa_url: z.string({ required_error: 'Cole o link do mapa.' }).trim().regex(/^https:\/\/\S+$/, 'Cole o link do mapa (começa com https://).').max(300),
        telefone: opcional(telefone),
      })
      .strict(),
    horarios: z
      .object({
        dias: z.array(z.number().int().min(0).max(6)).min(1, 'Marque pelo menos um dia de atendimento.').max(7),
        inicio: hora,
        fim: hora,
        almoco_inicio: opcional(hora),
        almoco_fim: opcional(hora),
        duracao_min: z.number({ invalid_type_error: 'Escolha a duração da consulta.' }).int().min(10, 'Duração entre 10 e 120 minutos.').max(120, 'Duração entre 10 e 120 minutos.'),
      })
      .strict(),
    profissionais: z
      .array(z.object({ nome: texto(3, 80, 'Nome do profissional'), funcao: z.enum(['fisioterapeuta', 'medico'], { errorMap: () => ({ message: 'Escolha se é fisioterapeuta ou médico(a).' }) }) }).strict())
      .min(1, 'Informe pelo menos um profissional que atende.')
      .max(15),
    valores: z
      .object({
        consulta_no_dia: dinheiro('Valor da consulta no dia'),
        consulta_antecipada: opcional(dinheiro('Valor pagando antes')),
        sinal_pix: opcional(dinheiro('Valor do sinal')),
        chave_pix: opcional(texto(5, 120, 'Chave Pix')),
        favorecido: opcional(texto(3, 120, 'Nome de quem recebe o Pix')),
      })
      .strict(),
    whatsapp: z
      .object({
        /** vazio = ainda não tem número (o João resolve com a pessoa) */
        numero: opcional(z.string().trim().transform((v) => v.replace(/[\s()-]/g, '')).pipe(z.string().regex(/^\+\d{12,14}$/, 'Digite o número com +55 e o DDD, por exemplo +5594984420153.'))),
        /** o app do número hoje: ajuda o João a escolher a conexão */
        aplicativo: z.enum(['business', 'comum', 'nao-sei', 'sem-numero'], { errorMap: () => ({ message: 'Diga em qual aplicativo o número está.' }) }),
        conexao: z.enum(['coexistencia', 'numero-novo'], { errorMap: () => ({ message: 'Escolha como quer usar o número.' }) }),
      })
      .strict(),
    equipe: z
      .array(z.object({ nome: texto(3, 80, 'Nome da pessoa'), email, funcao: z.enum(FUNCOES_DA_EQUIPE, { errorMap: () => ({ message: 'Escolha o papel da pessoa.' }) }) }).strict())
      .min(1, 'Informe pelo menos uma pessoa da equipe.')
      .max(20),
    celular_email: opcional(email),
    franquia_id_company: opcional(z.preprocess((v) => (typeof v === 'string' ? Number(v.trim()) : v), z.number({ invalid_type_error: 'Digite só números.' }).int().positive('Digite só números.'))),
    meta: z
      .object({
        ad_account: opcional(z.string().trim().regex(/^act_\d{5,25}$/, 'Esse código começa com act_ e tem só números depois.')),
        business_manager_id: opcional(z.string().trim().regex(/^\d{5,25}$/, 'Digite só números.')),
      })
      .strict()
      .default({}),
    assistente: Assistente,
    /** "conferi endereço, preços, horários e nomes" */
    confirmou: z.literal(true, { errorMap: () => ({ message: 'Marque que você conferiu endereço, preços, horários e nomes.' }) }),
  })
  .strict()
  .superRefine((r, ctx) => {
    const erro = (path: (string | number)[], message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, path, message });
    const gerentes = r.equipe.filter((p) => p.funcao === 'gerente');
    if (gerentes.length !== 1) erro(['equipe'], gerentes.length === 0 ? 'Marque UMA pessoa como responsável pela clínica.' : 'Só pode haver UMA pessoa como responsável pela clínica.');
    const emails = r.equipe.map((p) => p.email);
    if (new Set(emails).size !== emails.length) erro(['equipe'], 'Há dois e-mails iguais na equipe.');
    if (r.celular_email && emails.includes(r.celular_email)) erro(['celular_email'], 'Use um e-mail diferente do das pessoas da equipe.');
    if (r.horarios.fim <= r.horarios.inicio) erro(['horarios', 'fim'], 'O fim do expediente tem de ser depois do começo.');
    if (!!r.horarios.almoco_inicio !== !!r.horarios.almoco_fim) erro(['horarios', 'almoco_inicio'], 'Preencha o começo e o fim do almoço, ou deixe os dois em branco.');
    if (r.horarios.almoco_inicio && r.horarios.almoco_fim && r.horarios.almoco_fim <= r.horarios.almoco_inicio) erro(['horarios', 'almoco_fim'], 'O fim do almoço tem de ser depois do começo.');
    const v = r.valores;
    if (v.consulta_antecipada !== undefined && v.consulta_antecipada >= v.consulta_no_dia) erro(['valores', 'consulta_antecipada'], 'Pagando antes tem de ser MENOR que o valor no dia.');
    if (v.sinal_pix !== undefined) {
      if (v.consulta_antecipada === undefined) erro(['valores', 'sinal_pix'], 'Para ter sinal, informe também o valor pagando antes.');
      else if (v.sinal_pix >= v.consulta_antecipada) erro(['valores', 'sinal_pix'], 'O sinal tem de ser MENOR que o valor pagando antes.');
    }
    if (r.whatsapp.aplicativo === 'sem-numero' && r.whatsapp.numero) erro(['whatsapp', 'aplicativo'], 'Você informou um número, então não marque "ainda não tenho número".');
    if (r.whatsapp.aplicativo !== 'sem-numero' && !r.whatsapp.numero) erro(['whatsapp', 'numero'], 'Digite o número, ou marque "ainda não tenho número".');
  });

export type RespostasFormulario = z.infer<typeof RespostasFormulario>;

/** A objeção foi MUDADA pelo dono (difere do padrão da rede)? Só ela vira aprendizado; a que ficou igual já está no roteiro da rede. */
export function objecaoMudou(id: string, resposta: string | undefined): boolean {
  if (!resposta) return false;
  if (id === 'outra') return true;
  const padrao = OBJECOES_PADRAO.find((o) => o.id === id);
  return !!padrao && normaliza(padrao.resposta) !== normaliza(resposta);
}

/** Mapa «caminho do campo → mensagem em português» para a página pintar o erro no campo certo. Só a PRIMEIRA mensagem de cada campo. */
export function errosPorCampo(erro: z.ZodError): Record<string, string> {
  const m: Record<string, string> = {};
  for (const i of erro.issues) {
    const k = i.path.join('.') || '_';
    if (!(k in m)) m[k] = i.message;
  }
  return m;
}

export type ResultadoDoFormulario = { ok: true; respostas: RespostasFormulario } | { ok: false; campos: Record<string, string> };

/** Caracteres de controle (ESC, NUL, DEL…; \t \n \r ficam: o texto livre os troca por espaço) em qualquer texto do corpo: caminhos dos campos que os têm. */
export function camposComControle(valor: unknown, caminho: string[] = []): string[] {
  if (typeof valor === 'string') {
    const limpo = valor.replace(INVISIVEIS_BENIGNOS, ''); // marcas de direção de copiar/colar não travam o dono
    return /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/.test(limpo) || textoComDisfarce(limpo) ? [caminho.join('.') || '_'] : [];
  }
  if (Array.isArray(valor)) return valor.flatMap((v, i) => camposComControle(v, [...caminho, String(i)]));
  if (valor && typeof valor === 'object') return Object.entries(valor).flatMap(([k, v]) => camposComControle(v, [...caminho, k]));
  return [];
}

/** Tira, em TODOS os textos do corpo, as marcas de direção que vêm de copiar/colar (WhatsApp, Maps): não mudam nada e não devem travar o dono. */
function semMarcasDeCopia(valor: unknown): unknown {
  if (typeof valor === 'string') return valor.replace(INVISIVEIS_BENIGNOS, '');
  if (Array.isArray(valor)) return valor.map(semMarcasDeCopia);
  if (valor && typeof valor === 'object') return Object.fromEntries(Object.entries(valor).map(([k, v]) => [k, semMarcasDeCopia(v)]));
  return valor;
}

export function validarFormulario(corpo: unknown): ResultadoDoFormulario {
  const bruto = semMarcasDeCopia(corpo);
  const controle = camposComControle(bruto);
  if (controle.length) return { ok: false, campos: Object.fromEntries(controle.map((c) => [c, 'Tem um caractere invisível ou inválido. Apague este campo e digite de novo.'])) };
  const r = RespostasFormulario.safeParse(bruto);
  return r.success ? { ok: true, respostas: r.data } : { ok: false, campos: errosPorCampo(r.error) };
}

// ── sugestões do kit (o dono NÃO escolhe isto) ──────────────────────────────────────────────────────

const semAcento = (s: string) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
export const kebab = (s: string) => semAcento(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

/** O que o kit sugere para uma cidade, no padrão da rede (doutor-hernia-parauapebas / drherniaparauapebas / PARAUAPEBAS). */
export function sugestoesDoKit(cidade: string): { slug: string; subdominio: string; sufixo: string } {
  const base = kebab(cidade);
  const colado = base.replace(/-/g, '');
  return {
    slug: `doutor-hernia-${base}`.slice(0, 50).replace(/-+$/g, ''),
    subdominio: `drhernia${colado}`.slice(0, 40),
    sufixo: colado.toUpperCase().slice(0, 30),
  };
}

/** Campos [IMPORTANTE]: viram frase dita ao paciente ou texto de modelo aprovado na Meta. A página marca cada um com «vira frase dita ao paciente — confira». */
export const CAMPOS_IMPORTANTES_DO_FORMULARIO: readonly string[] = [
  'clinica.nome', 'clinica.endereco', 'clinica.mapa_url', 'horarios.dias', 'horarios.inicio', 'horarios.fim', 'horarios.almoco_inicio', 'horarios.duracao_min',
  'profissionais', 'valores.consulta_no_dia', 'valores.consulta_antecipada', 'valores.sinal_pix',
];

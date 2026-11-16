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

const hora = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use o formato 08:00 (hora:minuto).');
const texto = (min: number, max: number, nome: string) =>
  z
    .string({ required_error: `Preencha: ${nome}.`, invalid_type_error: `Preencha: ${nome}.` })
    .trim()
    .min(1, `Preencha: ${nome}.`)
    .min(min, `${nome}: escreva um pouco mais (mínimo ${min} letras).`)
    .max(max, `${nome}: muito longo (máximo ${max} letras).`);
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

export const FUNCOES_DA_EQUIPE = ['gerente', 'secretaria', 'sdr', 'observador'] as const;

export const RespostasFormulario = z
  .object({
    quem: z.object({ nome: texto(3, 80, 'Seu nome'), contato: texto(5, 120, 'Seu WhatsApp ou e-mail') }).strict(),
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
    sofia: z
      .object({
        nome_ia: z.preprocess((v) => (v === '' || v === null ? undefined : v), texto(2, 30, 'Nome da assistente').default('Sofia')),
        tom: z.enum(['casual', 'formal', 'friendly']).default('friendly'),
      })
      .strict()
      .default({}),
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
  if (typeof valor === 'string') return /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/.test(valor) ? [caminho.join('.') || '_'] : [];
  if (Array.isArray(valor)) return valor.flatMap((v, i) => camposComControle(v, [...caminho, String(i)]));
  if (valor && typeof valor === 'object') return Object.entries(valor).flatMap(([k, v]) => camposComControle(v, [...caminho, k]));
  return [];
}

export function validarFormulario(bruto: unknown): ResultadoDoFormulario {
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

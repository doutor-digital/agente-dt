/**
 * QUEM É O APP DO CELULAR DA CLÍNICA, E O QUE ELE (ou o Kommo) FALA SOZINHO. Parte pura, sem import de ambiente.
 *
 * O celular da clínica entra no Kommo como autor `bot`: "WhatsApp Business" (coexistência, API oficial) ou "WhatsApp Lite" (QR
 * code). Quem escreve ali é gente. Mas o app também fala sozinho (saudação, ausência) e o Kommo despeja avisos de sistema como
 * se fossem saída — esses NÃO são fala da equipe.
 *
 * Medido em 18/11/2026 (leitura da rota /talks): em Caxias e Petrópolis nenhum envio do agente sai como "WhatsApp Lite" (94 de 94
 * e 134 de 134 saem como "Salesbot"); o que sai como Lite é gente, mais a ausência do app ("Agradecemos o seu contato!…", 35 em
 * Petrópolis em 72 h), o aviso «messageContextInfo» e o robô de Retomada ("Passando novamente porque vi…", Caxias).
 */

export type AppDoCelular = 'business' | 'lite';

const APPS: Record<string, AppDoCelular> = { 'whatsapp business': 'business', 'whatsapp lite': 'lite' };

/** Nomes (minúsculos) com que o Kommo assina a fala vinda do celular da clínica. */
export const NOMES_DOS_APPS_DO_CELULAR: readonly string[] = Object.keys(APPS);

/** Qual app do celular é este autor? null = não é app do celular. */
export function appDoCelular(autorNome: string | null | undefined): AppDoCelular | null {
  return APPS[(autorNome ?? '').trim().toLowerCase()] ?? null;
}

/** Aviso do Kommo/WhatsApp que sai como mensagem de saída ("Unable to open this message…", «messageContextInfo» do Lite). */
export const AVISO_DO_SISTEMA =
  /^(unable to (open|display) this message|n[aã]o foi poss[ií]vel (abrir|exibir) (esta|essa) mensagem|'?messagecontextinfo'? is not yet supported)/i;

/** Saudação/ausência que o app manda sozinho (Lite: "Agradecemos o seu contato! Nosso atendimento é de segunda a sexta…"). */
export const RESPOSTA_AUTOMATICA_TEXTO = /agradecemos o seu contato|nosso atendimento (é|e) de |fora do (nosso )?hor[aá]rio|hor[aá]rio de atendimento (é|e) /i;

/**
 * Textos de robô do Kommo (etapa ▶ Retomada) que saem sem marca de robô: pelo celular (Caxias, "WhatsApp Lite") ou como o USUÁRIO
 * `internal` (Petrópolis). Na dúvida é robô: o erro custa uma cutucada a menos, nunca uma a mais.
 */
export const TEXTOS_DE_ROBO: readonly RegExp[] = [
  /passando novamente porque vi que voc[eê] procurou ajuda/i,
  /vi que voc[eê] demonstrou interesse no nosso tratamento, tentei contato/i,
];

/** O texto é de robô conhecido (ausência do app ou Retomada)? Não depende de hora nem de autor. */
export function ehTextoDeRoboDoApp(texto: string): boolean {
  const t = texto.trim();
  return RESPOSTA_AUTOMATICA_TEXTO.test(t) || TEXTOS_DE_ROBO.some((r) => r.test(t));
}

/**
 * A saída é fala automática PELO TEXTO (sem olhar a hora): aviso do sistema (de qualquer autor) ou, vinda do app do celular
 * (Business/Lite) e sem anexo, ausência/saudação ou texto de robô conhecido. É o que não conta como «a equipe falou» em lugar nenhum:
 * nem na pausa, nem no bloco <conversa_oficial> do prompt, nem na leitura da régua.
 */
export function ehFalaAutomaticaPeloTexto(m: { texto: string; autorNome: string; anexo?: unknown }): boolean {
  if (AVISO_DO_SISTEMA.test(m.texto.trim())) return true;
  return appDoCelular(m.autorNome) !== null && !m.anexo && ehTextoDeRoboDoApp(m.texto);
}

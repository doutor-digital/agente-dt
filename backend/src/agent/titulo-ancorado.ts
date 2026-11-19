/**
 * O nome que a IA grava no título do cartão tem de ter vindo de ALGUM lugar que ela viu: uma fala do paciente, o nome do
 * contato (perfil do WhatsApp) ou o retorno de uma ferramenta (cadastro no CRM).
 *
 * Caso de 19/11/2026, Tatuí, lead 4282053: o paciente mandou "Olá"; a IA chamou `atualizar_titulo_lead` com "Ocupado"
 * (cartão e contato "Isaque F Sousa" viraram "Ocupado") e no turno seguinte pediu desculpa AO PACIENTE. Não veio de outra
 * unidade: o pedido ao modelo tinha 2 mensagens (o prompt da Tatuí e "Olá"), e "Ocupado" estava no próprio prompt, como
 * exemplo do que NÃO é nome (regras_gerais → NOME: «"Ocupado", "Cliente", "Loja"…», tirado no mesmo PR). Sem nome nenhum na conversa, o
 * sonnet-5 pegou a única palavra com cara de nome que tinha à mão. Mesmo desenho em Salto, 13/11 ("Rosana" → "Ocupado").
 *
 * A trava é de código porque a regra do prompt é justamente o que induz o erro: nome que não aparece em nada do que a IA
 * viu é palpite. Função pura; quem junta a evidência é o grafo e quem recusa é a ferramenta.
 */

const CONECTORES = new Set(['de', 'da', 'do', 'das', 'dos', 'e', 'del', 'di', 'du']);

/** "José D'Ávila" → ["jose", "d", "avila"], "Maria-José" → ["maria", "jose"]: sem acento nem caixa; hífen e apóstrofo (reto ou curvo) separam. */
function palavras(texto: string): string[] {
  return (texto ?? '')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter(Boolean);
}

/** As palavras do nome que precisam estar na evidência: de 3 letras para cima, sem conector ("Jo", "Ed" não provam nada). */
function palavrasDoNome(nome: string): string[] {
  return palavras(nome).filter((p) => p.length >= 3 && !CONECTORES.has(p));
}

export interface ResultadoDaAncora {
  ancorado: boolean;
  /** As palavras do nome que não aparecem em lugar nenhum — vão para o motivo da recusa. */
  faltando: string[];
}

/**
 * Toda palavra do nome (3+ letras, fora conectores) aparece, inteira, em alguma evidência. "Todas" e não "alguma":
 * a descrição da ferramenta já manda não inventar sobrenome, e "Maria Souza" quando ela só disse "Maria" é invenção.
 * Nome só com palavras curtas não tem o que conferir e passa.
 */
export function nomeAncoradoNaConversa(nome: string, evidencias: ReadonlyArray<string>): ResultadoDaAncora {
  const exigidas = palavrasDoNome(nome);
  if (exigidas.length === 0) return { ancorado: true, faltando: [] };
  const vistas = new Set<string>();
  for (const e of evidencias) for (const p of palavras(e)) vistas.add(p);
  const faltando = exigidas.filter((p) => !vistas.has(p));
  return { ancorado: faltando.length === 0, faltando };
}

/**
 * O retorno de `buscar_paciente` NÃO é prova inteiro: os avisos dele repetem `args.nome`, o nome que a IA digitou ("Nenhum cadastro
 * encontrado para \"Rosana\"", "É XARÁ…", "…o nome \"X\"…"). Paciente diz "Olá" → IA busca "Rosana" → "Rosana" passaria. Só vale o nome
 * que veio da franquia, na linha de sucesso: "Confirmado pelo telefone: idClient 12 — Maria Souza | idClient 13 — Maria S. Souza. Nenhuma consulta…"
 * (agenda-tools.ts, buscar_paciente: cadastro com o telefone do paciente). `cadastrar_paciente` devolve o nome que a IA mandou: fora.
 */
const FERRAMENTA_COM_NOME_DA_FRANQUIA = 'buscar_paciente';

/** Os nomes de cadastro da linha "Confirmado pelo telefone: idClient N — <nome> | idClient M — <nome>. Nenhuma…". Vazio se a linha não existe. */
export function nomesConfirmadosPeloTelefone(retorno: string): string[] {
  const i = retorno.indexOf('Confirmado pelo telefone:');
  if (i < 0) return [];
  const trecho = retorno.slice(i + 'Confirmado pelo telefone:'.length);
  const fim = trecho.search(/\.\s+Nenhuma consulta futura|\.\s+Use este idClient/);
  const lista = fim < 0 ? trecho : trecho.slice(0, fim);
  const nomes: string[] = [];
  for (const m of lista.matchAll(/idClient\s+\S+\s+[—–-]\s+([^|]+)/g)) {
    const nome = m[1].trim();
    if (nome) nomes.push(nome);
  }
  return nomes;
}

/**
 * Contas `*-resgate`: a conversa com a outra Sofia entra no PROMPT (`<conversa_com_outra_sofia>`), não nas mensagens do grafo. As linhas
 * "(22/10 11:00) Paciente: Sidney" são fala do paciente e provam nome; "Sofia:" é a IA falando e não prova nada.
 */
export function falasDoPacienteNoPrompt(prompt: string): string[] {
  const out: string[] = [];
  for (const bloco of (prompt ?? '').matchAll(/<conversa_com_outra_sofia>([\s\S]*?)<\/conversa_com_outra_sofia>/g)) {
    for (const linha of bloco[1].split('\n')) {
      const m = /^\s*(?:\(\d{2}\/\d{2}\s+\d{2}:\d{2}\)\s+)?Paciente:\s*(.+)$/.exec(linha);
      if (m) out.push(m[1]);
    }
  }
  return out;
}

export interface MensagemParaEvidencia {
  tipo: string;
  texto: string;
  /** Nome da ferramenta, quando `tipo` é 'tool'. */
  ferramenta?: string;
}

/**
 * A evidência de um turno: o que o PACIENTE disse (`falaDoPaciente` tira do HumanMessage o bloco `<conversa_oficial>`, onde
 * a equipe e a própria clínica falam) e o nome que a franquia devolveu em buscar_paciente. Fala da IA, retorno
 * das outras ferramentas (a recusa desta mesma cita o nome recusado) e prompt do sistema ficam de fora.
 */
export function evidenciaDoNome(mensagens: ReadonlyArray<MensagemParaEvidencia>, falaDoPaciente: (texto: string) => string): string[] {
  const out: string[] = [];
  for (const m of mensagens) {
    // Instrução interna do próprio agente (follow-up, reativação) vem como HumanMessage e não é fala do paciente.
    if (m.tipo === 'human') {
      if (!/^\s*\[instru[cç][aã]o interna/i.test(m.texto)) out.push(falaDoPaciente(m.texto));
    }
    else if (m.tipo === 'tool' && m.ferramenta === FERRAMENTA_COM_NOME_DA_FRANQUIA) out.push(...nomesConfirmadosPeloTelefone(m.texto));
  }
  return out.filter(Boolean);
}

/** Chave de emergência: `TITULO_NOME_ANCORADO=off` volta ao comportamento antigo sem novo deploy de código. */
export function ancoraDoNomeLigada(raw: string | undefined = process.env.TITULO_NOME_ANCORADO): boolean {
  return (raw ?? '').trim().toLowerCase() !== 'off';
}

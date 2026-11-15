/**
 * AS PORTAS DO MUNDO DE FORA que o `--aplicar` usa (kit de unidade, fase 2). O executor só conhece estas interfaces: a implementação real é
 * HTTP (`chatwoot-http.ts`, `kapso-http.ts`, `segredos.ts`) e o teste usa um Chatwoot/Kapso de mentira no nível do HTTP (`chatwoot-falso.ts`).
 *
 * Segredo: nenhuma porta devolve ou recebe segredo para IMPRIMIR. O token que o Chatwoot devolve ao criar o usuário conector vai direto para
 * `SegredosPorta.guardar` e nunca para o log, a tela ou o relatório.
 */

/** A API de plataforma do Chatwoot (token do «Platform App»): cria contas e usuários. Não lê nem escreve dentro de uma conta. */
export interface PlataformaPorta {
  contaExiste(id: number): Promise<boolean>;
  criarConta(nome: string): Promise<{ id: number }>;
  /** cria o usuário (a resposta traz o token de acesso dele) */
  criarUsuario(u: { nome: string; email: string; senha: string }): Promise<{ id: number; tokenDeAcesso: string }>;
  vincular(contaId: number, usuarioId: number, papel: 'administrator' | 'agent'): Promise<void>;
}

/** Uma conta do Chatwoot, com o token DELA (o do usuário conector da clínica, ou o de referência para leitura). */
export interface ContaPorta {
  conta: number;
  get(caminho: string, query?: Record<string, string>): Promise<unknown>;
  post(caminho: string, corpo?: Record<string, unknown>): Promise<unknown>;
}

export interface KapsoPorta {
  /** nome do modelo → situação (APPROVED, PENDING…) dos modelos que a WABA já tem */
  modelos(waba: string): Promise<Record<string, string>>;
  criarModelo(waba: string, modelo: Record<string, unknown>): Promise<void>;
}

export interface SegredosPorta {
  /** confere ANTES de criar qualquer coisa que devolva um segredo: o cofre tem onde gravar? (lança se não) */
  pronto(): Promise<void>;
  /** o segredo existe (no cofre do kit ou no ambiente)? */
  tem(nome: string): Promise<boolean>;
  /** o valor, para USAR (nunca para imprimir); null se não existe */
  ler(nome: string): Promise<string | null>;
  /** guarda (modo 600); recusa sobrescrever um que já existe diferente */
  guardar(nome: string, valor: string): Promise<void>;
}

export interface PortasExternas {
  /** sem o token do Platform App não dá para criar conta nem usuário */
  plataforma: PlataformaPorta | null;
  /** abre uma conta com o token dado */
  abrirConta(conta: number, token: string): ContaPorta;
  /** a conta de REFERÊNCIA (Parauapebas, a do ambiente), SÓ leitura: o molde de etiquetas, atributos e automações da conta */
  referencia: ContaPorta | null;
  kapso: KapsoPorta | null;
  segredos: SegredosPorta;
  /** onde o Chatwoot chama o agente: https://agente-vps… (sem barra no fim) */
  urlDoAgente: string;
  /** a URL do Chatwoot (https://atendimento…) — para o link do Funil e das notas */
  urlDoChatwoot: string;
  /** gera a senha do usuário conector (aleatória); injetável para o teste */
  gerarSenha: () => string;
}

/** Um passo que só podia LER tentou escrever (o plano achava que já estava pronto): o executor pergunta e roda de novo com escrita. */
export class ErroSoLeitura extends Error {
  constructor(readonly o_que: string) {
    super(`passo em modo só-leitura tentou escrever (${o_que})`);
  }
}

/** O erro de uma porta, sem segredo no texto. */
export class ErroDaPorta extends Error {
  constructor(
    mensagem: string,
    readonly status?: number,
  ) {
    super(mensagem);
  }
}

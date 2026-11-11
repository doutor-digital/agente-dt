/**
 * ESCRITA no Asaas, numa lista fechada de rotas. Qualquer outro caminho é recusado aqui, antes de sair da máquina.
 *
 * PERMITIDO (método + rota): cadastrar e editar cliente; criar e editar cobrança (boleto, Pix, cartão por link, parcelado);
 * cancelar (excluir) cobrança pendente; estornar cobrança recebida; transferir (Pix/conta) — esta última só chega aqui depois
 * da lista de destinos e dos tetos de `mcp-remoto/asaas-limites.ts`; e CRIAR link de pagamento (só o POST: é o sinal da
 * consulta que a Sofia manda ao paciente, `lib/sinal-pix.ts`).
 *
 * PROIBIDO SEMPRE (não existe rota, então não há o que configurar): dados bancários da clínica, chaves de API, webhooks, usuários
 * do Asaas, antecipação, empréstimo, pagamento de contas (bill payment), assinatura, exclusão de cliente. A leitura continua em
 * `asaas.ts` (só GET).
 *
 * Escrita não é repetida sozinha: timeout ou 5xx pode ter gravado, e repetir cobraria ou pagaria duas vezes. Só o 429 (o Asaas
 * nem processou) volta a tentar.
 */
import { mascararDigitosSeguidos, mascararPii } from '../pii.js';
import { ASAAS_API, ErroAsaas, ritmoDaConta } from './asaas.js';
import { IDS_PROTEGIDOS, protegendo } from './mascaras.js';

const AGENTE = 'DoutorDigital-Conector/1.0';

export type MetodoDeEscrita = 'POST' | 'PUT' | 'DELETE';
// ids com o prefixo certo do Asaas (cus_ cliente, pay_ cobrança): "/payments/webhook" ou "/customers/myAccount" não são rotas de escrita
const CLIENTE = 'cus_[A-Za-z0-9]{6,40}';
const COBRANCA = 'pay_[A-Za-z0-9]{6,40}';
/** As ÚNICAS rotas em que este cliente escreve (método + caminho inteiro, sem query). */
export const ROTAS_DE_ESCRITA: ReadonlyArray<{ metodo: MetodoDeEscrita; caminho: RegExp; nome: string }> = [
  { metodo: 'POST', caminho: /^\/customers$/, nome: 'cadastrar cliente' },
  { metodo: 'PUT', caminho: new RegExp(`^/customers/${CLIENTE}$`), nome: 'editar cliente' },
  { metodo: 'POST', caminho: /^\/payments$/, nome: 'criar cobrança' },
  { metodo: 'PUT', caminho: new RegExp(`^/payments/${COBRANCA}$`), nome: 'editar cobrança' },
  { metodo: 'DELETE', caminho: new RegExp(`^/payments/${COBRANCA}$`), nome: 'cancelar cobrança' },
  { metodo: 'POST', caminho: new RegExp(`^/payments/${COBRANCA}/refund$`), nome: 'estornar cobrança' },
  { metodo: 'POST', caminho: /^\/transfers$/, nome: 'transferir' },
  // Sofia 2.0: o sinal do paciente. SÓ criar o link (lib/sinal-pix.ts); nada de editar, excluir ou ler link por aqui.
  { metodo: 'POST', caminho: /^\/paymentLinks$/, nome: 'criar link de pagamento (sinal da consulta)' },
  // Sofia 2.0 (11/11/2026): o sinal sai como Pix copia-e-cola de valor fixo, sem formulário (o link pedia nome, CPF, e-mail: idoso desiste)
  { metodo: 'POST', caminho: /^\/pix\/qrCodes\/static$/, nome: 'criar Pix copia-e-cola de valor fixo (sinal da consulta)' },
];

export function rotaPermitida(metodo: string, caminho: string): boolean {
  return ROTAS_DE_ESCRITA.some((r) => r.metodo === metodo && r.caminho.test(caminho));
}

type Fetcher = typeof fetch;
const dormir = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Ids do Asaas (cus_, pay_, sub_, ins_…) e o nossoNumero do boleto ficam legíveis: a lista é UMA só, em `mascaras.ts`
// (a mesma que protege o erro de todas as ferramentas do conector).

/**
 * Tira da mensagem o que nunca pode sair: a chave do Asaas, CPF/CNPJ e qualquer corrida de 11+ dígitos seguidos (a regra de
 * `lib/pii.ts`, com ou sem espaço, ponto, hífen ou barra), e-mail e — também pelo `lib/pii.ts`, só com DDD — telefone e cartão.
 * Ficam intactos: ids do Asaas (cus_…, pay_…, sub_…, ins_…), nossoNumero e números curtos (PED-20261028, datas, valores).
 */
export function limparTexto(texto: string, chave?: string, soSegredos = false): string {
  let t = texto;
  if (chave && chave.length >= 8) t = t.split(chave).join('[chave]');
  t = t.replace(/\$?aact_[A-Za-z0-9_\-:.=]+/g, '[chave]');
  // nossas próprias recusas (soSegredos) só citam documento mascarado, e o texto do pedido precisa aparecer inteiro
  if (soSegredos) return t;
  return protegendo(t, IDS_PROTEGIDOS, (resto) =>
    mascararPii(mascararDigitosSeguidos(resto, 11, '[documento]').replace(/[^\s@"',;]+@[^\s@"',;]+\.[^\s@"',;]+/g, '[e-mail]'), { exigirDdd: true }),
  );
}

/** Escrita no Asaas (POST, PUT ou DELETE) numa rota da lista. A chave só vai no cabeçalho e nunca volta em erro. */
export async function asaasEscrever<T = unknown>(
  contaId: string,
  chave: string,
  metodo: MetodoDeEscrita,
  caminho: string,
  corpo?: Record<string, unknown>,
  fetcher: Fetcher = fetch,
): Promise<T> {
  if (!rotaPermitida(metodo, caminho)) {
    throw new ErroAsaas('escrita recusada: essa operação não existe neste conector (dados bancários, chaves, webhooks, usuários, antecipação, empréstimo e pagamento de contas nunca são alterados por aqui)', null);
  }
  const ritmo = ritmoDaConta(contaId);
  for (let tentativa = 0; tentativa < 3; tentativa++) {
    await ritmo.vez();
    let resp: Response;
    try {
      resp = await fetcher(`${ASAAS_API}${caminho}`, {
        method: metodo,
        headers: {
          access_token: chave,
          'User-Agent': AGENTE,
          Accept: 'application/json',
          ...(corpo !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(corpo !== undefined ? { body: JSON.stringify(corpo) } : {}),
        // redirecionamento não é seguido: o cabeçalho com a chave não pode ir parar em outro endereço (e a escrita pode ter sido processada)
        redirect: 'error',
        signal: AbortSignal.timeout(30_000),
      });
    } catch {
      // pode ter chegado: não repete, quem chamou precisa conferir no Asaas antes de tentar de novo
      throw new ErroAsaas(`sem resposta do Asaas em ${caminho}: a gravação pode ter acontecido — confira no painel do Asaas antes de repetir`, null);
    }
    if (resp.status === 429) {
      // o Asaas nem processou: pode tentar de novo sem risco de duplicar
      if (tentativa < 2) {
        await dormir(1500 * (tentativa + 1));
        continue;
      }
      throw new ErroAsaas(`Asaas limitou as requisições em ${caminho} (429): nada foi gravado, tente em instantes`, 429);
    }
    let texto: string;
    try {
      texto = await resp.text();
    } catch {
      throw new ErroAsaas(`resposta do Asaas em ${caminho} cortada no meio: a gravação pode ter acontecido — confira no painel do Asaas antes de repetir`, null);
    }
    if (resp.status === 401) throw new ErroAsaas('o Asaas recusou a chave (401): chave errada, revogada ou de outro ambiente (sandbox × produção)', 401);
    if (resp.status === 403) {
      throw new ErroAsaas('o Asaas negou a gravação (403): a chave desta conta é só de leitura ou não tem permissão para esta operação (cobrança, estorno ou transferência). Gere uma chave com a permissão no painel do Asaas e salve-a no painel de integrações.', 403);
    }
    if (!resp.ok) throw new ErroAsaas(`Asaas ${resp.status} em ${caminho}: ${limparTexto(texto, chave).slice(0, 300)}`, resp.status);
    try {
      return (texto ? JSON.parse(texto) : null) as T;
    } catch {
      throw new ErroAsaas(`resposta do Asaas em ${caminho} ilegível: a gravação pode ter acontecido — confira no painel do Asaas antes de repetir`, null);
    }
  }
  throw new ErroAsaas(`Asaas não respondeu em ${caminho}`, null);
}

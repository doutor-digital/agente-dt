/**
 * ESCRITA no Asaas, estreita de propósito: só dois POST — cadastrar cliente (`/customers`) e gerar cobrança
 * (`/payments`). Qualquer outro caminho é recusado aqui, antes de sair da máquina: não existe como cancelar,
 * estornar, editar, transferir, sacar ou antecipar por este cliente. A leitura continua em `asaas.ts` (só GET).
 *
 * POST não é repetido sozinho: timeout ou 5xx pode ter criado a cobrança, e repetir cobraria o paciente duas
 * vezes. Só o 429 (o Asaas nem processou) volta a tentar.
 */
import { mascararPii } from '../pii.js';
import { ASAAS_API, ErroAsaas, ritmoDaConta } from './asaas.js';

const AGENTE = 'DoutorDigital-Conector/1.0';
/** Os únicos caminhos em que este cliente escreve. */
export const CAMINHOS_DE_ESCRITA = ['/customers', '/payments'] as const;

type Fetcher = typeof fetch;
const dormir = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Tira da mensagem o que nunca pode sair: a chave do Asaas, CPF/CNPJ (11 e 14 dígitos), e-mail e — pelo `lib/pii.ts` — telefone
 * (10 a 13 dígitos, com ou sem DDI/máscara) e cartão. Ids do Asaas (cus_…, pay_…) ficam intactos.
 */
export function limparTexto(texto: string, chave?: string, soSegredos = false): string {
  let t = texto;
  if (chave && chave.length >= 8) t = t.split(chave).join('[chave]');
  t = t.replace(/\$?aact_[A-Za-z0-9_\-:.=]+/g, '[chave]');
  // nossas próprias recusas (soSegredos) só citam documento mascarado, e o texto do pedido precisa aparecer inteiro
  if (soSegredos) return t;
  const ids: string[] = [];
  t = t.replace(/\b(?:cus|pay)_[A-Za-z0-9]+/g, (m) => `\u0001${ids.push(m) - 1}\u0001`);
  t = t
    .replace(/(?<![\w.\/-])\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2}(?!\w)/g, '[documento]')
    .replace(/(?<![\w.\/-])\d{3}\.?\d{3}\.?\d{3}-?\d{2}(?!\w)/g, '[documento]')
    .replace(/[^\s@"',;]+@[^\s@"',;]+\.[^\s@"',;]+/g, '[e-mail]');
  return mascararPii(t).replace(/\u0001(\d+)\u0001/g, (_, i: string) => ids[Number(i)] ?? '');
}

/** POST no Asaas em `/customers` ou `/payments`. A chave só vai no cabeçalho e nunca volta em erro. */
export async function asaasPost<T = unknown>(contaId: string, chave: string, caminho: string, corpo: Record<string, unknown>, fetcher: Fetcher = fetch): Promise<T> {
  if (!(CAMINHOS_DE_ESCRITA as readonly string[]).includes(caminho)) {
    throw new ErroAsaas(`escrita recusada: o conector só grava em ${CAMINHOS_DE_ESCRITA.join(' e ')}`, null);
  }
  const ritmo = ritmoDaConta(contaId);
  for (let tentativa = 0; tentativa < 3; tentativa++) {
    await ritmo.vez();
    let resp: Response;
    try {
      resp = await fetcher(`${ASAAS_API}${caminho}`, {
        method: 'POST',
        headers: { access_token: chave, 'User-Agent': AGENTE, Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify(corpo),
        // redirecionamento não é seguido: o cabeçalho com a chave não pode ir parar em outro endereço (e o POST pode ter sido processado)
        redirect: 'error',
        signal: AbortSignal.timeout(30_000),
      });
    } catch {
      // pode ter chegado: não repete, quem chamou precisa conferir no Asaas antes de tentar de novo
      throw new ErroAsaas(`sem resposta do Asaas em ${caminho}: a gravação pode ter acontecido — confira no painel do Asaas antes de repetir`, null);
    }
    if (resp.status === 429) {
      // o Asaas nem processou: pode tentar de novo sem risco de cobrar em dobro
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
      throw new ErroAsaas('o Asaas negou a gravação (403): a chave desta conta é só de leitura ou não tem permissão para cadastrar cliente e gerar cobrança. Gere uma chave com permissão de escrita no painel do Asaas e salve-a no painel de integrações.', 403);
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

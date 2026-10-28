/**
 * ESCRITA no Asaas, estreita de propósito: só dois POST — cadastrar cliente (`/customers`) e gerar cobrança
 * (`/payments`). Qualquer outro caminho é recusado aqui, antes de sair da máquina: não existe como cancelar,
 * estornar, editar, transferir, sacar ou antecipar por este cliente. A leitura continua em `asaas.ts` (só GET).
 *
 * POST não é repetido sozinho: timeout ou 5xx pode ter criado a cobrança, e repetir cobraria o paciente duas
 * vezes. Só o 429 (o Asaas nem processou) volta a tentar.
 */
import { Ritmo } from '../bling/ritmo.js';
import { ASAAS_API, ErroAsaas } from './asaas.js';

const AGENTE = 'DoutorDigital-Conector/1.0';
/** Os únicos caminhos em que este cliente escreve. */
export const CAMINHOS_DE_ESCRITA = ['/customers', '/payments'] as const;

type Fetcher = typeof fetch;
const ritmos = new Map<string, Ritmo>();
const dormir = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Tira da mensagem o que nunca pode sair: a chave do Asaas, sequências de 11 a 14 dígitos (CPF/CNPJ) e e-mails. */
export function limparTexto(texto: string, chave?: string): string {
  let t = texto;
  if (chave && chave.length >= 8) t = t.split(chave).join('[chave]');
  return t
    .replace(/\$?aact_[A-Za-z0-9_\-:.=]+/g, '[chave]')
    // CNPJ (14) e CPF (11), com ou sem pontuação, fora de ids como cus_000005401844 ou pay_123…
    .replace(/(?<![\w.\/-])\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2}(?!\w)/g, '[documento]')
    .replace(/(?<![\w.\/-])\d{3}\.?\d{3}\.?\d{3}-?\d{2}(?!\w)/g, '[documento]')
    .replace(/[^\s@"',;]+@[^\s@"',;]+\.[^\s@"',;]+/g, '[e-mail]');
}

/** POST no Asaas em `/customers` ou `/payments`. A chave só vai no cabeçalho e nunca volta em erro. */
export async function asaasPost<T = unknown>(contaId: string, chave: string, caminho: string, corpo: Record<string, unknown>, fetcher: Fetcher = fetch): Promise<T> {
  if (!(CAMINHOS_DE_ESCRITA as readonly string[]).includes(caminho)) {
    throw new ErroAsaas(`escrita recusada: o conector só grava em ${CAMINHOS_DE_ESCRITA.join(' e ')}`, null);
  }
  let ritmo = ritmos.get(contaId);
  if (!ritmo) ritmos.set(contaId, (ritmo = new Ritmo(500)));
  for (let tentativa = 0; tentativa < 3; tentativa++) {
    await ritmo.vez();
    let resp: Response;
    try {
      resp = await fetcher(`${ASAAS_API}${caminho}`, {
        method: 'POST',
        headers: { access_token: chave, 'User-Agent': AGENTE, Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify(corpo),
        signal: AbortSignal.timeout(30_000),
      });
    } catch {
      // pode ter chegado: não repete, quem chamou precisa conferir no Asaas antes de tentar de novo
      throw new ErroAsaas(`sem resposta do Asaas em ${caminho}: a gravação pode ter acontecido — confira no painel do Asaas antes de repetir`, null);
    }
    if (resp.status === 429 && tentativa < 2) {
      await dormir(1500 * (tentativa + 1));
      continue;
    }
    const texto = await resp.text();
    if (resp.status === 401) throw new ErroAsaas('o Asaas recusou a chave (401): chave errada, revogada ou de outro ambiente (sandbox × produção)', 401);
    if (resp.status === 403) {
      throw new ErroAsaas('o Asaas negou a gravação (403): a chave desta conta é só de leitura ou não tem permissão para cadastrar cliente e gerar cobrança. Gere uma chave com permissão de escrita no painel do Asaas e salve-a no painel de integrações.', 403);
    }
    if (!resp.ok) throw new ErroAsaas(`Asaas ${resp.status} em ${caminho}: ${limparTexto(texto, chave).slice(0, 300)}`, resp.status);
    return (texto ? JSON.parse(texto) : null) as T;
  }
  throw new ErroAsaas(`Asaas limitou as requisições em ${caminho} (429): nada foi gravado, tente em instantes`, 429);
}

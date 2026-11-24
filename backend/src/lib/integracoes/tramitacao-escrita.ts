/**
 * Escrita MÍNIMA na Tramitação Inteligente: criar UMA atividade (evento de atendimento). É a única porta de escrita da casa nessa API:
 * não edita, não apaga, não cria cliente nem processo. (A leitura fica em `tramitacao.ts`, que continua só GET.)
 *
 * Documentação oficial (<base>/docs/endpoints/atividades/createActivity.json): `POST /v1/atividades` com
 * `{ activity: { title, type, creator_id, start, end, description, assignments: [{ user_id, role }] } }`; `creator_id` é o id PÚBLICO do
 * usuário (vem de `GET /v2/usuarios`) e é obrigatório; a resposta 201 é `{ activity: { id, … } }`.
 *
 * SEM nova tentativa: POST não é idempotente, e repetir depois de uma queda de rede criaria o evento em dobro. Quem chama confere antes
 * se o evento já existe (mesmo título no mesmo horário). A chave é a mesma da leitura (a API não separa permissão de leitura e de escrita);
 * se o plano ou o usuário da chave não puder criar, vem 401/402/403 e a mensagem diz.
 */
import { ErroTramitacao, TRAMITACAO_API } from './tramitacao.js';

type Fetcher = typeof fetch;

export interface AtividadeNova {
  title: string;
  description: string;
  type: 'Event';
  /** ISO 8601 com offset, ex. 2026-11-18T09:00:00-03:00 */
  start: string;
  end: string;
  /** id público do advogado (`user_…`) */
  creator_id: string;
  assignments: Array<{ user_id: string; role: 'executor' | 'reviewer' | 'interested' }>;
}

const curto = (v: unknown, n = 240): string => (typeof v === 'string' ? v.slice(0, n) : '');

export async function criarAtividadeTramitacao(chave: string, atividade: AtividadeNova, fetcher: Fetcher = fetch): Promise<{ id: string | number | null }> {
  const caminho = '/v1/atividades';
  let resp: Response;
  try {
    resp = await fetcher(`${TRAMITACAO_API}${caminho}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${chave}`, 'User-Agent': 'DoutorDigital-Sophia/1.0', Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ activity: atividade }),
      redirect: 'error',
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    throw new ErroTramitacao(`sem resposta da Tramitação ao criar o evento: ${String(err).slice(0, 200)}`, null);
  }
  const texto = await resp.text();
  if (!resp.ok) {
    let corpo: { error?: unknown; message?: unknown; errors?: unknown } = {};
    try {
      corpo = JSON.parse(texto) as typeof corpo;
    } catch {
      /* corpo sem JSON */
    }
    const erros = Array.isArray(corpo.errors) ? corpo.errors.filter((e): e is string => typeof e === 'string').join('; ').slice(0, 300) : '';
    const detalhe = erros || curto(corpo.message) || curto(corpo.error) || 'erro sem detalhe';
    if (resp.status === 401) throw new ErroTramitacao('a Tramitação recusou a chave ao criar o evento (401): sem permissão de escrita ou chave removida', 401);
    if (resp.status === 402) throw new ErroTramitacao(`a Tramitação respondeu 402 ao criar o evento: o plano não permite esta operação (${detalhe})`, 402);
    throw new ErroTramitacao(`Tramitação ${resp.status} ao criar o evento: ${detalhe}`, resp.status);
  }
  try {
    const j = JSON.parse(texto) as { activity?: { id?: string | number } };
    return { id: j.activity?.id ?? null };
  } catch {
    throw new ErroTramitacao(`Tramitação ${resp.status} ao criar o evento: resposta que não é JSON (o evento pode ter sido criado: confira a agenda)`, resp.status);
  }
}

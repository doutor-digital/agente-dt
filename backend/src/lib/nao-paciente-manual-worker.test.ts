import test from 'node:test';
import assert from 'node:assert/strict';

// o worker importa o cliente do Kommo e o prisma, que validam o .env ao carregar: valores falsos de tamanho válido
for (const [k, v] of Object.entries({
  DATABASE_URL: 'postgresql://x:y@localhost:1/z',
  KOMMO_SUBDOMAIN: 'xxxxxxxxxx',
  KOMMO_ACCESS_TOKEN: 'xxxxxxxxxxxx',
  OPENAI_API_KEY: 'xxxxxxxxxxxx',
  SESSION_JWT_SECRET: 'x'.repeat(40),
})) process.env[k] ??= v;

const { tratarCartoes } = await import('./nao-paciente-manual-worker.js');
type Deps = Parameters<typeof tratarCartoes>[2];
type Ctx = Parameters<typeof tratarCartoes>[0];

const PERDIDO = 143;
const PASSAGEM = 111915771;
const COMERCIAL = 14475223;

function cartao(id: number, opts: { status?: number; tags?: string[]; motivo?: string } = {}) {
  return {
    id,
    status_id: opts.status ?? PERDIDO,
    custom_fields_values: [{ field_name: '⊘ Motivo do não agendamento', values: [{ value: opts.motivo ?? 'Não é paciente (currículo)' }] }],
    _embedded: { tags: (opts.tags ?? []).map((name) => ({ name })) },
  } as never;
}

function falso(opts: { voltaFalha?: number } = {}) {
  const marcas = new Set<string>();
  const chamadas: string[] = [];
  let falhasDaVolta = opts.voltaFalha ?? 0;
  const deps: Deps = {
    kommo: {
      addTag: async ({ leadId, tags }) => void chamadas.push(`tag:${leadId}:${(tags ?? []).join('+')}`),
      setLeadPipeline: async (leadId: number, _p: number, status?: number) => {
        if (status === PERDIDO && falhasDaVolta > 0) {
          falhasDaVolta--;
          throw new Error('Kommo 429');
        }
        chamadas.push(`etapa:${leadId}:${status}`);
      },
      addLeadNote: async (leadId: number) => {
        chamadas.push(`nota:${leadId}`);
        return { id: 1 };
      },
    } as Deps['kommo'],
    avisoRecente: async (_u, leadId, chave) => marcas.has(`${leadId}:${chave}`),
    marcarAviso: async (_u, leadId, chave) => void marcas.add(`${leadId}:${chave}`),
    marcarConversas: async (_u, leadId) => {
      chamadas.push(`conversa:${leadId}`);
      return 1;
    },
    simular: (_u, leadId) => void chamadas.push(`simulou:${leadId}`),
    dorme: async () => undefined,
  };
  return { deps, marcas, chamadas };
}

const ctx = (c: Partial<Ctx> = {}): Ctx => ({
  unit: { id: 'u', slug: 'doutor-hernia-petropolis' },
  seco: false,
  comercialId: COMERCIAL,
  perdido: PERDIDO,
  reentrada: PASSAGEM,
  naoContatar: 'NO_FOLLOW_UP',
  ...c,
});

test('só no papel: não escreve nada no Kommo nem no banco, só simula', async () => {
  const f = falso();
  const r = await tratarCartoes(ctx({ seco: true }), [cartao(1)], f.deps);
  assert.equal(r.simulados, 1);
  assert.deepEqual(f.chamadas, ['simulou:1']);
  assert.equal(f.marcas.size, 0);
});

test('o caso do Heitor: PERDIDO "currículo" sem etiqueta → telefone marcado, etiqueta, sai e volta de PERDIDO, nota, FEITO', async () => {
  const f = falso();
  const r = await tratarCartoes(ctx(), [cartao(5953841, { tags: ['PETRÓPOLIS'] })], f.deps);
  assert.equal(r.feitos, 1);
  assert.deepEqual(f.chamadas, [
    'conversa:5953841',
    'tag:5953841:NO_FOLLOW_UP+CURRÍCULO',
    `etapa:5953841:${PASSAGEM}`,
    `etapa:5953841:${PERDIDO}`,
    'nota:5953841',
  ]);
  assert.ok(f.marcas.has('5953841:nao_paciente_manual:feito'));
  // a rodada seguinte não mexe de novo
  f.chamadas.length = 0;
  await tratarCartoes(ctx(), [cartao(5953841, { tags: ['NO_FOLLOW_UP'] })], f.deps);
  assert.deepEqual(f.chamadas, []);
});

test('etiqueta posta à mão DEPOIS do PERDIDO: com a etapa de passagem, sai e volta mesmo assim (a régua já estava agendada)', async () => {
  const f = falso();
  await tratarCartoes(ctx(), [cartao(2, { tags: ['NO_FOLLOW_UP'] })], f.deps);
  assert.deepEqual(f.chamadas, ['conversa:2', `etapa:2:${PASSAGEM}`, `etapa:2:${PERDIDO}`, 'nota:2'], 'sem etiquetar de novo, mas sai e volta');
});

test('sem etapa de passagem: quem já tem a etiqueta só ganha a memória do telefone', async () => {
  const f = falso();
  await tratarCartoes(ctx({ reentrada: null }), [cartao(3, { tags: ['NO_FOLLOW_UP'] })], f.deps);
  assert.deepEqual(f.chamadas, ['conversa:3']);
  assert.ok(f.marcas.has('3:nao_paciente_manual:feito'));
});

test('a volta para PERDIDO falha 3 vezes: fica a PENDENTE; a rodada seguinte acha o cartão na passagem e devolve', async () => {
  const f = falso({ voltaFalha: 3 });
  const r1 = await tratarCartoes(ctx(), [cartao(4)], f.deps);
  assert.equal(r1.falhas, 1);
  assert.ok(f.marcas.has('4:nao_paciente_manual:pendente'));
  assert.ok(!f.marcas.has('4:nao_paciente_manual:feito'));
  f.chamadas.length = 0;
  // agora o cartão está na etapa de passagem, já com a etiqueta
  const r2 = await tratarCartoes(ctx(), [cartao(4, { status: PASSAGEM, tags: ['NO_FOLLOW_UP', 'CURRÍCULO'] })], f.deps);
  assert.equal(r2.feitos, 1);
  assert.deepEqual(f.chamadas, ['conversa:4', `etapa:4:${PERDIDO}`, 'nota:4'], 'não sai de novo: só volta');
  assert.ok(f.marcas.has('4:nao_paciente_manual:feito'));
});

test('na etapa de passagem SEM a PENDENTE o cartão é da equipe: não mexe; outro motivo também não', async () => {
  const f = falso();
  await tratarCartoes(ctx(), [cartao(5, { status: PASSAGEM }), cartao(6, { motivo: 'Não deu continuidade ao atendimento' })], f.deps);
  assert.deepEqual(f.chamadas, []);
});

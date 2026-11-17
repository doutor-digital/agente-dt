/**
 * Gera o JSON Schema do questionário A PARTIR do esquema zod (`questionario.ts`), para o arquivo
 * `ops/kit-unidade/questionario.schema.json` nunca se afastar do que o script de fato valida. Cobre só os tipos que o questionário usa.
 * Marca `x-sensivel` / `x-importante` (e o motivo) nos campos de `CAMPOS_SENSIVEIS` / `CAMPOS_IMPORTANTES`, e `x-nome-de-variavel` onde
 * o valor é o NOME de uma variável de ambiente (segredo nunca entra no questionário).
 */
import { z } from 'zod';
import { CAMPOS_IMPORTANTES, CAMPOS_SENSIVEIS, Questionario, VARIAVEIS_DE_SEGREDO } from './questionario.js';

type Js = Record<string, unknown>;

function converter(s: z.ZodTypeAny, caminho: string): { js: Js; opcional: boolean } {
  let opcional = false;
  for (;;) {
    if (s instanceof z.ZodEffects) s = s.innerType();
    else if (s instanceof z.ZodOptional) {
      opcional = true;
      s = s.unwrap();
    } else if (s instanceof z.ZodDefault) {
      opcional = true;
      s = s.removeDefault();
    } else break;
  }
  const js: Js = {};
  if (s instanceof z.ZodObject) {
    const props: Record<string, Js> = {};
    const obrigatorios: string[] = [];
    for (const [k, v] of Object.entries(s.shape as Record<string, z.ZodTypeAny>)) {
      const r = converter(v, caminho ? `${caminho}.${k}` : k);
      props[k] = r.js;
      if (!r.opcional) obrigatorios.push(k);
    }
    js.type = 'object';
    js.properties = props;
    if (obrigatorios.length) js.required = obrigatorios;
    js.additionalProperties = false;
  } else if (s instanceof z.ZodArray) {
    js.type = 'array';
    js.items = converter(s.element as z.ZodTypeAny, `${caminho}[]`).js;
    if (s._def.minLength) js.minItems = s._def.minLength.value;
    if (s._def.maxLength) js.maxItems = s._def.maxLength.value;
  } else if (s instanceof z.ZodString) {
    js.type = 'string';
    for (const c of s._def.checks) {
      if (c.kind === 'min') js.minLength = c.value;
      else if (c.kind === 'max') js.maxLength = c.value;
      else if (c.kind === 'regex') js.pattern = c.regex.source;
      else if (c.kind === 'email') js.format = 'email';
    }
  } else if (s instanceof z.ZodNumber) {
    js.type = 'number';
    for (const c of s._def.checks) {
      if (c.kind === 'int') js.type = 'integer';
      else if (c.kind === 'min') js[c.inclusive ? 'minimum' : 'exclusiveMinimum'] = c.value;
      else if (c.kind === 'max') js[c.inclusive ? 'maximum' : 'exclusiveMaximum'] = c.value;
    }
  } else if (s instanceof z.ZodBoolean) js.type = 'boolean';
  else if (s instanceof z.ZodEnum) {
    js.type = 'string';
    js.enum = s.options;
  } else if (s instanceof z.ZodLiteral) js.const = s.value;
  else throw new Error(`schema-json: tipo de zod não suportado em ${caminho}`);

  const sens = CAMPOS_SENSIVEIS[caminho];
  if (sens) {
    js['x-sensivel'] = true;
    js['x-motivo'] = sens;
  }
  const imp = CAMPOS_IMPORTANTES[caminho];
  if (imp) {
    js['x-importante'] = true;
    js['x-motivo-importante'] = imp;
  }
  if (VARIAVEIS_DE_SEGREDO.includes(caminho)) js['x-nome-de-variavel'] = true;
  return { js, opcional };
}

export function esquemaJson(): Js {
  const { js } = converter(Questionario, '');
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: 'https://doutordigitalconsultoria.com/kit-unidade/questionario.schema.json',
    title: 'Questionário de unidade nova (CRM da Doutor Digital)',
    description:
      'GERADO de backend/src/lib/kit-unidade/questionario.ts (npx tsx src/scripts/nova-unidade.ts --gerar-schema). Não edite à mão. Regras entre campos (1 gerente, valor antecipado < valor do dia, sufixo único da Meta…) só o script confere.',
    ...js,
  };
}

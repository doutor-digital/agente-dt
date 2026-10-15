/**
 * Cria (ou atualiza) a unidade da HM Tecnologia — empresa da casa que NÃO é Doutor Hérnia (15/10/2026).
 *
 * Só o Kommo, sem franquia e sem nada ligado: todas as chaves de automação nascem desligadas (os padrões
 * de `createUnit`), então a Sofia e os robôs não mexem nela. Ela aparece no conector da chefe (kommo_*)
 * e recebe o Bling por `scripts/bling.ts`. O token do Kommo vem do ambiente, nunca do código:
 *
 *   HM_KOMMO_TOKEN='…' node dist/scripts/seed-hm-tecnologia.js
 */
import { prisma } from '../lib/prisma.js';
import { createUnit, updateUnit } from '../services/units.service.js';

const SLUG = 'hm-tecnologia';
const NOME = 'HM Tecnologia';
const KOMMO_SUBDOMAIN = 'hmtecnologiakommon';

const token = (process.env.HM_KOMMO_TOKEN ?? '').trim();
if (!token) {
  console.error('Defina HM_KOMMO_TOKEN (token de longa duração da integração privada do Kommo da HM).');
  process.exit(2);
}

const existe = await prisma.unit.findUnique({ where: { slug: SLUG }, select: { id: true } });
if (existe) {
  await updateUnit(existe.id, { kommoSubdomain: KOMMO_SUBDOMAIN, kommoAccessToken: token });
  console.log(`✅ ${NOME} já existia (id=${existe.id}) — credenciais do Kommo atualizadas.`);
} else {
  const u = await createUnit({ slug: SLUG, name: NOME, kommoSubdomain: KOMMO_SUBDOMAIN, kommoAccessToken: token });
  console.log(`✅ ${NOME} criada (id=${u.id}), tudo desligado.`);
}
await prisma.$disconnect();
